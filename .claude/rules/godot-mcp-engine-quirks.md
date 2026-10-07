---
description: "godot-mcp 引擎陷阱 物理查询 碰撞体 ConcavePolygonShape3D CollisionLayer Mask ArrayMesh GenerateNormals GLB headless RID leak _Ready Free QueueFree Camera2D screenshot 截图 导航 bake shader compile_success MaterialOverride MultiMesh modulate self_modulate 级联 Label 垂直对齐 vertical_alignment 行高钳制 minimum_size ProgressBar 最小高 原型还原 EditorInterface parse-safe singleton get_editor_interface 版本兼容 4.7"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.19+

## 定位

这是 **Godot 引擎行为知识库**——不是工具调用指南（见 core/editor/bridge 等），不是语言教程。使用 MCP 工具操作 Godot 时会遇到这些**隐蔽的引擎陷阱**：多数无错误、无警告，静默失败，靠经验规避。按工具场景分组。

来源：吸收自 godogen（`D:\GitHub\godogen\godot\skills\godogen\quirks.md`）的引擎级、语言无关陷阱，剔除 C# 专属项（SetScript dispose / partial class / SceneBuilderBase 等），保留 GDScript 项目同样会踩的引擎行为。★ 标记对 MCP 工具直接相关、最易踩的重点。

## 截图与捕获（screenshot / execute_gdscript 捕获脚本）

- **★ `--write-movie` 第一帧在 `_Process()` 前渲染**：捕获序列的 frame 0 可能在 `_Process` 首次执行前生成。camera 若在 `_Process` 定位，frame 0 是 junk 帧。在 `_Initialize()` 用 `Position`/`RotationDegrees` 预置 camera（**勿用 `LookAt`**——节点未入树，空间方法失效）。关联：screenshot(capture)、execute_gdscript SceneTree 捕获脚本。
- **静态/动态场景的 fps 选择**：静态（UI/装饰/地形）`--fixed-fps 1`；动态（物理/移动/玩法）`--fixed-fps 10+`。低 FPS 使 `delta` 过大，引发物理 tunneling 和 erratic 行为。关联：screenshot(capture)。
- **★ 帧哈希全部相同 = 捕获接错**：若序列所有帧哈希一致，不要认定捕获成功——通常是 camera/time stepping/scripted input 接错。这是 frame-verify 的核心反作弊判据之一。关联：screenshot(capture)、frame-verify。

## 物理查询（physics / scene 碰撞体）

- **★ RayCast3D 不可靠检测 ConcavePolygonShape3D**：`RayCast3D` / `PhysicsRayQueryParameters3D` 对 `ConcavePolygonShape3D` 碰撞检测不可靠。用 `PhysicsShapeQueryParameters3D`（shape cast）或直接查 mesh 几何（SurfaceTool closest-point）做 trimesh 地形的落地/表面检测。关联：physics(raycast)——raycast 工具对 trimesh 地形会漏检。
- **ConcavePolygonShape3D 需顺时针 winding（Jolt）**：逆时针三角面产生朝下法线——物体从上方穿透，从下方碰撞。用平面 quad 测试：RigidBody 穿透则反转三角形索引顺序。关联：scene 创建碰撞形状、physics(body_info)。
- **BoxShape3D 在 trimesh 上卡边**：在 ConcavePolygon/trimesh 表面滑动的对象（载具/滚动体）用 `BoxShape3D` 会卡碰撞边（Godot/Jolt bug），改用 `CapsuleShape3D`。关联：scene 物理体。
- **★ CollisionLayer/Mask 是 bitmask 非 UI index**：`CollisionLayer`/`CollisionMask` 在代码里是 bitmask，不是编辑器 UI 层号。UI Layer 1=bitmask 1, Layer 2=2, Layer 3=4, Layer 4=8（2 的幂）。`CollisionLayer=4` 是 UI Layer 3，**不是 Layer 4**。关联：scene/edit_node 设碰撞属性、physics。
- **★ 默认 CollisionMask=1 漏非默认层**：新碰撞体默认 `CollisionMask=1`，若地形/墙用 layer 2+，玩家穿透**且无错误**。务必显式设 mask 覆盖所有该碰的层。关联：scene 物理体。

## 场景与资源导入（scene / edit_node / import_resources）

