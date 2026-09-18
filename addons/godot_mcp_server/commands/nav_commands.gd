extends Node

var _plugin: EditorPlugin
var _undo_manager: Node

func setup(plugin: EditorPlugin, undo_manager: Node = null) -> void:
	_plugin = plugin
	_undo_manager = undo_manager


func cleanup() -> void:
	# 阶段5(:649): 统一 cleanup 接口(与 incomplete-cleanup-command-nodes fix 一致)。本模块无信号/定时器,释放引用助 GC。
	_plugin = null
	_undo_manager = null


# CMP-16-A (2026-08-08): param docs metadata。
func get_command_docs() -> Dictionary:
	return {
		"nav_create_region": {
			"description": "创建 NavigationRegion3D 节点,可选立即 bake 导航网格。",
			"params": [
				CommandHelpers.doc_param("name", "String", false, "节点名默认 NavRegion"),
				CommandHelpers.doc_param("parent", "String", false, "父节点路径空则挂根"),
				CommandHelpers.doc_param("position", "Dictionary", false, "键 x/y/z float → Vector3 局部坐标"),
				CommandHelpers.doc_param("bake", "bool", false, "创建后是否立即 bake 默认 false"),
			],
		},
		"nav_bake_mesh": {
			"description": "对指定 NavigationRegion3D bake 导航网格。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 NavigationRegion3D 路径"),
			],
		},
		"nav_create_agent": {
			"description": "创建 NavigationAgent3D 节点并设置避障参数。",
			"params": [
				CommandHelpers.doc_param("name", "String", false, "默认 NavAgent"),
				CommandHelpers.doc_param("parent", "String", false, "父节点路径"),
				CommandHelpers.doc_param("target_position", "Dictionary", false, "键 x/y/z → Vector3 目标位置"),
				CommandHelpers.doc_param("path_desired_distance", "float", false, "路径到达阈值默认 0.5"),
				CommandHelpers.doc_param("target_desired_distance", "float", false, "目标到达阈值默认 1.0"),
				CommandHelpers.doc_param("avoidance_enabled", "bool", false, "是否启用避障默认 false"),
			],
		},
		"nav_set_params": {
			"description": "批量设置 NavigationAgent3D 的参数。",
			"params": [
				CommandHelpers.doc_param("node_path", "String", true, "目标 NavigationAgent3D 路径"),
				CommandHelpers.doc_param("params", "Dictionary", true, "键值表支持 path_desired_distance/target_desired_distance/radius/height/max_speed/avoidance_enabled 等"),
			],
		},
		"nav_create_link": {
			"description": "创建 NavigationLink3D 节点连接两处导航区域。",
			"params": [
				CommandHelpers.doc_param("name", "String", false, "默认 NavLink"),
				CommandHelpers.doc_param("parent", "String", false, "父节点路径"),
				CommandHelpers.doc_param("start_position", "Dictionary", false, "键 x/y/z → Vector3 起点"),
				CommandHelpers.doc_param("end_position", "Dictionary", false, "键 x/y/z → Vector3 终点"),
				CommandHelpers.doc_param("bidirectional", "bool", false, "是否双向默认 true"),
			],
		},
	}


func handle_nav_create_region(params: Dictionary, request_id: int) -> Dictionary:
	# C4 resolved (2026-07-28, A-lite async-dispatch, fallback 信号方案): bake 经
	# handle_nav_create_region_async coroutine 等 bake_finished 信号完成（Task 0 实测
	# NavigationRegion3D 无 is_baking/baking 属性，BAKING_PROPS 空，is_baking 轮询不可用；
	# bake_navigation_mesh 返 void；改用 bake_finished 信号 + 循环内 is_instance_valid 守卫，
	# 判据 navigation_mesh.get_vertices().size() > 0 —— get_vertices_count() 不存在）。
	# 原同步 handle_nav_create_region 保留作兜底；websocket_server.gd 分流 nav 到 _async 版。
	# redo 路径仍乐观（editor undo 系统限制，spec §11）。
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	var created = _create_nav_region(params, root)
	if created.has("error"):
		return created
	var nav = created.nav
	var parent_node = created.parent

	var want_bake: bool = params.get("bake", false)
	var bake_result: bool = false
	if _undo_manager != null:
		var do_ops: Array = [
			{"type": "method", "target": parent_node, "method": "add_child", "args": [nav]},
			{"type": "method", "target": nav, "method": "set_owner", "args": [root]},
			{"type": "reference", "value": nav}
		]
		if want_bake:
			# P1 修复: bake 作为 do_method 入 undo 栈(commit 时执行, redo 重 bake),
			# 取代原 action 外单独 bake —— 避免 Ctrl+Z 撤 add_node 后 bake 残留、redo
			# 不重 bake 的游离态。undo 无清空 method, 但 nav 被 reference 保护且 redo
			# 总是 fresh bake, undo→redo 周期内 mesh 状态一致。
			# 注: bake_navigation_mesh 是 coroutine, commit_action 同步执行 do_method 时
			# 仅跑到首个 await 点（bake 未真正完成）—— C4 accurate 判据 deferred（见函数头注释）。
			do_ops.append({"type": "method", "target": nav, "method": "bake_navigation_mesh", "args": []})
		_undo_manager.create_action_mixed("Create Nav Region (req:%d)" % request_id, do_ops,
			[
				{"type": "method", "target": parent_node, "method": "remove_child", "args": [nav]}
			])
		# commit_action 已执行 do_methods(含 bake), 读结果
		bake_result = want_bake and nav.navigation_mesh != null
	else:
		parent_node.add_child(nav)
		nav.owner = root
		if want_bake:
			nav.bake_navigation_mesh()
			bake_result = nav.navigation_mesh != null

	return {"result": {"node_path": str(nav.get_path()), "type": "NavigationRegion3D", "baked": bake_result}}


