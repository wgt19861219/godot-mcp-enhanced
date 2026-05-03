import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_ERROR_CODES,
  validateParamType,
  handleTool,
  genMaterialReadScript,
  genMaterialSetParamsScript,
  genMaterialCreateScript,
  genMaterialSaveScript,
  genMaterialLoadScript,
  genShaderReadScript,
  genShaderWriteScript,
  genShaderLoadFileScript,
  genShaderSaveFileScript,
  genShaderApplyTemplateScript,
} from '../build/tools/material-ops.js';

// ─── Error Codes ───────────────────────────────────────────────────────────

describe('MATERIAL_ERROR_CODES', () => {
  it('has MATERIAL_NOT_FOUND', () => { assert.ok('MATERIAL_NOT_FOUND' in MATERIAL_ERROR_CODES); });
  it('has INVALID_MATERIAL_TYPE', () => { assert.ok('INVALID_MATERIAL_TYPE' in MATERIAL_ERROR_CODES); });
  it('has INVALID_PARAM_TYPE', () => { assert.ok('INVALID_PARAM_TYPE' in MATERIAL_ERROR_CODES); });
  it('has SHADER_COMPILE_FAILED', () => { assert.ok('SHADER_COMPILE_FAILED' in MATERIAL_ERROR_CODES); });
  it('has RESOURCE_SAVE_FAILED', () => { assert.ok('RESOURCE_SAVE_FAILED' in MATERIAL_ERROR_CODES); });
  it('has INVALID_TEMPLATE', () => { assert.ok('INVALID_TEMPLATE' in MATERIAL_ERROR_CODES); });
  it('has SCRIPT_EXEC_FAILED', () => { assert.ok('SCRIPT_EXEC_FAILED' in MATERIAL_ERROR_CODES); });
});

// ─── validateParamType ────────────────────────────────────────────────────

describe('validateParamType', () => {
  it('returns "number" for numbers', () => {
    assert.strictEqual(validateParamType(3.14), 'number');
  });
  it('returns "number" for integers', () => {
    assert.strictEqual(validateParamType(0), 'number');
  });
  it('returns "string" for strings', () => {
    assert.strictEqual(validateParamType('hello'), 'string');
  });
  it('returns "boolean" for booleans', () => {
    assert.strictEqual(validateParamType(true), 'boolean');
  });
  it('returns "null" for null', () => {
    assert.strictEqual(validateParamType(null), 'null');
  });
  it('returns "null" for undefined', () => {
    assert.strictEqual(validateParamType(undefined), 'null');
  });
  it('returns "array" for array length 2 (Vector2)', () => {
    assert.strictEqual(validateParamType([1, 2]), 'array');
  });
  it('returns "array" for array length 3 (Vector3)', () => {
    assert.strictEqual(validateParamType([1, 2, 3]), 'array');
  });
  it('returns "array" for array length 4 (Color)', () => {
    assert.strictEqual(validateParamType([1, 0, 0, 1]), 'array');
  });
  it('rejects array length 1', () => {
    assert.throws(() => validateParamType([1]), { message: /array length 1/ });
  });
  it('rejects array length 5', () => {
    assert.throws(() => validateParamType([1, 2, 3, 4, 5]), { message: /array length 5/ });
  });
  it('rejects objects', () => {
    assert.throws(() => validateParamType({}), { message: /not supported/ });
  });
  it('rejects arrays with non-number elements', () => {
    assert.throws(() => validateParamType(['a', 'b']), { message: /must be a number/ });
  });
  it('rejects arrays with mixed types', () => {
    assert.throws(() => validateParamType([1, 'x', 3]), { message: /must be a number/ });
  });
});

// ─── genMaterialReadScript ────────────────────────────────────────────────

describe('genMaterialReadScript', () => {
  it('contains material check', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    assert.ok(script.includes('material'));
  });
  it('contains get_surface_override_material', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    assert.ok(script.includes('get_surface_override_material'));
  });
  it('contains surface_get_material', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    assert.ok(script.includes('surface_get_material'));
  });
  it('contains ShaderMaterial branch', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    assert.ok(script.includes('ShaderMaterial'));
    assert.ok(script.includes('get_shader_uniform_list'));
  });
  it('contains get_property_list for built-in materials', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    assert.ok(script.includes('get_property_list'));
    assert.ok(script.includes('PROPERTY_USAGE_STORAGE'));
  });
  it('uses material_index parameter', () => {
    const script = genMaterialReadScript('/root/Player', 2);
    assert.ok(script.includes('get_surface_override_material(2)'));
  });
});

