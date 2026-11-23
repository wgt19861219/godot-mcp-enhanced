import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  KILL_FACTOR, PRESSURE_RECOVER_MS, HARD_MIN_RECLAIM_MB, KINDS,
  parseLines, loadSampleFile, analyze, formatReport, defaultSamplePath,
} from '../../scripts/memguard-review.mjs';

// golden fixture 六场景（A–F）+ 常量机械比对——直接 import mjs 的纯函数（analyze 不碰文件系统）。
// 行形态逐字对齐 src/core/memory-guard.ts buildSampleLine：公共壳 ts/v/event/serverPid，
// rss_sample 无 machine 键，pressure_change 无 pressure 键（用 from/to）。
// 判定口径权威：docs/superpowers/specs/2026-11-23-memory-guard-p4-design.md「回看判定标准」表。

const T0 = Date.UTC(2026, 10, 10); // 2026-11-10 00:00:00Z 固定基准（不依赖真实时钟）
const DAY = 86_400_000;
const MIN = 60_000;
const MB = 1024 * 1024;
const NOW = T0 + 20 * DAY; // analyze 的固定"现在"（全部 fixture 的最后事件之后）
const SRV1 = 100;
const SRV2 = 200;

type RowOpts = { ts?: number; serverPid?: number; pressure?: string; v?: number };

/** 拼一行采样 JSONL（公共壳对齐 buildSampleLine 的两个条件省略）。 */
function line(event: string, fields: Record<string, unknown> = {}, o: RowOpts = {}): string {
  const row: Record<string, unknown> = {
    ts: o.ts ?? T0, v: o.v ?? 1, event, serverPid: o.serverPid ?? SRV1, ...fields,
  };
  if (event !== 'rss_sample') row.machine = null;
  if (event !== 'pressure_change') row.pressure = o.pressure ?? 'normal';
  return JSON.stringify(row);
}

const DEFAULT_THRESHOLDS = { minFreeMB: 3072, budgetPct: 67, maxInstances: 8, softMB: 3072, hardMB: 1536 };
const DEFAULT_DECLARED = { headless: 2048, gut_shard: 8192, game_window: 3072, editor: 3072 };

function serverStart(ts: number, serverPid: number = SRV1): string {
  return line('server_start', {
    pkgVersion: '0.41.0', thresholds: DEFAULT_THRESHOLDS, declaredMB: DEFAULT_DECLARED,
    killFactor: { ...KILL_FACTOR }, pollSeconds: 10, tzOffsetMin: 480,
  }, { ts, serverPid });
}

/** pressure_change 行（from/to，无 pressure 键）。 */
function pc(from: string, to: string, ts: number, serverPid: number = SRV1): string {
  return line('pressure_change', { from, to }, { ts, serverPid });
}

let pidSeq = 5000;
type ProcOpts = { pid?: number; serverPid?: number; leaseTs?: number; killMB?: number; killTs?: number; evictMB?: number };

/** 一个进程：lease_acquired + spawn_started（leaseTs，默认 sampleTs−1min）+ 一行 rss_sample（sampleTs）；
 *  killMB/evictMB 给定时另加一行带 rssBytes 的杀事件。无读数的 lease_acquired 单独构造。 */
function proc(leaseId: string, kind: string, declaredMB: number, rssMB: number | null, sampleTs: number, o: ProcOpts = {}): string[] {
  const pid = o.pid ?? pidSeq++;
  const sp = o.serverPid ?? SRV1;
  const leaseTs = o.leaseTs ?? sampleTs - MIN;
  const base = { kind, project: `D:/proj/${kind}`, leaseId, pid };
  const out = [
    line('lease_acquired', { ...base, declaredMB }, { ts: leaseTs, serverPid: sp }),
    line('spawn_started', base, { ts: leaseTs, serverPid: sp }),
  ];
  if (rssMB !== null) out.push(line('rss_sample', { ...base, declaredMB, rssBytes: rssMB * MB }, { ts: sampleTs, serverPid: sp }));
  if (o.killMB !== undefined) {
    out.push(line('budget_kill', {
      ...base, declaredMB, rssBytes: o.killMB * MB,
      budgetBytes: declaredMB * KILL_FACTOR[kind as keyof typeof KILL_FACTOR] * MB, killFactor: KILL_FACTOR[kind as keyof typeof KILL_FACTOR],
    }, { ts: o.killTs ?? sampleTs + MIN, serverPid: sp }));
  }
  if (o.evictMB !== undefined) {
    out.push(line('evict', { ...base, declaredMB, rssBytes: o.evictMB * MB, ratio: o.evictMB / declaredMB, reason: 'hard' },
      { ts: sampleTs + MIN, serverPid: sp }));
  }
  return out;
}

function reap(event: 'idle_reap' | 'exit_reap', ts: number, pid = 7000): string {
  return line(event, { kind: 'game_window', project: 'd/proj/game', pid, aliveMs: 900_000 }, { ts });
}

