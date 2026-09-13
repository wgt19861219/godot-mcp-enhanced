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
