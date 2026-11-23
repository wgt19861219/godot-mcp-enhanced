// test/core/memory-guard-sample.test.ts
//
// memory-guard 四期 Task 1 单测——memSample 采样单点:
//  ① 公共壳(ts/v/event/serverPid/pressure)+ 专有字段直铺 + machine MB 序列化 + 0600
//  ② server_start 惰性首发(进程内首个事件前自动先落一行,只发一次)
//  ③ 双开关短路:GODOT_MCP_MEMORY_GUARD=0 / GODOT_MCP_MEM_SAMPLE=0|false → 文件不创建
//  ④ snap 语义:null 显式 machine:null / 缺省只读缓存(冷→null 且不起 PowerShell,暖→复用)
//  ⑤ fail-open:appendFile 拒绝不抛,console.error 同因首次一行、后续静默
//
// 测试注入约定:采样文件路径经 vi.stubEnv('GODOT_MCP_MEM_SAMPLE_FILE') 逐用例重定向到
// tmp 夹具(覆盖 test/setup.js 全局重定向值,不触真实 ~/.godot-mcp);PowerShell 执行器经
// _setPsRunnerForTest 注入 spy(④ 验证「只读缓存不触发新采样」);memSample 内部
// fire-and-forget,经 vi.waitFor 等落盘行数到达后再断言内容。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'child_process';

// child_process spy 包装(importOriginal 保真,同 session-idle-timer/exit-watchdog 测试
// 惯例):⑥⑦ 接线用例触发的树杀/kill 链绝不真执行。
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// memory-guard 部分 mock(importOriginal 保真,同 mem-watchdog.test.ts 惯例):⑨ 看门狗
// 降级/恢复用例需可控 sampleRssBytes(抛错=降级轮/读数=恢复轮)——真实通道在非 Windows
// 恒空表,恢复路径不经 mock 无法跨平台驱动。其余导出保真直铺,①-⑦ 行为零影响。
vi.mock('../../src/core/memory-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/memory-guard.js')>();
  return { ...actual, sampleRssBytes: vi.fn(actual.sampleRssBytes) };
});

import { spawn as spawnSpy } from 'child_process';
import {
  memSample,
  getMachineMemorySnapshot,
  acquireLease,
  bindLeasePid,
  declaredMBFor,
  updatePressureState,
  sampleRssBytes,
  _setLeasesFilePathForTest,
  _resetForTest,
  _setPsRunnerForTest,
  type MachineMemorySnapshot,
} from '../../src/core/memory-guard.js';
import { pollOnce, _resetWatchdogForTest } from '../../src/core/mem-watchdog.js';
import {
  getSession,
  normalizeProjectKey,
  resetState,
  setRunSessionProc,
} from '../../src/core/process-state.js';
import { scanIdleSessions } from '../../src/core/session-idle-timer.js';
import {
  handleExitTrigger,
  stopExitWatchdog,
  _resetExitWatchdogForTest,
} from '../../src/core/exit-watchdog.js';

const IS_LINUX = process.platform === 'linux';

// server_start 的 pkgVersion 断言基准:与实现同款 createRequire 读法(包根上两级)
const PKG_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version ?? 'unknown';

let tmpDir: string;
let samplePath: string;

/** 读采样文件按行 parse(空行过滤)。 */
function readLines(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(samplePath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 取第 i 行(缺失即抛——测试自身失败,非断言歧义)。 */
function row(rows: Array<Record<string, unknown>>, i: number): Record<string, unknown> {
  const r = rows[i];
  if (r === undefined) throw new Error(`sample line ${i} missing`);
  return r;
}

/** 等 fire-and-forget append 落盘至期望行数。 */
async function waitForLineCount(n: number): Promise<void> {
  await vi.waitFor(() => {
    expect(fs.existsSync(samplePath)).toBe(true);
    expect(readLines().length).toBe(n);
  });
}

/** 静置一拍:负向断言(文件不该被创建)前给「若实现错误本应发生的异步写」留出时间窗。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
}

/** 机器快照 psRunner mock(对齐 memory-guard.test.ts mockMachinePs 形态,裁剪 RSS 分支):
 *  返回 spy 供「只读缓存不触发新采样」的调用计数断言。 */
function mockMachinePs(fields: { freePhysMB?: number; commitAvailMB?: number | null; godotCount?: number }): ReturnType<typeof vi.fn> {
  const spy = vi.fn((script: string): string => {
    if (script.includes('Win32_OperatingSystem')) {
      const j: Record<string, number> = { TotalVirtualMemorySize: 64 * 1024 * 1024 };
      if (fields.freePhysMB !== undefined) j['FreePhysicalMemory'] = Math.round(fields.freePhysMB * 1024); // MB→KB 字段
      if (fields.commitAvailMB != null) j['FreeVirtualMemory'] = Math.round(fields.commitAvailMB * 1024);
      return JSON.stringify(j);
    }
    return String(fields.godotCount ?? 0);
  });
  _setPsRunnerForTest(spy);
  return spy;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  _setPsRunnerForTest(null);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsample-test-'));
  samplePath = path.join(tmpDir, 'events.jsonl');
  // test/setup.js 全局设 GODOT_MCP_MEMORY_GUARD='0'(未 mock 守卫的其余测试零写盘);
  // 本文件测真实采样路径,逐用例显式回归「开」——stubEnv 须在 _resetForTest 之后
  // (开关缓存已清,首次调用重读 env)。采样文件逐用例重定向,覆盖 setup.js 全局值。
  vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '1');
  vi.stubEnv('GODOT_MCP_MEM_SAMPLE_FILE', samplePath);
});

