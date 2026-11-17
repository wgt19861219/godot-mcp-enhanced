import type { Tool } from "@modelcontextprotocol/server";

// UI tool entry point: definitions, handler, and meta.
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { getErrorMessage } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { executeGdscriptTrusted } from '../../gdscript-executor.js';
import { normalizeNodePath, sanitizeResPath, opsErrorResult, parseGdscriptResult, opsSuccess, NON_PERSIST, appendRuntimePersistWarning } from '../shared.js';
import { ACTIONS, CONTROL_TYPES, ANCHOR_PRESETS, ERROR_CODES, DRAW_OP_KINDS, findBlockedProps } from './types.js';
import type { DrawOp, UiNodeSpec } from './types.js';
import { genUiCreateControlScript, genUiContainerAddScript, genUiAnchorPresetScript } from './ui-create.js';
import { genUiSetLayoutScript, genUiGetLayoutScript, genUiBuildLayoutScript } from './ui-layout.js';
import { genUiSetThemeScript, genThemeCreateScript, genThemeSetPropertyScript } from './ui-theme.js';
import { genUiDrawRecipeScript } from './ui-draw.js';
import { genUiMeasureScript, checkViewportEffect } from './ui-measure.js';
import { genUiImportSingleScript } from './ui-import-single.js';
import { flattenTargets, flattenStyleTargets, styleExpectList, diffLayout, diffStyles, diffFlow, detectOverlaps, detectOutOfBounds, compactDiffEntries, compactStyleEntries } from './layout-diff.js';
import type { MeasuredNode } from './layout-diff.js';
import { buildQualityReport, compactReportSections } from './quality-check.js';
import { parseAuthoredGeometry, planRebase, applyRebasePatch } from './anchor-rebase.js';
import { parseGeometry, translateGeometry, resolveGeometryTokens, hasTokenRefs } from './prototype-import.js';
import type { PrototypeGeometry, TranslateResult, TokenColorMap } from './prototype-import.js';
import { runPixelVerify } from './pixel-verify.js';
import { genTokenPrefetchScript, genTokenSetScript, genTokenListScript } from './ui-tokens.js';
import { genExtractTreeScript, extractTreeReport, genDraftSaveScript } from './ui-extract.js';
import type { ExtractScanNode } from './ui-extract.js';
import { genThemeInspectScript, buildDesignDoc } from './ui-export.js';
import type { ThemeInspect } from './ui-export.js';
import { textResult } from '../../types.js';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui',
      description: `UI 操作。节点: ui_create_control, ui_container_add, ui_build_layout。布局: ui_set/get/measure_layout, ui_anchor_preset。原型: ui_import_prototype(几何 JSON 一次调用翻译+构建+测量+校验+持久化;样式→StyleBoxFlat;返回 style_verify/flow_verify)。像素终验: ui_pixel_verify(bg 节点截图采样 vs 目标色 RGB 距离;Windows 窗口模式会弹窗)。锚点改造: solve_from_current(既有场景反解比例锚点+浮点 offset,tscn 文本 patch 保注释,dry_run 默认 true 只出计划)。主题: ui_set_theme, theme_create, theme_set_property。设计 token: token_set(写 DesignTokens 落盘), token_list(审计全量)。样式逆向: extract_tree(整树 override 扫描→聚类报告,可选 Theme 草稿), export_doc(Theme 巡检→DESIGN.md 视图,只读不落盘)。绘图: ui_draw_recipe。${NON_PERSIST}(例外: theme_create(save_path)/token_set 直接落盘资源文件;extract_tree 带 draft_path 落草稿)`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: '项目目录（默认 GODOT_PROJECT_PATH 或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。build_layout=CSS 布局翻译构建(推荐), import_prototype=原型导入, pixel_verify=像素验证, create_control/container_add/anchor_preset=控件, set/get/measure_layout=布局, solve_from_current=既有场景锚点改造, draw_recipe=绘制, theme_*=主题, token_set/token_list=设计 token, extract_tree=整树样式逆向(可选草稿), export_doc=设计文档导出',
          },
          scene_path: { type: 'string', description: '场景路径（相对项目）。ui_set_theme/theme_set_property 可选;ui_pixel_verify 必填(已构建场景);solve_from_current 必填(res://)' },
          node_path: { type: 'string', description: '节点路径（set/get_layout/anchor_preset/set_theme/container_add/draw_recipe;solve_from_current 可选(子树)）' },
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
          theme_path: { type: 'string', description: 'ui_set_theme: Theme 资源路径(save/load 时必填);ui_measure_layout/ui_import_prototype: measure 前挂载到 root,主题敏感场景必传(theme_type_variation 节点字号需主题语境,显式挂载不依赖项目 autoload);ui_import_prototype/ui_pixel_verify: $token 解析源(theme DesignTokens colors);token_set/token_list: token 读写目标主题(必填,须已存在);export_doc: 导出目标主题(必填,巡检+DESIGN.md 视图)' },
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
          token_name: { type: 'string', description: 'token_set: token 名(白名单 ^[A-Za-z_][A-Za-z0-9_-]*$,与 $name 引用语法一致)' },
          token_value: {
            description: 'token_set: token 值——color 形态 [r,g,b] 或 [r,g,b,a]（0-1，元素须有限数）或数字常量（有限数）',
          },
          draft_path: { type: 'string', description: 'extract_tree: 可选 Theme 草稿落盘路径(.tres,相对项目;缺省只回报告' },
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
            description: 'ui_import_prototype/ui_pixel_verify: 原型几何 JSON(inline {viewport,nodes} 扁平视口坐标;与 geometry_path 二选一,本参优先)。样式字段:bg/fill(ProgressBar fill 槽色)/borderRadius(number 或 {tl,tr,br,bl})/border({width,color})→StyleBoxFlat 四控件槽位;颜色字段(bg/color/fill/border.color)可 "$name" 引用 theme DesignTokens token(须配 theme_path;import/pixel_verify 均支持;有引用时多一次 Godot 预取 spawn);perSides 单边差异等细节见规则文档',
            additionalProperties: true,
          },
          geometry_path: { type: 'string', description: 'ui_import_prototype/ui_pixel_verify: 几何 JSON 文件路径(相对项目,支持 res://;与 geometry 二选一)' },
          tolerance: { type: 'number', description: 'ui_import_prototype: layout_verify 容差(px,默认 2)' },
          detail: {
            type: 'string',
            enum: ['compact', 'extended'],
            description: 'ui_measure_layout(带 expect_tree)/ui_import_prototype: compact=verify 各节只返回不 ok 条目 top 20(按偏差量排序)+计数 summary,被压缩数组变为 {entries,summary} 对象;默认 extended 全量',
          },
          parent_path: { type: 'string', description: 'ui_build_layout: 父节点路径;ui_import_prototype: 须原点对齐节点(默认 root)——非原点挂载时 layout_verify 根级 diff 恒误报' },
          tree: {
            type: 'object',
            description: 'ui_build_layout: UI 节点树(最大深度 10);节点可带 styleboxes:[{slot: panel|normal|background|fill|hover|pressed|disabled, box: {bg_color:[r,g,b,a]0-1, corner_radius: 数值或{tl,tr,br,bl}, border_width, border_color, draw_center}}]→add_theme_stylebox_override',
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
          load_autoloads: { type: 'boolean', description: '加载 Autoload（默认 true）' },
          viewport: {
            type: 'object',
            description: 'ui_build_layout: 根 rect 求解基准 {w,h}(默认 1280x720;与项目窗口一致=视口几何);ui_import_prototype: 默认取 geometry.viewport;ui_measure_layout: 覆写测量视口(SubViewport 尺寸,正整数;注入重排;生效性见 data.measure.viewport_check,inconclusive 勿信);solve_from_current: 场景根直接子父尺寸兜底(父尺寸无法从 tscn 解析时以视口为父;须与项目视口一致,正整数)',
            properties: { w: { type: 'number', description: '宽(px)' }, h: { type: 'number', description: '高(px)' } },
          },
          persist: { type: 'boolean', description: 'ui_build_layout: 持久化到 .tscn（原子写；默认 false 运行时）' },
          include: {
            type: 'array', items: { type: 'string' },
            description: 'solve_from_current: 节点名白名单',
          },
          exclude: {
            type: 'array', items: { type: 'string' },
            description: 'solve_from_current: 节点名黑名单(优先于 include)',
          },
          dry_run: { type: 'boolean', description: 'solve_from_current: 默认 true 只出计划;false 写盘' },
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
    // Task 5(批1 1d):solve_from_current 纯 TS 文本 patch,不 spawn Godot——在 findGodot
    // 之前分流(无 Godot 环境也可用;dry_run 只读)。写盘链路见 handleSolveFromCurrent。
    if (action === 'solve_from_current') {
      return await handleSolveFromCurrent(args, projectPath, ctx);
    }
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    // 批4 Task2:verify 分档——仅 detail==='compact' 走压缩路径;缺省/extended 逐字节不变
    const detailCompact = args.detail === 'compact';
    let script: string;
    // Task 2(批1 1a):ui_measure_layout 的 viewport 覆写(假绿防护后处理读)
    let measureViewport: { w: number; h: number } | undefined;

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
      case 'token_set': {
        // 批3 Task 4:theme DesignTokens token 文件级写入(原子落盘)。校验全部前置在
        // spawn 前(白名单/有限数守卫),非法输入零 Godot 开销。
        const themePath = args.theme_path as string | undefined;
        if (!themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path is required for token_set action');
        }
        try { sanitizeResPath(themePath, 'theme_path'); } catch {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
        }
        const tokenName = args.token_name as string | undefined;
        // 白名单与 $name 引用语法(TOKEN_REF_RE)一致:首字符字母/下划线,余字符字母/数字/下划线/连字符
        if (!tokenName || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tokenName)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `token_name must match ^[A-Za-z_][A-Za-z0-9_-]*$ (got: ${JSON.stringify(tokenName ?? null)})`);
        }
        const tokenValue = args.token_value;
        if (Array.isArray(tokenValue)) {
          // color 形态:3-4 元有限数(不足/超出/非数/NaN 全拒,防 Color(NaN,...) 无效 GDScript)
          const nums = tokenValue as unknown[];
          if (nums.length < 3 || nums.length > 4 || !nums.every(n => typeof n === 'number' && Number.isFinite(n))) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
              'token_value color form must be [r, g, b] or [r, g, b, a] with finite numbers 0-1');
          }
        } else if (typeof tokenValue !== 'number' || !Number.isFinite(tokenValue)) {
          // constant 形态:有限数(字符串/NaN/Infinity 全拒,防 set_constant(..., NaN))
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            'token_value must be a color array [r,g,b](,[a]) 0-1 or a finite number constant');
        }
        script = genTokenSetScript(themePath, tokenName, tokenValue);
        break;
      }
      case 'token_list': {
        // 批3 Task 4:theme DesignTokens token 全量审计(只读)。
        const themePath = args.theme_path as string | undefined;
        if (!themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path is required for token_list action');
        }
        try { sanitizeResPath(themePath, 'theme_path'); } catch {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
        }
        script = genTokenListScript(themePath);
        break;
      }
      case 'extract_tree':
        // 特殊链(批4 Task 3):可能两次 spawn(扫描→聚类→可选草稿落盘),不走公共单次执行段,
        // 提前 return——同 ui_import_prototype 模式。
        return await handleExtractTree(args, projectPath, godot, loadAutoloads);
      case 'export_doc':
        // 特殊链(批4 Task 3):spawn 巡检 → TS 侧 buildDesignDoc 组装响应(非 GD 原样输出)。
        return await handleExportDoc(args, projectPath, godot, loadAutoloads);
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
        if (args.viewport != null) {
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
        // 批1 1a:theme_path 挂载(sanitize 同 ui_set_theme 先例——路径进 load(),防穿越)
        const themePath = args.theme_path as string | undefined;
        if (themePath) {
          try { sanitizeResPath(themePath, 'theme_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
          }
        }
        // Task 2(批1 1a):viewport 覆写(g800 复测通道)——正整数校验(brief Interfaces),
        // 同 build C1 先例在 handler 侧拒,生成器只接已校验值
        const nodePathNorm = nodePathRaw ? normalizeNodePath(nodePathRaw) : undefined;
        if (args.viewport != null) {
          const vp = args.viewport as { w?: unknown; h?: unknown };
          const w = typeof vp.w === 'number' ? vp.w : NaN;
          const h = typeof vp.h === 'number' ? vp.h : NaN;
          if (!(Number.isInteger(w) && w > 0) || !(Number.isInteger(h) && h > 0)) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive integers');
          }
          measureViewport = { w, h };
        }
        script = genUiMeasureScript(scenePath, nodePathNorm, maxDepth, styleExpect,
          measureViewport ? { themePath, viewport: measureViewport } : { themePath });
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
    // 批2 Task4(终审顺手项):measure 后处理合并为单次 parse/单次重写——原三段(expect_tree
    // 注入/viewport_check/quality+order 挂节,批1 Task1/2/4 分段累积)各自 JSON.parse 全响应
    // 再重写,大响应重复解析浪费;现共享同一份 parsed 逐段就地修改、任一段有产出才一次
    // 回写,段内条件与原三段一一对应(行为等价)。import 链(handleUiImportPrototype)本就
    // 单次 parse 组装输出,无同款可并。
    if (action === 'ui_measure_layout' && ((args.expect_tree as UiNodeSpec | undefined) || !r.isError)) {
      const expectTree = args.expect_tree as UiNodeSpec | undefined;
      try {
        const parsed = JSON.parse((r.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
          success?: boolean;
          warnings?: string[];
          data?: {
            measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number }; stalled?: boolean; theme_constants?: Record<string, number>; viewport_check?: string };
            layout_verify?: unknown;
            style_verify?: unknown;
            quality?: unknown;
            order?: unknown;
          };
        };
        let mutated = false;
        // 仅成功结果注入:错误/异常输出保持原样,diff 缺失由 AI 视为未验证(原三段共同契约)。
        // 各段独立 try/catch——段内处理函数抛错只弃该段,后续段照常(原三段各自 try/catch
        // 的等价保持;赋值均为整体表达式,抛错时赋值不发生,段内原子性同旧版 merged 局部量)。
        if (parsed.success === true) {
          // ── 段1(批1 Task4):expect_tree 注入——逐节点 diff/重叠/越界问题清单并回
          // data.layout_verify(Pascal verify_scene 模式,数字驱动收敛);PR-2:expect_tree
          // 同构复用 style_verify(spec §4.1 挂两处之二)。
          if (expectTree) {
            try {
              const measure = parsed.data?.measure;
              const measured = measure?.nodes ?? [];
              const targets = flattenTargets(expectTree);
              const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
              // 批4 Task2:compact 分支内对象化(diff/style 条目过滤+偏差量排序+截断);
              // extended(缺省)路径值与原表达式逐字节一致
              const diffAll = diffLayout(measured, targets, 2);
              const styleAll = diffStyles(styleReadings, flattenStyleTargets(expectTree));
              parsed.data = {
                ...parsed.data,
                layout_verify: {
                  targets,
                  diff: detailCompact ? compactDiffEntries(diffAll) : diffAll,
                  overlaps: detectOverlaps(measured),
                  out_of_bounds: detectOutOfBounds(measured),
                  // C1: 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
                  viewport: measure?.viewport,
                },
                style_verify: detailCompact ? compactStyleEntries(styleAll) : styleAll,
                ...(detailCompact ? { detail: 'compact' } : {}),
              };
              mutated = true;
            } catch {
              // 段1 弃置,后续段照常(原段1 catch 同款)
            }
          }
          // ── 段2(批1 Task2)假绿防护(Review Focus 2):viewport 覆写生效性检查。上报
          // viewport 值被注入覆写,本身不构成布局证据——checkViewportEffect 判据(独立于
          // 上报值):全铺节点(anchor 0→1)rect.w 贴合注入视口宽 = 直接证据(e2e 硬断言的
          // TS 版)。brief 预设的"非全铺节点相对默认视口基线变化"辅判据**实测弃用**:默认
          // 视口基线只能挂 root 取,与覆写轮的 SubViewport 通道语境不同(headless Window
          // 尺寸不可信 + stretch 字体度量失真,实测 Label 自适应 h/w 20↔23、56↔64 类噪声)
          // ——非视口变化会被误读为视口生效,假绿检测器自身假绿。故主判据未命中即
          // inconclusive(诚实降级,checkViewportEffect 的 baseline 形参保留给未来干净的
          // 同通道基线),附指引不得静默。
          if (!r.isError && measureViewport && parsed.data?.measure) {
            try {
              const verdict = checkViewportEffect(parsed.data.measure.nodes ?? [], measureViewport);
              const warnings = [...(parsed.warnings ?? [])];
              if (verdict === 'inconclusive') {
                warnings.push('viewport_check: inconclusive —— 测量结果中无全铺节点(anchor 0→1)rect.w 贴合注入视口宽,无法确认布局按注入视口重排(上报 viewport 值不可作为布局证据)。硬证据请用含全铺节点的场景复核,或窗口模式 run_project + dump_layout_tree(g800 复测通道)');
              }
              parsed.warnings = warnings;
              parsed.data = { ...parsed.data, measure: { ...parsed.data.measure, viewport_check: verdict } };
              mutated = true;
            } catch {
              // 段2 弃置,后续段照常(原段2 catch 同款)
            }
          }
          // ── 段3(批1 1c):quality/order 报告节——四类品质检查(裸壳/应跟随/等距组/
          // 溢出)聚合挂节。D8 输出纪律:stalled !== true 且对应节有发现才挂(无发现省略
          // 字段,null 语义);stalled 时不出判定只报 stalled(调用方契约,buildQualityReport
          // 注释同款)。视口溢出以 measure.viewport 为参照系;建议文案指向 solve_from_current/
          // 容器化。批2 Task2:measure 输出带 theme_constants 时提取 space_* 档位传入
          // (无声明跳过)。
          if (!r.isError && parsed.data?.measure) {
            try {
              const m = parsed.data.measure;
              const spacingScale = spacingScaleFromTheme(m.theme_constants);
              const report = m.stalled === true ? null : buildQualityReport(m.nodes ?? [], { viewport: m.viewport, ...(spacingScale ? { spacingScale } : {}) });
              if (report?.quality || report?.order) {
                // 批4 Task2:compact 分支内列表字段对象化(报告序截断),extended 逐字节一致
                const compacted = detailCompact && report ? compactReportSections(report) : null;
                parsed.data = {
                  ...parsed.data,
                  ...(report?.quality ? { quality: compacted?.quality ?? report.quality } : {}),
                  ...(report?.order ? { order: compacted?.order ?? report.order } : {}),
                  ...(detailCompact ? { detail: 'compact' } : {}),
                };
                mutated = true;
              }
            } catch {
              // 段3 弃置(原段3 catch 同款)
            }
          }
        }
        if (mutated) {
          r = { ...r, content: [{ type: 'text', text: JSON.stringify(parsed) }] };
        }
      } catch {
        // measure 输出异常时保持原样返回,diff 缺失由 AI 视为未验证(原三段同款契约)
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

// ─── solve_from_current 内部链(批1 1d Task5)────────────────────────────────

/** 批2 Task2:从 measure 导出的 DesignTokens constants 提取间距档位——键名约定
 * space_*(如 space_1..space_8,spec 批2 节),取值升序去重;无 theme_constants 或无
 * space_* 键 → undefined(调用方跳过档位检测,无声明不发噪音)。 */
function spacingScaleFromTheme(tc: Record<string, number> | undefined): number[] | undefined {
  if (!tc) return undefined;
  const vals = Object.entries(tc)
    .filter(([k, v]) => k.startsWith('space_') && Number.isFinite(v))
    .map(([, v]) => v);
  if (vals.length === 0) return undefined;
  return [...new Set(vals)].sort((a, b) => a - b);
}

/** include/exclude 节点名白名单校验(Godot 节点名约束,防非法名进后续匹配)。 */
function validateNameList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(`INVALID_PARAMS: ${field} must be an array of node names`);
  }
  for (const item of v) {
    if (typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
      throw new Error(`INVALID_PARAMS: ${field} contains invalid node name: ${JSON.stringify(item)} (must match ^[A-Za-z_][A-Za-z0-9_]*$)`);
    }
  }
  return v as string[];
}

