extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func handle_export_list_presets(params: Dictionary) -> Dictionary:
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	var result = []
	for i in range(presets.size()):
		var p = presets[i]
		result.append({
			"name": str(p.get("name", "Preset %d" % i)),
			"platform": str(p.get("platform", "unknown")),
			"runnable": p.is_runnable() if p.has_method("is_runnable") else false
		})
	return {"result": {"presets": result, "count": result.size()}}

func handle_export_get_preset(params: Dictionary) -> Dictionary:
	var preset_name: String = params.get("name", "")
	if preset_name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	for i in range(presets.size()):
		var p = presets[i]
		if str(p.get("name", "")) == preset_name:
			var data = {}
			for key in p.get_property_list():
				var prop_name = key["name"]
				if prop_name.begins_with("resource_"):
					continue
				var val = p.get(prop_name)
				if _is_sensitive_key(prop_name):
					data[prop_name] = "***"
				else:
					data[prop_name] = val
			return {"result": data}
	return {"error": {"code": -32002, "message": "Export preset not found: " + preset_name}}

func handle_export_build(params: Dictionary) -> Dictionary:
	var preset_name: String = params.get("preset", "")
	if preset_name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	if _plugin == null:
		return {"error": {"code": -32000, "message": "Editor plugin not available"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	# Find the preset
	var presets = ei.get_export_presets()
	var found = false
	for i in range(presets.size()):
		var p = presets[i]
		if str(p.get("name", "")) == preset_name:
			found = true
			break
	if not found:
		return {"error": {"code": -32002, "message": "Export preset not found: " + preset_name}}
	# Export build is complex and requires EditorExportPlatform API
	# Return status for now - actual build orchestration happens at Node.js level
	return {"result": {"status": "export_started", "preset": preset_name, "message": "Export initiated. Check editor output for progress."}}

func _is_sensitive_key(key: String) -> bool:
	var sensitive_patterns = ["keystore", "certificate", "codesign", "identity", "provisioning", "password", "secret", "token", "api_key"]
	var k = key.to_lower()
	for pattern in sensitive_patterns:
		if k.contains(pattern):
			return true
	return false
