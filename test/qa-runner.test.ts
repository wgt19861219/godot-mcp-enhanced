// test/qa-runner.test.ts — QA 执行器编排行为（mock bridge/runtime；断言分发/失败中止/报告聚合）
//
// mock 策略：
// - game-bridge：importOriginal 保留纯函数（pollWaitCondition/computePlaytestTimeoutMs/validate*），
//   只覆写 sendToBridge / setBridgeProjectDir / handleTool（install 用）
// - runtime：整模块 mock（run_project/stop_project）
// - runtime-assert 用真实现（其 sendToBridge 依赖同样被 mock → 同源验证 assert 复用链路）
// 报告目录 env 重定向 tmp。runner.ts 的 game-bridge.ts 不 mock net（符合"仅 game-bridge.test.ts 可 mock net"约定）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { textResult } from '../src/types.js';
import type { ToolContext } from '../src/types.js';

vi.mock('../src/tools/game-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/game-bridge.js')>();
  return {
    ...actual,
    sendToBridge: vi.fn(),
    setBridgeProjectDir: vi.fn(),
    handleTool: vi.fn(),
  };
});

vi.mock('../src/tools/runtime.js', () => ({
  handleTool: vi.fn(),
}));

import { sendToBridge, setBridgeProjectDir, handleTool as bridgeHandleTool } from '../src/tools/game-bridge.js';
import { handleTool as runtimeHandleTool } from '../src/tools/runtime.js';
import { runQaSuite } from '../src/tools/qa/runner.js';
import { renderMarkdown } from '../src/tools/qa/report.js';
import { parseQaSuite, type QaSuite } from '../src/tools/qa/spec.js';

const PROJECT = 'D:/proj/demo';

function makeCtx(): ToolContext {
  return {
    opsScript: 'D:/build/scripts/godot_operations.gd',
    findGodot: async () => 'godot',
    runningProcess: null,
    setRunningProcess: () => {},
    outputBuffer: [],
    setOutputBuffer: () => {},
    processStartTime: 0,
    setProcessStartTime: () => {},
    projectDir: '',
    setProjectDir: () => {},
    parseGodotConfig: () => ({}),
  };
}

function suite(overrides: Record<string, unknown> = {}): QaSuite {
  const parsed = parseQaSuite({
    name: 'unit',
    project_path: PROJECT,
    ...overrides,
  });
  if (!parsed.ok || !parsed.suite) throw new Error(parsed.error ?? 'bad suite');
  return parsed.suite;
}

/** 默认 mock：install/run 成功；sendToBridge 按方法路由 */
function defaultMocks(props: Record<string, unknown> = {}) {
  vi.mocked(bridgeHandleTool).mockResolvedValue(textResult(JSON.stringify({ success: true, message: 'installed' })));
  vi.mocked(runtimeHandleTool).mockImplementation(async (_n, args) => {
    const action = (args as Record<string, unknown>).action;
    if (action === 'run_project') return textResult('Bridge ready. Running project at D:/proj/demo (timeout: 600s).');
    return textResult('Stopped.');
  });
  vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
    if (method === 'get_node_properties') return { id: 1, result: { health: 100 } };
    if (method === 'get_tree') return { id: 2, result: { nodes: [{ path: '/root/Root' }] } };
    if (method === 'take_screenshot') return { id: 3, result: { success: true, path: 'user://mcp_screenshot.png', size: { x: 64, y: 64 } } };
    if (method === 'ping') return { id: 4, result: {} };
    if (method === 'wait_for_node') return { id: 6, result: { exists: true } };
    return { id: 5, result: {} };
  });
  void setBridgeProjectDir;
  void props;
}

let dir: string;
const prevEnv = process.env.GODOT_MCP_QA_REPORTS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-runner-test-'));
  process.env.GODOT_MCP_QA_REPORTS_DIR = dir;
  vi.clearAllMocks();
  defaultMocks();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  else process.env.GODOT_MCP_QA_REPORTS_DIR = prevEnv;
});

