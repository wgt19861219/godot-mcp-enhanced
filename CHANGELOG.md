# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### CLI — Client Adapters Expansion（4→13，配置扩展）

- AI 客户端配置 adapter 从 4 个扩到 **13 个**（+9：Claude Desktop / Windsurf / Cline / Zed / Gemini CLI / Antigravity / Trae / Cherry Studio / Qwen Code），对标 Godot AI 19 client auto-configure
- `ClientAdapter` 接口加必需 `scope: 'project' | 'global'` 属性
- scope 分布（plan 前置核实）：**global 8**（Codex/Claude Desktop/Windsurf/Cline/Zed/Antigravity/Trae/Cherry Studio）+ **project 5**（Claude Code/Cursor/OpenCode/Gemini CLI/Qwen Code）
- BOM 防御：`json-config.ts` 加 `stripBom` + `readJsonForCheck`，所有文件型 adapter 的 `isConfigured` 统一经 `readJsonForCheck`（修复带 BOM 合法配置被误判 → doctor 误报 + setup 破坏幂等）
- user-state 字段 per-client 白名单保留（Cline `disabled`/`autoApprove`、Cherry `isActive`/`installSource`、Antigravity `disabled`/`disabledTools`、Gemini CLI `trust`/`timeout`/`includeTools`/`excludeTools`、Qwen Code `trust`/`includeTools`/`excludeTools`/`timeout`/`description`、OpenCode `enabled`）
- `setup` / `doctor` 日志标 `(global)`/`(project)` 让用户知情改了哪些全局配置
- Cherry Studio entry 含 `type:"stdio"`（schema enum 强制，唯一需 type 的 client）
- 注：client adapter 是 CLI 侧配置，不进 capability-matrix（非 MCP 工具能力）

## [0.25.0] - 2026-07-27

### Tooling — 竞品调研驱动的 4 阶段改进（2026-07-27）

基于 GitHub 热门 MCP 项目 + Godot MCP 竞品（hi-godot / better-godot-mcp / Coding-Solo）调研，完成 4 个阶段的改进：

#### Stage 1 — animation_track 合并进 animation 工具

- 工具数 35 → 34，token 预算 71,573B → 69,943B（省 1,630B ≈ 408 tokens）
- animation 工具吸收 animation_track 的 6 个 action（含 set_curve）及 in_handle/out_handle 参数
- animation-track.ts 改为 re-export shim（生成器定义保留）
- 新增 animation 的 editor-method-map 路由（editor 模式 track/keyframe/curve 操作从 headless fallback 升级为直走 GD handler）
- **修复 3 个长期不一致 bug**：update_keyframe 风险等级（write→destructive，对齐 animation-track）/ persist warning 包装不一致 / editor-method-map 不对称
- 排除 oneOf schema 重构方向（browser-use #4211 证据：Claude 客户端报错）

#### Stage 2 — lean profile + profile 文档化

- 新增 `lean` profile（token 极敏感场景的最小可用集，~31KB vs full ~68KB）
- 含组：core, bridge, animation, audio, signal, code（比 lite 再砍 visual/profiler/test）
- **修复隐藏功能**：现有 lite profile（省 24KB）README 零文档覆盖，补全完整文档
- README 新增「Token 优化与 Profile」小节（7 profile 对比表 + 配置方式 + 运行时微调）
- 环境变量表加 GODOT_MCP_PROFILE / GODOT_MCP_MODE
- 排除工具组懒加载方向（profile+activeGroups AND 关系 + 无持久化阻碍）

#### Stage 3 — issue 报告双轨输出

- validation/delivery/game-design 的 8 处 issue 报告输出从纯 pretty-JSON 改为双轨格式
- 新增 `src/tools/shared/issue-formatter.ts`：formatIssues（severity 分组）+ dualTrackOutput + parseDualTrack
- 人类可读文本（severity 分组 + 文件路径 + 截断提示）+ 尾部紧凑 JSON（程序/测试解析）
- **补全 bug**：validate_project 的 issues.slice(0,100) 原无截断提示，现加「... and N more not shown」
- 排除 MCP Apps 方向（Claude Code 不支持 / Desktop 握手失败 / Cursor 回归）

#### Stage 4 — test_runner 工具（GUT 测试框架产品化闭环）

