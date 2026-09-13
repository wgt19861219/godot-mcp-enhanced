# per-project 运行会话分桶实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** process-state 游戏进程/输出/快照/busy 从全局单例改为 `Map<projectKey, RunSession>` 分桶,单 MCP 会话内多 Godot 项目并行运行(多窗口并存,上限可配),兼容层保证单项目场景与现有消费方零行为变化。

**Architecture:** 三层——process-state 分桶核心(兼容层语义重定向活跃桶 + per-key 新 API);runtime.ts 守卫总纲落地(闭包 sessionKey 贯穿同步主流程与异步回调);连带消费方修正(orphan/GodotServer/validation/audit/logger)。设计全文(含三轮审阅证据链):`docs/superpowers/specs/2026-09-13-per-project-run-sessions-design.md`(v3.1)。

**Tech Stack:** TypeScript(ES2022/strict/ESM,import 带 `.js`)、Vitest。

## Global Constraints

- 工作目录 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced`,分支 `feat/per-project-run-sessions`(已存在,基于 master@d840d1e3)。
- 设计文档 v3.1 是本计划的细则来源——任务里引用"设计 §X.Y"时**必须读设计文档对应节**。
- TypeScript strict + noUncheckedIndexedAccess;禁 any;ESM import 带 `.js`;工具 inputSchema 描述简体中文、运行时返回消息英文。
- 守卫总纲(设计 §4.3):run_project 闭包 sessionKey 贯穿**同步主流程与异步回调**;主流程**禁用** `setRunningProcess`(其内嵌 forceKillTree 在并发下杀错窗)。
- 现有 77 个 process-state 用例与全部既有消费方(qa/gif/bridge-session/ToolDispatcher ctx)**零改动零行为变化**(设计 §4.1 惰性创建硬性要求)。
- 改 rule-templates.ts 必须同步 `.claude/rules/godot-mcp-core.md`(STRICT=1 check:rules-sync)并触发 patch bump 0.33.2→0.33.3(Task 6)。
- 生成产物顺序:`npm run build` → `build-matrix` → `gen:tool-docs`(gen 消费 matrix 产物,顺序颠倒 preview 参数不出现)。
- 已知门禁盲区:check-rules-version-bump CI 侧不设防,bump 靠纪律(Task 6 自验 `node scripts/check-rules-version-bump.mjs && npm run version-check`)。
- 测试若触发 `test/regression/defects.ts` 模块级可变状态防恶化基线(85→86),按文件内注释链惯例 bump 并记录。

---

### Task 1: process-state 分桶核心与兼容层

**Files:**
- Modify: `src/core/process-state.ts`(模块变量区 :121-138、busy 锁 :177-254、进程/缓冲/时间/目录函数 :260-370、resetState :353-365)
- Test: `test/process-state.test.js`(验收:现有 77 用例零改动全绿)

**Interfaces:**
- Produces(后续任务消费):`RunSession` 结构、`normalizeProjectKey(p): string`、`getOrCreateSession(key): RunSession`、`activeKey(): string`;现有全部导出签名不变但语义重定向活跃桶。
- Consumes: 无(第一任务)。

- [ ] **Step 1: 先跑现有用例建立基线**

Run: `npx vitest run test/process-state.test.js`
Expected: 77/77 PASS(改动前基线;若本就失败,停下报告)。

- [ ] **Step 2: 实现分桶数据模型与兼容层**

(a) 模块变量区(:121-138)改造——6 个单例变量收进 RunSession,新增 Map 与归一化:

```ts
// ─── Per-project run sessions (设计 v3.1 §4.1) ──────────────────────────────
export type RunSessionStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'exited_early' | 'errored';

export interface RunSession {
  proc: ChildProcess | null;
  status: RunSessionStatus;
  outputBuffer: string[];
  lastFinishedRunOutput: string[];
  processStartTime: number;
  busy: boolean;
  busyOwner: string;
  busySince: number;
  displayPath: string;   // 显示用原始路径(key 仅供索引)
}

function newSession(displayPath: string): RunSession {
  // 惰性空桶钉死语义(设计 §4.1):status='exited'——不占 MAX_SESSIONS isAlive 名额、进 FIFO 可逐出
  return { proc: null, status: 'exited', outputBuffer: [], lastFinishedRunOutput: [],
            processStartTime: 0, busy: false, busyOwner: '', busySince: 0, displayPath };
}

