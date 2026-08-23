// test/e2e-debug-tools.test.ts — debug 子系统 10 action 的 editor 真进程 e2e（批 H / H-1, 2026-08-15）
//
// 补 test/cmp-14-debug-phase2.test.ts + test/gd-open-findings-contract.test.ts 的
// "源码字符串签约、运行时零验证"缺口：CMP-14 Phase 2/3 七个 async handler 与 A2
// `_debug_in_flight` 互斥守卫(websocket_server.gd)此前只有字符串形状断言,editor
// 真进程从未跑过。本文件仿 e2e-resilience-editor / e2e-testing-undo-manager 的
// 自 spawn 范式(spawn editor + MCP websocket + E2E_EDITOR=1 gate)。
//
// ─── 测试结构(3 用例)─────────────────────────────────────────────────────────
//
// 1. 链路 happy path: set_breakpoint → play(driver 套件) → 轮询 stack_trace
//    breaked(frames[0] 落点 == 断点行) → debug_step over(落点 == 断点行+1) →
//    continue。断点目标脚本每帧进 hot_func(fixtures/real-project/scripts/
//    debug_breakpoint_target.gd),断点按 `# BREAKPOINT:` 标记行动态定位行号。
// 2. A2 互斥(运行时验证): breaked 下并发 debug_step + debug_stack_trace。
//    **不走 EditorToolExecutor.execute**(它有 executeChain 串行化,永远造不出
//    并发),直发 conn.request 两次 —— editor 端 packet 循环 fire-and-forget,
//    第一个 coroutine 挂起(step 的 await_new_break 实测挂起窗 ~700ms)期间
//    第二个 packet 被 `_debug_in_flight` 守卫拒(-32000 "in flight")。
// 3. Phase 1 断点管理: list_breakpoints(按 path 过滤) → clear_breakpoint → list 归零。
//
// ─── 为什么需要 driver 套件(fixtures/real-project/tests/test_debug_driver.gd)───
//
// debug Phase 2/3 全部 handler 在 is_playing_scene()==false 时同步返回 guard
// 提示(无 await 窗口 → 互斥守卫永不触发),而 EditorInterface.play_custom_scene
// 无对应 MCP method。driver 套件跑在 editor 主循环内,代为按下"运行场景"。
// 经 exec.execute('testing', {action:'run'}) 调用 —— method-map 键是 `run`
// (testing.run → test_run)。⚠️ test_name 是**子串**过滤:'play' 会同时匹配
// test_stop_playing("s-playing" 含 "play") 导致 play 后立即 stop,必须用
// 'play_and' / 'stop_'(批 H 实测踩坑)。
//
// ─── 批 H 期间发现并修复的前序生产 bug(详见批 H 报告)─────────────────────────
//
// websocket_server.gd reply 构造原取 `response.result`,而 test_run/test_manage
// 返回 {"data": ...} —— Dictionary 点访问不存在的键 = SCRIPT ERROR,coroutine
// 在 reply 发送前中断 → test_run editor 路径挂死(客户端超时)。批 H 修复为
// `response.get("result", response.get("data"))` 后 test_run 结果可读,本文件
// 对 driver 套件结果做 passed/failed 断言(反假绿)。
//
// ─── 4.6.3 兼容缺陷导致的 deferred(前序生产 bug,不属本批修,记报告 concerns)───
//
// editor 实测(Godot 4.6.3)发现 CMP-14 Phase 2/3 三处在该版本不可用:
//   a) debug_evaluate: session.send_message("evaluate") 导致游戏进程退出
//      (纯净环境复验,godotProcs 2→1) —— 协议在 4.6.3 上不被游戏侧接受;
//   b) debug_inspect_frame: select_frame 的栈 Tree metadata 假设不成立
//      (-32001 "frame 0 not found in stack tree",NIT-5 预言未验证);
//   c) stack_frame_var 信号签名不匹配(editor log: "expected 4 argument(s),
//      but called with 2")→ 变量收集失效,vars 恒空。
// 故链路用例以 debug_step 替代 inspect_frame/evaluate 步骤(step 在 4.6.3 实测
// 完全可用:stepped:true + 落点断点行+1),后两者待生产修复后补真跑。
//
// ─── 运行方式 ───
//
//   cd D:/GitHub/godot-mcp-enhanced
//   GODOT_PATH="D:/godot/Godot_v4.6.3-stable_win64.exe" \
//   E2E_EDITOR=1 \
//   npx vitest run test/e2e-debug-tools.test.ts
//
// 前提 fixture(test/fixtures/real-project):
//   - addons/godot_mcp_server/(gitignored 本地副本,从仓库根 addons/ 复制)
//   - tests/test_debug_driver.gd + scripts/debug_breakpoint_target.gd +
//     scenes/debug/breakpoint_target.tscn(本批新增,进 git)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { EditorToolExecutor } from '../src/core/EditorToolExecutor.js';
import { readEditorSecret } from '../src/core/editor-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 守卫条件(对齐 e2e-resilience-editor 范式)────────────────────────────────
const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);

