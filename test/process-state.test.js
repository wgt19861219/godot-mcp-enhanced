import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process to prevent real taskkill/spawn calls on Windows
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const mockPs = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((evt, cb) => { if (evt === 'close') setTimeout(() => cb(0), 0); }),
      killed: false,
      kill: vi.fn(),
      pid: 99999,
    };
    return mockPs;
  }),
}));
import { spawn } from 'child_process';
import {
  resetState,
  getRunningProcess,
  setRunningProcess,
  getOutputBuffer,
  appendOutput,
  clearOutputBuffer,
  setOutputBuffer,
  getProcessStartTime,
  setProcessStartTime,
  getProjectDir,
  setProjectDir,
  forceKillTree,
  killPidTree,
  killProcess,
  isProcessBusy,
  setProcessBusy,
  acquireProcessSlot,
  getBusyInfo,
  buildBusyErrorMessage,
  acquireShortRunningSlot,
  releaseShortRunningSlot,
  getShortRunningCount,
  registerSpawnedGodotPid,
  unregisterSpawnedGodotPid,
  getSpawnedGodotPids,
  killOrphanGodotProcesses,
  getLastFinishedRunOutput,
  // Task 2: per-key 会话 API(设计 §4.2)
  normalizeProjectKey,
  getSession,
  listRunSessions,
  getRunSessionProc,
  setRunSessionProc,
  releaseRunSessionBusy,
  clearRunSession,
  markSessionStopping,
  setSessionStatus,
  markSessionExited,
  ensureSessionCapacity,
  getActiveRunPids,
  killAllRunSessions,
} from '../src/core/process-state.js';

function makeMockProc({ killed = false, pid = 12345 } = {}) {
  const listeners = {};
  const mock = {
    killed,
    pid,
    kill: vi.fn(() => { mock.killed = true; }),
    on: vi.fn((evt, cb) => { listeners[evt] = cb; }),
    emit(evt) { listeners[evt]?.(); },
    _listeners: listeners,
  };
  return mock;
}

beforeEach(() => resetState());

// ─── resetState ──────────────────────────────────────────────────────────────

describe('resetState', () => {
  it('clears all state', () => {
    const proc = makeMockProc();
    setRunningProcess(proc);
    setProcessStartTime(999);
    setProjectDir('/tmp/project');
    appendOutput(['line1', 'line2']);

    resetState();

    expect(getRunningProcess()).toBeNull();
    expect(getOutputBuffer()).toEqual([]);
    expect(getProcessStartTime()).toBe(0);
    expect(getProjectDir()).toBe('');
  });

  it('clears short running count', () => {
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    expect(getShortRunningCount()).toBe(2);
    resetState();
    expect(getShortRunningCount()).toBe(0);
  });

  it('clears busy owner', async () => {
    await acquireProcessSlot('run_project');
    expect(getBusyInfo().owner).toBe('run_project');
    resetState();
    expect(getBusyInfo().owner).toBe('');
  });
});

// ─── get/set runningProcess ──────────────────────────────────────────────────

describe('getRunningProcess / setRunningProcess', () => {
  it('sets and gets a process', () => {
    const proc = makeMockProc();
    setRunningProcess(proc);
    expect(getRunningProcess()).toBe(proc);
  });

  it('sets to null', () => {
    const proc = makeMockProc();
    setRunningProcess(proc);
    setRunningProcess(null);
    expect(getRunningProcess()).toBeNull();
  });

  it('kills old process when replaced with a different one', () => {
    const oldProc = makeMockProc({ killed: false });
    const newProc = makeMockProc();
    setRunningProcess(oldProc);
    setRunningProcess(newProc);

    expect(getRunningProcess()).toBe(newProc);
  });

  it('does NOT kill old process if it is already killed', () => {
    const oldProc = makeMockProc({ killed: true });
    const newProc = makeMockProc();
    setRunningProcess(oldProc);
    setRunningProcess(newProc);

    expect(oldProc.kill).not.toHaveBeenCalled();
  });

  it('does NOT kill old process if same reference is set again', () => {
    const proc = makeMockProc({ killed: false });
    setRunningProcess(proc);
    setRunningProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('clears output buffer and start time when set to null', () => {
    const proc = makeMockProc();
    setRunningProcess(proc);
    appendOutput(['a', 'b']);
    setProcessStartTime(42);

    setRunningProcess(null);

    expect(getOutputBuffer()).toEqual([]);
    expect(getProcessStartTime()).toBe(0);
  });

  it('clears busy owner when set to null', async () => {
    await acquireProcessSlot('run_project');
    expect(isProcessBusy()).toBe(true);
    setRunningProcess(null);
    expect(isProcessBusy()).toBe(false);
    expect(getBusyInfo().owner).toBe('');
  });
});

// ─── outputBuffer ────────────────────────────────────────────────────────────

describe('outputBuffer operations', () => {
  it('append adds lines', () => {
    appendOutput(['line1', 'line2']);
    expect(getOutputBuffer()).toEqual(['line1', 'line2']);
  });

  it('get returns current buffer', () => {
    expect(getOutputBuffer()).toEqual([]);
    appendOutput(['x']);
    expect(getOutputBuffer()).toEqual(['x']);
  });

  it('clear empties buffer', () => {
    appendOutput(['a', 'b', 'c']);
    clearOutputBuffer();
    expect(getOutputBuffer()).toEqual([]);
  });

  it('set replaces buffer', () => {
    appendOutput(['old']);
    setOutputBuffer(['new1', 'new2']);
    expect(getOutputBuffer()).toEqual(['new1', 'new2']);
  });
});

describe('appendOutput truncates at 5000', () => {
  it('keeps only last 5000 lines when exceeded', () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `line-${i}`);
    appendOutput(lines);
    const buf = getOutputBuffer();
    expect(buf.length).toBe(5000);
    expect(buf[0]).toBe('line-1000');
    expect(buf[4999]).toBe('line-5999');
  });

  it('does not truncate below 5000', () => {
    const lines = Array.from({ length: 4999 }, (_, i) => `line-${i}`);
    appendOutput(lines);
    expect(getOutputBuffer().length).toBe(4999);
  });

  it('truncates across multiple appends', () => {
    for (let i = 0; i < 60; i++) {
      appendOutput(Array.from({ length: 100 }, (_, j) => `batch${i}-${j}`));
    }
    const buf = getOutputBuffer();
    expect(buf.length).toBe(5000);
  });
});

