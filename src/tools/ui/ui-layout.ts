// UI layout operations: ui_set_layout, ui_get_layout, ui_build_layout.

// 路径类内插(scenePath/nodePath/parentPath)走 escapeForGdLiteral(Task 2,
// debt-cleanup-20260818):它们只内嵌进纯字符串字面量(load/node 查找/错误信息/persist
// _full/layout_built 输出),不参与 % 格式化——gdEscape 会把路径中 % 双写成 %%,含 % 的
// 路径被静默改写导致加载/查找失败。node name/type/property key 仍走 gdEscape(name 含 %
// 被 Godot 命名规则禁止、type 来自白名单、key 经 BLOCKED_PROPS 校验——零真实风险面,
// 保持不动;且二者共享 escapeGdStringCore,引号/反斜杠/换行/Tab 转义完全一致)。
import { gdEscape, escapeForGdLiteral, valueToGd, SCENE_TREE_HEADER } from '../shared.js';
import { CONTROL_TYPES, ANCHOR_PRESETS, STYLEBOX_SLOTS, colorToGd } from './types.js';
import { solveAnchors, CONTAINER_CONTROL_TYPES } from './anchor-solver.js';
import type { Rect } from './anchor-solver.js';
import { BLOCKED_PROPS } from '../../core/shared/blocked-props.js';
import type { FlexLayout, FlexChild, UiNodeSpec } from './types.js';

// ─── ui_set_layout ────────────────────────────────────────────────────────

