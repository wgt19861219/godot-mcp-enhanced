// test/middleware.test.ts
// IMPORTANT-5: createRateLimitMiddleware 单元测试
import { describe, it, expect } from 'vitest';
import { createRateLimitMiddleware } from '../src/core/middleware.js';
import type { DispatchContext } from '../src/types.js';

describe('createRateLimitMiddleware (IMPORTANT-5)', () => {
  const ctx = { toolName: 'test', args: {}, startTime: 0 } as unknown as DispatchContext;

  it('passes up to maxPerWindow calls within window', async () => {
    const mw = createRateLimitMiddleware(3, 1000);
    for (let i = 0; i < 3; i++) {
      const r = await mw.before(ctx);
      expect('passed' in r && r.passed).toBe(true);
    }
  });

  it('rejects calls exceeding maxPerWindow within window', async () => {
    const mw = createRateLimitMiddleware(2, 1000);
    await mw.before(ctx);
    await mw.before(ctx);
    const r3 = await mw.before(ctx);
    expect('rejected' in r3 && r3.rejected).toBe(true);
  });

  it('resets after window elapses', async () => {
    const mw = createRateLimitMiddleware(1, 20);
    await mw.before(ctx);
    const r2 = await mw.before(ctx);
    expect('rejected' in r2 && r2.rejected).toBe(true);
    await new Promise(r => setTimeout(r, 30));
    const r3 = await mw.before(ctx);
    expect('passed' in r3 && r3.passed).toBe(true);
  });

  // 2026-09-20 可靠性批任务③: 拒绝响应必须是 opsErrorResult 结构化 JSON(与全局错误口径
  // 一致),不能再是 'RATE_LIMITED: ...' 裸文本——客户端靠 error_code/retryable 程序化消费。
  it('rejection is structured opsErrorResult JSON (error_code/retryable/error_category)', async () => {
    const mw = createRateLimitMiddleware(1, 1000);
    await mw.before(ctx);
    const r2 = await mw.before(ctx);
    expect('rejected' in r2 && r2.rejected).toBe(true);
    if (!('rejected' in r2) || !r2.rejected) throw new Error('unreachable');
    const text = r2.error.content[0]?.type === 'text' ? r2.error.content[0].text : '';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['success']).toBe(false);
    expect(parsed['error_code']).toBe('RATE_LIMIT');
    expect(parsed['retryable']).toBe(true);
    expect(parsed['error_category']).toBe('guard');
    expect(typeof parsed['suggestion']).toBe('string');
    expect(parsed['suggestion']).toContain('Wait');
  });
});