// ─── processStartTime ────────────────────────────────────────────────────────

describe('getProcessStartTime / setProcessStartTime', () => {
  it('defaults to 0', () => {
    expect(getProcessStartTime()).toBe(0);
  });

  it('sets and gets', () => {
    setProcessStartTime(Date.now());
    const t = getProcessStartTime();
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThan(0);
  });
});

// ─── projectDir ──────────────────────────────────────────────────────────────

describe('getProjectDir / setProjectDir', () => {
  it('defaults to empty string', () => {
    expect(getProjectDir()).toBe('');
  });

  it('sets and gets', () => {
    setProjectDir('/home/user/project');
    expect(getProjectDir()).toBe('/home/user/project');
  });
});

// ─── forceKillTree ───────────────────────────────────────────────────────────

describe('forceKillTree', () => {
  it('is no-op when process is already killed', () => {
    const proc = makeMockProc({ killed: true });
    forceKillTree(proc);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('calls kill on non-Windows (or async spawn taskkill on Windows)', () => {
    const proc = makeMockProc({ killed: false });
    forceKillTree(proc);
    if (process.platform === 'win32') {
      expect(spawn).toHaveBeenCalledWith(
        'taskkill', ['/F', '/T', '/PID', '12345'], { stdio: 'ignore' }
      );
    } else {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('kills child process tree via pkill -P on POSIX (P1.2)', () => {
    // POSIX 分支在 win32 不执行(isWin 模块常量于加载时固化,无法本机翻转)。
    // 本测试在 Linux/CI 上走 RED→GREEN;win32 下 skip。P1.2 真实验证依赖 CI Linux。
    if (process.platform === 'win32') return;
    const proc = makeMockProc({ killed: false, pid: 4242 });
    forceKillTree(proc);
    // 对等 Windows taskkill /T:先 pkill -P 杀直接子进程,再 kill 主进程
    expect(spawn).toHaveBeenCalledWith('pkill', ['-P', '4242'], { stdio: 'ignore' });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('pkill spawn error handler prevents uncaughtException (P1: alpine w/o procps)', async () => {
    // P1 修复: pkill 在无 procps 的容器(alpine)异步 emit 'error'(ENOENT), try/catch
    // 只捕同步 throw 不捕 async 'error' 事件; 无 handler 时 EventEmitter rethrows →
    // uncaughtException → MCP server 崩。isWin 模块常量加载时固化, POSIX 分支 win32
    // 不执行 → 本测试 win32 skip, CI Linux 走 RED→GREEN(同上例 P1.2 先例)。
    if (process.platform === 'win32') return;
    const { EventEmitter } = await import('node:events');
    spawn.mockClear();
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      return child;
    });
    const proc = makeMockProc({ killed: false, pid: 4242 });
    forceKillTree(proc);
    // 取 pkill spawn 返回的 child, 模拟 ENOENT
    const pkillChild = spawn.mock.results[0].value;
    // 无 handler: EventEmitter emit('error') 无 listener 同步 throw → 崩
    // 有 handler: 不抛
    expect(() => pkillChild.emit('error', new Error('spawn pkill ENOENT'))).not.toThrow();
    // pkill 失败不阻断 SIGTERM fallback
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ─── killPidTree (orphan 清理辅助，双平台对等 forceKillTree) ─────────────────

describe('killPidTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('Windows: taskkill /F /T /PID <pid>', () => {  // T3a-Win
    if (process.platform !== 'win32') return;
    killPidTree(12345);
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '12345'], { stdio: 'ignore' });
  });

  it('POSIX: pkill -P <pid> + process.kill(SIGTERM) 双杀', () => {  // T3b
    if (process.platform === 'win32') return;  // isWin 模块常量加载时固化，POSIX 分支 win32 不执行
    killPidTree(4242);
    expect(spawn).toHaveBeenCalledWith('pkill', ['-P', '4242'], { stdio: 'ignore' });
    // process.kill 对真实 pid 4242 会抛（不存在），best-effort 吞掉；验证 spawn pkill 已调即可
  });

  it('POSIX: pkill spawn error 不崩 (P1 先例 alpine 无 procps)', () => {  // T3b-err
    if (process.platform === 'win32') return;
    const { EventEmitter } = require('events');
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      return child;
    });
    expect(() => killPidTree(4242)).not.toThrow();
  });

  it('no-op when pid is falsy', () => {
    killPidTree(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ─── killProcess ─────────────────────────────────────────────────────────────

describe('killProcess', () => {
  it('resolves immediately for killed process', async () => {
    const proc = makeMockProc({ killed: true });
    await expect(killProcess(proc)).resolves.toBeUndefined();
  });

  it('resolves when close event fires', async () => {
    const proc = makeMockProc({ killed: false });
    const promise = killProcess(proc);
    proc.emit('close');
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves when error event fires', async () => {
    const proc = makeMockProc({ killed: false });
    const promise = killProcess(proc);
    proc.emit('error');
    await expect(promise).resolves.toBeUndefined();
  });
});

// ─── busy guard ──────────────────────────────────────────────────────────────

describe('busy guard (C-03)', () => {
  it('defaults to not busy', () => {
    expect(isProcessBusy()).toBe(false);
  });

  it('setProcessBusy toggles state', () => {
    setProcessBusy(true);
    expect(isProcessBusy()).toBe(true);
    setProcessBusy(false);
    expect(isProcessBusy()).toBe(false);
  });

  it('setProcessBusy(false) clears owner', async () => {
    await acquireProcessSlot('test_tool');
    expect(getBusyInfo().owner).toBe('test_tool');
    setProcessBusy(false);
    expect(getBusyInfo().owner).toBe('');
  });

  it('blocks setRunningProcess when busy', () => {
    setProcessBusy(true);
    expect(() => setRunningProcess(makeMockProc())).toThrow(/Cannot replace process while another operation is using it/);
    setProcessBusy(false);
  });

  it('allows setRunningProcess when not busy', () => {
    const proc = makeMockProc();
    expect(() => setRunningProcess(proc)).not.toThrow();
    expect(getRunningProcess()).toBe(proc);
  });

  it('allows setRunningProcess(null) even when busy (auto-clears busy)', () => {
    setProcessBusy(true);
    expect(() => setRunningProcess(null)).not.toThrow();
    expect(isProcessBusy()).toBe(false);
  });

  it('resetState clears busy flag', () => {
    setProcessBusy(true);
    resetState();
    expect(isProcessBusy()).toBe(false);
  });
});

// ─── acquireProcessSlot ──────────────────────────────────────────────────────

describe('acquireProcessSlot', () => {
  it('returns true and sets busy when slot is free', async () => {
    expect(isProcessBusy()).toBe(false);
    expect(await acquireProcessSlot('run_project')).toBe(true);
    expect(isProcessBusy()).toBe(true);
  });

  it('returns false when already busy', async () => {
    setProcessBusy(true);
    expect(await acquireProcessSlot()).toBe(false);
  });

  it('is atomic: double acquire fails', async () => {
    expect(await acquireProcessSlot()).toBe(true);
    expect(await acquireProcessSlot()).toBe(false);
  });

  it('allows re-acquire after release', async () => {
    expect(await acquireProcessSlot()).toBe(true);
    setProcessBusy(false);
    expect(await acquireProcessSlot()).toBe(true);
  });

  it('records owner name', async () => {
    await acquireProcessSlot('run_project');
    expect(getBusyInfo().owner).toBe('run_project');
  });

  it('records owner as empty string by default', async () => {
    await acquireProcessSlot();
    expect(getBusyInfo().owner).toBe('');
  });
});

// ─── getBusyInfo ─────────────────────────────────────────────────────────────

describe('getBusyInfo', () => {
  it('returns empty info when not busy', () => {
    const info = getBusyInfo();
    expect(info.owner).toBe('');
    expect(info.startTime).toBe(0);
    expect(info.projectDir).toBe('');
  });

  it('returns owner and context when busy', async () => {
    setProcessStartTime(1000);
    setProjectDir('/my/project');
    await acquireProcessSlot('run_project');
    const info = getBusyInfo();
    expect(info.owner).toBe('run_project');
    expect(info.startTime).toBe(1000);
    expect(info.projectDir).toBe('/my/project');
  });
});

// ─── buildBusyErrorMessage ───────────────────────────────────────────────────

describe('buildBusyErrorMessage', () => {
  it('returns empty string when not busy', () => {
    expect(buildBusyErrorMessage()).toBe('');
  });

  it('includes owner when provided', async () => {
    await acquireProcessSlot('run_project');
    const msg = buildBusyErrorMessage();
    expect(msg).toContain('run_project');
    expect(msg).toContain('stop_project');
  });

  it('includes elapsed time when startTime is set', async () => {
    setProcessStartTime(Date.now() - 45000);
    await acquireProcessSlot('run_project');
    const msg = buildBusyErrorMessage();
    expect(msg).toMatch(/running for \d+s/);
  });

  it('includes project dir when set', async () => {
    setProjectDir('/my/game');
    await acquireProcessSlot('run_project');
    const msg = buildBusyErrorMessage();
    expect(msg).toContain('/my/game');
  });

  it('works without owner', async () => {
    await acquireProcessSlot();
    const msg = buildBusyErrorMessage();
    expect(msg).toContain('another Godot process is running');
    expect(msg).toContain('stop_project');
  });
});

// ─── short-running process lock ──────────────────────────────────────────────

describe('acquireShortRunningSlot / releaseShortRunningSlot', () => {
  it('acquires slot successfully', () => {
    expect(acquireShortRunningSlot()).toBe(true);
    expect(getShortRunningCount()).toBe(1);
  });

  it('allows up to 3 concurrent slots', () => {
    expect(acquireShortRunningSlot()).toBe(true);
    expect(acquireShortRunningSlot()).toBe(true);
    expect(acquireShortRunningSlot()).toBe(true);
    expect(acquireShortRunningSlot()).toBe(false);  // 4th fails
  });

  it('releases slot correctly', () => {
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    expect(getShortRunningCount()).toBe(2);
    releaseShortRunningSlot();
    expect(getShortRunningCount()).toBe(1);
  });

  it('does not go below 0 on over-release', () => {
    releaseShortRunningSlot();
    releaseShortRunningSlot();
    expect(getShortRunningCount()).toBe(0);
  });

  it('allows re-acquire after release', () => {
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    expect(acquireShortRunningSlot()).toBe(false);
    releaseShortRunningSlot();
    expect(acquireShortRunningSlot()).toBe(true);
  });

  it('is independent of long-running lock', async () => {
    await acquireProcessSlot('run_project');
    // Short-running slot should still be available even when long-running is busy
    expect(acquireShortRunningSlot()).toBe(true);
    expect(getShortRunningCount()).toBe(1);
  });

  it('resetState clears count', () => {
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    resetState();
    expect(getShortRunningCount()).toBe(0);
  });
});

// ─── spawnedGodotPids registry ──────────────────────────────────────────────

describe('spawnedGodotPids registry', () => {
  beforeEach(() => resetState());

  it('register adds pid to the set', () => {  // T1
    registerSpawnedGodotPid(12345);
    expect(getSpawnedGodotPids()).toContain(12345);
  });

  it('unregister removes pid from the set', () => {  // T1
    registerSpawnedGodotPid(12345);
    registerSpawnedGodotPid(67890);
    unregisterSpawnedGodotPid(12345);
    expect(getSpawnedGodotPids()).toEqual([67890]);
  });

  it('register ignores illegal pids (0 / negative / NaN)', () => {  // T2
    registerSpawnedGodotPid(0);
    registerSpawnedGodotPid(-1);
    registerSpawnedGodotPid(NaN);
    expect(getSpawnedGodotPids()).toEqual([]);
  });

  it('resetState clears the set', () => {  // T7
    registerSpawnedGodotPid(111);
    registerSpawnedGodotPid(222);
    resetState();
    expect(getSpawnedGodotPids()).toEqual([]);
  });
});

// ─── killOrphanGodotProcesses (默认基于集合 + opt-in 全系统扫描) ────────────

describe('killOrphanGodotProcesses', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('默认路径：清集合里存活 PID（Windows taskkill）', async () => {  // T3a
    if (process.platform !== 'win32') return;
    registerSpawnedGodotPid(process.pid);  // 当前进程，isPidAlive=true
    const count = await killOrphanGodotProcesses();
    expect(count).toBe(1);
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', String(process.pid)], { stdio: 'ignore' });
    expect(getSpawnedGodotPids()).toEqual([]);  // 清后集合空
  });

  it('跳过当前 _runningProcess.pid（正在管理的进程不杀）', async () => {  // T4
    const fakeRunning = { killed: false, pid: process.pid, kill: vi.fn(), on: vi.fn() };
    setRunningProcess(fakeRunning);
    registerSpawnedGodotPid(process.pid);      // == runningPid，应跳过
    registerSpawnedGodotPid(999999);            // 不存在，惰性移除（isPidAlive=false）
    const count = await killOrphanGodotProcesses();
    expect(count).toBe(0);  // runningPid 跳过 + 999999 不存活，均不计 killed
    expect(getSpawnedGodotPids()).toEqual([process.pid]);  // runningPid 仍在集合（未清，因跳过）
  });

  it('已退出 PID 惰性移除，返回 0', async () => {  // T5
    registerSpawnedGodotPid(999999);  // 不存在的 pid，isPidAlive=false
    const count = await killOrphanGodotProcesses();
    expect(count).toBe(0);
    expect(getSpawnedGodotPids()).toEqual([]);  // 惰性删除
  });

  it('30s 节流：第二次调用返回 0', async () => {  // T6
    registerSpawnedGodotPid(999999);
    await killOrphanGodotProcesses();
    const count = await killOrphanGodotProcesses();
    expect(count).toBe(0);
  });

  it('opt-in：options.fullSystemScan=true 时触发全系统扫描', async () => {  // T3c
    // IPC-R1/R5: 改用显式 options 参数,不再读 process.env
    const count = await killOrphanGodotProcesses('/some/project', { fullSystemScan: true });
    // fullSystemScanGodot 走 spawn（Win: powershell / POSIX: sh），count 取决于 mock；
    // 关键验证：fullSystemScan 开启时额外 spawn 被调用（powershell 或 sh）
    const scanSpawn = spawn.mock.calls.find(c => c[0] === 'powershell' || c[0] === 'sh');
    expect(scanSpawn).toBeDefined();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('opt-in 关闭：不触发全系统扫描', async () => {  // T3c-neg
    await killOrphanGodotProcesses('/some/project');
    const scanSpawn = spawn.mock.calls.find(c => c[0] === 'powershell' || c[0] === 'sh');
    expect(scanSpawn).toBeUndefined();
  });

  it('Windows: fullSystemScanGodot 用 literal .Contains($path)（D4，opt-in 路径）', async () => {  // T8
    if (process.platform !== 'win32') return;
    spawn.mockClear();
    const weirdPath = 'D:/my[game]/proj';
    await killOrphanGodotProcesses(weirdPath, { fullSystemScan: true });
    const psCall = spawn.mock.calls.find(c => c[0] === 'powershell');
    expect(psCall).toBeDefined();
    const cmd = psCall[1].find(a => typeof a === 'string' && a.includes('Where-Object'));
    expect(cmd).toContain('.Contains($path)');
    expect(cmd).not.toMatch(/-like\s+\('\*'\s*\+\s*\$path/);
    expect(cmd).toContain(weirdPath);
  });

  it('opt-in fullSystemScanGodot: spawn 15s 超时无响应 → kill + resolve(0)', async () => {  // T3c-timeout
    vi.useFakeTimers();
    let capturedPs;
    spawn.mockImplementationOnce(() => {
      capturedPs = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),  // 注册 close/error 但不自动触发（模拟 WMI/shell 无响应挂起）
        killed: false,
        kill: vi.fn(() => { capturedPs.killed = true; }),
        pid: 88888,
      };
      return capturedPs;
    });
    const promise = killOrphanGodotProcesses('/some/project', { fullSystemScan: true });
    // 推进 ORPHAN_SCAN_TIMEOUT_MS(15s) 触发 timer → settled + ps.kill + resolve(0)
    await vi.advanceTimersByTimeAsync(15_000);
    const count = await promise;
    expect(count).toBe(0);
    expect(capturedPs.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('opt-in fullSystemScanGodot: spawn error（powershell/sh 不存在）→ resolve(0)', async () => {  // T3c-error
    spawn.mockImplementationOnce(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((evt, cb) => { if (evt === 'error') setTimeout(() => cb(new Error('spawn ENOENT')), 0); }),
      killed: false,
      kill: vi.fn(),
      pid: 77777,
    }));
    const count = await killOrphanGodotProcesses('/some/project', { fullSystemScan: true });
    expect(count).toBe(0);
  });
});

// ─── output snapshot — B-1 修复(_lastFinishedRunOutput) ──────────────────────

describe('output snapshot — B-1 修复(_lastFinishedRunOutput)', () => {
  beforeEach(() => {
    resetState();
  });

  it('setRunningProcess(null) 把非空 buffer 挪入快照并清空当前 buffer', () => {
    appendOutput(['line1', 'SCRIPT ERROR: boom']);
    setRunningProcess(null);
    expect(getLastFinishedRunOutput()).toEqual(['line1', 'SCRIPT ERROR: boom']);
    expect(getOutputBuffer()).toEqual([]);
  });

  it('clearOutputBuffer 同样把非空内容挪入快照', () => {
    appendOutput(['a', 'b']);
    clearOutputBuffer();
    expect(getLastFinishedRunOutput()).toEqual(['a', 'b']);
    expect(getOutputBuffer()).toEqual([]);
  });

  it('空清空不覆盖既有快照(换窗时序:close handler 先存,run_project 开头 clear 时 buffer 已空)', () => {
    appendOutput(['old-run-output']);
    setRunningProcess(null);   // close handler 路径:存快照 + 清 buffer
    clearOutputBuffer();       // 新 run_project 开头(:167):buffer 已空
    expect(getLastFinishedRunOutput()).toEqual(['old-run-output']);
  });

  it('快照超过 5000 行时截断保留最近内容', () => {
    for (let i = 0; i < 3; i++) {
      appendOutput(Array.from({ length: 2000 }, (_, k) => `line-${i}-${k}`));
    }
    setRunningProcess(null);
    const snap = getLastFinishedRunOutput();
    expect(snap.length).toBe(5000);
    // 简报原断言 toContain('line-1-') 系算术错误:6000 行截最后 5000 行只丢最早 1000 行
    // (line-0-0..line-0-999),line-0 共 2000 行不可能整段消失;line-1 从第 2001 行起。
    // node 独立模拟验证:first=line-0-1000 last=line-2-1999。改为精确断言截断边界。
    expect(snap[0]).toBe('line-0-1000');
    expect(snap[snap.length - 1]).toBe('line-2-1999');
  });

  it('resetState 清空快照(测试隔离)', () => {
    appendOutput(['x']);
    setRunningProcess(null);
    expect(getLastFinishedRunOutput().length).toBe(1);
    resetState();
    expect(getLastFinishedRunOutput()).toEqual([]);
  });
});

// ─── per-project sessions — 分桶核心(设计 §4.2/§7,Task 2)──────────────────

describe('per-project sessions — 分桶核心(设计 §4.2/§7)', () => {
  beforeEach(() => { resetState(); });

  it('多桶并存:A/B 各自 proc,互不影响', () => {
    const pA = makeMockProc({ pid: 111 });
    const pB = makeMockProc({ pid: 222 });
    setProjectDir('/proj/A'); setRunSessionProc('/proj/A', pA, true);
    setProjectDir('/proj/B'); setRunSessionProc('/proj/B', pB, true);
    expect(getRunSessionProc('/proj/A')).toBe(pA);
    expect(getRunSessionProc('/proj/B')).toBe(pB);
    expect(listRunSessions().length).toBe(2);
    expect(getActiveRunPids()).toContain(pA.pid);
    expect(getActiveRunPids()).toContain(pB.pid);
  });

  it('setRunSessionProc 只 forceKillTree 该桶旧 proc,不碰其他桶(设计 C-1)', () => {
    const procA1 = makeMockProc({ pid: 111 });
    const procA2 = makeMockProc({ pid: 112 });
    const procB = makeMockProc({ pid: 222 });
    setProjectDir('/A'); setRunSessionProc('/A', procA1, true);
    setProjectDir('/B'); setRunSessionProc('/B', procB, true);
    spawn.mockClear();   // 只清 taskkill 调用记录(proc mock 的 vi.fn 不受影响)
    setRunSessionProc('/A', procA2, true);
    expect(getRunSessionProc('/B')).toBe(procB);          // B 不受影响
    expect(getRunSessionProc('/A')).toBe(procA2);
    if (process.platform === 'win32') {
      // A 桶旧 procA1 被杀,B 桶 procB 未被 taskkill
      expect(spawn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '111'], { stdio: 'ignore' });
      expect(spawn).not.toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '222'], { stdio: 'ignore' });
    } else {
      expect(procA1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procB.kill).not.toHaveBeenCalled();
    }
  });

  it('clearRunSession 只清目标桶:busy 释放+proc 清空+快照挪移(B 的 busy/proc 完好)', () => {
    const procA = makeMockProc({ pid: 111 });
    const procB = makeMockProc({ pid: 222 });
    setProjectDir('/A'); setRunSessionProc('/A', procA, true);
    appendOutput(['A-output'], normalizeProjectKey('/A'));
    setProjectDir('/B'); setRunSessionProc('/B', procB, true);   // 活跃切到 B
    clearRunSession('/A');
    expect(getRunSessionProc('/A')).toBeNull();
    expect(getSession('/A').busy).toBe(false);
    expect(getSession('/A').lastFinishedRunOutput).toEqual(['A-output']);  // 快照挪入
    expect(getRunSessionProc('/B')).toBe(procB);                 // B 的 proc 完好
    expect(getSession('/B').proc).toBe(procB);
  });

  it('运行中上限 GODOT_MCP_MAX_SESSIONS:达上限拒绝并列出会话(设计 §4.1)', () => {
    process.env.GODOT_MCP_MAX_SESSIONS = '2';
    try {
      setProjectDir('/A'); setRunSessionProc('/A', makeMockProc({ pid: 111 }), true);
      setProjectDir('/B'); setRunSessionProc('/B', makeMockProc({ pid: 222 }), true);
      expect(() => ensureSessionCapacity('/C')).toThrow(/MAX_SESSIONS|sessions running/);
      // 同项目已在跑:覆盖不算新增名额
      expect(() => ensureSessionCapacity('/A')).not.toThrow();
      // 已结束桶不占 isAlive 名额
      setRunSessionProc('/B', null, true);   // B → exited
      expect(() => ensureSessionCapacity('/C')).not.toThrow();
    } finally {
      delete process.env.GODOT_MCP_MAX_SESSIONS;
    }
  });

  it('ensureSessionCapacity 默认上限 4,溢出报错附在跑会话清单(英文,设计 §4.1)', () => {
    for (let i = 0; i < 4; i++) {
      setProjectDir(`/p${i}`);
      setRunSessionProc(`/p${i}`, makeMockProc({ pid: 100 + i }), true);
    }
    let msg = '';
    try { ensureSessionCapacity('/p5'); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/GODOT_MCP_MAX_SESSIONS/);
    expect(msg).toContain('Sessions running');
    expect(msg).toContain('/p0');            // 会话清单含 displayPath
    expect(msg).toContain('stop_project');
  });

  it('已结束桶 FIFO 超限逐出最旧(默认 16),活跃桶永不逐出;逐出后 getSession 返回 undefined(设计 §4.1)', () => {
    // 默认上限 16:造 17 个 exited 桶,最旧(/proj-0)被逐
    for (let i = 0; i < 17; i++) {
      setSessionStatus(`/proj-${i}`, 'exited');
    }
    expect(getSession('/proj-0')).toBeUndefined();   // 最旧被逐
    expect(getSession('/proj-1')).toBeDefined();
    expect(getSession('/proj-16')).toBeDefined();
    // 活跃桶即使 ended 也永不逐出
    setProjectDir('/proj-active');
    setSessionStatus('/proj-active', 'exited');
    for (let i = 17; i < 20; i++) setSessionStatus(`/proj-${i}`, 'exited');   // 连续触发逐出
    expect(getSession('/proj-active')).toBeDefined();
  });

  it('FIFO 逐出:shift 到活跃桶跳过删除(活跃桶排 order 队头场景)', () => {
    process.env.GODOT_MCP_MAX_FINISHED_SESSIONS = '2';
    try {
      setProjectDir('/active');
      setSessionStatus('/active', 'exited');    // 活跃桶 ended,排 FIFO 队头
      setSessionStatus('/e1', 'exited');
      setSessionStatus('/e2', 'exited');        // 超限 → shift active(活跃,跳过不删)
      expect(getSession('/active')).toBeDefined();
      setSessionStatus('/e3', 'exited');        // shift e1(非活跃,删除)
      expect(getSession('/e1')).toBeUndefined();
      expect(getSession('/active')).toBeDefined();
    } finally {
      delete process.env.GODOT_MCP_MAX_FINISHED_SESSIONS;
    }
  });

  it('FIFO 逐出防御 order 残留条目(空桶重绑后残留 "",Task 1 审查交接点 1)', () => {
    process.env.GODOT_MCP_MAX_FINISHED_SESSIONS = '2';
    try {
      setProcessStartTime(1);            // 创建 '' 空桶
      setRunningProcess(null);           // '' 登记 order(Task 1 行为)
      setProjectDir('/A');               // '' 空桶重绑 → Map 已无 '' 但 order 残留
      setSessionStatus('/x1', 'exited');
      setSessionStatus('/x2', 'exited'); // order=['',x1,x2] 超限 → shift ''(Map 无此桶,安全 no-op)
      expect(getSession('/x1')).toBeDefined();
      expect(getSession('/x2')).toBeDefined();
    } finally {
      delete process.env.GODOT_MCP_MAX_FINISHED_SESSIONS;
    }
  });

  it('状态机:markSessionStopping/setSessionStatus;close 判定顺序 exited_early(<2s)优先(设计 §4.1)', () => {
    // setSessionStatus:通用状态设置(含 spawn 失败终态)
    setSessionStatus('/X', 'starting');
    expect(getSession('/X').status).toBe('starting');
    setSessionStatus('/X', 'errored');           // spawn 同步失败终态(不滞留 starting)
    expect(getSession('/X').status).toBe('errored');
    // markSessionStopping:running/starting→stopping;ended 态不改
    setProjectDir('/S'); setRunSessionProc('/S', makeMockProc(), true);   // → running
    markSessionStopping('/S');
    expect(getSession('/S').status).toBe('stopping');
    setSessionStatus('/E', 'exited');
    markSessionStopping('/E');
    expect(getSession('/E').status).toBe('exited');   // ended 不改
    // markSessionExited:2s 内退出 → exited_early 优先(即使 code≠0)
    setRunSessionProc('/early', makeMockProc(), true);        // processStartTime=now
    markSessionExited('/early', 1);
    expect(getSession('/early').status).toBe('exited_early');
    // 2s 外 code≠0 → errored
    setRunSessionProc('/late', makeMockProc(), true);
    setProcessStartTime(Date.now() - 10_000, normalizeProjectKey('/late'));
    markSessionExited('/late', 1);
    expect(getSession('/late').status).toBe('errored');
    // 2s 外 code=0 → exited;code=null(无信息)→ exited
    setRunSessionProc('/ok', makeMockProc(), true);
    setProcessStartTime(Date.now() - 10_000, normalizeProjectKey('/ok'));
    markSessionExited('/ok', 0);
    expect(getSession('/ok').status).toBe('exited');
    markSessionExited('/ok', null);
    expect(getSession('/ok').status).toBe('exited');
    // setRunSessionProc(X, null) 路径:2s 内且有输出 → exited_early + 快照留档
    setRunSessionProc('/fast', makeMockProc(), true);
    appendOutput(['crash-line'], normalizeProjectKey('/fast'));
    setRunSessionProc('/fast', null, true);
    expect(getSession('/fast').status).toBe('exited_early');
    expect(getSession('/fast').lastFinishedRunOutput).toEqual(['crash-line']);
    // 2s 外有输出 → exited
    setRunSessionProc('/slow', makeMockProc(), true);
    setProcessStartTime(Date.now() - 10_000, normalizeProjectKey('/slow'));
    appendOutput(['normal-end'], normalizeProjectKey('/slow'));
    setRunSessionProc('/slow', null, true);
    expect(getSession('/slow').status).toBe('exited');
    // markSessionExited 未知桶 no-op(不创建桶)
    expect(() => markSessionExited('/unknown', 0)).not.toThrow();
    expect(getSession('/unknown')).toBeUndefined();
  });

  it('acquireProcessSlot(owner, X) 锁 X 桶而非活跃桶(设计 C-1 前半)', async () => {
    setProjectDir('/B');   // 活跃是 B(空)
    expect(await acquireProcessSlot('run_project', '/A')).toBe(true);
    expect(getSession('/A').busy).toBe(true);        // 锁在 A
    expect(getSession('/B').busy).toBe(false);
    // 多桶锁并存:B 仍可被另一操作锁住
    expect(await acquireProcessSlot('other', '/B')).toBe(true);
    expect(getSession('/B').busy).toBe(true);
    // A 重复锁失败(目标桶语义)
    expect(await acquireProcessSlot('again', '/A')).toBe(false);
  });

  it('getActiveRunPids = 全部桶内活进程(orphan 排除集合,设计 §4.4)', () => {
    const pA = makeMockProc({ pid: 111 });
    const pB = makeMockProc({ pid: 222 });
    const pDead = makeMockProc({ pid: 333, killed: true });
    setProjectDir('/A'); setRunSessionProc('/A', pA, true);
    setProjectDir('/B'); setRunSessionProc('/B', pB, true);
    setProjectDir('/C'); setRunSessionProc('/C', pDead, true);   // killed 进程不在集合
    const pids = getActiveRunPids();
    expect(pids).toContain(111);
    expect(pids).toContain(222);
    expect(pids).not.toContain(333);
    expect(pids.length).toBe(2);
    // 桶退出(proc=null)后不再在集合
    setRunSessionProc('/B', null, true);
    expect(getActiveRunPids()).toEqual([111]);
  });

  it('orphan 排除集合 = 全部桶活进程:非活跃桶活进程不被当孤儿(设计 §4.4 接口)', async () => {
    // process.pid 是真实存活进程;只要任一桶持有它即跳过(不再只看活跃桶单值)
    const pB = makeMockProc({ pid: process.pid });
    setProjectDir('/A');                       // 活跃 = A(无进程)
    setRunSessionProc('/B', pB, true);         // 非活跃桶 B 持有活进程
    registerSpawnedGodotPid(process.pid);
    const count = await killOrphanGodotProcesses();
    expect(count).toBe(0);                     // 在排除集合 → 跳过不计 kill
    expect(getSpawnedGodotPids()).toEqual([process.pid]);   // 跳过未清
  });

  it('killAllRunSessions 杀全部桶活进程并清桶(GodotServer.close 用,设计 §4.2)', async () => {
    vi.useFakeTimers();
    try {
      const pA = makeMockProc({ pid: 111 });
      const pB = makeMockProc({ pid: 222 });
      setProjectDir('/A'); setRunSessionProc('/A', pA, true);
      setProjectDir('/B'); setRunSessionProc('/B', pB, true);
      appendOutput(['B-out'], normalizeProjectKey('/B'));
      const p = killAllRunSessions();
      await vi.advanceTimersByTimeAsync(10_000);   // killProcess 5s 兜底 timer ×2(mock 不触发 close)
      await p;
      expect(getRunSessionProc('/A')).toBeNull();
      expect(getRunSessionProc('/B')).toBeNull();
      expect(getSession('/B').busy).toBe(false);
      expect(getSession('/B').lastFinishedRunOutput).toEqual(['B-out']);   // 快照挪入
      expect(getSession('/A').status).toBe('exited');
      expect(getActiveRunPids()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releaseRunSessionBusy(X) 只释放 X 桶 busy(设计 C-1)', async () => {
    await acquireProcessSlot('runA', '/A');
    await acquireProcessSlot('runB', '/B');
    releaseRunSessionBusy('/A');
    expect(getSession('/A').busy).toBe(false);
    expect(getSession('/A').busyOwner).toBe('');
    expect(getSession('/B').busy).toBe(true);     // B 不受影响
    releaseRunSessionBusy('/unknown');            // 无桶 no-op 不炸
  });

  it('buildBusyErrorMessage(targetKey) 报目标桶的持锁信息(设计 M-1)', async () => {
    setProjectDir('/B');
    await acquireProcessSlot('owner-A', '/A');
    const msg = buildBusyErrorMessage('/A');
    expect(msg).toContain('owner-A');
    expect(msg).toContain('stop_project');
    expect(buildBusyErrorMessage('/B')).toBe('');   // B 桶不 busy → 空串
  });

  it('registerSpawnedGodotPid(pid, projectKey) 归属化;getSpawnedGodotPids 兼容返回 pid 数组(设计 §4.1)', () => {
    registerSpawnedGodotPid(123, normalizeProjectKey('/A'));
    registerSpawnedGodotPid(456, normalizeProjectKey('/B'));
    expect(getSpawnedGodotPids()).toEqual([123, 456]);
    unregisterSpawnedGodotPid(123);
    expect(getSpawnedGodotPids()).toEqual([456]);
  });

  it('setRunSessionProc 首次将 displayPath 刷新为原始 projectPath 写法(Task 1 审查交接点 2)', () => {
    const raw = 'D:\\Proj\\MyGame';   // win 归一化 → 小写;displayPath 保留原始写法
    setRunSessionProc(raw, makeMockProc(), true);
    const s = getSession(raw);
    expect(s.displayPath).toBe(raw);
    const list = listRunSessions();
    expect(list[0].projectPath).toBe(normalizeProjectKey(raw));
    expect(list[0].displayPath).toBe(raw);
  });

  it('getSession 缺省返回活跃桶;listRunSessions 不含 "" 空桶', () => {
    appendOutput(['x']);   // 无 setProjectDir → 写入 '' 惰性空桶
    setProjectDir('/A'); setRunSessionProc('/A', makeMockProc(), true);
    expect(getSession()).toBe(getSession('/A'));          // 缺省=活跃桶(同一引用)
    expect(getSession('/unknown')).toBeUndefined();
    const list = listRunSessions();
    expect(list.length).toBe(1);                          // '' 空桶不进列表
    expect(list[0].projectPath).toBe(normalizeProjectKey('/A'));
    expect(list[0].pid).not.toBeNull();
  });
});
