@tool
extends Node

## MCP Bridge Autoload — TCP + NDJSON protocol
## Install as autoload in project.godot to enable runtime game control via MCP.
## Default port: 9081 (env GODOT_MCP_BRIDGE_PORT 可覆盖起点;未指定时起始候选在 9081-9090 内
## crypto 随机(竞态缓解),被占时环形递增避让,见 _start_server/_bind_available_port)

# A1 (2026-08-19 反馈 bridge 9081 多实例劫持): 端口不再固定 —— Windows 下两个 Godot 实例
# bind 同一端口可能都"成功"(流量实际都到先占实例),listen 错误码不可靠;listen 前主动 connect
# 探测端口是否已有服务在听,被占则递增避让(起点起最多 PORT_ATTEMPTS 个),实际端口写入
# machine+project 双 registry,由 MCP server 侧 resolveBridgePort 解析。
const PORT_DEFAULT := 9081
const PORT_ATTEMPTS := 10  # 默认区间 9081..9090,与 core/instance-manager.ts DEFAULT_PORT_START/END 对齐
var _port := PORT_DEFAULT
const MAX_AUTH_FAILS := 5
const LOCKOUT_BASE_SECONDS := 30.0
const LOCKOUT_MAX_SECONDS := 300.0
const MAX_MESSAGE_SIZE := 1048576  # 1MB
const MAX_PEERS := 5
const PROTOCOL_VERSION := "1.0"
# A2 (2026-09-16 反馈批): 脚本分发版本指纹 —— 与 package.json version 同步(由
# scripts/version-sync.mjs 的 bridgeGd target 管理,勿手改)。ping 响应与 registry entry
# 均回传,MCP server 侧与 bundled 版本比对,项目内旧版拷贝未同步一眼可辨(send_drag 五踩根因)。
const BRIDGE_SCRIPT_VERSION := "0.33.6"
const INACTIVITY_TIMEOUT := 60.0

# ─── Instance Registry (Phase 2b) ─────────────────────────────────────────
const REGISTRY_HEARTBEAT_INTERVAL := 30.0
var _registry_heartbeat_timer: Timer = null
# A1: 双位置心跳 —— machine-level(<data-dir>/.godot-mcp/instances)是 MCP server
# (TS resolveBridgePort)的解析源;project-level(user://.godot/mcp-instances)供项目内排查。
var _registry_files: Array[String] = []
var _instance_id: String = ""

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

# ─── Per-peer Monitor/Watch states (C-07) ──────────────────────────────────
const MONITOR_MAX_PROPERTIES := 20
const MONITOR_DEFAULT_MAX_SAMPLES := 500
var _monitor_states: Dictionary = {}

const WATCH_DEFAULT_MAX_EVENTS := 1000
var _watch_states: Dictionary = {}

# P3-6 push 模式:watch/monitor 事件产生时主动推送(无需 poll)
# push_enabled 的 peer,事件/样本产生时立即 put_data 推送 notification 消息
# 消息格式:{"jsonrpc":"2.0","method":"bridge/event","params":{"type":"watch|monitor",...}}
# TS 侧常驻 data handler 接收后转发为 MCP notification
var _push_peers: Dictionary = {}  # pid -> true(peer 启用了 push 模式)

# P2-4 确定性 playtest 状态:seed/fixed_delta 锁定 + snapshot 存储 + step pending 队列
# seed 注入全局 RNG(仅覆盖 randi/randf,per-instance RandomNumberGenerator 不受影响)
# fixed_delta 设 physics_ticks_per_second + max_physics_steps_per_frame=1 + jitter_fix=0 三连(不碰 time_scale)
# snapshot 用 _cmd_get_node_properties 序列化器复用(BLOCKED_PROPERTIES 跳过 script/owner 等危险属性)
var _playtest_active: bool = false
var _playtest_snapshot: Dictionary = {}  # {path: {properties: {}, parent: String}}
var _playtest_fixed_delta_saved: Dictionary = {}  # 原值,restore 时还原
var _playtest_step_pending: Array = []  # [{peer: StreamPeerTCP, pid: int, id: Variant, frames: int, coroutine: Callable, result: Dictionary}]
# 2026-08-07 审查 P2 修复：playtest 是独占模式（snapshot/fixed_delta_saved 是全局单例非 per-peer）。
# owner_pid 记录当前持有者，_cleanup_peer_state 只在持有者断开时才还原全局状态，
# 防多 peer 场景下 peer B 断开误清 peer A 的 physics 锁/snapshot。
var _playtest_owner_pid: int = -1
var _last_step_request_id: Variant = null  # step 请求的 id,供 _process_buffer_bytes 取用
# G1 (2026-08-13) control-first satellite 层(附录 F.1):freeze/unfreeze/step_until
# owner_pid 独占(仿 _playtest_owner_pid,防多 peer 误清);step_until 走延迟通道(同 __PLAYTEST_STEP__)
var _control_frozen: bool = false
var _control_owner_pid: int = -1
var _control_step_until_pending: Array = []  # [{peer_id,pid,id,frames_remaining,wall_deadline_ms,conditions,_added_this_frame}]
# H1 (2026-08-20) 帧定时输入时间线:同款延迟通道。开窗后逐帧计数,at_frame 匹配帧注入事件
# (注入复用 _cmd_send_*,零重复);完成/墙钟超时 push 响应 +(若原 frozen)refreeze。
var _control_input_seq_pending: Array = []  # [{peer_id,pid,id,timeline,frames_budget,wall_deadline_ms,frame_counter,applied,refreeze,_added_this_frame}]
# 2026-08-14 审查 D-2 修复:freeze/开窗介入前保存游戏自身 paused 原值(游戏代码可能自己
# paused=true,如暂停菜单/回合制),control 层退出(unfreeze/step_until 完成/owner 断线)
# 时还原原值而非硬设 false。saved_valid 防重复 freeze 把维持中的 true 覆盖真实原值
# (不变式:frozen=true -> saved_valid=true)。
var _control_paused_saved: bool = false
# P2-3 (2026-09-11): freeze 竞争检测——游戏代码在 freeze 下 unpause(暂停菜单/自动取消
# 暂停的过场)时计数并 re-assert(freeze 听 agent 的);unfreeze 响应报终值,让 AI 判断
# contested。每次 re-assert 可漏一帧,诚实报数而非假装 freeze 密不透风(satellite 变体)。
var _freeze_contested_count: int = 0
var _freeze_started_ms: int = 0
var _control_paused_saved_valid: bool = false
var _pending_control_step_until_result: Dictionary = {}
# P2-2 (2026-09-11): playtest.step 的 report 搭车参数(字符串哨兵装不下数组,同款临时变量模式)
var _pending_playtest_step_report: Dictionary = {}  # 临时:_handle_message 存,_process_buffer_bytes 取
var _pending_control_input_seq_result: Dictionary = {}  # H1 同款临时变量
var _pending_call_method_result: Dictionary = {}  # 坑4(2026-08-21 反馈批)同款:call_method await_completion 延迟响应上下文
# P3-2 (2026-09-11): click_button real_event 等帧验证延迟响应上下文(同款临时变量模式)
var _pending_click_verify_result: Dictionary = {}
# P3-1 (2026-09-11): NetworkConditioner 弱网注入(masteryee network_conditioner.gd 移植,
# MultiplayerPeerExtension 装饰器包装真实 peer,出向注入 latency/loss/jitter)
var _net_conditioner: _NetworkConditioner = null
# P3-3 (2026-09-11): 项目本地命令目录 res://mcp_commands/*.gd(regiellis mcp_commands 移植,
# custom. 前缀隔离内建命名空间;宽容加载,坏文件跳过绝不破坏 bridge 启动)。
# P8-1 (2026-09-11): 升级热加载状态机(LuoxuanLove user executor.gd 移植)——slot 模型:
# mtime 对比 → 300ms debounce → active_calls 归零才换(quiesce) → 加载失败回滚旧实例
# (reload_failed);文件删除等调用归零再卸载(removed_pending);重名冲突后者 reload_failed
# 清空命令集。P3 契约(get_commands()->Dictionary{"custom.*":Callable},实例为 Node)100% 兼容,
# 已有 mcp_commands 项目零改动获得热重载。设计偏离(相对 LuoxuanLove):不递归子目录
# (mcp_commands 约定平铺,P3 文档已载);不移植 snapshot/restore/before_unload 生命周期钩子
# (P3 契约是无状态 Callable 表);开关用 env 而非 ProjectSettings(bridge 侧约定统一)。
var _custom_slots: Dictionary = {}  # script_path -> {instance,commands,version,state,active_calls,pending_reload,removed_pending,last_mtime,last_error}
var _custom_index: Dictionary = {}  # "custom.xxx" -> script_path(重名冲突:后者 reload_failed 清空)
var _custom_last_scan_ms := 0
const CUSTOM_RELOAD_DEBOUNCE_MS := 300
const CUSTOM_HOT_RELOAD_ENV := "GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD"
# CMP-2 (2026-08-08): runtime error 捕获——game bridge 通道的 OS.add_logger ring buffer。
# 让 AI 能看到游戏运行时 push_error / 脚本 setter 报错,闭环调试(不再只靠 take_screenshot 间接推断)。
var _error_capture: _ErrorCapture = null
# P7 (2026-09-11): 语义观察层(gua 移植)——观察 profile(debug/player) + 可见性级联 +
# 字段级投影(omit/redact/replace/quantize) + UI role/label 语义。
# 游戏侧零代码:节点 meta 声明(agent_exposure / visible_to_player / agent_field_rules)。
# profile 门禁:env GODOT_MCP_BRIDGE_ALLOWED_PROFILES(逗号分隔,默认仅 debug)——
# agent 不能自授权 player(模式切换不经 agent 通道,对齐 gua "profile 由 host 持有")。
const OBSERVATION_PROFILES := ["debug", "player"]
const FIELD_RULES_META := "agent_field_rules"
const EXPOSURE_META := "agent_exposure"
const VISIBLE_META := "visible_to_player"
const MAX_FIELD_RULES := 32
const CASCADE_MAX_DEPTH := 64
var _allowed_profiles: Array = ["debug"]
# B-1/I-1 清偿(审查):env 三态——未设/"debug"=仅 debug;"player" 单值=**host 强制档**
# (全部读请求被静默提升为 player 投影,agent 不能自降级绕过——请求级 debug 参数被忽略,
# 对齐 gua "profile 由 host 持有,agent 不能自己切到 DEBUG");"debug,player" 多值=请求级
# 可选(开发/测试模式,单值才锁死防"开了 player 白名单 agent 却全程传 debug"的自愿投影)。
var _forced_profile: String = ""
# B-1 清偿(审查):player 档下 call_method 的结构枚举白名单方法整组拒——树都不可见
# (get_tree player 档剪枝/private 不进树),枚举树的方法在玩家视角语义不成立
# (get_child 的 index 在两档间漂移是错位陷阱,拒比错位诚实)。
const PLAYER_BLOCKED_ENUM_METHODS := [
	"get_children", "get_child", "get_child_count", "get_parent", "get_index",
	"get_groups", "get_incoming_connections", "get_signal_connection_list",
]


const BLOCKED_PROPERTIES := [
	"script", "owner", "process_mode", "process_priority", "process_input",
	"process_unhandled_input", "process_unhandled_key_input", "process_internal",
	"physics_process_mode", "physics_interpolation_mode", "name", "meta",
	"input_event", "ready", "tree_entered", "tree_exited", "tree_exiting",
	"instance",  # I-2 (P2-4 审查 B-1 修复): instance 可注入 ExtResource 实例化恶意场景 _ready,与 script 同级危险。对齐 godot_operations.gd:735 / command_helpers.gd:179。
]

# I-06: get_property_list removed from remote-allowed methods to prevent property enumeration.
# It is still used internally by _get_all_properties() but not exposed to remote callers.
const ALLOWED_METHODS := [
	"get", "get_class", "get_path", "get_children", "get_child", "get_child_count",
	"get_parent", "has_method", "is_class", "get_instance_id",
	"get_meta", "has_meta", "has_signal", "get_signal_list", "get_signal_connection_list",
	"get_incoming_connections", "get_index", "get_groups", "is_in_group",
	"is_inside_tree", "is_part_of_edited_scene", "get_owner",
]

# P1-6 (2026-07-06 RCE 审查): EXTRA_METHODS 危险方法黑名单 — 即使 env GODOT_MCP_BRIDGE_EXTRA_METHODS
# 显式列出也拒绝。这些方法可改变运行时结构/执行任意代码,与 call_method 白名单"只读安全"设计冲突:
# set_script 加载任意脚本(=RCE)、queue_free/free 销毁节点、add_child/remove_child 改树结构、
# call/callv 间接调用任意方法(绕白名单)、emit_signal 触发已连接回调、connect/disconnect 改信号拓扑。
const EXTRA_METHODS_BLOCKLIST := [
	"set_script", "set", "set_indexed", "set_owner", "queue_free", "free", "add_child", "remove_child",  # P2-2 (2026-08-11): set/set_indexed 对称(防 opt-in EXTRA_METHODS 后 node.set("script",...) 绕 set_script)
	"call", "callv", "emit_signal", "connect", "disconnect",
	# A5 (2026-08-11 审查): 间接调用入口与销毁对称——call_deferred/call_thread_safe 可在 args
	# 里带被禁方法名(call_method(method="call_deferred", args=["set_script", ...])绕 BLOCKLIST,
	# 它只查顶层 method 名看不见内层);queue_delete 对称 queue_free。
	# B-2 (2026-08-14): 原写的无下划线拼写(callthreadsafe 连写)是拼写错误——Godot 4 真实
	# 方法名 call_thread_safe(data/godot-classes.json 实证:定义于 Node),错误拼写永不命中。
	# 补 propagate_call(子树递归调用入口)。拼写契约由
	# test/denylist-godot-classes-contract.test.ts 守护。
	"call_deferred", "call_thread_safe", "propagate_call", "queue_delete",
]

# ─── Lifecycle ─────────────────────────────────────────────────────────────

func _ready() -> void:
	# Godot 4.6+: extends 原生类(Node)的虚函数不可调 super()(4.6.2 Parse error "hasn't been defined"),移除 IMP-4 super()。该 convention 仅适用于 extends 自定义基类。
	if Engine.is_editor_hint():
		return
	# CMP-2 (2026-08-08): 注册 runtime error 捕获(在 _start_server 前,确保任何启动错误也被捕)。
	_error_capture = _ErrorCapture.new()
	OS.add_logger(_error_capture)
	# G1 (2026-08-13): PROCESS_MODE_ALWAYS — freeze 设 tree.paused=true 后 bridge _process 必须继续,
	# 否则 TCP 死锁(附录 F.1 BLOCKING)。注意 BLOCKED_PROPERTIES 禁远程 set process_mode,本地 _ready 设不冲突。
	process_mode = Node.PROCESS_MODE_ALWAYS
	# P0-3 (2026-09-11) 评估结论:不加 process_priority=1000(帧末采样,satellite #389)——bridge
	# _process 还承担帧定时输入注入(send_input_sequence 的 at_frame 语义)与 freeze 开窗,整体
	# 移帧末会使输入生效帧偏移一位,破坏既有输入时序契约。monitor 统一迟一帧读数(时间线形状
	# 无损)记为已知限制;若后续需帧末精确对齐,做独立采样器子节点专项(priority 只作用采样)。
	# Headless 也启动 Bridge: run_project 跑 headless 游戏需 Bridge 通信(DisplayServer=headless)。
	# --headless --script 场景若端口全被占, _start_server 的探测+避让全失败会安全跳过(warning+return)。
	_start_server()
	# P3-3 (2026-09-11): 注册项目本地命令(res://mcp_commands/*.gd)。放在 _start_server 后:
	# 注册失败(push_warning 路径)不影响 bridge 服务;无目录时静默 no-op。
	_register_custom_commands()
	# P7 (2026-09-11): 观察 profile 白名单——env 是游戏方/启动配置的声明面,启动时读一次
	# (进程 env 生命周期内不变;agent 请求级 observation_profile 参数只能选白名单内的档位)。
	# env 三态:见 _forced_profile 声明处注释(单值=强制档/多值=可选/默认仅 debug)。
	var _env_profiles := OS.get_environment("GODOT_MCP_BRIDGE_ALLOWED_PROFILES")
	if _env_profiles.strip_edges() != "":
		var _parsed: Array = []
		for _tok in _env_profiles.split(","):
			var _p := _tok.strip_edges().to_lower()
			if _p in OBSERVATION_PROFILES and not (_p in _parsed):
				_parsed.append(_p)
		if not _parsed.is_empty():
			_allowed_profiles = _parsed
			if _parsed.size() == 1:
				_forced_profile = _parsed[0]


func _exit_tree() -> void:
	# 同 _ready():extends 原生类 Node 的 _exit_tree() 虚函数不可 super()(Godot 4.6+ Parse error)。
	_stop_server()
	# CMP-2: 注销 error 捕获(Logger 是 RefCounted,remove_logger 让引擎 logger 链释放引用,
	# 避免 Node 销毁后 logger 回调访问已失效上下文)。
	if _error_capture:
		OS.remove_logger(_error_capture)
		_error_capture = null


func _process(delta: float) -> void:
	# P0-3 (2026-09-11): delta 启用——monitor 采样改游戏时间调度(satellite #378 同款坑修复),
	# delta 已含 time_scale 缩放 = 游戏时间;此前帧步长采样在窗口期帧率变化时实际节奏漂移 2-4 倍。
	if _server == null:
		return

	# Accept new connections (Godot 4.6 renamed accept() to take_connection())
	# I-5 (2026-08-14 审查 P3) 评估结论:editor websocket_server.gd 的 STATE_CONNECTING
	# 握手超时在此**不需要**——本 bridge 的 peer 是 StreamPeerTCP(TCPServer.take_connection
	# 返回的入站连接,accept 时即 STATUS_CONNECTED,不存在 CONNECTING 中间态);
	# "连上不作为"的 peer 由下方 INACTIVITY_TIMEOUT=60s idle 断连兜底(accept 时即记
	# _peer_last_activity),发非 auth 数据的 peer 首条消息即被断(_process_buffer_bytes
	# 未认证分支 disconnect_from_host)——槽位占用均有界,无永久占坑路径。
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
			var elapsed: float = Time.get_ticks_msec() / 1000.0 - float(_peer_last_activity[pid_act])
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
		# C-07: cleanup per-peer monitor/watch state on disconnect
		_cleanup_peer_state(pid)
		# I-9: 清除断开 peer 的 per-peer 锁定/失败记录。per-peer 隔离是有意设计(非全局)——
		# 全局计数会让单个失败源锁死所有合法客户端(DoS), 详见 _process_buffer_bytes 处 I-9 论证。
		# 断开即清零是 per-peer 的预期行为(peer id 每连接不同), LOCKOUT 仅减速带, 非主防线。
		_auth_fail_count.erase(pid)
		_auth_locked_until.erase(pid)
		_peers.remove_at(i)

	# ─── P2-4 playtest.step pending:每帧递减 frames_remaining,到 0 时 push 响应 ──
	# step 语义:推进 N 帧后返回。_process 每帧调一次,递减计数即"推进"。
	# I-2 修复(P2-4 审查):刚加入的 entry(_added_this_frame=true)本帧不递减,
	# 否则 frames=1 在同一 _process tick 立即完成,physics_frame 未推进 → 拿到 pre-step 状态。
	# 下一帧 _added_this_frame 清 false 后才开始递减计数。
	if _playtest_step_pending.size() > 0:
		var completed: Array = []
		for idx in range(_playtest_step_pending.size()):
			var entry: Dictionary = _playtest_step_pending[idx]
			if bool(entry.get("_added_this_frame", false)):
				entry["_added_this_frame"] = false  # 下一帧开始递减
				continue
			entry["frames_remaining"] = int(entry["frames_remaining"]) - 1
			if int(entry["frames_remaining"]) <= 0:
				completed.append(idx)
		# 倒序处理完成的(避免索引漂移)
		completed.reverse()
		for idx in completed:
			var entry: Dictionary = _playtest_step_pending[idx]
			_playtest_step_pending.remove_at(idx)
			var peer_id: int = int(entry["peer_id"])
			# 找到对应 peer(peer 可能已断开)
			var target_peer: StreamPeerTCP = null
			for p in _peers:
				if p.get_instance_id() == peer_id:
					target_peer = p
					break
			if target_peer == null:
				continue  # peer 已断开,丢响应
			var step_result_dict := {
				"id": entry["id"],
				"result": {
					"success": true,
					"frames_stepped": true,
					"frame_count": Engine.get_process_frames(),
					"nodes": get_tree().root.get_child_count(),
				}
			}
			# P2-2: report 搭车——推进完成后求值终态(请求带 report 才有此字段);逐条失败不炸
			var _step_report_specs: Array = entry.get("report", [])
			if _step_report_specs.size() > 0:
				step_result_dict["result"]["report"] = _eval_structured_report(_step_report_specs, str(entry.get("profile", "debug")))
			var step_result := JSON.stringify(step_result_dict)
			target_peer.put_data((step_result + "\n").to_utf8_buffer())

	# ─── G1 (2026-08-13) control-first: freeze 维持 + step_until 轮询 ──
	# freeze 维持:每帧重设 paused(防游戏代码 WHEN_PAUSED 解 pause)。step_until 时 _control_frozen=false
	# (临时解开,让游戏跑),此块自然跳过;step_until 完成 refreeze 后恢复 _control_frozen=true。
	if _control_frozen:
		# P2-3: 竞争检测——被游戏代码解开才计数再 re-assert(已 paused 时不重复赋值);
		# step_until/input_seq 开窗期间 _control_frozen=false,此块跳过,窗口期游戏跑是合法的
		if not get_tree().paused:
			_freeze_contested_count += 1
		get_tree().paused = true
	# step_until 轮询:每帧递减 frames_remaining + 求值 conditions[](AND 全满足即停)
	if _control_step_until_pending.size() > 0:
		var su_completed: Array = []
		var now_ms := Time.get_ticks_msec()
		for su_idx in range(_control_step_until_pending.size()):
			var su_entry: Dictionary = _control_step_until_pending[su_idx]
			if bool(su_entry.get("_added_this_frame", false)):
				su_entry["_added_this_frame"] = false
				continue
			su_entry["frames_remaining"] = int(su_entry["frames_remaining"]) - 1
			var cond_error := ""
			var all_met := true
			var conds: Array = su_entry["conditions"]
			# B-1 清偿(审查):player 档下 conditions 求值同 wait_for_property 语义——
			# 不可观察节点视为 not found(存在性不泄露),属性值过投影后参与比较
			# (防"等待 hp==75 超时/成功"这类 1bit 真值侧信道)。
			var _su_player := str(su_entry.get("profile", "debug")) == "player"
			for cond in conds:
				var cdict: Dictionary = cond
				var node_path := str(cdict["path"])
				var n := get_node_or_null(node_path)
				if n == null or not is_instance_valid(n) or (_su_player and not _observable_in_player(n)):
					cond_error = "node not found/freed: %s" % node_path
					all_met = false
					break
				var prop := str(cdict["property"])
				if not (prop in n):
					cond_error = "property not found: %s.%s" % [node_path, prop]
					all_met = false
					break
				var nget: Variant = n.get(prop)
				if _su_player:
					var _cond_wrapper: Dictionary = {prop: nget}
					_project_dict(n, _cond_wrapper)
					nget = _cond_wrapper.get(prop, null)
				if not _compare_values(nget, str(cdict["op"]), cdict["value"]):
					all_met = false
			# 全仓审查 GD B-1 (2026-09-12): 完成判定移出 for cond 循环——原在循环体内致
			# ① AND 语义破坏(首条件满足即 append 完成,后续条件未评估,predicate_met 谎报全满足)
			# ② 同 su_idx 双 append(帧耗尽/多条件同帧满足时每条件命中一次)→ 消费循环倒序双
			# remove:单 pending 时第二轮索引空数组越界中断 _process;多 pending 时误删相邻条目。
			# 循环外判定保证每 entry 每帧至多一次 append。
			if cond_error != "" or all_met or int(su_entry["frames_remaining"]) <= 0 or now_ms > int(su_entry["wall_deadline_ms"]):
				if cond_error != "":
					su_entry["_error"] = cond_error
				su_entry["_met"] = all_met and cond_error == ""
				su_completed.append(su_idx)
		su_completed.reverse()
		for su_idx in su_completed:
			var su_entry: Dictionary = _control_step_until_pending[su_idx]
			_control_step_until_pending.remove_at(su_idx)
			# refreeze:若 step_until 前 frozen,完成时恢复 freeze
			if bool(su_entry.get("refreeze", false)):
				_control_frozen = true
				get_tree().paused = true  # freeze 维持(游戏原值仍由 _control_paused_saved 持有,unfreeze 时还原)
			elif _control_step_until_pending.is_empty() and _control_input_seq_pending.is_empty() and not _control_frozen:
				# 2026-08-14 审查 D-2 修复:最后一个开窗 entry 完成且无冻结,游戏回归自身
				# paused 原值(而非硬设 false)。pending 非空/冻结中不还原(后续 entry 仍需
				# 开窗推进,或由 freeze 维持、unfreeze/断线还原点统一处理)。
				# H1 (2026-08-20):input_seq pending 同为开窗者,两数组皆空才算最后一个。
				get_tree().paused = _control_paused_saved
				_control_paused_saved = false
				_control_paused_saved_valid = false
			var peer_id: int = int(su_entry["peer_id"])
			var target_peer: StreamPeerTCP = null
			for p in _peers:
				if p.get_instance_id() == peer_id:
					target_peer = p
					break
			if target_peer == null:
				continue
			var su_result_dict := {
				"id": su_entry["id"],
				"result": {
					"success": true,
					"predicate_met": bool(su_entry.get("_met", false)),
					"frames_elapsed": int(su_entry["max_frames"]) - int(su_entry["frames_remaining"]),
					"wall_exceeded": now_ms > int(su_entry["wall_deadline_ms"]),
					"error": str(su_entry.get("_error", "")),
				}
			}
			# P2-2: report 搭车——推进完成后求值终态(refreeze 已完成,读数与最后一处理帧一致)
			var _su_report_specs: Array = su_entry.get("report", [])
			if _su_report_specs.size() > 0:
				su_result_dict["result"]["report"] = _eval_structured_report(_su_report_specs, str(su_entry.get("profile", "debug")))
			var su_result := JSON.stringify(su_result_dict)
			target_peer.put_data((su_result + "\n").to_utf8_buffer())

	# ─── H1 (2026-08-20) input_sequence 轮询:逐帧计数 + at_frame 匹配注入 ──
	# 开窗模式同 step_until;注入直接复用 _cmd_send_*(自带校验),结果记 applied 如实上报。
	if _control_input_seq_pending.size() > 0:
		var isq_completed: Array = []
		var isq_now_ms := Time.get_ticks_msec()
		for isq_idx in range(_control_input_seq_pending.size()):
			var isq_entry: Dictionary = _control_input_seq_pending[isq_idx]
			if bool(isq_entry.get("_added_this_frame", false)):
				isq_entry["_added_this_frame"] = false
				continue
			isq_entry["frame_counter"] = int(isq_entry["frame_counter"]) + 1
			var isq_frame := int(isq_entry["frame_counter"])
			for isq_ev in (isq_entry["timeline"] as Array):
				var isq_e: Dictionary = isq_ev
				if int(isq_e.get("at_frame", -1)) == isq_frame:
					var isq_res: Variant = _inject_timeline_event(isq_e)
					(isq_entry["applied"] as Array).append({
						"at_frame": int(isq_e["at_frame"]),
						"type": str(isq_e.get("type", "")),
						"ok": not (isq_res is Dictionary and (isq_res as Dictionary).has("error")),
						"detail": isq_res,
					})
			if isq_frame >= int(isq_entry["frames_budget"]) or isq_now_ms > int(isq_entry["wall_deadline_ms"]):
				isq_entry["_wall_timeout"] = isq_now_ms > int(isq_entry["wall_deadline_ms"])
				isq_completed.append(isq_idx)
		isq_completed.reverse()
		for isq_idx in isq_completed:
			var isq_entry: Dictionary = _control_input_seq_pending[isq_idx]
			_control_input_seq_pending.remove_at(isq_idx)
			# refreeze / paused 原值还原:与 step_until D-2 语义对称,且需两数组皆空才算最后一个开窗者
			if bool(isq_entry.get("refreeze", false)):
				_control_frozen = true
				get_tree().paused = true
			elif _control_step_until_pending.is_empty() and _control_input_seq_pending.is_empty() and not _control_frozen:
				get_tree().paused = _control_paused_saved
				_control_paused_saved = false
				_control_paused_saved_valid = false
			var isq_peer_id: int = int(isq_entry["peer_id"])
			var isq_target: StreamPeerTCP = null
			for p in _peers:
				if p.get_instance_id() == isq_peer_id:
					isq_target = p
					break
			if isq_target == null:
				continue
			var isq_result := JSON.stringify({
				"id": isq_entry["id"],
				"result": {
					"success": not bool(isq_entry.get("_wall_timeout", false)),
					"applied": isq_entry["applied"],
					"applied_count": (isq_entry["applied"] as Array).size(),
					"total_events": (isq_entry["timeline"] as Array).size(),
					# F-4(2026-08-20 审查):部分事件 ok:false 时 success 仍 true(截断语义只看 wall_timeout),
					# 加 all_applied 一眼区分全量/部分注入(诊断字段,不改变 success 判定语义)。
					# 注意读法:applied 为空(wall 超时 0 事件注入)时 all() 空真为 true——
					# 读 all_applied 须对照 applied_count,空数组不构成"全量注入"证据。
					"all_applied": (isq_entry["applied"] as Array).all(func(r): return bool((r as Dictionary).get("ok", false))),
					"frames_elapsed": int(isq_entry["frame_counter"]),
					"wall_timeout": bool(isq_entry.get("_wall_timeout", false)),
					"refrozen": bool(isq_entry.get("refreeze", false)),
				}
			})
			isq_target.put_data((isq_result + "\n").to_utf8_buffer())

	# ─── Property monitor sampling (C-07: per-peer; P0-3 游戏时间调度) ──────
	var _monitor_tree := get_tree()
	var _game_paused := _monitor_tree != null and _monitor_tree.paused
	var dead_monitors: Array = []
	for peer_id in _monitor_states:
		var ms: Dictionary = _monitor_states[peer_id]
		if not ms.get("active", false):
			continue
		# P0-3 (2026-09-11): 游戏暂停/freeze 下游戏时间停走——跳过计时与采样
		# (PROCESS_MODE_ALWAYS 下 _process 仍每帧触发),防窗口被冻结空转耗光 + 记过期样本。
		if _game_paused:
			continue
		# P0-3: 帧步长(frame_counter/interval_frames)→ 游戏时间目标时刻制。delta 含
		# time_scale 缩放 = 游戏时间;采样节奏锚定时间后,窗口期帧率变化不再漂移(#378)。
		ms["elapsed_ms"] = float(ms["elapsed_ms"]) + delta * 1000.0
		if float(ms["elapsed_ms"]) < float(ms["next_sample_ms"]):
			ms["advanced_since_sample"] = true
			continue
		ms["advanced_since_sample"] = false
		var _ms_interval := float(ms["interval_ms"])
		ms["next_sample_ms"] = float(ms["next_sample_ms"]) + _ms_interval
		if float(ms["next_sample_ms"]) <= float(ms["elapsed_ms"]):
			# 长帧跨过多个采样点:resync 锚到当前 + 一个间隔,不 burst 补帧
			ms["next_sample_ms"] = float(ms["elapsed_ms"]) + _ms_interval
		var node := get_node_or_null(str(ms["node_path"]))
		if node == null:
			ms["active"] = false
			(ms["samples"] as Array).append({"frame": Engine.get_process_frames(), "time": Time.get_ticks_msec() / 1000.0, "t_game_ms": float(ms["elapsed_ms"]), "error": "node_lost", "stopped_reason": "node_lost"})
		else:
			# P7: player 档中途可见性复查(与 watch 同款语义)——游戏中途把节点藏起来后
			# 静默跳过该次采样(时间线缺格,不泄露),调度照常推进;重新可见自动恢复记录。
			if str(ms.get("profile", "debug")) == "player" and not _observable_in_player(node):
				continue
			var values: Dictionary = {}
			for prop in (ms["properties"] as Array):
				values[prop] = _jsonify(node.get(prop))
			# P7: player 档位采样实时投影(每次读 meta 现值——游戏中途把字段藏起来的
			# 语义生效;monitor 是持续观察,快照 start 时的规则集会在中途变更下失真)。
			if str(ms.get("profile", "debug")) == "player":
				_project_dict(node, values)
			var sample_dict := {
				"frame": Engine.get_process_frames(),
				"time": Time.get_ticks_msec() / 1000.0,
				"t_game_ms": float(ms["elapsed_ms"]),
				"values": values
			}
			(ms["samples"] as Array).append(sample_dict)
			# P3-6: push 模式下立即推送采样(不等 poll)
			_push_event_to_peer(peer_id, "monitor", {
				"node_path": str(ms["node_path"]),
				"sample": sample_dict
			})
			if (ms["samples"] as Array).size() >= int(ms["max_samples"]):
				(ms["samples"] as Array)[-1]["stopped_reason"] = "max_samples_reached"
				ms["active"] = false
		if not ms.get("active", false):
			dead_monitors.append(peer_id)
	for pid_key in dead_monitors:
		_monitor_states.erase(pid_key)

	# ─── P8-1 custom_commands 热加载 tick:debounce 限频的周期 reconcile ──────
	# 300ms 一档(mtime 扫描开销可忽略;LuoxuanLove _RELOAD_DEBOUNCE_MSEC 同款)。
	# 无 mcp_commands 目录时 _refresh_custom_slots 秒回(空扫描)。
	if _custom_last_scan_ms == 0 or Time.get_ticks_msec() - _custom_last_scan_ms >= CUSTOM_RELOAD_DEBOUNCE_MS:
		_refresh_custom_slots("tick")