/**
 * solve_from_current:既有场景锚点改造(批1 1d)——授权几何解析 → planRebase 反解
 * (f32 感知,引擎重算位级恒等,见 anchor-rebase.ts 头注)→ dry_run 默认 true 只出计划;
 * dry_run=false 段落级文本 patch 原子写(tmp+rename;仅动目标 [node] 段内布局行,段外
 * 字节与注释不动)。scene_path 必填 res:// 形式且过 sanitizeResPath。
 */
async function handleSolveFromCurrent(
  args: Record<string, unknown>,
  projectPath: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const sceneRaw = args.scene_path as string | undefined;
  if (!sceneRaw || !String(sceneRaw).trim()) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'solve_from_current 需要 scene_path(res:// 形式,指向待改造场景)');
  }
  try { sanitizeResPath(sceneRaw, 'scene_path'); } catch {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'scene_path contains path traversal');
  }
  let absPath: string;
  try { absPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(sceneRaw)); } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `scene_path 非法: ${getErrorMessage(err)}`);
  }
  if (!existsSync(absPath)) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `scene file not found: ${sceneRaw}`);
  }
  const text = readFileSync(absPath, 'utf-8');
  const parsedGeo = parseAuthoredGeometry(text);

  // node_path → subtree(measure 风格路径;剥 /root 前缀与场景根名,add_node B2 同款剥离链)
  let subtree: string | undefined;
  const npRaw = args.node_path as string | undefined;
  if (npRaw !== undefined && npRaw !== null && String(npRaw).trim() !== '') {
    const np = normalizeNodePath(String(npRaw));
    let cleaned: string;
    if (np === '/root') cleaned = '';
    else if (np.startsWith('/root/')) cleaned = np.slice('/root/'.length);
    else cleaned = np.replace(/^\//, '');
    const rootName = parsedGeo.find(n => n.parentPath === '')?.name;
    if (rootName && cleaned === rootName) cleaned = '';
    else if (rootName && cleaned.startsWith(rootName + '/')) cleaned = cleaned.slice(rootName.length + 1);
    subtree = cleaned;
    if (subtree !== '' && !parsedGeo.some(n => n.path === subtree)) {
      return opsErrorResult(ERROR_CODES.NODE_NOT_FOUND, `node_path 未在场景中找到: ${String(npRaw)}(解析为子树 "${subtree}")`);
    }
  }

  let include: string[] | undefined;
  let exclude: string[] | undefined;
  try {
    include = validateNameList(args.include, 'include');
    exclude = validateNameList(args.exclude, 'exclude');
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }

  // 批2 Task1:viewport 形参——场景根直接子的父尺寸兜底。handler 校验正整数
  // (Number.isInteger && >0,同 ui_measure_layout viewport 先例),planRebase 层再做
  // 正数守卫(纯函数自洽,不依赖调用方)。
  let viewport: { w: number; h: number } | undefined;
  if (args.viewport != null) {
    const vp = args.viewport as { w?: unknown; h?: unknown };
    const w = typeof vp.w === 'number' ? vp.w : NaN;
    const h = typeof vp.h === 'number' ? vp.h : NaN;
    if (!(Number.isInteger(w) && w > 0) || !(Number.isInteger(h) && h > 0)) {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive integers');
    }
    viewport = { w, h };
  }

  const plan = planRebase(parsedGeo, { include, exclude, subtree }, viewport ? { viewport } : undefined);
  const planPayload = {
    subtree: subtree ?? null,
    viewport: viewport ?? null,
    toWrite: plan.toWrite,
    skippedContainerChildren: plan.skippedContainerChildren,
    skippedByFilter: plan.skippedByFilter,
    skippedUnresolvedParent: plan.skippedUnresolvedParent,
    skippedNoGeometry: plan.skippedNoGeometry,
  };
  const dryRun = args.dry_run !== false;   // 默认 true——先看计划再写盘
  if (dryRun) {
    return textResult(JSON.stringify(opsSuccess({
      dry_run: true, scene: sceneRaw, ...planPayload,
      note: 'dry_run 默认 true:只返回计划不写盘;确认后传 dry_run=false 执行 tscn 文本 patch(注释保留)',
    })));
  }

  // 写盘前编辑器场景守卫(同 add_node P1-2:防覆盖编辑器内存状态)
  if (ctx.checkEditorSceneSave) {
    const guard = await ctx.checkEditorSceneSave(absPath);
    if (guard.blocked) {
      return opsErrorResult('EDITOR_SCENE_OPEN', guard.message ?? `Scene open in editor: ${absPath}`);
    }
  }
  const patch = applyRebasePatch(text, plan.toWrite);
  if (patch.patched === 0) {
    return textResult(JSON.stringify(opsSuccess({
      dry_run: false, written: 0, scene: sceneRaw, ...planPayload,
    }, patch.warnings)));
  }
  // 原子写:tmp → rename(patch 语义下 rename 覆盖目标);写前清残留 tmp——上次 rename 前崩溃可能遗留 .mcp-rebase-tmp(存在才删,失败忽略)
  const tmpPath = absPath + '.mcp-rebase-tmp';
  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath); } catch { /* 清理失败不阻断写盘 */ }
  }
  writeFileSync(tmpPath, patch.text, 'utf-8');
  renameSync(tmpPath, absPath);
  return textResult(JSON.stringify(opsSuccess({
    dry_run: false, written: patch.patched, scene: sceneRaw, ...planPayload,
  }, patch.warnings)));
}

