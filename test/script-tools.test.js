import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions } from '../build/tools/script.js';

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('script-tools getToolDefinitions', () => {
  const defs = getToolDefinitions();

  it('returns 7 tool definitions', () => {
    assert.strictEqual(defs.length, 7);
  });

  const expected = [
    'read_script', 'write_script', 'edit_script',
    'generate_test', 'create_test_scene',
    'execute_gdscript', 'project_replace',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      assert.ok(defs.some(d => d.name === name), `missing: ${name}`);
    });
  }

  it('every tool has description and inputSchema', () => {
    for (const d of defs) {
      assert.ok(d.description, `${d.name} missing description`);
      assert.ok(d.inputSchema, `${d.name} missing inputSchema`);
      assert.strictEqual(d.inputSchema.type, 'object');
    }
  });
});

// ─── edit_script schema specifics ─────────────────────────────────────────

describe('script-tools edit_script schema', () => {
  const defs = getToolDefinitions();
  const editDef = defs.find(d => d.name === 'edit_script');

  it('has search_and_replace optional property', () => {
    const sr = editDef.inputSchema.properties.search_and_replace;
    assert.ok(sr, 'missing search_and_replace property');
    assert.strictEqual(sr.type, 'object');
    assert.ok(sr.properties.search, 'missing search field');
    assert.ok(sr.properties.replace, 'missing replace field');
  });

  it('has auto_validate with default true', () => {
    const av = editDef.inputSchema.properties.auto_validate;
    assert.ok(av, 'missing auto_validate property');
    assert.strictEqual(av.default, true);
  });

  it('has indent_mode with raw and smart options', () => {
    const im = editDef.inputSchema.properties.indent_mode;
    assert.ok(im, 'missing indent_mode property');
    assert.ok(im.enum.includes('raw'));
    assert.ok(im.enum.includes('smart'));
  });
});

// ─── write_script lint integration ────────────────────────────────────────

describe('script-tools lint integration', () => {
  it('lintGDScript detects Godot 4.x deprecated property (L002)', async () => {
    const { lintGDScript } = await import('../build/tools/gdscript-lint.js');
    const code = 'extends RigidBody3D\n\nfunc _ready():\n\tvar body = RigidBody3D.new()\n\tbody.bounce = 0.5\n';
    const result = lintGDScript(code);
    assert.ok(result.errors.length > 0, 'should detect deprecated bounce property');
    assert.strictEqual(result.errors[0].rule, 'L002');
  });

  it('lintGDScript passes code without deprecated patterns', async () => {
    const { lintGDScript } = await import('../build/tools/gdscript-lint.js');
    const code = 'extends Node\n\nfunc _ready():\n\tpass\n';
    const result = lintGDScript(code);
    assert.strictEqual(result.errors.length + result.warnings.length, 0);
  });
});

// ─── project_replace schema ───────────────────────────────────────────────

describe('script-tools project_replace schema', () => {
  const defs = getToolDefinitions();
  const prDef = defs.find(d => d.name === 'project_replace');

  it('has dry_run with default false', () => {
    const dr = prDef.inputSchema.properties.dry_run;
    assert.ok(dr, 'missing dry_run property');
    assert.strictEqual(dr.default, false);
  });

  it('has extensions with default .gd', () => {
    const ext = prDef.inputSchema.properties.extensions;
    assert.ok(ext, 'missing extensions property');
    assert.deepStrictEqual(ext.default, ['.gd']);
  });
});
