/**
 * Path security utilities — I-ARCH-03 (extracted from helpers.ts)
 *
 * Path traversal protection, symlink resolution, allowed roots validation.
 */

import { isAbsolute, resolve, relative, sep, basename, dirname, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';
import { PathError } from './tool-errors.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_DECODE_ITERATIONS = 20;

/** Windows device names that must never be used as file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) */
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// ─── Iterative URL decode ─────────────────────────────────────────────────────

/** A-15: Iterative URL decode — defeats multi-layer encoding. */
export function iterativeDecode(raw: string, maxIterations = MAX_DECODE_ITERATIONS): string {
  let decoded = raw;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < maxIterations) {
    prev = decoded;
    decoded = decodeURIComponent(decoded);
    iterations++;
  }
  return decoded;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Resolve a path to absolute. Does NOT validate security — use resolveWithinRoot for that. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** Validate and resolve a project root path. */
export const validatePath = resolvePath;

/** Validate that a path is a valid Godot project root (contains project.godot). */
export function validateProjectRoot(p: string): string {
  const resolved = resolvePath(p);
  if (!existsSync(join(resolved, 'project.godot'))) {
    throw new PathError('Not a valid Godot project (no project.godot found)');
  }
  return resolved;
}

// ─── Project path resolution (shared with ToolDispatcher) ────────────────────

/** 5min TTL cache — project path rarely changes mid-session */
let _resolvedProjectPath: string | undefined;
let _resolvedProjectPathTime = 0;
const PROJECT_PATH_CACHE_TTL_MS = 300_000;

/**
 * Resolve project path with priority chain:
 * 1. explicitPath (tool call argument) → use directly, no validation
 * 2. GODOT_PROJECT_PATH env → validate project.godot exists
 * 3. cwd upward search → find project.godot (max 30 levels)
 * 4. None → return undefined (caller decides error handling)
 *
 * Results are cached for 30s (PROJECT_PATH_CACHE_TTL_MS).
 */
export function resolveProjectPath(explicitPath?: string): string | undefined {
  if (explicitPath) return explicitPath;

  const now = Date.now();
  if (_resolvedProjectPathTime > 0 && now - _resolvedProjectPathTime < PROJECT_PATH_CACHE_TTL_MS) {
    return _resolvedProjectPath;
  }

  const rawEnvPath = process.env.GODOT_PROJECT_PATH;
  if (rawEnvPath) {
    const envPath = resolvePath(rawEnvPath); // normalize relative → absolute
    if (existsSync(join(envPath, 'project.godot'))) {
      _resolvedProjectPath = envPath;
      _resolvedProjectPathTime = now;
      return envPath;
    }
    getLogger().warn('godot-mcp', `GODOT_PROJECT_PATH="${rawEnvPath}" does not contain project.godot, ignoring`);
  }

  let dir = process.cwd();
  const searchedPaths: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, 'project.godot'))) {
      _resolvedProjectPath = dir;
      _resolvedProjectPathTime = now;
      return dir;
    }
    searchedPaths.push(dir);
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  getLogger().warn('godot-mcp', `resolveProjectPath: no project.godot found. Searched: ${searchedPaths.join(' → ')}`);
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = now;
  return undefined;
}

/** Reset cache state (test-only). */
export function _resetProjectPathCache(): void {
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = 0;
}

// ─── Symlink-safe path resolution ─────────────────────────────────────────────

