// ui-export:批4 Task 3 export_doc——Theme 资源只读巡检 + DESIGN.md 视图组装。
// 契约:
// - **视图非真源**:buildDesignDoc 产出的 markdown 是 Theme 资源的视图,真源是 .tres;
//   改设计先改 theme(token_set/ui_set_theme),文档再 export_doc 重导,不在文档侧手改;
// - **双截断**:类型通道 names 每通道 top 10(GD 侧截,`more` 计数)+ 文档表内 names 前 5
//   (`(+N more)`)、类型按通道条目总数 top 20(`(+N types)`)——防大主题文档爆炸;
// - 无场景加载(只 load 资源,同 ui-tokens 通道);theme 缺失复用 themeFileNotFoundBlock
//   (文案单一真源,经 uiErrorMapper 前置分支 THEME_NOT_FOUND)。

import { escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';
import { DESIGN_TOKENS_TYPE } from './types.js';
import { themeFileNotFoundBlock } from './ui-tokens.js';
import { PROGRESS_BAR_MIN_HEIGHT } from './prototype-import.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** 通道摘要:names 为 top 10(GD 侧截),more 为剩余计数。 */
export interface ThemeChannelSummary { names: string[]; more: number }

/** 逐类型四通道条目(通道仅在有定义项时出现)。 */
export interface TypeChannelEntry {
  type: string;
  colors?: ThemeChannelSummary;
  constants?: ThemeChannelSummary;
  styleboxes?: ThemeChannelSummary;
  font_sizes?: ThemeChannelSummary;
}

export interface ThemeInspect {
  tokens: { colors: Record<string, number[]>; constants: Record<string, number> };
  types: TypeChannelEntry[];
  has_default_font: boolean;
  default_font_size?: number;
}

// ─── genThemeInspectScript ──────────────────────────────────────────────────

/** GD 侧通道 names 截断上限(每通道 top 10 + more 计数)。 */
const CHANNEL_TOP = 10;

/**
 * Theme 巡检脚本:无场景加载(load 资源,同 genTokenPrefetchScript 通道)。导出
 * ① DesignTokens colors/constants 全量(Color 先转 [r,g,b,a] 数组再入 dict,同
 * ui-tokens JSON roundtrip 通道);② get_type_list() 逐类型四通道
 * (get_color_list/get_constant_list/get_stylebox_list/get_font_size_list)names
 * 每通道 top 10 + more 计数(有定义项才挂通道键);③ default_font/default_font_size
 * 有无。theme 缺失/非 Theme → themeFileNotFoundBlock(THEME_NOT_FOUND 分流)。
 */
export function genThemeInspectScript(themePath: string): string {
  const tp = escapeForGdLiteral(themePath);
  return `${SCENE_TREE_HEADER}

func _initialize():
	var _theme = load("${tp}")
${themeFileNotFoundBlock(tp)}
	var _colors := {}
	for _name in _theme.get_color_list("${DESIGN_TOKENS_TYPE}"):
		var _c: Color = _theme.get_color(_name, "${DESIGN_TOKENS_TYPE}")
		_colors[str(_name)] = [_c.r, _c.g, _c.b, _c.a]
	var _constants := {}
	for _name in _theme.get_constant_list("${DESIGN_TOKENS_TYPE}"):
		_constants[str(_name)] = _theme.get_constant(_name, "${DESIGN_TOKENS_TYPE}")
	var _types: Array = []
	for _t in _theme.get_type_list():
		var _entry := {"type": str(_t)}
		var _cl: Array = _theme.get_color_list(_t)
		if _cl.size() > 0:
			_entry["colors"] = _channel(_cl)
		var _kl: Array = _theme.get_constant_list(_t)
		if _kl.size() > 0:
			_entry["constants"] = _channel(_kl)
		var _sl: Array = _theme.get_stylebox_list(_t)
		if _sl.size() > 0:
			_entry["styleboxes"] = _channel(_sl)
		var _fl: Array = _theme.get_font_size_list(_t)
		if _fl.size() > 0:
			_entry["font_sizes"] = _channel(_fl)
		_types.append(_entry)
	var _out := {"tokens": {"colors": _colors, "constants": _constants}, "types": _types, "has_default_font": _theme.default_font != null}
	if _theme.default_font_size > 0:
		_out["default_font_size"] = _theme.default_font_size
	_mcp_output("theme_inspect", JSON.stringify(_out))
	_mcp_done()

func _channel(list: Array) -> Dictionary:
	var _names: Array = []
	for _i in range(mini(${CHANNEL_TOP}, list.size())):
		_names.append(str(list[_i]))
	# HIGH-1(审查修复): more 下限钳制 0——通道 1-9 条(<top10 常态)时裸减产负数,
	# TS 侧 total = names.length + more 会全错(真机实锤 "-4: a, b, c")。源头修在此,
	# TS 侧 chanCell 信任输入形态不重复钳制。
	return {"names": _names, "more": maxi(0, list.size() - ${CHANNEL_TOP})}
`;
}

// ─── buildDesignDoc(纯函数)──────────────────────────────────────────────────

/** 文档表内 names 显示上限(超出 → (+N more))。 */
const DOC_NAME_TOP = 5;
/** 文档类型表上限(按通道条目总数排序,超出 → (+N types))。 */
const DOC_TYPE_TOP = 20;

/** 通道 cell:总 count(names+more)前缀 + 前 5 names + (+N more)。 */
function chanCell(c: ThemeChannelSummary | undefined): string {
  if (!c) return '—';
  const total = c.names.length + c.more;
  const shown = c.names.slice(0, DOC_NAME_TOP).join(', ');
  const rest = total - Math.min(total, DOC_NAME_TOP);
  return rest > 0 ? `${total}: ${shown} (+${rest} more)` : `${total}: ${shown}`;
}

/** 数值渲染:整数直出,小数保留至 4 位去尾零(0.5→0.5,0.25→0.25)。 */
function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
}

