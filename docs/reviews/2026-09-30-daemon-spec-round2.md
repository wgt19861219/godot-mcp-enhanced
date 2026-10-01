# 2026-09-30 常驻守护进程 spec — 第三方审查(第 2 轮 / 独立)

> **审查者**:独立子代理(不预设 spec 与第 1 轮审查结论为真,逐条在仓库内实测)
> **审查对象**:`docs/plans/2026-09-30-daemon-spec.md`(315 行,未实现;`git status` 确认与 `docs/reviews/2026-09-30-daemon-spec.md` 同为 untracked)
> **审查时 HEAD**:`8dfc87c0`(spec §0 引用的一致)
> **总体判定**:**GO WITH CHANGES** —— 第 1 轮的 3 Blocking 确实已处置且方向正确,但处置文本引入了 **2 项新的 Major**(其中 1 项使 §3.7 第 1 步的主触发路径在当前仓库形态下**不可能成立**,已实证),另有 6 项 Minor/Nit。修 M-1/M-2 后可转 plan。

## 0. 本轮与第 1 轮的分工

第 1 轮修的是**"原理错"**(端口漂移外推、单例检测自锁、Windows 信号)。本轮不重复这三条,只做两件事:

1. 把第 1 轮的处置**落到当前代码上验一遍**(处置文本是否真能实现);
2. 第 1 轮未覆盖的面:**SDK 2.x 的无 Node 适配器现实**、**启动序复用与 daemon 模式的冲突**、**CLI/治理门禁连带义务**、**交接失败判定**。

---

## 1. 经实测确认成立的部分(先给结论,避免误读为全面否定)

| 项 | 实测证据 |
|---|---|
| F3 transport 后挂 | `src/GodotServer.ts:542-544` `run()` 内 `new StdioServerTransport()` + `this.server.connect(transport)`,确为参数化改动 |
| F5 registry 向后兼容先例 | `src/web-gui/registry.ts:17-26` `version?` + `:161-169` `parseRegistrationFile` 不校验它 |
| F6 killPidTree | `src/core/process-state.ts:64` 定义、`:709` 导出;`src/GodotServer.ts:866` `ps.killPidTree(pid)`。spec 写"processState(Windows taskkill)"成立 |
| F7 进程级单例 | 模块级 setter 实测 **26 个**(`grep '^export function set[A-Z]'`),含 `setMcpServer`/`setLoggerServer`/`setProgressSender`/`setOnBridgeConnected`/`setInstanceManager`/`setElicitServer` 等;`GodotServer.ts:209-211` 无条件设置 → 同进程第二实例必互踩。**spec 说的"约 23"是低估(26),但结论方向正确** |
| F13 启动序在 `src/index.ts:25-80` | 实测 `startMcpServer` 起于 `:25`,安全门 `:27-62`、`applyUserSettingsAtStartup` `:66`、C-08 提示 `:69` 均在 25-80 内,行号准 |
| R4 detached 存活 | **我另建脚本实测**(非引用 spec):Windows + Node 24.14,`spawn(...,{detached:true,stdio:'ignore',windowsHide:true})` + `unref()`,父进程 300ms 后 `exit(0)`,子进程 2.5s 后成功写文件 → **父退子存,机制成立** |
| §3.7 步骤 1 的端口释放前提 | 自建 socket 探针实测:旧 holder 仍 listen 时新进程绑同端口 `EADDRINUSE`;旧进程**只关 listener 不退出**后同端口立即可绑 → **"先关 listener 再交给新实例"在 OS 层成立**(这正是 B-1 的正确修法) |
| §0.5 core→web-gui 分层 | `eslint.config.js:27-37` 只对 `src/core/**` 禁 `tools|web-gui`;`src/daemon/**` 不受限,结论成立 |
| §0.5 覆盖率阈值 | `vitest.config.ts:29-34` 76/67/80/77 逐字一致 |
| N-1 CSP 锚第五次重锚史 | `test/web-gui/server-http.test.ts:73-86` 五次重锚注释 + 硬编码锚 `fxmxYFhU...` 实测在场 |

**关于第 1 轮"核出的诚实面"(F1 localhost 条目 `enabled:false`)** :本轮复核发现 spec 正文**并未**如第 1 轮所述"R2 原文已如实标注该边界"——我 grep 全文,F1/R2/F12 只提"远程 URL + 自定义 headers 实证",localhost 条目的事实在 spec 正文里**不存在**。第 1 轮把"审查报告里的 F1 结论"误记为"spec 已诚实标注"。这不是大问题,但两条结论都该改:**spec 应把这条边界写进 F1/R2**(见 N-3,该边界比第 1 轮描述的更弱)。

