import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripEnvelope } from '../src/core/untrusted-wrap.js';
import { EventEmitter } from 'events';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockProc = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.killed = false;
  proc.unref = vi.fn();
  proc.pid = 54321;
  return proc;
};

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../src/core/process-state.js', () => ({
  appendOutput: vi.fn(),
  clearOutputBuffer: vi.fn(),
  getLastFinishedRunOutput: vi.fn(() => []),
  killProcess: vi.fn(async () => {}),
  forceKillTree: vi.fn(),
  setProcessBusy: vi.fn(),
  acquireProcessSlot: vi.fn(async () => true),
  acquireShortRunningSlot: vi.fn(() => true),
  releaseShortRunningSlot: vi.fn(),
  buildBusyErrorMessage: vi.fn(() => 'Busy'),
  killOrphanGodotProcesses: vi.fn(async () => 0),
  registerSpawnedGodotPid: vi.fn(),
  unregisterSpawnedGodotPid: vi.fn(),
}));

vi.mock('../src/helpers.js', () => ({
  validatePath: vi.fn(p => p),
  requireProjectPath: vi.fn(args => typeof args === 'string' ? args : args.project_path),
  buildSafeEnv: vi.fn(() => process.env),
  checkVersionMismatch: vi.fn(async () => null),
}));

vi.mock('../src/core/godot-finder.js', () => ({
  detectGodotVersion: vi.fn(async () => '4.6.stable'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    join: vi.fn((...args) => args.join('/')),
  };
});

vi.mock('../src/tools/game-bridge.js', () => ({
  isBridgeReady: vi.fn(),
  setBridgeProjectDir: vi.fn(),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/runtime.js';
import { spawn } from 'child_process';
import { killProcess, clearOutputBuffer, setProcessBusy, registerSpawnedGodotPid, unregisterSpawnedGodotPid, killOrphanGodotProcesses, getLastFinishedRunOutput } from '../src/core/process-state.js';
import { isBridgeReady } from '../src/tools/game-bridge.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(function (p) { this.runningProcess = p; }),
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

  it('has 1 merged tool definition with name "runtime"', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('runtime');
  });

  it('tool has action enum with all operations', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toEqual([
      'launch_editor',
      'run_project',
      'stop_project',
      'get_debug_output',
      'run_tests',
      'get_godot_version',
      'record_start',
      'record_stop',
      'record_save',
      'record_load',
      'record_play',
    ]);
  });

  it('definition has name, description, and inputSchema', () => {
    const defs = getToolDefinitions();
    const def = defs[0];
    expect(def.name).toBeTruthy();
    expect(def.description).toBeTruthy();
    expect(def.inputSchema).toBeDefined();
    expect(def.inputSchema.type).toBe('object');
  });

  it('T-3: recording_save file_name schema 描述准确(说明自动命名/入参忽略)', () => {
    // 原描述"录制文件名"误导用户可指定,实际行为忽略入参、始终自动时间戳命名。
    const desc = getToolDefinitions()[0].inputSchema.properties.file_name.description;
    expect(desc).toMatch(/自动命名|入参被忽略/);
    expect(desc).toMatch(/recording_\*\.json/);  // 保留格式约束说明
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('runtime TOOL_META', () => {
  it('has single entry for "runtime"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.runtime).toBeDefined();
  });

  it('marks runtime as long_running', () => {
    expect(TOOL_META.runtime.long_running).toBe(true);
  });

  it('marks runtime as not readonly', () => {
    expect(TOOL_META.runtime.readonly).toBe(false);
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
    const result = await handleTool('runtime', {
      action: 'launch_editor',
      project_path: '/fake/project',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Launched Godot editor');
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('--editor');
    expect(spawnArgs[1]).toContain('--path');
  });

  // F5 防回归（07-22 P1 修复）: launch_editor spawn 的 detached editor 不注册 PID。
  // 契约：runtime.ts:128 spawn({detached:true, stdio:'ignore'}) + :132 child.unref()
  // 不调 registerSpawnedGodotPid（仅 run_project:224 调）。
  // 回归场景：若有人误在 launch_editor 加 registerSpawnedGodotPid(child.pid)，
  // stop_project 的 killOrphanGodotProcesses 会按 PID 集合清掉其他会话的编辑器
  // （参考 [[godot-mcp-multi-session-process-ownership]]）。
  it('launch_editor detached 不注册 PID（多会话契约：防 killOrphanGodotProcesses 误杀其他会话编辑器）', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();

    await handleTool('runtime', {
      action: 'launch_editor',
      project_path: '/fake/project',
    }, ctx);

    // 核心契约：detached editor 不进 _spawnedGodotPids 集合
    expect(registerSpawnedGodotPid).not.toHaveBeenCalled();

    // 双重锁定 detached 语义（future-proof：若有人改 detached:false 也会 RED）
    const spawnArgs = spawn.mock.calls[0];
    const spawnOptions = spawnArgs[2];
    expect(spawnOptions.detached).toBe(true);
    expect(spawnOptions.stdio).toBe('ignore');
    expect(proc.unref).toHaveBeenCalled();
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
    const result = await handleTool('runtime', {
      action: 'run_project',
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
    await handleTool('runtime', {
      action: 'run_project',
      project_path: '/fake/project',
    }, ctx);

    expect(killProcess).toHaveBeenCalledWith(existingProc);
  });

  it('clears output buffer and sets process start time', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', {
      action: 'run_project',
      project_path: '/fake/project',
    }, ctx);

    expect(clearOutputBuffer).toHaveBeenCalled();
    expect(ctx.setProcessStartTime).toHaveBeenCalled();
    expect(ctx.setProjectDir).toHaveBeenCalledWith('/fake/project');
  });

  // P1.1: spawn() 同步抛异常时,:178 的 'error' handler 尚未注册 → 必须主动释放槽,
  // 否则 :140 acquireProcessSlot 获取的 busy 槽永久泄漏,后续 run_project 永远 busy。
  it('releases process slot when spawn throws synchronously (P1.1)', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('spawn boom'); });
    const ctx = createMockCtx();

    const result = await handleTool('runtime', {
      action: 'run_project',
      project_path: '/fake/project',
    }, ctx);

    // 不应抛出,应返回错误文本
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('failed to spawn');
    // 槽已释放:busy 清零 + runningProcess 置空
    expect(setProcessBusy).toHaveBeenCalledWith(false);
    expect(ctx.setRunningProcess).toHaveBeenCalledWith(null);
  });

  it('registers spawned pid for orphan cleanup', async () => {  // T9
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    expect(registerSpawnedGodotPid).toHaveBeenCalledWith(54321);
  });
});