/** Safely resolve real path — walks up to find existing ancestor for symlink resolution. */
export function safeRealPath(p: string, base?: string): string {
  try { return realpathSync(p); } catch {
    let current = resolvePath(p);
    const trailing: string[] = [];
    while (!existsSync(current)) {
      trailing.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let resolvedAncestor: string;
    try { resolvedAncestor = realpathSync(current); } catch (err) {
      // PII 护栏:err.message(可能含路径)只 log 到 server 端,不进 client 响应(safeMessage 是固定文本)。
      getLogger().debug('path-utils', `realpath failed: ${err instanceof Error ? err.message : err}`);
      throw new PathError('Cannot resolve real path during symlink resolution');
    }
    const resolved = trailing.length > 0 ? join(resolvedAncestor, ...trailing) : resolvedAncestor;
    if (base) {
      const rel = relative(base, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new PathError('Path traversal detected in fallback resolution');
      }
    }
    return resolved;
  }
}

// ─── Path traversal protection ────────────────────────────────────────────────

/**
 * Resolve userPath within root, blocking traversal attacks.
 *
 * Security layers: UNC path reject → Windows device name reject →
 * iterative URL decode → `..` segment reject → realpath + relative check.
 *
 * NOTE: TOCTOU window exists between symlink check and actual use —
 * accepted risk for local-only scenarios.
 */
export function resolveWithinRoot(root: string, userPath: string): string {
  const base = safeRealPath(resolvePath(root));

  if (/^\\\\[^\\]/.test(userPath)) {
    throw new PathError('Path traversal detected');
  }

  const leafName = userPath.replace(/\\/g, '/').split('/').pop() || '';
  const baseName = leafName.replace(/\.[^.]*$/, '');
  if (WINDOWS_DEVICE_RE.test(baseName)) {
    throw new PathError('Path traversal detected');
  }

  let decoded: string;
  try {
    decoded = iterativeDecode(userPath);
  } catch {
    throw new PathError('Path traversal detected');
  }

  const normalizedPath = decoded.replace(/\\/g, '/');
  // P2-6 (2026-09-11,审查修正): drive-relative("C:foo",盘符后无路径分隔符)——path.resolve
  // 会丢弃 base 解析到盘符 cwd;目标不存在时 safeRealPath 回落 base,造成"静默指向项目根"
  // 的语义歧义(BuildersGate padserver 实测形态),显式拒。**带根的 "C:/x" 不在此拒**——
  // 项目内绝对路径是 read_scene 等的合法用法(e2e 实用),由后续 resolve+relative 链放行
  // (项目内)或拒(项目外)。首版 /^[A-Za-z]:/ 误伤项目内绝对路径,e2e read_scene 全红。
  if (/^[A-Za-z]:(?:$|[^/])/.test(normalizedPath)) {
    throw new PathError('Path traversal detected');
  }
  // CI Linux 失败修复(P2-6 后续, 2026-09-13): 带根 "C:/x" 在 Windows 走后续链
  // (isAbsolute → 项目外拒/项目内放行),但 Linux 上 isAbsolute=false 被当相对路径
  // join 进项目内放行("c:/evil.gd" 解析成 <root>/c:/evil.gd)——同一输入跨平台
  // 判定漂移。"长得像 Windows 绝对路径但本平台不视为绝对"是形态歧义,显式拒;
  // Windows 项目内绝对路径(isAbsolute=true)不受影响,行为零变化。
  if (/^[A-Za-z]:\//.test(normalizedPath) && !isAbsolute(normalizedPath)) {
    throw new PathError('Path traversal detected');
  }
  // F-4: 段级精确匹配,避免误拒含 ".." 的合法文件名(my..file.txt、..hidden、foo/..bar)
  // 子串匹配会 over-block;第180行 realpath+relative 兜底仍保留作纵深防御
  const segments = normalizedPath.split('/');
  if (segments.some(s => s === '..')) {
    throw new PathError('Path traversal detected');
  }
  const resolved = resolve(base, normalizedPath);
  const realResolved = safeRealPath(resolved, base);
  const rel = relative(base, realResolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathError('Path traversal detected');
  }
  return realResolved;
}

// ─── Project path utilities ───────────────────────────────────────────────────

export function normalizeUserProjectPath(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('res://')) return trimmed.slice('res://'.length);
  return trimmed;
}

// D 批（v0.30）：MCP Roots 动态授权源已退役。
// 2026-07-28 规范正式废弃 Roots（12 个月窗口），SDK 官方迁移路径是 configuration
// （即 ALLOWED_PROJECT_PATHS env）。此前 modern era 下 listRoots 本就抛错回落 env，
// 退役后 legacy roots 客户端也统一走 env——语义更一致。详见 docs/protocol-debt-2026-07-28.md。

export function getAllowedProjectPaths(): string[] {
  const env = process.env.ALLOWED_PROJECT_PATHS;     // 唯一授权源（deny-by-default，见 isPathInAllowedRoots）
  if (!env) return [];
  return env.split(';').filter(Boolean).map(p => resolvePath(p));
}

/** Web GUI 扫描根(spec 2026-09-15 §3.2):allowlist 条目 realpath 归一化数组。
 *  与 isPathInAllowedRoots 的归一化语义同源(junction 防绕过);空数组=未配置,调用方自行 cwd 兜底。 */
export function getAllowedRealRoots(): string[] {
  return getAllowedProjectPaths().map(p => normalize(safeRealPath(p)));
}

const _pathAllowLogged = new Set<string>();

function ensureSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Check whether a requested path is within allowed project roots.
 *
 * Priority (highest wins):
 * 1. GODOT_MCP_UNRESTRICTED=true → allow everything (dev mode)
 * 2. ALLOWED_PROJECT_PATHS=/path1;/path2 → allow only listed roots + children
 * 3. No config → restrict to process.cwd() (deny-by-default)
 *
 * C-07: Changed from allow-by-default to deny-by-default.
 * Users must explicitly opt in via ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED.
 */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
    if (!_pathAllowLogged.has('unrestricted')) {
      getLogger().info('security', 'GODOT_MCP_UNRESTRICTED=true — all path restrictions bypassed');
      _pathAllowLogged.add('unrestricted');
    }
    // A-10: Debug-level audit log for every path access in unrestricted mode
    getLogger().debug('security', `UNRESTRICTED path access: ${requestedPath}`);
    return true;
  }
  // C-1 (2026-06-24 审查 Critical) + C-SEC-1: requestedPath 与 allowlist 条目都先 realpath
  // 归一化,再 normalize 消除 ".." 与混合分隔符。原实现只 normalize 不解析 reparse 点——
  // allowlist 内建 junction(Windows 普通用户权限即可,区别于 symlink)指向外部目录时,
  // startsWith(root) 前缀匹配放行;而下游 resolveWithinRoot 的 base=safeRealPath(root) 又把
  // base realpath 成 reparse 目标,relative(target, target/child) 不以 ".." 开头 → 读写
  // allowlist 外任意文件。两层 realpath 后:requestedPath 的 junction 解析到外部 → 不在
  // allowlist → 拒绝;allowlist 条目若本身是 junction 也解析到真实目标,避免合法访问被误拒。
  // safeRealPath 对不存在路径向上找存在祖先再 realpath(尾部字面拼接),兼顾"待创建新文件"场景。
  // TOCTOU(I-3 审查补注):同 resolveWithinRoot(:150 注释),safeRealPath 归一化后到实际写文件前,
  // 父段仍可能被换 symlink。本检查是本地单用户信任场景的安全边界,非多用户/不可信输入硬隔离。
  const requested = normalize(safeRealPath(resolvePath(requestedPath)));
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    // C-07: deny-by-default — restrict to cwd when no explicit allowlist configured.
    // Users must set ALLOWED_PROJECT_PATHS=/path1;/path2 or GODOT_MCP_UNRESTRICTED=true
    // to access paths outside cwd.
    if (!_pathAllowLogged.has('cwd-fallback')) {
      getLogger().warn('security',
        'ALLOWED_PROJECT_PATHS not configured — restricting to process.cwd(). ' +
        'Set ALLOWED_PROJECT_PATHS=/path1;/path2 for explicit control, ' +
        'or GODOT_MCP_UNRESTRICTED=true to disable restrictions.');
      _pathAllowLogged.add('cwd-fallback');
    }
    const cwd = normalize(safeRealPath(resolvePath('.')));
    return requested === cwd || requested.startsWith(ensureSep(cwd));
  }
  return allowed.some(p => {
    let normP: string;
    try {
      normP = normalize(safeRealPath(resolvePath(p)));
    } catch (err) {
      // I-4 (审查反馈): allowlist 条目祖先 realpathSync 失败(权限/reparse)时 safeRealPath :128 throw,
      // 原冒泡到 ToolDispatcher:464 导致整个校验抛错。该条目视为不匹配,不影响其他条目。
      getLogger().warn('security', `Allowlist entry realpath failed, skipping: ${p} — ${err instanceof Error ? err.message : err}`);
      return false;
    }
    return requested === normP || requested.startsWith(ensureSep(normP));
  });
}

/** 审查 I-E(2026-09-03): 错误消息里的「允许根列表」必须与 isPathInAllowedRoots 判定同源生成。
 *  上轮 NIT-2 的复刻式对齐(调用方本地重写分支逻辑)仍有残余漂移:判定侧对每条 allowlist 条目做
 *  safeRealPath 归一化、realpath 失败的条目跳过不放行,复刻的提示侧无差别列出——用户按提示把
 *  文件放进该条目仍被拒。本函数与判定走相同归一化链:realpath 失败条目同样不列;空 allowlist 时
 *  列 cwd fallback(同样归一化)。全部条目 realpath 失败时回列原始配置(此时问题在配置本身)。 */
export function describeAllowedRoots(): string {
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    return normalize(safeRealPath(resolvePath('.')));
  }
  const roots: string[] = [];
  for (const p of allowed) {
    try {
      roots.push(normalize(safeRealPath(resolvePath(p))));
    } catch {
      // 与 isPathInAllowedRoots 同语义:realpath 失败条目判定侧不放行,提示侧同样不列。
    }
  }
  return roots.length > 0 ? roots.join('; ') : allowed.join('; ');
}

/** Reset log state (test-only). */
export function _resetPathAllowWarned(): void { _pathAllowLogged.clear(); }


/**
 * Check whether the user has explicitly allowed paths outside the project root.
 *
 * Returns true when:
 * - GODOT_MCP_UNRESTRICTED=true (dev mode), OR
 * - ALLOWED_PROJECT_PATHS is configured (explicit opt-in)
 *
 * When false, callers should use resolveWithinRoot() to restrict paths.
 * When true, callers should still validate with isPathInAllowedRoots().
 *
 * @deprecated since v0.18.0 — prefer isPathInAllowedRoots() directly.
 * W5(2026-09-20 批2): 原住 src/helpers.ts;仍有真实调用方(screenshot.ts 5 处),
 * 搬至本文件与 getAllowedProjectPaths 同居,deprecated 语义保留待调用方迁移。
 */
export function allowOutsideProjectPaths(): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') return true;
  return getAllowedProjectPaths().length > 0;
}
