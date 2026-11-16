// ui_measure_layout:headless 整树 computed rect 测量。
// 执行链路(spec B-1 选型):executor 链(executeGdscriptTrusted),full-class extends
// SceneTree 脚本——gdscript-executor 对此类脚本走 injectHelpers 且不自动追加 _mcp_done,
// 因此可先 process_frame 等布局稳定再输出(随机 marker 由 executor replaceAll 注入)。
// 注意:SCENE_TREE_HEADER 的 _mcp_done() 已含 quit(0)(gdscript-templates.ts:138-141,
// 带 Engine.get_main_loop() 守卫),_emit 不再显式 quit,避免重复。
// maxDepth clamp 1-64;NaN/Infinity 回落默认 16,防生成 `depth > NaN` 非法 GDScript。
// PR-2(spec §4.1):styleExpect 期望清单(path→slots)内嵌为 JSON 字符串 + GD 侧
// parse(name 是任意字符串,禁裸拼 GD 字面量);读回判定 = 期望清单 ∪ has_theme_stylebox_override
// (I-B 拍板:并集左侧是期望——「override 没设上」的节点 has_override=false 也必须被读到,
// 以默认主题数值 diff 暴露;右侧补手写树/手动 override 场景)。

import { escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';

/** PR-4 抽取:styleExpect 期望清单 parse 注入行(genUiMeasureScript._initialize 与
 * ui-import-single._measure_go 共用一份构造与转义,防双份漂移)。
 * 转义语义(I-1):escapeForGdLiteral 供 GD 侧 JSON.parse_string 消费;gdEscape 为 %
 * 格式化场景设计会把 name 中 % 双写,此处禁用。空清单返回 ''(_style_expect 保持 {})。 */
export function genStyleExpectInit(
  styleExpect?: ReadonlyArray<{ path: string; slots: readonly string[] }>,
): string {
  if (!styleExpect || styleExpect.length === 0) return '';
  return `\tvar _se_parsed = JSON.parse_string("${escapeForGdLiteral(JSON.stringify(Object.fromEntries(styleExpect.map(e => [e.path, [...e.slots]]))))}")\n\t_style_expect = _se_parsed if typeof(_se_parsed) == TYPE_DICTIONARY else _style_expect\n`;
}

/** 批1 1a(theme_path 挂载):root 主题挂载注入行。与 genStyleExpectInit 同款共用构造——
 * genUiMeasureScript._initialize 与 ui-import-single._measure_go 各注入一份,防双份漂移
 * (measure 核心经 'var _frames := 0' 截取后 _initialize 整体剥离,import 链必须在
 * _measure_go 内重注)。背景(spec P0-2):theme_type_variation 节点的字号/行高取自
 * 主题,无主题语境下 rect 是错语境——显式挂载让测量不依赖项目自身是否挂了根主题
 * (spike 实测注:--headless --path --script 模式下引擎仍加载项目 autoload,自带
 * ThemeManager 的项目两轮同语境 Δ=0;无 autoload fixture 实测 24→42,见
 * test/ui-measure-theme.test.ts)。
 * null/非 Theme 显式报错退出(Review Focus 1,不静默吞)。转义走 escapeForGdLiteral
 * (纯字符串字面量内插,同 sp/np 先例——gdEscape 为 % 格式化设计会把 % 双写)。
 * 空路径返回 ''(向后兼容:不传 theme_path 时生成脚本与旧版逐字节一致)。 */
export function genThemeMountInit(themePath?: string): string {
  if (!themePath) return '';
  const tp = escapeForGdLiteral(themePath);
  return `\tvar _theme_res = load("${tp}")
\tif _theme_res == null or not _theme_res is Theme:
\t\t_mcp_output("error", "theme_path load failed: ${tp}")
\t\t_mcp_done()
\t\treturn
\troot.set_theme(_theme_res)
`;
}

export function genUiMeasureScript(
  scenePath: string,
  nodePath: string | undefined,
  maxDepth: number,
  styleExpect?: ReadonlyArray<{ path: string; slots: readonly string[] }>,
  opts?: { themePath?: string },
): string {
  const sp = escapeForGdLiteral(scenePath);
  const np = nodePath ? escapeForGdLiteral(nodePath) : '';
  const depth = Math.max(1, Math.min(64, Math.floor(Number.isFinite(maxDepth) ? maxDepth : 16)));
  // 修正(brief 运行期 Parse Error,2026-08-18 真跑 Godot 实测):brief 原文把
  // `var _style_expect: Dictionary = {}` 注入 _initialize() 函数体内——GDScript 函数
  // 局部变量不跨函数,_walk() 引用即 "Identifier not declared"(res://measure:185)。
  // 最小修正:声明上移 class body 顶层(缺省空字典,_walk 的 .get(path, []) 恒安全),
  // _initialize() 内只做 parse 赋值(styleInit 仅在期望清单非空时注入)。
  // 声明位置必须在 `var _frames := 0` 之后:ui-layout-integration 的 buildThenMeasure
  // 以 'var _frames := 0' 为截取锚点拼接 build+measure 单进程脚本,锚点之前的新增声明
  // 会被截掉 → 拼接产物 _walk 引用未声明标识符。
  // PR-4:ui-import-single.ts 同以该锚点截取(见其组装注释)。
  // scenePath/nodePath 内插走 escapeForGdLiteral(Task 2,debt-cleanup-20260818):sp/np 只
  // 内嵌进纯字符串字面量(load 调用/np 查找/错误信息),不参与 % 格式化——gdEscape 为 %
  // 格式化场景设计会把路径中 % 双写成 %%,含 % 的文件名(如 res://a%b.tscn)被静默改写
  // 导致加载失败;引号/反斜杠/换行/Tab 等共享转义两入口相同(escapeGdStringCore),切换零损失。
  const styleInit = genStyleExpectInit(styleExpect);
  // 批1 1a:theme_path 挂载注入(_mcp_load_scene 成功、场景 add_child 挂树之后——
  // root.set_theme 触发的主题传播作用于已进树的子树;置于 _initialize 语句区,
  // 不进 class body 声明区——ui-import-single 的截取拼接只保留锚点后的函数体)。
  const themeMount = genThemeMountInit(opts?.themePath);
  return `${SCENE_TREE_HEADER}

var _frames := 0
var _stable_count := 0
var _last_snapshot := ""
var _target: Node = null
var _count := 0
const _all_slots := ["panel", "normal", "background", "fill", "hover", "pressed", "disabled"]  # 与 types.ts STYLEBOX_SLOTS 双份硬编码,扩槽须两处同步
var _style_expect: Dictionary = {}

func _initialize():
${styleInit}\tif not _mcp_load_scene("${sp}"):
\t\t_mcp_done()
\t\treturn
\t_target = _mcp_scene_instance
${themeMount}${np ? `\tif "${np}" != "":
\t\tvar _n = _mcp_get_scene_node("${np}")
\t\tif _n == null:
\t\t\t_mcp_output("error", "Node not found: ${np}")
\t\t\t_mcp_done()
\t\t\treturn
\t\t_target = _n` : ''}
\tprocess_frame.connect(_on_measure_frame)

func _on_measure_frame() -> void:
\t_frames += 1
\tvar snap := _snapshot()
\tif snap == _last_snapshot:
\t\t_stable_count += 1
\telse:
\t\t_stable_count = 0
\t\t_last_snapshot = snap
\tif _stable_count >= 2 or _frames >= 5:
\t\tprocess_frame.disconnect(_on_measure_frame)
\t\t_emit()

func _snapshot() -> String:
\tvar parts: Array = []
\t_snap_walk(_target, 0, parts)
\treturn ";".join(parts)

func _snap_walk(n: Node, depth: int, parts: Array) -> void:
\tif depth > ${depth} or _count >= 2000:
\t\treturn
\tif n is Control:
\t\tvar c := n as Control
\t\tparts.append("%d,%d,%d,%d" % [int(c.global_position.x), int(c.global_position.y), int(c.size.x), int(c.size.y)])
\t\t_count += 1
\tfor ch in n.get_children():
\t\t_snap_walk(ch, depth + 1, parts)

func _emit() -> void:
\tvar nodes: Array = []
\t_count = 0
\t_walk(_target, 0, nodes)
\t# C1(M-a/M-b): stalled = 5 帧上限内未达到 2 帧稳定快照;viewport 作为 layout_verify
\t# 根级 rect 的参照系。注意用 content_scale_size 而非 Window.size / get_visible_rect()——
\t# headless --script 模式下 Window 实际尺寸不反映 project 设置(实测 100x100/2496x?),
\t# content_scale_size 才是 display/window/size 的直接映射(实测 1280x720)。
\tvar _vp := root.content_scale_size
\t_mcp_output("measure", JSON.stringify({
\t\t"stable_after_frames": _frames,
\t\t"stalled": _frames >= 5 and _stable_count < 2,
\t\t"viewport": {"w": _vp.x, "h": _vp.y},
\t\t"nodes": nodes}))
\t_mcp_done()

func _walk(n: Node, depth: int, nodes: Array) -> void:
\tif depth > ${depth} or _count >= 2000:
\t\treturn
\tif n is Control:
\t\tvar c := n as Control
\t\tvar entry := {
\t\t\t"path": str(_target.get_path_to(n)),
\t\t\t"type": n.get_class(),
\t\t\t"rect": {"x": c.global_position.x, "y": c.global_position.y, "w": c.size.x, "h": c.size.y},
\t\t\t"anchors": {"left": c.anchor_left, "right": c.anchor_right, "top": c.anchor_top, "bottom": c.anchor_bottom},
\t\t\t"offsets": {"left": c.offset_left, "right": c.offset_right, "top": c.offset_top, "bottom": c.offset_bottom},
\t\t\t"visible": c.is_visible_in_tree(),
\t\t}
\t\tif "text" in n:
\t\t\tentry["text"] = str(n.get("text"))
\t\t# PR-2:style 按需读回(期望清单 ∪ override 非空;spec §4.1)
\t\tvar _slots: Array = []
\t\tfor s in _style_expect.get(entry["path"], []):
\t\t\t_slots.append(str(s))
\t\tfor s in _all_slots:
\t\t\tif c.has_theme_stylebox_override(s) and not _slots.has(s):
\t\t\t\t_slots.append(s)
\t\tif _slots.size() > 0:
\t\t\tvar _styles: Array = []
\t\t\tfor s in _slots:
\t\t\t\tvar _sb = c.get_theme_stylebox(s)
\t\t\t\tvar _e := {"slot": s}
\t\t\t\tif _sb is StyleBoxFlat:
\t\t\t\t\tvar _f := _sb as StyleBoxFlat
\t\t\t\t\t_e["flat"] = true
\t\t\t\t\t_e["bg_color"] = [_f.bg_color.r, _f.bg_color.g, _f.bg_color.b, _f.bg_color.a]
\t\t\t\t\t_e["corner_radius"] = {"tl": _f.corner_radius_top_left, "tr": _f.corner_radius_top_right, "br": _f.corner_radius_bottom_right, "bl": _f.corner_radius_bottom_left}
\t\t\t\t\t_e["border_width"] = {"left": _f.border_width_left, "top": _f.border_width_top, "right": _f.border_width_right, "bottom": _f.border_width_bottom}
\t\t\t\t\t_e["border_color"] = [_f.border_color.r, _f.border_color.g, _f.border_color.b, _f.border_color.a]
\t\t\t\telse:
\t\t\t\t\t_e["flat"] = false
\t\t\t\t\t_e["type"] = _sb.get_class()
\t\t\t\t_styles.append(_e)
\t\t\tentry["styles"] = _styles
\t\tnodes.append(entry)
\t\t_count += 1
\tfor ch in n.get_children():
\t\t_walk(ch, depth + 1, nodes)
`;
}
