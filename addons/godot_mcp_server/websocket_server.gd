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
# 3A (2026-09-19 安全加固批3): challenge-response 握手的 per-peer 待验证 challenge
# (peer_id -> String)。auth_begin 生成,auth_proof 消费(成功/断开即清)。
var _auth_challenges: Dictionary = {}
var _crypto: Crypto
# A2 (2026-08-11 审查 P1:debug 异步请求竞争共享 _states):debug 请求 in-flight 互斥。
# _handle_message 由 _process 轮询同步调,debug coroutine await 挂起后循环继续处理下个
# packet → 两个并发 evaluate/inspect_frame 竞争同一 _states[session_id](eval_result 单槽
# 被后发者重置/错消费,selected_frame 互相覆盖),AI 拿串台数据且无报错。
# 同一时刻只允许一个在途 debug coroutine;新的 debug 请求到达时若在途则立即拒绝。
# stale 自愈:超时兜底见 I-4(2026-08-15 实测修正:handler **内部** script error 时
# GDScript 会以函数返回类型默认值({})恢复 await 侧,互斥锁释放行仍会执行;真正卡死的是
# 本协程**自身函数体**在 set/release 之间出错——批 H 修复前 response.result 点访问即此类,
# 该行已改为 get() 兜底,窗口仅剩 set 与 release 之间无其他语句。stale 释放保留作末道兜底)。
const DEBUG_IN_FLIGHT_STALE_MS := 120000
# I-4 (2026-08-14 审查 P3): debug 协程挂死(hang)兜底 watch(见 _await_with_watchdog)。
# 修复面(2026-08-15 headless probe 实测定性):① handler 内部 script error → GDScript
# 以返回类型默认值({})恢复 caller,现有 reply 路径发 {"result": null},client 不挂——
# 此类不靠 watchdog;② handler **挂死**(await 的信号永不触发、内部循环失去界)→ caller
# 的 await 永不恢复 → reply 永不发(client 干等默认 30s)+ 互斥锁卡到 stale 120s——
# 此类是 watchdog 的修复目标。debug 现有 handler 全为有界循环(settle 700ms/evaluate 3s/
# step 2s,最大 ~4s),watchdog=10s 正常路径零触发,仅兜未来引入的无界 await。
const DEBUG_ASYNC_WATCHDOG_MS := 10000
# I-5 (2026-08-14 审查 P3): WebSocket 握手超时。TCP 已 accept 但握手永不完成的 peer
# (端口扫描/裸 TCP 客户端连上不发 HTTP Upgrade)停留在 STATE_CONNECTING,原 match 只
# 处理 OPEN/CLOSED → 不 tick 不移除,永久占 MAX_PEERS=5 槽(5 个即拒绝新连接)。
# 10s > 正常本机握手(毫秒级)3 个量级,超时即 close + 回收槽位。
const WS_HANDSHAKE_TIMEOUT_MS := 10000
var _debug_in_flight := false
var _debug_in_flight_since := 0
# I-5: peer 进入 STATE_CONNECTING 的起始时刻(peer instance id → msec),握手完成/移除时清。
var _connecting_since: Dictionary = {}
# P4-2 (2026-09-11) 失焦降速对抗(beckett 轻量版):编辑器失焦时 Godot 主循环 sleep 提到
# unfocused_low_processor_mode_sleep_usec(默认 ~100ms ≈ 10fps),_process 轮询跟着掉速——
# 而编辑器失焦恰是 MCP 会话常态(人在聊天窗口)。有 MCP 流量时 clamp 进程级
# OS.low_processor_usage_mode_sleep_usec 到 60fps,空闲 10s 后恢复原值(进程级运行时变量,
# 无持久化零恢复负担)。诚实边界:效果依赖 OS.low_processor_usage_mode 开启(编辑器默认开);
# 不碰 EditorSettings 的 unfocused_* 机器级配置(NPGameDev 全量版才走,需备份+自愈全套)。
const FOCUS_BOOST_SLEEP_USEC := 16666  # 60fps
const FOCUS_IDLE_TIMEOUT_MS := 10000
var _focus_boost_until_ms := 0
var _focus_saved_sleep_usec := -1  # -1 = 未在 boost 期(原值未存)

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
	var project_dir: String = _get_project_dir()
	if project_dir == "":
		push_warning("[MCP] Cannot determine project dir; editor auth disabled")
		return
	var godot_dir: String = project_dir.path_join(".godot")
	var dir := DirAccess.open(project_dir)
	if dir and not dir.dir_exists(".godot"):
		dir.make_dir(".godot")
	_secret_file = godot_dir.path_join("mcp_editor.key")
	# S4-editor: 固定 secret 模式(本地测试, env GODOT_MCP_EDITOR_PERSISTENT_SECRET=true)。
	# mcp_editor.key 存在且有效则复用,跳过重生+写入+_restrict,打破"重生→覆盖写→
	# MCP 端 TTL 缓存不同步"窗口(对称 bridge mcp_bridge.gd:216-226 S4)。默认 false。
	# 不调 _start_server — 由 _ready:49 统一调(避免双重调用致 TCPServer 孤儿)。
	var _persistent_secret := OS.get_environment("GODOT_MCP_EDITOR_PERSISTENT_SECRET").to_lower() == "true"
	if _persistent_secret and FileAccess.file_exists(_secret_file):
		var _existing := FileAccess.get_file_as_string(_secret_file)
		if _existing.length() >= 32:
			_secret = _existing
			print("[MCP] Reusing persistent editor secret (GODOT_MCP_EDITOR_PERSISTENT_SECRET=true)")
			return
	_secret = _generate_secret()
	if _secret.length() < 32:
		push_error("[MCP] Secret generation failed — WebSocket server will not start")
		_secret = ""
		return
	# Windows: FileAccess.close 走 atomic rename(drivers/windows/file_access_windows.cpp:276, Godot #40366),
	# 杀软拦 rename → "Safe save failed" 红字(非致命但误导用户)。改用 PowerShell WriteAllText 直接写绕开。
	# 配合 _restrict_secret_permissions 用 icacls USERNAME:M + /inheritance:r(USERNAME Modify、其他用户无权限,
	# 比 USERNAME:R 更合理——R 是 anti-pattern: addon 以 USERNAME 身份却要覆盖自己只读的 key,
	# 只能靠 atomic rename 绕 ACL,正是红字根源)。secret 经环境变量传递(不经命令行暴露,见 I-3)。
	# Linux/macOS 的 FileAccess.close 不走 atomic,直接用。
	# SEC-P2-2 (2026-08-09 审查): 写前 symlink 预检。攻击者预置 .godot/mcp_editor.key 为 symlink
	# 指向任意文件,WriteAllText/FileAccess.open 均 follow symlink 覆盖目标文件。读方 editor-auth.ts
	# 已有 lstatSync 兜底(命中 symlink 降级 headless),此处写方对称加固防 follow 写目标。
	# 与 src/scripts/mcp_bridge.gd:_write_secret_to_file DUPLICATE 同步。
	var write_ok := false
	if OS.get_name() == "Windows":
		OS.set_environment("_MCP_SECRET_TMP", _secret)
		OS.set_environment("_MCP_SECRET_PATH", _secret_file)
		# F-1(2026-07-04 审查): path 经 env 传递($env:_MCP_SECRET_PATH),不字面拼接进 PowerShell
		# 单引号字符串 —— 项目目录名含 ' 即可逃逸注入任意命令。env 值不解析为命令语法,注入消失。
		# F-2(2026-07-04 审查): OS.execute 第五参 false=non-blocking,返回 fork 启动状态非 exit code,
		# write_ok=(ec==OK) 乐观判断可能误报成功。去 false(blocking 默认 true),ec 是真实 exit code。
		# SEC-P2-2: exit 3 = symlink 拒写(WriteAllText 不执行);Test-Path 守 Get-Item 防首次生成不存在时抛错。
		var ps_args := PackedStringArray(["-NoProfile", "-Command", "if (Test-Path $env:_MCP_SECRET_PATH) { if ((Get-Item -LiteralPath $env:_MCP_SECRET_PATH -Force).LinkType) { exit 3 } }; [IO.File]::WriteAllText($env:_MCP_SECRET_PATH, $env:_MCP_SECRET_TMP)"])
		var ec := OS.execute("powershell", ps_args, [])
		OS.unset_environment("_MCP_SECRET_TMP")
		OS.unset_environment("_MCP_SECRET_PATH")
		if ec == 3:
			# symlink 命中:不 fallback FileAccess(同样 follow symlink),标 secret 失败禁 WS 启动
			push_warning("[MCP] %s is a symlink — refusing to write editor secret" % _secret_file)
			_secret = ""
			return
		write_ok = (ec == OK)
		if not write_ok:
			push_warning("[MCP] PowerShell write failed (exit %d), fallback to FileAccess" % ec)
	else:
		# SEC-P2-2: readlink 成功(exit 0)= 是 symlink;失败(非零)= 普通文件或不存在。
		# GD 无原生 symlink 检测 API(FileAccess/DirAccess 均无 LinkType 等价),借 readlink。
		if FileAccess.file_exists(_secret_file):
			var rl_ec := OS.execute("readlink", PackedStringArray([_secret_file]), [])
			if rl_ec == OK:
				push_warning("[MCP] %s is a symlink — refusing to write editor secret" % _secret_file)
				_secret = ""
				return
		var f := FileAccess.open(_secret_file, FileAccess.WRITE)
		if f:
			f.store_string(_secret)
			f.close()
			write_ok = true
	if write_ok:
		_restrict_secret_permissions(_secret_file)
		print("[MCP] Auth secret written to %s" % _secret_file)
	else:
		# Windows 末级 fallback: FileAccess(会触发 Safe save 红字但 key 写成功)
		var f2 := FileAccess.open(_secret_file, FileAccess.WRITE)
		if f2:
			f2.store_string(_secret)
			f2.close()
			_restrict_secret_permissions(_secret_file)
			print("[MCP] Auth secret written to %s (FileAccess fallback)" % _secret_file)
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
		# USERNAME:M(Modify) + /inheritance:r(移除继承,其他用户无 ACE 无权限)。
		# 原 USERNAME:R 是 anti-pattern: addon 以 USERNAME 身份运行却要覆盖自己只读的 key,
		# 只能靠 FileAccess atomic rename 绕 ACL → 触发 "Safe save failed" 红字(Godot #40366)。
		# M 让 _generate_and_write_secret 的 PowerShell WriteAllText 能直接覆盖写,其他用户仍无权限(比 R 更严)。
		exit_code = OS.execute("icacls", PackedStringArray([path, "/inheritance:r", "/grant:r", "%s:M" % username]), [])
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
	# S4-editor: 固定 secret 模式不删(持久化供下次启动复用 + 与 MCP 端 TTL 缓存保持同步)。
	# 对称 bridge mcp_bridge.gd:441-443。
	var _persistent_secret := OS.get_environment("GODOT_MCP_EDITOR_PERSISTENT_SECRET").to_lower() == "true"
	if _persistent_secret:
		return
	if _secret_file != "" and FileAccess.file_exists(_secret_file):
		var on_disk := FileAccess.get_file_as_string(_secret_file)
		# 多 editor 实例共享同一固定路径 mcp_editor.key。本实例退出只删自己生成的 key,
		# 避免误删仍存活实例的 key(实例 A _exit_tree 不应清掉实例 B 的 secret 文件)。
		# on_disk 读失败(权限/IO)时 FileAccess 返 "" != _secret → 不删(安全侧:宁可暂留也不误删)。
		if on_disk == _secret:
			DirAccess.remove_absolute(_secret_file)
			print("[MCP] Auth secret file deleted")
		else:
			push_warning("[MCP] Secret file content mismatch — belongs to another instance; not deleted: %s" % _secret_file)
	_secret_file = ""
	_secret = ""

