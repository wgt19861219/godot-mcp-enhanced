# custom_meshes.gd
# 5 个手写 ArrayMesh（cone/tube/torus/stairs/fence），全用 SurfaceTool。
# stairs/fence 把多部件烘焙成单 ArrayMesh（A3，防 first-mesh-multi-mesh 复发）。
# 移植自 asset-forge custom_meshes.gd（删 class_name，改 preload 引用；删 make_ramp——方案 A 阻塞）
@tool
extends RefCounted


# --- cone 圆锥 ---
# P1-7：每顶点手设法线，不调 index()/generate_normals()（否则底圆周顶点 v0/v1 被合并 →
# 侧面斜法线与底面 -Y 被 generate_normals 平滑成圆角，重蹈 I-3）。
# 侧面斜法线 = 母线 (r,yb)→(0,yt) 的朝外垂直方向 (cos(a)*h, r, sin(a)*h)/L；apex 奇点用 UP。
static func make_cone(params: Dictionary) -> ArrayMesh:
	var height: float = CommandHelpers.num_guarded(params.get("height"), 1.0)
	var radius: float = CommandHelpers.num_guarded(params.get("radius"), 0.5)
	var segments: int = clampi(CommandHelpers.int_guarded(params.get("segments"), 24), 3, 128)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var yb := -height / 2.0
	var yt := height / 2.0
	var apex := Vector3(0.0, yt, 0.0)
	var cb := Vector3(0.0, yb, 0.0)
	# 母线长（侧面斜法线归一化用；maxf 防退化 height=radius=0 除零）
	var side_len := maxf(sqrt(height * height + radius * radius), 1e-6)
	for i in segments:
		var a0: float = (float(i) / segments) * TAU
		var a1: float = (float(i + 1) / segments) * TAU
		var v0 := Vector3(cos(a0) * radius, yb, sin(a0) * radius)
		var v1 := Vector3(cos(a1) * radius, yb, sin(a1) * radius)
		var n0 := Vector3(cos(a0) * height, radius, sin(a0) * height) / side_len  # v0 侧面斜法线
		var n1 := Vector3(cos(a1) * height, radius, sin(a1) * height) / side_len  # v1 侧面斜法线
		# 侧面三角形（v0,v1,apex）：每顶点手设侧面斜法线（winding 保留，几何朝向不变）
		st.set_normal(n0)
		st.add_vertex(v0)
		st.set_normal(n1)
		st.add_vertex(v1)
		st.set_normal(Vector3.UP)  # apex 奇点（所有侧面平均 → 纯上）
		st.add_vertex(apex)
		# 底面三角形（cb,v1,v0）：全 -Y（winding 不变，几何朝下）
		st.set_normal(Vector3.DOWN)
		st.add_vertex(cb)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(v1)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(v0)
	return st.commit()


