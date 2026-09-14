# 子项目 2：Web GUI 监控面板 — 设计文档

- **日期**: 2026-09-14
- **状态**: v1（brainstorming 产出，待第三方审阅）
- **上游依赖**: 子项目 1「per-project 运行会话分桶」（`feat/per-project-run-sessions`，18 commits，READY WITH FOLLOW-UPS）——本设计的运行会话面板直接消费 `RunSession` 模型与 `logger.project` 字段
- **决策链**: 用户在 brainstorming 中确认——独立 Web GUI（吸收 dashboard TUI 全部功能、跨平台）→ 宿主嵌 MCP server 进程 + 默认开 → 工具统计/时序按项目分组 → 方案 A（零依赖单 HTML + `node:http` + SSE + Inspector 安全壳）

---

## 1. 背景与目标

用户在多项目并行开发中需要一个**人机共看的实时监控面板**：

- TUI dashboard 只能在终端看，且是独立进程读日志文件（2s 轮询），拿不到 server 进程内存态（RunSession 实时会话）
- 分桶批（子项目 1）就绪了数据基础：`LogEntry.project` 字段（`src/core/logger.ts:33`）+ `RunSession` 模型（`src/core/process-state.ts` 的 `listRunSessions()`）
- 用户要求 Web 界面在所有操作系统可用（浏览器即跨平台）

**成功标准**（对齐 §10 验收标准）：server 启动即带面板、`run_project` 起游戏后会话面板 1s 内反映、多 server 数据互不串、安全壳拒绝未授权访问、TUI 行为回归不变。

## 2. 范围

### 范围内

1. `src/web-gui/` 新子系统：`node:http` + SSE 服务，嵌 MCP server 进程，默认开
2. 单文件 HTML 前端（原生 JS + 内联 CSS，TS 模板字符串内嵌，零构建链改动）
3. 四面板：运行会话 / 日志流 / 工具统计（全部/按项目切换）/ 分钟桶时序图
4. CLI `dashboard --web`：读登记、pid 探活、跨平台开浏览器（`start`/`open`/`xdg-open`）
5. 安全壳：127.0.0.1 恒绑定 + per-process token + Origin 白名单 + 响应卫生
6. `src/dashboard/aggregator.ts` 扩展：per-project 统计 + 修 `meta.project_path` 恒 miss 死逻辑（改读 `entry.project`）

### 范围外（明确不做）

- **控制按钮**（杀进程/重启会话/停 server）——第一版只读，控制走 MCP 工具
- **跨 server 聚合**——多 AI 客户端各开各的面板，一板一 server
- **远程访问**——不支持改绑定 host（需远程者走 ssh 隧道），从根上断掉局域网暴露
- **dashboard TUI 改动**——冻结保留（唯一例外：aggregator 死逻辑修复，`getState()` 契约不变）
- **前端框架/构建链**——零依赖单 HTML 是定案
- **规则模板/`.claude/rules` 联动**——不引导客户端配置，不触发版本 bump 硬门禁

## 3. 架构

### 3.1 组件与目录

新目录 `src/web-gui/`（≥2 源文件，符合仓库分组规则）：

| 文件 | 职责 | 关键约束 |
|------|------|---------|
| `server.ts` | `WebGuiServer` 类：`node:http` 服务、SSE 通道、token/Origin 校验、端口避让 | 依赖全部**构造器注入**（快照函数/配置/logger），遵守 2026-08-21 架构红线（禁新增模块级 setter） |
| `html.ts` | 单文件 HTML 内嵌 TS 模板字符串（预计 20-40KB） | HTML 本体**不含 token**；不进 tsc 构建链（字符串即产物） |
| `registry.ts` | 登记文件 `~/.godot-mcp/web-gui.json`（`[{pid, port, token, startedAt}]`）读写 + 死进程清理 | 与 `~/.godot-mcp/settings.json` 同目录约定 |

### 3.2 接线与配置

- `GodotServer` 启动完成后创建 `WebGuiServer`；`close()` 安全链新增 `stopWebGui` 步骤（HTTP close + SSE 全连接 end + 移除登记）
- 配置优先级：env > `~/.godot-mcp/settings.json` > 默认值（与 dashboard TUI 开关约定同源）：
  - `GODOT_MCP_WEB_GUI`：`0` 关闭（默认开）
  - `GODOT_MCP_WEB_GUI_PORT`：端口起点（默认 **9550**，已核实现有占用：bridge 9081-9090、editor WS 9090、web 试玩用户自选——无冲突）

