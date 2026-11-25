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

vi.mock('../src/core/path-utils.js', () => ({
  validatePath: vi.fn(p => p),
}));
vi.mock('../src/core/args-validation.js', () => ({
  requireProjectPath: vi.fn(args => typeof args === 'string' ? args : args.project_path),
}));
vi.mock('../src/core/godot-finder.js', () => ({
  buildSafeEnv: vi.fn(() => process.env),
  checkVersionMismatch: vi.fn(async () => null),
  detectGodotVersion: vi.fn(async () => '4.6.stable'),
}));

// D6: run_tests 分片模式需要 readdirSync/writeFileSync/unlinkSync——factory 面同步扩展
// (默认值无害:readdirSync→[] 使非分片用例不触磁盘;现有用例只消费 existsSync)
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
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
  shardFiles,
  enumerateTestScripts,
} from '../src/tools/runtime.js';
import { spawn } from 'child_process';
import { readdirSync, writeFileSync, unlinkSync } from 'fs';
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
    expect(def).toMatchObject({
      name: expect.stringMatching(/\S/),
      description: expect.stringMatching(/\S/),
      inputSchema: expect.any(Object),
    });
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
    expect(Object.hasOwn(TOOL_META, 'runtime')).toBe(true);
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

    expect(result?.content?.[0]?.text).toContain('Launched Godot editor');
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

    expect(result?.content?.[0]?.text).toContain('Running project');
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
    expect(result?.content?.[0]?.text).toContain('failed to spawn');
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

    expect(result?.content?.[0]?.text).toContain('No project is currently running');
  });

  // ─── Task 4 审查 Minor 修正:多项目提示文案(已传参不引导再传;未传参消除矛盾) ───

  it('显式传 project_path 且目标无进程但其他项目在跑 → 报目标项目,不引导再传参', async () => {
    // 建一个其他项目的活桶(真实 process-state)
    const proc = mockProc();
    setupSpawnMock(proc);
    await handleTool('runtime', { action: 'run_project', project_path: '/other' }, createMockCtx());

    const result = await handleTool('runtime', { action: 'stop_project', project_path: '/x' }, createMockCtx());
    const text = result.content[0].text;
    expect(text).toContain('Project /x has no running process');
    expect(text).toContain('Other sessions');
    expect(text).not.toContain('Pass project_path to target one');
  });

  it('未传参(活跃桶无进程)但其他项目在跑 → 保持引导句式,首句不再自相矛盾', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    await handleTool('runtime', { action: 'run_project', project_path: '/other' }, createMockCtx());

    // ctx.projectDir='/fake/project'(无桶无进程)→ 缺省 stop 落活跃桶
    const result = await handleTool('runtime', { action: 'stop_project' }, createMockCtx());
    const text = result.content[0].text;
    expect(text).toContain('Active project has no running process');
    expect(text).toContain('Sessions still running');
    expect(text).toContain('Pass project_path to target one');
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

    expect(result !== null).toBe(true);
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
    expect(result?.content?.[0]?.text).toContain('No debug output available');
  });

  it('returns classified debug output', async () => {
    // 真实桶路径:run 建桶 + appendOutput(真实)写输出 → get_debug_output 读活跃桶
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    await handleTool('runtime', { action: 'run_project', project_path: '/fake/project' }, ctx);
    proc.stdout.emit('data', Buffer.from('ERROR: something broke\nWARNING: deprecated\nhello world\n'));

    const result = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(result !== null).toBe(true);
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
    expect(result !== null).toBe(true);
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
    expect(result !== null).toBe(true);
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
    expect(result !== null).toBe(true);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('-gexit');
    expect(spawnArgs[1]).not.toContain('-gquit');
  });

  // D6 真机实证(2026-11-12, GUT 9.7.1 + Godot 4.7): Totals 段是无冒号对齐空格式
  // "Tests<spaces>N" / "Passing Tests<spaces>N" / "Failing Tests<spaces>N"(非零才打印),
  // 旧 regex "Tests: (\d+)" 在 GUT 9.7 上匹配不到任何行——解析须双格式兼容。
  it('GUT 9.7 Totals 格式(无冒号):单进程 passed 计数可解析', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const rp = handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
    }, ctx);
    emitProcessEvents(proc, 'Totals\n------\nTests                 6\nPassing Tests         6\nAsserts               6\n');
    const result = await rp;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.passed).toBe('6');
  });

  it('GUT 9.7 格式带 ANSI 色码也能解析(输出实含 \\x1b[33m 等)', async () => {
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const rp = handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
    }, ctx);
    emitProcessEvents(proc, '\x1b[33mTests\x1b[0m                 6\n');
    const result = await rp;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.passed).toBe('6');
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
    expect(result !== null).toBe(true);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('-gquit');
    expect(spawnArgs[1]).not.toContain('--evil-flag');
  });

  // D6 (2026-11-12 反馈批次): timeout 参数取代 120s 硬编码(单进程路径同样生效)
  it('timeout 可配:单进程路径 timeout=5 时 5s 强杀(默认 120)', async () => {
    vi.useFakeTimers();
    try {
      const proc = mockProc();
      setupSpawnMock(proc);   // 永不 close → 超时路径
      const ctx = createMockCtx();
      const rp = handleTool('runtime', {
        action: 'run_tests',
        project_path: '/fake/project',
        timeout: 5,
      }, ctx);
      await new Promise(r => process.nextTick(r));   // spawn 已发生

      vi.advanceTimersByTime(4_999);
      expect(forceKillTree).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(forceKillTree).toHaveBeenCalledWith(proc);

      const result = await rp;
      expect(result.content[0].text).toContain('timed out after 5s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout 缺省 120s(向后兼容基线)', async () => {
    vi.useFakeTimers();
    try {
      const proc = mockProc();
      setupSpawnMock(proc);
      const ctx = createMockCtx();
      const rp = handleTool('runtime', {
        action: 'run_tests',
        project_path: '/fake/project',
      }, ctx);
      await new Promise(r => process.nextTick(r));

      vi.advanceTimersByTime(119_999);
      expect(forceKillTree).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(forceKillTree).toHaveBeenCalled();

      const result = await rp;
      expect(result.content[0].text).toContain('timed out after 120s');
    } finally {
      vi.useRealTimers();
    }
  });

  // I-1(D6 审查): timeout=-1 不得归一成 1s——run_project 惯例明文"0/-1=不自动停",
  // 读者按惯例给 run_tests 传 -1 若走 || 短路(truthy 直通)+max(1,·) 会得 1s 几乎必超时。
  // 归一规则:非有限正数(含 0/负数/NaN/未传)一律回落 120。
  it('timeout=-1(run_project 不自动停惯例输入)归一回 120s,而非 1s(I-1)', async () => {
    vi.useFakeTimers();
    try {
      const proc = mockProc();
      setupSpawnMock(proc);
      const ctx = createMockCtx();
      const rp = handleTool('runtime', {
        action: 'run_tests',
        project_path: '/fake/project',
        timeout: -1,
      }, ctx);
      await new Promise(r => process.nextTick(r));

      vi.advanceTimersByTime(119_999);
      expect(forceKillTree).not.toHaveBeenCalled();   // 若归一成 1s,此处早已强杀
      vi.advanceTimersByTime(1);
      expect(forceKillTree).toHaveBeenCalled();

      const result = await rp;
      expect(result.content[0].text).toContain('timed out after 120s');
    } finally {
      vi.useRealTimers();
    }
  });

  // B5(竞品综述落地批 2026-11-13): run_tests I-SEC-08 前缀检查后补段级 ".." 拒绝——
  // 前缀挡不住 res://../<项目外> 枚举越界;对齐 path-utils.ts:196 段级精确形态,
  // 含 .. 的合法文件名(foo..bar.gd / ..hidden)不误伤。
  it('test_script 含 ".." 段(res://../evil)拒绝——spawn 不发生', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      test_script: 'res://../evil',
    }, ctx);
    expect(result.content[0].text).toContain('".." path segments');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('test_script 混合分隔符段级 ".."(res://a/../..\\\\evil)同样拒绝', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      test_script: 'res://a/../..\\evil',
    }, ctx);
    expect(result.content[0].text).toContain('".." path segments');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('合法路径不误伤: res://tests/foo.gd 与含 ".." 文件名(res://tests/foo..bar.gd)放行', async () => {
    for (const script of ['res://tests/foo.gd', 'res://tests/foo..bar.gd', 'res://tests/..hidden.gd']) {
      const proc = mockProc();
      setupSpawnMock(proc);
      const ctx = createMockCtx();
      const rp = handleTool('runtime', {
        action: 'run_tests',
        project_path: '/fake/project',
        test_script: script,
      }, ctx);
      emitProcessEvents(proc, 'Tests: 5 Passed');
      const result = await rp;
      expect(JSON.parse(result.content[0].text).exit_code).toBe(0);   // 正常走 GUT spawn
      const spawnArgs = spawn.mock.calls.at(-1);
      expect(spawnArgs[1]).toContain(script);   // 原样透传给 -gdir
    }
  });
});