afterEach(() => {
  _setPsRunnerForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('① memSample 公共壳与专有字段直铺', () => {
  it('lease_acquired 追加一行:壳字段(ts/v/event/serverPid/pressure)+ fields 直铺 + machine MB 序列化', async () => {
    const snap: MachineMemorySnapshot = {
      freePhysBytes: 4096 * 1024 * 1024,
      totalPhysBytes: 32768 * 1024 * 1024,
      commitAvailBytes: null,
      commitTotalBytes: null,
      godotProcCount: 3,
      sampledAt: Date.now(),
      degraded: 'non-windows',
    };
    memSample(
      'lease_acquired',
      { kind: 'headless', project: 'D:/proj', leaseId: 'p1-1-0', declaredMB: 1024 },
      snap,
    );
    await waitForLineCount(2); // server_start 惰性首发 + 本事件
    const rows = readLines();
    expect(row(rows, 0)['event']).toBe('server_start');
    const r = row(rows, 1);
    expect(r['event']).toBe('lease_acquired');
    expect(r['v']).toBe(1);
    expect(r['serverPid']).toBe(process.pid);
    expect(r['pressure']).toBe('normal');
    expect(typeof r['ts']).toBe('number');
    // fields 专有字段直铺(不嵌套、不改名)
    expect(r['kind']).toBe('headless');
    expect(r['project']).toBe('D:/proj');
    expect(r['leaseId']).toBe('p1-1-0');
    expect(r['declaredMB']).toBe(1024);
    // machine 序列化:bytes→MB 取整;commitAvailBytes null 透传 null;degraded 转 bool
    expect(r['machine']).toEqual({
      freePhysMB: 4096, commitAvailMB: null, totalPhysMB: 32768, godotProcCount: 3, degraded: true,
    });
  });

  it.skipIf(!IS_LINUX)('文件 0600 权限(Windows 无 chmod 语义,仅 Linux 断言;创建成功由其余用例覆盖)', async () => {
    memSample('lease_acquired', { kind: 'headless' });
    await waitForLineCount(2);
    expect(fs.statSync(samplePath).mode & 0o777).toBe(0o600);
  });
});

describe('② server_start 惰性首发', () => {
  it('首个 memSample 前自动先落一行(pkgVersion/thresholds/declaredMB 四档/killFactor 四档/pollSeconds/tzOffsetMin),且只发一次', async () => {
    // 阈值全量 stub 到非常量值——证明 server_start 记的是「事件时刻阈值」而非默认值硬编码
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '123');
    vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '56');
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_SOFT_MB', '2048');
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_HARD_MB', '1024');
    vi.stubEnv('GODOT_MCP_MAX_MACHINE_INSTANCES', '6');
    vi.stubEnv('GODOT_MCP_MEM_POLL_SECONDS', '15');
    vi.stubEnv('GODOT_MCP_DECLARED_MB_HEADLESS', '2048');
    memSample('lease_acquired', { kind: 'headless' });
    memSample('lease_acquired', { kind: 'editor' });
    await waitForLineCount(3); // server_start + 2 事件
    const ss = row(readLines(), 0);
    expect(ss['event']).toBe('server_start');
    expect(ss['v']).toBe(1);
    expect(ss['serverPid']).toBe(process.pid);
    expect(ss['pkgVersion']).toBe(PKG_VERSION);
    expect(ss['thresholds']).toEqual({ minFreeMB: 123, budgetPct: 56, maxInstances: 6, softMB: 2048, hardMB: 1024 });
    expect(ss['declaredMB']).toEqual({ headless: 2048, gut_shard: 8192, game_window: 3072, editor: 4096 });
    expect(ss['killFactor']).toEqual({ headless: 2, gut_shard: 2, game_window: 3, editor: 3 });
    expect(ss['pollSeconds']).toBe(15);
    expect(ss['tzOffsetMin']).toBe(-new Date().getTimezoneOffset());
    // 只发一次:第三次调用后 server_start 仍只有一行
    memSample('lease_acquired', { kind: 'game_window' });
    await waitForLineCount(4);
    expect(readLines().filter((r) => r['event'] === 'server_start')).toHaveLength(1);
  });
});

