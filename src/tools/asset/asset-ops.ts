import type { Tool } from "@modelcontextprotocol/server";

// src/tools/asset/asset-ops.ts — merged asset 工具（7 action）
//
// 单工具聚合：create / path / batch / undo / save / list_shapes / list_materials。
// 设计依据：T1-T6 GD 侧全就绪（command_handler 5 路由 + asset_commands 真实 handle_* +
// 工厂/阵列/放置/undo/save）。本模块为 TS 入口，负责：(1) 暴露工具 schema 给 MCP
// 客户端；(2) list_* 静态返回；(3) 写动作经 editor 盲转持久化。
//
// 路由大图（editor-method-map.ts + ToolDispatcher.ts:353-374 + editorExecutor 注入
// GodotServer.ts:436-437）：
//   editor 模式：ToolDispatcher.executeToolCall 盲转 currentExecutor.execute；
//   EditorToolExecutor._executeInner 经 editor-method-map 把 (asset, create/path/
//   batch/undo/save) 映射到扁平 method → command_handler.gd match 命中 → 持久化
//   （视口可见、可 undo）。create 的顶层 position/rotation/scale 由映射层 transformArgs
//   并入 params（GD handle_create 只读内层 params）。
//     - asset_list_shapes / asset_list_materials 无映射 → 转发工具名 'asset' →
//       command_handler 无 'asset' 分支 → -32601 → ToolDispatcher._isUnknownMethod
//       检测（嵌套+平铺）→ 回退 dispatchTool → 本 handleTool → 静态返回。
//   headless 模式：ToolDispatcher currentExecutor=null，dispatchTool → 本 handleTool：
//     - list_* 静态返回。
//     - create/path/batch/undo/save → 返 EDITOR_ONLY（无编辑器可持久化）。
//
// 因此本 handleTool **不**实现 ctx.editorExecutor 探索块（写动作靠 editor-method-map
// 盲转命中；list_* 靠 -32601 回退）。
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { opsErrorResult } from '../shared.js';
import { requireProjectPath, requireString } from '../../helpers.js';
import {
  isPathInAllowedRoots,
  normalizeUserProjectPath,
  resolveWithinRoot,
} from '../../core/path-utils.js';
import { SHAPES, SHAPE_NAMES, MATERIAL_PRESETS } from './schema.js';

// ─── 常量 ────────────────────────────────────────────────────────────────────

const ACTIONS = ['create', 'path', 'batch', 'undo', 'save', 'list_shapes', 'list_materials'] as const;

// ─── 工具定义 ─────────────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'asset',
    description: '参数化 3D shape 生成（11 shape）+ 路径阵列 + batch + undo + save 预制件。'
      + 'create/path/batch/undo/save 经 editor 持久化（视口可见、可 undo）；'
      + 'list_shapes/list_materials 静态返回。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: '操作类型。create=建资源节点, path=沿多点路径铺设(串联), batch=批量操作, undo=撤销, save=落盘, list_shapes/list_materials=形状/材质清单',
        },
        shape: {
          type: 'string',
          enum: [...SHAPE_NAMES],
          description: 'create/path: shape 名（见 list_shapes）',
        },
        params: { type: 'object', description: 'shape 参数（见 list_shapes 默认值）' },
        material: {
          type: ['string', 'object', 'null'],
          description: '预设名 / PBR dict（color(hex),alpha,emissive,metallic,roughness）/ res://.tres / null',
        },
        name: { type: 'string', description: '节点名（碰撞自增 _001）' },
        parent: { type: 'string', description: '父节点路径（绝对 /Root/X 或相对 X/Y）' },
        position: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
        rotation: { type: 'array', items: { type: 'number' }, description: '[x,y,z] 弧度' },
        scale: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
        items: { type: 'array', description: 'batch: [{shape,params,material,name,...}] ≤64' },
        path: { type: 'array', description: 'path: [[x,y,z],...] ≥2 点（与 path_node 互斥）' },
        path_node: { type: 'string', description: 'path: 场景 Path3D 节点路径（与 path 互斥）' },
        mode: {
          type: 'string',
          enum: ['discrete', 'continuous'],
          description: 'path 采样模式',
        },
        spacing: { type: 'number', description: 'path discrete: 等间距（与 count 互斥）' },
        count: { type: 'number', description: 'path discrete: 等数量（与 spacing 互斥）' },
        align: {
          type: 'string',
          enum: ['none', 'path', 'normal'],
          description: 'path 朝向（默认 path）',
        },
        align_vertices: {
          type: 'boolean',
          description: 'path continuous+spacing: 折线顶点段边界对齐',
        },
        node_path: { type: 'string', description: 'save: 要存的子树节点路径' },
        resource_path: { type: 'string', description: 'save: res://xxx.tscn 输出路径' },
      },
      required: ['action'],
    },
  }];
}