export function genUiSetLayoutScript(
  scenePath: string,
  nodePath: string,
  anchors?: { left?: number; right?: number; top?: number; bottom?: number },
  offsets?: { left?: number; right?: number; top?: number; bottom?: number },
  minSize?: { x?: number; y?: number },
  customMinSize?: { x?: number; y?: number },
  growDirection?: string,
): string {
  let lines = '';

  if (anchors) {
    if (anchors.left !== undefined) lines += `\n\tnode.anchor_left = ${anchors.left}`;
    if (anchors.right !== undefined) lines += `\n\tnode.anchor_right = ${anchors.right}`;
    if (anchors.top !== undefined) lines += `\n\tnode.anchor_top = ${anchors.top}`;
    if (anchors.bottom !== undefined) lines += `\n\tnode.anchor_bottom = ${anchors.bottom}`;
  }
  if (offsets) {
    if (offsets.left !== undefined) lines += `\n\tnode.offset_left = ${offsets.left}`;
    if (offsets.right !== undefined) lines += `\n\tnode.offset_right = ${offsets.right}`;
    if (offsets.top !== undefined) lines += `\n\tnode.offset_top = ${offsets.top}`;
    if (offsets.bottom !== undefined) lines += `\n\tnode.offset_bottom = ${offsets.bottom}`;
  }
  if (minSize) {
    if (minSize.x !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(${minSize.x}, node.custom_minimum_size.y)`;
    if (minSize.y !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(node.custom_minimum_size.x, ${minSize.y})`;
  }
  if (customMinSize) {
    lines += `\n\tnode.custom_minimum_size = Vector2(${customMinSize.x ?? 'node.custom_minimum_size.x'}, ${customMinSize.y ?? 'node.custom_minimum_size.y'})`;
  }
  if (growDirection) {
    const dir = growDirection.toLowerCase();
    const dirMap: Record<string, string> = {
      both: 'Control.GROW_DIRECTION_BOTH',
      up: 'Control.GROW_DIRECTION_UP',
      down: 'Control.GROW_DIRECTION_DOWN',
      left: 'Control.GROW_DIRECTION_LEFT',
      right: 'Control.GROW_DIRECTION_RIGHT',
    };
    const gdDir = dirMap[dir];
    if (gdDir) {
      if (dir === 'left' || dir === 'right' || dir === 'both') {
        lines += `\n\tnode.grow_horizontal = ${gdDir}`;
      }
      if (dir === 'up' || dir === 'down' || dir === 'both') {
        lines += `\n\tnode.grow_vertical = ${gdDir}`;
      }
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("layout_set", {"node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

// ─── ui_get_layout ────────────────────────────────────────────────────────

export function genUiGetLayoutScript(
  scenePath: string,
  nodePath: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar info = {
\t\t"anchor_left": node.anchor_left,
\t\t"anchor_right": node.anchor_right,
\t\t"anchor_top": node.anchor_top,
\t\t"anchor_bottom": node.anchor_bottom,
\t\t"offset_left": node.offset_left,
\t\t"offset_right": node.offset_right,
\t\t"offset_top": node.offset_top,
\t\t"offset_bottom": node.offset_bottom,
\t\t"global_position": {"x": node.global_position.x, "y": node.global_position.y},
\t\t"size": {"x": node.size.x, "y": node.size.y}
\t}
\t_mcp_output("layout", info)
\t_mcp_done()
`;
}

// ─── ui_build_layout ──────────────────────────────────────────────────────

const MAX_NESTING_DEPTH = 10;

/** 节点会以 Container 形态落地的判定:声明了 flex layout,或类型本身就是容器(B-3)。 */
function isContainerSpec(spec: UiNodeSpec): boolean {
  return spec.layout !== undefined || CONTAINER_CONTROL_TYPES.includes(spec.type);
}

/** rect(绝对几何,相对父左上角)→ 显式 anchors+offsets 赋值块。
 * 不用 set_anchors_preset(它不重置 offsets,引擎陷阱,spec §3.2)。
 * ⚠️ 本块必须拼在 add_child 之后:get_parent() 挂树后才有效,
 * 父为 Container 的守卫才能真实判定并跳过(B-3:容器会强制重排子 Control)。 */
function genRectLines(rect: Rect, viewport: { w: number; h: number }, indent: string): string {
  const a = solveAnchors(viewport, rect);
  return `
${indent}if node.get_parent() != null and node.get_parent() is Container:
${indent}\tpass # parent is Container: rect skipped (would be re-arranged)
${indent}else:
${indent}\tnode.anchor_left = ${a.anchor_left}
${indent}\tnode.anchor_right = ${a.anchor_right}
${indent}\tnode.anchor_top = ${a.anchor_top}
${indent}\tnode.anchor_bottom = ${a.anchor_bottom}
${indent}\tnode.offset_left = ${a.offset_left}
${indent}\tnode.offset_right = ${a.offset_right}
${indent}\tnode.offset_top = ${a.offset_top}
${indent}\tnode.offset_bottom = ${a.offset_bottom}`;
}

const VALID_DIRECTIONS = ['row', 'column', 'row-reverse', 'column-reverse', 'grid'] as const;
const VALID_JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
const VALID_ALIGN = ['stretch', 'flex-start', 'center', 'flex-end'] as const;
const VALID_WRAP = ['nowrap', 'wrap'] as const;
const VALID_ALIGN_SELF = ['auto', 'flex-start', 'center', 'flex-end', 'stretch'] as const;

function validateUiNodeSpec(spec: UiNodeSpec, depth: number, warnings: string[] = []): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Maximum nesting depth is ${MAX_NESTING_DEPTH}, exceeded at node "${spec.name}"`);
  }
  if (!spec.layout && !CONTROL_TYPES.includes(spec.type as typeof CONTROL_TYPES[number])) {
    throw new Error(`INVALID_CONTROL_TYPE: "${spec.type}" is not a whitelisted Control type`);
  }
  if (!spec.name) {
    throw new Error('name is required for each UiNodeSpec');
  }
  if (spec.anchor_preset && !(spec.anchor_preset in ANCHOR_PRESETS)) {
    throw new Error(`INVALID_ANCHOR_PRESET: "${spec.anchor_preset}"`);
  }
  if (spec.layout) {
    validateFlexLayout(spec.layout, warnings);
  }
  if (spec.flex) {
    validateFlexChild(spec.flex, warnings);
  }
  if (spec.styleboxes) {
    for (const sb of spec.styleboxes) {
      if (!STYLEBOX_SLOTS.includes(sb.slot)) {
        throw new Error(`INVALID_PARAMS: styleboxes slot "${sb.slot}" is not whitelisted (allowed: ${STYLEBOX_SLOTS.join(', ')})`);
      }
      const b = sb.box;
      // 审查 I-1:draw_center 在 genStyleboxLines 中裸内插进 GDScript,必须在 validate 层
      // 堵死非布尔输入(字符串可携带换行注入任意 GD 语句,TS 类型标注对 MCP 运行时 JSON 无强制力)
      if (b.draw_center !== undefined && typeof b.draw_center !== 'boolean') {
        throw new Error('INVALID_PARAMS: styleboxes draw_center must be a boolean');
      }
      const radii = typeof b.corner_radius === 'number'
        ? [b.corner_radius]
        : Object.values(b.corner_radius ?? {});
      if (radii.some(v => typeof v !== 'number' || v < 0 || !Number.isFinite(v))) {
        throw new Error('INVALID_PARAMS: styleboxes corner_radius must be non-negative finite number(s)');
      }
      if (b.border_width !== undefined && (typeof b.border_width !== 'number' || b.border_width < 0 || !Number.isFinite(b.border_width))) {
        throw new Error('INVALID_PARAMS: styleboxes border_width must be a non-negative finite number');
      }
      // PR-2 M-2(PR-1 终审转来):bg_color/border_color 四元 number 数组对称校验
      // (无注入向量——colorToGd 只认数组形态,坏输入原先在生成层静默/产出错行;
      // 此处早拒提升 INVALID_PARAMS 质量)
      for (const key of ['bg_color', 'border_color'] as const) {
        const c = b[key];
        if (c !== undefined) {
          const bad = !Array.isArray(c) || c.length !== 4
            || c.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1);
          if (bad) {
            throw new Error(`INVALID_PARAMS: styleboxes ${key} must be an array of exactly 4 finite numbers in [0,1]`);
          }
        }
      }
      // PR-2 M-5:corner_radius 布尔/null/数组原先静默当 0(Object.values(布尔)=[] 空过,
      // 生成器 `typeof object` 分支产 {} → 四角全 0)——显式拒
      if (b.corner_radius !== undefined && typeof b.corner_radius !== 'number'
        && (typeof b.corner_radius !== 'object' || b.corner_radius === null || Array.isArray(b.corner_radius))) {
        throw new Error('INVALID_PARAMS: styleboxes corner_radius must be a number or an object {tl,tr,br,bl}');
      }
    }
  }
  if (spec.children) {
    for (const child of spec.children) {
      validateUiNodeSpec(child, depth + 1, warnings);
    }
  }
}

function validateFlexLayout(layout: FlexLayout, warnings: string[]): void {
  if (!VALID_DIRECTIONS.includes(layout.direction)) {
    throw new Error(`INVALID_LAYOUT: direction must be one of: ${VALID_DIRECTIONS.join(', ')}, got "${layout.direction}"`);
  }
  if (layout.gap !== undefined && (typeof layout.gap !== 'number' || layout.gap < 0 || !Number.isFinite(layout.gap))) {
    throw new Error('INVALID_LAYOUT: gap must be a non-negative finite number');
  }
  if (layout.row_gap !== undefined && (typeof layout.row_gap !== 'number' || layout.row_gap < 0 || !Number.isFinite(layout.row_gap))) {
    throw new Error('INVALID_LAYOUT: row_gap must be a non-negative finite number');
  }
  if (layout.justify !== undefined && !VALID_JUSTIFY.includes(layout.justify)) {
    throw new Error(`INVALID_LAYOUT: justify must be one of: ${VALID_JUSTIFY.join(', ')}, got "${layout.justify}"`);
  }
  if (layout.align !== undefined && !VALID_ALIGN.includes(layout.align)) {
    throw new Error(`INVALID_LAYOUT: align must be one of: ${VALID_ALIGN.join(', ')}, got "${layout.align}"`);
  }
  if (layout.wrap !== undefined && !VALID_WRAP.includes(layout.wrap)) {
    throw new Error(`INVALID_LAYOUT: wrap must be one of: ${VALID_WRAP.join(', ')}, got "${layout.wrap}"`);
  }
  if (layout.padding !== undefined) {
    if (typeof layout.padding === 'number') {
      if (layout.padding < 0) throw new Error('INVALID_LAYOUT: padding must be non-negative');
    } else if (Array.isArray(layout.padding)) {
      if (layout.padding.length !== 4 || layout.padding.some(v => typeof v !== 'number' || v < 0)) {
        throw new Error('INVALID_LAYOUT: padding array must be [top, right, bottom, left] with non-negative numbers');
      }
    } else {
      throw new Error('INVALID_LAYOUT: padding must be a number or [top, right, bottom, left] array');
    }
  }
  if (layout.row_gap !== undefined && layout.wrap !== 'wrap') {
    warnings.push('layout.row_gap is ignored when wrap is not "wrap"');
  }
  // I1: wrap/grid 下 justify 根本不生效(见 genFlexContainerProps 的 ignored warning),
  // 此处不再宣称"经注入 spacer 实现"——两条 warning 语义矛盾。
  if (layout.justify !== undefined && ['space-between', 'space-around', 'space-evenly'].includes(layout.justify)
    && layout.wrap !== 'wrap' && layout.direction !== 'grid') {
    warnings.push(`layout.justify "${layout.justify}" is implemented via injected spacer nodes`);
  }
}

function validateFlexChild(flex: FlexChild, warnings: string[]): void {
  if (flex.grow !== undefined && (typeof flex.grow !== 'number' || flex.grow < 0 || !Number.isFinite(flex.grow))) {
    throw new Error('INVALID_FLEX: grow must be a non-negative finite number');
  }
  // I-05: validate min_width/min_height to prevent Infinity/NaN/negative values in GDScript
  if (flex.min_width !== undefined && (typeof flex.min_width !== 'number' || flex.min_width < 0 || !Number.isFinite(flex.min_width))) {
    throw new Error('INVALID_FLEX: min_width must be a non-negative finite number');
  }
  if (flex.min_height !== undefined && (typeof flex.min_height !== 'number' || flex.min_height < 0 || !Number.isFinite(flex.min_height))) {
    throw new Error('INVALID_FLEX: min_height must be a non-negative finite number');
  }
  if (flex.align_self !== undefined && !VALID_ALIGN_SELF.includes(flex.align_self)) {
    throw new Error(`INVALID_FLEX: align_self must be one of: ${VALID_ALIGN_SELF.join(', ')}, got "${flex.align_self}"`);
  }
  if (flex.shrink !== undefined) {
    warnings.push('flex.shrink is ignored (no Godot equivalent)');
  }
  if (flex.max_width !== undefined) {
    warnings.push('flex.max_width is ignored (no Godot equivalent)');
  }
  if (flex.max_height !== undefined) {
    warnings.push('flex.max_height is ignored (no Godot equivalent)');
  }
}

function resolveFlexContainer(layout: FlexLayout): {
  containerType: string;
  isReverse: boolean;
  isWrap: boolean;
  isGrid: boolean;
} {
  if (layout.direction === 'grid') {
    return { containerType: 'GridContainer', isReverse: false, isWrap: false, isGrid: true };
  }
  const isReverse = layout.direction === 'row-reverse' || layout.direction === 'column-reverse';
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  const isWrap = layout.wrap === 'wrap';

  let containerType: string;
  if (isWrap) {
    containerType = isRow ? 'HFlowContainer' : 'VFlowContainer';
  } else {
    containerType = isRow ? 'HBoxContainer' : 'VBoxContainer';
  }

  return { containerType, isReverse, isWrap, isGrid: false };
}

function genFlexContainerProps(layout: FlexLayout, indent: string, warnings: string[] = []): string {
  const { isWrap, isGrid } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  let lines = '';

  if (isGrid) {
    if (layout.columns !== undefined && layout.columns > 0) {
      lines += `\n${indent}node.columns = ${Math.floor(layout.columns)}`;
    }
    if (layout.gap !== undefined) {
      lines += `\n${indent}node.add_theme_constant_override("h_separation", ${layout.gap})`;
      const vSep = layout.row_gap ?? layout.gap;
      lines += `\n${indent}node.add_theme_constant_override("v_separation", ${vSep})`;
    }
    if (layout.padding !== undefined) {
      const p = typeof layout.padding === 'number'
        ? [layout.padding, layout.padding, layout.padding, layout.padding]
        : layout.padding;
      lines += `\n${indent}node.add_theme_constant_override("margin_top", ${p[0]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_right", ${p[1]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_bottom", ${p[2]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_left", ${p[3]})`;
    }
    return lines;
  }

  if (layout.justify) {
    if (isWrap) {
      warnings.push('layout.justify is ignored when wrap is "wrap" (FlowContainer has no alignment)');
    } else if (['space-between', 'space-around', 'space-evenly'].includes(layout.justify)) {
      warnings.push(`layout.justify "${layout.justify}" is implemented by injecting _spacer_N Control nodes (BoxContainer has no space-* alignment)`);
    } else {
      const justifyMap: Record<string, number> = { 'flex-start': 0, 'center': 1, 'flex-end': 2 };
      const alignment = justifyMap[layout.justify];
      if (alignment !== undefined) {
        lines += `\n${indent}node.alignment = ${alignment}`;
      }
    }
  }

  if (layout.gap !== undefined) {
    if (isWrap) {
      if (isRow) {
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${layout.gap})`;
        const vSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${vSep})`;
      } else {
        const hSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${hSep})`;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${layout.gap})`;
      }
    } else {
      lines += `\n${indent}node.add_theme_constant_override("separation", ${layout.gap})`;
    }
  }

  if (layout.padding !== undefined && !isWrap) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    lines += `\n${indent}node.add_theme_constant_override("margin_top", ${p[0]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_right", ${p[1]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_bottom", ${p[2]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_left", ${p[3]})`;
  }

  return lines;
}

