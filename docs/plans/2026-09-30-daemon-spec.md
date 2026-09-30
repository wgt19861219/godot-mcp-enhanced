# 常驻守护进程(daemon)专项 spec

- **日期**:2026-09-30
- **状态**:**已转 plan(2026-09-30 用户定案 D1-D4 全采纳推荐)**——实施计划 `docs/plans/2026-09-30-daemon-plan.md`(3 批 14 任务:批 A daemon-core / 批 B daemon-lifecycle / 批 C daemon-frontend-accept,含 spike 结论回填机制);此前经两轮第三方审查全数处置(第 1 轮 NO-GO→3 Blocking + 5 Nit,报告 `docs/reviews/2026-09-30-daemon-spec.md`;第 2 轮 GO WITH CHANGES→2 Major + 8 minor + 5 nit,报告 `docs/reviews/2026-09-30-daemon-spec-round2.md`;处置记录见文末 §8)
- **来源**:实例管理批(commit `8dfc87c0`)定范围记录——用户需求"面板要能拉起或重启服务,没有管理功能要这个面板干什么"→「①实例管理本批落地,②常驻守护进程专项后续(新会话开 spec)」。本文即 ②。
- **仓库根**:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced`(正文内文件引用为仓库内相对路径,均实测于 2026-09-30)

---

## 0. 背景与动机

### 现状(2026-09-30 实测)

- MCP server 唯一入口是 **stdio**:`src/GodotServer.ts:543-544` 构造 `StdioServerTransport` 并 `connect`。server 由 AI 客户端(ZCode/Claude Code 等)作为子进程拉起,**生命周期与客户端会话绑死**。
- Web GUI 面板**内嵌于 server 进程**(`src/GodotServer.ts:577` 构造 `WebGuiServer`,`:655` start)——客户端会话结束,面板随之死亡。
- 实例管理批已交付 `GET /api/instances` + `POST /api/instances/restart`(registry 三重校验 pid → `killPidTree`;自重启走 `onSelfRestart` 注入,`src/web-gui/server.ts:81`)。
- 实例登记:per-pid 文件 `~/.godot-mcp/web-gui/<pid>.json` + 机器级共享 token(`src/web-gui/registry.ts:17-35`),端口 9550 起、20 次尝试(`src/web-gui/server.ts:101-102` `DEFAULT_PORT_START`/`PORT_ATTEMPTS`),前端跨实例自愈扫描 9550..9569(html.ts recoverPanel,CSP connect-src 端口段与之同步)。

### 痛点(实例管理批收口时明确遗留)

| # | 痛点 | 根因 |
|---|------|------|
| P1 | **面板不能常驻**:想随时看面板,必须有 AI 客户端会话开着 | 面板内嵌于 stdio server 进程,进程随客户端生灭 |
| P2 | **杀实例后客户端不重连**:面板"重启他实例"后,对应客户端不会自动拉起新 server | stdio 父子进程关系——客户端是父,服务端无法左右客户端的重连行为。审查文档 `docs/reviews/2026-09-30-web-gui-instance-management.md` 实测:ZCode 90 秒内不自动重连 |
| P3 | **面板不能从零拉起服务**:实例区只能列/杀已存在实例 | 无常驻进程可承此操作;stdio server 若无客户端持有 stdin/stdout,拉起了也没有会话入口 |

三个痛点的共同解法:**让服务脱离客户端会话常驻,并把客户端连接方式从"父子 stdio"改为"网络连接"**——这正是"常驻守护进程"专项的范围。

### 关键探索事实(设计依据,均已实测)

| # | 事实 | 出处 |
|---|------|------|
| F1 | **ZCode 原生支持 `type: "http"` 的 MCP server 配置**(远程 URL + 自定义 headers 实证) | `C:\Users\wgt\.zcode\cli\config.json` mcp.servers 实测存在 http 类型条目(http 与 stdio 并存) |
| F2 | SDK 2.x(`@modelcontextprotocol/server` 2.0)导出 `WebStandardStreamableHTTPServerTransport` / `PerRequestHTTPServerTransport` / `InMemoryTransport`——HTTP MCP server 端点技术可行 | `node -e "import('@modelcontextprotocol/server')..."` 实测导出清单 |
| F3 | `GodotServer` 的 McpServer 实例与 transport 是后挂的(`run()` 内 new StdioServerTransport → `server.connect(transport)`)——换 transport 是参数化问题,不是架构问题(所在方法名为 run() 非 connect(),connect 是 SDK 侧调用——审查 N-4 修正) | `src/GodotServer.ts:543-544` |
| F4 | `WebGuiServer` 全部依赖走**构造器注入**(getSessions/stopSession/projects/settings/onSelfRestart 等十余个注入点,零模块级 setter)——daemon 进程内持有真 GodotServer 实例时,面板数据源真实可用,注入链原样成立 | `src/web-gui/server.ts:38-84` |
| F5 | registry 已有 version 字段向后兼容先例(旧文件无字段 → 前端"早期实例");加 kind 字段同模式 | `src/web-gui/registry.ts:17-28`(version 可选 + parse 不校验) |
| F6 | `killPidTree` 已在 processState(Windows `taskkill /F /T`),实例管理批 restart 端点已接线 | `src/GodotServer.ts:866`(ps.killPidTree) |
| F7 | `GodotServer` 是进程级单例架构:**模块级 setter 全局状态**(processState/logger/progress/game-bridge 回调等,AGENTS.md 记"约 23 个";第 2 轮审查 grep 实测 **26 个**——记录偏低,结论方向不变)——同一进程内构造多个 GodotServer 会互踩,**进程内多实例不可行** | AGENTS.md 定规 + 第 2 轮审查实测 |
| F8 | CLI 子命令路由现有:setup/configure/skills/doctor/init/dashboard/qa/web/gif/install/uninstall;bin 入口 `godot-mcp-enhanced`(`build/index.js`)+ `godot-mcp-dashboard` | `src/cli/router.ts:33-98` + package.json bin |
| F9 | `web` 子命令已被"Web 试玩闭环"占用(export→serve Godot 游戏),`dashboard --web` 是打开面板——**daemon 子命令命名不冲突,但 spec 必须写清三者区分**防误用 | `src/cli/web.ts:1-6` 头注释 + `src/web-gui/open.ts` |
| F10 | InstanceManager(`~/.godot-mcp/instances/`)管理的是 **Godot 游戏/编辑器实例**,web-gui registry(`~/.godot-mcp/web-gui/`)管理的是 **MCP server 实例**——两套注册表并存,daemon 只涉后者 | `src/core/instance-manager.ts:1-14` 头注释 |
| F11 | 前端跨实例自愈已存在:面板死后按 9550..9569 扫描 /api/health 迁移到活实例(html.ts recoverPanel);CSP connect-src 端口段与之同步——**daemon respawn 换端口的场景已有兜底** | `src/web-gui/server.ts:111-112` CSP 注释 |
| F12 | ZCode http 配置支持自定义 headers(Authorization 实证)——/mcp 端点若要求 token,客户端配置层可行 | 同 F1 |
| F13 | index.ts 启动链已有 env 安全门/H-08/C-08/设置重放(`applyUserSettingsAtStartup`)等,daemon 入口应复用同一启动序而非另写一套 | `src/index.ts:25-80`(`startMcpServer` 起;处置时 grep 勘误,初稿 38-80 有偏) |

## 0.5 仓库级约束核查结论(不是缺省,是 grep 过的"不需要/需要")

| 约束 | 核查结论 | 证据 |
|------|---------|------|
| core→tools 分层(eslint 门禁) | **需要关注**:daemon 入口属新增组合层,放 `src/daemon/` 或 `src/cli/`,import core/web-gui 合法;**不得**让 `src/core/**` import daemon | eslint no-restricted-imports 规则现状 |
| 禁止新增模块级 setter | **硬约束**:daemon 的依赖注入沿用 WebGuiServer 构造器注入模式(F4 同款) | AGENTS.md「分层约束与全局状态规则」 |
| CLI 子命令复用会话链 | daemon start/stop 不起 Godot 游戏/bridge,不复用 bridge-session;直接 import core/web-gui 合法 | AGENTS.md 同上 |
| `.claude/rules/` ↔ `rule-templates.ts` 双副本 | **本 spec 不触发**(不触碰两者,grep 证实无 daemon 相关段)→ 无版本 bump 义务、无 check:rules-sync 义务 | grep |
| capability-matrix | daemon 是 CLI 子命令 + transport 变体,**不改工具清单** → 不需 build-matrix;若最终在面板加"拉起实例"按钮,也不改工具定义 | matrix 由工具定义采集的机制 |
| 审计 | **需要**:daemon 生命周期事件(start/stop/restart/拒绝连接)落机器级审计,对齐实例管理批 `web-gui:instances` 先例 | `src/web-gui/server.ts` 审计接线 |
| 安全(env 门) | **需要**:daemon 入口复用 index.ts 的 dangerousBypassFlags 检查与设置重放——建议把启动序抽成共享函数,stdio 与 daemon 两入口同源 | F13 |
| budget/tool-groups 检查 | 不受影响(不加 MCP 工具) | 机制 |
| 覆盖率阈值 | **需要**:新增约 6 文件须配套用例,CI 阈值 statements 76%/branches 67%/functions 80%/lines 77% 强制(审查 N-5 补列) | vitest.config.ts |
| 测试落位惯例 | **需要**:web-gui 系测试在 `test/web-gui/` 子目录(实例管理批先例);daemon CLI/入口测试按文件归属就近(审查 N-5 补列) | 既有 test/ 目录结构 |
| 审计 caller 维度 | **需要**:daemon 生命周期审计的 caller 需区分 `daemon-cli` / `panel` 等来源,对齐既有 caller 语义(第 2 轮 m-5) | `src/core/audit-log.ts` caller 惯例 |
| exit code 注册表 | **需要**:新增 CLI 退出路径须过 `test/p2-exit-path-repair.test.ts` 的注册表扫描,daemon 子命令 exit code 语义要登记(第 2 轮 m-6) | `test/p2-exit-path-repair.test.ts` |

---

## 1. 目标与非目标

### 目标

- **G1 面板常驻**:`daemon start` 后,Web GUI 不依赖任何 AI 客户端会话,7×24 可访问;实例区照常列出全部注册实例(stdio + daemon 混合)。
- **G2 服务可拉起**:`godot-mcp-enhanced daemon start` 从零拉起常驻服务;`daemon stop`/`daemon status` 完整生命周期管理。
- **G3 重启可恢复**:daemon 实例被重启后,以受控交接顶上且**端口不漂移**(§3.7 不变式,审查 B-1),HTTP 客户端重连即恢复工具调用——P2 在 daemon 实例上根治。
- **G4 MCP over HTTP**:daemon 提供 `/mcp` streamable HTTP 端点,AI 客户端以 `type:"http"` 配置直连(F1/F2 实证可行)。
- **G5 stdio 入口零回归**:现有客户端 stdio 配置不改动、不受影响;两类实例并存。

### 非目标(明确不做,防范围蔓延)

- **N1** 多客户端会话隔离(per-session worker 代理)——§2 方案 C,留作演进;首期单会话约束(§3.6)。
- **N2** 开机自启/服务安装(Windows Service/注册表/计划任务)。
- **N3** daemon 崩溃 watchdog 自愈(异常退出后需手动 `daemon start`;诚实边界 §6)。
- **N4** 不改 InstanceManager(Godot 游戏实例注册表,F10)。
- **N5** 客户端适配器(setup/configure)生成 http 类型配置——后续小批;首期文档手把手给配置片段。
- **N6** 不做远程监听:全部端点绑 127.0.0.1(对齐 web-gui 现状)。

---

## 2. 方案选型

### 方案 A(推荐,首期):daemon = 常驻进程,内嵌单 GodotServer + HTTP MCP 端点 + 常驻面板

```
godot-mcp-enhanced daemon start
  └─ detached 子进程(daemon)
      ├─ GodotServer 实例(全能力,唯一)
      │    └─ McpServer ── 挂 WebStandardStreamableHTTPServerTransport → /mcp 端点
      ├─ WebGuiServer(常驻面板,注入链同 stdio 模式,数据源真实)
      └─ registry 登记(kind:"daemon")
```

- transport 从 stdio 换成 HTTP 是 F3 所示的参数化改动;GodotServer 复用度 100%(同一进程同一实例)。
- 面板即 daemon 的面板:进程内有真 GodotServer,`getSessions`/`projects`/`settings` 全部注入真实数据源(F4)。
- 解决 P1(面板常驻)、P3(daemon start 拉起)、P2(daemon 实例上 HTTP 客户端可重连)。
- 代价:**单实例共享**——同一时刻多个 HTTP 客户端连 /mcp 会共享同一 GodotServer 状态(bridge/editor 连接、调度队列)。首期以"单会话独占"约束回避(§3.6),N1 留演进。

### 方案 B(否决):daemon = 纯管理面(仅常驻面板 + 拉起/重启他实例),不提供 MCP 端点

- 面板数据源要**跨进程化**:现有面板直读本进程 GodotServer 内存态(sessions/projects/settings),daemon 无 server 实例则面板大量端点 503 或需新建跨进程聚合协议——隐性成本远超表面。
- "拉起服务"无落点:stdio server 无客户端持有即无意义;不提供 /mcp 则 P2 无解。
- 仅解决 P1,ROI 最低。

### 方案 C(演进预留,非本批):daemon = HTTP 网关 + per-session stdio worker 代理

```
daemon(常驻)
  ├─ /mcp 端点:每个新 MCP 会话(Initialize)spawn 一个 build/index.js stdio worker
  │             daemon 在 HTTP ↔ stdio 间双向转发 JSON-RPC(sessionId ↔ worker pid 映射)
  └─ 面板:常驻 + 聚合 worker 清单(worker 关内嵌面板防端口堆积)
```

- 隔离完美(每会话独立进程,根治共享互踩),P2 解决得最彻底(worker 重启对客户端只是连接闪断)。
- 代价:转发层工程量(session 管理、SSE 流转发、DELETE 语义、notification 透传、worker 崩溃回收)显著高于 A;且 A 的全部产出(registry kind、daemon CLI、面板常驻、respawn 机制)被 C 原样继承,**A→C 是增量演进不需推翻**。

**裁定:首期 A,C 作为后续演进路径在 §6 记录。**

---

## 3. 设计(方案 A)

### 3.1 进程模型与生命周期

```
┌─ CLI(godot-mcp-enhanced daemon start)────── 用户终端,退出即走 ─┐
│  1. 单例检测:registry 内已有活 daemon(kind=daemon 且 pid 探活)→ 拒绝并打印现状
│  2. spawn detached 子进程(node build/daemon/main.js,源 src/daemon/main.ts——第 2 轮 m-3 路径统一)
│     stdout/stderr → 日志文件 fd、stdin ignore(第 2 轮 m-1)
│  3. 轮询 registry 新登记(pid+kind=daemon)确认就绪——不用无鉴权 /api/health(第 2 轮 M-2:
│     它报不出 pid,分不清"我的新实例"与"别人的实例")→ 打印面板 URL + /mcp URL + token 获取方式(n-4)
└──────────────────────────────────────────────────────────────────┘
        ↓ detached(unref)
┌─ daemon 进程 ─────────────────────────────────────────────────────┐
│  1. 启动序复用 index.ts 同源链(env 安全门 → applyUserSettingsAtStartup)│
│  2. 构造 GodotServer(daemon 模式:不 connect stdio)                    │
│  3. 起 WebGuiServer(端口 9550 起,registry 登记 kind:"daemon")          │
│  4. /mcp 端点挂 WebStandardStreamableHTTPServerTransport               │
│  5. 退出钩子与信号处理(POSIX):有序 close(跨进程停止走 /api/shutdown,     │
│     Windows detached 进程收不到信号——审查 B-3,见下方 daemon stop)         │
└──────────────────────────────────────────────────────────────────────┘
```

- `daemon stop`(**审查 B-3:Windows 无跨进程优雅信号**——`kill(pid,'SIGTERM')` 即 TerminateProcess 不跑清理链,detached 进程亦收不到 SIGINT;本仓 `src/web-gui/server.ts:554` 注释即先例):主路走 **HTTP 关停端点 `POST /api/shutdown`**(共享 token 鉴权,服务端执行 onSelfRestart 同款有序 close 链);SIGTERM 信号仅作非 Windows 辅助;两者超时(默认 ~5s)兜底 `killPidTree`(F6)。
- `daemon status`:registry 读清单,标注 kind/端口/存活,exit code 0=有活 daemon(仅类比 qa.ts 的"0=好态"惯例,语义不同——审查 N-4 修正)。

### 3.2 HTTP 端点拓扑:单端口双路由

**daemon 的面板与 /mcp 共用一个 HTTP 监听**(127.0.0.1,端口 9550 起递增):

| 路由 | 用途 | 鉴权 |
|------|------|------|
| `/`、`/api/*`、`/assets/*` | Web GUI 面板(现状不动) | 共享 token(cookie,现状) |
| `/mcp`(POST/GET/DELETE) | MCP streamable HTTP | 共享 token(仅 Authorization header,§3.5) |
| `/api/shutdown`(POST) | 受控重启/关停指令(§3.7 T2 通道;`?restart=1` 走受控交接,缺省走有序 close) | 共享 token;Origin 规则同面板 API(同端口/无 Origin 放行,第 2 轮 M-1) |

单端口理由:①前端跨实例自愈按"实例=端口"扫描(F11),一个 daemon 占一个端口语义自洽;②registry 一个实例一条登记,面板/ MCP 端点同 pid 同生命周期;③少一个端口协商面。

实现归属:`WebGuiServer` 已有 HTTP 基建(listen/路由/CSP),但 **/mcp 不属于 web-gui 子系统**——web-gui 不 import MCP SDK。**注入链(审查 N-3 修正)**:WebGuiServer 在 `GodotServer.run()` 内部构造(`src/GodotServer.ts:577-655`),daemon 入口无法绕过 GodotServer 直接注入——正确通道是 **GodotServer options 加 `mcpHandler?: (req, res) => void` 透传字段**,`run()` 构造 WebGuiServer 时下传(对齐既有十余个注入点的同链模式,不复制注入点);缺席不挂 /mcp 路由(404,503 不适用——路由不存在)。

