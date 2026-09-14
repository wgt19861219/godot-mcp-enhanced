// 2026-08-11 P0-3: gdscript-executor timeout 路径测试
// 审查发现 gdscript-executor.ts:1294-1304 的 timer reject 路径零测
// (gdscript-executor-audit-runtime.test.js:9 显式声明"不测 timeout 路径:非 audit 回填")。
// helpers/mock-results.js 的 mockTimeoutSpawn/mockCrashSpawn 工厂零引用(建了不用)。
// 本文件复用 audit-runtime 的 child_process spawn mock 范式,验证 timer 触发 →
// reject("timed out after Ns") + unregisterSpawn(:1298) + releaseShortRunningSlot(:1301)。
//
// 注:timeout 是 TS 侧 setTimeout(:1294),非 spawnGodot 返回字段,故用真实 spawn mock +
// 不 emit close 让 timer 触发(对齐 audit-runtime 的 EventEmitter 假 proc 范式)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PathLike } from 'fs';

const { infoSpy, unregisterSpy, releaseSpy } = vi.hoisted(() => ({
  infoSpy: vi.fn(),
  unregisterSpy: vi.fn(),
  releaseSpy: vi.fn(),
}));

// mock logger:executeGdscript 调 EXECUTE_BEGIN audit(spawn 前),需 info spy
vi.mock('../src/core/logger.js', () => ({
  getLogger: () => ({
    info: infoSpy,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    close: vi.fn(),
  }),
}));

// mock fs.existsSync:让 godotPath 校验过(:1043),其他 existsSync 真实
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: PathLike) =>
      typeof p === 'string' && p.toLowerCase().includes('godot') ? true : actual.existsSync(p),
  };
});

// mock process-state:slot/PID 管理避开,unregister/release 设 spy 以断言 timer 调用
// I-4 统一策略(设计 §7):importOriginal 部分覆盖——stub 项保留,新导出透传真实模块。
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/process-state.js')>();
  return {
    ...actual,
    acquireShortRunningSlot: () => true,
    releaseShortRunningSlot: releaseSpy,
    getRunningProcess: () => null,
    getProjectDir: () => '',
    forceKillTree: () => {},
    registerSpawnedGodotPid: () => {},
    unregisterSpawnedGodotPid: unregisterSpy,
  };
});

// mock fs/promises.readdir:跳过 cleanupOldSessions 扫描(避免残留目录致卡死,见 A-07)
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readdir: vi.fn(async () => []) };
});

// mock child_process.spawn:返回 EventEmitter 假 proc(不 emit close,让 timer 触发)
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 12345;
      proc.killed = false;
      proc.kill = function (this: EventEmitter & { killed: boolean }) {
        this.killed = true;
        return true;
      };
      return proc;
    }),
  };
});

import { executeGdscript } from '../src/gdscript-executor.js';

describe('gdscript-executor timeout path (P0-3)', () => {
  beforeEach(() => {
    infoSpy.mockClear();
    unregisterSpy.mockClear();
    releaseSpy.mockClear();
  });

  it('timer 触发 → reject 带 "timed out after Ns" + 释放 slot + 注销 spawn', async () => {
    // 不 emit close,让 :1294 timer 触发。timeout:0.1 → 100ms timer
    const code = 'extends SceneTree\nfunc _initialize():\n\tpass';
    const promise = executeGdscript({ godotPath: '/fake/godot', projectPath: '', code, timeout: 0.1 });

    // timer reject 路径(:1303)
    await expect(promise).rejects.toThrow(/timed out after 0\.1s/);
    // timer 兜底释放 slot(:1301)
    expect(releaseSpy).toHaveBeenCalled();
    // timer 强杀后注销 spawn(:1298,exit 事件可能不触发)
    expect(unregisterSpy).toHaveBeenCalled();
  }, 10000);

  // 注:close 正常路径(emit close → clearTimeout → resolve,不走 timeout reject)已由
  // gdscript-executor-audit-runtime.test.js 的 3 个 close 测试覆盖(emit close 后 resolve +
  // 回填 executionId)。本文件聚焦 timer reject 路径(那边的已知 gap),不重复 close 覆盖。
});
