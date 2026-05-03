export const MARKER_RESULT = '___MCP_RESULT___';

export const SCENE_TREE_HEADER = `extends SceneTree

func _mcp_done() -> void:
\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
\tquit()
`;

export function opsSuccess(data: unknown, warnings: string[] = []) {
  return { success: true, data, warnings };
}
