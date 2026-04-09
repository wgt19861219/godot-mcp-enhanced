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

## 核心亮点

### 动态 GDScript 执行（借鉴 Hastur）

新增 `execute_gdscript` 工具，让 AI 可以在 headless 模式下执行任意 GDScript 代码：

- **代码片段模式**：无需写 `extends`，输入的代码会被自动包装为完整的 `extends SceneTree` 脚本
- **结构化输出**：通过 `_mcp_output(key, value)` 返回键值对结果
- **超时控制**：防止代码死循环卡住

### 运行时场景树查询

新增 `query_scene_tree` 工具，在内存中加载并实例化场景后查询节点树：

- 返回节点的**实际运行时属性值**，而非 .tscn 文件中的静态值
- 支持深度控制，避免过大的场景树返回过多数据

### 深度节点检查

新增 `inspect_node` 工具，获取单个节点的完整信息：

- 所有存储属性和编辑器属性
- 信号连接列表
- 可用信号列表
- 递归子节点遍历

## 闭环开发工作流

```
read_scene/read_script → 理解结构 → write_script → run_project
→ get_debug_output/capture_screenshot → 分析 → 修复 → 验证
→ execute_gdscript → 查询运行时状态 → 深度调试
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
        "execute_gdscript", "query_scene_tree", "inspect_node"
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

## 工具列表（共 30 个）

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

### 动态执行工具（新增）

| 工具 | 说明 |
|------|------|
| `execute_gdscript` | 在 headless 模式下执行任意 GDScript 代码。支持代码片段模式（自动包装）和完整类模式。返回结构化键值对结果。 |
| `query_scene_tree` | 加载场景并查询运行时节点树，返回解析后的实际属性值（而非 .tscn 文件的静态数据）。 |
| `inspect_node` | 深度检查节点：所有属性、信号连接、子节点，支持递归深度控制。 |

### 项目工具

| 工具 | 说明 |
|------|------|
| `list_projects` | 搜索目录中的 Godot 项目 |
| `get_project_info` | 项目元数据 + 文件统计 |
| `list_files` | 列出文件（支持扩展名/子目录过滤） |
| `read_project_config` | 解析 project.godot 为结构化 JSON |

### 场景工具

| 工具 | 说明 |
|------|------|
| `read_scene` | 解析 .tscn 为节点树 JSON |
| `create_scene` | 创建新场景 |
| `add_node` | 向场景添加节点 |
| `save_scene` | 保存场景更改 |
| `load_sprite` | 加载纹理到精灵节点 |

### 脚本工具

| 工具 | 说明 |
|------|------|
| `read_script` | 读取 .gd 文件（含元数据） |
| `write_script` | 写入/覆盖 .gd 文件 |

### API 文档工具

| 工具 | 说明 |
|------|------|
| `get_class_info` | 获取类的方法、属性、信号、常量 |
| `search_classes` | 按名称/描述搜索类 |
| `find_method` | 查找方法详情（含继承链） |
| `get_inheritance` | 获取完整继承链 |

## `execute_gdscript` 使用详解

### 代码片段模式（默认）

当输入代码不包含 `extends` 时，会自动包装：

```gdscript
# 你输入的代码：
var scene = load("res://scenes/main.tscn")
var root = scene.instantiate()
_mcp_output("node_count", str(root.get_child_count()))
_mcp_output("root_type", root.get_class())
```

这段代码会被自动包装为完整的 `extends SceneTree` 脚本，并注入辅助函数。使用 `_mcp_output(key, value)` 返回结构化结果。

### 完整类模式

当输入代码包含 `extends` 时，直接使用并注入辅助函数：

```gdscript
extends SceneTree

func _initialize():
    var project = ProjectSettings.globalize_path("res://")
    _mcp_output("project_path", project)
    var screen = DisplayServer.screen_get_size(0)
    _mcp_output("screen_size", str(screen))
    quit()
```

### 返回格式

```json
{
  "success": true,
  "compile_success": true,
  "compile_error": "",
  "run_success": true,
  "run_error": "",
  "outputs": [
    { "key": "node_count", "value": "5" },
    { "key": "root_type", "value": "Node2D" }
  ],
  "raw_output": "",
  "duration_ms": 1250
}
```

## 闭环开发示例

```
1. AI: read_scene("scenes/player.tscn")
   → 获取完整节点树，理解场景结构

2. AI: read_script("scripts/player_controller.gd")
   → 读取当前代码，确定需要修改的内容

3. AI: write_script("scripts/player_controller.gd", updated_code)
   → 写入修改

4. AI: run_project(project, timeout=10)
   → 启动游戏

5. AI: get_debug_output()
   → 检查是否有错误

6. AI: capture_screenshot(project, scene="scenes/level1.tscn")
   → 验证视觉效果（headless 模式）

7. AI: stop_project()
   → 获取完整摘要

8. AI: execute_gdscript(project, code="var s=load('res://main.tscn').instantiate(); _mcp_output('children', str(s.get_child_count()))")
   → 查询运行时状态，进行高级调试

9. AI: query_scene_tree(project, scene_path="res://scenes/main.tscn")
   → 获取场景运行时的实际节点属性

10. 如果仍有问题 → 回到步骤 2
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
