import { expect } from 'vitest';
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
} from '../src/tools/material-ops.js';

// ─── Error Codes ───────────────────────────────────────────────────────────

describe('MATERIAL_ERROR_CODES', () => {
  it('has MATERIAL_NOT_FOUND', () => { expect('MATERIAL_NOT_FOUND' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has INVALID_MATERIAL_TYPE', () => { expect('INVALID_MATERIAL_TYPE' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has INVALID_PARAM_TYPE', () => { expect('INVALID_PARAM_TYPE' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has SHADER_COMPILE_FAILED', () => { expect('SHADER_COMPILE_FAILED' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has RESOURCE_SAVE_FAILED', () => { expect('RESOURCE_SAVE_FAILED' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has INVALID_TEMPLATE', () => { expect('INVALID_TEMPLATE' in MATERIAL_ERROR_CODES).toBeTruthy(); });
  it('has SCRIPT_EXEC_FAILED', () => { expect('SCRIPT_EXEC_FAILED' in MATERIAL_ERROR_CODES).toBeTruthy(); });
});

// ─── validateParamType ────────────────────────────────────────────────────

describe('validateParamType', () => {
  it('returns "number" for numbers', () => {
    expect(validateParamType(3.14)).toBe('number');
  });
  it('returns "number" for integers', () => {
    expect(validateParamType(0)).toBe('number');
  });
  it('returns "string" for strings', () => {
    expect(validateParamType('hello')).toBe('string');
  });
  it('returns "boolean" for booleans', () => {
    expect(validateParamType(true)).toBe('boolean');
  });
  it('returns "null" for null', () => {
    expect(validateParamType(null)).toBe('null');
  });
  it('returns "null" for undefined', () => {
    expect(validateParamType(undefined)).toBe('null');
  });
  it('returns "array" for array length 2 (Vector2)', () => {
    expect(validateParamType([1, 2])).toBe('array');
  });
  it('returns "array" for array length 3 (Vector3)', () => {
    expect(validateParamType([1, 2, 3])).toBe('array');
  });
  it('returns "array" for array length 4 (Color)', () => {
    expect(validateParamType([1, 0, 0, 1])).toBe('array');
  });
  it('rejects array length 1', () => {
    expect(() => validateParamType([1])).toThrow(/array length 1/);
  });
  it('rejects array length 5', () => {
    expect(() => validateParamType([1, 2, 3, 4, 5])).toThrow(/array length 5/);
  });
  it('rejects objects', () => {
    expect(() => validateParamType({})).toThrow(/not supported/);
  });
  it('rejects arrays with non-number elements', () => {
    expect(() => validateParamType(['a', 'b'])).toThrow(/must be a number/);
  });
  it('rejects arrays with mixed types', () => {
    expect(() => validateParamType([1, 'x', 3])).toThrow(/must be a number/);
  });
});

// ─── genMaterialReadScript ────────────────────────────────────────────────

describe('genMaterialReadScript', () => {
  it('contains material check', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    expect(script.includes('material')).toBeTruthy();
  });
  it('contains get_surface_override_material', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    expect(script.includes('get_surface_override_material')).toBeTruthy();
  });
  it('contains surface_get_material', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    expect(script.includes('surface_get_material')).toBeTruthy();
  });
  it('contains ShaderMaterial branch', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    expect(script.includes('ShaderMaterial')).toBeTruthy();
    expect(script.includes('get_shader_uniform_list')).toBeTruthy();
  });
  it('contains get_property_list for built-in materials', () => {
    const script = genMaterialReadScript('/root/Player', 0);
    expect(script.includes('get_property_list')).toBeTruthy();
    expect(script.includes('PROPERTY_USAGE_STORAGE')).toBeTruthy();
  });
  it('uses material_index parameter', () => {
    const script = genMaterialReadScript('/root/Player', 2);
    expect(script.includes('get_surface_override_material(2)')).toBeTruthy();
  });
});

// ─── genMaterialCreateScript ──────────────────────────────────────────────

describe('genMaterialCreateScript', () => {
  it('creates ShaderMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'ShaderMaterial');
    expect(script.includes('ShaderMaterial.new()')).toBeTruthy();
    expect(script.includes('material')).toBeTruthy();
  });
  it('creates StandardMaterial3D', () => {
    const script = genMaterialCreateScript('/root/Player', 'StandardMaterial3D');
    expect(script.includes('StandardMaterial3D.new()')).toBeTruthy();
  });
  it('creates CanvasItemMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'CanvasItemMaterial');
    expect(script.includes('CanvasItemMaterial.new()')).toBeTruthy();
  });
  it('includes shader loading when shader_path provided', () => {
    const script = genMaterialCreateScript('/root/Player', 'ShaderMaterial', 'res://shaders/player.gdshader');
    expect(script.includes('ResourceLoader.exists')).toBeTruthy();
    expect(script.includes('res://shaders/player.gdshader')).toBeTruthy();
  });
  it('no shader loading for non-ShaderMaterial', () => {
    const script = genMaterialCreateScript('/root/Player', 'StandardMaterial3D', 'res://shaders/player.gdshader');
    expect(script.includes('ResourceLoader.exists')).toBeFalsy();
  });
});

// ─── genMaterialSetParamsScript ───────────────────────────────────────────

describe('genMaterialSetParamsScript', () => {
  it('generates is_shader branch', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { intensity: 2.5 });
    expect(script.includes('is_shader')).toBeTruthy();
    expect(script.includes('set_shader_parameter')).toBeTruthy();
    expect(script.includes('mat.set(')).toBeTruthy();
  });
  it('converts number to float', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { intensity: 2.5 });
    expect(script.includes('2.5')).toBeTruthy();
  });
  it('converts array[4] to Color', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { albedo: [1, 0, 0, 1] });
    expect(script.includes('Color(1, 0, 0, 1)')).toBeTruthy();
  });
  it('converts array[2] to Vector2', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { offset: [3, 4] });
    expect(script.includes('Vector2(3, 4)')).toBeTruthy();
  });
  it('converts array[3] to Vector3', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { pos: [1, 2, 3] });
    expect(script.includes('Vector3(1, 2, 3)')).toBeTruthy();
  });
  it('converts boolean', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { visible: true });
    expect(script.includes('true')).toBeTruthy();
  });
  it('converts null', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { val: null });
    expect(script.includes('null')).toBeTruthy();
  });
  it('converts string (resource path) with load() for shader', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { tex: 'res://icon.png' });
    expect(script.includes('load("res://icon.png")')).toBeTruthy();
    expect(script.includes('"res://icon.png"')).toBeTruthy();
  });
  it('converts plain string without load() for non-resource', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { name: 'hello' });
    expect(script.includes('"hello"')).toBeTruthy();
    expect(script.includes('load("hello")')).toBeFalsy();
  });
  it('handles multiple params', () => {
    const script = genMaterialSetParamsScript('/root/Player', 0, { a: 1, b: [1, 0, 0, 1] });
    expect(script.includes('set_shader_parameter("a"')).toBeTruthy();
    expect(script.includes('set_shader_parameter("b"')).toBeTruthy();
  });
});

