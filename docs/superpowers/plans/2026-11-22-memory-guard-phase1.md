# Memory Guard 一期实施计划（L1 准入三查 + L2 单进程预算杀）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 治两个已实证死机形态——「单进程内存炸弹」（GUT 22.5GB）与「多实例无总闸叠开」（8 实例齐起）：spawn 前准入三查（水位双口径/声明式预算/机器实例计数，快拒绝附占用清单）+ 10s 采样看门狗按「声明×系数」杀超预算进程并向工具调用抛 `MEM_BUDGET_EXCEEDED`。

**Architecture:** 新增 `src/core/memory-guard.ts`（内存快照+租约记账+三查准入，机器级跨 server 协调走 `~/.godot-mcp/memory-leases.json` 文件）与 `src/core/mem-watchdog.ts`（10s 轮询采样本 server 租约 PID 的 WorkingSet，超杀线树杀+归因）；在两个既有 spawn 漏斗（gdscript-executor 短命链 / process-state 长命会话链）+ launch_editor 前置 `admitSpawn()`；零新依赖（PowerShell `Get-CimInstance` 自写采样，复用 `orphan-cleanup.ts:102` 的 spawn 模式与 `fs-atomic.ts` 原子写）。

**Tech Stack:** TypeScript（vitest；PowerShell 子进程采样仅 Windows，非 Windows 优雅降级）。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-22-memory-guard-design.md`（v1 已拍板：快拒绝/15min/两期；杀系数 headless·gut=×2，game·editor=×3）

## Global Constraints

- **合并顺序（2026-11-22 执行方裁定翻转）**：**本批先落（0.38.2），反馈批 20261122 后落（0.38.3）**——guard 缺位期间任何批次执行都在死机风险敞口内；两批同改 `runtime.ts` 先停旧段与 `mcp_bridge.gd`，后落者 rebase 消解，冲突面对称。
- **版本纪律（Task 6 一笔四件套）**：`npm version patch --no-git-tag-version` → `npm run version-sync`（含 `addons/godot_mcp_server/plugin.cfg`；`BRIDGE_SCRIPT_VERSION` 由其自动同步，无手动 bump）→ README.md/README.en.md 版本行 → CHANGELOG 定版段。**CHANGELOG `[Unreleased]` 段必须保留实质内容（去符号后 >50 字符）**——CI 以 `STRICT=1 npm run check:changelog-sync` 强制（`.github/workflows/ci.yml:112`）。
- **覆盖率门禁对齐 CI**：本地验证用 `npx vitest run --coverage`（CI 阈值 76/67/80/77，`.github/workflows/ci.yml:150` + `vitest.config.ts`）——裸 `vitest run` 绿 ≠ CI 绿。
- **CI Linux 兼容**：guard 默认启用，Linux CI runner 上 commit/godotProcCount 均降级（只剩 os.freemem() 水位查）——guard 相关测试全部 mock 采样层（不依赖真实水位）；既有 spawn 类集成测试不受准入影响（mock memory-guard 或 CI env 注明）。
- **错误码注册表**：4 个新码必须进 `src/core/error-codes.ts` 注册表（Task 5）——未注册码兜底 `retryable:false` 会与拒绝文案「稍后重试」自相矛盾。
- **AGENTS.md 强制流程**：Task 6 收口含 ①`docs/reviews/` 落第三方审查文档（执行完本计划后独立审查）②memory 实体登记（`C:\Users\wgt\.claude\projects\D--GitHub-godot-mcp-series-godot-mcp-enhanced\memory\`）。
- **不引新依赖**：采样/计数全部自写 PowerShell（Windows）+ `os` 模块；禁 systeminformation/pidusage。
- **Windows 降级语义**：PowerShell 采样失败 → 快照标 `degraded: 'powershell-failed'`，commit 口径置 null、三查中 commit 查跳过（物理口径仍在）——**降级不放大通过面**，看门狗降级轮询间隔退 30s 并在日志记一次。
- **租约存储 fail-open（设计 §5④）**：`~/.godot-mcp` 可能被 `uninstall --purge` 整删——**写前 `ensureDir` 自建目录**（`fs-atomic.ts:46`，writeFileAtomic 本身不建父目录）；租约文件读写失败 → guard 降级放行 + 日志 `MEMGUARD degraded: lease-store unavailable`（不 throw 阻断工作流）。
- **守门总开关**：`GODOT_MCP_MEMORY_GUARD=0`（非空非 0/false 即启用，默认启用）——关闭时 acquireLease 恒 ok 且**不建租约**（返回 dummy lease，releaseLease 幂等）、看门狗不启动；对齐 `GODOT_MCP_BRIDGE_DISABLE` 先例。
- **lint 纪律**：改 `src/`/`test/` 的任务 commit 前 `npm run lint`（基线 533 零新增）。
- **注释简体中文**；commit `feat(core)/fix(core): 中文描述`；执行前从 master 建分支 `feat/memory-guard-p1`。
- **二期不混入**：IdleTimer/整机软硬阈值/doctor 面板/registry RSS 属二期（`2026-11-22-memory-guard-phase2.md`），本计划不做。

## Review Focus

1. **主炸弹 spawn 点必须被闸门覆盖**——`run_tests` 两条路径（分片 `runtime.ts:526`/单片 `:727`）都走 `runGutProcess`（spawn `:450`，**与 executor 无关**，审查 F1）；Task 4 漏斗清单以七处为准，gut_shard 接线点在 runGutProcess → Task 4 测试断言 run_tests 拒绝路径。
2. **租约陈旧清理的双规则**——pid 已死即清（防僵尸租约永久占预算）；pid 活但心跳 >90s 陈旧**保留**（server 崩了但 Godot 还在吃内存，预算必须继续算它）→ Task 1 测试两规则。
3. **目录自建 + fail-open**——`~/.godot-mcp` 可能被 `uninstall --purge` 整删（首写即炸，审查 F4）：写前 ensureDir；租约文件读写失败降级放行+`MEMGUARD degraded` 日志（不阻断工作流）；原子写必须（防并发写坏全 server 读崩）→ Task 1 测试。
4. **editor 双入口豁免检查但仍记账**——launch_editor 工具层（`runtime.ts:579`）与 Web GUI 复刻链（`GodotServer.ts:687`）**两处都接**（审查 F2）：跳三查但租约照建（4GB 记入预算）；杀线 ×3 仍生效 → Task 4 测试。
5. **预算闸防声明低估**——Σ 用 `max(declared, 实测RSS)`（审查设计层）：game 声明 3GB 实测 7GB 按 7GB 记账，否则 32GB 机放 7 会话最坏 49GB 任一杀线前整机先死 → Task 2 测试。
6. **preview 不在本期特判**——preview 会话 kind 仍为 `game_window`（杀线 9GB 不误杀）；IdleTimer preview 豁免是二期事（`RunSession` 补 preview 字段见二期 Task 1）→ Task 4 不写 preview 分支。
7. **杀归因不能丢**——看门狗杀掉进程后，executor/runGutProcess 的失败路径必须报 `MEM_BUDGET_EXCEEDED`（含最后读数）而非泛化「进程退出」；归因记录保留 ≥10min → Task 5 测试。
8. **`process.kill(pid, 0)` 存活探测的 Windows 语义**——EPERM=活着（别人的进程）、ESRCH=死、成功=活着自己的；三态都要测 → Task 1 测试。

---

### Task 1: memory-guard 核心——快照/档位/租约存储

**Files:**
- Create: `src/core/memory-guard.ts`
- Test: `test/core/memory-guard.test.ts`

**Interfaces:**
- Produces（二期与 Task 2-5 全依赖此块）:
```ts
export type SpawnKind = 'headless' | 'gut_shard' | 'game_window' | 'editor';
export interface MachineMemorySnapshot {
  freePhysBytes: number; totalPhysBytes: number;
  commitAvailBytes: number | null; commitTotalBytes: number | null;
  godotProcCount: number; sampledAt: number;
  degraded?: 'powershell-failed' | 'non-windows';
}
export interface MemLease {
  id: string; serverPid: number; kind: SpawnKind; declaredMB: number;
  projectPath: string; pid: number | null; startedAt: number; lastHeartbeat: number;
}
export function memoryGuardEnabled(): boolean;            // GODOT_MCP_MEMORY_GUARD 读一次缓存
export function declaredMBFor(kind: SpawnKind): number;   // 档位表+env 覆盖
export function getMachineMemorySnapshot(): MachineMemorySnapshot; // 10s 缓存
export function sampleRssBytes(pids: number[]): Promise<Record<number, number>>; // Get-CimInstance 批量，10s 结果缓存按 pid 集合键
export function listActiveLeases(): MemLease[];           // 读+清理后返回
export function acquireLease(kind: SpawnKind, projectPath: string, opts?: { exemptChecks?: boolean }): { lease: MemLease } | { denial: { code: 'MEMGUARD_LOW_WATER'|'MEMGUARD_BUDGET'|'MEMGUARD_INSTANCE_CAP'; message: string; inventory: MemLease[] } }; // Task 2 实现三查，本任务先恒 ok 建租约
export function bindLeasePid(leaseId: string, pid: number): void;
export function releaseLease(leaseId: string): void;
export function heartbeatLeases(): void;                  // 刷新本 serverPid 全部租约 lastHeartbeat 并落盘
```
- 档位默认：headless 1024 / gut_shard 8192 / game_window 3072 / editor 4096（MB）；env 覆盖 `GODOT_MCP_DECLARED_MB_<KIND大写>`（整数 MB，≤0 拒析回默认）。
- 租约文件：`join(os.homedir(), '.godot-mcp', 'memory-leases.json')`（目录已存在——machine registry 同级）；数组形态 `{version:1, leases: MemLease[]}`；写全部经 `src/core/fs-atomic.ts` writeFileAtomic。
- 清理规则（listActiveLeases 读时执行）：①pid 非 null 且死（三态探测）→ 删；②pid 为 null 且 lastHeartbeat 超 90s → 删；③pid 活（含心跳陈旧）→ 留。
- pid 探测：`killPidProbe(pid): 'alive' | 'dead'`——`process.kill(pid, 0)` 成功/EPERM=alive，ESRCH=dead。
- PowerShell 采样命令（Windows 且快照/采样用）：`Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json`——**commit 余量 = `FreeVirtualMemory`×1024（KB 字段）、commitTotal = `TotalVirtualMemorySize`×1024**（=CommitLimit−CommitTotal 语义；~~FreeSpaceInPagingFiles~~ 只反映页文件空闲不含 RAM 承载的 commit，固定/关闭 pagefile 机器上读数趋 0 会恒拒，审查 F3）；进程计数 `Get-Process | Where-Object Name -like 'Godot*' | Measure-Object | Select-Object -ExpandProperty Count`；RSS `Get-CimInstance Win32_Process -Filter "ProcessId=$p1 or ProcessId=$p2" | Select-Object ProcessId,WorkingSetSize | ConvertTo-Json`。spawn 模式参照 `src/core/orphan-cleanup.ts:102`（shell 包裹+编码处理），超时 5s，失败按 Global Constraints 降级。非 Windows：commit/godotProcCount 置 null/0 + degraded 标记（godotProcCount=0 时计数查跳过）。
- 租约文件写前 `ensureDir`（`fs-atomic.ts:46`）；读写 try/catch 全包——读失败返回 `[]`（视作无租约，水位/计数查仍在）、写失败记 `MEMGUARD degraded: lease-store unavailable` 后继续（fail-open，设计 §5④）。

- [ ] **Step 1: 写失败测试**——`test/core/memory-guard.test.ts`：①档位表默认值+env 覆盖（设/还原 env，`vi.stubEnv`）；②`memoryGuardEnabled` 三态（未设=开、`0`/`false`=关、任意他值=开）；③租约清理三规则（造 pid 活/死/未绑+心跳陈旧三种 lease 文件夹具——pid 探测用 `vi.spyOn(process, 'kill')` mock 三态）；④writeFileAtomic 被调用（spy `fs-atomic` 模块）；⑤快照缓存（10s 内两次调用只采一次——PowerShell runner mock 计数）；⑥降级：runner 抛错 → commitAvailBytes=null + degraded 标记、不抛出。租约文件路径用 env `USERPROFILE` 重定向到 tmp 夹具目录（或抽 `leasesFilePath()` 可注入）。
- [ ] **Step 2: 跑测试确认失败**——Run: `npx vitest run test/core/memory-guard.test.ts`；Expected: 模块不存在 FAIL。
- [ ] **Step 3: 实现**——按 Interfaces 落码；`acquireLease` 本任务恒成功建租约（Task 2 补三查）；lease id 形如 `p<serverPid>-<Date.now()>-<seq>`。
- [ ] **Step 4: 跑测试确认通过**——Run: 同 Step 2；Expected: PASS。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): memory-guard 核心——机器内存快照(双口径+Godot计数)/声明档位/跨server租约存储(原子写+三规则清理)"`