func _start_server() -> void:
	if _secret == "":
		push_error("[MCP] No valid auth secret — WebSocket server not started")
		return
	_server = TCPServer.new()
	for port in range(BASE_PORT, MAX_PORT + 1):
		# P2-13(2026-08-21 七维度审核): listen 错误码测不出 Windows 双 bind 假成功
		# (listen 返 OK 但流量全到先占实例)——listen 前先 connect 预探测,
		# 对齐 mcp_bridge.gd _bind_available_port 的 A1 缓解。
		if _port_in_use(port):
			print("[MCP] Port %d already served by another instance, trying %d" % [port, port + 1])
			continue
		if _server.listen(port, "127.0.0.1") == OK:
			_current_port = port
			print("[MCP] Listening on port %d" % port)
			_update_panel("MCP: Listening on port %d" % port)
			return
	push_error("[MCP] All ports (%d-%d) occupied" % [BASE_PORT, MAX_PORT])

## connect 探测端口是否已有服务在听(与 mcp_bridge.gd _port_in_use 同款)。
## localhost 连非监听端口立即 REFUSED(ms 级);poll 必须显式调——缺 poll 时
## get_status 恒停留 CONNECTING,探测形同虚设(bridge 侧 e2e 实测教训)。
func _port_in_use(port: int) -> bool:
	var probe := StreamPeerTCP.new()
	probe.connect_to_host("127.0.0.1", port)
	for i in 20:  # 最多 ~100ms 等待连接结果
		probe.poll()
		var status := probe.get_status()
		if status == StreamPeerTCP.STATUS_CONNECTED:
			probe.disconnect_from_host()
			return true
		if status == StreamPeerTCP.STATUS_ERROR:
			break
		OS.delay_msec(5)
	probe.disconnect_from_host()
	return false