// ─── handleTool — stop_project ──────────────────────────────────────────────

describe('runtime handleTool — stop_project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns message when no project running', async () => {
    const ctx = createMockCtx({ runningProcess: null });
    const result = await handleTool('runtime', { action: 'stop_project' }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project is currently running');
  });

  it('calls killOrphanGodotProcesses when no running process (orphan cleanup)', async () => {  // T10
    vi.clearAllMocks();
    const ctx = createMockCtx({ runningProcess: null });
    await handleTool('runtime', { action: 'stop_project', project_path: '/p' }, ctx);
    expect(killOrphanGodotProcesses).toHaveBeenCalled();
  });

  it('kills running process and returns classified output', async () => {
    const existingProc = mockProc();
    const ctx = createMockCtx({
      runningProcess: existingProc,
      outputBuffer: ['line with error', 'line with warning', 'normal line'],
    });

    const result = await handleTool('runtime', { action: 'stop_project' }, ctx);

    expect(result).not.toBeNull();
    expect(killProcess).toHaveBeenCalledWith(existingProc);
    expect(ctx.setRunningProcess).toHaveBeenCalledWith(null);

    const parsed = JSON.parse(stripEnvelope(result.content[0].text));
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

    const result = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No debug output available');
  });

  it('returns classified debug output', async () => {
    const proc = mockProc();
    const ctx = createMockCtx({
      runningProcess: proc,
      outputBuffer: ['ERROR: something broke', 'WARNING: deprecated', 'hello world'],
    });

    const result = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(stripEnvelope(result.content[0].text));
    expect(parsed.running).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(result.content[0].text.startsWith('<untrusted-'), 'get_debug_output 输出须信封包裹').toBe(true);
  });

  it('stop_project 输出也带信封(同数据源防护对称,审查 I-2)', async () => {
    const ctx = createMockCtx({
      runningProcess: mockProc(),
      outputBuffer: ['hello from game print'],
    });
    const result = await handleTool('runtime', { action: 'stop_project' }, ctx);
    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text.startsWith('<untrusted-'), 'stop 输出须信封包裹(游戏 print 是注入载体)').toBe(true);
    const parsed = JSON.parse(stripEnvelope(text));
    expect(Array.isArray(parsed.prints)).toBe(true);
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
    const resultPromise = handleTool('runtime', {
      action: 'run_tests',
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
    expect(spawnArgs[1]).toContain('-gquit');  // 默认 gquit(GUT ≤9.5 惯例,行为兼容)
  });

  // A4 (2026-07-04 反馈): GUT 9.6+ 移除 -gquit(报 Unknown arguments: -gquit)
  it('quit_flag=gexit spawns with -gexit (GUT 9.6+)', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const resultPromise = handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      quit_flag: 'gexit',
    }, ctx);

    emitProcessEvents(proc, 'Tests: 5 Passed');

    const result = await resultPromise;
    expect(result).not.toBeNull();
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('-gexit');
    expect(spawnArgs[1]).not.toContain('-gquit');
  });

  it('quit_flag 非法值回落 gquit(白名单兜底)', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const resultPromise = handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      quit_flag: '--evil-flag',
    }, ctx);

    emitProcessEvents(proc, 'Tests: 5 Passed');

    const result = await resultPromise;
    expect(result).not.toBeNull();
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('-gquit');
    expect(spawnArgs[1]).not.toContain('--evil-flag');
  });
});

