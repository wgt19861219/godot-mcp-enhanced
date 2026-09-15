// src/web-gui/files-api.ts
// 资源管理工作台纯逻辑层(spec 2026-09-15 v2 §3):列目录/读三模式/保存三重护栏。
// 路径安全链(§3.2):isPathInAllowedRoots+project.godot 校验 → resolveWithinRoot → 隐藏降噪。
import { readdir, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { isPathInAllowedRoots, resolveWithinRoot } from '../core/path-utils.js';

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
    if (st.size > TEXT_MAX) throw new FilesError('too_large', `file ${st.size}B exceeds 512KB text limit`);
    const content = await readFile(abs, 'utf-8');
    return { content, mtime: st.mtimeMs, size: st.size };
  }

  async readRaw(projectPath: string, rel: string): Promise<RawFile> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    const e = ext(basename(abs));
    const max = IMG_EXTS.has(e) ? IMG_MAX : AUDIO_EXTS.has(e) ? AUDIO_MAX : OTHER_RAW_MAX;
    if (st.size > max) throw new FilesError('too_large', `file ${st.size}B exceeds raw limit`);
    const bytes = await readFile(abs);
    return { bytes, contentType: CONTENT_TYPES[e] ?? 'application/octet-stream', size: st.size };
  }

  async readHex(projectPath: string, rel: string): Promise<HexSample> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    const fh = await readFile(abs);
    return { size: st.size, bytes: Array.from(fh.subarray(0, HEX_SAMPLE_BYTES)) };
  }

  async saveText(projectPath: string, rel: string, content: string, baseMtime: number): Promise<{ mtime: number }> {
    const abs = resolveInProject(projectPath, rel);
    if (!TEXT_EXTS.has(ext(basename(abs)))) throw new FilesError('bad_request', 'not a text extension');
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found (creation not supported)'); }
    if (st.mtimeMs !== baseMtime) {   // 乐观锁(§3.3-2):冲突带最新内容供前端提示
      const latest = await readFile(abs, 'utf-8');
      throw new FilesError('conflict', 'file modified since loaded', latest, st.mtimeMs);
    }
    // 备份(§3.3-3):percent-encode 可逆无碰撞;0o600 滚动覆盖。
    // 编码集锁定为 '\' 与 ':'(与测试锁定一致):'\' 是 Linux 合法字面字符必须编码;
    // '/' 不编码——保留为目录分隔符天然区分路径,若编码则 Linux 绝对路径(/tmp/...)与
    // 测试的 join 期望不匹配(CI Linux 必红),且无碰撞收益。
    const projEnc = projectPath.replaceAll('\\', '%5C').replaceAll(':', '%3A');
    const relEnc = rel.replaceAll('\\', '%5C').replaceAll(':', '%3A');
    const bakDir = join(this.backupDir, projEnc);
    await mkdir(bakDir, { recursive: true });
    await writeFile(join(bakDir, relEnc + '.bak'), await readFile(abs), { mode: 0o600 });
    // 原子写(§3.3-4)
    const tmp = abs + '.mcp-tmp';
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, abs);
    const after = await stat(abs);
    return { mtime: after.mtimeMs };
  }
}
