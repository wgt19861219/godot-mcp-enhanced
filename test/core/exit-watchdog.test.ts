// test/core/exit-watchdog.test.ts
//
// 内存治理二期 Task 4:退出 watchdog 单测(Playwright setupExitWatchdog 模式)——
// ①stdin close/SIGINT/SIGTERM 第一次触发 → 优雅回收全部非 preview 会话(逐桶
// stopping→kill 链→清桶→game_window 租约出账) ②10s 窗口内二次触发 → 立即强杀
// 全部 + exit(0) ③30s 兜底 exit(0)(优雅回收/退出链卡死也保证退出) ④preview 会话
// 不回收(用户在看的窗口,用户关窗即结束)。
// 补充:空桶触发 no-op/已结束桶不动/setupExitWatchdog 一次性注册(重复调用不叠加
// handler)/优雅段 10s 有限等待升级树杀。
// 三期 Task 3:pressure×exit-watchdog 正交(终审 Minor-5)——hard 态与 normal 态跑同一
// 退出链,回收目标/preview 豁免口径/优雅→强杀调用序逐字段一致;exit 链不读也不写
// pressure 状态机(源码锚+行为双钉,防未来往 exit 链加 pressure 分支)。
//
// 夹具约定(复制 test/core/session-idle-timer.test.ts 形态):mkdtemp tmp +
// _setLeasesFilePathForTest 重定向租约文件 + _resetForTest;child_process 的 spawn
// 包装为纯假(树杀参数断言,绝不真杀);pid 探活 vi.spyOn(process,'kill');fake timers
// 驱动三段转换(killProcess 5s 兜底/10s 优雅窗/30s 兜底 exit)。会话桶用
// process-state 真实 API 建桶(setRunSessionProc + makeProc 假进程);exit 经
// _resetExitWatchdogForTest 注入 fake 断言,绝不真退测试进程。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'node:events';

// child_process spy 包装(importOriginal 保真):断言树杀 spawn 参数;beforeEach 里
// 顶层 mockImplementation 纯假 child({on}),任何用例触发的树杀绝不真执行。
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn as spawnSpy } from 'child_process';
import {
  getSession,
  resetState,
  setRunSessionProc,
  setSessionStatus,
} from '../../src/core/process-state.js';
import {
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  updatePressureState,
  getPressureState,
  type MemLease,
  type MachineMemorySnapshot,
} from '../../src/core/memory-guard.js';
import {
  handleExitTrigger,
  setupExitWatchdog,
  stopExitWatchdog,
  _resetExitWatchdogForTest,
} from '../../src/core/exit-watchdog.js';

const IS_WIN = process.platform === 'win32';

let tmpDir: string;
let leasePath: string;
let exitSpy: ReturnType<typeof vi.fn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** 假 ChildProcess:仅含回收判活/建桶/killProcess 所需字段 + 事件桩(close 不触发,
 *  killProcess 只能靠 5s 兜底 resolve——正好驱动「有限等待」语义)。 */
function makeProc(pid: number): ChildProcess {
  return { pid, killed: false, exitCode: null, on: vi.fn(), kill: vi.fn() } as unknown as ChildProcess;
}

function makeLease(partial: Partial<MemLease> = {}): MemLease {
  const now = Date.now();
  return {
    id: 'lease-exit',
    serverPid: process.pid,
    kind: 'game_window',
    declaredMB: 3072,
    projectPath: 'D:/proj-a',
    pid: null,
    startedAt: now,
    lastHeartbeat: now,
    ...partial,
  };
}

/** 直接写租约文件夹具(绕过被测模块,构造初始盘面)。 */
function writeLeaseFixture(leases: MemLease[]): void {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, JSON.stringify({ version: 1, leases }));
}

/** 读盘面(验证回收后租约移除落在文件上)。 */
function readDisk(): { version: number; leases: MemLease[] } {
  return JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { version: number; leases: MemLease[] };
}

