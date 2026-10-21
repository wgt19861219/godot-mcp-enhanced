## MCP Undo/Redo Manager — EditorUndoRedoManager 包装
##
## AI 触发的 mutation 经此 wrapper 接入 Godot 编辑器的 undo 栈，
## 用户 Ctrl+Z 可逐步撤销 AI 操作（UX 信任保障）。
##
## 历史上限（2026-10-21，编辑器 40GB 内存事故根治项）：UndoRedo.max_steps 默认
## 0 = 无上限（官方文档），长 AI 会话数千次 mutation commit 进编辑器 undo 栈致
## 内存单调增长。create_action_mixed 每次调用先把 global + 当前场景两条 history
## 的 UndoRedo 上限压到 MAX_UNDO_STEPS（见 _cap_undo_history）。上限作用于共享栈
## （含用户手动编辑）；更深的回滚走 git。
##
## 接入 undo 的 handler（8 个，生产调用共 37 处——剔注释口径，2026-10-21 逐行复核）：
## - node_commands.gd（add_node/remove_node/edit_node/batch_add 4 处）
## - ui_commands.gd（create_control/set_layout/theme/container 等 8 处）
## - animation_commands.gd（7 处）
## - asset/asset_placer.gd（place_one/place_batch 2 处，经 asset_commands.gd 间接调用）
## - particle_commands.gd（5 处）
## - nav_commands.gd（5 处）
## - animtree_commands.gd（4 处）
## - scene_commands.gd（instance_scene/set_instance_property 2 处）
##
## 不接入 undo 的 handler（含理由）：
## - export_commands.gd：落盘文件不可逆，无 undo 语义
## - recording_commands.gd：editor 路由已移除(GD-R10,原 editor 路径被禁用强制走 Bridge),与 editor-only UndoRedoManager 矛盾
## - sync_commands.gd：纯观察者（connect/disconnect 信号 + 只读序列化），无场景树 mutation
## - test_commands.gd：测试命令不产生场景 mutation（仅注入 undo_manager 到测试上下文）
## - scene_commands.gd open/save：场景级 open/save 不应被 Ctrl+Z 跨场景切换
##
extends Node

## 编辑器共享 undo 栈的历史步数上限。取 200：截断长 AI 会话的无限增长，
## 用户手动 undo 深度基本无感；更深回滚走 git。
const MAX_UNDO_STEPS := 200

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin


## 创建混合 action（methods + properties + references）
## do_ops/undo_ops 中每个元素是 Dictionary，格式:
## {"type": "method", "target": Object, "method": String, "args": Array}
## {"type": "property", "target": Object, "property": String, "value": Variant}
## {"type": "reference", "value": Node}  # Issue 1: add_do_reference 仅限 Node
func create_action_mixed(action_name: String, do_ops: Array, undo_ops: Array) -> void:
	var undo_redo = _plugin.get_undo_redo()
	_cap_undo_history(undo_redo)
	var label: String = "MCP: %s" % action_name
	undo_redo.create_action(label)
	for op in do_ops:
		_apply_op(undo_redo, "do", op)
	for op in undo_ops:
		_apply_op(undo_redo, "undo", op)
	undo_redo.commit_action()


## 把编辑器 undo 历史上限压到 MAX_UNDO_STEPS（幂等，每次 create_action_mixed 调用）。
## 关键 API 约束（2026-10-21 审查核实，勿回退成 undo_redo.max_steps = N）：
## EditorUndoRedoManager 继承 Object、零属性、无 max_steps——上限只能设在它管理的
## 各 history 的 UndoRedo 上（get_history_undo_redo）。create_action 无 custom_context
## 时按首个操作推断目标 history：Node → 当前编辑场景，非 Node → GLOBAL_HISTORY，
## 因此两条都要盖。场景未打开时 get_edited_scene_root() 为 null，只盖 global。
func _cap_undo_history(undo_redo: EditorUndoRedoManager) -> void:
	var global_ur: UndoRedo = undo_redo.get_history_undo_redo(EditorUndoRedoManager.GLOBAL_HISTORY)
	if global_ur != null and global_ur.max_steps != MAX_UNDO_STEPS:
		global_ur.max_steps = MAX_UNDO_STEPS
	var ei: EditorInterface = _plugin.get_editor_interface()
	if ei == null:
		return
	var scene_root := ei.get_edited_scene_root()
	if scene_root == null:
		return
	var scene_ur: UndoRedo = undo_redo.get_history_undo_redo(undo_redo.get_object_history_id(scene_root))
	if scene_ur != null and scene_ur.max_steps != MAX_UNDO_STEPS:
		scene_ur.max_steps = MAX_UNDO_STEPS


