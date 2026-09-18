// src/tools/shared/ops-runner.ts
// ops 工具 action-switch 尾部执行样板收敛(2026-09-18 重复分析,原 10 文件各自内联)。
// errorMapper 是各工具的真实差异,保留在调用方;此处只统一 execute→parse→warn 链。
import type { ToolResult } from '../../types.js';
import { executeGdscriptRuntime, executeGdscriptTrusted } from '../../gdscript-executor.js';
import { parseGdscriptResult } from '../../core/shared/errors.js';
import { appendRuntimePersistWarning } from './persistence-warning.js';

export interface RunOpsScriptOptions {
  godot: string;
  projectPath: string;
  script: string;
  loadAutoloads: boolean;
  errorMapper: (msg: string) => string;
  /** appendRuntimePersistWarning 的 action 参数(持久化提示中引用的 action 名) */
  action: string;
  /** 不传则用 executeGdscript 内部默认(解构默认 30s) */
  timeoutSec?: number;
  paramWarnings?: string[];
  /** true 时包 appendRuntimePersistWarning(运行时改动不落盘提示);
   *  条件 warn 的工具(physics/navigation 按 PERSIST_ACTIONS 集合判定)传计算值 */
  warnRuntimePersist?: boolean;
  /** parseGdscriptResult 第 4 参(errorOpts.suggestion),仅 node-3d-ops 使用 */
  errorOpts?: { suggestion?: string };
  /** true 走 executeGdscriptTrusted(全沙箱豁免,uid-ops 写 .uid 需 FileAccess.WRITE);
   *  默认 false = executeGdscriptRuntime 通道(仅跳 Phase 3,保留危险 API 正则防线) */
  trusted?: boolean;
}

export async function runOpsScript(opts: RunOpsScriptOptions): Promise<ToolResult> {
  const execute = opts.trusted ? executeGdscriptTrusted : executeGdscriptRuntime;
  // timeout 兜底 30 与 executeGdscript 内部解构默认(timeout = 30)一致;
  // 类型上 ExecuteGdscriptOptions.timeout 必填,无法用条件 spread 表达"省略"。
  const result = await execute({
    godotPath: opts.godot,
    projectPath: opts.projectPath,
    code: opts.script,
    timeout: opts.timeoutSec ?? 30,
    loadAutoloads: opts.loadAutoloads,
  });
  const parsed = parseGdscriptResult(result, opts.paramWarnings ?? [], opts.errorMapper, opts.errorOpts);
  return opts.warnRuntimePersist
    ? appendRuntimePersistWarning(parsed, opts.action)
    : parsed;
}