# 2026-09-18 重复收敛:sync/async 两版 nav_create_region 共享的节点构建前奏。
# 返回 {"nav": nav, "parent": parent_node};失败返回 {"error": {...}}(code -32002/-32003)。
# root==null(-32003)与 parent 未找到(-32002)检查均在此,两 handler 直接透传 error。
func _create_nav_region(params: Dictionary, root: Node) -> Dictionary:
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}
	var node_name: String = params.get("name", "NavRegion")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}
	var nav = NavigationRegion3D.new()
	nav.name = node_name
	var pos = params.get("position")
	if pos != null and pos is Dictionary:
		nav.position = Vector3(float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0)))
	# P0-2: mesh 在入栈前初始化(附着 nav,随 reference 保护,undo/redo 不丢)
	var mesh = NavigationMesh.new()
	mesh.geometry_parsed_collision_mask = 0xFFFFFFFF
	nav.navigation_mesh = mesh
	return {"nav": nav, "parent": parent_node}

const BAKE_WAIT_TIMEOUT_MS := 28000  # < client 30s 超时；nav_create_region 用
const BAKE_MESH_WAIT_TIMEOUT_MS := 110000  # bake_mesh 长 timeout（== TS client timeoutMs:110000，EditorToolExecutor.ts:112；peer 异常断开时 orphan 由 §10 守卫兜底）

# nav_create_region async 版（A-lite coroutine handler）。spec §6 fallback 信号方案。
# Task 0 实测 is_baking/baking 属性不存在（BAKING_PROPS 空），改用 bake_finished 信号 +
# is_instance_valid 循环内守卫等 bake 完成；判据 navigation_mesh.get_vertices().size() > 0。
# bake 保留为 do_method 入 undo（保 P1 redo 重 bake）。
func handle_nav_create_region_async(params: Dictionary, request_id: int) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	var created = _create_nav_region(params, root)
	if created.has("error"):
		return created
	var nav = created.nav
	var parent_node = created.parent

	var want_bake: bool = params.get("bake", false)
	var bake_result: bool = false

	# bake_finished 信号先连接（避 commit/add_child 路径触发 bake 后丢信号）
	var _bake_state = {"done": false}
	var _cb: Callable  # want_bake=false 时保持默认空 Callable（类型系统隐式默认），不显式赋 Callable()
	if want_bake:
		_cb = func() -> void: _bake_state["done"] = true
		nav.bake_finished.connect(_cb)

	# do_ops / 同步 add_child 路径（与同步版一致，bake 作 do_method 入 undo 保 redo 重 bake）
	if _undo_manager != null:
		var do_ops: Array = [
			{"type": "method", "target": parent_node, "method": "add_child", "args": [nav]},
			{"type": "method", "target": nav, "method": "set_owner", "args": [root]},
			{"type": "reference", "value": nav}
		]
		if want_bake:
			do_ops.append({"type": "method", "target": nav, "method": "bake_navigation_mesh", "args": []})
		_undo_manager.create_action_mixed("Create Nav Region (req:%d)" % request_id, do_ops,
			[{"type": "method", "target": parent_node, "method": "remove_child", "args": [nav]}])
	else:
		parent_node.add_child(nav)
		nav.owner = root
		if want_bake:
			nav.bake_navigation_mesh()

	# §6 fallback: bake_finished 信号 + timer 竞速（替代 is_baking 轮询）
	if want_bake:
		var _deadline: int = Time.get_ticks_msec() + BAKE_WAIT_TIMEOUT_MS
		while not _bake_state["done"] and Time.get_ticks_msec() < _deadline:
			if not is_instance_valid(nav):
				# N1: freed 对象不碰信号（信号随对象释放自动断开），直接 return（对齐 headless navigation.ts:45）
				return {"error": {"code": -32003, "message": "NavigationRegion3D freed during bake"}}
			await get_tree().process_frame
		if is_instance_valid(nav) and nav.bake_finished.is_connected(_cb):
			nav.bake_finished.disconnect(_cb)  # one-shot 显式断开，避节点复用累积
		if not _bake_state["done"]:
			push_warning("[MCP] nav bake deadline exhausted (req:%d) — bake_result 退化乐观" % request_id)
		bake_result = is_instance_valid(nav) and nav.navigation_mesh != null and nav.navigation_mesh.get_vertices().size() > 0

	return {"result": {"node_path": str(nav.get_path()), "type": "NavigationRegion3D", "baked": bake_result}}

