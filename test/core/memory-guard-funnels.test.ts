// test/core/memory-guard-funnels.test.ts
//
// memory-guard 一期 Task 4:七处 Godot spawn 点漏斗接线的行为契约测试。
//
// 覆盖(brief 测试清单①-⑥):
//  ① runGutProcess 拒——run_tests 分片路径(主炸弹链闸门锚)+ 单片路径 + 过态释放;
//  ② run_project 拒/过两态 + 先停旧释放被停会话租约(顺序断言);
//  ③ launch_editor 双入口(工具层行为级 + Web GUI 复刻链源码级)exemptChecks:true;
//  ④ spawnGodot 拒 → validation 消费链(batchValidateScripts)返回 denial 文本;
//  ⑤ executor / screenshot / headless-process(runGodotHeadless) 拒路径各一条 + 过态释放;
//  ⑥ run_project 既有成功前缀文本契约回归(Running project at / Preview mode: / Bridge ready.)。
//  ⑦ 看门狗杀归因接线(Task 5)——executor close 命中 wasMemKilled → mem_budget_exceeded
//    标志 + 归因 run_error,parseGdscriptResult 改报 MEM_BUDGET_EXCEEDED;未命中回归锚
//    (原 Process exited 路径);run_tests 单片被杀 → opsErrorResult MEM_BUDGET_EXCEEDED;
//    run_project 会话被杀 → get_debug_output 附 mem_budget_exceeded 与 errors 归因行。
//    审查补测 I-1/I-2:stop_project 两条归因路径(停止分支 killProcess-等-close 窗口 +
//    no-running 分支)+ 分片模式 mem_killed 归因链,均含命中/未命中回归锚。
//
// mock 策略:memory-guard 模块 vi.mock 接管 acquireLease/bindLeasePid/releaseLease
// (projectPathFromArgs 等纯函数透传真身);child_process.spawn 可控假 proc;process-state
// 仅 stub 杀进程/PID 注册项,分桶 API 透传真身(对齐 runtime.test.js 的 I-4 策略);
// 其余模块 importOriginal 定向 stub,防缺导出炸裂。
// 测试环境守卫:test/setup.js 全局 GODOT_MCP_MEMORY_GUARD=0 只影响未 mock 真身的既有
// 测试(零 PowerShell / 零租约写盘);本文件 acquireLease 被完整接管,env 值无关。

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── memory-guard mock:三函数可控 spy,纯函数(projectPathFromArgs)透传真身 ──
const memguard = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  bindLeasePid: vi.fn(),
  releaseLease: vi.fn(),
}));
vi.mock('../../src/core/memory-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/memory-guard.js')>();
  return { ...actual, ...memguard };
});

// ── child_process mock:spawn 可控(测试逐用例注入假 proc),其余导出透传 ──
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

// ── process-state mock:杀进程/PID 注册 stub(防真杀),分桶 API 透传真身 ──
vi.mock('../../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/process-state.js')>();
  return {
    ...actual,
    killProcess: vi.fn(async () => {}),
    forceKillTree: vi.fn(),
    registerSpawnedGodotPid: vi.fn(),
    unregisterSpawnedGodotPid: vi.fn(),
  };
});

// ── godot-finder:checkVersionMismatch/detectGodotVersion stub(防真读 config/版本探测) ──
vi.mock('../../src/core/godot-finder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/godot-finder.js')>();
  return {
    ...actual,
    checkVersionMismatch: vi.fn(async () => null),
    detectGodotVersion: vi.fn(async () => '4.6.stable'),
  };
});

// ── game-bridge:isBridgeReady 可控(⑥ wait_for_bridge 文本契约) ──
const bridgeReadyMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/tools/game-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/game-bridge.js')>();
  return { ...actual, isBridgeReady: bridgeReadyMock };
});

// ── mem-watchdog mock(⑦ 归因接线):wasMemKilled 可控,其余导出透传真身(formatMemKillMessage
//    纯函数保真——断言真实报文模板,而非 mock 回声) ──
const wasMemKilledMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/mem-watchdog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/mem-watchdog.js')>();
  return { ...actual, wasMemKilled: wasMemKilledMock };
});

// ── import-check:needsImport 恒 false(跳过 executor 的 import warmup) ──
vi.mock('../../src/tools/import-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/import-check.js')>();
  return { ...actual, needsImport: vi.fn(() => false) };
});

// ── logger:no-op spy(executor audit info / runtime 错误日志不落盘) ──
vi.mock('../../src/core/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/logger.js')>();
  return {
    ...actual,
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

// ── fs/promises:readdir → [](跳过 executor cleanupOldSessions 扫描,对齐 P0-3 范式) ──
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(async () => []) };
});

