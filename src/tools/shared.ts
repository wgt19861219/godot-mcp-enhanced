import type { ExecuteGdscriptResult } from '../gdscript-executor.js';
import { textResult } from '../types.js';
import type { ToolResult } from '../types.js';

export const MARKER_RESULT = '___MCP_RESULT___';

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

// Escapes a string for embedding in a GDScript string literal.
// % → %% prevents GDScript string formatting from interpreting % as a placeholder.
// Note: do NOT apply gdEscape to already-escaped output (e.g. gdEscape(gdEscape(x)))
// as %% would become %%%% (harmless but unnecessary double-escaping).
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
    .replace(/\$/g, '\\$')
    .replace(/'/g, "\\'");
}

export function validateVector3(v: unknown): { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Vector3 must be an object with x, y, z number fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y', 'z']) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) throw new Error(`Vector3 field "${key}" must be a finite number`);
  }
  return { x: obj.x as number, y: obj.y as number, z: obj.z as number };
}

export const SCENE_TREE_HEADER = `extends SceneTree

var _mcp_root: Node = null
var _mcp_scene_instance: Node = null

func _mcp_get_root() -> Node:
\tif _mcp_root != null:
\t\treturn _mcp_root
\tif root != null:
\t\t_mcp_root = root
\t\treturn _mcp_root
\tvar ml: Variant = Engine.get_main_loop()
\tif ml != null and ml is SceneTree and ml.root != null:
\t\t_mcp_root = ml.root
\t\treturn _mcp_root
\treturn null

func _mcp_get_node(path: NodePath) -> Node:
\tvar _p: String = str(path)
\tif _p.begins_with("/"):
\t\t_p = _p.substr(1)
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn null
\t# Fallback: root.get_node() may fail in headless _initialize()
\tvar _node: Node = _r.get_node_or_null(_p)
\tif _node != null:
\t\treturn _node
\t# Manual traversal for headless compatibility
\tvar _parts: PackedStringArray = _p.split("/")
\t_node = _r
\tfor _part in _parts:
\t\tif _part == "":
\t\t\tcontinue
\t\tvar _found: bool = false
\t\tfor _ch in _node.get_children():
\t\t\tif _ch.name == _part:
\t\t\t\t_node = _ch
\t\t\t\t_found = true
\t\t\t\tbreak
\t\tif not _found:
\t\t\tif _part == "root" and _node == _r:
\t\t\t\tcontinue
\t\t\treturn null
\treturn _node
func _mcp_load_main_scene() -> void:
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn
\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
\tif _sp != null and _sp != "":
\t\tvar _sr = load(_sp)
\t\tif _sr:
\t\t\t_r.add_child(_sr.instantiate())
func _mcp_load_scene(sp: String) -> bool:
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\t_mcp_output("error", "Scene root not available")
\t\treturn false
\tif _mcp_scene_instance != null:
\t\tif _mcp_scene_instance.get_parent() != null:
\t\t\t_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
\t\t_mcp_scene_instance.queue_free()
\t\t_mcp_scene_instance = null
\tvar _sr = load(sp)
\tif _sr == null:
\t\t_mcp_output("error", "Failed to load scene: " + sp)
\t\treturn false
\t_mcp_scene_instance = _sr.instantiate()
\t_r.add_child(_mcp_scene_instance)
\treturn true

func _mcp_get_scene_node(path: String) -> Node:
\t# Search within loaded scene instance (avoids root/SceneName prefix issue)
\tif _mcp_scene_instance != null:
\t\tvar _p: String = path
\t\twhile _p.begins_with("/"):
\t\t\t_p = _p.substr(1)
\t\t# Strip leading "root/" or "root" prefix
\t\tif _p.begins_with("root/"):
\t\t\t_p = _p.substr(5)
\t\telif _p == "root":
\t\t\t_p = ""
\t\t# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
\t\tif _p != "" and _mcp_scene_instance.name.length() > 0:
\t\t\tvar _scene_name: String = _mcp_scene_instance.name + "/"
\t\t\tif _p.begins_with(_scene_name):
\t\t\t\t_p = _p.substr(_scene_name.length())
\t\t\telif _p == _mcp_scene_instance.name:
\t\t\t\t_p = ""
\t\tif _p == "":
\t\t\treturn _mcp_scene_instance
\t\tvar _node: Node = _mcp_scene_instance.get_node_or_null(_p)
\t\tif _node != null:
\t\t\treturn _node
\t# Fallback to global search
\treturn _mcp_get_node(path)

func _mcp_done() -> void:
\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
\tif Engine.get_main_loop() == self:
\t\tquit(0)
`;

export const NON_PERSIST = '运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。';

export function opsSuccess(data: unknown, warnings: string[] = []) {
  return { success: true, data, warnings };
}

export function opsError(errorCode: string, message: string) {
  return { success: false, error: message, error_code: errorCode, warnings: [] };
}

export function opsErrorResult(errorCode: string, message: string): ToolResult {
  return textResult(JSON.stringify(opsError(errorCode, message)));
}

export function parseGdscriptResult(
  result: ExecuteGdscriptResult,
  paramWarnings: string[] = [],
  errorMapper: (errorMsg: string) => string = () => 'SCRIPT_EXEC_FAILED',
): ToolResult {
  if (!result.compile_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.compile_error);
  }
  if (!result.run_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.run_error);
  }

  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const entry of result.outputs) {
    if (entry.key === 'warning') {
      warnings.push(String(entry.value));
    } else if (entry.key === 'error') {
      return opsErrorResult(errorMapper(String(entry.value)), String(entry.value));
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
