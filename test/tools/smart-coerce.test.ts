import { describe, it, expect } from 'vitest';
import { smartCoerce, coerceRect2 } from '../../src/tools/smart-coerce.js';

describe('smartCoerce', () => {
  // ── Hex colors ──

  describe('hex color conversion', () => {
    it('should convert 6-digit hex to Color', () => {
      expect(smartCoerce('#ff0000')).toBe('Color(1, 0, 0, 1)');
    });

    it('should convert 3-digit short hex to Color', () => {
      expect(smartCoerce('#FFF')).toBe('Color(1, 1, 1, 1)');
    });

    it('should convert 8-digit hex with alpha to Color', () => {
      // 0x80 / 255 ≈ 0.502
      const result = smartCoerce('#ff000080');
      expect(result).toBe('Color(1, 0, 0, 0.502)');
    });

    it('should convert #000 to Color(0, 0, 0, 1)', () => {
      expect(smartCoerce('#000')).toBe('Color(0, 0, 0, 1)');
    });

    it('should handle mixed case hex', () => {
      expect(smartCoerce('#AbCdEf')).toBe('Color(0.671, 0.804, 0.937, 1)');
    });
  });

  // ── Named colors ──

  describe('named color conversion', () => {
    it('should convert "red" to Color', () => {
      expect(smartCoerce('red')).toBe('Color(1, 0, 0, 1)');
    });

    it('should convert "blue" to Color', () => {
      expect(smartCoerce('blue')).toBe('Color(0, 0, 1, 1)');
    });

    it('should convert "green" to Color', () => {
      expect(smartCoerce('green')).toBe('Color(0, 0.502, 0, 1)');
    });

    it('should convert "transparent" to Color with alpha 0', () => {
      expect(smartCoerce('transparent')).toBe('Color(0, 0, 0, 0)');
    });

    it('should be case-insensitive', () => {
      expect(smartCoerce('RED')).toBe('Color(1, 0, 0, 1)');
      expect(smartCoerce('Blue')).toBe('Color(0, 0, 1, 1)');
    });

    it('should handle "white" and "black"', () => {
      expect(smartCoerce('white')).toBe('Color(1, 1, 1, 1)');
      expect(smartCoerce('black')).toBe('Color(0, 0, 0, 1)');
    });
  });

  // ── Comma-separated vectors ──

  describe('comma-separated vector conversion', () => {
    it('should convert "100,200" to Vector2-like object', () => {
      expect(smartCoerce('100,200')).toEqual({ x: 100, y: 200 });
    });

    it('should convert "100,200,50" to Vector3-like object', () => {
      expect(smartCoerce('100,200,50')).toEqual({ x: 100, y: 200, z: 50 });
    });

    it('should handle spaces around commas', () => {
      expect(smartCoerce('100, 200')).toEqual({ x: 100, y: 200 });
      expect(smartCoerce('100 , 200 , 50')).toEqual({ x: 100, y: 200, z: 50 });
    });

    it('should handle negative numbers', () => {
      expect(smartCoerce('-10,20')).toEqual({ x: -10, y: 20 });
      expect(smartCoerce('-1,-2,-3')).toEqual({ x: -1, y: -2, z: -3 });
    });

    it('should handle decimal numbers', () => {
      expect(smartCoerce('1.5,2.5')).toEqual({ x: 1.5, y: 2.5 });
    });
  });

  // ── Non-convertible values ──

  describe('non-convertible values', () => {
    it('should return non-string primitives unchanged', () => {
      expect(smartCoerce(42)).toBe(42);
      expect(smartCoerce(true)).toBe(true);
      expect(smartCoerce(null)).toBe(null);
      expect(smartCoerce(undefined)).toBe(undefined);
    });

    it('should return unrecognized strings unchanged', () => {
      expect(smartCoerce('hello')).toBe('hello');
      expect(smartCoerce('#xyz')).toBe('#xyz');
      expect(smartCoerce('not_a_color')).toBe('not_a_color');
    });
  });
});

describe('coerceRect2', () => {
  it('should convert {x, y, w, h} object to Rect2 string', () => {
    expect(coerceRect2({ x: 10, y: 20, w: 100, h: 50 }))
      .toBe('Rect2(10, 20, 100, 50)');
  });

  it('should return original value if keys are not exactly x,y,w,h', () => {
    const obj = { x: 10, y: 20, w: 100, h: 50, extra: 1 };
    expect(coerceRect2(obj)).toBe(obj);
  });

  it('should return original value if missing keys', () => {
    expect(coerceRect2({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('should return non-objects unchanged', () => {
    expect(coerceRect2(42)).toBe(42);
    expect(coerceRect2('string')).toBe('string');
    expect(coerceRect2(null)).toBe(null);
  });

  it('should return original if values are not numbers', () => {
    expect(coerceRect2({ x: '10', y: '20', w: '100', h: '50' }))
      .toEqual({ x: '10', y: '20', w: '100', h: '50' });
  });
});
