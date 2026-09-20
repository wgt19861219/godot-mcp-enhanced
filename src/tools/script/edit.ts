// script 工具 edit_script action 实现（含该 action 专属的缩进检测/重复行检测/验证回滚 helpers）。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { basename } from 'path';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { writeFileAtomic } from '../../core/fs-atomic.js';
import { batchValidateScripts } from '../validation.js';
import { lintGDScript, formatLintResults } from '../gdscript-lint.js';
import { opsErrorResult } from '../shared.js';
import { pluginSelfPathGuard } from '../shared/file-guard.js';
import { runDotnetBuild } from '../shared/validation.js';
import { getLogger } from '../../core/logger.js';
import { checkTextResourceGuard, ensureClassNameImport, scanScriptSandboxOrThrow } from './shared.js';

const execFileAsync = promisify(execFile);

function detectDuplicateLines(lines: string[]): string[] {
  const warnings: string[] = [];
  let runStart = -1;
  for (let i = 1; i <= lines.length; i++) {
    const cur = i < lines.length ? lines[i]!.trim() : '';
    const prev = lines[i - 1]!.trim();
    if (cur.length > 10 && cur === prev && (cur.includes('(') || cur.includes('='))) {
      if (runStart < 0) runStart = i - 1;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        warnings.push(`Duplicate block (lines ${runStart + 1}-${i}): "${prev.substring(0, 80)}"`);
      }
      runStart = -1;
    }
  }
  return warnings;
}

function formatDuplicateWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `\n\n⚠ Warning: ${warnings.length} duplicate line(s) detected (possible copy-paste error):\n${warnings.map(w => `  ${w}`).join('\n')}`;
}

function joinWithLineEnding(content: string, hasCRLF: boolean): string {
  if (!hasCRLF) return content;
  return content.split('\n').join('\r\n');
}

async function validateAndRevert(
  fullPath: string,
  rawFile: string,
  godotPath: string,
  projectPath: string,
  contextInfo?: string
): Promise<string | null> {
  try {
    const valResult = await batchValidateScripts(godotPath, projectPath, [fullPath], 15000);
    // Godot 不可用 / 验证基础设施失败 → 无法判定脚本正确性,不回滚。
    // batchValidateScripts 在 spawn 失败、验证器超时或基础设施错误时返回
    // [{file:'<validator>'|'<validator:spawn>'|..., errors:[...]}](file 以 '<' 开头),
    // 这些不代表脚本本身有 GDScript parse error。若不拦截,下方 errors.length>0 会
    // 误判并回滚正确修改(Godot 未安装时所有 edit_script 都会被静默回滚并谎报 parse error)。
    // 只有 file 为真实脚本路径(rel)且含 Parse Error 时才回滚。
    const infraFailure = valResult.length > 0 && valResult[0]!.file.startsWith('<');
    if (infraFailure) {
      return `⚠️ Validation skipped (Godot unavailable): ${valResult[0]!.errors[0] ?? 'validator did not run'}\nEdit was applied but not validated.`;
    }
    if (valResult.length > 0 && valResult[0]!.errors.length > 0) {
      try {
        writeFileSync(fullPath, rawFile, 'utf-8');
      } catch (rollbackErr) {
        return `⚠️ CRITICAL: Parse error detected AND rollback failed!\n` +
          `Parse errors:\n  ${valResult[0]!.errors.join('\n  ')}\n` +
          `Rollback error: ${rollbackErr}\n` +
          `File may be in a corrupted state: ${fullPath}`;
      }
      // 尝试解析结构化错误信息
      const parsed = parseGodotErrors(valResult[0]!.errors);
      let errorLines: string;
      if (parsed.length > 0) {
        errorLines = parsed.map(e => {
          let line = `  Line ${e.line}: ${e.message}`;
          if (e.identifier) line += ` (${e.identifier})`;
          return line;
        }).join('\n');
      } else {
        // 回退到原始格式
        errorLines = valResult[0]!.errors.map(e => `  ${e}`).join('\n');
      }

      return `⚠️ Edit REVERTED due to GDScript parse error:\n` +
        errorLines +
        `\n\nOriginal file restored. Please fix the edit content and retry.` +
        (contextInfo ? `\n\n--- Attempted change ---\n${contextInfo}` : '');
    }
  } catch (e) {
    return `⚠️ Validation skipped (Godot unavailable): ${(e as Error).message}\nEdit was applied but not validated.`;
  }
  return null;
}

