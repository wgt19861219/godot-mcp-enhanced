# MCP 使用规范文档 P0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 代理开发者创建 godot-mcp-enhanced 的完整使用规范文档体系（P0：核心 + 4 个高频子系统）

**Architecture:** 混合策略 — CLAUDE.md 速查表（始终可见）+ core.md 核心指南（始终可见）+ 4 个子系统 rule 文件（按需加载）。所有 rule 文件遵循统一 5 节模板。

**Tech Stack:** Markdown, Claude Code .claude/rules/ frontmatter

**Spec:** `docs/superpowers/specs/2026-05-27-mcp-usage-guide-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `CLAUDE.md` | 创建 | 项目级配置 + 子系统速查表 |
| `.claude/rules/godot-mcp-core.md` | 创建 | 核心指南：模式决策树 + 核心工具 + 运行时语义 |
| `.claude/rules/godot-mcp-editor.md` | 创建 | Editor WebSocket 模式详细指南 |
| `.claude/rules/godot-mcp-bridge.md` | 创建 | Game Bridge 系统详细指南 |
| `.claude/rules/godot-mcp-ui.md` | 创建 | UI 布局工具链详细指南 |
| `.claude/rules/godot-mcp-recording.md` | 创建 | 录制/回放系统详细指南 |

---

### Task 1: 创建 CLAUDE.md 项目配置文件

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: 创建 CLAUDE.md**

```markdown
# Godot MCP Enhanced 项目配置

## MCP 工具验证规则

编辑 `.gd` 文件后，必须运行 `validate_scripts` 验证语法。
使用 `edit_script` 时优先选择 `search_and_replace` 模式（CRLF 安全、行号偏移鲁棒）。

## 发版门禁

每次发版前必须运行 `verify_delivery`，确保场景树完整性 + 脚本健康 + 性能正常 + 自定义断言通过。

## MCP 子系统速查（详细指南见 .claude/rules/godot-mcp-*.md）

| 子系统 | 入口工具 | 核心能力 | 前提 | rule 文件 |
|--------|---------|---------|------|----------|
| **模式选择** | — | Headless/Editor/Bridge 决策树 | — | core |
| Editor | launch_editor | 实时场景树同步、undo | 编辑器运行中 | editor |
| Bridge | game_bridge_install | 查询/输入/写入/等待 | 游戏运行中 | bridge |
| UI 布局 | ui_build_layout | CSS Flexbox/Grid 翻译 | headless | ui |
| 录制回放 | recording_start | 捕获→保存→回放 | Bridge 连接 | recording |
| 粒子 | particles_create | GPU 粒子 + 6 种预设 | headless | particles |
| TileMap | tilemap_read | 读写/填充/复制/变换 | headless | tilemap |
| 动画 | animation | 播放/编辑/AnimationTree | headless | animation |
| 导航 | nav_create_region | Region/Agent/Link | headless | navigation |
| 材质 | material_read | 材质读写/着色器 | headless | material |
| 信号 | signal_connect | 连接/断开/发射/列出 | headless | signal |
| 音频 | audio_play | 播放/停止/参数/状态 | headless | audio |
| 工作流 | dev_loop | 执行→验证→截图一体化 | headless | workflow |
```

- [ ] **Step 2: 验证文件内容**

确认 CLAUDE.md 包含：MCP 验证规则、发版门禁、13 行速查表。总行数约 25 行。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with MCP tool verification rules and subsystem quick reference"
```

---

### Task 2: 创建核心指南 godot-mcp-core.md

**Files:**
- Create: `.claude/rules/godot-mcp-core.md`

- [ ] **Step 1: 创建 .claude/rules/ 目录**

```bash
mkdir -p .claude/rules
```

- [ ] **Step 2: 创建 godot-mcp-core.md**

