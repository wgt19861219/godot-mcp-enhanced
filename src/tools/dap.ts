import type { Tool } from "@modelcontextprotocol/server";
import net from 'node:net';
import { resolve as resolvePath } from 'node:path';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── dap 组 — DAP 断点调试(TS 直连 editor 自带 DAP server,P9) ────────────────
//
// 移植自 LuoxuanLove-godot-dotnet-mcp addons/.../tools/dap/executor.gd (791 行,P2)。 [上游 license:MIT,2026-10-01 GitHub API 核实,见 THIRD_PARTY_NOTICES.md]
// 机制:作为 **DAP client** TCP 连 Godot editor 自带 DAP server(默认 127.0.0.1:6006)
// ——不是自己实现 DAP server,是驱动 editor 已有的调试端点(引擎官方协议,比对标
// 竞品的"按图标找调试器按钮"面板 hack 稳)。
//
// 架构决策(设计偏离声明):原实现跑在 GD editor 插件内(StreamPeerTCP + await
// process_frame);enhanced 改为 **TS 侧 node:net 直连**——①无 GD 改动(不增加
// editor 插件分发/版本兼容负担);②DAP 场景本就要求 editor 运行中且调试服务器开启,
// 前置一致;③Node 的 TCP/async/帧解码是标准操作,frame 编解码从 GD 的最重部分(791
// 行里大半)缩到 ~40 行。与既有 debug 工具(editor 层 EditorDebuggerPlugin,面板
// hook)并存互补:debug 走 editor WebSocket 插件,dap 走官方协议直连。
//
// 保留(LuoxuanLove 同款):18 action 面/三段会话状态机(initialized→launched→
// configured)/断点簿记自存+全量重发(DAP 全量语义,上限 512 sources × 256 lines)/
// SENSITIVE_KEYS 把 authorization/token/password 从 DAP 响应洗掉(调试输出防 secret
// 泄漏)/loopback 强制(allow_remote_hosts 显式开)/超时 30s cap/会话 8/消息 200/
// buffer+frame 1MB 上限。
//
// 前置(要文档化):editor 需开启调试服务器——Editor Settings → Network → Debug
// Adapter(端口 6006);launch 调试还需 Debug 菜单"Deploy with Remote Debug"。
// 限制:C# 断点需 .NET debugger,本工具只覆盖 GDScript(引擎 DAP scope)。

const TOOL_NAMES = ['dap'] as const;
export { TOOL_NAMES };

const ACTIONS = [
  'status',              // 会话/设置/断点计数总览(同步,无需 DAP 连接)
  'get_settings',        // 读运行时 DAP 设置
  'set_settings',        // 改运行时 DAP 设置(host/port/timeout/默认会话/allow_remote_hosts)
  'initialize',          // DAP initialize(建 TCP + 握手,状态机第一段)
  'launch',              // DAP launch(让 editor 启动调试会话)
  'attach',              // DAP attach(Godot DAP 对 attach 支持有限,协议层透传)
  'configuration_done',  // DAP configurationDone(配置完成,断点已下发后调用)
  'disconnect',          // DAP disconnect(可选 terminateDebuggee)
  'terminate',           // DAP terminate
  'threads',             // 线程列表
  'set_breakpoint',      // 加断点(簿记+全量重发)
  'remove_breakpoint',   // 删断点(簿记+全量重发)
  'list_breakpoints',    // 列本会话断点(同步,本地簿记)
  'pause',               // 请求中断
  'continue',            // 继续运行
  'step_over',           // 单步(跨过函数)
  'stack_trace',         // 读调用栈(需暂停在断点)
  'output',              // 收集 output 事件(游戏 stdout/调试输出)
] as const;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6006;
const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_SESSION_ID = 'default';
const MAX_SESSIONS = 8;
const MAX_MESSAGES_PER_SESSION = 200;
// 全仓审查 M6: buffer 上限须容纳 header(约 20-40B)+ body——原与 frame 同为 1MB,
// 恰好 1MB 的合法帧会先被 buffer 上限误杀(报错还误导成 buffer 问题)。+4KB header 余量。
const MAX_BUFFER_BYTES = 1048576 + 4096;
const MAX_FRAME_BYTES = 1048576;
const MAX_BREAKPOINT_SOURCES = 512;
const MAX_BREAKPOINTS_PER_SOURCE = 256;

const SENSITIVE_KEYS = ['authorization', 'password', 'secret', 'token', 'key', 'apikey', 'api_key', 'access_token', 'refresh_token'];
const SENSITIVE_VALUE_MARKERS = ['authorization:', 'bearer ', 'password=', 'password:', 'secret=', 'secret:', 'token=', 'token:', 'api_key=', 'api_key:', 'apikey=', 'apikey:', 'access_token=', 'access_token:', 'refresh_token=', 'refresh_token:'];

// ─── 会话与设置(模块级;进程生命周期,同原实现内存语义) ────────────────────────

interface DapSession {
  id: string;
  socket: net.Socket;
  buffer: Buffer;
  messages: DapMessage[];
  /** 单调消息计数(push 时自增,附到消息 __mcpSeq)——trim 的 shift 不影响它,
   * _collectOutput 据此过滤窗口内新消息(全仓审查 I1:原 length 游标在 200 条稳态下
   * 与 slice 起点数学互斥,积压满后 output 恒空)。 */
  msgSeq: number;
  /** data pump 检出的致命错误(buffer/frame 超限)——事件路径无处返回,暂存后由 _readMessages 报出(审查 N-3 清偿)。 */
  pendingError: ToolResult | null;
  host: string;
  port: number;
  initialized: boolean;
  started: boolean;
  configured: boolean;
  launchMode: string;
  capabilities: Record<string, unknown>;
}

