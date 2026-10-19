// src/tools/qa/runner.ts — QA 套件顺序执行器
//
// 编排既有原语，不复制逻辑：
// - 生命周期：game-bridge handleTool(install) + runtime handleTool(run_project/stop_project)
//   （进程槽守卫/输出缓冲等热路径逻辑不重写；qa.run 本身在 dispatcher 层经 confirm+audit 门）
// - 步骤层：直调已导出的 sendToBridge / pollWaitCondition / computePlaytestTimeoutMs
// - 断言：复用 runtime-assert 导出的 4 个 assert 函数（同源防 drift）
//
// 语义：FAILED = 断言未满足（测试失败）；ERROR = 基础设施失败（bridge 断连/超时/校验拒绝）。
// 两者默认都中止剩余步骤（continue_on_failure=true 继续）；中止的剩余步骤记 SKIPPED。

import { mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolContext, ToolResult } from '../../types.js';
import {
  sendToBridge, setBridgeProjectDir, pollWaitCondition, computePlaytestTimeoutMs,
  validateBridgePath, validateWaitPropertyParams,
} from '../game-bridge.js';
import * as gameBridge from '../game-bridge.js';
import * as runtime from '../runtime.js';
import { assertNodeState, assertSceneStructure, assertScreenText, assertPerf, assertScreenshotDiff } from '../runtime-assert.js';
import type { QaSuite, QaStep } from './spec.js';
import { makeRunId, qaReportsDir, type QaReport, type StepRecord } from './report.js';
import { resolveGameDataPath } from '../game-fs.js';
// re-export:保 test/qa-runner.test.ts 既有 import 路径兼容
export { resolveGameDataPath };

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
/** 取消原因常量:aborted 置值(:208)与 finalizeSummary 判定(:280)共用,字面量漂移会让 CANCELLED 静默降级 FAILED */
const CANCEL_REASON = 'cancelled by user';

/** 解析 ToolResult.content[0].text 为 JSON；失败返回 null（text 可能是纯文本错误） */
function parseToolJson(res: ToolResult): Record<string, unknown> | null {
  const text = res.content[0]?.type === 'text' ? res.content[0].text : undefined;
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function condense(v: unknown, max = 200): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, max);
}

export interface RunQaResult {
  report: QaReport;
  paths: { json_path: string; md_path: string };
}

/** 套件内跨步骤状态(watch/monitor 单订阅槽自管 + errors baseline;Task PR-1a) */
interface RunState {
  watchActive: boolean;
  monitorActive: boolean;
  watchEventsCache: WatchEvent[] | null;
  errorsBaselineSeq: number | null;
  /** freeze 步骤后为 true(unfreeze 复位):teardown 兜底解冻的依据(P2-14) */
  frozenActive: boolean;
}
type WatchEvent = { frame: number; time: number; args: unknown[] };

/** 外部控制钩子(PR-1b):cancelRequested 步骤间轮询;onProgress 与 ctx.progress 同点位 */
export interface QaRunControl {
  cancelRequested(): boolean;
  onProgress?(step: number, total: number, current: string): void;
}

function newRunState(): RunState {
  return { watchActive: false, monitorActive: false, watchEventsCache: null, errorsBaselineSeq: null, frozenActive: false };
}

/**
 * 执行 QA 套件并落盘报告。
 * @param suite 已校验的套件
 * @param projectPath 已通过白名单校验的绝对路径（index/CLI 层解析）
 * @param ctx 工具上下文（install 用 opsScript；run/stop 用进程槽；progress 可选）
 * @param ctl 外部控制钩子（PR-1b）：cancelRequested 步骤间轮询取消；onProgress 同步进度
 * @param runIdOverride 外部注入的 run_id（PR-1b 异步注册表 taskId 与报告保持一致）；缺省按套件名生成
 */