# ─── Server management ─────────────────────────────────────────────────────

func _start_server() -> void:
	_crypto = Crypto.new()
	_secret = _generate_secret()
	if _secret.length() < 32:
		push_error("[MCP Bridge][SECURITY] Secret generation failed — Bridge server not started")
		_secret = ""
		return
	if not _bind_available_port():
		return
	print("[MCP Bridge] Listening on 127.0.0.1:%d" % _port)
	# C-01: Secret file MUST be in project .godot/ — never fall back to tmpdir.
	# Writing to tmpdir (globally readable on Linux) allows local privilege escalation.
	var proj_dir := _get_project_dir()
	if proj_dir == "":
		push_error("[MCP Bridge][SECURITY] Cannot determine project directory — aborting Bridge startup")
		_server.stop()
		_server = null
		return
	var godot_dir := proj_dir + "/.godot"
	if not DirAccess.dir_exists_absolute(godot_dir):
		DirAccess.make_dir_recursive_absolute(godot_dir)
	_secret_file = godot_dir + "/mcp_bridge_%d.secret" % _port
	# S4 (2026-06-23): 固定 secret 模式(本地测试,env GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true)。
	# secret 文件存在且有效则复用,跳过重生+写入,打破"重生→_restrict 收紧只读→下次写失败
	# abort→_exit_tree 删除→MCP 端 5min TTL 缓存不同步"的死循环。默认 false 保持每次重生(安全)。
	var _persistent_secret := OS.get_environment("GODOT_MCP_BRIDGE_PERSISTENT_SECRET").to_lower() == "true"
	var _secret_reused := false
	if _persistent_secret and FileAccess.file_exists(_secret_file):
		var _existing := FileAccess.get_file_as_string(_secret_file)
		if _existing.length() >= 32:
			_secret = _existing
			_secret_reused = true
			print("[MCP Bridge] Reusing persistent secret (GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true)")
	if not _secret_reused and not _write_secret_to_file(_secret_file):
		push_error("[MCP Bridge][SECURITY] Failed to write secret to %s — aborting Bridge startup. Check directory permissions." % _secret_file)
		_server.stop()
		_server = null
		return
	# Instance registry heartbeat (Phase 2b)
	_start_registry_heartbeat()


## A1 (2026-08-19 反馈): 端口绑定 —— 探测占用 + 递增避让。
## env GODOT_MCP_BRIDGE_PORT 设起点(默认随机化,见下);每个候选端口先 connect 探测(已有服务在听
## 则让位 —— Windows 双 bind 可"成功"但流量全到先占实例,listen 错误码测不出),再 listen
## (保留端口段/权限等 listen 失败同样递增,见 2026-08-14 反馈 Hyper-V 保留段 9046-9145 覆盖 9081)。
## 成功时 _server 已建立且 _port 为实际端口;全部失败返回 false(Bridge 禁用,游戏继续跑)。
## ⚠️ 已知残留竞态(2026-08-21 批 2 实测):双实例毫秒级同瞬启动时探测→listen 窗口双判空闲,
## 20 轮同瞬双 spawn 18 轮双 listen OK(Windows 双 bind 假成功)。「listen 后回探自连判属主」
## 修复被真机证伪(双属主/零属主两态漂移)已回退;证伪数据见
## docs/reviews/2026-08-21-audit-fixes-batch2.md。
## 缓解(2026-08-21 裁决,默认场景起始候选随机化):双实例都从 9081 起步是碰撞主因——随机起点
## 把必然碰撞降为 1/PORT_ATTEMPTS,配合递增避让实际碰撞趋零。危害重估:连错实例会被 auth 拒
## (secret 每实例 Crypto.generate_random_bytes 密码学随机,严格本实例比对)——危害=显式
## auth failed 需重跑(可用性),**非静默错连**(无数据安全问题),auth 是语义防线。
## 随机源用 _crypto 而非 randi():playtest.seed 锁全局 randi/randf,双实例同 seed 时
## randi() 同值随机化失效;密码学源不受 seed 影响。env 显式指定时保持确定性(用户契约)。
func _bind_available_port() -> bool:
	var start_port := PORT_DEFAULT
	var env_port := OS.get_environment("GODOT_MCP_BRIDGE_PORT")
	if env_port != "" and env_port.is_valid_int():
		start_port = clampi(int(env_port), 1, 65535)
	elif _crypto != null:
		var rb := _crypto.generate_random_bytes(2)
		start_port = PORT_DEFAULT + (int(rb[0]) * 256 + int(rb[1])) % PORT_ATTEMPTS
	for i in PORT_ATTEMPTS:
		# 审查Nit-A:环形取模保候选集合恒为 [PORT_DEFAULT, PORT_DEFAULT+PORT_ATTEMPTS-1]
		# (随机起点+线性递增会漂到窗口外,与 instance-manager 分配窗口不对称)
		var candidate: int = PORT_DEFAULT + ((start_port - PORT_DEFAULT + i) % PORT_ATTEMPTS)
		if _port_in_use(candidate):
			print("[MCP Bridge] Port %d already served by another instance, trying %d" % [candidate, candidate + 1])
			continue
		var server := TCPServer.new()
		var err := server.listen(candidate, "127.0.0.1")
		if err == OK:
			_server = server
			_port = candidate
			return true
		push_warning("[MCP Bridge] listen(%d) failed (err %d), trying next port" % [candidate, err])
	_port = PORT_DEFAULT
	push_warning("[MCP Bridge] No available port in %d-%d — Bridge disabled. " % [start_port, start_port + PORT_ATTEMPTS - 1] +
		"If netstat shows no listener on these ports, check Windows reserved port ranges: " +
		"netsh interface ipv4 show excludedportrange protocol=tcp")
	return false


## connect 探测端口是否已有服务在听(能建立 TCP 连接 = 占用)。
## localhost 连非监听端口立即 REFUSED(ms 级),探测 10 个候选端口最坏 ~1s,仅 _ready 一次性开销。
## poll() 必须显式调 —— StreamPeerTCP 状态不自动推进,缺 poll 时 get_status 恒停留
## CONNECTING,探测恒判"空闲"(e2e 实测:缺 poll 时探测形同虚设,靠 listen err 22 兜底;
## 真实劫持场景 Windows 双 bind 不报错,探测是唯一防线)。
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

## Compat: Godot 4.6 renamed TCPServer.accept() to take_connection()
func _server_take_connection() -> StreamPeerTCP:
	if _server.has_method("take_connection"):
		return _server.take_connection()
	return _server.accept()


# DUPLICATE: Keep in sync with addons/godot_mcp_server/websocket_server.gd:_constant_time_compare
# Cannot share because editor plugin and game autoload have separate script contexts.
# C-05: Fixed-length comparison (always 32 bytes) to prevent timing side-channel.
func _constant_time_compare(a: String, b: String) -> bool:
	# IMPORTANT: SECRET_LEN must match the token length generated by the MCP server's
	# secret generation logic. If token generation changes, update this constant.
	const SECRET_LEN := 32
	# Reject early if lengths differ — avoids leaking length info through
	# branch-prediction timing inside the loop.
	if a.length() != SECRET_LEN or b.length() != SECRET_LEN:
		return false
	var result := 0
	for i in range(SECRET_LEN):
		result = result | (ord(a[i]) ^ ord(b[i]))
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
		push_error("[MCP Bridge] Failed to generate 32-char secret after 11 attempts — refusing to start with weak key")
		return ""
	return result

func _get_project_dir() -> String:
	var res_root: String = ProjectSettings.globalize_path("res://")
	if res_root != "":
		return res_root.rstrip("/")
	return ""



func _write_secret_to_file(path: String) -> bool:
	# I-3/I-8 SECURITY: secret 明文写入,Godot FileAccess 无权限参数。
	# I-8: 写完后用 OS.execute 收紧权限(与 TS 端/websocket_server.gd 对齐)。
	# Safe save 规避(Godot #40366): Windows FileAccess.close 走 atomic rename,杀软拦 → 红字
	# (非致命但误导)。改用 PowerShell WriteAllText 直接写绕开;secret 经环境变量传递(见 I-3)。
	# 配合 _restrict_secret_permissions 用 USERNAME:M(Modify)+ inheritance:r,PowerShell 能覆盖 M key。
	# Linux/macOS 的 FileAccess.close 不走 atomic,直接用。
	# SEC-P2-2 (2026-08-09 审查): 写前 symlink 预检。攻击者预置 secret 文件为 symlink 指向任意
	# 文件,WriteAllText/FileAccess.open 均 follow symlink 覆盖目标。读方 game-bridge.ts 已有
	# lstatSync 兜底,此处写方对称加固。与 addons/godot_mcp_server/websocket_server.gd DUPLICATE 同步。
	var write_ok := false
	if OS.get_name() == "Windows":
		OS.set_environment("_MCP_SECRET_TMP", _secret)
		OS.set_environment("_MCP_SECRET_PATH", path)
		# F-1(2026-07-04 审查): path 经 env 传递($env:_MCP_SECRET_PATH),不字面拼接进 PowerShell
		# 单引号字符串(项目目录名含 ' 即可逃逸注入)。env 值不解析为命令语法,注入消失。
		# F-2(2026-07-04 审查): OS.execute 去 blocking=false,ec 为真实 exit code(原 non-blocking 返回
		# fork 启动状态,write_ok=(ec==OK) 乐观判断可能误报成功)。与 websocket_server.gd 同步。
		# SEC-P2-2: exit 3 = symlink 拒写(WriteAllText 不执行);Test-Path 守 Get-Item 防首次生成不存在时抛错。
		var ps_args := PackedStringArray(["-NoProfile", "-Command", "if (Test-Path $env:_MCP_SECRET_PATH) { if ((Get-Item -LiteralPath $env:_MCP_SECRET_PATH -Force).LinkType) { exit 3 } }; [IO.File]::WriteAllText($env:_MCP_SECRET_PATH, $env:_MCP_SECRET_TMP)"])
		var ec := OS.execute("powershell", ps_args, [])
		OS.unset_environment("_MCP_SECRET_TMP")
		OS.unset_environment("_MCP_SECRET_PATH")
		if ec == 3:
			# symlink 命中:不 fallback FileAccess(同样 follow symlink),返 false 让调用方处理
			push_warning("[MCP Bridge] %s is a symlink — refusing to write bridge secret" % path)
			return false
		write_ok = (ec == OK)
		if not write_ok:
			push_warning("[MCP Bridge] PowerShell write failed (exit %d), fallback to FileAccess" % ec)
	else:
		# SEC-P2-2: readlink 成功(exit 0)= 是 symlink;失败(非零)= 普通文件或不存在。
		# GD 无原生 symlink 检测 API(FileAccess/DirAccess 均无 LinkType 等价),借 readlink。
		if FileAccess.file_exists(path):
			var rl_ec := OS.execute("readlink", PackedStringArray([path]), [])
			if rl_ec == OK:
				push_warning("[MCP Bridge] %s is a symlink — refusing to write bridge secret" % path)
				return false
		var f := FileAccess.open(path, FileAccess.WRITE)
		if f:
			f.store_string(_secret)
			f.close()
			write_ok = true
	if write_ok:
		_restrict_secret_permissions(path)
		return true
	# Windows 末级 fallback: FileAccess(会触发 Safe save 红字但 key 写成功)
	var f2 := FileAccess.open(path, FileAccess.WRITE)
	if f2:
		f2.store_string(_secret)
		f2.close()
		_restrict_secret_permissions(path)
		return true
	return false

# I-8: 收紧 secret 文件权限(Godot FileAccess 无 chmod 参数,用 OS.execute 绕过)。
# I-2: TS 端用 os.userInfo().username 防环境变量伪造(C-ARC-01);Godot OS API 无等价 getUserInfo,
#      此处退回 get_environment("USERNAME")。威胁有限:攻击者需本机代码执行权限,而本机可执行即可直读 secret。
# I-1: OS.execute 退出码非零时 push_warning,避免权限收紧失败静默(可能 world-readable)。
# DUPLICATE: 与 addons/godot_mcp_server/websocket_server.gd:_restrict_secret_permissions 保持同步。
func _restrict_secret_permissions(path: String) -> void:
	var os_name := OS.get_name()
	var exit_code := 0  # I-1: 捕获 OS.execute 退出码,非零告警(避免权限收紧失败静默)
	if os_name == "Windows":
		var username := OS.get_environment("USERNAME")
		if username.is_empty():
			username = OS.get_environment("USER")
		if username.is_empty() or not RegEx.create_from_string("^[A-Za-z0-9_-]+$").search(username):
			push_warning("[MCP Bridge] Cannot restrict secret permissions: username '%s' has unexpected chars" % username)
			return
		# USERNAME:M(Modify) + /inheritance:r(其他用户无 ACE)。原 USERNAME:R 是 anti-pattern
		# (bridge 以 USERNAME 身份运行却要覆盖自己只读的 key → 靠 FileAccess atomic rename 绕 ACL
		# → Safe save 红字, Godot #40366)。M 让 _write_secret_to_file 的 PowerShell 能直接覆盖,
		# 其他用户仍无权限(比 R 更严)。与 websocket_server.gd:_restrict_secret_permissions 同步。
		exit_code = OS.execute("icacls", PackedStringArray([path, "/inheritance:r", "/grant:r", "%s:M" % username]), [])
		if exit_code != 0:
			push_warning("[MCP Bridge] icacls failed (exit %d), secret may keep default permissions: %s" % [exit_code, path])
	elif os_name in ["Linux", "FreeBSD", "macOS"]:
		exit_code = OS.execute("chmod", PackedStringArray(["600", path]), [])
		if exit_code != 0:
			push_warning("[MCP Bridge] chmod failed (exit %d), secret may keep default permissions: %s" % [exit_code, path])


# ─── Instance Registry (Phase 2b) ─────────────────────────────────────────


func _start_registry_heartbeat() -> void:
	_instance_id = str(OS.get_process_id()) + "_" + str(Time.get_ticks_msec())
	# Machine-level registry
	# N-2(审查·已知限制): OS.get_data_dir() 默认三平台两次 base_dir 归一到用户主目录,
	# 与 TS 侧 instance-manager.getDefaultRegistryDir(~/.godot-mcp/instances) 对齐;
	# 但 Linux/macOS 显式设置 XDG_DATA_HOME 时 GD 写 $XDG_DATA_HOME 上两级、TS 仍读 ~ 下,
	# 两侧漂移 → resolveBridgePort 回落 9081(审查Important-B:起点随机化后 GD 约 90% 场景不在
	# 9081,此回落从「无害」退化为「连不上」——非碰撞类缝隙,与 auth 兜底是两类问题;容器/Flatpak 留意)。
	var machine_dir: String = OS.get_data_dir().get_base_dir().get_base_dir().path_join(".godot-mcp").path_join("instances")
	# Project-level registry
	var project_dir: String = ProjectSettings.globalize_path("user://").path_join(".godot").path_join("mcp-instances")
	_dir_ensure(machine_dir)
	_dir_ensure(project_dir)
	# A1: 双写 —— machine-level 是 MCP server(TS resolveBridgePort)解析实际端口的来源;
	# project-level 保留(项目内排查实例状态用)。
	_registry_files = [
		machine_dir.path_join(_instance_id + ".json"),
		project_dir.path_join(_instance_id + ".json"),
	]
	_write_registry_entry()
	# Timer
	_registry_heartbeat_timer = Timer.new()
	_registry_heartbeat_timer.wait_time = REGISTRY_HEARTBEAT_INTERVAL
	_registry_heartbeat_timer.one_shot = false
	_registry_heartbeat_timer.autostart = true
	_registry_heartbeat_timer.timeout.connect(_write_registry_entry)
	add_child(_registry_heartbeat_timer)


func _write_registry_entry() -> void:
	if _registry_files.is_empty():
		return
	var entry: Dictionary = {
		"id": _instance_id,
		"projectPath": ProjectSettings.globalize_path("res://"),
		"projectName": ProjectSettings.get_setting("application/config/name"),
		"port": _port,
		"pid": OS.get_process_id(),
		"lastSeen": Time.get_datetime_string_from_system(),
		"godotVersion": Engine.get_version_info().get("string", "unknown"),
		"bridgeVersion": BRIDGE_SCRIPT_VERSION,
		"capabilities": ["registry-heartbeat"],
	}
	var json: String = JSON.stringify(entry, "	")
	for registry_file in _registry_files:
		# Atomic write: temp file -> rename
		var tmp_file: String = registry_file + ".tmp"
		var f: FileAccess = FileAccess.open(tmp_file, FileAccess.WRITE)
		if f == null:
			push_warning("[MCP Bridge] Failed to write registry entry: %s" % FileAccess.get_open_error())
			continue
		f.store_string(json)
		f.close()
		DirAccess.rename_absolute(tmp_file, registry_file)


func _stop_registry_heartbeat() -> void:
	if _registry_heartbeat_timer != null:
		_registry_heartbeat_timer.stop()
		_registry_heartbeat_timer.queue_free()
		_registry_heartbeat_timer = null
	# Clean up registry files on exit
	for registry_file in _registry_files:
		if registry_file != "" and FileAccess.file_exists(registry_file):
			DirAccess.remove_absolute(registry_file)
	_registry_files.clear()


func _dir_ensure(dir: String) -> void:
	if not DirAccess.dir_exists_absolute(dir):
		DirAccess.make_dir_recursive_absolute(dir)

func _stop_server() -> void:
	_stop_registry_heartbeat()
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
		# S4 (2026-06-23): 固定 secret 模式不删除(持久化供下次启动复用 + 与 MCP 端 TTL 缓存保持同步)
		var _persistent_secret := OS.get_environment("GODOT_MCP_BRIDGE_PERSISTENT_SECRET").to_lower() == "true"
		if not _persistent_secret and _secret_file != "" and FileAccess.file_exists(_secret_file):
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
			# 全仓审查 GD I-4 (2026-09-12): 未认证 peer 的空行不是合法流量(auth 是单条
			# JSON 行)——原无条件 continue,未认证 peer 每秒发 "\n" 即借 269 行"任何入站
			# 数据刷新 idle 计时"无限续命,5 个此类连接占满 MAX_PEERS 且 60s 超时永不
			# 触发,合法客户端被永久拒绝(打破"槽位占用均有界"声明)。未认证空行直接
			# 断连;已认证 peer 的空行继续容忍(keepalive 惯例)。慢速散字节路径由
			# MAX_MESSAGE_SIZE buffer 上限兜底(达 1MB 断连)。
			if not _authenticated_peers.has(pid):
				peer.disconnect_from_host()
				_peer_buffers[key] = raw
				return true
			continue
		var line := line_bytes.get_string_from_utf8()
		if line == "" and line_bytes.size() > 0:
			push_warning("[MCP Bridge] Invalid UTF-8 in message from peer %d, disconnecting" % pid)
			peer.disconnect_from_host()
			_peer_buffers[key] = raw
			return true
		if not _authenticated_peers.has(pid):
			# I-9: per-peer lockout —— 用 pid(peer_id) 隔离失败计数与锁定, 而非全局。
			# 全局键会导致单个失败源(错误客户端/攻击者) 5 次失败锁死所有合法客户端 300s(DoS);
			# per-peer 下失败连接自己被锁, 不影响其他客户端。
			# secret 为 256-bit 随机, 暴力不可行, LOCKOUT 仅减速带(非主防线), per-peer 可接受。
			if _auth_locked_until.has(pid):
				var locked_until: float = _auth_locked_until[pid]
				if Time.get_ticks_msec() / 1000.0 < locked_until:
					peer.put_data((JSON.stringify({"id": null, "error": {"code": -32002, "message": "Too many auth failures, temporarily locked"}}) + "\n").to_utf8_buffer())
					peer.disconnect_from_host()
					_peer_buffers[key] = raw
					return true
				else:
					_auth_locked_until.erase(pid)
					_auth_fail_count[pid] = 0
			var parsed: Variant = JSON.parse_string(line)
			var incoming_secret: String = ""
			if parsed is Dictionary and parsed.get("params") is Dictionary:
				incoming_secret = str(parsed["params"].get("secret", ""))
			if parsed is Dictionary and parsed.get("method") == "auth" and _constant_time_compare(incoming_secret, _secret):
				_authenticated_peers[pid] = true
				_auth_fail_count.erase(pid)
				peer.put_data((JSON.stringify({"id": parsed.get("id"), "result": {"authenticated": true}}) + "\n").to_utf8_buffer())
				continue
			else:
				var fails: int = int(_auth_fail_count.get(pid, 0)) + 1
				_auth_fail_count[pid] = fails
				if fails >= MAX_AUTH_FAILS:
					var lockout_time := minf(LOCKOUT_BASE_SECONDS * pow(2.0, (float(fails) / MAX_AUTH_FAILS) - 1.0), LOCKOUT_MAX_SECONDS)
					_auth_locked_until[pid] = Time.get_ticks_msec() / 1000.0 + lockout_time
				peer.put_data((JSON.stringify({"id": null, "error": {"code": -32001, "message": "Authentication required"}}) + "\n").to_utf8_buffer())
				peer.disconnect_from_host()
				_peer_buffers[key] = raw
				return true
		var response := _handle_message(line, pid)
		# P2-4: playtest.step 返回特殊标记 —— 存 pending 延迟 push,不立即 put_data
		# _process 末尾递减 frames_remaining(I-2:加入帧不递减),到 0 时 push 响应(计数器轮询,非 coroutine)
		if response.begins_with("__PLAYTEST_STEP__"):
			var frames := int(response.split("__")[2])
			var _step_report: Array = _pending_playtest_step_report.get("report", [])
			var _step_profile: String = str(_pending_playtest_step_report.get("profile", "debug"))
			_pending_playtest_step_report = {}
			_playtest_step_pending.append({
				"peer_id": peer.get_instance_id(),
				"pid": pid,
				"id": _last_step_request_id,
				"frames_remaining": frames,
				"report": _step_report,  # P2-2: 结构化终态读数,完成响应时求值
				"profile": _step_profile,  # B-1: report 求值按此档位投影
				"_added_this_frame": true,  # I-2 修复:本帧不递减,下一帧才开始计帧
			})
		elif response.begins_with("__PLAYTEST_CONTROL_STEP_UNTIL__"):
			# G1: 从临时变量取 step_until 完整 params 存 pending(_process 轮询 conditions)
			var su_payload: Dictionary = _pending_control_step_until_result
			_pending_control_step_until_result = {}
			_control_step_until_pending.append({
				"peer_id": peer.get_instance_id(),
				"pid": pid,
				"id": _last_step_request_id,
				"frames_remaining": int(su_payload["max_frames"]),
				"max_frames": int(su_payload["max_frames"]),
				"wall_deadline_ms": Time.get_ticks_msec() + int(su_payload["wall_budget_ms"]),
				"conditions": su_payload["conditions"],
				"refreeze": bool(su_payload.get("refreeze", false)),
				"report": su_payload.get("report", []),  # P2-2: 结构化终态读数
				"profile": str(su_payload.get("profile", "debug")),  # B-1: report 求值档位
				"_added_this_frame": true,
			})
		elif response.begins_with("__PLAYTEST_CONTROL_INPUT_SEQ__"):
			# H1: input_sequence 同款登记(_process 逐帧计数注入)
			var isq_payload: Dictionary = _pending_control_input_seq_result
			_pending_control_input_seq_result = {}
			_control_input_seq_pending.append({
				"peer_id": peer.get_instance_id(),
				"pid": pid,
				"id": _last_step_request_id,
				"timeline": isq_payload["timeline"],
				"frames_budget": int(isq_payload["frames_budget"]),
				"wall_deadline_ms": Time.get_ticks_msec() + int(isq_payload["wall_budget_ms"]),
				"refreeze": bool(isq_payload.get("refreeze", false)),
				"frame_counter": 0,
				"applied": [],
				"_added_this_frame": true,  # I-2 同款:登记帧不计数,下一帧起 at_frame=1
			})
		elif response.begins_with("__CALL_METHOD_ASYNC__"):
			# 坑4(2026-08-21 反馈批): call_method await_completion —— fire-and-forget 启动协程,
			# 完成后由协程自身推送响应(不阻塞本 packet 循环;peer 断开则丢响应,同 pending 推送模式)。
			var cm_payload: Dictionary = _pending_call_method_result
			_pending_call_method_result = {}
			var cm_ctx: Dictionary = cm_payload["ctx"]
			_await_call_method_and_respond(peer.get_instance_id(), cm_payload["id"], str(cm_ctx["path"]), cm_ctx["method"], cm_ctx["args"], bool(cm_ctx.get("player_mode", false)))
		elif response.begins_with("__CLICK_VERIFY__"):
			# P3-2 (2026-09-11): click_button real_event 同款 fire-and-forget 协程——
			# press/release 注入 + 等 4 帧读信号计数 + 推送响应。
			var cv_payload: Dictionary = _pending_click_verify_result
			_pending_click_verify_result = {}
			_await_click_verify_and_respond(peer.get_instance_id(), cv_payload["id"], str(cv_payload["path"]))
		else:
			peer.put_data((response + "\n").to_utf8_buffer())
	_peer_buffers[key] = raw
	return false