let _sessions = new Map<string, RunSession>();
let _exitedSessionOrder: string[] = [];   // 已结束桶 FIFO(逐出最旧)
let _projectDir = '';                     // 语义升级:活跃项目(最近一次 run_project)
```

`_runningProcess/_outputBuffer/_lastFinishedRunOutput/_processStartTime/_processBusy/_busyOwner/_busySince` 七个变量**删除**,全部改为经桶访问。

(b) key 归一化与桶获取(放在 enqueueAsync 之前):

```ts
/** 项目 key 归一化(设计 §4.1):resolve + win 下 lowercase;仅供 Map 索引。 */
export function normalizeProjectKey(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function activeKey(): string {
  return _projectDir ? normalizeProjectKey(_projectDir) : '';
}

/** 惰性获取/创建活跃桶(硬性实现要求,设计 §4.1——77 个现有用例依赖)。 */
function getOrCreateSession(key: string): RunSession {
  let s = _sessions.get(key);
  if (!s) {
    s = newSession(key ? key : _projectDir);
    if (key) s.displayPath = key;  // displayPath 首次用 key,后续 setProjectDir 刷新
    _sessions.set(key, s);
  }
  return s;
}
```

(顶部补 `import { resolve as pathResolve } from 'path';` 或复用现有 path import——按文件现有 import 风格;`resolve` 全名引用避免与函数参数遮蔽。)

(c) 现有导出逐个语义重定向(签名不变)——**同构改造模式**(以三个为代表,其余照此):

```ts
export function getRunningProcess(): ChildProcess | null {
  return getOrCreateSession(activeKey()).proc;
}

export function getOutputBuffer(): string[] {
  return getOrCreateSession(activeKey()).outputBuffer;
}

export function appendOutput(lines: string[], projectKey?: string): void {
  const s = getOrCreateSession(projectKey ?? activeKey());
  s.outputBuffer.push(...lines);
  if (s.outputBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
    s.outputBuffer = s.outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}
```

**完整改造清单**(逐个按同模式重定向到 `getOrCreateSession(activeKey())` 或加可选 key 参数):
`getRunningProcess`/`setRunningProcess`(null 分支的清空+stash 改作用于该桶;注意 setRunningProcess 现有 forceKillTree 段对新 proc 非 null 时仍是"活跃桶旧 proc"——本任务保持现状语义,Task 2 加 per-key API 后 runtime.ts 停用它)/`getOutputBuffer`/`appendOutput(加可选 key)`/`clearOutputBuffer(加可选 key,清前 stash 挪入该桶 lastFinishedRunOutput,非空才挪)`/`setOutputBuffer(buf, key?)`/`getProcessStartTime`/`setProcessStartTime(t, key?)`/`getProjectDir`(不变)/`setProjectDir`(活跃指针,写后同步新活跃桶 displayPath)/`isProcessBusy`/`setProcessBusy`(作用于活跃桶的 busy 三件组)/`getProcessSlotInfo 等`。
`stashOutputBuffer`/`getLastFinishedRunOutput` 改为桶字段操作(B-1 语义不变,per-bucket)。

(d) busy 锁区(:179-254)重定向:`acquireProcessSlot(owner)` 的 `_processBusy/_busyOwner/_busySince/_runningProcess` 全部改经活跃桶 session 字段;死进程自愈检查读活跃桶 proc(本任务暂不加 projectPath 参数,Task 2 加);`getBusyInfo`/`buildBusyErrorMessage` 数据来源改活跃桶字段(本任务保持无参,Task 2 加 targetKey)。enqueueAsync 与临界区**保持不变**(同步临界体,禁 await,设计 §4.2 M-4)。

(e) `resetState()`(:353-365)追加:`_sessions = new Map(); _exitedSessionOrder = [];`

(f) 文件头 CR-3 注释块(:104-120)追加三行:分桶语义、活跃指针定义(最近 run_project,写入方收窄见设计 §4.7)、'' 空桶语义(设计 §4.1)。

- [ ] **Step 3: 跑现有用例验证零改动通过**

Run: `npx vitest run test/process-state.test.js && npm run build`
Expected: 77/77 PASS + tsc 零错。**若有用例失败,是兼容层没重定向干净(常见:漏改某函数仍读旧变量)——修复实现而不是改用例。**

- [ ] **Step 4: Commit**

```bash
git add src/core/process-state.ts
git commit -m "refactor(process-state): 分桶核心——RunSession Map + 兼容层语义重定向活跃桶(77 用例零改动通过)"
```

---

### Task 2: per-key 新 API + 状态机 + 上限/FIFO + pid 注册表归属化

**Files:**
- Modify: `src/core/process-state.ts`(新导出区、acquireProcessSlot 加参、pid 注册表、killOrphanGodotProcesses 包装 :373-386)
- Test: `test/process-state.test.js`(新增 describe)

**Interfaces:**
- Consumes: Task 1 的 RunSession/getOrCreateSession/normalizeProjectKey/activeKey。
- Produces(设计 §4.2 清单,签名逐字):
```ts
getSession(projectPath?: string): RunSession | undefined
listRunSessions(): Array<{ projectPath: string; displayPath: string; status: RunSessionStatus; pid: number | null }>
getRunSessionProc(projectPath: string): ChildProcess | null
setRunSessionProc(projectPath: string, proc: ChildProcess | null, skipBusyCheck?: boolean): void
releaseRunSessionBusy(projectPath: string): void
clearRunSession(projectPath: string): void
markSessionStopping(projectPath: string): void
setSessionStatus(projectPath: string, status: RunSessionStatus): void
markSessionExited(projectPath: string, exitCode: number | null): void   // close 判定:2s 内=exited_early,code≠0=errored,否则 exited
ensureSessionCapacity(projectPath: string): void                       // 上限检查,拒绝抛错附会话清单
getActiveRunPids(): number[]
killAllRunSessions(): Promise<void>
acquireProcessSlot(owner: string, projectPath?: string): Promise<boolean>   // 加参
buildBusyErrorMessage(targetKey?: string): string                            // 加参
clearOutputBuffer(projectKey?: string) / appendOutput(lines, projectKey?) / setProcessStartTime(t, key?)  // Task 1 已加
```

- [ ] **Step 1: 写失败测试(新增 describe,代表用例如下,完整覆盖设计 §7 分桶核心清单)**

```js
import { /* 追加 */ normalizeProjectKey, getSession, listRunSessions, getRunSessionProc,
         setRunSessionProc, releaseRunSessionBusy, clearRunSession, markSessionStopping,
         setSessionStatus, getActiveRunPids, killAllRunSessions, acquireProcessSlot } from '../src/core/process-state.js';

describe('per-project sessions — 分桶核心(设计 §4.2/§7)', () => {
  beforeEach(() => { resetState(); });

  it('多桶并存:A/B 各自 proc,互不影响', () => {
    const pA = mockChildProcessA(), pB = mockChildProcessB();  // 用现有测试的 child_process mock 形态
    setProjectDir('/proj/A'); setRunSessionProc('/proj/A', pA, true);
    setProjectDir('/proj/B'); setRunSessionProc('/proj/B', pB, true);
    expect(getRunSessionProc('/proj/A')).toBe(pA);
    expect(getRunSessionProc('/proj/B')).toBe(pB);
    expect(listRunSessions().length).toBe(2);
    expect(getActiveRunPids()).toContain(pA.pid);
  });

  it('setRunSessionProc 只 forceKillTree 该桶旧 proc,不碰其他桶(设计 C-1)', () => {
    // A 桶换新进程时,B 桶旧进程必须存活
    setProjectDir('/A'); setRunSessionProc('/A', procA1, true);
    setProjectDir('/B'); setRunSessionProc('/B', procB, true);
    setRunSessionProc('/A', procA2, true);
    expect(getRunSessionProc('/B')).toBe(procB);          // B 不受影响
    expect(getRunSessionProc('/A')).toBe(procA2);
  });

  it('clearRunSession 只清目标桶:busy 释放+proc 清空+快照挪移(活跃则同步指针)', () => {
    setProjectDir('/A'); setRunSessionProc('/A', procA, true);
    appendOutput(['A-output'], normalizeProjectKey('/A'));
    setProjectDir('/B'); setRunSessionProc('/B', procB, true);   // 活跃切到 B
    clearRunSession('/A');
    expect(getRunSessionProc('/A')).toBeNull();
    expect(getSession('/A').busy).toBe(false);
    expect(getSession('/A').lastFinishedRunOutput).toEqual(['A-output']);  // 快照挪入
    expect(getRunSessionProc('/B')).toBe(procB);                 // B 的 busy/proc 完好
  });

  it('运行中上限 GODOT_MCP_MAX_SESSIONS:达上限拒绝并列出会话(设计 §4.1)', () => {
    process.env.GODOT_MCP_MAX_SESSIONS = '2';
    setProjectDir('/A'); setRunSessionProc('/A', procA, true);
    setProjectDir('/B'); setRunSessionProc('/B', procB, true);
    expect(() => ensureSessionCapacity('/C')).toThrow(/MAX_SESSIONS|sessions running/);
    delete process.env.GODOT_MCP_MAX_SESSIONS;
  });

  it('已结束桶 FIFO 超限逐出最旧,活跃桶永不逐出;逐出后 getSession 返回 undefined(设计 §4.1)', () => { /* 依 design §4.1:16 上限,造 17 个 exited 桶断言最旧被逐 */ });

  it('状态机:markSessionStopping/setSessionStatus;close 判定顺序 exited_early(<2s)优先(设计 §4.1)', () => { /* 由 setRunSessionProc(null,...) 路径+2s 阈值断言 */ });

  it('acquireProcessSlot(owner, X) 锁 X 桶而非活跃桶(设计 C-1 前半)', async () => {
    setProjectDir('/B');   // 活跃是 B(空)
    expect(await acquireProcessSlot('run_project', '/A')).toBe(true);
    expect(getSession('/A').busy).toBe(true);        // 锁在 A
    expect(getSession('/B').busy).toBe(false);
  });

  it('getActiveRunPids = 全部桶内活进程(orphan 排除集合,设计 §4.4)', () => { /* A/B 两桶活进程 + 一个已退桶,断言集合 */ });
});
```

(mock 形态参照现有文件头 child_process mock;`requireSessionCapacity`/`assertSessionCapacity` 命名最终实现定一个——下述实现用 `ensureSessionCapacity(projectPath)`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/process-state.test.js -t "per-project sessions"`
Expected: FAIL(新导出不存在)。

- [ ] **Step 3: 实现新 API(设计 §4.2 签名逐字)**

核心实现(完整):

```ts
// ─── Per-key run session API(设计 §4.2)────────────────────────────────────
export function getSession(projectPath?: string): RunSession | undefined {
  const key = projectPath === undefined ? activeKey() : normalizeProjectKey(projectPath);
  return _sessions.get(key);
}

export function listRunSessions(): Array<{ projectPath: string; displayPath: string; status: RunSessionStatus; pid: number | null }> {
  const out = [];
  for (const [key, s] of _sessions) {
    if (key === '') continue;                       // '' 空桶不进列表(设计 §4.1)
    out.push({ projectPath: key, displayPath: s.displayPath, status: s.status, pid: s.proc?.pid ?? null });
  }
  return out;
}

export function getRunSessionProc(projectPath: string): ChildProcess | null {
  return _sessions.get(normalizeProjectKey(projectPath))?.proc ?? null;
}

export function setRunSessionProc(projectPath: string, proc: ChildProcess | null, skipBusyCheck?: boolean): void {
  const key = normalizeProjectKey(projectPath);
  const s = getOrCreateSession(key);
  if (s.displayPath === key) s.displayPath = projectPath;   // 首次刷新为原始写法
  if (!skipBusyCheck && s.busy) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  // C-1 核心:forceKillTree 仅针对**该桶**旧 proc(绝不碰活跃桶或其他桶)
  if (s.proc && !s.proc.killed && proc !== s.proc) {
    forceKillTree(s.proc);
  }
  s.proc = proc;
  s.status = proc ? 'running' : 'exited';
  if (proc) s.processStartTime = Date.now();
  if (!proc) {
    stashToSnapshot(s);          // 非空才挪 + 2s 判定 exited_early/errored(见下)
  }
}

export function releaseRunSessionBusy(projectPath: string): void {
  const s = _sessions.get(normalizeProjectKey(projectPath));
  if (s) { s.busy = false; s.busyOwner = ''; s.busySince = 0; }
}

export function clearRunSession(projectPath: string): void {
  const key = normalizeProjectKey(projectPath);
  const s = _sessions.get(key);
  if (!s) return;
  s.busy = false; s.busyOwner = ''; s.busySince = 0;
  if (s.proc) { s.proc = null; }
  stashToSnapshot(s);
  s.processStartTime = 0;
  // 活跃指针同步(活跃桶被清,指针保持指向——快照可查,设计 §5"不转移")
}

export function markSessionStopping(projectPath: string): void {
  const s = _sessions.get(normalizeProjectKey(projectPath));
  if (s && (s.status === 'running' || s.status === 'starting')) s.status = 'stopping';
}

export function setSessionStatus(projectPath: string, status: RunSessionStatus): void {
  const s = getOrCreateSession(normalizeProjectKey(projectPath));
  s.status = status;
}

export function getActiveRunPids(): number[] {
  const out: number[] = [];
  for (const s of _sessions.values()) {
    if (s.proc && s.proc.pid && isAlive(s.proc)) out.push(s.proc.pid);
  }
  return out;
}

export async function killAllRunSessions(): Promise<void> {
  for (const s of _sessions.values()) {
    if (s.proc && !s.proc.killed) { s.status = 'stopping'; await killProcess(s.proc); }
    s.proc = null; s.busy = false; s.busyOwner = ''; s.busySince = 0;
  }
}
```

配套 helper(文件级,完整):

```ts
/** close 判定(设计 §4.1):2s 内退出=exited_early 优先;2s 外 code≠0=errored;否则 exited。 */
export function markSessionExited(projectPath: string, exitCode: number | null): void {
  const s = _sessions.get(normalizeProjectKey(projectPath));
  if (!s) return;
  const early = s.processStartTime > 0 && Date.now() - s.processStartTime < 2_000;
  s.status = early ? 'exited_early' : (exitCode !== null && exitCode !== 0 ? 'errored' : 'exited');
}

配套(完整):

```ts
/** stash:非空才挪 + 进程结束态判定(exited_early <2s 优先,设计 §4.1)。 */
function stashToSnapshot(s: RunSession): void {
  if (s.outputBuffer.length > 0) {
    const early = s.processStartTime > 0 && Date.now() - s.processStartTime < 2_000;
    s.status = early ? 'exited_early' : 'exited';
    s.lastFinishedRunOutput = s.outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
    s.outputBuffer = [];
  } else {
    s.status = s.processStartTime > 0 ? 'exited' : s.status;
  }
}
```
(errored 判定由 close code 传入路径——runtime.ts close handler 调 `setSessionStatus` 前,若 close code≠0 且非 early 则设 'errored';process-state 提供 `markSessionExited(projectPath, exitCode)` 一并实现:内部按 2s/code 双判据。)

```ts
/** 运行中上限检查(设计 §4.1:每调用读 env,拒绝并附会话清单)。 */
export function ensureSessionCapacity(projectPath: string): void {
  const max = Math.max(1, Number(process.env.GODOT_MCP_MAX_SESSIONS) || 4);
  const alive = listRunSessions().filter(x => x.status === 'starting' || x.status === 'running' || x.status === 'stopping');
  const key = normalizeProjectKey(projectPath);
  const alreadyRunning = alive.some(x => x.projectPath === key);
  if (!alreadyRunning && alive.length >= max) {
    throw new Error(`Max concurrent run sessions (${max}) reached. Running: ${alive.map(x => x.displayPath).join(', ')}. Use stop_project first.`);
  }
}

/** FIFO 逐出(设计 §4.1:已结束桶上限 16,活跃永不逐出)。在每次桶状态转 ended 时调用。 */
function evictExitedIfNeeded(): void {
  const max = Math.max(1, Number(process.env.GODOT_MCP_MAX_FINISHED_SESSIONS) || 16);
  // _exitedSessionOrder 维护:桶进入 ended 态时 push(key);同项目覆盖时先移除旧 key
  while (_exitedSessionOrder.length > max) {
    const oldest = _exitedSessionOrder.shift();
    if (oldest !== undefined && oldest !== activeKey()) _sessions.delete(oldest);
  }
}
```

其余改造:`acquireProcessSlot(owner, projectPath?)` 临界体改操作目标桶(`getOrCreateSession(normalizeProjectKey(projectPath ?? _projectDir))`),自愈检查读该桶 proc;`buildBusyErrorMessage(targetKey?)` 读 targetKey 桶;`_spawnedGodotPids: Set<number>` → `Map<number, string>`(`registerSpawnedGodotPid(pid, projectKey?)` 加参,`getSpawnedGodotPids()` 返回 `Array.from(map.keys())` 兼容);`killOrphanGodotProcesses` 包装(:373-386)的注入改 `runningPid` → `activePids: getActiveRunPids()`(orphan-cleanup.ts 接口同步改,见 Task 3;本任务先在 process-state 侧改注入形状并同步 orphan-cleanup 签名 `runningPid` → `activePids: number[]`,内部 `has(activePids)` 判断——最小改动)。

- [ ] **Step 4: 跑全部测试**

Run: `npx vitest run test/process-state.test.js && npm run build`
Expected: 新增用例 + 既有 77 用例全 PASS,tsc 零错。

- [ ] **Step 5: Commit**

```bash
git add src/core/process-state.ts src/core/orphan-cleanup.ts test/process-state.test.js
git commit -m "feat(process-state): per-key 会话 API(9 导出)+状态机+上限/FIFO+pid 注册表归属化"
```

---

### Task 3: orphan 节流 per-project + GodotServer close 链

**Files:**
- Modify: `src/core/orphan-cleanup.ts`(节流 :60-61、排除集合参数)、`src/core/GodotServer.ts`(close 链 :693-711 附近,grep `killOrphan\|runningProcess` 定位)
- Test: `test/regression/` 或就近新建 `test/orphan-multibucket.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `getActiveRunPids()`/`killAllRunSessions()`。
- Produces: `cleanupOrphanProcesses` 注入形状含 `activePids: number[]`;节流 `Map<projectKey, lastScanAt>`。

- [ ] **Step 1: 失败测试**——A 项目周期扫描后 30s 内,B 项目 stop_project 的 orphan 分支不被全局节流吞掉(设计 §4.4 M-5);排除集合含多桶活进程。
- [ ] **Step 2: 确认失败** — Run: `npx vitest run test/orphan-multibucket.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**——`orphan-cleanup.ts` 的模块级 `_lastScanAt` 改 `Map<string, number>`(key=projectDir);第一层排除 `pid === runningPid` 改 `activePids.includes(pid)`;`GodotServer.ts` close 链中逐进程清理段替换为 `await killAllRunSessions()`(保留其余 close 逻辑:editor 连接、logger 等)。
- [ ] **Step 4: 通过 + 回归** — Run: `npx vitest run test/orphan-multibucket.test.js test/process-state.test.js && npm run build` Expected: PASS。
- [ ] **Step 5: Commit** — `git commit -m "feat(orphan): 节流 per-project + 排除集合改全部活进程 + GodotServer close 走 killAllRunSessions"`

---

### Task 4: runtime.ts 守卫总纲落地 + 测试与 mock 基建

**Files:**
- Modify: `src/tools/runtime.ts`(run_project :153-303 / stop_project :305-335 / get_debug_output :337-355 / inputSchema)
- Test: `test/runtime.test.js`(mock 工厂 :22-36 + 新用例)

**Interfaces:**
- Consumes: Task 2 全部新 API(`normalizeProjectKey/ensureSessionCapacity/getRunSessionProc/setRunSessionProc/releaseRunSessionBusy/clearRunSession/markSessionStopping/markSessionExited/setSessionStatus/listRunSessions/getSession`)。
- Produces: `stop_project`/`get_debug_output` 新可选参数 `project_path`(inputSchema);run_project 返回消息含 `(N sessions running)`;`resolveReadableOutput(ctx, session?)` 带桶参数。

- [ ] **Step 1: mock 工厂先改造(15 文件,设计 §7 I-4 统一策略)**

`test/runtime.test.js:22-35` 工厂改 `vi.mock(importOriginal)` 部分覆盖(仅 stub 测试需要假的函数,新导出透传真实模块):

```js
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,                                    // 新导出(getRunSessionProc 等)走真实实现
    appendOutput: vi.fn(),                        // 仍需 stub 的(断言目标/副作用隔离)逐个列
    killProcess: vi.fn(async () => {}),
    forceKillTree: vi.fn(),
    acquireProcessSlot: vi.fn(async () => true),
    buildBusyErrorMessage: vi.fn(() => 'Busy'),
    killOrphanGodotProcesses: vi.fn(async () => 0),
  };
});
```

**同策略改造其余 14 个 vi.mock(process-state) 文件**(grep `vi.mock.*process-state` 定位;`test/godot-server.test.js:69-86`/`k-subscribe-setlevel.test.ts:79`/`import-check.test.ts:32`/`editor-fallback-integration.test.js:54`/`core/godot-server-oninitialized.test.ts:55` 等——每个文件判断哪些 mock 是行为断言目标(保留 stub)、哪些只是防副作用(importOriginal 透传)。改造后逐文件跑确认无回归。

- [ ] **Step 2: 写失败测试(新用例清单,代表代码)**

```js
describe('run_project — per-project 分桶(设计 §4.3/§7)', () => {
  it('跨项目并存:A run 后 B run,A 仍活且互不杀', async () => {
    const procA = mockProc(), procB = mockProc();
    setupSpawnMock(procA); const ctxA = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA' }, ctxA);
    setupSpawnMock(procB); const ctxB = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pB' }, ctxB);
    expect(getRunSessionProc('/pA')).toBe(procA);      // 真实模块经 importOriginal
    expect(getRunSessionProc('/pB')).toBe(procB);
  });

  it('活跃切走后 A 的输出仍写 A 桶(坑 1 行为锁定)', async () => {
    const procA = mockProc(); setupSpawnMock(procA); const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA' }, ctx);
    // B run(活跃切走)后,procA 的 stdout 数据进 A 桶
    const procB = mockProc(); setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB' }, ctx);
    procA.stdout.emit('data', Buffer.from('A-log-line'));
    expect(getSession('/pA').outputBuffer).toContain('A-log-line');
  });

  it('C-1 行为锁定:profiling await 窗口下并发 run 互不杀、proc 各归各桶', async () => {
    // mock DebuggerProfiler.create 延迟 resolve 制造 :195 await 窗口
    vi.mock('../src/core/function-profiler.js', ...);  // 参照现有 profiling 测试的 mock 形态
    // Promise 未 resolve 前发起 B run;A 的 create resolve 后继续,断言两桶各归各、无 forceKillTree(procB)
  });

  it('I-1 行为锁定:A(profiling)运行中 run B,B 退出不断 A 的 profiler', async () => { /* 断言 ctx.functionProfiler 仍为 A 的实例 */ });

  it('上限溢出:第 5 个项目 run 被拒并列出会话', async () => { /* env GODOT_MCP_MAX_SESSIONS=4 */ });

  it('stop_project/get_debug_output 带 project_path 读指定桶', async () => { /* A 活跃时查 B 桶输出/快照 */ });

  it('守卫专项:活跃切走后关旧窗,A 桶被正确清理且 B 的 busy/proc 完好', async () => {
    // A run→B run→procA.emit('close', 0)→断言 getSession('/A') 状态 ended/快照在,B 桶 busy/proc 不动
  });
});
```

- [ ] **Step 3: 确认失败** — Run: `npx vitest run test/runtime.test.js -t "per-project"` Expected: FAIL。

- [ ] **Step 4: 实现 runtime.ts(设计 §4.3 全部要点,关键代码)**

run_project 骨架(改造后,节选关键段——sessionKey 贯穿):

```ts
case 'run_project': {
  const p = requireProjectPath(args);
  if (!existsSync(join(p, 'project.godot'))) { ... }
  const waitForBridge = args.wait_for_bridge === true;
  const bridgeTimeout = ...; const timeout = ...; const preview = args.preview === true;
  const godot = await ctx.findGodot();
  const versionWarning = await checkVersionMismatch(p, godot);
  const warnPrefix = ...;
  const sessionKey = normalizeProjectKey(p);        // ← 闭包级 sessionKey(守卫总纲)

  ensureSessionCapacity(p);                          // 上限(同项目覆盖不算新增)

  // Stop existing:只杀 X 桶旧进程(设计 §4.3)
  const existingProc = getRunSessionProc(p);
  if (existingProc) {
    markSessionStopping(p);
    releaseRunSessionBusy(p);
    await killProcess(existingProc);
    clearRunSession(p);
  }

  if (!await acquireProcessSlot('run_project', p)) {
    return textResult(buildBusyErrorMessage(sessionKey));
  }

  ctx.setProjectDir(p);                              // 活跃指针切换(唯一切换点)
  clearOutputBuffer(sessionKey);
  // processStartTime 由 setRunSessionProc 设置

  const profiling = args.profiling === true;
  if (ctx.functionProfiler && profilerOwnerKey === sessionKey) {   // I-1:仅同桶才关
    ctx.functionProfiler.close(); ctx.functionProfiler = undefined;
  }
  let profilerOwnerKey2: string | undefined;          // 文件级 let profilerOwnerKey 追踪属主
  let proc: ChildProcess;
  if (profiling) {
    try {
      const profiler = await DebuggerProfiler.create();
      ctx.functionProfiler = profiler; profilerOwnerKey = sessionKey;   // 属主弱关联
      ...
    } catch (err) {
      releaseRunSessionBusy(sessionKey);              // C-1:按 key 释放
      if (profilerOwnerKey === sessionKey) { ctx.functionProfiler?.close(); ctx.functionProfiler = undefined; }
      setSessionStatus(sessionKey, 'errored');
      return textResult(...);
    }
  } else {
    try { proc = spawn(...); }
    catch (err) {
      releaseRunSessionBusy(sessionKey);              // C-1
      setSessionStatus(sessionKey, 'errored');
      appendOutput([`Spawn error: ${msg}`], sessionKey);
      return textResult(...);                         // :219 setRunningProcess(null) 删除——proc 未注册无需清
    }
  }
  proc.stdout?.on('data', (d) => appendOutput(d.toString().split('\n'), sessionKey));   // 坑 1
  proc.stderr?.on('data', (d) => appendOutput(d.toString().split('\n'), sessionKey));

  let autoStopTimer: ...;
  if (timeout > 0 && !preview) {
    autoStopTimer = setTimeout(() => {
      if (getRunSessionProc(sessionKey) === proc) {           // 守卫判断按 key(坑 5)
        releaseRunSessionBusy(sessionKey);
        markSessionStopping(p); void killProcess(proc);
        clearRunSession(sessionKey);                           // 守卫动作按 key(坑 4)
      }
      if (proc.pid) unregisterSpawnedGodotPid(proc.pid);
    }, timeout * 1000);
  }

  proc.on('close', (code) => {
    if (ctx.functionProfiler && profilerOwnerKey === sessionKey) {  // I-1:属主守卫
      ctx.functionProfiler.close(); ctx.functionProfiler = undefined;
    }
    if (getRunSessionProc(sessionKey) === proc) {            // 守卫按 key
      markSessionExited(p, code);                            // exited_early/errored/exited 判定
      clearRunSession(sessionKey);
    }
    if (proc.pid) unregisterSpawnedGodotPid(proc.pid);
    if (autoStopTimer) clearTimeout(autoStopTimer);
  });

  proc.on('error', (err) => {
    if (getRunSessionProc(sessionKey) === proc) {
      setSessionStatus(sessionKey, 'errored');
      clearRunSession(sessionKey);
    }
    if (proc.pid) unregisterSpawnedGodotPid(proc.pid);
    if (autoStopTimer) clearTimeout(autoStopTimer);
    appendOutput([`Spawn error: ${err.message}`], sessionKey);   // 坑 1(error 路径,设计 v3.1)
  });

  setRunSessionProc(sessionKey, proc, true);                 // C-1 核心:按 key 写入,禁用 setRunningProcess
  if (proc.pid) registerSpawnedGodotPid(proc.pid, sessionKey);

  if (waitForBridge) {
    const r = await isBridgeReady(p, bridgeTimeoutMs, {
      proc,
      isCancelled: () => getRunSessionProc(sessionKey) !== proc,   // 坑 6:按 key
    });
    if (!r.ready) {
      if (getRunSessionProc(sessionKey) === proc) {          // 守卫按 key
        markSessionStopping(p); releaseRunSessionBusy(sessionKey);
        void killProcess(proc); clearRunSession(sessionKey);
      }
      return errorResult(...);
    }
    ...
  }
  // 成功返回消息统一追加会话数:
  const running = listRunSessions().filter(x => isAliveStatus(x.status)).length;
  const sessionNote = running > 1 ? ` (${running} sessions running)` : '';
  // 各分支文案 + sessionNote(preview 两分支与普通分支同)
}
```

(文件顶部加 `let profilerOwnerKey: string | undefined;` 模块级追踪;`isAliveStatus`/`activeProjectKeyOf` 本地 helper:`const isAliveStatus = (st: string) => st === 'starting' || st === 'running' || st === 'stopping';`、`function activeProjectKeyOf(ctx: ToolContext): string { return ctx.projectDir ? normalizeProjectKey(ctx.projectDir) : ''; }`)

`stop_project`/`get_debug_output` 改造(关键差异):

```ts
case 'stop_project': {
  const targetKey = typeof args.project_path === 'string' && args.project_path
    ? normalizeProjectKey(args.project_path) : activeProjectKeyOf(ctx);   // 缺省=活跃
  const targetProc = getRunSessionProc(targetKey);
  if (!targetProc) { /* orphan 分支按 args.project_path ?? ctx.projectDir(现状语义)+列会话提示 */ }
  markSessionStopping(args.project_path ?? ctx.projectDir!);
  await killProcess(targetProc);
  const s = getSession(targetKey);
  const { lines, fromSnapshot } = resolveReadableOutputFor(s);    // per-key 读数(设计 M-3)
  ... // result 同现状,source/runtime/total_lines 来自 s
  clearRunSession(targetKey);
}
case 'get_debug_output': {
  const targetKey = ...同上;
  const s = getSession(targetKey);
  if (!s || (s.outputBuffer.length === 0 && !s.proc && s.lastFinishedRunOutput.length === 0)) {
    return textResult('No debug output available. Run a project first.');   // 逐出桶返回 session evicted(设计 §4.1)——getSession undefined 时报 'session evicted or unknown'
  }
  ... // resolveReadableOutputFor(s) 同现状语义
}
```

`resolveReadableOutput` 改为 `resolveReadableOutputFor(s: RunSession)`(消费 session 而非 ctx);inputSchema 的 `stop_project`/`get_debug_output` 共用参数区加 `project_path` 可选参数描述。

- [ ] **Step 5: 通过 + 全文件回归** — Run: `npx vitest run test/runtime.test.js && npm run build` Expected: 全 PASS(含既有 preview/快照回落用例——单项目语义不变)。
- [ ] **Step 6: Commit** — `git commit -m "feat(runtime): 守卫总纲落地——sessionKey 贯穿同步/异步全路径 + 跨项目并存 + stop/get_debug_output 带 project_path"`

---

### Task 5: 消费方修正(validation/gdscript-executor/audit/logger)

**Files:**
- Modify: `src/tools/validation.ts:574-575`、`src/gdscript-executor.ts:1140-1142`、`src/core/ToolDispatcher.ts:558-559`、`src/core/logger.ts(:221-224 pendingTools、:416-460 toolStart/toolEnd)`
- Test: `test/`(就近:validation 的 V-01 用例改造 + logger 新用例)

**Interfaces:**
- Consumes: Task 2 的 `getRunSessionProc()`、Task 1 的 `getProjectDir()`。
- Produces: JSONL `tool_start`/`tool_end` 条目含 `project` 字段(子项目 2 Web GUI 数据基础)。

- [ ] **Step 1: 失败测试**——①validate_scripts 后活跃指针不变(getProjectDir 仍为旧值);②execute_gdscript 对运行中项目警告按目标桶触发;③logger tool_end 条目带 project。
- [ ] **Step 2: 确认失败** — Run: 对应 vitest 文件 Expected: FAIL。
- [ ] **Step 3: 实现**(设计 §4.7/§4.5 I-3/§6 I-2/§4.6,均为小改):
  - `validation.ts:575`:`ctx.setProjectDir(projectPath)` 删除,该值改局部传递(其消费点 orphan 过滤用 `getProjectDir()` 读)。
  - `gdscript-executor.ts:1140-1142`:判定改 `getRunSessionProc(目标项目路径) != null`。
  - `ToolDispatcher.ts:558-559`:audit projectPath fallback 链改 `(args.project_path) ? args.project_path : (ps.getProjectDir() || resolveProjectPath())`。
  - `logger.ts`:`pendingTools` Map 值加 `project` 字段(toolStart 时从第二参/上下文取,runtime 域传 args.project_path ?? 活跃);toolEnd 配对写出。~15 行。
- [ ] **Step 4: 通过 + 回归** — Run: `npx vitest run test/ -t "validation|logger|executor"` + `npm run build`。
- [ ] **Step 5: Commit** — `git commit -m "fix(consumers): 活跃指针单写入方 + executor 警告按桶 + audit 归属 + logger project 字段"`

---

### Task 6: 规则双副本 + claudemd + 版本链 0.33.3

**Files:**
- Modify: `src/tools/rule-templates.ts`(「视觉改动收尾流程」段扩展)、`.claude/rules/godot-mcp-core.md` 同步、`src/tools/claudemd-builder.ts:90` 附近、package.json/version-sync 产物、`CHANGELOG.md`、`README.md`(工具表 + 版本表)

- [ ] **Step 1: 规则双副本**——在「视觉改动收尾流程」小节追加多项目说明(双副本逐字一致,模板内反引号转义):

```text
- 多项目并存：run_project 可并行运行多个项目（窗口并存，上限 GODOT_MCP_MAX_SESSIONS 默认 4）；
  同项目重复 run 会先停旧进程。查错/停止其他项目用 stop_project、get_debug_output 的 project_path 参数。
