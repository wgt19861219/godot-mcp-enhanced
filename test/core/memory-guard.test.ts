// test/core/memory-guard.test.ts
//
// memory-guard 核心(Task 1)单测——①档位表默认值+env 覆盖 ②总开关三态 ③租约清理三规则
// ④writeFileAtomic 原子写 ⑤快照缓存 ⑥PowerShell 失败降级 ⑦ensureDir 目录自建
// ⑧fail-open(读失败返 []/写失败降级日志) + 补充(租约生命周期/RSS 采样)
// + ⑫二期 Task 2 整机软阈值 pressure 状态机(拒新保旧+上报,fake timers 推进多轮)
// + ⑭三期 WATCHDOG_EXEMPT 驱逐候选过滤(env 豁免整组剔出候选,与殿后排序正交)
// + ⑬⑦三期 Task 2 面板可见性:watchdogExempt 字段(固定序 preview→editor,guard=0 照出)。
//
// 测试注入约定:PowerShell 执行器经 _setPsRunnerForTest 注入 fake(不真起 PowerShell);
// 租约文件路径经 _setLeasesFilePathForTest 重定向到 tmp 夹具目录(不触真实 ~/.godot-mcp);
// pid 探测经 vi.spyOn(process, 'kill') mock 三态(process 是运行时对象,spyOn 生效)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'child_process';

// logger 全模块 mock:⑧ fail-open 用例断言 MEMGUARD degraded 降级日志;
// fs-atomic(Windows rename 降级路径)的 debug 输出同走此 mock,不触真文件日志。
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../../src/core/logger.js', () => ({ getLogger: () => mockLogger }));

// fs-atomic spy 包装(importOriginal 保真实现):④ 断言 writeFileAtomic 被调用、
// ⑦ ensureDir 真实自建目录、⑧ mockImplementationOnce 一次性注入写失败。
vi.mock('../../src/core/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/fs-atomic.js')>();
  return {
    ...actual,
    writeFileAtomic: vi.fn(actual.writeFileAtomic),
    ensureDir: vi.fn(actual.ensureDir),
  };
});

import { writeFileAtomic, ensureDir } from '../../src/core/fs-atomic.js';
import {
  declaredMBFor,
  memoryGuardEnabled,
  getMachineMemorySnapshot,
  sampleRssBytes,
  listActiveLeases,
  acquireLease,
  bindLeasePid,
  releaseLease,
  heartbeatLeases,
  killPidProbe,
  updatePressureState,
  getPressureState,
  getPressureEnteredAt,
  buildMemoryPanel,
  getEvictionCandidates,
  watchdogExemptGroups,
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  type MemLease,
  type MachineMemorySnapshot,
} from '../../src/core/memory-guard.js';
import { pollOnce } from '../../src/core/mem-watchdog.js';
// 二期 Task 5 面板用:会话桶真实 API 建桶注入 lastPokeAt(「最后交互」数据源);
// ⑭ 驱逐候选 preview 桥接用 getOrCreateSession+normalizeProjectKey(与 run_project 建桶同键)
import {
  getSession,
  resetState,
  setRunSessionProc,
  getOrCreateSession,
  normalizeProjectKey,
} from '../../src/core/process-state.js';

const IS_WIN = process.platform === 'win32';

let tmpDir: string;
let leasePath: string;

function makeLease(partial: Partial<MemLease> = {}): MemLease {
  const now = Date.now();
  return {
    id: 'lease-x',
    serverPid: 4321,
    kind: 'headless',
    declaredMB: 1024,
    projectPath: 'D:/proj',
    pid: null,
    startedAt: now,
    lastHeartbeat: now,
    ...partial,
  };
}

/** 直接写租约文件夹具(绕过被测模块,构造清理三规则的初始盘面)。 */
function writeLeaseFixture(leases: MemLease[]): void {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, JSON.stringify({ version: 1, leases }));
}

/** 读盘面(验证清理/写回结果落在文件上)。 */
function readDisk(): { version: number; leases: MemLease[] } {
  return JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { version: number; leases: MemLease[] };
}

/** mock process.kill 的便捷构造:命中 aliveSet 返回 true,否则抛 ESRCH(死)。 */
function mockKillProbe(aliveSet: Set<number>): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (aliveSet.has(pid)) return true;
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as typeof process.kill);
}

/** Task 2:机器快照 psRunner mock——Win32_OperatingSystem 字段按需缺席(构造 commit 降级 null)、
 *  Win32_Process 返回固定 RSS 行(pid→实测字节)、其余脚本视为 Godot 计数。内存入参单位 MB。 */
function mockMachinePs(fields: {
  freePhysMB?: number;
  commitAvailMB?: number | null;
  godotCount?: number;
  rss?: Record<number, number>;
}): void {
  _setPsRunnerForTest((script) => {
    if (script.includes('Win32_OperatingSystem')) {
      const j: Record<string, number> = { TotalVirtualMemorySize: 64 * 1024 * 1024 };
      if (fields.freePhysMB !== undefined) j.FreePhysicalMemory = Math.round(fields.freePhysMB * 1024); // MB→KB 字段
      if (fields.commitAvailMB != null) j.FreeVirtualMemory = Math.round(fields.commitAvailMB * 1024);
      return JSON.stringify(j);
    }
    if (script.includes('Win32_Process')) {
      return JSON.stringify(
        Object.entries(fields.rss ?? {}).map(([pid, bytes]) => ({ ProcessId: Number(pid), WorkingSetSize: bytes })),
      );
    }
    return String(fields.godotCount ?? 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  _setPsRunnerForTest(null);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
  // Task 4 起 test/setup.js 全局设 GODOT_MCP_MEMORY_GUARD='0'(未 mock 守卫的其余测试
  // 零 PowerShell/零租约写盘);本文件测真实守卫逻辑,逐用例显式回归「开」——
  // 关闭态用例(②/⑩ 内 stubEnv('0'/'false'))自行覆盖本值。stubEnv 须在 _resetForTest
  // 之后(缓存已清,首次调用重读 env)。
  vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
  // Task 2 起 acquireLease 启用路径走准入三查——默认夹具恒「健康机器」,对既有用例透明(三查等价恒过):
  // 水位阈值压到 1MB(两平台物理空闲恒过)+ 预算 100%(恒不超)+ 充足快照 mock(Windows 通道;
  // 非 Windows 快照不经 psRunner,os 真实读数同样满足 1MB 阈值)。
  vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '1');
  vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '100');
  // 三期起驱逐候选受 GODOT_MCP_WATCHDOG_EXEMPT 影响——显式归零防宿主 env 泄漏污染
  // 既有用例(⑭ describe 内用例自行 stubEnv 覆盖)。空串 = 无豁免,与未设等价。
  vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', '');
  mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
});

