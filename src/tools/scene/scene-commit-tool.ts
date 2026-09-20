import type { Tool } from "@modelcontextprotocol/server";

// src/tools/scene-commit-tool.ts
// P2: MCP tool wrapper for scene_commit.
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { executeGdscriptRuntime as executeGdscript } from '../../gdscript-executor.js';
import { generateCommitScript, validateCommitOperations, TILESET_RESOURCE_OPS, type CommitOperation } from './scene-commit.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../../core/process-state.js';
import { opsErrorResult } from '../shared.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] scene-commit-tool module is absorbed into scene. Do not register directly.`);
  return [{
    name: 'scene_commit',
    description: '批量执行场景修改操作（tile_set/tile_fill/tile_erase/tile_clear/tileset_assign/node_property/node_add + TileSet 资源层配置 9 op），合并为一次 Godot 进程调用。适合需要持久化的批量修改。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
        scene_path: { type: 'string', description: '目标场景路径（如 res://scenes/Level.tscn）' },
        operations: {
          type: 'array',
          description: '操作列表',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add', 'tileset_physics_layer_add', 'tile_collision_set', 'tileset_physics_layer_set', 'tileset_physics_layer_remove', 'tileset_navigation_layer_add', 'tile_navigation_set', 'tileset_custom_data_layer_add', 'tile_custom_data_set', 'tile_collision_clear'] },
              node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径（tile 操作必需）' },
              coords: { type: 'object', description: '图块坐标 {x, y}' },
              region: { type: 'object', description: '矩形区域 {x, y, w, h}' },
              source_id: { type: 'number', description: 'TileSet 源 ID' },
              atlas: { type: 'object', description: '图集坐标 {x, y}' },
              alternative_tile: { type: 'number', description: '替代图块索引（默认 0）' },
              tileset_path: { type: 'string', description: 'TileSet 资源路径（tileset_assign + 层配置 9 op；层配置 op 限 res:// 项目内 .tres）' },
              collision_layer: { type: 'number', description: 'tileset_physics_layer_add/set: 碰撞层位掩码' },
              collision_mask: { type: 'number', description: 'tileset_physics_layer_add/set: 碰撞遮罩位掩码' },
              physics_layer: { type: 'number', description: 'tile_collision_set/clear: 物理 layer 索引（0 起）' },
              layer: { type: 'number', description: 'tileset_physics_layer_set/remove 与 tile_custom_data_set: layer 索引（0 起）' },
              layers: { type: 'number', description: 'tileset_navigation_layer_add: 导航层位掩码（可选）' },
              navigation_layer: { type: 'number', description: 'tile_navigation_set: 导航 layer 索引（0 起）' },
              shape: { type: 'string', enum: ['rect', 'polygon'], description: 'tile_collision_set/tile_navigation_set: rect=全格四点；polygon=自定义点集' },
              points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, description: 'polygon 模式点集 [{x,y}]' },
              one_way: { type: 'boolean', description: 'tile_collision_set: 单向碰撞（可选）' },
              name: { type: 'string', description: '节点名称（node_add）/自定义数据层名（tileset_custom_data_layer_add）' },
              type: { type: 'string', description: '节点类型（node_add）/数据层类型 int|float|bool|string|color|vector2（可选）' },
              path: { type: 'string', description: '节点路径（node_property）' },
              property: { type: 'string', description: '属性名' },
              value: { description: '属性值（node_property）/自定义数据值（tile_custom_data_set）' },
              parent: { type: 'string', description: '父节点路径（node_add）' },
            },
            required: ['op'],
          },
        },
        save: { type: 'boolean', description: '是否保存到文件（默认 true）', default: true },
        stop_on_error: { type: 'boolean', description: '遇错是否停止（默认 true）', default: true },
      },
      required: ['scene_path', 'operations'],
    },
  }];
}

// ─── Core handler (shared by handleTool and scene module) ─────────────────