// ─── handleTool — get_godot_version ─────────────────────────────────────────

describe('runtime handleTool — get_godot_version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Godot version via detectGodotVersion', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('runtime', { action: 'get_godot_version' }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('4.6');
  });
});

// ─── handleTool — run_project wait_for_bridge ─────────────────────────────────────

describe('runtime handleTool — run_project wait_for_bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function resultText(r) { return (r?.content?.[0]?.text) ?? ''; }

  it('run_project 默认不探测 bridge', async () => {
    spawn.mockImplementation(() => mockProc());
    isBridgeReady.mockReset();
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    expect(isBridgeReady).not.toHaveBeenCalled();
  });

  it('run_project wait_for_bridge=true 且就绪 → 文本含 Bridge ready', async () => {
    spawn.mockImplementation(() => mockProc());
    isBridgeReady.mockResolvedValue({ ready: true, reason: 'bridge ready' });
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', wait_for_bridge: true }, ctx);
    expect(isBridgeReady).toHaveBeenCalledWith('/p', expect.any(Number), expect.objectContaining({ isCancelled: expect.any(Function) }));
    expect(resultText(r)).toContain('Bridge ready');
  });

  it('run_project wait_for_bridge 但进程早退 → 文本含 not ready + process exited', async () => {
    spawn.mockImplementation(() => mockProc());
    isBridgeReady.mockResolvedValue({ ready: false, reason: 'process exited during probe' });
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', wait_for_bridge: true, bridge_timeout: 10 }, ctx);
    expect(resultText(r)).toContain('not ready');
    expect(resultText(r)).toContain('process exited');
  });
});

// ─── run_project — Imp-4 process replacement guard (2026-06-24 审查 Q-1) ──────

describe('run_project — Imp-4 process replacement guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Imp-4: 进程被替换后,旧进程 close 不清新进程的 busy/running 状态', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    // 模拟 procA 已被新进程 procB 替换(runningProcess 指向 procB)
    const procB = mockProc();
    ctx.runningProcess = procB;

    setProcessBusy.mockClear();
    ctx.setRunningProcess.mockClear();

    // 旧进程 procA 退出触发 close。守卫 :179 runningProcess(procB) !== procA → 不应误清 procB 状态
    procA.emit('close', 0);

    expect(setProcessBusy).not.toHaveBeenCalled();
    expect(ctx.setRunningProcess).not.toHaveBeenCalled();
    // ADVISORY-3（final review Minor-4）：守卫 false 时 unregister 仍在守卫外执行（runtime.ts:208），移除旧 procA pid。
    // 若将来误把 unregister 移进守卫内，此断言会 RED（procA 被 procB 替换后 unregister 不再触发）。
    expect(unregisterSpawnedGodotPid).toHaveBeenCalledWith(54321);
  });

  it('Imp-4: runningProcess 仍是该进程时,close 正常清 busy/running', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    // runningProcess 仍是 procA(未被替换)
    ctx.runningProcess = procA;

    setProcessBusy.mockClear();
    ctx.setRunningProcess.mockClear();

    procA.emit('close', 0);

    expect(setProcessBusy).toHaveBeenCalledWith(false);
    expect(ctx.setRunningProcess).toHaveBeenCalledWith(null);
  });

  it('Imp-4: error 事件同样守卫(进程已替换不清)', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    const procB = mockProc();
    ctx.runningProcess = procB;

    setProcessBusy.mockClear();
    ctx.setRunningProcess.mockClear();

    procA.emit('error', new Error('spawn failed'));

    expect(setProcessBusy).not.toHaveBeenCalled();
    expect(ctx.setRunningProcess).not.toHaveBeenCalled();
    // ADVISORY-3（final review Minor-4）：error handler 同理，守卫外 unregister 执行（runtime.ts:218）。
    expect(unregisterSpawnedGodotPid).toHaveBeenCalledWith(54321);
  });
});

