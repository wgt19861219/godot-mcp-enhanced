---
description: "godot-mcp 核心指南 模式选择 Headless Editor Bridge execute_gdscript edit_script dev_loop run_and_verify validate_scripts verify_delivery 运行时 持久化"
alwaysApply: true
---

> 适用于 godot-mcp-enhanced v0.39.0+

## 概述与架构

godot-mcp-enhanced 提供 46 个 MCP 工具（279 个 action，权威数据见 docs/capability-matrix.md，由 `npm run build-matrix` 生成），通过三层架构操作 Godot：

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
- **⚠️ 沙箱安全限制（C-04 已知限制）**：GDScript 沙箱扫描基于正则匹配（非语法解析），设计用于防止**意外误操作**，**不可防御恶意/蓄意绕过**。已知绕过向量包括：
  - 字符串拼接：`str("OS")+".cmd()"` 或 `%` 格式化构造危险 API 名
  - 变量间接调用：通过 `call()` / `funcref()` 的非字面量参数绕过静态扫描
  - 注释中包含危险 API 名称会导致误报拦截（安全侧失败）
  - **适用场景**：本地单用户开发环境（信任调用者）。**不适用于多用户/远程/不可信输入场景**——后者需要容器/VM 隔离 + `GODOT_MCP_ALLOW_UNSAFE=false`
  - **write_script/edit_script 也走沙箱扫描**：写入 .gd 前对内容调 `scanGdscriptSandbox`，发现已知危险 API 模式（清单不列举防被侦察）则阻断（SANDBOX_VIOLATION），与 execute_gdscript 同威胁面对齐。双 opt-in 旁路（`UNRESTRICTED + DISABLE_SAFETY`）

### edit_script — 脚本编辑

- **优先使用 search_and_replace**：基于内容匹配，对行号偏移鲁棒，CRLF 安全。**⚠️ 不要使用 Claude 内置 Edit 工具编辑 .gd 文件**——内置 Edit 无法正确处理 GDScript 的 tab 缩进，匹配率极低。始终使用 MCP 的 `edit_script` + `search_and_replace` 参数。
- **search_and_replace 免确认**：使用 `search_and_replace` 模式的 `edit_script` 无需 confirmation token，直接执行，减少 API 调用。
- **行范围模式**（start_line/end_line）：仅在 search_and_replace 无法使用时（如批量重复修改）。仍需 confirmation token。
- **indent_mode**：`smart`（推荐）自动对齐缩进；`raw` 仅在确认缩进正确时使用。
- **verify_content**：提供期望内容作为守卫，防止过时的行号编辑。

### dev_loop vs 单独工具

- **dev_loop**：执行 GDScript → 可选验证 → 可选 Bridge 查询/截图 → 可选断言 → 可选状态保存。适合一体化验证流程。
- **★ dev_loop 的 `code` 全行匹配 E2E DSL 会静默切 Bridge 序列**：若 `code` 每一非空行都匹配 DSL 语法（`waitFor(...)`/`click(x,y)`/`press(...)`/`typeText(...)`/`waitMs(...)`），dev_loop **不执行 GDScript，而是逐行作为 Bridge 命令**发送（返回 `mode: "dsl"`）。传含 `click(100,100)` 的内容会被当 bridge 脚本——意图跑 GDScript 时避免整段恰好全是 DSL 语法。
- **dev_loop `acceptance.assertions` 三类型前置条件**：`gdscript`（默认，headless 跑断言脚本）、`screenshot_diff`（**需 Bridge 连接**，take_screenshot + 可选余弦相似度预筛 + 可见性检查）、`frame_degradation`（**需先 `frame_sequence` 捕获帧**或手动提供 `frames_dir`，否则无帧可比）。用高级断言前先确认前置满足。
- **单独工具**：execute_gdscript + validate_scripts + run_and_verify 灵活组合。适合多步调试或需要中间检查的场景。

### debug — 断点管理（editor-only）

- **set_breakpoint**：在 GDScript 指定行设断点（走 CodeEdit gutter，gutter 可见 + 现行 game 命中 + 下次 run 同步保持）。
- **clear_breakpoint**：清除指定行断点。
- **list_breakpoints**：列出当前活跃 tab 脚本的断点。
- **⚠️ Phase 1 限制**：脚本必须在编辑器中打开且是当前活跃 tab。headless 模式返回 EDITOR_ONLY。

### dap — DAP 断点调试（P9，TS 直连 editor DAP server）