// ─── handleTool — run_tests 分片模式(D6, 2026-11-12 反馈:单进程全量 22.5GB 死机) ───

describe('runtime handleTool — run_tests 分片模式(D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const direntry = (name, isDir) => ({
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  });

  function setupFlatTestDir(names) {
    readdirSync.mockImplementation(() => names.map(n => direntry(n, false)));
  }

  function shardSpawn(outputs, exitCodes) {
    outputs.forEach((outText, i) => {
      spawn.mockImplementationOnce(() => {
        const p = mockProc();
        process.nextTick(() => {
          p.stdout.emit('data', Buffer.from(outText));
          p.emit('close', exitCodes[i]);
        });
        return p;
      });
    });
  }

  it('shards=2: spawn 2 次、每次 args 含 -gconfig= 且不含 -gdir、汇总 Tests=两片之和(3+4=7)', async () => {
    setupFlatTestDir(['test_a.gd', 'test_b.gd', 'test_c.gd', 'test_d.gd']);
    shardSpawn(['Tests: 3\nFailed: 0\n', 'Tests: 4\nFailed: 1\n'], [0, 1]);

    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
    }, createMockCtx());

    expect(spawn).toHaveBeenCalledTimes(2);
    for (const call of spawn.mock.calls) {
      const gconfigArg = call[1].find(a => typeof a === 'string' && a.startsWith('-gconfig='));
      expect(gconfigArg, '每片 spawn 须传 -gconfig=<临时文件>').toMatch(/^-gconfig=.+/);
      // cmd 层 -gdir 优先级最高会覆盖 config 的 dirs(反馈坑③:防 dirs 附加合并)——分片禁传
      expect(call[1]).not.toContain('-gdir');
    }
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_tests).toBe(7);
    expect(parsed.total_failed).toBe(1);
    expect(parsed.all_passed).toBe(false);
    expect(parsed.shards).toBe(2);
  });

  it('GUT 9.7 Totals 格式:分片计数求和(Failing Tests 非零行)', async () => {
    setupFlatTestDir(['test_a.gd', 'test_b.gd']);
    shardSpawn([
      'Totals\n------\nTests                 4\nFailing Tests         1\n',
      'Totals\n------\nTests                 3\n',
    ], [1, 0]);

    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
    }, createMockCtx());

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_tests).toBe(7);
    expect(parsed.total_failed).toBe(1);
    expect(parsed.shard_results[0].failed).toBe(1);
    expect(parsed.shard_results[1].failed).toBe(0);   // Failing 行非零才打印:缺行=0
  });

  it('每片临时 gutconfig:dirs 置空、tests=该片 res:// 文件蛇形分配(a,c|b,d),跑完清理', async () => {
    setupFlatTestDir(['test_a.gd', 'test_b.gd', 'test_c.gd', 'test_d.gd']);
    shardSpawn(['Tests: 2\n', 'Tests: 2\n'], [0, 0]);

    await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
    }, createMockCtx());

    expect(writeFileSync).toHaveBeenCalledTimes(2);
    const cfg0 = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(cfg0.dirs).toEqual([]);
    expect(cfg0.tests).toEqual(['res://test/test_a.gd', 'res://test/test_c.gd']);
    const cfg1 = JSON.parse(writeFileSync.mock.calls[1][1]);
    expect(cfg1.tests).toEqual(['res://test/test_b.gd', 'res://test/test_d.gd']);
    // 临时文件跑完清理(每片 unlink 一次)
    expect(unlinkSync).toHaveBeenCalledTimes(2);
    const writtenPaths = writeFileSync.mock.calls.map(c => c[0]);
    for (const p of writtenPaths) {
      expect(unlinkSync).toHaveBeenCalledWith(p);
    }
  });

  it('失败片(exit 1)不中断后续片:全片跑完汇总', async () => {
    setupFlatTestDir(['test_a.gd', 'test_b.gd']);
    shardSpawn(['Tests: 1\nFailed: 1\nSome Script ERROR\n', 'Tests: 2\nFailed: 0\n'], [1, 0]);

    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
    }, createMockCtx());

    expect(spawn).toHaveBeenCalledTimes(2);   // 片1 失败后片2 照跑
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.shard_results[0].status).toBe('failed');
    expect(parsed.shard_results[1].status).toBe('ok');
    expect(parsed.total_tests).toBe(3);
    expect(parsed.total_failed).toBe(1);
  });

  it('片超时不中断后续片:per-shard 计时,超时片 status=timeout', async () => {
    vi.useFakeTimers();
    try {
      setupFlatTestDir(['test_a.gd', 'test_b.gd']);
      const hung = mockProc();   // 片1 永不 close
      spawn.mockImplementationOnce(() => hung);
      spawn.mockImplementationOnce(() => {
        const p = mockProc();
        process.nextTick(() => {
          p.stdout.emit('data', Buffer.from('Tests: 2\n'));
          p.emit('close', 0);
        });
        return p;
      });

      const rp = handleTool('runtime', {
        action: 'run_tests',
        project_path: '/fake/project',
        shards: 2,
        timeout: 5,
      }, createMockCtx());
      await new Promise(r => process.nextTick(r));   // 片1 spawn 已发生

      vi.advanceTimersByTime(5_000);   // 片1 超时 → 片2 继续
      const result = await rp;

      expect(forceKillTree).toHaveBeenCalledWith(hung);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.shard_results[0].status).toBe('timeout');
      expect(parsed.shard_results[1].status).toBe('ok');
      expect(parsed.total_tests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout=-1 分片模式:timeout_per_shard_s 归一 120(I-1,非 1s)', async () => {
    setupFlatTestDir(['test_a.gd', 'test_b.gd']);
    shardSpawn(['Tests: 1\n', 'Tests: 1\n'], [0, 0]);

    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
      timeout: -1,
    }, createMockCtx());

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.timeout_per_shard_s).toBe(120);
    // 全片正常完成(120s 默认下 mock 进程立即 close,非 timeout 状态)
    expect(parsed.shard_results.every(x => x.status === 'ok')).toBe(true);
  });

  it('shards 缺省(=1):保持现有单进程行为(-gdir 直传、无 -gconfig、输出结构不变)', async () => {
    setupFlatTestDir(['test_a.gd']);
    const proc = mockProc();
    setupSpawnMock(proc);
    const ctx = createMockCtx();
    const rp = handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
    }, ctx);
    emitProcessEvents(proc, 'Tests: 5 Passed');

    const result = await rp;
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = spawn.mock.calls[0];
    expect(spawnArgs[1]).toContain('-gdir');
    expect(spawnArgs[1].some(a => typeof a === 'string' && a.startsWith('-gconfig='))).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.passed).toBe('5');   // 现有输出结构(单值 join)
  });

  it('测试目录无 .gd 文件时报错(不空跑分片)', async () => {
    setupFlatTestDir(['notes.txt']);
    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: '/fake/project',
      shards: 2,
    }, createMockCtx());
    expect(result.content[0].text).toContain('no test scripts');
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ─── run_tests 分片纯函数(D6) ────────────────────────────────────────────────

