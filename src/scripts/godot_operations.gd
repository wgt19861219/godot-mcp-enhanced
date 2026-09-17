#!/usr/bin/env -S godot --headless --script
extends SceneTree

var debug_mode = false

# ── Inline safe-value check (mirrors safe_values.gd, used when running outside project context) ──
# C-03: Keep in sync with src/scripts/safe_values.gd — that is the canonical source.
const _SAFE_MAX_DEPTH := 10

func _is_safe_value(val: Variant, depth: int = 0) -> bool:
	if depth > _SAFE_MAX_DEPTH:
		return false
	if val == null:
		return true
	if val is bool or val is int or val is float or val is String or val is StringName:
		return true
	if val is Vector2 or val is Vector2i or val is Vector3 or val is Vector3i:
		return true
	if val is Color or val is Rect2 or val is Rect2i:
		return true
	if val is Transform2D or val is Transform3D or val is Basis or val is Quaternion:
		return true
	if val is Plane or val is AABB:
		return true
	if val is PackedByteArray or val is PackedInt32Array or val is PackedInt64Array:
		return true
	if val is PackedFloat32Array or val is PackedFloat64Array or val is PackedStringArray:
		return true
	if val is PackedVector2Array or val is PackedVector3Array or val is PackedColorArray:
		return true
	if val is Array:
		for item in val:
			if not _is_safe_value(item, depth + 1):
				return false
		return true
	if val is Dictionary:
		for key in val:
			if not _is_safe_value(key, depth + 1):
				return false
			if not _is_safe_value(val[key], depth + 1):
				return false
		return true
	return false

# ── 资源属性类型识别 helper（Spec A §1）────────────────────────────────────
# JSON 无法表达 Resource 实例，res:// String 路径 → sanitize + load 成 Resource 再 set；
# 类型不匹配报错非静默（解决 batch silently fail）。
# 仅覆盖 TYPE_OBJECT + res://（NodePath / Array 数学类型留 follow-up，不退化现状）。
func _get_property_type(obj: Object, key: String) -> int:
	for p in obj.get_property_list():
		if String(p.get("name", "")) == key:
			return int(p.get("type", TYPE_NIL))
	return -1

# CMP-10 (2026-08-08): 检查 value 是否含足够分量匹配数学类型(Vector2 需 2, Vector3 需 3 等)。
# 支持 Array(长度)、Dictionary(x/y/z/w 或 r/g/b/a 键)、Vector*(已是正确类型直接通过)。
# 对齐竞品 PropertyParser._has_components,防 typeof(current) 陷阱(Vector2(0,0) 静默接受单值)。
func _has_components(value: Variant, needed: int) -> bool:
	if value is Vector2 and needed <= 2: return true
	if value is Vector2i and needed <= 2: return true
	if value is Vector3 and needed <= 3: return true
	if value is Vector3i and needed <= 3: return true
	if value is Vector4 and needed <= 4: return true
	if value is Color and needed <= 4: return true
	if value is Rect2 and needed <= 4: return true
	if value is Quaternion and needed <= 4: return true
	if value is Plane and needed <= 4: return true
	if value is Array:
		return (value as Array).size() >= needed
	if value is Dictionary:
		var d: Dictionary = value
		# 尝试 x/y/z/w 键名
		var xy_keys := ["x", "y", "z", "w"]
		var count := 0
		for k in xy_keys:
			if d.has(k): count += 1
		if count >= needed: return true
		# 尝试 r/g/b/a 键名(Color)
		var rgba_keys := ["r", "g", "b", "a"]
		count = 0
		for k in rgba_keys:
			if d.has(k): count += 1
		if count >= needed: return true
		return false
	return false