export async function handleCommitAction(
  args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  const absPath = resolveWithinRoot(p, scenePath);
  const operations = args.operations as Array<Record<string, unknown>>;
  const save = args.save !== false;
  const stopOnError = args.stop_on_error !== false;

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return opsErrorResult('INVALID_PARAMS', 'operations must be a non-empty array');
  }
  if (operations.length > 500) {
    return opsErrorResult('INVALID_PARAMS', `Too many operations (${operations.length}). Maximum: 500`);
  }

  // IMPORTANT-7 (review): operations 结构校验(原 as unknown as CommitOperation[] 无运行时校验,
  // 畸形 op 致 generateCommitScript 崩溃)。用 validateCommitOperations 便于单测。
  const validationError = validateCommitOperations(operations);
  if (validationError) {
    return opsErrorResult('INVALID_PARAMS', validationError);
  }

  // TileSet 资源 op(物理/导航/自定义数据层,共 9 个)经 ResourceSaver 写 .tres——
  // tileset_path 是写盘参数,必须过项目内校验(deny-by-default,防越界写)。
  // validateCommitOperations 已做 res:// 前缀 + 明文 .. 浅校验;此处对已存在的 .tres 追加
  // resolveWithinRoot realpath 纵深校验(拦 URL 编码/symlink 等绕过浅校验的形态,
  // memory: file-path-args-whitelist-blindspot)。不存在的路径无覆写面——GD 侧 load null
  // 走 "TileSet resource not found" 结构化错误,放行到执行层。
  for (const op of operations) {
    if (!TILESET_RESOURCE_OPS.has(op.op as string)) continue;
    const rel = normalizeUserProjectPath(op.tileset_path as string);
    if (existsSync(resolve(p, rel))) {
      try {
        resolveWithinRoot(p, rel);
      } catch {
        return opsErrorResult('INVALID_PARAMS', `Op tileset_path escapes project root: ${String(op.tileset_path)}`);
      }
    }
  }

  // F-1 (批 F, 2026-08-14): editor 场景写守卫——commit 走 headless spawn 写盘(不在 editor-method-map),
  // 若该场景在 editor 打开, headless 直写磁盘会被 editor GUI save 覆盖回旧内存态,批量写入静默丢失。
  // 调用方式对齐 index.ts edit_node(:385-388)同款;守卫在 acquireShortRunningSlot 之前,被拦截不占 slot。
  // headless 模式 checkEditorSceneSave 未注入, 直接放行。
  if (ctx.checkEditorSceneSave) {
    const sceneGuard = await ctx.checkEditorSceneSave(absPath);
    if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
  }

  // Generate GDScript
  const resPath = `res://${scenePath.replace(/\\/g, '/')}`;
  const script = generateCommitScript(
    resPath,
    operations as unknown as CommitOperation[],
    save,
    stopOnError,
  );

  // Execute via Godot process
  if (!acquireShortRunningSlot()) {
    return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  }

  try {
    const godot = await ctx.findGodot();
    const result = await executeGdscript({
      godotPath: godot,
      projectPath: p,
      code: script,
      timeout: 120,
      loadAutoloads: false,
    });

    // Parse COMMIT_RESULT from output
    const commitResult = parseCommitResult(result.raw_output || result.run_error || '');
    // F-2 (批 F, 2026-08-14; 批F fix 收口): 真失败(COMMIT_RESULT success:false)不再假成功——
    // 顶层置 isError,防 AI 与 middleware 把失败当成功。单条件 success 驱动,统一覆盖三类真失败:
    // 保存失败(ENOSPC/EACCES → err != OK → success:false)/stopOnError 中止(stopBlock success:false,
    // 含 save=false 的中止——原 save && saved===false 条件把该 corner 误排除)/load 失败。
    // save=false 正常完成的 saved:false 伴随 success:true,不触发;commitResult 为 null
    // (GDScript 崩溃无 COMMIT_RESULT)时短路走 fallback,行为不变。
    if (commitResult?.success === false) {
      return { content: [{ type: 'text', text: JSON.stringify(commitResult, null, 2) }], isError: true };
    }
    return textResult(JSON.stringify(commitResult || {
      success: result.run_success,
      raw_output: result.raw_output,
      errors: result.errors,
    }, null, 2));
  } finally {
    releaseShortRunningSlot();
  }
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'scene_commit') return null;
  return handleCommitAction(args, ctx);
}

/** Parse COMMIT_RESULT JSON from GDScript output. */
export function parseCommitResult(output: string): Record<string, unknown> | null {
  const marker = 'COMMIT_RESULT: ';
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return null;
  try {
    const after = output.slice(idx + marker.length);
    // Find the end of the JSON value — match balanced braces
    let depth = 0;
    let end = -1;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return null;
    return JSON.parse(after.slice(0, end));
  } catch {
    return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene_commit: { readonly: false, long_running: true },
};
