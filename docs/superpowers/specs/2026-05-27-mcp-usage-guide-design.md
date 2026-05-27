# MCP 使用规范文档设计

> 日期：2026-05-27
> 状态：审查修订版 v2
> 目标受众：AI 代理开发者
> 审查修订：13 项发现全部采纳

## 背景

项目有 130+ 个 MCP 工具，24 个子系统。使用方法分散在 README（工具列表）、过时的 demo-log、和 setup_project_rules 生成的规则中。
设计目标：为 AI 代理开发者提供完整的工具使用指引。

## 方案：混合策略 + 分批交付

### 分层结构

1. **CLAUDE.md 速查表**：~20 行表格，始终可见，覆盖全部子系统入口
2. **核心指南** (`godot-mcp-core.md`)：模式选择决策树 + 核心工具用法，始终可见
3. **子系统 rule 文件**：详细指南，`alwaysApply: false` 按需加载

### 与 setup_project_rules 的关系

`setup_project_rules` 生成的 `.claude/rules/godot-mcp.md` 是基础规则（始终可见），包含工具映射表和基础用法。
本次新增的 rule 文件是详细指南（按需加载），覆盖基础规则未涉及的深度内容。两层共存互补。

### Claude Code rule 文件配置

所有 rule 文件使用以下 frontmatter 格式（解决 #5 和 #13）：

```yaml
---
description: "详细指南关键词列表，包含所有关联工具名"
alwaysApply: false
---
```

`description` 中包含所有关联工具名和关键概念词，确保 Claude Code 在相关场景下能匹配加载。
`alwaysApply: false` 避免所有文件同时加载消耗上下文。

## 分批交付计划

### P0：核心 + 高频子系统（本次实施）

| 文件 | 内容 | 行数 | alwaysApply |
|------|------|------|-------------|
| `CLAUDE.md`（追加） | 全部子系统速查表格 | ~20 行 | — |
| `.claude/rules/godot-mcp-core.md` | 模式选择决策树 + 核心工具用法 + 运行时语义 | 80-120 行 | true |
| `.claude/rules/godot-mcp-editor.md` | Editor WebSocket 模式 | 80-120 行 | false |
| `.claude/rules/godot-mcp-bridge.md` | Game Bridge 系统 | 80-120 行 | false |
| `.claude/rules/godot-mcp-ui.md` | UI 布局工具链 | 80-120 行 | false |
| `.claude/rules/godot-mcp-recording.md` | 录制/回放系统 | 80-120 行 | false |

### P1：剩余高频子系统（后续实施）

| 文件 | 内容 | 行数 |
|------|------|------|
| `.claude/rules/godot-mcp-particles.md` | 粒子系统（5 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-tilemap.md` | TileMap 编辑（8 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-animation.md` | 动画播放器 + AnimationTree（6 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-navigation.md` | 导航系统（5 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-material.md` | 材质/着色器（3 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-signal.md` | 信号系统（4 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-audio.md` | 音频系统（4 工具） | 80-120 行 |
| `.claude/rules/godot-mcp-workflow.md` | 工作流引擎（3 工具） | 80-120 行 |

### P2：跨系统模式（P0 后补充）

| 文件 | 内容 | 行数 |
|------|------|------|
| `.claude/rules/godot-mcp-patterns.md` | 跨子系统工作流模式 | 80-120 行 |

### P3：低频子系统（按需）

IK 框架、性能分析、3D 物理/空间、场景/脚本/项目、API 文档、测试/模板等低频子系统。
这些子系统的 README 工具列表描述已足够，仅在发现 AI 误用时补充 rule 文件。

## 统一 rule 文件模板（解决 #7）

所有 rule 文件严格遵循 5 节结构：

```markdown
---
description: "关键词：工具名1 工具名2 概念词A 概念词B"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构（~10 行）
- 子系统是什么、解决什么问题
- 与其他模式/子系统的关系
- 前提条件

## 工具清单与对比（~15 行）
- 工具列表 + 简要说明
- 与 headless/editor 模式的行为差异（如适用）

## 使用指南（~30 行）
- 核心工作流步骤
- 关键参数要点
- 模式选择指引

## 调用示例（~25 行）
- 2-3 个成功路径示例（参数 + 返回值）
- 1 个错误处理示例（参数无效/连接失败等）

## 常见陷阱（~10 行）
- 静默失败场景
- 易混淆概念
- 性能/安全注意事项
```