func _handle_message(raw: String, pid: int) -> String:
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
		"get_scene_stats":
			result = _cmd_get_scene_stats(params)
		"find_nodes":
			result = _cmd_find_nodes(params)
		"get_node_properties":
			result = _cmd_get_node_properties(params)
		"get_node_layout":
			result = _cmd_get_node_layout(params)
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
		"send_touch":
			result = _cmd_send_touch(params)
		"send_drag":
			result = _cmd_send_drag(params)
		"send_text":
			result = _cmd_send_text(params)
		# H1 (2026-08-20) 帧定时输入时间线:开窗+逐帧 at_frame 注入(与 freeze/seed 组合=确定性完全体)
		"send_input_sequence":
			result = _cmd_control_input_sequence(params, pid)
		"wait_for_node":
			result = _cmd_wait_for_node(params)
		"wait_for_property":
			result = _cmd_wait_for_property(params)
		"collect_state":
			result = _cmd_collect_state(params)
		"take_screenshot":
			result = _cmd_take_screenshot(params)
		"get_performance":
			result = _cmd_get_performance()
		"get_viewport_info":
			result = _cmd_get_viewport_info()
		# CMP-2 (2026-08-08): runtime error 捕获——查询/清除游戏运行时错误
		"get_errors":
			result = _cmd_get_errors(params)
		"clear_errors":
			result = _cmd_clear_errors()
		"recording.start":
			result = _cmd_recording_start()
		"recording.stop":
			result = _cmd_recording_stop()
		"monitor.start":
			result = _cmd_monitor_start(params, pid)
		"monitor.stop":
			result = _cmd_monitor_stop(pid)
		"monitor.poll":
			result = _cmd_monitor_poll(pid)
		"watch.start":
			result = _cmd_watch_start(params, pid)
		"watch.stop":
			result = _cmd_watch_stop(pid)
		"watch.poll":
			result = _cmd_watch_poll(pid)
		"find_ui_elements":
			result = _cmd_find_ui_elements(params)
		# P8-1: custom_commands 热加载诊断(内建优先层,custom. 前缀但由内建处理)。
		"custom.list":
			result = _custom_list()
		"click_button":
			result = _cmd_click_button(params)
		# P3-1 (2026-09-11): 弱网注入——包装 MultiplayerPeer 出向注入 latency/loss/jitter
		# (masteryee network_conditioner.gd 移植,MultiplayerPeerExtension 装饰器)
		"network.set_conditions":
			result = _cmd_network_set_conditions(params)
		"network.clear":
			result = _cmd_network_clear()
		"network.status":
			result = _cmd_network_status()
		# P2-4 确定性 playtest 四原语(seed/fixed_delta/snapshot/restore 同步;step 走 coroutine)
		"playtest.seed":
			result = _cmd_playtest_seed(params, pid)
		"playtest.fixed_delta":
			result = _cmd_playtest_fixed_delta(params, pid)
		"playtest.snapshot":
			result = _cmd_playtest_snapshot(params, pid)
		"playtest.restore":
			result = _cmd_playtest_restore(params, pid)
		"playtest.step":
			result = _cmd_playtest_step(params, pid)
		# G1 (2026-08-13) control-first satellite 层(附录 F.1)
		"playtest.freeze":
			result = _cmd_control_freeze(params, pid)
		"playtest.unfreeze":
			result = _cmd_control_unfreeze(params, pid)
		"playtest.step_until":
			result = _cmd_control_step_until(params, pid)
		_:
			# P3-3 (2026-09-11): 未匹配内建时查项目本地命令表(custom. 前缀天然零内建冲突,
			# match 分支优先 = 内建永远赢)。信任边界与 GDA_CALLABLE 同哲学:调用面 = 游戏源码方
			# 在 res://mcp_commands/*.gd 声明的面,agent 只能调已声明命令名,default deny。
			if method.begins_with("custom.") and _custom_index.has(method):
				result = _execute_custom_command(method, params)
			else:
				error = {"code": -32601, "message": "Method not found: %s. 若为新增 method（如 get_node_layout），项目根 mcp_bridge.gd 可能版本过旧，请重新 game_bridge_install 或同步上游 src/scripts/mcp_bridge.gd。" % method}

	# Promote command-level errors to top-level so TS client sees them.
	# TS sendToBridge only checks resp.error (top-level), never result.error.
	if error.is_empty() and result is Dictionary and result.has("error"):
		error = result["error"]
		result = null
	# P2-4: playtest.step 特殊处理 —— 返回哨兵字符串,让 _process_buffer_bytes 启动 coroutine
	if error.is_empty() and result is Dictionary and result.has("__playtest_step__"):
		_last_step_request_id = id
		return "__PLAYTEST_STEP__%d__" % int(result["frames"])
	# G1: step_until 同款哨兵(延迟通道)。完整 result 存临时变量,_process_buffer_bytes 取用存 pending。
	if error.is_empty() and result is Dictionary and result.has("__playtest_control_step_until__"):
		_last_step_request_id = id
		_pending_control_step_until_result = result
		return "__PLAYTEST_CONTROL_STEP_UNTIL__"
	# H1: input_sequence 同款哨兵(延迟通道)。
	if error.is_empty() and result is Dictionary and result.has("__playtest_control_input_seq__"):
		_last_step_request_id = id
		_pending_control_input_seq_result = result
		return "__PLAYTEST_CONTROL_INPUT_SEQ__"
	# 坑4(2026-08-21 反馈批): call_method await_completion 同款哨兵——协程方法等待完成
	# 后才推送真值(await callv 三版本实证可行,见 _await_call_method_and_respond 注释)。
	if error.is_empty() and result is Dictionary and result.has("__call_method_async__"):
		_pending_call_method_result = {"id": id, "ctx": result["__call_method_async__"]}
		return "__CALL_METHOD_ASYNC__"
	# P3-2 (2026-09-11): click_button real_event 同款哨兵——注入真实鼠标事件后需等引擎
	# 处理 2 帧(press/release 各 2)才能读信号计数,延迟推送(见 _await_click_verify_and_respond)。
	if error.is_empty() and result is Dictionary and result.has("__click_verify__"):
		_pending_click_verify_result = {"id": id, "path": result["__click_verify__"]}
		return "__CLICK_VERIFY__"
	if error.is_empty():
		return JSON.stringify({"id": id, "result": result})
	else:
		return JSON.stringify({"id": id, "error": error})


# ─── Command implementations ────────────────────────────────────────────────

func _cmd_ping() -> Dictionary:
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	# A1 (2026-08-19 反馈): pid + project 指纹 —— 多实例并存时客户端可校验响应来自目标实例
	# (9081 曾被先占旧实例劫持,返回的数据属于另一项目,无任何迹象)。
	return {
		"pong": true,
		"version": PROTOCOL_VERSION,
		"bridgeVersion": BRIDGE_SCRIPT_VERSION,
		"scene": scene_path,
		"fps": Engine.get_frames_per_second(),
		"pid": OS.get_process_id(),
		"project": ProjectSettings.globalize_path("res://"),
	}


func _cmd_get_tree(params: Dictionary) -> Variant:
	# B-1 清偿(审查):player 档下整树过滤——不可观察节点整枝剪除(不进树),
	# 可观察节点 info 过字段投影。此前 get_tree 不过投影直接违背"private 不进树"承诺。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var max_depth: int = _int_guarded(params.get("max_depth"), 10)
	var root_node := get_tree().root
	if root_node == null:
		return {"tree": [], "scene": ""}
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	if player_mode and not _observable_in_player(root_node):
		return {"tree": [], "scene": scene_path, "observation_profile": "player"}
	var counter := [0]
	var result: Dictionary = {"tree": [_serialize_node(root_node, max_depth, 0, counter, 2000, player_mode)], "scene": scene_path}
	if player_mode:
		result["observation_profile"] = "player"
	return result


# 批 2 readScene：基于 current_scene 的场景统计（迭代单遍 stack DFS，无爆栈）。只聚合不传树。
# TYPE_WINDOW: typeTopN 字典维护窗口（>2000 停维护字典省内存，nodeCount 仍准确）
# HARD_STOP: OOM 硬停止（nodeCount 绝对上限）。独立于 _serialize_node max_nodes（序列化上限）。
const TYPE_WINDOW: int = 2000
const HARD_STOP: int = 50000

func _cmd_get_scene_stats(_params: Dictionary) -> Variant:
	var scene := get_tree().current_scene
	if scene == null:
		return {"stats": null}  # no current_scene → TS 透传 null 降级
	var node_count: int = 0
	var type_count: Dictionary = {}
	var truncated: bool = false
	# 批 2 M2：Godot 场景树不变量保证无环（节点不能是自己的祖先），stack DFS 不会无限循环；HARD_STOP 兜底防 OOM
	var stack: Array = [scene]
	while stack.size() > 0:
		if node_count >= HARD_STOP:
			truncated = true
			break
		var node: Node = stack.pop_back()
		node_count += 1
		if node_count <= TYPE_WINDOW:
			var cls: String = node.get_class()
			type_count[cls] = int(type_count.get(cls, 0)) + 1
		for c in node.get_children():
			stack.push_back(c)
	var type_top_n: Variant = null
	if node_count <= TYPE_WINDOW:
		var entries: Array = []
		for key in type_count.keys():
			entries.append({"type": key, "n": int(type_count[key])})
		entries.sort_custom(func(a, b): return int(a["n"]) > int(b["n"]))
		type_top_n = entries.slice(0, 5)
	return {
		"stats": {
			"path": scene.scene_file_path,
			"root": scene.name,
			"nodeCount": node_count,
			"typeTopN": type_top_n,
			"truncated": truncated,
		}
	}


func _serialize_node(node: Node, max_depth: int, depth: int, counter: Array, max_nodes: int = 2000, player_mode: bool = false) -> Dictionary:
	if counter[0] >= max_nodes:
		var brief := _node_info(node)
		if player_mode:
			_project_dict(node, brief)  # B-1: 截断 fallback 分支同样投影
		return brief
	counter[0] += 1
	var info := _node_info(node)
	if player_mode:
		_project_dict(node, info)
	if depth < max_depth:
		var children: Array = []
		for child in node.get_children():
			if counter[0] >= max_nodes:
				break
			if player_mode and not _observable_in_player(child):
				continue  # B-1: 不可观察子树整枝剪除(与 find_nodes 级联语义一致)
			children.append(_serialize_node(child, max_depth, depth + 1, counter, max_nodes, player_mode))
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
	# P7 (2026-09-11): 观察 profile——debug 直通现状;player = 可见性级联 + 字段投影。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var profile: String = profile_res["profile"]
	var player_mode := profile == "player"
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var group: String = str(params.get("group", ""))
	var max_results: int = _int_guarded(params.get("limit"), 100)
	if max_results > 500:
		max_results = 500
	# 坑2(2026-08-21 反馈批): 消费 root 参数——限定子树搜索范围(此前声明了却被忽略,
	# 传子树 root 仍从 /root 全树搜返回无关节点)。绝对路径(/root/Main/UI)推荐;
	# 相对路径按 bridge autoload 节点解析。节点不存在时报错而非静默全树。
	var root_path: String = str(params.get("root", ""))
	var start_root: Node = get_tree().root
	if root_path != "":
		start_root = get_node_or_null(root_path)
		if start_root == null:
			return {"error": {"code": -7, "message": "Root node not found: %s (find_nodes 的 root 须为有效节点路径,推荐绝对路径如 /root/Main)" % root_path}}
	# P5-2 (2026-09-11): near 空间查询(gua 移植简化版)——near_node 锚点 + max_distance,
	# 只收 Node2D/3D(有 global_position 的节点),按距离升序,锚点自身排除(找"附近其他"语义)。
	# 距离计算在 GD 侧(TS 不信任坐标重算,节点位置是引擎真相源)。
	var near_node_path: String = str(params.get("near_node", ""))
	var near_anchor: Node = null
	var near_max_distance: float = -1.0
	if near_node_path != "":
		near_anchor = get_node_or_null(near_node_path)
		if near_anchor == null:
			return {"error": {"code": -8, "message": "near_node anchor not found: %s" % near_node_path}}
		if not (near_anchor is Node2D or near_anchor is Node3D):
			return {"error": {"code": -9, "message": "near_node anchor must be Node2D/Node3D (got %s)" % near_anchor.get_class()}}
		near_max_distance = _num(params.get("max_distance"), 1000.0)
		if near_max_distance < 0.0:
			return {"error": {"code": -10, "message": "max_distance must be >= 0 (got %f)" % near_max_distance}}
		# P7 (2026-09-11): near × 投影联动(P5 钩子清偿——P5 时无投影层故注释"不适用",
		# 本批补上)。锚点 position 有任何字段规则(omit/redact/replace/quantize)即拒:
		# 锚点坐标不可信/不可见时测距无意义,且按偏移坐标测距可差分反推真实坐标。
		if player_mode and _position_rule_state(near_anchor) != "":
			return {"error": {"code": -11, "message": "near_node anchor position is under an agent_field_rule and cannot be used for ranging under observation_profile=player (anti distance-differencing)"}}
		# 全仓审查 GD I-2 (2026-09-12): 锚点自身也须可观察——原只查 position 规则漏了
		# private/级联隐藏节点:拿 private 节点当锚点可拿到它与各可观察节点的 distance,
		# 每帧查询即差分追踪 private 节点位置轨迹(穿透 P7 存在性不泄露承诺)。
		# 报错用 not found 语义(与 -8 同款),不泄露"存在但不可见"。
		if player_mode and not _observable_in_player(near_anchor):
			return {"error": {"code": -8, "message": "near_node anchor not found: %s" % near_node_path}}
	var anchor_2d: Node2D = near_anchor as Node2D if near_anchor is Node2D else null
	var anchor_3d: Node3D = near_anchor as Node3D if near_anchor is Node3D else null
	# B-1(2026-09-11 审查): near 是排序型查询——traverse 的 max_results 截断发生在
	# **树序**收集阶段(_traverse_tree 循环条件 results.size()<max_results),若沿用调用方
	# limit(默认 100),命中超 100 时树序第 101+ 里的近距离节点在排序前已被静默丢弃。
	# 修法:near 模式先大上限收集(≤500,受 max_visited 5000 约束),距离排序后再截 limit。
	var near_collect_cap := maxi(max_results, 500) if near_anchor != null else max_results
	var results: Array = _traverse_tree(
		func(node: Node) -> bool:
			# P7: player profile——级联不可观察的节点不进结果;position 被规则的
			# 候选不可测距(与锚点同款防差分反推语义)。
			if player_mode:
				if not _observable_in_player(node):
					return false
				if near_anchor != null and _position_rule_state(node) != "":
					return false
			if pattern != "" and not node.name.match(pattern):
				return false
			if type_filter != "" and not node.is_class(type_filter):
				return false
			if group != "" and not node.is_in_group(group):
				return false
			if near_anchor != null:
				if node == near_anchor:
					return false
				if node is Node2D and anchor_2d != null:
					if node.global_position.distance_to(anchor_2d.global_position) > near_max_distance:
						return false
				elif node is Node3D and anchor_3d != null:
					if node.global_position.distance_to(anchor_3d.global_position) > near_max_distance:
						return false
				else:
					return false  # 近邻查询只收与锚点同维度的节点(2D↔2D / 3D↔3D)
			return true,
		{"max_results": near_collect_cap, "root": start_root}
	)
	if near_anchor != null:
		# 距离升序(gua 同款确定性排序;tie 按节点名)
		var keyed: Array = []
		for node in results:
			var d := 0.0
			if node is Node2D and anchor_2d != null:
				d = (node as Node2D).global_position.distance_to(anchor_2d.global_position)
			elif node is Node3D and anchor_3d != null:
				d = (node as Node3D).global_position.distance_to(anchor_3d.global_position)
			keyed.append({"node": node, "d": d})
		keyed.sort_custom(func(a, b):
			if a["d"] != b["d"]:
				return a["d"] < b["d"]
			return (a["node"] as Node).name < (b["node"] as Node).name)
		results = keyed.map(func(e): return e["node"])
		if results.size() > max_results:
			results.resize(max_results)  # B-1: 排序后截回调用方 limit
	var serialized: Array = []
	for node in results:
		var info: Dictionary = _node_info(node)
		if player_mode:
			_project_dict(node, info)  # P7: 字段投影(omit/redact/replace/quantize)
		if near_anchor != null:
			if node is Node2D and anchor_2d != null:
				info["distance"] = (node as Node2D).global_position.distance_to(anchor_2d.global_position)
			elif node is Node3D and anchor_3d != null:
				info["distance"] = (node as Node3D).global_position.distance_to(anchor_3d.global_position)
		serialized.append(info)
	return {"nodes": serialized, "count": serialized.size()}





## P10: 多人状态同步地基(masteryee sync_state 移植裁剪)。
## 收集约定:节点实现 `_mcp_state() -> Dictionary` 即被收集(游戏侧声明离散状态——
## wave/score/phase 等;浮点位置类建议游戏侧自行量化,或 TS 比对侧用 tolerance 容差,
## 否则 host/client 各自物理步进后浮点不逐位相等,比对永远 false——masteryee 亲读发现的坑)。
## 可选 group(如 "mcp_watch"):组内**无** _mcp_state 的成员记存在性标记(参与节点集比对)。
## 上限 256 节点/嵌套深度 8 防大树爆量;非安全类型(Object)递归降级为 str(),不炸整体 JSON。
func _cmd_collect_state(params: Dictionary) -> Variant:
	var group := str(params.get("group", ""))
	var root := get_tree().root
	if root == null:
		return {"error": {"code": -1, "message": "SceneTree not ready"}}
	var out: Dictionary = {}
	var count := 0
	var truncated := false
	var stack: Array = [root]
	# 全仓审查 GD I-3 (2026-09-12): 树遍历 freed 守卫——_mcp_state() 是 P10 唯一的用户
	# 代码执行点,其内部直接 .free()(非 queue_free)树中节点会让后续 pop 拿到 freed 引用,
	# get_children() 抛 "previously freed instance" 中断整次收集(result=null 静默丢全部
	# 已收集状态)。跳过 freed 节点继续收集,保住部分结果。
	while not stack.is_empty():
		if count >= 256:
			truncated = true  # P10 审查 N-2:静默截断会让两侧同截断产生 in_sync 假阴性——显式标记
			break
		var node: Node = stack.pop_back()
		if node == null or not is_instance_valid(node):
			continue  # 用户 _mcp_state() 内 free 的节点:跳过,收集继续
		for child in node.get_children():
			stack.append(child)
		if node.has_method("_mcp_state"):
			var st: Variant = node.call("_mcp_state")
			if st is Dictionary:
				out[String(node.get_path())] = _state_safe(st, 0)
				count += 1
			else:
				out[String(node.get_path())] = {"__error__": "_mcp_state() must return a Dictionary"}
				count += 1
		elif group != "" and node.is_in_group(group):
			out[String(node.get_path())] = {"__present__": true}
			count += 1
	return {
		"instances": out,
		"count": count,
		"truncated": truncated,
		"collected": out.keys(),
		"game_time_ms": Time.get_ticks_msec(),
	}


## _mcp_state 返回值的递归安全化:Object → str() 降级;深度上限 8;其余原样(JSON 可序列化类型)。
## P10 审查 B-1 清偿(2026-09-12):几何类型(Vector2/3/4 系)**必须走 _jsonify 转 {x,y,z} dict**
## ——裸 Vector2 经 JSON.stringify 退化为 "(10.000001, 20)" 字符串(真机实证,见 send_drag
## 先例),TS 比对侧的数值容差只对 number 生效,字符串退化让容差对位置类完全失效(masteryee
## 坑在核心场景原样复现);转 dict 后分量级数值走容差路径。float 加 is_finite:INF/NaN
## 序列化为 1e99999/null 会漂移值语义(同值 INF 恒判 diff/NaN 静默变 null),降级 str()。
func _state_safe(v: Variant, depth: int) -> Variant:
	if depth > 8:
		return "[depth-limit]"
	if v is Dictionary:
		var d: Dictionary = {}
		for k in (v as Dictionary):
			d[str(k)] = _state_safe((v as Dictionary)[k], depth + 1)
		return d
	if v is Array:
		var a: Array = []
		for item in (v as Array):
			a.append(_state_safe(item, depth + 1))
		return a
	if v is Vector2 or v is Vector2i or v is Vector3 or v is Vector3i or v is Vector4 or v is Vector4i or v is Color:
		return _jsonify(v)
	if v is float and not is_finite(v):
		return str(v)
	if _is_safe_value(v):
		return v
	return str(v)


func _cmd_get_node_properties(params: Dictionary) -> Variant:
	# P7: 观察 profile——player 下不可观察节点报 not found(存在性不泄露:
	# 报 403 等于告诉 agent "这里有个藏起来的节点"),可观察节点的 props 过字段投影。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if player_mode and not _observable_in_player(node):
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
		# 2026-08-07 审查 P2 修复：非 Resource 非 Node 的 Object 子类（如 EditorInterface、
		# 自定义 RefCounted）进 props dict 会致 JSON.stringify 整体失败或泄露对象内部表示。
		# 对齐 :881/:1119 的 _is_safe_value 守卫模式（读取场景用 continue 跳过，非 reject）。
		if not _is_safe_value(val):
			continue
		props[name] = val
	if player_mode:
		_project_dict(node, props)
	return {"properties": props, "node": path}


func _cmd_get_node_layout(params: Dictionary) -> Variant:
	# P7: 观察 profile——与 get_node_properties 同款(不可观察 → not found;可观察 → 投影)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	if not is_instance_valid(node):
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if player_mode and not _observable_in_player(node):
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var data: Dictionary = {}
	data["type"] = node.get_class()
	# visible 横切（P1）：CanvasItem 与 Node3D 各自定义 visible
	if node is CanvasItem or node is Node3D:
		data["visible"] = node.visible
	if node is CanvasItem:
		data["z_index"] = node.z_index
	# 变换字段（P2）：Node2D/Control 各自定义，读取代码相同合并；Node3D 在下面用 Vector3 覆盖。
	if node is Node2D or node is Control:
		data["position"] = _jsonify(node.position)
		data["global_position"] = _jsonify(node.global_position)
		data["rotation"] = _jsonify(node.rotation)
		data["scale"] = _jsonify(node.scale)
	if node is Control:
		data["size"] = _jsonify(node.size)
		data["rect"] = _jsonify(node.get_rect())
		data["anchor_left"] = node.anchor_left
		data["anchor_right"] = node.anchor_right
		data["anchor_top"] = node.anchor_top
		data["anchor_bottom"] = node.anchor_bottom
		data["offset_left"] = node.offset_left
		data["offset_right"] = node.offset_right
		data["offset_top"] = node.offset_top
		data["offset_bottom"] = node.offset_bottom
		data["pivot_offset"] = _jsonify(node.pivot_offset)
	# 独立 if 非 elif（P3）：Sprite2D 同时命中上面的 Node2D 变换层 + 这里的专属层
	if node is Sprite2D:
		data["centered"] = node.centered
		data["offset"] = _jsonify(node.offset)
	if node is Node3D:
		data["position"] = _jsonify(node.position)
		data["global_position"] = _jsonify(node.global_position)
		data["rotation"] = _jsonify(node.rotation)
		data["scale"] = _jsonify(node.scale)
	# 注：global_position 节点未入树时引擎静默返 ZERO，调用方须警惕未入树场景。
	if player_mode:
		_project_dict(node, data)  # P7: layout 键(position/global_position/...)过字段规则
	return {"layout": data, "node": path}


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
	# E-2 (2026-08-14): 属性存在性校验——原实现两道守卫后裸 node.set,拼错属性名是
	# no-op + success:true(三路 editor/headless/bridge 中唯一无存在性校验的,brief :100 P2)。
	# 对齐 headless godot_operations.gd _set_property_with_coerce 的 "Property not found"
	# 拒绝 + editor command_helpers.gd coerce_property_value 四层第 2 层。
	# 批E-fix2 (2026-08-15): -1 不再一票否决——实测 Godot 4.6.3(DIAG6/7/9/11):
	# script static var 不在 get_property_list 但 `prop in node` 为 true 且 instance set
	# 生效;普通 script var(health 等)本就在 list 不受影响。`in` 是引擎存在性真值
	# (拼错名 DIAG8 "healt" in node=false),故 -1 且 not in 才拒;在但无声明类型 → 放行
	# 裸 set 保持旧行为(static var 是调试通道典型写入目标,一票否决是行为回归)。
	# null 值安全(2026-08-16 批 K 实测补证, Godot 4.6.3): in 是"属性存在性"而非
	# "get() 非 null" —— `static var sv = null`/`var v = null` 的 in 均为 true 且
	# set 后 get 立即可读;null 初值不会被 -7 误拒,无需特判。
	# prop_type 未知 → 数学/Object 分派不适用;Array/Dict 输入仍走 coerce(-1 不匹配
	# 任何分支 → null → -8 拒绝,标量透传由引擎 Variant 转换处理,DIAG15 String→int 生效)。
	var prop_type := _get_property_type(node, prop)
	if prop_type == -1 and not prop in node:
		return {"error": {"code": -7, "message": "Property not found: %s on %s" % [prop, node.get_class()]}}
	if not _is_safe_value(value):
		var type_info: String = "null" if value == null else value.get_class()
		return {"error": {"code": -3, "message": "Value type not allowed: %s" % type_info}}
	# 批E-fix1 (2026-08-15): String 输入 → TYPE_OBJECT/数学类型属性拒绝(code -9)。
	# 实测 Godot 4.6.3(DIAG12-14): node.set 数学属性传 "(1, 2)"/"garbage"、Resource 属性传
	# "res://icon.svg" 均静默 no-op(position 仍 (0,0)/texture 不变)但流程返 success——
	# 批E 残余假成功,bridge 是三路中唯一未拦截的。对齐:
	# ① TYPE_OBJECT:headless/editor 对 plain String 报错、res:// String 走 load;bridge
	#   不引入 load(资源路径防护是另两路的 DUPLICATE 副本,bridge 加需同步三份),统一
	#   拒绝并引导走 editor/headless 路径。
	# ② 数学类型:对齐 headless _has_components(String 不在分量类型白名单 → 拒绝),
	#   改用 Array/Dict 分量输入。注:call_method args 侧 _coerce_bridge_single 对
	#   Vector2/3 接受 String(显式构造器),与本处属性 set 的拒绝语义有意不同。
	if value is String:
		if prop_type == TYPE_OBJECT:
			return {"error": {"code": -9, "message": "Property %s expects Resource: String via bridge set_node_property is a silent no-op, use editor/headless path for res:// loading" % prop}}
		elif prop_type in [TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_COLOR, TYPE_PLANE, TYPE_QUATERNION, TYPE_RECT2, TYPE_RECT2I]:
			return {"error": {"code": -9, "message": "Property %s expects math type: String input is a silent no-op, pass Array/Dict components (e.g. [x, y, z])" % prop}}
	# E-2 (2026-08-14): 数学类型 coerce——JSON Array/Dict 输入经 node.set 是静默 no-op
	# 但返 success(Godot 4.x verified,见 command_helpers.gd:93-94 注释)。仅 Array/Dict
	# 输入走转换(null/标量/已是数学类型透传,保持 bridge 原行为);对齐 headless E-1 修复
	# + editor coerce_value_for_property,消灭三路行为撕裂。
	var coerced: Variant = value
	if value is Array or value is Dictionary:
		coerced = _coerce_math_value(prop_type, value)
		if coerced == null:
			return {"error": {"code": -8, "message": "Property %s: cannot coerce %s (missing/null component)" % [prop, value]}}
	node.set(prop, coerced)
	return {"success": true, "node": path, "property": prop}


