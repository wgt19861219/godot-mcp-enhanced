# Godot MCP Enhanced

> 免费 · 开源 · 全功能 —— 截至 2026-06-27 调研,Godot MCP 赛道里
> 罕见「免费 + 开源 + 128+ 工具」的方案。

给 AI(Claude Code、Cursor 等 MCP 客户端)一个能真正读、写、跑、验证 Godot 项目的
工具层:128+ 工具覆盖场景/脚本/UI/动画/物理/粒子/导航/音频/测试/导出,三层架构
(headless + editor + game bridge)+ 路径白名单 / 注入防御 / sandbox 安全体系。

**[English](README.en.md)** · 工具描述为简体中文,服务中文 Godot 开发者社区;欢迎 i18n PR。

## 与同类方案对比

> **本项目不追求"工具数量第一"。** 赛道里,godot-mcp-pro 有 175 个工具但闭源收 $15;
> 免费的 Coding-Solo 仅 13 个。真正稀缺的是「免费 + 开源 + 全功能 + 安全」的组合。
> 数据截至 2026-06-27(stars / 工具数 / 价格均可能变化,详见各项目仓库)。

| 维度 | **本项目** | godot-mcp-pro | GDAI MCP | Coding-Solo/godot-mcp |
|---|:---:|:---:|:---:|:---:|
| 价格 | **免费** | $15 买断 [^p1] | $19 买断 [^p2] | 免费 [^p3] |
| 开源 | **✅ MIT** | ❌ server 预编译闭源 [^p1] | ❌ [^p2] | ✅ [^p3] |
| 工具数 | 128+ | 175 [^p1] | ~30 [^p1] | 13 [^p1] |
| 安全特性 | **✅ 路径白名单 / 注入防御 / sandbox / 确认令牌 / 输出防伪** | — | — | — |
| 架构 | **三层 headless + editor + bridge** | 单 editor WS [^p1] | stdio [^p1] | headless CLI [^p1] |
| Godot 4.5–4.7 兼容矩阵 | **✅** | — | — | — |
| 中文工具描述 | **✅** | — | — | ❌ |

[^p1]: https://github.com/youichi-uda/godot-mcp-pro README(含其自带竞品对比表),抓取 2026-06-27
[^p2]: GDAI MCP,数据转引自 godot-mcp-pro 对比表,2026-06-27
[^p3]: https://github.com/Coding-Solo/godot-mcp,抓取 2026-06-27

_"—" 表示该项目公开 README 未披露相应能力,不代表必然缺失;欢迎 PR 修正。_

## 安全体系

截至 2026-06-27 调研,Godot MCP 赛道内少见提供系统化安全特性的方案。本项目内置多层防护,
适合对可信边界有要求的开发场景:

- **路径访问控制** — `ALLOWED_PROJECT_PATHS` 白名单(deny-by-default),防 junction / 符号链接绕过
- **GDScript 注入防御** — 危险 API 模式扫描 + 字符串拼接绕过检测
- **危险操作确认令牌** — 删节点等操作需显式确认
- **输出标记防伪造** — 每次执行随机标记,防 GDScript 伪造 MCP 输出
- **本地运行** — 无远程暴露,无第三方数据上传

<details>
<summary><b>⚠️ 诚实的边界(展开必读)</b></summary>

以上是**防误操作层**,不是不可绕过的安全边界。GDScript 拥有完整系统访问权限,
沙箱可被间接方式绕过(`call()` 动态分派、多步变量构造 API 名等)。

- 需真正隔离:容器 / VM + `GODOT_MCP_ALLOW_UNSAFE=false`
- 关闭扫描:`GODOT_MCP_SANDBOX=disabled`(仅开发)
- 本工具**仅限本地可信环境**,不提供远程认证或加密

</details>

## 核心能力

### 三层架构 — 静态编辑 / 实时调试 / 运行时验证

不是单一连接,而是按场景分工的三层(自动检测,互不冲突):

| 层 | 连接方式 | 适用场景 |
|---|---|---|
| **Headless CLI** | 独立 Godot 进程 | 文件读写、批量创建、一次性验证(默认) |
| **Editor WebSocket** | 连接运行中的编辑器 | 实时操作当前场景、Undo、场景树同步 |
| **Game Bridge** | TCP 连接运行中的游戏 | E2E 测试、运行时调试、输入模拟、状态验证 |

