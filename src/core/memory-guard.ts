// src/core/memory-guard.ts
//
// 内存治理一期 Task 1:核心模块——机器内存快照 / 声明档位 / 跨 server 租约存储。
// 后续任务(准入三查/看门狗/漏斗接线)全部建立在本模块导出之上。
//
// 设计要点(docs/superpowers/specs/2026-11-22-memory-guard-design.md):
//  - 机器内存双口径:物理内存恒走 Node 内置 os(三平台可得);commit 双口径与 Godot
//    进程计数仅 Windows(PowerShell Get-CimInstance),非 Windows/采样失败优雅降级;
//  - 租约存 ~/.godot-mcp/memory-leases.json(机器级目录惯例,同 instances/audit),
//    形态 {version:1, leases:[]},写全部经 fs-atomic 原子写,写前 ensureDir;
//  - fail-open:租约文件读失败视作无租约、写失败记降级日志后继续(设计 §5④)——
//    治理层自身故障不得阻断工具链可用性。

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { freemem, homedir, totalmem } from 'os';
import { join } from 'path';
import { getLogger } from './logger.js';
import { ensureDir, writeFileAtomic } from './fs-atomic.js';

export type SpawnKind = 'headless' | 'gut_shard' | 'game_window' | 'editor';

export interface MachineMemorySnapshot {
  freePhysBytes: number; totalPhysBytes: number;
  commitAvailBytes: number | null; commitTotalBytes: number | null;
  godotProcCount: number; sampledAt: number;
  degraded?: 'powershell-failed' | 'non-windows';
}

export interface MemLease {
  id: string; serverPid: number; kind: SpawnKind; declaredMB: number;
  projectPath: string; pid: number | null; startedAt: number; lastHeartbeat: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 声明档位默认值(MB)——env GODOT_MCP_DECLARED_MB_<KIND大写> 可逐档覆盖(整数,≤0 拒析回默认)。 */
const DEFAULT_DECLARED_MB: Record<SpawnKind, number> = {
  headless: 1024,
  gut_shard: 8192,
  game_window: 3072,
  editor: 4096,
};
/** 快照缓存窗口(10s):看门狗高频轮询不反复起 PowerShell。 */
const SNAPSHOT_CACHE_TTL_MS = 10_000;
/** RSS 批量采样结果缓存窗口(10s),按 pid 集合键。 */
const RSS_CACHE_TTL_MS = 10_000;
/** 未绑 pid 租约的心跳陈旧阈值(90s)——超时即视为弃约清理。 */
const LEASE_HEARTBEAT_STALE_MS = 90_000;
/** PowerShell 采样超时(5s),超时按降级处理。 */
const POWERSHELL_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// 总开关与档位
// ---------------------------------------------------------------------------

let _enabledCache: boolean | null = null;

/** 内存治理总开关:GODOT_MCP_MEMORY_GUARD 读一次缓存。未设=开;'0'/'false'=关;任意他值=开。 */
export function memoryGuardEnabled(): boolean {
  if (_enabledCache === null) {
    const raw = process.env.GODOT_MCP_MEMORY_GUARD;
    _enabledCache = raw !== '0' && raw !== 'false';
  }
  return _enabledCache;
}

/** 声明档位(MB):默认表 + env GODOT_MCP_DECLARED_MB_<KIND大写> 覆盖(整数 MB,≤0 拒析回默认)。 */
export function declaredMBFor(kind: SpawnKind): number {
  const raw = process.env[`GODOT_MCP_DECLARED_MB_${kind.toUpperCase()}`];
  if (raw !== undefined) {
    const mb = Number.parseInt(raw, 10);
    if (Number.isFinite(mb) && mb > 0) return mb;
  }
  return DEFAULT_DECLARED_MB[kind];
}

// ---------------------------------------------------------------------------
// PowerShell 采样通道(仅 Windows;非 Windows / 失败一律优雅降级)
// ---------------------------------------------------------------------------

/** PowerShell 脚本执行器:入参脚本,返回 stdout 文本;失败抛错由调用方降级。 */
export type PsScriptRunner = (script: string) => string;

let _psRunner: PsScriptRunner | null = null;

/** 默认执行器:同步 spawn PowerShell(-NoProfile),5s 超时。编码沿用 orphan-cleanup 惯例
 *  utf8 直读(采样字段全 ASCII 数字,ConvertTo-Json 输出无非 ASCII 顾虑)。 */
function defaultPsRunner(script: string): string {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: POWERSHELL_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`powershell exited ${r.status}: ${String(r.stderr ?? '').slice(0, 200)}`);
  }
  return Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : (r.stdout ?? '');
}