### Task 2: 准入三查 admitSpawn（快拒绝+占用清单）

**Files:**
- Modify: `src/core/memory-guard.ts`（acquireLease 接三查）
- Test: `test/core/memory-guard.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: `acquireLease` 三查实现——①水位：`freePhysBytes ≥ GODOT_MCP_MIN_FREE_MB×1MB`（默认 3072）且（commitAvailBytes 非 null 时）`commitAvailBytes ≥ 同阈值`；②预算（**防声明低估，审查设计层修正**）：`Σ max(lease.declaredMB, RSS_MB(lease)) + 本kind声明MB ≤ totalPhysBytes × GODOT_MCP_MEM_BUDGET_PCT/100`（默认 67）——RSS 取 10s 采样缓存（pid 未绑/无读数退 declared）；③计数：`godotProcCount ≤ GODOT_MCP_MAX_MACHINE_INSTANCES`（默认 8；godotProcCount=0 且 degraded=non-windows 时跳过）。`opts.exemptChecks=true` 跳三查直接建租约（editor 用）。拒绝 message 模板：`[MEMGUARD_<CODE>] 拒绝 spawn(<kind>,<project>):<原因一句话>。当前机器: 可用X/Y GB(commit Z), 预算 B% 已占用 S GB(本 kind 需 D GB), Godot 进程 N。占用清单: <逐条 pid/kind/project/声明MB/实测MB>。建议: stop_project 释放 / 稍后重试 / GODOT_MCP_MEMORY_GUARD=0 豁免(风险自担)`。`memoryGuardEnabled()===false` 时恒返回 dummy lease（不查不落盘副作用，releaseLease 幂等 no-op）。

- [ ] **Step 1: 写失败测试**——①低水位拒（mock 快照 freePhys 2GB）code=MEMGUARD_LOW_WATER 且 message 含「占用清单」与 pid；②预算拒（已有租约 20GB + game_window 3GB > 67%×32GB）code=MEMGUARD_BUDGET；③计数拒（godotProcCount=9>8）；④exemptChecks 跳过三查建租约；⑤guard=0 时低水位也 ok；⑥commit=null（降级）时只查物理口径仍拒。
- [ ] **Step 2: 确认失败**——Run: `npx vitest run test/core/memory-guard.test.ts`；Expected: 新用例 FAIL。
- [ ] **Step 3: 实现**——三查顺序：水位→预算→计数（先便宜的数值比较，快照已有缓存）；denial.inventory=listActiveLeases()。
- [ ] **Step 4: 确认通过**。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): admitSpawn 准入三查——水位双口径/声明预算/机器实例计数,快拒绝附占用清单与可操作建议(Bazel 语义)"`

