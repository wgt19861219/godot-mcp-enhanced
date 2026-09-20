// src/core/middleware.ts
//
// Middleware pipeline executor and middleware factories (rate-limit / elicitation).

import { getLogger } from './logger.js';
import type { Tool } from "@modelcontextprotocol/server";
import { errorResult } from '../types.js';
import { opsErrorResult } from './shared/errors.js';
import type { DispatchContext, Middleware, MiddlewareResult, ToolResult, HandlerResult } from '../types.js';
import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { isFeatureEnabled } from './feature-flags.js';
import { classifyError } from './tool-errors.js';
import type { RequestedSchema } from './elicit.js';

// ─── Pipeline Executor ────────────────────────────────────────────────────────

/**
 * Execute a tool call through the middleware pipeline.
 *
 * 1. Run each mw.before(ctx) in order. First rejection stops the before-chain.
 * 2. If all before hooks pass, call executeTool(). If rejected, skip executeTool.
 * 3. Run ALL mw.after(ctx, result) hooks — even if before was rejected.
 *    Each after hook can modify result. After hooks that throw are caught silently.
 */
export async function executeMiddleware(
  middleware: Middleware[],
  ctx: DispatchContext,
  executeTool: () => Promise<HandlerResult>,
): Promise<HandlerResult> {
  let result: HandlerResult = errorResult('No middleware result');
  let rejected = false;

  // ── Phase 1: Before hooks ───────────────────────────────────────────────────
  for (const mw of middleware) {
    try {
      const beforeResult: MiddlewareResult = await mw.before(ctx);
      if ('rejected' in beforeResult && beforeResult.rejected) {
        getLogger().info('middleware', `Rejected by "${mw.name}": tool=${ctx.toolName}`);
        result = beforeResult.error;
        rejected = true;
        break;
      }
    } catch (err) {
      getLogger().error('middleware', `Before hook "${mw.name}" threw: ${err instanceof Error ? err.stack : String(err)}`);
      result = errorResult(`Middleware "${mw.name}" error: ${classifyError(err).safeMessage}`);
      rejected = true;
      break;
    }
  }

  // ── Phase 2: Execute tool ──────────────────────────────────────────────────
  if (!rejected) {
    try {
      result = await executeTool();
    } catch (err) {
      // Log full exception (including stack trace) so crashes are diagnosable
      getLogger().error('middleware', `Tool execution threw: ${err instanceof Error ? err.stack : String(err)}`);
      result = errorResult(`Tool execution error: ${classifyError(err).safeMessage}`);
    }
  }

  // ── Phase 3: After hooks (always run) ──────────────────────────────────────
  // P0-2 MRTR: InputRequiredResult 是协议级控制流（confirm_and_execute 双时代），跳过 after hooks
  for (const mw of middleware) {
    if (mw.after && !isInputRequiredResult(result)) {
      try {
        result = await mw.after(ctx, result as ToolResult);
      } catch {
        // After hooks must not crash the pipeline — silently catch
        getLogger().warn('middleware', `After hook "${mw.name}" threw, ignoring`);
      }
    }
  }

  return result!;
}

// (createConnectionCheckMiddleware 已删除:生产未接入的 dead code,接入需统一
//  bridge/editor 两套连接信号源,成本高于收益;现有断连由各工具 handler 内部
//  返 BRIDGE_NOT_CONNECTED 处理。2026-08-14 P2-2 清理。)

// ─── Elicitation Middleware Factory ────────────────────────────────────────────

/**
 * Create an elicitation middleware.
 * Checks required params vs provided args. If missing and client supports
 * elicitation, asks the client. Otherwise returns MISSING_PARAM error.
 * Only prompts for primitive types (string/number/boolean/enum).
 */
