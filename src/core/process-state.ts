/**
 * Process state management for Godot MCP Enhanced.
 *
 * C-04: Async state-mutating operations are serialized through `enqueueAsync`.
 * Reads are still direct (no queueing) since they're atomic in the Node.js
 * single-threaded model. This prevents race conditions when MCP clients
 * introduce parallel tool calls.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { resolve as pathResolve } from 'path';
import { getLogger } from './logger.js';
import { killOrphanGodotProcesses as cleanupOrphanProcesses, resetOrphanScanTime } from './orphan-cleanup.js';

const isWin = process.platform === 'win32';

const MAX_OUTPUT_BUFFER_SIZE = 5000;
const MAX_SHORT_CONCURRENT = 3;

// ─── Cross-platform process termination ────────────────────────────────────

/** Kill process tree without blocking the event loop. Uses async spawn on Windows. */
export function forceKillTree(proc: ChildProcess): void {
  if (proc.killed) return;
  if (isWin) {
    try {
      const child = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      child.on('error', () => { proc.kill(); });
    } catch (err) {
      getLogger().debug('process-state', `taskkill failed, falling back to proc.kill: ${err}`);
      proc.kill();
    }
  } else {
    // P1.2: POSIX 对等 Windows taskkill /T — 先 pkill -P 杀直接子进程(Godot 可能
    // spawn 导入/资源工具子进程),再 kill 主进程。pkill 失败不阻断主进程 kill。
    if (proc.pid) {
      try {
        // P1: pkill may be absent (alpine w/o procps) → spawn emits an async
        // 'error' (ENOENT) that try/catch cannot intercept. Without a listener,
        // EventEmitter rethrows → uncaughtException → MCP server crash. SIGTERM
        // below is the unconditional fallback, so swallow pkill errors.
        const pk = spawn('pkill', ['-P', String(proc.pid)], { stdio: 'ignore' });
        pk.on('error', () => {});
      } catch (err) {
        getLogger().debug('process-state', `pkill failed, falling back to proc.kill: ${err}`);
      }
    }
    proc.kill('SIGTERM');
  }
}

/** 探测 PID 是否存活（signal 0，不发信号）。 */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 按 PID 杀进程树（与 forceKillTree 共享双平台语义，IMPORTANT-1）。
 * Windows taskkill /F /T 清整树；POSIX pkill -P 杀子进程 + SIGTERM 主进程
 * （Godot 可能 spawn 导入/资源子进程，对等 forceKillTree POSIX 分支）。
 * 导出仅为测试可测性（@internal）。
 */
export function killPidTree(pid: number): void {
  if (!pid) return;
  if (isWin) {
    try {
      const tk = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      tk.on('error', () => {});  // P1 先例：防 uncaughtException
    } catch { /* best effort */ }
  } else {
    try {
      const pk = spawn('pkill', ['-P', String(pid)], { stdio: 'ignore' });
      pk.on('error', () => {});  // P1 先例：pkill 缺失(alpine)防 uncaughtException
    } catch { /* best effort */ }
    try { process.kill(pid, 'SIGTERM'); } catch { /* best effort */ }
  }
}

/** Async kill: waits for 'close' event, with 5 s fallback. */
export function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // F-5: 进程已自然退出(exitCode !== null)也立即 resolve,避免无谓等 5s timer
    if (proc.killed || proc.exitCode !== null) { resolve(); return; }
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const timer = setTimeout(() => {
      forceKillTree(proc);
      done();
    }, 5000);

    proc.on('close', () => {
      clearTimeout(timer);
      done();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      done();
    });

    forceKillTree(proc);
  });
}