func _process(delta: float) -> void:
	# P1-5 fix: _exit_tree 后残留 deferred _process 调用时 _server 可能已 stop/free, is_instance_valid 守卫防误用
	if not _server or not is_instance_valid(_server): return
	_update_focus_boost()

	if _server.is_connection_available():
		var tcp_peer = _server.take_connection()

		if _peers.size() >= MAX_PEERS:
			tcp_peer.disconnect_from_host()
			push_warning("[MCP] Connection rejected: max peers reached (%d)" % MAX_PEERS)
			_update_panel("MCP: Rejected connection (%d/%d peers)" % [_peers.size(), MAX_PEERS])
			return

		var ws_peer = WebSocketPeer.new()
		ws_peer.set_inbound_buffer_size(MAX_MESSAGE_SIZE)
		ws_peer.set_outbound_buffer_size(4 * 1024 * 1024)  # F4(2026-07-29): 4MB outbound 上限防慢消费者堆积 OOM
		ws_peer.accept_stream(tcp_peer)
		_peers.append(ws_peer)
		# I-5: 记录握手起始时刻(CONNECTING 超时判定的基准)
		_connecting_since[ws_peer.get_instance_id()] = Time.get_ticks_msec()
		_mark_focus_traffic()  # P4-2: 新连接即流量
		print("[MCP] Client connected (total: %d)" % _peers.size())
		_update_panel("MCP: %d client(s) connected" % _peers.size())

	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var peer = _peers[i]
		peer.poll()
		match peer.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				# I-5: 握手完成,清 CONNECTING 计时
				_connecting_since.erase(peer.get_instance_id())
				_heartbeat.tick(delta, peer)
				var _pkt_count := 0
				while peer.get_available_packet_count() > 0 and _pkt_count < 50:
					var text = peer.get_packet().get_string_from_utf8()
					_handle_message(text, peer)
					_pkt_count += 1
					_heartbeat.reset_activity(peer.get_instance_id())
			WebSocketPeer.STATE_CONNECTING:
				# I-5 (2026-08-14 审查 P3): 握手超时回收槽位(见 WS_HANDSHAKE_TIMEOUT_MS 注释)。
				var cid: int = peer.get_instance_id()
				if not _connecting_since.has(cid):
					_connecting_since[cid] = Time.get_ticks_msec()
				if Time.get_ticks_msec() - int(_connecting_since[cid]) > WS_HANDSHAKE_TIMEOUT_MS:
					push_warning("[MCP] Peer %d WebSocket handshake not completed within %dms — closing (slot reclaimed)" % [cid, WS_HANDSHAKE_TIMEOUT_MS])
					peer.close()
					to_remove.append(i)
			WebSocketPeer.STATE_CLOSED:
				to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		var removed_peer = _peers[to_remove[i]]
		var rid: int = removed_peer.get_instance_id()
		_heartbeat.remove_peer(rid)
		_authenticated_peers.erase(rid)
		_connecting_since.erase(rid)
		# I-9: 清除断开 peer 的 per-peer 锁定/失败记录,避免字典无限增长
		_auth_fail_count.erase(rid)
		_auth_locked_until.erase(rid)
		_auth_challenges.erase(rid)  # 3A: 断开即弃 challenge(单连接单次有效)
		_peers.remove_at(to_remove[i])
		print("[MCP] Client disconnected")