LuoxuanLove 移植：MCP server 直连 Godot editor 自带 DAP server（Debug Adapter Protocol，默认 127.0.0.1:6006）——引擎官方调试协议，比对标竞品"按图标找调试器按钮"的面板 hack 稳。与 `debug` 工具（editor 插件 EditorDebuggerPlugin 路径）并存互补；断点/单步调试优先用本工具。

- **前置（一次性）**：editor 开启调试服务器——Editor Settings → Network → Debug Adapter（默认端口 6006）；launch 调试还需 Debug 菜单勾选 "Deploy with Remote Debug"。未开启时 `initialize` 报 DAP_UNAVAILABLE（附开启指引）。
- **会话流（三段状态机，乱序拒）**：`initialize`（建 TCP + DAP 握手）→ `launch`（让 editor 启动调试会话；或 `attach`）→ `set_breakpoint`（可多次）→ `configuration_done`（断点下发完成）→ 断点命中后 `stack_trace` / `step_over` / `continue` / `pause`；`output` 收集调试输出；`disconnect`（可选 terminate_debuggee）/`terminate` 收尾。
- **断点语义**：本地簿记 + `setBreakpoints` 全量重发（DAP 全量协议）；上限 512 sources × 256 lines；`list_breakpoints` 读本地簿记。source_path 接受 `res://`（须配 project_path 转绝对路径）或绝对路径。
- **安全**：host 强制 loopback（127.0.0.1/localhost/::1；远程需 set_settings allow_remote_hosts 显式开）；DAP 响应经 sensitive-key 清洗（token/password/authorization/bearer 等键值 → [redacted]，防调试输出泄漏 secret）；超时上限 30s；会话上限 8。
- **限制（诚实声明）**：只覆盖 GDScript（C# 断点需 .NET debugger，引擎 DAP scope）；`attach` 对 Godot DAP 支持有限（协议层透传，由 server 行为决定）；`stack_trace` 需暂停在断点；e2e 未覆盖真 editor（单测用 mock DAP server 覆盖协议层/状态机/清洗/上限，真 editor 路径手动验证）。
### engine — 实时 ClassDB 内省（editor-only）

- **class_info**：查单个类的完整结构（属性/方法/信号/枚举/继承），默认 no_inherit=true 只看本类 own 成员。
- **search**：substring 匹配类名（返回 {name, parent} 列表，上限 100 条）。
- **get_inheritance**：返回类的继承链（从本类到 Object）。
- **vs docs**：docs 是静态 4.7 快照（离线），engine 是运行中引擎的真实 ClassDB（含第三方 addon/自定义类/实际版本差异）。

### run_and_verify vs 手动组合

- **run_and_verify**：一键 headless 运行 + 错误分析 + 可选场景树快照。适合快速检查。**自动读取 project.godot 的 autoload 配置**，将 autoload 单例相关的"Identifier not found"错误标记为 headless_limitation 而非真实错误，减少误报。
- **手动组合**：run_project + get_debug_output + stop_project。适合需要精细控制运行时长的场景。
  - `run_project` 支持 `wait_for_bridge` 参数（默认 false）：true 时等待 Bridge 就绪再返回（用 `game-bridge.isBridgeReady` 零接触探测）。
  - `run_project` 支持 `bridge_timeout` 参数（默认 10 秒）：等待 Bridge 就绪的最大超时时间。
  - `run_project` 支持 `preview` 参数（默认 false）：true 时禁用自动停止，游戏窗口常驻，用户关闭窗口即结束——用于 AI 改完视觉内容后的收尾验证（见下「视觉改动收尾流程」）。

### 视觉改动收尾流程（preview 预览模式）

AI 改动涉及用户需要看到效果才能验收的内容（`.tscn` / UI 脚本 / 样式 / 场景结构等）后，收尾动作不是让用户打开编辑器：

1. `validate_scripts` 快速语法验证（避免弹一个崩溃的窗口）；
2. `run_project(preview=true)` 弹出常驻游戏窗口；
3. 告知用户"游戏窗口已弹出，请确认效果，关闭窗口即验证结束"；
4. 用户关窗后 `get_debug_output` 检查运行时错误并汇报（运行结束后输出仍可读，`source` 标注 `last_finished_run`）。

- 纯逻辑 / 测试 / 文档改动不弹窗。
- preview **默认不传 `wait_for_bridge`**：bridge 未就绪会终止游戏进程，窗口会在用户眼前闪现即逝；仅当确实需要 bridge 查询运行时状态且项目 bridge 就绪快时才组合。
- 新一轮 `run_project` 会先停旧进程再起新窗口；旧输出经快照自动留档，换窗前可先 `get_debug_output` 保存上一轮错误。
- 多项目并存：`run_project` 可并行运行多个项目（窗口并存，上限 `GODOT_MCP_MAX_SESSIONS` 默认 4）；
  同项目重复 run 会先停旧进程。查错/停止其他项目用 `stop_project`、`get_debug_output` 的 `project_path` 参数。
