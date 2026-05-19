import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintGDScript } from '../build/tools/gdscript-lint.js';

describe('GDScript Lint', () => {
  it('returns empty results for clean code', () => {
    const code = 'extends Node3D\n\nfunc _ready():\n\tpass';
    const result = lintGDScript(code, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.meta.godot_target, '4.6');
  });

  it('returns meta information', () => {
    const result = lintGDScript('', true);
    assert.ok(result.meta.rules_count >= 0);
    assert.ok(result.meta.last_reviewed);
  });
});
