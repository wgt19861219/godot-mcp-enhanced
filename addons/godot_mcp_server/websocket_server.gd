extends Node

const BASE_PORT := 9090
const MAX_PORT := 9094

var _server: TCPServer
var _peers: Array[WebSocketPeer] = []
var _heartbeat: Node
var _command_handler: Node
var _current_port: int = 0
var _request_counter: int = 0
var _plugin: EditorPlugin
var _secret: String = ""
var _secret_file: String = ""
var _authenticated_peers: Dictionary = {}  # peer_id (int) -> true
var _crypto: Crypto

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func _ready() -> void:
	_crypto = Crypto.new()
	_heartbeat = preload("heartbeat.gd").new()
	add_child(_heartbeat)
	_heartbeat.timeout_detected.connect(_on_heartbeat_timeout)

	_command_handler = preload("command_handler.gd").new()
	_command_handler.setup(_plugin)
	add_child(_command_handler)

	_generate_and_write_secret()
	_start_server()

func _generate_and_write_secret() -> void:
	_secret = _generate_secret()
	var project_dir: String = _get_project_dir()
	if project_dir == "":
		push_warning("[MCP] Cannot determine project dir; editor auth disabled")
		return
	var godot_dir: String = project_dir.path_join(".godot")
	var dir := DirAccess.open(project_dir)
	if dir and not dir.dir_exists(".godot"):
		dir.make_dir(".godot")
	_secret_file = godot_dir.path_join("mcp_editor.key")
	var f := FileAccess.open(_secret_file, FileAccess.WRITE)
	if f:
		f.store_string(_secret)
		f.close()
		print("[MCP] Auth secret written to %s" % _secret_file)
	else:
		push_warning("[MCP] Failed to write auth secret to %s" % _secret_file)

func _generate_secret() -> String:
	var chars := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var result := ""
	var rng_bytes: PackedByteArray = _crypto.generate_random_bytes(64)
	var idx := 0
	while result.length() < 32 and idx < rng_bytes.size():
		var b: int = rng_bytes[idx]
		idx += 1
		if b >= 256 - (256 % chars.length()):
			continue
		result += chars[b % chars.length()]
	var fallback := 0
	while result.length() < 32 and fallback < 10:
		rng_bytes = _crypto.generate_random_bytes(64)
		idx = 0
		fallback += 1
		while result.length() < 32 and idx < rng_bytes.size():
			var b2: int = rng_bytes[idx]
			idx += 1
			if b2 >= 256 - (256 % chars.length()):
				continue
			result += chars[b2 % chars.length()]
	assert(result.length() == 32, "Failed to generate 32-char secret")
	return result

func _get_project_dir() -> String:
	var res_root: String = ProjectSettings.globalize_path("res://")
	if res_root != "":
		return res_root.rstrip("/")
	return ""

func _delete_secret_file() -> void:
	if _secret_file != "" and FileAccess.file_exists(_secret_file):
		DirAccess.remove_absolute(_secret_file)
		print("[MCP] Auth secret file deleted")
	_secret_file = ""
	_secret = ""

func _start_server() -> void:
	_server = TCPServer.new()
	for port in range(BASE_PORT, MAX_PORT + 1):
		if _server.listen(port) == OK:
			_current_port = port
			print("[MCP] Listening on port %d" % port)
			_update_panel("MCP: Listening on port %d" % port)
			return
	push_error("[MCP] All ports (%d-%d) occupied" % [BASE_PORT, MAX_PORT])