// ─── genMaterialCreateScript ──────────────────────────────────────────────

describe('genMaterialCreateScript', () => {
  it('creates ShaderMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'ShaderMaterial');
    assert.ok(script.includes('ShaderMaterial.new()'));
    assert.ok(script.includes('material'));
  });
  it('creates StandardMaterial3D', () => {
    const script = genMaterialCreateScript('/root/Player', 'StandardMaterial3D');
    assert.ok(script.includes('StandardMaterial3D.new()'));
  });
  it('creates CanvasItemMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'CanvasItemMaterial');
    assert.ok(script.includes('CanvasItemMaterial.new()'));
  });
  it('includes shader loading when shader_path provided', () => {
    const script = genMaterialCreateScript('/root/Player', 'ShaderMaterial', 'res://shaders/player.gdshader');
    assert.ok(script.includes('ResourceLoader.exists'));
    assert.ok(script.includes('res://shaders/player.gdshader'));
  });
  it('no shader loading for non-ShaderMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'StandardMaterial3D', 'res://shaders/player.gdshader');
    assert.ok(!script.includes('ResourceLoader.exists'));
  });
});

// ─── genMaterialSetParamsScript ───────────────────────────────────────────

describe('genMaterialSetParamsScript', () => {
  it('generates is_shader branch', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { intensity: 2.5 });
    assert.ok(script.includes('is_shader'));
    assert.ok(script.includes('set_shader_parameter'));
    assert.ok(script.includes('mat.set('));
  });
  it('converts number to float', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { intensity: 2.5 });
    assert.ok(script.includes('2.5'));
  });
  it('converts array[4] to Color', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { albedo: [1, 0, 0, 1] });
    assert.ok(script.includes('Color(1, 0, 0, 1)'));
  });
  it('converts array[2] to Vector2', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { offset: [3, 4] });
    assert.ok(script.includes('Vector2(3, 4)'));
  });
  it('converts array[3] to Vector3', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { pos: [1, 2, 3] });
    assert.ok(script.includes('Vector3(1, 2, 3)'));
  });
  it('converts boolean', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { visible: true });
    assert.ok(script.includes('true'));
  });
  it('converts null', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { val: null });
    assert.ok(script.includes('null'));
  });
  it('converts string (resource path) with load() for shader', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { tex: 'res://icon.png' });
    assert.ok(script.includes('load("res://icon.png")'));
    assert.ok(script.includes('"res://icon.png"'));
  });
  it('converts plain string without load() for non-resource', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { name: 'hello' });
    assert.ok(script.includes('"hello"'));
    assert.ok(!script.includes('load("hello")'));
  });
  it('handles multiple params', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { a: 1, b: [1, 0, 0, 1] });
    assert.ok(script.includes('set_shader_parameter("a"'));
    assert.ok(script.includes('set_shader_parameter("b"'));
  });
});

// ─── genMaterialSaveScript ────────────────────────────────────────────────

describe('genMaterialSaveScript', () => {
  it('contains ResourceSaver.save', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    assert.ok(script.includes('ResourceSaver.save'));
  });
  it('contains DirAccess for auto-create directory', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    assert.ok(script.includes('make_dir_recursive'));
  });
  it('contains error check for save failure', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    assert.ok(script.includes('Failed to save'));
  });
});

// ─── genMaterialLoadScript ────────────────────────────────────────────────

describe('genMaterialLoadScript', () => {
  it('contains ResourceLoader.exists check', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    assert.ok(script.includes('ResourceLoader.exists'));
  });
  it('contains load call', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    assert.ok(script.includes('load('));
  });
  it('sets material', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    assert.ok(script.includes('material'));
  });
  it('contains not found error for missing resource', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/missing.tres');
    assert.ok(script.includes('Material not found'));
  });
});

// ─── genShaderReadScript ──────────────────────────────────────────────────

describe('genShaderReadScript', () => {
  it('contains shader code output', () => {
    const script = genShaderReadScript('/root/Player', 0);
    assert.ok(script.includes('shader_code'));
    assert.ok(script.includes('mat.shader.code'));
  });
  it('checks for ShaderMaterial type', () => {
    const script = genShaderReadScript('/root/Player', 0);
    assert.ok(script.includes('Not a ShaderMaterial'));
  });
  it('checks for null shader', () => {
    const script = genShaderReadScript('/root/Player', 0);
    assert.ok(script.includes('No shader assigned'));
  });
});

