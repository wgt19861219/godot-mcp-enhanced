// test/web-gui/run-sessions-remove.test.ts
// 面板清理(2026-09-14 批准设计):removeRunSession 三态——ended 删除 + FIFO 摘除、
// alive 拒绝桶保留、不存在 not_found。mock proc 惯例同 run-sessions-detailed.test.ts。
// 注:appendOutput/setProcessStartTime 的 key 参数不做 normalize(getOrCreateSession
// 直用裸 key),须先 normalizeProjectKey 再传——与生产调用方 runtime.ts 同模式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ps from '../../src/core/process-state.js';

type FakeProc = import('node:child_process').ChildProcess;
function fakeProc(pid: number): FakeProc {
  return { pid, on: () => {}, kill: () => {} } as unknown as FakeProc;
}

/** 走生产链路顺序把桶推到 ended 态:spawn(startTime 推远绕开 2s early)→ 权威判定 → 清 proc。 */
function endSession(raw: string, pid: number): void {
  const key = ps.normalizeProjectKey(raw);
  ps.setRunSessionProc(raw, fakeProc(pid), true);
  ps.appendOutput(['line1'], key);
  ps.setProcessStartTime(Date.now() - 3000, key);
  ps.markSessionExited(raw, 0);
  ps.clearRunSession(raw);
}

describe('removeRunSession(面板清理:ended 桶移除,alive 拒绝)', () => {
  beforeEach(() => { ps.resetState(); });
  afterEach(() => { delete process.env.GODOT_MCP_MAX_FINISHED_SESSIONS; });

  it('ended 态桶删除:ok:true + 桶消失', () => {
    endSession('D:/projA', 111);
    expect(ps.listRunSessions().length).toBe(1);
    const r = ps.removeRunSession('D:/projA');
    expect(r).toEqual({ ok: true });
    expect(ps.listRunSessions().length).toBe(0);
    expect(ps.getSession('D:/projA')).toBeUndefined();
  });

  it('FIFO 摘除(间接效应):remove 后触发逐出不误删后继桶', () => {
    process.env.GODOT_MCP_MAX_FINISHED_SESSIONS = '2';
    endSession('D:/fifoA', 121);
    endSession('D:/fifoB', 122);
    expect(ps.removeRunSession('D:/fifoA')).toEqual({ ok: true });
    // FIFO 摘除正确 → [B];结束 C → [B,C] ≤ 上限 2 不逐出。
    // 若 remove 未摘 FIFO → [A,B,C] 超上限触发逐出:shift A(Map 无此桶跳过)继续 shift → B 被误删。
    endSession('D:/fifoC', 123);
    const keys = ps.listRunSessions().map(x => x.projectPath).sort();
    expect(keys).toEqual([
      ps.normalizeProjectKey('D:/fifoB'),
      ps.normalizeProjectKey('D:/fifoC'),
    ]);
  });

  it('alive 桶拒绝:reason alive + 桶保留', () => {
    ps.setRunSessionProc('D:/alive', fakeProc(456), true);   // status='running'
    expect(ps.removeRunSession('D:/alive')).toEqual({ ok: false, reason: 'alive' });
    expect(ps.getSession('D:/alive')).toBeDefined();
    expect(ps.listRunSessions().length).toBe(1);
  });

  it('不存在 → not_found', () => {
    expect(ps.removeRunSession('D:/nope')).toEqual({ ok: false, reason: 'not_found' });
  });
});
