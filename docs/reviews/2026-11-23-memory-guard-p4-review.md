# memory-guard 四期（采样落盘 + 档位回看判定标准 + 只读分析工具）全分支终审

**日期**：2026-11-23　**审查人**：fresh reviewer（Claude，独立会话）　**分支**：`worktree-feat-memory-guard-p4`
**范围**：`e90c476b..ad32fcb5`（15 commits：计划落档 1 + 功能 7 + 审查修复 4 + 文档收口 3；33 文件 +4652/−51）
**依据**：计划 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\plans\2026-11-23-memory-guard-p4.md`（Global Constraints + Review Focus 五条）；设计 v2 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-23-memory-guard-p4-design.md`；执行账本 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\feat-memory-guard-p4\.superpowers\sdd\2026-11-23-memory-guard-p4\progress.md`

---

## 一、审查范围与方法

- **主视图**：review package（`.superpowers/sdd/2026-11-23-memory-guard-p4/review-e90c476b..ad32fcb5.diff`，6193 行 / 约 462KB），**按文件边界分 12 段全量通读**：①提交清单+规则/CHANGELOG/版本件/lookback 文档 ②设计审查文档+manifest/package.json ③`scripts/memguard-review.mjs` 全文 ④server.json/doctor.ts/audit-log.ts/exit-watchdog.ts ⑤mem-watchdog.ts ⑥memory-guard.ts 采样区 ⑦session-idle-timer/mcp_bridge.gd/rule-templates ⑧doctor.test/audit-log.test/mem-watchdog.test ⑨⑩memory-guard-sample.test.ts（分两段）⑪memory-guard.test/session-idle-timer.test/defects.ts/setup.js ⑫memguard-review.test.ts。diff 中间的计划与 spec 段（718–1141 行）与已单独读取的文件相同，未重复读。
- **源码定点核实（具名风险 → 核对了什么）**：
  - 「final sample 是否在自然退出路径生效」→ 读 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts:276-300`（`killPidProbe`/`listActiveLeases` 读时三规则）、`:815-833`（`releaseLease`）、grep 全部 31 处 `releaseLease(` 调用点确认漏斗 close 路径形态。
  - 「memory-guard.ts 新增对 audit-log.ts 的 import 是否成环」→ `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\audit-log.ts:15-22` import 面（仅 `tool-registry.js` type-only 与 `logger.js`，无回边）。
  - 「exit-watchdog 透传导入是否破坏三期源码锚」→ `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\exit-watchdog.test.ts:513-515` 锚原文（`/pressure/i` + 精确串 `from './memory-guard.js'`）；grep `exit-watchdog.ts` 全文无 `pressure` 字样。
  - 「同进程并发轮转」→ `audit-log.ts:203-248`（`rotateIfNeededWith` 锁逻辑）、`:520-526`（`appendMachineAuditLine` 新增轮转）、`appendAuditLine`（:140-175，无进程内串行化）；grep `appendMachineAuditLine(` 全部 24 处调用点。
  - 「exit 链 exit_reap 落盘窗口」→ `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\exit-watchdog.ts:124-168`、`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\GodotServer.ts:753`。
