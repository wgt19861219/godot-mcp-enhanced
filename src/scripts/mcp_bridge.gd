@tool
extends Node

## MCP Bridge Autoload — TCP + NDJSON protocol
## Install as autoload in project.godot to enable runtime game control via MCP.
## Default port: 9081

const PORT := 9081

var _server: TCPServer = null
var _peers: Array[StreamPeerTCP] = []
var _peer_buffers: Dictionary = {}
var _secret: String = ""

const BLOCKED_PROPERTIES := ["script", "owner", "process_mode", "process_priority", "name"]

# ─── Lifecycle ─────────────────────────────────────────────────────────────

func _ready() -> void:
	_start_server()


func _exit_tree() -> void:
	_stop_server()


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections (Godot 4.6 renamed accept() to take_connection())
	var peer: StreamPeerTCP = _server_take_connection()
	if peer != null:
		_peers.append(peer)
		_peer_buffers[peer.get_instance_id()] = ""

	# Process each peer
	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var p: StreamPeerTCP = _peers[i]
		p.poll()
		if p.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			to_remove.append(i)
			continue
		if p.get_available_bytes() > 0:
			var data := p.get_utf8_string()
			if data != "":
				var pid := p.get_instance_id()
				_peer_buffers[pid] = str(_peer_buffers.get(pid, "")) + data
				_process_buffer(p, pid)

	# Remove disconnected peers (reverse order to preserve indices)
	for idx in range(to_remove.size() - 1, -1, -1):
		var i: int = to_remove[idx]
		var pid := _peers[i].get_instance_id()
		_peer_buffers.erase(pid)
		_peers.remove_at(i)


# ─── Server management ─────────────────────────────────────────────────────

func _start_server() -> void:
	_secret = _generate_secret()
	_server = TCPServer.new()
	var err := _server.listen(PORT)
	if err != OK:
		push_warning("[MCP Bridge] Failed to listen on port %d: %d" % [PORT, err])
		_server = null
		return
	print("[MCP Bridge] Listening on port %d | secret: %s" % [PORT, _secret])
## Compat: Godot 4.6 renamed TCPServer.accept() to take_connection()
func _server_take_connection() -> StreamPeerTCP:
	if _server.has_method("take_connection"):
		return _server.take_connection()
	return _server.accept()



func _generate_secret() -> String:
	var chars := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var result := ""
	for i in range(32):
		result += chars[randi() % chars.length()]
	return result


func _stop_server() -> void:
	for p in _peers:
		if p.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			p.disconnect_from_host()
	_peers.clear()
	if _server:
		_server.stop()
		_server = null


# ─── Protocol handling ─────────────────────────────────────────────────────

func _process_buffer(peer: StreamPeerTCP, pid: int) -> void:
	var buf: String = str(_peer_buffers.get(pid, ""))
	while true:
		var idx := buf.find("\n")
		if idx == -1:
			break
		var line := buf.substr(0, idx).strip_edges()
		buf = buf.substr(idx + 1)
		if line == "":
			continue
		# C1: Require auth handshake — first message must be {"method":"auth","secret":"..."}
		if not _peer_buffers.has(pid + 1):  # authenticated flag
			var parsed: Variant = JSON.parse_string(line)
			if parsed is Dictionary and parsed.get("method") == "auth" and str(parsed.get("secret")) == _secret:
				_peer_buffers[pid + 1] = true  # mark authenticated
				peer.put_utf8_string(JSON.stringify({"id": parsed.get("id"), "result": {"authenticated": true}}) + "\n")
				continue
			else:
				peer.put_utf8_string(JSON.stringify({"id": null, "error": {"code": -32001, "message": "Authentication required"}}) + "\n")
				continue
		var response := _handle_message(line)
		peer.put_utf8_string(response + "\n")
	_peer_buffers[pid] = buf


