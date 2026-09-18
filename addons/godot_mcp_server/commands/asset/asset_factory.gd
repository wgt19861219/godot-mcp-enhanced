# asset_factory.gd
# 调度层：create_mesh 分发（6 内置 PrimitiveMesh + 5 手写 ArrayMesh）+ create_material（4 来源）
# 移植自 asset-forge asset_factory.gd（删 class_name，改 preload 引用；make_ramp 阻塞未移植，方案 A）
@tool
extends RefCounted

# 材质预设库（同目录 preload；原 asset-forge 的 MaterialLibrary）
const MaterialPresets = preload("material_presets.gd")
# 手写 ArrayMesh（同目录 preload；原 asset-forge 的 CustomMeshes，删 class_name）
const CustomMeshes = preload("custom_meshes.gd")


# v7 mesh 缓存（static var 持 Mesh 引用，常驻 plugin session；@tool 热重载偶发清空无害）
static var _cache: Dictionary = {}
# P1-6：cache FIFO 上限（防 discrete 大量不同 params 无界增长；超限淘汰最早，Dictionary 保插入顺序）
const _CACHE_LIMIT = 256


# v7 缓存：相同 (shape, params) 返同一 Mesh 资源（MeshInstance3D 共享 → GPU vertex buffer 复用）
# 未知 shape 返 null 不缓存。material 不进 key（base_params 只含几何参数子字典）
static func create_mesh(shape: String, params: Dictionary) -> Mesh:
	var key: String = shape.to_lower() + "|" + _params_key(params)
	if _cache.has(key):
		return _cache[key]
	var mesh: Mesh = create_mesh_uncached(shape, params)
	if mesh != null:
		if _cache.size() >= _CACHE_LIMIT:  # P1-6：FIFO 淘汰最早（防无界增长）
			_cache.erase(_cache.keys()[0])
		_cache[key] = mesh  # null（未知 shape）不缓存
	return mesh


# P1-6：清空 _cache（_exit_tree 调用，与 undo 历史对齐，不跨会话；@tool 热重载偶发清空无害）
static func clear_cache() -> void:
	_cache.clear()


# 既有创建逻辑（create_mesh 缓存未命中时调）
# 6 内置 PrimitiveMesh（box/cylinder/sphere/prism/wall/ramp）+ 5 手写 ArrayMesh（cone/tube/torus/stairs/fence）
# 注：ramp 仅 PrismMesh 路径（make_ramp 阻塞未移植，方案 A）
static func create_mesh_uncached(shape: String, params: Dictionary) -> Mesh:
	match shape.to_lower():
		"box":
			var m := BoxMesh.new()
			m.size = _vec3(params, "size", Vector3.ONE)
			return m
		"cylinder":
			var m := CylinderMesh.new()
			m.height = CommandHelpers.num_guarded(params.get("height"), 1.0)
			m.top_radius = CommandHelpers.num_guarded(params.get("radius"), 0.5)
			m.bottom_radius = m.top_radius
			# P2-6: clampi 下限防 mesh 退化（对齐 custom_meshes.gd:16 的 clampi(..., 3, 128)）
			m.radial_segments = clampi(CommandHelpers.int_guarded(params.get("radial_segments"), 24), 3, 128)
			return m
		"sphere":
			var m := SphereMesh.new()
			m.radius = CommandHelpers.num_guarded(params.get("radius"), 0.5)
			m.radial_segments = clampi(CommandHelpers.int_guarded(params.get("radial_segments"), 24), 3, 128)
			m.rings = clampi(CommandHelpers.int_guarded(params.get("rings"), 16), 3, 128)
			return m
		"prism":
			var m := PrismMesh.new()
			m.size = _vec3(params, "size", Vector3.ONE)
			m.left_to_right = CommandHelpers.num_guarded(params.get("left_to_right"), 0.5)
			return m
		"wall":  # 语义化 box：length/height/thickness
			var m := BoxMesh.new()
			m.size = Vector3(
				CommandHelpers.num_guarded(params.get("length"), 2.0),
				CommandHelpers.num_guarded(params.get("height"), 1.0),
				CommandHelpers.num_guarded(params.get("thickness"), 0.1)
			)
			return m
		"ramp":  # 语义化 prism：坡道（单件 PrismMesh；make_ramp 阻塞未移植，方案 A）
			var m := PrismMesh.new()
			m.size = Vector3(
				CommandHelpers.num_guarded(params.get("length"), 2.0),
				CommandHelpers.num_guarded(params.get("height"), 1.0),
				CommandHelpers.num_guarded(params.get("width"), 1.0)
			)
			m.left_to_right = 0.0
			return m
		"cone":
			return CustomMeshes.make_cone(params)
		"tube":
			return CustomMeshes.make_tube(params)
		"torus":
			return CustomMeshes.make_torus(params)
		"stairs":
			return CustomMeshes.make_stairs(params)
		"fence":
			return CustomMeshes.make_fence(params)
		_:
			push_error("AssetFactory: 未知 shape '%s'" % shape)
			return null