const REAL_PROJECT = resolve(__dirname, 'fixtures', 'real-project');
const hasProject =
  existsSync(REAL_PROJECT) &&
  existsSync(resolve(REAL_PROJECT, 'project.godot')) &&
  existsSync(resolve(REAL_PROJECT, 'addons', 'godot_mcp_server', 'plugin.cfg'));
// driver 套件 + 断点目标 fixture 必须在(本批新增,git 跟踪)
const hasDebugFixture =
  existsSync(resolve(REAL_PROJECT, 'tests', 'test_debug_driver.gd')) &&
  existsSync(resolve(REAL_PROJECT, 'scripts', 'debug_breakpoint_target.gd')) &&
  existsSync(resolve(REAL_PROJECT, 'scenes', 'debug', 'breakpoint_target.tscn'));

const hasEditorFlag = !!process.env.E2E_EDITOR;
const canRun = hasGodot && hasProject && hasDebugFixture && hasEditorFlag;

// ─── 反假绿 stderr 告警(未启用时显式提示,不静默假绿)───
if (!canRun) {
  const reasons: string[] = [];
  if (!hasGodot) reasons.push(`GODOT_PATH 未设或不存在(当前: ${GODOT_PATH || '<空>'})`);
  if (!hasProject) reasons.push(`real-project fixture 不完整(需 project.godot + addons/godot_mcp_server/plugin.cfg): ${REAL_PROJECT}`);
  if (!hasDebugFixture) reasons.push('debug fixture 缺失(需 tests/test_debug_driver.gd + scripts/debug_breakpoint_target.gd + scenes/debug/breakpoint_target.tscn)');
  if (!hasEditorFlag) reasons.push('E2E_EDITOR=1 未设(需 GUI editor + 自管 spawn)');
  process.stderr.write(
    `[E2E-SKIP] e2e-debug-tools 未启用。原因: ${reasons.join('; ')}\n` +
    `  本测试需真实 Godot editor 运行游戏进程(mcp-enhanced 插件 + WebSocket 9090)。\n` +
    `  开发者本机运行步骤:\n` +
    `    1. 复制插件到 fixture(若未做): cp -r addons/godot_mcp_server test/fixtures/real-project/addons/\n` +
    `    2. GODOT_PATH="<godot.exe>" E2E_EDITOR=1 npx vitest run test/e2e-debug-tools.test.ts\n`,
  );
}

// ─── 常量 ────────────────────────────────────────────────────────────────────
const EDITOR_PORT = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);
const BP_RES = 'res://scripts/debug_breakpoint_target.gd';
const BP_ABS = resolve(REAL_PROJECT, 'scripts', 'debug_breakpoint_target.gd');

/** 断点行号:按 `# BREAKPOINT:` 标记行(带冒号)动态定位。
 *  必须匹配带冒号形式 —— 脚本头部注释里有 "按 `# BREAKPOINT` 标记行" 的提及性文字,
 *  无冒号区分时 findIndex 会先命中注释行,断点设在注释行上永不命中(批 H 实测踩坑)。 */
