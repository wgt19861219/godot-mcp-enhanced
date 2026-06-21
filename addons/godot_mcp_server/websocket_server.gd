extends Node

const BASE_PORT := 9090
const MAX_PORT := 9094
const MAX_AUTH_FAILS := 5
const LOCKOUT_BASE_SECONDS := 30.0
const LOCKOUT_MAX_SECONDS := 300.0
const MAX_PEERS := 5
const MAX_MESSAGE_SIZE := 1048576  # 1MB

var _server: TCPServer
var _peers: Array[WebSocketPeer] = []
var _heartbeat: Node
var _command_handler: Node
var _current_port: int = 0
var _request_counter: int = 0
var _plugin: EditorPlugin
var _panel: Control = null
var _secret: String = ""
var _secret_file: String = ""
var _authenticated_peers: Dictionary = {}  # peer_id (int) -> true
var _auth_fail_count: Dictionary = {}
var _auth_locked_until: Dictionary = {}
var _crypto: Crypto

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func set_panel(panel: Control) -> void:
	_panel = panel
	# C-02: wire cancel callback to avoid hardcoded path in status_panel
	if panel.has_method("set_cancel_callback"):
		panel.set_cancel_callback(cancel_current_operation)

func _ready() -> void:
	_crypto = Crypto.new()
	_heartbeat = preload("heartbeat.gd").new()
	add_child(_heartbeat)
	_heartbeat.timeout_detected.connect(_on_heartbeat_timeout)

	_command_handler = preload("command_handler.gd").new()
	_command_handler.setup(_plugin)
	# E2 (review): plugin.gd:21 用 get_node_or_null("command_handler") 按名字查找做 cleanup,
	# 必须显式设 .name(否则 Godot 自动名不匹配 → cleanup 路径失效/死代码)。
	_command_handler.name = "command_handler"
	add_child(_command_handler)

	_generate_and_write_secret()
	_start_server()

func _generate_and_write_secret() -> void:
	# I-3 SECURITY: secret 明文写入 .godot/mcp_editor.key。Godot FileAccess 无权限参数(无法设 0600)。
	# 本地单用户开发场景可接受;多用户/共享主机需手动 chmod 0600(Linux/macOS)或 icacls 限制(Windows),
	# 否则同机其他用户可读 secret 导致本地提权。详见 CLAUDE.md bridge 规则“多用户环境不安全”。
	_secret = _generate_secret()
	if _secret.length() < 32:
		push_error("[MCP] Secret generation failed — WebSocket server will not start")
		_secret = ""
		return
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
		_restrict_secret_permissions(_secret_file)
		print("[MCP] Auth secret written to %s" % _secret_file)
	else:
		push_warning("[MCP] Failed to write auth secret to %s" % _secret_file)

# I-8: Godot FileAccess 无权限参数,secret 明文落盘。用 OS.execute 调系统命令收紧权限,
# 与 TS 端 instance-api-auth.ts 的 icacls/chmod 对齐(本地单用户默认安全,此为多用户加固)。
# I-2: TS 端用 os.userInfo().username 防环境变量伪造(C-ARC-01);Godot OS API 无等价 getUserInfo,
#      此处退回 get_environment("USERNAME")。威胁有限:攻击者需本机代码执行权限,而本机可执行即可直读 secret。
# I-1: OS.execute 退出码非零时 push_warning,避免权限收紧失败静默(可能 world-readable)。
# DUPLICATE: Keep in sync with src/scripts/mcp_bridge.gd:_restrict_secret_permissions
func _restrict_secret_permissions(path: String) -> void:
	var os_name := OS.get_name()
	var exit_code := 0  # I-1: 捕获 OS.execute 退出码,非零告警(避免权限收紧失败静默)
	if os_name == "Windows":
		var username := OS.get_environment("USERNAME")
		if username.is_empty():
			username = OS.get_environment("USER")
		# 严格白名单防 ACL 注入(用户名含 ;/空格等会破坏 icacls 参数),与 TS 端一致
		if username.is_empty() or not RegEx.create_from_string("^[A-Za-z0-9_-]+$").search(username):
			push_warning("[MCP] Cannot restrict secret permissions: username '%s' has unexpected chars" % username)
			return
		exit_code = OS.execute("icacls", PackedStringArray([path, "/inheritance:r", "/grant:r", "%s:R" % username]), [])
		if exit_code != 0:
			push_warning("[MCP] icacls failed (exit %d), secret may keep default permissions: %s" % [exit_code, path])
	elif os_name in ["Linux", "FreeBSD", "macOS"]:
		exit_code = OS.execute("chmod", PackedStringArray(["600", path]), [])
		if exit_code != 0:
			push_warning("[MCP] chmod failed (exit %d), secret may keep default permissions: %s" % [exit_code, path])

