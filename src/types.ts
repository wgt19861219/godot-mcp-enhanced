import type { ChildProcess } from 'child_process';
import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";

// ─── Shared type definitions for tool handlers ─────────────────────────────

export type ToolResult = CallToolResult;

/** P0-2 MRTR: handleCall 返回类型含 InputRequiredResult（confirm_and_execute 双时代兼容） */
export type HandlerResult = CallToolResult | InputRequiredResult;

export interface ToolContext {
  opsScript: string;
  findGodot: (projectPath?: string) => Promise<string>;
  runningProcess: ChildProcess | null;
  setRunningProcess: (proc: ChildProcess | null, skipBusyCheck?: boolean) => void;
  outputBuffer: string[];
  setOutputBuffer: (buf: string[]) => void;
  processStartTime: number;
  setProcessStartTime: (t: number) => void;
  projectDir: string;
  setProjectDir: (d: string) => void;
  parseGodotConfig: (content: string) => Record<string, unknown>;
  /** P1-2 (2026-07-06 review): editor 文本资源写守卫 — script/scene 写脚本前调,
   *  editorExecutor 可用时由 dispatcher 注入(经 WS 调 guard_text_resource_write)。
   *  返回 {blocked:true} 表示编辑器内存状态冲突(打开的脚本/缓存 Resource), 应中止写。
   *  headless 无编辑器状态可守, 回调未注入(undefined), 调用方跳过。 */
  checkEditorTextResourceWrite?: (path: string) => Promise<{ blocked: boolean; code?: number; message?: string }>;
  /** P1-2: 场景离线保存守卫(防覆盖编辑器中打开的场景, 与 guard_offline_scene_save 对称)。 */
  checkEditorSceneSave?: (path: string) => Promise<{ blocked: boolean; code?: number; message?: string }>;
  /** MCP Progress 通知 emitter（per-request，dispatcher 注入）。无 progressToken 时 undefined，调用方用 ctx.progress?.()。 */
  progress?: (progress: number, total: number, message?: string) => void;
  /** P2 (2026-09-11): run_project(profiling=true) 创建的函数级 profiler 实例——
   * spawn 前绑 127.0.0.1:0 端口并传 --remote-debug 给引擎回拨;profiler 工具的
   * capture_functions action 从此读。进程 close 时由 runtime 清理(close())。 */
  functionProfiler?: import('./core/function-profiler.js').DebuggerProfiler;
  /** PR-2: 客户端声明 tasks 能力(tools/call task-augmented)时 true——qa run 据此自动转 async
   *  并在响应 _meta.relatedTask 回指 task。由 GodotServer tools/call handler 从
   *  server.getClientCapabilities() 读出注入(dispatcher 层拿不到 server 引用)。 */
  taskAugmented?: boolean;
}

// Helper to create a text result
export function textResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

// Helper to create an error result (signals failure to MCP clients)
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Safely extract a message string from an unknown thrown value. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ─── Middleware types (competitive borrowing Phase 5) ──────────────────────────

export type ConnectionState = 'disconnected' | 'connected' | 'degraded' | 'reconnecting';

export interface DispatchContext {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  phase: 'before' | 'after';
  /** G2 (2026-08-13): per-request trace id (16 hex),注入 result._meta 供 client/可观测追踪。 */
  traceId: string;
  /** 1C (2026-09-19): best-effort 调用者标识(_meta.agentId/agent_id)。MCP 规范未定义
   *  caller 身份字段、主流客户端通常不注入 → 多数请求为 undefined。仅供审计 caller 归因,
   *  不得用于鉴权决策。 */
  caller?: string;
}

export type MiddlewareResult =
  | { passed: true }
  | { rejected: true; error: ToolResult };

export interface Middleware {
  name: string;
  before(ctx: DispatchContext): Promise<MiddlewareResult>;
  after?(ctx: DispatchContext, result: ToolResult): Promise<ToolResult>;
}

/** Delegate for proxy tool to re-dispatch through the full middleware chain. */
export type ToolCallDelegate = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
