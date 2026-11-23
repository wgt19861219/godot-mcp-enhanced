# memory-guard 四期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 治理事件采样落盘双通道（杀事件入既有 machine-audit 清偿 T3-M-3 + 独立采样 JSONL）+ 档位回看判定标准 9 条 + `memguard-review.mjs` 只读分析工具。

**Architecture:** memSample 单点旁挂（fire-and-forget appendFile + fail-open catch），事件接线覆盖准入/生命周期/pressure/杀/rss 六类；轮转复用 `audit-log.ts` `rotateIfNeeded` 参数化；分析工具零依赖 mjs 按 leaseId 聚合、9 条判定三态输出。

**Tech Stack:** TypeScript（src/core）、零依赖 ESM mjs（scripts）、Vitest。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-23-memory-guard-p4-design.md`（v2 已批准）——计划从 spec 论证，executor 同时读两份。

## 对设计的两处偏离说明（executor 无需决策，已裁定）

1. **不新增 `spawn_failed` 事件行**：spawn 失败数由分析端 `lease_acquired − spawn_started` 差值推导——7 处漏斗逐处接线重复且新漏斗易漏，单点 bindLeasePid 已覆盖 `spawn_started`；失败原因本就在工具报文/stderr，采样流不重复。spec 事件清单少此一行，聚合口径不受影响。
2. **`final rss` 的最近读数源**：watchdog pollOnce 的 rssMap 是局部变量——mem-watchdog 增模块级 `_lastRssByPid: Map<number, number>`（每轮 poll 覆写），releaseLease final sample 从此表取（记入 defects baseline 点名清单）。

## Global Constraints

- 分支 `feat/memory-guard-p4`（worktree 隔离）；版本 bump 0.40.1→0.41.0（minor，规则模板变更触发硬门禁）四件套；**bump ≠ 发版**（npm publish/tag 待用户指令，AGENTS.md N-C）
- 零新依赖；`npm run lint` 基线 533 warnings 0 errors；`npm run test:coverage` 基线 82.4/74.92/85.59/84.18 不回退
- `module-level-mutable-state` baseline 110→+N：新增模块级变量**逐个点名**登记 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\regression\defects.ts` 注释（当前基线值 110）
- 写盘一律 fail-open：`void appendFile(...).catch(...)`——未处理 rejection 崩进程是红线
- `GODOT_MCP_MEMORY_GUARD=0` 与 `GODOT_MCP_MEM_SAMPLE=0/false`（实时读 env 不缓存）双双零写盘
- 采样文件 `~/.godot-mcp/memory-guard-events.jsonl` 权限 0600；路径可经 `GODOT_MCP_MEM_SAMPLE_FILE` 覆盖
- 改规则双副本（`src\tools\rule-templates.ts` + `.claude\rules\godot-mcp-core.md`）后必跑 `npm run build` + `STRICT=1 npm run check:rules-sync`
- 无工具面变更：capability-matrix 不重建、verify_delivery 不适用
- 文档引用一律绝对路径；`[Unreleased]` 段保留（T3-M-3 回标，其余挂账不动）
- 非 Windows：RSS 通道恒空——采样照落（无 rssBytes 字段），分析工具报 Windows-only

## Review Focus（spec 隐含、无任务测试会咬人的五类——各钉进 owning task）

1. **开关关零写盘**（guard=0 或 MEM_SAMPLE=0 时任何路径不创建文件——测试环境的真实 home 防污染）→ Task 1 Step 测试钉
2. **appendFile 失败不崩进程且不刷屏**（磁盘满/权限拒：首次 warn 一行、后续静默、进程活着）→ Task 1 测试钉
3. **editor 豁免路径不起 PowerShell**（exemptChecks:true 时 machine=null 而非新起快照——冷缓存同步 2×5s 打脸延迟承诺）→ Task 2 测试钉
4. **多 server 并发交错/半行**（分析端逐行 try-parse 跳坏行计数，不炸整份报告）→ Task 6 golden fixture 钉
5. **悬挂 episode 与 pid 复用**（server 崩溃无 to:'normal' 闭合行→unresolved 丢弃；14 天窗口两进程同 pid→leaseId 分开聚合）→ Task 6 fixture 钉

