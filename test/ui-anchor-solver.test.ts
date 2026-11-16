import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { solveAnchors, solveAnchorsUnrounded, CONTAINER_CONTROL_TYPES } from '../src/tools/ui/anchor-solver.js';

describe('solveAnchors', () => {
  it('全填充 rect → full_rect 型锚点(0,1,0,1)零偏移', () => {
    const r = solveAnchors({ w: 1280, h: 720 }, { x: 0, y: 0, w: 1280, h: 720 });
    expect(r.anchor_left).toBe(0); expect(r.anchor_right).toBe(1);
    expect(r.anchor_top).toBe(0); expect(r.anchor_bottom).toBe(1);
    expect(r.offset_left).toBe(0); expect(r.offset_right).toBe(0);
  });

  it('居中 rect → 0.5 比例锚点 + 整数偏移', () => {
    const r = solveAnchors({ w: 1000, h: 800 }, { x: 400, y: 350, w: 200, h: 100 });
    expect(r.anchor_left).toBe(0.4); expect(r.anchor_right).toBe(0.6);
    expect(Number.isInteger(r.offset_left)).toBe(true);
  });

  it('属性:任意合法 rect 反解后前向重放误差 ≤1px', () => {
    const rectArb = fc.integer({ min: 1, max: 2000 }).chain(pw =>
      fc.integer({ min: 1, max: 2000 }).chain(ph =>
        fc.integer({ min: 0, max: pw }).chain(x =>
          fc.integer({ min: 0, max: pw - x }).chain(w =>
            fc.integer({ min: 0, max: ph }).chain(y =>
              fc.integer({ min: 0, max: ph - y }).map(h => ({ pw, ph, x, y, w, h })))))));
    fc.assert(fc.property(rectArb, ({ pw, ph, x, y, w, h }) => {
      const r = solveAnchors({ w: pw, h: ph }, { x, y, w, h });
      const fx = r.anchor_left * pw + r.offset_left;
      const fw = (r.anchor_right * pw + r.offset_right) - fx;
      const fy = r.anchor_top * ph + r.offset_top;
      const fh = (r.anchor_bottom * ph + r.offset_bottom) - fy;
      expect(Math.abs(fx - x)).toBeLessThanOrEqual(1);
      expect(Math.abs(fw - w)).toBeLessThanOrEqual(1);
      expect(Math.abs(fy - y)).toBeLessThanOrEqual(1);
      expect(Math.abs(fh - h)).toBeLessThanOrEqual(1);
    }), { numRuns: 500 });
  });

  it('父尺寸非正数 → INVALID_PARAMS', () => {
    expect(() => solveAnchors({ w: 0, h: 100 }, { x: 0, y: 0, w: 10, h: 10 })).toThrow('INVALID_PARAMS');
  });
});

// ─── 批1 1d:solveAnchorsUnrounded(浮点 offset 直出,不取整)──────────────────
// 0 容差契约:重算 anchor*parentSize + offset === childRect 严格成立(===,禁 round)。
describe('solveAnchorsUnrounded', () => {
  it('靶子真实几何:父 758.5×493.5、子 x=11.5 w=225 → anchor 未吸附 + 浮点 offset + 严格恒等', () => {
    const r = solveAnchorsUnrounded({ w: 758.5, h: 493.5 }, { x: 11.5, y: 8.5, w: 225, h: 64 });
    // anchor_left 是 11.5/758.5 的未吸附浮点值(非 0/0.5/1)
    expect(r.anchor_left).toBe(11.5 / 758.5);
    expect(r.anchor_top).toBe(8.5 / 493.5);
    expect(r.anchor_right).toBe((11.5 + 225) / 758.5);
    expect(r.anchor_bottom).toBe((8.5 + 64) / 493.5);
    // offset 为浮点直出(11.5 - (11.5/758.5)*758.5 的浮点残差,非取整值)
    expect(r.offset_left).toBe(11.5 - (11.5 / 758.5) * 758.5);
    // 0 容差数学恒等:重算严格 === childRect
    expect(r.anchor_left * 758.5 + r.offset_left).toBe(11.5);
    expect(r.anchor_top * 493.5 + r.offset_top).toBe(8.5);
    expect(r.anchor_right * 758.5 + r.offset_right).toBe(11.5 + 225);
    expect(r.anchor_bottom * 493.5 + r.offset_bottom).toBe(8.5 + 64);
  });

  it('非二进值(156.225/225)同样严格恒等——浮点残差精确补偿', () => {
    const r = solveAnchorsUnrounded({ w: 225, h: 64 }, { x: 156.225, y: 18.725, w: 18.55, h: 18.55 });
    expect(r.anchor_left).toBe(156.225 / 225);
    expect(r.anchor_left * 225 + r.offset_left).toBe(156.225);
    expect(r.anchor_right * 225 + r.offset_right).toBe(156.225 + 18.55);
    expect(r.anchor_top * 64 + r.offset_top).toBe(18.725);
    expect(r.anchor_bottom * 64 + r.offset_bottom).toBe(18.725 + 18.55);
  });

  it('吸附语义与 solveAnchors 一致:整比例值吸附到 0/0.5/1', () => {
    const r = solveAnchorsUnrounded({ w: 1000, h: 800 }, { x: 0, y: 400, w: 1000, h: 400 });
    expect(r.anchor_left).toBe(0); expect(r.anchor_right).toBe(1);
    expect(r.anchor_top).toBe(0.5); expect(r.anchor_bottom).toBe(1);
    expect(r.anchor_left * 1000 + r.offset_left).toBe(0);
    expect(r.anchor_top * 800 + r.offset_top).toBe(400);
  });

  it('属性:任意浮点 rect 反解后重算严格恒等(0 容差,禁 round)', () => {
    const arb = fc.double({ min: 0.001, max: 2000, noNaN: true }).chain(pw =>
      fc.double({ min: 0.001, max: 2000, noNaN: true }).chain(ph =>
        fc.double({ min: 0, max: pw, noNaN: true }).chain(x =>
          // max 钳到 ≥ min:x 逼近 pw 时 pw-x < 0.001 会触发 fc "min>max" 生成错误
          fc.double({ min: 0.001, max: Math.max(0.001, pw - x), noNaN: true }).chain(w =>
            fc.double({ min: 0, max: ph, noNaN: true }).chain(y =>
              fc.double({ min: 0.001, max: Math.max(0.001, ph - y), noNaN: true }).map(h => ({ pw, ph, x, y, w, h })))))));
    fc.assert(fc.property(arb, ({ pw, ph, x, y, w, h }) => {
      const r = solveAnchorsUnrounded({ w: pw, h: ph }, { x, y, w, h });
      expect(r.anchor_left * pw + r.offset_left).toBe(x);
      expect(r.anchor_top * ph + r.offset_top).toBe(y);
      expect(r.anchor_right * pw + r.offset_right).toBe(x + w);
      expect(r.anchor_bottom * ph + r.offset_bottom).toBe(y + h);
    }), { numRuns: 500 });
  });

  it('父尺寸非正数 → INVALID_PARAMS(与 solveAnchors 同语义)', () => {
    expect(() => solveAnchorsUnrounded({ w: 0, h: 100 }, { x: 0, y: 0, w: 10, h: 10 })).toThrow('INVALID_PARAMS');
  });
});

describe('CONTAINER_CONTROL_TYPES', () => {
  it('包含 BoxContainer 族与常用容器', () => {
    for (const t of ['HBoxContainer', 'VBoxContainer', 'GridContainer', 'MarginContainer']) {
      expect(CONTAINER_CONTROL_TYPES).toContain(t);
    }
  });
});