/**
 * C# edit_script 验证回滚：调 dotnet build,失败则回滚。
 * 与 validateAndRevert(GDScript)平行,但错误处理更粗粒度(不做行号解析,
 * dotnet 输出格式解析是老规划阶段二的 L 工作量)。
 *
 * 优雅降级:无 .csproj / dotnet CLI 不可用时返回 skipNote(不阻断编辑)。
 */
async function csharpValidateAndRevert(
  fullPath: string,
  rawFile: string,
  projectPath: string
): Promise<string | null> {
  // 检测 .csproj 存在
  // 注：existsSync 不展开 glob，早期版本误用 existsSync(join(projectPath, '*.csproj'))
  // 永远返 false（死代码），实际靠 readdirSync 兜底。2026-08-06 审查 P2 删死代码。
  const csprojExists = readdirSync(projectPath).some(f => f.endsWith('.csproj'));
  if (!csprojExists) {
    return null; // 无 .csproj,无法验证,不阻断(调用方显示 skipNote)
  }

  // 2026-08-06 审查 P1 修复：dotnet build 执行任意 MSBuild <Target>/.csproj 预构建步骤
  // = 任意代码执行面（与 execute_gdscript 同威胁），须对称走 action-gate opt-in。
  // 默认拒（无 GODOT_MCP_PRIVILEGED_GROUPS=code-execution 时 skip build），对齐 action-gate 哲学。
  // 旁路：设 GODOT_MCP_PRIVILEGED_GROUPS=code-execution（或 all）显式授权。
  const privilegedGroups = process.env.GODOT_MCP_PRIVILEGED_GROUPS;
  const codeExecAllowed = privilegedGroups === 'all'
    || (privilegedGroups ?? '').split(',').map(s => s.trim()).includes('code-execution');
  if (!codeExecAllowed) {
    getLogger().warn('security',
      `C# dotnet build skipped (not gated): GODOT_MCP_PRIVILEGED_GROUPS lacks 'code-execution'. ` +
      `Set GODOT_MCP_PRIVILEGED_GROUPS=code-execution to enable dotnet build validation (note: MSBuild targets can execute arbitrary code).`);
    return null; // 未 opt-in 时 skip（不阻断编辑，但也不跑 build）
  }

  try {
    const result = await runDotnetBuild(projectPath, execFileAsync as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>);
    if (result.ok) {
      return null; // build 成功（或 dotnet 不在 PATH 时 skipped）
    }
    // build 失败 → 原子回滚（tmp+rename，2026-08-06 审查 P2 修复：原 writeFileSync 直写非原子，
    // 回滚中途崩溃会留半截损坏文件）
    try {
      const tmpPath = fullPath + '.mcp-rollback-tmp';
      writeFileSync(tmpPath, rawFile, 'utf-8');
      renameSync(tmpPath, fullPath);
    } catch (rollbackErr) {
      return `⚠️ CRITICAL: C# build error detected AND rollback failed!\n` +
        `Rollback error: ${rollbackErr}\nFile may be in a corrupted state: ${fullPath}`;
    }
    const output = result.output;
    // 截取关键错误行(MSBuild error/warning 行),保留前 1500 字符
    const errorSection = output.split('\n').filter(l => /error|Error|FAILED/.test(l)).join('\n');
    const trimmed = (errorSection || output).substring(0, 1500);
    return `⚠️ Edit REVERTED due to C# build error:\n  ${trimmed.split('\n').join('\n  ')}\n\nOriginal file restored. Please fix the edit content and retry.`;
  } catch (e: unknown) {
    // runDotnetBuild 内部已 catch，此处防御性兜底
    return `⚠️ Unexpected error during C# validation: ${(e as Error).message}`;
  }
}

// ─── GDScript error parsing (best-effort) ────────────────────────────────────