- **★ `.gdignore` 静默阻止整个目录导入**：任何目录放 `.gdignore` 会让 Godot importer **完全跳过**它。绝不在 `assets/` 放——只有 `screenshots/` 等捕获目录该放。纹理不导入时先查散落的 `.gdignore`。关联：import_resources、scene 加载纹理、screenshot。
- **★ ArrayMesh.GenerateNormals() 是阴影必需**：程序化 mesh（SurfaceTool/raw ArrayMesh）不调 `GenerateNormals()` 则不接收阴影——**无错误、无警告，阴影就是不出现**。手动算的法线（即使视觉正确）也可能破坏阴影接收，始终用 `GenerateNormals()`。关联：execute_gdscript 程序化 mesh、screenshot 查阴影。
- **GLB MaterialOverride 不序列化进 .tscn**：GLB 内部 MeshInstance3D 的 MaterialOverride 不持久化（owner 设置跳过有 `SceneFilePath` 的子节点）。需程序化 ArrayMesh 才能自定义材质。关联：scene/edit_node 改 GLB 材质。
- **MultiMeshInstance3D + GLB pack 后不渲染**：mesh 资源引用在 pack+save 序列化时丢失。用独立 GLB 实例替代。关联：scene 实例化、save_scene。

## Headless 执行（execute_gdscript / run_and_verify）

- **★ headless RID leak errors 无害**：headless 场景构建/退出总产生 `leaked RID`/`Leaked instance`/`ObjectDB instances` 错误，**无害，忽略**。run_and_verify 分析错误时不应把这些当真错误误报。关联：run_and_verify、execute_gdscript。
- **`_Ready()` 在 `--script` 的 `_Initialize()` 不触发**：`godot --script` 运行 SceneTree 脚本时，实例化场景节点的 `_Ready()` 在 `_Initialize()` 期间不触发，须 `Root.AddChild(node)` 后手动调 init 方法。关联：execute_gdscript 完整类模式。
- **`Free()` vs `QueueFree()`**：`QueueFree()` 把节点留到帧末才移除，阻塞 name 重用；测试脚本里立即替换场景用 `Free()`。关联：execute_gdscript 测试脚本。
- **★ `execute_gdscript --script` 不认 GutTest → 用 `run_tests`**：headless CLI `godot --script` 要求脚本 `extends SceneTree`/`MainLoop`，直接跑 `extends GutTest`（Node 子类）的 GUT 测试脚本必失败，弹窗 "Can't load the script ... as it doesn't inherit from SceneTree or MainLoop"。跑 GUT 单元测试用 `runtime` 工具的 `run_tests` action——它封装 `godot --headless --script addons/gut/gut_cmdln.gd -gdir=<test_script> -gquit`（`test_script` 默认 `res://test/`、须 `res://` 前缀，I-SEC-08 防目录穿越，自动解析 Tests/Failed 计数，120s 超时）。前提：项目装了 GUT addon（`addons/gut/gut_cmdln.gd`）。关联：execute_gdscript、runtime(run_tests)。
- **★ `check:gdscript` 编译层抓不到运行时类型错（2026-09-03 审查 I-F）**：`--import`/`load()` 编译只验证语法与静态类型——`var x: Array = params.get(...)`（Variant 赋给类型化变量）**编译通过**，运行时接 Dictionary/嵌套容器/null 直接 SCRIPT ERROR。这是 send_drag 崩溃事故与 `_vec2_from_param` 元素级缺陷的共同盲区：「编译过 = 安全」是误判。真机行为锚定走 GODOT_PATH 门控 e2e（`test/scene-gd-operations-e2e.test.ts` 的 skipIf 模式，单例秒级）。另真机实证（4.7）：`float(null)`/`float([1,2])`/`float({"x":1})` 均运行时崩（"float() 对 null 安全"是错误结论）；MCP 输入是任意嵌套 JSON，数值参数须白名单守卫（`_num()` 先例，对齐 `_is_valid_touch_index`）。关联：game_input 输入归一、bridge 同步分发（无异常隔离，一处崩全桥堵死）。

## 输入与相机（game_input / screenshot）

- **Camera2D 无 Current 属性**：设当前用 `MakeCurrent()`，且节点须已在场景树中。关联：scene 加 Camera2D、game_input。
- **Chase camera 每帧重设 Current 覆盖测试 camera**：游戏 camera 在 `_PhysicsProcess` 设 `Current=true` 会每帧覆盖测试/捕获 harness 的 camera。测试 harness 须**每帧禁用游戏 camera**。关联：screenshot 测试、execute_gdscript。
- **相机 Lerp 首帧从原点 swoop**：`_PhysicsProcess` 中 `Lerp` 的相机首帧从 (0,0,0) 飞过来。用 `_initialized` flag 首帧 snap 位置，后续帧再 lerp。关联：screenshot、execute_gdscript。

## 材质与着色器（material / shader_write / shader_apply_template）

- **★ `compile_success` 是假绿（C-BUG-1）**：`shader_write` / `shader_apply_template` 返回的 `compile_success: true` **仅确认 shader 资源已分配（`get_rid().is_valid()`），与代码能否编译无关**——Godot 4.x headless 无可靠 shader 编译验证 API（RenderingServer 不实际编译）。AI 看到 `compile_success: true` 易误判 shader 正确（与 `run_tests` 认知缺口同类假绿）。**必须**经截图或 Godot 错误输出人工确认；返回结构里的 `verification_note` 文本已提示，但勿只看布尔值。关联：material(shader_write/shader_apply_template)。