# E-2 (2026-08-14): 查属性声明类型(get_property_list)。存在性校验(-1=不存在)+
# _coerce_math_value 分派共用。DUPLICATE 副本:对齐 headless godot_operations.gd
# _get_property_type(独立 runtime script,同步维护;bridge autoload 无法 import 同款)。
func _get_property_type(obj: Object, key: String) -> int:
	for p in obj.get_property_list():
		if String(p.get("name", "")) == key:
			return int(p.get("type", TYPE_NIL))
	return -1


# E-2 (2026-08-14): MCP JSON Array/Dict 输入 → Godot 数学类型真转换(DUPLICATE 三副本之一)。
# ⚠️ 三副本同步关系(改任一处须同步另外两处):
#   源(editor 侧):   addons/godot_mcp_server/commands/command_helpers.gd coerce_value_for_property
#   副本(headless):  src/scripts/godot_operations.gd _coerce_math_value
#   副本(bridge 侧): 本文件 _coerce_math_value
# 另:文件内第四份同族 _coerce_bridge_single(call_method args 侧,CMP-9-B)按 ClassDB 方法
# 声明类型逐参数强转(Vector2/3 显式接受 String 构造),与本函数按属性声明类型的分派是
# 不同输入面——同步维护属性 coerce 时勿混淆两份的 String 语义(属性 set 拒绝,args 接受)。
# 对齐 godot_operations.gd _is_safe_value 的既有 DUPLICATE 做法(C-03 同步模式)。
# 与 editor 源版差异(有意,与 headless 副本一致): 按属性声明类型 prop_type 分派而非
# typeof(current);支持 Dict{x,y,z,w}/{r,g/b/a} 输入;补 Vector4i/Rect2/Rect2i 构造。
# 返回 null = Array/Dict 输入但分量缺失/为 null 无法构造(调用方报错拒绝)。
func _coerce_math_value(prop_type: int, value: Variant) -> Variant:
	if not (value is Array or value is Dictionary):
		return value  # 已是数学类型/标量等,透传交 node.set
	var x: Variant = _math_comp(value, 0, "x")
	var y: Variant = _math_comp(value, 1, "y")
	var z: Variant = _math_comp(value, 2, "z")
	var w: Variant = _math_comp(value, 3, "w")
	var r: Variant = _math_comp(value, 0, "r")
	var g: Variant = _math_comp(value, 1, "g")
	var b: Variant = _math_comp(value, 2, "b")
	var a: Variant = _math_comp(value, 3, "a")
	if prop_type == TYPE_VECTOR2:
		if x != null and y != null:
			return Vector2(float(x), float(y))
	elif prop_type == TYPE_VECTOR2I:
		if x != null and y != null:
			return Vector2i(int(x), int(y))
	elif prop_type == TYPE_VECTOR3:
		if x != null and y != null and z != null:
			return Vector3(float(x), float(y), float(z))
	elif prop_type == TYPE_VECTOR3I:
		if x != null and y != null and z != null:
			return Vector3i(int(x), int(y), int(z))
	elif prop_type == TYPE_VECTOR4:
		if x != null and y != null and z != null and w != null:
			return Vector4(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_VECTOR4I:
		if x != null and y != null and z != null and w != null:
			return Vector4i(int(x), int(y), int(z), int(w))
	elif prop_type == TYPE_COLOR:
		# 先 r/g/b/a 键名,再 x/y/z/w(对齐 headless _has_components 两种键名都接受)
		if r != null and g != null and b != null:
			return Color(float(r), float(g), float(b), float(a) if a != null else 1.0)
		if x != null and y != null and z != null:
			return Color(float(x), float(y), float(z), float(w) if w != null else 1.0)
	elif prop_type == TYPE_PLANE:
		if x != null and y != null and z != null and w != null:
			return Plane(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_QUATERNION:
		if x != null and y != null and z != null and w != null:
			return Quaternion(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_RECT2:
		if x != null and y != null and z != null and w != null:
			return Rect2(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_RECT2I:
		if x != null and y != null and z != null and w != null:
			return Rect2i(int(x), int(y), int(z), int(w))
	return null


# E-2: 数学分量读取——Array 按索引,Dict 按 key(x/y/z/w 或 r/g/b/a);越界/缺键/值为 null 返 null。
func _math_comp(value: Variant, index: int, key: String) -> Variant:
	# H-1(2026-09-17 审查):分量取出后必须过类型白名单,容器分量进 float() 即 SCRIPT ERROR
	# (同步分发无异常隔离→result:null)。对齐 _num 先例。
	var out: Variant = null
	if value is Array:
		var arr: Array = value
		if index < arr.size():
			out = arr[index]
	elif value is Dictionary:
		var dict: Dictionary = value
		if dict.has(key):
			out = dict[key]
	if out is int or out is float or (out is String and String(out).is_valid_float()):
		return out
	return null


func _cmd_call_method(params: Dictionary) -> Variant:
	# B-1 清偿(审查):player 档接线——ALLOWED_METHODS 本质是只读方法集(get/get_meta/
	# get_children 等),按入口名归"动作通道"是分类错误(审查 I 教训);player 档下:
	# ①不可观察节点报 not found(存在性不泄露);②结构枚举方法整组拒(树不可见则枚举
	# 语义不成立,get_child 的 index 两档漂移是错位陷阱);③get(prop) 返回值过字段投影。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = []
	if params.get("args") is Array:
		args = params["args"]
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if player_mode and not _observable_in_player(node):
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if player_mode and method in PLAYER_BLOCKED_ENUM_METHODS:
		return {"error": {"code": -22, "message": "Structure-enumeration method '%s' is not available under observation_profile=player (the player-view tree is pruned; enumerate via get_tree with observation_profile=player instead)" % method}}
	# S5 (2026-06-23): env GODOT_MCP_BRIDGE_EXTRA_METHODS 扩展白名单(opt-in,默认只读安全)。
	# ALLOWED_METHODS 设计为只读(get/has_*/get_meta 等),防 call_method 任意执行;信任环境
	# 可显式加方法(如 emit_signal)用此 env。注意 emit_signal 会触发已连接的任意回调,慎用。
	# CMP-9-B (2026-08-08): 同一 env 也覆盖写/副作用方法(take_damage/add_velocity 等),
	# 对标竞品 runtime.call。EXTRA_METHODS_BLOCKLIST 仍是不可覆盖硬底线。
	var _extra_env := OS.get_environment("GODOT_MCP_BRIDGE_EXTRA_METHODS")
	var _extra_ok := false
	if _extra_env != "":
		for _m in _extra_env.split(","):
			if (_m as String).strip_edges() == method:
				_extra_ok = true
				break
	# GDA_CALLABLE (2026-09-11 P1 批): per-node 静态声明白名单(来源 aigengame gda_harness.gd)。
	# 游戏开发者在节点脚本声明 const GDA_CALLABLE := ["take_damage"],bridge 沿脚本基类链
	# 静态读 get_script_constant_map() 枚举(零项目代码执行,default deny:不声明=不可调)。
	# 信任边界:白名单是声明者的断言(副作用由声明方自查,进游戏方 code review),bridge
	# 保证"未声明的方法绝不可调"。粒度比 env 全局白名单细,粒度单位=节点而非进程。
	# BLOCKLIST 仍是不可覆盖硬底线(声明也拦,见下方统一 BLOCKLIST 检查)。
	var _gda_ok := method in _declared_callables(node)
	# P1-6: EXTRA/GDA 声明即使显式列出,危险方法仍拒绝(防 env 误设/声明滥用致 RCE)
	if (_extra_ok or _gda_ok) and method in EXTRA_METHODS_BLOCKLIST:
		# B-2 (2026-08-14): 内层检查——间接调用入口(args[0]=内层方法名)命中 BLOCKLIST 时,
		# 若 args[0] 也是 BLOCKLIST 方法(如 call_thread_safe + set_script),拒绝信息一并标注
		# 内外两层(纵深防御 + 诊断增强)。仅 BLOCKLIST 命中分支内检查,正常方法不受影响。
		var _inner_note := ""
		if args.size() > 0 and args[0] is String and args[0] in EXTRA_METHODS_BLOCKLIST:
			_inner_note = " Inner method '%s' is also blocked." % args[0]
		return {"error": {"code": -6, "message": "Method blocked even with GODOT_MCP_BRIDGE_EXTRA_METHODS / GDA_CALLABLE declaration (dangerous, changes runtime structure; the blocklist is a hard floor no allowlist channel can bypass): %s%s" % [method, _inner_note]}}
	if not method in ALLOWED_METHODS and not _extra_ok and not _gda_ok:
		return {"error": {"code": -2, "message": "Method not allowed: %s (allow via: env GODOT_MCP_BRIDGE_EXTRA_METHODS, or declare const GDA_CALLABLE := [\"%s\"] in the node's script — per-node allowlist, see aigengame GDA_CALLABLE convention)" % [method, method]}}
	if not node.has_method(method):
		# CMP-9-B: did-you-mean(对标竞品 + editor call_method 一致体验),降 AI 重试成本
		var _suggestion := _suggest_bridge_method(node, method)
		var _hint := "Allowed methods: see ALLOWED_METHODS or set GODOT_MCP_BRIDGE_EXTRA_METHODS."
		if _suggestion != "":
			_hint = "Did you mean '%s'? %s" % [_suggestion, _hint]
		return {"error": {"code": -3, "message": "Method not found: %s. %s" % [method, _hint]}}
	if args.size() > 8:
		return {"error": {"code": -4, "message": "Too many arguments (max 8)"}}
	if method == "get" and args.size() > 0 and args[0] is String:
		if _is_blocked_property(args[0]):
			return {"error": {"code": -5, "message": "Blocked property via get(): %s" % args[0]}}
	# CMP-9-B: args 类型强转(对标竞品 coerce_call_args + editor call_method 一致)。
	# 按 ClassDB method 声明类型强转,防 Vector3 传单值/Array 静默变零值(Godot callv 不自动转)。
	var _coerced := _coerce_bridge_args(node, method, args)
	# P0-1 (2026-09-11): callv 参数预检(个数+类型)——coerce 后仍不可达声明的组合,
	# callv 会 push 引擎错误并返回 null,被上层当"成功返回 null"误报(与 void 返回不可区分;
	# aigengame 在 4.6.3 实测:String→int/Dictionary→Object/null→int/JSON array→Array[int] 全中)。
	# 预检放协程检测前,同步 callv 与 await_completion 哨兵两条路径都被覆盖。
	var _precheck := _call_args_precheck_error(node, method, _coerced)
	if _precheck != "":
		return {"error": {"code": -10, "message": "Argument mismatch (%s): %s" % [method, _precheck]}}
	# 坑4(2026-08-21 反馈批): 协程检测——callv 对含 await 的方法在首个 await 处挂起并立即
	# 返回 GDScriptFunctionState(内部类型,is 类型名不可解析,须 get_class() 字符串判定;
	# 4.5.1/4.6.3/4.7.2 三版探针实证:协程返该对象/非协程返真值,协程会自动续跑)。
	# 此前该对象经 _jsonify Object 分支序列化为 {type:"GDScriptFunctionState",...} 无用信息,
	# AI 误以为拿到了返回值(feedback 2026-08-19 四坑之四)。
	#
	# await_completion=true 统一走延迟响应(无论协程与否):await callv 对非协程穿透立返
	# (探针 PROBE4),响应形态恒为 {result, undoable, awaited:true} 一致可判。
	if bool(params.get("await_completion", false)):
		# 哨兵→_poll_peers fire-and-forget 启动 _await_call_method_and_respond,
		# await callv 完成后推送真值(TS 侧 sendToBridge timeout 兜管,长协程注意调大)。
		return {"__call_method_async__": {"path": path, "method": method, "args": _coerced, "player_mode": player_mode}}
	var result: Variant = node.callv(method, _coerced)
	if player_mode and method == "get" and args.size() > 0 and args[0] is String:
		# B-1: player 档 get(prop) 返回值过字段投影(单键 wrapper 复用 dict 投影)
		var wrapper: Dictionary = {str(args[0]): _jsonify(result)}
		_project_dict(node, wrapper)
		result = wrapper.get(str(args[0]), result)
	if result is Object and result.get_class() == "GDScriptFunctionState":
		return {
			"result": null,
			"coroutine": true,
			"undoable": false,
			"note": "method suspended at first await and auto-continues (fire-and-forget); return value not available yet — poll side effects, or pass await_completion=true to wait for it (long coroutine: raise timeout)",
		}
	# CMP-9-B: undoable=false 显式声明(call 不可 undo,对标竞品 + editor call_method 一致)
	return {"result": _jsonify(result), "undoable": false}


## 坑4(2026-08-21 反馈批): call_method 协程等待的延迟响应协程。
## `await node.callv(...)` 三版本实证可行(4.5.1/4.6.3/4.7.2 探针:协程等待返真值/
## 非协程穿透立返)——fire-and-forget 调用(不带 await)时本协程在首个 await 处挂起自动续跑,
## 不阻塞 _poll_peers 的 packet 循环。完成后按 playtest.step pending 同款模式查 peer 推送
## (peer 已断开则丢响应)。节点在等待期间被 free 时守卫退出。
func _await_call_method_and_respond(peer_id: int, id: Variant, path: String, method: String, coerced: Array, player_mode: bool = false) -> void:
	var payload: Dictionary = {}
	var node := get_node_or_null(path)
	if node == null or not is_instance_valid(node):
		payload = {"id": id, "error": {"code": -1, "message": "Node not found (went away during await): %s" % path}}
	else:
		var ret: Variant = await node.callv(method, coerced)
		if player_mode and method == "get" and coerced.size() > 0 and coerced[0] is String:
			# B-1: 协程路径同款投影(与同步路径对称,防 await_completion 旁路)
			var wrapper: Dictionary = {str(coerced[0]): _jsonify(ret)}
			_project_dict(node, wrapper)
			ret = wrapper.get(str(coerced[0]), ret)
		payload = {"id": id, "result": {"result": _jsonify(ret), "undoable": false, "awaited": true}}
	var target_peer: StreamPeerTCP = null
	for p in _peers:
		if p.get_instance_id() == peer_id:
			target_peer = p
			break
	if target_peer == null:
		return  # peer 已断开,丢响应(同 pending 完成推送模式)
	target_peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())


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
	if val is Object:
		# B4 (2026-08-11 审查): 非 Node/非 Resource 的 Object(InputEvent/RegExMatch 等)对齐
		# editor 侧 engine_commands.gd _serialize_return_value 的 Object 分支,返 {type, instance_id}。
		# 原 return val 原样——JSON.stringify 对裸 Object 可能失败或返不可读 str(),
		# bridge/editor 两通道返回结构不一致,AI 跨通道比对踩坑。
		return {"type": val.get_class(), "instance_id": val.get_instance_id()}
	return val


# CMP-9-B (2026-08-08): did-you-mean — 方法不存在时给最接近建议(对标竞品 + editor call_method 一致)。
# String.similarity > 0.6 取最高分。限制扫 node.get_method_list()(已在 line 937 has_method 检查后调用)。
func _suggest_bridge_method(node: Node, target: String) -> String:
	var best := ""
	var best_score := 0.6
	for m in node.get_method_list():
		if m is Dictionary and m.has("name"):
			var name_: String = m["name"]
			var score: float = target.similarity(name_)
			if score > best_score:
				best_score = score
				best = name_
	return best


# CMP-9-B (2026-08-08): args 类型强转(对标竞品 coerce_call_args + editor call_method 一致)。
# 按 ClassDB method 声明类型强转,防 Vector3 传 Array [1,2,3] 或 String "(1,2,3)" 静默变零值。
# 取不到 method info(动态方法)→ 不强转透传(Godot callv 自己处理)。
func _coerce_bridge_args(node: Node, method: String, raw_args: Array) -> Array:
	var methods: Array = node.get_method_list()
	var method_info: Dictionary = {}
	for m in methods:
		if m is Dictionary and m.get("name", "") == method:
			method_info = m
			break
	if method_info.is_empty() or not method_info.has("args"):
		return raw_args
	var declared_args: Array = method_info["args"]
	var coerced: Array = []
	for i in range(raw_args.size()):
		var raw: Variant = raw_args[i]
		if i < declared_args.size() and declared_args[i] is Dictionary:
			var declared_type: int = int(declared_args[i].get("type", TYPE_NIL))
			coerced.append(_coerce_bridge_single(raw, declared_type))
		else:
			coerced.append(raw)
	return coerced


# CMP-9-B: 单个参数强转(与 editor engine_commands.gd _coerce_single_arg 同款逻辑)。
func _coerce_bridge_single(raw: Variant, declared_type: int) -> Variant:
	match declared_type:
		TYPE_VECTOR2:
			if raw is Array and raw.size() >= 2:
				return Vector2(float(raw[0]), float(raw[1]))
			if raw is String:
				return Vector2(raw)
		TYPE_VECTOR2I:
			if raw is Array and raw.size() >= 2:
				return Vector2i(int(raw[0]), int(raw[1]))
		TYPE_VECTOR3:
			if raw is Array and raw.size() >= 3:
				return Vector3(float(raw[0]), float(raw[1]), float(raw[2]))
			if raw is String:
				return Vector3(raw)
		TYPE_VECTOR3I:
			if raw is Array and raw.size() >= 3:
				return Vector3i(int(raw[0]), int(raw[1]), int(raw[2]))
		TYPE_VECTOR4:
			if raw is Array and raw.size() >= 4:
				return Vector4(float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
		TYPE_COLOR:
			if raw is Array and raw.size() >= 3:
				var a: float = float(raw[3]) if raw.size() > 3 else 1.0
				return Color(float(raw[0]), float(raw[1]), float(raw[2]), a)
		TYPE_BOOL:
			if raw is String:
				return raw.to_lower() == "true"
			if raw is float or raw is int:
				return bool(raw)
		TYPE_INT:
			if raw is String:
				# 审查G-3 修复(2026-08-20):裸 int() 部分解析("5px"→5)/失败零值("abc"→0)静默吞;
				# is_valid_int 严格判定,非法保留原值由后续类型不匹配显式暴露
				return int(raw) if (raw as String).is_valid_int() else raw
			if raw is float:
				return int(raw)
		TYPE_FLOAT:
			if raw is String:
				# 同 TYPE_INT:is_valid_float 严格判定
				return float(raw) if (raw as String).is_valid_float() else raw
			if raw is int:
				return float(raw)
		TYPE_STRING:
			return str(raw)
		TYPE_NODE_PATH:
			return NodePath(str(raw))
	return raw


# P0-1 (2026-09-11): coerce 后宽化可达表——源类型 → 引擎 Variant::can_convert_strict
# 允许的目标类型列表。GDScript 无 can_convert_strict API,表为机械转写:
# JSON 6 源行(NIL/BOOL/FLOAT/STRING/ARRAY/DICTIONARY)来自 aigengame gda_harness.gd
# JSON_ARGUMENT_CONVERSIONS(真引擎 callv 一致性矩阵验证过,含"第一版手转写曾误拒
# String→Color、Array→Packed*"的教训);TYPE_INT 行为 _coerce_bridge_single 的
# coerce 产物源(int 可宽化到 float)。未列出的源(VECTOR*/COLOR 等 coerce 产物)
# 只能 identity 匹配——它们仅在 declared 类型即产出类型时出现,无需宽化行。
const _BRIDGE_ARG_STRICT_CONVERSIONS := {
	TYPE_NIL: [TYPE_OBJECT],
	TYPE_BOOL: [TYPE_INT, TYPE_FLOAT],
	TYPE_INT: [TYPE_FLOAT],
	TYPE_FLOAT: [TYPE_BOOL, TYPE_INT],
	TYPE_STRING: [TYPE_STRING_NAME, TYPE_NODE_PATH, TYPE_COLOR],
	TYPE_ARRAY: [
		TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY,
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY,
		TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_COLOR_ARRAY,
		TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_VECTOR4_ARRAY,
	],
	TYPE_DICTIONARY: [],
}


# GDA_CALLABLE (2026-09-11 P1 批): 沿脚本基类链静态枚举声明的可调方法名。
# get_script_constant_map() 是引擎反射(零项目代码执行);GDScript 禁止重声明基类常量,
# 链上最多一处声明,循环收集为防御式写法。static func:行为探针可直接调用。
# 同名约定保持 aigengame 生态互认:用户项目同时被两工具操作时一份声明通用。
static func _declared_callables(node: Node) -> Array:
	var names: Array = []
	var script: Script = node.get_script() as Script
	while script != null:
		var constants: Dictionary = script.get_script_constant_map()
		var declared: Variant = constants.get("GDA_CALLABLE", null)
		if typeof(declared) == TYPE_ARRAY or typeof(declared) == TYPE_PACKED_STRING_ARRAY:
			for entry in declared:
				if typeof(entry) == TYPE_STRING or typeof(entry) == TYPE_STRING_NAME:
					var entry_name := String(entry)
					if not names.has(entry_name):
						names.append(entry_name)
		script = script.get_base_script()
	return names


# P0-1 (2026-09-11): callv 参数预检(个数 + 类型),返回 "" 放行 / 错误描述拒绝。
# static func:不依赖实例状态,行为探针脚本可直接 preload 调用。
# 签名取不到(get_method_list 无该方法,如动态注册)→ 返回 "" 放行,由 callv 自行处理。
static func _call_args_precheck_error(node: Node, method: String, coerced_args: Array) -> String:
	var method_info: Dictionary = {}
	for m in node.get_method_list():
		if m is Dictionary and m.get("name", "") == method:
			method_info = m
			break
	if method_info.is_empty() or not method_info.has("args"):
		return ""
	var declared_args: Array = method_info["args"]
	var defaults: Array = method_info.get("default_args", [])
	var required: int = declared_args.size() - defaults.size()
	var vararg := (int(method_info.get("flags", 0)) & METHOD_FLAG_VARARG) != 0
	if coerced_args.size() < required:
		return ("needs at least %d argument(s); %d supplied" % [required, coerced_args.size()])
	if not vararg and coerced_args.size() > declared_args.size():
		return ("accepts at most %d argument(s); %d supplied" % [declared_args.size(), coerced_args.size()])
	for i in range(mini(coerced_args.size(), declared_args.size())):
		var spec: Dictionary = declared_args[i] if declared_args[i] is Dictionary else {}
		var declared_type := int(spec.get("type", TYPE_NIL))
		var val: Variant = coerced_args[i]
		if declared_type == TYPE_NIL:
			continue  # Variant 参数接受一切
		if (declared_type == TYPE_ARRAY or declared_type == TYPE_DICTIONARY) \
				and int(spec.get("hint", PROPERTY_HINT_NONE)) != PROPERTY_HINT_NONE:
			# typed container:Array/Dict 来自 JSON 永远是无类型的,引擎拒收普通 Array → Array[int]
			return ("argument %d (%s) is a typed %s (%s), which an untyped JSON value cannot satisfy"
				% [i + 1, str(spec.get("name", "")), type_string(declared_type), str(spec.get("hint_string", ""))])
		if typeof(val) == declared_type:
			continue  # identity
		var reachable: Array = _BRIDGE_ARG_STRICT_CONVERSIONS.get(typeof(val), [])
		if not declared_type in reachable:
			return ("argument %d (%s) expects %s, got %s (coerce could not bridge this; refusing rather than letting callv fail silently with null)"
				% [i + 1, str(spec.get("name", "")), type_string(declared_type), type_string(typeof(val))])
	return ""


# ─── Shared tree traversal ──────────────────────────────────────────────────
# Callback receives each node; return true to include in results.
func _traverse_tree(callback: Callable, opts: Dictionary = {}) -> Array:
	var root_node: Node = opts.get("root", get_tree().root) as Node
	var max_results: int = int(opts.get("max_results", 500))
	var max_visited: int = int(opts.get("max_visited", 5000))
	if root_node == null:
		return []
	var results: Array = []
	var stack: Array[Node] = [root_node]
	var visited: int = 0
	while stack.size() > 0 and results.size() < max_results and visited < max_visited:
		var node: Node = stack.pop_back()
		if node == null:
			continue
		visited += 1
		if callback.call(node):
			results.append(node)
		var children := node.get_children()
		for i in range(children.size() - 1, -1, -1):
			stack.append(children[i])
	return results




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
		return false
	return false


# ─── P7 (2026-09-11): 语义观察层 — 投影核心(gua gua.cpp 移植,GD 单文件化) ────
# 设计偏离清单(相对 gua,审查用):
# 1. 投影层位置:C++ registry 对象 → GD bridge 输出通道(分发模型约束,单文件)。
# 2. 坏规则处理:注册时整 policy 拒 → 读时逐条 fail-closed(mode 未知/replace 缺
#    replacement/quantize quantum<=0 均降级 redact——"无法安全应用的规则按 redact 处理",
#    开发者写错规则不会被惩罚成裸暴露)。
# 3. path 体系:gua 世界模型(label/position.x/state.*) → enhanced 输出 dict 键
#    (name/position/text/value/...),支持 position.x/y/z 分量级(仅当值为 Dictionary)。
# 4. QUANTIZE 精确有理数取模 → snapped()(尽调许可的简化)。
# 5. watch 事件 args 不做字段投影(信号参数是位置参数无字段名,无法按 path 匹配;
#    只做可见性过滤——不可观察节点的信号事件不记录。需要隐藏的信号把信号源藏进
#    不可见子树,或不在 player profile 下监听)。
# 6. agent_allowed_actions 位掩码不移植(动作授权走既有三通道白名单:
#    env EXTRA_METHODS / GDA_CALLABLE / BLOCKLIST 硬底线,观察投影只管 read 通道)。

## 解析请求的 observation_profile 参数。返回 {"error": ...} 表示校验失败。
## debug = 现状直通;player = 级联 + 投影全开,需 env GODOT_MCP_BRIDGE_ALLOWED_PROFILES 授权。
## 强制档(host 单值 env)下请求级参数被静默提升为强制档——防 agent 自降级绕过投影。
func _resolve_observation_profile(params: Dictionary) -> Dictionary:
	var profile := str(params.get("observation_profile", "debug")).to_lower()
	if not (profile in OBSERVATION_PROFILES):
		return {"error": {"code": -20, "message": "observation_profile must be \"debug\" or \"player\" (got \"%s\")" % profile}}
	if _forced_profile != "":
		return {"profile": _forced_profile, "forced": true}
	if not (profile in _allowed_profiles):
		return {"error": {"code": -21, "message": "observation_profile \"%s\" is not allowed on this bridge (allowed: %s). Game-side env GODOT_MCP_BRIDGE_ALLOWED_PROFILES declares which observation tiers agents may use." % [profile, ",".join(PackedStringArray(_allowed_profiles))]}}
	return {"profile": profile}

## 读取节点的 agent_field_rules meta 并归一化为 {path: {mode, replacement?, quantum?}}。
## fail-closed 降级原则:mode 未知 / replace 缺 replacement / quantize quantum<=0 → redact。
## 重复 path 后者覆盖(gua 同款);规则数上限 MAX_FIELD_RULES(截断 + warning)。
func _load_field_rules(node: Node) -> Dictionary:
	if not node.has_meta(FIELD_RULES_META):
		return {}
	var raw: Variant = node.get_meta(FIELD_RULES_META)
	if not (raw is Array):
		return {}
	var rules: Dictionary = {}
	var count := 0
	for entry in (raw as Array):
		if not (entry is Dictionary):
			continue
		var e := entry as Dictionary
		var path := str(e.get("path", ""))
		if path == "":
			continue
		count += 1
		if count > MAX_FIELD_RULES:
			push_warning("[MCP Bridge] %s has >%d agent_field_rules, extra rules ignored" % [str(node.get_path()), MAX_FIELD_RULES])
			break
		var mode := str(e.get("mode", "")).to_lower()
		var rule: Dictionary = {}
		match mode:
			"keep":
				continue  # 显式 keep = 无规则(字段原样)
			"omit", "redact":
				rule = {"mode": mode}
			"replace":
				# N-1(审查): replacement 须为安全标量(_is_safe_value)——Object/Node/Resource 型
				# 替值会污染 JSON 输出(声明者自伤,降级 redact 兜底)。
				if e.has("replacement") and _is_safe_value(e["replacement"]):
					rule = {"mode": "replace", "replacement": e["replacement"]}
				else:
					rule = {"mode": "redact"}  # fail-closed: 缺/不安全 replacement 降级
			"quantize":
				var q: Variant = e.get("quantum", null)
				if (q is int or q is float) and float(q) > 0.0:
					rule = {"mode": "quantize", "quantum": float(q)}
				else:
					rule = {"mode": "redact"}  # fail-closed: quantum 非法降级
			_:
				rule = {"mode": "redact"}  # fail-closed: 未知 mode 降级
		rules[path] = rule  # 重复 path 后者覆盖
	return rules

## 对单个值应用非 omit 规则(redact/replace/quantize)。omit 由 _project_dict 删键处理。
func _apply_field_rule(value: Variant, rule: Dictionary) -> Variant:
	match str(rule["mode"]):
		"redact":
			if value is bool:
				return false
			if value is int or value is float:
				return 0
			return "[redacted]"
		"replace":
			return rule["replacement"]
		"quantize":
			if value is int or value is float:
				return snapped(float(value), float(rule["quantum"]))
			return "[redacted]"  # 非数值不可量化 → redact(gua: quantize 仅数值路径)
	return value

## 对输出 dict 应用节点字段规则(原地改)。player profile 专用。
## 整键规则(path == "position")作用于 data[path];分量规则("position.x")仅当
## data[path] 是 Dictionary 时作用于其 x/y/z 子键——位置输出(_node_info/_extract_ui_data/
## monitor 值 jsonify 后)均为 {"x":..,"y":..} 形态。
func _project_dict(node: Node, data: Dictionary) -> void:
	var rules := _load_field_rules(node)
	if rules.is_empty():
		return
	for path in rules.keys():
		var rule: Dictionary = rules[path]
		var parts := (path as String).split(".")
		if parts.size() == 1:
			if data.has(path):
				if rule["mode"] == "omit":
					data.erase(path)
				elif data[path] is Dictionary:
					# 整键规则作用于 dict 值(position/global_position 等向量输出)——逐分量应用
					# (探针 e2e 实测教训:整 dict 直接过 _apply_field_rule 会被 quantize/redact
					# 判非数值 → 整个换 "[redacted]",形状破坏;gua 语义是 position.x/y/z 分量级)。
					# replace 保持整体替换(声明者可给 dict 替值)。
					if rule["mode"] == "replace":
						data[path] = rule["replacement"]
					else:
						var subd: Dictionary = data[path]
						for k in subd.keys():
							subd[k] = _apply_field_rule(subd[k], rule)
				else:
					data[path] = _apply_field_rule(data[path], rule)
		else:
			var base := parts[0]
			var sub := parts[1]
			if data.has(base) and data[base] is Dictionary and (data[base] as Dictionary).has(sub):
				if rule["mode"] == "omit":
					(data[base] as Dictionary).erase(sub)
				else:
					(data[base] as Dictionary)[sub] = _apply_field_rule((data[base] as Dictionary)[sub], rule)

## 可见性级联(player profile):沿 parent 链上溯(含自身,深度上限防异常树),
## 任一祖先 agent_exposure=="private" 或 visible_to_player==false → 整棵子树不可观察。
## 与渲染 visible 正交:两个声明维度是游戏定义的观察语义,不掺 is_visible_in_tree()
## (gua 同款:visible_to_player 是 WorldObject 字段而非渲染状态)。
## 宽容解析:visible_to_player 接受 bool false 或字符串 "false"(防 .tscn 手写陷阱);
## agent_exposure 接受字符串 "private"(均大小写不敏感);其它值 = 默认可见。
func _observable_in_player(node: Node) -> bool:
	var current: Node = node
	var depth := 0
	while current != null and depth < CASCADE_MAX_DEPTH:
		if current.has_meta(EXPOSURE_META):
			if str(current.get_meta(EXPOSURE_META)).to_lower() == "private":
				return false
		if current.has_meta(VISIBLE_META):
			# 类型分支比较:GDScript 4 的 == 不做 String↔bool 隐式转换,裸
			# `v == false` 在 meta 值为字符串时是运行时 Invalid operands 错误(探针实测)。
			var v: Variant = current.get_meta(VISIBLE_META)
			var v_hidden := false
			if v is bool:
				v_hidden = (v as bool) == false
			elif v is String:
				v_hidden = (v as String).to_lower() == "false"
			if v_hidden:
				return false
		current = current.get_parent()
		depth += 1
	return true

## player profile 下 position 的规则状态(""/"omit"/"redact"/"replace"/"quantize")。
## near 查询联动用(P5 钩子清偿):锚点与候选的 position 有任何规则即不可参与测距——
## 防 agent 用距离差分反推隐藏/粗化坐标(gua: "position 被 OMIT 的对象既不能当锚点
## 也不可被测距";enhanced 收紧为任何 position 级规则均排除,quantize 距离同样泄精度)。
func _position_rule_state(node: Node) -> String:
	var rules := _load_field_rules(node)
	for path in rules.keys():
		var p := path as String
		if p == "position" or p.begins_with("position."):
			return str(rules[p]["mode"])
	return ""

## UI role 适配表(gua auto_adapter _control_role 移植 + ProgressBar 扩展)。
## 子类先判(OptionButton/CheckBox/CheckButton/SpinBox 都是 BaseButton/Range 子类)。
func _ui_role(ctrl: Control) -> String:
	if ctrl is OptionButton:
		return "combobox"
	if ctrl is ItemList:
		return "list"
	if ctrl is TabContainer:
		return "tablist"
	if ctrl is CheckBox or ctrl is CheckButton:
		return "checkbox"
	if ctrl is ProgressBar:
		return "progressbar"
	if ctrl is BaseButton:
		return "button"
	if ctrl is Label:
		return "text"
	if ctrl is LineEdit or ctrl is TextEdit:
		return "textbox"
	if ctrl is Slider or ctrl is SpinBox:
		return "slider"
	if ctrl is ScrollContainer:
		return "scrollarea"
	return "panel"

## UI label 提取(gua _control_label 移植;OptionButton 用 name——其 text 是选中项文本,
## 做 label 会与 value 语义混淆)。敏感文本的隐藏走 agent_field_rules(text 规则),
## 不移植 gua 的 META_SENSITIVE(单一机制,防两套标记语义漂移)。
func _ui_label(ctrl: Control) -> String:
	if ctrl is BaseButton and not ctrl is OptionButton:
		return str(ctrl.get("text"))
	if ctrl is Label or ctrl is LineEdit or ctrl is TextEdit:
		return str(ctrl.get("text"))
	return str(ctrl.name)


# ─── Input simulation ──────────────────────────────────────────────────────

func _cmd_send_key(params: Dictionary) -> Variant:
	var key: String = str(params.get("key", ""))
	var pressed: bool = params.get("pressed", true)
	var keycode: int = _key_from_string(key)
	if keycode == 0:
		return {"error": {"code": -1, "message": "Unknown key: %s" % key}}
	var event := InputEventKey.new()
	event.keycode = keycode
	# S6 (2026-06-23): 同时设 physical_keycode,触发用物理键码映射的 input action。
	# Godot 4 推荐 physical_keycode 映射;只设 keycode 在 physical 映射项目里不触发 ui_action。
	event.physical_keycode = keycode
	event.pressed = pressed
	# 反馈批次D (2026-09-17, 批次C审查 Nit3): device=0 对称收口(同 mouse 链;不依赖
	# 引擎对默认 -1 的未文档化规范化)。timeline 注入复用本函数,自动跟随。
	event.device = 0
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


# mouse 按钮值解析:MOUSE_BUTTON 枚举 int(1-9)直通;left/right/middle 字符串映射;非法返 -1。
# 审查G-2 修复(2026-08-20):int() 对 String 裸转得 0(MOUSE_BUTTON_NONE)——button:"left"
# 注入无效事件仍报 success,applied 谎报 ok。集中一处解析,直接调用与 timeline 深预检同享。
func _mouse_button_from_value(v: Variant) -> int:
	if v is int or v is float:
		var i := int(v)
		return i if i >= 1 and i <= 9 else -1
	if v is String:
		var m := {"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE}
		return m.get((v as String).to_lower(), -1)
	return -1


# touch/drag 的 index 预检:非负整数(int 或整值 float;String 数值不收,对齐 button 同款严格语义)
func _is_valid_touch_index(v: Variant) -> bool:
	if v is int:
		return v >= 0
	if v is float:
		return v >= 0.0 and v == float(int(v))
	return false


func _cmd_send_mouse_click(params: Dictionary) -> Variant:
	# 反馈批次C (2026-09-17):x/y 裸 float() 是 2026-09-03 审查 I-C 修复的漏网点
	# (mouse_move/drag 已改 _num 守卫,此处漏改)——null/容器参数触发 SCRIPT ERROR,
	# 同步分发无异常隔离 → 响应静默变 result:null(真机 headless 实证)。对齐 _num 收口。
	var x: float = _num(params.get("x", 0), 0.0)
	var y: float = _num(params.get("y", 0), 0.0)
	var button: int = _mouse_button_from_value(params.get("button", 1))
	if button == -1:
		return {"error": {"code": -1, "message": "Invalid mouse button: %s (use 1-9 or left/right/middle)" % str(params.get("button", 1))}}
	var pressed: bool = params.get("pressed", true)
	var event := InputEventMouseButton.new()
	event.position = Vector2(x, y)
	event.button_index = button
	event.pressed = pressed
	event.global_position = Vector2(x, y)
	# 反馈批次C (2026-09-17,09-10 建议①):显式 device=0 对齐真实鼠标事件(真实事件 device=0;
	# 不设时默认 -1,当前引擎派发链会规范化为 0——真机 4.6.3 实测——但不依赖该未文档化行为)。
	event.device = 0
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y, "button": button}


func _cmd_send_mouse_move(params: Dictionary) -> Variant:
	# 审查 I-C: x/y/button_mask 与 _num 守卫(本函数本批新增 button_mask,同函数同形态一并守卫)
	var x: float = _num(params.get("x", 0), 0.0)
	var y: float = _num(params.get("y", 0), 0.0)
	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	# 反馈批次C (2026-09-17):device=0 对齐真实管线(同 _cmd_send_mouse_click)
	event.device = 0
	# 反馈 2026-08-22 (CardGame2): 可选 button_mask(1=left 2=right 4=middle 位掩码)——
	# move 事件默认不带按键状态,非 drag motion;传掩码可模拟按住拖动(先 press 再带 mask 的 move)。
	var mask := int(_num(params.get("button_mask", 0), 0.0))
	if mask < 0:
		mask = 0
	event.button_mask = mask
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y, "button_mask": mask}


# 阶段2b IMP-11: 触摸事件注入(对齐 recording_commands.gd :197 + recording.ts touch 回放契约)
func _cmd_send_touch(params: Dictionary) -> Variant:
	# 反馈批次C (2026-09-17):x/y 裸 float() 同 _cmd_send_mouse_click 的 I-C 漏网收口
	var x: float = _num(params.get("x", 0), 0.0)
	var y: float = _num(params.get("y", 0), 0.0)
	var pressed: bool = params.get("pressed", true)
	# 审查N-1(对称):index 严格校验,直接调用路径与 timeline 深预检同语义
	if not _is_valid_touch_index(params.get("index", 0)):
		return {"error": {"code": -1, "message": "Invalid touch index: %s (must be non-negative integer)" % str(params.get("index", 0))}}
	var index: int = _int_guarded(params.get("index"), 0)
	var event := InputEventScreenTouch.new()
	event.position = Vector2(x, y)
	event.pressed = pressed
	event.index = index
	# 反馈批次D (2026-09-17, 批次C审查 Nit3): device=0 对称收口(同 mouse 链)。
	# timeline 注入复用本函数,自动跟随。
	event.device = 0
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y, "pressed": pressed, "index": index}


# IMP-11 补全: 触屏拖拽回放载体(对齐 _cmd_send_touch;speed best-effort,Godot 内部可能重算覆盖)
# 反馈 2026-08-22 (CardGame2): relative/speed 曾声明 Array 类型化变量,MCP schema 是 object
# (Dictionary {x,y})——类型化赋值行直接 SCRIPT ERROR(守卫在赋值之后,来不及生效)→游戏侧
# Debugger Break 卡死 + bridge 后续请求全超时。修:Variant 接收 + Array/Dictionary 双形态归一。
# 审查 I-C(2026-09-03): float()/int() 对容器/null 是运行时 SCRIPT ERROR(真机 4.7 实证
# float([1,2])/float({"x":1})/float(null) 全崩;上轮审查 A6「float() 对 null 安全」结论作废)——
# 元素级无守卫会重现顶层形态同源的 bridge 卡死(同步分发无异常隔离)。_num 白名单守卫对齐
# _is_valid_touch_index/_compare_values 先例:仅 int/float/合法数字字符串放行,其余回 fallback。
func _num(v: Variant, fallback: float) -> float:
	if v is int or v is float:
		return float(v)
	if v is String and String(v).is_valid_float():
		return float(v)
	return fallback

# H-2(2026-09-17 审查):int 守卫,对齐 _num 先例——仅整值/合法数字串放行,其余回 fallback。
func _int_guarded(v: Variant, fallback: int) -> int:
	if v is int:
		return v
	if v is float and is_finite(v) and v == floor(v):
		return int(v)
	if v is String and String(v).is_valid_int():
		return int(v)
	return fallback

func _vec2_from_param(v: Variant, fallback: Vector2) -> Vector2:
	if v is Array:
		return Vector2(
			_num(v[0], fallback.x) if v.size() > 0 else fallback.x,
			_num(v[1], fallback.y) if v.size() > 1 else fallback.y)
	elif v is Dictionary:
		return Vector2(_num(v.get("x", fallback.x), fallback.x), _num(v.get("y", fallback.y), fallback.y))
	return fallback

func _cmd_send_drag(params: Dictionary) -> Variant:
	var x: float = _num(params.get("x", 0), 0.0)
	var y: float = _num(params.get("y", 0), 0.0)
	# 审查N-1(对称):index 严格校验,直接调用路径与 timeline 深预检同语义
	if not _is_valid_touch_index(params.get("index", 0)):
		return {"error": {"code": -1, "message": "Invalid drag index: %s (must be non-negative integer)" % str(params.get("index", 0))}}
	var index: int = _int_guarded(params.get("index"), 0)
	# 审查 Minor-10: 归一 fallback 静默无警示——形态非法静默归 (0,0) 且回显归一后值,
	# 调用方无法区分「用户传 0」与「形态错被归零」(如 {"speed":"fast"} 静默零速)。补 warnings。
	var warnings: Array = []
	for vec_key in ["relative", "speed"]:
		if params.has(vec_key):
			var raw_v: Variant = params[vec_key]
			if not (raw_v is Array or raw_v is Dictionary):
				warnings.append("%s has invalid form (%s); fell back to (0,0)" % [vec_key, str(raw_v)])
	var relative := _vec2_from_param(params.get("relative", [0.0, 0.0]), Vector2.ZERO)
	var speed := _vec2_from_param(params.get("speed", [0.0, 0.0]), Vector2.ZERO)
	var event := InputEventScreenDrag.new()
	event.position = Vector2(x, y)
	event.index = index
	# 反馈批次D (2026-09-17, 批次C审查 Nit3): device=0 对称收口(同 mouse 链)。
	# timeline 注入复用本函数,自动跟随。(插在 index 后避开 velocity 行区域——
	# 该行由批A d7b15fa4 改名,分支合并时两侧改动重叠会冲突)
	event.device = 0
	event.relative = relative
	# 跨项目验证发现(2026-09-16 反馈批A,CardGame2 Godot 4.7 真机):InputEventScreenDrag
	# 的引擎属性是 velocity(Godot 3 的 speed 已改名),赋值/读取 speed 直接 SCRIPT ERROR —
	# send_drag 在 Godot 4 上从未真正可用(6f997b4 修的是参数归一化,属性名错漏网)。
	# MCP API 参数名 speed 保持不变(调用方契约),仅引擎属性侧改名。
	event.velocity = speed
	Input.parse_input_event(event)
	# 审查 I-B(2026-09-03): 裸 Vector2 经 JSON.stringify 退化为 "(x, y)" 字符串(真机实证),
	# 走 _jsonify 输出 {"x","y"}(对齐 wait_for_property 先例),响应可结构化消费。
	var resp := {"success": true, "x": x, "y": y, "index": index, "relative": _jsonify(relative), "speed": _jsonify(speed)}
	if warnings.size() > 0:
		resp["warnings"] = warnings
	return resp


func _cmd_send_text(params: Dictionary) -> Variant:
	var text: String = str(params.get("text", ""))
	if text.length() > 1000:
		return {"error": {"code": -1, "message": "Text too long: %d chars (max 1000)" % text.length()}}
	for ch in text:
		var event := InputEventKey.new()
		event.unicode = ch.unicode_at(0)
		# 反馈批次D (2026-09-17): device=0 对称收口(同 _cmd_send_key)
		event.device = 0
		event.pressed = true
		Input.parse_input_event(event)
		event.pressed = false
		Input.parse_input_event(event)
	return {"success": true, "characters": text.length()}


# ─── Wait commands (sync check, not async) ──────────────────────────────────

func _cmd_wait_for_node(params: Dictionary) -> Variant:
	# B-1 清偿(审查):player 档下不可观察节点 exists=false——存在性侧信道封堵
	# (wait 永不满足是诚实语义:玩家视角"不存在"),而非报错(报错即泄露存在)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	var node_exists := node != null
	if node_exists and str(profile_res["profile"]) == "player" and not _observable_in_player(node):
		node_exists = false
	return {"exists": node_exists, "path": path}


func _cmd_wait_for_property(params: Dictionary) -> Variant:
	# B-1 清偿(审查):player 档下不可观察节点报 not found(存在性不泄露);
	# current 显示值与 match 比较均基于投影后值(agent 看到的与比较的一致,
	# 防"显示投影值但按真值 match"的二分探测侧信道)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var path: String = str(params.get("path", ""))
	var prop: String = str(params.get("property", ""))
	var expected: Variant = params.get("value")
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if player_mode and not _observable_in_player(node):
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if _is_blocked_property(prop):
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	var current: Variant = node.get(prop)
	# I-07: Safety check on read value to prevent leaking complex types (Resource, Script, etc.)
	if not _is_safe_value(current):
		return {"match": false, "property": prop, "current": "<unsupported type>", "expected": _jsonify(expected)}
	var shown: Variant = _jsonify(current)
	var match_src: Variant = current
	if player_mode:
		var wrapper: Dictionary = {prop: _jsonify(current)}
		_project_dict(node, wrapper)
		shown = wrapper.get(prop, null)
		match_src = shown  # match 也基于投影后值(防真值二分探测)
	var match_result: bool = str(match_src) == str(expected)
	return {"match": match_result, "property": prop, "current": shown, "expected": _jsonify(expected)}


# ─── Visual ─────────────────────────────────────────────────────────────────

func _cmd_take_screenshot(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", "user://mcp_screenshot.png"))
	# Normalize and check traversal
	var clean_path: String = path.replace("\\", "/").uri_decode()
	if not clean_path.begins_with("user://"):
		return {"error": {"code": -1, "message": "Screenshot path must start with user://"}}
	# Check each segment for traversal
	# 审查 L-2: "user://" 是 7 字符,原 substr(8) 首段永丢首字符("user://foo/x" → 段 ["oo","x"])。
	# 实测无逃逸路径(.. 段仍拒 + 引擎 user 目录沙箱兜底),但本检查是 TS 豁免后唯一段级防线,顺手修正。
	for segment in clean_path.substr(7).split("/"):
		if segment == ".." or segment == ".":
			return {"error": {"code": -1, "message": "Screenshot path contains directory traversal"}}
	var viewport := get_viewport()
	if viewport == null:
		return {"error": {"code": -3, "message": "No active viewport available for screenshot"}}
	var tex := viewport.get_texture()
	if tex == null:
		return {"error": {"code": -3, "message": "Viewport has no render texture (window not yet rendered or headless backend)"}}
	var img := tex.get_image()
	if img == null:
		return {"error": {"code": -3, "message": "Failed to capture viewport image (GPU not ready or window minimized/backgrounded)"}}
	var err := img.save_png(clean_path)
	if err != OK:
		return {"error": {"code": -2, "message": "Failed to save screenshot: error %d" % err}}
	return {"success": true, "path": clean_path, "size": {"x": img.get_width(), "y": img.get_height()}}


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


# ─── CMP-2: runtime error 捕获 (2026-08-08) ──────────────────────────────────

func _cmd_get_errors(params: Dictionary) -> Dictionary:
	if _error_capture == null:
		return {"error": {"code": -32003, "message": "Error capture not initialized"}}
	var since_seq := _int_guarded(params.get("since_seq"), 0)
	var clear := bool(params.get("clear", false))
	return _error_capture.poll(since_seq, clear)


func _cmd_clear_errors() -> Dictionary:
	if _error_capture == null:
		return {"error": {"code": -32003, "message": "Error capture not initialized"}}
	_error_capture.clear()
	return {"status": "ok", "cleared": true}


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


# ─── Monitor commands ───────────────────────────────────────────────────

func _cmd_monitor_start(params: Dictionary, pid: int) -> Variant:
	# P7: 观察 profile——player 下不可观察节点拒(同 not found 语义);采样持续投影
	# (每次采样实时读 meta——战争迷雾类"游戏运行中把对象藏起来"语义对齐 gua 动态过滤)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var profile: String = profile_res["profile"]
	var player_mode := profile == "player"
	var node_path: String = str(params.get("node_path", ""))
	var properties = params.get("properties", [])
	var interval: int = _int_guarded(params.get("interval_frames"), 10)

	if node_path == "":
		return {"error": {"code": -1, "message": "node_path is required"}}
	if not properties is Array or properties.size() == 0:
		return {"error": {"code": -2, "message": "properties must be a non-empty array"}}
	if properties.size() > MONITOR_MAX_PROPERTIES:
		return {"error": {"code": -6, "message": "Too many properties (%d, max %d)" % [properties.size(), MONITOR_MAX_PROPERTIES]}}
	if interval < 1:
		interval = 1
	if interval > 300:
		interval = 300

	var node := get_node_or_null(node_path)
	if node == null:
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}
	if player_mode and not _observable_in_player(node):
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}

	# I-11: filter out blocked property names
	# M-EXPLAIN (2026-09-01): 同时点名被过滤属性(dropped_blocked),返回的 properties
	# 改为实际监控列表(filtered_props)——修复此前返回原始请求列表导致的"谎报监控范围"。
	var filtered_props: Array = []
	var dropped_blocked: Array = []
	for prop in properties:
		if _is_blocked_property(str(prop)):
			if not dropped_blocked.has(prop):
				dropped_blocked.append(prop)
		else:
			filtered_props.append(prop)
	if filtered_props.size() == 0:
		return {"error": {"code": -7, "message": "All requested properties are blocked"}}

	var previous_samples: Array = []
	if _monitor_states.has(pid) and _monitor_states[pid].get("active", false):
		previous_samples = (_monitor_states[pid]["samples"] as Array).duplicate(true)

	# P0-3 (2026-09-11): monitor 采样改游戏时间调度(satellite #378 同款坑修复)。
	# interval_frames 语义 = 60fps 基准下的标称帧间隔,换算 interval_ms(interval_frames * 1000/60):
	# 采样节奏锚定游戏时间而非帧数——窗口期帧率变化时节奏稳定(帧步长会漂移 2-4 倍,尤其
	# freeze 后 fps 读数过期时);tree.paused(游戏暂停/freeze)时游戏时间停走,不烧样本不记过期值。
	# 首个采样点 = 游戏时间推进一个 interval 后(对齐旧 frame_counter 0→interval 才采的行为)。
	var interval_ms := interval * (1000.0 / 60.0)
	_monitor_states[pid] = {
		"active": true,
		"node_path": node_path,
		"properties": filtered_props,
		"interval_frames": interval,
		"interval_ms": interval_ms,
		"elapsed_ms": 0.0,
		"next_sample_ms": interval_ms,
		"advanced_since_sample": false,
		"samples": [],
		"max_samples": MONITOR_DEFAULT_MAX_SAMPLES,
		"profile": profile,  # P7: 采样时按此档位投影
	}
	# P3-6: push 模式注册(monitor.start 带 push:true 时启用主动推送)
	if bool(params.get("push", false)):
		_push_peers[pid] = true

	var result_dict: Dictionary = {
		"monitoring": true,
		"node_path": node_path,
		"properties": filtered_props,
		"dropped_blocked": dropped_blocked,
		"interval_frames": interval,
		# P0-3: 实际调度按游戏时间(60fps 基准换算);paused/freeze 期间游戏时间停走不采样
		"interval_ms": interval_ms,
		"scheduling": "game_time",
		"max_samples": MONITOR_DEFAULT_MAX_SAMPLES,
	}
	if previous_samples.size() > 0:
		result_dict["previous_samples"] = previous_samples
	return result_dict


# M-EXPLAIN (2026-09-01): monitor 数值摘要——让输出自己解释自己(对标 satelliteoflove
# 05f721b:数值摘要说明 min/max 发生时刻)。诚实边界:
# ① 仅标量数值属性(int/float;Vector/Color 经 _jsonify 已是 Dict,跳过不进摘要);
# ② error 样本(node_lost 等)跳过;③ min/max 与既有极值相同时保留首次出现的时刻。
func _monitor_summary(samples: Array, properties: Array) -> Dictionary:
	var summary: Dictionary = {}
	for prop in properties:
		var key := str(prop)
		var best: Dictionary = {}
		for s in samples:
			if not (s is Dictionary):
				continue
			var sd: Dictionary = s
			if sd.has("error"):
				continue
			var values: Dictionary = sd.get("values", {})
			if not values.has(key):
				continue
			var v: Variant = values[key]
			if not (v is int or v is float):
				continue
			var frame := int(sd.get("frame", 0))
			var time := float(sd.get("time", 0.0))
			if best.is_empty():
				best = {"min": v, "max": v, "min_at_frame": frame, "min_at_time": time, "max_at_frame": frame, "max_at_time": time}
			else:
				if v < best["min"]:
					best["min"] = v
					best["min_at_frame"] = frame
					best["min_at_time"] = time
				elif v > best["max"]:
					best["max"] = v
					best["max_at_frame"] = frame
					best["max_at_time"] = time
		if not best.is_empty():
			summary[key] = best
	return summary


func _cmd_monitor_stop(pid: int) -> Variant:
	if not _monitor_states.has(pid):
		return {"monitoring": false, "samples": [], "sample_count": 0, "message": "No active monitor for this peer"}
	var ms: Dictionary = _monitor_states[pid]
	if not ms.get("active", false):
		# I-03: monitor may have auto-stopped; return reason + samples
		var old_samples := (ms["samples"] as Array).duplicate(true)
		var reason := ""
		if old_samples.size() > 0:
			var last: Dictionary = old_samples[-1]
			if last.has("stopped_reason"):
				reason = last["stopped_reason"]
		var msg := "No active monitor"
		if reason != "":
			msg = "Monitor stopped: %s" % reason
		_monitor_states.erase(pid)
		return {
			"monitoring": false,
			"samples": old_samples,
			"sample_count": old_samples.size(),
			"stopped_reason": reason,
			"interval_frames": int(ms.get("interval_frames", 0)),
			"max_samples": int(ms.get("max_samples", 0)),
			"summary": _monitor_summary(old_samples, ms.get("properties", [])),
			"message": msg,
		}
	ms["active"] = false
	# P0-3 (2026-09-11): stop 补采——游戏时间推进过(advanced_since_sample)但最后一次调度
	# 采样没赶上时,stop 时补采终态,防最后一格读数丢失(freeze/游戏暂停下不补:游戏时间
	# 没走过,补出来的只会是过期样本)。不 push(P3-6):poll 返回已携带,推送无意义。
	if bool(ms.get("advanced_since_sample", false)) and not get_tree().paused:
		var _stop_node := get_node_or_null(str(ms["node_path"]))
		if _stop_node != null:
			var _stop_values: Dictionary = {}
			for prop in (ms["properties"] as Array):
				_stop_values[prop] = _jsonify(_stop_node.get(prop))
			if str(ms.get("profile", "debug")) == "player":
				_project_dict(_stop_node, _stop_values)  # P7: 补采同样投影
			(ms["samples"] as Array).append({
				"frame": Engine.get_process_frames(),
				"time": Time.get_ticks_msec() / 1000.0,
				"t_game_ms": float(ms["elapsed_ms"]),
				"values": _stop_values
			})
	var samples := (ms["samples"] as Array).duplicate(true)
	var duration := 0.0
	if samples.size() > 0:
		duration = samples[samples.size() - 1].get("time", 0.0) - samples[0].get("time", 0.0)
	# I-03: extract stopped_reason from last sample
	var stopped_reason: String = ""
	if samples.size() > 0:
		var last: Dictionary = samples[-1]
		if last.has("stopped_reason"):
			stopped_reason = last["stopped_reason"]
	var result_dict: Dictionary = {
		"monitoring": false,
		"samples": samples,
		"sample_count": samples.size(),
		"total_frames": Engine.get_process_frames(),
		"duration_seconds": duration,
		"interval_frames": int(ms.get("interval_frames", 0)),
		"max_samples": int(ms.get("max_samples", 0)),
		"summary": _monitor_summary(samples, ms.get("properties", [])),
	}
	if stopped_reason != "":
		result_dict["stopped_reason"] = stopped_reason
	_monitor_states.erase(pid)
	return result_dict


func _cmd_monitor_poll(pid: int) -> Variant:
	if not _monitor_states.has(pid):
		return {"monitoring": false, "samples": [], "message": "No active monitor for this peer"}
	var ms: Dictionary = _monitor_states[pid]
	if not ms.get("active", false):
		# I-03: return last stopped_reason
		var last_reason: String = ""
		if (ms["samples"] as Array).size() > 0:
			var last: Dictionary = (ms["samples"] as Array)[-1]
			if last.has("stopped_reason"):
				last_reason = last["stopped_reason"]
		var msg := "No active monitor"
		if last_reason != "":
			msg = "Monitor stopped: %s" % last_reason
		return {"monitoring": false, "samples": [], "stopped_reason": last_reason, "message": msg}
	var samples := (ms["samples"] as Array).duplicate(true)
	return {
		"monitoring": true,
		"node_path": str(ms["node_path"]),
		"samples": samples,
		"sample_count": samples.size(),
		"interval_frames": int(ms.get("interval_frames", 0)),
		"summary": _monitor_summary(samples, ms.get("properties", [])),
	}


# --- Signal watch commands (C-07: per-peer) ---

# P3-6: 向启用了 push 模式的 peer 主动推送事件(无需等 poll)
# type: "watch" | "monitor";payload: 事件数据(单个 sample 或 event)
func _push_event_to_peer(pid: int, event_type: String, payload: Dictionary) -> void:
	if not _push_peers.get(pid, false):
		return
	# 找到对应的 peer StreamPeerTCP
	var target_peer: StreamPeerTCP = null
	for p in _peers:
		if p.get_instance_id() == pid:
			target_peer = p
			break
	if target_peer == null:
		return
	if target_peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	var msg := JSON.stringify({
		"jsonrpc": "2.0",
		"method": "bridge/event",
		"params": {"type": event_type, "data": payload}
	}) + "\n"
	target_peer.put_data(msg.to_utf8_buffer())


func _on_watched_signal_0(pid: int) -> void:
	_record_watch_event([], pid)

func _on_watched_signal_1(arg0: Variant, pid: int) -> void:
	_record_watch_event([arg0], pid)

func _on_watched_signal_2(arg0: Variant, arg1: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1], pid)

