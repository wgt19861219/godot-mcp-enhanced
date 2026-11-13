# A2 (2026-11-12 反馈批次) fixture 探针:自毁钮——Button pressed handler 内 queue_free
# 自身(复刻三项目反馈场景:点击后按钮被 handler 释放,bridge verify 协程 await 归来后
# 节点已 free)。暴露方法经 GODOT_MCP_BRIDGE_EXTRA_METHODS env 放行(e2e 测试进程内设置):
# - get_self_destruct_btn: 惰性创建/重建自毁钮,返回 path + 中心坐标
# - get_sd_state: 自毁计数 + 按钮存活状态(证明 handler 真跑 + 按钮真自毁)
extends Node2D

var self_destruct_press_count := 0

var _sd_btn: Button = null


func _ready() -> void:
	_spawn_self_destruct()


func _spawn_self_destruct() -> void:
	var b := Button.new()
	b.text = "SelfDestruct"
	b.position = Vector2(400, 300)
	b.size = Vector2(160, 60)
	# lambda 按值捕获对象引用:handler 内 b.queue_free() = 按钮自毁自身(反馈场景同款)
	var ref := b
	b.pressed.connect(
		func() -> void:
			self_destruct_press_count += 1
			ref.queue_free()
	)
	add_child(b)
	_sd_btn = b


func get_self_destruct_btn() -> Dictionary:
	# 惰性重建:被点自毁后(节点已 free)重建新钮;首次调用时 _ready 已建,直接返回
	if not is_instance_valid(_sd_btn):
		_spawn_self_destruct()
	var r := _sd_btn.get_global_rect()
	return {"path": str(_sd_btn.get_path()), "x": r.get_center().x, "y": r.get_center().y}


func get_sd_state() -> Dictionary:
	return {
		"press_count": self_destruct_press_count,
		"btn_valid": is_instance_valid(_sd_btn),
	}
