import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'fs';
import { join, sep, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from './logger.js';
import { getErrorMessage } from '../types.js';
import { safeRealPath } from './path-utils.js';
import { InternalError } from './tool-errors.js';

const execFileAsync = promisify(execFile);

const WINDOWS_SEARCH_DIRS = [
  'C:\\Program Files\\Godot',
  'C:\\Program Files (x86)\\Godot',
  // User-specific locations (resolved at runtime to avoid hardcoded usernames)
];

/** Extra search directories from GODOT_MCP_SEARCH_PATHS env var (semicolon-separated). */
function getExtraSearchDirs(): string[] {
  const env = process.env.GODOT_MCP_SEARCH_PATHS;
  if (!env) return [];
  return env.split(';').filter(d => d.length > 0);
}

/** Resolve user-specific search directories (Downloads, Desktop, etc.). */
function getUserSearchDirs(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  return [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ];
}

const POSIX_CANDIDATES = [
  '/usr/bin/godot4',
  '/usr/local/bin/godot4',
  '/Applications/Godot.app/Contents/MacOS/Godot',
];

// ─── Multi-path cache (replaces global singleton) ────────────────────────────
// Key: projectPath or GLOBAL_KEY for the default fallback
const GLOBAL_KEY = '__global__';
const _pathCache = new Map<string, string>();

/**
 * 判定 `godot --version` 输出是否为可信的 Godot 版本签名。
 *
 * C-SEC-2 安全考量:旧的宽松校验 includes('godot') || /^\d+\.\d+/ 会被任何
 * 打印 "4.6" 的二进制绕过——经 godot_path 工具参数覆盖后该二进制被 spawn 执行
 * (任意代码执行)。收紧后接受任一:
 *   1. 输出含 "godot" 关键字(大小写不敏感)且带至少 major.minor 版本号;或
 *   2. 完整三段语义版本号 major.minor.patch(如 4.6.3);或
 *   3. 两段版本号 + Godot 状态/构建后缀(如 4.3.stable / 4.6.rc / 4.0.dev)。
 *
 * 这把伪造成本从"打印 4.6"提高到"伪造形如 Godot 版本签名的输出"。
 * 注:无法防御会完整伪造 --version 输出的攻击者——完整防御需路径白名单
 * (GODOT_MCP_ALLOWED_GODOT_PATHS)或二进制签名校验。
 * 另:状态后缀列表(stable|rc|dev|...)非穷举(review M-4);自定义构建若被误拒,
 * 用户应通过 GODOT_PATH 环境变量显式指定(该分支亦走本校验)。
 */
function isGodotVersionSignature(stdout: string): boolean {
  const v = stdout.trim();
  const hasGodotWord = /godot/i.test(v);
  const hasMajorMinor = /\d+\.\d+/.test(v);
  const hasThreePartVersion = /\d+\.\d+\.\d+/.test(v);
  const hasVersionStatus = /\d+\.\d+\.(stable|rc|dev|beta|alpha|custom|mono|official|gentoo|flathub|homebrew|llvm)/i.test(v);
  return (hasGodotWord && hasMajorMinor) || hasThreePartVersion || hasVersionStatus;
}

// ─── 批 2 B-3:机器级 godot-paths.json(CLI install 写入,白名单/搜索链消费)──────

/** 配置文件路径:~/.godot-mcp/godot-paths.json(机器级目录惯例,同 instances/、qa-reports/)。 */
export function getGodotPathsConfigFile(): string {
  return join(homedir(), '.godot-mcp', 'godot-paths.json');
}

/**
 * 容错读取:文件不存在 / JSON 损坏 / paths 非数组 → [];
 * 数组内仅保留非空字符串(非法元素静默剔除)。
 */
export function readGodotPathsConfig(): string[] {
  try {
    const raw = readFileSync(getGodotPathsConfigFile(), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; paths?: unknown };
    if (!Array.isArray(parsed.paths)) return [];
    return parsed.paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/** 去重 + 原子写(tmp + rename,防半写状态被读到)。 */
export function writeGodotPathsConfig(paths: string[]): void {
  const unique = [...new Set(paths)];
  const file = getGodotPathsConfigFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify({ version: 1, paths: unique }, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/**
 * C-SEC-godotpath: GODOT_MCP_ALLOWED_GODOT_PATHS 路径白名单(分号分隔,realpath 归一)。
 * 签名校验(isGodotVersionSignature)之上的硬隔离——防 AI 可控的 godot_path
 * 工具参数/project override/env 指向任意二进制被 spawn(任意代码执行)。
 * 批 2 优先级链:UNRESTRICTED 旁路 → env 设了即用(显式用户意图)→
 * 机器级 godot-paths.json(CLI install 登记的路径视为可信)→ 两者皆无
 * back-compat 放行(签名校验仍兜底)。
 */
export function isGodotPathAllowed(candidatePath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') return true;
  const raw = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
  const allowed = raw && raw.trim() !== ''
    ? raw.split(/[;]+/).map(s => s.trim()).filter(Boolean)
    : readGodotPathsConfig();
  if (allowed.length === 0) return true;  // env 与 config 皆无 = back-compat 放行
  let realCandidate: string;
  try { realCandidate = safeRealPath(candidatePath); } catch { realCandidate = candidatePath; }
  const isAllowed = allowed.some(a => {
    let realA: string;
    try { realA = safeRealPath(a); } catch { realA = a; }
    return realCandidate === realA || realCandidate.startsWith(realA + sep) || realCandidate.startsWith(realA + '/');
  });
  if (!isAllowed) {
    getLogger().warn('security', `godot path "${candidatePath}" rejected by GODOT_MCP_ALLOWED_GODOT_PATHS whitelist`);
  }
  return isAllowed;
}

/** G-CONF (2026-09-01): 路径指向目录的显式判定(对标 godot-ai 69ba29f「拒绝指向目录的 GODOT_BIN」)。
 * 此前目录候选只会在 execFile 报 ENOENT/EACCES 后落进 debug 日志,用户可见的只剩含混的
 * "Godot binary not found"。stat 失败(不存在/权限)返回 false,交回原有失败路径。 */
function isDirectoryPath(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** validateGodotBinary 的分层结果——失败时带 stage(校验器在哪一步判非法)。
 * D3 (2026-09-17 反馈批次D, 09-06 fr2 反馈): ToolDispatcher 的 godot_path 校验错误
 * 出口消费它组装诊断线索,替代单句 "not a valid Godot binary"(合法 4.7.2 console exe
 * 被拒时无从排查)。validateGodotBinary 保持 boolean 语义供 finder 内部候选循环消费。 */
export type GodotBinaryCheck =
  | { ok: true }
  | { ok: false; stage: 'path-not-allowed' | 'is-directory' | 'version-run-failed' | 'not-godot-signature'; stdoutPreview?: string };

/** Validate a candidate binary by running --version and checking for Godot signature. */
export async function validateGodotBinaryDetailed(candidatePath: string): Promise<GodotBinaryCheck> {
  if (!isGodotPathAllowed(candidatePath)) return { ok: false, stage: 'path-not-allowed' };
  if (isDirectoryPath(candidatePath)) {
    getLogger().warn('godot-finder', `godot candidate is a directory, not an executable: ${candidatePath}`);
    return { ok: false, stage: 'is-directory' };
  }
  try {
    const { stdout } = await execFileAsync(candidatePath, ['--version'], { encoding: 'utf-8', timeout: 5000, env: buildSafeEnv() });
    if (!isGodotVersionSignature(stdout)) {
      getLogger().warn('godot-finder', `godot candidate --version output not a Godot signature: ${JSON.stringify(stdout.trim().slice(0, 80))}`);
      return { ok: false, stage: 'not-godot-signature', stdoutPreview: stdout.trim().slice(0, 80) };
    }
    return { ok: true };
  } catch (err) {
    getLogger().debug('godot-finder', `validateGodotBinary failed for ${candidatePath}: ${err instanceof Error ? err.message : err}`);
    return { ok: false, stage: 'version-run-failed' };
  }
}

export async function validateGodotBinary(candidatePath: string): Promise<boolean> {
  return (await validateGodotBinaryDetailed(candidatePath)).ok;
}

/**
 * 跑 `godot --version` 返回完整版本串(如 "4.6.2.stable")。
 * execFileAsync + buildSafeEnv(安全),isGodotVersionSignature 校验防伪造。
 * 非零退出/超时 → "godot --version failed";签名无效 → "Invalid Godot version signature"(区分,审查①)。
 * 消费方:check_template(提取 major.minor)、get_godot_version(optional refactor)。
 */
export async function detectGodotVersion(godotPath: string): Promise<string> {
  if (!isGodotPathAllowed(godotPath)) {
    throw new InternalError('godot path not in GODOT_MCP_ALLOWED_GODOT_PATHS');
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(godotPath, ['--version'], { encoding: 'utf-8', timeout: 10000, env: buildSafeEnv() }));
  } catch (err) {
    // PII 护栏:err.message(可能含路径)只 log 到 server 端,不进 client 响应。
    getLogger().debug('godot-finder', `detectGodotVersion --version failed: ${err instanceof Error ? err.message : err}`);
    throw new InternalError('godot --version failed');
  }
  const v = stdout.trim();
  if (!isGodotVersionSignature(v)) throw new InternalError('Invalid Godot version signature');
  return v;
}

function findInDirectory(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      if (/^Godot_v4.*\.exe$/i.test(entry)) {
        return join(dir, entry);
      }
    }
  } catch (err) { getLogger().debug('godot-finder', `scanning directory: ${err instanceof Error ? err.message : err}`); }
  return null;
}

// ─── Project-level override resolution ────────────────────────────────────────

/**
 * Try to resolve a project-specific Godot binary path.
 * Priority: .godot/mcp-godot.json > project.godot [godot_mcp] > .godot-version (godots)
 */
async function tryProjectOverride(projectPath: string): Promise<string | null> {
  // A. Try .godot/mcp-godot.json
  const mcpConfigPath = join(projectPath, '.godot', 'mcp-godot.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const raw = readFileSync(mcpConfigPath, 'utf-8');
      const config = JSON.parse(raw) as { godot_path?: string };
      if (config.godot_path) {
        const candidate = config.godot_path;
        if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
      }
    } catch (err) {
      getLogger().debug('godot-finder', `mcp-godot.json parse error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // B. Try [godot_mcp] section in project.godot
  const projectGodotPath = join(projectPath, 'project.godot');
  if (existsSync(projectGodotPath)) {
    try {
      const content = readFileSync(projectGodotPath, 'utf-8');
      // Match [godot_mcp] section and extract godot_path value
      const sectionMatch = content.match(/^\[godot_mcp\]\s*\n([\s\S]*?)(?=\n\[|$)/m);
      if (sectionMatch?.[1]) {
        const pathMatch = sectionMatch[1].match(/^godot_path\s*=\s*"?(.+?)"?\s*$/m);
        if (pathMatch?.[1]) {
          const candidate = pathMatch[1].trim();
          if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
        }
      }
    } catch (err) {
      getLogger().debug('godot-finder', `project.godot read error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // C. Try .godot-version file (godots / asdf-style version managers)
  const versionFile = join(projectPath, '.godot-version');
  if (existsSync(versionFile)) {
    try {
      const versionSpec = readFileSync(versionFile, 'utf-8').trim();
      if (versionSpec) {
        const resolved = resolveGodotsVersion(versionSpec);
        if (resolved) {
          if (await validateGodotBinary(resolved)) return resolved;
        }
      }
    } catch (err) {
      getLogger().debug('godot-finder', `.godot-version read error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return null;
}

/**
 * Resolve a godots version specifier to a Godot binary path.
 * Searches ~/.godots/versions/ (and platform-specific locations) for matching versions.
 * Uses prefix matching: "4.6" matches "4.6.3-stable" but NOT "14.6.0".
 */
function resolveGodotsVersion(versionSpec: string): string | null {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;

  // godots stores versions in ~/.godots/versions/<version>/
  const godotsDirs = [
    join(home, '.godots', 'versions'),
    // macOS: check Application Support
    join(home, 'Library', 'Application Support', 'Godots', 'versions'),
  ];

  // Build a safe prefix regex: "4.6" → /^4\.6/ (escape dots, anchor to start)
  const prefix = versionSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionRe = new RegExp(`^${prefix}`);

  for (const godotsDir of godotsDirs) {
    if (!existsSync(godotsDir)) continue;
    try {
      let bestMatch: string | null = null;
      let bestEntry = '';
      for (const entry of readdirSync(godotsDir)) {
        if (versionRe.test(entry)) {
          // Prefer longer/more specific matches (e.g. "4.6.3" over "4.6")
          if (entry.length > bestEntry.length) {
            const versionDir = join(godotsDir, entry);
            const found = findGodotBinaryInDir(versionDir);
            if (found) {
              bestMatch = found;
              bestEntry = entry;
            }
          }
        }
      }
      if (bestMatch) return bestMatch;
    } catch { /* skip */ }
  }

  return null;
}

/** Find a Godot binary inside a directory (recursively, depth 1). */
function findGodotBinaryInDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      // Direct executable
      if (process.platform === 'win32' && /^Godot.*\.exe$/i.test(entry)) return fullPath;
      if (process.platform !== 'win32' && /^Godot$/i.test(entry)) return fullPath;
      // macOS .app bundle
      if (entry.endsWith('.app')) {
        const macosBin = join(fullPath, 'Contents', 'MacOS', 'Godot');
        if (existsSync(macosBin)) return macosBin;
      }
      // Check one level deeper
      if (existsSync(fullPath) && !entry.startsWith('.')) {
        try {
          for (const sub of readdirSync(fullPath)) {
            if (process.platform === 'win32' && /^Godot.*\.exe$/i.test(sub)) return join(fullPath, sub);
            if (process.platform !== 'win32' && /^Godot$/i.test(sub)) return join(fullPath, sub);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Clear the cached Godot binary path. If projectPath is given, only clear that project's cache. */
export function clearGodotPathCache(projectPath?: string): void {
  if (projectPath) {
    _pathCache.delete(projectPath);
  } else {
    _pathCache.clear();
  }
}

/** Get the currently cached Godot binary path, or null if not yet resolved. */
export function getCachedGodotPath(projectPath?: string): string | null {
  return _pathCache.get(projectPath ?? GLOBAL_KEY) ?? null;
}

/**
 * Find a Godot binary.
 * When projectPath is given, checks project-level overrides first (.godot/mcp-godot.json,
 * project.godot [godot_mcp], .godot-version). Falls back to global GODOT_PATH, PATH, and
 * platform-specific search.
 */
export async function findGodot(projectPath?: string): Promise<string> {
  const cacheKey = projectPath ?? GLOBAL_KEY;

  // 1. Check cache
  const cached = _pathCache.get(cacheKey);
  // 缓存命中仍须通过白名单——env 运行时变更后 stale cache 不应绕过新策略
  if (cached && (cached === 'godot' || existsSync(cached)) && isGodotPathAllowed(cached)) return cached;
  _pathCache.delete(cacheKey);

  // N-4 (2026-09-01 审查): tried 诊断列表死代码清除——只 push 从不消费,不进任何
  // 错误消息;失败原因的可读化由各分支自身的 warn/debug 日志承担(G-CONF 目录拒绝等)。

  // 2. Project-level overrides (only when projectPath is given)
  if (projectPath) {
    const projectOverride = await tryProjectOverride(projectPath);
    if (projectOverride) { _pathCache.set(cacheKey, projectOverride); return projectOverride; }
  }

  // 3. Environment variable — validate the binary
  if (process.env.GODOT_PATH) {
    if (existsSync(process.env.GODOT_PATH)) {
      // G-CONF (2026-09-01): 显式 env 配置指向目录 → 显性报错而非静默落入后续搜索链
      // (fallback 到 registry/scoop 找到的版本会掩盖用户的配置错误);路径值不进
      // client 消息(PII-safe),完整路径见 server 日志。
      if (isDirectoryPath(process.env.GODOT_PATH)) {
        getLogger().warn('godot-finder', `GODOT_PATH is a directory, not an executable: ${process.env.GODOT_PATH}`);
        throw new InternalError('GODOT_PATH points to a directory, not an executable (set it to the Godot executable file path)');
      }
      if (await validateGodotBinary(process.env.GODOT_PATH)) {
        _pathCache.set(cacheKey, process.env.GODOT_PATH);
        return process.env.GODOT_PATH;
      }
    }
  }

  // 3.5 批 2 B-3:机器级 godot-paths.json 候选(CLI install 登记的 Godot,
  // 用户显式安装动作 → 优先于 PATH 里可能过期的版本;validateGodotBinary 内含白名单校验)
  for (const candidate of readGodotPathsConfig()) {
    if (existsSync(candidate)) {
      if (await validateGodotBinary(candidate)) {
        _pathCache.set(cacheKey, candidate);
        return candidate;
      }
    }
  }

  // 4. Try `godot` on PATH via a quick async spawn
  try {
    const { stdout } = await execFileAsync('godot', ['--version'], { encoding: 'utf-8', timeout: 5000, env: buildSafeEnv() });
    if (isGodotVersionSignature(stdout)) {
      // PATH 解析的 'godot' 字面量在白名单启用时通常无法匹配绝对路径条目——
      // 视为不可校验,跳过让用户显式设 GODOT_PATH 或扩充白名单(含 PATH 目录)。
      if (isGodotPathAllowed('godot')) {
        _pathCache.set(cacheKey, 'godot');
        return 'godot';
      }
    }
  } catch (err) { getLogger().debug('godot-finder', `PATH godot failed: ${err instanceof Error ? err.message : err}`); }

  // 5. Windows-specific: Registry + Scoop
  if (process.platform === 'win32') {
    const registryResult = await findViaRegistry();
    if (registryResult) { _pathCache.set(cacheKey, registryResult); return registryResult; }

    const scoopResult = await findViaScoop();
    if (scoopResult) { _pathCache.set(cacheKey, scoopResult); return scoopResult; }
  }

  // 6. Platform-specific search
  if (process.platform === 'win32') {
    const allDirs = [...WINDOWS_SEARCH_DIRS, ...getUserSearchDirs(), ...getExtraSearchDirs()];
    for (const dir of allDirs) {
      const found = findInDirectory(dir);
      if (found && await validateGodotBinary(found)) { _pathCache.set(cacheKey, found); return found; }
    }
  } else {
    for (const candidate of POSIX_CANDIDATES) {
      if (existsSync(candidate) && await validateGodotBinary(candidate)) { _pathCache.set(cacheKey, candidate); return candidate; }
    }
  }

  throw new InternalError(
    // projectPath 仅用于条件分支(是否加项目级配置提示),其值不进 safeMessage(PII-safe)。
    projectPath
      ? 'Godot binary not found. Set GODOT_PATH, or for project-level config create .godot/mcp-godot.json or add [godot_mcp] section to project.godot.'
      : 'Godot binary not found. Set GODOT_PATH or add godot to PATH.',
  );
}

/** Windows: 查找注册表中的 Godot 安装路径 */
async function findViaRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    // 查询 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall 下的 Godot 条目
    const { stdout } = await execFileAsync('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s', '/f', 'Godot',
    ], { encoding: 'utf-8', timeout: 5000 });
    // 从输出中提取 DisplayIcon 或 InstallLocation 路径
    const match = stdout.match(/DisplayIcon\s+REG_SZ\s+(.+)/m);
    if (match?.[1]) {
      const candidate = match[1].trim();
      if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
    }
  } catch { /* registry not available or no entries */ }
  return null;
}

/** Windows: 查找 Scoop 安装的 Godot */
async function findViaScoop(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    const scoopShim = join(home, 'scoop', 'shims', 'godot.exe');
    if (existsSync(scoopShim) && await validateGodotBinary(scoopShim)) return scoopShim;
  } catch { /* ignore */ }
  return null;
}

// ── Godot 子进程 spawn 基建(W5 安家,2026-09-20 批2) ─────────────────────────
// buildSafeEnv/checkVersionMismatch 原住 src/helpers.ts 废弃桶,语义同属「Godot
// 二进制查找/版本探测/子进程 env」域,收编本文件。函数体零变化,纯搬家。

/**
 * Build a sanitized environment for Godot child processes.
 *
 * SECURITY NOTE (I-04): The following user-directory variables are passed
 * because Godot needs them to locate editor data, cache, and config:
 * HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_*, DISPLAY.
 * All other env vars are stripped to prevent credential leakage to child processes.
 *
 * S4/S5 (2026-06-24): GODOT_MCP_BRIDGE_* prefixed vars are passed through.
 * This is the mcp_bridge.gd runtime config sub-namespace (toggles like
 * GODOT_MCP_BRIDGE_PERSISTENT_SECRET / GODOT_MCP_BRIDGE_EXTRA_METHODS), NOT user
 * credentials. Stripping them at the spawn boundary silently breaks the GDScript-side
 * fixes — the env switch never flips, so the secret-reuse / method-whitelist logic
 * never runs.
 *
 * S4-editor (2026-07-11): GODOT_MCP_EDITOR_* added symmetrically — editor plugin
 * (addons/godot_mcp_server/websocket_server.gd) reads GODOT_MCP_EDITOR_PERSISTENT_SECRET
 * at _ready via OS.get_environment(); launch_editor spawns the editor with buildSafeEnv,
 * so without passthrough the env is stripped and PERSISTENT never triggers. Same
 * sub-namespace rule (runtime config, NOT credentials).
 *
 * Scope is intentionally narrow (GODOT_MCP_BRIDGE_ / GODOT_MCP_EDITOR_, not bare
 * GODOT_MCP_): server-side
 * security/sandbox switches (GODOT_MCP_UNRESTRICTED, GODOT_MCP_ALLOW_UNSAFE,
 * ALLOW_EXECUTE_GDSCRIPT, ALLOWED_PROJECT_PATHS) MUST stay stripped — a child
 * process must not unlock its own restrictions. See gdscript-executor-core.test.js.
 */
export function buildSafeEnv(): NodeJS.ProcessEnv {
  const godotMcpEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith('GODOT_MCP_BRIDGE_') || key.startsWith('GODOT_MCP_EDITOR_')) && value !== undefined) {
      godotMcpEnv[key] = value;
    }
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    APPDATA: process.env.APPDATA ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    GODOT: process.env.GODOT ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    COMSPEC: process.env.COMSPEC ?? '',
    OS: process.env.OS ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    DISPLAY: process.env.DISPLAY ?? '',
    // XAUTHORITY 与 DISPLAY 配对的 X11 认证文件。缺它 xvfb-run 下 spawn 的 Godot
    // 无法认证 X 连接 → 游戏进程秒退 → bridge 永不就绪(2026-08-15 CI matrix L2 根因)
    XAUTHORITY: process.env.XAUTHORITY ?? '',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '',
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
    ...godotMcpEnv,
  };
}

const GODOT_VERSION_CHECK_TIMEOUT_MS = 5000;

export async function checkVersionMismatch(projectPath: string, godotBin: string): Promise<string | null> {
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, 'utf-8');
    const featuresMatch = config.match(/config\/features=PackedStringArray\("([^"]+)"\)/);
    if (!featuresMatch) return null;
    const projectVersion = featuresMatch[1];

    const { stdout, stderr } = await execFileAsync(godotBin, ['--version'], { timeout: GODOT_VERSION_CHECK_TIMEOUT_MS, env: buildSafeEnv() });
    const binVersion = (stdout || stderr || '').trim();
    const binMatch = binVersion.match(/^(\d+\.\d+)/);
    if (!binMatch) return null;
    const binMajorMinor = binMatch[1];

    if (projectVersion !== binMajorMinor) {
      return `[WARNING] Version mismatch: project.godot expects Godot ${projectVersion}, but binary is ${binVersion} (${binMajorMinor}). Errors may be inaccurate.`;
    }
    return null;
  } catch (err) {
    getLogger().warn('helpers', `checkVersionMismatch failed: ${getErrorMessage(err)}`);
    return null;
  }
}