func _on_watched_signal_3(arg0: Variant, arg1: Variant, arg2: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1, arg2], pid)

func _on_watched_signal_4(arg0: Variant, arg1: Variant, arg2: Variant, arg3: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1, arg2, arg3], pid)


func _record_watch_event(raw_args: Array, peer_id: int) -> void:
	if not _watch_states.has(peer_id):
		return
	var ws: Dictionary = _watch_states[peer_id]
	if not ws.get("active", false):
		return
	# P7: player 档位中途可见性复查——meta 运行时可变(watch 开始后游戏把节点藏起来,
	# 如迷雾推进),不可观察期间的事件静默不记录(不断连,重新可见后自动恢复记录)。
	# args 不做字段投影:信号参数是位置参数无字段名,无法按 path 匹配(设计偏离 #5)。
	if str(ws.get("profile", "debug")) == "player":
		var _src := get_node_or_null(str(ws.get("node_path", "")))
		if _src == null or not _observable_in_player(_src):
			return
	var safe_args: Array = []
	for arg in raw_args:
		safe_args.append(_jsonify(arg))
	var event_dict := {
		"frame": Engine.get_process_frames(),
		"time": Time.get_ticks_msec() / 1000.0,
		"args": safe_args,
	}
	(ws["events"] as Array).append(event_dict)
	# P3-6: push 模式下立即推送(不等 poll)
	_push_event_to_peer(peer_id, "watch", {
		"node_path": str(ws.get("node_path", "")),
		"signal_name": str(ws.get("signal_name", "")),
		"event": event_dict
	})
	if (ws["events"] as Array).size() >= int(ws["max_events"]):
		_do_watch_disconnect(peer_id)
		ws["active"] = false