### 3.3 GodotServer 改动:transport 参数化(最小侵入)

- 现 `run()`(GodotServer.ts:543-544)内联 `new StdioServerTransport()` → 拆出 `connectTransport(transport: Transport)`,stdio 路径传 stdio 实例调用它;daemon 传 HTTP transport(方法名审查 N-4 修正)。
- daemon **不注册** `process.stdin.on('end')` 自杀钩子(`src/index.ts:165` 现状:stdio server 靠它检测客户端断连;detached 进程 stdin 立即 end → daemon 启动即自杀——第 2 轮 m-1)。daemon 的退出通道只有:`/api/shutdown` 端点、POSIX 信号(非 Windows)、`killPidTree` 兜底。
- 启动序共享段**带选项裁剪**(第 2 轮 m-2):`startMcpServer` 内还内含自动拉 Dashboard TUI(`src/index.ts:167-180`)与 self-update 检查(`:190-198`)——daemon 进程不要这两项(无终端可弹 TUI;self-update 属 stdio 会话行为)。共享段签名形如 `runStartupSequence({ dashboard, selfUpdate })`,stdio 入口全 true,daemon 全 false。
- daemon 模式下 `GODOT_MCP_WEB_GUI` 语义:面板**必起**(daemon 的存在意义),env=0 时 daemon start 直接拒绝("daemon 模式依赖面板端口,请去掉 GODOT_MCP_WEB_GUI=0")——不允许起一个无面板的哑 daemon(无面板则 registry 不登记,实例管理失明)。
- stdio 模式行为完全不变。