describe('③ 双开关短路(文件不创建级别)', () => {
  it('GODOT_MCP_MEMORY_GUARD=0 → memSample 短路,文件不创建', async () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest(); // 开关读一次缓存——重置后首次调用重读 env
    memSample('lease_acquired', { kind: 'headless' });
    await settle();
    expect(fs.existsSync(samplePath)).toBe(false);
  });

  it('GODOT_MCP_MEM_SAMPLE=0 → 同上短路', async () => {
    vi.stubEnv('GODOT_MCP_MEM_SAMPLE', '0');
    memSample('lease_acquired', { kind: 'headless' });
    await settle();
    expect(fs.existsSync(samplePath)).toBe(false);
  });

  it('GODOT_MCP_MEM_SAMPLE=false → 同上短路(两个关闭值都测)', async () => {
    vi.stubEnv('GODOT_MCP_MEM_SAMPLE', 'false');
    memSample('lease_acquired', { kind: 'headless' });
    await settle();
    expect(fs.existsSync(samplePath)).toBe(false);
  });
});

describe('④ snap 参数语义(只读缓存,不触发新采样)', () => {
  it('snap=null 显式落 machine:null', async () => {
    memSample('lease_acquired', { kind: 'headless' }, null);
    await waitForLineCount(2);
    expect(row(readLines(), 1)['machine']).toBeNull();
  });

  it('snap 缺省且缓存冷(_resetForTest 已清)→ machine:null 且不起 PowerShell', async () => {
    const psSpy = mockMachinePs({});
    memSample('lease_acquired', { kind: 'headless' }); // snap 缺省
    await waitForLineCount(2);
    expect(row(readLines(), 1)['machine']).toBeNull();
    expect(psSpy).not.toHaveBeenCalled();
  });

  it('snap 缺省且缓存暖 → machine 复用缓存快照序列化,无新增 PowerShell 调用', async () => {
    const psSpy = mockMachinePs({ freePhysMB: 8192, commitAvailMB: 4096, godotCount: 2 });
    getMachineMemorySnapshot(); // 预热缓存(此处经 mock 起「PowerShell」)
    const callsAfterWarm = psSpy.mock.calls.length;
    memSample('lease_acquired', { kind: 'headless' }); // snap 缺省 → 只读缓存
    await waitForLineCount(2);
    const warmed = getMachineMemorySnapshot(); // 10s 缓存窗内,同一份快照对象
    expect(row(readLines(), 1)['machine']).toEqual({
      freePhysMB: Math.round(warmed.freePhysBytes / 1024 / 1024),
      commitAvailMB: warmed.commitAvailBytes !== null ? Math.round(warmed.commitAvailBytes / 1024 / 1024) : null,
      totalPhysMB: Math.round(warmed.totalPhysBytes / 1024 / 1024),
      godotProcCount: warmed.godotProcCount,
      degraded: warmed.degraded !== undefined,
    });
    expect(psSpy.mock.calls.length).toBe(callsAfterWarm); // 零新增采样
    // Windows 侧加钉:machine 来自缓存里的 mock 读数(8192MB),非现场 os.freemem 重读
    if (process.platform === 'win32') {
      expect((row(readLines(), 1)['machine'] as Record<string, unknown>)['freePhysMB']).toBe(8192);
    }
  });
});

describe('⑤ fail-open:追加失败同因去重 warn', () => {
  it('路径不可写(目标是目录)→ 不抛/首错一行 console.error/第二次静默', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(samplePath); // 采样文件路径本身是目录 → appendFile 必拒(不可写路径)
    memSample('lease_acquired', { kind: 'headless' }); // server_start + 事件两次失败(同因去重)
    memSample('lease_acquired', { kind: 'editor' }); // 第三次失败(同因静默)
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
    await settle(); // 让后续失败的 catch 链也全部跑完再计数
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('memSample');
  });
});

