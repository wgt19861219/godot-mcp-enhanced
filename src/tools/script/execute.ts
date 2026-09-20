// script 工具 execute_gdscript action 实现。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { maybeWrapUntrusted } from '../../core/untrusted-wrap.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { executeGdscript } from '../../gdscript-executor.js';
import { validateTimeout } from '../shared.js';
import { opsErrorResult } from '../shared.js';

export async function executeGdscriptAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const projectPath = requireProjectPath(args);
  const code = args.code as string;
  // I-01: validate code is a non-empty string before passing to wrapSnippet
  if (!code || typeof code !== 'string') {
    return opsErrorResult('INVALID_PARAMS', 'code must be a non-empty string.');
  }
  const timeout = validateTimeout(args.timeout);
  // undefined → 让 executeGdscript 自动检测 autoload；显式 true/false 直接传递
  const loadAutoloads = args.load_autoloads === undefined ? undefined : (args.load_autoloads as boolean);
  const godot = await ctx.findGodot();

  const result = await executeGdscript({
    godotPath: godot,
    projectPath,
    code,
    timeout,
    loadAutoloads,
  });

  // 全仓审查 M-3 (2026-09-12): 项目文件内容被用户 GDScript 读取后经 _mcp_output/print
  // 回传,是 P1-1 声明威胁模型(项目文件内藏提示注入)的间接读通道——outputs 值与
  // raw_output 过信封包装(对齐 workflow.ts dev_loop 的同款处理),execute 通道不再裸吐。
  if (Array.isArray(result.outputs)) {
    result.outputs = result.outputs.map((o) =>
      o && typeof o === 'object'
        ? { ...o, value: maybeWrapUntrusted('gdscript.execute', o.key || 'output', String(o.value ?? '')) }
        : o,
    );
  }
  if (typeof result.raw_output === 'string' && result.raw_output) {
    result.raw_output = maybeWrapUntrusted('gdscript.execute', 'raw_output', result.raw_output);
  }

  let output = JSON.stringify(result, null, 2);
  if (result.autoload_detected && result.autoload_detected.length > 0) {
    const names = result.autoload_detected.join(', ');
    output = `ℹ️ Auto-detected autoload usage (${names}). Enabled load_autoloads=true automatically.\n\n${output}`;
  }
  return textResult(output);
}