### 3.4 registry 扩展:kind 字段

`WebGuiRegistration` 加可选 `kind?: 'stdio' | 'daemon'`(F5 同款向后兼容:旧文件无字段 → 前端按 stdio 显示):

- daemon 登记写 `kind:"daemon"`;`GET /api/instances` 透传;前端实例区加徽标(daemon/stdio/早期)。
- 单例检测 = registry 内 kind=daemon 且探活——**登记即真相源**,不另建 pid 文件(避免第二份状态漂移)。
- **检测双层执行**(审查 B-2):①CLI 壳 `daemon start` 启动前查(用户友好像,给出已运行实例信息);②daemon 进程入口自身再查(防绕过 CLI 直跑 `node build/daemon/main.js` 起多实例)。**respawn 豁免**:入口检测遇 `--respawn-of=<旧pid>` → 放行(旧 pid 登记在场 = §3.7 交接窗口;旧 pid 已死也放行——交接尾段旧进程可能已 exit)。
- **跨实例强杀 daemon**(A 面板 killPidTree B daemon)语义:允许,对齐 stdio 他实例——但强杀不走交接序列、close 链不跑、无人 respawn,面板文案指引改用受控重启(T1/T2,§3.7)。

### 3.5 /mcp 鉴权:强制共享 token

- 复用 `getOrCreateSharedToken()` 的机器级 token(`src/web-gui/registry.ts:51`),要求 `/mcp` 请求带 `Authorization: Bearer <token>`(F12:ZCode http 配置 headers 实证可行)。
- **强制而非可选**:/mcp 背后是完整工具面(任意 GDScript 执行、文件写、进程管理),敏感度高于面板只读面;同机任意本地进程都能连 127.0.0.1,无鉴权不可接受。401 响应不带 token 值;失败落审计。
- **仅认 Authorization header,cookie 与 query token 一并拒收**(第 1 轮 N-2 + 第 2 轮 n-2):面板与 /mcp 同源同端口,浏览器同源 fetch 自动带 cookie——若 /mcp 顺手复用面板 cookie 校验,DNS rebinding 恶意页面即可凭 cookie 获得完整工具面;且 web-gui 现有 `extractToken` 优先级是 query > header > cookie,URL 里的 token 会进代理日志/浏览器历史,泄露面更大。实现为**独立取值分支(只查 Authorization header),不复用 extractToken**。
- **Host 头白名单校验**(第 1 轮 N-2 提出,第 2 轮 n-1 修正口径):SDK transport 的 rebinding 相关**选项已全部 `@deprecated`,官方口径 "Use external middleware"**(`index.d.mts:502/508/514` 实测)——实现须按**中间件形式**接线,SDK 导出的 `validateHostHeader` / `localhostAllowedHostnames`(`index.d.mts:166/170`)可作底层构件,不依赖 deprecated 选项。
- token 获取途径:`daemon start` 打印(打码,对齐 `--show-token` 先例)/`daemon status --show-token` 全量。
- daemon respawn 时 token 不变(机器级共享 token 的既有设计,cookie/header 均存活)。