func _handle_message(text: String, peer: WebSocketPeer) -> void:
	_mark_focus_traffic()  # P4-2: 入站消息即流量(出站响应必随入站请求,RPC 模式流量对齐)
	var pid: int = peer.get_instance_id()

	var parsed = JSON.parse_string(text)
	# 全仓审查 GD I-5 (2026-09-12): 顶层标量 JSON("123"/1.5/"x")经 parse_string 返回
	# int/float/String——无 has() 方法,原 `not parsed.has(...)` 触发运行时错误中断
	# _handle_message → 外层 _process 当帧中断,同帧所有 peer 的 poll/heartbeat 跳过;
	# 无需认证即可持续发送标量帧实质瘫痪 WS 服务。对齐 bridge 侧 _handle_message 的
	# `not (parsed is Dictionary)` 正确写法(369-374 的 C3 修过 params 侧同源问题)。
	if not (parsed is Dictionary) or not parsed.has("jsonrpc"):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid JSON-RPC"}}))
		return

	# security P2#1 fix: params 非 Dictionary 防御(防畸形输入致 handle 内 params.get 报错中断帧处理, 多 peer 互影响)
	# C3: null params 也 reject（旧 `!= null and not` 短路放行 null → 命中 handle 强类型 Dictionary → SCRIPT ERROR 中断帧 packet 循环）
	var _rpc_params = parsed.get("params", {})
	if _rpc_params == null or not (_rpc_params is Dictionary):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32602, "message": "Invalid params: must be an object"}}))
		return
	# 3A (2026-09-19 安全加固批3): challenge-response 握手——secret 不上线路。
	# auth_begin: 发随机 challenge(per-peer 单次);auth_proof: HMAC-SHA256(secret, challenge)
	# 恒时比较。旧 method=auth 明文通道保留(下分支,旧 TS 兼容)——假监听者先占端口只能
	# 收到 HMAC(对单次 challenge 有效),拿不到 secret 本身,无法连真插件横向复用。
	# 锁定检查对三个认证方法共用(与 auth 同款 per-peer 指数锁定,I-9)。
	var _auth_method: Variant = parsed.get("method")
	if _auth_method == "auth_begin" or _auth_method == "auth_proof" or _auth_method == "auth":
		if _auth_locked_until.has(pid):
			var _al_locked_until: float = _auth_locked_until[pid]
			if Time.get_ticks_msec() / 1000.0 < _al_locked_until:
				peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32002, "message": "Too many auth failures, temporarily locked"}}))
				peer.close()
				return
			else:
				_auth_locked_until.erase(pid)
				_auth_fail_count[pid] = 0
	if _auth_method == "auth_begin":
		if _secret == "":
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32002, "message": "Server auth not configured; connection rejected"}}))
			peer.close()
			return
		var cr_challenge: String = _crypto.generate_random_bytes(16).hex_encode()
		_auth_challenges[pid] = cr_challenge
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"challenge": cr_challenge}}))
		return
	if _auth_method == "auth_proof":
		if not _auth_challenges.has(pid):
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "No pending challenge; send auth_begin first"}}))
			peer.close()
			return
		# HMAC-SHA256(secret, challenge) hex —— key/msg 均 UTF-8 bytes,输出小写 hex(与 TS 侧 createHmac 对齐)
		var cr_expected: String = _crypto.hmac_digest(HashingContext.HASH_SHA256, _secret.to_utf8_buffer(), String(_auth_challenges[pid]).to_utf8_buffer()).hex_encode()
		var cr_provided: String = str(parsed.get("params", {}).get("proof", ""))
		if _constant_time_compare_varlen(cr_provided, cr_expected):
			_authenticated_peers[pid] = true
			_auth_challenges.erase(pid)
			_auth_fail_count.erase(pid)
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"authenticated": true}}))
			print("[MCP] Peer %d authenticated (challenge-response)" % pid)
			_send_session_sync(peer)
		else:
			var cr_fails: int = int(_auth_fail_count.get(pid, 0)) + 1
			_auth_fail_count[pid] = cr_fails
			if cr_fails >= MAX_AUTH_FAILS:
				var cr_lockout: float = minf(LOCKOUT_BASE_SECONDS * pow(2.0, (float(cr_fails) / MAX_AUTH_FAILS) - 1.0), LOCKOUT_MAX_SECONDS)
				_auth_locked_until[pid] = Time.get_ticks_msec() / 1000.0 + cr_lockout
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32001, "message": "Authentication failed"}}))
			peer.close()
		return
	# Auth endpoint — always allowed
	if _auth_method == "auth":
		if _secret == "":
			peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32002, "message": "Server auth not configured; connection rejected"}}))
			peer.close()
			return
		# 锁定检查已前置(与 auth_begin/auth_proof 共用,3A);此处仅明文 secret 比较(旧 TS 兼容)
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
		_heartbeat.resume(pid)  # P1#1 fix: per-peer resume
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
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))  # ipc P0-2 fix: ping 回响应
		return

	_request_counter = (_request_counter + 1) % 1000000
	var _method: String = parsed.get("method", "")
	var response: Dictionary
	if _method.begins_with("nav_"):
		# A-lite: nav 走 async 入口（spec §3）。packet 循环不 await 本 coroutine——
		# 挂起期间循环继续处理下个 packet（非 nav 当帧 reply），nav reply 在 bake 完成后自行恢复发。
		# 并发 nav 请求允许（packet 循环不串行化）：同 peer 多 nav bake 时，先完成的 coroutine 发的
		# operation_end 可能抢先于仍在 bake 的其他 coroutine 恢复心跳；heartbeat P1#3 hard timeout
		# 兜底（heartbeat.gd:37-46）防误断（operation_end 仅递减计数，非强制立即恢复）。
		# I-4 (2026-08-14 审查 P3): 此路径**不**加 script-error watchdog——nav 协程有内部
		# deadline(bake_mesh 110s == TS client timeoutMs 110s,create_region 28s < client 30s),
		# 正常路径必在 deadline 内自行返回;提前发兜底 error reply 会与迟到的真实 reply 双发,
		# 而 ≥110s 的 watchdog 对 client 已无增益(同刻 client 已超时,§10 peer 守卫兜底丢 reply)。
		response = await _command_handler.handle_nav_async(_method, parsed.get("params", {}), _request_counter)
	elif _method == "test_run":
		# P2-12 phase 2: test_run 走 async 入口（防 WS keepalive 饿死）。suite 内每 test 后
		# await get_tree().process_frame 让出主循环，heartbeat.tick 照常 ping + packet 照常 drain。
		# test_manage 保持同步（秒级 results_get，走 else 分支 handle()）。
		# client 用 290s timeoutMs（EditorToolExecutor isTestRun 分支）大幅降低 orphan 概率
		# （优于 nav_bake 默认 30s），但极端超 290s 仍会 orphan，§10 peer 守卫兜底丢 reply。
		# I-4 (2026-08-14 审查 P3): 同 nav 不加 watchdog——test_run 无内部上界(suite 数×单
		# suite 耗时不可预估,290s 只是 TS 侧预算),任何固定 watchdog 都可能在合法长 suite 上
		# 与迟到的真实 reply 双发。script error 时维持文档化限制(client 290s 超时兜底)。
		response = await _command_handler.handle_test_async(_method, parsed.get("params", {}), _request_counter)
	elif _method.begins_with("debug_") and _method not in ["debug_set_breakpoint", "debug_clear_breakpoint", "debug_list_breakpoints"]:
		# CMP-14 (2026-08-09): debug Phase 2/3 走 async 入口(信号+settle 轮询)。
		# Phase 1 三个断点 method(set/clear/list)保持同步(gutter 操作无需 async)。
		# 栈帧/变量/step/reload 需 await settle 或 await_new_break,走 coroutine 防饿死 WS keepalive。
		# A2: debug 协程共享 debugger_bridge._states(eval_result 单槽/selected_frame),
		# 并发在途会串台 —— in-flight 互斥,新请求在互斥窗内直接拒绝(非排队,客户端重试即可)。
		if _debug_in_flight and Time.get_ticks_msec() - _debug_in_flight_since < DEBUG_IN_FLIGHT_STALE_MS:
			response = {"error": {"code": -32000, "message": "Another debug request is already in flight (debugger requests are serialized — shared breakpoint state would otherwise cross-contaminate). Retry after it completes."}}
		else:
			if _debug_in_flight:
				push_warning("[MCP] debug in-flight flag stale for %d ms (coroutine aborted by script error?) — releasing" % (Time.get_ticks_msec() - _debug_in_flight_since))
			_debug_in_flight = true
			_debug_in_flight_since = Time.get_ticks_msec()
			# I-4 (2026-08-14 审查 P3): debug 协程挂死兜底。经 _await_with_watchdog 把
			# handler fire-and-forget 隔离:handler **挂死**(await 永不恢复)时本协程
			# 的轮询仍活着,10s 到点返 error reply + 执行到下方释放行(互斥锁不再卡
			# 120s stale)。handler 内部 script error 的行为(2026-08-15 实测)是 caller
			# 以类型默认值 {} 恢复——box 立即填充,watchdog 零触发,走既有 reply 路径。
			# watchdog=10s > debug handler 内部上界之和(evaluate 3s/step 2s+settle
			# 700ms,最大 ~4s),正常路径零触发。
			response = await _await_with_watchdog(
				Callable(_command_handler, "handle_debug_async").bind(_method, parsed.get("params", {}), _request_counter),
				DEBUG_ASYNC_WATCHDOG_MS, _method)
			# coroutine 恢复后立即释放(在 §10 peer 守卫之前,无论 peer 是否还在都释放;
			# I-4 后挂死超时路径同样到达此行——互斥锁不再依赖 120s stale 自愈)
			_debug_in_flight = false
	else:
		response = _command_handler.handle(_method, parsed.get("params", {}), _request_counter)
	# §10 peer 生命周期守卫：coroutine 恢复时 peer 可能已 CLOSED/被 free
	if not is_instance_valid(peer) or peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		push_warning("[MCP] nav coroutine resumed but peer gone (method=%s), reply dropped" % _method)
		return
	if response == null or not response is Dictionary:
		push_warning("[MCP] command_handler returned null/non-dict for method: %s" % _method)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32603, "message": "Internal error: handler returned invalid response"}}))
		return
	var reply = {"jsonrpc": "2.0", "id": parsed.get("id")}
	if response.has("error"):
		reply["error"] = response.error
	else:
		# batch-H fix (2026-08-15): test_run/test_manage 返回 {"data": ...} 而非 {"result": ...},
		# 原 `response.result` 点访问不存在的键 = SCRIPT ERROR "Invalid access to property or key"
		# → coroutine 在 reply 发送前中断 → 客户端 30s 超时挂死(test_run editor 路径自 P2-12
		# phase 2 起不可用,因 e2e-testing-undo-manager 的 action 名笔误从未被 e2e 真跑暴露)。
		# 兼容两种形状:显式 result 优先,data 键(test_commands)reshape 进 result。
		reply["result"] = response.get("result", response.get("data"))
	# security P1#3 fix: peer.send_text 对 >1MB 消息返回 ERR_INVALID_DATA, 检查返回值
	# 失败时 reply 本身发不出, 改发精简 error(远小于 1MB), 让客户端收到明确 -32010 而非 30s 超时
	var _reply_str := JSON.stringify(reply)
	if peer.send_text(_reply_str) != OK:
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "error": {"code": -32010, "message": "Response exceeds 1MB WebSocket limit"}}))

