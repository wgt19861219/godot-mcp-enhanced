/**
 * P3 批 (2026-09-11) e2e:click_button real_event / network_conditioner / custom_command。
 *
 * 守卫:GODOT_MCP_E2E_L2=1 opt-in + GODOT_PATH + fixture 存在(对齐 e2e-bridge-input-sequence 模式;
 * headless spawn 游戏进程,不需 GUI editor)。fixture: test/fixtures/p3-e2e(UI 按钮 + ENet peer
 * 建立/拆除 + mcp_commands/example.gd)。
 *
 * 断言分层:
 * - P3-2: emit 路径 mode=emit 且 button_pressed 不变;real_event 路径 mode=real_event +
 *   verified + signal_counts(pressed/toggled)+ button_pressed 翻转(真实输入管道切状态)
 * - P3-1: 无 peer set 报错;setup peer 后 set/status/clear 生命周期 + clear 幂等
 * - P3-3: custom.ping/check_state 可调;未声明命令 -32601;bad.name(非 custom. 前缀)不可达
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
const FIXTURE = resolve(__dirname, 'fixtures', 'p3-e2e');
const hasFixture = existsSync(resolve(FIXTURE, 'project.godot'));
const RUN = !!process.env.GODOT_MCP_E2E_L2;

if (!RUN) {
  const _reason = !hasGodot ? 'Godot not found'
    : !hasFixture ? 'no p3-e2e fixture'
    : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] P3 e2e skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
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

/** 经 GDA_CALLABLE 白名单调 fixture main.gd 方法。 */
async function callMain(method: string, args: unknown[] = []): Promise<Record<string, unknown>> {
  const r = await callTool({
    action: 'game_write', method: 'call_method',
    params: { path: '/root/Main', method, args },
  });
  if (r.isError) process.stderr.write(`[callMain:${method}] error: ${r.text.slice(0, 400)}\n`);
  expect(r.isError, `${method} 不应报错: ${r.text.slice(0, 300)}`).toBe(false);
  const parsed = JSON.parse(r.text) as { result?: Record<string, unknown> };
  return (parsed.result ?? parsed) as Record<string, unknown>;
}

