extends Node

var _plugin: EditorPlugin

# Recording state
var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func _input(event: InputEvent) -> void:
	if not _recording:
		return
	if event is InputEventKey:
		var entry: Dictionary = {
			"type": "key",
			"keycode": event.keycode,
			"pressed": event.pressed,
			"shift": event.shift_pressed,
			"ctrl": event.ctrl_pressed,
			"alt": event.alt_pressed,
			"time_offset": Time.get_ticks_msec() - _record_start_time
		}
		_recorded_events.append(entry)
	elif event is InputEventMouseButton:
		var entry: Dictionary = {
			"type": "mouse_click",
			"position": [event.position.x, event.position.y],
			"button": event.button_index,
			"pressed": event.pressed,
			"time_offset": Time.get_ticks_msec() - _record_start_time
		}
		_recorded_events.append(entry)
	elif event is InputEventMouseMotion:
		var entry: Dictionary = {
			"type": "mouse_move",
			"position": [event.position.x, event.position.y],
			"time_offset": Time.get_ticks_msec() - _record_start_time
		}
		_recorded_events.append(entry)

# ─── recording_start ────────────────────────────────────────────────────────

func handle_recording_start(params: Dictionary) -> Dictionary:
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
	var events_json: String = params.get("events_json", "")
	if events_json == "":
		return {"error": {"code": -32004, "message": "events_json is required"}}

	var parsed = JSON.parse_string(events_json)
	if parsed == null:
		return {"error": {"code": -32004, "message": "Invalid events JSON"}}

	var events = parsed.get("events") if parsed is Dictionary else []
	if events == null or not (events is Array):
		return {"error": {"code": -32004, "message": "events_json must contain an events array"}}

	var speed = params.get("speed")
	var speed_val = float(speed) if speed != null else 1.0
	if speed_val <= 0.0:
		speed_val = 1.0

	var played_count = 0
	for evt in events:
		if not (evt is Dictionary):
			continue
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
		played_count += 1

	return {"result": {"events_played": played_count, "speed": speed_val, "status": "playback_complete"}}

func cleanup() -> void:
	_recording = false
	_recorded_events = []