export function createElicitationMiddleware(
  getToolDef: (name: string) => Tool | null,
  elicitFn: ((requestedSchema: RequestedSchema, message: string) => Promise<Record<string, unknown> | null>) | null,
): Middleware {
  return {
    name: 'elicitation',

    before: async (ctx) => {
      if (!isFeatureEnabled('ELICITATION')) return { passed: true };

      const def = getToolDef(ctx.toolName);
      if (!def?.inputSchema) return { passed: true };


      // Shallow-copy args to avoid mutating caller's object
      const safeArgs = { ...ctx.args };
      ctx.args = safeArgs;
      const schema = def.inputSchema as {
          required?: string[];
          properties?: Record<string, { type?: string; [key: string]: unknown }>;
          [key: string]: unknown;
        };
      const required: string[] = schema.required ?? [];
      if (required.length === 0) return { passed: true };

      const missing = required.filter(name => {
        const val = safeArgs[name];
        return val === undefined || val === null || val === '';
      });
      if (missing.length === 0) return { passed: true };

      const props = schema.properties ?? {};
      // Note: enum-typed params (type:'string' + enum:[...]) are already covered by this
      // check since their base type is 'string'. However, oneOf/anyOf compound types are
      // NOT supported — elicitation skips them to avoid complex schema resolution.
      const primitiveMissing = missing.filter(name => {
        const prop = props[name];
        if (!prop) return false;
        const type = prop.type;
        return type === 'string' || type === 'number' || type === 'boolean';
      });
      if (primitiveMissing.length === 0) {
        // F-14: 到此处 missing.length > 0(第140行保证)但全是非 primitive(无 type/联合类型),
        // 无法 elicit 也不能绕过必需校验——直接报错(当前 common-schemas 字段都有 type,此分支不可达,防御性)
        return {
          rejected: true,
          error: {
            content: [{ type: 'text' as const, text: JSON.stringify({
              success: false,
              error: `Missing required parameter(s): ${missing.join(', ')}`,
              error_code: 'MISSING_PARAM',
              missing_params: missing,
            }) }],
            isError: true,
          },
        };
      }

      if (elicitFn) {
        const requestedSchema: RequestedSchema = {
          type: 'object',
          properties: Object.fromEntries(
            primitiveMissing.map(p => [p, props[p] ?? { type: 'string' }]),
          ),
          required: primitiveMissing,
        };
        const elicited = await elicitFn(
          requestedSchema,
          `Tool "${ctx.toolName}" missing required parameter(s)`,
        );
        if (elicited) {
          for (const [key, val] of Object.entries(elicited)) {
            // P1 修复（2026-07-10 审查）：原条件含 !(key in safeArgs)，当客户端对 required primitive
            // 传 null/'' 占位（key 存在但空）时，missing 判定(:137) 触发 elicit，但 apply 时 key 已存在
            // 导致用户填入的真实值被静默丢弃、工具仍用空值执行。primitiveMissing 已是「空值或真缺失」的
            // 并集，elicitFn 返回值应直接覆盖，无需 key 存在性守卫（有效非空值不在 primitiveMissing 内）。
            if (primitiveMissing.includes(key)) safeArgs[key] = val;
          }
          return { passed: true };
        }
      }

      return {
        rejected: true,
        error: {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Missing required parameter(s): ${primitiveMissing.join(', ')}`,
            error_code: 'MISSING_PARAM',
            missing_params: primitiveMissing,
          }) }],
          isError: true,
        },
      };
    },
  };
}

// ─── Rate Limit Middleware (IMPORTANT-5) ──────────────────────────────────────

/**
 * 全局 rate limit 中间件。防 AI 失控循环调用(execute_gdscript/read_scene 等)
 * 耗尽 CPU/IO/子进程槽。固定窗口计数:windowMs 内最多 maxPerWindow 次,超限拒绝。
 * 属软限(防失控循环,非硬 DoS 防护——后者需容器级隔离)。默认 60 次/秒,可按部署调整。
 */
export function createRateLimitMiddleware(
  maxPerWindow: number = 60,
  windowMs: number = 1000,
): Middleware {
  let windowStart: number = Date.now();
  let count: number = 0;
  return {
    name: 'rate-limit',
    before: async () => {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      count++;
      if (count > maxPerWindow) {
        getLogger().warn('middleware', `Rate limit exceeded: ${count}/${maxPerWindow} per ${windowMs}ms`);
        // 2026-09-20 可靠性批任务③: 原裸文本 errorResult('RATE_LIMITED: ...') 与全局
        // opsErrorResult 结构化口径(error_code/retryable/suggestion)不一致,客户端无法
        // 程序化消费。retryable=true(瞬态限流,稍候即恢复);对齐 tool-errors.ts RateLimitError。
        return {
          rejected: true,
          error: opsErrorResult('RATE_LIMIT',
            `超过 ${maxPerWindow} 次/${windowMs}ms 调用上限。AI 调用循环可能失控,请检查流程。`,
            {
              retryable: true,
              errorCategory: 'guard',
              suggestion: `Wait ~${Math.ceil(windowMs / 1000)}s for the window to reset, then retry; if repeated, check the agent loop.`,
            }),
        };
      }
      return { passed: true };
    },
  };
}
