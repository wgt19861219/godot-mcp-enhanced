// src/core/mem-watchdog.ts
//
// 内存治理一期 Task 3:看门狗——10s 周期采样本 server 租约 PID 的 WorkingSet,
// 任一实测 RSS 超「声明MB × KILL_FACTOR[kind]」即树杀 + 释放租约 + 归因记录
// (wasMemKilled,保留 10min,Task 5 归因接线消费),kubelet 检查点语义(设计 L2)。
//
// 设计要点(docs/superpowers/specs/2026-11-22-memory-guard-design.md):
//  - 只管本 serverPid 的租约(各 server 看门狗各管各的;用户手开的外部进程永不杀);
//  - RSS 采样走 memory-guard 的 async 门面(与准入共享 10s 缓存——Task 2 审查 M-1:
//    轮询与准入互击时缓存兜住,单轮成本有界);
//  - 树杀复用 process-state 既有 kill 链 killPidTree(Windows taskkill /F /T /PID,
//    POSIX pkill -P + SIGTERM,双平台树杀语义,brief 授权的复用路径);
//  - 降级(采样抛错/读数全空):本轮跳过不判杀,连续 3 轮失败退避 30s 并记一次日志;
//  - 总开关关闭(GODOT_MCP_MEMORY_GUARD=0/false):startWatchdog no-op、pollOnce 不杀。

import { killPidTree } from './process-state.js';
import { getLogger } from './logger.js';
import {
  killPidProbe,
  listActiveLeases,
  memoryGuardEnabled,
  releaseLease,
  sampleRssBytes,
  type MemLease,
  type SpawnKind,
} from './memory-guard.js';

/** 单进程杀线系数:实测 RSS > 声明MB × 系数 即杀。
 *  headless/gut_shard ×2(治炸弹,GUT 8GB 声明→16GB 杀);game_window/editor ×3
 *  (合法重会话余量,游戏实测可至 7GB,3GB×3=9GB 不误杀)——设计 §5 单进程杀系数裁定。 */
export const KILL_FACTOR: Record<SpawnKind, number> = {
  headless: 2, gut_shard: 2, game_window: 3, editor: 3,
};

/** 归因记录保留窗口(10min):杀后工具调用失败路径(Task 5)查 wasMemKilled 报
 *  MEM_BUDGET_EXCEEDED;过期记录不可信(pid 会被 OS 复用)。 */
const ATTRIBUTION_TTL_MS = 10 * 60 * 1000;
/** 采样降级阈值:连续 N 轮失败进入退避。 */
const DEGRADE_THRESHOLD = 3;
/** 降级退避窗口(30s):期间轮询 tick 跳过,降低无效采样开销。 */
const DEGRADE_BACKOFF_MS = 30_000;

const MB = 1024 * 1024;

interface KillAttribution { readingBytes: number; declaredMB: number; kind: SpawnKind; at: number; }

let _timer: ReturnType<typeof setInterval> | null = null;
let _consecutiveDegrades = 0;
let _backoffUntil = 0;
const _attributions = new Map<number, KillAttribution>();

/** 字节数 → 「X.Y GB」展示(与 memory-guard 拒绝报文同格式)。 */
function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 轮询间隔秒数:clamp(GODOT_MCP_MEM_POLL_SECONDS,5,3600),默认 10——下限 5s
 *  因每次采样有 PowerShell 进程开销(设计 L2);非法/未设回默认。 */