interface DapMessage {
  seq?: number;
  type: string;
  command?: string;
  request_seq?: number;
  success?: boolean;
  event?: string;
  body?: unknown;
  message?: string;
  [key: string]: unknown;
}

interface DapSettings {
  host: string;
  port: number;
  timeout_ms: number;
  default_session_id: string;
  default_launch_args: Record<string, unknown>;
  default_attach_args: Record<string, unknown>;
  allow_remote_hosts: boolean;
}

let _sequence = 1;
const _sessions = new Map<string, DapSession>();
const _breakpoints = new Map<string, Map<string, number[]>>();
let _settings: DapSettings = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  timeout_ms: DEFAULT_TIMEOUT_MS,
  default_session_id: DEFAULT_SESSION_ID,
  default_launch_args: {},
  default_attach_args: {},
  allow_remote_hosts: false,
};

/**
 * H-4(2026-09-17 审查):GodotServer.close() 清理钩子——销毁全部 DAP TCP socket
 * 并清 _sessions/_breakpoints 簿记。此前 dap socket 完全不在 close() 清理链,
 * close 后热重启/测试隔离会泄漏长寿命 TCP 连接(对端 editor DAP server 侧残留会话)。
 */
export function closeAllDapSessions(): void {
  for (const s of _sessions.values()) {
    try { s.socket.destroy(); } catch { /* best-effort */ }
  }
  _sessions.clear();
  _breakpoints.clear();
}

/** 测试钩子:重置模块级状态(单测隔离)。复用 closeAllDapSessions 的清理循环(同语义去重)。 */
export function _resetForTest(): void {
  closeAllDapSessions();
  _sequence = 1;
  _settings = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    default_session_id: DEFAULT_SESSION_ID,
    default_launch_args: {},
    default_attach_args: {},
    allow_remote_hosts: false,
  };
}

// ─── 结果构造(JSON 文本;成功/失败均带结构化字段) ─────────────────────────────

function dapOk(data: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

function dapErr(code: string, message: string, details: Record<string, unknown> = {}): ToolResult {
  return errorResult(JSON.stringify({ error: message, error_code: code, ...details }, null, 2));
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'dap',
      description: [
        'DAP 断点调试 — TS 直连 Godot editor 自带 DAP server(默认 127.0.0.1:6006,P9 移植)。',
        '会话流:initialize → launch(或 attach)→ set_breakpoint(s) → configuration_done → (断点命中后) stack_trace/step_over/continue。',
        '断点簿记本地自存 + setBreakpoints 全量重发(512 sources × 256 lines 上限);DAP 响应经 sensitive-key 清洗(防调试输出泄漏 secret)。',
        '前置:editor 开启调试服务器(Editor Settings → Network → Debug Adapter,端口 6006);launch 还需 Debug 菜单"Deploy with Remote Debug"。',
        '⚠️ 只覆盖 GDScript(C# 断点需 .NET debugger);与 debug 工具(editor 插件面板 hook)并存互补,稳定性优先用本工具。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Action type: status | get_settings | set_settings | initialize | launch | attach | configuration_done | disconnect | terminate | threads | set_breakpoint | remove_breakpoint | list_breakpoints | pause | continue | step_over | stack_trace | output',
          },
          session_id: {
            type: 'string',
            description: 'DAP 会话 id(默认 settings.default_session_id,初始 "default")',
          },
          host: {
            type: 'string',
            description: 'DAP host(默认 127.0.0.1;非 loopback 需 settings.allow_remote_hosts)',
          },
          port: {
            type: 'integer',
            description: 'DAP 端口(默认 6006)',
          },
          project_path: {
            type: 'string',
            description: '断点 source_path 用 res:// 相对路径时的项目根(转绝对路径给 DAP)',
          },
          timeout_ms: {
            type: 'integer',
            description: 'DAP 请求超时毫秒(默认 1000,上限 30000;launch 等慢操作建议传大)',
          },
          settings: {
            type: 'object',
            description: 'set_settings: 运行时 DAP 设置(host/port/timeout_ms/default_session_id/default_launch_args/default_attach_args/allow_remote_hosts)',
          },
          include_raw: {
            type: 'boolean',
            description: '响应附带清洗后的原始 DAP request/response/messages(调试协议层用)',
          },
          adapter_args: {
            type: 'object',
            description: 'launch/attach: 透传给 adapter 的参数字典(与默认合并,后者优先级高)',
          },
          program: {
            type: 'string',
            description: 'launch: 可选 program 参数',
          },
          cwd: {
            type: 'string',
            description: 'launch: 可选工作目录',
          },
          restart: {
            type: 'boolean',
            description: 'launch/attach/disconnect: DAP restart 标志',
          },
          terminate_debuggee: {
            type: 'boolean',
            description: 'disconnect: 是否同时终止被调试进程',
          },
          source_path: {
            type: 'string',
            description: 'set/remove_breakpoint: 脚本路径(res://... 或绝对路径;res:// 需配 project_path)',
          },
          line: {
            type: 'integer',
            description: 'set/remove_breakpoint: 1-based 行号',
          },
          thread_id: {
            type: 'integer',
            description: 'pause/continue/step_over/stack_trace: DAP thread id(默认 1)',
          },
          disconnect: {
            type: 'boolean',
            description: 'terminate: 成功后同时关闭本地 DAP 会话(清断点簿记)',
          },
          client_id: {
            type: 'string',
            description: 'initialize: DAP clientID 标识(默认 godot-mcp-enhanced)',
          },
          client_name: {
            type: 'string',
            description: 'initialize: DAP clientName 显示名(默认 godot-mcp-enhanced)',
          },
          adapter_id: {
            type: 'string',
            description: 'initialize: DAP adapterID(默认 godot)',
          },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'dap') return null;

  const action = args.action as string;
  if (!action) return dapErr('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return dapErr('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }
  const timeoutError = _timeoutLimitError(args);
  if (timeoutError) return timeoutError;

  switch (action) {
    case 'status':
      return dapOk(_statusData());
    case 'get_settings':
      return dapOk(_settingsData());
    case 'set_settings':
      return _setSettings(args);
    case 'list_breakpoints':
      return dapOk(_breakpointListData(_sessionId(args)));
  }

  try {
    switch (action) {
      case 'initialize':
        return await _initialize(args);
      case 'launch':
        return await _launchOrAttach('launch', args);
      case 'attach':
        return await _launchOrAttach('attach', args);
      case 'configuration_done':
        return await _configurationDone(args);
      case 'disconnect':
        return await _disconnect(args);
      case 'terminate':
        return await _terminate(args);
      case 'threads':
        return await _sessionRequest('threads', {}, args, { requireInitialized: true });
      case 'set_breakpoint':
        return await _setBreakpoint(args);
      case 'remove_breakpoint':
        return await _removeBreakpoint(args);
      case 'pause':
        return await _threadRequest('pause', args);
      case 'continue':
        return await _threadRequest('continue', args);
      case 'step_over':
        return await _threadRequest('next', args);
      case 'stack_trace':
        return await _threadRequest('stackTrace', args);
      case 'output':
        return await _collectOutput(args);
    }
  } catch (err) {
    return dapErr('DAP_ERROR', `DAP ${action} failed: ${String(err instanceof Error ? err.message : err)}`);
  }
  return dapErr('INVALID_ACTION', `Unhandled action: ${action}`);
}