// ─── genMaterialSaveScript ────────────────────────────────────────────────

describe('genMaterialSaveScript', () => {
  it('contains ResourceSaver.save', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    expect(script.includes('ResourceSaver.save')).toBeTruthy();
  });
  it('contains DirAccess for auto-create directory', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    expect(script.includes('make_dir_recursive')).toBeTruthy();
  });
  it('contains error check for save failure', () => {
    const script = genMaterialSaveScript('/root/Player', 0, 'res://materials/player.tres');
    expect(script.includes('Failed to save')).toBeTruthy();
  });
});

// ─── genMaterialLoadScript ────────────────────────────────────────────────

describe('genMaterialLoadScript', () => {
  it('contains ResourceLoader.exists check', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    expect(script.includes('ResourceLoader.exists')).toBeTruthy();
  });
  it('contains load call', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    expect(script.includes('load(')).toBeTruthy();
  });
  it('sets material', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/player.tres');
    expect(script.includes('material')).toBeTruthy();
  });
  it('contains not found error for missing resource', () => {
    const script = genMaterialLoadScript('/root/Player', 'res://materials/missing.tres');
    expect(script.includes('Material not found')).toBeTruthy();
  });
});

// ─── genShaderReadScript ──────────────────────────────────────────────────

describe('genShaderReadScript', () => {
  it('contains shader code output', () => {
    const script = genShaderReadScript('/root/Player', 0);
    expect(script.includes('shader_code')).toBeTruthy();
    expect(script.includes('mat.shader.code')).toBeTruthy();
  });
  it('checks for ShaderMaterial type', () => {
    const script = genShaderReadScript('/root/Player', 0);
    expect(script.includes('Not a ShaderMaterial')).toBeTruthy();
  });
  it('checks for null shader', () => {
    const script = genShaderReadScript('/root/Player', 0);
    expect(script.includes('No shader assigned')).toBeTruthy();
  });
});

// ─── genShaderWriteScript ─────────────────────────────────────────────────