# E-1 (2026-08-14): MCP JSON Array/Dict 输入 → Godot 数学类型真转换(DUPLICATE 三副本之一)。
# ⚠️ 三副本同步关系(改任一处须同步另外两处):
#   源(editor 侧):   addons/godot_mcp_server/commands/command_helpers.gd coerce_value_for_property
#   副本(headless):  本文件 _coerce_math_value
#   副本(bridge 侧): src/scripts/mcp_bridge.gd _coerce_math_value
# headless --script 是独立 script context 无法 import addons,对齐 mcp_bridge.gd
# _is_safe_value 内联副本的做法(C-03 DUPLICATE 同步模式)。
# 与 editor 源版差异(有意): 按属性声明类型 prop_type 分派而非 typeof(current)——调用方
# 已从 get_property_list 取得声明类型;支持 Dict{x,y,z,w}/{r,g,b,a} 输入(对齐 _has_components);
# 补 Vector4i/Rect2/Rect2i 构造。返回 null = Array/Dict 输入但分量缺失/为 null 无法构造。
func _coerce_math_value(prop_type: int, value: Variant) -> Variant:
	if not (value is Array or value is Dictionary):
		return value  # 已是数学类型/标量等,透传交 node.set
	var x: Variant = _math_comp(value, 0, "x")
	var y: Variant = _math_comp(value, 1, "y")
	var z: Variant = _math_comp(value, 2, "z")
	var w: Variant = _math_comp(value, 3, "w")
	var r: Variant = _math_comp(value, 0, "r")
	var g: Variant = _math_comp(value, 1, "g")
	var b: Variant = _math_comp(value, 2, "b")
	var a: Variant = _math_comp(value, 3, "a")
	if prop_type == TYPE_VECTOR2:
		if x != null and y != null:
			return Vector2(float(x), float(y))
	elif prop_type == TYPE_VECTOR2I:
		if x != null and y != null:
			return Vector2i(int(x), int(y))
	elif prop_type == TYPE_VECTOR3:
		if x != null and y != null and z != null:
			return Vector3(float(x), float(y), float(z))
	elif prop_type == TYPE_VECTOR3I:
		if x != null and y != null and z != null:
			return Vector3i(int(x), int(y), int(z))
	elif prop_type == TYPE_VECTOR4:
		if x != null and y != null and z != null and w != null:
			return Vector4(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_VECTOR4I:
		if x != null and y != null and z != null and w != null:
			return Vector4i(int(x), int(y), int(z), int(w))
	elif prop_type == TYPE_COLOR:
		# 先 r/g/b/a 键名,再 x/y/z/w(对齐 _has_components 两种键名都接受)
		if r != null and g != null and b != null:
			return Color(float(r), float(g), float(b), float(a) if a != null else 1.0)
		if x != null and y != null and z != null:
			return Color(float(x), float(y), float(z), float(w) if w != null else 1.0)
	elif prop_type == TYPE_PLANE:
		if x != null and y != null and z != null and w != null:
			return Plane(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_QUATERNION:
		if x != null and y != null and z != null and w != null:
			return Quaternion(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_RECT2:
		if x != null and y != null and z != null and w != null:
			return Rect2(float(x), float(y), float(z), float(w))
	elif prop_type == TYPE_RECT2I:
		if x != null and y != null and z != null and w != null:
			return Rect2i(int(x), int(y), int(z), int(w))
	return null

# E-1: 数学分量读取——Array 按索引,Dict 按 key(x/y/z/w 或 r/g/b/a);越界/缺键/值为 null 返 null。
# 返 null 时 _coerce_math_value 视为分量缺失,调用方报错拒绝(防 float(null) 运行时崩溃)。
func _math_comp(value: Variant, index: int, key: String) -> Variant:
	if value is Array:
		var arr: Array = value
		if index < arr.size() and arr[index] != null:
			return arr[index]
		return null
	if value is Dictionary:
		var dict: Dictionary = value
		if dict.has(key) and dict[key] != null:
			return dict[key]
	return null

func _set_property_with_coerce(node: Node, key: String, value: Variant) -> bool:
	# 双保险：instance 即使漏加 _BLOCKED_PROPERTIES 也拒
	# I-2: instance 可注入 ExtResource 实例化恶意场景 _ready，与 script 同级危险
	if key == "instance":
		log_error("Blocked 'instance' property (I-2 security)")
		return false
	var prop_type := _get_property_type(node, key)
	if prop_type == -1:
		log_error("Property not found: %s on %s" % [key, node.get_class()])
		return false
	var coerced: Variant = value
	if prop_type == TYPE_OBJECT:
		if value is String and value.begins_with("res://"):
			coerced = load(_sanitize_res_path(value))
			if coerced == null:
				log_error("Failed to load resource for %s: %s" % [key, value])
				return false
		elif value is String:
			# Resource 属性传非 res:// String → 报错非静默（解决 batch silently fail）
			log_error("Property %s expects Resource, got plain String '%s' (use res:// path)" % [key, value])
			return false
	# CMP-10 (2026-08-08): 数学类型分量校验——防 Vector2 属性传单值静默变 Vector2(0,0)。
	# 对齐竞品 _has_components:检查传入值的分量数是否匹配属性期望的数学类型。
	# E-1 (2026-08-14): 校验通过后补真转换(_coerce_math_value)——原实现只校验不转换,
	# coerced 仍是原 Array/Dict,node.set(Array→数学类型)是静默 no-op 但返 success
	# (Godot 4.7 verified,见 command_helpers.gd:93-94 注释)。类型面扩至 Vector4/4i/
	# Plane/Quaternion(对齐 editor coerce_value_for_property)。
	var math_needed := 0
	var math_label := ""
	if prop_type == TYPE_VECTOR2 or prop_type == TYPE_VECTOR2I:
		math_needed = 2
		math_label = "Vector2 (2 components)"
	elif prop_type == TYPE_VECTOR3 or prop_type == TYPE_VECTOR3I:
		math_needed = 3
		math_label = "Vector3 (3 components)"
	elif prop_type == TYPE_COLOR:
		math_needed = 3  # Color 允许 3(r,g,b) 或 4(r,g,b,a)
		math_label = "Color (3-4 components)"
	elif prop_type == TYPE_RECT2 or prop_type == TYPE_RECT2I:
		math_needed = 4
		math_label = "Rect2 (4 components)"
	elif prop_type == TYPE_VECTOR4 or prop_type == TYPE_VECTOR4I \
			or prop_type == TYPE_PLANE or prop_type == TYPE_QUATERNION:
		math_needed = 4
		math_label = "4-component math type (Vector4/Plane/Quaternion)"
	if math_needed > 0:
		if not _has_components(value, math_needed):
			log_error("Property %s expects %s, got: %s" % [key, math_label, value])
			return false
		var converted: Variant = _coerce_math_value(prop_type, value)
		if converted == null:
			log_error("Property %s: cannot coerce %s (missing/null component)" % [key, value])
			return false
		coerced = converted
	node.set(key, coerced)
	return true

func _init():
	var args = OS.get_cmdline_args()
	debug_mode = "--debug-godot" in args

	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		_exit_with(1)
		return
	var operation_index = script_index + 2
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		_exit_with(1)
		return
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
		_exit_with(1)
		return
	if not params:
		log_error("Failed to parse JSON parameters: " + params_json)
		_exit_with(1)
		return
	log_info("Executing operation: " + operation)

	# B7: 进程启动清 res:// 残留 *.tmp.{tres,tscn,res}(超时 kill 落在 save 中途的半截文件)
	_clean_atomic_tmp()

	match operation:
		"create_scene":
			create_scene(params)
		"add_node":
			add_node(params)
		"edit_node":
			edit_node(params)
		"remove_node":
			remove_node(params)
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
			cleanup_and_quit([], 1)

	# 反馈 2026-08-27 真机坐实:无参 call_deferred("quit") = quit(0),在 handler 内
	# quit(1)(如 batch failed_count>0 的「修真静默」、save/pack 失败的 2026-08-07 P1
	# 修复)之后执行,退出码被覆盖回 0——历史上所有非零退出码从未真正到达 TS 层。
	# 修:所有 quit(N) 收口为 _exit_with(N) 登记,尾部按登记值重放。
	call_deferred("quit", _requested_exit_code)
	return
# ─── Logging helpers ──────────────────────────────────────────────────────────

func log_debug(message: String) -> void:
	if debug_mode:
		print("[DEBUG] " + message)

func log_info(message: String) -> void:
	print("[INFO] " + message)

func log_error(message: String) -> void:
	printerr("[ERROR] " + message)

# 统一退出码登记(见 _init 尾部注释):quit(code) 的退出码无法读回(SceneTree 无 getter),
# 尾部 deferred 无参 quit 会覆盖它——所有非零退出必须经 _exit_with 登记。
var _requested_exit_code := 0

func _exit_with(code: int) -> void:
	_requested_exit_code = code
	quit(code)

func cleanup_and_quit(nodes: Array, exit_code: int = 0) -> void:
	for node in nodes:
		if is_instance_valid(node):
			node.free()
	_exit_with(exit_code)
	return

# B5(反馈批次 B, 2026-09-09/09-10): 落盘后回读自检——save 返回 OK 不等于文件可加载
# (历史上序列化异常/半写形态静默成功,调用方下次操作/游戏加载才发现节点被丢)。
# 回读用 CACHE_MODE_IGNORE 绕过本进程资源缓存直读盘上文件;SceneState 节点计数比对
# (不 instantiate,零脚本副作用——场景可能挂用户脚本)。失败 → 调用方 exit 1 当场报错。
func _verify_saved_scene(saved_res_path: String, packed: PackedScene) -> bool:
	var expected: int = packed.get_state().get_node_count()
	var reloaded = ResourceLoader.load(saved_res_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if reloaded == null or not (reloaded is PackedScene):
		log_error("Self-check failed: saved scene failed to load back: " + saved_res_path)
		return false
	var actual: int = (reloaded as PackedScene).get_state().get_node_count()
	if actual != expected:
		log_error("Self-check failed: node count mismatch after save (packed %d, reloaded %d) — nodes dropped on reload: " % [expected, actual] + saved_res_path)
		return false
	return true

# 审查 M-3(2026-09-03): parent 规范化统一——原 add_node/batch 只特判整体 "root"/裸根名 +
# 剥 "root/" 前缀,不剥 "/root/" 与场景根名前缀,与 edit_node/remove_node 的 node_path 剥离链
# 分叉(同一输入 "/root/Foo" 或 query_scene_tree 拷贝的 "Main/Foo" 在两路径行为不同)。
# 统一剥离链;根/空串解析为 scene_root 自身;失败返回 null(调用方处置)。
func _resolve_parent_node(parent_path: String, scene_root: Node) -> Node:
	if parent_path == "" or parent_path == "root" or parent_path == "/root" or parent_path == scene_root.name:
		return scene_root
	var cleaned := parent_path
	if cleaned.begins_with("/root/"):
		cleaned = cleaned.substr(6)
	elif cleaned.begins_with("root/"):
		cleaned = cleaned.substr(5)
	elif cleaned.begins_with("/"):
		cleaned = cleaned.substr(1)
	if cleaned.begins_with(scene_root.name + "/"):
		cleaned = cleaned.substr(scene_root.name.length() + 1)
	if cleaned == "" or cleaned == scene_root.name:
		return scene_root
	return scene_root.get_node_or_null(cleaned)

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

# headless instantiate_class 类型白名单(合并 node_commands ALLOWED_NODE_TYPES +
# ui_commands ALLOWED_CONTROL_TYPES + 裸 Control, 移除裸 Node)。
# 对齐 editor node_commands.gd ALLOWED_NODE_TYPES + ui_commands.gd ALLOWED_CONTROL_TYPES
# 纯白名单精神(I-4 / IMPORTANT-14)。移除 "Node" 堵 extends Node 恶意脚本 _ready RCE:
# Node 自身是 Node 的父类 → is_parent_class("Node","Node")=true → base_type="Node" 通过
# → script.new() 触发 _ready OS.execute RCE(不经 execute_gdscript 沙箱)。
# 须与 addons/.../commands/node_commands.gd + ui_commands.gd 三处白名单同步(defects detect 守护)。
const ALLOWED_HEADLESS_TYPES: Array = [
	"Node3D", "MeshInstance3D", "StaticBody3D", "RigidBody3D",
	"CharacterBody3D", "Camera3D", "Light3D", "DirectionalLight3D",
	"OmniLight3D", "SpotLight3D", "CollisionShape3D", "RayCast3D",
	"Area3D", "Marker3D", "PathFollow3D", "VisibleOnScreenNotifier3D",
	"Node2D", "Sprite2D", "AnimatedSprite2D",
	"CollisionShape2D", "Area2D", "RigidBody2D", "CharacterBody2D",
	"AudioStreamPlayer", "AudioStreamPlayer2D", "AudioStreamPlayer3D",
	"AnimationPlayer", "AnimationTree", "Timer",
	"Control",
	"Button", "Label", "Panel", "LineEdit", "TextEdit", "RichTextLabel",
	"LinkButton", "HSlider", "VSlider", "CheckBox", "CheckButton",
	"OptionButton", "SpinBox", "ProgressBar", "TextureRect", "ColorPickerButton",
	"TabContainer", "Tree", "ItemList", "MarginContainer", "HBoxContainer",
	"VBoxContainer", "GridContainer", "CenterContainer", "ScrollContainer",
	"PanelContainer", "HSplitContainer", "VSplitContainer", "NinePatchRect",
	# 反馈批次 B B1(2026-09-09/09-10): TextureButton/ColorRect 是 UI 刚需(图片按钮/遮罩色块),
	# 此前缺失致 headless add_node/batch_add_nodes Refused。与 ui_commands ALLOWED_CONTROL_TYPES 同步。
	"TextureButton", "ColorRect",
]

func _is_headless_allowed(type_name: String) -> bool:
	return type_name in ALLOWED_HEADLESS_TYPES

func instantiate_class(name_of_class: String):
	if name_of_class.is_empty():
		log_error("Cannot instantiate class: name is empty")
		return null

	# I-S3: 深层纵深——即便白名单,仍阻危险引擎类前缀(白名单已不含,此为防御网)。
	var blocked_prefixes := ["File", "Thread", "Mutex", "Semaphore", "OS", "IP", "StreamPeer", "TCP", "UDP", "HTTP", "TLS", "Crypto", "Hash", "RegEx", "XML", "JSONParser", "ResourceLoader", "ResourceSaver", "PackedData", "TranslationServer", "PhysicsServer", "RenderingServer", "AudioServer", "NavigationServer", "DisplayServer"]
	for prefix in blocked_prefixes:
		if name_of_class.begins_with(prefix):
			log_error(String("Class %s is blocked for security reasons") % name_of_class)
			return null
	if ClassDB.class_exists(name_of_class):
		# P1 RCE 修复(对齐 editor I-4 / IMPORTANT-14):纯白名单 ∈ 检查,不再用
		# is_parent_class("Node") 兜底。is_parent_class("Node","Node")=true →
		# extends Node 恶意类绕过 → instantiate 跑 _ready RCE。白名单移除裸 Node,
		# 仅允许具体可实例化类型 + Node2D/Node3D/Control 基础类。
		if not _is_headless_allowed(name_of_class):
			log_error(String("Refused: %s is not in the headless allowed types whitelist") % name_of_class)
			return null
		if not ClassDB.can_instantiate(name_of_class):
			log_error("Class exists but cannot be instantiated: " + name_of_class)
			return null
		var result = ClassDB.instantiate(name_of_class)
		if result == null:
			log_error("ClassDB.instantiate() returned null for class: " + name_of_class)
		return result

	var script = get_script_by_name(name_of_class)
	if script is GDScript:
		# P1 RCE 修复:script 分支同样用白名单——检查脚本 extends 的 base_type ∈ 白名单。
		# extends Node2D 合法自定义脚本 base_type="Node2D" ∈ 允许;
		# extends Node 恶意脚本 base_type="Node" ∉ 允许(白名单移除裸 Node)→ 拒绝, 堵 _ready RCE。
		var base_type: String = script.get_instance_base_type()
		if base_type.is_empty() or not _is_headless_allowed(base_type):
			log_error(String("Refused: script class %s base type %s not in headless whitelist") % [name_of_class, base_type])
			return null
		return script.new()

	log_error("Failed to get script for class: " + name_of_class)
	return null

# ─── Scene operations ─────────────────────────────────────────────────────────

func create_scene(params):
	log_info("Creating scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

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
		_exit_with(1)
		return

	# C-03: apply root_node_name after successful instantiation (was dead code after return)
	if params.has("root_node_name") and params.root_node_name != "":
		scene_root.name = params.root_node_name
	else:
		scene_root.name = "root"

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result != OK:
		log_error("Failed to pack scene: " + str(result))
		cleanup_and_quit([scene_root], 1)
		return

	# Ensure directory exists
	var scene_dir_relative = scene_dir_res.substr(6)
	if not scene_dir_relative.is_empty():
		var dir = DirAccess.open("res://")
		if dir == null:
			var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
			if make_dir_error != OK:
				log_error("Failed to create directory: " + scene_dir_abs)
				cleanup_and_quit([scene_root], 1)
				return
		else:
			if not dir.dir_exists(scene_dir_relative):
				var make_dir_error = dir.make_dir_recursive(scene_dir_relative)
				if make_dir_error != OK:
					log_error("Failed to create directory: " + scene_dir_relative + ", error: " + str(make_dir_error))
					cleanup_and_quit([scene_root], 1)
					return

	var save_error = _save_atomic(packed_scene, full_scene_path)
	scene_root.free()
	if save_error == OK:
		print("Scene created successfully at: " + params.scene_path)
	else:
		log_error("Failed to save scene. Error: " + str(save_error))
		_exit_with(1)
		return
func add_node(params):
	log_info("Adding node to scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)

	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()

	var parent_path = "root"
	if params.has("parent_node_path"):
		parent_path = params.parent_node_path

	var parent = _resolve_parent_node(parent_path, scene_root)
	if not parent:
		log_error("Parent node not found: " + parent_path)
		cleanup_and_quit([scene_root], 1)
		return

	var new_node = instantiate_class(params.node_type)
	if not new_node:
		log_error("Failed to instantiate node of type: " + params.node_type)
		cleanup_and_quit([scene_root], 1)
		return
	new_node.name = params.node_name

	# 审查 C-1(2026-09-03): 属性失败曾仅 log_error(走 stderr)后继续落盘→exit 0 假成功,
	# 错误行被 TS 成功路径(只取 stdout)整体丢弃。对齐 batch_add_nodes「任一属性失败→整节点失败」。
	if params.has("properties"):
		var properties = params.properties
		for property in properties:
			if _is_safe_property(property):
				if not _set_property_with_coerce(new_node, property, properties[property]):
					log_error("Failed to set property %s on new node" % property)
					new_node.free()
					cleanup_and_quit([scene_root], 1)
					return

	parent.add_child(new_node)
	new_node.owner = scene_root

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var save_error = _save_atomic(packed_scene, absolute_scene_path, absolute_scene_path)  # A5: 回填原 uid
		if save_error == OK:
			if not _verify_saved_scene(full_scene_path, packed_scene):  # B5: 回读自检
				cleanup_and_quit([scene_root], 1)
				return
			print("Node '%s' of type '%s' added successfully" % [params.node_name, params.node_type])
		else:
			log_error("Failed to save scene: " + str(save_error))
			cleanup_and_quit([scene_root], 1)
			return
	else:
		log_error("Failed to pack scene: " + str(result))
		cleanup_and_quit([scene_root], 1)
		return
	scene_root.free()


func edit_node(params):
	log_info("Editing node in scene: " + params.scene_path)
	var full_scene_path = _sanitize_res_path(params.scene_path)
	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()
	# node_path 规范化：TS 侧 normalizeNodePath 传 "/root/Root/X" 格式，
	# scene_root 是 instantiate 出来的 PackedScene 根，未挂 SceneTree，绝对路径找不到。
	# 复用 add_node parent_path 规范化逻辑：剥 "/root/" / "root/" 前缀，转相对路径。
	var node_path = params.node_path
	if node_path.begins_with("/root/"):
		node_path = node_path.substr(6)
	elif node_path.begins_with("root/"):
		node_path = node_path.substr(5)
	elif node_path.begins_with("/"):
		node_path = node_path.substr(1)
	# 根名前缀剥离(对齐 remove_node):query_scene_tree 拷贝路径含场景根名,get_node_or_null
	# 相对 scene_root 自身,不剥会误报 not found
	if node_path.begins_with(scene_root.name + "/"):
		node_path = node_path.substr(scene_root.name.length() + 1)
	var node = scene_root.get_node_or_null(node_path)
	if node == null:
		log_error("Node not found: " + params.node_path)
		cleanup_and_quit([scene_root], 1)
		return
	var failed = 0
	if params.has("properties"):
		for key in params.properties:
			if not _is_safe_property(key):
				log_error("Blocked property: " + key)
				failed += 1
				continue
			if not _set_property_with_coerce(node, key, params.properties[key]):
				failed += 1
	# 持久化：复用 add_node pack+save 尾段，不复用 owner 赋值
	# (add_node new_node.owner=scene_root 是给新节点设归属；edit_node 改已存在节点，
	#  照搬会把 owner 非本场景的节点如 instance 子节点错误提升、被 pack 进主场景)
	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)
	if result == OK:
		var save_error = _save_atomic(packed_scene, absolute_scene_path, absolute_scene_path)  # A5: 回填原 uid
		if save_error == OK:
			if not _verify_saved_scene(full_scene_path, packed_scene):  # B5: 回读自检
				cleanup_and_quit([scene_root], 1)
				return
			print("Node '%s' edited successfully" % params.node_path)
		else:
			log_error("Failed to save scene: " + str(save_error))
			cleanup_and_quit([scene_root], 1)
			return
	else:
		log_error("Failed to pack scene: " + str(result))
		cleanup_and_quit([scene_root], 1)
		return
	scene_root.free()
	if failed > 0:
		# 审查 Minor-1: 成功的属性变更已 pack+save 落盘(save 在 failed 判定前),整节点重试会重复。
		log_error("Note: successful property changes are already persisted (%d failed); query_scene_tree before retrying to avoid duplicates." % failed)
		_exit_with(1)


# 反馈 2026-08-27 (CardGame2): headless remove_node 原走 TS 拼接的内联脚本,只改内存
# (remove_child + queue_free)从不落盘 → 返 success 但文件原样;后续写操作基于旧文件,
# 被删节点"复活"与新节点双份并存;且 queue_free 在无帧循环的 --script 模式下悬置,
# 进程退出报 RID leak exit 1(2026-08-30 形态)。迁 ops 持久化链对齐 edit_node:
# load → instantiate → remove_child + free → pack → _save_atomic。
func remove_node(params):
	log_info("Removing node from scene: " + params.scene_path)
	var full_scene_path = _sanitize_res_path(params.scene_path)
	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()
	# node_path 规范化：复用 edit_node 逻辑(TS 传 "/X/Y" 绝对路径形式)
	var node_path = params.node_path
	if node_path.begins_with("/root/"):
		node_path = node_path.substr(6)
	elif node_path.begins_with("root/"):
		node_path = node_path.substr(5)
	elif node_path.begins_with("/"):
		node_path = node_path.substr(1)
	# 对齐 add_node parent 特判(scene_root.name):get_node_or_null 相对 scene_root 自身,
	# 用户从 query_scene_tree 拷的路径含场景根名(如 "Main/Child2")→剥根名前缀防误报 not found
	if node_path.begins_with(scene_root.name + "/"):
		node_path = node_path.substr(scene_root.name.length() + 1)
	if node_path == "" or node_path == "." or node_path == scene_root.name:
		log_error("Cannot remove root node")
		cleanup_and_quit([scene_root], 1)
		return
	var node = scene_root.get_node_or_null(node_path)
	if node == null:
		log_error("Node not found: " + params.node_path)
		cleanup_and_quit([scene_root], 1)
		return
	var parent = node.get_parent()
	var node_name = str(node.name)
	parent.remove_child(node)
	node.free()  # 立即 free(脚本无帧循环,queue_free 悬置 = RID leak exit 1 根因)
	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)
	if result == OK:
		var save_error = _save_atomic(packed_scene, absolute_scene_path, absolute_scene_path)  # A5: 回填原 uid
		if save_error == OK:
			if not _verify_saved_scene(full_scene_path, packed_scene):  # B5: 回读自检
				cleanup_and_quit([scene_root], 1)
				return
			print("Node '%s' removed successfully from %s" % [node_name, params.scene_path])
		else:
			log_error("Failed to save scene: " + str(save_error))
			cleanup_and_quit([scene_root], 1)
			return
	else:
		log_error("Failed to pack scene: " + str(result))
		cleanup_and_quit([scene_root], 1)
		return
	scene_root.free()


func batch_add_nodes(params):
	log_info("Batch adding nodes to scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)

	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()
	var nodes = params.nodes
	var added_count = 0
	var failed_count = 0
	var failed_nodes: Array = []

	for node_def in nodes:
		var node_name = node_def.get("node_name", "")
		if not (node_name is String) or node_name == "":
			# 反馈 2026-08-27 形态3: name 缺失曾静默落成 Godot 自动名(@Control@6,%路径查不到)
			log_error("Node definition missing/empty node_name, skipped: " + str(node_def))
			failed_nodes.append("(missing node_name): " + str(node_def.get("node_type", "?")))
			failed_count += 1
			continue

		var parent_path = "root"
		if node_def.has("parent_node_path"):
			parent_path = node_def.parent_node_path

		var parent = _resolve_parent_node(parent_path, scene_root)
		if not parent:
			log_error("Parent node not found: " + parent_path + " for node: " + node_name)
			failed_nodes.append(node_name + " (parent not found: " + parent_path + ")")
			failed_count += 1
			continue

		var new_node = instantiate_class(node_def.node_type)
		if not new_node:
			log_error("Failed to instantiate: " + node_def.node_type)
			failed_nodes.append(node_name + " (instantiate failed: " + str(node_def.node_type) + ")")
			failed_count += 1
			continue

		# 反馈 2026-08-27 形态2: 属性设置失败曾只 log_error 不计数,节点照常 add +
		# added_count+=1 → 最终 "N/N added" + exit 0 的假成功(unique_name_in_owner/name 静默丢失)。
		# 修:任一属性失败 → 整节点失败(不 add_child,计 failed),per-node 清单上报。
		var failed_props: Array = []
		if node_def.has("properties"):
			var properties = node_def.properties
			for property in properties:
				if not _is_safe_property(property):
					failed_props.append(property + " (blocked)")
					continue
				if not _set_property_with_coerce(new_node, property, properties[property]):
					failed_props.append(property)
		if failed_props.size() > 0:
			log_error("Failed properties on %s: %s" % [node_name, ", ".join(PackedStringArray(failed_props))])
			failed_nodes.append(node_name + " (failed properties: " + ", ".join(PackedStringArray(failed_props)) + ")")
			failed_count += 1
			new_node.free()
			continue

		new_node.name = node_name

		parent.add_child(new_node)
		new_node.owner = scene_root
		added_count += 1

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var save_error = _save_atomic(packed_scene, absolute_scene_path, absolute_scene_path)  # A5: 回填原 uid
		if save_error == OK:
			if not _verify_saved_scene(full_scene_path, packed_scene):  # B5: 回读自检
				cleanup_and_quit([scene_root], 1)
				return
			print("Batch add completed: %d/%d nodes added to %s" % [added_count, nodes.size(), params.scene_path])
			if failed_count > 0:
				log_error("Failed to add %d nodes" % failed_count)
				for failed_desc in failed_nodes:
					log_error("  - " + failed_desc)
				# 审查 Minor-1: 部分失败语义显式化——成功的 added_count 个节点已随本次 pack+save 落盘,
				# 整批重试会重复创建(add_node 无同级重名检测);重试前先 query_scene_tree 核对。
				log_error("Note: %d successfully added nodes are already persisted; query_scene_tree before retrying to avoid duplicates." % added_count)
				# 修真静默：failed_count>0 时 quit(1)，TS scene/index.ts:329 exitCode!=0 才抓得到
				cleanup_and_quit([scene_root], 1)
				return
		else:
			log_error("Failed to save scene: " + str(save_error))
			cleanup_and_quit([scene_root], 1)
			return
	else:
		log_error("Failed to pack scene: " + str(result))
		cleanup_and_quit([scene_root], 1)
		return
	scene_root.free()


func load_sprite(params):
	log_info("Loading sprite into scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		_exit_with(1)
		return
	var full_texture_path = _sanitize_res_path(params.texture_path)

	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()

	var node_path = params.node_path
	if node_path.begins_with("root/"):
		node_path = node_path.substr(5)

	var sprite_node = null
	if node_path == "":
		sprite_node = scene_root
	else:
		sprite_node = scene_root.get_node_or_null(node_path)

	if not sprite_node:
		log_error("Node not found: " + params.node_path)
		cleanup_and_quit([scene_root], 1)
		return

	if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
		log_error("Node is not a sprite-compatible type: " + sprite_node.get_class())
		cleanup_and_quit([scene_root], 1)
		return

	var texture = load(full_texture_path)
	if not texture:
		if not FileAccess.file_exists(full_texture_path):
			log_error("Texture file not found: " + full_texture_path)
		else:
			log_error("Failed to load texture: " + full_texture_path)
			log_error("Headless mode cannot import textures. Run the editor first to generate .import cache.")
		cleanup_and_quit([scene_root], 1)
		return

	if sprite_node is Sprite2D or sprite_node is Sprite3D:
		sprite_node.texture = texture
	elif sprite_node is TextureRect:
		sprite_node.texture = texture

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var error = _save_atomic(packed_scene, full_scene_path, full_scene_path)  # A5: 回填原 uid
		if error == OK:
			if not _verify_saved_scene(full_scene_path, packed_scene):  # B5: 回读自检
				scene_root.free()
				_exit_with(1)
				return
			print("Sprite loaded successfully with texture: " + full_texture_path)
			scene_root.free()
			return
		else:
			log_error("Failed to save scene: " + str(error))
	else:
		log_error("Failed to pack scene: " + str(result))
	# 2026-08-07 审查 P1 修复：save/pack 失败分支必须 quit(1)（同 save_scene，防假成功）
	scene_root.free()
	_exit_with(1)


func export_mesh_library(params):
	log_info("Exporting MeshLibrary from scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

	var full_output_path = _sanitize_res_path(params.output_path)

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
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
		cleanup_and_quit([scene_root], 1)
		return

	var output_dir = full_output_path.get_base_dir()
	if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):
		var error = dir.make_dir_recursive(output_dir.substr(6))
		if error != OK:
			log_error("Failed to create directory: " + output_dir + ", error: " + str(error))
			cleanup_and_quit([scene_root], 1)
			return

	if item_id > 0:
		var error = _save_atomic(mesh_library, full_output_path)
		if error == OK:
			print("MeshLibrary exported successfully with %d items to: %s" % [item_id, full_output_path])
		else:
			log_error("Failed to save MeshLibrary: " + str(error))
			# 审查 M-7: 死 op 失败分支补非零登记(无 TS 调用方但 CLI 可达,原落 exit 0 假成功)
			scene_root.free()
			_exit_with(1)
			return
	else:
		log_error("No valid meshes found in the scene")
		scene_root.free()
		_exit_with(1)
		return
	scene_root.free()


func save_scene(params):
	log_info("Saving scene: " + params.scene_path)

	var full_scene_path = _sanitize_res_path(params.scene_path)

	if not FileAccess.file_exists(full_scene_path):
		log_error("Scene file does not exist: " + full_scene_path)
		_exit_with(1)
		return
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return
	var scene_root = scene.instantiate()

	var save_path = _sanitize_res_path(params.new_path) if params.has("new_path") else full_scene_path

	# Create directory if needed
	if params.has("new_path"):
		var dir = DirAccess.open("res://")
		if dir == null:
			log_error("Failed to open res:// directory")
			cleanup_and_quit([scene_root], 1)
			return

		var scene_dir = save_path.get_base_dir()
		if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):
			var error = dir.make_dir_recursive(scene_dir.substr(6))
			if error != OK:
				log_error("Failed to create directory: " + scene_dir + ", error: " + str(error))
				cleanup_and_quit([scene_root], 1)
				return

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result == OK:
		var error = _save_atomic(packed_scene, save_path, full_scene_path)  # A5: 回填原文件 uid(save_path 可为 new_path)
		if error == OK:
			if not _verify_saved_scene(save_path, packed_scene):  # B5: 回读自检
				cleanup_and_quit([scene_root], 1)
				return
			print("Scene saved successfully to: " + save_path)
			scene_root.free()
			return
		else:
			log_error("Failed to save scene: " + str(error))
	else:
		log_error("Failed to pack scene: " + str(result))
	# 2026-08-07 审查 P1 修复：save/pack 失败分支必须 quit(1)，否则 _init() 的
	# call_deferred("quit") 默认 quit(0) 致 TS 端按 exitCode 判定假成功（数据丢失却报告成功）。
	# 对照 create_scene:277-278 / edit_node:433-449 / batch_add_nodes:516-532 的失败分支处理。
	scene_root.free()
	_exit_with(1)



# ─── Security helpers ───────────────────────────────────────────────────────

const BLOCKED_PROPERTIES := [
	"script", "owner", "process_mode", "process_priority", "process_input",
	"process_unhandled_input", "process_unhandled_key_input", "process_internal",
	"physics_process_mode", "physics_interpolation_mode", "name", "meta",
	"input_event", "ready", "tree_entered", "tree_exited", "tree_exiting",
	"instance",  # I-2: instance 可注入 ExtResource 实例化恶意场景 _ready，与 script 同级危险
]

func _is_safe_property(prop_name: String) -> bool:
	if prop_name.begins_with("_"):
		return false
	if prop_name in BLOCKED_PROPERTIES:
		return false
	if "." in prop_name and prop_name.split(".")[0] in BLOCKED_PROPERTIES:
		return false
	return true





func _sanitize_res_path(path: String) -> String:
	# Null byte check
	if path.find(char(0)) != -1:
		return "res://"
	# Normalize backslashes to forward slashes
	var normalized_path = path.replace("\\", "/")
	# Percent-decode (handles %2e%2e → ..)
	# I-08: wrap uri_decode to handle invalid URI encodings gracefully
	var decoded: String = normalized_path
	if normalized_path.find("%") != -1:
		var test: String = normalized_path.uri_decode()
		if test != null:
			decoded = test
	normalized_path = decoded
	# Ensure res:// prefix
	var full = normalized_path if normalized_path.begins_with("res://") else "res://" + normalized_path
	var parts = full.substr(6).split("/")
	var result_parts = []
	for part in parts:
		# Explicitly reject traversal segments
		if part == ".." or part == ".":
			continue
		if not part.is_empty():
			result_parts.append(part)
	return "res://" + "/".join(result_parts)

# ─── File helpers ─────────────────────────────────────────────────────────────

func find_files(path: String, extension: String, depth: int = 0) -> Array:
	var files = []
	if depth > 10:
		return files
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension, depth + 1))
			elif file_name.ends_with(extension):
				files.append(path + file_name)
			file_name = dir.get_next()

	return files


func get_uid(params):
	if not params.has("file_path"):
		log_error("File path is required")
		_exit_with(1)
		return
	var file_path = _sanitize_res_path(params.file_path)

	log_info("Getting UID for file: " + file_path)

	var absolute_path = ProjectSettings.globalize_path(file_path)

	if not FileAccess.file_exists(file_path):
		log_error("File does not exist: " + file_path)
		_exit_with(1)
		return
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
		project_path = _sanitize_res_path(params.project_path)
		if not project_path.ends_with("/"):
			project_path += "/"

	var scenes = find_files(project_path, ".tscn")
	var success_count = 0
	var error_count = 0

	for scene_path in scenes:
		var scene = load(scene_path)
		if scene:
			var error = _save_atomic(scene, scene_path)
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
				# B7 例外: 此处 resave 旨在触发 .uid 边车生成(须在原路径 script_path),
				# 原子化(_save_atomic 写 .tmp.<ext>)会令 .uid 边车落到 tmp 路径→rename 后孤儿→目的失败。
				# 脚本/shader resave 快,半截损坏下次 load 即暴露; .uid 语义优先, 不原子化。
				var error = ResourceSaver.save(res, script_path)
				if error == OK:
					generated_uids += 1
				else:
					log_error("Failed to generate UID for: " + script_path)
			else:
				log_error("Failed to load resource: " + script_path)

	print("Resave complete: %d scenes saved, %d errors, %d UIDs generated" % [success_count, error_count, generated_uids])
	# 审查 M-7: 对齐 batch failed_count>0 语义——原 error_count>0 仅计数打印落 exit 0 假成功
	if error_count > 0:
		_exit_with(1)

# B7: 原子化资源写——tmp+rename 防超时 kill 落在 save 中途产半截损坏 .tres/.tscn 阻塞项目加载。
# tmp 必须以目标扩展名结尾(ResourceSaver 按扩展名分派 saver, 裸 .tmp 返回 err 15)。
# 对齐 data-import.ts:188 已验证范例 + memory resourcesaver-extension-dispatch。
# A5 (2026-08-19 反馈 headless save_scene 抹 uid): 场景写盘可选传 preserve_uids_from(原
# .tscn 路径),save 后按原文回填 [gd_scene]/[ext_resource] 的 uid 属性 —— pack() 新建
# PackedScene 的 uid 为空(ResourceSaver 便不写 uid=),ext uid 依赖 ResourceUID 注册表
# (headless 未 import 时缺失),两者都致 uid 全丢(git diff 噪音 + uid 引用断)。
# Resource 无公开 uid 属性(4.6.3 实测 Invalid access),文本回填是唯一兼容 4.5-4.7 的方法。
# resave_resources 语义=重生成 uid,不传此参;create_scene 新文件无原 uid 可保,不传。
func _save_atomic(res, full_path: String, preserve_uids_from: String = "") -> int:
	var ext := full_path.get_extension()  # tres/res/tscn/gd/shader/gdshader
	var tmp := full_path + ".tmp." + ext
	# B7: 写前清同路径旧 tmp(防上次同路径 crash 残留阻塞本次 save)
	if FileAccess.file_exists(tmp):
		DirAccess.remove_absolute(tmp)
	var uids := _extract_uids(preserve_uids_from)
	var save_err: int = ResourceSaver.save(res, tmp)
	if save_err != OK:
		DirAccess.remove_absolute(tmp)  # save 失败清半截 tmp
		return save_err
	if not uids.is_empty():
		# 回填失败不阻断 save(uid 丢失是降级非错误,主体场景已正确落盘)
		_restore_uids_in_file(tmp, uids)
	var rename_err: int = DirAccess.rename_absolute(tmp, full_path)
	if rename_err != OK:
		DirAccess.remove_absolute(tmp)  # rename 失败清 tmp
		return rename_err
	return OK


# A5: 提取 .tscn 文本的 uid 快照。{"sceneUid": String, "ext": {res://path: uid}}。
# path 不存在/读失败返空 dict(调用方跳过回填)。ext uid 按 path 建映射(重序列化后
# ext_resource 行顺序/索引会变,path 是稳定键)。
func _extract_uids(path: String) -> Dictionary:
	var result := {"sceneUid": "", "ext": {}}
	if path == "" or not FileAccess.file_exists(path):
		return {}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return {}
	var content := f.get_as_text()
	f.close()
	var ext_map: Dictionary = result["ext"]
	for line in content.split("\n"):
		var stripped := String(line).strip_edges()
		if stripped.begins_with("[gd_scene") and String(result["sceneUid"]) == "":
			var u := _extract_tscn_attr(stripped, "uid")
			if u != "":
				result["sceneUid"] = u
		elif stripped.begins_with("[ext_resource"):
			var p := _extract_tscn_attr(stripped, "path")
			var eu := _extract_tscn_attr(stripped, "uid")
			if p != "" and eu != "" and not ext_map.has(p):
				ext_map[p] = eu
	return result


# A5: 提取 header 行内 `key="value"` 属性值(仅 [gd_scene/[ext_resource 单行结构)。
func _extract_tscn_attr(line: String, key: String) -> String:
	var marker := key + "=\""
	var idx := line.find(marker)
	if idx == -1:
		return ""
	var start := idx + marker.length()
	var end_idx := line.find("\"", start)
	if end_idx == -1:
		return ""
	return line.substr(start, end_idx - start)


# A5: 把 uid 快照回填进已 save 的 .tscn 文本(仅补缺失的 uid= 属性,已有不覆盖)。
# 非 .tscn 文件跳过(.tres 无 [gd_scene] 行,天然不匹配)。
func _restore_uids_in_file(path: String, uids: Dictionary) -> void:
	if path.get_extension() != "tscn":
		return
	var scene_uid := String(uids.get("sceneUid", ""))
	var ext_uids: Dictionary = uids.get("ext", {})
	if scene_uid == "" and ext_uids.is_empty():
		return
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return
	var content := f.get_as_text()
	f.close()
	var lines: Array = content.split("\n")
	var changed := false
	for i in lines.size():
		var line := String(lines[i])
		var stripped := line.strip_edges()
		var need_uid := ""
		# N-6(审查): 带前导空格防 guid= 类子串误判
		if scene_uid != "" and stripped.begins_with("[gd_scene") and not stripped.contains(' uid="'):
			need_uid = scene_uid
		elif not ext_uids.is_empty() and stripped.begins_with("[ext_resource") and not stripped.contains(' uid="'):
			var p := _extract_tscn_attr(stripped, "path")
			if p != "" and ext_uids.has(p):
				need_uid = String(ext_uids[p])
		if need_uid != "":
			# trim_suffix("]") 去行尾 ] 再去右侧空白(GDScript rstrip 必须传字符集,不能无参)
			lines[i] = line.trim_suffix("]").strip_edges(false, true) + " uid=\"%s\"]" % need_uid
			changed = true
	if not changed:
		return
	var out := FileAccess.open(path, FileAccess.WRITE)
	if out == null:
		log_info("UID restore skipped (cannot rewrite: %s)" % path)
		return
	out.store_string("\n".join(lines))
	out.close()


# B7 启动清理: 扫 res:// 残留 *.tmp.{tres,tscn,res}(_save_atomic 超时 kill 半截产物)。
# 对齐 plan「★关键约束」+ data-import.ts:188 clean_dir 模式; 每进程早跑一次。
# .godot/ 导入缓存被 find_files 的 "." 前缀跳过排除。
func _clean_atomic_tmp() -> void:
	var removed := 0
	for ext in [".tmp.tres", ".tmp.tscn", ".tmp.res"]:
		var stale := find_files("res://", ext)
		for tmp_path in stale:
			if DirAccess.remove_absolute(tmp_path) == OK:
				removed += 1
			else:
				log_error("Failed to remove stale atomic tmp: " + tmp_path)
	if removed > 0:
		log_info("Cleaned %d stale atomic tmp file(s)" % removed)
