// B1(竞品综述落地批 2026-11-13): uncaughtException 接入限时清理链。
// 方案 docs/plans/2026-11-13-竞品综述落地批方案.md Task B1:
// - 记 stderr 后执行带 5s 硬上限的 best-effort 清理,超时或清理抛错都强制 exit(1)
// - 清理成功也退 1(uncaught 不可恢复,不学 gracefulShutdown 的 exit(0))
// 单测 mock process.exit + fake timers 验证计时器语义,不真退进程。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleUncaughtException, runUncaughtCleanup, setUncaughtCleanup } from '../src/core/uncaught-cleanup.js';

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  // stderr 不刷屏(err 对象序列化进控制台会污染测试输出)
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setUncaughtCleanup(null);   // 模块级钩子复位,防跨用例泄漏
});

describe('runUncaughtCleanup — 限时清理链(B1)', () => {
  it('清理成功也退 1(uncaught 不可恢复,非 graceful 的 exit 0)', async () => {
    const cleanup = vi.fn(async () => {});
    runUncaughtCleanup(cleanup);
    expect(exitSpy).not.toHaveBeenCalled();   // 微任务结算前不退
    await vi.advanceTimersByTimeAsync(0);     // flush 微任务
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('清理返回 rejected promise(异步抛错)→ 强制 exit(1)', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup boom'); });
    runUncaughtCleanup(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('清理同步抛错(同步栈已损坏的常态)→ 强制 exit(1)', async () => {
    const cleanup = vi.fn(() => { throw new Error('sync boom'); }) as unknown as () => Promise<void>;
    runUncaughtCleanup(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('清理卡死(永不 settle)→ 5s 硬上限 timer 强制 exit(1)', async () => {
    const cleanup = vi.fn(() => new Promise<void>(() => {}));   // pending forever
    runUncaughtCleanup(cleanup);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('超时后清理才完成 → exit 只调一次(清理完成不二次退出)', async () => {
    let resolveCleanup: () => void = () => {};
    const cleanup = vi.fn(() => new Promise<void>((r) => { resolveCleanup = r; }));
    runUncaughtCleanup(cleanup);
    await vi.advanceTimersByTimeAsync(5_000);   // 硬上限先到 → exit(1)
    expect(exitSpy).toHaveBeenCalledTimes(1);
    resolveCleanup();                            // 迟到的清理完成 → 不得再次 exit
    await vi.advanceTimersByTimeAsync(10);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('未注入清理(daemon/CLI 路径未起 server)→ 直接退 1', async () => {
    runUncaughtCleanup(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('预算可注入(测试/调参)——1s 预算下 999ms 不退、1000ms 强退', async () => {
    runUncaughtCleanup(() => new Promise<void>(() => {}), 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleUncaughtException — process 事件处理器接线形态(B1)', () => {
  it('记 stderr(含堆栈)后进入限时清理链', async () => {
    const errSpy = vi.spyOn(console, 'error');
    setUncaughtCleanup(async () => {});
    handleUncaughtException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith('[uncaughtException]', expect.stringContaining('boom'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('非 Error 抛出值 → String() 序列化进 stderr', async () => {
    const errSpy = vi.spyOn(console, 'error');
    setUncaughtCleanup(async () => {});
    handleUncaughtException('raw string');
    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith('[uncaughtException]', 'raw string');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('钩子可撤销(setUncaughtCleanup(null) → 无清理直接退)', async () => {
    setUncaughtCleanup(async () => { throw new Error('should not run'); });
    setUncaughtCleanup(null);
    handleUncaughtException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
