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
//  - 总开关关闭(GODOT_MCP_MEMORY_GUARD=0/false):startWatchdog no-op、pollOnce 不杀;
//  - 二期 Task 2:pollOnce 每轮把整机快照喂给 memory-guard 的 pressure 状态机
//    (拒新保旧的软阈值判定;状态机唯一写者在 memory-guard,本模块只消费不拥有状态);
//  - 二期 Task 3:hard 态(整机硬阈值,默认 1536MB,0s 宽限)进驱逐循环——逐个树杀
//    候选(实测÷声明降序,preview/editor 殿后,排序唯一写者在 memory-guard),杀一个
//    force 重采样再判,杀到脱离硬阈值+minimum-reclaim 2GB 即停;租约耗尽仍低压诚实上报。
//  - 三期 Task 1:GODOT_MCP_WATCHDOG_EXEMPT 命中组(preview/editor)剔出驱逐候选
//    (过滤在 memory-guard 的 getEvictionCandidates 单点);候选耗尽报文附豁免计数。
//  - 四期 Task 5(T3-M-3 清偿):三类杀事件(budget_kill/evict/evict_exhausted)在采样行
//    之外双写机器级审计 ~/.godot-mcp/machine-audit.jsonl(跨 server 杀可见性)。两通道
//    独立:审计不经 isAuditEnabled(「杀」类事件机器级恒写的既有契约),审计写失败不影响
//    杀与采样。
//
// 驱逐边界声明(Docker 反模式禁令,设计 §L2):preview/editor 殿后≠永不杀;单进程硬帽
// (声明×KILL_FACTOR,一期)独立于驱逐豁免——env 显式豁免驱逐(GODOT_MCP_WATCHDOG_EXEMPT,
// 三期已落地)只作用于驱逐候选,单进程硬帽仍恒生效(无上限豁免被禁令禁止)。

