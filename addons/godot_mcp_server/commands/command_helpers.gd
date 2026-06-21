## command_helpers.gd — Shared utility functions for editor command modules.
## C-05: Extracted from 7 files to eliminate ~120 lines of duplication.

class_name CommandHelpers


## Get the root node of the currently edited scene.
## Tries EditorInterface first (editor mode), falls back to SceneTree root child (headless).
static func get_edited_scene_root(plugin: EditorPlugin = null) -> Node:
	if plugin != null:
		var ei: EditorInterface = plugin.get_editor_interface()
		if ei != null:
			var edited: Node = ei.get_edited_scene_root()
			if edited != null:
				return edited
	var ml: MainLoop = Engine.get_main_loop()
	if ml == null or not (ml is SceneTree):
		return null
	var st: SceneTree = ml as SceneTree
	if st == null or st.root == null:
		return null
	if st.root.get_child_count() > 0:
		return st.root.get_child(0)
	return null


## Find a node by path relative to root.
## Strips leading "root/" prefix and leading slashes.
static func find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p: String = path
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


## Check for path traversal (`..` segments) in a resource path.
## C-1 / IMP-2-CONSISTENCY: 共享段级 `..` 阻断,被 scene_commands 与 ui_commands 复用,
## 保持防御深度一致(与 godot_operations._sanitize_res_path 对齐)。单一实现消除重复。
static func has_path_traversal(p: String) -> bool:
	return "/../" in p or p.begins_with("../") or p.ends_with("/..") or p == ".."


## Check that a property exists on an object and its value type is compatible.
## Replaces duplicated copies in scene_commands.gd and ui_commands.gd.
## C-03: Removed string wildcard pass-through — strings are only allowed when
## the target property is also a string, or when str_to_var can parse them into
## the correct type (e.g., "Vector2(1, 2)" for a Vector2 property).
static func property_exists_and_type_ok(obj: Object, prop_name: String, val) -> bool:
	var found: bool = false
	for p: Dictionary in obj.get_property_list():
		if p["name"] == prop_name:
			found = true
			break
	if not found:
		return false
	var current: Variant = obj.get(prop_name)
	if current == null:
		return val == null
	var current_type: int = typeof(current)
	var val_type: int = typeof(val)
	if current_type == val_type:
		return true
	# Allow float/int interchange
	if (current_type == TYPE_FLOAT and val_type == TYPE_INT) or (current_type == TYPE_INT and val_type == TYPE_FLOAT):
		return true
	# C-03: String values only allowed for string properties, or when a safe
	# type-specific constructor can convert them to the expected type.
	if val_type == TYPE_STRING:
		if current_type == TYPE_STRING:
			return true
		# C-02 fix: replace str_to_var with safe type-specific constructors.
		# str_to_var can deserialize arbitrary objects; only allow known-safe scalar/math types.
		return _try_safe_string_convert(val, current_type)
	return false  # type mismatch — reject


## Try to convert a string value to the expected type using safe constructors only.
## Returns true if the string can be safely converted to match target_type.
## C-02: Replaces str_to_var which can deserialize arbitrary objects.
static func _try_safe_string_convert(val: String, target_type: int) -> bool:
	match target_type:
		TYPE_BOOL:
			return val == "true" or val == "false" or val == "True" or val == "False"
		TYPE_INT:
			return val.is_valid_int()
		TYPE_FLOAT:
			return val.is_valid_float() or val.is_valid_int()
		TYPE_COLOR:
			# Valid if the parse ignores the supplied default (same result for two different defaults).
			return Color.from_string(val, Color(0, 0, 0, 0)) == Color.from_string(val, Color(1, 1, 1, 1))
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return _count_number_components(val) == 2
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return _count_number_components(val) == 3
		TYPE_RECT2, TYPE_RECT2I, TYPE_PLANE, TYPE_QUATERNION:
			return _count_number_components(val) == 4
		TYPE_AABB, TYPE_TRANSFORM2D:
			return _count_number_components(val) == 6
		TYPE_BASIS:
			return _count_number_components(val) == 9
		TYPE_TRANSFORM3D:
			return _count_number_components(val) == 12
	return false


## Count comma-separated numeric components, ignoring surrounding brackets/parens/whitespace.
## Returns -1 if any component is not a number. Safe replacement for str_to_var (C-02).
static func _count_number_components(val: String) -> int:
	var cleaned := val.strip_edges()
	for ch in ["(", ")", "[", "]", "{", "}"]:
		cleaned = cleaned.replace(ch, "")
	if cleaned == "":
		return 0
	var parts := cleaned.split(",", false)
	for p in parts:
		var t := p.strip_edges()
		if not (t.is_valid_float() or t.is_valid_int()):
			return -1
	return parts.size()
