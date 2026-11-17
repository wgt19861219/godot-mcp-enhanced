// ui-extract:批4 Task 3 extract_tree——整树 theme override 逆向扫描 + 聚类 + 可选草稿落盘。
// 分工同 ui-tokens.ts 先例:extract 相关的 GD 脚本生成与聚类纯函数独立成文件。
// 契约(独立于 ui_import_prototype 的期望清单通道):
// - 只扫 **override**(has_theme_stylebox_override/has_theme_font_size_override/
//   has_theme_color_override)——默认主题项不进扫描(与 measure 的「期望 ∪ override」并集
//   左侧不同,extract 关心的是「场景作者显式设置了什么」);
// - 顺序锚(v1 审查 B3):GD 无 override-only getter,`get_theme_stylebox(` 必须出现在
//   `has_theme_stylebox_override(` 命中分支内之后(生成脚本两者都含,单测 indexOf 锁序);
// - 草稿只产 ThemeDraft(新建 Theme 资源),不回写场景、不改既有主题——「只产草稿」。

import { escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';
import { DESIGN_TOKENS_TYPE } from './types.js';
import type { StyleBoxFlatSpec, StyleBoxSlot } from './types.js';
import { styleboxSlotFor } from './prototype-import.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** 单槽 stylebox override 读回(StyleBoxFlat 四组字段 + draw_center;flat=false 为
 * 非 StyleBoxFlat override(如 StyleBoxTexture/Empty),只记槽位不进聚类)。 */
export interface StyleReading {
  slot: string;
  flat: boolean;
  bg_color?: [number, number, number, number];
  corner_radius?: { tl: number; tr: number; br: number; bl: number };
  border_width?: { left: number; top: number; right: number; bottom: number };
  border_color?: [number, number, number, number];
  draw_center?: boolean;
}

/** extract_scan 单节点——任一 override 命中(stylebox/font_size/font_color)才输出。 */
export interface ExtractScanNode {
  path: string;
  type: string;
  styles?: Array<StyleReading>;
  font_size?: number;
  font_color?: [number, number, number, number];
}

/** stylebox 聚类组:规格键(bg_color join + corner/border 数值 + draw_center,精确匹配)。 */
export interface SpecGroup {
  spec: ExtractSpec;
  count: number;
  nodes: string[];
  slots: string[];
  suggested_token: string;
}

/** font_size / font_color 聚类组(值精确匹配)。 */
export interface FontSizeGroup { value: number; count: number; nodes: string[]; suggested_token: string }
export interface FontColorGroup { value: [number, number, number, number]; count: number; nodes: string[]; suggested_token: string }

export interface ExtractReport {
  stylebox_groups: SpecGroup[];
  font_size_groups: FontSizeGroup[];
  font_color_groups: FontColorGroup[];
}

/** 聚类规格:StyleBoxFlatSpec 形态 + border_width 读回双形态(dict 四值——引擎侧逐边独立,
 * StyleBoxFlatSpec.border_width 仅 number(统一四边)是翻译侧产出契约;extract 读回不折叠,
 * 四值不等时保真进组/草稿,genDraftSaveScript 的 dict 分支逐边落地)。 */
export type ExtractSpec = Omit<StyleBoxFlatSpec, 'border_width'> & {
  border_width?: number | { left: number; top: number; right: number; bottom: number };
};

/** 草稿条目:四类控件(Panel/ProgressBar/Button/Label)默认槽最高频 spec。 */
export interface ThemeDraftStylebox { type: string; slot: StyleBoxSlot; spec: ExtractSpec; token: string }
export interface ThemeDraft {
  styleboxes: ThemeDraftStylebox[];
  colors: Array<{ name: string; value: [number, number, number, number] }>;
  constants: Array<{ name: string; value: number }>;
}

// ─── genExtractTreeScript ───────────────────────────────────────────────────

