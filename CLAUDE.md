# Godot MCP Enhanced 项目配置

## MCP 工具验证规则

编辑 `.gd` 文件后，验证语法有两个层次：
- `validate_scripts`（MCP 工具）：逐脚本 Godot `load()` 编译，能报真实 Parse Error（含块缩进）。不等于项目级完整编译：全新或从未导入的项目先导入一次，否则引用 `class_name` 的脚本会报错；返回 `incomplete: true` 表示校验器没跑完，不算通过。
- `npm run check:gdscript`：项目级完整编译（整项目一起编译，**改 `addons/**/*.gd` 后必须跑**）。需 `GODOT_PATH`。

使用 `edit_script` 时优先选择 `search_and_replace` 模式（CRLF 安全、行号偏移鲁棒）。

## 发版门禁

每次发版前必须运行 `verify_delivery`，确保场景树完整性 + 脚本健康 + 性能正常 + 自定义断言通过。

## MCP 子系统速查（详细指南见 .claude/rules/godot-mcp-*.md）

| 子系统 | 入口工具 | 核心能力 | 前提 | rule 文件 |
|--------|---------|---------|------|----------|
| **模式选择** | — | Headless/Editor/Bridge 决策树 | — | core |
| **引擎陷阱** | — | Godot 引擎行为知识（无错误提示的隐蔽陷阱，按工具分组） | — | engine-quirks |
| Editor | launch_editor | 实时场景树同步、undo | 编辑器运行中 | editor |
| Bridge | game_bridge_install | 查询/输入/写入/等待/监控/信号/UI发现 | 游戏运行中 | bridge |
| UI 布局 | ui_build_layout | CSS Flexbox/Grid 翻译 | headless | ui |
| 录制回放 | recording_start | 捕获→保存→回放 | Bridge 连接 | recording |
| 粒子 | particles_create | GPU 粒子 + 6 种预设 | headless | core |
| TileMap | tilemap_read | 读写/填充/复制/变换 | headless | core |
| 动画 | animation | 播放/编辑/AnimationTree | headless | core |
| 导航 | nav_create_region | Region/Agent/Link | headless | engine-quirks |
| 材质 | material_read | 材质读写/着色器 | headless | engine-quirks |
| 信号 | signal_connect | 连接/断开/发射/列出 | headless | core |
| 音频 | audio_play | 播放/停止/参数/状态 | headless | core |
| 工作流 | dev_loop | 执行→验证→截图一体化 | headless | core |

> 注：particles/tilemap/animation/signal/audio 无专属 rule 文件（运行时工具，见 core.md「运行时 vs 持久化」段；GPU 粒子 headless 不渲染同 2D 截图空白限制）；material/navigation 陷阱见 engine-quirks.md；workflow 详见 core.md「dev_loop vs 单独工具」。editor/bridge/ui/recording 有专属 rule。

## src 目录分组规则

| 子系统形态 | 放置规则 |
|-----------|---------|
| 一个工具由 **≥2 个源文件**实现 | 建同名目录（如 `src/tscn/`、`src/tools/scene/`、`src/tools/ui/`、`src/tools/animation/`）|
| **单文件**实现 | 平铺在父目录（如 `src/tools/script.ts`）|

判定依据是"文件数 / 职责可分性"，**不是行数**。大文件（如 `script.ts` ~1000 行）只要单文件单职责就不拆。新增工具时：先单文件起步，需要拆分时再升级为目录。
