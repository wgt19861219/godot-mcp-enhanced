extends Node

const McpTestRunner := preload("res://addons/godot_mcp_server/testing/mcp_test_runner.gd")

var _plugin: EditorPlugin
var _undo_manager: Node
var _test_runner: RefCounted
## N-5 (审查): handle_test_run 维护的聚合结果。handle_test_manage 返回此快照
## 而非 _test_runner.get_results()（runner 每 run_suite 头 _results.clear()，
## 多 suite 跑完后只剩最后一个 suite）。
var _last_combined_results: Dictionary = {}

func setup(plugin: EditorPlugin, undo_manager: Node = null) -> void:
	_plugin = plugin
	_undo_manager = undo_manager
	_test_runner = McpTestRunner.new()


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"test_assert": {
			"description": "对当前场景做节点/属性/信号/数量类断言。",
			"params": [
				CommandHelpers.doc_param("assertion_type", "String", true, "断言类型 node_exists/property_equals/signal_connected/node_count"),
				CommandHelpers.doc_param("path", "String", false, "目标节点路径"),
				CommandHelpers.doc_param("property", "String", false, "property_equals 时属性名"),
				CommandHelpers.doc_param("expected", "JSON", false, "property_equals 时期望值"),
				CommandHelpers.doc_param("target", "String", false, "signal_connected 时目标节点路径"),
				CommandHelpers.doc_param("signal", "String", false, "signal_connected 时信号名"),
				CommandHelpers.doc_param("method", "String", false, "signal_connected 时目标方法名"),
				CommandHelpers.doc_param("parent", "String", false, "node_count 时父节点路径"),
				CommandHelpers.doc_param("count", "int", false, "node_count 时期望子节点数默认 -1"),
			],
		},
		"test_run": {
			"description": "按名称过滤运行测试套件并聚合结果。",
			"params": [
				CommandHelpers.doc_param("suite", "String", false, "suite 名子串过滤"),
				CommandHelpers.doc_param("test_name", "String", false, "测试名子串过滤"),
				CommandHelpers.doc_param("exclude_test_name", "String", false, "要排除的测试名子串"),
				CommandHelpers.doc_param("verbose", "bool", false, "详细输出默认 false"),
			],
		},
		"test_manage": {
			"description": "查看上次测试结果或重置 runner(op 默认 results_get)。",
			"params": [
				CommandHelpers.doc_param("verbose", "bool", false, "详细输出默认 false"),
				CommandHelpers.doc_param("op", "String", false, "操作名默认 results_get"),
			],
		},
	}


