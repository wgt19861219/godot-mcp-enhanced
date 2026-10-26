import { randomBytes } from 'crypto';
import { getActionRisk, getActionRisks } from './tool-registry.js';
import { InternalError, RateLimitError } from './tool-errors.js';

interface PendingToken {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  /** I-07: True if any arg was truncated during creation — consumer must refuse execution. */
  wasTruncated?: boolean;
  // NOTE(2026-07-13 安全): caller/clientId 绑定不堵 AI 自确认(单客户端:AI 同 session
  // 产生+消费 token,任何 caller 校验都通过)。AI 自确认由 ToolDispatcher.confirm_and_execute
  // 的 out-of-band elicitation gate 堵。clientId 仅在未来多客户端时需加(防跨连接重放,与 elicitation 正交)。
}

export const TOKEN_TTL_MS = 120_000; // 120s — P0-2 MRTR 多一次 round-trip（原 60s 在 MRTR 下可能不够用户响应）
const MAX_TOKENS = 100;
const TOKEN_RATE_LIMIT = 5; // max new tokens per second
const MAX_ARGS_JSON_SIZE = 10_000; // I-02: Truncate args JSON to prevent memory bloat from large GDScript code blocks
const pendingTokens = new Map<string, PendingToken>();
let _recentCreations: number[] = []; // timestamps of recent createPendingToken calls

// I-CQ-06: Prevent timer restart after explicit cleanup/shutdown
let _shutdown = false;

let _cleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
}, 60_000);
// 允许进程正常退出（不阻塞事件循环）
if (_cleanupTimer.unref) _cleanupTimer.unref();

/** Restart the background cleanup interval if it isn't running. */
function ensureCleanupTimer(): void {
  if (_shutdown) return; // I-CQ-06: Don't restart after explicit cleanup
  if (_cleanupTimer !== null) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, pending] of pendingTokens) {
      if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
    }
  }, 60_000);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

// IMPORTANT: 本守卫依赖 GodotServer.ts 按 MERGED 工具名（如 'scene'/'script'/'game'）路由，
// 而非旧的独立工具名。若调用方绕过 merged-name 路由器直接用旧名（如 'remove_node'），
// 守卫将捕获不到。GodotServer.handleToolCall() 是单一入口，始终解析为 merged 名。
//
// 判定依据：ToolMeta.actionRisks（每个工具模块的 TOOL_META 声明）。
// risk !== 'read' 的 action 需确认。
//
// 2026-07-12 CRITICAL RCE 复合链修复：删除 dynamicRiskOverride（曾把
// script.edit_script + search_and_replace 降级为 'read'）。该豁免的"非破坏性"
// 假设已被证伪——search_and_replace 能写盘任意内容（含 class_name 注入），
// 经 ensureClassNameImport 自动注册全局类，配合 create_scene/add_node 的
// root_node_type 无校验 + godot_operations.gd:177-179 脚本分支 script.new()
// 无 is_parent_class 检查，构成零确认 RCE 复合链。豁免已删，edit_script 整体
// 恢复 TOOL_META 声明的 'write' risk，search_and_replace 正常需确认令牌。

// 批 B1 (2026-10-26): dry_run 只读预检不产生持久变更,免确认(与 tool-circuit-breaker
// 的同款豁免对齐)。批 B 审查 B-1 清偿:豁免收敛到「handler 真实实现 dry_run 语义」的
// action 白名单——全局布尔短路会让任意写/删 action 传 dry_run:true 绕过确认令牌
// (2026-07-12 dynamicRiskOverride 同型教训复发:豁免不得信任调用方承诺,须验证可兑现)。
// 白名单维护:新增实现 dry_run 的 handler 时同步加条目。
const DRY_RUN_IMPLEMENTED = new Set(['scene.commit', 'script.project_replace']);
export { DRY_RUN_IMPLEMENTED };

export function requiresConfirmation(toolName: string, args?: Record<string, unknown>): boolean {
  const action = (args?.action ?? args?.method) as string | undefined;
  if (action == null) return false;
  if (args?.dry_run === true && DRY_RUN_IMPLEMENTED.has(`${toolName}.${action}`)) return false;
  const risk = getActionRisk(toolName, action);
  return risk !== undefined && risk !== 'read';
}

