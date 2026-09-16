extends Node

var _plugin: EditorPlugin

# Recording state
var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0
# E3: mouse_motion 每帧多次触发 → 降采样 + 上限防 _recorded_events 无限增长 OOM
const _MOTION_MIN_INTERVAL_MS := 16  # ~60fps,过密的 mouse_motion 跳过
const _MAX_RECORDED_EVENTS := 50000  # 兜底上限,超限丢弃并警告
var _last_motion_time: int = 0

# CRITICAL-2 (R2): 回放事件总数上限防 OOM(百万级 events_json 致编辑器崩溃),与 TS MAX_RECORDING_EVENTS 对齐
const MAX_PLAYBACK_EVENTS := 10000

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func _input(event: InputEvent) -> void:
	# P0-4 fix: 编辑器态不捕获输入(防抢占编辑器快捷键 + 回放重注入触发 Ctrl+S/Delete 等危险操作)
	# recording 走 Bridge(game-bridge)运行时游戏捕获, 编辑器插件路径禁用
	if Engine.is_editor_hint():
		return
	if not _recording:
		return
	var now := Time.get_ticks_msec()
	if event is InputEventKey:
		var entry: Dictionary = {
			"type": "key",
			"keycode": event.keycode,
			"pressed": event.pressed,
			"shift": event.shift_pressed,
			"ctrl": event.ctrl_pressed,
			"alt": event.alt_pressed,
			"time_offset": now - _record_start_time
		}
		_append_event(entry)
	elif event is InputEventMouseButton:
		var entry: Dictionary = {
			"type": "mouse_click",
			"position": [event.position.x, event.position.y],
			"button": event.button_index,
			"pressed": event.pressed,
			"time_offset": now - _record_start_time
		}
		_append_event(entry)
	elif event is InputEventMouseMotion:
		# E3: 降采样 — 跳过过密的 mouse_motion(每帧多个),防 _recorded_events 无限增长 OOM
		if now - _last_motion_time < _MOTION_MIN_INTERVAL_MS:
			return
		_last_motion_time = now
		var entry: Dictionary = {
			"type": "mouse_move",
			"position": [event.position.x, event.position.y],
			"time_offset": now - _record_start_time
		}
		_append_event(entry)
	elif event is InputEventScreenTouch:  # IMP-11 (2026-06-26 review): 触摸事件录制(触屏设备)
		var entry: Dictionary = {
			"type": "touch",
			"position": [event.position.x, event.position.y],
			"pressed": event.pressed,
			"index": event.index,
			"time_offset": Time.get_ticks_msec() - _record_start_time
		}
		_append_event(entry)
	elif event is InputEventScreenDrag:  # IMP-11 补全: 拖拽录制(对齐 bridge _input + _cmd_send_drag 契约)
		# speed 键是 MCP 录制契约名保留;引擎属性读取走 velocity(Godot 4 改名,2026-09-16 跨项目验证发现)
		var drag_entry: Dictionary = {
			"type": "touch_drag",
			"position": [event.position.x, event.position.y],
			"index": event.index,
			"relative": [event.relative.x, event.relative.y],
			"speed": [event.velocity.x, event.velocity.y],
			"time_offset": Time.get_ticks_msec() - _record_start_time
		}
		_append_event(drag_entry)


# E3: 带上限的事件追加,超 _MAX_RECORDED_EVENTS 丢弃并警告(防 OOM)
func _append_event(entry: Dictionary) -> void:
	if _recorded_events.size() >= _MAX_RECORDED_EVENTS:
		push_warning("[MCP] Recording: max events (%d) reached, dropping further events" % _MAX_RECORDED_EVENTS)
		return
	_recorded_events.append(entry)


# ─── recording_start ────────────────────────────────────────────────────────