# DUPLICATE: Keep in sync with src/scripts/mcp_bridge.gd:_generate_secret
# Cannot share because editor plugin and game autoload have separate script contexts.
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
	if result.length() < 32:
		push_error("[MCP] Failed to generate 32-char secret after 11 attempts — refusing to start with weak key")
		return ""
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
	if _secret == "":
		push_error("[MCP] No valid auth secret — WebSocket server not started")
		return
	_server = TCPServer.new()
	for port in range(BASE_PORT, MAX_PORT + 1):
		if _server.listen(port, "127.0.0.1") == OK:
			_current_port = port
			print("[MCP] Listening on port %d" % port)
			_update_panel("MCP: Listening on port %d" % port)
			return
	push_error("[MCP] All ports (%d-%d) occupied" % [BASE_PORT, MAX_PORT])

func _process(delta: float) -> void:
	if not _server: return

	if _server.is_connection_available():
		var tcp_peer = _server.take_connection()

		if _peers.size() >= MAX_PEERS:
			tcp_peer.disconnect_from_host()
			push_warning("[MCP] Connection rejected: max peers reached (%d)" % MAX_PEERS)
			_update_panel("MCP: Rejected connection (%d/%d peers)" % [_peers.size(), MAX_PEERS])
			return

		var ws_peer = WebSocketPeer.new()
		ws_peer.set_inbound_buffer_size(MAX_MESSAGE_SIZE)
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
				var _pkt_count := 0
				while peer.get_available_packet_count() > 0 and _pkt_count < 50:
					var text = peer.get_packet().get_string_from_utf8()
					_handle_message(text, peer)
					_pkt_count += 1
					_heartbeat.reset_activity(peer.get_instance_id())
			WebSocketPeer.STATE_CLOSED:
				to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		var removed_peer = _peers[to_remove[i]]
		var rid: int = removed_peer.get_instance_id()
		_heartbeat.remove_peer(rid)
		_authenticated_peers.erase(rid)
		# I-9: 清除断开 peer 的 per-peer 锁定/失败记录,避免字典无限增长
		_auth_fail_count.erase(rid)
		_auth_locked_until.erase(rid)
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
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32002, "message": "Server auth not configured; connection rejected"}}))
			peer.close()
			return
		# I-9: per-peer lockout —— 用 pid(peer_id)隔离失败计数与锁定,而非全局 "localhost"。
		# 原全局键导致单个失败源(错误客户端/攻击者)5 次失败后锁死所有合法客户端 300s(可用性问题)。
		# per-peer 下失败连接自己被锁,不影响其他客户端;secret 为 256-bit 随机,暴力不可行,锁定仅减速。
		if _auth_locked_until.has(pid):
			var locked_until: float = _auth_locked_until[pid]
			if Time.get_ticks_msec() / 1000.0 < locked_until:
				peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32002, "message": "Too many auth failures, temporarily locked"}}))
				peer.close()
				return
			else:
				_auth_locked_until.erase(pid)
				_auth_fail_count[pid] = 0
		var provided: String = str(parsed.get("params", {}).get("secret", ""))
		if _constant_time_compare(provided, _secret):
			_authenticated_peers[pid] = true
			_auth_fail_count.erase(pid)
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"authenticated": true}}))
			print("[MCP] Peer %d authenticated" % pid)
			_send_session_sync(peer)
		else:
			var fails: int = int(_auth_fail_count.get(pid, 0)) + 1
			_auth_fail_count[pid] = fails
			if fails >= MAX_AUTH_FAILS:
				var lockout_time := minf(LOCKOUT_BASE_SECONDS * pow(2.0, (float(fails) / MAX_AUTH_FAILS) - 1.0), LOCKOUT_MAX_SECONDS)
				_auth_locked_until[pid] = Time.get_ticks_msec() / 1000.0 + lockout_time
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "Authentication failed"}}))
			peer.close()
		return

	# All other methods require authentication
	if _secret == "" or not _authenticated_peers.has(pid):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "Authentication required"}}))
		peer.close()
		return

	if parsed.get("method") == "operation_start":
		var timeout = parsed.get("params", {}).get("timeout", 300)
		# IMP-3: validate timeout — reject non-numeric, clamp to [1, 600] (heartbeat caps at 600)
		if not (timeout is int or timeout is float):
			timeout = 300
		timeout = clampf(float(timeout), 1.0, 600.0)
		_heartbeat.pause_for_operation(timeout, pid)  # C-01: pass peer_id for targeted timeout
		_update_panel("MCP: Operation in progress...")
		var _op_panel := _get_panel()
		if _op_panel: _op_panel.set_operation_active(true)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "operation_end":
		_heartbeat.resume()
		_update_panel("MCP: %d client(s) connected" % _peers.size())
		var _op_panel := _get_panel()
		if _op_panel: _op_panel.set_operation_active(false)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "request_sync":
		_send_session_sync(peer)
		return

	if parsed.get("method") == "ping":
		_heartbeat.reset_activity(peer.get_instance_id())
		return

	_request_counter = (_request_counter + 1) % 1000000
	var response = _command_handler.handle(parsed.get("method", ""), parsed.get("params", {}), _request_counter)
	if response == null or not response is Dictionary:
		push_warning("[MCP] command_handler returned null/non-dict for method: %s" % parsed.get("method", ""))
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32603, "message": "Internal error: handler returned invalid response"}}))
		return
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