// space-* justify 无法用 BoxContainer alignment 表达,改为注入 SIZE_EXPAND spacer 实现。
// CSS 语义:between = 元素间 N-1 个等距;evenly = N+1 个等距(含首尾);around = 2N 个半距。
// (spec §3.3,审查 B-2:around 必须是 2N 个 0.5,不能用 N+1 个 —— N≥2 时配比不等)
export type SequenceItem = { kind: 'spacer'; ratio: number } | { kind: 'child'; spec: UiNodeSpec };

function interleaveSpacers(justify: string, children: UiNodeSpec[]): SequenceItem[] {
  const asChildren = (): SequenceItem[] => children.map(c => ({ kind: 'child' as const, spec: c }));
  if (children.length === 0) return [];
  if (justify === 'space-between') {
    const out: SequenceItem[] = [];
    children.forEach((c, i) => {
      if (i > 0) out.push({ kind: 'spacer', ratio: 1 });
      out.push({ kind: 'child', spec: c });
    });
    return out;
  }
  if (justify === 'space-evenly') {
    const out: SequenceItem[] = [];
    for (const c of children) {
      out.push({ kind: 'spacer', ratio: 1 });
      out.push({ kind: 'child', spec: c });
    }
    out.push({ kind: 'spacer', ratio: 1 });
    return out;
  }
  if (justify === 'space-around') {
    // B-2: 必须是 2N 个 0.5(每个 child 前后各一个),不能用 N+1 个 —— N≥2 时配比不等。
    // 相邻两个 0.5 spacer 拼出元素间距(2x),边缘单个 0.5 为边距(x),即 around 的"边距=间距之半"。
    const out: SequenceItem[] = [];
    for (const c of children) {
      out.push({ kind: 'spacer', ratio: 0.5 });
      out.push({ kind: 'child', spec: c });
      out.push({ kind: 'spacer', ratio: 0.5 });
    }
    return out;
  }
  return asChildren();
}