- bridge 查询/输入模拟对最近 `run_project` 的项目生效；profiler 采样最近一次 profiling 会话（不被无关 run 销毁）。

## 运行时 vs 持久化

部分工具在 headless 进程中创建/修改节点，但**这些变更不持久化到 .tscn 文件**：

- **运行时工具**（不持久化）：signal(action=connect/disconnect/emit)、scene(action=create_3d_node)、physics(action=raycast)、tilemap_*、audio_*、particles_*、ui_*、runtime(action=record_*) 等
- **持久化方法**：使用 add_node（写入 .tscn）+ save_scene 保存。或用 write_script / edit_script 修改 .gd 文件。

> 运行时工具适合验证和测试。若需持久化场景修改，必须使用 add_node + save_scene。

## 内存治理（memory-guard，一期 0.38+ / 二期 0.39+）

多实例连跑/大批量测试把机器内存打爆（全量 GUT 22.5GB 死机类事故）的治理面，三层：

- **L1 准入**：每次 Godot spawn 前依次过查——水位双口径（物理空闲与 commit 余量均 ≥ `GODOT_MCP_MIN_FREE_MB`，默认 3072MB）/ 声明预算（Σ max(租约声明, 实测RSS) ≤ `GODOT_MCP_MEM_BUDGET_PCT`%×物理总量，默认 67）/ 机器实例 ≤ 8 / 二期软阈值（pressure 态拒新保旧）。**看到 `MEMGUARD_*` 拒绝不是 bug，是治理在干活**：stop_project 释放 / 调 `GODOT_MCP_DECLARED_MB_<KIND>` 上调档位 / `GODOT_MCP_MEMORY_GUARD=0` 豁免（风险自担）。
- **L2 看门狗**：10s 轮询租约 pid RSS——单进程超声明×系数（headless/gut_shard ×2、game_window/editor ×3）树杀并报 `MEM_BUDGET_EXCEEDED`（附档位上调指引）；整机软阈值跌破 `GODOT_MCP_MEM_PRESSURE_SOFT_MB`（默认 3072MB）持续 30s 进 pressure（拒新保旧，在跑任务不动）；硬阈值跌破 `GODOT_MCP_MEM_PRESSURE_HARD_MB`（默认 1536MB）立即驱逐（实测÷声明降序，preview/editor 殿后，杀到脱离+2GB 余量即停，外部进程永不杀）；三期起驱逐候选可经 `GODOT_MCP_WATCHDOG_EXEMPT`（逗号分隔 preview/editor，未设=无豁免）整组豁免——命中组不进候选（殿后语义不变：未命中组仍排序最后可杀），单进程硬帽不受影响，未知 token warn 忽略（面板 `watchdogExempt` 字段可见）。
- **L3 面板**：`godot_get_context` 的 `memory` 对象与 `doctor` 的 Memory guard 段——双口径水位 / 预算与已占用 / pressure 状态 / 活跃实例表（pid/项目/kind/声明/实测 RSS/最后交互，实例 RSS 由 TS 侧按 registry pid 采样）。**pressure≠normal 或遇 MEMGUARD 拒绝时先看面板再决定 stop/调档/等待**。

二期生命周期：非 preview 会话 15min 无 bridge 交互自动回收（`GODOT_MCP_SESSION_IDLE_MINUTES`，0=关；preview 窗口豁免）；server 退出时优雅回收全部非 preview 会话（10s 有限等待 → 二次触发强杀 → 30s 兜底）。拒绝/驱逐/回收日志可 grep `MEMGUARD`。CI 连跑场景 `GODOT_MCP_MEMORY_GUARD=0` 一键全关。

## 绑脚本场景（B 轨）结构改动推荐通道

场景绑定的 `.gd` 脚本若引用 **autoload 单例或全局 class_name**（跨文件依赖），headless `load()` 该场景会因脚本编译失败而返回 null——headless 片段进程缺完整项目上下文，autoload 相关 "Identifier not found" 属已知 headless 限制（`run_and_verify` 同源将其标记为 headless_limitation）。此类场景的**结构性改动（加/删/改节点）必须走编辑器 WS 通道**：`launch_editor` → 编辑器内打开目标场景 → `add_node`/`edit_node`/`remove_node`（editor 路由操作活动场景）→ `save_scene`。编辑器有完整项目上下文（autoload 注册 + 全局类缓存），加载此类场景不失败。

