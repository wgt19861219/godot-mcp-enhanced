#!/usr/bin/env node
// scripts/memguard-review.mjs
// memory-guard 采样回看（只读分析）：读采样 JSONL（主文件 + 全部轮转代际 .1–.4），按 leaseId
// 聚合进程 RSS 分布与事件频次，按 serverPid 重建 pressure episode，输出九条回看判定的三态
// 结论（命中 / 未命中 / 数据不足）。只出建议不自动调档；零依赖（Node 内置模块），随 npm 包
// 分发（package.json files 含 scripts）。
//
// 判定标准与聚合口径的权威来源：docs/superpowers/specs/2026-11-23-memory-guard-p4-design.md
// 「聚合口径」「回看判定标准」「回看工具」三节。采样行形态见同文档「事件 schema」节
// （源码 src/core/memory-guard.ts buildSampleLine：rss_sample 无 machine 键、pressure_change
// 无 pressure 键）。
//
// 用法：node scripts/memguard-review.mjs [--file <path>]
//   默认路径同 sampleFilePath()：env GODOT_MCP_MEM_SAMPLE_FILE 优先，否则
//   ~/.godot-mcp/memory-guard-events.jsonl；同目录 <file>.1–<file>.4 为轮转代际（一并读入，
//   按 ts 排序合并），<file>.lock 是轮转锁不是代际。
// 退出码：0=有结论（触发条件满足且至少一条判定有结论）/ 1=数据不足 / 2=读失败（含任一代际
//   不可读或主文件缺失而代际存在——已读部分照常出报告并在首部提示数据不完整）
//
// 结构：parseLines / analyze / formatReport 为纯函数（测试 import 直调），loadSampleFile 接收
// 路径数组语义（主文件 + 代际）做读取合并，CLI 壳尽量薄。风格同 check-tool-count.mjs。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ===== 常量表（防漂移：test/scripts/memguard-review.test.ts 读源码文本机械比对，勿单侧改值）=====
/** 单进程杀线系数——与 mem-watchdog.ts KILL_FACTOR / memory-guard.ts SAMPLE_KILL_FACTOR 逐值一致。 */
export const KILL_FACTOR = Object.freeze({ headless: 2, gut_shard: 2, game_window: 3, editor: 3 });
/** pressure 恢复去抖窗——与 memory-guard.ts PRESSURE_RECOVER_MS（源码写法 `5 * 60_000`）一致。 */
export const PRESSURE_RECOVER_MS = 300_000;
/** hard 脱离 minimum-reclaim——与 memory-guard.ts HARD_MIN_RECLAIM_MB 一致（#5a 建议文案指路）。 */
export const HARD_MIN_RECLAIM_MB = 2048;
export const KINDS = Object.freeze(['headless', 'gut_shard', 'game_window', 'editor']);

/** 采样 schema 版本（公共壳 v 字段）：更高 v 的行前向兼容忽略并计数。 */
const SAMPLE_VERSION = 1;
/** 轮转代际数（memory-guard.ts SAMPLE_ROTATE_KEEP）：8MB/代 × 4 代。 */
const SAMPLE_ROTATE_KEEP = 4;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

/** 判定参数——spec「回看判定标准」表逐条；分位类判据 n<20 报样本不足（spec 聚合口径）。 */
const JUDGE = Object.freeze({
  percentileMinN: 20,
  coverageDays: 14,
  triggerStartedPerKind: 30,
  budgetKillPerDay: 1,
  lowWaterRejectPerDay: 3,
  hardFlapWindowMs: 10 * 60_000,
  hardFlapRate: 0.3,
  shortEpisodeMs: 3 * PRESSURE_RECOVER_MS,
  shortEpisodeShare: 0.5,
  directHardShare: 0.3,
  reapPerDay: 5,
  overestimateP95: 0.5,
  overestimateMax: 0.8,
  /** 最后事件距今超过此值提示"采样可能已关闭/数据可能过期"（启发式）。 */
  staleAgeMs: DAY_MS,
});

const KNOWN_EVENTS = new Set([
  'server_start', 'lease_acquired', 'spawn_started', 'spawn_reject', 'rss_sample',
  'budget_kill', 'evict', 'evict_exhausted', 'pressure_change',
  'watchdog_degraded', 'watchdog_recovered', 'idle_reap', 'exit_reap',
]);

const STATUS_LABEL = { hit: '命中', miss: '未命中', insufficient: '数据不足' };

// ===== 基础工具 =====

/** nearest-rank 分位（p∈(0,1]，升序数组，1 基秩 = ceil(p·n)）。空数组返回 null。 */
function nearestRank(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1];
}

function fmtNum(x, digits = 0) {
  return x === null || x === undefined ? '—' : x.toFixed(digits);
}
function fmtPct(x) {
  return x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`;
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtTs(ts) {
  if (ts === null) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 本地日历日（辅助信息用，如 budget_kill 出现在哪些天）。 */
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDur(ms) {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 2 * DAY_MS) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${(ms / DAY_MS).toFixed(1)} 天`;
}

// ===== 解析与加载 =====

/**
 * 纯函数：逐行解析 + 按 ts 稳定排序。坏行/半行/缺壳字段跳过计数；未知 event、更高 v 分别
 * 计数（前向兼容）——多 server 并发交错写入的坏行不炸整份报告。
 * @param {string[]} lines 原始行（可乱序、可跨代际）
 * @returns {{rows: Array<Record<string, any>>, skipped: {badLines:number, blank:number, futureVersion:number, unknownEvents: Record<string, number>}}} */