### Task 3: 看门狗——10s 采样+单进程预算杀+归因

**Files:**
- Create: `src/core/mem-watchdog.ts`
- Test: `test/core/mem-watchdog.test.ts`

**Interfaces:**
- Consumes: `listActiveLeases`/`sampleRssBytes`/`releaseLease`/`memoryGuardEnabled`（memory-guard）；树杀复用 `src/core/process-state.ts` 既有 kill 链（`killProcess`/taskkill /F /T 路径 :30/:78——若导出形态不合适，用 `spawn('taskkill', ['/F','/T','/PID',String(pid)])` 就地实现并注明）。
- Produces:
```ts
export const KILL_FACTOR: Record<SpawnKind, number> = { headless: 2, gut_shard: 2, game_window: 3, editor: 3 };
export function startWatchdog(): void;   // 幂等；间隔 = clamp(GODOT_MCP_MEM_POLL_SECONDS,5,3600) 默认 10
export function stopWatchdog(): void;    // 测试用
export function wasMemKilled(pid: number): { readingBytes: number; declaredMB: number; kind: SpawnKind } | null; // 归因记录保留 10min
export function pollOnce(): Promise<{checked: number; killed: number}>; // 单轮，测试直调
```
- 轮询逻辑：取本 serverPid 的 activeLeases（pid 已绑）→ `sampleRssBytes(pids)` → 任一 `rss > declaredMB×1MB×KILL_FACTOR[kind]` → 树杀 + releaseLease + 记归因 + console 一行 `MEMGUARD kill <pid> kind=<k> rss=<GB> budget=<GB>`。杀失败（进程已自己退出）→ 仅清租约。guard 关→startWatchdog no-op。降级（采样失败）→ 本轮跳过，连续 3 轮失败退避 30s 并记一次日志。
- 挂载：`src/GodotServer.ts` 启动序列调 `startWatchdog()`（位置：既有 60s 周期扫描 :775-777 注册处旁）；同处每 60s 调 `heartbeatLeases()`（<90s 陈旧线）。

