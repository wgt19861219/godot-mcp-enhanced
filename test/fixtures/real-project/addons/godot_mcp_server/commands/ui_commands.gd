extends Node

var _plugin: EditorPlugin
var _undo_manager: Node

# IMPORTANT-14 (review): 严格白名单替代 is_parent_class(node_type,"Control") 兜底。
# 原写法放行任意 Control 子类(含第三方 class_name 脚本),实例化时触发其 _init/_ready 执行任意 GDScript。
# 与 node_commands.gd ALLOWED_NODE_TYPES(I-4)对齐;须与 TS 端 ui_create_control 的 31 种 Control 同步。
# 反馈批次 B B1(2026-09-09/09-10): 补 TextureButton/ColorRect(UI 刚需:图片按钮/遮罩色块)。
const ALLOWED_CONTROL_TYPES: Array = [
	"Button", "Label", "Panel", "LineEdit", "TextEdit", "RichTextLabel",
	"LinkButton", "HSlider", "VSlider", "CheckBox", "CheckButton",
	"OptionButton", "SpinBox", "ProgressBar", "TextureRect", "ColorPickerButton",
	"TabContainer", "Tree", "ItemList", "MarginContainer", "HBoxContainer",
	"VBoxContainer", "GridContainer", "CenterContainer", "ScrollContainer",
	"PanelContainer", "HSplitContainer", "VSplitContainer", "NinePatchRect",
	"TextureButton", "ColorRect",
]

func setup(plugin: EditorPlugin, undo_manager: Node = null) -> void:
	_plugin = plugin
	_undo_manager = undo_manager


func cleanup() -> void:
	# 阶段5(:649): 统一 cleanup 接口(与 incomplete-cleanup-command-nodes fix 一致)。本模块无信号/定时器,释放引用助 GC。
	_plugin = null


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"ui_create_control": {
			"description": "创建 Control 子类节点(须在白名单 31 种内)。创建后可设属性。",
			"params": [
				CommandHelpers.doc_param("node_type", "String", false, "Control 子类类型,须在白名单 31 种内(默认 Label)"),
				CommandHelpers.doc_param("node_name", "String", false, "新节点名(默认 Control)"),
				CommandHelpers.doc_param("parent_node_path", "String", false, "父节点路径,空则挂场景根"),
				CommandHelpers.doc_param("properties", "Dictionary", false, "创建后要设置的属性键值(经 coerce_property_value)"),
			],
		},
		"ui_set_layout": {
			"description": "设置 Control 节点的布局(anchors/offsets/size/grow_direction)。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 Control 节点路径"),
				CommandHelpers.doc_param("anchors", "Dictionary", false, "键 left/right/top/bottom(float)设 anchor"),
				CommandHelpers.doc_param("offsets", "Dictionary", false, "键 left/right/top/bottom(float)设 offset"),
				CommandHelpers.doc_param("custom_minimum_size", "Dictionary", false, "键 x/y(float)设 custom_minimum_size"),
				CommandHelpers.doc_param("min_size", "Dictionary", false, "custom_minimum_size 的别名(仅在 custom_minimum_size 未传时生效)"),
				CommandHelpers.doc_param("grow_direction", "String", false, "取值 both/up/down/left/right;空表示跳过"),
			],
		},
		"ui_get_layout": {
			"description": "读取 Control 节点的布局信息(anchors/offsets/size)。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 Control 节点路径"),
			],
		},
		"ui_anchor_preset": {
			"description": "应用预设锚点(16 种 preset,如 top_left/full_rect/center)。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 Control 节点路径"),
				CommandHelpers.doc_param("preset", "String", true, "锚点预设名(top_left/full_rect/center 等 16 种)"),
			],
		},
		"ui_set_theme": {
			"description": "Theme 操作:create 创建空 Theme/set_params 设属性/save 存盘/load 加载。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 Control 节点路径"),
				CommandHelpers.doc_param("action", "String", true, "取值 create/set_params/save/load"),
				CommandHelpers.doc_param("params", "Dictionary", false, "action=set_params 时 Theme 属性键值表"),
				CommandHelpers.doc_param("theme_path", "String", false, "action=save/load 时必需(须 res:// 或 user://)"),
			],
		},
		"ui_container_add": {
			"description": "向容器节点添加子 Control。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "容器节点路径"),
				CommandHelpers.doc_param("child_type", "String", false, "子 Control 类型,须在白名单(默认 Label)"),
				CommandHelpers.doc_param("child_name", "String", false, "子节点名(默认 Child)"),
				CommandHelpers.doc_param("child_properties", "Dictionary", false, "子节点属性键值"),
			],
		},
		"theme_create": {
			"description": "创建 Theme:create 新建空 Theme/extract 从节点提取已有 Theme。",
			"params": [
				CommandHelpers.doc_param("action", "String", false, "取值 create/extract(默认 create)"),
				CommandHelpers.doc_param("source_node_path", "String", false, "action=extract 时必需(须 Control 且有 theme)"),
				CommandHelpers.doc_param("save_path", "String", false, "若非空则保存到该 .tres 路径(须 res:// 或 user://)"),
			],
		},
		"theme_set_property": {
			"description": "设置节点的 Theme 属性(default_font/color/constant/stylebox)。",
			"params": [
				CommandHelpers.doc_param("theme_node_path", "String", true, "持有 theme 的节点路径"),
				CommandHelpers.doc_param("item_type", "String", true, "取值 default_font/color/constant/stylebox"),
				CommandHelpers.doc_param("name", "String", false, "theme 属性名(color/constant/stylebox 用)"),
				CommandHelpers.doc_param("theme_type", "String", false, "theme type 分类串(color/constant/stylebox 用)"),
				CommandHelpers.doc_param("value", "JSON", true, "属性值;color 需 [r,g,b(,a)],constant 需 int,default_font/stylebox 需资源路径串"),
			],
		},
	}
	_undo_manager = null