### DRY 规则（解决 #8）

运行时语义（"运行时操作不持久化到 .tscn"）在 `godot-mcp-core.md` 中定义一次。
其他 rule 文件引用：
```
> 运行时工具，不持久化。详见 godot-mcp-core.md "运行时 vs 持久化" 一节。
```

## CLAUDE.md 速查表（解决 #2）

在 CLAUDE.md 末尾追加：

```markdown
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

## P0 详细指南设计

### 核心指南 (`godot-mcp-core.md`)（解决 #6, #8, #11）

**alwaysApply: true**（始终可见，AI 需要在每次调用时参考）

**description**: "godot-mcp 核心指南 模式选择 Headless Editor Bridge execute_gdscript edit_script dev_loop run_and_verify"

**内容**：

#### 1. 概述与架构（~10 行）
- MCP 工具三层架构：Headless CLI → Editor WebSocket → Game Bridge
- `setup_project_rules` 生成的基础规则与本指南的关系

#### 2. 模式选择决策树（~15 行，解决 #11）

```
需要操作什么？
├─ .tscn/.gd 文件（静态）
│   ├─ 精确编辑 → Headless（edit_script/write_script）
│   └─ 批量创建 → Headless（batch_add_nodes/batch_create_files）
├─ 编辑器中打开的场景（实时）
│   ├─ 有编辑器连接？→ Editor 模式（editor_sync + add_node）
│   └─ 无连接 → Headless（read_scene + add_node + save_scene）
├─ 运行中的游戏（动态）
│   ├─ 只读查询 → Bridge game_query
│   ├─ 修改状态 → Bridge game_write
│   └─ 模拟输入 → Bridge game_input + game_wait
└─ 一次性验证
    ├─ 快速检查 → run_and_verify
    ├─ 完整交付 → verify_delivery
    └─ 语法检查 → validate_scripts