# v7 缓存 key：顺序无关（Dictionary key 排序）+ 零碰撞（完整内容序列化，非 hash）
# 不用 Dictionary.hash()（顺序敏感 godot-proposals #9452 + 碰撞静默返错误 mesh）
static func _params_key(params: Dictionary) -> String:
	var keys: Array = params.keys()
	keys.sort()
	var parts: PackedStringArray = []
	for k in keys:
		parts.append(str(k) + ":" + _variant_key(params[k]))
	return "{" + ",".join(parts) + "}"


# v7 _params_key 的 Variant 值序列化（递归 Dictionary 排序 / Array 有序 / PackedFloat64Array / 标量 str）
static func _variant_key(v: Variant) -> String:
	if v is Dictionary:
		return _params_key(v)  # 嵌套 dict 递归 + 排序
	if v is Array:
		var parts: PackedStringArray = []
		for x in (v as Array):
			parts.append(_variant_key(x))  # 数组有序（正确，数组本有序）
		return "[" + ",".join(parts) + "]"
	if v is PackedFloat64Array:  # _vec3 兼容（_vec3 接受 Array 或 PackedFloat64Array）
		var parts: PackedStringArray = []
		for x in (v as PackedFloat64Array):
			parts.append(str(x))
		return "[" + ",".join(parts) + "]"
	return str(v)


static func create_material(spec: Variant) -> Material:
	if spec == null:
		return MaterialPresets.create("default")
	if spec is String:
		var s: String = spec
		if s.begins_with("res://"):
			if CommandHelpers.has_path_traversal(s):
				return MaterialPresets.create("default")
			var loaded = load(s)
			return loaded if loaded is Material else MaterialPresets.create("default")
		return MaterialPresets.create(s)  # 预设名（未知 → default 回退）
	if spec is Dictionary:
		var d: Dictionary = spec
		var mat := StandardMaterial3D.new()
		if d.has("color"):
			mat.albedo_color = _parse_color(d["color"], Color(1, 1, 1))  # BUG1 修复：Array/hex 分派，非法回退白
		# P2-6: clampf [0,1] 防 metallic/roughness 超语义范围（StandardMaterial3D 要求 0~1，>1 渲染过曝）
		mat.metallic = clampf(float(d.get("metallic", 0.0)), 0.0, 1.0)
		mat.roughness = clampf(float(d.get("roughness", 0.7)), 0.0, 1.0)
		if d.has("emissive"):
			mat.emission_enabled = true
			mat.emission = _parse_color(d["emissive"], Color(0, 0, 0))  # BUG1 修复：同上，非法回退黑
		if d.has("alpha"):
			var a: float = float(d["alpha"])
			if a < 1.0:
				mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
				var c: Color = mat.albedo_color
				c.a = a
				mat.albedo_color = c
		return mat
	return MaterialPresets.create("default")


# 类型分派解析颜色：Array/PackedFloat64Array [r,g,b(,a)] / String hex / 其他 fallback。
# BUG1 修复：原 String(d["color"]) 在 d["color"] 为 Array 时调不存在的 String(Array) 构造
# → 抛 SCRIPT ERROR 中断 create_material 返 null → material_override=null 材质静默丢失。
# 风格对齐 _vec3（Array/PackedFloat64Array 分派）；第 4 元素（若有）作 alpha。
static func _parse_color(v: Variant, fallback: Color) -> Color:
	if v is Array:
		var a := v as Array
		if a.size() >= 3:
			var c := Color(float(a[0]), float(a[1]), float(a[2]))
			if a.size() >= 4:
				c.a = float(a[3])
			return c
		return fallback
	if v is PackedFloat64Array:
		var a2 := v as PackedFloat64Array
		if a2.size() >= 3:
			var c := Color(a2[0], a2[1], a2[2])
			if a2.size() >= 4:
				c.a = a2[3]
			return c
		return fallback
	if v is String:
		return _safe_html(v, fallback)
	return fallback

# A-4：Color.html 对非法 hex 返黑色 + stderr 噪声。校验合法 hex（3/4/6/8 位），非法时回退 fallback
static func _safe_html(hex: String, fallback: Color) -> Color:
	var s := hex.strip_edges().lstrip("#")
	var ok_len := s.length() == 6 or s.length() == 8 or s.length() == 3 or s.length() == 4
	if ok_len and s.is_valid_hex_number():
		return Color.html(hex)
	push_warning("非法 hex 颜色 '%s'，回退 %s" % [hex, str(fallback)])
	return fallback


# JSON 数组 [x,y,z] → Vector3
static func _vec3(params: Dictionary, key: String, default_v: Vector3) -> Vector3:
	if not params.has(key):
		return default_v
	var arr: Variant = params[key]
	if arr is Array:
		var a := arr as Array
		return Vector3(float(a[0]), float(a[1]), float(a[2])) if a.size() >= 3 else default_v
	if arr is PackedFloat64Array:
		var a2 := arr as PackedFloat64Array
		return Vector3(a2[0], a2[1], a2[2]) if a2.size() >= 3 else default_v
	return default_v