describe('runQaSuite happy path', () => {
  it('install→run→seed→steps→stop 全链编排 + 报告 PASSED', async () => {
    const s = suite({
      options: { seed: 42, stop_after: true },
      steps: [
        { type: 'input', method: 'send_key', params: { key: 'space', pressed: true }, label: '按下' },
        { type: 'wait', method: 'wait_for_node', params: { path: '/root/Root' } },
        { type: 'assert', assert: 'node_state', path: '/root/Root', expect: { health: 100 }, label: '满血' },
        { type: 'screenshot', label: '留证' },
      ],
    });

    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');

    // 生命周期调用序列
    expect(bridgeHandleTool).toHaveBeenCalledWith('game', expect.objectContaining({ action: 'game_bridge_install' }), expect.anything());
    expect(runtimeHandleTool).toHaveBeenCalledWith('runtime', expect.objectContaining({ action: 'run_project', wait_for_bridge: true }), expect.anything());
    expect(runtimeHandleTool).toHaveBeenCalledWith('runtime', expect.objectContaining({ action: 'stop_project' }), expect.anything());

    // 步骤层 sendToBridge 序列：seed → input → wait probe → assert 查询 → screenshot
    const methods = vi.mocked(sendToBridge).mock.calls.map(c => c[0]);
    expect(methods).toEqual(expect.arrayContaining(['playtest.seed', 'send_key', 'wait_for_node', 'get_node_properties', 'take_screenshot']));

    expect(report.summary).toMatchObject({ total: 4, passed: 4, failed: 0, errors: 0, skipped: 0, status: 'PASSED' });
    expect(report.steps.map(x => x.status)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
    // PROJECT 是虚构路径 → user:// 解析不到本地文件 → 诚实降级（记录游戏侧路径，不伪造证据）
    expect(report.steps[3]!.detail).toContain('留在游戏侧');
    expect(report.steps[3]!.evidence?.screenshot_path).toBeUndefined();
  });

  // darwin 的 Godot 数据根(~/Library/Application Support/Godot)无法用环境变量重定向,跳过(CI 矩阵仅 win/linux)
  it.skipIf(process.platform === 'darwin')('screenshot 步骤：user:// 解析成功时 PNG 拷入报告目录', async () => {
    // 构造 Godot app_userdata 布局(平台无关)：win32=APPDATA/Godot/app_userdata/<name>，
    // linux=XDG_DATA_HOME/godot/app_userdata/<name>(resolveGameDataPath 按 platform 选 base，
    // 只设 APPDATA 在 Linux CI 上解析不到 → 降级分支 → 本测试首跑 CI 即红,issue 见 PR#25)
    const appdata = mkdtempSync(join(tmpdir(), 'qa-appdata-'));
    const project = mkdtempSync(join(tmpdir(), 'qa-proj-'));
    const prevAppdata = process.env.APPDATA;
    const prevXdg = process.env.XDG_DATA_HOME;
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="TestProj"\n');
    const godotRoot = process.platform === 'win32'
      ? (process.env.APPDATA = appdata, join(appdata, 'Godot'))
      : (process.env.XDG_DATA_HOME = appdata, join(appdata, 'godot'));
    const userDataDir = join(godotRoot, 'app_userdata', 'TestProj');
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(join(userDataDir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    try {
      vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
        if (method === 'take_screenshot') return { id: 3, result: { success: true, path: 'user://shot.png', size: { x: 8, y: 4 } } };
        return { id: 5, result: {} };
      });
      const s = suite({ project_path: project, steps: [{ type: 'screenshot', label: '拷贝成功' }] });
      const report = await runQaSuite(s, project, makeCtx(), 'inline');

      expect(report.steps[0]!.status).toBe('PASSED');
      expect(report.steps[0]!.detail).toContain('8x4');
      const shotPath = report.steps[0]!.evidence!.screenshot_path!;
      expect(shotPath).toMatch(/-step0\.png$/);
      expect(existsSync(shotPath)).toBe(true);
    } finally {
      process.env.APPDATA = prevAppdata;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
      rmSync(appdata, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('失败语义', () => {
  it('断言 mismatch → FAILED + 后续 SKIPPED（默认中止）', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'get_node_properties') return { id: 1, result: { health: 1 } }; // 不匹配 expect 100
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'assert', assert: 'node_state', path: '/root/Root', expect: { health: 100 }, label: '满血' },
        { type: 'sleep', ms: 150, label: '不应执行' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]).toMatchObject({ status: 'FAILED', label: '满血' });
    expect(report.steps[0]!.mismatch).toEqual({ health: { expected: 100, actual: 1 } });
    expect(report.steps[1]).toMatchObject({ status: 'SKIPPED' });
    expect(report.steps[1]!.skip_reason).toContain('aborted after step 0');
    expect(report.summary).toMatchObject({ status: 'FAILED', failed: 1, skipped: 1 });
  });

  it('continue_on_failure=true → FAILED 后继续执行', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'get_node_properties') return { id: 1, result: { health: 1 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      options: { continue_on_failure: true },
      steps: [
        { type: 'assert', assert: 'node_state', path: '/root/Root', expect: { health: 100 } },
        { type: 'sleep', ms: 120 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('FAILED');
    expect(report.steps[1]!.status).toBe('PASSED');
    expect(report.summary).toMatchObject({ failed: 1, passed: 1, status: 'FAILED' });
  });

  it('bridge error → 步骤 ERROR + 中止', async () => {
    vi.mocked(sendToBridge).mockResolvedValue({ id: 9, error: { code: -32001, message: 'auth fail' } });
    const s = suite({ steps: [{ type: 'input', method: 'send_key', params: { key: 'w' } }, { type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]).toMatchObject({ status: 'ERROR' });
    expect(report.steps[0]!.detail).toContain('auth fail');
    expect(report.steps[1]!.status).toBe('SKIPPED');
  });

  it('wait 超时三分支(B2):节点不存在→UNMEASURED / 值不符→FAILED / 属性缺失→UNMEASURED', async () => {
    // ① wait_for_node 节点不存在(exists=false 持续到超时)→ UNMEASURED(前提不成立)
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'wait_for_node') return { id: 1, result: { exists: false, path: '/root/Nope' } };
      return { id: 5, result: {} };
    });
    const s1 = suite({
      options: { wait_timeout_ms: 600 },
      steps: [{ type: 'wait', method: 'wait_for_node', params: { path: '/root/Nope' } }],
    });
    const r1 = await runQaSuite(s1, PROJECT, makeCtx(), 'inline');
    expect(r1.steps[0]!.status).toBe('UNMEASURED');
    expect(r1.steps[0]!.detail).toContain('前提不成立');
    expect(r1.steps[0]!.detail).toContain('/root/Nope');
    expect(r1.summary.unmeasured).toBe(1);
    expect(r1.summary.status).toBe('FAILED');  // Feel Gate:无法测量的检查不是通过

    // ② wait_for_property 属性存在但值不符(match=false current 有值)→ FAILED(现状)
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'wait_for_property') return { id: 2, result: { match: false, property: 'hp', current: 30, expected: '100' } };
      return { id: 5, result: {} };
    });
    const s2 = suite({
      options: { wait_timeout_ms: 600 },
      steps: [{ type: 'wait', method: 'wait_for_property', params: { path: '/root/Root', property: 'hp', value: '100' } }],
    });
    const r2 = await runQaSuite(s2, PROJECT, makeCtx(), 'inline');
    expect(r2.steps[0]!.status).toBe('FAILED');
    expect(r2.steps[0]!.detail).toContain('未在');
    expect(r2.steps[0]!.detail).toContain('30');
    expect(r2.summary.unmeasured).toBe(0);

    // ③ wait_for_property 属性缺失(current=null)→ UNMEASURED
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'wait_for_property') return { id: 3, result: { match: false, property: 'mana', current: null, expected: '50' } };
      return { id: 5, result: {} };
    });
    const s3 = suite({
      options: { wait_timeout_ms: 600 },
      steps: [{ type: 'wait', method: 'wait_for_property', params: { path: '/root/Root', property: 'mana', value: '50' } }],
    });
    const r3 = await runQaSuite(s3, PROJECT, makeCtx(), 'inline');
    expect(r3.steps[0]!.status).toBe('UNMEASURED');
    expect(r3.steps[0]!.detail).toContain('mana');
    expect(r3.summary.unmeasured).toBe(1);

    // ④ wait_for_property 节点缺失(GD 报 JSON-RPC error Node not found,轮询立即中止)→ UNMEASURED
    vi.mocked(sendToBridge).mockResolvedValue({ id: 4, error: { code: -1, message: 'Node not found: /root/Gone' } });
    const s4 = suite({
      options: { wait_timeout_ms: 600 },
      steps: [{ type: 'wait', method: 'wait_for_property', params: { path: '/root/Gone', property: 'hp', value: '1' } }],
    });
    const r4 = await runQaSuite(s4, PROJECT, makeCtx(), 'inline');
    expect(r4.steps[0]!.status).toBe('UNMEASURED');
    expect(r4.steps[0]!.detail).toContain('Node not found');

    // ⑤ 其他 bridge error(非 Node not found)仍 ERROR(现状不放松)
    vi.mocked(sendToBridge).mockResolvedValue({ id: 6, error: { code: -2, message: 'Blocked property: script' } });
    const s5 = suite({
      options: { wait_timeout_ms: 600 },
      steps: [{ type: 'wait', method: 'wait_for_property', params: { path: '/root/Root', property: 'script', value: 'x' } }],
    });
    const r5 = await runQaSuite(s5, PROJECT, makeCtx(), 'inline');
    expect(r5.steps[0]!.status).toBe('ERROR');
  });
});

