// test/e2e-qa-assert-batch.test.ts — QA 断言四件套 L2 e2e(真 Godot + 真 bridge)
//
// 审查 I-2(spec §5.2 验收缺口):PR-1a 的 4 个新断言(signal/errors/monitor/screenshot_diff)
// 此前仅有 mock 单测。本文件在真 bridge 全链上各跑至少一条步骤 + 一次人为破坏(FAILED 带 mismatch)。
// PR-1b 追加:node_state 真 bridge 嵌套 shape 回归(修复前 actual 恒 undefined 必 FAILED)。
// 契约同 e2e-qa-suite.test.ts:本地默认 skip,需 GODOT_MCP_E2E_L2=1 + GODOT_PATH;
// fixture test/fixtures/e2e-project(Root/Node3D,无 autoload)。
// ⚠️ 并发:bridge 单端口 9081——勿与 e2e-qa-suite / e2e-full-tool-verification 的 L2 describe
// 同时跑(单文件单独跑:`GODOT_MCP_E2E_L2=1 npx vitest run test/e2e-qa-assert-batch.test.ts`)。
//
// fixture 契约注:Root 是纯 Node3D——数值监控属性用 rotation_edit_mode(Node3D 原生
// enum int;process_priority 在 bridge BLOCKED_PROPERTIES、extra_cull_margin 属
// GeometryInstance3D 在纯 Node3D 上 get 返 null;position 是 Vector3 非数值);watch 用
// Node 通用信号 ready(套件启动时已发过 → min_count:0 兜底,验接线非事件量);
// screenshot_diff 参考图用 fixture 根 screenshot.png(1280x720,与 viewport 同尺寸;
// max_diff_ratio:1 允许内容全异 → 验全链)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import type { ToolContext } from '../src/types.js';
import { parseGodotConfig } from '../src/core/config-parser.js';
import * as ps from '../src/core/process-state.js';
import { resetOrphanScanTime } from '../src/core/orphan-cleanup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const E2E_PROJECT = resolve(__dirname, 'fixtures', 'e2e-project');

const RUN = !!process.env.GODOT_MCP_E2E_L2;

if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found' : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] L2 qa assert-batch skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
}

function makeCtx(): ToolContext {
  return {
    opsScript: resolve(__dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    findGodot: () => Promise.resolve(GODOT_PATH),
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skipBusyCheck?) { ps.setRunningProcess(proc, skipBusyCheck); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d: string) { ps.setProjectDir(d); },
    parseGodotConfig,
  };
}

function parseResultJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

