// test/core/session-idle-timer.test.ts
//
// 内存治理二期 Task 1:会话空闲回收 IdleTimer 单测——①超 15min 未 poke 且
// preview:false → 树杀+清桶+释放 game_window 租约 ②poke 重置计时(bridge 交互续命)
// ③preview:true 会话超时不动(含 preview 落桶数据源锚——run_project 建桶处真实写值,
// 源码锚定) ④env=0 关(timer 不启动+扫描直接跳过) ⑤杀日志含 MEMGUARD idle-reap 可 grep。
// 补充:恰在阈值不收(严格大于)/已结束桶不动/poke 不存在桶 no-op/60s 周期驱动/
// startIdleTimer 幂等。
// 三期 Task 3:IdleTimer×驱逐循环双路回收幂等(终审 Minor-5)——同一会话先驱逐杀再
// idle 扫(死进程感知跳过,无二次树杀)/先 idle 回收再驱逐循环(候选空 no-op),
// 双向不炸、会话桶与租约账本终态一致(二期靠「releaseLease 幂等双路不冲突」注释论证)。
//
// 夹具约定(复制 test/core/mem-watchdog.test.ts 形态):mkdtemp tmp +
// _setLeasesFilePathForTest 重定向租约文件 + _resetForTest;child_process 的 spawn
// 包装为纯假(树杀参数断言,绝不真杀);pid 探活 vi.spyOn(process,'kill');fake timers
// 控制空闲钟(Date)与 60s 扫描周期。会话桶用 process-state 真实 API 建桶
// (setRunSessionProc + makeProc 假进程),preview/lastPokeAt 的生产侧落值在
// runtime.ts/bridge-client.ts,以源码锚定断言覆盖(③)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'child_process';

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
  pokeRunSession,
} from '../../src/core/process-state.js';
import {
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  getEvictionCandidates,
  type MemLease,
} from '../../src/core/memory-guard.js';
import { pollOnce, wasMemKilled, _resetWatchdogForTest } from '../../src/core/mem-watchdog.js';
import {
  scanIdleSessions,
  startIdleTimer,
  stopIdleTimer,
} from '../../src/core/session-idle-timer.js';

const IS_WIN = process.platform === 'win32';
const MIN = 60_000;

let tmpDir: string;
let leasePath: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** 假 ChildProcess:仅含扫描判活与建桶所需字段(killed/exitCode/pid)+ 事件桩。 */
function makeProc(pid: number): ChildProcess {
  return { pid, killed: false, exitCode: null, on: vi.fn(), kill: vi.fn() } as unknown as ChildProcess;
}

function makeLease(partial: Partial<MemLease> = {}): MemLease {
  const now = Date.now();
  return {
    id: 'lease-idle',
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetState();            // process-state 会话桶隔离
  _resetForTest();         // memory-guard 状态隔离(env 开关缓存/租约序号)
  // 意外真采样立即炸测试(listActiveLeases 只探活不采样,此 runner 兜底防漏网路径)
  _setPsRunnerForTest(() => {
    throw new Error('unexpected real PowerShell spawn');
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-timer-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
  // spawn 顶层纯假:返回带 on() 的假 child,树杀绝不真执行
  vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
  // 回收行 console 一路走 stderr(stdout 是 stdio 模式 JSON-RPC 独占通道,mem-watchdog
  // kill 行同通道)——spy 防刷屏+可断言
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetState();
  stopIdleTimer();
  vi.useRealTimers();
  _setLeasesFilePathForTest(null);
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('① 超 15min 未 poke 且 preview:false → 树杀+清桶+释放租约', () => {
  it('16min 无交互:树杀(taskkill /F /T /PID)、会话桶清干净、game_window 租约出账', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);   // 建桶 running,lastPokeAt=建桶时刻(spawn 不算交互)
    writeLeaseFixture([makeLease({ id: 'L1', pid: 4242 })]);
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 16 * MIN);      // 16min 无 bridge 交互
    expect(scanIdleSessions()).toEqual({ reaped: 1 });

    if (IS_WIN) {
      expect(spawnSpy).toHaveBeenCalledWith(
        'taskkill', ['/F', '/T', '/PID', '4242'], expect.objectContaining({ stdio: 'ignore' }),
      );
    } else {
      expect(spawnSpy).toHaveBeenCalledWith(
        'pkill', ['-P', '4242'], expect.objectContaining({ stdio: 'ignore' }),
      );
    }
    const s = getSession('D:/proj-a');
    expect(s?.proc).toBeNull();                   // 会话桶清干净(验收锚)
    expect(s?.status).toBe('exited');
    expect(readDisk().leases).toHaveLength(0);    // 租约不挂账(验收锚)
  });

  it('租约释放按项目路径反查:其他项目的 game_window 租约不受牵连', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    writeLeaseFixture([
      makeLease({ id: 'L1', pid: 4242 }),
      makeLease({ id: 'L-other', pid: 5001, projectPath: 'D:/proj-b' }),
    ]);
    mockKillProbe(new Set([4242, 5001]));

    vi.setSystemTime(Date.now() + 16 * MIN);
    expect(scanIdleSessions()).toEqual({ reaped: 1 });
    const remaining = readDisk().leases;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('L-other');
  });
});