// ─── 高层 action(状态机,对标原实现同名函数) ────────────────────────────────

async function _initialize(args: Record<string, unknown>): Promise<ToolResult> {
  const initializeArgs = {
    clientID: String(args.client_id ?? 'godot-mcp-enhanced'),
    clientName: String(args.client_name ?? 'godot-mcp-enhanced'),
    adapterID: String(args.adapter_id ?? 'godot'),
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: true,
    supportsRunInTerminalRequest: false,
  };
  const result = await _sessionRequest('initialize', initializeArgs, args, {});
  if (result.isError !== true) {
    const session = _sessions.get(_sessionId(args));
    if (session) {
      session.initialized = true;
      const data = JSON.parse(safeText(result)) as { response?: { body?: Record<string, unknown> } };
      if (data.response?.body) session.capabilities = { ...data.response.body };
    }
  }
  return result;
}

async function _launchOrAttach(command: 'launch' | 'attach', args: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = _sessionId(args);
  const session = _sessions.get(sessionId);
  if (!session || !session.initialized) {
    return _sessionStateError(sessionId, 'initialize', `${command} requires an initialized DAP session`);
  }
  const requestArgs = _adapterArgs(command, args);
  const result = await _sessionRequest(command, requestArgs, args, { requireInitialized: true });
  if (result.isError !== true) {
    const s = _sessions.get(sessionId);
    if (s) {
      s.started = true;
      s.launchMode = command;
    }
  }
  return result;
}

async function _configurationDone(args: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = _sessionId(args);
  const session = _sessions.get(sessionId);
  if (!session || !session.initialized) {
    return _sessionStateError(sessionId, 'initialize', 'configuration_done requires an initialized DAP session');
  }
  if (!session.started) {
    return _sessionStateError(sessionId, 'launch_or_attach', 'configuration_done requires launch or attach first');
  }
  const result = await _sessionRequest('configurationDone', {}, args, { requireInitialized: true });
  if (result.isError !== true) {
    const s = _sessions.get(sessionId);
    if (s) s.configured = true;
  }
  return result;
}

async function _disconnect(args: Record<string, unknown>): Promise<ToolResult> {
  const requestArgs = {
    restart: Boolean(args.restart),
    terminateDebuggee: Boolean(args.terminate_debuggee),
  };
  const result = await _sessionRequest('disconnect', requestArgs, args, { requireExisting: true });
  if (result.isError !== true) _closeSession(_sessionId(args));
  return result;
}

async function _terminate(args: Record<string, unknown>): Promise<ToolResult> {
  const result = await _sessionRequest('terminate', {}, args, { requireExisting: true });
  if (result.isError !== true && Boolean(args.disconnect)) _closeSession(_sessionId(args));
  return result;
}