func handle_nav_bake_mesh(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is NavigationRegion3D):
		return {"error": {"code": -32004, "message": "Node is not a NavigationRegion3D: " + node_path}}

	node.bake_navigation_mesh()
	var success = node.navigation_mesh != null
	return {"result": {"node": node_path, "success": success, "status": "bake_completed" if success else "bake_failed"}}

# nav_bake_mesh async 版（A-lite coroutine handler）。spec §6 fallback 信号方案。
# 110s GD 兜底窗口 == TS client requestTimeoutMs（EditorToolExecutor.ts:112 传 timeoutMs:110000），
# client 不会先 reject（P3-2 核实：原 :165 注释'client 30s'过时，TS 早已对齐 110s）。
# 仅 peer 异常断开时 GD coroutine 完成于 orphan 态，§10 peer 守卫兜底丢 reply。
func handle_nav_bake_mesh_async(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is NavigationRegion3D):
		return {"error": {"code": -32004, "message": "Node is not a NavigationRegion3D: " + node_path}}

	var nav: NavigationRegion3D = node
	var _bake_state = {"done": false}
	var _cb: Callable = func() -> void: _bake_state["done"] = true
	nav.bake_finished.connect(_cb)
	nav.bake_navigation_mesh()

	# §6 fallback: bake_finished 信号 + timer 竞速（BAKE_MESH_WAIT_TIMEOUT_MS 量级）
	var _deadline: int = Time.get_ticks_msec() + BAKE_MESH_WAIT_TIMEOUT_MS
	while not _bake_state["done"] and Time.get_ticks_msec() < _deadline:
		if not is_instance_valid(nav):
			# N1: freed 对象不碰信号（信号随对象释放自动断开），直接 return（对齐 headless navigation.ts:45）
			return {"error": {"code": -32003, "message": "NavigationRegion3D freed during bake"}}
		await get_tree().process_frame
	if is_instance_valid(nav) and nav.bake_finished.is_connected(_cb):
		nav.bake_finished.disconnect(_cb)
	if not _bake_state["done"]:
		push_warning("[MCP] nav bake_mesh deadline exhausted — bake_result 退化乐观")
	# N1 补全：对齐 :144（create_region_async 末行）。循环内/freed 分支已守，但 deadline 耗尽退出后
	# nav 可能被并发 peer 删除（MAX_PEERS=5），末行属性访问须先 is_instance_valid 否则 SCRIPT ERROR。
	var success: bool = is_instance_valid(nav) and nav.navigation_mesh != null and nav.navigation_mesh.get_vertices().size() > 0
	# GD-R1 (2026-08-08): status 与 success 同源,消除 deadline 耗尽但 mesh 已生成时
	# success:true + status:"bake_timeout" 的矛盾语义。对齐 :162 success 派生逻辑
	# (失败分支 async 用 bake_timeout 区分 deadline 耗尽,sync 用 bake_failed 区分无 mesh)。
	return {"result": {"node": node_path, "success": success, "status": "bake_completed" if success else "bake_timeout"}}