- **可执行复现（read-only，不改 checkout）**：对 HEAD 的 `build/core`（时间戳晚于最后一次 src/core 提交 b7b466e4）写复现脚本 `C:\Users\wgt\AppData\Local\Temp\p4-review-repro\repro.mjs`，坐实两条 Important（见第八节）。临时产物在 `%TEMP%` 下（`p4-review-repro\` 与 `p4-review-repro-*` 数据目录），hook 拒绝带通配的 `rm -rf`，**留待控制器删除**。
- **行为验证（定向，非全量）**：`npx vitest run` 七个受影响测试文件（memory-guard-sample / audit-log / memguard-review / doctor / mem-watchdog / session-idle-timer / exit-watchdog）→ **7 files / 223 passed / 1 skipped（Linux-only 0600）/ 0 failed**。全量门禁证据采信 Task 8 报告（`2972bfa5`，其后两笔仅改文档）。
- **checkout 状态**：审查前后 `git status` 均仅既有 `package-lock.json` 噪音，HEAD `ad32fcb5` 未动。
- **限制（诚实声明）**：未实跑 lint/tsc/全量 coverage（采信控制器证据）；evict/evict_exhausted 的驱逐路径测试本机为 Windows 实跑，非 Windows 行为未验证；复现脚本用的是 `build/` 而非直接跑 `src/`，两者差异仅为 tsc 转译。

## 二、总体判定

| 维度 | 判定 | 一句话 |
|---|---|---|
| Review Focus 五条 | **PASS** | 五条各有实现 + 真实 fs 测试双重锚定（第三节） |
| 计划对齐（8 任务） | **PASS** | 功能全部在场；偏离字面处均有账本裁定背书，裁定本身除一条外均成立（第六节） |
| 双通道分工 / 开关语义 / 失败隔离 | **PASS** | 两通道独立、双开关文件不创建级短路、每个 fire-and-forget 都挂 catch |
| 写盘 ↔ 读盘字段对账 | **PASS** | 13 事件逐字段对得上（5.3 节） |
| **final sample（Task 4）** | **FAIL** | 自然退出路径（设计目标）不触发；测试夹具恰好绕开目标分支（Important-1） |
| **machine-audit 新接轮转的并发安全** | **FAIL** | 同进程并发 `appendMachineAuditLine` + 文件超 10MB → 审计整代丢失（Important-2） |
| 文档一致性 | **PASS（含两处失实）** | lookback 文档 §5 已知局限非常诚实；但 §1.1/CHANGELOG 对 final sample 的声称与实现不符（随 Important-1 修正） |
| 治理行为零影响 | **PASS** | 全部接线在决策之后、bare 调用、fail-open；`snap` hoist 不改语义（5.6 节） |
| 版本 / 规则 / CHANGELOG 收口 | **PASS** | 四件套同步、T3-M-3 回标、`[Unreleased]` 其余挂账保留 |

**结论：With fixes。** 两条 Important 均有可执行复现、修法小而明确，应在合并前落地；其余 40 条延后小问题无一需要合并前修。

## 三、Review Focus 五条逐条核验

### 1. 开关关零写盘 ✅

- 实现：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts:1228-1240` `memSample` 首两行 `if (!memoryGuardEnabled()) return; if (!memSampleEnabled()) return;` 先于 `appendSampleLine`（不 mkdir、不 append、不入链、不触发惰性 server_start）；`memSampleEnabled` 实时读 env、`'0'`/`'false'` 关、其余含空串均开（与 README「其余值与未设=开」一致）。
- 测试：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\memory-guard-sample.test.ts` ③ 三用例（GUARD=0 / MEM_SAMPLE=0 / =false）断言 `existsSync(samplePath) === false`；⑧⑤ `updatePressureState` 在 guard=0 下零行且文件不创建；⑪④ 预置 8MB+ 超限文件 + 双开关关 → `sizeChecks() === 0`（**连 stat 都不发生**，零触碰口径对轮转检查同样成立）。
- 判定：**通过**。

### 2. appendFile 失败不崩进程且不刷屏 ✅

- 实现：`memory-guard.ts:1194-1202` `appendSampleLine` 每段 `.catch(warnSampleFailOnce)`，链恒为已决态；`warnSampleFailOnce` 同因键 `${what}(${message})` 去重，首次一行 `console.error`，追加失败/轮转失败两类互不去重；`rotateSampleIfNeeded`（:1211-1226）轮转失败走采样通道口径（同因去重 + 重试标志），**不计** `recordAuditWriteFailure`。`mem-watchdog.ts:216-226` `auditKill` 的 `void appendMachineAuditLine(...).catch(recordAuditWriteFailure)`。
- 测试：⑤ 路径是目录 → 3 次失败 `errSpy` 恰 1 次；⑪③ 轮转失败（最老代位置放目录）→ 旧行仍在、新行照追加、`getAuditFailureStats().failures` 不变；⑫③ 审计文件路径是目录 → `process.on('unhandledRejection')` spy 零调用、树杀 `spawnSpy` 恰 1 次、采样行照落。
- 判定：**通过**。

### 3. editor 豁免路径不起 PowerShell ✅

- 实现：`memory-guard.ts:672-675` `snap` hoist 到 `if (opts?.exemptChecks !== true)` 块外并初始化 `null`；`lease_acquired` 传 `snap` → editor 豁免路径第三参为 `null` → `buildSampleLine`（:1152-1172）走 `snap !== null` 的显式分支落 `machine:null`，**不进** `_snapshotCache` 读取分支，更不调 `getMachineMemorySnapshot()`。
- 测试：⑥ 第二用例 `acquireLease('editor', …, { exemptChecks: true })` → `machine === null` 且 `psSpy.not.toHaveBeenCalled()`；④ 第三用例另钉「snap 缺省 + 缓存暖 → 复用缓存、PowerShell 调用数零增量」。
- 判定：**通过**。

### 4. 多 server 并发交错 / 半行不炸报告 ✅

- 实现：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\memguard-review.mjs` `parseLines`（:112-137）逐行 try-parse：非 JSON / 非对象 / 缺壳字段（ts 非有限数、event 非串、serverPid 非有限数）各计 `badLines`；`v === 1` 且 event 未知 → `unknownEvents` 计数；`v > 1` → `futureVersion` 计数；全部 `continue` 不抛。`loadSampleFile`（:149-171）任一已存在文件不可读记 `failures`，CLI 钳退出码 2 并在报告首部提示「数据不完整」。
- 测试：fixture E 钉半行 / 非 JSON / `[]` / `{}` / 未知 event / v=2 / 空行 / ts 非数字共 5+1+1+1 计数；fixture C 输入按 ts **倒序**喂入仍正确重建；CLI 两例部分读失败（代际做成目录 / 主文件缺失而代际存在）均退出码 2 且已读部分照常出报告。
- 判定：**通过**。

### 5. 悬挂 episode 与 pid 复用 ✅

- 实现：`rebuildEpisodes`（`memguard-review.mjs:221-275`）按 `serverPid` 分段；同 serverPid 再见 `server_start` = pid 已被新 server 复用，此前未闭合段推入列表标 `resolved:false`；聚合键全程 `leaseId`（`touchProc` 以 `r.leaseId` 为 Map 键）。
- 测试：fixture C 同 pid 4242 两 leaseId 分开聚合（max 各 1500/3000MB）、两 server episode 分段；fixture D1/D2 **双向判别**——悬挂段的直进行/降级后再升级进行级统计（#6 1/2 命中、#5a 1/2 命中），排除则结论翻转（D2：三段悬挂进行分母 → 1/4 未命中）；#5b 时长集只含闭合段（D1 100% 命中，悬挂段若误入则 50% 未命中）。
- 判定：**通过**。

## 四、计划对齐（8 任务）与偏离背书

| 任务 | 计划产物 | 落地核对 | 偏离与背书 |
|---|---|---|---|
| T1 memSample 单点 | `memSample(event, fields, snap?)` / `sampleFilePath()` / `memSampleEnabled()` / `_resetForTest` 扩展 / setup.js 重定向 | 全部在场（`memory-guard.ts:1084-1240`、`test/setup.js:39-44`）；defects 110→115 五变量逐个点名 | 无 |
| T2 五事件接线 | `lease_acquired`/`spawn_started`/`spawn_reject{check}`/`idle_reap`/`exit_reap` | 全部在场，字段名与计划 Interfaces 一致 | ①无 `spawn_failed`（计划头部已声明）；②exit-watchdog 经 session-idle-timer 透传（Ruling，见第六节 R-2） |
| T3 pressure_change ×4 + degraded/recovered | 4 处切换 + 退避点/恢复点 | 全部在场（`memory-guard.ts:383/397/419/437`、`mem-watchdog.ts:92-94/140-142`）；壳对 pressure_change 省略 pressure 键 | 查⓪ `thresholds={softMB}`（Ruling，见 R-3） |
| T4 rss_sample 策略 + kill 行 + final | 五策略 / 三 kill 事件 / final sample | 策略四条 + kill 三行在场；**final sample 在目标路径不工作**（Important-1） | ①`startedAt` 取代 `_leaseBindAt`（计划前提错误，实现取事实，正确）；②压力态恒 60s（计划 `max(interval,60s)` 与 spec 矛盾，取 spec，正确） |
| T5 轮转参数化 + 采样轮转 + 审计双写 | `rotateIfNeededWith` / 8MB×4 / `auditKill` 三点 / machine-audit 补轮转 | 全部在场；`rotateIfNeeded` 对外行为不变；`GODOT_MCP_MACHINE_AUDIT_FILE` 隔离 env | ①审计行不经 `isAuditEnabled`（Ruling，见 R-7）；②不加串行链（Ruling，**见 R-11，本审不认同**） |
| T6 分析工具 | `memguard-review.mjs` + golden fixture + 常量比对 | 在场：七场景 A–G、九条判定三态、CLI 退出码 0/1/2、KILL_FACTOR 三方 / PRESSURE_RECOVER_MS / HARD_MIN_RECLAIM_MB 机械比对 | C1/C2/C3 三口径裁定（见 R-14/15/16） |
| T7 doctor sampling 行 | `sampling: on/off, …` | 在场（`doctor.ts:227-243`），四态 + 降级 + off 带原因 | 有效态=guard && MEM_SAMPLE（正确，与 memSample 短路同源） |
| T8 文档 + 0.41.0 | lookback / README 双语 / 规则双副本 / CHANGELOG / 四件套 | 全部在场；T3-M-3 回标；`[Unreleased]` 其余三项挂账保留 | ①capability-matrix 重建（计划字面作废——CI `check-tool-count` 要求，正确）；②docs/tools 页脚不提交（存量漂移，与既往五次 bump 同款） |

