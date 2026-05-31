import type { ExecuteGdscriptResult } from '../gdscript-executor.js';
import { textResult, errorResult } from '../types.js';
import type { ToolResult } from '../types.js';
import { isVerifyEligible } from '../core/tool-registry.js';
import { smartCoerce, coerceRect2 } from './smart-coerce.js';

export const MARKER_RESULT = '___MCP_RESULT___';
export const MARKER_ERROR = '___MCP_ERROR___';

export const TYPE_WHITELIST = [
  'Node3D', 'MeshInstance3D', 'StaticBody3D', 'RigidBody3D',
  'CharacterBody3D', 'Camera3D', 'Light3D', 'DirectionalLight3D',
  'OmniLight3D', 'SpotLight3D', 'CollisionShape3D', 'RayCast3D',
  'Area3D', 'Marker3D', 'PathFollow3D', 'VisibleOnScreenNotifier3D',
] as const;

// ─── Helper Utilities ─────────────────────────────────────────────────────

export function normalizeNodePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('NodePath cannot be empty');
  if (trimmed.startsWith('res://')) throw new Error('NodePath must be a scene tree path (root/...), not a resource path (res://...)');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

// Validates a res:// path against traversal attacks, including URL-encoded bypass.
export function sanitizeResPath(raw: unknown, field: string): string {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('res://')) {
    throw new Error(`${field} must be a string starting with res://`);
  }
  // Decode iteratively to defeat double-encoding (%252e%252e%252f etc.)
  let decoded = raw;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < 5) {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new Error(`${field} contains invalid encoding: ${raw}`);
    }
    iterations++;
  }
  if (decoded.includes('/../') || decoded.endsWith('/..') || decoded.includes('\\')) {
    throw new Error(`${field} contains path traversal: ${raw}`);
  }
  return decoded;
}

// Escapes a string for embedding in a GDScript string literal.
// % → %% prevents GDScript string formatting from interpreting % as a placeholder.
// Note: do NOT apply gdEscape to already-escaped output (e.g. gdEscape(gdEscape(x)))
// as %% would become %%%% (harmless but unnecessary double-escaping).
// Note: \uXXXX sequences are NOT escaped because GDScript does not support \u escapes
// (only \xHH for hex and \UXXXXYYYY for unicode codepoints in StringName).
// Note: $ is NOT escaped because GDScript double-quoted strings don't treat $ as special.
// NodePath syntax like $Player works at the expression level, not inside string literals.
export function gdEscape(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '')
    .replace(/%/g, '%%')
    .replace(/'/g, "\\'");
}

/**
 * Unified GDScript value serializer.
 *
 * Converts a JS value into a GDScript expression string.
 * Used by scene.ts, ui-tools.ts, animation-shared.ts, and animation-ops.ts.
 *
 * Returns a bare GDScript literal / constructor call:
 *   null, true/false, 42, "string", Vector2(1,2), Vector3(1,2,3), Color(1,0,0,1)
 *
 * Throws on unsupported types (objects with unexpected keys, arbitrary arrays, etc.).
 * Throws on NaN / Infinity values.
 *
 * @param v         The value to serialize.
 * @param trackType Optional animation track type hint (e.g. 'rotation_3d' → Quaternion).
 */