---

## 2. Major(转 plan 前必须处置)

### M-1 §3.7 步骤 1 的"面板 restart 端点"主触发路径**实际被同源闸门拒绝**(已实证,置信 95)

spec §3.7 步骤 1 写:

> 旧 daemon 收到重启指令(**面板 restart 端点识别 `kind === 'daemon'`**,或 `POST /api/shutdown?restart=1`)

**"面板 restart 端点"这条在当前仓库形态下走不通。** `src/web-gui/server.ts:299-307`:

```ts
private originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${this.portValue}` || origin === `http://localhost:${this.portValue}`;
}
private authorized(req, url): boolean {
  return this.tokenEquals(this.extractToken(req, url)) && this.originAllowed(req);
}
```

面板页在 A 实例(端口 pA)上,`fetch('http://127.0.0.1:'+pB+'/api/instances/restart')` 会带 `Origin: http://127.0.0.1:pA`;目标 B 的 `portValue = pB ≠ pA` → `authorized()` 假 → **403**。

**实测**(我构造两个 `WebGuiServer` 实例,同一共享 token):

```
A(panel origin)=http://127.0.0.1:57387  B(target daemon)=http://127.0.0.1:57388
case1 same-port origin -> B:        HTTP 404   ← 同源可达(证明路径本身没坏,是跨端口被拦)
case2 cross-port origin (A -> B):   HTTP 403   ← 面板重启"他实例"必然 403
case3 cookie auth same-port:        HTTP 404   ← 即便复用面板 cookie 通道也救不了跨端口
```

即:**共享 token 完全有效也没用,卡的是 Origin**。而"用面板重启 daemon"恰恰是 V4 的验收动作(`V4 面板重启 daemon 实例 → 受控交接`)。当前 spec 把主路径写成了不可达路径,只留"或 `POST /api/shutdown?restart=1`",那个端点**今天也不存在**(实测 `POST /api/shutdown` → 405)。

**修法(二选一,须在 spec 里定死,不能留"或")**:

- **推荐**:把交接触发收敛为**单一通道**——CLI `daemon restart` 打 `POST /api/shutdown?restart=1`(CLI 用 `fetch` 无 Origin 头,`originAllowed` 直接放行,现状即支持),面板只读展示实例状态 + 提供"复制重启命令"文案;V4 验收改为"CLI restart → 端口不漂移 → ZCode 重连恢复",面板路径降级为诚实边界。
- **若要保留面板按钮**:必须新增**受控的特例分支**并写清安全论证——例如 `/api/instances/restart` 接受"loopback Origin 任意端口 + 共享 token + **不读 cookie**",其恶意面是"本机任意网页若能拿到 token 即可重启 daemon",须与 N-2 的 cookie 面一样显式论证后再落地。**不可**只是"放开 originAllowed 的端口相等判断"——那会同时打开面板全部写端点(`/api/projects/file` 写文件、`/api/sessions/start` 起进程)的跨端口面。

连带:`GET /api/instances` 是经 `authorized()` 的普通读路径,面板自己也读不到别的实例吗?——**能读到**(自己的端口),所以实例区列表不受影响,受影响的只有"对别人发写请求"。

### M-2 `--port` 未定语义 + 新实例端口扫描降级 + 回滚判定,构成新的端口漂移与"双活"缺口(置信 85)

§3.7 步骤 2/4 要求:新 daemon **显式传 `--port=<旧端口>`**;失败判定是"**新实例未起/未登记/绑端口失败**"。

实测三处与代码现实不符:

1. **`WebGuiServer.start()` 没有"严格绑端口"语义**。`src/web-gui/server.ts:194-208` 是 `for (let i = 0; i < PORT_ATTEMPTS; i++) { candidate = start + i; try { listen(candidate) ... } catch { lastErr = err } }`——**端口被占只是静默换下一个**。我的探针证实:旧 holder 仍 listen 时同端口 `EADDRINUSE`,而 `start()` 会把它吃掉改成 9551 并**成功登记**。若交接序列任何一步把顺序写反(或旧进程 listener 关得比 spawn 慢),新实例**不会失败,会漂到 9551**——这正是 B-1 要消灭的现象,且此路径**绕过了 B-1 的修法**(因为代码"成功了")。
   → spec 必须为 daemon 增加 **`strictPort`(或 `portStart` + `PORT_ATTEMPTS=1`)语义**:绑不上即报错退出,绝不顺延。这是 M-2 的最小充分修法。
