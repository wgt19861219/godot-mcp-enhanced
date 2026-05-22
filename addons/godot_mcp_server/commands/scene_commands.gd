extends Node

func handle_open_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("scene_path", "")
	if path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path is required"}}
	if not path.begins_with("res://"):
		return {"error": {"code": -32004, "message": "scene_path must start with res://"}}
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.open_scene_from_path(path)
	return {"result": {"status": "opened", "path": path}}

func handle_save_scene(_params: Dictionary) -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.save_scene()
	return {"result": {"status": "saved"}}

func handle_instance_scene(params: Dictionary) -> Dictionary:
	var scene_path: String = params.get("scene_path", "")
	var instance_path: String = params.get("instance_path", "")
	var parent_path: String = params.get("parent_node_path", "")
	var node_name: String = params.get("node_name", "")
	var properties: Dictionary = params.get("properties", {})

	if scene_path.is_empty() or instance_path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path and instance_path required"}}
	if not instance_path.begins_with("res://"):
		return {"error": {"code": -32004, "message": "instance_path must start with res://"}}
	if scene_path == instance_path:
		return {"error": {"code": -32004, "message": "CIRCULAR_REFERENCE"}}

	var instance_res = load(instance_path)
	if instance_res == null:
		return {"error": {"code": -32000, "message": "INSTANCE_LOAD_FAILED: " + instance_path}}
	if not (instance_res is PackedScene):
		return {"error": {"code": -32000, "message": "NOT_A_PACKED_SCENE: " + instance_path}}

	var instance = instance_res.instantiate()
	if not node_name.is_empty():
		instance.name = node_name

	var blocked: Array = ["script", "owner", "name", "parent", "children", "tree", "meta", "process_mode", "process_priority",
		"process_input", "process_unhandled_input", "process_unhandled_key_input",
		"process_internal", "physics_process_mode", "input_event", "ready"]
	for key in properties:
		if key.begins_with("_") or key in blocked:
			continue
		if not key is String:
			continue
		var val = properties[key]
		if val is Object:
			continue  # 不允许设置 Object 子类型
		instance.set(key, val)

	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()
	if root == null:
		instance.queue_free()  # 释放未添加到树的节点
		return {"error": {"code": -32003, "message": "No edited scene"}}
	var parent = _find_node_by_path(root, parent_path)
	if parent == null:
		parent = root
	parent.add_child(instance)
	instance.owner = root

	return {"result": {"node_name": str(instance.name), "instance_of": instance_path}}

func handle_set_instance_property(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	var prop_name: String = params.get("property", "")
	var prop_value = params.get("value")

	if node_path.is_empty() or prop_name.is_empty():
		return {"error": {"code": -32004, "message": "node_path and property required"}}

	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No edited scene"}}
	var target = _find_node_by_path(root, node_path)
	if target == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}

	if target == root or target.owner != root:
		return {"error": {"code": -32004, "message": "NODE_NOT_INSTANCE"}}

	var blocked: Array = ["script", "owner", "name", "parent", "children", "tree", "meta", "process_mode", "process_priority",
		"process_input", "process_unhandled_input", "process_unhandled_key_input",
		"process_internal", "physics_process_mode", "input_event", "ready"]
	if prop_name.begins_with("_") or prop_name in blocked:
		return {"error": {"code": -32004, "message": "BLOCKED_PROPERTY: " + prop_name}}
	# 属性名格式验证
	if prop_name.is_empty() or (not (prop_name[0] == "_" or prop_name[0].is_alpha())):
		return {"error": {"code": -32004, "message": "INVALID_PROPERTY_NAME: " + prop_name}}
	if prop_value is Object:
		return {"error": {"code": -32004, "message": "OBJECT_VALUES_NOT_ALLOWED"}}
	target.set(prop_name, prop_value)
	return {"result": {"node": str(target.name), "property": prop_name}}

func _find_node_by_path(root: Node, path: String) -> Node:
	if path.is_empty() or path == "root":
		return root
	var clean: String = path
	if clean.begins_with("root/"):
		clean = clean.substr(5)
	while clean.begins_with("/"):
		clean = clean.substr(1)
	if clean.is_empty():
		return root
	if root.has_node(clean):
		return root.get_node(clean)
	return null