# ─── ui_create_control ──────────────────────────────────────────────────────

func handle_ui_create_control(params: Dictionary, request_id: int) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_type: String = params.get("node_type", "Label")
	var node_name: String = params.get("node_name", "Control")
	var parent_path: String = params.get("parent_node_path", "")
	var parent_node: Node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	if not (node_type in ALLOWED_CONTROL_TYPES):
		return {"error": {"code": -32004, "message": "Invalid or blocked Control type: " + node_type}}

	var node = ClassDB.instantiate(node_type)
	if node == null:
		return {"error": {"code": -32000, "message": "Cannot instantiate: " + node_type}}
	node.name = node_name

	var properties = params.get("properties")
	if properties != null and properties is Dictionary:
		for key in properties:
			if key.begins_with("_"):
				continue
			if not key is String:
				continue
			if ":" in key or "/" in key:
				continue
			var val = properties[key]
			if val is Object:
				continue
			var r := CommandHelpers.coerce_property_value(node, key, val)
			if r["ok"]:
				node.set(key, r["value"])

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Create UI Control (req:%d)" % request_id,
			[
				{"type": "method", "target": parent_node, "method": "add_child", "args": [node]},
				{"type": "method", "target": node, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": node}
			],
			[
				{"type": "method", "target": parent_node, "method": "remove_child", "args": [node]}
			]
		)
	else:
		parent_node.add_child(node)
		node.owner = root

	return {"result": {"type": node_type, "name": node_name, "path": str(node.get_path()), "status": "created"}}

# ─── ui_set_layout ──────────────────────────────────────────────────────────