export function parseLines(lines) {
  const rows = [];
  const skipped = { badLines: 0, blank: 0, futureVersion: 0, unknownEvents: {} };
  for (const raw of lines) {
    const s = raw.trim();
    if (s === '') { skipped.blank++; continue; }
    let obj;
    try { obj = JSON.parse(s); } catch { skipped.badLines++; continue; }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { skipped.badLines++; continue; }
    const { ts, v, event, serverPid } = obj;
    if (!Number.isFinite(ts) || typeof event !== 'string' || !Number.isFinite(serverPid)) { skipped.badLines++; continue; }
    if (v === SAMPLE_VERSION) {
      if (!KNOWN_EVENTS.has(event)) {
        skipped.unknownEvents[event] = (skipped.unknownEvents[event] ?? 0) + 1;
        continue;
      }
      rows.push(obj);
    } else if (typeof v === 'number' && v > SAMPLE_VERSION) {
      skipped.futureVersion++;
    } else {
      skipped.badLines++; // v 缺失/非法/更低：不认识的壳
    }
  }
  rows.sort((a, b) => a.ts - b.ts); // 稳定排序：代际乱序/跨文件合并后恢复时序
  return { rows, skipped };
}

/** 采样文件默认路径（与 src/core/memory-guard.ts sampleFilePath() 同语义）。 */
export function defaultSamplePath(env = process.env) {
  return env.GODOT_MCP_MEM_SAMPLE_FILE ?? join(homedir(), '.godot-mcp', 'memory-guard-events.jsonl');
}

/**
 * 读主文件 + 全部代际（.4 → .1 → 主，旧到新），合并为行数组（analyze 内再按 ts 排序）。
 * 代际文件缺失属常态（未轮转到）不计失败；主文件缺失、任一已存在文件不可读记入 failures
 * （CLI 据此把退出码钳为 2——数据不完整不等于有结论）。
 * @returns {{lines:string[], files: Array<{path:string, lines:number}>, failures: Array<{path:string, error:string}>}} */
