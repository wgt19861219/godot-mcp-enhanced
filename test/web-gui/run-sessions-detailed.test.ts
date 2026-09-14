// test/web-gui/run-sessions-detailed.test.ts
// Task 4(Web GUI 监控面板):process-state listRunSessionsDetailed 只读详单导出。
// 状态重置跟随既有惯例(test/process-state.test.js:75):beforeEach resetState()。
// 注:appendOutput/setProcessStartTime 的 key 参数不做 normalize(getOrCreateSession
// 直用裸 key),须先 normalizeProjectKey 再传——与生产调用方 runtime.ts:189 同模式。
import { describe, it, expect, beforeEach } from 'vitest';
import * as ps from '../../src/core/process-state.js';

describe('listRunSessionsDetailed(设计 §3.3.2:直接遍历,禁惰性建桶)', () => {
  beforeEach(() => { ps.resetState(); });

  it('返回白名单全字段且不含 proc;两态输出行数', () => {
    const raw = 'D:/projA';
    const key = ps.normalizeProjectKey(raw);
    ps.setRunSessionProc(raw, { pid: 123, on: () => {}, kill: () => {} } as unknown as import('node:child_process').ChildProcess, true);
    ps.appendOutput(['line1', 'line2'], key);
    // 运行中态:pid=proc.pid,outputLines 读 outputBuffer
    const running = ps.listRunSessionsDetailed();
    const r = running.find(s => s.projectPath === key);
    expect(r).toBeDefined();
    expect(r!.status).toBe('running');
    expect(r!.pid).toBe(123);
    expect(r!.outputLines).toBe(2);
    // 推回 startTime 绕开 2s early 判定,markSessionExited 权威判 exited(code=0,>2s)
    ps.setProcessStartTime(Date.now() - 3000, key);
    ps.markSessionExited(raw, 0);
    // 生产链路顺序(runtime close 链):markSessionExited 定态 → clearRunSession 挪快照+清 proc
    ps.clearRunSession(raw);
    const list = ps.listRunSessionsDetailed();
    const a = list.find(s => s.projectPath === key);
    expect(a).toBeDefined();
    expect(a!.pid).toBe(null);                       // clearRunSession 后 proc=null
    expect(a!.status).toBe('exited');
    expect(a!.outputLines).toBe(2);                  // ended 态读 lastFinishedRunOutput
    expect(a!.displayPath).toBe(raw);                // 显示用原始路径(key 仅供索引)
    expect(a!).not.toHaveProperty('proc');
    expect(a!).toHaveProperty('processStartTime');
    expect(a!).toHaveProperty('busy');
    expect(a!).toHaveProperty('busyOwner');
    expect(a!).toHaveProperty('busySince');
  });

  it('不创建新桶(读侧无副作用)', () => {
    ps.setRunSessionProc('D:/projB', { pid: 456, on: () => {}, kill: () => {} } as unknown as import('node:child_process').ChildProcess, true);
    const before = ps.listRunSessions().length;
    ps.listRunSessionsDetailed();
    expect(ps.listRunSessions().length).toBe(before);
  });
});