export function createPendingToken(toolName: string, args: Record<string, unknown>): string {
  // I-19: refuse token creation after shutdown — timer is stopped, token would never be cleaned
    if (_shutdown) throw new InternalError('Token system has been shut down');
  ensureCleanupTimer();
  const now = Date.now();
  // A-05: Rate limit — prevent high-frequency token creation from evicting legitimate tokens
  _recentCreations = _recentCreations.filter(t => now - t < 1000);
  // A-05: 防止数组在高频场景下短暂膨胀，超过 2x 限制时截断
  if (_recentCreations.length > TOKEN_RATE_LIMIT * 2) {
    _recentCreations = _recentCreations.slice(-TOKEN_RATE_LIMIT);
  }
  if (_recentCreations.length >= TOKEN_RATE_LIMIT) {
    throw new RateLimitError('Token creation rate limit exceeded, retry shortly');
  }
  _recentCreations.push(now);
  // 清理过期 token
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
  // 超限时移除最旧的（遍历 100 条 < 1μs，逻辑清晰可靠）
  if (pendingTokens.size >= MAX_TOKENS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, pending] of pendingTokens) {
      if (pending.createdAt < oldestTime) {
        oldestTime = pending.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) pendingTokens.delete(oldestKey);
  }
  const token = randomBytes(18).toString('base64url');
  // I-02: Truncate large args to prevent memory bloat (e.g. GDScript code blocks in execute_gdscript)
  const { args: truncatedArgs, truncated } = truncateArgs(args);
  pendingTokens.set(token, { token, toolName, args: truncatedArgs, createdAt: now, wasTruncated: truncated || undefined });
  return token;
}

/**
 * Consume a pending confirmation token.
 *
 * SECURITY NOTE: 校验 token 值但不验证 caller 身份。单客户端 MCP 下 caller/session 绑定
 * 不堵 AI 自确认(AI 同 session 产生+消费 token,caller 校验必过)。AI 自确认改由
 * ToolDispatcher.confirm_and_execute 的 out-of-band elicitation gate 堵(2026-07-13):
 * consumeToken 成功后 elicitInput 经 server→client→user UI 问用户,AI 经 tools/call
 * 通道无法伪造 elicitation 响应。未来若加多客户端,此处仍需 clientId 防跨连接重放(与 elicitation 正交)。
 */
export function consumeToken(token: string): { toolName: string; args: Record<string, unknown>; wasTruncated?: boolean } | null {
  const pending = pendingTokens.get(token);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > TOKEN_TTL_MS) {
    pendingTokens.delete(token);
    return null;
  }
  pendingTokens.delete(token);
  return { toolName: pending.toolName, args: pending.args, wasTruncated: pending.wasTruncated };
}

/**
 * Peek a pending confirmation token without consuming it.
 *
 * P0-2 MRTR: confirm_and_execute 第一轮 peek（验证有效但不消费），返回 InputRequiredResult；
 * 第二轮收到 inputResponses 后才 consumeToken。两步分离避免第一轮误消费致第二轮 requestState 校验失败。
 */
export function peekToken(token: string): { toolName: string; args: Record<string, unknown>; wasTruncated?: boolean } | null {
  const pending = pendingTokens.get(token);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > TOKEN_TTL_MS) {
    pendingTokens.delete(token);
    return null;
  }
  return { toolName: pending.toolName, args: pending.args, wasTruncated: pending.wasTruncated };
}

export function pendingCount(): number {
  return pendingTokens.size;
}

/**
 * Reset all mutable state: clear pending tokens and stop the cleanup interval.
 * Useful for test teardown or hot-reload scenarios.
 * The cleanup interval will be recreated on the next `createPendingToken()` call.
 */
export function resetState(): void {
  pendingTokens.clear();
  _recentCreations = [];
  _shutdown = false; // Allow restart after test reset
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

/**
 * Graceful shutdown: stop the cleanup interval and clear all pending tokens.
 * After calling this, the module is still usable — the interval restarts on
 * the next `createPendingToken()` call.
 */
export function cleanup(): void {
  _shutdown = true; // I-CQ-06: Prevent timer restart after graceful shutdown
  pendingTokens.clear();
  _recentCreations = [];
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

/** @internal Exposed for testing — check whether the cleanup timer is active. */
export function isCleanupTimerRunning(): boolean {
  return _cleanupTimer !== null;
}

/** I-02: Truncate large string values in args to cap memory usage per token.
 *  I-07: Returns whether any value was truncated so consumer can refuse execution. */
function truncateArgs(args: Record<string, unknown>): { args: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > MAX_ARGS_JSON_SIZE) {
      out[key] = value.substring(0, MAX_ARGS_JSON_SIZE) + `...[truncated ${value.length - MAX_ARGS_JSON_SIZE} chars]`;
      truncated = true;
    } else {
      out[key] = value;
    }
  }
  return { args: out, truncated };
}

/** Whether a tool has ANY guarded action (任意 action 的 risk 非 read). Used by capability matrix. */
export function isGuardedTool(toolName: string): boolean {
  const risks = getActionRisks(toolName);
  return risks !== undefined && Object.values(risks).some(r => r !== 'read');
}