func _do_watch_disconnect(peer_id: int) -> void:
	if not _watch_states.has(peer_id):
		return
	var ws: Dictionary = _watch_states[peer_id]
	if not ws.get("connected", false):
		return
	var node := get_node_or_null(str(ws.get("node_path", "")))
	if node != null:
		var callable := _get_watch_callable(peer_id)
		var signal_name: String = str(ws.get("signal_name", ""))
		if node.has_signal(signal_name) and node.is_connected(signal_name, callable):
			node.disconnect(signal_name, callable)
	ws["connected"] = false


func _get_watch_callable(peer_id: int) -> Callable:
	var ws: Dictionary = _watch_states.get(peer_id, {})
	var sig_list := []
	var node := get_node_or_null(str(ws.get("node_path", "")))
	var signal_name: String = str(ws.get("signal_name", ""))
	if node != null and node.has_signal(signal_name):
		sig_list = node.get_signal_list()
	for sig_info in sig_list:
		if sig_info.get("name", "") == signal_name:
			var arg_count: int = sig_info.get("args", []).size()
			match arg_count:
				0: return _on_watched_signal_0.bind(peer_id)
				1: return _on_watched_signal_1.bind(peer_id)
				2: return _on_watched_signal_2.bind(peer_id)
				3: return _on_watched_signal_3.bind(peer_id)
				4: return _on_watched_signal_4.bind(peer_id)
				_: return _on_watched_signal_0.bind(peer_id)
	return _on_watched_signal_0.bind(peer_id)


func _cmd_watch_start(params: Dictionary, pid: int) -> Variant:
	# P7: 观察 profile——player 下不可观察节点报 not found(存在性不泄露);
	# 事件记录时复查可见性(meta 运行时可变,watch 开始后中途被藏 → 后续事件不记录)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var profile: String = profile_res["profile"]
	var node_path: String = str(params.get("node_path", ""))
	var signal_name: String = str(params.get("signal_name", ""))
	var max_events: int = _int_guarded(params.get("max_events"), 1000)

	if node_path == "":
		return {"error": {"code": -1, "message": "node_path is required"}}
	if signal_name == "":
		return {"error": {"code": -2, "message": "signal_name is required"}}
	if max_events < 1:
		max_events = 1
	if max_events > 5000:
		max_events = 5000

	var node := get_node_or_null(node_path)
	if node == null:
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}
	if profile == "player" and not _observable_in_player(node):
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}
	if not node.has_signal(signal_name):
		return {"error": {"code": -4, "message": "Signal not found: %s on %s" % [signal_name, node_path]}}

	# If this peer already watching, disconnect first
	if _watch_states.has(pid) and _watch_states[pid].get("active", false):
		_do_watch_disconnect(pid)

	var previous_events: Array = []
	if _watch_states.has(pid) and (_watch_states[pid].get("events") as Array).size() > 0:
		previous_events = (_watch_states[pid]["events"] as Array).duplicate(true)

	# Set state before resolving callable
	_watch_states[pid] = {
		"active": false,
		"node_path": node_path,
		"signal_name": signal_name,
		"events": [],
		"max_events": max_events,
		"connected": false,
		"profile": profile,  # P7: 事件记录时按此档位复查可见性
	}
	# P3-6: push 模式注册(watch.start 带 push:true 时启用主动推送)
	if bool(params.get("push", false)):
		_push_peers[pid] = true

	var callable := _get_watch_callable(pid)
	var err := node.connect(signal_name, callable)
	if err != OK:
		_watch_states.erase(pid)
		return {"error": {"code": -5, "message": "Failed to connect signal: %s (error %d)" % [signal_name, err]}}

	_watch_states[pid]["active"] = true
	_watch_states[pid]["connected"] = true

	var result_dict: Dictionary = {
		"watching": true,
		"node_path": node_path,
		"signal_name": signal_name,
		"max_events": max_events,
	}
	if previous_events.size() > 0:
		result_dict["previous_events"] = previous_events
	return result_dict


func _cmd_watch_stop(pid: int) -> Variant:
	if not _watch_states.has(pid):
		return {"watching": false, "events": [], "event_count": 0, "message": "No active watch for this peer"}
	var ws: Dictionary = _watch_states[pid]
	_do_watch_disconnect(pid)
	ws["active"] = false
	var events := (ws["events"] as Array).duplicate(true)
	var duration := 0.0
	if events.size() > 0:
		duration = events[events.size() - 1].get("time", 0.0) - events[0].get("time", 0.0)
	var result_dict: Dictionary = {
		"watching": false,
		"events": events,
		"event_count": events.size(),
		"node_path": str(ws.get("node_path", "")),
		"signal_name": str(ws.get("signal_name", "")),
		"duration_seconds": duration,
	}
	_watch_states.erase(pid)
	return result_dict


func _cmd_watch_poll(pid: int) -> Variant:
	if not _watch_states.has(pid) or not _watch_states[pid].get("active", false):
		return {"watching": false, "events": [], "message": "No active watch for this peer"}
	var ws: Dictionary = _watch_states[pid]
	var events := (ws["events"] as Array).duplicate(true)
	return {
		"watching": true,
		"node_path": str(ws.get("node_path", "")),
		"signal_name": str(ws.get("signal_name", "")),
		"events": events,
		"event_count": events.size(),
	}


# C-07: cleanup per-peer state on disconnect
func _cleanup_peer_state(pid: int) -> void:
	if _watch_states.has(pid):
		_do_watch_disconnect(pid)
		_watch_states.erase(pid)
	if _monitor_states.has(pid):
		_monitor_states.erase(pid)
	# P3-6: 清理 push 模式注册
	_push_peers.erase(pid)
	# 2026-08-06 审查 P1 修复：playtest physics 锁 peer 断线时必须 restore，否则
	# Engine.physics_ticks_per_second 等全局值永久停留在测试值（游戏变慢到测试 hz 无法恢复）。
	# 2026-08-07 审查 P2 修复：多 peer 场景下只在该 pid 是 playtest 持有者时才还原全局状态，
	# 否则 peer B 断开会误清 peer A 的 physics 锁/snapshot（_playtest_owner_pid 在
	# _cmd_playtest_seed/_cmd_playtest_fixed_delta 时赋值）。
	if pid == _playtest_owner_pid:
		if not _playtest_fixed_delta_saved.is_empty():
			Engine.physics_ticks_per_second = int(_playtest_fixed_delta_saved["physics_ticks_per_second"])
			Engine.max_physics_steps_per_frame = int(_playtest_fixed_delta_saved["max_physics_steps_per_frame"])
			Engine.physics_jitter_fix = float(_playtest_fixed_delta_saved["physics_jitter_fix"])
			_playtest_fixed_delta_saved.clear()
		# 2026-08-07 审查 P1 修复：snapshot 同属 playtest 全局状态，peer 断开必须同步 clear。
		# 否则：(1) _playtest_snapshot（可达 50000 节点×N 属性，数十 MB）永久驻留内存（泄漏）；
		# (2) 后续新 peer 调 playtest.restore 误读到这份陈旧快照，场景已变 → 节点状态损坏。
		if not _playtest_snapshot.is_empty():
			_playtest_snapshot.clear()
		# 2026-08-14 审查 D-4 修复：_playtest_active 复位移出 fixed_delta 分支（与 snapshot.clear
		# 同级）——seed-only/snapshot-only 周期同样要复位。残留 true 会令 _input 跳过录制，
		# recording.start 表面成功但录不到任何事件（静默失效）。
		_playtest_active = false
		_playtest_owner_pid = -1
	# G1 (2026-08-13) control-first:持有者断开时还原 freeze(防游戏永久暂停)+ 清 step_until pending
	if pid == _control_owner_pid:
		_control_frozen = false
		_control_owner_pid = -1
		# 2026-08-14 审查 D-2 修复:还原游戏自身 paused 原值(freeze/开窗介入前保存),
		# 而非硬设 false——覆盖 step_until 开窗中(owner 持有但非 frozen)断线的场景。
		get_tree().paused = _control_paused_saved
		_control_paused_saved = false
		_control_paused_saved_valid = false
		_control_step_until_pending.clear()
		# H1 (2026-08-20):input_sequence pending 同清(owner 断线,开窗/refreeze 一并放弃)
		_control_input_seq_pending.clear()
	# 清理断线 peer 的 pending step entries（防 _process 继续递减无效 frames_remaining）
	if _playtest_step_pending.size() > 0:
		var i: int = _playtest_step_pending.size() - 1
		while i >= 0:
			var entry: Dictionary = _playtest_step_pending[i]
			if int(entry.get("pid", -1)) == pid:
				_playtest_step_pending.remove_at(i)
			i -= 1


# ─── UI discovery commands ──────────────────────────────────────────────

func _extract_ui_data(ctrl: Control) -> Dictionary:
	var data: Dictionary = {
		"path": str(ctrl.get_path()),
		"type": ctrl.get_class(),
		# P7 (2026-09-11): role/label 语义增强(gua auto_adapter 移植)——Playwright a11y
		# tree 的 Godot 手工版,role 是控件类别的稳定语义名(不随 Godot 内部类名漂移),
		# label 是人可读名(text 类控件取 text,容器类取节点名)。全档位输出(语义信息非隐私)。
		"role": _ui_role(ctrl),
		"label": _ui_label(ctrl),
		"visible": ctrl.visible,
		"position": {"x": ctrl.position.x, "y": ctrl.position.y},
		"size": {"x": ctrl.size.x, "y": ctrl.size.y},
		"center": {"x": ctrl.position.x + ctrl.size.x / 2.0, "y": ctrl.position.y + ctrl.size.y / 2.0},
	}
	if ctrl is BaseButton:
		data["text"] = str(ctrl.get("text")) if ctrl.get("text") != null else ""
		data["disabled"] = ctrl.disabled
	elif ctrl is Label:
		data["text"] = ctrl.text
	elif ctrl is Range:
		data["value"] = ctrl.value
		data["min_value"] = ctrl.min_value
		data["max_value"] = ctrl.max_value
		if ctrl is SpinBox:
			data["editable"] = ctrl.editable
	elif ctrl is LineEdit:
		data["text"] = ctrl.text
		data["editable"] = ctrl.editable
		data["max_length"] = ctrl.max_length
	elif ctrl is OptionButton:
		data["text"] = ctrl.text
		data["item_count"] = ctrl.item_count
		var items: Array = []
		for i in range(ctrl.item_count):
			items.append(ctrl.get_item_text(i))
		data["items"] = items
	elif ctrl is ItemList:
		data["item_count"] = ctrl.item_count
	return data


func _cmd_find_ui_elements(params: Dictionary) -> Variant:
	# P7: 观察 profile——player 下不可见级联过滤 + 输出投影;role/label 全档位输出。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	var player_mode := str(profile_res["profile"]) == "player"
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var visible_only: bool = params.get("visible_only", true)
	var max_results: int = _int_guarded(params.get("limit"), 200)
	if max_results > 500:
		max_results = 500

	# A-06: 复用 _traverse_tree + callback 过滤
	var results: Array = _traverse_tree(
		func(node: Node) -> bool:
			if not node is Control:
				return false
			var ctrl: Control = node as Control
			if player_mode and not _observable_in_player(ctrl):
				return false
			if visible_only and not ctrl.visible:
				return false
			if pattern != "":
				var text_to_match := ""
				if "text" in ctrl:
					text_to_match = str(ctrl.get("text"))
				if not ctrl.name.match(pattern) and not text_to_match.match(pattern):
					return false
			if type_filter != "" and not ctrl.is_class(type_filter):
				return false
			return true,
		{"max_results": max_results, "max_visited": 5000}
	)

	var extracted: Array = []
	for node in results:
		var data := _extract_ui_data(node as Control)
		if player_mode:
			_project_dict(node, data)
		extracted.append(data)
	return {"elements": extracted, "count": extracted.size()}


func _cmd_click_button(params: Dictionary) -> Variant:
	var text: String = str(params.get("text", ""))
	var path: String = str(params.get("path", ""))

	var target: BaseButton = null

	if path != "":
		var node := get_node_or_null(path)
		if node == null:
			return {"error": {"code": -1, "message": "Node not found: %s" % path}}
		if not node is BaseButton:
			return {"error": {"code": -2, "message": "Node is not a Button: %s (type: %s)" % [path, node.get_class()]}}
		target = node as BaseButton
	elif text != "":
		var _tree = get_tree()
		if _tree == null:
			return {"error": {"code": -1, "message": "Scene tree not available"}}
		var stack: Array = [_tree.root]
		while stack.size() > 0:
			var node: Node = stack.pop_back()
			# Traverse children first so disabled parents don't block child discovery
			for child in node.get_children():
				stack.append(child)
			if node is BaseButton:
				var btn: BaseButton = node as BaseButton
				if btn.disabled:
					continue  # I-02: skip disabled buttons
				var btn_text := str(btn.get("text")) if btn.get("text") != null else ""
				if btn_text == text and btn.visible:
					target = btn
					break
		if target == null:
			return {"error": {"code": -3, "message": "No visible Button with text \"%s\" found" % text}}
	else:
		return {"error": {"code": -4, "message": "Either text or path is required"}}

	# I-02: skip disabled buttons
	if target.disabled:
		return {"error": {"code": -5, "message": "Button is disabled: %s" % str(target.get_path())}}

	# P3-2 (2026-09-11): real_event=true 走真实输入事件路径——press/release 两个
	# InputEventMouseButton 注入 viewport,走完整引擎输入管道(focus/hover/toggle 状态/
	# button_group 互斥全真实路径)。修复 emit_signal("pressed") 不切换 button_pressed
	# 状态类 bug(CheckBox/RadioButton 点击"成功"但没勾上)。需等引擎处理帧后读信号计数,
	# 走哨兵延迟响应(同 call_method await_completion 模式)。
	if params.get("real_event", false):
		return {"__click_verify__": str(target.get_path())}

	target.emit_signal("pressed")
	return {
		"clicked": true,
		"button_path": str(target.get_path()),
		"button_text": str(target.get("text")) if target.get("text") != null else "",
		"mode": "emit",
	}


# ─── P2-4 确定性 playtest 四原语 ─────────────────────────────────────────────
# seed/fixed_delta/snapshot/restore 同步(不需 await 帧);
# step 走 coroutine(await get_tree().physics_frame),响应延迟 push(见 _process 末尾)。
# 5 个 accept 限制(spec):① 不保信号连接运行时拓扑 ② Resource 用 resource_path ③ 不复活已 free 节点
# ④ 不保 RigidBody 物理速度(靠 seed+fixed_delta 重放) ⑤ monitor samples 不在 snapshot 范围

func _cmd_playtest_seed(params: Dictionary, pid: int) -> Variant:
	# 2026-08-14 审查 D-3 修复：owner 互斥（对齐 freeze :2076-2078）——其他 peer 已持有
	# playtest 时拒绝，防 peer B 静默抢占 owner 覆盖全局 RNG 破坏 peer A 的确定性重放。
	if _playtest_owner_pid != -1 and _playtest_owner_pid != pid:
		return {"error": {"code": -1, "message": "playtest session held by another session (owner_pid=%d)" % _playtest_owner_pid}}
	var seed_value: int = _int_guarded(params.get("seed"), 0)
	seed(seed_value)  # @GlobalScope.seed,影响全局 randi/randf
	_playtest_active = true
	# 2026-08-07 审查 P2 修复：记录 playtest 持有者，_cleanup_peer_state 只在 owner 断开时还原
	_playtest_owner_pid = pid
	return {"success": true, "seed": seed_value, "note": "global RNG seeded (per-instance RandomNumberGenerator unaffected)"}

func _cmd_playtest_fixed_delta(params: Dictionary, pid: int) -> Variant:
	# 2026-08-14 审查 D-3 修复：owner 互斥（同 _cmd_playtest_seed，防抢占 physics 锁）
	if _playtest_owner_pid != -1 and _playtest_owner_pid != pid:
		return {"error": {"code": -1, "message": "playtest session held by another session (owner_pid=%d)" % _playtest_owner_pid}}
	var hz: int = _int_guarded(params.get("hz"), 60)
	if hz < 1 or hz > 1000:
		return {"error": {"code": -1, "message": "hz must be 1-1000, got %d" % hz}}
	# 保存原值(restore 时还原)
	if _playtest_fixed_delta_saved.is_empty():
		_playtest_fixed_delta_saved = {
			"physics_ticks_per_second": Engine.physics_ticks_per_second,
			"max_physics_steps_per_frame": Engine.max_physics_steps_per_frame,
			"physics_jitter_fix": Engine.physics_jitter_fix,
		}
	# 三连:固定 tick 率 + 单帧单步 + 关 jitter(每帧恰好 1 个 physics tick,delta = 1/hz)
	Engine.physics_ticks_per_second = hz
	Engine.max_physics_steps_per_frame = 1
	Engine.physics_jitter_fix = 0.0
	_playtest_active = true
	# 2026-08-07 审查 P2 修复：记录 playtest 持有者（同 _cmd_playtest_seed）
	_playtest_owner_pid = pid
	return {"success": true, "hz": hz, "delta": 1.0 / float(hz)}

const PLAYTEST_SNAPSHOT_HARD_STOP: int = 50000  # 对齐 _cmd_get_scene_stats 上限，防大场景 OOM/栈溢

func _cmd_playtest_snapshot(params: Dictionary, pid: int) -> Variant:
	# 2026-08-14 审查 D-3 修复：snapshot-only peer 也登记 owner（首个 playtest 操作者语义）。
	# 此前 snapshot 不登记 → snapshot-only peer 断线走不到 `pid == _playtest_owner_pid`
	# 清理分支 → 数十 MB 快照永久驻留 + 陈旧快照被新 peer restore 写坏场景。
	# B-1 清偿(审查):player 档拒——snapshot 复用 properties 序列化器快照整树真值,
	# 投影快照无法保真 restore(语义冲突:restore 会把投影值写回游戏),诚实拒绝。
	var snap_profile := _resolve_observation_profile(params)
	if snap_profile.has("error"):
		return snap_profile
	if str(snap_profile["profile"]) == "player":
		return {"error": {"code": -23, "message": "playtest.snapshot is not available under observation_profile=player (snapshots must be faithful for restore; a projected snapshot would write projected values back into the game)"}}
	if _playtest_owner_pid == -1:
		_playtest_owner_pid = pid
	# 复用 _cmd_get_node_properties 序列化器:遍历场景树,每个节点存 {properties, parent}
	_playtest_snapshot.clear()
	var root := get_tree().root
	_collect_node_snapshot(root, "")
	var truncated: bool = _playtest_snapshot.size() >= PLAYTEST_SNAPSHOT_HARD_STOP
	return {"success": true, "nodes": _playtest_snapshot.size(), "truncated": truncated, "note": "snapshot saved (signals/physics/freed nodes not preserved)"}

func _collect_node_snapshot(node: Node, parent_path: String) -> void:
	# 2026-08-06 审查 P1 修复：节点数上限守卫，防大场景递归栈溢出/OOM
	# （对齐 _cmd_get_scene_stats HARD_STOP=50000 模式）
	if _playtest_snapshot.size() >= PLAYTEST_SNAPSHOT_HARD_STOP:
		push_warning("[mcp_bridge] playtest snapshot hit HARD_STOP=%d, truncating (large scene may OOM)" % PLAYTEST_SNAPSHOT_HARD_STOP)
		return
	var path: String = str(node.get_path())
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
		# 2026-08-07 审查 P2 修复：同 _cmd_get_node_properties(:823)，非安全 Object 子类
		# 进 snapshot dict 会致后续 JSON.stringify 整体失败。读取场景用 continue 跳过。
		if not _is_safe_value(val):
			continue
		props[name] = val
	_playtest_snapshot[path] = {"properties": props, "parent": parent_path}
	for child in node.get_children():
		_collect_node_snapshot(child, path)

func _cmd_playtest_restore(params: Dictionary, pid: int) -> Variant:
	# 2026-08-14 审查 D-3 修复：restore 受 owner 互斥约束（全局快照属 owner，防任意 peer
	# 抢先 restore 把他人快照写进场景）。
	# B-1 清偿(审查):player 档拒——与 snapshot 对称(保真语义)。
	var restore_profile := _resolve_observation_profile(params)
	if restore_profile.has("error"):
		return restore_profile
	if str(restore_profile["profile"]) == "player":
		return {"error": {"code": -23, "message": "playtest.restore is not available under observation_profile=player (restore must write faithful values; see snapshot's note)"}}
	if _playtest_owner_pid != -1 and _playtest_owner_pid != pid:
		return {"error": {"code": -1, "message": "playtest session held by another session (owner_pid=%d)" % _playtest_owner_pid}}
	if _playtest_snapshot.is_empty():
		return {"error": {"code": -1, "message": "No snapshot saved. Call playtest_snapshot first."}}
	var restored: int = 0
	var skipped_freed: int = 0
	for path in _playtest_snapshot.keys():
		var entry: Dictionary = _playtest_snapshot[path]
		var node := get_node_or_null(path)
		if node == null:
			skipped_freed += 1  # 限制 ③:不复活已 free 节点
			continue
		var props: Dictionary = entry["properties"]
		for prop_name in props.keys():
			if prop_name in BLOCKED_PROPERTIES:
				continue  # 安全命脉:restore 跳过 BLOCKED_PROPERTIES(防 script 注入 RCE)
			# 2026-08-07 审查 P1 修复：snapshot 时 _collect_node_snapshot(:1718-1721) 把
			# Resource 转成 {"type":..,"path":..} 字典、Node 转成路径 String。restore 必须
			# 反向转换，否则字典/字符串原样 set 给 Resource/Node 类型属性 → 类型不匹配 →
			# 节点 invisible / mesh 缺失 / 状态损坏（playtest restore 对真实场景基本不可用）。
			var val: Variant = props[prop_name]
			if val is Dictionary and val.has("type") and val.has("path"):
				# Resource 占位：按 resource_path load 回来；空 path 或 load 失败则跳过不损坏
				var res_path: String = String(val["path"])
				if res_path.is_empty():
					continue
				var r: Resource = load(res_path)
				if r != null:
					val = r
				else:
					continue  # Resource load 失败（路径变/资源删），跳过不损坏原属性
			elif val is String and String(val).begins_with("/root/"):
				# Node 引用占位：跨 restore 无法复活（原节点可能已 free/路径变），跳过不损坏
				continue
			node.set(prop_name, val)
		restored += 1
	# 还原 fixed_delta 原值
	if not _playtest_fixed_delta_saved.is_empty():
		Engine.physics_ticks_per_second = int(_playtest_fixed_delta_saved["physics_ticks_per_second"])
		Engine.max_physics_steps_per_frame = int(_playtest_fixed_delta_saved["max_physics_steps_per_frame"])
		Engine.physics_jitter_fix = float(_playtest_fixed_delta_saved["physics_jitter_fix"])
		_playtest_fixed_delta_saved.clear()
	# 2026-08-14 审查 D-4 修复：restore 完成 = playtest 周期结束，复位 _playtest_active。
	# 此前 seed→restore 后残留 true → _input 持续跳过录制 → recording.start 静默失效。
	_playtest_active = false
	return {"success": true, "restored": restored, "skipped_freed": skipped_freed}

# P2-2 (2026-09-11): report 结构化搭车——step/step_until 响应自带终态读数,省掉紧随
# 其后的观察调用往返(来源 satellite mcp_game_bridge.gd report 搭车;求值时机在响应
# 构造处=推进完成后,读数反映最后一处理帧)。刻意用结构化 {path, property}(对齐
# step_until conditions 的 RCE 规避边界,不引入 Expression——Erodenn 规则表把
# Expression 列 Tier 1 hard_block);属性过 _is_blocked_property(同 set_node_property);
# 逐条失败不炸整调用(单条带 error 字段)。
const _REPORT_MAX_ENTRIES := 16

