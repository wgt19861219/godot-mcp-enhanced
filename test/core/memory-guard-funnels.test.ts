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

/** 假子进程(EventEmitter 形态,对齐 gdscript-executor-timeout.test.ts 范式)。 */
function fakeProc(pid: number) {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number; killed: boolean;
    stdout: EventEmitter; stderr: EventEmitter;
    unref: ReturnType<typeof vi.fn>;
    kill: () => boolean;
  };
  proc.pid = pid;
  proc.killed = false;
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
});