**Global Constraints 核对**：零新依赖 ✅（mjs 仅 node 内置；TS 仅 `fs/promises`、`module.createRequire`）；fail-open 一律 `.catch` ✅；采样文件 0600 ✅（Linux 用例 skipIf 本机未实跑，`appendFile(..., { mode: 0o600 })` 语义读码确认）；`GODOT_MCP_MEM_SAMPLE_FILE` 覆盖 ✅；规则双副本改后 STRICT rules-sync ✅（控制器证据）；无工具面变更 ✅；`[Unreleased]` 保留 ✅；非 Windows RSS 恒空采样照落 ✅（mjs 提示 + 判定报数据不足）。

## 五、跨任务整体性

### 5.1 双通道分工、失败隔离、开关语义

- **分工自洽**：采样通道 = 分析主数据（串行链保序、进程内视角）；审计通道 = 跨 server 杀可见性（多写者、无序、恒写）。三类杀事件两处都落，join 键 `leaseId`（审计行 timestamp 与采样 ts 不保证同毫秒——lookback §5 已写明）。
- **失败隔离**：采样 append 失败 → `warnSampleFailOnce`，不触审计计数；审计写失败 → `recordAuditWriteFailure`，不影响 kill 与采样（⑫③ 钉住）；轮转失败 → 采样口径重试、审计口径 best-effort，两套口径不串。
- **开关语义**：`GODOT_MCP_MEMORY_GUARD=0` 与 `GODOT_MCP_MEM_SAMPLE=0/false` 均在 `memSample` 入口短路（文件不创建级）；审计通道**不受** `GODOT_MCP_AUDIT` 控制（机器级既有契约，README/lookback/CHANGELOG 三处均披露）；doctor `sampling:` 行的有效态与 `memSample` 短路同源。三处读 env 均实时不缓存，语义一致。
- 一处需注意的交互（见 Minor-2）：`evict_exhausted` 在 hard 持续期每 poll 一行，采样通道已在 lookback §5 声明「计数偏大」，但**审计通道同样每 10s 灌一行**且无节流，文档未提。

### 5.2 串行链 + 轮转 + 跨进程锁

- **采样通道**：`_sampleAppendChain` 严格 FIFO（行序=调用序，Task 1 实测抓到 server_start 与首事件颠倒后修复）；轮转检查作为链上一环排在对应 append 之前（避免 rename 瞬间 append 落错代）；每段自带 catch → 无未处理 rejection；链不持任何跨 await 的锁 → 无死锁面；体积上限 8MB×5=40MB（轮转失败时暂增长、下条即重试）。
- **跨进程**：`<file>.lock` wx 独占创建 + 持有者存活跳过 + 死亡抢占（机制自 audit-log 原样保留）；他人在转时我方 `skipped` 后照常 append，行落旧代或新主文件均可保全；Windows 上 rename 遇我方打开中的句柄会让对方轮转失败、对方下条重试——best-effort，既有语义。
- **同进程**：采样通道由串行链保证 rotate→append 不并发；**审计通道无此保证**——这是 Important-2 的根因（第八节）。
- **双开关关闭**：`memSample` 短路在任何 fs 调用之前，⑪④ 以 `sizeChecks()===0` 钉住「连 stat 都不发生」——零触碰成立。

### 5.3 写盘侧 ↔ 读盘侧字段逐事件对账（13/13 对上）

| event | 写盘（`buildSampleLine` + 调用点） | 读盘（`analyze`） | 对上 |
|---|---|---|---|
| server_start | pkgVersion / thresholds{minFreeMB,budgetPct,maxInstances,softMB,hardMB} / declaredMB / killFactor / pollSeconds / tzOffsetMin | thresholds.minFreeMB===softMB 判 #4 前提；declaredMB/killFactor/pkgVersion 展示 | ✅ |
| lease_acquired | kind/project/leaseId/declaredMB（无 pid） | 建进程、acquired++、kind 覆盖窗 | ✅ |
| spawn_started | kind/project/leaseId/pid | started++、触发条件「≥30 进程」 | ✅ |
| spawn_reject | kind/project/check/reason/thresholds + 壳 pressure(after-state) | check===1 && reason===LOW_WATER && pressure==='normal' → #4 | ✅ |
| rss_sample | kind/project/leaseId/pid/declaredMB/rssBytes，**无 machine** | noteReading → 进程 max | ✅ |
| budget_kill | + budgetBytes/killFactor | noteReading、budgetKills、killDays | ✅ |
| evict | + ratio/reason:'hard' | noteReading、evicts | ✅ |
| evict_exhausted | envExempted{preview,editor} | 计数 + 提示 | ✅ |
| pressure_change | from/to，**无 pressure 键** | 四路分类 + episode 重建 | ✅ |
| watchdog_degraded/recovered | consecutiveRounds / {} | 计数 + 提示 | ✅ |
| idle_reap/exit_reap | kind:'game_window'/project/pid/aliveMs，machine:null，无 leaseId | 计数 → #7 | ✅ |

公共壳 `ts/v/event/serverPid` 四键 `parseLines` 强制校验，`buildSampleLine` 恒写。审计行 `AuditEntry` 9 必填字段照填、载荷进 `details`（⑫①⑫④ 逐字段断言）。