function runPs(script: string): string {
  return (_psRunner ?? defaultPsRunner)(script);
}

// ---------------------------------------------------------------------------
// 机器内存快照(10s 缓存)
// ---------------------------------------------------------------------------

let _snapshotCache: { at: number; snap: MachineMemorySnapshot } | null = null;

/** 机器内存快照(同步,10s 缓存)。物理内存恒可得(os);commit 双口径与 Godot 进程计数
 *  仅 Windows;非 Windows/采样失败降级(commit 置 null、计数 0)并打 degraded 标记。 */
export function getMachineMemorySnapshot(): MachineMemorySnapshot {
  const now = Date.now();
  if (_snapshotCache !== null && now - _snapshotCache.at < SNAPSHOT_CACHE_TTL_MS) {
    return _snapshotCache.snap;
  }
  const snap = sampleMachineMemory();
  _snapshotCache = { at: now, snap };
  return snap;
}

function sampleMachineMemory(): MachineMemorySnapshot {
  const totalPhysBytes = totalmem();
  if (process.platform !== 'win32') {
    return {
      freePhysBytes: freemem(), totalPhysBytes,
      commitAvailBytes: null, commitTotalBytes: null,
      godotProcCount: 0, sampledAt: Date.now(),
      degraded: 'non-windows',
    };
  }
  let freePhysBytes = freemem();
  let commitAvailBytes: number | null = null;
  let commitTotalBytes: number | null = null;
  let godotProcCount = 0;
  let degraded: MachineMemorySnapshot['degraded'];
  // 口径 1:物理空闲 + commit 双口径(KB 字段 ×1024;commit 余量 = FreeVirtualMemory,
  // =CommitLimit−CommitTotal 语义,审查 F3 定案——不读 FreeSpaceInPagingFiles)
  try {
    const out = runPs(
      'Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json',
    );
    const j = JSON.parse(out) as Record<string, unknown>;
    const freeKb = Number(j['FreePhysicalMemory']);
    const commitAvailKb = Number(j['FreeVirtualMemory']);
    const commitTotalKb = Number(j['TotalVirtualMemorySize']);
    if (Number.isFinite(freeKb) && freeKb > 0) freePhysBytes = freeKb * 1024;
    if (Number.isFinite(commitAvailKb) && commitAvailKb >= 0) commitAvailBytes = commitAvailKb * 1024;
    if (Number.isFinite(commitTotalKb) && commitTotalKb >= 0) commitTotalBytes = commitTotalKb * 1024;
  } catch {
    degraded = 'powershell-failed';
  }
  // 口径 2:Godot 进程计数(上游计数查在 godotProcCount=0 时跳过)
  try {
    const out = runPs(
      "Get-Process | Where-Object Name -like 'Godot*' | Measure-Object | Select-Object -ExpandProperty Count",
    );
    const n = Number.parseInt(out.trim(), 10);
    if (Number.isFinite(n) && n >= 0) godotProcCount = n;
    else degraded = 'powershell-failed';
  } catch {
    degraded = 'powershell-failed';
  }
  const snap: MachineMemorySnapshot = {
    freePhysBytes, totalPhysBytes, commitAvailBytes, commitTotalBytes,
    godotProcCount, sampledAt: Date.now(),
  };
  if (degraded !== undefined) snap.degraded = degraded;
  return snap;
}

// ---------------------------------------------------------------------------
// RSS 批量采样(10s 结果缓存,按 pid 集合键)
// ---------------------------------------------------------------------------

const _rssCache = new Map<string, { at: number; data: Record<number, number> }>();

/** 批量采样进程 RSS(字节)。Windows 走 Get-CimInstance Win32_Process 批量查询;
 *  结果按 pid 集合(排序归一)缓存 10s;非 Windows/失败/空集合 → 空 Record(不抛)。 */
