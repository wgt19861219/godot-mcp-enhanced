import { describe, it, expect } from 'vitest';
import {
  classifyError,
  newTraceId,
  ValidationError,
  PathError,
  ConnectionError,
  TimeoutError,
  TransportError,
  GuardError,
  RateLimitError,
  InternalError,
} from '../../src/core/tool-errors.js';

// ─── classifyError: 7 类映射 + retryable ──────────────────────────────────────
describe('classifyError — 7 类结构化分类', () => {
  it('ValidationError → validation / not-retryable / INVALID_PARAMS', () => {
    const r = classifyError(new ValidationError());
    expect(r).toEqual({ category: 'validation', retryable: false, code: 'INVALID_PARAMS', safeMessage: 'Parameter validation failed' });
  });

  it('PathError → path / not-retryable / PATH_NOT_ALLOWED', () => {
    const r = classifyError(new PathError());
    expect(r).toEqual({ category: 'path', retryable: false, code: 'PATH_NOT_ALLOWED', safeMessage: 'Path not allowed or invalid' });
  });

  it('ConnectionError → connection / retryable / NOT_CONNECTED', () => {
    const r = classifyError(new ConnectionError());
    expect(r).toEqual({ category: 'connection', retryable: true, code: 'NOT_CONNECTED', safeMessage: 'Editor/bridge not connected' });
  });

  it('TimeoutError → timeout / retryable / TIMEOUT', () => {
    const r = classifyError(new TimeoutError());
    expect(r).toEqual({ category: 'timeout', retryable: true, code: 'TIMEOUT', safeMessage: 'Operation timed out' });
  });

  it('TransportError → transport / retryable / TRANSPORT', () => {
    const r = classifyError(new TransportError());
    expect(r).toEqual({ category: 'transport', retryable: true, code: 'TRANSPORT', safeMessage: 'Transport error' });
  });

  it('GuardError → guard / not-retryable / GUARD(拒绝)', () => {
    const r = classifyError(new GuardError());
    expect(r).toEqual({ category: 'guard', retryable: false, code: 'GUARD', safeMessage: 'Guard rejected operation' });
  });

  it('RateLimitError → guard / retryable / RATE_LIMIT(限流,区别于拒绝)', () => {
    const r = classifyError(new RateLimitError());
    expect(r).toEqual({ category: 'guard', retryable: true, code: 'RATE_LIMIT', safeMessage: 'Rate limit exceeded, retry shortly' });
  });

  it('InternalError → internal / not-retryable / INTERNAL', () => {
    const r = classifyError(new InternalError());
    expect(r).toEqual({ category: 'internal', retryable: false, code: 'INTERNAL', safeMessage: 'Internal error' });
  });
});

// ─── PII 护栏(核心)──────────────────────────────────────────────────────────
describe('classifyError — PII 护栏(绝不读 err.message 进 safeMessage)', () => {
  it('原生 Error 含路径 → 兜底 internal + 固定 safeMessage,不含原 message', () => {
    const secret = 'D:\\Users\\secret\\project';
    const r = classifyError(new Error(`Path resolution failed at ${secret}`));
    expect(r).toEqual({ category: 'internal', retryable: false, code: 'INTERNAL', safeMessage: 'Internal error' });
    // 关键断言:safeMessage 绝不含原 message 里的 PII 路径
    expect(r.safeMessage).not.toContain(secret);
    expect(r.safeMessage).not.toContain('Path resolution failed');
  });

  it('原生 Error 含用户名 → safeMessage 不含', () => {
    const r = classifyError(new Error('cannot access /home/alice/.config'));
    expect(r.safeMessage).toBe('Internal error');
    expect(r.safeMessage).not.toContain('alice');
  });

  it('非 Error 值(string/null/undefined/object)兜底 internal', () => {
    for (const v of ['a string', null, undefined, { foo: 1 }, 42]) {
      const r = classifyError(v);
      expect(r.category).toBe('internal');
      expect(r.retryable).toBe(false);
      expect(r.safeMessage).toBe('Internal error');
    }
  });
});

// ─── 自定义 safeMessage / code 透传 ───────────────────────────────────────────
describe('classifyError — 自定义构造参数透传', () => {
  it('PathError 自定义 safeMessage + code', () => {
    const r = classifyError(new PathError('Not a valid Godot project (no project.godot found)', 'PROJECT_ROOT_INVALID'));
    expect(r.safeMessage).toBe('Not a valid Godot project (no project.godot found)');
    expect(r.code).toBe('PROJECT_ROOT_INVALID');
    expect(r.category).toBe('path');
  });

  it('ConnectionError 自定义 safeMessage(保留 code=NOT_CONNECTED)', () => {
    const r = classifyError(new ConnectionError('Cannot authenticate: not connected or no secret'));
    expect(r.safeMessage).toBe('Cannot authenticate: not connected or no secret');
    expect(r.code).toBe('NOT_CONNECTED');
    expect(r.retryable).toBe(true);
  });
});

// ─── newTraceId ───────────────────────────────────────────────────────────────
describe('newTraceId', () => {
  it('生成 32 字符 hex(批 C/C1 2026-11-13: randomUUID 全长,对齐 OTel traceId 32-hex 口径)', () => {
    const id = newTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('每次调用唯一(CSPRNG 随机源)', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTraceId()));
    expect(ids.size).toBe(200);
  });
});
