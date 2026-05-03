import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './godot-ops.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const MATERIAL_ERROR_CODES = {
  MATERIAL_NOT_FOUND: 'MATERIAL_NOT_FOUND',
  INVALID_MATERIAL_TYPE: 'INVALID_MATERIAL_TYPE',
  INVALID_PARAM_TYPE: 'INVALID_PARAM_TYPE',
  SHADER_COMPILE_FAILED: 'SHADER_COMPILE_FAILED',
  RESOURCE_SAVE_FAILED: 'RESOURCE_SAVE_FAILED',
  INVALID_TEMPLATE: 'INVALID_TEMPLATE',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ALLOWED_MATERIAL_TYPES = ['ShaderMaterial', 'StandardMaterial3D', 'CanvasItemMaterial'] as const;

// ─── Shader Templates ─────────────────────────────────────────────────────

const SHADER_TEMPLATES: Record<string, { description: string; uniforms: string[]; code: string }> = {
  dissolve: {
    description: '2D/3D 通用溶解效果',
    uniforms: ['edge_color: Color', 'edge_width: float', 'progress: float'],
    code: `shader_type canvas_item;

uniform vec4 edge_color : source_color = vec4(1.0, 0.3, 0.0, 1.0);
uniform float edge_width : hint_range(0.0, 0.5) = 0.1;
uniform float progress : hint_range(0.0, 1.0) = 0.0;

void fragment() {
  vec4 color = texture(TEXTURE, UV);
  float threshold = progress;
  float edge = smoothstep(threshold - edge_width, threshold, UV.x);
  float dissolve = step(threshold, UV.x);
  if (dissolve < 0.01) discard;
  vec3 final_color = mix(edge_color.rgb, color.rgb, edge);
  COLOR = vec4(final_color, color.a * dissolve);
}`,
  },
  outline: {
    description: '2D 描边效果',
    uniforms: ['outline_color: Color', 'outline_width: float'],
    code: `shader_type canvas_item;

uniform vec4 outline_color : source_color = vec4(1.0, 1.0, 1.0, 1.0);
uniform float outline_width : hint_range(1.0, 10.0) = 2.0;

void fragment() {
  vec2 pixel_size = TEXTURE_PIXEL_SIZE * outline_width;
  vec4 color = texture(TEXTURE, UV);
  float alpha = 0.0;
  alpha = max(alpha, texture(TEXTURE, UV + vec2(pixel_size.x, 0.0)).a);
  alpha = max(alpha, texture(TEXTURE, UV - vec2(pixel_size.x, 0.0)).a);
  alpha = max(alpha, texture(TEXTURE, UV + vec2(0.0, pixel_size.y)).a);
  alpha = max(alpha, texture(TEXTURE, UV - vec2(0.0, pixel_size.y)).a);
  COLOR = mix(vec4(outline_color.rgb, alpha), color, color.a);
}`,
  },
  blur: {
    description: '2D 模糊效果',
    uniforms: ['blur_amount: float', 'direction: vec2'],
    code: `shader_type canvas_item;

uniform float blur_amount : hint_range(0.0, 10.0) = 2.0;
uniform vec2 direction = vec2(1.0, 0.0);

void fragment() {
  vec4 color = vec4(0.0);
  vec2 pixel_size = TEXTURE_PIXEL_SIZE * direction * blur_amount;
  color += texture(TEXTURE, UV + pixel_size * -3.0) * 0.015625;
  color += texture(TEXTURE, UV + pixel_size * -2.0) * 0.09375;
  color += texture(TEXTURE, UV + pixel_size * -1.0) * 0.234375;
  color += texture(TEXTURE, UV) * 0.3125;
  color += texture(TEXTURE, UV + pixel_size * 1.0) * 0.234375;
  color += texture(TEXTURE, UV + pixel_size * 2.0) * 0.09375;
  color += texture(TEXTURE, UV + pixel_size * 3.0) * 0.015625;
  COLOR = color;
}`,
  },
  glow: {
    description: '2D 发光效果',
    uniforms: ['glow_color: Color', 'glow_intensity: float'],
    code: `shader_type canvas_item;

uniform vec4 glow_color : source_color = vec4(0.0, 0.5, 1.0, 1.0);
uniform float glow_intensity : hint_range(0.0, 5.0) = 1.5;

void fragment() {
  vec4 color = texture(TEXTURE, UV);
  float glow = 0.0;
  vec2 pixel_size = TEXTURE_PIXEL_SIZE;
  glow += texture(TEXTURE, UV + vec2(pixel_size.x, 0.0)).a;
  glow += texture(TEXTURE, UV - vec2(pixel_size.x, 0.0)).a;
  glow += texture(TEXTURE, UV + vec2(0.0, pixel_size.y)).a;
  glow += texture(TEXTURE, UV - vec2(0.0, pixel_size.y)).a;
  glow *= 0.25 * glow_intensity;
  vec3 final_color = color.rgb + glow_color.rgb * glow * (1.0 - color.a);
  COLOR = vec4(final_color, color.a + glow * 0.5);
}`,
  },
  water: {
    description: '3D 水面效果',
    uniforms: ['wave_speed: float', 'wave_scale: float', 'deep_color: Color', 'shallow_color: Color'],
    code: `shader_type spatial;

uniform float wave_speed = 1.0;
uniform float wave_scale = 0.5;
uniform vec4 deep_color : source_color = vec4(0.0, 0.1, 0.4, 1.0);
uniform vec4 shallow_color : source_color = vec4(0.1, 0.4, 0.7, 0.8);

void vertex() {
  VERTEX.y += sin(VERTEX.x * wave_scale + TIME * wave_speed) * 0.2;
  VERTEX.y += cos(VERTEX.z * wave_scale + TIME * wave_speed * 0.8) * 0.15;
}

void fragment() {
  float depth = clamp(NORMAL.z, 0.0, 1.0);
  vec4 water_color = mix(shallow_color, deep_color, depth);
  ALBEDO = water_color.rgb;
  ALPHA = water_color.a;
  METALLIC = 0.1;
  ROUGHNESS = 0.2;
}`,
  },
  gradient_map: {
    description: '2D/3D 通用色调映射',
    uniforms: ['gradient_texture: Texture', 'intensity: float'],
    code: `shader_type canvas_item;

uniform sampler2D gradient_texture : hint_default_white;
uniform float intensity : hint_range(0.0, 1.0) = 1.0;

void fragment() {
  vec4 color = texture(TEXTURE, UV);
  float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec4 mapped = texture(gradient_texture, vec2(luminance, 0.5));
  COLOR = vec4(mix(color.rgb, mapped.rgb, intensity), color.a);
}`,
  },
};

