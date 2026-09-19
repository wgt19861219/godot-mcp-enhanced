import type { Tool } from "@modelcontextprotocol/server";

// UI tool entry point: definitions, handler, and meta.
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { getErrorMessage } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../../helpers.js';
import { executeGdscriptTrusted } from '../../gdscript-executor.js';
import { normalizeNodePath, sanitizeResPath, opsErrorResult, parseGdscriptResult, opsSuccess, NON_PERSIST, appendRuntimePersistWarning } from '../shared.js';
import { ACTIONS, CONTROL_TYPES, ANCHOR_PRESETS, ERROR_CODES, DRAW_OP_KINDS, findBlockedProps } from './types.js';
import type { DrawOp, UiNodeSpec } from './types.js';
import { genUiCreateControlScript, genUiContainerAddScript, genUiAnchorPresetScript } from './ui-create.js';
import { genUiSetLayoutScript, genUiGetLayoutScript, genUiBuildLayoutScript } from './ui-layout.js';
import { genUiSetThemeScript, genThemeCreateScript, genThemeSetPropertyScript } from './ui-theme.js';
import { genUiDrawRecipeScript } from './ui-draw.js';
import { genUiMeasureScript } from './ui-measure.js';
import { genUiImportSingleScript } from './ui-import-single.js';
import { flattenTargets, flattenStyleTargets, styleExpectList, diffLayout, diffStyles, diffFlow, detectOverlaps, detectOutOfBounds } from './layout-diff.js';
import type { MeasuredNode } from './layout-diff.js';
import { parseGeometry, translateGeometry } from './prototype-import.js';
import type { PrototypeGeometry, TranslateResult } from './prototype-import.js';
import { runPixelVerify } from './pixel-verify.js';
import { textResult } from '../../types.js';
import { readFileSync } from 'node:fs';

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui',
      description: `UI 操作。节点: ui_create_control, ui_container_add, ui_build_layout。布局: ui_set_layout, ui_get_layout, ui_anchor_preset。原型: ui_import_prototype(几何 JSON 一次调用翻译+构建+测量+校验+持久化;bg/fill/borderRadius/border→StyleBoxFlat,落盘 theme_override_styles/<slot>;返回 style_verify 逐槽位样式 diff/flow_verify flow 直接子层 rect diff)。像素终验: ui_pixel_verify(bg 节点截图采样 vs 目标色 RGB 距离;Windows 窗口模式会弹窗,几何+style_verify 全绿后跑一次)。主题: ui_set_theme, theme_create, theme_set_property。绘图: ui_draw_recipe。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。ui_build_layout=CSS 布局翻译构建(推荐), ui_import_prototype=原型导入, ui_pixel_verify=像素验证, ui_create_control/container_add/anchor_preset=控件, ui_set/get/measure_layout=布局, ui_draw_recipe=绘制, theme_*=主题',
          },
          scene_path: { type: 'string', description: '场景路径（相对项目路径）。ui_set_theme/theme_set_property 可选;ui_pixel_verify: 必填,已构建场景(ui_import_prototype persist 产物)' },
          node_path: { type: 'string', description: '节点路径（ui_set_layout/ui_get_layout/ui_anchor_preset/ui_set_theme/ui_container_add/ui_draw_recipe）' },
          node_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_create_control/ui_container_add: Control 子类类型',
          },
          node_name: { type: 'string', description: 'ui_create_control: 新节点名称' },
          parent_node_path: { type: 'string', description: 'ui_create_control: 父节点路径（默认 root）' },
          properties: {
            type: 'object',
            description: 'ui_create_control: 可选属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          anchors: {
            type: 'object',
            description: 'ui_set_layout: 锚点 {left, right, top, bottom}，值 0-1',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          offsets: {
            type: 'object',
            description: 'ui_set_layout: 边距 {left, right, top, bottom}，像素值',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          min_size: {
            type: 'object',
            description: 'ui_set_layout: 最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          custom_minimum_size: {
            type: 'object',
            description: 'ui_set_layout: 自定义最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          grow_direction: {
            type: 'string',
            enum: ['both', 'up', 'down', 'left', 'right'],
            description: 'ui_set_layout: 增长方向',
          },
          preset: {
            type: 'string',
            enum: Object.keys(ANCHOR_PRESETS),
            description: 'ui_anchor_preset: 锚点预设名称',
          },
          theme_action: {
            type: 'string',
            enum: ['set_params', 'create', 'save', 'load'],
            description: 'ui_set_theme: 操作类型（set_params/create/save/load）',
          },
          theme_path: { type: 'string', description: 'ui_set_theme: Theme 资源路径（save/load 时必填）' },
          params: {
            type: 'object',
            description: 'ui_set_theme(set_params): 键值对（number/bool/string/array[4]→Color）',
            additionalProperties: true,
          },
          child_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_container_add: 子节点 Control 类型',
          },
          child_name: { type: 'string', description: 'ui_container_add: 子节点名称' },
          child_properties: {
            type: 'object',
            description: 'ui_container_add: 子节点属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          theme_create_action: {
            type: 'string',
            enum: ['create', 'extract'],
            description: 'theme_create: 操作类型（create 创建空 Theme | extract 从节点提取）',
          },
          source_node_path: { type: 'string', description: 'theme_create(extract): 源节点路径' },
          save_path: { type: 'string', description: 'theme_create: 可选保存路径（res://themes/xxx.tres）' },
          theme_node_path: { type: 'string', description: 'theme_set_property: 拥有 Theme 的节点路径' },
          item_type: {
            type: 'string',
            enum: ['default_font', 'color', 'constant', 'stylebox'],
            description: 'theme_set_property: 属性类型',
          },
          prop_name: { type: 'string', description: 'theme_set_property: 属性名' },
          theme_type: { type: 'string', description: 'theme_set_property: Theme 类型名（可选）' },
          value: {
            description: 'theme_set_property: 属性值（default_font/stylebox 为资源路径，color 为 [r,g,b,a]，constant 为数字）',
          },
          ops: {
            type: 'array',
            description: 'ui_draw_recipe: 绘图操作数组（最多 200 个）',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...DRAW_OP_KINDS], description: '绘制操作类型(rect/circle/line 等)' },
                position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
                size: { type: 'array', items: { type: 'number' }, description: '[w, h]' },
                center: { type: 'array', items: { type: 'number' }, description: '[x, y] 圆心' },
                radius: { type: 'number', description: '半径' },
                from: { type: 'array', items: { type: 'number' }, description: '[x, y] 起点' },
                to: { type: 'array', items: { type: 'number' }, description: '[x, y] 终点' },
                start_angle: { type: 'number', description: '起始角度（弧度）' },
                end_angle: { type: 'number', description: '结束角度（弧度）' },
                points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y], ...]' },
                text: { type: 'string', description: '文本' },
                color: { type: 'array', items: { type: 'number' }, description: '[r,g,b] 或 [r,g,b,a]，0-1' },
                width: { type: 'number', description: '线宽' },
                filled: { type: 'boolean', description: '是否填充（默认 true）' },
                font_size: { type: 'number', description: '字号（默认 16）' },
              },
              required: ['kind'],
            },
          },
          max_depth: { type: 'number', description: 'ui_measure_layout: 最大遍历深度(默认 16,上限 64)' },
          expect_tree: { type: 'object', description: 'ui_measure_layout: 可选目标树(同 ui_build_layout tree,含 rect);提供时输出逐节点 diff/重叠/越界', additionalProperties: true },
          geometry: {
            type: 'object',
            description: 'ui_import_prototype/ui_pixel_verify: 原型几何 JSON(inline,{viewport,nodes},扁平视口坐标;与 geometry_path 二选一,同时给时本参优先;样式字段:bg/fill(ProgressBar fill 槽色)/borderRadius(number 或 {tl,tr,br,bl})/border({width,color})→StyleBoxFlat 四控件槽位(Panel/ProgressBar/Button/Label))',
            additionalProperties: true,
          },
          geometry_path: { type: 'string', description: 'ui_import_prototype/ui_pixel_verify: 几何 JSON 文件路径(相对项目,支持 res:// 前缀;与 geometry 二选一)' },
          tolerance: { type: 'number', description: 'ui_import_prototype: layout_verify 容差(px,默认 2)' },
          parent_path: { type: 'string', description: 'ui_build_layout: 父节点路径;ui_import_prototype: 须为原点对齐(global_position≈0,0)的节点,默认 root——非原点挂载时 layout_verify 根级条目期望按视口原点求解,根级 diff 恒误报' },
          tree: {
            type: 'object',
            description: 'ui_build_layout: UI 节点树（最大深度 10）;节点可带 styleboxes: [{slot: panel|normal|background|fill|hover|pressed|disabled, box: {bg_color:[r,g,b,a]0-1, corner_radius: 数值或{tl,tr,br,bl}, border_width, border_color, draw_center}}]→add_theme_stylebox_override(StyleBoxFlat)',
            properties: {
              type: { type: 'string', enum: [...CONTROL_TYPES], description: 'Control 子类' },
              name: { type: 'string', description: '节点名称' },
              properties: { type: 'object', additionalProperties: true, description: '节点属性' },
              anchor_preset: { type: 'string', enum: Object.keys(ANCHOR_PRESETS), description: '锚点预设' },
              layout: {
                type: 'object',
                description: 'CSS Flexbox 布局描述（存在时覆盖 type 字段）',
                properties: {
                  direction: { type: 'string', enum: ['row', 'column', 'row-reverse', 'column-reverse', 'grid'], description: '主轴方向' },
                  justify: { type: 'string', enum: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'], description: '主轴对齐' },
                  align: { type: 'string', enum: ['stretch', 'flex-start', 'center', 'flex-end'], description: '交叉轴对齐' },
                  wrap: { type: 'string', enum: ['nowrap', 'wrap'], description: '换行模式' },
                  gap: { type: 'number', description: '主轴间距' },
                  row_gap: { type: 'number', description: '换行时行间距（仅 wrap 模式）' },
                  columns: { type: 'number', description: 'Grid 列数（仅 grid 方向）' },
                  padding: {
                    description: '内边距：数字或 [上, 右, 下, 左]',
                    oneOf: [
                      { type: 'number' },
                      { type: 'array', items: { type: 'number' } },
                    ],
                  },
                },
                required: ['direction'],
              },
              flex: {
                type: 'object',
                description: '子节点 flex 控制',
                properties: {
                  grow: { type: 'number', description: '扩展比例（0=不扩展）' },
                  shrink: { type: 'number', description: '收缩比例（忽略，无 Godot 对应）' },
                  align_self: { type: 'string', enum: ['auto', 'flex-start', 'center', 'flex-end', 'stretch'], description: '单独对齐覆盖' },
                  min_width: { type: 'number', description: '最小宽度' },
                  min_height: { type: 'number', description: '最小高度' },
                  max_width: { type: 'number', description: '最大宽度（忽略，无 Godot 对应）' },
                  max_height: { type: 'number', description: '最大高度（忽略，无 Godot 对应）' },
                },
              },
              children: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '子节点' },
            },
            required: ['type', 'name'],
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          viewport: {
            type: 'object',
            description: 'ui_build_layout: 根节点 rect 的求解基准 {w, h}(默认 1280x720,须为正数;与项目 display/window/size 一致时根 rect 即视口绝对几何);ui_import_prototype: 可选,默认取 geometry.viewport',
            properties: { w: { type: 'number', description: '宽(px)' }, h: { type: 'number', description: '高(px)' } },
          },
          persist: { type: 'boolean', description: 'ui_build_layout: 持久化到 .tscn（原子写；默认 false 运行时）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

// follow-up C5: Control 创造/改节点树（headless 退出丢失）→ 加提示；ui_get_layout 查询 +
// ui_set_theme/theme_create/theme_set_property（Theme 资源，C5 文案 add_node 错位）不加。
const UI_PERSIST_ACTIONS = new Set(['ui_create_control', 'ui_set_layout', 'ui_anchor_preset', 'ui_container_add', 'ui_draw_recipe', 'ui_build_layout']);

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'ui') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
      case 'ui_create_control': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodeType = args.node_type as string;
        const nodeName = args.node_name as string;
        if (!CONTROL_TYPES.includes(nodeType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid node_type "${nodeType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        if (!nodeName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'node_name is required');
        }
        const parentPath = normalizeNodePath((args.parent_node_path as string) || 'root');
        const properties = args.properties as Record<string, unknown> | undefined;
        const blocked = findBlockedProps(properties);
        if (blocked.length) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Property key(s) blocked (BLOCKED_PROPS security policy): ${blocked.join(', ')}. Keys like script/owner/name/instance are not settable via UI properties.`);
        }
        script = genUiCreateControlScript(scenePath, nodeType, nodeName, parentPath, properties);
        break;
      }
      case 'ui_set_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const anchors = args.anchors as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const offsets = args.offsets as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const minSize = args.min_size as { x?: number; y?: number } | undefined;
        const customMinSize = args.custom_minimum_size as { x?: number; y?: number } | undefined;
        const growDirection = args.grow_direction as string | undefined;
        script = genUiSetLayoutScript(scenePath, nodePath, anchors, offsets, minSize, customMinSize, growDirection);
        break;
      }
      case 'ui_get_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genUiGetLayoutScript(scenePath, nodePath);
        break;
      }
      case 'ui_anchor_preset': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const presetName = args.preset as string;
        if (!(presetName in ANCHOR_PRESETS)) {
          return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET,
            `Invalid preset "${presetName}". Must be one of: ${Object.keys(ANCHOR_PRESETS).join(', ')}`);
        }
        const presetValue = ANCHOR_PRESETS[presetName]!;
        script = genUiAnchorPresetScript(scenePath, nodePath, presetValue, presetName);
        break;
      }
      case 'ui_set_theme': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const themeAction = args.theme_action as string;
        if (!['set_params', 'create', 'save', 'load'].includes(themeAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_action "${themeAction}". Must be one of: set_params, create, save, load`);
        }
        const themePath = args.theme_path as string | undefined;
        if ((themeAction === 'save' || themeAction === 'load') && !themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `theme_path is required for ${themeAction} action`);
        }
        if (themePath) {
          try { sanitizeResPath(themePath, 'theme_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
          }
        }
        const params = args.params as Record<string, unknown> | undefined;
        script = genUiSetThemeScript(scenePath, nodePath, themeAction as 'set_params' | 'create' | 'save' | 'load', themePath, params);
        break;
      }
      case 'ui_container_add': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const childType = args.child_type as string;
        if (!CONTROL_TYPES.includes(childType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid child_type "${childType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        const childName = args.child_name as string;
        if (!childName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'child_name is required');
        }
        const childProperties = args.child_properties as Record<string, unknown> | undefined;
        const blocked = findBlockedProps(childProperties);
        if (blocked.length) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Child property key(s) blocked (BLOCKED_PROPS security policy): ${blocked.join(', ')}. Keys like script/owner/name/instance are not settable via UI properties.`);
        }
        script = genUiContainerAddScript(scenePath, nodePath, childType, childName, childProperties);
        break;
      }
      case 'theme_create': {
        const themeCreateAction = args.theme_create_action as string;
        if (!['create', 'extract'].includes(themeCreateAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_create_action "${themeCreateAction}". Must be one of: create, extract`);
        }
        const sourceNodePath = args.source_node_path as string | undefined;
        const savePath = args.save_path as string | undefined;
        if (savePath) {
          try { sanitizeResPath(savePath, 'save_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'save_path contains path traversal');
          }
        }
        if (themeCreateAction === 'extract' && !sourceNodePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'source_node_path is required for extract action');
        }
        const scenePath = args.scene_path as string | undefined;
        const resolvedScenePath = scenePath
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePath))
          : '';
        if (!resolvedScenePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'scene_path is required for theme_create');
        }
        const normalizedSourcePath = sourceNodePath ? normalizeNodePath(sourceNodePath) : undefined;
        script = genThemeCreateScript(resolvedScenePath, themeCreateAction as 'create' | 'extract', normalizedSourcePath, savePath);
        break;
      }
      case 'theme_set_property': {
        const themeNodePath = normalizeNodePath(args.theme_node_path as string);
        const itemType = args.item_type as string;
        if (!['default_font', 'color', 'constant', 'stylebox'].includes(itemType)) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_ITEM_TYPE,
            `Invalid item_type "${itemType}". Must be one of: default_font, color, constant, stylebox`);
        }
        const propName = (args.prop_name || args.name) as string;
        if (!propName) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'prop_name (or name) is required');
        }
        const value = args.value;
        if (value === undefined || value === null) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'value is required');
        }
        const themeType = args.theme_type as string | undefined;
        const scenePathParam = args.scene_path as string | undefined;
        const resolvedScenePath = scenePathParam
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePathParam))
          : undefined;
        script = genThemeSetPropertyScript(
          projectPath, themeNodePath,
          itemType as 'default_font' | 'color' | 'constant' | 'stylebox',
          propName, value, themeType, resolvedScenePath,
        );
        break;
      }
      case 'ui_draw_recipe': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const ops = args.ops as DrawOp[];
        if (!Array.isArray(ops)) {
          return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, 'ops must be an array');
        }
        try {
          script = genUiDrawRecipeScript(scenePath, nodePath, ops);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('Unknown draw op kind') || msg.includes('Maximum') || msg.includes('Color must be')) {
            return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_build_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const tree = args.tree as UiNodeSpec;
        if (!tree || typeof tree !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'tree is required and must be an object');
        }
        const persist = args.persist === true;
        // C1: viewport 参数——根节点 rect 的求解基准;非正数(含缺项/NaN)→ INVALID_PARAMS
        let viewport: { w: number; h: number } | undefined;
        if (args.viewport !== undefined) {
          const vp = args.viewport as { w?: unknown; h?: unknown };
          const w = typeof vp.w === 'number' ? vp.w : NaN;
          const h = typeof vp.h === 'number' ? vp.h : NaN;
          if (!(w > 0) || !(h > 0)) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive numbers');
          }
          viewport = { w, h };
        }
        try {
          script = genUiBuildLayoutScript(scenePath, parentPath, tree, viewport, persist);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('INVALID_CONTROL_TYPE')) {
            return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE, msg);
          }
          if (msg.includes('INVALID_ANCHOR_PRESET')) {
            return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET, msg);
          }
          if (msg.includes('name is required') || msg.includes('Maximum nesting') || msg.includes('INVALID_PARAMS')) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_measure_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePathRaw = args.node_path as string | undefined;
        const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 16;
        const expectTree = args.expect_tree as UiNodeSpec | undefined;
        if (expectTree && (typeof expectTree !== 'object' || !expectTree.name)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'expect_tree must be a tree object with name');
        }
        // PR-2:expect_tree 带 styleboxes → 期望清单内嵌 measure 脚本(读回判定并集左侧)
        const styleExpect = expectTree ? styleExpectList(flattenStyleTargets(expectTree)) : undefined;
        script = genUiMeasureScript(scenePath, nodePathRaw ? normalizeNodePath(nodePathRaw) : undefined, maxDepth, styleExpect);
        break;
      }
      case 'ui_pixel_verify':
        // 特殊链路:capture 是独立 spawn(窗口模式 driver 参数不同,spec §5 capture 不并入
        // executor 链),不走公共单次执行段,提前 return——同 ui_import_prototype 模式。
        return await handleUiPixelVerify(args, projectPath, godot);
      case 'ui_import_prototype':
        // 特殊链路:内部单 spawn 合成(build+persist→reload→measure,PR-4),不走公共单次执行段,提前 return。
        return handleUiImportPrototype(args, projectPath, godot, loadAutoloads);
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscriptTrusted({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    let r = parseGdscriptResult(result, [], uiErrorMapper);
    // Task 4: expect_tree 注入——measure 成功输出后,把逐节点 diff/重叠/越界问题清单
    // 并回 data.layout_verify(Pascal verify_scene 模式,数字驱动收敛)。
    if (action === 'ui_measure_layout' && (args.expect_tree as UiNodeSpec | undefined)) {
      const expectTree = args.expect_tree as UiNodeSpec;
      try {
        const parsed = JSON.parse((r.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
          success?: boolean;
          data?: { measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number } } };
          warnings?: string[];
        };
        // 仅成功结果注入:错误/异常输出保持原样,diff 缺失由 AI 视为未验证
        if (parsed.success === true) {
          const measure = parsed.data?.measure;
          const measured = measure?.nodes ?? [];
          const targets = flattenTargets(expectTree);
          // PR-2:expect_tree 同构复用 style_verify(spec §4.1 挂两处之二)
          const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
          const wrapped = {
            targets,
            diff: diffLayout(measured, targets, 2),
            overlaps: detectOverlaps(measured),
            out_of_bounds: detectOutOfBounds(measured),
            // C1: 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
            viewport: measure?.viewport,
          };
          const merged = { ...parsed, data: { ...parsed.data, layout_verify: wrapped,
            style_verify: diffStyles(styleReadings, flattenStyleTargets(expectTree)) } };
          r = { ...r, content: [{ type: 'text', text: JSON.stringify(merged) }] };
        }
      } catch {
        // measure 输出异常时保持原样返回,diff 缺失由 AI 视为未验证
      }
    }
    // persist=true 的 ui_build_layout 已原子写落盘,不再 append "headless 退出即丢" 提示;其余照旧。
    if (UI_PERSIST_ACTIONS.has(action) && !(action === 'ui_build_layout' && args.persist === true)) {
      return appendRuntimePersistWarning(r, action);
    }
    return r;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── ui_import_prototype 内部链(spec §2.3)──────────────────────────────────

/** GDScript error 输出 → 错误码映射(handleTool 公共段与 ui_import_prototype 共用)。 */
const uiErrorMapper = (msg: string) => {
  if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
  if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
  if (msg.includes('no theme')) return ERROR_CODES.THEME_NOT_FOUND;
  if (msg.includes('not a Theme')) return ERROR_CODES.THEME_NOT_FOUND;
  return ERROR_CODES.SCRIPT_EXEC_FAILED;
};

/** geometry/geometry_path 二选一解析(ui_import_prototype 与 ui_pixel_verify 共用):
 * 都给 → geometry 优先 + warning;都不给 → INVALID_PARAMS;geometry_path 经
 * normalizeUserProjectPath + resolveWithinRoot 白名单(越界 INVALID_PARAMS)。 */
function resolveGeometryInput(
  args: Record<string, unknown>,
  projectPath: string,
): { ok: true; rawGeometry: unknown; preWarnings: string[] } | { ok: false; result: ToolResult } {
  const geometryPathRaw = args.geometry_path as string | undefined;
  if (args.geometry !== undefined && args.geometry !== null) {
    const preWarnings: string[] = [];
    if (geometryPathRaw !== undefined) {
      preWarnings.push('geometry 与 geometry_path 同时提供: geometry 优先, geometry_path 被忽略');
    }
    return { ok: true, rawGeometry: args.geometry, preWarnings };
  }
  if (geometryPathRaw !== undefined) {
    let absGeometryPath: string;
    try {
      absGeometryPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(geometryPathRaw));
    } catch (err) {
      return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, `geometry_path 非法: ${getErrorMessage(err)}`) };
    }
    try {
      return { ok: true, rawGeometry: JSON.parse(readFileSync(absGeometryPath, 'utf-8')), preWarnings: [] };
    } catch (err) {
      return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, `geometry_path 文件读取或 JSON 解析失败: ${getErrorMessage(err)}`) };
    }
  }
  return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'geometry 与 geometry_path 必须提供其一') };
}

/**
 * ui_import_prototype 一次调用内部链:zod 校验 → translateGeometry 纯函数翻译 →
 * build(**固定 persist=true**)+persist→reload(CACHE_MODE_IGNORE)→measure **单 spawn 合成**(PR-4,spec §6;原两次 spawn 首版实测 ~6s)。B-1 契约保持:measure(reload)读磁盘场景,不持久化则 verify 全部 actual:null;因此也不入 UI_PERSIST_ACTIONS,无"退出即丢"可提示)→ diffLayout(目标=翻译树)→ 组装 {tree, build_warnings, measure, verify_coverage, layout_verify}。
 */
async function handleUiImportPrototype(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
  loadAutoloads: boolean,
): Promise<ToolResult> {
  const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
  const parentPath = normalizeNodePath((args.parent_path as string) || 'root');

  // geometry / geometry_path 二选一(v2 N-6 白名单前置拦截),提取为 resolveGeometryInput
  // 与 ui_pixel_verify 共用——行为不变,prototype-import 单测保护。
  const resolved = resolveGeometryInput(args, projectPath);
  if (!resolved.ok) return resolved.result;
  const preWarnings = resolved.preWarnings;
  const rawGeometry = resolved.rawGeometry;

  let geo: PrototypeGeometry;
  let translated: TranslateResult;
  try {
    geo = parseGeometry(rawGeometry);
    translated = translateGeometry(geo);
  } catch (err) {
    // parseGeometry/translateGeometry 的非法输入(交叉重叠/等 rect/超限/重名…)均以
    // INVALID_PARAMS 前缀抛出(v2 N-1 拒绝而非静默),原样透传给 AI 修原型侧。
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }

  // tolerance:有限非负数,默认 2(diffLayout 同款语义)
  const tolRaw = args.tolerance;
  const tolerance = typeof tolRaw === 'number' && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 2;

  // viewport:显式优先,默认 geometry.viewport(合成根 rect 的求解基准)
  let viewport = geo.viewport;
  if (args.viewport !== undefined) {
    const vp = args.viewport as { w?: unknown; h?: unknown };
    const w = typeof vp.w === 'number' ? vp.w : NaN;
    const h = typeof vp.h === 'number' ? vp.h : NaN;
    if (!(w > 0) || !(h > 0)) {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive numbers');
    }
    viewport = { w, h };
  }

  // ① 单 spawn 合成(PR-4,spec §6):build→persist→reload(CACHE_MODE_IGNORE)→measure
  // 一次 Godot 进程完成。固定 persist=true 保持 B-1 契约——measure(reload)读的是磁盘
  // 场景,不持久化则 verify 全部 actual:null。reload 阶段错误信息由模板内嵌
  // 「build 已持久化,可重跑 ui_measure_layout」恢复语义(persist 先于 measure),TS 侧
  // 不再二次拼接(原两阶段流程的 hint-append 逻辑随第二次 spawn 一起删除)。
  const styleTargets = flattenStyleTargets(translated.tree);
  const singleScript = genUiImportSingleScript(scenePath, parentPath, translated.tree, viewport, styleExpectList(styleTargets));
  const singleResult = await executeGdscriptTrusted({
    godotPath: godot, projectPath, code: singleScript, timeout: 30, loadAutoloads,
  });
  const parsed = parseGdscriptResult(singleResult, [], uiErrorMapper);
  if (parsed.isError) return parsed;

  let out: {
    data?: {
      persist?: { saved?: boolean };
      warnings?: unknown[];
      measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number }; stable_after_frames?: number; stalled?: boolean };
    };
    warnings?: string[];
  };
  try {
    out = JSON.parse((parsed.content?.[0] as { text?: string } | undefined)?.text ?? '{}');
  } catch {
    return parsed;
  }

  // build_warnings:输入消歧 + 翻译 warnings 透传 + 容差模糊带使用提示 + 生成器 warnings。
  // I-2(声明式修复):parent_path 非 root 时根级 diff 参照系限制提示(diff 算法不改——
  // measure 根级 target 的期望 rect 按视口原点求解,挂载父非原点对齐时恒误报)。
  // 审查遗留②:归一化判定(去尾斜杠)——'root/'/'/root/' 与 '/root' 语义等价,字符串全等
  // 会假阳性多弹 warning;场景根名(如 '/Main')仍保守提示(无害——原点对齐理论差异仍在)。
  const parentIsRoot = parentPath.replace(/\/+$/, '') === '/root';
  const buildWarnings = [
    ...preWarnings,
    ...translated.warnings,
    '使用提示: 避免构造 ≤2px 宽的相邻独立节点(容差模糊带)——verify 容差内兄弟关系与偏移不可区分',
    ...(!parentIsRoot ? [
      `parent_path="${parentPath}" 非 root: layout_verify 根级条目期望 rect 按视口原点求解,挂载父非原点对齐(global_position≈0,0)时根级 diff 恒误报——请确认挂载父原点对齐,或忽略根级条目的 diff 结果`,
    ] : []),
  ];
  for (const w of out.data?.warnings ?? []) {
    buildWarnings.push(typeof w === 'object' && w !== null && 'message' in w ? String((w as { message: unknown }).message) : String(w));
  }
  if (out.data?.persist?.saved !== true) {
    buildWarnings.push('persist 落盘失败(saved=false):measure 读到的是磁盘旧场景,layout_verify 不可信,请排查后重试');
  }

  // ③ 组装返回(单 spawn:measure 与 build 输出同批;输出异常保持原样,diff 缺失由 AI 视为未验证)。
  try {
    const measure = out.data?.measure;
    const measured = measure?.nodes ?? [];
    const targets = flattenTargets(translated.tree);
    const layoutVerify = {
      targets,
      diff: diffLayout(measured, targets, tolerance),
      overlaps: detectOverlaps(measured),
      out_of_bounds: detectOutOfBounds(measured),
      // 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
      viewport: measure?.viewport,
    };
    // PR-2:style_verify(逐槽位样式 diff)+ flow_verify(flow 直接子层数字清单)
    const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
    const styleVerify = diffStyles(styleReadings, styleTargets);
    const flowVerify = diffFlow(measured, translated.flow_expect, tolerance);
    const verifyCoverage = {
      ...translated.coverage,
      _note: 'targets 为受 layout_verify 几何覆盖的节点数(含合成根 _PrototypeRoot,无 flow 时 = 输入节点数+1);flow 直接子节点丢 rect 不在 layout_verify 覆盖内,由 flow_verify 数字覆盖(期望=输入视口 rect);孙层由 layout_verify 近似覆盖(期望相对输入父原点,容器排布后天然带偏移)',
    };
    return textResult(JSON.stringify(opsSuccess({
      tree: translated.tree,
      build_warnings: buildWarnings,
      measure: {
        stable_after_frames: measure?.stable_after_frames,
        stalled: measure?.stalled,
        viewport: measure?.viewport,
      },
      verify_coverage: verifyCoverage,
      layout_verify: layoutVerify,
      style_verify: styleVerify,
      flow_verify: flowVerify,
      persist: out.data?.persist,
    }, out.warnings ?? [])));
  } catch {
    return parsed;
  }
}

/**
 * ui_pixel_verify(spec §5 终验):入参同 import(geometry/geometry_path 二选一 + 必填
 * scene_path 指向 ui_import_prototype persist 产物)→ parseGeometry → runPixelVerify
 * (capture → decode → 采样 → 判定)。不做 translate/translate 产物比对——采样基准是
 * 输入视口 rect(终验前提:layout_verify/style_verify 已全绿,期望≈实测)。
 */
async function handleUiPixelVerify(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
): Promise<ToolResult> {
  const sceneRaw = args.scene_path as string | undefined;
  if (!sceneRaw || !String(sceneRaw).trim()) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'ui_pixel_verify 需要 scene_path 指向已构建场景(ui_import_prototype persist 产物)');
  }
  let scenePath: string;
  try {
    scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(String(sceneRaw)));
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `scene_path 非法: ${getErrorMessage(err)}`);
  }
  const resolved = resolveGeometryInput(args, projectPath);
  if (!resolved.ok) return resolved.result;
  let geo: PrototypeGeometry;
  try {
    geo = parseGeometry(resolved.rawGeometry);
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }
  const r = await runPixelVerify({ godotPath: godot, projectPath, scenePath, geo });
  if (!r.ok) {
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, r.error + (r.hint ? `\nHint: ${r.hint}` : ''));
  }
  return textResult(JSON.stringify(opsSuccess({ pixel_verify: r.summary })));
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  ui: {
    readonly: false,
    long_running: false,
    actionRisks: {
      ui_get_layout: 'read', ui_create_control: 'write', ui_set_layout: 'write',
      ui_anchor_preset: 'write', ui_set_theme: 'write', ui_container_add: 'write',
      ui_draw_recipe: 'write', ui_build_layout: 'write', ui_measure_layout: 'read',
      ui_import_prototype: 'write', ui_pixel_verify: 'write',
      theme_create: 'write', theme_set_property: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
