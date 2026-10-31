# 批 D (2026-10-26): 工具正确性审计 fixture——引擎裁决锚点。
# _ready 由引擎实跑设置 text,审计契约经 bridge node_state/screen_text 断言。
extends Label


func _ready() -> void:
	text = "AUDIT-FIXTURE"
