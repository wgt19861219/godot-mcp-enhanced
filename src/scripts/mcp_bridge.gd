@tool
extends Node

## MCP Bridge Autoload — TCP + NDJSON protocol
## Install as autoload in project.godot to enable runtime game control via MCP.
## Default port: 9081

const PORT := 9081
const MAX_AUTH_FAILS := 5
const LOCKOUT_BASE_SECONDS := 30.0
const LOCKOUT_MAX_SECONDS := 300.0
const _LOCKOUT_KEY := "localhost"
const MAX_MESSAGE_SIZE := 1048576  # 1MB
const MAX_PEERS := 5
const PROTOCOL_VERSION := "1.0"
const INACTIVITY_TIMEOUT := 60.0

var _server: TCPServer = null
var _peers: Array[StreamPeerTCP] = []
var _peer_buffers: Dictionary = {}
var _authenticated_peers: Dictionary = {}
var _auth_fail_count: Dictionary = {}
var _auth_locked_until: Dictionary = {}
var _secret: String = ""
var _secret_file: String = ""
var _crypto: Crypto = null
var _peer_last_activity: Dictionary = {}

var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0

const BLOCKED_PROPERTIES := [
	"script", "owner", "process_mode", "process_priority", "process_input",
	"process_unhandled_input", "process_unhandled_key_input", "process_internal",
	"physics_process_mode", "physics_interpolation_mode", "name", "meta",
	"input_event", "ready", "tree_entered", "tree_exited", "tree_exiting",
]

# WARNING: "get" + "get_property_list" can enumerate most public properties.
# This is intentional for debugging but be aware of the information disclosure vector.
const ALLOWED_METHODS := [
	"get", "get_class", "get_path", "get_children", "get_child", "get_child_count",
	"get_parent", "get_property_list", "has_method", "is_class", "get_instance_id",
	"get_meta", "has_meta", "has_signal", "get_signal_list", "get_signal_connection_list",
	"get_incoming_connections", "get_index", "get_groups", "is_in_group",
	"is_inside_tree", "is_part_of_edited_scene", "get_owner",
]

# ─── Lifecycle ─────────────────────────────────────────────────────────────

func _ready() -> void:
	if Engine.is_editor_hint():
		return
	_start_server()


func _exit_tree() -> void:
	_stop_server()


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections (Godot 4.6 renamed accept() to take_connection())
	var peer: StreamPeerTCP = _server_take_connection()
	if peer != null:
		if _peers.size() >= MAX_PEERS:
			push_warning("[MCP Bridge] Max peers (%d) reached, rejecting connection" % MAX_PEERS)
			peer.disconnect_from_host()
		else:
			_peers.append(peer)
			_peer_last_activity[peer.get_instance_id()] = Time.get_ticks_msec() / 1000.0
			_peer_buffers["buf_" + str(peer.get_instance_id())] = PackedByteArray()

	# Process each peer
	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var p: StreamPeerTCP = _peers[i]
		p.poll()
		if p.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			to_remove.append(i)
			continue
		# Idle timeout check
		var pid_act := p.get_instance_id()
		if _peer_last_activity.has(pid_act):
			var elapsed := Time.get_ticks_msec() / 1000.0 - _peer_last_activity[pid_act]
			if elapsed > INACTIVITY_TIMEOUT:
				push_warning("[MCP Bridge] Peer %d idle for %.0fs, disconnecting" % [pid_act, elapsed])
				p.disconnect_from_host()
				to_remove.append(i)
				continue
		if p.get_available_bytes() > 0:
			_peer_last_activity[pid_act] = Time.get_ticks_msec() / 1000.0
			var byte_count := p.get_available_bytes()
			var result := p.get_data(byte_count)
			if result[0] == OK:
				var raw_data: PackedByteArray = result[1]
				if raw_data.size() > 0:
					var pid := p.get_instance_id()
					var key := "buf_" + str(pid)
					var existing: PackedByteArray = _peer_buffers.get(key, PackedByteArray()) as PackedByteArray
					var combined: PackedByteArray = existing + raw_data
					if combined.size() > MAX_MESSAGE_SIZE:
						push_warning("[MCP Bridge] Peer %d buffer exceeded %d bytes, disconnecting" % [pid, MAX_MESSAGE_SIZE])
						p.disconnect_from_host()
						to_remove.append(i)
						continue
					_peer_buffers[key] = combined
					if _process_buffer_bytes(p, pid):
						to_remove.append(i)

	# Remove disconnected peers (reverse order to preserve indices)
	for idx in range(to_remove.size() - 1, -1, -1):
		var i: int = to_remove[idx]
		var pid := _peers[i].get_instance_id()
		_peer_buffers.erase("buf_" + str(pid))
		_authenticated_peers.erase(pid)
		_peer_last_activity.erase(pid)
		# Auth fail/lockout counts persist across reconnects (all connections are localhost)
		_peers.remove_at(i)


