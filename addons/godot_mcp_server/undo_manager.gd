extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func create_action(request_id: int, do_methods: Array, undo_methods: Array) -> void:
	var undo_redo = _plugin.get_undo_redo()
	undo_redo.create_action("MCP: op_%d" % request_id)
	for m in do_methods:
		_add_method_call(undo_redo, "do", m)
	for m in undo_methods:
		_add_method_call(undo_redo, "undo", m)
	undo_redo.commit_action()


func _add_method(undo_redo: UndoRedo, mode: String, target: Object, method: String, args: Array) -> void:
	if mode == "do":
		match args.size():
			0: undo_redo.add_do_method(target, method)
			1: undo_redo.add_do_method(target, method, args[0])
			2: undo_redo.add_do_method(target, method, args[0], args[1])
			3: undo_redo.add_do_method(target, method, args[0], args[1], args[2])
			4: undo_redo.add_do_method(target, method, args[0], args[1], args[2], args[3])
			_:  undo_redo.add_do_method(Callable(target, method).bindv(args))
	else:
		match args.size():
			0: undo_redo.add_undo_method(target, method)
			1: undo_redo.add_undo_method(target, method, args[0])
			2: undo_redo.add_undo_method(target, method, args[0], args[1])
			3: undo_redo.add_undo_method(target, method, args[0], args[1], args[2])
			4: undo_redo.add_undo_method(target, method, args[0], args[1], args[2], args[3])
			_:  undo_redo.add_undo_method(Callable(target, method).bindv(args))


func _add_method_call(undo_redo: UndoRedo, mode: String, m: Dictionary) -> void:
	var args: Array = m.get("args", [])
	var target: Object = m.target
	var method: String = m.method
	_add_method(undo_redo, mode, target, method, args)
