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
import {
  memSample,
  getMachineMemorySnapshot,
  _resetForTest,
  _setPsRunnerForTest,
  type MachineMemorySnapshot,
} from '../../src/core/memory-guard.js';

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
