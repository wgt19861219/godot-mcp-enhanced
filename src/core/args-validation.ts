// src/core/args-validation.ts — 工具参数强校验原语
// W5(2026-09-20 可维护性批2): 原住 src/helpers.ts 废弃桶(I-ARCH-03 拆分遗留),
// 安家至 core 供 tools/core 两层共用(ToolDispatcher 与各工具模块均引用)。
// 函数体与语义零变化,纯搬家。
import { basename } from 'path';
import { validatePath, isPathInAllowedRoots, describeAllowedRoots } from './path-utils.js';
import { PathError } from './tool-errors.js';

/** Require a non-empty string from tool args. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${key} must be a non-empty string, got: ${v === undefined ? 'undefined' : v === null ? 'null' : JSON.stringify(v)}`);
  }
  return v;
}

/** Require a finite number from tool args. */
export function requireNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${key} is required and must be a number`);
  }
  // F-15: 拒绝空串/纯空白(Number("")=0 会静默改变数值语义);hex/科学计数仍接受为合法数字
  if (typeof v === 'string' && v.trim() === '') {
    throw new Error(`${key} must be a finite number, got: ${JSON.stringify(v)}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a finite number, got: ${JSON.stringify(v)}`);
  }
  return n;
}

/** Convenience: require and validate project_path in one call. */
export function requireProjectPath(args: Record<string, unknown>): string {
  const resolved = validatePath(requireString(args, 'project_path'));
  if (!isPathInAllowedRoots(resolved)) {
    // 审查 I-D(2026-09-03): 原生 Error 被 classifyError 兜底成笼统 'Internal error'(INTERNAL)——
    // screenshot capture 越权走此路径时正是反馈 2026-08-19 描述的误导形态(同工具行为分裂);
    // 且消息外传 resolved 绝对路径(违 P2-17)。收口 PathError(结构化 PATH_NOT_ALLOWED,
    // safeMessage 外传),消息对齐 screenshot throwPathNotAllowed 模式(basename+同源 roots+指引)。
    throw new PathError(
      `project_path is outside allowed project roots: ${basename(resolved)}. Allowed roots: ${describeAllowedRoots()}. ` +
      'Fix: move the project under an allowed root, or extend ALLOWED_PROJECT_PATHS (semicolon-separated).');
  }
  return resolved;
}