describe('② poke 重置计时(bridge 交互续命)', () => {
  it('16min 时来一次交互 → 立即扫描不收;再过 15min+1s 无交互 → 收', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 16 * MIN);
    pokeRunSession('D:/proj-a');                  // 交互到达,空闲钟重置
    expect(scanIdleSessions()).toEqual({ reaped: 0 });
    expect(getSession('D:/proj-a')?.proc).toBe(proc);   // 会话原样保留

    vi.advanceTimersByTime(15 * MIN + 1_000);     // 距上次 poke 又过 15min+(fake 时钟随之推进)
    expect(scanIdleSessions()).toEqual({ reaped: 1 });
  });

  it('pokeRunSession 对不存在的桶 no-op(不建桶不炸)', () => {
    expect(() => pokeRunSession('D:/nowhere')).not.toThrow();
    expect(getSession('D:/nowhere')).toBeUndefined();   // 读路径不得建桶
  });
});

describe('③ preview:true 会话超时不动(preview 字段数据源锚)', () => {
  it('1h 无交互也不收:preview 是用户在看的窗口,IdleTimer 豁免', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    getSession('D:/proj-a')!.preview = true;      // run_project 建桶处落的值(数据源锚见下)
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 60 * MIN);
    expect(scanIdleSessions()).toEqual({ reaped: 0 });
    expect(getSession('D:/proj-a')?.proc).toBe(proc);   // 原样不动
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('数据源锚:run_project 建桶处真实写 preview 进会话桶(源码锚定,防字段成摆设)', () => {
    const src = readFileSync(join(__dirname, '../../src/tools/runtime.ts'), 'utf-8');
    expect(src).toMatch(/\.preview\s*=\s*preview/);
  });

  it('挂点锚:bridge sendToBridge 成功路径调 pokeRunSession(源码锚定,一处覆盖三类交互)', () => {
    const src = readFileSync(join(__dirname, '../../src/core/bridge-client.ts'), 'utf-8');
    expect(src).toContain('pokeRunSession(');
  });
});

describe('④ GODOT_MCP_SESSION_IDLE_MINUTES=0 → 关', () => {
  it('扫描直接跳过(超时会话不动);startIdleTimer no-op(零周期 tick)', async () => {
    vi.stubEnv('GODOT_MCP_SESSION_IDLE_MINUTES', '0');
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 60 * MIN);
    expect(scanIdleSessions()).toEqual({ reaped: 0 });
    expect(getSession('D:/proj-a')?.proc).toBe(proc);

    startIdleTimer();                             // env=0 → no-op,timer 不启动
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawnSpy).not.toHaveBeenCalled();      // 零 interval tick
  });
});

describe('⑤ 杀日志含 MEMGUARD idle-reap(可 grep)', () => {
  it('回收时 stderr 一行:MEMGUARD idle-reap <pid> + idle 秒数 + 项目路径', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));
    vi.setSystemTime(Date.now() + 16 * MIN);

    scanIdleSessions();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/MEMGUARD idle-reap 4242 idle=\d+s/));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('D:/proj-a'));
  });
});