### 动态 GDScript 执行

`execute_gdscript` 让 AI 在 headless 模式执行任意 GDScript:代码片段模式(自动包装 `extends SceneTree`)、结构化输出(`_mcp_output`)、超时控制、Autoload 上下文(`load_autoloads=true`)、结构化错误(类型/文件/行号/修复建议)。

### AI 开发闭环 — 不只是工具堆砌

```
read_scene / read_script → 理解结构 → write_script / edit_script
→ run_and_verify(错误分析)→ validate_scripts → verify_delivery(交付门禁)
```

- **`verify_delivery`** — 端到端交付门禁:场景树完整性 + 脚本健康 + 性能 + 自定义断言
- **`validate_scripts`** — 触发 Godot 完整编译(含跨文件依赖),捕获 headless 遗漏的 Parse Error
- **`dev_loop`** — 执行 → 验证 → 截图一体化,支持 acceptance 验收标准

闭环示例:AI 用 `read_scene` 理解 → `write_script` 改 → `run_and_verify(capture_tree=true)` 跑+分析 → `validate_project` 查资源 → `batch_add_nodes` 批建 → `import_resources` 注册 → 有问题回到改脚本。

### 批量操作与资源管理

- **`batch_add_nodes`** — 一次调用添加多个节点,只在最后做一次 pack+save,避免每个节点启停 headless Godot
- **`validate_project`** — 静态扫描缺失资源、无效 `preload()`/`load()` 路径、孤立 `.import` 文件
- **`import_resources`** — 扫描目录批量注册资源(图片/音频/字体/3D 模型),自动生成 `.import`

## 工具一览(128+)

### 执行工具

| 工具 | 说明 |
|------|------|
| `launch_editor` | 启动 Godot 编辑器 GUI |
| `run_project` | 以调试模式运行项目（自动超时） |
| `stop_project` | 停止运行中的项目，返回结构化输出 |
| `get_debug_output` | 获取分类调试输出（错误/警告/打印） |
| `capture_screenshot` | 截取游戏画面（Windows 默认窗口模式，Linux/macOS 自动降级） |
| `analyze_screenshot` | AI 分析截图内容（元素识别、缺陷检测） |
| `run_tests` | 运行 GUT 单元测试并解析结果 |
| `get_godot_version` | 获取 Godot 引擎版本 |

### 验证工具

| 工具 | 说明 |
|------|------|
| `run_and_verify` | 一键 headless 运行并返回结构化错误/警告分析。支持 `capture_tree` 选项同时获取场景树快照。自动检测版本不一致和脚本语法错误。 |
| `analyze_error` | 重新分析 Godot 输出文本，提供修复建议 |
| `validate_scripts` | 对每个脚本执行 Godot `load()` 编译验证（触发完整编译，含跨文件依赖解析），检测 headless 运行可能遗漏的 Parse Error |

### 动态执行工具

| 工具 | 说明 |
|------|------|
| `execute_gdscript` | 在 headless 模式下执行任意 GDScript 代码。支持代码片段模式（自动包装）和完整类模式。设置 `load_autoloads=true` 可在完整 Autoload 上下文中运行（DataRegistry、PlayerData 等）。 |
| `query_scene_tree` | 加载场景并查询运行时节点树，返回解析后的实际属性值。 |
| `inspect_node` | 深度检查节点：所有属性、信号连接、子节点，支持递归深度控制。 |

### 项目工具

| 工具 | 说明 |
|------|------|
| `list_projects` | 搜索目录中的 Godot 项目 |
| `get_project_info` | 项目元数据 + 文件统计 |
| `list_files` | 列出文件（支持扩展名/子目录过滤） |
| `read_project_config` | 解析 project.godot 为结构化 JSON |
| `create_project` | 创建完整 Godot 项目结构 |
| `setup_project_rules` | 一键配置项目规则（hooks + CLAUDE.md），建议首次使用时运行 |
| `validate_project` | 检查缺失资源、无效脚本引用、孤立 .import 文件 |
| `import_resources` | 扫描目录批量生成 .import 文件（图片/音频/字体/3D模型） |

