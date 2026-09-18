## command_helpers.gd — Shared utility functions for editor command modules.
## C-05: Extracted from 7 files to eliminate ~120 lines of duplication.

class_name CommandHelpers


## Get the root node of the currently edited scene.
## Tries EditorInterface first (editor mode), falls back to SceneTree root child (headless).
static func get_edited_scene_root(plugin: EditorPlugin = null) -> Node:
	if plugin != null:
		var ei: EditorInterface = plugin.get_editor_interface()
		if ei != null:
			var edited: Node = ei.get_edited_scene_root()
			if edited != null:
				return edited
	var ml: MainLoop = Engine.get_main_loop()
	if ml == null or not (ml is SceneTree):
		return null
	var st: SceneTree = ml as SceneTree
	if st == null or st.root == null:
		return null
	if st.root.get_child_count() > 0:
		return st.root.get_child(0)
	return null


## Find a node by path relative to root.
## Strips leading "root/" prefix and leading slashes.
static func find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p: String = path
	while p.begins_with("/"):
		p = p.substr(1)
	if p.begins_with("root/"):
		p = p.substr(5)
	if p.begins_with(root.name + "/"):
		p = p.substr(root.name.length() + 1)
	elif p == root.name:
		return root
	if p == "":
		return root
	return root.get_node_or_null(p)


## Check for path traversal (`..` segments) in a resource path.
## C-1 / IMP-2-CONSISTENCY: 共享段级 `..` 阻断,被 scene_commands 与 ui_commands 复用,
## 保持防御深度一致(与 godot_operations._sanitize_res_path 对齐)。单一实现消除重复。
static func has_path_traversal(p: String) -> bool:
	return "/../" in p or p.begins_with("../") or p.ends_with("/..") or p == ".."


## B7: 原子化资源写——tmp+rename 防超时 kill 落在 save 中途产半截损坏 .tres/.tscn 阻塞项目加载。
## tmp 必须以目标扩展名结尾(ResourceSaver 按扩展名分派 saver, 裸 .tmp 返回 err 15)。
## 对齐 data-import.ts:188 已验证范例 + headless godot_operations.gd _save_atomic(同模式独立实现)。
## T3a 教训1: FileAccess.file_exists 静态; DirAccess 的 file_exists 是实例方法(Godot 4)。
## T3a 教训3: write-before-clean——同路径旧 tmp 残留先清,防阻塞本次 save。
static func _save_atomic(res, full_path: String) -> int:
	var ext := full_path.get_extension()  # tres/res/tscn
	var tmp := full_path + ".tmp." + ext
	# 写前清同路径旧 tmp(防上次同路径 crash 残留阻塞本次 save)
	if FileAccess.file_exists(tmp):
		DirAccess.remove_absolute(tmp)
	var save_err: int = ResourceSaver.save(res, tmp)
	if save_err != OK:
		DirAccess.remove_absolute(tmp)  # save 失败清半截 tmp
		return save_err
	var rename_err: int = DirAccess.rename_absolute(tmp, full_path)
	if rename_err != OK:
		DirAccess.remove_absolute(tmp)  # rename 失败清 tmp
		return rename_err
	return OK


## Parse a Vector3 from JSON/array sources. T5: shared vec3 parser for asset_placer
## (replaces per-file _vec3 copies from asset-forge). Accepts Array or PackedFloat64Array
## of length >= 3; any other type or short array returns Vector3.ZERO (defensive).
static func parse_vec3(v: Variant) -> Vector3:
	if v is Array:
		var a: Array = v as Array
		if a.size() >= 3:
			# I-1(2026-09-17 审查批4): 分量经 _comp_white 白名单——毒分量({}/非法串)裸 float()
			# 即 "Invalid type" SCRIPT ERROR;守卫后毒/缺分量按 0.0 处理(对齐短数组 Vector3.ZERO 语义)。
			return Vector3(
				num_guarded(_comp_white(a, 0), 0.0),
				num_guarded(_comp_white(a, 1), 0.0),
				num_guarded(_comp_white(a, 2), 0.0))
		return Vector3.ZERO
	if v is PackedFloat64Array:
		var p: PackedFloat64Array = v as PackedFloat64Array
		if p.size() >= 3:
			return Vector3(p[0], p[1], p[2])
		return Vector3.ZERO
	return Vector3.ZERO