/**
 * extract_tree 扫描脚本:headless 单次 spawn,_mcp_load_scene 后整树 walk(不需要
 * 布局稳定——只读 override,不依赖 computed rect,故无 process_frame 等帧)。
 * 每 Control ① _all_slots 各槽 has_theme_stylebox_override(s) 命中后 get_theme_stylebox(s)
 * 读 StyleBoxFlat 字段;② font_size 门控;③ font_color 门控(Color 转 [r,g,b,a] 数组,
 * 同 ui-tokens 的 JSON roundtrip 通道);任一命中才输出节点。maxDepth 内插数字
 * (调用方 clamp 1-64,NaN 回落 16,同 ui-measure 先例)。nodePath 可选(子树定位,
 * 同 measure 的 np 块)。_count 上限 2000(防大场景输出爆炸,同 measure)。
 */
export function genExtractTreeScript(scenePath: string, nodePath: string | undefined, maxDepth: number): string {
  const sp = escapeForGdLiteral(scenePath);
  const np = nodePath ? escapeForGdLiteral(nodePath) : '';
  const depth = Math.max(1, Math.min(64, Math.floor(Number.isFinite(maxDepth) ? maxDepth : 16)));
  return `${SCENE_TREE_HEADER}

var _target: Node = null
var _count := 0
const _all_slots := ["panel", "normal", "background", "fill", "hover", "pressed", "disabled"]  # 与 types.ts STYLEBOX_SLOTS 三份硬编码之一,扩槽须同步

func _initialize():
	if not _mcp_load_scene("${sp}"):
		_mcp_done()
		return
	_target = _mcp_scene_instance
${np ? `\tif "${np}" != "":
\t\tvar _n = _mcp_get_scene_node("${np}")
\t\tif _n == null:
\t\t\t_mcp_output("error", "Node not found: ${np}")
\t\t\t_mcp_done()
\t\t\treturn
\t\t_target = _n` : ''}
	var nodes: Array = []
	_count = 0
	_walk(_target, 0, nodes)
	_mcp_output("extract_scan", JSON.stringify({"nodes": nodes}))
	_mcp_done()

func _walk(n: Node, depth: int, nodes: Array) -> void:
	if depth > ${depth} or _count >= 2000:
		return
	if n is Control:
		var c := n as Control
		var entry := {"path": str(_target.get_path_to(n)), "type": n.get_class()}
		var _styles: Array = []
		for s in _all_slots:
			if c.has_theme_stylebox_override(s):
				var _sb = c.get_theme_stylebox(s)
				var _e := {"slot": s, "flat": _sb is StyleBoxFlat}
				if _sb is StyleBoxFlat:
					var _f := _sb as StyleBoxFlat
					_e["bg_color"] = [_f.bg_color.r, _f.bg_color.g, _f.bg_color.b, _f.bg_color.a]
					_e["corner_radius"] = {"tl": _f.corner_radius_top_left, "tr": _f.corner_radius_top_right, "br": _f.corner_radius_bottom_right, "bl": _f.corner_radius_bottom_left}
					_e["border_width"] = {"left": _f.border_width_left, "top": _f.border_width_top, "right": _f.border_width_right, "bottom": _f.border_width_bottom}
					_e["border_color"] = [_f.border_color.r, _f.border_color.g, _f.border_color.b, _f.border_color.a]
					_e["draw_center"] = _f.draw_center
				_styles.append(_e)
		if _styles.size() > 0:
			entry["styles"] = _styles
		if c.has_theme_font_size_override("font_size"):
			entry["font_size"] = c.get_theme_font_size("font_size")
		if c.has_theme_color_override("font_color"):
			var _fc := c.get_theme_color("font_color")
			entry["font_color"] = [_fc.r, _fc.g, _fc.b, _fc.a]
		if entry.has("styles") or entry.has("font_size") or entry.has("font_color"):
			nodes.append(entry)
			_count += 1
	for ch in n.get_children():
		_walk(ch, depth + 1, nodes)
`;
}

// ─── extractTreeReport(聚类纯函数)───────────────────────────────────────────

/** 0-1 分量 → 两位 hex(Math.round 对齐 CSS 换算,0.5*255→128)。 */
function hex2(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
}

function rrggbb(c: [number, number, number, number]): string {
  return hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}

