// test/core/exit-watchdog.test.ts
//
// 内存治理二期 Task 4:退出 watchdog 单测(Playwright setupExitWatchdog 模式)——
// ①stdin close/SIGINT/SIGTERM 第一次触发 → 优雅回收全部非 preview 会话(逐桶
// stopping→kill 链→清桶→game_window 租约出账) ②10s 窗口内二次触发 → 立即强杀
// 全部 + exit(0) ③30s 兜底 exit(0)(优雅回收/退出链卡死也保证退出) ④preview 会话
// 不回收(用户在看的窗口,用户关窗即结束)。
// 补充:空桶触发 no-op/已结束桶不动/setupExitWatchdog 一次性注册(重复调用不叠加
// handler)/优雅段 10s 有限等待升级树杀。
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
  type MemLease,
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

describe('挂点锚:GodotServer.run() 启动注册(源码锚定)', () => {
  it('run() 内调用 setupExitWatchdog(与 startIdleTimer 同区)', () => {
    const src = readFileSync(join(__dirname, '../../src/GodotServer.ts'), 'utf8');
    expect(src).toContain('setupExitWatchdog()');
  });

  it('connectTransport 不注册 stdin 钩子(daemon 纪律守护,daemon 不经 run() 不挂 watchdog)', () => {
    const src = readFileSync(join(__dirname, '../../src/daemon/main.ts'), 'utf8');
    expect(src).not.toContain('setupExitWatchdog');   // daemon 入口不注册
  });
});