// ---- 报告的最小类型面（mjs 无 .d.ts，测试只声明用到的字段）----
type Status = 'hit' | 'miss' | 'insufficient';
interface KindJudge { status: Status; detail: string }
interface Judgment { id: string; status: Status; detail: string; perKind?: Record<string, KindJudge> }
interface KindStats {
  acquired: number; started: number; spawnFailed: number; n: number; samples: number;
  budgetKills: number; evicts: number; killDays: string[];
  p50MB: number | null; p95MB: number | null; maxMB: number | null;
  p50Ratio: number | null; p95Ratio: number | null; maxRatio: number | null; windowDays: number;
}
interface ProcRow { leaseId: string; pid: number | null; kind: string; declaredMB: number | null; started: boolean; samples: number; maxBytes: number | null; budgetKilled: boolean; evicted: boolean }
interface Report {
  exitCode: number;
  parsed: { validRows: number; skipped: { badLines: number; blank: number; futureVersion: number; unknownEvents: Record<string, number> } };
  window: { firstTs: number | null; lastTs: number | null; days: number | null; ageMs: number | null };
  thresholds: Array<{ count: number; minFreeEqualsSoft: boolean }>;
  kinds: Record<string, KindStats>;
  procs: ProcRow[];
  events: {
    spawnReject: { total: number; byCheck: Record<string, number>; byReason: Record<string, number>; lowWaterNormalCheck1: number };
    budgetKill: number; evict: number; evictExhausted: number; idleReap: number; exitReap: number;
    pressureChange: { toPressure: number; directHard: number; upgradedHard: number; downgraded: number; toNormal: number };
    watchdogDegraded: number; watchdogRecovered: number;
  };
  episodes: {
    resolved: number; unresolved: number; orphanCloses: number;
    viaPressure: number; directHard: number; upgradedHard: number; downgrades: number; hardEntries: number; flaps: number;
    medianMin: number | null; shortCount: number; shareUnder15min: number | null;
    list: Array<{ serverPid: number; startTs: number; endTs: number | null; resolved: boolean; durationMin: number | null }>;
  };
  trigger: { met: boolean; reason: string };
  judgments: Judgment[];
  hints: string[];
}

function run(lines: string[]): Report {
  return analyze(lines, { now: NOW });
}
function j(r: Report, id: string): Judgment {
  const found = r.judgments.find((x) => x.id === id);
  if (!found) throw new Error(`报告缺判定 #${id}`);
  return found;
}
function jk(r: Report, id: string, kind: string): KindJudge {
  const per = j(r, id).perKind;
  if (!per || !per[kind]) throw new Error(`判定 #${id} 缺 kind=${kind}`);
  return per[kind];
}

// ---------------------------------------------------------------------------
// fixture A（命中侧）：30 headless 进程 P50>declared + 15 例 budget_kill（跨多日）+
// 20 gut_shard 进程低 RSS 覆盖 14 天 + 完整 pressure episode（升级→降级→10min 内再升级）。
// headless/gut_shard 两档事件均从 T0 铺到 T0+14d（两档 kind 覆盖窗都 ≥14，#8 才能对 headless 下"未命中"）。
// ---------------------------------------------------------------------------
const headlessSampleTs = (i: number): number => T0 + Math.round((i * (14 * DAY - 60 * MIN)) / 29);
const headlessKillTs = (i: number): number => headlessSampleTs(i) + 60 * MIN;
const localDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function fixtureA(): string[] {
  const out = [serverStart(T0)];
  // headless：i<15 仅样本读数 3000+i MB（>declared 2048）；i≥15 另有 budget_kill 5000+i MB（样本后 1h）——
  // 样本时刻均匀铺满 14 天，末进程的 kill 恰在 T0+14d；15 例 / 14 天 ≥ 1/天。
  for (let i = 0; i < 30; i++) {
    out.push(...proc(`h${i}`, 'headless', 2048, 3000 + i, headlessSampleTs(i), {
      leaseTs: i === 0 ? T0 : undefined,
      killMB: i >= 15 ? 5000 + i : undefined,
      killTs: i >= 15 ? headlessKillTs(i) : undefined,
    }));
  }
  // 一个 spawn 失败：lease_acquired 后无 spawn_started（差值推导）
  out.push(line('lease_acquired', { kind: 'headless', project: 'D:/proj/fail', leaseId: 'hfail', declaredMB: 2048 }, { ts: T0 + 40 * MIN }));
  // gut_shard：20 进程 RSS 2000+i MB（远低于 8192 声明），首末样本恰跨 14 天
  for (let i = 0; i < 20; i++) {
    const sampleTs = i === 0 ? T0 + MIN : i === 19 ? T0 + 14 * DAY : T0 + Math.round((i * 14 * DAY) / 19);
    out.push(...proc(`g${i}`, 'gut_shard', 8192, 2000 + i, sampleTs));
  }
  // pressure episode（server 100，day 2）：进 pressure → 升级 hard → 降级 → 5min 内再升级（抖动）→ 降级 → 恢复
  const a = T0 + 2 * DAY;
  out.push(
    pc('normal', 'pressure', a), pc('pressure', 'hard', a + 20 * MIN),
    pc('hard', 'pressure', a + 30 * MIN), pc('pressure', 'hard', a + 35 * MIN),
    pc('hard', 'pressure', a + 45 * MIN), pc('pressure', 'normal', a + 60 * MIN),
  );
  out.push(line('evict_exhausted', { envExempted: { preview: 0, editor: 0 } }, { ts: a + 21 * MIN }));
  out.push(line('watchdog_degraded', { consecutiveRounds: 3 }, { ts: a + 22 * MIN }));
  out.push(line('watchdog_recovered', {}, { ts: a + 50 * MIN }));
  return out;
}