## 导航（navigation / nav_create_region / nav_query_path）

- **★ `query_path` 静默返回空路径**：无导航数据（未创建 region 或未烘焙）时，`query_path` 返回 `path: []` + `path_length: 0` + `warning: "No navigation data available"`，**不报错**。`create_region` 默认 `bake=false`——忘记单独调 `bake_mesh` 则后续 `query_path` 静默返回空。正确工作流：`create_region` → `bake_mesh`（单独 120s 超时，其他 action 30s）→ `query_path`。看到空 path 先回头确认已 bake。关联：navigation(query_path/create_region/bake_mesh)。

## 节点定位与坐标实测（scene / edit_node / game_query 坐标读取 / UI 布局调试）

- **★ 三种坐标系不可混算**：Sprite2D/Node2D 系的 `position` 是节点原点，Sprite2D 还有 `centered`（true=纹理以 position 为中心绘制，false=从 position 起绘）+ `offset`；Control 系（TextureRect/Button/Panel 等）用 `anchor` + `offset_left/right/top/bottom`，`position` 是相对父节点左上角且受父 Container 布局影响，`global_position` 才是屏幕坐标。纸面推算「Sprite2D 视觉中心」vs「TextureRect anchor 位置」vs「Control global_position」三者极易错，必须读运行时真实值再算。关联：scene/edit_node 设坐标属性、game_query(get_node_properties) 读坐标、UI 布局调试。
- **★ 定位类问题先实测不纸面猜**：调坐标/布局/对齐时第一步用 game bridge 读真实值，不要 headless 截图（空白，见「截图与捕获」段）或纸面推算：(1) `game_query find_nodes` 确认真实节点路径与类型；(2) `game_query get_node_properties` 读 `position`/`global_position`/`size`/`offset_*`；(3) `game_query take_screenshot`（GPU 真渲染）+ 视觉确认实际渲染的是哪个元素；(4) 看到真实数据再改。反例：据「偏右上」反馈想当然以为是 lock 按钮、反复改 4 次无果，game bridge 实测发现根本没 lock、偏的是角标——根因就是没第一时间实测。关联：game_query/find_ui_elements、screenshot（headless 空白）；headless 截图根因见 godot-mcp-core.md「Headless 截图限制」。`get_node_layout` method 一次返全布局（含 `global_position` 成对），优先于手动拼 `get_node_properties` 扁平 dump。
- **Node3D.scale 对部分节点无效**：Node3D.xml 原文 "The behavior of some 3D node types is not affected by this property. These include Light3D, Camera3D, AudioStreamPlayer3D"。`get_node_layout` 照读这些节点的 scale 值，但引擎忽略——AI 勿用 scale 对这几类节点做布局推断。关联：game_query(get_node_layout) Node3D 分支。
- **★ `set_anchors_preset` 不改 offset，`set_anchors_and_offsets_preset` 才改**：`Control.set_anchors_preset(preset, keep_offsets=false)`（Godot 4.7 headless 实测：默认 / 显式 false / 显式 true 三种形式）**只设 anchor 分数，不动 offset_left/right/top/bottom**，`keep_offsets` 参数对 offset 无实际影响。只有 `set_anchors_and_offsets_preset(preset)` 才重算 offset（如 FULL_RECT → offsets 全归 0）。后果：do 用 `set_anchors_preset` 时，undo 只记 4 anchors（property op）即完整还原（offset 没被动过）；若 do 用 `set_anchors_and_offsets_preset`，undo 必须补记 4 offsets。reviewer/code 易误判"set_anchors_preset(keep_offsets=false) 会重算 offset 致 undo 不全"——实测不成立。关联：ui_anchor_preset、game_query Control 布局、D-P2 Task3 final review Important#1（实测推翻）。

## UI 渲染与控件尺寸（ui_import_prototype / ui 布局 / modulate 染色）