// ─── genShaderWriteScript ─────────────────────────────────────────────────

describe('genShaderWriteScript', () => {
  it('contains shader duplicate', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    assert.ok(script.includes('mat.shader.duplicate()'));
  });
  it('contains compile result check', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    assert.ok(script.includes('compile_result'));
    assert.ok(script.includes('compile_success'));
  });
  it('embeds shader code', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    assert.ok(script.includes('shader_type canvas_item'));
  });
  it('uses process_frame for compile wait', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    assert.ok(script.includes('process_frame'));
    assert.ok(!script.includes('create_timer'));
  });
  it('includes errors and warnings arrays', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    assert.ok(script.includes('"errors"'));
    assert.ok(script.includes('"warnings"'));
  });
});

// ─── genShaderLoadFileScript ──────────────────────────────────────────────

describe('genShaderLoadFileScript', () => {
  it('contains ResourceLoader.exists check', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/water.gdshader');
    assert.ok(script.includes('ResourceLoader.exists'));
  });
  it('loads shader file', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/water.gdshader');
    assert.ok(script.includes('mat.shader = load('));
  });
  it('contains file not found error', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/missing.gdshader');
    assert.ok(script.includes('Shader file not found'));
  });
});

// ─── genShaderSaveFileScript ──────────────────────────────────────────────

describe('genShaderSaveFileScript', () => {
  it('contains FileAccess.open', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    assert.ok(script.includes('FileAccess.open'));
  });
  it('contains DirAccess for auto-create', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    assert.ok(script.includes('make_dir_recursive'));
  });
  it('contains store_string', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    assert.ok(script.includes('store_string'));
  });
});

// ─── genShaderApplyTemplateScript ─────────────────────────────────────────

describe('genShaderApplyTemplateScript', () => {
  it('applies dissolve template', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'dissolve');
    assert.ok(script.includes('dissolve'));
    assert.ok(script.includes('template_applied'));
  });
  it('applies outline template', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'outline');
    assert.ok(script.includes('outline'));
  });
  it('applies water template with spatial shader', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'water');
    assert.ok(script.includes('shader_type spatial'));
  });
  it('throws for invalid template name', () => {
    assert.throws(() => genShaderApplyTemplateScript('/root/Player', 0, 'nonexistent'), { message: /Invalid template/ });
  });
  it('contains compile check with errors/warnings', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'glow');
    assert.ok(script.includes('compile_success'));
    assert.ok(script.includes('errors'));
    assert.ok(script.includes('warnings'));
  });
});

// ─── Template coverage ────────────────────────────────────────────────────

describe('all templates are valid', () => {
  const templateNames = ['dissolve', 'outline', 'blur', 'glow', 'water', 'gradient_map'];
  for (const name of templateNames) {
    it(`${name} template generates valid script`, () => {
      const script = genShaderApplyTemplateScript('/root/Node', 0, name);
      assert.ok(script.includes('_mcp_output'));
      assert.ok(script.includes('_mcp_done'));
    });
  }
});

// ─── handleTool integration tests ───────────────────────────────────────────

describe('handleTool routing', () => {
  it('returns null for unknown tool name', async () => {
    const result = await handleTool('unknown_tool', {}, { findGodot: async () => '/fake' });
    assert.strictEqual(result, null);
  });

  it('returns null for unrelated tool', async () => {
    const result = await handleTool('run_project', {}, { findGodot: async () => '/fake' });
    assert.strictEqual(result, null);
  });

  it('material_write rejects missing action', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error_code);
  });

  it('material_write rejects invalid material_type', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'create',
      material_type: 'InvalidType',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error_code, 'INVALID_MATERIAL_TYPE');
  });

  it('shader_edit list_templates works without project_path', async () => {
    const result = await handleTool('shader_edit', {
      action: 'list_templates',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.data.templates.length >= 6);
  });

  it('shader_edit rejects missing code for write', async () => {
    const result = await handleTool('shader_edit', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'write',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error_code, 'SCRIPT_EXEC_FAILED');
  });

  it('material_write rejects non-res:// resource_path', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'save',
      resource_path: 'invalid/path.tres',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
  });

  it('material_read rejects empty node_path', async () => {
    const result = await handleTool('material_read', {
      project_path: '/tmp/fake',
      node_path: '',
    }, { findGodot: async () => '/fake' });
    assert.ok(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
  });
});