export function genSpacerLines(name: string, ratio: number, isRow: boolean, indent: string, ownerVar: string, parentVar: string): string {
  const flag = isRow ? 'size_flags_horizontal' : 'size_flags_vertical';
  return `${indent}node = ClassDB.instantiate("Control")
${indent}node.name = "${gdEscape(name)}"
${indent}node.${flag} = Control.SIZE_EXPAND
${indent}node.size_flags_stretch_ratio = ${ratio}
${indent}node.mouse_filter = Control.MOUSE_FILTER_IGNORE
${indent}${parentVar}.add_child(node)
${indent}node.owner = ${ownerVar}`;
}

function applyAlignSelf(align: string, isRow: boolean, indent: string, warnings?: string[]): string {
  if (align === 'stretch') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND_FILL`;
    } else {
      return `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND_FILL`;
    }
  } else if (align === 'center') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = (node.size_flags_vertical & ~Control.SIZE_EXPAND & ~Control.SIZE_FILL) | Control.SIZE_SHRINK_CENTER`;
    } else {
      return `\n${indent}node.size_flags_horizontal = (node.size_flags_horizontal & ~Control.SIZE_EXPAND & ~Control.SIZE_FILL) | Control.SIZE_SHRINK_CENTER`;
    }
  } else if (align === 'flex-end') {
    warnings?.push('align/flex.align_self "flex-end" has no direct Container equivalent; consider adding a spacer child with SIZE_EXPAND before this node to push it to the end');
  }
  return '';
}