## 校验 report 参数:[ok: bool, validated: Array | error_dict]
func _validate_report_spec(params: Dictionary) -> Array:
	var raw: Variant = params.get("report", [])
	if raw == null or not (raw is Array) or (raw as Array).is_empty():
		return [true, []]  # 未带 report = 不搭车
	var arr: Array = raw
	if arr.size() > _REPORT_MAX_ENTRIES:
		return [false, {"error": {"code": -1, "message": "report exceeds %d entries" % _REPORT_MAX_ENTRIES}}]
	var out: Array = []
	for e in arr:
		if not (e is Dictionary) or not (e as Dictionary).has("path") or not (e as Dictionary).has("property"):
			return [false, {"error": {"code": -1, "message": "each report entry must be {path, property}"}}]
		var edict: Dictionary = e
		var rpath := str(edict["path"])
		var rprop := str(edict["property"])
		if rpath.is_empty() or rprop.is_empty():
			return [false, {"error": {"code": -1, "message": "report path/property must be non-empty strings"}}]
		if _is_blocked_property(rprop):
			return [false, {"error": {"code": -1, "message": "report property is blocked: %s" % rprop}}]
		out.append({"path": rpath, "property": rprop})
	return [true, out]

## 求值:逐条读节点属性(结构化,无 Expression);失败条目带 error 不炸整列表。
## B-1 清偿(审查):profile=player 时不可观察节点报 not found(存在性不泄露),
## 可观察节点值过字段投影——report 搭车与六读通道同语义,无旁路。
func _eval_structured_report(specs: Array, profile: String = "debug") -> Array:
	var player_mode := profile == "player"
	var out: Array = []
	for e in specs:
		var edict: Dictionary = e
		var rpath := str(edict["path"])
		var rprop := str(edict["property"])
		var n := get_node_or_null(rpath)
		if n == null or not is_instance_valid(n):
			out.append({"path": rpath, "property": rprop, "error": "node not found/freed"})
			continue
		if player_mode and not _observable_in_player(n):
			out.append({"path": rpath, "property": rprop, "error": "node not found/freed"})
			continue
		if not (rprop in n):
			out.append({"path": rpath, "property": rprop, "error": "property not found"})
			continue
		var value: Variant = _jsonify(n.get(rprop))
		if player_mode:
			var wrapper: Dictionary = {rprop: value}
			_project_dict(n, wrapper)
			value = wrapper.get(rprop, null)
		out.append({"path": rpath, "property": rprop, "value": value})
	return out


func _cmd_playtest_step(params: Dictionary, pid: int) -> Dictionary:
	# 2026-08-14 审查 D-6 修复：frozen 守卫——冻结中 step 的帧递减不感知 paused，
	# 游戏未推进却返 success（假成功）。入口明确报错，引导先 unfreeze。
	if _control_frozen:
		return {"error": {"code": -1, "message": "game is frozen; unfreeze before stepping"}}
	# 全仓审查 GD M-2 (2026-09-12): step 补 owner 互斥——seed/fixed_delta/snapshot/restore
	# 均有,唯独 step 没有:owner A 确定性重放期间其他 peer 的 step 可推进帧破坏帧对齐。
	# 对齐 playtest 域 owner 语义(:3417 seed 同款)。
	if _playtest_owner_pid != -1 and _playtest_owner_pid != pid:
		return {"error": {"code": -1, "message": "playtest session held by another session (owner_pid=%d)" % _playtest_owner_pid}}
	# step 走延迟响应:_handle_message 返回哨兵字符串,_process_buffer_bytes 存 pending,
	# _process 每帧递减 frames_remaining(I-2 修复:加入帧不递减,下一帧起计),到 0 时 push 响应。
	# 非真 await physics_frame coroutine(bridge TCP 同步模型不支持),而是 _process 计数器轮询,
	# 每个递减对应一次 _process 调用 ≈ 推进一帧(physics 在 _process 前由引擎跑)。
	var frames: int = _int_guarded(params.get("frames"), 1)
	if frames < 1 or frames > 60:
		return {"error": {"code": -1, "message": "frames must be 1-60, got %d" % frames}}
	# P2-2: report 参数校验(结构化终态读数);经临时变量随哨兵传 pending(数组走不了字符串编码)
	var vr: Array = _validate_report_spec(params)
	if not bool(vr[0]):
		return vr[1]
	# B-1 清偿(审查): profile 随 report 传 pending——player 档下 report 搭车读数同样
	# 过可见性 + 投影(防"六通道都投影了,report 直读真值"的旁路)。
	var profile_res := _resolve_observation_profile(params)
	if profile_res.has("error"):
		return profile_res
	_pending_playtest_step_report = {"report": vr[1], "profile": str(profile_res["profile"])}
	return {"__playtest_step__": true, "frames": frames}


# ─── G1 (2026-08-13) control-first satellite 层(附录 F.1)─────────────────
# freeze/unfreeze/step_until:借鉴 satellite mcp_game_bridge.gd,叠加到 enhanced determinism-first。
# process_mode=PROCESS_MODE_ALWAYS(_ready 设)保证 freeze 时 bridge _process 继续。
# step_until 用结构化条件 {path,property,op,value}[](AND),不引入 Expression(规避白名单绕过 + RCE)。
const _CONTROL_MAX_FRAMES := 600  # step_until 帧上限(~10s@60fps)
const _CONTROL_DEFAULT_WALL_BUDGET_MS := 30000  # wall 兜底(防 time_scale=0/暂停饿死)
const _CONTROL_ALLOWED_OPS := ["==", "!=", "<", ">", "<=", ">="]

func _cmd_control_freeze(params: Dictionary, pid: int) -> Dictionary:
	# owner 独占:已有其他 owner 持有 → 拒(防多 peer 冲突)
	if _control_owner_pid != -1 and _control_owner_pid != pid:
		return {"error": {"code": -1, "message": "control layer held by another session (owner_pid=%d)" % _control_owner_pid}}
	# 可靠性审查修复(2026-08-20):开窗期间 freeze 拒——bridge PROCESS_MODE_ALWAYS 下
	# frame_counter 照走、事件照注入(游戏不消费)→ 时间线假成功;对齐 step 的 D-6 frozen 守卫范式
	if not _control_input_seq_pending.is_empty() or not _control_step_until_pending.is_empty():
		return {"error": {"code": -1, "message": "control layer busy: input sequence / step_until in flight; finish before freeze"}}
	_control_owner_pid = pid
	# 2026-08-14 审查 D-2 修复:freeze 前保存游戏自身 paused 原值(在置 true 之前)。
	# saved_valid 防"冻结中重复 freeze"把维持中的 true 覆盖真实原值。
	if not _control_paused_saved_valid:
		_control_paused_saved = get_tree().paused
		_control_paused_saved_valid = true
	# P2-3(审查 I-1 修正): 仅新 freeze 会话(此前未 frozen)重置计数/起点——重复 freeze
	# (frozen 下再发 freeze,常见操作)不清已有会话的竞争历史,unfreeze 报整段会话终值。
	if not _control_frozen:
		_freeze_contested_count = 0
		_freeze_started_ms = Time.get_ticks_msec()
	_control_frozen = true
	get_tree().paused = true  # freeze:每帧 _process 重设(防游戏代码解 pause)
	return {"success": true, "frozen": true}

func _cmd_control_unfreeze(params: Dictionary, pid: int) -> Dictionary:
	# 仅 owner 可 unfreeze(防 peer B 误清 peer A 的 freeze)
	if _control_owner_pid != -1 and _control_owner_pid != pid:
		return {"error": {"code": -1, "message": "control layer held by another session (owner_pid=%d)" % _control_owner_pid}}
	_control_frozen = false
	_control_owner_pid = -1
	# 2026-08-14 审查 D-1 (P1) 修复:unfreeze 即放弃控制,必须清 step_until pending。
	# 否则残留 pending 完成时会 refreeze(重新置 frozen+paused)而 owner 已=-1,
	# 游戏永久暂停无人能解(owner 断线路径 _cleanup_peer_state 已有 clear,此路径
	# 此前漏了,两路径不对称)。
	_control_step_until_pending.clear()
	# H1 (2026-08-20):input_sequence pending 同理必清(refreeze 复活同款风险)
	_control_input_seq_pending.clear()
	# 2026-08-14 审查 D-2 修复:还原游戏自身 paused 原值,而非硬设 false
	# (防游戏暂停菜单/回合制自身暂停状态被清——菜单开着但游戏在跑)。
	# Nit-A (2026-08-14 审查补修):仅 saved_valid 时才还原 paused——(a) 从未 freeze
	# (owner=-1 放行)直接 unfreeze;(b) 非 refreeze step_until 完成已清 S/V 后 owner
	# 空转持有期间游戏自行 paused。两种边缘下无有效原值,无条件还原会把游戏自暂停
	# 清成过期的 false。S/V 清除不受守卫影响(无论是否还原都要清)。
	if _control_paused_saved_valid:
		get_tree().paused = _control_paused_saved
	_control_paused_saved = false
	_control_paused_saved_valid = false
	# P2-3: 报 freeze 会话终值——contested_reasserts>0 说明游戏代码对抗过 freeze
	# (每帧维持下每漏一帧计一次);frozen_for_ms 为真实墙钟持冻时长。
	var _frozen_for_ms: int = _freeze_started_ms
	var _final_contested: int = _freeze_contested_count
	_freeze_contested_count = 0
	_freeze_started_ms = 0
	return {"success": true, "frozen": false, "frozen_for_ms": (Time.get_ticks_msec() - _frozen_for_ms) if _frozen_for_ms > 0 else 0, "contested_reasserts": _final_contested}

func _cmd_control_step_until(params: Dictionary, pid: int) -> Dictionary:
	# owner 独占
	if _control_owner_pid != -1 and _control_owner_pid != pid:
		return {"error": {"code": -1, "message": "control layer held by another session (owner_pid=%d)" % _control_owner_pid}}
	var conditions: Variant = params.get("conditions", [])
	if not (conditions is Array) or conditions.size() == 0:
		return {"error": {"code": -1, "message": "conditions must be a non-empty array of {path,property,op,value}"}}
	# 校验每个 condition(结构化,不引入 Expression)
	var validated: Array = []
	for cond in conditions:
		if not (cond is Dictionary):
			return {"error": {"code": -1, "message": "each condition must be an object {path,property,op,value}"}}
		var cdict: Dictionary = cond
		if not (cdict.has("path") and cdict.has("property") and cdict.has("op") and cdict.has("value")):
			return {"error": {"code": -1, "message": "condition missing required key (path/property/op/value)"}}
		var op := str(cdict["op"])
		if not _CONTROL_ALLOWED_OPS.has(op):
			return {"error": {"code": -1, "message": "op must be one of %s, got %s" % [str(_CONTROL_ALLOWED_OPS), op]}}
		if not _is_safe_value(cdict["value"]):
			return {"error": {"code": -1, "message": "condition value failed _is_safe_value (几何/标量/PackedArray only)"}}
		validated.append(cdict)
	var max_frames: int = _int_guarded(params.get("max_frames"), _CONTROL_MAX_FRAMES)
	if max_frames < 1 or max_frames > _CONTROL_MAX_FRAMES:
		return {"error": {"code": -1, "message": "max_frames must be 1-%d, got %d" % [_CONTROL_MAX_FRAMES, max_frames]}}
	var wall_budget_ms: int = _int_guarded(params.get("wall_budget_ms"), _CONTROL_DEFAULT_WALL_BUDGET_MS)
	# 2026-08-14 审查 D-5 修复：上限压 50s（clamp）。等待期 bridge 无字节往来，60s 会被
	# 同文件 INACTIVITY_TIMEOUT=60.0 idle 断连切断（响应丢失+状态突变），压到 50s 留 10s 余量。
	wall_budget_ms = clampi(wall_budget_ms, 1000, 50000)
	# step_until:临时解 pause 开窗让游戏跑(若原 frozen,记 refreeze 完成时恢复)。
	# _process 每帧求值 conditions,满足/帧尽/wall 超时 → push 响应 + (若 refreeze)re-freeze。
	var refreeze: bool = _control_frozen
	# P2-2(审查 B-1 修正): report 校验必须在开窗副作用**之前**——校验失败直接返回 error,
	# 若已开窗(refreeze 丢弃)则 freeze 永久丢失且调用方以为未生效。对齐 conditions 校验位置。
	# 全仓审查 GD I-1 (2026-09-12): owner 抢注与 paused 原值保存同属开窗副作用——原在
	# report/profile 校验之前执行,校验失败路径会 ① 抢注 owner(后续其他 peer 被"held by
	# another session"拒) ② 残留过期 _control_paused_saved(peer 断线时还原到校验失败时刻
	# 的 paused,游戏自身后开的暂停被重置)。随开窗一并移到全部校验之后。
	var su_vr: Array = _validate_report_spec(params)
	if not bool(su_vr[0]):
		return su_vr[1]
	# B-1 清偿(审查): profile 同窗口前置校验 + 随 payload 传 pending(report 求值投影用)
	var su_profile_res := _resolve_observation_profile(params)
	if su_profile_res.has("error"):
		return su_profile_res
	_control_owner_pid = pid
	# 2026-08-14 审查 D-2 修复:开窗前若无有效保存则记录当前 paused(refreeze 周期已由
	# freeze 保存;非 refreeze 周期此处保存的即游戏自身原值),供完成/断线还原点恢复。
	if not _control_paused_saved_valid:
		_control_paused_saved = get_tree().paused
		_control_paused_saved_valid = true
	_control_frozen = false  # 临时解:让 _process 不维持 paused,游戏跑
	get_tree().paused = false  # 开窗
	return {"__playtest_control_step_until__": true, "conditions": validated, "max_frames": max_frames, "wall_budget_ms": wall_budget_ms, "refreeze": refreeze, "report": su_vr[1], "profile": str(su_profile_res["profile"])}

# ─── H1 (2026-08-20) 帧定时输入时间线(确定性完全体最后一块) ────────────────
# at_frame=N = 开窗后第 N 个推进帧(登记帧不计数,I-2 同款);注入点=bridge _process
# (autoload,先于场景树节点同帧执行);事件经 Input.parse_input_event 进入引擎输入管线,
# 被随后帧的游戏逻辑读到(与真实输入同路径,帧对齐语义由 e2e 实测锚定)。
# 与 playtest.seed/fixed_delta/freeze 组合:seed 锁随机+fixed_delta 锁步长+freeze 锁起播点
# +时间线锁输入 —— 竞品(仅固定帧数 step/无 seed)无此组合能力。
const _INPUT_SEQ_MAX_EVENTS := 256
const _INPUT_SEQ_MAX_AT_FRAME := 600
const _INPUT_SEQ_MAX_SETTLE := 600
const _INPUT_SEQ_TYPES := ["action", "key", "mouse_click", "mouse_move", "touch", "drag"]

func _cmd_control_input_sequence(params: Dictionary, pid: int) -> Dictionary:
	# owner 独占(同 step_until)
	if _control_owner_pid != -1 and _control_owner_pid != pid:
		return {"error": {"code": -1, "message": "control layer held by another session (owner_pid=%d)" % _control_owner_pid}}
	var timeline: Variant = params.get("timeline", [])
	if not (timeline is Array) or timeline.size() == 0:
		return {"error": {"code": -1, "message": "timeline must be a non-empty array of {at_frame, type, ...}"}}
	if timeline.size() > _INPUT_SEQ_MAX_EVENTS:
		return {"error": {"code": -1, "message": "timeline too large: %d events (max %d)" % [timeline.size(), _INPUT_SEQ_MAX_EVENTS]}}
	var validated: Array = []
	var max_at := 0
	for ev in timeline:
		if not (ev is Dictionary):
			return {"error": {"code": -1, "message": "each timeline event must be an object"}}
		var e: Dictionary = ev
		if not (e.has("at_frame") and e.has("type")):
			return {"error": {"code": -1, "message": "timeline event missing at_frame/type"}}
		var at_f := _int_guarded(e["at_frame"], 0)
		if at_f < 1 or at_f > _INPUT_SEQ_MAX_AT_FRAME:
			return {"error": {"code": -1, "message": "at_frame must be 1-%d, got %d" % [_INPUT_SEQ_MAX_AT_FRAME, at_f]}}
		var t := str(e["type"])
		if not _INPUT_SEQ_TYPES.has(t):
			return {"error": {"code": -1, "message": "type must be one of %s, got %s" % [str(_INPUT_SEQ_TYPES), t]}}
		# 深预检(可判定的在登记前拒绝,all-or-nothing):key 可解析 / action 在 InputMap /
		# mouse_click button 可解析 / touch·drag index 非负整数(审查G-2:与 key 同款 all-or-nothing)
		if t == "key" and _key_from_string(str(e.get("key", ""))) == 0:
			return {"error": {"code": -1, "message": "Unknown key: %s (at_frame=%d)" % [str(e.get("key", "")), at_f]}}
		if t == "action" and not InputMap.has_action(str(e.get("name", ""))):
			return {"error": {"code": -1, "message": "Unknown action: %s (at_frame=%d); action must exist in project InputMap" % [str(e.get("name", "")), at_f]}}
		if t == "mouse_click" and _mouse_button_from_value(e.get("button", 1)) == -1:
			return {"error": {"code": -1, "message": "Invalid button: %s (at_frame=%d); use 1-9 or left/right/middle" % [str(e.get("button", 1)), at_f]}}
		if (t == "touch" or t == "drag") and not _is_valid_touch_index(e.get("index", 0)):
			return {"error": {"code": -1, "message": "Invalid index: %s (at_frame=%d); must be non-negative integer" % [str(e.get("index", 0)), at_f]}}
		if t == "drag":
			# 审查 M-2: 深预检补 drag 形态——relative/speed 键名拼错(如 rel)或形态非法原本
			# 登记期不拒,注入期静默 fallback (0,0) → E2E 假绿。键白名单 + 双形态校验。
			var drag_keys := ["at_frame", "type", "x", "y", "index", "relative", "speed"]
			for k in e.keys():
				if not (k in drag_keys):
					return {"error": {"code": -1, "message": "Unknown drag event key: %s (at_frame=%d); valid keys: %s" % [str(k), at_f, str(drag_keys)]}}
			for vec_key in ["relative", "speed"]:
				if e.has(vec_key) and not (e[vec_key] is Array or e[vec_key] is Dictionary):
					return {"error": {"code": -1, "message": "Invalid %s: %s (at_frame=%d); must be [x,y] array or {x,y} object" % [vec_key, str(e[vec_key]), at_f]}}
		validated.append(e)
		max_at = maxi(max_at, at_f)
	var settle: int = _int_guarded(params.get("settle_frames"), 0)
	if settle < 0 or settle > _INPUT_SEQ_MAX_SETTLE:
		return {"error": {"code": -1, "message": "settle_frames must be 0-%d, got %d" % [_INPUT_SEQ_MAX_SETTLE, settle]}}
	var wall_budget_ms: int = _int_guarded(params.get("wall_budget_ms"), _CONTROL_DEFAULT_WALL_BUDGET_MS)
	# D-5 同款:压 50s,防等待期无字节被 idle 断连切断
	wall_budget_ms = clampi(wall_budget_ms, 1000, 50000)
	# 开窗(同 step_until):记 refreeze + paused 原值 + 临时解 pause 让游戏逐帧推进
	var refreeze: bool = _control_frozen
	_control_owner_pid = pid
	if not _control_paused_saved_valid:
		_control_paused_saved = get_tree().paused
		_control_paused_saved_valid = true
	_control_frozen = false
	get_tree().paused = false
	return {"__playtest_control_input_seq__": true, "timeline": validated, "frames_budget": max_at + settle + 1, "wall_budget_ms": wall_budget_ms, "refreeze": refreeze}

func _inject_timeline_event(ev: Dictionary) -> Variant:
	# 注入复用现有 _cmd_send_*(自带参数校验+注入),零重复;action 类型走 InputEventAction。
	var t := str(ev.get("type", ""))
	match t:
		"action":
			var a := InputEventAction.new()
			a.action = str(ev.get("name", ""))
			a.pressed = bool(ev.get("pressed", true))
			if ev.has("strength"):
				a.strength = _num(ev["strength"], 0.0)
			Input.parse_input_event(a)
			return {"success": true, "action": a.action, "pressed": a.pressed}
		"key":
			return _cmd_send_key(ev)
		"mouse_click":
			return _cmd_send_mouse_click(ev)
		"mouse_move":
			return _cmd_send_mouse_move(ev)
		"touch":
			return _cmd_send_touch(ev)
		"drag":
			return _cmd_send_drag(ev)
		_:
			return {"error": {"code": -1, "message": "Unknown timeline event type: %s" % t}}

# 结构化条件求值:actual op target(标量/String/Vector,不引入 Expression)
func _compare_values(actual: Variant, op: String, target: Variant) -> bool:
	if actual is float or actual is int:
		# G-1 修复(2026-08-20 审查):数值分支对齐 Vector 分支的 N-1 白名单——target 非数值
		# return false,防 String 条件值经 float("abc") 静默按 0 比较(step_until 假阳性 predicate_met)
		if not (target is int or target is float):
			return false
		var a: float = float(actual)
		var t: float = float(target)
		match op:
			"==": return is_equal_approx(a, t)
			"!=": return not is_equal_approx(a, t)
			"<": return a < t
			">": return a > t
			"<=": return a <= t
			">=": return a >= t
	if actual is String or actual is bool:
		match op:
			"==": return str(actual) == str(target)
			"!=": return str(actual) != str(target)
			"<": return str(actual) < str(target)
			">": return str(actual) > str(target)
			"<=": return str(actual) <= str(target)
			">=": return str(actual) >= str(target)
	if actual is Vector2 or actual is Vector3:
		# N-1 修复(审查):Vector 属性 value 必须是标量(按 length 比)或 Vector,否则 return false
		# (防 Array/Dict value 经 float() 静默转 0.0 致条件永不满足、静默耗尽帧/wall)
		if not (target is int or target is float or target is Vector2 or target is Vector3):
			return false
		var len_a: float = 0.0
		var len_t: float = 0.0
		if actual is Vector2:
			len_a = (actual as Vector2).length()
			len_t = float(target) if not (target is Vector2) else (target as Vector2).length()
		else:
			len_a = (actual as Vector3).length()
			len_t = float(target) if not (target is Vector3) else (target as Vector3).length()
		match op:
			"==": return is_equal_approx(len_a, len_t)
			"!=": return not is_equal_approx(len_a, len_t)
			"<": return len_a < len_t
			">": return len_a > len_t
			"<=": return len_a <= len_t
			">=": return len_a >= len_t
	# 其他类型(Color/Rect 等):仅 == / !=(str 比较)
	match op:
		"==": return str(actual) == str(target)
		"!=": return str(actual) != str(target)
		_: return false  # 不支持 < > 等于非标量/Vector


func _input(event: InputEvent) -> void:
	if not _recording:
		return
	# P2-4: playtest 激活时跳过录制,避免 playtest 注入的输入污染录制序列
	if _playtest_active:
		return
	# Note: field is 'time_offset' (renamed from 'time_ms' in v0.18.0).
	# Existing recordings with 'time_ms' field are incompatible.
	var time_ms: int = Time.get_ticks_msec() - _record_start_time
	if event is InputEventKey:
		_recorded_events.append({"type": "key", "keycode": event.keycode, "pressed": event.pressed, "shift": event.shift_pressed, "ctrl": event.ctrl_pressed, "alt": event.alt_pressed, "time_offset": time_ms})
	elif event is InputEventMouseButton:
		_recorded_events.append({"type": "mouse_click", "position": [event.position.x, event.position.y], "button": event.button_index, "pressed": event.pressed, "time_offset": time_ms})
	elif event is InputEventMouseMotion:
		# 审查 Minor-11: 补记 button_mask——「按住拖动」的 motion 带按键态,不记则录制回放
		# 丢失按键态(与 send_mouse_move 的 button_mask 注入能力对称);旧回放器忽略未知字段,向后兼容。
		_recorded_events.append({"type": "mouse_move", "position": [event.position.x, event.position.y], "button_mask": event.button_mask, "time_offset": time_ms})
	elif event is InputEventScreenTouch:  # IMP-11: 触摸事件录制(对齐 recording_commands.gd :46 + _cmd_send_touch 契约)
		_recorded_events.append({"type": "touch", "position": [event.position.x, event.position.y], "pressed": event.pressed, "index": event.index, "time_offset": time_ms})
	elif event is InputEventScreenDrag:  # IMP-11 补全: 拖拽录制(对齐 recording_commands.gd + _cmd_send_drag 契约)
	# speed 键是 MCP 录制契约名保留;引擎属性读取走 velocity(Godot 4 改名,同 _cmd_send_drag)
		_recorded_events.append({"type": "touch_drag", "position": [event.position.x, event.position.y], "index": event.index, "relative": [event.relative.x, event.relative.y], "speed": [event.velocity.x, event.velocity.y], "time_offset": time_ms})


## 内联安全类型检查（替代 SafeValues 类引用，autoload 环境无法引用 safe_values.gd）
## C-03: Keep in sync with src/scripts/safe_values.gd — that is the canonical source.
## 覆盖 JSON 反序列化可产生的类型 + StringName（GDScript 内部调用）
const _MAX_SAFE_DEPTH := 10

func _is_safe_value(value: Variant, depth: int = 0) -> bool:
	if value == null:
		return true
	if value is bool or value is int or value is float or value is String or value is StringName:
		return true
	# Keep in sync with safe_values.gd — geometric + PackedArray types
	if value is Vector2 or value is Vector2i or value is Vector3 or value is Vector3i:
		return true
	if value is Color or value is Rect2 or value is Rect2i:
		return true
	if value is Transform2D or value is Transform3D or value is Basis or value is Quaternion:
		return true
	if value is Plane or value is AABB:
		return true
	if value is PackedByteArray or value is PackedInt32Array or value is PackedInt64Array:
		return true
	if value is PackedFloat32Array or value is PackedFloat64Array or value is PackedStringArray:
		return true
	if value is PackedVector2Array or value is PackedVector3Array or value is PackedColorArray:
		return true
	if depth >= _MAX_SAFE_DEPTH:
		return false
	if value is Array:
		for item in value:
			if not _is_safe_value(item, depth + 1):
				return false
		return true
	if value is Dictionary:
		for key in value:
			if not _is_safe_value(key, depth + 1) or not _is_safe_value(value[key], depth + 1):
				return false
		return true
	return false


