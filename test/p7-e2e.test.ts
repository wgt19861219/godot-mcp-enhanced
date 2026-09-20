/**
 * P7 批 (2026-09-11) e2e:语义观察层——观察 profile + 级联 + 字段投影 + near 联动 + role。
 *
 * 守卫:GODOT_MCP_E2E_L2=1 opt-in + GODOT_PATH + fixture(对齐 p3-e2e 模式)。
 * fixture: test/fixtures/p3-e2e(P7 节点在 main.gd _ready 动态创建:
 * SecretEnemy 四规则 / HiddenParent private / ChildOfHidden 级联 / FoggedOut / PlainNode)。
 * 环境注入 GODOT_MCP_BRIDGE_ALLOWED_PROFILES=debug,player(授权 player 档)。
 *
 * 断言分层:
 * - debug 档直通(有规则也不投影) vs player 档全投影(quantize/redact/replace/omit)
 * - 级联:祖先 private → 子树不可观察;visible_to_player=false 第二维度
 * - 存在性不泄露:不可观察节点 get_node_properties/layout 报 not found(非 403)
 * - near 联动:position 有规则的锚点 -11 / 候选静默排除
 * - role/label 全档位输出;monitor/watch 中途可见性
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
  process.stderr.write(`[skip] P7 e2e skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
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

/** game_query 直调(params 透传,observation_profile 在 params 里)。 */
async function query(method: string, params: Record<string, unknown>): Promise<{ r: Record<string, unknown> | null; err: string }> {
  const res = await callTool({ action: 'game_query', method, params });
  if (res.isError) return { r: null, err: res.text };
  try {
    return { r: JSON.parse(res.text) as Record<string, unknown>, err: '' };
  } catch (e) {
    return { r: null, err: `JSON parse: ${String(e)} / ${res.text.slice(0, 200)}` };
  }
}

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

