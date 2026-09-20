/**
 * GDScript executor module for Godot MCP Enhanced.
 *
 * Enables execution of arbitrary GDScript code in a headless Godot process.
 * Inspired by Hastur Operation Plugin's remote execution design:
 * - Code snippet auto-wrapping (no `extends` → auto-wrap)
 * - Structured key-value output via `_mcp_output(key, value)`
 * - Marked output protocol for reliable parsing
 *
 * SECURITY WARNING: GDScript has full system access (FileAccess, DirAccess,
 * OS.execute = arbitrary shell). scanGdscriptSandbox provides a blacklist to catch
 * accidental misuse, NOT a security boundary — GDScript is Turing-complete so regex
 * cannot exhaustively block indirect/reflection bypasses (variable first-arg to
 * .call(), StringName(), etc.). Acceptable for local single-user MCP; for multi-user
 * or untrusted input use container/VM isolation + GODOT_MCP_ALLOW_UNSAFE=false.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile, mkdir, rm, readdir, lstat, mkdtemp } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir, userInfo } from 'os';
import { randomUUID, createHash } from 'crypto';
import { analyzeOutput, type ParsedError } from './error-analyzer.js';
import { forceKillTree, getRunSessionProc, acquireShortRunningSlot, releaseShortRunningSlot, registerSpawnedGodotPid, unregisterSpawnedGodotPid } from './core/process-state.js';
import { buildSafeEnv } from './core/godot-finder.js';
import { MARKER_RESULT as MARKER_RESULT_SHARED, MARKER_ERROR as MARKER_ERROR_SHARED, GD_MCP_GET_ROOT, GD_MCP_GET_NODE, GD_MCP_LOAD_MAIN_SCENE, GD_MCP_OUTPUT } from './tools/shared.js';
import { normalizeIndentToTabs as _sharedNormalizeIndent } from './tools/shared/value-serializer.js';
import { getLogger, resolveLogDir } from './core/logger.js';
import { needsImport, runImport } from './tools/import-check.js';


// W5 遗留批5(2026-09-20):Sandbox scanner + autoload 防线段拆至 core/sandbox-scanner.ts(纯搬家)。
// 此处 re-export 兼容存量消费方(bpy-sandbox/overrides/bridge-client/web-gui/测试等零改动);新代码请直连新家。
export {
  escapeRegExp,
  stripLiterals,
  scanGdscriptSandbox,
  loadExtraDangerousPatterns,
  detectAutoloadUsage,
  parseAutoloadNames,
  removeOrphanBridgeLines,
  repairOrphanedBridgeAutoload,
  _resetAutoloadCache,
  _resetExtraDangerousPatternsCache,
} from './core/sandbox-scanner.js';
import {
  scanGdscriptSandbox,
  detectAutoloadUsage,
  parseAutoloadNames,
  repairOrphanedBridgeAutoload,
} from './core/sandbox-scanner.js';
// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutputEntry {
  key: string;
  value: string;
}

export interface ExecuteGdscriptResult {
  success: boolean;
  compile_success: boolean;
  compile_error: string;
  /** Structured error list with type, file, line, message, and suggestion */
  errors: ParsedError[];
  run_success: boolean;
  run_error: string;
  outputs: OutputEntry[];
  raw_output: string;
  duration_ms: number;
  /** Auto-detected autoload references (non-empty when load_autoloads was auto-enabled) */
  autoload_detected?: string[];
  /** C-AUDIT: per-execution id（对照 UE 9b128514），崩溃/超时后凭日志反查具体执行 */
  executionId?: string;
  /** C-AUDIT: 原始用户 code 的字节级 SHA-256（hex），不含原始 code 本身（对齐 I-10） */
  scriptSha256?: string;
}

export interface ExecuteGdscriptOptions {
  godotPath: string;
  projectPath: string;
  code: string;
  timeout: number; // seconds
  /** When true, runs with full autoload context (slower but can access autoloads like DataRegistry) */
  loadAutoloads?: boolean;
}

// ─── Execute 取证审计（C-AUDIT，对照 UE 9b128514）─────────────────────────────
//
// 在 spawn godot 之前对【原始用户 code】算字节级 SHA-256 + 生成 executionId，记一条
// EXECUTE_BEGIN 结构化审计日志。崩溃/超时后可凭日志反查到具体执行（哪段 code、写到哪个
// 临时文件）。事件【不含原始 code】（对齐 I-10 字面量脱敏），只放 hash + 路径 + 模式。

export interface ExecAuditEvent {
  audit: 'EXECUTE_BEGIN';
  executionId: string;
  scriptSha256: string;
  scriptPath: string;
  mode: string;
  autoload: boolean;
}

