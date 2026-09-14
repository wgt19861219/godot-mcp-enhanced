# 子项目 2：Web GUI 监控面板 — 设计文档

- **日期**: 2026-09-14
- **状态**: v3（v1 审阅 2B+6I+7M、v2 全新视角审阅 3B+4I+8M 全部裁决落实，见 §14 修订记录）
- **上游依赖**: 子项目 1「per-project 运行会话分桶」（`feat/per-project-run-sessions`，18 commits，READY WITH FOLLOW-UPS）——本设计的运行会话面板直接消费 `RunSession` 模型与 `logger.project` 字段
- **决策链**: 用户在 brainstorming 中确认——独立 Web GUI（吸收 dashboard TUI 全部功能、跨平台）→ 宿主嵌 MCP server 进程 + 默认开 → 工具统计/时序按项目分组 → 方案 A（零依赖单 HTML + `node:http` + SSE + Inspector 安全壳）

---

## 1. 背景与目标

用户在多项目并行开发中需要一个**人机共看的实时监控面板**：

- TUI dashboard 只能在终端看，且是独立进程读日志文件（2s 轮询），拿不到 server 进程内存态（RunSession 实时会话）
- 分桶批（子项目 1）就绪了数据基础：`LogEntry.project` 字段（`src/core/logger.ts:33`）+ `RunSession` 模型（`src/core/process-state.ts` 的 `listRunSessions()`）
- 用户要求 Web 界面在所有操作系统可用（浏览器即跨平台）

**成功标准**（对齐 §10 验收标准）：server 启动即带面板、`run_project` 起游戏后会话面板 1s 内反映、多 server 下**会话面板按进程隔离、日志/统计面板按 `srv` 进程标识过滤**（见 §3.3.1）、安全壳拒绝未授权访问、TUI 行为回归不变。

## 2. 范围

### 范围内

1. `src/web-gui/` 新子系统：`node:http` + SSE 服务，嵌 MCP server 进程，默认开
2. 单文件 HTML 前端（原生 JS + 内联 CSS，TS 模板字符串内嵌，零构建链改动）
3. 四面板：运行会话 / 日志流 / 工具统计（全部/按项目切换）/ 分钟桶时序图
4. CLI `dashboard --web`：读登记、pid 探活、跨平台开浏览器（`start`/`open`/`xdg-open`）
5. 安全壳：127.0.0.1 恒绑定 + per-process token + Origin 白名单 + 响应卫生
6. `src/dashboard/aggregator.ts` 扩展：per-project 统计 + 修 `meta.project_path` 恒 miss 死逻辑（改读 `entry.project`）
7. `src/core/logger.ts` 最小侵入：`LogEntry` 新增可选 `srv` 字段（进程标识，见 §3.3.1）——与 `project` 字段同模式（可选、向后兼容、dashboard 聚合器不破）
8. **既有死逻辑/时区修复（继承自 TUI 的 bug，Web GUI 将其提升为核心数据流故必须修）**：`src/dashboard/log-reader.ts` 的 `getTodayFile()` 改用**本地日期**与 logger `todayStr()` 对齐（现用 UTC——东八区每日 00:00-08:00 启动的进程 watch 错文件、面板断流最长 8 小时；改 LogReader 侧，不动 logger 存量文件名语义，TUI 同受益）
9. `src/dashboard/launcher.ts` **仅允许加一处入口 guard**（web-gui 激活时短路返回，不碰渲染与平台分支——理由见 §3.2 第二触发点）
10. 连带文档：① AGENTS.md `src/` 结构表新增 `src/web-gui/` 行 + dashboard 段措辞澄清（"独立只读 CLI 进程"描述仅指 TUI；web-gui 是 server 内嵌监控面，无设置项影响 server 行为的红线仍守住）；② `src/cli/router.ts` showHelp 的 dashboard 行补 `--web` 用法（受 `check:command-docs-drift` 门禁约束，命令文档同步）；③ CHANGELOG `[Unreleased]`

### 范围外（明确不做）

