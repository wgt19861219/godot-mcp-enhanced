/**
 * G2 (2026-08-13): 结构化错误分类体系 + trace_id 生成。
 *
 * 借鉴 xulek `_classify_exception` / `_new_trace_id`(附录 H 标杆),移植到 enhanced。
 *
 * PII 护栏(核心):分类从异常【类型】映射,绝不读 err.message。
 * 旧 safeErrorCategory 曾把含路径/项目名的错误文本塞进 error_category 外传 PII
 * (见 ToolDispatcher.ts 506-510 历史注释);本模块用结构化异常类型替代文本推断,
 * 让分类可精细化的同时不再有 PII 外传风险。
 *
 * 用法:throw new PathError() / new ConnectionError() 等;主 catch 用 classifyError(err)
 * 拿 {category, retryable, code, safeMessage},safeMessage 进 client 响应,
 * 完整 err.message 只 log() 到 server 日志。
 */

import { randomUUID } from 'crypto';

export type ErrorCategory =
  | 'validation'
  | 'timeout'
  | 'transport'
  | 'guard'
  | 'path'
  | 'connection'
  | 'internal';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  code: string;
  /** PII-safe message — 不含路径/项目名,可进 client 响应。完整 err.message 只 log。 */
  safeMessage: string;
}

/**
 * 基类:所有结构化工具错误。
 * 子类设默认 category / retryable / code;构造时传 PII-safe 的 safeMessage。
 * 父类 Error.message 也用 safeMessage(避免误传 PII);如需保留详细文本供 log,
 * 调用方在 catch 里 `log(err instanceof Error ? err.message : String(err))` 单独打。
 */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: ErrorCategory,
    public readonly retryable: boolean,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'ToolError';
  }
}

/** 参数校验失败(不可重试)。 */
export class ValidationError extends ToolError {
  constructor(safeMessage = 'Parameter validation failed', code = 'INVALID_PARAMS') {
    super(code, 'validation', false, safeMessage);
    this.name = 'ValidationError';
  }
}

/** 路径校验失败:不在白名单 / 穿越 / 非法字符(不可重试,PII 高发区)。 */
export class PathError extends ToolError {
  constructor(safeMessage = 'Path not allowed or invalid', code = 'PATH_NOT_ALLOWED') {
    super(code, 'path', false, safeMessage);
    this.name = 'PathError';
  }
}

/** 编辑器/bridge 未连接(可重试 — 重连后可成功)。 */
export class ConnectionError extends ToolError {
  constructor(safeMessage = 'Editor/bridge not connected', code = 'NOT_CONNECTED') {
    super(code, 'connection', true, safeMessage);
    this.name = 'ConnectionError';
  }
}

/** 操作超时(可重试)。 */
export class TimeoutError extends ToolError {
  constructor(safeMessage = 'Operation timed out', code = 'TIMEOUT') {
    super(code, 'timeout', true, safeMessage);
    this.name = 'TimeoutError';
  }
}

/**
 * dispatcher 级工具调用全局 deadline 兜底(可重试,2026-09-20 可靠性批任务①)。
 * 与 TimeoutError 区分:TimeoutError 是各 handler 内部的业务超时(如 Godot 进程 30s);
 * ToolDeadlineError 是 ToolDispatcher 包的最后一道网——handler 忘写内部超时导致调用
 * 无限挂起时,由 GODOT_MCP_TOOL_DEADLINE_MS(默认 3600000ms)兜底 reject。
 */
export class ToolDeadlineError extends ToolError {
  constructor(safeMessage = 'Tool call exceeded global deadline') {
    super('TOOL_DEADLINE_EXCEEDED', 'timeout', true, safeMessage);
    this.name = 'ToolDeadlineError';
  }
}

/** 传输层错误:socket 断开等非超时(可重试)。 */
export class TransportError extends ToolError {
  constructor(safeMessage = 'Transport error', code = 'TRANSPORT') {
    super(code, 'transport', true, safeMessage);
    this.name = 'TransportError';
  }
}

/** 守卫拒绝(确认令牌/只读模式拦截,不可重试)。 */
export class GuardError extends ToolError {
  constructor(safeMessage = 'Guard rejected operation', code = 'GUARD') {
    super(code, 'guard', false, safeMessage);
    this.name = 'GuardError';
  }
}

/** 速率限制(瞬态,可重试 — 与 GuardError 拒绝区分)。归 guard category 但 retryable=true。 */
export class RateLimitError extends ToolError {
  constructor(safeMessage = 'Rate limit exceeded, retry shortly', code = 'RATE_LIMIT') {
    super(code, 'guard', true, safeMessage);
    this.name = 'RateLimitError';
  }
}

/** 内部错误(不可重试,PII-safe 固定兜底)。 */
export class InternalError extends ToolError {
  constructor(safeMessage = 'Internal error', code = 'INTERNAL') {
    super(code, 'internal', false, safeMessage);
    this.name = 'InternalError';
  }
}

/**
 * Classify an unknown thrown value into a structured error.
 *
 * ToolError 子类走结构化字段;原生 Error / 其它值兜底成 internal(PII-safe 固定 message)。
 * **绝不读 err.message 作为 safeMessage**(防 PII 外传)。
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ToolError) {
    return {
      category: err.category,
      retryable: err.retryable,
      code: err.code,
      safeMessage: err.safeMessage,
    };
  }
  // 原生 Error / string / 其它:固定 internal + 安全 message,绝不外泄 err.message
  return { category: 'internal', retryable: false, code: 'INTERNAL', safeMessage: 'Internal error' };
}

/** Generate a 16-hex trace id(对齐 xulek `_new_trace_id`,AI 易读)。单 server 不用 W3C traceparent。 */
export function newTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}