describe('L2 e2e: qa 断言四件套 + 人为破坏（真 Godot）', () => {
  beforeAll(() => {
    if (RUN) {
      registerAllModules();
      // 治 bridge 密钥权限循环(e2e-full L2 同款)
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
    }
  });

  afterAll(() => {
    if (!RUN) return;
    // 进程槽兜底清理(qa stop_after 正常已停;防中途失败泄漏游戏进程占 9081)
    const proc = ps.getRunningProcess();
    if (proc) ps.setRunningProcess(null);
    // fixture 还原:qa 的 auto_install_bridge 写 project.godot autoload + 拷 mcp_bridge.gd
    // —— e2e-project 的设计前提是"无 autoload"(避免加载链),跑完必须还原。
    const cfgPath = join(E2E_PROJECT, 'project.godot');
    try {
      const cfg = readFileSync(cfgPath, 'utf-8');
      if (/^MCPBridge=/m.test(cfg)) {
        let cleaned = cfg.split('\n').filter(l => !l.startsWith('MCPBridge=')).join('\n');
        cleaned = cleaned.replace(/\[autoload\]\s*(?=(\n\[)|\s*$)/g, '');
        writeFileSync(cfgPath, cleaned.replace(/\n+$/, '\n'), 'utf-8');
      }
      rmSync(join(E2E_PROJECT, 'mcp_bridge.gd'), { force: true });
      rmSync(join(E2E_PROJECT, 'mcp_bridge.gd.uid'), { force: true });
      rmSync(join(E2E_PROJECT, '.godot', 'mcp_bridge_9081.secret'), { force: true });
    } catch { /* best effort */ }
    // orphan 兜底(e2e-full L2 同款):只杀本会话注册的 PID,零误杀并行文件
    try { resetOrphanScanTime(); void ps.killOrphanGodotProcesses(); } catch { /* best effort */ }
  });

  it.runIf(RUN)('monitor/signal/errors/screenshot_diff 断言全链 + 破坏断言 FAILED 带 mismatch', { timeout: 180000 }, async () => {
    // 报告重定向 tmp(仓库内),防污染真实 ~/.godot-mcp
    const reportDir = resolve(__dirname, '..', '.tmp-qa-assert-e2e-reports');
    rmSync(reportDir, { recursive: true, force: true });
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportDir;

    const mod = getModuleForTool('qa');
    expect(mod).toBeTruthy();

    // 背靠背运行防护(9081 拖尾,'Bridge not ready' 时等 5s 重试一次——e2e-qa-suite 同款)
    const runOnce = async (): Promise<Record<string, unknown> | null> => {
      const result = await mod!.handleTool('qa', {
        action: 'run',
        project_path: E2E_PROJECT,
        spec: {
          name: 'l2-assert-batch',
          options: {
            bridge_timeout_s: 30, run_timeout_s: 120, suite_budget_ms: 120000,
            continue_on_failure: true, // 破坏断言后仍执行,出完整报告
          },
          steps: [
            { type: 'wait', method: 'wait_for_node', params: { path: '/root/Root' }, timeout_ms: 20000, label: '主场景加载' },
            { type: 'monitor_start', node_path: '/root/Root', properties: ['rotation_edit_mode'], interval_frames: 2, label: '监控根节点' },
            { type: 'sleep', ms: 300, label: '采样窗口' },
            { type: 'assert', assert: 'monitor', property: 'rotation_edit_mode', min: -1000, max: 1000, label: 'monitor 区间断言' },
            // 人为破坏:实际值恒 0,期望 ≥99999 必不符 → FAILED + mismatch 带真实 actual
            // (破坏仍用 monitor;node_state 的平铺假设缺陷已于 PR-1b 修复——见下方
            // 'node_state 真 bridge shape' 步骤,修复前该步 actual 恒 undefined 必 FAILED)
            { type: 'assert', assert: 'monitor', property: 'rotation_edit_mode', min: 99999, label: '人为破坏' },
            { type: 'monitor_stop', label: '停监控' },
            { type: 'watch_start', node_path: '/root/Root', signal_name: 'ready', label: '监听 ready' },
            { type: 'watch_stop', label: '停监听' },
            { type: 'assert', assert: 'signal', min_count: 0, label: 'signal 零事件合法' },
            { type: 'assert', assert: 'errors', max_count: 10, label: 'errors 宽松上限' },
            // PR-1b 修复回归:真 bridge get_node_properties 返回嵌套 {properties:{...}, node},
            // 修复前 assertNodeState 按平铺取值 → actual 恒 undefined 必 FAILED;修复后期望 PASSED
            { type: 'assert', assert: 'node_state', path: '/root/Root', expect: { rotation_edit_mode: 0 }, label: 'node_state 真 bridge shape' },
            { type: 'assert', assert: 'screenshot_diff', reference: 'screenshot.png', max_diff_ratio: 1, label: '截图对比全链' },
          ],
        },
      }, makeCtx());
      const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
      return parseResultJson(text);
    };

    let json = await runOnce();
    const setupErrorOf = (j: Record<string, unknown> | null) => (j?.data as { setup_error?: string } | undefined)?.setup_error;
    let se = setupErrorOf(json);
    if (typeof se === 'string' && se.includes('Bridge not ready')) {
      await new Promise(r => setTimeout(r, 5000));
      json = await runOnce();
    }
    se = setupErrorOf(json);

    expect(json).not.toBeNull();
    expect(json!.success).toBe(true);
    expect(se).toBeUndefined();
    const data = json!.data as {
      summary: { total: number; passed: number; failed: number; errors: number; skipped: number; status: string };
      steps: { status: string; label?: string; skip_reason?: string }[];
      report: { json_path: string; md_path: string };
    };

    // 破坏断言 FAILED、其余 11 步全 PASSED(含 PR-1b node_state 嵌套 shape 回归)、summary.failed ≥ 1
    expect(data.summary).toMatchObject({ total: 12, passed: 11, failed: 1, errors: 0, skipped: 0, status: 'FAILED' });
    expect(data.steps.map(s => s.status)).toEqual([
      'PASSED', 'PASSED', 'PASSED', 'PASSED', 'FAILED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED',
    ]);
    expect(data.steps[4]).toMatchObject({ label: '人为破坏', status: 'FAILED' });
    expect(data.steps[10]).toMatchObject({ label: 'node_state 真 bridge shape', status: 'PASSED' });

    // 完整 mismatch 在报告 json(响应 stepsCondensed 不带 mismatch)——FAILED 证据非空
    expect(existsSync(data.report.json_path)).toBe(true);
    const reportJson = JSON.parse(readFileSync(data.report.json_path, 'utf-8'));
    const failedStep = (reportJson.steps as Array<{ label?: string; mismatch?: Record<string, { expected: unknown; actual: unknown }> }>)[4];
    expect(failedStep?.label).toBe('人为破坏');
    expect(failedStep?.mismatch?.rotation_edit_mode).toEqual({ expected: '≥ 99999', actual: 0 });

    // 游戏已被 stop_after 收尾
    expect(ps.getRunningProcess()).toBeNull();

    rmSync(reportDir, { recursive: true, force: true });
    delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  });
});
