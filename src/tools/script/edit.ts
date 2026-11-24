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

/** validateAndRevert 输出(Task D1, 2026-11-12):
 * - reverted=true: 检测到 GDScript parse error 且已尝试回滚(无论回滚写成败)。
 *   edit_script 必须以错误语义返回(opsErrorResult('EDIT_REVERTED') → isError:true),
 *   不得以成功主语开头——反馈 2026-11-08: 旧实现回滚响应无 error 标志,
 *   调用方(AI)在长上下文里误判"编辑成功但静默回滚未落盘"。
 * - reverted=false: 编辑保留在磁盘上。message 为附注(验证基础设施不可用的
 *   skip note),空串表示无附注。 */
interface ValidateRevertOutcome {
  reverted: boolean;
  message: string;
}

async function validateAndRevert(
  fullPath: string,
  rawFile: string,
  godotPath: string,
  projectPath: string,
  contextInfo?: string
): Promise<ValidateRevertOutcome> {
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
      return {
        reverted: false,
        message: `⚠️ Validation skipped (Godot unavailable): ${valResult[0]!.errors[0] ?? 'validator did not run'}\nEdit was applied but not validated.`,
      };
    }
    if (valResult.length > 0 && valResult[0]!.errors.length > 0) {
      try {
        // D1(2026-11-12): 回滚改原子写(原裸 writeFileSync,回滚中途崩溃会留半截损坏文件,
        // 与主链 A-ATOMIC 写不对称)
        writeFileAtomic(fullPath, rawFile);
      } catch (rollbackErr) {
        return {
          reverted: true,
          message: `⚠️ CRITICAL: Parse error detected AND rollback failed!\n` +
            `Parse errors:\n  ${valResult[0]!.errors.join('\n  ')}\n` +
            `Rollback error: ${rollbackErr}\n` +
            `File may be in a corrupted state: ${fullPath}`,
        };
      }
      // 控制器裁定(2026-11-24): mismatch 文案带成因(parse error 明细),与上方「回滚失败」分支信息量一致
      const rollbackMismatch = rollbackReadbackMessage(
        fullPath,
        rawFile,
        `Parse errors:\n  ${valResult[0]!.errors.join('\n  ')}`,
      );
      if (rollbackMismatch) return { reverted: true, message: rollbackMismatch };
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

      return {
        reverted: true,
        message: `EDIT WAS REVERTED due to GDScript parse error:\n` +
          errorLines +
          `\n\nOriginal file restored. Please fix the edit content and retry.` +
          (contextInfo ? `\n\n--- Attempted change ---\n${contextInfo}` : ''),
      };
    }
    // Task D2 (2026-11-12): MCP_LOAD_NULL 等已降级为 headless_limitations 警告
    // (batchValidateScripts 不再计入 errors → 上述回滚分支不触发,编辑保留)。
    // 此处经 message(skip-note)通道透传警告,防"编辑保留但 load null 信号静默丢失"。
    const loadNullWarns = valResult.flatMap(r => r.headless_limitations ?? []);
    if (loadNullWarns.length > 0) {
      return {
        reverted: false,
        message: `⚠️ Validation warning: ${loadNullWarns.join('\n')}`,
      };
    }
  } catch (e) {
    return {
      reverted: false,
      message: `⚠️ Validation skipped (Godot unavailable): ${(e as Error).message}\nEdit was applied but not validated.`,
    };
  }
  return { reverted: false, message: '' };
}

/** D1(2026-11-12): 写后回读校验——writeFileAtomic 落盘后读回磁盘内容与意图内容比对,
 * 不一致(并发修改/降级直写中断等)以 WRITE_VERIFY_FAILED 错误返回,防"谎报已落盘"。
 * @returns opsErrorResult 若回读不一致;null 表示磁盘内容与意图一致。 */