// ─── run_project preview 模式 + 快照回落(B-1) ───────────────────────────────

function resultText(r) { return (r?.content?.[0]?.text) ?? ''; }

describe('run_project — preview 模式', () => {
  it('preview=true 不设 autoStopTimer:快进超时时间进程不被杀', async () => {
    vi.useFakeTimers();
    try {
      const procA = mockProc();
      setupSpawnMock(procA);
      const ctx = createMockCtx();
      await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 5, preview: true }, ctx);
      ctx.runningProcess = procA;
      killProcess.mockClear();
      vi.advanceTimersByTime(6000);
      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('对照组:非 preview 时 timer 到点杀进程', async () => {
    vi.useFakeTimers();
    try {
      const procA = mockProc();
      setupSpawnMock(procA);
      const ctx = createMockCtx();
      await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 5 }, ctx);
      ctx.runningProcess = procA;
      killProcess.mockClear();
      vi.advanceTimersByTime(6000);
      expect(killProcess).toHaveBeenCalledWith(procA);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preview=true 返回消息含预览语义且不含 timeout 秒数', async () => {
    setupSpawnMock(mockProc());
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 30, preview: true }, ctx);
    const t = resultText(r);
    expect(t).toContain('Preview mode');
    expect(t).toContain('no auto-stop');
    expect(t).not.toContain('timeout: 30s');
  });

  it('preview + wait_for_bridge 成功分支:含 Preview mode 且不含 timeout 秒数', async () => {
    setupSpawnMock(mockProc());
    isBridgeReady.mockResolvedValue({ ready: true, reason: '' });
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', preview: true, wait_for_bridge: true, bridge_timeout: 10 }, ctx);
    const t = resultText(r);
    expect(t).toContain('Preview mode');
    expect(t).not.toContain('timeout: 40s');
    expect(t).toContain('bridge ready');
  });
});

describe('get_debug_output / stop_project — 快照回落(B-1)', () => {
  afterEach(() => {
    getLastFinishedRunOutput.mockReturnValue([]);
  });

  it('buffer 空 + 无运行进程 + 快照非空 → 读快照并标注 last_finished_run', async () => {
    getLastFinishedRunOutput.mockReturnValue(['SCRIPT ERROR: boom']);
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('boom');
    expect(t).toContain('last_finished_run');
  });

  it('buffer 非空 → 优先当前 buffer,不读快照', async () => {
    getLastFinishedRunOutput.mockReturnValue(['OLD-SNAPSHOT-LINE']);
    const ctx = createMockCtx({ outputBuffer: ['CURRENT LINE'] });
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('CURRENT LINE');
    expect(t).not.toContain('OLD-SNAPSHOT-LINE');
  });

  it('stop_project 在进程结束后仍能报出错误(现存 bug 修复)', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx({ runningProcess: procA });
    getLastFinishedRunOutput.mockReturnValue(['SCRIPT ERROR: late-crash']);
    const r = await handleTool('runtime', { action: 'stop_project' }, ctx);
    const t = resultText(r);
    expect(t).toContain('late-crash');
  });

  it('全空仍返回 No debug output', async () => {
    getLastFinishedRunOutput.mockReturnValue([]);
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(resultText(r)).toContain('No debug output available');
  });
});