### 场景工具

| 工具 | 说明 |
|------|------|
| `read_scene` | 解析 .tscn 为节点树 JSON，含属性类型解析（ExtResource/Color/Vector2/Vector3/NodePath/数组/字典/数字/字符串） |
| `create_scene` | 创建新场景 |
| `add_node` | 向场景添加节点 |
| `batch_add_nodes` | 一次调用添加多个节点（比重复 `add_node` 快得多） |
| `save_scene` | 保存场景更改 |
| `load_sprite` | 加载纹理到精灵节点 |
| `edit_node` | 编辑节点属性（位置/缩放/旋转/自定义属性） |
| `remove_node` | 从场景移除节点（需确认令牌） |
| `quick_scene` | 快速创建场景 + 可选脚本（一步到位） |
| `instance_scene` | 实例化 .tscn 场景到目标父节点 |
| `detach_instance` | 从场景树分离实例节点 |
| `diff_scenes` | 比较两个 .tscn 场景文件差异 |
| `merge_scene` | .tscn 冲突解决（三方合并，ExtResource/SubResource ID 重映射） |

### 脚本工具

| 工具 | 说明 |
|------|------|
| `read_script` | 读取 .gd/.cs 文件（含元数据） |
| `write_script` | 写入/覆盖 .gd 文件 |
| `edit_script` | 按行范围编辑 .gd 文件。支持 `raw`/`smart` 缩进模式、内容验证、变更前后对比。 |
| `generate_test` | 分析 .gd 文件并生成 GUT 测试脚本 |
| `create_test_scene` | 创建 GUT 测试运行器场景 |
| `project_replace` | 全项目批量搜索替换（CRLF 安全） |

### 运行时操作工具

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。如需持久化场景修改，请使用 `add_node` + `save_scene`。

| 工具 | 说明 |
|------|------|
| `signal_connect` | 连接两个节点的信号。仅影响当前执行上下文。 |
| `signal_disconnect` | 断开信号连接。仅影响当前执行上下文。 |
| `signal_emit` | 发射节点信号，参数仅支持基础类型（string/number/bool/null）。仅影响当前执行上下文。 |
| `signal_list` | 列出节点上可用的信号。 |
| `physics_raycast` | 执行 3D 射线检测，返回碰撞点、法线、碰撞体信息。 |
| `physics_body_info` | 获取物理体的碰撞形状、AABB、碰撞层/掩码信息。 |
| `node_create_3d` | 运行时创建 3D 节点（支持 16 种白名单类型）。headless 创建不持久化。 |
| `nav_query_path` | 查询 3D 导航路径，支持指定 NavigationRegion3D 或自动回退。 |

### 音频播放控制工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `audio_play` | 播放音频资源。支持 AudioStreamPlayer、AudioStreamPlayer2D、AudioStreamPlayer3D 三种节点类型。 |
| `audio_stop` | 停止指定音频播放器的播放。 |
| `audio_set_param` | 设置音频参数：音量 dB、音调缩放、总线路由。 |
| `audio_query` | 查询播放状态（播放中/暂停/停止）、当前播放位置、总线信息。 |
| `diagnose_physics` | 诊断物理体碰撞状态（含 ConcavePolygonShape3D 陷阱检测）。 |
| `query_spatial` | 空间区域查询：碰撞体距离排序，支持碰撞掩码过滤。 |
| `collision_overlay` | 创建碰撞形状彩色线框叠加（StaticBody=蓝/CharacterBody=绿/RigidBody=红/Area=黄）。 |

### TileMap 编辑工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。如需持久化 TileMap 修改，请使用 `execute_gdscript` 写入 .tscn 或在编辑器中操作。同时支持 TileMap（旧版）和 TileMapLayer（Godot 4.3+ 新版）两种节点类型。