/** mock process.kill:命中 aliveSet 返回 true,否则抛 ESRCH(死)。 */
function mockKillProbe(aliveSet: Set<number>): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (aliveSet.has(pid)) return true;
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as typeof process.kill);
}

/** 期望树杀命令(pid 参数按平台形态断言)。 */
function expectTreeKill(pid: number): void {
  if (IS_WIN) {
    expect(spawnSpy).toHaveBeenCalledWith(
      'taskkill', ['/F', '/T', '/PID', String(pid)], expect.objectContaining({ stdio: 'ignore' }),
    );
  } else {
    expect(spawnSpy).toHaveBeenCalledWith(
      'pkill', ['-P', String(pid)], expect.objectContaining({ stdio: 'ignore' }),
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetState();            // process-state 会话桶隔离
  _resetForTest();         // memory-guard 状态隔离(env 开关缓存/租约序号)
  // 意外真采样立即炸测试(listActiveLeases 只探活不采样,此 runner 兜底防漏网路径)
  _setPsRunnerForTest(() => {
    throw new Error('unexpected real PowerShell spawn');
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-watchdog-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
  // spawn 顶层纯假:返回带 on() 的假 child,树杀绝不真执行
  vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
  // watchdog 状态机复位 + exit 注入 fake(绝不真退测试进程)
  exitSpy = vi.fn();
  _resetExitWatchdogForTest(exitSpy as unknown as (code: number) => void);
  // 回收行 console 一路走 stderr(stdout 是 stdio 模式 JSON-RPC 独占通道,
  // mem-watchdog/idle-reap 行同通道)——spy 防刷屏+可断言
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetState();
  // 摘 setupExitWatchdog 真注册的 handler(幂等测试会碰真 process 事件面,精确摘除)
  stopExitWatchdog();
  _resetExitWatchdogForTest(null);
  vi.useRealTimers();
  _setLeasesFilePathForTest(null);
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('① 第一次触发(stdin close/SIGINT/SIGTERM)→ 逐会话回收 + 释放租约', () => {
  it('两个非 preview 会话:逐桶树杀、桶清干净、game_window 租约出账', async () => {
    const procA = makeProc(4242);
    const procB = makeProc(4243);
    setRunSessionProc('D:/proj-a', procA, true);
    setRunSessionProc('D:/proj-b', procB, true);
    writeLeaseFixture([
      makeLease({ id: 'L1', pid: 4242 }),
      makeLease({ id: 'L2', pid: 4243, projectPath: 'D:/proj-b' }),
    ]);
    mockKillProbe(new Set([4242, 4243]));

    handleExitTrigger('stdin-close');

    // 优雅段 kill 链立即发出(killProcess 末行 forceKillTree 同步 spawn 树杀命令)
    expectTreeKill(4242);
    expectTreeKill(4243);
    // 优雅等待版 kill 的 5s 内置兜底后(killProcess resolve),收尾链跑完
    await vi.advanceTimersByTimeAsync(5_000);
    for (const p of ['D:/proj-a', 'D:/proj-b']) {
      const s = getSession(p);
      expect(s?.proc).toBeNull();              // 会话桶清干净(验收锚)
      expect(s?.status).toBe('exited');        // markSessionStopping(主动停止语义)→
                                              // clearRunSession 的 stashToSnapshot 归 exited
    }
    expect(readDisk().leases).toHaveLength(0); // 租约不挂账(验收锚)
    // 一次触发不主动 exit(退出决策交还既有退出链 index.ts gracefulShutdown)
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('回收行 stderr 一行 MEMGUARD exit-reap(可 grep,与 idle-reap 同通道)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    writeLeaseFixture([makeLease({ id: 'L1', pid: 4242 })]);
    mockKillProbe(new Set([4242]));

    handleExitTrigger('SIGINT');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/MEMGUARD exit-reap 4242/));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('D:/proj-a'));
  });

  it('空会话(无任何桶)触发 no-op 不炸、不 exit', async () => {
    handleExitTrigger('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('已结束桶(exited)不动——回收只针对存活会话', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    setSessionStatus('D:/proj-a', 'exited');
    mockKillProbe(new Set([4242]));

    handleExitTrigger('stdin-close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getSession('D:/proj-a')?.status).toBe('exited');
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringMatching(/MEMGUARD exit-reap/));
  });
});

describe('② 10s 窗口内二次触发 → 立即强杀全部 + exit(0)', () => {
  it('graceful 期间第二信号:立即树杀 + exit(0),不等优雅段收尾', async () => {
    const procA = makeProc(4242);
    const procB = makeProc(4243);
    setRunSessionProc('D:/proj-a', procA, true);
    setRunSessionProc('D:/proj-b', procB, true);
    mockKillProbe(new Set([4242, 4243]));

    handleExitTrigger('SIGINT');                 // 第一次:进入 graceful
    vi.mocked(spawnSpy).mockClear();             // 清掉优雅段首轮树杀计数
    await vi.advanceTimersByTimeAsync(1_000);    // 10s 窗口内
    handleExitTrigger('SIGTERM');                // 第二次:立即强杀

    expect(exitSpy).toHaveBeenCalledWith(0);     // 立即 exit(0)(零 timer 推进)
    expectTreeKill(4242);                        // 全部仍存活非 preview 桶强杀
    expectTreeKill(4243);
    for (const p of ['D:/proj-a', 'D:/proj-b']) {
      expect(getSession(p)?.proc).toBeNull();    // 桶已清
    }
  });

  it('强杀行 stderr 一行 MEMGUARD exit-force-kill(可 grep)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    handleExitTrigger('SIGINT');
    handleExitTrigger('SIGINT');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/MEMGUARD exit-force-kill 4242/));
  });
});

describe('③ 30s 兜底 exit(0)(优雅回收/退出链卡死也保证退出)', () => {
  it('触发后 30s 到点 → exit(0)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    handleExitTrigger('stdin-close');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(exitSpy).not.toHaveBeenCalled();      // 未到点不退
    await vi.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledWith(0);     // 30s 整到点兜底退
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('④ preview 会话不回收(用户在看的窗口,用户关窗即结束)', () => {
  it('非 preview 回收、preview 桶原样保留(proc 不杀/状态 running/租约挂账)', async () => {
    const procNormal = makeProc(4242);
    const procPreview = makeProc(4343);
    setRunSessionProc('D:/proj-a', procNormal, true);
    setRunSessionProc('D:/proj-b', procPreview, true);
    getSession('D:/proj-b')!.preview = true;     // run_project 建桶处落的值
    writeLeaseFixture([
      makeLease({ id: 'L1', pid: 4242 }),
      makeLease({ id: 'L2', pid: 4343, projectPath: 'D:/proj-b' }),
    ]);
    mockKillProbe(new Set([4242, 4343]));

    handleExitTrigger('stdin-close');
    await vi.advanceTimersByTimeAsync(5_000);

    // 非 preview:回收
    expect(getSession('D:/proj-a')?.proc).toBeNull();
    // preview:原样不动(验收锚)
    const pv = getSession('D:/proj-b');
    expect(pv?.proc).toBe(procPreview);
    expect(pv?.status).toBe('running');
    const remaining = readDisk().leases;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('L2');
  });

  it('全部 preview 会话:触发零回收、零树杀', async () => {
    const proc = makeProc(4343);
    setRunSessionProc('D:/proj-b', proc, true);
    getSession('D:/proj-b')!.preview = true;
    mockKillProbe(new Set([4343]));

    handleExitTrigger('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(getSession('D:/proj-b')?.proc).toBe(proc);
  });
});

describe('补充:一次性注册与优雅窗升级', () => {
  it('setupExitWatchdog 幂等(重复调用不叠加 handler)', () => {
    const stdinBefore = (process.stdin as EventEmitter).listenerCount('close');
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    setupExitWatchdog();
    setupExitWatchdog();
    setupExitWatchdog();

    expect((process.stdin as EventEmitter).listenerCount('close')).toBe(stdinBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
  });

  it('优雅段 10s 窗口到点时已收尾 → 不升级树杀、不 exit(有限等待的硬语义边界)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    handleExitTrigger('SIGINT');
    vi.mocked(spawnSpy).mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    // fake proc 不 emit close,killProcess 走 5s 内置兜底强杀(spawn 1 次)后 settle;
    // 10s 升级路径(forceReapSessions)不触发——其标志是 exit-force-kill 日志
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringMatching(/MEMGUARD exit-force-kill/));
    expect(getSession('D:/proj-a')?.proc).toBeNull();   // 收尾链已完成(桶清)
    expect(exitSpy).not.toHaveBeenCalled();             // 窗口到点≠退出(30s 兜底才退)
  });

  it('stopExitWatchdog 摘除 handler(精确摘除,幂等)', () => {
    const stdinBefore = (process.stdin as EventEmitter).listenerCount('close');
    setupExitWatchdog();
    expect((process.stdin as EventEmitter).listenerCount('close')).toBe(stdinBefore + 1);
    stopExitWatchdog();
    expect((process.stdin as EventEmitter).listenerCount('close')).toBe(stdinBefore);
    stopExitWatchdog();                          // 幂等
    expect((process.stdin as EventEmitter).listenerCount('close')).toBe(stdinBefore);
  });
});

describe('挂点锚:注册顺序与 close 不拆除(源码锚定,审查 Important-1/2)', () => {
  it('index.ts:setupExitWatchdog() 先于 process.on("SIGINT") 注册(注册序=执行序,\n' +
     '二次信号 watchdog 强杀必须抢在 gracefulShutdown 的 exit(1) 之前)', () => {
    const src = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8');
    const setupIdx = src.indexOf('setupExitWatchdog()');
    const sigintIdx = src.indexOf("process.on('SIGINT'");
    expect(setupIdx).toBeGreaterThan(-1);
    expect(sigintIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeLessThan(sigintIdx);   // watchdog 先注册 → 先执行
  });

  it('run() 内调用 setupExitWatchdog(幂等二次防线,与 startIdleTimer 同区)', () => {
    const src = readFileSync(join(__dirname, '../../src/GodotServer.ts'), 'utf8');
    expect(src).toContain('setupExitWatchdog()');
  });

  it('GodotServer.close() 不摘除 watchdog(Important-2:close 挂死场景兜底必须保持武装)', () => {
    const src = readFileSync(join(__dirname, '../../src/GodotServer.ts'), 'utf8');
    expect(src).not.toContain('stopExitWatchdog');   // close 链不拆除;测试显式收口
  });

  it('connectTransport 不注册 stdin 钩子(daemon 纪律守护,daemon 不经 run() 不挂 watchdog)', () => {
    const src = readFileSync(join(__dirname, '../../src/daemon/main.ts'), 'utf8');
    expect(src).not.toContain('setupExitWatchdog');   // daemon 入口不注册
  });
});

// ===========================================================================
// 三期 Task 3:pressure×exit-watchdog 正交(终审 Minor-5)——二期靠 exit-watchdog.ts
// 头注释论证「退出回收是生命周期卫生,非 guard 功能」,本 describe 用行为对比+源码锚
// 双钉:pressure 状态机(normal/hard)不改变退出链的任何行为,exit 链也不反写 pressure。
// ===========================================================================

/** 退出链单轮行为观测(两态可对比的纯数据:树杀目标序/桶终态/盘面终态/exit 码序)。 */
interface ExitChainObservation {
  graceTreeKillPids: number[];    // 优雅段树杀目标 pid 序(含 SIGTERM 轮+5s 兜底轮)
  normalSessionCleared: boolean;  // 非 preview 桶收尾(proc 清空+status exited)
  previewProcKept: boolean;       // preview 桶 proc 原对象保留(豁免口径)
  previewStatusRunning: boolean;  // preview 桶状态未被改写
  diskLeaseIds: string[];         // 优雅段后盘面租约(仅 preview 的留)
  exitCallsBeforeForce: number;   // 优雅段 exit 调用数(应 0——退出决策交还既有退出链)
  forceTreeKillPids: number[];    // 二次强杀段树杀目标 pid 序
  forceSessionCleared: boolean;   // 二次强杀目标桶清空
  exitCodes: number[];            // exit 调用码序(二次触发应 [0])
  pressureChanged: boolean;       // 链前后 pressure 态是否被改写(应 false——exit 链不写状态机)
}

/** 从 spawn 调用记录提取树杀目标 pid 序(taskkill /F /T /PID <pid> 与 pkill -P <pid>
 *  双平台形态统一为 pid 数组——观测平台无关,两态对比不受命令形态差异干扰)。 */
function treeKillPids(): number[] {
  const out: number[] = [];
  for (const call of vi.mocked(spawnSpy).mock.calls) {
    const cmd = call[0] as string;
    const args = (call[1] ?? []) as readonly string[];
    if (cmd !== 'taskkill' && cmd !== 'pkill') continue;
    const pidArg = args.find((a) => /^\d+$/.test(a));
    if (pidArg !== undefined) out.push(Number(pidArg));
  }
  return out;
}

/** 低压机器快照(物理空闲 100MB < 硬阈值 1536MB,commit 降级 null 只看物理口径)——
 *  直调 updatePressureState 推进 hard 态(0s 宽限一次即进,不走采样通道)。 */
function lowPressureSnap(): MachineMemorySnapshot {
  return {
    freePhysBytes: 100 * 1024 * 1024,
    totalPhysBytes: 64 * 1024 * 1024 * 1024,
    commitAvailBytes: null,
    commitTotalBytes: null,
    godotProcCount: 0,
    sampledAt: Date.now(),
  };
}

/** 跑一轮完整退出链(一次触发优雅回收 + 5s 收尾 + 窗口内二次触发强杀),返回行为观测。
 *  夹具同组会话桶:非 preview(D:/proj-a) + preview(D:/proj-b)各一,二次强杀目标另建
 *  (D:/proj-c)——覆盖「回收目标集合/preview 豁免/优雅→强杀调用序」三个观测面。 */
async function runExitChain(): Promise<ExitChainObservation> {
  resetState();                                        // 清上一轮会话桶
  _resetExitWatchdogForTest(exitSpy as unknown as (code: number) => void);
  exitSpy.mockClear();
  const procNormal = makeProc(4242);
  const procPreview = makeProc(4343);
  setRunSessionProc('D:/proj-a', procNormal, true);
  setRunSessionProc('D:/proj-b', procPreview, true);
  getSession('D:/proj-b')!.preview = true;            // run_project 建桶处落的值
  writeLeaseFixture([
    makeLease({ id: 'L1', pid: 4242 }),
    makeLease({ id: 'L2', pid: 4343, projectPath: 'D:/proj-b' }),
  ]);
  mockKillProbe(new Set([4242, 4343]));
  const pressureBefore = getPressureState();
  vi.mocked(spawnSpy).mockClear();

  handleExitTrigger('SIGINT');                        // 第一次:优雅回收段
  await vi.advanceTimersByTimeAsync(5_000);           // killProcess 5s 兜底后收尾链跑完

  const graceTreeKillPids = treeKillPids();
  const sNormal = getSession('D:/proj-a');
  const normalSessionCleared = sNormal?.proc === null && sNormal?.status === 'exited';
  const sPreview = getSession('D:/proj-b');
  const previewProcKept = sPreview?.proc === procPreview;
  const previewStatusRunning = sPreview?.status === 'running';
  const diskLeaseIds = readDisk().leases.map((l) => l.id);
  const exitCallsBeforeForce = exitSpy.mock.calls.length;

  setRunSessionProc('D:/proj-c', makeProc(4444), true);  // 重建存活目标(二次强杀要有对象)
  vi.mocked(spawnSpy).mockClear();
  handleExitTrigger('SIGTERM');                       // 第二次:10s 窗口内 → 立即强杀+exit
  const forceTreeKillPids = treeKillPids();
  const forceSessionCleared = getSession('D:/proj-c')?.proc === null;
  const exitCodes = exitSpy.mock.calls.map((c) => c[0]);
  const pressureChanged = getPressureState() !== pressureBefore;

  return {
    graceTreeKillPids, normalSessionCleared, previewProcKept, previewStatusRunning,
    diskLeaseIds, exitCallsBeforeForce, forceTreeKillPids, forceSessionCleared,
    exitCodes, pressureChanged,
  };
}

describe('三期 Task 3:pressure×exit-watchdog 正交(exit 链永不读 pressure)', () => {
  it('normal 态与 hard 态跑同一退出链:回收目标/preview 豁免/优雅→强杀调用序逐字段完全一致', async () => {
    // updatePressureState 需守卫开(setup.js 全局 '0');两轮同条件跑,唯一变量是 pressure 态
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
    _resetForTest();                                  // 清开关缓存+状态机复位 normal

    // —— 第一轮:normal 态(基线,绝对期望先钉死——防两态同坏时对比恒绿)——
    expect(getPressureState()).toBe('normal');
    const normalObs = await runExitChain();
    expect(normalObs.graceTreeKillPids).toEqual([4242, 4242]); // 优雅段只杀非 preview(SIGTERM 轮+5s 兜底轮)
    expect(normalObs.normalSessionCleared).toBe(true);         // 非 preview 桶收尾(验收锚)
    expect(normalObs.previewProcKept).toBe(true);              // preview 桶原样保留(豁免口径)
    expect(normalObs.previewStatusRunning).toBe(true);
    expect(normalObs.diskLeaseIds).toEqual(['L2']);            // 盘面仅剩 preview 租约
    expect(normalObs.exitCallsBeforeForce).toBe(0);            // 一次触发不主动 exit
    expect(normalObs.forceTreeKillPids).toEqual([4444]);       // 二次触发立即强杀新存活目标
    expect(normalObs.forceSessionCleared).toBe(true);
    expect(normalObs.exitCodes).toEqual([0]);                  // 二次触发 exit(0)
    expect(normalObs.pressureChanged).toBe(false);             // 链不写状态机

    // —— 第二轮:hard 态(低压快照直调推进,0s 宽限)——
    updatePressureState(lowPressureSnap());
    expect(getPressureState()).toBe('hard');
    const hardObs = await runExitChain();

    // 契约核心:hard 态行为观测与 normal 态完全一致(pressure 不改变退出链任何行为)
    expect(hardObs).toEqual(normalObs);
  });

  it('hard 态跑完整退出链后状态机原样仍 hard(exit 链不写 pressure——正交是双向的)', async () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
    _resetForTest();
    updatePressureState(lowPressureSnap());
    expect(getPressureState()).toBe('hard');

    setRunSessionProc('D:/proj-a', makeProc(4242), true);
    mockKillProbe(new Set([4242]));
    handleExitTrigger('SIGINT');
    await vi.advanceTimersByTimeAsync(5_000);
    handleExitTrigger('SIGTERM');                     // 强杀段也跑完

    expect(getPressureState()).toBe('hard');          // 优雅+强杀全程不喂/不改状态机
  });

  it('源码锚:exit-watchdog.ts 不含 pressure 面(防未来往 exit 链加 pressure 分支)', () => {
    const src = readFileSync(join(__dirname, '../../src/core/exit-watchdog.ts'), 'utf8');
    expect(src).not.toMatch(/pressure/i);             // 任何 pressure 相关引用都该过本测试这关
    expect(src).not.toContain("from './memory-guard.js'");   // 不直接依赖 memory-guard(租约释放经 idle-timer 单源)
  });
});
