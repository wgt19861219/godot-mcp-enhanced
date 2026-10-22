import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// ─── 批 2:Godot 自动安装下载器(src/cli/godot-installer.ts)──────────────────
// 纯函数层不联网;下载/编排层用 mock fetch / 临时目录。

const m = await import('../src/cli/godot-installer.js');

describe('assertAllowedDownloadUrl(下载域名硬编码白名单)', () => {
  it('github release / asset CDN / api 域放行', () => {
    expect(() => m.assertAllowedDownloadUrl('https://github.com/godotengine/godot/releases/download/4.7.2-stable/a.zip')).not.toThrow();
    expect(() => m.assertAllowedDownloadUrl('https://objects.githubusercontent.com/some/path')).not.toThrow();
    expect(() => m.assertAllowedDownloadUrl('https://api.github.com/repos/godotengine/godot/releases/latest')).not.toThrow();
  });

  it('非白名单域名拒绝', () => {
    expect(() => m.assertAllowedDownloadUrl('https://evil.com/godot.zip')).toThrow(/allowlist/);
    expect(() => m.assertAllowedDownloadUrl('https://github.com.evil.com/a')).toThrow(/allowlist/);
  });

  it('http(非 https)拒绝', () => {
    expect(() => m.assertAllowedDownloadUrl('http://github.com/a')).toThrow();
  });

  it('file:// 等怪协议拒绝', () => {
    expect(() => m.assertAllowedDownloadUrl('file:///etc/passwd')).toThrow();
  });

  it('不可解析 URL 拒绝', () => {
    expect(() => m.assertAllowedDownloadUrl('not a url')).toThrow();
  });
});

describe('assertStableVersionTag(版本 tag 白名单)', () => {
  it('stable tag 放行', () => {
    expect(() => m.assertStableVersionTag('4.7.2-stable')).not.toThrow();
    expect(() => m.assertStableVersionTag('4.5.0-stable')).not.toThrow();
  });

  it('非 stable / 注入形态拒绝', () => {
    expect(() => m.assertStableVersionTag('4.8-dev')).toThrow();
    expect(() => m.assertStableVersionTag('../../evil')).toThrow();
    expect(() => m.assertStableVersionTag('4.7.2-stable/extra')).toThrow();
    expect(() => m.assertStableVersionTag('')).toThrow();
  });
});

describe('platformAssetName(平台资产映射,{v} 占位符契约)', () => {
  it('五组合映射正确', () => {
    expect(m.platformAssetName('win32', 'x64')).toBe('Godot_v{v}-stable_win64.exe.zip');
    expect(m.platformAssetName('win32', 'arm64')).toBe('Godot_v{v}-stable_windows_arm64.exe.zip');
    expect(m.platformAssetName('linux', 'x64')).toBe('Godot_v{v}-stable_linux.x86_64.zip');
    expect(m.platformAssetName('linux', 'arm64')).toBe('Godot_v{v}-stable_linux.arm64.zip');
    expect(m.platformAssetName('darwin', 'arm64')).toBe('Godot_v{v}-stable_macos.universal.zip');
  });

  it('不支持的组合抛错', () => {
    expect(() => m.platformAssetName('freebsd', 'x64')).toThrow();
    expect(() => m.platformAssetName('win32', 'mips')).toThrow();
  });
});

describe('buildReleaseUrls(构造并自校验)', () => {
  it('binary + sums 两个 URL 正确', () => {
    const urls = m.buildReleaseUrls('4.7.2-stable', 'Godot_v{v}-stable_win64.exe.zip');
    expect(urls.binaryUrl).toBe('https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_win64.exe.zip');
    expect(urls.sumsUrl).toBe('https://github.com/godotengine/godot/releases/download/4.7.2-stable/SHA512-SUMS.txt');
  });

  it('非法 tag 在构造期即抛(不产出 URL)', () => {
    expect(() => m.buildReleaseUrls('evil-tag', 'Godot_v{v}-stable_win64.exe.zip')).toThrow();
  });
});

