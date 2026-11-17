import { describe, it, expect } from 'vitest';
import { checkBudget, THRESHOLDS } from '../../scripts/check-token-budget.mjs';

function mkCap(name: string, descBytes: number, schemaBytes: number) {
  return { name, group: 'core', size: { descBytes, schemaBytes, totalBytes: descBytes + schemaBytes } };
}

describe('checkBudget', () => {
  it('clean caps → no warnings, no errors', () => {
    const caps = [mkCap('a', 100, 1000), mkCap('b', 200, 2000)];
    const r = checkBudget(caps as never);
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.sum).toBe(3300);
  });

  it('per-tool total in warn band → warning, not error', () => {
    const caps = [mkCap('big', 1000, 6100)]; // total 7100 ≥ perToolTotal.warn(7000), < error(14000)
    const r = checkBudget(caps as never);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some(w => w.includes('big'))).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('per-tool schema over error threshold → error', () => {
    const caps = [mkCap('huge', 100, 13600)]; // schema ≥ perToolSchema.error(13600)
    const r = checkBudget(caps as never);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some(e => e.includes('huge'))).toBe(true);
  });

  it('total sum over error threshold → error', () => {
    // 构造 sum ≥ 120KB
    const caps = Array.from({ length: 20 }, (_, i) => mkCap(`t${i}`, 500, 6000)); // 20×6500 = 130000 ≥ 120*1024
    const r = checkBudget(caps as never);
    expect(r.errors.some(e => e.includes('total'))).toBe(true);
  });

  it('THRESHOLDS constants match spec', () => {
    expect(THRESHOLDS.perToolDesc.warn).toBe(800);
    expect(THRESHOLDS.perToolDesc.error).toBe(2000);
    expect(THRESHOLDS.perToolSchema.warn).toBe(6000);
    // 2026-11-17 (Refero 批4 首任务) 二录校准 13000→13600/14000→14400(detail 参数+draft_path+
    // enum+2+描述扩写增量水位);批4 首任务漏改本断言(既有红),Task 3 收口补齐。见 check-token-budget.mjs 注释。
    expect(THRESHOLDS.perToolSchema.error).toBe(13600);
    expect(THRESHOLDS.perToolTotal.warn).toBe(7000);
    expect(THRESHOLDS.perToolTotal.error).toBe(14400);
    // totalSum warn 2026-08-16 校准 80KB→90KB(实测 86412B 超旧线 5.5%,对齐覆盖率阈值
    // ">4% 持续超额应上调"惯例);error 120KB 硬线不变。见 check-token-budget.mjs 注释。
    // P4-1 (2026-09-11) game 描述瘦身后全量 ~94KB,warn 90→95KB;P9 (2026-09-12) 校准 95→105KB
    // (P8 热加载/SSOT 描述 + P9 dap 工具正当增量推至 ~103.9KB,审查 N-5 记录)
    // 易用性批 1 (2026-09-19) 23 工具 action 描述补全等正当增量 ~4.7KB 推至 ~110.8KB——
    // 校准 105→112KB(error 120KB 硬线不变),见 check-token-budget.mjs 注释
    // B1 (2026-10-19) find_ui_elements role/match 参数正当增量推至 ~112.5KB——校准 112→116KB
    // 批 A (2026-10-26) 描述压缩治理 116975→111923B(-5.0KB)——校准 116→112KB(瘦身即校准
    // 惯例)。终值以 check-token-budget.mjs 注释为准(2026-10-29 审查 L-5:本注释曾写 111778B 漂移)。
    // 2026-11-17 (Refero 批3 首任务) 校准 112→113KiB(批1/批2 增量后实测 114376B,批3 预计越旧线)
    // + error 线首录 12000→13000(ui schema 11992B 余 8B,校准不瘦身)。见 check-token-budget.mjs 注释。
    expect(THRESHOLDS.totalSum.warn).toBe(113 * 1024);
    expect(THRESHOLDS.totalSum.error).toBe(120 * 1024);
  });
});