// ─── Helper Utilities ─────────────────────────────────────────────────────

export function validateParamType(v: unknown): 'number' | 'string' | 'boolean' | 'null' | 'array' {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) {
    const len = v.length;
    if (len !== 2 && len !== 3 && len !== 4) {
      throw new Error(`Invalid param type: array length ${len} not supported (expected 2=Vector2, 3=Vector3, 4=Color)`);
    }
    for (let i = 0; i < len; i++) {
      if (typeof v[i] !== 'number') {
        throw new Error(`Invalid param type: array element [${i}] must be a number, got ${typeof v[i]}`);
      }
    }
    return 'array';
  }
  throw new Error(`Invalid param type: ${typeof v} not supported`);
}

// ─── Value conversion helper ───────────────────────────────────────────────

function valueToGdscript(value: unknown, forShader = false): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (forShader && value.startsWith('res://')) return `load("${gdEscape(value)}")`;
    return `"${gdEscape(value)}"`;
  }
  if (Array.isArray(value)) {
    const len = value.length;
    if (len === 2) return `Vector2(${Number(value[0])}, ${Number(value[1])})`;
    if (len === 3) return `Vector3(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])})`;
    if (len === 4) return `Color(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])}, ${Number(value[3])})`;
    throw new Error(`Invalid param type: array length ${len} not supported`);
  }
  throw new Error(`Invalid param type: ${typeof value} not supported type`);
}