/** 规格键:bg_color join + corner/border 数值 + draw_center,JSON 序列化保证顺序稳定,精确匹配。 */
function specKey(spec: ExtractSpec): string {
  return JSON.stringify([
    spec.bg_color ?? null,
    spec.corner_radius ?? null,
    spec.border_width ?? null,
    spec.border_color ?? null,
    spec.draw_center ?? null,
  ]);
}

/** StyleReading → ExtractSpec(缺省字段省键,规格键对 undefined 与缺键等价)。 */
function specOf(r: StyleReading): ExtractSpec {
  const spec: ExtractSpec = {};
  if (r.bg_color !== undefined) spec.bg_color = [...r.bg_color];
  if (r.corner_radius !== undefined) spec.corner_radius = { ...r.corner_radius };
  if (r.border_width !== undefined) spec.border_width = { ...r.border_width };
  if (r.border_color !== undefined) spec.border_color = [...r.border_color];
  if (r.draw_center !== undefined) spec.draw_center = r.draw_center;
  return spec;
}

/** 草稿选举的控件四类(与 styleboxSlotFor 映射一一对应;其余类型不可映射)。 */
const DRAFT_TYPES = ['Panel', 'ProgressBar', 'Button', 'Label'] as const;

/**
 * 聚类纯函数:① stylebox 规格(精确匹配)分组;② font_size 值分组;③ font_color 值分组;
 * 组均按 count 降序、同 count 按首次出现序。draft 选举:四类控件各取默认槽最高频 spec
 * → set_stylebox 条目 + bg_color token(colors);font_color 组 → text_* token(colors);
 * font_size 组 → font_size_* token(constants)。空扫描 → draft null + notes 一行说明;
 * 不可映射类型 → 报告含组、草稿跳过并在 notes 点名类型(Review Focus 4,诚实不静默);
 * 非 StyleBoxFlat override 读数跳过聚类并 notes 说明。
 */