export function valueToGd(v: unknown, trackType?: string): string {
  // ── Smart coercion layer (only for objects and strings) ──
  if (typeof v === 'object' && v !== null) {
    const rectResult = coerceRect2(v);
    if (typeof rectResult === 'string') return rectResult;
  }
  if (typeof v === 'string') {
    const coerced = smartCoerce(v);
    if (coerced !== v) {
      if (typeof coerced === 'string') return coerced;
      if (typeof coerced === 'object') return valueToGd(coerced, trackType);
    }
  }

  // ── null / undefined ──
  if (v === null || v === undefined) return 'null';

  // ── boolean ──
  if (typeof v === 'boolean') return v ? 'true' : 'false';

  // ── number (with NaN / Infinity guard) ──
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite number not supported: ${v}`);
    return String(v);
  }

  // ── string ──
  if (typeof v === 'string') return `"${gdEscape(v)}"`;

  // ── array → Vector2 / Vector3 / Color ──
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) throw new Error('Non-finite number in array');
      return `Vector2(${v[0]}, ${v[1]})`;
    }
    if (v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number') {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) throw new Error('Non-finite number in array');
      if (trackType === 'rotation_3d') {
        return `Quaternion.from_euler(Vector3(${v[0]}, ${v[1]}, ${v[2]}))`;
      }
      return `Vector3(${v[0]}, ${v[1]}, ${v[2]})`;
    }
    if (v.length === 4 && v.every(el => typeof el === 'number')) {
      if (!v.every(el => Number.isFinite(el as number))) throw new Error('Non-finite number in array');
      return `Color(${v[0]}, ${v[1]}, ${v[2]}, ${v[3]})`;
    }
    // Longer arrays → JSON array literal (e.g. keyframe points, polygon vertices)
    return `[${v.map(el => valueToGd(el)).join(', ')}]`;
  }

  // ── object → {x,y} / {x,y,z} / {r,g,b,a} ──
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.some(k => !['x', 'y', 'z', 'r', 'g', 'b', 'a'].includes(k))) {
      throw new Error(`Unsupported object keys: ${keys.filter(k => !['x', 'y', 'z', 'r', 'g', 'b', 'a'].includes(k)).join(', ')}. Allowed: {x,y}, {x,y,z}, {r,g,b,a}.`);
    }
    // Vector2 / Vector3
    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
      if (!Number.isFinite(obj.x as number) || !Number.isFinite(obj.y as number)) throw new Error('Non-finite number in object');
      if (typeof obj.z === 'number') {
        if (!Number.isFinite(obj.z as number)) throw new Error('Non-finite number in object');
        return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
      }
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    // Color
    if (typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1.0;
      if (!Number.isFinite(obj.r as number) || !Number.isFinite(obj.g as number) || !Number.isFinite(obj.b as number) || !Number.isFinite(a as number)) throw new Error('Non-finite number in object');
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    throw new Error(`Cannot convert object to GDScript literal: expected {x,y}, {x,y,z}, or {r,g,b,a}`);
  }

  throw new Error(`Cannot convert value to GDScript literal: ${typeof v}`);
}

/** Clamps a timeout value (seconds) to [min, max], defaulting on invalid input. */
export function validateTimeout(value: unknown, min = 5, max = 120, defaultVal = 30): number {
  if (value === undefined || value === null) return defaultVal;
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultVal;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** Ensure a value converts to a finite number; throws with descriptive error on failure. */
export function ensureNumber(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${JSON.stringify(v)}`);
  return n;
}

/** Clamp a numeric parameter to [min, max], pushing a warning when clamped. Returns undefined if input is undefined. */
export function clampParam(val: number | undefined, min: number, max: number, name: string, warnings: string[]): number | undefined {
  if (val === undefined) return undefined;
  if (val < min) { warnings.push(`${name} ${val} clamped to ${min}`); return min; }
  if (val > max) { warnings.push(`${name} ${val} clamped to ${max}`); return max; }
  return val;
}

/** Validate and return a rounded number within [min, max]; throws on failure. */
export function validatePositiveInt(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got: ${JSON.stringify(v)}`);
  }
  return Math.round(n);
}

/** Common error codes shared across tool modules. */
export const COMMON_ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
} as const;

/** Validates that a string is a safe GDScript identifier (class name, type name, etc.). */
export function validateIdentifier(name: string, label = 'Identifier'): void {
  if (name.length > 64) {
    throw new Error(`${label} "${name.slice(0, 20)}..." must be 1-64 characters (got ${name.length})`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} "${name}" is not a valid GDScript identifier`);
  }
}

// 标准 camelCase→snake_case（nodeType→node_type）。连续大写会逐字插入下划线（HTTPClient→h_t_t_p_client），但 Godot 属性无此模式。
export function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (ch, idx) => (idx > 0 ? '_' : '') + ch.toLowerCase());
}

export function validateVector3(v: unknown): { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Vector3 must be an object with x, y, z number fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y', 'z']) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) throw new Error(`Vector3 field "${key}" must be a finite number`);
  }
  return { x: obj.x as number, y: obj.y as number, z: obj.z as number };
}

// ─── GDScript 辅助函数（共享模板）────────────────────────
// SCENE_TREE_HEADER 和 gdscript-executor.ts 的 wrapSnippet 共同引用。
// 使用 readonly string[] 而非模板字面量，防止 JS 变量插值污染 GDScript 代码。

/** _mcp_get_root() — 获取场景根节点（缓存） */
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\tif root != null:',
  '\t\t_mcp_root = root',
  '\t\treturn _mcp_root',
  '\tvar ml: Variant = Engine.get_main_loop()',
  '\tif ml != null and ml is SceneTree and ml.root != null:',
  '\t\t_mcp_root = ml.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];