```markdown
---
description: "godot-mcp 核心指南 模式选择 Headless Editor Bridge execute_gdscript edit_script dev_loop run_and_verify validate_scripts verify_delivery 运行时 持久化"
alwaysApply: true
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

godot-mcp-enhanced 提供 130+ 工具，通过三层架构操作 Godot：

1. **Headless CLI** — 独立 Godot 进程执行 GDScript，适合文件读写和一次性验证
2. **Editor WebSocket** — 连接运行中的编辑器插件，适合实时场景操作
3. **Game Bridge** — TCP 连接运行中的游戏，适合运行时调试和 E2E 测试

`setup_project_rules` 生成的 `.claude/rules/godot-mcp.md` 是基础规则（始终可见）。
本指南是核心决策参考，子系统详细指南在 `.claude/rules/godot-mcp-*.md` 中按需加载。

## 模式选择决策树

```
需要操作什么？
├─ .tscn/.gd 文件（静态读写）
│   ├─ 精确编辑 → Headless（edit_script / write_script）
│   └─ 批量创建 → Headless（batch_add_nodes / batch_create_files）
├─ 编辑器中打开的场景（实时）
│   ├─ 编辑器已连接？→ Editor 模式（editor_sync + add_node）
│   └─ 未连接 → Headless（read_scene + add_node + save_scene）
├─ 运行中的游戏（动态状态）
│   ├─ 只读查询 → Bridge（game_query）
│   ├─ 修改状态 → Bridge（game_write）
│   └─ 模拟输入 → Bridge（game_input + game_wait）
└─ 一次性验证
    ├─ 快速检查 → run_and_verify
    ├─ 完整交付 → verify_delivery
    └─ 语法检查 → validate_scripts
```

## 核心工具使用决策

### execute_gdscript — 动态执行

- **片段模式**（默认）：无需 `extends`，代码自动包装为 `extends SceneTree`。用 `_mcp_output(key, value)` 返回结构化结果，用 `_mcp_done()` 结束执行。
- **完整类模式**：手写 `extends SceneTree`，适合需要 `_process()` 或复杂生命周期的场景。
- **load_autoloads=true**：在完整项目环境中运行，可访问 DataRegistry、PlayerData 等全局单例。启动较慢（需加载整个项目），仅在确实需要 Autoload 时开启。
- **注意**：片段模式中 `func`/`var`/`const` 声明自动放在类级别，语句行放在 `_initialize()` 体内。

### edit_script — 脚本编辑

- **优先使用 search_and_replace**：基于内容匹配，对行号偏移鲁棒，CRLF 安全。
- **行范围模式**（start_line/end_line）：仅在 search_and_replace 无法使用时（如批量重复修改）。
- **indent_mode**：`smart`（推荐）自动对齐缩进；`raw` 仅在确认缩进正确时使用。
- **verify_content**：提供期望内容作为守卫，防止过时的行号编辑。

### dev_loop vs 单独工具

- **dev_loop**：执行 GDScript → 可选验证 → 可选 Bridge 查询/截图 → 可选断言 → 可选状态保存。适合一体化验证流程。
- **单独工具**：execute_gdscript + validate_scripts + run_and_verify 灵活组合。适合多步调试或需要中间检查的场景。

### run_and_verify vs 手动组合

- **run_and_verify**：一键 headless 运行 + 错误分析 + 可选场景树快照。适合快速检查。
- **手动组合**：run_project + get_debug_output + stop_project。适合需要精细控制运行时长的场景。

## 运行时 vs 持久化

部分工具在 headless 进程中创建/修改节点，但**这些变更不持久化到 .tscn 文件**：

- **运行时工具**（不持久化）：signal_connect/disconnect/emit、node_create_3d、physics_raycast、tilemap_*、audio_*、particles_*、ui_*、recording_* 等
- **持久化方法**：使用 add_node（写入 .tscn）+ save_scene 保存。或用 write_script / edit_script 修改 .gd 文件。

> 运行时工具适合验证和测试。若需持久化场景修改，必须使用 add_node + save_scene。

## 常见陷阱

- **忘记 `_mcp_done()`**：片段模式中如果没有调用 `_mcp_done()`，执行会超时。
- **edit_script 行号偏移**：多步编辑后行号会变化。始终优先使用 search_and_replace。
- **运行时操作误认为持久化**：运行时工具的修改在 headless 进程退出后丢失。
- **load_autoloads 性能开销**：仅在需要 Autoload 单例时开启，否则启动时间增加 3-5 倍。
- **Bridge 密钥过期**：Bridge 密钥有 5 分钟 TTL 缓存，长时间未操作后首次调用可能稍慢。
```