2. **步骤 4 的回滚判定抓不住"绑错端口"**。判定写的是"新实例**未登记**"才回滚;而按 1,新实例绑到 9551 后**登记成功** → 旧进程判定"交接成功" → 删自己登记 → exit。结果:`registry` 里一条 daemon 登记写着 9551,而 ZCode 的静态 URL 还在 9550 → **V3/V4 永久失败**,且现场是"看起来成功"的。修法:交接确认必须比对**端口 == 旧端口**(登记文件里的 `port` 字段,而非仅"有条目")。
3. **回滚路径本身会留双活**。步骤 4 说"旧进程重新 listen 原端口回滚"。若新实例已绑到别处且登记成功,旧进程回滚后**两个 daemon 都活着**,直接违反 §3.4"单例"不变量,且 `daemon status`(按 `kind=daemon` 计数)会报两条、下一条"kind=daemon 且探活"的 `daemon start` 会被误拒。修法:回滚前必须先 `killPidTree(新 pid)` 并**确认其登记文件消失**,再 re-listen;或把"新实例绑错端口"直接升级为交接失败(配合 1 后此路自然关闭)。

4. **就绪轮询用 `/api/health` 不可靠**。§3.1 步骤 3 写"轮询 `/api/health` 就绪(复用前端同款探活)";该端点(`server.ts:335-346`)是**无鉴权**且**只报 `{ok, port}`**。在"已有 stdio 实例占着 9550、daemon 漂到 9551"的场景,CLI 只要探 9550 就得到 200 → 误判 daemon 就绪并打印**别人的** URL。修法:就绪判定改探 `/api/instances`(带 token,读 `me`/`kind`)或让 daemon 暴露携带 `pid`+`kind` 的探活;`--port` 也必须定为**内部旗标**(`daemon --help` 不列,防用户手动传导致与单例检测打架)。

---