// ─── GDScript Generators: material_read ────────────────────────────────────

export function genMaterialReadScript(nodePath: string, materialIndex: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tvar info = {}
\tinfo["material_type"] = mat.get_class()
\tinfo["resource_path"] = mat.resource_path if mat.resource_path else ""
\tif mat is ShaderMaterial and mat.shader != null:
\t\tvar uniforms = []
\t\tfor u in mat.shader.get_shader_uniform_list():
\t\t\tvar entry = {}
\t\t\tentry["name"] = u["name"]
\t\t\tentry["type"] = u["type"]
\t\t\tentry["hint"] = u["hint"]
\t\t\tvar val = mat.get_shader_parameter(u["name"])
\t\t\tif val == null:
\t\t\t\tentry["value"] = null
\t\t\telif val is Color:
\t\t\t\tentry["value"] = [val.r, val.g, val.b, val.a]
\t\t\telif val is Vector2:
\t\t\t\tentry["value"] = [val.x, val.y]
\t\t\telif val is Vector3:
\t\t\t\tentry["value"] = [val.x, val.y, val.z]
\t\t\telse:
\t\t\t\tentry["value"] = val
\t\t\tuniforms.append(entry)
\t\tinfo["shader_uniforms"] = uniforms
\t\tinfo["shader_path"] = mat.shader.resource_path if mat.shader.resource_path else ""
\telse:
\t\tvar props = {}
\t\tfor p in mat.get_property_list():
\t\t\tif p["usage"] & PROPERTY_USAGE_STORAGE:
\t\t\t\tvar pname = p["name"]
\t\t\t\tif not pname.begins_with("resource_") and not pname.begins_with("shader/"):
\t\t\t\t\tvar val = mat.get(pname)
\t\t\t\t\tif val is Color:
\t\t\t\t\t\tprops[pname] = [val.r, val.g, val.b, val.a]
\t\t\t\t\telif val is Vector2:
\t\t\t\t\t\tprops[pname] = [val.x, val.y]
\t\t\t\t\telif val is Vector3:
\t\t\t\t\t\tprops[pname] = [val.x, val.y, val.z]
\t\t\t\t\telse:
\t\t\t\t\t\tprops[pname] = val
\t\tinfo["properties"] = props
\t_mcp_output("material_info", info)
\t_mcp_done()
`;
}

// ─── GDScript Generators: material_write ───────────────────────────────────

export function genMaterialSetParamsScript(
  nodePath: string, materialIndex: number, params: Record<string, unknown>
): string {
  const paramLines = Object.entries(params).map(([key, value]) => {
    const gdShaderValue = valueToGdscript(value, true);
    const gdValue = valueToGdscript(value, false);
    return `\tif is_shader:\n\t\tmat.set_shader_parameter("${gdEscape(key)}", ${gdShaderValue})\n\telse:\n\t\tmat.set("${gdEscape(key)}", ${gdValue})`;
  }).join('\n');
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tvar is_shader = mat is ShaderMaterial
${paramLines}
\t_mcp_output("params_set", {"count": ${Object.keys(params).length}})
\t_mcp_done()
`;
}