/**
 * DESIGN.md 组装(纯函数):头部声明(视图/真源/生成方)+ DesignTokens 全量表
 * (空 → 一行空档说明)+ 类型槽位摘要表(通道条目总数排序 top 20,`(+N types)`;
 * 每类型各通道 counts + names 截断)+ 引擎约束提示节(固定三条,引用
 * PROGRESS_BAR_MIN_HEIGHT 常量防文档侧数字漂移)。
 */
export function buildDesignDoc(inspect: ThemeInspect): string {
  const lines: string[] = [];
  lines.push('# DESIGN');
  lines.push('');
  lines.push('> 本文档是 Theme 资源的视图,真源是 .tres;由 export_doc 生成——改设计先改 theme(token_set/ui_set_theme),再重导本文档。');
  lines.push('');

  // DesignTokens 全量表
  lines.push('## DesignTokens');
  lines.push('');
  const colorEntries = Object.entries(inspect.tokens.colors);
  const constEntries = Object.entries(inspect.tokens.constants);
  if (colorEntries.length === 0 && constEntries.length === 0) {
    lines.push(`- (空:该 Theme 无 DesignTokens token——先 token_set 建档,再 export_doc 重导)`);
  } else {
    lines.push('| token | 值 | 通道 |');
    lines.push('|-------|-----|------|');
    for (const [name, v] of colorEntries) {
      lines.push(`| \`$${name}\` | [${v.map(num).join(', ')}] | color |`);
    }
    for (const [name, v] of constEntries) {
      lines.push(`| \`$${name}\` | ${num(v)} | constant |`);
    }
  }
  lines.push('');

  // 类型槽位摘要表(通道条目总数排序,截 top 20)
  lines.push(`## 类型槽位摘要(top ${DOC_TYPE_TOP})`);
  lines.push('');
  const chanTotal = (t: TypeChannelEntry): number =>
    (t.colors ? t.colors.names.length + t.colors.more : 0)
    + (t.constants ? t.constants.names.length + t.constants.more : 0)
    + (t.styleboxes ? t.styleboxes.names.length + t.styleboxes.more : 0)
    + (t.font_sizes ? t.font_sizes.names.length + t.font_sizes.more : 0);
  const sorted = [...inspect.types].sort((a, b) => chanTotal(b) - chanTotal(a));
  const shown = sorted.slice(0, DOC_TYPE_TOP);
  lines.push('| 类型 | colors | constants | styleboxes | font_sizes |');
  lines.push('|------|--------|-----------|------------|------------|');
  for (const t of shown) {
    lines.push(`| ${t.type} | ${chanCell(t.colors)} | ${chanCell(t.constants)} | ${chanCell(t.styleboxes)} | ${chanCell(t.font_sizes)} |`);
  }
  if (sorted.length > shown.length) {
    lines.push(`(+${sorted.length - shown.length} types)`);
  }
  lines.push('');

  // 引擎约束提示(固定三条)
  lines.push('## 引擎约束提示');
  lines.push('');
  lines.push(`- ProgressBar 默认主题最小高 ~${PROGRESS_BAR_MIN_HEIGHT}px(stylebox override 只降不除,原型 rect.h 更小会被引擎钳制)`);
  lines.push('- Label 垂直对齐默认 TOP,需显式 vertical_alignment=1(CENTER)才垂直居中');
  lines.push('- 透明布局壳须 self_modulate(禁 modulate——乘性级联会让整棵子树跟着消失)');
  lines.push(`- 默认字体: ${inspect.has_default_font ? '已设置' : '未设置(回落 ThemeDB fallback)'}${inspect.default_font_size !== undefined ? `,默认字号 ${num(inspect.default_font_size)}` : ''}`);
  lines.push('');
  return lines.join('\n');
}
