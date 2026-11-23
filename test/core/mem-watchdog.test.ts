// test/core/mem-watchdog.test.ts
//
// mem-watchdog(Task 3)单测——①超杀线触发杀(gut_shard ×2:RSS 17GB 杀/16GB 不杀)
// ②game_window ×3(9.5GB 杀/8GB 不杀) ③editor 同 ×3 ④wasMemKilled 归因(含 10min 过期)
// ⑤guard=0 时 pollOnce 不杀+startWatchdog no-op ⑥树杀调用参数(taskkill /F /T /PID;
// POSIX pkill -P) ⑦采样抛错一轮跳过不崩+连续 3 轮失败退避 30s。
// 补充:KILL_FACTOR 表锁死防漂移/他 server 租约不杀/无读数不判杀/杀前已死仅清租约/
// startWatchdog 幂等/间隔 clamp。
// 二期 Task 3:整机硬阈值驱逐——①ratio 降序杀最大者 ②杀一个够即停(force 通道断言)
// ③preview/editor 殿后 ④租约耗尽诚实上报不抛崩 ⑤外部进程不在候选集 + 候选直测。
// 三期:env 豁免×驱逐×单进程硬帽正交——①豁免组剔出候选不杀+耗尽报文附豁免计数
// ②单进程硬帽(KILL_FACTOR)不受驱逐豁免影响照杀(Docker 禁令) ③豁免/editor 并存只杀
// 普通、杀后脱离 hard 即停不越界。
//
// 夹具约定(复制 test/core/memory-guard.test.ts 形态):mkdtemp tmp +
// _setLeasesFilePathForTest 重定向租约文件 + _resetForTest();memory-guard 部分
// mock(importOriginal 保真——sampleRssBytes/releaseLease 可控注入,租约读写落真实
// tmp 夹具断言盘面);child_process 的 spawn 包装为纯假(树杀参数断言⑥,绝不真杀);
// pid 探活 vi.spyOn(process,'kill');fake timers 控制 10s 轮询与 10min 归因过期。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// logger 全模块 mock:降级退避用例断言 MEMGUARD degraded 日志只记一次。
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../../src/core/logger.js', () => ({ getLogger: () => mockLogger }));

// child_process spy 包装(importOriginal 保真):⑥ 断言树杀 spawn 参数;spawnSync 走
// 保真实现——真实采样通道被 _setPsRunnerForTest 注入的 throwing runner 顶替,不真起
// 进程。beforeEach 里再把 spawn 顶层 mockImplementation 为纯假 child({on}),保证
// 任何用例触发的树杀都不会真执行。
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// memory-guard 部分 mock(importOriginal 保真):sampleRssBytes/releaseLease 可控
// (mock 面覆盖 mem-watchdog 的 import);listActiveLeases 等其余导出保真——「杀后
// 盘面租约移除」断言走真实 tmp 文件读写。二期 Task 3 增:getMachineMemorySnapshot
// 进 mock 面(驱逐用例断言 force 通道被调;非 force 分流回真实实现走 psRunner+缓存)。
// actual 引用经 vi.hoisted 提升(vi.mock 工厂提升执行时顶层 const 尚未初始化)。
const actualMemguardRef = vi.hoisted(() => ({
  current: null as typeof import('../../src/core/memory-guard.js') | null,
}));
vi.mock('../../src/core/memory-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/memory-guard.js')>();
  actualMemguardRef.current = actual;
  return {
    ...actual,
    sampleRssBytes: vi.fn(actual.sampleRssBytes),
    releaseLease: vi.fn(actual.releaseLease),
    getMachineMemorySnapshot: vi.fn(actual.getMachineMemorySnapshot),
  };
});

// audit-log 部分 mock(importOriginal 保真):四期 Task 5 起杀事件审计行在 watchdog 内
// fire-and-forget(void appendMachineAuditLine(...).catch(recordAuditWriteFailure))——
// 包一层记录在途 promise,afterEach 等其落定后再清 tmpDir(否则在途 append 与 rmSync
// 竞态:ENOENT 误计审计失败 + 残留 tmp 目录)。真实现直调,落本文件 tmp 的重定向路径。
const auditInflight = vi.hoisted((): Promise<void>[] => []);
vi.mock('../../src/core/audit-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/audit-log.js')>();
  return {
    ...actual,
    appendMachineAuditLine: vi.fn((entry: Omit<AuditEntry, 'timestamp'>) => {
      const p = actual.appendMachineAuditLine(entry);
      auditInflight.push(p.catch(() => {}));
      return p;
    }),
  };
});

