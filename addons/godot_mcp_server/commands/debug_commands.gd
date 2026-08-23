extends Node

# CMP-3 (2026-08-08): debug 组 Phase 1 — 断点管理(editor-only)
# 提供 set/clear/list breakpoint 三个同步 action。
# AI 能预置断点,用户 F5 运行后命中——从无到有的质变。
#
# 断点走 CodeEdit gutter 路径(竞品 regiellis/godot-mcp-go 验证可行):
# - 不走底层 breakpoint debugger message(只 arm game,不可见/跨 run 丢失)
# - 走 CodeEdit.set_line_as_breakpoint → 进入 editor breakpoint map
#   → 现行 game 命中 + 下次 run 同步 + gutter 可见 + Breakpoints 列表可见
#
# 设计决策(Phase 1 简化):
# - 只对当前活跃 tab 的脚本操作(get_current_script,非 get_open_scripts 全集)
# - CMP-14 (2026-08-09): 自动打开脚本(EditorInterface.edit_script)— 修 Phase 1 限制
#   Phase 1 要求脚本已是当前 tab;Phase 2 改为自动 edit_script 打开
# - 脚本未打开 → 报错提示 AI 先用 editor 工具打开或让用户手动打开
# - 行号 1-based(AI 友好)→ CodeEdit 0-based 内部转换
# - path 必须是 res:// 开头

var _plugin: EditorPlugin
# CMP-14 (2026-08-09): debugger bridge(EditorDebuggerPlugin 子类,经 plugin._debugger_bridge 访问)
# 注:不在此缓存 _bridge —— plugin.gd _enter_tree 里 websocket_server(含 command_handler →
# debug_commands.setup)先于 add_debugger_plugin 创建,setup 时 _debugger_bridge 尚未赋值。
# 改为每次调用时经 _ensure_bridge 动态取(此时 plugin._debugger_bridge 已在 _enter_tree 赋值)。


func setup(plugin: EditorPlugin, _undo_manager: Node = null) -> void:
	_plugin = plugin


func cleanup() -> void:
	_plugin = null


# CMP-16-A (2026-08-08) + CMP-14 (2026-08-09): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"debug_set_breakpoint": {
			"description": "在指定脚本行设置断点(走 CodeEdit gutter,进入 editor breakpoint map)。CMP-14 后支持自动打开脚本(无需预先激活 tab)。",
			"params": [
				CommandHelpers.doc_param("path", "String", true, "res:// 路径的 .gd 脚本"),
				CommandHelpers.doc_param("line", "int", true, "1-based 行号"),
			],
		},
		"debug_clear_breakpoint": {
			"description": "清除指定脚本行的断点。CMP-14 后支持自动打开脚本。",
			"params": [
				CommandHelpers.doc_param("path", "String", true, "res:// 路径的 .gd 脚本"),
				CommandHelpers.doc_param("line", "int", true, "1-based 行号"),
			],
		},
		"debug_list_breakpoints": {
			"description": "列出当前活跃 tab 脚本的断点(Phase 1 只查当前 tab)。",
			"params": [
				CommandHelpers.doc_param("path", "String", false, "可选:只列指定脚本(留空=当前活跃 tab)"),
			],
		},
		# CMP-14 (2026-08-09) Phase 2/3
		"debug_stack_trace": {
			"description": "读当前断点的调用栈 + 当前帧局部变量。需游戏暂停在断点。",
			"params": [
				CommandHelpers.doc_param("all_vars", "bool", false, "true=返回全部变量(默认截断 100 个)"),
				CommandHelpers.doc_param("filter", "String", false, "变量名子串过滤"),
			],
		},
		"debug_inspect_frame": {
			"description": "切到指定栈帧 + 读该帧局部变量。需游戏暂停在断点。",
			"params": [
				CommandHelpers.doc_param("frame_index", "int", false, "栈帧索引(0=最内层,默认 0)"),
				CommandHelpers.doc_param("all_vars", "bool", false, "true=返回全部变量(默认截断 100 个)"),
				CommandHelpers.doc_param("filter", "String", false, "变量名子串过滤"),
			],
		},
		"debug_evaluate": {
			"description": "断点上下文表达式求值(REPL)。需游戏暂停在断点。",
			"params": [
				CommandHelpers.doc_param("expression", "String", true, "GDScript 表达式(在当前断点上下文求值)"),
			],
		},
		"debug_step": {
			"description": "单步执行(into/over)。需游戏暂停在断点。注:Godot wire 协议不支持 out。",
			"params": [
				CommandHelpers.doc_param("mode", "String", false, "into=进入函数 / over=跨过函数(默认 over)"),
			],
		},
		"debug_continue": {
			"description": "继续运行到下一断点。需游戏暂停在断点。",
			"params": [],
		},
		"debug_pause": {
			"description": "请求中断(暂停运行中游戏)。需游戏运行中。",
			"params": [],
		},
		"debug_reload_scripts": {
			"description": "热重载指定脚本到运行中游戏。需游戏运行中(非暂停)。拒绝重载 MCP 自身 addon。",
			"params": [
				CommandHelpers.doc_param("paths", "Array", true, "res:// 脚本路径数组(如 [\"res://Player.gd\"])"),
			],
		},
	}