afterEach(() => {
  _setLeasesFilePathForTest(null);
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('① 声明档位 declaredMBFor', () => {
  it('默认值:headless 1024 / gut_shard 8192 / game_window 3072 / editor 4096', () => {
    expect(declaredMBFor('headless')).toBe(1024);
    expect(declaredMBFor('gut_shard')).toBe(8192);
    expect(declaredMBFor('game_window')).toBe(3072);
    expect(declaredMBFor('editor')).toBe(4096);
  });

  it('env 覆盖:GODOT_MCP_DECLARED_MB_<KIND大写> 生效,未覆盖档不受影响', () => {
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', '2048');
    vi.stubEnv('GODOT_MCP_DECLARED_MB_GUT_SHARD', '16384');
    expect(declaredMBFor('headless')).toBe(2048);
    expect(declaredMBFor('gut_shard')).toBe(16384);
    expect(declaredMBFor('editor')).toBe(4096);
  });

  it('env 覆盖拒析:≤0/非整数/空串回默认', () => {
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', '0');
    expect(declaredMBFor('headless')).toBe(1024);
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', '-5');
    expect(declaredMBFor('headless')).toBe(1024);
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', 'abc');
    expect(declaredMBFor('headless')).toBe(1024);
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', '');
    expect(declaredMBFor('headless')).toBe(1024);
  });
});

describe('② 总开关 memoryGuardEnabled', () => {
  it('未设 = 开', () => {
    const saved = process.env.GODOT_MCP_MEMORY_GUARD;
    delete process.env.GODOT_MCP_MEMORY_GUARD;
    expect(memoryGuardEnabled()).toBe(true);
    if (saved !== undefined) process.env.GODOT_MCP_MEMORY_GUARD = saved;
  });

  it("'0'/'false' = 关,任意他值 = 开", () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    expect(memoryGuardEnabled()).toBe(false);
    _resetForTest(); // 开关读一次缓存,逐 case 前重置
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', 'false');
    expect(memoryGuardEnabled()).toBe(false);
    _resetForTest();
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
    expect(memoryGuardEnabled()).toBe(true);
    _resetForTest();
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', 'yes');
    expect(memoryGuardEnabled()).toBe(true);
  });
});

describe('③ 租约清理三规则 listActiveLeases', () => {
  it('killPidProbe 三态:kill 成功/EPERM=alive,ESRCH=dead', () => {
    const spy = vi.spyOn(process, 'kill');
    spy.mockImplementation((() => true) as typeof process.kill);
    expect(killPidProbe(100)).toBe('alive');
    spy.mockImplementation((() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as typeof process.kill);
    expect(killPidProbe(101)).toBe('alive');
    spy.mockImplementation((() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }) as typeof process.kill);
    expect(killPidProbe(102)).toBe('dead');
  });

  it('死 pid 删 / 未绑+心跳超 90s 删 / 活 pid 留(心跳陈旧也留),清理结果回写盘', () => {
    const now = Date.now();
    writeLeaseFixture([
      makeLease({ id: 'alive', pid: 111 }),
      makeLease({ id: 'dead', pid: 222 }),
      makeLease({ id: 'unbound-fresh', pid: null }),
      makeLease({ id: 'unbound-stale', pid: null, lastHeartbeat: now - 91_000 }),
      makeLease({ id: 'alive-stale-hb', pid: 333, lastHeartbeat: now - 600_000 }),
    ]);
    mockKillProbe(new Set([111, 333]));

    const active = listActiveLeases();
    expect(active.map((l) => l.id).sort()).toEqual(['alive', 'alive-stale-hb', 'unbound-fresh']);
    // 清理结果落盘(死 pid 与未绑陈久租约从文件中移除)
    expect(readDisk().leases.map((l) => l.id).sort()).toEqual(['alive', 'alive-stale-hb', 'unbound-fresh']);
  });
});

describe('④ 原子写通道 writeFileAtomic', () => {
  it('acquireLease 经 writeFileAtomic 写盘,文件形态 {version:1, leases:[...]}', () => {
    const res = acquireLease('headless', 'D:/proj');
    expect('lease' in res).toBe(true);
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(1);
    const disk = readDisk();
    expect(disk.version).toBe(1);
    expect(disk.leases).toHaveLength(1);
    if ('lease' in res) {
      expect(disk.leases[0]!.id).toBe(res.lease.id);
      expect(disk.leases[0]!.projectPath).toBe('D:/proj');
    }
  });
});

describe('⑤ 快照缓存 getMachineMemorySnapshot(Windows)', () => {
  it.skipIf(!IS_WIN)('10s 窗口内两次调用只采一次,双口径换算正确', () => {
    let memCalls = 0;
    let countCalls = 0;
    _setPsRunnerForTest((script) => {
      if (script.includes('Win32_OperatingSystem')) {
        memCalls++;
        return JSON.stringify({ FreePhysicalMemory: 1024, FreeVirtualMemory: 2048, TotalVirtualMemorySize: 4096 });
      }
      countCalls++;
      return '3'; // Godot 进程计数
    });
    const s1 = getMachineMemorySnapshot();
    const s2 = getMachineMemorySnapshot();
    expect(memCalls).toBe(1); // 只采一次
    expect(countCalls).toBe(1);
    expect(s2.sampledAt).toBe(s1.sampledAt); // 命中缓存,同一快照
    expect(s1.freePhysBytes).toBe(1024 * 1024); // KB 字段 ×1024
    expect(s1.commitAvailBytes).toBe(2048 * 1024);
    expect(s1.commitTotalBytes).toBe(4096 * 1024);
    expect(s1.godotProcCount).toBe(3);
    expect(s1.totalPhysBytes).toBe(os.totalmem());
    expect(s1.degraded).toBeUndefined();
  });
});

describe('⑥ 降级', () => {
  it.skipIf(!IS_WIN)('PowerShell runner 抛错 → commit 置 null + degraded 标记,不抛出', () => {
    _setPsRunnerForTest(() => {
      throw new Error('powershell boom');
    });
    const snap = getMachineMemorySnapshot();
    expect(snap.commitAvailBytes).toBeNull();
    expect(snap.commitTotalBytes).toBeNull();
    expect(snap.degraded).toBe('powershell-failed');
    expect(snap.godotProcCount).toBe(0);
    expect(snap.freePhysBytes).toBeGreaterThan(0); // os.freemem() 兜底
    expect(snap.totalPhysBytes).toBeGreaterThan(0); // os.totalmem() 恒有值
  });

  it.skipIf(IS_WIN)('非 Windows → commit 置 null/计数 0 + degraded 标记', () => {
    const snap = getMachineMemorySnapshot();
    expect(snap.commitAvailBytes).toBeNull();
    expect(snap.commitTotalBytes).toBeNull();
    expect(snap.godotProcCount).toBe(0);
    expect(snap.degraded).toBe('non-windows');
    expect(snap.totalPhysBytes).toBe(os.totalmem());
  });
});

describe('⑦ ensureDir 目录自建', () => {
  it('租约目录不存在时,首次写租约成功并自建目录', () => {
    expect(fs.existsSync(path.dirname(leasePath))).toBe(false);
    const res = acquireLease('editor', 'D:/proj');
    expect('lease' in res).toBe(true);
    expect(fs.existsSync(path.dirname(leasePath))).toBe(true);
    expect(fs.existsSync(leasePath)).toBe(true);
    expect(vi.mocked(ensureDir)).toHaveBeenCalled();
    if ('lease' in res) {
      expect(res.lease.kind).toBe('editor');
      expect(res.lease.declaredMB).toBe(4096);
    }
  });
});

describe('⑧ fail-open', () => {
  it('租约文件读失败(损坏 JSON)返回 [] 不抛', () => {
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{corrupted not json');
    expect(() => listActiveLeases()).not.toThrow();
    expect(listActiveLeases()).toEqual([]);
  });

  it('写失败记 MEMGUARD degraded 日志后继续,不抛', () => {
    vi.mocked(writeFileAtomic).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => acquireLease('headless', 'D:/proj')).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'memory-guard',
      expect.stringContaining('MEMGUARD degraded: lease-store unavailable'),
    );
  });
});