# --- tube 空心圆柱 ---
# P1-7：4 面（外侧面/内侧面/顶环/底环）各自手设法线，不调 index()/generate_normals()
# （否则环顶点被合并 → 外侧径向与底环 -Y 等被平滑成圆角，重蹈 I-3）。
static func make_tube(params: Dictionary) -> ArrayMesh:
	var height: float = CommandHelpers.num_guarded(params.get("height"), 1.0)
	var radius: float = CommandHelpers.num_guarded(params.get("radius"), 0.5)
	var thickness: float = CommandHelpers.num_guarded(params.get("thickness"), 0.1)
	var segments: int = clampi(CommandHelpers.int_guarded(params.get("segments"), 24), 3, 128)
	var inner := maxf(radius - thickness, 0.001)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var yb := -height / 2.0
	var yt := height / 2.0
	for i in segments:
		var a0: float = (float(i) / segments) * TAU
		var a1: float = (float(i + 1) / segments) * TAU
		var o0b := Vector3(cos(a0) * radius, yb, sin(a0) * radius)
		var o1b := Vector3(cos(a1) * radius, yb, sin(a1) * radius)
		var o0t := Vector3(cos(a0) * radius, yt, sin(a0) * radius)
		var o1t := Vector3(cos(a1) * radius, yt, sin(a1) * radius)
		var i0b := Vector3(cos(a0) * inner, yb, sin(a0) * inner)
		var i1b := Vector3(cos(a1) * inner, yb, sin(a1) * inner)
		var i0t := Vector3(cos(a0) * inner, yt, sin(a0) * inner)
		var i1t := Vector3(cos(a1) * inner, yt, sin(a1) * inner)
		var no0 := Vector3(cos(a0), 0.0, sin(a0))  # o0 径向朝外
		var no1 := Vector3(cos(a1), 0.0, sin(a1))  # o1 径向朝外
		var ni0 := -no0  # i0 径向朝内
		var ni1 := -no1  # i1 径向朝内
		# 外侧面（o0b,o1b,o0t)+(o1b,o1t,o0t)：径向朝外（winding 保留，几何朝向不变）
		st.set_normal(no0)
		st.add_vertex(o0b)
		st.set_normal(no1)
		st.add_vertex(o1b)
		st.set_normal(no0)
		st.add_vertex(o0t)
		st.set_normal(no1)
		st.add_vertex(o1b)
		st.set_normal(no1)
		st.add_vertex(o1t)
		st.set_normal(no0)
		st.add_vertex(o0t)
		# 内侧面（i0b,i0t,i1b)+(i1b,i0t,i1t)：径向朝内（反向）
		st.set_normal(ni0)
		st.add_vertex(i0b)
		st.set_normal(ni0)
		st.add_vertex(i0t)
		st.set_normal(ni1)
		st.add_vertex(i1b)
		st.set_normal(ni1)
		st.add_vertex(i1b)
		st.set_normal(ni0)
		st.add_vertex(i0t)
		st.set_normal(ni1)
		st.add_vertex(i1t)
		# 顶环（o0t,o1t,i1t)+(o0t,i1t,i0t)：+Y
		st.set_normal(Vector3.UP)
		st.add_vertex(o0t)
		st.set_normal(Vector3.UP)
		st.add_vertex(o1t)
		st.set_normal(Vector3.UP)
		st.add_vertex(i1t)
		st.set_normal(Vector3.UP)
		st.add_vertex(o0t)
		st.set_normal(Vector3.UP)
		st.add_vertex(i1t)
		st.set_normal(Vector3.UP)
		st.add_vertex(i0t)
		# 底环（o0b,i1b,o1b)+(o0b,i0b,i1b)：-Y
		st.set_normal(Vector3.DOWN)
		st.add_vertex(o0b)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(i1b)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(o1b)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(o0b)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(i0b)
		st.set_normal(Vector3.DOWN)
		st.add_vertex(i1b)
	return st.commit()


# --- torus 圆环 ---
static func make_torus(params: Dictionary) -> ArrayMesh:
	var R: float = CommandHelpers.num_guarded(params.get("major_radius"), 0.5)
	var r: float = CommandHelpers.num_guarded(params.get("minor_radius"), 0.2)
	var ms: int = clampi(CommandHelpers.int_guarded(params.get("major_segments"), 32), 3, 128)
	var ns: int = clampi(CommandHelpers.int_guarded(params.get("minor_segments"), 16), 3, 128)
	# F1(2026-07-29): ms/ns 各 ≤128 隐含 ms×ns ≤ 16384，顶点 ≈ 9.8 万 < 20 万上限，无需额外乘积守卫。
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in ms:
		var a0: float = (float(i) / ms) * TAU
		var a1: float = (float(i + 1) / ms) * TAU
		for j in ns:
			var b0: float = (float(j) / ns) * TAU
			var b1: float = (float(j + 1) / ns) * TAU
			var p00 := _torus_vertex(R, r, a0, b0)
			var p01 := _torus_vertex(R, r, a0, b1)
			var p10 := _torus_vertex(R, r, a1, b0)
			var p11 := _torus_vertex(R, r, a1, b1)
			st.add_vertex(p00)
			st.add_vertex(p10)
			st.add_vertex(p01)
			st.add_vertex(p01)
			st.add_vertex(p10)
			st.add_vertex(p11)
	st.index()
	st.generate_normals()
	return st.commit()


static func _torus_vertex(R: float, r: float, a: float, b: float) -> Vector3:
	var ring := Vector3(cos(a) * R, 0.0, sin(a) * R)
	var n := Vector3(cos(a), 0.0, sin(a))
	return ring + n * cos(b) * r + Vector3.UP * sin(b) * r