export function loadSampleFile(mainPath) {
  const candidates = [];
  for (let i = SAMPLE_ROTATE_KEEP; i >= 1; i--) candidates.push(`${mainPath}.${i}`);
  candidates.push(mainPath);
  const lines = [];
  const files = [];
  const failures = [];
  for (const p of candidates) {
    if (!existsSync(p)) {
      if (p === mainPath) failures.push({ path: p, error: '文件不存在' });
      continue;
    }
    try {
      const ls = readFileSync(p, 'utf8').split('\n');
      if (ls[ls.length - 1] === '') ls.pop(); // 文件末换行产生的空元素不是行
      files.push({ path: p, lines: ls.length });
      for (const l of ls) lines.push(l);
    } catch (e) {
      failures.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { lines, files, failures };
}

// ===== 聚合 =====

function emptyKind() {
  return {
    acquired: 0, started: 0, spawnFailed: 0, n: 0, samples: 0, budgetKills: 0, evicts: 0,
    killDays: [], declared: [], p50MB: null, p95MB: null, maxMB: null,
    p50Ratio: null, p95Ratio: null, maxRatio: null, windowDays: 0, firstTs: null, lastTs: null,
  };
}

function emptyEvents() {
  return {
    spawnReject: { total: 0, byCheck: {}, byReason: {}, lowWaterNormalCheck1: 0 },
    budgetKill: 0, evict: 0, evictExhausted: 0, idleReap: 0, exitReap: 0,
    pressureChange: { toPressure: 0, directHard: 0, upgradedHard: 0, downgraded: 0, toNormal: 0 },
    watchdogDegraded: 0, watchdogRecovered: 0,
  };
}

/** 进程 = leaseId（非 pid：14 天窗 Windows pid 会复用，同 pid 多 leaseId 分开聚合）。 */
function touchProc(procs, r, create) {
  let p = procs.get(r.leaseId);
  if (!p) {
    if (!create) return null;
    p = { leaseId: r.leaseId, pid: null, kind: r.kind, declaredMB: null, started: false, samples: 0, maxBytes: null, budgetKilled: false, evicted: false };
    procs.set(r.leaseId, p);
  }
  if (p.declaredMB === null && typeof r.declaredMB === 'number') p.declaredMB = r.declaredMB;
  return p;
}

/** 进程 RSS = max(全部 rss_sample / budget_kill / evict / final sample 的 rssBytes)：被杀读数是峰值证据。 */
function noteReading(p, bytes) {
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
    p.maxBytes = p.maxBytes === null ? bytes : Math.max(p.maxBytes, bytes);
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * pressure episode 按 serverPid 分段重建（多 server 状态机独立时序不可混算）：首个进入行起、
 * to:'normal' 行止；server 重启/文件末尾无闭合行的悬挂 episode 标 unresolved——**只从时长集合
 * （#5b）剔除**，其切换行照常进行级统计（#5a/#6）：进入行与降级行是完整观测到的事实，未闭合
 * 只让"时长"不可知（控制器裁定 C3）。直进（normal→hard）与升级（pressure→hard）分计。
 */
function rebuildEpisodes(rows) {
  const byServer = new Map();
  const list = [];
  let orphanCloses = 0;
  const openEpisode = (serverPid, ts) => ({
    serverPid, startTs: ts, endTs: null, resolved: false, lastDowngradeTs: null,
    viaPressure: 0, directHard: 0, upgradedHard: 0, downgrades: 0, hardEntries: 0, flaps: 0,
  });
  for (const r of rows) {
    if (r.event === 'server_start') {
      // 同 serverPid 再见 server_start = 该 pid 已被新 server 进程复用：此前未闭合段悬挂
      const st = byServer.get(r.serverPid);
      if (st && st.current) { list.push(st.current); st.current = null; }
      continue;
    }
    if (r.event !== 'pressure_change') continue;
    const { from, to } = r;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    let st = byServer.get(r.serverPid);
    if (!st) { st = { current: null }; byServer.set(r.serverPid, st); }
    let ep = st.current;
    if (!ep && to !== 'normal') { ep = openEpisode(r.serverPid, r.ts); st.current = ep; }
    if (!ep) { if (to === 'normal') orphanCloses++; continue; } // 进入行已轮转掉的孤立闭合行
    if (from === 'normal' && to === 'pressure') ep.viaPressure++;
    else if (from === 'normal' && to === 'hard') { ep.directHard++; ep.hardEntries++; }
    else if (from === 'pressure' && to === 'hard') {
      ep.upgradedHard++; ep.hardEntries++;
      if (ep.lastDowngradeTs !== null && r.ts - ep.lastDowngradeTs <= JUDGE.hardFlapWindowMs) ep.flaps++;
      ep.lastDowngradeTs = null;
    } else if (from === 'hard' && to === 'pressure') { ep.downgrades++; ep.lastDowngradeTs = r.ts; }
    if (to === 'normal') { ep.endTs = r.ts; ep.resolved = true; list.push(ep); st.current = null; }
  }
  for (const st of byServer.values()) if (st.current) list.push(st.current);
  list.sort((a, b) => a.startTs - b.startTs);
  const closed = list.filter((e) => e.resolved);
  const durations = closed.map((e) => e.endTs - e.startTs).sort((a, b) => a - b);
  // 行级统计（#5a/#6）闭合与悬挂段一并计入；时长统计（#5b）只用闭合段
  const sum = (k) => list.reduce((s, e) => s + e[k], 0);
  const shortCount = closed.filter((e) => e.endTs - e.startTs < JUDGE.shortEpisodeMs).length;
  return {
    list: list.map((e) => ({
      serverPid: e.serverPid, startTs: e.startTs, endTs: e.endTs, resolved: e.resolved,
      durationMin: e.resolved ? (e.endTs - e.startTs) / 60_000 : null,
      viaPressure: e.viaPressure, directHard: e.directHard, upgradedHard: e.upgradedHard, downgrades: e.downgrades, flaps: e.flaps,
    })),
    resolved: closed.length,
    unresolved: list.length - closed.length,
    orphanCloses,
    viaPressure: sum('viaPressure'), directHard: sum('directHard'), upgradedHard: sum('upgradedHard'),
    downgrades: sum('downgrades'), hardEntries: sum('hardEntries'), flaps: sum('flaps'),
    medianMin: durations.length > 0 ? nearestRank(durations, 0.5) / 60_000 : null,
    shortCount,
    shareUnder15min: closed.length > 0 ? shortCount / closed.length : null,
  };
}

/**
 * 纯函数：分析采样行，产出报告（含九条判定三态与退出码）。
 * @param {string[]} lines 原始行
 * @param {{now?: number, sampleEnv?: string}} [opts] now=「距今」基准；sampleEnv=当前环境
 *   GODOT_MCP_MEM_SAMPLE 原值（仅用于"采样已关闭"提示，不参与判定）
 */
export function analyze(lines, { now = Date.now(), sampleEnv } = {}) {
  const { rows, skipped } = parseLines(lines);
  const kinds = Object.fromEntries(KINDS.map((k) => [k, emptyKind()]));
  const events = emptyEvents();
  const procs = new Map();
  const thresholdsMap = new Map();
  let unattributedRows = 0;

  for (const r of rows) {
    switch (r.event) {
      case 'server_start': {
        const key = JSON.stringify([r.thresholds, r.declaredMB, r.killFactor, r.pkgVersion]);
        const t = thresholdsMap.get(key);
        if (t) t.count++;
        else thresholdsMap.set(key, { count: 1, pkgVersion: r.pkgVersion, thresholds: r.thresholds, declaredMB: r.declaredMB, killFactor: r.killFactor });
        break;
      }
      case 'spawn_reject': {
        const sr = events.spawnReject;
        sr.total++;
        bump(sr.byCheck, String(r.check));
        if (typeof r.reason === 'string') bump(sr.byReason, r.reason);
        // #4 口径：查①水位拒绝 且 事件行 after-state pressure='normal'（pressure/hard 态的拒绝走查⓪，不计）
        if (r.check === 1 && r.reason === 'MEMGUARD_LOW_WATER' && r.pressure === 'normal') sr.lowWaterNormalCheck1++;
        break;
      }
      case 'pressure_change': {
        const { from, to } = r;
        const pc = events.pressureChange;
        if (from === 'normal' && to === 'pressure') pc.toPressure++;
        else if (from === 'normal' && to === 'hard') pc.directHard++;
        else if (from === 'pressure' && to === 'hard') pc.upgradedHard++;
        else if (from === 'hard' && to === 'pressure') pc.downgraded++;
        if (to === 'normal') pc.toNormal++;
        break;
      }
      case 'evict_exhausted': events.evictExhausted++; break;
      case 'watchdog_degraded': events.watchdogDegraded++; break;
      case 'watchdog_recovered': events.watchdogRecovered++; break;
      case 'idle_reap': events.idleReap++; break;
      case 'exit_reap': events.exitReap++; break;
      case 'lease_acquired':
      case 'spawn_started':
      case 'rss_sample':
      case 'budget_kill':
      case 'evict': {
        if (typeof r.leaseId !== 'string' || !KINDS.includes(r.kind)) { unattributedRows++; break; }
        const ks = kinds[r.kind];
        if (ks.firstTs === null) ks.firstTs = r.ts;
        ks.lastTs = r.ts;
        if (r.event === 'lease_acquired') {
          ks.acquired++;
          touchProc(procs, r, true);
        } else if (r.event === 'spawn_started') {
          ks.started++;
          const p = touchProc(procs, r, true);
          p.started = true;
          if (Number.isFinite(r.pid)) p.pid = r.pid;
        } else if (r.event === 'rss_sample') {
          ks.samples++;
          noteReading(touchProc(procs, r, true), r.rssBytes);
        } else if (r.event === 'budget_kill') {
          ks.budgetKills++;
          events.budgetKill++;
          const p = touchProc(procs, r, true);
          noteReading(p, r.rssBytes);
          p.budgetKilled = true;
          if (!ks.killDays.includes(localDate(r.ts))) ks.killDays.push(localDate(r.ts));
        } else {
          ks.evicts++;
          events.evict++;
          const p = touchProc(procs, r, true);
          noteReading(p, r.rssBytes);
          p.evicted = true;
        }
        break;
      }
      default: break; // server_start 已处理；无其它已知事件
    }
  }

  // 每档 RSS 分布（进程 max，含杀读数）；分位仅 n≥20 计算，比值按各进程自身声明折算（历史数据按事件时刻档位）
  const procList = [...procs.values()];
  for (const k of KINDS) {
    const ks = kinds[k];
    // spawn 失败数无独立事件（计划裁定）：按 kind 用 lease_acquired − spawn_started 差值推导（窗口轮转可为负，钳 0）
    ks.spawnFailed = Math.max(0, ks.acquired - ks.started);
    if (ks.firstTs !== null) ks.windowDays = (ks.lastTs - ks.firstTs) / DAY_MS;
    const withReading = procList
      .filter((p) => p.kind === k && p.maxBytes !== null && p.declaredMB !== null && p.declaredMB > 0)
      .map((p) => ({ mb: p.maxBytes / MB, ratio: p.maxBytes / MB / p.declaredMB, declared: p.declaredMB }))
      .sort((a, b) => a.mb - b.mb);
    ks.n = withReading.length;
    ks.declared = [...new Set(withReading.map((x) => x.declared))].sort((a, b) => a - b);
    if (ks.n === 0) continue;
    const mb = withReading.map((x) => x.mb);
    // ratio 分位必须按 ratio 自身升序取秩：kind 内声明不一致（回看→上调档位→再采）时 mb 序 ≠ ratio 序，
    // 沿用 mb 序会让 P50/P95/max(ratio) 全部取错值（审查 Important-1）
    const ratio = withReading.map((x) => x.ratio).sort((a, b) => a - b);
    ks.maxMB = mb[mb.length - 1];
    ks.maxRatio = ratio[ratio.length - 1];
    if (ks.n >= JUDGE.percentileMinN) {
      ks.p50MB = nearestRank(mb, 0.5);
      ks.p95MB = nearestRank(mb, 0.95);
      ks.p50Ratio = nearestRank(ratio, 0.5);
      ks.p95Ratio = nearestRank(ratio, 0.95);
    }
  }

  // 观察窗 = 首事件至末事件（并集）；不足 1 天按 1 天计（spec：短跑一次不该算出 24 倍频次）
  const firstTs = rows.length > 0 ? rows[0].ts : null;
  const lastTs = rows.length > 0 ? rows[rows.length - 1].ts : null;
  const elapsedDays = firstTs === null ? null : (lastTs - firstTs) / DAY_MS;
  const days = elapsedDays === null ? null : Math.max(1, elapsedDays);
  const window = { firstTs, lastTs, elapsedDays, days, ageMs: lastTs === null ? null : now - lastTs };
  const perDay = (count) => (days === null ? null : count / days);

  const episodes = rebuildEpisodes(rows);
  const thresholds = [...thresholdsMap.values()].map((t) => ({
    ...t,
    minFreeEqualsSoft: !!t.thresholds && t.thresholds.minFreeMB === t.thresholds.softMB,
  }));

  // 触发条件（满足其一）：某 kind spawn_started ≥30 进程，或观察窗 ≥14 天
  const maxStartedKind = KINDS.reduce((a, b) => (kinds[a].started >= kinds[b].started ? a : b));
  const maxStarted = kinds[maxStartedKind].started;
  const byCount = maxStarted >= JUDGE.triggerStartedPerKind;
  const byWindow = days !== null && days >= JUDGE.coverageDays;
  const trigger = {
    met: byCount || byWindow,
    maxStartedKind,
    maxStarted,
    reason: days === null
      ? `未满足（无有效事件，无观察窗）`
      : byCount || byWindow
        ? `满足（${byCount ? `${maxStartedKind} spawn_started ${maxStarted} ≥ ${JUDGE.triggerStartedPerKind} 进程` : `最大 kind 进程数 ${maxStarted} < ${JUDGE.triggerStartedPerKind}`}；观察窗 ${fmtNum(days, 2)} 天${byWindow ? ` ≥ ${JUDGE.coverageDays}` : ` < ${JUDGE.coverageDays}`}）`
        : `未满足（最大 kind 进程数 ${maxStarted} < ${JUDGE.triggerStartedPerKind}，观察窗 ${fmtNum(days, 2)} 天 < ${JUDGE.coverageDays}）`,
  };

  // ===== 九条判定（三态：hit / miss / insufficient）=====
  const judgments = [];
  const hit = (detail) => ({ status: 'hit', detail });
  const miss = (detail) => ({ status: 'miss', detail });
  const insufficient = (detail) => ({ status: 'insufficient', detail });
  /** per-kind 判定：每档独立三态 + 顶层聚合态（任一档命中即命中，否则任一档未命中即未命中，全不足即不足）。 */
  const kindJudge = (fn) => {
    const perKind = Object.fromEntries(KINDS.map((k) => [k, fn(kinds[k], k)]));
    const statuses = Object.values(perKind).map((x) => x.status);
    const status = statuses.includes('hit') ? 'hit' : statuses.includes('miss') ? 'miss' : 'insufficient';
    return { status, detail: KINDS.map((k) => `${k} ${STATUS_LABEL[perKind[k].status]}`).join(' / '), perKind };
  };
  /** 频次类判定（X/观察窗天 ≥ 阈值）：无观察窗 → 数据不足。describe 为「<次数> / <天数>」片段。 */
  const rateJudge = (count, threshold, describe) => {
    if (days === null) return insufficient('无观察窗（零有效行）');
    const rate = perDay(count);
    const d = `${describe} = ${fmtNum(rate, 2)}/天（阈值 ≥${threshold}）`;
    return rate >= threshold ? hit(d) : miss(d);
  };
  /** 比例类判定（num/den 与阈值比较，isHit 为命中谓词）：分母为 0 → 数据不足。 */
  const ratioJudge = (num, den, noDenominatorDetail, describe, isHit) => {
    if (den === 0) return insufficient(noDenominatorDetail);
    const rate = num / den;
    const d = `${describe} = ${fmtPct(rate)}`;
    return isHit(rate) ? hit(d) : miss(d);
  };

  // #1 某档 P50(进程max) > declared×1.0（n≥20）→ 声明常态性低估
  judgments.push({
    id: '1', title: `声明常态性低估：某档 P50(进程max) > declared×1.0（n≥${JUDGE.percentileMinN}）`,
    advice: '上调该档 GODOT_MCP_DECLARED_MB_<KIND> 至 P50×1.2 取整',
    ...kindJudge((ks) => {
      if (ks.n < JUDGE.percentileMinN) return insufficient(`样本不足（n=${ks.n} < ${JUDGE.percentileMinN}），不计算分位`);
      const d = `P50=${fmtNum(ks.p50MB)}MB / 声明 ${ks.declared.join('|')}MB = ${ks.p50Ratio.toFixed(2)}×（n=${ks.n}）`;
      return ks.p50Ratio > 1 ? hit(d) : miss(d);
    }),
  });

  // #2 某档 P95(进程max, 含 kill 读数) > declared×KILL_FACTOR → 逼近硬帽误杀线
  judgments.push({
    id: '2', title: '逼近硬帽误杀线：某档 P95(进程max，含 kill 读数) > declared×KILL_FACTOR',
    advice: '上调档位优先；KILL_FACTOR 为源码常量（src/core/mem-watchdog.ts）非 env——需改源码',
    ...kindJudge((ks, k) => {
      if (ks.n < JUDGE.percentileMinN) return insufficient(`样本不足（n=${ks.n} < ${JUDGE.percentileMinN}），不计算分位`);
      const f = KILL_FACTOR[k];
      const d = `P95=${fmtNum(ks.p95MB)}MB = 声明×${ks.p95Ratio.toFixed(2)} vs KILL_FACTOR=${f}（n=${ks.n}，含 budget_kill ${ks.budgetKills} 例 / evict ${ks.evicts} 例读数）`;
      return ks.p95Ratio > f ? hit(d) : miss(d);
    }),
  });

  // #3 budget_kill ≥1/观察窗天（同 kind）→ 硬帽过紧；括注「跨多日复发」降为辅助信息（列出不同日）
  judgments.push({
    id: '3', title: `硬帽过紧：budget_kill ≥ ${JUDGE.budgetKillPerDay}/观察窗天（同 kind）`,
    advice: '核对该档进程分布后上调档位',
    ...kindJudge((ks) => {
      const r = rateJudge(ks.budgetKills, JUDGE.budgetKillPerDay, `${ks.budgetKills} 例 / ${fmtNum(days, 2)} 天`);
      if (ks.budgetKills > 0) r.detail += `；出现在 ${ks.killDays.length} 个不同日（${ks.killDays.join(', ')}）`;
      return r;
    }),
  });

  // #4 spawn_reject(check=1, LOW_WATER) ≥3/观察窗天 且事件行 pressure='normal' → 瞬时水位毛刺偏频
  {
    let premise;
    if (thresholds.length === 0) premise = '窗口内无 server_start 行，MIN_FREE 与 SOFT 的关系不可核';
    else if (thresholds.every((t) => t.minFreeEqualsSoft)) premise = `前提成立：MIN_FREE_MB = SOFT_MB（${thresholds.map((t) => t.thresholds.minFreeMB).join('|')}），本判据专捕 30s 去抖窗内的瞬时毛刺`;
    else premise = '前提不成立：存在 MIN_FREE_MB ≠ SOFT_MB 的自定义配置，本判据含义不同（MIN_FREE 低于 SOFT 时此处拒绝即持续性吃紧而非毛刺）';
    const count = events.spawnReject.lowWaterNormalCheck1;
    const judge = rateJudge(count, JUDGE.lowWaterRejectPerDay, `${count} 次 / ${fmtNum(days, 2)} 天`);
    judge.detail += `；${premise}`;
    judgments.push({
      id: '4', title: `瞬时水位毛刺偏频：spawn_reject(check=1, LOW_WATER, pressure='normal') ≥ ${JUDGE.lowWaterRejectPerDay}/观察窗天`,
      advice: 'MIN_FREE_MB 下调 512MB 档评估 + 评估瞬时分配源',
      ...judge,
    });
  }

  // #5a hard 抖动率：hard→pressure 降级后 10min 内再次 →hard 的次数 / hard 进入次数 >30%
  judgments.push({
    id: '5a', title: `硬阈值边缘反复杀：hard→pressure 降级后 ${JUDGE.hardFlapWindowMs / 60_000}min 内再 →hard 的次数 / hard 进入次数 > ${fmtPct(JUDGE.hardFlapRate)}`,
    advice: `HARD_MIN_RECLAIM_MB（memory-guard.ts 源码常量，当前 ${HARD_MIN_RECLAIM_MB}）或 HARD_MB 调整评估——PRESSURE_RECOVER_MS 只管 pressure→normal 与此无关`,
    ...ratioJudge(
      episodes.flaps, episodes.hardEntries,
      `无 hard 进入（闭合 ${episodes.resolved} 段 / 悬挂 ${episodes.unresolved} 段）`,
      `${JUDGE.hardFlapWindowMs / 60_000}min 内再升级 ${episodes.flaps} / hard 进入 ${episodes.hardEntries}（闭合 ${episodes.resolved} 段 + 悬挂 ${episodes.unresolved} 段，降级 ${episodes.downgrades} 次）`,
      (rate) => rate > JUDGE.hardFlapRate,
    ),
  });

  // #5b 压力期 episode 时长：<15min（恢复下限 5min 的 3 倍）的 episode 占比 >50%（只用闭合段）
  judgments.push({
    id: '5b', title: `软阈值边缘抖动：闭合 episode 时长 < ${JUDGE.shortEpisodeMs / 60_000}min（恢复下限 ${PRESSURE_RECOVER_MS / 60_000}min 的 3 倍）的占比 > ${fmtPct(JUDGE.shortEpisodeShare)}`,
    advice: 'SOFT_MB 上调评估',
    ...ratioJudge(
      episodes.shortCount, episodes.resolved,
      '无已闭合 episode（悬挂段不进时长集）',
      `<${JUDGE.shortEpisodeMs / 60_000}min 的 ${episodes.shortCount} / 闭合 ${episodes.resolved} 段（时长中位 ${fmtNum(episodes.medianMin, 1)}min；悬挂 ${episodes.unresolved} 段不进时长集）`,
      (rate) => rate > JUDGE.shortEpisodeShare,
    ),
  });

  // #6 hard 直进（from:'normal'→to:'hard'）占进入行（from='normal' 的 pressure/hard 进入）比 >30%
  {
    const entries = episodes.viaPressure + episodes.directHard;
    judgments.push({
      id: '6', title: `软硬间距过窄：hard 直进（from:'normal'→to:'hard'）占进入行（from='normal' 的 pressure/hard 进入）比 > ${fmtPct(JUDGE.directHardShare)}`,
      advice: 'SOFT_MB/HARD_MB 间距拉开（SOFT 上调优先）',
      ...ratioJudge(
        episodes.directHard, entries,
        `无 from='normal' 的进入行（闭合 ${episodes.resolved} 段 / 悬挂 ${episodes.unresolved} 段）`,
        `直进 ${episodes.directHard} / 进入行 ${entries}（升级 ${episodes.upgradedHard} 另计不稀释分母；闭合 ${episodes.resolved} 段 + 悬挂 ${episodes.unresolved} 段）`,
        (rate) => rate > JUDGE.directHardShare,
      ),
    });
  }

  // #7 idle_reap+exit_reap ≥5/观察窗天 → 会话常忘收（非档位问题）
  judgments.push({
    id: '7', title: `会话常忘收：idle_reap+exit_reap ≥ ${JUDGE.reapPerDay}/观察窗天`,
    advice: '非档位问题——提示用户侧工作流（preview 模式/显式 stop），不调参',
    ...rateJudge(events.idleReap + events.exitReap, JUDGE.reapPerDay,
      `idle_reap ${events.idleReap} + exit_reap ${events.exitReap} 次 / ${fmtNum(days, 2)} 天`),
  });

  // #8 每 kind 独立：P95(进程max) < declared×0.5 且 max(进程max) < declared×0.8，且该 kind 覆盖窗 ≥14 天
  judgments.push({
    id: '8', title: `声明常态性高估（每 kind 独立）：P95(进程max) < declared×${JUDGE.overestimateP95} 且 max(进程max) < declared×${JUDGE.overestimateMax}，且该 kind 覆盖窗 ≥ ${JUDGE.coverageDays} 天`,
    advice: '下调该档释放预算空间',
    ...kindJudge((ks) => {
      const why = [];
      if (ks.n < JUDGE.percentileMinN) why.push(`样本不足（n=${ks.n} < ${JUDGE.percentileMinN}）`);
      if (ks.windowDays < JUDGE.coverageDays) why.push(`窗口不足（该 kind 覆盖 ${fmtNum(ks.windowDays, 2)} 天 < ${JUDGE.coverageDays}）`);
      if (why.length > 0) return insufficient(why.join('；'));
      const d = `P95=声明×${ks.p95Ratio.toFixed(2)}（需 <${JUDGE.overestimateP95}）且 max=声明×${ks.maxRatio.toFixed(2)}（需 <${JUDGE.overestimateMax}），覆盖 ${fmtNum(ks.windowDays, 2)} 天，n=${ks.n}`;
      return ks.p95Ratio < JUDGE.overestimateP95 && ks.maxRatio < JUDGE.overestimateMax ? hit(d) : miss(d);
    }),
  });

  // ===== 提示 =====
  const hints = [];
  const totalStarted = KINDS.reduce((s, k) => s + kinds[k].started, 0);
  const totalReadings = KINDS.reduce((s, k) => s + kinds[k].samples + kinds[k].budgetKills + kinds[k].evicts, 0);
  if (totalStarted > 0 && totalReadings === 0) {
    hints.push(`spawn_started ${totalStarted} 进程但无任何 RSS 读数——最可能是非 Windows 平台无 RSS 通道（sampleRssBytes 恒空），档位回看判定 #1/#2/#8 不适用`);
  }
  if (sampleEnv === '0' || sampleEnv === 'false') {
    hints.push(`当前环境 GODOT_MCP_MEM_SAMPLE=${sampleEnv}：采样已关闭，数据可能过期`);
  }
  if (window.ageMs !== null && window.ageMs > JUDGE.staleAgeMs) {
    hints.push(`最后事件距今 ${fmtDur(window.ageMs)}——若期间 server 有运行，采样可能已关闭（GODOT_MCP_MEM_SAMPLE=0）或守卫关闭（GODOT_MCP_MEMORY_GUARD=0），数据可能过期`);
  }
  if (events.evictExhausted > 0) {
    hints.push(`evict_exhausted ${events.evictExhausted} 行：hard 持续期间每个 poll 轮落一行（无节流），计数偏大，只作"候选耗尽仍 hard 曾发生"的证据`);
  }
  if (events.watchdogRecovered > 0) {
    hints.push(`watchdog_recovered 在零租约轮次也可能落行（无读数证据），不宜作为通道健康时长的依据`);
  }
  if (unattributedRows > 0) hints.push(`${unattributedRows} 行缺 leaseId 或 kind 不在四档之内，未进每档聚合`);
  if (skipped.futureVersion > 0) hints.push(`${skipped.futureVersion} 行 v>${SAMPLE_VERSION}（更高 schema 版本）已忽略——请升级本脚本后再分析`);
  const hasConclusion = judgments.some((jd) => jd.status !== 'insufficient');
  const exitCode = trigger.met && hasConclusion ? 0 : 1;

  return {
    exitCode,
    parsed: { validRows: rows.length, skipped },
    window,
    thresholds,
    kinds,
    procs: procList,
    events,
    episodes,
    trigger,
    judgments,
    hints,
  };
}

// ===== 报告文本 =====

function padRight(s, w) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** 纯函数：报告 → 人读文本（简体中文）。failures 非空 = 部分文件读失败：首部醒目提示数据不完整，
 *  末行退出码按读失败（2）显示——与 CLI 的钳位口径一致。 */
export function formatReport(report, { filePath, files, failures } = {}) {
  const { window: w, kinds: ks, events: ev, episodes: ep, trigger } = report;
  const partial = failures !== undefined && failures.length > 0;
  const shownExit = partial ? 2 : report.exitCode;
  const out = [];
  out.push('[memguard-review] memory-guard 采样回看（只读分析，不自动调档）');
  if (partial) {
    out.push(`⚠ 数据不完整：${failures.length} 个文件读取失败（清单见 stderr）——以下仅基于已读出的部分，观察窗与频次可能失真；退出码按读失败处理`);
  }
  if (filePath) out.push(`数据源：${filePath}${files && files.length > 1 ? `（含代际，共 ${files.length} 个文件 / ${files.reduce((s, f) => s + f.lines, 0)} 行）` : ''}`);
  const sk = report.parsed.skipped;
  const unknown = Object.entries(sk.unknownEvents).map(([k, v]) => `${k}×${v}`).join(', ');
  out.push(`有效行 ${report.parsed.validRows}；跳过：坏行/半行 ${sk.badLines}、空行 ${sk.blank}、更高版本 ${sk.futureVersion}、未知事件 ${unknown || '无'}`);
  if (w.days === null) {
    out.push('覆盖窗：无有效事件');
  } else {
    // 负值 = 采样时间戳晚于当前时钟（时钟偏移/回放旧数据），不是"距今"
    const age = w.ageMs < 0 ? `时间戳晚于当前时钟（${fmtDur(-w.ageMs)}）` : fmtDur(w.ageMs);
    out.push(`覆盖窗：${fmtTs(w.firstTs)} ~ ${fmtTs(w.lastTs)}（首事件至末事件 ${fmtNum(w.elapsedDays, 2)} 天，计 ${fmtNum(w.days, 2)} 天）；最后事件距今 ${age}`);
  }
  out.push(`触发条件：${trigger.reason}${trigger.met ? '' : ' → 窗口不足，以下判定仅供参考'}［条件：某 kind spawn_started ≥ ${JUDGE.triggerStartedPerKind} 进程，或观察窗 ≥ ${JUDGE.coverageDays} 天］`);

  out.push('');
  out.push('阈值快照（server_start 行，按事件时刻阈值判定）：');
  if (report.thresholds.length === 0) {
    out.push('  （窗口内无 server_start 行——可能已轮转掉）');
  } else {
    for (const t of report.thresholds) {
      const th = t.thresholds ?? {};
      const d = t.declaredMB ? Object.entries(t.declaredMB).map(([k, v]) => `${k}=${v}`).join(' ') : '—';
      const f = t.killFactor ? Object.entries(t.killFactor).map(([k, v]) => `${k}=${v}`).join(' ') : '—';
      out.push(`  ×${t.count}  pkg=${t.pkgVersion ?? '—'}  minFreeMB=${th.minFreeMB ?? '—'} budgetPct=${th.budgetPct ?? '—'} maxInstances=${th.maxInstances ?? '—'} softMB=${th.softMB ?? '—'} hardMB=${th.hardMB ?? '—'}  声明MB: ${d}  killFactor: ${f}`);
    }
  }

  out.push('');
  out.push(`每档进程与 RSS（进程=leaseId；RSS=进程 max，含 budget_kill/evict 读数；nearest-rank 分位，n<${JUDGE.percentileMinN} 不计算分位；n<40 时 P95 落在最大两个样本之内；failed=lease_acquired−spawn_started 差值推导）`);
  out.push(padRight('kind', 12) + padRight('acquired', 10) + padRight('started', 9) + padRight('failed', 8) + padRight('n', 6) + padRight('samples', 9)
    + padRight('P50MB', 8) + padRight('P95MB', 8) + padRight('maxMB', 8) + padRight('声明MB', 10) + padRight('P50/声明', 10) + padRight('P95/声明', 10) + padRight('max/声明', 10)
    + padRight('kill', 6) + 'evict');
  for (const k of KINDS) {
    const s = ks[k];
    out.push(padRight(k, 12) + padRight(String(s.acquired), 10) + padRight(String(s.started), 9) + padRight(String(s.spawnFailed), 8) + padRight(String(s.n), 6) + padRight(String(s.samples), 9)
      + padRight(fmtNum(s.p50MB), 8) + padRight(fmtNum(s.p95MB), 8) + padRight(fmtNum(s.maxMB), 8) + padRight(s.declared.join('|') || '—', 10)
      + padRight(s.p50Ratio === null ? '—' : s.p50Ratio.toFixed(2), 10) + padRight(s.p95Ratio === null ? '—' : s.p95Ratio.toFixed(2), 10) + padRight(s.maxRatio === null ? '—' : s.maxRatio.toFixed(2), 10)
      + padRight(String(s.budgetKills), 6) + String(s.evicts));
  }

  out.push('');
  const rate = (c) => (w.days === null ? '—' : `${fmtNum(c / w.days, 2)}/天`);
  const sr = ev.spawnReject;
  out.push(`事件频次（按观察窗 ${fmtNum(w.days, 2)} 天折算）`);
  out.push(`  spawn_reject 合计 ${sr.total}（${rate(sr.total)}）：查⓪压力 ${sr.byCheck['0'] ?? 0} / 查①水位 ${sr.byCheck['1'] ?? 0}（其中 pressure='normal'：${sr.lowWaterNormalCheck1}，#4 口径）/ 查②预算 ${sr.byCheck['2'] ?? 0} / 查③实例 ${sr.byCheck['3'] ?? 0}`);
  out.push(`  杀：budget_kill ${ev.budgetKill}（${rate(ev.budgetKill)}）  evict ${ev.evict}  evict_exhausted ${ev.evictExhausted}`);
  out.push(`  回收：idle_reap ${ev.idleReap}  exit_reap ${ev.exitReap}  合计 ${ev.idleReap + ev.exitReap}（${rate(ev.idleReap + ev.exitReap)}）`);
  const pcc = ev.pressureChange;
  out.push(`  pressure_change：→pressure ${pcc.toPressure}  直进 hard ${pcc.directHard}  升级 hard ${pcc.upgradedHard}  降级 ${pcc.downgraded}  →normal ${pcc.toNormal}`);
  out.push(`  watchdog_degraded ${ev.watchdogDegraded}  watchdog_recovered ${ev.watchdogRecovered}`);

  out.push('');
  out.push(`pressure episode（按 serverPid 分段）：闭合 ${ep.resolved} / 悬挂 ${ep.unresolved}（不进时长集）/ 孤立闭合行 ${ep.orphanCloses}`);
  if (ep.resolved > 0) {
    out.push(`  闭合段时长：中位 ${fmtNum(ep.medianMin, 1)}min，<${JUDGE.shortEpisodeMs / 60_000}min 占比 ${fmtPct(ep.shareUnder15min)}`);
  }
  out.push(`  切换行（含悬挂段）：经 pressure 进 ${ep.viaPressure} / 直进 hard ${ep.directHard} / 升级 hard ${ep.upgradedHard} / 降级 ${ep.downgrades}；降级后 ${JUDGE.hardFlapWindowMs / 60_000}min 内再升级 ${ep.flaps} 次`);
  for (const e of ep.list.slice(0, 12)) {
    out.push(`  serverPid=${e.serverPid}  ${fmtTs(e.startTs)} ~ ${e.resolved ? fmtTs(e.endTs) : '（无闭合）'}  ${e.resolved ? `${fmtNum(e.durationMin, 1)}min` : '悬挂'}  经pressure进 ${e.viaPressure} / 直进hard ${e.directHard} / 升级 ${e.upgradedHard} / 降级 ${e.downgrades}`);
  }
  if (ep.list.length > 12) out.push(`  …另有 ${ep.list.length - 12} 段未列出`);

  out.push('');
  out.push('九条判定（命中 / 未命中 / 数据不足）');
  for (const jd of report.judgments) {
    out.push(`  #${jd.id} ${jd.title}`);
    if (jd.perKind) {
      for (const k of KINDS) {
        const c = jd.perKind[k];
        out.push(`     ${padRight(k, 12)} ${STATUS_LABEL[c.status]}  ${c.detail}`);
      }
    } else {
      out.push(`     ${STATUS_LABEL[jd.status]}  ${jd.detail}`);
    }
    if (jd.advice && jd.status === 'hit') out.push(`     建议：${jd.advice}`);
  }

  if (report.hints.length > 0) {
    out.push('');
    out.push('提示：');
    for (const h of report.hints) out.push(`  - ${h}`);
  }
  out.push('');
  out.push(`退出码 ${shownExit}${partial ? '（部分读失败钳位；' : '（'}0=有结论 / 1=数据不足：触发条件未满足或无判定可下结论 / 2=读失败）`);
  return out.join('\n');
}

// ===== CLI 壳 =====

const USAGE = '用法：node scripts/memguard-review.mjs [--file <path>]';

function parseArgs(argv) {
  const args = { help: false, file: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') {
      args.file = argv[i + 1];
      if (args.file === undefined || args.file.startsWith('--')) return { error: '--file 缺少路径' };
      i++;
    } else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else return { error: `未知参数：${a}` };
  }
  return args; // 无 --file → 默认路径
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { console.error(`[memguard-review] ${args.error}\n${USAGE}`); return 2; }
  if (args.help) { console.log(USAGE); return 0; }
  const filePath = args.file ?? defaultSamplePath();
  const loaded = loadSampleFile(filePath);
  for (const f of loaded.failures) console.error(`[memguard-review] 读取失败：${f.path}——${f.error}`);
  if (loaded.files.length === 0) {
    console.error(`[memguard-review] 无可读采样文件（${filePath}）：采样可能从未开启/从未产生事件；用 --file 指定路径`);
    return 2;
  }
  const report = analyze(loaded.lines, { sampleEnv: process.env.GODOT_MCP_MEM_SAMPLE });
  console.log(formatReport(report, { filePath, files: loaded.files, failures: loaded.failures }));
  // 部分读失败（任一代际不可读 / 主文件缺失而代际存在）：已读部分照常出报告，但退出码钳为 2——
  // 最旧代际丢失会让观察窗缩短、X/天 频次虚高、#8 覆盖窗失真，脚本化调用方不能把 0 当可信信号（审查 Important-2）
  return loaded.failures.length > 0 ? 2 : report.exitCode;
}

// 同 check-tool-count.mjs：import 不执行 main，直接运行（argv[1] 与本文件同源）才跑
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