describe('run_tests 分片纯函数(D6)', () => {
  it('shardFiles 蛇形 round-robin:排序后轮流发牌,片间均衡(非连续切块)', () => {
    expect(shardFiles(['e', 'a', 'c', 'b', 'd'], 2)).toEqual([['a', 'c', 'e'], ['b', 'd']]);
    expect(shardFiles(['a', 'b'], 4)).toEqual([['a'], ['b'], [], []]);   // 片数>文件数:空片保留由调用方过滤
    expect(shardFiles(['a'], 1)).toEqual([['a']]);
  });

  it('enumerateTestScripts:递归子目录、排除 addons 段/_ 前缀/非 .gd/点开头', () => {
    readdirSync.mockImplementation((dir) => {
      if (dir === '/fake/project/test') {
        return [
          direntryHelper('test_a.gd', false),
          direntryHelper('sub', true),
          direntryHelper('addons', true),
          direntryHelper('_helper.gd', false),
          direntryHelper('notes.txt', false),
          direntryHelper('.hidden', true),
        ];
      }
      if (dir === '/fake/project/test/sub') {
        return [direntryHelper('test_deep.gd', false), direntryHelper('_skip.gd', false)];
      }
      throw new Error(`unexpected readdirSync: ${dir}`);
    });
    const files = enumerateTestScripts('/fake/project', 'res://test/');
    expect(files).toEqual(['res://test/sub/test_deep.gd', 'res://test/test_a.gd']);
  });

  it('enumerateTestScripts:单 .gd 文件入参直接返回单元素列表', () => {
    expect(enumerateTestScripts('/fake/project', 'res://test/test_only.gd'))
      .toEqual(['res://test/test_only.gd']);
  });
});

// direntry helper(纯函数 describe 共用;主 describe 内 direntry 已定义)
function direntryHelper(name, isDir) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

// ─── handleTool — get_godot_version ─────────────────────────────────────────

describe('runtime handleTool — get_godot_version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Godot version via detectGodotVersion', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('runtime', { action: 'get_godot_version' }, ctx);
    expect(result?.content?.[0]?.text).toContain('4.6');
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