### 3.6 单会话独占(首期互踩回避)

- 同一时刻 /mcp 仅服务**一个 MCP 会话**(以 SDK transport 的 sessionId/Initialize 语义判定,实现批核实 SDK 2.x 的会话生命周期细节):第二个 Initialize 请求 → 返回明确错误信息(指引另起 daemon 或连 stdio 实例)。
- 明确拒绝优于隐式互踩(F7:进程级单例状态,两客户端并发操作不同项目必互踩)。
- 拒绝形态(第 2 轮 m-8):HTTP 层**明确错误响应**(4xx + 可读 message,指引另起 daemon 或连 stdio 实例),不静默排队;具体响应形态实现批随 R3(SDK 会话语义核实)一并定。
- 该约束写进 /mcp 错误响应与文档,面板实例区对 daemon 实例显示"会话占用中/空闲"。

### 3.7 重启语义:端口不漂移的受控交接(第 1 轮 B-1/B-2 + 第 2 轮 M-1/M-2 处置后重写)

**不变式 1:daemon 的端口跨重启不漂移**——MCP 客户端配置的是静态 URL,不似面板浏览器有 recoverPanel 跨端口自愈(F11);该兜底**只救面板浏览器,不救 MCP 客户端**。端口稳定优先于交接期间的秒级可用性。
**不变式 2:任意时刻至多一个活 daemon**——失败回滚路径也必须维持(第 2 轮 M-2:"双活"违反 §3.4 单例不变量)。

**触发通道(第 2 轮 M-1 收敛为两条,均由 daemon 自身执行)**:

- **T1 面板自重启**:在 daemon 自己的面板上点"重启本实例"(isSelf 路径)——Origin 同端口,`originAllowed` 天然放行(实测 `src/web-gui/server.ts:299-307`:无 Origin 或 Origin=自身端口放行)。
- **T2 CLI**:`godot-mcp-enhanced daemon restart` → CLI 直连 `POST http://127.0.0.1:<port>/api/shutdown?restart=1`(CLI 请求无 Origin 头,同款放行;token 鉴权照走)。
- **跨实例面板重启 daemon(A 面板重启 B daemon)维持 403 现状**——Origin 跨端口被 `originAllowed` 拒(第 2 轮双实例实测 403),同源闸门是有意设计,**不新增"任意 loopback Origin"特例**;A 面板对 daemon 实例的重启按钮改为指引文案("在 daemon 自身面板或 CLI restart")。跨实例 `killPidTree` 强杀 daemon 仍可用(对齐 stdio 他实例语义),但强杀不走交接序列、close 链不跑、**无人 respawn**——文案诚实告知需 `daemon start` 重拉,推荐走 T1/T2。

受控交接序列(daemon 收到 restart 指令后自执行):

1. **先关闭 HTTP listener(不 exit,进程仍在)**,端口释放(第 2 轮探针实测:旧 holder 只关 listener 不退出时,同端口可立即被新进程绑定——OS 层前提成立);
2. detached-spawn 新 daemon(目标 `build/daemon/main.js`),**显式传 `--port=<旧端口>` 且 strictPort 语义:该端口绑不上(EADDRINUSE)即启动失败,不走 `server.ts:194-208` 的 20 次静默顺延**(第 2 轮 M-2:顺延会静默漂移到 9551 且"成功登记",被步骤 3 误读为交接成功)。新 daemon 以 `--respawn-of=<旧pid>` 豁免单例检测(§3.4);
3. **交接成功判定(第 2 轮 M-2 收紧):registry 出现新登记且 `port === 旧端口` 且 `kind === 'daemon'`**——按登记文件的 pid+port 比对,**不用无鉴权的 `/api/health` 探测**(它报不出 pid,分不清"我的新实例"与"别人的实例")→ 旧进程**删除自身登记**(删前校验登记文件内容 pid+startedAt 与自身一致,防 PID 复用误删他人登记——第 2 轮 m-7)→ 有序 close → exit;
4. **失败回滚(维持不变式 2)**:新实例未起/未在限时报到/报到了但端口不符 → 旧进程**先 `killPidTree` 新实例并轮询确认其登记消失**,再重新 listen 原端口,面板/CLI 返回失败详情——不做到不了位的半交接,不留双活。

- 交接窗口(秒级)内面板与 /mcp 同时拒连(连接拒绝 ECONNREFUSED,非 5xx),客户端表现为一次连接闪断,HTTP 客户端重试即恢复——这正是 G3 主张;"交接中拒连"与"端口上无 daemon"表现相同、均由客户端重试收敛,验收不作区分(第 2 轮 n-5)。
- 双登记窗口处置:步骤 3 旧进程删自身登记前,registry 短暂存在两条 daemon 登记——前端实例区与 `daemon status` 对旧条目显示"交接中"(依据 `--respawn-of` 关联,非错误态)。
- stdio 实例的重启路径(现状)不动——文案继续诚实告知"stdio 客户端需手动重连"。

### 3.8 CLI 子命令

```
godot-mcp-enhanced daemon start  [--open]     # 拉起;--open 顺带开浏览器(对齐 dashboard --web)
godot-mcp-enhanced daemon stop   [--force]    # 主路 POST /api/shutdown 有序停(Windows 无跨进程信号,审查 B-3);--force 直接 killPidTree
godot-mcp-enhanced daemon status [--show-token]
godot-mcp-enhanced daemon restart             # 活 daemon 走 T2 受控交接(POST /api/shutdown?restart=1,§3.7);死 daemon 等价 start
```

- **URL 打印义务**(第 2 轮 n-4):`daemon start` / `daemon restart` / respawn 完成后,CLI 与 daemon 日志都要打印 `/mcp` 完整 URL 与 token 获取方式(`daemon status --show-token` 或面板设置页)——用户找不到连接地址等于功能不存在。
- 子命令名 `daemon` 与 `web`(试玩闭环,F9)、`dashboard`(TUI/--web 打开面板)不冲突;`daemon --help` 文案写清三者区别。
- router.ts 挂 `case 'daemon'`;实现文件 `src/cli/daemon.ts`(平铺单文件起步,符合「src 目录分组规则」;daemon 进程入口独立 `src/daemon/main.ts`,与 CLI 壳分离——CLI 壳薄(组装参数+spawn),daemon 入口厚(进程内组装),职责不同不混文件;两者合计若超两文件再建 `src/daemon/` 目录)。

### 3.9 安全清单

- 全端点 127.0.0.1(N6);/mcp 强制 token(§3.5);token 0o600 + Windows icacls(既有惯例)。
- daemon 启动序复用 dangerousBypassFlags 检查(H-08)与设置重放(F13)——抽共享启动函数防两入口漂移。
- 生命周期事件审计:daemon start/stop/restart/respawn/401 拒绝 → 机器级审计(**批 A/B 实施裁定:caller 统一 `web-gui:daemon`**——shutdown/重启非 instance 操作,复用 `web-gui:instances` 反而归因失真;对齐 ToolDispatcher 的 `web-gui:<子系统>` 通道归一惯例,/mcp 侧为 `daemon:mcp`,来源 daemon-cli/panel 落 details.caller)。
- 日志:detached 进程 stdout/stderr 落 `~/.godot-mcp/logs/daemon-<pid>.log`(对齐 resolveLogDir 惯例),防 Windows detached 输出悬空。

### 3.10 daemon 的 env 与配置契约(第 2 轮 m-4 补设)

**问题**:daemon 由用户终端拉起(非 AI 客户端 spawn),拿不到客户端注入的 `GODOT_PATH`/`ALLOWED_PROJECT_PATHS`/profile——若终端环境也无这些 env,路径白名单落 deny-by-default 仅 cwd,面板"添加项目"(`src/web-gui/server.ts:695`)与非 cwd 项目的 run/edit(`:769`)全部 403,面板形同虚设。

**契约:daemon 的配置真相源 = GUI 设置面板持久化的 `~/.godot-mcp/settings.json`**(2026-09-29 设置批既有能力:Godot 路径/版本 + 项目白名单,保存即热生效改 env):