// ─── ui_import_prototype 内部链(spec §2.3)──────────────────────────────────

/** GDScript error 输出 → 错误码映射(handleTool 公共段与 ui_import_prototype 共用)。 */
const uiErrorMapper = (msg: string) => {
  // 批3 Task 4:'theme file not found'(genTokenSetScript/genTokenListScript 的缺失分支)
  // → THEME_NOT_FOUND。该消息**含 'not found'**,排在通用 NODE_NOT_FOUND 分支会被截胡,
  // 故必须前置;与下方 'load failed' 子串不相交,相对位置无谓。
  if (msg.includes('theme file not found')) return ERROR_CODES.THEME_NOT_FOUND;
  if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
  // 批3 Task 3:theme_path load failed(genTokenPrefetchScript/genThemeMountInit 的 null/
  // 非 Theme 分支)→ THEME_NOT_FOUND。**全前缀匹配**而非 'load failed' 子串——后者会
  // 误伤 ui-import-single.ts 的 "Scene reload failed (post-persist): ..."(import 链
  // reload 失败应回落 SCRIPT_EXEC_FAILED,终审 Important-1 收紧)。
  if (msg.includes('theme_path load failed')) return ERROR_CODES.THEME_NOT_FOUND;
  if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
  if (msg.includes('no theme')) return ERROR_CODES.THEME_NOT_FOUND;
  if (msg.includes('not a Theme')) return ERROR_CODES.THEME_NOT_FOUND;
  return ERROR_CODES.SCRIPT_EXEC_FAILED;
};

