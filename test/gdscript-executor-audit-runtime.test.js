// P1-9 EXECUTE_BEGIN 审计运行时验证 + 崩溃回填端到端
//
// 现有 gdscript-executor-audit.test.js 是纯静态契约（indexOf 顺序比较）+ buildExecAuditEvent
// 纯函数单元。本文件补两个零覆盖 gap：
// 1. 运行时验证 EXECUTE_BEGIN 在 spawn 前真的调了 logger.info（替代静态 :69-77）
// 2. 三路径 resolve 回填 executionId/scriptSha256（崩溃场景审计溯源，此前只能靠源码阅读）
//
// 不测成功 marker 路径（:1283）：generateMarker 非 export，marker 随机无法固定。
// 不测 timeout 路径（:1249 timer reject）：非 audit 回填。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── hoisted 共享 spy/ref（vi.mock factory 提升后仍可引用）──────────────────
const mocks = vi.hoisted(() => {
  const infoSpy = vi.fn();
  let lastProc = null;
  return {
    infoSpy,
    getLastProc: () => lastProc,
    setLastProc: (p) => { lastProc = p; },
    resetProc: () => { lastProc = null; },
  };
});

// ─── mock logger：只覆盖 getLogger，返回固定 logger 对象 ────────────────────
vi.mock('../src/core/logger.js', () => ({
  getLogger: () => ({
    info: mocks.infoSpy,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    close: vi.fn(),
  }),
}));

// ─── mock fs.existsSync：让 godotPath 校验过（:1043），其他 existsSync 真实 ────
// executeGdscript :1043 !existsSync(godotPath) → return "Godot binary not found"（audit 在其后）。
// 传 /fake/godot 需 existsSync 返 true；needsImport(projectPath='') 查 .godot/imported 走真实 false。
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (p) => (typeof p === 'string' && p.toLowerCase().includes('godot') ? true : actual.existsSync(p)),
  };
});

// ─── mock process-state：避开 slot/PID 管理（聚焦 audit + spawn 回填）────────
// gdscript-executor:25 import { forceKillTree, getProjectDir, getRunningProcess,
// acquireShortRunningSlot, releaseShortRunningSlot }。slot 系统状态可能致 :1063 提前 return。
// I-4 统一策略(设计 §7):importOriginal 部分覆盖——仅 stub 上述防副作用项,
// 新导出(getRunSessionProc/killAllRunSessions 等)透传真实模块,防补导出漂移。
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireShortRunningSlot: () => true,
    releaseShortRunningSlot: () => {},
    getRunningProcess: () => null,
    getProjectDir: () => '',
    forceKillTree: () => {},
    // B-T4: spawn 注册/注销 PID（无需真实跟踪，no-op 即可）
    registerSpawnedGodotPid: () => {},
    unregisterSpawnedGodotPid: () => {},
  };
});

// ─── mock fs/promises.readdir 返空：跳过 cleanupOldSessions 扫描 ────────────
// executeGdscript 每次调用都 cleanupOldSessions（gdscript-executor.ts:1104）扫 BASE_TMP_DIR，
// 测试环境残留可能数千目录 + retryRm 退避致分钟级卡死（A-07）。
// readdir 仅 cleanupOldSessions 用；writeSessionFile/createSessionDir 用 writeFile/mkdtemp（保留真实）。
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readdir: vi.fn(async () => []) };
});

// ─── mock child_process.spawn：返回 EventEmitter 假 proc（参照 android.test.ts:10）──
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 12345;
      proc.killed = false;
      proc.kill = function () { this.killed = true; return true; };
      mocks.setLastProc(proc);
      return proc;
    }),
  };
});

import { executeGdscript } from '../src/gdscript-executor.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** 从 infoSpy 调用里提取 EXECUTE_BEGIN audit 事件（security channel）。 */
function extractAuditEvent() {
  for (const [mod, msg] of mocks.infoSpy.mock.calls) {
    if (mod !== 'security') continue;
    try {
      const evt = JSON.parse(msg);
      if (evt.audit === 'EXECUTE_BEGIN') return evt;
    } catch { /* not json */ }
  }
  return null;
}