## 3. Minor(plan 批可处置,但须落进改动面)

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| m-1 | **"stdout/stderr 重定向日志文件"与 `stdio:'ignore'` 互斥** | `log`/`console.error` 经 `process.stdout/stderr`;`detached:true` + `stdio:'ignore'` 时二者落 NUL,`daemon-<pid>.log` 会是空文件。spec §3.1/§3.9 同时写了这两件事 | spawn 时 `fs.openSync(logPath,'a')` 后传 `stdio:['ignore', fd, fd]`(或 `'inherit'` 不可用于 detached 无人终端)。**同时**:daemon 入口**不得**注册 `process.stdin.on('end', …)`(`src/index.ts:165`),detached + `stdin:'ignore'` 下这会立即触发"优雅退出" |
| m-2 | **"启动序抽共享段"不足以让 daemon 安全复用** | `startMcpServer`(`src/index.ts:25-199`)除安全门外还内含:进程级 `unhandledRejection`/`uncaughtException`(`:17-23`,文件顶层)、stdin-end 关机(`:165`)、`server.run()` 后**自动拉 Dashboard TUI**(`:167-180`)、self-update 检查(`:190-198`)。daemon 需要前两者、绝不要后两者 | 抽出的共享函数必须带选项(如 `{ stdinLifetime: boolean; autoDashboard: boolean }`),而非"抽一段同源链"。否则 daemon 会拉起一个没人看的 TUI,并在 stdin 关闭时自杀 |
| m-3 | **published 路径与 spawn 目标不一致,且 `files` 白名单未列 daemon** | spec §3.1 写 spawn `build/daemon/index.js`,§3.8/§4 写入口是 `src/daemon/main.ts`(→ `build/daemon/main.js`);`package.json.files` 现有 `build/**/*.js`(够),但**树里目前没有 `src/daemon/`** | 统一为一个路径;`build` 脚本会把 `src/**/*.ts` 全编到 build(tsc 决定),但 `:216` 的"平铺单文件起步"表述与 `build/daemon/index.js` 不一致,plan 需定死文件名 |
| m-4 | **daemon 的 env 面与 stdio 一致客户端的 env 面不等价,spec 未定义通道** | daemon 由**终端**CLI 拉起,继承的是终端 env;ZCode 的 `godot` 条目(实测 config)注入了 `GODOT_PATH`/`GODOT_MCP_MODE=editor`/`ALLOWED_PROJECT_PATHS`(9 条)。缺失时:`isPathInAllowedRoots` 落 **deny-by-default 仅 cwd**(`src/core/path-utils.ts:273-286`)→ 面板"添加项目"(`server.ts:695` `isPathInAllowedRoots`)与 `run/edit`(`:769`)对白名单外项目**全 403**,而面板"项目白名单"设置项写 `process.env.ALLOWED_PROJECT_PATHS`(`core/user-settings.ts:119`)——**daemon 进程的 env 正好是这些工具与面板共用的那一份**,改设置即改工具授权面 | spec 必须新增一节"daemon 的 env/配置契约":`daemon start` 支持显式传 env(或读 settings.json 的同一份),并明确"无 `ALLOWED_PROJECT_PATHS` 时 daemon 只能访问 cwd,白名单外项目面板操作 403"的诚实提示。**建议同时加一条护栏**:设置面板改白名单时对 daemon 进程给出"影响 7×24 实例"的提示 |
| m-5 | **审计 `caller` 语义:CLI 侧与 server 侧都会写 `web-gui:instances`** | `src/web-gui/server.ts:504-513` `auditInstanceAction` 硬编码 `caller:'web-gui:instances'`;spec §3.9 要 daemon start/stop/restart 也落同一子系统。CLI 侧没有 `web-gui:` 语境 | 增加 `actor`/`source` 维度或给 CLI 侧定独立 caller(如 `cli:daemon`),否则事后无法区分"进程自己报的"与"CLI 命令报的" |
| m-6 | **交接/命名的 exit code 义务** | spec §3.1 明确"exit code 0=有活 daemon(仅类比 qa.ts)"。但 `src/core/exit-codes.ts:10-12` 载明:`test/p2-exit-path-repair.test.ts` 静态扫描 `src/cli` 的 `process.exit(n)` 字面值,**注册表外的码被 CI 拦截**;现注册表只有 0/1/2 | daemon CLI 新增退出点一律引用 `EXIT_CODES`;"没有活 daemon"若要非 0 语义,须用现有码并在 spec 写明(推荐 `daemon status` 恒 0 + 文案区分,避免与 `stop` 的失败码混淆) |
| m-7 | **PID 复用 + 按文件名删登记的竞态** | `registry.ts:150-153` `removeRegistration(pid)` 按 `<pid>.json` 无条件删;Windows 复用 pid 频繁。交接窗口内旧进程若删到**新进程**的同名登记(pid 相同),新 daemon 就"消失了" | 删登记前校验文件内容 `pid` 与 `startedAt` 属于自己(条件删除),或新实例写 `replaces:<oldpid>` 并让旧进程只删该标记的文件 |
| m-8 | **单会话独占的拒绝形态没说清** | §3.6 只说"返回明确错误信息"。SDK 侧:无效 sessionId → 404、非 initialize 请求缺 sessionId → 400(`index.d.mts:560-565`),而 streamable HTTP 的 initialize 被拒在客户端侧通常表现为**连接失败**,不是可读文案 | spec 应写明:第二个 Initialize 以 HTTP 4xx + MCP error body 拒绝,并把指引文案同时放进**面板实例区**(§3.6 已提)+ `/mcp` 的 4xx body;并明确"占用判定"落在 `sessionIdGenerator`/`onsessioninitialized`/`onsessionclosed`(`index.d.mts:468/476/487`)哪个回调 |

---

## 4. Nit

