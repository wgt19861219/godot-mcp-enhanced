// runtime-timeout.test.ts — computeRunTimeout 纯函数(问题 3:run_project timeout race 修复)
// 提取自 runtime.ts run_project 的 timeout 计算,使可单元测试。
// 修复:wait_for_bridge 时 timeout 至少 bridge_timeout + 10,防 auto-stop 与 bridge 就绪 race。
import { describe, it, expect } from 'vitest';
import { computeRunTimeout } from '../src/tools/runtime.js';

describe('computeRunTimeout', () => {
  it('无 wait_for_bridge 时默认 30', () => {
    expect(computeRunTimeout(undefined, 10, false)).toBe(30);
  });

  it('wait_for_bridge 时 timeout ≥ bridge_timeout + 10(防 race)', () => {
    // 默认 30 vs bridge 30+10=40 → 取 40(当前 bug:取 30,race)
    expect(computeRunTimeout(undefined, 30, true)).toBe(40);
  });

  it('wait_for_bridge + 小 bridge:取默认 30(max(20,30))', () => {
    expect(computeRunTimeout(undefined, 10, true)).toBe(30);
  });

  it('显式 timeout > bridge+10 时尊重显式值', () => {
    expect(computeRunTimeout(120, 30, true)).toBe(120);
  });

  it('显式 timeout < bridge+10 时用 bridge+10(防 race)', () => {
    expect(computeRunTimeout(15, 30, true)).toBe(40);
  });

  it('最小 5(下限)', () => {
    expect(computeRunTimeout(1, 10, false)).toBe(5);
  });

  // 反馈批次D (2026-09-17, fr2 2026-09-02 反馈): 显式 0/-1 = 不自动停(交 stop_project)
  it('显式 0 = 不自动停(bridge 交互会话逐步驱动场景)', () => {
    expect(computeRunTimeout(0, 10, false)).toBe(0);
  });

  it('显式 -1 = 不自动停(负数全归一 0)', () => {
    expect(computeRunTimeout(-1, 10, false)).toBe(0);
  });

  it('显式 0 + wait_for_bridge 也不设 auto-stop(无 timer 即无 race,不强制 bridge+10)', () => {
    expect(computeRunTimeout(0, 30, true)).toBe(0);
  });

  it('未传/NaN/空串/null 不触发 0 语义(仍默认 30,防误伤)', () => {
    expect(computeRunTimeout(undefined, 10, false)).toBe(30);
    expect(computeRunTimeout(NaN, 10, false)).toBe(30);
    expect(computeRunTimeout('', 10, false)).toBe(30);
    expect(computeRunTimeout(null, 10, false)).toBe(30);
  });
});