1. daemon 启动走同一 `applyUserSettingsAtStartup()` 重放——settings.json 有配置则 daemon 直接可用,**GUI 设置面板就是 daemon 的配置界面**(在 daemon 自己的面板上改设置,保存即热生效,无需重启 daemon)。
2. 终端 env(用户 shell 里有 `GODOT_PATH` 等)仍按设置批既有优先级参与(GUI 设置优先于注入 env,清除恢复启动快照——daemon 场景的"注入 env"即终端 env,语义不变)。
3. **首启预检**:settings.json 与终端 env 均无有效 Godot 路径/白名单 → daemon 照常起(面板可访问、设置页可配),但 CLI 输出与面板显著提示"未配置 Godot 路径/项目白名单,请在本面板设置页配置"——V1 验收含此提示在场性。
4. `daemon start` **不加** `--godot-path`/`--projects` 参数绕过(配置入口唯一:设置面板;避免两条配置通道漂移)。

---

## 4. 改动面清单(文件级,plan 批细化)

| 文件 | 改动 | 性质 |
|------|------|------|
| `src/daemon/main.ts`(新) | daemon 进程入口:启动序(复用共享段)、GodotServer(daemon 模式)、WebGuiServer、/mcp transport、信号处理 | 新增 |
| `src/cli/daemon.ts`(新) | start/stop/status/restart CLI 壳:单例检测、detached spawn、就绪轮询(registry 登记比对,非 /api/health——M-2)、打印 /mcp URL 与 token 获取方式(n-4) | 新增 |
| `src/cli/router.ts` | `case 'daemon'` | 小改 |
| `src/GodotServer.ts` | `run()` 内 transport 构造参数化(connectTransport);daemon 模式旗标(面板必起校验);`mcpHandler` 透传字段(→ WebGuiServer 挂 /mcp 路由,审查 N-3) | 中改 |
| `src/web-gui/server.ts` | mcpHandler 路由挂载注入点;`POST /api/shutdown`(受控重启/关停通道,§3.7);`start()` 加 strictPort 选项(指定端口 EADDRINUSE 即败,不静默顺延——第 2 轮 M-2) | 中改 |
| `src/web-gui/registry.ts` | WebGuiRegistration.kind 可选字段 + 读写 | 小改 |
| `src/web-gui/html.ts` | 实例区 kind 徽标;daemon 会话占用/交接中状态展示;跨实例对 daemon 的重启按钮改 T1/T2 指引文案(§3.7,第 2 轮 M-1);**CSP 锚第六次重算**(改 INDEX_HTML 内联脚本必触发,`test/web-gui/server-http.test.ts` 锚值+独立重算双通道互证——第 1 轮 N-1) | 中改 |
| `src/index.ts` | 启动序抽共享段(供 daemon 入口复用) | 中改 |
| `test/`(若干) | daemon CLI 单测(mock spawn)、registry kind 读写、restart daemon 分支、/mcp 鉴权 401、connectTransport 参数化、html 契约 | 新增 |
| `CHANGELOG.md` | [Unreleased] 条目 | 惯例 |
| `README.md`/docs 使用指南 | daemon 章节 + ZCode/Claude Code http 配置片段 + 三命令区分(F9) | 文档 |

明确不触碰:`.claude/rules/`、`src/tools/rule-templates.ts`(§0.5 已核查)、`src/core/instance-manager.ts`、capability-matrix、`addons/`。

---

## 5. 验收标准

**自动化(每批全绿门禁)**:`npm run lint` 0 + `npm run build` 通过 + `npm test` 全绿(新增用例覆盖 §4 测试行)。

**功能验收(A=自动化可测,R=真机手动)**:

| # | 验收项 | 方式 |
|---|--------|------|
| V1 | `daemon start` → 面板 URL 可访问、registry 出现 kind:"daemon" 登记、/api/instances 列出它;未配置 Godot 路径/白名单时 CLI 与面板显著提示在场(§3.10),在 daemon 面板设置页配置后**热生效**(项目 run/edit 不再 403) | R |
| V2 | /mcp 端点:带 token 的 MCP 客户端(SDK client 脚本或 `npm run inspector`)initialize → tools/list → 任一工具调用成功;无 token 401 + 审计落盘 | A(脚本)+R |
| V3 | **ZCode 以 `type:"http"` 配置连 daemon → 工具调用成功**(F1 的 localhost 落地验证) | R |
| V4 | 受控重启 daemon(触发=T1 daemon 自身面板重启 或 T2 CLI restart,§3.7)→ **端口不漂移**(登记 port 比对)、新 daemon 登记顶上、V3 的 ZCode 重连后工具调用恢复;另测失败注入:指定端口被占(EADDRINUSE)→ 回滚(杀新实例+确认登记消失+旧进程重 listen),**无双活** | R |
| V5 | `daemon stop` → 进程干净退出、registry 惰性清、无孤儿(tasklist 核对);**daemon 日志含 close 链完成证据**(强杀路径过不了此验收——审查 B-3) | R |
| V6 | 单会话独占:第二个 MCP 客户端 Initialize 被明确拒绝 | A |
| V7 | stdio 回归:smoke 过 + 既有 stdio 全量测试绿(自动化;"某次会话工具可用"不可作可复现验收,该措辞已删——审查 N-4) | A |
| V8 | 二次 `daemon start`(已有活 daemon)→ 拒绝并打印现状 | A |

**流程验收**:plan 落地后第三方审查文档(`docs/reviews/`)+ memory 登记(AGENTS.md 强制流程)。

---

## 6. 风险与诚实边界