async function _setBreakpoint(args: Record<string, unknown>): Promise<ToolResult> {
  const sourcePath = _normalizeSourceKey(_sourcePath(args));
  if (!sourcePath) return dapErr('INVALID_PARAMS', 'dap set_breakpoint requires source_path');
  const line = Number(args.line ?? 0);
  if (!(line > 0)) return dapErr('INVALID_PARAMS', 'dap set_breakpoint requires line');
  const sessionId = _sessionId(args);
  const store = _breakpointStore(sessionId);
  if (!store.has(sourcePath) && store.size >= MAX_BREAKPOINT_SOURCES) {
    return _limitError(`Too many dap breakpoint sources for session`, 'sources', store.size, MAX_BREAKPOINT_SOURCES);
  }
  const lines = [...(store.get(sourcePath) ?? [])];
  if (!lines.includes(line)) lines.push(line);
  lines.sort((a, b) => a - b);
  if (lines.length > MAX_BREAKPOINTS_PER_SOURCE) {
    return _limitError('Too many dap breakpoints for source', 'breakpoints', lines.length, MAX_BREAKPOINTS_PER_SOURCE);
  }
  const result = await _sendBreakpoints(sourcePath, lines, args);
  if (result.isError !== true) {
    _storeBreakpoints(sessionId, sourcePath, lines);
    return _withBreakpointList(result);
  }
  return result;
}

async function _removeBreakpoint(args: Record<string, unknown>): Promise<ToolResult> {
  const sourcePath = _normalizeSourceKey(_sourcePath(args));
  if (!sourcePath) return dapErr('INVALID_PARAMS', 'dap remove_breakpoint requires source_path');
  const sessionId = _sessionId(args);
  const store = _breakpointStore(sessionId);
  const lines = (store.get(sourcePath) ?? []).filter((l) => l !== Number(args.line ?? 0));
  const result = await _sendBreakpoints(sourcePath, lines, args);
  if (result.isError !== true) {
    _storeBreakpoints(sessionId, sourcePath, lines);
    return _withBreakpointList(result);
  }
  return result;
}

async function _sendBreakpoints(sourcePath: string, lines: number[], args: Record<string, unknown>): Promise<ToolResult> {
  const breakpoints = lines.map((line) => ({ line }));
  const dapArgs = { source: { path: _dapPath(sourcePath, args) }, breakpoints };
  return _sessionRequest('setBreakpoints', dapArgs, args, {});
}

async function _threadRequest(command: string, args: Record<string, unknown>): Promise<ToolResult> {
  return _sessionRequest(command, { threadId: Number(args.thread_id ?? 1) }, args, {});
}

async function _collectOutput(args: Record<string, unknown>): Promise<ToolResult> {
  const sessionResult = await _ensureSession(args);
  if (!sessionResult.ok) return sessionResult.error!;
  const session = sessionResult.session!;
  // 全仓审查 I1: 原用 messages.length 做游标,与 _trimMessages 的 200 上限数学互斥
  // (稳态下 push 即 shift,length 恒 ≤200,slice(200) 恒空)——改用单调 __mcpSeq 过滤。
  const lastSeq = session.msgSeq;
  const readError = await _readMessages(session, _timeoutMs(args), -1);
  if (readError) return readError;
  const newMessages = session.messages.filter(
    (m) => Number((m as Record<string, unknown>).__mcpSeq ?? 0) > lastSeq,
  );
  const outputs: unknown[] = [];
  for (const message of newMessages) {
    if (message.type === 'event' && message.event === 'output') {
      outputs.push(message.body);
    }
  }
  const data: Record<string, unknown> = { outputs: _sanitizeValue(outputs), session_id: session.id };
  if (args.include_raw) {
    // 剥离 __mcpSeq 内部字段,不污染原始消息输出(复用 _stripSeq helper)
    data.messages = _sanitizeValue(newMessages.map(_stripSeq));
  }
  return dapOk(data);
}

// ─── DAP 请求核心(连接/帧编解码/响应匹配) ────────────────────────────────────

interface SessionRequestOptions {
  requireExisting?: boolean;
  requireInitialized?: boolean;
}

async function _sessionRequest(
  command: string,
  arguments_: Record<string, unknown>,
  args: Record<string, unknown>,
  options: SessionRequestOptions,
): Promise<ToolResult> {
  const sessionId = _sessionId(args);
  const existing = _sessions.get(sessionId);
  if (options.requireExisting && !existing) {
    return _sessionStateError(sessionId, 'initialize', 'DAP session is not connected');
  }
  if (options.requireInitialized && (!existing || !existing.initialized)) {
    return _sessionStateError(sessionId, 'initialize', 'DAP session must be initialized first');
  }
  if (existing && (options.requireInitialized || options.requireExisting)
    && (existing.host !== _host(args) || existing.port !== _port(args))) {
    return _sessionStateError(sessionId, 'same_endpoint', 'DAP session endpoint changed; initialize a new session before this action');
  }
  const sessionResult = await _ensureSession(args);
  if (!sessionResult.ok) return sessionResult.error!;
  const session = sessionResult.session!;
  // 全仓审查 I2: 前置校验用的是断连前的旧 session(initialized=true),但 _ensureSession
  // 已重建未握手新连接——立即拒,提示重新 initialize(而非把请求发到新连接报假超时)。
  if (sessionResult.rebuilt && (options.requireInitialized || options.requireExisting)) {
    return _sessionStateError(sessionId, 'initialize', 'DAP connection was lost and reconnected; re-run initialize before this action');
  }

  const requestSeq = _sequence++;
  const request: DapMessage = { seq: requestSeq, type: 'request', command, arguments: arguments_ };
  try {
    _writeRequest(session, request);
  } catch (err) {
    _closeSession(sessionId);
    return dapErr('DAP_WRITE_FAILED', `Failed to write DAP request: ${String(err instanceof Error ? err.message : err)}`);
  }

  const readError = await _readMessages(session, _timeoutMs(args), requestSeq);
  if (readError) return readError;

  const response = _findResponse(session.messages, requestSeq);
  if (!response) {
    return _dapRequestError('DAP request timed out', 'dap_timeout', sessionId, command, args);
  }
  if (response.success !== true) {
    return _dapRequestError(`DAP request failed: ${String(response.message ?? command)}`, 'dap_response_failed', sessionId, command, args);
  }
  const data: Record<string, unknown> = { session_id: sessionId, response: _sanitizeValue(_stripSeq(response)) };
  if (args.include_raw) {
    data.request = _sanitizeValue(request);
    data.messages = _sanitizeValue(session.messages.map(_stripSeq));
  }
  return dapOk(data);
}