---

### Task 1: memSample 采样单点 + server_start + 开关/路径/隔离基建

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`（模块尾部 `_resetForTest` 附近新增采样区）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\setup.js`（尾部加采样文件 tmp 重定向）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\memory-guard-sample.test.ts`（新建）

**Interfaces:**
- Produces: `memSample(event: string, fields: Record<string, unknown>, snap?: MachineMemorySnapshot | null): void`——**同步签名、内部 fire-and-forget**；公共壳自动拼 `ts/v/serverPid/kind?/project?/leaseId?/pid?/machine?/pressure?`（fields 传入的专有字段直铺；`snap` 为 `null` 显式落 `machine:null`，缺省 undefined 时尝试读 `getMachineMemorySnapshot()` 缓存——**只读缓存不触发新采样**，缓存冷时落 null）；`sampleFilePath(): string`（env `GODOT_MCP_MEM_SAMPLE_FILE` 优先，默认 `join(homedir(), '.godot-mcp', 'memory-guard-events.jsonl')`）；`memSampleEnabled(): boolean`（`GODOT_MCP_MEM_SAMPLE` 非 `0`/`false` 即开，实时读）
- Produces: `_resetForTest()` 扩展清 `_sampleWarnedOnce`/`_serverStartLogged`/`_sampleAppendCount`/`_lastSizeCheckAt`
- Consumes: 既有 `memoryGuardEnabled()`/`getMachineMemorySnapshot()`/`getPressureState()`/`declaredMBFor()`/`minFreeMB()`/`budgetPct()`/`maxMachineInstances()`/`pressureSoftMB()`/`pressureHardMB()`（后两者为模块私有，同模块直调）

- [ ] **Step 1: test/setup.js 尾部加隔离**（对齐 12-31 行 AUDIT_EXTERNAL_DIR 先例）

```js
// memory-guard 四期:采样文件重定向到临时目录——memSample 默认开,不重定向则任何
// 走真实采样的测试写真实 ~/.godot-mcp/memory-guard-events.jsonl。采样专属测试自行覆盖本值。
process.env.GODOT_MCP_MEM_SAMPLE_FILE = join(
  mkdtempSync(join(tmpdir(), 'mcp-mem-sample-')), 'memory-guard-events.jsonl',
);
```

- [ ] **Step 2: 写失败测试**（新建 `test\core\memory-guard-sample.test.ts`）覆盖：
  - `memSample('lease_acquired', {...})` 追加一行 JSON：壳字段（ts/v/serverPid/pressure）+ 专有字段直铺；文件 0600 权限（Windows 上断言创建成功即可，权限断言 `skipIf(!IS_LINUX)`——Windows 无 chmod 语义）
  - `server_start` 惰性首发：进程内首个 memSample 调用前自动先落一行 server_start（含 pkgVersion/thresholds{minFreeMB,budgetPct,maxInstances,softMB,hardMB}/declaredMB 四档/killFactor 四档/pollSeconds/tzOffsetMin），且**只发一次**（第二次 memSample 不再附）
  - `GODOT_MCP_MEMORY_GUARD=0` → memSample 短路，文件不创建
  - `GODOT_MCP_MEM_SAMPLE=0` / `=false` → 同上短路（两个值都测）
  - `snap=null` 显式落 `machine:null`；`snap` 缺省且缓存冷（`_resetForTest` 清缓存后）→ `machine:null` **且不起 PowerShell**（spy `_psRunner` 未被调用）
  - fail-open：appendFile reject（路径指向不可写目录）→ 不抛、console.error 首次一行 warn、第二次静默、进程活着

- [ ] **Step 3: 跑测试确认红**——`npx vitest run test/core/memory-guard-sample.test.ts`，期望 FAIL（memSample 未定义）

- [ ] **Step 4: 实现**（memory-guard.ts 采样区，约 120 行）

要点：模块级 `_sampleWarnedOnce`（Set<string> 同因去重 warn）、`_serverStartLogged`（boolean）、`_sampleAppendCount`/`_lastSizeCheckAt`（Task 5 轮转用，先占位递增）；`void appendFile(path, line, { mode: 0o600 }).catch(err => warnOnce(err))`——mode 仅首建生效（appendFile 语义）；server_start 的 killFactor 表从 `mem-watchdog.ts` import `KILL_FACTOR`（既有 export）；写盘前 `mkdir(dirname, { recursive: true })` 同 catch 包裹。

- [ ] **Step 5: 跑测试确认绿 + 全文件回归**——`npx vitest run test/core/memory-guard-sample.test.ts test/core/memory-guard.test.ts`（后者确认 `_resetForTest` 扩展零破坏）

- [ ] **Step 6: Commit**——`git commit -m "feat(core): memSample 采样单点——公共壳/server_start 惰性首发/fail-open/双开关/0600/测试隔离"`

### Task 2: 准入与生命周期事件接线（lease_acquired/spawn_started/spawn_reject/idle_reap/exit_reap）

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`（acquireLease 成功/拒绝分支、bindLeasePid）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\session-idle-timer.ts:60-86`（scanIdleSessions 回收点）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\exit-watchdog.ts`（优雅回收收尾点）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\memory-guard-sample.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 `memSample(event, fields, snap?)`
- Produces: 五事件行形态（后续 Task 6 分析端依赖字段名——**字段名即接口**）：`lease_acquired{kind,project,leaseId,declaredMB}`（machine 用查⓪-③ 已取的 snap；editor exemptChecks 路径传 null）；`spawn_started{...壳,leaseId,pid}`；`spawn_reject{kind,project,leaseId?,check:0|1|2|3,reason:DenialCode,thresholds:{当时判定阈值}}`；`idle_reap{kind:'game_window',project,pid,aliveMs,machine:null}`；`exit_reap{同 idle_reap}`

