/**
 * 零依赖 zip 提取器(批 2 自写,替代系统 tar 方案——真机实测双杀:
 * Linux GNU tar 不支持 zip 格式;Windows GNU tar 把 `C:\` 绝对路径当
 * host:path 远程语法 "Cannot connect to C:")。
 *
 * 支持子集(覆盖 Godot 官方 release 资产):store(0) + deflate(8),无加密;
 * zip64(Godot 官方 export templates .tpz 即 zip64)。完整性由外层 SHA512
 * (SHA512-SUMS.txt 同源校验)保证,内层 CRC32 冗余不校验。路径穿越防护:
 * 条目名以 / 开头、含 .. 段、或含盘符形态 → 拒绝整个 zip。
 *
 * 流式化(2026-08-21 架构审查 MAJOR-2):原实现整文件 readFileSync 进内存
 * ("~60MB editor 资产"假设),但 web-exporter 用同一函数解压 ~1GB 的 .tpz,
 * 低内存机器 OOM。现仅元数据驻留内存(尾部 EOCD ≤64KB + 中央目录 KB~MB 级,
 * 上限 512MB 防恶意构造),条目数据 createReadStream(start,end) + 流式 inflate,
 * 内存占用与 zip 大小无关。
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, createReadStream, createWriteStream } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { createInflateRaw } from 'zlib';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { InternalError } from '../core/tool-errors.js';

const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_SCAN = EOCD_MIN_SIZE + 65535;  // EOCD + 最大 comment
const CD_ENTRY_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
/** 中央目录驻留内存上限:真实世界 CD 为 KB~MB 级;超限视为恶意构造拒解。 */
const MAX_CD_BYTES = 512 * 1024 * 1024;

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** 条目名安全校验:拒绝对对路径/盘符/.. 段(路径穿越防护)+ Windows 保留设备名(纵深防御)。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function assertSafeEntryName(name: string): void {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new InternalError(`zip entry path traversal (absolute): ${name}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new InternalError(`zip entry path traversal (drive): ${name}`);
  }
  const segments = normalized.split('/');
  if (segments.some(seg => seg === '..')) {
    throw new InternalError(`zip entry path traversal (..): ${name}`);
  }
  const base = segments.pop() ?? normalized;
  if (WINDOWS_RESERVED.test(base)) {
    throw new InternalError(`zip entry reserved device name: ${name}`);
  }
  // 安全P3-1(2026-08-20 审查):NTFS 交替数据流形态(foo.txt:ads)——盘符正则只认行首
  // `^[a-zA-Z]:`,基名中冒号不拦;win32 writeFileSync 落 NTFS ADS=经典恶意载荷藏匿位。
  // win32 合法文件名不含冒号(盘符已被上游拒且那是整路径级),基名含 : 即拒。
  if (base.includes(':')) {
    throw new InternalError(`zip entry NTFS alternate data stream: ${name}`);
  }
}

/** 在给定 buffer(调用方传尾部窗口)内从后向前扫 EOCD 签名,返回相对偏移。 */
function locateEocd(buf: Buffer): number {
  const scanStart = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new InternalError('zip: end-of-central-directory signature not found (not a zip file?)');
}

function u64le(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x1_0000_0000;
}

/** 按需读绝对偏移(fd 分段读,替代整文件驻留)。短读抛错(文件被截断/损坏)。 */
type ReadAt = (offset: number, length: number) => Buffer;

function makeReadAt(fd: number): ReadAt {
  return (offset, length) => {
    const b = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, b, read, length - read, offset + read);
      if (n <= 0) throw new InternalError(`zip: short read at offset ${offset} (expected ${length}, got ${read})`);
      read += n;
    }
    return b;
  };
}

/** EOCD 值读取(zip64 感知):EOCD 本体在 tailBuf 内(eocdRel 相对偏移,eocdAbs 绝对偏移);
 *  EOCD 的 CD offset/size/条目数为 0xFFFFFFFF 时,经 readAt 按绝对偏移读 EOCD64 locator
 *  与记录取 8 字节真值。 */
function readEocdValues(readAt: ReadAt, tailBuf: Buffer, eocdRel: number, eocdAbs: number): { entryCount: number; cdOffset: number; cdSize: number } {
  let entryCount = tailBuf.readUInt16LE(eocdRel + 10);
  let cdOffset = tailBuf.readUInt32LE(eocdRel + 16);
  let cdSize = tailBuf.readUInt32LE(eocdRel + 12);
  const zip64Needed = cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff || tailBuf.readUInt16LE(eocdRel + 8) === 0xffff;
  if (zip64Needed) {
    // EOCD64 locator 恰在 EOCD 前(20 字节):sig 0x07064b50 + ... + EOCD64 offset(8B,偏移 8)
    const locatorAbs = eocdAbs - 20;
    if (locatorAbs >= 0) {
      const locator = readAt(locatorAbs, 20);
      if (locator.readUInt32LE(0) === 0x07064b50) {
        const e64 = u64le(locator, 8);
        // EOCD64 固定头 56B:total entries @32 / cdSize @40 / cdOffset @48(各 8B)
        const rec = readAt(e64, 56);
        if (rec.readUInt32LE(0) === 0x06064b50) {
          entryCount = u64le(rec, 32);
          cdSize = u64le(rec, 40);
          cdOffset = u64le(rec, 48);
        }
      }
    }
    if (cdOffset === 0xffffffff) throw new InternalError('zip: zip64 EOCD not found but needed');
  }
  return { entryCount, cdOffset, cdSize };
}

/** CD 条目的 zip64 extra field(header id 0x0001)按需补真值(顺序:usize,csize,localOffset,disk)。 */
function entry64Fix(buf: Buffer, extraStart: number, extraLen: number, e: { compressedSize: number; uncompressedSize: number; localHeaderOffset: number }): void {
  if (e.compressedSize !== 0xffffffff && e.uncompressedSize !== 0xffffffff && e.localHeaderOffset !== 0xffffffff) return;
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (e.uncompressedSize === 0xffffffff && q + 8 <= end) { e.uncompressedSize = u64le(buf, q); q += 8; }
      if (e.compressedSize === 0xffffffff && q + 8 <= end) { e.compressedSize = u64le(buf, q); q += 8; }
      if (e.localHeaderOffset === 0xffffffff && q + 8 <= end) { e.localHeaderOffset = u64le(buf, q); }  // F-3:末字段,无后续消费不再累加 q
      return;
    }
    p += 4 + size;
  }
}

/** 解析中央目录(cd 为已读入内存的 CD 段,offset 从 0 起遍历)。 */
function readCentralDirectory(cd: Buffer, entryCount: number): ZipEntry[] {
  let offset = 0;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > cd.length || cd.readUInt32LE(offset) !== CD_ENTRY_SIG) {
      throw new InternalError(`zip: corrupt central directory at entry ${i}`);
    }
    const fnLen = cd.readUInt16LE(offset + 28);
    const extraLen = cd.readUInt16LE(offset + 30);
    const commentLen = cd.readUInt16LE(offset + 32);
    const fields = {
      compressedSize: cd.readUInt32LE(offset + 20),
      uncompressedSize: cd.readUInt32LE(offset + 24),
      localHeaderOffset: cd.readUInt32LE(offset + 42),
    };
    entry64Fix(cd, offset + 46 + fnLen, extraLen, fields);
    entries.push({
      name: cd.toString('utf-8', offset + 46, offset + 46 + fnLen),
      compression: cd.readUInt16LE(offset + 10),
      compressedSize: fields.compressedSize,
      uncompressedSize: fields.uncompressedSize,
      localHeaderOffset: fields.localHeaderOffset,
    });
    offset += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压 zip 到 destDir(流式:仅元数据驻留内存,条目数据流式解压,内存与 zip 大小无关)。 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const totalSize = statSync(zipPath).size;
  const fd = openSync(zipPath, 'r');
  const readAt = makeReadAt(fd);
  try {
    // 1) 尾部窗口(EOCD + 最大 comment ≤ 64KB+22)定位 EOCD
    const tailLen = Math.min(totalSize, EOCD_MAX_SCAN);
    const tail = readAt(totalSize - tailLen, tailLen);
    const eocdRel = locateEocd(tail);
    const eocdAbs = totalSize - tailLen + eocdRel;
    // 2) EOCD 值(zip64 感知)
    const { entryCount, cdOffset, cdSize } = readEocdValues(readAt, tail, eocdRel, eocdAbs);
    if (cdSize > MAX_CD_BYTES) {
      throw new InternalError(`zip: central directory too large (${cdSize} bytes) — refusing`);
    }
    // 3) CD 读入内存 + 全量解析
    const cd = readAt(cdOffset, cdSize);
    const entries = readCentralDirectory(cd, entryCount);
    // 先全量校验条目名(任一恶意 → 整包拒绝,不落半解压状态)
    // L-16(2026-10-22 审查): 目录条目(尾 /)此前跳过 assertSafeEntryName——
    // `../evil/` 形态的目录条目可在解压根外建目录。现条目名全量校验(目录去尾 /
    // 后同规则);并加 resolve 前缀硬验(纵深防御:join 产物必须仍在 destDir 内)。
    const destRoot = resolve(destDir);
    for (const e of entries) {
      assertSafeEntryName(e.name.endsWith('/') ? e.name.replace(/\/+$/, '') : e.name);
      const target = resolve(destDir, e.name);
      if (target !== destRoot && !target.startsWith(destRoot + sep)) {
        throw new InternalError(`zip entry escapes dest dir: ${e.name}`);
      }
    }
    mkdirSync(destDir, { recursive: true });
    // 4) 条目数据逐个流式解压(createReadStream 按路径独立开流,fd 仅用于元数据)
    for (const e of entries) {
      const target = join(destDir, e.name);
      if (e.name.endsWith('/')) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      // 读 local file header,定位数据起点
      const lh = readAt(e.localHeaderOffset, 30);
      if (lh.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
        throw new InternalError(`zip: corrupt local header for entry ${e.name}`);
      }
      const lfhLen = lh.readUInt16LE(26);
      const lfhExtra = lh.readUInt16LE(28);
      const dataStart = e.localHeaderOffset + 30 + lfhLen + lfhExtra;
      mkdirSync(dirname(target), { recursive: true });
      if (e.compressedSize === 0) {
        // 空文件:createReadStream end<start 会抛 RangeError,直接写空文件
        if (e.uncompressedSize !== 0) {
          throw new InternalError(`zip: size mismatch for ${e.name} (no data, expected ${e.uncompressedSize})`);
        }
        writeFileSync(target, '');
        continue;
      }
      const src = createReadStream(zipPath, { start: dataStart, end: dataStart + e.compressedSize - 1 });
      if (e.compression !== 0 && e.compression !== 8) {
        throw new InternalError(`zip: unsupported compression method ${e.compression} for ${e.name}`);
      }
      // P2-18(2026-08-21 七维度审核): 读侧强校验——原实现写盘后才 statSync 比对
      // uncompressedSize(事后性),恶意/损坏条目(中央目录声明小、deflate 实际解出大)
      // 会先把磁盘写满才暴露。inflate 流上累计计数,超声明值立即断流。
      let received = 0;
      const sizeGuard = new Transform({
        transform(chunk: Buffer, _enc: string, cb: (e?: Error | null, d?: Buffer) => void) {
          received += chunk.length;
          if (received > e.uncompressedSize) {
            cb(new InternalError(`zip: entry "${e.name}" exceeds declared uncompressed size ${e.uncompressedSize} (possible zip bomb / corrupt entry)`));
            return;
          }
          cb(null, chunk);
        },
      });
      try {
        if (e.compression === 8) {
          await pipeline(src, createInflateRaw(), sizeGuard, createWriteStream(target));
        } else {
          await pipeline(src, sizeGuard, createWriteStream(target));
        }
      } catch (err) {
        throw new InternalError(`zip: failed to extract ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const got = statSync(target).size;
      if (got !== e.uncompressedSize) {
        throw new InternalError(`zip: size mismatch for ${e.name} (expected ${e.uncompressedSize}, got ${got})`);
      }
    }
  } finally {
    closeSync(fd);
  }
}
