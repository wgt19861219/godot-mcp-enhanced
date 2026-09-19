import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { executeGdscriptTrusted } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape, escapeForGdLiteral, sanitizeResPath, validateIdentifier } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, appendRuntimePersistWarning } from './shared.js';
import { BLOCKED_PROPS } from './scene/helpers.js';  // IMP-1 (2026-06-26 review): 复用 scene BLOCKED_PROPS 防 set_params 改危险属性(未来抽 shared)

// ─── Constants ─────────────────────────────────────────────────────────────

const ACTIONS = [
  'read', 'set_params', 'create', 'save', 'load',
  'shader_read', 'shader_write', 'shader_load_file', 'shader_save_file',
  'shader_list_templates', 'shader_apply_template',
] as const;

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

/**
 * Parse a JS value into a GDScript literal.
 * - number  → "3.14"
 * - boolean → "true" / "false"
 * - null/undefined → "null"
 * - string  → '"escaped"' (or 'load("res://...")' when forShader=true and value starts with res://)
 * - array[2] → "Vector2(x, y)"
 * - array[3] → "Vector3(x, y, z)"
 * - array[4] → "Color(r, g, b, a)"
 */
export function parseMaterialParam(value: unknown, forShader = false): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    // T2b: res:// shader 参数值进 load() 纯字面量,含 % 的资源路径须原样(与 F-7 同根因)。
    if (forShader && value.startsWith('res://')) return `load("${escapeForGdLiteral(value)}")`;
    // F-7: 材质字符串值嵌入字面量后经 mat.set() 传递,不参与 % 格式化。
    // 用 escapeForGdLiteral(不双写 %),原 gdEscape 会把 % → %% 致含 % 的值损坏。
    return `"${escapeForGdLiteral(value)}"`;
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
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.get("material")
\tif mat == null and node.has_method("get_surface_override_material"):
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null:
\t\tvar _mesh = node.get("mesh")
\t\tif _mesh != null and _mesh.has_method("surface_get_material"):
\t\t\tmat = _mesh.surface_get_material(${materialIndex})
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
    const gdShaderValue = parseMaterialParam(value, true);
    const gdValue = parseMaterialParam(value, false);
    return `\tif is_shader:\n\t\tmat.set_shader_parameter("${gdEscape(key)}", ${gdShaderValue})\n\telse:\n\t\tmat.set("${gdEscape(key)}", ${gdValue})`;
  }).join('\n');
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.get("material")
\tif mat == null and node.has_method("get_surface_override_material"):
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null:
\t\tvar _mesh = node.get("mesh")
\t\tif _mesh != null and _mesh.has_method("surface_get_material"):
\t\t\tmat = _mesh.surface_get_material(${materialIndex})
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
    ? `\n\tif ResourceLoader.exists("${escapeForGdLiteral(shaderPath)}"):\n\t\tmat.shader = load("${escapeForGdLiteral(shaderPath)}")\n\telse:\n\t\t_mcp_output("error", "Shader not found: ${escapeForGdLiteral(shaderPath)}")\n\t\t_mcp_done()\n\t\treturn`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = ${materialType}.new()${shaderLine}