describe('fixture A（命中侧）', () => {
  it('触发条件满足、退出码 0、进程/杀/差值推导口径正确', () => {
    const r = run(fixtureA());
    expect(r.parsed.validRows).toBe(fixtureA().length);
    expect(r.parsed.skipped).toEqual({ badLines: 0, blank: 0, futureVersion: 0, unknownEvents: {} });
    expect(r.window.firstTs).toBe(T0);
    expect(r.window.lastTs).toBe(T0 + 14 * DAY);
    expect(r.window.days).toBe(14);
    expect(r.trigger.met).toBe(true);
    expect(r.exitCode).toBe(0);
    const h = r.kinds.headless!;
    expect(h.started).toBe(30);
    expect(h.acquired).toBe(31);
    expect(h.spawnFailed).toBe(1); // lease_acquired − spawn_started
    expect(h.n).toBe(30);
    expect(h.budgetKills).toBe(15);
    // 杀日按本机时区的日历日去重（期望值与实现同式，跨时区稳）
    expect(h.killDays).toEqual([...new Set(Array.from({ length: 15 }, (_, n) => localDate(headlessKillTs(n + 15))))]);
    expect(h.killDays.length).toBeGreaterThan(1);
    expect(h.windowDays).toBeGreaterThanOrEqual(14);
    expect(r.kinds.gut_shard!.n).toBe(20);
    expect(r.kinds.game_window!.n).toBe(0);
    expect(r.kinds.editor!.n).toBe(0);
    expect(r.thresholds[0]!.minFreeEqualsSoft).toBe(true);
    expect(r.events.evictExhausted).toBe(1);
    expect(r.events.watchdogDegraded).toBe(1);
    expect(r.events.watchdogRecovered).toBe(1);
  });

  it('#1 P50>declared：headless 命中 / gut_shard 未命中 / 零样本 kind 数据不足', () => {
    const r = run(fixtureA());
    const h = r.kinds.headless!;
    // 30 进程升序：15×(3000..3014) + 15×(5015..5029)；P50=第 15 位 3014MB / P95=第 29 位 5028MB
    expect(h.p50MB).toBe(3014);
    expect(h.p95MB).toBe(5028);
    expect(h.maxMB).toBe(5029);
    expect(h.p50Ratio).toBeCloseTo(3014 / 2048, 6);
    expect(jk(r, '1', 'headless').status).toBe('hit');
    expect(jk(r, '1', 'gut_shard').status).toBe('miss');
    expect(jk(r, '1', 'editor').status).toBe('insufficient');
    expect(jk(r, '1', 'editor').detail).toContain('样本不足');
  });

  it('#2 P95>KILL_FACTOR：headless 命中（kill 读数进 P95）/ gut_shard 未命中', () => {
    const r = run(fixtureA());
    expect(jk(r, '2', 'headless').status).toBe('hit');
    expect(jk(r, '2', 'gut_shard').status).toBe('miss');
    expect(jk(r, '2', 'game_window').status).toBe('insufficient');
  });

  it('#3 budget_kill ≥1/观察窗天：headless 命中（15/14）并附杀日 / gut_shard 未命中', () => {
    const r = run(fixtureA());
    const hd = jk(r, '3', 'headless');
    expect(hd.status).toBe('hit');
    expect(hd.detail).toContain('1.07');
    expect(hd.detail).toContain(`出现在 ${r.kinds.headless!.killDays.length} 个不同日`);
    expect(jk(r, '3', 'gut_shard').status).toBe('miss');
  });

  it('episode 重建：1 闭合 / 0 悬挂，升级 2、降级 2、10min 内再升级 1，时长 60min', () => {
    const r = run(fixtureA());
    const e = r.episodes;
    expect(e.resolved).toBe(1);
    expect(e.unresolved).toBe(0);
    expect(e.orphanCloses).toBe(0);
    expect(e.viaPressure).toBe(1);
    expect(e.directHard).toBe(0);
    expect(e.upgradedHard).toBe(2);
    expect(e.downgrades).toBe(2);
    expect(e.hardEntries).toBe(2);
    expect(e.flaps).toBe(1);
    expect(e.medianMin).toBe(60);
    expect(e.shareUnder15min).toBe(0);
    expect(e.list).toHaveLength(1);
    expect(e.list[0]!.serverPid).toBe(SRV1);
    expect(e.list[0]!.durationMin).toBe(60);
    expect(r.events.pressureChange).toEqual({ toPressure: 1, directHard: 0, upgradedHard: 2, downgraded: 2, toNormal: 1 });
  });

  it('#5a hard 抖动率 1/2=50%>30% 命中；#5b <15min 占比 0% 未命中；#6 直进 0/1 未命中', () => {
    const r = run(fixtureA());
    expect(j(r, '5a').status).toBe('hit');
    expect(j(r, '5a').detail).toContain('50.0%');
    expect(j(r, '5b').status).toBe('miss');
    expect(j(r, '6').status).toBe('miss');
  });

  it('#4 无 check=1 拒绝未命中；#7 无回收未命中', () => {
    const r = run(fixtureA());
    expect(j(r, '4').status).toBe('miss');
    expect(j(r, '7').status).toBe('miss');
  });

  it('#8 gut_shard 命中（P95<0.5 且 max<0.8，覆盖 14 天）/ headless 未命中 / 零样本 kind 样本不足', () => {
    const r = run(fixtureA());
    const g = r.kinds.gut_shard!;
    expect(g.windowDays).toBe(14);
    expect(g.p95Ratio).toBeCloseTo(2018 / 8192, 6);
    expect(g.maxRatio).toBeCloseTo(2019 / 8192, 6);
    expect(jk(r, '8', 'gut_shard').status).toBe('hit');
    expect(jk(r, '8', 'headless').status).toBe('miss');
    expect(jk(r, '8', 'editor').status).toBe('insufficient');
    expect(jk(r, '8', 'editor').detail).toContain('样本不足');
  });

  it('九条判定齐全且有序；报告文本含触发条件/三态', () => {
    const r = run(fixtureA());
    expect(r.judgments.map((x) => x.id)).toEqual(['1', '2', '3', '4', '5a', '5b', '6', '7', '8']);
    const text = formatReport(r);
    expect(text).toContain('触发条件：满足');
    expect(text).toContain('命中');
    expect(text).toContain('未命中');
    expect(text).toContain('数据不足');
  });
});

