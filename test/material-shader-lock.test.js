// 批2 重构护栏:四个 shader 生成函数输出基线。
import { describe, it, expect } from 'vitest';
import {
  genShaderReadScript, genShaderWriteScript, genShaderLoadFileScript, genShaderApplyTemplateScript,
} from '../src/tools/material-ops.js';

describe('shader 生成脚本快照锁定', () => {
  it('shader_read', () => {
    expect(genShaderReadScript('/root/M/Sprite', 0)).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var node = _mcp_get_node("/root/M/Sprite")
      	if node == null:
      		_mcp_output("error", "Node not found: /root/M/Sprite")
      		_mcp_done()
      		return
      	var mat = node.get("material")
      	if mat == null and node.has_method("get_surface_override_material"):
      		mat = node.get_surface_override_material(0)
      	if mat == null:
      		var _mesh = node.get("mesh")
      		if _mesh != null and _mesh.has_method("surface_get_material"):
      			mat = _mesh.surface_get_material(0)
      	if mat == null:
      		_mcp_output("error", "No material on node")
      		_mcp_done()
      		return
      	if not mat is ShaderMaterial:
      		_mcp_output("error", "Not a ShaderMaterial")
      		_mcp_done()
      		return
      	if mat.shader == null:
      		_mcp_output("error", "No shader assigned")
      		_mcp_done()
      		return
      	_mcp_output("shader_code", mat.shader.code)
      	_mcp_done()
      "
    `);
  });
  it('shader_write', () => {
    expect(genShaderWriteScript('/root/M/Sprite', 0, 'shader_type canvas_item;\nvoid fragment() {}')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var node = _mcp_get_node("/root/M/Sprite")
      	if node == null:
      		_mcp_output("error", "Node not found: /root/M/Sprite")
      		_mcp_done()
      		return
      	var mat = node.get("material")
      	if mat == null and node.has_method("get_surface_override_material"):
      		mat = node.get_surface_override_material(0)
      	if mat == null:
      		var _mesh = node.get("mesh")
      		if _mesh != null and _mesh.has_method("surface_get_material"):
      			mat = _mesh.surface_get_material(0)
      	if mat == null:
      		_mcp_output("error", "No material on node")
      		_mcp_done()
      		return
      	if not mat is ShaderMaterial:
      		_mcp_output("error", "Not a ShaderMaterial")
      		_mcp_done()
      		return
      	mat.shader = mat.shader.duplicate()
      	var _code_json: String = "\\"shader_type canvas_item;\\\\nvoid fragment() {}\\""
      	var _parsed: Variant = JSON.parse_string(_code_json)
      	if _parsed == null:
      		_mcp_output("error", "Failed to parse shader code JSON")
      		_mcp_done()
      		return
      	mat.shader.code = _parsed
      	await process_frame
      	# C-BUG-1: get_rid().is_valid() 仅确认 shader 资源已分配,与代码能否编译无关。
      	# Godot 4.x headless 无可靠 shader 编译验证 API(RenderingServer 不实际编译)。
      	# compile_success 不可作为"编译通过"依据,必须经截图/Godot 错误输出人工确认。
      	var compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
      	var errors = []
      	var warnings = []
      	if not compile_ok:
      		errors.append({"line": 0, "message": "Shader resource allocation failed"})
      	_mcp_output("compile_result", {"compile_success": compile_ok, "errors": errors, "warnings": warnings, "verification_note": "compile_success only confirms shader resource allocation, NOT that the code compiles. Godot 4.x headless cannot verify shader compilation — always verify via screenshot or Godot error output."})
      	_mcp_done()
      "
    `);
  });
  it('shader_load_file', () => {
    expect(genShaderLoadFileScript('/root/M/Sprite', 0, 'res://shaders/a.gdshader')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var node = _mcp_get_node("/root/M/Sprite")
      	if node == null:
      		_mcp_output("error", "Node not found: /root/M/Sprite")
      		_mcp_done()
      		return
      	var mat = node.get("material")
      	if mat == null and node.has_method("get_surface_override_material"):
      		mat = node.get_surface_override_material(0)
      	if mat == null:
      		var _mesh = node.get("mesh")
      		if _mesh != null and _mesh.has_method("surface_get_material"):
      			mat = _mesh.surface_get_material(0)
      	if mat == null:
      		_mcp_output("error", "No material on node")
      		_mcp_done()
      		return
      	if not mat is ShaderMaterial:
      		_mcp_output("error", "Not a ShaderMaterial")
      		_mcp_done()
      		return
      	if not ResourceLoader.exists("res://shaders/a.gdshader"):
      		_mcp_output("error", "Shader file not found: res://shaders/a.gdshader")
      		_mcp_done()
      		return
      	mat.shader = load("res://shaders/a.gdshader")
      	_mcp_output("shader_loaded", {"shader_path": "res://shaders/a.gdshader"})
      	_mcp_done()
      "
    `);
  });
  it('shader_apply_template', () => {
    expect(genShaderApplyTemplateScript('/root/M/Sprite', 0, 'dissolve')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var node = _mcp_get_node("/root/M/Sprite")
      	if node == null:
      		_mcp_output("error", "Node not found: /root/M/Sprite")
      		_mcp_done()
      		return
      	var mat = node.get("material")
      	if mat == null and node.has_method("get_surface_override_material"):
      		mat = node.get_surface_override_material(0)
      	if mat == null:
      		var _mesh = node.get("mesh")
      		if _mesh != null and _mesh.has_method("surface_get_material"):
      			mat = _mesh.surface_get_material(0)
      	if mat == null:
      		_mcp_output("error", "No material on node")
      		_mcp_done()
      		return
      	if not mat is ShaderMaterial:
      		_mcp_output("error", "Not a ShaderMaterial")
      		_mcp_done()
      		return
      	mat.shader = mat.shader.duplicate()
      	var _code_json: String = "\\"shader_type canvas_item;\\\\n\\\\nuniform vec4 edge_color : source_color = vec4(1.0, 0.3, 0.0, 1.0);\\\\nuniform float edge_width : hint_range(0.0, 0.5) = 0.1;\\\\nuniform float progress : hint_range(0.0, 1.0) = 0.0;\\\\n\\\\nvoid fragment() {\\\\n  vec4 color = texture(TEXTURE, UV);\\\\n  float threshold = progress;\\\\n  float edge = smoothstep(threshold - edge_width, threshold, UV.x);\\\\n  float dissolve = step(threshold, UV.x);\\\\n  if (dissolve < 0.01) discard;\\\\n  vec3 final_color = mix(edge_color.rgb, color.rgb, edge);\\\\n  COLOR = vec4(final_color, color.a * dissolve);\\\\n}\\""
      	var _parsed: Variant = JSON.parse_string(_code_json)
      	if _parsed == null:
      		_mcp_output("error", "Failed to parse shader code JSON")
      		_mcp_done()
      		return
      	mat.shader.code = _parsed
      	await process_frame
      	# C-BUG-1: get_rid().is_valid() 仅确认 shader 资源已分配,与代码能否编译无关。
      	# Godot 4.x headless 无可靠 shader 编译验证 API。compile_success 不可作为编译通过依据。
      	var compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
      	var errors = []
      	var warnings = []
      	if not compile_ok:
      		errors.append({"line": 0, "message": "Shader resource allocation failed"})
      	_mcp_output("template_applied", {"template": "dissolve", "compile_success": compile_ok, "errors": errors, "warnings": warnings, "verification_note": "compile_success only confirms shader resource allocation, NOT that the code compiles. Verify via screenshot or Godot error output."})
      	_mcp_done()
      "
    `);
  });
});