- **控制按钮**（杀进程/重启会话/停 server）——第一版只读，控制走 MCP 工具
- **跨 server 聚合**——多 AI 客户端各开各的面板，一板一 server（日志/统计经 `srv` 过滤后仅显示本进程条目）
- **远程访问**——不支持改绑定 host（需远程者走 ssh 隧道），从根上断掉局域网暴露
- **dashboard TUI 代码改动**——冻结保留，三处例外均为接线层/纯逻辑修复而非 TUI 渲染本体：① aggregator 死逻辑修复（`getState()` 结构契约不变）；② `log-reader.ts` 时区对齐修复（§2.8，TUI 同受益）；③ `launcher.ts` 入口 guard 一处（§2.9，`GODOT_MCP_WEB_GUI=0` 或 web-gui 启动失败时 TUI 照旧自动弹，回退路径完整）
- **前端框架/构建链**——零依赖单 HTML 是定案
- **规则模板/`.claude/rules` 联动**——不引导客户端配置，不触发版本 bump 硬门禁
- **浏览器兼容基线**——近两年主流浏览器（需 `EventSource`/`sessionStorage`/CSS Grid/Flex）
- **i18n**——面板文案中文即可；**无障碍基线**——语义标签 + `textContent`，不做 ARIA 全覆盖

## 3. 架构

### 3.1 组件与目录

新目录 `src/web-gui/`（≥2 源文件，符合仓库分组规则）：

| 文件 | 职责 | 关键约束 |
|------|------|---------|
| `server.ts` | `WebGuiServer` 类：`node:http` 服务、SSE 通道、token/Origin 校验、端口避让 | 依赖全部**构造器注入**（快照函数/配置/logger），遵守 2026-08-21 架构红线（禁新增模块级 setter）。**listen 后 `server.unref()` 且每个 SSE socket `unref()`**（附属功能不阻塞进程退出，对齐 orphanScanTimer 先例；server.unref 不覆盖已建连接，故逐 socket unref）；**关闭顺序 = 逐 SSE 连接 end → `closeAllConnections()` → `close()`**（对齐 instance-http-server P2-3R 先例，防长连接挂起 close 回调）。导出**只读查询** `isWebGuiActive(): boolean`（内部模块级状态由本模块类方法维护，非注入接口，合规）供 launcher 入口 guard 使用 |
| `html.ts` | 单文件 HTML 内嵌 TS 模板字符串（预计 20-40KB） | HTML 本体**不含 token**；无独立构建步骤（TS 字符串随 tsc 正常编译进 build，无打包链） |
| `registry.ts` | per-pid 登记文件 `~/.godot-mcp/web-gui/<pid>.json`（`{pid, port, token, startedAt}`）+ readdir 聚合 + pid 探活清死 | **per-pid 单文件**（每实例写自己的文件，无并发写竞争——对齐 `~/.godot-mcp/instances/` InstanceManager 模式与 `inflight-<pid>.json` 先例）；**写入带磁盘权限加固**（照抄 instance-manager S-5：`mode 0o600` + 目录 `0o700` + Windows icacls——登记文件含 token 准入凭证，默认 0644 会被同机他用户读取后直接 curl 击穿安全壳第 2 层）；**原子写**（.tmp → rename，同先例）；`isPidAlive` 做成注入点供测试 mock |

### 3.2 接线与配置

- `GodotServer.run()` 流程内创建 `WebGuiServer`，**启动结果（成功 listen / 禁用 / 失败三态）记录在 server 实例上**（如 `webGuiActive: boolean` 属性）——这是 `src/index.ts` TUI 决策的同步查询点（run() 完成后状态已定，无时序竞态）
- **auto-launch TUI 抑制（双保险，覆盖两个触发点）**：
  - 触发点 1 `src/index.ts:164-166`：TUI 决策从"与 `server.run()` 并行的动态 import"改为**在 `server.run()` 完成后查询 `webGuiActive` 再决定**——激活则跳过，禁用/失败则照旧弹
  - 触发点 2 `src/tools/game-bridge.ts:69`（`setOnBridgeConnected(() => launchDashboardOnce())`——bridge 首连回调，v2 遗漏的第二触发点）：在 `launchDashboardOnce()` **入口加 guard**——`isWebGuiActive()` 为真即短路返回（launcher.ts 唯一允许的改动，见 §2.9；不在 tools 层引入 web-gui 耦合）。注意 `launcher.ts:31-39` 的 `_launched` 标志只在真执行后置位，仅靠 index.ts 跳过调用挡不住此触发点