function genFlexChildLines(flex: FlexChild, isRow: boolean, indent: string, warnings?: string[]): string {
  let lines = '';

  if (flex.grow !== undefined && flex.grow > 0) {
    lines += `\n${indent}node.size_flags_stretch_ratio = ${flex.grow}`;
    if (isRow) {
      lines += `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND`;
    } else {
      lines += `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND`;
    }
  }

  if (flex.align_self && flex.align_self !== 'auto') {
    lines += applyAlignSelf(flex.align_self, isRow, indent, warnings);
  }

  if (flex.min_width !== undefined || flex.min_height !== undefined) {
    const w = flex.min_width ?? 'node.custom_minimum_size.x';
    const h = flex.min_height ?? 'node.custom_minimum_size.y';
    lines += `\n${indent}node.custom_minimum_size = Vector2(${w}, ${h})`;
  }

  return lines;
}

// PR-1:stylebox 变量名计数(模块级,genUiBuildLayoutScript 入口重置——同步拼接无并发
// 交错,每次生成从 _sb_1 起)。裁定:brief 测试断言嵌套场景父/子 stylebox 为 _sb_1/_sb_2,
// 共享 nextId 计数时父节点的 _saved_N 会在两 stylebox 之间消耗 id,无法产出该序列;
// 故 _sb_N 用专属 1-based 计数。N-7(同名 var 是 GDScript 编译错)仍消除:
// _sb_ 系列内唯一 + 前缀与 _saved_/_margin_/_spacer_ 互异,整树作用域无同名。
let _sbCounter = 0;
const nextSbId = (): number => ++_sbCounter;

/** PR-1:styleboxes → StyleBoxFlat 构造块(spec §3.2)。变量名 _sb_N 由专属 1-based
 * 计数器生成(见 nextSbId,genUiBuildLayoutScript 入口重置)——整树拼进单个
 * _initialize() 作用域,与 _saved_N/_margin_N 同层,同名 var 是 GDScript 编译错
 * (审查 N-7)。colorToGd 出 [r,g,b,a] → Color(...) 表达式。 */