# ─── Server management ─────────────────────────────────────────────────────

func _start_server() -> void:
	_crypto = Crypto.new()
	_secret = _generate_secret()
	_server = TCPServer.new()
	var err := _server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_warning("[MCP Bridge] Failed to listen on port %d: %d" % [PORT, err])
		_server = null
		return
	print("[MCP Bridge] Listening on 127.0.0.1:%d" % PORT)
	var proj_dir := _get_project_dir()
	if proj_dir != "":
		var godot_dir := proj_dir + "/.godot"
		if not DirAccess.dir_exists_absolute(godot_dir):
			DirAccess.make_dir_recursive_absolute(godot_dir)
		_secret_file = godot_dir + "/mcp_bridge_%d.secret" % PORT
		if not _write_secret_to_file(_secret_file):
			push_warning("[MCP Bridge] Failed to write secret to .godot/, falling back to tmpdir")
		else:
			return
	_secret_file = OS.get_temp_dir().path_join("mcp_bridge_%d.secret" % PORT)
	push_warning("[MCP Bridge][SECURITY] Writing secret to tmpdir — file may be readable by other users. Prefer project .godot/ directory.")
	if not _write_secret_to_file(_secret_file):
		push_warning("[MCP Bridge] Failed to write secret to %s" % _secret_file)

## Compat: Godot 4.6 renamed TCPServer.accept() to take_connection()
func _server_take_connection() -> StreamPeerTCP:
	if _server.has_method("take_connection"):
		return _server.take_connection()
	return _server.accept()


# DUPLICATE: Keep in sync with addons/godot_mcp_server/websocket_server.gd:_constant_time_compare
# Cannot share because editor plugin and game autoload have separate script contexts.
func _constant_time_compare(a: String, b: String) -> bool:
	var result := 0
	if a.length() != b.length():
		result = 1
	var max_len := maxi(a.length(), b.length())
	for i in range(max_len):
		var ca := ord(a[i]) if i < a.length() else 0
		var cb := ord(b[i]) if i < b.length() else 0
		result = result | (ca ^ cb)
	return result == 0

# DUPLICATE: Keep in sync with addons/godot_mcp_server/websocket_server.gd:_generate_secret
# Cannot share because editor plugin and game autoload have separate script contexts.
func _generate_secret() -> String:
	var chars := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var result := ""
	var rng_bytes: PackedByteArray = _crypto.generate_random_bytes(64)
	var idx := 0
	while result.length() < 32 and idx < rng_bytes.size():
		var b: int = rng_bytes[idx]
		idx += 1
		# Rejection sampling: skip bytes causing modulo bias (256 % 62 = 8, skip >= 248)
		if b >= 256 - (256 % chars.length()):
			continue
		result += chars[b % chars.length()]
	# Fallback: if rejection sampling exhausted bytes, generate more (max 10 attempts)
	var fallback_attempts := 0
	while result.length() < 32 and fallback_attempts < 10:
		rng_bytes = _crypto.generate_random_bytes(64)
		idx = 0
		fallback_attempts += 1
		while result.length() < 32 and idx < rng_bytes.size():
			var b2: int = rng_bytes[idx]
			idx += 1
			if b2 >= 256 - (256 % chars.length()):
				continue
			result += chars[b2 % chars.length()]
	if result.length() < 32:
		push_error("[MCP Bridge] Failed to generate 32-char secret, using truncated value")
	return result