- [ ] **Step 3: 验证文件内容**

确认文件包含：frontmatter（alwaysApply: true）、版本标记、5 节结构（概述→决策树→核心工具→运行时语义→陷阱）。总行数约 90 行。

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/godot-mcp-core.md
git commit -m "docs: add core MCP usage guide with mode selection decision tree"
```

---

### Task 3: 创建 Editor WebSocket 指南

**Files:**
- Create: `.claude/rules/godot-mcp-editor.md`

- [ ] **Step 1: 创建 godot-mcp-editor.md**

```markdown
---
description: "editor websocket editor_sync_start editor_sync_stop editor_get_scene_tree launch_editor 编辑器 场景树同步 undo plugin addons godot_mcp_server"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

Editor 模式通过 WebSocket JSON-RPC 2.0 连接 Godot 编辑器内的 GDScript 插件，实时操作当前打开的场景。

- **插件位置**：`addons/godot_mcp_server/`（需安装在目标项目中）
- **连接机制**：launch_editor 启动编辑器后，服务端自动检测 WebSocket 连接（端口 13100）
- **回退策略**：无编辑器连接时自动回退到 Headless 模式；设置 `GODOT_MCP_NO_FALLBACK=true` 禁止回退

## 工具清单与对比

### Editor 独有工具

| 工具 | 说明 |
|------|------|
| `editor_sync_start` | 启动场景树实时监听，推送 node_added/node_removed 事件 |
| `editor_sync_stop` | 停止场景树监听 |
| `editor_get_scene_tree` | 获取编辑器当前场景树完整快照 |

### 仅 Headless 可用

| 工具 | 原因 |
|------|------|
| `execute_gdscript` | 独立进程执行，不适合编辑器环境 |
| `query_scene_tree` | Headless 专用，用 editor_get_scene_tree 替代 |
| `inspect_node` | Headless 专用 |

### 行为差异

| 工具 | Headless | Editor |
|------|----------|--------|
| `add_node` | 需指定 scene_path，创建后需 save_scene | 操作当前打开场景，实时刷新 |
| `edit_node` | 需指定 scene_path | 操作当前场景中的节点 |
| `remove_node` | 需确认令牌 | 需确认令牌 + 支持 undo |
| 其他工具 | 自动路由到 headless 执行 | 未知工具名自动 forward 到插件 |

## 使用指南

### 连接流程

1. 确认目标项目已安装 `addons/godot_mcp_server/` 插件
2. 调用 `launch_editor(project_path)` 启动编辑器
3. 服务端自动检测 WebSocket 连接（最长等待约 10 秒）
4. 连接成功后，工具调用自动路由到编辑器

### 场景树同步

- `editor_sync_start` 连接 SceneTree 的 node_added/node_removed 信号
- 事件通过 EditorToolExecutor 缓冲（最大 10000 条），超出时丢弃最旧记录
- 编辑器断开重连后，同步自动恢复
- `editor_get_scene_tree` 获取当前快照（不依赖 sync 状态）

## 调用示例

### 启动编辑器并同步场景树

```
// 1. 启动编辑器
launch_editor(project_path="D:/projects/my-game")

// 2. 启动场景树监听
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: { status: "ok", message: "Scene tree sync started" }

// 3. 获取当前场景树
editor_get_scene_tree(project_path="D:/projects/my-game")
// → 返回: { nodes: [...], root: "Node3D", child_count: 15 }
```

### 错误：编辑器未安装插件

```
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: {
//     error: "EDITOR_NOT_CONNECTED",
//     message: "These tools require editor mode with plugin connection.
//               Use headless query_scene_tree as alternative."
//   }
// 解决：在 Godot 编辑器中安装 addons/godot_mcp_server/ 插件并重启编辑器
```

## 常见陷阱