function genStyleboxLines(spec: UiNodeSpec, indent: string, nextSbId: () => number): string {
  if (!spec.styleboxes || spec.styleboxes.length === 0) return '';
  const blocks: string[] = [];
  for (const sb of spec.styleboxes) {
    const v = `_sb_${nextSbId()}`;
    const b = sb.box;
    const lines: string[] = [`var ${v} := StyleBoxFlat.new()`];
    if (b.bg_color !== undefined) lines.push(`${v}.bg_color = ${colorToGd(b.bg_color)}`);
    if (b.draw_center !== undefined) lines.push(`${v}.draw_center = ${b.draw_center}`);
    if (b.corner_radius !== undefined) {
      const u = typeof b.corner_radius === 'number' ? b.corner_radius : undefined;
      const o = typeof b.corner_radius === 'object' && b.corner_radius !== null ? b.corner_radius : {};
      lines.push(
        `${v}.corner_radius_top_left = ${o.tl ?? u ?? 0}`,
        `${v}.corner_radius_top_right = ${o.tr ?? u ?? 0}`,
        `${v}.corner_radius_bottom_right = ${o.br ?? u ?? 0}`,
        `${v}.corner_radius_bottom_left = ${o.bl ?? u ?? 0}`,
      );
    }
    if (b.border_width !== undefined) {
      lines.push(
        `${v}.border_width_left = ${b.border_width}`,
        `${v}.border_width_top = ${b.border_width}`,
        `${v}.border_width_right = ${b.border_width}`,
        `${v}.border_width_bottom = ${b.border_width}`,
      );
    }
    if (b.border_color !== undefined) lines.push(`${v}.border_color = ${colorToGd(b.border_color)}`);
    // 引擎事实(Task 4 集成实测 2026-08-17):Godot 4.7 中 stylebox 类 theme override 的
    // 属性路径是 theme_override_styles/<slot>(非 theme_override_styleboxes/——spec 原文
    // 误写),且经 node.set("theme_override_styles/…") 设值后 PackedScene.pack 照样丢
    // override;唯一实测落盘可靠路径是 add_theme_stylebox_override API(落盘产出
    // theme_override_styles/<slot> = SubResource("StyleBoxFlat_…"))。
    lines.push(`node.add_theme_stylebox_override("${sb.slot}", ${v})`);
    blocks.push(lines.map(l => `${indent}${l}`).join('\n'));
  }
  return '\n' + blocks.join('\n');
}

function uiNodeToGd(
  spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string,
  warnings: string[] = [], nextId: () => number = () => 0,
  viewport: { w: number; h: number } = { w: 1280, h: 720 },
  parentIsContainer: boolean = false,
  parentSize?: { w: number; h: number },
): string {
  if (spec.layout) {
    return uiNodeToGdWithLayout(spec, parentVar, ownerVar, indent, warnings, nextId, viewport);
  }
  // C1: rect 按父尺寸求解——parentSize 为当前节点 rect 的求解基准:
  //   根节点由调用方显式传 viewport;父带 rect 的子节点传父 rect.w/h;
  //   父无 rect(非根)时降级 viewport 并告警(结果可能不准)。
  //   容器父走 parentIsContainer 路径(rect 运行时跳过,已有 skipped warning),不再叠加本告警。
  if (spec.rect && !parentSize && !parentIsContainer) {
    warnings.push(`node "${spec.name}" has rect but its parent's size is unknown — solved against viewport, result may be inaccurate`);
  }
  const solveBase = parentSize ?? viewport;
  // rect(绝对几何)优先于 anchor_preset;父为 Container 时静态提示(运行时另有跳过守卫,B-3)
  if (spec.rect && parentIsContainer) {
    warnings.push(`node "${spec.name}" has rect but parent is a Container — rect will be skipped at runtime (containers re-arrange children)`);
  }
  const rectLines = spec.rect ? genRectLines(spec.rect, solveBase, indent) : '';
  const anchorLine = spec.anchor_preset && !spec.rect
    ? `\n${indent}node.set_anchors_preset(${ANCHOR_PRESETS[spec.anchor_preset]})`
    : '';
  const propLines = spec.properties && Object.keys(spec.properties).length > 0
    ? '\n' + Object.entries(spec.properties)
        .filter(([k]) => {
          if (BLOCKED_PROPS.has(k)) {
            warnings.push(`properties.${k} is blocked (BLOCKED_PROPS security policy) — dropped`);
            return false;
          }
          return true;
        })
        .map(([k, v]) => `${indent}node.set("${gdEscape(k)}", ${valueToGd(v)})`)
        .join('\n')
    : '';
  const styleLines = genStyleboxLines(spec, indent, nextSbId);

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(spec.type)}")
${indent}if node == null:
${indent}\t_mcp_output("error", "Failed to instantiate: ${gdEscape(spec.type)}")
${indent}\t_mcp_done()
${indent}\treturn
${indent}node.name = "${gdEscape(spec.name)}"${anchorLine}${propLines}${styleLines}`;

  if (spec.children && spec.children.length > 0) {
    const savedIdx = nextId();
    const savedVar = `_saved_${savedIdx}`;
    lines += `\n${indent}var ${savedVar} = node`;
    // C1: 子 rect 的求解基准 = 本节点 rect.w/h(无 rect 时 undefined → 子侧降级 viewport)
    const childParentSize = spec.rect ? { w: spec.rect.w, h: spec.rect.h } : undefined;
    for (const child of spec.children) {
      lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent, warnings, nextId, viewport, isContainerSpec(spec), childParentSize);
    }
    lines += `\n${indent}node = ${savedVar}`;
  }

  lines += `\n${indent}${parentVar}.add_child(node)