// ─── Module-level mutable state ─────────────────────────────────────────────
// Intentional design: module-scoped state accessed exclusively through the
// getter/setter functions below. This avoids class instantiation overhead
// while still providing encapsulation — consumers never touch these
// variables directly. Use resetState() for test isolation.
//
// ⚠️ CONCURRENCY / MULTI-INSTANCE LIMITATION (CR-3): The shared state below is
// shared across all callers within one MCP server process. In the default
// single-instance mode, acquireProcessSlot (serialized via enqueueAsync) plus
// the long-running lock implicitly bound cross-talk — a second run_project fails
// while the slot is busy, and short ops (query_scene_tree) are capped by
// acquireShortRunningSlot. setProjectDir / setRunningProcess are intentionally
// NOT enqueued: making them async would break all synchronous callers
// (ToolDispatcher, e2e tests). Residual risk is confined to:
//   (a) GODOT_MCP_MULTI_INSTANCE=true mixing local headless + remote instances,
//   (b) the window between long-lock release and the next setProjectDir.
// For true per-project isolation, run a separate MCP server process per project.
//
// ─── Per-project run sessions (设计 v3.1 §4.1) ──────────────────────────────
// 分桶语义:游戏进程/输出/快照/busy 按 project key 分桶存于 _sessions,兼容层
// 导出函数语义重定向到"活跃桶"。
// 活跃指针 = _projectDir(最近一次 run_project 写入;写入方收窄见设计 §4.7)。
// key='' 空桶 = 惰性兼容桶(无项目上下文时的读写落点;不进 listRunSessions、
// FIFO 可逐出;首次 setProjectDir(X) 后由惰性空桶重绑/废弃接管,设计 §4.1)。

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
let _exitedSessionOrder: string[] = [];   // 已结束桶 FIFO(逐出最旧;登记于 setRunningProcess(null),逐出消费后续任务接入)
let _projectDir = '';                     // 语义升级:活跃项目(最近一次 run_project)

// Short-running counter: query_scene_tree / inspect_node (seconds-level operations)
let _shortRunningCount = 0;

// 仅长生命周期 / 可能挂起的 Godot 进程注册（崩溃残留或 close 时机错位需 orphan 兜底）：
//   - run_project（runtime.ts:224，长生命周期游戏进程）
//   - gdscript-executor spawn（B-T4，原 only-run-project 致挂起脚本 + close → 孤儿无兜底）
// launch_editor 不注册（detached 编辑器，用户有意长期运行）。
// Task 2 归属化(设计 §4.1):Set<number> → Map<number, projectKey>——orphan 清理链(§4.4)按
// 桶归属排除全部活进程,防周期扫描误杀非活跃窗口;projectKey 缺省 ''(未归属,兼容旧调用)。
let _spawnedGodotPids = new Map<number, string>();

/** 记录本会话 spawn 的需要 orphan 兜底的 Godot 进程 PID(可选归属 project key)。 */
export function registerSpawnedGodotPid(pid: number, projectKey?: string): void {
  if (pid && pid > 0) _spawnedGodotPids.set(pid, projectKey ?? '');
}

/** 进程正常退出时移除（主动清理，避免集合累积死 PID）。 */
export function unregisterSpawnedGodotPid(pid: number): void {
  _spawnedGodotPids.delete(pid);
}

/** 测试用：读取当前 pid 集合(兼容层:返回 pid 数组,归属信息经 orphan ctx 内部消费)。 */
export function getSpawnedGodotPids(): number[] {
  return Array.from(_spawnedGodotPids.keys());
}

// ─── Per-project key normalization & lazy session access(设计 §4.1)─────────