export async function sampleRssBytes(pids: number[]): Promise<Record<number, number>> {
  if (pids.length === 0) return {};
  const cacheKey = [...pids].sort((a, b) => a - b).join(',');
  const now = Date.now();
  const hit = _rssCache.get(cacheKey);
  if (hit !== undefined && now - hit.at < RSS_CACHE_TTL_MS) return hit.data;
  const data = sampleRssNow(pids);
  _rssCache.set(cacheKey, { at: now, data });
  return data;
}

function sampleRssNow(pids: number[]): Record<number, number> {
  if (process.platform !== 'win32') return {};
  try {
    const filter = pids.map((p) => `ProcessId=${p}`).join(' or ');
    const out = runPs(
      `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,WorkingSetSize | ConvertTo-Json`,
    );
    // ConvertTo-Json 单结果输出对象、多结果输出数组——归一为行数组
    const parsed = JSON.parse(out) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const data: Record<number, number> = {};
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const pid = Number((row as Record<string, unknown>)['ProcessId']);
      const ws = Number((row as Record<string, unknown>)['WorkingSetSize']);
      if (Number.isFinite(pid) && Number.isFinite(ws)) data[pid] = ws;
    }
    return data;
  } catch {
    return {}; // 采样失败降级空表(调用方视作无 RSS 数据)
  }
}

// ---------------------------------------------------------------------------
// 跨 server 租约存储(~/.godot-mcp/memory-leases.json)
// ---------------------------------------------------------------------------

interface LeaseFileShape { version: 1; leases: MemLease[]; }

let _leasesFilePathOverride: string | null = null;

/** 租约文件路径(默认 ~/.godot-mcp/memory-leases.json,机器级目录惯例——machine registry 同级)。 */
export function leasesFilePath(): string {
  return _leasesFilePathOverride ?? join(homedir(), '.godot-mcp', 'memory-leases.json');
}

/** 读租约:读失败(不存在/损坏/权限)/形态异常一律返回 []——fail-open,水位/计数查仍在(设计 §5④)。 */
function readLeases(): MemLease[] {
  try {
    const raw = readFileSync(leasesFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LeaseFileShape> | null;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.leases)) return [];
    return parsed.leases.filter(
      (l): l is MemLease => l !== null && typeof l === 'object' && typeof l.id === 'string',
    );
  } catch {
    return [];
  }
}

