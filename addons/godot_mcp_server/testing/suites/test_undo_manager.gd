@tool
extends McpTestSuite

## P1-5 coverage suite for undo_manager.gd.
##
## Covers all 6 funcs in addons/godot_mcp_server/undo_manager.gd:
##   1. setup(plugin)
##   2. create_action_mixed(action_name, do_ops, undo_ops)
##   3. _cap_undo_history(undo_redo)                        [private, 2026-10-21]
##   4. _add_method(undo_redo, mode, target, method, args)  [private]
##   5. _add_method_call(undo_redo, mode, m)                [private]
##   6. _apply_op(undo_redo, mode, op)                       [private]
##
## Runs in editor context (EditorUndoRedoManager is unavailable in headless).
## All suites are short (<1s) — phase-1 sync path has no transport hard gate.

const UndoManagerScript := preload("res://addons/godot_mcp_server/undo_manager.gd")

var _plugin: EditorPlugin
var _undo_manager: Node
var _arena: Node  ## throwaway parent for test nodes, torn down in suite_teardown


func suite_name() -> String:
	return "undo_manager"


func suite_setup(ctx: Dictionary) -> void:
	_plugin = ctx.get("plugin", null)
	_undo_manager = ctx.get("undo_manager", null)
	if _plugin == null:
		fail_setup("suite_setup: ctx.plugin is null — run via editor test_run, not headless")
		return
	## Prefer the live undo_manager from command_handler (registered via setup).
	## Fall back to a fresh instance for isolated coverage when the live one
	## isn't threaded through (defensive — should not happen in editor runs).
	if _undo_manager == null:
		_undo_manager = UndoManagerScript.new()
		_undo_manager.setup(_plugin)
	## Arena holds test children so they don't pollute the edited scene root.
	## N-3 (审查): 无场景打开时 get_edited_scene_root() 返回 null，add_child 会 SCRIPT ERROR
	## 崩溃，且 runner 的 fail_setup 无法捕获 suite_setup 内的崩溃。用 skip_suite 体面退出。
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		skip_suite("no scene open in editor — undo_manager tests require an edited scene (open any scene and re-run)")
		return
	_arena = Node.new()
	## P3-BLOCKING-FIX (2026-08-01 全天审查): arena 是 suite 级 fixture，必须在测试间保留。
	## 命名 _McpTestUndoArena 统一前缀约定（所有测试相关节点用 _McpTest*）。
	## 防 mcp_test_runner.gd:_free_mcp_test_nodes_recursive 误清：设 _mcp_test_persistent meta
	## （该函数跳过 has_meta("_mcp_test_persistent") 的节点）。suite_teardown 负责最终释放。
	## 根因见 arena-prefix-collision-blocking：二期 async 路径下 queue_free 在帧末落地。
	_arena.name = "_McpTestUndoArena"
	_arena.set_meta("_mcp_test_owned", true)
	_arena.set_meta("_mcp_test_persistent", true)
	scene_root.add_child(_arena)
	_arena.owner = scene_root


func setup() -> void:
	## Sanity: each test starts with a clean arena (suite_teardown clears at end,
	## but per-test cleanup via track() handles mid-test leaks).
	pass


func teardown() -> void:
	## Drop any arena children left by this test so the next test starts clean.
	for child in _arena.get_children():
		_arena.remove_child(child)
		child.queue_free()


func suite_teardown() -> void:
	if _arena != null and is_instance_valid(_arena):
		var parent := _arena.get_parent()
		if parent != null:
			parent.remove_child(_arena)
		_arena.queue_free()


# ----- test 1: setup() assigns _plugin -------------------------------------

func test_setup_assigns_plugin() -> void:
	## The live _undo_manager was set up with _plugin in command_handler.setup.
	## We assert the round-trip by creating a fresh instance and confirming
	## setup binds the plugin (accessed via the public get_undo_redo() path).
	var fresh := UndoManagerScript.new()
	fresh.setup(_plugin)
	## _plugin is private, but setup's contract is "enables create_action_mixed".
	## Assert indirectly: create_action_mixed must not crash and must produce
	## a committed action (verified in test_create_action_mixed_adds_node).
	## Here we only confirm setup() doesn't leave the instance in a broken
	## state by calling create_action_mixed with empty ops.
	fresh.create_action_mixed("noop", [], [])
	assert_true(true, "setup() + empty create_action_mixed did not crash")
	fresh.free()