describe('genShaderWriteScript', () => {
  it('contains shader duplicate', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    expect(script.includes('mat.shader.duplicate()')).toBeTruthy();
  });
  it('contains compile result check', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    expect(script.includes('compile_result')).toBeTruthy();
    expect(script.includes('compile_success')).toBeTruthy();
  });
  it('embeds shader code', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    expect(script.includes('shader_type canvas_item')).toBeTruthy();
  });
  it('uses process_frame for compile wait', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    expect(script.includes('process_frame')).toBeTruthy();
    expect(script.includes('create_timer')).toBeFalsy();
  });
  it('includes errors and warnings arrays', () => {
    const script = genShaderWriteScript('/root/Player', 0, 'shader_type canvas_item;');
    expect(script.includes('"errors"')).toBeTruthy();
    expect(script.includes('"warnings"')).toBeTruthy();
  });
});

// ─── genShaderLoadFileScript ──────────────────────────────────────────────

describe('genShaderLoadFileScript', () => {
  it('contains ResourceLoader.exists check', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/water.gdshader');
    expect(script.includes('ResourceLoader.exists')).toBeTruthy();
  });
  it('loads shader file', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/water.gdshader');
    expect(script.includes('mat.shader = load(')).toBeTruthy();
  });
  it('contains file not found error', () => {
    const script = genShaderLoadFileScript('/root/Player', 0, 'res://shaders/missing.gdshader');
    expect(script.includes('Shader file not found')).toBeTruthy();
  });
});

// ─── genShaderSaveFileScript ──────────────────────────────────────────────

describe('genShaderSaveFileScript', () => {
  it('contains FileAccess.open', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    expect(script.includes('FileAccess.open')).toBeTruthy();
  });
  it('contains DirAccess for auto-create', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    expect(script.includes('make_dir_recursive')).toBeTruthy();
  });
  it('contains store_string', () => {
    const script = genShaderSaveFileScript('res://shaders/new.gdshader', 'shader_type canvas_item;');
    expect(script.includes('store_string')).toBeTruthy();
  });
});

// ─── genShaderApplyTemplateScript ─────────────────────────────────────────

describe('genShaderApplyTemplateScript', () => {
  it('applies dissolve template', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'dissolve');
    expect(script.includes('dissolve')).toBeTruthy();
    expect(script.includes('template_applied')).toBeTruthy();
  });
  it('applies outline template', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'outline');
    expect(script.includes('outline')).toBeTruthy();
  });
  it('applies water template with spatial shader', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'water');
    expect(script.includes('shader_type spatial')).toBeTruthy();
  });
  it('throws for invalid template name', () => {
    expect(() => genShaderApplyTemplateScript('/root/Player', 0, 'nonexistent')).toThrow(/Invalid template/);
  });
  it('contains compile check with errors/warnings', () => {
    const script = genShaderApplyTemplateScript('/root/Player', 0, 'glow');
    expect(script.includes('compile_success')).toBeTruthy();
    expect(script.includes('errors')).toBeTruthy();
    expect(script.includes('warnings')).toBeTruthy();
  });
});

// ─── Template coverage ────────────────────────────────────────────────────

describe('all templates are valid', () => {
  const templateNames = ['dissolve', 'outline', 'blur', 'glow', 'water', 'gradient_map'];
  for (const name of templateNames) {
    it(`${name} template generates valid script`, () => {
      const script = genShaderApplyTemplateScript('/root/Node', 0, name);
      expect(script.includes('_mcp_output')).toBeTruthy();
      expect(script.includes('_mcp_done')).toBeTruthy();
    });
  }
});

// ─── handleTool integration tests ───────────────────────────────────────────

describe('handleTool routing', () => {
  it('returns null for unknown tool name', async () => {
    const result = await handleTool('unknown_tool', {}, { findGodot: async () => '/fake' });
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool', async () => {
    const result = await handleTool('run_project', {}, { findGodot: async () => '/fake' });
    expect(result).toBe(null);
  });

  it('material_write rejects missing action', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBeTruthy();
  });

  it('material_write rejects invalid material_type', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'create',
      material_type: 'InvalidType',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('INVALID_MATERIAL_TYPE');
  });

  it('shader_edit list_templates works without project_path', async () => {
    const result = await handleTool('shader_edit', {
      action: 'list_templates',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.templates.length >= 6).toBeTruthy();
  });

  it('shader_edit rejects missing code for write', async () => {
    const result = await handleTool('shader_edit', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'write',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('SCRIPT_EXEC_FAILED');
  });

  it('material_write rejects non-res:// resource_path', async () => {
    const result = await handleTool('material_write', {
      project_path: '/tmp/fake',
      node_path: '/root/Node',
      action: 'save',
      resource_path: 'invalid/path.tres',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('material_read rejects empty node_path', async () => {
    const result = await handleTool('material_read', {
      project_path: '/tmp/fake',
      node_path: '',
    }, { findGodot: async () => '/fake' });
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});