- [ ] **Step 1: 写失败测试**：
  - acquireLease 成功 → lease_acquired 行落盘（含 declaredMB=declaredMBFor(kind)）
  - editor 路径 `acquireLease('editor', p, { exemptChecks: true })` → 行落且 `machine:null` **且 spy 确认未起 PowerShell**（Review Focus 3）
  - 查⓪/查①两拒绝（既有 ⑫ 测试同款夹具推进 pressure / 构造低水位快照）→ spawn_reject 行 `check:0` 与 `check:1`、reason 均 MEMGUARD_LOW_WATER——**同一 code 不同 check 必须可分**
  - bindLeasePid → spawn_started 行（pid 非 null）
  - scanIdleSessions 回收 → idle_reap 行 aliveMs>0（**M3 坑：断言非零**——clearRunSession 后 processStartTime 恒 0，接线必须先捕获）
  - exit-watchdog 优雅回收 → exit_reap 行
- [ ] **Step 2: 红**——跑确认新 describe FAIL
- [ ] **Step 3: 实现接线**：
  - acquireLease 成功 return 前 `memSample('lease_acquired', {...}, opts?.exemptChecks === true ? null : snap)`——editor 分支 snap 未取（`:662` guard 内才有），传 null
  - 拒绝 return 前 `memSample('spawn_reject', { check, reason, thresholds }, snap)`——四个查点各自传 check 序号（查⓪=0 水位=1 预算=2 实例=3）；leaseId 在拒绝时尚未生成，省略
  - bindLeasePid 末尾 `memSample('spawn_started', { kind, project, leaseId, pid })`
  - scanIdleSessions：`clearRunSession` **之前**捕获 `proc.pid`/`s.processStartTime`/`entry.projectPath`，回收后 `memSample('idle_reap', { kind:'game_window', project, pid, aliveMs: now - s.processStartTime }, null)`
  - exit-watchdog 收尾链同款（exit_reap）；两处 import memSample（同目录模块）