| # | Nit |
|---|---|
| n-1 | **N-2 的 Host 校验建议应改口径**:`WebStandardStreamableHTTPServerTransportOptions` 本身带 `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection`,但三者**均标注 `@deprecated Use external middleware for host validation instead`**(`index.d.mts:499-516`);SDK 导出的是 `validateHostHeader`/`localhostAllowedHostnames`/`hostHeaderValidationResponse`(`:166-178`)作为外部中间件。spec §3.5 写"SDK 有现成导出…实现批接线"方向对,但应点明**这是中间件而非构造选项**,且仓库既有 `authorized()` 的 loopback 同源闸门可作第二道,不必重复造 |
| n-2 | **/mcp 只认 Authorization 的落实要更硬**:`extractToken`(`server.ts:278-297`)优先级是 **query > `X-GUI-Token` > cookie**。spec N-2 已说拒绝 cookie,但没说 **query token 也要拒**(浏览器恶意页可把 token 放 URL 触发 GET 侧信道)。实现批须为 /mcp 走独立分支,只读 `Authorization: Bearer` |
| n-3 | **F1/R2 的诚实面应补齐且比我第 1 轮记录更弱**:实测 ZCode config 里**已有** `http://127.0.0.1:3845/mcp` 的 localhost http 条目(`figma-dev-mode-mcp-server`),但 `enabled:false`、无 headers。所以:(a) localhost 形态存在但被禁用,**未验证可连**;(b) **"http 条目支持 headers"与"localhost 条目支持 headers"是两条独立事实**,spec 用前者推后者,应在 R2 明说"localhost + Authorization 组合未实证,失败则 P2 路径降级" |
| n-4 | **MCP URL 打印义务缺失**:§3.5 只说 `daemon start`/`daemon status --show-token` 打印 token,`daemon status` 应输出可直接粘到 ZCode 的**完整 `/mcp` URL + headers 片段**;D4(`--open`)与本项正交,建议 D 表补一行 |
| n-5 | **§3.2 "缺席不挂 /mcp 路由(404,503 不适用)"** 与 §3.6/§3.7 的"交接中面板+`/mcp` 双拒连"表述并存时,验收要能分清 404(未实现)与 5xx(交接中/内部错)。建议在 V2/V4 里各加一条状态码断言 |

---

## 5. 验收标准复核

| # | 复核结论 |
|---|---|
| V1 | 可测,但"面板 URL 可访问"在**无 `ALLOWED_PROJECT_PATHS`** 的终端里只能看 cwd —— 见 m-4,建议 V1 补一条"面板项目区在未配白名单时的行为符合文档" |
| V2 | 可自动化,但 `package.json` 的 `inspector` 脚本是 `npx @modelcontextprotocol/inspector build/index.js`(**stdio 形态**),daemon 的 /mcp 需另写 SDK client 脚本;spec 写"或 npm run inspector"会误导,建议删掉该括注 |
| V3 | 真机项,保留;须同时记录 `enabled:true` 的 localhost 条目实证(见 n-3) |
| V4 | **当前不可执行**:面板路径被 M-1 阻断;且"端口不漂移"在 M-2 下无机械保障。修 M-1/M-2 后重写为"CLI restart → 端口不变 → 客户端重连恢复" |
| V5 | 第 1 轮已强化(日志含 close 链证据),成立;建议补"`daemon-<pid>.log` 非空"(防 m-1 的 NUL 空文件使该证据天然缺失) |
| V6/A、V7、V8 | V6 见 m-8;V7 口径(全量 stdio 测试绿)可执行;V8 成立 |

---

## 6. 处置建议清单(按优先级)

1. **M-1**:§3.7 步骤 1 收敛为单一触发通道(CLI `POST /api/shutdown?restart=1`),面板降级为只读 + 文案;或显式设计并论证"loopback 任意端口 Origin + 仅 header 鉴权"的特例分支。同步改 V4。
2. **M-2**:新增 `strictPort`(绑不上即失败,绝不顺延)+ 交接确认比对 `port == 旧端口` + 回滚前先杀新实例并确认其登记消失 + 就绪探测改用带身份信息的端点。`--port` 定为内部旗标。
3. **m-1/m-2**:确定 detached 的 stdio 具体接法(文件 fd)与 daemon 模式必须屏蔽的启动序行为(stdin-end、自动 TUI、self-update)。
4. **m-4**:补"daemon 的 env/配置契约"一节(白名单/Godot 路径/profile 的来源与缺失后果)。
5. **m-3/m-5/m-6/m-7/m-8** 落进 §4 改动面清单与测试行。
6. **n-1~n-5** 落进 §3.5/§3.6/§3.1 与验收表。

## 7. 值得进 memory 的教训(本轮新增)

1. **"共享 token 有效"≠"调用可达"**:本仓 `authorized()` 是"token **且** Origin 等于自身端口",任何"面板去操作另一个实例"的设计都必须先过 Origin 这一关——第 1 轮与 spec 都只盯着 token。
2. **"显式传端口"必须配套"严格绑端口"**:只要下层的监听函数带顺延重试(本仓 `PORT_ATTEMPTS=20`),`--port=X` 就只是**建议**而非约束;而失败判定若只看"有没有登记",漂移会被读成成功。
3. **detached 常驻进程与 `src/index.ts` 的读者假设冲突**:stdio 入口里的 `stdin 'end'`、自动 TUI、self-update 全是"有客户端会话"的假设,复用启动序时必须显式裁剪,否则"复用"= 引入三个副作用。
