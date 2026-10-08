# 独立第三方审查报告:Web GUI「资源重导入」批次(2026-10-08)

> 审查者:code-reviewer 子代理(隔离视角,不预设实现者声明为真)
> 审查对象:工作区未提交改动(git diff 9 文件 +374/-11)
> 主会话补跑验证附记见文末「验证补跑」。

## 总体判定:SHIPPED WITH NITS

主路径设计正确、测试真实锁定、仓库级约束全部合规。发现 1 项 Important 级并发缺口(手动 ⟳ 与 runProject 自动导入互不感知,双向可触发同项目 `godot --import` 重叠执行)+ 3 项 Nit。无 Blocking 问题。

**审查方法与诚实声明**:本审查在无命令执行工具的子代理环境进行,**无法亲自跑 `npx vitest` / `npx tsc --noEmit` / `git diff`**,所有结论基于对工作区文件系统的 grep/read 实测(file:line 均为亲读)。实现者声明的「lint 绿 + build 绿 + 7172 passed」**未获本审查独立复跑背书**;旁证:CHANGELOG:11 记录上批 7158 用例,本批 +14(实测用例数见 §3),7158+14=7172 数字自洽。落盘本报告前建议在终端补跑:

```bash
npx vitest run test/web-gui/server-projects.test.ts test/web-gui/wiring-projects.test.ts test/web-gui/html.test.ts test/web-gui/server-http.test.ts
npx tsc --noEmit
```

---

## 维度一:设计正确性 — 通过,含 1 项 Important 缺口

### 1.1 校验链顺序与 /api/sessions/start 一致(属实)

`src/web-gui/server.ts:999-1041` 实测链序:400(projectPath 前置,:994-996 共用)→ 503(回调缺席,:1001)→ READ_ONLY 403(:1002-1006)→ 白名单 403(:1007-1011)→ project.godot 404(:1012-1015)→ 运行中 409(:1019-1026)→ 互斥 200_duplicate(:1027-1030)→ fire 200(:1031-1040)。对照 sessions/start(`server.ts:951-990`):503→readonly 403→白名单 403→404 的相对顺序逐项一致,409/互斥为 reimport 特有、插在 404 之后 fire 之前,与声明相符。POST 路由表已登记(`server.ts:426`)。

### 1.2 409 判定与 process-state 会话语义同源(属实)

`server.ts:16` import `normalizeProjectKey, isAliveStatus` 自 `../core/process-state.js`;判定链 `server.ts:1019-1022` = `normalizeProjectKey(projectPath)` + `getSessions().some(normalizeProjectKey(s.projectPath) === key && isAliveStatus(s.status))`。注入的 `getSessions` 在 `src/GodotServer.ts:567` 接 `ps.listRunSessionsDetailed()`——其返回的 `projectPath` 就是归一化桶 key(`src/core/process-state.ts:297-315`),再 normalize 幂等。`isAliveStatus` = starting/running/stopping(`process-state.ts:210-211`),stopping 也拦,语义正确。

### 1.3 互斥集 importingProjects 无泄漏路径(属实)

摘除点在 `pushImportDone` 首行无条件执行(`server.ts:1355`),成功/失败两个 settle 分支都经 `server.ts:1034-1037` 的 `.then(onFulfilled, onRejected)` 汇入。有界性:`runImport` 有 120s 超时(`src/tools/import-check.ts:112-116` exitCode===null 即 throw),Promise 必然 settle。**server.stop 后完成**:`stop()` 已 `sseClients.clear()`(`server.ts:324-325`),`pushImportDone` 检 `sseClients.size === 0` 直接 return(`server.ts:1356`),不触达已销毁连接;delete 本身无害。未发现泄漏路径。

### 1.4 SSE 事件 payload 契约两端一致(属实)

