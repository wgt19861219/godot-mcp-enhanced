extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func handle_particles_create(params: Dictionary, request_id: int) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_type: String = params.get("node_type", "GPUParticles3D")
	if node_type != "GPUParticles2D" and node_type != "GPUParticles3D":
		return {"error": {"code": -32004, "message": "Invalid node_type: " + node_type}}

	var node_name: String = params.get("name", "Particles")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = _find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}

	var cls = ClassDB.instantiate(node_type)
	if cls == null:
		return {"error": {"code": -32000, "message": "Cannot instantiate: " + node_type}}
	cls.name = node_name

	var pos = params.get("position")
	if pos != null:
		if node_type == "GPUParticles3D":
			cls.position = Vector3(float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0)))
		else:
			cls.position = Vector2(float(pos.get("x", 0.0)), float(pos.get("y", 0.0)))

	parent_node.add_child(cls)
	cls.owner = root

	return {"result": {"node_path": str(cls.get_path()), "type": node_type, "status": "created"}}

func handle_particles_set_emission(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is GPUParticles2D or node is GPUParticles3D):
		return {"error": {"code": -32004, "message": "Node is not a GPUParticles type: " + node.get_class()}}

	var mat = node.process_material
	var amount = params.get("amount")
	if amount != null:
		node.amount = int(amount)

	var emission_shape: String = params.get("emission_shape", "")
	if emission_shape != "":
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.process_material = mat
		var shape_map = {
			"point": ParticleProcessMaterial.EMISSION_SHAPE_POINT,
			"sphere": ParticleProcessMaterial.EMISSION_SHAPE_SPHERE,
			"box": ParticleProcessMaterial.EMISSION_SHAPE_BOX,
			"ring": ParticleProcessMaterial.EMISSION_SHAPE_RING,
		}
		if shape_map.has(emission_shape):
			mat.emission_shape = shape_map[emission_shape]
		else:
			return {"error": {"code": -32004, "message": "Invalid emission_shape: " + emission_shape + ". Supported: point, sphere, box, ring"}}
		var radius = params.get("emission_sphere_radius")
		if radius != null:
			mat.emission_sphere_radius = float(radius)
		var extents = params.get("emission_box_extents")
		if extents != null:
			mat.emission_box_extents = Vector3(float(extents.get("x", 1.0)), float(extents.get("y", 1.0)), float(extents.get("z", 1.0)))

	var direction = params.get("direction")
	if direction != null:
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.process_material = mat
		mat.direction = Vector3(float(direction.get("x", 0.0)), float(direction.get("y", -1.0)), float(direction.get("z", 0.0)))

	var spread = params.get("spread")
	if spread != null:
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.process_material = mat
		mat.spread = float(spread)

	return {"result": {"node": node_path, "status": "emission_set"}}

func handle_particles_set_process(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is GPUParticles2D or node is GPUParticles3D):
		return {"error": {"code": -32004, "message": "Node is not a GPUParticles type: " + node.get_class()}}

	var mat = node.process_material
	var gravity = params.get("gravity")
	if gravity != null:
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.process_material = mat
		mat.gravity = Vector3(float(gravity.get("x", 0.0)), float(gravity.get("y", -9.8)), float(gravity.get("z", 0.0)))

	var speed_scale = params.get("speed_scale")
	if speed_scale != null:
		node.speed_scale = float(speed_scale)

	var explosiveness = params.get("explosiveness")
	if explosiveness != null:
		node.explosiveness = float(explosiveness)

	var randomness = params.get("randomness")
	if randomness != null:
		node.randomness = float(randomness)

	var lifetime = params.get("lifetime")
	if lifetime != null:
		node.lifetime = float(lifetime)

	var damping = params.get("damping")
	if damping != null:
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.process_material = mat
		mat.damping = float(damping)

	return {"result": {"node": node_path, "status": "process_set"}}

func handle_particles_load_preset(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is GPUParticles2D or node is GPUParticles3D):
		return {"error": {"code": -32004, "message": "Node is not a GPUParticles type: " + node.get_class()}}

	var preset: String = params.get("preset", "")
	var presets = {
		"fire": {"amount": 40, "lifetime": 1.5, "gravity": Vector3(0, -5, 0), "spread": 30.0, "explosiveness": 0.3, "damping": 2.0},
		"smoke": {"amount": 20, "lifetime": 3.0, "gravity": Vector3(0, -1, 0), "spread": 10.0, "explosiveness": 0.1, "damping": 3.0},
		"rain": {"amount": 200, "lifetime": 1.0, "gravity": Vector3(0, -20, 0), "spread": 5.0, "direction": Vector3(0, -1, 0)},
		"snow": {"amount": 60, "lifetime": 4.0, "gravity": Vector3(0, -2, 0), "spread": 180.0, "randomness": 0.8},
		"sparkle": {"amount": 30, "lifetime": 0.5, "gravity": Vector3(0, 0, 0), "spread": 180.0, "explosiveness": 0.8},
		"explosion": {"amount": 80, "lifetime": 1.0, "gravity": Vector3(0, -3, 0), "spread": 180.0, "explosiveness": 1.0, "one_shot": true},
	}
	if not presets.has(preset):
		return {"error": {"code": -32004, "message": "Unknown preset: " + preset + ". Available: fire, smoke, rain, snow, sparkle, explosion"}}

	var cfg = presets[preset]
	node.amount = cfg.get("amount", 10)
	node.lifetime = cfg.get("lifetime", 1.0)
	node.explosiveness = cfg.get("explosiveness", 0.0)
	node.randomness = cfg.get("randomness", 0.0)
	if cfg.has("one_shot") and cfg["one_shot"]:
		node.one_shot = true

	var mat = node.process_material
	if mat == null:
		mat = ParticleProcessMaterial.new()
		node.process_material = mat
	if cfg.has("gravity"):
		mat.gravity = cfg["gravity"]
	if cfg.has("spread"):
		mat.spread = cfg["spread"]
	if cfg.has("damping"):
		mat.damping = cfg["damping"]
	if cfg.has("direction"):
		mat.direction = cfg["direction"]

	return {"result": {"node": node_path, "preset": preset, "status": "preset_loaded"}}

func handle_particles_set_material(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var node = _find_node(root, node_path)
	if node == null:
		return {"error": {"code": -32002, "message": "Node not found: " + node_path}}
	if not (node is GPUParticles2D or node is GPUParticles3D):
		return {"error": {"code": -32004, "message": "Node is not a GPUParticles type: " + node.get_class()}}

	var mat = ParticleProcessMaterial.new()
	node.process_material = mat

	return {"result": {"node": node_path, "material_type": "ParticleProcessMaterial", "status": "material_set"}}

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