import { spawn as spawnSpy } from 'child_process';
import {
  KILL_FACTOR,
  formatMemKillMessage,
  startWatchdog,
  stopWatchdog,
  wasMemKilled,
  pollOnce,
  _resetWatchdogForTest,
} from '../../src/core/mem-watchdog.js';
import {
  sampleRssBytes,
  releaseLease,
  getMachineMemorySnapshot,
  getEvictionCandidates,
  getPressureState,
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  type MemLease,
} from '../../src/core/memory-guard.js';
import {
  getOrCreateSession,
  normalizeProjectKey,
  resetState,
} from '../../src/core/process-state.js';
import type { AuditEntry } from '../../src/core/audit-log.js';

const IS_WIN = process.platform === 'win32';
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024; // 二期 Task 3 驱逐用例的 MB 级读数(ratio 构造用)

let tmpDir: string;
let leasePath: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function makeLease(partial: Partial<MemLease> = {}): MemLease {
  const now = Date.now();
  return {
    id: 'lease-w',
    serverPid: process.pid, // 看门狗只管本 server 的租约
    kind: 'gut_shard',
    declaredMB: 8192,
    projectPath: 'D:/proj',
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

/** 读盘面(验证杀后租约移除/保留落在文件上)。 */
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
  _resetWatchdogForTest();
  _resetForTest();
  // Task 4 起 test/setup.js 全局设 GODOT_MCP_MEMORY_GUARD='0'(其余测试零副作用);
  // 本文件测真实看门狗逻辑(pollOnce/startWatchdog 均查总开关),逐用例显式回归「开」——
  // 关闭态用例(⑤ describe)自行 stubEnv('0') 覆盖。stubEnv 须在 _resetForTest 之后(清缓存后重读)。
  vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
  // 三期起驱逐候选受 GODOT_MCP_WATCHDOG_EXEMPT 影响——显式归零防宿主 env 泄漏污染
  // 既有用例(三期 describe 用例自行 stubEnv 覆盖)。空串 = 无豁免,与未设等价。
  vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', '');
  // 二期 Task 3 起 pollOnce 每轮喂 pressure 状态机(真采样经 psRunner)——runner 给恒健康
  // 快照(空闲 64GB):防真实机器空闲 <1536MB 时既有用例意外进 hard 触发驱逐污染断言;
  // 驱逐用例自行覆盖为低压快照。runner 起的是「不起真 PowerShell 进程」的保险,假值可断言。
  _setPsRunnerForTest((script) => {
    if (script.includes('Win32_OperatingSystem')) {
      return JSON.stringify({
        FreePhysicalMemory: 64 * 1024 * 1024, FreeVirtualMemory: 64 * 1024 * 1024,
        TotalVirtualMemorySize: 64 * 1024 * 1024 * 2,
      });
    }
    return '0';
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-watchdog-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
  // 四期 Task 5 起 kill 路径真写机器级审计行——重定向到本文件 tmp(不触真实 ~/.godot-mcp)
  vi.stubEnv('GODOT_MCP_MACHINE_AUDIT_FILE', path.join(tmpDir, 'machine-audit.jsonl'));
  vi.mocked(sampleRssBytes).mockResolvedValue({}); // 安全默认:无读数不判杀
  // spawn 顶层纯假:返回带 on() 的假 child,树杀绝不真执行
  vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
  // 杀行 console 一行走 stderr(stdout 是 stdio 模式 JSON-RPC 独占通道)——spy 防刷屏+可断言
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  _resetWatchdogForTest();
  resetState(); // 清 process-state 会话桶(Task 3 preview 桥接夹具隔离)
  vi.useRealTimers();
  _setLeasesFilePathForTest(null);
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(auditInflight.splice(0)); // 在途审计行落定后再清 tmpDir(防与 rmSync 竞态)
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('系数表 KILL_FACTOR 锁死(防漂移)', () => {
  it('headless/gut_shard ×2,game_window/editor ×3(设计 §5 单进程杀系数裁定)', () => {
    expect(KILL_FACTOR).toEqual({ headless: 2, gut_shard: 2, game_window: 3, editor: 3 });
  });
});

describe('formatMemKillMessage 归因报文(Task 5 接线消费)', () => {
  it('brief 逐字模板:峰值 GB / 声明MB×系数 / 上调档位指引(kind 大写进 env 名)', () => {
    expect(formatMemKillMessage({ readingBytes: 5 * GB, declaredMB: 1024, kind: 'gut_shard' }))
      .toBe('内存预算超限被看门狗终止: 峰值 5.0 GB / 声明 1024MB×2。若为合法重负载,调 GODOT_MCP_DECLARED_MB_GUT_SHARD 上调档位');
  });

  it('系数按 kind 取表(game_window ×3),峰值 X.Y GB 格式', () => {
    const msg = formatMemKillMessage({ readingBytes: 9.5 * GB, declaredMB: 3072, kind: 'game_window' });
    expect(msg).toContain('峰值 9.5 GB');
    expect(msg).toContain('声明 3072MB×3');
    expect(msg).toContain('GODOT_MCP_DECLARED_MB_GAME_WINDOW');
  });
});

describe('① 超杀线触发杀(gut_shard 声明 8192MB,杀线 8192×2=16GB)', () => {
  it('RSS 17GB > 16GB → 树杀+释放租约+归因+console(stderr)一行', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', kind: 'gut_shard', declaredMB: 8192, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 17 * GB });

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 1 });
    expect(vi.mocked(releaseLease)).toHaveBeenCalledWith('L1');
    expect(readDisk().leases).toHaveLength(0); // 真实现落盘:租约移除
    expect(wasMemKilled(4242)).toMatchObject({ readingBytes: 17 * GB, declaredMB: 8192, kind: 'gut_shard' });
    expect(stderrSpy).toHaveBeenCalledWith('MEMGUARD kill 4242 kind=gut_shard rss=17.0 GB budget=16.0 GB');
  });

  it('RSS 16GB 恰在杀线上(严格大于才杀)→ 不杀,租约保留', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', kind: 'gut_shard', declaredMB: 8192, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 16 * GB });

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 0 });
    expect(readDisk().leases).toHaveLength(1);
    expect(wasMemKilled(4242)).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('② game_window ×3(声明 3072MB,杀线 3×3072MB=9GB)', () => {
  it('RSS 9.5GB > 9GB → 杀;8GB → 不杀', async () => {
    mockKillProbe(new Set([5001, 5002])); // 两笔 pid 都在存活集(否则被当死租约清理)
    writeLeaseFixture([makeLease({ id: 'G1', kind: 'game_window', declaredMB: 3072, pid: 5001 })]);

    vi.mocked(sampleRssBytes).mockResolvedValue({ 5001: 9.5 * GB });
    expect(await pollOnce()).toEqual({ checked: 1, killed: 1 });
    expect(wasMemKilled(5001)).toMatchObject({ readingBytes: 9.5 * GB, declaredMB: 3072, kind: 'game_window' });

    // 第二笔不杀:同系数下 8GB < 9GB
    writeLeaseFixture([makeLease({ id: 'G2', kind: 'game_window', declaredMB: 3072, pid: 5002 })]);
    vi.mocked(sampleRssBytes).mockResolvedValue({ 5002: 8 * GB });
    expect(await pollOnce()).toEqual({ checked: 1, killed: 0 });
    expect(wasMemKilled(5002)).toBeNull();
  });
});

describe('③ editor 同 ×3(声明 4096MB,杀线 12GB)', () => {
  it('RSS 12.5GB > 12GB → 杀;11GB → 不杀', async () => {
    mockKillProbe(new Set([6001, 6002])); // 两笔 pid 都在存活集(否则被当死租约清理)
    writeLeaseFixture([makeLease({ id: 'E1', kind: 'editor', declaredMB: 4096, pid: 6001 })]);

    vi.mocked(sampleRssBytes).mockResolvedValue({ 6001: 12.5 * GB });
    expect(await pollOnce()).toEqual({ checked: 1, killed: 1 });
    expect(wasMemKilled(6001)).toMatchObject({ readingBytes: 12.5 * GB, declaredMB: 4096, kind: 'editor' });

    writeLeaseFixture([makeLease({ id: 'E2', kind: 'editor', declaredMB: 4096, pid: 6002 })]);
    vi.mocked(sampleRssBytes).mockResolvedValue({ 6002: 11 * GB });
    expect(await pollOnce()).toEqual({ checked: 1, killed: 0 });
    expect(wasMemKilled(6002)).toBeNull();
  });
});

describe('④ wasMemKilled 归因', () => {
  it('未涉及 pid 恒 null;命中含 readingBytes/declaredMB/kind;10min 过期后返回 null', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]); // 杀线 2GB
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 5 * GB });
    await pollOnce();

    expect(wasMemKilled(9999)).toBeNull(); // 未涉及
    expect(wasMemKilled(4242)).toMatchObject({ readingBytes: 5 * GB, declaredMB: 1024, kind: 'gut_shard' });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000); // 越过 10min 保留窗
    expect(wasMemKilled(4242)).toBeNull();
  });
});