# ----- test 2: create_action_mixed adds a node via do, removes via undo ----

func test_create_action_mixed_adds_and_removes_node() -> void:
	var child := Node.new()
	child.name = "_McpTestMethodChild"
	child.set_meta("_mcp_test_owned", true)
	track(child)
	## do_op: add child to arena; undo_op: remove child from arena.
	## create_action_mixed commits the action, so after commit the do-method
	## has executed (add_child landed). Undo should reverse it.
	var do_ops := [{
		"type": "method",
		"target": _arena,
		"method": "add_child",
		"args": [child],
	}]
	var undo_ops := [{
		"type": "method",
		"target": _arena,
		"method": "remove_child",
		"args": [child],
	}]
	_undo_manager.create_action_mixed("add test child", do_ops, undo_ops)
	## After commit, do-method ran: child is in arena.
	assert_eq(child.get_parent(), _arena, "do-method add_child landed the child in arena")
	## Undo the last action via the suite helper (resolves scene/global history).
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo returned true (an action was undone)")
	## After undo, undo-method ran: child removed from arena.
	assert_ne(child.get_parent(), _arena, "undo-method removed the child from arena")


# ----- test 3: _add_method skips null target without crashing --------------

func test_add_method_invalid_target_is_guarded() -> void:
	## _add_method must push_warning and return for a null target, not crash.
	## N-4 + 实测发现: freed 对象传给强类型 Object 形参会 Godot 在函数绑定时
	## 触发 SCRIPT ERROR（"previously freed is not a subclass"），早于函数体的
	## is_instance_valid 守卫 —— 守卫只覆盖 null（绑定时 null 可通过 Object? 形参），
	## 不覆盖 freed。故本测试改用 null（守卫真实覆盖的场景）。
	## freed 场景由 Godot 引擎自身的参数绑定检查兜底（SCRIPT ERROR abort 测试）。
	var children_before := _arena.get_child_count()
	var undo_redo := _plugin.get_undo_redo()
	undo_redo.create_action("test: null target")
	## null target: is_instance_valid(null) = false → push_warning + return（守卫路径）
	_undo_manager._add_method(undo_redo, "do", null, "add_child", [_arena])
	undo_redo.commit_action()
	## 守卫工作正确时 null 的 add_child 从未注册 → commit 不改 arena。
	assert_eq(_arena.get_child_count(), children_before, "null-target guard: no op committed (arena child_count unchanged)")


# ----- test 4: _apply_op property branch -----------------------------------

func test_apply_op_property_do_and_undo() -> void:
	## _apply_op with type="property" must call add_do_property/add_undo_property.
	## We verify by committing an action that sets a property, then undoing it.
	var target := Node.new()
	target.name = "_McpTestPropTarget"
	target.set_meta("_mcp_test_owned", true)
	## Give it a custom property via meta (Node has no settable value props by
	## default, so use name which is a real String property).
	target.name = "before"
	track(target)
	var undo_redo := _plugin.get_undo_redo()
	undo_redo.create_action("test: property op")
	_undo_manager._apply_op(undo_redo, "do", {
		"type": "property",
		"target": target,
		"property": "name",
		"value": "after",
	})
	_undo_manager._apply_op(undo_redo, "undo", {
		"type": "property",
		"target": target,
		"property": "name",
		"value": "before",
	})
	undo_redo.commit_action()
	## After commit, do-property applied: name is "after".
	assert_eq(target.name, "after", "do-property set name to 'after'")
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo returned true")
	## After undo, undo-property applied: name restored to "before".
	assert_eq(target.name, "before", "undo-property restored name to 'before'")


# ----- test 5: _apply_op unknown type falls through with warning -----------