- `GodotServer.close()` 安全链新增 `stopWebGui` 步骤（插入位置实现时定，处于 killAllRunSessions 同层；按 §3.1 关闭顺序：SSE 全连接 end + `closeAllConnections()` + HTTP close + 删除自己的 per-pid 登记文件）
- 配置：**纯 env 开关**（与 TUI 的 `GODOT_MCP_NO_DASHBOARD` 同一模式）——
  - `GODOT_MCP_WEB_GUI`：`0` 关闭（默认开；关闭时 auto-launch TUI 照旧）
  - `GODOT_MCP_WEB_GUI_PORT`：端口起点（默认 **9550**，已核实现有占用：bridge 9081-9090、editor WS 9090 及扩展段 9090-9094、DAP 6006、web 试玩用户自选——无冲突）

### 3.3 数据流（三条，全在 server 进程内）

1. **日志/统计**：`LogReader`（复用 `src/dashboard/log-reader.ts`，**先修其 `getTodayFile()` UTC/本地时区 bug**，见 §2.8）以 **500ms** 轮询 tail 日志文件 → **按 `entry.srv === 本进程 serverId` 过滤** → 喂扩展版 `Aggregator` → 出全局 + per-project 统计。对 logger 的侵入收敛为一处：`LogEntry` 新增可选 `srv` 字段（`src/core/logger.ts` 单例创建时 `crypto.randomUUID()` 生成一次；**写点共 5 处全覆盖**——`log()`（debug/info/warn/error 全经此）、`toolStart()`、`toolEnd()`、`checkToolTimeouts()` 超时条目（直推 buffer，不经 writeEntry——漏写则超时 tool_end 被 srv 过滤丢弃、统计丢错误计数）、rotation 条目；字段可选、无行为变更、既有消费者不破——与 `project` 字段同模式）。另需新增**只读取出导出 `getServerId()`**（供 WebGuiServer 读本进程 srv 做过滤；只读查询非 setter，合规）。已验证 `resetLogger()` 生产代码零调用，srv 进程内稳定。
   - 背景（v1 审 B-1）：日志文件按天命名（`<YYYY-MM-DD>.jsonl`）且多 server 同日**共写同一文件**、`LogEntry` 原无进程标识——不过滤则双 server 场景日志流/统计互相污染。`srv` 字段是"互不串"验收标准（§10.3）的数据基础
   - 端到端延迟上界：logger 写盘缓冲 bufferMs 默认 100ms（`logger.ts:60`）+ 轮询 500ms ≈ 最坏 600ms，满足监控场景"接近实时"（时区 bug 修复后全时段成立，见 §2.8）
   - `pollIntervalMs` **不得低于 500ms**（`LogReader` 的 `CHECK_DEBOUNCE_MS` 防抖硬下限，再小会被静默吞掉）
   - 后续如需毫秒级实时再考虑 logger 实例级 subscribe，本期不做
2. **运行会话**：调 `process-state` **新增导出 `listRunSessionsDetailed()`**（返回 §4.1 白名单全字段；**不改动**既有 `listRunSessions()` 的四字段 DTO 契约与既有测试；**实现必须直接遍历 `_sessions`（同 `listRunSessions()` 现模式），禁止经 `getOrCreateSession` 触发惰性建桶**——否则空桶进 `_sessions` 与 FIFO 逐出序，污染分桶语义），序列化时挑字段：`displayPath` / `status` / pid / `processStartTime` / busy 三件组（busy/busyOwner/busySince）/ 输出缓冲行数（**两态语义**：运行中 = `outputBuffer.length`，已结束 = `lastFinishedRunOutput.length`）。**`proc`（ChildProcess 引用）不外泄**。（背景：v1 审 B-2——原设计声明的 7 字段中 4 字段不在 `listRunSessions()` 实际 DTO 上）
3. **推送**：SSE 事件三类——
   - `hello`（**每次连接建立都发**，含 EventSource 自动重连：幂等全量 = 会话列表 + 统计快照 + 最近日志尾部；客户端收到 hello 即整体重置本地状态后续增量——这是断线恢复的唯一机制。**去重键**：hello 回放与 in-flight log 帧可能短暂重叠，前端按稳定键（`ts` + `call_id` + 会话内序号）去重）
   - `log`（增量日志批量，按 500ms 聚合帧）
   - `sessions` / `stats`（快照推送，节流 500ms / 1s）
   - `/api/sessions`、`/api/stats` 按需 GET 端点降级为**非 SSE 备用/调试**（断线恢复不依赖它们）