describe('setup / teardown', () => {
  it('install 失败 → 全 SKIPPED + setup_error，不 run_project', async () => {
    vi.mocked(bridgeHandleTool).mockResolvedValue(textResult('Error: Bridge script not found at /x'));
    const s = suite({ steps: [{ type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.setup_error).toContain('game_bridge_install 失败');
    expect(report.steps[0]!.skip_reason).toContain('setup'); // 初始 SKIPPED 无 skip_reason → 用状态断言
    expect(report.steps[0]!.status).toBe('SKIPPED');
    expect(report.summary.status).toBe('FAILED');
    expect(runtimeHandleTool).not.toHaveBeenCalled();
  });

  it('run_project 未就绪 → setup_error + 不执行步骤', async () => {
    vi.mocked(runtimeHandleTool).mockResolvedValue(textResult('Error: Bridge not ready (timeout). Game stopped.'));
    const s = suite({ steps: [{ type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.setup_error).toContain('run_project 失败');
    expect(report.summary.status).toBe('FAILED');
  });

  it('auto_run=false 且 ping 失败 → 可行动 setup_error', async () => {
    vi.mocked(sendToBridge).mockResolvedValue({ id: 1, error: { code: -1, message: 'ECONNREFUSED' } });
    const s = suite({ options: { auto_run: false }, steps: [{ type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.setup_error).toContain('auto_run=false');
    expect(report.setup_error).toContain('ECONNREFUSED');
  });

  it('stop_after=false → 不调 stop_project', async () => {
    const s = suite({ options: { stop_after: false }, steps: [{ type: 'sleep', ms: 100 }] });
    await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(runtimeHandleTool).toHaveBeenCalledTimes(1); // 仅 run_project
  });

  it('stop_project 抛异常 → teardown_warnings 记录且不影响判定', async () => {
    vi.mocked(runtimeHandleTool).mockImplementation(async (_n, args) => {
      const action = (args as Record<string, unknown>).action;
      if (action === 'run_project') return textResult('Bridge ready.');
      throw new Error('kill failed');
    });
    const s = suite({ steps: [{ type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.teardown_warnings?.[0]).toContain('stop_project 失败');
    expect(report.summary.status).toBe('PASSED');
  });
});

describe('步骤分支覆盖（审查 NIT-8 补缺：set/call/step_until/wait_frames）', () => {
  it('set 步骤：参数直传 + 非 /root/ 前缀路径被拒（ERROR）', async () => {
    const s1 = suite({ steps: [{ type: 'set', path: '/root/Root', property: 'x', value: 3 }] });
    const r1 = await runQaSuite(s1, PROJECT, makeCtx(), 'inline');
    expect(r1.steps[0]!.status).toBe('PASSED');
    expect(sendToBridge).toHaveBeenCalledWith('set_node_property',
      { path: '/root/Root', property: 'x', value: 3 }, expect.any(Number));

    vi.mocked(sendToBridge).mockClear();
    const s2 = suite({ steps: [{ type: 'set', path: 'Root', property: 'x', value: 3 }] });
    const r2 = await runQaSuite(s2, PROJECT, makeCtx(), 'inline');
    expect(r2.steps[0]!.status).toBe('ERROR');
    expect(r2.steps[0]!.detail).toContain('/root/');
  });

  it('call 步骤：args 默认空数组 + bridge 拒绝时提示 EXTRA_METHODS 逃生口', async () => {
    const s = suite({ steps: [{ type: 'call', path: '/root/Root', method: 'take_damage' }] });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(sendToBridge).toHaveBeenCalledWith('call_method',
      { path: '/root/Root', method: 'take_damage', args: [] }, expect.any(Number));
    expect(r.steps[0]!.status).toBe('PASSED'); // 默认 mock 无 error

    vi.mocked(sendToBridge).mockResolvedValue({ id: 9, error: { code: -1, message: 'blocked by whitelist' } });
    const r2 = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r2.steps[0]!.status).toBe('ERROR');
    expect(r2.steps[0]!.detail).toContain('GODOT_MCP_BRIDGE_EXTRA_METHODS');
  });

  it('step_until 步骤：conditions/max_frames/wall_budget_ms 透传 playtest.step_until', async () => {
    vi.mocked(sendToBridge).mockResolvedValue({ id: 5, result: { success: true, predicate_met: true, frames_elapsed: 42, wall_exceeded: false, error: '' } });
    const s = suite({
      steps: [{
        type: 'step_until',
        conditions: [{ path: '/root/Root', property: 'x', op: '>=', value: 3 }],
        max_frames: 120,
        wall_budget_ms: 5000,
      }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.steps[0]!.status).toBe('PASSED');
    const call = vi.mocked(sendToBridge).mock.calls.find(c => c[0] === 'playtest.step_until');
    expect(call?.[1]).toEqual({
      conditions: [{ path: '/root/Root', property: 'x', op: '>=', value: 3 }],
      max_frames: 120,
      wall_budget_ms: 5000,
    });
    // wall_budget 5000 + 5s 余量公式（≥10000，且不小于 step 基础超时下限）
    expect(call?.[2]).toBeGreaterThanOrEqual(10000);
  });

  it('step_until 三态(B2):条件未满足→FAILED(修原无条件 PASSED 假绿)/ 前提缺失→UNMEASURED', async () => {
    // ① predicate_met=false(帧耗尽)→ FAILED(原实现无条件 PASSED,与 spec 语义相悖)
    vi.mocked(sendToBridge).mockResolvedValue({ id: 5, result: { success: true, predicate_met: false, frames_elapsed: 120, wall_exceeded: false, error: '' } });
    const s1 = suite({
      steps: [{ type: 'step_until', conditions: [{ path: '/root/Root', property: 'x', op: '>=', value: 3 }], max_frames: 120 }],
    });
    const r1 = await runQaSuite(s1, PROJECT, makeCtx(), 'inline');
    expect(r1.steps[0]!.status).toBe('FAILED');
    expect(r1.steps[0]!.detail).toContain('未满足');
    expect(r1.steps[0]!.detail).toContain('120');
    expect(r1.steps[0]!.mismatch?.predicate).toBeTruthy();

    // ② 前提缺失(node/property not found,GD result.error 非空)→ UNMEASURED
    vi.mocked(sendToBridge).mockResolvedValue({ id: 5, result: { success: true, predicate_met: false, frames_elapsed: 7, wall_exceeded: false, error: 'node not found/freed: /root/Root' } });
    const s2 = suite({
      steps: [{ type: 'step_until', conditions: [{ path: '/root/Root', property: 'x', op: '>=', value: 3 }] }],
    });
    const r2 = await runQaSuite(s2, PROJECT, makeCtx(), 'inline');
    expect(r2.steps[0]!.status).toBe('UNMEASURED');
    expect(r2.steps[0]!.detail).toContain('前提不成立');
    expect(r2.summary.unmeasured).toBe(1);
  });

  it('wait_frames 步骤：playtest.step {frames} 透传', async () => {
    const s = suite({ steps: [{ type: 'wait_frames', frames: 5 }] });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.steps[0]!.status).toBe('PASSED');
    expect(sendToBridge).toHaveBeenCalledWith('playtest.step', { frames: 5 }, expect.any(Number));
  });
});

describe('报告落盘接线', () => {
  it('writeReport(runner 产物) → json 可回读且结构完整', async () => {
    const { writeReport } = await import('../src/tools/qa/report.js');
    const s = suite({ steps: [{ type: 'sleep', ms: 100, label: '唯一' }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    const paths = writeReport(report);
    const back = JSON.parse(readFileSync(paths.json_path, 'utf-8'));
    expect(back.summary.status).toBe('PASSED');
    expect(back.steps[0].label).toBe('唯一');
    expect(back.run_id).toBe(report.run_id);
  });
});

// ═══ QA 收尾批（2026-08-16）：NIT-8 分支补全 + record_on_failure ═══

describe('playtest 控制步骤（NIT-8 补全：freeze/unfreeze/snapshot/restore）', () => {
  it('freeze/unfreeze → playtest.freeze / playtest.unfreeze 方法名 + 成功 PASSED', async () => {
    const s = suite({
      steps: [
        { type: 'freeze', label: '冻结' },
        { type: 'unfreeze', label: '解冻' },
      ],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.steps.map(x => x.status)).toEqual(['PASSED', 'PASSED']);
    expect(sendToBridge).toHaveBeenCalledWith('playtest.freeze', {}, expect.any(Number));
    expect(sendToBridge).toHaveBeenCalledWith('playtest.unfreeze', {}, expect.any(Number));
  });

  it('snapshot/restore → playtest.snapshot / playtest.restore 透传', async () => {
    const s = suite({
      steps: [{ type: 'snapshot', label: '快照' }, { type: 'restore', label: '恢复' }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.steps.map(x => x.status)).toEqual(['PASSED', 'PASSED']);
    expect(sendToBridge).toHaveBeenCalledWith('playtest.snapshot', {}, expect.any(Number));
    expect(sendToBridge).toHaveBeenCalledWith('playtest.restore', {}, expect.any(Number));
  });

  it('freeze bridge error → ERROR + 中止后续步骤', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'playtest.freeze') return { id: 9, error: { code: -1, message: 'frozen by other peer' } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [{ type: 'freeze' }, { type: 'unfreeze' }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.steps[0]!.status).toBe('ERROR');
    expect(r.steps[0]!.detail).toContain('frozen by other peer');
    expect(r.steps[1]!.skip_reason).toContain('aborted after step 0');
  });
});

describe('suite budget 耗尽（NIT-8）', () => {
  it('预算耗尽后剩余步骤 SKIPPED + summary FAILED', async () => {
    // Date.now 递进 mock：第 4 次调用起 +11s（suite_budget_ms=10000 最小值），
    // 首个步骤执行中预算被吃穿 → 后续步骤 SKIPPED。阈值断言容错（内部调用次数实现细节）。
    const realNow = Date.now();
    let calls = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + (calls++ > 3 ? 11000 : 0));
    try {
      const s = suite({
        options: { suite_budget_ms: 10000, continue_on_failure: true },
        steps: [
          { type: 'sleep', ms: 100, label: 's1' },
          { type: 'sleep', ms: 100, label: 's2' },
          { type: 'sleep', ms: 100, label: 's3' },
        ],
      });
      const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
      expect(r.steps.some(x => x.skip_reason === 'suite budget exhausted')).toBe(true);
      expect(r.summary.skipped).toBeGreaterThanOrEqual(1);
      expect(r.summary.status).toBe('FAILED'); // skipped>0 → FAILED（finalizeSummary 语义）
    } finally {
      spy.mockRestore();
    }
  });
});

describe('record_on_failure（QA 收尾批①）', () => {
  const recordingEvents = [{ type: 'key', keycode: 87, pressed: true, time_offset: 120 }];

  function recordMocks(): string[] {
    // 共享顺序日志：验证 recording.stop 先于 stop_project（杀游戏断 bridge 前取 events）
    const order: string[] = [];
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      order.push(method);
      if (method === 'recording.start') return { id: 10, result: {} };
      if (method === 'recording.stop') return { id: 11, result: { version: 1, duration_ms: 500, events: recordingEvents } };
      if (method === 'get_node_properties') return { id: 1, result: { health: 1 } }; // 断言失败：expect 100
      return { id: 5, result: {} };
    });
    vi.mocked(runtimeHandleTool).mockImplementation(async (_n, args) => {
      const action = (args as Record<string, unknown>).action;
      order.push(`runtime:${String(action)}`);
      if (action === 'run_project') return textResult('Bridge ready. Running project.');
      return textResult('Stopped.');
    });
    return order;
  }

  it('失败套件：events 落盘 qa-reports/<run_id>-recording.json + recording.stop 先于 stop_project', async () => {
    const order = recordMocks();
    const s = suite({
      options: { record_on_failure: true },
      steps: [{ type: 'assert', assert: 'node_state', path: '/root/Root', expect: { health: 100 } }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.summary.status).toBe('FAILED');
    expect(r.recording_path).toBeDefined();
    const saved = JSON.parse(readFileSync(r.recording_path!, 'utf-8'));
    expect(saved).toEqual({ version: 1, duration_ms: 500, events: recordingEvents });
    expect(order.indexOf('recording.stop')).toBeLessThan(order.lastIndexOf('runtime:stop_project'));
    expect(order).toContain('recording.start');
  });

  it('成功套件：不落盘（recording_path undefined）', async () => {
    recordMocks();
    const s = suite({
      options: { record_on_failure: true },
      steps: [{ type: 'sleep', ms: 100 }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.summary.status).toBe('PASSED');
    expect(r.recording_path).toBeUndefined();
  });

  it('recording.start 失败（旧 bridge）：teardown_warning 降级，套件照常执行', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'recording.start') return { id: 10, error: { code: -32601, message: 'Method not found' } };
      return { id: 5, result: {} };
    });
    const s = suite({
      options: { record_on_failure: true },
      steps: [{ type: 'sleep', ms: 100 }],
    });
    const r = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(r.summary.status).toBe('PASSED');
    expect(r.teardown_warnings?.some(w => w.includes('recording.start 失败'))).toBe(true);
    expect(r.recording_path).toBeUndefined();
  });

  it('默认 false：不发起录制（负例）', async () => {
    const order = recordMocks();
    const s = suite({ steps: [{ type: 'sleep', ms: 100 }] });
    await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(order).not.toContain('recording.start');
  });
});

// ═══ PR-1a Task 3：watch/monitor 控制步骤 + RunState + teardown 兜底 stop ═══

describe('qa runner: watch/monitor 控制步骤(Task PR-1a)', () => {
  it('watch_start→watch_stop 正常执行,stop 后 detail 带事件数', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.stop') return { id: 2, result: { watching: false, events: [{ frame: 10, time: 1.5, args: [42] }], event_count: 1 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/Main', signal_name: 'pressed' },
        { type: 'watch_stop' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.summary.status).toBe('PASSED');
    expect(report.steps[1]!.detail).toContain('1 event');
  });

  it('本套件重复 watch_start → 第二个 ERROR', async () => {
    // watch.poll 探测返回非 watching(无套件外 watch)
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 3, result: { watching: false, events: [] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/A', signal_name: 'x' },
        { type: 'watch_start', node_path: '/root/B', signal_name: 'y' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('ERROR');
    expect(report.steps[1]!.detail).toContain('已有活跃 watch');
  });

  it('watch_start 时探测到套件外既有 watch → detail 注明已替换', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.poll') return { id: 3, result: { watching: true, events: [{ frame: 1, time: 0.1, args: [] }] } };
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/A', signal_name: 'x' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('PASSED');
    expect(report.steps[0]!.detail).toContain('已替换');
  });

  it('步骤中断后(aborted)teardown 对未 stop 的 watch 兜底补 stop', async () => {
    const stopCalls: string[] = [];
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'send_key') return { id: 4, result: {} };
      if (method === 'watch.stop') { stopCalls.push(method); return { id: 2, result: { watching: false, events: [], event_count: 0 } }; }
      if (method === 'monitor.stop') { stopCalls.push(method); return { id: 6, result: { monitoring: false, samples: [], stopped_reason: '' } }; }
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/A', signal_name: 'x' },
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
      ],
    });
    // input 会 PASSED,teardown 兜底仍应触发(套件结束时 watch 仍 active)
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.summary.status).toBe('PASSED');
    expect(stopCalls).toContain('watch.stop');
  });

  it('monitor_start→monitor_stop 正常执行', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.stop') return { id: 8, result: { monitoring: false, samples: [{ frame: 5, time: 0.5, values: { health: 80 } }], sample_count: 1, stopped_reason: '' } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'], interval_frames: 5 },
        { type: 'monitor_stop' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.summary.status).toBe('PASSED');
  });
});

// ═══ PR-1a Task 4:signal/monitor 断言 + Task 3 审查 Minor 补测 ═══

describe('qa runner: signal/monitor 断言(Task PR-1a)', () => {
  it('signal 断言:活跃 watch poll 取数,args_match 深比较计数', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 2, result: { watching: true, node_path: '/root/B', signal_name: 'moved',
        events: [
          { frame: 10, time: 1.0, args: [{ x: 1, y: 2 }] },
          { frame: 20, time: 2.0, args: [{ x: 3, y: 4 }] },
          { frame: 30, time: 3.0, args: ['other'] },
        ], event_count: 3 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/B', signal_name: 'moved' },
        // 3 事件中仅 1 个 args 深等于 [{x:1,y:2}]:[{x:3,y:4}] 与 ['other'] 均被排除。
        // (brief 原文 min/max=2 与 jsonEqual 语义不自洽,修正为 1/1——偏离见 task-4-report)
        { type: 'assert', assert: 'signal', min_count: 1, max_count: 1, args_match: [{ x: 1, y: 2 }] },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED');
  });

  it('signal 断言 B-2:max_events 满自动停(poll 空)→ 补 stop 取全量,不误判 0 事件', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 2, result: { watching: false, events: [], message: 'No active watch' } };
      // (brief 原文此处引用未定义变量 i 会 ReferenceError,改为字面量——偏离见 task-4-report)
      if (method === 'watch.stop') return { id: 3, result: { watching: false,
        events: [{ frame: 1, time: 1, args: [1] }], event_count: 1 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/B', signal_name: 'hit' },
        { type: 'assert', assert: 'signal', min_count: 1 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED'); // 补 stop 后拿到 1 事件,不假红
  });

  it('signal 断言:计数低于 min_count → FAILED 且 mismatch 带实际计数', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 2, result: { watching: true, events: [], event_count: 0 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/B', signal_name: 'x' },
        { type: 'assert', assert: 'signal', min_count: 3 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('FAILED');
    expect(report.steps[1]!.mismatch?.count).toEqual({ expected: '[3, ∞]', actual: 0 });
  });

  it('signal 断言:从未 watch_start → ERROR', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.poll') return { id: 2, result: { watching: false, events: [], message: 'No active watch' } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'assert', assert: 'signal', min_count: 1 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('ERROR');
    // Minor③(s4 弱断言补 detail):错误消息可行动——指引用户先 watch_start
    expect(report.steps[0]!.detail).toContain('watch_start');
  });

  it('monitor 断言:min/max 区间 + non_increasing 单调判定 PASSED', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.poll') return { id: 9, result: { monitoring: true, node_path: '/root/P', sample_count: 3,
        samples: [
          { frame: 1, time: 0.1, values: { health: 100 } },
          { frame: 2, time: 0.2, values: { health: 90 } },
          { frame: 3, time: 0.3, values: { health: 90 } },
        ] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'assert', assert: 'monitor', property: 'health', min: 50, max: 100, monotonic: 'non_increasing' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED');
  });

  it('monitor 断言 B-2:node_lost 自动停(poll 空)→ 补 stop 取全量,判 ERROR(数据不完整)', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.poll') return { id: 9, result: { monitoring: false, samples: [], stopped_reason: 'node_lost', message: 'Monitor stopped: node_lost' } };
      if (method === 'monitor.stop') return { id: 8, result: { monitoring: false, sample_count: 2, stopped_reason: 'node_lost',
        samples: [
          { frame: 1, time: 0.1, values: { health: 100 } },
          { frame: 2, time: 0.2, error: 'node_lost', stopped_reason: 'node_lost' },
        ] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'assert', assert: 'monitor', property: 'health', min: 0 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('ERROR');
    expect(report.steps[1]!.detail).toContain('node_lost');
  });

  it('monitor 断言:越界 → FAILED 且 mismatch 带首个违规样本', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.poll') return { id: 9, result: { monitoring: true, sample_count: 2,
        samples: [
          { frame: 1, time: 0.1, values: { fps: 60 } },
          { frame: 2, time: 0.2, values: { fps: 20 } },
        ] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['fps'] },
        { type: 'assert', assert: 'monitor', property: 'fps', min: 30 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('FAILED');
    expect(report.steps[1]!.mismatch?.fps).toEqual({ expected: '≥ 30', actual: 20 });
  });

  it('monitor 断言:样本缺属性 → ERROR(不假绿)', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.poll') return { id: 9, result: { monitoring: true, sample_count: 1,
        samples: [{ frame: 1, time: 0.1, values: { other: 1 } }] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['fps'] },
        { type: 'assert', assert: 'monitor', property: 'fps', min: 30 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('ERROR');
    // Minor③(m5 弱断言补 detail):错误消息指明缺失的属性名(可行动)
    expect(report.steps[1]!.detail).toContain('缺属性');
  });
});

describe('qa runner: monitor 单调四档(审查 I-3:每档满足→PASSED/违反→FAILED)', () => {
  // 审查 I-3:execMonitorAssert 单调判定是 every+findIndex 双段逻辑,此前手写用例仅覆盖
  // non_increasing 满足侧一档——`>` 误写为 `>=` 之类回归现有测试全绿。此处四档正反全锁。
  const modes: Array<{ mode: 'increasing' | 'non_decreasing' | 'decreasing' | 'non_increasing'; passSeq: number[]; failSeq: number[]; desc: string }> = [
    { mode: 'increasing', passSeq: [10, 20, 40], failSeq: [10, 20, 20], desc: '严格递增:相等即违反' },
    { mode: 'non_decreasing', passSeq: [10, 20, 20, 30], failSeq: [10, 30, 20], desc: '非降:下降违反,相等合法' },
    { mode: 'decreasing', passSeq: [50, 30, 10], failSeq: [50, 30, 30], desc: '严格递减:相等即违反' },
    { mode: 'non_increasing', passSeq: [50, 30, 30, 10], failSeq: [10, 20], desc: '非增:上升违反,相等合法' },
  ];

  function monitorMocks(seq: number[]) {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.poll') return {
        id: 9,
        result: { monitoring: true, sample_count: seq.length, samples: seq.map((v, i) => ({ frame: i + 1, time: 0.1 * (i + 1), values: { health: v } })) },
      };
      return { id: 5, result: {} };
    });
  }

  for (const { mode, passSeq, failSeq, desc } of modes) {
    it(`${mode} 满足序列 [${passSeq}] → PASSED(${desc})`, async () => {
      monitorMocks(passSeq);
      const s = suite({
        steps: [
          { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
          { type: 'assert', assert: 'monitor', property: 'health', monotonic: mode },
        ],
      });
      const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
      expect(report.steps[1]!.status).toBe('PASSED');
    });

    it(`${mode} 违反序列 [${failSeq}] → FAILED 且 mismatch 带 ${mode} 与首违规对`, async () => {
      monitorMocks(failSeq);
      const s = suite({
        steps: [
          { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
          { type: 'assert', assert: 'monitor', property: 'health', monotonic: mode },
        ],
      });
      const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
      expect(report.steps[1]!.status).toBe('FAILED');
      expect(report.steps[1]!.mismatch?.health_monotonic).toMatchObject({ expected: mode });
      // 首违规对:frame 前值→后值(违反该档判据的相邻样本对)
      expect(String(report.steps[1]!.mismatch?.health_monotonic?.actual)).toContain('→');
    });
  }

  it('min/max 两处越界(一低一高)→ mismatch 定位首个违规样本(审查 I-3)', async () => {
    // 序列 [90(ok), 200(>max), 40(<min)],区间 [60,100]:首违规是 frame2=200,
    // 非 frame3=40——锁 findIndex 语义(取第一个,不是任意/最后一个越界样本)
    monitorMocks([90, 200, 40]);
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'assert', assert: 'monitor', property: 'health', min: 60, max: 100 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('FAILED');
    expect(report.steps[1]!.mismatch?.health).toEqual({ expected: '≥ 60 且 ≤ 100', actual: 200 });
    expect(report.steps[1]!.detail).toContain('frame 2');
  });
});

describe('qa runner: Task 3 审查 Minor 修复/补测(watch_stop 幂等 + monitor)', () => {
  it('watch_stop 重复调用(Minor③):已 stop 有缓存 → PASSED 不重发 bridge,缓存不被空结果冲掉', async () => {
    let stopCount = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 3, result: { watching: false, events: [] } };
      if (method === 'watch.stop') {
        stopCount++;
        // 模拟 GD 侧:第二次 stop 时已无活跃 watch,返成功 result + 空 events(会把缓存覆盖为 [])
        const events = stopCount === 1 ? [{ frame: 10, time: 1.0, args: [7] }] : [];
        return { id: 2, result: { watching: false, events, event_count: events.length } };
      }
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/B', signal_name: 'hit' },
        { type: 'watch_stop' },
        { type: 'watch_stop' },
        { type: 'assert', assert: 'signal', min_count: 1, max_count: 1 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED');
    expect(report.steps[2]!.status).toBe('PASSED');
    expect(report.steps[2]!.detail).toContain('cached');
    expect(stopCount).toBe(1); // 第二次 watch_stop 不重发 bridge
    expect(report.steps[3]!.status).toBe('PASSED'); // assert signal 从缓存仍取到 1 事件
  });

  it('monitor teardown 兜底(Minor①):套件正常结束未 monitor_stop → 补发 monitor.stop', async () => {
    const stopCalls: string[] = [];
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.stop') { stopCalls.push(method); return { id: 8, result: { monitoring: false, samples: [], sample_count: 0 } }; }
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'sleep', ms: 100 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.summary.status).toBe('PASSED');
    expect(stopCalls).toContain('monitor.stop'); // teardown 兜底补发
    expect(report.teardown_warnings).toBeUndefined(); // 兜底成功不记警告
  });

  it('本套件重复 monitor_start → 第二个 ERROR(Minor②)', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'monitor_start', node_path: '/root/Q', properties: ['fps'] },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('ERROR');
    expect(report.steps[1]!.detail).toContain('已有活跃 monitor');
  });

  it('monitor_stop detail 带 sample_count(Minor③)', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.start') return { id: 7, result: { monitoring: true } };
      if (method === 'monitor.stop') return { id: 8, result: { monitoring: false, sample_count: 2, samples: [] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'monitor_start', node_path: '/root/P', properties: ['health'] },
        { type: 'monitor_stop' },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED');
    expect(report.steps[1]!.detail).toContain('2 sample');
  });
});

