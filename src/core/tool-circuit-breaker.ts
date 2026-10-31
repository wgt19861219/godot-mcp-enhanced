// src/core/tool-circuit-breaker.ts
//
// 工具级失败熔断 middleware(批 B3,2026-10-26,竞品综述建议2 三件套之一)。
// 对标 Unreal_mcp 8266bd35 "an unchanged call that failed three times in a row
// is refused before it runs":同一 tool.action + 稳定参数指纹连续失败 N 次(默认 3)
// 即拒绝执行,附首错摘要与自愈指引;成功清零;开路 10 分钟后半开放行一次试探。
//
// 边界:
// - 仅对 write/destructive/process 类 action 生效(getActionRisk 判定)。read 不熔——
//   探测类调用失败属正常探路,熔断反而阻断发现。risk 未知(undefined)同样不熔:
//   熔断是防御层,不能因元数据缺失误伤。
// - 只计「工具真实执行」的失败:middleware 链上更早的拒绝(rate-limit/audit)不会走到
//   本 middleware 的 before,天然不计;更晚的拒绝(elicitation MISSING_PARAM)通过
//   键快照 + 错误码排除。InputRequiredResult 由 executeMiddleware 整体跳过 after。
// - 确认流接入(2026-10-29 审查 B-1/F1):write 类工具经 confirm_and_execute 两轮往返
//   真实执行时绕过 middleware 链(外层 ctx.toolName='confirm_and_execute' 恒不可熔)——
//   dispatcher 在 _confirmExecute 真实执行点显式调 checkOpen/recordOutcome,与
//   middleware 路径共用同一键空间与计数表。
// - 键定格(2026-10-29 审查 B-1/F2):before 时把键快照进 ctx,after 用快照——
//   executeToolCall 在 before 之后原地注入 args.project_path、elicitation middleware
//   在 before 之后补填必填参数,均会使 after 重算的指纹漂移到别的键(计数与开路检查
//   落在不同键,熔断永不触发)。指纹计算另剔除注入类字段,使确认流(pending.args 含
//   注入的 project_path)与直接调用(客户端原始 args)落入同一键。
// - 半开单飞(2026-10-29 审查 M-2/F3):半开窗口放行试探时登记 probingAt 时间戳,
//   试探在飞期间并发调用全部拒绝(原实现无 in-flight 标记,并发全放行,多路同时
//   失败会连环续开路)。probingAt 超过 probeTimeoutMs 视为试探丢失(after 未跑,
//   如进程崩溃),允许新试探防永久锁死。
// - key 表上限 maxKeys(默认 1000)防长会话内存膨胀:超限先清全部未开路条目(开路
//   条目是正在防御的状态,优先保留);全开路删无可删时按最旧 openedAt 淘汰
//   (2026-10-29 审查 M-3/F4,原实现此场景 Map 无界增长)。
// - 确认令牌第一轮(requires_confirmation 响应)中性处理(2026-10-29 审查 B-1):
//   该响应非错误亦非成功,成功分支会清零计数——若不清零处理,确认流「第一轮发
//   token→第二轮真实失败」循环中计数永远被第一轮重置,永不达阈值。
// - 关闭开关:GODOT_MCP_TOOL_CIRCUIT_BREAKER=0(feature-flags 注册,默认开)。
//
// 「稳定参数指纹」:canonical JSON(递归排序对象键,剔除注入类字段)→ FNV-1a 32bit。
// 同语义参数(键序不同/注入字段增减)指纹相同;任何值变化即新 key——失败原因通常与
// 参数强相关,改参数获得新机会是设计意图(拒绝信息中明示)。非安全用途,不需加密强度。

import { opsErrorResult } from './shared/errors.js';
import { isFeatureEnabled } from './feature-flags.js';
import type { DispatchContext, Middleware, ToolResult } from '../types.js';

/** before 时把熔断键快照进 ctx 的标记(after 据此只计真实执行过的调用,且不重算键)。 */
const CB_KEY = Symbol('circuitBreakerKey');

/** middleware 层拒绝的错误码——不计入熔断(工具未执行或非工具失败)。 */
const NON_TOOL_ERROR_CODES = new Set(['RATE_LIMIT', 'TOOL_CIRCUIT_OPEN', 'MISSING_PARAM']);

/** dispatcher 注入类参数(executeToolCall 原地写入,非客户端语义)——指纹计算前剔除,
 * 使「客户端省略 project_path 的直接调用」与「token 内含注入 project_path 的确认流」
 * 落入同一键(2026-10-29 审查 B-1/F2)。 */
const INJECTED_ARG_KEYS = new Set(['project_path']);

export type RiskLevel = 'read' | 'write' | 'destructive' | 'process';