// ===========================================================================
// 四期 Task 2:准入/生命周期五事件接线(lease_acquired/spawn_started/spawn_reject/
// idle_reap/exit_reap)——接线在 src 侧,此处经公开 API 真实触发并断言采样行形态
//(字段名即 Task 6 分析端接口)。夹具:租约文件 _setLeasesFilePathForTest 重定向
//(acquireLease 启用路径写租约/回收链读账本,不触真实 ~/.godot-mcp);child_process
// spawn 纯假(树杀绝不真执行);process-state 会话桶 resetState 隔离;exit-watchdog
// 经 _resetExitWatchdogForTest 注入 fake exit(绝不真退测试进程)。
// ===========================================================================

/** mock process.kill:命中 aliveSet 返回 true,否则抛 ESRCH(死)——bindLeasePid 前的
 *  租约清理线按 pid 探活,不 mock 时假 pid 恒死被清、bind 静默 no-op 无事件。 */
function mockKillProbe(aliveSet: Set<number>): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (aliveSet.has(pid)) return true;
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as typeof process.kill);
}

describe('⑥ Task 2:准入事件接线(lease_acquired/spawn_reject 四查/spawn_started)', () => {
  const IS_WIN = process.platform === 'win32';
  let leasePath: string;

  /** 直接写租约文件夹具(绕过被测模块,构造查② 预算占用的初始盘面)。 */
  function writeLeaseFixture(leases: Array<Record<string, unknown>>): void {
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, JSON.stringify({ version: 1, leases }));
  }

  beforeEach(() => {
    leasePath = path.join(tmpDir, 'memory-leases.json');
    _setLeasesFilePathForTest(leasePath);
    // spawn 顶层纯假(⑥ 不触 spawn,兜底防漏网路径真起进程)
    vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
  });

  afterEach(() => {
    _setLeasesFilePathForTest(null);
  });

  it('acquireLease 成功 → lease_acquired 行(kind/project/leaseId/declaredMB=declaredMBFor(kind),machine 复用准入链快照)', async () => {
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '1');   // 两平台恒过(对齐 memory-guard.test.ts 惯例)
    vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '100');
    mockMachinePs({ freePhysMB: 8192, commitAvailMB: 4096, godotCount: 2 });
    const res = acquireLease('headless', 'D:/proj');
    expect('lease' in res).toBe(true);
    if (!('lease' in res)) return;
    await waitForLineCount(2);                   // server_start 惰性首发 + 本事件
    const r = row(readLines(), 1);
    expect(r['event']).toBe('lease_acquired');
    expect(r['kind']).toBe('headless');
    expect(r['project']).toBe('D:/proj');
    expect(r['leaseId']).toBe(res.lease.id);
    expect(r['declaredMB']).toBe(declaredMBFor('headless'));
    // machine=与查⓪-③ 同一份快照(复用零新增采样);totalPhys 来自真实 os.totalmem(),
    // 断言与 getMachineMemorySnapshot() 同源对象逐字段对齐(Windows 加钉 mock 读数 8192)
    const snap = getMachineMemorySnapshot();
    expect(r['machine']).toEqual({
      freePhysMB: Math.round(snap.freePhysBytes / 1024 / 1024),
      commitAvailMB: snap.commitAvailBytes !== null ? Math.round(snap.commitAvailBytes / 1024 / 1024) : null,
      totalPhysMB: Math.round(snap.totalPhysBytes / 1024 / 1024),
      godotProcCount: snap.godotProcCount,
      degraded: snap.degraded !== undefined,
    });
    if (IS_WIN) {
      expect((r['machine'] as Record<string, unknown>)['freePhysMB']).toBe(8192);
    }
  });

  it('editor exemptChecks 路径 → lease_acquired 行 machine:null 且零 PowerShell(豁免分支不取快照)', async () => {
    const psSpy = mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    const res = acquireLease('editor', 'D:/proj', { exemptChecks: true });
    expect('lease' in res).toBe(true);
    await waitForLineCount(2);
    const r = row(readLines(), 1);
    expect(r['event']).toBe('lease_acquired');
    expect(r['kind']).toBe('editor');
    expect(r['declaredMB']).toBe(declaredMBFor('editor'));
    expect(r['machine']).toBeNull();             // 设计约束:豁免路径无快照,显式 null
    expect(psSpy).not.toHaveBeenCalled();        // 连机器快照采样都没起(Review Focus 3)
  });

  it('查⓪ pressure 拒 → spawn_reject 行 check:0(reason=MEMGUARD_LOW_WATER,thresholds={softMB},无 leaseId)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // hard enter 上报行
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 }); // 机器健康——唯一拒因是状态机
    // 物理空闲 1MB < 硬阈值 1536MB → 0s 宽限立即 hard(单次调用,免 fake timers 推进 30s)
    updatePressureState({
      freePhysBytes: 1 * 1024 * 1024,
      totalPhysBytes: 64 * 1024 * 1024 * 1024,
      commitAvailBytes: null,
      commitTotalBytes: null,
      godotProcCount: 0,
      sampledAt: Date.now(),
    });
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    // 四期 Task 3 起 hard enter 先落一行 pressure_change(normal→hard):spawn_reject 行顺移至 2
    await waitForLineCount(3);
    const rows = readLines();
    expect(row(rows, 1)['event']).toBe('pressure_change'); // hard enter 切换行(⑧③ 已详断形态)
    const r = row(rows, 2);
    expect(r['event']).toBe('spawn_reject');
    expect(r['kind']).toBe('headless');
    expect(r['project']).toBe('D:/proj');
    expect(r['check']).toBe(0);                  // 查⓪ 序号
    expect(r['reason']).toBe('MEMGUARD_LOW_WATER'); // 与查① 同 code——check 字段是唯一区分
    expect(r['thresholds']).toEqual({ softMB: 3072 });
    expect('leaseId' in r).toBe(false);          // 拒绝时租约未生成,字段整个缺席
    expect(r['pressure']).toBe('hard');          // 壳 after-state 佐证拒因形态
    expect(r['machine']).not.toBeNull();         // 拒绝路径有现成快照,复用落盘
    errSpy.mockRestore();
  });

  it('查① 低水位拒 → spawn_reject 行 check:1(与查⓪ 同 reason 不同 check,字段层可分)', async () => {
    if (IS_WIN) {
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '3072'); // 默认阈值下 mock 物理空闲 2GB 必触发
      mockMachinePs({ freePhysMB: 2 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    } else {
      // 非 Windows 快照无 psRunner 通道(os 真实读数不可控)——阈值抬到必超,等价覆盖
      vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '999999');
    }
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    await waitForLineCount(2);
    const r = row(readLines(), 1);
    expect(r['event']).toBe('spawn_reject');
    expect(r['check']).toBe(1);
    expect(r['reason']).toBe('MEMGUARD_LOW_WATER');
    expect(r['thresholds']).toEqual({ minFreeMB: IS_WIN ? 3072 : 999999 });
    expect(r['pressure']).toBe('normal');        // 状态机未进压力——区别于查⓪ 行的 hard
  });

  it('查② 预算拒 → spawn_reject 行 check:2(reason=MEMGUARD_BUDGET,thresholds 含 budgetPct+当时占用)', async () => {
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '1');    // 水位恒过,单查预算
    vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '1'); // 1% 预算必超(占用 8192+需 1024 MB)
    writeLeaseFixture([{
      id: 'L-big', serverPid: 4321, kind: 'gut_shard', declaredMB: 8192,
      projectPath: 'D:/big', pid: null,          // 无 pid → 纯声明计占用,不触 RSS 采样
      startedAt: Date.now(), lastHeartbeat: Date.now(),
    }]);
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    await waitForLineCount(2);
    const r = row(readLines(), 1);
    expect(r['event']).toBe('spawn_reject');
    expect(r['check']).toBe(2);
    expect(r['reason']).toBe('MEMGUARD_BUDGET');
    expect(r['thresholds']).toEqual({ budgetPct: 1, usedMB: 8192 });
  });

  it.skipIf(!IS_WIN)('查③ 实例计数拒 → spawn_reject 行 check:3(reason=MEMGUARD_INSTANCE_CAP,thresholds={maxInstances})', async () => {
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 9 }); // 9 > 默认上限 8
    const res = acquireLease('headless', 'D:/proj');
    expect('denial' in res).toBe(true);
    await waitForLineCount(2);
    const r = row(readLines(), 1);
    expect(r['event']).toBe('spawn_reject');
    expect(r['check']).toBe(3);
    expect(r['reason']).toBe('MEMGUARD_INSTANCE_CAP');
    expect(r['thresholds']).toEqual({ maxInstances: 8 });
  });

  it('bindLeasePid → spawn_started 行(leaseId+pid 非 null,kind/project 从租约回读)', async () => {
    vi.stubEnv('GODOT_MCP_MIN_FREE_MB', '1');
    vi.stubEnv('GODOT_MCP_MEM_BUDGET_PCT', '100');
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    const res = acquireLease('headless', 'D:/proj');
    if (!('lease' in res)) throw new Error('acquire failed');
    mockKillProbe(new Set([4242]));              // bind 前清理线按 pid 探活,假 pid 须活
    bindLeasePid(res.lease.id, 4242);
    await waitForLineCount(3);                   // server_start + lease_acquired + spawn_started
    const r = row(readLines(), 2);
    expect(r['event']).toBe('spawn_started');
    expect(r['leaseId']).toBe(res.lease.id);
    expect(r['pid']).toBe(4242);                 // 进程身份确立点,pid 非 null
    expect(r['kind']).toBe('headless');
    expect(r['project']).toBe('D:/proj');
  });
});

