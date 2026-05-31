# Godot MCP Enhanced

增强版 Godot 引擎 MCP 服务器 — 为 **AI 辅助游戏开发闭环** 而设计。

基于 [godot-mcp](https://github.com/Coding-Solo/godot-mcp) 二次开发，填补了关键能力空白：场景读取、脚本读写、截图、测试、**动态 GDScript 执行** 等。

**[English](README.en.md)**

## 与原版 godot-mcp 对比

| 功能 | godot-mcp | godot-mcp-enhanced |
|------|:---------:|:------------------:|
| 启动编辑器 | 支持 | 支持 |
| 运行项目 | 支持 | 支持（+ 自动超时） |
| 获取调试输出 | 支持（原始） | 支持（结构化：错误/警告/打印分类） |
| 停止项目 | 支持 | 支持（+ 摘要） |
| 获取版本 | 支持 | 支持 |
| 列出项目 | 支持 | 支持 |
| 项目信息 | 支持 | 支持（+ 文件统计） |
| 创建场景 | 支持 | 支持 |
| 添加节点 | 支持 | 支持 |
| 加载精灵 | 支持 | 支持 |
| 保存场景 | 支持 | 支持 |
| **读取场景（解析 .tscn）** | **不支持** | **支持** |
| **读取脚本（.gd）** | **不支持** | **支持** |
| **写入脚本（.gd）** | **不支持** | **支持** |
| **列出文件（带过滤）** | **不支持** | **支持** |
| **读取项目配置** | **不支持** | **支持** |
| **截图** | **不支持** | **支持** |
| **运行单元测试（GUT）** | **不支持** | **支持** |
| **执行任意 GDScript** | **不支持** | **支持** |
| **运行时场景树查询** | **不支持** | **支持** |
| **深度检查节点** | **不支持** | **支持** |
| **批量添加节点** | **不支持** | **支持** |
| **项目验证** | **不支持** | **支持** |
| **资源导入** | **不支持** | **支持** |
| **运行验证 + 场景树快照** | **不支持** | **支持** |
| **编辑脚本（行范围替换）** | **不支持** | **支持** |
| **Autoload 上下文执行** | **不支持** | **支持** |
| **结构化错误分析** | **不支持** | **支持** |
| **MCP 资源（godot://）** | **不支持** | **支持** |
| **脚本语法验证** | **不支持** | **支持**（逐文件 Godot 解析器检查） |
| **版本不一致检测** | **不支持** | **支持**（project.godot vs 二进制版本） |
| **搜索替换编辑** | **不支持** | **支持**（search_and_replace，CRLF 安全） |
| **截图自动重试** | **不支持** | **支持**（失败后 2x frameDelay 重试） |
| **音频播放控制** | **不支持** | **支持**（播放/停止/参数/状态查询） |
| **TileMap 编辑** | **不支持** | **支持**（读写/填充/复制粘贴/变换，兼容旧版 TileMap 与 TileMapLayer） |
| **双模式架构** | **不支持** | **支持**（Headless CLI + Editor WebSocket JSON-RPC 2.0） |
| **粒子系统** | **不支持** | **支持**（GPU 粒子创建/发射/处理/预设/材质，6 种预设效果） |
| **导航系统** | **不支持** | **支持**（NavigationRegion3D/Agent/Link 创建与管理） |
| **AnimationTree** | **不支持** | **支持**（状态机/混合树/混合空间创建与管理） |
| **测试断言** | **不支持** | **支持**（场景树断言 + 压力测试） |
| **导出管理** | **不支持** | **支持**（预设查询/导出构建） |
| **材质与着色器** | **不支持** | **支持**（读写材质/着色器编辑/模板） |
| **Game Bridge** | **不支持** | **支持**（运行时查询/输入/等待） |
| **工作流引擎** | **不支持** | **支持**（dev_loop/场景快照/批量验证） |
| **动画播放器控制** | **不支持** | **支持**（查询/播放/编辑动画） |
| **性能分析** | **不支持** | **支持**（FPS/内存/绘制调用/物理统计） |
| **3D 空间查询** | **不支持** | **支持**（transform/AABB/bounds/区域查找） |

## 核心亮点

### 双模式架构

v0.8.0 引入双模式架构，同时支持 **Headless CLI** 和 **Editor WebSocket** 两种连接方式：

- **Headless 模式**（原有）：通过 `executeGdscript()` 在独立 Godot 进程中执行代码，所有工具继续支持
- **Editor 模式**（新增）：通过 WebSocket JSON-RPC 2.0 连接编辑器内 GDScript 插件，实时操作打开的场景
- **Editor 插件**：`addons/godot_mcp_server/` 提供 command_handler + 7 个命令模块（node/test/export/particle/nav/animtree/undo）
- 自动检测编辑器连接状态，两种模式工具互不冲突

### 动态 GDScript 执行

`execute_gdscript` 工具让 AI 可以在 headless 模式下执行任意 GDScript 代码：

- **代码片段模式**：无需写 `extends`，输入的代码会被自动包装为完整的 `extends SceneTree` 脚本。支持 `func`/`var`/`const` 等声明（自动放在类级别）和语句行（放在 `_initialize()` 体内）
- **结构化输出**：通过 `_mcp_output(key, value)` 返回键值对结果
- **超时控制**：防止代码死循环卡住
- **Autoload 上下文**：设置 `load_autoloads=true` 可在完整项目环境中运行，访问 DataRegistry、PlayerData 等全局单例
- **结构化错误**：返回 `errors` 数组，包含错误类型、文件、行号、消息和修复建议

### 批量操作

`batch_add_nodes` 一次调用添加多个节点，只在最后做一次 pack+save，避免每个节点都启停 headless Godot，性能提升显著。

### 项目验证

`validate_project` 静态扫描项目，检查：
- `.tscn` 文件中引用了不存在的资源
- `.gd` 脚本中 `preload()`/`load()` 路径无效
- 源资源已删除但 `.import` 文件残留

### 资源导入

`import_resources` 扫描目录批量注册资源（图片/音频/字体/3D模型），自动生成 `.import` 文件。

## 闭环开发工作流

```
read_scene/read_script → 理解结构 → write_script → run_and_verify
→ validate_project → batch_add_nodes → import_resources → 验证通过
```

## 安全边界

本工具在受信任的本地开发环境中运行，具有以下安全特性：

- **GDScript 动态执行**：`execute_gdscript` 等工具会在本地 Godot 进程中执行任意 GDScript 代码。GDScript 拥有完整的系统访问权限（文件读写、网络请求、进程创建）。**仅用于受信任的本地开发环境，不可暴露到不可信的远程连接。**
- **路径白名单**：通过 `ALLOWED_PROJECT_PATHS` 环境变量限制可访问的项目路径（分号分隔多个路径）。未配置时允许所有路径并打印一次性警告，零配置即可使用。
- **确认令牌**：对危险操作（如删除节点）要求显式确认，防止 AI 误操作。
- **输出标记防伪造**：每次执行使用随机生成的标记字符串，防止 GDScript 代码伪造 MCP 输出。

**仅限本地使用**：本工具设计为 AI 与开发者在同一台机器上协作使用，不提供任何远程访问认证或加密机制。

## 安装

```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install
```

## 首次使用

连接 Godot 项目后，建议立即运行以下工具一键配置项目规则：

```
setup_project_rules(project_path="你的项目路径")
```

这会自动生成：
- **`.claude/settings.json`**：PostToolUse hook，每次编辑 `.gd` 文件后自动提醒 AI 运行 `validate_scripts` 验证语法
- **`CLAUDE.md`**：项目级规则，包含 GDScript 验证规则和发版门禁（`verify_delivery` 检查）

如果已有配置想更新，使用 `force=true` 覆盖。如只需其中一项，用 `hooks=false` 或 `claude_md=false` 跳过。

## 配置

### Cursor

在项目中创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["D:/GitHub/godot-mcp-enhanced/build/index.js"],
      "env": {
        "GODOT_PATH": "C:/path/to/godot.exe",
        "DEBUG": "true"
      }
    }
  }
}
```

### Cline / Claude Code

添加到 MCP 设置中：

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["D:/GitHub/godot-mcp-enhanced/build/index.js"],
      "env": {
        "GODOT_PATH": "C:/path/to/godot.exe",
        "DEBUG": "true"
      },
      "autoApprove": [
        "launch_editor", "run_project", "stop_project",
        "get_debug_output", "capture_screenshot", "analyze_screenshot", "run_tests",
        "get_godot_version", "list_projects", "get_project_info",
        "list_files", "read_project_config", "create_project", "setup_project_rules",
        "read_scene", "create_scene", "add_node", "save_scene", "load_sprite",
        "edit_node", "remove_node", "batch_add_nodes",
        "read_script", "write_script", "edit_script",
        "generate_test", "create_test_scene", "project_replace",
        "query_scene_tree", "inspect_node",
        "validate_project", "import_resources",
        "run_and_verify", "analyze_error", "validate_scripts",
        "signal_connect", "signal_disconnect", "signal_emit", "signal_list",
        "physics_raycast", "physics_body_info", "diagnose_physics",
        "query_spatial", "collision_overlay", "node_create_3d", "nav_query_path",
        "audio_play", "audio_stop", "audio_set_param", "audio_query",
        "tilemap_read", "tilemap_set_cell", "tilemap_erase_cell", "tilemap_fill_rect",
        "tilemap_clear", "tilemap_copy", "tilemap_paste", "tilemap_set_transform",
        "material_read", "material_write", "shader_edit",
        "game_bridge_install", "game_bridge_uninstall",
        "game_query", "game_input", "game_wait",
        "dev_loop", "scene_snapshot", "batch_validate", "batch_create_files", "batch_run_verify",
        "animation", "profiler", "spatial_info",
        "get_class_info", "search_classes", "find_method", "get_inheritance",
        "test_assert", "test_stress", "export_list_presets", "export_get_preset", "export_build",
        "particles_create", "particles_set_emission", "particles_set_process",
        "particles_load_preset", "particles_set_material",
        "nav_create_region", "nav_bake_mesh", "nav_create_agent", "nav_set_params", "nav_create_link",
        "animtree_create", "animtree_add_state", "animtree_add_transition",
        "animtree_set_blend", "animtree_play",
        "ik_modifier_create", "ik_modifier_get", "ik_modifier_set", "ik_list_bones",
        "verify_delivery", "list_templates", "apply_template",
        "ui_create_control", "ui_build_layout", "ui_set_layout", "ui_get_layout",
        "ui_anchor_preset", "ui_set_theme", "ui_container_add", "ui_draw_recipe",
        "theme_create", "theme_set_property",
        "recording_start", "recording_stop", "recording_save", "recording_load", "recording_play",
        "editor_sync_start", "editor_sync_stop",
        "quick_scene", "diff_scenes", "detach_instance"
      ]
    }
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GODOT_PATH` | Godot 可执行文件路径 | 自动检测 |
| `GODOT_PROJECT_PATH` | 指定 Godot 项目路径（跳过自动检测） | 自动检测 |
| `GODOT_MCP_SEARCH_PATHS` | 额外 Godot 二进制搜索目录（分号分隔） | — |
| `DEBUG` | 启用详细日志 | `false` |
| `ALLOW_OUTSIDE_PROJECT_PATHS` | 允许工具访问项目目录外的文件（如截图输出路径） | `false` |