```

#### 3. 核心工具使用决策（~30 行，解决 #6）
- **execute_gdscript**：片段模式 vs 完整类模式、load_autoloads 何时开启
- **edit_script**：search_and_replace（推荐）vs 行范围、smart vs raw 缩进
- **dev_loop**：何时用 dev_loop（一体化）vs 单独工具（灵活组合）
- **run_and_verify vs 手动组合**：快速检查 vs 精细控制

#### 4. 运行时语义（~10 行，解决 #8）
- 定义一次：哪些工具是运行时操作、不持久化到 .tscn
- 持久化方法：add_node + save_scene（非运行时工具）
- 引用方式：其他 rule 文件用 `> 详见 core.md` 引用

#### 5. 调用示例（~20 行）
- execute_gdscript 片段模式 + 结构化输出
- edit_script search_and_replace 最佳实践
- dev_loop 基本用法

#### 6. 常见陷阱（~10 行）
- 运行时工具不持久化的混淆
- execute_gdscript 忘记 `_mcp_done()`
- edit_script 行号偏移问题

### Editor WebSocket (`godot-mcp-editor.md`)

**description**: "editor websocket editor_sync_start editor_sync_stop editor_get_scene_tree launch_editor 编辑器 场景树同步 undo plugin"

**内容**（5 节模板）：

#### 1. 概述与架构（~10 行）
- 双模式架构：Headless（独立进程）vs Editor（连接运行中的编辑器）
- Editor 通过 WebSocket JSON-RPC 2.0 连接 `addons/godot_mcp_server/` 插件
- 自动检测连接状态，无连接时回退 headless

#### 2. 工具清单与对比（~15 行，解决 #10）
- Editor 独有：editor_sync_start/stop、editor_get_scene_tree
- 仅 Headless：execute_gdscript、query_scene_tree、inspect_node
- 行为差异表：
  | 工具 | Headless 行为 | Editor 行为 |
  |------|-------------|------------|
  | add_node | 需指定 scene_path，创建后需 save_scene | 操作当前打开场景，实时刷新 |
  | edit_node | 需指定 scene_path | 操作当前选中节点 |
  | remove_node | 需确认令牌 | 需确认令牌 + 支持 undo |

#### 3. 使用指南（~20 行）
- 连接流程：launch_editor → 自动检测（端口 13100）→ 工具路由切换
- GODOT_MCP_NO_FALLBACK 环境变量
- 场景树同步：editor_sync_start 推送 node_added/node_removed 事件

#### 4. 调用示例（~25 行，解决 #9）
- 成功：启动编辑器 + 启动同步 + 获取场景树
- 成功：监听节点变化
- **错误**：编辑器未安装插件时的连接失败处理

#### 5. 常见陷阱（~10 行）
- 连接失败（插件未安装）
- 超时（编辑器启动慢）
- 与 headless 的选择策略
- forward 机制：未知工具名自动转发到插件

### Game Bridge (`godot-mcp-bridge.md`)

**description**: "game bridge game_query game_input game_write game_wait game_bridge_install game_bridge_uninstall bridge 运行时 TCP WebSocket 密钥认证"

**内容**（5 节模板）：

#### 1. 概述与架构（~10 行）
- Bridge 是运行时通信层：MCP 服务端 ↔ TCP ↔ 运行中的游戏
- 三层区别：Headless（独立进程）vs Editor（连接 IDE）vs Bridge（连接运行时游戏）
- 使用场景：E2E 测试、运行时调试、输入模拟、状态验证

#### 2. 工具清单与对比（~15 行）
- **game_query**（7 method）：ping/get_tree/find_nodes/get_node_properties/get_performance/get_viewport_info/take_screenshot
- **game_input**（4 method）：send_key/send_mouse_click/send_mouse_move/send_text
- **game_write**（2 method）：set_node_property/call_method
- **game_wait**（2 method）：wait_for_node/wait_for_property
- 安装：game_bridge_install / game_bridge_uninstall

#### 3. 使用指南（~20 行）
- 安装流程：game_bridge_install → 注册 autoload → 生成密钥 → 配置端口 9081
- 安全：密钥文件 + 127.0.0.1 绑定 + 读后即删
- 与 dev_loop 集成：bridge 参数在 dev_loop 中的使用方式

#### 4. 调用示例（~25 行，解决 #9）
- 成功：检查游戏运行（ping → get_tree → find_nodes）
- 成功：模拟输入（send_mouse_click → wait_for_node → get_node_properties）
- 成功：修改运行时状态（set_node_property / call_method）
- **错误**：Bridge 未连接时的错误处理

#### 5. 常见陷阱（~10 行）
- Bridge 未连接（游戏未运行或 autoload 未安装）
- 密钥文件权限问题
- 与录制系统的依赖关系（录制需要 Bridge）

### UI 布局 (`godot-mcp-ui.md`)

**description**: "ui ui_create_control ui_build_layout ui_set_layout ui_get_layout ui_anchor_preset ui_set_theme ui_container_add ui_draw_recipe theme_create theme_set_property CSS flexbox grid 布局 容器 锚点"

**内容**（5 节模板）：

#### 1. 概述与架构（~10 行）
- CSS Flexbox/Grid → Godot Container 树翻译
- 两种使用方式：单节点操作（ui_create_control）vs 批量布局（ui_build_layout）
- 运行时工具，不持久化。详见 core.md

#### 2. 工具清单与对比（~15 行）
- 批量布局：ui_build_layout（声明式 + 递归 children）
- 单节点：ui_create_control + ui_set_layout + ui_anchor_preset
- 容器操作：ui_container_add
- 绘图：ui_draw_recipe（7 种操作：rect/circle/line/arc/polygon/polyline/string）
- 主题：theme_create + theme_set_property + ui_set_theme
- 支持的 29 种 Control 子类

#### 3. 使用指南（~20 行）
- ui_build_layout tree 结构：type/name/properties/anchor_preset/layout/flex/children
- layout 字段：direction(row/column/grid)/justify/align/gap/padding
- flex 字段：grow/min_width/min_height/align_self
- children 递归（最大深度 10）

#### 4. 调用示例（~25 行，解决 #9）
- 成功：Flexbox 行布局（HBox 按钮组）
- 成功：Grid 布局（设置面板 2 列）
- 成功：draw_recipe HP 条
- **错误**：无效 Control 类型处理

#### 5. 常见陷阱（~10 行）
- 运行时 vs 持久化混淆
- 容器嵌套规则（Container 的子节点必须是 Control）
- CSS 属性不支持时的回退

### 录制/回放 (`godot-mcp-recording.md`)

**description**: "recording recording_start recording_stop recording_save recording_load recording_play 录制 回放 输入事件 bridge E2E 测试"

**内容**（5 节模板）：

#### 1. 概述与架构（~10 行）
- 录制系统捕获输入事件（键盘/鼠标），保存为 JSON，可回放
- 依赖 Game Bridge（输入事件通过 Bridge 发送）
- 使用场景：E2E 测试录制、回归测试、操作复现

#### 2. 工具清单与对比（~15 行）
- recording_start — 开始录制（需要 Bridge 连接）
- recording_stop — 停止并返回事件 JSON
- recording_save — 保存到 res://recordings/（文件名必须匹配 recording_*.json）
- recording_load — 从文件加载
- recording_play — 回放（speed 倍速、events_json 参数）

#### 3. 使用指南（~20 行）
- 完整流程：start → 操作 → stop → save → load → play
- 事件格式：{version, duration_ms, events: [...]}
- 文件命名：recording_YYYYMMDD_HHmmss.json
- 文件名校验：sanitizeRecordingFileName 拒绝路径遍历

#### 4. 调用示例（~25 行，解决 #9）
- 成功：完整录制→保存→加载→回放流程
- 成功：与 game_wait 结合的 E2E 测试
- **错误**：Bridge 未连接时录制失败的错误处理

#### 5. 常见陷阱（~10 行）
- Bridge 未连接（录制依赖 Bridge）
- 文件名格式校验（必须 recording_*.json）
- 回放时序问题（速度倍速可能影响结果）

## 设计原则

1. **80-120 行上限**：每个 rule 文件精简，超出部分用 `> 详见 README.md 工具列表` 截断
2. **5 节模板强制**：概述→工具清单→使用指南→示例（含错误）→陷阱（解决 #7）
3. **错误示例强制**：每个 rule 至少 1 个错误处理示例（解决 #9）
4. **版本标记**：每个 rule 文件开头 `> 适用于 godot-mcp-enhanced v0.14.0+`（解决 #4）
5. **DRY**：运行时语义在 core.md 定义一次，其他文件引用（解决 #8）
6. **description 对齐**：所有 description 包含关联工具名和概念词（解决 #13）
7. **核心指南始终可见**：core.md 使用 alwaysApply: true（解决 #5）

## 审查修订记录

| # | 问题 | 决定 | 本版修订 |
|---|------|------|---------|
| #1 | 覆盖范围不足 | 分批 P0→P1→P2→P3 | 新增 P1/P2/P3 文件清单 |
| #2 | 速查表位置 | 保留在 CLAUDE.md | 扩展为 13 行表格 |
| #3 | setup_project_rules 关系 | 设计文档补充说明 | 新增"与 setup_project_rules 的关系"一节 |
| #4 | 版本同步 | 轻量标记 | 模板增加版本标记 |
| #5 | 加载机制 | alwaysApply: false | 新增 Claude Code 配置格式说明 |
| #6 | 核心工具指南 | 新增 core.md | 新增核心指南完整设计 |
| #7 | 统一模板 | 5 节模板强制 | 新增统一模板定义 |
| #8 | DRY | 基础 rule 定义一次 | core.md 定义运行时语义，其他引用 |
| #9 | 错误示例 | 每个 rule 至少 1 个 | 每个示例章节标注错误示例 |
| #10 | 工具对比详细化 | 含具体行为差异 | Editor 指南增加行为差异表 |
| #11 | 决策树 | core.md ASCII 图 | core.md 增加 3 层决策树 |
| #12 | 跨系统模式 | 新增 patterns.md | 列入 P2 计划 |
| #13 | 触发词对齐 | description 含关键词 | 每个 rule 设计指定 description 内容 |
