extends Node2D
## P3 (2026-09-11) e2e fixture 脚本:UI 按钮(CheckBox/Button)+ ENet peer 建立/拆除。
## P7 (2026-09-11) 扩展:语义观察层节点(_ready 动态创建,带 agent meta 声明)。
## GDA_CALLABLE 声明 call_method 可调面(P1-4 default deny;顺便验证与新功能联动)。

const GDA_CALLABLE := ["setup_net_peer", "clear_net_peer", "get_check_state", "get_p7_nodes", "hide_secret_enemy", "unhide_secret_enemy", "get_secret_position", "emit_p7_ping", "hide_main", "unhide_main", "toggle_p10_flag", "setup_b1_ui"]

## P7: watch 中途可见性用例——player 档 watch 本信号,游戏 hide_main() 后事件不再记录。
signal p7_ping(value: int)

var _net_peer: ENetMultiplayerPeer = null


func _ready() -> void:
	_setup_p7_nodes()


## P7: 动态创建观察层测试节点(比 .tscn 静态 meta 灵活——可运行中改 meta 测动态语义)。
## 节点清单(position 均为 Node2D 局部坐标,Main 在原点,global 同值):
## - SecretEnemy(300,400):字段规则——position quantize(步长 64)、hp redact、
##   score replace(替值 999)、name_tag omit。debug 档全可见,player 档投影后可见。
## - HiddenParent(500,500):agent_exposure=private——player 档整藏。
## - ChildOfHidden(500,500):无自身 meta,祖先 private 级联藏(级联核心用例)。
## - FoggedOut(200,700):visible_to_player=false——player 档藏(与 private 正交的第二维度)。
## - PlainNode(100,100):无 meta——两档均可见(投影不误伤)。
func _setup_p7_nodes() -> void:
	var secret := Node2D.new()
	secret.name = "SecretEnemy"
	secret.position = Vector2(300, 400)
	# 脚本属性进 get_property_list(裸 Node2D 的 set() 无属性槽会报错);
	# meta 声明字段规则,脚本属性是被投影的数据本体。
	secret.set_script(load("res://p7_enemy.gd"))
	secret.set_meta("agent_field_rules", [
		{"path": "position", "mode": "quantize", "quantum": 64},
		{"path": "hp", "mode": "redact"},
		{"path": "score", "mode": "replace", "replacement": 999},
		{"path": "name_tag", "mode": "omit"},
	])
	add_child(secret)

	var hidden := Node2D.new()
	hidden.name = "HiddenParent"
	hidden.position = Vector2(500, 500)
	hidden.set_meta("agent_exposure", "private")
	add_child(hidden)
	var child := Node2D.new()
	child.name = "ChildOfHidden"
	child.position = Vector2(500, 500)
	hidden.add_child(child)

	var fogged := Node2D.new()
	fogged.name = "FoggedOut"
	fogged.position = Vector2(200, 700)
	fogged.set_meta("visible_to_player", false)
	add_child(fogged)

	var plain := Node2D.new()
	plain.name = "PlainNode"
	plain.position = Vector2(100, 100)
	add_child(plain)


func get_p7_nodes() -> Dictionary:
	var out: Dictionary = {}
	for n in ["SecretEnemy", "HiddenParent", "ChildOfHidden", "FoggedOut", "PlainNode"]:
		var node := get_node_or_null(str(n))
		out[str(n)] = node.get_path() if node != null else ""
	return out


## P7: 游戏代码把 SecretEnemy 运行中藏起来(monitor/watch 中途可见性用例)。
func hide_secret_enemy() -> Dictionary:
	var node := get_node_or_null("SecretEnemy")
	if node == null:
		return {"ok": false}
	node.set_meta("agent_exposure", "private")
	return {"ok": true}


func unhide_secret_enemy() -> Dictionary:
	var node := get_node_or_null("SecretEnemy")
	if node == null:
		return {"ok": false}
	node.remove_meta("agent_exposure")
	return {"ok": true}


func get_secret_position() -> Dictionary:
	var node := get_node_or_null("SecretEnemy")
	if node == null:
		return {"found": false}
	return {"found": true, "x": node.position.x, "y": node.position.y}


func emit_p7_ping() -> Dictionary:
	p7_ping.emit(randi() % 1000)
	return {"ok": true}


func hide_main() -> Dictionary:
	set_meta("agent_exposure", "private")
	return {"ok": true}