describe.skipIf(!hasGodot || !hasFixture || !RUN)('P7 e2e (L2)', { timeout: 240_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch { /* EPERM best-effort */ }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
      // P7: 授权 player 档(游戏方声明面 = 启动 env;agent 不能自授权)
      process.env.GODOT_MCP_BRIDGE_ALLOWED_PROFILES = 'debug,player';
      if (!_registered) {
        registerAllModules();
        _registered = true;
      }
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
      process.stderr.write(`[skip] P7 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
    }
  }, 200000);

  afterAll(async () => {
    delete process.env.GODOT_MCP_BRIDGE_ALLOWED_PROFILES;
    try {
      const mod = getModuleForTool('runtime');
      if (mod) await mod.handleTool('runtime', { project_path: FIXTURE, action: 'stop_project' }, makeCtx());
    } catch { /* best-effort */ }
    try {
      writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap);
      rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
    } catch { /* EPERM best-effort */ }
    try {
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
    } catch { /* best-effort */ }
  });

  // ─── debug 档直通 vs player 档投影 ────────────────────────────────────────

  it('OBS-a: debug 档直通——SecretEnemy 有规则也不投影(position 真值 300,400)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, err } = await query('find_nodes', { pattern: 'SecretEnemy' });
    expect(err).toBe('');
    const nodes = (r!.nodes as Array<Record<string, unknown>>);
    expect(nodes.length).toBe(1);
    const pos = nodes[0]!.position as Record<string, number>;
    expect(pos.x).toBe(300);
    expect(pos.y).toBe(400);
  });

  it('OBS-b: player 档投影——position quantize 64(snapped 300→320, 400→384)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, err } = await query('find_nodes', { pattern: 'SecretEnemy', observation_profile: 'player' });
    expect(err).toBe('');
    const nodes = (r!.nodes as Array<Record<string, unknown>>);
    expect(nodes.length).toBe(1);
    const pos = nodes[0]!.position as Record<string, number>;
    expect(pos.x).toBe(320);  // snapped(300, 64) = 5*64
    expect(pos.y).toBe(384);  // snapped(400, 64) = 6*64
  });

  it('OBS-c: player 档级联——private 祖先/visible_to_player=false 整藏,PlainNode 不误伤', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, err } = await query('find_nodes', { root: '/root/Main', observation_profile: 'player' });
    expect(err).toBe('');
    const names = (r!.nodes as Array<Record<string, unknown>>).map(n => String(n.name));
    expect(names.includes('HiddenParent'), 'private 对象不进树').toBe(false);
    expect(names.includes('ChildOfHidden'), '祖先 private 级联藏子树').toBe(false);
    expect(names.includes('FoggedOut'), 'visible_to_player=false 藏').toBe(false);
    expect(names.includes('PlainNode'), '无 meta 节点不误伤').toBe(true);
    expect(names.includes('SecretEnemy'), '有字段规则但可观察的节点仍在树(值投影)').toBe(true);
    // 对照:debug 档全可见
    const dbg = await query('find_nodes', { root: '/root/Main' });
    const dbgNames = (dbg.r!.nodes as Array<Record<string, unknown>>).map(n => String(n.name));
    expect(dbgNames.includes('HiddenParent')).toBe(true);
    expect(dbgNames.includes('ChildOfHidden')).toBe(true);
    expect(dbgNames.includes('FoggedOut')).toBe(true);
  });

  it('OBS-d: get_node_properties player——hp redact 0/score replace 999/name_tag omit 删键', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, err } = await query('get_node_properties', { path: '/root/Main/SecretEnemy', observation_profile: 'player' });
    expect(err).toBe('');
    const props = r!.properties as Record<string, unknown>;
    expect(props.hp, '数值 redact → 0').toBe(0);
    expect(props.score, 'replace → 声明替值 999').toBe(999);
    expect(props.name_tag, undefined as unknown).toBeUndefined();  // omit → 键删除
    // debug 对照:真值
    const dbg = await query('get_node_properties', { path: '/root/Main/SecretEnemy' });
    const dbgProps = dbg.r!.properties as Record<string, unknown>;
    expect(dbgProps.hp).toBe(75);
    expect(dbgProps.score).toBe(12);
    expect(dbgProps.name_tag).toBe('boss-omega');
  });

  it('OBS-e: 存在性不泄露——player 档 get_node_properties/layout 对不可观察节点报 not found(非 403)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const props = await query('get_node_properties', { path: '/root/Main/HiddenParent', observation_profile: 'player' });
    expect(props.err).toContain('Node not found');
    const layout = await query('get_node_layout', { path: '/root/Main/HiddenParent', observation_profile: 'player' });
    expect(layout.err).toContain('Node not found');
  });

  it('OBS-f: near × 投影联动——position 有规则的锚点 -11;无规则锚点的 near 结果排除有规则候选', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // 锚点 SecretEnemy(position quantize 规则)→ -11 防差分反推
    const anchored = await query('find_nodes', {
      root: '/root/Main', near_node: '/root/Main/SecretEnemy', max_distance: 2000, observation_profile: 'player',
    });
    expect(anchored.err).toContain('-11');
    // 锚点 PlainNode(无规则)→ 正常,但 SecretEnemy(候选侧有规则)静默排除
    const ok = await query('find_nodes', {
      root: '/root/Main', near_node: '/root/Main/PlainNode', max_distance: 2000, observation_profile: 'player',
    });
    expect(ok.err).toBe('');
    const names = (ok.r!.nodes as Array<Record<string, unknown>>).map(n => String(n.name));
    expect(names.includes('SecretEnemy'), 'position 被规则的候选不可测距').toBe(false);
    expect(names.includes('PlainNode')).toBe(false);  // 锚点自身排除(P5 语义)
  });

  it('OBS-g: find_ui_elements role/label 全档位输出(CheckBox→checkbox,非 button)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const res = await callTool({ action: 'find_ui_elements', pattern: '*MyCheck*' });
    expect(res.isError).toBe(false);
    const elements = (JSON.parse(res.text) as { elements: Array<Record<string, unknown>> }).elements;
    expect(elements.length).toBe(1);
    expect(elements[0]!.role, 'CheckBox 子类先判,不被 BaseButton→button 吞').toBe('checkbox');
    expect(elements[0]!.label).toBe('MyCheck');
    // player 档同样给 role(role 是语义信息非隐私)
    const p7res = await callTool({ action: 'find_ui_elements', pattern: '*MyCheck*', observation_profile: 'player' });
    expect(p7res.isError).toBe(false);
    const p7elements = (JSON.parse(p7res.text) as { elements: Array<Record<string, unknown>> }).elements;
    expect(p7elements[0]!.role).toBe('checkbox');
  });

  it('OBS-h: monitor player 采样投影(320/384) + 中途隐藏后样本零新增 + 恢复续采', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const start = await callTool({
      action: 'monitor_start', node_path: '/root/Main/SecretEnemy',
      properties: ['position'], interval_frames: 5, observation_profile: 'player',
    });
    expect(start.isError, `monitor_start 不应报错: ${start.text.slice(0, 300)}`).toBe(false);
    await new Promise(res => setTimeout(res, 600));  // 可见期 ~7 格(interval 5 帧≈83ms)
    let poll = await callTool({ action: 'monitor_poll' });
    expect(poll.isError).toBe(false);
    let samples = (JSON.parse(poll.text) as { samples: Array<Record<string, unknown>> }).samples;
    expect(samples.length, '可见期采到样本').toBeGreaterThanOrEqual(1);
    const visibleCount = samples.length;
    for (const s of samples) {
      const v = s.values as Record<string, Record<string, number>>;
      expect(v.position.x, '全部样本均为投影后值(quantize 64)').toBe(320);
      expect(v.position.y).toBe(384);
    }
    await callMain('hide_secret_enemy');
    await new Promise(res => setTimeout(res, 600));  // 隐藏期同长度(若泄露会 +7 格)
    poll = await callTool({ action: 'monitor_poll' });
    samples = (JSON.parse(poll.text) as { samples: Array<Record<string, unknown>> }).samples;
    expect(samples.length, '隐藏期样本零新增(静默缺格不泄露)').toBeLessThanOrEqual(visibleCount + 1);  // +1 容差:hide 生效前边界格
    await callMain('unhide_secret_enemy');
    await new Promise(res => setTimeout(res, 500));
    poll = await callTool({ action: 'monitor_poll' });
    samples = (JSON.parse(poll.text) as { samples: Array<Record<string, unknown>> }).samples;
    expect(samples.length, '恢复可见后续采').toBeGreaterThan(visibleCount + 1);
    const stop = await callTool({ action: 'monitor_stop' });
    expect(stop.isError).toBe(false);
  });

  it('OBS-i: watch player 中途隐藏——事件静默不记录,恢复后继续', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    await callMain('unhide_main');
    const start = await callTool({
      action: 'watch_start', node_path: '/root/Main', signal_name: 'p7_ping',
      observation_profile: 'player',
    });
    expect(start.isError, `watch_start 不应报错: ${start.text.slice(0, 300)}`).toBe(false);
    await callMain('emit_p7_ping');
    await new Promise(res => setTimeout(res, 400));
    let poll = await callTool({ action: 'watch_poll' });
    let events = (JSON.parse(poll.text) as { events: unknown[] }).events;
    expect(events.length, '可见期事件记录').toBe(1);
    await callMain('hide_main');
    await callMain('emit_p7_ping');
    await callMain('emit_p7_ping');
    await new Promise(res => setTimeout(res, 400));
    poll = await callTool({ action: 'watch_poll' });
    events = (JSON.parse(poll.text) as { events: unknown[] }).events;
    expect(events.length, '中途隐藏期事件静默不记录').toBe(1);
    await callMain('unhide_main');
    await callMain('emit_p7_ping');
    await new Promise(res => setTimeout(res, 400));
    poll = await callTool({ action: 'watch_poll' });
    events = (JSON.parse(poll.text) as { events: unknown[] }).events;
    expect(events.length, '恢复可见后继续记录').toBe(2);
    await callTool({ action: 'watch_stop' });
  });

  it('OBS-j: profile 门禁 e2e 侧——默认无 observation_profile = debug 档;非法档位 -20', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const bad = await query('find_nodes', { observation_profile: 'yolo' });
    expect(bad.err).toContain('-20');
    // TS 侧枚举在 schema,但 GD 是真相源(params 直通,绕 schema 的调用也被 GD 拒)
    const unauth = await query('find_nodes', { observation_profile: 'player' });
    // 本 e2e 环境已授权 player,unauth 应正常(门禁拒的验证在 p7-unit PB-f 未授权探针)
    expect(unauth.err).toBe('');
  });

  it('OBS-k: get_tree player——不可观察子树整枝剪除 + 可观察节点 info 投影(B-1 清偿)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const collectNames = (n: Record<string, unknown>, acc: string[]): void => {
      acc.push(String(n.name));
      for (const c of (n.children as Array<Record<string, unknown>>) ?? []) collectNames(c, acc);
    };
    const { r, err } = await query('get_tree', { max_depth: 6, observation_profile: 'player' });
    expect(err).toBe('');
    expect(r!.observation_profile).toBe('player');
    const names: string[] = [];
    collectNames(r!.tree[0] as Record<string, unknown>, names);
    expect(names.includes('HiddenParent'), 'private 不进树').toBe(false);
    expect(names.includes('ChildOfHidden'), '级联剪枝').toBe(false);
    expect(names.includes('FoggedOut'), 'visible_to_player=false 剪枝').toBe(false);
    expect(names.includes('SecretEnemy'), '可观察节点在树(值投影)').toBe(true);
    // SecretEnemy 的 position 投影:树里递归找该节点核对 quantize 值
    const findNode = (n: Record<string, unknown>, name: string): Record<string, unknown> | null => {
      if (String(n.name) === name) return n;
      for (const c of (n.children as Array<Record<string, unknown>>) ?? []) {
        const hit = findNode(c, name);
        if (hit) return hit;
      }
      return null;
    };
    const secret = findNode(r!.tree[0] as Record<string, unknown>, 'SecretEnemy');
    expect(secret).not.toBeNull();
    const pos = secret!.position as Record<string, number>;
    expect(pos.x).toBe(320);
    expect(pos.y).toBe(384);
    // debug 对照:HiddenParent 在树
    const dbg = await query('get_tree', { max_depth: 6 });
    const dbgNames: string[] = [];
    collectNames(dbg.r!.tree[0] as Record<string, unknown>, dbgNames);
    expect(dbgNames.includes('HiddenParent')).toBe(true);
  });

  it('OBS-l: wait 侧信道封堵——wait_for_node 不可观察 exists=false;wait_for_property match 基于投影值', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // wait_for_node/wait_for_property 走 game_wait(TS 轮询通道,单次快照由 params 直通 GD);
    // 短 timeout 让"永不满足"类断言快速返回。
    // interval_ms 500(D1 清偿 2026-09-12):单次探测超时=args.interval_ms×2(game-bridge.ts:718,
    // interval_ms 是 args 顶层字段非 params 内字段),默认 200 时探测超时仅 400ms——本地慢机
    // (背景 Godot 进程抢资源)单次往返超 400ms 即 BridgeTimeoutError 硬中止(visible 探测假失败)。
    // 500→探测 1000ms 余量;"永不满足"断言等满总窗 5000ms 返回,语义不变。
    const waitOnce = async (method: string, params: Record<string, unknown>): Promise<{ r: Record<string, unknown> | null; err: string }> => {
      const res = await callTool({ action: 'game_wait', method, params, interval_ms: 500, timeout: 5000 });
      if (res.isError) return { r: null, err: res.text };
      try {
        return { r: JSON.parse(res.text) as Record<string, unknown>, err: '' };
      } catch (e) {
        return { r: null, err: `JSON parse: ${String(e)}` };
      }
    };
    const visible = await waitOnce('wait_for_node', { path: '/root/Main/PlainNode', observation_profile: 'player' });
    expect(visible.err).toBe('');
    expect(visible.r!.exists).toBe(true);
    const hidden = await waitOnce('wait_for_node', { path: '/root/Main/HiddenParent', observation_profile: 'player' });
    // exists=false 永不满足 → TS 轮询到超时;pollWaitCondition 返回最后快照(非 error)
    expect(hidden.err === '' || hidden.err.includes('timeout') || hidden.err.toLowerCase().includes('timed out'), `超时形态: ${hidden.err.slice(0, 200)}`).toBe(true);
    if (hidden.r) expect(hidden.r.exists, '不可观察节点 exists=false(非报错=不泄露存在)').toBe(false);
    // wait_for_property: hp redact → current=0;match 用投影值。
    // 注:value 传字符串 "0"——GD 的 JSON 数字统一反序列化为 float(str(0.0)="0.0"),
    // 投影 redact 归 0 是 int(str="0"),str 比较语义下 number 0 形态不匹配(既有行为)。
    const m0 = await waitOnce('wait_for_property', { path: '/root/Main/SecretEnemy', property: 'hp', value: '0', observation_profile: 'player' });
    expect(m0.err).toBe('');
    expect(m0.r!.current, '显示投影值 0').toBe(0);
    expect(m0.r!.match, 'match 按投影值比较').toBe(true);
    const m75 = await waitOnce('wait_for_property', { path: '/root/Main/SecretEnemy', property: 'hp', value: '75', observation_profile: 'player' });
    if (m75.r) expect(m75.r.match, '真值 75 在 player 档不可探测(轮询超时形态)只会 not match').toBe(false);
    // 不可观察节点报 not found(存在性不泄露)——单次 GD 错误经 pollWaitCondition 上抛
    const notfound = await waitOnce('wait_for_property', { path: '/root/Main/HiddenParent', property: 'name', value: 'x', observation_profile: 'player' });
    expect(notfound.err).toContain('Node not found');
  });

  it('OBS-m: call_method player——get 投影/枚举方法 -22/snapshot·restore -23(B-1 清偿)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // get(prop) 返回值投影:position → snapped
    const getPos = await callTool({
      action: 'game_write', method: 'call_method',
      params: { path: '/root/Main/SecretEnemy', method: 'get', args: ['position'], observation_profile: 'player' },
    });
    expect(getPos.isError, `get(position) 不应报错: ${getPos.text.slice(0, 300)}`).toBe(false);
    const posResult = (JSON.parse(getPos.text) as { result: Record<string, number> }).result;
    expect(posResult.x, 'get 投影后 snapped').toBe(320);
    expect(posResult.y).toBe(384);
    // 结构枚举方法 -22
    const enumCall = await callTool({
      action: 'game_write', method: 'call_method',
      params: { path: '/root/Main', method: 'get_children', observation_profile: 'player' },
    });
    expect(enumCall.isError).toBe(true);
    expect(enumCall.text).toContain('-22');
    // 不可观察节点 not found(存在性不泄露)
    const hiddenCall = await callTool({
      action: 'game_write', method: 'call_method',
      params: { path: '/root/Main/HiddenParent', method: 'get_class', observation_profile: 'player' },
    });
    expect(hiddenCall.isError).toBe(true);
    expect(hiddenCall.text).toContain('Node not found');
    // snapshot/restore -23(保真语义冲突)——playtest 走 game_playtest action(params 直通)
    const playtestCall = async (method: string, params: Record<string, unknown>): Promise<{ r: Record<string, unknown> | null; err: string }> => {
      const res = await callTool({ action: 'game_playtest', method, params });
      if (res.isError) return { r: null, err: res.text };
      try {
        return { r: JSON.parse(res.text) as Record<string, unknown>, err: '' };
      } catch (e) {
        return { r: null, err: `JSON parse: ${String(e)}` };
      }
    };
    const snap = await playtestCall('playtest.snapshot', { observation_profile: 'player' });
    expect(snap.err).toContain('-23');
    const restore = await playtestCall('playtest.restore', { observation_profile: 'player' });
    expect(restore.err).toContain('-23');
    // debug 档不受影响
    const snapDbg = await playtestCall('playtest.snapshot', {});
    expect(snapDbg.err).toBe('');
    const restoreDbg = await playtestCall('playtest.restore', {});
    expect(restoreDbg.err).toBe('');
  });
});