describe('⑤ guard=0(GODOT_MCP_MEMORY_GUARD=0)', () => {
  it('pollOnce 不杀不采样不动租约;startWatchdog no-op(零轮询)', async () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest(); // 清总开关读缓存
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 100 * GB }); // 若执行必杀

    const r = await pollOnce();
    expect(r).toEqual({ checked: 0, killed: 0 });
    expect(vi.mocked(sampleRssBytes)).not.toHaveBeenCalled();
    expect(readDisk().leases).toHaveLength(1); // 租约不动(未读未清)
    expect(spawnSpy).not.toHaveBeenCalled();

    startWatchdog(); // no-op
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(sampleRssBytes)).not.toHaveBeenCalled(); // 零 interval 轮询
  });
});

describe('⑥ 树杀调用参数(spy spawn)', () => {
  it('Windows: taskkill /F /T /PID <pid>;POSIX: pkill -P <pid>(双平台树杀语义)', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]); // 杀线 2GB
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 5 * GB });

    await pollOnce();
    if (IS_WIN) {
      expect(spawnSpy).toHaveBeenCalledWith(
        'taskkill', ['/F', '/T', '/PID', '4242'], expect.objectContaining({ stdio: 'ignore' }),
      );
    } else {
      expect(spawnSpy).toHaveBeenCalledWith(
        'pkill', ['-P', '4242'], expect.objectContaining({ stdio: 'ignore' }),
      );
    }
    expect(wasMemKilled(4242)).not.toBeNull(); // 树杀后归因在案
  });
});