func _add_method(undo_redo: EditorUndoRedoManager, mode: String, target: Object, method: String, args: Array) -> void:
	if not is_instance_valid(target):
		push_warning("undo_manager: invalid (freed/null) target for method '%s'" % method)
		return
	# I-3 (2026-08-14 审查,可疑项防御性修复——未复现): args 中已 freed 的 Object 参数
	# 跳过注册整个 op。原 is_instance_valid 只查 target 不查 args 里的 Object;batch 孤儿
	# free 与 add_do_reference 冲突时,回放期引擎调用带 freed 实参的方法 → SCRIPT ERROR
	# 中断整个 action 回放(跳过单 op 不中断回放,降级为 Ctrl+Z 少撤一步)。
	# ⚠️ 检测必须用 typeof(arg) == TYPE_OBJECT 而非 `arg is Object`——Godot 4.6.3 实测
	# (headless probe,2026-08-15):对 freed 实例求值 `is` 本身即 SCRIPT ERROR
	# "Left operand of 'is' is a previously freed instance";typeof 不求值实例,安全。
	# 局限(如实声明): 此为**注册期**检查——args 在注册后、回放前被 free 仍会报错(引擎
	# 内部回放路径,wrapper 层无法拦截);add_do/undo_reference 持 Node 引用仍是主防线。
	for arg in args:
		if typeof(arg) == TYPE_OBJECT and not is_instance_valid(arg):
			push_warning("undo_manager: freed Object arg for method '%s' (mode=%s) — skipping op registration (defensive, I-3)" % [method, mode])
			return
	# EditorUndoRedoManager.add_do_method/add_undo_method 签名是 (Object, StringName, ...args)
	# vararg，不接受 Callable（UndoRedo 风格 add_do_method(cb) 会静默不注册 do_method
	# -> commit_action 执行空 do_ops -> add_child 从未调用 -> 节点不落地 bug）。
	# 用 callv 把 args 数组 spread 成 vararg 参数，确保 do_method 正确注册。
	var mname := "add_do_method" if mode == "do" else "add_undo_method"
	undo_redo.callv(mname, [target, method] + args)


func _add_method_call(undo_redo: EditorUndoRedoManager, mode: String, m: Dictionary) -> void:
	var args: Array = m.get("args", [])
	var target: Object = m.target
	var method: String = m.method
	_add_method(undo_redo, mode, target, method, args)


func _apply_op(undo_redo: EditorUndoRedoManager, mode: String, op: Dictionary) -> void:
	var op_type: String = op.get("type", "method")
	match op_type:
		"method":
			_add_method_call(undo_redo, mode, op)
		"property":
			var target: Object = op.target
			if not is_instance_valid(target):
				push_warning("undo_manager: invalid (freed/null) target for property '%s'" % str(op.get("property", "")))
				return
			var prop: String = str(op.get("property", ""))
			if prop.is_empty():
				push_warning("undo_manager: empty property name, skipping")
				return
			var val = op.value
			if mode == "do":
				undo_redo.add_do_property(target, prop, val)
			else:
				undo_redo.add_undo_property(target, prop, val)
		"reference":
			# Issue 1: add_do_reference/add_undo_reference 仅限 Node,不接受 Resource。
			# GD-R5 (2026-08-08): 显式化此约束——reference op 仅对 Node 有效
			# (Godot UndoRedo.add_do_reference 持有 Node 树引用,Resource 的 refcount 语义不同)。
			# Resource 的 undo 靠 add_do_method 调 ref/unref,非 reference op;调用方需自行处理。
			var val = op.value
			if val is Node and is_instance_valid(val):
				if mode == "do":
					undo_redo.add_do_reference(val)
				else:
					undo_redo.add_undo_reference(val)
			elif val is Resource:
				push_warning("undo_manager: reference op does not support Resource (got %s). Use add_do_method with ref/unref for Resource undo." % val.get_class())
			else:
				push_warning("undo_manager: reference skipped — value is %s, not valid Node" % ("" if val == null else val.get_class()))
		_:
			push_warning("undo_manager: unknown op type '%s', skipping" % op_type)
