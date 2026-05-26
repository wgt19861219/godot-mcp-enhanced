import { expect, it, describe } from 'vitest';
import {
  ANIM_ERROR_CODES,
  TRACK_TYPES,
  LOOP_MODES,
  valueToGd,
  argsToGd,
  animErrorMapper,
  ensureNumber,
} from '../src/tools/animation-shared.js';

// ─── ANIM_ERROR_CODES ────────────────────────────────────────────────────────

describe('ANIM_ERROR_CODES', () => {
  it('has expected keys', () => {
    expect('INVALID_ACTION' in ANIM_ERROR_CODES).toBeTruthy();
    expect('NODE_NOT_FOUND' in ANIM_ERROR_CODES).toBeTruthy();
    expect('ANIM_NOT_FOUND' in ANIM_ERROR_CODES).toBeTruthy();
    expect('TRACK_NOT_FOUND' in ANIM_ERROR_CODES).toBeTruthy();
    expect('KEYFRAME_NOT_FOUND' in ANIM_ERROR_CODES).toBeTruthy();
    expect('INVALID_PARAMS' in ANIM_ERROR_CODES).toBeTruthy();
    expect('SCRIPT_EXEC_FAILED' in ANIM_ERROR_CODES).toBeTruthy();
  });
  it('has invalid_track_type is not present (not a key)', () => {
    expect('invalid_track_type' in ANIM_ERROR_CODES).toBeFalsy();
  });
});

// ─── TRACK_TYPES ─────────────────────────────────────────────────────────────

describe('TRACK_TYPES', () => {
  it('is non-empty array', () => {
    expect(Array.isArray(TRACK_TYPES)).toBeTruthy();
    expect(TRACK_TYPES.length).toBeGreaterThan(0);
  });
  it('contains "value"', () => {
    expect(TRACK_TYPES.includes('value')).toBeTruthy();
  });
  it('contains "position_3d"', () => {
    expect(TRACK_TYPES.includes('position_3d')).toBeTruthy();
  });
  it('contains "method"', () => {
    expect(TRACK_TYPES.includes('method')).toBeTruthy();
  });
  it('contains "bezier"', () => {
    expect(TRACK_TYPES.includes('bezier')).toBeTruthy();
  });
  it('has 9 track types', () => {
    expect(TRACK_TYPES.length).toBe(9);
  });
});

// ─── LOOP_MODES ──────────────────────────────────────────────────────────────

describe('LOOP_MODES', () => {
  it('contains none, linear, pingpong', () => {
    expect(LOOP_MODES.includes('none')).toBeTruthy();
    expect(LOOP_MODES.includes('linear')).toBeTruthy();
    expect(LOOP_MODES.includes('pingpong')).toBeTruthy();
  });
  it('has exactly 3 modes', () => {
    expect(LOOP_MODES.length).toBe(3);
  });
});

// ─── valueToGd ───────────────────────────────────────────────────────────────

describe('valueToGd', () => {
  it('converts numbers', () => {
    expect(valueToGd(42)).toBe('42');
  });
  it('converts negative numbers', () => {
    expect(valueToGd(-3.14)).toBe('-3.14');
  });
  it('converts zero', () => {
    expect(valueToGd(0)).toBe('0');
  });
  it('converts strings with quotes', () => {
    expect(valueToGd('hello')).toBe('"hello"');
  });
  it('converts boolean true', () => {
    expect(valueToGd(true)).toBe('true');
  });
  it('converts boolean false', () => {
    expect(valueToGd(false)).toBe('false');
  });
  it('converts null to "null"', () => {
    expect(valueToGd(null)).toBe('null');
  });
  it('converts undefined to "null"', () => {
    expect(valueToGd(undefined)).toBe('null');
  });
  it('converts 2-element array to Vector2', () => {
    expect(valueToGd([1, 2])).toBe('Vector2(1, 2)');
  });
  it('converts 3-element array to Vector3', () => {
    expect(valueToGd([1, 2, 3])).toBe('Vector3(1, 2, 3)');
  });
  it('converts 3-element array with rotation_3d to Quaternion', () => {
    expect(valueToGd([0.1, 0.2, 0.3], 'rotation_3d')).toBe(
      'Quaternion.from_euler(Vector3(0.1, 0.2, 0.3))'
    );
  });
  it('converts 4-element array to Color', () => {
    expect(valueToGd([1, 0, 0, 1])).toBe('Color(1, 0, 0, 1)');
  });
  it('converts longer array to JSON', () => {
    expect(valueToGd([1, 2, 3, 4, 5])).toBe('[1,2,3,4,5]');
  });
  it('throws for object types', () => {
    expect(() => valueToGd({})).toThrow();
  });
});

