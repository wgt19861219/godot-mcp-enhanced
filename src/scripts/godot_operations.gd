#!/usr/bin/env -S godot --headless --script
extends SceneTree

var debug_mode = false

func _init():
	var args = OS.get_cmdline_args()
	debug_mode = "--debug-godot" in args

	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		quit(1)

	var operation_index = script_index + 2
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		quit(1)

	log_debug("All arguments: " + str(args))
	var operation = args[operation_index]
	var params_json = args[params_index]

	log_info("Operation: " + operation)
	log_debug("Params JSON: " + params_json)

	var json = JSON.new()
	var error = json.parse(params_json)
	var params = null

	if error == OK:
		params = json.get_data()
	else:
		log_error("Failed to parse JSON parameters: " + params_json)
		log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
		quit(1)

	if not params:
		log_error("Failed to parse JSON parameters: " + params_json)
		quit(1)

	log_info("Executing operation: " + operation)

	match operation:
		"create_scene":
			create_scene(params)
		"add_node":
			add_node(params)
		"batch_add_nodes":
			batch_add_nodes(params)
		"load_sprite":
			load_sprite(params)
		"export_mesh_library":
			export_mesh_library(params)
		"save_scene":
			save_scene(params)
		"get_uid":
			get_uid(params)
		"resave_resources":
			resave_resources(params)
		_:
			log_error("Unknown operation: " + operation)
			quit(1)

	quit()

# ─── Logging helpers ──────────────────────────────────────────────────────────

func log_debug(message: String) -> void:
	if debug_mode:
		print("[DEBUG] " + message)

func log_info(message: String) -> void:
	print("[INFO] " + message)

func log_error(message: String) -> void:
	printerr("[ERROR] " + message)

# ─── Class helpers ────────────────────────────────────────────────────────────

func get_script_by_name(name_of_class: String):
	if ResourceLoader.exists(name_of_class, "Script"):
		var script = load(name_of_class) as Script
		if script:
			return script
		log_error("Failed to load script from path: " + name_of_class)
		return null

	var global_classes = ProjectSettings.get_global_class_list()
	for global_class in global_classes:
		if global_class["class"] == name_of_class:
			var script = load(global_class["path"]) as Script
			if script:
				return script
			log_error("Failed to load script from registry path: " + global_class["path"])
			return null

	log_error("Could not find script for class: " + name_of_class)
	return null

func instantiate_class(name_of_class: String):
	if name_of_class.is_empty():
		log_error("Cannot instantiate class: name is empty")
		return null

	if ClassDB.class_exists(name_of_class):
		if ClassDB.can_instantiate(name_of_class):
			var result = ClassDB.instantiate(name_of_class)
			if result == null:
				log_error("ClassDB.instantiate() returned null for class: " + name_of_class)
			return result
		log_error("Class exists but cannot be instantiated: " + name_of_class)
		return null

	var script = get_script_by_name(name_of_class)
	if script is GDScript:
		return script.new()

	log_error("Failed to get script for class: " + name_of_class)
	return null

# ─── Scene operations ─────────────────────────────────────────────────────────

