// ui_import_prototype 单 spawn 合成脚本模板(spec §6,PR-4)——build→persist→reload→
// measure 一次 Godot 进程完成(原两次 spawn 首版实测 ~6s,耗时留档
// test/integration/ui-import-integration.test.ts)。
// 形态拍板(spec §6 二轮审阅 N-2):独立模板文件,不扩 ui-measure——build 走 _initialize
// 同步语义、measure 走 process_frame 异步稳定语义,两种生命周期不混进 genUiMeasureScript;
// 共享 _mcp_load_scene(gdscript-templates.ts)零改动——本模板 reload 分支自带
// CACHE_MODE_IGNORE,不影响全部既有调用方。
// 组装三段(沿 test/integration/ui-layout-integration.test.ts buildThenMeasure 真跑验证
// 先例):①genUiBuildLayoutScript(persist=true) 尾部 layout_built+_mcp_done 替换为
// call_deferred("_measure_go");②genUiMeasureScript 输出自 'var _frames := 0' 截取并
// 剥离其 _initialize(裸 load 同进程二载命中 ResourceCache 旧实例——spec B-1,reload
// 分支由 _measure_go 自带);③追加 _measure_go:styleInit → reload → np 定位 → connect,
// 引用全部前向声明(规避 GDScript 前向引用风险)。
// reload 错误信息内嵌「build 已持久化,可重跑」恢复语义(persist 先于 measure 的既有
// 顺序;原两阶段流程的 TS 侧 hint-append 随第二次 spawn 删除,阶段语义由模板自持)。
import { escapeForGdLiteral } from '../shared.js';
import { genUiBuildLayoutScript } from './ui-layout.js';
import { genUiMeasureScript, genStyleExpectInit, genThemeMountInit } from './ui-measure.js';
import type { UiNodeSpec } from './types.js';

export function genUiImportSingleScript(
  scenePath: string,
  parentPath: string,
  tree: UiNodeSpec,
  viewport: { w: number; h: number },
  styleExpect?: ReadonlyArray<{ path: string; slots: readonly string[] }>,
  themePath?: string,
): string {
  // sp/np 内嵌 reload load/npLookup/错误信息均为纯字面量(不参与 % 格式化),走
  // escapeForGdLiteral——gdEscape 会把路径中 % 双写成 %%(Task 2 根因,reload 加载失败源)。
  const sp = escapeForGdLiteral(scenePath);
  const np = escapeForGdLiteral(parentPath);
  // np 定位段:与 genUiMeasureScript _initialize 同款(_mcp_get_scene_node 支持场景根名
  // 前缀剥离,parentPath="/root" 时 _target=场景根;非 root 挂载时定位挂载父——measure
  // path 与 flattenTargets 树根名起算的对齐前提)。
  const npLookup = `\tif "${np}" != "":
\t\tvar _n = _mcp_get_scene_node("${np}")
\t\tif _n == null:
\t\t\t_mcp_output("error", "Node not found (post-persist): ${np} —— build 已持久化,可重跑 ui_measure_layout")
\t\t\t_mcp_done()
\t\t\treturn
\t\t_target = _n
`;
  const measureGo = `func _measure_go() -> void:
${genStyleExpectInit(styleExpect)}\t# --- reload(spec §6 B-1:绕过 ResourceCache 读新落盘场景;裸 load 同进程
\t# 二载命中缓存返回旧实例(无新子树)→ verify 全红,故必须 CACHE_MODE_IGNORE)---
\tif _mcp_scene_instance != null:
\t\tif _mcp_scene_instance.get_parent() != null:
\t\t\t_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
\t\t_mcp_scene_instance.queue_free()
\t\t_mcp_scene_instance = null
\tvar _rl = ResourceLoader.load("${sp}", "", ResourceLoader.CACHE_MODE_IGNORE)
\tif _rl == null or not (_rl is PackedScene):
\t\t_mcp_output("error", "Scene reload failed (post-persist): ${sp} —— build 已持久化,可重跑 ui_measure_layout")
\t\t_mcp_done()
\t\treturn
\t_mcp_scene_instance = _rl.instantiate()
\troot.add_child(_mcp_scene_instance)
\t_target = _mcp_scene_instance
${genThemeMountInit(themePath)}${npLookup}\tprocess_frame.connect(_on_measure_frame)
`;

  // ① build 段尾替换。锚点守卫:genUiBuildLayoutScript 结构变更导致替换未命中时,静默
  // 产出「build 完 _mcp_done 不测量」的假脚本——fail fast 在生成期。
  const buildBlock = genUiBuildLayoutScript(scenePath, parentPath, tree, viewport, true)
    .replace(/\t_mcp_output\("layout_built"[\s\S]*?\t_mcp_done\(\)\n$/, '\tcall_deferred("_measure_go")\n');
  if (!buildBlock.endsWith('\tcall_deferred("_measure_go")\n')) {
    throw new Error('ui-import-single: build 尾部锚点(layout_built+_mcp_done)替换未命中——genUiBuildLayoutScript 结构变更需同步本模板');
  }

  // ② measure 核心截取。锚点守卫同上:indexOf -1 会让 slice 静默产出损坏脚本。
  // themePath 不传给 genUiMeasureScript:其 _initialize(含 themeMount 注入位)在下一步
  // 整体剥离,本链真正的挂载点在上方 _measure_go 的 genThemeMountInit(themePath)。
  const measureFull = genUiMeasureScript(scenePath, parentPath, 16, styleExpect);
  const anchorIdx = measureFull.indexOf('var _frames := 0');
  if (anchorIdx < 0) {
    throw new Error('ui-import-single: ui-measure 截取锚点 "var _frames := 0" 缺失——genUiMeasureScript 结构变更需同步本模板');
  }
  const measureCore = measureFull
    .slice(anchorIdx)
    .replace(/\nfunc _initialize\(\):[\s\S]*?(?=\nfunc _on_measure_frame)/, '\n');
  if (measureCore.includes('func _initialize')) {
    throw new Error('ui-import-single: measure _initialize 剥离未命中(锚点 regex 失配)——genUiMeasureScript 结构变更需同步本模板');
  }

  return `${buildBlock}${measureCore}${measureGo}`;
}
