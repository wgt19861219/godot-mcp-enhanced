@tool
extends EditorPlugin

var websocket_server: Node
var status_panel: Control

func _enter_tree() -> void:
	websocket_server = preload("websocket_server.gd").new()
	websocket_server.name = "MCPServer"
	websocket_server.setup(self)
	add_child(websocket_server)

	var panel_scene = preload("ui/status_panel.tscn")
	status_panel = panel_scene.instantiate()
	add_control_to_bottom_panel(status_panel, "MCP")
	websocket_server.set_panel(status_panel)

func _exit_tree() -> void:
	if websocket_server:
		websocket_server.set_process(false)
		var handler = websocket_server.get_node_or_null("command_handler")
		if handler and handler.has_method("cleanup"):
			handler.cleanup()
		websocket_server.queue_free()
		websocket_server = null
	if status_panel:
		remove_control_from_bottom_panel(status_panel)
		status_panel.queue_free()
		status_panel = null

func get_plugin() -> EditorPlugin:
	return self