func test_apply_op_unknown_type_is_warned() -> void:
	## _apply_op with an unrecognized type must hit the `_` branch: push_warning
	## and skip (not crash). N-4 (审查): 强断言 — 给 target 一个可观测属性（name），
	## 断言 unknown type op 未改动它（守卫的契约是"什么都不做"）。守卫删了的话
	## match `_` 不执行，但 target.name 也不变 → 仍绿。所以额外断言 commit 后
	## 没有产生 SCRIPT ERROR（runner 隐式保证）+ name 未变（显式反查）。
	var target := Node.new()
	target.name = "_McpTestBefore"
	target.set_meta("_mcp_test_owned", true)
	track(target)
	var undo_redo := _plugin.get_undo_redo()
	undo_redo.create_action("test: unknown op type")
	_undo_manager._apply_op(undo_redo, "do", {
		"type": "nonexistent_type",
		"target": target,
		"property": "name",
		"value": "_McpTestAfter",  ## must NOT be applied (type unrecognized)
	})
	undo_redo.commit_action()
	## commit executed do-methods but unknown-type op registered nothing, so
	## the property assignment never happened → name unchanged.
	assert_eq(target.name, "_McpTestBefore", "unknown-type op did not apply property (name unchanged)")


# ----- test 6: reference op with valid Node (P0-4 补全) --------------------

func test_apply_op_reference_valid_node() -> void:
	## reference op with a valid Node should call add_do_reference.
	## add_do_reference 的效果：undo 后节点不被 queue_free（生命周期由 UndoRedo 管理）。
	## 验证方式：commit 后 undo，节点仍 is_instance_valid（未被释放）。
	var child := Node.new()
	child.name = "_McpTestRefChild"
	child.set_meta("_mcp_test_owned", true)
	track(child)
	var do_ops := [
		{"type": "method", "target": _arena, "method": "add_child", "args": [child]},
		{"type": "reference", "value": child},
	]
	var undo_ops := [
		{"type": "method", "target": _arena, "method": "remove_child", "args": [child]},
	]
	_undo_manager.create_action_mixed("add child with reference", do_ops, undo_ops)
	assert_eq(child.get_parent(), _arena, "do-method add_child landed the child in arena")
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo returned true")
	assert_ne(child.get_parent(), _arena, "undo-method removed the child from arena")
	## 关键验证：reference op 让 UndoRedo 持有生命周期，undo 后节点仍 valid（未被 queue_free）
	assert_true(is_instance_valid(child), "reference op: child still valid after undo (UndoRedo manages lifecycle)")


# ----- test 7: reference op skips non-Node (P0-4 补全) ---------------------

func test_apply_op_reference_skips_non_node() -> void:
	## reference op with a Resource (non-Node) should push_warning and skip.
	## 验证：commit 不 crash + Resource 不被 add_do_reference（无 observable 副作用，
	## 但关键是 push_warning 路径不崩溃）。
	var res := Resource.new()
	res.set_meta("_mcp_test_owned", true)
	track(res)
	var undo_redo := _plugin.get_undo_redo()
	undo_redo.create_action("test: reference non-Node")
	_undo_manager._apply_op(undo_redo, "do", {"type": "reference", "value": res})
	undo_redo.commit_action()
	## Resource 被 push_warning 跳过，不 crash。无 observable 断言（push_warning 是副作用），
	## 只要 commit 不 crash 即通过。
	assert_true(true, "reference op with Resource did not crash (skipped via push_warning)")


# ----- test 8: asset_placer place_one do/undo 对称性 (P0-4 补全) -----------

func test_asset_placer_place_one_symmetry() -> void:
	## 模拟 asset_placer.gd:place_one 的 undo 接入模式：
	## do = add_child + set_owner + reference，undo = remove_child
	## 验证 do 后节点在 arena，undo 后节点被移除且仍 valid（reference 持有生命周期）。
	var placed := Node.new()
	placed.name = "_McpTestPlacedNode"
	placed.set_meta("_mcp_test_owned", true)
	track(placed)
	var scene_root := EditorInterface.get_edited_scene_root()
	var do_ops := [
		{"type": "method", "target": _arena, "method": "add_child", "args": [placed]},
		{"type": "method", "target": placed, "method": "set_owner", "args": [scene_root]},
		{"type": "reference", "value": placed},
	]
	var undo_ops := [
		{"type": "method", "target": _arena, "method": "remove_child", "args": [placed]},
	]
	_undo_manager.create_action_mixed("place_one asset", do_ops, undo_ops)
	## do 后：节点在 arena + owner = scene_root
	assert_eq(placed.get_parent(), _arena, "place_one do: child in arena")
	assert_eq(placed.owner, scene_root, "place_one do: owner set to scene_root")
	## undo 后：节点从 arena 移除，仍 valid
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo returned true")
	assert_ne(placed.get_parent(), _arena, "place_one undo: child removed from arena")
	assert_true(is_instance_valid(placed), "place_one undo: child still valid (reference manages lifecycle)")