export function extractTreeReport(scan: ExtractScanNode[]): { report: ExtractReport; draft: ThemeDraft | null; notes: string[] } {
  const notes: string[] = [];

  // ① stylebox 聚类(仅 flat 读数;非 flat 点名跳过)
  const styleReadings: Array<{ node: ExtractScanNode; reading: StyleReading }> = [];
  let nonFlatCount = 0;
  for (const node of scan) {
    for (const r of node.styles ?? []) {
      if (r.flat) styleReadings.push({ node, reading: r });
      else nonFlatCount += 1;
    }
  }
  if (nonFlatCount > 0) {
    notes.push(`${nonFlatCount} 处非 StyleBoxFlat override(StyleBoxTexture/Empty 等)跳过聚类,仅记槽位`);
  }

  const specGroups = new Map<string, { spec: ExtractSpec; count: number; nodes: string[]; slots: Map<string, number> }>();
  for (const { node, reading } of styleReadings) {
    const spec = specOf(reading);
    const key = specKey(spec);
    let g = specGroups.get(key);
    if (!g) {
      g = { spec, count: 0, nodes: [], slots: new Map() };
      specGroups.set(key, g);
    }
    g.count += 1;
    if (!g.nodes.includes(node.path)) g.nodes.push(node.path);
    g.slots.set(reading.slot, (g.slots.get(reading.slot) ?? 0) + 1);
  }
  const stylebox_groups: SpecGroup[] = [...specGroups.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => ({
      spec: g.spec,
      count: g.count,
      nodes: g.nodes,
      slots: [...g.slots.keys()],
      suggested_token: `style_${topSlot(g.slots)}_${g.spec.bg_color ? rrggbb(g.spec.bg_color) : 'default'}`,
    }));

  // ② font_size 分组(值精确匹配)
  const fsMap = new Map<number, { count: number; nodes: string[] }>();
  for (const node of scan) {
    if (typeof node.font_size === 'number') {
      let g = fsMap.get(node.font_size);
      if (!g) { g = { count: 0, nodes: [] }; fsMap.set(node.font_size, g); }
      g.count += 1;
      g.nodes.push(node.path);
    }
  }
  const font_size_groups: FontSizeGroup[] = [...fsMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([value, g]) => ({ value, count: g.count, nodes: g.nodes, suggested_token: `font_size_${value}` }));

  // ③ font_color 分组(值精确匹配;数组 join 键)
  const fcMap = new Map<string, { value: [number, number, number, number]; count: number; nodes: string[] }>();
  for (const node of scan) {
    if (node.font_color !== undefined) {
      const key = node.font_color.join(',');
      let g = fcMap.get(key);
      if (!g) { g = { value: [...node.font_color], count: 0, nodes: [] }; fcMap.set(key, g); }
      g.count += 1;
      g.nodes.push(node.path);
    }
  }
  const font_color_groups: FontColorGroup[] = [...fcMap.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => ({ value: g.value, count: g.count, nodes: g.nodes, suggested_token: `text_${rrggbb(g.value)}` }));

  // draft 选举(四类控件各取默认槽最高频 spec;平票取先出现)
  const styleboxes: ThemeDraftStylebox[] = [];
  const colors: ThemeDraft['colors'] = [];
  for (const t of DRAFT_TYPES) {
    const slot = styleboxSlotFor(t)!;
    const candidates = new Map<string, { spec: ExtractSpec; count: number }>();
    for (const { node, reading } of styleReadings) {
      if (node.type !== t || reading.slot !== slot) continue;
      const spec = specOf(reading);
      const key = specKey(spec);
      const g = candidates.get(key);
      if (g) g.count += 1;
      else candidates.set(key, { spec, count: 1 });
    }
    if (candidates.size === 0) continue;
    const best = [...candidates.values()].reduce((a, b) => (b.count > a.count ? b : a));
    const token = best.spec.bg_color
      ? `style_${slot}_${rrggbb(best.spec.bg_color)}`
      : `style_${slot}_default`;
    styleboxes.push({ type: t, slot, spec: best.spec, token });
    if (best.spec.bg_color) colors.push({ name: token, value: [...best.spec.bg_color] });
  }
  for (const g of font_color_groups) colors.push({ name: g.suggested_token, value: [...g.value] });
  const constants = font_size_groups.map(g => ({ name: g.suggested_token, value: g.value }));

  let draft: ThemeDraft | null = null;
  if (styleboxes.length > 0 || colors.length > 0 || constants.length > 0) {
    draft = { styleboxes, colors, constants };
  }

  // notes:空扫描一行说明(Review Focus 4);不可映射类型点名(报告含组、草稿跳过)
  if (scan.length === 0) {
    notes.unshift('扫描完成:场景无任何 theme override 命中(全默认主题),未生成草稿');
  } else {
    const unmappable = [...new Set(
      scan.filter(n => (n.styles?.length ?? 0) > 0 && !DRAFT_TYPES.includes(n.type as typeof DRAFT_TYPES[number])).map(n => n.type),
    )];
    if (unmappable.length > 0) {
      notes.push(`类型 ${unmappable.join(', ')} 带样式 override 但不在草稿映射四类(Panel/ProgressBar/Button/Label):报告含组、草稿跳过`);
    }
  }

  return { report: { stylebox_groups, font_size_groups, font_color_groups }, draft, notes };
}

/** 组内最高频 slot(平票取首见——Map 迭代序即首见序)。 */
function topSlot(slots: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [s, c] of slots) {
    if (c > bestCount) { best = s; bestCount = c; }
  }
  return best;
}

// ─── genDraftSaveScript ─────────────────────────────────────────────────────

/**
 * 草稿落盘脚本:Theme.new() + StyleBoxFlat 逐字段 set + set_stylebox + DesignTokens
 * set_color/set_constant + 原子落盘(make_dir_recursive → tmp → ResourceSaver.save →
 * rename,复制 ui-tokens.ts genTokenSetScript 模式,错误分支同款)。草稿 JSON 内嵌
 * (escapeForGdLiteral + GD 侧 JSON.parse_string,同 genStyleExpectInit 先例——
 * 节点/类型名是任意字符串,禁裸拼 GD 字面量)。corner_radius/border_width 支持
 * dict 四角/统一 number 两种形态(StyleBoxFlatSpec 类型全量,读回恒 dict,防御双形态)。
 */