| 工具 | 说明 |
|------|------|
| `tilemap_read` | 读取 TileMap/TileMapLayer 的 cell 数据，返回指定区域内的 tile 坐标、source_id、atlas_coords、alternative_tile。 |
| `tilemap_set_cell` | 设置单个 tile 的源图集和坐标。 |
| `tilemap_erase_cell` | 擦除单个 tile（设为空）。 |
| `tilemap_fill_rect` | 批量填充矩形区域内的所有 tile。 |
| `tilemap_clear` | 清空 TileMap/TileMapLayer 的所有 tile。 |
| `tilemap_copy` | 复制指定区域为模板（内部缓存），用于后续粘贴。 |
| `tilemap_paste` | 将已复制的模板粘贴到目标位置。 |
| `tilemap_set_transform` | 设置 tile 的翻转/旋转变换（水平翻转、垂直翻转、Transpose）。 |

所有运行时工具支持可选 `load_autoloads` 参数（默认 `true`），可在完整 Autoload 上下文中执行。

### API 文档工具

| 工具 | 说明 |
|------|------|
| `get_class_info` | 获取类的方法、属性、信号、常量 |
| `search_classes` | 按名称/描述搜索类 |
| `find_method` | 查找方法详情（含继承链） |
| `get_inheritance` | 获取完整继承链 |

### 材质与着色器工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `material_read` | 读取节点材质属性和 shader uniform 列表 |
| `material_write` | 设置材质参数、创建/附加/保存材质（.tres） |
| `shader_edit` | 读写着色器代码、加载 .gdshader、应用模板、编译诊断 |

### Game Bridge 工具

| 工具 | 说明 |
|------|------|
| `game_bridge_install` | 安装 MCP Bridge autoload 到项目（WebSocket 服务端） |
| `game_bridge_uninstall` | 卸载 MCP Bridge autoload |
| `game_query` | 查询运行中游戏状态（场景树/节点属性/性能/视口） |
| `game_input` | 向运行中游戏发送输入事件（键盘/鼠标/文本） |
| `game_wait` | 在 timeout 窗口内轮询等待游戏状态条件（节点出现/属性值变化），支持 `interval_ms` 探测间隔。条件成立立即返回，超时返回 `timed_out` |

### 工作流工具

| 工具 | 说明 |
|------|------|
| `dev_loop` | 开发循环：执行 GDScript → 验证 → 捕获输出，支持 save_state 文件即记忆 |
| `scene_snapshot` | 场景树快照，用于前后对比检测变更 |
| `batch_validate` | 批量验证多个 GDScript 文件 |

### 动画工具（运行时）

| 工具 | 说明 |
|------|------|
| `animation` | 查询、播放、编辑动画。支持 list_players、get_info、get_details、get_keyframes、play、stop、seek、create、delete、update_props、add/remove_track、add/remove/update_keyframe 等子操作 |

### 性能分析工具（运行时）

| 工具 | 说明 |
|------|------|
| `profiler` | 性能分析：快照（FPS/内存/绘制调用/物理统计）、采样分析、活跃进程检测、信号连接审计 |

### 3D 空间工具

| 工具 | 说明 |
|------|------|
| `spatial_info` | 获取 Node3D 空间信息：transform、AABB、bounds、区域查找 |

### 测试与导出工具

| 工具 | 说明 |
|------|------|
| `test_assert` | 断言场景树状态：node_exists、property_equals、signal_connected、node_count |
| `test_stress` | 压力测试：重复创建/销毁节点检测内存泄漏 |
| `export_list_presets` | 列出项目导出预设 |
| `export_get_preset` | 获取导出预设详情 |
| `export_build` | 执行导出构建 |

### 粒子系统工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `particles_create` | 创建 GPU 粒子节点（GPUParticles2D / GPUParticles3D） |
| `particles_set_emission` | 设置发射参数：形状（point/sphere/box/ring）、半径、方向、扩散 |
| `particles_set_process` | 设置处理参数：重力、速度、爆炸性、生命周期、阻尼 |
| `particles_load_preset` | 加载预设效果：fire / smoke / rain / snow / sparkle / explosion |
| `particles_set_material` | 创建或重置 ParticleProcessMaterial |