import { handleTool as runtimeHandleTool } from '../../src/tools/runtime.js';
import { executeGdscript } from '../../src/gdscript-executor.js';
import { parseGdscriptResult } from '../../src/tools/shared.js';
import { killProcess } from '../../src/core/process-state.js';   // mock 面内的可控注入(I-1)
import { captureScreenshot } from '../../src/screenshot.js';
import { spawnGodot } from '../../src/tools/spawn-helper.js';
import { batchValidateScripts } from '../../src/tools/validation.js';
import { runGodotHeadless } from '../../src/core/godot-spawn.js';
import { resetState } from '../../src/core/process-state.js';
import type { ToolContext } from '../../src/types.js';

// ── 真实 tmp 夹具(不 mock fs):project.godot + test/*.gd 供分片枚举;假 godot 二进制 ──
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'mg-funnels-'));
const TMP_PROJECT = join(TMP_ROOT, 'proj');
const GODOT_BIN = join(TMP_ROOT, 'godot-fake.exe');
mkdirSync(join(TMP_PROJECT, 'test'), { recursive: true });
writeFileSync(join(TMP_PROJECT, 'project.godot'), '; fake project\n', 'utf-8');
writeFileSync(join(TMP_PROJECT, 'test', 'a_test.gd'), 'extends GutTest\n', 'utf-8');
writeFileSync(join(TMP_PROJECT, 'test', 'b_test.gd'), 'extends GutTest\n', 'utf-8');
writeFileSync(GODOT_BIN, '', 'utf-8');

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 假子进程(EventEmitter 形态,对齐 gdscript-executor-timeout.test.ts 范式)。
 *  exitCode 显式置 null:真 ChildProcess 的初值就是 null,killProcess / acquireProcessSlot /
 *  run_project 停旧段判活都按 `=== null` 严格比较——夹具留 undefined 会被当成「已退出」。 */
function fakeProc(pid: number) {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number; killed: boolean; exitCode: number | null;
    stdout: EventEmitter; stderr: EventEmitter;
    unref: ReturnType<typeof vi.fn>;
    kill: () => boolean;
  };
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.unref = vi.fn();
  proc.kill = function (this: { killed: boolean }) { this.killed = true; return true; };
  return proc;
}

/** 默认过态租约;测试按需 mockImplementationOnce 覆盖。 */
const OK_LEASE_ID = 'lease-ok';
function defaultLease() { return { lease: { id: OK_LEASE_ID } }; }

function makeDenial(code = 'MEMGUARD_BUDGET') {
  return { denial: { code, message: `[${code}] 测试拒绝:mock 注入` } };
}

/** runtime 工具 ctx(对齐 runtime.test.js 的 createMockCtx 最小面)。 */
function makeCtx(): ToolContext {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => GODOT_BIN),
    projectDir: TMP_PROJECT,
    setProjectDir: vi.fn(),
  } as unknown as ToolContext;
}

/** ToolResult → 文本。 */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content[0]?.text ?? '';
}

beforeEach(() => {
  memguard.acquireLease.mockClear();
  memguard.bindLeasePid.mockClear();
  memguard.releaseLease.mockClear();
  spawnMock.mockReset();
  bridgeReadyMock.mockReset();
  memguard.acquireLease.mockImplementation(() => defaultLease());
  resetState();
});

// ─── ① runGutProcess 漏斗(run_tests 分片 + 单片,主炸弹链) ────────────────────

describe('① run_tests 漏斗(runGutProcess)', () => {
  it('分片路径拒:acquireLease(gut_shard) 返回 denial → 整轮返回 MEMGUARD 错误且 spawn 未被调', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_BUDGET'));
    const r = await runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, shards: 2, timeout: 5,
    }, makeCtx());
    expect(r).not.toBeNull();
    expect((r as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(textOf(r!)) as { error_code: string; error: string };
    expect(parsed.error_code).toBe('MEMGUARD_BUDGET');
    expect(parsed.error).toContain('MEMGUARD_BUDGET');
    // 准入调用:kind=gut_shard,projectPath 从 args --path 解析
    expect(memguard.acquireLease).toHaveBeenCalledWith('gut_shard', TMP_PROJECT);
    // 主炸弹锚:拒即不 spawn
    expect(spawnMock).not.toHaveBeenCalled();
    // 未获租约不得有 bind/release
    expect(memguard.bindLeasePid).not.toHaveBeenCalled();
  });

  it('单片路径拒:shards=1 同款 denial 透传', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_LOW_WATER'));
    const r = await runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, timeout: 5,
    }, makeCtx());
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r!)).toContain('MEMGUARD_LOW_WATER');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('过态:spawn 后 bindLeasePid(leaseId, pid),进程退出 releaseLease(leaseId)', async () => {
    const proc = fakeProc(4101);
    spawnMock.mockImplementation(() => proc);
    const r = await runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, timeout: 5,
    }, makeCtx());
    // 单片模式返回 JSON 统计(非 isError)
    expect((r as { isError?: boolean }).isError).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4101);
    proc.emit('close', 0);
    // close 事件异步触发 → 轮询等 releaseLease 落地
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
    void r;
  });
});