服务端 `pushImportDone`(`server.ts:1354-1361`):成功 `{type:'done', projectPath, ok:true, report}`、失败 `{type:'done', projectPath, ok:false, error: Error→message}`,事件名 `'import'`。前端 `src/web-gui/html.ts:1373-1384`:订阅 `addEventListener('import')`、判 `d.type !== 'done'` 短路、成功消费 `d.report.gutted`(Array 判定 + 长度警示)、失败消费 `d.error`(截断 120 字符)。字段名、事件名、类型判别两端逐项对齐,且被测试 `server-projects.test.ts:530` 全量 `toEqual` 深比较锁定。

### 1.5 ⚠️ Important I-1:手动 reimport 与 runProject 自动导入之间双向无互斥

本批 409 与互斥设计的目标是「防 importer 重写 `.godot/imported` 与并发访问在 Windows 撞文件锁」(`server.ts:1016-1018` 注释),但两个写同一资源的入口互不感知,双向各留一个**数十秒级**(import 时长)并发窗:

- **正向(自动导入中点 ⟳)**:runProject 自动导入段(`GodotServer.ts:609-622`)杀完旧进程后,直到 `executeRunProject` spawn 新会话之前,项目无 alive 会话(旧桶已 `clearRunSession`,`process-state.ts:366-374` 不改 status 但退出钩子已将其归 exited)→ 409 不拦;自动导入**不进 `importingProjects` 集**(`server.ts:1027` 只查自己登记的)→ 互斥不拦 → 第二个 `godot --import` 与进行中的第一个并发。
- **反向(⟳ 进行中点 ▶ 运行)**:`sessions/start` 链(`server.ts:951-990`)不查 `importingProjects` → `runProject` 回调 `needsImport()` 命中(手动 import 未完成,mtime 缓存未更新,`import-check.ts:125-127` 只在成功后写缓存)→ 又起一个 `runImport` → **双 importer 并发**,且其完成后 spawn 的游戏进程还会与仍在跑的另一个 importer 并发——正是 409 设计要防的场景。

最可能触发的用户序列恰是本功能的目标场景:「点运行发现纹理还是旧的 → 赶紧点 ⟳」。实现者的诚实边界声明(`GodotServer.ts:607-608`)未覆盖此缺口。**建议**(下一批):互斥状态下提共享——如 `WebGuiServerOptions` 暴露 `isImporting(key)` 查询口给 `GodotServer` 的 `needsImport` 命中分支,或自动导入路径也经端点侧互斥集。鉴于失败有反馈(SSE error / logger.warn)、损坏有 gutted 自检兜底、单一入口使用完全正确,不阻断本批合入。

---

## 维度二:TS-GD/分层一致性 — 通过,含 1 项注释失实 Nit

- **自动导入段位置与顺序(属实)**:杀旧进程在 `executeRunProject` 之前(`GodotServer.ts:609-622` → :623),测试 `wiring-projects.test.ts:336,349` 以 `invocationCallOrder` 真锁。
- **跨项目桶不受影响(属实)**:`getRunSessionProc` 内部 `normalizeProjectKey` 按桶查(`process-state.ts:318-320`),四步调用(`markSessionStopping`/`releaseRunSessionBusy`/`killProcess`/`clearRunSession`)全部按 key,不触其他桶。
- **runImport 120s 超时与注入(属实)**:`GodotServer.ts:618,658` 均传 120_000,`ctx.findGodot` 解析路径,测试 `wiring-projects.test.ts:315` 锁定参数三元组。
- **分层方向合法(属实)**:`server.ts:16` 是 web-gui→core(单向约束只禁 core→tools/web-gui,`eslint.config.js:28-33` 实测);`GodotServer.ts:67-68` import tools 属应用层组合根,合法。`web-gui/server.ts` 全文无 `console.` 调用(grep 零命中),且该文件在 console.log 禁令文件面内(`eslint.config.js:63-65`)。
- **⚠️ Nit N-1:「stopSession 同款四步」注释失实**:`GodotServer.ts:604` 注释 vs 实际——stopSession(`GodotServer.ts:572-580`)是 markStopping → **kill** → releaseBusy 三显式调用(快照挪移靠退出钩子);自动导入段是 markStopping → **releaseBusy → kill** → clearRunSession 四显式调用,顺序对调且多一步。行为无害(kill 等待窗 ≤5s 内 busy 提前释放,但 `executeRunProject` 自带杀旧进程收敛,不会双进程残留;clearRunSession 显式化反而更干净),建议改注释为「stopSession 变体」并说明 releaseBusy 提前的理由,避免后人照注释错抄。
  **→ 处置(审查后已修)**:注释已改写为「stopSession 变体:releaseBusy 提前于 kill,且多显式 clearRunSession」,并在同段补 ③ 标注 I-1 已知缺口(`src/GodotServer.ts` 自动导入段注释,2026-10-08)。

