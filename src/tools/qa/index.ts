// src/tools/qa/index.ts — QA 测试套件编排工具（v0.30 B 批；PR-1b 增 async/status/cancel）
//
// 定位：把既有原语（bridge 输入/等待/断言、确定性 playtest、截图证据）编排成
// "规范 → 执行 → 报告 → 回归 diff" 的闭环，对标商业 AI QA 工具（StraySpark 模式）
// 的免费开源实现。五个 action：
//   run    — 执行套件（inline spec / spec 文件），落盘 ~/.godot-mcp/qa-reports。
//            mode:sync（同步等完整结果）| async（注册 → 后台执行 → 立即返回
//            run_id，长套件防客户端超时）。显式 mode 优先；未显式指定时，客户端
//            声明 tasks 能力则自动 async，否则 sync。全局单 working 互斥（bridge
//            单连接），冲突返回 BUSY。
//   report — 读报告（'latest'/'prev'/路径/文件名）
//   diff   — 两份报告按用例对比（回归/修复/新增/移除）
//   status — 查运行注册表（run_id 省略=列全部；内存态，server 重启即丢，
//            查不到时引导 qa report 读落盘报告）
//   cancel — 对 working run 置取消标志（当前步骤结束后生效，teardown 照常收尾）
//
// 安全：run/cancel 声明 'process' 风险（run 装 bridge + 起游戏 + 输入/写状态，
// cancel 干预运行中进程），经 ToolDispatcher 的 confirm+audit 门一次性覆盖整个
// 套件（与 confirm_and_execute 对已确认操作直调模块的语义一致）；report/diff/status 只读。
// call 步骤受 bridge 只读白名单 + GODOT_MCP_BRIDGE_EXTRA_METHODS 约束，不绕过。

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool } from '@modelcontextprotocol/server';
import type { ToolResult, ToolContext } from '../../types.js';
import { textResult } from '../../types.js';
import { opsErrorResult } from '../shared.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { isPathInAllowedRoots } from '../../core/path-utils.js';
import { classifyError } from '../../core/tool-errors.js';
import { getLogger } from '../../core/logger.js';
import { parseQaSuite } from './spec.js';
import { runQaSuite, type QaRunControl } from './runner.js';
import { writeReport, readReport, listReports, diffReports, makeRunId, type QaReport } from './report.js';
import {
  registerRun, getRun, listRuns, activeWorkingRun, requestCancel, finishRun, updateProgress,
  QaBusyError, type RunRecord,
} from './registry.js';

// C-1 惯例：导出 TOOL_NAMES 供 scripts/check-tool-groups.mjs 归组对账（audit 第 4 次游离教训）
const TOOL_NAMES = ['qa'] as const;
export { TOOL_NAMES };

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'qa',
    description: 'QA 测试套件编排：结构化测试规范 → 自动安装 bridge → 运行游戏 → 逐步执行 → 聚合报告 + 回归 diff。'
      + '步骤类型：input/wait/wait_frames/freeze/unfreeze/step_until/snapshot/restore/set/call/'
      + 'watch_start|stop/monitor_start|stop/assert/screenshot/sleep；断言 8 种与各字段语义见 schema 字段 description。'
      + 'run 支持 mode:async 后台执行(qa status/cancel 管理)。'
      + '报告落 ~/.godot-mcp/qa-reports/<run_id>.{json,md}。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'report', 'diff', 'status', 'cancel'],
          description: 'run=执行套件；report=读报告；diff=对比两份报告找回归；status=查运行注册表(进度/终态)；cancel=取消进行中的 run',
        },
        // run
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'run: sync=同步等完整结果;async=立即返回 run_id 后台执行(用 qa status 轮询/qa cancel 取消)。默认:未显式指定时,客户端声明 MCP tasks 能力则自动 async,否则 sync',
        },
        run_id: { type: 'string', description: 'status/cancel: 目标 run_id(status 省略=列出全部注册 run)' },
        // assert 8 种(node_state/scene_structure/screen_text/perf/screenshot_diff/signal/errors/monitor)
        // 的字段级语义在 spec.ts zod 注释与 runtime-assert schema description(Task 6),此处只做索引级概述,避免双份维护
        spec: { type: 'object', description: 'run: inline 套件 spec 对象。步骤为 discriminated union(type 字段决定形态)：input(method+params,bridge 原生参数)、wait(wait_for_node/wait_for_property 轮询)、wait_frames(1-60 帧确定性推进)、freeze/unfreeze、step_until(结构化条件{path,property,op,value}[]，规避 RCE)、snapshot/restore、set(写节点属性)、call(bridge 只读白名单方法，写方法需 GODOT_MCP_BRIDGE_EXTRA_METHODS)、watch_start(node_path+signal_name，单套件单 watch)、watch_stop、monitor_start(node_path+properties[]，单套件单 monitor)、monitor_stop、screenshot(证据落报告目录)、sleep。步骤带 label 便于 diff 对齐' },
        spec_path: { type: 'string', description: 'run: spec 文件路径(.json 或含 ```qa-spec 围栏的 .md)，大套件建议用文件避免 token 截断；须在 ALLOWED_PROJECT_PATHS 白名单内' },
        project_path: { type: 'string', description: 'run: 项目路径(覆盖 spec 内的 project_path；spec 未写时必填)' },
        // report / diff
        report_path: { type: 'string', description: 'report: 报告路径或 run_id；latest=最新，prev=次新' },
        base_path: { type: 'string', description: 'diff: 基线报告(默认 prev)' },
        head_path: { type: 'string', description: 'diff: 对比报告(默认 latest)' },
      },
      required: ['action'],
    },
  }];
}