- **插件未安装**：editor_sync 工具返回 EDITOR_NOT_CONNECTED。需要手动安装插件到项目。
- **编辑器启动慢**：大型项目首次启动可能超过 10 秒。可分两步操作：先 launch_editor，等几秒后再 sync。
- **forward 机制**：未明确处理的工具名会自动转发到编辑器插件，可能产生意外行为。
- **断开重连**：编辑器崩溃或关闭后，sync 状态自动清理。需要重新 launch_editor。
- **端口冲突**：默认端口 13100，如果被占用需检查编辑器插件配置。
```

- [ ] **Step 2: 验证文件内容**

确认 5 节结构完整，包含行为差异表和错误示例。总行数约 95 行。

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/godot-mcp-editor.md
git commit -m "docs: add Editor WebSocket mode usage guide"
```

---

### Task 4: 创建 Game Bridge 指南

**Files:**
- Create: `.claude/rules/godot-mcp-bridge.md`

- [ ] **Step 1: 创建 godot-mcp-bridge.md**

```markdown
---
description: "game bridge game_query game_input game_write game_wait game_bridge_install game_bridge_uninstall 运行时 TCP 密钥认证 端口 9081 autoload mcp_bridge E2E 测试 调试"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

Game Bridge 是 MCP 服务端与**运行中的游戏**之间的 TCP 通信层。

- **三层区别**：Headless（独立 Godot 进程）vs Editor（连接 IDE）vs Bridge（连接运行时游戏）
- **通信方式**：MCP 服务端 → TCP JSON-RPC 2.0 → 游戏内 mcp_bridge.gd autoload
- **使用场景**：E2E 测试、运行时调试、输入模拟、状态验证、截图验证
- **前提**：游戏必须正在运行（F5 或 run_project），且已安装 Bridge autoload

## 工具清单

### 安装管理

| 工具 | 说明 |
|------|------|
| `game_bridge_install` | 安装 Bridge autoload 到项目（注册 autoload + 配置端口 9081） |
| `game_bridge_uninstall` | 卸载 Bridge autoload |

### 查询 — game_query

| method | 说明 |
|--------|------|
| `ping` | 检查游戏是否运行 |
| `get_tree` | 获取场景树结构 |
| `find_nodes` | 按名称/类型/路径查找节点 |
| `get_node_properties` | 获取节点属性值 |
| `get_performance` | 获取性能统计（FPS/内存等） |
| `get_viewport_info` | 获取视口信息 |
| `take_screenshot` | 从运行中的游戏截图 |

### 输入 — game_input

| method | 说明 |
|--------|------|
| `send_key` | 发送键盘事件（key + pressed） |
| `send_mouse_click` | 发送鼠标点击（x, y, button, pressed） |
| `send_mouse_move` | 移动鼠标（x, y） |
| `send_text` | 输入文本（text） |

### 写入 — game_write

| method | 说明 |
|--------|------|
| `set_node_property` | 设置节点属性值（path + property + value） |
| `call_method` | 调用节点方法（path + method + args） |

### 等待 — game_wait

| method | 说明 |
|--------|------|
| `wait_for_node` | 等待节点出现（path） |
| `wait_for_property` | 等待属性值变化（path + property + value） |

## 使用指南

### 安装流程

1. 调用 `game_bridge_install(project_path)` — 注册 autoload、配置端口 9081
2. 在 Godot 中运行项目（F5 或 `run_project`）
3. 游戏启动后 Bridge 自动监听 TCP 连接
4. 使用 `game_query(method="ping")` 验证连接

### 安全机制

- **密钥认证**：安装时生成随机密钥文件，每次 TCP 连接需认证
- **本地绑定**：TCP 仅监听 127.0.0.1，不暴露到网络
- **密钥生命周期**：读取后缓存 5 分钟（TTL），文件权限收紧（0600/icacls）
- **防符号链接**：密钥文件若是 symlink 则拒绝读取

### 与 dev_loop 集成

dev_loop 的 `bridge` 参数可在执行 GDScript 后自动进行 Bridge 查询：

```json
{
  "bridge": {
    "screenshot": { "path": "user://test.png" },
    "queries": [
      { "method": "ping", "expect": "ok" },
      { "method": "find_nodes", "params": { "pattern": "Player" } }
    ]
  }
}
```

## 调用示例

### 检查游戏运行状态

```
game_query(method="ping")
// → { status: "ok", message: "Bridge connected" }