## Coerce MCP JSON Array values to Godot math types matching the target property.
## Godot's Object.set() does NOT auto-convert Array to Vector3 etc (Godot 4.7
## verified: set("position", [0,0,-6]) is a silent no-op). Mirrors the parse_vec3
## path that asset_placer uses for create/batch position. Returns val unchanged
## when no coercion applies so non-math properties fall through to type_ok / Godot.
## Fixes instance_scene properties.position / set_instance_property Vector3 set
## (asset create/batch already worked via parse_vec3; scene tools did not).
## H-1(2026-09-17 审查第三副本收口, fix round 1): Array 分量经 _comp_white 类型白名单——
## 毒分量({}/非法串)裸 float()/int() = "Nonexistent constructor" SCRIPT ERROR(editor 常驻
## 进程不挂死,但中断后落 return val → node.set(Array) 静默 no-op 假成功)。守卫后毒/缺
## 分量返 null,调用方(coerce_property_value / ui theme)报错或点名跳过,不再静默。
## 短数组行为随此对齐两副本:分量缺失返 null(旧透传原 Array → set no-op 假成功)。
static func coerce_value_for_property(obj: Object, prop_name: String, val: Variant) -> Variant:
	if val is Array:
		var current = obj.get(prop_name)
		if current != null:
			var a: Array = val
			match typeof(current):
				TYPE_VECTOR2:
					var x: Variant = _comp_white(a, 0)
					var y: Variant = _comp_white(a, 1)
					if x != null and y != null:
						return Vector2(float(x), float(y))
					return null
				TYPE_VECTOR2I:
					var xi: Variant = _comp_white(a, 0)
					var yi: Variant = _comp_white(a, 1)
					if xi != null and yi != null:
						return Vector2i(int(xi), int(yi))
					return null
				TYPE_VECTOR3:
					var x3: Variant = _comp_white(a, 0)
					var y3: Variant = _comp_white(a, 1)
					var z3: Variant = _comp_white(a, 2)
					if x3 != null and y3 != null and z3 != null:
						return Vector3(float(x3), float(y3), float(z3))
					return null
				TYPE_VECTOR3I:
					var x3i: Variant = _comp_white(a, 0)
					var y3i: Variant = _comp_white(a, 1)
					var z3i: Variant = _comp_white(a, 2)
					if x3i != null and y3i != null and z3i != null:
						return Vector3i(int(x3i), int(y3i), int(z3i))
					return null
				TYPE_VECTOR4:
					var x4: Variant = _comp_white(a, 0)
					var y4: Variant = _comp_white(a, 1)
					var z4: Variant = _comp_white(a, 2)
					var w4: Variant = _comp_white(a, 3)
					if x4 != null and y4 != null and z4 != null and w4 != null:
						return Vector4(float(x4), float(y4), float(z4), float(w4))
					return null
				TYPE_COLOR:
					# alpha 分量毒/缺 → 默认 1.0(对齐 headless _coerce_math_value Color 分支宽松语义)
					var cr: Variant = _comp_white(a, 0)
					var cg: Variant = _comp_white(a, 1)
					var cb: Variant = _comp_white(a, 2)
					if cr != null and cg != null and cb != null:
						var ca: Variant = _comp_white(a, 3)
						return Color(float(cr), float(cg), float(cb), float(ca) if ca != null else 1.0)
					return null
				TYPE_PLANE:
					var px: Variant = _comp_white(a, 0)
					var py: Variant = _comp_white(a, 1)
					var pz: Variant = _comp_white(a, 2)
					var pw: Variant = _comp_white(a, 3)
					if px != null and py != null and pz != null and pw != null:
						return Plane(float(px), float(py), float(pz), float(pw))
					return null
				TYPE_QUATERNION:
					var qx: Variant = _comp_white(a, 0)
					var qy: Variant = _comp_white(a, 1)
					var qz: Variant = _comp_white(a, 2)
					var qw: Variant = _comp_white(a, 3)
					if qx != null and qy != null and qz != null and qw != null:
						return Quaternion(float(qx), float(qy), float(qz), float(qw))
					return null
	return val


## H-1(2026-09-17 审查): Array 分量类型白名单——仅 int/float/合法数字串放行,其余返 null。
## Keep in sync(三副本分量白名单): src/scripts/godot_operations.gd _math_comp(headless)+
## src/scripts/mcp_bridge.gd _math_comp(bridge)——本文件是 editor 异构形态的第三副本
## (coerce_value_for_property 按 typeof(current) 分派,只收 Array 输入)。
static func _comp_white(a: Array, index: int) -> Variant:
	if index < a.size():
		var out: Variant = a[index]
		if out is int or out is float or (out is String and String(out).is_valid_float()):
			return out
	return null