# --- stairs 楼梯（多台阶 → 单 ArrayMesh，A3）---
static func make_stairs(params: Dictionary) -> ArrayMesh:
	var steps: int = clampi(CommandHelpers.int_guarded(params.get("steps"), 5), 1, 200)
	var sh: float = CommandHelpers.num_guarded(params.get("step_height"), 0.2)
	var sd: float = CommandHelpers.num_guarded(params.get("step_depth"), 0.3)
	var w: float = CommandHelpers.num_guarded(params.get("width"), 1.2)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in steps:
		_add_box(st, Vector3(0.0, (i + 0.5) * sh, (i + 0.5) * sd), Vector3(w, sh, sd))
	# I-3：_add_box 已用 set_normal 设面法线（轴对齐）。不调 index()/generate_normals()：
	# index() 按位置去重会把 box 跨面角点合并 → generate_normals() smooth 平均成对角线（原 bug）。
	return st.commit()


# v5 fence 柱 x 坐标列表（纯函数，可单测）。posts = 满配柱数；
# start_post/end_post=false 时跳过首/末柱。剩余柱仍按 t=i/(posts-1) 取（跳过端点索引，柱间距不变）。
# posts=1 走 t=0.0 特例（避免 posts-1=0 除零），x=-length/2（左端，make_fence 既有行为，v5 保留）。
static func _post_xs(length: float, posts: int, start_post: bool, end_post: bool) -> Array:
	var xs: Array = []
	for i in posts:
		if i == 0 and not start_post:
			continue
		if i == posts - 1 and not end_post:
			continue
		var t: float = 0.0 if posts == 1 else float(i) / float(posts - 1)
		xs.append((t - 0.5) * length)
	return xs


# --- fence 栅栏（柱 + 横档 → 单 ArrayMesh，A3）---
# v5：柱循环改为调 _post_xs 纯函数；start_post/end_post 控制首/末柱（continuous 端柱共享，默认 true 零回归）
static func make_fence(params: Dictionary) -> ArrayMesh:
	var length: float = CommandHelpers.num_guarded(params.get("length"), 3.0)
	var height: float = CommandHelpers.num_guarded(params.get("height"), 1.2)
	var posts: int = clampi(CommandHelpers.int_guarded(params.get("posts"), 4), 1, 200)
	var pr: float = CommandHelpers.num_guarded(params.get("post_radius"), 0.05)
	var rt: float = CommandHelpers.num_guarded(params.get("rail_thickness"), 0.04)
	var start_post: bool = bool(params.get("start_post", true))
	var end_post: bool = bool(params.get("end_post", true))
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var seg := 12
	for x in _post_xs(length, posts, start_post, end_post):
		_add_cylinder(st, Vector3(x, height / 2.0, 0.0), pr, height, seg)
	_add_box(st, Vector3(0.0, height * 0.8, 0.0), Vector3(length, rt, rt))  # 上横档
	_add_box(st, Vector3(0.0, height * 0.3, 0.0), Vector3(length, rt, rt))  # 下横档
	# I-3：_add_cylinder（径向法线，曲面 smooth）+ _add_box（面法线，轴对齐硬边）已各自 set_normal。
	# 不调 index()/generate_normals()：index() 按位置去重会合并 box 跨面角点 → 平滑法线（原 bug）。
	return st.commit()


# 注：原 asset-forge make_ramp（两端独立高度 wedge）未移植——方案 A 阻塞（上游
# ramp-winding-mixed-convention / ramp-height-chord-as-arc 两个 open CRITICAL 待修）。
# ramp 的单件 PrismMesh 路径已在 asset_factory.create_mesh_uncached 就绪，不受影响。


