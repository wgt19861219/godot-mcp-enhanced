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
// Intentional design: module-scoped "singleton" state accessed exclusively
// through the getter/setter functions below. This avoids class instantiation
// overhead while still providing encapsulation — consumers never touch these
// variables directly. Use resetState() for test isolation.
//
// ⚠️ CONCURRENCY / MULTI-INSTANCE LIMITATION (CR-3): This singleton state is
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
let _runningProcess: ChildProcess | null = null;
let _outputBuffer: string[] = [];
// B-1 修复(2026-09-13 预览模式设计):最近一次已结束运行会话的输出快照。
// setRunningProcess(null)/clearOutputBuffer 清空 _outputBuffer 前把非空内容挪入此处
// (move 语义;空清空不覆盖旧快照——换窗时序下 close handler 先存,run_project 开头
// 的 clearOutputBuffer 时 buffer 已空,不能把刚存的快照冲掉)。
let _lastFinishedRunOutput: string[] = [];
let _processStartTime = 0;
let _projectDir = '';

// Long-running lock: run_project only (game process that persists for seconds/minutes)
let _processBusy = false;
let _busyOwner = '';
let _busySince = 0;

// Short-running counter: query_scene_tree / inspect_node (seconds-level operations)
let _shortRunningCount = 0;

// 仅长生命周期 / 可能挂起的 Godot 进程注册（崩溃残留或 close 时机错位需 orphan 兜底）：
//   - run_project（runtime.ts:224，长生命周期游戏进程）
//   - gdscript-executor spawn（B-T4，原 only-run_project 致挂起脚本 + close → 孤儿无兜底）
// launch_editor 不注册（detached 编辑器，用户有意长期运行）。
let _spawnedGodotPids: Set<number> = new Set();

/** 记录本会话 spawn 的需要 orphan 兜底的 Godot 进程 PID（仅 run_project）。 */
export function registerSpawnedGodotPid(pid: number): void {
  if (pid && pid > 0) _spawnedGodotPids.add(pid);
}

/** 进程正常退出时移除（主动清理，避免集合累积死 PID）。 */
export function unregisterSpawnedGodotPid(pid: number): void {
  _spawnedGodotPids.delete(pid);
}

/** 测试用：读取当前集合。 */
export function getSpawnedGodotPids(): number[] {
  return Array.from(_spawnedGodotPids);
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
  return _processBusy;
}

/**
 * Acquire the long-running process slot through the async serialization queue.
 * Serialized via enqueueAsync to prevent race conditions when MCP clients
 * issue parallel tool calls (e.g. run_project + execute_gdscript simultaneously).
 * Returns true if acquired, false if slot is busy.
 */
export async function acquireProcessSlot(owner: string = ''): Promise<boolean> {
  return enqueueAsync(() => {
    if (_processBusy) {
      // I-06: 即时检查进程存活 — 仅在进程对象已注册时才检查
      if (_runningProcess && (_runningProcess.killed || _runningProcess.exitCode !== null)) {
        getLogger().warn('process-state', `Process slot held by "${_busyOwner}", process dead — auto-releasing`);
        _processBusy = false;
        _busyOwner = '';
        _busySince = 0;
      } else if (_busySince > 0 && Date.now() - _busySince > 300_000) {
        const processDead = !_runningProcess || _runningProcess.killed || _runningProcess.exitCode !== null;
        if (processDead) {
          getLogger().warn('process-state', `Process slot held by "${_busyOwner}" for >5min, process dead — auto-releasing`);
          _processBusy = false;
          _busyOwner = '';
          _busySince = 0;
        } else {
          getLogger().warn('process-state', `Process slot held by "${_busyOwner}" for >5min, process still alive — not releasing`);
        }
      }
      if (_processBusy) return false;
    }
    _processBusy = true;
    _busyOwner = owner;
    _busySince = Date.now();
    return true;
  });
}

export function setProcessBusy(busy: boolean): void {
  _processBusy = busy;
  if (!busy) {
    _busyOwner = '';
    _busySince = 0;
  }
}