## I-1(2026-09-17 审查批4,批1 终审范围增补): editor 命令族数值参数守卫——毒参数
## (null/容器/非法串)裸 float()/int() = "Invalid type" SCRIPT ERROR(editor 常驻不挂死,
## 但中断命令处理且错误不回显)。仅 int/float/合法数字串放行,其余回 fallback。
## Keep in sync(数值守卫两副本): src/scripts/mcp_bridge.gd _num/_int_guarded(bridge)+ 本文件
## (editor,public 形态跨文件 CommandHelpers. 前缀调用)。headless(godot_operations.gd)
## 无数值守卫副本——其命令走 TS 工具层前置校验(如 navigation.ts validateVector3),且
## headless 进程一次性不常驻;其分量层白名单是 _math_comp(与 _comp_white 同族,另册同步)。
static func num_guarded(v: Variant, fallback: float) -> float:
	if v is int or v is float:
		return float(v)
	if v is String and String(v).is_valid_float():
		return float(v)
	return fallback


static func int_guarded(v: Variant, fallback: int) -> int:
	if v is int:
		return v
	if v is float and is_finite(v) and v == floor(v):
		return int(v)
	if v is String and String(v).is_valid_int():
		return int(v)
	return fallback


## C12: 查属性的 PROPERTY_USAGE_* flag（via get_property_list）。
## 用于 edit_node / set_instance_property 判断属性是否只读。
## 只读属性 undo 回放 set(prop, null) 会错误赋值（node.get 对不存在/只读属性返当前值或 null），
## 故调用方据返回值跳过只读属性的 undo。找不到属性返 null（调用方决定处理）。
static func _get_property_usage(obj: Object, prop: String) -> Variant:
	for p in obj.get_property_list():
		if String(p.get("name", "")) == prop:
			return p.get("usage", 0)
	return null


## C9: 类型感知相等比较（test_assert property_equals 用）。
## 旧实现在 test_commands.gd 用 str(val) == str(expected)，对常见场景永真返回 false：
## - str(Vector3(1,2,3)) != str([1,2,3])：节点属性 vs JSON Array 表达
## - str(true) != str(1)：bool vs int（语义应不等，但应可控而非 str 偶然）
## 本 helper 显式分流：同类型直接 ==；Array↔数学类型分量比；int/float 数字宽松；其余 str fallback。
## bool↔int 由 typeof 严格分离（TYPE_BOOL ≠ TYPE_INT）落入 str fallback，str(True)!=str(1) 返回 false（语义正确）。
static func values_equal(val, expected) -> bool:
	# 同类型直接 ==（含 bool==bool / int==int / Vector3==Vector3 / Array==Array 元素比）
	if typeof(val) == typeof(expected):
		return val == expected
	# Array ↔ 数学类型：JSON 端常用 Array 表达 Vector/Color，分量逐一比
	if expected is Array:
		if val is Vector2:
			return expected.size() == 2 and float(expected[0]) == val.x and float(expected[1]) == val.y
		if val is Vector3:
			return expected.size() == 3 and float(expected[0]) == val.x and float(expected[1]) == val.y and float(expected[2]) == val.z
		if val is Vector4:
			return expected.size() == 4 and float(expected[0]) == val.x and float(expected[1]) == val.y and float(expected[2]) == val.z and float(expected[3]) == val.w
		if val is Color:
			return expected.size() == 4 and float(expected[0]) == val.r and float(expected[1]) == val.g and float(expected[2]) == val.b and float(expected[3]) == val.a
		return false
	# int↔float 数字宽松（GDScript == 本就宽松，这里显式表达意图）
	if typeof(val) == TYPE_INT and typeof(expected) == TYPE_FLOAT:
		return float(val) == float(expected)
	if typeof(val) == TYPE_FLOAT and typeof(expected) == TYPE_INT:
		return float(val) == float(expected)
	# 其余异类型（bool↔int / Vector3↔Dictionary / String↔int ...）退回字符串比较
	return str(val) == str(expected)


## editor 侧 BLOCKED_PROPERTIES —— 对齐 headless godot_operations.gd BLOCKED_PROPERTIES + TS BLOCKED_PROPS。
## instance 额外在 coerce_property_value 内双保险拒绝（I-2: 可注入 ExtResource 实例化恶意场景 _ready）。
const BLOCKED_PROPERTIES := [
	"script", "owner", "process_mode", "process_priority", "process_input",
	"process_unhandled_input", "process_unhandled_key_input", "process_internal",
	"physics_process_mode", "physics_interpolation_mode", "name", "meta",
	"input_event", "ready", "tree_entered", "tree_exited", "tree_exiting",
	"instance",  # I-2: instance 可注入 ExtResource 实例化恶意场景 _ready，与 script 同级危险
]