func create_scene(params):
	log_info("Creating scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
	var scene_dir_res = full_scene_path.get_base_dir()
	var scene_dir_abs = absolute_scene_path.get_base_dir()

	log_debug("Scene path: " + full_scene_path)
	log_debug("Absolute path: " + absolute_scene_path)

	var root_node_type = "Node2D"
	if params.has("root_node_type"):
		root_node_type = params.root_node_type

	var scene_root = instantiate_class(root_node_type)
	if not scene_root:
		log_error("Failed to instantiate node of type: " + root_node_type)
		quit(1)

	scene_root.name = "root"
	scene_root.owner = scene_root

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result != OK:
		log_error("Failed to pack scene: " + str(result))
		quit(1)

	# Ensure directory exists
	var scene_dir_relative = scene_dir_res.substr(6)
	if not scene_dir_relative.is_empty():
		var dir = DirAccess.open("res://")
		if dir == null:
			var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
			if make_dir_error != OK:
				log_error("Failed to create directory: " + scene_dir_abs)
				quit(1)
		else:
			if not dir.dir_exists(scene_dir_relative):
				var make_dir_error = dir.make_dir_recursive(scene_dir_relative)
				if make_dir_error != OK:
					log_error("Failed to create directory: " + scene_dir_relative + ", error: " + str(make_dir_error))
					quit(1)

	var save_error = ResourceSaver.save(packed_scene, full_scene_path)
	if save_error == OK:
		print("Scene created successfully at: " + params.scene_path)
	else:
		log_error("Failed to save scene. Error: " + str(save_error))
		quit(1)


func add_node(params):
	log_info("Adding node to scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)

	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		quit(1)

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		quit(1)

	var scene_root = scene.instantiate()

	var parent_path = "root"
	if params.has("parent_node_path"):
		parent_path = params.parent_node_path

	var parent = scene_root
	if parent_path != "root":
		parent = scene_root.get_node(parent_path.replace("root/", ""))
		if not parent:
			log_error("Parent node not found: " + parent_path)
			quit(1)

	var new_node = instantiate_class(params.node_type)
	if not new_node:
		log_error("Failed to instantiate node of type: " + params.node_type)
		quit(1)
	new_node.name = params.node_name

	if params.has("properties"):
		var properties = params.properties
		for property in properties:
			new_node.set(property, properties[property])

	parent.add_child(new_node)
	new_node.owner = scene_root

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var save_error = ResourceSaver.save(packed_scene, absolute_scene_path)
		if save_error == OK:
			print("Node '%s' of type '%s' added successfully" % [params.node_name, params.node_type])
		else:
			log_error("Failed to save scene: " + str(save_error))
	else:
		log_error("Failed to pack scene: " + str(result))


func batch_add_nodes(params):
	log_info("Batch adding nodes to scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)

	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		quit(1)

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var nodes = params.nodes
	var added_count = 0
	var failed_count = 0

	for node_def in nodes:
		var parent_path = "root"
		if node_def.has("parent_node_path"):
			parent_path = node_def.parent_node_path

		var parent = scene_root
		if parent_path != "root":
			parent = scene_root.get_node(parent_path.replace("root/", ""))
			if not parent:
				log_error("Parent node not found: " + parent_path + " for node: " + node_def.node_name)
				failed_count += 1
				continue

		var new_node = instantiate_class(node_def.node_type)
		if not new_node:
			log_error("Failed to instantiate: " + node_def.node_type)
			failed_count += 1
			continue

		new_node.name = node_def.node_name

		if node_def.has("properties"):
			var properties = node_def.properties
			for property in properties:
				new_node.set(property, properties[property])

		parent.add_child(new_node)
		new_node.owner = scene_root
		added_count += 1

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var save_error = ResourceSaver.save(packed_scene, absolute_scene_path)
		if save_error == OK:
			print("Batch add completed: %d/%d nodes added to %s" % [added_count, nodes.size(), params.scene_path])
			if failed_count > 0:
				log_error("Failed to add %d nodes" % failed_count)
		else:
			log_error("Failed to save scene: " + str(save_error))
	else:
		log_error("Failed to pack scene: " + str(result))


func load_sprite(params):
	log_info("Loading sprite into scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		quit(1)

	var full_texture_path = params.texture_path
	if not full_texture_path.begins_with("res://"):
		full_texture_path = "res://" + full_texture_path

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		quit(1)

	var scene_root = scene.instantiate()

	var node_path = params.node_path
	if node_path.begins_with("root/"):
		node_path = node_path.substr(5)

	var sprite_node = null
	if node_path == "":
		sprite_node = scene_root
	else:
		sprite_node = scene_root.get_node(node_path)

	if not sprite_node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
		log_error("Node is not a sprite-compatible type: " + sprite_node.get_class())
		quit(1)

	var texture = load(full_texture_path)
	if not texture:
		log_error("Failed to load texture: " + full_texture_path)
		quit(1)

	if sprite_node is Sprite2D or sprite_node is Sprite3D:
		sprite_node.texture = texture
	elif sprite_node is TextureRect:
		sprite_node.texture = texture

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var error = ResourceSaver.save(packed_scene, full_scene_path)
		if error == OK:
			print("Sprite loaded successfully with texture: " + full_texture_path)
		else:
			log_error("Failed to save scene: " + str(error))
	else:
		log_error("Failed to pack scene: " + str(result))


func export_mesh_library(params):
	log_info("Exporting MeshLibrary from scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	var full_output_path = params.output_path
	if not full_output_path.begins_with("res://"):
		full_output_path = "res://" + full_output_path

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		quit(1)

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var mesh_library = MeshLibrary.new()

	var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
	var use_specific_items = mesh_item_names.size() > 0
	var item_id = 0

	for child in scene_root.get_children():
		if use_specific_items and not (child.name in mesh_item_names):
			continue

		var mesh_instance = null
		if child is MeshInstance3D:
			mesh_instance = child
		else:
			for descendant in child.get_children():
				if descendant is MeshInstance3D:
					mesh_instance = descendant
					break

		if mesh_instance and mesh_instance.mesh:
			mesh_library.create_item(item_id)
			mesh_library.set_item_name(item_id, child.name)
			mesh_library.set_item_mesh(item_id, mesh_instance.mesh)

			for collision_child in child.get_children():
				if collision_child is CollisionShape3D and collision_child.shape:
					mesh_library.set_item_shapes(item_id, [collision_child.shape])
					break

			if mesh_instance.mesh:
				mesh_library.set_item_preview(item_id, mesh_instance.mesh)

			item_id += 1

	# Create directory if needed
	var dir = DirAccess.open("res://")
	if dir == null:
		log_error("Failed to open res:// directory")
		quit(1)

	var output_dir = full_output_path.get_base_dir()
	if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):
		var error = dir.make_dir_recursive(output_dir.substr(6))
		if error != OK:
			log_error("Failed to create directory: " + output_dir + ", error: " + str(error))
			quit(1)

	if item_id > 0:
		var error = ResourceSaver.save(mesh_library, full_output_path)
		if error == OK:
			print("MeshLibrary exported successfully with %d items to: %s" % [item_id, full_output_path])
		else:
			log_error("Failed to save MeshLibrary: " + str(error))
	else:
		log_error("No valid meshes found in the scene")


func save_scene(params):
	log_info("Saving scene: " + params.scene_path)

	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		quit(1)

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		quit(1)

	var scene_root = scene.instantiate()

	var save_path = params.new_path if params.has("new_path") else full_scene_path
	if params.has("new_path") and not save_path.begins_with("res://"):
		save_path = "res://" + save_path

	# Create directory if needed
	if params.has("new_path"):
		var dir = DirAccess.open("res://")
		if dir == null:
			log_error("Failed to open res:// directory")
			quit(1)

		var scene_dir = save_path.get_base_dir()
		if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):
			var error = dir.make_dir_recursive(scene_dir.substr(6))
			if error != OK:
				log_error("Failed to create directory: " + scene_dir + ", error: " + str(error))
				quit(1)

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var error = ResourceSaver.save(packed_scene, save_path)
		if error == OK:
			print("Scene saved successfully to: " + save_path)
		else:
			log_error("Failed to save scene: " + str(error))
	else:
		log_error("Failed to pack scene: " + str(result))


# ─── File helpers ─────────────────────────────────────────────────────────────

func find_files(path: String, extension: String) -> Array:
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension))
			elif file_name.ends_with(extension):
				files.append(path + file_name)
			file_name = dir.get_next()

	return files


func get_uid(params):
	if not params.has("file_path"):
		log_error("File path is required")
		quit(1)

	var file_path = params.file_path
	if not file_path.begins_with("res://"):
		file_path = "res://" + file_path

	log_info("Getting UID for file: " + file_path)

	var absolute_path = ProjectSettings.globalize_path(file_path)

	if not FileAccess.file_exists(file_path):
		log_error("File does not exist: " + file_path)
		quit(1)

	var uid_path = file_path + ".uid"
	var f = FileAccess.open(uid_path, FileAccess.READ)

	if f:
		var uid_content = f.get_as_text()
		f.close()
		var result = {
			"file": file_path,
			"absolutePath": absolute_path,
			"uid": uid_content.strip_edges(),
			"exists": true
		}
		print(JSON.stringify(result))
	else:
		var result = {
			"file": file_path,
			"absolutePath": absolute_path,
			"exists": false,
			"message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
		}
		print(JSON.stringify(result))


func resave_resources(params):
	log_info("Resaving all resources to update UID references...")

	var project_path = "res://"
	if params.has("project_path"):
		project_path = params.project_path
		if not project_path.begins_with("res://"):
			project_path = "res://" + project_path
		if not project_path.ends_with("/"):
			project_path += "/"

	var scenes = find_files(project_path, ".tscn")
	var success_count = 0
	var error_count = 0

	for scene_path in scenes:
		var scene = load(scene_path)
		if scene:
			var error = ResourceSaver.save(scene, scene_path)
			if error == OK:
				success_count += 1
			else:
				error_count += 1
				log_error("Failed to save: " + scene_path + ", error: " + str(error))
		else:
			error_count += 1
			log_error("Failed to load: " + scene_path)

	# Process scripts/shaders
	var scripts = find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
	var missing_uids = 0
	var generated_uids = 0

	for script_path in scripts:
		var uid_path = script_path + ".uid"
		var f = FileAccess.open(uid_path, FileAccess.READ)
		if not f:
			missing_uids += 1
			var res = load(script_path)
			if res:
				var error = ResourceSaver.save(res, script_path)
				if error == OK:
					generated_uids += 1
				else:
					log_error("Failed to generate UID for: " + script_path)
			else:
				log_error("Failed to load resource: " + script_path)

	print("Resave complete: %d scenes saved, %d errors, %d UIDs generated" % [success_count, error_count, generated_uids])