### 3.4 HTTP 端点

| 端点 | 方法 | 鉴权 | 响应 |
|------|------|------|------|
| `/` | GET | 无（静态 HTML，不含 token） | `text/html` + nosniff + CSP |
| `/events` | GET (SSE) | query `?token=` + Origin 白名单；连接建立即发幂等 `hello` | `text/event-stream` |
| `/api/sessions` | GET | `X-GUI-Token` 头 或 query token | JSON 会话快照（`listRunSessionsDetailed()` 白名单字段） |
| `/api/stats` | GET | 同上 | JSON 统计快照（含 per-project） |

## 4. 四面板契约

### 4.1 运行会话（新能力，TUI 没有）

每行一个 `RunSession`（数据源 `listRunSessionsDetailed()`）：项目 `displayPath`、状态徽章（色标：`running` 绿 / `starting` 蓝 / `stopping` 黄 / `exited_early` 红 / `errored` 橙 / `exited` 灰）、pid、启动时刻、busy 标记、输出缓冲行数（两态语义见 §3.3.2）。无会话时显示空态提示。

### 4.2 日志流（吸收 TUI）

最近 500 条回放 + 实时追加（SSE `log` 事件）；过滤输入框（工具名/模块/项目子串）+ 级别下拉（ALL → INFO → WARN → ERROR）——TUI 快捷键 `f`/`l` 的 Web 等价物。日志文本一律 `textContent` 插入（防日志内容 XSS）。

### 4.3 工具统计（吸收 TUI + 增强）

表格列：tool / calls / errors / avg / min / max / lastCalled。数据字段与 TUI `ToolStats` 一致（`avg` 由 `totalDurationMs / calls` 前端派生，不新增后端字段）。顶部切换器：**全部 / 按项目**（`project` 字段分组，多项目并行时看清各项目状况）。

### 4.4 分钟桶时序图（吸收 TUI"性能面板"）

30 个分钟桶（calls/errors/总耗时，UTC 分钟 key，与 aggregator 现有实现一致），纯 CSS 柱状图（零依赖），随 4.3 的项目切换器联动。

> 语义澄清：本面板是**工具调用时序统计**（继承 TUI 的"性能面板"语义），不是游戏运行时性能（那属 profiler/bridge 域，范围外）。

## 5. 安全模型（Inspector 壳，四层）

