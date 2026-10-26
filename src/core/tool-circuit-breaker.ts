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
//   before-passed 标记 + 错误码排除。InputRequiredResult 由 executeMiddleware 整体跳过 after。
// - key 表上限 maxKeys(默认 1000)防长会话内存膨胀:超限清全部未开路条目(开路条目
//   是正在防御的状态,优先保留)。
// - 关闭开关:GODOT_MCP_TOOL_CIRCUIT_BREAKER=0(feature-flags 注册,默认开)。
//
// 「稳定参数指纹」:canonical JSON(递归排序对象键)→ FNV-1a 32bit。同语义参数
// (键序不同)指纹相同;任何值变化即新 key——失败原因通常与参数强相关,改参数
// 获得新机会是设计意图(拒绝信息中明示)。非安全用途,不需加密强度。

import { opsErrorResult } from './shared/errors.js';
import { isFeatureEnabled } from './feature-flags.js';
import type { DispatchContext, Middleware, ToolResult } from '../types.js';

/** 本请求已通过熔断 before 的标记(after 据此只计真实执行过的调用)。 */
const CB_PASSED = Symbol('circuitBreakerPassed');

/** middleware 层拒绝的错误码——不计入熔断(工具未执行或非工具失败)。 */
const NON_TOOL_ERROR_CODES = new Set(['RATE_LIMIT', 'TOOL_CIRCUIT_OPEN', 'MISSING_PARAM']);

export type RiskLevel = 'read' | 'write' | 'destructive' | 'process';

export interface CircuitBreakerOptions {
  /** 连续失败开路阈值,默认 3。 */
  threshold?: number;
  /** 开路后半开等待毫秒,默认 10 分钟。 */
  openMs?: number;
  /** key 表上限,默认 1000。 */
  maxKeys?: number;
  /** 查询 tool.action 风险等级;undefined/'read' 不熔。默认接 tool-registry getActionRisk。 */
  getActionRisk?: (toolName: string, action: string) => RiskLevel | undefined;
  /** 时钟注入(测试用),默认 Date.now。 */
  now?: () => number;
}

interface BreakerState {
  count: number;
  firstError: string;
  openedAt?: number;
}

/** 递归排序对象键后的 canonical JSON 序列化(数组保序)。 */
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

/** 稳定参数指纹:canonical JSON → FNV-1a。导出供测试。 */
export function stableArgsFingerprint(args: Record<string, unknown>): string {
  return fnv1a(JSON.stringify(canonicalize(args)));
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

function extractErrorBrief(result: ToolResult): string {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

export function createCircuitBreakerMiddleware(opts: CircuitBreakerOptions = {}): Middleware {
  const threshold = opts.threshold ?? 3;
  const openMs = opts.openMs ?? 10 * 60 * 1000;
  const maxKeys = opts.maxKeys ?? 1000;
  const now = opts.now ?? Date.now;
  const getActionRisk = opts.getActionRisk ?? (() => undefined);
  const breakers = new Map<string, BreakerState>();

  /** 熔断只关心写类 action;action 缺失时用 '_' 占位保持 key 形状稳定。 */
  const isBreakable = (ctx: DispatchContext): boolean => {
    if (!isFeatureEnabled('TOOL_CIRCUIT_BREAKER')) return false;
    // 批 B1 (2026-10-26): dry_run 只读预检不熔(与 guard.ts requiresConfirmation 的
    // 同款豁免对齐)——预检就是要反复试探的场景。
    if (ctx.args?.dry_run === true) return false;
    const action = typeof ctx.args?.action === 'string' ? ctx.args.action
      : typeof ctx.args?.method === 'string' ? ctx.args.method
      : '_';
    const risk = getActionRisk(ctx.toolName, action);
    return risk !== undefined && risk !== 'read';
  };

  const keyOf = (ctx: DispatchContext): string => {
    const action = typeof ctx.args?.action === 'string' ? ctx.args.action
      : typeof ctx.args?.method === 'string' ? ctx.args.method
      : '_';
    return `${ctx.toolName}.${action}:${stableArgsFingerprint(ctx.args ?? {})}`;
  };

  return {
    name: 'circuitBreaker',
    before: async (ctx) => {
      if (!isBreakable(ctx)) return { passed: true };
      const key = keyOf(ctx);
      const st = breakers.get(key);
      if (st?.openedAt !== undefined) {
        if (now() - st.openedAt >= openMs) {
          // 半开:放行一次试探,失败则续开路(重新计时)
          delete st.openedAt;
        } else {
          const remainSec = Math.ceil((st.openedAt + openMs - now()) / 1000);
          return {
            rejected: true,
            error: opsErrorResult('TOOL_CIRCUIT_OPEN',
              `同参数调用已连续失败 ${st.count} 次,熔断中(约剩 ${remainSec}s 后半开试探)。首错: ${st.firstError}`,
              {
                retryable: true,
                errorCategory: 'guard',
                suggestion: '先 read 目标状态定位失败原因,或修改参数后重试(参数不同即新指纹);半开窗口后自动放行一次试探。',
              }),
          };
        }
      }
      (ctx as DispatchContext & { [CB_PASSED]?: boolean })[CB_PASSED] = true;
      return { passed: true };
    },
    after: async (ctx, result) => {
      const passedThrough = (ctx as DispatchContext & { [CB_PASSED]?: boolean })[CB_PASSED] === true;
      if (!passedThrough) return result; // 本请求未通过熔断 before(middleware 早拒/非工具执行),不计
      if (isBreakable(ctx)) {
        const key = keyOf(ctx);
        const failed = result.isError === true && !NON_TOOL_ERROR_CODES.has(parseOpsErrorCode(result) ?? '');
        if (failed) {
          const st = breakers.get(key) ?? { count: 0, firstError: extractErrorBrief(result) };
          st.count += 1;
          if (st.count >= threshold && st.openedAt === undefined) {
            st.openedAt = now();
          }
          breakers.set(key, st);
          if (breakers.size > maxKeys) {
            // 超限优先清未开路条目(开路条目是正在防御的状态)
            for (const [k, v] of breakers) {
              if (v.openedAt === undefined) breakers.delete(k);
            }
          }
        } else {
          breakers.delete(key); // 成功(或非工具失败码)即清零
        }
      }
      return result;
    },
  };
}
