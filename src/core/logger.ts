/**
 * Logger — MCP Dashboard 的日志基础层
 *
 * 双写 JSONL 文件 + stderr，缓冲批量刷盘，tool 配对追踪，
 * 敏感数据清洗，按日切割 + 保留天数清理。
 */

import { writeSync, closeSync, openSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from "@modelcontextprotocol/server";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  v: 1;
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  tool?: string;
  duration_ms?: number;
  error?: string;
  type?: 'tool_start' | 'tool_end' | 'rotation';
  call_id?: string;
  /** §4.6(设计):工具调用归属项目路径——子项目 2 Web GUI 的数据基础。
   *  可选字段:调用方未提供时不写(向后兼容,dashboard 聚合器不破)。 */
  project?: string;
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  logDir?: string;
  bufferMs?: number;
  bufferMax?: number;
  maxRetentionDays?: number;
}

export interface Logger {
  debug(module: string, msg: string, meta?: Record<string, unknown>): void;
  info(module: string, msg: string, meta?: Record<string, unknown>): void;
  warn(module: string, msg: string, meta?: Record<string, unknown>): void;
  error(module: string, msg: string, meta?: Record<string, unknown>): void;
  toolStart(tool: string, args?: Record<string, unknown>, project?: string): string;
  toolEnd(callId: string, tool: string, durationMs: number, error?: string): void;
  flush(): void;
  pendingCount(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_MS = 100;
const DEFAULT_BUFFER_MAX = 50;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_STRING_LEN = 200;
const TOOL_TIMEOUT_MS = 60_000;
const SENSITIVE_RE = /password|secret|token|key|auth/i;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/** 8 字符 ID — crypto 随机源，与项目安全惯例一致 */
function nanoid8(): string {
  return randomUUID().replace(/-/g, '').substring(0, 8);
}

/** 确定日志目录 — XDG 标准路径 */
export function resolveLogDir(override?: string): string {
  if (override) return override;
  const platform = process.platform;
  if (platform === 'win32') {
    const base = process.env.APPDATA ?? join(process.env.USERPROFILE ?? tmpdir(), 'AppData', 'Roaming');
    return join(base, 'godot-mcp', 'logs');
  }
  if (platform === 'darwin') {
    const home = process.env.HOME ?? tmpdir();
    return join(home, 'Library', 'Application Support', 'godot-mcp', 'logs');
  }
  // Linux / other
  const xdg = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? tmpdir(), '.local', 'share');
  return join(xdg, 'godot-mcp', 'logs');
}

/** 当天日期字符串 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 截断长字符串 */
function truncate(s: string): string {
  if (s.length <= MAX_STRING_LEN) return s;
  return s.slice(0, MAX_STRING_LEN - 3) + '...';
}

/** Sanitize meta 对象：截断 + 敏感 key 替换 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_RE.test(k)) {
      result[k] = '***';
      continue;
    }
    if (typeof v === 'string') {
      result[k] = truncate(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// P2-10: msg 中的敏感 key=value 值脱敏 — sanitizeMsg 此前仅 truncate，是脆弱设计
// （未来新增调用方若把 secret 拼进 msg 字符串而非放进 meta 敏感 key 即泄露）。复用
// SENSITIVE_RE 词表做 KV 模式匹配，值（含引号/无引号）替换为 ***，保留 key 与分隔符。
// 注：子串匹配（如 "monkey" 含 "key"）会偶发误报，与 sanitizeMeta 行为一致，安全侧宁过脱敏。
const SENSITIVE_KV_RE = /(\b\w*(?:password|secret|token|key|auth)\w*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi;

/** Sanitize msg — 截断 + 敏感 key=value 值脱敏（P2-10） */
export function sanitizeMsg(msg: string): string {
  const redacted = msg.replace(SENSITIVE_KV_RE, '$1$2***');
  return truncate(redacted);
}

/** MCP LoggingLevel 子集映射：本项目 4 级 → MCP 8 级。debug/info 返 null（不发 client，连接级默认）。 */
function toMcpLevel(level: LogLevel): 'warning' | 'error' | null {
  if (level === 'warn') return 'warning';
  if (level === 'error') return 'error';
  return null;
}

/** P1-7: syslog 级别排名(debug<info<warn<error),用于 per-request logLevel 过滤。 */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * P1-7 (SEP-2577): 判断 entry 是否应发往 client,考虑 per-request logLevel。
 *
 * - _currentRequestLogLevel === null(非工具调用上下文):保持旧行为(仅 warn/error 发)。
 *   覆盖连接级通知(GodotServer.ts 项目上下文)和启动期日志。
 * - _currentRequestLogLevel === 'off':完全不发(客户端显式关闭)。
 * - _currentRequestLogLevel 是具体级别:entry.level >= requested 才发(含 debug/info,
 *   即客户端请求 debug 级别时,所有 >= debug 的日志都发)。
 */
function shouldEmitToClient(entry: LogEntry): boolean {
  if (_currentRequestLogLevel === 'off') return false;
  if (_currentRequestLogLevel === null) {
    // 旧行为:仅 warn/error
    return toMcpLevel(entry.level) !== null;
  }
  // per-request 模式:按排名过滤
  return LEVEL_RANK[entry.level] >= LEVEL_RANK[_currentRequestLogLevel];
}

/**
 * 增量第三写：按条件向 MCP client 推送日志。
 *
 * P1-3 完整推进:优先用 _requestLogFn(SDK 官方 ctx.mcpReq.log,自动 era + severity 过滤)。
 * 无 _requestLogFn 时(连接级/启动期/legacy)降级到 server 级 sendLoggingMessage + P1-7 自管过滤。
 *
 * guard: _mcpServer 注入 + _clientReady + shouldEmitToClient(P1-7 per-request 过滤,仅降级路径用)。
 * 失败静默（try/catch 同步 throw + .catch async reject）——日志是观测层，绝不影响主流程。
 * 安全：entry 经 log() 的 sanitizeMsg/sanitizeMeta 脱敏后才进 writeEntry，data 已脱敏。
 */
function emitToClient(entry: LogEntry): void {
  const data: Record<string, unknown> = { msg: entry.msg, module: entry.module };
  if (entry.tool) data.tool = entry.tool;
  if (entry.meta) data.meta = entry.meta;

  // P1-3: 优先用 SDK 官方 per-request log 函数(自动过滤 modern envelope + legacy setLevel + severity)
  if (_requestLogFn) {
    const mcpLevel = entry.level === 'warn' ? 'warning' : entry.level;
    try {
      const p = _requestLogFn(mcpLevel, data, entry.module);
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 同步 throw 静默
    }
    return;
  }

  // 降级路径:无 per-request logFn,用 server 级 sendLoggingMessage + P1-7 自管过滤
  if (!_mcpServer || !_clientReady) return;
  if (!shouldEmitToClient(entry)) return;
  const mcpLevel = _currentRequestLogLevel === null
    ? toMcpLevel(entry.level)  // 旧行为:仅 warning/error
    : (entry.level === 'warn' ? 'warning' : entry.level);  // per-request:发原始级别
  if (!mcpLevel) return;
  try {
    const p = _mcpServer.sendLoggingMessage({ level: mcpLevel, logger: entry.module, data });
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {
    // 同步 throw 静默
  }
}

/** stderr 格式化：[module] LEVEL msg — LEVEL 仅 warn/error 显示 */
function formatStderr(entry: LogEntry): string {
  const levelTag = (entry.level === 'warn' || entry.level === 'error')
    ? ` ${entry.level.toUpperCase()}`
    : '';
  return `[${entry.module}]${levelTag} ${entry.msg}\n`;
}

// ---------------------------------------------------------------------------
// Logger 实现
// ---------------------------------------------------------------------------

interface PendingTool {
  tool: string;
  startTime: number;
  /** §4.6:toolStart 时记录的项目归属,toolEnd/超时配对携带(调用方不重传)。 */
  project?: string;
}

interface LoggerImpl extends Logger {
  _bufferMs: number;
  _bufferMax: number;
  _maxRetentionDays: number;
}

function createLogger(opts: LoggerOptions = {}): Logger {
  const logDir = resolveLogDir(opts.logDir);
  const bufferMs = opts.bufferMs ?? DEFAULT_BUFFER_MS;
  const bufferMax = opts.bufferMax ?? DEFAULT_BUFFER_MAX;
  const maxRetentionDays = opts.maxRetentionDays ?? DEFAULT_RETENTION_DAYS;

  let buffer: LogEntry[] = [];
  let fd: number | null = null;
  let currentDate = todayStr();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let _lastCleanupDate = ''; // I-PERF-01: only run cleanup once per day
  const pendingTools = new Map<string, PendingTool>();

  // ---- 文件管理 ----

  function ensureDir(): void {
    mkdirSync(logDir, { recursive: true });
  }

  function currentFilePath(): string {
    return join(logDir, `${currentDate}.jsonl`);
  }

  function openFd(): void {
    ensureDir();
    if (fd !== null) {
      // 已有 fd，检查是否需要轮转（日期变更）
      const today = todayStr();
      if (today !== currentDate) {
        // 写入轮转信号到旧文件
        const rotationEntry: LogEntry = {
          v: 1,
          ts: new Date().toISOString(),
          level: 'info',
          module: 'logger',
          msg: 'Rotating log file',
          type: 'rotation',
          meta: { new_file: `${today}.jsonl` },
        };
        const line = JSON.stringify(rotationEntry) + '\n';
        try { writeSync(fd, line); } catch { /* ignore */ }
        closeSync(fd);
        currentDate = today;
        // 打开新文件
        fd = openSync(currentFilePath(), 'a');
        return;
      }
      return; // 同一天，继续用
    }
    currentDate = todayStr();
    fd = openSync(currentFilePath(), 'a');
  }

  /** 清理过期日志文件 — 基于文件名中的日期判断 */
  function cleanupOldFiles(): void {
    try {
      ensureDir();
      const files = readdirSync(logDir);
      const now = new Date();
      const cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxRetentionDays);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        // 从文件名解析日期：YYYY-MM-DD.jsonl
        const dateStr = f.replace('.jsonl', '');
        const fileDate = new Date(dateStr + 'T00:00:00');
        if (isNaN(fileDate.getTime())) continue; // 文件名不是标准日期格式，跳过
        if (fileDate < cutoffDate) {
          try { unlinkSync(join(logDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ---- 核心写入 ----

  function writeEntry(entry: LogEntry): void {
    buffer.push(entry);
    // stderr 双写
    try {
      process.stderr.write(formatStderr(entry));
    } catch { /* ignore */ }
    // 缓冲满则刷盘
    if (buffer.length >= bufferMax) {
      doFlush();
    } else if (!flushTimer && !closed) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        doFlush();
      }, bufferMs);
      flushTimer.unref?.();
    }
    emitToClient(entry);
  }

  /** 内部刷盘：写文件 + 检查超时工具 */
  function doFlush(): void {
    if (buffer.length === 0 && pendingTools.size === 0) return;
    try { openFd(); } catch { /* ignore open errors */ }

    // 检查 tool 超时
    checkToolTimeouts();

    if (buffer.length > 0 && fd !== null) {
      const data = buffer.map(e => JSON.stringify(e) + '\n').join('');
      try {
        // I-02: writeSync is intentional — ensures log data is flushed before process exit.
        // The buffer mechanism (100ms / 50 entries) limits writeSync calls to ~10/sec,
        // and each write is typically <10KB, blocking the event loop for <1ms.
        // Switching to async writeFile risks data loss on crash/exit.
        writeSync(fd, data);
      } catch { /* ignore write errors */ }
      buffer = [];
    }

    // I-PERF-01: Only run cleanup once per day instead of every flush
    const today = todayStr();
    if (_lastCleanupDate !== today) {
      cleanupOldFiles();
      _lastCleanupDate = today;
    }
  }

  /** 检查超时未配对的 toolStart */
  function checkToolTimeouts(): void {
    const now = Date.now();
    const timedOut: string[] = [];
    for (const [callId, pending] of pendingTools) {
      if (now - pending.startTime >= TOOL_TIMEOUT_MS) {
        timedOut.push(callId);
      }
    }
    for (const callId of timedOut) {
      const pending = pendingTools.get(callId);
      if (!pending) continue;
      pendingTools.delete(callId);
      const entry: LogEntry = {
        v: 1,
        ts: new Date().toISOString(),
        level: 'warn',
        module: 'logger',
        msg: `Tool call timed out: ${pending.tool}`,
        tool: pending.tool,
        type: 'tool_end',
        call_id: callId,
        duration_ms: now - pending.startTime,
        error: 'timeout',
      };
      if (pending.project) entry.project = pending.project;
      buffer.push(entry);
    }
  }

  // ---- 日志级别方法 ----

  function log(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
    if (closed) return;
    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level,
      module,
      msg: sanitizeMsg(msg),
    };
    if (meta && Object.keys(meta).length > 0) {
      entry.meta = sanitizeMeta(meta);
    }
    writeEntry(entry);
  }

  function debug(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('debug', module, msg, meta);
  }
  function info(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('info', module, msg, meta);
  }
  function warn(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('warn', module, msg, meta);
  }
  function error(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('error', module, msg, meta);
  }

  // ---- tool 配对 ----

  function toolStart(tool: string, args?: Record<string, unknown>, project?: string): string {
    const id = nanoid8();
    const callId = `${tool}:${id}`;
    pendingTools.set(callId, { tool, startTime: Date.now(), project });

    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level: 'info',
      module: 'dispatcher',
      msg: `Tool call started: ${tool}`,
      tool,
      type: 'tool_start',
      call_id: callId,
    };
    if (project) entry.project = project;
    if (args && Object.keys(args).length > 0) {
      entry.meta = { arg_keys: Object.keys(args) };
    }
    writeEntry(entry);
    return callId;
  }

  function toolEnd(callId: string, tool: string, durationMs: number, err?: string): void {
    const pending = pendingTools.get(callId);
    if (!pending) {
      // 未知 callId → warn
      warn('logger', `Unknown call_id in toolEnd: ${callId}`, { tool });
      return;
    }
    pendingTools.delete(callId);

    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level: err ? 'error' : 'info',
      module: 'dispatcher',
      msg: `Tool call completed: ${tool}`,
      tool,
      type: 'tool_end',
      call_id: callId,
      duration_ms: durationMs,
    };
    if (pending.project) entry.project = pending.project;
    if (err) entry.error = sanitizeMsg(err);
    writeEntry(entry);
  }

  // ---- 公共方法 ----

  function flush(): void {
    doFlush();
  }

  function pendingCount(): number {
    return buffer.length;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // 刷超时工具
    checkToolTimeouts();
    // 刷缓冲
    if (buffer.length > 0 || fd !== null) {
      try { openFd(); } catch { /* ignore */ }
      if (buffer.length > 0 && fd !== null) {
        const data = buffer.map(e => JSON.stringify(e) + '\n').join('');
        try { writeSync(fd, data); } catch { /* ignore */ }
        buffer = [];
      }
    }
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  }

  // 首次刷盘时延迟清理（构造时不执行 I/O）
  return { debug, info, warn, error, toolStart, toolEnd, flush, pendingCount, close } as LoggerImpl;
}

// ---------------------------------------------------------------------------
// 单例管理
// ---------------------------------------------------------------------------

// MCP Logging 注入：Server 实例 + client 就绪 flag。null/false 时不发，零开销退化。
let _mcpServer: Server | null = null;
let _clientReady = false;

// P1-7 (SEP-2577): per-request logLevel 过滤。
// stdio 单请求并发场景下用 module 级变量安全(同一时刻只有一个请求在处理);
// HTTP 多请求场景(P3-3)需升级为 AsyncLocalStorage,留 TODO。
// null = 非工具调用上下文(连接级通知/启动期),保持旧行为(发 warn/error)。
// 'off' = 客户端显式关闭日志。具体级别 = 按 syslog 排名过滤。
//
// @deprecated P1-3 完整推进:优先用 _requestLogFn(SDK 官方 ctx.mcpReq.log),
// 它自动处理 modern envelope logLevel + legacy setLevel + severity 过滤。
// _currentRequestLogLevel 保留作 fallback(测试 + 无 srvCtx 的 legacy 场景)。
let _currentRequestLogLevel: LogLevel | 'off' | null = null;

// P1-3 完整推进:per-request log 函数(SDK 官方 ctx.mcpReq.log)。
// ToolDispatcher.handleCall 注入 srvCtx.mcpReq.log,emitToClient 优先用它。
// null = 非工具调用上下文(连接级通知/启动期),降级到 server 级 sendLoggingMessage。
// SDK 的 ctx.mcpReq.log 自动:modern era 读 envelope logLevel / legacy era 读 _loggingLevels /
// 自动 severity 过滤。优于 P1-7 自管过滤(消除 envelope lift 陷阱)。
type RequestLogFn = (level: string, data: unknown, logger?: string) => Promise<void>;
let _requestLogFn: RequestLogFn | null = null;

/**
 * P1-7: 包裹器,在工具调用期间设置 per-request logLevel,执行完(含抛错)复位。
 * ToolDispatcher.handleCall 提取 _meta['io.modelcontextprotocol/logLevel'] 后用此包裹工具执行。
 * emitToClient 读 _currentRequestLogLevel 决定是否过滤。
 *
 * 同步版:用于同步代码块。工具调用是 async,用 withRequestLogLevelAsync。
 */
export function withRequestLogLevel<T>(level: LogLevel | 'off' | null, fn: () => T): T {
  const prev = _currentRequestLogLevel;
  _currentRequestLogLevel = level;
  try {
    return fn();
  } finally {
    _currentRequestLogLevel = prev;
  }
}

/**
 * P1-7: async 版包裹器,await 完成后才复位(同步版会在 Promise resolve 前就复位)。
 * ToolDispatcher.executeToolCall 用此包裹 targetMod.handleTool(await)。
 */
export async function withRequestLogLevelAsync<T>(level: LogLevel | 'off' | null, fn: () => Promise<T>): Promise<T> {
  const prev = _currentRequestLogLevel;
  _currentRequestLogLevel = level;
  try {
    return await fn();
  } finally {
    _currentRequestLogLevel = prev;
  }
}

/** 读当前 per-request logLevel(测试用,工具一般不直接读)。 */
export function getCurrentRequestLogLevel(): LogLevel | 'off' | null {
  return _currentRequestLogLevel;
}

/**
 * P1-3 完整推进: async 包裹器, 在工具调用期间注入 SDK 官方 per-request log 函数。
 * ToolDispatcher.handleCall 从 srvCtx.mcpReq.log 提取后用此包裹工具执行链。
 * emitToClient 优先用 _requestLogFn(SDK 自动过滤), 无它时降级到自管 _currentRequestLogLevel。
 * finally 保证复位(含抛错)。
 */
export async function withRequestLogFn<T>(logFn: RequestLogFn | null, fn: () => Promise<T>): Promise<T> {
  const prev = _requestLogFn;
  _requestLogFn = logFn;
  try {
    return await fn();
  } finally {
    _requestLogFn = prev;
  }
}

/** 读当前 per-request log 函数(测试用)。 */
export function getCurrentRequestLogFn(): RequestLogFn | null {
  return _requestLogFn;
}

/** 注入 MCP Server 实例（GodotServer 构造时调）；null 清除（close/测试隔离） */
export function setLoggerServer(server: Server | null): void {
  _mcpServer = server;
}

/** 标记 client 是否已完成 initialize（oninitialized 时设 true）；未就绪不发，避免 SDK 报错 */
export function setLoggerClientReady(ready: boolean): void {
  _clientReady = ready;
}

let instance: Logger | null = null;

export function getLogger(opts?: LoggerOptions): Logger {
  if (!instance) {
    instance = createLogger(opts);
  } else if (opts && Object.keys(opts).length > 0) {
    // A-01: 仅在首次忽略时 warn，避免每次调用都输出重复日志
    if (!_singletonWarned) {
      instance.warn('logger', 'getLogger() called with options but singleton already exists — options ignored');
      _singletonWarned = true;
    }
  }
  return instance;
}
let _singletonWarned = false;

export function resetLogger(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
  _mcpServer = null;
  _clientReady = false;
  // P1-7 review N3: 防御性复位,避免测试在 async 包裹中途调 resetLogger 致状态泄漏
  _currentRequestLogLevel = null;
  // P1-3: 同理复位 per-request log 函数
  _requestLogFn = null;
}