### 3.3 数据流（三条，全在 server 进程内）

1. **日志/统计**：`LogReader`（复用 `src/dashboard/log-reader.ts`）以 **500ms** 轮询 tail 本进程日志文件 → 喂扩展版 `Aggregator` → 出全局 + per-project 统计。零 logger 侵入（不改写盘缓冲；后续如需毫秒级实时再考虑 logger 实例级 subscribe，本期不做）
2. **运行会话**：直接调 `process-state` 的 `listRunSessions()` 内存快照，序列化时白名单挑字段：`displayPath` / `status` / pid / `processStartTime` / busy 三件组 / 输出缓冲行数。**`proc`（ChildProcess 引用）不外泄**
3. **推送**：SSE 事件三类——
   - `hello`（首连全量：会话列表 + 统计快照 + 最近日志尾部）
   - `log`（增量日志批量，按 500ms 聚合帧）
   - `sessions` / `stats`（快照推送，节流 500ms / 1s）
   - 另有 `GET /api/sessions`、`GET /api/stats` 按需端点，供 SSE 断线重连后恢复全量

### 3.4 HTTP 端点

| 端点 | 方法 | 鉴权 | 响应 |
|------|------|------|------|
| `/` | GET | 无（静态 HTML，不含 token） | `text/html` + nosniff + CSP |
| `/events` | GET (SSE) | query `?token=` + Origin 白名单 | `text/event-stream` |
| `/api/sessions` | GET | `X-GUI-Token` 头 或 query token | JSON 会话快照 |
| `/api/stats` | GET | 同上 | JSON 统计快照（含 per-project） |

## 4. 四面板契约

### 4.1 运行会话（新能力，TUI 没有）

每行一个 `RunSession`：项目 `displayPath`、状态徽章（色标：`running` 绿 / `starting` 蓝 / `stopping` 黄 / `exited_early` 红 / `errored` 橙 / `exited` 灰）、pid、启动时刻、busy 标记、输出缓冲行数。数据源 `listRunSessions()`。无会话时显示空态提示。

### 4.2 日志流（吸收 TUI）

最近 500 条回放 + 实时追加（SSE `log` 事件）；过滤输入框（工具名/模块/项目子串）+ 级别下拉（ALL → INFO → WARN → ERROR）——TUI 快捷键 `f`/`l` 的 Web 等价物。日志文本一律 `textContent` 插入（防日志内容 XSS）。

### 4.3 工具统计（吸收 TUI + 增强）

表格列：tool / calls / errors / avg / min / max / lastCalled。数据字段与 TUI `ToolStats` 一致（`avg` 由 `totalDurationMs / calls` 前端派生，不新增后端字段）。顶部切换器：**全部 / 按项目**（`project` 字段分组，多项目并行时看清各项目状况）。

### 4.4 分钟桶时序图（吸收 TUI"性能面板"）

30 个分钟桶（calls/errors/总耗时，UTC 分钟 key，与 aggregator 现有实现一致），纯 CSS 柱状图（零依赖），随 4.3 的项目切换器联动。

> 语义澄清：本面板是**工具调用时序统计**（继承 TUI 的"性能面板"语义），不是游戏运行时性能（那属 profiler/bridge 域，范围外）。

## 5. 安全模型（Inspector 壳，四层）

