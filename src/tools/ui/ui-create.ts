// UI node creation: ui_create_control, ui_container_add, ui_anchor_preset.

import { gdEscape, escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';
import { CONTROL_TYPES, genPropertyLines } from './types.js';

export function genUiCreateControlScript(
  scenePath: string,
  nodeType: string,
  nodeName: string,
  parentPath: string,
  properties?: Record<string, unknown>,
): string {
  const propLines = properties && Object.keys(properties).length > 0
    ? genPropertyLines(properties)
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar parent = _mcp_get_scene_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar node = ClassDB.instantiate("${gdEscape(nodeType)}")
\tif node == null:
\t\t_mcp_output("error", "Failed to instantiate: ${gdEscape(nodeType)}")
\t\t_mcp_done()
\t\treturn
\tnode.name = "${gdEscape(nodeName)}"${propLines}
\tparent.add_child(node)
\tnode.owner = parent.owner if parent.owner != null else parent
\t_mcp_output("created", {"type": "${gdEscape(nodeType)}", "name": "${gdEscape(nodeName)}", "path": str(node.get_path()) if node.is_inside_tree() else "${gdEscape(nodeName)}"})
\t_mcp_done()
`;
}

export function genUiContainerAddScript(
  scenePath: string,
  nodePath: string,
  childType: string,
  childName: string,
  childProperties?: Record<string, unknown>,
): string {
  if (!CONTROL_TYPES.includes(childType as typeof CONTROL_TYPES[number])) {
    throw new Error(`INVALID_CONTROL_TYPE: "${childType}" is not a whitelisted Control type`);
  }
  const propLines = childProperties && Object.keys(childProperties).length > 0
    ? genPropertyLines(childProperties).replace(/\t_mcp_set_prop\(node,/g, '\t_mcp_set_prop(child,')
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar container = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif container == null:
\t\t_mcp_output("error", "Container node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar child = ClassDB.instantiate("${gdEscape(childType)}")
\tif child == null:
\t\t_mcp_output("error", "Failed to instantiate: ${gdEscape(childType)}")
\t\t_mcp_done()
\t\treturn
\tchild.name = "${gdEscape(childName)}"${propLines}
\tcontainer.add_child(child)
\tchild.owner = container.owner if container.owner != null else container
\t_mcp_output("child_added", {"container": "${escapeForGdLiteral(nodePath)}", "child_type": "${gdEscape(childType)}", "child_name": "${gdEscape(childName)}", "child_path": str(child.get_path()) if child.is_inside_tree() else "${gdEscape(childName)}"})
\t_mcp_done()
`;
}

export function genUiAnchorPresetScript(
  scenePath: string,
  nodePath: string,
  presetValue: number,
  presetName: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tnode.set_anchors_preset(${presetValue})
\t_mcp_output("preset_applied", {"node": "${escapeForGdLiteral(nodePath)}", "preset": "${gdEscape(presetName)}", "value": ${presetValue}})
\t_mcp_done()
`;
}
