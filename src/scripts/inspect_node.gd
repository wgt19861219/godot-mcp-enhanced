extends SceneTree

# Deep-inspect a specific node in a scene
# Usage: godot --headless --path <project> --script inspect_node.gd <json_params>
# Params: {
#   "scene_path": "res://scenes/main.tscn",
#   "node_path": "root/Player/Sprite2D",   (optional, default: root)
#   "max_depth": 3,
#   "include_signals": true,
#   "include_properties": true
# }

func _init():
	var args = OS.get_cmdline_args()
	var script_index = args.find("--script")
	if script_index == -1:
		_output_error("Could not find --script argument")
		quit(1)
		return

	var params_index = script_index + 2
	if args.size() <= params_index:
		_output_error("Usage: godot --headless --script inspect_node.gd <json_params>")
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
	var node_path = params.get("node_path", "")
	var max_depth = int(params.get("max_depth", 3))
	var include_signals = params.get("include_signals", true)
	var include_properties = params.get("include_properties", true)

	if scene_path == "":
		_output_error("scene_path is required")
		quit(1)
		return

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	# Load and instantiate scene
	var scene_resource = load(scene_path)
	if not scene_resource:
		_output_error("Failed to load scene: " + scene_path)
		quit(1)
		return

	var root = scene_resource.instantiate()
	get_root().add_child(root)

	# Find target node
	var target = root
	if node_path != "" and node_path != "root":
		var clean_path = node_path
		if clean_path.begins_with("root/"):
			clean_path = clean_path.substr(5)
		if root.has_node(clean_path):
			target = root.get_node(clean_path)
		else:
			_output_error("Node not found: " + node_path)
			root.queue_free()
			quit(1)
			return

	# Build result
	var result = {
		"name": str(target.name),
		"type": target.get_class(),
		"path": str(target.get_path()),
		"scene_path": scene_path,
	}

	if include_properties:
		result["properties"] = _get_all_properties(target)

	if include_signals:
		result["signal_connections"] = _get_signal_connections(target)
		result["available_signals"] = _get_available_signals(target)

	result["children"] = _get_children_details(target, 0, max_depth)

	_output_result(result)

	root.queue_free()
	quit()

func _get_all_properties(node: Node) -> Dictionary:
	var props = {}
	for prop in node.get_property_list():
		var name = prop["name"]
		# Skip noisy internal properties
		if name.begins_with("_") or name in ["script", "owner"]:
			continue
		if prop.usage & PROPERTY_USAGE_STORAGE or prop.usage & PROPERTY_USAGE_EDITOR:
			var val = node.get(name)
			props[name] = _safe_str(val)
	return props

func _get_signal_connections(node: Node) -> Array:
	var connections = []
	for conn in node.get_incoming_connections():
		var entry = {}
		if "signal" in conn:
			entry["signal"] = str(conn["signal"])
		if "source" in conn:
			var src = conn["source"]
			if src is Node:
				entry["from"] = str(src.get_path())
			else:
				entry["from"] = str(src)
		if "method" in conn:
			entry["method"] = str(conn["method"])
		connections.append(entry)
	return connections

func _get_available_signals(node: Node) -> Array:
	var signals = []
	for sig in node.get_signal_list():
		var entry = {"name": str(sig.get("name", ""))}
		var args_arr = []
		if sig.has("args"):
			for arg in sig["args"]:
				args_arr.append(str(arg))
		entry["args"] = args_arr
		signals.append(entry)
	return signals

func _get_children_details(node: Node, depth: int, max_depth: int) -> Array:
	if depth >= max_depth:
		var names = []
		for child in node.get_children():
			names.append({"name": str(child.name), "type": child.get_class(), "truncated": true})
		return names

	var children = []
	for child in node.get_children():
		var entry = {
			"name": str(child.name),
			"type": child.get_class(),
		}
		if depth + 1 < max_depth:
			entry["children"] = _get_children_details(child, depth + 1, max_depth)
		children.append(entry)
	return children

func _safe_str(val) -> String:
	if val == null:
		return "<null>"
	match typeof(val):
		TYPE_OBJECT:
			if val:
				return "<" + val.get_class() + ">"
			return "<null>"
		TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I:
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

func _output_result(data: Dictionary) -> void:
	print("___MCP_RESULT___" + JSON.stringify(data))

func _output_error(msg: String) -> void:
	print("___MCP_ERROR___" + JSON.stringify({"success": false, "error": msg}))
