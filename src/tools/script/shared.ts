// script 工具跨 action 共享守卫层。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import type { ToolContext, ToolResult } from '../../types.js';
import { opsErrorResult } from '../shared.js';
import { scanGdscriptSandbox } from '../../gdscript-executor.js';
import { runImport } from '../import-check.js';
import { formatImportIntegrity } from '../import-integrity.js';

/** P1-2 (2026-07-06 review): editor 文本资源写守卫。ctx.checkEditorTextResourceWrite 由
 *  dispatcher 在 editorExecutor 可用时注入(headless 模式不注入 → 直接放行)。
 *  返回非 null = 被守卫阻塞(脚本在 ScriptEditor 打开 / ResourceLoader 缓存冲突),
 *  调用方直接 return 该 ToolResult。防 TS writeFileSync 绕过编辑器内存状态守卫致版本撕裂。 */
export async function checkTextResourceGuard(ctx: ToolContext, path: string): Promise<ToolResult | null> {
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

/** M6 (write_script 2026-06-23 / edit_script 2026-06-24): 若 .gd 的 class_name 新增或变化,
 *  触发 --import 重建 .godot/global_script_class_cache。否则自定义目录新 class_name 不被
 *  needsImport 检测 → execute_gdscript 不 warm → 后续 "Identifier not declared"。
 *  write_script 传 contentBefore=null(新文件,after 有 class_name 即触发);
 *  edit_script 传 rawFile(编辑前),仅 class_name 变化才触发(避免每次 edit 都 30s import)。 */
export async function ensureClassNameImport(
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
    const integrity = await runImport(projectPath, godot, 30_000);
    let msg = `\n\n⚠️ 检测到 class_name '${after}'，已自动 --import 重建 .godot/global_script_class_cache。后续 execute_gdscript / F5 可直接引用。`;
    // 能力 D：导入后 .import 完整性异常上浮到工具输出（自动 warmup 链的用户可见口）
    const integrityText = formatImportIntegrity(integrity);
    if (integrityText) msg += `\n\n${integrityText}`;
    return msg;
  } catch (err) {
    return `\n\n⚠️ 检测到 class_name '${after}' 但自动 --import 失败: ${err instanceof Error ? err.message : String(err)}。需手动 \`godot --headless --import --path <project>\` 重建 cache，否则后续可能 "Identifier not declared"。`;
  }
}