game_query(method="get_tree")
// → { root: "Node3D", child_count: 15 }

game_query(method="find_nodes", params={ "pattern": "Player" })
// → { nodes: [{ path: "root/Player", type: "CharacterBody3D" }] }
```

### 模拟输入并等待

```
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": false })
game_wait(method="wait_for_node", params={ "path": "root/CanvasLayer/Dialog" })
game_query(method="get_node_properties", params={ "path": "root/CanvasLayer/Dialog", "properties": ["visible"] })
// → { visible: true }
```

### 修改运行时状态

```
game_write(method="set_node_property", params={ "path": "root/Player", "property": "position", "value": { "x": 10, "y": 0, "z": 5 } })
game_write(method="call_method", params={ "path": "root/Player", "method": "take_damage", "args": [25] })
```

### 错误：Bridge 未连接

```
game_query(method="ping")
// → 超时或错误: "Bridge not connected"
// 解决：1. 确认已运行 game_bridge_install
//       2. 确认游戏正在运行（F5 或 run_project）
//       3. 检查项目 .godot/ 目录下是否有 mcp_bridge_9081.secret 文件
```

## 常见陷阱

- **Bridge 未安装**：调用 game_query/input/write/wait 前必须先 game_bridge_install。安装是一次性的（写入 project.godot autoload）。
- **游戏未运行**：Bridge autoload 只在游戏运行时监听。编辑器模式（编辑场景）不会启动 Bridge。
- **密钥文件权限**：Windows 上可能需要 icacls 权限。Linux/macOS 上自动 chmod 0600。
- **与录制系统**：recording_start 依赖 Bridge 连接。确保 Bridge 可用后再录制。
- **端口 9081 冲突**：如果端口被占用，需要手动修改 autoload 脚本中的端口配置。
- **密钥缓存**：5 分钟 TTL 后首次调用会重新读取密钥文件，可能有短暂延迟。
```

- [ ] **Step 2: 验证文件内容**

确认 4 大工具组（query/input/write/wait）完整，含 dev_loop 集成和错误示例。总行数约 115 行。

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/godot-mcp-bridge.md
git commit -m "docs: add Game Bridge system usage guide with query/input/write/wait tools"
```

---

### Task 5: 创建 UI 布局指南

**Files:**
- Create: `.claude/rules/godot-mcp-ui.md`

- [ ] **Step 1: 创建 godot-mcp-ui.md**

```markdown
---
description: "ui ui_create_control ui_build_layout ui_set_layout ui_get_layout ui_anchor_preset ui_set_theme ui_container_add ui_draw_recipe theme_create theme_set_property CSS flexbox grid 布局 容器 锚点 Control HBoxContainer VBoxContainer GridContainer 全屏 居中"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

UI 布局工具将 **CSS Flexbox/Grid 语义**翻译为 Godot Container 树，让 AI 用熟悉的布局概念构建 Godot UI。

- **两种使用方式**：单节点操作（ui_create_control）vs 批量布局（ui_build_layout）
- **运行时工具**：操作在 headless 进程中执行，不持久化到 .tscn。详见 godot-mcp-core.md "运行时 vs 持久化"。
- **两种方式互补**：ui_build_layout 适合整体布局，ui_create_control + ui_set_layout 适合精确定位

## 工具清单

| 工具 | 说明 |
|------|------|
| `ui_build_layout` | 声明式批量布局，CSS Flexbox/Grid → Godot Container 树 |
| `ui_create_control` | 创建单个 Control 节点（29 种类型） |
| `ui_set_layout` | 设置锚点/偏移/最小尺寸 |
| `ui_get_layout` | 查询节点布局信息 |
| `ui_anchor_preset` | 应用 16 种锚点预设 |
| `ui_container_add` | 向 Container 添加子 Control |
| `ui_draw_recipe` | 声明式 2D 绘图（7 种操作） |
| `ui_set_theme` | 设置/创建/保存/加载 Theme |
| `theme_create` | 创建空 Theme 或从节点提取 |
| `theme_set_property` | 设置 Theme 属性（font/color/constant/stylebox） |