- [ ] **Step 4: 绿 + 回归**——sample 文件全绿 + `npx vitest run test/core/memory-guard.test.ts test/core/session-idle-timer.test.ts test/core/exit-watchdog.test.ts`（接线不破坏既有 270 行正交性测试）
- [ ] **Step 5: Commit**——`feat(core): 准入/生命周期五事件接线——lease_acquired/spawn_started/spawn_reject(check 序号)/idle_reap/exit_reap`

### Task 3: pressure_change（4 处切换）+ watchdog_degraded/recovered

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`（updatePressureState 4 处切换点：`:372-381` hard→pressure、`:388-400` 任意→hard、`:412-422` normal→pressure、`:427-439` pressure→normal）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`（noteDegrade 退避点 `:80-93` 与恢复点 `_consecutiveDegrades=0`）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\memory-guard-sample.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 memSample
- Produces: `pressure_change{serverPid,from,to}`（**省略公共壳 pressure 字段**——from/to 即态；machine 带，用喂入的 snap）；`watchdog_degraded{consecutiveRounds}` / `watchdog_recovered{}`

- [ ] **Step 1: 失败测试**：既有 ⑫ 状态机夹具推进——4 种切换各断言一行 pressure_change（from/to 精确值：normal→pressure / pressure→hard / hard→pressure / pressure→normal）；`memoryGuardEnabled()=false` 时 updatePressureState 早退零行；watchdog 连续 3 轮采样失败 → watchdog_degraded（consecutiveRounds=3）、恢复首轮 → watchdog_recovered
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**：4 处切换在既有 console.error 旁各加一行 memSample（from/to 用切换前后局部变量）；memSample 内部判定 event==='pressure_change' 时壳不含 pressure 键。watchdog 侧 noteDegrade 触发退避时落 degraded、`_consecutiveDegrades=0` 且此前 ≥3 时落 recovered
- [ ] **Step 4: 绿 + 回归**（含 `test\core\mem-watchdog.test.ts`）
- [ ] **Step 5: Commit**——`feat(core): pressure_change 全 4 切换+watchdog 降级/恢复事件接线`