describe('parseSha512Sums(官方双空格格式)', () => {
  const SUMS = 'aa'.repeat(64) + '  Godot_v4.7.2-stable_win64.exe.zip\n' +
               'bb'.repeat(64) + '  other.zip\n' +
               'cc'.repeat(64) + '  Godot_v4.7.2-stable_export_templates.tpz\n';

  it('匹配文件名返回小写 hex', () => {
    expect(m.parseSha512Sums(SUMS, 'Godot_v4.7.2-stable_win64.exe.zip')).toBe('aa'.repeat(64));
  });

  it('大写哈希归一小写', () => {
    const upper = 'AA'.repeat(64) + '  x.zip';
    expect(m.parseSha512Sums(upper, 'x.zip')).toBe('aa'.repeat(64));
  });

  it('条目缺失抛错', () => {
    expect(() => m.parseSha512Sums('aa  other.zip', 'missing.zip')).toThrow(/not found/);
  });

  it('CRLF 换行容错', () => {
    const crlf = 'aa'.repeat(64) + '  x.zip\r\n';
    expect(m.parseSha512Sums(crlf, 'x.zip')).toBe('aa'.repeat(64));
  });
});

describe('sha512File(流式哈希)', () => {
  it('与 crypto 一次性计算一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-hash-'));
    const f = join(dir, 'x.bin');
    const payload = Buffer.alloc(1024 * 64, 7);  // 64KB,跨多个 16KB 流块
    writeFileSync(f, payload);
    const expected = createHash('sha512').update(payload).digest('hex');
    expect(await m.sha512File(f)).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Task 4:下载执行 + 编排 ───────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

describe('verifyDownloadedAsset(SHA512 失败即删)', () => {
  it('哈希不匹配 → 删文件并抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-verify-'));
    const f = join(dir, 'Godot_v4.7.2-stable_win64.exe.zip');
    writeFileSync(f, Buffer.from('tampered'));
    await expect(m.verifyDownloadedAsset(f, '0'.repeat(128))).rejects.toThrow(/sha512 mismatch/i);
    expect(existsSync(f)).toBe(false);  // 失败即删
    rmSync(dir, { recursive: true, force: true });
  });

  it('哈希匹配 → 通过且不删', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-verify2-'));
    const f = join(dir, 'a.zip');
    const payload = Buffer.from('good');
    writeFileSync(f, payload);
    const good = createHash('sha512').update(payload).digest('hex');
    await expect(m.verifyDownloadedAsset(f, good)).resolves.toBeUndefined();
    expect(existsSync(f)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('downloadWithProgress', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('evil 域名在下载期即被 allowlist 拒绝(不发起请求)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(m.downloadWithProgress('https://evil.com/a.zip', join(tmpdir(), 'x.zip')))
      .rejects.toThrow(/allowlist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mock fetch 流式落盘内容一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-dl-'));
    const dest = join(dir, 'a.zip');
    const payload = Buffer.from('abc123godot');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload)));
    let lastBytes = -1;
    await m.downloadWithProgress(
      'https://github.com/godotengine/godot/releases/download/4.7.2-stable/a.zip',
      dest,
      (bytes) => { lastBytes = bytes; },
    );
    expect(readFileSync(dest).toString()).toBe('abc123godot');
    expect(lastBytes).toBe(payload.length);  // 进度回调收到累计字节
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('HTTP 非 2xx 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(m.downloadWithProgress(
      'https://github.com/godotengine/godot/releases/download/4.7.2-stable/a.zip',
      join(tmpdir(), 'gme-dl-404', 'a.zip'),
    )).rejects.toThrow(/404/);
    vi.unstubAllGlobals();
  });
});