### 导航工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `nav_create_region` | 创建 NavigationRegion3D 并可选烘焙导航网格 |
| `nav_bake_mesh` | 烘焙导航网格（长时间操作） |
| `nav_create_agent` | 创建 NavigationAgent3D 并设置寻路参数 |
| `nav_set_params` | 设置导航代理参数（10 个可配置字段：radius、height、max_speed 等） |
| `nav_create_link` | 创建 NavigationLink3D 连接点（支持双向） |

### AnimationTree 工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `animtree_create` | 创建 AnimationTree 节点（支持 AnimationNodeStateMachine / BlendTree / BlendSpace2D） |
| `animtree_add_state` | 向状态机添加动画状态（AnimationNodeAnimation） |
| `animtree_add_transition` | 在状态间添加转换（含交叉淡入淡出时间和条件） |
| `animtree_set_blend` | 设置混合参数（float 用于 BlendTree，Vector2 用于 BlendSpace） |
| `animtree_play` | 切换到目标状态（通过 playback.travel） |

### IK 框架工具（运行时）

| 工具 | 说明 |
|------|------|
| `ik_modifier_create` | 创建 IK 修改器节点（TwoBoneIK3D / FABRIK3D / CCDIK3D / SplineIK3D / JacobianIK3D） |
| `ik_modifier_get` | 读取 IK 修改器属性 |
| `ik_modifier_set` | 设置 IK 参数（active、influence、bone_name、target、magnet） |
| `ik_list_bones` | 列出 Skeleton3D 骨骼 |

### 验证交付工具

| 工具 | 说明 |
|------|------|
| `verify_delivery` | 端到端交付验证：场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 标准合规 |

### 游戏设计工具

| 工具 | 说明 |
|------|------|
| `validate_gdd` | 验证游戏设计文档是否符合 8 章节标准（概述、玩家幻想、详细规则、公式、边界情况、依赖、调优旋钮、验收标准） |
| `chain_verify` | Chain-of-Verification 自我质疑引擎：对审查结论生成 5 个挑战性问题，防止盲点和过度自信 |

### 代码模板工具

| 工具 | 说明 |
|------|------|
| `list_templates` | 列出可用代码模板（内置 + 用户自定义） |
| `apply_template` | 应用代码模板到指定脚本（支持变量替换） |

### UI 布局工具（运行时）

| 工具 | 说明 |
|------|------|
| `ui_create_control` | 创建 UI Control 节点 |
| `ui_build_layout` | CSS Flexbox/Grid 翻译层，从声明式布局描述构建 Godot Container 树 |
| `ui_set_layout` | 设置 Control 节点布局属性（锚点/偏移/最小尺寸） |
| `ui_get_layout` | 查询 Control 节点布局信息 |
| `ui_anchor_preset` | 应用锚点预设（full_rect/center/top_wide 等 16 种） |
| `ui_set_theme` | 设置/创建/保存/加载 Theme |
| `ui_container_add` | 向 Container 添加子 Control 节点 |
| `ui_draw_recipe` | 声明式绘图操作（rect/circle/line/arc/polygon/string） |
| `theme_create` | 创建空 Theme 或从节点提取 Theme |
| `theme_set_property` | 设置 Theme 属性（font/color/constant/stylebox） |

### 录制工具

| 工具 | 说明 |
|------|------|
| `recording_start` | 开始录制输入事件（键盘/鼠标） |
| `recording_stop` | 停止录制并返回事件数据 |
| `recording_save` | 保存录制到 JSON 文件 |
| `recording_load` | 加载录制文件 |
| `recording_play` | 回放录制的输入事件 |

### 编辑器同步工具

| 工具 | 说明 |
|------|------|
| `editor_sync_start` | 启动场景树实时监听（推送 node_added/node_removed 事件） |
| `editor_sync_stop` | 停止场景树监听 |

> ⚠️ 运行时工具(物理 / 动画 / UI / 粒子 / TileMap / 材质等)仅在 headless 执行上下文生效,
> **不持久化到 .tscn**;需持久化用 `add_node` + `save_scene`。

## MCP 资源（Resources）

AI 客户端可通过 `godot://` URI 方案发现和读取项目上下文，无需显式工具调用。

### 静态资源