// ─── 批3 Task 3: $token 预取共享辅助(import/pixel_verify 双链)──────────────

/** tokens_resolved 形状:预取发生才挂(无 $ 引用不挂);refs = geometry 内 $ 引用次数
 * (四字段 color/bg/fill/border.color 逐次计数,不去重);tokens = 去重后已解析 token 名
 * (与主题总 token 数解耦——只报本次用到的,可审计)。 */
interface TokensResolvedInfo {
  theme_path: string;
  refs: number;
  tokens: string[];
}

type TokenResolveOutcome =
  | { ok: true; geo: PrototypeGeometry; tokensInfo?: TokensResolvedInfo }
  | { ok: false; result: ToolResult };

/**
 * 批3 Task 3:$token 预取解析共享辅助(handleUiImportPrototype 与 handleUiPixelVerify
 * 调用)。链路:sanitize 上移 → `hasTokenRefs` 为 false 直接透传(**零 spawn**,无 $ 的
 * 既有调用零开销零行为变化);true 而 theme_path 缺 → INVALID_PARAMS(附 DesignTokens
 * 约定路径指引);有 → `genTokenPrefetchScript` 预取 spawn(**loadAutoloads: false**
 * ——脚本只 load 资源,不跑 autoload,省启动;timeout 30)→ parseGdscriptResult
 * (error 输出经 uiErrorMapper 的 'theme_path load failed' → THEME_NOT_FOUND 分流)→ 从
 * `out.data.token_map.colors` 取 map → `resolveGeometryTokens` 换字面量。
 * resolveGeometryTokens 抛错(TOKEN_NOT_FOUND/INVALID_PARAMS)**不在本辅助内 catch**——
 * 冒给调用方的既有 catch 按消息前缀分流(两个 handler 的分流锚,单测锁定)。
 * theme 无 DesignTokens type(裸 Theme)→ 预取返回空 map → 缺键路径 TOKEN_NOT_FOUND。
 */