export const TOOL_META = {
  'qa': {
    readonly: false,
    long_running: true,
    actionRisks: {
      run: 'process' as const,  // 装 bridge + 起游戏 + 输入/写游戏状态：dispatcher 层 confirm+audit 一次覆盖
      report: 'read' as const,
      diff: 'read' as const,
      status: 'read' as const,
      cancel: 'process' as const,   // 干预运行中进程（置取消标志，teardown 收尾）
    },
  },
};

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'qa') return null;
  const action = args.action as string;

  try {
    switch (action) {
      case 'run':
        return await handleRun(args, ctx);
      case 'report':
        return handleReport(args);
      case 'diff':
        return handleDiff(args);
      case 'status':
        return handleStatus(args);
      case 'cancel':
        return handleCancel(args);
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}（可用：run/report/diff/status/cancel）`);
    }
  } catch (err) {
    // P2-17 残留点补修(2026-08-21 问题对账): 工具层 catch 直拼 err.message(常含
    // 绝对路径)绕过主 catch 的 G2 PII 护栏——改走 classifyError.safeMessage
    // (runtime-assert 顶层同款),完整错误只进 server 日志。
    getLogger().error('qa', `action=${action} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const { safeMessage } = classifyError(err);
    return opsErrorResult('QA_ERROR', `qa.${action} 失败: ${safeMessage}`);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function handleRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let specInput: unknown;
  let specSource: QaReport['suite']['spec_source'] = 'inline';
  if (args.spec !== undefined && args.spec !== null) {
    specInput = args.spec;
  } else if (typeof args.spec_path === 'string' && args.spec_path) {
    // 审查 Important-1 修复：spec_path 是文件读取入口，必须与 project_path 同标准过
    // ALLOWED_PROJECT_PATHS 白名单（此前是全 src/tools 唯一 readFileSync(args.*) 直读口子）
    const specAbs = resolve(args.spec_path);
    if (!isPathInAllowedRoots(specAbs)) {
      return opsErrorResult('INVALID_PATH',
        `spec_path 不在 ALLOWED_PROJECT_PATHS 白名单内: ${specAbs}。把 spec 文件放进白名单根内，或改用 inline spec 参数。`);
    }
    try {
      specInput = readFileSync(specAbs, 'utf-8');
      specSource = 'file';
    } catch (err) {
      return opsErrorResult('INVALID_PARAMS', `spec_path 不可读: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    return opsErrorResult('INVALID_PARAMS', 'run 需要 spec（inline 对象）或 spec_path（文件路径）');
  }

  const parsed = parseQaSuite(specInput);
  if (!parsed.ok || !parsed.suite) {
    return opsErrorResult('INVALID_SPEC', parsed.error ?? 'spec 解析失败');
  }
  const suite = parsed.suite;

  const rawProject = (typeof args.project_path === 'string' && args.project_path) || suite.project_path;
  if (!rawProject) {
    return opsErrorResult('INVALID_PARAMS', '缺少 project_path（工具参数或 spec 内至少提供一处）');
  }
  let projectPath: string;
  try {
    projectPath = requireProjectPath({ project_path: rawProject });
  } catch (err) {
    return opsErrorResult('INVALID_PATH', err instanceof Error ? err.message : String(err));
  }

  // PR-2 Task 4: 客户端声明 tasks 能力(ctx.taskAugmented,由 GodotServer tools/call handler
  // 从 getClientCapabilities() 读出注入)且未显式指定 mode 时自动转 async——客户端经
  // _meta.relatedTask 回指 + tasks/get 轮询,防长套件阻塞 tools/call。显式 mode 优先
  // (审查 Important-1 修复:能力协商只提供默认值,显式参数覆盖默认值——声明 tasks 能力
  // 的客户端显式传 mode:'sync' 仍走同步路径)。
  const mode = args.mode === 'sync' ? 'sync' : (args.mode === 'async' || ctx.taskAugmented === true ? 'async' : 'sync');
  const runId = makeRunId(suite.name);   // index 层生成，注册表 taskId 与报告 run_id 同一标识
  // BUSY 门：sync/async 一视同仁（bridge 单连接，全局同时仅 1 个 run）
  let record: RunRecord;
  try {
    record = registerRun(runId, suite.name, projectPath, suite.steps.length);
  } catch (busy) {
    if (busy instanceof QaBusyError) {
      // opsErrorResult opts 不支持任意结构化字段，current_run_id 已内嵌于 QaBusyError.message
      const cur = activeWorkingRun();
      const progress = cur ? `（进度 step ${cur.progress.step}/${cur.progress.total}）` : '';
      return opsErrorResult('BUSY', `${busy.message}${progress}`, {
        suggestion: `qa status(run_id:"${busy.currentRunId}") 轮询其完成后重试，或 qa cancel(run_id:"${busy.currentRunId}") 取消`,
        retryable: true,
      });
    }
    throw busy;
  }
  const ctl: QaRunControl = {
    cancelRequested: () => record.cancelRequested,
    onProgress: (step, total, current) => updateProgress(runId, step, total, current),
  };
  const exec = runQaSuite(suite, projectPath, ctx, specSource, ctl, runId)
    .then((report) => {
      const paths = writeReport(report);
      finishRun(runId,
        report.summary.status === 'PASSED' ? 'completed' : report.summary.status === 'CANCELLED' ? 'cancelled' : 'failed',
        report, paths);
      return { report, paths };
    })
    .catch((err: unknown) => {
      // 异常安全（brief Step 3 注记修正，必须落实）：writeReport/runQaSuite 抛错时兜底置
      // failed，防 record 永远 working 死锁 BUSY。rethrow 由两条路径消化——sync 的 await
      // （→ 外层 catch → QA_ERROR，行为与 PR-1a 前一致）；async 调用方已离开，由下方
      // record.done 的吞错 handler 接住（同时防 unhandled rejection）。
      // T2 审查 Minor-2：兜底也带 error（否则 tasks/result payload 只剩 run_id，不可诊断）。
      finishRun(runId, 'failed', undefined, undefined, `suite 执行异常: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
  record.done = exec.then(() => undefined, () => undefined);

  if (mode === 'async') {
    const res = textResult(JSON.stringify({
      success: true,
      data: {
        run_id: runId, status: 'working',
        suite_name: suite.name, steps_total: suite.steps.length,
        hint: `qa status(run_id:"${runId}") 轮询进度；qa report(report_path:"${runId}") 读结果；qa cancel(run_id:"${runId}") 取消`,
      },
    }));
    // PR-2 Task 4: _meta.relatedTask 回指(taskAugmented 客户端的协议入口,spec §3.2 组件 3)。
    // 类型断言放宽同 G2 先例(ToolDispatcher.ts healthSample):CallToolResult._meta 推断类型
    // 只声明 serverInfo key;G2 注入用 {...result._meta, trace_id, duration_ms} 展开,未知键
    // (relatedTask)天然透传到 wire——集成测试实测锁定(test/qa-tasks-wire.test.ts Task 4)。
    (res as ToolResult & { _meta?: Record<string, unknown> })._meta = { relatedTask: { taskId: runId, status: 'working' } };
    return res;
  }
  // sync：等完整结果（行为与 PR-1a 前一致，响应结构不变）
  const { report, paths } = await exec;

  // 响应只带摘要 + 紧凑步骤表（完整 mismatch/证据在报告文件里，防响应膨胀）
  const stepsCondensed = report.steps.map(s => ({
    index: s.index,
    label: s.label,
    type: s.type,
    status: s.status,
    detail: s.detail?.slice(0, 120),
    skip_reason: s.skip_reason,
    screenshot: s.evidence?.screenshot_path,
  }));
  return textResult(JSON.stringify({
    success: true,
    data: {
      run_id: report.run_id,
      // CLI nightly（同套件上次基线 diff）与 audit 留痕需要；报告 json 内同源
      suite_name: report.suite.name,
      project_path: report.suite.project_path,
      summary: report.summary,
      setup_error: report.setup_error,
      recording: report.recording_path,
      steps: stepsCondensed,
      report: paths,
    },
    warnings: report.teardown_warnings ?? [],
  }));
}

// ─── report ──────────────────────────────────────────────────────────────────

function handleReport(args: Record<string, unknown>): ToolResult {
  const ref = typeof args.report_path === 'string' && args.report_path ? args.report_path : 'latest';
  try {
    const report = readReport(ref);
    return textResult(JSON.stringify({ success: true, data: { report } }));
  } catch (err) {
    return opsErrorResult('REPORT_NOT_FOUND', err instanceof Error ? err.message : String(err),
      { suggestion: `可用报告: ${listReports().slice(0, 10).join(', ') || '(无)'}` });
  }
}

// ─── diff ────────────────────────────────────────────────────────────────────

function handleDiff(args: Record<string, unknown>): ToolResult {
  const baseRef = typeof args.base_path === 'string' && args.base_path ? args.base_path : 'prev';
  const headRef = typeof args.head_path === 'string' && args.head_path ? args.head_path : 'latest';
  try {
    const base = readReport(baseRef);
    const head = readReport(headRef);
    if (base.run_id === head.run_id) {
      return opsErrorResult('INVALID_PARAMS', `base 与 head 是同一份报告 (${base.run_id})`);
    }
    return textResult(JSON.stringify({ success: true, data: diffReports(base, head) }));
  } catch (err) {
    return opsErrorResult('REPORT_NOT_FOUND', err instanceof Error ? err.message : String(err),
      { suggestion: `可用报告: ${listReports().slice(0, 10).join(', ') || '(无)'}` });
  }
}

// ─── status / cancel（PR-1b）─────────────────────────────────────────────────

/** RunRecord → wire 紧凑视图（snake_case 与工具参数/响应命名一致；不含内部字段
 *  cancelRequested/done，终态附报告路径与 summary 摘要，不含 report 全文） */
function condenseRecord(r: RunRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    run_id: r.taskId,
    status: r.status,
    suite_name: r.suite_name,
    progress: r.progress,
    created_at: r.createdAt,
    last_updated_at: r.lastUpdatedAt,
  };
  if (r.status !== 'working') {
    base.report = r.reportPaths;
    base.summary = r.report?.summary;
  }
  return base;
}

function handleStatus(args: Record<string, unknown>): ToolResult {
  const rid = typeof args.run_id === 'string' && args.run_id ? args.run_id : undefined;
  if (!rid) {
    return textResult(JSON.stringify({ success: true, data: { runs: listRuns().map(condenseRecord) } }));
  }
  const r = getRun(rid);
  if (!r) {
    return opsErrorResult('RUN_NOT_FOUND',
      `run_id "${rid}" 不在运行注册表（server 可能已重启或已过期）。尝试 qa report(report_path:"${rid}") 读落盘报告。`);
  }
  return textResult(JSON.stringify({ success: true, data: { run: condenseRecord(r) } }));
}

function handleCancel(args: Record<string, unknown>): ToolResult {
  const rid = typeof args.run_id === 'string' && args.run_id ? args.run_id : '';
  if (!rid) return opsErrorResult('INVALID_PARAMS', 'cancel 需要 run_id');
  const r = requestCancel(rid);
  if (!r.ok) return opsErrorResult('INVALID_PARAMS', r.message ?? '取消失败');
  return textResult(JSON.stringify({
    success: true,
    data: { run_id: rid, cancel_requested: true, note: '取消在当前步骤结束后生效，teardown 照常收尾' },
  }));
}