### Task 4: rss_sample 采样策略 + kill 采样行 + final sample

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`（pollOnce 采样循环 `:103-176`、killOverBudget/killForEviction、模块级状态区）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`（releaseLease——final sample）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\memory-guard-sample.test.ts`（追加；watchdog 夹具复用 mem-watchdog.test.ts 的 mockMachinePs/mockKillProbe 形态）

**Interfaces:**
- Consumes: Task 1 memSample；mem-watchdog 既有 `pollOnce()`/`KILL_FACTOR`/`_attributions`
- Produces: `rss_sample{leaseId,pid,declaredMB,rssBytes}`（**无 machine 字段**——省体积）；`budget_kill{leaseId,pid,kind,declaredMB,rssBytes,budgetBytes,killFactor}`；`evict{leaseId,pid,kind,declaredMB,rssBytes,ratio,reason:'hard'}`；`evict_exhausted{envExempted:{preview,editor}}`；`final_sample` 复用 rss_sample 形态（leaseId 聚合端自动并入 max）；模块级 `_lastRssByPid: Map<number, number>`（export 仅测试用 getter 或经 `_resetForTest` 清理——**禁 setter 注入**，测试经 pollOnce 行为驱动）
- 策略常量（mem-watchdog 模块级）：`RSS_SAMPLE_INTERVAL_MS = 60_000`、`RSS_SAMPLE_LONG_LIVED_MS = 300_000`、`RSS_SAMPLE_LONG_LIVED_AFTER_MS = 3_600_000`；首采标志按 leaseId 记（`_sampledOnce: Set<string>`）；租约起始时刻用 `bindLeasePid` 时间戳（memory-guard 侧 MemLease 若无 startedAt 则用 spawn_started 事件时刻近似——builder 对齐 MemLease 既有字段，无则模块内 `Map<leaseId, number>` 记 bind 时刻）

- [ ] **Step 1: 失败测试**（fake timers + mock rss 表）：
  - 租约 bind 后**首个 pollOnce 即落一行** rss_sample（首轮必采，不受 60s 节流）
  - 第二个 pollOnce（+10s）**不落**；+61s 落（时间驱动 60s，非 N 次计数）
  - 存活 >1h 的租约：+61s 不落、+301s 落（长活降频）
  - pressure 态：60s 档恢复（+61s 落）
  - killOverBudget 命中 → budget_kill 行（rssBytes=读数、budgetBytes=declared×factor、killFactor）**且同行数据可作该进程 max 证据**；killForEviction → evict 行（ratio/reason:'hard'）；耗尽分支 → evict_exhausted（envExempted 计数）
  - releaseLease 且 `_lastRssByPid` 有该 pid → 落 final rss_sample 行；无读数 → 不落
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**：pollOnce 拿到 rssMap 后先覆盖写 `_lastRssByPid`，再按策略循环落行；kill 两函数与耗尽分支各加 memSample；releaseLease 内查表落 final（同模块 import `_lastRssByPid` 的读取函数——从 mem-watchdog export `getLastRss(pid): number | undefined` 只读 getter，避免双向写）
- [ ] **Step 4: 绿 + 回归**（`test\core\mem-watchdog.test.ts` 全量——kill 路径既有断言不破坏）
- [ ] **Step 5: defects.ts 登记**——`module-level-mutable-state` baseline 110→114（点名：mem-watchdog `_lastRssByPid`/`_sampledOnce`/`_leaseBindAt` + memory-guard `_lastSizeCheckAt` 若 Task 1 未计）；跑 `npx vitest run test/regression/defects-open.test.ts` 绿
- [ ] **Step 6: Commit**——`feat(core): rss_sample 五策略采样+kill 三事件采样行+final sample`

### Task 5: rotateIfNeeded 参数化 + 采样轮转 + 杀事件入审计通道（T3-M-3 清偿）

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\audit-log.ts`（rotateIfNeeded 参数化 `:198-236`、appendMachineAuditLine 补轮转 `:490-494`）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`（kill 两路径+耗尽分支追加 appendMachineAuditLine）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`（memSample 落盘前轮转检查接线）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\core\audit-log.test.ts`（追加）；`test\core\memory-guard-sample.test.ts`（追加轮转用例）

**Interfaces:**
- Produces: `rotateIfNeededWith(filePath: string, sizeBytes: number, keepGens: number): Promise<void>`（导出；原 `rotateIfNeeded(filePath)` 委托 `rotateIfNeededWith(filePath, AUDIT_ROTATE_SIZE, AUDIT_ROTATE_KEEP)` 行为不变）；采样常量 `SAMPLE_ROTATE_SIZE = 8MB`/`SAMPLE_ROTATE_KEEP = 4`
- Produces: 审计行（appendMachineAuditLine）：`{ trace_id: 'memguard', tool: 'memory-guard', action: 'budget_kill'|'evict'|'evict_exhausted', risk: 'process', ok: true, project_path: lease 项目或 '', changed_files: [], duration_ms: 0, details: { leaseId, pid, kind, declaredMB, rssBytes, ratio?, budgetBytes?, envExempted? } }`——AuditEntry 既有 9 必填字段照填，自由载荷进 details
- Consumes: Task 4 kill 事件点

- [ ] **Step 1: 失败测试**：
  - rotateIfNeededWith 参数化轮转：造 9MB 文件 + keepGens=4 → `.1→.2→.3→.4` 链式、`.4` 删除；keepGens=1 退化为单备份
  - appendMachineAuditLine 追加后文件超限触发轮转（machine-audit 补轮转回归）
  - killOverBudget → 机器审计文件多一行（action='budget_kill'、details.leaseId 在）；耗尽分支 → evict_exhausted 审计行；**isAuditEnabled()=false 时不写审计行但采样行照落**（双通道独立）
  - memSample 轮转：预置 8MB+ 采样文件 → append 触发轮转（`.4` 链）；启动首条 append 前 stat 一次（N4：已有大文件立即轮转不等 500 计数）；轮转失败置重试标志（下一 append 即重试）
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**——audit-log 抽参数化函数（锁/代际/失败语义逐行保留，注释注明四期参数化来源）；memSample 落盘前 `_sampleAppendCount % 500 === 0 || _lastSizeCheckAt === 0` 时 `void rotateIfNeededWith(...).catch()`；mem-watchdog kill 点 `void appendMachineAuditLine({...}).catch(recordAuditWriteFailure)`
- [ ] **Step 4: 绿 + 回归**（audit-log.test.ts 全量 + mem-watchdog.test.ts 全量）
- [ ] **Step 5: Commit**——`feat(core): rotateIfNeeded 参数化+采样轮转 8MB×4+杀事件入 machine-audit(T3-M-3 清偿)`

### Task 6: memguard-review.mjs 分析工具 + golden fixture + 常量机械比对

**Files:**
- Create: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\memguard-review.mjs`
- Create: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\scripts\memguard-review.test.ts`
- Test: 同上（测试文件即 golden fixture 载体）

**Interfaces:**
- Consumes: 采样文件 schema（Task 1-5 全部事件形态）+ `KILL_FACTOR`（`src\core\mem-watchdog.ts:46`）+ `PRESSURE_RECOVER_MS`（`src\core\memory-guard.ts:315`）——**mjs 硬编码常量表 + 机械比对测试防漂移**
- Produces: CLI——`node scripts/memguard-review.mjs [--file <path>]`；退出码 0=有结论/1=数据不足/2=读失败；stdout 人读报告（覆盖窗/每档 P50/P95/max/进程数（nearest-rank，n<20 报样本不足）/事件频次表（spawn_reject 按 check 分、两种回收、三类杀）/9 条判定三态/最后事件距今/MEM_SAMPLE 关闭提示/非 Windows RSS 提示）

- [ ] **Step 1: 写 golden fixture 测试**（构造 tmp JSONL 直调 mjs 的分析函数——mjs 导出 `analyze(lines: string[]): Report` 纯函数 + CLI 壳分离，测试 import 纯函数）：
  - fixture A（全绿命中）：构造 ≥30 进程某档 P50>declared、budget_kill 一例、pressure episode 完整——断言 #1 命中、#3 命中、episode 重建正确
  - fixture B（右删失）：某进程仅 budget_kill 行有 rssBytes（rss_sample 无）→ 该进程 max 取 kill 读数（#2 可触发验证）
  - fixture C（pid 复用 + 跨 server）：两 serverPid 交错行、同 pid 两 leaseId → 分开聚合、episode 按 serverPid 分段
  - fixture D（悬挂 episode）：server_start 后无闭合 → unresolved 计数不进 #5b 分母
  - fixture E（坏行/半行/未知 event/更高 v）：跳过计数不炸；`.1` 代际文件按 ts 排序合并
  - fixture F（观察窗）：3 天数据 + 2 次 reject → 频次按观察窗天折算；<14 天时 #8 报"窗口不足"非"未命中"
  - 常量机械比对：读 `src\core\mem-watchdog.ts` 源码文本正则抽 KILL_FACTOR 四值、`memory-guard.ts` 抽 PRESSURE_RECOVER_MS=300000，与 mjs 常量表断言相等
- [ ] **Step 2: 红**（mjs 不存在 import 失败）
- [ ] **Step 3: 实现 mjs**（纯函数 analyze + CLI 壳；九条判定逐条实现 spec 表——含 #5a hard 抖动率、#5b episode 时长中位、#6 进入行分母、#4 check=1 且 pressure='normal'）
- [ ] **Step 4: 绿 + 手跑**——`node scripts/memguard-review.mjs --file <fixture>` 各退出码目检
- [ ] **Step 5: Commit**——`feat(scripts): memguard-review 分析工具——leaseId 聚合/9 判定三态/常量机械比对/golden fixture 六场景`

### Task 7: doctor sampling 可见性行

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\cli\doctor.ts`（Memory guard 段）
- Test: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\test\cli\doctor.test.ts`（追加）

**Interfaces:**
- Consumes: `memSampleEnabled()`/`sampleFilePath()`（Task 1 导出）；文件 size/最后事件年龄（fs.stat + 尾行读，doctor 是 CLI 进程可同步）
- Produces: doctor Memory guard 段新行 `sampling: on|off, file <size>, last event <age>s ago`（文件不存在时 `no data yet`；MEM_SAMPLE=0 时仅 `off`）

- [ ] **Step 1: 失败测试**——开+有文件 → 行含 on 与 size；MEM_SAMPLE=0 → 行含 off 不含 size；文件不存在 → no data yet
- [ ] **Step 2: 红 → Step 3: 实现 → Step 4: 绿（doctor.test.ts 全量）**
- [ ] **Step 5: Commit**——`feat(cli): doctor Memory guard 段补 sampling 可见性行`

### Task 8: 文档 + 版本收口 0.41.0

**Files:**
- Create: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\memory-guard-lookback.md`（判定表/聚合口径/触发条件/工具用法——从 spec v2「回看判定标准」「聚合口径」节整理为永久文档，头部注明真源链条 spec→本文档）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\README.md`（env 表 +2 行：`GODOT_MCP_MEM_SAMPLE`/`GODOT_MCP_MEM_SAMPLE_FILE`；版本表 v0.41.0 行；env 表附近一行链接指向 lookback 文档）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\tools\rule-templates.ts` + `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\rules\godot-mcp-core.md`（「内存治理」段补用户面采样语义：开关/文件位置/如何删除——**不进维护者回看判据**）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\CHANGELOG.md`（`[Unreleased]` T3-M-3 回标"四期随采样统一收口"；新 `[0.41.0]` 定版段）
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\package.json` + version-sync 六 A 类