async function resolveTokensForGeometry(
  geo: PrototypeGeometry,
  themePathRaw: string | undefined,
  projectPath: string,
  godot: string,
): Promise<TokenResolveOutcome> {
  if (!hasTokenRefs(geo)) return { ok: true, geo };
  if (!themePathRaw) {
    return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS,
      '$token 引用需要提供 theme_path(DesignTokens 约定路径 res://ui/theme.tres)') };
  }
  try { sanitizeResPath(themePathRaw, 'theme_path'); } catch {
    return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal') };
  }
  const prefetch = await executeGdscriptTrusted({
    godotPath: godot, projectPath, code: genTokenPrefetchScript(themePathRaw), timeout: 30, loadAutoloads: false,
  });
  const parsed = parseGdscriptResult(prefetch, [], uiErrorMapper);
  if (parsed.isError) return { ok: false, result: parsed };

  // token_map 提取:GD _mcp_output("token_map", JSON.stringify({colors})) 经
  // parseGdscriptResult 落 data.token_map(measure 链 theme_constants 同款通道)。
  let colors: TokenColorMap;
  try {
    const out = JSON.parse((parsed.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
      data?: { token_map?: { colors?: unknown } };
    };
    colors = (out.data?.token_map?.colors ?? {}) as TokenColorMap;
  } catch {
    return { ok: false, result: opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, 'token_map 输出解析失败(非合法 JSON)') };
  }

  // refs/tokens 统计(输入侧 $ 引用;四字段逐次计数)
  const refNames: string[] = [];
  for (const nd of geo.nodes) {
    for (const v of [nd.color, nd.bg, nd.fill, nd.border?.color]) {
      if (typeof v === 'string' && v.startsWith('$')) refNames.push(v.slice(1));
    }
  }
  // resolve 抛错冒给调用方(前缀分流);值形状校验在 resolveTokenColor 逐值做
  const resolved = resolveGeometryTokens(geo, { map: colors, themePath: themePathRaw });
  return {
    ok: true,
    geo: resolved,
    tokensInfo: { theme_path: themePathRaw, refs: refNames.length, tokens: [...new Set(refNames)] },
  };
}

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
  try {
    geo = parseGeometry(rawGeometry);
  } catch (err) {
    // parseGeometry 的非法输入(schema 违规)以 INVALID_PARAMS 前缀抛出(v2 N-1 拒绝
    // 而非静默),原样透传给 AI 修原型侧。
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }

  // tolerance:有限非负数,默认 2(diffLayout 同款语义)
  const tolRaw = args.tolerance;
  const tolerance = typeof tolRaw === 'number' && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 2;

  // 批1 1a:theme_path 挂载透传进合成脚本(_measure_go 注入;sanitize 同 ui_set_theme 先例)
  const themePath = args.theme_path as string | undefined;
  if (themePath) {
    try { sanitizeResPath(themePath, 'theme_path'); } catch {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
    }
  }

  // viewport:显式优先,默认 geometry.viewport(合成根 rect 的求解基准)
  let viewport = geo.viewport;
  if (args.viewport != null) {
    const vp = args.viewport as { w?: unknown; h?: unknown };
    const w = typeof vp.w === 'number' ? vp.w : NaN;
    const h = typeof vp.h === 'number' ? vp.h : NaN;
    if (!(w > 0) || !(h > 0)) {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive numbers');
    }
    viewport = { w, h };
  }

  // 批3 Task 3:$token 预取解析 + 翻译。预取在辅助内完成(有 $ 才 spawn,无 $ 零开销
  // 透传);resolveGeometryTokens 抛错(TOKEN_NOT_FOUND/INVALID_PARAMS)与 translateGeometry
  // 的既有非法输入同 catch **按消息前缀分流**——TOKEN_NOT_FOUND 前缀单独成码(缺键点名
  // token 与 theme 路径),其余保持 INVALID_PARAMS 透传修原型侧。
  let translated: TranslateResult;
  let tokensInfo: TokensResolvedInfo | undefined;
  try {
    const outcome = await resolveTokensForGeometry(geo, themePath, projectPath, godot);
    if (!outcome.ok) return outcome.result;
    translated = translateGeometry(outcome.geo);
    tokensInfo = outcome.tokensInfo;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.startsWith('TOKEN_NOT_FOUND')) return opsErrorResult(ERROR_CODES.TOKEN_NOT_FOUND, msg);
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
  }

  // ① 单 spawn 合成(PR-4,spec §6):build→persist→reload(CACHE_MODE_IGNORE)→measure
  // 一次 Godot 进程完成。固定 persist=true 保持 B-1 契约——measure(reload)读的是磁盘
  // 场景,不持久化则 verify 全部 actual:null。reload 阶段错误信息由模板内嵌
  // 「build 已持久化,可重跑 ui_measure_layout」恢复语义(persist 先于 measure),TS 侧
  // 不再二次拼接(原两阶段流程的 hint-append 逻辑随第二次 spawn 一起删除)。
  const styleTargets = flattenStyleTargets(translated.tree);
  const singleScript = genUiImportSingleScript(scenePath, parentPath, translated.tree, viewport, styleExpectList(styleTargets), themePath);
  const singleResult = await executeGdscriptTrusted({
    godotPath: godot, projectPath, code: singleScript, timeout: 30, loadAutoloads,
  });
  const parsed = parseGdscriptResult(singleResult, [], uiErrorMapper);
  if (parsed.isError) return parsed;

  let out: {
    data?: {
      persist?: { saved?: boolean };
      warnings?: unknown[];
      measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number }; stable_after_frames?: number; stalled?: boolean; theme_constants?: Record<string, number> };
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
  // 批4 Task2:verify 分档——compact 分支内 diff/style/flow 对象化 + quality/order 列表
  // 字段对象化 + data.detail 挂出;extended(缺省)路径值与原表达式逐字节一致(形态纪律)。
  const detailCompact = args.detail === 'compact';
  try {
    const measure = out.data?.measure;
    const measured = measure?.nodes ?? [];
    const targets = flattenTargets(translated.tree);
    const diffAll = diffLayout(measured, targets, tolerance);
    const layoutVerify = {
      targets,
      diff: detailCompact ? compactDiffEntries(diffAll) : diffAll,
      overlaps: detectOverlaps(measured),
      out_of_bounds: detectOutOfBounds(measured),
      // 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
      viewport: measure?.viewport,
    };
    // PR-2:style_verify(逐槽位样式 diff)+ flow_verify(flow 直接子层数字清单)
    const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
    const styleAll = diffStyles(styleReadings, styleTargets);
    const styleVerify = detailCompact ? compactStyleEntries(styleAll) : styleAll;
    const flowAll = diffFlow(measured, translated.flow_expect, tolerance);
    const flowVerify = detailCompact ? compactDiffEntries(flowAll) : flowAll;
    const verifyCoverage = {
      ...translated.coverage,
      _note: 'targets 为受 layout_verify 几何覆盖的节点数(含合成根 _PrototypeRoot,无 flow 时 = 输入节点数+1);flow 直接子节点丢 rect 不在 layout_verify 覆盖内,由 flow_verify 数字覆盖(期望=输入视口 rect);孙层由 layout_verify 近似覆盖(期望相对输入父原点,容器排布后天然带偏移)',
    };
    // Task 4(批1 1c):quality/order 报告节(D8:stalled !== true 且有发现才挂;
    // 视口溢出以 measure.viewport 为参照系;建议文案指向 solve_from_current/容器化)。
    // 批2 Task2:import 链 GD 侧暂不导出 theme_constants(ui-import-single 不向
    // genUiMeasureScript 传 themePath,_emit 无导出段)→ spacingScale 恒 undefined
    // 跳过档位检测;接线与 measure 链对称,将来打通数据源即自动生效。
    const importScale = spacingScaleFromTheme(measure?.theme_constants);
    const qualityReport = measure?.stalled === true
      ? null
      : buildQualityReport(measured, { viewport: measure?.viewport, ...(importScale ? { spacingScale: importScale } : {}) });
    const compacted = detailCompact && qualityReport ? compactReportSections(qualityReport) : null;
    return textResult(JSON.stringify(opsSuccess({
      tree: translated.tree,
      // 批3 Task 3:预取发生才挂(无 $ 引用省略字段);refs/tokens 与主题总 token 数解耦,可审计
      ...(tokensInfo ? { tokens_resolved: tokensInfo } : {}),
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
      ...(qualityReport?.quality ? { quality: compacted?.quality ?? qualityReport.quality } : {}),
      ...(qualityReport?.order ? { order: compacted?.order ?? qualityReport.order } : {}),
      persist: out.data?.persist,
      ...(detailCompact ? { detail: 'compact' } : {}),
    }, out.warnings ?? [])));
  } catch {
    return parsed;
  }
}