/** 调 executeGdscript，等 spawn 发生，emit 事件，返回 result。 */
async function runAndEmit(emitFn) {
  const code = 'extends SceneTree\nfunc _initialize():\n\tpass';
  let execErr = null;
  const promise = executeGdscript({ godotPath: '/fake/godot', projectPath: '', code, timeout: 5 });
  promise.catch((e) => { execErr = e; });
  try {
    await vi.waitFor(() => expect(mocks.getLastProc()).not.toBeNull(), { timeout: 3000 });
  } catch {
    throw new Error(`spawn never happened. execErr=${execErr ? `${execErr.message}` : 'none (pending)'} | infoCalls=${mocks.infoSpy.mock.calls.length} | auditSeen=${extractAuditEvent() ? 'yes' : 'no'}`);
  }
  const proc = mocks.getLastProc();
  emitFn(proc);
  return promise;
}

// ─── SUT ──────────────────────────────────────────────────────────────────────

describe('EXECUTE_BEGIN audit — runtime + crash backfill (P1-9)', () => {
  beforeEach(() => {
    mocks.infoSpy.mockClear();
    mocks.resetProc();
  });

  // ── Test 1: log-before-spawn 运行时验证 + 双向定位 ────────────────────────
  it('logs EXECUTE_BEGIN before spawn and backfills executionId (runtime, not static)', async () => {
    const result = await runAndEmit((proc) => {
      // 空 stdout + exit 1 → RID leak 兜底路径 resolve（:1306）
      proc.emit('close', 1);
    });

    const spawnMock = (await import('child_process')).spawn;
    // 运行时验证：info(security, EXECUTE_BEGIN) 在 spawn 之前调用（替代静态 :69-77）
    expect(mocks.infoSpy).toHaveBeenCalledBefore(spawnMock);

    const evt = extractAuditEvent();
    expect(evt).not.toBeNull();
    expect(evt.audit).toBe('EXECUTE_BEGIN');
    expect(evt.executionId).toBeTruthy();
    expect(evt.scriptSha256).toMatch(/^[a-f0-9]{64}$/); // 字节级 SHA-256

    // 双向定位：result.executionId === 日志记下的 executionId
    expect(result.executionId).toBe(evt.executionId);
    expect(result.scriptSha256).toBe(evt.scriptSha256);
  });

  // ── Test 2: 崩溃 + Parse Error → :1323 路径，回填 executionId ─────────────
  it('backfills executionId on crash with Parse Error (path :1323)', async () => {
    const result = await runAndEmit((proc) => {
      proc.stdout.emit('data', Buffer.from('SCRIPT ERROR: Parse Error: invalid syntax'));
      proc.emit('close', 1);
    });

    // 走 :1323（无 marker + 有 Parse/Script Error）
    expect(result.success).toBe(false);
    expect(result.run_error).toContain('exited with code 1');
    // 回填
    expect(result.executionId).toBeTruthy();
    expect(result.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    // 双向定位
    const evt = extractAuditEvent();
    expect(result.executionId).toBe(evt.executionId);
  });

  // ── Test 3: RID leak 兜底 → :1306 路径，回填 executionId ──────────────────
  it('backfills executionId on RID-leak exit (path :1306)', async () => {
    const result = await runAndEmit((proc) => {
      // 无 marker、无 Parse/Script Error 的噪声 + exit 1
      proc.stdout.emit('data', Buffer.from('CORE RID leak detected during cleanup'));
      proc.emit('close', 1);
    });

    // 走 :1306 兜底（exitCode≠0 但 !hasRealError）
    expect(result.success).toBe(false);
    expect(result.run_error).toContain('RID leak during cleanup');
    expect(result.compile_success).toBe(true); // 兜底视为非编译错误
    // 回填
    expect(result.executionId).toBeTruthy();
    expect(result.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    // 双向定位
    const evt = extractAuditEvent();
    expect(result.executionId).toBe(evt.executionId);
  });
});