### 5.4 文档与实现一致性

- **lookback 文档**（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\memory-guard-lookback.md`）与 mjs 逐条核对：观察窗 `max(1,(末−首)/24h)` ✅；nearest-rank 与「n<40 时 P95 落在最大两个样本内」（n=20 秩 19、n=39 秩 38）✅；kind 覆盖窗五类行且 `leaseId` 为字符串 ✅；悬挂 episode 只出 #5b 时长集 ✅；#4 前提三态 ✅；退出码 2 的三种情形 ✅；§5 已知局限 12 条**逐条与实现相符**，诚实度很高。
- **两处失实**（均源于 Important-1）：§1.1「租约释放时若看门狗最近一轮有读数则补一行 final sample」与 CHANGELOG Task 4 条「短命进程末值，零 PowerShell 成本」——自然退出路径实际不触发。
- **一处措辞失准**：CHANGELOG Task 1 条「killFactor/pollSeconds 硬编码复制…Task 6 机械比对测试防漂移」——机械比对只覆盖 `KILL_FACTOR`（三方）；`pollSeconds` 是函数，测试未比对（见 Minor-3）。
- README 双语 env 表 +2 行、链接句、版本表行 ✅；规则双副本逐字一致 ✅（STRICT 证据）；规则副本 `GODOT_MCP_MEM_SAMPLE=0` 漏 `=false`（账本已搁置，Ruling）。

### 5.5 模块依赖方向与 defects 登记

- 新增依赖边仅 `memory-guard.ts → audit-log.ts`（`rotateIfNeededWith`）与 `mem-watchdog.ts → audit-log.ts`（`appendMachineAuditLine`）；`audit-log.ts` 不反向依赖任何治理模块 → **无环**。`mem-watchdog → memory-guard`、`session-idle-timer → memory-guard`、`exit-watchdog → session-idle-timer` 均为既有边；`export { memSample }` 透传零新增边。`SAMPLE_KILL_FACTOR`/`samplePollSeconds` 硬编码复制而非 import 是正确的防环选择。
- defects baseline 110→119：T1 +5（`_sampleWarnedOnce`/`_serverStartLogged`/`_sampleAppendCount`/`_lastSizeCheckAt`/`_sampleAppendChain`）、T4 +3（`_lastRssByPid`/`_sampledOnce`/`_lastSampleAt`）、T5 +1（`_sampleRotateRetry`）——与 `/^(let|const) _/` 实际计数逐个核对**无误**（`SAMPLE_*`/`PKG_VERSION` 不以下划线开头，按既有规则不计）。

### 5.6 对既有治理行为零影响

逐接线点核对：`acquireLease` 四处 `memSample` 均在 denial return 之前、决策之后，`snap` hoist 前后取值路径相同；`bindLeasePid`/`releaseLease` 在 `writeLeases` 之后；`updatePressureState` 四处在状态赋值与 console.error 之后；`killOverBudget`/`killForEviction` 在 `killPidTree` 之后、`releaseLease` 之前（`killForEviction` 的 `releaseLease` 由 killPidTree 前移到 memSample/auditKill 后，无行为差异）；`pollOnce` 的 `notePollRss` 覆盖写与 `sampleRssRows` 均在杀/驱逐判定之后、只读 `getPressureState()`；`scanIdleSessions`/`gracefulReapSessions` 在回收链之后。`appendMachineAuditLine` 新增的 `rotateIfNeeded` 仅多一次 stat，不 reject。**治理判定链路零采样依赖** ✅。

## 六、Ruling 逐条评估

账本共 30 条含 `Ruling` 的行。逐条评估：**29 条成立**，**1 条本审不认同**。

| # | 裁定 | 评估 |
|---|---|---|
| R-1 | 分支名 `worktree-feat-…` ≠ 计划名 | 成立，零成本 |
| R-2 | exit-watchdog 透传导入 memSample（不直连） | **成立**。锚是精确 import 串（`exit-watchdog.test.ts:515`），透传保持字面；exit-watchdog 本就经 session-idle-timer 传递依赖 memory-guard（`releaseGameWindowLeases`），零新增边。一点备注：`buildSampleLine` 会读 `getPressureState()` 拼 shell，退出链从此**间接读** pressure 状态——只影响 exit_reap 行的 `pressure` 字段值，不进任何决策，三期「normal/hard 同链」行为测试比的是账本故仍绿。锚若将来改为 AST 级「传递依赖」判定需同步调整 |
| R-3 | 查⓪ `thresholds={softMB}` | 成立（壳 `pressure:'hard'` 可区分）；hard 态附 `hardMB` 更准确，Minor-6 |
| R-4 | project 字段双形态不 join | 成立，文档已注明 |
| R-5 | `MemLease.startedAt` 取代 `_leaseBindAt` | 成立，少一模块级变量 |
| R-6 | 压力态采样恒 60s | 成立，计划字面与 spec 矛盾取 spec |
| R-7 | 审计行不经 `isAuditEnabled` | 成立。论证引用三条既有契约（GodotServer startup / cli audit-helper / daemon defaultAuditKill），与 T3-M-3「审计关闭时更需留痕」一致；三处文档均披露 |
| R-8 | machine-audit 隔离走专属 env | 成立，spec 隔离节原文授权 |
| R-9 | 参数化轮转须暴露失败 | 成立，工程上正确 |
| R-10 | mkdir 每事件不优化 | 成立 |
| **R-11** | **审计通道不加串行链** | **不认同**。裁定只权衡了「行序外观」与「+1 模块级变量」，**没有考虑 `appendMachineAuditLine` 在同批刚接入 `rotateIfNeeded`**，而 `rotateIfNeededWith` 的锁判定（`audit-log.ts:221`）对 `holder === process.pid` 放行——驱逐循环同 tick 连发 N 次 `auditKill` 时 N 个轮转并发执行。可执行复现见 Important-2：整代审计行丢失 + 虚假失败计数。加链是修法之一（同时修正行序），另一修法见第八节 |
| R-12 | join 键 leaseId 主键 | 成立 |
| R-13 | T6/T7 提交前不强制全量 | 成立，T8 已全量 |
| R-14 | #3 触发条件按字面 | 成立 |
| R-15 | 观察窗 `max(1,…)` | 成立，落实 spec 括注 |
| R-16 | 触发条件不满足退出码 1 | 成立，与「攒多少数据才动手」门槛语义一致 |
| R-17 | 悬挂 episode 仅出 #5b 时长集 | 成立，D1/D2 双向判别证据充分 |
| R-18~21 | doctor 有效态 / 前缀 / 恒带 size 与 no readable event / fmtAgo | 均成立，N6 目的（用户自证采样在跑）论证到位 |
| R-22 | 全量门禁合并为一次 `test:coverage` | 成立 |
| R-23 | `GODOT_MCP_MACHINE_AUDIT_FILE` 不入 README | 成立（与两个同类 env 一致）；备注：想重定向 machine-audit 的用户需读 CHANGELOG 才知道 |
| R-24 | 规则双副本头部版本行不动 | 成立，与三期同款 |
| R-25 | package-lock 不纳入 | 成立 |
| R-26 | docs/tools 页脚 diff 还原 | 成立，存量漂移须上报用户（账本已标） |
| R-27 | capability-matrix 重建 | 成立，计划字面错误（CI `check-tool-count` 要求） |
| R-28 | CHANGELOG 相对路径 | 成立 |
| R-29 | 四条文档精度 minor 并入 fix round | 成立 |
| R-30 | 规则副本漏 `=false` 不改 | 成立但建议：0.41.0 尚未 publish，若门禁允许随发版提交补上，否则下版（Minor-7） |

## 七、延后小问题 triage（账本全部 40 条 `minor (deferred)` / `minor (搁置)` / `观察`）

**合并前必修：无。**（本审新发现的两条 Important 不在此列，见第八节。）

| 组 | 条目（账本原文摘要） | 去向 | 理由 |
|---|---|---|---|
| A 采样写盘 | T1 mkdir 每事件；T1 `...fields` 展开位序可覆写 ts/v/event/serverPid；T1 显式 server_start 重复；T5 %500 节奏链上读计数；T5 skipped 清重试标志 | 记入挂账 | 均无现有触发路径或影响有界（≤1000 条 append 查一次 / 对方正转则文件终会被转）。`...fields` 移到壳键之前是一行改动，顺手时做 |
| B 事件语义 | T2 forceReap 不发 exit_reap；T2 exit_reap aliveMs 含 kill 链等待；T3 零租约 recovered；T4 evict rssBytes 推算；T4 evict_exhausted 每 poll 一行；T4 簿记滞后一轮 | 记入挂账 | 均已在 lookback §5 如实声明。evict_exhausted 对**审计通道**的灌入未声明（Minor-2），建议加节流 |
| C 测试基建 | T5 auditInflight 三处重复；T5 memory-guard.test 未排水；T6 killDays 同式推导；T6 toContain('命中') 弱断言；T7 panelWithGuard 重复；T7 statSync vi.fn 脆弱；T7 残片分支无黑盒测试 | 记入挂账 | 测试质量项，不影响行为 |
| D 分析工具 | T6 #4 前提三态缺「不可核」；T6 from/to 四路分类写两遍；**T6 SAMPLE_ROTATE_KEEP 未机械比对**；T6 零进程 kind 在 #3 得 miss；T6 spawnFailed 钳 0 掩盖截断；T6 MEM_SAMPLE=0 时段不可反推；T6 MJS:376 注释误导；T6 #1 detail 文案声明混合配对误导；T6 loadSampleFile 不持锁 | 记入挂账 | 全部可在后续迭代处理。**SAMPLE_ROTATE_KEEP 建议优先**：`SAMPLE_ROTATE_KEEP` 已 export，加一条读源码文本比对是 3 行测试；否则源码改 5 代时 mjs 静默漏读 `.5` |
| E doctor | T7 existsSync 吞非 ENOENT + TOCTOU；T7 fmtBytes 进位带；T7 已知瞬态（唯一一行未写完） | 记入挂账 / 接受 | 诊断行，无害 |
| F 文档 | T8 lookback:23 括注 leaseId 贯穿拒绝；T8 lookback:32 条件句式；T8 README 版本表「公共壳带 leaseId」不精确；T8 spec:59/:79 旧口径；T8 lookback 全绝对路径（搁置）；T8 规则副本漏 `=false`（搁置） | 记入挂账 | lookback 已声明「设计文档字面与实现不一致处以本文档为准」。规则副本 `=false` 建议随发版或下版（Minor-7） |
| G 既有环境观察 | 全量泄漏 ~58 行到真实 machine-audit；夹具 `project.godot` 被改写；changelog-sync 裸日期空转；docs/tools 页脚漂移 | 上报用户，非本批 | **与本批的交互**：本批给 machine-audit 新接 10MB 轮转，既有泄漏会让该文件更快越过 10MB——首次轮转本身是期望行为，但也让 Important-2 的「文件超 10MB + 同 tick 并发」前置条件在开发机上更早可达。Important-2 修复后此交互无负面后果 |

## 八、发现的问题

### Critical（必须修）

无。

### Important（应当修，合并前）

#### Important-1　final sample 在自然退出路径（其设计目标）不触发；`_lastRssByPid` 条目随之泄漏

- **位置**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts:815-833`（`releaseLease`）、`:289-300`（`listActiveLeases` 读时清理规则①「pid 非 null 且死 → 删」）、`:1075-1080`（`_lastRssByPid` / `notePollRss`）。
- **机理**：`releaseLease` 第一步 `const leases = listActiveLeases()` 带读时清理——pid 已死的租约在 `find` 之前就被过滤并回写盘，`target === undefined`，final sample 整段跳过。而 7 处 spawn 漏斗的自然退出路径（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\gdscript-executor.ts:1028`、`src\tools\spawn-helper.ts:111`、`src\screenshot.ts:127`、`src\core\headless-process.ts:76`、`src\tools\runtime.ts:561`、`src\GodotServer.ts:724` 的 `child.on('close')`）全部在进程已死时调 `releaseLease` → 全部走不到。final sample 唯一成立的分支是 `releaseLease` 时进程仍活——即 kill 路径（`killPidTree` 异步，`releaseLease` 紧随其后），而该路径的 final 行与 `budget_kill`/`evict` 行同读数、纯冗余。
- **为何重要**：spec「RSS 采样策略」明文「final sample：漏斗 releaseLease 处（**自然退出路径**）…短命进程的末值」；CHANGELOG 0.41.0 Task 4 条与 lookback §1.1 均声称成立——**文档失实**。进程在两次轮询之间退出（恰是 final sample 要捕的场景）只剩首采下界。Task 4 测试 ⑩⑦ 用 `mockKillProbe(new Set([4242, 5555]))` 让假 pid 在释放时「存活」，恰好只覆盖了非目标分支，给了假信心。附带：`_lastRssByPid` 该 pid 条目因 `target === undefined` 永不删除，与注释「读后即删」不符（量级有界、无误关联——清理先行反而挡住了 pid 复用误读）。
- **复现**（HEAD build，守卫与采样均开）：对 pid 已死的租约 `notePollRss` 后 `releaseLease` → 采样文件**连创建都没有**（0 行）；对照 pid 存活 → final 行正常落。
- **修法**：final sample 的租约查找不要经带清理的 `listActiveLeases()`。首选 `pollOnce` 按 leaseId 快照 `{pid, kind, projectPath, declaredMB, rssBytes}`（替代 `_lastRssByPid` 的 pid 键），`releaseLease` 按 leaseId 查快照、命中即落行并删——不依赖账本状态，同时根治泄漏与「读后即删」失实；长时间无人释放的条目加时间戳 TTL 兜底清理。次选 `releaseLease` 先 `readLeases()`（模块私有、无清理）再 `listActiveLeases()`——更小但若中途有别的 `listActiveLeases` 调用（heartbeat/并发 acquire）已清盘仍会漏。**补测试**：不 mock `process.kill`（或 mock 为 ESRCH）让 pid 在释放时已死，断言 final 行仍落；同步改 lookback §1.1 / CHANGELOG 措辞（若选择不修则改为诚实声明）。计划层面：Task 4 Interfaces 写的「releaseLease final sample 从此表取」未计入 `listActiveLeases` 的读时清理——属计划前提缺口，非实现者偏离。

#### Important-2　同进程并发 `appendMachineAuditLine` 触发并发轮转 → 审计整代丢失 + 虚假失败计数

- **位置**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\audit-log.ts:221`（锁判定 `holder !== process.pid && isPidAlive(holder)` 才 skip——**同 pid 重入放行**）、`:520-526`（`appendMachineAuditLine` 本批新接 `rotateIfNeeded`）；触发源 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts:216-226`（`auditKill` fire-and-forget）、`:240-270`（`evictForHardThreshold` 同步循环，同 tick 可连发 evict×N + evict_exhausted）。
- **机理**：N 个 `appendMachineAuditLine` 在同一同步段内启动，各自 `await mkdir` → `await rotateIfNeeded` → `stat` 都看到 >10MB → 第 1 个 wx 获锁；第 2..N 个 wx 失败后读到持有者是**自己的 pid** → 不 skip → 覆盖锁继续轮转 → 第二个 `rm .3` 删掉第一个刚推上来的代，随后 `rename main→.1` 因主文件已被第 1 个移走而 ENOENT → `failed` → `recordAuditWriteFailure`。
- **复现**（HEAD build）：预置 main=A(>10MB) / .1=B / .2=C，`Promise.all` 三次 append → 结果 `.2=A, .3=B`，**C 整代丢失**，`.1` 缺失，链错位，`getAuditFailureStats().failures` +2；对照逐个 `await` → 4 文件齐全、0 失败。
- **为何重要**：machine-audit 是「最高危面不可抵赖」的审计通道；触发场景恰是 hard 阈值驱逐（机器最吃紧、最该留痕的时刻），且该文件在本批前**没有轮转**，所以这是本批**新引入**的暴露面。触发概率低（需文件恰已超 10MB + 同 tick ≥2 次 kill），但后果是至多 10MB 审计历史不可恢复地丢失 + 误导性的失败告警。既有全量测试向真实 machine-audit 泄漏 ~58 行/次，开发机上该文件 8.94MB 正逼近阈值。现有测试 ⑫④ 注释已承认「同一 tick 连发的两行落盘先后不保证」——并发已知，但只按行序问题接受，未考虑轮转。
- **修法**（二选一）：
  (a) `appendMachineAuditLine` 进程内串行——模块级 promise 链（与 `_sampleAppendChain` 同款，+1 变量登记 defects），顺带修正行序；同时建议给 `appendAuditLine` 也加（项目审计 + 外置副本各一次 `rotateIfNeeded`，同暴露面，既有问题）。
  (b) `rotateIfNeededWith` 对 `holder === process.pid` 也返回 `skipped`——改动最小，但会牺牲「前代进程死时留下同 pid 陈旧锁」的恢复路径，需配锁文件 mtime 判陈旧。
  **补测试**：超 10MB 文件 + 并发 3 次 `appendMachineAuditLine` → 代际 A/B/C 全在、失败计数不变。
- **与 Ruling 的关系**：直接反驳 R-11「审计通道不加串行链」——裁定的代价评估「同 tick 两行先后可能颠倒（外观问题）」漏掉了轮转。

### Minor（建议改）

1. **exit_reap 落盘在退出链上 best-effort**——`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\exit-watchdog.ts:151` `gracefulReapSessions` 的 `memSample` 在 `await Promise.all(killProcess)` 之后入链；index.ts 的 gracefulShutdown 并行推进，若先 `process.exit` 则 appendFile 未完成即丢（既有 `console.error` 行有同样暴露但 stderr 同步）。建议 lookback §5 补一句「退出链上的采样行 best-effort」。
2. **`evict_exhausted` 无节流灌审计通道**——hard 持续且无可杀候选时 machine-audit 每 poll（10s）一行，约 2MB/天。采样侧已声明「计数偏大」，审计侧未提。建议按 hard episode 首次或 N 分钟节流（`mem-watchdog.ts:251-253`）。
3. **CHANGELOG 措辞**——Task 1 条「killFactor/pollSeconds 硬编码复制…Task 6 机械比对测试防漂移」：机械比对只覆盖 `KILL_FACTOR`（三方相等）；`pollSeconds` 是函数未被比对。改为「killFactor 经机械比对；pollSeconds 仅注释登记」。
4. **`rotateSampleIfNeeded` 的 `skipped` 清重试标志**——`memory-guard.ts:1211-1226`：轮转失败 → retry=true → 下条 append 遇他人在转 → `skipped` → retry 被清 → 若对方轮转随后失败（Windows 上我方 append 句柄致其 rename 失败），双方都失败且我方要等 500 边界。低概率；改 `skipped` 不清标志即可。
5. **`idle_reap` 不带 leaseId**——`session-idle-timer.ts:42-48` 的 `releaseGameWindowLeases(project)` 已按项目反查到租约，leaseId 唾手可得；带上后分析端可把回收行并入进程时间线。lookback 已如实写「无 leaseId」，非缺陷。
6. **查⓪ spawn_reject 在 hard 态 `thresholds: {softMB}`**——`memory-guard.ts:695`：拒因是硬阈值却只附 softMB；壳 `pressure:'hard'` 可区分，但 thresholds 字段对 hard 态误导。hard 态附 `hardMB`。
7. **规则副本 `GODOT_MCP_MEM_SAMPLE=0` 漏 `=false`**（账本已搁置）——0.41.0 尚未 publish，若 `check-rules-version-bump` 允许随发版提交补上则补，否则下版。

## 九、做得好的地方

- **串行链解决真实竞态**：Task 1 连跑回归实测抓到 `server_start` 与首事件行序颠倒（libuv 线程池完成序不确定），改 `_sampleAppendChain` 后行序=调用序；轮转检查被正确地放在链上而非另起并行链——这个设计决策在 ⑪ 系列用例里被精确钉住（`sizeChecks()` 计数）。
- **fail-open 纪律贯彻到底**：每个 fire-and-forget 都挂 catch；⑫③ 显式挂 `process.on('unhandledRejection')` spy 断言零调用——这是对「未处理 rejection 崩进程是红线」最直接的证据形式，而不是只断言「没抛」。
- **测试用真实文件系统**：所有轮转/追加/权限用例都落真实 tmp 文件，部分 mock 一律 `importOriginal` 保真；⑪③ 用「最老代位置放目录」这种文件系统事实注入轮转失败，而不是 mock `rename`。
- **双向判别 fixture**：D1/D2 让「悬挂段排除与否」在两个方向上都能翻转结论，而非只钉一个方向——这是防止实现与测试同向出错的正确姿势。fixture G（声明混合、ratio 序≠mb 序）由审查发现并修成回归钉子。
- **常量三方机械比对**：`KILL_FACTOR` 在 mjs ↔ watchdog ↔ guard 三处复制，测试读源码文本抽取（含 `5 * 60_000` 表达式求值）——把「注释登记不构成防线」的教训落成了测试。
- **治理零影响的实现纪律**：全部接线 bare 调用、在决策之后；`snap` hoist 不改语义；editor 豁免路径用 `psSpy` 零调用钉死而非只看 `machine:null`。
- **文档诚实度**：lookback §5 已知局限 12 条逐条与实现相符（含「evict.rssBytes 是推算值却计入 max」「#2 用脚本硬编码 KILL_FACTOR 而非快照」这类对自己不利的声明）。
- **控制器裁定留痕质量高**：每条 Ruling 带「代价若错」，绝大多数论证引用了既有契约原文，可追溯。

## 十、Declined to judge（考虑过但搁置的行为，逐行）

- `appendAuditLine`（项目审计 + 外置副本）同样存在同进程并发轮转暴露——既有问题，非本批引入；但 Important-2 的修法 (a) 顺带覆盖，列入建议。
- web GUI「重启本实例」路径（`GodotServer.ts:753` 直接 `close()` → `process.exit(0)`）不经 exit-watchdog，不发 `exit_reap`——计划只点名 `gracefulReapSessions`，超范围。
- `_lastRssByPid`/`_sampledOnce`/`_lastSampleAt` 在 server 长期运行下的内存量级——条目数 ≤ 本 server 曾 spawn 的 pid 数，字节级，不构成问题（泄漏的语义问题并入 Important-1）。
- `PKG_VERSION` 在模块加载期 `createRequire` 读 package.json，缺失即 import 抛——npm 包内恒存在，同 web-gui 先例。
- `GODOT_MCP_MEM_SAMPLE_FILE=''`（空串）→ `??` 不视为未设 → 路径 `''` → append ENOENT 同因去重 warn——用户误配置边缘，与 `GODOT_MCP_MACHINE_AUDIT_FILE` 同读法。
- `rebuildEpisodes` 对「进入行已轮转掉、只剩 hard→pressure 降级行」的情形会以降级行为起点开一段（`downgrades=1, hardEntries=0`）——右删失，方向是低估 #5a，文档「孤立闭合行」只覆盖了闭合侧；影响极小。
- `evict_exhausted` 每 poll 一行进**采样**通道——lookback §5 已声明「计数偏大」，接受。
- doctor `sampling:` 行放在 Memory guard 段外层 try 内，`buildMemoryPanel()` 抛错时该行不输出——面板都失败时不显示采样行可接受。
- 非 Windows 无 RSS 通道 → #1/#2/#8 恒数据不足——spec 明文 Windows-only，工具以提示报出。
- 规则副本头部版本行仍 `v0.39.0+` 而正文写「四期采样（0.41.0+）」——与三期同款，门禁以 HEAD 为基线，接受。
- 账本「观察」四项（全量泄漏 58 行 / 夹具 project.godot 改写 / changelog-sync 裸日期空转 / docs/tools 页脚漂移）——既有，控制器已标「须上报用户」；与本批的交互已在第七节 G 组注明。
- `package-lock.json` 脏——worktree `npm install` 噪音，裁定不纳入，接受。

## 十一、结论

**Ready to merge? With fixes**

**理由**：Review Focus 五条全部有实现 + 真实 fs 测试双重锚定且定向复跑全绿（7 files / 223 passed / 0 failed）；13 事件写盘↔读盘字段逐一对上；lookback 文档 §5 已知局限与实现逐条相符；治理行为零影响；30 条裁定中 29 条成立。但两条 Important 均有可执行复现且修法小而明确：**Important-1** final sample 在其设计目标路径（自然退出）因 `listActiveLeases` 读时清理先行而完全不触发，测试夹具恰好绕开、文档声称失实；**Important-2** 本批给 machine-audit 新接轮转后，同进程并发 append（驱逐循环天然连发）在文件超 10MB 时导致审计整代丢失，Ruling R-11 的代价评估漏掉了这一面。两条修完（含各补一条钉住目标分支的测试、同步 lookback/CHANGELOG 措辞）即可合并；40 条延后小问题无一需合并前修，其中 `SAMPLE_ROTATE_KEEP` 机械比对建议下批优先。

---

## 十二、终审修复波复核（2026-11-24）

> 本节由控制器在范围性复审完成后追加；第一至十一节保持终审当时（`ad32fcb5`）的原貌，不回改。
> **修复范围**：`ad32fcb5..479aa80e`（3 提交：`013fc718` fix(core) / `2dcf80e6` docs(p4) / `479aa80e` test 弱断言收紧；10 文件 +261/−53）。
> **复审方式**：一名 fresh 复审者只看修复包，逐条判定终审发现是否解决、核对具名风险，并另写独立脚本复验行为（不依赖修复者的测试）。

### 12.1 结论

**Ready to merge? Yes。** 修复波涉及的发现全部解决，没有引入新的致命/重要破坏；残留 2 条非承重 Minor，停放并记裁定（12.3）。

### 12.2 逐项判定

| 终审发现 | 落地 | 复审判定 |
|---|---|---|
| Important-1 final sample 在自然退出路径不触发、pid 键条目泄漏 | 读数表改为按 leaseId 键的快照 `_lastRssByLease`（值含 pid/kind/projectPath/declaredMB/rssBytes/at）；`releaseLease` 首句 `emitFinalRssSample(leaseId)`，先于 dummy 早退与 `listActiveLeases()`；读后即删 + 10min TTL（每次 `notePollRss` 写入前清扫）+ `_resetForTest` 清表。测试补「释放时 pid 已死、账本已无该租约，final 行仍落」与 TTL 边界两侧。 | ADDRESSED |
| Important-2 同进程并发 `appendMachineAuditLine` 触发并发轮转 | `mkdir → 轮转检查 → appendFile` 整段进进程内串行链 `_machineAuditChain`（每段自带 catch，链恒为已决态；返回的 promise 照常 reject，调用方的失败计数语义不变）。`appendAuditLine` 与 `rotateIfNeededWith`（含同 pid 放行）未动。测试补「并发 3 次三代全在」与链失败隔离两例；defects baseline 119→120。 | ADDRESSED |
| Minor-4 `skipped` 清重试标志 | 只有 `rotated` 才清 `_sampleRotateRetry`，`skipped` 既不置位也不清。测试补「失败 → 他人持活锁 skipped → 标志保留 → 锁释放后下一条即轮转」。 | ADDRESSED |
| Minor-1 / 2 / 3 | lookback 补「退出链采样行 best-effort」与 `evict_exhausted` 审计侧说明（仅文档，未实现节流）；CHANGELOG 把机械比对范围改准为仅 `KILL_FACTOR`。 | ADDRESSED |
| 顺带项 | `SAMPLE_ROTATE_KEEP` 机械比对测试；lookback 的 `spawn_reject` leaseId 表述改准（恒无）；README 版本表措辞；因修复而变的 lookback / CHANGELOG 同步。 | ADDRESSED |
| 补充项：三处 `machine` 非空断言 | 收紧为精确值，弱断言计数回到 master 基线 911。 | ADDRESSED |

**复审者的独立复验**（对 HEAD 的 `build/core`，零 mock，12/12 PASS）：

- final sample：真 node 子进程 + 真 PowerShell RSS 读数下，释放时 `process.kill(pid, 0)` 得 ESRCH、账本的内存态与盘面都已无该租约，final 行仍落且字段全取自快照，重复释放不重复落；被看门狗树杀的进程得 `budget_kill` 行 + 恰 1 行 final + 1 行审计；超窗快照不落、窗内落；dummy 租约 id 不误取他人快照。
- 并发轮转：旧函数体等价物两轮 32 次中 26 次损坏（整代丢失 10 次、行序错乱 21 次、失败计数虚增 4 次），新实现 8/8 全对。
- 串行链：首段失败时调用方拿到 reject，故障消除后后续段照落。

**检查**：定向 vitest 5 文件 158 passed / 1 skipped；`npx tsc --noEmit` 与 `npx tsc --noEmit -p tsconfig.test.json` 均 exit 0；`check:test-quality` 911。全量、coverage、lint 复审未重跑，以修复波门禁为准（530 文件 / 8201 passed / 98 skipped / 0 failed；coverage 82.58 / 75.07 / 85.75 / 84.34；lint 533 warnings / 0 errors）。

### 12.3 残留项（停放，带裁定）

1. **`releaseLease` 内的语句顺序**（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts:816-822`）：`emitFinalRssSample` 排在账本移除之前，采样路径唯一的同步抛点 `os.homedir()` 一旦抛错，租约不会被移出账本。**裁定：停放。** 触发前提是该进程已有 RSS 快照（跑过至少一轮 Windows 轮询），而同模块的租约文件路径与实例注册表路径同样解析 `homedir()`——`homedir()` 抛错的环境里守卫的其余路径一样失灵，不是这条语句序独有的缺口；租约最终仍被读时清理（pid 已死）。若要加固，正确形状是给 `memSample` 的同步入口整体加 try/catch（让「绝不抛」的文档契约覆盖全部 20 处调用点），而不是在 `releaseLease` 里挪语句。代价若错：该环境下租约在账本多滞留到下一次读。
2. **lookback 文档措辞**（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\memory-guard-lookback.md:42`）：「超 10 分钟无人释放的快照自动回收」未写清理时机。实现是下一次 `notePollRss` 写入时惰性清理——RSS 通道停摆期间不回收，释放时也不按 TTL 拒绝。**裁定：停放。** CHANGELOG 的「10min TTL 惰性清理」是准的。代价若错：永久文档一句少四个字。

### 12.4 复审的范围外观察

- 修复报告称「忘记 `.catch` 也不会触发 unhandledRejection」，不成立：链尾 catch 只保证链自身恒为已决态，返回的 promise 照常 reject，调用方漏写 `.catch` 仍触发 1 次（与修复前行为一致）。代码无误，仅修复报告措辞有误；该报告随执行工作区删除，此处留档。
- `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\CHANGELOG.md` 的 [0.41.0] Task 2 条「leaseId 拒绝时未生成则字段整个缺席」是条件句式，实现上恒缺席（四处 `spawn_reject` 都在租约创建之前）。挂账。
- `check:test-quality` 弱断言 911 > 上限 860、vitest `globalSetup` 每次运行改写已跟踪夹具 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\fixtures\gdscript-check\project.godot`、`appendAuditLine` 的同进程并发轮转暴露——均为既有问题，见第十节。
