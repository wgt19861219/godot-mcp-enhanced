// test/e2e-qa-suite.test.ts — QA 套件 L2 e2e（真 Godot + 真 bridge）
//
// 契约：本地默认 skip，需 GODOT_MCP_E2E_L2=1 + GODOT_PATH；CI godot-matrix job 启用。
// 验证 qa.run 端到端：install → run_project → wait/assert/screenshot 步骤 → 报告落盘 → stop。
// fixture：test/fixtures/e2e-project（main.tscn 仅 Root/Node3D，无 autoload 链）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import type { ToolContext } from '../src/types.js';
import { parseGodotConfig } from '../src/core/config-parser.js';
import * as ps from '../src/core/process-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const E2E_PROJECT = resolve(__dirname, 'fixtures', 'e2e-project');

const RUN = !!process.env.GODOT_MCP_E2E_L2;

if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found' : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] L2 qa suite skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
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

describe('L2 e2e: qa run 端到端（真 Godot）', () => {
  beforeAll(() => {
    if (RUN) registerAllModules();
  });

  afterAll(() => {
    if (RUN) {
      // 进程槽兜底清理（qa stop_after 正常已停；防中途失败泄漏游戏进程）
      const proc = ps.getRunningProcess();
      if (proc) ps.setRunningProcess(null);
      // fixture 还原：qa 的 auto_install_bridge 会写 project.godot autoload + 拷
      // mcp_bridge.gd——e2e-project 的设计前提是"无 autoload"（避免加载链），跑完必须还原。
      const cfgPath = join(E2E_PROJECT, 'project.godot');
      try {
        const cfg = readFileSync(cfgPath, 'utf-8');
        if (/^MCPBridge=/m.test(cfg)) {
          // 去 MCPBridge 行后，若 [autoload] 段变空则整段移除（还原 git 基线的"无 autoload"形态）
          let cleaned = cfg.split('\n').filter(l => !l.startsWith('MCPBridge=')).join('\n');
          cleaned = cleaned.replace(/\[autoload\]\s*(?=(\n\[)|\s*$)/g, '');
          writeFileSync(cfgPath, cleaned.replace(/\n+$/, '\n'), 'utf-8');
        }
        rmSync(join(E2E_PROJECT, 'mcp_bridge.gd'), { force: true });
        rmSync(join(E2E_PROJECT, 'mcp_bridge.gd.uid'), { force: true });
      } catch { /* best effort */ }
    }
  });

  it.runIf(RUN)('smoke 套件：wait_for_node + scene_structure + screenshot → PASSED + 报告落盘', { timeout: 120000 }, async () => {
    // 报告重定向 tmp，防污染真实 ~/.godot-mcp
    const reportDir = resolve(__dirname, '..', '.tmp-qa-e2e-reports');
    rmSync(reportDir, { recursive: true, force: true });
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportDir;

    const mod = getModuleForTool('qa');
    expect(mod).toBeTruthy();

    // 背靠背运行防护：上一场游戏的 9081 释放有拖尾（实测孤儿进程秒级退出但窗口期
    // 下一场 bind 失败 → 31s bridge 超时）。'Bridge not ready' 签名时等 5s 重试一次。
    const runOnce = async (): Promise<Record<string, unknown> | null> => {
      const result = await mod!.handleTool('qa', {
        action: 'run',
        project_path: E2E_PROJECT,
        spec: {
          name: 'l2-smoke',
          options: { bridge_timeout_s: 30, run_timeout_s: 120, suite_budget_ms: 90000 },
          steps: [
            { type: 'wait', method: 'wait_for_node', params: { path: '/root/Root' }, timeout_ms: 20000, label: '主场景加载' },
            { type: 'assert', assert: 'scene_structure', nodes: [{ path: '/root/Root' }], label: 'Root 存在' },
            { type: 'screenshot', label: '留证' },
          ],
        },
      }, makeCtx());
      const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
      return parseResultJson(text);
    };

    let json = await runOnce();
    let setupError = (json?.data as { setup_error?: string } | undefined)?.setup_error;
    if (typeof setupError === 'string' && setupError.includes('Bridge not ready')) {
      await new Promise(r => setTimeout(r, 5000));
      json = await runOnce();
    }

    expect(json).not.toBeNull();
    expect(json!.success).toBe(true);
    const data = json!.data as {
      summary: { status: string; passed: number };
      report: { json_path: string; md_path: string };
      steps: { status: string; label?: string }[];
    };
    expect(data.summary.status).toBe('PASSED');
    expect(data.summary.passed).toBe(3);
    expect(data.steps.map(s => s.status)).toEqual(['PASSED', 'PASSED', 'PASSED']);

    // 报告落盘可回读
    expect(existsSync(data.report.json_path)).toBe(true);
    const reportJson = JSON.parse(readFileSync(data.report.json_path, 'utf-8'));
    expect(reportJson.summary.status).toBe('PASSED');
    expect(existsSync(data.report.md_path)).toBe(true);

    // 游戏已被 stop_after 收尾
    expect(ps.getRunningProcess()).toBeNull();

    rmSync(reportDir, { recursive: true, force: true });
    delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  });
});
