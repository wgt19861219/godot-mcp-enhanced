// GDScript template constants shared across tool modules.
// Uses readonly string[] to prevent JS variable interpolation into GDScript code.

export const MARKER_RESULT = '___MCP_RESULT___';
export const MARKER_ERROR = '___MCP_ERROR___';

export const TYPE_WHITELIST = [
  'Node3D', 'MeshInstance3D', 'StaticBody3D', 'RigidBody3D',
  'CharacterBody3D', 'Camera3D', 'Light3D', 'DirectionalLight3D',
  'OmniLight3D', 'SpotLight3D', 'CollisionShape3D', 'RayCast3D',
  'Area3D', 'Marker3D', 'PathFollow3D', 'VisibleOnScreenNotifier3D',
] as const;

/** _mcp_get_root() — 获取场景根节点（缓存） */
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\t# Godot 4.6+: self.root is required (extends SceneTree — root is native property)',
  '\tif self.root != null:',
  '\t\t_mcp_root = self.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];

/** _mcp_get_node() — 按路径获取节点（精确版：只在根节点上下文跳过 "root"） */
export const GD_MCP_GET_NODE: readonly string[] = [
  'func _mcp_get_node(path: NodePath) -> Node:',
  '\tvar _p: String = str(path)',
  '\tif _p.begins_with("/"):',
  '\t\t_p = _p.substr(1)',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn null',
  '\t# Fallback: root.get_node() may fail in headless _initialize()',
  '\tvar _node: Node = _r.get_node_or_null(_p)',
  '\tif _node != null:',
  '\t\treturn _node',
  '\t# Manual traversal for headless compatibility',
  '\tvar _parts: PackedStringArray = _p.split("/")',
  '\t_node = _r',
  '\tfor _part in _parts:',
  '\t\tif _part == "":',
  '\t\t\tcontinue',
  '\t\tvar _found: bool = false',
  '\t\tfor _ch in _node.get_children():',
  '\t\t\tif _ch.name == _part:',
  '\t\t\t\t_node = _ch',
  '\t\t\t\t_found = true',
  '\t\t\t\tbreak',
  '\t\tif not _found:',
  '\t\t\tif _part == "root" and _node == _r:',
  '\t\t\t\tcontinue',
  '\t\t\treturn null',
  '\treturn _node',
];

/** _mcp_load_main_scene() — 加载主场景 */
export const GD_MCP_LOAD_MAIN_SCENE: readonly string[] = [
  'func _mcp_load_main_scene() -> void:',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn',
  '\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")',
  '\tif _sp != null and _sp != "":',
  '\t\tvar _sr = load(_sp)',
  '\t\tif _sr:',
  '\t\t\t_r.add_child(_sr.instantiate())',
];

/** _mcp_output() — 记录输出 */
export const GD_MCP_OUTPUT: readonly string[] = [
  'func _mcp_output(key: String, value: Variant) -> void:',
  '\t_mcp_outputs.append({"key": key, "value": str(value)})',
];