func _handle_message(raw: String) -> String:
	var parsed: Variant
	parsed = JSON.parse_string(raw)
	if parsed == null or not (parsed is Dictionary):
		return JSON.stringify({"id": null, "error": {"code": -32700, "message": "Parse error"}})

	var msg: Dictionary = parsed
	var id: Variant = msg.get("id", null)
	var method: String = str(msg.get("method", ""))
	var params: Dictionary = {}
	if msg.get("params") is Dictionary:
		params = msg["params"]

	var result: Variant = null
	var error: Dictionary = {}

	match method:
		"ping":
			result = _cmd_ping()
		"get_tree":
			result = _cmd_get_tree(params)
		"find_nodes":
			result = _cmd_find_nodes(params)
		"get_node_properties":
			result = _cmd_get_node_properties(params)
		"set_node_property":
			result = _cmd_set_node_property(params)
		"call_method":
			result = _cmd_call_method(params)
		"send_key":
			result = _cmd_send_key(params)
		"send_mouse_click":
			result = _cmd_send_mouse_click(params)
		"send_mouse_move":
			result = _cmd_send_mouse_move(params)
		"send_text":
			result = _cmd_send_text(params)
		"wait_for_node":
			result = _cmd_wait_for_node(params)
		"wait_for_property":
			result = _cmd_wait_for_property(params)
		"take_screenshot":
			result = _cmd_take_screenshot(params)
		"get_performance":
			result = _cmd_get_performance()
		"get_viewport_info":
			result = _cmd_get_viewport_info()
		_:
			error = {"code": -32601, "message": "Method not found: %s" % method}

	if error.is_empty():
		return JSON.stringify({"id": id, "result": result})
	else:
		return JSON.stringify({"id": id, "error": error})


# ─── Command implementations ────────────────────────────────────────────────

func _cmd_ping() -> Dictionary:
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	return {"pong": true, "scene": scene_path, "fps": Engine.get_frames_per_second()}


func _cmd_get_tree(params: Dictionary) -> Variant:
	var max_depth: int = int(params.get("max_depth", 10))
	var root_node := get_tree().root
	if root_node == null:
		return {"tree": [], "scene": ""}
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	return {"tree": [_serialize_node(root_node, max_depth, 0)], "scene": scene_path}


func _serialize_node(node: Node, max_depth: int, depth: int) -> Dictionary:
	var info := _node_info(node)
	if depth < max_depth:
		var children: Array = []
		for child in node.get_children():
			children.append(_serialize_node(child, max_depth, depth + 1))
		if children.size() > 0:
			info["children"] = children
	return info


func _node_info(node: Node) -> Dictionary:
	var info := {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()),
	}
	if node is CanvasItem:
		info["visible"] = node.visible
	if node is Node2D:
		info["position"] = {"x": node.position.x, "y": node.position.y}
	if node is Node3D:
		info["position"] = {"x": node.position.x, "y": node.position.y, "z": node.position.z}
	return info


func _cmd_find_nodes(params: Dictionary) -> Dictionary:
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var group: String = str(params.get("group", ""))
	var results: Array = []
	var nodes := _all_nodes(get_tree().root)
	for node in nodes:
		if pattern != "" and not node.name.match(pattern):
			continue
		if type_filter != "" and not node.is_class(type_filter):
			continue
		results.append(_node_info(node))
		if results.size() >= 100:
			break
	return {"nodes": results, "count": results.size()}


func _all_nodes(node: Node) -> Array[Node]:
	var result: Array[Node] = [node]
	for child in node.get_children():
		result.append_array(_all_nodes(child))
	return result