${indent}node.owner = ${ownerVar}`;
  // rect 赋值必须在 add_child 之后执行:get_parent() 此时才有效,
  // Container 守卫才能真实判定并跳过(否则守卫恒走 else,名存实亡)
  lines += rectLines;

  return lines;
}

function uiNodeToGdWithLayout(
  spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string,
  warnings: string[], nextId: () => number,
  viewport: { w: number; h: number } = { w: 1280, h: 720 },
): string {
  const layout = spec.layout!;
  const { containerType, isReverse, isWrap, isGrid } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';

  if (isGrid && layout.justify) warnings.push('layout.justify is ignored for grid direction');
  if (isGrid && layout.align) warnings.push('layout.align is ignored for grid direction');
  if (isGrid && layout.wrap) warnings.push('layout.wrap is ignored for grid direction');
  if (isGrid && (layout.columns === undefined || layout.columns <= 0)) warnings.push('Grid layout without columns: GridContainer defaults to 1 column');

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(containerType)}")
${indent}if node == null:
${indent}\t_mcp_output("error", "Failed to instantiate: ${gdEscape(containerType)}")
${indent}\t_mcp_done()
${indent}\treturn
${indent}node.name = "${gdEscape(spec.name)}"`;

  const preset = spec.anchor_preset ? ANCHOR_PRESETS[spec.anchor_preset] : 15;
  lines += `\n${indent}node.set_anchors_preset(${preset})`;

  if (spec.properties && Object.keys(spec.properties).length > 0) {
    const safeEntries = Object.entries(spec.properties).filter(([k]) => {
      if (BLOCKED_PROPS.has(k)) {
        warnings.push(`properties.${k} is blocked (BLOCKED_PROPS security policy) — dropped`);
        return false;
      }
      return true;
    });
    if (safeEntries.length > 0) {
      lines += '\n' + safeEntries.map(
        ([k, v]) => `${indent}node.set("${gdEscape(k)}", ${valueToGd(v)})`
      ).join('\n');
    }
  }

  lines += genStyleboxLines(spec, indent, nextSbId);
  lines += genFlexContainerProps(layout, indent, warnings);

  let marginWrapperVar: string | null = null;
  if (isWrap && layout.padding !== undefined) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    const marginIdx = nextId();
    marginWrapperVar = `_margin_${marginIdx}`;
    const marginBlock = `${indent}var ${marginWrapperVar} = ClassDB.instantiate("MarginContainer")
${indent}${marginWrapperVar}.name = "${gdEscape(spec.name)}_margin"
${indent}${marginWrapperVar}.add_theme_constant_override("margin_top", ${p[0]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_right", ${p[1]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_bottom", ${p[2]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_left", ${p[3]})
${indent}${marginWrapperVar}.set_anchors_preset(${preset})`;
    lines = marginBlock + '\n' + lines;
  }

  const savedIdx = nextId();
  const savedVar = `_saved_${savedIdx}`;
  lines += `\n${indent}var ${savedVar} = node`;

  let children = spec.children ?? [];
  if (isReverse) children = [...children].reverse();

  const justifyNeedsSpacers = !isWrap && !isGrid && layout.justify !== undefined
    && ['space-between', 'space-around', 'space-evenly'].includes(layout.justify);
  if (justifyNeedsSpacers && children.some(c => c.flex?.grow !== undefined && c.flex.grow > 0)) {
    warnings.push('justify space-* combined with child flex.grow: spacers and grow children share the free space, distribution will not match CSS semantics');
  }
  const seq: SequenceItem[] = justifyNeedsSpacers ? interleaveSpacers(layout.justify!, children) : children.map(c => ({ kind: 'child' as const, spec: c }));

  let spacerIdx = 0;
  for (const item of seq) {
    if (item.kind === 'spacer') {
      lines += '\n' + genSpacerLines(`_spacer_${spacerIdx++}`, item.ratio, isRow, indent, ownerVar, savedVar);
      continue;
    }
    const child = item.spec;
    lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent, warnings, nextId, viewport, true);

    if (layout.align && (!child.flex || !child.flex.align_self || child.flex.align_self === 'auto')) {
      lines += applyAlignSelf(layout.align, isRow, indent, warnings);
    }
    if (child.flex) {
      lines += genFlexChildLines(child.flex, isRow, indent, warnings);
    }
  }

  lines += `\n${indent}node = ${savedVar}`;

  if (marginWrapperVar) {
    lines += `\n${indent}node = ${marginWrapperVar}`;
    lines += `\n${indent}${marginWrapperVar}.add_child(${savedVar})`;
    lines += `\n${indent}${savedVar}.owner = ${ownerVar}`;
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  } else {
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  }

  return lines;
}

