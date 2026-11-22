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
//    治理层自身故障不得阻断工具链可用性;
//  - 二期 Task 3:整机硬阈值(默认 1536MB,0s 宽限)进 hard + 驱逐候选计算
//    (实测÷声明降序,preview/editor 殿后)——杀的执行在 mem-watchdog(消费方),
//    状态机与排序的唯一写者在本模块。

import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { freemem, homedir, totalmem } from 'os';
import { join } from 'path';
import { getLogger } from './logger.js';
import { ensureDir, writeFileAtomic } from './fs-atomic.js';
import { getSession } from './process-state.js';

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
/** pid 绑定宽限窗(5min,终审 I-1):acquire→spawn→bindLeasePid 正常流程毫秒级完成,
 *  超窗仍 pid=null 必为泄漏(spawn 同步抛未归还/bindLeasePid 竞态覆盖回 null)——
 *  heartbeatLeases 对其停续命,任其落入上方 90s 陈旧清理线,账本自愈。 */
const LEASE_PID_BIND_GRACE_MS = 5 * 60_000;
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
 *  仅 Windows;非 Windows/采样失败降级(commit 置 null、计数 0)并打 degraded 标记。
 *  opts.force=true 旁路缓存强制重采样并刷新缓存(二期 Task 3:驱逐循环「杀一个重采样」
 *  必须拿新鲜读数——10s 缓存会读到杀前旧值反复多杀,审查二期;缓存语义本体不变)。 */