// ═══ Task 4 审查 Important 修复:空缓存 falsy 判据 + 套件外订阅拒绝 ═══

describe('qa runner: Task 4 审查 Important 修复(空缓存/套件外拒绝)', () => {
  it('Important①:watch_stop 0 事件空缓存 → signal 断言走缓存判 FAILED(actual=0),不误报 ERROR', async () => {
    let stopCount = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.start') return { id: 1, result: { watching: true } };
      if (method === 'watch.poll') return { id: 3, result: { watching: false, events: [], message: 'No active watch' } };
      if (method === 'watch.stop') {
        stopCount++;
        return { id: 2, result: { watching: false, events: [], event_count: 0 } }; // 0 事件 → 空缓存 []
      }
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'watch_start', node_path: '/root/B', signal_name: 'x' },
        { type: 'watch_stop' }, // 0 事件,缓存 = []
        { type: 'watch_stop' }, // 姊妹修复:空缓存 [] 非 null → 幂等 cached 分支,不误报 ERROR
        { type: 'assert', assert: 'signal', min_count: 1 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[1]!.status).toBe('PASSED');
    expect(report.steps[2]!.status).toBe('PASSED'); // 幂等 cached 分支(姊妹修复)
    expect(report.steps[2]!.detail).toContain('cached');
    expect(report.steps[3]!.status).toBe('FAILED'); // 非 ERROR:断言未满足而非基础设施失败
    expect(report.steps[3]!.mismatch?.count).toEqual({ expected: '[1, ∞]', actual: 0 });
    expect(stopCount).toBe(1); // 后续取数/幂等 stop 均走缓存,不重发 bridge
  });

  it('Important②:从未 watch_start 但 bridge 有套件外活跃 watch → 拒绝消费 ERROR(防假绿)', async () => {
    // 套件外订阅在跑(watching:true 且有事件)——修复前会消费它 → min_count 满足 → 假绿 PASSED
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'watch.poll') return { id: 2, result: { watching: true, events: [{ frame: 1, time: 0.1, args: [9] }], event_count: 1 } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'assert', assert: 'signal', min_count: 1 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('ERROR');
    expect(report.steps[0]!.detail).toContain('套件外');
  });

  it('Important②:从未 monitor_start 但 bridge 有套件外活跃 monitor → 拒绝消费 ERROR(防假绿)', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'monitor.poll') return { id: 9, result: { monitoring: true, sample_count: 2,
        samples: [
          { frame: 1, time: 0.1, values: { fps: 60 } },
          { frame: 2, time: 0.2, values: { fps: 60 } },
        ] } };
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'assert', assert: 'monitor', property: 'fps', min: 30 },
      ],
    });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('ERROR');
    expect(report.steps[0]!.detail).toContain('套件外');
  });
});

