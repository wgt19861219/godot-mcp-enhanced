extends Area2D
# Task 7(0.33.3 双项目验收):area 声明补全——静态扫描样本此前从未真跑,parse error
# 会阻断脚本加载($Sub 无 hit 信号,连带 main.tscn 的编辑器连接失败)。内部类信号桩
# 保持 "area.clear_shapes.disconnect" 调用字面不变(scanGdScriptSignals 断言零影响)。

class AreaStub:
	signal clear_shapes

signal hit

var area := AreaStub.new()

func _exit_tree() -> void:
	area.clear_shapes.disconnect(_on_clear)

func _on_body(_b: Node) -> void:
	hit.emit()

func _on_clear() -> void:
	pass