func _get_project_dir() -> String:
	var res_root: String = ProjectSettings.globalize_path("res://")
	if res_root != "":
		return res_root.rstrip("/")
	return ""



func _write_secret_to_file(path: String) -> bool:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f:
		f.store_string(_secret)
		f.close()
		return true
	return false


func _stop_server() -> void:
	for p in _peers:
		if p.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			p.disconnect_from_host()
	_peers.clear()
	_authenticated_peers.clear()
	_peer_last_activity.clear()
	_auth_fail_count.clear()
	_auth_locked_until.clear()
	if _server:
		_server.stop()
		if _secret_file != "" and FileAccess.file_exists(_secret_file):
			DirAccess.remove_absolute(_secret_file)
		_server = null


# ─── Protocol handling ─────────────────────────────────────────────────────

func _process_buffer_bytes(peer: StreamPeerTCP, pid: int) -> bool:
	var key := "buf_" + str(pid)
	var raw: PackedByteArray = _peer_buffers.get(key, PackedByteArray()) as PackedByteArray
	while true:
		var nl_idx := raw.find(0x0A)
		if nl_idx == -1:
			break
		var line_bytes: PackedByteArray = raw.slice(0, nl_idx)
		raw = raw.slice(nl_idx + 1)
		if line_bytes.size() == 0:
			continue
		var line := line_bytes.get_string_from_utf8()
		if line == "" and line_bytes.size() > 0:
			push_warning("[MCP Bridge] Invalid UTF-8 in message from peer %d, disconnecting" % pid)
			peer.disconnect_from_host()
			_peer_buffers[key] = raw
			return true
		if not _authenticated_peers.has(pid):
			
			if _auth_locked_until.has(_LOCKOUT_KEY):
				var locked_until: float = _auth_locked_until[_LOCKOUT_KEY]
				if Time.get_ticks_msec() / 1000.0 < locked_until:
					peer.put_data((JSON.stringify({"id": null, "error": {"code": -32002, "message": "Too many auth failures, temporarily locked"}}) + "\n").to_utf8_buffer())
					peer.disconnect_from_host()
					_peer_buffers[key] = raw
					return true
				else:
					_auth_locked_until.erase(_LOCKOUT_KEY)
					_auth_fail_count[_LOCKOUT_KEY] = 0
			var parsed: Variant = JSON.parse_string(line)
			var incoming_secret: String = ""
			if parsed is Dictionary and parsed.get("params") is Dictionary:
				incoming_secret = str(parsed["params"].get("secret", ""))
			if parsed is Dictionary and parsed.get("method") == "auth" and _constant_time_compare(incoming_secret, _secret):
				_authenticated_peers[pid] = true
				_auth_fail_count.erase(_LOCKOUT_KEY)
				peer.put_data((JSON.stringify({"id": parsed.get("id"), "result": {"authenticated": true}}) + "\n").to_utf8_buffer())
				continue
			else:
				var fails: int = int(_auth_fail_count.get(_LOCKOUT_KEY, 0)) + 1
				_auth_fail_count[_LOCKOUT_KEY] = fails
				if fails >= MAX_AUTH_FAILS:
					var lockout_time := minf(LOCKOUT_BASE_SECONDS * pow(2.0, (float(fails) / MAX_AUTH_FAILS) - 1.0), LOCKOUT_MAX_SECONDS)
					_auth_locked_until[_LOCKOUT_KEY] = Time.get_ticks_msec() / 1000.0 + lockout_time
				peer.put_data((JSON.stringify({"id": null, "error": {"code": -32001, "message": "Authentication required"}}) + "\n").to_utf8_buffer())
				peer.disconnect_from_host()
				_peer_buffers[key] = raw
				return true
		var response := _handle_message(line)
		peer.put_data((response + "\n").to_utf8_buffer())
	_peer_buffers[key] = raw
	return false

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
		"recording.start":
			result = _cmd_recording_start()
		"recording.stop":
			result = _cmd_recording_stop()
		_:
			error = {"code": -32601, "message": "Method not found: %s" % method}

	# Promote command-level errors to top-level so TS client sees them.
	# TS sendToBridge only checks resp.error (top-level), never result.error.
	if error.is_empty() and result is Dictionary and result.has("error"):
		error = result["error"]
		result = null
	if error.is_empty():
		return JSON.stringify({"id": id, "result": result})
	else:
		return JSON.stringify({"id": id, "error": error})


