/**
 * MCP Progress 通知 — 与 logger 同构的两件套（sender + clientReady）。
 *
 * 区别于 logger（sendLoggingMessage 无 token 广播，可模块级注入）：
 * progress 必须带 progressToken 路由到特定请求（per-request），
 * 故 token 经 createProgressEmitter 闭包捕获，随 request 透传（见 spec §4.3 四层参数链）。
 *
 * 失败安全：progress 是观测层，绝不影响主流程（guard + fire-and-forget）。
 */
import type { Server } from "@modelcontextprotocol/server";
import { ToolDeadlineError } from './tool-errors.js';

export type ProgressToken = string | number;
export type ProgressEmitter = (progress: number, total: number, message?: string) => void;

let _progressSender: Server | null = null;
let _progressClientReady = false;

/** 注入 MCP Server 实例（GodotServer 构造时调）；null 清除（close/测试隔离） */
export function setProgressSender(server: Server | null): void {
  _progressSender = server;
}

/** 标记 client 是否已完成 initialize（oninitialized 时设 true）；未就绪不发，避免 SDK 握手前报错 */
export function setProgressClientReady(ready: boolean): void {
  _progressClientReady = ready;
}

/**
 * 创建 per-request progress emitter。token 闭包捕获，并发安全（C-CONC-1）。
 * guard: _progressSender + _progressClientReady。失败静默。
 */
export function createProgressEmitter(token: ProgressToken): ProgressEmitter {
  return (progress: number, total: number, message?: string): void => {
    if (!_progressSender || !_progressClientReady) return;
    try {
      const p = _progressSender.notification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      });
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 同步 throw 静默——progress 是观测层，绝不影响主流程
    }
  };
}

/** 测试隔离 / 干净关闭：重置模块状态 */
export function resetProgressSender(): void {
  _progressSender = null;
  _progressClientReady = false;
}

/**
 * 心跳保活(2026-09-11 P1 批,来源 BuildersGate server.py:789-844 的取消经济学):
 * MCP 客户端对"无响应无进度"的调用按 idle 上限(常见 1800s)杀,但 server 侧线程照样
 * 跑完——钱照扣、文件照写、结果没处送("白花钱的取消")。心跳不是让慢工具变快,是让
 * 慢工具别变成静默损失:每 20s 发一次 progress notification 证明请求活着。
 * 首个 tick 在 20s 时——20s 内完成的工具零消息、零开销。
 * 无 progressToken(客户端未带 _meta.progressToken)时不发:progress 必须按 token
 * 路由到特定请求,无 token 无法投递(协议约束,非实现选择)。
 * message 明示 heartbeat 语义,防客户端误读为业务进度。
 */
export async function withToolHeartbeat<T>(
  emitter: ((progress: number, total: number, message?: string) => void) | undefined,
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!emitter) return fn();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    emitter(elapsedSec, 0, `${toolName}: still working (${elapsedSec}s) — heartbeat, not progress`);
  }, 20_000);
  // N-6(审查):unref 防"长工具永不 settle + server close"时 interval 吊住 event loop
  // (vitest fake timers 无 unref,防御式探测)
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * 工具调用全局 deadline 兜底(2026-09-20 可靠性批任务①,可靠性评估缺口:
 * dispatcher 无整体 deadline,handler 忘写内部超时则调用可无限挂起)。
 *
 * 与 withToolHeartbeat 的分工:心跳防"客户端 idle 杀"(取消经济学,只保活不中止);
 * deadline 是最后一道网——超过 deadlineMs 仍未 settle 的调用以 ToolDeadlineError
 * reject,由调用方(ToolDispatcher.handleCall)转结构化错误返回客户端(retryable)。
 *
 * 取消经济学边界(诚实声明):deadline 触发后底层 fn 仍在跑(JS 无法中止 Promise),
 * 其 late settle 结果被丢弃——与客户端 idle 杀同样是"白花钱的取消",差别是客户端
 * 拿到明确的 TOOL_DEADLINE_EXCEEDED 错误而非无限等待。
 *
 * deadlineMs <= 0 表示禁用(退化为纯心跳)。默认值对齐 qa run_timeout_s 上限(3600s,
 * src/tools/qa/spec.ts:185)——所有已知合法长操作不被误伤;更长/更短部署经
 * GODOT_MCP_TOOL_DEADLINE_MS 调整。deadline 触发时心跳 timer 一并清理(finally),
 * 不向已终结的请求继续发 progress。
 */
export async function withToolDeadline<T>(
  emitter: ((progress: number, total: number, message?: string) => void) | undefined,
  toolName: string,
  fn: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  if (!(deadlineMs > 0)) return withToolHeartbeat(emitter, toolName, fn);
  const startedAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (emitter) {
    heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      emitter(elapsedSec, 0, `${toolName}: still working (${elapsedSec}s) — heartbeat, not progress`);
    }, 20_000);
    if (typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === 'function') {
      (heartbeatTimer as unknown as { unref: () => void }).unref();
    }
  }
  try {
    return await new Promise<T>((resolve, reject) => {
      const deadlineTimer = setTimeout(() => {
        reject(new ToolDeadlineError(
          `${toolName}: exceeded global deadline of ${Math.round(deadlineMs / 1000)}s (GODOT_MCP_TOOL_DEADLINE_MS). ` +
          'The underlying operation may still be running server-side; its result will be discarded.',
        ));
      }, deadlineMs);
      if (typeof (deadlineTimer as unknown as { unref?: () => void }).unref === 'function') {
        (deadlineTimer as unknown as { unref: () => void }).unref();
      }
      // fn 的 late settle(deadline 已 reject 后到达)对已 settle 的 Promise 无副作用;
      // 在 executor 内挂 then 同时防 unhandled rejection。
      fn().then(
        (v) => { clearTimeout(deadlineTimer); resolve(v); },
        (e) => { clearTimeout(deadlineTimer); reject(e); },
      );
    });
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  }
}