| URI | 说明 |
|-----|------|
| `godot://project/info` | 项目元数据 + 文件统计（JSON） |
| `godot://project/config` | 原始 `project.godot` 文件 |

### 资源模板

| URI 模式 | 说明 |
|----------|------|
| `godot://scene/{path}` | 读取 `.tscn` 场景为节点树摘要 |
| `godot://script/{path}` | 读取 `.gd` 脚本文件 |
| `godot://file/{path}` | 读取项目中任意文本文件 |

### 安全限制

- 路径必须在项目根目录下（禁止 `../` 遍历）
- `.godot/`、`.import/`、`node_modules/` 目录被阻止
- `.import`、`.uid`、`.godot` 文件扩展名被阻止

### 使用示例

```
Client: ListResources → 发现所有场景和脚本
Client: ReadResource("godot://project/info") → 项目配置 + 统计
Client: ReadResource("godot://scene/scenes/main.tscn") → 节点树摘要
Client: ReadResource("godot://script/scripts/player.gd") → GDScript 源码
```

## 快速开始

### 1 分钟配置（推荐）

#### Claude Code — 全局安装（所有 Godot 项目自动可用）

```bash
claude mcp add -s user godot -- npx -y godot-mcp-enhanced
```

> **为什么用 `-s user`？** Godot MCP 是个人开发工具，你会在多个 Godot 项目中使用它。`-s user`（user scope）将配置写入 `~/.claude.json` 顶层，所有项目自动连接，无需每个项目重复安装。详见 [Claude Code MCP 文档](https://code.claude.com/docs/zh-CN/mcp#mcp-installation-scopes)。

如果你只想在当前项目使用（不推荐，切项目会丢失）：

```bash
claude mcp add godot -- npx -y godot-mcp-enhanced  # local scope，仅当前项目
```

#### Cursor / Cline / Windsurf / 其他
在项目的 `.cursor/mcp.json` 或 MCP 配置中添加：

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "godot-mcp-enhanced"]
    }
  }
}
```

#### 腾讯 CodeBuddy（国内用户）
CodeBuddy 文档（2026-06-27 实测）支持外部 stdio MCP Server：**设置 → MCP 标签 → Add MCP**，粘贴与上面相同的 json。也可从其 MCP Market 一键安装（上架后）。
> ⚠️ 端到端接入验证待补：配置方法基于 CodeBuddy MCP 文档，godot-mcp-enhanced 尚未在其内跑通。

### 一键配置
```bash
npx godot-mcp-enhanced setup
# 自动检测：Godot 路径 + AI 客户端 + 写入配置
```

### 首次使用

连接 Godot 项目后，建议立即运行以下工具一键配置项目规则：

```
setup_project_rules(project_path="你的项目路径")
```

这会自动生成：
- **`.claude/settings.json`**：PostToolUse hook，每次编辑 `.gd` 文件后自动提醒 AI 运行 `validate_scripts` 验证语法
- **`CLAUDE.md`**：项目级规则，包含 GDScript 验证规则和发版门禁（`verify_delivery` 检查）

如果已有配置想更新，使用 `force=true` 覆盖。如只需其中一项，用 `hooks=false` 或 `claude_md=false` 跳过。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GODOT_PATH` | Godot 可执行文件路径 | 自动搜索（PATH/注册表/Scoop/Downloads） |
| `GODOT_PROJECT_PATH` | 默认项目路径 | 自动检测 cwd（向上搜索 project.godot） |
| `GODOT_MCP_SEARCH_PATHS` | 额外 Godot 搜索目录（分号分隔） | 无 |
| `DEBUG` | 启用详细日志 | `false` |

> **注意：** 项目路径有 30 秒缓存。切换项目后等待 30 秒或重启 MCP server 使新路径生效。

### 多版本 Godot 支持

