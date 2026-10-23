import { it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// P1-5 (批次 E): godot-spawn.ts 此前 test/ 0 匹配，三分支（close/timeout/spawn error）零覆盖。
// 对称 test/core/blender-spawn.test.ts FakeProc + vi.hoisted + vi.mock importOriginal 保留 execFile 模式。
// 加 spawn error 用例（godot-spawn 特有 reject，blender 未测）。
class FakeProc extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  pid = 12345;
}

const { mockSpawn, mockForceKillTree } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockForceKillTree: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

// I-4 统一策略:importOriginal 部分覆盖——forceKillTree 是断言目标保留 stub,
// 其余导出透传真实模块(防 Task 系列新增导出后 mock 工厂缺导出 TypeError)。
vi.mock('../../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/process-state.js')>();
  return { ...actual, forceKillTree: mockForceKillTree };
});

import { runGodotHeadless } from '../../src/core/godot-spawn.js';

beforeEach(() => {
  mockSpawn.mockReset();
  mockForceKillTree.mockReset();
});

it('累积 stdout/stderr，close 时 resolve exitCode', async () => {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 5000);
  proc.stdout.emit('data', Buffer.from('out1-'));
  proc.stdout.emit('data', Buffer.from('out2'));
  proc.stderr.emit('data', Buffer.from('err'));
  proc.emit('close', 0);
  const r = await p;
  expect(r).toEqual({ exitCode: 0, stdout: 'out1-out2', stderr: 'err' });
});

it('超时 forceKillTree,等真实 close 才 resolve exitCode null（L-15:不裸 resolve,流句柄不悬空）', async () => {
  vi.useFakeTimers();
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 1000);
  vi.advanceTimersByTime(1001);
  expect(mockForceKillTree).toHaveBeenCalledWith(proc);
  // L-15(2026-10-22 审查): 超时分支不再裸 resolve——kill 发出后等真实 close
  // (被杀场景 code=null)。close 未到前 Promise 仍 pending。
  const pending = Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 0))]);
  vi.advanceTimersByTime(10);
  expect(await pending).toBe('pending');
  proc.emit('close', null);
  const r = await p;
  expect(r.exitCode).toBeNull();
  vi.useRealTimers();
});

it('L-15: 超时 + kill 失败(close 永不到来)→ 5s failsafe destroy 流后 resolve', async () => {
  vi.useFakeTimers();
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 1000);
  vi.advanceTimersByTime(1001);
  vi.advanceTimersByTime(5000);
  const r = await p;
  expect(r.exitCode).toBeNull();
  expect(proc.stdout.destroy).toHaveBeenCalled();
  expect(proc.stderr.destroy).toHaveBeenCalled();
  vi.useRealTimers();
});

it('spawn error reject（含 "failed to spawn" 子串，与历史 import-check 断言兼容）', async () => {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 5000);
  proc.emit('error', new Error('ENOENT'));
  await expect(p).rejects.toThrow('failed to spawn');
});