// ═══ PR-1a Task 5:errors baseline 按需采集 + errors 断言 ═══
// (brief 原文套件字面量 `as never as QaSuite` 绕过 parseQaSuite → 运行时无 options,
//  runner.ts:117 `o.auto_install_bridge` 即 TypeError——已适配本文件 suite() helper 惯例,断言逐字保留)

describe('qa runner: errors 断言(Task PR-1a)', () => {
  it('含 errors 断言的套件:setup 后采 baseline,期间零新错误 → PASSED', async () => {
    const calls: Array<{ m: string; p: unknown }> = [];
    vi.mocked(sendToBridge).mockImplementation(async (method: string, params: unknown) => {
      calls.push({ m: method, p: params });
      // next_seq=5 模拟游戏已有 5 条历史错误(baseline 锚点非 0,恒传 0 会把历史错误计入→假红)
      if (method === 'get_errors') return { id: 20, result: { errors: [], next_seq: 5 } };
      return { id: 5, result: {} };
    });
    const s = suite({ steps: [
      { type: 'assert', assert: 'errors' },
    ] });
    const report = await runQaSuite(s, 'D:/proj', makeCtx(), 'inline');
    expect(report.summary.status).toBe('PASSED');
    // baseline 采集 + 断言查询,两次 get_errors 都带 since_seq
    const ge = calls.filter(c => c.m === 'get_errors');
    expect(ge.length).toBe(2);
    // Minor④:e1 弱断言补强——首调用(baseline)since_seq=0;次调用(断言查询)
    // since_seq=首次返回的 next_seq(=5)。恒传 0 时历史错误计入 → 本用例假红,可抓锚点回归。
    expect((ge[0]!.p as { since_seq?: number }).since_seq).toBe(0);
    expect((ge[1]!.p as { since_seq?: number }).since_seq).toBe(5);
  });

  it('期间新增 2 条 error → FAILED,mismatch 带实际计数', async () => {
    let seq = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'get_errors') {
        if (seq++ === 0) return { id: 20, result: { errors: [], next_seq: 0 } };
        return { id: 21, result: { errors: [
          { seq: 1, kind: 'error', message: 'null instance', code: '', function: 'f', file: 'a.gd', line: 1 },
          { seq: 2, kind: 'script', message: 'script err', code: '', function: 'g', file: 'b.gd', line: 2 },
          { seq: 3, kind: 'warning', message: 'warn should be excluded', code: '', function: 'h', file: 'c.gd', line: 3 },
        ], next_seq: 3 } };
      }
      return { id: 5, result: {} };
    });
    const s = suite({ steps: [
      { type: 'assert', assert: 'errors' },
    ] });
    const report = await runQaSuite(s, 'D:/proj', makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('FAILED');
    expect(report.steps[0]!.mismatch?.new_errors).toEqual({ expected: '≤ 0', actual: 2 }); // warning 排除
  });

  it('kinds 含 warning 时 warning 计入', async () => {
    let seq = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'get_errors') {
        if (seq++ === 0) return { id: 20, result: { errors: [], next_seq: 0 } };
        return { id: 21, result: { errors: [{ seq: 1, kind: 'warning', message: 'w', code: '', function: '', file: '', line: 1 }], next_seq: 1 } };
      }
      return { id: 5, result: {} };
    });
    const s = suite({ steps: [
      { type: 'assert', assert: 'errors', kinds: ['error', 'warning'], max_count: 0 },
    ] });
    const report = await runQaSuite(s, 'D:/proj', makeCtx(), 'inline');
    expect(report.steps[0]!.status).toBe('FAILED');
  });

  it('baseline 采集失败(旧 bridge)→ 降级 warning + 断言 ERROR,不 failSetup', async () => {
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'get_errors') return { id: 22, error: { code: -32003, message: 'Error capture not initialized' } };
      return { id: 5, result: {} };
    });
    const s = suite({ steps: [
      { type: 'assert', assert: 'errors' },
    ] });
    const report = await runQaSuite(s, 'D:/proj', makeCtx(), 'inline');
    expect(report.setup_error).toBeUndefined();           // 不 failSetup
    expect(report.teardown_warnings?.some(w => w.includes('get_errors baseline'))).toBe(true);
    expect(report.steps[0]!.status).toBe('ERROR');
  });

  it('不含 errors 断言的套件:setup 不采 baseline(零多余 bridge 调用)', async () => {
    const calls: string[] = [];
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      calls.push(method);
      return { id: 5, result: {} };
    });
    const s = suite({ steps: [
      { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
    ] });
    await runQaSuite(s, 'D:/proj', makeCtx(), 'inline');
    expect(calls).not.toContain('get_errors');
  });
});