\tnode.material = mat
\t_mcp_output("created", {"material_type": "${gdEscape(materialType)}", "node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

export function genMaterialSaveScript(nodePath: string, materialIndex: number, resourcePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.get("material")
\tif mat == null and node.has_method("get_surface_override_material"):
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null:
\t\tvar _mesh = node.get("mesh")
\t\tif _mesh != null and _mesh.has_method("surface_get_material"):
\t\t\tmat = _mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tvar dir = "${escapeForGdLiteral(resourcePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar _full := "${escapeForGdLiteral(resourcePath)}"
\tvar _ext := _full.get_extension()
\tvar _tmp := _full + ".tmp." + _ext
\tif FileAccess.file_exists(_tmp):
\t\tDirAccess.remove_absolute(_tmp)
\tvar err := ResourceSaver.save(mat, _tmp)
\tif err != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to save resource: " + str(err))
\t\t_mcp_done()
\t\treturn
\tvar _ren := DirAccess.rename_absolute(_tmp, _full)
\tif _ren != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to rename tmp: " + str(_ren))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("saved", {"resource_path": "${escapeForGdLiteral(resourcePath)}"})
\t_mcp_done()
`;
}

export function genMaterialLoadScript(nodePath: string, resourcePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not ResourceLoader.exists("${escapeForGdLiteral(resourcePath)}"):
\t\t_mcp_output("error", "Material not found: ${escapeForGdLiteral(resourcePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = load("${escapeForGdLiteral(resourcePath)}")
\tif mat == null:
\t\t_mcp_output("error", "Material not found: ${escapeForGdLiteral(resourcePath)}")
\t\t_mcp_done()
\t\treturn
\tnode.material = mat
\t_mcp_output("loaded", {"resource_path": "${escapeForGdLiteral(resourcePath)}", "material_type": mat.get_class()})
\t_mcp_done()
`;
}

// ─── GDScript Generators: shader_edit ──────────────────────────────────────

// 共享前奏:节点定位 → 材质三层 fallback(material → surface_override → mesh.surface)→
// ShaderMaterial 校验。四个 shader_edit 系生成函数复用(2026-09-18 重复分析收敛)。
function shaderMatPreamble(nodePath: string, materialIndex: number): string {
  return `func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.get("material")
\tif mat == null and node.has_method("get_surface_override_material"):
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null:
\t\tvar _mesh = node.get("mesh")
\t\tif _mesh != null and _mesh.has_method("surface_get_material"):
\t\t\tmat = _mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn`;
}

export function genShaderReadScript(nodePath: string, materialIndex: number): string {
  return `${SCENE_TREE_HEADER}
${shaderMatPreamble(nodePath, materialIndex)}
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
  // F-7: shader code 经 JSON.stringify → 字面量 → JSON.parse_string 往返,不参与 % 格式化。
  // 用 escapeForGdLiteral(不双写 %),原 gdEscape 会把 shader 中的 % 损坏为 %%。
  const jsonCode = escapeForGdLiteral(JSON.stringify(code));
  return `${SCENE_TREE_HEADER}
${shaderMatPreamble(nodePath, materialIndex)}
\tmat.shader = mat.shader.duplicate()
\tvar _code_json: String = "${jsonCode}"
\tvar _parsed: Variant = JSON.parse_string(_code_json)
\tif _parsed == null:
\t\t_mcp_output("error", "Failed to parse shader code JSON")
\t\t_mcp_done()
\t\treturn
\tmat.shader.code = _parsed
\tawait process_frame
\t# C-BUG-1: get_rid().is_valid() 仅确认 shader 资源已分配,与代码能否编译无关。
\t# Godot 4.x headless 无可靠 shader 编译验证 API(RenderingServer 不实际编译)。
\t# compile_success 不可作为"编译通过"依据,必须经截图/Godot 错误输出人工确认。
\tvar compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
\tvar errors = []
\tvar warnings = []
\tif not compile_ok:
\t\terrors.append({"line": 0, "message": "Shader resource allocation failed"})
\t_mcp_output("compile_result", {"compile_success": compile_ok, "errors": errors, "warnings": warnings, "verification_note": "compile_success only confirms shader resource allocation, NOT that the code compiles. Godot 4.x headless cannot verify shader compilation — always verify via screenshot or Godot error output."})
\t_mcp_done()
`;
}

export function genShaderLoadFileScript(
  nodePath: string, materialIndex: number, filePath: string
): string {
  return `${SCENE_TREE_HEADER}
${shaderMatPreamble(nodePath, materialIndex)}
\tif not ResourceLoader.exists("${escapeForGdLiteral(filePath)}"):
\t\t_mcp_output("error", "Shader file not found: ${escapeForGdLiteral(filePath)}")
\t\t_mcp_done()
\t\treturn
\tmat.shader = load("${escapeForGdLiteral(filePath)}")
\t_mcp_output("shader_loaded", {"shader_path": "${escapeForGdLiteral(filePath)}"})
\t_mcp_done()
`;
}

export function genShaderSaveFileScript(filePath: string, code: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar dir = "${escapeForGdLiteral(filePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar f = FileAccess.open("${escapeForGdLiteral(filePath)}", FileAccess.WRITE)
\tif f == null:
\t\t_mcp_output("error", "Failed to open file for writing: ${escapeForGdLiteral(filePath)}")
\t\t_mcp_done()
\t\treturn
\tf.store_string("${escapeForGdLiteral(code)}")
\tf.close()
\t_mcp_output("shader_saved", {"file_path": "${escapeForGdLiteral(filePath)}"})
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
  // F-7: shader code 经 JSON.stringify → 字面量 → JSON.parse_string 往返,不参与 % 格式化。
  // 用 escapeForGdLiteral(不双写 %),原 gdEscape 会把 shader 中的 % 损坏为 %%。
  const jsonCode = escapeForGdLiteral(JSON.stringify(code));
  return `${SCENE_TREE_HEADER}
${shaderMatPreamble(nodePath, materialIndex)}
\tmat.shader = mat.shader.duplicate()
\tvar _code_json: String = "${jsonCode}"
\tvar _parsed: Variant = JSON.parse_string(_code_json)
\tif _parsed == null:
\t\t_mcp_output("error", "Failed to parse shader code JSON")
\t\t_mcp_done()
\t\treturn
\tmat.shader.code = _parsed
\tawait process_frame
\t# C-BUG-1: get_rid().is_valid() 仅确认 shader 资源已分配,与代码能否编译无关。
\t# Godot 4.x headless 无可靠 shader 编译验证 API。compile_success 不可作为编译通过依据。
\tvar compile_ok = mat.shader != null and mat.shader.get_rid().is_valid()
\tvar errors = []
\tvar warnings = []
\tif not compile_ok:
\t\terrors.append({"line": 0, "message": "Shader resource allocation failed"})
\t_mcp_output("template_applied", {"template": "${gdEscape(templateName)}", "compile_success": compile_ok, "errors": errors, "warnings": warnings, "verification_note": "compile_success only confirms shader resource allocation, NOT that the code compiles. Verify via screenshot or Godot error output."})
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
      name: 'material',
      description: `Material and shader operations. Read: read. Write: set_params, create, save, load. Shader: shader_read, shader_write, shader_load_file, shader_save_file, shader_list_templates, shader_apply_template. ` + NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。read=读材质, set_params=调参, create/save/load=建/存/载, shader_*=着色器读写(文件版带 _file), apply_template=套模板',
          },
          node_path: { type: 'string', description: 'Scene tree node path' },
          material_index: { type: 'number', description: 'Material index (optional, default 0)' },
          params: { type: 'object', description: 'set_params: parameter key-value pairs' },
          material_type: { type: 'string', description: 'create: material type' },
          shader_path: { type: 'string', description: 'create: shader resource path' },
          resource_path: { type: 'string', description: 'save/load: resource path' },
          code: { type: 'string', description: 'shader_write/shader_save_file: shader code' },
          file_path: { type: 'string', description: 'shader_load_file/shader_save_file: file path' },
          template_name: { type: 'string', description: 'shader_apply_template: template name' },
          load_autoloads: { type: 'boolean', description: 'Load Autoload context (default true)' },
        },
        required: ['action'],
      },
    },
  ];
}