func handle_recording_start(params: Dictionary) -> Dictionary:
	# P0-4 fix: 编辑器态拒绝录制, recording 应走 Bridge
	if Engine.is_editor_hint():
		return {"error": {"code": -32009, "message": "Recording in editor mode is disabled. Use game_bridge (Bridge) recording instead - editor _input capture is disabled to avoid side effects."}}
	_recording = true
	_recorded_events = []
	_record_start_time = Time.get_ticks_msec()

	return {"result": {"status": "recording", "message": "Input events are being captured via editor plugin"}}

# ─── recording_stop ─────────────────────────────────────────────────────────

func handle_recording_stop(params: Dictionary) -> Dictionary:
	if not _recording:
		return {"error": {"code": -32004, "message": "No recording in progress"}}

	_recording = false
	var duration_ms = Time.get_ticks_msec() - _record_start_time
	var events = _recorded_events.duplicate()
	_recorded_events = []

	return {"result": {"version": 1, "duration_ms": duration_ms, "events": events, "event_count": events.size()}}

# ─── recording_play ─────────────────────────────────────────────────────────

func handle_recording_play(params: Dictionary) -> Dictionary:
	# P0-4 fix: 编辑器态拒绝回放(防 Input.parse_input_event 重注入编辑器触发危险操作)
	if Engine.is_editor_hint():
		return {"error": {"code": -32009, "message": "Playback in editor mode is disabled. Use game_bridge (Bridge) recording playback instead."}}
	var events_json: String = params.get("events_json", "")
	if events_json == "":
		return {"error": {"code": -32004, "message": "events_json is required"}}

	var parsed = JSON.parse_string(events_json)
	if parsed == null:
		return {"error": {"code": -32004, "message": "Invalid events JSON"}}

	var events = parsed.get("events") if parsed is Dictionary else []
	if events == null or not (events is Array):
		return {"error": {"code": -32004, "message": "events_json must contain an events array"}}
	# CRITICAL-2 (R2): 事件总数上限防 OOM(恶意/失控客户端传百万级 events_json)
	if events.size() > MAX_PLAYBACK_EVENTS:
		return {"error": {"code": -32004, "message": "events array exceeds limit %d (got %d) — potential OOM" % [MAX_PLAYBACK_EVENTS, events.size()]}}

	var speed = params.get("speed")
	var speed_val = float(speed) if speed != null else 1.0
	if speed_val <= 0.0:
		speed_val = 1.0

	var played_count = 0
	# Schedule events with time offsets using a Timer for proper delays
	if events.size() == 0:
		return {"result": {"events_queued": 0, "speed": speed_val, "status": "playback_complete"}}

	# Build a sorted schedule of (delay_ms, event) pairs
	var schedule: Array = []
	var base_offset: float = 0.0
	for evt in events:
		if not (evt is Dictionary):
			continue
		var offset: float = float(evt.get("time_offset", evt.get("time_ms", 0.0))) / speed_val
		schedule.append({"delay": offset - base_offset, "event": evt})
		base_offset = offset

	_playback_schedule = schedule
	_playback_index = 0
	_playback_count = 0

	# Start playback via timer
	_schedule_next_event()

	return {"result": {"events_queued": events.size(), "speed": speed_val, "status": "playback_started"}}

var _playback_schedule: Array = []
var _playback_index: int = 0
var _playback_count: int = 0
var _playback_timer: Timer = null

func _schedule_next_event() -> void:
	var zero_delay_count := 0
	const MAX_ZERO_DELAY_PER_FRAME := 100
	while _playback_index < _playback_schedule.size():
		var entry: Dictionary = _playback_schedule[_playback_index]
		var delay_ms: float = entry.get("delay", 0.0)
		_playback_index += 1

		if delay_ms <= 1.0:
			zero_delay_count += 1
			if zero_delay_count >= MAX_ZERO_DELAY_PER_FRAME:
				# 2026-08-07 审查 P2 修复：达上限时不能先 fire 再 start timer——
				# _on_playback_timer_timeout(:205) 会重发 _playback_index-1 处的同一事件，
				# 致第 100 个事件被重复发射一次（回放失真）。改为回退 index 让 timer
				# 到时走正常"未 fire → timer fire"路径，当前事件只发一次。
				push_warning("[MCP] Recording: max zero-delay events per frame reached (%d), deferring" % MAX_ZERO_DELAY_PER_FRAME)
				_playback_index -= 1  # 撤销本次自增，让 timer timeout 的 :205 正常 fire 此事件
				_ensure_playback_timer()
				_playback_timer.start(0.001)
				return
			_fire_playback_event(entry.get("event"))
			continue
		else:
			_ensure_playback_timer()
			_playback_timer.start(delay_ms / 1000.0)
			return

	# All events processed
	_playback_schedule = []
	_playback_index = 0