/** 项目 key 归一化(设计 §4.1):resolve + win 下 lowercase;仅供 Map 索引。 */
export function normalizeProjectKey(p: string): string {
  const r = pathResolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 活跃桶 key:活跃指针非空时归一化,否则 ''(惰性兼容桶)。 */
export function activeKey(): string {
  return _projectDir ? normalizeProjectKey(_projectDir) : '';
}

/** 惰性获取/创建活跃桶(硬性实现要求,设计 §4.1——77 个现有用例依赖此语义)。 */
export function getOrCreateSession(key: string): RunSession {
  let s = _sessions.get(key);
  if (!s) {
    s = newSession(key ? key : _projectDir);
    if (key) s.displayPath = key;  // displayPath 首次用 key,后续 setProjectDir/setRunSessionProc 刷新
    _sessions.set(key, s);
  }
  return s;
}

// ─── Per-key run session API(设计 §4.2,Task 2)─────────────────────────────
// 跨项目路径的状态操作(供 runtime.ts 守卫总纲使用):均为 per-key 状态操作,
// 非依赖注入 setter,不违反 AGENTS.md「禁止新增模块级 setter 注入点」。

/** 谓词(设计 §4.1,Supervisor 模式):isAlive=starting/running/stopping(canSignal 同集)。 */
function isAliveStatus(st: RunSessionStatus): boolean {
  return st === 'starting' || st === 'running' || st === 'stopping';
}

/** 谓词:ended 态(exited/exited_early/errored)——桶保留可查,进 FIFO 可逐出。 */
function isEndedStatus(st: RunSessionStatus): boolean {
  return st === 'exited' || st === 'exited_early' || st === 'errored';
}

/** 桶进入 ended 态时登记 FIFO(同 key 重复结束移到队尾,防重复条目)并按需逐出。 */
function markEndedAndEvict(key: string): void {
  const i = _exitedSessionOrder.indexOf(key);
  if (i !== -1) _exitedSessionOrder.splice(i, 1);
  _exitedSessionOrder.push(key);
  evictExitedIfNeeded();
}

/** 已结束桶上限 FIFO 逐出(设计 §4.1:默认 16,GODOT_MCP_MAX_FINISHED_SESSIONS 每调用读取;
 *  活跃桶永不逐出;order 残留条目(空桶重绑后遗留的 '',Task 1 交接点 1)delete 为 no-op,安全跳过)。 */
function evictExitedIfNeeded(): void {
  const max = Math.max(1, Number(process.env.GODOT_MCP_MAX_FINISHED_SESSIONS) || 16);
  while (_exitedSessionOrder.length > max) {
    const oldest = _exitedSessionOrder.shift();
    if (oldest !== undefined && oldest !== activeKey()) _sessions.delete(oldest);
  }
}

/** per-key 路径的快照挪移 + 进程结束态判定(设计 §4.1):
 *  非空输出 → 挪入快照并按 2s 阈值判 exited_early/exited;无输出且曾运行(startTime>0)→ exited。
 *  已是 ended 态(markSessionExited 先行的权威判定,含 errored)不覆盖——防 close 链中
 *  markSessionExited → clearRunSession 的 errored 被 stash 冲掉。 */
function stashToSnapshot(key: string, s: RunSession): void {
  if (s.outputBuffer.length > 0) {
    if (!isEndedStatus(s.status)) {
      const early = s.processStartTime > 0 && Date.now() - s.processStartTime < 2_000;
      s.status = early ? 'exited_early' : 'exited';
      markEndedAndEvict(key);
    }
    s.lastFinishedRunOutput = s.outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
    s.outputBuffer = [];
  } else if (!isEndedStatus(s.status) && s.processStartTime > 0) {
    s.status = 'exited';
    markEndedAndEvict(key);
  }
}

/** 读取指定项目桶(缺省=活跃桶);未创建/已逐出返回 undefined。 */
export function getSession(projectPath?: string): RunSession | undefined {
  const key = projectPath === undefined ? activeKey() : normalizeProjectKey(projectPath);
  return _sessions.get(key);
}

/** 会话清单(设计 §4.1:'' 空桶不进列表;pid 无进程时为 null)。 */
export function listRunSessions(): Array<{ projectPath: string; displayPath: string; status: RunSessionStatus; pid: number | null }> {
  const out: Array<{ projectPath: string; displayPath: string; status: RunSessionStatus; pid: number | null }> = [];
  for (const [key, s] of _sessions) {
    if (key === '') continue;   // '' 空桶不进列表(设计 §4.1)
    out.push({ projectPath: key, displayPath: s.displayPath, status: s.status, pid: s.proc?.pid ?? null });
  }
  return out;
}

/** 指定桶的进程(守卫身份校验用:getRunSessionProc(key) === proc)。 */
export function getRunSessionProc(projectPath: string): ChildProcess | null {
  return _sessions.get(normalizeProjectKey(projectPath))?.proc ?? null;
}

/** 按 key 写入 proc(设计 §4.2 C-1):forceKillTree 仅针对**该桶**旧 proc,绝不碰活跃桶
 *  或其他桶——run_project 主流程必须用本函数,不得用活跃桶语义的 setRunningProcess。 */
export function setRunSessionProc(projectPath: string, proc: ChildProcess | null, skipBusyCheck?: boolean): void {
  const key = normalizeProjectKey(projectPath);
  const s = getOrCreateSession(key);
  if (s.displayPath === key) s.displayPath = projectPath;   // Task 1 交接点 2:首次用原始写法刷新
  if (!skipBusyCheck && s.busy) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  if (s.proc && !s.proc.killed && proc !== s.proc) {
    forceKillTree(s.proc);
  }
  s.proc = proc;
  if (proc) {
    s.status = 'running';
    s.processStartTime = Date.now();
  } else {
    // status 仍为旧值(running/stopping 等)→ stashToSnapshot 内完整 early/exited 判定
    stashToSnapshot(key, s);
  }
}

/** 按 key 释放 busy(设计 §4.2 C-1):主流程 busy 释放显式传 key,不落活跃桶。 */
export function releaseRunSessionBusy(projectPath: string): void {
  const s = _sessions.get(normalizeProjectKey(projectPath));
  if (s) { s.busy = false; s.busyOwner = ''; s.busySince = 0; }
}

/** 清 X 桶的 proc/busy/快照挪移(守卫体内动作用;不杀进程——killProcess 由调用方负责,
 *  活跃指针不转移,设计 §5:被清桶保持可查询)。 */
export function clearRunSession(projectPath: string): void {
  const key = normalizeProjectKey(projectPath);
  const s = _sessions.get(key);
  if (!s) return;
  s.busy = false; s.busyOwner = ''; s.busySince = 0;
  if (s.proc) { s.proc = null; }
  stashToSnapshot(key, s);
  s.processStartTime = 0;
}

/** killProcess 前设 stopping 态(仅 running/starting 可转;ended 态不动)。 */
export function markSessionStopping(projectPath: string): void {
  const s = _sessions.get(normalizeProjectKey(projectPath));
  if (s && (s.status === 'running' || s.status === 'starting')) s.status = 'stopping';
}

/** 直接设置桶状态(spawn 失败终态 'errored' 等);转 ended 态时登记 FIFO。 */
export function setSessionStatus(projectPath: string, status: RunSessionStatus): void {
  const key = normalizeProjectKey(projectPath);
  const s = getOrCreateSession(key);
  s.status = status;
  if (isEndedStatus(status)) markEndedAndEvict(key);
}

/** close 判定(设计 §4.1 状态机,权威入口):2s 内退出=exited_early 优先于 code 判定;
 *  2s 外 code≠0=errored;否则 exited。不创建桶(未知桶 no-op)。 */
export function markSessionExited(projectPath: string, exitCode: number | null): void {
  const key = normalizeProjectKey(projectPath);
  const s = _sessions.get(key);
  if (!s) return;
  const early = s.processStartTime > 0 && Date.now() - s.processStartTime < 2_000;
  s.status = early ? 'exited_early' : (exitCode !== null && exitCode !== 0 ? 'errored' : 'exited');
  markEndedAndEvict(key);
}

/** orphan 清理链排除集合(设计 §4.4):全部桶内活进程——判据为"有管理中的 proc 对象"
 *  (未 killed 且未退出),不做系统级 pid 探测(orphan 第一层自会 isPidAlive)。 */
export function getActiveRunPids(): number[] {
  const out: number[] = [];
  for (const s of _sessions.values()) {
    const p = s.proc;
    if (p?.pid && !p.killed && p.exitCode == null) out.push(p.pid);
  }
  return out;
}

/** 杀全部桶活进程并清桶(GodotServer.close 用,设计 §5:不留孤儿)。 */
export async function killAllRunSessions(): Promise<void> {
  for (const [key, s] of _sessions) {
    if (s.proc && !s.proc.killed) {
      s.status = 'stopping';
      await killProcess(s.proc);
    }
    s.proc = null;
    s.busy = false; s.busyOwner = ''; s.busySince = 0;
    stashToSnapshot(key, s);
    s.processStartTime = 0;
  }
}

/** 运行中上限检查(设计 §4.1:GODOT_MCP_MAX_SESSIONS 每调用读取,默认 4;同项目覆盖
 *  不算新增名额;溢出拒绝并附在跑会话清单,提示先 stop——不自动逐出运行中进程)。 */
export function ensureSessionCapacity(projectPath: string): void {
  const max = Math.max(1, Number(process.env.GODOT_MCP_MAX_SESSIONS) || 4);
  const alive = listRunSessions().filter(x => isAliveStatus(x.status));
  const key = normalizeProjectKey(projectPath);
  const alreadyRunning = alive.some(x => x.projectPath === key);
  if (!alreadyRunning && alive.length >= max) {
    throw new Error(
      `GODOT_MCP_MAX_SESSIONS (${max}) reached. Sessions running: ${alive.map(x => x.displayPath).join(', ')}. Use stop_project first.`,
    );
  }
}

// ─── C-04: Async queue for serializing state mutations ────────────────────────
let _queueTail: Promise<void> = Promise.resolve();

/** Serialize an async state-mutating operation. Ensures only one async mutation
 *  is in-flight at a time. Supports returning a value from the serialized function. */
function enqueueAsync<T>(fn: () => (Promise<T> | T)): Promise<T> {
  let resolve!: (value: void) => void;
  const prev = _queueTail;
  _queueTail = new Promise<void>((r) => { resolve = r; });
  return prev
    .then(() => fn())
    .then(
      (result) => { resolve(); return result; },
      (err) => { resolve(); throw err; },
    );
}

// ─── Long-running process lock ──────────────────────────────────────────────

export function isProcessBusy(): boolean {
  return getOrCreateSession(activeKey()).busy;
}

/**
 * Acquire the long-running process slot through the async serialization queue.
 * Serialized via enqueueAsync to prevent race conditions when MCP clients
 * issue parallel tool calls (e.g. run_project + execute_gdscript simultaneously).
 * Returns true if acquired, false if slot is busy.
 * Task 2 加可选 projectPath(设计 §4.2):显式传参时锁**目标桶**——run_project 现状顺序是
 * acquire 先于 setProjectDir,按活跃桶锁会锁错桶;缺省仍锁活跃桶(兼容层)。
 */
export async function acquireProcessSlot(owner: string = '', projectPath?: string): Promise<boolean> {
  const key = projectPath !== undefined ? normalizeProjectKey(projectPath) : activeKey();
  return enqueueAsync(() => {
    // 临界区保持同步(禁 await,设计 §4.2 M-4);数据源=目标桶字段
    const s = getOrCreateSession(key);
    if (s.busy) {
      // I-06: 即时检查进程存活 — 仅在进程对象已注册时才检查
      if (s.proc && (s.proc.killed || s.proc.exitCode !== null)) {
        getLogger().warn('process-state', `Process slot held by "${s.busyOwner}", process dead — auto-releasing`);
        s.busy = false;
        s.busyOwner = '';
        s.busySince = 0;
      } else if (s.busySince > 0 && Date.now() - s.busySince > 300_000) {
        const processDead = !s.proc || s.proc.killed || s.proc.exitCode !== null;
        if (processDead) {
          getLogger().warn('process-state', `Process slot held by "${s.busyOwner}" for >5min, process dead — auto-releasing`);
          s.busy = false;
          s.busyOwner = '';
          s.busySince = 0;
        } else {
          getLogger().warn('process-state', `Process slot held by "${s.busyOwner}" for >5min, process still alive — not releasing`);
        }
      }
      if (s.busy) return false;
    }
    s.busy = true;
    s.busyOwner = owner;
    s.busySince = Date.now();
    return true;
  });
}

export function setProcessBusy(busy: boolean): void {
  const s = getOrCreateSession(activeKey());
  s.busy = busy;
  if (!busy) {
    s.busyOwner = '';
    s.busySince = 0;
  }
}

/** Get info about what is currently holding the long-running lock. */
export function getBusyInfo(): { owner: string; startTime: number; projectDir: string } {
  const s = getOrCreateSession(activeKey());
  return { owner: s.busyOwner, startTime: s.processStartTime, projectDir: _projectDir };
}

/** Build a user-friendly error message when the long-running slot is occupied.
 *  Task 2 加可选 targetKey(设计 §4.2 M-1):多桶同时 busy 时报**目标桶**的持锁信息
 *  (owner/时长/项目路径取自该桶);缺省报活跃桶(兼容层)。 */
export function buildBusyErrorMessage(targetKey?: string): string {
  const key = targetKey !== undefined ? normalizeProjectKey(targetKey) : activeKey();
  const s = getOrCreateSession(key);
  if (!s.busy) return '';

  const details: string[] = [];
  if (s.processStartTime > 0) {
    const elapsed = Math.round((Date.now() - s.processStartTime) / 1000);
    details.push(`running for ${elapsed}s`);
  }
  if (s.displayPath) {
    details.push(`project: ${s.displayPath}`);
  }

  let msg = 'Error: another Godot process is running';
  if (s.busyOwner) {
    msg += ` (started by ${s.busyOwner}`;
    if (details.length > 0) msg += ', ' + details.join(', ');
    msg += ')';
  } else if (details.length > 0) {
    msg += ' (' + details.join(', ') + ')';
  }
  return msg + '. Use stop_project to release it.';
}

// ─── Short-running process lock ─────────────────────────────────────────────

export function acquireShortRunningSlot(): boolean {
  if (_shortRunningCount >= MAX_SHORT_CONCURRENT) return false;
  _shortRunningCount++;
  return true;
}

export function releaseShortRunningSlot(): void {
  _shortRunningCount = Math.max(0, _shortRunningCount - 1);
}

export function getShortRunningCount(): number {
  return _shortRunningCount;
}

// ─── Running process management(兼容层:语义重定向活跃桶,签名不变)─────────

export function getRunningProcess(): ChildProcess | null {
  return getOrCreateSession(activeKey()).proc;
}

export function setRunningProcess(proc: ChildProcess | null, skipBusyCheck = false): void {
  const s = getOrCreateSession(activeKey());
  if (!skipBusyCheck && s.busy && proc !== null) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  // Clearing the process always clears busy state
  if (proc === null) {
    if (s.busy) {
      getLogger().debug('process-state', `setRunningProcess(null) called while process is busy (owner: ${s.busyOwner || '(unknown)'}). This bypasses acquire/release semantics.`);
    }
    s.busy = false;
    s.busyOwner = '';
    s.busySince = 0;
  }
  // forceKillTree 段保持"活跃桶旧 proc"语义(Task 2 加 per-key API setRunSessionProc 后 runtime.ts 停用本函数)
  if (s.proc && !s.proc.killed && proc !== s.proc) {
    forceKillTree(s.proc);
  }
  s.proc = proc;
  if (!proc) {
    // 该桶运行结束:快照挪入本桶 + 登记 FIFO(设计 §4.1 已结束桶序,逐出消费后续任务接入)
    stashOutputBuffer(s);
    s.outputBuffer = [];
    s.processStartTime = 0;
    const key = activeKey();
    if (!_exitedSessionOrder.includes(key)) _exitedSessionOrder.push(key);
  }
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

export function clearOutputBuffer(projectKey?: string): void {
  const s = getOrCreateSession(projectKey ?? activeKey());
  stashOutputBuffer(s);
  s.outputBuffer = [];
}

/** B-1 修复(2026-09-13 预览模式设计,分桶版):桶输出缓冲被清空前,非空内容
 *  挪入该桶最近结束运行快照(move 语义;空清空不覆盖旧快照——换窗时序下
 *  close handler 先存,run_project 开头的 clearOutputBuffer 时 buffer 已空,
 *  不能把刚存的快照冲掉)。@internal */
function stashOutputBuffer(s: RunSession): void {
  if (s.outputBuffer.length > 0) {
    s.lastFinishedRunOutput = s.outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}

/** 最近一次已结束运行会话的输出快照(活跃桶;get_debug_output 在当前缓冲为
 *  空且无运行进程时回落读取)。 */
export function getLastFinishedRunOutput(): string[] {
  return getOrCreateSession(activeKey()).lastFinishedRunOutput;
}

export function setOutputBuffer(buf: string[], key?: string): void {
  getOrCreateSession(key ?? activeKey()).outputBuffer = buf;
}

export function getProcessStartTime(): number {
  return getOrCreateSession(activeKey()).processStartTime;
}

export function setProcessStartTime(t: number, key?: string): void {
  getOrCreateSession(key ?? activeKey()).processStartTime = t;
}

export function getProjectDir(): string {
  return _projectDir;
}

export function setProjectDir(d: string): void {
  const oldKey = activeKey();
  _projectDir = d;
  const newKey = activeKey();
  if (newKey === oldKey) {
    const existing = _sessions.get(newKey);
    if (existing) existing.displayPath = d;
    return;
  }
  const existing = _sessions.get(newKey);
  if (existing) {
    existing.displayPath = d;  // 已有桶:仅刷新显示路径,不覆盖该桶既有数据
    return;
  }
  const old = _sessions.get(oldKey);
  // 惰性空桶跟随重绑(兼容层,设计 §4.1 惰性创建的补全):单例时代 setProjectDir
  // 只换目录标签、状态全保留;分桶后,从未承载真实运行(proc=null/无输出/无快照)的
  // 惰性空桶里的状态(startTime/busy 等"无项目上下文"写入)随活跃声明归属新项目。
  // 已承载真实运行数据的桶(有 proc/输出/快照)不迁移,留在 Map 中等待 FIFO 逐出。
  if (old && old.proc === null && old.status === 'exited'
    && old.outputBuffer.length === 0 && old.lastFinishedRunOutput.length === 0) {
    _sessions.delete(oldKey);
    old.displayPath = d;
    _sessions.set(newKey, old);
  } else {
    _sessions.set(newKey, newSession(d));
  }
}

/** Reset all module-level state — for test isolation. */
export function resetState(): void {
  _sessions = new Map();
  _exitedSessionOrder = [];
  _projectDir = '';
  _shortRunningCount = 0;
  _spawnedGodotPids = new Map();
  _queueTail = Promise.resolve();
  resetOrphanScanTime();
}

// Export async queue for consumers that need serialized async operations (e.g. killProcess)
export { enqueueAsync };

// P2-4: killOrphanGodotProcesses 薄包装(逻辑移至 orphan-cleanup.ts,ctx 注入破循环)。
// importer 签名不变(仍 ps.killOrphanGodotProcesses(projectDir, options))。
// Task 2(设计 §4.4):排除集合从"活跃桶单 pid"改为 activePids=全部桶内活进程,
// 防周期 orphan 扫描误杀非活跃窗口;spawnedPids 同步为归属化 Map。
export async function killOrphanGodotProcesses(
  projectDir?: string,
  options?: { fullSystemScan?: boolean },
): Promise<number> {
  return cleanupOrphanProcesses(
    {
      spawnedPids: _spawnedGodotPids,
      activePids: getActiveRunPids(),
      isPidAlive,
      killPidTree,
    },
    projectDir,
    options,
  );
}