- [ ] **Step 1: 写失败测试**——①超杀线触发杀（lease gut_shard 8192MB，mock RSS 17GB → 杀；16GB → 不杀）；②game_window ×3 系数（RSS 9.5GB > 3×3072MB=9GB → 杀；8GB → 不杀）——锁死系数语义防漂移；③editor 同 ×3；④wasMemKilled 归因含 readingBytes/declaredMB；⑤guard=0 时 pollOnce 不杀；⑥树杀调用参数 `/F /T /PID`（spy spawn）；⑦采样抛错一轮跳过不崩。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现 + GodotServer 挂载**。
- [ ] **Step 4: 确认通过 + `npm run lint`**。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): mem-watchdog 单进程预算杀——10s 采样 WorkingSet,超声明×系数(2/3)树杀+MEM_BUDGET_EXCEEDED 归因(kubelet 检查点语义)"`

### Task 4: 漏斗接线——七处 Godot spawn 点全覆盖（审查 F1/F2 修正）

**Files:**
- Modify: `src/tools/runtime.ts`——①`runGutProcess`（:439 函数，spawn :450——**run_tests 分片 :526/单片 :727 两路径共用，主炸弹所在链**）：spawn 前 `acquireLease('gut_shard', projectPath)` → 拒则整轮 run_tests 返回 denial、过则 spawn 后 `bindLeasePid` + 退出 `releaseLease`（:456 registerSpawnedGodotPid 旁对称挂）；②run_project：先停旧（既有 :197-205，停止后释放被停会话租约）→ `acquireLease('game_window')` → spawn → bindLeasePid + 会话 exit 释放；③launch_editor（case :579）：`acquireLease('editor', {exemptChecks:true})` → spawn → bindLeasePid(child.pid)
- Modify: `src/GodotServer.ts:687`——Web GUI「编辑」按钮 launch_editor 复刻链（:684 注释自认）：同 ③语义接入（editor 豁免检查必记账）
- Modify: `src/gdscript-executor.ts`（spawn 点 :905 前置 admit；公开 API 加可选参 `spawnKind?: SpawnKind` 默认 `'headless'`）
- Modify: `src/core/headless-process.ts:18`（spawn 前置 admit，kind 调用方注入默认 headless）
- Modify: `src/tools/spawn-helper.ts:46`（`spawnGodot` 加可选 `spawnKind` 参数默认 `'headless'`，函数内前置 admit——**validation/workflow/scene/batch-tools/android 五消费方零改动自动覆盖**）
- Modify: `src/screenshot.ts:79`（capture spawn 前置 admit，headless）
- Test: `test/core/memory-guard-funnels.test.ts`（新）+ 既有 runtime/executor/validation 测试回归