| # | 风险/边界 | 处置 |
|---|----------|------|
| R1 | `WebStandardStreamableHTTPServerTransport` 是 Web Standard Request/Response 形态,与 Node http Server 的 wiring 需适配层(Node 18+ 全局 Request/Response 可用,但细节如流式 SSE 响应需实现批核实;备选 `PerRequestHTTPServerTransport` 形态待比选) | plan 批第一项任务:写最小 spike 验证 wiring,再定稿 §3.2 |
| R2 | ZCode http 客户端对 **localhost** http MCP 的行为——F1 实证的是**远程** http 条目;本机 config 另有 `http://127.0.0.1:<port>/mcp` 形态条目但 `enabled:false` 且无 headers,**不足为证**(第 2 轮 n-3 精确化) | V3 真机验收;失败则 daemon 价值降级为"面板常驻+管理",P2 回避路径记录在案 |
| R3 | SDK 2.x streamable transport 的会话生命周期(sessionId 生成/过期/DELETE 语义)细节未核实 | plan 批核实;影响 §3.6 单会话判定的实现位置 |
| R4 | Windows detached spawn:stdio 悬空(已处置:日志重定向)、父子 Job 对象级联杀死风险(spawn 时 `detached:true` + unref;真机 V5 核对终端关闭后 daemon 存活) | V5 |
| R5 | respawn 交接时序:listener 先关再 spawn 的窗口内面板与 /mcp 双拒连(秒级);回滚路径(重新 listen)失败的理论残留 | §3.7 受控交接以"端口不漂移"为不变式设计(审查 B-1:跨端口自愈只救面板不救 MCP 客户端);V4 真机验证交接与回滚 |
| R6 | daemon 崩溃(异常退出)不自愈(N3) | 诚实边界:面板也死(面板在 daemon 进程内)→ 需 `daemon start` 手动拉起;watchdog/双进程 supervisor 留待用户按使用体感决定是否立项 |
| R7 | 单 GodotServer 的既有全局状态在 daemon 长生命周期下的累积(长跑内存/连接态) | daemon 模式等价于一个很长命的 stdio server;现有 unhandledRejection 防线与 close 链复用;长跑观察项如实记录 |
| R8 | 与"早期实例"共存:老版本 stdio 实例无 kind 字段 → 前端按"早期实例"显示(既有语义,不冲突) | 无需处置,F5 兼容模式 |

**演进路径(非本批)**:方案 C(per-session worker 代理)在 A 落地后按需立项;A 的 registry/CLI/面板/respawn 全部被继承。

---

## 7. 用户决策请求(转 plan 前拍板)

| # | 决策点 | 选项 | 推荐 |
|---|--------|------|------|
| D1 | 方案选型 | A(daemon 内嵌单实例)/ B(纯管理面)/ C(网关+worker 代理,一步到位) | **A 首期**,C 演进(§2 裁定理由) |
| D2 | /mcp 鉴权 | 强制共享 token(§3.5)/ 首期无鉴权仅回环 | **强制 token**(/mcp 敏感度高于面板,同机进程可达) |
| D3 | /mcp 并发策略 | 单会话独占(§3.6)/ 允许多连接共享(文档警示互踩) | **单会话独占**(明确拒绝优于隐式互踩) |
| D4 | daemon start 交互 | 默认打印 URL 手动开 / `--open` 旗标开浏览器 | `--open` 旗标(对齐 `dashboard --web` 惯例,默认不抢焦点) |

D1-D4 全部采纳推荐即可直接转 plan;任一改选,spec 相应节(D2→§3.5、D3→§3.6、D4→§3.8)按选择修订。

---

## 8. 第三方审查处置记录(2026-09-30)

**审查**:code-reviewer 子代理(隔离视角,声明逐条实测),报告 `docs/reviews/2026-09-30-daemon-spec.md`。总体判定 **NO-GO**(修 B-1~B-3 后可转 plan)→ 3 Blocking + 5 Nit 已全数处置,本节为修订对照。

| # | 审查发现 | 处置 |
|---|---------|------|
| B-1 | 端口漂移推翻 G3:面板 recoverPanel 跨端口自愈只救浏览器面板,**不救配置静态 URL 的 MCP 客户端**,"先 respawn 后退出"必然端口漂移 → V4 永久失败 | ✅ §3.7 重写为"端口不漂移的受控交接"(旧进程先关 listener → spawn 传 `--port=旧端口` → 登记确认 → 旧 exit;失败回滚重 listen);G3/V4/R5 措辞同步改为"端口不漂移为不变式" |
| B-2 | 单例检测与 respawn 交互未定义(入口检测会拒绝 respawn 新实例 → 死锁;仅 CLI 壳检测则可绕过起多实例;交接期双登记窗口无处置) | ✅ §3.4 补双层检测(CLI 壳 + 进程入口)与 `--respawn-of=<旧pid>` 豁免通道;§3.7 补双登记窗口"交接中"标注与旧进程删登记时序 |
| B-3 | Windows 无跨进程优雅信号(`kill(pid,'SIGTERM')` 即 TerminateProcess 不跑清理链;本仓 `src/web-gui/server.ts:554` 注释即先例),"优雅信号"主路不成立,且 V5 验收强杀也能过 | ✅ §3.1/§3.8 stop 主路改 `POST /api/shutdown`(共享 token,服务端走 onSelfRestart 同款有序 close 链),信号仅非 Windows 辅助;V5 加"daemon 日志含 close 链完成证据" |
| N-1 | html.ts 改动漏 CSP 锚第六次重锚义务 | ✅ §4 html.ts 行补列(锚值 + 独立重算双通道互证) |
| N-2 | /mcp 未写明仅认 Authorization、拒绝 cookie(面板同源 fetch 自动带 cookie,DNS rebinding 面);缺 Host 头校验 | ✅ §3.5 补两道闸:鉴权独立分支只查 Authorization 不读 cookie;SDK `validateHostHeader`/`localhostAllowedHostnames` 接线 |
| N-3 | mcpHandler 注入链与 WebGuiServer 构造位置冲突(在 `GodotServer.run()` 内构造,daemon 入口无法直接注入) | ✅ §3.2/§4 改为 GodotServer options `mcpHandler` 透传字段下传,对齐既有注入链模式 |
| N-4 | F3/§3.3 方法名误(connect() 实为 run());qa.ts exit code 语义仅可类比;V7"本会话工具即回归证明"不可复现 | ✅ 三处措辞修正;V7 改为 smoke + 既有 stdio 全量测试(自动化口径) |
| N-5 | §0.5 漏列覆盖率阈值(statements 76%/branches 67%/functions 80%/lines 77%)与测试落位惯例(`test/web-gui/` 子目录) | ✅ §0.5 补两行 |

**审查者核出的诚实面(未改,维持原状)**:F1 的 localhost 形态条目 `enabled:false` 不能算 localhost 已实证——spec R2 原文已如实标注该边界,维持。