- **识别信号**：headless 报 `Failed to load scene: <path> — scene or its attached scripts failed to compile, check script dependencies/autoloads`，且消息尾部附引擎原始错误行（前 5 行，如 `res://player.gd:12: ... Identifier not found ...`）——切编辑器通道，不要在 headless 侧反复重试。
- **headless 仍可用的操作**：`read_scene`（纯文本 parse，不执行脚本）、`edit_script`/`write_script`（改 .gd 源码本身）——只改脚本内容不动场景结构时无需编辑器。
- **错误消息自带归因**：模板 `_mcp_load_scene` 的 null 分支附上述归因提示；`parseGdscriptResult` 把 executor 解析的引擎错误行（`result.errors` 前 5 行）拼进 SCRIPT_EXEC_FAILED/LOAD_FAILED 等错误消息——直接看消息即可定位是脚本依赖问题，无需翻 raw_output。

## Headless 截图限制（2D 与 3D）

Headless 模式下场景截图可能完全空白——headless 进程默认用 **RendererDummy**（无 GPU 渲染后端），不初始化渲染服务器，2D CanvasItem 与 3D mesh 都不渲染像素。实测 Godot 4.7 headless 加载 3D 场景得 `DummyMesh/DummyCamera/DummyMaterial` 泄漏，截图全背景色空白（PIL 色散 spread=0）。**3D 同样受影响**，非仅 2D。

**推荐工作流**：
1. 用 `screenshot(action=capture)` 尝试截图
2. 如果返回 `BLANK_DETECTED` 警告，使用以下替代方案：
   - 用户手动截图（F5 运行后截图）
   - `screenshot(action=analyze)` 返回图片的 base64 数据供 AI 视觉分析（需配合 `image_path` 指定本地文件）
   - Bridge `take_screenshot`（游戏运行时 GPU viewport 渲染，2D/3D 均可）
3. 3D 视觉确认同理需 GPU 模式（Bridge 或 editor/GUI）；headless 下用数据铁证替代（场景加载成功 + ArrayMesh 顶点数据 + 几何拓扑 χ）

## 常见陷阱

