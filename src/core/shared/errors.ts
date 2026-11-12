// Error handling and result construction utilities.

import type { ExecuteGdscriptResult } from '../../gdscript-executor.js';
import { textResult, errorResult } from '../../types.js';
import type { ToolResult } from '../../types.js';

/** Common error codes shared across tool modules. */
export const COMMON_ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
} as const;

export const NON_PERSIST = '运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。';

export function opsSuccess(data: unknown, warnings: string[] = []) {
  return { success: true, data, warnings };
}

export function opsError(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string; retryable?: boolean; errorCategory?: string; traceId?: string },
) {
  return {
    success: false,
    error: message,
    error_code: errorCode,
    warnings: [] as string[],
    ...(opts?.suggestion ? { suggestion: opts.suggestion } : {}),
    // G2: 结构化错误三元组(借鉴 xulek _err)。errorCategory 是结构化枚举(非 err.message 文本),
    // 无 PII 外传风险 — 见 tool-errors.ts PII 护栏。
    ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
    ...(opts?.errorCategory ? { error_category: opts.errorCategory } : {}),
    ...(opts?.traceId ? { trace_id: opts.traceId } : {}),
  };
}

export function opsErrorResult(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string; retryable?: boolean; errorCategory?: string; traceId?: string },
): ToolResult {
  return errorResult(JSON.stringify(opsError(errorCode, message, opts)));
}

/**
 * Task D4 (2026-11-12): 把 executor 解析出的引擎错误行（result.errors，error-analyzer
 * 从 stderr 解析的结构化 ParsedError）拼进错误消息——此前 parseGdscriptResult 只透传
 * compile_error/run_error/entry.value，errors 整组丢弃，场景绑脚本编译失败时调用方
 * 只剩裸 "Failed to load scene"，引擎原始错误行（哪个 .gd 哪行什么错）不可见。
 * 上限 5 行防刷屏，超出附溢出计数；空/缺省数组返回空串（消息保持原样，不拼空段——
 * 兼容测试/调用方不传 errors 的极简对象形态）。
 */
function formatEngineErrorLines(errors: ExecuteGdscriptResult['errors'] | undefined, max = 5): string {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const lines = errors.slice(0, max).map((e) => {
    const loc = e.file ? `${e.file}${e.line !== undefined ? `:${e.line}` : ''}` : '';
    return loc ? `${loc}: ${e.message}` : e.message;
  });
  const overflow = errors.length > max ? `\n  (+${errors.length - max} more)` : '';
  return `\nEngine error output (first ${lines.length} line(s), parsed from stderr):\n  ${lines.join('\n  ')}${overflow}`;
}

export function parseGdscriptResult(
  result: ExecuteGdscriptResult,
  paramWarnings: string[] = [],
  errorMapper: (errorMsg: string) => string = () => 'SCRIPT_EXEC_FAILED',
  errorOpts?: { suggestion?: string },
): ToolResult {
  // Task D4: 三个失败分支统一拼引擎错误行（compile/run/errorMapper——如 LOAD_FAILED）
  const engineLines = formatEngineErrorLines(result.errors);
  if (!result.compile_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.compile_error + engineLines, errorOpts);
  }
  if (!result.run_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.run_error + engineLines, errorOpts);
  }

  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const entry of result.outputs) {
    if (entry.key === 'warning') {
      warnings.push(String(entry.value));
    } else if (entry.key === 'error') {
      const errCode = errorMapper(String(entry.value));
      return opsErrorResult(errCode, String(entry.value) + engineLines, errCode === 'NODE_NOT_FOUND' ? errorOpts : undefined);
    } else {
      try {
        data[entry.key] = JSON.parse(entry.value);
      } catch {
        warnings.push(`Output key "${entry.key}" is not valid JSON, stored as raw string`);
        data[entry.key] = entry.value;
      }
    }
  }

  return textResult(JSON.stringify(opsSuccess(data, [...paramWarnings, ...warnings])));
}