---

## 维度三:测试质量 — 通过

- **server-projects 8 用例真覆盖声明分支**(`test/web-gui/server-projects.test.ts:446-557`):503/readonly 403+不调回调/白名单 403(真收紧 env + finally restore)/404/**alive→409(:484,status='running')与 ended→放行(:499,status='exited')区分**/成功链(:513:**fn pending 时 200 已返回 = fire-and-forget 响应先于完成**;互斥期二次请求 `{started:false}` 且 `fn` 仍 1 次;release 后 SSE payload **全量 toEqual 深比较**;摘除后第三次请求 `started:true` = 可重入)/失败链(:540,SSE `{ok:false,error}` 含 timed out)。
- **wiring 三分支顺序断言真实**(`test/web-gui/wiring-projects.test.ts:319-360`):false 短路不调 runImport;`mockRunImport.invocationCallOrder[0] < mockExecuteRunProject.mock.invocationCallOrder[0]`(:336)锁「import 先于 spawn」;`mockKillProcess < mockRunImport`(:349)+ markStopping/releaseBusy/clearRunSession 调用断言(:345-347)锁「杀完再 import」;失败不阻断(:352-359)。mock 定义合格:`getRunSessionProc` 默认 null(其余用例正确跳过分支)、`killProcess` resolved、afterEach `clearAllMocks` + env 恢复(:192-199),`mockReturnValueOnce` 均被消费,无泄漏。
- **Nit N-2**::339 无法锁四步内部相对顺序(mock killProcess 不触发真实 close 钩子),只锁了外层时序——mock 边界所致,可接受,不要求改。
- **html.test.ts:66-73** 为字符串包含断言——该文件头即声明「前端行为靠契约+真机验收」,属既有定位非本批退步。server-http.test.ts:97-104 CSP hash **双通道互证**(build 产物导入值 + 测试内独立 split/归一/重算)锁死脚本变更,质量好。

---

## 维度四:仓库级约束独立核查 — 全部合规

- **rule-templates.ts / .claude/rules 未触碰**:全仓 grep `reimport` 命中文件清单为 src 三文件、test 四文件、CHANGELOG、README、`.zcode/plans/`(会话产物)、node_modules/docs 数据文件——**无** `src/tools/rule-templates.ts`、**无** `.claude/rules/`。版本 bump 硬门禁不触发,CHANGELOG:9「不 bump 版本」声明属实。
- **capability-matrix 无需重建**:matrix 源 `src/capability/` 零命中 reimport(本批是 web-gui HTTP 端点,非 MCP 工具变更),声明核实成立。
- **eslint**:console.log 禁令文件面含 `src/web-gui/server.ts`(eslint.config.js:63-65),全文无 console 调用;core→tools 门禁方向无违反(见维度二)。
- **GDScript**:改动文件清单无 `.gd`,check:gdscript 门禁不适用。
- **build/ 产物同步**:`build/GodotServer.js`、`build/web-gui/*` 已含同改动(本地已构建),`build/` 在 .gitignore(:2),非 git 漂移。

---

## 维度五:验证完整性 — 部分背书

如 §「诚实声明」:本审查环境无法执行命令,**lint/build/test 7172 的实现者声明未获独立复跑**。静态旁证:7158+14=7172 自洽;14 个新用例逐一实读确认存在且非恒真。类型层面,新增接口键(`server.ts:76-79`)、调用点(`GodotServer.ts:656-659`)、测试 mock 形状三方一致,未见明显类型错配;CSP hash 为运行时计算而非硬编码,不存在「改脚本忘改 hash」类风险。落盘本报告前须由主会话补跑开头两条命令并贴输出(AGENTS.md 完成前验证红线)。

