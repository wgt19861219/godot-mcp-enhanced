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
import type { MeasuredNode } from './layout-diff.js';

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
 * 空路径返回 ''(向后兼容:不传 theme_path 时生成脚本与旧版逐字节一致)。
 * mountTarget(Task 2):viewport 覆写激活时必须 'scene-root'——root.set_theme 的主题
 * 传播不跨 Viewport 边界(spike 探针实测:root 主题 + SubViewport 挂载 → variation
 * 节点拿不到主题,字号 24 不顶开;场景根挂主题 → 42 正常),SubViewport 内子树的主题
 * 祖先只能是场景根自己。非 Control 场景根显式报错(不静默不崩)。 */
export function genThemeMountInit(themePath?: string, mountTarget?: 'root' | 'scene-root'): string {
  if (!themePath) return '';
  const tp = escapeForGdLiteral(themePath);
  const mountLine = mountTarget === 'scene-root'
    ? `\tif _mcp_scene_instance is Control:
\t\t(_mcp_scene_instance as Control).set_theme(_theme_res)
\telse:
\t\t_mcp_output("error", "theme_path requires a Control scene root when viewport override is active")
\t\t_mcp_done()
\t\treturn
`
    : `\troot.set_theme(_theme_res)\n`;
  return `\tvar _theme_res = load("${tp}")
\tif _theme_res == null or not _theme_res is Theme:
\t\t_mcp_output("error", "theme_path load failed: ${tp}")
\t\t_mcp_done()
\t\treturn
${mountLine}`;
}

/** 批1 1a(Task 2):viewport 覆写注入段——g800 复测通道。
 * spike 实测(2026-11-16,Godot 4.7 headless --path --script,探针不留仓库):
 * ① root.content_scale_size 直接赋值:当刻读回新值,但后续帧被引擎复位回项目设置
 *    (960×540),布局不重排——不生效;
 * ② root.set_size(Vector2i):同样被复位(WIN 回 64×64,headless DisplayServer 窗口尺寸
 *    不可控)——不生效;
 * ③ SubViewport 通道:场景实例挂进指定尺寸 SubViewport,Control 树按注入视口重排
 *    (靶子 960×540 默认,注入 800×480 → 全铺节点 rect.w 960→800)——生效。
 * 三段产物:
 *  - declare:class body 声明 `var _vp_sub: SubViewport = null`(须在 'var _frames := 0'
 *    锚点之后——import 链截取保留;_emit 引用);
 *  - create:_initialize/_measure_go 内、场景加载(_mcp_load_scene / reload load)之前
 *    ——视口先于场景加载设置,布局才按新视口算;
 *  - adopt:场景加载成功后把实例从 root 转挂进 _vp_sub(_mcp_load_scene 固定挂 root,
 *    转挂后 Control 按新 parent 的视口尺寸重排,measure 的等帧稳定判定覆盖重排过程)。
 * 空 viewport 返回三段 ''(向后兼容:不传时生成脚本与旧版逐字节一致)。
 * w/h 为生成期数字字面量内插(handler 侧已校验正整数)。 */
export function genViewportInit(viewport?: { w: number; h: number }): { declare: string; create: string; adopt: string } {
  if (!viewport) return { declare: '', create: '', adopt: '' };
  const { w, h } = viewport;
  return {
    declare: `var _vp_sub: SubViewport = null  # viewport 参数覆写目标(Task 2,spike:SubViewport 通道)\n`,
    create: `\t# --- viewport 覆写(g800 复测通道,spike 结论:root.content_scale_size/set_size 均被引擎
\t# 复位,SubViewport 通道生效;须先于场景加载设置)---
\t_vp_sub = SubViewport.new()
\t_vp_sub.size = Vector2i(${w}, ${h})
\troot.add_child(_vp_sub)
`,
    adopt: `\tif _vp_sub != null and _mcp_scene_instance != null and _mcp_scene_instance.get_parent() != null:
\t\t_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
\t\t_vp_sub.add_child(_mcp_scene_instance)
`,
  };
}

/** 批1 1a(Task 2 假绿防护,Review Focus 2):viewport 覆写生效性判定(纯函数)。
 * 上报 viewport 值被注入覆写,本身不能证明布局按新视口算——须有独立于上报值的
 * 布局证据,否则假绿(viewport 报 800、布局实际仍按默认视口):
 * ① 全铺判据(无需基线,handler 主判据):存在 anchor_left==0 且 anchor_right==1 的
 *    节点且 |rect.w - vp.w| <= 1 → 全铺节点 rect.w 跟随注入视口宽,直接证据
 *    (e2e 硬断言的 TS 版);
 * ② 基线判据(可选 baseline 形参):存在非全铺节点(rect.w < vp.w)相对基线 rect 四值
 *    任一变化 → 布局语境切换。**handler 侧实测弃用此辅判据**:默认视口基线只能挂
 *    root 取,与覆写轮 SubViewport 通道语境不同(headless Window 不可信 + stretch
 *    字体度量失真),非视口变化会被误读为生效——假绿检测器自身假绿。形参保留给
 *    未来干净的同通道基线(见 index.ts 后处理注释)。
 * 判据不满足 → 'inconclusive'(诚实降级,调用方附警告,不得静默)。 */