**审查附带核正(进 memory)**:AGENTS.md 技术栈节写的 SDK 版本 `@modelcontextprotocol/sdk ^1.29.0` 已过时,实际依赖为拆包后的 `@modelcontextprotocol/core` + `@modelcontextprotocol/server` ^2.0.0(package.json 实测)——AGENTS.md 该行待后续顺手更新(不属本 spec 改动面)。

### 8.2 第 2 轮审查处置(2026-09-30,GO WITH CHANGES)

**审查**:round2 报告 `docs/reviews/2026-09-30-daemon-spec-round2.md`——第 1 轮处置文本拿到当前代码上复验 + 第 1 轮未覆盖面;审查者另建探针实测两条机制前提(Windows detached+unref 子进程父退后存活 ✓;旧进程只关 listener 不退出时同端口可立即被新进程绑定 ✓)。判定:第 1 轮 3 Blocking 确已修好,但处置文本引入 2 Major + 8 minor + 5 nit,全数处置如下。

| # | 审查发现 | 处置 |
|---|---------|------|
| M-1 | §3.7 触发路径被同源闸门拒绝:A 面板(Origin=A 端口)打 B daemon 的 restart → 403(`originAllowed` 双实例实测);跨端口 cookie 也救不了;`POST /api/shutdown` 当时不存在(405) | ✅ §3.7 触发通道收敛为 **T1**(daemon 自身面板 isSelf,同端口 Origin 天然放行)+ **T2**(CLI 直连,无 Origin 头放行);跨实例面板重启 daemon **维持 403 现状不破闸**,面板改指引文案;跨实例强杀允许但诚实标注"无人 respawn,需 daemon start 重拉";§3.2 路由表补 `/api/shutdown` 行 |
| M-2 | `--port` 只是建议:`start()` 20 次静默顺延会吃掉 EADDRINUSE 漂到 9551 且"成功登记"→ 漂移被读成交接成功;`/api/health` 无鉴权会把他实例误判为就绪;回滚留双活 | ✅ §3.7 加**不变式 2**(至多一个活 daemon)+ **strictPort 语义**(指定端口绑不上即败,不静默顺延,§4 server.ts 行同步)+ 成功判定收紧为"新登记且 port===旧端口且 kind=daemon"(按登记文件比对,弃 /api/health)+ 回滚先杀新实例并确认登记消失;§3.1 图就绪轮询同步改 |
| m-1 | stdout 重定向与 `stdio:'ignore'` 互斥致日志空文件;detached 下 stdin 立即 end,`index.ts:165` 自杀钩子会让 daemon 启动即死 | ✅ §3.1 图改"stdout/stderr → 日志文件 fd、stdin ignore";§3.3 补"daemon 不注册 stdin end 钩子,退出通道=shutdown 端点/POSIX 信号/killPidTree 兜底" |
| m-2 | 抽共享启动段不够:`startMcpServer` 还内含 Dashboard TUI(`index.ts:167-180`)与 self-update(`:190-198`),daemon 不要 | ✅ §3.3 补"共享段带选项裁剪 `{dashboard, selfUpdate}`,stdio 全 true、daemon 全 false" |
| m-3 | spawn 目标 `build/daemon/index.js` 与入口 `src/daemon/main.ts` 不一致 | ✅ §3.1/§3.4 统一为 `build/daemon/main.js`(源 `src/daemon/main.ts`) |
| m-4 | daemon 拿不到客户端注入 env → deny-by-default 仅 cwd,面板加项目/run/edit(`server.ts:695/:769`)全 403;spec 缺 env/配置契约 | ✅ 新增 **§3.10**:配置真相源 = `settings.json`(设置批闭环——GUI 设置面板即 daemon 配置界面,保存热生效)+ 首启预检提示 + 不加 `--godot-path` 参数避免双通道;V1 验收补提示与热生效 |
| m-5 | 审计 caller 只有 server 侧维度 | ✅ §0.5 补:caller 需区分 `daemon-cli`/`panel` 来源 |
| m-6 | exit code 须过 `test/p2-exit-path-repair.test.ts` 注册表扫描 | ✅ §0.5 补:daemon 子命令 exit code 登记义务 |
| m-7 | PID 复用下按文件名删登记的竞态 | ✅ §3.7 步骤 3 补:删登记前校验文件内容 pid+startedAt 与自身一致 |
| m-8 | 单会话拒绝形态未定 | ✅ §3.6 补:HTTP 层明确 4xx + 可读 message,不静默排队;具体形态随 R3 定 |
| n-1 | SDK rebinding 选项全 `@deprecated`(官方口径 external middleware),第 1 轮 N-2 的接线口径需修 | ✅ §3.5 修正:按**中间件形式**接线,`validateHostHeader`/`localhostAllowedHostnames` 作底层构件,不依赖 deprecated 选项 |
| n-2 | `extractToken` 优先级 query>header>cookie,/mcp 连 query token 也要拒 | ✅ §3.5 鉴权条合并改写:独立取值分支只查 Authorization,cookie 与 query 一并拒,不复用 extractToken |
| n-3 | 第 1 轮处置记录称"spec R2 已如实标注 localhost 边界"但正文无该具体事实;实测 localhost 条目 `enabled:false` 无 headers,证据比第 1 轮记的更弱 | ✅ R2 补写具体事实(`enabled:false` 不足为证);§8 第 1 轮"诚实面"段措辞以本行**勘误**为准 |
| n-4 | MCP URL 打印义务缺失 | ✅ §3.8 补:start/restart/respawn 后 CLI 与日志打印 /mcp URL + token 获取方式;§3.1 图/§4 cli 行同步 |
| n-5 | 404 与交接中 5xx 的验收区分 | ✅ §3.7 补:交接中为拒连(ECONNREFUSED)非 5xx,与"端口无 daemon"同表现,客户端重试收敛,验收不作区分 |

**第 2 轮附带的正向确认(不改动)**:F 表行号全准;覆盖率阈值 76/67/80/77 逐字一致;eslint 只禁 `src/core/**`,`src/daemon/` 合法;R4 与 §3.7 步骤 1 的 OS 层前提由探针实测成立;F7 setter 计数修正为实测 **26**(AGENTS.md"约 23"偏低,方向不变,已更新 F7)。