---

## Blocking Issues

无。

## Important Issues

- **I-1**(§1.5):手动 ⟳ 与 runProject 自动导入双向无互斥,同项目 `godot --import` 可重叠执行数十秒级窗口,恰为本批 409/互斥设计要防的 Windows `.godot/imported` 文件锁并发写场景。证据:`server.ts:1027`(互斥只查 importingProjects)+ `GodotServer.ts:609`(needsImport 不查互斥)+ `server.ts:951-990`(start 链不查互斥)。建议下一批把互斥状态上提共享。**→ 处置:已修(2026-10-08 遗留批)。新建 `src/web-gui/import-mutex.ts` 模块级共享锁(tryAcquire 非阻塞供 ⟳ 端点 / acquire FIFO 排队供自动导入 / release 移交);端点实例 Set 删除换共享锁;自动导入拿锁后双检 needsImport(等待期间他人完成 → 跳过重复导入),finally 释放。同进程内有效,跨进程由 runImport 报错兜底(与 409 会话判定同语义)。测试 +10。**

## Nits

- **N-1**:`GodotServer.ts:604`「stopSession 同款四步」注释与实际调用序列不符(顺序对调 + 多 clearRunSession)。**→ 已修(审查后,见维度二处置)。**
- **N-2**:`wiring-projects.test.ts:339` 未锁杀进程四步内部顺序(mock 边界,可接受)。不改。
- **N-3**:reimport 异步失败(SSE import {ok:false})无 auditWebGui 审计留痕,仅 logger + SSE;与 sessions/start 的同步失败留痕面不完全对齐(scan 先例亦如此,可下批统一)。**→ 处置:已修(2026-10-08 遗留批)。`pushImportDone` 失败分支补 `auditWebGui('projects','reimport','process',path,{ok:false,error})` + logger.warn;scan 因无单一 projectPath 不适用 auditWebGui 语义,维持现状(结论已写入 pushImportDone 注释)。**

## 值得进 memory 的工程教训

1. **同资源双入口的互斥状态必须共享**:server 层 `importingProjects` 与注入回调内的自动导入各自「入口内完备」,但跨入口并发照样穿透——新增写同一资源的第二入口时,互斥/锁状态要集中或暴露查询口,而非各入口各建一套(场景:web-gui reimport vs runProject 自动导入,2026-10-08 审查 I-1)。
2. **fire-and-forget + SSE 完成契约用全量 payload 深比较锁定两端**(server-projects.test.ts:530 的 `toEqual({type,projectPath,ok,report})` 模式),配合 CSP hash 双通道互证(server-http.test.ts:97-104),是「异步契约不漂移」的可复用测试范式。
3. **审查子代理环境可能无命令执行工具**:委派审查时若要求复跑测试,需先确认子代理工具面;否则报告必须显式声明「未独立复跑」并留核查命令,不得默认转述实现者验证声明为事实(本次审查实践)。

---

## 验证补跑(主会话,2026-10-08 审查后)

N-1 注释修正(`src/GodotServer.ts` 自动导入段)后,主会话按审查要求补跑:

```
$ npx tsc --noEmit          → REAL_TSC_EXIT=0(输出仅 1 行 npm 配置警告,零类型错误)
$ npx vitest run test/web-gui/server-projects.test.ts test/web-gui/wiring-projects.test.ts \
    test/web-gui/html.test.ts test/web-gui/server-http.test.ts
  → Tests  142 passed (142)
```

另:全量验证于注释修正前完成——`npm run lint` 零输出(通过)、`npm run build` BUILD_EXIT=0、`npm test` 全量 **7172 passed | 93 skipped**(480 文件)。注释修正仅改注释文本,不影响编译产物语义(定向复跑已覆盖)。
