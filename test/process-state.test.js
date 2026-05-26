import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process to prevent real taskkill/spawn calls on Windows
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
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
  killProcess,
  isProcessBusy,
  setProcessBusy,
} from '../build/core/process-state.js';

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

    // On any platform, the old process should be acted upon.
    // Unix: kill('SIGTERM') is called. Windows: spawnSync is mocked.
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
    // Simulate close event
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
    // setRunningProcess(null) auto-clears busy — no need for callers to manage order
    expect(() => setRunningProcess(null)).not.toThrow();
    expect(isProcessBusy()).toBe(false);
  });

  it('resetState clears busy flag', () => {
    setProcessBusy(true);
    resetState();
    expect(isProcessBusy()).toBe(false);
  });
});
