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

// I-4 统一策略(设计 §7):importOriginal 部分覆盖——仅 stub 断言目标/防真实杀进程项,
// 分桶 API(getRunSessionProc/setRunSessionProc/getSession/markSessionExited/...)透传
// 真实模块——**分桶行为靠真实实现验证**(per-project 用例直接断言真实桶状态)。
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    killProcess: vi.fn(async () => {}),          // 断言目标 + 防真实杀进程
    forceKillTree: vi.fn(),                      // 断言目标(C-1 互不杀)
    clearOutputBuffer: vi.fn(),                  // 断言目标('clears output buffer')
    buildBusyErrorMessage: vi.fn(() => 'Busy'),
    killOrphanGodotProcesses: vi.fn(async () => 0),
    registerSpawnedGodotPid: vi.fn(),            // 断言目标(T9 归属化契约)
    unregisterSpawnedGodotPid: vi.fn(),          // 断言目标(ADVISORY-3)
  };
});

// C-1/I-1 行为锁定(设计 §7):DebuggerProfiler.create 可控延迟 resolve,制造
// run_project profiling 路径 `await DebuggerProfiler.create()` 的并发窗口。
const { mockProfilerCreate } = vi.hoisted(() => ({ mockProfilerCreate: vi.fn() }));
vi.mock('../src/core/function-profiler.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DebuggerProfiler: { create: mockProfilerCreate } };
});
const fakeProfiler = () => ({ port: 9555, close: vi.fn() });

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
import {
  killProcess,
  clearOutputBuffer,
  forceKillTree,
  registerSpawnedGodotPid,
  unregisterSpawnedGodotPid,
  killOrphanGodotProcesses,
  // 分桶 API(经 importOriginal 透传,import 拿到的即真实实现——分桶行为靠真实模块验证)
  resetState,
  normalizeProjectKey,
  getRunSessionProc,
  getSession,
  listRunSessions,
} from '../src/core/process-state.js';
import { isBridgeReady } from '../src/tools/game-bridge.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// mock 双基建①(设计 §7):ctx setter 模拟副作用对齐活跃指针语义——setProjectDir
// 更新 this.projectDir(activeProjectKeyOf(ctx) 读它做缺省 targetKey)。
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
    setProjectDir: vi.fn(function (d) { this.projectDir = d; }),
    parseGodotConfig: vi.fn(),
    ...overrides,
  };
}