## I-4 (2026-08-14 审查 P3): 协程挂死(hang)兜底 watch。
## 2026-08-15 headless probe 实测定性(Godot 4.6.3),两种失效模式行为不同:
## ① handler 内部 script error → GDScript 以函数返回类型默认值({})恢复 caller,
##   既有 reply 路径发 {"result": null},client 不挂(批 H 修的"reply 永不发"是本
##   协程**自身函数体**出错——response.result 点访问——已由批 H get() 兜底修复);
## ② handler 挂死(await 的信号永不触发)→ caller 的 await 永不恢复 → reply 永不发 +
##   调用方后续清理(互斥锁释放)全跳过——本 watch 修复此类。
## 结构:handler 协程经 _fill_response_box fire-and-forget 后台跑(结果写共享 box);本
## 协程轮询 box —— 正常完成/script-error-默认值返回均零额外延迟;挂死时 box 永不填充,
## 轮询到 deadline 返 error Dictionary,调用方照常走 reply + 互斥锁释放路径。
## 仅用于内部上界确定的协程(debug);nav/test_run 不适用的理由见 _handle_message 调用点注释。
func _await_with_watchdog(fn: Callable, timeout_ms: int, method: String) -> Dictionary:
	if timeout_ms <= 0:
		return await fn.call()
	var box: Dictionary = {"done": false, "response": null}
	_fill_response_box(fn, box)  # 不 await:后台协程,填完 box 自然结束
	var deadline := Time.get_ticks_msec() + timeout_ms
	while not box["done"] and Time.get_ticks_msec() < deadline:
		await Engine.get_main_loop().process_frame
	if box["done"]:
		return box["response"]
	push_error("[MCP] %s coroutine did not complete within %dms (hung on an await that never resumed?) — replying error + releasing debug mutex" % [method, timeout_ms])
	return {"error": {"code": -32008, "message": "Editor handler coroutine did not complete within %dms (hung); no reply was produced. Check the editor log for the error." % timeout_ms}}


