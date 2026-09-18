/**
 * 批 2 (2026-08-21) GD 对称性行为级 e2e:数值白名单假阳性回归 + mouse button 语义。
 * 复用 H1 input-seq-e2e 的 fixture 与 harness 模式(同 fixture 起一次游戏跑两用例)。
 *
 * freeze pending 守卫不在本文件:单连接 e2e 的 TS 侧 _sendLock 会把并发 freeze 排队到
 * 开窗结束之后,行为不可达(需双 peer)——由 gd-symmetry-contract.test.ts 契约级覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { parseGodotConfig } from '../src/helpers.js';
import * as ps from '../src/core/process-state.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const FIXTURE = resolve(__dirname, 'fixtures', 'input-seq-e2e');
const hasFixture = existsSync(resolve(FIXTURE, 'project.godot'));
const RUN = !!process.env.GODOT_MCP_E2E_L2;
if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found' : !hasFixture ? 'no fixture' : 'GODOT_MCP_E2E_L2 not set';
  console.log(`[e2e-gd-symmetry] skip: ${_reason}`);
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
  if (!result) return { text: 'null result', isError: true };
  if (!isToolResult(result)) return { text: `UNEXPECTED_RESULT: ${JSON.stringify(result).slice(0, 200)}`, isError: true };
  return { text: result.content.map(c => c.text).join('\n') ?? '', isError: result.isError === true };
}

describe.skipIf(!hasGodot || !hasFixture || !RUN)('批 2 GD 对称性 e2e (L2)', { timeout: 120_000, sequential: true }, () => {
  let projectGodotSnap = '';

  beforeAll(async () => {
    projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf8');
    try { rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true }); } catch { /* EPERM best-effort */ }
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
    if (!_registered) { registerAllModules(); _registered = true; }
    const install = await callTool({ action: 'game_bridge_install' });
    expect(install.isError, `install failed: ${install.text.slice(0, 200)}`).toBe(false);
    const runMod = getModuleForTool('runtime');
    const run = await runMod!.handleTool('runtime', {
      project_path: FIXTURE, action: 'run_project',
      wait_for_bridge: true, bridge_timeout: 30, timeout: 120,
    }, makeCtx());
    expect(run && isToolResult(run) && run.isError !== true, 'run_project failed').toBe(true);
  }, 200000);

  afterAll(() => {
    try { writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap, 'utf8'); } catch { /* best-effort */ }
    try { rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('审查G-1: step_until 数值属性 + String 条件值不再假阳性(predicate_met=false 帧耗尽)', { timeout: 30_000 }, async () => {
    // Main 是 Node2D,rotation 默认 0.0(纯 float,命中数值分支)。修复前 float("abc")=0 →
    // 0>=0 恒真 → 帧未跑即 predicate_met=true(假阳性);修复后数值分支白名单拒非数值
    // target → 耗尽 30 帧 false。注意 property 不支持 "position:x" 子字段语法。
    // wall_budget 20000(D1 清偿 2026-09-12):本地慢机(背景 Godot 进程抢资源)实测 ~417ms/帧,
    // 30 帧需 12.5s——原 5000 预算下 wall 先于帧耗尽,frames_elapsed=5~12 波动假失败。
    // 断言语义不变:String 拒斥 + 帧耗尽,只是给慢机足够时间预算。
    const r = await callTool({
      action: 'game_playtest', method: 'playtest.step_until',
      params: {
        conditions: [{ path: '/root/Main', property: 'rotation', op: '>=', value: 'abc' }],
        max_frames: 30, wall_budget_ms: 30000,
      },
      timeout: 40000,
    });
    expect(r.isError, `step_until errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { predicate_met?: boolean; frames_elapsed?: number };
    expect(parsed.predicate_met, 'String 条件值必须拒(白名单)而非按 0 比较').toBe(false);
    expect(parsed.frames_elapsed ?? 0, '应耗尽全部帧而非立即满足').toBeGreaterThanOrEqual(30);
  });

  it('审查GD-B1(全仓审查): 多条件 AND 语义——A 满足但 B 拒斥时 predicate_met=false 且帧耗尽', { timeout: 60_000 }, async () => {
    // 原 GD 完成判定嵌在 for cond 循环体内:首条件满足即 append 完成,后续条件未评估,
    // predicate_met=true 谎报全满足;且同 su_idx 双 append 致消费循环双 remove 越界。
    // 修复:判定移出循环——全部条件评估后才判定。A(数值 0>=0)立即满足、
    // B(String 'abc')白名单拒斥恒 false → AND 结果 false,应耗尽 30 帧。
    const r = await callTool({
      action: 'game_playtest', method: 'playtest.step_until',
      params: {
        conditions: [
          { path: '/root/Main', property: 'rotation', op: '>=', value: 0 },
          { path: '/root/Main', property: 'rotation', op: '>=', value: 'abc' },
        ],
        max_frames: 30, wall_budget_ms: 30000,
      },
      timeout: 40000,
    });
    expect(r.isError, `step_until errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { predicate_met?: boolean; frames_elapsed?: number; error?: string };
    expect(parsed.error ?? '').toBe('');
    expect(parsed.predicate_met, 'AND 语义:B 拒斥时不得因 A 满足谎报全满足').toBe(false);
    expect(parsed.frames_elapsed ?? 0, '帧耗尽而非首条件满足即停').toBeGreaterThanOrEqual(30);
  });

  it('审查G-1 正向回归: 数值条件值仍正常满足(白名单不误伤合法路径)', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_playtest', method: 'playtest.step_until',
      params: {
        conditions: [{ path: '/root/Main', property: 'rotation', op: '>=', value: 0 }],
        max_frames: 10, wall_budget_ms: 5000,
      },
      timeout: 15000,
    });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as { predicate_met?: boolean };
    expect(parsed.predicate_met, '数值 0.0>=0 应立即满足').toBe(true);
  });

  it('批5守恒O1: playtest.step 延迟响应——frames_stepped + frame_count + report 搭车求值', { timeout: 30_000 }, async () => {
    // O1 哨兵收敛(2026-09-18 批5)守恒网:playtest.step 是五条延迟通道之一
    // (哨兵字符串→pending 登记→N 帧后 _process 推送)。重构前后此用例语义必须不变:
    // frames_stepped=true、frame_count 正整数、report=[{path,property}] 求值随响应返回。
    // property 用 visible(name 在 BLOCKED_PROPERTIES,Node2D.visible 恒 true 断言最稳)。
    const r = await callTool({
      action: 'game_playtest', method: 'playtest.step',
      params: { frames: 5, report: [{ path: '/root/Main', property: 'visible' }] },
      timeout: 20000,
    });
    expect(r.isError, `playtest.step errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as {
      frames_stepped?: boolean; frame_count?: number;
      report?: Array<{ path: string; property: string; value?: unknown; error?: string }>;
    };
    expect(parsed.frames_stepped, '延迟通道完成后应 frames_stepped=true').toBe(true);
    expect(typeof parsed.frame_count, 'frame_count 应为数字').toBe('number');
    expect(parsed.frame_count ?? 0).toBeGreaterThan(0);
    expect(parsed.report, 'report 搭车求值应随延迟响应返回').toEqual([
      { path: '/root/Main', property: 'visible', value: true },
    ]);
  });

  it('审查G-2: send_mouse_click button:"left" 映射 MOUSE_BUTTON_LEFT(不再 int()=0 谎报)', { timeout: 20_000 }, async () => {
    const r = await callTool({
      action: 'game_input', method: 'send_mouse_click',
      params: { x: 0, y: 0, button: 'left', pressed: true },
    });
    expect(r.isError, `click errored: ${r.text.slice(0, 200)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { button?: number };
    expect(parsed.button, '"left" 应映射为 1(MOUSE_BUTTON_LEFT)而非 int("left")=0').toBe(1);
  });

  it('审查G-2 负向: button:"abc" 结构化拒绝(不再静默注入 MOUSE_BUTTON_NONE 假成功)', { timeout: 20_000 }, async () => {
    const r = await callTool({
      action: 'game_input', method: 'send_mouse_click',
      params: { x: 0, y: 0, button: 'abc' },
    });
    expect(r.isError, `button:"abc" 应被拒,实际: ${r.text.slice(0, 200)}`).toBe(true);
    expect(r.text).toContain('Invalid mouse button');
  });
});