- 新建第 35 个工具 test_runner，聚合测试能力为 AI 可调用的 write→run→report 闭环
- 4 个 action：check_gut（GUT 预检）/ list_suites（扫描测试文件）/ run（运行+结构化报告）/ generate（生成+落盘）
- 强依赖 GUT addon，复用 GUT 的 test/*.gd 文件格式做套件持久化（零新数据结构）
- **修复 bug**：runtime.ts:337 GUT 输出解析返回字符串数组，test_runner 改为真数字
- 对冲竞品 hi-godot 的主打卖点
- 排除 Streamable HTTP 方向（15+ 模块级单例并发不安全 + 安全层零基础）

## [0.24.0] - 2026-07-25

### Added — Self-update（Godot AI 追赶 3/3）

- 新增 `self_update` 工具（action=check/update）：check 查 npm 最新版 + 各项目 addon 版本漂移（只读，免确认）；update 覆盖安装包内 addon 到指定项目（需确认，三层路径校验 + 降级保护）
- MCP 服务端启动异步查 npm registry，有新版 stderr 提示（24h 缓存，失败静默）
- 单工具 + action enum 设计避 `guard.ts:65` confirm 门旁路；readOnly 模式拒整工具

### Fixed — Security（批次 A：RCE + 路径穿越，2026-07-23）

- A1 data-import `class_path` 补 root 校验（堵 RCE，gdscript-template-injection 复发实例）
- A2/A6/A7/A9 TS 路径参数统一 resolveWithinRoot
- A3 workflow user://.. 穿越×3 段级拒绝
- A4 game-bridge symlink 检查移到权限收紧前
- A5 asset_factory material load 补 has_path_traversal
- A8 logger error + call-recorder msg 套 sanitizeMsg
- A10 ui/scene property 改走 coerce_property_value + 删本地 blocked（instance 纵深统一）

### Fixed — Reliability（批次 B：降级链路 + 进程通信 + 资源写原子化，2026-07-23）

10 条可靠性 finding 修复（5 份审查：专项2 可靠性 4 条 + 通用版进程通信 6 条）：

- **降级链路统一（B1+B2+B3+B6）**：B1 evaluateState 按 errorType 分流（仅 heartbeat 驱动 reconnecting，工具失败不再误降级）；B3 心跳用独立 5s 超时（原复用 30s，TCP 半开降级 ~225s→~85s）；B2 handleEditorStall disconnect 清 zombie；B6 重建后 setState('connected') 即刻复位
- **进程通信（B4+B5）**：B4 连接类错误结构化 err.code（do_not_retry 覆盖 Disconnected/JSON parse error，Executor 合并 I-12 分支）；B5 fireDisconnect/fireReconnect try/catch 容错
- **资源写原子化（B7）**：17 处 ResourceSaver.save 改 tmp+rename 原子提交（三环境：headless godot_operations.gd 9 处 + addons 3 处 + TS 生成 5 处），防超时 kill 产半截损坏资源阻塞项目加载
- **advisory（B8+B9+B10）**：isConnected 活性语义 JSDoc；orphan 崩溃恢复 opt-in 文档；authTimeoutMs 参数化

### Fixed — Editor（mcp_editor.key 多实例互删，2026-07-23）

- **editor-secret-cross-instance-delete**：`addons/godot_mcp_server/websocket_server.gd` `_delete_secret_file` 原无条件 `DirAccess.remove_absolute(_secret_file)`，多个 editor 实例（或禁用→启用插件）共享固定路径 `.godot/mcp_editor.key` 时，任一实例 `_exit_tree` 会删掉仍存活实例的 key。现象：editor 日志称 `Auth secret written` 但文件找不到；TS 端 TTL 缓存（5 min）过期后重连读不到 key → editor 工具连不上。改为删前 `FileAccess.get_file_as_string` 校验 `on_disk == _secret`，只清自己生成的 key（读失败返 "" != _secret 也不删，安全侧）。defects.ts 加 FIXED 条目（detect 查 `on_disk == _secret`）+ 计数 80→81。

### Fixed — Correctness（批次 C：协议契约 + 返回值语义 + undo 完整性 + 参数校验，2026-07-23/24）

12 条正确性 finding 修复（5 份审查协议正确性/参数校验段 + addons GDScript 正确性 + data-import）。**C4 deferred**（架构阻塞，见末段）：

- **协议契约（C1+C3）**：C1 `sync_commands.gd` `_on_node_added/_on_node_removed` 改用现成 `_plugin` 字段（删 dead `_command_handler.get_plugin()` indirection——command_handler extends Node 无此方法，has_method 恒 false→传 null→get_edited_scene_root(null) fallback get_child(0) 错场景）；C3 `websocket_server.gd` params:null 改 reject -32602（原 `_rpc_params != null and not is Dictionary` 的 and 短路放行 null→Dictionary 强类型 SCRIPT ERROR 中断帧 packet 循环）
- **返回值语义（C9）**：`test_commands.gd` test_assert 改用 `CommandHelpers.values_equal` 类型感知比较（原 str() 比较 str(Vector3)≠str([10,0,5]) / str(true)≠str(1)，致 Vector3 vs Array / bool vs int 断言永不等；values_equal：同类型直接 ==，Array↔Vector2/3/Color 分量比，bool↔int 严格不等，int/float 宽松）
- **undo 完整性（C10+C11+C12）**：C10 `animtree_commands.gd` add_state/add_transition/set_blend 加 create_action_mixed undo（原仅 create 有 undo，Ctrl+Z 只撤 create；undo: add_state→remove_node / add_transition→remove_transition / set_blend→property old_val）；C11 `node_commands.gd` batch_add_nodes commit 后扫孤儿 is_inside_tree()+free()（GDScript 无异常机制，commit 失败已 instantiate Node 孤儿 leak）；C12 edit_node/set_instance_property 记 undo 前查 PROPERTY_USAGE_READ_ONLY 跳过只读（原 old_val=node.get(key) 对只读/不存在属性返 null→undo 回放 set(key,null) 错误赋值，加 _get_property_usage helper）
- **参数校验（C13+C5）**：C13 `ui_commands.gd` set_params 加 `_theme_has_property` 守卫（theme.set 前校验 Theme 有效属性，避免无效 key silent no-op/动态属性污染）+ default_font/stylebox load null 守卫；C5 `path_generator.gd` resolve_points strip "root/" 前缀（对齐 command_helpers.find_node，内联 strip 保 path_generator 纯几何静态类独立性）
- **TS 正确性（C2+C6+C7+C8）**：C2 `gdscript-executor.ts` extractCompileError 改 \b 词边界正则（原裸 includes 致用户 print("Parse Error: debug") 误判 compile 失败，marker/no-marker 两路径共用一处覆盖）；C8 proc.on('error') :1344 + catch :1143 裸 rm(sessionDir) 改 retryRm（对齐 timer/close，Windows EPERM 容错）；C6 `data-import.ts` csv_content 分支前置 size 守卫（原后置太晚，MCP SDK JSON.parse 阶段已载入 OOM）；C7 data-import GD 模板 `.tmp.tres` 自清从只扫 _output_dir 扩为 `_clean_tmp_global("res://")` 递归扫全局（跨 output_dir 残留，对齐 godot_operations find_files 跳过 .godot + depth≤10）
- **C4 deferred**：nav bake accurate bake_result（coroutine await + vertices_count 判据）——同步 dispatch（command_handler return 无 await + websocket_server not response is Dictionary 检查）不支持 coroutine handler，含 await 会使 handle_nav_create_region 成 coroutine 返 state 命中 -32603（比原 bake_result 不准的 bug 更糟）。需 async-dispatch 重构或 sync-bake API 研究（架构阻塞，超 bug-fix 范畴）。当前 bake 作 do_method 入 undo do_ops（P1 fix 保留），bake_result 乐观（!=null），`defects.ts` nav-bake-in-undo-action deferral 注释跟踪。

defects.ts 加 12 条 FIXED detect（C1/C2/C3/C5-C13）+ 计数 81→93。C4 由 nav-bake-in-undo-action（P1 bake 在 do_ops fixed）+ deferral 注释跟踪，不加新 OPEN detect（accurate bake_result 是架构 follow-up，非 bug-fix 可修）。

### Fixed — Tooling（批次 D：asset/android 工具游离，2026-07-24）

- **asset-android-tool-orphan（D1）**：`src/core/tool-registry.ts` asset/android 工具在 module-loader 注册（`module-loader.ts:57,71,75`）但不在 `TOOL_GROUPS`/`ALWAYS_ALLOWED` → `isToolAllowed('asset'/'android')` 恒 false（发现层 tools/list 隐藏 + profile 不强制，执行层 ReadOnlyGuard 兜底非 RCE）。补 `asset`(requires editor) + `android`(requires []) 2 组，toolToGroup reverse map + activeGroups + getFilteredTools 链自动派生一致。方案 a（不修 executeToolCall，避免破坏 advanced-proxy delegateCall 逃生舱）。android requires:[] 核实（`android.ts:212` deploy=spawnGodot headless export，无 EditorConnection）。

**D2 撤销**（find_node 内置 has_path_traversal）：经 eng-review + memory [[nodepath-traversal-category-error]] 核实为范畴错误复活（批次 A A11 已否决同建议）——has_path_traversal 是 resource 范畴（`command_helpers.gd:46` 注释 "resource path"），find_node 出口 get_node_or_null 纯场景树，NodePath `..` 是 Godot 合法父引用（`../Sibling`）非 fs traversal。D2 转 follow-up（NodePath `..` 策略统一：node_commands:51 项目拒 .. vs memory 范畴错误，历史痕迹需项目方拍板；若对齐 memory 撤既存 8 处节点路径前置，若禁 .. 走 schema pattern 非内置）。

**D2 follow-up 闭环（2026-07-24，方向 A）**：用户拍板撤节点路径前置（对齐 memory 范畴错误判断）。撤 6 处节点路径范畴 `has_path_traversal` 前置（`node_commands:52/108/161/231` + `asset_placer:154/203`）——范畴错误修正：`has_path_traversal` 是 resource 范畴（res:// fs traversal）误用于 scene tree 节点路径，get_node_or_null 受 SceneTree root 子树限制，`..` 是合法父引用（`root/A/../B` 等价 `root/B`）不能逃逸 fs。撤前置后 get_node_or_null 兜底（null→报 not found，-32002 与撤前同 code）。保留 6 处资源范畴前置（command_helpers:203 / scene:23 / ui:387 / asset_commands:112 / asset_factory:131，res:// 真 fs traversal）。memory 分类更正：原「8 处节点路径」误把 resource scope 的 scene/ui 算入，实测节点路径 6 + 资源 6 = 12。defects detect `nodepath-traversal-category-error`（两文件 CommandHelpers.has_path_traversal 计数=0）防复发。

### Fixed — Bridge（take_screenshot null 崩溃吞错，2026-07-24）

- **bridge-take-screenshot-null-crash-swallow**：`src/scripts/mcp_bridge.gd` `_cmd_take_screenshot` 的 `get_viewport().get_texture().get_image()` 链无 null guard，`get_image()` 返回 null（窗口后台/viewport 未就绪/DummyRenderer）时 `img.save_png()` 触发 runtime error 中断函数，`_handle_message` result 停 null → promote error 不触发（null 非 Dictionary）→ 返回 `{"result":null}` 吞错（客户端只见 null，既无 result 也无 error，无法定位）。补 viewport/texture/img 三层 null guard 各返结构化 `{"error":{code:-3,message}}`，`_handle_message` promote error 触发客户端可见。defects.ts 加 FIXED detect（`_cmd_take_screenshot` 函数体含 `get_image()` 必须有 `== null` 守卫）+ 计数 96→97。

### Not Fixed — 经审查否决

- ~~A11 find_node traversal~~：eng-review 否决（范畴错误）。find_node 唯一出口 `root.get_node_or_none` 纯内存，返 Node 零流入 load/DirAccess；NodePath `..` 是 Godot 父节点引用语法不逃逸场景树。若需禁 node_path `..` 应走 schema 契约变更（归 D 工具治理批次）。

### Added — Security（execute 取证，对照 UE 9b128514）

- **execute_gdscript 崩溃取证套件**：spawn godot 之前对【原始用户 code】算字节级 SHA-256 + 生成 `executionId`，记一条 `EXECUTE_BEGIN` 结构化审计日志（不含原始 code，对齐 I-10 字面量脱敏）；`ExecuteGdscriptResult` 回填 `executionId`/`scriptSha256`（成功 / RID leak / 无 marker 三路径都回填）。崩溃/超时后可凭日志反查具体执行（哪段 code 的 hash、写到哪个临时文件），无需原始 code 入日志。新增 `buildExecAuditEvent()` 纯函数 + 8 测试（5 单元 + 3 源码契约锁 log-before-exec 顺序）。差异化护城河：Godot AI 的 `game_eval` 是运行时求值，无 execute 前哈希留痕与崩溃溯源。

### BREAKING — scene 工具行为对齐（spec A 闭环）

- `scene edit_node` 现在自动落盘到 .tscn（之前仅改内存，需配合持久化操作）。迁移：直接调 edit_node 即落盘，无需再调 save_scene
- `scene edit_node` / `batch_add_nodes` 资源属性（texture/font/audio_stream 等 `res://` 路径）现正确 load 成 Resource（之前字面赋值字符串致属性错）
- `scene edit_node` 传 `instance` 属性现被 block（I-2 安全：防注入 ExtResource 实例化恶意场景）
- `scene batch_add_nodes` 部分节点失败现返错误（之前 exit 0 静默）

### 行为变更 — ZCode 深度支持（AGENTS.md 双写 + engine-quirks 分发）

- `setup_project_rules` 现在默认同时生成 `AGENTS.md`（与 `CLAUDE.md` 并列）。`AGENTS.md` 是 ZCode / Codex / Cursor / Cline 等遵循 AGENTS.md 标准的客户端的指令来源。升级后首次运行会在项目根新增 `AGENTS.md` 并进入 git。如不需要，传 `agents_md=false`。
- `setup_project_rules` 现在分发 `godot-mcp-engine-quirks.md`（引擎陷阱知识，原仅在仓库自用 `.claude/rules/`，未纳入分发）。升级后目标项目 `.claude/rules/` 会新增此文件。

## [0.23.0] - 2026-07-13

### Fixed — Security（CRITICAL，多轮独立审查核实）

- **零确认 RCE 复合链**（`6406de4`）：`edit_script` `search_and_replace` 经 `dynamicRiskOverride` 降级 read 绕确认令牌 → 写盘注入恶意 `class_name` + `ensureClassNameImport` 自动注册 + `create_scene` `root_node_type` 无校验 + `godot_operations.gd` 脚本分支 `script.new()` 无 `is_parent_class("Node")` 检查 = 零确认 RCE。修：删 override + create_scene 加 `^[A-Za-z0-9_]+$` + script 加 `get_instance_base_type`/`is_parent_class` 对称 ClassDB 校验
- **`confirm_and_execute` elicitation out-of-band gate**（`18ef867` + review `8819ad5`/`a21fecd`）：堵 AI 自读自确认 token。单客户端 caller/session 绑定无效（AI 同 session 产生+消费 token = 假保护）→ 改 MCP `elicitInput`（server→client→user UI，AI 无法伪造响应）。review 加固：I-1 消息含 `pending.args` 预览（>500 字截断，防盲批）+ I-2 `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` opt-in 降级（默认 fail-closed，显式 true 降级+审计，与仓库 `GODOT_MCP_UNRESTRICTED` 等惯例一致）

### Fixed — editor 路由（协议断链，editor 模式工具此前系统性失效）

- **editor-method-map 登记 6 族 21 action**（`356a061`）：`animation_track`（TS 全名 action→method + `shortenAction` 转短名 add_track→add）/ `export_*`（打通 editor→GD，原 fallback headless 撞 EDITOR_ONLY 死锁）/ `particles`/`nav`（action 加 nav_ 前缀）/`animtree`/`ui`（theme 归 ui）。`ui_set_theme`/`theme_create` 因 GD handler 读 action 做聚合子分派（与 TS 顶层 action 契约不一致）不登记避 -32004 回归；`recording` GD editor 主动禁用走 bridge 不登记
- **scene/node editor 路由**（`214d44a` 等）+ `open_scene` 死映射（`7247682`，TS 入口未接 ACTIONS/switch/actionRisks）+ `manage_tools` reconnecting 卡死（`b008293`，reconnect 失败启动后台重连循环）

### Fixed — bugs

- **path_generator align_vertices 死循环**（`5b63a9c`）：`spacing<=0`+`count>=1`+`align_vertices` 组合 while d+=spacing 永真死循环卡 @tool 编辑器主线程；align_vertices 分支入口加 `spacing<=0.0` early-return 守卫（fbdd684 BUG2 count 优先修复漏此独立 if 分支）
- **scene vector3 set coerce**（`8cbac21`）：`instance_scene`/`set_instance_property` 收 Array `[0,0,-6]` 静默 no-op（Godot 4.7 `Object.set` 不自动转 Array→Vector3）；`coerce_value_for_property` 按属性真实类型转
- **asset Array color 崩 + path count 优先**（`fbdd684`）：create_material 传 `[r,g,b]` 调不存在的 String(Array) 抛 SCRIPT ERROR 材质丢失；count>=1 优先于 spacing 默认 1.0
- **data-import A1/A2/A3**（`e0882c9`/`4d5059f`）：绝对路径双盘符 + csv_to_resources 用 ctx.projectDir 非 args.project_path + instance_scene 无 pack+save 回写

### Fixed — Reliability

- **HealthMonitor 控制回路**（`85f5328`）：editor stall 检测（setState 加 onStateChange 回调 → GodotServer heartbeat 监听 → handleEditorStall 统一降级，15s×5≈75s 远快 OS keepalive ~2h）

### Changed

- **删 ReconnectionManager 死代码**（`f2773fb`，410 行）：src/ 生产零引用，真重连逻辑在 `EditorConnection.ts:448` scheduleReconnect 自实现；审查批评为假保护（与 confirm token caller 绑定同类）

## [0.22.0] - 2026-07-08

### Added — asset-forge 整合（主打：参数化 3D shape 生成）

- **merged `asset` 工具**（7 action：`create`/`path`/`batch`/`undo`/`save`/`list_shapes`/`list_materials`）：单工具聚合参数化 shape 生成 + 路径阵列 + batch 原子 undo + save 预制件。create/path/batch/undo/save 经 editor 持久化（视口可见、可 undo）；list_* 静态返回
- **11 shape**：内置 6（box/cylinder/sphere/prism/wall/ramp）+ 手写 5（cone/tube/torus/stairs/fence）
- **路径阵列**：discrete（离散放置）+ continuous（连续采样）+ align_vertices（贴合表面）
- **batch 原子 undo**：多 shape 混合批量放置，单次 undo 回滚整批
- **10 材质预设**：wood/metal/stone/glass/gold/coral/sand/seaweed/water/default
- **save resource_path 安全校验**：TS 侧 realpathSync + resolveWithinRoot 白名单（防路径遍历）
- **已知限制**：ramp 在 continuous path 模式被拒（方案 A，continuous ramp 顶点对齐复杂度阻塞；discrete 可用）

### Added — MCP 协议增强

- **`godot_get_context` 元工具**（core）：一次调用返回会话全景 11 字段（mode/project/connections/scene/recentCalls/callStats/toolGroups/workflows/rules/performance/hint），替代 AI 探路循环。readScene 三态真实采集（editor EditorInterface / bridge current_scene / headless null）+ CallRecorder 单例记录调用历史
- **MCP Roots 动态授权**（core）：client 运行时动态声明授权根（替换 `ALLOWED_PROJECT_PATHS` env 启动期固定，免改 env 须重启）。Roots 优先 env 兜底（替换式非合并）+ re-fetch 失败保留旧 roots
- **MCP Server Instructions 注入**（core）：initialize 响应携带静态中文速查卡（1417 码元，5 节 + 5 陷阱）注入 client LLM 上下文。失败兜底 undefined 优于泄露错误
- **MCP Logging 协议**（core）：`sendLoggingMessage` 按 warn/error 级 fire-and-forget 推 client（文件 + stderr 双写不变）。四重 guard 保证日志观测层绝不影响主流程

### Changed — 安全标注诚实化

- **idempotentHint 注释修正**：idempotent = 重试安全 ≠ 无副作用，readOnly 是充分条件非定义。merged action 工具保守只在纯读标 true（写动作含创建/删除/任意方法调用，auto derive 写→false 已是协议合规安全姿态）
- **README 沙箱拼装绕过例子**：诚实标注 `execute_gdscript` 检测边界（`"cu"+"rl"` / `str("OS")+".execute()"` 字符串拼装构造 API 名绕过静态正则，深度绕过由容器隔离兜底）

## [0.21.0] - 2026-07-06

### Added — csv_to_resources 新工具（CSV → Godot 资源批量导入）

- **`csv_to_resources` action**（data-import）：从 CSV 批量生成 Godot .tres 资源，双轨实现（TS parseCsv/generateImportScript + GDScript 反射/FileAccess/ResourceSaver）。CRITICAL-1 注入防护（FileAccess 零进脚本，类型白名单反射）+ CRITICAL-2 遍历防护（白名单 + resolveWithinRoot）。集成测试覆盖真 Godot 各类型 + 空值 + 遍历 + 类型错误
- **MCP 标准 ToolAnnotations**（core）：从 actionRisks 派生 `readOnly`/`destructive` hints，客户端据此优化 UI（破坏性操作确认提示等）
- **测试基础设施**：capability reviewer 设施（按子系统切 5 个只读 reviewer agent：bridge/editor-plugin/headless/data-import/recording）+ e2e L2 opt-in（`GODOT_MCP_E2E_L2=1`，默认 skip flaky bridge/recording）

### Fixed — Security（多轮独立审查核实修复）

- **RCE 安全审查 5 条**：EXTRA_METHODS 危险方法黑名单 / command_handler 客户端 force 永远视为 false / DISABLE_SAFETY+SANDBOX=disabled 双开关需 UNRESTRICTED / sanitizeMsg 敏感值脱敏 / 动态路由调 sender 前补只读拦截
- **三份审查报告 9 条 P0/P1**（ipc do_not_retry 防断连期间重试 + particle 4 setter undo + undo is_instance_valid + nav commit 顺序 + editor 录制禁用 + EditorToolExecutor 串行化 + websocket ping 响应/send_text 检查/params 防御 + sync_commands 信号清理 + gdscript-executor slot 兜底）
- **GDScript defect 批**（P1-5/P1-6/P2#1/P1-9）
- **data-import F-5~F-8 审查闭环**：`_safe_float` is_finite 守（Vector2(INF) 落盘视觉损坏）/ csv_path statSync 预检（绕过 readFileSync 阶段 OOM）/ Vector2·Color 显式 `float()` cast + Color.html `is_valid_html_color` 校验

### Fixed — Reliability（ipc + 综合审查）

- **ipc P1-4** connectGeneration 防 disconnect 后进行中 connect() 复活已断开连接
- **ipc P1-7** gdscript-executor slot 泄漏兜底
- **ipc P1-8** game-bridge invalidate race（`_socket === sock` 守卫防废弃 socket 异步 close 错误 invalidate 新 socket）
- **综合审查 P1-1** editor 模式 -32601 Unknown method 自动回退 headless（command_handler 只认扁平 method，TS (tool,action) 工具转发后落 -32601 静默失效，EditorToolExecutor 无回退）
- **综合审查 P1-2** editor_guards 接线（TS 写脚本/场景经 WS 调 guard_text_resource_write/guard_offline_scene_save，防绕过 ScriptEditor/ResourceLoader 缓存致磁盘/内存版本撕裂）
- **综合审查 P1-3** heartbeat 暂停超时改恢复 normal 检测（原 emit timeout_detected 断连与暂停容忍长操作的语义相反）

### Fixed — editor 插件 EditorInterface 4.7 兼容

- Engine singleton → `EditorPlugin.get_editor_interface()`（4.7 EditorInterface 不再注册为 Engine singleton）

### Changed

- **capability gdScriptImpl.editor 按工具命令精确路由**（EDITOR_COMMAND_ROUTING 取代 group→单文件粗粒度映射）
- **M2 证伪订正 + drift CI gate**（移除 generatedAt 噪音）

### Docs

- core.md 吸收 enhanced-boundaries 3 条工具陷阱
- agent-arch 落地状态复核 callout + agentId 假设注释
- ROADMAP #13 分发（awesome-mcp-servers PR #9067 已发 + MCP Registry 待 npm 包带 mcpName）

### Fixed — editor 插件原生类虚函数 super() 回归（654b162）

- **移除 6 处 super()**（`addons/godot_mcp_server/plugin.gd` `_enter_tree`/`_exit_tree` + `websocket_server.gd` `_ready`/`_process`/`_exit_tree` + `ui/status_panel.gd` `_ready`）：`super()`（无方法名）对原生类（EditorPlugin/Node/VBoxContainer）虚函数是 Godot Parse Error "Cannot call the parent class' virtual function ... hasn't been defined"（**4.6.2+ 均报，非 4.7 特有**），addon 加载失败/9090 不监听。IMP-4 "虚函数首行调 super" 仅适用 extends 自定义基类。
- **溯源**：654b162（v0.19.0）违反 `docs/review-followup-2026-06-18.md:93` 与 `mcp_bridge.gd` 移除 super 先例，误将 IMP-4 用到原生类；提交自承"editor 实测待专项"，从未真验证。同期 `.claude/rules/godot-mcp-editor.md` "2026-06-26 4.7 `--check-only` 全编译通过"系假绿（`--check-only <file>` 空跑不触发编译）。
- **验证**：reproducer 红绿闭环（4.7+4.6.2 super 在→parse error / super 删→通过）+ `--headless --import`（`test/fixtures/gdscript-check`）addon 全量编译干净；`defects.ts` `plugin-no-super-call` detect 反转计数"原生类虚函数有 super"=0 留 FIXED 防 654b162 式回归。

### Fixed — editor 插件 Safe save 红字（Godot #40366）

- **消除 `websocket_server.gd` "Safe save failed" 红字**：Windows 上 `FileAccess.open(WRITE).close()` 总走 atomic（写 .tmp + rename，`drivers/windows/file_access_windows.cpp:276`），杀软拦 rename → 红字（非致命，fallback 直接写仍成功，addon 照常起、9090 监听，但红字误导用户以为 addon 损坏）。代码层绕开：Windows 改用 `OS.execute("powershell", WriteAllText)` 直接写（secret 经环境变量传递，不经命令行暴露）；Linux/macOS 的 `FileAccess.close` 不走 atomic，保留 `FileAccess`；PowerShell 失败有 `FileAccess` fallback 兜底。
- **修 `_restrict_secret_permissions` anti-pattern**：`icacls /inheritance:r /grant:r USERNAME:R`（自己只读）→ `USERNAME:F`（自己全控）。R 是 anti-pattern——addon 以 USERNAME 身份运行却要覆盖自己只读的 key，只能靠 FileAccess atomic rename 绕 ACL，正是红字根源。F 让 PowerShell 能直接覆盖写；其他用户因 `inheritance:r` 无 ACE（比 R + 继承残留更严，实测仅 `USERNAME:F`）。
- **验证**：4.7 `--editor --headless` 实测两次（key 新建 + 覆盖）零 Safe save 红字 + `Listening 9090` + key 写成功；`icacls` 实测 ACL 仅 `USERNAME:F`、其他用户零 ACE；F key 可覆盖写。
- **同步 `src/scripts/mcp_bridge.gd`**（DUPLICATE 注释约束）：`_write_secret_to_file` + `_restrict_secret_permissions` 同款修复（Windows PowerShell 绕 atomic + F ACL）。4.7+4.6.2 `--headless` load 编译干净。

## [0.20.0] - 2026-06-30

### Added — cpp GDExtension 脚手架 + 全工具验证靶子

- **cpp `scaffold_gdextension`**：新工具，生成 8 文件 C++ GDExtension 工程骨架（不联网/不编译），填补竞品 C++/GDExtension 赛道空白
- **全工具验证靶子**：`test/fixtures/real-project/` 真实多子系统无 autoload 靶子 + 三层（L1 headless 静态 / L2 运行态 / L3 特殊环境）全自动化验证，覆盖 28/30 顶层工具正路径
- 含 R3 审查修复、全面安全审查 H1-M4 修复（累计自 v0.19.1 的本地增量）

### Fixed — 工具行为一致性(反假绿驱动)

- **default-null 统一**:25 处 `default return null` + 6 处 action 校验 null → `opsErrorResult('UNKNOWN_ACTION')`(工具自报,替代 dispatcher 兜底 HANDLER_NULL);同步修现有 e2e 假绿(ui build_layout/create_control、project info 从未真执行却"通过")
- **run_project bridge-not-ready isError**(bug):`wait_for_bridge + !ready` → `errorResult`(isError:true);修复前 `textResult` isError:false 误报(到 game_query ping 才暴露 BRIDGE_NOT_CONNECTED)
- **run_project timeout race**:提取 `computeRunTimeout` 纯函数,`wait_for_bridge` 时 `timeout ≥ bridge_timeout + 10`(防 auto-stop 与 bridge 就绪 race 致游戏被提前 kill)

## [0.19.1] - 2026-06-27

### Fixed — 版本元数据同步

v0.19.0 发版后版本元数据漂移修复(npm v0.19.0 基于 tag 2a48d06,manifest/plugin.cfg 仍 0.18.2):

- `manifest.json` / `addons/godot_mcp_server/plugin.cfg` / `docs/使用指南.md`: 0.18.2 → 0.19.1(同步)
- `README.md` 版本表补 v0.19.0/v0.18.2 行

注: v0.19.0 npm 包元数据漂移(manifest/plugin.cfg 0.18.2),v0.19.1 彻底同步。功能无变化。

## [0.19.0] - 2026-06-27

### R2 审查响应链(12 commit, CI 全绿)

3 CRITICAL(1 修 + 2 push back 经 TDD 实测) + 安全同源 4 点 + IMP-11 touch 双侧 + 阶段1b 守卫 + editor 插件 undo_manager + super() IMP-4 + 2 defect 闭环(@739 wontfix / @748 fixed)。

#### Fixed — CRITICAL

- **detachInstance 双 parent 属性**(`tscn-editor-detach.ts:441/444/445`): `parent=""` 空串子节点 detach 时,原 `[^"]+` 正则不匹配空串走 else 叠加,残留 `parent=""` → 双 parent 属性致 Godot 解析失败。修复: 正则 `[^"]*` + `:444` 空串等同 `.` 守卫。诚实纠错 CRITICAL-3(阶段3 push back 漏网双 parent)
- **recording MAX_EVENTS 双侧上限**(`recording.ts` + `mcp_bridge.gd`): 录制事件无界增长 → TS 回放 + GDScript 录制双侧上限

#### Fixed — 安全同源(已修未传播至同类)

- **UI BLOCKED_PROPS**(`ui/types.ts` + `ui/index.ts` + `ui-layout.ts`): findBlockedProps 抽 shared + handler 前置硬拒(平铺)/生成层 warnings(嵌套)
- **audio stream_path sanitizeResPath**(`audio-ops.ts`): 同源对齐 res:// 路径校验
- **instance-api-auth symlink**(`instance-api-auth.ts`): lstatSync 检测 + unlink 防 writeFileSync follow symlink
- **instance-manager 段级路径遍历**(`instance-manager.ts`): `includes('..')` 误拒合法路径 → 段级 `seg === '..'`

#### Fixed — 契约双侧

- **IMP-11 touch/ScreenDrag 双侧契约**(`recording.ts` + `mcp_bridge.gd`): TS 回放加 touch 分支(此前 silently skip) + bridge 补 `_cmd_send_touch`/dispatch/`_input` 录制(对齐 `recording_commands.gd`)

#### Added — editor 插件 undo_manager + super 一致性

- **:649 nav/particle/animtree/ui commands 接入 undo_manager**(`command_handler.gd` + 4 模块): setup 加 undo_manager 参数 + 7 处 `add_child+set_owner` 包装 `create_action_mixed`(逐字复用 `node_commands:60-73` 已验证模式) + 补 cleanup()(统一接口)。editor 模式 nav region/agent/link、particles、AnimationTree、UI control/container 创建可 Ctrl+Z 撤销
- **super() IMP-4 一致性**: plugin.gd `_enter_tree`/`_exit_tree` + websocket_server.gd `_ready`/`_process`/`_exit_tree` + status_panel.gd `_ready` 共 6 处加 super()

#### Fixed — 守卫

- **阶段1b 守卫**: EditorConnection connect catch 加 `authenticated=false`(覆盖 performAuth reject/timeout/catch 三路径); ui-theme color 元素 `Number.isFinite` + constant NaN 守卫; tscn-editor-add `incrementLoadSteps` `-?\d+` 匹配负值 + `Math.max(1,n)` clamp

#### Defect 闭环

- **@739 scene-merge 字面量 wontfix**(= CRITICAL-1): 双重保护(正则 `[^"]+` 护城河 + map key 隔离)防字面量 ExtResource/SubResource 篡改。双侧回归测试固化。detect 精确化(避免粗略 detect 复测误重开)
- **:383 nodeName 注入确认已修**(IMPORTANT-5): escapeTscnAttr `$→$$` 转义(`tscn-editor-shared.ts:38`)根因修复覆盖所有 detach/merge 调用点

#### 验证

- TDD red→green(@748 双 parent / IMP-11 touch / 守卫); validate_scripts 0 errors(editor 插件 5 文件); tsc 0; 全测试套无回归
- CI 全绿(12 commit)
- 2 次诚实纠错(阶段5 super push back + @748 CRITICAL-3 push back): push back 须查项目规则 + 穷尽失败模式,静态推理易漏

## [0.18.2] - 2026-06-18

### 安全 — 沙箱加固与防御深度

全面审查修复(GDScript 沙箱绕过组 + 防御深度一致性 + 注入面收敛):

- **沙箱绕过组**(`gdscript-executor.ts`):拼接窗口 4→8(MAX_CONCAT_WINDOW)、补 `Engine/FileAccess/DirAccess/JavaScriptBridge` 索引访问拦截、`Expression.execute` 正则跨行(`[\s\S]{0,500}?` 防 ReDoS)、`ResourceLoader.load` 正则去贪婪、`detectAutoloadUsage` 改 stripLiterals 骨架扫描消除注释误触
- **stripLiterals res:// 保留 + 三引号归一**:剥字符串内容时保留 `res://` 前缀(消除 `load("res://")` 误报回归);三引号开/闭引号归一为单个(让单 `"` 正则覆盖三引号,避免负向预查回溯陷阱)
- **HMAC 启动警告**(`GodotServer.ts`):MULTI_INSTANCE 启用时警告 verifyApiToken 是发送端 only(零生产接线)
- **rate limit 中间件**(`middleware.ts`):createRateLimitMiddleware(全局 60 次/秒软限防 AI 失控循环)
- **scene-commit 转义 + 校验**:serializeGdValue 补 `\r`/`\t` 转义、validateCommitOperations 结构校验(替代 as unknown as 强转)
- **P0 命令注入收敛**:`generate-doc-db.js` execSync → execFileSync 数组参数;`.cursor/mcp.json` 本地路径 example 化 + gitignore

### GDScript 插件

- **bridge super() 修复**(`mcp_bridge.gd`):移除 extends Node 虚函数的 super()(Godot 4.6.2 Parse error;IMP-4 convention 仅适用自定义基类)。GUI 4.6.2 闭环验证(Listening + pong + WASD)
- **command_handler .name**(`websocket_server.gd`):设 `.name="command_handler"`,修 plugin.gd cleanup 死代码
- **instantiate_class Node 检查**(`godot_operations.gd`):补 is_parent_class("Node") 堵非 Node 引擎类
- **ui_commands 白名单**:ALLOWED_CONTROL_TYPES(29 种)替代 is_parent_class 兜底

### 可靠性

- **cleanupOldSessions 降噪+防卡**(`gdscript-executor.ts`):try 移入循环 + EPERM 聚合 + MAX_CLEANUP_PER_RUN=10 上限(根因:190 累积 stale 目录 × retryRm 退避致 E2E 60s 超时,全量 461s→13s)

### 测试与文档

- **E2E CI 假绿修复**:GODOT_PATH 默认空(强制显式,避免 CI 静默 skip 假绿)
- **deprecated TODO v0.20.0**、**ROADMAP 历史里程碑化**、**增量复审 issue 清单**(`docs/review-followup-2026-06-18.md`)

### 验证

- 全量 **2670+ passed / 0 failed**(155 文件)、build/lint EXIT 0、EPERM 0、E2E 13s
- 2026-06-18 全面审查(16 IMPORTANT + 17 ADVISORY)与增量复审(Top 3 P0)已处理

## [0.18.1] - 2026-06-14

### Fixed — 3 个阻塞性 CRITICAL（功能验证审查发现并修复）

经实际 MCP 工具调用验证（在 godot-test-project 端到端测试），修复了 3 个导致核心功能不可用的 CRITICAL 缺陷：

1. **parseTscn 节点属性解析**（`src/tscn-parser.ts`）：`parseTypedValue` 原用冒号 `:` 查找类型分隔符，但 Godot 4.x 节点多行属性格式为 `key = value`（等号），导致 `position`/`script`/`color`/`texture` 等所有多行属性被整行塞进 `name`/`value`，`ExtResource`/`Color`/`Vector2`/`Vector3`/`NodePath`/数组/字典的类型解析逻辑从未触发。改为优先用 `=` 分隔，`value` 经 `parseValue` 正确解析为结构化对象。**实测**：`read_scene` 现在返回 `{name:"script", value:{__type:"ExtResource", id:"1_dodge"}}` 而非整行字符串；`color = Color(0,0,0,1)` 解析为 `{__type:"Color", value:"0, 0, 0, 1"}`；含 `/` 的属性名（如 `theme_override_font_sizes/font_size`）保留完整路径。

2. **parseTscn 头部解析**（`src/tscn-parser.ts`）：`startsWith('gd_scene')` 漏了方括号，实际行是 `[gd_scene ...]`，导致 `header` 恒返回 `{}`，`format`/`load_steps`/`uid` 全部丢失。改为 `startsWith('[gd_scene')` + 正则提取方括号内属性。

3. **wait_for_node / wait_for_property 真正等待**（`src/tools/game-bridge.ts`）：Bridge 端（`mcp_bridge.gd`）的 `_cmd_wait_for_*` 是单次同步快照，工具命名与文档却暗示异步等待，导致所有依赖"等待条件成立"的自动化流程静默失败。新增 `pollWaitCondition`：在 `timeout` 窗口内按 `interval_ms`（默认 200ms，范围 50-2000）反复探测，条件成立立即返回，超时返回 `timed_out`，error 立即中止。返回值新增 `wait_completed`/`elapsed_ms`/`timed_out`，向后兼容。

### 验证

- 全量测试：**2597 passed / 0 failed**（+20 新测试覆盖修复，0 回归）
- 新增测试：`test/tscn-parser.test.js`（属性/头部解析各类型）、`test/game-bridge-wait.test.ts`（轮询/超时/error 中止/向后兼容）
- 端到端实测：`read_scene` 在 dodge/pong/main 三场景确认属性与头部正确解析（ExtResource/Color/数字/字符串/负数/浮点/含 `/` 的属性名）

## [0.18.0] - 2026-06-10

### Breaking Changes — 工具合并（39 → 27 MCP 工具）

9 个独立 MCP 工具被吸收进相关工具组，工具名不再独立存在：

| 旧工具名 | 新路由 | 说明 |
|----------|--------|------|
| `node_create_3d` | `scene(action="create_3d_node")` | 3D 节点创建并入场景工具 |
| `scene_commit` | `scene(action="commit")` | 批量场景提交并入场景工具 |
| `recording` | `runtime(action="record_start/stop/save/load/play")` | 录制系统并入运行时工具 |
| `templates` | `project(action="list/apply")` | 代码模板并入项目工具 |
| `ik` | `animation(action="ik_modifier_create/get/set/list_bones")` | IK 系统并入动画工具 |
| `test` | `validation(action="assert/stress/export_*")` | 测试框架并入验证工具 |
| `game_design` | `validation(action="validate_gdd/chain_verify")` | 游戏设计验证并入验证工具 |
| `verify_delivery` | `validation(action="verify_delivery")` | 交付验证并入验证工具 |
| `batch` | `workflow(action="create_files/run_verify/diff_scenes")` | 批量工具并入工作流工具 |

### Migration Guide

**自动迁移**：调用 `manage_tools(action="migrate")` 获取完整映射 JSON。

**Legacy 兼容模式**：设置环境变量 `GODOT_MCP_WARN_LEGACY=1` 可让旧工具名继续工作（打 warning），保留一个版本后移除。

**手动迁移**：将旧工具调用替换为新路由：
```
旧: node_create_3d(type="Node3D", name="Player", ...)
新: scene(action="create_3d_node", type="Node3D", name="Player", ...)

旧: recording(action="start", ...)
新: runtime(action="record_start", ...)
```

### Added

- **LEGACY_TOOL_MAP**: 旧工具名到新 (tool, action) 的迁移映射表
- **notifyToolsChanged**: `manage_tools` 的 activate/deactivate 操作后发送 MCP `notifications/tools/list_changed`
- **manage_tools migrate action**: 输出完整迁移映射 JSON
- **ErrorCodes 集中定义**: `src/core/error-codes.ts` — MISSING_ACTION/UNKNOWN_ACTION/MISSING_REQUIRED_PARAM/HANDLER_ERROR
- **ActionResult 统一响应**: `src/core/action-response.ts` — wrapResult/toToolResult 兼容旧格式
- **Common Schema**: `src/core/common-schemas.ts` — 共享参数定义 + withCommonParams
- **50 条意图→action 选准率测试**: 验证 action 命名语义化

### Changed

- `ToolDispatcher.dispatchTool`: 新增 legacy fallback 路由，旧工具名自动映射到新 (tool, action)
- `GodotServer`: 注入 MCP Server 实例给 tool-registry（listChanged 支持）
- `module-loader`: 移除 9 个被吸收模块的注册（文件保留，handler 被目标模块导入）

## [0.17.2] - 2026-06-09

### Security

- **F-05**: `_generate_secret()` 截断时返回空字符串 + 拒绝启动 WebSocket/Bridge 服务 — 防止使用弱密钥运行（`websocket_server.gd` + `mcp_bridge.gd`）
- **F-01**: CI/非 TTY 环境下 `isPathInAllowedRoots` 日志级别从 `info` 提升为 `warn`，提醒运维人员配置 `ALLOWED_PROJECT_PATHS`
- **F-02**: `EditorConnection` 客户端白名单移除 `0.0.0.0` 和 `::` — 仅允许明确的 localhost 地址

### Changed

- **F-03**: 移除 `EditorToolExecutor` 中 `_use_undo` 半实现标志 — 插件端未准备好，参数改为原样透传
- **F-04**: 多实例路由添加 `EXPERIMENTAL` 警告日志，明确告知用户功能未完成

### Removed

- A-04: `index.ts` Profile 类型从 `as` 强制断言改为显式 `string`

### Added

- A-03: `parseConfigValue` 递归深度限制（8 层）添加说明注释

## [0.17.1] - 2026-06-08

### Fixed

- **CRITICAL-1**: 删除 `tscn-editor.ts` 中 8 个无引用导出函数（`editNodeProperty`、`deleteNode`、`addConnection`、`removeConnection`、`setNodeScript`、`changeNodeType`、`addExtResource`、`addSubResource`）及 `ResourceAddResult` 接口 — 净减 ~527 行死代码
- **CRITICAL-2**: 解耦 core ↔ tools 双向依赖 — `ToolCallDelegate` 类型定义提升到 `types.ts` 共享层，`ToolDispatcher` 改用构造函数注入 delegate，`GodotServer` 组合根负责连接
- **CRITICAL-3**: `animation-ops.ts` 补充 38 个单元测试 — 参数验证（15）、GDScript 生成验证（13）、路由与导出（5）、边界（5）
- **CRITICAL-4**: `EditorToolExecutor.ts` 补充 16 个 mock 测试 — sync 生命周期、treeChangeRing 缓冲区、reconnect 处理、execute 分支
- **S-03**: `game-bridge.ts` 移除 Bridge 密钥 tmpdir 回退 — `_projectDir` 未设置时抛出明确错误，不再静默回退到全局可读的临时目录
- **S-04**: `editor-auth.ts` 权限检查顺序修正 — `checkFilePermissions()` 先于 `readFileSync()` 执行，拒绝不安全权限的密钥文件
- **D-02**: 删除 `spatial-ops.ts` 空壳文件及 `module-loader.ts` 引用 — 功能已迁移到 `physics-ops.ts`

### Changed

- 工具模块统一使用 `requireProjectPath` 辅助函数，减少重复代码

### Removed

- `src/tools/spatial-ops.ts`（空壳，功能已在 physics-ops.ts）
- `test/spatial-ops.test.js`（对应测试）
- `test/tscn-editor-resources.test.ts`（仅测试死代码函数）

## [0.17.0] - 2026-06-07

### Fixed

- **C-01**: `parseTscn` 中 `rootNode` 多根节点覆盖保护 — 防止畸形 .tscn 文件解析错误
- **C-02**: `deleteNode` 删除节点后递减 `load_steps`，与 `addNode`/`detachInstance` 行为一致
- **C-03**: `addNode` 对含路径的 parent 参数使用 `findNodeSectionLine` 精确匹配，避免同名节点歧义
- **C-04**: 沙箱安全限制文档扩展——列出已知绕过向量（字符串拼接、变量间接调用）和适用场景
- **I-02**: `EditorConnection` 构造函数增加 `0.0.0.0` / `::` 拦截，防止绑定所有接口
- **I-04**: `normalizeArgs` 递归深度超过 5 层时输出 log 警告
- **I-06**: `remapSubResourceIds` / `remapSubResourceRefs` 支持 Godot 4.x 字符串 UID（如 `StyleBoxFlat_xb1kx`）
- **I-07**: `confirm_and_execute` 检测 args 截断标记，拒绝执行不完整代码并返回 `ARGS_TRUNCATED` 错误
- **I-08**: editor 模式 `_duration_ms` 追加前检查是否已存在，避免重复输出

### Security

- **SEC-REV-01**: `isPathInAllowedRoots` 策略从 deny-by-default 恢复为 allow-by-default。v0.15.0 的 C-SEC-01 引入 deny-by-default（未配置时仅允许 `process.cwd()`），但 `npx` 启动场景下 `cwd` 是缓存目录而非用户项目，导致合法用户被阻断且无恢复路径。现改为：未配置 `ALLOWED_PROJECT_PATHS` 时允许所有路径并记录 info 日志；用户可通过设置 `ALLOWED_PROJECT_PATHS=/path1;/path2` 选择性启用白名单限制

### Fixed

- `DEFAULT_SKIP_DIRS` 移除 `'addons'` 和 `'tools'` — 插件和工具是用户代码目录，不应被默认跳过。修复 `list_files`、`get_project_info`、`validate_scripts`、`validate_project` 无法发现 addons 资源的问题
- `collectFilesByExt` / `validate_project` / `project_replace` 中硬编码的 `['addons', 'tools']` 同步移除
- `verify_delivery`（交付检查）**有意保留**跳过 addons — 第三方插件代码不纳入交付质量门禁
- `_pathAllowLogged` 从共享 boolean 改为 per-key `Set` 去重 — `GODOT_MCP_UNRESTRICTED` 和未配置 `ALLOWED_PROJECT_PATHS` 的日志消息各自独立去重

## [0.15.1] - 2026-05-27

### Fixed

- **#7**: Godot 4.6 editor plugin 兼容性 — `undo_manager.gd` 使用 `Callable.bindv()` 替代多参数 `add_do_method`；`scene_commands.gd` 替换已移除的 `String.is_alpha()`；`ui_commands.gd` 替换已移除的 `GROW_DIRECTION_UP/DOWN/LEFT/RIGHT`
- `nav_commands.gd` 修复遗漏的 `bake_navigation_mesh()` 返回值捕获
- `navigation.ts` 生成的 GDScript 中 `bake_navigation_mesh()` 返回值捕获 — 去掉 void 返回值捕获，改用 `navigation_mesh != null` 检查
- `ui_commands.gd` match 语句添加 `_` 默认分支返回错误
- `undo_manager.gd` 添加 null target 防御
- `validation.ts` 嵌套 spawn 补上 `buildSafeEnv()`
- `screenshot.ts` 和 `project.ts` 替换 `as string` 为类型守卫/requireString

## [0.15.0] - 2026-05-27

### Security

- **C-SEC-01**: `isPathInAllowedRoots` 改为 deny-by-default — 未设置白名单时仅允许 `process.cwd()`，新增 `GODOT_MCP_UNRESTRICTED` 环境变量作为逃生阀
- **I-SEC-01**: `list_projects` 的 `search_dir` 参数添加白名单检查，修复绕过漏洞（含 editor 分支）
- **C-SEC-02**: 可选 GDScript 沙箱警告扫描器 — `GODOT_MCP_SANDBOX=strict` 启用，检测 `OS.execute`/`DirAccess.remove`/`FileAccess.open(WRITE)` 等危险操作

### Fixed

- **C-TYP-01**: game-bridge 连接锁 — `_ensureConnection` 拆分为 `_doConnect` + Promise 链锁，防止并发连接竞争
- **C-TYP-02**: process-state TOCTOU 竞争 — `acquireProcessSlot()` 原子操作替代 `isProcessBusy` + `setProcessBusy` 两步模式
- **C-Q-01**: test_stress GDScript 缩进修复 — 空格改为 tab，修复 mixed indentation 解析错误
- **C-Q-02**: 录制功能重构为 Bridge TCP 模式 — start/stop 通过 Bridge 命令实现，修复跨进程状态不可用的架构断裂
- **I-Q-06**: ik-tools.ts 两处 `as any` 替换为 `readonly string[]` 类型守卫
- **I-Q-07**: 4 处 `as Record` 断言添加运行时 object 类型校验
- **I-Q-08**: 7 处关键空 catch 块（子进程/文件 I/O/网络）添加 `console.debug` 日志

### Changed

- **C-Q-03/04/05**: material-ops 提取 `parseMaterialParam` 共享函数；tilemap-ops 提取 4 个辅助函数（layerArg/nodePreamble/tilemapBranch/tilemapCall），净减 101 行
- **I-Q-01/02**: `ensureNumber`/`clampParam`/`validatePositiveInt` 统一到 `shared.ts`，消除 6 个模块的重复定义
- **C-CI-01**: 新增 ESLint 配置（warn-only）+ CI lint 步骤

### Added

- **C-CI-02**: gdscript-executor 核心函数测试 +38（wrapSnippet/buildSafeEnv/createAutoloadLoaderScript 等）
- **C-CI-03**: delivery.ts 维度测试 +50（scene_tree/script_health/performance/assertions），覆盖率 3% → 80%
- **I-CI-01**: GDScript 代码生成正确性测试 +70（gdEscape/SCENE_TREE_HEADER/stressTest/recordingPlay 等）
- 录制功能 Bridge 端：`mcp_bridge.gd` 新增 `_cmd_recording_start/stop` + `_input` 回调

### Post-Review Fixed

- **C-1**: `scene.ts` query_scene_tree/inspect_node 进程槽泄漏 — 7 条退出路径（early return + timeout/close/error 回调）补充 `setProcessBusy(false)`，修复永久锁死
- **I-4**: `recording.ts` 冗余动态 `await import('./game-bridge.js')` 统一为静态导入

## [0.16.0] - 2026-05-31

### Security

- **SEC-01**: Windows 密钥文件 ACL 验证 — `editor-auth.ts` 和 `game-bridge.ts` 的 `icacls` 调用增加 username 格式校验 + 回读验证，确保权限实际生效
- **SEC-02**: `resolveWithinRoot` 路径穿越防护加强 — 预检 `..` 片段 + `safeRealPath` 回退路径 base 校验，堵死 symlink + 编码绕过
- **SEC-03**: README 移除 `execute_gdscript` 自动批准建议，降低任意代码执行风险
- **SEC-04**: GDScript 执行器输出缓冲区 10MB 上限 — 超限截断并强制终止进程树，防内存耗尽
- **SEC-05**: `splitTopLevel` 元素数量上限 10000，防 O(n²) ReDoS
- **SEC-06**: `project_replace` 扩展名白名单（`.gd/.tscn/.tres` 等）+ 硬编码排除 `.git`/`node_modules`
- **SEC-07**: `add_node`/`batch_add_nodes` 标识符正则校验 (`/^[A-Za-z0-9_]+$/`) + 批量上限 100

### Fixed

- **C-01**: EditorConnection 认证超时不再意外调度重连 — 在 `ws.close()` 前设置 `connectAttempt=true`
- **C-02**: Autoload loader 脚本的错误标记随机化 — `randomizeMarkers` 应用到 loader，防止用户代码伪造错误输出
- **C-03**: 进程替换保护 — `setProcessBusy` 守卫机制，运行中的进程不会被其他工具意外 kill
- **T-01/T-02/T-03**: test-framework 和 validation 的 GDScript 使用 `_initialize()` 替代 `_init()`，修复场景树未就绪时节点查找失败；修复 stress test `await process_frame` 缩进
- **T-04/T-05**: physics-ops raycast 添加 `World3D` null 检查，ik-tools owner 设置添加 root null 检查
- **S-02**: 确认令牌不再截断代码 — 用户可审查完整待执行内容
- **I-03**: 参数键只保留 snake_case 版本，消除 camelCase/snake_case 双键冲突
- **T-09/T-10**: ui-tools 生成的 GDScript 统一使用 tab 缩进；`draw_arc` 补充 `point_count` 参数
- **I-06**: `parseConfigValue` 空白字符串不再被错误解析为数字 0
- **I-01**: `gdEscape()` 移除无效的 `$` 转义 — GDScript 双引号字符串中 `$` 不是特殊字符（仅在表达式级别用于 NodePath）
- **I-02**: `ToolDispatcher` 统一所有错误响应使用 `opsErrorResult()` — 7 条路径从混用纯文本/手动 JSON 改为结构化 JSON
- **A-10**: `editor-auth.ts` 消除 TOCTOU 竞争 — 去掉 `existsSync()` 前置检查，直接 `readFileSync()` + try-catch
- **A-01**: `tscn-parser.ts` parseDictContent 分隔符检查 `:` 优先于 `=`（Godot 4.x 标准用冒号）
- **A-02**: Godot 二进制搜索增强 — `detectProjectPath` 深度 5→15，新增 `GODOT_PROJECT_PATH` / `GODOT_MCP_SEARCH_PATHS` 环境变量，扩展用户目录搜索（Downloads/Desktop）
- **C-01**: `godot_operations.gd` return 语句缩进修复（1tab→2tab）+ 混合行尾统一

### Changed

- **A-11**: `.gitignore` 新增 `.ruff_cache/`、`.reviews/`、`.claude/worktrees/`、`tsconfig.tsbuildinfo` 等条目
- **I-03/I-04/I-05**: `EditorConnection.notify()`、`process-state` 并发安全、`gdscript-executor` 沙箱扫描器局限性 — 补充 JSDoc 文档注释

### Added

- `process-state` 新增 `isProcessBusy()` / `setProcessBusy()` 导出
- 新增 17 个测试：busy guard (6)、parseConfigValue (10)、auth timeout reconnect (1)

## [0.12.0] - 2026-05-23

### Added

- **#10**: CSS Grid 翻译层 — `ui_build_layout` 的 `layout.direction` 支持 `"grid"`，使用 GridContainer，支持 `columns` 参数
- **#11**: EditorConnection 重连上限 — `maxReconnectAttempts` 选项（默认 20），超过后停止重连并触发 `onDisconnect`

### Changed

- **#7**: requestId 取模保护 — `websocket_server.gd` 和 `EditorConnection.ts` 的自增 ID 添加 `%` 取模，防止溢出
- **#9**: L015 lint 规则改为逐行扫描 + `isInCommentOrString` 过滤，消除注释/字符串中的误报
- **#6**: `edit_node` 和 `trySetHelper` 属性名自动 camelCase→snake_case 转换，MCP 调用方无需手动转换

## [0.11.1] - 2026-05-22

### Security

- **C1**: EditorConnection 消息大小限制从 `raw.length`（字符数）改为 `Buffer.byteLength(raw, 'utf8')`（字节数），修复多字节字符绕过 1MB 限制。
- **C2**: TCP Bridge 添加 `MAX_MESSAGE_SIZE`（1MB）缓冲区限制，超限时断连对端，与 WebSocket 服务端对称。
- **C3**: `_cmd_wait_for_property` 添加属性屏蔽检查，防止读取被屏蔽的属性。
- **C4**: 提取 `_is_blocked_property()` 统一函数，检查所有点分路径段而非仅首段。
- **M1**: `_is_blocked_property` 补充 `theme_override` 前缀屏蔽。
- **I2**: 点分段遍历中增加下划线前缀检查。

## [0.11.0] - 2026-05-22

### Added

- **verify_delivery** tool: end-to-end delivery verification with 4 dimensions (scene tree integrity, script health, performance, custom assertions)
- **L1 quickVerify**: optional lightweight verification embedded in write tool return values (`verify=true`)
- **dev_loop acceptance**: acceptance criteria parameter for post-execution verification

### Security

- **迭代 URL 解码**: `sanitizeResPath` 和 `resolveWithinRoot` 迭代解码最多 5 轮，防御 `%252e%252e%252f` 双编码路径遍历。
- **密钥文件生命周期**: Bridge 密钥文件不再由客户端读后即删，改为由 GDScript Bridge `_stop_server()` 统一管理，修复多实例兼容性。
- **认证锁定断开连接**: 超过最大认证失败次数后立即断开 TCP 连接，防止 CPU 空转。
- **编辑器 WebSocket 限速**: websocket_server 添加与 mcp_bridge 对称的暴力破解防护（5 次失败 → 30 秒锁定），消除两服务间的安全防护不对称。
- **重复安全函数标注**: `_constant_time_compare` 在两文件中标注 DUPLICATE 同步注释，防止未来修改时遗漏。

### Fixed

- **断言隔离**: verify_delivery 断言改为逐条独立执行，单条失败不阻塞后续断言。
- **认证失败检测**: game-bridge 客户端用 Bridge 错误码 (-32001/-32002) 替代魔法字符串匹配。
- **findAssociatedScenes 性能**: 场景文件内容缓存，避免 O(n*m) 重复读取。
- **项目有效性验证**: verify_delivery 入口检查 `project.godot` 是否存在。
- **quickVerify 占位**: 未实现的 quickVerify 返回 `passed:false` 而非误导性的 `passed:true`。
- **CRLF 处理**: `wrapAssertionCode` 正确处理独立 `\r`（与 `gdEscape` 一致）。
- **密钥生成 fallback**: `_generate_secret` 添加 10 次重试上限防止理论死循环。
- **parseConfigValue 引号**: 数组解析分割时尊重引号边界，不再误拆引号内逗号。

## [0.10.1] - 2026-05-21

### Security

- **Bridge TCP 绑定本地地址**: MCP Bridge 的 TCP 服务器从 `0.0.0.0` 改为 `127.0.0.1`，消除同网络设备未授权连接风险。
- **Bridge 密钥文件读后即删**: 认证密钥首次读取后立即从磁盘删除并缓存到内存，将凭证暴露窗口从整个会话期缩短到毫秒级。
- **Bridge 密钥缓存自愈**: Bridge 重启导致认证失败时自动清除缓存，下次调用重新从磁盘读取新密钥。
- **临时目录符号链接防护**: `cleanupOldSessions()` 使用 `lstatSync` 替代 `statSync` 并跳过符号链接，防止共享临时目录中的符号链接攻击。

### Fixed

- `opsErrorResult()` 返回结果现在包含 `isError: true`，MCP 客户端可正确检测失败响应。
- 新增 `errorResult()` 辅助函数统一错误返回格式。

## [0.10.0] - 2026-05-19

### Added

- CSS Flexbox 布局翻译层 (`ui_build_layout`)
- GDScript Lint 规则引擎 (`validate_scripts`)
- Flexbox 到 Godot Container 映射
- 布局参数验证与错误提示

### Security

- 路径遍历防护增强
- GDScript 转义顺序修复
- `confirm_and_execute` 只读守卫绕过修复
- Windows 进程终止统一
- 认证锁定绕过修复
- 模取偏差修复

### Fixed

- GDScript 字符串字面量修复
- 死代码清理
- 定时器泄漏修复
- 路径遍历绕过修复

---

## 早期版本概览(v0.1.0–v0.9.0 + v0.13.0 / v0.14.0)

> 早期版本无详细 Added/Fixed 记录,此处保留概览(2026-06-28 从原 ROADMAP 历史里程碑迁移,防丢失)。v0.10.0–v0.12.0 / v0.15.0+ 见上方详细变更;v0.13.0 / v0.14.0 暂仅概览(详细待补)。

### v0.14.0(2026-05-24)

7 轴全维度审查修复 + IK 框架 MVP + 测试基础设施升级。

- IK 框架 MVP(4 工具):ik_modifier_create / ik_modifier_get / ik_modifier_set / ik_list_bones
- 7 轴审查:8 CRITICAL + 20 IMPORTANT + 14 ADVISORY 发现,全部 CRITICAL 已修复
- 测试迁移 node:test → Vitest,1257 测试通过,47% 覆盖率;CI/CD GitHub Actions(Node 20/22 矩阵)

### v0.13.0(2026-05-23)

Bridge 安全加固 + 功能增强(C-01~C-03、requestId 取模、EditorConnection 重连上限、CSS Grid 翻译、edit_node camelCase→snake_case、L015 lint 逐行扫描)。

### v0.9.0(2026-05-16)

审查反馈 + 架构优化(118 工具,463 测试):批量工具 / UI 工具 / 录制系统(5 工具)/ editor_sync / 确认令牌 / Read-Only 模式 / Lite 模式。

### v0.8.0(2026-05-13)

架构升级(96 工具):双模式架构(Editor WebSocket + GDScript 插件 + UndoManager)/ 测试框架 + 导出管理 / 高级工具集(粒子+导航+AnimationTree)。

### v0.7.0 及更早

| 版本 | 日期 | 要点 |
|------|------|------|
| v0.7.0 | 2026-05-08 | 安全加固:输入转义、超时泄漏、类型安全、crypto.randomUUID |
| v0.6.0 | 2026-05-03 | 音频播放控制(4) + TileMap 编辑(8) |
| v0.5.0 | 2026-05-02 | 信号控制(4) + 物理查询(2) + 3D 创建(1) + 导航寻路(1) |
| v0.4.0 | 2026-05-01 | 版本检测 + validate_scripts + search_and_replace |
| v0.3.0 | — | edit_script + batch_add_nodes + validate_project + import_resources |
| v0.2.0 | — | read_scene + read/write_script + query_scene_tree + MCP Resources |
| v0.1.0 | — | 基础功能:项目/场景/执行控制/截图/API 文档 |