1. **绑定恒 127.0.0.1**：不提供 host 配置项。远程访问 = 范围外（ssh 隧道自理）
2. **token**：每进程 `crypto.randomBytes(24)` 生成（hex 48 字符）。进入路径仅一条：CLI 打开的 URL `?token=xxx`；页面 JS 存 `sessionStorage`，后续 fetch 带 `X-GUI-Token` 头；刷新由 sessionStorage 恢复。`/` 返回的 HTML 是无 token 静态串
3. **Origin 校验**：SSE（`EventSource` 不能带自定义头）= query token + Origin 白名单（仅 `http://127.0.0.1:<port>` 与 `http://localhost:<port>`）组合；无 Origin 的非浏览器客户端（curl 等）凭 token 放行。校验失败一律 401/403，不发任何 CORS 头
4. **响应卫生**：`X-Content-Type-Options: nosniff`；CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`（单文件内嵌所需）；日志/路径等动态内容全部 `textContent`

> SSE over WS 的选型依据：WS 不受同源策略约束（CSWSH 攻击面，Vitest CVE-2025-24964 教训），SSE 受 CORS 约束且 EventSource 原生自动重连——竞品调研结论。

## 6. CLI / launcher

- `godot-mcp-enhanced dashboard --web`：
  1. 读 `web-gui.json` → 逐条 `process.kill(pid, 0)` 探活，死条目顺手清除并回写
  2. 一个活 server → 直接开浏览器；多个 → 终端编号菜单让用户选；零个 → 提示"没有运行中的 MCP server"（退出码非 0）
  3. 浏览器启动失败（`start`/`open`/`xdg-open` 全不可用）→ 降级打印完整 URL（含 token）手动点
- `godot-mcp-enhanced dashboard`（无参）：**TUI 行为完全不变**（现 `launchDashboardOnce()` 路径不动）
- 子命令命名避让：CLI `web` 已被"Web 试玩闭环"占用（`src/cli/router.ts:11`），故走 `dashboard --web` 而非新子命令

## 7. 生命周期与错误处理

| 场景 | 行为 |
|------|------|
| 端口避让 | 9550 起被占 +1，最多试 20 个；全占 → **警告并禁用 GUI，MCP server 照常运行**（audit log 记 warn） |
| server 正常退出 | `close()` 链 `stopWebGui`：HTTP close + SSE 全部 end + 登记条目移除 |
| SIGKILL 残留登记 | 下次 `dashboard --web` 或新 server 启动时 pid 探活清除 |
| SSE 断线（浏览器侧） | `EventSource` 原生自动重连；重连后先 GET `/api/*` 恢复全量再续订增量 |
| SSE 死连接（服务端侧） | 写失败自动摘除连接，防句柄泄漏 |
| 日志源故障（文件删/轮转） | `LogReader` 轮询重试；GUI 顶部黄条"日志源中断重试中" |
| WebGuiServer 任何异常 | 捕获 → 降级为禁用 → 不影响 MCP 主功能（GUI 是附属功能，绝不拖垮主服务） |

## 8. aggregator 扩展（含死逻辑修复）

`src/dashboard/aggregator.ts`：

1. **新增** per-project 统计：`toolStatsByProject: Map<string, Map<string, ToolStats>>` 与 `timeSeriesByProject`（结构同全局，key = `entry.project`；无 project 字段的条目归入 `"unknown"` 桶）。新增 `getProjectKeys()` / `getStateFor(project)` 供 Web GUI 使用
2. **修复** `aggregator.ts:65-70` 死逻辑：`meta.project_path` 恒 miss（真数据在 `entry.project`，logger 子项目 1 已写实）→ 改读 `entry.project`。**影响面**：TUI StatusBar 的 projectPath 从恒空变为显示真实路径（修复而非破坏）；`getState()` 返回结构不变（TUI 冻结契约）
3. 全局统计与 `getState()` / `getTopTools()` 现有行为零改动

## 9. 测试策略

- **单元**（Vitest，新代码不进覆盖率排除清单）：
  - registry：登记写/读/pid 探活清死条目（mock `process.kill`）
  - 鉴权矩阵：对 token 对 Origin / 无 Origin curl / 错 token / 错 Origin 四象限的放行拒绝
  - Aggregator：per-project 统计正确性（多项目混合流）/ `entry.project` 修复验证 / `getState()` 契约回归（证 TUI 冻结）
  - 端口避让：mock 端口占用场景
- **集成**：真起 HTTP——`GET /` 回 HTML（含 nosniff/CSP 头）、`/api/sessions` 回白名单字段（断言无 `proc` 键）、SSE 首连 `hello`、错 token 401、写入日志后 500ms 内收到 `log` 事件
- **前端**：不写单测（原生 JS 无构建链），API 契约测试锁字段 + 真机人工验收
- **门禁**：标准 `npm run lint` + `npm run build` + `npm test`；不改工具清单 → 不跑 build-matrix；不涉 `.claude/rules` → 无版本 bump 硬门禁（变更进 CHANGELOG `[Unreleased]`）

## 10. 验收标准（真机）

1. server 启动 → `~/.godot-mcp/web-gui.json` 有登记；`dashboard --web` 打开浏览器四面板有数据
2. `run_project` 起游戏 → 会话面板 1s 内出现 running 条目；关窗后变 exited 且输出快照行数可见
3. 双 AI 客户端双 server → 两端口两面板，数据互不串（分桶批的姊妹场景）
4. 错 token 访问 401、伪造 Origin 的 SSE 被拒
5. TUI `dashboard` 行为回归不变

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

## 13. 开放问题

无——控制按钮（范围外）、性能面板语义（工具调用时序，§4.4 澄清）、远程访问（范围外）均已定案。