# --- 辅助：box（24 独立顶点 + 面法线，I-3：修 stairs/fence box 法线被平滑）---
# 旧版 8 共享顶点 + index() 按位置去重 → box 角顶点被 3 面共享 → generate_normals() smooth 把法线
# 平均为对角线方向（多分量），光照在面间圆滑过渡，box 看起来像低面数球。
# 新版每面 4 独立顶点带该面法线：index() 按「位置+法线」去重，跨面角点法线不同→不合并→24 顶点独立；
# generate_normals() 依此索引关系重算→每顶点只属同面三角形→法线 = ±X/±Y/±Z 轴对齐（硬边）。
# 顶点顺序与旧版一致（box 几何不变，仅法线从平滑变轴对齐）。
static func _add_box(st: SurfaceTool, center: Vector3, size: Vector3) -> void:
	var hx := size.x / 2.0
	var hy := size.y / 2.0
	var hz := size.z / 2.0
	var c := center
	var v := [
		c + Vector3(-hx, -hy, -hz),
		c + Vector3(hx, -hy, -hz),
		c + Vector3(hx, hy, -hz),
		c + Vector3(-hx, hy, -hz),
		c + Vector3(-hx, -hy, hz),
		c + Vector3(hx, -hy, hz),
		c + Vector3(hx, hy, hz),
		c + Vector3(-hx, hy, hz),
	]
	_add_face(st, v[0], v[1], v[2], v[3], Vector3(0.0, 0.0, -1.0))  # -Z 面
	_add_face(st, v[5], v[4], v[7], v[6], Vector3(0.0, 0.0, 1.0))  # +Z 面
	_add_face(st, v[4], v[0], v[3], v[7], Vector3(-1.0, 0.0, 0.0))  # -X 面
	_add_face(st, v[1], v[5], v[6], v[2], Vector3(1.0, 0.0, 0.0))  # +X 面
	_add_face(st, v[3], v[2], v[6], v[7], Vector3(0.0, 1.0, 0.0))  # +Y 面
	_add_face(st, v[4], v[5], v[1], v[0], Vector3(0.0, -1.0, 0.0))  # -Y 面


# 单面：4 顶点（CCW 从外侧看，法线 n）→ 2 三角形 (a,b,c)+(a,c,d)，每顶点带面法线 set_normal
static func _add_face(
	st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, d: Vector3, n: Vector3
) -> void:
	st.set_normal(n)
	st.add_vertex(a)
	st.add_vertex(b)
	st.add_vertex(c)
	st.set_normal(n)
	st.add_vertex(a)
	st.add_vertex(c)
	st.add_vertex(d)


# --- 辅助：圆柱（侧面 + 顶/底盖）加进 SurfaceTool（栅栏柱用）---
static func _add_cylinder(
	st: SurfaceTool, center: Vector3, radius: float, height: float, segments: int
) -> void:
	# I-3：侧面每顶点 set 径向法线（曲面 smooth）；与 _add_box 面法线各自独立，不依赖 generate_normals
	# P0-1：含顶/底盖 fan——栅栏柱独立站立，无盖则俯视柱顶/仰视柱底穿帮（看到内部/穿透地面）。
	# 盖子叉积朝柱内（与侧面/_add_face 同 winding 约定 → cull 可见），set_normal 朝外（光照）；
	# 不调 index()/generate_normals()（否则盖子与侧面共享环顶点被平滑，重蹈 I-3 覆辙）
	var ct := center + Vector3(0.0, height / 2.0, 0.0)  # 顶盖中心
	var cb := center + Vector3(0.0, -height / 2.0, 0.0)  # 底盖中心
	for i in segments:
		var a0: float = (float(i) / segments) * TAU
		var a1: float = (float(i + 1) / segments) * TAU
		var n0 := Vector3(cos(a0), 0.0, sin(a0))  # a0 角度径向法线
		var n1 := Vector3(cos(a1), 0.0, sin(a1))  # a1 角度径向法线
		var o0b := center + Vector3(cos(a0) * radius, -height / 2.0, sin(a0) * radius)
		var o1b := center + Vector3(cos(a1) * radius, -height / 2.0, sin(a1) * radius)
		var o0t := center + Vector3(cos(a0) * radius, height / 2.0, sin(a0) * radius)
		var o1t := center + Vector3(cos(a1) * radius, height / 2.0, sin(a1) * radius)
		st.set_normal(n0)
		st.add_vertex(o0b)
		st.set_normal(n1)
		st.add_vertex(o1b)
		st.set_normal(n0)
		st.add_vertex(o0t)
		st.set_normal(n1)
		st.add_vertex(o1b)
		st.set_normal(n1)
		st.add_vertex(o1t)
		st.set_normal(n0)
		st.add_vertex(o0t)
		# P0-1 顶盖 fan（set_normal +Y 朝上；绕序 ct,o0t,o1t 叉积朝柱内 -Y → 从上方俯视可见实心圆面）
		st.set_normal(Vector3.UP)
		st.add_vertex(ct)
		st.add_vertex(o0t)
		st.add_vertex(o1t)
		# P0-1 底盖 fan（set_normal -Y 朝下；绕序 cb,o1b,o0b 叉积朝柱内 +Y → 从下方仰视可见）
		st.set_normal(Vector3.DOWN)
		st.add_vertex(cb)
		st.add_vertex(o1b)
		st.add_vertex(o0b)