describe('⑦ 采样降级(抛错/读数全空)', () => {
  it('采样抛错:一轮跳过不崩、不判杀不杀', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('powershell boom'));

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 0 });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(wasMemKilled(4242)).toBeNull();
    expect(readDisk().leases).toHaveLength(1); // 租约不动
  });

  it('读数全空(采样通道失败返回空表)同计降级轮:连续 3 轮后退避并记一次日志', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockResolvedValue({}); // 全空 = 通道降级

    await pollOnce();
    await pollOnce();
    expect(mockLogger.warn).not.toHaveBeenCalled(); // 未达阈值不记
    await pollOnce();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith('mem-watchdog', expect.stringContaining('MEMGUARD degraded'));
  });

  it('连续 3 轮失败(周期驱动):退避 30s 内 tick 跳过,窗口过后恢复轮询且日志不重复', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('ps down'));
    startWatchdog(); // 默认 10s 间隔

    await vi.advanceTimersByTimeAsync(30_000); // tick×3(t=10/20/30)全失败 → t=30 进入退避至 t=60
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000); // t=40/50 两 tick 落在退避窗内 → 跳过
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000); // t=60 越过退避窗 → 恢复第 4 轮(又失败,持续退避)
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(4);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1); // 日志只在首次达阈值记一次
  });

  it('降级后一轮成功(拿到读数)即清零计数:再失败需重新累计 3 轮', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('ps down'));
    await pollOnce();
    await pollOnce(); // 2 轮失败
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 0.5 * GB }); // 第 3 轮成功(读数正常)
    await pollOnce();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('ps down'));
    await pollOnce();
    await pollOnce(); // 计数重新累计 1+2=2,仍未达 3
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('补充:轮询边界语义', () => {
  it('他 server 的租约不在管辖范围:超杀不杀不采样其 pid 判杀路径', async () => {
    writeLeaseFixture([makeLease({ id: 'other', serverPid: 999_999, declaredMB: 1024, pid: 555 })]);
    mockKillProbe(new Set([555]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 555: 5 * GB }); // 若判杀必杀

    const r = await pollOnce();
    expect(r).toEqual({ checked: 0, killed: 0 });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(readDisk().leases).toHaveLength(1); // 他人租约不动
  });

  it('无读数的租约不判杀(防误杀):部分 pid 缺读数时仅判有读数者', async () => {
    writeLeaseFixture([
      makeLease({ id: 'a', declaredMB: 1024, pid: 111 }),
      makeLease({ id: 'b', declaredMB: 1024, pid: 222 }),
    ]);
    mockKillProbe(new Set([111, 222]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 111: 0.5 * GB }); // 222 无读数(刚退出)

    const r = await pollOnce();
    expect(r).toEqual({ checked: 2, killed: 0 });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('杀前探活已死(进程自己退出)→ 仅清租约:不树杀、不记归因、不算 killed', async () => {
    writeLeaseFixture([makeLease({ id: 'dead', declaredMB: 1024, pid: 333 })]);
    const alive = new Set([333]); // 阶段一探活(listActiveLeases)时活
    mockKillProbe(alive);
    vi.mocked(sampleRssBytes).mockImplementation(async () => {
      alive.delete(333); // 模拟采样窗口内进程自己退出(杀前再探即死)
      return { 333: 5 * GB };
    });

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 0 });
    expect(vi.mocked(releaseLease)).toHaveBeenCalledWith('dead'); // 租约清了
    expect(readDisk().leases).toHaveLength(0);
    expect(spawnSpy).not.toHaveBeenCalled(); // 没树杀
    expect(wasMemKilled(333)).toBeNull(); // 不记归因(不是看门狗杀的)
  });

  it('startWatchdog 幂等(二次调用不叠加 timer),默认 10s 间隔驱动轮询', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));
    startWatchdog();
    startWatchdog(); // 幂等

    await vi.advanceTimersByTimeAsync(35_000); // t=10/20/30 共 3 次 tick(若叠加 timer 会 ×2)
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(3);

    stopWatchdog();
    await vi.advanceTimersByTimeAsync(30_000); // 停后零 tick
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(3);
  });

  it('间隔 clamp:GODOT_MCP_MEM_POLL_SECONDS=1 → 下限 5s;=7200 → 上限 3600s', async () => {
    writeLeaseFixture([makeLease({ id: 'L1', declaredMB: 1024, pid: 4242 })]);
    mockKillProbe(new Set([4242]));

    vi.stubEnv('GODOT_MCP_MEM_POLL_SECONDS', '1'); // 低于下限 → clamp 5
    startWatchdog();
    await vi.advanceTimersByTimeAsync(5_000); // 若未 clamp(1s 间隔)会有 5 次 tick
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(1);
    stopWatchdog();

    vi.mocked(sampleRssBytes).mockClear();
    vi.stubEnv('GODOT_MCP_MEM_POLL_SECONDS', '7200'); // 超上限 → clamp 3600
    startWatchdog();
    await vi.advanceTimersByTimeAsync(3_600_000); // 恰 1 次 tick
    expect(vi.mocked(sampleRssBytes)).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 二期 Task 3:整机硬阈值驱逐——硬阈值默认 1536MB(0s 宽限跌破即进)、minimum-reclaim
// 2GB(脱离线=硬阈值+2048MB,同是驱逐停止线)、排序=实测÷声明降序、preview/editor 殿后。
// 快照通道注入:watchdog 单进程杀走 mock 的 sampleRssBytes,驱逐候选 ratio 走 memory-guard
// 内部 psRunner 通道(sampleRssBytesCached 不经导出 mock 面)——两通道分离各自可控。
// 依赖 psRunner 的用例同 memory-guard.test.ts 惯例 Windows-only(skipIf(!IS_WIN)):
// 非 Windows 引擎级无 PowerShell 采样通道(快照 commit/RSS 恒降级空),驱逐排序无读数可依。
// ===========================================================================

/** Task 3:快照/RSS 候选双通道 psRunner mock(照搬 memory-guard.test.ts mockMachinePs 形态)。
 *  freePhysMB 控制机器快照(pollOnce 首行非 force 喂状态机:低于 1536 → hard);
 *  rss 喂驱逐候选的实测读数(ratio=实测÷声明)。commit 字段缺席 → 降级 null 只看物理口径。 */
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

/** force 快照序列注入:mock getMachineMemorySnapshot 的 force 分支按序消费(耗尽续用
 *  末值),非 force 分流回真实实现(走 psRunner+10s 缓存)——驱逐循环「杀一个重采样」
 *  的新鲜读数由本序列驱动,杀后翻恢复态即验证「即停不全杀」。 */
function mockForceSnapshots(seqMB: number[]): void {
  const queue = [...seqMB];
  vi.mocked(getMachineMemorySnapshot).mockImplementation(((opts?: { force?: boolean }) => {
    if (opts?.force) {
      const mb = queue.length > 0 ? queue.shift()! : seqMB[seqMB.length - 1];
      return {
        freePhysBytes: mb * 1024 * 1024,
        totalPhysBytes: os.totalmem(),
        commitAvailBytes: null, commitTotalBytes: null,
        godotProcCount: 0, sampledAt: Date.now(),
      };
    }
    return actualMemguardRef.current!.getMachineMemorySnapshot();
  }) as typeof getMachineMemorySnapshot);
}

/** preview 会话桶夹具:memory-guard 桥接按 normalizeProjectKey 归一查桶,建桶用同键
 *  (run_project 建桶链走 setRunSessionProc 的同款归一;afterEach resetState 清)。 */
function makePreviewSession(projectPath: string): void {
  getOrCreateSession(normalizeProjectKey(projectPath)).preview = true;
}

describe('二期 Task 3:整机硬阈值驱逐', () => {
  it.skipIf(!IS_WIN)('① 硬阈值触发:按实测÷声明 ratio 降序杀最大者(A 1.86 先于 B 1.46),B 存活', async () => {
    writeLeaseFixture([
      makeLease({ id: 'A', kind: 'headless', declaredMB: 1024, pid: 1001 }),
      makeLease({ id: 'B', kind: 'gut_shard', declaredMB: 8192, pid: 1002 }),
    ]);
    mockKillProbe(new Set([1001, 1002]));
    const rss = { 1001: 1900 * MB, 1002: 12 * GB }; // ratio 1.856 / 1.465,均低于各自杀线(2048MB/16GB)→ 单进程杀零杀
    vi.mocked(sampleRssBytes).mockResolvedValue(rss);
    mockMachinePsForEvict({ freePhysMB: 1000, rss }); // 机器空闲 1000MB < 1536 → pollOnce 首行进 hard
    mockForceSnapshots([1000, 6000]); // force:仍低压(杀 A)→ 6000MB ≥ 3584(脱离+2GB,停)

    const r = await pollOnce();
    expect(r).toEqual({ checked: 2, killed: 1 });
    expect(wasMemKilled(1001)).toMatchObject({ readingBytes: 1900 * MB, declaredMB: 1024, kind: 'headless' }); // ratio 最大者被杀
    expect(wasMemKilled(1002)).toBeNull(); // ratio 次之的 B 存活——降序只杀最大者
    expect(readDisk().leases.map((l) => l.id)).toEqual(['B']);
    expect(vi.mocked(releaseLease)).toHaveBeenCalledWith('A');
    expect(getPressureState()).toBe('pressure'); // 杀到脱离硬阈值+2GB → 降 pressure(拒新保旧)
  });

  it.skipIf(!IS_WIN)('② 杀一个够即停:force 重采样脱离+2GB 即停不全杀(断言 force 通道被调)', async () => {
    writeLeaseFixture([
      makeLease({ id: 'A', kind: 'headless', declaredMB: 2048, pid: 1001 }),
      makeLease({ id: 'B', kind: 'headless', declaredMB: 2048, pid: 1002 }),
      makeLease({ id: 'C', kind: 'headless', declaredMB: 2048, pid: 1003 }),
    ]);
    mockKillProbe(new Set([1001, 1002, 1003]));
    const rss = { 1001: 3072 * MB, 1002: 2048 * MB, 1003: 1024 * MB }; // ratio 1.5/1.0/0.5,均低于杀线 4096MB
    vi.mocked(sampleRssBytes).mockResolvedValue(rss);
    mockMachinePsForEvict({ freePhysMB: 1000, rss });
    mockForceSnapshots([1000, 6000]); // 杀 A(ratio 最大)后 force 采到恢复 → 停,B/C 不杀

    const r = await pollOnce();
    expect(r).toEqual({ checked: 3, killed: 1 }); // 只杀 A 一个(杀一个够即停)
    expect(wasMemKilled(1001)).not.toBeNull();
    expect(wasMemKilled(1002)).toBeNull();
    expect(wasMemKilled(1003)).toBeNull();
    expect(readDisk().leases.map((l) => l.id).sort()).toEqual(['B', 'C']);
    // 行为断言:驱逐循环采样新鲜度走 force 通道(10s 缓存会让「杀一个重采样」读旧值反复多杀,审查二期)
    expect(vi.mocked(getMachineMemorySnapshot)).toHaveBeenCalledWith({ force: true });
  });

  it.skipIf(!IS_WIN)('③ preview/editor 排最后:ratio 更高的 preview(2.0)与 editor(1.95)不先杀,先杀普通 N(1.25)', async () => {
    writeLeaseFixture([
      makeLease({ id: 'P', kind: 'game_window', declaredMB: 1024, pid: 3001, projectPath: 'D:/proj-prev' }),
      makeLease({ id: 'E', kind: 'editor', declaredMB: 4096, pid: 3002 }),
      makeLease({ id: 'N', kind: 'headless', declaredMB: 2048, pid: 3003 }),
    ]);
    makePreviewSession('D:/proj-prev'); // P 的会话桶 preview=true(用户在看的窗口)
    mockKillProbe(new Set([3001, 3002, 3003]));
    const rss = { 3001: 2048 * MB, 3002: 8 * GB, 3003: 2560 * MB }; // ratio 2.0/1.95/1.25,均低于各自杀线(3072MB/12GB/4096MB)
    vi.mocked(sampleRssBytes).mockResolvedValue(rss);
    mockMachinePsForEvict({ freePhysMB: 1000, rss });
    mockForceSnapshots([1000, 6000]); // 杀 N(唯一非豁免)后恢复 → 停,P/E 不杀

    const r = await pollOnce();
    expect(r).toEqual({ checked: 3, killed: 1 });
    expect(wasMemKilled(3003)).not.toBeNull(); // 普通租约 N 先杀(尽管 ratio 三者最低)
    expect(wasMemKilled(3001)).toBeNull(); // ratio 最高的 preview P 不先杀(豁免殿后)
    expect(wasMemKilled(3002)).toBeNull(); // editor E 不先杀
    expect(readDisk().leases.map((l) => l.id).sort()).toEqual(['E', 'P']);
  });

  it.skipIf(!IS_WIN)('④ 租约耗尽仍低压:诚实上报「已无本 server 可驱逐进程」不抛崩,状态诚实保持 hard', async () => {
    writeLeaseFixture([makeLease({ id: 'A', kind: 'headless', declaredMB: 1024, pid: 1001 })]);
    mockKillProbe(new Set([1001]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 1001: 1500 * MB }); // ratio 1.46 < 杀线 2048MB,单进程杀零杀
    mockMachinePsForEvict({ freePhysMB: 1000, rss: { 1001: 1500 * MB } });
    mockForceSnapshots([1000]); // force 恒低压(外部占用,杀光候选也不恢复)

    const r = await pollOnce(); // 租约耗尽 → 诚实日志 → break,不抛崩
    expect(r).toEqual({ checked: 1, killed: 1 }); // 候选照杀(能回收一点是一点)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已无本 server 可驱逐进程'));
    expect(getPressureState()).toBe('hard'); // 仍处硬阈值区——不假装修复(外部占用需人工处理)
  });

  it.skipIf(!IS_WIN)('⑤ 外部进程不在候选集:本 server 无租约(仅他 server 租约在盘)→ 不杀任何进程,诚实上报', async () => {
    writeLeaseFixture([makeLease({ id: 'other', serverPid: 999_999, declaredMB: 1024, pid: 555 })]);
    mockKillProbe(new Set([555])); // 他 server 租约的进程活着(但不在本 server 管辖)
    mockMachinePsForEvict({ freePhysMB: 1000, rss: { 555: 5 * GB } }); // 若误进候选必被杀
    mockForceSnapshots([1000]); // 恒低压

    const r = await pollOnce();
    expect(r).toEqual({ checked: 0, killed: 0 });
    expect(spawnSpy).not.toHaveBeenCalled(); // 无租约 pid(用户手开的外部进程)永不杀
    expect(readDisk().leases).toHaveLength(1); // 他人租约不动
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已无本 server 可驱逐进程'));
  });

  it.skipIf(!IS_WIN)('补充:getEvictionCandidates——pid 未绑不进候选;非豁免组在前,preview/editor 殿后(组内仍 ratio 降序)', () => {
    writeLeaseFixture([
      makeLease({ id: 'unbound', pid: null }), // pid 未绑(无法树杀):不进候选
      makeLease({ id: 'N', kind: 'headless', declaredMB: 2048, pid: 3004 }),
      makeLease({ id: 'E', kind: 'editor', declaredMB: 4096, pid: 3005 }),
      makeLease({ id: 'P', kind: 'game_window', declaredMB: 1024, pid: 3006, projectPath: 'D:/proj-prev' }),
    ]);
    makePreviewSession('D:/proj-prev');
    mockKillProbe(new Set([3004, 3005, 3006]));
    mockMachinePsForEvict({ freePhysMB: 65536, rss: { 3004: 1536 * MB, 3005: 6 * GB, 3006: 2048 * MB } });

    // 三期签名迁移:返回 { candidates, envExempted }(beforeEach 已把 env 归零——豁免计数恒零)
    const { candidates, envExempted } = getEvictionCandidates();
    expect(candidates.map((c) => c.lease.id)).toEqual(['N', 'P', 'E']); // 非豁免 N(0.75)在前;豁免组内 P(2.0)>E(1.5)
    expect(envExempted).toEqual({ preview: 0, editor: 0 });
    expect(candidates[0].ratio).toBeCloseTo(0.75, 5);
    expect(candidates[1].ratio).toBeCloseTo(2.0, 5);
    expect(candidates[2].ratio).toBeCloseTo(1.5, 5);
  });
});

// ===========================================================================
// 三期:env 豁免×驱逐×单进程硬帽正交——GODOT_MCP_WATCHDOG_EXEMPT 命中组剔出驱逐
// 候选(memory-guard 单点过滤);单进程硬帽(pollOnce 杀循环,123-130 行)零改动照杀
// (Docker 反模式禁令:无上限豁免被禁止);耗尽报文附豁免计数归因。
// ===========================================================================

describe('三期:env 豁免×驱逐×单进程硬帽正交', () => {
  it.skipIf(!IS_WIN)('① env=editor + hard 态 + 仅 editor 存活:驱逐候选被剔光不杀,耗尽报文附豁免计数', async () => {
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'editor');
    writeLeaseFixture([makeLease({ id: 'E', kind: 'editor', declaredMB: 4096, pid: 6001 })]);
    mockKillProbe(new Set([6001]));
    const rss = { 6001: 8 * GB }; // ratio 1.95 高(若非豁免必被驱逐),但 < editor 杀线 12GB → 单进程杀零杀
    vi.mocked(sampleRssBytes).mockResolvedValue(rss);
    mockMachinePsForEvict({ freePhysMB: 1000, rss }); // 机器空闲 1000MB < 1536 → pollOnce 首行进 hard
    mockForceSnapshots([1000]); // force 恒低压(模拟外部占用)→ 驱逐循环每轮仍 hard → 候选耗尽

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 0 }); // editor 被 env 豁免:驱逐循环零杀
    expect(spawnSpy).not.toHaveBeenCalled(); // 未树杀
    expect(wasMemKilled(6001)).toBeNull();
    expect(readDisk().leases.map((l) => l.id)).toEqual(['E']); // 租约保留(不是看门狗杀的)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已无本 server 可驱逐进程'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('被 GODOT_MCP_WATCHDOG_EXEMPT 豁免'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('editor 1')); // 豁免笔数归因
    expect(getPressureState()).toBe('hard'); // 诚实保持 hard(不假装修复)
  });

  it('② env=editor + editor RSS 超声明×3 → pollOnce 单进程杀路径照杀(硬帽不受驱逐豁免影响)', async () => {
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'editor');
    writeLeaseFixture([makeLease({ id: 'E', kind: 'editor', declaredMB: 4096, pid: 6001 })]);
    mockKillProbe(new Set([6001]));
    vi.mocked(sampleRssBytes).mockResolvedValue({ 6001: 12.5 * GB }); // > editor 杀线 12GB(4096MB×3)
    // 机器快照走 beforeEach 默认恒健康(64GB 空闲)→ normal 不进驱逐——纯测单进程杀路径

    const r = await pollOnce();
    expect(r).toEqual({ checked: 1, killed: 1 }); // 单进程杀循环(pollOnce 内)零改动,豁免不救硬帽
    expect(spawnSpy).toHaveBeenCalledTimes(1); // killPidTree 树杀被调
    expect(wasMemKilled(6001)).toMatchObject({ readingBytes: 12.5 * GB, declaredMB: 4096, kind: 'editor' }); // 归因在案
    expect(readDisk().leases).toHaveLength(0); // 租约释放
  });

  it.skipIf(!IS_WIN)('③ env=editor + hard 态 + headless/editor 并存:驱逐只杀 headless,杀后脱离 hard 即停(未越界杀 editor)', async () => {
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'editor');
    writeLeaseFixture([
      makeLease({ id: 'N', kind: 'headless', declaredMB: 2048, pid: 1001 }),
      makeLease({ id: 'E', kind: 'editor', declaredMB: 4096, pid: 1002 }),
    ]);
    mockKillProbe(new Set([1001, 1002]));
    const rss = { 1001: 3072 * MB, 1002: 8 * GB }; // N ratio 1.5(< 杀线 4096MB 不触单进程杀);E ratio 1.95 被豁免剔出候选
    vi.mocked(sampleRssBytes).mockResolvedValue(rss);
    mockMachinePsForEvict({ freePhysMB: 1000, rss });
    mockForceSnapshots([1000, 6000]); // 杀 N 后 force 采到恢复(≥3584MB)→ 即停

    const r = await pollOnce();
    expect(r).toEqual({ checked: 2, killed: 1 }); // 只驱逐杀 N
    expect(wasMemKilled(1001)).not.toBeNull();
    expect(wasMemKilled(1002)).toBeNull(); // editor 未被越界杀(env 豁免生效)
    expect(readDisk().leases.map((l) => l.id)).toEqual(['E']);
    expect(getPressureState()).toBe('pressure'); // 脱离 hard 即停
  });
});