describe('补充:租约生命周期 bind/heartbeat/release', () => {
  it('bind 回填 pid,heartbeat 刷新本 server 心跳,release 摘除', () => {
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    mockKillProbe(new Set([4242])); // 绑定后心跳阶段 pid 探测须活

    const res = acquireLease('game_window', 'D:/proj');
    expect('lease' in res).toBe(true);
    if (!('lease' in res)) return;
    expect(res.lease.id).toMatch(/^p\d+-\d+-0$/); // id 形如 p<serverPid>-<ts>-<seq>,seq 自 0 起
    expect(res.lease.pid).toBeNull();
    expect(res.lease.lastHeartbeat).toBe(t);

    bindLeasePid(res.lease.id, 4242);
    expect(readDisk().leases[0]!.pid).toBe(4242);

    t += 5_000;
    heartbeatLeases();
    expect(readDisk().leases[0]!.lastHeartbeat).toBe(t);

    releaseLease(res.lease.id);
    expect(readDisk().leases).toHaveLength(0);
  });
});

describe('⑨ I-1 修复:总开关关闭态 dummy lease 短路', () => {
  it("关闭态(GODOT_MCP_MEMORY_GUARD=0) acquireLease 恒 ok 返回 dummy,租约文件不被创建、writeFileAtomic 零调用", () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    const res = acquireLease('headless', 'D:/proj');
    expect('lease' in res).toBe(true);
    if (!('lease' in res)) return;
    expect(res.lease.id).toBe('guard-disabled');
    expect(res.lease.kind).toBe('headless');
    expect(res.lease.declaredMB).toBe(1024);
    expect(res.lease.pid).toBeNull();
    expect(fs.existsSync(leasePath)).toBe(false); // 不创建租约文件
    expect(fs.existsSync(path.dirname(leasePath))).toBe(false); // 连目录都不建
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled(); // 零写调用
  });

  it("关闭态('false') releaseLease(dummy)/bindLeasePid(dummy)/heartbeatLeases 无害 no-op,release 可重复调不抛", () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', 'false');
    const res = acquireLease('editor', 'D:/proj');
    expect('lease' in res).toBe(true);
    expect(() => bindLeasePid('guard-disabled', 1234)).not.toThrow();
    expect(() => heartbeatLeases()).not.toThrow();
    expect(() => releaseLease('guard-disabled')).not.toThrow();
    expect(() => releaseLease('guard-disabled')).not.toThrow(); // 重复调幂等
    expect(fs.existsSync(leasePath)).toBe(false); // 全程零落盘
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureDir)).not.toHaveBeenCalled();
  });
});

describe('补充:RSS 批量采样 sampleRssBytes(Windows)', () => {
  it.skipIf(!IS_WIN)('单对象/数组两形态解析 + pid 集合缓存(乱序同键)+ 空集合不起 PowerShell', async () => {
    let psCalls = 0;
    _setPsRunnerForTest((script) => {
      if (!script.includes('Win32_Process')) throw new Error(`unexpected script: ${script}`);
      psCalls++;
      // ConvertTo-Json 单结果输出对象、多结果输出数组——按脚本是否含多 pid 的 or 判定
      return script.includes(' or ')
        ? JSON.stringify([
            { ProcessId: 100, WorkingSetSize: 1111 },
            { ProcessId: 200, WorkingSetSize: 2222 },
          ])
        : JSON.stringify({ ProcessId: 100, WorkingSetSize: 1111 });
    });
    expect(await sampleRssBytes([100])).toEqual({ 100: 1111 }); // 单对象形态
    expect(await sampleRssBytes([100, 200])).toEqual({ 100: 1111, 200: 2222 }); // 数组形态
    expect(await sampleRssBytes([200, 100])).toEqual({ 100: 1111, 200: 2222 }); // 乱序同集合命中缓存
    expect(psCalls).toBe(2);
    expect(await sampleRssBytes([])).toEqual({}); // 空集合直接返回,不起 PowerShell
    expect(psCalls).toBe(2);
  });
});