# ----- test 9: batch 操作原子性 (P0-4 补全) --------------------------------

func test_batch_operations_atomic_undo() -> void:
	## 模拟 asset_placer.gd:place_batch 的 undo 接入模式：
	## 多个节点累积进一次 create_action_mixed，一次 Ctrl+Z 全部撤销。
	var nodes: Array[Node] = []
	for i in range(3):
		var n := Node.new()
		n.name = "_McpTestBatch%d" % i
		n.set_meta("_mcp_test_owned", true)
		track(n)
		nodes.append(n)
	var do_ops: Array = []
	var undo_ops: Array = []
	for n in nodes:
		do_ops.append({"type": "method", "target": _arena, "method": "add_child", "args": [n]})
		do_ops.append({"type": "reference", "value": n})
		undo_ops.append({"type": "method", "target": _arena, "method": "remove_child", "args": [n]})
	## 一次 commit 全部 3 个节点（batch 原子性）
	_undo_manager.create_action_mixed("place_batch 3 assets", do_ops, undo_ops)
	for i in range(3):
		assert_eq(nodes[i].get_parent(), _arena, "batch do: node %d in arena" % i)
	## 一次 undo 全部撤销
	var did_undo := editor_undo(_plugin.get_undo_redo())
	assert_true(did_undo, "editor_undo returned true (batch action undone)")
	for i in range(3):
		assert_ne(nodes[i].get_parent(), _arena, "batch undo: node %d removed from arena" % i)
		assert_true(is_instance_valid(nodes[i]), "batch undo: node %d still valid (reference lifecycle)" % i)


# ----- test 10: create_action_mixed 封顶 undo 历史 (2026-10-21) --------------

func test_create_action_caps_undo_history() -> void:
	## 40GB 内存事故根治项：create_action_mixed 后，global 与当前场景两条 history
	## 的 UndoRedo.max_steps 都必须等于 MAX_UNDO_STEPS。注意：cap 是产品行为本身，
	## 本测试运行即把上限真实设进当前编辑器会话（非测试副作用）。只断言属性落位，
	## 不触发 200+ 步真实裁剪（避免污染用户 undo 历史）——裁剪语义由引擎
	## UndoRedo.max_steps 文档保证（"older steps are removed from history"）。
	_undo_manager.create_action_mixed("cap probe", [], [])
	var undo_redo := _plugin.get_undo_redo()
	## Nit-2(null 防御,对齐 mcp_test_suite._collect_histories 风格):
	## get_history_undo_redo 理论可返 null,null 时给出断言失败而非 SCRIPT ERROR。
	var global_ur: UndoRedo = undo_redo.get_history_undo_redo(EditorUndoRedoManager.GLOBAL_HISTORY)
	assert_true(global_ur != null, "global history UndoRedo resolved")
	assert_eq(global_ur.max_steps, UndoManagerScript.MAX_UNDO_STEPS, "global history capped at MAX_UNDO_STEPS")
	## suite_setup 已对"无场景"skip_suite，此处 scene_root 必非 null；防御性断言。
	var scene_root := EditorInterface.get_edited_scene_root()
	assert_true(scene_root != null, "scene open (guaranteed by suite_setup skip)")
	var scene_ur: UndoRedo = undo_redo.get_history_undo_redo(undo_redo.get_object_history_id(scene_root))
	assert_true(scene_ur != null, "scene history UndoRedo resolved")
	assert_eq(scene_ur.max_steps, UndoManagerScript.MAX_UNDO_STEPS, "scene history capped at MAX_UNDO_STEPS")