// ─── Tool Handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = ['material'] as const;

// follow-up C5: 改运行时 material/shader 属性（含 load/shader_load_file，eng-review 修正）
// → 加提示；save/shader_save_file（落盘）+ read/shader_read/shader_list_templates（只读）不加。
const MAT_PERSIST_ACTIONS = new Set(['create', 'set_params', 'shader_write', 'shader_apply_template', 'load', 'shader_load_file']);

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const action = args.action as string;
    if (!action) return opsErrorResult('SCRIPT_EXEC_FAILED', 'action is required');

    // list_templates 不需要 project_path，提前返回
    if (action === 'shader_list_templates') {
      const templates = Object.entries(SHADER_TEMPLATES).map(([n, t]) => ({
        name: n,
        description: t.description,
        uniforms: t.uniforms,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { templates }, warnings: [] }) }] };
    }

    const projectPath = requireProjectPath(args);
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
      return sanitizeResPath(raw, field);
    }


        switch (action) {
      case 'read': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
        script = genMaterialReadScript(nodePath, materialIndex);
        break;
      }
      case 'set_params': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
        const params = args.params as Record<string, unknown>;
        if (!params || typeof params !== 'object') {
        return opsErrorResult('INVALID_PARAM_TYPE', 'params must be an object');
      }
        for (const [key, val] of Object.entries(params)) {
        if (BLOCKED_PROPS.has(key)) return opsErrorResult('INVALID_PARAM_TYPE', `param "${key}" is blocked (BLOCKED_PROPS security policy: script/owner/name/instance/etc.)`);
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
        const nodePath = requireNodePath(args.node_path);
        const materialType = args.material_type as string;
        if (!ALLOWED_MATERIAL_TYPES.includes(materialType as typeof ALLOWED_MATERIAL_TYPES[number])) {
        return opsErrorResult('INVALID_MATERIAL_TYPE', `material_type must be one of: ${ALLOWED_MATERIAL_TYPES.join(', ')}`);
      }
        validateIdentifier(materialType, 'material_type');
        const shaderPath = args.shader_path as string | undefined;
        if (shaderPath) {
        try { sanitizeResPath(shaderPath, 'shader_path'); } catch {
        return opsErrorResult('INVALID_PATH', 'shader_path contains path traversal');
      }
      }
        script = genMaterialCreateScript(nodePath, materialType, shaderPath);
        break;
      }
      case 'save': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
        const resourcePath = requireResPath(args.resource_path, 'resource_path');
        script = genMaterialSaveScript(nodePath, materialIndex, resourcePath);
        break;
      }
      case 'load': {
        const nodePath = requireNodePath(args.node_path);
        const resourcePath = requireResPath(args.resource_path, 'resource_path');
        script = genMaterialLoadScript(nodePath, resourcePath);
        break;
      }
      case 'shader_read': {
        const materialIndex = requireMaterialIndex(args.material_index);
        const nodePath = requireNodePath(args.node_path);
        script = genShaderReadScript(nodePath, materialIndex);
        break;
      }
      case 'shader_write': {
        const materialIndex = requireMaterialIndex(args.material_index);
        const nodePath = requireNodePath(args.node_path);
        const code = args.code as string;
        if (code === undefined || code === null) return opsErrorResult('SCRIPT_EXEC_FAILED', 'code is required for write action');
        script = genShaderWriteScript(nodePath, materialIndex, code);
        break;
      }
      case 'shader_load_file': {
        const materialIndex = requireMaterialIndex(args.material_index);
        const nodePath = requireNodePath(args.node_path);
        const filePath = requireResPath(args.file_path, 'file_path');
        script = genShaderLoadFileScript(nodePath, materialIndex, filePath);
        break;
      }
      case 'shader_save_file': {
        const filePath = requireResPath(args.file_path, 'file_path');
        const code = args.code as string;
        if (code === undefined || code === null) return opsErrorResult('SCRIPT_EXEC_FAILED', 'code is required for save_file action');
        script = genShaderSaveFileScript(filePath, code);
        break;
      }
      case 'shader_apply_template': {
        const nodePath = requireNodePath(args.node_path);
        const materialIndex = requireMaterialIndex(args.material_index);
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

    const result = await executeGdscriptTrusted({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const r = parseGdscriptResult(result, [], materialErrorMapper);
    return MAT_PERSIST_ACTIONS.has(action) ? appendRuntimePersistWarning(r, `material_${action}`) : r;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('Invalid param type')) return opsErrorResult('INVALID_PARAM_TYPE', msg);
    if (msg.includes('Invalid template')) return opsErrorResult('INVALID_TEMPLATE', msg);
    if (msg.includes('NodePath')) return opsErrorResult('MATERIAL_NOT_FOUND', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  material: {
    readonly: false,
    long_running: false,
    actionRisks: {
      read: 'read', shader_read: 'read', shader_list_templates: 'read',
      set_params: 'write', create: 'write', save: 'write', load: 'write',
      shader_write: 'write', shader_load_file: 'write', shader_save_file: 'write', shader_apply_template: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