# ─── Breakpoint management ────────────────────────────────────────────────────

func handle_set_breakpoint(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var line: int = int(params.get("line", 0))
	if path == "":
		return {"error": {"code": -32602, "message": "path is required (res:// path to .gd script)"}}
	if line < 1:
		return {"error": {"code": -32602, "message": "line is required (1-based line number)"}}
	if not path.begins_with("res://"):
		return {"error": {"code": -32602, "message": "path must be a res:// path, got: %s" % path}}
	# I-2 (2026-08-14 审查 P2): 防 path traversal(res://../ 逃出项目根,load()+edit_script
	# 可加载/打开项目外 .gd,错误信息差构成存在性+行数 oracle)。对齐 handle_reload_scripts
	# 的 P2-5 同款 contains("..") 拒绝。
	if path.contains(".."):
		return {"error": {"code": -32602, "message": "Path must not contain '..' (path traversal blocked): %s" % path}}
	return _toggle_breakpoint(path, line, true)


func handle_clear_breakpoint(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var line: int = int(params.get("line", 0))
	if path == "":
		return {"error": {"code": -32602, "message": "path is required (res:// path to .gd script)"}}
	if line < 1:
		return {"error": {"code": -32602, "message": "line is required (1-based line number)"}}
	if not path.begins_with("res://"):
		return {"error": {"code": -32602, "message": "path must be a res:// path, got: %s" % path}}
	# I-2 (2026-08-14 审查 P2): 同 handle_set_breakpoint,防 path traversal(对称加固)。
	if path.contains(".."):
		return {"error": {"code": -32602, "message": "Path must not contain '..' (path traversal blocked): %s" % path}}
	return _toggle_breakpoint(path, line, false)


func handle_list_breakpoints(params: Dictionary) -> Dictionary:
	var filter_path: String = params.get("path", "")
	var script_editor: ScriptEditor = EditorInterface.get_script_editor()
	var result: Array = []
	# Phase 1:只查当前活跃 tab 的断点(get_breakpointed_lines 只在当前 CodeEdit 可用)
	var current_script: Resource = script_editor.get_current_script()
	if current_script != null and current_script is Script:
		var res_path: String = current_script.resource_path
		if filter_path == "" or res_path == filter_path:
			var ce_result: Dictionary = _get_current_code_edit(script_editor)
			var code_edit: CodeEdit = ce_result.get("code_edit", null)
			if code_edit != null:
				var bp_lines: PackedInt32Array = code_edit.get_breakpointed_lines()
				if not bp_lines.is_empty():
					# CodeEdit 行号 0-based → 转 1-based(AI 友好)
					var lines_1based: Array = []
					for bp_line in bp_lines:
						lines_1based.append(bp_line + 1)
					result.append({"path": res_path, "lines": lines_1based})
	return {"result": {"breakpoints": result, "count": result.size(), "scope": "current_tab", "note": "Only lists breakpoints for the currently active script tab. Open the script in the editor to list its breakpoints."}}


# ─── Internal helpers ────────────────────────────────────────────────────────

# toggle 断点的核心:找到已打开的脚本 → 拿 CodeEdit → set_line_as_breakpoint → 二次校验
# Phase 1 只对当前活跃 tab 操作(避免异步切换 tab 复杂度)
func _toggle_breakpoint(path: String, line: int, enabled: bool) -> Dictionary:
	var script_editor: ScriptEditor = EditorInterface.get_script_editor()
	# CMP-14 (2026-08-09): 自动打开脚本(修 Phase 1 限制)。
	# Phase 1 要求脚本已是当前活跃 tab,否则报错。Phase 2 改为:若脚本未打开或非当前 tab,
	# 用 EditorInterface.edit_script(load(path)) 自动打开(文档确认这会打开并激活脚本)。
	var current_script: Resource = script_editor.get_current_script()
	if current_script == null or not current_script is Script or current_script.resource_path != path:
		# 尝试自动打开目标脚本
		var loaded: Resource = load(path)
		if loaded == null or not loaded is Script:
			return {"error": {"code": -32004, "message": "Script %s could not be loaded (file may not exist or is not a valid GDScript)." % path}}
		EditorInterface.edit_script(loaded)
		# edit_script 同步激活,重新取 current_script
		current_script = script_editor.get_current_script()
	# 校验:edit_script 后仍非目标脚本(罕见,如路径不匹配)
	if current_script == null or current_script.resource_path != path:
		return {"error": {"code": -32004, "message": "Could not activate script %s as the current tab. Open it manually in the editor." % path}}
	# 拿 CodeEdit
	# GD-R7: _get_current_code_edit 返回 Dictionary 含 reason,错误信息区分版本不兼容/布局异常/无 tab
	var ce_result: Dictionary = _get_current_code_edit(script_editor)
	var code_edit: CodeEdit = ce_result.get("code_edit", null)
	if code_edit == null:
		return {"error": {"code": -32003, "message": "Could not get CodeEdit: %s" % ce_result.get("reason", "unknown error")}}
	# 行号 1-based(AI)→ 0-based(CodeEdit 内部)
	var line_0based: int = line - 1
	if line_0based < 0 or line_0based >= code_edit.get_line_count():
		return {"error": {"code": -32602, "message": "Line %d is out of range (script has %d lines)" % [line, code_edit.get_line_count()]}}
	# toggle gutter breakpoint
	code_edit.set_line_as_breakpoint(line_0based, enabled)
	# 二次校验:gutter 是否真的接受了变更
	var actual: bool = code_edit.is_line_breakpointed(line_0based)
	if actual != enabled:
		return {"error": {"code": -32003, "message": "Breakpoint gutter did not take the change (line %d of %s)" % [line, path]}}
	# issue #63(2026-08-23):set_breakpoint 是 play 前最后一步,此处提前连接面板
	# stack_dump 等兜底信号(ensure_connected 幂等),消除"游戏 break 瞬间信号尚未
	# 连接 → 一次性 stack_dump 信号永久丢失"的错过窗口。找不到面板时静默,由后续
	# debug 读取类 handler 的 refetch_stack 补拉兜底。
	var br := _ensure_bridge()
	if br.ok:
		br.bridge.call("ensure_connected")
	return {"result": {
		"path": path,
		"line": line,
		"enabled": enabled,
		"visible_in_editor": true,
		"note": "Breakpoint is in the editor's breakpoint map: visible in gutter, live for a running game, and kept for the next run.",
	}}


# 从当前活跃 editor 拿 CodeEdit(ScriptEditorBase.get_base_editor)
# GD-R7 (2026-08-08): 返回 Dictionary 含 code_edit + reason,区分"版本不兼容"vs"布局异常"vs"无活跃 tab"
func _get_current_code_edit(script_editor: ScriptEditor) -> Dictionary:
	var editor = script_editor.get_current_editor()
	if editor == null:
		return {"code_edit": null, "reason": "No active script editor tab — open a script first"}
	if not editor.has_method("get_base_editor"):
		return {"code_edit": null, "reason": "Editor version unsupported: ScriptEditorBase lacks get_base_editor method (possible Godot version incompatibility)"}
	var base = editor.call("get_base_editor")
	if base is CodeEdit:
		return {"code_edit": base as CodeEdit, "reason": ""}
	return {"code_edit": null, "reason": "Active editor's base is not a CodeEdit (got %s) — internal layout may have changed" % ("" if base == null else base.get_class())}


# ─── CMP-14 (2026-08-09): Phase 2/3 调试器集成 ─────────────────────────────────
#
# 7 个异步 handler,经 _bridge(EditorDebuggerPlugin 子类)与运行中游戏调试会话交互。
# 对标竞品 regiellis/godot-mcp-go 的 debug 组(state/frame/step/resume/pause/reload_scripts)。
# 实现完成(2026-08-09,批次 2-6 已落地:settle await + 守卫 + 超时俱全,非桩)。

func _ensure_bridge() -> Dictionary:
	# 校验 bridge 可用(防 Phase 2/3 在无 bridge 环境调用)。
	# CMP-14: 每次**动态**从 plugin 取 _debugger_bridge(非 setup 时缓存)——
	# 因 plugin.gd _enter_tree 时序:websocket_server(setup 链)先于 add_debugger_plugin,
	# setup 时取必为 null。运行时(handler 真正被调用时)_debugger_bridge 已赋值。
	# 返回 {ok: bool, bridge: EditorDebuggerPlugin, error: Dictionary}
	var bridge: EditorDebuggerPlugin = null
	if _plugin != null and _plugin.has_method("get"):
		var fetched = _plugin.get("_debugger_bridge")
		if fetched is EditorDebuggerPlugin:
			bridge = fetched
	if bridge == null or not is_instance_valid(bridge):
		return {"ok": false, "bridge": null, "error": {"error": {"code": -32000, "message": "Debugger bridge not available (CMP-14 Phase 2/3 requires editor mode with debugger plugin registered)"}}}
	return {"ok": true, "bridge": bridge, "error": {}}


func handle_stack_trace(params: Dictionary) -> Dictionary:
	# CMP-14 批次 3:读当前断点的调用栈 + 当前帧变量。
	# 对标竞品 debug.state(读取部分)。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	# 1. 确保面板信号已连接(首次调用时 discover)
	bridge.call("ensure_connected")

	# 2. A4: 单 session 解析(替代 current_break 的"第一个 breaked"+ 面板归属含糊迭代,
	#    消除与 evaluate/active_sessions()[0] 的 session 归属错配)
	var rs: Dictionary = bridge.call("resolve_session")
	if not bool(rs.get("ok", false)):
		var rs_err: Dictionary = rs.get("error", {})
		if str(rs_err.get("message", "")).begins_with("Multiple"):
			return {"error": rs_err}
		# 无活跃 session(未运行/未断点)→ 原同款提示(含 playing 状态)
		return {"result": {
			"breaked": false,
			"playing": EditorInterface.is_playing_scene(),
			"note": "Game is not paused at a breakpoint. Use debug_pause or set a breakpoint first." if EditorInterface.is_playing_scene() else "No scene is playing. Run the project (F5) first.",
		}}
	var state: Dictionary = rs["state"]
	if not bool(state.get("breaked", false)):
		# 有 session 但未暂停在断点
		return {"result": {
			"breaked": false,
			"playing": EditorInterface.is_playing_scene(),
			"note": "Game is not paused at a breakpoint. Use debug_pause or set a breakpoint first.",
		}}

	# 3. 错过自愈(issue #63):breaked 但 has_stackdump=false = 一次性面板信号被错过
	#    的症状,主动补拉一次 get_stack_dump(每 break 周期至多一次)再 settle
	if not bool(state.get("has_stackdump", false)):
		bridge.call("refetch_stack", state)
	# 4. settle:等栈/变量落地(信号可能滞后 50-200ms)
	state = await bridge.call("settle", state)

	# 4. 从面板回读真实选中帧(防用户手点)
	var selected: int = bridge.call("synced_selection", state)

	# 5. 变量截断/过滤(默认 VARS_CAP 截断,all_vars=true 全给,filter 子串过滤)
	var all_vars: bool = bool(params.get("all_vars", false))
	var filter: String = params.get("filter", "")
	var all_var_list: Array = state.get("vars", [])
	var matched: Array = []
	for v in all_var_list:
		if filter != "" and not str(v.get("name", "")).contains(filter):
			continue
		matched.append(v)
	var vars_truncated := 0
	if not all_vars and matched.size() > bridge.get("VARS_CAP"):
		vars_truncated = matched.size() - bridge.get("VARS_CAP")
		matched = matched.slice(0, bridge.get("VARS_CAP"))

	# 6. 整形返回(对标竞品 _describe_break)
	return {"result": {
		"breaked": true,
		"reason": state.get("reason", ""),
		"can_debug": state.get("can_debug", false),
		"frames": state.get("frames", []),
		"selected_frame": selected,
		"vars_total": all_var_list.size(),
		"vars": matched,
		"vars_truncated": vars_truncated if vars_truncated > 0 else null,
		"filter": filter if filter != "" else null,
	}}


func handle_inspect_frame(params: Dictionary) -> Dictionary:
	# CMP-14 批次 3:切到指定栈帧 + 读该帧局部变量。
	# 对标竞品 debug.frame。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	var frame_index: int = int(params.get("frame_index", 0))

	bridge.call("ensure_connected")
	# A4: 单 session 解析(state/session 同源,消除 current_break+active_sessions[0] 错配)
	var rs: Dictionary = bridge.call("resolve_session")
	if not bool(rs.get("ok", false)):
		return {"error": rs.get("error", {})}
	var state: Dictionary = rs["state"]
	if not bool(state.get("breaked", false)):
		return {"error": {"code": -32000, "message": "Game is not paused, so there is no frame to inspect. Set a breakpoint and pause first."}}

	# 错过自愈(issue #63):frames 未见时先补拉一次再 settle —— select_frame 依赖
	# 面板栈 Tree 已填充(Tree 由 stack_dump 消息驱动),frames 空则 select 必败
	if not bool(state.get("has_stackdump", false)):
		bridge.call("refetch_stack", state)
		state = await bridge.call("settle", state)

	# 切帧(触发编辑器自动拉该帧变量)
	var sel_result: Dictionary = bridge.call("select_frame", state, frame_index)
	if not sel_result.get("ok", false):
		return {"error": {"code": -32001, "message": "Failed to select frame %d: %s" % [frame_index, sel_result.get("why", "unknown")]}}

	# settle:等新帧变量落地
	state = await bridge.call("settle", state)

	# 变量截断/过滤(同 handle_stack_trace)
	var all_vars: bool = bool(params.get("all_vars", false))
	var filter: String = params.get("filter", "")
	var all_var_list: Array = state.get("vars", [])
	var matched: Array = []
	for v in all_var_list:
		if filter != "" and not str(v.get("name", "")).contains(filter):
			continue
		matched.append(v)
	var vars_truncated := 0
	if not all_vars and matched.size() > bridge.get("VARS_CAP"):
		vars_truncated = matched.size() - bridge.get("VARS_CAP")
		matched = matched.slice(0, bridge.get("VARS_CAP"))

	return {"result": {
		"breaked": true,
		"selected_frame": frame_index,
		"frames": state.get("frames", []),
		"vars_total": all_var_list.size(),
		"vars": matched,
		"vars_truncated": vars_truncated if vars_truncated > 0 else null,
		"filter": filter if filter != "" else null,
	}}


func handle_evaluate(params: Dictionary) -> Dictionary:
	# CMP-14 批次 5:断点上下文表达式求值(REPL)。对标竞品 + Godot-MCP-Native evaluate-debug-expression。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	var expression: String = params.get("expression", "")
	if expression == "":
		return {"error": {"code": -32602, "message": "expression is required (GDScript expression to evaluate in the current breakpoint context)"}}

	bridge.call("ensure_connected")
	# A4: 单 session 解析——evaluate 用与 state 同源的 session(原 current_break 取"第一个
	# breaked" + active_sessions()[0] 取首个 session,两者可能不同 session,结果串台)。
	var rs: Dictionary = bridge.call("resolve_session")
	if not bool(rs.get("ok", false)):
		return {"error": rs.get("error", {})}
	var state: Dictionary = rs["state"]
	if not bool(state.get("breaked", false)):
		return {"error": {"code": -32000, "message": "Game is not paused, so there is no breakpoint context to evaluate in. Pause at a breakpoint first."}}
	var session: EditorDebuggerSession = rs["session"]

	# 重置 eval 接收标志
	state["eval_received"] = false
	state["eval_result"] = null

	# 发 evaluate 消息(编辑器→游戏)
	session.send_message("evaluate", [expression])

	# 等 evaluation_return(超时 3s,表达式可能复杂)
	var deadline := Time.get_ticks_msec() + 3000
	while Time.get_ticks_msec() < deadline:
		if bool(state.get("eval_received", false)):
			return {"result": {"expression": expression, "value": state.get("eval_result", null)}}
		if not EditorInterface.is_playing_scene():
			return {"error": {"code": -32000, "message": "Game stopped before evaluation returned."}}
		await Engine.get_main_loop().process_frame
	return {"error": {"code": -32000, "message": "Evaluation timed out (3s). The expression may be too complex or the debugger did not respond."}}


func handle_step(params: Dictionary) -> Dictionary:
	# CMP-14 批次 4:单步执行(into/over)。对标竞品 debug.step。
	# step 不能用 send_message("step")(thread id 设不了),走按钮 emit pressed。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	var mode: String = params.get("mode", "over").to_lower()
	if mode != "into" and mode != "over":
		return {"error": {"code": -32602, "message": "'mode' must be 'into' or 'over' (got '%s'). Note: 'out' is not supported by Godot's debugger wire protocol." % mode}}

	bridge.call("ensure_connected")
	var state: Dictionary = bridge.call("current_break")
	if state.is_empty():
		return {"error": {"code": -32000, "message": "The game is not paused, so there is nothing to step. Set a breakpoint and pause first."}}
	if not bool(state.get("can_debug", false)):
		return {"error": {"code": -32009, "message": "This break is not steppable: the engine reports can_debug=false (e.g. fatal error break). Only debug_continue is offered from here."}}

	var was_at: int = int(state.get("at", 0))
	var pressed: Dictionary = bridge.call("press", mode)
	if not bool(pressed.get("ok", false)):
		return {"error": {"code": -32000, "message": "Step failed: %s" % pressed.get("why", "unknown")}}

	# 等新断点(STEP_WAIT_MS=2s);超时不当错误(游戏继续跑是真实结果)
	var STEP_WAIT: int = bridge.get("STEP_WAIT_MS")
	var landed: Dictionary = await bridge.call("await_new_break", was_at, STEP_WAIT)
	if landed.is_empty():
		# 超时:游戏继续运行(没命中新断点)
		return {"result": {
			"stepped": true,
			"mode": mode,
			"playing": EditorInterface.is_playing_scene(),
			"breaked": false,
			"note": "The game ran on instead of stopping again, so it is running now, not paused.",
		}}
	# 命中新断点
	landed = await bridge.call("settle", landed)
	return {"result": {
		"stepped": true,
		"mode": mode,
		"breaked": true,
		"location": {"file": (landed.get("frames", [])[0].get("file", "") if landed.get("frames", []).size() > 0 else ""), "line": (landed.get("frames", [])[0].get("line", 0) if landed.get("frames", []).size() > 0 else 0)},
		"reason": landed.get("reason", ""),
	}}


func handle_continue(params: Dictionary) -> Dictionary:
	# CMP-14 批次 4:继续运行(到下一断点)。对标竞品 debug.resume。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	bridge.call("ensure_connected")
	var state: Dictionary = bridge.call("current_break")
	# 未暂停时 resume 无意义,但不算错(可能是用户已手动 resume)
	if state.is_empty():
		return {"result": {"resumed": false, "playing": EditorInterface.is_playing_scene(), "note": "Game is not paused; nothing to resume."}}

	var was_at: int = int(state.get("at", 0))
	var pressed: Dictionary = bridge.call("press", "resume")
	if not bool(pressed.get("ok", false)):
		return {"error": {"code": -32000, "message": "Resume failed: %s" % pressed.get("why", "unknown")}}

	# 等新断点(RESUME_WATCH_MS=1s);超时=游戏继续跑
	var RESUME_WAIT: int = bridge.get("RESUME_WATCH_MS")
	var landed: Dictionary = await bridge.call("await_new_break", was_at, RESUME_WAIT)
	if landed.is_empty():
		return {"result": {"resumed": true, "rebroke": false, "playing": true}}
	landed = await bridge.call("settle", landed)
	return {"result": {"resumed": true, "rebroke": true, "playing": true, "state": {"reason": landed.get("reason", ""), "frames": landed.get("frames", [])}}}


func handle_pause(params: Dictionary) -> Dictionary:
	# CMP-14 批次 4:请求中断(暂停运行中游戏)。对标竞品 debug.pause。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	bridge.call("ensure_connected")
	if not EditorInterface.is_playing_scene():
		return {"error": {"code": -32000, "message": "No scene is currently playing, so there is nothing to pause."}}

	# 已暂停则无需 pause
	var state: Dictionary = bridge.call("current_break")
	if not state.is_empty():
		return {"result": {"pause_requested": false, "breaked": true, "note": "Game is already paused.", "state": {"reason": state.get("reason", ""), "frames": state.get("frames", [])}}}

	var pressed: Dictionary = bridge.call("press", "pause")
	if not bool(pressed.get("ok", false)):
		return {"error": {"code": -32000, "message": "Pause failed: %s" % pressed.get("why", "unknown")}}

	# 轮询等 is_breaked(PAUSE_WATCH_MS=1s)
	var PAUSE_WAIT: int = bridge.get("PAUSE_WATCH_MS")
	var deadline := Time.get_ticks_msec() + PAUSE_WAIT
	while Time.get_ticks_msec() < deadline:
		state = bridge.call("current_break")
		if not state.is_empty():
			state = await bridge.call("settle", state)
			return {"result": {"pause_requested": true, "breaked": true, "state": {"reason": state.get("reason", ""), "frames": state.get("frames", [])}}}
		if not EditorInterface.is_playing_scene():
			return {"result": {"pause_requested": true, "breaked": false, "note": "Game stopped before pausing."}}
		await Engine.get_main_loop().process_frame
	return {"result": {"pause_requested": true, "breaked": false, "note": "Pause requested but game did not break within %dms (it may be running native code)." % PAUSE_WAIT}}


func handle_reload_scripts(params: Dictionary) -> Dictionary:
	# CMP-14 批次 6:热重载指定脚本到运行中游戏。对标竞品 debug.reload_scripts。
	var br := _ensure_bridge()
	if not br.ok: return br.error
	var bridge: EditorDebuggerPlugin = br.bridge

	# 守卫 1:必须有运行中场景
	if not EditorInterface.is_playing_scene():
		return {"error": {"code": -32000, "message": "No scene is currently playing, so there is nothing to reload into. Run the project (F5) first.", "suggestion": "Use the editor's play button to start the scene before reloading scripts."}}

	# 守卫 2:单 session 解析(I-1 2026-08-14 审查:原 active_sessions()[0] 静默选第一个,
	# 双 run 时 reload 可能发给非目标 session 且 send_message 无 reply 难察觉;对齐三件套
	# stack_trace/inspect_frame/evaluate 的 A4 resolve_session() 写法,多 session 明确拒绝)
	var rs: Dictionary = bridge.call("resolve_session")
	if not bool(rs.get("ok", false)):
		var rs_err: Dictionary = rs.get("error", {})
		if str(rs_err.get("message", "")).begins_with("Multiple"):
			return {"error": rs_err}
		# 无活跃 session(游戏启动中)→ 原同款提示
		return {"error": {"code": -32000, "message": "The game is starting and has no debug session yet. Wait a moment and retry."}}
	var session: EditorDebuggerSession = rs["session"]

	# 守卫 3:暂停态拒绝(reload 会 queue unheard)——state 与 session 同源(resolve_session)
	if bool(rs["state"].get("breaked", false)):
		return {"error": {"code": -32009, "message": "The game is paused at a break, and a reload sent now would queue unheard (the debugger freezes message processing while paused).", "suggestion": "Resume it with debug_continue first, then reload."}}

	# 守卫 4:path 校验(防重载 MCP 自身致会话断)
	var paths: Array = []
	if params.has("paths") and params.get("paths") is Array:
		paths = params["paths"]
	if paths.is_empty():
		return {"error": {"code": -32602, "message": "paths is required (JSON array of res:// script paths to reload, e.g. [\"res://Player.gd\"])"}}
	for p in paths:
		var path_str: String = str(p)
		if not path_str.begins_with("res://"):
			return {"error": {"code": -32602, "message": "Path must be a res:// path, got: %s" % path_str}}
		# P2-5 (2026-08-11 审查): 防 path traversal(../ 绕 res:// 限制)。4 道守卫
		# (playing/session/非暂停/MCP addon)兜底仍在,此为对称加固(与其他工具 path 校验对齐)。
		if path_str.contains(".."):
			return {"error": {"code": -32602, "message": "Path must not contain '..' (path traversal blocked): %s" % path_str}}
		# 防 reload MCP 自身 addon 致 debug session 断
		if path_str.begins_with("res://addons/godot_mcp_server/"):
			return {"error": {"code": -32000, "message": "Refusing to reload MCP server addon scripts (%s) — this would break the debug session. Reload MCP changes via editor restart." % path_str}}

	var filesystem = EditorInterface.get_resource_filesystem()

	# 先 update_file 通知编辑器 FS(否则游戏重读旧缓存)
	for path in paths:
		filesystem.update_file(path)

	# 发 reload 消息(游戏进程内处理,无 reply)
	session.send_message("scene:reload_cached_files", [PackedStringArray(paths)])

	return {"result": {
		"reloaded": paths,
		"sessions_active": 1,
		"caveats": [
			"autoload singletons keep their old instances (state preserved, code updated)",
			"reload swaps code but not state: @export defaults and initialized vars won't reapply to live nodes",
			"class_name only updates on a fresh run (restart the scene)",
		],
	}}