function verifyWriteResult(fullPath: string, expectedContent: string): ToolResult | null {
  const written = readFileSync(fullPath, 'utf-8');
  if (written !== expectedContent) {
    return opsErrorResult(
      'WRITE_VERIFY_FAILED',
      `Post-write verification failed: disk content of ${basename(fullPath)} does not match the intended edit ` +
        `(expected ${expectedContent.length} chars, found ${written.length}). The file may have been modified concurrently.`,
      { suggestion: 'Re-read the file (read_script) and retry the edit.' },
    );
  }
  return null;
}

/** 反馈 11-20 复发条(2026-11-24): 回滚写回读校验——回滚写返回后读盘与原文比对
 * (对齐 verifyWriteResult 的写后回读)。此前两处回滚写(GD writeFileAtomic / C# tmp+rename)
 * 落盘后无回读:回滚写静默失效时响应仍称 "Original file restored",盘上却留着被拒的
 * 新内容——与「回执成功但盘没变」互为反向错位。
 * @param cause 可选成因段(已格式化),插在说明句与结尾行之间——GD 路径传 parse error 明细,
 *   与同函数既有「回滚失败」分支的信息量一致;C# 路径不传(对齐其既有回滚失败分支,不附 build 输出)。
 * @returns null = 盘上内容等于原文;不一致或读盘失败返回 CRITICAL mismatch 文案
 *   (读不到就无法确认回滚生效,同样不得声称已恢复),调用方经 { reverted: true, message } 上抛。 */
function rollbackReadbackMessage(fullPath: string, rawFile: string, cause?: string): string | null {
  let detail: string;
  try {
    const onDisk = readFileSync(fullPath, 'utf-8');
    if (onDisk === rawFile) return null;
    detail = `Rollback write did not take effect: on-disk content of ${basename(fullPath)} is not the original content ` +
      `(expected ${rawFile.length} chars, found ${onDisk.length}).`;
  } catch (readErr) {
    detail = `Rollback could not be confirmed: reading ${basename(fullPath)} back failed (${(readErr as Error).message}).`;
  }
  return `⚠️ CRITICAL: rollback write mismatch!\n${detail}\n` +
    (cause ? `${cause}\n` : '') +
    `File may be in a corrupted state: ${fullPath}`;
}

/**
 * C# edit_script 验证回滚：调 dotnet build,失败则回滚。
 * 与 validateAndRevert(GDScript)平行,但错误处理更粗粒度(不做行号解析,
 * dotnet 输出格式解析是老规划阶段二的 L 工作量)。
 *
 * 返回形态对齐 ValidateRevertOutcome(终审 Important-1, 2026-11-12):
 * reverted=true → 调用方必须 opsErrorResult('EDIT_REVERTED')(isError:true),
 * 与 GDScript 回滚语义对称——旧实现返回裸消息由调用方 textResult,无 error 标志,
 * 调用方(AI)在长上下文里误判"编辑成功但静默回滚未落盘"(与 D1 GDScript 同根因)。
 *
 * 优雅降级:无 .csproj / gate 未放行 / build 成功 → {reverted:false, message:''}
 * (不阻断编辑);意外异常 → {reverted:false, message:警告}(编辑保留在盘上)。
 */
