// test/core/memory-guard.test.ts
//
// memory-guard 核心(Task 1)单测——①档位表默认值+env 覆盖 ②总开关三态 ③租约清理三规则
// ④writeFileAtomic 原子写 ⑤快照缓存 ⑥PowerShell 失败降级 ⑦ensureDir 目录自建
// ⑧fail-open(读失败返 []/写失败降级日志) + 补充(租约生命周期/RSS 采样)。
//
// 测试注入约定:PowerShell 执行器经 _setPsRunnerForTest 注入 fake(不真起 PowerShell);
// 租约文件路径经 _setLeasesFilePathForTest 重定向到 tmp 夹具目录(不触真实 ~/.godot-mcp);
// pid 探测经 vi.spyOn(process, 'kill') mock 三态(process 是运行时对象,spyOn 生效)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  _setLeasesFilePathForTest,
  _setPsRunnerForTest,
  _resetForTest,
  type MemLease,
} from '../../src/core/memory-guard.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  _setPsRunnerForTest(null);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-test-'));
  leasePath = path.join(tmpDir, '.godot-mcp', 'memory-leases.json');
  _setLeasesFilePathForTest(leasePath);
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
