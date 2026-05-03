import type { ExecuteGdscriptResult } from '../gdscript-executor.js';
import { textResult } from '../types.js';
import type { ToolResult } from '../types.js';

export const MARKER_RESULT = '___MCP_RESULT___';

export const SCENE_TREE_HEADER = `extends SceneTree

func get_node(path: NodePath) -> Node:
\treturn root.get_node(path)

func _mcp_load_main_scene() -> void:
\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
\tif _sp != null and _sp != "":
\t\tvar _sr = load(_sp)
\t\tif _sr:
\t\t\troot.add_child(_sr.instantiate())

func _mcp_done() -> void:
\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
\tquit()
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