// ─── ② run_project 漏斗(game_window)─────────────────────────────────────────

describe('② run_project 漏斗(game_window)', () => {
  it('拒:acquireLease(game_window) 返回 denial → 不 spawn,返回 MEMGUARD 错误', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_INSTANCE_CAP'));
    const r = await runtimeHandleTool('runtime', {
      action: 'run_project', project_path: TMP_PROJECT,
    }, makeCtx());
    expect(r).not.toBeNull();
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r!)).toContain('MEMGUARD_INSTANCE_CAP');
    expect(memguard.acquireLease).toHaveBeenCalledWith('game_window', TMP_PROJECT);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('过态:bindLeasePid + 成功前缀 Running project at,close 后 releaseLease', async () => {
    const proc = fakeProc(4201);
    spawnMock.mockImplementation(() => proc);
    const r = await runtimeHandleTool('runtime', {
      action: 'run_project', project_path: TMP_PROJECT,
    }, makeCtx());
    expect((r as { isError?: boolean }).isError).toBeUndefined();
    // ⑥ 文本契约:成功前缀不动(GodotServer.ts / qa/runner.ts 按前缀/子串匹配)
    expect(textOf(r!)).toMatch(/^Running project at /);
    expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4201);
    proc.emit('close', 0);
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
  });

  it('先停旧:第二轮 run 在 acquireLease 之前释放被停会话的旧租约', async () => {
    const proc1 = fakeProc(4301);
    const proc2 = fakeProc(4302);
    memguard.acquireLease
      .mockImplementationOnce(() => ({ lease: { id: 'lease-run1' } }))
      .mockImplementationOnce(() => ({ lease: { id: 'lease-run2' } }));
    spawnMock.mockImplementationOnce(() => proc1).mockImplementationOnce(() => proc2);

    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());

    // 旧租约被释放(停旧段主动归还——proc1 不 emit close,唯一释放通道即停旧逻辑)
    expect(memguard.releaseLease).toHaveBeenCalledWith('lease-run1');
    // 顺序:释放旧租约先于第二次 acquireLease(防自家旧租约占新预算)
    const relOld = memguard.releaseLease.mock.calls.findIndex(c => c[0] === 'lease-run1');
    expect(relOld).toBeGreaterThanOrEqual(0);
    const relOrder = memguard.releaseLease.mock.invocationCallOrder[relOld]!;
    const acq2Order = memguard.acquireLease.mock.invocationCallOrder[1]!;
    expect(relOrder).toBeLessThan(acq2Order);
    // 新租约正常绑定新进程
    expect(memguard.bindLeasePid).toHaveBeenCalledWith('lease-run2', 4302);
  });

  it('spawn 游戏 env 注入 GODOT_MCP_BRIDGE_OWNER_PID=本 server pid(默认 spawn 分支)', async () => {
    const proc = fakeProc(4221);
    spawnMock.mockImplementation(() => proc);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    const env = spawnMock.mock.calls[0]![2]!.env as Record<string, string>;
    expect(env.GODOT_MCP_BRIDGE_OWNER_PID).toBe(String(process.pid));
  });
});

// ─── ③ launch_editor 双入口(editor 豁免检查必记账)──────────────────────────