// ---------------------------------------------------------------------------
// fixture B（右删失）：进程只有 budget_kill/evict 行带 rssBytes（无 rss_sample）→ max 取杀读数。
// ---------------------------------------------------------------------------
function fixtureB(killOnly: number): string[] {
  const out = [serverStart(T0)];
  for (let i = 0; i < 20; i++) {
    const killOnlyProc = i >= 20 - killOnly;
    out.push(...proc(`b${i}`, 'headless', 2048, killOnlyProc ? null : 1000, T0 + (i + 1) * MIN, {
      killMB: killOnlyProc ? 5200 : undefined,
    }));
  }
  return out;
}

describe('fixture B（右删失：仅杀行有读数）', () => {
  it('仅 budget_kill 行的进程计入 n，max 取 kill 读数', () => {
    const r = run(fixtureB(2));
    const h = r.kinds.headless!;
    expect(h.n).toBe(20);
    expect(h.samples).toBe(18);
    const killed = r.procs.filter((p) => p.budgetKilled);
    expect(killed).toHaveLength(2);
    for (const p of killed) {
      expect(p.samples).toBe(0);
      expect(p.maxBytes).toBe(5200 * MB);
    }
    expect(h.maxMB).toBe(5200);
  });

  it('#2 可触发：2/20 kill 读数进 P95（第 19 位）→ 命中；1/20 时 P95 为存活读数 → 未命中', () => {
    expect(jk(run(fixtureB(2)), '2', 'headless').status).toBe('hit');
    const r1 = run(fixtureB(1));
    expect(r1.kinds.headless!.p95MB).toBe(1000);
    expect(jk(r1, '2', 'headless').status).toBe('miss');
  });

  it('仅 evict 行的进程：max 取 evict.rssBytes（推算读数照 spec 计入）', () => {
    const r = run([serverStart(T0), ...proc('e0', 'game_window', 3072, null, T0 + MIN, { evictMB: 3000 })]);
    const p = r.procs.find((x) => x.leaseId === 'e0')!;
    expect(p.evicted).toBe(true);
    expect(p.maxBytes).toBe(3000 * MB);
    expect(r.kinds.game_window!.n).toBe(1);
    expect(r.kinds.game_window!.evicts).toBe(1);
    expect(r.events.evict).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fixture C（pid 复用 + 跨 server）：同 pid 4242 两个 leaseId 分开聚合；两 server 行交错、
// 输入按 ts 倒序喂入（analyze 必须按 ts 排序）；episode 按 serverPid 分段。
// ---------------------------------------------------------------------------
function fixtureC(): string[] {
  const out = [
    serverStart(T0, SRV1), serverStart(T0 + MIN, SRV2),
    ...proc('la-1', 'headless', 2048, 1500, T0 + 5 * MIN, { pid: 4242, serverPid: SRV1 }),
    ...proc('lb-1', 'headless', 2048, 3000, T0 + 6 * MIN, { pid: 4242, serverPid: SRV2 }),
    // server 100：直进 hard → 降级 → 恢复（40min）
    pc('normal', 'hard', T0 + 60 * MIN, SRV1), pc('hard', 'pressure', T0 + 70 * MIN, SRV1), pc('pressure', 'normal', T0 + 100 * MIN, SRV1),
    // server 200：进 pressure → 恢复（90min），时间上与 server 100 的 episode 交错
    pc('normal', 'pressure', T0 + 30 * MIN, SRV2), pc('pressure', 'normal', T0 + 120 * MIN, SRV2),
  ];
  return out.reverse();
}

describe('fixture C（pid 复用 + 跨 server）', () => {
  it('同 pid 两 leaseId 分开聚合，各自 max 独立', () => {
    const r = run(fixtureC());
    const same = r.procs.filter((p) => p.pid === 4242);
    expect(same).toHaveLength(2);
    expect(same.map((p) => p.maxBytes).sort((a, b) => a! - b!)).toEqual([1500 * MB, 3000 * MB]);
    expect(r.kinds.headless!.n).toBe(2);
    expect(r.kinds.headless!.started).toBe(2);
  });

  it('episode 按 serverPid 分段：2 段闭合，直进 hard 1、降级 1；#6 1/2 命中、#5a 0/1 未命中', () => {
    const r = run(fixtureC());
    const e = r.episodes;
    expect(e.resolved).toBe(2);
    expect(e.unresolved).toBe(0);
    expect(e.list.map((x) => x.serverPid)).toEqual([SRV2, SRV1]); // 按 startTs 升序（输入倒序也被排回）
    expect(e.list[0]!.durationMin).toBe(90);
    expect(e.list[1]!.durationMin).toBe(40);
    expect(e.directHard).toBe(1);
    expect(e.viaPressure).toBe(1);
    expect(e.downgrades).toBe(1);
    expect(e.hardEntries).toBe(1);
    expect(e.flaps).toBe(0);
    expect(j(r, '6').status).toBe('hit');
    expect(j(r, '5a').status).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// fixture D（悬挂 episode，控制器裁定 C3）：悬挂段只从 #5b 时长集剔除，其切换行照常进 #5a/#6。
// 两个形态各给一个方向的判别证据——悬挂行被排除则结论翻转。
// ---------------------------------------------------------------------------
function startRow(serverPid: number, ts: number): string {
  return line('server_start', { pkgVersion: '0.41.0' }, { ts, serverPid });
}
const TAIL_ROW = line('lease_acquired', { kind: 'headless', project: 'p', leaseId: 'tail', declaredMB: 2048 }, { ts: T0 + 300 * MIN });

/** D1（命中方向）：悬挂段直进 hard + 降级后 5min 再升级（无闭合）；闭合段经 pressure 进入后 10min 恢复。 */
function fixtureD1(): string[] {
  return [
    startRow(300, T0),
    pc('normal', 'hard', T0 + 60 * MIN, 300), pc('hard', 'pressure', T0 + 70 * MIN, 300), pc('pressure', 'hard', T0 + 75 * MIN, 300), // 无闭合
    startRow(400, T0 + 120 * MIN),
    pc('normal', 'pressure', T0 + 180 * MIN, 400), pc('pressure', 'normal', T0 + 190 * MIN, 400), // 10min 闭合
    pc('pressure', 'normal', T0 + 240 * MIN, 500), // 孤立闭合行（进入行已轮转掉）
    TAIL_ROW,
  ];
}

/** D2（未命中方向）：三段悬挂均经 pressure 进入（其中一段含降级后 5min 再升级）；闭合段直进 hard 后降级（无再升级）恢复，40min。 */
function fixtureD2(): string[] {
  return [
    startRow(310, T0), pc('normal', 'pressure', T0 + 10 * MIN, 310),
    startRow(320, T0 + MIN), pc('normal', 'pressure', T0 + 20 * MIN, 320),
    startRow(330, T0 + 2 * MIN),
    pc('normal', 'pressure', T0 + 30 * MIN, 330), pc('pressure', 'hard', T0 + 35 * MIN, 330),
    pc('hard', 'pressure', T0 + 40 * MIN, 330), pc('pressure', 'hard', T0 + 45 * MIN, 330), // 降级后 5min 再升级，无闭合
    startRow(400, T0 + 3 * MIN),
    pc('normal', 'hard', T0 + 100 * MIN, 400), pc('hard', 'pressure', T0 + 110 * MIN, 400), pc('pressure', 'normal', T0 + 140 * MIN, 400),
    TAIL_ROW,
  ];
}

describe('fixture D（悬挂 episode：只从 #5b 时长集剔除）', () => {
  it('D1：悬挂段直进行进 #6 分子分母 → 1/2 命中；降级后再升级进 #5a → 1/2 命中；#5b 仍只用闭合段 → 100% 命中', () => {
    const r = run(fixtureD1());
    const e = r.episodes;
    expect(e.resolved).toBe(1);
    expect(e.unresolved).toBe(1);
    expect(e.orphanCloses).toBe(1);
    expect(e.list.find((x) => !x.resolved)!.serverPid).toBe(300);
    // 行级统计含悬挂段
    expect(e.directHard).toBe(1);
    expect(e.viaPressure).toBe(1);
    expect(e.upgradedHard).toBe(1);
    expect(e.downgrades).toBe(1);
    expect(e.hardEntries).toBe(2);
    expect(e.flaps).toBe(1);
    // #6：悬挂段的直进行进分子与分母 → 1/2；若悬挂段被排除则 0/1 未命中
    expect(j(r, '6').status).toBe('hit');
    expect(j(r, '6').detail).toContain('直进 1 / 进入行 2');
    expect(j(r, '6').detail).toContain('50.0%');
    // #5a：悬挂段「降级后 5min 再升级」进分子、hard 进入进分母 → 1/2；若悬挂段被排除则无 hard 进入（数据不足）
    expect(j(r, '5a').status).toBe('hit');
    expect(j(r, '5a').detail).toContain('再升级 1 / hard 进入 2');
    // #5b：仅闭合的 10min episode 进时长集 → 100% 命中；若悬挂段（60→300min）被误计入则为 50% 未命中
    expect(e.shortCount).toBe(1);
    expect(e.shareUnder15min).toBe(1);
    expect(j(r, '5b').status).toBe('hit');
    expect(j(r, '5b').detail).toContain('100.0%');
  });

  it('D2：三段悬挂的进入行进 #6 分母 → 1/4=25% 未命中（排除则 1/1 命中）；悬挂段抖动进 #5a 分子 → 1/3 命中', () => {
    const r = run(fixtureD2());
    const e = r.episodes;
    expect(e.resolved).toBe(1);
    expect(e.unresolved).toBe(3);
    expect(e.viaPressure).toBe(3);
    expect(e.directHard).toBe(1);
    expect(e.upgradedHard).toBe(2); // 330 段两次升级：首次进 hard + 降级后 5min 再升级
    expect(e.downgrades).toBe(2);
    expect(e.hardEntries).toBe(3); // 330 段 2 次 + 400 段直进 1 次
    expect(e.flaps).toBe(1);
    expect(j(r, '6').status).toBe('miss');
    expect(j(r, '6').detail).toContain('直进 1 / 进入行 4');
    expect(j(r, '6').detail).toContain('25.0%');
    // #5a：悬挂段的再升级进分子、两次 hard 进入进分母 → 1/3；若悬挂段被排除则 0/1 未命中
    expect(j(r, '5a').status).toBe('hit');
    expect(j(r, '5a').detail).toContain('再升级 1 / hard 进入 3');
    expect(j(r, '5a').detail).toContain('33.3%');
    // #5b 只看闭合的 40min 段 → 0% 未命中（三段悬挂不在时长集）
    expect(e.shortCount).toBe(0);
    expect(j(r, '5b').status).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// fixture E（坏行/半行/未知 event/更高 v + 代际合并）
// ---------------------------------------------------------------------------
describe('fixture E（坏行与代际合并）', () => {
  it('坏行/半行跳过计数不炸；未知 event 与更高 v 分别计数', () => {
    const lines = [
      serverStart(T0),
      '{"ts":1760000000000,"v":1,"event":"lease_acc', // 半行
      'not json at all', // 坏行
      '[]', // 非对象
      '{}', // 缺壳字段
      line('teleport_start', {}, { ts: T0 + 1 }), // 未知 event
      line('lease_acquired', { kind: 'headless', project: 'p', leaseId: 'x', declaredMB: 2048 }, { ts: T0 + 2, v: 2 }), // 更高 v
      '', // 空行
      line('spawn_started', { kind: 'headless', project: 'p', leaseId: 'x', pid: 1 }, { ts: T0 + 3 }),
      '{"ts":"1760000000000","v":1,"event":"spawn_started","serverPid":1}', // ts 非数字
    ];
    const { rows, skipped } = parseLines(lines);
    expect(rows.map((x) => x.event)).toEqual(['server_start', 'spawn_started']);
    expect(skipped.badLines).toBe(5);
    expect(skipped.blank).toBe(1);
    expect(skipped.futureVersion).toBe(1);
    expect(skipped.unknownEvents).toEqual({ teleport_start: 1 });
    const r = run(lines);
    expect(r.exitCode).toBe(1); // 触发条件不满足
    expect(j(r, '5a').status).toBe('insufficient');
    expect(j(r, '5b').status).toBe('insufficient');
    expect(j(r, '6').status).toBe('insufficient');
    expect(j(r, '4').status).toBe('miss');
  });

  it('空输入：窗口为 null，全部判定数据不足，退出码 1', () => {
    const r = run([]);
    expect(r.window.days).toBeNull();
    expect(r.trigger.met).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.judgments.every((x) => x.status === 'insufficient')).toBe(true);
    expect(r.judgments.every((x) => !x.perKind || Object.values(x.perKind).every((k) => k.status === 'insufficient'))).toBe(true);
  });

  it('.1 代际与主文件按 ts 排序合并；.lock 不是代际', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memguard-review-'));
    try {
      const main = join(dir, 'ev.jsonl');
      writeFileSync(`${main}.1`, [line('lease_acquired', { kind: 'headless', project: 'p', leaseId: 'g', declaredMB: 2048 }, { ts: T0 + 2 * 60 * MIN }), serverStart(T0 - DAY)].join('\n') + '\n');
      writeFileSync(main, [line('spawn_started', { kind: 'headless', project: 'p', leaseId: 'g', pid: 9 }, { ts: T0 + 60 * MIN })].join('\n'));
      writeFileSync(`${main}.lock`, '12345'); // 轮转锁，不是代际
      const loaded = loadSampleFile(main);
      expect(loaded.failures).toEqual([]);
      expect(loaded.files.map((f) => f.path)).toEqual([`${main}.1`, main]);
      const { rows } = parseLines(loaded.lines);
      expect(rows.map((x) => x.ts)).toEqual([T0 - DAY, T0 + 60 * MIN, T0 + 2 * 60 * MIN]);
      expect(rows[0]!.event).toBe('server_start'); // server_start 在旧代际里也能合并进来
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('主文件缺失：failures 记一条、零行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memguard-review-'));
    try {
      const loaded = loadSampleFile(join(dir, 'nope.jsonl'));
      expect(loaded.lines).toEqual([]);
      expect(loaded.files).toEqual([]);
      expect(loaded.failures).toHaveLength(1);
      expect(loaded.failures[0]!.path).toBe(join(dir, 'nope.jsonl'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fixture F（观察窗）：频次按观察窗天折算；<14 天时 #8 报"窗口不足"非"未命中"。
// ---------------------------------------------------------------------------
function fixtureF1(): string[] {
  const out = [serverStart(T0)];
  for (let i = 0; i < 20; i++) {
    const sampleTs = i === 19 ? T0 + 3 * DAY : T0 + Math.round((i * 3 * DAY) / 19);
    out.push(...proc(`f${i}`, 'headless', 2048, 600, i === 0 ? T0 + MIN : sampleTs));
  }
  for (const d of [1, 2]) {
    out.push(line('spawn_reject', { kind: 'headless', project: 'p', check: 1, reason: 'MEMGUARD_LOW_WATER', thresholds: { minFreeMB: 3072 } }, { ts: T0 + d * DAY }));
    out.push(reap('idle_reap', T0 + d * DAY + MIN, 7000 + d));
  }
  return out;
}

describe('fixture F（观察窗）', () => {
  it('F1：3 天窗 + 2 次 check=1 拒绝 → 0.67/天未命中；#8 窗口不足非未命中；触发条件不满足退出码 1', () => {
    const r = run(fixtureF1());
    expect(r.window.days).toBeCloseTo(3, 3);
    expect(r.kinds.headless!.n).toBe(20);
    expect(r.events.spawnReject.lowWaterNormalCheck1).toBe(2);
    const j4 = j(r, '4');
    expect(j4.status).toBe('miss');
    expect(j4.detail).toContain('0.67');
    expect(j(r, '7').status).toBe('miss');
    expect(jk(r, '1', 'headless').status).toBe('miss'); // n=20 可算分位
    const j8 = jk(r, '8', 'headless');
    expect(j8.status).toBe('insufficient');
    expect(j8.detail).toContain('窗口不足');
    expect(j8.detail).not.toContain('未命中');
    expect(r.trigger.met).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('F2：1 小时窗按 1 天计（不折 24 倍）；3 次有效 check=1 → 3/天命中；回收 5/天命中', () => {
    const lines = [
      serverStart(T0),
      line('spawn_reject', { kind: 'headless', project: 'p', check: 1, reason: 'MEMGUARD_LOW_WATER', thresholds: { minFreeMB: 3072 } }, { ts: T0 + 1 * MIN }),
      line('spawn_reject', { kind: 'headless', project: 'p', check: 1, reason: 'MEMGUARD_LOW_WATER', thresholds: { minFreeMB: 3072 } }, { ts: T0 + 2 * MIN }),
      line('spawn_reject', { kind: 'headless', project: 'p', check: 1, reason: 'MEMGUARD_LOW_WATER', thresholds: { minFreeMB: 3072 } }, { ts: T0 + 3 * MIN }),
      // 不计入 #4：事件行 pressure='pressure'（非 normal）、check=0（查⓪）、check=2（预算）
      line('spawn_reject', { kind: 'headless', project: 'p', check: 1, reason: 'MEMGUARD_LOW_WATER', thresholds: { minFreeMB: 3072 } }, { ts: T0 + 4 * MIN, pressure: 'pressure' }),
      line('spawn_reject', { kind: 'headless', project: 'p', check: 0, reason: 'MEMGUARD_LOW_WATER', thresholds: { softMB: 3072 } }, { ts: T0 + 5 * MIN }),
      line('spawn_reject', { kind: 'headless', project: 'p', check: 2, reason: 'MEMGUARD_BUDGET', thresholds: { budgetPct: 67, usedMB: 1 } }, { ts: T0 + 6 * MIN }),
      reap('idle_reap', T0 + 7 * MIN, 1), reap('idle_reap', T0 + 8 * MIN, 2), reap('idle_reap', T0 + 9 * MIN, 3), reap('idle_reap', T0 + 10 * MIN, 4),
      reap('exit_reap', T0 + 11 * MIN, 5),
      line('lease_acquired', { kind: 'headless', project: 'p', leaseId: 'tail', declaredMB: 2048 }, { ts: T0 + 60 * MIN }),
    ];
    const r = run(lines);
    expect(r.window.days).toBe(1);
    expect(r.events.spawnReject.lowWaterNormalCheck1).toBe(3);
    expect(r.events.spawnReject.byCheck).toEqual({ 0: 1, 1: 4, 2: 1 });
    expect(r.events.spawnReject.byReason).toEqual({ MEMGUARD_LOW_WATER: 5, MEMGUARD_BUDGET: 1 });
    expect(j(r, '4').status).toBe('hit');
    expect(r.events.idleReap).toBe(4);
    expect(r.events.exitReap).toBe(1);
    expect(j(r, '7').status).toBe('hit');
  });
});

// ---------------------------------------------------------------------------
// 常量机械比对（防漂移）：读源码文本抽取，与 mjs 常量表三方相等。
// ---------------------------------------------------------------------------
const CORE = join(__dirname, '..', '..', 'src', 'core');

function extractObject(src: string, decl: string): Record<string, number> {
  const m = new RegExp(`const ${decl}[^=]*=\\s*\\{([\\s\\S]*?)\\}`).exec(src);
  if (!m) throw new Error(`源码未找到 ${decl}`);
  const out: Record<string, number> = {};
  for (const [, k, v] of m[1]!.matchAll(/(\w+)\s*:\s*(\d+(?:\.\d+)?)/g)) out[k!] = Number(v);
  return out;
}

/** 求值纯数字字面量表达式（支持数字分隔符与四则运算，如 `5 * 60_000`）；非白名单字符即拒。 */
function evalNumeric(expr: string): number {
  const e = expr.replace(/_/g, '').trim();
  if (!/^[\d\s()+*/.-]+$/.test(e)) throw new Error(`非常量表达式：${expr}`);
  return Function(`"use strict"; return (${e});`)() as number;
}

function extractConst(src: string, name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`源码未找到 ${name}`);
  return m[1]!;
}

describe('常量机械比对（mjs 常量表 ↔ 源码）', () => {
  const watchdog = readFileSync(join(CORE, 'mem-watchdog.ts'), 'utf8');
  const guard = readFileSync(join(CORE, 'memory-guard.ts'), 'utf8');

  it('KILL_FACTOR 三方相等：mjs ↔ mem-watchdog.ts ↔ memory-guard.ts SAMPLE_KILL_FACTOR', () => {
    const fromWatchdog = extractObject(watchdog, 'KILL_FACTOR');
    const fromGuard = extractObject(guard, 'SAMPLE_KILL_FACTOR');
    expect(fromWatchdog).toEqual(KILL_FACTOR);
    expect(fromGuard).toEqual(KILL_FACTOR);
    expect(Object.keys(fromWatchdog).sort()).toEqual([...KINDS].sort());
    expect(KILL_FACTOR).toEqual({ headless: 2, gut_shard: 2, game_window: 3, editor: 3 });
  });

  it('PRESSURE_RECOVER_MS：源码表达式 5 * 60_000 抽取 = 300000 = mjs', () => {
    const expr = extractConst(guard, 'PRESSURE_RECOVER_MS');
    expect(expr.trim()).toBe('5 * 60_000'); // 钉住写法：抽取必须处理表达式而非仅字面量
    expect(evalNumeric(expr)).toBe(300_000);
    expect(PRESSURE_RECOVER_MS).toBe(300_000);
  });

  it('HARD_MIN_RECLAIM_MB：源码 = 2048 = mjs', () => {
    expect(evalNumeric(extractConst(guard, 'HARD_MIN_RECLAIM_MB'))).toBe(2048);
    expect(HARD_MIN_RECLAIM_MB).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// 路径解析 + CLI 壳（退出码 0/1/2）
// ---------------------------------------------------------------------------
describe('CLI 与路径', () => {
  it('defaultSamplePath：env 优先，否则 ~/.godot-mcp/memory-guard-events.jsonl', () => {
    expect(defaultSamplePath({ GODOT_MCP_MEM_SAMPLE_FILE: 'X:/custom.jsonl' })).toBe('X:/custom.jsonl');
    expect(defaultSamplePath({})).toBe(join(homedir(), '.godot-mcp', 'memory-guard-events.jsonl'));
  });

  it('退出码：fixture A → 0；空文件 → 1；文件缺失 → 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memguard-review-cli-'));
    try {
      const script = join(__dirname, '..', '..', 'scripts', 'memguard-review.mjs');
      const fileA = join(dir, 'a.jsonl');
      const fileEmpty = join(dir, 'empty.jsonl');
      writeFileSync(fileA, fixtureA().join('\n') + '\n');
      writeFileSync(fileEmpty, '');
      const ok = spawnSync(process.execPath, [script, '--file', fileA], { encoding: 'utf8' });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('触发条件：满足');
      expect(ok.stdout).toContain('#8');
      const empty = spawnSync(process.execPath, [script, '--file', fileEmpty], { encoding: 'utf8' });
      expect(empty.status, empty.stderr).toBe(1);
      expect(empty.stdout).toContain('数据不足');
      const missing = spawnSync(process.execPath, [script, '--file', join(dir, 'missing.jsonl')], { encoding: 'utf8' });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('missing.jsonl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