export function genMaterialCreateScript(
  nodePath: string, materialType: string, shaderPath?: string
): string {
  const shaderLine = materialType === 'ShaderMaterial' && shaderPath
    ? `\n\tif ResourceLoader.exists("${gdEscape(shaderPath)}"):\n\t\tmat.shader = load("${gdEscape(shaderPath)}")\n\telse:\n\t\t_mcp_output("error", "Shader not found: ${gdEscape(shaderPath)}")\n\t\t_mcp_done()\n\t\treturn`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = ${gdEscape(materialType)}.new()${shaderLine}
\tnode.material = mat
\t_mcp_output("created", {"material_type": "${gdEscape(materialType)}", "node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genMaterialSaveScript(nodePath: string, materialIndex: number, resourcePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tvar dir = "${gdEscape(resourcePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar err = ResourceSaver.save(mat, "${gdEscape(resourcePath)}")
\tif err != OK:
\t\t_mcp_output("error", "Failed to save resource: " + str(err))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("saved", {"resource_path": "${gdEscape(resourcePath)}"})
\t_mcp_done()
`;
}

export function genMaterialLoadScript(nodePath: string, resourcePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not ResourceLoader.exists("${gdEscape(resourcePath)}"):
\t\t_mcp_output("error", "Material not found: ${gdEscape(resourcePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = load("${gdEscape(resourcePath)}")
\tif mat == null:
\t\t_mcp_output("error", "Material not found: ${gdEscape(resourcePath)}")
\t\t_mcp_done()
\t\treturn
\tnode.material = mat
\t_mcp_output("loaded", {"resource_path": "${gdEscape(resourcePath)}", "material_type": mat.get_class()})
\t_mcp_done()
`;
}

// ─── GDScript Generators: shader_edit ──────────────────────────────────────

export function genShaderReadScript(nodePath: string, materialIndex: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn
\tif mat.shader == null:
\t\t_mcp_output("error", "No shader assigned")
\t\t_mcp_done()
\t\treturn
\t_mcp_output("shader_code", mat.shader.code)
\t_mcp_done()
`;
}

export function genShaderWriteScript(
  nodePath: string, materialIndex: number, code: string
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn
\tmat.shader = mat.shader.duplicate()
\tmat.shader.code = "${gdEscape(code)}"
\tawait get_tree().process_frame
\tvar compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
\tvar errors = []
\tvar warnings = []
\tif not compile_ok:
\t\terrors.append({"line": 0, "message": "Shader compilation failed"})
\t_mcp_output("compile_result", {"compile_success": compile_ok, "errors": errors, "warnings": warnings})
\t_mcp_done()
`;
}

export function genShaderLoadFileScript(
  nodePath: string, materialIndex: number, filePath: string
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn
\tif not ResourceLoader.exists("${gdEscape(filePath)}"):
\t\t_mcp_output("error", "Shader file not found: ${gdEscape(filePath)}")
\t\t_mcp_done()
\t\treturn
\tmat.shader = load("${gdEscape(filePath)}")
\t_mcp_output("shader_loaded", {"shader_path": "${gdEscape(filePath)}"})
\t_mcp_done()
`;
}

export function genShaderSaveFileScript(filePath: string, code: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar dir = "${gdEscape(filePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar f = FileAccess.open("${gdEscape(filePath)}", FileAccess.WRITE)
\tif f == null:
\t\t_mcp_output("error", "Failed to open file for writing: ${gdEscape(filePath)}")
\t\t_mcp_done()
\t\treturn
\tf.store_string("${gdEscape(code)}")
\tf.close()
\t_mcp_output("shader_saved", {"file_path": "${gdEscape(filePath)}"})
\t_mcp_done()
`;
}

export function genShaderApplyTemplateScript(
  nodePath: string, materialIndex: number, templateName: string
): string {
  const template = SHADER_TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Invalid template: ${templateName}`);
  }
  const code = template.code;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.material
\tif mat == null:
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null and node.mesh != null:
\t\tmat = node.mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn
\tmat.shader = mat.shader.duplicate()
\tmat.shader.code = "${gdEscape(code)}"
\tawait get_tree().process_frame
\tvar compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
\tvar errors = []
\tvar warnings = []
\tif not compile_ok:
\t\terrors.append({"line": 0, "message": "Shader compilation failed"})
\t_mcp_output("template_applied", {"template": "${gdEscape(templateName)}", "compile_success": compile_ok, "errors": errors, "warnings": warnings})
\t_mcp_done()
`;
}

// ─── Error mapper ──────────────────────────────────────────────────────────

function materialErrorMapper(msg: string): string {
  if (msg.includes('Node not found')) return 'MATERIAL_NOT_FOUND';
  if (msg.includes('No material')) return 'MATERIAL_NOT_FOUND';
  if (msg.includes('Not a ShaderMaterial')) return 'INVALID_MATERIAL_TYPE';
  if (msg.includes('Shader not found') || msg.includes('Shader file not found')) return 'MATERIAL_NOT_FOUND';
  if (msg.includes('Material not found')) return 'MATERIAL_NOT_FOUND';
  if (msg.includes('No shader assigned')) return 'MATERIAL_NOT_FOUND';
  if (msg.includes('shader error') || msg.includes('Shader compile')) return 'SHADER_COMPILE_FAILED';
  if (msg.includes('Failed to save')) return 'RESOURCE_SAVE_FAILED';
  if (msg.includes('Failed to open file')) return 'RESOURCE_SAVE_FAILED';
  if (msg.includes('Invalid param type') || msg.includes('not supported type')) return 'INVALID_PARAM_TYPE';
  return 'SCRIPT_EXEC_FAILED';
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'material_read',
      description: `读取节点材质属性 + shader uniform 列表。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '场景树节点路径' },
          material_index: { type: 'number', description: '材质索引（可选，默认 0，仅对 mesh surface 材质生效）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'material_write',
      description: `写参数 / 创建材质 / 附加 / 保存 .tres。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '场景树节点路径' },
          material_index: { type: 'number', description: '材质索引（可选，默认 0）' },
          action: {
            type: 'string',
            enum: ['set_params', 'create', 'save', 'load'],
            description: '操作类型：set_params 设置参数 | create 创建材质 | save 保存为 .tres | load 加载 .tres',
          },
          params: {
            type: 'object',
            description: 'set_params 时的参数键值对（number→float, array[2]→Vector2, array[3]→Vector3, array[4]→Color, string→资源路径）',
          },
          material_type: {
            type: 'string',
            description: 'create 时的材质类型（ShaderMaterial / StandardMaterial3D / CanvasItemMaterial）',
          },
          shader_path: { type: 'string', description: 'create ShaderMaterial 时的 shader 资源路径（可选）' },
          resource_path: { type: 'string', description: 'save/load 时的资源路径（res://materials/xxx.tres）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'action'],
      },
    },
    {
      name: 'shader_edit',
      description: `读写 shader code / 加载 .gdshader / 模板 / 编译诊断。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '场景树节点路径（list_templates/save_file 时可选）' },
          action: {
            type: 'string',
            enum: ['read', 'write', 'load_file', 'save_file', 'list_templates', 'apply_template'],
            description: '操作类型：read 读取 shader | write 写入 shader | load_file 加载 .gdshader | save_file 保存 .gdshader | list_templates 列出模板 | apply_template 应用模板',
          },
          code: { type: 'string', description: 'write 时的完整 shader 代码' },
          file_path: { type: 'string', description: 'load_file/save_file 时的文件路径（res://shaders/xxx.gdshader）' },
          template_name: { type: 'string', description: 'apply_template 时的模板名称' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = ['material_read', 'material_write', 'shader_edit'] as const;

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    // list_templates 不需要 project_path，提前返回
    if (name === 'shader_edit' && args.action === 'list_templates') {
      const templates = Object.entries(SHADER_TEMPLATES).map(([n, t]) => ({
        name: n,
        description: t.description,
        uniforms: t.uniforms,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { templates }, warnings: [] }) }] };
    }

    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    function requireMaterialIndex(raw: unknown): number {
      if (raw === undefined || raw === null) return 0;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new Error('material_index must be a non-negative integer');
      }
      return raw;
    }

    function requireNodePath(raw: unknown): string {
      if (!raw || typeof raw !== 'string') {
        throw new Error('NodePath cannot be empty');
      }
      return normalizeNodePath(raw);
    }

    function requireResPath(raw: unknown, field: string): string {
      if (!raw || typeof raw !== 'string' || !raw.startsWith('res://')) {
        throw new Error(`${field} must be a string starting with res://`);
      }
      return raw;
    }

    switch (name) {
      case 'material_read': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
        script = genMaterialReadScript(nodePath, materialIndex);
        break;
      }
      case 'material_write': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
        const action = args.action as string;
        if (!action) return opsErrorResult('SCRIPT_EXEC_FAILED', 'action is required');

        switch (action) {
          case 'set_params': {
            const params = args.params as Record<string, unknown>;
            if (!params || typeof params !== 'object') {
              return opsErrorResult('INVALID_PARAM_TYPE', 'params must be an object');
            }
            for (const [key, val] of Object.entries(params)) {
              try {
                validateParamType(val);
              } catch (e) {
                return opsErrorResult('INVALID_PARAM_TYPE', `param "${key}": ${(e as Error).message}`);
              }
            }
            script = genMaterialSetParamsScript(nodePath, materialIndex, params);
            break;
          }
          case 'create': {
            const materialType = args.material_type as string;
            if (!ALLOWED_MATERIAL_TYPES.includes(materialType as typeof ALLOWED_MATERIAL_TYPES[number])) {
              return opsErrorResult('INVALID_MATERIAL_TYPE', `material_type must be one of: ${ALLOWED_MATERIAL_TYPES.join(', ')}`);
            }
            const shaderPath = args.shader_path as string | undefined;
            script = genMaterialCreateScript(nodePath, materialType, shaderPath);
            break;
          }
          case 'save': {
            const resourcePath = requireResPath(args.resource_path, 'resource_path');
            script = genMaterialSaveScript(nodePath, materialIndex, resourcePath);
            break;
          }
          case 'load': {
            const resourcePath = requireResPath(args.resource_path, 'resource_path');
            script = genMaterialLoadScript(nodePath, resourcePath);
            break;
          }
          default:
            return opsErrorResult('SCRIPT_EXEC_FAILED', `Unknown action: ${action}`);
        }
        break;
      }
      case 'shader_edit': {
        const action = args.action as string;
        if (!action) return opsErrorResult('SCRIPT_EXEC_FAILED', 'action is required');
        const materialIndex = requireMaterialIndex(args.material_index);

        switch (action) {
          case 'read': {
            const nodePath = requireNodePath(args.node_path);
            script = genShaderReadScript(nodePath, materialIndex);
            break;
          }
          case 'write': {
            const nodePath = requireNodePath(args.node_path);
            const code = args.code as string;
            if (code === undefined || code === null) return opsErrorResult('SCRIPT_EXEC_FAILED', 'code is required for write action');
            script = genShaderWriteScript(nodePath, materialIndex, code);
            break;
          }
          case 'load_file': {
            const nodePath = requireNodePath(args.node_path);
            const filePath = requireResPath(args.file_path, 'file_path');
            script = genShaderLoadFileScript(nodePath, materialIndex, filePath);
            break;
          }
          case 'save_file': {
            const filePath = requireResPath(args.file_path, 'file_path');
            const code = args.code as string;
            if (code === undefined || code === null) return opsErrorResult('SCRIPT_EXEC_FAILED', 'code is required for save_file action');
            script = genShaderSaveFileScript(filePath, code);
            break;
          }
          case 'list_templates': {
            return null as never;
          }
          case 'apply_template': {
            const nodePath = requireNodePath(args.node_path);
            const templateName = args.template_name as string;
            if (!templateName) return opsErrorResult('INVALID_TEMPLATE', 'template_name is required for apply_template action');
            if (!SHADER_TEMPLATES[templateName]) {
              return opsErrorResult('INVALID_TEMPLATE', `Unknown template: ${templateName}. Available: ${Object.keys(SHADER_TEMPLATES).join(', ')}`);
            }
            script = genShaderApplyTemplateScript(nodePath, materialIndex, templateName);
            break;
          }
          default:
            return opsErrorResult('SCRIPT_EXEC_FAILED', `Unknown action: ${action}`);
        }
        break;
      }
      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    return parseGdscriptResult(result, [], materialErrorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Invalid param type')) return opsErrorResult('INVALID_PARAM_TYPE', msg);
    if (msg.includes('Invalid template')) return opsErrorResult('INVALID_TEMPLATE', msg);
    if (msg.includes('NodePath')) return opsErrorResult('MATERIAL_NOT_FOUND', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}