func handle_nav_create_agent(params: Dictionary, request_id: int) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_name: String = params.get("name", "NavAgent")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var agent = NavigationAgent3D.new()
	agent.name = node_name

	var target_pos = params.get("target_position")
	if target_pos != null and target_pos is Dictionary:
		agent.target_position = Vector3(float(target_pos.get("x", 0.0)), float(target_pos.get("y", 0.0)), float(target_pos.get("z", 0.0)))

	agent.path_desired_distance = CommandHelpers.num_guarded(params.get("path_desired_distance"), 0.5)
	agent.target_desired_distance = CommandHelpers.num_guarded(params.get("target_desired_distance"), 1.0)
	agent.avoidance_enabled = params.get("avoidance_enabled", false)

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Create Nav Agent (req:%d)" % request_id,
			[
				{"type": "method", "target": parent_node, "method": "add_child", "args": [agent]},
				{"type": "method", "target": agent, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": agent}
			],
			[
				{"type": "method", "target": parent_node, "method": "remove_child", "args": [agent]}
			]
		)
	else:
		parent_node.add_child(agent)
		agent.owner = root

	return {"result": {"node_path": str(agent.get_path()), "type": "NavigationAgent3D"}}

func handle_nav_set_params(params: Dictionary) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = CommandHelpers.find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is NavigationAgent3D):
		return {"error": {"code": -32004, "message": "Node is not a NavigationAgent3D: " + node_path}}

	var raw_params = params.get("params", {})
	if raw_params == null or not (raw_params is Dictionary):
		return {"error": {"code": -32004, "message": "params must be a dictionary"}}

	var agent: NavigationAgent3D = node
	var do_ops: Array = []
	var undo_ops: Array = []
	var updated = []

	if raw_params.has("path_desired_distance"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "path_desired_distance", float(raw_params["path_desired_distance"]))
		updated.append("path_desired_distance")
	if raw_params.has("target_desired_distance"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "target_desired_distance", float(raw_params["target_desired_distance"]))
		updated.append("target_desired_distance")
	if raw_params.has("radius"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "radius", float(raw_params["radius"]))
		updated.append("radius")
	if raw_params.has("height"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "height", float(raw_params["height"]))
		updated.append("height")
	if raw_params.has("max_speed"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "max_speed", float(raw_params["max_speed"]))
		updated.append("max_speed")
	if raw_params.has("avoidance_enabled"):
		# P2-5: bool() 强转（对齐其他参数 float()/int()），NavigationAgent3D.avoidance_enabled 是 bool
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "avoidance_enabled", bool(raw_params["avoidance_enabled"]))
		updated.append("avoidance_enabled")
	if raw_params.has("neighbor_distance"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "neighbor_distance", float(raw_params["neighbor_distance"]))
		updated.append("neighbor_distance")
	if raw_params.has("max_neighbors"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "max_neighbors", int(raw_params["max_neighbors"]))
		updated.append("max_neighbors")
	if raw_params.has("time_horizon_agents"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "time_horizon_agents", float(raw_params["time_horizon_agents"]))
		updated.append("time_horizon_agents")
	if raw_params.has("time_horizon_obstacles"):
		CommandHelpers._record_prop(do_ops, undo_ops, agent, "time_horizon_obstacles", float(raw_params["time_horizon_obstacles"]))
		updated.append("time_horizon_obstacles")

	if do_ops.is_empty():
		return {"error": {"code": -32004, "message": "no valid nav params to set"}}

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Set NavAgent Params", do_ops, undo_ops)
	else:
		for op in do_ops:
			op["target"].set(op["property"], op["value"])
	return {"result": {"node": node_path, "updated": updated, "status": "params_set"}}

func handle_nav_create_link(params: Dictionary, request_id: int) -> Dictionary:
	var root = CommandHelpers.get_edited_scene_root(_plugin)
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_name: String = params.get("name", "NavLink")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var link = NavigationLink3D.new()
	link.name = node_name

	var start_pos = params.get("start_position")
	if start_pos != null and start_pos is Dictionary:
		link.start_position = Vector3(float(start_pos.get("x", 0.0)), float(start_pos.get("y", 0.0)), float(start_pos.get("z", 0.0)))

	var end_pos = params.get("end_position")
	if end_pos != null and end_pos is Dictionary:
		link.end_position = Vector3(float(end_pos.get("x", 0.0)), float(end_pos.get("y", 0.0)), float(end_pos.get("z", 0.0)))

	link.bidirectional = params.get("bidirectional", true)

	if _undo_manager != null:
		_undo_manager.create_action_mixed("Create Nav Link (req:%d)" % request_id,
			[
				{"type": "method", "target": parent_node, "method": "add_child", "args": [link]},
				{"type": "method", "target": link, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": link}
			],
			[
				{"type": "method", "target": parent_node, "method": "remove_child", "args": [link]}
			]
		)
	else:
		parent_node.add_child(link)
		link.owner = root

	return {"result": {"node_path": str(link.get_path()), "type": "NavigationLink3D", "bidirectional": link.bidirectional}}