func unhide_main() -> Dictionary:
	remove_meta("agent_exposure")
	return {"ok": true}


func setup_net_peer() -> Dictionary:
	if _net_peer != null:
		return {"ok": true, "already": true}
	_net_peer = ENetMultiplayerPeer.new()
	# port 0 = 系统分配空闲端口(不与并发测试互撞)。
	# ⚠️ 不调 get_local_port():Windows Godot 4.6.3 实测该调用阻塞挂死主循环
	# (探针二分定位:port 查询挂,set_multiplayer_peer 不挂;port 信息对 e2e 非必需)。
	var err := _net_peer.create_server(0, 32)
	if err != OK:
		_net_peer = null
		return {"ok": false, "error": err}
	get_tree().get_multiplayer().set_multiplayer_peer(_net_peer)
	return {"ok": true}


func clear_net_peer() -> Dictionary:
	if _net_peer == null:
		return {"ok": true, "already": false}
	var mp := get_tree().get_multiplayer()
	if mp.get_multiplayer_peer() == _net_peer:
		mp.set_multiplayer_peer(OfflineMultiplayerPeer.new())
	_net_peer.close()
	_net_peer = null
	return {"ok": true}


func get_check_state() -> Dictionary:
	var cb := get_node_or_null("UI/Root/MyCheck") as CheckBox
	if cb == null:
		return {"found": false}
	return {
		"found": true,
		"button_pressed": cb.button_pressed,
		"visible": cb.visible,
		"disabled": cb.disabled,
	}

## P10 (2026-09-12) sync_state 约定:实现 _mcp_state() 的节点被 collect_state 收集。
## 返回离散状态(wave/score 类);另有可写 p10_flag 供 e2e 验证快照 diff。
var p10_flag := false
var p10_ticks := 0
var p10_pos := Vector2(10.0, 20.0)


## B1 (2026-10-19): find_ui_elements role/match 用例控件——_ready 不建、用例内显建,
## 不扰动既有 pattern 断言的元素集合。补齐 fixture 缺的 8 种 role 场景控件
## (combobox/list/tablist/progressbar/text/textbox/slider/scrollarea);
## 名字带 B1 前缀,与 MyCheck/MyButton 的 pattern 匹配不互撞。
## B1Text/B1Line 带 text 供 match=exact/contains 的 text/label 通道用例。
func setup_b1_ui() -> Dictionary:
	var root := get_node_or_null("UI/Root") as Control
	if root == null:
		return {"ok": false}
	var combo := OptionButton.new()
	combo.name = "B1Combo"
	combo.add_item("Alpha")
	combo.add_item("Beta")
	root.add_child(combo)
	var list := ItemList.new()
	list.name = "B1List"
	root.add_child(list)
	var tabs := TabContainer.new()
	tabs.name = "B1Tab"
	var page := Control.new()
	page.name = "B1TabPage"
	tabs.add_child(page)
	root.add_child(tabs)
	var progress := ProgressBar.new()
	progress.name = "B1Progress"
	progress.value = 40.0
	root.add_child(progress)
	var label := Label.new()
	label.name = "B1Text"
	label.text = "LabelTextSample"
	root.add_child(label)
	var edit := LineEdit.new()
	edit.name = "B1Line"
	edit.text = "EditSample"
	root.add_child(edit)
	var slide := HSlider.new()
	slide.name = "B1Slide"
	root.add_child(slide)
	var scroll := ScrollContainer.new()
	scroll.name = "B1Scroll"
	var inner := Label.new()
	inner.name = "B1ScrollText"
	inner.text = "Inner"
	scroll.add_child(inner)
	root.add_child(scroll)
	return {"ok": true}


func _mcp_state() -> Dictionary:
	## pos 是 Vector2:collect_state 的 _state_safe 转 {x,y} dict(B-1 清偿),
	## e2e 验证微差 Vector2 在容差内不产生 diff(toggle 顺带微移 0.00001)。
	return {"scene": "p3-e2e", "flag": p10_flag, "ticks": p10_ticks, "pos": p10_pos}


func toggle_p10_flag() -> Dictionary:
	p10_flag = not p10_flag
	p10_ticks += 1
	p10_pos += Vector2(0.00001, 0.0)  # 容差内微移:验证 compare 不误报(B-1 e2e 锚)
	return {"flag": p10_flag}