function findBreakpointLine(): number {
  const lines = readFileSync(BP_ABS, 'utf-8').split(/\r?\n/);
  const idx = lines.findIndex((l) => /#\s*BREAKPOINT:/.test(l));
  if (idx < 0) throw new Error(`断点标记 '# BREAKPOINT:' 未找到于 ${BP_ABS}`);
  return idx + 1; // 1-based(debug_set_breakpoint 契约)
}

/** TCP probe 9090 是否 LISTEN(e2e-resilience-editor 同款,真实 WS 就绪信号)。 */
function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve_) => {
    const sock = net.connect({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve_(true); });
    sock.once('error', () => { sock.destroy(); resolve_(false); });
  });
}

/** JSON.parse 容错(null/非 JSON 均返 undefined,调用方按需窄化)。 */
function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** frames[0] 的 line 提取 helper(落点断言用)。 */
function frameZeroLine(parsed: Record<string, unknown> | undefined): number | undefined {
  const frames = parsed?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const f0 = frames[0] as Record<string, unknown>;
  return typeof f0.line === 'number' ? f0.line : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// e2e debug tools: spawn editor + 断点链路 + A2 互斥 + Phase 1 管理
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!canRun)('e2e debug tools (editor): 断点链路 + A2 互斥 + Phase 1 管理', () => {
  let editor: ChildProcess | null = null;
  let conn: EditorConnection | null = null;
  let exec: EditorToolExecutor | null = null;

  /** debug 组工具调用 helper:返回 { isError, text, parsed(result 字典) }。 */
  async function execDebug(
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; text: string; parsed: Record<string, unknown> | undefined }> {
    const r = await exec!.execute('debug', { project_path: REAL_PROJECT, action, ...extra });
    const c = r.content[0];
    const text = c && c.type === 'text' ? c.text : JSON.stringify(c);
    return { isError: r.isError === true, text, parsed: safeParse(text) };
  }

  /** 轮询 debug_stack_trace 直到 breaked===true 且 frames 非空。
   *  frames 必须纳入等待条件:breaked 翻 true 的瞬间 stack_dump 消息可能尚未
   *  落地(frames:[] 但 breaked:true,settle 的 stack_landed 对 has_stackdump=false
   *  的 state 立即放行)——批 H 实测时序,只等 breaked 会拿到空栈。 */
  async function waitForBreaked(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const r = await execDebug('stack_trace');
      const framesOk = Array.isArray(r.parsed?.frames) && (r.parsed?.frames as unknown[]).length > 0;
      if (!r.isError && r.parsed && r.parsed.breaked === true && framesOk) return r.parsed;
      last = r.parsed ?? { raw: r.text };
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`waitForBreaked 超时(${timeoutMs}ms),最后一次 stack_trace: ${JSON.stringify(last)}`);
  }

  beforeAll(async () => {
    // .godot 缓存清理(对齐 e2e-resilience-editor.test.ts:165 模式):防陈旧 import
    // 缓存让新增 fixture(断点脚本/场景/driver 套件)不被发现 → 假红。
    rmSync(resolve(REAL_PROJECT, '.godot'), { recursive: true, force: true });

    // spawn editor 非 detached(可 kill)+ 等就绪(WS 9090 LISTEN)
    editor = spawn(GODOT_PATH, ['--editor', '--path', REAL_PROJECT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GODOT_MCP_EDITOR_PERSISTENT_SECRET: 'true' },
    });
    editor.on('exit', (code) => {
      if (editor && editor.exitCode !== null && code !== 0) {
        process.stderr.write(`[E2E-DIAG] editor exit code=${code}\n`);
      }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await isPortOpen(EDITOR_PORT, '127.0.0.1')) break;
      if (editor.exitCode !== null) throw new Error(`editor 启动后立即退出(exitCode=${editor.exitCode})`);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (editor.exitCode !== null) throw new Error('editor 30s 内未就绪');

    const secret = readEditorSecret(REAL_PROJECT);
    if (!secret) throw new Error(`未能从 ${REAL_PROJECT}/.godot/mcp_editor.key 读 secret`);

    conn = new EditorConnection({
      host: '127.0.0.1', port: EDITOR_PORT, secret,
      reconnect: false, // 本文件不 kill editor,无需重连
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    });
    await conn.connect();
    exec = new EditorToolExecutor(conn);
  }, 60_000);

  afterAll(async () => {
    // 顺序:先停游戏(kill editor 前显式停,防游戏进程残留 —— Windows 上
    // TerminateProcess 不杀子树)→ 断连 → kill editor → 给 OS 回收端口时间。
    if (exec && conn && conn.isConnected()) {
      try {
        // test_name 'stop_' 只匹配 test_stop_playing('play' 会误匹配两者,见文件头注释)
        await exec.execute('testing', {
          project_path: REAL_PROJECT, action: 'run',
          suite: 'debug_driver', test_name: 'stop_',
        });
      } catch { /* best effort */ }
    }
    try { conn?.disconnect(); } catch { /* best effort */ }
    if (editor && editor.exitCode === null) {
      try { editor.kill('SIGKILL'); } catch { /* best effort */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }, 60_000);

  // ─── 用例 1: 链路 happy path ────────────────────────────────────────────────
  it('断点链路: set_breakpoint → play → stack_trace(断点落点) → step over → continue', async () => {
    // 1. 设断点(标记行动态定位;_toggle_breakpoint 会自动 edit_script 打开 tab)
    const line = findBreakpointLine();
    const setRes = await execDebug('set_breakpoint', { path: BP_RES, line });
    expect(setRes.isError, `set_breakpoint 不应失败: ${setRes.text}`).not.toBe(true);
    expect(setRes.parsed?.enabled, 'set_breakpoint 应返回 enabled=true').toBe(true);

    // 2. 启动游戏(driver 套件 play_custom_scene)。test_name 是子串过滤,
    //    'play_and' 防止误匹配 test_stop_playing(见文件头注释)。
    const playRes = await exec!.execute('testing', {
      project_path: REAL_PROJECT, action: 'run',
      suite: 'debug_driver', test_name: 'play_and',
    });
    const pc = playRes.content[0];
    const pcText = pc && pc.type === 'text' ? pc.text : '';
    expect(playRes.isError, `driver play 不应失败: ${pcText}`).not.toBe(true);
    const playData = safeParse(pcText);
    expect(playData?.failed, `driver 套件不应有失败 test: ${pcText}`).toBe(0);
    expect(playData?.passed, 'driver 套件应有 1 个 passed(test_play_and_break)').toBe(1);

    // 3. 轮询 stack_trace 直到断点命中(游戏 spawn+脚本编译+首次 _process 需数秒)
    const st = await waitForBreaked(20_000);
    expect(st.breaked, '断点命中后 stack_trace.breaked 应为 true').toBe(true);
    const frames = st.frames;
    expect(Array.isArray(frames), 'frames 应为数组').toBe(true);
    expect((frames as unknown[]).length, 'frames 应非空(断点命中必有调用栈)').toBeGreaterThan(0);
    expect(typeof st.selected_frame, 'selected_frame 应为数字').toBe('number');
    // 落点强断言:frames[0] 正是断点标记行(防"任意 break 都算过"的假绿)
    expect(frameZeroLine(st.parsed ?? st), `frames[0].line 应为断点行 ${line}`).toBe(line);

    // 4. step over:单步执行(4.6.3 实测可用;inspect_frame/evaluate 因前序兼容
    //    bug deferred,见文件头注释)。step 返回 location(非 frames),落点 = 断点行 + 1。
    const step = await execDebug('step', { mode: 'over' });
    expect(step.isError, `step 不应失败: ${step.text}`).not.toBe(true);
    expect(step.parsed?.stepped, 'step 应返回 stepped=true').toBe(true);
    const stepLoc = step.parsed?.location as Record<string, unknown> | undefined;
    expect(stepLoc?.line, `step over 落点应为断点行+1(${line + 1}),实际 ${JSON.stringify(stepLoc)}`).toBe(line + 1);
    expect(String(stepLoc?.file ?? ''), 'step 落点 file 应为断点目标脚本').toContain('debug_breakpoint_target.gd');

    // 5. continue: 恢复运行(循环断点脚本下一帧会再 break,供用例 2 复用)
    const cont = await execDebug('continue');
    expect(cont.isError, `continue 不应失败: ${cont.text}`).not.toBe(true);
    expect(cont.parsed?.resumed, 'continue 应返回 resumed=true').toBe(true);
  }, 120_000);

  // ─── 用例 2: A2 互斥(运行时验证 websocket_server.gd _debug_in_flight 守卫)───
  it('A2 互斥: 并发 step + stack_trace,恰一个被 -32000 in-flight 拒绝', async () => {
    // 前置:用例 1 continue 后循环断点下一帧再 break。等 breaked。
    await waitForBreaked(15_000);

    // 并发对:不走 exec.execute(executeChain 串行化造不出并发),直发 conn.request。
    // 两个 request 同一事件循环 tick 连续 ws.send → editor 同帧 drain 两个 packet:
    // pkt1(step)置 _debug_in_flight=true 后挂起(press + await_new_break 轮询,
    // 实测挂起窗 ~700ms)→ pkt2(stack_trace)见 flag → -32000 拒。
    // (第一个挂起请求用 step 而非 evaluate:evaluate 的 send_message 在 4.6.3
    // 上会杀死游戏进程 —— 前序生产 bug,见文件头 deferred 注释。)
    const TIMEOUT = { timeoutMs: 15_000 };
    const p1 = conn!.request('debug_step', { mode: 'over' }, TIMEOUT);
    const p2 = conn!.request('debug_stack_trace', {}, TIMEOUT);
    const settled = await Promise.allSettled([p1, p2]);

    const results = settled.map((s, i) => {
      if (s.status === 'fulfilled') {
        return { i, ok: true as const, value: s.value };
      }
      const e = s.reason as Error & { code?: unknown };
      return { i, ok: false as const, message: e?.message ?? String(s.reason), code: e?.code };
    });
    process.stderr.write(`[A2-mutex] 并发结果: ${JSON.stringify(results.map((r) => ({ ok: r.ok, code: r.code, msg: r.ok ? r.value : r.message })))}\n`);

    // 核心断言:恰好一个被拒,且拒绝码/文案符合 A2 守卫(-32000 + "in flight")
    const rejected = results.filter((r) => !r.ok);
    expect(rejected.length, `应恰好 1 个请求被拒(实际 ${rejected.length})——0 个=互斥守卫失效,2 个=两请求都被拒异常`).toBe(1);
    expect(rejected[0]!.code, '被拒请求 code 应为 -32000(A2 守卫)').toBe(-32000);
    expect(String(rejected[0]!.message), '拒绝 message 应含 "in flight"').toContain('in flight');

    // 另一个应成功(反假绿:不是"都错了一个碰巧像互斥")——成功侧是 step(pkt1)
    const okd = results.filter((r) => r.ok);
    expect(okd.length, '另一个请求应成功').toBe(1);
    expect(okd[0]!.i, '成功侧应为先 drain 的 step(pkt1)').toBe(0);
    const okVal = okd[0]!.ok ? (okd[0]!.value as Record<string, unknown>) : {};
    expect(okVal.stepped, '成功侧 step 应 stepped=true').toBe(true);

    // 清场:恢复游戏运行(防 afterAll 停止时卡在 breaked)
    try {
      await execDebug('continue');
    } catch { /* best effort:游戏可能已自行结束 */ }
  }, 120_000);

  // ─── 用例 3: Phase 1 断点管理(list/clear,同步 method)──────────────────────
  it('Phase 1: list_breakpoints 按 path 过滤可见 → clear → list 归零', async () => {
    const line = findBreakpointLine();

    // list(set_breakpoint 的 edit_script 已把目标脚本设为当前 tab;list 按 path 过滤)
    const listRes = await execDebug('list_breakpoints', { path: BP_RES });
    expect(listRes.isError, `list_breakpoints 不应失败: ${listRes.text}`).not.toBe(true);
    const bps = listRes.parsed?.breakpoints;
    expect(Array.isArray(bps), 'breakpoints 应为数组').toBe(true);
    const mine = (bps as Array<Record<string, unknown>>).find((b) => b.path === BP_RES);
    expect(mine?.path, `list 应含 ${BP_RES} 的断点(实际: ${JSON.stringify(bps)})`).toBe(BP_RES);
    expect((mine!.lines as unknown[]), `断点行应含标记行 ${line}`).toContain(line);

    // clear
    const clr = await execDebug('clear_breakpoint', { path: BP_RES, line });
    expect(clr.isError, `clear_breakpoint 不应失败: ${clr.text}`).not.toBe(true);
    expect(clr.parsed?.enabled, 'clear 后 enabled 应为 false').toBe(false);

    // list 归零
    const list2 = await execDebug('list_breakpoints', { path: BP_RES });
    expect(list2.isError, 'clear 后 list 不应失败').not.toBe(true);
    const bps2 = (list2.parsed?.breakpoints ?? []) as Array<Record<string, unknown>>;
    const mine2 = bps2.find((b) => b.path === BP_RES);
    expect(mine2 ?? { lines: [] }, 'clear 后该脚本不应再有断点行').toEqual(expect.objectContaining({ lines: [] }));
  }, 60_000);

  // ─── 用例 4: 错过窗口回归(issue #63,2026-08-23)─────────────────────────────
  it('错过窗口(issue #63): play 后不查询等 break 完成,首次 stack_trace 应拿到 frames', async () => {
    // 根因(4.7 实测):引擎只在 break 瞬间请求一次 get_stack_dump → 面板只 emit 一次
    // stack_dump 信号;若 set_breakpoint/play 到首次 stack_trace 之间面板信号未连接
    // (CI editor 首次导入期首个请求可延迟数秒),信号永久丢失,frames 恒空 → 20s 超时
    // (issue #63 的 CI 失败模式)。修复:set_breakpoint 提前 ensure_connected(层2)+
    // stack_trace 的 refetch_stack 补拉(层1)。本用例确定性复现该窗口:play 后
    // 刻意等 8s(>> 游戏 spawn+编译+首帧断点)不发任何 debug 查询,再首次查询。
    const line = findBreakpointLine();

    // 清场:用例 1-3 的游戏可能还在跑(循环断点),stop 后重新起干净一局
    await exec!.execute('testing', {
      project_path: REAL_PROJECT, action: 'run',
      suite: 'debug_driver', test_name: 'stop_',
    });

    // 1. 设断点 —— 层2:此刻应已把面板 stack_dump 兜底信号连接好
    const setRes = await execDebug('set_breakpoint', { path: BP_RES, line });
    expect(setRes.isError, `set_breakpoint 不应失败: ${setRes.text}`).not.toBe(true);

    // 2. play
    const playRes = await exec!.execute('testing', {
      project_path: REAL_PROJECT, action: 'run',
      suite: 'debug_driver', test_name: 'play_and',
    });
    expect(playRes.isError, 'driver play 不应失败').not.toBe(true);

    // 3. 【窗口模拟】8 秒内不发任何 stack_trace 类查询(不触发 ensure_connected
    //    重试路径),让游戏 break + 一次性 stack_dump 信号在"无人监听"下 emit 完
    await new Promise((r) => setTimeout(r, 8_000));

    // 4. 首次 stack_trace:修复前此处 frames 恒空(信号已错过,不自愈);修复后
    //    层2 已在 set_breakpoint 时连好信号(等待期接住),层1 补拉再兜底
    const st = await execDebug('stack_trace');
    expect(st.isError, `stack_trace 不应失败: ${st.text}`).not.toBe(true);
    expect(st.parsed?.breaked, '8s 后游戏应已 break 在断点').toBe(true);
    const frames = st.parsed?.frames;
    expect(Array.isArray(frames) && frames.length > 0,
      `首次查询 frames 应非空(一次性 stack_dump 信号未因错过而丢失): ${st.text}`).toBe(true);
    expect(frameZeroLine(st.parsed), `frames[0].line 应为断点行 ${line}`).toBe(line);

    // 清场:恢复运行(防 afterAll 停止时卡在 breaked)
    try { await execDebug('continue'); } catch { /* best effort */ }
  }, 120_000);
});