- [ ] **Step 1: lookback 文档**（从 spec 抄录整理，绝对路径引用）
- [ ] **Step 2: README env 表 + 链接 + 规则双副本**——双语 env 表两行；core.md 双副本同段补句
- [ ] **Step 3: 版本四件套**——package.json 0.41.0 → `node scripts/version-sync.mjs` → CHANGELOG 定版段（含 T3-M-3 回标）→ README 版本表行
- [ ] **Step 4: 全门禁**（AGENTS.md 强制清单）：
  - `npm run lint`（533/0）+ `npm run build` + `npm run test:coverage`（82.4/74.92/85.59/84.18 不回退）
  - `STRICT=1 npm run check:rules-sync` + `npm run check:rules-version-bump`
  - `STRICT=1 npm run check:changelog-sync` + `node scripts/version-sync.mjs --check`
  - `npx vitest run`（全量零新失败；flaky 按 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\flaky-watchlist.md` 规则单跑复验）
  - capability-matrix **不重建**（无工具面变更，写进 commit body 防困惑）
- [ ] **Step 5: Commit**——`docs+chore(release): 四期文档收口——lookback 永久文档/README/规则双副本/版本四件套 0.41.0(T3-M-3 清偿)`
- [ ] **Step 6: 收尾（执行流程层）**——独立审查文档 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\reviews\2026-11-23-memory-guard-p4-review.md`（AGENTS.md §8）+ memory 登记（feature-decision-log + lesson）+ Obsidian 开发日志