func _ensure_playback_timer() -> void:
	if _playback_timer == null:
		_playback_timer = Timer.new()
		_playback_timer.one_shot = true
		_playback_timer.timeout.connect(_on_playback_timer_timeout)
		add_child(_playback_timer)

func _on_playback_timer_timeout() -> void:
	if _playback_index > 0 and _playback_index <= _playback_schedule.size():
		var entry: Dictionary = _playback_schedule[_playback_index - 1]
		_fire_playback_event(entry.get("event"))
	_schedule_next_event()

func _fire_playback_event(evt: Dictionary) -> void:
	if evt == null:
		return
	var evt_type: String = str(evt.get("type", ""))
	match evt_type:
		"key":
			var ie = InputEventKey.new()
			ie.keycode = int(evt.get("keycode", 0))
			ie.pressed = bool(evt.get("pressed", true))
			ie.shift_pressed = bool(evt.get("shift", false))
			ie.ctrl_pressed = bool(evt.get("ctrl", false))
			ie.alt_pressed = bool(evt.get("alt", false))
			Input.parse_input_event(ie)
		"mouse_click":
			var ie = InputEventMouseButton.new()
			var pos = evt.get("position", [0.0, 0.0])
			if pos is Array and pos.size() >= 2:
				ie.position = Vector2(float(pos[0]), float(pos[1]))
			ie.button_index = int(evt.get("button", 1))
			ie.pressed = bool(evt.get("pressed", true))
			Input.parse_input_event(ie)
		"mouse_move":
			var ie = InputEventMouseMotion.new()
			var pos = evt.get("position", [0.0, 0.0])
			if pos is Array and pos.size() >= 2:
				ie.position = Vector2(float(pos[0]), float(pos[1]))
			Input.parse_input_event(ie)
		"touch":  # IMP-11: 触摸回放
			var ie = InputEventScreenTouch.new()
			var pos = evt.get("position", [0.0, 0.0])
			if pos is Array and pos.size() >= 2:
				ie.position = Vector2(float(pos[0]), float(pos[1]))
			ie.pressed = bool(evt.get("pressed", true))
			ie.index = int(evt.get("index", 0))
			Input.parse_input_event(ie)
		"touch_drag":  # IMP-11 补全: 拖拽回放(speed best-effort)
			var ie = InputEventScreenDrag.new()
			var pos = evt.get("position", [0.0, 0.0])
			if pos is Array and pos.size() >= 2:
				ie.position = Vector2(float(pos[0]), float(pos[1]))
			ie.index = int(evt.get("index", 0))
			var rel = evt.get("relative", [0.0, 0.0])
			if rel is Array and rel.size() >= 2:
				ie.relative = Vector2(float(rel[0]), float(rel[1]))
			var spd = evt.get("speed", [0.0, 0.0])
			if spd is Array and spd.size() >= 2:
				ie.velocity = Vector2(float(spd[0]), float(spd[1]))  # 引擎属性 velocity(Godot 4 改名;speed 是 MCP 契约键名)
			Input.parse_input_event(ie)
	_playback_count += 1

func cleanup() -> void:
	_recording = false
	_recorded_events = []
	_playback_schedule = []
	_playback_index = 0
	if _playback_timer != null:
		_playback_timer.stop()
		remove_child(_playback_timer)
		_playback_timer.queue_free()
		_playback_timer = null
