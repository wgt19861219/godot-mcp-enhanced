extends Node

var _command_handler: Node
var _syncing: bool = false
var _node_paths: Dictionary = {}  # { instance_id (int): { path: String, type: String } }


func setup(handler: Node) -> void:
	_command_handler = handler


func start_sync() -> Dictionary:
	if _syncing:
		return {"error": {"code": "SYNC_ALREADY_ACTIVE", "message": "Sync already active"}}
	_syncing = true
	_node_paths.clear()
	_cache_paths_recursive(get_tree().root)
	get_tree().connect("node_added", _on_node_added)
	get_tree().connect("node_removed", _on_node_removed)
	return {"result": {"success": true}}


func stop_sync() -> Dictionary:
	if not _syncing:
		return {"error": {"code": "SYNC_NOT_ACTIVE", "message": "Sync not active"}}
	_syncing = false
	get_tree().disconnect("node_added", _on_node_added)
	get_tree().disconnect("node_removed", _on_node_removed)
	_node_paths.clear()
	return {"result": {"success": true}}


func get_scene_tree() -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": "NO_SCENE", "message": "No current scene"}}
	return {"result": {"success": true, "tree": _serialize_tree(root, 0, 5)}}


func _cache_paths_recursive(node: Node, depth: int = 0) -> void:
	if node and depth < 50:
		_node_paths[node.get_instance_id()] = {
			"path": str(node.get_path()),
			"type": node.get_class()
		}
		for child in node.get_children():
			_cache_paths_recursive(child, depth + 1)


func _on_node_added(node: Node) -> void:
	# 仅跟踪当前编辑场景内的节点变更
	var edited_root = _get_edited_scene_root()
	if edited_root != null and not edited_root.is_ancestor_of(node) and node != edited_root:
		return
	var path = str(node.get_path())
	_node_paths[node.get_instance_id()] = {
		"path": path,
		"type": node.get_class()
	}
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_added",
			"path": path,
			"node_type": node.get_class()
		})


func _on_node_removed(node: Node) -> void:
	var edited_root = _get_edited_scene_root()
	if edited_root != null and not edited_root.is_ancestor_of(node) and node != edited_root:
		return
	var id = node.get_instance_id()
	var cached = _node_paths.get(id, {})
	var path = cached.get("path", "<removed>") if cached is Dictionary else "<removed>"
	var node_type = cached.get("type", "Node") if cached is Dictionary else "Node"
	_node_paths.erase(id)
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_removed",
			"path": path,
			"node_type": node_type
		})


func cleanup() -> void:
	if _syncing:
		stop_sync()


func _get_edited_scene_root() -> Node:
	if _command_handler and _command_handler.has_method("get_plugin"):
		var plugin = _command_handler.get_plugin()
		if plugin:
			var ei = plugin.get_editor_interface()
			if ei:
				return ei.get_edited_scene_root()
	var ml = Engine.get_main_loop()
	if ml and ml is SceneTree and ml.root and ml.root.get_child_count() > 0:
		return ml.root.get_child(0)
	return null


func _serialize_tree(node: Node, depth: int, max_depth: int) -> Dictionary:
	var result = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path())
	}
	if depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(_serialize_tree(child, depth + 1, max_depth))
		result["children"] = children
	return result