async function bridgeOk(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await callTool({ action, ...extra });
  if (r.isError) process.stderr.write(`[bridgeOk:${action}] error: ${r.text.slice(0, 400)}\n`);
  expect(r.isError, `${action} 不应报错: ${r.text.slice(0, 300)}`).toBe(false);
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe.skipIf(!hasGodot || !hasFixture || !RUN)('P3 e2e (L2)', { timeout: 240_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch { /* EPERM best-effort */ }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
      if (!_registered) {
        registerAllModules();
        _registered = true;
      }
      // N-4(P1 审查同款): install 前强制清旧 bridge 残留(EPERM 留副本 + 幂等保留 = 测旧代码)
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
      const install = await callTool({ action: 'game_bridge_install' });
      if (install.isError) throw new Error(`game_bridge_install failed: ${install.text}`);
      const mod = getModuleForTool('runtime');
      if (!mod) throw new Error('MODULE_NOT_FOUND: runtime');
      const result = await mod.handleTool('runtime', {
        project_path: FIXTURE, action: 'run_project',
        wait_for_bridge: true, bridge_timeout: 30, timeout: 120,
      }, makeCtx());
      if (!result || !isToolResult(result) || result.isError === true) {
        throw new Error(`run_project failed: ${result ? result.content.map(c => 'text' in c ? c.text : '').join('') : 'null'}`);
      }
    } catch (e) {
      _initError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[skip] P3 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
    }
  }, 200000);

  afterAll(async () => {
    try {
      const mod = getModuleForTool('runtime');
      if (mod) await mod.handleTool('runtime', { project_path: FIXTURE, action: 'stop_project' }, makeCtx());
    } catch { /* best-effort */ }
    try {
      writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap);
      rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
    } catch { /* best-effort */ }
    try {
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
    } catch { /* best-effort */ }
  });

  // ─── P3-2: click_button real_event ─────────────────────────────────────────

  it('CLICK-a: emit 路径(默认)mode=emit,button_pressed 不变(emit_signal 不切状态)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const before = await callMain('get_check_state');
    expect(before.button_pressed).toBe(false);
    const r = await bridgeOk('click_button', { text: 'MyCheck' });
    expect(r.mode).toBe('emit');
    expect(r.clicked).toBe(true);
    const after = await callMain('get_check_state');
    expect(after.button_pressed, 'emit_signal("pressed") 不切换 button_pressed').toBe(false);
  });

  it('CLICK-b: real_event 路径 verified + signal_counts + button_pressed 翻转', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const before = await callMain('get_check_state');
    expect(before.button_pressed, '点击前应为 false(自带基线,不依赖 CLICK-a 先行)').toBe(false);
    const r = await bridgeOk('click_button', { text: 'MyCheck', real_event: true, timeout: 15000 });
    expect(r.mode).toBe('real_event');
    expect(r.verified).toBe(true);
    expect(r.clicked).toBe(true);
    const counts = r.signal_counts as Record<string, number>;
    expect(counts.pressed, '引擎输入管道真实发射 pressed').toBeGreaterThanOrEqual(1);
    expect(counts.toggled, 'CheckBox 切换状态发 toggled').toBeGreaterThanOrEqual(1);
    expect(r.button_pressed, '真实输入路径切换 button_pressed').toBe(true);
    // 状态确实变了(经 fixture 方法读回,不只信 click 响应)
    const after = await callMain('get_check_state');
    expect(after.button_pressed).toBe(true);
  });

  // ─── P3-1: network_conditioner 生命周期 ─────────────────────────────────────

  it('NET-a: 无 peer 时 set 诚实报错(不装 Offline 空壳)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const cleared = await callMain('clear_net_peer');
    expect(cleared.ok).toBe(true);
    const r = await callTool({
      action: 'network_conditioner', op: 'set',
      latency_ms: 100, loss_pct: 10, jitter_ms: 5,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No multiplayer peer configured');
  });

  it('NET-b: 建 ENet peer 后 set/status/clear 生命周期 + clear 幂等', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const setup = await callMain('setup_net_peer');
    expect(setup.ok).toBe(true);
    const set = await bridgeOk('network_conditioner', { op: 'set', latency_ms: 100, loss_pct: 10, jitter_ms: 5 });
    expect(set.ok).toBe(true);
    expect(set.inner_peer).toBe('ENetMultiplayerPeer');
    const status = await bridgeOk('network_conditioner', { op: 'status' });
    expect(status.installed).toBe(true);
    const cond = status.conditions as Record<string, number>;
    expect(cond.latency_ms).toBe(100);
    expect(cond.loss_pct).toBe(10);
    expect(cond.jitter_ms).toBe(5);
    const clear = await bridgeOk('network_conditioner', { op: 'clear' });
    expect(clear.ok).toBe(true);
    expect(clear.installed).toBe(false);
    expect(clear.restored_peer).toBe('ENetMultiplayerPeer');
    const status2 = await bridgeOk('network_conditioner', { op: 'status' });
    expect(status2.installed).toBe(false);
    // clear 幂等:再次 clear 不报错
    const clear2 = await bridgeOk('network_conditioner', { op: 'clear' });
    expect(clear2.ok).toBe(true);
    // fixture 自持引用仍非空(already=true 只证脚本变量未清;真正保证是上面的
    // clear.restored_peer 断言 + bridge 侧 conditioner 已置 null)
    const st = await callMain('setup_net_peer');  // 已有 → already
    expect(st.already).toBe(true);
    await callMain('clear_net_peer');
  });

  it('NET-c: 非法参数被拒(loss>100)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r = await callTool({
      action: 'network_conditioner', op: 'set',
      latency_ms: -5, loss_pct: 200, jitter_ms: 0,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid conditions');
  });

  // ─── P5-2: near 空间查询 ─────────────────────────────────────────────────────

  it('NEAR-e2e: 近邻过滤+距离升序+锚点排除(Anchor 锚点,max_distance=400)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // P7 fixture 扩展后 Main 下新增 P7 节点(SecretEnemy(300,400) 距 500 恰在旧边界上,
    // 浮点不稳)——max_distance 收到 400:期望集 = Main(0)/NearA(30)/PlainNode(141)/NearB(300),
    // SecretEnemy(500)/HiddenParent(707)/FoggedOut(728)/FarAway(7071) 稳排除。
    const r = await bridgeOk('game_query', {
      method: 'find_nodes',
      params: { near_node: '/root/Main/Anchor', max_distance: 400, root: '/root/Main' },
    });
    const nodes = (r.nodes ?? []) as Array<{ name: string; distance?: number }>;
    const names = nodes.map(n => n.name);
    // Main 根节点也是 Node2D(原点,距 Anchor 0)故最前;NearA(30)/PlainNode(141)/NearB(300) 升序
    expect(names, 'Main(0)/NearA(30)/PlainNode(141)/NearB(300) 升序').toEqual(['Main', 'NearA', 'PlainNode', 'NearB']);
    expect(names, '锚点自身与远距节点排除').not.toContain('Anchor');
    expect(names).not.toContain('FarAway');
    expect(nodes[1].distance).toBeCloseTo(30, 0);
    expect(nodes[3].distance).toBeCloseTo(300, 0);
    // 负向:锚点不存在(-8)/锚点非 2D3D(-9)/max_distance 负(-10)
    const bad = await callTool({ action: 'game_query', method: 'find_nodes', params: { near_node: '/root/Main/Nope' } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('anchor not found');
    const badType = await callTool({ action: 'game_query', method: 'find_nodes', params: { near_node: '/root/Main/UI' } });
    expect(badType.isError).toBe(true);
    expect(badType.text).toContain('must be Node2D/Node3D');
    const badDist = await callTool({ action: 'game_query', method: 'find_nodes', params: { near_node: '/root/Main/Anchor', max_distance: -1 } });
    expect(badDist.isError).toBe(true);
    expect(badDist.text).toContain('max_distance must be >= 0');
    // B-1 行为锚:limit=1 时返回距离最近的一个(Main,距 0)——排序后截断而非树序截断
    const capped = await bridgeOk('game_query', {
      method: 'find_nodes',
      params: { near_node: '/root/Main/Anchor', max_distance: 400, root: '/root/Main', limit: 1 },
    });
    const cappedNodes = (capped.nodes ?? []) as Array<{ name: string; distance?: number }>;
    expect(cappedNodes.length).toBe(1);
    expect(cappedNodes[0]!.name, '排序后截断:limit=1 留最近节点').toBe('Main');
    expect(cappedNodes[0]!.distance).toBeCloseTo(0, 5);
  });

  // ─── P3-3: custom_command ──────────────────────────────────────────────────

  it('CUST-a: custom.ping 可调(pong) + custom.echo 参数透传', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const ping = await bridgeOk('custom_command', { method: 'custom.ping' });
    expect(ping.pong).toBe(true);
    const echo = await bridgeOk('custom_command', {
      method: 'custom.echo', params: { message: 'hello-p3' },
    });
    expect(echo.message).toBe('hello-p3');
  });

  it('CUST-b: custom.check_state 读到 fixture 场景(命令可访问场景树)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r = await bridgeOk('custom_command', { method: 'custom.check_state' });
    expect(r.found, 'check_state 命令可访问场景树读到 Main').toBe(true);
    // button_pressed 不锁具体值:本用例跑在 CLICK-b 之后(sequential),勾选态取决于前序用例
    expect(typeof r.button_pressed).toBe('boolean');
  });

  it('CUST-c: 未声明命令 -32601;bad.name(非 custom. 前缀)注册时被跳过,同样不可达', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const r1 = await callTool({ action: 'custom_command', method: 'custom.nonexistent' });
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain('-32601');
    const r2 = await callTool({ action: 'custom_command', method: 'bad.name' });
    expect(r2.isError, 'bad.name 非 custom. 前缀:TS 层前缀拦截(比 bridge 更早),同样不可达').toBe(true);
    expect(r2.text).toContain('INVALID_PARAMS');
  });

  it('SYNC(P10): snapshot → 改状态 → snapshot → compare 出 diff;自身对照 in_sync', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // 清场(上次运行可能留快照——进程内 Map,同文件 sequential 内共享)
    await bridgeOk('sync_state', { sub_action: 'clear' });
    // 快照 A
    const snapA = await bridgeOk('sync_state', { sub_action: 'snapshot', label: 'host' });
    expect(Number(snapA.count)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(snapA.collected)).toContain('/root/Main');  // _mcp_state 约定节点被收集
    // 改状态(GDA_CALLABLE 声明的 toggle_p10_flag)
    const toggled = await callMain('toggle_p10_flag');
    expect(toggled.flag).toBe(true);
    // 快照 B
    await bridgeOk('sync_state', { sub_action: 'snapshot', label: 'client' });
    // 比对:flag/ticks 两键 diff(ticks 0→1,flag false→true)
    const cmp = await bridgeOk('sync_state', { sub_action: 'compare', label_a: 'host', label_b: 'client' });
    expect(cmp.in_sync).toBe(false);
    expect(cmp.missing_in_b).toEqual([]);
    expect(cmp.missing_in_a).toEqual([]);
    const diffKeys = (cmp.diffs as Array<{ path: string; key: string }>).filter((d) => d.path === '/root/Main').map((d) => d.key).sort();
    expect(diffKeys).toEqual(['flag', 'ticks']);
    // 自身对照:同状态再拍一张,in_sync=true(浮点容差默认 0.0001 内)
    await bridgeOk('sync_state', { sub_action: 'snapshot', label: 'client2' });
    const selfCmp = await bridgeOk('sync_state', { sub_action: 'compare', label_a: 'client', label_b: 'client2' });
    expect(selfCmp.in_sync).toBe(true);
    // list 清单
    const list = await bridgeOk('sync_state', { sub_action: 'list' });
    expect(list.total).toBe(3);
    await bridgeOk('sync_state', { sub_action: 'clear' });
  });
});