**Interfaces:**
- Consumes: `acquireLease`（即设计文档中的 admitSpawn 守门函数）、`bindLeasePid`、`releaseLease`（memory-guard）。
- Produces: 七处漏斗 admit 失败 → 直接返回 `opsErrorResult(denial.code, denial.message)`（不 spawn）；全部退出路径（runGutProcess resolve/executor exit/process-state 会话 exit/editor 子进程 exit）调 `releaseLease(leaseId)`；run_project 先停旧释放被停会话租约。

- [ ] **Step 1: 写失败测试**——mock memory-guard（`vi.mock`）逐漏斗：①**runGutProcess 拒**（run_tests 两路径至少覆盖分片路径一条）→ 整轮返回 MEMGUARD_ 错误且 spawn 未被调——**主炸弹场景的闸门锚**；②run_project 拒/过两态（过态断言 exit 后 releaseLease 收到 leaseId、被停旧会话租约释放）；③launch_editor 工具层 + Web GUI 复刻链**两处** `exemptChecks:true` 断言；④spawnGodot 拒 → validation 任一 action 返回 denial；⑤executor/screenshot 拒路径各一条；⑥文本契约回归：run_project 既有成功前缀不动。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**（按 Files 七处；preview 本期不特判——Review Focus 6）。
- [ ] **Step 4: 确认通过 + `npx vitest run --coverage` 全量回归（CI 阈值口径）**。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): 七处 Godot spawn 点接入 memory-guard——runGutProcess(gut_shard 主炸弹链)/executor/spawn-helper 五模块/screenshot/run_project/launch_editor 双入口(editor 豁免检查必记账),退出释放租约"`