describe('⑦ Task 2:生命周期回收事件接线(idle_reap/exit_reap)', () => {
  /** 假 ChildProcess:仅含扫描判活与建桶所需字段 + 事件桩(idle 路径,close 不触发)。 */
  function makeProc(pid: number): ChildProcess {
    return { pid, killed: false, exitCode: null, on: vi.fn(), kill: vi.fn() } as unknown as ChildProcess;
  }

  /** 自闭假 ChildProcess:killProcess 注册 close 监听即同步触发——优雅段 kill 链零
   *  timer 推进完成收尾(免 fake timers 与异步 append 采样的交织)。 */
  function makeSelfClosingProc(pid: number): ChildProcess {
    return {
      pid, killed: false, exitCode: null, kill: vi.fn(),
      on: vi.fn((ev: string, cb: () => void) => { if (ev === 'close') cb(); }),
    } as unknown as ChildProcess;
  }

  beforeEach(() => {
    resetState();                                 // process-state 会话桶隔离
    _setLeasesFilePathForTest(path.join(tmpDir, 'memory-leases.json')); // 回收链读账本不触真实 home
    vi.mocked(spawnSpy).mockImplementation((() => ({ on: vi.fn() })) as unknown as typeof spawnSpy);
    _resetExitWatchdogForTest(vi.fn());           // exit 注入 fake(绝不真退测试进程)
  });

  afterEach(() => {
    stopExitWatchdog();                           // 清 10s/30s timer + 状态复位(幂等)
    _resetExitWatchdogForTest(null);
    _setLeasesFilePathForTest(null);
  });

  it('scanIdleSessions 回收 → idle_reap 行(kind=game_window,aliveMs 非零——processStartTime 在 clearRunSession 前捕获)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // idle-reap stderr 行
    const proc = makeProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    const s = getSession('D:/proj-a');
    if (!s) throw new Error('session missing');
    s.lastPokeAt = Date.now() - 16 * 60_000;      // 空闲 16min > 15min 阈值(免 fake timers)
    s.processStartTime = Date.now() - 5_000;      // 进程存活 5s:有界非零锚(见下)
    expect(scanIdleSessions()).toEqual({ reaped: 1 });
    await waitForLineCount(2);
    const r = row(readLines(), 1);
    expect(r['event']).toBe('idle_reap');
    expect(r['kind']).toBe('game_window');
    expect(r['project']).toBe(normalizeProjectKey('D:/proj-a')); // 会话桶 key 形态(分析端视为不透明)
    expect(r['pid']).toBe(4242);
    const aliveMs = r['aliveMs'] as number;
    expect(aliveMs).toBeGreaterThanOrEqual(5_000); // 非零(M3 坑:clear 后 processStartTime 恒 0,接线先捕获)
    expect(aliveMs).toBeLessThan(60_000);          // 有界——防「读了 clear 后的 0」错型(now-0≈1.7e12)
    expect(r['machine']).toBeNull();               // 设计约束:回收路径不触发新采样
    errSpy.mockRestore();
  });

  it('exit-watchdog 优雅回收 → exit_reap 行(同 idle_reap 形态,project/pid/aliveMs 齐)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // exit-watchdog/exit-reap stderr 行
    const proc = makeSelfClosingProc(4242);
    setRunSessionProc('D:/proj-a', proc, true);
    const s = getSession('D:/proj-a');
    if (!s) throw new Error('session missing');
    s.processStartTime = Date.now() - 5_000;
    handleExitTrigger('SIGINT');                  // 第一次触发:优雅回收段(不主动 exit)
    await waitForLineCount(2);                    // server_start + exit_reap(收尾链跑完)
    const r = row(readLines(), 1);
    expect(r['event']).toBe('exit_reap');
    expect(r['kind']).toBe('game_window');
    expect(r['project']).toBe(normalizeProjectKey('D:/proj-a'));
    expect(r['pid']).toBe(4242);
    const aliveMs = r['aliveMs'] as number;
    expect(aliveMs).toBeGreaterThanOrEqual(5_000);
    expect(aliveMs).toBeLessThan(60_000);
    expect(r['machine']).toBeNull();
    errSpy.mockRestore();
  });
});

