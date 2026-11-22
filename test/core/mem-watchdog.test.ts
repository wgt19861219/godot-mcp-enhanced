// test/core/mem-watchdog.test.ts
//
// mem-watchdog(Task 3)单测——①超杀线触发杀(gut_shard ×2:RSS 17GB 杀/16GB 不杀)
// ②game_window ×3(9.5GB 杀/8GB 不杀) ③editor 同 ×3 ④wasMemKilled 归因(含 10min 过期)
// ⑤guard=0 时 pollOnce 不杀+startWatchdog no-op ⑥树杀调用参数(taskkill /F /T /PID;
// POSIX pkill -P) ⑦采样抛错一轮跳过不崩+连续 3 轮失败退避 30s。
// 补充:KILL_FACTOR 表锁死防漂移/他 server 租约不杀/无读数不判杀/杀前已死仅清租约/
// startWatchdog 幂等/间隔 clamp。
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
// 盘面租约移除」断言走真实 tmp 文件读写。
vi.mock('../../src/core/memory-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/memory-guard.js')>();
  return {
    ...actual,
    sampleRssBytes: vi.fn(actual.sampleRssBytes),
    releaseLease: vi.fn(actual.releaseLease),
  };
});

import { spawn as spawnSpy } from 'child_process';
import {
  KILL_FACTOR,
  startWatchdog,
  stopWatchdog,
  wasMemKilled,
  pollOnce,
  _resetWatchdogForTest,
} from '../../src/core/mem-watchdog.js';
import {
  sampleRssBytes,
  releaseLease,
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  type MemLease,
} from '../../src/core/memory-guard.js';

const IS_WIN = process.platform === 'win32';
const GB = 1024 * 1024 * 1024;

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
  // 意外真采样立即炸测试(watchdog 的采样面已被 mock 顶替;此 runner 兜底防漏网路径)
  _setPsRunnerForTest(() => {
    throw new Error('unexpected real PowerShell spawn');
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-watchdog-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
  vi.mocked(sampleRssBytes).mockResolvedValue({}); // 安全默认:无读数不判杀
  // spawn 顶层纯假:返回带 on() 的假 child,树杀绝不真执行
  vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
  // 杀行 console 一行走 stderr(stdout 是 stdio 模式 JSON-RPC 独占通道)——spy 防刷屏+可断言
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _resetWatchdogForTest();
  vi.useRealTimers();
  _setLeasesFilePathForTest(null);
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('系数表 KILL_FACTOR 锁死(防漂移)', () => {
  it('headless/gut_shard ×2,game_window/editor ×3(设计 §5 单进程杀系数裁定)', () => {
    expect(KILL_FACTOR).toEqual({ headless: 2, gut_shard: 2, game_window: 3, editor: 3 });
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