## 统一 property coerce（editor 侧）。关键不对称：只 coerce 不 set（返 {"ok","value","error"}），
## set 由 handler 经 undo 系统 do_op 执行——editor 要 per-property undo（do=set new / undo=set old），
## helper 内置 set 会与 do_op 重复执行。与 headless _set_property_with_coerce（godot_operations.gd，
## 内置 set 因 headless 无 per-property undo、走整场景 pack+save）刻意不对称。靠 defects.ts 双向 detect 防漂移。
static func coerce_property_value(obj: Object, prop: String, val: Variant) -> Dictionary:
	# 1. BLOCKED 过滤 + instance 双保险（即使漏加 BLOCKED_PROPERTIES 也拒）
	if prop in BLOCKED_PROPERTIES or prop == "instance":
		return {"ok": false, "value": null, "error": "Blocked property: %s" % prop}
	# 2. 属性存在性 + 取声明类型
	var prop_type := -1
	for p in obj.get_property_list():
		if String(p.get("name", "")) == prop:
			prop_type = int(p.get("type", TYPE_NIL))
			break
	if prop_type == -1:
		return {"ok": false, "value": null, "error": "Property not found: %s on %s" % [prop, obj.get_class()]}
	# 3. 类型分支（严格对齐 headless _set_property_with_coerce 语义，消除 editor/headless 撕裂）
	var coerced: Variant = val
	if prop_type == TYPE_OBJECT:
		if val is String and val.begins_with("res://"):
			if has_path_traversal(val):
				return {"ok": false, "value": null, "error": "Path traversal blocked: %s" % val}
			coerced = load(val)
			if coerced == null:
				return {"ok": false, "value": null, "error": "Failed to load resource: %s" % val}
		elif val is String:
			# Resource 属性传非 res:// String → 非静默拒绝（对齐 headless，修 batch silently fail 同根因）
			return {"ok": false, "value": null, "error": "Property %s expects Resource, got plain String '%s' (use res:// path)" % [prop, val]}
		# val 非 String → 透传（JSON 无法表达 Resource 实例，交 Godot set 处理，与 headless 一致）
	else:
		# 非 TYPE_OBJECT：Array 走数学类型 coerce（Vector2/3/Color...），非 Array 透传
		coerced = coerce_value_for_property(obj, prop, val)
		# H-1 fix round 1: 毒/缺分量 → null(守卫拒绝,仅 Array 输入可能),报可读错误——
		# 文案对齐 headless _set_property_with_coerce 的 cannot coerce(三副本行为对齐,
		# 不再中断兜底/透传原 Array → undo do_op set 静默 no-op 假成功)
		if coerced == null and val is Array:
			return {"ok": false, "value": null, "error": "Property %s: cannot coerce %s (missing/null/blocked component)" % [prop, val]}
	return {"ok": true, "value": coerced, "error": ""}


## F2(2026-07-29): property op undo 记录 helper（对齐 particle_commands.gd:19，抽到共享层供 nav/ui 复用）。
## do=set new_val / undo=set old=target.get(prop)。append 进 do_ops/undo_ops，由 create_action_mixed commit。
static func _record_prop(do_ops: Array, undo_ops: Array, target: Object, prop: String, new_val) -> void:
	undo_ops.append({"type": "property", "target": target, "property": prop, "value": target.get(prop)})
	do_ops.append({"type": "property", "target": target, "property": prop, "value": new_val})


# ─── CMP-16-A (2026-08-08): param docs metadata(对标竞品 regiellis base_command.gd doc_param) ────
#
# 每个 command module 实现 get_command_docs() -> Dictionary 返回 {method_name: {description, params}}。
# command_handler.gd 的 list_param_docs 聚合所有 module 的 docs,供 TS 侧 live schema 构建拉取。
# 用显式 metadata 而非 docstring 解析(GDScript 不能反射函数签名,docstring 解析脆弱)。

## 构建单个 param 的 docs 条目。对标竞品 base_command.gd doc_param。
## type 用 Godot 类型名(String/int/float/bool/Vector3/Array/Dictionary/NodePath/Object/JSON 等)。
static func doc_param(pname: String, ptype: String, required: bool, desc: String) -> Dictionary:
	return {"name": pname, "type": ptype, "required": required, "desc": desc}


## Godot 类型名 → JSON schema type(对标竞品 jsonSchemaType)。
## String/NodePath/Vector2/3/Color → "string"(以 literal 字符串传,addon 侧 coerce)。
## JSON/未知/Variant/Object → ""(schema 省略 type,等价 any)。
static func godot_type_to_schema_type(t: String) -> String:
	match t:
		"String", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", \
		"Color", "Rect2", "Rect2i", "Plane", "Quaternion", "Basis", "Transform2D", "Transform3D":
			return "string"
		"int": return "integer"
		"float": return "number"
		"bool": return "boolean"
		"Array": return "array"
		"Dictionary", "Object": return "object"
		_: return ""  # JSON/未知/Variant → 省略 type(any)