### Task 5: 错误码注册 + 杀归因接线 + doctor 最小可见性

**Files:**
- Modify: `src/core/error-codes.ts:34-88`（注册表追加 4 码——**未注册码兜底 retryable:false 与「稍后重试」文案自相矛盾，审查制度项**：`MEMGUARD_LOW_WATER: {retryable: true, category: 'resource', meaning: '内存水位不足拒 spawn'}` / `MEMGUARD_BUDGET: {retryable: true, ...}` / `MEMGUARD_INSTANCE_CAP: {retryable: true, ...}` / `MEM_BUDGET_EXCEEDED: {retryable: false, category: 'resource', meaning: '进程超内存预算被看门狗终止'}`）
- Modify: `src/gdscript-executor.ts`（失败分析路径查 `wasMemKilled(proc.pid)` → 优先报 `MEM_BUDGET_EXCEEDED`：`内存预算超限被看门狗终止: 峰值 <GB> / 声明 <MB>MB×<系数>。若为合法重负载,调 GODOT_MCP_DECLARED_MB_<KIND> 上调档位`）
- Modify: `src/tools/runtime.ts`（runGutProcess 失败路径同样查归因优先报；run_project 会话被杀后的 get_debug_output/stop 路径附归因）
- Modify: doctor 输出（grep `doctor` 定位 src/cli 或 tools 实现）——附两行：`memory-guard: enabled|disabled (budget 67%, leases N, watermark 3072MB)` + 快照一行
- Test: `test/core/mem-watchdog.test.ts` 追归因断言 + error-codes 既有注册表测试追加（若有 registry 完整性测试则同步）+ executor 既有错误路径测试追加

