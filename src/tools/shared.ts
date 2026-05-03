import type { ExecuteGdscriptResult } from '../gdscript-executor.js';
import { textResult } from '../types.js';
import type { ToolResult } from '../types.js';

export const MARKER_RESULT = '___MCP_RESULT___';

export const SCENE_TREE_HEADER = `extends SceneTree

var _mcp_root: Node = null

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

func get_node(path: NodePath) -> Node:
\tvar _p: String = str(path)
\tif _p.begins_with("/"):
\t\t_p = _p.substr(1)
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn null
\treturn _r.get_node(_p)

func _mcp_load_main_scene() -> void:
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn
\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
\tif _sp != null and _sp != "":
\t\tvar _sr = load(_sp)
\t\tif _sr:
\t\t\t_r.add_child(_sr.instantiate())

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