describe('⑩ Task 2:准入三查 acquireLease(水位双口径/声明预算/实例计数)', () => {
  it('① 低水位拒:code=MEMGUARD_LOW_WATER,message 含占用清单与 pid,拒绝不落盘', () => {
    if (IS_WIN) {
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '3072'); // 默认阈值下 mock 物理空闲 2GB 必触发
      mockMachinePs({ freePhysMB: 2 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    } else {
      // 非 Windows 快照无 psRunner 通道(os 真实读数不可控)——阈值抬到必超,物理口径行为等价
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '999999');
    }
    writeLeaseFixture([makeLease({ id: 'L1', pid: 111, kind: 'game_window', declaredMB: 3072, projectPath: 'D:/gameA' })]);
    mockKillProbe(new Set([111]));
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    if (!('denial' in res)) return;
    expect(res.denial.code).toBe('MEMGUARD_LOW_WATER');
    expect(res.denial.message).toContain('占用清单');
    expect(res.denial.message).toContain('pid=111');
    expect(res.denial.inventory.map((l) => l.id)).toEqual(['L1']);
    expect(readDisk().leases).toHaveLength(1); // 拒绝路径不新增租约
  });

  it('② 预算拒:Σmax(声明,实测RSS)+本kind声明 > pct%×物理总量,code=MEMGUARD_BUDGET', () => {
    vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '5');
    writeLeaseFixture([
      makeLease({ id: 'big', pid: 111, kind: 'gut_shard', declaredMB: 20480, projectPath: 'D:/big' }),
      makeLease({ id: 'rss', pid: 222, kind: 'headless', declaredMB: 1024, projectPath: 'D:/small' }),
    ]);
    mockKillProbe(new Set([111, 222]));
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0, rss: { 222: 5120 * 1024 * 1024 } });
    const res = acquireLease('game_window', 'D:/proj');
    expect('denial' in res).toBe(true);
    if (!('denial' in res)) return;
    expect(res.denial.code).toBe('MEMGUARD_BUDGET');
    // Windows:222 实测 5GB>声明 1GB 取实测;111 无读数退声明 → 已占用 20480+5120=25.0GB(防声明低估)
    // 非 Windows:RSS 采样平台短路恒空,两笔均退声明 → 20480+1024=21.0GB(纯声明路径)
    expect(res.denial.message).toContain(IS_WIN ? '已占用 25.0 GB' : '已占用 21.0 GB');
    expect(res.denial.message).toContain('本 kind 需 3.0 GB');
  });

  it.skipIf(!IS_WIN)('③ 计数拒:godotProcCount=9 > 上限 8,code=MEMGUARD_INSTANCE_CAP', () => {
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 9 });
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    if (!('denial' in res)) return;
    expect(res.denial.code).toBe('MEMGUARD_INSTANCE_CAP');
    expect(res.denial.message).toContain('Godot 进程数 9');
    expect(res.denial.message).toContain('上限 8');
  });

  it('④ exemptChecks=true 跳三查直接建租约(必拒环境下仍成功落盘)', () => {
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '999999'); // 构造水位必拒环境
    const res = acquireLease('editor', 'D:/proj', { exemptChecks: true });
    expect('lease' in res).toBe(true);
    if (!('lease' in res)) return;
    expect(res.lease.kind).toBe('editor');
    expect(readDisk().leases).toHaveLength(1);
  });

  it('⑤ guard=0 时低水位也 ok:短路先于三查,零采样零落盘', () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '999999'); // 若三查执行必拒
    let psCalls = 0;
    _setPsRunnerForTest(() => {
      psCalls++;
      return '0';
    });
    const res = acquireLease('headless', 'D:/proj');
    expect('lease' in res).toBe(true);
    if ('lease' in res) expect(res.lease.id).toBe('guard-disabled');
    expect(psCalls).toBe(0); // 三查未执行(Windows 上连快照采样都没起)
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it('⑥ commit=null(降级)时只查物理口径仍拒,message 诚实呈现 commit n/a', () => {
    if (IS_WIN) {
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '3072');
      // 返回缺 FreeVirtualMemory 字段 → commit 双口径降级 null;物理空闲 1024KB=1MB < 3072MB
      _setPsRunnerForTest((script) => {
        if (script.includes('Win32_OperatingSystem')) return JSON.stringify({ FreePhysicalMemory: 1024 });
        return '0';
      });
    } else {
      // 非 Windows commit 恒 null(天然降级);物理真实空闲 < 999999MB 恒低
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '999999');
    }
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    if (!('denial' in res)) return;
    expect(res.denial.code).toBe('MEMGUARD_LOW_WATER');
    expect(res.denial.message).toContain('commit n/a');
  });
});

// 终审 I-1a(2026-11-22,docs/reviews/2026-11-22-memory-guard-p1-review.md):pid=null 租约
// 泄漏被 60s 心跳无限续命 → 90s 陈旧清理线永不到期,账本非自愈。修复:heartbeatLeases
// 对「startedAt 超 5min 宽限窗仍 pid=null」的租约停续命(不刷 lastHeartbeat)——正常流程
// acquire→spawn→bindLeasePid 毫秒级完成,超窗必为泄漏/竞态覆盖产物,任其陈旧即被清理。
describe('⑪ 终审 I-1:pid=null 租约超宽限窗停续命(账本自愈)', () => {
  it('startedAt 超 5min 仍 pid=null → heartbeatLeases 不刷新其 lastHeartbeat;心跳累计陈旧超 90s 后被读时清理', () => {
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    // 构造泄漏租约:lastHeartbeat 新鲜(距 30s<90s,读时清理不动它),startedAt 距 6min 超 5min 宽限窗
    const leak = makeLease({
      id: 'leak-1', serverPid: process.pid, pid: null,
      startedAt: t - 6 * 60_000, lastHeartbeat: t - 30_000,
    });
    writeLeaseFixture([leak]);
    heartbeatLeases();
    const after = readDisk().leases.find((l) => l.id === 'leak-1');
    expect(after).toBeDefined();                     // 未到 90s 陈旧线,租约暂留
    expect(after!.lastHeartbeat).toBe(t - 30_000);   // 核心:未被续命(心跳保持原值)
    // 推进 91s:lastHeartbeat 距今 121s 超 90s → 读时清理删除,账本自愈
    t += 91_000;
    expect(listActiveLeases().some((l) => l.id === 'leak-1')).toBe(false);
    expect(readDisk().leases.some((l) => l.id === 'leak-1')).toBe(false);
  });

  it('startedAt < 5min 的 pid=null 租约照常续命;已绑 pid 的租约不受宽限窗影响', () => {
    const t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    mockKillProbe(new Set([4242])); // 已绑 pid 探测须活
    const fresh = makeLease({
      id: 'fresh-1', serverPid: process.pid, pid: null,
      startedAt: t - 60_000, lastHeartbeat: t - 60_000,
    });
    const bound = makeLease({
      id: 'bound-1', serverPid: process.pid, pid: 4242,
      startedAt: t - 10 * 60_000, lastHeartbeat: t - 30_000,
    });
    writeLeaseFixture([fresh, bound]);
    heartbeatLeases();
    const disk = readDisk().leases;
    expect(disk.find((l) => l.id === 'fresh-1')!.lastHeartbeat).toBe(t); // 宽限窗内照常续
    expect(disk.find((l) => l.id === 'bound-1')!.lastHeartbeat).toBe(t); // 已绑 pid 超窗也续(心跳仅服务未绑阶段)
  });
});