func handle_ui_set_layout(params: Dictionary, request_id: int = 0) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var ctrl: Control = node
	# F2(2026-07-29 报告5): anchors/offsets/min_size/grow_direction 改 _record_prop 聚合 property op
	# 进 create_action_mixed，Ctrl+Z 可撤销（原直接赋值无 undo）。
	var do_ops: Array = []
	var undo_ops: Array = []

	var anchors = params.get("anchors")
	if anchors != null and anchors is Dictionary:
		if anchors.has("left"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "anchor_left", float(anchors["left"]))
		if anchors.has("right"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "anchor_right", float(anchors["right"]))
		if anchors.has("top"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "anchor_top", float(anchors["top"]))
		if anchors.has("bottom"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "anchor_bottom", float(anchors["bottom"]))

	var offsets = params.get("offsets")
	if offsets != null and offsets is Dictionary:
		if offsets.has("left"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "offset_left", float(offsets["left"]))
		if offsets.has("right"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "offset_right", float(offsets["right"]))
		if offsets.has("top"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "offset_top", float(offsets["top"]))
		if offsets.has("bottom"):
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "offset_bottom", float(offsets["bottom"]))

	var custom_minimum_size = params.get("custom_minimum_size")
	if custom_minimum_size != null and custom_minimum_size is Dictionary:
		var cx = float(custom_minimum_size.get("x", ctrl.custom_minimum_size.x))
		var cy = float(custom_minimum_size.get("y", ctrl.custom_minimum_size.y))
		CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "custom_minimum_size", Vector2(cx, cy))
	else:
		var min_size = params.get("min_size")
		if min_size != null and min_size is Dictionary:
			var nx = float(min_size.get("x", ctrl.custom_minimum_size.x))
			var ny = float(min_size.get("y", ctrl.custom_minimum_size.y))
			CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "custom_minimum_size", Vector2(nx, ny))

	var grow_direction: String = params.get("grow_direction", "")
	if grow_direction != "":
		match grow_direction:
			"both":
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_horizontal", Control.GROW_DIRECTION_BOTH)
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_vertical", Control.GROW_DIRECTION_BOTH)
			"up":
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_vertical", Control.GROW_DIRECTION_BEGIN)
			"down":
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_vertical", Control.GROW_DIRECTION_END)
			"left":
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_horizontal", Control.GROW_DIRECTION_BEGIN)
			"right":
				CommandHelpers._record_prop(do_ops, undo_ops, ctrl, "grow_horizontal", Control.GROW_DIRECTION_END)
			_:
				return {"error": {"code": -32004, "message": "Invalid grow_direction: " + grow_direction}}

	if do_ops.is_empty():
		return {"error": {"code": -32004, "message": "no layout params to set"}}

	if _undo_manager != null:
		_undo_manager.create_action_mixed("UI Set Layout", do_ops, undo_ops)
	else:
		for op in do_ops:
			op["target"].set(op["property"], op["value"])
	return {"result": {"node": node_path, "status": "layout_set"}}

# ─── ui_get_layout ──────────────────────────────────────────────────────────