/**
 * ui_pixel_verify(spec §5 终验):入参同 import(geometry/geometry_path 二选一 + 必填
 * scene_path 指向 ui_import_prototype persist 产物)→ parseGeometry →(批3 Task 3:$token
 * 预取解析,同 import 链辅助)→ runPixelVerify(capture → decode → 采样 → 判定)。
 * 不做 translate/translate 产物比对——采样基准是输入视口 rect(终验前提:
 * layout_verify/style_verify 已全绿,期望≈实测)。
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
  // 批3 Task 3:$token 预取解析(与 import 链同一辅助)——runPixelVerify 收**解析后**
  // geometry(采样基准 = 解析色字面量,collectBgTargets 的 target 换算才正确);
  // resolution 抛错按消息前缀分流(现状无 try 兜底会冒成 SCRIPT_EXEC_FAILED——修正:
  // TOKEN_NOT_FOUND 前缀单独成码,其余 INVALID_PARAMS)。
  let geoVerified: PrototypeGeometry;
  try {
    const outcome = await resolveTokensForGeometry(geo, args.theme_path as string | undefined, projectPath, godot);
    if (!outcome.ok) return outcome.result;
    geoVerified = outcome.geo;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.startsWith('TOKEN_NOT_FOUND')) return opsErrorResult(ERROR_CODES.TOKEN_NOT_FOUND, msg);
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
  }
  const r = await runPixelVerify({ godotPath: godot, projectPath, scenePath, geo: geoVerified });
  if (!r.ok) {
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, r.error + (r.hint ? `\nHint: ${r.hint}` : ''));
  }
  return textResult(JSON.stringify(opsSuccess({ pixel_verify: r.summary })));
}

// ─── 批4 Task 3: extract_tree / export_doc 内部链 ────────────────────────────

/** extract_scan JSON 提取(公共执行段输出通道:data.extract_scan.nodes)。 */
function parseExtractScan(parsed: ToolResult): ExtractScanNode[] | null {
  try {
    const out = JSON.parse((parsed.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
      data?: { extract_scan?: { nodes?: unknown } };
    };
    const nodes = out.data?.extract_scan?.nodes;
    return Array.isArray(nodes) ? (nodes as ExtractScanNode[]) : null;
  } catch {
    return null;
  }
}

/**
 * extract_tree(批4 Task 3):scene_path 必填;node_path/max_depth 可选(默认 16/cap 64,
 * 同 measure);draft_path 可选(sanitize 防穿越)。链路:spawn1 扫描(extract_scan)→
 * extractTreeReport 聚类(纯函数)→ draft_path 且 draft 非空 → spawn2 落草稿(原子写)。
 * 响应 {report, draft, notes, persist?};空扫描 draft=null 且不落盘(Review Focus 4)。
 */
async function handleExtractTree(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
  loadAutoloads: boolean,
): Promise<ToolResult> {
  const sceneRaw = args.scene_path as string | undefined;
  if (!sceneRaw || !String(sceneRaw).trim()) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'extract_tree 需要 scene_path(待逆向样式的场景)');
  }
  let scenePath: string;
  try {
    scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(String(sceneRaw)));
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `scene_path 非法: ${getErrorMessage(err)}`);
  }
  const npRaw = args.node_path as string | undefined;
  const nodePath = npRaw !== undefined && npRaw !== null && String(npRaw).trim() !== ''
    ? normalizeNodePath(String(npRaw)) : undefined;
  const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 16;
  const draftRaw = args.draft_path as string | undefined;
  if (draftRaw !== undefined && draftRaw !== null && String(draftRaw).trim() !== '') {
    try { sanitizeResPath(String(draftRaw), 'draft_path'); } catch {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'draft_path contains path traversal');
    }
  }

  const scanResult = await executeGdscriptTrusted({
    godotPath: godot, projectPath,
    code: genExtractTreeScript(scenePath, nodePath, maxDepth),
    timeout: 30, loadAutoloads,
  });
  const scanned = parseGdscriptResult(scanResult, [], uiErrorMapper);
  if (scanned.isError) return scanned;
  const scan = parseExtractScan(scanned);
  if (scan === null) {
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, 'extract_scan 输出解析失败(非合法 JSON 或 nodes 非数组)');
  }

  const { report, draft, notes } = extractTreeReport(scan);
  const payload: Record<string, unknown> = { report, draft, notes };
  // 草稿落盘:draft_path 提供**且** draft 非空才 spawn2(空扫描零写盘,诚实不落空文件)
  if (draftRaw && draft) {
    const saveResult = await executeGdscriptTrusted({
      godotPath: godot, projectPath,
      code: genDraftSaveScript(String(draftRaw), draft),
      timeout: 30, loadAutoloads,
    });
    const saved = parseGdscriptResult(saveResult, [], uiErrorMapper);
    if (saved.isError) return saved;
    payload.persist = { path: String(draftRaw) };
  } else if (draftRaw && !draft) {
    notes.push('draft_path 已提供但扫描无可映射草稿(空扫描/全不可映射类型),未落盘');
  }
  return textResult(JSON.stringify(opsSuccess(payload)));
}

