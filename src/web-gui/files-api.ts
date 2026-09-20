// src/web-gui/files-api.ts
// 资源管理工作台纯逻辑层(spec 2026-09-15 v2 §3):列目录/读三模式/保存三重护栏。
// 路径安全链(§3.2):isPathInAllowedRoots+project.godot 校验 → resolveWithinRoot → 隐藏降噪。
import { readdir, stat, readFile, writeFile, mkdir, rename, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { isPathInAllowedRoots, resolveWithinRoot } from '../core/path-utils.js';
import { hardenFilePermissionsWindows } from './registry.js';
import { auditWebGui } from './audit-helper.js';
// 批4-T6(五维评估 P2): saveText 写 .gd 接全仓沙箱扫描——此前是"全仓写 .gd 必扫描"
// (script/shared.ts scanScriptSandboxOrThrow 声明)之外的第 4 个入口(web-gui 默认开启)。
import { scanGdscriptSandbox } from '../gdscript-executor.js';

export interface DirEntry { name: string; isDir: boolean; size: number; mtime: number; }
export interface TextFileContent { content: string; mtime: number; size: number; }
export interface RawFile { bytes: Buffer; contentType: string; size: number; }
export interface HexSample { size: number; bytes: number[]; }

export type FilesErrorCode = 'forbidden' | 'not_found' | 'too_large' | 'conflict' | 'bad_request';

export class FilesError extends Error {
  constructor(public readonly code: FilesErrorCode, message: string,
              public readonly latestContent?: string, public readonly latestMtime?: number) {
    super(message); this.name = 'FilesError';
  }
}

export const TEXT_EXTS: ReadonlySet<string> = new Set([
  'gd', 'tscn', 'tres', 'json', 'md', 'cfg', 'import', 'txt', 'gdignore', 'gitignore', 'bat', 'sh', 'ps1',
]);
export const IMG_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
export const AUDIO_EXTS: ReadonlySet<string> = new Set(['ogg', 'wav', 'mp3']);

const HIDDEN_DIRS = new Set(['.godot', '.git', '__pycache__', 'node_modules']);
const TEXT_MAX = 512 * 1024;
const IMG_MAX = 10 * 1024 * 1024;
const AUDIO_MAX = 20 * 1024 * 1024;
const OTHER_RAW_MAX = 50 * 1024 * 1024;
export const HEX_SAMPLE_BYTES = 4096;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
};

// controller 裁决(2026-09-15):dotfile(.gdignore/.gitignore)的 extname 返回空串,
// 回退取整名去前导点——否则 TEXT_EXTS 含 'gdignore' 却永远匹配不上,测试锁定此行为。
function ext(name: string): string {
  const e = extname(name).slice(1).toLowerCase();
  if (e) return e;
  return name.startsWith('.') ? name.slice(1).toLowerCase() : '';
}

/** 统一入口安全链(§3.2):白名单+project.godot→resolveWithinRoot;任何 PathError→forbidden。 */
function resolveInProject(projectPath: string, rel: string): string {
  if (!isPathInAllowedRoots(projectPath)) throw new FilesError('forbidden', 'path outside allowed roots');
  if (!existsSync(join(projectPath, 'project.godot'))) throw new FilesError('not_found', 'not a godot project (project.godot missing)');
  try {
    return resolveWithinRoot(projectPath, rel);
  } catch {
    throw new FilesError('forbidden', 'path escapes project root');
  }
}

export class FilesApi {
  private readonly backupDir: string;

  constructor(opts: { backupDir?: string } = {}) {
    this.backupDir = opts.backupDir ?? join(homedir(), '.godot-mcp', 'web-gui', 'backups');
  }