## I-4: 后台协程壳——执行 handler 并把结果写进 box(与 _await_with_watchdog 配对)。
## 2026-08-15 实测:handler 内部 script error 时本壳的 await 以返回类型默认值({})恢复,
## box 仍会填充(走既有 degenerate reply 路径);box 永不填充只发生在 handler 真挂死
## (await 永不返回)时——那才是 watch 要检测的。
func _fill_response_box(fn: Callable, box: Dictionary) -> void:
	box["response"] = await fn.call()
	box["done"] = true


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

# 3A (2026-09-19 批3 真机实测修复): challenge-response proof 专用恒时比较——HMAC hex
# 恒 64 字符,_constant_time_compare 的 SECRET_LEN=32 硬编码(editor secret 专用)会把
# 合法 proof 长度不等直接判 false(真机首测兑现,TS mock 同构测不出)。长度先等值校验
# 再恒时异或;HMAC hex 场景长度恒定,无长度泄露面。
func _constant_time_compare_varlen(a: String, b: String) -> bool:
	if a.length() != b.length():
		return false
	var result := 0
	for i in range(a.length()):
		result = result | (ord(a[i]) ^ ord(b[i]))
	return result == 0

# P4-2 (2026-09-11) 失焦降速对抗——流量驱动 clamp(见 _focus_boost_until_ms 声明处注释)。
func _mark_focus_traffic() -> void:
	_focus_boost_until_ms = Time.get_ticks_msec() + FOCUS_IDLE_TIMEOUT_MS


