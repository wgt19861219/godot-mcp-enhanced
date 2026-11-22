// 错误码注册表 + opsError 自动补全 retryable 单测(竞品综述建议⑤,2026-11-13 批 A/A1)。
// 核心契约:显式传参优先(已带 retryable 的调用点行为零变化)/未登记码保守 false+warn 一次
// (不拒调用)/已登记码未传时按注册表补全/异常路径(tool-errors.ts 9 类默认码)与返回路径
// 同一张表背书(修复 TIMEOUT 同码不同义断裂)。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock logger(warn-once 断言需要可观测;避免真实文件 IO)
const warnMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() }),
}));

import { ERROR_CODES, resetUnregisteredCodeWarnings } from '../../src/core/error-codes.js';
import { opsError, opsErrorResult } from '../../src/core/shared/errors.js';
import {
  classifyError,
  ValidationError,
  PathError,
  ConnectionError,
  TimeoutError,
  ToolDeadlineError,
  TransportError,
  GuardError,
  RateLimitError,
  InternalError,
} from '../../src/core/tool-errors.js';

beforeEach(() => {
  warnMock.mockClear();
  resetUnregisteredCodeWarnings();
});

// ─── 注册表本身 ───────────────────────────────────────────────────────────────
describe('ERROR_CODES 注册表', () => {
  it('规模 ≥ 25 码(覆盖 ~90% opsErrorResult 调用点的收编承诺)', () => {
    expect(Object.keys(ERROR_CODES).length).toBeGreaterThanOrEqual(25);
  });

  it('每码声明齐全(retryable/meaning 必有,category 为合法枚举之一)', () => {
    // 内存治理一期 Task 5:新增 'resource' 类别(MEMGUARD_* 四码)
    const validCategories = new Set(['validation', 'timeout', 'transport', 'guard', 'path', 'connection', 'internal', 'resource']);
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(typeof spec.retryable, `${code}.retryable`).toBe('boolean');
      expect(spec.meaning.length, `${code}.meaning 非空`).toBeGreaterThan(0);
      expect(validCategories.has(spec.category!), `${code}.category=${spec.category}`).toBe(true);
    }
  });

  it('关键高频码在册(grep 频率前 3 + 方案点名瞬态码)', () => {
    for (const code of [
      'INVALID_PARAMS', 'UNKNOWN_ACTION', 'INVALID_PATH', // 频率前 3(180/36/24 处)
      'NOT_CONNECTED', 'BRIDGE_NOT_CONNECTED', 'BRIDGE_TIMEOUT', 'TIMEOUT',
      'RATE_LIMIT', 'CONCURRENCY_LIMIT', 'TOOL_CIRCUIT_OPEN', 'SERVER_STALE',
    ]) {
      expect(ERROR_CODES[code], code).toBeDefined();
    }
  });

  // 内存治理一期 Task 5(2026-11-22):MEMGUARD 4 码收编——准入三拒可重试(水位回升/
  // 预算释放/进程退出后同参数重试有意义),超预算被杀不可重试(原样重试同参数必再被杀,
  // 须先上调声明档位)。未注册前 denial 走 opsErrorResult 落兜底 retryable:false,
  // 与报文「稍后重试」建议自相矛盾(审查制度项)。
  it('MEMGUARD 4 码注册(准入拒绝 retryable:true,超预算杀 retryable:false,均 resource)', () => {
    expect(ERROR_CODES.MEMGUARD_LOW_WATER).toEqual({
      retryable: true, category: 'resource', meaning: '内存水位不足拒 spawn',
    });
    expect(ERROR_CODES.MEMGUARD_BUDGET).toMatchObject({ retryable: true, category: 'resource' });
    expect(ERROR_CODES.MEMGUARD_INSTANCE_CAP).toMatchObject({ retryable: true, category: 'resource' });
    expect(ERROR_CODES.MEM_BUDGET_EXCEEDED).toEqual({
      retryable: false, category: 'resource', meaning: '进程超内存预算被看门狗终止',
    });
    // 补全语义闭环:deny 码经 opsError 补全不再落兜底 false
    expect(opsError('MEMGUARD_LOW_WATER', 'm').retryable).toBe(true);
    expect(opsError('MEMGUARD_LOW_WATER', 'm').error_category).toBe('resource');
    expect(opsError('MEM_BUDGET_EXCEEDED', 'm').retryable).toBe(false);
  });
});