import { killPidTree } from './process-state.js';
import { getLogger } from './logger.js';
import { appendMachineAuditLine, recordAuditWriteFailure } from './audit-log.js';
import {
  getEvictionCandidates,
  getMachineMemorySnapshot,
  getPressureState,
  killPidProbe,
  listActiveLeases,
  memSample,
  memoryGuardEnabled,
  notePollRss,
  releaseLease,
  sampleRssBytes,
  updatePressureState,
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

/** rss_sample 常规采样间隔(60s,四期 Task 4):时间驱动节流(非 N 次轮计数)——
 *  GODOT_MCP_MEM_POLL_SECONDS 改动不漂(clamp 5-3600 全区间成立,设计 N3)。 */
const RSS_SAMPLE_INTERVAL_MS = 60_000;
/** 长活租约降频间隔(300s):存活 >1h 后边际信息量小,省体积(editor/game_window 常驻)。 */
const RSS_SAMPLE_LONG_LIVED_MS = 300_000;
/** 长活判定线(1h):租约存活(now-startedAt)越过该值起采样间隔放宽到 300s——
 *  锚是 MemLease.startedAt 既有字段(bind≈acquire 后毫秒级,无需独立 bind 时刻表)。 */
const RSS_SAMPLE_LONG_LIVED_AFTER_MS = 3_600_000;

const MB = 1024 * 1024;

interface KillAttribution { readingBytes: number; declaredMB: number; kind: SpawnKind; at: number; }

let _timer: ReturnType<typeof setInterval> | null = null;
let _consecutiveDegrades = 0;
let _backoffUntil = 0;
const _attributions = new Map<number, KillAttribution>();
/** 首采标志(leaseId 集,四期 Task 4):bind 后首个拿到读数的 pollOnce 必落一行
 *  rss_sample(不受 60s 节流)——几秒结束的短命作业至少留一行样本(治「短命
 *  headless 0 样本」)。无读数轮不消耗标志(落不了行——rssBytes 缺值)。 */
const _sampledOnce = new Set<string>();
/** 每租约上次采样时刻(leaseId → ts):时间驱动节流的计时锚(非轮次计数)。 */
const _lastSampleAt = new Map<string, number>();

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
 *  (日志不重复——退避期间 tick 跳过,恢复后首轮若又失败即再续期,不刷屏)。
 *  四期 Task 3:首次达阈值(退避真正触发点)落一行 watchdog_degraded 采样——后续
 *  失败仅续期退避不重复落行,与 warn 日志同款只记一次语义。 */
function noteDegrade(): void {
  _consecutiveDegrades++;
  if (_consecutiveDegrades >= DEGRADE_THRESHOLD) {
    if (_consecutiveDegrades === DEGRADE_THRESHOLD) {
      getLogger().warn(
        'mem-watchdog',
        `MEMGUARD degraded: 连续 ${DEGRADE_THRESHOLD} 轮 RSS 采样失败,轮询退避 ${DEGRADE_BACKOFF_MS / 1000}s(采样通道不可用,跳过判杀不误杀)`,
      );
      memSample('watchdog_degraded', { consecutiveRounds: _consecutiveDegrades });
    }
    _backoffUntil = Date.now() + DEGRADE_BACKOFF_MS;
  }
}

/** 单轮看门狗(测试直调;startWatchdog 周期驱动):先把整机快照喂给 pressure 状态机
 *  (二期 Task 2;快照与准入共享 10s 缓存)→ 取本 serverPid 的活跃租约(pid 已绑)
 *  → 批量采样 RSS → 任一超「声明×系数」→ 树杀+释放租约+归因+一行 stderr →
 *  (二期 Task 3)仍处 hard 态 → 进整机驱逐循环。返回
 *  {checked=本轮照看的租约数, killed=实际树杀数(单进程杀+驱逐杀)}。总开关关闭 →
 *  不读不杀恒零。降级(抛错/读数全空)→ 本轮跳过一切杀(含驱逐——RSS 通道不可信时
 *  ratio 排序失效,不按失控序杀;与非 Windows 无 RSS 通道则驱逐不工作的一期同款
 *  边界,连续 3 轮退避自愈后恢复);部分 pid 无读数不判杀。 */
export async function pollOnce(): Promise<{ checked: number; killed: number }> {
  if (!memoryGuardEnabled()) return { checked: 0, killed: 0 };
  // 二期 Task 2:每轮喂整机快照推进 pressure 状态机(状态机唯一写者在 memory-guard,
  // watchdog 只消费不拥有状态——反向引用会成环,审查二期裁定)
  updatePressureState(getMachineMemorySnapshot());
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
  if (_consecutiveDegrades >= DEGRADE_THRESHOLD) {
    memSample('watchdog_recovered', {}); // 四期 Task 3:此前已降级(≥3),恢复首轮拿到读数——通道恢复
  }
  _consecutiveDegrades = 0; // 拿到读数(哪怕部分)即视为通道健康,降级计数清零
  // 四期 Task 4:按 leaseId 记本轮读数快照(final sample 数据源,releaseLease 在任何账本查找之前
  // 按 leaseId 取用——表本体在 memory-guard 侧防反向 import 成环)。先记再进杀检查:kill 路径的
  // releaseLease final sample 要拿到本轮读数(含本轮将被杀的租约)。
  for (const lease of leases) {
    const rss = rssMap[lease.pid as number];
    if (rss !== undefined) notePollRss(lease, rss);
  }
  let killed = 0;
  const releasedIds = new Set<string>(); // 本轮已释放租约(真杀/探活死清账):不再进策略采样
  for (const lease of leases) {
    const pid = lease.pid as number;
    const rss = rssMap[pid];
    if (rss === undefined) continue; // 无读数不判杀(防误杀:刚退出的进程拿不到读数)
    const factor = KILL_FACTOR[lease.kind] ?? 2;
    if (rss <= lease.declaredMB * MB * factor) continue;
    if (killOverBudget(lease, rss)) killed++;
    releasedIds.add(lease.id); // killOverBudget 两出口(真杀/探活死)都已释放租约
  }
  // 二期 Task 3:整机硬阈值驱逐——单进程杀后仍处 hard 态(状态机由上方喂快照推进)
  // 进驱逐循环:杀到脱离硬阈值+minimum-reclaim 2GB 即停(不全杀)。
  if (getPressureState() === 'hard') killed += evictForHardThreshold(releasedIds);
  // 四期 Task 4:rss_sample 策略采样——仍存活租约按策略落行(本轮已释放者的 RSS
  // 证据由 budget_kill/evict 行携带,不重复采)。
  sampleRssRows(leases, rssMap, releasedIds);
  return { checked: leases.length, killed };
}

/** rss_sample 策略采样(四期 Task 4,设计 §「RSS 采样策略」):
 *  ① 首采必落——bind 后首个拿到读数的 pollOnce 不受节流(短命作业至少留一行;
 *     无读数轮不消耗标志,rssBytes 缺值无法落行);
 *  ② 时间驱动——距上次采样 ≥60s(非轮次计数,GODOT_MCP_MEM_POLL_SECONDS 改动不漂);
 *  ③ 长活降频——存活 >1h(锚 MemLease.startedAt)间隔放宽到 300s;
 *  ④ 压力态恢复 60s 档——pressure/hard 下长活降频收回(保持观测密度;不加密到
 *     每轮:300s 轮询下「每轮」=半小时一行没意义,恒 60s 档即「不低于 60s 不松于 60s」);
 *  本轮已释放租约(releasedIds)不采(budget_kill/evict 行已带 RSS 峰值证据);
 *  行不带 machine 键(省体积 M11,buildSampleLine 按 event 省略),pressure 键保留。
 *  尾部顺手清已释放租约的簿记(租约 id 不复用,残留即死条目,防长期运行缓慢积累)。 */
function sampleRssRows(leases: MemLease[], rssMap: Record<number, number>, releasedIds: Set<string>): void {
  const now = Date.now();
  for (const lease of leases) {
    if (releasedIds.has(lease.id)) continue;
    const rss = rssMap[lease.pid as number];
    if (rss === undefined) continue; // 无读数不采(首采标志不消耗,顺延到首个有读数轮)
    if (_sampledOnce.has(lease.id)) {
      let interval = RSS_SAMPLE_INTERVAL_MS;
      if (now - lease.startedAt >= RSS_SAMPLE_LONG_LIVED_AFTER_MS) interval = RSS_SAMPLE_LONG_LIVED_MS;
      if (getPressureState() !== 'normal') interval = RSS_SAMPLE_INTERVAL_MS; // 压力态:降频收回 60s 档
      if (now - (_lastSampleAt.get(lease.id) ?? 0) < interval) continue;
    }
    _sampledOnce.add(lease.id);
    _lastSampleAt.set(lease.id, now);
    memSample('rss_sample', {
      kind: lease.kind, project: lease.projectPath, leaseId: lease.id,
      pid: lease.pid, declaredMB: lease.declaredMB, rssBytes: rss,
    });
  }
  const liveIds = new Set(leases.map((l) => l.id));
  for (const id of _sampledOnce) if (!liveIds.has(id)) _sampledOnce.delete(id);
  for (const id of _lastSampleAt.keys()) if (!liveIds.has(id)) _lastSampleAt.delete(id);
}

/** 杀事件审计行(四期 Task 5,T3-M-3 清偿):与采样行同点双写机器级审计——采样通道是
 *  分析端主数据(本 server 视角),审计通道给跨 server 的杀可见性。形态对齐 cli/daemon.ts
 *  defaultAuditKill(AuditEntry 既有 9 必填字段 + 自由载荷进 details);恒写不经
 *  isAuditEnabled(机器级「杀」类事件既有契约,同 GodotServer startup / daemon kill 先例)。
 *  fire-and-forget:看门狗主循环不 await 落盘;失败经 recordAuditWriteFailure 计数
 *  (审计通道可观测面),kill 与采样不受影响。 */
function auditKill(
  action: 'budget_kill' | 'evict' | 'evict_exhausted',
  projectPath: string,
  details: Record<string, unknown>,
): void {
  void appendMachineAuditLine({
    trace_id: 'memguard', tool: 'memory-guard', action, risk: 'process',
    ok: true, project_path: projectPath, changed_files: [], duration_ms: 0,
    details,
  }).catch(recordAuditWriteFailure);
}

/** 整机硬阈值驱逐循环(二期 Task 3;三期 Task 1 候选增 env 豁免过滤;watchdog 只消费
 *  memory-guard 导出,不拥有状态):每轮 force 刷新快照喂状态机(绕过 10s 缓存——杀一个
 *  后重采样读缓存旧值会反复多杀,审查二期)→ 仍 hard(未达「硬阈值+2GB」脱离线)→ 取驱逐
 *  候选(实测÷声明降序,preview/editor 殿后,GODOT_MCP_WATCHDOG_EXEMPT 命中组剔出——
 *  过滤与排序唯一写者在 memory-guard)树杀队首 → 循环;状态机降级 pressure 即停;候选
 *  耗尽仍 hard → 诚实上报「已无本 server 可驱逐进程,外部占用需人工处理」break,不抛崩
 *  (外部进程永不杀——候选只在本 server 租约集合内);三期:env 豁免剔出过租约时在既有句
 *  后附豁免计数归因(被剔组/笔数——需人工处理或调 env)。
 *  死循环防护:attempted 集合保证每租约单轮仅尝试一次——killPidTree 异步强杀,
 *  force 采样可能早于 OS 回收读到旧值(最坏杀光全部候选(attempted 集合保证有界
 *  终止,非最小杀伤);taskkill /F 后 Windows 工作集随进程终止即释放,实际风险低);
 *  候选集随每杀单调缩小(杀即 releaseLease 清账本),必终止。 */
function evictForHardThreshold(releasedIds: Set<string>): number {
  let killed = 0;
  const attempted = new Set<string>();
  for (;;) {
    updatePressureState(getMachineMemorySnapshot({ force: true }));
    if (getPressureState() !== 'hard') break; // 杀到脱离硬阈值+2GB → 状态机已降 pressure
    const { candidates, envExempted } = getEvictionCandidates();
    const victim = candidates.find((c) => !attempted.has(c.lease.id));
    if (victim === undefined) {
      // 三期:env 豁免剔出过租约 → 既有句后附豁免计数(组×笔数),全零保持原句
      const msg = 'MEMGUARD hard 已无本 server 可驱逐进程,外部占用需人工处理(租约耗尽仍处硬阈值)';
      if (envExempted.preview > 0 || envExempted.editor > 0) {
        console.error(
          `${msg}(另有 ${envExempted.preview + envExempted.editor} 笔租约被 GODOT_MCP_WATCHDOG_EXEMPT 豁免: `
          + `preview ${envExempted.preview}, editor ${envExempted.editor}——需人工处理或调 env)`,
        );
      } else {
        console.error(msg);
      }
      memSample('evict_exhausted', { envExempted }); // 四期 Task 4:候选耗尽仍 hard 的诚实证据行
      auditKill('evict_exhausted', '', { envExempted }); // 四期 Task 5:无受害租约 → project_path 空
      break;
    }
    attempted.add(victim.lease.id);
    if (killForEviction(victim.lease, victim.ratio)) killed++;
    releasedIds.add(victim.lease.id); // 驱逐两出口(真杀/探活死)都已释放租约,不进策略采样
  }
  return killed;
}

/** 树杀一笔驱逐候选(与 killOverBudget 同语义:杀前探活,已死仅清租约不记归因——
 *  不是看门狗杀的)。归因记推算实测字节(ratio×声明,与候选 RSS 采样同源);报文带
 *  ratio(实测÷声明)与声明档位,grep MEMGUARD 可审计。 */
function killForEviction(lease: MemLease, ratio: number): boolean {
  const pid = lease.pid as number;
  if (killPidProbe(pid) === 'dead') {
    releaseLease(lease.id);
    return false;
  }
  killPidTree(pid);
  const readingBytes = Math.round(ratio * lease.declaredMB * MB);
  memSample('evict', { // 四期 Task 4:驱逐杀采样行(rssBytes=推算读数,与候选 ratio 同源)
    kind: lease.kind, project: lease.projectPath, leaseId: lease.id, pid,
    declaredMB: lease.declaredMB, rssBytes: readingBytes, ratio, reason: 'hard',
  });
  auditKill('evict', lease.projectPath, { // 四期 Task 5:同事件审计行(ratio 进 details)
    leaseId: lease.id, pid, kind: lease.kind, declaredMB: lease.declaredMB, rssBytes: readingBytes, ratio,
  });
  releaseLease(lease.id);
  _attributions.set(pid, { readingBytes, declaredMB: lease.declaredMB, kind: lease.kind, at: Date.now() });
  console.error(
    `MEMGUARD evict kill ${pid} kind=${lease.kind} ratio=${ratio.toFixed(2)}(实测÷声明) declared=${lease.declaredMB}MB`,
  );
  return true;
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
  memSample('budget_kill', { // 四期 Task 4:超预算杀采样行(杀时读数=超线峰值证据,喂 per-process max)
    kind: lease.kind, project: lease.projectPath, leaseId: lease.id, pid,
    declaredMB: lease.declaredMB, rssBytes: readingBytes, budgetBytes, killFactor: factor,
  });
  auditKill('budget_kill', lease.projectPath, { // 四期 Task 5:同事件审计行(budgetBytes 进 details)
    leaseId: lease.id, pid, kind: lease.kind, declaredMB: lease.declaredMB, rssBytes: readingBytes, budgetBytes,
  });
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

/** 归因报文(Task 5 接线消费):executor/runtime 失败路径优先报 MEM_BUDGET_EXCEEDED 的
 *  message 文本——峰值读数 / 声明档位×杀线系数 / 上调档位指引(env 名按 kind 大写)。
 *  单一来源供两处消费方共用,防报文格式漂移。 */
export function formatMemKillMessage(attr: { readingBytes: number; declaredMB: number; kind: SpawnKind }): string {
  const factor = KILL_FACTOR[attr.kind] ?? 2;
  return `内存预算超限被看门狗终止: 峰值 ${fmtGB(attr.readingBytes)} / 声明 ${attr.declaredMB}MB×${factor}。若为合法重负载,调 GODOT_MCP_DECLARED_MB_${attr.kind.toUpperCase()} 上调档位`;
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

/** 重置模块可变状态(timer/降级计数/归因记录/rss_sample 采样簿记),测试隔离用。 */
export function _resetWatchdogForTest(): void {
  stopWatchdog();
  _consecutiveDegrades = 0;
  _backoffUntil = 0;
  _attributions.clear();
  _sampledOnce.clear();
  _lastSampleAt.clear();
}
