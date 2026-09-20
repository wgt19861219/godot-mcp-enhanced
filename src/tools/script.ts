import { join, basename, extname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, renameSync, unlinkSync, copyFileSync } from 'fs';
import { writeFileAtomic } from '../core/fs-atomic.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { maybeWrapUntrusted } from '../core/untrusted-wrap.js';
import { textResult } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../core/path-utils.js';
import { ensureDir } from '../core/fs-atomic.js';
import { executeGdscript } from '../gdscript-executor.js';
import { scanGdscriptSandbox } from '../gdscript-executor.js';
import { runImport } from './import-check.js';
import { batchValidateScripts } from './validation.js';
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
import { getTemplateSuggestion } from './code-templates.js';
import { opsErrorResult, escapeForGdLiteral } from './shared.js';
import { pluginSelfPathGuard } from './shared/file-guard.js';
import { runDotnetBuild } from './shared/validation.js';

const execFileAsync = promisify(execFile);
import { validateTimeout } from './shared.js';
import { getLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/tool-registry.js';

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

/** P1-2 (2026-07-06 review): editor 文本资源写守卫。ctx.checkEditorTextResourceWrite 由
 *  dispatcher 在 editorExecutor 可用时注入(headless 模式不注入 → 直接放行)。
 *  返回非 null = 被守卫阻塞(脚本在 ScriptEditor 打开 / ResourceLoader 缓存冲突),
 *  调用方直接 return 该 ToolResult。防 TS writeFileSync 绕过编辑器内存状态守卫致版本撕裂。 */
async function checkTextResourceGuard(ctx: ToolContext, path: string): Promise<ToolResult | null> {
  if (!ctx.checkEditorTextResourceWrite) return null;
  const guard = await ctx.checkEditorTextResourceWrite(path);
  if (guard.blocked) {
    return opsErrorResult('EDITOR_RESOURCE_OPEN', guard.message ?? `Resource open in editor: ${path}`);
  }
  return null;
}

/**
 * SEC-P1-1 (2026-08-08): write_script/edit_script 沙箱扫描守卫。
 *
 * write_script/edit_script 写任意 content 不经沙箱扫描,与 execute_gdscript 不对齐——
 * 客户端可写 @tool 脚本(editor 加载即执行 _ready)+ 含 OS.execute 脚本(配合 load/instantiate 触发)。
 * 此函数对 .gd 文件内容调 scanGdscriptSandbox,发现危险模式则阻断(对齐 overrides.ts:106-119 范式)。
 *
 * 旁路:UNRESTRICTED && (DISABLE_SAFETY || ALLOW_UNSAFE) 双 opt-in(对齐 executeGdscript
 * gdscript-executor.ts:1054-1055 + overrides.ts:106-108)。非 .gd 文件跳过(.cs 等不适用)。
 *
 * @returns opsErrorResult 若检测到危险模式且未旁路;null 表示通过(安全或已旁路)
 */
// B-1 (2026-08-14): 导出供三个 .gd 写入旁路入口共用(quick_scene/batch create_files/
// templates apply_template)。全仓所有写 .gd 落盘前必须过此扫描(SEC-P1-1 同一威胁面:
// tscn 绑 ExtResource 后编辑器打开/run_project 即执行)。
export function scanScriptSandboxOrThrow(content: string, filePath: string): ToolResult | null {
  // 只扫 .gd(C# 等不适用 scanGdscriptSandbox 的 GDScript 专用模式)
  if (!filePath.endsWith('.gd')) return null;
  // 双 opt-in 旁路(对齐 gdscript-executor.ts:1054-1055)
  const safetyDisabled = process.env.GODOT_MCP_UNRESTRICTED === 'true'
    && (process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true');
  if (safetyDisabled) return null;
  const sandboxWarnings = scanGdscriptSandbox(content);
  if (sandboxWarnings.length > 0) {
    return opsErrorResult(
      'SANDBOX_VIOLATION',
      `Script content failed sandbox scan: ${filePath}\n` +
      `Dangerous patterns detected (write/edit shares the same threat surface as execute_gdscript — written .gd executes via run_project/@tool):\n${sandboxWarnings.join('\n')}\n` +
      `Set GODOT_MCP_DISABLE_SAFETY=true + GODOT_MCP_UNRESTRICTED=true to override (P0-1 double-opt-in).`,
    );
  }
  return null;
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

const ACTIONS = [
  'read_script',
  'write_script',
  'edit_script',
  'generate_test',
  'create_test_scene',
  'execute_gdscript',
  'project_replace',
] as const;

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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'script',
      description: '脚本操作。读写: read_script, write_script。编辑: edit_script（行号/search_and_replace）。执行: execute_gdscript（⚠️ 沙箱仅防误操作，不可用于不可信输入；高安全场景 ALLOW_EXECUTE_GDSCRIPT=false 或容器隔离）。⚠️ write_script/edit_script 写 .gd 前也走沙箱扫描（与 execute_gdscript 同威胁面）。测试: generate_test, create_test_scene。批量替换: project_replace。💡 最佳实践:分步执行、每步验证,复杂逻辑拆小块用 read/edit_script 迭代。详细用法: help 工具。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。read_script=读, write_script=写, edit_script=编辑(行号/search_and_replace), execute_gdscript=执行, project_replace=全仓批量替换, generate_test/create_test_scene=测试生成',
          },
          script_path: { type: 'string', description: 'read_script 用绝对路径；write_script/edit_script/generate_test 用绝对或相对项目路径' },
          content: { type: 'string', description: 'write_script: GDScript 内容' },
          overwrite: { type: 'boolean', description: 'write_script: 覆盖已有文件（默认 false）', default: false },
          start_line: { type: 'number', description: 'edit_script: 替换起始行（1-based）' },
          end_line: { type: 'number', description: 'edit_script: 替换结束行（1-based，含）' },
          new_content: { type: 'string', description: 'edit_script: 替换内容' },
          indent_mode: {
            type: 'string',
            enum: ['raw', 'smart'],
            description: 'edit_script: 缩进模式（默认 raw）',
            default: 'raw',
          },
          verify_content: { type: 'string', description: 'edit_script: 期望内容守卫（不匹配则中止）' },
          auto_validate: {
            type: 'boolean',
            description: 'edit_script: 自动验证语法并在失败时回滚（默认 true）',
            default: true,
          },
          search_and_replace: {
            type: 'object',
            description: 'edit_script: 内容搜索替换模式（提供时忽略 start_line/end_line）',
            properties: {
              search: { type: 'string', description: '搜索文本（CRLF 归一化匹配）' },
              replace: { type: 'string', description: '替换文本' },
              occurrence: { type: 'number', description: '替换第几次出现（1-based，0=全部）' },
            },
            required: ['search', 'replace'],
          },
          code: { type: 'string', description: 'execute_gdscript: 要执行的 GDScript 代码' },
          timeout: { type: 'number', description: 'execute_gdscript: 超时秒数（默认 30）', default: 30 },
          load_autoloads: { type: 'boolean', description: 'execute_gdscript: 省略时自动检测 autoload 引用；显式 true/false 覆盖自动检测' },
          search: { type: 'string', description: 'project_replace: 搜索文本' },
          replace: { type: 'string', description: 'project_replace: 替换文本' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 文件扩展名（默认 [".gd"]）',
            default: ['.gd'],
          },
          exclude_dirs: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 排除目录（默认 [".godot", ".import"]）',
            default: ['.godot', '.import'],
          },
          dry_run: { type: 'boolean', description: 'project_replace: 仅预览不写入（默认 false）', default: false },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

/** M6 (write_script 2026-06-23 / edit_script 2026-06-24): 若 .gd 的 class_name 新增或变化,
 *  触发 --import 重建 .godot/global_script_class_cache。否则自定义目录新 class_name 不被
 *  needsImport 检测 → execute_gdscript 不 warm → 后续 "Identifier not declared"。
 *  write_script 传 contentBefore=null(新文件,after 有 class_name 即触发);
 *  edit_script 传 rawFile(编辑前),仅 class_name 变化才触发(避免每次 edit 都 30s import)。 */
async function ensureClassNameImport(
  projectPath: string, filePath: string, contentBefore: string | null, contentAfter: string, ctx: ToolContext,
): Promise<string> {
  if (!filePath.endsWith('.gd')) return '';
  const classOf = (s: string): string | null => s.match(/^\s*class_name\s+(\w+)/m)?.[1] ?? null;
  const before = contentBefore == null ? null : classOf(contentBefore);
  const after = classOf(contentAfter);
  if (!after) return '';            // 编辑后无 class_name
  if (before === after) return '';  // class_name 未变化
  try {
    const godot = await ctx.findGodot();
    await runImport(projectPath, godot, 30_000);
    return `\n\n⚠️ 检测到 class_name '${after}'，已自动 --import 重建 .godot/global_script_class_cache。后续 execute_gdscript / F5 可直接引用。`;
  } catch (err) {
    return `\n\n⚠️ 检测到 class_name '${after}' 但自动 --import 失败: ${err instanceof Error ? err.message : String(err)}。需手动 \`godot --headless --import --path <project>\` 重建 cache，否则后续可能 "Identifier not declared"。`;
  }
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'script') return null;

  const action = args.action as string;

  switch (action) {
    case 'read_script': {
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.script_path as string));
      if (!existsSync(sp)) return textResult(`Script not found: ${sp}`);

      const content = readFileSync(sp, 'utf-8');
      const lines = content.split('\n');
      const ext = extname(sp).toLowerCase();

      // C# 文件：直接读取，返回 csharp 语言标记
      if (ext === '.cs') {
        let csClassName = '';
        let csNamespace = '';
        let csBaseClass = '';
        const csUsings: string[] = [];
        for (const line of lines) {
          const nsMatch = line.match(/^\s*namespace\s+(\S+)/);
          if (nsMatch) csNamespace = nsMatch[1]!;
          const clsMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/);
          if (clsMatch && !csClassName) csClassName = clsMatch[1]!;
          const baseMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)/);
          if (baseMatch) csBaseClass = baseMatch[1]!;
          const usingMatch = line.match(/^\s*using\s+([^;]+);/);
          if (usingMatch && csUsings.length < 50) csUsings.push(usingMatch[1]!.trim());
        }
        // P1-1: 源码内容 nonce 信封(输出侧防注入,src/core/untrusted-wrap.ts)
        return textResult(maybeWrapUntrusted('script.read', sp, JSON.stringify({
          path: sp,
          language: 'csharp',
          namespace: csNamespace,
          class_name: csClassName,
          extends: csBaseClass,
          usings: csUsings,
          lines: lines.length,
          content,
        }, null, 2)));
      }

      // GDScript 文件：解析 extends / class_name
      let extendsClass = '';
      let className = '';

      for (const line of lines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1]!;
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1]!;
      }

      // P1-1: 源码内容 nonce 信封(输出侧防注入,src/core/untrusted-wrap.ts)
      return textResult(maybeWrapUntrusted('script.read', sp, JSON.stringify({
        path: sp,
        extends: extendsClass,
        class_name: className,
        lines: lines.length,
        content,
      }, null, 2)));
    }

    case 'write_script': {
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

    case 'edit_script': {
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

    case 'generate_test': {
      const projectPath = requireProjectPath(args);
      const scriptPath = args.script_path as string;
      if (!scriptPath) {
        return opsErrorResult('INVALID_PARAMS', 'script_path is required (e.g. "scripts/player.gd")');
      }

      const fullScriptPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
      if (!existsSync(fullScriptPath)) {
        return opsErrorResult('NOT_FOUND', `Script not found: ${fullScriptPath}`, {
          suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
        });
      }

      const source = readFileSync(fullScriptPath, 'utf-8');
      const srcLines = source.split('\n');

      let extendsClass = '';
      let className = '';
      for (const line of srcLines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1]!;
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1]!;
      }

      const publicMethods: string[] = [];
      const voidMethods = new Set<string>();
      for (const line of srcLines) {
        const funcMatch = line.match(/^func\s+(\w+)\s*\((?:[^)]*)\)\s*(?:->\s*(\w+))?\s*:/);
        if (funcMatch && !funcMatch[1]!.startsWith('_')) {
          publicMethods.push(funcMatch[1]!);
          if (funcMatch[2] === 'void') {
            voidMethods.add(funcMatch[1]!);
          }
        }
      }

      if (publicMethods.length === 0) {
        return textResult(
          `No public methods found in ${scriptPath}.\n` +
          `Only private methods (starting with _) were detected or the file has no functions.\n` +
          `The script extends "${extendsClass || 'unknown'}".`
        );
      }

      let testTarget: string;
      if (className) {
        testTarget = className;
      } else if (scriptPath.includes('/')) {
        testTarget = scriptPath.split('/').pop()?.replace('.gd', '') || 'Target';
      } else {
        testTarget = scriptPath.replace('.gd', '');
      }
      const scriptResPath = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath}`;

      let testCode = 'extends GutTest\n\n';
      testCode += `var ${testTarget}  # Instance under test\n\n`;
      testCode += 'func before_each():\n';
      testCode += `\t${testTarget} = load("${escapeForGdLiteral(scriptResPath)}").new()\n\n`;
      testCode += 'func after_each():\n';
      testCode += `\tif is_instance_valid(${testTarget}):\n`;
      testCode += `\t\t${testTarget}.free()\n\n`;

      for (const method of publicMethods) {
        testCode += `func test_${method}():\n`;
        if (voidMethods.has(method)) {
          testCode += `\t# void method — no return value to assert\n`;
          testCode += `\t${testTarget}.${method}()\n`;
          testCode += `\tpass # TODO: verify side effects\n\n`;
        } else {
          testCode += `\tvar result = ${testTarget}.${method}()\n`;
          testCode += `\tassert_not_null(result, "${method} should return a value")\n\n`;
        }
      }

      const outputTestPath = join(projectPath, 'test', 'scripts', `test_${basename(scriptPath)}`);

      return textResult(
        `Generated GUT test for ${scriptPath}\n\n` +
        `Target class: ${testTarget}\n` +
        `Extends: ${extendsClass || 'N/A'}\n` +
        `Class name: ${className || 'N/A'}\n` +
        `Public methods found: ${publicMethods.length}\n` +
        `  ${publicMethods.join(', ')}\n\n` +
        `Suggested save path: ${outputTestPath}\n\n` +
        `--- Generated test code ---\n${testCode}` +
        `--- End of generated code ---\n\n` +
        `To save, use: write_script(project_path="${projectPath}", script_path="test/scripts/test_${basename(scriptPath)}", content=<above code>)`
      );
    }

    case 'create_test_scene': {
      const p = requireProjectPath(args);

      const gutDir = join(p, 'addons', 'gut');
      if (!existsSync(gutDir)) {
        return textResult(
          `GUT (Godot Unit Test) addon not found at ${gutDir}.\n\n` +
          `To install GUT:\n` +
          `1. Download from: https://github.com/bitwes/Gut/releases\n` +
          `2. Extract to ${join(p, 'addons', 'gut')}\n` +
          `3. Or use the Godot Asset Library: https://godotengine.org/asset-library/asset/282\n\n` +
          `After installing GUT, run create_test_scene again.`
        );
      }

      mkdirSync(join(p, 'test', 'scripts'), { recursive: true });

      const testSceneContent = [
        '[gd_scene load_steps=2 format=3]',
        '',
        '[ext_resource type="Script" path="res://addons/gut/gut.gd" id="1_gut"]',
        '',
        '[node name="TestScene" type="Node"]',
        'script = ExtResource("1_gut")',
        '',
      ].join('\n');
      writeFileSync(join(p, 'test_scene.tscn'), testSceneContent, 'utf-8');

      return textResult(
        `GUT test scene created at ${join(p, 'test_scene.tscn')}\n\n` +
        `To run tests:\n` +
        `1. Open test_scene.tscn in Godot editor\n` +
        `2. Click "Run All" in the GUT panel\n` +
        `3. Or use run_tests(project_path="${p}") for headless testing\n\n` +
        `Test scripts should be placed in: test/scripts/`
      );
    }

    case 'execute_gdscript': {
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

    case 'project_replace': {
      const p = requireProjectPath(args);
      const search = args.search as string;
      const replace = (args.replace as string) ?? '';
      const ALLOWED_EXTENSIONS = new Set(['.gd', '.cs', '.tscn', '.tres', '.gdshader', '.cfg', '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv']);
      const HARDCODED_EXCLUDE = new Set(['.git', 'node_modules']);
      const rawExtensions: string[] = (args.extensions as string[]) || ['.gd'];
      const extensions = rawExtensions.filter(ext => ALLOWED_EXTENSIONS.has(ext));
      if (extensions.length === 0) {
        return opsErrorResult('INVALID_PARAMS', `No allowed extensions. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }
      const userExcludeDirs: string[] = (args.exclude_dirs as string[]) || ['.godot', '.import'];
      const excludeDirs = [...new Set([...userExcludeDirs, ...HARDCODED_EXCLUDE])];
      const dryRun = args.dry_run === true;

      if (!search) {
        return opsErrorResult('INVALID_PARAMS', 'search must be a non-empty string.');
      }

      const normalizedSearch = search.replace(/\r\n/g, '\n');
      const normalizedReplace = replace.replace(/\r\n/g, '\n');

      // I-01, I-03: Clean up residual .bak / .mcp-tmp files from interrupted atomic writes
      // Scan all top-level subdirectories (not just . and src) since project_replace can affect any location
      const cleanedResiduals: string[] = [];
      for (const suffix of ['.bak', '.mcp-tmp']) {
        try {
          const rootEntries = readdirSync(p, { withFileTypes: true });
          for (const rootEntry of rootEntries) {
            const absDir = join(p, rootEntry.name);
            // Only scan directories that aren't excluded and the root itself
            const isExcluded = excludeDirs.includes(rootEntry.name) || rootEntry.name.startsWith('.');
            const targets = isExcluded ? [] : (rootEntry.isDirectory() ? [absDir] : rootEntry.isFile() && rootEntry.name.endsWith(suffix) ? [absDir] : []);
            // Also check root-level files matching suffix
            if (rootEntry.isFile() && rootEntry.name.endsWith(suffix)) {
              try { unlinkSync(absDir); cleanedResiduals.push(rootEntry.name); } catch { /* best effort */ }
              continue;
            }
            for (const targetDir of targets) {
              if (!existsSync(targetDir)) continue;
              const entries = readdirSync(targetDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith(suffix)) {
                  const residualPath = join(targetDir, entry.name);
                  try { unlinkSync(residualPath); cleanedResiduals.push(join(rootEntry.name, entry.name)); } catch { /* best effort */ }
                }
              }
            }
          }
        } catch { /* non-critical cleanup */ }
      }

      // Collect files
      const MAX_FILES = 500;
      const matchedFiles: string[] = [];
      const skippedDirs: string[] = [];
      function scanDir(dir: string, depth: number): void {
        if (matchedFiles.length >= MAX_FILES) return;
        if (depth > 15) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (matchedFiles.length >= MAX_FILES) return;
            if (entry.name.startsWith('.')) continue;
            if (excludeDirs.includes(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (existsSync(join(full, '.gdignore'))) continue;
              scanDir(full, depth + 1);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
              matchedFiles.push(full);
            }
          }
        } catch (err) {
          getLogger().debug('script', `scan dir for files: ${err instanceof Error ? err.message : err}`);
          skippedDirs.push(dir.slice(p.length + 1) || dir);
        }
      }
      scanDir(p, 0);
      if (matchedFiles.length >= MAX_FILES) {
        return opsErrorResult('INVALID_PARAMS', `Too many matching files (>${MAX_FILES}). Narrow the search with more specific extensions or add directories to exclude_dirs.`);
      }

      const relOf = (absPath: string) => absPath.slice(p.length + 1);

      const changedFiles: string[] = [];
      const unchangedFiles: string[] = [];
      const skippedLarge: string[] = [];
      let totalReplacements = 0;
      const MAX_FILE_SIZE = 1_000_000; // 1MB

      // Phase 1: 收集所有变更到内存
      const pendingWrites: Array<{ filePath: string; finalContent: string }> = [];

      for (const filePath of matchedFiles) {
        try {
          const fileSize = statSync(filePath).size;
          if (fileSize > MAX_FILE_SIZE) {
            skippedLarge.push(relOf(filePath));
            continue;
          }
        } catch (e) { getLogger().debug('script', `stat failed for ${filePath}: ${e instanceof Error ? e.message : e}`); continue; }
        const content = readFileSync(filePath, 'utf-8');
        const hasCRLF = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');

        if (!normalized.includes(normalizedSearch)) {
          unchangedFiles.push(relOf(filePath));
          continue;
        }

        const count = normalized.split(normalizedSearch).length - 1;
        totalReplacements += count;

        if (!dryRun) {
          const newContent = normalized.replaceAll(normalizedSearch, normalizedReplace);
          const finalContent = hasCRLF ? newContent.split('\n').join('\r\n') : newContent;
          pendingWrites.push({ filePath, finalContent });
        }

        changedFiles.push(relOf(filePath));
      }

      // P1-2 FileGuard: 拒写插件自资产——整批原子检查(任一命中全拒,保持批量原子性)
      // 全仓审查 B-1 (2026-09-12): project_replace 的批量写入曾绕过沙箱扫描——此处对每个
      // .gd 落盘内容过 scanScriptSandboxOrThrow(script.ts:79 全仓约束:所有写 .gd 落盘前
      // 必须过此扫描)。攻击路径与 SEC-P1-1 同构:replace 注入危险 API → run_project 即执行。
      if (!dryRun && pendingWrites.length > 0) {
        for (const pw of pendingWrites) {
          const selfGuardP = pluginSelfPathGuard(pw.filePath);
          if (selfGuardP) return selfGuardP;
          const sandboxGuardP = scanScriptSandboxOrThrow(pw.finalContent, pw.filePath);
          if (sandboxGuardP) return sandboxGuardP;
        }
      }
      // Phase 2: Best-effort atomic write — backup originals, write .tmp, rename with rollback
      if (!dryRun && pendingWrites.length > 0) {
        const tmpFiles: string[] = [];
        const bakFiles: string[] = [];
        const renamedCount = { value: 0 };
        try {
          // Step 1: Write all .tmp files (safe — originals untouched)
          for (const pw of pendingWrites) {
            const tmpPath = pw.filePath + '.tmp';
            writeFileSync(tmpPath, pw.finalContent, 'utf-8');
            tmpFiles.push(tmpPath);
          }
          // Step 2: Backup originals to .bak (needed for rollback)
          for (const pw of pendingWrites) {
            const bakPath = pw.filePath + '.bak';
            copyFileSync(pw.filePath, bakPath);
            bakFiles.push(bakPath);
          }
          // Step 3: Rename .tmp → target
          for (let i = 0; i < pendingWrites.length; i++) {
            renameSync(tmpFiles[i]!, pendingWrites[i]!.filePath);
            renamedCount.value++;
          }
        } catch (writeErr) {
          // Rollback: restore .bak for already-renamed files
          for (let i = 0; i < renamedCount.value; i++) {
            try { renameSync(bakFiles[i]!, pendingWrites[i]!.filePath); } catch { /* best effort */ }
          }
          // Cleanup .tmp and remaining .bak files
          for (const tmp of tmpFiles) {
            try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
          }
          for (const bak of bakFiles) {
            try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
          }
          return opsErrorResult('ATOMIC_WRITE_FAILED', `Batch write failed: ${(writeErr as Error).message}. Rollback attempted for ${renamedCount.value} files.`);
        }
        // Success: cleanup .bak files
        for (const bak of bakFiles) {
          try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
        }
        // Cleanup .tmp (already renamed, but defensive)
        for (const tmp of tmpFiles) {
          try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
        }
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      const summary = [
        `${prefix}Batch replace complete.`,
        `Search: "${search.substring(0, 80)}${search.length > 80 ? '...' : ''}"`,
        `Replace: "${replace.substring(0, 80)}${replace.length > 80 ? '...' : ''}"`,
        `Extensions: ${extensions.join(', ')}`,
        `Scanned: ${matchedFiles.length} files`,
        `Changed: ${changedFiles.length} files (${totalReplacements} replacements)`,
        unchangedFiles.length > 0 ? `Unchanged: ${unchangedFiles.length} files` : '',
        skippedLarge.length > 0 ? `Skipped (>${MAX_FILE_SIZE / 1_000_000}MB): ${skippedLarge.length} files` : '',
        skippedDirs.length > 0 ? `Skipped dirs (unreadable): ${skippedDirs.slice(0, 10).join(', ')}${skippedDirs.length > 10 ? ` ... and ${skippedDirs.length - 10} more` : ''}` : '',
        cleanedResiduals.length > 0 ? `Cleaned residuals: ${cleanedResiduals.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const details = changedFiles.length > 0
        ? '\n\nChanged files:\n' + changedFiles.slice(0, 50).map(f => `  ${f}`).join('\n')
          + (changedFiles.length > 50 ? `\n  ... and ${changedFiles.length - 50} more` : '')
        : '\n\nNo files contained the search text.';

      return textResult(summary + details);
    }

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  script: {
    readonly: false,
    long_running: false,
    actionRisks: {
      read_script: 'read', write_script: 'write', edit_script: 'write',
      generate_test: 'write', create_test_scene: 'write',
      execute_gdscript: 'process', project_replace: 'destructive',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