function pollIntervalSeconds(): number {
  const raw = Number.parseInt(process.env.GODOT_MCP_MEM_POLL_SECONDS ?? '', 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(3600, Math.max(5, raw));
}

/** 记一轮采样降级:首次达到阈值记一次日志并进入 30s 退避;持续失败持续续期退避窗
 *  (日志不重复——退避期间 tick 跳过,恢复后首轮若又失败即再续期,不刷屏)。 */
function noteDegrade(): void {
  _consecutiveDegrades++;
  if (_consecutiveDegrades >= DEGRADE_THRESHOLD) {
    if (_consecutiveDegrades === DEGRADE_THRESHOLD) {
      getLogger().warn(
        'mem-watchdog',
        `MEMGUARD degraded: 连续 ${DEGRADE_THRESHOLD} 轮 RSS 采样失败,轮询退避 ${DEGRADE_BACKOFF_MS / 1000}s(采样通道不可用,跳过判杀不误杀)`,
      );
    }
    _backoffUntil = Date.now() + DEGRADE_BACKOFF_MS;
  }
}

/** 单轮看门狗(测试直调;startWatchdog 周期驱动):取本 serverPid 的活跃租约(pid 已绑)
 *  → 批量采样 RSS → 任一超「声明×系数」→ 树杀+释放租约+归因+一行 stderr。返回
 *  {checked=本轮照看的租约数, killed=实际树杀数}。总开关关闭 → 不读不杀恒零。
 *  降级(抛错/读数全空)→ 本轮跳过判杀(计数见 noteDegrade);部分 pid 无读数不判杀。 */
export async function pollOnce(): Promise<{ checked: number; killed: number }> {
  if (!memoryGuardEnabled()) return { checked: 0, killed: 0 };
  const leases = listActiveLeases().filter(
    (l) => l.serverPid === process.pid && typeof l.pid === 'number',
  );
  const pids = leases.map((l) => l.pid as number);
  let rssMap: Record<number, number>;
  try {
    rssMap = await sampleRssBytes(pids);
  } catch {
    noteDegrade(); // 采样通道抛错:本轮跳过,看门狗自身故障不崩主循环
    return { checked: leases.length, killed: 0 };
  }
  if (pids.length > 0 && Object.keys(rssMap).length === 0) {
    noteDegrade(); // 读数全空 = 采样通道失败降级(PowerShell 失败/非 Windows 恒空)
    return { checked: leases.length, killed: 0 };
  }
  _consecutiveDegrades = 0; // 拿到读数(哪怕部分)即视为通道健康,降级计数清零
  let killed = 0;
  for (const lease of leases) {
    const pid = lease.pid as number;
    const rss = rssMap[pid];
    if (rss === undefined) continue; // 无读数不判杀(防误杀:刚退出的进程拿不到读数)
    const factor = KILL_FACTOR[lease.kind] ?? 2;
    if (rss <= lease.declaredMB * MB * factor) continue;
    if (killOverBudget(lease, rss)) killed++;
  }
  return { checked: leases.length, killed };
}

/** 树杀一笔超预算租约,返回是否真执行了树杀:杀前再探活(进程已自己退出 →
 *  taskkill 必失败,仅清租约不记归因——不是看门狗杀的,工具调用失败路径不应报
 *  MEM_BUDGET_EXCEEDED,返回 false);活 → killPidTree 树杀 + releaseLease + 归因 +
 *  一行 MEMGUARD kill(返回 true)。输出走 console.error(stderr):stdout 是 stdio
 *  模式独占 JSON-RPC 通道,console.log 被 lint 门禁禁用(批次1-1),人类可读输出
 *  按门禁指引进 stderr。 */
function killOverBudget(lease: MemLease, readingBytes: number): boolean {
  const pid = lease.pid as number;
  if (killPidProbe(pid) === 'dead') {
    releaseLease(lease.id);
    return false;
  }
  const factor = KILL_FACTOR[lease.kind] ?? 2;
  const budgetBytes = lease.declaredMB * MB * factor;
  killPidTree(pid);
  releaseLease(lease.id);
  _attributions.set(pid, { readingBytes, declaredMB: lease.declaredMB, kind: lease.kind, at: Date.now() });
  console.error(`MEMGUARD kill ${pid} kind=${lease.kind} rss=${fmtGB(readingBytes)} budget=${fmtGB(budgetBytes)}`);
  return true;
}

/** 归因查询(保留 10min):命中返回杀时读数/声明/类型,供工具调用失败路径报
 *  MEM_BUDGET_EXCEEDED(Task 5 接线);过期/未涉及返回 null(过期记录惰性清理)。 */
export function wasMemKilled(pid: number): { readingBytes: number; declaredMB: number; kind: SpawnKind } | null {
  const rec = _attributions.get(pid);
  if (rec === undefined) return null;
  if (Date.now() - rec.at > ATTRIBUTION_TTL_MS) {
    _attributions.delete(pid);
    return null;
  }
  return { readingBytes: rec.readingBytes, declaredMB: rec.declaredMB, kind: rec.kind };
}

/** 启动看门狗轮询(幂等):间隔 = clamp(GODOT_MCP_MEM_POLL_SECONDS,5,3600) 默认 10s;
 *  降级退避窗口内 tick 跳过;timer unref 不阻塞进程退出;总开关关闭 → no-op。 */
export function startWatchdog(): void {
  if (_timer !== null) return; // 幂等:重复调用不叠加 timer
  if (!memoryGuardEnabled()) return; // 总开关关闭:看门狗不启动
  _timer = setInterval(() => {
    if (Date.now() < _backoffUntil) return; // 降级退避窗口内:本轮跳过
    void pollOnce().catch(() => { /* pollOnce 已内吞采样错,此处兜底防 unhandled rejection */ });
  }, pollIntervalSeconds() * 1000);
  _timer.unref?.();
}

/** 停止看门狗轮询(GodotServer.close/测试用,幂等)。 */
export function stopWatchdog(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** 重置模块可变状态(timer/降级计数/归因记录),测试隔离用。 */
export function _resetWatchdogForTest(): void {
  stopWatchdog();
  _consecutiveDegrades = 0;
  _backoffUntil = 0;
  _attributions.clear();
}