func handle_test_assert(params: Dictionary) -> Dictionary:
	var assertion_type: String = params.get("assertion_type", "")
	var path: String = params.get("path", "")
	var root: Node = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	match assertion_type:
		"node_exists":
			var node = CommandHelpers.find_node(root, path)
			if node != null:
				return {"result": {"passed": true, "message": "Node exists: " + path}}
			else:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
		"property_equals":
			var node = CommandHelpers.find_node(root, path)
			if node == null:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
			var prop: String = params.get("property", "")
			# 2026-08-06 审查 P1 修复：未走 BLOCKED_PROPERTIES 过滤 → 可读 script 等敏感属性，
			# 且 Node/Resource 对象走 values_equal str fallback 永远 false/true 随机命中。
			# 对齐 _cmd_get_node_properties（mcp_bridge.gd）+ set_instance_property 的守卫模式。
			if prop in CommandHelpers.BLOCKED_PROPERTIES or prop.begins_with("_") or ":" in prop or "/" in prop:
				return {"result": {"passed": false, "message": "BLOCKED_PROPERTY: " + prop}}
			var val = node.get(prop)
			if val is Object:
				# Node/Resource 对象不能直接比较（str fallback 不可信）
				if val is Resource:
					val = {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
				else:
					val = str(val)  # Node → 路径字符串
			var expected = params.get("expected")
			# C9: 类型感知比较（CommandHelpers.values_equal），修复 str() 比较致 Vector3 vs Array / bool vs int 永不等
			# 2026-08-06 N-3：var match 改 matched 避免遮蔽 GDScript match 关键字
			var matched = CommandHelpers.values_equal(val, expected)
			return {"result": {"passed": matched, "message": "%s.%s = %s (expected: %s)" % [path, prop, str(val), str(expected)], "actual": str(val)}}
		"signal_connected":
			var src_path: String = params.get("path", "")
			var tgt_path: String = params.get("target", "")
			var sig: String = params.get("signal", "")
			var meth: String = params.get("method", "")
			var src = CommandHelpers.find_node(root, src_path)
			var tgt = CommandHelpers.find_node(root, tgt_path)
			if src == null or tgt == null:
				return {"result": {"passed": false, "message": "Source or target node not found"}}
			var connected = src.is_connected(sig, Callable(tgt, meth))
			return {"result": {"passed": connected, "message": "Signal %s->%s.%s %s" % [sig, tgt_path, meth, "connected" if connected else "not connected"]}}
		"node_count":
			var parent_path: String = params.get("parent", "")
			var parent_node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
			if parent_node == null:
				return {"result": {"passed": false, "message": "Parent node not found: " + parent_path}}
			var count: int = parent_node.get_child_count()
			var expected_count: int = CommandHelpers.int_guarded(params.get("count"), -1)
			return {"result": {"passed": count == expected_count, "message": "Children: %d (expected: %d)" % [count, expected_count], "actual": count}}
		_:
			return {"error": {"code": -32004, "message": "Unknown assertion type: " + assertion_type}}


# ----- McpTestSuite runner (P2-12 phase 2) ----------------------------------
#
# Async coroutine path: run_suite yields to the editor main loop between
# tests (via _yield_frame → await get_tree().process_frame), so heartbeat.tick
# keeps firing and pending packets drain — long suites no longer starve the
# WebSocket keepalive. websocket_server.gd routes test_run through `await`
# (like nav_bake_mesh), and EditorToolExecutor wraps it in startOperation/
# endOperation with a 290s budget. test_manage stays synchronous (秒级 results_get).

## Run McpTestSuite scripts. Discovers test_*.gd in res://tests/ and
## res://addons/godot_mcp_server/testing/suites/, then runs them.
## Filters: suite (substring), test_name (substring), exclude_test_name.
## Async (P2-12 phase 2): awaits run_suite which yields between tests.
func handle_test_run_async(params: Dictionary, _request_id: int) -> Dictionary:
	var suite_filter: String = params.get("suite", "")
	var test_filter: String = params.get("test_name", "")
	var exclude_test_filter: String = params.get("exclude_test_name", "")
	var verbose: bool = params.get("verbose", false)

	## Clear previous results before discovery so an abort can never expose
	## a stale prior run via handle_test_manage.
	_test_runner.clear()

	var discovery := McpTestRunner.discover_suites()
	var suites: Array = discovery.suites
	if suites.is_empty():
		var msg := "No test suites found (looked in res://tests/ and res://addons/godot_mcp_server/testing/suites/)"
		if not discovery.errors.is_empty():
			msg += " (%d script(s) failed to load: %s)" % [discovery.errors.size(), ", ".join(discovery.errors)]
		return {"data": {"error": msg, "total": 0, "load_errors": discovery.errors}}

	## ctx threaded into every suite_setup(). Holds the plugin + undo_manager
	## so suites testing editor-only APIs (e.g. test_undo_manager.gd) can
	## access them without re-resolving from EditorInterface.
	var ctx := {
		"plugin": _plugin,
		"undo_manager": _undo_manager,
	}

	var combined_results := {
		"passed": 0,
		"failed": 0,
		"skipped": 0,
		"total": 0,
		"suites_run": [],
		"failures": [],
		"load_errors": discovery.errors,
	}

	## P2-12 phase 2: yield_cb lets the runner await between tests so the
	## editor main loop services heartbeat + drains packets. Mirrors
	## nav_bake_mesh's `await get_tree().process_frame` pattern.
	var yield_cb := Callable(self, "_yield_frame")
	for suite in suites:
		if not suite_filter.is_empty() and suite.suite_name() != suite_filter:
			continue
		var result: Dictionary = await _test_runner.run_suite(
			suite, test_filter, exclude_test_filter, ctx, yield_cb
		)
		combined_results.passed += int(result.get("passed", 0))
		combined_results.failed += int(result.get("failed", 0))
		combined_results.skipped += int(result.get("skipped", 0))
		combined_results.total += int(result.get("total", 0))
		combined_results.suites_run.append(suite.suite_name())
		if result.has("failures"):
			combined_results.failures.append_array(result.failures)
		## Between suites: extra yield (coarse-grained safety net on top of
		## the per-test yield inside run_suite).
		await _yield_frame()

	## verbose per-test rows (P3-4, closed 2026-08-01): 当前 verbose=true 只返聚合 + failures，
	## 不返每条 test 详情。runner 内部 _results 经 run_suite 每 suite 头 _results.clear()，
	## 多 suite 时无法回溯全量 per-test 行。failures 数组已含失败 test 的 message + assertion_count，
	## 覆盖调试需求；全量 per-test rows（含 passed/skipped）无明确需求驱动，YAGNI 不实现。
	## 如未来需要：run_suite 加 verbose 参数传 get_results(true)，handler 收集每 suite 快照。
	_annotate_edited_scene(combined_results)
	## N-5: 缓存聚合结果供 handle_test_manage 取回（runner 内部 _results 只含最后一个 suite）
	_last_combined_results = combined_results.duplicate(true)
	return {"data": combined_results}


## P2-12 phase 2: yield one frame to the editor main loop. Called by the
## runner between tests (via yield_cb) and between suites (directly) so
## heartbeat.tick() fires + pending WebSocket packets drain, preventing
## keepalive starvation on long suites.
func _yield_frame() -> void:
	await get_tree().process_frame


## Partial-results retrieval for the last run (use after timeout/abort).
## N-5: 返回 handle_test_run 缓存的聚合快照（_last_combined_results），非 runner 内部 _results。
func handle_test_manage(params: Dictionary) -> Dictionary:
	var verbose: bool = params.get("verbose", false)
	var op: String = params.get("op", "results_get")
	match op:
		"results_get":
			if _last_combined_results.is_empty():
				return {"data": {"error": "No previous test_run results — call test_run first", "total": 0}}
			_annotate_edited_scene(_last_combined_results)
			return {"data": _last_combined_results}
		_:
			return {"error": {"code": -32004, "message": "Unknown test_manage op: " + op}}


## Surface the edited scene so failures are attributable at a glance (a
## suite that assumes the main scene is open will phantom-fail otherwise).
func _annotate_edited_scene(results: Dictionary) -> void:
	var scene_root := EditorInterface.get_edited_scene_root()
	var edited := scene_root.scene_file_path if scene_root else ""
	results["edited_scene"] = edited