func handle_ui_get_layout(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var ctrl: Control = node
	var info = {
		"anchor_left": ctrl.anchor_left,
		"anchor_right": ctrl.anchor_right,
		"anchor_top": ctrl.anchor_top,
		"anchor_bottom": ctrl.anchor_bottom,
		"offset_left": ctrl.offset_left,
		"offset_right": ctrl.offset_right,
		"offset_top": ctrl.offset_top,
		"offset_bottom": ctrl.offset_bottom,
		"global_position": {"x": ctrl.global_position.x, "y": ctrl.global_position.y},
		"size": {"x": ctrl.size.x, "y": ctrl.size.y},
	}

	return {"result": {"node": node_path, "layout": info}}

# ─── ui_anchor_preset ───────────────────────────────────────────────────────

func handle_ui_anchor_preset(params: Dictionary, request_id: int = 0) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var preset: String = params.get("preset", "")
	var preset_map = {
		"top_left": Control.PRESET_TOP_LEFT,
		"top_right": Control.PRESET_TOP_RIGHT,
		"bottom_left": Control.PRESET_BOTTOM_LEFT,
		"bottom_right": Control.PRESET_BOTTOM_RIGHT,
		"center_left": Control.PRESET_CENTER_LEFT,
		"center_top": Control.PRESET_CENTER_TOP,
		"center_right": Control.PRESET_CENTER_RIGHT,
		"center_bottom": Control.PRESET_CENTER_BOTTOM,
		"center": Control.PRESET_CENTER,
		"left_wide": Control.PRESET_LEFT_WIDE,
		"top_wide": Control.PRESET_TOP_WIDE,
		"right_wide": Control.PRESET_RIGHT_WIDE,
		"bottom_wide": Control.PRESET_BOTTOM_WIDE,
		"vcenter_wide": Control.PRESET_VCENTER_WIDE,
		"hcenter_wide": Control.PRESET_HCENTER_WIDE,
		"full_rect": Control.PRESET_FULL_RECT,
	}
	if not preset_map.has(preset):
		return {"error": {"code": -32004, "message": "Unknown preset: " + preset + ". Available: " + str(preset_map.keys())}}

	var ctrl: Control = node
	# F2(2026-07-29 报告5): set_anchors_preset 改 method op 进 create_action_mixed，
	# undo 记旧 4 anchors property op；Ctrl+Z 回滚（原直接调用无 undo）。
	# anchor preset 改 anchor_left/right/top/bottom 四属性；记旧值供 undo
	var do_ops: Array = [
		{"type": "method", "target": ctrl, "method": "set_anchors_preset", "args": [preset_map[preset]]},
	]
	var undo_ops: Array = [
		{"type": "property", "target": ctrl, "property": "anchor_left", "value": ctrl.anchor_left},
		{"type": "property", "target": ctrl, "property": "anchor_right", "value": ctrl.anchor_right},
		{"type": "property", "target": ctrl, "property": "anchor_top", "value": ctrl.anchor_top},
		{"type": "property", "target": ctrl, "property": "anchor_bottom", "value": ctrl.anchor_bottom},
	]
	if _undo_manager != null:
		_undo_manager.create_action_mixed("UI Anchor Preset", do_ops, undo_ops)
	else:
		ctrl.set_anchors_preset(preset_map[preset])
	return {"result": {"node": node_path, "preset": preset, "status": "preset_applied"}}

# ─── ui_set_theme ───────────────────────────────────────────────────────────

func handle_ui_set_theme(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var ctrl: Control = node
	var action: String = params.get("action", "")

	match action:
		"create":
			# F2(2026-07-29 报告5): ctrl.theme 改走 create_action_mixed（property op），Ctrl+Z 回滚旧 theme。
			var new_theme = Theme.new()
			if _undo_manager != null:
				_undo_manager.create_action_mixed("UI Theme Create",
					[{"type": "property", "target": ctrl, "property": "theme", "value": new_theme}],
					[{"type": "property", "target": ctrl, "property": "theme", "value": ctrl.theme}])
			else:
				ctrl.theme = new_theme
		"set_params":
			var theme = ctrl.theme
			if theme == null:
				return {"error": {"code": -32004, "message": "Node has no theme assigned"}}
			var p = params.get("params")
			if p != null and p is Dictionary:
				# F2(2026-07-29 报告5): theme.set(key,val) 累积 method op，循环后一次 create_action_mixed，
				# undo 记 theme.get(key) 旧值；Ctrl+Z 回滚每个 set。未设时 get 返默认值（ADVISORY 级可接受）。
				var t_do: Array = []
				var t_undo: Array = []
				for key in p:
					if not key is String:
						continue
					if ":" in key or "/" in key:
						continue
					var val = p[key]
					if val is Object:
						continue
					# C13: 校验 key 是 Theme 有效属性（避免 silent no-op / 动态属性污染）
					if not _theme_has_property(theme, String(key)):
						continue
					# P2-1: val 按 Theme 属性当前类型 coerce（Array→Color/Vector3 等），对齐
					# handle_theme_set_property :491-497 显式 Array→Color 模式，避免 Color 属性传 Array silent no-op
					val = CommandHelpers.coerce_value_for_property(theme, String(key), val)
					# H-1 fix round 1: 毒/缺分量 → null(守卫拒绝,仅 Array 输入可能)——点名跳过
					# 该 key,不进 undo 链(theme.set(key,null) 会清值/报错);对齐三副本可诊断语义
					if val == null and p[key] is Array:
						printerr("[ERROR] UI theme param %s: cannot coerce Array (blocked/missing component), skipped" % String(key))
						continue
					t_undo.append({"type": "method", "target": theme, "method": "set", "args": [String(key), theme.get(key)]})
					t_do.append({"type": "method", "target": theme, "method": "set", "args": [String(key), val]})
				if not t_do.is_empty() and _undo_manager != null:
					_undo_manager.create_action_mixed("UI Theme Set Params", t_do, t_undo)
				else:
					for op in t_do:
						op["target"].callv("set", op["args"])
		"save":
			var theme = ctrl.theme
			if theme == null:
				return {"error": {"code": -32004, "message": "Node has no theme to save"}}
			var save_path: String = params.get("theme_path", "")
			if save_path == "":
				return {"error": {"code": -32004, "message": "theme_path is required for save action"}}
			if not _validate_resource_path(save_path):
				return {"error": {"code": -32004, "message": "theme_path must start with res:// or user://: " + save_path}}
			var err = CommandHelpers._save_atomic(theme, save_path)
			if err != OK:
				return {"error": {"code": -32000, "message": "Failed to save theme: " + str(err)}}
		"load":
			var load_path: String = params.get("theme_path", "")
			if load_path == "":
				return {"error": {"code": -32004, "message": "theme_path is required for load action"}}
			if not _validate_resource_path(load_path):
				return {"error": {"code": -32004, "message": "theme_path must start with res:// or user://: " + load_path}}
			var res = load(load_path)
			if res == null:
				return {"error": {"code": -32000, "message": "Failed to load theme from: " + load_path}}
			# F2(2026-07-29 报告5): ctrl.theme=res 改走 create_action_mixed（property op），Ctrl+Z 回滚旧 theme。
			if _undo_manager != null:
				_undo_manager.create_action_mixed("UI Theme Load",
					[{"type": "property", "target": ctrl, "property": "theme", "value": res}],
					[{"type": "property", "target": ctrl, "property": "theme", "value": ctrl.theme}])
			else:
				ctrl.theme = res
		_:
			return {"error": {"code": -32004, "message": "Invalid action: " + action + ". Must be: set_params, create, save, load"}}

	return {"result": {"node": node_path, "action": action, "status": "theme_set"}}

# ─── ui_container_add ───────────────────────────────────────────────────────

func handle_ui_container_add(params: Dictionary, request_id: int) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var container = CommandHelpers.find_node(root, node_path)
	if container == null:
		return {"error": {"code": -32002, "message": "Container node not found: " + node_path}}

	var child_type: String = params.get("child_type", "Label")
	if not (child_type in ALLOWED_CONTROL_TYPES):
		return {"error": {"code": -32004, "message": "Invalid or blocked Control type: " + child_type}}

	var child_name: String = params.get("child_name", "Child")
	var child = ClassDB.instantiate(child_type)
	if child == null:
		return {"error": {"code": -32000, "message": "Cannot instantiate: " + child_type}}
	child.name = child_name

	var child_properties = params.get("child_properties")
	if child_properties != null and child_properties is Dictionary:
		for key in child_properties:
			if key.begins_with("_"):
				continue
			if not key is String:
				continue
			if ":" in key or "/" in key:
				continue
			var cval = child_properties[key]
			if cval is Object:
				continue
			var r := CommandHelpers.coerce_property_value(child, key, cval)
			if r["ok"]:
				child.set(key, r["value"])

	if _undo_manager != null:
		_undo_manager.create_action_mixed("UI Container Add (req:%d)" % request_id,
			[
				{"type": "method", "target": container, "method": "add_child", "args": [child]},
				{"type": "method", "target": child, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": child}
			],
			[
				{"type": "method", "target": container, "method": "remove_child", "args": [child]}
			]
		)
	else:
		container.add_child(child)
		child.owner = root

	return {"result": {"container": node_path, "child_type": child_type, "child_name": child_name, "child_path": str(child.get_path()), "status": "child_added"}}

# ─── theme_create ───────────────────────────────────────────────────────────

# F2(2026-07-29): theme_create 只 Theme.new()+可选 save 文件，不赋给节点 ctrl.theme（不改场景树持久属性），
# 故不需 undo（Ctrl+Z 无意义）。报告5 F2 列其为误判，本批排除。
func handle_theme_create(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var action: String = params.get("action", "create")
	var theme: Theme

	match action:
		"create":
			theme = Theme.new()
		"extract":
			var source_path: String = params.get("source_node_path", "")
			var source = CommandHelpers.find_node(root, source_path)
			if source == null:
				return {"error": {"code": -32002, "message": "Source node not found: " + source_path}}
			if not (source is Control):
				return {"error": {"code": -32004, "message": "Source node is not a Control: " + source.get_class()}}
			var src_theme = source.theme
			if src_theme == null:
				return {"error": {"code": -32004, "message": "Source node has no theme"}}
			theme = src_theme
		_:
			return {"error": {"code": -32004, "message": "Invalid action: " + action + ". Must be: create, extract"}}

	var save_path: String = params.get("save_path", "")
	if save_path != "":
		if not _validate_resource_path(save_path):
			return {"error": {"code": -32004, "message": "save_path must start with res:// or user://: " + save_path}}
		var err = CommandHelpers._save_atomic(theme, save_path)
		if err != OK:
			return {"error": {"code": -32000, "message": "Failed to save theme: " + str(err)}}

	return {"result": {"action": action, "status": "theme_created"}}

# IMP-2: 资源路径必须为 res:// 或 user:// 前缀,堵已认证用户的本地任意文件写入/读取
# IMP-2-CONSISTENCY: 加段级 .. 阻断,与 scene_commands._has_path_traversal 防御深度对齐
func _validate_resource_path(p: String) -> bool:
	if not (p.begins_with("res://") or p.begins_with("user://")):
		return false
	if CommandHelpers.has_path_traversal(p):
		return false
	return true


# C13: 校验 key 是 Theme 有效属性（set_params 用，避免 theme.set 无效 key silent no-op / 动态属性污染）。
# Theme.get_property_list 含继承自 Resource/Object 的属性 + Theme 特有属性；set 不在列表的 key 会创建
# 动态属性（无主题效果）= silent no-op。找不到返 false（调用方 continue 跳过）。
func _theme_has_property(theme: Theme, key: String) -> bool:
	for p in theme.get_property_list():
		if String(p.get("name", "")) == key:
			return true
	return false


# ─── theme_set_property ─────────────────────────────────────────────────────

func handle_theme_set_property(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var theme_node_path: String = params.get("theme_node_path", "")
	var node = CommandHelpers.find_node(root, theme_node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + theme_node_path}}

	var theme = node.theme
	if theme == null:
		return {"error": {"code": -32004, "message": "Node has no theme assigned"}}
	if not (theme is Theme):
		return {"error": {"code": -32004, "message": "Node.theme is not a Theme"}}

	var item_type: String = params.get("item_type", "")
	var prop_name: String = params.get("name", "")
	var theme_type: String = params.get("theme_type", "")
	var value = params.get("value")
	# F2(2026-07-29 报告5): 各 theme.set_xxx 累积 method op（do+旧值 undo），match 后一次 create_action_mixed。
	# 旧值取法：theme.get_color/get_constant/get_default_font/get_stylebox；未设时返默认值（ADVISORY 级可接受）。
	var t_do: Array = []
	var t_undo: Array = []

	match item_type:
		"default_font":
			var font_path: String = str(value)
			if not _validate_resource_path(font_path):
				return {"error": {"code": -32004, "message": "font path must start with res:// or user://: " + font_path}}
			# C13: load null 守卫（load 失败返 null 直接传 set_default_font 致 silent no-op / 错误）
			var font = load(font_path)
			if font == null:
				return {"error": {"code": -32004, "message": "Failed to load font: " + font_path}}
			t_do.append({"type": "method", "target": theme, "method": "set_default_font", "args": [font]})
			t_undo.append({"type": "method", "target": theme, "method": "set_default_font", "args": [theme.get_default_font()]})
		"color":
			var c = value
			if c is Array and c.size() >= 3:
				var a = float(c[3]) if c.size() >= 4 else 1.0
				var new_col = Color(float(c[0]), float(c[1]), float(c[2]), a)
				t_do.append({"type": "method", "target": theme, "method": "set_color", "args": [prop_name, theme_type, new_col]})
				t_undo.append({"type": "method", "target": theme, "method": "set_color", "args": [prop_name, theme_type, theme.get_color(prop_name, theme_type)]})
			else:
				return {"error": {"code": -32004, "message": "Color value must be array [r, g, b] or [r, g, b, a]"}}
		"constant":
			t_do.append({"type": "method", "target": theme, "method": "set_constant", "args": [prop_name, theme_type, int(value)]})
			t_undo.append({"type": "method", "target": theme, "method": "set_constant", "args": [prop_name, theme_type, theme.get_constant(prop_name, theme_type)]})
		"stylebox":
			var sb_path: String = str(value)
			if not _validate_resource_path(sb_path):
				return {"error": {"code": -32004, "message": "stylebox path must start with res:// or user://: " + sb_path}}
			# C13: load null 守卫
			var sb = load(sb_path)
			if sb == null:
				return {"error": {"code": -32004, "message": "Failed to load stylebox: " + sb_path}}
			# F2(2026-07-29): 对称追加 set_stylebox method op + theme.get_stylebox 旧值（保持资源路径校验）。
			t_do.append({"type": "method", "target": theme, "method": "set_stylebox", "args": [prop_name, theme_type, sb]})
			t_undo.append({"type": "method", "target": theme, "method": "set_stylebox", "args": [prop_name, theme_type, theme.get_stylebox(prop_name, theme_type)]})
		_:
			return {"error": {"code": -32004, "message": "Invalid item_type: " + item_type + ". Must be: default_font, color, constant, stylebox"}}

	if not t_do.is_empty():
		if _undo_manager != null:
			_undo_manager.create_action_mixed("UI Theme Set Property", t_do, t_undo)
		else:
			for op in t_do:
				op["target"].callv(op["method"], op["args"])
	return {"result": {"node": theme_node_path, "item_type": item_type, "name": prop_name, "status": "property_set"}}
