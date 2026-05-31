# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
