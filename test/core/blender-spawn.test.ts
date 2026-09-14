import { it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 12345;
}

// Brief 测试用 vi.doMock + 动态 import，但其工厂 `() => ({ spawn })` 抹掉 child_process
// 其余导出，导致 helpers.ts 模块加载期 `promisify(execFile)` 崩溃。改用仓库已验证的
// vi.hoisted + vi.mock + importOriginal 模式（对称 test/core/blender-finder.test.ts），
// 仅覆盖 spawn，保留 execFile 等真实导出。FakeProc + 假定时器的测试意图不变。
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

import { runBlenderHeadless } from '../../src/core/blender-spawn.js';

beforeEach(() => {
  mockSpawn.mockReset();
  mockForceKillTree.mockReset();
});

it('accumulates stdout/stderr and resolves exitCode on close', async () => {
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runBlenderHeadless(['--background'], '/fake/blender', 5000);
  proc.stdout.emit('data', Buffer.from('out1-'));
  proc.stdout.emit('data', Buffer.from('out2'));
  proc.stderr.emit('data', Buffer.from('err'));
  proc.emit('close', 0);
  const r = await p;
  expect(r).toEqual({ exitCode: 0, stdout: 'out1-out2', stderr: 'err' });
});

it('resolves exitCode null on timeout (forceKillTree)', async () => {
  vi.useFakeTimers();
  const proc = new FakeProc();
  mockSpawn.mockReturnValue(proc);
  const p = runBlenderHeadless(['--background'], '/fake/blender', 1000);
  vi.advanceTimersByTime(1001);
  const r = await p;
  expect(r.exitCode).toBeNull();
  expect(mockForceKillTree).toHaveBeenCalledWith(proc);
  vi.useRealTimers();
});