- [ ] **Step 1: 写失败测试**——executor 进程退出且 wasMemKilled 命中 → 错误码 MEM_BUDGET_EXCEEDED 优先于 SCRIPT_EXEC_FAILED；未命中走原路径（回归锚）。
- [ ] **Step 2-4: 失败→实现→通过**（含 doctor 行快照测试或手动验证记录）。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): 看门狗杀归因接线——executor/游戏会话失败路径优先报 MEM_BUDGET_EXCEEDED 附峰值与档位上调指引;doctor 附 guard 状态两行"`

### Task 6: 真机验证 + 文档 + 版本收口

**Files:**
- Modify: README.md/README.en.md（env 表新增 7 项：GODOT_MCP_MEMORY_GUARD/MIN_FREE_MB/MEM_BUDGET_PCT/MAX_MACHINE_INSTANCES/MEM_POLL_SECONDS/DECLARED_MB_×4 项合并说明）+ CHANGELOG.md
- Modify: `D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md`（11-12 死机条/11-22 条附「一期落地」注记）+ 新建开发日志 `D:\workspace\Obsidian\GodotMCP\开发日志\2026-11-22 memory-guard一期.md`

- [ ] **Step 1: 真机验证（env 强制触发法）**——①`GODOT_MCP_MIN_FREE_MB=999999` 起游戏 → 预期 MEMGUARD_LOW_WATER 拒绝且清单可见；②`GODOT_MCP_DECLARED_MB_GUT_SHARD=1`（杀线 2MB）跑任一测试 → 预期被杀且报 MEM_BUDGET_EXCEEDED；③默认 env 正常跑 run_project+execute_gdscript 全通（无误拒）；④双终端双 server 同项目各 run → 第二个受预算/计数约束或通过但 leases 文件两条目。记录四项输出到开发日志。
- [ ] **Step 2: README env 表 + CHANGELOG + 版本四件套**（`npm version patch` → version-sync → README×2 → CHANGELOG 定版段；**[Unreleased] 保留实质内容 >50 字符**——`STRICT=1 npm run check:changelog-sync` 过）。
- [ ] **Step 3: 门禁（CI 口径）**——`npm run build && npm run lint && npx vitest run --coverage && STRICT=1 npm run check:rules-sync && STRICT=1 npm run check:changelog-sync`（覆盖率阈值 76/67/80/77；无 schema 改动不动 build-matrix；tool-count 不变）。
- [ ] **Step 4: Commit**——`git commit -m "chore(release): memory-guard 一期收口——准入三查+单进程预算杀+版本四件套"`
- [ ] **Step 5: AGENTS.md 强制流程收口**——①本计划执行完成后派独立审查（reviewer 不在实现上下文），报告落 `docs/reviews/2026-11-22-memory-guard-p1-review.md`；②memory 实体登记（guard env 面/杀系数/七漏斗清单写 `C:\Users\wgt\.claude\projects\D--GitHub-godot-mcp-series-godot-mcp-enhanced\memory\memory-guard-*.md` + MEMORY.md 索引行）。
- [ ] **Step 6: Obsidian 回标与开发日志**（按全局规范 frontmatter/callouts；反馈库 11-12 条附「一期落地」+commit hash；11-22 条注明资源维度归本机制/归属维度归反馈批 Task 4）。
