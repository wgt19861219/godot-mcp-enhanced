extends SceneTree

var _issues = []

func _probe(i: int, code: String, msg: String):
	_issues.append({"op_index": i, "code": code, "message": msg})

func _initialize():
	var scene = load("res://test_main.tscn")
	if scene == null:
		_probe(-1, "SCENE_LOAD_FAILED", "Failed to load scene: res://test_main.tscn")
		print("VALIDATE_RESULT: " + JSON.stringify({"ok": false, "issues": _issues}))
		quit()
		return
	var inst = scene.instantiate()
	# --- probe 0: tile_set node ---
	var _0n = inst.get_node_or_null("Grid")
	if _0n == null:
		_probe(0, "NODE_NOT_FOUND", "op=tile_set: node not found: Grid")
	elif not (_0n is TileMap or _0n is TileMapLayer):
		_probe(0, "NODE_TYPE_MISMATCH", "op=tile_set: node is " + str(_0n.get_class()) + ", expected TileMap/TileMapLayer")
	# --- probe 1: tileset_physics_layer_set tileset ---
	if not ResourceLoader.exists("res://fixtures/tileset.tres"):
		_probe(1, "TILESET_NOT_FOUND", "op=tileset_physics_layer_set: tileset resource not found: res://fixtures/tileset.tres")
	else:
		var _1ts = load("res://fixtures/tileset.tres")
		if _1ts == null:
			_probe(1, "TILESET_LOAD_FAILED", "op=tileset_physics_layer_set: tileset failed to load: res://fixtures/tileset.tres")
		else:
			if _1ts.get_physics_layers_count() <= 5:
				_probe(1, "LAYER_OUT_OF_RANGE", "op=tileset_physics_layer_set: physics layer 5 >= count " + str(_1ts.get_physics_layers_count()))
	# --- probe 2: tileset_custom_data_layer_add tileset ---
	if not ResourceLoader.exists("res://fixtures/tileset.tres"):
		_probe(2, "TILESET_NOT_FOUND", "op=tileset_custom_data_layer_add: tileset resource not found: res://fixtures/tileset.tres")
	else:
		var _2ts = load("res://fixtures/tileset.tres")
		if _2ts == null:
			_probe(2, "TILESET_LOAD_FAILED", "op=tileset_custom_data_layer_add: tileset failed to load: res://fixtures/tileset.tres")
	# --- probe 3: node_add parent ---
	var _3p = inst.get_node_or_null("Sub")
	if _3p == null:
		_probe(3, "PARENT_NOT_FOUND", "op=node_add: parent not found: Sub")
	# --- probe 4: node_property path ---
	var _4t = inst.get_node_or_null("Marker")
	if _4t == null:
		_probe(4, "NODE_NOT_FOUND", "op=node_property: node not found: Marker")
	# --- probe 5: node_add (no probeable preconditions) ---
	print("VALIDATE_RESULT: " + JSON.stringify({"ok": _issues.is_empty(), "issues": _issues}))
	quit()