// 真实 process-state 模块级状态隔离(per-key API 透传真实实现后必须逐用例重置)
beforeEach(() => {
  resetState();
});

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
    // 守卫总纲(设计 §4.3):proc 按 sessionKey 写入桶(C-1:禁用 ctx.setRunningProcess)
    expect(getRunSessionProc('/fake/project')).toBe(proc);
  });

  it('kills existing process before starting new one', async () => {
    // 同项目重跑互杀(单项目语义不变):X 桶有旧进程 → 先杀旧再起新
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);

    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);

    expect(killProcess).toHaveBeenCalledWith(procA);
    expect(getRunSessionProc('/p')).toBe(procB);
  });

  it('clears output buffer and sets process start time', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', {
      action: 'run_project',
      project_path: '/fake/project',
    }, ctx);

    expect(clearOutputBuffer).toHaveBeenCalledWith(normalizeProjectKey('/fake/project'));
    // processStartTime 由 setRunSessionProc 写入桶(设计 §4.3),不再走 ctx
    expect(getSession('/fake/project').processStartTime).toBeGreaterThan(0);
    expect(ctx.setProjectDir).toHaveBeenCalledWith('/fake/project');
  });

  // P1.1: spawn() 同步抛异常时,'error' handler 尚未注册 → 必须主动释放槽,
  // 否则 acquireProcessSlot 获取的 busy 槽永久泄漏,后续 run_project 永远 busy。
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
    // 槽已释放(per-key busy 真实验证)+ 桶终态 errored(proc 未注册不滞留 starting)
    const s = getSession('/fake/project');
    expect(s.busy).toBe(false);
    expect(s.status).toBe('errored');
    expect(s.proc).toBeNull();
    // :219 的 ctx.setRunningProcess(null) 已删除(设计 §4.3 点名)——proc 未注册无需清
    expect(ctx.setRunningProcess).not.toHaveBeenCalled();
  });

  it('registers spawned pid for orphan cleanup', async () => {  // T9
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    // 归属化契约(设计 §4.4):注册时带本次 sessionKey
    expect(registerSpawnedGodotPid).toHaveBeenCalledWith(54321, normalizeProjectKey('/p'));
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
    // 真实桶路径:run 建桶 + appendOutput(真实)写输出 → stop 读桶分类
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/fake/project' }, ctx);
    proc.stdout.emit('data', Buffer.from('line with error\nline with warning\nnormal line\n'));

    const result = await handleTool('runtime', { action: 'stop_project' }, ctx);

    expect(result).not.toBeNull();
    expect(killProcess).toHaveBeenCalledWith(proc);

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
    // 真实桶路径:run 建桶 + appendOutput(真实)写输出 → get_debug_output 读活跃桶
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/fake/project' }, ctx);
    proc.stdout.emit('data', Buffer.from('ERROR: something broke\nWARNING: deprecated\nhello world\n'));

    const result = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(stripEnvelope(result.content[0].text));
    expect(parsed.running).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(result.content[0].text.startsWith('<untrusted-'), 'get_debug_output 输出须信封包裹').toBe(true);
  });

  it('stop_project 输出也带信封(同数据源防护对称,审查 I-2)', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/fake/project' }, ctx);
    proc.stdout.emit('data', Buffer.from('hello from game print\n'));
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

// ─── run_project — 进程替换守卫(2026-06-24 审查 Q-1,per-key 身份校验版)─────

describe('run_project — Imp-4 process replacement guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Imp-4: 进程被替换后,旧进程 close 不清新进程的桶状态', async () => {
    // 同项目重跑:X 桶 procA → procB(Stop existing 杀 procA);procA 的迟到 close
    // 守卫 getRunSessionProc(X) !== procA → 不清 procB 的桶
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    killProcess.mockClear();
    // 旧进程 procA 退出触发 close。守卫 :getRunSessionProc(X)=procB !== procA → 不误清 B 桶
    procA.emit('close', 0);

    expect(getRunSessionProc('/p')).toBe(procB);
    expect(getSession('/p').busy).toBe(true);   // B 的 busy 持锁不被旧 close 清掉
    // ADVISORY-3（final review Minor-4）：守卫 false 时 unregister 仍在守卫外执行，移除旧 procA pid。
    // 若将来误把 unregister 移进守卫内，此断言会 RED（procA 被 procB 替换后 unregister 不再触发）。
    expect(unregisterSpawnedGodotPid).toHaveBeenCalledWith(54321);
  });

  it('Imp-4: 桶内仍是该进程时,close 正常清桶并留快照', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);
    procA.stdout.emit('data', Buffer.from('game-log-line'));

    procA.emit('close', 0);

    const s = getSession('/p');
    expect(s.proc).toBeNull();
    expect(s.busy).toBe(false);
    // 2s 内 close → exited_early(设计 §4.1 状态机);输出挪入快照
    expect(s.status).toBe('exited_early');
    expect(s.lastFinishedRunOutput).toContain('game-log-line');
    expect(s.outputBuffer).toHaveLength(0);
  });

  it('Imp-4: error 事件同样守卫(进程已替换不清),错误行按 sessionKey 写桶', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 0 }, ctx);

    procA.emit('error', new Error('spawn failed'));

    // 守卫:getRunSessionProc(X)=procB !== procA → B 桶不动
    expect(getRunSessionProc('/p')).toBe(procB);
    expect(getSession('/p').status).toBe('running');
    // ADVISORY-3（final review Minor-4）：error handler 同理，守卫外 unregister 执行。
    expect(unregisterSpawnedGodotPid).toHaveBeenCalledWith(54321);
    // 坑 1(:268 error 路径):错误行带 sessionKey 写桶(exited_early/errored 态最需要的输出)
    expect(getSession('/p').outputBuffer.some(l => l.includes('spawn failed'))).toBe(true);
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