func _cmd_get_node_properties(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var props: Dictionary = {}
	for prop in node.get_property_list():
		var name: String = prop["name"]
		if name.begins_with("_") or name.begins_with("theme_override"):
			continue
		var val: Variant = node.get(name)
		if val is Resource:
			val = {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
		elif val is Node:
			val = str(val.get_path())
		props[name] = val
	return {"properties": props, "node": path}


func _cmd_set_node_property(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var prop: String = str(params.get("property", ""))
	var value: Variant = params.get("value")
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if prop.begins_with("_") or prop in BLOCKED_PROPERTIES:
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	node.set(prop, value)
	return {"success": true, "node": path, "property": prop}


func _cmd_call_method(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = []
	if params.get("args") is Array:
		args = params["args"]
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var blocked := ["queue_free", "free", "set_script", "remove_child", "queue_redraw"]
	if method in blocked:
		return {"error": {"code": -2, "message": "Blocked method: %s" % method}}
	if not node.has_method(method):
		return {"error": {"code": -3, "message": "Method not found: %s" % method}}
	var result: Variant = node.callv(method, args)
	return {"result": _jsonify(result)}


func _jsonify(val: Variant) -> Variant:
	if val is Vector2:
		return {"x": val.x, "y": val.y}
	if val is Vector3:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Color:
		return {"r": val.r, "g": val.g, "b": val.b, "a": val.a}
	if val is Rect2:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Resource:
		return {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
	if val is Node:
		return str(val.get_path())
	return val


# ─── Input simulation ──────────────────────────────────────────────────────

func _cmd_send_key(params: Dictionary) -> Variant:
	var key: String = str(params.get("key", ""))
	var pressed: bool = params.get("pressed", true)
	var keycode: int = _key_from_string(key)
	if keycode == 0:
		return {"error": {"code": -1, "message": "Unknown key: %s" % key}}
	var event := InputEventKey.new()
	event.keycode = keycode
	event.pressed = pressed
	Input.parse_input_event(event)
	return {"success": true, "key": key}


func _key_from_string(key: String) -> int:
	var mapping := {
		"enter": KEY_ENTER, "escape": KEY_ESCAPE, "space": KEY_SPACE,
		"tab": KEY_TAB, "shift": KEY_SHIFT, "ctrl": KEY_CTRL, "alt": KEY_ALT,
		"up": KEY_UP, "down": KEY_DOWN, "left": KEY_LEFT, "right": KEY_RIGHT,
		"a": KEY_A, "b": KEY_B, "c": KEY_C, "d": KEY_D, "e": KEY_E,
		"f": KEY_F, "g": KEY_G, "h": KEY_H, "i": KEY_I, "j": KEY_J,
		"k": KEY_K, "l": KEY_L, "m": KEY_M, "n": KEY_N, "o": KEY_O,
		"p": KEY_P, "q": KEY_Q, "r": KEY_R, "s": KEY_S, "t": KEY_T,
		"u": KEY_U, "v": KEY_V, "w": KEY_W, "x": KEY_X, "y": KEY_Y, "z": KEY_Z,
		"0": KEY_0, "1": KEY_1, "2": KEY_2, "3": KEY_3, "4": KEY_4,
		"5": KEY_5, "6": KEY_6, "7": KEY_7, "8": KEY_8, "9": KEY_9,
	}
	var upper := key.to_lower()
	if mapping.has(upper):
		return mapping[upper]
	return 0


func _cmd_send_mouse_click(params: Dictionary) -> Variant:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var button: int = int(params.get("button", 1))
	var pressed: bool = params.get("pressed", true)
	var event := InputEventMouseButton.new()
	event.position = Vector2(x, y)
	event.button_index = button
	event.pressed = pressed
	event.global_position = Vector2(x, y)
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y, "button": button}


func _cmd_send_mouse_move(params: Dictionary) -> Variant:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y}


func _cmd_send_text(params: Dictionary) -> Variant:
	var text: String = str(params.get("text", ""))
	for ch in text:
		var event := InputEventKey.new()
		event.unicode = ch.unicode_at(0)
		event.pressed = true
		Input.parse_input_event(event)
		event.pressed = false
		Input.parse_input_event(event)
	return {"success": true, "characters": text.length()}


# ─── Wait commands (sync check, not async) ──────────────────────────────────

func _cmd_wait_for_node(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	return {"exists": node != null, "path": path}


func _cmd_wait_for_property(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var prop: String = str(params.get("property", ""))
	var expected: Variant = params.get("value")
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var current: Variant = node.get(prop)
	var match_result: bool = str(current) == str(expected)
	return {"match": match_result, "property": prop, "current": _jsonify(current), "expected": _jsonify(expected)}


# ─── Visual ─────────────────────────────────────────────────────────────────

func _cmd_take_screenshot(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", "user://mcp_screenshot.png"))
	var viewport := get_viewport()
	var img := viewport.get_texture().get_image()
	img.save_png(path)
	return {"success": true, "path": path, "size": {"x": img.get_width(), "y": img.get_height()}}


func _cmd_get_performance() -> Dictionary:
	return {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
	}


func _cmd_get_viewport_info() -> Dictionary:
	var vp := get_viewport()
	return {
		"size": {"x": vp.get_visible_rect().size.x, "y": vp.get_visible_rect().size.y},
	}