### 支持的 29 种 Control 子类

Button, Label, Panel, LineEdit, TextEdit, RichTextLabel, LinkButton, HSlider, VSlider, CheckBox, CheckButton, OptionButton, SpinBox, ProgressBar, TextureRect, ColorPickerButton, TabContainer, Tree, ItemList, MarginContainer, HBoxContainer, VBoxContainer, GridContainer, CenterContainer, ScrollContainer, PanelContainer, HSplitContainer, VSplitContainer, NinePatchRect

## 使用指南

### ui_build_layout — 声明式布局

`tree` 参数定义布局结构，支持递归嵌套（最大深度 10）：

```json
{
  "type": "VBoxContainer",
  "name": "MainMenu",
  "layout": { "direction": "column", "gap": 10, "padding": 20 },
  "children": [
    { "type": "Label", "name": "Title", "properties": { "text": "游戏标题" } },
    {
      "type": "HBoxContainer",
      "name": "ButtonRow",
      "layout": { "direction": "row", "justify": "center", "gap": 8 },
      "children": [
        { "type": "Button", "name": "StartBtn", "properties": { "text": "开始" } },
        { "type": "Button", "name": "QuitBtn", "properties": { "text": "退出" } }
      ]
    }
  ]
}
```

### layout 字段

| 字段 | 值 | 对应 Godot |
|------|-----|-----------|
| `direction` | row/column/grid | HBoxContainer/VBoxContainer/GridContainer |
| `justify` | flex-start/center/flex-end/space-between/space-around/space-evenly | Container alignment |
| `align` | stretch/flex-start/center/flex-end | Cross-axis alignment |
| `gap` | number | Theme 默认间距 override |
| `padding` | number 或 [上,右,下,左] | MarginContainer |
| `columns` | number | GridContainer columns（仅 grid 方向） |

### flex 字段（控制子节点在容器中的行为）

| 字段 | 说明 | 对应 Godot |
|------|------|-----------|
| `grow` | 扩展比例（0=不扩展） | size_flags_stretch_ratio |
| `min_width` / `min_height` | 最小尺寸 | custom_minimum_size |
| `align_self` | 单独对齐覆盖 | size_flags + alignment |

### anchor_preset 锚点预设

16 种预设：top_left, top_right, bottom_left, bottom_right, center_left, center_top, center_right, center_bottom, center, left_wide, top_wide, right_wide, bottom_wide, vcenter_wide, hcenter_wide, **full_rect**（最常用）

### draw_recipe 声明式绘图

7 种绘图操作：`rect`（矩形）、`circle`（圆形）、`line`（线段）、`arc`（弧线）、`polygon`（多边形）、`polyline`（折线）、`string`（文本）

每种操作支持 `color`（[r,g,b] 或 [r,g,b,a]，0-1 范围）、`filled`（是否填充）、`width`（线宽）。

## 调用示例

### Flexbox 行布局

```
ui_build_layout(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  parent_path="root",
  tree={
    "type": "HBoxContainer",
    "name": "Toolbar",
    "layout": { "direction": "row", "gap": 4, "padding": [0, 8, 0, 8] },
    "children": [
      { "type": "Button", "name": "NewBtn", "properties": { "text": "新建" } },
      { "type": "Button", "name": "OpenBtn", "properties": { "text": "打开" } },
      { "type": "Button", "name": "SaveBtn", "properties": { "text": "保存" } }
    ]
  }
)
```

### draw_recipe HP 条

```
ui_draw_recipe(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_path="root/HUD/HealthBar",
  ops=[
    { "kind": "rect", "position": [0, 0], "size": [200, 20], "color": [0.2, 0.2, 0.2] },
    { "kind": "rect", "position": [0, 0], "size": [140, 20], "color": [0, 0.8, 0] },
    { "kind": "string", "text": "70/100", "position": [80, 14], "color": [1, 1, 1], "font_size": 12 }
  ]
)
```

### 错误：无效 Control 类型

