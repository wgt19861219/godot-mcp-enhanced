extends Node

var _plugin: EditorPlugin

const BLOCKED_PROPS: Array = ["script", "owner", "name", "parent", "children", "tree", "meta", "process_mode", "process_priority",
	"process_input", "process_unhandled_input", "process_unhandled_key_input",
	"process_internal", "physics_process_mode", "input_event", "ready",
	"material", "texture", "mesh", "collision_layer", "collision_mask",
	"collision_priority", "transform", "global_transform"]

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

# ─── ui_create_control ──────────────────────────────────────────────────────

func handle_ui_create_control(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_type: String = params.get("node_type", "Label")
	var node_name: String = params.get("node_name", "Control")
	var parent_path: String = params.get("parent_node_path", "")
	var parent_node: Node = _find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	if not ClassDB.class_exists(node_type) or not ClassDB.is_parent_class(node_type, "Control"):
		return {"error": {"code": -32004, "message": "Invalid Control type: " + node_type}}

	var node = ClassDB.instantiate(node_type)
	if node == null:
		return {"error": {"code": -32000, "message": "Cannot instantiate: " + node_type}}
	node.name = node_name

	var properties = params.get("properties")
	if properties != null and properties is Dictionary:
		for key in properties:
			if key.begins_with("_") or key in BLOCKED_PROPS:
				continue
			if not key is String:
				continue
			if ":" in key or "/" in key:
				continue
			var val = properties[key]
			if val is Object:
				continue
			if _property_exists_and_type_ok(node, key, val):
				node.set(key, val)

	parent_node.add_child(node)
	node.owner = root

	return {"result": {"type": node_type, "name": node_name, "path": str(node.get_path()), "status": "created"}}

# ─── ui_set_layout ──────────────────────────────────────────────────────────

func handle_ui_set_layout(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var ctrl: Control = node

	var anchors = params.get("anchors")
	if anchors != null and anchors is Dictionary:
		if anchors.has("left"):
			ctrl.anchor_left = float(anchors["left"])
		if anchors.has("right"):
			ctrl.anchor_right = float(anchors["right"])
		if anchors.has("top"):
			ctrl.anchor_top = float(anchors["top"])
		if anchors.has("bottom"):
			ctrl.anchor_bottom = float(anchors["bottom"])

	var offsets = params.get("offsets")
	if offsets != null and offsets is Dictionary:
		if offsets.has("left"):
			ctrl.offset_left = float(offsets["left"])
		if offsets.has("right"):
			ctrl.offset_right = float(offsets["right"])
		if offsets.has("top"):
			ctrl.offset_top = float(offsets["top"])
		if offsets.has("bottom"):
			ctrl.offset_bottom = float(offsets["bottom"])

	var min_size = params.get("min_size")
	if min_size != null and min_size is Dictionary:
		if min_size.has("x"):
			ctrl.custom_minimum_size = Vector2(float(min_size["x"]), ctrl.custom_minimum_size.y)
		if min_size.has("y"):
			ctrl.custom_minimum_size = Vector2(ctrl.custom_minimum_size.x, float(min_size["y"]))

	var custom_minimum_size = params.get("custom_minimum_size")
	if custom_minimum_size != null and custom_minimum_size is Dictionary:
		var cx = float(custom_minimum_size.get("x", ctrl.custom_minimum_size.x))
		var cy = float(custom_minimum_size.get("y", ctrl.custom_minimum_size.y))
		ctrl.custom_minimum_size = Vector2(cx, cy)

	var grow_direction: String = params.get("grow_direction", "")
	if grow_direction != "":
		match grow_direction:
			"both":
				ctrl.grow_horizontal = Control.GROW_DIRECTION_BOTH
				ctrl.grow_vertical = Control.GROW_DIRECTION_BOTH
			"up":
				ctrl.grow_vertical = Control.GROW_DIRECTION_BEGIN
			"down":
				ctrl.grow_vertical = Control.GROW_DIRECTION_END
			"left":
				ctrl.grow_horizontal = Control.GROW_DIRECTION_BEGIN
			"right":
				ctrl.grow_horizontal = Control.GROW_DIRECTION_END

	return {"result": {"node": node_path, "status": "layout_set"}}

# ─── ui_get_layout ──────────────────────────────────────────────────────────

func handle_ui_get_layout(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
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

func handle_ui_anchor_preset(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
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
	ctrl.set_anchors_preset(preset_map[preset])

	return {"result": {"node": node_path, "preset": preset, "status": "preset_applied"}}

# ─── ui_set_theme ───────────────────────────────────────────────────────────

func handle_ui_set_theme(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is Control):
		return {"error": {"code": -32004, "message": "Node is not a Control: " + node.get_class()}}

	var ctrl: Control = node
	var action: String = params.get("action", "")

	match action:
		"create":
			var theme = Theme.new()
			ctrl.theme = theme
		"set_params":
			var theme = ctrl.theme
			if theme == null:
				return {"error": {"code": -32004, "message": "Node has no theme assigned"}}
			var p = params.get("params")
			if p != null and p is Dictionary:
				for key in p:
					if not key is String:
						continue
					if ":" in key or "/" in key:
						continue
					var val = p[key]
					if val is Object:
						continue
					theme.set(key, val)
		"save":
			var theme = ctrl.theme
			if theme == null:
				return {"error": {"code": -32004, "message": "Node has no theme to save"}}
			var save_path: String = params.get("theme_path", "")
			if save_path == "":
				return {"error": {"code": -32004, "message": "theme_path is required for save action"}}
			var err = ResourceSaver.save(theme, save_path)
			if err != OK:
				return {"error": {"code": -32000, "message": "Failed to save theme: " + str(err)}}
		"load":
			var load_path: String = params.get("theme_path", "")
			if load_path == "":
				return {"error": {"code": -32004, "message": "theme_path is required for load action"}}
			var res = load(load_path)
			if res == null:
				return {"error": {"code": -32000, "message": "Failed to load theme from: " + load_path}}
			ctrl.theme = res
		_:
			return {"error": {"code": -32004, "message": "Invalid action: " + action + ". Must be: set_params, create, save, load"}}

	return {"result": {"node": node_path, "action": action, "status": "theme_set"}}

# ─── ui_container_add ───────────────────────────────────────────────────────

func handle_ui_container_add(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var container = _find_node(root, node_path)
	if container == null:
		return {"error": {"code": -32002, "message": "Container node not found: " + node_path}}

	var child_type: String = params.get("child_type", "Label")
	if not ClassDB.class_exists(child_type) or not ClassDB.is_parent_class(child_type, "Control"):
		return {"error": {"code": -32004, "message": "Invalid Control type: " + child_type}}

	var child_name: String = params.get("child_name", "Child")
	var child = ClassDB.instantiate(child_type)
	if child == null:
		return {"error": {"code": -32000, "message": "Cannot instantiate: " + child_type}}
	child.name = child_name

	var child_properties = params.get("child_properties")
	if child_properties != null and child_properties is Dictionary:
		for key in child_properties:
			if key.begins_with("_") or key in BLOCKED_PROPS:
				continue
			if not key is String:
				continue
			if ":" in key or "/" in key:
				continue
			var cval = child_properties[key]
			if cval is Object:
				continue
			if _property_exists_and_type_ok(child, key, cval):
				child.set(key, cval)

	container.add_child(child)
	child.owner = root

	return {"result": {"container": node_path, "child_type": child_type, "child_name": child_name, "child_path": str(child.get_path()), "status": "child_added"}}

# ─── theme_create ───────────────────────────────────────────────────────────

func handle_theme_create(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var action: String = params.get("action", "create")
	var theme: Theme

	match action:
		"create":
			theme = Theme.new()
		"extract":
			var source_path: String = params.get("source_node_path", "")
			var source = _find_node(root, source_path)
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
		var err = ResourceSaver.save(theme, save_path)
		if err != OK:
			return {"error": {"code": -32000, "message": "Failed to save theme: " + str(err)}}

	return {"result": {"action": action, "status": "theme_created"}}

# ─── theme_set_property ─────────────────────────────────────────────────────

func handle_theme_set_property(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var theme_node_path: String = params.get("theme_node_path", "")
	var node = _find_node(root, theme_node_path)
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

	match item_type:
		"default_font":
			var font_path: String = str(value)
			theme.set_default_font(load(font_path))
		"color":
			var c = value
			if c is Array and c.size() >= 3:
				var a = float(c[3]) if c.size() >= 4 else 1.0
				theme.set_color(prop_name, theme_type, Color(float(c[0]), float(c[1]), float(c[2]), a))
			else:
				return {"error": {"code": -32004, "message": "Color value must be array [r, g, b] or [r, g, b, a]"}}
		"constant":
			theme.set_constant(prop_name, theme_type, int(value))
		"stylebox":
			var sb_path: String = str(value)
			theme.set_stylebox(prop_name, theme_type, load(sb_path))
		_:
			return {"error": {"code": -32004, "message": "Invalid item_type: " + item_type + ". Must be: default_font, color, constant, stylebox"}}

	return {"result": {"node": theme_node_path, "item_type": item_type, "name": prop_name, "status": "property_set"}}

# ─── Helpers ─────────────────────────────────────────────────────────────────

func _get_edited_scene_root() -> Node:
	if _plugin != null:
		var ei = _plugin.get_editor_interface()
		if ei != null:
			var edited = ei.get_edited_scene_root()
			if edited != null:
				return edited
	var ml = Engine.get_main_loop()
	if ml == null or not (ml is SceneTree):
		return null
	var st = ml as SceneTree
	if st == null or st.root == null:
		return null
	if st.root.get_child_count() > 0:
		return st.root.get_child(0)
	return null

func _find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p = path
	while p.begins_with("/"):
		p = p.substr(1)
	if p.begins_with("root/"):
		p = p.substr(5)
	if p.begins_with(root.name + "/"):
		p = p.substr(root.name.length() + 1)
	elif p == root.name:
		return root
	if p == "":
		return root
	return root.get_node_or_null(p)

# SYNC: identical copy in scene_commands.gd — keep both in sync
func _property_exists_and_type_ok(obj: Object, prop_name: String, val) -> bool:
	var found = false
	for p in obj.get_property_list():
		if p["name"] == prop_name:
			found = true
			break
	if not found:
		return false
	var current = obj.get(prop_name)
	if current == null:
		return val == null
	var current_type = typeof(current)
	var val_type = typeof(val)
	if current_type == val_type:
		return true
	if (current_type == TYPE_INT or current_type == TYPE_FLOAT) and (val_type == TYPE_INT or val_type == TYPE_FLOAT):
		return true
	if (current_type == TYPE_STRING or current_type == TYPE_STRING_NAME) and (val_type == TYPE_STRING or val_type == TYPE_STRING_NAME):
		return true
	if (current_type == TYPE_BOOL and val_type == TYPE_INT) or (current_type == TYPE_INT and val_type == TYPE_BOOL):
		return true
	return false