/** 全仓审查 I1 配套: 剥离附着的内部 __mcpSeq 字段——消息对象进任何输出
 * (response/messages/outputs)前统一过此函数,不污染对客户端暴露的 DAP 数据。 */
function _stripSeq(m: DapMessage): DapMessage {
  const { __mcpSeq, ...rest } = m as Record<string, unknown> & { __mcpSeq?: number };
  void __mcpSeq;
  return rest as DapMessage;
}

interface EnsureSessionResult {
  ok: boolean;
  session?: DapSession;
  error?: ToolResult;
  /** 全仓审查 I2: socket 断开后 _ensureSession 走 _closeSession 重建新连接(未握手)。
   * 标记重建,让带前置(requireInitialized/requireExisting)的调用方立即拒——否则请求
   * 会发到从未 initialize 的新连接(DAP 协议违规),报误导性 dap_timeout,且断点簿记
   * 已被 _closeSession 静默清空。 */
  rebuilt?: boolean;
}

async function _ensureSession(args: Record<string, unknown>): Promise<EnsureSessionResult> {
  const sessionId = _sessionId(args);
  const host = _host(args);
  const port = _port(args);
  const endpointError = _validateEndpoint(host, port);
  if (endpointError) return { ok: false, error: endpointError };
  const existing = _sessions.get(sessionId);
  // 全仓审查 I2: 断连残留 session(endpoint 未变但 socket 非 open)被 _closeSession
  // 重建——标记 rebuilt 让调用方的前置校验重新审视(新连接未 initialize)。
  let rebuilt = false;
  if (existing) {
    if (existing.host === host && existing.port === port && existing.socket.readyState === 'open') {
      return { ok: true, session: existing };
    }
    _closeSession(sessionId);
    rebuilt = true;
  }
  // 并发首连去重(审查 N-4 清偿,参照 bridge-client 串行化模式):同 session_id 的并发
  // 请求复用同一 in-flight Promise——防后完成者覆盖前者的 socket(泄漏到进程结束)。
  const inflightKey = `${sessionId}@${host}:${port}`;
  const inflight = _connectInflight.get(inflightKey);
  if (inflight) return inflight;
  const connectPromise = (async (): Promise<EnsureSessionResult> => {
    const socket = await _connect(host, port, _timeoutMs(args));
    const session: DapSession = {
      id: sessionId,
      socket,
      buffer: Buffer.alloc(0),
      messages: [],
      msgSeq: 0,
      pendingError: null,
      host,
      port,
      initialized: false,
      started: false,
      configured: false,
      launchMode: '',
      capabilities: {},
    };
    _rememberSession(sessionId, session);
    return { ok: true, session, rebuilt };
  })();
  _connectInflight.set(inflightKey, connectPromise);
  try {
    return await connectPromise;
  } finally {
    _connectInflight.delete(inflightKey);
  }
}

/** in-flight 连接去重表(键 `sessionId@host:port`)——并发首连复用,防 socket 覆盖泄漏。 */
const _connectInflight = new Map<string, Promise<EnsureSessionResult>>();

function _connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect({ host, port });
    const onError = (err: Error) => {
      socket.destroy();
      rejectPromise(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolvePromise(socket);
    });
    setTimeout(() => {
      if (socket.readyState === 'open') return;
      socket.destroy();
      rejectPromise(new Error(`connect timeout after ${timeoutMs}ms`));
    }, Math.max(timeoutMs, 200)).unref?.();
  });
}

