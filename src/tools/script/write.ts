// script 工具 write_script action 实现。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import { existsSync, writeFileSync } from 'fs';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { ensureDir } from '../../core/fs-atomic.js';
import { lintGDScript, formatLintResults } from '../gdscript-lint.js';
import { getTemplateSuggestion } from '../code-templates.js';
import { opsErrorResult } from '../shared.js';
import { pluginSelfPathGuard } from '../shared/file-guard.js';
import { checkTextResourceGuard, ensureClassNameImport, scanScriptSandboxOrThrow } from './shared.js';

export async function writeScript(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const scriptPath = args.script_path as string;
  const projectPath = requireProjectPath(args);
  const sp = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
  // P1-2 FileGuard: 拒写插件自资产(bridge 脚本/editor 插件源码,防自毁防御)
  const selfGuardW = pluginSelfPathGuard(sp);
  if (selfGuardW) return selfGuardW;
  const content = args.content as string;
  const overwrite = args.overwrite === true; // default false

  if (existsSync(sp) && !overwrite) {
    return opsErrorResult('FILE_EXISTS', `File already exists: ${sp}. Set overwrite=true to replace it.`);
  }

  const textGuard = await checkTextResourceGuard(ctx, sp);
  if (textGuard) return textGuard;

  // SEC-P1-1: write_script 扫沙箱(对齐 execute_gdscript,防 @tool/OS.execute 脚本写入)
  const sandboxGuard = scanScriptSandboxOrThrow(content, sp);
  if (sandboxGuard) return sandboxGuard;

  ensureDir(sp);
  writeFileSync(sp, content, 'utf-8');

  // M6: 提取为 ensureClassNameImport(与 edit_script 共用,Imp-8 补齐 edit_script)。contentBefore=null 表示新文件。
  const importSection = await ensureClassNameImport(projectPath, sp, null, content, ctx);

  let lintSection = '';
  let templateHint = '';
  if (sp.endsWith('.gd')) {
    const lintOutput = lintGDScript(content);
    lintSection = formatLintResults(lintOutput);

    const allIssues = [...lintOutput.errors, ...lintOutput.warnings];
    if (allIssues.length > 0) {
      const suggestions = new Set<string>();
      for (const issue of allIssues) {
        const suggestion = getTemplateSuggestion(issue.rule);
        if (suggestion) {
          const preview = suggestion.split('\n').slice(0, 3).join('\n');
          suggestions.add(`  (${issue.rule}) → 建议:\n    ${preview}\n    ... (完整模板见 templates(action=list))`);
        }
      }
      if (suggestions.size > 0) {
        templateHint = '\n\nTemplate suggestions:\n' + [...suggestions].join('\n');
      }
    }
  }
  return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${importSection}${lintSection}${templateHint}`);
}