  async listDir(projectPath: string, sub: string): Promise<{ entries: DirEntry[] }> {
    const dir = resolveInProject(projectPath, sub);
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); }
    catch { throw new FilesError('not_found', 'directory not found'); }
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;   // 浏览层降噪(§3.2-3),非访问控制
      let size = 0; let mtime = 0;
      try { const st = await stat(join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch { /* 竞态删除:显示 0 */ }
      entries.push({ name: d.name, isDir: d.isDirectory(), size, mtime });
    }
    entries.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
    return { entries };
  }

  async readText(projectPath: string, rel: string): Promise<TextFileContent> {
    const abs = resolveInProject(projectPath, rel);
    if (!TEXT_EXTS.has(ext(basename(abs)))) throw new FilesError('bad_request', 'not a text extension; use preview mode');
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    if (st.isDirectory()) throw new FilesError('bad_request', 'is a directory');   // M-3:目录名带文本扩展时唯一防线
    if (st.size > TEXT_MAX) throw new FilesError('too_large', `file ${st.size}B exceeds 512KB text limit`);
    const content = await readFile(abs, 'utf-8');
    return { content, mtime: st.mtimeMs, size: st.size };
  }

  async readRaw(projectPath: string, rel: string): Promise<RawFile> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    if (st.isDirectory()) throw new FilesError('bad_request', 'is a directory');   // M-3:否则 readFile(目录)冒裸 EISDIR
    const e = ext(basename(abs));
    const max = IMG_EXTS.has(e) ? IMG_MAX : AUDIO_EXTS.has(e) ? AUDIO_MAX : OTHER_RAW_MAX;
    if (st.size > max) throw new FilesError('too_large', `file ${st.size}B exceeds raw limit`);
    const bytes = await readFile(abs);
    return { bytes, contentType: CONTENT_TYPES[e] ?? 'application/octet-stream', size: st.size };
  }

  async readHex(projectPath: string, rel: string): Promise<HexSample> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    if (st.isDirectory()) throw new FilesError('bad_request', 'is a directory');   // M-3:否则 open(目录)冒裸 EISDIR
    // 流式采样(controller 裁决 2026-09-15):handle 定位读,只占 4KB 缓冲——
    // 原 readFile 全量读入后截取会让 GB 级文件先占满内存,冲击同进程 MCP 会话。
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(HEX_SAMPLE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEX_SAMPLE_BYTES, 0);
      return { size: st.size, bytes: Array.from(buf.subarray(0, bytesRead)) };
    } finally {
      await fh.close();
    }
  }

  async saveText(projectPath: string, rel: string, content: string, baseMtime: number): Promise<{ mtime: number }> {
    const started = new Date();
    const abs = resolveInProject(projectPath, rel);
    const fileExt = ext(basename(abs));
    if (!TEXT_EXTS.has(fileExt)) throw new FilesError('bad_request', 'not a text extension');
    // 批4-T6(五维评估 P2): .gd 接全仓沙箱扫描(与 MCP 通道 write_script 同一防线,
    // 修复前是"全仓写 .gd 必扫描"声明外的第 4 入口)。bat/sh/ps1 无对应扫描器,明确
    // 不覆盖(威胁模型内 web-gui token 持有者本可直接写盘——方案 §4 裁决)。
    if (fileExt === 'gd') {
      const violations = scanGdscriptSandbox(content);
      if (violations.length > 0) {
        throw new FilesError('bad_request',
          `content blocked by gdscript sandbox scanner: ${violations[0]}`
          + ' (含危险模式的 .gd 请经 MCP 通道写入,那里有 out-of-band 确认门)');
      }
    }
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found (creation not supported)'); }
    if (st.mtimeMs !== baseMtime) {   // 乐观锁(§3.3-2):冲突带最新内容供前端提示
      const latest = await readFile(abs, 'utf-8');
      throw new FilesError('conflict', 'file modified since loaded', latest, st.mtimeMs);
    }
    // NOTE: TOCTOU window exists between stat(mtime 校验) and backup/write —
    // 两个并发保存可同时过校验造成丢更新;本地单用户面板场景接受该残留风险(标注风格对齐 path-utils.ts)。
    // 备份(§3.3-3):percent-encode 可逆无碰撞;0o600 滚动覆盖。
    // 编码集锁定为 '\' 与 ':'(与测试锁定一致):'\' 是 Linux 合法字面字符必须编码;
    // '/' 不编码——保留为目录分隔符天然区分路径,若编码则 Linux 绝对路径(/tmp/...)与
    // 测试的 join 期望不匹配(CI Linux 必红),且无碰撞收益。
    const projEnc = projectPath.replaceAll('\\', '%5C').replaceAll(':', '%3A');
    const relEnc = rel.replaceAll('\\', '%5C').replaceAll(':', '%3A');
    const bakDir = join(this.backupDir, projEnc);
    await mkdir(bakDir, { recursive: true, mode: 0o700 });
    const bakPath = join(bakDir, relEnc + '.bak');
    await writeFile(bakPath, await readFile(abs), { mode: 0o600 });
    // 审查 Low(2026-09-17 批 3):.bak 含旧文件全文,Windows 无视 0o600 → icacls 收紧 ACL
    // (对齐 registry.ts 登记文件/projects-store.ts 同域持久化文件惯例,best-effort)
    hardenFilePermissionsWindows(bakPath);
    // 原子写(§3.3-4)
    const tmp = abs + '.mcp-tmp';
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, abs);
    const after = await stat(abs);
    // 2C (2026-09-19 安全加固批2): Web GUI 旁路写接审计——files-api 不经 ToolDispatcher,
    // 此前 HTTP 文件写零留痕(可核查缺口)。批4-T8: 重构复用 audit-helper 统一出口
    // (caller 细分 web-gui:files;trace_id/duration/ok 诚实化),仍双写外置副本(2A)。
    auditWebGui('files', 'write_file', 'write', projectPath, { changedFiles: [rel], durationMs: Date.now() - started.getTime() });
    return { mtime: after.mtimeMs };
  }
}
