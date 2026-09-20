import { describe, it, expect, vi, afterEach } from 'vitest';
import { withToolHeartbeat, withToolDeadline } from '../src/core/progress.js';
import { ToolDeadlineError } from '../src/core/tool-errors.js';
import { readFileSync } from 'node:fs';

/**
 * P1(2026-09-11)心跳保活 — 单元(fake timers)+ 接线契约。
 * 来源:BuildersGate 取消经济学(客户端按 idle 杀无进度调用,server 线程照样跑完扣钱)。
 * 心跳 = 每 20s 一次 progress notification 证明请求活着;20s 内完成的工具零消息。
 */

describe('P1 心跳: withToolHeartbeat 单元', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('HB-a: 无 progressToken(emitter undefined)时直通,零开销', async () => {
    const fn = vi.fn(async () => 'done');
    const r = await withToolHeartbeat(undefined, 'tool', fn);
    expect(r).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('HB-b: 快速完成的工具不发任何心跳(首个 tick 在 20s)', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    await withToolHeartbeat(emitter, 'tool', async () => 'fast');
    vi.advanceTimersByTime(60_000); // fn 已 settle,timer 已清——不应再发
    expect(emitter).not.toHaveBeenCalled();
  });

  it('HB-c: 慢工具每 20s 发心跳,message 明示 heartbeat 语义;settle 后停止', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    let resolveFn!: (v: string) => void;
    const p = withToolHeartbeat(emitter, 'export_build', () => new Promise<string>(res => { resolveFn = res; }));
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(20_000);
    expect(emitter, '40s 时已发 2 次').toHaveBeenCalledTimes(2);
    const first = emitter.mock.calls[0]!;
    expect(first[2]).toContain('export_build');
    expect(first[2]).toContain('heartbeat, not progress');
    expect(first[0], 'progress 参数为已耗时秒').toBe(20);
    resolveFn('ok');
    expect(await p).toBe('ok');
    const count = emitter.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(emitter.mock.calls.length, 'settle 后 timer 已清').toBe(count);
  });

  it('HB-d: fn 抛异常时 finally 清 timer,异常透传', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    const p = withToolHeartbeat(emitter, 'tool', async () => { throw new Error('boom'); });
    await expect(p).rejects.toThrow('boom');
    const count = emitter.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(emitter.mock.calls.length).toBe(count);
  });
});

describe('P1 心跳: dispatcher 接线契约', () => {
  // Nit-3(审查): 本用例是源码字符串断言,参数换行/改名即假红——行为级正确性由
  // ToolDispatcher.test.ts 的 DL-E2E(挂起 handler+50ms env deadline→结构化错误)兜底,
  // 此处只锁"主路径确实包了 deadline"的接线事实。
  it('HB-e: ToolDispatcher 主执行路径包 deadline(心跳内聚于 withToolDeadline)', () => {
    const ts = readFileSync('src/core/ToolDispatcher.ts', 'utf8');
    // 2026-09-20 任务①: 主路径从 withToolHeartbeat 升级为 withToolDeadline(心跳+deadline 双 timer)
    expect(ts.includes('withToolDeadline(progressEmitter, name,'), '主路径接线').toBe(true);
    expect(ts.includes('instanceof ToolDeadlineError'), 'deadline 错误就地转结构化 opsErrorResult').toBe(true);
    expect(ts.includes("from './progress.js'"), 'import 存在').toBe(true);
  });
});

/**
 * 任务①(2026-09-20 可靠性批): withToolDeadline = 心跳 + 全局 deadline 兜底。
 * 语义:deadline 触发以 ToolDeadlineError reject(调用方转结构化错误);fn 的 late
 * settle 无副作用且不产生 unhandled rejection;deadline 触发后心跳一并停。
 */
