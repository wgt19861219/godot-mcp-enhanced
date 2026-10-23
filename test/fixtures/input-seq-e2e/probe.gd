# H1 (2026-08-20) send_input_sequence e2e 探针:运行时注册 action "jump"(避免手写
# project.godot [input] 序列化),每物理帧记录首次读到 pressed 的全局帧号与累计帧数。
# get_probe_state 走 bridge call_method 只读白名单(get_*)。
extends Node2D

var first_seen_frame := -1
var first_seen_action := ""
var frames_run := 0
var press_count := 0

func _ready() -> void:
	# 2026-10-23 CI 红修复:headless 主循环无 vsync 不限帧,CI 快机上帧率可远超 60fps,
	# wall_timeout 用例(at_frame=600 + 1s wall 预算)的"600 帧 ≈ 10s ≫ 1s 必截断"假设失效
	# (实测 4.7.2 job:1s 内跑完 600 帧 → success=true 红)。限主循环 60fps 使 process 帧
	# (at_frame 对齐 Engine.get_process_frames())与 physics 帧同速,截断语义在任意机型稳定。
	# freeze/step 用例不受影响(冻结态帧由 playtest.step 驱动,不走真实时间节流)。
	Engine.max_fps = 60
	if not InputMap.has_action("jump"):
		InputMap.add_action("jump")
	var ev := InputEventKey.new()
	ev.physical_keycode = KEY_SPACE
	InputMap.action_add_event("jump", ev)

func _physics_process(_delta: float) -> void:
	frames_run += 1
	if first_seen_frame == -1 and Input.is_action_just_pressed("jump"):
		first_seen_frame = Engine.get_process_frames()
		first_seen_action = "jump"
	if Input.is_action_just_pressed("jump"):
		press_count += 1

func get_probe_state() -> Dictionary:
	return {
		"first_seen_frame": first_seen_frame,
		"first_seen_action": first_seen_action,
		"frames_run": frames_run,
		"press_count": press_count,
		"action_pressed": Input.is_action_pressed("jump"),
	}

# 坑4(2026-08-21 反馈批)e2e 探针:协程方法——call_method 默认应返 {coroutine:true},
# await_completion=true 应等待并返真值。非 get_* 前缀,须 GODOT_MCP_BRIDGE_EXTRA_METHODS=slow_add。
func slow_add(a: int, b: int) -> int:
	await get_tree().process_frame
	return a + b