// ═══ PR-1a Task 7:screenshot_diff 断言步骤(真实现降级语义;传参断言见 qa-screenshot-diff-step.test.ts)═══

describe('qa runner: screenshot_diff 断言步骤(Task PR-1a)', () => {
  it('复用 runtime-assert 真实现:虚构项目走诚实降级,步骤 ERROR/FAILED 不抛', async () => {
    // defaultMocks 已路由 take_screenshot → success + user:// 路径;PROJECT 是虚构路径,
    // 真实 assertScreenshotDiff 解析 user:// 失败(或 project_path 白名单外)→ success:false
    // → 步骤 ERROR(诚实降级,不伪造判定)。传参正确性由 qa-screenshot-diff-step.test.ts 的
    // mock 断言覆盖(ESM 命名导出无法 vi.spyOn)。
    const s = suite({ steps: [
      { type: 'assert', assert: 'screenshot_diff', reference: 'D:/ref/x.png' },
    ] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline');
    expect(['ERROR', 'FAILED']).toContain(report.steps[0]!.status);
    expect(report.steps[0]!.detail).toContain('screenshot_diff');
  });
});

// ═══ PR-1b Task 2:取消信号与进度钩子 + CANCELLED 终态 ═══
// (brief 的 suiteOf helper 不存在于本文件,按现有 suite(overrides) 惯例适配——
//  options 覆盖即 overrides 的一等用法;mock 返回值带 id 符合 BridgeResponse 契约)

describe('qa runner: 取消信号与 CANCELLED 终态(PR-1b)', () => {
  it('第 2 步后取消:剩余步骤 SKIPPED(cancelled by user),summary CANCELLED,前 2 步状态保留', async () => {
    let stepsExecuted = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      if (method === 'send_key') stepsExecuted++;
      return { id: 5, result: {} };
    });
    const s = suite({
      steps: [
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
      ],
    });
    const ctl = { cancelRequested: () => stepsExecuted >= 2 };  // 第 3 步前生效
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline', ctl);
    expect(report.summary.status).toBe('CANCELLED');
    expect(report.steps[2]!.skip_reason).toBe('cancelled by user');
    expect(report.steps[0]!.status).toBe('PASSED');
    expect(report.steps[1]!.status).toBe('PASSED');
  });

  it('取消优先于 FAILED:取消前已有失败步骤,summary 仍 CANCELLED(半途报告不作基线)', async () => {
    let executed = 0;
    vi.mocked(sendToBridge).mockImplementation(async (method: string) => {
      executed++;
      if (method === 'get_node_properties') return { id: 1, result: { health: 50 } };
      return { id: 5, result: {} };
    });
    // continue_on_failure: true 让 FAILED 后继续到第 2 步,再在取消检查处终止——
    // 验证 cancelled 判定优先于 failed(取消的半途报告不作 FAILED 基线)
    const s = suite({
      options: { continue_on_failure: true },
      steps: [
        { type: 'assert', assert: 'node_state', path: '/root/P', expect: { health: 999 } },  // FAILED(50≠999)
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
      ],
    });
    const ctl = { cancelRequested: () => executed >= 1 };
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline', ctl);
    expect(report.summary.status).toBe('CANCELLED');
    expect(report.summary.failed).toBe(1);
  });

  it('onProgress 回调随步骤推进上报(与 ctx.progress 同点位)', async () => {
    vi.mocked(sendToBridge).mockResolvedValue({ id: 5, result: {} });
    const calls: string[] = [];
    const s = suite({
      steps: [
        { type: 'input', method: 'send_key', params: { key: 'ui_accept' } },
        { type: 'sleep', ms: 100 },
      ],
    });
    await runQaSuite(s, PROJECT, makeCtx(), 'inline', {
      cancelRequested: () => false,
      onProgress: (step, total, current) => calls.push(`${step}/${total}:${current}`),
    });
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('input');
  });

  it('runIdOverride:报告 run_id 用外部传入值(注册表 taskId 与报告一致)', async () => {
    vi.mocked(sendToBridge).mockResolvedValue({ id: 5, result: {} });
    const s = suite({ steps: [{ type: 'sleep', ms: 100 }] });
    const report = await runQaSuite(s, PROJECT, makeCtx(), 'inline', undefined, '20260817-120000-myid');
    expect(report.run_id).toBe('20260817-120000-myid');
  });

  it('renderMarkdown 显示 CANCELLED 结果行', () => {
    const md = renderMarkdown({
      version: 1,
      run_id: 'r',
      suite: { name: 's', project_path: 'p', started_at: '', spec_source: 'inline' },
      options: {},
      summary: { total: 1, passed: 0, failed: 0, errors: 0, skipped: 1, status: 'CANCELLED', duration_ms: 5 },
      steps: [],
    });
    expect(md).toContain('CANCELLED');
  });
});
