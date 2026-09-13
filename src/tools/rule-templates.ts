// src/tools/rule-templates.ts
// 详细子系统规则模板，供 setup_project_rules 写入目标项目
//
// ⚠️ 维护注意：本文件中的模板内容与 .claude/rules/godot-mcp-*.md 是两份独立副本。
// 更新规则时，必须同步修改两处：(1) .claude/rules/ 下的实际文件 (2) 此处的模板。
// 分发追踪由 .godot-mcp-manifest.json 解决（见 setup_project_rules 的 reconcile），
// 但模板源与 .claude/rules/ 仍需保持一致 —— CI 的 check-rules-version-bump 脚本
// 会在模板变更时强制要求 package.json 版本 bump。

/**
 * 所有详细规则文件的映射：文件名 → 内容
 * godot-mcp.md（基础规则）由 claudemd-builder.ts 的 GODOT_MCP_RULES 提供
 */
export const DETAILED_RULE_TEMPLATES: Record<string, string> = {
  'godot-mcp-core.md': `---
description: "godot-mcp 核心指南 模式选择 Headless Editor Bridge execute_gdscript edit_script dev_loop run_and_verify validate_scripts verify_delivery 运行时 持久化"
alwaysApply: true
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 概述与架构

godot-mcp-enhanced 提供 46 个 MCP 工具（271 个 action，权威数据见 docs/capability-matrix.md，由 \`npm run build-matrix\` 生成），通过三层架构操作 Godot：

1. **Headless CLI** — 独立 Godot 进程执行 GDScript，适合文件读写和一次性验证
2. **Editor WebSocket** — 连接运行中的编辑器插件，适合实时场景操作
3. **Game Bridge** — TCP 连接运行中的游戏，适合运行时调试和 E2E 测试

\`setup_project_rules\` 生成的 \`.claude/rules/godot-mcp.md\` 是基础规则（始终可见）。
本指南是核心决策参考，子系统详细指南在 \`.claude/rules/godot-mcp-*.md\` 中按需加载。

## 模式选择决策树

\`\`\`
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
\`\`\`

## 核心工具使用决策

### execute_gdscript — 动态执行

- **片段模式**（默认）：无需 \`extends\`，代码自动包装为 \`extends SceneTree\`。用 \`_mcp_output(key, value)\` 返回结构化结果，用 \`_mcp_done()\` 结束执行。
- **完整类模式**：手写 \`extends SceneTree\`，适合需要 \`_process()\` 或复杂生命周期的场景。
- **load_autoloads=true**：在完整项目环境中运行，可访问 DataRegistry、PlayerData 等全局单例。启动较慢（需加载整个项目），仅在确实需要 Autoload 时开启。
- **注意**：片段模式中 \`func\`/\`var\`/\`const\` 声明自动放在类级别，语句行放在 \`_initialize()\` 体内。
- **⚠️ 沙箱安全限制（C-04 已知限制）**：GDScript 沙箱扫描基于正则匹配（非语法解析），设计用于防止**意外误操作**，**不可防御恶意/蓄意绕过**。已知绕过向量包括：
  - 字符串拼接：\`str("OS")+".cmd()"\` 或 \`%\` 格式化构造危险 API 名
  - 变量间接调用：通过 \`call()\` / \`funcref()\` 的非字面量参数绕过静态扫描
  - 注释中包含危险 API 名称会导致误报拦截（安全侧失败）
  - **适用场景**：本地单用户开发环境（信任调用者）。**不适用于多用户/远程/不可信输入场景**——后者需要容器/VM 隔离 + \`GODOT_MCP_ALLOW_UNSAFE=false\`
  - **write_script/edit_script 也走沙箱扫描**：写入 .gd 前对内容调 \`scanGdscriptSandbox\`，发现已知危险 API 模式（清单不列举防被侦察）则阻断（SANDBOX_VIOLATION），与 execute_gdscript 同威胁面对齐。双 opt-in 旁路（\`UNRESTRICTED + DISABLE_SAFETY\`）

### edit_script — 脚本编辑

- **优先使用 search_and_replace**：基于内容匹配，对行号偏移鲁棒，CRLF 安全。**⚠️ 不要使用 Claude 内置 Edit 工具编辑 .gd 文件**——内置 Edit 无法正确处理 GDScript 的 tab 缩进，匹配率极低。始终使用 MCP 的 \`edit_script\` + \`search_and_replace\` 参数。
- **search_and_replace 免确认**：使用 \`search_and_replace\` 模式的 \`edit_script\` 无需 confirmation token，直接执行，减少 API 调用。
- **行范围模式**（start_line/end_line）：仅在 search_and_replace 无法使用时（如批量重复修改）。仍需 confirmation token。
- **indent_mode**：\`smart\`（推荐）自动对齐缩进；\`raw\` 仅在确认缩进正确时使用。
- **verify_content**：提供期望内容作为守卫，防止过时的行号编辑。

### dev_loop vs 单独工具

- **dev_loop**：执行 GDScript → 可选验证 → 可选 Bridge 查询/截图 → 可选断言 → 可选状态保存。适合一体化验证流程。
- **★ dev_loop 的 \`code\` 全行匹配 E2E DSL 会静默切 Bridge 序列**：若 \`code\` 每一非空行都匹配 DSL 语法（\`waitFor(...)\`/\`click(x,y)\`/\`press(...)\`/\`typeText(...)\`/\`waitMs(...)\`），dev_loop **不执行 GDScript，而是逐行作为 Bridge 命令**发送（返回 \`mode: "dsl"\`）。传含 \`click(100,100)\` 的内容会被当 bridge 脚本——意图跑 GDScript 时避免整段恰好全是 DSL 语法。
- **dev_loop \`acceptance.assertions\` 三类型前置条件**：\`gdscript\`（默认，headless 跑断言脚本）、\`screenshot_diff\`（**需 Bridge 连接**，take_screenshot + 可选余弦相似度预筛 + 可见性检查）、\`frame_degradation\`（**需先 \`frame_sequence\` 捕获帧**或手动提供 \`frames_dir\`，否则无帧可比）。用高级断言前先确认前置满足。
- **单独工具**：execute_gdscript + validate_scripts + run_and_verify 灵活组合。适合多步调试或需要中间检查的场景。

### debug — 断点管理（editor-only）

- **set_breakpoint**：在 GDScript 指定行设断点（走 CodeEdit gutter，gutter 可见 + 现行 game 命中 + 下次 run 同步保持）。
- **clear_breakpoint**：清除指定行断点。
- **list_breakpoints**：列出当前活跃 tab 脚本的断点。
- **⚠️ Phase 1 限制**：脚本必须在编辑器中打开且是当前活跃 tab。headless 模式返回 EDITOR_ONLY。

### dap — DAP 断点调试（P9，TS 直连 editor DAP server）

LuoxuanLove 移植：MCP server 直连 Godot editor 自带 DAP server（Debug Adapter Protocol，默认 127.0.0.1:6006）——引擎官方调试协议，比对标竞品"按图标找调试器按钮"的面板 hack 稳。与 \`debug\` 工具（editor 插件 EditorDebuggerPlugin 路径）并存互补；断点/单步调试优先用本工具。

- **前置（一次性）**：editor 开启调试服务器——Editor Settings → Network → Debug Adapter（默认端口 6006）；launch 调试还需 Debug 菜单勾选 "Deploy with Remote Debug"。未开启时 \`initialize\` 报 DAP_UNAVAILABLE（附开启指引）。
- **会话流（三段状态机，乱序拒）**：\`initialize\`（建 TCP + DAP 握手）→ \`launch\`（让 editor 启动调试会话；或 \`attach\`）→ \`set_breakpoint\`（可多次）→ \`configuration_done\`（断点下发完成）→ 断点命中后 \`stack_trace\` / \`step_over\` / \`continue\` / \`pause\`；\`output\` 收集调试输出；\`disconnect\`（可选 terminate_debuggee）/\`terminate\` 收尾。
- **断点语义**：本地簿记 + \`setBreakpoints\` 全量重发（DAP 全量协议）；上限 512 sources × 256 lines；\`list_breakpoints\` 读本地簿记。source_path 接受 \`res://\`（须配 project_path 转绝对路径）或绝对路径。
- **安全**：host 强制 loopback（127.0.0.1/localhost/::1；远程需 set_settings allow_remote_hosts 显式开）；DAP 响应经 sensitive-key 清洗（token/password/authorization/bearer 等键值 → [redacted]，防调试输出泄漏 secret）；超时上限 30s；会话上限 8。
- **限制（诚实声明）**：只覆盖 GDScript（C# 断点需 .NET debugger，引擎 DAP scope）；\`attach\` 对 Godot DAP 支持有限（协议层透传，由 server 行为决定）；\`stack_trace\` 需暂停在断点；e2e 未覆盖真 editor（单测用 mock DAP server 覆盖协议层/状态机/清洗/上限，真 editor 路径手动验证）。
### engine — 实时 ClassDB 内省（editor-only）

- **class_info**：查单个类的完整结构（属性/方法/信号/枚举/继承），默认 no_inherit=true 只看本类 own 成员。
- **search**：substring 匹配类名（返回 {name, parent} 列表，上限 100 条）。
- **get_inheritance**：返回类的继承链（从本类到 Object）。
- **vs docs**：docs 是静态 4.7 快照（离线），engine 是运行中引擎的真实 ClassDB（含第三方 addon/自定义类/实际版本差异）。

### run_and_verify vs 手动组合

- **run_and_verify**：一键 headless 运行 + 错误分析 + 可选场景树快照。适合快速检查。**自动读取 project.godot 的 autoload 配置**，将 autoload 单例相关的"Identifier not found"错误标记为 headless_limitation 而非真实错误，减少误报。
- **手动组合**：run_project + get_debug_output + stop_project。适合需要精细控制运行时长的场景。
  - \`run_project\` 支持 \`wait_for_bridge\` 参数（默认 false）：true 时等待 Bridge 就绪再返回（用 \`game-bridge.isBridgeReady\` 零接触探测）。
  - \`run_project\` 支持 \`bridge_timeout\` 参数（默认 10 秒）：等待 Bridge 就绪的最大超时时间。
  - \`run_project\` 支持 \`preview\` 参数（默认 false）：true 时禁用自动停止，游戏窗口常驻，用户关闭窗口即结束——用于 AI 改完视觉内容后的收尾验证（见下「视觉改动收尾流程」）。

### 视觉改动收尾流程（preview 预览模式）

AI 改动涉及用户需要看到效果才能验收的内容（\`.tscn\` / UI 脚本 / 样式 / 场景结构等）后，收尾动作不是让用户打开编辑器：

1. \`validate_scripts\` 快速语法验证（避免弹一个崩溃的窗口）；
2. \`run_project(preview=true)\` 弹出常驻游戏窗口；
3. 告知用户"游戏窗口已弹出，请确认效果，关闭窗口即验证结束"；
4. 用户关窗后 \`get_debug_output\` 检查运行时错误并汇报（运行结束后输出仍可读，\`source\` 标注 \`last_finished_run\`）。

- 纯逻辑 / 测试 / 文档改动不弹窗。
- preview **默认不传 \`wait_for_bridge\`**：bridge 未就绪会终止游戏进程，窗口会在用户眼前闪现即逝；仅当确实需要 bridge 查询运行时状态且项目 bridge 就绪快时才组合。
- 新一轮 \`run_project\` 会先停旧进程再起新窗口；旧输出经快照自动留档，换窗前可先 \`get_debug_output\` 保存上一轮错误。

## 运行时 vs 持久化

部分工具在 headless 进程中创建/修改节点，但**这些变更不持久化到 .tscn 文件**：

- **运行时工具**（不持久化）：signal(action=connect/disconnect/emit)、scene(action=create_3d_node)、physics(action=raycast)、tilemap_*、audio_*、particles_*、ui_*、runtime(action=record_*) 等
- **持久化方法**：使用 add_node（写入 .tscn）+ save_scene 保存。或用 write_script / edit_script 修改 .gd 文件。

> 运行时工具适合验证和测试。若需持久化场景修改，必须使用 add_node + save_scene。

## Headless 截图限制（2D 与 3D）

Headless 模式下场景截图可能完全空白——headless 进程默认用 **RendererDummy**（无 GPU 渲染后端），不初始化渲染服务器，2D CanvasItem 与 3D mesh 都不渲染像素。实测 Godot 4.7 headless 加载 3D 场景得 \`DummyMesh/DummyCamera/DummyMaterial\` 泄漏，截图全背景色空白（PIL 色散 spread=0）。**3D 同样受影响**，非仅 2D。

**推荐工作流**：
1. 用 \`screenshot(action=capture)\` 尝试截图
2. 如果返回 \`BLANK_DETECTED\` 警告，使用以下替代方案：
   - 用户手动截图（F5 运行后截图）
   - \`screenshot(action=analyze)\` 返回图片的 base64 数据供 AI 视觉分析（需配合 \`image_path\` 指定本地文件）
   - Bridge \`take_screenshot\`（游戏运行时 GPU viewport 渲染，2D/3D 均可）
3. 3D 视觉确认同理需 GPU 模式（Bridge 或 editor/GUI）；headless 下用数据铁证替代（场景加载成功 + ArrayMesh 顶点数据 + 几何拓扑 χ）

## 常见陷阱

- **忘记 \`_mcp_done()\`**：片段模式中如果没有调用 \`_mcp_done()\`，执行会超时。
- **edit_script 行号偏移**：多步编辑后行号会变化。始终优先使用 search_and_replace。
- **运行时操作误认为持久化**：运行时工具的修改在 headless 进程退出后丢失。
- **load_autoloads 性能开销**：仅在需要 Autoload 单例时开启，否则启动时间增加 3-5 倍。
- **Bridge 密钥过期**：Bridge 密钥有 5 分钟 TTL 缓存，长时间未操作后首次调用可能稍慢。
- **Headless 截图空白（2D/3D）**：Headless 用 RendererDummy 无渲染后端，2D CanvasItem 与 3D mesh 均不渲染像素。使用 Bridge take_screenshot（GPU viewport）或手动/GUI 截图替代。
- **run_and_verify 可能残留进程**：headless 模式下交互式场景（不自动退出）可能残留 Godot 进程。如果后续 \`run_project\` 报 "another Godot process is running"，先调用 \`stop_project\` 清理残留进程。
- **orphan 扫描会话隔离（多会话安全，v0.x+）**：\`stop_project\` 的 orphan 清理**默认只清本会话 \`run_project\` 启动过、脱离管理且仍存活的 Godot 进程**（按 PID 集合，非全系统扫描）。多个并发会话操作同一项目时，互不误杀对方的编辑器/游戏进程。\`launch_editor\` 启动的编辑器**不纳入** orphan 清理（detached，用户有意长期运行，永不被自动杀）。崩溃恢复场景（MCP server 重启后内存 PID 集合丢失）：设环境变量 \`GODOT_MCP_FULL_SYSTEM_SCAN=true\` 后调 \`stop_project\`，恢复 V-01 全系统扫描兜底（按项目目录匹配，会清所有匹配的 Godot，慎用）。**此 opt-in 非缺陷，是多会话安全的有意设计（B9）**。
- **load_autoloads=true 片段模式差异**：\`load_autoloads=true\` 时片段包装为 \`extends Node\`（非 \`extends SceneTree\`），\`get_root()\` 不可用。需要手写 \`extends SceneTree\` 完整类模式来访问 SceneTree API。
- **load_autoloads autoload 层级**：\`load_autoloads=true\` 时 autoload 节点不直接挂在 \`get_root()\` 下，而是通过 autoload 系统加载。使用 \`Engine.get_main_loop().get_root().get_node("autoload/Xxx")\` 访问。
- **remove_node 路径格式**：使用 \`父名#子名\` 格式（如 \`Main#ValidationLabel\`），而非 \`/\` 分隔路径。先用 \`query_scene_tree\` 确认节点名。
- **ui_build_layout 必须传 scene_path**：不传 \`scene_path\` 会报错 "Failed to load scene"。所有 \`ui_build_layout\` 调用必须包含 \`scene_path\` 参数。
- **screenshot analyze 返回格式**：\`screenshot(action=analyze)\` 返回图片 base64 数据（非文字描述），需配合 \`image_path\` 参数指定本地 PNG/JPG 文件路径。它不会自动对截图做 AI 文字分析，而是将图片数据返回给调用方做视觉检查。
- **findGodot 缓存 + env 固化（M3, v0.18.x+）**：\`findGodot\` 首次解析后缓存（\`_pathCache\`），且 Node 进程 env 启动时固化。改 \`GODOT_PATH\` 环境变量后**需重启 MCP 服务端**才生效（env 进程级 + 缓存双固化；若新 env 未注入则 fallback PATH 上的 godot）。项目级覆盖用 \`.godot/mcp-godot.json\` 的 \`godot_path\` 或 project.godot \`[godot_mcp]\` 段（优先于 env，且每项目独立缓存）。
- **ALLOWED_PROJECT_PATHS 不热重载（M5, v0.18.x+）**：项目路径白名单从 \`process.env.ALLOWED_PROJECT_PATHS\` 读取（分号分隔），Node 进程 env 启动时由父进程注入并固化。改 settings.json 的 env 配置后**需重启 MCP 服务端（或宿主 Claude Code）**才生效——改完仍报 \`PATH_NOT_ALLOWED\` 多半是未重启。临时绕过：\`GODOT_MCP_UNRESTRICTED=true\`（仅本地开发）。
- **add_node 无节点级冲突检测（吸收自 ai-kit enhanced-boundaries #5）**：\`batch_add_nodes\` 后再单独 \`add_node\` 加同名子节点不会报错，可能产生重复节点（尤其同父路径，Godot 加载时拒绝）。add 前先 \`query_scene_tree\` 查目标父下是否已有同名节点，走"query → 条件 add"模式。实现层（\`src/tscn/tscn-editor-add.ts\` \`_addNodeInner\`）无同级重名扫描；defects.md \`addnode-no-duplicate-check\`（OPEN）跟踪实现层修复。
- **validate_scripts vs run_and_verify 可能不一致（吸收自 enhanced-boundaries #4）**：validate_scripts 跑 headless 验证器脚本（捕跨文件编译依赖），但不等于实跑场景（运行时动态行为/场景加载）。关键验证结论（如"脚本通过"）用 validate_scripts + run_and_verify 交叉确认，不一致时以 run_and_verify 实跑为准。
- **load_skill 召回的是参考代码（吸收自 enhanced-boundaries #12）**：\`load_skill\` 检索第三方 skill 库（GodotPrompter / gd-agentic 等）召回的 scripts 是教学示例，非生产代码（可能含硬编码密钥 / null 崩溃 / 未验证模式）。复制到生产项目前必须人工审。
- **未知参数被拒 + did-you-mean（P8, 2026-09-12）**：所有工具的顶层未声明参数（不在 inputSchema properties 中）一律拒绝——早期 additionalProperties 静默容忍已反转（regiellis 模式移植）；拼写接近时返回 did-you-mean 建议（Levenshtein 相似度 > 0.4，如 alpah → 想传 alpha?）。inputSchema 是参数 SSOT：handler 私下读取的键必须声明进 schema（CI \`check:ssot-params\` 审计声明面↔使用面零漂移，白名单 scripts/ssot-allowlist.json 记录有意例外；dispatcher 级公共键 \`godot_path\` 豁免——ToolDispatcher 对所有工具读它做 per-call Godot 二进制覆盖，~19 个未声明它的 headless 工具同样支持，P8 审查 B-1 清偿）；传错参数名会立刻报错而非被静默忽略。
`,

  'godot-mcp-bridge.md': `---
description: "game bridge game_query game_input game_write game_wait game_bridge_install game_bridge_uninstall 运行时 TCP 密钥认证 端口 9081 autoload mcp_bridge E2E 测试 调试"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}

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
| \`game_bridge_install\` | 安装 Bridge autoload 到项目（注册 autoload + 配置端口 9081） |
| \`game_bridge_uninstall\` | 卸载 Bridge autoload |

### 查询 — game_query

| method | 说明 |
|--------|------|
| \`ping\` | 检查游戏是否运行 |
| \`get_tree\` | 获取场景树结构 |
| \`find_nodes\` | 按名称/类型/路径查找节点。params 可传 root 限定子树搜索范围（推荐绝对路径如 /root/Main；节点不存在时报错非静默全树）；near_node+max_distance 近邻查询（锚点须 Node2D/Node3D，只收同维度节点按距离升序含 distance 字段，锚点自身排除；max_distance 默认 1000）；observation_profile 观察档见「语义观察层」段 |
| \`get_node_properties\` | 获取节点属性值 |
| \`get_node_layout\` | 获取节点完整布局快照（type + position/global_position 成对 + Control anchor/offset + Sprite2D centered + Node3D Vector3，全走 _jsonify） |
| \`get_performance\` | 获取性能统计（FPS/内存等） |
| \`get_viewport_info\` | 获取视口信息 |
| \`take_screenshot\` | 从运行中的游戏截图 |
| \`get_errors\` | 查询游戏运行时错误（push_error/脚本报错/引擎错误），支持 \`since_seq\` 增量 + \`clear\` 读即焚 |
| \`clear_errors\` | 清空错误 buffer |

### 输入 — game_input

| method | 说明 |
|--------|------|
| \`send_key\` | 发送键盘事件（key + pressed） |
| \`send_mouse_click\` | 发送鼠标点击（x, y, button, pressed）。button 支持 int 1-9 或 left/right/middle |
| \`send_mouse_move\` | 移动鼠标（x, y；可选 button_mask 1=left/2=right/4=middle 位掩码，配合先 press 可模拟按住拖动） |
| \`send_text\` | 输入文本（text） |
| \`send_input_sequence\` | H1(2026-08-20) 帧定时输入时间线（timeline=[{at_frame:1-600 开窗后第N帧, type:"action"/"key"/"mouse_click"/"mouse_move"/"touch"/"drag", ...事件参数}], settle_frames, wall_budget_ms）。延迟响应;owner 互斥同 control 层;frozen 下自动开窗播放+完成 refreeze;与 playtest.seed/fixed_delta 组合=确定性完全体。action 事件需 name 在项目 InputMap |

### 写入 — game_write

| method | 说明 |
|--------|------|
| \`set_node_property\` | 设置节点属性值（path + property + value） |
| \`call_method\` | 调用节点方法（path + method + args）。CMP-9-B(2026-08-08)增强:默认只读白名单(get/has_*/get_meta 等),env \`GODOT_MCP_BRIDGE_EXTRA_METHODS=method1,method2\` 可扩展(含写方法如 take_damage),或游戏侧在节点脚本声明 const \`GDA_CALLABLE\` := ["方法名"](per-node 声明白名单,2026-09-11,default deny,零执行静态枚举);\`EXTRA_METHODS_BLOCKLIST\`(free/queue_free/set_script/call/emit_signal 等)是不可覆盖硬底线(env/声明均不可越过);args 按方法声明类型自动强转(传 [1,2,3] 给 Vector3 参数正确转换);强转不可达组合(个数不足/超出、类型不可转如 String→int 非数字、Dictionary→Object、typed Array)调用前显式报错 code -10(P0-1,防 callv 静默失败返回 null 被误读为成功);方法不存在时返回 did-you-mean 建议;response 含 undoable=false(call 不可 undo) |

### 等待 — game_wait

| method | 说明 |
|--------|------|
| \`wait_for_node\` | 等待节点出现（path） |
| \`wait_for_property\` | 等待属性值变化（path + property + value） |

### 监控 — monitor_start/stop/poll

| action | 说明 |
|--------|------|
| \`monitor_start\` | 开始属性采样（node_path + properties + interval_frames）。P0-3(2026-09-11):interval_frames 为 60fps 基准标称帧数,实际按游戏时间毫秒调度(interval_ms=interval_frames*1000/60),帧率变化节奏不漂移;paused/freeze 期间游戏时间停走不采样;样本含 t_game_ms 游戏时间戳。M-EXPLAIN(2026-09-01):返回 properties=实际监控列表,被安全过滤的属性逐个点名进 dropped_blocked;上限 20 属性/500 样本 |
| \`monitor_stop\` | 停止采样，返回完整时间线（附数值极值摘要 summary：min/max 及发生帧/时刻，仅数值属性） |
| \`monitor_poll\` | 获取当前采样数据（不停止；同样附 summary 与 interval_frames） |

### 信号监听 — watch_start/stop/poll

| action | 说明 |
|--------|------|
| \`watch_start\` | 监听信号事件（node_path + signal_name + max_events） |
| \`watch_stop\` | 停止监听，返回事件列表 |
| \`watch_poll\` | 获取已记录事件（不停止） |

### UI 发现 — find_ui_elements / click_button

| action | 说明 |
|--------|------|
| \`find_ui_elements\` | 查找可见 Control 节点（pattern / type / visible_only / limit / observation_profile），输出含 role/label 语义字段（见「语义观察层」段） |
| \`click_button\` | 点击按钮（text 或 path；real_event=true 走真实输入事件路径） |

### 弱网注入与自定义命令 — network_conditioner / custom_command

| action | 说明 |
|--------|------|
| \`network_conditioner\` | op=set/clear/status——包装 MultiplayerPeer 出向注入 latency_ms/loss_pct/jitter_ms（多人联机弱网测试，masteryee 同款 MultiplayerPeerExtension 装饰器） |
| \`custom_command\` | 调用游戏项目 res://mcp_commands/*.gd 声明的 custom.* 命令（method 必须以 custom. 开头，params 透传；支持运行中热加载，见下方「自定义命令热加载」段） |

### 自定义命令热加载 — mcp_commands 状态机（P8）

游戏运行中修改/新增/删除 \`res://mcp_commands/*.gd\` 会被 bridge 自动感知并重载（LuoxuanLove executor 模式移植），无需重启游戏：

- **扫描节奏**：每 300ms debounce tick 对比文件 mtime（\`_process\` 限频，无变更秒回）；变更标记 \`reload_pending\`。
- **quiesce 语义**：命令调用中（\`active_calls > 0\`）绝不换实例——重载/卸载推迟到调用归零（\`waiting_quiesce\`），防运行中 Callable 失效。
- **失败回滚**：新版本加载失败（非 Node/缺 get_commands/非 Dictionary 契约违反）→ slot 进 \`reload_failed\` + \`last_error\`，**旧实例与旧命令原样可用**（旧版本继续服务）。文件修好后下次 mtime 变更自动恢复。
- **独立加载（不走 ResourceLoader）**：新版本用 \`FileAccess\` 读源码 + \`GDScript.new()\` 独立对象加载——同路径 \`ResourceLoader.load\` 即使 \`CACHE_MODE_IGNORE\` 也会就地替换 ResourceCache 共享资源，旧实例的方法表随之消失（实测回滚保留的旧 Callable \`is_valid()=false\`）；独立对象加载失败即丢弃，旧脚本资源从未被触碰，回滚天然有效。
- **删除处理**：文件消失时若调用中则 \`removed_pending\` 等归零再卸载；空闲直接卸载 slot。
- **重名冲突**：多个 .gd 声明同一 \`custom.xxx\` → **路径字典序靠前者赢**（索引按 sort 顺序全量重建，与注册时间无关），后者 slot \`reload_failed\` 清空命令集（\`last_error\` 报 Duplicate）。
- **内建诊断**：\`game(action=custom_command, method=custom.list)\` 返回全部 slot 状态快照（state/version/commands/active_calls/pending_reload/last_error）——agent 可观察热加载结果与失败原因。
- **env 开关**：\`GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD=0\` 关闭热重载（退化为启动加载一次；mtime 变更不再触发重载，状态字段照常上报）。
- **⚠️ 已知引擎限制**：运行中写入**语法坏**的 .gd 会触发 Godot Script Debugger REPL（debug> 提示符停等 stdin，主循环挂死，bridge 不可防）——语法错误请在 IDE 侧先消灭；bridge 防线覆盖"合法语法但违反契约"的坏文件（如 extends RefCounted）。

### 多人状态同步 — sync_state（P10）

masteryee sync_state 移植裁剪——**快照/比对两段式原语，不做进程编排**（多游戏实例由用户/agent 起在各端口，bridge 端口避让已有；借连接切换打多个快照后比对）：

- **收集约定（游戏侧声明）**：节点实现 \`_mcp_state() -> Dictionary\` 即被 \`collect_state\` 收集（返回**离散状态**——wave/score/phase 等；浮点位置类建议游戏侧自行量化）。返回非 Dictionary 记 \`__error__\` 标记；嵌套 Object 递归降级 str()（不炸 JSON）；上限 256 节点/深度 8。
- **group 参数**（如 \`mcp_watch\`）：组内**无** \`_mcp_state\` 的成员记 \`{"__present__": true}\` 存在性标记——参与节点集比对（节点增删可测）。
- **快照流**：\`game(action=sync_state, sub_action=snapshot, label=host)\` 收集当前 bridge 状态存内存快照（进程生命周期）；切到另一实例连接再 snapshot(label=client)；\`sub_action=compare, label_a=host, label_b=client, tolerance=0.0001\` 比对；\`list\`/\`clear\` 管理快照。
- **浮点容差（关键设计——masteryee 亲读坑）**：数值 \`|a-b|<=tolerance\` 视为相等（默认 0.0001）；**Vector2/3/4/Color 自动转 \`{x,y,z}\` dict 走分量级容差**（裸几何类型经 JSON 序列化退化字符串会让容差完全失效——审查 B-1 清偿）；float 的 INF/NaN 降级字符串（防序列化漂移值语义）。原版 dict 严格相等比对在真实多人游戏**永远 false**（host/client 各自物理步进后浮点位置不逐位相等）——容差参数是该坑的修复，比对语义的一部分。
- **比对输出**：\`in_sync\` / \`paths_compared\` / \`missing_in_b\` / \`missing_in_a\` / \`diffs[{path,key,a,b}]\`（键级 diff，嵌套数值在容差内不报）。
- **典型用法**（多人同步验证）：起 host+client 两游戏 → 各自连接 → 同一逻辑时刻各 snapshot → compare 容差调到游戏可接受精度 → \`in_sync=true\` 证明状态同步；diffs 定位失步字段。
- **边界（诚实声明）**：collect_state **不经 P7 观察层**（observation_profile 不生效）——\`_mcp_state\` 是游戏方声明面（与 custom_command 同构，节点自己决定暴露什么），player 档下需过滤的由游戏方在 \`_mcp_state\` 内自实现；快照 label 进程内全局（跨实例场景建议带实例前缀防静默覆盖）；256 节点截断时响应含 \`truncated: true\`（两侧同截断可能漏比，扩容靠游戏侧收窄声明面）。

### 语义观察层 — observation_profile（P7）

观察通道（\`find_nodes\` / \`get_node_properties\` / \`get_node_layout\` / \`get_tree\` / \`find_ui_elements\` / \`monitor_start\` / \`watch_start\` / \`game_wait\` 的 wait_for_node·wait_for_property / \`call_method\` / playtest.step·step_until 的 report 搭车与 conditions）支持 \`observation_profile\` 参数（\`"debug"|"player"\`，默认 debug；game_query/game_wait/game_write 走 params 内同名键）：

- **debug**：直通现状——所有节点与属性全量可见（节点有规则也不投影）。
- **player**：投影档。**门禁三态**（env \`GODOT_MCP_BRIDGE_ALLOWED_PROFILES\`，启动时读一次）：未设/\`debug\` = 仅 debug（请求 player 得 -21，非法值 -20）；**单值 \`player\` = host 强制档**——全部观察请求被静默提升为 player（agent 不能自降级绕过投影，对齐 gua "profile 由 host 持有"）；多值 \`debug,player\` = 请求级可选（开发/测试模式）。生效行为：
  - **可见性级联**：节点或任一祖先 meta \`agent_exposure="private"\` 或 \`visible_to_player=false\`（bool 或字符串 "false"，均大小写不敏感）→ 整棵子树不可观察：不进 find_nodes/find_ui_elements/get_tree 结果（get_tree 整枝剪除）；get_node_properties/get_node_layout/monitor_start/watch_start/call_method 对其报 \`Node not found\`（存在性不泄露，报 404 而非 403）；wait_for_node 对其 exists=false；report 搭车/conditions 对其报 node not found。两维度正交：private=对象级整藏，visible_to_player=玩家不可见；与渲染 visible 无关（纯声明语义）。
  - **字段投影**：节点 meta \`agent_field_rules\`（Array，每条 \`{path, mode, replacement?, quantum?}\`；path 是输出 dict 键，支持 \`position.x/y/z\` 分量级；单节点上限 32 条，重复 path 后者覆盖）——\`omit\` 删键 / \`redact\` 数值归 0·bool 归 false·字符串换 "[redacted]" / \`replace\` 换声明替值（须安全标量，Object 型降级 redact）/ \`quantize\` 数值按 quantum snapped（整键作用于 dict 值如 position 时逐分量应用）。坏规则 fail-closed 降级为 redact（写错规则不会被惩罚成裸暴露）。规则每次查询实时读取，游戏运行中改 meta 即时生效（战争迷雾类动态语义）。
  - **call_method 读白名单同语义**：player 档下 \`get(prop)\` 返回值过字段投影（含 await_completion 协程路径）；结构枚举方法（get_children/get_child/get_child_count/get_parent/get_index/get_groups/get_incoming_connections/get_signal_connection_list）整组拒（-22——树已剪枝，枚举语义不成立且 index 两档漂移是错位陷阱，枚举请用 get_tree player 档）；其余白名单方法照常。
  - **wait_for_property / conditions**：current 显示与 match 比较均基于投影后值（防"显示投影值按真值 match"的二分探测侧信道）。
  - **playtest.snapshot / restore 在 player 档拒绝**（-23）——快照必须保真才能恢复，投影快照 restore 会把投影值写回游戏（语义冲突，诚实拒绝）。
  - **monitor/watch 中途隐藏**：采样/事件在节点不可观察期间静默跳过（时间线缺格），恢复可见自动续记；断线重连后订阅重发。
  - **near 联动**：player 档下 position 有任何字段规则的锚点被拒（-11，防距离差分反推隐藏/粗化坐标）、候选节点被静默排除。
  - **边界（诚实声明）**：watch 事件 args 不做字段投影（信号参数是位置参数无字段名——需要隐藏的信号把信号源藏进不可见子树，或不在 player 档监听）；**take_screenshot 是玩家视角的诚实呈现**（private 但渲染可见的节点在截图中视觉存在——渲染层的隐藏是游戏自己的 visible 逻辑，观察投影管数据通道不管像素）；写类操作（set_node_property/输入注入/click_button）不受观察档影响（授权走既有白名单三通道）；editor 层（read_scene 等 headless 文件操作）不经此层——"防看穿"覆盖 bridge 运行时数据通道。

\`find_ui_elements\` 输出含 \`role\`/\`label\`（**全档位**，语义信息非隐私）：Button→button、CheckBox/CheckButton→checkbox、OptionButton→combobox、Slider/SpinBox→slider、LineEdit/TextEdit→textbox、Label→text、ProgressBar→progressbar、ItemList→list、TabContainer→tablist、ScrollContainer→scrollarea、其余 Control→panel；label 取 text 类控件（Button/Label/LineEdit/TextEdit）的 text、OptionButton 取节点名（其 text 是选中项文本）、容器类取节点名。

### 工具组管理 — manage_tools

| action | 说明 |
|--------|------|
| \`list_groups\` | 列出所有工具组及其启用/停用状态 + 每 profile 实测 bytes/approxTokens 价格标签 |
| \`activate\` | 启用指定工具组（按名称） |
| \`deactivate\` | 停用指定工具组（按名称） |
| \`sync\` | 返回各工具组的 \`requires\` 连接状态（editor/bridge/headless） |
| \`reconnect\` | 触发 EditorConnection 重新连接（bridge 无持久连接，no-op） |

**行为说明**：
- \`reconnect\` 仅影响 Editor WebSocket 连接（端口 9090-9094）。Bridge 为持久 TCP 连接（30s keepalive、断线自动重连并重发订阅），无显式重连语义，故 no-op。
- \`sync\` 返回结构：\`{ groups: [{ name, requires, status }, ...], editor: { installed, connected, state }, bridge: { note } }\`。其中 **status**:editor 组 = \`connected\`/\`disconnected\`(基于 editor 连接);bridge 组 = \`probe-required\`(用 \`game_query(method=ping)\` 探测);无 requires 组(core/animation/ui 等)= \`n/a\`。**editor.state**:连上时用 healthMonitor(工具调用健康),未连报 \`disconnected\`,未启动报 \`null\`。**editor.installed** = editorConn 是否注入(launch_editor 后 true)。

## 使用指南

### 安装流程

1. 调用 \`game_bridge_install(project_path)\` — 注册 autoload、配置端口 9081
2. 在 Godot 中运行项目（F5 或 \`run_project\`）
3. 游戏启动后 Bridge 自动监听 TCP 连接
4. 使用 \`game_query(method="ping")\` 验证连接

### 安全机制

- **密钥认证**：安装时生成随机密钥文件，每次 TCP 连接需认证
- **本地绑定**：TCP 仅监听 127.0.0.1，不暴露到网络
- **密钥生命周期**：读取后缓存 5 分钟（TTL），文件权限收紧（0600/icacls）
- **防符号链接**：密钥文件若是 symlink 则拒绝读取

### 与 dev_loop 集成

dev_loop 的 \`bridge\` 参数可在执行 GDScript 后自动进行 Bridge 查询：

\`\`\`json
{
  "bridge": {
    "screenshot": { "path": "user://test.png" },
    "queries": [
      { "method": "ping", "expect": "ok" },
      { "method": "find_nodes", "params": { "pattern": "Player" } }
    ]
  }
}
\`\`\`

## 调用示例

### 检查游戏运行状态

\`\`\`
game_query(method="ping")
// → { status: "ok", message: "Bridge connected" }

game_query(method="get_tree")
// → { root: "Node3D", child_count: 15 }

game_query(method="find_nodes", params={ "pattern": "Player" })
// → { nodes: [{ path: "/root/Player", type: "CharacterBody3D" }] }
\`\`\`

### 模拟输入并等待

\`\`\`
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": false })
game_wait(method="wait_for_node", params={ "path": "/root/CanvasLayer/Dialog" })
game_query(method="get_node_properties", params={ "path": "/root/CanvasLayer/Dialog", "properties": ["visible"] })
// → { visible: true }
\`\`\`

### 修改运行时状态

\`\`\`
game_write(method="set_node_property", params={ "path": "/root/Player", "property": "position", "value": { "x": 10, "y": 0, "z": 5 } })
game_write(method="call_method", params={ "path": "/root/Player", "method": "take_damage", "args": [25] })
\`\`\`

### 属性监控

\`\`\`
game(action="monitor_start", node_path="/root/Player", properties=["position", "health"], interval_frames=5)
// → { monitoring: true, node_path: "/root/Player", properties: [...], dropped_blocked: [], interval_frames: 5, max_samples: 500 }

game(action="monitor_poll")
// → { monitoring: true, samples: [{frame: 100, time: 1.667, t_game_ms: 1666.7, values: {position: {x:10,y:0}}}], sample_count: 1, interval_frames: 5, summary: {...} }

game(action="monitor_stop")
// → { monitoring: false, samples: [...], sample_count: 30, duration_seconds: 2.5, summary: {health: {min: 0, max: 100, min_at_frame: 120, ...}} }  // summary 仅数值属性；position 是 Vector(Dict) 不进摘要
\`\`\`

### 信号监听

\`\`\`
game(action="watch_start", node_path="/root/Button", signal_name="pressed", max_events=100)
// → { watching: true, node_path: "/root/Button", signal_name: "pressed", max_events: 100 }

game(action="watch_poll")
// → { watching: true, events: [{frame: 150, time: 2.5, args: []}], event_count: 1 }

game(action="watch_stop")
// → { watching: false, events: [...], event_count: 5, duration_seconds: 8.2 }
\`\`\`

### UI 元素发现

\`\`\`
game(action="find_ui_elements", type="Button", visible_only=true)
// → { elements: [{path: "/root/Menu/StartBtn", type: "Button", text: "Start", ...}], count: 3 }

game(action="click_button", text="Start")
// → { clicked: true, button_path: "/root/Menu/StartBtn", button_text: "Start" }
\`\`\`

### 错误：Bridge 未连接

\`\`\`
game_query(method="ping")
// → 超时或错误: "Bridge not connected"
// 解决：1. 确认已运行 game_bridge_install
//       2. 确认游戏正在运行（F5 或 run_project）
//       3. 检查项目 .godot/ 目录下是否有 mcp_bridge_9081.secret 文件
\`\`\`

## 常见陷阱

- **Bridge 未安装**：调用 game_query/input/write/wait 前必须先 game_bridge_install。安装是一次性的（写入 project.godot autoload）。
- **游戏未运行**：Bridge autoload 只在游戏运行时监听。编辑器模式（编辑场景）不会启动 Bridge。
- **密钥文件权限**：Windows 上可能需要 icacls 权限。Linux/macOS 上自动 chmod 0600。
- **密钥权限循环**：Bridge 首次运行后将密钥文件权限收紧为只读（Windows: \`(R)\` only），导致后续启动时无法重写密钥而中止（"Failed to write secret — aborting Bridge startup"）。**解决**：手动恢复写入权限 \`icacls ".godot/mcp_bridge_9081.secret" /grant "%USERNAME%:(W)"\`，或删除密钥文件让 Bridge 重新生成。**S4 治本（v0.18.x+）**：设置环境变量 \`GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true\`，Bridge 复用现有 secret 文件（不重生、不收紧、\`_exit_tree\` 不删除），彻底打破权限循环并与 MCP 端 5min TTL 缓存保持同步。仅本地测试用（安全降级，生产保持默认 false）。
- **节点路径必须用绝对路径**：\`game_write\`、\`game_wait\` 等的 \`path\` 参数必须以 \`/root/\` 开头（如 \`/root/Main/Player\`），不接受 \`root/Main/Player\` 格式。\`game_query(method="get_tree")\` 返回的路径可用于参考。
- **与录制系统**：\`runtime(action="record_start")\` 依赖 Bridge 连接。确保 Bridge 可用后再录制。
- **端口 9081 冲突**：端口被占时自动递增避让（9081 起，最多尝试 10 个候选）；可用环境变量 \`GODOT_MCP_BRIDGE_PORT\` 设起点，无需修改 autoload 脚本。
- **密钥缓存**：5 分钟 TTL 后首次调用会重新读取密钥文件，可能有短暂延迟。
- **monitor 最大属性数**：单次监控最多 20 个属性（MONITOR_MAX_PROPERTIES），超出会报错。
- **monitor 自动停止**：采样达到 500 条（_monitor_max_samples）后自动停止。
- **watch Lambda 适配器**：信号回调使用 0-4 参数的匹配 Callable，超过 4 参数的信号只记录前 4 个。
- **watch 自动断开**：事件达到 max_events 后自动断开信号连接并停止。
- **find_ui_elements 最大返回**：默认 200，上限 500 条结果。
- **click_button**：默认通过 emit_signal("pressed") 触发，不模拟实际鼠标点击事件（**不切换 button_pressed 状态**——CheckBox/RadioButton 点击"成功"但没勾上时用此解释）。传 \`real_event=true\` 走真实输入事件路径：press/release InputEventMouseButton 注入 viewport，走完整引擎输入管道（切换 button_pressed/触发 button_group 互斥/focus），响应含 \`signal_counts\`（pressed/toggled 等信号计数）与 \`verified\`（等 4 帧延迟响应，同 call_method await_completion 模式）。
- **call_method 白名单只读（S5, v0.18.x+）**：\`ALLOWED_METHODS\` 仅含只读方法（get/has_*/get_meta/get_signal_list 等），刻意禁状态修改（防 call_method 任意执行）。\`emit_signal\`/\`_on_*\` 回调/业务方法默认被拒。需触发业务逻辑时：(a) 设环境变量 \`GODOT_MCP_BRIDGE_EXTRA_METHODS=emit_signal,xxx\` 显式扩展（opt-in，注意 emit_signal 会触发已连接的任意回调，安全降级）；(b) 用 \`set_node_property\` 改属性间接触发；(c) 业务逻辑内联到 GDScript 片段。注：\`_cmd_call_method\` 仍有 \`args.size() > 8\` 拒绝限制（>8 参数的调用/emit_signal 会失败）。
- **call_method CMP-9-B 增强（v0.27.0+）**：(1) args 按方法声明类型自动强转（传 \`[1,2,3]\` 给 Vector3 参数正确转换，Godot callv 不自动转，防静默零值）；(2) 方法不存在时返回 did-you-mean 建议（\`String.similarity\` > 0.6 取最高分）；(3) response 含 \`undoable: false\`（call 不可 undo，对标竞品）；(4) \`EXTRA_METHODS_BLOCKLIST\`（free/queue_free/set_script/call/callv/emit_signal/connect/disconnect 等）是不可覆盖硬底线（即使 env 列出也拒，防 RCE/运行时结构破坏）。向后兼容：不设 env 时行为完全不变。(5) P0-1(2026-09-11) callv 参数预检——coerce 后仍不可达方法声明的组合(个数不足/超出、类型不可转如 String→int 非数字、Dictionary→Object、null→int、typed Array/Dict、JSON array→Array[int])在调用前显式拒绝(code -10),防 callv 静默失败返回 null 被误读为成功(与 void 返回不可区分);方法签名取不到的动态方法放行,由 callv 自行处理。(6) GDA_CALLABLE per-node 声明白名单(2026-09-11 P1 批)——游戏侧在节点脚本声明 const GDA_CALLABLE := ["take_damage"],bridge 沿脚本基类链静态读 get_script_constant_map() 枚举(零项目代码执行,default deny:不声明=不可调);信任边界:声明是声明者的断言(进游戏方 code review),bridge 保证未声明方法绝不可调;BLOCKLIST 仍是硬底线(声明也拦)。
- **monitor 游戏时间调度（P0-3, 2026-09-11）**：采样节奏锚定游戏时间(delta*1000 累计,含 time_scale)而非帧数——帧步长在窗口期帧率变化时实际节奏漂移 2-4 倍(satellite #378 同款坑)。paused/freeze 期间不计时不采样;长帧跨多个采样点只 resync 不 burst 补帧;monitor_stop 时若游戏时间推进过但末次采样未赶上会补采终态。已知限制:采样在 bridge 帧前执行,读数统一迟一帧(时间线形状无损);帧末精确对齐需独立采样器子节点(评估后未做,防帧定时输入注入的时序偏移)。
- **P2 control 层增强（2026-09-11）**：(1) report 搭车——playtest.step/step_until 可带 report=[{path,property}](≤16 条,结构化,不引入 Expression,属性过黑名单),响应自带终态读数(省紧随观察往返);逐条失败带 error 不炸。(2) freeze 竞争上报——游戏代码在 freeze 下 unpause 时 bridge re-assert 并计数,unfreeze 响应含 frozen_for_ms/contended_reasserts(>0 = 游戏对抗过 freeze,每次 re-assert 可漏一帧,诚实报数)。(3) 函数级 profiling——run_project(profiling=true) 传 --remote-debug(spawn 前绑端口,attach 会话无此通道),之后 profiler 工具 capture_functions(seconds/top/sort/capture_limit) 一次调用采窗口+排名(引擎原生流,函数级 self/total 热点+最慢帧 top30,等价编辑器 Profiler 面板;帧级分析仍用 get_data)。
- **P3 能力扩展（2026-09-11）**：(1) 弱网注入 network_conditioner——op=set 包装当前 MultiplayerPeer(MultiplayerPeerExtension 装饰器,只改**出向**:静默丢包/延迟+jitter 进队列 16ms flush;无带宽限制;host 侧装=影响 host 发给所有 client,双向对称需两端各装;依赖 SceneMultiplayer 高阶 API,raw socket 不走此管道),无 peer(OfflineMultiplayerPeer)诚实报错不装空壳;clear 恢复原 peer(游戏自行换过 peer 则不覆盖)且幂等;status 报 pending_packets。(2) custom_command 项目本地命令——游戏开发者丢 .gd 进 res://mcp_commands/(get_commands() -> {"custom.xxx": Callable}),bridge _ready 宽容注册(load 失败/非 Node/无方法/非 Dictionary 一律跳过不崩启动),custom. 前缀强制(内建零冲突,default deny;信任边界同 GDA_CALLABLE:声明面=游戏源码方责任,进游戏方 code review);调用 game(action=custom_command, method=custom.xxx, params=...),未声明命令 bridge 返 -32601。(3) manage_tools list_groups 响应加 profiles 价格标签(每 profile 实测 bytes + approxTokens,Buffer.byteLength 口径含中文)——切 profile 前先看价格(对照 BuildersGate 105k 基线)。
- **P8 热加载（2026-09-12）**：mcp_commands 状态机——mtime+300ms debounce tick 感知文件变更；命令调用中不换实例(quiesce,active_calls 归零才重载/卸载)；加载失败回滚旧实例继续服务(slot=reload_failed+last_error,文件修好后自动恢复)；GDScript.new()+FileAccess **独立加载**(不走 ResourceLoader:同路径 load 即使 CACHE_MODE_IGNORE 也就地替换共享资源,旧实例方法表消失、旧 Callable is_valid()=false——实测坑,独立对象加载失败即丢弃,回滚天然有效)；删除文件 quiesce 后卸载 slot；重名冲突路径字典序靠前者赢(后者 reload_failed 清空);\`custom.list\` 内建诊断返回 slot 状态快照；env GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD=0 关闭热重载。已知边界：运行中写入**语法坏** .gd 触发 Script Debugger REPL 挂死主循环(引擎层,bridge 不可防——语法错误 IDE 侧先消灭;bridge 防线覆盖"合法语法坏契约"如 extends RefCounted)。
- **send_key 已支持 physical_keycode（S6, v0.18.x+）**：\`_cmd_send_key\` 同时设 \`keycode\` + \`physical_keycode\`，触发用物理键码映射的 input action（Godot 4 推荐 physical_keycode 映射）。早期版本只设 keycode，physical 映射项目（如 \`ui_right\` 用 physical）不触发。
- **多用户环境不安全**：Bridge 使用 TCP 绑定 127.0.0.1 + 共享密钥认证。在单用户本地开发环境下足够安全，但在多用户共享系统（如远程开发服务器）上，localhost 通信可被同一机器上的其他用户嗅探。如需多用户隔离，考虑使用 Unix Domain Socket（仅文件权限控制访问）。
`,

  'godot-mcp-editor.md': `---
description: "editor websocket editor_sync_start editor_sync_stop editor_get_scene_tree launch_editor 编辑器 场景树同步 undo plugin addons godot_mcp_server"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 概述与架构

Editor 模式通过 WebSocket JSON-RPC 2.0 连接 Godot 编辑器内的 GDScript 插件，实时操作当前打开的场景。

- **插件位置**：\`addons/godot_mcp_server/\`（需安装在目标项目中）
- **连接机制**：launch_editor 启动编辑器后，服务端自动检测 WebSocket 连接（端口 9090，被占自动递增至 9094）
- **回退策略**：无编辑器连接时自动回退到 Headless 模式；设置 \`GODOT_MCP_NO_FALLBACK=true\` 禁止回退

## 工具清单与对比

### Editor 独有工具

| 工具 | 说明 |
|------|------|
| \`editor_sync_start\` | 启动场景树实时监听，推送 node_added/node_removed 事件 |
| \`editor_sync_stop\` | 停止场景树监听 |
| \`editor_get_scene_tree\` | 获取编辑器当前场景树完整快照 |

### 仅 Headless 可用

| 工具 | 原因 |
|------|------|
| \`execute_gdscript\` | 独立进程执行，不适合编辑器环境 |
| \`query_scene_tree\` | Headless 专用，用 editor_get_scene_tree 替代 |
| \`inspect_node\` | Headless 专用 |

### 行为差异

| 工具 | Headless | Editor |
|------|----------|--------|
| \`add_node\` | 需指定 scene_path，创建后需 save_scene | 操作当前打开场景，实时刷新 |
| \`edit_node\` | 需指定 scene_path | 操作当前场景中的节点 |
| \`remove_node\` | 需确认令牌 | 需确认令牌 + 支持 undo |
| 其他工具 | 自动路由到 headless 执行 | 未知工具名自动 forward 到插件 |

## 使用指南

### 连接流程

1. 确认目标项目已安装 \`addons/godot_mcp_server/\` 插件
2. 调用 \`launch_editor(project_path)\` 启动编辑器
3. 服务端自动检测 WebSocket 连接（最长等待约 10 秒）
4. 连接成功后，工具调用自动路由到编辑器

### 场景树同步

- \`editor_sync_start\` 连接 SceneTree 的 node_added/node_removed 信号
- 事件通过 EditorToolExecutor 缓冲（最大 10000 条），超出时丢弃最旧记录
- 编辑器断开重连后，同步自动恢复
- \`editor_get_scene_tree\` 获取当前快照（不依赖 sync 状态）

## 调用示例

### 启动编辑器并同步场景树

\`\`\`
// 1. 启动编辑器
launch_editor(project_path="D:/projects/my-game")

// 2. 启动场景树监听
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: { status: "ok", message: "Scene tree sync started" }

// 3. 获取当前场景树
editor_get_scene_tree(project_path="D:/projects/my-game")
// → 返回: { nodes: [...], root: "Node3D", child_count: 15 }
\`\`\`

### 错误：编辑器未安装插件

\`\`\`
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: {
//     error: "EDITOR_NOT_CONNECTED",
//     message: "These tools require editor mode with plugin connection.
//               Use headless query_scene_tree as alternative."
//   }
// 解决：在 Godot 编辑器中安装 addons/godot_mcp_server/ 插件并重启编辑器
\`\`\`

## 常见陷阱

- **插件未安装**：editor_sync 工具返回 EDITOR_NOT_CONNECTED。需要手动安装插件到项目。
- **编辑器启动慢**：大型项目首次启动可能超过 10 秒。可分两步操作：先 launch_editor，等几秒后再 sync。
- **forward 机制**：未明确处理的工具名会自动转发到编辑器插件，可能产生意外行为。
- **断开重连**：编辑器崩溃或关闭后，sync 状态自动清理。需要重新 launch_editor。
- **launch_editor 崩溃恢复（2026-08-07 审查 P2 文档化）**：launch_editor 是 fire-and-forget（detached + unref），不跟踪编辑器生命周期。编辑器崩溃后：① WS 断开 → EditorConnection 自动重连（20 次指数退避）；② 重连耗尽 → reconnectExhausted handler → handleEditorStall 降级 headless（用户可用 headless 工作）；③ 非 PERSISTENT_SECRET 模式下崩溃即删 secret，rebuildEditorConnection 需 secret 文件 → rebuild 失败需手动重新 launch_editor 或重启 MCP server。**用户预期管理**：系统不会自动重启崩溃的编辑器，需手动 launch_editor 或重启 server。心跳降级走 B-T5 分流（REQUEST_TIMEOUT 主线程卡死 → 降级；NOT_CONNECTED/CONNECTION_LOST 下线 → 让自动重连兜底不降级）。
- **端口冲突**：默认端口 9090（\`BASE_PORT\`），被占自动递增至 9094；MCP 端默认连 9090，多实例场景可用 \`GODOT_EDITOR_PORT\` 指定。
- **editor 插件 4.7 Vector 类兼容**：早期记忆称 4.7 编译失败（Vector.from_string 等 4.6 API 移除），但 master 已迁移（Vector→\`_count_number_components\`，\`Color.from_string\` 4.7 保留），headless 工具 4.7 正常。**但 \`godot --check-only <file>\` 是假绿**：该用法只打 banner 不触发编译（4.7+4.6.2 实测），2026-06-26 据此称"6 文件全编译通过"不可信。addon 全量编译验证应用 \`godot --headless --import --path test/fixtures/gdscript-check\`（启用 plugin + 建全局类 class_name 缓存）。
- **原生类虚函数禁 super()（2026-07-04 修复 654b162 回归）**：\`super()\`（无方法名）对 Godot 原生类（EditorPlugin/Node/VBoxContainer）虚函数（\`_ready\`/\`_process\`/\`_enter_tree\`/\`_exit_tree\`，**含 \`_init\`**）一律是 **Parse Error**："Cannot call the parent class' virtual function ... hasn't been defined"，**4.6.2+ 均报（非 4.7 特有）**。调父类实现用 \`super._method()\`（带方法名）显式形式。IMP-4 "虚函数首行调 super" **仅适用 extends 自定义基类**（见 CHANGELOG \`mcp_bridge.gd\` 移除 super 先例 + \`docs/review-followup-2026-06-18.md:93\`）。654b162（v0.19.0）误加 6 处 super() 致 addon 加载失败/9090 不监听；2026-07-04 移除（plugin/websocket_server/status_panel），4.7+4.6.2 \`--import\` 实测全量编译通过。
- **editor 模式 WebSocket 端口 9090-9094（非 13100）**：\`addons/godot_mcp_server/websocket_server.gd:3\` \`BASE_PORT=9090\`。\`editor_get_scene_tree\` 返回 \`EDITOR_NOT_CONNECTED\` 通常是**端口/key/未就绪**问题（非编译）：需 \`mcp_editor.key\` icacls 权限 + 等 editor GUI 就绪（插件 WebSocket 监听 9090）+ MCP 端连对端口。详见 [[godot-editor-plugin-e2e-verification]]。
- **editor 路由操作活动场景（2026-07-20）**：\`add_node\`/\`edit_node\`/\`batch_add_nodes\`/\`remove_node\` 的 editor 路由（editor-method-map 登记后 editor 连接时走 \`handle_*\`）操作**编辑器活动场景**（\`ei.get_edited_scene_root()\`），\`scene_path\` 参数仅 headless 生效。editor 模式操作非活动场景须先 \`open_scene\` 切换活动场景。editor/headless 语义差异：headless 按 scene_path 加载磁盘场景改盘，editor 改内存活动场景（不落盘，须 save_scene 持久化）。
- **headless 改盘 + editor 开同场景→Ctrl+S 覆盖（2026-07-20）**：headless 改盘后，**若编辑器开着同一场景**，编辑器内存的旧版本 Ctrl+S 会覆盖 MCP 改动——须 Project→Reload 场景（或 File→Close Scene）后再操作。\`checkEditorSceneSave\` 守卫只防 MCP→editor 脏方向；反向（editor→MCP，用户手动 Ctrl+S）是引擎行为，MCP 端不可控。headless 改盘后建议关闭编辑器内该场景或 Reload。
- **editor 固定 secret（S4-editor）**：设环境变量 \`GODOT_MCP_EDITOR_PERSISTENT_SECRET=true\`，editor plugin 复用现有 \`mcp_editor.key\`（不重生、不收紧 ACL、\`_exit_tree\` 不删除），彻底消除 \`_ready\` 覆盖写需求及 MCP 端 TTL 缓存同步窗口。仅本地测试用（安全降级——secret 固定不再轮换，生产保持默认 false）。对称 bridge \`GODOT_MCP_BRIDGE_PERSISTENT_SECRET\`（见 godot-mcp-bridge.md「密钥权限循环」）。
- **mcp_editor.key 多实例互删（2026-07-23 修复）**：editor 启动写 \`{project}/.godot/mcp_editor.key\`，\`_exit_tree\` 默认删除。多个 editor 实例（或禁用→启用插件）共享同一路径时，**历史版本任一实例退出会误删仍存活实例的 key**（现象：editor 日志称 \`Auth secret written\` 但文件找不到；存活实例内存 \`_secret\` 仍有效、9090 仍 LISTEN，TS 端 TTL 缓存 5min 过期后重连连不上）。**已修复**：\`websocket_server.gd:_delete_secret_file\` 删前 \`FileAccess.get_file_as_string\` 校验 \`on_disk == _secret\`，只清自己生成的 key（读失败也不删，安全侧）。仍遇此问题（旧 addon 副本/未重启 editor）：设 \`GODOT_MCP_EDITOR_PERSISTENT_SECRET=true\` 重启 editor（见上条 S4-editor）。
`,

  'godot-mcp-ui.md': `---
description: "ui ui_create_control ui_build_layout ui_measure_layout ui_set_layout ui_get_layout ui_anchor_preset ui_set_theme ui_container_add ui_draw_recipe theme_create theme_set_property CSS flexbox grid 布局 测量 容器 锚点 rect Control HBoxContainer VBoxContainer GridContainer 全屏 居中"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 概述与架构

UI 布局工具将 **CSS Flexbox/Grid 语义**翻译为 Godot Container 树，让 AI 用熟悉的布局概念构建 Godot UI。

- **三种入口**：单节点操作（ui_create_control）/ 批量布局（ui_build_layout）/ HTML 原型还原（ui_import_prototype，几何 JSON 一次调用，固定持久化）
- **运行时工具**：操作在 headless 进程中执行，默认不持久化到 .tscn（例外：\`ui_build_layout\` 支持 \`persist=true\` 原子写；\`ui_import_prototype\` 无 persist 参数、固定持久化）。详见 godot-mcp-core.md "运行时 vs 持久化"。
- **互补关系**：ui_import_prototype 适合"HTML 原型→Godot"还原（原型是唯一真源）；ui_build_layout 适合手写树整体布局；ui_create_control + ui_set_layout 适合精确定位

## 工具清单

| 工具 | 说明 |
|------|------|
| \`ui_build_layout\` | 声明式批量布局，CSS Flexbox/Grid → Godot Container 树；支持 rect 绝对几何与 persist 原子写 |
| \`ui_import_prototype\` | HTML 原型几何 JSON 一次调用：翻译→build（固定 persist）→measure→layout_verify；返回 verify_coverage 覆盖率（v0.31.0） |
| \`ui_measure_layout\` | headless 整树 computed rect 测量（等布局稳定后输出，可带 expect_tree diff） |
| \`ui_create_control\` | 创建单个 Control 节点（29 种类型） |
| \`ui_set_layout\` | 设置锚点/偏移/最小尺寸 |
| \`ui_get_layout\` | 查询节点布局信息 |
| \`ui_anchor_preset\` | 应用 16 种锚点预设 |
| \`ui_container_add\` | 向 Container 添加子 Control |
| \`ui_draw_recipe\` | 声明式 2D 绘图（7 种操作） |
| \`ui_set_theme\` | 设置/创建/保存/加载 Theme |
| \`theme_create\` | 创建空 Theme 或从节点提取 |
| \`theme_set_property\` | 设置 Theme 属性（font/color/constant/stylebox） |

### 支持的 29 种 Control 子类

Button, Label, Panel, LineEdit, TextEdit, RichTextLabel, LinkButton, HSlider, VSlider, CheckBox, CheckButton, OptionButton, SpinBox, ProgressBar, TextureRect, ColorPickerButton, TabContainer, Tree, ItemList, MarginContainer, HBoxContainer, VBoxContainer, GridContainer, CenterContainer, ScrollContainer, PanelContainer, HSplitContainer, VSplitContainer, NinePatchRect

## 使用指南

### ui_build_layout — 声明式布局

\`tree\` 参数定义布局结构，支持递归嵌套（最大深度 10）：

\`\`\`json
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
\`\`\`

### layout 字段

| 字段 | 值 | 对应 Godot |
|------|-----|-----------|
| \`direction\` | row/column/grid | HBoxContainer/VBoxContainer/GridContainer |
| \`justify\` | flex-start/center/flex-end/space-between/space-around/space-evenly | Container alignment |
| \`align\` | stretch/flex-start/center/flex-end | Cross-axis alignment |
| \`gap\` | number | Theme 默认间距 override |
| \`padding\` | number 或 [上,右,下,左] | MarginContainer |
| \`columns\` | number | GridContainer columns（仅 grid 方向） |

### flex 字段（控制子节点在容器中的行为）

| 字段 | 说明 | 对应 Godot |
|------|------|-----------|
| \`grow\` | 扩展比例（0=不扩展） | size_flags_stretch_ratio |
| \`min_width\` / \`min_height\` | 最小尺寸 | custom_minimum_size |
| \`align_self\` | 单独对齐覆盖 | size_flags + alignment |

### anchor_preset 锚点预设

16 种预设：top_left, top_right, bottom_left, bottom_right, center_left, center_top, center_right, center_bottom, center, left_wide, top_wide, right_wide, bottom_wide, vcenter_wide, hcenter_wide, **full_rect**（最常用）

### rect 绝对几何（v0.30.3 语义修正）

无 \`layout\` 字段的节点支持 \`rect: {x, y, w, h}\`——**相对父节点左上角**（不是视口绝对坐标），按**父尺寸**反解为 anchors+offsets：

- **求解基准**：根节点（挂 parent_path 下）的 rect 相对 **\`viewport\` 参数**求解（默认 1280x720）；子节点的 rect 相对**父节点的 rect.w/h** 求解；父节点未声明 rect 时降级用 viewport 求解并发 warning（\`parent's size is unknown\`，结果可能不准）。
- **viewport 参数**：\`ui_build_layout\` 顶层参数 \`{w, h}\`（须为正数），与项目 \`display/window/size\` 一致时根 rect 即视口绝对几何。
- **父必须非 Container**：HBoxContainer 等容器父会强制重排子节点，rect 会被运行时跳过并给出 warning（需要容器内定位请重构为非容器父或兄弟节点）。
- \`rect\` 优先于 \`anchor_preset\`；显式写四值 anchors+offsets，不用 set_anchors_preset（引擎陷阱：preset 不重置 offsets）。
- 锚点值吸附 0/0.5/1（可读性优先），其余位置保持比例锚点兜底。
- **带 \`layout\` 的容器节点自身 rect 不落地布局**：仅作为 \`ui_measure_layout(expect_tree)\` 的对照目标（diff 会报告实际偏差）；容器实际几何由 \`anchor_preset\`（默认 full_rect）与子节点内容/\`custom_minimum_size\` 撑开决定。

### justify space-* 行为（v0.30.3）

非 wrap 非 grid 的 row/column 下，\`space-between/around/evenly\` 通过注入 \`_spacer_N\` Control 节点实现（SIZE_EXPAND + stretch_ratio），**不再是近似映射**。\`wrap: "wrap"\` 时 justify 被忽略（FlowContainer 无对齐）、\`grid\` 方向时同样忽略——这两种情况**不注入 spacer、也不发 spacer 注入 warning**。与子节点 \`flex.grow\` 并存时，spacer 与 grow 子节点瓜分剩余空间，分配语义与 CSS 不同，会有 warning。

### 布局收敛闭环

\`ui_build_layout(tree 含 rect)\` → \`ui_measure_layout(expect_tree=同一棵 tree，**不带 node_path**)\` → 按 \`data.layout_verify.diff\` 的 Δ 数值修 tree → 循环至全绿 → \`ui_build_layout(persist=true)\` 原子写 .tscn（pack → tmp → rename）。

- \`layout_verify\` 结构：\`targets\`（期望 rect 清单）/ \`diff\`（逐节点 Δ，容差默认 2px）/ \`overlaps\`（兄弟节点重叠）/ \`out_of_bounds\`（溢出父边界）/ \`viewport\`（measure 输出的根参照系透传）。
- **坐标系语义（v0.30.3）**：rect 相对父节点左上角；\`diff\` 的 actual 为**父相对坐标**（measured 子 global − 父 global，与 target 同构可直接比 Δ）；根级 target（树根自身 rect）以视口原点为参照；父不在测量集（未渲染/不可见）时该条目 delta 为 NaN。
- \`ui_measure_layout\` 单独使用时：\`node_path\` 可选（省略则从场景根整树测），\`max_depth\` 默认 16（上限 64），等布局稳定（连续帧快照一致或最多 5 帧）后输出；输出含 \`viewport\`（项目声明视口尺寸）与 \`stalled\`（5 帧上限内未达 2 帧稳定时 true，布局可能未收敛）。

### ui_import_prototype — HTML 原型还原（v0.31.0）

**工作流（AI 全链路，原型是唯一真源）**：AI 写 HTML 原型（每个待还原元素标 \`data-name\`）→ 浏览器 MCP 一条 evaluate 提取几何 JSON（模板见下节）→ \`ui_import_prototype\` **一次调用**完成 翻译→build→measure→layout_verify → **不绿回 HTML 改原型**（不在 Godot 侧调 rect）→ 绿后 \`screenshot(action=diff)\` 像素级双图验收（要点见本节末）。

**入参**：\`geometry\`（inline JSON）或 \`geometry_path\`（文件路径，相对项目、支持 \`res://\` 前缀；二选一，同时给时 \`geometry\` 优先 + warning）/\`viewport\`（可选，默认取 geometry.viewport）/\`tolerance\`（默认 2px）/\`parent_path\`（默认 root）。**没有 persist 参数——固定持久化**（内部 measure 是第二次 Godot spawn 从磁盘 load 场景，不落盘则 verify 全部 actual:null）。

**proto-geometry JSON**（strict schema，未知字段拒绝——字段拼错（如 \`font-size\`）早暴露，不静默丢）：

\`\`\`json
{
  "viewport": { "w": 1280, "h": 720 },
  "nodes": [
    { "name": "TopBar", "rect": { "x": 0, "y": 0, "w": 1280, "h": 56 },
      "type": "Panel", "text": "标题", "fontSize": 16, "color": "#e8ecf5",
      "bg": "#10141f", "align": "center", "value": 0.72,
      "flow": "row", "justify": "space-between", "interactive": true }
  ]
}
\`\`\`

- **扁平列表，视口绝对坐标**（rect 为浏览器/原型视口绝对值）；树由翻译器按 rect 包含关系自动推导（容差 1px，≤500 节点）；**两节点 rect 交叉重叠（互不包含）或完全相等 → INVALID_PARAMS**（不静默落平级）。
- 字段全可选（除 name/rect）：\`type\`（CONTROL_TYPES 白名单）/\`text\`/\`fontSize\`（px）/\`color\`/\`bg\`/\`fill\`（ProgressBar fill 槽色，取 \`[data-fill]\` 子元素背景）/\`borderRadius\`（统一四角 number 或 \`{tl,tr,br,bl}\` 对象）/\`border\`（\`{width,color}\` 统一四边，CSS 四边不同时取 top；**四边各异不单独 warning**——生产者仅取 top，其余三边差异静默；style_verify 无法暴露该差异（期望与实测同源于同一翻译产出，恒绿），真暴露渠道是 ui_pixel_verify 像素采样）/\`align\`（left|center|right，缺省 center）/\`value\`（0-1，ProgressBar）/\`flow\`（row|column，容器排布语义）/\`justify\`/\`interactive\`（text+interactive→Button）。
- **颜色仅三种格式**：\`#rrggbb\` / \`[r,g,b]\` 0-255 / \`[r,g,b,a]\` 0-1。CSS \`rgb()/rgba()\` 字符串**不支持**——evaluate 模板已内置转换（见下节）。
- **bg 缺省 = 透明壳契约（责任归 JSON 生产者）**：推断为布局壳 Panel（无显式 type、无 text、无 bg、无 value 的纯布局节点，及 flow 壳）→ \`self_modulate:[1,1,1,0]\`（禁 modulate，级联陷阱见 godot-mcp-engine-quirks.md）。**该有背景的面板务必在原型侧显式填 bg**，否则被当透明壳（build_warnings 会提示 "set bg or type to keep it visible"）。**自带视觉控件不会被设透明壳**：ProgressBar（推断或显式）、Button（推断或显式）、任何显式 type（含显式 Panel）——显式 type 说明有意为之，一律保留可见性。
- **翻译规则要点**（12+1 条）：类型推断（显式 type > flow > value→ProgressBar > text+interactive→Button > text→Label > Panel）；视口坐标逐层减父原点转相对父 rect（进锚点求解链）；Label 全部 \`vertical_alignment:1\`；bg/fill/borderRadius/border→StyleBoxFlat（槽位映射（\`add_theme_stylebox_override\` API；override 属性名为 \`theme_override_styles/<slot>\`，注意 \`node.set()\` 该路径 pack 落盘会丢 override，勿手写）：Panel→panel、ProgressBar→background+fill、Button/Label→normal；其余控件 warning+忽略；bg 缺省而 border/radius 存在→\`draw_center=false\` 保 CSS 透明底）；非白名单 type 降级 Panel + warning；深度 cap 10；name 非法字符清洗。
- **引擎下限预警（只警不修，修在原型侧）**：文本控件 rect.h < fontSize*1.5 → "可能被字体最小行高钳制" warning；ProgressBar rect.h < 27 → "will be clamped" warning（**无条件**；实测 Godot 4.7.1 h=16：无 override→27、bg-only→23、fill-only→27、bg+fill→23，全组合被钳，override 只改变钳制值不消除钳制）。应对：调大原型 rect.h 或调小字号，勿指望 Godot 侧硬压。
- **容差模糊带**：verify 容差（默认 2px）内兄弟关系与偏移不可区分——**避免构造 ≤2px 宽的相邻独立节点**（工具返回也带此提示）。

**返回**：\`{ tree, build_warnings, measure: {stable_after_frames, stalled, viewport}, verify_coverage, layout_verify: {targets, diff, overlaps, out_of_bounds, viewport}, style_verify, flow_verify, persist }\`。

- **verify_coverage 覆盖率语义**：\`targets\` 为受几何 verify 覆盖的节点数（**含合成根 \`_PrototypeRoot\`——无 flow 时 = 输入节点数 + 1**）。**flow 直接子节点丢 rect、不在 layout_verify 覆盖内——由 \`flow_verify\` 数字覆盖**（期望=输入视口 rect vs 容器排布实测 global rect，逐节点 Δx/Δy/Δw/Δh；孙层由 **layout_verify** 近似覆盖（非 flow_verify）——期望相对输入父原点，容器排布后天然带偏移）。
- **style_verify（逐槽位样式 diff）**：\`ui_import_prototype\` 返回与 \`ui_measure_layout\`（expect_tree 时）均挂；对「期望清单内节点 ∪ 槽位 override 非空节点」按需读回 \`get_theme_stylebox(slot)\`（override 优先、回落默认主题——**override 没设上时以默认主题数值 diff 暴露**）；非 StyleBoxFlat（如 Label 未 override 的 normal 槽 StyleBoxEmpty）以 type 红条目暴露、不进字段 diff；仅比 box 显式设置的字段，颜色容差 0.002（Color float32 精度）、corner/border 宽度精确匹配。
- **flow_verify 容差语义**：直接子层 Δ 的合理阈值可大于几何 verify 的 2px（HTML flex 默认 align stretch vs Godot size_flags 默认 fill 的固有数值差）——偏差即价值，暴露后按 Δ 在原型侧修或加 size_flags；\`tolerance\` 参数同款可调。
- measure 阶段失败时错误信息附 \`(build 已持久化,可重跑 ui_measure_layout)\`——场景已在磁盘，无需重新 import。
- **ui_pixel_verify(像素终验)**：对已构建场景（\`scene_path\` 必填，指 \`ui_import_prototype\` persist 产物）窗口模式截图，对每个 bg 节点采样中心+四角内缩点（内缩 \`max(0, min(borderRadius+border.width, 短边/2−2))\` (短边<4 时回落 0,防负内缩)，角点坐标按像素格半开区间右/下缘 \`−1\`），与目标色 RGB 欧氏距离判定（中心容差 20、角点 60，0-255 空间；实测校准零底噪零偏移，13 采样点 distance=0）。**定位是终验而非迭代反馈**——几何 layout_verify + style_verify 全绿后才跑一次（每次 capture 窗口模式弹窗 + 秒级耗时）。Windows 窗口模式专属（headless=dummy renderer 截图空白；Linux headless 2D CanvasItem 亦空白，BLANK 拦截为 stdout 提示 + PNG 全图均匀色双条件）。采样跳过两类：半透明 bg（alpha<0.999，即非完全不透明；合成后采样色≠bg_color）与 ProgressBar 系（type/value/fill 任一——fill 与百分比文字覆盖 bg 渲染面，无可采样纯色区，bg 槽依赖 style_verify）；带 text 节点跳过中心点（居中排版必踩文字，仅采四角）。未映射控件（如 LineEdit 带 bg）的 bg 被翻译层忽略、渲染无该色——采样仍收集且预期红，与 build_warnings 样式丢失警告互为印证（诚实暴露，不静默跳过）。采样基准=输入视口 rect，挂载父须原点对齐（同 layout_verify 约束）；flow 子节点位置偏差由 flow_verify 先收敛；PNG 中间产物临时落 \`.godot/\` 且失败路径也清理。

**像素验收要点（\`screenshot(action=diff)\`）**：\`image_a\`/\`image_b\` 两 PNG（白名单内，尺寸必须一致）、\`threshold\` 默认 0.12（per-pixel RGB 欧氏距离 / (√3×255)，严格大于才计差、忽略 alpha）、可选 \`diff_path\` 输出红染差异图；返回 \`{width, height, diff_pixels, diff_ratio, bbox}\`。

- **capture 的 viewport 必须与原型 viewport 一致**（用法契约）：原型 1280x720 则 capture 也用 1280x720，否则几何比例全错、diff 全图皆红。
- **diff_ratio 含字体抗锯齿底噪**——对 diff_ratio **以同布局好图对为基线，坏图对 ratio 应显著高于基线（如 > 基线×1.5）**，勿用精确值断言。本仓实测（threshold=0.12）：好图对 web-prototype vs godot-hud（同布局不同渲染器）≈0.1762；下半部内容消失的合成坏图（godot-hud 下半 y>360 置纯黑，模拟 modulate 级联内容消失）≈0.48，约为基线 2.7 倍——"好图 < 0.25、坏图 > 0.4" 的区间示例在本仓成立；跨项目请以自身好图对为基线校准（同源渲染仍有 17% 量级像素差，精确值断言必 flaky）。

### 浏览器 evaluate 取数脚本模板（chrome-devtools / playwright 通用）

HTML 原型侧约定：每个待还原元素标 \`data-name\`（=Godot 节点名，须唯一）；flex 容器标 \`data-flow="row|column"\`（可选 \`data-justify\`）；整页视口容器标 \`data-viewport\`（可选，缺省取窗口尺寸）。在浏览器 MCP（如 chrome-devtools 的 evaluate_script / playwright 的 browser_evaluate）执行：

\`\`\`js
() => {
  const toRgba = (c) => {                     // CSS 颜色 → [r,g,b,a] 0-1 数组(保留 alpha;替代丢 alpha 的 toHex)
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;   // alpha 0 = 透明
    return [Number(m[1])/255, Number(m[2])/255, Number(m[3])/255, m[4] !== undefined ? Number(m[4]) : 1];
  };
  const vpEl = document.querySelector('[data-viewport]');
  const vpRect = vpEl ? vpEl.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
  const out = { viewport: { w: Math.round(vpRect.width), h: Math.round(vpRect.height) }, nodes: [] };
  for (const el of document.querySelectorAll('[data-name]')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const node = {
      name: el.dataset.name,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
    const text = (el.dataset.text ?? el.textContent ?? '').trim();  // 嵌套容器建议用 data-text 标注,避免吞子元素文本
    if (text) node.text = text;
    const alignMap = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
    const align = alignMap[cs.textAlign];                // 水平对齐:CSS 默认 left 而翻译器缺省 center——不采集会系统性丢失对齐
    if (align) node.align = align;                       // (justify 等其余值不输出字段,走翻译器缺省 center)
    const fs = parseFloat(cs.fontSize);
    if (Number.isFinite(fs)) node.fontSize = fs;
    const fg = toRgba(cs.color);
    if (fg && !(fg[0]===0 && fg[1]===0 && fg[2]===0 && fg[3]===1)) node.color = fg;  // 跳过浏览器默认黑
    const bg = toRgba(cs.backgroundColor);                 // 背景色:非透明才填(透明壳契约由翻译器兜底)
    if (bg) node.bg = bg;
    const flow = el.dataset.flow;
    if (flow === 'row' || flow === 'column') {
      node.flow = flow;
      if (el.dataset.justify) node.justify = el.dataset.justify;
    }
    if (el.dataset.value !== undefined) {                 // ProgressBar:value 必填 0-1 小数,百分数(如 72)请先除以 100——schema min(0).max(1) 会拒
      const v = Number(el.dataset.value);
      node.value = Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
    }
    if (el.dataset.interactive === 'true') node.interactive = true;
    const px = (v) => parseFloat(v) || 0;                  // "8px" → 8
    const tl = px(cs.borderTopLeftRadius), tr = px(cs.borderTopRightRadius),
          br = px(cs.borderBottomRightRadius), bl = px(cs.borderBottomLeftRadius);
    if (tl || tr || br || bl) {
      node.borderRadius = (tl === tr && tr === br && br === bl) ? tl : { tl, tr, br, bl };
    }
    const bw = parseFloat(cs.borderTopWidth);              // CSS 四边不同时取 top(简单;border-color 同)
    if (Number.isFinite(bw) && bw > 0) {
      const bc = toRgba(cs.borderTopColor);
      if (bc) node.border = { width: bw, color: bc };
    }
    const fillEl = el.querySelector('[data-fill]');        // ProgressBar fill 色:原型约定内层标 data-fill
    if (fillEl) {
      const fc = toRgba(getComputedStyle(fillEl).backgroundColor);
      if (fc) node.fill = fc;
    }
    if (el.dataset.type) node.type = el.dataset.type;     // 显式类型覆盖推断(29 种白名单内)
    out.nodes.push(node);
  }
  return out;  // → 直接作 geometry 入参,或写文件后走 geometry_path
}
\`\`\`

要点：**bg 只在 \`getComputedStyle().backgroundColor\` 非透明时填**（透明壳契约由翻译器兜底）；**颜色经 toRgba 转 \`[r,g,b,a]\` 0-1 数组**（保留 alpha，替代旧 toHex 的丢 alpha；翻译器三种颜色格式均认）；\`viewport\` 取 \`[data-viewport]\` 容器或窗口尺寸，**必须与 Godot 项目 \`display/window/size\` 及后续 \`screenshot(capture)\` 的 viewport 参数一致**（不一致则几何比例全错）。

### draw_recipe 声明式绘图

7 种绘图操作：\`rect\`（矩形）、\`circle\`（圆形）、\`line\`（线段）、\`arc\`（弧线）、\`polygon\`（多边形）、\`polyline\`（折线）、\`string\`（文本）

每种操作支持 \`color\`（[r,g,b] 或 [r,g,b,a]，0-1 范围）、\`filled\`（是否填充）、\`width\`（线宽）。

## 调用示例

### Flexbox 行布局

\`\`\`
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
\`\`\`

### draw_recipe HP 条

\`\`\`
ui_draw_recipe(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_path="/root/HUD/HealthBar",
  ops=[
    { "kind": "rect", "position": [0, 0], "size": [200, 20], "color": [0.2, 0.2, 0.2] },
    { "kind": "rect", "position": [0, 0], "size": [140, 20], "color": [0, 0.8, 0] },
    { "kind": "string", "text": "70/100", "position": [80, 14], "color": [1, 1, 1], "font_size": 12 }
  ]
)
\`\`\`

### 错误：无效 Control 类型

\`\`\`
ui_create_control(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_type="MyCustomWidget",    // ❌ 不在白名单中
  node_name="CustomWidget"
)
// → { error: "INVALID_CONTROL_TYPE", message: "MyCustomWidget is not a supported control type" }
// 解决：使用 29 种支持的类型之一，或通过 execute_gdscript 注册自定义场景
\`\`\`

## 常见陷阱

- **运行时默认不持久化**：UI 布局工具创建的节点在 headless 进程退出后丢失。\`ui_build_layout(persist=true)\` 可原子写 .tscn（pack → tmp → rename，默认 false）；其余持久化替代方案：\`add_node\` + \`save_scene\` 逐个写入，或 \`scene(action="commit")\`（批量 node_property/node_add 操作）直接编辑 .tscn。
- **Container 子节点必须是 Control**：向 HBoxContainer/VBoxContainer 等容器添加非 Control 子节点会报错。
- **CSS 属性回退**：\`wrap\`、\`order\`、\`flex-shrink\`、\`max-width/height\` 等 CSS 属性在 Godot 中无对应，会被忽略。
- **grid 方向必须指定 columns**：使用 \`direction: "grid"\` 时必须同时指定 \`columns\` 数量。
- **ui_build_layout vs ui_create_control**：build_layout 一次创建整棵树，适合初始布局。create_control + set_layout 适合精确控制单个节点。
`,

  'godot-mcp-recording.md': `---
description: "recording record_start record_stop record_save record_load record_play 录制 回放 输入事件 bridge E2E 测试 regression 操作复现 输入捕获 事件重放"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}

## 概述与架构

录制系统捕获用户输入事件（键盘/鼠标），序列化为 JSON，可在后续回放。

- **工具入口**：\`runtime\` 工具的 \`record_start\`/\`record_stop\`/\`record_save\`/\`record_load\`/\`record_play\` 五个 action（v0.18 合并，原独立 \`recording_*\` 工具已并入）
- **依赖**：Game Bridge 必须已连接（输入事件通过 Bridge 发送和捕获）
- **存储位置**：\`res://recordings/recording_*.json\`（项目内）
- **使用场景**：E2E 测试用例录制、回归测试、Bug 复现、操作自动化

## action 清单（runtime 工具）

| action | 说明 | 前提 |
|------|------|------|
| \`record_start\` | 开始捕获输入事件 | Bridge 已连接 |
| \`record_stop\` | 停止捕获，返回事件 JSON | 录制进行中 |
| \`record_save\` | 保存到 res://recordings/ | events_json 参数 |
| \`record_load\` | 从文件加载录制 | 文件名匹配 recording_*.json |
| \`record_play\` | 回放录制的输入事件 | Bridge 已连接 + events_json |

## 使用指南

### 完整流程

\`\`\`
1. game_bridge_install → 安装 Bridge（一次性）
2. run_project → 启动游戏
3. game_query(method="ping") → 确认 Bridge 连接
4. runtime(action="record_start") → 开始录制
5. [用户操作 / game_input 模拟输入]
6. runtime(action="record_stop") → 停止录制，获取 events_json
7. runtime(action="record_save", file_name) → 保存到文件
--- 后续使用 ---
8. runtime(action="record_load", file_name) → 加载录制
9. runtime(action="record_play", events_json, speed) → 回放
\`\`\`

### 事件格式

\`\`\`json
{
  "version": 1,
  "duration_ms": 5420,
  "events": [
    { "type": "key", "keycode": 87, "pressed": true, "time_offset": 120 },
    { "type": "mouse_click", "position": [640, 360], "button": 1, "pressed": true, "time_offset": 2300 },
    { "type": "key", "keycode": 87, "pressed": false, "time_offset": 4100 }
  ]
}
\`\`\`

### 文件命名与安全

- **始终自动命名**：record_save 忽略传入的 \`file_name\` 参数，始终生成 \`recording_YYYYMMDD_HHmmss.json\` 格式的时间戳文件名
- **强制格式**：\`file_name\` 参数必须匹配 \`recording_*.json\`，否则报 \`INVALID_FILE_NAME\`（但实际保存仍用自动命名）
- **路径遍历防护**：文件名禁止包含 \`/\`、\`\\\`、\`..\`

## 调用示例

### 完整录制→保存→加载→回放

\`\`\`
// 1. 开始录制
runtime(action="record_start", project_path="D:/game")
// → { status: "ok", message: "Recording started" }

// 2. [模拟玩家操作]
game_input(method="send_key", params={ "key": "Key_W", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 320, "y": 240, "button": "left", "pressed": true })

// 3. 停止录制
runtime(action="record_stop", project_path="D:/game")
// → { events_json: "{\\"version\\":1,\\"duration_ms\\":1200,\\"events\\":[...]}" }

// 4. 保存到文件（注意：始终自动命名，忽略传入的 file_name）
runtime(action="record_save", project_path="D:/game", file_name="recording_test_login.json", events_json="<从 stop 获取>")
// → { success: true, data: { saved: { file_name: "recording_20260607_220255.json", path: "res://recordings/recording_20260607_220255.json" } } }

// 5. 后续加载并回放（注意：record_load 可能被沙箱拦截，推荐直接用 events_json）
// 方式 A：通过文件加载（可能被沙箱拦截）
runtime(action="record_load", project_path="D:/game", file_name="recording_20260607_220255.json")
// → { events_json: "..." }

// 方式 B（推荐）：直接用 record_stop 返回的 events_json，跳过文件加载
runtime(action="record_play", project_path="D:/game", events_json="<从 stop 直接获取>", speed=1.0)
// → { status: "ok", events_played: 5 }
\`\`\`

### 与 game_wait 结合的 E2E 测试

\`\`\`
// 录制一次操作，后续自动回放 + 验证
runtime(action="record_load", project_path="D:/game", file_name="recording_open_menu.json")
runtime(action="record_play", project_path="D:/game", events_json="<loaded>", speed=2.0)
game_wait(method="wait_for_node", params={ "path": "/root/CanvasLayer/OptionsMenu" })
game_query(method="get_node_properties", params={ "path": "/root/CanvasLayer/OptionsMenu", "properties": ["visible"] })
// → { visible: true } — 测试通过
\`\`\`

### 错误：Bridge 未连接

\`\`\`
runtime(action="record_start", project_path="D:/game")
// → { error: "BRIDGE_NOT_CONNECTED", message: "Recording requires an active game bridge connection" }
// 解决：1. 确认已 game_bridge_install
//       2. 确认游戏正在运行（F5）
//       3. 确认 game_query(method="ping") 返回成功
\`\`\`

## 常见陷阱

- **Bridge 是硬依赖**：\`record_start\`/\`record_play\` 都需要 Bridge 连接。没有 Bridge 则无法录制或回放。
- **文件名格式严格**：\`recording_test.json\`（❌ 不匹配）、\`recording_test_login.json\`（✅ 匹配）。必须以 \`recording_\` 开头、\`.json\` 结尾。
- **回放时序**：speed > 1.0 会加速回放，但可能因游戏帧率跟不上导致事件丢失。建议 E2E 测试使用 speed=1.0。
- **录制文件存储在项目内**：\`res://recordings/\` 下的文件会随项目版本控制。敏感录制应在 .gitignore 中排除。
- **事件类型有限**：仅捕获键盘（key）和鼠标（mouse_click）事件。触摸、手柄等不适用。
- **record_load 沙箱限制**：\`record_load\` 需要文件读取，可能被 GDScript 沙箱拦截（"Sandbox violation: File access"）。推荐直接将 \`record_stop\` 返回的 \`events_json\` 传给 \`record_play\`，跳过文件加载。
- **record_play 需要 Bridge 连接**：回放通过 Bridge 逐条发送事件（send_key/send_mouse_click），不支持 headless 模式。不支持的按键（如功能键 F1-F12）会被跳过并记录到 errors 中。
`,

  'godot-mcp-engine-quirks.md': `---
description: "godot-mcp 引擎陷阱 物理查询 碰撞体 ConcavePolygonShape3D CollisionLayer Mask ArrayMesh GenerateNormals GLB headless RID leak _Ready Free QueueFree Camera2D screenshot 截图 导航 bake shader compile_success MaterialOverride MultiMesh modulate self_modulate 级联 Label 垂直对齐 vertical_alignment 行高钳制 minimum_size ProgressBar 最小高 原型还原"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 定位

这是 **Godot 引擎行为知识库**——不是工具调用指南（见 core/editor/bridge 等），不是语言教程。使用 MCP 工具操作 Godot 时会遇到这些**隐蔽的引擎陷阱**：多数无错误、无警告，静默失败，靠经验规避。按工具场景分组。

来源：吸收自 godogen（\`D:\\GitHub\\godogen\\godot\\skills\\godogen\\quirks.md\`）的引擎级、语言无关陷阱，剔除 C# 专属项（SetScript dispose / partial class / SceneBuilderBase 等），保留 GDScript 项目同样会踩的引擎行为。★ 标记对 MCP 工具直接相关、最易踩的重点。

## 截图与捕获（screenshot / execute_gdscript 捕获脚本）

- **★ \`--write-movie\` 第一帧在 \`_Process()\` 前渲染**：捕获序列的 frame 0 可能在 \`_Process\` 首次执行前生成。camera 若在 \`_Process\` 定位，frame 0 是 junk 帧。在 \`_Initialize()\` 用 \`Position\`/\`RotationDegrees\` 预置 camera（**勿用 \`LookAt\`**——节点未入树，空间方法失效）。关联：screenshot(capture)、execute_gdscript SceneTree 捕获脚本。
- **静态/动态场景的 fps 选择**：静态（UI/装饰/地形）\`--fixed-fps 1\`；动态（物理/移动/玩法）\`--fixed-fps 10+\`。低 FPS 使 \`delta\` 过大，引发物理 tunneling 和 erratic 行为。关联：screenshot(capture)。
- **★ 帧哈希全部相同 = 捕获接错**：若序列所有帧哈希一致，不要认定捕获成功——通常是 camera/time stepping/scripted input 接错。这是 frame-verify 的核心反作弊判据之一。关联：screenshot(capture)、frame-verify。

## 物理查询（physics / scene 碰撞体）

- **★ RayCast3D 不可靠检测 ConcavePolygonShape3D**：\`RayCast3D\` / \`PhysicsRayQueryParameters3D\` 对 \`ConcavePolygonShape3D\` 碰撞检测不可靠。用 \`PhysicsShapeQueryParameters3D\`（shape cast）或直接查 mesh 几何（SurfaceTool closest-point）做 trimesh 地形的落地/表面检测。关联：physics(raycast)——raycast 工具对 trimesh 地形会漏检。
- **ConcavePolygonShape3D 需顺时针 winding（Jolt）**：逆时针三角面产生朝下法线——物体从上方穿透，从下方碰撞。用平面 quad 测试：RigidBody 穿透则反转三角形索引顺序。关联：scene 创建碰撞形状、physics(body_info)。
- **BoxShape3D 在 trimesh 上卡边**：在 ConcavePolygon/trimesh 表面滑动的对象（载具/滚动体）用 \`BoxShape3D\` 会卡碰撞边（Godot/Jolt bug），改用 \`CapsuleShape3D\`。关联：scene 物理体。
- **★ CollisionLayer/Mask 是 bitmask 非 UI index**：\`CollisionLayer\`/\`CollisionMask\` 在代码里是 bitmask，不是编辑器 UI 层号。UI Layer 1=bitmask 1, Layer 2=2, Layer 3=4, Layer 4=8（2 的幂）。\`CollisionLayer=4\` 是 UI Layer 3，**不是 Layer 4**。关联：scene/edit_node 设碰撞属性、physics。
- **★ 默认 CollisionMask=1 漏非默认层**：新碰撞体默认 \`CollisionMask=1\`，若地形/墙用 layer 2+，玩家穿透**且无错误**。务必显式设 mask 覆盖所有该碰的层。关联：scene 物理体。

## 场景与资源导入（scene / edit_node / import_resources）

- **★ \`.gdignore\` 静默阻止整个目录导入**：任何目录放 \`.gdignore\` 会让 Godot importer **完全跳过**它。绝不在 \`assets/\` 放——只有 \`screenshots/\` 等捕获目录该放。纹理不导入时先查散落的 \`.gdignore\`。关联：import_resources、scene 加载纹理、screenshot。
- **★ ArrayMesh.GenerateNormals() 是阴影必需**：程序化 mesh（SurfaceTool/raw ArrayMesh）不调 \`GenerateNormals()\` 则不接收阴影——**无错误、无警告，阴影就是不出现**。手动算的法线（即使视觉正确）也可能破坏阴影接收，始终用 \`GenerateNormals()\`。关联：execute_gdscript 程序化 mesh、screenshot 查阴影。
- **GLB MaterialOverride 不序列化进 .tscn**：GLB 内部 MeshInstance3D 的 MaterialOverride 不持久化（owner 设置跳过有 \`SceneFilePath\` 的子节点）。需程序化 ArrayMesh 才能自定义材质。关联：scene/edit_node 改 GLB 材质。
- **MultiMeshInstance3D + GLB pack 后不渲染**：mesh 资源引用在 pack+save 序列化时丢失。用独立 GLB 实例替代。关联：scene 实例化、save_scene。

## Headless 执行（execute_gdscript / run_and_verify）

- **★ headless RID leak errors 无害**：headless 场景构建/退出总产生 \`leaked RID\`/\`Leaked instance\`/\`ObjectDB instances\` 错误，**无害，忽略**。run_and_verify 分析错误时不应把这些当真错误误报。关联：run_and_verify、execute_gdscript。
- **\`_Ready()\` 在 \`--script\` 的 \`_Initialize()\` 不触发**：\`godot --script\` 运行 SceneTree 脚本时，实例化场景节点的 \`_Ready()\` 在 \`_Initialize()\` 期间不触发，须 \`Root.AddChild(node)\` 后手动调 init 方法。关联：execute_gdscript 完整类模式。
- **\`Free()\` vs \`QueueFree()\`**：\`QueueFree()\` 把节点留到帧末才移除，阻塞 name 重用；测试脚本里立即替换场景用 \`Free()\`。关联：execute_gdscript 测试脚本。
- **★ \`execute_gdscript --script\` 不认 GutTest → 用 \`run_tests\`**：headless CLI \`godot --script\` 要求脚本 \`extends SceneTree\`/\`MainLoop\`，直接跑 \`extends GutTest\`（Node 子类）的 GUT 测试脚本必失败，弹窗 "Can't load the script ... as it doesn't inherit from SceneTree or MainLoop"。跑 GUT 单元测试用 \`runtime\` 工具的 \`run_tests\` action——它封装 \`godot --headless --script addons/gut/gut_cmdln.gd -gdir=<test_script> -gquit\`（\`test_script\` 默认 \`res://test/\`、须 \`res://\` 前缀，I-SEC-08 防目录穿越，自动解析 Tests/Failed 计数，120s 超时）。前提：项目装了 GUT addon（\`addons/gut/gut_cmdln.gd\`）。关联：execute_gdscript、runtime(run_tests)。
- **★ \`check:gdscript\` 编译层抓不到运行时类型错（2026-09-03 审查 I-F）**：\`--import\`/\`load()\` 编译只验证语法与静态类型——\`var x: Array = params.get(...)\`（Variant 赋给类型化变量）**编译通过**，运行时接 Dictionary/嵌套容器/null 直接 SCRIPT ERROR。这是 send_drag 崩溃事故与 \`_vec2_from_param\` 元素级缺陷的共同盲区：「编译过 = 安全」是误判。真机行为锚定走 GODOT_PATH 门控 e2e（\`test/scene-gd-operations-e2e.test.ts\` 的 skipIf 模式，单例秒级）。另真机实证（4.7）：\`float(null)\`/\`float([1,2])\`/\`float({"x":1})\` 均运行时崩（"float() 对 null 安全"是错误结论）；MCP 输入是任意嵌套 JSON，数值参数须白名单守卫（\`_num()\` 先例，对齐 \`_is_valid_touch_index\`）。关联：game_input 输入归一、bridge 同步分发（无异常隔离，一处崩全桥堵死）。

## 输入与相机（game_input / screenshot）

- **Camera2D 无 Current 属性**：设当前用 \`MakeCurrent()\`，且节点须已在场景树中。关联：scene 加 Camera2D、game_input。
- **Chase camera 每帧重设 Current 覆盖测试 camera**：游戏 camera 在 \`_PhysicsProcess\` 设 \`Current=true\` 会每帧覆盖测试/捕获 harness 的 camera。测试 harness 须**每帧禁用游戏 camera**。关联：screenshot 测试、execute_gdscript。
- **相机 Lerp 首帧从原点 swoop**：\`_PhysicsProcess\` 中 \`Lerp\` 的相机首帧从 (0,0,0) 飞过来。用 \`_initialized\` flag 首帧 snap 位置，后续帧再 lerp。关联：screenshot、execute_gdscript。

## 材质与着色器（material / shader_write / shader_apply_template）

- **★ \`compile_success\` 是假绿（C-BUG-1）**：\`shader_write\` / \`shader_apply_template\` 返回的 \`compile_success: true\` **仅确认 shader 资源已分配（\`get_rid().is_valid()\`），与代码能否编译无关**——Godot 4.x headless 无可靠 shader 编译验证 API（RenderingServer 不实际编译）。AI 看到 \`compile_success: true\` 易误判 shader 正确（与 \`run_tests\` 认知缺口同类假绿）。**必须**经截图或 Godot 错误输出人工确认；返回结构里的 \`verification_note\` 文本已提示，但勿只看布尔值。关联：material(shader_write/shader_apply_template)。

## 导航（navigation / nav_create_region / nav_query_path）

- **★ \`query_path\` 静默返回空路径**：无导航数据（未创建 region 或未烘焙）时，\`query_path\` 返回 \`path: []\` + \`path_length: 0\` + \`warning: "No navigation data available"\`，**不报错**。\`create_region\` 默认 \`bake=false\`——忘记单独调 \`bake_mesh\` 则后续 \`query_path\` 静默返回空。正确工作流：\`create_region\` → \`bake_mesh\`（单独 120s 超时，其他 action 30s）→ \`query_path\`。看到空 path 先回头确认已 bake。关联：navigation(query_path/create_region/bake_mesh)。

## 节点定位与坐标实测（scene / edit_node / game_query 坐标读取 / UI 布局调试）

- **★ 三种坐标系不可混算**：Sprite2D/Node2D 系的 \`position\` 是节点原点，Sprite2D 还有 \`centered\`（true=纹理以 position 为中心绘制，false=从 position 起绘）+ \`offset\`；Control 系（TextureRect/Button/Panel 等）用 \`anchor\` + \`offset_left/right/top/bottom\`，\`position\` 是相对父节点左上角且受父 Container 布局影响，\`global_position\` 才是屏幕坐标。纸面推算「Sprite2D 视觉中心」vs「TextureRect anchor 位置」vs「Control global_position」三者极易错，必须读运行时真实值再算。关联：scene/edit_node 设坐标属性、game_query(get_node_properties) 读坐标、UI 布局调试。
- **★ 定位类问题先实测不纸面猜**：调坐标/布局/对齐时第一步用 game bridge 读真实值，不要 headless 截图（空白，见「截图与捕获」段）或纸面推算：(1) \`game_query find_nodes\` 确认真实节点路径与类型；(2) \`game_query get_node_properties\` 读 \`position\`/\`global_position\`/\`size\`/\`offset_*\`；(3) \`game_query take_screenshot\`（GPU 真渲染）+ 视觉确认实际渲染的是哪个元素；(4) 看到真实数据再改。反例：据「偏右上」反馈想当然以为是 lock 按钮、反复改 4 次无果，game bridge 实测发现根本没 lock、偏的是角标——根因就是没第一时间实测。关联：game_query/find_ui_elements、screenshot（headless 空白）；headless 截图根因见 godot-mcp-core.md「Headless 截图限制」。\`get_node_layout\` method 一次返全布局（含 \`global_position\` 成对），优先于手动拼 \`get_node_properties\` 扁平 dump。
- **Node3D.scale 对部分节点无效**：Node3D.xml 原文 "The behavior of some 3D node types is not affected by this property. These include Light3D, Camera3D, AudioStreamPlayer3D"。\`get_node_layout\` 照读这些节点的 scale 值，但引擎忽略——AI 勿用 scale 对这几类节点做布局推断。关联：game_query(get_node_layout) Node3D 分支。
- **★ \`set_anchors_preset\` 不改 offset，\`set_anchors_and_offsets_preset\` 才改**：\`Control.set_anchors_preset(preset, keep_offsets=false)\`（Godot 4.7 headless 实测：默认 / 显式 false / 显式 true 三种形式）**只设 anchor 分数，不动 offset_left/right/top/bottom**，\`keep_offsets\` 参数对 offset 无实际影响。只有 \`set_anchors_and_offsets_preset(preset)\` 才重算 offset（如 FULL_RECT → offsets 全归 0）。后果：do 用 \`set_anchors_preset\` 时，undo 只记 4 anchors（property op）即完整还原（offset 没被动过）；若 do 用 \`set_anchors_and_offsets_preset\`，undo 必须补记 4 offsets。reviewer/code 易误判"set_anchors_preset(keep_offsets=false) 会重算 offset 致 undo 不全"——实测不成立。关联：ui_anchor_preset、game_query Control 布局、D-P2 Task3 final review Important#1（实测推翻）。

## UI 渲染与控件尺寸（ui_import_prototype / ui 布局 / modulate 染色）

- **★ \`modulate\` 乘性级联影响整个子树，\`self_modulate\` 只染自身**：\`modulate\` 与子节点 modulate 相乘作用到所有后代——给布局壳设 \`modulate:[1,1,1,0]\` 想做"透明占位"会让**整个子树跟着消失**（无错误无警告）。仅染自身用 \`self_modulate\`；透明布局壳必须 \`self_modulate\`。\`ui_import_prototype\` 翻译器对透明壳已固定走 self_modulate（bg 走 StyleBoxFlat 通道，翻译器不再产出 modulate 染色）。关联：ui_import_prototype(bg/透明壳规则)、ui_create_control(properties.modulate)。
- **★ Label 垂直对齐默认 TOP，CSS line-height 居中惯用法失效**：CSS \`line-height = height\` 的文本垂直居中在 Godot 不成立——Label 默认 \`vertical_alignment=0\`(TOP)，单行文本会贴顶。需显式 \`vertical_alignment=1\`(CENTER)。\`ui_import_prototype\` 翻译器对全部 Label 已固定 \`vertical_alignment:1\`；手写 properties 时勿漏。关联：ui_build_layout/ui_create_control 文本节点、ui_import_prototype 翻译规则 3。
- **Control 高度被字体最小行高钳制（minimum_size 顶开）**：Label/Button 的 rect.h 小于字体行高时，引擎 \`Control.minimum_size\` 把高度顶开到行高——**无警告静默变高**，verify 的 \`dh\` 会暴露（实际比目标高）。文本控件 rect.h 需 ≥ fontSize*1.5，或显式调小字号。\`ui_import_prototype\` 翻译器对 rect.h < fontSize*1.5 发 warning（"可能被字体最小行高钳制"）。关联：ui_import_prototype 行高预警、ui_measure_layout(layout_verify.diff 的 dh)。
- **★ ProgressBar 默认主题最小高 27px（Godot 4.7，实测）**：默认主题 stylebox 把 ProgressBar 的 \`Control.minimum_size\` 顶到约 27px——原型 rect.h=16 落地实测 27px（2026-08-16 RTS HUD fixture HpBar 集成验收，dh=+11）。这是主题硬约束非 bug；处置：原型侧把 rect.h 调到 ≥27，或换自定义 Theme stylebox。\`ui_import_prototype\` 翻译器对 rect.h < 27 发 "will be clamped" warning（具名常量 PROGRESS_BAR_MIN_HEIGHT=27，**无条件**——实测 Godot 4.7.1 h=16：无 override→27、bg-only→23、fill-only→27、bg+fill→23，全组合被钳，override 只改变钳制值不消除钳制）。同类：Button 默认主题也有最小高约束。关联：ui_import_prototype 引擎下限预警、ui_set_theme。

## 多人联机与弱网测试（network_conditioner / ENet peer / 多人 e2e）

- **★ ENetMultiplayerPeer.get_local_port() 在 Windows Godot 4.6.3 阻塞挂死主循环（实测）**：探针二分定位——create_server(0) 返回 OK、set_multiplayer_peer 不挂，**唯独 get_local_port() 调用后进程无响应挂死**（--script 探针与完整游戏均复现，stdout 因挂死未 flush 看似无输出）。多人 e2e fixture 与探针一律**不调 get_local_port()**；需要端口信息的场景改从 create_server 显式传端口 + 自记录。关联：test/fixtures/p3-e2e/main.gd setup_net_peer 注释、network_conditioner e2e。
- **多人 peer 未配置时 get_multiplayer_peer() 返回 OfflineMultiplayerPeer 而非 null**：判断"多人未启用"要同时查 null 与 \`is OfflineMultiplayerPeer\`（bridge network.set_conditions 的空壳防护即此形态）。
- **弱网注入只作用于出向包**：host 侧装 conditioner = 影响 host 发给所有 client 的包；双向对称弱网需两端各装。无带宽限制；raw socket 不走 MultiplayerPeer 管道（依赖 SceneMultiplayer 高阶 API）。
`,

  'godot-mcp-workflow-bridge-e2e.md': `---
description: "bridge e2e 运行时验证 game_bridge_install run_project wait_for_bridge game_query ping game_input game_wait take_screenshot frame-verify 录制 回归测试 输入模拟 —— 当你需要验证运行时行为、做 E2E 测试、模拟输入或回归测试时使用"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 运行时验证 / E2E 流程

把"安装 Bridge → 启动游戏 → 连接 → 模拟输入 → 留证"串成可遵循的 checklist，避免遗漏前置步骤。工具细节见 \`godot-mcp-bridge.md\` 与 \`godot-mcp-recording.md\`。

**何时用**：需要验证运行时行为、做 E2E 测试、模拟输入、回归测试、Bug 复现时。

**checklist**：
- [ ] 1. \`game_bridge_install(project_path)\` — 一次性安装 Bridge autoload（端口 9081，写 project.godot）
- [ ] 2. \`run_project(project_path, wait_for_bridge=true)\` — 启动游戏并等 Bridge 就绪（\`bridge_timeout\` 默认 10s）
- [ ] 3. \`game_query(method="ping")\` — 确认连接（期望 \`status: "ok"\`）；未连排查：未 install / 游戏没运行 / 密钥权限
- [ ] 4. 操作 + 验证：\`game_input\`（send_key/send_mouse_click/send_text）模拟输入 → \`game_wait\`（wait_for_node/wait_for_property）等状态变化
- [ ] 5. 留证：\`take_screenshot\`（**GPU viewport 真渲染**，非 headless 空白）/ 或 \`frame-verify\`（反作弊退化检测）

**常见偏离**：
- 忘记 \`game_bridge_install\`（query/input 直接报 BRIDGE_NOT_CONNECTED）
- 游戏没运行就 query（Bridge 只在游戏运行时监听）
- 用 headless \`screenshot\` 做运行时视觉确认（headless 用 RendererDummy，2D/3D 均空白）→ 必须用 bridge \`take_screenshot\`
- 节点路径不用绝对路径（\`game_write\`/\`game_wait\` 的 \`path\` 必须以 \`/root/\` 开头）
`,

  'godot-mcp-workflow-verify.md': `---
description: "验证闭环 run_and_verify validate_scripts verify_delivery read_scene edit_script 交付门禁 编译 跨文件依赖 parse error 场景树完整性 —— 当你改完代码/场景需要验证或交付前自检时使用"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 改 → 跑 → 验证闭环

把"理解 → 改 → 跑 → 编译验证 → 交付门禁"串成 checklist，避免只跑一种验证就交付。工具细节见 \`godot-mcp-core.md\`。

**何时用**：改完代码/场景后需要验证、交付前自检时。

**checklist**：
- [ ] 1. \`read_scene\` / \`read_script\` — 理解现有结构（属性类型解析）
- [ ] 2. \`edit_script\`（**search_and_replace 优先**）/ \`write_script\` — 修改
- [ ] 3. \`run_and_verify(capture_tree=true)\` — headless 跑 + 结构化错误分析（自动识别 autoload 相关 headless_limitation）
- [ ] 4. \`validate_scripts\` — 触发 Godot 完整 \`load()\` 编译（含**跨文件依赖**，捕 headless 运行遗漏的 Parse Error）
- [ ] 5. \`verify_delivery\` — 交付门禁（场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 合规）

**常见偏离**：
- 只跑 \`run_and_verify\` 不跑 \`validate_scripts\`（漏跨文件编译错误——两者可能不一致，以 run_and_verify 实跑为准但 validate_scripts 补跨文件依赖）
- 运行时工具（signal/tilemap/particles 等）误认为持久化（headless 退出即丢失，持久化须 add_node + save_scene）
- 忘记 \`_mcp_done()\`（execute_gdscript 片段模式超时）
`,

  'godot-mcp-workflow-safe-edit.md': `---
description: "安全编辑 edit_script search_and_replace validate_scripts 确认令牌 remove_node headless 改盘 editor 覆盖 沙箱 防误用 CRLF tab 缩进 —— 当你编辑 .gd/.tscn、删节点或执行危险操作时使用"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 安全编辑流

编辑 \`.gd\`/\`.tscn\`、删节点、运行危险操作时的防护 checklist。工具细节见 \`godot-mcp-core.md\` 与 \`godot-mcp-editor.md\`。

**何时用**：编辑 \`.gd\`/\`.tscn\`、删节点、执行危险操作时。

**checklist**：
- [ ] 1. \`edit_script\` **优先 search_and_replace**（内容匹配、行号偏移鲁棒、CRLF 安全、免确认 token）；**禁用内置 Edit 工具改 .gd**（tab 缩进匹配率极低）
- [ ] 2. 改 \`.gd\` 后必跑 \`validate_scripts\`（验证语法）
- [ ] 3. headless 改盘 + editor 开同场景 → Ctrl+S 覆盖风险：建议 editor 内 Reload 场景或关闭该场景后再操作
- [ ] 4. 危险操作（\`remove_node\` 等）需显式确认令牌
- [ ] 5. GDScript 沙箱是**防误用层非防对抗**（间接构造可绕过；真正隔离须容器/VM + \`GODOT_MCP_ALLOW_UNSAFE=false\`）
- [ ] 6. \`write_script\`/\`edit_script\` 写 .gd 前也走沙箱扫描（与 \`execute_gdscript\` 同威胁面，发现已知危险 API 模式（含 @tool 加载即执行等，清单不列举防被侦察）阻断 SANDBOX_VIOLATION；双 opt-in 旁路 \`UNRESTRICTED + DISABLE_SAFETY\`）

**常见偏离**：
- 用内置 Edit 工具改 \`.gd\`（tab 缩进失败）
- 改完不 validate
- headless 改盘后被 editor 旧版本 Ctrl+S 覆盖（MCP 不可控，须 Reload）
`,
};