/** _mcp_get_node() — 按路径获取节点（精确版：只在根节点上下文跳过 "root"） */
export const GD_MCP_GET_NODE: readonly string[] = [
  'func _mcp_get_node(path: NodePath) -> Node:',
  '\tvar _p: String = str(path)',
  '\tif _p.begins_with("/"):',
  '\t\t_p = _p.substr(1)',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn null',
  '\t# Fallback: root.get_node() may fail in headless _initialize()',
  '\tvar _node: Node = _r.get_node_or_null(_p)',
  '\tif _node != null:',
  '\t\treturn _node',
  '\t# Manual traversal for headless compatibility',
  '\tvar _parts: PackedStringArray = _p.split("/")',
  '\t_node = _r',
  '\tfor _part in _parts:',
  '\t\tif _part == "":',
  '\t\t\tcontinue',
  '\t\tvar _found: bool = false',
  '\t\tfor _ch in _node.get_children():',
  '\t\t\tif _ch.name == _part:',
  '\t\t\t\t_node = _ch',
  '\t\t\t\t_found = true',
  '\t\t\t\tbreak',
  '\t\tif not _found:',
  '\t\t\tif _part == "root" and _node == _r:',
  '\t\t\t\tcontinue',
  '\t\t\treturn null',
  '\treturn _node',
];

/** _mcp_load_main_scene() — 加载主场景 */
export const GD_MCP_LOAD_MAIN_SCENE: readonly string[] = [
  'func _mcp_load_main_scene() -> void:',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn',
  '\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")',
  '\tif _sp != null and _sp != "":',
  '\t\tvar _sr = load(_sp)',
  '\t\tif _sr:',
  '\t\t\t_r.add_child(_sr.instantiate())',
];

/** _mcp_output() — 记录输出（修复：SCENE_TREE_HEADER 原缺失此函数） */
export const GD_MCP_OUTPUT: readonly string[] = [
  'func _mcp_output(key: String, value: Variant) -> void:',
  '\t_mcp_outputs.append({"key": key, "value": str(value)})',
];

export const SCENE_TREE_HEADER = [
  'extends SceneTree',
  '',
  'var _mcp_outputs: Array = []',
  'var _mcp_root: Node = null',
  'var _mcp_scene_instance: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  '',
  // SCENE_TREE_HEADER 独有：场景加载和导航辅助
  'func _mcp_load_scene(sp: String) -> bool:',
  '	var _r: Node = _mcp_get_root()',
  '	if _r == null:',
  '		_mcp_output("error", "Scene root not available")',
  '		return false',
  '	if _mcp_scene_instance != null:',
  '		if _mcp_scene_instance.get_parent() != null:',
  '			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)',
  '		_mcp_scene_instance.queue_free()',
  '		_mcp_scene_instance = null',
  '	var _sr = load(sp)',
  '	if _sr == null:',
  '		_mcp_output("error", "Failed to load scene: " + sp)',
  '		return false',
  '	_mcp_scene_instance = _sr.instantiate()',
  '	_r.add_child(_mcp_scene_instance)',
  '	return true',
  '',
  'func _mcp_get_scene_node(path: String) -> Node:',
  '	# Search within loaded scene instance (avoids root/SceneName prefix issue)',
  '	if _mcp_scene_instance != null:',
  '		var _p: String = path',
  '		while _p.begins_with("/"):',
  '			_p = _p.substr(1)',
  '		# Strip leading "root/" or "root" prefix',
  '		if _p.begins_with("root/"):',
  '			_p = _p.substr(5)',
  '		elif _p == "root":',
  '			_p = ""',
  '		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")',
  '		if _p != "" and _mcp_scene_instance.name.length() > 0:',
  '			var _scene_name: String = _mcp_scene_instance.name + "/"',
  '			if _p.begins_with(_scene_name):',
  '				_p = _p.substr(_scene_name.length())',
  '			elif _p == _mcp_scene_instance.name:',
  '				_p = ""',
  '		if _p == "":',
  '		return _mcp_scene_instance',
  '		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)',
  '		if _node != null:',
  '			return _node',
  '	# Fallback to global search',
  '	return _mcp_get_node(path)',
  '',
  ...GD_MCP_OUTPUT,
  '',
  'func _mcp_done() -> void:',
  '	print("' + MARKER_RESULT + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
  '	if Engine.get_main_loop() == self:',
  '		quit(0)',
].join('\n');