// ---------------------------------------------------------------------------
// 二期 Task 2:整机软阈值 pressure 状态机(拒新保旧+上报)
// ---------------------------------------------------------------------------

/** 直调 updatePressureState 的快照构造(不走采样通道,时序全由 fake timers 控制):
 *  入参单位 MB;commitAvailMB=null 构造降级口径(commit 缺席)。 */
function pressureSnap(freePhysMB: number, commitAvailMB: number | null): MachineMemorySnapshot {
  return {
    freePhysBytes: freePhysMB * 1024 * 1024,
    totalPhysBytes: 64 * 1024 * 1024 * 1024,
    commitAvailBytes: commitAvailMB === null ? null : commitAvailMB * 1024 * 1024,
    commitTotalBytes: commitAvailMB === null ? null : 64 * 1024 * 1024 * 1024,
    godotProcCount: 0,
    sampledAt: Date.now(),
  };
}

describe('⑫ 二期 Task 2:整机软阈值 pressure 状态机(拒新保旧+上报)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // 时间原点归零,30s/5min 去抖算术直观
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('① 瞬时跌破回升 → 计时清零,两段合计跌破再长也不进 pressure(防抖)', () => {
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=0 跌破(2GB<3072MB)起算
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=10s 回升 → 去抖计时清零
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=20s 再跌破 → 重新起算
    vi.advanceTimersByTime(20_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=40s 回升(第二段仅 20s<30s)→ 又清零
    // 两段跌破合计 30s 但不连续 → 后续持续健康永不进 pressure
    for (let s = 50; s <= 80; s += 10) {
      vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(8 * 1024, 64 * 1024));
    }
    expect(getPressureState()).toBe('normal');
    expect(getPressureEnteredAt()).toBeNull();
    // 状态 normal 时健康机器 acquireLease 不因软阈值拒(水位 1MB/预算 100% 恒过)
    expect('lease' in acquireLease('headless', 'D:/proj')).toBe(true);
  });

  it('② 持续跌破满 30s → pressure,acquireLease 第四查拒(code=MEMGUARD_LOW_WATER,message 含拒新保旧前缀)+stderr 上报', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const s of [0, 10, 20]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // 物理口径持续跌破
      expect(getPressureState()).toBe('normal'); // 未满 30s 不进
    }
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=30s 恰满 30s → 进 pressure
    expect(getPressureState()).toBe('pressure');
    expect(getPressureEnteredAt()).toBe(30_000);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('MEMGUARD pressure enter'));
    // 拒新:快照 mock 是健康机器(水位 1MB/预算 100% 恒过)——唯一拒因是状态机在 pressure
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    if (!('denial' in res)) return;
    expect(res.denial.code).toBe('MEMGUARD_LOW_WATER');
    expect(res.denial.message).toContain('整机内存压力(软阈值)持续 30s——拒新保旧');
    expect(fs.existsSync(leasePath)).toBe(false); // 拒绝路径不落盘
  });

  it('③ pressure 期间在跑租约不被杀:pollOnce 照常看护,健康租约 killed=0 且保留(保旧)', async () => {
    for (const s of [0, 10, 20, 30]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // 持续跌破满 30s
    }
    expect(getPressureState()).toBe('pressure');
    // 一笔已绑 pid 的在跑租约(headless 声明 1024MB,杀线 ×2=2048MB;RSS 512MB 远低)
    writeLeaseFixture([
      makeLease({ id: 'keep-1', serverPid: process.pid, kind: 'headless', declaredMB: 1024, pid: 555 }),
    ]);
    mockKillProbe(new Set([555]));
    if (IS_WIN) {
      // Windows:RSS 通道可控——512MB 读数直接证明「主动判定不超杀线不杀」
      mockMachinePs({ freePhysMB: 2 * 1024, commitAvailMB: 64 * 1024, godotCount: 1, rss: { 555: 512 * 1024 * 1024 } });
    }
    // 非 Windows:RSS 通道恒空走降级路径,降级语义本就是「不判杀」——观测契约一致(killed=0+租约保留)
    const r = await pollOnce();
    expect(r.checked).toBe(1);
    expect(r.killed).toBe(0);
    expect(readDisk().leases.some((l) => l.id === 'keep-1')).toBe(true); // 保旧:租约不动
  });

  it('④ pressure→normal 需连续 5min 高于软阈值,中途再跌破恢复计时重计', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const s of [0, 10, 20, 30]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(2 * 1024, 64 * 1024));
    }
    expect(getPressureState()).toBe('pressure'); // t=30s 进 pressure
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=40s 回升 → 5min 恢复计时起算
    vi.advanceTimersByTime(160_000);
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=200s 中途再跌破 → 恢复计时清零
    expect(getPressureState()).toBe('pressure'); // 仍 pressure(未恢复)
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=210s 回升 → 恢复计时重新起算
    vi.advanceTimersByTime(299_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=509s 连续 299s 差 1s → 仍 pressure
    expect(getPressureState()).toBe('pressure');
    vi.advanceTimersByTime(1_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=510s 恰连续 300s → 恢复 normal
    expect(getPressureState()).toBe('normal');
    expect(getPressureEnteredAt()).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('MEMGUARD pressure exit'));
    expect('lease' in acquireLease('headless', 'D:/proj')).toBe(true); // 恢复后重新受理
  });

  it('⑤ 接线:watchdog pollOnce 每轮喂快照推进状态机(持续跌破 4 轮恰满 30s 进 pressure)', async () => {
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_SOFT_MB', '999999'); // 阈值抬到必跌破(两平台物理读数恒低)
    for (let i = 0; i < 4; i++) {
      if (i > 0) vi.advanceTimersByTime(10_000); // 对齐看门狗默认 10s 轮询节奏
      await pollOnce();
    }
    expect(getPressureState()).toBe('pressure'); // 第 4 轮(t=30s)恰满 30s
  });

  it('⑥ guard=0:状态机旁路——updatePressureState 不更新,pressure 恒 normal 不拒新', () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest(); // 清总开关读缓存(与一期关闭态用例同惯例)
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_SOFT_MB', '999999');
    for (const s of [0, 10, 20, 30, 40]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(0, 0)); // 恒跌破喂 5 轮
    }
    expect(getPressureState()).toBe('normal'); // 旁路:状态不变
    const res = acquireLease('headless', 'D:/proj');
    expect('lease' in res).toBe(true); // dummy 短路(一期 I-1),pressure 不参与
    if ('lease' in res) expect(res.lease.id).toBe('guard-disabled');
  });

  it('⑦ 双口径语义:commit 余量跌破同样计入;commit=null 降级只看物理口径', () => {
    for (const s of [0, 10, 20, 30]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(64 * 1024, 2 * 1024)); // 物理健康,commit 2GB<3072MB 跌破
    }
    expect(getPressureState()).toBe('pressure');
    // commit 降级 null:只看物理口径——物理 64GB 健康 → 恒不跌破
    _resetForTest(); // 清状态机重证
    for (const s of [0, 10, 20, 30, 40]) {
      if (s > 0) vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(64 * 1024, null));
    }
    expect(getPressureState()).toBe('normal');
  });
});

