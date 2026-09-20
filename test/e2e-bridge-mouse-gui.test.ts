/**
 * C1 (2026-09-17) 反馈批次C e2e:复现/回归 09-10「send_mouse_click 对普通 Control.gui_input
 * (tap 判定链)不触发——Button 类 pressed 链正常」。
 *
 * 守卫:GODOT_MCP_E2E_L2=1 opt-in + GODOT_PATH + fixture 存在(对齐 e2e-bridge-input-sequence 模式;
 * run_project spawn 游戏进程,Windows 本机带窗口)。
 *
 * 断言分层:
 * - 引擎管线可见性:probe.engine_mouse_events 增长(parse_input_event 的事件到达 root 层 _input)
 * - Control.gui_input:press+release 两事件都送达,release 位移<8 判 tap → control_taps +1
 * - Button 对照:同链路 press+release → button_pressed +1
 * - 事件字段:control_last_event 带 device/global_position(修复后应与真实管线一致)
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
const FIXTURE = resolve(__dirname, 'fixtures', 'mouse-gui-e2e');
const hasFixture = existsSync(resolve(FIXTURE, 'project.godot'));
const RUN = !!process.env.GODOT_MCP_E2E_L2;

if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found'
    : !hasFixture ? 'no mouse-gui-e2e fixture'
    : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] C1 mouse-gui e2e skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
}

let _registered = false;

function ensureRegistered(): void {
  if (!_registered) {
    registerAllModules();
    _registered = true;
  }
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

async function callRuntime(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool('runtime');
  if (!mod) return { text: 'MODULE_NOT_FOUND: runtime', isError: true };
  const result = await mod.handleTool('runtime', { project_path: FIXTURE, ...args }, makeCtx());
  if (!result || !isToolResult(result)) return { text: 'run unexpected', isError: true };
  return { text: result.content.map(c => c.text).join('\n') ?? '', isError: result.isError === true };
}

async function callMethod(path: string, method: string): Promise<Record<string, unknown>> {
  const r = await callTool({
    action: 'game_write', method: 'call_method',
    params: { path, method, args: [] },
  });
  expect(r.isError, `call_method ${method}: ${r.text.slice(0, 300)}`).toBe(false);
  const parsed = JSON.parse(r.text) as { result?: Record<string, unknown> };
  return (parsed.result ?? parsed) as Record<string, unknown>;
}

async function probeState(): Promise<Record<string, unknown>> {
  return callMethod('/root/Main', 'get_probe_state');
}

async function clickAt(x: number, y: number): Promise<void> {
  const press = await callTool({ action: 'game_input', method: 'send_mouse_click', params: { x, y, button: 1, pressed: true } });
  expect(press.isError, `press: ${press.text.slice(0, 200)}`).toBe(false);
  await new Promise(r => setTimeout(r, 150));
  const release = await callTool({ action: 'game_input', method: 'send_mouse_click', params: { x, y, button: 1, pressed: false } });
  expect(release.isError, `release: ${release.text.slice(0, 200)}`).toBe(false);
  await new Promise(r => setTimeout(r, 150));
}

describe.skipIf(!hasGodot || !hasFixture || !RUN)('C1 send_mouse_click gui_input e2e (L2)', { timeout: 180_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch {
        // EPERM best-effort
      }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
      // call_method 只读白名单不含自定义探针方法,经文档支持的 EXTRA_METHODS env 放行
      // (run_project spawn 的游戏进程继承本进程 env;仅本测试进程内生效)
      process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = 'get_probe_state,get_ctl_center,get_btn_center';
      ensureRegistered();
      // N-4(2026-09-11 P1 审查): 清上次残留,防 install 幂等保留旧 bridge 测到旧行为
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
      const install = await callTool({ action: 'game_bridge_install' });
      if (install.isError) throw new Error(`game_bridge_install failed: ${install.text}`);
      const run = await callRuntime({ action: 'run_project', wait_for_bridge: true, bridge_timeout: 30, timeout: 120 });
      if (run.isError) throw new Error(`run_project failed: ${run.text}`);
    } catch (e) {
      _initError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[skip] C1 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
    }
  }, 200000);

  afterAll(async () => {
    // 清理本文件注入的 env(防同 worker 后续 bridge 测试继承 EXTRA_METHODS)
    delete process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS;
    try {
      await callRuntime({ action: 'stop_project' });
    } catch {
      // best-effort
    }
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

  it('send_mouse_click press+release 触发普通 Control.gui_input(tap 判定链)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const base = await probeState();
    const ctlCenter = await callMethod('/root/Main', 'get_ctl_center');
    const cx = Number(ctlCenter.x);
    const cy = Number(ctlCenter.y);
    process.stderr.write(`[C1] ctl center=(${cx},${cy}) base=${JSON.stringify(base)}\n`);

    await clickAt(cx, cy);

    const after = await probeState();
    process.stderr.write(`[C1] after control click: ${JSON.stringify(after)}\n`);

    // 引擎管线:事件应到达 root 层 _input(press+release 两个)
    expect(Number(after.engine_mouse_events)).toBeGreaterThanOrEqual(Number(base.engine_mouse_events) + 2);
    // Control.gui_input:press+release 都应送达
    expect(Number(after.control_gui_count)).toBeGreaterThanOrEqual(Number(base.control_gui_count) + 2);
    // 复刻 CardGame2 tap 判定:同点位 press→release 位移<8 → tap +1
    expect(Number(after.control_taps)).toBeGreaterThanOrEqual(Number(base.control_taps) + 1);
  });

  it('send_mouse_click press+release 触发 Button.pressed(对照组)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const base = await probeState();
    const btnCenter = await callMethod('/root/Main', 'get_btn_center');
    const bx = Number(btnCenter.x);
    const by = Number(btnCenter.y);

    await clickAt(bx, by);

    const after = await probeState();
    process.stderr.write(`[C1] after button click: ${JSON.stringify(after)}\n`);

    expect(Number(after.engine_mouse_events)).toBeGreaterThanOrEqual(Number(base.engine_mouse_events) + 2);
    expect(Number(after.button_gui_count)).toBeGreaterThanOrEqual(Number(base.button_gui_count) + 2);
    expect(Number(after.button_press_count)).toBeGreaterThanOrEqual(Number(base.button_press_count) + 1);
  });

  it('注入事件字段与真实管线一致(device=0 非默认 -1,global_position 落位)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const base = await probeState();
    const ctlCenter = await callMethod('/root/Main', 'get_ctl_center');

    await callTool({ action: 'game_input', method: 'send_mouse_click', params: { x: Number(ctlCenter.x), y: Number(ctlCenter.y), button: 1, pressed: true } });
    await new Promise(r => setTimeout(r, 150));

    const after = await probeState();
    const last = after.control_last_event as Record<string, unknown> | undefined;
    process.stderr.write(`[C1] last event on control: ${JSON.stringify(last)}\n`);
    expect(last).toBeDefined();
    if (!last) return;
    // device:真实鼠标事件 device=0;注入事件即使不显式设置,引擎派发链也规范化为 0
    // (实测 4.6.3)。显式断言锚定该行为——未来引擎若改规范化语义,此处红。
    expect(Number(last.device)).toBe(0);
    // global_position 保持注入的窗口全局坐标;position 被引擎 make_input_local 局部化
    // (Control(100,100)+size 200 → 中心(200,200) 全局,局部(100,100))
    expect(last.global_position).toEqual([Number(ctlCenter.x), Number(ctlCenter.y)]);
    expect(last.position).toEqual([100, 100]);
  });

  // D5 (2026-09-17 反馈批次D, 批次C审查 Nit3): touch/drag/key 注入链 device=0 对称
  // 收口的行为级锚定——_input 探针按 device 值分布计数,注入事件须落 device=0 桶。
  it('D5: send_touch/send_drag/send_key 注入事件的 device=0(probe 设备分布断言)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const base = await probeState();

    const touch = await callTool({ action: 'game_input', method: 'send_touch', params: { x: 50, y: 50, pressed: true, index: 0 } });
    expect(touch.isError, `sendTouch: ${touch.text.slice(0, 200)}`).toBe(false);
    const drag = await callTool({ action: 'game_input', method: 'send_drag', params: { x: 60, y: 60, index: 0, relative: [10, 10] } });
    expect(drag.isError, `sendDrag: ${drag.text.slice(0, 200)}`).toBe(false);
    const key = await callTool({ action: 'game_input', method: 'send_key', params: { key: 'space', pressed: true } });
    expect(key.isError, `sendKeys: ${key.text.slice(0, 200)}`).toBe(false);
    await new Promise(r => setTimeout(r, 300));

    const after = await probeState();
    process.stderr.write(`[D5] touch/key probe: ${JSON.stringify(after)}\n`);

    // touch+drag 两个事件都进管线,且全部落在 device=0 桶(无 -1/其他设备桶出现)
    expect(Number(after.engine_touch_events)).toBeGreaterThanOrEqual(Number(base.engine_touch_events) + 2);
    const touchCounts = (after.touch_device_counts ?? {}) as Record<string, number>;
    const touchZero = Number(touchCounts['0'] ?? 0);
    expect(touchZero, `touch/drag 事件须 device=0: ${JSON.stringify(touchCounts)}`).toBeGreaterThanOrEqual(Number((base.touch_device_counts as Record<string, number> | undefined)?.['0'] ?? 0) + 2);
    expect(touchCounts['-1'], '不得出现 device=-1(默认未规范化)桶').toBeUndefined();

    // key 事件同款 device=0
    expect(Number(after.engine_key_events)).toBeGreaterThanOrEqual(Number(base.engine_key_events) + 1);
    const keyCounts = (after.key_device_counts ?? {}) as Record<string, number>;
    expect(Number(keyCounts['0'] ?? 0), `key 事件须 device=0: ${JSON.stringify(keyCounts)}`).toBeGreaterThanOrEqual(Number((base.key_device_counts as Record<string, number> | undefined)?.['0'] ?? 0) + 1);
    expect(keyCounts['-1'], '不得出现 device=-1 桶').toBeUndefined();
  });

  // D2 (2026-09-17 反馈批次D, fr2 2026-09-02 反馈): find_nodes 对 CanvasLayer(非
  // CanvasItem 节点)盲区核实——fixture _ready 动态挂 MapPanel(CanvasLayer, layer=12,
  // 复刻反馈场景)。当前版本 _traverse_tree 全 Node 递归应无盲区;本用例即定谳证据 +
  // 防回归锚定(未来若有人给遍历加 CanvasItem 过滤,此处红)。
  it('D2: find_nodes 能搜到 CanvasLayer 节点(MapPanel,非 CanvasItem 无盲区)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const r = await callTool({ action: 'game_query', method: 'find_nodes', params: { pattern: '*Map*' } });
    expect(r.isError, `findNodes: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { nodes?: Array<{ name?: string; type?: string; path?: string }>; count?: number };
    process.stderr.write(`[D2] find_nodes *Map*: ${JSON.stringify(parsed)}\n`);

    const map = parsed.nodes?.find(n => n.name === 'MapPanel');
    expect(map, 'MapPanel(CanvasLayer)须出现在 find_nodes 结果——非 CanvasItem 无盲区').toBeDefined();
    expect(map?.type).toBe('CanvasLayer');
    expect(map?.path).toBe('/root/Main/MapPanel');
    expect(Number(parsed.count)).toBeGreaterThanOrEqual(1);

    // 对照:type 过滤直接按类名也应命中(CanvasLayer is_class 匹配)
    const byType = await callTool({ action: 'game_query', method: 'find_nodes', params: { type: 'CanvasLayer' } });
    expect(byType.isError).toBe(false);
    const parsedType = JSON.parse(byType.text) as { nodes?: Array<{ name?: string }> };
    expect(parsedType.nodes?.some(n => n.name === 'MapPanel'), 'type=CanvasLayer 也须命中').toBe(true);
  });
});

describe.skipIf(!hasGodot || !hasFixture || !RUN)('C2 headless spawn 输入派发定谳 (L2)', { timeout: 180_000, sequential: true }, () => {
  // 09-12 反馈定谳(2026-09-17 真机,结论反转):--headless 进程下 Input.parse_input_event
  // 正常派发(GUI 链全通:engine_mouse_events/control_gui_count/control_taps 全增长)——
  // 反馈「headless 整链不派发」上游不可复现。首轮「不派发」实测系测试取层错误致 x=null
  // → GD float(null) SCRIPT ERROR → handler 崩溃事件从未构造(连带挖出 _cmd_send_mouse_click
  // x/y 裸 float() 的 I-C 漏网,本批已收口 _num 守卫)。本 describe 手动起真 headless 进程
  // 锚定「headless 派发正常」,防引擎未来行为回归。
  let projectGodotSnap = '';

  beforeAll(() => {
    projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
    process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = 'get_probe_state,get_ctl_center,get_btn_center';
  });

  afterAll(() => {
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
    delete process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS;
  });

  it('--headless 进程下 GUI 输入管线派发定谳(engine_mouse_events/control_gui_count 实测)', async () => {
    const { spawn: nodeSpawn } = await import('child_process');
    const { sendToBridge, setBridgeProjectDir } = await import('../src/core/bridge-client.js');

    ensureRegistered();
    // 装 bridge(独立于 describe1 的会话,其 afterAll 已清理)
    rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
    const install = await callTool({ action: 'game_bridge_install' });
    expect(install.isError, `install: ${install.text.slice(0, 200)}`).toBe(false);

    const proc = nodeSpawn(GODOT_PATH, ['--headless', '--path', FIXTURE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } as Record<string, string>,
    });
    const stderrLines: string[] = [];
    proc.stderr?.on('data', (d: Buffer) => stderrLines.push(d.toString()));
    proc.stdout?.on('data', (d: Buffer) => stderrLines.push(d.toString()));

    try {
      setBridgeProjectDir(FIXTURE);
      // 等 bridge 就绪(轮询 ping,20s 上限)
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const pong = await sendToBridge('ping', {}, 2000);
          ready = !!pong && !('error' in (pong as Record<string, unknown>));
        } catch {
          // 未就绪,继续轮询
        }
      }
      expect(ready, `bridge 未就绪。headless 输出:\n${stderrLines.slice(-20).join('')}`).toBe(true);

      // call_method 原始响应两层 result:{result:{<函数返回值>},undoable:...}
      // (describe1 走 TS game 工具已 unwrap 一层,此处直连 sendToBridge 需手动取两层)
      const unwrapCallMethod = (r: Record<string, unknown>): Record<string, unknown> =>
        ((r.result as Record<string, unknown>).result) as Record<string, unknown>;
      const readProbe = async (): Promise<Record<string, unknown>> => {
        const r = await sendToBridge('call_method', { path: '/root/Main', method: 'get_probe_state', args: [] }, 10000);
        const rr = r as Record<string, unknown>;
        const inner = rr.result as Record<string, unknown> | undefined;
        expect(inner?.error, `call_method error: ${JSON.stringify(rr).slice(0, 300)}`).toBeUndefined();
        return unwrapCallMethod(rr);
      };
      const callProbe = async (method: string): Promise<Record<string, unknown>> => {
        const r = await sendToBridge('call_method', { path: '/root/Main', method, args: [] }, 10000);
        return unwrapCallMethod(r as Record<string, unknown>);
      };
      const ctlCenter = await callProbe('get_ctl_center');

      const base = await readProbe();
      const clickResp = await sendToBridge('send_mouse_click', { x: Number(ctlCenter.x), y: Number(ctlCenter.y), button: 1, pressed: true }, 10000) as Record<string, unknown>;
      await new Promise(r => setTimeout(r, 200));
      await sendToBridge('send_mouse_click', { x: Number(ctlCenter.x), y: Number(ctlCenter.y), button: 1, pressed: false }, 10000);
      await new Promise(r => setTimeout(r, 200));
      const after = await readProbe();

      process.stderr.write(`[C2] headless base=${JSON.stringify(base)}\n[C2] headless after=${JSON.stringify(after)}\n[C2] clickResp=${JSON.stringify(clickResp)}\n[C2] headless proc output tail:\n${stderrLines.slice(-30).join('')}\n`);

      // 定谳断言(2026-09-17 实测 4.6.3):headless 下 GUI 输入管线正常派发——
      // _input 探针 +2(press/release)、Control.gui_input +2、tap 判定链 +1。
      // 若未来引擎 headless 行为变化(不再派发),此处红,须重新评估文档标注。
      expect(Number(after.engine_mouse_events)).toBeGreaterThanOrEqual(Number(base.engine_mouse_events) + 2);
      expect(Number(after.control_gui_count)).toBeGreaterThanOrEqual(Number(base.control_gui_count) + 2);
      expect(Number(after.control_taps)).toBeGreaterThanOrEqual(Number(base.control_taps) + 1);

      // 注入响应无 warnings(headless 派发正常,不应有误导性告警)
      const click = (clickResp.result as Record<string, unknown>) ?? clickResp;
      expect(click.success, `clickResp: ${JSON.stringify(clickResp)}`).toBe(true);
      expect(click.warnings, `不应有 warnings: ${JSON.stringify(clickResp)}`).toBeUndefined();
    } finally {
      proc.kill();
      await new Promise(r => setTimeout(r, 500));
    }
  });
});