// ===========================================================================
// 四期 Task 3:pressure_change 四切换 + watchdog_degraded/recovered 接线——
// 接线在 src 侧(updatePressureState 四切换点/noteDegrade 退避点/恢复首轮清零点),
// 此处经公开 API 真实触发并断言采样行形态(字段名即 Task 6 分析端接口)。
// 夹具:⑧ 复制 memory-guard.test.ts ⑫ 的 pressureSnap + fake timers(时序全可控);
// ⑨ 复制 mem-watchdog.test.ts 的租约夹具 + sampleRssBytes 部分 mock(抛错=降级轮/
// 读数=恢复轮),pollOnce 首行喂状态机的机器快照走 mockMachinePs(恒健康)。
// ===========================================================================

/** 直调 updatePressureState 的快照构造(不走采样通道,时序全由 fake timers 控制;复制
 *  memory-guard.test.ts ⑫ 同名夹具):入参单位 MB;commitAvailMB=null 构造降级口径。 */
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

describe('⑧ Task 3:pressure_change 四切换接线(updatePressureState)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // 时间原点归零,30s/5min 去抖算术直观(同 ⑫ 惯例)
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 持续跌破软阈值(默认 3072MB)满 30s 进 pressure:feeds at t=0..step*3。 */
  function driveSoftEnter(): void {
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=0 跌破(2GB<3072MB)起算
    for (let t = 10_000; t <= 30_000; t += 10_000) {
      vi.advanceTimersByTime(10_000);
      updatePressureState(pressureSnap(2 * 1024, 64 * 1024)); // t=30s 恰满 30s → 进 pressure
    }
  }

  it('① normal→pressure:持续跌破满 30s → 一行 from=normal to=pressure;壳省略 pressure 键;machine=喂入的切换 snap', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // pressure enter stderr 行
    driveSoftEnter();
    vi.useRealTimers(); // fire-and-forget append 与 fake timers 无关,先回真实时钟再等落盘
    await waitForLineCount(2); // server_start + pressure_change
    const r = row(readLines(), 1);
    expect(r['event']).toBe('pressure_change');
    expect(r['from']).toBe('normal');
    expect(r['to']).toBe('pressure');
    expect('pressure' in r).toBe(false); // 壳省略 pressure 键——from/to 即态,第三键有歧义
    expect(r['machine']).toEqual({       // machine 用喂入的 snap(t=30 切换轮的跌破读数)
      freePhysMB: 2048, commitAvailMB: 65536, totalPhysMB: 65536, godotProcCount: 0, degraded: false,
    });
    errSpy.mockRestore();
  });

  it('② pressure→hard:进 pressure 后跌破硬阈值(1MB<1536MB)→ from=pressure to=hard', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    driveSoftEnter();                          // t=30s 进 pressure(row 1:normal→pressure)
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(1, 64 * 1024)); // t=40s 0s 宽限立即 hard(row 2)
    vi.useRealTimers();
    await waitForLineCount(3);
    const r = row(readLines(), 2);
    expect(r['event']).toBe('pressure_change');
    expect(r['from']).toBe('pressure');
    expect(r['to']).toBe('hard');
    expect('pressure' in r).toBe(false);
    errSpy.mockRestore();
  });

  it('③ hard→pressure:1MB 立即 hard(row1 normal→hard)→ 4GB 达硬阈值+2GB 脱离线 → from=hard to=pressure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updatePressureState(pressureSnap(1, 64 * 1024));  // t=0 normal→hard(0s 宽限,row 1)
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(4 * 1024, null)); // t=10s 4096MB≥1536+2048 → hard exit(row 2)
    vi.useRealTimers();
    await waitForLineCount(3);
    const rows = readLines();
    const r1 = row(rows, 1);
    expect(r1['event']).toBe('pressure_change'); // 垫脚石切换顺带钉住 site② 的 normal 入线
    expect(r1['from']).toBe('normal');
    expect(r1['to']).toBe('hard');
    const r2 = row(rows, 2);
    expect(r2['event']).toBe('pressure_change');
    expect(r2['from']).toBe('hard');
    expect(r2['to']).toBe('pressure');
    expect('pressure' in r2).toBe(false);
    errSpy.mockRestore();
  });

  it('④ pressure→normal:进 pressure 后连续 5min 高于软阈值 → from=pressure to=normal', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    driveSoftEnter();                          // t=30s 进 pressure(row 1)
    vi.advanceTimersByTime(10_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=40s 回升 → 5min 恢复计时起算
    vi.advanceTimersByTime(300_000);
    updatePressureState(pressureSnap(8 * 1024, 64 * 1024)); // t=340s 恰连续 300s → 恢复(row 2)
    vi.useRealTimers();
    await waitForLineCount(3);
    const r = row(readLines(), 2);
    expect(r['event']).toBe('pressure_change');
    expect(r['from']).toBe('pressure');
    expect(r['to']).toBe('normal');
    expect('pressure' in r).toBe(false);
    errSpy.mockRestore();
  });

  it('⑤ guard=0:updatePressureState 早退(状态机旁路在切换判定之前)→ 零行,文件不创建', async () => {
    vi.stubEnv('GODOT_MCP_MEMORY_GUARD', '0');
    _resetForTest(); // 开关读一次缓存——重置后首次调用重读 env
    updatePressureState(pressureSnap(1, 64 * 1024)); // 若未早退必切 normal→hard 落行
    vi.advanceTimersByTime(40_000);
    updatePressureState(pressureSnap(2 * 1024, 64 * 1024));
    vi.useRealTimers();
    await settle();
    expect(fs.existsSync(samplePath)).toBe(false);
  });
});