export const NON_PERSIST = '运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。';

export function opsSuccess(data: unknown, warnings: string[] = []) {
  return { success: true, data, warnings };
}

export function opsError(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
) {
  return {
    success: false,
    error: message,
    error_code: errorCode,
    warnings: [] as string[],
    ...(opts?.suggestion ? { suggestion: opts.suggestion } : {}),
  };
}

export function opsErrorResult(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
): ToolResult {
  return errorResult(JSON.stringify(opsError(errorCode, message, opts)));
}

export function parseGdscriptResult(
  result: ExecuteGdscriptResult,
  paramWarnings: string[] = [],
  errorMapper: (errorMsg: string) => string = () => 'SCRIPT_EXEC_FAILED',
  errorOpts?: { suggestion?: string },
): ToolResult {
  if (!result.compile_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.compile_error, errorOpts);
  }
  if (!result.run_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.run_error, errorOpts);
  }

  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const entry of result.outputs) {
    if (entry.key === 'warning') {
      warnings.push(String(entry.value));
    } else if (entry.key === 'error') {
      const errCode = errorMapper(String(entry.value));
      return opsErrorResult(errCode, String(entry.value), errCode === 'NODE_NOT_FOUND' ? errorOpts : undefined);
    } else {
      try {
        data[entry.key] = JSON.parse(entry.value);
      } catch {
        data[entry.key] = entry.value;
      }
    }
  }

  return textResult(JSON.stringify(opsSuccess(data, [...paramWarnings, ...warnings])));
}

// ─── L1 Quick Verify Infrastructure ────────────────────────────────────────

export interface QuickVerifyResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
  error?: string;
}

/** L1 verify entry point. Returns null when verify !== true (skip verification). */
// async: reserved for future GDScript execution — callers should always await
export async function quickVerify(
  toolName: string,
  args: Record<string, unknown>,
): Promise<QuickVerifyResult | null> {
  if (args.verify !== true) return null;

  if (!isVerifyEligible(toolName)) {
    return { passed: false, checks: [], error: `No quickVerify handler for tool: ${toolName}` };
  }

  // Not yet implemented — returns explicit failure so callers know verification was not performed
  return { passed: false, checks: [{ name: 'not_implemented', passed: false, detail: 'L1 quickVerify not yet implemented for this tool' }] };
}

/** Shared assertion wrapper — called by both dev_loop.acceptance and delivery.ts assertions */
export function wrapAssertionCode(assertionCode: string, description: string, loadScene = true): string {
  const escapedDesc = gdEscape(description);
  const sceneLoadLine = loadScene ? '\t_mcp_load_main_scene()\n' : '';
  return `${SCENE_TREE_HEADER}

func _initialize():
${sceneLoadLine}\tvar _desc = "${escapedDesc}"
\t# --- user assertion code ---
\t${assertionCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\n\t')}
\t# --- end user code ---
\t_mcp_done()
`;
}

/** L1 template: check whether a node exists */
export function genCheckNodeExists(nodePath: string): string {
  const escaped = gdEscape(nodePath);
  return `var _n = _mcp_get_node("${escaped}")
if _n != null:
\t_mcp_output("node_exists", JSON.stringify({"path": "${escaped}", "exists": true, "type": _n.get_class()}))
else:
\t_mcp_output("node_exists", JSON.stringify({"path": "${escaped}", "exists": false, "type": ""}))`;
}

/** L1 template: batch-read property values */
export function genCheckProperties(nodePath: string, props: Record<string, unknown>): string {
  const escaped = gdEscape(nodePath);
  const lines: string[] = [];
  lines.push(`var _n = _mcp_get_node("${escaped}")`);
  lines.push('if _n == null:');
  lines.push(`\t_mcp_output("props", JSON.stringify({"error": "node not found: ${escaped}"}))`);
  lines.push('else:');
  lines.push('\tvar _props = {}');
  for (const [key, expected] of Object.entries(props)) {
    const ek = gdEscape(key);
    const ev = gdEscape(JSON.stringify(expected));
    lines.push(`\t_props["${ek}"] = {"actual": str(_n.get("${ek}")), "expected": str("${ev}")}`);
  }
  lines.push('\t_mcp_output("props", JSON.stringify(_props))');
  return lines.join('\n');
}
