import { expect } from 'vitest';
import {
  normalizeNodePath, gdEscape, validateVector3,
  TYPE_WHITELIST,
} from '../src/tools/shared.js';
import { genNavQueryScript } from '../src/tools/navigation.js';

describe('normalizeNodePath', () => {
  it('prepends / if missing', () => {
    expect(normalizeNodePath('root/Player')).toBe('/root/Player');
  });
  it('keeps /root/... unchanged', () => {
    expect(normalizeNodePath('/root/Player')).toBe('/root/Player');
  });
  it('rejects empty string', () => {
    expect(() => normalizeNodePath('')).toThrow(/empty/);
  });
  it('rejects whitespace-only', () => {
    expect(() => normalizeNodePath('   ')).toThrow(/empty/);
  });
  it('rejects res:// paths', () => {
    expect(() => normalizeNodePath('res://scenes/main.tscn')).toThrow(/scene tree path/);
  });
  it('trims whitespace', () => {
    expect(normalizeNodePath('  /root/Player  ')).toBe('/root/Player');
  });
});

describe('gdEscape', () => {
  it('escapes double quotes', () => {
    expect(gdEscape('say "hello"')).toBe('say \\"hello\\"');
  });
  it('escapes backslashes', () => {
    expect(gdEscape('path\\to\\file')).toBe('path\\\\to\\\\file');
  });
  it('escapes newlines', () => {
    expect(gdEscape('line1\nline2')).toBe('line1\\nline2');
  });
  it('escapes CRLF', () => {
    expect(gdEscape('a\r\nb')).toBe('a\\nb');
  });
  it('removes null bytes', () => {
    expect(gdEscape('a\0b')).toBe('ab');
  });
  it('preserves unicode', () => {
    expect(gdEscape('你好世界')).toBe('你好世界');
  });
  it('handles empty string', () => {
    expect(gdEscape('')).toBe('');
  });
});

describe('validateVector3', () => {
  it('accepts valid {x,y,z}', () => {
    expect(validateVector3({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
  });
  it('accepts zero values', () => {
    expect(validateVector3({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
  it('accepts negative values', () => {
    expect(validateVector3({ x: -1, y: -2.5, z: -3 })).toEqual({ x: -1, y: -2.5, z: -3 });
  });
  it('rejects missing field', () => {
    expect(() => validateVector3({ x: 1, y: 2 })).toThrow(/finite number/);
  });
  it('rejects non-number value', () => {
    expect(() => validateVector3({ x: '1', y: 2, z: 3 })).toThrow(/finite number/);
  });
  it('rejects null', () => {
    expect(() => validateVector3(null)).toThrow(/object/);
  });
  it('rejects NaN', () => {
    expect(() => validateVector3({ x: NaN, y: 0, z: 0 })).toThrow(/finite number/);
  });
  it('rejects Infinity', () => {
    expect(() => validateVector3({ x: 0, y: Infinity, z: 0 })).toThrow(/finite number/);
  });
});

describe('TYPE_WHITELIST', () => {
  it('contains Node3D', () => { expect(TYPE_WHITELIST.includes('Node3D')).toBeTruthy(); });
  it('contains MeshInstance3D', () => { expect(TYPE_WHITELIST.includes('MeshInstance3D')).toBeTruthy(); });
  it('contains Camera3D', () => { expect(TYPE_WHITELIST.includes('Camera3D')).toBeTruthy(); });
  it('contains RigidBody3D', () => { expect(TYPE_WHITELIST.includes('RigidBody3D')).toBeTruthy(); });
  it('does NOT contain Node', () => { expect(TYPE_WHITELIST.includes('Node')).toBeFalsy(); });
});

describe('genNavQueryScript', () => {
  it('contains NavigationServer3D.map_get_path', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10});
    expect(script.includes('NavigationServer3D.map_get_path')).toBeTruthy();
    expect(script.includes('Vector3(0, 0, 0)')).toBeTruthy();
    expect(script.includes('Vector3(10, 0, 10)')).toBeTruthy();
  });
  it('includes region lookup when provided', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10}, '/root/NavRegion');
    expect(script.includes('NavigationRegion3D')).toBeTruthy();
    expect(script.includes('/root/NavRegion')).toBeTruthy();
  });
  it('includes fallback maps logic', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10});
    expect(script.includes('get_maps')).toBeTruthy();
    expect(script.includes('warning')).toBeTruthy();
  });
});