export function genDraftSaveScript(draftPath: string, draft: ThemeDraft): string {
  const dp = escapeForGdLiteral(draftPath);
  const json = escapeForGdLiteral(JSON.stringify(draft));
  return `${SCENE_TREE_HEADER}

func _initialize():
	var _parsed = JSON.parse_string("${json}")
	var _draft: Dictionary = _parsed if typeof(_parsed) == TYPE_DICTIONARY else {}
	var _theme := Theme.new()
	for _sbx in _draft.get("styleboxes", []):
		var _d: Dictionary = _sbx
		var _box := StyleBoxFlat.new()
		var _spec: Dictionary = _d.get("spec", {})
		if _spec.has("bg_color"):
			var _bg: Array = _spec["bg_color"]
			_box.bg_color = Color(_bg[0], _bg[1], _bg[2], _bg[3])
		if _spec.has("draw_center"):
			_box.draw_center = bool(_spec["draw_center"])
		if _spec.has("corner_radius"):
			var _cr: Variant = _spec["corner_radius"]
			if typeof(_cr) == TYPE_DICTIONARY:
				var _crd: Dictionary = _cr
				_box.corner_radius_top_left = int(_crd.get("tl", 0))
				_box.corner_radius_top_right = int(_crd.get("tr", 0))
				_box.corner_radius_bottom_right = int(_crd.get("br", 0))
				_box.corner_radius_bottom_left = int(_crd.get("bl", 0))
			else:
				var _crn := int(_cr)
				_box.set_corner_radius_all(_crn)
		if _spec.has("border_width"):
			var _bw: Variant = _spec["border_width"]
			if typeof(_bw) == TYPE_DICTIONARY:
				var _bwd: Dictionary = _bw
				_box.border_width_left = int(_bwd.get("left", 0))
				_box.border_width_top = int(_bwd.get("top", 0))
				_box.border_width_right = int(_bwd.get("right", 0))
				_box.border_width_bottom = int(_bwd.get("bottom", 0))
			else:
				_box.set_border_width_all(int(_bw))
		if _spec.has("border_color"):
			var _bc: Array = _spec["border_color"]
			_box.border_color = Color(_bc[0], _bc[1], _bc[2], _bc[3])
		_theme.set_stylebox(_d.get("slot", ""), _d.get("type", ""), _box)
	for _col in _draft.get("colors", []):
		var _cd: Dictionary = _col
		var _cv: Array = _cd.get("value", [0, 0, 0, 1])
		_theme.set_color(_cd.get("name", ""), "${DESIGN_TOKENS_TYPE}", Color(_cv[0], _cv[1], _cv[2], _cv[3]))
	for _con in _draft.get("constants", []):
		var _nd: Dictionary = _con
		_theme.set_constant(_nd.get("name", ""), "${DESIGN_TOKENS_TYPE}", _nd.get("value", 0))
	var _dir := "${dp}".get_base_dir()
	if not DirAccess.dir_exists_absolute(_dir):
		DirAccess.make_dir_recursive_absolute(_dir)
	var _full := "${dp}"
	var _ext := _full.get_extension()
	var _tmp := _full + ".tmp." + _ext
	if FileAccess.file_exists(_tmp):
		DirAccess.remove_absolute(_tmp)
	var _err := ResourceSaver.save(_theme, _tmp)
	if _err != OK:
		DirAccess.remove_absolute(_tmp)
		_mcp_output("error", "Failed to save theme: " + str(_err))
		_mcp_done()
		return
	var _ren := DirAccess.rename_absolute(_tmp, _full)
	if _ren != OK:
		DirAccess.remove_absolute(_tmp)
		_mcp_output("error", "Failed to rename tmp: " + str(_ren))
		_mcp_done()
		return
	_mcp_output("draft_saved", JSON.stringify({"path": "${dp}", "styleboxes": _draft.get("styleboxes", []).size(), "colors": _draft.get("colors", []).size(), "constants": _draft.get("constants", []).size()}))
	_mcp_done()
`;
}
