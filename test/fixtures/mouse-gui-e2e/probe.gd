# C1 (2026-09-17) 反馈批次C fixture 探针:复现 09-10「send_mouse_click 对普通
# Control.gui_input(tap 判定链)不触发——Button/TextureButton 的 pressed 链正常」。
# 对照组:Button(走 BaseButton._gui_input → pressed 信号);实验组:普通 Control
# (MOUSE_FILTER_STOP + gui_input 信号,press 记录→release 位移判 is_tap,复刻
# CardGame2 列表条目判定链)。_input 探针同时计数引擎管线到达 root 层的鼠标事件,
# 用于区分「事件未进管线」vs「进了管线但 GUI 派发不到 Control」。
# D5/D2 (2026-09-17) 反馈批次D 扩展:touch/key 注入探针(device 值分布,锚定
# device=0 对称收口)+ CanvasLayer 子节点(核实 find_nodes 对非 CanvasItem 盲区)。
# 所有暴露方法 get_* 前缀 = bridge call_method 只读白名单。
extends Node2D

var control_gui_count := 0
var control_last_event := {}
var control_taps := 0
var button_press_count := 0
var button_gui_count := 0
var engine_mouse_events := 0
var engine_touch_events := 0
var touch_device_counts := {}
var engine_key_events := 0
var key_device_counts := {}

var _press_pos := Vector2.ZERO
var _press_valid := false
var _ctl: Control
var _btn: Button


func _ready() -> void:
	_ctl = Control.new()
	_ctl.position = Vector2(100, 100)
	_ctl.size = Vector2(200, 200)
	_ctl.mouse_filter = Control.MOUSE_FILTER_STOP
	_ctl.gui_input.connect(_on_ctl_gui_input)
	add_child(_ctl)

	_btn = Button.new()
	_btn.text = "Click"
	_btn.position = Vector2(400, 100)
	_btn.size = Vector2(120, 60)
	_btn.pressed.connect(func() -> void: button_press_count += 1)
	_btn.gui_input.connect(func(_ev: InputEvent) -> void: button_gui_count += 1)
	add_child(_btn)

	# D2 (2026-09-17 反馈批次D): 复刻 fr2 2026-09-02 反馈场景——MapPanel 是
	# CanvasLayer(Node 直接子类,非 CanvasItem),layer=12。用于真机核实
	# find_nodes(全 Node 递归)当前版本无盲区 + 防回归锚定。
	var map_panel := CanvasLayer.new()
	map_panel.name = "MapPanel"
	map_panel.layer = 12
	add_child(map_panel)


func _input(ev: InputEvent) -> void:
	if ev is InputEventMouse:
		engine_mouse_events += 1
	elif ev is InputEventScreenTouch or ev is InputEventScreenDrag:
		engine_touch_events += 1
		var d := str(ev.device)
		touch_device_counts[d] = int(touch_device_counts.get(d, 0)) + 1
	elif ev is InputEventKey:
		engine_key_events += 1
		var d := str(ev.device)
		key_device_counts[d] = int(key_device_counts.get(d, 0)) + 1


func _on_ctl_gui_input(ev: InputEvent) -> void:
	control_gui_count += 1
	if ev is InputEventMouseButton:
		var mb := ev as InputEventMouseButton
		control_last_event = {
			"kind": "mouse_button",
			"button_index": mb.button_index,
			"pressed": mb.pressed,
			"position": [mb.position.x, mb.position.y],
			"global_position": [mb.global_position.x, mb.global_position.y],
			"device": mb.device,
			"window_id": mb.window_id,
		}
		if mb.pressed:
			_press_pos = mb.position
			_press_valid = true
		elif _press_valid:
			# 复刻 CardGame2 tap 判定:release 时比较与 press 的位移
			if mb.position.distance_to(_press_pos) < 8.0:
				control_taps += 1
			_press_valid = false
	elif ev is InputEventMouseMotion:
		var mm := ev as InputEventMouseMotion
		control_last_event = {
			"kind": "motion",
			"position": [mm.position.x, mm.position.y],
			"global_position": [mm.global_position.x, mm.global_position.y],
			"device": mm.device,
			"window_id": mm.window_id,
		}


func get_ctl_center() -> Dictionary:
	var r := _ctl.get_global_rect()
	return {"x": r.get_center().x, "y": r.get_center().y}


func get_btn_center() -> Dictionary:
	var r := _btn.get_global_rect()
	return {"x": r.get_center().x, "y": r.get_center().y}


func get_probe_state() -> Dictionary:
	return {
		"control_gui_count": control_gui_count,
		"control_last_event": control_last_event,
		"control_taps": control_taps,
		"button_press_count": button_press_count,
		"button_gui_count": button_gui_count,
		"engine_mouse_events": engine_mouse_events,
		"engine_touch_events": engine_touch_events,
		"touch_device_counts": touch_device_counts,
		"engine_key_events": engine_key_events,
		"key_device_counts": key_device_counts,
	}
