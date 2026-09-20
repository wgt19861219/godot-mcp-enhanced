/**
 * 反馈坑 2/4(2026-08-21 反馈批)行为级 e2e:find_nodes root 子树限定 + call_method 协程双模式。
 * 复用 e2e-gd-symmetry 的 fixture(input-seq-e2e)与 harness 模式;协程探针 slow_add
 * (probe.gd)须 GODOT_MCP_BRIDGE_EXTRA_METHODS=slow_add 环境起游戏(子进程继承 process.env)。
 * 坑3(override 插入位置)是 TS 文件操作,由 test/overrides.test.ts 顺序单测锁定。
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
  const _reason = !hasGodot ? 'Godot not found' : !hasFixture ? 'no fixture' : 'GODOT_MCP_E2E_L2 not set';
  console.log(`[e2e-bridge-feedback-pits] skip: ${_reason}`);
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

async function callTool(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool('game');
  if (!mod) return { text: 'MODULE_NOT_FOUND: game', isError: true };
  const r = await mod.handleTool('game', args, makeCtx());
  if (!r || !Array.isArray((r as ToolResult).content)) return { text: String(r), isError: true };
  const tr = r as ToolResult;
  return { text: String(tr.content[0]?.text ?? ''), isError: tr.isError === true };
}

describe.skipIf(!RUN)('反馈坑 2/4: find_nodes root + call_method 协程(行为级)', () => {
  let projectGodotSnap = '';
  let hadExtraEnv = false;

  beforeAll(async () => {
    projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf8');
    try { rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true }); } catch { /* EPERM best-effort */ }
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
    // 坑4:slow_add 非 get_* 前缀,游戏进程须带 EXTRA_METHODS 白名单(子进程继承本 env)
    if (!process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS) {
      process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = 'slow_add';
      hadExtraEnv = true;
    }
    if (!_registered) { registerAllModules(); _registered = true; }
    // N-4: 清残留防 install 幂等保留旧副本(同 input-seq 注释)
    try { rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true }); } catch { /* EPERM best-effort */ }
    const install = await callTool({ action: 'game_bridge_install', project_path: FIXTURE });
    expect(install.isError, `install failed: ${install.text.slice(0, 200)}`).toBe(false);
    const runMod = getModuleForTool('runtime');
    const run = await runMod!.handleTool('runtime', {
      project_path: FIXTURE, action: 'run_project',
      wait_for_bridge: true, bridge_timeout: 30, timeout: 120,
    }, makeCtx());
    expect(run && isToolResult(run) && run.isError !== true, 'run_project failed').toBe(true);
  }, 200000);

  afterAll(() => {
    if (hadExtraEnv) { delete process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS; }
    try { writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap, 'utf8'); } catch { /* best-effort */ }
    try { rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('坑2: find_nodes root=/root/Main 限定子树——不含 Root/MCPBridge,仅 Main', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_query', method: 'find_nodes',
      params: { pattern: '*', root: '/root/Main' },
    });
    expect(r.isError, `find_nodes errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { nodes?: Array<{ name?: string }> };
    const names = (parsed.nodes ?? []).map(n => n.name).sort();
    expect(names, '子树内只应有 Main(修复前 root 被忽略返回全树节点)').toEqual(['Main']);
  });

  it('坑2 正向回归: 不传 root 仍全树搜索(默认行为不变)', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_query', method: 'find_nodes',
      params: { pattern: '*' },
    });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as { nodes?: Array<{ name?: string }> };
    const names = (parsed.nodes ?? []).map(n => n.name);
    expect(names).toContain('Main');
    expect(names.length, '全树应含 Root/MCPBridge/Main 等多于子树的节点').toBeGreaterThan(1);
  });

  it('坑2 负向: 无效 root 报结构化错误(非静默全树)', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_query', method: 'find_nodes',
      params: { pattern: '*', root: '/root/NopeNotExist' },
    });
    // TS 层把 bridge 错误以文本形态回传("Bridge error (-7): Root node not found ..."),
    // 不保证 JSON 形态——按关键信息断言
    expect(r.text, '无效 root 须报 Root node not found').toContain('Root node not found');
  });

  it('坑4: 协程方法默认 fire-and-forget——返 {coroutine:true} 标记非内部状态对象', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_write', method: 'call_method',
      params: { path: '/root/Main', method: 'slow_add', args: [11, 22] },
    });
    expect(r.isError, `call_method errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { result?: unknown; coroutine?: boolean; note?: string };
    expect(parsed.coroutine, '协程默认须返 coroutine:true 标记').toBe(true);
    expect(parsed.result, 'result 须为 null(返回值尚未产生)而非 GDScriptFunctionState 序列化').toBeNull();
    expect(parsed.note ?? '', '标记须附使用指引').toContain('await_completion');
  });

  it('坑4: await_completion=true 等待协程完成——返真值 33 + awaited 标记(延迟响应)', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_write', method: 'call_method',
      params: { path: '/root/Main', method: 'slow_add', args: [11, 22], await_completion: true },
      timeout: 15000,
    });
    expect(r.isError, `await call_method errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { result?: unknown; awaited?: boolean };
    expect(parsed.awaited, '延迟响应须带 awaited:true').toBe(true);
    expect(parsed.result, '须等到协程真值 33 而非 null').toBe(33);
  });

  it('坑4 正向回归: 非协程方法 + await_completion 统一延迟路径(await callv 穿透立返,形态一致)', { timeout: 30_000 }, async () => {
    const r = await callTool({
      action: 'game_write', method: 'call_method',
      // get_parent 在只读白名单内;Main 的父节点是 root,await 穿透立返但形态带 awaited:true
      params: { path: '/root/Main', method: 'get_parent', await_completion: true },
      timeout: 15000,
    });
    expect(r.isError, `call_method errored: ${r.text.slice(0, 300)}`).toBe(false);
    const parsed = JSON.parse(r.text) as { result?: unknown; awaited?: boolean };
    expect(parsed.awaited, '非协程 + await_completion 也应带 awaited:true(形态统一)').toBe(true);
    expect(parsed.result, 'get_parent 应返回 root 节点信息').toBeTruthy();
  });
});

function isToolResult(val: unknown): val is ToolResult {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.content) && obj.content.every(
    (c: unknown) => c && typeof c === 'object' && 'type' in (c as Record<string, unknown>) && 'text' in (c as Record<string, unknown>),
  );
}