/** 写租约:ensureDir + 原子写;写失败记降级日志后继续,不抛(fail-open,设计 §5④)。 */
function writeLeases(leases: MemLease[]): void {
  try {
    const filePath = leasesFilePath();
    ensureDir(filePath);
    writeFileAtomic(filePath, JSON.stringify({ version: 1, leases } satisfies LeaseFileShape, null, 2));
  } catch (e) {
    getLogger().warn(
      'memory-guard',
      `MEMGUARD degraded: lease-store unavailable (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** pid 三态探测:process.kill(pid, 0) 成功/EPERM=alive(权限不足但进程存在),ESRCH=dead;
 *  其余未知错误保守视为 alive(防误删活租约,同 inflight.ts 判活惯例)。 */
export function killPidProbe(pid: number): 'alive' | 'dead' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

/** 读时清理并返回活跃租约。三规则:①pid 非 null 且死 → 删;②pid 为 null 且心跳超 90s → 删;
 *  ③pid 活(心跳陈旧也留——进程在即租约在,心跳仅兜底未绑 pid 阶段)。有清理才回写盘。 */
export function listActiveLeases(): MemLease[] {
  const leases = readLeases();
  const now = Date.now();
  const kept = leases.filter((l) => {
    if (l.pid !== null && l.pid !== undefined) {
      return killPidProbe(l.pid) === 'alive';
    }
    return now - l.lastHeartbeat <= LEASE_HEARTBEAT_STALE_MS;
  });
  if (kept.length !== leases.length) writeLeases(kept);
  return kept;
}

let _leaseSeq = 0;

/** 总开关关闭态的 dummy lease id(固定值,标识"守卫已关、恒 ok"的占位租约,不落盘)。 */
const DUMMY_LEASE_ID = 'guard-disabled';

/** 获取租约。Task 2 将在此实现准入三查(水位/预算/实例上限);本任务恒成功建租约。
 *  lease id 形如 p<serverPid>-<Date.now()>-<seq>(同 server 进程内单调递增)。
 *  I-1 审查修复:总开关关闭(GODOT_MCP_MEMORY_GUARD=0/false) → 恒 ok 返回 dummy 租约,
 *  不读不写租约文件(零落盘副作用)——治理关闭时上层 spawn 漏斗照常工作,租约机制整体旁路。 */
export function acquireLease(
  kind: SpawnKind,
  projectPath: string,
  opts?: { exemptChecks?: boolean },
): { lease: MemLease } | { denial: { code: 'MEMGUARD_LOW_WATER' | 'MEMGUARD_BUDGET' | 'MEMGUARD_INSTANCE_CAP'; message: string; inventory: MemLease[] } } {
  void opts; // exemptChecks(豁免位)由 Task 2 三查消费;本任务无检查可豁免
  if (!memoryGuardEnabled()) {
    const now = Date.now();
    return {
      lease: {
        id: DUMMY_LEASE_ID,
        serverPid: process.pid,
        kind,
        declaredMB: declaredMBFor(kind),
        projectPath,
        pid: null,
        startedAt: now,
        lastHeartbeat: now,
      } satisfies MemLease,
    };
  }
  const leases = listActiveLeases();
  const now = Date.now();
  const lease: MemLease = {
    id: `p${process.pid}-${now}-${_leaseSeq++}`,
    serverPid: process.pid,
    kind,
    declaredMB: declaredMBFor(kind),
    projectPath,
    pid: null,
    startedAt: now,
    lastHeartbeat: now,
  };
  writeLeases([...leases, lease]);
  return { lease };
}

/** 给租约绑定子进程 pid(建约时未绑,spawn 成功后回填;此后清理判定切换到 pid 探测)。
 *  dummy lease(总开关关闭态)无盘面实体,不可绑 pid → no-op(I-1)。 */
export function bindLeasePid(leaseId: string, pid: number): void {
  if (leaseId === DUMMY_LEASE_ID) return;
  const leases = listActiveLeases();
  const target = leases.find((l) => l.id === leaseId);
  if (target === undefined) return; // 租约已被清理/不存在 → 静默(幂等)
  target.pid = pid;
  writeLeases(leases);
}

/** 释放租约(幂等:租约不存在/已被清理时静默)。dummy lease 无盘面实体 → no-op,可重复调(I-1)。 */
export function releaseLease(leaseId: string): void {
  if (leaseId === DUMMY_LEASE_ID) return;
  const leases = listActiveLeases();
  const kept = leases.filter((l) => l.id !== leaseId);
  if (kept.length !== leases.length) writeLeases(kept);
}

/** 刷新本 serverPid 全部租约的 lastHeartbeat 并落盘(无本 server 租约时不写盘,避免空转 IO)。
 *  总开关关闭态本 server 不会有真实租约(dummy 不落盘)→ 心跳无对象,免读盘 no-op(I-1)。 */
export function heartbeatLeases(): void {
  if (!memoryGuardEnabled()) return;
  const leases = listActiveLeases();
  if (!leases.some((l) => l.serverPid === process.pid)) return;
  const now = Date.now();
  for (const l of leases) {
    if (l.serverPid === process.pid) l.lastHeartbeat = now;
  }
  writeLeases(leases);
}

// ---------------------------------------------------------------------------
// 测试注入钩子(单测不真起 PowerShell / 不触真实 ~/.godot-mcp)
// ---------------------------------------------------------------------------

/** 注入/恢复 PowerShell 执行器(传 null 恢复默认 spawnSync 实现)。 */
export function _setPsRunnerForTest(runner: PsScriptRunner | null): void {
  _psRunner = runner;
}

/** 注入/恢复租约文件路径(传 null 恢复默认 ~/.godot-mcp 路径)。 */
export function _setLeasesFilePathForTest(p: string | null): void {
  _leasesFilePathOverride = p;
}

/** 重置模块可变状态(env 开关缓存/快照缓存/RSS 缓存/租约序号),测试隔离用。 */
export function _resetForTest(): void {
  _enabledCache = null;
  _snapshotCache = null;
  _rssCache.clear();
  _leaseSeq = 0;
}