describe('③ launch_editor 漏斗(editor)', () => {
  it('工具层:acquireLease(editor, {exemptChecks:true}) → spawn → bindLeasePid,子进程 close 释放', async () => {
    const child = fakeProc(4401);
    spawnMock.mockImplementation(() => child);
    const r = await runtimeHandleTool('runtime', {
      action: 'launch_editor', project_path: TMP_PROJECT,
    }, makeCtx());
    expect((r as { isError?: boolean }).isError).toBeUndefined();
    expect(memguard.acquireLease).toHaveBeenCalledWith('editor', TMP_PROJECT, { exemptChecks: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4401);
    child.emit('close', 0);
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
  });

  it('Web GUI 复刻链(GodotServer.editProject):源码级断言同款 editor 豁免记账', () => {
    const src = readFileSync(join(__dirname, '../../src/GodotServer.ts'), 'utf-8');
    const start = src.indexOf('editProject: async');
    expect(start).toBeGreaterThan(0);
    const seg = src.slice(start, start + 1200);
    expect(seg).toMatch(/acquireLease\(\s*'editor'/);
    expect(seg).toMatch(/exemptChecks:\s*true/);
  });

  // ── 终审 I-1(2026-11-22):launch_editor 双入口的租约泄漏缺口 ──────────────────
  // (b) findGodot 前置于 acquireLease:环境级失败(GODOT_PATH 配错/PATH 无 godot)
  //     不得留下已建租约;(c) spawn 同步抛时 error/close handler 均未注册,须归还租约再抛。

  it('终审 I-1(b):findGodot 失败(环境级)抛错时 acquireLease 未被调——findGodot 前置于准入,零租约副作用', async () => {
    const ctx = makeCtx();
    (ctx.findGodot as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('godot not found (GODOT_PATH misconfigured)');
    });
    await expect(runtimeHandleTool('runtime', {
      action: 'launch_editor', project_path: TMP_PROJECT,
    }, ctx)).rejects.toThrow(/godot not found/);
    expect(memguard.acquireLease).not.toHaveBeenCalled();   // 无租约可泄漏
    expect(memguard.releaseLease).not.toHaveBeenCalled();
  });

  it('终审 I-1(c):spawn 同步抛 → releaseLease 归还租约再 rethrow(error/close handler 均未注册)', async () => {
    spawnMock.mockImplementation(() => { throw new Error('sync spawn boom'); });
    await expect(runtimeHandleTool('runtime', {
      action: 'launch_editor', project_path: TMP_PROJECT,
    }, makeCtx())).rejects.toThrow(/sync spawn boom/);
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
  });
});

// ─── ④ spawnGodot 漏斗(spawn-helper,validation/workflow/scene/batch/android 共用)───

describe('④ spawnGodot 漏斗(headless)', () => {
  it('拒:denial 形态 SPAWN_FAILED + 结构化 denial 字段,spawn 未被调', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_BUDGET'));
    const r = await spawnGodot(GODOT_BIN, ['--headless', '--path', TMP_PROJECT, '--quit'], { timeoutMs: 1000 });
    expect(r.denial).toEqual({ code: 'MEMGUARD_BUDGET', message: expect.stringContaining('MEMGUARD_BUDGET') });
    expect(r.output).toContain('SPAWN_FAILED');
    expect(r.output).toContain('MEMGUARD_BUDGET');
    expect(r.exitCode).toBe(-1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(memguard.acquireLease).toHaveBeenCalledWith('headless', TMP_PROJECT);
  });

  it('validation 消费链:batchValidateScripts 拿到 denial 文本(SPAWN_ERROR 通道自动透传)', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_LOW_WATER'));
    const results = await batchValidateScripts(GODOT_BIN, TMP_PROJECT, [join(TMP_PROJECT, 'test', 'a_test.gd')], 2000);
    expect(results.length).toBeGreaterThan(0);
    const all = JSON.stringify(results);
    expect(all).toContain('MEMGUARD_LOW_WATER');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('过态:bindLeasePid + close 后 releaseLease', async () => {
    const proc = fakeProc(4501);
    spawnMock.mockImplementation(() => proc);
    void await spawnGodot(GODOT_BIN, ['--headless', '--path', TMP_PROJECT, '--quit'], { timeoutMs: 5000 });
    expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4501);
    proc.emit('close', 0);
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
  });
});

// ─── ⑤ executor / screenshot / headless-process 拒路径 ───────────────────────

describe('⑤ executor 漏斗(headless)', () => {
  it('拒:compile_error 携带 MEMGUARD 码,spawn 未被调', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_BUDGET'));
    const r = await executeGdscript({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT, code: 'var x := 1', timeout: 5,
    });
    expect(r.success).toBe(false);
    expect(r.compile_error).toContain('MEMGUARD_BUDGET');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(memguard.acquireLease).toHaveBeenCalledWith('headless', TMP_PROJECT);
    expect(memguard.bindLeasePid).not.toHaveBeenCalled();
  });

  it('过态:bindLeasePid + close 后 releaseLease', async () => {
    const proc = fakeProc(4601);
    spawnMock.mockImplementation(() => proc);
    const p = executeGdscript({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT, code: 'var x := 1', timeout: 5,
    });
    // executeGdscript 在 spawn 前有多个 await(写临时脚本等),先等 bind 落地再 emit close
    await vi.waitFor(() => {
      expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4601);
    });
    proc.emit('close', 0);
    const r = await p;
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    void r;
  });
});

describe('⑤ screenshot 漏斗(headless)', () => {
  it('拒:success=false + error 携带 MEMGUARD 码,spawn 未被调', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_LOW_WATER'));
    const r = await captureScreenshot({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT,
      outputPath: join(TMP_ROOT, 'out.png'), timeout: 2,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('MEMGUARD_LOW_WATER');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(memguard.acquireLease).toHaveBeenCalledWith('headless', TMP_PROJECT);
  });

  it('过态:bindLeasePid + close 后 releaseLease', async () => {
    const proc = fakeProc(4701);
    spawnMock.mockImplementation(() => proc);
    const p = captureScreenshot({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT,
      outputPath: join(TMP_ROOT, 'out2.png'), timeout: 5,
    });
    await vi.waitFor(() => {
      expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4701);
    });
    proc.emit('close', 0);
    await p;
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
  });

  it('终审 I-1(c):spawn 同步抛 → 结构化失败返回(对齐异步 error 契约)且 releaseLease 归还租约', async () => {
    spawnMock.mockImplementation(() => { throw new Error('sync spawn boom'); });
    const r = await captureScreenshot({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT,
      outputPath: join(TMP_ROOT, 'out3.png'), timeout: 2,
    });
    expect(r.success).toBe(false);
    expect(r.godotOutput).toContain('Spawn error');
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
  });
});