interface ParseErrorDetail {
  line: number;
  message: string;
  type: 'parse_error' | 'script_error';
  /** 标识符名称（best-effort 提取，可能为空） */
  identifier?: string;
}

/**
 * 解析 Godot 验证错误输出。标识符提取是 best-effort，
 * 提取失败不阻塞主要错误消息展示。
 */
function parseGodotErrors(rawErrors: string[]): ParseErrorDetail[] {
  const details: ParseErrorDetail[] = [];
  for (const err of rawErrors) {
    const match = err.match(/:(\d+)\s*-\s*(Parse Error|Script Error):\s*(.*)/);
    if (match) {
      const detail: ParseErrorDetail = {
        line: parseInt(match[1]!),
        message: match[3]!,
        type: match[2]! === 'Parse Error' ? 'parse_error' : 'script_error',
      };
      // best-effort 标识符提取
      const identMatch =
        match[3]!.match(/identifier "([^"]+)"/i) ||
        match[3]!.match(/"(\w+)" not declared/i) ||
        match[3]!.match(/Unexpected identifier:\s*"(\w+)"/i);
      if (identMatch) {
        detail.identifier = identMatch[1]!;
      }
      details.push(detail);
    }
  }
  return details;
}

// ─── Indent detection (heuristic — GDScript typically uses tabs or 2/4 spaces) ──

interface IndentStyle {
  type: 'tab' | 'space';
  size: number;
}

/**
 * 检测文件缩进风格。只统计有实际缩进（>0）的行，排除空行和 0 级缩进行。
 * 注意：这是启发式算法，非严格 GCD。对 3/6 空格交替等极端情况可能推断错误，
 * 但 GDScript 几乎只用 tab 或 2/4 空格，99% 场景正确。
 */
function detectIndentStyle(lines: string[]): IndentStyle {
  let tabCount = 0;
  let spaceCount = 0;
  const spaceSizes: number[] = [];

  const sampleLines = lines.slice(0, 100);
  for (const line of sampleLines) {
    if (line.trim().length === 0) continue;
    const leadingMatch = line.match(/^(\s+)/);
    if (!leadingMatch) continue;

    // 只统计有实际缩进的行（缩进长度 > 0 已经由 leadingMatch 保证）
    const leading = leadingMatch[1]!;
    if (leading.includes('\t')) {
      tabCount++;
    } else {
      spaceCount++;
      spaceSizes.push(leading.length);
    }
  }

  if (tabCount >= spaceCount) {
    return { type: 'tab', size: 1 };
  }

  // 计算最常见的空格缩进大小，推断单个缩进级别
  const sizeCounts = new Map<number, number>();
  for (const s of spaceSizes) {
    sizeCounts.set(s, (sizeCounts.get(s) || 0) + 1);
  }
  const sorted = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const commonSize = sorted[0]?.[0] ?? 4;
  // 启发式：bucket 到 2/4/8
  const indentSize = commonSize <= 2 ? 2 : (commonSize <= 4 ? 4 : 8);

  return { type: 'space', size: indentSize };
}

/**
 * 将文本的行首缩进归一化为目标风格。
 * search 文本可能来自 AI（空格缩进），但目标文件用 tab 缩进（或反过来）。
 * 逐行检测行首空白并转换：tab→目标大小空格，或空格→tab。
 */
function normalizeIndentForMatch(text: string, targetStyle: IndentStyle): string {
  const lines = text.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const leadingMatch = line.match(/^(\s+)/);
    if (!leadingMatch || line.trim().length === 0) {
      result.push(line);
      continue;
    }
    const leading = leadingMatch[1]!;
    // 计算缩进级别：tab 算 1 级，空格按 4 空格推断级别
    // 已知简化：混合 tab+space 行首时忽略空格部分，GDScript 中极少见
    let levels: number;
    if (leading.includes('\t')) {
      levels = leading.split('\t').length - 1;
    } else {
      levels = Math.round(leading.length / 4) || 1;
    }
    const targetIndent = targetStyle.type === 'tab'
      ? '\t'.repeat(levels)
      : ' '.repeat(levels * targetStyle.size);
    result.push(targetIndent + line.trimStart());
  }
  return result.join('\n');
}

