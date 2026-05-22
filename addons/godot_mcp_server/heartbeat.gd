extends Node

const PING_INTERVAL := 5.0
const INACTIVITY_TIMEOUT := 30.0

signal timeout_detected()

# Per-peer activity tracking
var _peer_activity: Dictionary = {}  # peer_id -> { activity: float, ping: float }
var _is_paused: bool = false
var _operation_timeout: float = 0.0
var _operation_timer: float = 0.0


func reset_activity(peer_id: int = -1) -> void:
	if peer_id == -1:
		for key in _peer_activity:
			_peer_activity[key].activity = 0.0
	else:
		if _peer_activity.has(peer_id):
			_peer_activity[peer_id].activity = 0.0


func remove_peer(peer_id: int) -> void:
	_peer_activity.erase(peer_id)


func tick(delta: float, peer: WebSocketPeer) -> void:
	if _is_paused:
		_operation_timer += delta
		if _operation_timer > _operation_timeout:
			_is_paused = false
			emit_signal("timeout_detected")
		return

	var pid: int = peer.get_instance_id()
	if not _peer_activity.has(pid):
		_peer_activity[pid] = { "activity": 0.0, "ping": 0.0 }

	var state: Dictionary = _peer_activity[pid]
	state.activity += delta
	state.ping += delta

	if state.activity > INACTIVITY_TIMEOUT:
		emit_signal("timeout_detected")
		return

	if state.ping >= PING_INTERVAL:
		state.ping = 0.0
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "method": "ping", "params": {}}))


func pause_for_operation(timeout_sec: float) -> void:
	_is_paused = true
	_operation_timeout = min(timeout_sec, 600.0)
	_operation_timer = 0.0


func resume() -> void:
	_is_paused = false
	for key in _peer_activity:
		_peer_activity[key].activity = 0.0
		_peer_activity[key].ping = 0.0
