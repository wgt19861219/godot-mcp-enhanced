extends Node

var _scene_commands: Node
var _node_commands: Node
var _test_commands: Node
var _export_commands: Node
var _undo_manager: Node

func setup(plugin: EditorPlugin) -> void:
	_undo_manager = preload("undo_manager.gd").new()
	_undo_manager.setup(plugin)
	add_child(_undo_manager)

	_scene_commands = preload("commands/scene_commands.gd").new()
	add_child(_scene_commands)

	_node_commands = preload("commands/node_commands.gd").new()
	_node_commands.setup(_undo_manager)
	add_child(_node_commands)

	_test_commands = preload("commands/test_commands.gd").new()
	add_child(_test_commands)

	_export_commands = preload("commands/export_commands.gd").new()
	_export_commands.setup(plugin)
	add_child(_export_commands)

func handle(method: String, params: Dictionary, request_id: int) -> Dictionary:
	match method:
		"open_scene":
			return _scene_commands.handle_open_scene(params)
		"save_scene":
			return _scene_commands.handle_save_scene(params)
		"add_node":
			return _node_commands.handle_add_node(params, request_id)
		"test_assert":
			return _test_commands.handle_test_assert(params)
		"export_list_presets":
			return _export_commands.handle_export_list_presets(params)
		"export_get_preset":
			return _export_commands.handle_export_get_preset(params)
		"export_build":
			return _export_commands.handle_export_build(params)
		_:
			return {"error": {"code": -32601, "message": "Unknown method: %s" % method}}