// ─── opsError 自动补全 ────────────────────────────────────────────────────────
describe('opsError — retryable/errorCategory 自动补全', () => {
  it('显式传参优先:未知码显式传 true 仍是 true(不被保守 false 覆盖)', () => {
    const r = opsError('NEVER_REGISTERED_CODE', 'm', { retryable: true });
    expect(r.retryable).toBe(true);
  });

  it('显式传参优先:已登记 true 的码显式传 false 仍是 false(零破坏)', () => {
    const r = opsError('RATE_LIMIT', 'm', { retryable: false });
    expect(r.retryable).toBe(false);
  });

  it('已登记码未传 retryable → 按注册表补全', () => {
    expect(opsError('INVALID_PARAMS', 'm').retryable).toBe(false);
    expect(opsError('RATE_LIMIT', 'm').retryable).toBe(true);
  });

  it('已登记码未传 errorCategory → 按注册表补全 error_category', () => {
    expect(opsError('INVALID_PARAMS', 'm').error_category).toBe('validation');
    expect(opsError('PATH_NOT_ALLOWED', 'm').error_category).toBe('path');
  });

  it('显式 errorCategory 优先于注册表', () => {
    const r = opsError('INVALID_PARAMS', 'm', { errorCategory: 'internal' });
    expect(r.error_category).toBe('internal');
  });

  it('未登记码:保守补 false + warn 一次(同码不重复警),不拒调用', () => {
    const first = opsError('TOTALLY_UNKNOWN_A', 'm');
    expect(first).toMatchObject({ success: false, error_code: 'TOTALLY_UNKNOWN_A', retryable: false });
    expect(first.error_category).toBeUndefined(); // 无据可依,不编造分类
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toContain('TOTALLY_UNKNOWN_A');

    opsError('TOTALLY_UNKNOWN_A', 'm'); // 同码第二次:不再警
    expect(warnMock).toHaveBeenCalledTimes(1);

    opsError('TOTALLY_UNKNOWN_B', 'm'); // 异码:各警一次
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('opsErrorResult 走同一补全(JSON 体携带补全字段)', () => {
    const parsed = JSON.parse(opsErrorResult('TIMEOUT', 'm').content[0]!.text);
    expect(parsed).toMatchObject({ success: false, error_code: 'TIMEOUT', retryable: true, error_category: 'timeout' });
  });
});

// ─── 异常路径与返回路径同一张表背书 ───────────────────────────────────────────
describe('tool-errors.ts 9 异常类默认码 ↔ 注册表对齐', () => {
  const cases: Array<[string, new () => Error]> = [
    ['INVALID_PARAMS', ValidationError],
    ['PATH_NOT_ALLOWED', PathError],
    ['NOT_CONNECTED', ConnectionError],
    ['TIMEOUT', TimeoutError],
    ['TOOL_DEADLINE_EXCEEDED', ToolDeadlineError],
    ['TRANSPORT', TransportError],
    ['GUARD', GuardError],
    ['RATE_LIMIT', RateLimitError],
    ['INTERNAL', InternalError],
  ];

  it.each(cases)('%s:classifyError 的 retryable/category 与注册表逐字段一致', (code, Ctor) => {
    const spec = ERROR_CODES[code];
    expect(spec, `${code} 在注册表`).toBeDefined();
    const c = classifyError(new Ctor());
    expect(c.retryable).toBe(spec!.retryable);
    expect(c.category).toBe(spec!.category);
  });
});