describe('⑨ Task 3:watchdog_degraded/recovered 接线(noteDegrade/恢复点)', () => {
  beforeEach(() => {
    // 状态机恒健康(软/硬阈值均 1MB,真实 os 读数必高于):pollOnce 首行喂快照零切换,
    // 行数账本只剩 watchdog 事件;机器快照走 mockMachinePs 免真起 PowerShell。
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_SOFT_MB', '1');
    vi.stubEnv('GODOT_MCP_MEM_PRESSURE_HARD_MB', '1');
    mockMachinePs({ freePhysMB: 64 * 1024, commitAvailMB: 64 * 1024, godotCount: 0 });
    _resetWatchdogForTest(); // 清 mem-watchdog 降级计数/退避窗
    _setLeasesFilePathForTest(path.join(tmpDir, 'memory-leases.json'));
    fs.mkdirSync(path.dirname(path.join(tmpDir, 'memory-leases.json')), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'memory-leases.json'),
      JSON.stringify({
        version: 1,
        leases: [{
          id: 'W1', serverPid: process.pid, kind: 'headless', declaredMB: 1024,
          projectPath: 'D:/proj', pid: 4242, startedAt: Date.now(), lastHeartbeat: Date.now(),
        }],
      }),
    );
    mockKillProbe(new Set([4242])); // listActiveLeases 清理线按 pid 探活,假 pid 须活
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('ps down')); // 默认:采样通道抛错
  });

  afterEach(() => {
    _setLeasesFilePathForTest(null);
  });

  it('① 连续 3 轮采样失败 → watchdog_degraded(consecutiveRounds=3);第 4/5 轮仅续退避不重复落行', async () => {
    await pollOnce();
    await pollOnce();
    await pollOnce(); // 第 3 轮达阈值(退避触发点)→ 落行
    await waitForLineCount(2); // server_start + watchdog_degraded
    const r = row(readLines(), 1);
    expect(r['event']).toBe('watchdog_degraded');
    expect(r['consecutiveRounds']).toBe(3);
    expect(r['pressure']).toBe('normal'); // 非 pressure_change 事件壳照带 pressure 键
    expect(r['machine']).not.toBeNull();  // pollOnce 首行喂快照,缓存暖
    await pollOnce();
    await pollOnce(); // 第 4/5 轮失败:计数 4/5≠3 不再落行(对齐 warn 日志只记一次)
    await settle();
    expect(readLines()).toHaveLength(2);
  });

  it('② 降级后首轮拿到读数 → watchdog_recovered;再失败重新累计,未满 3 轮不落 degraded', async () => {
    await pollOnce();
    await pollOnce();
    await pollOnce(); // 降级(row 1)
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 512 * 1024 * 1024 }); // 恢复轮:读数正常
    await pollOnce();
    await waitForLineCount(3); // + watchdog_recovered
    const r = row(readLines(), 2);
    expect(r['event']).toBe('watchdog_recovered');
    expect('consecutiveRounds' in r).toBe(false); // recovered 无专有字段(接口 {})
    expect(r['pressure']).toBe('normal');
    vi.mocked(sampleRssBytes).mockRejectedValue(new Error('ps down'));
    await pollOnce();
    await pollOnce(); // 恢复后重新累计 1+2=2 轮,未达 3 → 不落 degraded
    await settle();
    expect(readLines()).toHaveLength(3);
  });

  it('③ 未达阈值的失败(2 轮)+ 成功轮:零降级事件也零恢复事件(此前 <3,恢复语义不成立)', async () => {
    await pollOnce();
    await pollOnce();
    vi.mocked(sampleRssBytes).mockResolvedValue({ 4242: 512 * 1024 * 1024 });
    await pollOnce(); // 2 轮失败后成功:计数清零,无 degraded 也无 recovered
    await settle();
    // 零事件 → memSample 一次未被调(server_start 也惰性未触发)→ 文件不创建
    expect(fs.existsSync(samplePath)).toBe(false);
  });
});