describe('fetchLatestStableTag(GODOT_MCP_INSTALL_TAG pin)', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('pin env 直接返回(不联网),非法 pin 拒绝', async () => {
    vi.stubEnv('GODOT_MCP_INSTALL_TAG', '4.7.2-stable');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await m.fetchLatestStableTag()).toBe('4.7.2-stable');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('非法 pin tag 在本地即抛', async () => {
    vi.stubEnv('GODOT_MCP_INSTALL_TAG', 'evil');
    await expect(m.fetchLatestStableTag()).rejects.toThrow(/stable only/);
  });

  it('L-17: 版本查询带 AbortSignal 超时,失败重试 1 次后成功(不再永久挂起)', async () => {
    vi.stubEnv('GODOT_MCP_INSTALL_TAG', '');  // 空串 falsy → 走联网路径
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('TimeoutError: signal timed out'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: '4.7.2-stable' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await m.fetchLatestStableTag()).toBe('4.7.2-stable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 两次尝试都必须带 AbortSignal(弱网挂起不再无限等待)
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toHaveProperty('signal');
    expect((fetchMock.mock.calls[1] as unknown[])[1]).toHaveProperty('signal');
    vi.unstubAllGlobals();
  });
});

describe('confirmYesNo(CLI 交互确认)', () => {
  it('非 TTY(CI/管道)返回 false 不阻塞', async () => {
    const { confirmYesNo } = await import('../src/cli/confirm.js');
    expect(await confirmYesNo('test?')).toBe(false);
  });
});

describe('appendMachineAuditLine(机器级审计;审查 N-4:FAKE_HOME 隔离,不写真实 ~/.godot-mcp)', () => {
  beforeAll(() => {
    const fake = mkdtempSync(join(tmpdir(), 'gme-machaudit-'));
    vi.stubEnv('HOME', fake);
    vi.stubEnv('USERPROFILE', fake);
  });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('落 ~/.godot-mcp/machine-audit.jsonl 且 JSON 行合法(带 timestamp)', async () => {
    const { appendMachineAuditLine, getMachineAuditFile } = await import('../src/core/audit-log.js');
    await appendMachineAuditLine({
      trace_id: `t-test-${Date.now()}`, tool: 'cli', action: 'install_godot_test', risk: 'process',
      ok: true, project_path: '', changed_files: [], duration_ms: 5,
      details: { versionTag: '4.7.2-stable' },
    });
    expect(existsSync(getMachineAuditFile())).toBe(true);
    expect(getMachineAuditFile()).toMatch(/[/\\]\.godot-mcp[/\\]machine-audit\.jsonl$/);
    const lines = readFileSync(getMachineAuditFile(), 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.action).toBe('install_godot_test');
    expect(typeof last.timestamp).toBe('string');
    expect(last.ok).toBe(true);
  });
});

// ─── extractZip(自写零依赖 zip reader;系统 tar 方案废弃:Linux GNU tar 无 zip 支持,
// Windows GNU tar 把 `C:\` 绝对路径当 host:path 远程语法——真机手测双杀)──────────

import { readdirSync } from 'fs';
import { buildSampleZip } from './godot-installer.test-helper.js';

// fixture 代码自生成(不提交二进制,遵循 pngjs globalSetup 同款惯例)
const SAMPLE_ZIP = join(tmpdir(), `gme-sample-${process.pid}.zip`);
buildSampleZip(SAMPLE_ZIP);

describe('extractZip(零依赖 zip reader)', () => {
  it('解压 fixture(store/deflate 条目 + 目录条目)内容逐字节一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-'));
    await m.extractZip(SAMPLE_ZIP, dir);
    const readme = readFileSync(join(dir, 'sample_dir', 'readme.txt'), 'utf-8');
    expect(readme).toBe('hello godot zip');
    const bin = readFileSync(join(dir, 'sample_dir', 'bin.dat'));
    expect(bin.length).toBe(1024);
    expect(bin[0]).toBe(0); expect(bin[250]).toBe(250); expect(bin[251]).toBe(0); // i%251 pattern
    rmSync(dir, { recursive: true, force: true });
  });

  it('zip 路径穿越防护(条目名以 ../ 或绝对路径开头 → 拒绝)', async () => {
    // 构造带恶意条目名的 zip:手工拼 minimal zip(单 store 条目名 ../evil.txt)
    const { buildZipWithEntryName } = await import('./godot-installer.test-helper.js');
    const evilZip = join(tmpdir(), `gme-evil-${Date.now()}.zip`);
    buildZipWithEntryName(evilZip, '../evil.txt', Buffer.from('pwn'));
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-evil-'));
    await expect(m.extractZip(evilZip, dir)).rejects.toThrow(/path traversal|unsafe/i);
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('穿越负向多形态:反斜杠/盘符/绝对路径/嵌套 .. /保留设备名全拒(审查 N-3/N-5)', async () => {
    const { buildZipWithEntryName } = await import('./godot-installer.test-helper.js');
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-multi-'));
    const evilNames = ['..\\evil.txt', 'C:/evil.txt', 'C:evil.txt', '/abs/evil.txt', 'a/../../evil.txt', 'CON'];
    for (const [i, evilName] of evilNames.entries()) {
      const zip = join(dir, `evil-${i}.zip`);
      buildZipWithEntryName(zip, evilName, Buffer.from('x'));
      await expect(m.extractZip(zip, dir)).rejects.toThrow(/traversal|reserved/i);
    }
    expect(readdirSync(dir).length).toBe(evilNames.length);  // 只有 zip,无解压产物
    rmSync(dir, { recursive: true, force: true });
  });

  it('L-16: 目录条目(尾 /)同样拒穿越——../evil-dir/ 不再跳过校验', async () => {
    // 原实现只对非目录条目过 assertSafeEntryName,`../evil-dir/` 的目录条目
    // 直达 mkdirSync(join(destDir, name)),在解压根外建目录(2026-10-22 审查 L-16)。
    const { buildZipWithEntryName } = await import('./godot-installer.test-helper.js');
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-direvil-'));
    const evilZip = join(dir, 'evil-dir.zip');
    buildZipWithEntryName(evilZip, '../evil-dir/', Buffer.alloc(0));
    await expect(m.extractZip(evilZip, dir)).rejects.toThrow(/traversal|escapes/i);
    expect(existsSync(join(dir, '..', 'evil-dir'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('安全P3-1: NTFS 交替数据流形态(基名含冒号)全拒——foo.txt:ads 落盘即 ADS 隐藏流', async () => {
    const { buildZipWithEntryName } = await import('./godot-installer.test-helper.js');
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-ads-'));
    const adsNames = ['foo.txt:ads', 'dir/hidden:stream', 'plain:colon', 'a:b:c'];
    for (const [i, evilName] of adsNames.entries()) {
      const zip = join(dir, `ads-${i}.zip`);
      buildZipWithEntryName(zip, evilName, Buffer.from('x'));
      // a:b:c 走上游盘符分支(drive)同样拒;多字符基名走 ADS 分支——两类拒绝都算防护在位
      await expect(m.extractZip(zip, dir), `entry=${evilName}`).rejects.toThrow(/alternate data stream|traversal/i);
    }
    expect(readdirSync(dir).length).toBe(adsNames.length);  // 只有 zip,零解压产物
    rmSync(dir, { recursive: true, force: true });
  });

  it('zip64 形态解压(EOCD64 locator/记录 + CD 条目 zip64 extra;批 4b 官方 tpz 即 zip64)', async () => {
    const { buildZip64Sample } = await import('./godot-installer.test-helper.js');
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip64-'));
    const zip = join(dir, 's.tpz');
    buildZip64Sample(zip);
    await m.extractZip(zip, dir);
    expect(readFileSync(join(dir, 'dir', 'big.bin')).toString()).toBe('zip64-payload');
    rmSync(dir, { recursive: true, force: true });
  });

  it('损坏 zip(无 EOCD 签名)抛错不写半成品', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-unzip-bad-'));
    const badZip = join(dir, 'bad.zip');
    writeFileSync(badZip, Buffer.from('this is not a zip at all'));
    await expect(m.extractZip(badZip, dir)).rejects.toThrow(/zip/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── 断点续传(批 4b:1GB@787MB 断连实测催生;N-4 补自动化回归)────────────────

describe('downloadWithProgress 断点续传', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterAll(() => { vi.unstubAllGlobals(); });

  /** 构造中途断连的 Response body:推完 prefix 字节后流 error(模拟远端断开)。 */
  function abortedBody(prefix: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(prefix));
        setTimeout(() => controller.error(new Error('simulated disconnect')), 5);
      },
    });
  }

  it('断连后带 Range 续传:206 append 拼接完整', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-resume-'));
    const dest = join(dir, 'big.tpz');
    const full = Buffer.from('0123456789ABCDEFGHIJ');  // 20B
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      call++;
      const range = init?.headers?.['range'];
      if (call === 1) {
        return new Response(abortedBody(full.subarray(0, 10)), { status: 200 });
      }
      // 重试:若 10B 已 flush(N-3 竞态不显形)→ 206 续传尾段;
      // 若未 flush(磁盘 0B)→ 200 全量重下。两分支行为都正确,断言以最终产物为准
      if (range === 'bytes=10-') return new Response(full.subarray(10), { status: 206 });
      return new Response(full, { status: 200 });
    }));
    await m.downloadWithProgress('https://github.com/godotengine/godot/releases/download/4.7.2-stable/big.tpz', dest);
    vi.unstubAllGlobals();
    expect(call).toBe(2);
    expect(readFileSync(dest).toString()).toBe(full.toString());
    rmSync(dir, { recursive: true, force: true });
  });

  it('服务器忽略 Range 回 200:整文件重写(不 append 旧残留)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gme-restart-'));
    const dest = join(dir, 'big.tpz');
    writeFileSync(dest, 'STALE-RESIDUE', 'utf-8');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      return call === 1
        ? new Response(abortedBody(Buffer.from('HALF-')), { status: 200 })
        : new Response('FULL-CONTENT', { status: 200 });  // 重试:不支持 Range → 200 全量
    }));
    await m.downloadWithProgress('https://github.com/godotengine/godot/releases/download/4.7.2-stable/big.tpz', dest);
    vi.unstubAllGlobals();
    expect(readFileSync(dest).toString()).toBe('FULL-CONTENT');  // 无旧残留拼接
    rmSync(dir, { recursive: true, force: true });
  });
});