export async function editScript(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const scriptPath = args.script_path as string;
  const projectPath = requireProjectPath(args);
  const fullPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
  // P1-2 FileGuard: 拒写插件自资产
  const selfGuardE = pluginSelfPathGuard(fullPath);
  if (selfGuardE) return selfGuardE;

  if (!existsSync(fullPath)) {
    return opsErrorResult('NOT_FOUND', `File not found: ${fullPath}`, {
      suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
    });
  }

  const textGuard = await checkTextResourceGuard(ctx, fullPath);
  if (textGuard) return textGuard;

  const rawFile = readFileSync(fullPath, 'utf-8');
  const hasCRLF = rawFile.includes('\r\n');
  const lines = rawFile.split(/\r?\n/);
  const autoValidate = args.auto_validate !== false;

  let godotPath: string | null = null;
  const isCsharp = fullPath.endsWith('.cs');
  if (autoValidate && fullPath.endsWith('.gd')) {
    try {
      godotPath = await ctx.findGodot();
    } catch {
      godotPath = null;
    }
  }

  // search_and_replace mode
  if (args.search_and_replace && typeof args.search_and_replace === 'object') {
    const sr = args.search_and_replace as { search: string; replace: string; occurrence?: number };
    if (!sr.search) {
      return opsErrorResult('INVALID_PARAMS', 'search_and_replace.search must be a non-empty string.');
    }
    const normalizedContent = rawFile.replace(/\r\n/g, '\n');
    let normalizedSearch = sr.search.replace(/\r\n/g, '\n');
    let normalizedReplace = sr.replace.replace(/\r\n/g, '\n');

    // Tab/Space 归一化：如果直接匹配失败，尝试按文件缩进风格重试
    if (!normalizedContent.includes(normalizedSearch)) {
      const fileIndent = detectIndentStyle(normalizedContent.split('\n'));
      const searchIndent = detectIndentStyle(normalizedSearch.split('\n'));
      if (fileIndent.type !== searchIndent.type) {
        const candidateSearch = normalizeIndentForMatch(normalizedSearch, fileIndent);
        if (normalizedContent.includes(candidateSearch)) {
          normalizedSearch = candidateSearch;
          normalizedReplace = normalizeIndentForMatch(normalizedReplace, fileIndent);
        }
      }
    }

    const occurrence = sr.occurrence ?? 1;
    let searchIndex = -1;
    let foundCount = 0;

    if (occurrence === 0) {
      if (!normalizedContent.includes(normalizedSearch)) {
        // P2-17(2026-08-21 七维度审核): 不回显 resolve 后的绝对路径,报文件名
        return opsErrorResult('NOT_FOUND', `search_and_replace: search text not found in ${basename(fullPath)}`);
      }
      const newFileContent = normalizedContent.replaceAll(normalizedSearch, normalizedReplace);
      const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
      // SEC-P1-1: edit_script 全量替换扫沙箱(扫描替换后的完整内容)
      const sandboxGuard = scanScriptSandboxOrThrow(finalContent, fullPath);
      if (sandboxGuard) return sandboxGuard;
      // A-ATOMIC (2026-09-01): 覆盖用户 .gd 走原子写(此前直写,进程崩溃/断电窗口
      // 半写;validateAndRevert 只兜"验证失败回滚",不兜崩溃)
      writeFileAtomic(fullPath, finalContent);

      if (godotPath) {
        const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
        if (revertMsg) return textResult(revertMsg);
      }
      if (isCsharp && autoValidate) {
        const revertMsg = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
        if (revertMsg) return textResult(revertMsg);
      }

      const count = normalizedContent.split(normalizedSearch).length - 1;

      const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
      const dw = formatDuplicateWarnings(dupWarns);

      let editLintSection = '';
      if (fullPath.endsWith('.gd')) {
        const editedContent = readFileSync(fullPath, 'utf-8');
        editLintSection = formatLintResults(lintGDScript(editedContent));
      }

      // M6 (Imp-8): class_name 新增/变化时重建 cache(与 write_script 一致)
      const importSection = await ensureClassNameImport(projectPath, fullPath, rawFile, finalContent, ctx);

      return textResult(`Edited ${fullPath}: replaced all ${count} occurrences of search text.${dw}${editLintSection}${importSection}`);
    }

    let pos = 0;
    while (pos < normalizedContent.length) {
      const idx = normalizedContent.indexOf(normalizedSearch, pos);
      if (idx === -1) break;
      foundCount++;
      if (foundCount === occurrence) {
        searchIndex = idx;
        break;
      }
      pos = idx + 1;
    }

    if (searchIndex === -1) {
      return opsErrorResult('NOT_FOUND', `search_and_replace: occurrence ${occurrence} not found (found ${foundCount} total matches in ${fullPath})`);
    }

    const before = normalizedContent.substring(0, searchIndex);
    const after = normalizedContent.substring(searchIndex + normalizedSearch.length);
    const newFileContent = before + normalizedReplace + after;
    const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
    // SEC-P1-1: edit_script 单 occurrence 替换扫沙箱(扫描替换后的完整内容)
    const sandboxGuard = scanScriptSandboxOrThrow(finalContent, fullPath);
    if (sandboxGuard) return sandboxGuard;
    writeFileAtomic(fullPath, finalContent);  // A-ATOMIC: 覆盖用户 .gd 原子写

    if (godotPath) {
      const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
      if (revertMsg) return textResult(revertMsg);
    }
    if (isCsharp && autoValidate) {
      const revertMsg = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
      if (revertMsg) return textResult(revertMsg);
    }

    const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
    const dw = formatDuplicateWarnings(dupWarns);

    let editLintSection = '';
    if (fullPath.endsWith('.gd')) {
      const editedContent = readFileSync(fullPath, 'utf-8');
      editLintSection = formatLintResults(lintGDScript(editedContent));
    }

    // M6 (Imp-8): class_name 新增/变化时重建 cache(与 write_script 一致)
    const importSection = await ensureClassNameImport(projectPath, fullPath, rawFile, finalContent, ctx);

    return textResult(`Edited ${fullPath}: replaced occurrence ${occurrence} of search text (${foundCount} total matches found).${dw}${editLintSection}${importSection}`);
  }

  // Line-number mode
  // I-02: safe numeric conversion instead of raw `as number`
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return opsErrorResult('INVALID_PARAMS', `start_line and end_line must be finite numbers, got start_line=${args.start_line}, end_line=${args.end_line}`);
  }
  const newContent = args.new_content as string;
  const indentMode = (args.indent_mode as string) || 'raw';
  const verifyContent = args.verify_content as string | undefined;

  if (startLine < 1 || endLine < startLine) {
    return opsErrorResult('INVALID_PARAMS', `Invalid line range: start_line=${startLine}, end_line=${endLine}`);
  }

  if (endLine > lines.length) {
    return opsErrorResult('INVALID_PARAMS', `end_line ${endLine} exceeds file length ${lines.length}`);
  }

  const beforeLines = lines.slice(startLine - 1, endLine);

  if (verifyContent !== undefined) {
    const existingContent = beforeLines.join('\n');
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\t/g, '    ').trim();
    if (normalize(existingContent) !== normalize(verifyContent)) {
      return opsErrorResult(
        'CONTENT_MISMATCH',
        `Content verification failed at lines ${startLine}-${endLine}. The file has changed since the line numbers were read.\n` +
        `--- Expected ---\n${verifyContent}\n` +
        `--- Actual ---\n${existingContent}`
      );
    }
  }

  const newLines = newContent.split(/\r?\n/);
  let adjustedLines: string[];

  if (indentMode === 'smart') {
    // 检测文件实际缩进风格（排除 0 级缩进行，只统计有实际缩进的行）
    const indentStyle = detectIndentStyle(lines);

    if (indentStyle.type === 'tab') {
      // 保持现有 tab 逻辑
      const originalLine = lines[startLine - 1] || '';
      const originalBaseIndent = (originalLine.match(/^(\t*)/) || ['',''])[1]!.length;

      const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
      let newMinIndent = Infinity;
      for (const nl of newNonEmptyLines) {
        const tabs = (nl.match(/^(\t*)/) || ['',''])[1]!.length;
        if (tabs < newMinIndent) newMinIndent = tabs;
      }
      if (newMinIndent === Infinity) newMinIndent = 0;

      const indentDelta = originalBaseIndent - newMinIndent;

      adjustedLines = newLines.map((line: string) => {
        if (line.trim() === '') return line;

        const currentTabs = (line.match(/^(\t*)/) || ['',''])[1]!.length;

        if (indentDelta > 0) {
          return '\t'.repeat(indentDelta) + line;
        } else if (indentDelta < 0) {
          const tabsToRemove = Math.min(-indentDelta, currentTabs);
          return line.substring(tabsToRemove);
        }
        return line;
      });
    } else {
      // 空格缩进逻辑
      const originalLine = lines[startLine - 1] || '';
      const originalBaseIndent = (originalLine.match(/^( *)/) || ['',''])[1]!.length;

      const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
      let newMinIndent = Infinity;
      for (const nl of newNonEmptyLines) {
        const spaces = (nl.match(/^( *)/) || ['',''])[1]!.length;
        if (spaces < newMinIndent) newMinIndent = spaces;
      }
      if (newMinIndent === Infinity) newMinIndent = 0;

      const indentDelta = originalBaseIndent - newMinIndent;

      adjustedLines = newLines.map((line: string) => {
        if (line.trim() === '') return line;
        const currentSpaces = (line.match(/^( *)/) || ['',''])[1]!.length;
        if (indentDelta > 0) {
          return ' '.repeat(indentDelta) + line;
        } else if (indentDelta < 0) {
          const toRemove = Math.min(-indentDelta, currentSpaces);
          return line.substring(toRemove);
        }
        return line;
      });
    }
  } else {
    adjustedLines = newLines;
  }

  lines.splice(startLine - 1, endLine - startLine + 1, ...adjustedLines);

  const result = joinWithLineEnding(lines.join('\n'), hasCRLF);
  // SEC-P1-1: edit_script 行号模式扫沙箱(扫描替换后的完整内容)
  const sandboxGuard = scanScriptSandboxOrThrow(result, fullPath);
  if (sandboxGuard) return sandboxGuard;
  writeFileAtomic(fullPath, result);  // A-ATOMIC: 覆盖用户 .gd 原子写

  if (godotPath) {
    const ctxInfo = `Lines ${startLine}-${endLine}:\n${beforeLines.join('\n')}\n→\n${adjustedLines.join('\n')}`;
    const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath, ctxInfo);
    if (revertMsg) return textResult(revertMsg);
  }
  if (isCsharp && autoValidate) {
    const revertMsg = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
    if (revertMsg) return textResult(revertMsg);
  }

  const afterLines = adjustedLines;
  const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines)`;
  const diffBody = `--- Before ---\n${beforeLines.join('\n')}\n--- After ---\n${afterLines.join('\n')}`;

  const contextBefore = lines.slice(Math.max(0, startLine - 3), startLine - 1);
  const contextAfterStart = startLine - 1 + adjustedLines.length;
  const contextAfter = lines.slice(contextAfterStart, contextAfterStart + 2);
  const ctxBefore = contextBefore.length > 0 ? `\n--- Context (before) ---\n${contextBefore.join('\n')}` : '';
  const ctxAfter = contextAfter.length > 0 ? `\n--- Context (after) ---\n${contextAfter.join('\n')}` : '';

  const warnings = formatDuplicateWarnings(detectDuplicateLines(lines));
  const skipNote = (autoValidate && !fullPath.endsWith('.gd') && !fullPath.endsWith('.cs'))
    ? "\nNote: Auto-validate only supports .gd (Godot parse) and .cs (dotnet build) files. Other file types are not validated."
    : "";

  let editLintSection = '';
  if (fullPath.endsWith('.gd')) {
    const editedContent = readFileSync(fullPath, 'utf-8');
    editLintSection = formatLintResults(lintGDScript(editedContent));
  }

  // M6 (Imp-8): class_name 新增/变化时重建 cache(与 write_script 一致)
  const importSection = await ensureClassNameImport(projectPath, fullPath, rawFile, result, ctx);

  return textResult(`${diffHeader}\n${diffBody}${ctxBefore}${ctxAfter}${warnings}${skipNote}${editLintSection}${importSection}`);
}