- **忘记 `_mcp_done()`**：片段模式中如果没有调用 `_mcp_done()`，执行会超时。
- **edit_script 行号偏移**：多步编辑后行号会变化。始终优先使用 search_and_replace。
- **运行时操作误认为持久化**：运行时工具的修改在 headless 进程退出后丢失。
- **load_autoloads 性能开销**：仅在需要 Autoload 单例时开启，否则启动时间增加 3-5 倍。
- **Bridge 密钥过期**：Bridge 密钥有 5 分钟 TTL 缓存，长时间未操作后首次调用可能稍慢。
- **Headless 截图空白（2D/3D）**：Headless 用 RendererDummy 无渲染后端，2D CanvasItem 与 3D mesh 均不渲染像素。使用 Bridge take_screenshot（GPU viewport）或手动/GUI 截图替代。
- **run_and_verify 可能残留进程**：headless 模式下交互式场景（不自动退出）可能残留 Godot 进程。如果后续 `run_project` 报 "another Godot process is running"，先调用 `stop_project` 清理残留进程。
- **orphan 扫描会话隔离（多会话安全，v0.x+）**：`stop_project` 的 orphan 清理**默认只清本会话 `run_project` 启动过、脱离管理且仍存活的 Godot 进程**（按 PID 集合，无任何 env 可开全系统兜底）。多个并发会话操作同一项目时，互不误杀对方的编辑器/游戏进程。`launch_editor` 启动的编辑器**不纳入** orphan 清理（detached，用户有意长期运行，永不被自动杀）。崩溃恢复（MCP server 重启后内存 PID 集合丢失）不走 `stop_project`，走**启动时清理**：设环境变量 `GODOT_MCP_STARTUP_CLEANUP=true`（feature flag，默认关）后重启 MCP server——启动 sweep 先清死 pid 的 bridge registry 心跳条目（默认面，v0.36.8+），flag 开时再执行两层 Godot 进程清理（第一层 PID 集合毫秒级 + 第二层全系统扫描 15s，按项目目录匹配、跳过 --editor）并连带清死实例 secret。⚠️ 旧名 `GODOT_MCP_FULL_SYSTEM_SCAN` 是无消费者的历史 env 名，设了不生效。**默认关非缺陷，是多会话安全的 opt-in 有意设计（B9）**——全系统扫描按目录匹配会清所有匹配的 Godot，多会话环境慎开。
- **load_autoloads=true 片段模式差异**：`load_autoloads=true` 时片段包装为 `extends Node`（非 `extends SceneTree`），`get_root()` 不可用。需要手写 `extends SceneTree` 完整类模式来访问 SceneTree API。
- **load_autoloads autoload 层级**：`load_autoloads=true` 时 autoload 节点不直接挂在 `get_root()` 下，而是通过 autoload 系统加载。使用 `Engine.get_main_loop().get_root().get_node("autoload/Xxx")` 访问。
- **remove_node 路径格式**：使用 `父名#子名` 格式（如 `Main#ValidationLabel`），而非 `/` 分隔路径。先用 `query_scene_tree` 确认节点名。
- **ui_build_layout 必须传 scene_path**：不传 `scene_path` 会报错 "Failed to load scene"。所有 `ui_build_layout` 调用必须包含 `scene_path` 参数。
- **screenshot analyze 返回格式**：`screenshot(action=analyze)` 返回图片 base64 数据（非文字描述），需配合 `image_path` 参数指定本地 PNG/JPG 文件路径。它不会自动对截图做 AI 文字分析，而是将图片数据返回给调用方做视觉检查。
- **findGodot 缓存 + env 固化（M3, v0.18.x+）**：`findGodot` 首次解析后缓存（`_pathCache`），且 Node 进程 env 启动时固化。改 `GODOT_PATH` 环境变量后**需重启 MCP 服务端**才生效（env 进程级 + 缓存双固化；若新 env 未注入则 fallback PATH 上的 godot）。项目级覆盖用 `.godot/mcp-godot.json` 的 `godot_path` 或 project.godot `[godot_mcp]` 段（优先于 env，且每项目独立缓存）。
- **ALLOWED_PROJECT_PATHS 不热重载（M5, v0.18.x+）**：项目路径白名单从 `process.env.ALLOWED_PROJECT_PATHS` 读取（分号分隔），Node 进程 env 启动时由父进程注入并固化。改 settings.json 的 env 配置后**需重启 MCP 服务端（或宿主 Claude Code）**才生效——改完仍报 `PATH_NOT_ALLOWED` 多半是未重启。临时绕过：`GODOT_MCP_UNRESTRICTED=true`（仅本地开发）。
- **add_node 无节点级冲突检测（吸收自 ai-kit enhanced-boundaries #5）**：`batch_add_nodes` 后再单独 `add_node` 加同名子节点不会报错，可能产生重复节点（尤其同父路径，Godot 加载时拒绝）。add 前先 `query_scene_tree` 查目标父下是否已有同名节点，走"query → 条件 add"模式。实现层（`src/tscn/tscn-editor-add.ts` `_addNodeInner`）无同级重名扫描；defects.md `addnode-no-duplicate-check`（OPEN）跟踪实现层修复。
- **validate_scripts vs run_and_verify 可能不一致（吸收自 enhanced-boundaries #4）**：validate_scripts 跑 headless 验证器脚本（捕跨文件编译依赖），但不等于实跑场景（运行时动态行为/场景加载）。关键验证结论（如"脚本通过"）用 validate_scripts + run_and_verify 交叉确认，不一致时以 run_and_verify 实跑为准。
- **load_skill 召回的是参考代码（吸收自 enhanced-boundaries #12）**：`load_skill` 检索第三方 skill 库（GodotPrompter / gd-agentic 等）召回的 scripts 是教学示例，非生产代码（可能含硬编码密钥 / null 崩溃 / 未验证模式）。复制到生产项目前必须人工审。
- **未知参数被拒 + did-you-mean（P8, 2026-09-12）**：所有工具的顶层未声明参数（不在 inputSchema properties 中）一律拒绝——早期 additionalProperties 静默容忍已反转（regiellis 模式移植）；拼写接近时返回 did-you-mean 建议（Levenshtein 相似度 > 0.4，如 alpah → 想传 alpha?）。inputSchema 是参数 SSOT：handler 私下读取的键必须声明进 schema（CI `check:ssot-params` 审计声明面↔使用面零漂移，白名单 scripts/ssot-allowlist.json 记录有意例外；dispatcher 级公共键 `godot_path` 豁免——ToolDispatcher 对所有工具读它做 per-call Godot 二进制覆盖，~19 个未声明它的 headless 工具同样支持，P8 审查 B-1 清偿）；传错参数名会立刻报错而非被静默忽略。