func _update_focus_boost() -> void:
	if Time.get_ticks_msec() < _focus_boost_until_ms:
		if _focus_saved_sleep_usec < 0:
			_focus_saved_sleep_usec = OS.low_processor_usage_mode_sleep_usec
		OS.low_processor_usage_mode_sleep_usec = FOCUS_BOOST_SLEEP_USEC
	else:
		_restore_focus_sleep()


func _restore_focus_sleep() -> void:
	if _focus_saved_sleep_usec >= 0:
		OS.low_processor_usage_mode_sleep_usec = _focus_saved_sleep_usec
		_focus_saved_sleep_usec = -1


# I-3(2026-09-11 审查): boost 期间用户回焦时,引擎已把 sleep 设回有焦值——saved 里存的
# 失焦原值已过期,恢复会"有焦编辑器 ~10fps"。捕获回焦事件放弃恢复(saved=-1),交还引擎自管。
func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN:
		_focus_saved_sleep_usec = -1


func _exit_tree() -> void:
	set_process(false)
	_restore_focus_sleep()  # P4-2: 插件停用/编辑器退出前恢复 sleep 原值(防 boost 残留)
	if _heartbeat:
		_heartbeat.timeout_detected.disconnect(_on_heartbeat_timeout)
	if _server: _server.stop()
	for peer in _peers: peer.close()
	_peers.clear()
	_authenticated_peers.clear()
	_connecting_since.clear()
	_auth_fail_count.clear()
	_auth_locked_until.clear()
	_delete_secret_file()
	_server = null  # P1-5 fix: 置 null 防 deferred _process 误用已 stop 的 server
