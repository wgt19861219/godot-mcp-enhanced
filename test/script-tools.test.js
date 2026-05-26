import { expect } from 'vitest';
import { getToolDefinitions } from '../src/tools/script.js';

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('script-tools getToolDefinitions', () => {
  const defs = getToolDefinitions();

  it('returns 7 tool definitions', () => {
    expect(defs.length).toBe(7);
  });

  const expected = [
    'read_script', 'write_script', 'edit_script',
    'generate_test', 'create_test_scene',
    'execute_gdscript', 'project_replace',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(defs.some(d => d.name === name)).toBeTruthy();
    });
  }

  it('every tool has description and inputSchema', () => {
    for (const d of defs) {
      expect(d.description).toBeTruthy();
      expect(d.inputSchema).toBeTruthy();
      expect(d.inputSchema.type).toBe('object');
    }
  });
});

// ─── edit_script schema specifics ─────────────────────────────────────────

describe('script-tools edit_script schema', () => {
  const defs = getToolDefinitions();
  const editDef = defs.find(d => d.name === 'edit_script');

  it('has search_and_replace optional property', () => {
    const sr = editDef.inputSchema.properties.search_and_replace;
    expect(sr).toBeTruthy();
    expect(sr.type).toBe('object');
    expect(sr.properties.search).toBeTruthy();
    expect(sr.properties.replace).toBeTruthy();
  });

  it('has auto_validate with default true', () => {
    const av = editDef.inputSchema.properties.auto_validate;
    expect(av).toBeTruthy();
    expect(av.default).toBe(true);
  });

  it('has indent_mode with raw and smart options', () => {
    const im = editDef.inputSchema.properties.indent_mode;
    expect(im).toBeTruthy();
    expect(im.enum.includes('raw')).toBeTruthy();
    expect(im.enum.includes('smart')).toBeTruthy();
  });
});

// ─── write_script lint integration ────────────────────────────────────────

describe('script-tools lint integration', () => {
  it('lintGDScript detects Godot 4.x deprecated property (L002)', async () => {
    const { lintGDScript } = await import('../src/tools/gdscript-lint.js');
    const code = 'extends RigidBody3D\n\nfunc _ready():\n\tvar body = RigidBody3D.new()\n\tbody.bounce = 0.5\n';
    const result = lintGDScript(code);
    expect(result.errors.length > 0).toBeTruthy();
    expect(result.errors[0].rule).toBe('L002');
  });

  it('lintGDScript passes code without deprecated patterns', async () => {
    const { lintGDScript } = await import('../src/tools/gdscript-lint.js');
    const code = 'extends Node\n\nfunc _ready():\n\tpass\n';
    const result = lintGDScript(code);
    expect(result.errors.length + result.warnings.length).toBe(0);
  });
});

// ─── project_replace schema ───────────────────────────────────────────────

describe('script-tools project_replace schema', () => {
  const defs = getToolDefinitions();
  const prDef = defs.find(d => d.name === 'project_replace');

  it('has dry_run with default false', () => {
    const dr = prDef.inputSchema.properties.dry_run;
    expect(dr).toBeTruthy();
    expect(dr.default).toBe(false);
  });

  it('has extensions with default .gd', () => {
    const ext = prDef.inputSchema.properties.extensions;
    expect(ext).toBeTruthy();
    expect(ext.default).toEqual(['.gd']);
  });
});
