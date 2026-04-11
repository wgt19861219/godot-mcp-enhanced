# Godot MCP Enhanced

增强版 Godot 引擎 MCP 服务器 — 为 **AI 辅助游戏开发闭环** 而设计。

基于 [godot-mcp](https://github.com/Coding-Solo/godot-mcp) 二次开发，填补了关键能力空白：场景读取、脚本读写、截图、测试、**动态 GDScript 执行** 等。

**[English](README.md)**

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

## 核心亮点

### 动态 GDScript 执行

`execute_gdscript` 工具让 AI 可以在 headless 模式下执行任意 GDScript 代码：

- **代码片段模式**：无需写 `extends`，输入的代码会被自动包装为完整的 `extends SceneTree` 脚本
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

## 安装

```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install
```

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
        "get_debug_output", "capture_screenshot", "run_tests",
        "get_godot_version", "list_projects", "get_project_info",
        "list_files", "read_project_config",
        "read_scene", "create_scene", "add_node", "save_scene", "load_sprite",
        "read_script", "write_script",
        "execute_gdscript", "query_scene_tree", "inspect_node",
        "batch_add_nodes", "validate_project", "import_resources",
        "run_and_verify", "analyze_error", "edit_script"
      ]
    }
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GODOT_PATH` | Godot 可执行文件路径 | 自动检测 |
| `DEBUG` | 启用详细日志 | `false` |

## 工具列表（共 34 个）

### 执行工具

| 工具 | 说明 |
|------|------|
| `launch_editor` | 启动 Godot 编辑器 GUI |
| `run_project` | 以调试模式运行项目（自动超时） |
| `stop_project` | 停止运行中的项目，返回结构化输出 |
| `get_debug_output` | 获取分类调试输出（错误/警告/打印） |
| `capture_screenshot` | 截取游戏画面（headless 模式） |
| `run_tests` | 运行 GUT 单元测试并解析结果 |
| `get_godot_version` | 获取 Godot 引擎版本 |

### 验证工具

| 工具 | 说明 |
|------|------|
| `run_and_verify` | 一键 headless 运行并返回结构化错误/警告分析。支持 `capture_tree` 选项同时获取场景树快照。 |
| `analyze_error` | 重新分析 Godot 输出文本，提供修复建议 |

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

### 脚本工具

| 工具 | 说明 |
|------|------|
| `read_script` | 读取 .gd 文件（含元数据） |
| `write_script` | 写入/覆盖 .gd 文件 |
| `edit_script` | 按行范围编辑 .gd 文件。自动检测 tab 缩进和 CRLF 换行。 |

### API 文档工具

| 工具 | 说明 |
|------|------|
| `get_class_info` | 获取类的方法、属性、信号、常量 |
| `search_classes` | 按名称/描述搜索类 |
| `find_method` | 查找方法详情（含继承链） |
| `get_inheritance` | 获取完整继承链 |

## v0.3.0 新增工具详解

### `edit_script`

按行范围编辑现有 GDScript 文件。自动检测并保留原始 tab 缩进和 CRLF/LF 换行：

```json
{
  "script_path": "scripts/player.gd",
  "start_line": 10,
  "end_line": 12,
  "new_content": "func get_health() -> int:\n\treturn hp"
}
```

比 `write_script` 更安全 — 仅修改指定行，不影响文件其余部分。

### `batch_add_nodes`

一次 headless Godot 调用添加多个节点，避免逐个启动的开销：

```json
{
  "project_path": "/path/to/project",
  "scene_path": "scenes/main.tscn",
  "nodes": [
    { "node_type": "Label", "node_name": "Title", "properties": { "text": "Hello" } },
    { "node_type": "Button", "node_name": "StartBtn", "parent_node_path": "root/UI" },
    { "node_type": "Sprite2D", "node_name": "PlayerIcon" }
  ]
}
```

### `validate_project`

静态分析项目常见问题：

- `.tscn` 文件中 `ext_resource` 引用了不存在的文件
- `.gd` 脚本中 `preload()`/`load()` 路径无效
- 源资源已删除但 `.import` 文件残留

返回结构化报告，包含严重级别：`critical`、`error`、`warning`、`info`。

### `import_resources`

批量注册资源到项目，自动生成 `.import` 文件：

```json
{
  "project_path": "/path/to/project",
  "directory": "assets/ui",
  "extensions": [".png", ".jpg", ".mp3"],
  "recursive": true
}
```

支持格式：`.png`、`.jpg`、`.jpeg`、`.webp`、`.svg`、`.mp3`、`.ogg`、`.wav`、`.ttf`、`.otf`、`.glb`、`.gltf`。

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

## 系统要求

- Godot Engine 4.x（已测试 4.5+）
- Node.js >= 18
- GUT 插件（用于 `run_tests` 工具）

## 许可证

MIT