```
ui_create_control(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_type="MyCustomWidget",    // ❌ 不在白名单中
  node_name="CustomWidget"
)
// → { error: "INVALID_CONTROL_TYPE", message: "MyCustomWidget is not a supported control type" }
// 解决：使用 29 种支持的类型之一，或通过 execute_gdscript 注册自定义场景
```

## 常见陷阱

- **运行时不持久化**：UI 布局工具创建的节点在 headless 进程退出后丢失。持久化需用 add_node + save_scene。
- **Container 子节点必须是 Control**：向 HBoxContainer/VBoxContainer 等容器添加非 Control 子节点会报错。
- **CSS 属性回退**：`wrap`、`order`、`flex-shrink`、`max-width/height` 等 CSS 属性在 Godot 中无对应，会被忽略。
- **grid 方向必须指定 columns**：使用 `direction: "grid"` 时必须同时指定 `columns` 数量。
- **ui_build_layout vs ui_create_control**：build_layout 一次创建整棵树，适合初始布局。create_control + set_layout 适合精确控制单个节点。
```

- [ ] **Step 2: 验证文件内容**

确认含 ui_build_layout 语法详解、draw_recipe 示例、错误示例。总行数约 115 行。

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/godot-mcp-ui.md
git commit -m "docs: add UI layout tools guide with CSS Flexbox translation reference"
```

---

### Task 6: 创建录制/回放指南

**Files:**
- Create: `.claude/rules/godot-mcp-recording.md`

- [ ] **Step 1: 创建 godot-mcp-recording.md**

```markdown
---
description: "recording recording_start recording_stop recording_save recording_load recording_play 录制 回放 输入事件 bridge E2E 测试 regression 操作复现 输入捕获 事件重放"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

录制系统捕获用户输入事件（键盘/鼠标），序列化为 JSON，可在后续回放。

- **依赖**：Game Bridge 必须已连接（输入事件通过 Bridge 发送和捕获）
- **存储位置**：`res://recordings/recording_*.json`（项目内）
- **使用场景**：E2E 测试用例录制、回归测试、Bug 复现、操作自动化

## 工具清单

| 工具 | 说明 | 前提 |
|------|------|------|
| `recording_start` | 开始捕获输入事件 | Bridge 已连接 |
| `recording_stop` | 停止捕获，返回事件 JSON | 录制进行中 |
| `recording_save` | 保存到 res://recordings/ | events_json 参数 |
| `recording_load` | 从文件加载录制 | 文件名匹配 recording_*.json |
| `recording_play` | 回放录制的输入事件 | Bridge 已连接 + events_json |

## 使用指南

### 完整流程

```
1. game_bridge_install → 安装 Bridge（一次性）
2. run_project → 启动游戏
3. game_query(method="ping") → 确认 Bridge 连接
4. recording_start → 开始录制
5. [用户操作 / game_input 模拟输入]
6. recording_stop → 停止录制，获取 events_json
7. recording_save(file_name) → 保存到文件
--- 后续使用 ---
8. recording_load(file_name) → 加载录制
9. recording_play(events_json, speed=1.0) → 回放
```

### 事件格式

```json
{
  "version": 1,
  "duration_ms": 5420,
  "events": [
    { "type": "key", "keycode": 87, "pressed": true, "timestamp_ms": 120 },
    { "type": "mouse_click", "x": 640, "y": 360, "button": 1, "pressed": true, "timestamp_ms": 2300 },
    { "type": "key", "keycode": 87, "pressed": false, "timestamp_ms": 4100 }
  ]
}
```

### 文件命名与安全

- **自动命名**：`recording_YYYYMMDD_HHmmss.json`（如 `recording_20260527_143022.json`）
- **强制格式**：文件名必须匹配 `recording_*.json`，否则报 `INVALID_FILE_NAME`
- **路径遍历防护**：文件名禁止包含 `/`、`\`、`..`

## 调用示例

### 完整录制→保存→加载→回放

```
// 1. 开始录制
recording_start(project_path="D:/game")
// → { status: "ok", message: "Recording started" }

// 2. [模拟玩家操作]
game_input(method="send_key", params={ "key": "Key_W", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 320, "y": 240, "button": "left", "pressed": true })