async function csharpValidateAndRevert(
  fullPath: string,
  rawFile: string,
  projectPath: string
): Promise<ValidateRevertOutcome> {
  // 检测 .csproj 存在
  // 注：existsSync 不展开 glob，早期版本误用 existsSync(join(projectPath, '*.csproj'))
  // 永远返 false（死代码），实际靠 readdirSync 兜底。2026-08-06 审查 P2 删死代码。
  const csprojExists = readdirSync(projectPath).some(f => f.endsWith('.csproj'));
  if (!csprojExists) {
    return { reverted: false, message: '' }; // 无 .csproj,无法验证,不阻断
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
    return { reverted: false, message: '' }; // 未 opt-in 时 skip（不阻断编辑，但也不跑 build）
  }

  try {
    const result = await runDotnetBuild(projectPath, execFileAsync as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>);
    if (result.ok) {
      return { reverted: false, message: '' }; // build 成功（或 dotnet 不在 PATH 时 skipped）
    }
    // build 失败 → 原子回滚（tmp+rename，2026-08-06 审查 P2 修复：原 writeFileSync 直写非原子，
    // 回滚中途崩溃会留半截损坏文件）
    try {
      const tmpPath = fullPath + '.mcp-rollback-tmp';
      writeFileSync(tmpPath, rawFile, 'utf-8');
      renameSync(tmpPath, fullPath);
    } catch (rollbackErr) {
      return {
        reverted: true,
        message: `⚠️ CRITICAL: C# build error detected AND rollback failed!\n` +
          `Rollback error: ${rollbackErr}\nFile may be in a corrupted state: ${fullPath}`,
      };
    }
    const rollbackMismatch = rollbackReadbackMessage(fullPath, rawFile);
    if (rollbackMismatch) return { reverted: true, message: rollbackMismatch };
    const output = result.output;
    // 截取关键错误行(MSBuild error/warning 行),保留前 1500 字符
    const errorSection = output.split('\n').filter(l => /error|Error|FAILED/.test(l)).join('\n');
    const trimmed = (errorSection || output).substring(0, 1500);
    return {
      reverted: true,
      message: `⚠️ Edit REVERTED due to C# build error:\n  ${trimmed.split('\n').join('\n  ')}\n\nOriginal file restored. Please fix the edit content and retry.`,
    };
  } catch (e: unknown) {
    // runDotnetBuild 内部已 catch，此处防御性兜底（非回滚——编辑保留在盘上，走 textResult 附注）
    return { reverted: false, message: `⚠️ Unexpected error during C# validation: ${(e as Error).message}` };
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
      // 反馈 11-20 复发条(2026-11-24): no-change 守卫——落盘内容与原文逐字相同时不写盘、
      // 不校验,显式回 "No change made"(此前照常写盘并回 "replaced …",调用方分不清
      // 「改了」与「没改」,复发时与 git diff 对账失真)。三条成功路径同款。
      if (finalContent === rawFile) {
        return textResult(`No change made to ${fullPath}: the edit result is identical to the existing content (nothing written).`);
      }
      // SEC-P1-1 / Task D3(2026-11-12 反馈批次): edit_script 沙箱扫描收窄到增量——只扫
      // replace 段。既有文件的合法敏感代码(FileAccess.WRITE 存档/load(常量) 等)不再阻断
      // 无关编辑(它们已在盘上,编辑行为不改变其存在);replace 段新引入的危险模式
      // (Phase 1/2/3,含字符串拼接绕过)仍拦。write_script 维持全文扫描(新文件/整文件覆盖,威胁模型不同)。
      const sandboxGuard = scanScriptSandboxOrThrow(normalizedReplace, fullPath);
      if (sandboxGuard) return sandboxGuard;
      // A-ATOMIC (2026-09-01): 覆盖用户 .gd 走原子写(此前直写,进程崩溃/断电窗口
      // 半写;validateAndRevert 只兜"验证失败回滚",不兜崩溃)
      writeFileAtomic(fullPath, finalContent);
      // D1(2026-11-12): 写后回读校验,不一致以错误返回
      const verifyFail0 = verifyWriteResult(fullPath, finalContent);
      if (verifyFail0) return verifyFail0;

      if (godotPath) {
        const outcome = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
        if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
        if (outcome.message) return textResult(outcome.message);
      }
      if (isCsharp && autoValidate) {
        // 终审 Important-1(2026-11-12): C# 回滚对齐 GDScript 的 isError 语义
        const outcome = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
        if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
        if (outcome.message) return textResult(outcome.message);
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

      // 反馈 11-20 复发条: 成功回执附落盘内容的 UTF-8 字节数(Buffer.byteLength,非 .length
      // 的 UTF-16 码元)——复发时拿它与 git diff 对账,即可区分「没写」与「写了又被盖」。
      const bytesWritten = Buffer.byteLength(finalContent, 'utf8');
      return textResult(`Edited ${fullPath}: replaced all ${count} occurrences of search text (${bytesWritten} bytes written).${dw}${editLintSection}${importSection}`);
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
    // 反馈 11-20 复发条: no-change 守卫,同上 occurrence=0 路径
    if (finalContent === rawFile) {
      return textResult(`No change made to ${fullPath}: the edit result is identical to the existing content (nothing written).`);
    }
    // SEC-P1-1 / Task D3(2026-11-12 反馈批次): 同上 occurrence=0 路径——单次替换只扫
    // replace 段增量,既有文件敏感代码不阻断无关编辑;replace 段新引入危险模式仍拦。
    const sandboxGuard = scanScriptSandboxOrThrow(normalizedReplace, fullPath);
    if (sandboxGuard) return sandboxGuard;
    writeFileAtomic(fullPath, finalContent);  // A-ATOMIC: 覆盖用户 .gd 原子写
    // D1(2026-11-12): 写后回读校验,不一致以错误返回
    const verifyFail1 = verifyWriteResult(fullPath, finalContent);
    if (verifyFail1) return verifyFail1;

    if (godotPath) {
      const outcome = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
      if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
      if (outcome.message) return textResult(outcome.message);
    }
    if (isCsharp && autoValidate) {
      // 终审 Important-1(2026-11-12): C# 回滚对齐 GDScript 的 isError 语义
      const outcome = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
      if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
      if (outcome.message) return textResult(outcome.message);
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

    // 反馈 11-20 复发条: 字节数括注,同上
    const bytesWritten = Buffer.byteLength(finalContent, 'utf8');
    return textResult(`Edited ${fullPath}: replaced occurrence ${occurrence} of search text (${foundCount} total matches found) (${bytesWritten} bytes written).${dw}${editLintSection}${importSection}`);
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
  // 反馈 11-20 复发条: no-change 守卫,同上 search_and_replace 路径(文案点明行号区间)
  if (result === rawFile) {
    return textResult(`No change made to ${fullPath}: lines ${startLine}-${endLine} replaced with identical content (nothing written).`);
  }
  // SEC-P1-1 / Task D3(2026-11-12 反馈批次): 行号模式沙箱扫描收窄到增量——只扫实际插入的
  // 新行(adjustedLines,smart 缩进调整后的最终落盘增量)。既有文件敏感代码不阻断无关编辑;
  // 新行引入的危险模式(Phase 1/2/3,含字符串拼接绕过)仍拦。
  const sandboxGuard = scanScriptSandboxOrThrow(adjustedLines.join('\n'), fullPath);
  if (sandboxGuard) return sandboxGuard;
  writeFileAtomic(fullPath, result);  // A-ATOMIC: 覆盖用户 .gd 原子写
  // D1(2026-11-12): 写后回读校验,不一致以错误返回
  const verifyFail2 = verifyWriteResult(fullPath, result);
  if (verifyFail2) return verifyFail2;

  if (godotPath) {
    const ctxInfo = `Lines ${startLine}-${endLine}:\n${beforeLines.join('\n')}\n→\n${adjustedLines.join('\n')}`;
    const outcome = await validateAndRevert(fullPath, rawFile, godotPath, projectPath, ctxInfo);
    if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
    if (outcome.message) return textResult(outcome.message);
  }
  if (isCsharp && autoValidate) {
    // 终审 Important-1(2026-11-12): C# 回滚对齐 GDScript 的 isError 语义
    const outcome = await csharpValidateAndRevert(fullPath, rawFile, projectPath);
    if (outcome.reverted) return opsErrorResult('EDIT_REVERTED', outcome.message);
    if (outcome.message) return textResult(outcome.message);
  }

  const afterLines = adjustedLines;
  // 反馈 11-20 复发条: 字节数括注,同上(拼在 header 行)
  const bytesWritten = Buffer.byteLength(result, 'utf8');
  const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines) (${bytesWritten} bytes written)`;
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