## 工具列表（140+ 个）

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
| `validate_scripts` | 逐文件运行 Godot 解析器验证 GDScript 语法，检测 headless 运行可能遗漏的 Parse Error |

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
| `read_scene` | 解析 .tscn 为节点树 JSON |
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
| `game_wait` | 等待特定游戏状态条件（节点出现/属性值变化） |

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

## 闭环开发示例

```
1. AI: read_scene("scenes/player.tscn")
   → 获取完整节点树，理解场景结构

2. AI: read_script("scripts/player_controller.gd")
   → 读取当前代码，确定需要修改的内容

3. AI: write_script("scripts/player_controller.gd", updated_code)
   → 写入修改

4. AI: run_and_verify(project, capture_tree=true)
   → headless 运行 + 错误分析 + 场景树快照

5. AI: validate_project(project)
   → 检查缺失资源、无效引用

6. AI: batch_add_nodes(project, scene, nodes=[...])
   → 一次添加多个 UI 元素

7. AI: import_resources(project, directory="assets/ui")
   → 注册新资源到项目

8. 如果仍有问题 → 回到步骤 2
```

## 致谢

- [godot-mcp](https://github.com/Coding-Solo/godot-mcp) — 原始项目
- [Hastur Operation Plugin](https://github.com/rayxuln/hastur-operation-plugin) — 动态 GDScript 执行和结构化输出的灵感来源
- [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) — 借鉴了以下功能概念：
  - **Hooks + Rules 体系** → `setup_project_rules` 自动生成 `.claude/settings.json`（PostToolUse hook 自动验证 GDScript）和 `CLAUDE.md`（项目编码标准）
  - **Gate-check / verify** → `verify_delivery` 端到端交付验证（场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 合规）
  - **Workflow pipeline** → `dev_loop` 执行→验证→截图一体化工作流，支持 `acceptance` 验收标准和 `save_state` 会话记忆
  - **GDScript Lint** → `validate_scripts` 逐文件语法验证（L015 行级扫描 + 字符串/注释过滤），对标 CCGS 的 `validate-commit.sh`
  - **GDD 标准** → `validate_gdd` 8 章节游戏设计文档结构校验，对标 CCGS 的 `design/gdd` 路径规则
  - **Chain-of-Verification** → `chain_verify` 自我质疑引擎，防止审查盲点
  - **代码模板** → `list_templates` / `apply_template` 模板系统，对标 CCGS 的 41 个文档模板

## 系统要求

- Godot Engine 4.x（已测试 4.6+）
- Node.js >= 18
- GUT 插件（用于 `run_tests` 工具）

## 截图功能平台说明

`capture_screenshot` 工具根据平台使用不同的渲染策略：

| 平台 | 模式 | 说明 |
|------|------|------|
| **Windows** | 窗口模式（默认） | Headless 模式下 viewport 纹理返回 null，必须使用 GPU 上下文 |
| **Linux** | Headless → 窗口模式降级 | Headless + OpenGL3 取决于 GPU 驱动是否支持 |
| **macOS** | Headless → 窗口模式降级 | 与 Linux 相同 |

内置 `screenshot_capture.gd` 使用 `process_frame` 信号模式和 `call_deferred()` 确保场景加载和帧捕获的可靠性。

## 许可证

MIT

## 更新日志

> 完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 日期 | 要点 |
|------|------|------|
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