// ─── argsToGd ────────────────────────────────────────────────────────────────

describe('argsToGd', () => {
  it('converts empty args', () => {
    expect(argsToGd()).toBe('[]');
  });
  it('converts empty array', () => {
    expect(argsToGd([])).toBe('[]');
  });
  it('converts mixed args', () => {
    const result = argsToGd([42, 'hello', true]);
    expect(result).toBe('[42, "hello", true]');
  });
  it('converts single number arg', () => {
    expect(argsToGd([10])).toBe('[10]');
  });
});

// ─── animErrorMapper ─────────────────────────────────────────────────────────

describe('animErrorMapper', () => {
  it('maps AnimationPlayer not found to NODE_NOT_FOUND', () => {
    expect(animErrorMapper('AnimationPlayer not found')).toBe(ANIM_ERROR_CODES.NODE_NOT_FOUND);
  });
  it('maps Animation not found to ANIM_NOT_FOUND', () => {
    expect(animErrorMapper('Animation not found: idle')).toBe(ANIM_ERROR_CODES.ANIM_NOT_FOUND);
  });
  it('maps Track index not found to TRACK_NOT_FOUND', () => {
    expect(animErrorMapper('Track index not found: 5')).toBe(ANIM_ERROR_CODES.TRACK_NOT_FOUND);
  });
  it('maps Keyframe not found to KEYFRAME_NOT_FOUND', () => {
    expect(animErrorMapper('Keyframe not found: 3')).toBe(ANIM_ERROR_CODES.KEYFRAME_NOT_FOUND);
  });
  it('maps unknown errors to SCRIPT_EXEC_FAILED', () => {
    expect(animErrorMapper('something went wrong')).toBe(ANIM_ERROR_CODES.SCRIPT_EXEC_FAILED);
  });
  it('maps empty string to SCRIPT_EXEC_FAILED', () => {
    expect(animErrorMapper('')).toBe(ANIM_ERROR_CODES.SCRIPT_EXEC_FAILED);
  });
});

// ─── ensureNumber ────────────────────────────────────────────────────────────

describe('ensureNumber', () => {
  it('returns number for valid input', () => {
    expect(ensureNumber(42, 'test')).toBe(42);
  });
  it('returns number for float input', () => {
    expect(ensureNumber(3.14, 'test')).toBe(3.14);
  });
  it('returns number for string number', () => {
    expect(ensureNumber('10', 'test')).toBe(10);
  });
  it('throws for NaN', () => {
    expect(() => ensureNumber(NaN, 'test')).toThrow();
  });
  it('throws for Infinity', () => {
    expect(() => ensureNumber(Infinity, 'test')).toThrow();
  });
  it('throws for undefined', () => {
    expect(() => ensureNumber(undefined, 'test')).toThrow();
  });
  it('Number(null) yields 0 (does not throw)', () => {
    // Number(null) === 0, which is finite, so ensureNumber does NOT throw
    expect(ensureNumber(null, 'test')).toBe(0);
  });
  it('includes param name in error message', () => {
    expect(() => ensureNumber(NaN, 'my_param')).toThrow('my_param');
  });
});