describe('get_debug_output / stop_project — 快照回落(B-1,真实桶时序)', () => {
  it('进程结束后(close 已清桶)→ get_debug_output 读快照并标注 last_finished_run', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    procA.stdout.emit('data', Buffer.from('SCRIPT ERROR: boom\n'));
    procA.emit('close', 0);   // 用户关窗/崩溃:close handler stash 输出进快照、清桶

    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('boom');
    expect(t).toContain('last_finished_run');
  });

  it('buffer 非空 → 优先当前 buffer,不读快照', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    procA.stdout.emit('data', Buffer.from('OLD-SNAPSHOT-LINE\n'));
    procA.emit('close', 0);   // 快照 = OLD-SNAPSHOT-LINE
    // 同项目重跑(procB):新桶输出优先于旧快照
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    procB.stdout.emit('data', Buffer.from('CURRENT LINE\n'));

    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('CURRENT LINE');
    expect(t).not.toContain('OLD-SNAPSHOT-LINE');
  });

  it('stop_project 返回被停运行的输出(崩溃错误可报出)', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/p' }, ctx);
    procA.stdout.emit('data', Buffer.from('SCRIPT ERROR: late-crash\n'));

    const r = await handleTool('runtime', { action: 'stop_project' }, ctx);
    const t = resultText(r);
    expect(t).toContain('late-crash');
  });

  it('全空仍返回 No debug output', async () => {
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(resultText(r)).toContain('No debug output available');
  });
});

// ─── run_project — per-project 分桶(设计 §4.3/§7)──────────────────────────