export interface CircuitBreakerOptions {
  /** 连续失败开路阈值,默认 3。 */
  threshold?: number;
  /** 开路后半开等待毫秒,默认 10 分钟。 */
  openMs?: number;
  /** key 表上限,默认 1000。 */
  maxKeys?: number;
  /** 半开试探在飞保护窗毫秒,默认 60 秒(超时视为试探丢失,允许新试探)。 */
  probeTimeoutMs?: number;
  /** 查询 tool.action 风险等级;undefined/'read' 不熔。默认接 tool-registry getActionRisk。 */
  getActionRisk?: (toolName: string, action: string) => RiskLevel | undefined;
  /** 时钟注入(测试用),默认 Date.now。 */
  now?: () => number;
}

/** 确认流(confirm_and_execute→_confirmExecute)接入面:绕过 middleware 链的真实执行点。 */
export interface CircuitBreakerMiddleware extends Middleware {
  /** 真实执行前检查:开路(含半开单飞拒绝)时返回拒绝结果,否则 null 放行。 */
  checkOpen(toolName: string, args: Record<string, unknown>): ToolResult | null;
  /** 真实执行后记账(与 middleware after 同计数表);failed 显式覆盖失败判定
   * (确认流绕过 healthSample 的 isError 补打,调用方用 checkJsonSuccessFalse 兜底)。 */
  recordOutcome(toolName: string, args: Record<string, unknown>, result: ToolResult, failed?: boolean): void;
}

interface BreakerState {
  count: number;
  firstError: string;
  openedAt?: number;
  /** 半开试探在飞时间戳(M-2 单飞);试探结束(成败均)清除。 */
  probingAt?: number;
}

/** 递归排序对象键后的 canonical JSON 序列化(数组保序,注入类字段已在上层剔除)。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** FNV-1a 32bit(非安全用途,指纹稳定即可)。 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 稳定参数指纹:剔除注入类字段 → canonical JSON → FNV-1a。导出供测试。 */
export function stableArgsFingerprint(args: Record<string, unknown>): string {
  const pruned: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    if (!INJECTED_ARG_KEYS.has(k)) pruned[k] = args[k];
  }
  return fnv1a(JSON.stringify(canonicalize(pruned)));
}

/** 从 opsErrorResult 形态的结果里解析 error_code(无法解析返回 undefined)。导出供测试。 */
export function parseOpsErrorCode(result: ToolResult): string | undefined {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(text) as { error_code?: unknown };
    return typeof parsed.error_code === 'string' ? parsed.error_code : undefined;
  } catch {
    return undefined;
  }
}

/** 确认令牌第一轮响应(requires_confirmation)——非错误非成功,计数中性。
 *  收紧(2026-10-31 三审遗留3):同时要求 "confirmation_token" 子串在场——真实令牌响应
 *  两键恒同现(ToolDispatcher 确认门);单 requires_confirmation 子串可被工具正文伪造。
 *  与 audit-log isTokenRequestResult 同口径联动,改须两处同步。 */
function isConfirmationRequest(result: ToolResult): boolean {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
  return (
    typeof text === 'string' &&
    text.includes('"requires_confirmation":true') &&
    text.includes('"confirmation_token"')
  );
}