/** Get info about what is currently holding the long-running lock. */
export function getBusyInfo(): { owner: string; startTime: number; projectDir: string } {
  return { owner: _busyOwner, startTime: _processStartTime, projectDir: _projectDir };
}

/** Build a user-friendly error message when the long-running slot is occupied. */
export function buildBusyErrorMessage(): string {
  if (!_processBusy) return '';
  const info = getBusyInfo();

  const details: string[] = [];
  if (info.startTime > 0) {
    const elapsed = Math.round((Date.now() - info.startTime) / 1000);
    details.push(`running for ${elapsed}s`);
  }
  if (info.projectDir) {
    details.push(`project: ${info.projectDir}`);
  }

  let msg = 'Error: another Godot process is running';
  if (info.owner) {
    msg += ` (started by ${info.owner}`;
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

// ─── Running process management ─────────────────────────────────────────────

export function getRunningProcess(): ChildProcess | null {
  return _runningProcess;
}

export function setRunningProcess(proc: ChildProcess | null, skipBusyCheck = false): void {
  if (!skipBusyCheck && _processBusy && proc !== null) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  // Clearing the process always clears busy state
  if (proc === null) {
    if (_processBusy) {
      getLogger().debug('process-state', `setRunningProcess(null) called while process is busy (owner: ${_busyOwner || '(unknown)'}). This bypasses acquire/release semantics.`);
    }
    _processBusy = false;
    _busyOwner = '';
    _busySince = 0;
  }
  if (_runningProcess && !_runningProcess.killed && proc !== _runningProcess) {
    forceKillTree(_runningProcess);
  }
  _runningProcess = proc;
  if (!proc) {
    stashOutputBuffer();
    _outputBuffer = [];
    _processStartTime = 0;
  }
}

export function getOutputBuffer(): string[] {
  return _outputBuffer;
}

export function appendOutput(lines: string[]): void {
  _outputBuffer.push(...lines);
  if (_outputBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
    _outputBuffer = _outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}

export function clearOutputBuffer(): void {
  stashOutputBuffer();
  _outputBuffer = [];
}

/** B-1 修复:输出缓冲被清空前,非空内容挪入最近结束运行快照。@internal */
function stashOutputBuffer(): void {
  if (_outputBuffer.length > 0) {
    _lastFinishedRunOutput = _outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}

/** 最近一次已结束运行会话的输出快照(get_debug_output 在当前缓冲为空且无运行进程时回落读取)。 */
export function getLastFinishedRunOutput(): string[] {
  return _lastFinishedRunOutput;
}

export function setOutputBuffer(buf: string[]): void {
  _outputBuffer = buf;
}

export function getProcessStartTime(): number {
  return _processStartTime;
}

export function setProcessStartTime(t: number): void {
  _processStartTime = t;
}

export function getProjectDir(): string {
  return _projectDir;
}

export function setProjectDir(d: string): void {
  _projectDir = d;
}

/** Reset all module-level state — for test isolation. */
export function resetState(): void {
  _runningProcess = null;
  _outputBuffer = [];
  _lastFinishedRunOutput = [];
  _processStartTime = 0;
  _projectDir = '';
  _processBusy = false;
  _busyOwner = '';
  _busySince = 0;
  _shortRunningCount = 0;
  _spawnedGodotPids = new Set();
  _queueTail = Promise.resolve();
  resetOrphanScanTime();
}

// Export async queue for consumers that need serialized async operations (e.g. killProcess)
export { enqueueAsync };

// P2-4: killOrphanGodotProcesses 薄包装(逻辑移至 orphan-cleanup.ts,ctx 注入破循环)。
// importer 签名不变(仍 ps.killOrphanGodotProcesses(projectDir, options))。
export async function killOrphanGodotProcesses(
  projectDir?: string,
  options?: { fullSystemScan?: boolean },
): Promise<number> {
  return cleanupOrphanProcesses(
    {
      spawnedPids: _spawnedGodotPids,
      runningPid: _runningProcess?.pid,
      isPidAlive,
      killPidTree,
    },
    projectDir,
    options,
  );
}