1. **绑定恒 127.0.0.1**：不提供 host 配置项。远程访问 = 范围外（ssh 隧道自理）
2. **token**：每进程 `crypto.randomBytes(24)` 生成（hex 48 字符）。进入路径仅一条：CLI 打开的 URL `?token=xxx`；页面 JS 存 `sessionStorage` 后立即 `history.replaceState` 清掉 URL query（token 不留浏览器历史），后续 fetch 带 `X-GUI-Token` 头；刷新由 sessionStorage 恢复。`/` 返回的 HTML 是无 token 静态串
3. **Origin 校验**：SSE（`EventSource` 不能带自定义头）= query token + Origin 白名单（仅 `http://127.0.0.1:<port>` 与 `http://localhost:<port>`）组合；无 Origin 的非浏览器客户端（curl 等）凭 token 放行。校验失败一律 401/403，不发任何 CORS 头
4. **响应卫生**：`X-Content-Type-Options: nosniff`；CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`（单文件内嵌所需）；日志/路径等动态内容全部 `textContent`

> SSE over WS 的选型依据：WS 不受同源策略约束（CSWSH 攻击面，Vitest CVE-2025-24964 教训），SSE 受 CORS 约束且 EventSource 原生自动重连——竞品调研结论。

## 6. CLI / launcher

- `godot-mcp-enhanced dashboard --web`：
  1. readdir `~/.godot-mcp/web-gui/` 聚合 per-pid 登记文件 → 逐条 `isPidAlive` 探活，死条目顺手删除；`startedAt` **语义 = 登记写入时刻**（不跨平台读第三方进程启动时间——成本高于收益），pid 活但登记明显陈旧的（pid 复用误判面）标注可疑并优先 GET `/api/stats` 探测确认
  2. 一个活 server → 直接开浏览器；多个 → 终端编号菜单让用户选；零个 → 提示"没有运行中的 MCP server"（退出码非 0）
  3. 浏览器启动失败（`start`/`open`/`xdg-open` 全不可用）→ 降级打印完整 URL（含 token）手动点
- `godot-mcp-enhanced dashboard`（无参）：**TUI 行为完全不变**（现 `launchDashboardOnce()` 路径不动）
- 子命令命名避让：CLI `web` 已被"Web 试玩闭环"占用（`src/cli/router.ts:11`），故走 `dashboard --web` 而非新子命令

## 7. 生命周期与错误处理

| 场景 | 行为 |
|------|------|
| 端口避让 | 9550 起被占 +1，最多试 20 个；全占 → **警告并禁用 GUI，MCP server 照常运行**（audit log 记 warn）；禁用后 auto-launch TUI 照旧（§3.2） |
| server 正常退出 | `close()` 链 `stopWebGui`：逐 SSE 连接 end → `closeAllConnections()` → HTTP close → 删除 per-pid 登记文件。listen 已 `unref()`，GUI 开启下进程仍可干净退出（不被 HTTP/SSE 句柄挂住） |
| SIGKILL 残留登记 | per-pid 文件残留由下次 `dashboard --web` 或新 server 启动时探活清除 |
| SSE 断线（浏览器侧） | `EventSource` 原生自动重连；**重连即新连接 → 服务端重发幂等 `hello` 全量 → 客户端整体重置后续增量**（唯一恢复机制，不依赖 /api）。注：`history.replaceState` 清 URL query 不影响重连（EventSource 重连用构造时 URL，token 仍在） |
| token 失效（server 重启后端口被新进程复用） | `EventSource` 不暴露状态码、会 401 自动重连死循环——前端 `onerror` 配 fetch `/api/stats` 探测，确认 401 后**停止重连**并显示"面板已失效（server 已重启），请重新运行 dashboard --web" |
| SSE 死连接（服务端侧） | 写失败自动摘除连接，防句柄泄漏；活跃 SSE socket 已逐个 `unref()`（§3.1），不阻塞进程退出 |
| 日志源故障（文件删/轮转） | `LogReader` 轮询重试；GUI 顶部黄条"日志源中断重试中" |
| WebGuiServer 任何异常 | 捕获 → 降级为禁用 → 不影响 MCP 主功能（GUI 是附属功能，绝不拖垮主服务） |

## 8. aggregator 扩展（含死逻辑修复）

`src/dashboard/aggregator.ts`：

1. **新增** per-project 统计：`toolStatsByProject: Map<string, Map<string, ToolStats>>` 与 `timeSeriesByProject`（结构同全局，key = `entry.project`；无 project 字段的条目归入 `"unknown"` 桶）。`timeSeriesByProject` **必须复刻 A-12 幽灵清理逻辑**（getState 时清理已被 RingBuffer 覆盖的旧 minuteKey——minuteKey 只有 HH:MM 无日期，跨天防撞桶依赖此清理）。新增 `getProjectKeys()` / `getStateFor(project)` 供 Web GUI 使用
2. **修复** `aggregator.ts:65-70` 死逻辑：`meta.project_path` 恒 miss（真数据在 `entry.project`，logger 子项目 1 已写实）→ 改读 `entry.project`
3. **契约表述**：`getState()` / `getTopTools()` 返回**结构**零改动；唯一值变化 = `projectPath` 从恒空变为**首个观察值**（沿现有 `!this.projectPath` 只赋值一次的语义，多项目下可能停留在最早项目——TUI StatusBar 的已知局限，Web GUI 的按项目分组不受此影响）

## 9. 测试策略

- **单元**（Vitest，新代码不进覆盖率排除清单，纳入现有阈值——实测 `vitest.config.ts:22-27`：statements 76 / branches 51 / functions 79 / lines 77）：
  - registry：per-pid 登记写/读/readdir 聚合/isPidAlive 探活清死（注入点 mock）；**双进程并发登记互不丢失**（各写各文件，聚合两条都在）；**登记文件权限**（0o600，注入 fs 断言或读 mode）
  - 鉴权矩阵：对 token 对 Origin / 无 Origin curl / 错 token / 错 Origin 四象限的放行拒绝
  - Aggregator：per-project 统计正确性（多项目混合流）/ `entry.project` 修复验证 / `getState()` 结构契约回归（证 TUI 冻结）/ `srv` 过滤（本进程条目进、他进程条目弃，**含超时 tool_end 条目**——覆盖 5 写点）
  - `log-reader.ts` 时区修复：mock 时钟跨 UTC/本地边界（本地 00:00-08:00 窗口）验证定位到 logger 实际写入的本地日期文件
  - TUI 抑制：`isWebGuiActive()` 真/假两态下 `launchDashboardOnce()` 行为（真=短路不弹不置位 `_launched`；假=照旧）；`GodotServer.webGuiActive` 三态传播
  - 端口避让：mock 端口占用场景
- **集成**：真起 HTTP——`GET /` 回 HTML（含 nosniff/CSP 头）、`/api/sessions` 回白名单字段（断言无 `proc` 键、含两态输出行数语义）、SSE 首连 `hello`、**断开重连后再次收到 `hello` 且状态恢复一致**、错 token 401、写入日志后 500ms 内收到 `log` 事件（带 `srv` 过滤）、**GUI 开启下进程 close 无残留句柄挂起**
- **既有测试隔离**：`GodotServer` 被大量既有测试构造，web-gui 默认开会真 listen + 写真实 `~/.godot-mcp/`——**`test/setup.js` 全局设 `GODOT_MCP_WEB_GUI=0`**，web-gui 专属测试显式开 env（隔离用户 home 与端口竞争）
- **前端**：不写单测（原生 JS 无构建链），API 契约测试锁字段 + 真机人工验收
- **门禁**：标准 `npm run lint` + `npm run build` + `npm test`；不改工具清单 → 不跑 build-matrix；不涉 `.claude/rules` → 无版本 bump 硬门禁（变更进 CHANGELOG `[Unreleased]`）；showHelp 补 `--web` 行后跑 `check:command-docs-drift`

## 10. 验收标准（真机）

1. server 启动 → `~/.godot-mcp/web-gui/` 有本进程登记文件；`dashboard --web` 打开浏览器四面板有数据
2. `run_project` 起游戏 → 会话面板 1s 内出现 running 条目；关窗后变 exited 且输出快照行数可见
3. 双 AI 客户端双 server → 两端口两面板：**会话面板天然进程隔离（各看各的内存态），日志流/统计面板经 `srv` 过滤后仅显示本进程条目**（互不串）
4. 错 token 访问 401、伪造 Origin 的 SSE 被拒
5. TUI `dashboard` 行为回归不变（`getState()` 结构契约不变；`GODOT_MCP_WEB_GUI=0` 时 auto-launch TUI 照旧）

## 11. 实施基线（分支）

- 本分支 `feat/web-gui-panel` **基于 `feat/per-project-run-sessions`** 开出（依赖其 `RunSession` 模型与 `logger.project` 字段）
- 分桶分支合入 master 的时机是用户保留决策（18 commits 已过全部门禁 + 双项目真机验收）；期间若用户批准合并，本分支 rebase 到 master 快进即可，不封锁任何路径

## 12. 竞品参考（设计依据）

| 来源 | 借鉴点 |
|------|--------|
| MCP Inspector | server 进程内嵌 HTTP + token 准入 + Origin allow-list + 默认回环绑定 |
| Vitest CVE-2025-24964 | WS 的 CSWSH 攻击面 → 选 SSE（受 CORS 约束 + EventSource 原生重连） |
| webpack-bundle-analyzer static | 零依赖单 HTML 先例（无构建链、可移植） |
| PM2 | 进程登记表形态（pid/port 元数据 + 死槽位校验）；上限策略反向借鉴（我们端口有限避让而非无限） |
| 本仓 InstanceManager / instance-http-server | per-pid 登记文件（免并发写竞争）；`closeAllConnections` 防长连接挂起 close |

## 13. 开放问题

无——两轮审阅全部发现已裁决：v1 审 2B+6I+7M（srv 字段/listRunSessionsDetailed/per-pid 登记/幂等 hello 等）、v2 审 3B+4I+8M（双触发点抑制/时序竞态/时区 bug/登记权限/srv 5 写点/测试隔离/禁惰性建桶等），详见 §14。

## 14. 修订记录

- **v1 → v2**（2026-09-14，第一轮第三方审阅 APPROVED WITH REVISIONS 后修订）：
  - B-1：`LogEntry` 新增可选 `srv` 进程标识字段，日志/统计按 `srv` 过滤；"零 logger 侵入"改为"最小侵入（一处可选字段）"；§10.3 验收标准改准确表述
  - B-2：新增 `listRunSessionsDetailed()` 导出（不动 `listRunSessions()` 契约）；§4.1 输出行数两态语义
  - I-1：登记改 per-pid 文件（`~/.godot-mcp/web-gui/<pid>.json`）+ isPidAlive 注入点
  - I-2：砍 settings.json 配置层（原声明失实），纯 env 开关
  - I-3：web-gui 启用成功时抑制 auto-launch TUI（范围外清单加例外注记）
  - I-4：SSE 断线恢复改为"重连即重发幂等 hello，客户端整体重置"；/api 降级备用
  - I-5：listen 后 unref；关闭顺序 SSE end → closeAllConnections → close
  - I-6：AGENTS.md 结构表/措辞连带更新列入范围
  - M-1/2/3/4/5/7：契约措辞精确化、pollIntervalMs ≥ 500ms 注记、A-12 清理复刻、构建措辞、replaceState 清 token、范围外补浏览器/i18n/无障碍基线；M-6：pid 复用误判面探活+startedAt 粗校验（§6.1）
- **v2 → v3**（2026-09-14，第二轮全新视角审阅 NEEDS REWORK 后局部返工）：
  - B-1：TUI 抑制补第二触发点 `game-bridge.ts:69`（bridge 首连回调，v2 遗漏——`_launched` 标志只在真执行后置位，仅跳过 index.ts 调用挡不住它）：`launcher.ts` 放宽为"仅允许入口 guard 一处"（`isWebGuiActive()` 短路），与 index.ts 决策双保险（§3.2）
  - B-2：TUI 决策时序竞态：`GodotServer` 暴露 `webGuiActive` 状态属性（run() 完成后已定），index.ts 决策改在 run() 完成后查询（§3.2）
  - B-3：`log-reader.ts getTodayFile()` UTC vs logger 本地日期的时区 bug（东八区每日 00:00-08:00 启动断流）——列入范围修复（§2.8），LogReader 侧对齐本地日期，TUI 同受益；§9 加 mock 时钟跨边界测试
  - I-1：登记文件磁盘权限加固（0o600/0o700/icacls + 原子写，照抄 instance-manager S-5——token 是准入凭证，默认权限会击穿安全壳第 2 层）（§3.1）
  - I-2：srv 写点列全 5 处（含 checkToolTimeouts 超时条目与 rotation 条目）+ 新增只读取出导出 `getServerId()`（§3.3.1）
  - I-3：既有测试隔离——`test/setup.js` 全局 `GODOT_MCP_WEB_GUI=0`，专属测试显式开（§9）
  - I-4：`listRunSessionsDetailed()` 禁止经 `getOrCreateSession` 惰性建桶，直接遍历 `_sessions`（§3.3.2）
  - M-1：hello 与 in-flight log 帧去重键（ts+call_id+序号）（§3.3.3）
  - M-2：token 失效 401 重连死循环防护——前端 onerror + fetch 探测后停重连提示重开（§7）
  - M-3：覆盖率阈值改实测值 76/51/79/77（§9）
  - M-4：连带清单补 showHelp `--web` 行 + `check:command-docs-drift` 门禁（§2.10）
  - M-5：startedAt 语义定为登记写入时刻，不跨平台读进程启动时间（§6.1）
  - M-7：端口清单补 DAP 6006（§3.2）
  - M-8：活跃 SSE socket 逐个 unref（§3.1）
  - M-6：stopWebGui 插入位置实现时定，已在 §3.2 注明