func _process(delta: float) -> void:
	if not _server: return

	if _server.is_connection_available():
		var tcp_peer = _server.take_connection()
		var ws_peer = WebSocketPeer.new()
		ws_peer.accept_stream(tcp_peer)
		_peers.append(ws_peer)
		print("[MCP] Client connected (total: %d)" % _peers.size())
		_update_panel("MCP: %d client(s) connected" % _peers.size())

	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var peer = _peers[i]
		peer.poll()
		match peer.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				_heartbeat.tick(delta, peer)
				while peer.get_available_packet_count() > 0:
					var text = peer.get_packet().get_string_from_utf8()
					_handle_message(text, peer)
					_heartbeat.reset_activity(peer.get_instance_id())
			WebSocketPeer.STATE_CLOSED:
				to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		var removed_peer = _peers[to_remove[i]]
		var rid: int = removed_peer.get_instance_id()
		_heartbeat.remove_peer(rid)
		_authenticated_peers.erase(rid)
		_peers.remove_at(to_remove[i])
		print("[MCP] Client disconnected")

func _handle_message(text: String, peer: WebSocketPeer) -> void:
	var pid: int = peer.get_instance_id()

	var parsed = JSON.parse_string(text)
	if not parsed or not parsed.has("jsonrpc"):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid JSON-RPC"}}))
		return

	# Auth endpoint — always allowed
	if parsed.get("method") == "auth":
		if _secret == "":
			# No secret configured (couldn't write file); skip auth
			_authenticated_peers[pid] = true
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"authenticated": true}}))
			_send_session_sync(peer)
			return
		var provided: String = str(parsed.get("params", {}).get("secret", ""))
		if _constant_time_compare(provided, _secret):
			_authenticated_peers[pid] = true
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"authenticated": true}}))
			print("[MCP] Peer %d authenticated" % pid)
			_send_session_sync(peer)
		else:
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "Authentication failed"}}))
			peer.close()
		return

	# All other methods require authentication
	if _secret != "" and not _authenticated_peers.has(pid):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "Authentication required"}}))
		peer.close()
		return

	if parsed.get("method") == "operation_start":
		var timeout = parsed.get("params", {}).get("timeout", 300)
		_heartbeat.pause_for_operation(timeout)
		_update_panel("MCP: Operation in progress...")
		_get_panel().set_operation_active(true)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "operation_end":
		_heartbeat.resume()
		_update_panel("MCP: %d client(s) connected" % _peers.size())
		_get_panel().set_operation_active(false)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "request_sync":
		_send_session_sync(peer)
		return

	if parsed.get("method") == "ping":
		_heartbeat.reset_activity(peer.get_instance_id())
		return

	_request_counter += 1
	var response = _command_handler.handle(parsed.get("method", ""), parsed.get("params", {}), _request_counter)
	var reply = {"jsonrpc": "2.0", "id": parsed.get("id")}
	if response.has("error"):
		reply["error"] = response.error
	else:
		reply["result"] = response.result
	peer.send_text(JSON.stringify(reply))

func _send_session_sync(peer: WebSocketPeer) -> void:
	var open_scenes: Array = []
	if _plugin:
		var ei = _plugin.get_editor_interface()
		open_scenes = ei.get_open_scenes()
	peer.send_text(JSON.stringify({"method": "session_resync", "params": {"open_scenes": open_scenes}}))

func _on_heartbeat_timeout() -> void:
	push_warning("[MCP] Heartbeat timeout")
	_update_panel("MCP: Connection timeout!")

func cancel_current_operation() -> void:
	_heartbeat.resume()
	_update_panel("MCP: Operation cancelled")
	for peer in _peers:
		peer.send_text(JSON.stringify({"method": "operation_cancelled", "params": {}}))

func _update_panel(text: String) -> void:
	var panel = _get_panel()
	if panel: panel.update_status(text)

func _get_panel() -> Node:
	return get_node_or_null("../../../../../MCP")

func _constant_time_compare(a: String, b: String) -> bool:
	if a.length() != b.length():
		return false
	var result := 0
	for i in range(a.length()):
		result = result | (ord(a[i]) ^ ord(b[i]))
	return result == 0

func _exit_tree() -> void:
	set_process(false)
	if _heartbeat:
		_heartbeat.timeout_detected.disconnect(_on_heartbeat_timeout)
	if _server: _server.stop()
	for peer in _peers: peer.close()
	_peers.clear()
	_authenticated_peers.clear()
	_delete_secret_file()