describe('⑤ headless-process 漏斗(runGodotHeadless)', () => {
  it('拒:reject 携带 MEMGUARD 码,spawn 未被调', async () => {
    memguard.acquireLease.mockImplementation(() => makeDenial('MEMGUARD_INSTANCE_CAP'));
    await expect(runGodotHeadless(
      ['--headless', '--path', TMP_PROJECT, '--import'], GODOT_BIN, 5_000,
    )).rejects.toThrow(/MEMGUARD_INSTANCE_CAP/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(memguard.acquireLease).toHaveBeenCalledWith('headless', TMP_PROJECT);
  });

  it('过态:bindLeasePid + close 后 releaseLease', async () => {
    const proc = fakeProc(4801);
    spawnMock.mockImplementation(() => proc);
    const p = runGodotHeadless(['--headless', '--path', TMP_PROJECT, '--import'], GODOT_BIN, 5_000);
    proc.emit('close', 0);
    await p;
    expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 4801);
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
  });

  it('终审 I-1(c):spawn 同步抛 → releaseLease 归还租约后 reject(error/close handler 均未注册)', async () => {
    spawnMock.mockImplementation(() => { throw new Error('sync spawn boom'); });
    await expect(runGodotHeadless(
      ['--headless', '--path', TMP_PROJECT, '--import'], GODOT_BIN, 5_000,
    )).rejects.toThrow(/failed to spawn/);
    expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
  });
});

// ─── ⑥ run_project 既有成功前缀文本契约回归 ─────────────────────────────────

describe('⑥ run_project 成功前缀文本契约', () => {
  it('preview 态前缀 "Preview mode: game window is now open"', async () => {
    const proc = fakeProc(4901);
    spawnMock.mockImplementation(() => proc);
    const r = await runtimeHandleTool('runtime', {
      action: 'run_project', project_path: TMP_PROJECT, preview: true,
    }, makeCtx());
    expect(textOf(r!)).toMatch(/^Preview mode: game window is now open at /);
  });

  it('wait_for_bridge 态前缀 "Bridge ready."', async () => {
    bridgeReadyMock.mockImplementation(async () => ({ ready: true }));
    const proc = fakeProc(4902);
    spawnMock.mockImplementation(() => proc);
    const r = await runtimeHandleTool('runtime', {
      action: 'run_project', project_path: TMP_PROJECT, wait_for_bridge: true, timeout: 30,
    }, makeCtx());
    expect(textOf(r!)).toMatch(/^Bridge ready\. /);
  });

  // 同一项目连续五轮 run:第 2 轮起每轮都会「先停旧」杀掉上一轮的进程。
  it('四条成功响应前缀原样;先停旧时尾部附被杀 pid,首跑(无旧实例)不附', async () => {
    bridgeReadyMock.mockImplementation(async () => ({ ready: true }));
    memguard.acquireLease.mockImplementation(() => ({ lease: { id: 'lease-run' } }));
    const variants: Array<{ args: Record<string, unknown>; prefix: RegExp }> = [
      { args: {}, prefix: /^Running project at / },
      { args: {}, prefix: /^Running project at / },
      { args: { preview: true }, prefix: /^Preview mode: game window is now open at / },
      { args: { wait_for_bridge: true, timeout: 30 }, prefix: /^Bridge ready\. Running project at / },
      { args: { preview: true, wait_for_bridge: true, timeout: 30 }, prefix: /^Preview mode: bridge ready/ },
    ];
    const procs = variants.map((_, i) => fakeProc(5200 + i));
    spawnMock.mockReset();
    procs.forEach((p) => spawnMock.mockImplementationOnce(() => p));
    for (const [i, v] of variants.entries()) {
      const r = await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT, ...v.args }, makeCtx());
      expect(textOf(r!), `第 ${i} 轮`).toMatch(v.prefix);
      if (i === 0) {
        expect(textOf(r!)).not.toContain('killed previous');
      } else {
        expect(textOf(r!), `第 ${i} 轮`).toMatch(new RegExp(`\\(killed previous instance pid: ${5200 + i - 1}\\)$`));
      }
    }
  });

  // 审查 Important-1(修复轮 1):旧实例已退出但 close 事件尚未送达(用户刚关窗 / stop_project 的
  // kill 在途 / 残留 stdio 句柄拖住 close)——旧 proc 仍在桶里,killProcess 对它直接 resolve 不发
  // 信号,本次 run 什么都没杀,不得记成被杀。两种形态 = killProcess 早退的两个条件。
  it.each<[string, (p: ReturnType<typeof fakeProc>) => void]>([
    ['exitCode 已置(进程已退出)', (p) => { p.exitCode = 0; }],
    ['killed 已置(stop_project 的 kill 在途)', (p) => { p.killed = true; }],
  ])('旧实例已退出(%s)但 close 未送达 → 再 run 四条前缀照旧,不含 killed previous', async (_name, mutate) => {
    bridgeReadyMock.mockImplementation(async () => ({ ready: true }));
    memguard.acquireLease.mockImplementation(() => ({ lease: { id: 'lease-run' } }));
    const variants: Array<{ args: Record<string, unknown>; prefix: RegExp }> = [
      { args: {}, prefix: /^Running project at / },
      { args: { preview: true }, prefix: /^Preview mode: game window is now open at / },
      { args: { wait_for_bridge: true, timeout: 30 }, prefix: /^Bridge ready\. Running project at / },
      { args: { preview: true, wait_for_bridge: true, timeout: 30 }, prefix: /^Preview mode: bridge ready/ },
    ];
    for (const [i, v] of variants.entries()) {
      // 每个变体独立成场景:resetState 清桶,上一场景的旧进程不带入
      resetState();
      const oldProc = fakeProc(5301);
      const newProc = fakeProc(5302);
      spawnMock.mockReset();
      spawnMock.mockImplementationOnce(() => oldProc).mockImplementationOnce(() => newProc);
      await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());   // 首跑:旧实例入桶
      mutate(oldProc);                                                                                       // 随后退出/被杀,close 未送达
      const r = await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT, ...v.args }, makeCtx());
      expect(textOf(r!), `第 ${i} 个变体`).toMatch(v.prefix);
      expect(textOf(r!), `第 ${i} 个变体`).not.toContain('killed previous');
    }
  });

  // 对照(修复前后都绿,钉住最常见的那条路径):用户关窗且 close 已送达——close handler 里的
  // clearRunSession 已把桶里的 proc 清掉,再 run 根本不进停旧段,无从记被杀。
  it('旧实例 close 已送达(用户关窗后)→ 桶已清,再 run 无尾注', async () => {
    const oldProc = fakeProc(5351);
    const newProc = fakeProc(5352);
    spawnMock.mockReset();
    spawnMock.mockImplementationOnce(() => oldProc).mockImplementationOnce(() => newProc);
    const args = { action: 'run_project', project_path: TMP_PROJECT, preview: true };
    await runtimeHandleTool('runtime', args, makeCtx());
    oldProc.emit('close', 0);   // 用户关窗,close 事件送达
    const r = await runtimeHandleTool('runtime', args, makeCtx());
    expect(textOf(r!)).toMatch(/^Preview mode: game window is now open at /);
    expect(textOf(r!)).not.toContain('killed previous');
  });
});