export function genUiBuildLayoutScript(
  scenePath: string,
  parentPath: string,
  tree: UiNodeSpec,
  viewport?: { w: number; h: number },
  persist: boolean = false,
): string {
  const warnings: string[] = [];
  validateUiNodeSpec(tree, 1, warnings);

  let _idCounter = 0;
  const nextId = () => _idCounter++;
  _sbCounter = 0; // PR-1:每次生成重置 stylebox 计数(_sb_N 从 1 起,跨调用不累加)
  // C1: 根节点 rect 的父(parent_path 指向的节点)尺寸静态未知 → 以 viewport 为基准求解
  // (默认 1280x720,可通过参数覆盖);树内子节点则按各自父的 rect.w/h 求解(见 uiNodeToGd)。
  const baseViewport = viewport ?? { w: 1280, h: 720 };
  const buildBlock = uiNodeToGd(tree, 'parent', 'root', '\t', warnings, nextId, baseViewport, false, baseViewport);

  const warningLines = warnings.length > 0
    ? `\n\t_mcp_output("warnings", ${JSON.stringify(warnings.map(w => {
      const dot = w.indexOf('.');
      const field = dot > 0 ? w.substring(0, dot) : 'layout';
      return { field, message: w };
    }))})`
    : '';

  // persist=true:build 完成后原子写落盘(pack → tmp → rename,失败清理,同 scene-commit F-2 模式)。
  // 注意 warningLines 为空时不自带前导换行,故本块以 \n 开头保证与 buildBlock 行分隔。
  // owner 归一(实测 2026-08-16):build 时子节点先挂父、父后挂树,游离期设 owner 被引擎
  // 拒绝(Invalid owner. Owner must be an ancestor)→ 子节点 owner=null → pack 丢弃整棵子树。
  // pack 前全树已挂、祖先链成立,统一 set_owner 为场景根(编辑器保存语义)。
  const persistBlock = persist
    ? `\n\t# --- persist(原子写:pack → tmp → rename,同 scene-commit F-2 模式) ---
\tfor n in _mcp_scene_instance.find_children("*", "Node", true, false):
\t\tif n.get_owner() != _mcp_scene_instance:
\t\t\tn.set_owner(_mcp_scene_instance)
\tvar packed = PackedScene.new()
\tpacked.pack(_mcp_scene_instance)
\tvar _full := "${escapeForGdLiteral(scenePath)}"
\tvar _ext := _full.get_extension()
\tvar _tmp := _full + ".tmp." + _ext
\tif FileAccess.file_exists(_tmp):
\t\tDirAccess.remove_absolute(_tmp)
\tvar err := ResourceSaver.save(packed, _tmp)
\tif err != OK:
\t\tDirAccess.remove_absolute(_tmp)
\telse:
\t\tvar _ren := DirAccess.rename_absolute(_tmp, _full)
\t\tif _ren != OK:
\t\t\tDirAccess.remove_absolute(_tmp)
\t\t\terr = _ren
\t_mcp_output("persist", {"saved": err == OK})`
    : '';

  const rootType = tree.layout ? resolveFlexContainer(tree.layout).containerType : tree.type;

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_get_scene_node("${escapeForGdLiteral(parentPath)}")
\tif root == null:
\t\t_mcp_output("error", "Parent not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar parent = root
\tvar node: Node
${buildBlock}${warningLines}${persistBlock}
\t_mcp_output("layout_built", {"parent": "${escapeForGdLiteral(parentPath)}", "root_type": "${gdEscape(rootType)}", "root_name": "${gdEscape(tree.name)}"})
\t_mcp_done()
`;
}