/**
 * export_doc(批4 Task 3):theme_path 必填(sanitize 防穿越)。spawn 巡检
 * (theme_inspect:DesignTokens 全量 + 逐类型四通道 top10 + default_font)→
 * buildDesignDoc 组装 markdown。响应 {document, theme_path},不落盘(视图非真源)。
 */
async function handleExportDoc(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
  loadAutoloads: boolean,
): Promise<ToolResult> {
  const themePath = args.theme_path as string | undefined;
  if (!themePath) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path is required for export_doc action');
  }
  try { sanitizeResPath(themePath, 'theme_path'); } catch {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
  }
  const result = await executeGdscriptTrusted({
    godotPath: godot, projectPath,
    code: genThemeInspectScript(themePath),
    timeout: 30, loadAutoloads,
  });
  const parsed = parseGdscriptResult(result, [], uiErrorMapper);
  if (parsed.isError) return parsed;
  let inspect: ThemeInspect | undefined;
  try {
    const out = JSON.parse((parsed.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
      data?: { theme_inspect?: ThemeInspect };
    };
    inspect = out.data?.theme_inspect;
  } catch {
    inspect = undefined;
  }
  if (!inspect || typeof inspect !== 'object' || !inspect.tokens) {
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, 'theme_inspect 输出解析失败(非合法 JSON 或缺 tokens)');
  }
  return textResult(JSON.stringify(opsSuccess({ document: buildDesignDoc(inspect), theme_path: themePath })));
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
      solve_from_current: 'write',
      token_set: 'write', token_list: 'read',
      extract_tree: 'write', export_doc: 'read',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
