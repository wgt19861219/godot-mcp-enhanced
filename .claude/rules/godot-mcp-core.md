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
