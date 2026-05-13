extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func handle_test_assert(params: Dictionary) -> Dictionary:
	var assertion_type: String = params.get("assertion_type", "")
	var path: String = params.get("path", "")
	var root: Node = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	match assertion_type:
		"node_exists":
			var node = _find_node(root, path)
			if node != null:
				return {"result": {"passed": true, "message": "Node exists: " + path}}
			else:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
		"property_equals":
			var node = _find_node(root, path)
			if node == null:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
			var prop: String = params.get("property", "")
			var val = node.get(prop)
			var expected = params.get("expected")
			var match = str(val) == str(expected)
			return {"result": {"passed": match, "message": "%s.%s = %s (expected: %s)" % [path, prop, str(val), str(expected)], "actual": str(val)}}
		"signal_connected":
			var src_path: String = params.get("path", "")
			var tgt_path: String = params.get("target", "")
			var sig: String = params.get("signal", "")
			var meth: String = params.get("method", "")
			var src = _find_node(root, src_path)
			var tgt = _find_node(root, tgt_path)
			if src == null or tgt == null:
				return {"result": {"passed": false, "message": "Source or target node not found"}}
			var connected = src.is_connected(sig, Callable(tgt, meth))
			return {"result": {"passed": connected, "message": "Signal %s->%s.%s %s" % [sig, tgt_path, meth, "connected" if connected else "not connected"]}}
		"node_count":
			var parent_path: String = params.get("parent", "")
			var parent_node = _find_node(root, parent_path) if parent_path != "" else root
			if parent_node == null:
				return {"result": {"passed": false, "message": "Parent node not found: " + parent_path}}
			var count: int = parent_node.get_child_count()
			var expected_count: int = int(params.get("count", -1))
			return {"result": {"passed": count == expected_count, "message": "Children: %d (expected: %d)" % [count, expected_count], "actual": count}}
		_:
			return {"error": {"code": -32004, "message": "Unknown assertion type: " + assertion_type}}

func _get_edited_scene_root() -> Node:
	if _plugin != null:
		var ei = _plugin.get_editor_interface()
		if ei != null:
			var edited = ei.get_edited_scene_root()
			if edited != null:
				return edited
	# Fallback via SceneTree
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