describe('run_project — per-project 分桶(设计 §4.3/§7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('跨项目并存:A run 后 B run,A 仍活且互不杀', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 0 }, ctx);
    const procB = mockProc();
    setupSpawnMock(procB);
    const rB = await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

    expect(rB.content[0].text).toContain('Running project');
    expect(killProcess).not.toHaveBeenCalled();          // B run 不杀 A(窗口互杀修复)
    expect(getRunSessionProc('/pA')).toBe(procA);        // proc 各归各桶(真实模块)
    expect(getRunSessionProc('/pB')).toBe(procB);
  });

  it('坑 1 行为锁定:活跃切走后,A 的输出仍写 A 桶', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 0 }, ctx);
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

    // B run(活跃切走)后,procA 的 stdout 数据进 A 桶(闭包 sessionKey,不读活跃指针)
    procA.stdout.emit('data', Buffer.from('A-log-line'));
    expect(getSession('/pA').outputBuffer).toContain('A-log-line');
    expect(getSession('/pB').outputBuffer).not.toContain('A-log-line');
  });

  it('C-1 行为锁定:profiling await 窗口下并发 run 互不杀、proc 各归各桶', async () => {
    // mock DebuggerProfiler.create 延迟 resolve,制造 run_project profiling 路径
    // `await DebuggerProfiler.create()` 的真实并发窗口(设计 §10.3 C-1)
    let resolveCreateA;
    mockProfilerCreate.mockImplementationOnce(() => new Promise(r => { resolveCreateA = r; }));
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    const runAPromise = handleTool('runtime', {
      action: 'run_project', project_path: '/pA', profiling: true, timeout: 0,
    }, ctx);
    await new Promise(r => setImmediate(r));   // A 推进到 create await 挂起点

    // A 挂起期间 B run(活跃指针被 B 切走)
    const procB = mockProc();
    setupSpawnMock(procB);
    const rB = await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);
    expect(rB.content[0].text).toContain('Running project');

    resolveCreateA(fakeProfiler());
    setupSpawnMock(procA);   // A 恢复执行后的 spawn 返回 procA(mock 当前值是 procB)
    await runAPromise;

    expect(getRunSessionProc('/pA')).toBe(procA);   // A 的 proc 写 A 桶(非活跃桶)
    expect(getRunSessionProc('/pB')).toBe(procB);   // B 不被 A 写入误杀
    expect(forceKillTree).not.toHaveBeenCalled();   // 互不杀(C-1 核心)
    // spawn 顺序:B 先(A 挂起窗口内 spawn)、A 后(create resolve 后)——
    // 按内容识别:profiling 路径(A)带 --remote-debug,B 的不带
    const spawnArgsB = spawn.mock.calls[0];
    expect(spawnArgsB[1]).toContain('/pB');
    expect(spawnArgsB[1]).not.toContain('--remote-debug');
    const spawnArgsA = spawn.mock.calls[1];
    expect(spawnArgsA[1]).toContain('/pA');
    expect(spawnArgsA[1]).toContain('--remote-debug');
  });

  it('I-1 行为锁定:A(profiling)运行中 run B,B 不销毁 A 的 profiler', async () => {
    const profilerA = fakeProfiler();
    mockProfilerCreate.mockResolvedValueOnce(profilerA);
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', profiling: true, timeout: 0 }, ctx);
    expect(ctx.functionProfiler).toBe(profilerA);

    // 非同桶 run B:不得无条件 close 现有 profiler(I-1:仅同桶属主才关)
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

    expect(ctx.functionProfiler).toBe(profilerA);          // profiler 保留最近一次 profiling 会话
    expect(profilerA.close).not.toHaveBeenCalled();
  });

  it('I-1 行为锁定:B 退出(close)不断 A 的 profiler', async () => {
    const profilerA = fakeProfiler();
    mockProfilerCreate.mockResolvedValueOnce(profilerA);
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', profiling: true, timeout: 0 }, ctx);
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

    procB.emit('close', 0);   // B 退出:close handler 的 profiler 清理段须属主守卫

    expect(ctx.functionProfiler).toBe(profilerA);
    expect(profilerA.close).not.toHaveBeenCalled();
  });

  it('上限溢出:超出 GODOT_MCP_MAX_SESSIONS 的 run 被拒并列出在跑会话', async () => {
    process.env.GODOT_MCP_MAX_SESSIONS = '2';
    try {
      const ctx = createMockCtx();
      for (const p of ['/p1', '/p2']) {
        setupSpawnMock(mockProc());
        await handleTool('runtime', { action: 'run_project', project_path: p, timeout: 0 }, ctx);
      }
      setupSpawnMock(mockProc());
      const r3 = await handleTool('runtime', { action: 'run_project', project_path: '/p3', timeout: 0 }, ctx);

      expect(r3.content[0].text).toContain('GODOT_MCP_MAX_SESSIONS');
      expect(r3.content[0].text).toContain('/p2');        // 列出在跑会话清单
      expect(getRunSessionProc('/p3')).toBeNull();        // 第 3 个未启动
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.GODOT_MCP_MAX_SESSIONS;
    }
  });

  it('同项目覆盖不算新增名额(上限豁免)', async () => {
    process.env.GODOT_MCP_MAX_SESSIONS = '1';
    try {
      const ctx = createMockCtx();
      setupSpawnMock(mockProc());
      await handleTool('runtime', { action: 'run_project', project_path: '/p1', timeout: 0 }, ctx);
      setupSpawnMock(mockProc());
      const r2 = await handleTool('runtime', { action: 'run_project', project_path: '/p1', timeout: 0 }, ctx);
      expect(r2.content[0].text).toContain('Running project');   // 同项目重跑不被上限拒绝
    } finally {
      delete process.env.GODOT_MCP_MAX_SESSIONS;
    }
  });

  it('守卫专项:活跃切走后关旧窗,A 桶被正确清理且 B 的 busy/proc 完好', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 0 }, ctx);
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

    procA.stdout.emit('data', Buffer.from('A-log'));
    procA.emit('close', 0);   // 用户关 A 窗:close 守卫按 A 的 sessionKey 清 A 桶

    const sA = getSession('/pA');
    expect(sA.status).toBe('exited_early');               // 2s 内 close 判定
    expect(sA.proc).toBeNull();
    expect(sA.lastFinishedRunOutput).toContain('A-log');  // 快照留档可查
    expect(getRunSessionProc('/pB')).toBe(procB);         // B 桶 proc 不动
    expect(getSession('/pB').busy).toBe(true);            // B 的 busy 锁不被动(活跃指针在 B)
  });

  it('stop_project/get_debug_output 带 project_path 读指定桶', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 0 }, ctx);
    const procB = mockProc();
    setupSpawnMock(procB);
    await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);
    procA.stdout.emit('data', Buffer.from('ERROR: from A\n'));
    procB.stdout.emit('data', Buffer.from('ERROR: from B\n'));

    // A 活跃时查 B 桶输出 / 反之(显式 project_path 覆盖活跃缺省)
    const rA = await handleTool('runtime', { action: 'get_debug_output', project_path: '/pA' }, ctx);
    const tA = resultText(rA);
    expect(tA).toContain('from A');
    expect(tA).not.toContain('from B');
    expect(JSON.parse(stripEnvelope(tA)).running).toBe(true);

    const rDefault = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(resultText(rDefault)).toContain('from B');     // 缺省=活跃桶(最近 run 的 B)

    // stop 指定 A:只停 A,B 完好
    const rStop = await handleTool('runtime', { action: 'stop_project', project_path: '/pA' }, ctx);
    expect(killProcess).toHaveBeenCalledWith(procA);
    expect(killProcess).not.toHaveBeenCalledWith(procB);
    const parsed = JSON.parse(stripEnvelope(resultText(rStop)));
    expect(parsed.status).toBe('stopped');
    expect(parsed.errors.some(e => e.includes('from A'))).toBe(true);
    expect(getRunSessionProc('/pB')).toBe(procB);
    expect(getSession('/pB').busy).toBe(true);
  });

  it('get_debug_output 指定未知/已逐出项目 → No debug output + session 提示', async () => {
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output', project_path: '/never-run' }, ctx);
    const t = resultText(r);
    expect(t).toContain('No debug output available');
    expect(t).toContain('session evicted or unknown');
  });

  it('成功消息在多会话时追加 (N sessions running),单会话不追加', async () => {
    const ctx = createMockCtx();
    setupSpawnMock(mockProc());
    const rA = await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 0 }, ctx);
    expect(resultText(rA)).not.toContain('sessions running');
    setupSpawnMock(mockProc());
    const rB = await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);
    expect(resultText(rB)).toContain('(2 sessions running)');
  });

  it('preview per-project:双项目 preview 并存,均无 autoStop', async () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockCtx();
      const procA = mockProc();
      setupSpawnMock(procA);
      await handleTool('runtime', { action: 'run_project', project_path: '/pA', timeout: 5, preview: true }, ctx);
      const procB = mockProc();
      setupSpawnMock(procB);
      const rB = await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 5, preview: true }, ctx);
      expect(resultText(rB)).toContain('Preview mode');
      expect(resultText(rB)).toContain('(2 sessions running)');

      killProcess.mockClear();
      vi.advanceTimersByTime(6000);
      expect(killProcess).not.toHaveBeenCalled();        // preview 无 auto-stop
      expect(getRunSessionProc('/pA')).toBe(procA);
      expect(getRunSessionProc('/pB')).toBe(procB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('坑 6 行为锁定:共享 ctx 下 A(wait_for_bridge 探测中)的 isCancelled 在 B run 后仍 false(A 活)', async () => {
    isBridgeReady.mockImplementation(() => new Promise(() => {}));   // A 永挂探测中
    try {
      const ctx = createMockCtx();
      const procA = mockProc();
      setupSpawnMock(procA);
      handleTool('runtime', {
        action: 'run_project', project_path: '/pA', wait_for_bridge: true, bridge_timeout: 5, timeout: 0,
      }, ctx);   // 永挂探测不 settle,悬空无 rejection,无需 await
      await new Promise(r => setImmediate(r));   // A 推进到 isBridgeReady 探测

      // B run(活跃切走)后,A 的 isCancelled 按 A 桶身份判断,不得因活跃指针切走而误报
      const procB = mockProc();
      setupSpawnMock(procB);
      await handleTool('runtime', { action: 'run_project', project_path: '/pB', timeout: 0 }, ctx);

      const opts = isBridgeReady.mock.calls[0][2];
      expect(opts.isCancelled()).toBe(false);            // A 活着 → 不误报(坑 6)
      expect(getRunSessionProc('/pA')).toBe(procA);      // A 未被 B run 杀

      procA.emit('close', 0);   // 清 A 的 autoStopTimer,避免测试后 timer 泄漏
    } finally {
      isBridgeReady.mockReset();
    }
  });
});