- **★ `modulate` 乘性级联影响整个子树，`self_modulate` 只染自身**：`modulate` 与子节点 modulate 相乘作用到所有后代——给布局壳设 `modulate:[1,1,1,0]` 想做"透明占位"会让**整个子树跟着消失**（无错误无警告）。仅染自身用 `self_modulate`；透明布局壳必须 `self_modulate`。`ui_import_prototype` 翻译器对透明壳已固定走 self_modulate（bg 走 StyleBoxFlat 通道，翻译器不再产出 modulate 染色）。关联：ui_import_prototype(bg/透明壳规则)、ui_create_control(properties.modulate)。
- **★ Label 垂直对齐默认 TOP，CSS line-height 居中惯用法失效**：CSS `line-height = height` 的文本垂直居中在 Godot 不成立——Label 默认 `vertical_alignment=0`(TOP)，单行文本会贴顶。需显式 `vertical_alignment=1`(CENTER)。`ui_import_prototype` 翻译器对全部 Label 已固定 `vertical_alignment:1`；手写 properties 时勿漏。关联：ui_build_layout/ui_create_control 文本节点、ui_import_prototype 翻译规则 3。
- **Control 高度被字体最小行高钳制（minimum_size 顶开）**：Label/Button 的 rect.h 小于字体行高时，引擎 `Control.minimum_size` 把高度顶开到行高——**无警告静默变高**，verify 的 `dh` 会暴露（实际比目标高）。文本控件 rect.h 需 ≥ fontSize*1.5，或显式调小字号。`ui_import_prototype` 翻译器对 rect.h < fontSize*1.5 发 warning（"可能被字体最小行高钳制"）。关联：ui_import_prototype 行高预警、ui_measure_layout(layout_verify.diff 的 dh)。
- **★ ProgressBar 默认主题最小高 27px（Godot 4.7，实测）**：默认主题 stylebox 把 ProgressBar 的 `Control.minimum_size` 顶到约 27px——原型 rect.h=16 落地实测 27px（2026-08-16 RTS HUD fixture HpBar 集成验收，dh=+11）。这是主题硬约束非 bug；处置：原型侧把 rect.h 调到 ≥27，或换自定义 Theme stylebox。`ui_import_prototype` 翻译器对 rect.h < 27 发 "will be clamped" warning（具名常量 PROGRESS_BAR_MIN_HEIGHT=27，**无条件**——实测 Godot 4.7.1 h=16：无 override→27、bg-only→23、fill-only→27、bg+fill→23，全组合被钳，override 只改变钳制值不消除钳制）。同类：Button 默认主题也有最小高约束。关联：ui_import_prototype 引擎下限预警、ui_set_theme。

## 多人联机与弱网测试（network_conditioner / ENet peer / 多人 e2e）

- **★ ENetMultiplayerPeer.get_local_port() 在 Windows Godot 4.6.3 阻塞挂死主循环（实测）**：探针二分定位——create_server(0) 返回 OK、set_multiplayer_peer 不挂，**唯独 get_local_port() 调用后进程无响应挂死**（--script 探针与完整游戏均复现，stdout 因挂死未 flush 看似无输出）。多人 e2e fixture 与探针一律**不调 get_local_port()**；需要端口信息的场景改从 create_server 显式传端口 + 自记录。关联：test/fixtures/p3-e2e/main.gd setup_net_peer 注释、network_conditioner e2e。
- **多人 peer 未配置时 get_multiplayer_peer() 返回 OfflineMultiplayerPeer 而非 null**：判断"多人未启用"要同时查 null 与 `is OfflineMultiplayerPeer`（bridge network.set_conditions 的空壳防护即此形态）。
- **弱网注入只作用于出向包**：host 侧装 conditioner = 影响 host 发给所有 client 的包；双向对称弱网需两端各装。无带宽限制；raw socket 不走 MultiplayerPeer 管道（依赖 SceneMultiplayer 高阶 API）。

## 版本兼容与 parse-safe（addons 开发 / EditorInterface / engine API）

- **★ 缺失的 engine class 方法在 parse 期即失败，has_method 守卫救不了**：GDScript 对 `EditorInterface.get_unsaved_scenes()` 这类**直接调用**做静态查找——方法在所用 Godot 构建里不存在时**整个 .gd 文件 parse 失败**（不是运行时才报错），`if EditorInterface.has_method(...)` 守卫写在同一文件里也一起死。新增 4.6+/4.7+ 才有的 API 调用必须改 `Object.call("...")` 字符串形式（parse-safe，运行时才解析）+ `has_method` 守卫做运行时优雅降级（yanhuifair v1.12.3 教训：`EditorInterface.call("get_unsaved_scenes")`）。支持矩阵 4.5–4.7：新增 API 先确认 4.5 已存在。
- **EditorInterface 两种获取路径语义不同**：GDScript 全局名 `EditorInterface.xxx`（类型表达式路径，4.x 全版本可用）≠ `Engine.get_singleton("EditorInterface")`（运行时查找路径，**4.7 起返回 null**——不再注册为 Engine singleton）。插件内获取一律走 `EditorPlugin.get_editor_interface()`（本项目 `_get_ei()` 模式）；两者混用是 4.7 兼容 bug 的常见根源。
- **改 addons 后必须跑 `npm run check:gdscript`（项目级完整编译）**：`validate_scripts` 是逐文件 parse，漏结构性 bug（缩进/块体）；跨版本验证跑双端 `GODOT_PATH=<4.5.x>` 与 `GODOT_PATH=<4.7.x>` 各一次。