// ─── 二期 Task 5:L3 面板聚合 buildMemoryPanel(doctor / godot_get_context 共享单源) ───
// 夹具三注入:租约 tmp(既有 _setLeasesFilePathForTest)+ registry tmp(env
// GODOT_MCP_BRIDGE_REGISTRY_DIR 指向 tmp 子目录,不触真实 ~/.godot-mcp/instances)+
// 会话桶(process-state 真实 API setRunSessionProc 建桶,lastPokeAt 直接落值)。
// RSS 采样走 mockMachinePs 的 rss 表(mock pid 集合,不真起 PowerShell)。

describe('⑬ buildMemoryPanel(二期 Task 5)', () => {
  let registryDir: string;

  /** 写 registry 心跳条目夹具(形态对齐 mcp_bridge.gd _write_registry_entry)。 */
  function writeRegistryFixture(entries: Array<{ pid: number; projectPath: string }>): void {
    fs.mkdirSync(registryDir, { recursive: true });
    for (const e of entries) {
      fs.writeFileSync(
        path.join(registryDir, `inst-${e.pid}.json`),
        JSON.stringify({
          id: `inst-${e.pid}`, projectPath: e.projectPath, projectName: 'P', port: 9081,
          pid: e.pid, lastSeen: new Date().toISOString(), lastSeenMs: Date.now(),
          godotVersion: '4.7.2', capabilities: ['registry-heartbeat'],
        }),
      );
    }
  }

  /** 假 ChildProcess(建会话桶所需最小形状,复制 session-idle-timer.test.ts makeProc)。 */
  function makeProc(pid: number): ChildProcess {
    return { pid, killed: false, exitCode: null, on: vi.fn(), kill: vi.fn() } as unknown as ChildProcess;
  }

  beforeEach(() => {
    registryDir = path.join(tmpDir, 'instances');
    vi.stubEnv('GODOT_MCP_BRIDGE_REGISTRY_DIR', registryDir);
  });

  afterEach(() => {
    resetState(); // 清面板消费的会话桶(避免跨 describe 泄漏给同文件后续用例)
  });

  it('① 健康默认态:四组字段齐(guard/watermarkMB/pressure/machine/budget,空实例表)', () => {
    const p = buildMemoryPanel();
    expect(p.guard).toBe(true);                        // beforeEach 显式回归「开」
    expect(p.watermarkMB).toBe(1);                     // beforeEach stubEnv MIN_FREE_MB=1(与准入同源)
    expect(p.pressure).toEqual({ state: 'normal', enteredAt: null });
    if (IS_WIN) {                                      // 快照读数走 ps mock 精确值
      expect(p.machine.freePhysBytes).toBe(64 * 1024 ** 3);   // mockMachinePs 64GB 夹具
      expect(p.machine.commitAvailBytes).toBe(64 * 1024 ** 3);
      expect(p.machine.godotProcCount).toBe(0);
    } else {                                           // 非 Windows 快照不经 psRunner(os 真实读数)
      expect(p.machine.freePhysBytes).toBeGreaterThan(0);
      expect(p.machine.commitAvailBytes).toBeNull();   // 无 PowerShell 通道降级
    }
    expect(p.budget.pct).toBe(100);                    // beforeEach stubEnv BUDGET_PCT=100
    // totalPhysBytes 恒走 os.totalmem()(两平台,ps mock 不控)→ pct=100 时 budgetMB=机器总 MB
    expect(p.budget.budgetMB).toBe(Math.round(os.totalmem() / 1024 / 1024));
    expect(p.budget.usedMB).toBe(0);
    expect(p.budget.leaseCount).toBe(0);
    expect(p.instances).toEqual([]);
  });

  it('② 租约条目行:pid/项目/kind/声明/实测 RSS/最后交互(会话桶 lastPokeAt),usedMB=Σ max(声明,实测)', () => {
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 1, rss: { 4242: 512 * 1024 * 1024 } });
    writeLeaseFixture([makeLease({ id: 'L1', kind: 'game_window', declaredMB: 3072, projectPath: 'D:/proj-a', pid: 4242 })]);
    mockKillProbe(new Set([4242]));                    // 租约 pid 判活(listActiveLeases 读时清理)
    const pokeAt = Date.now() - 30_000;
    setRunSessionProc('D:/proj-a', makeProc(4242));    // 建桶(spawn 即 lastPokeAt 起点)
    getSession('D:/proj-a')!.lastPokeAt = pokeAt;      // 直接落值(模拟 Task 1 poke 链)
    const p = buildMemoryPanel();
    expect(p.instances).toHaveLength(1);
    expect(p.instances[0]).toMatchObject({
      pid: 4242, project: 'D:/proj-a', kind: 'game_window', declaredMB: 3072,
      lastPokeAt: pokeAt, source: 'lease',
    });
    if (IS_WIN) {                                      // RSS 走 ps mock 精确值(非 Windows 无 WMI 通道)
      expect(p.instances[0]!.rssMB).toBe(512);
    } else {
      expect(p.instances[0]!.rssMB).toBeNull();        // 采样 miss 诚实 null
    }
    expect(p.budget.usedMB).toBe(3072);                // max(声明 3072, 实测≤512) 取声明(两平台同)
    expect(p.budget.leaseCount).toBe(1);
  });

  it.skipIf(!IS_WIN)('③ usedMB 防声明低估:实测 RSS 超声明取实测(一期 leaseUsageCtx 同源口径)', () => {
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, rss: { 5150: 2048 * 1024 * 1024 } });
    writeLeaseFixture([makeLease({ id: 'L2', kind: 'headless', declaredMB: 1024, projectPath: 'D:/proj-b', pid: 5150 })]);
    mockKillProbe(new Set([5150]));
    const p = buildMemoryPanel();
    expect(p.instances[0]!.rssMB).toBe(2048);
    expect(p.budget.usedMB).toBe(2048);                // max(声明 1024, 实测 2048) 取实测
  });

  it('④ registry-only 行(外部实例):kind/声明 null + source=registry + 无会话桶 lastPokeAt null;死 pid 心跳不显示', () => {
    writeRegistryFixture([{ pid: 9999, projectPath: 'D:/external' }, { pid: 8888, projectPath: 'D:/dead' }]);
    mockKillProbe(new Set([9999]));                    // 8888 死(ESRCH) → 剔除
    const p = buildMemoryPanel();
    expect(p.instances).toHaveLength(1);
    expect(p.instances[0]).toMatchObject({
      pid: 9999, project: 'D:/external', kind: null, declaredMB: null,
      rssMB: null, lastPokeAt: null, source: 'registry', // RSS 未在 mock rss 表 → null(采样 miss 诚实呈现)
    });
  });

  it('⑤ 同 pid 租约+registry 心跳 → 合并单行 source=both(kind/声明来自租约)', () => {
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, rss: { 4242: 256 * 1024 * 1024 } });
    writeLeaseFixture([makeLease({ id: 'L3', kind: 'game_window', declaredMB: 3072, projectPath: 'D:/proj-a', pid: 4242 })]);
    writeRegistryFixture([{ pid: 4242, projectPath: 'D:/proj-a' }]);
    mockKillProbe(new Set([4242]));
    const p = buildMemoryPanel();
    expect(p.instances).toHaveLength(1);
    expect(p.instances[0]).toMatchObject({ pid: 4242, kind: 'game_window', declaredMB: 3072, source: 'both' });
    if (IS_WIN) expect(p.instances[0]!.rssMB).toBe(256);  // RSS 走 ps mock(非 Windows 采样 miss null)
  });

  it('⑥ guard=0:面板照常返回(只读观测不吃总开关)但 WMI 通道旁路——os 内置读数+零 PowerShell', () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest();                                   // 清总开关读缓存
    const p = buildMemoryPanel();
    expect(p.guard).toBe(false);
    expect(p.pressure.state).toBe('normal');           // 状态机旁路恒 normal(真实呈现非假数据)
    expect(p.instances).toEqual([]);                   // dummy 租约不落盘,账本空是真实状态
    expect(p.machine.freePhysBytes).toBeGreaterThan(0); // 快照照常返回(os 内置读数)
    expect(p.machine.commitAvailBytes).toBeNull();     // WMI 通道随治理旁路(test/setup.js 全局
    expect(p.machine.godotProcCount).toBe(0);          //  guard=0「未 mock 测试零 PowerShell」约定)
  });

  it('⑦ 三期 Task 2:watchdogExempt 面板字段——未设=[] / editor / preview,editor 恒固定序;guard=0 照出', () => {
    // beforeEach 已 stubEnv WATCHDOG_EXEMPT=''(空串=未设语义) → 无豁免
    expect(buildMemoryPanel().watchdogExempt).toEqual([]);
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'editor');
    expect(buildMemoryPanel().watchdogExempt).toEqual(['editor']);
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'preview,editor');
    expect(buildMemoryPanel().watchdogExempt).toEqual(['preview', 'editor']);
    // 乱序+大小写不敏感:输出恒固定序 preview→editor(doctor 行/get_context 展示稳定契约)
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', ' Editor , PREVIEW ');
    expect(buildMemoryPanel().watchdogExempt).toEqual(['preview', 'editor']);
    // guard=0 面板照常返回,exempt 字段照出(只读观测不吃总开关——exempt 是 env 事实非治理状态)
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest();                                   // 清总开关读缓存(⑥ 用例同款模式)
    const p = buildMemoryPanel();
    expect(p.guard).toBe(false);
    expect(p.watchdogExempt).toEqual(['preview', 'editor']);
  });
});