# ─── Command implementations ────────────────────────────────────────────────

func _cmd_ping() -> Dictionary:
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	return {"pong": true, "version": PROTOCOL_VERSION, "scene": scene_path, "fps": Engine.get_frames_per_second()}


func _cmd_get_tree(params: Dictionary) -> Variant:
	var max_depth: int = int(params.get("max_depth", 10))
	var root_node := get_tree().root
	if root_node == null:
		return {"tree": [], "scene": ""}
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	var counter := [0]
	return {"tree": [_serialize_node(root_node, max_depth, 0, counter)], "scene": scene_path}


func _serialize_node(node: Node, max_depth: int, depth: int, counter: Array, max_nodes: int = 2000) -> Dictionary:
	if counter[0] >= max_nodes:
		return _node_info(node)
	counter[0] += 1
	var info := _node_info(node)
	if depth < max_depth:
		var children: Array = []
		for child in node.get_children():
			if counter[0] >= max_nodes:
				break
			children.append(_serialize_node(child, max_depth, depth + 1, counter, max_nodes))
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
	var max_results: int = int(params.get("limit", 100))
	if max_results > 500:
		max_results = 500
	var results: Array = []
	var stack: Array[Node] = [get_tree().root]
	while stack.size() > 0 and results.size() < max_results:
		var node: Node = stack.pop_back()
		if node == null:
			continue
		var match_found := true
		if pattern != "" and not node.name.match(pattern):
			match_found = false
		if match_found and type_filter != "" and not node.is_class(type_filter):
			match_found = false
		if match_found and group != "" and not node.is_in_group(group):
			match_found = false
		if match_found:
			results.append(_node_info(node))
		var children := node.get_children()
		for i in range(children.size() - 1, -1, -1):
			stack.append(children[i])
	return {"nodes": results, "count": results.size()}





