import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockProc = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.killed = false;
  proc.unref = vi.fn();
  return proc;
};

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../src/core/process-state.js', () => ({
  appendOutput: vi.fn(),
  clearOutputBuffer: vi.fn(),
  killProcess: vi.fn(async () => {}),
  setProcessBusy: vi.fn(),
}));

vi.mock('../src/helpers.js', () => ({
  validatePath: vi.fn(p => p),
  checkVersionMismatch: vi.fn(async () => null),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/runtime.js';
import { spawn } from 'child_process';
import { killProcess, clearOutputBuffer } from '../src/core/process-state.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: Date.now() - 5000,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(),
    ...overrides,
  };
}

function setupSpawnMock(proc) {
  spawn.mockReturnValue(proc);
}

function emitProcessEvents(proc, stdoutData, exitCode = 0) {
  process.nextTick(() => {
    proc.stdout.emit('data', Buffer.from(stdoutData));
    proc.emit('close', exitCode);
  });
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('runtime getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has 6 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(6);
    const names = defs.map(d => d.name);
    expect(names).toContain('launch_editor');
    expect(names).toContain('run_project');
    expect(names).toContain('stop_project');
    expect(names).toContain('get_debug_output');
    expect(names).toContain('run_tests');
    expect(names).toContain('get_godot_version');
  });

  it('each definition has name, description, and inputSchema', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('runtime TOOL_META', () => {
  it('has entries for all 6 tools', () => {
    expect(Object.keys(TOOL_META).length).toBe(6);
    expect(TOOL_META.launch_editor).toBeDefined();
    expect(TOOL_META.run_project).toBeDefined();
    expect(TOOL_META.stop_project).toBeDefined();
    expect(TOOL_META.get_debug_output).toBeDefined();
    expect(TOOL_META.run_tests).toBeDefined();
    expect(TOOL_META.get_godot_version).toBeDefined();
  });

  it('marks run_tests as long_running', () => {
    expect(TOOL_META.run_tests.long_running).toBe(true);
  });

  it('marks get_debug_output and get_godot_version as readonly', () => {
    expect(TOOL_META.get_debug_output.readonly).toBe(true);
    expect(TOOL_META.get_godot_version.readonly).toBe(true);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('runtime handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — launch_editor ─────────────────────────────────────────────

describe('runtime handleTool — launch_editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches Godot editor via spawn', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const result = await handleTool('launch_editor', {
      project_path: '/fake/project',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Launched Godot editor');
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('--editor');
    expect(spawnArgs[1]).toContain('--path');
  });
});

// ─── handleTool — run_project ───────────────────────────────────────────────

describe('runtime handleTool — run_project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns Godot in debug mode and sets running process', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const result = await handleTool('run_project', {
      project_path: '/fake/project',
      timeout: 30,
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Running project');
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('--debug');
    expect(ctx.setRunningProcess).toHaveBeenCalledTimes(1);
  });

  it('kills existing process before starting new one', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const existingProc = mockProc();
    const ctx = createMockCtx({ runningProcess: existingProc });
    await handleTool('run_project', {
      project_path: '/fake/project',
    }, ctx);

    expect(killProcess).toHaveBeenCalledWith(existingProc);
  });

  it('clears output buffer and sets process start time', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('run_project', {
      project_path: '/fake/project',
    }, ctx);

    expect(clearOutputBuffer).toHaveBeenCalled();
    expect(ctx.setProcessStartTime).toHaveBeenCalled();
    expect(ctx.setProjectDir).toHaveBeenCalledWith('/fake/project');
  });
});

// ─── handleTool — stop_project ──────────────────────────────────────────────

describe('runtime handleTool — stop_project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns message when no project running', async () => {
    const ctx = createMockCtx({ runningProcess: null });
    const result = await handleTool('stop_project', {}, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project is currently running');
  });

  it('kills running process and returns classified output', async () => {
    const existingProc = mockProc();
    const ctx = createMockCtx({
      runningProcess: existingProc,
      outputBuffer: ['line with error', 'line with warning', 'normal line'],
    });

    const result = await handleTool('stop_project', {}, ctx);

    expect(result).not.toBeNull();
    expect(killProcess).toHaveBeenCalledWith(existingProc);
    expect(ctx.setRunningProcess).toHaveBeenCalledWith(null);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('stopped');
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

// ─── handleTool — get_debug_output ──────────────────────────────────────────

describe('runtime handleTool — get_debug_output', () => {
  it('returns message when no output and no running process', async () => {
    const ctx = createMockCtx({
      runningProcess: null,
      outputBuffer: [],
    });

    const result = await handleTool('get_debug_output', {}, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No debug output available');
  });

  it('returns classified debug output', async () => {
    const proc = mockProc();
    const ctx = createMockCtx({
      runningProcess: proc,
      outputBuffer: ['ERROR: something broke', 'WARNING: deprecated', 'hello world'],
    });

    const result = await handleTool('get_debug_output', {}, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.running).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

// ─── handleTool — run_tests ─────────────────────────────────────────────────

describe('runtime handleTool — run_tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns Godot with GUT test runner', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const resultPromise = handleTool('run_tests', {
      project_path: '/fake/project',
    }, ctx);

    emitProcessEvents(proc, 'Tests: 5 Passed');

    const result = await resultPromise;
    expect(result).not.toBeNull();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.exit_code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('--headless');
    expect(spawnArgs[1]).toContain('addons/gut/gut_cmdln.gd');
  });
});

// ─── handleTool — get_godot_version ─────────────────────────────────────────

describe('runtime handleTool — get_godot_version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns Godot with --version flag', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const resultPromise = handleTool('get_godot_version', {}, ctx);

    emitProcessEvents(proc, '4.6.stable');

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('4.6');
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('--version');
  });
});