function _writeRequest(session: DapSession, request: DapMessage): void {
  const body = Buffer.from(JSON.stringify(request), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  session.socket.write(Buffer.concat([header, body]));
}

/** 读消息直到等到 request_seq 的 response 或超时。返回错误 ToolResult 或 null(成功)。 */
async function _readMessages(session: DapSession, timeoutMs: number, requestSeq: number): Promise<ToolResult | null> {
  const deadline = Date.now() + Math.max(timeoutMs, 1);
   
  while (true) {
    if (session.pendingError) {
      const err = session.pendingError;
      session.pendingError = null;
      return err;  // pump 检出的致命错误优先于超时报告(防真因被超时掩盖,审查 N-3 清偿)
    }
    _drainFrames(session);
    if (session.buffer.length > MAX_BUFFER_BYTES) {
      _closeSession(session.id);
      return _limitError('DAP buffer exceeded maximum size', 'buffer_bytes', session.buffer.length, MAX_BUFFER_BYTES);
    }
    if (requestSeq >= 0 && _findResponse(session.messages, requestSeq)) return null;
    if (requestSeq < 0 && Date.now() >= deadline) return null;  // output 模式:读满超时窗即回
    if (Date.now() >= deadline) {
      return null;  // 让上层报 dap_timeout(带 request 上下文)
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 给 socket 挂 data pump(连接建立后立即调用一次,幂等)。 */
function _attachSocketDataPump(session: DapSession): void {
  if ((session.socket as unknown as { __mcpDapPump?: boolean }).__mcpDapPump) return;
  (session.socket as unknown as { __mcpDapPump?: boolean }).__mcpDapPump = true;
  session.socket.on('data', (chunk: Buffer) => {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    if (session.buffer.length > MAX_BUFFER_BYTES) {
      session.pendingError = _limitError('DAP buffer exceeded maximum size', 'buffer_bytes', session.buffer.length, MAX_BUFFER_BYTES);
      _closeSession(session.id);
      return;
    }
    _drainFrames(session);
  });
  session.socket.on('error', () => _closeSession(session.id));
  // 连接断开:不主动删会话记录——下次 _ensureSession 因 readyState!=open 重建
}

/** 从 buffer 解析完整帧(Content-Length header + JSON body),解析出的消息进 session.messages。 */
function _drainFrames(session: DapSession): void {
   
  while (true) {
    const headerEnd = session.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = session.buffer.subarray(0, headerEnd).toString('utf8');
    const contentLength = _contentLength(header);
    if (contentLength < 0) {
      session.buffer = Buffer.alloc(0);  // 协议错:丢弃 buffer 重新同步(原实现同款)
      return;
    }
    if (contentLength > MAX_FRAME_BYTES) {
      session.pendingError = _limitError('DAP frame exceeded maximum size', 'frame_bytes', contentLength, MAX_FRAME_BYTES);
      _closeSession(session.id);
      return;
    }
    const bodyStart = headerEnd + 4;
    if (session.buffer.length < bodyStart + contentLength) return;
    const bodyText = session.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
    session.buffer = session.buffer.subarray(bodyStart + contentLength);
    try {
      const parsed = JSON.parse(bodyText) as DapMessage;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        // 全仓审查 I1: 附单调 __mcpSeq(trim 的 shift 不影响),collectOutput 据此过滤
        session.msgSeq += 1;
        (parsed as Record<string, unknown>).__mcpSeq = session.msgSeq;
        session.messages.push(parsed);
        _trimMessages(session.messages);
      }
    } catch {
      // 单帧 JSON 坏:跳过继续(不杀会话)
    }
  }
}

function _contentLength(header: string): number {
  for (const line of header.split('\r\n')) {
    if (line.toLowerCase().startsWith('content-length:')) {
      const value = Number.parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
      return Number.isFinite(value) ? value : -1;
    }
  }
  return -1;
}

function _findResponse(messages: DapMessage[], requestSeq: number): DapMessage | undefined {
  return messages.find(
    (m) => m.type === 'response' && m.request_seq === requestSeq,
  );
}

// ─── 设置(对标原实现 _set_settings 白名单校验) ───────────────────────────────

function _setSettings(args: Record<string, unknown>): ToolResult {
  const incoming = args.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return dapErr('INVALID_PARAMS', 'DAP settings must be a dictionary');
  }
  const next: DapSettings = { ..._settings, default_launch_args: { ..._settings.default_launch_args }, default_attach_args: { ..._settings.default_attach_args } };
  // allow_remote_hosts 先于循环应用(还原原实现 gd:555 预处理顺序,审查 N-2 清偿)——
  // 支持同批次 {host: 远程, allow_remote_hosts: true}(TS 逐键循环会因旧值 false 先拒 host)。
  const incomingSettings = incoming as Record<string, unknown>;
  if (incomingSettings.allow_remote_hosts !== undefined) {
    next.allow_remote_hosts = Boolean(incomingSettings.allow_remote_hosts);
  }
  for (const [key, rawValue] of Object.entries(incomingSettings)) {
    switch (key) {
      case 'host': {
        const host = String(rawValue).trim();
        if (!host) return dapErr('INVALID_PARAMS', 'DAP host setting cannot be empty');
        if (!isLoopbackHost(host) && !next.allow_remote_hosts) {
          return dapErr('INVALID_PARAMS', 'DAP host must be loopback unless allow_remote_hosts is enabled');
        }
        next.host = host;
        break;
      }
      case 'port': {
        const port = Number(rawValue);
        if (!(port > 0 && port <= 65535)) return dapErr('INVALID_PARAMS', 'DAP port setting is invalid');
        next.port = port;
        break;
      }
      case 'timeout_ms': {
        const timeoutMs = Number(rawValue);
        if (!(timeoutMs > 0)) return dapErr('INVALID_PARAMS', 'DAP timeout_ms setting is invalid');
        if (timeoutMs > MAX_TIMEOUT_MS) {
          return _limitError('DAP timeout_ms setting exceeds the maximum', 'timeout_ms', timeoutMs, MAX_TIMEOUT_MS);
        }
        next.timeout_ms = timeoutMs;
        break;
      }
      case 'default_session_id': {
        const sessionId = String(rawValue).trim();
        if (!sessionId) return dapErr('INVALID_PARAMS', 'DAP default_session_id setting cannot be empty');
        next.default_session_id = sessionId;
        break;
      }
      case 'default_launch_args':
      case 'default_attach_args': {
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
          return dapErr('INVALID_PARAMS', `DAP ${key} setting must be a dictionary`);
        }
        next[key] = { ...(rawValue as Record<string, unknown>) };
        break;
      }
      case 'allow_remote_hosts':
        next.allow_remote_hosts = Boolean(rawValue);
        break;
      default:
        return dapErr('INVALID_PARAMS', `Unknown DAP setting: ${key}`);
    }
  }
  if (!next.allow_remote_hosts && !isLoopbackHost(next.host)) {
    return dapErr('INVALID_PARAMS', 'DAP host must be loopback unless allow_remote_hosts is enabled');
  }
  _settings = next;
  return dapOk(_settingsData());
}

// ─── 断点簿记 ────────────────────────────────────────────────────────────────

function _breakpointStore(sessionId: string): Map<string, number[]> {
  return _breakpoints.get(sessionId) ?? new Map<string, number[]>();
}

function _storeBreakpoints(sessionId: string, sourcePath: string, lines: number[]): void {
  const store = _breakpointStore(sessionId);
  if (lines.length === 0) store.delete(sourcePath);
  else store.set(sourcePath, [...lines]);
  if (store.size === 0) _breakpoints.delete(sessionId);
  else _breakpoints.set(sessionId, store);
}

function _breakpointListData(sessionId: string): Record<string, unknown> {
  const store = _breakpointStore(sessionId);
  const items: Array<Record<string, unknown>> = [];
  for (const [sourcePath, lines] of store) {
    for (const line of lines) {
      items.push({ session_id: sessionId, source_path: sourcePath, line });
    }
  }
  return { session_id: sessionId, count: items.length, breakpoints: items };
}

function _withBreakpointList(result: ToolResult): ToolResult {
  // opsOkResult 的 content[0].text 是 JSON 字符串;把 breakpoints 追加进去
  try {
    const data = JSON.parse(safeText(result)) as Record<string, unknown>;
    data.breakpoints = _breakpointListData(String(data.session_id ?? DEFAULT_SESSION_ID)).breakpoints;
    return dapOk(data);
  } catch {
    return result;
  }
}

// ─── status/序列化 ──────────────────────────────────────────────────────────

function _statusData(): Record<string, unknown> {
  const sessions = [..._sessions.values()].map((s) => ({
    session_id: s.id,
    endpoint: `${s.host}:${s.port}`,
    initialized: s.initialized,
    started: s.started,
    configured: s.configured,
    launch_mode: s.launchMode,
    message_count: s.messages.length,
    // 全仓审查 M5: capabilities 是全文件唯一未过清洗的 DAP 数据出口——远程/恶意 server
    // 的 capabilities 内嵌 token/authorization 字段会裸吐,统一过 _sanitizeValue。
    capabilities: _sanitizeValue(s.capabilities),
  }));
  let breakpointCount = 0;
  for (const store of _breakpoints.values()) {
    for (const lines of store.values()) breakpointCount += lines.length;
  }
  return {
    protocol: 'Debug Adapter Protocol',
    godot_builtin_dap_scope: 'GDScript',
    csharp_debugger_note: 'C# breakpoints require a .NET debugger such as coreclr.',
    sequence: _sequence,
    default_host: _settings.host,
    default_port: _settings.port,
    default_session_id: _settings.default_session_id,
    breakpoint_count: breakpointCount,
    session_count: sessions.length,
    sessions,
    settings: _settingsData(),
  };
}

function _settingsData(): Record<string, unknown> {
  // 不回 launch/attach 默认参数(可能含敏感配置;原实现 include_adapter_args=false 同款)
  return {
    host: _settings.host,
    port: _settings.port,
    timeout_ms: _settings.timeout_ms,
    default_session_id: _settings.default_session_id,
    allow_remote_hosts: _settings.allow_remote_hosts,
  };
}

// ─── 参数/校验 helpers ──────────────────────────────────────────────────────

function _sessionId(args: Record<string, unknown>): string {
  const value = String(args.session_id ?? _settings.default_session_id).trim();
  return value || DEFAULT_SESSION_ID;
}

function _host(args: Record<string, unknown>): string {
  return String(args.host ?? _settings.host).trim();
}

function _port(args: Record<string, unknown>): number {
  return Number(args.port ?? _settings.port);
}

function _timeoutMs(args: Record<string, unknown>): number {
  const value = Number(args.timeout_ms ?? _settings.timeout_ms);
  if (!(value > 0)) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function _sourcePath(args: Record<string, unknown>): string {
  return String(args.source_path ?? '').trim();
}

/** 全仓审查 I3 (2026-09-12): 断点簿记 key 规范化——绝对路径 resolve + Windows 小写 +
 * 正斜杠统一。防 D:/a.gd 与 D:\a.gd(或大小写/./.. 变体)生成多份独立簿记:setBreakpoints
 * 全量语义下仅最后写入生效而 list 显示全部(虚高),remove 匹配写法残留幽灵断点,
 * 上限 256/512 被同文件多写法绕过。res:// 保持原样归一类。 */
function _normalizeSourceKey(p: string): string {
  if (p.startsWith('res://')) return p;
  try {
    const resolved = resolvePath(p);
    return process.platform === 'win32' ? resolved.replaceAll('\\', '/').toLowerCase() : resolved;
  } catch {
    return p.replaceAll('\\', '/');
  }
}

/** res:// 路径转绝对路径给 DAP(需 project_path 推导;绝对路径原样)。 */
function _dapPath(path: string, args: Record<string, unknown>): string {
  if (path.startsWith('res://')) {
    const projectRoot = String(args.project_path ?? '');
    if (projectRoot) {
      return resolvePath(projectRoot, path.slice('res://'.length));
    }
    return path;  // 无 project_path 时透传 res://(Godot DAP 部分版本也接受;失败由 server 报)
  }
  return path;
}

function _adapterArgs(command: 'launch' | 'attach', args: Record<string, unknown>): Record<string, unknown> {
  const defaultsKey = command === 'launch' ? 'default_launch_args' : 'default_attach_args';
  const out: Record<string, unknown> = { ..._settings[defaultsKey] };
  const raw = args.adapter_args;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(out, raw as Record<string, unknown>);
  }
  if (args.program !== undefined) out.program = String(args.program);
  if (args.cwd !== undefined) out.cwd = String(args.cwd);
  if (args.restart !== undefined) out.restart = Boolean(args.restart);
  return out;
}

function _validateEndpoint(host: string, port: number): ToolResult | null {
  if (!host || !(port > 0 && port <= 65535)) {
    return _unavailableError({ host, port }, 'invalid_endpoint');
  }
  if (!isLoopbackHost(host) && !_settings.allow_remote_hosts) {
    return _unavailableError({ host, port }, 'remote_endpoint_disabled');
  }
  return null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function _sessionStateError(sessionId: string, expected: string, message: string): ToolResult {
  return dapErr('DAP_INVALID_SESSION_STATE', message, { session_id: sessionId, expected });
}

function _dapRequestError(message: string, errorType: string, sessionId: string, command: string, args: Record<string, unknown>): ToolResult {
  const details: Record<string, unknown> = { error_type: errorType, session_id: sessionId, command };
  if (args.include_raw) {
    const session = _sessions.get(sessionId);
    if (session) details.messages = _sanitizeValue(session.messages.map(_stripSeq));
  }
  return dapErr('DAP_REQUEST_FAILED', message, details);
}

function _limitError(message: string, sizeKey: string, sizeValue: number, limit: number): ToolResult {
  return dapErr('DAP_LIMIT_EXCEEDED', message, { error_type: 'dap_limit_exceeded', [sizeKey]: sizeValue, limit });
}

function _unavailableError(endpoint: { host: string; port: number }, transportStatus: string): ToolResult {
  return dapErr('DAP_UNAVAILABLE', 'DAP endpoint unavailable', {
    error_type: 'dap_unavailable',
    endpoint: `${endpoint.host}:${endpoint.port}`,
    host: endpoint.host,
    port: endpoint.port,
    transport_status: transportStatus,
    protocol: 'Debug Adapter Protocol',
    hint: 'Enable the DAP server in the Godot editor: Editor Settings → Network → Debug Adapter (port 6006), then retry with dap initialize.',
  });
}

function _timeoutLimitError(args: Record<string, unknown>): ToolResult | null {
  if (args.timeout_ms === undefined) return null;
  const timeoutMs = Number(args.timeout_ms);
  if (!(timeoutMs > 0)) return null;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return _limitError('DAP timeout_ms exceeds the maximum', 'timeout_ms', timeoutMs, MAX_TIMEOUT_MS);
  }
  return null;
}

function _closeSession(sessionId: string): void {
  const session = _sessions.get(sessionId);
  if (!session) return;
  try { session.socket.destroy(); } catch { /* best-effort */ }
  _sessions.delete(sessionId);
  _breakpoints.delete(sessionId);
}

function _rememberSession(sessionId: string, session: DapSession): void {
  if (!_sessions.has(sessionId) && _sessions.size >= MAX_SESSIONS) {
    const oldest = _sessions.keys().next().value;
    if (oldest !== undefined) _closeSession(oldest);
  }
  _sessions.set(sessionId, session);
  _attachSocketDataPump(session);
}

function _trimMessages(messages: DapMessage[]): void {
  while (messages.length > MAX_MESSAGES_PER_SESSION) {
    messages.shift();
  }
}

// ─── secret 清洗(对标原实现 SENSITIVE_KEYS/MARKERS) ─────────────────────────

function _sanitizeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = _isSensitiveKey(key) ? '[redacted]' : _sanitizeValue(v);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(_sanitizeValue);
  if (typeof value === 'string') return _sanitizeString(value);
  return value;
}

function _sanitizeString(value: string): string {
  const normalized = value.trim().toLowerCase();
  for (const marker of SENSITIVE_VALUE_MARKERS) {
    if (normalized.includes(marker)) return '[redacted]';
  }
  return value;
}

function _isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function safeText(result: ToolResult): string {
  return result.content?.map((c) => ('text' in c ? String(c.text) : '')).join('') ?? '';
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  dap: {
    // 组级:launch/terminate 改编辑器调试会话,非纯只读
    readonly: false,
    long_running: true,
    actionRisks: {
      status: 'read',
      get_settings: 'read',
      set_settings: 'write',
      initialize: 'write',        // 建 TCP 会话(外部连接)
      launch: 'write',            // 让 editor 启动调试会话(可能起游戏进程)
      attach: 'write',
      configuration_done: 'write',
      disconnect: 'write',
      terminate: 'write',         // 终止调试会话/被调试进程
      threads: 'read',
      set_breakpoint: 'write',    // 改 editor 断点状态
      remove_breakpoint: 'write',
      list_breakpoints: 'read',
      pause: 'write',             // 执行控制
      continue: 'write',
      step_over: 'write',
      stack_trace: 'read',
      output: 'read',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