func _cmd_get_node_properties(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var props: Dictionary = {}
	for prop in node.get_property_list():
		var name: String = prop["name"]
		if name.begins_with("_") or name.begins_with("theme_override") or name in BLOCKED_PROPERTIES:
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
	if not params.has("value"):
		return {"error": {"code": -6, "message": "Missing required parameter: value"}}
	var value: Variant = params["value"]
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if _is_blocked_property(prop):
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	if not _is_safe_value(value):
		return {"error": {"code": -3, "message": "Value type not allowed: %s" % value.get_class()}}
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
	if not method in ALLOWED_METHODS:
		return {"error": {"code": -2, "message": "Method not allowed: %s" % method}}
	if not node.has_method(method):
		return {"error": {"code": -3, "message": "Method not found: %s" % method}}
	if args.size() > 8:
		return {"error": {"code": -4, "message": "Too many arguments (max 8)"}}
	if method == "get" and args.size() > 0 and args[0] is String:
		if _is_blocked_property(args[0]):
			return {"error": {"code": -5, "message": "Blocked property via get(): %s" % args[0]}}
	var result: Variant = node.callv(method, args)
	return {"result": _jsonify(result)}


func _jsonify(val: Variant) -> Variant:
	if val is Vector2:
		return {"x": val.x, "y": val.y}
	if val is Vector2i:
		return {"x": val.x, "y": val.y}
	if val is Vector3:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Vector3i:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Color:
		return {"r": val.r, "g": val.g, "b": val.b, "a": val.a}
	if val is Rect2:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Rect2i:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Transform2D:
		return {"x": val.origin.x, "y": val.origin.y}
	if val is Transform3D:
		return {"x": val.origin.x, "y": val.origin.y, "z": val.origin.z}
	if val is Resource:
		return {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
	if val is Node:
		return str(val.get_path())
	return val


func _is_safe_value(val: Variant) -> bool:
	# Whitelist: only allow safe value types for set_node_property
	if val == null:
		return true
	if val is bool or val is int or val is float or val is String:
		return true
	if val is Vector2 or val is Vector2i or val is Vector3 or val is Vector3i:
		return true
	if val is Color or val is Rect2 or val is Rect2i:
		return true
	if val is Transform2D or val is Transform3D or val is Basis or val is Quaternion:
		return true
	if val is Plane or val is AABB:
		return true
	if val is PackedByteArray or val is PackedInt32Array or val is PackedInt64Array:
		return true
	if val is PackedFloat32Array or val is PackedFloat64Array or val is PackedStringArray:
		return true
	if val is PackedVector2Array or val is PackedVector3Array or val is PackedColorArray:
		return true
	if val is Array:
		for item in val:
			if not _is_safe_value(item):
				return false
		return true
	if val is Dictionary:
		for key in val:
			if not _is_safe_value(val[key]):
				return false
		return true
	return false


func _is_blocked_property(prop: String) -> bool:
	if prop.begins_with("_"):
		return true
	if prop.begins_with("theme_override"):
		return true
	if prop in BLOCKED_PROPERTIES:
		return true
	if "." in prop:
		for segment in prop.split("."):
			if segment == "" or segment.begins_with("_") or segment in BLOCKED_PROPERTIES:
				return true
	if ":" in prop or "/" in prop:
		return true
	return false


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
	if text.length() > 1000:
		return {"error": {"code": -1, "message": "Text too long: %d chars (max 1000)" % text.length()}}
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
	if _is_blocked_property(prop):
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	var current: Variant = node.get(prop)
	var match_result: bool = str(current) == str(expected)
	return {"match": match_result, "property": prop, "current": _jsonify(current), "expected": _jsonify(expected)}


# ─── Visual ─────────────────────────────────────────────────────────────────

func _cmd_take_screenshot(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", "user://mcp_screenshot.png"))
	if not path.begins_with("user://") or ".." in path:
		return {"error": {"code": -1, "message": "Screenshot path must be user:// and contain no traversal"}}
	var viewport := get_viewport()
	var img := viewport.get_texture().get_image()
	var err := img.save_png(path)
	if err != OK:
		return {"error": {"code": -2, "message": "Failed to save screenshot: error %d" % err}}
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


# ─── Recording ───────────────────────────────────────────────────────────────

func _cmd_recording_start() -> Variant:
	if _recording:
		return {"error": {"code": -1, "message": "Recording already in progress"}}
	_recording = true
	_recorded_events = []
	_record_start_time = Time.get_ticks_msec()
	return {"status": "recording", "message": "Input events are being captured"}


func _cmd_recording_stop() -> Variant:
	if not _recording:
		return {"error": {"code": -1, "message": "No recording in progress"}}
	_recording = false
	var duration_ms: int = Time.get_ticks_msec() - _record_start_time
	var events: Array = _recorded_events.duplicate()
	_recorded_events = []
	return {"version": 1, "duration_ms": duration_ms, "events": events, "event_count": events.size()}


func _input(event: InputEvent) -> void:
	if not _recording:
		return
	var time_ms: int = Time.get_ticks_msec() - _record_start_time
	if event is InputEventKey:
		_recorded_events.append({"type": "key", "keycode": event.keycode, "pressed": event.pressed, "shift": event.shift_pressed, "ctrl": event.ctrl_pressed, "alt": event.alt_pressed, "time_ms": time_ms})
	elif event is InputEventMouseButton:
		_recorded_events.append({"type": "mouse_click", "position": [event.position.x, event.position.y], "button": event.button_index, "pressed": event.pressed, "time_ms": time_ms})
	elif event is InputEventMouseMotion:
		_recorded_events.append({"type": "mouse_move", "position": [event.position.x, event.position.y], "time_ms": time_ms})