function extractErrorBrief(result: ToolResult): string {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

export function createCircuitBreakerMiddleware(opts: CircuitBreakerOptions = {}): CircuitBreakerMiddleware {
  const threshold = opts.threshold ?? 3;
  const openMs = opts.openMs ?? 10 * 60 * 1000;
  const maxKeys = opts.maxKeys ?? 1000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const getActionRisk = opts.getActionRisk ?? (() => undefined);
  const breakers = new Map<string, BreakerState>();

  /** 熔断只关心写类 action;action 缺失时用 '_' 占位保持 key 形状稳定。 */
  const isBreakableArgs = (toolName: string, args?: Record<string, unknown>): boolean => {
    if (!isFeatureEnabled('TOOL_CIRCUIT_BREAKER')) return false;
    // 批 B1 (2026-10-26): dry_run 只读预检不熔(与 guard.ts requiresConfirmation 的
    // 同款豁免对齐)——预检就是要反复试探的场景。
    if (args?.dry_run === true) return false;
    const action = actionOf(args);
    const risk = getActionRisk(toolName, action);
    return risk !== undefined && risk !== 'read';
  };

  const actionOf = (args?: Record<string, unknown>): string =>
    typeof args?.action === 'string' ? args.action
      : typeof args?.method === 'string' ? args.method
        : '_';

  const keyOfArgs = (toolName: string, args?: Record<string, unknown>): string =>
    `${toolName}.${actionOf(args)}:${stableArgsFingerprint(args ?? {})}`;

  /** 开路检查 + 半开单飞放行(before 与确认流 checkOpen 共用)。返回拒绝结果或 null(放行)。 */
  const admitProbe = (key: string): ToolResult | null => {
    const st = breakers.get(key);
    if (st?.openedAt === undefined) return null;
    const elapsed = now() - st.openedAt;
    if (elapsed >= openMs) {
      // 半开:放行一次试探(M-2 单飞——试探在飞期间并发拒绝;probingAt 超窗视为试探丢失)
      if (st.probingAt !== undefined && now() - st.probingAt < probeTimeoutMs) {
        return opsErrorResult('TOOL_CIRCUIT_OPEN',
          `同参数调用熔断中(半开试探进行中,稍后重试)。首错: ${st.firstError}`,
          {
            retryable: true,
            errorCategory: 'guard',
            suggestion: '半开试探成功后自动恢复;失败则重新计时。稍后重试或修改参数(参数不同即新指纹)。',
          });
      }
      st.probingAt = now();
      breakers.set(key, st);
      return null;
    }
    const remainSec = Math.ceil((st.openedAt + openMs - now()) / 1000);
    return opsErrorResult('TOOL_CIRCUIT_OPEN',
      `同参数调用已连续失败 ${st.count} 次,熔断中(约剩 ${remainSec}s 后半开试探)。首错: ${st.firstError}`,
      {
        retryable: true,
        errorCategory: 'guard',
        suggestion: '先 read 目标状态定位失败原因,或修改参数后重试(参数不同即新指纹);半开窗口后自动放行一次试探。',
      });
  };

  /** 成败记账(after 与确认流 recordOutcome 共用)。 */
  const applyOutcome = (key: string, result: ToolResult, failedOverride?: boolean): void => {
    // 确认令牌第一轮响应:非错误非成功,既不累计也不清零(清零会让确认流计数永不达阈值)
    if (isConfirmationRequest(result)) return;
    // middleware 层拒绝码(RATE_LIMIT/MISSING_PARAM 等)同样中性——工具未执行,
    // 真实失败计数应保留(批 B 审查 Nit-1 清偿;原实现无条件 delete 削弱防御)。
    if (result.isError === true && NON_TOOL_ERROR_CODES.has(parseOpsErrorCode(result) ?? '')) return;
    const failed = failedOverride ?? result.isError === true;
    if (failed) {
      const st = breakers.get(key) ?? { count: 0, firstError: extractErrorBrief(result) };
      st.count += 1;
      // 半开试探失败 → 续开路(重新计时);首次达阈值 → 开路。probingAt 无论成败都清。
      if (st.count >= threshold) st.openedAt = now();
      st.probingAt = undefined;
      breakers.set(key, st);
      if (breakers.size > maxKeys) {
        // 超限优先清未开路条目(开路条目是正在防御的状态)
        for (const [k, v] of breakers) {
          if (v.openedAt === undefined) breakers.delete(k);
        }
        // M-3 兜底:全开路删无可删时按最旧 openedAt 淘汰,防 Map 无界增长
        if (breakers.size > maxKeys) {
          let oldestKey: string | undefined;
          let oldestAt = Number.MAX_SAFE_INTEGER;
          for (const [k, v] of breakers) {
            const at = v.openedAt ?? Number.MAX_SAFE_INTEGER;
            if (at < oldestAt) { oldestAt = at; oldestKey = k; }
          }
          if (oldestKey !== undefined) breakers.delete(oldestKey);
        }
      }
    } else {
      breakers.delete(key); // 成功(或非工具失败码)即清零
    }
  };

  return {
    name: 'circuitBreaker',
    before: async (ctx) => {
      if (!isBreakableArgs(ctx.toolName, ctx.args)) return { passed: true };
      const key = keyOfArgs(ctx.toolName, ctx.args);
      const rejected = admitProbe(key);
      if (rejected) return { rejected: true, error: rejected };
      // F2 键定格:before 通过即把键快照进 ctx,after 用快照——after 时 args 可能已被
      // executeToolCall 注入 project_path / elicitation 补填参数,重算会漂到别的键。
      (ctx as DispatchContext & { [CB_KEY]?: string })[CB_KEY] = key;
      return { passed: true };
    },
    after: async (ctx, result) => {
      const key = (ctx as DispatchContext & { [CB_KEY]?: string })[CB_KEY];
      if (typeof key !== 'string') return result; // 本请求未通过熔断 before(middleware 早拒/非熔断域),不计
      applyOutcome(key, result);
      return result;
    },
    checkOpen: (toolName, args) => {
      if (!isBreakableArgs(toolName, args)) return null;
      return admitProbe(keyOfArgs(toolName, args));
    },
    recordOutcome: (toolName, args, result, failed) => {
      if (!isBreakableArgs(toolName, args)) return;
      applyOutcome(keyOfArgs(toolName, args), result, failed);
    },
  };
}