// 3. 停止录制
recording_stop(project_path="D:/game")
// → { events_json: "{\"version\":1,\"duration_ms\":1200,\"events\":[...]}" }

// 4. 保存到文件
recording_save(project_path="D:/game", file_name="recording_test_login.json", events_json="<从 stop 获取>")
// → { status: "ok", path: "res://recordings/recording_test_login.json" }

// 5. 后续加载并回放
recording_load(project_path="D:/game", file_name="recording_test_login.json")
// → { events_json: "..." }

recording_play(project_path="D:/game", events_json="<从 load 获取>", speed=1.0)
// → { status: "ok", events_played: 5 }
```

### 与 game_wait 结合的 E2E 测试

```
// 录制一次操作，后续自动回放 + 验证
recording_load(project_path="D:/game", file_name="recording_open_menu.json")
recording_play(project_path="D:/game", events_json="<loaded>", speed=2.0)
game_wait(method="wait_for_node", params={ "path": "root/CanvasLayer/OptionsMenu" })
game_query(method="get_node_properties", params={ "path": "root/CanvasLayer/OptionsMenu", "properties": ["visible"] })
// → { visible: true } — 测试通过
```

### 错误：Bridge 未连接

```
recording_start(project_path="D:/game")
// → { error: "BRIDGE_NOT_CONNECTED", message: "Recording requires an active game bridge connection" }
// 解决：1. 确认已 game_bridge_install
//       2. 确认游戏正在运行（F5）
//       3. 确认 game_query(method="ping") 返回成功
```

## 常见陷阱

- **Bridge 是硬依赖**：recording_start/recording_play 都需要 Bridge 连接。没有 Bridge 则无法录制或回放。
- **文件名格式严格**：`recording_test.json`（❌ 不匹配）、`recording_test_login.json`（✅ 匹配）。必须以 `recording_` 开头、`.json` 结尾。
- **回放时序**：speed > 1.0 会加速回放，但可能因游戏帧率跟不上导致事件丢失。建议 E2E 测试使用 speed=1.0。
- **录制文件存储在项目内**：`res://recordings/` 下的文件会随项目版本控制。敏感录制应在 .gitignore 中排除。
- **事件类型有限**：仅捕获键盘（key）和鼠标（mouse_click）事件。触摸、手柄等不适用。
```

- [ ] **Step 2: 验证文件内容**

确认含完整流程、事件格式、Bridge 依赖说明、错误示例。总行数约 100 行。

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/godot-mcp-recording.md
git commit -m "docs: add recording/replay system usage guide"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 验证文件结构**

确认以下文件存在且内容正确：

```bash
ls -la CLAUDE.md .claude/rules/godot-mcp-core.md .claude/rules/godot-mcp-editor.md .claude/rules/godot-mcp-bridge.md .claude/rules/godot-mcp-ui.md .claude/rules/godot-mcp-recording.md
```

- [ ] **Step 2: 验证 frontmatter 格式**

- `godot-mcp-core.md`：`alwaysApply: true`
- 其他 4 个文件：`alwaysApply: false`，description 包含关联工具名

- [ ] **Step 3: 验证设计规范覆盖**

对照设计文档，确认 13 项审查决定全部落实：

| # | 决定 | 验证方式 |
|---|------|---------|
| #1 | P0 6 文件 | 文件存在 |
| #2 | 速查表 13 行 | CLAUDE.md 表格 |
| #3 | setup_project_rules 关系 | core.md 提及 |
| #4 | 版本标记 | 每个文件开头 |
| #5 | alwaysApply 配置 | frontmatter |
| #6 | 核心指南 | core.md 存在 |
| #7 | 5 节模板 | 每个文件结构 |
| #8 | DRY 运行时语义 | core.md 定义 + 其他引用 |
| #9 | 错误示例 | 每个文件有错误示例 |
| #10 | 行为差异表 | editor.md 对比表 |
| #11 | 决策树 | core.md ASCII 图 |
| #12 | patterns.md P2 计划 | 设计文档中记录 |
| #13 | description 关键词 | 每个文件 frontmatter |
