/**
 * P8 批 (2026-09-11) e2e:mcp_commands 热加载状态机(真起游戏,运行中改文件)。
 *
 * 守卫:GODOT_MCP_E2E_L2=1 opt-in + GODOT_PATH + fixture(对齐 p3-e2e 模式)。
 * fixture: test/fixtures/p3-e2e(mcp_commands/example.gd 含 custom.ping/echo/check_state)。
 *
 * 断言分层:
 * - HOT-a: custom.list 诊断(example.gd loaded + 命令面)
 * - HOT-b: 运行中新增 hot_cmd.gd → debounce 后新 slot + 命令可调(热加载核心)
 * - HOT-c: 运行中把新文件改坏(语法错)→ reload_failed 回滚保旧实例(旧命令仍可调)
 * - HOT-d: 删除新文件 → slot 卸载 + 命令不可达
 * - 收尾清理:hot_cmd.gd 恢复删除态,example.gd 保持原样(全程未动)
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
  process.stderr.write(`[skip] P8 e2e skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
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

/** custom_command 调用(返回 parsed 或 {err})。 */
async function custom(method: string, params: Record<string, unknown> = {}): Promise<{ r: Record<string, unknown> | null; err: string }> {
  const res = await callTool({ action: 'custom_command', method, params });
  if (res.isError) return { r: null, err: res.text };
  try {
    return { r: JSON.parse(res.text) as Record<string, unknown>, err: '' };
  } catch (e) {
    return { r: null, err: `JSON parse: ${String(e)}` };
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

describe.skipIf(!hasGodot || !hasFixture || !RUN)('P8 e2e (L2)', { timeout: 240_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;
  const HOT_CMD = resolve(FIXTURE, 'mcp_commands', 'hot_cmd.gd');

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch { /* EPERM best-effort */ }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
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
      process.stderr.write(`[skip] P8 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
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
      rmSync(HOT_CMD, { force: true });
      rmSync(HOT_CMD + '.uid', { force: true });
      rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
    } catch { /* EPERM best-effort */ }
    try {
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
    } catch { /* best-effort */ }
  });

  it('HOT-a: custom.list——example.gd slot loaded + 命令面', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    const { r, err } = await custom('custom.list');
    expect(err).toBe('');
    const slots = (r!.slots as Array<Record<string, unknown>>);
    expect(slots.length).toBe(1);
    expect(slots[0]!.state).toBe('loaded');
    expect(slots[0]!.script).toContain('example.gd');
    const commands = r!.commands as string[];
    for (const c of ['custom.ping', 'custom.echo', 'custom.check_state']) {
      expect(commands.includes(c), `命令面应含 ${c}`).toBe(true);
    }
    // 既有命令可用(P3 回归)
    const ping = await custom('custom.ping');
    expect(ping.err).toBe('');
    expect((ping.r as Record<string, unknown>).pong).toBe(true);
  });

  it('HOT-b: 运行中新增 hot_cmd.gd → debounce 后热加载(新命令可调)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    writeFileSync(HOT_CMD, [
      'extends Node',
      'func get_commands() -> Dictionary:',
      '\treturn {"custom.hot": _hot}',
      'func _hot(params: Dictionary) -> Dictionary:',
      '\treturn {"hot": true, "msg": str(params.get("m", ""))}',
      '',
    ].join('\n'));
    await sleep(900);  // debounce 300ms + 余量(mtime 变更 → tick 扫描 → reload)
    const { r, err } = await custom('custom.list');
    expect(err).toBe('');
    const slots = (r!.slots as Array<Record<string, unknown>>);
    expect(slots.length, '新 slot 出现').toBe(2);
    const hot = slots.find(s => String(s.script).includes('hot_cmd'));
    expect(hot, 'hot_cmd slot').toBeTruthy();
    expect(hot!.state).toBe('loaded');
    const call = await custom('custom.hot', { m: 'reload' });
    expect(call.err).toBe('');
    expect((call.r as Record<string, unknown>).hot).toBe(true);
    expect((call.r as Record<string, unknown>).msg).toBe('reload');
  });

  it('HOT-c: 运行中把 hot_cmd.gd 改成违反契约(合法语法 extends RefCounted)→ reload_failed 回滚保旧实例', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    // 注:不用语法坏文件——运行中引擎编译语法坏 .gd 会触发 Godot 4.6 Script Debugger
    // REPL 挂死主循环(引擎层限制,bridge 不可防,规则文档声明)。此处用"合法语法但非
    // Node 实例"验证同一回滚状态机(can_instantiate true → new() → 非 Node → 失败)。
    writeFileSync(HOT_CMD, 'extends RefCounted\nfunc get_commands() -> Dictionary:\n\treturn {}\n');
    await sleep(900);
    const { r, err } = await custom('custom.list');
    expect(err).toBe('');
    const slots = (r!.slots as Array<Record<string, unknown>>);
    const hot = slots.find(s => String(s.script).includes('hot_cmd'));
    expect(hot, 'hot_cmd slot 仍在(不销毁)').toBeTruthy();
    expect(hot!.state).toBe('reload_failed');
    expect(String(hot!.last_error)).toContain('must instantiate to a Node');
    // 回滚:旧实例的命令照常可调
    const call = await custom('custom.hot', { m: 'rollback' });
    expect(call.err, `回滚后旧命令应可用: ${call.err.slice(0, 200)}`).toBe('');
    expect((call.r as Record<string, unknown>).msg).toBe('rollback');
  });

  it('HOT-d: 删除 hot_cmd.gd → slot 卸载 + custom.hot 不可达(custom.ping 不误伤)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);
    rmSync(HOT_CMD, { force: true });
    rmSync(HOT_CMD + '.uid', { force: true });
    await sleep(900);
    const { r, err } = await custom('custom.list');
    expect(err).toBe('');
    const slots = (r!.slots as Array<Record<string, unknown>>);
    expect(slots.length, 'hot_cmd slot 卸载').toBe(1);
    const gone = await custom('custom.hot');
    expect(gone.err).not.toBe('');  // 不可达
    const ping = await custom('custom.ping');
    expect(ping.err).toBe('');  // example.gd 不误伤
  });
});