// ---------------------------------------------------------------------------
// 三期 Task 1:WATCHDOG_EXEMPT 驱逐候选过滤——env 命中组(preview/editor)整组剔出
// 候选(区别于殿后:殿后=排序最后仍可杀,env 豁免=不进候选),与殿后语义正交:未命中
// 组维持既有殿后排序。单进程硬帽(KILL_FACTOR)不受 env 豁免影响——watchdog 侧
// mem-watchdog.test.ts 三期 describe 钉住。ratio 断言依赖 RSS 读数通道(psRunner
// mock)→ Windows-only,同二期驱逐用例惯例;纯成员断言用例全平台跑。
// ---------------------------------------------------------------------------

/** preview 会话桶夹具(候选桥接键 = normalizeProjectKey,与 run_project 建桶同键)。 */
function makePreviewSession(projectPath: string): void {
  getOrCreateSession(normalizeProjectKey(projectPath)).preview = true;
}

describe('⑭ 三期:WATCHDOG_EXEMPT 候选过滤', () => {
  const MBQ = 1024 * 1024; // MB 级 RSS 构造(ratio = 实测÷声明)

  afterEach(() => {
    resetState(); // 清 preview 会话桶(describe 局部,避免跨用例泄漏)
  });

  it('watchdogExemptGroups 直测:未设/空串=空 Set;trim+大小写不敏感;每次调用实时读 env', () => {
    expect(watchdogExemptGroups().size).toBe(0); // 未设 → 无豁免
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', '');
    expect(watchdogExemptGroups().size).toBe(0); // 空串等同未设
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', ' Editor , PREVIEW ');
    const groups = watchdogExemptGroups();
    expect(groups.size).toBe(2);
    expect(groups.has('preview')).toBe(true);
    expect(groups.has('editor')).toBe(true); // 改 env 后下一次调用即生效(不缓存)
  });

  it.skipIf(!IS_WIN)('① env 未设:结构=既有排序清单 + envExempted 全零(新签名基线,殿后语义不变)', () => {
    writeLeaseFixture([
      makeLease({ id: 'N', serverPid: process.pid, kind: 'headless', declaredMB: 2048, pid: 3001 }),
      makeLease({ id: 'E', serverPid: process.pid, kind: 'editor', declaredMB: 4096, pid: 3002 }),
      makeLease({ id: 'P', serverPid: process.pid, kind: 'game_window', declaredMB: 1024, pid: 3003, projectPath: 'D:/prev-only' }),
    ]);
    makePreviewSession('D:/prev-only');
    mockKillProbe(new Set([3001, 3002, 3003]));
    mockMachinePs({ rss: { 3001: 1536 * MBQ, 3002: 6 * 1024 * MBQ, 3003: 2048 * MBQ } });

    const r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['N', 'P', 'E']); // 普通区 N(0.75)在前;豁免区殿后 P(2.0)>E(1.5)
    expect(r.candidates[0].ratio).toBeCloseTo(0.75, 5);
    expect(r.envExempted).toEqual({ preview: 0, editor: 0 });
  });

  it.skipIf(!IS_WIN)('② env=editor:editor 不进候选且计数=1;preview 仍殿后(留在候选内),headless ratio 降序不变', () => {
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'editor');
    writeLeaseFixture([
      makeLease({ id: 'N1', serverPid: process.pid, kind: 'headless', declaredMB: 2048, pid: 3001 }),
      makeLease({ id: 'N2', serverPid: process.pid, kind: 'headless', declaredMB: 1024, pid: 3004 }),
      makeLease({ id: 'E', serverPid: process.pid, kind: 'editor', declaredMB: 4096, pid: 3002 }),
      makeLease({ id: 'P', serverPid: process.pid, kind: 'game_window', declaredMB: 1024, pid: 3003, projectPath: 'D:/prev-only' }),
    ]);
    makePreviewSession('D:/prev-only');
    mockKillProbe(new Set([3001, 3002, 3003, 3004]));
    mockMachinePs({ rss: { 3001: 1536 * MBQ, 3002: 6 * 1024 * MBQ, 3003: 2048 * MBQ, 3004: 1536 * MBQ } });

    const r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['N2', 'N1', 'P']); // headless 区 ratio 1.5>0.75 降序;P 殿后(env 未豁免 preview)
    expect(r.envExempted).toEqual({ preview: 0, editor: 1 });
  });

  it.skipIf(!IS_WIN)('③ env=preview,editor:preview 会话与 editor 均不进候选;非 preview 的 game_window 视为普通候选', () => {
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'preview,editor');
    writeLeaseFixture([
      makeLease({ id: 'G', serverPid: process.pid, kind: 'game_window', declaredMB: 2048, pid: 3005, projectPath: 'D:/normal-game' }),
      makeLease({ id: 'E', serverPid: process.pid, kind: 'editor', declaredMB: 4096, pid: 3002 }),
      makeLease({ id: 'P', serverPid: process.pid, kind: 'game_window', declaredMB: 1024, pid: 3003, projectPath: 'D:/prev-only' }),
      makeLease({ id: 'N', serverPid: process.pid, kind: 'headless', declaredMB: 2048, pid: 3001 }),
    ]);
    makePreviewSession('D:/prev-only'); // 仅 P 的会话桶 preview=true;G 无桶(非 preview)
    mockKillProbe(new Set([3001, 3002, 3003, 3005]));
    mockMachinePs({ rss: { 3001: 1024 * MBQ, 3002: 6 * 1024 * MBQ, 3003: 2048 * MBQ, 3005: 1536 * MBQ } });

    const r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['G', 'N']); // G(0.75)>N(0.5) 同普通区降序
    expect(r.envExempted).toEqual({ preview: 1, editor: 1 });
  });

  it('④ env=prevew,editor(拼错):仅 editor 生效 + stderr warn 含原始 token(合法 token 照常生效)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', 'prevew,editor');
    writeLeaseFixture([
      makeLease({ id: 'N', serverPid: process.pid, kind: 'headless', declaredMB: 2048, pid: 3001 }),
      makeLease({ id: 'E', serverPid: process.pid, kind: 'editor', declaredMB: 4096, pid: 3002 }),
    ]);
    mockKillProbe(new Set([3001, 3002]));

    const r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['N']); // editor 被剔;拼错的 preview 无效(无 preview 剔除)
    expect(r.envExempted).toEqual({ preview: 0, editor: 1 });
    expect(errSpy).toHaveBeenCalledTimes(1); // 一行/每未知 token
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('MEMGUARD WATCHDOG_EXEMPT'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('prevew'));
  });

  it('⑤ env=空串/`,,`:等同未设(envExempted 全零、候选含全部组、无 warn)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 夹具无 RSS 读数(ratio 全 0)→ 豁免区内走 sort 稳定序 = 夹具写入序(P 先于 E 写入)
    writeLeaseFixture([
      makeLease({ id: 'N', serverPid: process.pid, kind: 'headless', declaredMB: 2048, pid: 3001 }),
      makeLease({ id: 'P', serverPid: process.pid, kind: 'game_window', declaredMB: 1024, pid: 3003, projectPath: 'D:/prev-only' }),
      makeLease({ id: 'E', serverPid: process.pid, kind: 'editor', declaredMB: 4096, pid: 3002 }),
    ]);
    makePreviewSession('D:/prev-only');
    mockKillProbe(new Set([3001, 3002, 3003]));

    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', '');
    let r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['N', 'P', 'E']); // 分区排序不依赖 ratio(殿后恒在尾部)
    expect(r.envExempted).toEqual({ preview: 0, editor: 0 });

    vi.stubEnv('GODOT_MCP_WATCHDOG_EXEMPT', ',,'); // 全空 token
    r = getEvictionCandidates();
    expect(r.candidates.map((c) => c.lease.id)).toEqual(['N', 'P', 'E']);
    expect(r.envExempted).toEqual({ preview: 0, editor: 0 });
    expect(errSpy).not.toHaveBeenCalled(); // 空 token 静默跳过,不产 warn
  });
});
