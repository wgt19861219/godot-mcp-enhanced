/**
 * A2+A3 (2026-11-12 反馈批次) e2e:行为级真机锚定(模式同 e2e-bridge-mouse-gui C1:
 * install → run_project 带窗口 + wait_for_bridge → sendToBridge 直连)。
 *
 * **必须带窗口**(非 headless):真机探针定谳(2026-11-13,Godot 4.7/4.6.3 双端)——
 * headless 下普通 Control.gui_input 派发正常(C2 结论成立),但 **BaseButton 点击链
 * 不响应注入**(press 无论 push_input 还是 parse_input_event,button_down/pressed
 * 均零计数;探针 v3/v4 实测,headless viewport 亦仅 64x64)。real_event 的
 * push_input 注入是窗口场景功能,自毁钮 e2e 只能在带窗口模式验证。
 *
 * - A2 自毁钮:click_button real_event=true 点「pressed handler 内 queue_free 自身」的
 *   按钮——修复前 verify 协程末尾读已 free 节点属性 → Debugger Break 挂死主循环,
 *   bridge 从此不响应(2026-10-10/09-24/09-28/11-02 三项目三踩)。修复后:响应正常
 *   返回不超时,clicked/verified 如实(pressed 信号已计 = 信号链走通),button_text
 *   来自 press 前缓存,button_pressed 为 null(节点没了读不到,诚实呈现)。
 * - A3 硬黑名单预检:call_method method="set"(BLOCKLIST 成员)无 env/GDA 命中——
 *   修复前首条报错是 -2 白名单文案(建议 "allow via env/GDA_CALLABLE",照做后再撞
 *   -6 硬底线,误导死路);修复后首条即 -6 hard floor 终判。
 *
 * 守卫:GODOT_PATH + fixture 存在(skipIf;CI 无 Godot 时 skip,窗口弹闪仅本机)。
 * 源码契约见 test/bridge-feedback-batch-a2a3-contract.test.ts。
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
import { sendToBridge, setBridgeProjectDir } from '../src/core/bridge-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const FIXTURE = resolve(__dirname, 'fixtures', 'self-destruct-e2e');
const hasFixture = existsSync(resolve(FIXTURE, 'project.godot'));

if (!hasGodot || !hasFixture) {
  process.stderr.write(`[skip] A2/A3 self-destruct e2e skipped — ${!hasGodot ? 'Godot not found (GODOT_PATH)' : 'no self-destruct-e2e fixture'}.\n`);
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

async function callGame(args: Record<string, unknown>): Promise<string> {
  const mod = getModuleForTool('game');
  expect(mod, 'game 模块须注册').toBeTruthy();
  const result = await mod!.handleTool('game', { project_path: FIXTURE, ...args }, makeCtx());
  const text = (result as ToolResult).content.map(c => c.text).join('\n');
  expect(text.includes('"error"'), `${args.action} 失败: ${text.slice(0, 300)}`).toBe(false);
  return text;
}

async function callRuntime(args: Record<string, unknown>): Promise<string> {
  const mod = getModuleForTool('runtime');
  expect(mod, 'runtime 模块须注册').toBeTruthy();
  const result = await mod!.handleTool('runtime', { project_path: FIXTURE, ...args }, makeCtx());
  return (result as ToolResult).content.map(c => c.text).join('\n');
}

describe.skipIf(!hasGodot || !hasFixture)('A2/A3 自毁钮 verify 存活守卫 + blocklist 预检 e2e', { timeout: 180_000, sequential: true }, () => {
  let projectGodotSnap = '';
  let _initError: string | null = null;

  // call_method 探针方法经文档支持的 EXTRA_METHODS env 放行(run_project spawn 的游戏
  // 进程继承本进程 env;不含 "set"——A3 断言的正是 blocklist 方法在无 env 命中时的
  // 首条报错形态)
  const EXTRA_ENV = 'get_sd_state,get_self_destruct_btn';

  async function callProbe(method: string, args: unknown[] = []): Promise<Record<string, unknown>> {
    const r = await sendToBridge('call_method', { path: '/root/Main', method, args }, 10_000) as Record<string, unknown>;
    const inner = r.result as Record<string, unknown> | undefined;
    expect(inner?.error, `call_method ${method} 报错: ${JSON.stringify(r).slice(0, 300)}`).toBeUndefined();
    return (inner?.result ?? inner) as Record<string, unknown>;
  }

  beforeAll(async () => {
    try {
      projectGodotSnap = readFileSync(resolve(FIXTURE, 'project.godot'), 'utf-8');
      try {
        rmSync(resolve(FIXTURE, '.godot'), { recursive: true, force: true });
      } catch {
        // EPERM best-effort
      }
      process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
      process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = EXTRA_ENV;
      ensureRegistered();
      // N-4 对齐:清上次残留 mcp_bridge.gd,防 install 幂等保留旧版测到旧行为
      rmSync(resolve(FIXTURE, 'mcp_bridge.gd'), { force: true });
      await callGame({ action: 'game_bridge_install' });

      // 带窗口模式(非 headless):BaseButton 点击链只在窗口模式响应注入(探针定谳,见文件头)
      const run = await callRuntime({ action: 'run_project', wait_for_bridge: true, bridge_timeout: 30, timeout: 120 });
      expect(run.includes('"error"'), `run_project 失败: ${run.slice(0, 300)}`).toBe(false);
      setBridgeProjectDir(FIXTURE);
      const pong = await sendToBridge('ping', {}, 5000);
      expect(pong && !('error' in (pong as Record<string, unknown>)), `bridge ping 失败: ${JSON.stringify(pong).slice(0, 200)}`).toBe(true);
    } catch (e) {
      _initError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[skip] A2/A3 e2e beforeAll failed — suite will skip all tests. Error: ${_initError}\n`);
      try {
        await callRuntime({ action: 'stop_project' });
      } catch {
        // best-effort
      }
    }
  }, 200_000);

  afterAll(async () => {
    delete process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET; // 跨文件 env 泄漏清理(对齐 C1 Nit-13)
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

  it('A2: click_button real_event 点自毁钮——bridge 仍响应不挂死,verify 如实', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const btnInfo = await callProbe('get_self_destruct_btn');
    const path = String(btnInfo.path);
    process.stderr.write(`[A2] self-destruct btn: ${JSON.stringify(btnInfo)}\n`);

    // real_event=true 走延迟响应协程(press/release 注入 + 等帧读信号计数)。
    // 修复前:自毁钮在等帧窗口内 free,末尾读 btn 属性 Debugger Break 挂死 → 本调用超时。
    const clickResp = await sendToBridge('click_button', { path, real_event: true }, 15_000) as Record<string, unknown>;
    const result = clickResp.result as Record<string, unknown> | undefined;
    expect(result?.error, `click_button 不应有 error: ${JSON.stringify(clickResp).slice(0, 400)}`).toBeUndefined();
    const r = (result?.result ?? result) as Record<string, unknown>;
    process.stderr.write(`[A2] click real_event resp: ${JSON.stringify(r)}\n`);

    // 信号链走通:pressed 信号已被 recorder 计数(handler 释放按钮即证明 press 真实派发)
    const counts = (r.signal_counts ?? {}) as Record<string, number>;
    expect(Number(counts.pressed ?? 0), 'signal_counts.pressed 须 >=1(press 注入真实走通引擎管线)').toBeGreaterThanOrEqual(1);
    expect(r.clicked).toBe(true);
    expect(r.verified, 'verified 如实标记(节点已 free 但信号已计 = 点击已生效)').toBe(true);
    // button_text 来自 press 前缓存(节点已 free 仍须返回文本,不得崩/空)
    expect(r.button_text).toBe('SelfDestruct');
    // button_pressed:节点没了读不到,诚实给 null(不得崩,也不得误报 false)
    expect(r.button_pressed).toBeNull();
    expect(r.mode).toBe('real_event');

    // 游戏侧印证:handler 真跑了 + 按钮真自毁了 + bridge 之后仍活着(再查一次状态)
    const sd = await callProbe('get_sd_state');
    process.stderr.write(`[A2] sd state after click: ${JSON.stringify(sd)}\n`);
    expect(Number(sd.press_count)).toBeGreaterThanOrEqual(1);
    expect(sd.btn_valid, '按钮须已被 handler 释放(自毁场景成立)').toBe(false);
  });

  it('A3: call_method set 无 env/GDA 命中——首条报错即 -6 硬底线,无 allow via 误导', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    // "set" 在 EXTRA_METHODS_BLOCKLIST(与 set_script 对称,防 node.set("script",...) 绕道)
    const resp = await sendToBridge('call_method', { path: '/root/Main', method: 'set', args: ['position', { x: 1, y: 1 }] }, 10_000) as Record<string, unknown>;
    // 错误响应形态:顶层 {"id", "error"}(实测);兼容 result 内嵌 error 的包装形态
    const err = (resp.error ?? (resp.result as Record<string, unknown> | undefined)?.error) as Record<string, unknown> | undefined;
    process.stderr.write(`[A3] call_method set resp: ${JSON.stringify(resp)}\n`);
    expect(err, `须返回 error 结构: ${JSON.stringify(resp).slice(0, 300)}`).toBeDefined();
    expect(Number(err?.code), '首条报错须直接 -6 硬底线(不落 -2 白名单文案)').toBe(-6);
    expect(String(err?.message)).toContain('hard floor');
    expect(String(err?.message), '不得含 "allow via" 误导建议(照做后再撞 -6 是死路)').not.toContain('allow via');

    // bridge 仍活着(A3 报错路径不得影响后续服务)
    const sd = await callProbe('get_sd_state');
    expect(sd).toBeTruthy();
  });
});