export const SCENE_TREE_HEADER = [
  'extends SceneTree',
  '',
  'var _mcp_outputs: Array = []',
  '# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
  'var _mcp_root: Node = null',
  'var _mcp_scene_instance: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  '',
  // SCENE_TREE_HEADER 独有：场景加载和导航辅助
  // Task D4 (2026-11-12): load() 返回 null 最常见根因是场景绑定脚本引用 autoload/class_name
  // 在 headless 编译失败——null 分支文案附归因（前缀保持 "Failed to load scene"，errorMapper
  // 的 LOAD_FAILED 匹配依赖此子串）；引擎原始错误行由 TS 侧 parseGdscriptResult 拼 result.errors。
  'func _mcp_load_scene(sp: String) -> bool:',
  '	var _r: Node = _mcp_get_root()',
  '	if _r == null:',
  '		_mcp_output("error", "Scene root not available")',
  '		return false',
  '	if _mcp_scene_instance != null:',
  '		if _mcp_scene_instance.get_parent() != null:',
  '			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)',
  '		_mcp_scene_instance.queue_free()',
  '		_mcp_scene_instance = null',
  '	var _sr = load(sp)',
  '	if _sr == null:',
  '		_mcp_output("error", "Failed to load scene: " + sp + " — scene or its attached scripts failed to compile, check script dependencies/autoloads (headless lacks autoload/class_name resolution; structural changes should use the editor WS channel)")',
  '		return false',
  '	_mcp_scene_instance = _sr.instantiate()',
  '	_r.add_child(_mcp_scene_instance)',
  '	return true',
  '',
  'func _mcp_get_scene_node(path: String) -> Node:',
  '	# Search within loaded scene instance (avoids root/SceneName prefix issue)',
  '	if _mcp_scene_instance != null:',
  '		var _p: String = path',
  '		while _p.begins_with("/"):',
  '			_p = _p.substr(1)',
  '		# Strip leading "root/" or "root" prefix',
  '		if _p.begins_with("root/"):',
  '			_p = _p.substr(5)',
  '		elif _p == "root":',
  '			_p = ""',
  '		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")',
  '		if _p != "" and _mcp_scene_instance.name.length() > 0:',
  '			var _scene_name: String = _mcp_scene_instance.name + "/"',
  '			if _p.begins_with(_scene_name):',
  '				_p = _p.substr(_scene_name.length())',
  '			elif _p == _mcp_scene_instance.name:',
  '				_p = ""',
  '		if _p == "":',
  '			return _mcp_scene_instance',
  '		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)',
  '		if _node != null:',
  '			return _node',
  '	# Fallback to global search',
  '	return _mcp_get_node(path)',
  '',
  ...GD_MCP_OUTPUT,
  '',
  // Task D5 (2026-11-12): property set 前按目标属性类型 coerce。
  // Godot Object.set() 对 Array→数学类型 / String→Resource 均静默 no-op
  // (4.7 verified,见 command_helpers.gd coerce_value_for_property 注释)——
  // 裸 set 丢 texture/modulate 等属性。分派对齐三副本语义(editor
  // coerce_property_value / headless _set_property_with_coerce):数学类型按
  // typeof(node.get(key)) 分派(内置 Control 数学属性默认值恒非 null);Object 属性
  // 按声明类型判(get_property_list)——Object 属性默认值是 null,typeof(current)
  // 得 TYPE_NIL,load 分支永不可达(texture 陷阱)。node.get(key) 为 null 的非
  // Object 属性(不存在/无默认值)→原样 set 交引擎报错,不吞。
  'func _mcp_set_prop(node: Node, key: String, val: Variant) -> void:',
  '	var current: Variant = node.get(key)',
  '	if val is Array and current != null:',
  '		var a: Array = val',
  '		var coerced: Variant = null',
  '		match typeof(current):',
  '			TYPE_VECTOR2:',
  '				var v2x: Variant = _mcp_prop_comp(a, 0)',
  '				var v2y: Variant = _mcp_prop_comp(a, 1)',
  '				if v2x != null and v2y != null:',
  '					coerced = Vector2(float(v2x), float(v2y))',
  '			TYPE_VECTOR3:',
  '				var v3x: Variant = _mcp_prop_comp(a, 0)',
  '				var v3y: Variant = _mcp_prop_comp(a, 1)',
  '				var v3z: Variant = _mcp_prop_comp(a, 2)',
  '				if v3x != null and v3y != null and v3z != null:',
  '					coerced = Vector3(float(v3x), float(v3y), float(v3z))',
  '			TYPE_VECTOR4:',
  '				var v4x: Variant = _mcp_prop_comp(a, 0)',
  '				var v4y: Variant = _mcp_prop_comp(a, 1)',
  '				var v4z: Variant = _mcp_prop_comp(a, 2)',
  '				var v4w: Variant = _mcp_prop_comp(a, 3)',
  '				if v4x != null and v4y != null and v4z != null and v4w != null:',
  '					coerced = Vector4(float(v4x), float(v4y), float(v4z), float(v4w))',
  '			TYPE_COLOR:',
  '				var cr: Variant = _mcp_prop_comp(a, 0)',
  '				var cg: Variant = _mcp_prop_comp(a, 1)',
  '				var cb: Variant = _mcp_prop_comp(a, 2)',
  '				if cr != null and cg != null and cb != null:',
  '					var ca: Variant = _mcp_prop_comp(a, 3)',
  '					coerced = Color(float(cr), float(cg), float(cb), float(ca) if ca != null else 1.0)',
  '		if coerced != null:',
  '			node.set(key, coerced)',
  '			return',
  '	elif val is String and _mcp_prop_declared_type(node, key) == TYPE_OBJECT:',
  // D5 M1+M2(终审 Important-2, 2026-11-12): res:// load 前路径防护(对齐
  // godot_operations.gd _sanitize_res_path 的拒绝语义,null byte/反斜杠/
  // percent-decode 穿越 → prop_error 跳过不 load);TYPE_OBJECT 收非 res://
  // 字符串也显式报 prop_error 不再静默 no-op(文案对齐 editor 副本
  // command_helpers.gd coerce_property_value)。
  '		var res_path: String = String(val)',
  '		if not res_path.begins_with("res://"):',
  '			_mcp_output("prop_error", "Property " + key + " expects Resource, got plain String \'" + res_path + "\' (use res:// path)")',
  '			return',
  '		if not _mcp_res_path_ok(res_path):',
  '			_mcp_output("prop_error", "Unsafe res:// path blocked for " + key + ": " + res_path)',
  '			return',
  '		var res: Variant = load(res_path)',
  '		if res != null:',
  '			node.set(key, res)',
  '		else:',
  '			_mcp_output("prop_error", "Failed to load resource for " + key + ": " + res_path)',
  '		return',
  '	node.set(key, val)',
  '',
  // D5 M1(终审 Important-2): load 前防护 ~15 行内联(拒绝语义,与 godot_operations.gd
  // _sanitize_res_path 同源——那边读文件面归一化后仍放行,这里属性注入面直接拒绝上报)。
  // null byte(裸与 %00)/反斜杠(裸与 %5C)/percent-decode 后的 .. 或 . 段一律拒。
  'func _mcp_res_path_ok(path: String) -> bool:',
  '	if path.find(char(0)) != -1:',
  '		return false',
  '	var decoded: String = path',
  '	if path.find("%") != -1:',
  '		decoded = path.uri_decode()',
  '	if decoded.find(char(0)) != -1 or decoded.find("\\\\") != -1:',
  '		return false',
  '	for part in decoded.substr(6).split("/"):',
  '		if part == ".." or part == ".":',
  '			return false',
  '	return true',
  '',
  'func _mcp_prop_declared_type(node: Node, key: String) -> int:',
  '	for p in node.get_property_list():',
  '		if String(p.get("name", "")) == key:',
  '			return int(p.get("type", TYPE_NIL))',
  '	return -1',
  '',
  // Keep in sync(分量白名单,语义对齐三副本): addons/.../command_helpers.gd
  // _comp_white + src/scripts/godot_operations.gd _math_comp + mcp_bridge.gd _math_comp。
  // 仅 int/float/合法数字串放行——float(毒分量 {}/null/容器) 是 SCRIPT ERROR
  // (engine-quirks 真机实证)。
  'func _mcp_prop_comp(a: Array, index: int) -> Variant:',
  '	if index < a.size():',
  '		var c: Variant = a[index]',
  '		if c is int or c is float or (c is String and String(c).is_valid_float()):',
  '			return c',
  '	return null',
  '',
  'func _mcp_done() -> void:',
  '	print("' + MARKER_RESULT + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
  '	if Engine.get_main_loop() == self:',
  '		quit(0)',
].join('\n');