describe('补充:边界语义', () => {
  it('恰在阈值(15min 整)不收——严格大于才收', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 15 * MIN);      // now - lastPokeAt 恰等于阈值
    expect(scanIdleSessions()).toEqual({ reaped: 0 });
    expect(getSession('D:/proj-a')?.proc).toBe(proc);
  });

  it('已结束桶(exited)即使超时也不动——回收只针对存活会话', () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    setSessionStatus('D:/proj-a', 'exited');      // 游戏已退出,桶保留可查
    mockKillProbe(new Set([4242]));

    vi.setSystemTime(Date.now() + 60 * MIN);
    expect(scanIdleSessions()).toEqual({ reaped: 0 });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('60s 周期驱动:startIdleTimer 后 timer 驱动扫描(建桶 16min+ 后被回收)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    startIdleTimer();
    await vi.advanceTimersByTimeAsync(16 * MIN + 61_000);   // 某 60s tick 必命中超时
    expect(getSession('D:/proj-a')?.proc).toBeNull();
  });

  it('startIdleTimer 幂等(二次调用不叠加 timer,回收只发生一次)', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    mockKillProbe(new Set([4242]));

    startIdleTimer();
    startIdleTimer();
    await vi.advanceTimersByTimeAsync(16 * MIN + 61_000);
    const reapCalls = vi.mocked(stderrSpy).mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('MEMGUARD idle-reap'),
    );
    expect(reapCalls).toHaveLength(1);
  });
});

// ===========================================================================
// 三期 Task 3:IdleTimer×驱逐循环双路回收幂等(终审 Minor-5)——二期靠
// session-idle-timer.ts 头注释「releaseLease 幂等,双路不冲突」论证,本 describe 用
// 双向时序钉行为:驱逐先杀(树杀一次+账本清)→ idle 再扫感知死进程跳过;idle 先回收
// (树杀+清桶+账本清)→ 驱逐循环候选空 no-op。两侧守卫各在消费方:IdleTimer 侧是
// 无活进程判据(proc.exitCode/killed,同 getActiveRunPids——驱逐树杀后 close 事件把
// exitCode 置值,扫描即跳过);驱逐侧是 killForEviction 杀前探活 dead → 仅清租约不杀。
// 夹具照搬 mem-watchdog.test.ts 驱逐 describe 惯例(psRunner 双通道 mock +
// it.skipIf(!IS_WIN)——非 Windows 无 PowerShell 采样通道,快照不可控进不了 hard)。
// ===========================================================================

const MB = 1024 * 1024;

/** 从 spawn 调用记录统计对目标 pid 的树杀命令次数(taskkill /F /T /PID <pid> 与
 *  pkill -P <pid> 双平台形态)。 */
function treeKillCount(pid: number): number {
  return vi.mocked(spawnSpy).mock.calls.filter((call) => {
    const cmd = call[0] as string;
    const args = (call[1] ?? []) as readonly string[];
    return (cmd === 'taskkill' || cmd === 'pkill') && args.includes(String(pid));
  }).length;
}

/** 快照/RSS 候选双通道 psRunner mock(照搬 mem-watchdog.test.ts mockMachinePsForEvict
 *  形态):freePhysMB 控制机器快照(低压 <1536MB → pollOnce 首行进 hard);rss 喂驱逐
 *  候选的实测读数。commit 字段缺席 → 降级 null 只看物理口径。 */
function mockMachinePsForEvict(fields: { freePhysMB?: number; rss?: Record<number, number> }): void {
  _setPsRunnerForTest((script) => {
    if (script.includes('Win32_OperatingSystem')) {
      const j: Record<string, number> = { TotalVirtualMemorySize: 64 * 1024 * 1024 };
      if (fields.freePhysMB !== undefined) j.FreePhysicalMemory = Math.round(fields.freePhysMB * 1024);
      return JSON.stringify(j);
    }
    if (script.includes('Win32_Process')) {
      return JSON.stringify(
        Object.entries(fields.rss ?? {}).map(([pid, bytes]) => ({ ProcessId: Number(pid), WorkingSetSize: bytes })),
      );
    }
    return '0'; // Godot 计数通道(驱逐路径不消费)
  });
}

