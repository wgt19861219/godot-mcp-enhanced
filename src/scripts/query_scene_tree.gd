extends SceneTree

# Query scene tree at runtime — returns resolved property values
# Usage: godot --headless --path <project> --script query_scene_tree.gd <json_params>
# Params: { "scene_path": "res://scenes/main.tscn", "max_depth": 5 }

func _init():
	var args = OS.get_cmdline_args()
	var script_index = args.find("--script")
	if script_index == -1:
		_output_error("Could not find --script argument")
		quit(1)
		return

	var params_index = script_index + 2
	if args.size() <= params_index:
		_output_error("Usage: godot --headless --script query_scene_tree.gd <json_params>")
		quit(1)
		return

	var params_json = args[params_index]
	var json = JSON.new()
	var error = json.parse(params_json)
	if error != OK:
		_output_error("Failed to parse JSON: " + json.get_error_message())
		quit(1)
		return

	var params = json.get_data()
	var scene_path = params.get("scene_path", "")
	var max_depth = int(params.get("max_depth", 5))

	if scene_path == "":
		_output_error("scene_path is required")
		quit(1)
		return

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	# Load scene
	var scene_resource = load(scene_path)
	if not scene_resource:
		_output_error("Failed to load scene: " + scene_path)
		quit(1)
		return

	# Instantiate
	var root = scene_resource.instantiate()
	get_root().add_child(root)

	# Walk tree
	var tree_data = _inspect_node(root, 0, max_depth)
	var total = _count_nodes(tree_data)

	_output_result({"root": tree_data, "total_nodes": total, "scene_path": scene_path})

	root.queue_free()
	quit()

func _inspect_node(node: Node, depth: int, max_depth: int) -> Dictionary:
	var result = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path()),
		"properties": _get_storage_properties(node),
		"children": []
	}

	if depth < max_depth:
		for child in node.get_children():
			result["children"].append(_inspect_node(child, depth + 1, max_depth))

	return result

func _get_storage_properties(node: Node) -> Dictionary:
	var props = {}
	for prop in node.get_property_list():
		if prop.usage & PROPERTY_USAGE_STORAGE:
			var val = node.get(prop.name)
			if val != null:
				props[prop.name] = _safe_str(val)
	return props

func _safe_str(val) -> String:
	if val == null:
		return "<null>"
	match typeof(val):
		TYPE_OBJECT:
			if val:
				return "<" + val.get_class() + ">"
			return "<null>"
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return str(val)
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return str(val)
		TYPE_COLOR:
			return str(val)
		TYPE_RECT2, TYPE_RECT2I:
			return str(val)
		TYPE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, \
		TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, \
		TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			return str(val)
		TYPE_DICTIONARY:
			return JSON.stringify(val)
		_:
			return str(val)

func _count_nodes(data: Dictionary) -> int:
	var count = 1
	for child in data.get("children", []):
		count += _count_nodes(child)
	return count

func _output_result(data: Dictionary) -> void:
	print("___MCP_RESULT___" + JSON.stringify(data))

func _output_error(msg: String) -> void:
	print("___MCP_ERROR___" + JSON.stringify({"success": false, "error": msg}))