describe('任务①: withToolDeadline 单元', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('DL-a: deadlineMs<=0 禁用——退化为纯心跳,fn 正常 resolve 透传', async () => {
    vi.useFakeTimers();
    const r = await withToolDeadline(undefined, 'tool', async () => 'done', 0);
    expect(r).toBe('done');
    const r2 = await withToolDeadline(vi.fn(), 'tool', async () => 'done2', -1);
    expect(r2).toBe('done2');
  });

  it('DL-b: fn 在 deadline 内 settle——值透传,无 deadline 错误', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    const p = withToolDeadline(emitter, 'tool', async () => 'fast', 60_000);
    expect(await p).toBe('fast');
    vi.advanceTimersByTime(120_000); // deadline timer 应已清,不再触发
  });

  it('DL-c: fn 永不 settle + deadline 到——ToolDeadlineError reject(code/toolName)', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    const p = withToolDeadline(emitter, 'execute_gdscript', () => new Promise<string>(() => {}), 30_000);
    vi.advanceTimersByTime(30_000);
    await expect(p).rejects.toBeInstanceOf(ToolDeadlineError);
    await expect(p).rejects.toMatchObject({
      code: 'TOOL_DEADLINE_EXCEEDED',
      category: 'timeout',
      retryable: true,
    });
    // reject 的 safeMessage 含工具名与 env 指引(PII-safe:无路径)
    const err = await p.catch(e => e as ToolDeadlineError);
    expect(err.safeMessage).toContain('execute_gdscript');
    expect(err.safeMessage).toContain('GODOT_MCP_TOOL_DEADLINE_MS');
  });

  it('DL-d: deadline 触发后心跳停止——不再向已终结的请求发 progress', async () => {
    vi.useFakeTimers();
    const emitter = vi.fn();
    const p = withToolDeadline(emitter, 'tool', () => new Promise<string>(() => {}), 30_000);
    vi.advanceTimersByTime(20_000);
    expect(emitter).toHaveBeenCalledTimes(1); // deadline 前心跳正常
    vi.advanceTimersByTime(10_000); // deadline 触发
    await expect(p).rejects.toBeInstanceOf(ToolDeadlineError);
    const count = emitter.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(emitter.mock.calls.length, 'deadline 后心跳 timer 已清').toBe(count);
  });

  it('DL-e: fn 的 late settle 在 deadline reject 后到达——无副作用、无 unhandled rejection', async () => {
    vi.useFakeTimers();
    let resolveFn!: (v: string) => void;
    const p = withToolDeadline(vi.fn(), 'tool', () => new Promise<string>(res => { resolveFn = res; }), 30_000);
    vi.advanceTimersByTime(30_000);
    await expect(p).rejects.toBeInstanceOf(ToolDeadlineError);
    resolveFn('late-ok'); // late settle:Promise 已 reject,此值被丢弃,不炸
    // fake timers 接管 setImmediate,用纯 microtask 链 flush(两跳覆盖 then 回调入队)
    await Promise.resolve().then(() => {}).then(() => {});
  });

  it('DL-f: fn 在 deadline 前 reject——异常透传(非 ToolDeadlineError 包装)', async () => {
    vi.useFakeTimers();
    const p = withToolDeadline(vi.fn(), 'tool', async () => { throw new Error('boom'); }, 60_000);
    await expect(p).rejects.toThrow('boom');
  });

  it('DL-g: fn 的 late reject 在 deadline reject 后到达——不产生 unhandled rejection', async () => {
    vi.useFakeTimers();
    let rejectFn!: (e: unknown) => void;
    const p = withToolDeadline(vi.fn(), 'tool', () => new Promise<string>((_, rej) => { rejectFn = rej; }), 30_000);
    vi.advanceTimersByTime(30_000);
    await expect(p).rejects.toBeInstanceOf(ToolDeadlineError);
    rejectFn(new Error('late-boom')); // late reject:已被 executor 内 then 消费,不炸
    await Promise.resolve().then(() => {}).then(() => {});
  });
});