describe('三期 Task 3:IdleTimer×驱逐循环双路回收幂等(同一会话双向时序)', () => {
  beforeEach(() => {
    // pollOnce/pressure 状态机需守卫开(setup.js 全局 '0');驱逐候选受 WATCHDOG_EXEMPT
    // 影响,显式归零防宿主 env 泄漏(两测试文件既有惯例)。归因记录隔离(wasMemKilled 跨用例)。
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', '');
    _resetWatchdogForTest();
  });

  it.skipIf(!IS_WIN)('正向序:驱逐先杀(树杀一次+账本清)→ idle 再扫感知死进程跳过——无二次树杀、桶/账本终态一致、不抛异常', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    writeLeaseFixture([makeLease({ id: 'L1', pid: 4242 })]);   // game_window 声明 3072MB(杀线 9GB)
    const alive = new Set([4242]);
    mockKillProbe(alive);
    // RSS 4GB < 杀线 9GB(单进程杀零杀),ratio 1.33 进驱逐候选;机器空闲 1000MB < 1536 → 进 hard
    mockMachinePsForEvict({ freePhysMB: 1000, rss: { 4242: 4096 * MB } });

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 1 });    // 驱逐路径杀掉:releaseLease+树杀记一次
    expect(treeKillCount(4242)).toBe(1);             // 树杀恰一次
    expect(wasMemKilled(4242)).not.toBeNull();       // 归因在案(驱逐侧杀的)
    expect(readDisk().leases).toHaveLength(0);       // 账本已清

    // 模拟驱逐树杀生效的进程级后果:close 事件已派发(exitCode 置值)+进程亡——这正是
    // IdleTimer 侧死进程感知判据(proc.exitCode/killed)的数据源
    proc.exitCode = 1;
    alive.delete(4242);
    vi.mocked(spawnSpy).mockClear();

    vi.setSystemTime(Date.now() + 16 * MIN);         // 空闲超阈值(若不跳过必再杀)
    let reaped: { reaped: number } | undefined;
    expect(() => { reaped = scanIdleSessions(); }).not.toThrow();   // 无异常抛出
    expect(reaped).toEqual({ reaped: 0 });           // 死进程感知跳过:零回收

    expect(vi.mocked(spawnSpy).mock.calls).toHaveLength(0);         // 无二次树杀(核心契约)
    expect(readDisk().leases).toHaveLength(0);       // 账本终态保持(idle 路径零重复动作)
    expect(getSession('D:/proj-a')?.proc).toBe(proc);               // 桶原样(idle 未二次触碰,桶收尾归 close 回调链)
    expect(scanIdleSessions()).toEqual({ reaped: 0 });              // 重复扫描仍幂等 no-op
  });

  it.skipIf(!IS_WIN)('反向序:idle 先回收(树杀+清桶+账本清)→ 驱逐循环再进:候选空 no-op 不炸、无二次树杀', async () => {
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    writeLeaseFixture([makeLease({ id: 'L1', pid: 4242 })]);
    const alive = new Set([4242]);
    mockKillProbe(alive);

    vi.setSystemTime(Date.now() + 16 * MIN);
    expect(scanIdleSessions()).toEqual({ reaped: 1 });            // idle 回收:树杀+清桶+租约出账
    expect(treeKillCount(4242)).toBe(1);                          // 树杀恰一次
    const s = getSession('D:/proj-a');
    expect(s?.proc).toBeNull();                                   // 桶清干净(验收锚)
    expect(s?.status).toBe('exited');
    expect(readDisk().leases).toHaveLength(0);                    // 账本已清

    // 模拟树杀生效:进程亡;再进 hard(账本已空,无 pid 可采)走驱逐循环
    alive.delete(4242);
    vi.mocked(spawnSpy).mockClear();
    mockMachinePsForEvict({ freePhysMB: 1000, rss: {} });

    const r = await pollOnce();                                   // 驱逐循环:候选空 → 诚实上报 break
    expect(r).toEqual({ checked: 0, killed: 0 });
    expect(vi.mocked(spawnSpy).mock.calls).toHaveLength(0);       // 无二次树杀
    // Task 1 新签名直证:该租约已不在驱逐候选(候选空+豁免计数零)
    const { candidates, envExempted } = getEvictionCandidates();
    expect(candidates).toEqual([]);
    expect(envExempted).toEqual({ preview: 0, editor: 0 });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已无本 server 可驱逐进程'));
  });
});