- bridge 查询/输入模拟对最近 run_project 的项目生效；profiler 采样最近一次 profiling 会话（不被无关 run 销毁）。
```

- [ ] **Step 2: claudemd-builder 措辞**——「运行时管理」段补一句多项目(`preview/多窗口/project_path 参数`)。
- [ ] **Step 3: 版本链**——`npm version patch --no-git-tag-version`(0.33.2→0.33.3)→ `npm run build && npm run version-sync` → CHANGELOG 定版段(`[0.33.3]`,Added: per-project 会话分桶/多窗口并存/stop·get_debug_output project_path;Fixed: 并发互杀/orphan 误杀非活跃窗/profiler 误销毁/audit 归属)→ README 工具表 run_project 行 + 版本表新行。
- [ ] **Step 4: 验证** — Run: `node scripts/check-rules-version-bump.mjs && npm run version-check && STRICT=1 npm run check:rules-sync` Expected: 三者 exit 0。
- [ ] **Step 5: Commit** — `git commit -m "chore(release): 0.33.3 per-project 会话分桶——规则双副本多项目说明 + 版本链"`

---

### Task 7: 生成产物 + 全量门禁 + 手动验收

**Files:**
- Regenerate: `docs/tools/runtime.md`、`docs/capability-matrix.{json,md}`

- [ ] **Step 1: 产物** — `npm run build && npm run build-matrix && npm run gen:tool-docs && npm run check:budget`(顺序不可颠倒,gen 消费 matrix)。Expected: runtime.md 参数表含 stop_project/get_debug_output 的 project_path;无 budget 超限。
- [ ] **Step 2: 全量门禁** — `npm run lint && npm test`(已知:ui-layout-integration 可能并发 flaky,复跑一次绿即过,如实记录)。Expected: lint 0 错、测试全绿。
- [ ] **Step 3: 手动验收(需 GODOT_PATH)**——复用 `.superpowers/sdd/preview-acceptance.mjs` 模式写双项目验收脚本:fixture A + fixture B 先后 `run_project(preview=true)` → 断言**两进程同时活 >35s**(越过 30s 周期扫描)→ 关 A(getLastFinishedRunOutput('/A') 有内容)→ B 仍活 → get_debug_output(project_path=B) 正常 → 关 B。输出贴报告。
- [ ] **Step 4: Commit** — `git commit -m "docs(tools): 分桶参数文档与 capability-matrix 再生成"`。

---

## 验收标准(对照设计 v3.1)

1. 现有 77 process-state 用例 + 全部既有消费方零改动零行为变化(Task 1 验收)。
2. 跨项目并存/同项目互杀/上限/FIFO/状态机 per-project 语义(Task 2)。
3. orphan 周期扫描不杀非活跃窗口 + close 清全部(Task 3)。
4. 守卫总纲行为锁定:并发 await 窗口互不杀(C-1)、profiler 属主不被无关 run 销毁(I-1)、活跃切走后输出写对桶/关窗清对桶(Task 4)。
5. 活跃指针单写入方/audit 归属/logger project 字段(Task 5)。
6. 双副本一致 + 0.33.3 版本链 + 产物一致(Task 6/7)。
7. 手动双项目并行弹窗验收(Task 7)。
8. 实施后:`docs/reviews/` 第三方审查文档 + memory 登记(AGENTS.md §8/「完成前必登 memory」)。