如果你使用 [godots](https://github.com/MakovWait/Godots) 等版本管理器管理多个 Godot 版本，可以为每个项目单独指定 Godot 二进制路径。

**优先级**：工具参数 `godot_path` > 项目配置 > `GODOT_PATH` 环境变量 > PATH > 平台搜索

#### 方式一：项目配置文件（推荐）

在项目目录下创建 `.godot/mcp-godot.json`：

```json
{
  "version": 1,
  "godot_path": "/path/to/Godot_v4.6.3-stable_macos.arm64"
}
```

#### 方式二：project.godot 配置段

在 `project.godot` 末尾添加：

```ini
[godot_mcp]
godot_path=/path/to/Godot_v4.6.3-stable_macos.arm64
```

#### 方式三：工具参数

在 MCP 工具调用时传入 `godot_path` 参数（如 `run_project`、`execute_gdscript` 等 10 个核心工具均支持）。

#### 方式四：godots 版本管理器自动检测

在项目根目录创建 `.godot-version` 文件（内容为版本号，如 `4.6.3`），MCP server 会自动在 `~/.godots/versions/` 中查找对应版本。

### 手动配置（高级用户）

<details>
<summary>展开查看手动安装步骤</summary>

```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install && npm run build
```

在 MCP 配置中指向 `build/index.js`，并设置所需环境变量。

</details>

## 致谢

- [godot-mcp](https://github.com/Coding-Solo/godot-mcp) — 原始项目，本项目基于其二次开发（Copyright (c) 2025 Solomon Elias，MIT，见 [LICENSE](LICENSE)）
- [Hastur Operation Plugin](https://github.com/rayxuln/hastur-operation-plugin) — 动态 GDScript 执行和结构化输出的灵感来源
- [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) — 借鉴了以下功能概念：
  - **Hooks + Rules 体系** → `setup_project_rules` 自动生成 `.claude/settings.json`（PostToolUse hook 自动验证 GDScript）和 `CLAUDE.md`（项目编码标准）
  - **Gate-check / verify** → `verify_delivery` 端到端交付验证（场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 合规）
  - **Workflow pipeline** → `dev_loop` 执行→验证→截图一体化工作流，支持 `acceptance` 验收标准和 `save_state` 会话记忆
  - **GDScript Lint** → `validate_scripts` 内置的静态 lint 层（L015 行级扫描 + 字符串/注释过滤，独立于 load() 编译检查），对标 CCGS 的 `validate-commit.sh`
  - **GDD 标准** → `validate_gdd` 8 章节游戏设计文档结构校验，对标 CCGS 的 `design/gdd` 路径规则
  - **Chain-of-Verification** → `chain_verify` 自我质疑引擎，防止审查盲点
  - **代码模板** → `list_templates` / `apply_template` 模板系统，对标 CCGS 的 41 个文档模板

## 系统要求

- Godot Engine 4.x（已测试 4.6+）
- Node.js >= 18
- GUT 插件（用于 `run_tests` 工具）

<details>
<summary><b>截图功能平台说明</b></summary>

`capture_screenshot` 工具根据平台使用不同的渲染策略：

| 平台 | 模式 | 说明 |
|------|------|------|
| **Windows** | 窗口模式（默认） | Headless 模式下 viewport 纹理返回 null，必须使用 GPU 上下文 |
| **Linux** | Headless → 窗口模式降级 | Headless + OpenGL3 取决于 GPU 驱动是否支持 |
| **macOS** | Headless → 窗口模式降级 | 与 Linux 相同 |

内置 `screenshot_capture.gd` 使用 `process_frame` 信号模式和 `call_deferred()` 确保场景加载和帧捕获的可靠性。

> **测试提示：** 仓库的 E2E 测试（`test/e2e-*.test.ts`）依赖真实 Godot 二进制。设置 `GODOT_PATH` 指向本地 Godot 以运行它们；未设置时这些测试被静默跳过（控制台打印 `[E2E-SKIP]` 告警），**CI 默认不验证真实 Godot 集成**——`npm test` 的"全部通过"仅覆盖 TS/GDScript 逻辑，不含真实 Godot 子进程行为。

</details>

## 许可证

[MIT](LICENSE) — 含上游 [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) 版权（Copyright (c) 2025 Solomon Elias）。

## 更新日志

> 完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 日期 | 要点 |
|------|------|------|
| **v0.19.1** | 2026-06-27 | 版本元数据同步(manifest/plugin.cfg/README/使用指南)— 功能无变化,补 v0.19.0 npm 元数据漂移 |
| **v0.19.0** | 2026-06-27 | R2 审查响应链 — editor 4 模块 undo_manager(nav/particle/animtree/ui Ctrl+Z 撤销) + super() IMP-4 + IMP-11 touch 双侧契约 + 安全同源 4 点(UI/audio/instance) + @748 detach 双 parent fix + 阶段1b 守卫,2894 测试 |
| **v0.18.2** | 2026-06-18 | 安全加固 — 沙箱绕过组 + 防御深度 + 注入收敛,2670 测试 |
| **v0.18.1** | 2026-06-14 | 功能验证审查 3 CRITICAL 修复 — parseTscn 属性/头部解析（read_scene 现正确返回结构化属性）+ game_wait 轮询等待（pollWaitCondition），2597 测试 |
| **v0.18.0** | 2026-06-10 | 工具合并（39→27 MCP 工具）+ LEGACY 兼容模式 + manage_tools 迁移 + notifyToolsChanged |
| **v0.17.1** | 2026-06-08 | 五维审查 P0+P1 全量修复 — tscn 死代码删除 527 行 + core/tools 解耦 + animation-ops +38 测试 + EditorExecutor +16 测试 + 安全加固，2252 测试 |
| **v0.17.0** | 2026-06-07 | 审查修复 9 项（4C+5I/A）— tscn 编辑正确性 + 确认令牌截断保护 + 字符串 UID + 安全加固，2023 测试 |
| **v0.16.0** | 2026-05-31 | 审查驱动质量提升 — ToolDispatcher 提取 + 87 次提交 + merge_scene + 项目脚手架 + 智能类型转换 + 1638 测试 |
| **v0.15.1** | 2026-05-27 | Godot 4.6 editor plugin 兼容性修复 |
| **v0.15.0** | 2026-05-27 | 6 代理并行审查（14 CRITICAL 修复）+ deny-by-default 安全 + Bridge 录制 + ESLint + 1509 测试 |
| **v0.14.0** | 2026-05-24 | 7 轴全维度审查（8 CRITICAL 修复）+ IK 框架 MVP + Vitest 迁移 1257 测试 |
| **v0.13.0** | 2026-05-23 | Bridge 安全加固 20 项 + requestId 取模 + CSS Grid + EditorConnection 重连上限 |
| **v0.12.0** | 2026-05-23 | 迭代 URL 解码防路径遍历 + verify_delivery 4 维度验证 + dev_loop acceptance |
| **v0.11.1** | 2026-05-22 | Bridge TCP 绑定 127.0.0.1 + 密钥文件读后即删 + opsErrorResult isError 修复 |
| **v0.11.0** | 2026-05-22 | CSS Flexbox 布局翻译层 + GDScript Lint 规则引擎 + 路径遍历防护增强 |
| **v0.10.1** | 2026-05-21 | Bridge TCP 绑定本地地址 + 密钥文件生命周期管理 + opsErrorResult 修复 |
| **v0.10.0** | 2026-05-19 | 场景实例化 + 编辑器实时同步 + 代码优化重构（124 工具） |
| **v0.9.0** | 2026-05-16 | 批量工具 + UI 工具 + 录制系统 + 确认令牌 + Read-Only/Lite 模式（118 工具） |
| **v0.8.0** | 2026-05-13 | 双模式架构 + 测试框架 + 粒子/导航/AnimationTree（96 工具） |
| **v0.7.0** | 2026-05-08 | 安全加固 + 输入转义 + 类型安全 + tscn-parser 修复 |
| **v0.6.0** | 2026-05-03 | 音频播放控制 4 工具 + TileMap 编辑 8 工具 |
| **v0.5.0** | 2026-05-02 | 信号控制 + 物理查询 + 3D 创建 + 导航寻路（8 工具） |
| **v0.4.0** | 2026-05-01 | 版本检测 + validate_scripts + search_and_replace + 截图稳定性 |
| **v0.3.0** | — | edit_script + batch_add_nodes + validate_project + import_resources |
| **v0.2.0** | — | read_scene + read/write_script + query_scene_tree + MCP Resources |
| **v0.1.0** | — | 项目管理 + 场景操作 + 执行控制 + 截图 + execute_gdscript |
