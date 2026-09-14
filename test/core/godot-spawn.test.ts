import { it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// P1-5 (批次 E): godot-spawn.ts 此前 test/ 0 匹配，三分支（close/timeout/spawn error）零覆盖。
// 对称 test/core/blender-spawn.test.ts FakeProc + vi.hoisted + vi.mock importOriginal 保留 execFile 模式。
// 加 spawn error 用例（godot-spawn 特有 reject，blender 未测）。
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
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

it('超时 forceKillTree + resolve exitCode null（防 CI Godot 卡留僵尸）', async () => {
  vi.useFakeTimers();
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 1000);
  vi.advanceTimersByTime(1001);
  const r = await p;
  expect(r.exitCode).toBeNull();
  expect(mockForceKillTree).toHaveBeenCalledWith(proc);
  vi.useRealTimers();
});

it('spawn error reject（含 "failed to spawn" 子串，与历史 import-check 断言兼容）', async () => {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runGodotHeadless(['--headless'], '/fake/godot', 5000);
  proc.emit('error', new Error('ENOENT'));
  await expect(p).rejects.toThrow('failed to spawn');
});
