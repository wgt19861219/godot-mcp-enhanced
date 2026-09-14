extends Node2D
# analysis fixture：正向（代码连接/发射）+ 负向（注释/字符串内同名调用不得误报）
# Task 7(0.33.3 双项目验收):Sub 声明补全——静态扫描样本此前从未真跑,"Sub" 未声明
# 的 parse error 会阻断脚本加载与 _ready(print 特征行不执行)。内部类信号桩保持
# "Sub.hit.connect" 调用字面不变(scanGdScriptSignals/signal_map 断言零影响)。

class SubStub:
	signal hit

signal game_over

var Sub := SubStub.new()

func _ready() -> void:
	# Task 7 双项目验收:输出隔离特征行(不含 connect/emit 模式,不影响 scanGdScriptSignals 断言)
	print("ANALYSIS-FIXTURE-MARKER per-project bucket isolation")
	game_over.connect(_on_game_over)
	$Button.pressed.connect(_on_button_pressed)
	# emit_signal("fake_in_comment")
	var s = "emit_signal(\"in_string\")"
	emit_signal("game_over")
	Sub.hit.connect(_on_sub_hit)

func _on_button_pressed() -> void:
	pass

func _on_game_over() -> void:
	pass

func _on_sub_hit() -> void:
	pass