export function buildExecAuditEvent(input: {
  code: string;
  scriptPath: string;
  mode: string;
  autoload: boolean;
}): ExecAuditEvent {
  return {
    audit: 'EXECUTE_BEGIN',
    executionId: randomUUID(),
    scriptSha256: createHash('sha256').update(input.code, 'utf8').digest('hex'),
    scriptPath: input.scriptPath,
    mode: input.mode,
    autoload: input.autoload,
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TMP_PREFIX = 'godot-mcp-exec-';

/** I-16: Opaque symbol to prevent external code from bypassing sandbox */
const _trustedSymbol = Symbol('trusted');

/** Execute GDScript with sandbox scanning disabled. Only for internal trusted code paths. */
export function executeGdscriptTrusted(options: Omit<ExecuteGdscriptOptions, '_skipSandbox'>): Promise<ExecuteGdscriptResult> {
  (options as unknown as Record<symbol, boolean>)[_trustedSymbol] = true;
  return executeGdscript(options as ExecuteGdscriptOptions);
}

/**
 * P6 (2026-09-11): runtime 工具族通道——只跳 Phase 3(tokenizer 非字面量 load 拦截),
 * **保留 Phase 1(危险 API 正则)/Phase 2(拼接绕过)全部防线**(与全豁免的 Trusted 区分)。
 * 语义:调用方(animation/signal/physics 等)的 code 是服务端固定模板 + 转义插值参数,
 * 模板自身的动态 load(主场景路径来自 ProjectSettings)是合法服务端行为;AI 若经插值
 * 逃逸注入任意代码,Phase 1/2 正则(OS.execute/ClassDB/网络类等)仍拦。opaque symbol
 * 防外部(AI 经 execute_gdscript 工具)伪造此标记。
 */
const _p3SkipSymbol = Symbol('p3-skip');
export function executeGdscriptRuntime(options: Omit<ExecuteGdscriptOptions, '_skipSandbox'>): Promise<ExecuteGdscriptResult> {
  (options as unknown as Record<symbol, boolean>)[_p3SkipSymbol] = true;
  return executeGdscript(options as ExecuteGdscriptOptions);
}
/** Re-export markers from shared.ts for consumers that import from this module */
export { MARKER_RESULT_SHARED as MARKER_RESULT, MARKER_ERROR_SHARED as MARKER_ERROR };

/** Generate a random per-execution marker prefix to prevent output forgery.
 *
 *  SECURITY CONTRACT (I-05): This function MUST use a cryptographically secure random source.
 *  The current implementation uses Node.js `randomUUID()` (backed by crypto.randomUUID),
 *  and takes the full 32-hex de-hyphenated UUID — the v4 version/variant bits are fixed,
 *  so the effective entropy is 122 bits, sufficient to prevent marker prediction.
 *  (2026-09-19 批1修正: 此前 substring(0,16) 实际只有 64 bit,与旧注释"122 bits"不符;
 *   parseMcpMarkers 前缀匹配长度无关,加长无兼容影响。)
 *
 *  DO NOT replace with Math.random(), timestamp-based, or any deterministic generator,
 *  and DO NOT truncate below 32 hex chars without re-evaluating the entropy budget.
 *  If this contract is violated, GDScript code could forge MCP output markers and
 *  inject false results into tool responses. */
function generateMarker(): string {
  return `__MCP_${randomUUID().replace(/-/g, '').substring(0, 32)}__`;
}

// ─── Temp file helpers ──────────────────────────────────────────────────────

const BASE_TMP_DIR = join(tmpdir(), 'godot-mcp-exec');
let baseDirPromise: Promise<void> | null = null;

async function ensureBaseDir(): Promise<void> {
  baseDirPromise ??= mkdir(BASE_TMP_DIR, { recursive: true, mode: 0o700 })
    .then(() => {})
    .catch((err) => {
      baseDirPromise = null;  // C-01: clear cache on failure so next call retries
      throw err;
    });
  return baseDirPromise;
}

/** Create an isolated session directory for one execution */
async function createSessionDir(): Promise<string> {
  await ensureBaseDir();
  // A-02: 嵌入时间戳到目录名，cleanupOldSessions 解析文件名判断过期（不依赖 mtime）
  return mkdtemp(join(BASE_TMP_DIR, `${TMP_PREFIX}${Date.now()}-`));
}

/** Background cleanup: remove session dirs and staging dirs older than 1 hour */
async function cleanupOldSessions(): Promise<void> {
  if (!baseDirPromise) return;
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  // IMPORTANT-11 (review): try 移入循环内,retryRm 失败不再中断整个循环(原中断致每次只清
  // 第一个失败目录,残留累积)。EPERM/EBUSY 失败收集后聚合 1 条(降噪:原每目录 1 条)。
  let entries: string[];
  try {
    entries = await readdir(BASE_TMP_DIR);
  } catch (err) {
    getLogger().debug('gdscript', `cleanup stale dirs: readdir failed: ${err}`);
    return;
  }
  const lockFailures: string[] = [];
  // IMPORTANT-11: 单次清理上限防卡——累积多时每目录 retryRm 退避(最坏 1.2s)拖慢 gdscript 执行。
  // 超出目录下次 cleanup 兜底(1h TTL,不丢)。
  const MAX_CLEANUP_PER_RUN = 10;
  // IMPORTANT-12 (38s flaky 根治): 单次 cleanup 总耗时上限。staging 累积时 retryRm 每目录最坏
  // 1.2s 退避,仅 MAX_CLEANUP_PER_RUN=10 仍可阻塞 ~12s;累积更多(实测 31 个)叠加每次
  // executeGdscript 触发的 cleanup 致 P3 偶发 38s。加 2s 预算,超时停止本次,残留下次兜底(1h TTL)。
  const CLEANUP_BUDGET_MS = 2000;
  let attempts = 0; // 计尝试(含 EPERM 失败),防 staging 全 EPERM 时 for 全遍历阻塞主路径
  for (const entry of entries) {
    if (attempts >= MAX_CLEANUP_PER_RUN) break;
    if (Date.now() - now > CLEANUP_BUDGET_MS) break;
    // I-02: Also clean up staging dirs (renamed by retryRm on Windows)
    if (!entry.startsWith(TMP_PREFIX) && !entry.startsWith('_staging_')) continue;
    try {
      const dirPath = join(BASE_TMP_DIR, entry);
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink()) continue;
      // A-02: 优先解析文件名中的时间戳；回退到 mtime（兼容旧格式目录）
      let dirAge: number;
      // 全仓审查 M-1 (2026-09-12): mkdtemp 在前缀后追加 6 随机字符,目录名以随机后缀收尾,
      // 原 /-(\d+)-$/ 要求"数字段+-"收尾永不匹配(A-02 文件名解析从未生效,恒走 mtime 兜底)。
      // 改为前缀锚定提取时间戳段(引用 TMP_PREFIX 防常量漂移)。
      const tsMatch = entry.match(new RegExp(`^${TMP_PREFIX}(\\d+)-`));
      if (tsMatch) {
        dirAge = now - parseInt(tsMatch[1]!);
      } else {
        dirAge = now - stat.mtimeMs;
      }
      if (stat.isDirectory() && dirAge > maxAge) {
        // A-07: Retry rm on EPERM/EBUSY (Windows file locking) with backoff
        attempts++;
        await retryRm(dirPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EPERM') || msg.includes('EBUSY')) {
        lockFailures.push(entry); // 聚合,不逐条打
      } else {
        getLogger().debug('gdscript', `cleanup stale dirs: ${msg}`);
      }
    }
  }
  if (lockFailures.length > 0) {
    getLogger().debug('gdscript', `cleanup stale dirs: ${lockFailures.length} 个 staging 目录清理失败(EPERM/EBUSY,Windows 句柄占用),待下次 cleanup 兜底`);
  }
}

/** A-07: Retry rm with backoff for EPERM/EBUSY errors on Windows.
 *  P-1: On Windows, first attempt rename to a staging dir, then delete from there.
 *  This avoids EPERM from Godot still holding file handles on the original path. */
async function retryRm(dirPath: string, maxRetries = 3): Promise<void> {
  // P-1: Windows rename-to-staging strategy
  if (process.platform === 'win32') {
    try {
      const stagingName = join(BASE_TMP_DIR, `_staging_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const { rename: renameAsync } = await import('fs/promises');
      await renameAsync(dirPath, stagingName);
      // Renamed successfully — now delete from staging (less likely to hit EPERM)
      dirPath = stagingName;
    } catch {
      // Rename failed — fall through to normal retry logic on original path
    }
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      if (attempt > 0) getLogger().debug('gdscript', `retryRm succeeded on attempt ${attempt + 1}: ${dirPath}`);
      return;
    } catch (err: unknown) {
      const isRetryable = err instanceof Error && 'code' in err &&
        ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY');
      if (!isRetryable || attempt === maxRetries) throw err;
      // I-LOG: 静默重试 EPERM/EBUSY（Windows 上 Godot 进程退出后短暂持有 .gd 句柄，
      // 每次执行必现）。逐次 attempt 日志会淹没测试输出与覆盖率摘要（IMPORTANT-3）。
      // 最终失败由调用方 catch 聚合记录；staging 目录由 cleanupOldSessions 在下次
      // 执行时兜底清理（已有机制，1 小时 TTL）。
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

async function writeTempScript(code: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}.gd`);
  // I-24: POSIX — mode 0o600 restricts to owner read/write only
  await writeFile(filePath, code, { encoding: 'utf-8', mode: 0o600 });
  // I-S5: Restrict file permissions on Windows (icacls overrides POSIX mode)
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = await import('node:child_process');
        // C-ARC-01: Validate username strictly (no backslash injection), use :M not :F
        // (批 K 2026-08-16: 与 5968a03/editor-auth 同款 —— :R 只读残留会让后续重写/删除
        // 临时 .gd 失败,仅累积 tmpdir 垃圾;:M 允许写删但不给改 ACL 的完全控制)
        const winUser = userInfo().username;
        if (winUser && /^[A-Za-z0-9_-]+$/.test(winUser)) {
          execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${winUser}:M`], { windowsHide: true });
      }
    } catch { /* non-critical: best-effort permission restriction */ }
  }
  return filePath;
}

async function writeSessionFile(content: string, ext: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}${ext}`);
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

// ─── Code wrapping ──────────────────────────────────────────────────────────

/**
 * Detect if the code is a "full class" (contains `extends`)
 * or a "snippet" that needs auto-wrapping.
 */
export function isFullClass(code: string): boolean {
  // Match `extends` at the start of a line (ignoring whitespace and comments)
  return /^\s*extends\s+/m.test(code);
}

/**
 * Classify GDScript code lines into declarations (class-level) and statements.
 * Declarations include func, var, const, signal, enum, class_name, and annotations.
 * Statements go into _initialize() body.
 */
function classifyLines(code: string): { declarationLines: string[]; statementLines: string[] } {
  // Normalize CRLF → LF so \r doesn't leak into line content and break GDScript parsing
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const declarationLines: string[] = [];
  const statementLines: string[] = [];

  let inFuncBody = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines go to statement group
    if (trimmed === '') {
      if (inFuncBody) {
        declarationLines.push(line);
      }
      continue;
    }

    // Comment-only lines at top level go to declarations
    if (trimmed.startsWith('#') && !inFuncBody) {
      declarationLines.push(line);
      continue;
    }

    // Top-level declarations: func, var, const, signal, enum, class_name, annotations
    // Only classify as declaration if the line starts at column 0 (no indentation).
    // Indented var/const inside if/while/for blocks are local, not class-level.
    if (/^[^\t ]/.test(line) && /^(func |static func |var |const |signal |enum |class_name |@export|@onready|@icon|@warning)/.test(trimmed)) {
      declarationLines.push(line);
      if (/^(static )?func /.test(trimmed)) {
        inFuncBody = true;
      }
      // Multi-line lambda: var x = func(): / var x = func(args):
      // Body lines must stay with the declaration, not go to _initialize().
      if (/=\s*func\s*\(.*\)\s*:\s*$/.test(trimmed)) {
        inFuncBody = true;
      }
      continue;
    }

    // Lines indented under a func declaration are part of that func body.
    // A top-level (column-0) non-comment line ends the func body.
    // Comment lines at column 0 are intentionally allowed inside func bodies —
    // they don't constitute a new top-level construct.
    if (inFuncBody) {
      if (/^[^\t ]/.test(line) && !trimmed.startsWith('#')) {
        inFuncBody = false;
        // Fall through to statement classification below
      } else {
        declarationLines.push(line);
        continue;
      }
    }

    // Everything else is a statement
    statementLines.push(line);
  }

  // Normalize leading spaces → tabs so wrapper's \t prefix doesn't create mixed indentation
  _normalizeIndentToTabs(declarationLines);
  _normalizeIndentToTabs(statementLines);

  return { declarationLines, statementLines };
}

/** Normalize leading spaces to tabs in-place via the shared implementation. */
function _normalizeIndentToTabs(lines: string[]): void {
  const normalized = _sharedNormalizeIndent(lines.join('\n'));
  const result = normalized.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = result[i] ?? lines[i]!;
  }
}

/**
 * Wrap a snippet into a valid `extends SceneTree` script with helper functions.
 * Splits user code into declarations (class-level) and statements (inside _initialize).
 * This allows func/var/const definitions to work correctly at class scope.
 */
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // BUG-2 fix: SceneTree has a built-in `root` property (Window).
  // User `var root = ...` at class level collides with it.
  // Rename user's `var root` → `var _mcp_user_root` and update references.
  const ST_RESERVED = ['root'];
  for (const reserved of ST_RESERVED) {
    // Step 1: Rename declaration `var root =` → `var _mcp_user_root =`
    // Also covers `var root: Type = ...` and `var root` (no initializer)
    const declPattern = new RegExp(`^(var\\s+)${reserved}\\b`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(declPattern, `$1_mcp_user_${reserved}`);
    }
    // Step 2: Update references in both declarationLines and statementLines.
    // _mcp_user_root contains 'root' but is preceded by '_' so refPattern won't match it.
    const refPattern = new RegExp(`(?<![_.\\w])\\b${reserved}\\b(?!\\w)`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
    for (let i = 0; i < statementLines.length; i++) {
      statementLines[i] = statementLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
  }

  // Build via array join — prevents JS template interpolation of user code
  const scriptLines: string[] = [
    'extends SceneTree',
    '## MCP snippet mode — autoloads are NOT available unless load_autoloads=true',
    '## Use Variant type for variables to avoid "Cannot infer type" errors',
    '',
    'var _mcp_outputs: Array = []',
    '# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT,
    '',
    ...GD_MCP_GET_NODE,
    '',
    ...GD_MCP_LOAD_MAIN_SCENE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  ];
  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    scriptLines.push('');
    scriptLines.push(...declarationLines);
    scriptLines.push('');
  }

  scriptLines.push(
    'func _initialize():',
    '\t_mcp_load_main_scene()',
  );

  if (statementLines.length > 0) {
    for (const l of statementLines) {
      scriptLines.push('\t' + l);
    }
  }

  scriptLines.push(
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  );

  return scriptLines.join('\n') + '\n';
}

/**
 * Wrap a snippet as `extends Node` for autoload mode.
 * The loader scene instantiates this via .new(), so it must be a Node subclass.
 */
export function wrapSnippetAsNode(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // Rename user's _initialize to _mcp_user_init to avoid collision with our _initialize
  for (let i = 0; i < declarationLines.length; i++) {
    declarationLines[i] = declarationLines[i]!.replace(/func _initialize\(/g, "func _mcp_user_init(");
  }
  const hasUserInit = /func _mcp_user_init\(/.test(declarationLines.join('\n'));

  // Node context variant: uses get_tree().root instead of self.root
  const GD_MCP_GET_ROOT_AS_NODE: readonly string[] = [
    'func _mcp_get_root() -> Node:',
    '\tif _mcp_root != null:',
    '\t\treturn _mcp_root',
    '\tvar _tree = get_tree()',
    '\tif _tree != null and _tree.root != null:',
    '\t\t_mcp_root = _tree.root',
    '\t\treturn _mcp_root',
    '\treturn null',
  ];

  // Build via array join — prevents JS template interpolation of user code
  const nodeLines: string[] = [
    'extends Node',
    '## MCP autoload snippet mode — runs as Node child in loader scene',
    '',
    'var _mcp_outputs: Array = []',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT_AS_NODE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tvar _tree = get_tree()',
    '\tif _tree != null:',
    '\t\t_tree.quit(0)',
  ];

  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    nodeLines.push('');
    nodeLines.push(...declarationLines);
    nodeLines.push('');
  }

  nodeLines.push('func _initialize() -> void:');
  if (statementLines.length > 0) {
    for (const l of statementLines) {
      nodeLines.push('\t' + l);
    }
  }
  if (hasUserInit) {
    nodeLines.push('\t_mcp_user_init()');
  }
  nodeLines.push('\t_mcp_done()');

  return nodeLines.join('\n') + '\n';
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
export function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  // Skip injection if the code already declares these helpers (exclude comment lines)
  const hasOutputsVar = lines.some(l => /^\s*var\s+_mcp_outputs\s*:/.test(l) && !l.trim().startsWith('#'));
  const hasOutputFunc = lines.some(l => /^\s*func\s+_mcp_output\s*\(/.test(l) && !l.trim().startsWith('#'));
  const hasDoneFunc = lines.some(l => /^\s*func\s+_mcp_done\s*\(/.test(l) && !l.trim().startsWith('#'));

  const helperLines: string[] = [''];
  if (!hasOutputsVar) {
    helperLines.push('var _mcp_outputs: Array = []', '');
  }
  if (!hasOutputFunc) {
    helperLines.push('func _mcp_output(key: String, value: Variant) -> void:', '\t_mcp_outputs.append({"key": key, "value": str(value)})', '');
  }
  if (!hasDoneFunc) {
    helperLines.push(
      'func _mcp_done() -> void:',
      '\tprint("' + MARKER_RESULT_SHARED + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
      '\tif Engine.get_main_loop() == self:',
      '\t\tquit(0)',
      '',
    );
  }

  const result = [...lines.slice(0, extendsIdx + 1), ...helperLines, ...lines.slice(extendsIdx + 1)];
  return result.join('\n');
}

// ─── Output parsing ─────────────────────────────────────────────────────────

export function parseMcpMarkers(raw: string, resultMarker = MARKER_RESULT_SHARED, errorMarker = MARKER_ERROR_SHARED): {
  parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null;
  logLines: string[];
} {
  const lines = raw.split('\n');
  const logLines: string[] = [];
  let parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON: ' + trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON: ' + trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  return { parsed, logLines };
}

// ─── Main execution function ────────────────────────────────────────────────

export async function executeGdscript(
  options: ExecuteGdscriptOptions
): Promise<ExecuteGdscriptResult> {
  const { godotPath, projectPath, timeout = 30 } = options;
  let code = options.code;
  // 全仓审查 I-1 处置记录 (2026-09-12): 曾按审查建议 scrub 用户代码中的 marker 固定常量,
  // 实测撤销——固定常量 ___MCP_RESULT___/___MCP_ERROR___ 是 C-09 的**公开协议契约**(测试模板
  // /helper/生成器统一"写常量、server replaceAll 换随机 marker",ui-layout 等 full-class
  // 测试即依赖此机制),scrub 破坏契约致结构化输出解析全断。威胁模型重审:单脚本内的输出
  // 控制权本属脚本作者(marker 防的是跨执行/重放伪造,非当次);execute 通道输出的注入防御
  // 由 untrusted 信封(M-3)承担。审查发现降级为设计声明,不构成漏洞。
  let loadAutoloads = options.loadAutoloads ?? false;
  let autoloadDetected: string[] | undefined;

  // Autoload auto-detection: scan code for autoload references when not explicitly set
  if (options.loadAutoloads === undefined) {
    const autoloadNames = parseAutoloadNames(projectPath);
    const matched = detectAutoloadUsage(code, autoloadNames);
    if (matched.length > 0) {
      loadAutoloads = true;
      autoloadDetected = matched;
      getLogger().info('gdscript', `Auto-detected autoload usage: ${matched.join(', ')}. Enabled load_autoloads.`);
    }
  }
  const startTime = Date.now();

  // P2-4: orphan bridge autoload 前置自愈——残留条目+脚本已删会让每次 headless 操作崩
  if (repairOrphanedBridgeAutoload(projectPath)) {
    getLogger().warn('gdscript', `Repaired orphaned McpBridge autoload entry in ${projectPath} (script missing) — removed the dangling entry.`);
  }

  // Warn if same project is being used by a running game process
  // 设计 §4.5 I-3:按目标桶判定(getRunSessionProc 内部归一化 key)——原活跃桶判定
  // (getProjectDir()+getRunningProcess())在活跃=B 时对运行中的 A 漏报 .godot/ 缓存冲突风险。
  if (getRunSessionProc(projectPath)) {
    getLogger().warn('gdscript', `Warning: project ${projectPath} is also being used by a running game process. Headless execution should be safe but watch for .godot/ cache conflicts.`);
  }

  // Hard kill switch: set ALLOW_EXECUTE_GDSCRIPT=false to disable GDScript execution
  if (process.env.ALLOW_EXECUTE_GDSCRIPT === 'false') {
    return { success: false, compile_success: false, compile_error: 'GDScript execution is disabled (ALLOW_EXECUTE_GDSCRIPT=false)', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // CMP-11 (2026-08-08): opt-in 审计日志——执行前把完整代码写到独立文件供事后追溯。
  // env GODOT_MCP_AUDIT_CODE=true 开启。字符串字面量脱敏(防 secret 泄露到审计日志)。
  if (process.env.GODOT_MCP_AUDIT_CODE === 'true') {
    try {
      const { appendFileSync } = await import('fs');
      const auditPath = join(resolveLogDir(), 'audit-code.log');
      const sanitized = code.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '"***"'); // 字符串字面量脱敏
      const ts = new Date().toISOString();
      appendFileSync(auditPath, `[${ts}] project=${projectPath} autoloads=${autoloadDetected?.join(',') ?? 'none'}\n${sanitized}\n---\n`);
    } catch { /* best-effort:审计失败不阻断执行 */ }
  }

  // C-SEC-02: Sandbox scan — BLOCKS execution on dangerous patterns by default
  const skipSandbox = (options as unknown as Record<symbol, boolean>)[_trustedSymbol] === true;
  const p3Skip = (options as unknown as Record<symbol, boolean>)[_p3SkipSymbol] === true;
  const sandboxWarnings = skipSandbox ? [] : scanGdscriptSandbox(code, { skipPhase3: p3Skip });
  // C-02: Support both new GODOT_MCP_DISABLE_SAFETY and legacy GODOT_MCP_ALLOW_UNSAFE
  // P0-1 (2026-07-06 RCE 审查): 双开关 — 上述 flag 需同时设 GODOT_MCP_UNRESTRICTED=true 才生效,
  // 防误设单 env 绕过沙箱报警。kill switch (ALLOW_EXECUTE_GDSCRIPT=false, 上方) 优先于此。
  const safetyDisabled = process.env.GODOT_MCP_UNRESTRICTED === 'true'
    && (process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true');
  if (sandboxWarnings.length > 0 && !safetyDisabled) {
    return {
      success: false, compile_success: false,
      compile_error: `Sandbox violation: code contains dangerous patterns. Set GODOT_MCP_DISABLE_SAFETY=true + GODOT_MCP_UNRESTRICTED=true to override (P0-1 double-opt-in).\n${sandboxWarnings.join('\n')}`,
      errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected,
    };
  }
  if (sandboxWarnings.length > 0 && safetyDisabled) {
    // I-04: 结构化审计事件 — 记录安全绕过的完整上下文（代码摘要、时间戳、触发模式）
    // I-10: Sanitize string literals in code summary to prevent credential leakage
    const rawSummary = code.slice(0, 120).replace(/\n/g, '\\n');
    const codeSummary = rawSummary.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, '"***"');
    getLogger().warn('security', JSON.stringify({
      audit: 'SANDBOX_BYPASS',
      warnings: sandboxWarnings,
      codePreview: codeSummary,
      flag: process.env.GODOT_MCP_DISABLE_SAFETY === 'true' ? 'GODOT_MCP_DISABLE_SAFETY' : 'GODOT_MCP_ALLOW_UNSAFE',
    }));
    getLogger().warn('security', `Safety bypass active — executing despite sandbox warnings: ${sandboxWarnings}`);
    // I-18: Mark execution output so downstream consumers know sandbox was bypassed
    code = '# [UNSANDBOXED] Executing with safety bypass\n' + code;
  }

  // Validate godotPath exists and looks like a Godot binary
  if (!existsSync(godotPath)) {
    return { success: false, compile_success: false, compile_error: `Godot binary not found: ${godotPath}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }
  const binName = basename(godotPath).toLowerCase();
  if (!binName.includes('godot')) {
    return { success: false, compile_success: false, compile_error: `Binary does not appear to be Godot: ${basename(godotPath)}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // P3: Auto-import warmup — ensures .godot/imported/ is fresh before headless execution
  if (needsImport(projectPath)) {
    try {
      getLogger().info('executor', `Running import warmup for ${projectPath}`);
      await runImport(projectPath, godotPath);
    } catch (importErr) {
      getLogger().warn('executor', `Import warmup failed: ${importErr instanceof Error ? importErr.message : importErr}`);
      // Non-fatal — continue execution
    }
  }

  // Acquire short-running slot AFTER all validation — ensures no early-return leaks the slot
  if (!acquireShortRunningSlot()) {
    return { success: false, compile_success: false, compile_error: 'Too many concurrent headless operations (max 3). Please wait and retry.', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // C-01: Generate random per-execution markers to prevent user code forgery
  const rndResult = generateMarker();
  const rndError = generateMarker();

  // Prepare script content
  // Routing logic:
  // --script mode requires extends SceneTree/MainLoop
  // --scene (autoload) mode uses loader that calls .new(), requires extends Node
  // SceneTree-based scripts (using root/quit/get_node override) CANNOT run as Node,
  // so autoload mode is downgraded to --script for them.
  let scriptContent: string;
  if (isFullClass(code)) {
    const extendsSceneTree = /^\s*extends\s+(SceneTree|MainLoop)/m.test(code);
    if (extendsSceneTree) {
      // SceneTree scripts always use --script mode (root/quit API incompatible with Node)
      loadAutoloads = false;
      scriptContent = injectHelpers(code);
    } else if (loadAutoloads) {
      // Full class extending Node etc. with autoloads → inject helpers, loader calls .new()
      scriptContent = injectHelpers(code);
    } else {
      // Full class extending Node/etc. without autoloads → strip extends, wrap as SceneTree
      const strippedCode = code.replace(/^\s*extends\s+\S+.*\n?/m, '');
      scriptContent = wrapSnippet(strippedCode, rndResult);
    }
  } else if (loadAutoloads) {
    scriptContent = wrapSnippetAsNode(code, rndResult);
  } else {
    scriptContent = wrapSnippet(code, rndResult);
  }

  // C-09: For injectHelpers path, replace fixed markers with random ones
  // (wrapSnippet paths already use random markers via template parameter)
  scriptContent = scriptContent.replaceAll(MARKER_RESULT_SHARED, rndResult);
  scriptContent = scriptContent.replaceAll(MARKER_ERROR_SHARED, rndError);

  // Create isolated session directory
  await cleanupOldSessions();
  const sessionDir = await createSessionDir();

  // Write temp file
  const tempFiles: string[] = [];
  let tempFile: string;
  try {
    tempFile = await writeTempScript(scriptContent, sessionDir);
    tempFiles.push(tempFile);
  } catch (err) {
    releaseShortRunningSlot();
    return {
      success: false,
      compile_success: false,
      compile_error: `Failed to write temp script: ${err}`,
      errors: [],
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: Date.now() - startTime,
      autoload_detected: autoloadDetected,
    };
  }

  // Build Godot arguments
  const godotArgs: string[] = ['--headless', '--path', projectPath];
  if (loadAutoloads) {
    // Autoload mode: create a loader scene that initializes all autoloads first
    try {
      // Write loader script first to get its absolute path
      const loaderScriptPath = await writeSessionFile(createAutoloadLoaderScript(tempFile, rndError), '.gd', sessionDir);
      tempFiles.push(loaderScriptPath);
      // Create scene referencing loader script by absolute path (not res://)
      const loaderScene = createAutoloadLoaderScene(loaderScriptPath);
      const loaderScenePath = await writeSessionFile(loaderScene, '.tscn', sessionDir);
      tempFiles.push(loaderScenePath);
      godotArgs.push('--scene', loaderScenePath);
    } catch (err) {
      // C8: retryRm 对齐 timer(:1255)/close(:1269) 分支(Windows EPERM 容错)。spec C8 :1344 同 bug 一并修。
      retryRm(sessionDir).catch(() => {});
      releaseShortRunningSlot();
      return {
        success: false,
        compile_success: false,
        compile_error: `Failed to create autoload loader files: ${err}`,
        errors: [],
        run_success: false,
        run_error: '',
        outputs: [],
        raw_output: '',
        duration_ms: Date.now() - startTime,
        autoload_detected: autoloadDetected,
      };
    }
  } else {
    godotArgs.push('--script', tempFile);
  }

  // C-AUDIT (对照 UE 9b128514): spawn 前留痕——原始 code 的字节级 SHA-256 + executionId，
  // 记 EXECUTE_BEGIN 审计（不含原始 code，对齐 I-10）。崩溃/超时后凭日志反查；executionId/
  // scriptSha256 同时回填到结果（见下方 resolve），便于调用方与日志双向定位。
  const execMode = isFullClass(code)
    ? (loadAutoloads ? 'full_class_autoload' : 'full_class')
    : (loadAutoloads ? 'snippet_autoload' : 'snippet');
  const auditEvent = buildExecAuditEvent({
    code,
    scriptPath: tempFile,
    mode: execMode,
    autoload: loadAutoloads,
  });
  getLogger().info('security', JSON.stringify(auditEvent));
  const { executionId, scriptSha256 } = auditEvent;

  // Spawn Godot process
  return new Promise<ExecuteGdscriptResult>((resolve, reject) => {
    // C-PERF-01: Use Buffer[] to avoid O(n²) string concatenation.
    // Each += on a string copies the entire contents; with 10MB of output
    // this becomes catastrophically slow. Buffers collect chunks and
    // are joined once at close time.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB output limit
    let outputExceeded = false;

    const proc = spawn(godotPath, godotArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });
    // B-T4: 注册到 _spawnedGodotPids, close/崩溃可清理 in-flight short-running spawn。
    // 原 only-run_project 注册致挂起脚本 + close → 孤儿无兜底; 三路径 forceKillTree 后也需 unregister。
    if (proc.pid) registerSpawnedGodotPid(proc.pid);
    const unregisterSpawn = () => { if (proc.pid) unregisterSpawnedGodotPid(proc.pid); };
    proc.on('exit', unregisterSpawn);   // 正常 exit
    proc.on('error', unregisterSpawn);  // spawn 错误（ENOENT 等）

    proc.stdout?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stdoutChunks.push(d);
      stdoutBytes += d.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        // P-2: 截断已有 buffer 到限制内，释放超限内存
        let kept = 0;
        const trimmed: Buffer[] = [];
        for (const chunk of stdoutChunks) {
          if (kept + chunk.byteLength <= MAX_OUTPUT_BYTES) {
            trimmed.push(chunk);
            kept += chunk.byteLength;
          } else {
            const remainder = MAX_OUTPUT_BYTES - kept;
            if (remainder > 0) trimmed.push(chunk.subarray(0, remainder));
            break;
          }
        }
        stdoutChunks.length = 0;
        stdoutChunks.push(...trimmed, Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: pipe 溢出强杀后注销（exit 事件可能不触发）
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stderrChunks.push(d);
      stderrBytes += d.byteLength;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        // P-2: 截断已有 buffer 到限制内
        let kept = 0;
        const trimmed: Buffer[] = [];
        for (const chunk of stderrChunks) {
          if (kept + chunk.byteLength <= MAX_OUTPUT_BYTES) {
            trimmed.push(chunk);
            kept += chunk.byteLength;
          } else {
            const remainder = MAX_OUTPUT_BYTES - kept;
            if (remainder > 0) trimmed.push(chunk.subarray(0, remainder));
            break;
          }
        }
        stderrChunks.length = 0;
        stderrChunks.push(...trimmed, Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: pipe 溢出强杀后注销（exit 事件可能不触发）
      }
    });

    // ipc P1-7 fix: settled 防close/error/timer 重复触发; timer 兜底释放 slot + reject
    // 防 forceKillTree 后进程不 emit close(Windows taskkill 失败/driver bug) 致 slot 永占 + pending 永悬
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (!proc.killed) {
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: timeout 强杀后注销（exit 事件可能不触发）
      }
      settled = true;
      releaseShortRunningSlot();
      retryRm(sessionDir).catch(() => {});
      reject(new Error(`Godot process timed out after ${timeout}s`));
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      if (settled) return;  // ipc P1-7: timer 已 reject(timeout)
      settled = true;
      clearTimeout(timer);
      unregisterSpawn();  // B-T4 对称补全：exit/error/timeout/pipe 均已调，close 也补（Set 幂等，防 close 先于 exit 的 driver 边界）
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      releaseShortRunningSlot();
      // Cleanup session directory (fire-and-forget async)
      // A-07: retryRm 处理 Windows EPERM(Godot 退出瞬间短暂持有 .gd 句柄)。原裸 rm 静默吞错致
      // sessionDir 残留累积,实测触发 cleanupOldSessions 的 retryRm 退避阻塞主路径 38s flaky。
      retryRm(sessionDir).catch(() => {});

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput, rndResult, rndError);
      const analysis = analyzeOutput(logLines, projectPath ? { projectPath } : undefined);

      if (parsed) {
        const isSuccess = parsed.success === true;
        // Detect compile errors from Godot output
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;

        resolve({
          success: isSuccess && !hasCompileError,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: isSuccess,
          run_error: parsed.error || '',
          outputs: (parsed.outputs || []) as OutputEntry[],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
          autoload_detected: autoloadDetected,
          executionId,
          scriptSha256,
        });
      } else {
        // No marker found — likely a compile error or crash
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;
        // Safety net: if no real errors (only RID leak cleanup warnings),
        // the script likely ran but cleanup crashed before marker print
        if (!hasCompileError && exitCode !== 0) {
          const hasRealError = /\b(Parse Error|Script Error|SCRIPT ERROR)\b/.test(rawOutput);
          if (!hasRealError) {
            resolve({
              success: false,
              compile_success: true,
              compile_error: '',
              errors: analysis.errors,
              run_success: false,
              run_error: `Process exited with code ${exitCode} (likely RID leak during cleanup, no script error found)`,
              outputs: [],
              raw_output: logLines.join('\n'),
              duration_ms: duration,
              autoload_detected: autoloadDetected,
              executionId,
              scriptSha256,
            });
            return;
          }
        }
        resolve({
          success: false,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: false,
          run_error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
          outputs: [],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
          autoload_detected: autoloadDetected,
          executionId,
          scriptSha256,
        });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;  // ipc P1-7: timer 已 reject
      settled = true;
      clearTimeout(timer);
      releaseShortRunningSlot();
      // C8: retryRm 对齐 timer(:1255)/close(:1269) 分支(Windows EPERM 容错,原裸 rm 静默吞错致残留)。
      retryRm(sessionDir).catch(() => {});

      // Spawn failure is fatal — reject so callers can catch and report
      reject(new Error(`Failed to spawn Godot process: ${err.message}`));
    });
  });
}

/**
 * Extract compile error from Godot output.
 * Godot prints errors like: "scripts/gdscript/gdscript.cpp:123 - Parse Error: ..."
 */
function extractCompileError(raw: string): string {
  const lines = raw.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // C2 根治(final review 揭示 \b 非根治): Godot 编译错误格式 ":line - Parse Error:"(见 :1356 注释)。
    // 原 \b 在词首仍匹配——print("Parse Error: debug") 的 "Parse Error:" 在字符串开始,\b 匹配词首边界
    // 仍误判;dash 前缀要求 Godot 格式 ":<num> - Parse Error:",用户 print 无此格式不匹配。
    if (/:[0-9]+ - (Parse Error|Script Error):/.test(trimmed)) {
      errors.push(trimmed);
    }
  }
  return errors.join('\n');
}

// ─── Autoload loader helpers ──────────────────────────────────────────────────

/**
 * Create a minimal .tscn scene that loads with autoload context.
 * The scene runs the user's script from _ready().
 */
export function createAutoloadLoaderScene(loaderScriptPath: string): string {
  const loaderPathRes = loaderScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="' + loaderPathRes + '" id="1"]',
    '',
    '[node name="MCPLoader" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n');
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
export function createAutoloadLoaderScript(userScriptPath: string, errorMarker: string): string {
  const pathRes = userScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tvar user_script: GDScript = load("' + pathRes + '") as GDScript',
    '\tif user_script == null:',
    '\t\tprint("' + errorMarker + '" + JSON.stringify({"success": false, "error": "Failed to load user script"}))',
    '\t\tget_tree().quit(0)',
    '\t\treturn',
    '\tvar instance: Variant = user_script.new()',
    '\tif instance.has_method("_initialize"):',
    '\t\tinstance._initialize()',
    '\tget_tree().quit(0)',
  ].join('\n') + '\n';
}