func send_mcp_notification(method: String, params: Dictionary) -> void:
	# G-C-03 fix: command_handler.send_notification 经 has_method 守卫转发到此;
	# 此前方法不存在 → sync 的 node_added/node_removed 通知被静默丢弃。
	# 广播 JSON-RPC notification 给所有已认证且 OPEN 的 peer。
	var msg := JSON.stringify({"jsonrpc": "2.0", "method": method, "params": params})
	for peer in _peers:
		if peer.get_ready_state() == WebSocketPeer.STATE_OPEN and _authenticated_peers.has(peer.get_instance_id()):
			# M-3: 检查返回值,单 peer 发送失败不中断广播循环
			var _send_err := peer.send_text(msg)
			if _send_err != OK:
				push_warning("[MCP] send_mcp_notification send_text failed (err=%d)" % _send_err)


func _on_heartbeat_timeout(peer_id: int) -> void:
	push_warning("[MCP] Heartbeat timeout (peer_id: %d)" % peer_id)
	_update_panel("MCP: Connection timeout!")
	if peer_id == -1:
		for peer in _peers:
			peer.close()
	else:
		for peer in _peers:
			if peer.get_instance_id() == peer_id:
				peer.close()
				break

func cancel_current_operation() -> void:
	_heartbeat.resume()
	_update_panel("MCP: Operation cancelled")
	for peer in _peers:
		peer.send_text(JSON.stringify({"method": "operation_cancelled", "params": {}}))

func _update_panel(text: String) -> void:
	var panel = _get_panel()
	if panel: panel.update_status(text)

func _get_panel() -> Node:
	if _panel and is_instance_valid(_panel):
		return _panel
	return null

# DUPLICATE: Keep in sync with src/scripts/mcp_bridge.gd:_constant_time_compare
# Cannot share because editor plugin and game autoload have separate script contexts.
# C-05: Fixed-length comparison (always 32 bytes) to prevent timing side-channel.
func _constant_time_compare(a: String, b: String) -> bool:
	const SECRET_LEN := 32
	# Reject early if lengths differ — avoids leaking length info through
	# branch-prediction timing inside the loop.
	if a.length() != SECRET_LEN or b.length() != SECRET_LEN:
		return false
	var result := 0
	for i in range(SECRET_LEN):
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
	_auth_fail_count.clear()
	_auth_locked_until.clear()
	_delete_secret_file()