// ─── ⑦ 看门狗杀归因接线(Task 5)─────────────────────────────────────────────

describe('⑦ 杀归因接线(wasMemKilled 消费)', () => {
  const GB2 = 1024 ** 3;

  beforeEach(() => {
    wasMemKilledMock.mockReset();
    wasMemKilledMock.mockReturnValue(null); // 安全默认:未命中(回归锚语义)
  });

  it('executor:close 命中归因 → mem_budget_exceeded 标志 + 归因 run_error,parseGdscriptResult 改报 MEM_BUDGET_EXCEEDED', async () => {
    const proc = fakeProc(5101);
    spawnMock.mockImplementation(() => proc);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 5101 ? { readingBytes: 5 * GB2, declaredMB: 1024, kind: 'headless' } : null);
    const p = executeGdscript({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT, code: 'var x := 1', timeout: 5,
    });
    await vi.waitFor(() => {
      expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 5101);
    });
    proc.emit('close', 1);   // 被杀进程退出码非 0,stdout 无 marker(半截输出)
    const r = await p;
    expect(r.mem_budget_exceeded).toBe(true);
    expect(r.run_error).toContain('内存预算超限被看门狗终止');
    expect(r.run_error).toContain('峰值 5.0 GB');
    expect(r.run_error).toContain('GODOT_MCP_DECLARED_MB_HEADLESS');   // 档位上调指引(kind 大写)
    // 消费链:parseGdscriptResult 优先报 MEM_BUDGET_EXCEEDED(注册表补全 retryable/category)
    const tr = parseGdscriptResult(r);
    const parsed = JSON.parse(tr.content[0]!.text!) as { error_code: string; retryable: boolean; error_category: string };
    expect(parsed.error_code).toBe('MEM_BUDGET_EXCEEDED');
    expect(parsed.retryable).toBe(false);
    expect(parsed.error_category).toBe('resource');
  });

  it('executor 回归锚:未命中归因 → 原路径(run_error=Process exited,无标志,仍报 SCRIPT_EXEC_FAILED)', async () => {
    const proc = fakeProc(5102);
    spawnMock.mockImplementation(() => proc);
    const p = executeGdscript({
      godotPath: GODOT_BIN, projectPath: TMP_PROJECT, code: 'var x := 1', timeout: 5,
    });
    await vi.waitFor(() => {
      expect(memguard.bindLeasePid).toHaveBeenCalledWith(OK_LEASE_ID, 5102);
    });
    proc.emit('close', 1);
    const r = await p;
    expect(r.mem_budget_exceeded).toBeUndefined();
    expect(r.run_error).toContain('Process exited with code 1');
    const tr = parseGdscriptResult(r);
    expect((JSON.parse(tr.content[0]!.text!) as { error_code: string }).error_code).toBe('SCRIPT_EXEC_FAILED');
  });

  it('run_tests 单片:被看门狗杀 → opsErrorResult MEM_BUDGET_EXCEEDED 附档位指引', async () => {
    const proc = fakeProc(5201);
    spawnMock.mockImplementation(() => proc);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 5201 ? { readingBytes: 17 * GB2, declaredMB: 8192, kind: 'gut_shard' } : null);
    // handleTool 等 close 才返回——先拿 promise,spawn 落地后 emit close(被杀进程退出码 1)
    const rPromise = runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, timeout: 5,
    }, makeCtx());
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled(); });
    proc.emit('close', 1);
    const r = await rPromise;
    expect((r as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(textOf(r!)) as { error_code: string; error: string; retryable: boolean };
    expect(parsed.error_code).toBe('MEM_BUDGET_EXCEEDED');
    expect(parsed.error).toContain('声明 8192MB×2');
    expect(parsed.error).toContain('GODOT_MCP_DECLARED_MB_GUT_SHARD');
    expect(parsed.retryable).toBe(false);
  });

  it('run_project 会话被杀:get_debug_output 附 mem_budget_exceeded 字段且 errors 含归因行', async () => {
    const proc = fakeProc(5301);
    spawnMock.mockImplementation(() => proc);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 5301 ? { readingBytes: 9.5 * GB2, declaredMB: 3072, kind: 'game_window' } : null);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    proc.emit('close', 1);   // 看门狗树杀 → close(code=1)
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
    const r = await runtimeHandleTool('runtime', {
      action: 'get_debug_output', project_path: TMP_PROJECT,
    }, makeCtx());
    const txt = textOf(r!);
    expect(txt).toContain('"mem_budget_exceeded"');                              // 结构化字段
    expect(txt).toContain('内存预算超限被看门狗终止');
    expect(txt).toContain('[MEM_BUDGET_EXCEEDED]');                              // 归因行进 errors 分类
    expect(txt).toContain('GODOT_MCP_DECLARED_MB_GAME_WINDOW');
  });

  it('run_project 回归锚:未被杀的自然退出 → get_debug_output 无 mem_budget_exceeded 字段', async () => {
    const proc = fakeProc(5302);
    spawnMock.mockImplementation(() => proc);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    proc.emit('close', 0);
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
    const r = await runtimeHandleTool('runtime', {
      action: 'get_debug_output', project_path: TMP_PROJECT,
    }, makeCtx());
    expect(textOf(r!)).not.toContain('mem_budget_exceeded');
  });

  // ── 审查 I-1:stop_project 两条归因路径(命中/未命中回归锚各一)────────────────
  // 停止分支的可达序列依据真实 killProcess 语义("Async kill: waits for 'close' event"):
  // 看门狗树杀后 close 事件未派发的窗口内 stop 进来 → targetProc 非 null →
  // await killProcess 期间 close 到达 → close handler 归因落桶+Map → killProcess
  // resolve → stop 读到快照归因行与 Map 条目。mock 忠实模拟"kill 中 close 到达"。

  it('I-1 stop_project 停止分支:kill 窗口内归因到达 → result 附 mem_budget_exceeded 字段 + errors 归因行', async () => {
    const proc = fakeProc(5401);
    spawnMock.mockImplementation(() => proc);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 5401 ? { readingBytes: 9.5 * GB2, declaredMB: 3072, kind: 'game_window' } : null);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    vi.mocked(killProcess).mockImplementationOnce(async (p: { emit: (ev: string, code: number) => void }) => {
      p.emit('close', 1);   // kill 过程中 close 到达(被看门狗杀,exitCode 1)
    });
    const r = await runtimeHandleTool('runtime', { action: 'stop_project', project_path: TMP_PROJECT }, makeCtx());
    const txt = textOf(r!);
    expect(txt).toContain('"status": "stopped"');
    expect(txt).toContain('"mem_budget_exceeded"');                       // 结构化字段
    expect(txt).toContain('[MEM_BUDGET_EXCEEDED]');                       // 归因行进 errors 分类
    expect(txt).toContain('GODOT_MCP_DECLARED_MB_GAME_WINDOW');           // 档位上调指引
  });

  it('I-1 stop_project 停止分支回归锚:正常停止(未被杀)→ 无归因字段无归因行', async () => {
    const proc = fakeProc(5402);
    spawnMock.mockImplementation(() => proc);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    vi.mocked(killProcess).mockImplementationOnce(async (p: { emit: (ev: string, code: number) => void }) => {
      p.emit('close', 0);
    });
    const r = await runtimeHandleTool('runtime', { action: 'stop_project', project_path: TMP_PROJECT }, makeCtx());
    const txt = textOf(r!);
    expect(txt).toContain('"status": "stopped"');
    expect(txt).not.toContain('mem_budget_exceeded');
    expect(txt).not.toContain('MEM_BUDGET_EXCEEDED');
  });

  it('I-1 stop_project no-running 分支:会话被杀后(close 已清 proc)→ 文本附归因与上调指引', async () => {
    const proc = fakeProc(5403);
    spawnMock.mockImplementation(() => proc);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 5403 ? { readingBytes: 17 * GB2, declaredMB: 8192, kind: 'gut_shard' } : null);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    proc.emit('close', 1);   // 看门狗树杀 → close 清 proc,recentMemKills 已记归因
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
    const r = await runtimeHandleTool('runtime', { action: 'stop_project', project_path: TMP_PROJECT }, makeCtx());
    const txt = textOf(r!);
    expect(txt).toContain('No project is currently running');
    expect(txt).toContain('Last run was killed by memory watchdog: [MEM_BUDGET_EXCEEDED]');
    expect(txt).toContain('声明 8192MB×2');
  });

  it('I-1 stop_project no-running 分支回归锚:自然退出后 → 原文本,无 watchdog 附注', async () => {
    const proc = fakeProc(5404);
    spawnMock.mockImplementation(() => proc);
    await runtimeHandleTool('runtime', { action: 'run_project', project_path: TMP_PROJECT }, makeCtx());
    proc.emit('close', 0);
    await vi.waitFor(() => {
      expect(memguard.releaseLease).toHaveBeenCalledWith(OK_LEASE_ID);
    });
    const r = await runtimeHandleTool('runtime', { action: 'stop_project', project_path: TMP_PROJECT }, makeCtx());
    const txt = textOf(r!);
    expect(txt).toContain('No project is currently running');
    expect(txt).not.toContain('watchdog');
    expect(txt).not.toContain('MEM_BUDGET_EXCEEDED');
  });

  // ── 审查 I-2:分片模式 mem_killed 归因链(片级标注 + 顶层升格 + 其余片照跑)────

  it('I-2 run_tests 分片:片1 被看门狗杀 → status=mem_killed 带归因,顶层升格 mem_budget_exceeded,片2 照跑', async () => {
    const p1 = fakeProc(6101);
    const p2 = fakeProc(6102);
    spawnMock.mockImplementationOnce(() => p1).mockImplementationOnce(() => p2);
    wasMemKilledMock.mockImplementation((pid: number) =>
      pid === 6101 ? { readingBytes: 17 * GB2, declaredMB: 8192, kind: 'gut_shard' } : null);
    const rPromise = runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, shards: 2, timeout: 5,
    }, makeCtx());
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledTimes(1); });
    p1.emit('close', 1);   // 片1 被杀(exitCode 1,无 GUT 计数输出)
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledTimes(2); });   // 失败片不中断后续片
    p2.emit('close', 0);   // 片2 正常退出
    const r = await rPromise;
    const parsed = JSON.parse(textOf(r!)) as {
      mode: string; mem_budget_exceeded?: string;
      shard_results: Array<{ shard: number; status: string; mem_kill?: string }>;
    };
    expect(parsed.mode).toBe('sharded');
    expect(parsed.shard_results).toHaveLength(2);
    // 被杀片归因标注(而非泛化 failed)——审查 I-2 验收点
    expect(parsed.shard_results[0]!.status).toBe('mem_killed');
    expect(parsed.shard_results[0]!.mem_kill).toContain('GODOT_MCP_DECLARED_MB_GUT_SHARD');
    expect(parsed.shard_results[0]!.mem_kill).toContain('声明 8192MB×2');
    // 其余片照常汇总
    expect(parsed.shard_results[1]!.status).toBe('ok');
    // 首个被杀片归因升格顶层(agent 单看汇总即见)
    expect(parsed.mem_budget_exceeded).toContain('内存预算超限被看门狗终止');
  });

  it('I-2 run_tests 分片回归锚:无片被杀 → 全片无 mem_killed,顶层无 mem_budget_exceeded', async () => {
    const p1 = fakeProc(6201);
    const p2 = fakeProc(6202);
    spawnMock.mockImplementationOnce(() => p1).mockImplementationOnce(() => p2);
    const rPromise = runtimeHandleTool('runtime', {
      action: 'run_tests', project_path: TMP_PROJECT, shards: 2, timeout: 5,
    }, makeCtx());
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledTimes(1); });
    p1.emit('close', 0);
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledTimes(2); });
    p2.emit('close', 0);
    const r = await rPromise;
    const txt = textOf(r!);
    expect(txt).not.toContain('mem_killed');
    expect(txt).not.toContain('mem_budget_exceeded');
    expect(txt).not.toContain('MEM_BUDGET_EXCEEDED');
  });
});