export function checkViewportEffect(
  nodes: ReadonlyArray<MeasuredNode>,
  vp: { w: number; h: number },
  baseline?: ReadonlyArray<MeasuredNode>,
): 'effective' | 'inconclusive' {
  // ① 全铺判据:anchor 全宽 + rect.w 贴注入视口宽(1px 容差吸收浮点)
  if (nodes.some(n => n.anchors?.left === 0 && n.anchors?.right === 1 && Math.abs(n.rect.w - vp.w) <= 1)) {
    return 'effective';
  }
  // ② 基线判据:非全铺节点(rect.w < vp.w)相对默认视口基线发生变化
  if (baseline) {
    const baseMap = new Map(baseline.map(n => [n.path, n]));
    const changed = nodes.some(n => {
      const b = baseMap.get(n.path);
      if (!b || n.rect.w >= vp.w) return false;
      return n.rect.x !== b.rect.x || n.rect.y !== b.rect.y
        || n.rect.w !== b.rect.w || n.rect.h !== b.rect.h;
    });
    if (changed) return 'effective';
  }
  return 'inconclusive';
}

export function genUiMeasureScript(
  scenePath: string,
  nodePath: string | undefined,
  maxDepth: number,
  styleExpect?: ReadonlyArray<{ path: string; slots: readonly string[] }>,
  opts?: { themePath?: string; viewport?: { w: number; h: number } },
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
  // 批1 1a(Task 2):viewport 覆写注入(SubViewport 通道,spike 结论)。create 段在
  // _mcp_load_scene 之前(视口先于场景加载设置),adopt 段在加载成功后转挂,declare 段
  // 在锚点之后的 class body 声明区(import 链截取保留 + _emit 引用)。
  const vp = genViewportInit(opts?.viewport);
  // 批1 1a:theme_path 挂载注入(_mcp_load_scene 成功、场景 add_child 挂树之后——
  // set_theme 触发的主题传播作用于已进树的子树;置于 _initialize 语句区,
  // 不进 class body 声明区——ui-import-single 的截取拼接只保留锚点后的函数体)。
  // viewport 激活时挂场景根:root 主题传播不跨 Viewport 边界(spike 探针实测)。
  const themeMount = genThemeMountInit(opts?.themePath, opts?.viewport ? 'scene-root' : 'root');
  // 批2 Task2:DesignTokens constants 导出段(_emit 内,themePath 存在才注入——无
  // themePath 逐字节兼容)。挂载点读回与 genThemeMountInit 挂载目标一致:viewport 激活
  // 时是场景根(root 主题传播不跨 Viewport 边界,root.theme 此语境拿不到挂载 Theme),
  // 否则 root(Window.theme 属性)。_mcp_scene_instance 是 SCENE_TREE_HEADER 的 class 级
  // 声明,_emit 可直接引用;themeMount 的 scene-root 分支已保证非 Control 早退,此处
  // as Control 安全。type 不存在 → get_constant_list 空 → 空 dict(无声明不发噪音,
  // 不报错);键 str() 归一(防御性,恒等转换)。
  const themeConstEmit = opts?.themePath
    ? `\t# 批2 Task2:DesignTokens constants 导出——从实际挂载点读回 Theme(与 genThemeMountInit
\t# 挂载目标一致);type 不存在 → 空 dict(无声明不发噪音,不报错)
\tvar _tc := {}
\tvar _mounted_theme: Theme = ${opts.viewport ? '(_mcp_scene_instance as Control).theme' : 'root.theme'}
\tif _mounted_theme != null:
\t\tfor _cn in _mounted_theme.get_constant_list("DesignTokens"):
\t\t\t_tc[str(_cn)] = _mounted_theme.get_constant(_cn, "DesignTokens")
`
    : '';
  return `${SCENE_TREE_HEADER}

var _frames := 0
var _stable_count := 0
var _last_snapshot := ""
var _target: Node = null
var _count := 0
const _all_slots := ["panel", "normal", "background", "fill", "hover", "pressed", "disabled"]  # 与 types.ts STYLEBOX_SLOTS 双份硬编码,扩槽须两处同步
var _style_expect: Dictionary = {}
${vp.declare}
func _initialize():
${styleInit}${vp.create}\tif not _mcp_load_scene("${sp}"):
\t\t_mcp_done()
\t\treturn
\t_target = _mcp_scene_instance
${vp.adopt}${themeMount}${np ? `\tif "${np}" != "":
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
\t# Task 2:viewport 参数注入时优先返回注入值(SubViewport 尺寸,spike 结论)——布局
\t# 语境按 SubViewport 算,root.content_scale_size 此时仍是项目默认值(不复位 _vp_sub)。
${opts?.viewport
    ? '\tvar _vp := root.content_scale_size\n\tif _vp_sub != null:\n\t\t_vp = Vector2(_vp_sub.size)'
    : '\tvar _vp := root.content_scale_size'}
${themeConstEmit}\t_mcp_output("measure", JSON.stringify({
\t\t"stable_after_frames": _frames,
\t\t"stalled": _frames >= 5 and _stable_count < 2,
\t\t"viewport": {"w": _vp.x, "h": _vp.y},
\t\t"nodes": nodes${opts?.themePath ? ',\n\t\t"theme_constants": _tc' : ''}}))
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
