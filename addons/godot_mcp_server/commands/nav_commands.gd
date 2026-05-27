extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func handle_nav_create_region(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_name: String = params.get("name", "NavRegion")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = _find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var nav = NavigationRegion3D.new()
	nav.name = node_name

	var pos = params.get("position")
	if pos != null:
		nav.position = Vector3(float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0)))

	parent_node.add_child(nav)
	nav.owner = root

	var mesh = NavigationMesh.new()
	mesh.geometry_parsed_collision_mask = 0xFFFFFFFF
	nav.navigation_mesh = mesh

	var bake_result: bool = false
	if params.get("bake", false):
		nav.bake_navigation_mesh()
		bake_result = nav.navigation_mesh != null

	return {"result": {"node_path": str(nav.get_path()), "type": "NavigationRegion3D", "baked": bake_result}}

func handle_nav_bake_mesh(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is NavigationRegion3D):
		return {"error": {"code": -32004, "message": "Node is not a NavigationRegion3D: " + node_path}}

	node.bake_navigation_mesh()
	var success = node.navigation_mesh != null
	return {"result": {"node": node_path, "success": success, "status": "bake_completed"}}

func handle_nav_create_agent(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_name: String = params.get("name", "NavAgent")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = _find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var agent = NavigationAgent3D.new()
	agent.name = node_name

	var target_pos = params.get("target_position")
	if target_pos != null:
		agent.target_position = Vector3(float(target_pos.get("x", 0.0)), float(target_pos.get("y", 0.0)), float(target_pos.get("z", 0.0)))

	agent.path_desired_distance = float(params.get("path_desired_distance", 0.5))
	agent.target_desired_distance = float(params.get("target_desired_distance", 1.0))
	agent.avoidance_enabled = params.get("avoidance_enabled", false)

	parent_node.add_child(agent)
	agent.owner = root

	return {"result": {"node_path": str(agent.get_path()), "type": "NavigationAgent3D"}}

func handle_nav_set_params(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is NavigationAgent3D):
		return {"error": {"code": -32004, "message": "Node is not a NavigationAgent3D: " + node_path}}

	var raw_params = params.get("params", {})
	if raw_params == null or not (raw_params is Dictionary):
		return {"error": {"code": -32004, "message": "params must be a dictionary"}}

	var agent: NavigationAgent3D = node
	var updated = []

	if raw_params.has("path_desired_distance"):
		agent.path_desired_distance = float(raw_params["path_desired_distance"])
		updated.append("path_desired_distance")
	if raw_params.has("target_desired_distance"):
		agent.target_desired_distance = float(raw_params["target_desired_distance"])
		updated.append("target_desired_distance")
	if raw_params.has("radius"):
		agent.radius = float(raw_params["radius"])
		updated.append("radius")
	if raw_params.has("height"):
		agent.height = float(raw_params["height"])
		updated.append("height")
	if raw_params.has("max_speed"):
		agent.max_speed = float(raw_params["max_speed"])
		updated.append("max_speed")
	if raw_params.has("avoidance_enabled"):
		agent.avoidance_enabled = raw_params["avoidance_enabled"]
		updated.append("avoidance_enabled")
	if raw_params.has("neighbor_distance"):
		agent.neighbor_distance = float(raw_params["neighbor_distance"])
		updated.append("neighbor_distance")
	if raw_params.has("max_neighbors"):
		agent.max_neighbors = int(raw_params["max_neighbors"])
		updated.append("max_neighbors")
	if raw_params.has("time_horizon_agents"):
		agent.time_horizon_agents = float(raw_params["time_horizon_agents"])
		updated.append("time_horizon_agents")
	if raw_params.has("time_horizon_obstacles"):
		agent.time_horizon_obstacles = float(raw_params["time_horizon_obstacles"])
		updated.append("time_horizon_obstacles")

	return {"result": {"node": node_path, "updated": updated, "status": "params_set"}}

func handle_nav_create_link(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_name: String = params.get("name", "NavLink")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = _find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var link = NavigationLink3D.new()
	link.name = node_name

	var start_pos = params.get("start_position")
	if start_pos != null:
		link.start_position = Vector3(float(start_pos.get("x", 0.0)), float(start_pos.get("y", 0.0)), float(start_pos.get("z", 0.0)))

	var end_pos = params.get("end_position")
	if end_pos != null:
		link.end_position = Vector3(float(end_pos.get("x", 0.0)), float(end_pos.get("y", 0.0)), float(end_pos.get("z", 0.0)))

	link.bidirectional = params.get("bidirectional", true)

	parent_node.add_child(link)
	link.owner = root

	return {"result": {"node_path": str(link.get_path()), "type": "NavigationLink3D", "bidirectional": link.bidirectional}}

func _get_edited_scene_root() -> Node:
	if _plugin != null:
		var ei = _plugin.get_editor_interface()
		if ei != null:
			var edited = ei.get_edited_scene_root()
			if edited != null:
				return edited
	var ml = Engine.get_main_loop()
	if ml == null or not (ml is SceneTree):
		return null
	var st = ml as SceneTree
	if st == null or st.root == null:
		return null
	if st.root.get_child_count() > 0:
		return st.root.get_child(0)
	return null

func _find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p = path
	while p.begins_with("/"):
		p = p.substr(1)
	if p.begins_with("root/"):
		p = p.substr(5)
	if p.begins_with(root.name + "/"):
		p = p.substr(root.name.length() + 1)
	elif p == root.name:
		return root
	if p == "":
		return root
	return root.get_node_or_null(p)