export async function runQaSuite(
  suite: QaSuite,
  projectPath: string,
  ctx: ToolContext,
  specSource: QaReport['suite']['spec_source'],
  ctl?: QaRunControl,
  runIdOverride?: string,
): Promise<QaReport> {
  const o = suite.options;
  const runId = runIdOverride ?? makeRunId(suite.name);
  const startedAt = new Date();
  const startedMs = Date.now();

  const steps: StepRecord[] = suite.steps.map((s, i) => ({
    index: i,
    label: s.label,
    type: s.type,
    status: 'SKIPPED' as const,
    elapsed_ms: 0,
  }));

  const report: QaReport = {
    version: 1,
    run_id: runId,
    suite: { name: suite.name, project_path: projectPath, started_at: startedAt.toISOString(), spec_source: specSource },
    options: o as unknown as Record<string, unknown>,
    summary: { total: suite.steps.length, passed: 0, failed: 0, errors: 0, skipped: suite.steps.length, status: 'FAILED', duration_ms: 0 },
    steps,
  };

  let gameStarted = false;
  // aborted 提升到外层(原内层 try 块级):外层 finally 需读它判定 CANCELLED(PR-1b)
  let aborted: string | undefined;
  // record_on_failure（QA 收尾批①）：setup 就绪后 start，teardown（stop_project 杀游戏
  // 断 bridge）前 stop；成功丢弃，失败落盘 qa-reports（与 screenshot 证据同目录）。
  let recordStarted = false;
  let pendingRecording: { version: 1; duration_ms: number; events: unknown[] } | null = null;
  const runState = newRunState();

  // finalize 放外层 finally：早退（setup error）/正常结束/异常路径都统一结算 summary
  /** setup 失败统一出口：记 setup_error + 全部步骤标 SKIPPED('setup failed') */
  const failSetup = (msg: string): QaReport => {
    report.setup_error = msg;
    for (const s of steps) s.skip_reason = 'setup failed';
    return report;
  };

  try {
    try {
      // ── setup：install → run → 确定性锚点 ──────────────────────────────────
      if (o.auto_install_bridge) {
        const r = await gameBridge.handleTool('game', { action: 'game_bridge_install', project_path: projectPath }, ctx);
        const text = r?.content[0]?.type === 'text' ? r.content[0].text : '';
        const json = parseToolJson(r ?? { content: [] });
        const ok = (json?.success === true) || text.includes('already registered');
        if (!ok) {
          return failSetup(`game_bridge_install 失败: ${condense(text)}`);
        }
      }

      setBridgeProjectDir(projectPath);

      if (o.auto_run) {
        const r = await runtime.handleTool('runtime', {
          action: 'run_project',
          project_path: projectPath,
          wait_for_bridge: true,
          bridge_timeout: o.bridge_timeout_s,
          timeout: o.run_timeout_s,
        }, ctx);
        const text = r?.content[0]?.type === 'text' ? r.content[0].text : '';
        if (!text.includes('Bridge ready')) {
          return failSetup(`run_project 失败: ${condense(text)}`);
        }
        gameStarted = true;
      } else {
        // 连接已运行的游戏：ping 探活，给出可行动的错误
        const resp = await sendToBridge('ping', {}, o.step_timeout_ms);
        if (resp.error) {
          return failSetup(`auto_run=false 但游戏 bridge 不可达 (ping: ${resp.error.message})。确认游戏已运行且已 game_bridge_install。`);
        }
      }

      if (o.seed !== undefined) {
        const resp = await sendToBridge('playtest.seed', { seed: o.seed }, o.step_timeout_ms);
        if (resp.error) return failSetup(`playtest.seed 失败: ${resp.error.message}`);
      }
      if (o.fixed_delta_hz !== undefined) {
        const resp = await sendToBridge('playtest.fixed_delta', { hz: o.fixed_delta_hz }, o.step_timeout_ms);
        if (resp.error) return failSetup(`playtest.fixed_delta 失败: ${resp.error.message}`);
      }

      // errors baseline(I-2:仅含 errors 断言的套件采集;失败降级不 failSetup)
      if (suite.steps.some(s => s.type === 'assert' && s.assert === 'errors')) {
        const resp = await sendToBridge('get_errors', { since_seq: 0 }, o.step_timeout_ms);
        if (resp.error) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `get_errors baseline 采集失败(errors 断言将判 ERROR,旧 bridge 可能无错误捕获): ${resp.error.message}`];
        } else {
          runState.errorsBaselineSeq = ((resp.result ?? {}) as { next_seq?: number }).next_seq ?? 0;
        }
      }

      if (o.record_on_failure) {
        // best-effort：旧 bridge 无此命令只记警告降级，不阻断套件（同 screenshot 降级哲学）
        const resp = await sendToBridge('recording.start', {}, o.step_timeout_ms);
        if (resp.error) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `recording.start 失败(录制证据不可用): ${resp.error.message}`];
        } else {
          recordStarted = true;
        }
      }

      // ── steps ──────────────────────────────────────────────────────────────
      for (let i = 0; i < suite.steps.length; i++) {
        const step = suite.steps[i]!;
        const rec = steps[i]!;

        if (aborted) {
          rec.skip_reason = aborted;
          continue;
        }
        const remaining = o.suite_budget_ms - (Date.now() - startedMs);
        if (remaining <= 0) {
          rec.skip_reason = 'suite budget exhausted';
          aborted = 'suite budget exhausted';
          continue;
        }
        // 取消检查(PR-1b):步骤间轮询,复用 aborted 的 SKIPPED 机制标记剩余步骤
        if (!aborted && ctl?.cancelRequested()) {
          aborted = CANCEL_REASON;
          rec.skip_reason = CANCEL_REASON;
          continue;
        }

        ctx.progress?.(i + 1, suite.steps.length, `qa step ${i + 1}/${suite.steps.length}: ${step.type}${step.label ? ` (${step.label})` : ''}`);
        ctl?.onProgress?.(i + 1, suite.steps.length, `${step.type}${step.label ? ` (${step.label})` : ''}`);
        const t0 = Date.now();
        const outcome = await execStep(step, o, runId, i, projectPath, runState);
        rec.elapsed_ms = Date.now() - t0;
        rec.status = outcome.status;
        rec.detail = outcome.detail;
        rec.mismatch = outcome.mismatch;
        rec.evidence = outcome.evidence;

        if (outcome.status !== 'PASSED' && !o.continue_on_failure) {
          aborted = `aborted after step ${i} (${step.type}${step.label ? ` "${step.label}"` : ''} ${outcome.status})`;
        }
      }
    } finally {
      // ── teardown：尽力收尾，失败只记警告不影响报告判定 ──────────────────────
      // watch/monitor 兜底收尾(防泄漏;失败只记警告)
      if (runState.watchActive) {
        try {
          const resp = await sendToBridge('watch.stop', {}, o.step_timeout_ms);
          if (resp.error) {
            report.teardown_warnings = [...(report.teardown_warnings ?? []), `watch.stop 兜底失败: ${resp.error.message}`];
          } else {
            runState.watchActive = false;
          }
        } catch (err) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `watch.stop 兜底异常: ${err instanceof Error ? err.message : String(err)}`];
        }
      }
      if (runState.monitorActive) {
        try {
          const resp = await sendToBridge('monitor.stop', {}, o.step_timeout_ms);
          if (resp.error) {
            report.teardown_warnings = [...(report.teardown_warnings ?? []), `monitor.stop 兜底失败: ${resp.error.message}`];
          } else {
            runState.monitorActive = false;
          }
        } catch (err) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `monitor.stop 兜底异常: ${err instanceof Error ? err.message : String(err)}`];
        }
      }
      // 录制 stop 必须在 stop_project 之前（杀游戏即断 bridge，之后取不到 events）。
      if (recordStarted) {
        try {
          const resp = await sendToBridge('recording.stop', {}, o.step_timeout_ms);
          if (resp.error) {
            report.teardown_warnings = [...(report.teardown_warnings ?? []), `recording.stop 失败(录制证据丢失): ${resp.error.message}`];
          } else {
            const r = resp.result as { version?: number; duration_ms?: number; events?: unknown[] };
            if (r && Array.isArray(r.events)) {
              pendingRecording = { version: 1, duration_ms: r.duration_ms ?? 0, events: r.events };
            }
          }
        } catch (err) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `recording.stop 异常(录制证据丢失): ${err instanceof Error ? err.message : String(err)}`];
        }
      }
      // P2-14(2026-08-21 七维度审核): freeze 是套件主动施加的破坏性状态(tree.paused),
      // abort(断言失败/预算耗尽/cancel)时必须兜底解冻——外部游戏(auto_run:false)不能
      // 残留永久暂停。须在 stop_project 之前(杀游戏即断 bridge,之后无法解冻)。
      if (runState.frozenActive) {
        try {
          const resp = await sendToBridge('playtest.unfreeze', {}, o.step_timeout_ms);
          if (resp.error) {
            report.teardown_warnings = [...(report.teardown_warnings ?? []), `playtest.unfreeze 兜底失败: ${resp.error.message}`];
          } else {
            runState.frozenActive = false;
          }
        } catch (err) {
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `playtest.unfreeze 兜底异常: ${err instanceof Error ? err.message : String(err)}`];
        }
      }
      if (o.stop_after && gameStarted) {
        try {
          await runtime.handleTool('runtime', { action: 'stop_project' }, ctx);
        } catch (err) {
          // Nit-1（审查）：append 模式（同函数其余 4 处一致）——recording.stop 已失败时不被覆盖
          report.teardown_warnings = [...(report.teardown_warnings ?? []), `stop_project 失败: ${err instanceof Error ? err.message : String(err)}`];
        }
      }
    }
  } finally {
    finalizeSummary(report, startedMs, aborted === CANCEL_REASON);
    // 失败落盘录制（成功丢弃）：格式与 recording_play 的 events_json 兼容，可离线回放复现。
    if (o.record_on_failure && pendingRecording && report.summary.status !== 'PASSED') {
      try {
        const dir = qaReportsDir();
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `${runId}-recording.json`);
        writeFileSync(p, JSON.stringify(pendingRecording), 'utf-8');
        report.recording_path = p;
      } catch (err) {
        report.teardown_warnings = [...(report.teardown_warnings ?? []), `录制落盘失败: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
  }

  return report;
}

/** 统计 steps 状态 → summary(cancelled 优先;否则任一非 PASSED 或 setup_error ? FAILED : PASSED)。
 * B2: UNMEASURED 单独计数且计入 anyNotPassed——Feel Gate 语义"无法测量的检查不是通过",
 * 整体仍 FAILED,但 unmeasured 计数可辨,排查方向指向前提(前置步骤没建出目标)。 */
function finalizeSummary(report: QaReport, startedMs: number, cancelled: boolean): void {
  let passed = 0, failed = 0, errors = 0, skipped = 0, unmeasured = 0;
  for (const s of report.steps) {
    if (s.status === 'PASSED') passed++;
    else if (s.status === 'FAILED') failed++;
    else if (s.status === 'ERROR') errors++;
    else if (s.status === 'UNMEASURED') unmeasured++;
    else skipped++;
  }
  const anyNotPassed = failed > 0 || errors > 0 || skipped > 0 || unmeasured > 0;
  report.summary = {
    total: report.steps.length,
    passed, failed, errors, skipped, unmeasured,
    status: cancelled ? 'CANCELLED' : (anyNotPassed || report.setup_error ? 'FAILED' : 'PASSED'),
    duration_ms: Date.now() - startedMs,
  };
}

// ─── 单步执行 ────────────────────────────────────────────────────────────────

interface StepOutcome {
  status: 'PASSED' | 'FAILED' | 'ERROR' | 'UNMEASURED';
  detail?: string;
  mismatch?: Record<string, { expected: unknown; actual: unknown }>;
  evidence?: { screenshot_path?: string };
}

type ResolvedOptions = QaSuite['options'];

// ─── watch/monitor 取数 helper(B-2 取数路径:poll 优先 → 非 active 补 stop 全量)───

type MonitorSample = { frame: number; time: number; values?: Record<string, unknown>; error?: string; stopped_reason?: string };

/** 取 watch 全量事件:缓存优先(空数组也是有效缓存,stop 后仍可用)→ poll →
 * 未开启则拒绝消费(watching:true 即套件外订阅,消费=假绿)→ watching 取数 → 非 active 补 stop 全量。
 * B-2:GD 侧 max_events 满后自动置 inactive,poll 返回空,必须补 stop 才能拿到事件。 */
async function collectWatchEvents(runState: RunState, timeoutMs: number): Promise<{ events: WatchEvent[] } | { error: string }> {
  // Important①:用 !== null 判缓存,不能用 truthy——0 事件的空缓存 [] 是 falsy,
  // 误走 poll 会在已 stop 时报 ERROR('无活跃 watch'),而语义应为 FAILED(计数 0 < min_count)
  if (runState.watchEventsCache !== null) return { events: runState.watchEventsCache };
  const poll = await sendToBridge('watch.poll', {}, timeoutMs);
  if (poll.error) return { error: `bridge: ${poll.error.message}` };
  const r = (poll.result ?? {}) as { watching?: boolean; events?: unknown[] };
  // Important②:铁律判定顺序——本套件未 watch_start 则拒绝取数(哪怕 bridge 侧
  // watching:true,那是套件外订阅,消费会把别人的事件泄入断言造成假绿)
  if (!runState.watchActive) {
    return { error: r.watching === true
      ? '本套件未 watch_start,拒绝消费套件外订阅(bridge 存在非本套件开启的活跃 watch)'
      : '无活跃 watch 且无缓存事件,先 watch_start' };
  }
  if (r.watching === true) return { events: (Array.isArray(r.events) ? r.events : []) as WatchEvent[] };
  const stop = await sendToBridge('watch.stop', {}, timeoutMs);
  if (stop.error) return { error: `bridge: ${stop.error.message}` };
  const sr = (stop.result ?? {}) as { events?: unknown[] };
  runState.watchActive = false;
  runState.watchEventsCache = (Array.isArray(sr.events) ? sr.events : []) as WatchEvent[];
  return { events: runState.watchEventsCache };
}

/** 取 monitor 全量样本:poll → 未开启则拒绝消费(monitoring:true 即套件外订阅,消费=假绿)
 * → monitoring 取数 → 非 active 补 stop 全量(B-2 同款)。 */
async function collectMonitorSamples(runState: RunState, timeoutMs: number): Promise<{ samples: MonitorSample[]; stoppedReason?: string } | { error: string }> {
  const poll = await sendToBridge('monitor.poll', {}, timeoutMs);
  if (poll.error) return { error: `bridge: ${poll.error.message}` };
  const r = (poll.result ?? {}) as { monitoring?: boolean; samples?: unknown[]; stopped_reason?: string };
  // Important②:铁律判定顺序——本套件未 monitor_start 则拒绝取数(哪怕 bridge 侧
  // monitoring:true,那是套件外订阅,消费会把别人的样本泄入断言造成假绿)
  if (!runState.monitorActive) {
    return { error: r.monitoring === true
      ? '本套件未 monitor_start,拒绝消费套件外订阅(bridge 存在非本套件开启的活跃 monitor)'
      : '无活跃 monitor,先 monitor_start' };
  }
  if (r.monitoring === true) return { samples: (Array.isArray(r.samples) ? r.samples : []) as MonitorSample[] };
  const stop = await sendToBridge('monitor.stop', {}, timeoutMs);
  if (stop.error) return { error: `bridge: ${stop.error.message}` };
  const sr = (stop.result ?? {}) as { samples?: unknown[]; stopped_reason?: string };
  runState.monitorActive = false;
  return {
    samples: (Array.isArray(sr.samples) ? sr.samples : []) as MonitorSample[],
    stoppedReason: sr.stopped_reason || undefined,
  };
}

/** JSON 深比较(键序不敏感不保证;与既有 node_state 的 JSON.stringify 比较同风格) */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function execStep(step: QaStep, o: ResolvedOptions, runId: string, index: number, projectPath: string, runState: RunState): Promise<StepOutcome> {
  switch (step.type) {
    case 'input': {
      const pathErr = validateBridgePath(step.params, step.method);
      if (pathErr) return err(pathErr);
      // H1 审查 N-4 收敛:send_input_sequence 超时经 computePlaytestTimeoutMs 统一放宽
      // (wall+10s;与 game-bridge 同一纯函数,不再内联公式)
      const inputTimeout = computePlaytestTimeoutMs(step.method, step.params.wall_budget_ms, o.step_timeout_ms);
      const resp = await sendToBridge(step.method, step.params, inputTimeout);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      // H1 审查 I-1 修复:延迟通道 wall_timeout 截断时 GD 返回 result 层 success=false
      // 但顶层无 JSON-RPC error(_process 直推响应不走 error promote)——只查顶层
      // error 会把截断报 PASSED。qa 是自动判定引擎,须显式判软失败。
      const seqResult = resp.result as Record<string, unknown> | undefined;
      if (step.method === 'send_input_sequence' && seqResult && seqResult.success === false) {
        return err(`send_input_sequence 截断: ${JSON.stringify({
          wall_timeout: seqResult.wall_timeout,
          applied_count: seqResult.applied_count,
          all_applied: seqResult.all_applied,
          total_events: seqResult.total_events,
          frames_elapsed: seqResult.frames_elapsed,
        })}`);
      }
      return { status: 'PASSED', detail: `${step.method} ok (${condense(resp.result)})` };
    }
    case 'wait': {
      const pathErr = validateBridgePath(step.params, step.method) ?? validateWaitPropertyParams(step.method, step.params);
      if (pathErr) return err(pathErr);
      const totalMs = step.timeout_ms ?? o.wait_timeout_ms;
      const r = await pollWaitCondition(
        step.method,
        () => sendToBridge(step.method, step.params, Math.min(o.step_timeout_ms, totalMs)),
        totalMs,
        step.interval_ms ?? 500,
      );
      // B2: 节点不存在也是"前提不成立"而非基础设施错——wait_for_property 对缺失节点
      // 报 JSON-RPC error "Node not found"(pollWaitCondition 立即中止),归 UNMEASURED。
      const respError = r.error as { message?: string } | undefined;
      if (respError) {
        if (typeof respError.message === 'string' && respError.message.includes('Node not found')) {
          return { status: 'UNMEASURED', detail: `前提不成立: ${respError.message} (waited ${r.elapsed_ms ?? '?'}ms of ${totalMs}ms)` };
        }
        return err(`bridge: ${condense(r.error)}`);
      }
      if (r.wait_completed === true) {
        return { status: 'PASSED', detail: `${step.method} satisfied in ${r.elapsed_ms}ms` };
      }
      // B2 超时三分支:前提不成立(节点不存在/属性缺失)→ UNMEASURED,排查方向指向
      // 前置步骤;目标存在但值不满足 → FAILED(现状)。detail 带实测数字(expected/last/at)。
      const waited = `waited ${r.elapsed_ms ?? '?'}ms of ${totalMs}ms`;
      const wparams = (step.params ?? {}) as { path?: string; property?: string; value?: unknown };
      if (step.method === 'wait_for_node' && r.exists === false) {
        return { status: 'UNMEASURED', detail: `前提不成立: node ${wparams.path ?? '?'} 不存在 (expected exists=true, last exists=false, ${waited})` };
      }
      if (step.method === 'wait_for_property' && r.match === false && r.current === null) {
        return { status: 'UNMEASURED', detail: `前提不成立: ${wparams.path ?? '?'}.${wparams.property ?? '?'} 缺失或值为 null (expected ${condense(wparams.value, 60)}, last current=null, ${waited})` };
      }
      const lastBits = step.method === 'wait_for_property'
        ? `expected ${condense(r.expected ?? wparams.value, 60)}, last current=${condense(r.current, 60)}`
        : condense(r);
      return { status: 'FAILED', detail: `${step.method} 未在 ${totalMs}ms 内满足 (${lastBits}, ${waited})` };
    }
    case 'wait_frames': {
      const resp = await sendToBridge('playtest.step', { frames: step.frames }, computePlaytestTimeoutMs('playtest.step', undefined, o.step_timeout_ms));
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      return { status: 'PASSED', detail: `stepped ${step.frames} frame(s)` };
    }
    case 'freeze':
    case 'unfreeze': {
      const resp = await sendToBridge(`playtest.${step.type}`, {}, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      runState.frozenActive = step.type === 'freeze';
      return { status: 'PASSED', detail: step.type };
    }
    case 'step_until': {
      const params: Record<string, unknown> = { conditions: step.conditions };
      if (step.max_frames !== undefined) params.max_frames = step.max_frames;
      if (step.wall_budget_ms !== undefined) params.wall_budget_ms = step.wall_budget_ms;
      const resp = await sendToBridge('playtest.step_until', params, computePlaytestTimeoutMs('playtest.step_until', step.wall_budget_ms, o.step_timeout_ms));
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      // B2: 响应契约(GD 帧循环完成时){success, predicate_met, frames_elapsed, wall_exceeded, error}。
      // 原实现无条件 PASSED,把 predicate_met=false(帧耗尽/wall 超预算,条件未满足)也判过——
      // 与 spec "推进至条件满足"语义相悖,假绿。现按三态:前提不成立(node/property not found,
      // GD 侧 error 字段)→ UNMEASURED;条件在而未满足 → FAILED;满足 → PASSED。
      const r = (resp.result ?? {}) as { predicate_met?: boolean; error?: string; frames_elapsed?: number; wall_exceeded?: boolean };
      if (typeof r.error === 'string' && r.error !== '') {
        return { status: 'UNMEASURED', detail: `前提不成立: ${r.error} (stepped ${r.frames_elapsed ?? '?'} frame(s))` };
      }
      if (r.predicate_met !== true) {
        return {
          status: 'FAILED',
          detail: `step_until 条件未满足 (stepped ${r.frames_elapsed ?? '?'} frame(s)${r.wall_exceeded === true ? ', wall budget exceeded' : ''}, conditions: ${condense(step.conditions, 120)})`,
          mismatch: { predicate: { expected: condense(step.conditions, 120), actual: `not met after ${r.frames_elapsed ?? '?'} frame(s)` } },
        };
      }
      return { status: 'PASSED', detail: `predicate met after ${r.frames_elapsed ?? '?'} frame(s)` };
    }
    case 'snapshot':
    case 'restore': {
      const resp = await sendToBridge(`playtest.${step.type}`, {}, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      return { status: 'PASSED', detail: condense(resp.result, 120) || step.type };
    }
    case 'set': {
      const pathErr = validateBridgePath({ path: step.path });
      if (pathErr) return err(pathErr);
      const resp = await sendToBridge('set_node_property', { path: step.path, property: step.property, value: step.value }, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      return { status: 'PASSED', detail: `${step.path}.${step.property} set` };
    }
    case 'call': {
      const pathErr = validateBridgePath({ path: step.path });
      if (pathErr) return err(pathErr);
      const resp = await sendToBridge('call_method', { path: step.path, method: step.method, args: step.args ?? [] }, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}（写方法需 GODOT_MCP_BRIDGE_EXTRA_METHODS 放行）`);
      return { status: 'PASSED', detail: condense(resp.result, 120) || `${step.method} ok` };
    }
    case 'assert': {
      // fn 选择表:可复用 runtime-assert 的 5 种(不依赖 RunState;含 Task 7 接线的 screenshot_diff);
      // signal/errors/monitor 依赖 RunState 跨步骤状态,走套件内本地断言。
      const fn = step.assert === 'node_state' ? assertNodeState
        : step.assert === 'scene_structure' ? assertSceneStructure
        : step.assert === 'screen_text' ? assertScreenText
        : step.assert === 'perf' ? assertPerf
        : step.assert === 'screenshot_diff' ? assertScreenshotDiff
        : null;
      if (fn) {
        // 原有 runtime-assert 复用流程(args 组装 → fn → parseToolJson 判定),原样保留
        const args: Record<string, unknown> = { action: step.assert };
        for (const k of ['path', 'expect', 'tolerance', 'nodes', 'text', 'present', 'baseline', 'reference', 'threshold', 'max_diff_ratio'] as const) {
          const v = step[k];
          if (v !== undefined) args[k] = v;
        }
        // screenshot_diff 专属注入:project_path(解析 user:// 截图)+ evidence_path(diff 染红图落 qa-reports)
        if (step.assert === 'screenshot_diff') {
          args.project_path = projectPath;
          const dir = qaReportsDir();
          mkdirSync(dir, { recursive: true });
          args.evidence_path = join(dir, `${runId}-step${index}-diff.png`);
        }
        const res = await fn(args);
        const json = parseToolJson(res);
        if (!json) return err(`assert ${step.assert} 返回非 JSON: ${condense(res.content[0]?.type === 'text' ? res.content[0].text : '')}`);
        if (json.success === false) {
          return err(`assert ${step.assert}: ${condense(json.error)}`);
        }
        if (json.passed === true) {
          // screenshot_diff PASSED 时回填染红图路径(details.evidence_path 由 Task 6 真实现
          // 回显注入的报告路径;evidence 落盘是 best-effort,回填失败仅缺证据不影响判定)
          const evidence = step.assert === 'screenshot_diff'
            ? { screenshot_path: (json.details as Record<string, unknown> | undefined)?.evidence_path as string | undefined }
            : undefined;
          return { status: 'PASSED', detail: `assert ${step.assert} ok`, evidence };
        }
        return {
          status: 'FAILED',
          detail: `assert ${step.assert} mismatch`,
          mismatch: json.mismatch as Record<string, { expected: unknown; actual: unknown }> | undefined,
          // Task 7 审查 Minor①:FAILED 时也回填染红图(失败排错关键证据)——
          // runtime-assert FAILED 分支同样在 details.evidence_path 回显注入路径,与 PASSED 同款取值
          evidence: step.assert === 'screenshot_diff'
            ? { screenshot_path: (json.details as Record<string, unknown> | undefined)?.evidence_path as string | undefined }
            : undefined,
        };
      }
      // ── 套件内本地断言(signal/errors/monitor:依赖 RunState 跨步骤状态)──
      if (step.assert === 'signal') return await execSignalAssert(step, runState, o);
      if (step.assert === 'errors') return await execErrorsAssert(step, runState, o);
      if (step.assert === 'monitor') return await execMonitorAssert(step, runState, o);
      return err(`assert ${step.assert}: 未实现`);
    }
    case 'screenshot': {
      // 真 bridge 契约（v0.30 e2e 实测纠正）：take_screenshot 把 PNG 存游戏侧
      // user:// 并返回 {success, path, size}——无 base64 字段（runtime-assert 占位
      // 代码里的 image 字段是臆测）。这里尽力把文件拷进报告目录，解析不到则
      // 诚实降级记录游戏侧路径（不伪造证据）。
      const shotUri = `user://mcp_qa_${runId}_step${index}.png`;
      const resp = await sendToBridge('take_screenshot', { path: shotUri }, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      const r = (resp.result ?? {}) as { success?: boolean; path?: string; size?: { x: number; y: number } };
      if (r.success !== true || typeof r.path !== 'string') {
        return { status: 'FAILED', detail: `take_screenshot 未成功: ${condense(resp.result)}` };
      }
      const gameSide = r.path;
      const local = resolveGameDataPath(projectPath, gameSide);
      if (local) {
        const dir = qaReportsDir();
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `${runId}-step${index}.png`);
        copyFileSync(local, p);
        return { status: 'PASSED', detail: `screenshot ${r.size?.x ?? '?'}x${r.size?.y ?? '?'}`, evidence: { screenshot_path: p } };
      }
      return {
        status: 'PASSED',
        detail: `screenshot 留在游戏侧 ${gameSide}（user:// 无法解析到本机路径，报告目录无副本）`,
      };
    }
    case 'watch_start': {
      if (runState.watchActive) return err('本套件已有活跃 watch,先 watch_stop');
      // 探测是否替换套件外开启的既有 watch(GD 侧静默替换,qa 需在 detail 注明)
      let replacedNote = '';
      const probe = await sendToBridge('watch.poll', {}, o.step_timeout_ms);
      const pr = (probe.result ?? {}) as { watching?: boolean };
      if (!probe.error && pr.watching === true) replacedNote = ' (已替换套件外开启的既有 watch)';
      const params: Record<string, unknown> = { node_path: step.node_path, signal_name: step.signal_name, push: false };
      if (step.max_events !== undefined) params.max_events = step.max_events;
      const resp = await sendToBridge('watch.start', params, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      runState.watchActive = true;
      runState.watchEventsCache = null;
      return { status: 'PASSED', detail: `watch.start ${step.node_path}:${step.signal_name}${replacedNote}` };
    }
    case 'watch_stop': {
      // Important① 姊妹:判据用 === null 而非 truthy——0 事件的空缓存 [] 是 falsy,
      // 会让第二次 watch_stop 误报 ERROR 而到不了下方幂等 cached 分支
      if (!runState.watchActive && runState.watchEventsCache === null) return err('无活跃 watch(未 watch_start 或已 stop)');
      // Task 3 审查 Minor③:已 stop 且缓存就绪 → 直接复用缓存,不重发 bridge stop
      // (GD 侧无活跃 watch 时 stop 仍返成功 result + 空 events,重发会把缓存覆盖为 [])
      if (!runState.watchActive && runState.watchEventsCache !== null) {
        return { status: 'PASSED', detail: `watch.stop ${runState.watchEventsCache.length} event(s) (cached)` };
      }
      const resp = await sendToBridge('watch.stop', {}, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      const r = (resp.result ?? {}) as { events?: unknown[] };
      runState.watchActive = false;
      runState.watchEventsCache = Array.isArray(r.events) ? (r.events as WatchEvent[]) : [];
      return { status: 'PASSED', detail: `watch.stop ${runState.watchEventsCache.length} event(s)` };
    }
    case 'monitor_start': {
      if (runState.monitorActive) return err('本套件已有活跃 monitor,先 monitor_stop');
      const params: Record<string, unknown> = { node_path: step.node_path, properties: step.properties };
      if (step.interval_frames !== undefined) params.interval_frames = step.interval_frames;
      const resp = await sendToBridge('monitor.start', params, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      runState.monitorActive = true;
      return { status: 'PASSED', detail: `monitor.start ${step.node_path} [${step.properties.join(', ')}]` };
    }
    case 'monitor_stop': {
      if (!runState.monitorActive) return err('无活跃 monitor(未 monitor_start 或已 stop)');
      const resp = await sendToBridge('monitor.stop', {}, o.step_timeout_ms);
      if (resp.error) return err(`bridge: ${resp.error.message}`);
      runState.monitorActive = false;
      const r = (resp.result ?? {}) as { sample_count?: number };
      return { status: 'PASSED', detail: `monitor.stop ${r.sample_count ?? 0} sample(s)` };
    }
    case 'sleep': {
      await sleep(step.ms);
      return { status: 'PASSED', detail: `slept ${step.ms}ms` };
    }
  }
}

// ─── 套件内本地断言(依赖 RunState 跨步骤状态)───────────────────────────────

async function execSignalAssert(step: { min_count?: number; max_count?: number; args_match?: unknown }, runState: RunState, o: ResolvedOptions): Promise<StepOutcome> {
  const collected = await collectWatchEvents(runState, o.step_timeout_ms);
  if ('error' in collected) return err(collected.error);
  const minCount = step.min_count ?? 1;
  const maxCount = step.max_count ?? Number.POSITIVE_INFINITY;
  const hasArgsMatch = step.args_match !== undefined;
  const matched = collected.events.filter(e => !hasArgsMatch || jsonEqual(e.args, step.args_match));
  if (matched.length >= minCount && matched.length <= maxCount) {
    return { status: 'PASSED', detail: `signal ${matched.length}/${collected.events.length} event(s) matched${hasArgsMatch ? ' args_match' : ''}` };
  }
  const last = matched.at(-1) ?? collected.events.at(-1);
  return {
    status: 'FAILED',
    detail: `signal count mismatch${last ? `(last event: ${condense(last)})` : ''}`,
    mismatch: { count: { expected: `[${minCount}, ${maxCount === Number.POSITIVE_INFINITY ? '∞' : maxCount}]`, actual: matched.length } },
  };
}

async function execErrorsAssert(step: { kinds?: string[]; max_count?: number }, runState: RunState, o: ResolvedOptions): Promise<StepOutcome> {
  if (runState.errorsBaselineSeq === null) {
    return err('errors 断言不可用:baseline 采集失败(见 teardown_warnings,旧 bridge 无 get_errors)');
  }
  const resp = await sendToBridge('get_errors', { since_seq: runState.errorsBaselineSeq }, o.step_timeout_ms);
  if (resp.error) return err(`bridge: ${resp.error.message}`);
  const r = (resp.result ?? {}) as { errors?: Array<{ seq: number; kind: string; message: string }> };
  const kinds = step.kinds ?? ['error', 'script', 'shader'];   // 默认排除 warning(太吵)
  const maxCount = step.max_count ?? 0;
  const hits = (r.errors ?? []).filter(e => kinds.includes(e.kind));
  if (hits.length <= maxCount) {
    return { status: 'PASSED', detail: `errors ${hits.length} ≤ ${maxCount} [${kinds.join(',')}]` };
  }
  const entries = hits.slice(0, 5).map(e => `${e.kind}: ${e.message.slice(0, 80)}`).join(' | ');
  return {
    status: 'FAILED',
    detail: `新增 ${hits.length} 条(前 5: ${entries.slice(0, 160)})`,
    mismatch: { new_errors: { expected: `≤ ${maxCount}`, actual: hits.length } },
  };
}

async function execMonitorAssert(step: { property?: string; min?: number; max?: number; monotonic?: 'increasing' | 'non_decreasing' | 'decreasing' | 'non_increasing' }, runState: RunState, o: ResolvedOptions): Promise<StepOutcome> {
  // brief 签名为 property: string,但 QaStep 里 property 是 optional(zod 未按 assert 值差异化必填),
  // TS strict 下不可赋值——改为 optional + 运行时守卫(spec 层漏配时给出可行动 ERROR)
  const property = step.property;
  if (!property) return err('monitor 断言需要 property');
  const collected = await collectMonitorSamples(runState, o.step_timeout_ms);
  if ('error' in collected) return err(collected.error);
  const { samples, stoppedReason } = collected;
  // 数据完整性(不假绿):非空 stopped_reason 或任一样本带 error 键(node_lost 等)
  const badSample = samples.find(s => s.error !== undefined);
  if (stoppedReason || badSample) {
    return err(`monitor 数据不完整: stopped_reason=${stoppedReason || badSample?.stopped_reason || badSample?.error}`);
  }
  // 提取数值序列(样本缺属性=数据不完整,ERROR)
  const series: Array<{ frame: number; value: number }> = [];
  for (const s of samples) {
    const v = s.values?.[property];
    if (typeof v !== 'number') {
      return err(`样本缺属性 ${property} 或非数值(frame ${s.frame}: ${condense(v)})`);
    }
    series.push({ frame: s.frame, value: v });
  }
  // 区间断言
  if (step.min !== undefined || step.max !== undefined) {
    const viol = series.find(p =>
      (step.min !== undefined && p.value < step.min) || (step.max !== undefined && p.value > step.max));
    if (viol) {
      const range = `${step.min !== undefined ? `≥ ${step.min}` : ''}${step.min !== undefined && step.max !== undefined ? ' 且 ' : ''}${step.max !== undefined ? `≤ ${step.max}` : ''}`;
      return {
        status: 'FAILED',
        detail: `monitor ${property} 越界(首个违规 frame ${viol.frame})`,
        mismatch: { [property]: { expected: range, actual: viol.value } },
      };
    }
  }
  // 单调性断言
  if (step.monotonic !== undefined && series.length >= 2) {
    const ok = series.every((p, i) => {
      if (i === 0) return true;
      const prev = series[i - 1]!.value;
      switch (step.monotonic) {
        case 'increasing': return p.value > prev;
        case 'non_decreasing': return p.value >= prev;
        case 'decreasing': return p.value < prev;
        case 'non_increasing': return p.value <= prev;
      }
    });
    if (!ok) {
      const violIdx = series.findIndex((p, i) => {
        if (i === 0) return false;
        const prev = series[i - 1]!.value;
        return step.monotonic === 'increasing' ? p.value <= prev
          : step.monotonic === 'non_decreasing' ? p.value < prev
          : step.monotonic === 'decreasing' ? p.value >= prev
          : p.value > prev;
      });
      return {
        status: 'FAILED',
        detail: `monitor ${property} 违反 ${step.monotonic}(首个违规 frame ${series[violIdx]?.frame})`,
        mismatch: { [`${property}_monotonic`]: { expected: step.monotonic, actual: `frame ${series[violIdx! - 1]?.frame}=${series[violIdx! - 1]?.value} → frame ${series[violIdx]?.frame}=${series[violIdx]?.value}` } },
      };
    }
  }
  return { status: 'PASSED', detail: `monitor ${property} ${series.length} sample(s) ok` };
}

function err(message: string): StepOutcome {
  return { status: 'ERROR', detail: message };
}
