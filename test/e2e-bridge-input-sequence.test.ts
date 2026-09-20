/**
 * H1 (2026-08-20) send_input_sequence e2e:帧对齐注入实测(fixture test/fixtures/input-seq-e2e)。
 *
 * 守卫:GODOT_MCP_E2E_L2=1 opt-in + GODOT_PATH + fixture 存在(对齐 e2e-bridge-get-node-layout 模式;
 * headless spawn 游戏进程,不需 GUI editor)。
 *
 * 断言分层:
 * - 响应契约:applied_count/total_events/refrozen/wall_timeout
 * - 注入可见性:probe.first_seen_frame 从 -1 变有效帧号(action 被 _physics_process 读到)
 * - release 语义:at_frame=10 的 release 后 Input.is_action_pressed("jump")==false
 * - 负向:at_frame=0 / unknown action 预检拒绝
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { parseGodotConfig } from '../src/core/config-parser.js';
import * as ps from '../src/core/process-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const FIXTURE = resolve(__dirname, 'fixtures', 'input-seq-e2e');
const hasFixture = existsSync(resolve(FIXTURE, 'project.godot'));
const RUN = !!process.env.GODOT_MCP_E2E_L2;

if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found'
    : !hasFixture ? 'no input-seq-e2e fixture'
    : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] H1 input_sequence e2e skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
}

let _registered = false;

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

function isToolResult(val: unknown): val is ToolResult {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.content) && obj.content.every(
    (c: unknown) => c && typeof c === 'object' && 'type' in (c as Record<string, unknown>) && 'text' in (c as Record<string, unknown>),
  );
}

async function callTool(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool('game');
  if (!mod) return { text: 'MODULE_NOT_FOUND: game', isError: true };
  const result = await mod.handleTool('game', { project_path: FIXTURE, ...args }, makeCtx());
  if (!result) return { text: 'null result (action 未匹配任何 case — 疑似假绿)', isError: true };
  if (!isToolResult(result)) return { text: `UNEXPECTED_RESULT: ${JSON.stringify(result).slice(0, 200)}`, isError: true };
  return { text: result.content.map(c => c.text).join('\n') ?? '', isError: result.isError === true };
}

async function probeState(): Promise<Record<string, unknown>> {
  const r = await callTool({
    action: 'game_write', method: 'call_method',
    params: { path: '/root/Main', method: 'get_probe_state', args: [] },
  });
  if (r.isError) process.stderr.write(`[probeState] call_method error: ${r.text.slice(0, 400)}\n`);
  expect(r.isError).toBe(false);
  const parsed = JSON.parse(r.text) as { result?: Record<string, unknown> };
  // game_write call_method 返回 {result: {...}} 或直接 dict,兼容两层
  return (parsed.result ?? parsed) as Record<string, unknown>;
}

async function sendSeq(params: Record<string, unknown>): Promise<{ r: Record<string, unknown>; isError: boolean }> {
  const r = await callTool({ action: 'game_input', method: 'send_input_sequence', params });
  if (r.isError) return { r: { raw: r.text }, isError: true };
  return { r: JSON.parse(r.text) as Record<string, unknown>, isError: false };
}

describe.skipIf(!hasGodot || !hasFixture || !RUN)('H1 send_input_sequence e2e (L2)', { timeout: 180_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch {
        // EPERM best-effort(对齐 e2e-bridge-get-node-layout 模式)
      }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
      // call_method 只读白名单不含自定义探针方法,经文档支持的 EXTRA_METHODS env 放行
      // (run_project spawn 的游戏进程继承本进程 env;仅本测试进程内生效)
      process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = 'get_probe_state';
      if (!_registered) {
        registerAllModules();
        _registered = true;
      }
      // N-4(2026-09-11 P1 审查): 清上次运行的 bridge 残留——afterEach rmSync 遇 Windows EPERM
      // 可能留旧副本,而 install 幂等逻辑对"内容 differs"选择保留不覆盖,e2e 会测到旧 bridge。
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
      const install = await callTool({ action: 'game_bridge_install' });
      if (install.isError) throw new Error(`game_bridge_install failed: ${install.text}`);
      const run = await callToolRealRun();
      if (run.isError) throw new Error(`run_project failed: ${run.text}`);
    } catch (e) {
      _initError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[skip] H1 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
    }
  }, 200000);

  async function callToolRealRun(): Promise<{ text: string; isError: boolean }> {
    const mod = getModuleForTool('runtime');
    if (!mod) return { text: 'MODULE_NOT_FOUND: runtime', isError: true };
    const result = await mod.handleTool('runtime', {
      project_path: FIXTURE, action: 'run_project',
      wait_for_bridge: true, bridge_timeout: 30, timeout: 120,
    }, makeCtx());
    if (!result || !isToolResult(result)) return { text: 'run unexpected', isError: true };
    return { text: result.content.map(c => c.text).join('\n') ?? '', isError: result.isError === true };
  }

  afterAll(async () => {
    // 清理本文件注入的 env(防 T11 同款测试污染:同 worker 后续 bridge 测试继承 EXTRA_METHODS)
    delete process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS;
    try {
      const mod = getModuleForTool('runtime');
      if (mod) await mod.handleTool('runtime', { project_path: FIXTURE, action: 'stop_project' }, makeCtx());
    } catch {
      // best-effort
    }
    // 恢复 project.godot 快照(game_bridge_install 写了 autoload 段)
    try {
      writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap);
      rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
    } catch {
      // best-effort
    }
  });

  it('freeze 窗口内时间线:at_frame 注入被游戏读到 + release 生效 + refreeze', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const freeze = await callTool({ action: 'game_playtest', method: 'playtest.freeze', params: {} });
    expect(freeze.isError).toBe(false);

    const base = await probeState();
    expect(base.first_seen_frame).toBe(-1); // 基线:从未读到 jump

    const { r, isError } = await sendSeq({
      timeline: [
        { at_frame: 5, type: 'action', name: 'jump', pressed: true },
        { at_frame: 10, type: 'action', name: 'jump', pressed: false },
      ],
      settle_frames: 5,
    });
    expect(isError).toBe(false);
    expect(r.success).toBe(true);
    expect(r.applied_count).toBe(2);
    expect(r.total_events).toBe(2);
    expect(r.wall_timeout).toBe(false);
    expect(r.refrozen).toBe(true); // frozen 状态发起 → 完成 refreeze

    const after = await probeState();
    expect(Number(after.first_seen_frame)).toBeGreaterThan(-1); // press 被读到
    expect(after.first_seen_action).toBe('jump');
    expect(after.action_pressed).toBe(false); // at_frame=10 release 生效(refreeze 冻结下 Input 状态可查)
    expect(Number(after.frames_run)).toBeGreaterThan(Number(base.frames_run)); // 开窗期间游戏推进了帧

    const unfreeze = await callTool({ action: 'game_playtest', method: 'playtest.unfreeze', params: {} });
    expect(unfreeze.isError).toBe(false);
  });

  it('非 frozen 直播时间线(不要求 freeze,refrozen=false)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, isError } = await sendSeq({
      timeline: [{ at_frame: 3, type: 'key', key: 'space', pressed: true }],
      settle_frames: 2,
      wall_budget_ms: 10000,
    });
    expect(isError).toBe(false);
    expect(r.success).toBe(true);
    expect(r.applied_count).toBe(1);
    expect(r.refrozen).toBe(false);
  });

  it('wall_timeout 正向场景:超长 timeline + 1s wall 截断如实上报(审查 N-3)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // at_frame=600 @60fps≈10s,wall_budget=1s(clamp 下限)必截断;
    // 截断响应是 result 层 success=false + wall_timeout=true,顶层无 JSON-RPC error
    const { r, isError } = await sendSeq({
      timeline: [{ at_frame: 600, type: 'action', name: 'jump', pressed: true }],
      settle_frames: 0,
      wall_budget_ms: 1000,
    });
    expect(isError).toBe(false); // 顶层无 error(延迟通道不走 error promote)
    expect(r.success).toBe(false);
    expect(r.wall_timeout).toBe(true);
    expect(Number(r.frames_elapsed)).toBeGreaterThan(0); // 确实推进过帧后才截断
    expect(Number(r.frames_elapsed)).toBeLessThan(600); // 且没跑完
    expect(Number(r.applied_count)).toBe(0); // at_frame=600 未到,0 注入
    expect(Number(r.total_events)).toBe(1);
  });

  it('负向:at_frame=0 预检拒绝(登记帧不计数,合法下限 1)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r = await callTool({
      action: 'game_input', method: 'send_input_sequence',
      params: { timeline: [{ at_frame: 0, type: 'action', name: 'jump', pressed: true }] },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('at_frame must be 1-600');
  });

  it('负向:unknown action 深预检拒绝(InputMap 存在性)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r = await callTool({
      action: 'game_input', method: 'send_input_sequence',
      params: { timeline: [{ at_frame: 2, type: 'action', name: 'definitely_not_mapped', pressed: true }] },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown action');
  });

  it('负向:unknown key 深预检拒绝', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r = await callTool({
      action: 'game_input', method: 'send_input_sequence',
      params: { timeline: [{ at_frame: 2, type: 'key', key: 'not_a_key', pressed: true }] },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown key');
  });
});