// ─── 工具处理 ─────────────────────────────────────────────────────────────────

const TOOL_NAMES = ['asset'] as const;

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  // 非 asset 工具不归本模块处理
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  // action 经 inputSchema.enum 校验，但 enum 是 schema 层约束，TS 无法窄化。
  // 此处是整个模块唯一允许的裸 as（action 已 enum 校验通过）。
  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  // ── list_* 静态返回（不经 editor，headless/editor 双模式都到此处）──
  // editor 模式下 list_* 经 ToolDispatcher 盲转到 command_handler → -32601 →
  // 回退 dispatchTool → 本 handleTool，多 1 次 WS 往返但功能正确。
  if (action === 'list_shapes') {
    return { content: [{ type: 'text', text: JSON.stringify({ shapes: SHAPES }) }] };
  }
  if (action === 'list_materials') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          presets: MATERIAL_PRESETS,
          custom_rule: '{color(hex 或 #hex),alpha?,emissive?,metallic?,roughness?}',
          external: 'res://*.tres',
        }),
      }],
    };
  }

  // ── create/path/batch/undo/save: editor 模式由 ToolDispatcher 盲转 ──
  // editor 模式不会到此（已被 currentExecutor.execute 转发到 command_handler）。
  // 仅 headless 模式 dispatchTool 落到此处 → 返 EDITOR_ONLY。

  // ── save 的 TS 侧 resource_path 前置校验（T8）──
  // 路由现实：editor 模式 save 由 ToolDispatcher 盲转 → command_handler.handle_save
  // （GD T6 已做 begins_with("res://") + has_path_traversal）；TS handleTool 在 editor
  // 模式不被调。headless 模式 save 落到本 handleTool → 原本直接返 EDITOR_ONLY。
  // 此处校验主要给 headless save 早期 resource_path 格式反馈（EDITOR_ONLY 返回前校验），
  // 同时作为防御层：即使未来路由调整使 TS handleTool 在 editor 模式被调，也先于持久化拒掉
  // 非法路径。editor 模式符号链接/TOCTOU 防护靠 GD T6 + 本地可信环境（已知架构局限）。
  if (action === 'save') {
    const resourcePath = requireString(args, 'resource_path');
    if (!resourcePath.startsWith('res://')) {
      return opsErrorResult(
        'INVALID_PATH',
        `save resource_path must start with res://, got: ${resourcePath}`,
      );
    }
    // 惯例（同 batch-tools.ts:114-115 / data-import.ts:320-321）：res:// 先剥离，
    // resolveWithinRoot 不识别 res://。normalizeUserProjectPath 单参，仅剥前缀。
    const projectPath = requireProjectPath(args);
    const relPath = normalizeUserProjectPath(resourcePath);
    // resolveWithinRoot: realpathSync 归一，防符号链接/`..`/UNC/Windows 设备名。
    // 越界 → 抛异常（不能静默吞，save 是写操作）。
    const resolved = resolveWithinRoot(projectPath, relPath);
    if (!isPathInAllowedRoots(resolved)) {
      return opsErrorResult(
        'PATH_NOT_ALLOWED',
        `save resource_path outside ALLOWED_PROJECT_PATHS: ${resourcePath}`,
      );
    }
  }

  return opsErrorResult(
    'EDITOR_ONLY',
    `asset action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.`,
  );
}

// ─── 工具元数据（注册到 tool-registry 供权限/风险分级）────────────────────────

export const TOOL_META: Record<string, {
  readonly: boolean;
  long_running: boolean;
  actionRisks?: Record<string, RiskLevel>;
}> = {
  asset: {
    readonly: false,
    long_running: false,
    actionRisks: {
      list_shapes: 'read',
      list_materials: 'read',
      create: 'write',
      path: 'write',
      batch: 'write',
      undo: 'write',
      save: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