export function getMachineMemorySnapshot(opts?: { force?: boolean }): MachineMemorySnapshot {
  const now = Date.now();
  if (!opts?.force && _snapshotCache !== null && now - _snapshotCache.at < SNAPSHOT_CACHE_TTL_MS) {
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

/** 批量采样进程 RSS(字节),async 门面(看门狗等异步消费方用)——实现在同步核心上,共享同一缓存。 */
export async function sampleRssBytes(pids: number[]): Promise<Record<number, number>> {
  return sampleRssBytesCached(pids);
}

/** 同步批量采样 RSS(10s 缓存,按 pid 集合键)——acquireLease 准入预算查是同步路径,直接用核心。
 *  Windows 走 Get-CimInstance Win32_Process 批量查询;非 Windows/失败/空集合 → 空 Record(不抛)。 */
function sampleRssBytesCached(pids: number[]): Record<number, number> {
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

// ---------------------------------------------------------------------------
// 整机软阈值 pressure 状态机(二期 Task 2)——唯一写者在本模块,watchdog 只喂快照消费
// ---------------------------------------------------------------------------

/** pressure 三态:normal(正常受理)/pressure(拒新保旧)/hard(硬阈值驱逐区,Task 3)。 */
export type PressureState = 'normal' | 'pressure' | 'hard';

/** 进压力去抖窗(30s):双口径任一低于软阈值须持续满 30s 才进 pressure——瞬时跌破不抖动。 */
const PRESSURE_ENTER_MS = 30_000;
/** 恢复去抖窗(5min):需连续 5min 双口径均高于软阈值才回 normal(中途再跌破重计)
 *  ——kubelet eviction-pressure-transition-period 同款语义,防状态在边界来回翻转。 */
const PRESSURE_RECOVER_MS = 5 * 60_000;
/** 硬阈值 minimum-reclaim 余量(MB,固定 2048):hard 态脱离须双口径均达「硬阈值+本值」
 *  ——一次杀够 2GB 余量防 1536MB 边缘反复杀(kubelet eviction-minimum-reclaim 映射),
 *  同时是驱逐循环的停止线(杀到该线即停,不全杀)。 */
const HARD_MIN_RECLAIM_MB = 2048;

let _pressureState: PressureState = 'normal';
let _pressureEnteredAt: number | null = null;
let _softBreachSince: number | null = null;
let _recoverSince: number | null = null;

/** 整机软阈值(MB):GODOT_MCP_MEM_PRESSURE_SOFT_MB,默认 3072——双口径(物理空闲/commit 余量)共用,
 *  与水位线 GODOT_MCP_MIN_FREE_MB 独立(水位是即时拒绝,软阈值是持续 30s 才拒新保旧)。 */
function pressureSoftMB(): number {
  return readPositiveIntEnv('GODOT_MCP_MEM_PRESSURE_SOFT_MB', 3072);
}

/** 整机硬阈值(MB):GODOT_MCP_MEM_PRESSURE_HARD_MB,默认 1536——双口径任一跌破即进
 *  hard(0s 宽限,与软阈值 30s 防抖不同:kubelet 硬驱逐语义,机器存活线不给宽限,
 *  跌破立即驱逐)。 */
function pressureHardMB(): number {
  return readPositiveIntEnv('GODOT_MCP_MEM_PRESSURE_HARD_MB', 1536);
}

/** 双口径任一低于软阈值即视为跌破(commit 降级 null 时只看物理口径,与水位查①同款)。 */
function isBelowSoftThreshold(snap: MachineMemorySnapshot, softBytes: number): boolean {
  if (snap.freePhysBytes < softBytes) return true;
  return snap.commitAvailBytes !== null && snap.commitAvailBytes < softBytes;
}

/** 喂快照推进 pressure 状态机(唯一写入口:watchdog pollOnce 每轮喂 + 驱逐循环杀后
 *  force 重采样喂 + 测试直调推进多轮)。
 *  状态机语义:
 *  - hard 进入(二期 Task 3):双口径任一低于硬阈值(默认 1536MB)→ 立即进 hard,
 *    0s 宽限(kubelet 硬驱逐语义,机器存活线不给宽限;杀由 watchdog 消费执行);
 *  - hard 脱离:双口径均达「硬阈值+minimum-reclaim 2048MB」→ 降 pressure(两级恢复,
 *    见下方恢复语义决定);未达线保持 hard;
 *  - normal 下跌破软阈值持续 30s → pressure;跌破后回升 → 去抖计时清零重来(瞬时跌破不触发);
 *  - pressure 态连续 5min 双口径高于软阈值 → normal;中途再跌破 → 恢复计时重计。
 *  进入线(硬阈值)与脱离线(硬阈值+2GB)刻意迟滞:防「杀一个刚过 1536 线 → 降级 →
 *  又跌破 → 再进」的边缘抖动环——minimum-reclaim 的存在意义。
 *  总开关关闭:整体旁路不更新(pressure 恒 normal 不拒绝,与一期 I-1 口径一致)。
 *  状态切换时 stderr 上报一行(对齐 MEMGUARD kill 惯例:stdout 是 stdio 模式 JSON-RPC 独占通道)。 */
export function updatePressureState(snap: MachineMemorySnapshot): void {
  if (!memoryGuardEnabled()) return;
  const now = Date.now();
  const softBytes = pressureSoftMB() * 1024 * 1024;
  const hardEnterBytes = pressureHardMB() * 1024 * 1024;
  const hardExitBytes = hardEnterBytes + HARD_MIN_RECLAIM_MB * 1024 * 1024;
  const below = isBelowSoftThreshold(snap, softBytes);

  // —— 硬阈值判定(先于软阈值机:硬驱逐区优先级最高)——
  const belowHardEnter = snap.freePhysBytes < hardEnterBytes
    || (snap.commitAvailBytes !== null && snap.commitAvailBytes < hardEnterBytes);
  const reachedHardExit = snap.freePhysBytes >= hardExitBytes
    && (snap.commitAvailBytes === null || snap.commitAvailBytes >= hardExitBytes);

  if (_pressureState === 'hard') {
    if (!reachedHardExit) return; // 仍处硬驱逐区:保持 hard(幂等,无日志)
    // 恢复语义决定(Task 2 审查 Minor-3 遗留,Task 3 裁定):hard 采用两级恢复——
    // 脱离硬阈值+minimum-reclaim 即降 pressure(事实态:不再深处硬区),pressure 再按
    // 5min 连续健康回 normal。不采「hard 挂到 5min 直回 normal」:hard 挂 5min 会让
    // 看门狗每轮 pollOnce 重进驱逐循环空转 force 采样(多余 PowerShell 开销);且
    // hard/pressure 拒新语义相同(acquireLease 查⓪ 均拒新),两级恢复零准入代价。
    _pressureState = 'pressure';
    _pressureEnteredAt = now;
    _softBreachSince = null;
    _recoverSince = null; // 恢复计时从降级时刻重起(落入下方软机起算)
    console.error(
      `MEMGUARD hard exit → pressure 物理空闲 ${fmtGB(snap.freePhysBytes)} ≥ 硬阈值 ${pressureHardMB()}MB` +
      `+minimum-reclaim ${HARD_MIN_RECLAIM_MB}MB——回拒新保旧(恢复 normal 需再连续 ${PRESSURE_RECOVER_MS / 1000}s 健康)`,
    );
    // 落入下方软阈值机:pressure 态继续按 below 推进恢复计时
  } else if (belowHardEnter) {
    // 任何态(normal/pressure)跌破硬阈值 → 立即 hard(0s 宽限;驱逐由 watchdog 执行)
    const prev = _pressureState;
    _pressureState = 'hard';
    _pressureEnteredAt = now;
    _softBreachSince = null;
    _recoverSince = null;
    const commitStr = snap.commitAvailBytes !== null ? fmtGB(snap.commitAvailBytes) : 'n/a';
    console.error(
      `MEMGUARD hard enter(prev=${prev}) 物理空闲 ${fmtGB(snap.freePhysBytes)}(commit ${commitStr})` +
      ` < 硬阈值 ${pressureHardMB()}MB——0s 宽限立即驱逐超声明租约(实测÷声明降序,watchdog 执行)`,
    );
    return;
  }

  if (_pressureState === 'normal') {
    if (!below) {
      _softBreachSince = null; // 回升 → 去抖计时清零(防瞬时跌破抖动)
      return;
    }
    if (_softBreachSince === null) {
      _softBreachSince = now; // 首次跌破起算
      return;
    }
    if (now - _softBreachSince >= PRESSURE_ENTER_MS) {
      _pressureState = 'pressure';
      _pressureEnteredAt = now;
      _softBreachSince = null;
      _recoverSince = null;
      const commitStr = snap.commitAvailBytes !== null ? fmtGB(snap.commitAvailBytes) : 'n/a';
      console.error(
        `MEMGUARD pressure enter 物理空闲 ${fmtGB(snap.freePhysBytes)}(commit ${commitStr})` +
        ` < 软阈值 ${pressureSoftMB()}MB 持续 ${PRESSURE_ENTER_MS / 1000}s——拒新保旧(在跑租约不动)`,
      );
    }
    return;
  }

  // pressure 态:恢复需连续 5min 高于软阈值,中途跌破恢复计时重计(hard 已在上方专属分支分流)
  if (!below) {
    if (_recoverSince === null) {
      _recoverSince = now; // 回升起算 5min 恢复去抖
    } else if (now - _recoverSince >= PRESSURE_RECOVER_MS) {
      const prevState = _pressureState;
      _pressureState = 'normal';
      _pressureEnteredAt = null;
      _recoverSince = null;
      console.error(
        `MEMGUARD pressure exit(prev=${prevState}) 连续 ${PRESSURE_RECOVER_MS / 1000}s` +
        ` 高于软阈值 ${pressureSoftMB()}MB,恢复受理新 spawn`,
      );
    }
  } else {
    _recoverSince = null; // 再跌破 → 5min 恢复计时重计
  }
}

/** 当前 pressure 状态(hard=处硬驱逐区:跌破硬阈值进入,达硬阈值+minimum-reclaim 才脱离)。 */
export function getPressureState(): PressureState {
  return _pressureState;
}

/** 进入 pressure/hard 的时间戳(normal 态为 null)——上报/诊断消费。 */
export function getPressureEnteredAt(): number | null {
  return _pressureEnteredAt;
}

// ---------------------------------------------------------------------------
// 硬阈值驱逐候选计算(二期 Task 3)——排序语义单点在本模块,watchdog 只消费最终序
// ---------------------------------------------------------------------------

/** 驱逐候选清单(二期 Task 3):本 server 活跃租约(pid 已绑)按「实测 RSS ÷ 声明 MB」
 *  降序——超声明预算最多者先杀;preview 会话(game_window 且 process-state 会话桶
 *  preview===true)与 editor kind 整组殿后(豁免优先级最低先杀序,设计 §L2「驱逐排序
 *  最后」;殿后≠永不杀——硬阈值杀光普通候选仍不够时按组内 ratio 序继续)。
 *  preview 桥接归属本模块而非 watchdog 组合:排序语义单点完整,消费方拿到即最终序,
 *  无需二次重排;依赖方向 memory-guard → process-state 安全(反向无 import,不成环),
 *  会话匹配键 = normalizeProjectKey(与 run_project 建桶同键;getSession 内部归一,
 *  无会话/非 preview 的 game_window 视为普通候选)。
 *  外部进程(用户手开的编辑器/游戏,无租约 pid)天然不在集合——候选只来自租约账本,
 *  且仅本 serverPid(各 server 看门狗各管各的,一期管辖口径)。
 *  RSS 走 sampleRssBytesCached(与准入共享 10s 缓存);无读数租约 ratio 记 0 仍进候选
 *  (排最后:读不到≠不占内存,杀光有读数者仍不够时可杀它;候选耗尽则诚实上报,不误报
 *  「无可驱逐」)。declaredMB 恒 >0(档位/env 守卫),Math.max(1,·) 仅防御脏账本。 */
export function getEvictionCandidates(): Array<{ lease: MemLease; ratio: number }> {
  const leases = listActiveLeases().filter(
    (l) => l.serverPid === process.pid && typeof l.pid === 'number',
  );
  const rssMap = sampleRssBytesCached(leasePids(leases));
  const rows = leases.map((l) => {
    const rss = rssMap[l.pid as number];
    const ratio = rss !== undefined ? rss / 1024 / 1024 / Math.max(1, l.declaredMB) : 0;
    const exempt = l.kind === 'editor'
      || (l.kind === 'game_window' && getSession(l.projectPath)?.preview === true);
    return { lease: l, ratio, exempt };
  });
  rows.sort((a, b) => (a.exempt === b.exempt ? b.ratio - a.ratio : a.exempt ? 1 : -1));
  return rows.map(({ lease, ratio }) => ({ lease, ratio }));
}

// ---------------------------------------------------------------------------
// 准入三查(Task 2):env 阈值 + 占用统计 + 拒绝报文
// ---------------------------------------------------------------------------

/** 拒绝码:水位 / 声明预算 / 机器实例计数。 */
type DenialCode = 'MEMGUARD_LOW_WATER' | 'MEMGUARD_BUDGET' | 'MEMGUARD_INSTANCE_CAP';

/** 正整数 env 读取(拒析回默认,对齐 declaredMBFor 惯例;max 收紧上限)。低频调用不缓存。 */
function readPositiveIntEnv(name: string, def: number, max?: number): number {
  const raw = process.env[name];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && (max === undefined || n <= max)) return n;
  }
  return def;
}

/** 水位线下限(MB):GODOT_MCP_MIN_FREE_MB,默认 3072——物理空闲与 commit 余量两口径共用。
 *  Task 5 起导出:doctor 可见性行消费(与准入判定同源,防两处阈值漂移)。 */
export function minFreeMB(): number {
  return readPositiveIntEnv('GODOT_MCP_MIN_FREE_MB', 3072);
}

/** 内存预算百分比:GODOT_MCP_MEM_BUDGET_PCT,默认 67(合法区间 1-100)。
 *  Task 5 起导出:doctor 可见性行消费(同上)。 */
export function budgetPct(): number {
  return readPositiveIntEnv('GODOT_MCP_MEM_BUDGET_PCT', 67, 100);
}

/** 机器级 Godot 实例上限:GODOT_MCP_MAX_MACHINE_INSTANCES,默认 8。 */
function maxMachineInstances(): number {
  return readPositiveIntEnv('GODOT_MCP_MAX_MACHINE_INSTANCES', 8);
}

/** 字节数 → 「X.Y GB」展示。 */
function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** MB(可浮点)→ 「X.Y GB」展示。 */
function fmtMBasGB(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 租约 pid 提取(未绑/异常缺字段的不进 RSS 采样集合)。 */
function leasePids(leases: MemLease[]): number[] {
  return leases.filter((l) => l.pid !== null && l.pid !== undefined).map((l) => l.pid as number);
}

/** 拒绝/预算共用的占用统计:实测 RSS 批量采样(10s 缓存)+ Σ max(声明MB, 实测RSS_MB)。
 *  实测取 max 是防声明低估——声明 1GB 实跑 5GB 的租约按 5GB 占预算(设计层审查修正)。 */
function leaseUsageCtx(leases: MemLease[], kind: SpawnKind): {
  rssMap: Record<number, number>;
  usedMB: number;
  needMB: number;
} {
  const rssMap = sampleRssBytesCached(leasePids(leases));
  const usedMB = leases.reduce((sum, l) => {
    const rss = l.pid !== null && l.pid !== undefined ? rssMap[l.pid] : undefined;
    return sum + Math.max(l.declaredMB, rss !== undefined ? rss / 1024 / 1024 : 0);
  }, 0);
  return { rssMap, usedMB, needMB: declaredMBFor(kind) };
}

/** 拒绝报文(Bazel 语义:一句话原因 + 机器读数 + 占用清单 + 可操作建议,让调用方/用户能自行动作)。 */
function buildDenial(
  code: DenialCode,
  reason: string,
  kind: SpawnKind,
  projectPath: string,
  snap: MachineMemorySnapshot,
  leases: MemLease[],
  ctx: { rssMap: Record<number, number>; usedMB: number; needMB: number },
): { code: DenialCode; message: string; inventory: MemLease[] } {
  const commitStr = snap.commitAvailBytes !== null ? fmtGB(snap.commitAvailBytes) : 'n/a';
  const inventory = leases.length === 0
    ? '(无)'
    : leases
        .map((l) => {
          const rss = l.pid !== null && l.pid !== undefined ? ctx.rssMap[l.pid] : undefined;
          const rssStr = rss !== undefined ? `${Math.round(rss / 1024 / 1024)}MB` : '-';
          return `pid=${l.pid ?? '-'} kind=${l.kind} project=${l.projectPath} 声明=${l.declaredMB}MB 实测=${rssStr}`;
        })
        .join('; ');
  const message =
    `[${code}] 拒绝 spawn(${kind},${projectPath}):${reason}。` +
    `当前机器: 可用 ${fmtGB(snap.freePhysBytes)}/${fmtGB(snap.totalPhysBytes)} (commit ${commitStr}), ` +
    `预算 ${budgetPct()}% 已占用 ${fmtMBasGB(ctx.usedMB)}(本 kind 需 ${fmtMBasGB(ctx.needMB)}), ` +
    `Godot 进程 ${snap.godotProcCount}。占用清单: ${inventory}。` +
    `建议: stop_project 释放 / 稍后重试 / GODOT_MCP_MEMORY_GUARD=0 豁免(风险自担)`;
  return { code, message, inventory: leases };
}

/** 获取租约(准入三查,Task 2;二期 Task 2 增查⓪):启用路径建租约前依次过——
 *  ⓪ 整机软阈值 pressure(二期 Task 2):状态机持续 30s 跌破 GODOT_MCP_MEM_PRESSURE_SOFT_MB
 *     (默认 3072MB) → 拒新保旧——在跑任务与既有租约不动(杀是硬阈值 Task 3 的事),
 *     code 复用 MEMGUARD_LOW_WATER(retryable);
 *  ① 水位双口径:物理空闲与 commit 余量(非 null 时)均须 ≥ GODOT_MCP_MIN_FREE_MB(默认 3072MB);
 *  ② 声明预算:Σ max(租约声明MB, 实测RSS_MB) + 本 kind 声明 ≤ GODOT_MCP_MEM_BUDGET_PCT%(默认 67)×物理总量;
 *  ③ 机器实例计数:godotProcCount ≤ GODOT_MCP_MAX_MACHINE_INSTANCES(默认 8;非 Windows 无计数通道
 *     (计数恒 0 且 degraded)时跳过,不误拦)。任一不过 → 快拒绝,附占用清单与可操作建议。
 *  opts.exemptChecks=true 跳全部查直接建租约(editor 用——用户显式起编辑器不受机器水位约束)。
 *  lease id 形如 p<serverPid>-<Date.now()>-<seq>(同 server 进程内单调递增)。
 *  I-1 审查修复:总开关关闭(GODOT_MCP_MEMORY_GUARD=0/false) → 恒 ok 返回 dummy 租约,
 *  不读不写租约文件(零落盘副作用)——治理关闭时上层 spawn 漏斗照常工作,租约机制整体旁路。 */
export function acquireLease(
  kind: SpawnKind,
  projectPath: string,
  opts?: { exemptChecks?: boolean },
): { lease: MemLease } | { denial: { code: DenialCode; message: string; inventory: MemLease[] } } {
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
  if (opts?.exemptChecks !== true) {
    const snap = getMachineMemorySnapshot();

    // 查⓪ 整机软阈值 pressure(二期 Task 2):状态机非 normal(pressure;hard 为 Task 3
    // 占位,进入后同样拒新)→ 拒新保旧。与查① 的区别:水位是即时读数拒,这里是
    // 「持续 30s 跌破」的历史状态拒(状态机记忆,由 watchdog 喂快照维护)——瞬时
    // 毛刺由查① 兜住,持续吃紧由本查兜住,在跑任务与既有租约一律不动。
    if (getPressureState() !== 'normal') {
      const ctx = leaseUsageCtx(leases, kind); // 拒绝报文要占用清单与实测(与后续查共享 10s 缓存)
      return {
        denial: buildDenial(
          'MEMGUARD_LOW_WATER', '整机内存压力(软阈值)持续 30s——拒新保旧',
          kind, projectPath, snap, leases, ctx,
        ),
      };
    }

    // 查① 水位(双口径,最便宜先查——纯数值比较,快照已有 10s 缓存;commit 降级 null 时只查物理口径)
    const minFree = minFreeMB();
    const minFreeBytes = minFree * 1024 * 1024;
    const physLow = snap.freePhysBytes < minFreeBytes;
    const commitLow = snap.commitAvailBytes !== null && snap.commitAvailBytes < minFreeBytes;
    if (physLow || commitLow) {
      const low: string[] = [];
      if (physLow) low.push(`物理空闲 ${fmtGB(snap.freePhysBytes)}`);
      if (commitLow) low.push(`commit 余量 ${fmtGB(snap.commitAvailBytes!)}`);
      const ctx = leaseUsageCtx(leases, kind); // 拒绝报文要占用清单与实测,10s 缓存与后续查共享
      return {
        denial: buildDenial(
          'MEMGUARD_LOW_WATER', `${low.join(' 与 ')}低于水位线 ${minFree} MB`,
          kind, projectPath, snap, leases, ctx,
        ),
      };
    }

    // 查② 声明预算(防声明低估:实测 RSS 与声明取大者计占用)
    const ctx = leaseUsageCtx(leases, kind);
    const pct = budgetPct();
    const budgetMB = (snap.totalPhysBytes / 1024 / 1024) * (pct / 100);
    if (ctx.usedMB + ctx.needMB > budgetMB) {
      return {
        denial: buildDenial(
          'MEMGUARD_BUDGET',
          `声明预算超限:已占用 ${fmtMBasGB(ctx.usedMB)} + 本 kind 需 ${fmtMBasGB(ctx.needMB)},超过 ${pct}% 预算上限 ${fmtMBasGB(budgetMB)}`,
          kind, projectPath, snap, leases, ctx,
        ),
      };
    }

    // 查③ 机器实例计数(非 Windows 无计数通道:计数恒 0 且 degraded → 跳过,不误拦)
    const cap = maxMachineInstances();
    const skipCount = snap.godotProcCount === 0 && snap.degraded === 'non-windows';
    if (!skipCount && snap.godotProcCount > cap) {
      return {
        denial: buildDenial(
          'MEMGUARD_INSTANCE_CAP', `Godot 进程数 ${snap.godotProcCount} 超过机器实例上限 ${cap}`,
          kind, projectPath, snap, leases, ctx,
        ),
      };
    }
  }
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

/** 从 spawn args 解析 --path 后随值作租约记账的 projectPath(Task 4 漏斗共用——
 *  runGutProcess/spawnGodot/runHeadlessCollector/runScreenshot 的调用方全部以
 *  ['--headless', '--path', <dir>, ...] 形态传参,解析注入让消费方零改动)。
 *  无 --path 或其后无值时返回占位 '(no-path)'(仅记账展示用,不参与判定的键)。 */
export function projectPathFromArgs(args: readonly string[]): string {
  const idx = args.indexOf('--path');
  const v = idx >= 0 ? args[idx + 1] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : '(no-path)';
}

/** 释放租约(幂等:租约不存在/已被清理时静默)。dummy lease 无盘面实体 → no-op,可重复调(I-1)。 */
export function releaseLease(leaseId: string): void {
  if (leaseId === DUMMY_LEASE_ID) return;
  const leases = listActiveLeases();
  const kept = leases.filter((l) => l.id !== leaseId);
  if (kept.length !== leases.length) writeLeases(kept);
}

/** 刷新本 serverPid 全部租约的 lastHeartbeat 并落盘(无本 server 租约时不写盘,避免空转 IO)。
 *  总开关关闭态本 server 不会有真实租约(dummy 不落盘)→ 心跳无对象,免读盘 no-op(I-1)。
 *  终审 I-1 修复:pid=null 且 startedAt 超宽限窗(LEASE_PID_BIND_GRACE_MS)的租约**停续命**
 *  (不刷新 lastHeartbeat)——防泄漏/竞态产的无 pid 租约被 60s 心跳无限续命、90s 陈旧清理线
 *  永不到期(账本污染直至 server 重启);停续命后其心跳自然陈旧,被 listActiveLeases 读时清理。 */
export function heartbeatLeases(): void {
  if (!memoryGuardEnabled()) return;
  const leases = listActiveLeases();
  if (!leases.some((l) => l.serverPid === process.pid)) return;
  const now = Date.now();
  for (const l of leases) {
    if (l.serverPid !== process.pid) continue;
    if ((l.pid === null || l.pid === undefined) && now - l.startedAt > LEASE_PID_BIND_GRACE_MS) continue;
    l.lastHeartbeat = now;
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

// ---------------------------------------------------------------------------
// L3 内存面板数据(二期 Task 5)——doctor / godot_get_context 共享聚合单源(防两处漂移)
// ---------------------------------------------------------------------------

/** 面板活跃实例行:租约条目(本 server spawn,有 kind/声明)与 registry 心跳条目(游戏侧
 *  autoload 写入,含外部手开实例)按 pid 对齐合并;「最后交互」取 Task 1 会话桶 lastPokeAt;
 *  实测 RSS 由 TS 侧按 pid 走一期 sampleRssBytesCached(10s 缓存与准入/驱逐共享——
 *  不动 GD 心跳结构,审查降本裁定)。 */
export interface MemoryPanelInstance {
  pid: number | null;
  project: string;
  kind: SpawnKind | null;      // 仅租约条目有(registry-only = 外部实例无租约记账)
  declaredMB: number | null;   // 仅租约条目有
  rssMB: number | null;        // WMI 采样命中才有(失败/非 Windows/进程刚退 → null 诚实呈现)
  lastPokeAt: number | null;   // 本 server 会话桶命中才有(非 run_project 会话 → null)
  source: 'lease' | 'registry' | 'both';
}

/** L3 面板数据(spec §L3 四组字段):双口径水位 / 预算与已占用 / pressure 状态 / 活跃实例表。
 *  guard=0 时面板照常返回——只读观测不吃总开关(pressure 恒 normal 与空账本是关闭态真实呈现)。 */
export interface MemoryPanelData {
  guard: boolean;
  watermarkMB: number;         // 准入水位线(与判定同源,doctor/get_context 展示不重复读 env)
  pressure: { state: PressureState; enteredAt: number | null };
  machine: MachineMemorySnapshot;
  budget: { pct: number; budgetMB: number; usedMB: number; leaseCount: number };
  instances: MemoryPanelInstance[];
}

/** 读 machine registry 心跳条目(~/.godot-mcp/instances/*.json,游戏侧 mcp_bridge autoload
 *  30s 周期写入)——面板活跃实例表的第二数据源(外部手开游戏不在本 server 租约内,只在此可见)。
 *  capabilities 过滤 registry-heartbeat(排除 TS server 自注册条目,与 bridge-client
 *  liveHeartbeatPortsFor 同语义);目录语义与 machineRegistryInstancesDir 一致(env
 *  GODOT_MCP_BRIDGE_REGISTRY_DIR 可重定向)——本地复刻三行判定而非 import bridge-client
 *  (巨型模块,CLI doctor 不背其依赖面)。registry 不可读/条目损坏 → [](观测降级,不抛)。 */
function readRegistryHeartbeatEntries(): Array<{ pid: number; projectPath: string }> {
  const override = process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  const dir = override && override.trim() !== ''
    ? override
    : join(homedir(), '.godot-mcp', 'instances');
  const out: Array<{ pid: number; projectPath: string }> = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
        const pid = Number(entry['pid']);
        const projectPath = entry['projectPath'];
        const caps = entry['capabilities'];
        if (!Number.isFinite(pid) || pid <= 0) continue;
        if (typeof projectPath !== 'string' || projectPath.length === 0) continue;
        if (!Array.isArray(caps) || !caps.includes('registry-heartbeat')) continue;
        out.push({ pid, projectPath });
      } catch { /* 单条损坏跳过(观测降级) */ }
    }
  } catch { /* 目录不可读 → 空集(观测降级) */ }
  return out;
}

/** 总开关关闭态的轻量快照(os 内置读数,WMI 通道旁路)——guard=0 时面板照常返回但不
 *  起 PowerShell:commit 双口径与 Godot 计数降级 null/0(与 non-windows 降级同语义,
 *  零开销零副作用)。test/setup.js 全局 GODOT_MCP_MEMORY_GUARD='0' 的「未 mock 守卫的
 *  其余测试零 PowerShell/零租约写盘」约定(Task 4 起)因此对 get_context 调用链保持成立。 */
function lightSnapshotWithoutWmi(): MachineMemorySnapshot {
  return {
    freePhysBytes: freemem(), totalPhysBytes: totalmem(),
    commitAvailBytes: null, commitTotalBytes: null,
    godotProcCount: 0, sampledAt: Date.now(),
  };
}

/** L3 面板聚合(spec §L3):一次调用返回 doctor / godot_get_context 共用的面板数据。
 *  采样开销:快照与 RSS 均走既有 10s 缓存(与准入/驱逐共享,无重复 PowerShell)。
 *  实例表合并语义:租约按 pid(未绑 pid 用 lease id 占位键)→ registry 心跳按 pid 对齐,
 *  同 pid 合并单行 source=both(kind/声明来自租约);registry 条目 pid 已死不显示(GD 侧
 *  自清前的窗口,与租约读时清理同语义);usedMB = Σ max(声明MB, 实测RSS_MB)(一期
 *  leaseUsageCtx 同源口径,防声明低估)。排序按 pid 升序(展示稳定)。
 *  guard=0:面板照常返回(只读观测不吃总开关,pressure 恒 normal 与空账本是关闭态真实
 *  呈现),但 WMI 观测通道随治理旁路——快照走 os 内置(commit/计数降级)、RSS 不采样。 */
export function buildMemoryPanel(): MemoryPanelData {
  const guardOn = memoryGuardEnabled();
  const snap = guardOn ? getMachineMemorySnapshot() : lightSnapshotWithoutWmi();
  const leases = listActiveLeases();
  const registry = readRegistryHeartbeatEntries();

  // 行收集:租约先行(registry 对齐时升级 source=both)
  const rows = new Map<number | string, MemoryPanelInstance>();
  for (const l of leases) {
    const key = typeof l.pid === 'number' ? l.pid : `lease:${l.id}`;
    rows.set(key, {
      pid: typeof l.pid === 'number' ? l.pid : null,
      project: l.projectPath,
      kind: l.kind,
      declaredMB: l.declaredMB,
      rssMB: null,
      lastPokeAt: getSession(l.projectPath)?.lastPokeAt ?? null,
      source: 'lease',
    });
  }
  for (const r of registry) {
    const existing = rows.get(r.pid);
    if (existing !== undefined) { existing.source = 'both'; continue; }
    if (killPidProbe(r.pid) === 'dead') continue; // 死心跳条目不显示(GD 自清前窗口)
    rows.set(r.pid, {
      pid: r.pid,
      project: r.projectPath,
      kind: null,
      declaredMB: null,
      rssMB: null,
      lastPokeAt: getSession(r.projectPath)?.lastPokeAt ?? null,
      source: 'registry',
    });
  }

  // RSS 批量采样:全部非 null pid 一次采样(10s 缓存,与准入/驱逐共享);guard=0 旁路
  // (零 PowerShell,rssMB 恒 null——观测通道随治理关闭的诚实呈现)
  const pids = [...rows.values()].filter((r): r is MemoryPanelInstance & { pid: number } => typeof r.pid === 'number').map((r) => r.pid);
  const rssMap = guardOn ? sampleRssBytesCached(pids) : {};
  for (const row of rows.values()) {
    if (row.pid === null) continue;
    const rss = rssMap[row.pid];
    if (rss !== undefined) row.rssMB = Math.round(rss / 1024 / 1024);
  }

  // 预算占用:Σ max(声明MB, 实测RSS_MB)——与一期 leaseUsageCtx 同源口径
  const usedMB = leases.reduce((sum, l) => {
    const rss = typeof l.pid === 'number' ? rssMap[l.pid] : undefined;
    return sum + Math.max(l.declaredMB, rss !== undefined ? rss / 1024 / 1024 : 0);
  }, 0);
  const pct = budgetPct();
  const budgetMB = Math.round((snap.totalPhysBytes / 1024 / 1024) * (pct / 100));

  const instances = [...rows.values()].sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0));
  return {
    guard: guardOn,
    watermarkMB: minFreeMB(),
    pressure: { state: getPressureState(), enteredAt: getPressureEnteredAt() },
    machine: snap,
    budget: { pct, budgetMB, usedMB, leaseCount: leases.length },
    instances,
  };
}

/** 注入/恢复租约文件路径(传 null 恢复默认 ~/.godot-mcp 路径)。 */
export function _setLeasesFilePathForTest(p: string | null): void {
  _leasesFilePathOverride = p;
}

/** 重置模块可变状态(env 开关缓存/快照缓存/RSS 缓存/租约序号/pressure 状态机),测试隔离用。 */
export function _resetForTest(): void {
  _enabledCache = null;
  _snapshotCache = null;
  _rssCache.clear();
  _leaseSeq = 0;
  _pressureState = 'normal';
  _pressureEnteredAt = null;
  _softBreachSince = null;
  _recoverSince = null;
}