# ─── CMP-2 (2026-08-08): runtime error 捕获 Logger 子类 ──────────────────────
# 竞品 game_error_log.gd 验证过的设计:re-entrancy guard 防 error storm 递归、
# rationale 优先于 code(Godot 把错误文本拆两段)、ring buffer pop_front、
# 只捕 SCRIPT/SHADER/WARNING 放过普通 print。
# 不放 backtrace 深栈:Godot 4 _script_backtraces 是扁平字符串数组解析不可靠,
# 首帧(function/file/line)已在 _log_error 参数,够用。
class _ErrorCapture extends Logger:
	const MAX_ENTRIES := 200
	const MAX_TEXT_LEN := 4096  # NIT-4: 截断超长 message/code/function/file 防撑爆 MAX_MESSAGE_SIZE

	var _entries: Array[Dictionary] = []
	var _seq := 0
	var _in_log := false  # re-entrancy guard:push_error 递归触发 logger 再触发 error 会卡死

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array) -> void:
		if _in_log:
			return
		# 捕获全部 4 种错误类型(ERROR/SCRIPT/SHADER/WARNING)。
		# NIT-1 (2026-08-08 第三方审查): 补 ERROR_TYPE_ERROR 覆盖引擎层运行时错误
		# (null 解引用/API 误用/FileAccess 失败/callv 参数错误),超越竞品只捕 SCRIPT/SHADER/WARNING。
		# 注意:_log_error 不被普通 print() 触发(走 _log_message),这里不会收到 print。
		if error_type != ERROR_TYPE_ERROR and error_type != ERROR_TYPE_SCRIPT and error_type != ERROR_TYPE_SHADER and error_type != ERROR_TYPE_WARNING:
			return
		# GD-R2/IPC-R7 (2026-08-08): GDScript 无 try/finally,引擎错误绕过控制流。
		# 把所有有风险操作(substr/append/pop_front)集中到 _capture_entry 辅助方法,
		# 主方法 _log_error 用两行明确控制 _in_log——除非 _capture_entry 内部引擎错误
		# (绕过 GDScript 控制流,此时整个 capture 子系统已失效,与现状无异),
		# 否则 _in_log = false 必达。消除"GDScript 可达的提前退出路径致 _in_log 卡死 true"。
		_in_log = true
		_capture_entry(function, file, line, code, rationale, error_type)
		_in_log = false

	# GD-R2/IPC-R7: 辅助方法——集中所有有风险操作(substr/append/pop_front)。
	# 普通方法正常情况必然返回(GDScript 无异常机制);构建 entry 全程用局部变量,
	# 仅成功构建后才 append 到 _entries,最小化副作用。
	func _capture_entry(function: String, file: String, line: int, code: String, rationale: String, error_type: int) -> void:
		_seq += 1
		var kind := "warning"
		if error_type == ERROR_TYPE_ERROR:
			kind = "error"
		elif error_type == ERROR_TYPE_SCRIPT:
			kind = "script"
		elif error_type == ERROR_TYPE_SHADER:
			kind = "shader"
		# rationale 是引擎错误的人话描述,code 是 push_error 的原始文本;前者更可读。
		# NIT-4 (2026-08-08 第三方审查): 截断防超长文本撑爆 MAX_MESSAGE_SIZE。
		var msg := (rationale if rationale != "" else code).substr(0, MAX_TEXT_LEN)
		var code_clipped := code.substr(0, MAX_TEXT_LEN)
		_entries.append({
			"seq": _seq,
			"kind": kind,
			"message": msg,
			"code": code_clipped,
			"function": function.substr(0, MAX_TEXT_LEN),
			"file": file.substr(0, MAX_TEXT_LEN),
			"line": line,
		})
		if _entries.size() > MAX_ENTRIES:
			_entries.pop_front()

	# 增量查询:返回 seq > since_seq 的条目 + 下次查询用的 next_seq 游标。
	# clear=true 在查询后清空 buffer(读即焚,适合 AI 确认已处理完旧错误)。
	# H-2(2026-09-17 审查):seq 裸转换 _int_guarded(回退 -1 = 永不命中,静默全滤)。
	# DUPLICATE: Keep in sync with 外层 _int_guarded(语言约束实证:GDScript 内部类
	# 无法访问外层实例方法/静态方法,Parse Error,只能同形态副本;e["seq"] 本身由
	# _capture_entry 的内部计数器唯一写入,此处属顺手纵深而非外部攻击面)。
	func _int_guarded(v: Variant, fallback: int) -> int:
		if v is int:
			return v
		if v is float and is_finite(v) and v == floor(v):
			return int(v)
		if v is String and String(v).is_valid_int():
			return int(v)
		return fallback

	func poll(since_seq: int, clear: bool) -> Dictionary:
		var out: Array = []
		for e in _entries:
			if _int_guarded(e["seq"], -1) > since_seq:
				out.append(e)
		var next := _seq
		if clear:
			_entries.clear()
		return {"errors": out, "next_seq": next}

	func clear() -> void:
		_entries.clear()


# ─── P3-2 (2026-09-11): click_button real_event 等帧验证协程 ────────────────
# press/release 注入 viewport → 等引擎处理帧 → 读信号计数 → 推送响应。
# 信号计数 = "点击真的走通引擎输入管道"的客观证据(LuoxuanLove ClickSignalRecorder 模式),
# 而非只看我们自己 emit 的返回值。

func _await_click_verify_and_respond(peer_id: int, id: Variant, path: String) -> void:
	var payload: Dictionary = {}
	var node := get_node_or_null(path)
	if node == null or not is_instance_valid(node) or not node is BaseButton:
		payload = {"id": id, "error": {"code": -1, "message": "Button went away during verify: %s" % path}}
	else:
		var btn: BaseButton = node as BaseButton
		var vp := btn.get_viewport()
		if vp == null:
			payload = {"id": id, "error": {"code": -6, "message": "Button has no viewport: %s" % path}}
		else:
			var recorder := _ClickSignalRecorder.new()
			recorder.attach(btn)
			var center := btn.get_global_rect().get_center()
			var press := InputEventMouseButton.new()
			press.button_index = MOUSE_BUTTON_LEFT
			press.pressed = true
			press.position = center
			press.global_position = center
			# 反馈批次C (2026-09-17):device=0 对齐真实管线(同 _cmd_send_mouse_click)
			press.device = 0
			vp.push_input(press)
			await get_tree().process_frame
			await get_tree().process_frame
			var release := InputEventMouseButton.new()
			release.button_index = MOUSE_BUTTON_LEFT
			release.pressed = false
			release.position = center
			release.global_position = center
			release.device = 0
			vp.push_input(release)
			await get_tree().process_frame
			await get_tree().process_frame
			recorder.detach(btn)
			var counts: Dictionary = recorder.to_dictionary()
			var pressed_count := int(counts.get("pressed", 0))
			payload = {"id": id, "result": {
				"clicked": pressed_count > 0,
				"button_path": path,
				"button_text": str(btn.get("text")) if btn.get("text") != null else "",
				"mode": "real_event",
				"signal_counts": counts,
				"button_pressed": btn.button_pressed,
				"verified": pressed_count > 0,
			}}
	var target_peer: StreamPeerTCP = null
	for p in _peers:
		if p.get_instance_id() == peer_id:
			target_peer = p
			break
	if target_peer == null:
		return  # peer 已断开,丢响应(同 pending 完成推送模式)
	target_peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())


# 按钮信号计数器(LuoxuanLove ui_control_tools.gd ClickSignalRecorder 移植):
# attach 后 hook BaseButton 四个核心信号计数,detach 拆除;计数 = 引擎输入管道
# 真实处理点击的客观证据(emit_signal 路径不经过它,只有真实事件才计数)。
class _ClickSignalRecorder:
	extends RefCounted

	var counts := {}

	func attach(btn: BaseButton) -> void:
		btn.pressed.connect(_record_pressed)
		btn.button_down.connect(_record_button_down)
		btn.button_up.connect(_record_button_up)
		btn.toggled.connect(_record_toggled)

	func detach(btn: BaseButton) -> void:
		if not is_instance_valid(btn):
			return
		if btn.pressed.is_connected(_record_pressed):
			btn.pressed.disconnect(_record_pressed)
		if btn.button_down.is_connected(_record_button_down):
			btn.button_down.disconnect(_record_button_down)
		if btn.button_up.is_connected(_record_button_up):
			btn.button_up.disconnect(_record_button_up)
		if btn.toggled.is_connected(_record_toggled):
			btn.toggled.disconnect(_record_toggled)

	func to_dictionary() -> Dictionary:
		return counts.duplicate(true)

	func _record_pressed() -> void:
		_record("pressed")

	func _record_button_down() -> void:
		_record("button_down")

	func _record_button_up() -> void:
		_record("button_up")

	func _record_toggled(_pressed: bool) -> void:
		_record("toggled")

	func _record(signal_name: String) -> void:
		counts[signal_name] = int(counts.get(signal_name, 0)) + 1


# ─── P3-1 (2026-09-11): 弱网注入命令 ────────────────────────────────────────

func _cmd_network_set_conditions(params: Dictionary) -> Variant:
	var latency := _num(params.get("latency_ms"), 0.0)
	var loss := _num(params.get("loss_pct"), 0.0)
	var jitter := _num(params.get("jitter_ms"), 0.0)
	if latency < 0.0 or loss < 0.0 or loss > 100.0 or jitter < 0.0:
		return {"error": {"code": -1, "message": "Invalid conditions: latency_ms/jitter_ms >= 0, 0 <= loss_pct <= 100 (got latency=%f loss=%f jitter=%f)" % [latency, loss, jitter]}}
	var tree := get_tree()
	if tree == null:
		return {"error": {"code": -2, "message": "Scene tree not available"}}
	var mp := tree.get_multiplayer()
	if _net_conditioner == null:
		var current := mp.get_multiplayer_peer()
		# OfflineMultiplayerPeer = 多人未配置(set_multiplayer_peer 未被游戏调用过)。
		# 无真实 peer 可包装时诚实报错,不静默装一个包着 Offline 的空壳。
		if current == null or current is OfflineMultiplayerPeer:
			return {"error": {"code": -3, "message": "No multiplayer peer configured (get_multiplayer_peer() is null/Offline). 先让游戏建 host/join(ENet/WebSocket peer)再注入弱网"}}
		var conditioner := _NetworkConditioner.new()
		conditioner.set_inner(current)
		conditioner.start_driver(self)
		mp.set_multiplayer_peer(conditioner)
		_net_conditioner = conditioner
	_net_conditioner.set_conditions(latency, loss, jitter)
	return {
		"ok": true,
		"installed": true,
		"conditions": _net_conditioner.get_conditions(),
		"inner_peer": _net_conditioner.get_inner().get_class(),
		"note": "只作用于出向包(host 侧装=影响 host 发给所有 client);无带宽限制;依赖 SceneMultiplayer 高阶 API",
	}


func _cmd_network_clear() -> Variant:
	if _net_conditioner == null:
		return {"ok": true, "installed": false, "note": "no conditioner installed"}
	var tree := get_tree()
	var inner: MultiplayerPeer = _net_conditioner.get_inner()
	_net_conditioner.stop_driver()
	if tree != null and inner != null:
		var mp := tree.get_multiplayer()
		# 只在 conditioner 仍是当前 peer 时恢复(游戏若自行换过 peer,不要覆盖游戏的值)
		if mp.get_multiplayer_peer() == _net_conditioner:
			mp.set_multiplayer_peer(inner)
	var restored: String = inner.get_class() if inner != null else ""
	_net_conditioner = null
	return {"ok": true, "installed": false, "restored_peer": restored}


func _cmd_network_status() -> Variant:
	if _net_conditioner == null:
		return {"installed": false}
	return {
		"installed": true,
		"conditions": _net_conditioner.get_conditions(),
		"pending_packets": _net_conditioner.pending_count(),
		"inner_peer": _net_conditioner.get_inner().get_class(),
	}


# 弱网注入器(masteryee-labs Open-Godot-MCP network_conditioner.gd 移植,2026-09-11):
# MultiplayerPeerExtension 装饰器(引擎内置可扩展类,Godot 4.1+,无需编译 GDExtension)
# 包装真实 peer。只改出向一条路径 _put_packet_script:未启用直通/静默丢包(randf < loss_pct)/
# 延迟+jitter 进 pending 队列由 16ms Timer flush;其余 ~20 个虚方法一行直通 inner。
class _NetworkConditioner:
	extends MultiplayerPeerExtension

	var _inner: MultiplayerPeer = null
	var _latency_ms := 0.0
	var _loss_pct := 0.0
	var _jitter_ms := 0.0
	var _pending: Array = []  # 队列出向包: {buffer, send_time}
	var _driver: Timer = null

	func set_inner(peer: MultiplayerPeer) -> void:
		_inner = peer

	func get_inner() -> MultiplayerPeer:
		return _inner

	func set_conditions(latency: float, loss: float, jitter: float) -> void:
		_latency_ms = latency
		_loss_pct = loss
		_jitter_ms = jitter

	func get_conditions() -> Dictionary:
		return {"latency_ms": _latency_ms, "loss_pct": _loss_pct, "jitter_ms": _jitter_ms}

	func pending_count() -> int:
		return _pending.size()

	func _setup_driver() -> void:
		if _driver == null:
			_driver = Timer.new()
			_driver.set_wait_time(0.016)
			_driver.set_autostart(true)
			_driver.timeout.connect(_flush)

	func start_driver(parent: Node) -> void:
		_setup_driver()
		if _driver.get_parent() == null:
			parent.add_child(_driver)

	func stop_driver() -> void:
		if _driver:
			_driver.queue_free()
			_driver = null
		_pending.clear()

	func _flush() -> void:
		if _inner == null:
			return
		var now := Time.get_ticks_msec()
		for i in range(_pending.size() - 1, -1, -1):
			if _pending[i]["send_time"] <= now:
				_inner.put_packet(_pending[i]["buffer"])
				_pending.remove_at(i)

	func _put_packet_script(p_buffer: PackedByteArray) -> int:
		if _inner == null:
			return FAILED
		if _latency_ms <= 0.0 and _loss_pct <= 0.0 and _jitter_ms <= 0.0:
			return _inner.put_packet(p_buffer)
		if randf() < _loss_pct / 100.0:
			return OK  # 静默丢包
		var delay := _latency_ms + randf_range(-_jitter_ms, _jitter_ms)
		if delay <= 0.0:
			return _inner.put_packet(p_buffer)
		_pending.append({"buffer": p_buffer, "send_time": Time.get_ticks_msec() + delay})
		return OK

	func _get_packet_script() -> PackedByteArray:
		if _inner == null:
			return PackedByteArray()
		return _inner.get_packet()

	func _get_available_packet_count() -> int:
		if _inner == null:
			return 0
		return _inner.get_available_packet_count()

	func _get_max_packet_size() -> int:
		if _inner == null:
			return 0
		return _inner.get_max_packet_size()

	func _get_connection_status() -> int:
		if _inner == null:
			return MultiplayerPeer.CONNECTION_DISCONNECTED
		return _inner.get_connection_status()

	func _set_transfer_channel(p_channel: int) -> void:
		if _inner:
			_inner.set_transfer_channel(p_channel)

	func _get_transfer_channel() -> int:
		if _inner:
			return _inner.get_transfer_channel()
		return 0

	func _set_transfer_mode(p_mode: int) -> void:
		if _inner:
			_inner.set_transfer_mode(p_mode)

	func _get_transfer_mode() -> int:
		if _inner:
			return _inner.get_transfer_mode()
		return MultiplayerPeer.TRANSFER_MODE_RELIABLE

	func _set_refuse_new_connections(p_refuse: bool) -> void:
		if _inner:
			_inner.set_refuse_new_connections(p_refuse)

	func _is_refusing_new_connections() -> bool:
		if _inner:
			return _inner.is_refusing_new_connections()
		return true

	func _is_server() -> bool:
		if _inner:
			return _inner.is_server()
		return false

	func _get_unique_id() -> int:
		if _inner:
			return _inner.get_unique_id()
		return 1

	func _set_target_peer(p_peer: int) -> void:
		if _inner:
			_inner.set_target_peer(p_peer)

	func _poll() -> void:
		if _inner:
			_inner.poll()

	func _close() -> void:
		if _inner:
			_inner.close()
		_pending.clear()

	func _disconnect_peer(p_peer: int, p_force: bool) -> void:
		if _inner:
			_inner.disconnect_peer(p_peer, p_force)

	func _get_packet_channel() -> int:
		if _inner:
			return _inner.get_packet_channel()
		return 0

	func _get_packet_mode() -> int:
		if _inner:
			return _inner.get_packet_mode()
		return MultiplayerPeer.TRANSFER_MODE_RELIABLE

	func _get_packet_peer() -> int:
		if _inner:
			return _inner.get_packet_peer()
		return 0


# ─── P3-3 (2026-09-11): 项目本地命令目录 res://mcp_commands/*.gd ────────────
# (regiellis-godot-mcp-go mcp_commands 移植)游戏开发者丢一个 .gd 文件进
# res://mcp_commands/ 即扩展 bridge 命令面,无需 fork server。契约:脚本实例化为
# Node 暴露 get_commands() -> {"custom.xxx": Callable};宽容加载(load 失败/
# 不可实例化/非 Node/无方法/返回非 Dictionary)push_warning 跳过,绝不破坏启动。
# enhanced 约束:命令名必须 custom. 前缀(regiellis 内建是运行时字典可枚举冲突,
# 此处 match 不可枚举,前缀隔离天然零内建冲突)。信任边界与 GDA_CALLABLE 同哲学:
# 声明面 = 游戏源码方责任(进游戏方 code review),bridge 保证未声明命令名不可达。

func _register_custom_commands() -> void:
	# P8-1: 状态机入口(_ready 调用;P3 的启动一次性注册升级为 reconcile)。
	_refresh_custom_slots("initialize")


## P8-1 热加载状态机核心(LuoxuanLove _reconcile_script_inventory 移植):
## 扫描 → mtime 对比标记 pending → 删除处理(quiesce) → pending 槽位 reload(quiesce) → 重建索引。
## env GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD=0 关闭热重载(退化为 P3 的启动加载一次;
## 调用路径仍走 _execute_custom_command 的 active_calls 记账,状态字段照常上报)。
func _refresh_custom_slots(reason: String) -> void:
	var hot_reload := OS.get_environment(CUSTOM_HOT_RELOAD_ENV).to_lower() != "0"
	_custom_last_scan_ms = Time.get_ticks_msec()
	var discovered := {}
	var dir := DirAccess.open("res://mcp_commands")
	if dir != null:
		dir.list_dir_begin()
		var file_name := dir.get_next()
		while not file_name.is_empty():
			if not dir.current_is_dir() and file_name.get_extension() == "gd":
				var path := "res://mcp_commands".path_join(file_name)
				discovered[path] = true
				var mtime := FileAccess.get_modified_time(path)
				# CI 失败修复(HOT-c, 2026-09-13): get_modified_time 返回秒级 Unix 时间戳——
				# 1 秒内两次保存(编辑器快速迭代常态)秒值相同,原 mtime 单比较静默丢 reload,
				# 状态机停留旧 state(e2e 实证:HOT-b 写入与 HOT-c 写入同秒,state 停 loaded)。
				# 补内容 md5 双比较:同秒任意内容变化可靠触发。开销可忽略(mcp_commands 文件
				# 个位数 + 均为小脚本,300ms tick 周期下微秒-毫秒级)。
				# ⚠️ FileAccess.get_file_size 是实例方法不可静态调(首版踩坑:Parse Error 挂
				# autoload,check:gdscript 漏报此错误,手起游戏才暴露——审查盲区 1 二例)。
				var content_hash := FileAccess.get_md5(path)
				var slot: Dictionary = _custom_slots.get(path, {})
				if slot.is_empty():
					# ENV=0 冻结命令面(P8 审查 N-2 清偿):仅启动扫描(initialize)建新 slot;
					# tick 发现的新文件不加载——否则"启动加载一次"名不副实(新增照样热加载)。
					if hot_reload or reason == "initialize":
						_custom_slots[path] = _create_custom_slot(path, mtime, content_hash, reason)
					continue
				if hot_reload and (int(slot.get("last_mtime", 0)) != mtime or String(slot.get("last_hash", "")) != content_hash):
					slot["last_mtime"] = mtime
					slot["last_hash"] = content_hash
					slot["pending_reload"] = true
					slot["state"] = "reload_pending"
					_custom_slots[path] = slot
			file_name = dir.get_next()
		dir.list_dir_end()
	# 删除处理:文件消失 + 调用中 → removed_pending/quiesce;空闲 → 直接卸载
	# ENV=0 冻结:已加载 slot 不因文件消失卸载(启动加载一次语义,P8 审查 N-2 清偿)
	for path in _custom_slots.keys():
		if discovered.has(path):
			continue
		if not hot_reload:
			continue
		var slot: Dictionary = _custom_slots[path]
		if int(slot.get("active_calls", 0)) > 0:
			slot["removed_pending"] = true
			slot["state"] = "waiting_quiesce"
			_custom_slots[path] = slot
			continue
		_unload_custom_slot(path, "script_removed")
	# pending reload:调用中(quiesce)或首次(初始化)按序处理
	for path in _custom_slots.keys():
		var slot: Dictionary = _custom_slots[path]
		if not bool(slot.get("pending_reload", false)):
			continue
		if int(slot.get("active_calls", 0)) > 0:
			slot["state"] = "waiting_quiesce"
			_custom_slots[path] = slot
			continue
		if not hot_reload and slot.get("instance", null) != null:
			continue  # 热重载关:已有实例不再 reload(启动已加载一次)
		_reload_custom_slot(path)
	_rebuild_custom_index()


func _create_custom_slot(path: String, mtime: int, content_hash: String, reason: String) -> Dictionary:
	return {
		"instance": null,
		"commands": {},
		"version": 0,
		"state": "reload_pending",
		"active_calls": 0,
		"pending_reload": true,
		"removed_pending": false,
		"last_mtime": mtime,
		"last_hash": content_hash,
		"last_error": null,
		"last_reason": reason,
	}


## 加载/重载一个 slot。失败回滚旧实例(reload_failed 保旧 Callable 可用)。
## ⚠️ 已知引擎限制(2026-09-11 e2e HOT-c 实测):运行中写入**语法坏**的 .gd 会触发
## Godot 4.6 Script Debugger REPL(debug> 提示符,主循环停等 stdin → bridge 死)——引擎
## 编译坏脚本即 break,与加载方式无关。bridge 侧防线覆盖"合法语法但违反契约"的坏文件
## (非 Node/缺 get_commands/非 custom. 前缀);语法级坏文件是开发者 IDE 先报的错误,
## 记为热加载已知边界(规则文档同步声明)。
## ⚠️ 不走 ResourceLoader(2026-09-11 e2e HOT-c 二轮实测):同路径 load 即使
## CACHE_MODE_IGNORE 也会就地替换 ResourceCache 里的共享 GDScript 资源,旧实例的方法表
## 随之消失——回滚保留的旧 Callable is_valid()=false(实例活着但方法没了)。故改用
## FileAccess 读源码 + GDScript.new() 独立对象加载:坏文件加载失败即丢弃,旧脚本资源
## 从未被触碰,回滚 = 旧实例原封不动,天然有效。
func _reload_custom_slot(path: String) -> void:
	var slot: Dictionary = _custom_slots.get(path, {})
	if slot.is_empty():
		return
	var old_instance: Node = slot.get("instance", null)
	var script := GDScript.new()
	script.source_code = FileAccess.get_file_as_string(path)
	var reload_ok := script.reload() == OK
	var new_instance: Node = null
	var commands: Dictionary = {}
	var load_error := ""
	if not reload_ok or not script.can_instantiate():
		load_error = "failed to load as instantiable script"
	else:
		var inst: Variant = script.new()
		if not (inst is Node):
			load_error = "must instantiate to a Node"
			# RefCounted 出作用域自释放;其余 Object 子类显式 free 防漏
			if inst is Object and not (inst is RefCounted):
				(inst as Object).free()
		else:
			new_instance = inst
			if not new_instance.has_method("get_commands"):
				load_error = "no get_commands() method"
			else:
				var cmds: Variant = new_instance.get_commands()
				if not (cmds is Dictionary):
					load_error = "get_commands() must return a Dictionary"
				else:
					for method in (cmds as Dictionary):
						var callable: Variant = (cmds as Dictionary)[method]
						if not (callable is Callable) or not (callable as Callable).is_valid():
							push_warning("[MCP Bridge] Skipping custom command '%s': value must be a valid Callable" % method)
							continue
						if not (method as String).begins_with("custom."):
							push_warning("[MCP Bridge] Skipping custom command '%s' from '%s': must use 'custom.' prefix" % [method, path])
							continue
						commands[method] = callable
	if load_error != "" or (commands.is_empty() and new_instance == null):
		if new_instance != null:
			new_instance.queue_free()
		slot["pending_reload"] = false
		slot["state"] = "reload_failed"
		slot["last_error"] = load_error if load_error != "" else "no valid commands"
		if old_instance != null:
			_custom_slots[path] = slot  # 回滚:独立加载未触碰旧脚本,旧实例/旧 Callable 原样可用
			push_warning("[MCP Bridge] Custom command reload failed for %s (kept previous version): %s" % [path, slot["last_error"]])
			_rebuild_custom_index()
			return
		_custom_slots[path] = slot
		push_warning("[MCP Bridge] Skipping custom command file '%s': %s" % [path, slot["last_error"]])
		return
	# 成功:旧实例让位(挂树节点 queue_free),新实例挂 bridge 下保活
	if old_instance != null:
		old_instance.queue_free()
	add_child(new_instance)
	slot["instance"] = new_instance
	slot["commands"] = commands
	slot["version"] = int(slot.get("version", 0)) + 1
	slot["state"] = "loaded"
	slot["pending_reload"] = false
	slot["removed_pending"] = false
	slot["last_error"] = null
	_custom_slots[path] = slot


## 重建 "custom.xxx" -> script_path 索引;重名冲突后者 reload_failed 清空命令集
## (LuoxuanLove _rebuild_tool_index 同款;路径字典序靠前者赢——索引每次全量重建按 sort 顺序,与注册时间无关,冲突可诊断。P8 审查 N-3 措辞修正)。
func _rebuild_custom_index() -> void:
	_custom_index.clear()
	for path in _sorted_custom_paths():
		var slot: Dictionary = _custom_slots.get(path, {})
		for method in (slot.get("commands", {}) as Dictionary):
			if _custom_index.has(method):
				var conflict: Dictionary = _custom_slots.get(path, {})
				conflict["last_error"] = "Duplicate custom command name: %s (already registered by an earlier script)" % method
				conflict["state"] = "reload_failed"
				conflict["commands"] = {}
				_custom_slots[path] = conflict
				push_warning("[MCP Bridge] %s" % conflict["last_error"])
				continue
			_custom_index[method] = path


func _unload_custom_slot(path: String, reason: String) -> void:
	var slot: Dictionary = _custom_slots.get(path, {})
	if slot.is_empty():
		return
	var instance: Node = slot.get("instance", null)
	if instance != null:
		instance.queue_free()
	_custom_slots.erase(path)


func _sorted_custom_paths() -> Array:
	var paths: Array = []
	for path in _custom_slots.keys():
		paths.append(str(path))
	paths.sort()
	return paths


## 命令执行(active_calls 记账 + quiesce;P8-1)。调用中不换实例,完成后处理 pending 变更。
func _execute_custom_command(method: String, params: Dictionary) -> Variant:
	var path := str(_custom_index.get(method, ""))
	var slot: Dictionary = _custom_slots.get(path, {})
	if slot.is_empty() or slot.get("instance", null) == null:
		return {"error": {"code": -32601, "message": "Custom command not loaded: %s" % method}}
	if bool(slot.get("removed_pending", false)):
		return {"error": {"code": -32601, "message": "Custom command is pending unload: %s" % method}}
	var callable: Callable = (slot["commands"] as Dictionary).get(method, Callable())
	if not callable.is_valid():
		return {"error": {"code": -32601, "message": "Custom command callable invalid: %s" % method}}
	slot["active_calls"] = int(slot.get("active_calls", 0)) + 1
	_custom_slots[path] = slot
	var result: Variant = callable.call(params)
	# 全仓审查 GD I-6 (2026-09-12): 协程命令(内部 await)在首个 await 处挂起并立即返回
	# GDScriptFunctionState——① active_calls 立即归零,quiesce 不覆盖仍在执行的协程,
	# 下个 tick(≥300ms)热重载会释放其宿主实例,resume 时报 freed instance;
	# ② FunctionState 流入响应被 JSON.stringify 成无意义字符串,agent 无有效诊断。
	# 此处显式警告 + 阻止 FunctionState 流入响应(对齐内建 call_method 的协程检测先例
	# :1845——注意必须用 get_class() 字符串比较,`is GDScriptFunctionState` 类型检查
	# 在 Godot 4.x 会 Parse Error"Could not find type",autoload 直接挂掉)。
	if result is Object and result.get_class() == "GDScriptFunctionState":
		push_warning("[MCP Bridge] custom command '%s' is a coroutine (contains await); hot-reload quiesce does NOT cover it — make custom commands synchronous" % path)
		result = {"error": "custom command is a coroutine (contains await); quiesce/hot-reload cannot cover coroutines — make it synchronous"}
	slot = _custom_slots.get(path, slot)
	slot["active_calls"] = maxi(0, int(slot.get("active_calls", 1)) - 1)
	_custom_slots[path] = slot
	# quiesce:调用归零后处理 pending(重载/卸载)
	if int(slot["active_calls"]) == 0:
		if bool(slot.get("removed_pending", false)):
			_unload_custom_slot(path, "script_removed")
			_rebuild_custom_index()
		elif bool(slot.get("pending_reload", false)):
			_reload_custom_slot(path)
			_rebuild_custom_index()
	return result


## P8-1 内建诊断:custom.list 返回 slot 状态快照(agent 可观察热加载/reload_failed)。
func _custom_list() -> Variant:
	var slots: Array = []
	for path in _sorted_custom_paths():
		var slot: Dictionary = _custom_slots.get(path, {})
		slots.append({
			"script": path,
			"state": str(slot.get("state", "")),
			"version": int(slot.get("version", 0)),
			"commands": (slot.get("commands", {}) as Dictionary).keys(),
			"active_calls": int(slot.get("active_calls", 0)),
			"pending_reload": bool(slot.get("pending_reload", false)),
			"removed_pending": bool(slot.get("removed_pending", false)),
			"last_error": slot.get("last_error", null),
		})
	return {"slots": slots, "count": slots.size(), "commands": _custom_index.keys()}
