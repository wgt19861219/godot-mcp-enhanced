import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath, resolveWithinRoot, normalizeUserProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const TOOL_NAMES = [
  'ui_create_control',
  'ui_set_layout',
  'ui_get_layout',
  'ui_anchor_preset',
  'ui_set_theme',
  'ui_container_add',
  'ui_draw_recipe',
  'ui_build_layout',
  'theme_create',
  'theme_set_property',
] as const;

const CONTROL_TYPES = [
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect',
  'ColorPickerButton', 'TabContainer', 'Tree', 'ItemList',
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer',
  'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
] as const;

const ANCHOR_PRESETS: Record<string, number> = {
  top_left: 0,
  top_right: 1,
  bottom_left: 2,
  bottom_right: 3,
  center_left: 4,
  center_top: 5,
  center_right: 6,
  center_bottom: 7,
  center: 8,
  left_wide: 9,
  top_wide: 10,
  right_wide: 11,
  bottom_wide: 12,
  vcenter_wide: 13,
  hcenter_wide: 14,
  full_rect: 15,
};

const ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_DRAW_OP: 'INVALID_DRAW_OP',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  THEME_NOT_FOUND: 'THEME_NOT_FOUND',
  INVALID_THEME_PROPERTY: 'INVALID_THEME_PROPERTY',
  INVALID_THEME_ITEM_TYPE: 'INVALID_THEME_ITEM_TYPE',
} as const;

const DRAW_OP_KINDS = ['rect', 'circle', 'line', 'arc', 'polygon', 'polyline', 'string'] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function serializePropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${gdEscape(value)}"`;
  throw new Error(`Unsupported property type: ${typeof value}`);
}

function genPropertyLines(properties: Record<string, unknown>): string {
  let lines = '';
  for (const [key, value] of Object.entries(properties)) {
    lines += `\n\tnode.set("${gdEscape(key)}", ${serializePropertyValue(value)})`;
  }
  return lines;
}

function colorToGd(c: unknown): string {
  if (!Array.isArray(c) || c.length < 3) {
    throw new Error('Color must be [r, g, b] or [r, g, b, a] (values 0-1)');
  }
  const a = c.length >= 4 ? c[3] : 1;
  return `Color(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

// ─── GDScript Generators ───────────────────────────────────────────────────

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
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar parent = _mcp_get_scene_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar node = ${nodeType}.new()
\tnode.name = "${gdEscape(nodeName)}"${propLines}
\tparent.add_child(node)
\tnode.owner = parent.owner if parent.owner != null else parent
\t_mcp_output("created", {"type": "${gdEscape(nodeType)}", "name": "${gdEscape(nodeName)}", "path": str(node.get_path()) if node.is_inside_tree() else "${gdEscape(nodeName)}"})
\t_mcp_done()
`;
}

export function genUiSetLayoutScript(
  scenePath: string,
  nodePath: string,
  anchors?: { left?: number; right?: number; top?: number; bottom?: number },
  offsets?: { left?: number; right?: number; top?: number; bottom?: number },
  minSize?: { x?: number; y?: number },
  customMinSize?: { x?: number; y?: number },
  growDirection?: string,
): string {
  let lines = '';

  if (anchors) {
    if (anchors.left !== undefined) lines += `\n\tnode.anchor_left = ${anchors.left}`;
    if (anchors.right !== undefined) lines += `\n\tnode.anchor_right = ${anchors.right}`;
    if (anchors.top !== undefined) lines += `\n\tnode.anchor_top = ${anchors.top}`;
    if (anchors.bottom !== undefined) lines += `\n\tnode.anchor_bottom = ${anchors.bottom}`;
  }
  if (offsets) {
    if (offsets.left !== undefined) lines += `\n\tnode.offset_left = ${offsets.left}`;
    if (offsets.right !== undefined) lines += `\n\tnode.offset_right = ${offsets.right}`;
    if (offsets.top !== undefined) lines += `\n\tnode.offset_top = ${offsets.top}`;
    if (offsets.bottom !== undefined) lines += `\n\tnode.offset_bottom = ${offsets.bottom}`;
  }
  if (minSize) {
    if (minSize.x !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(${minSize.x}, node.custom_minimum_size.y)`;
    if (minSize.y !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(node.custom_minimum_size.x, ${minSize.y})`;
  }
  if (customMinSize) {
    lines += `\n\tnode.custom_minimum_size = Vector2(${customMinSize.x ?? 'node.custom_minimum_size.x'}, ${customMinSize.y ?? 'node.custom_minimum_size.y'})`;
  }
  if (growDirection) {
    const dir = growDirection.toLowerCase();
    const dirMap: Record<string, string> = {
      both: 'Control.GROW_DIRECTION_BOTH',
      up: 'Control.GROW_DIRECTION_UP',
      down: 'Control.GROW_DIRECTION_DOWN',
      left: 'Control.GROW_DIRECTION_LEFT',
      right: 'Control.GROW_DIRECTION_RIGHT',
    };
    const gdDir = dirMap[dir];
    if (gdDir) {
      if (dir === 'left' || dir === 'right' || dir === 'both') {
        lines += `\n\tnode.grow_horizontal = ${gdDir}`;
      }
      if (dir === 'up' || dir === 'down' || dir === 'both') {
        lines += `\n\tnode.grow_vertical = ${gdDir}`;
      }
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("layout_set", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genUiGetLayoutScript(
  scenePath: string,
  nodePath: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar info = {
\t\t"anchor_left": node.anchor_left,
\t\t"anchor_right": node.anchor_right,
\t\t"anchor_top": node.anchor_top,
\t\t"anchor_bottom": node.anchor_bottom,
\t\t"offset_left": node.offset_left,
\t\t"offset_right": node.offset_right,
\t\t"offset_top": node.offset_top,
\t\t"offset_bottom": node.offset_bottom,
\t\t"global_position": {"x": node.global_position.x, "y": node.global_position.y},
\t\t"size": {"x": node.size.x, "y": node.size.y}
\t}
\t_mcp_output("layout", info)
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
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tnode.set_anchors_preset(${presetValue})
\t_mcp_output("preset_applied", {"node": "${gdEscape(nodePath)}", "preset": "${gdEscape(presetName)}", "value": ${presetValue}})
\t_mcp_done()
`;
}

// ─── ui_set_theme ──────────────────────────────────────────────────────────

export function genUiSetThemeScript(
  scenePath: string,
  nodePath: string,
  action: 'set_params' | 'create' | 'save' | 'load',
  themePath?: string,
  params?: Record<string, unknown>,
): string {
  let actionBlock = '';

  switch (action) {
    case 'create':
      actionBlock = `
\tvar theme = Theme.new()
\tnode.theme = theme`;
      break;
    case 'set_params': {
      const paramLines: string[] = [];
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === null || value === undefined) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", null)`);
          } else if (typeof value === 'number') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${value})`);
          } else if (typeof value === 'boolean') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${String(value)})`);
          } else if (typeof value === 'string') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", "${gdEscape(value)}")`);
          } else if (Array.isArray(value) && value.length === 4) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]}))`);
          }
        }
      }
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn${paramLines.length > 0 ? '\n' + paramLines.join('\n') : ''}`;
      break;
    }
    case 'save':
      if (!themePath) throw new Error('theme_path is required for save action');
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme to save")
\t\t_mcp_done()
\t\treturn
\tvar dir = "${gdEscape(themePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar err = ResourceSaver.save(theme, "${gdEscape(themePath)}")
\tif err != OK:
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn`;
      break;
    case 'load':
      if (!themePath) throw new Error('theme_path is required for load action');
      actionBlock = `
\tvar res = load("${gdEscape(themePath)}")
\tif res == null:
\t\t_mcp_output("error", "Failed to load theme from: ${gdEscape(themePath)}")
\t\t_mcp_done()
\t\treturn
\tnode.theme = res`;
      break;
  }

  const outputKey = action === 'save' ? 'saved' : action === 'load' ? 'loaded' : 'theme_set';
  const outputValue = action === 'save'
    ? '{"resource_path": "' + gdEscape(themePath || '') + '"}'
    : action === 'load'
      ? '{"resource_path": "' + gdEscape(themePath || '') + '"}'
      : '{"node": "' + gdEscape(nodePath) + '", "action": "' + action + '"}';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${actionBlock}
\t_mcp_output("${outputKey}", ${outputValue})
\t_mcp_done()
`;
}

// ─── ui_container_add ──────────────────────────────────────────────────────

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
    ? genPropertyLines(childProperties).replace(/\tnode\./g, '\tchild.')
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar container = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif container == null:
\t\t_mcp_output("error", "Container node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar child = ${childType}.new()
\tchild.name = "${gdEscape(childName)}"${propLines}
\tcontainer.add_child(child)
\tchild.owner = container.owner if container.owner != null else container
\t_mcp_output("child_added", {"container": "${gdEscape(nodePath)}", "child_type": "${gdEscape(childType)}", "child_name": "${gdEscape(childName)}", "child_path": str(child.get_path()) if child.is_inside_tree() else "${gdEscape(childName)}"})
\t_mcp_done()
`;
}

// ─── ui_draw_recipe ──────────────────────────────────────────────────────────

const MAX_DRAW_OPS = 200;

export type DrawOp = { kind: string; [key: string]: unknown };

function drawOpToGd(op: DrawOp): string {
  const col = (c: unknown) => colorToGd(c ?? [1, 1, 1, 1]);

  switch (op.kind) {
    case 'rect': {
      const pos = op.position as number[];
      const sz = op.size as number[];
      return `\tdraw_rect(Rect2(${pos[0]}, ${pos[1]}, ${sz[0]}, ${sz[1]}), ${col(op.color)})`;
    }
    case 'circle': {
      const ctr = op.center as number[];
      const r = op.radius as number;
      return `\tdraw_circle(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${col(op.color)})`;
    }
    case 'line': {
      const from = op.from as number[];
      const to = op.to as number[];
      const w = op.width as number | undefined;
      return `\tdraw_line(Vector2(${from[0]}, ${from[1]}), Vector2(${to[0]}, ${to[1]}), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'arc': {
      const ctr = op.center as number[];
      const r = op.radius as number;
      const sa = op.start_angle as number;
      const ea = op.end_angle as number;
      const w = op.width as number | undefined;
      return `\tdraw_arc(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${sa}, ${ea}, ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'polygon': {
      const pts = op.points as number[][];
      const packedPts = pts.map(p => `Vector2(${p[0]}, ${p[1]})`).join(', ');
      const filled = op.filled !== false;
      if (filled) {
        return `\tdraw_colored_polygon(PackedVector2Array([${packedPts}]), ${col(op.color)})`;
      }
      const w = op.width as number | undefined;
      return `\tdraw_polyline(PackedVector2Array([${packedPts}]), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'polyline': {
      const pts = op.points as number[][];
      const packedPts = pts.map(p => `Vector2(${p[0]}, ${p[1]})`).join(', ');
      const w = op.width as number | undefined;
      return `\tdraw_polyline(PackedVector2Array([${packedPts}]), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'string': {
      const text = String(op.text ?? '');
      const pos = op.position as number[];
      const fs = (op.font_size as number) ?? 16;
      return `\tdraw_string(ThemeDB.fallback_font, Vector2(${pos[0]}, ${pos[1]}), "${gdEscape(text)}", HORIZONTAL_ALIGNMENT_LEFT, -1, ${fs}, ${col(op.color)})`;
    }
    default:
      throw new Error(`Unknown draw op kind: "${op.kind}". Must be one of: ${DRAW_OP_KINDS.join(', ')}`);
  }
}

export function genUiDrawRecipeScript(
  scenePath: string,
  nodePath: string,
  ops: DrawOp[],
): string {
  if (ops.length > MAX_DRAW_OPS) {
    throw new Error(`Maximum ${MAX_DRAW_OPS} draw ops allowed, got ${ops.length}`);
  }

  const drawLines = ops.map(op => drawOpToGd(op)).join('\n');

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar _draw_fn = func():
${drawLines || '\t\tpass'}
\tnode.draw.connect(_draw_fn)
\tnode.queue_redraw()
\t_mcp_output("draw_recipe_attached", {"node": "${gdEscape(nodePath)}", "ops_count": ${ops.length}})
\t_mcp_done()
`;
}

// ─── ui_build_layout ─────────────────────────────────────────────────────────

export type UiNodeSpec = {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  anchor_preset?: string;
  children?: UiNodeSpec[];
};

const MAX_NESTING_DEPTH = 10;

function validateUiNodeSpec(spec: UiNodeSpec, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Maximum nesting depth is ${MAX_NESTING_DEPTH}, exceeded at node "${spec.name}"`);
  }
  if (!CONTROL_TYPES.includes(spec.type as typeof CONTROL_TYPES[number])) {
    throw new Error(`INVALID_CONTROL_TYPE: "${spec.type}" is not a whitelisted Control type`);
  }
  if (!spec.name) {
    throw new Error('name is required for each UiNodeSpec');
  }
  if (spec.anchor_preset && !(spec.anchor_preset in ANCHOR_PRESETS)) {
    throw new Error(`INVALID_ANCHOR_PRESET: "${spec.anchor_preset}"`);
  }
  if (spec.children) {
    for (const child of spec.children) {
      validateUiNodeSpec(child, depth + 1);
    }
  }
}

let _savedCounter = 0;

function uiNodeToGd(spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string): string {
  const anchorLine = spec.anchor_preset
    ? `\n${indent}node.set_anchors_preset(${ANCHOR_PRESETS[spec.anchor_preset]})`
    : '';
  const propLines = spec.properties && Object.keys(spec.properties).length > 0
    ? '\n' + Object.entries(spec.properties).map(
        ([k, v]) => `${indent}node.set("${gdEscape(k)}", ${serializePropertyValue(v)})`
      ).join('\n')
    : '';

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(spec.type)}")
${indent}node.name = "${gdEscape(spec.name)}"${anchorLine}${propLines}`;

  if (spec.children && spec.children.length > 0) {
    const savedIdx = _savedCounter++;
    const savedVar = `_saved_${savedIdx}`;
    lines += `\n${indent}var ${savedVar} = node`;
    for (const child of spec.children) {
      lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent);
    }
    lines += `\n${indent}node = ${savedVar}`;
  }

  lines += `\n${indent}${parentVar}.add_child(node)
${indent}node.owner = ${ownerVar}`;

  return lines;
}

export function genUiBuildLayoutScript(
  scenePath: string,
  parentPath: string,
  tree: UiNodeSpec,
): string {
  validateUiNodeSpec(tree, 1);

  _savedCounter = 0;
  const buildBlock = uiNodeToGd(tree, 'parent', 'root', '\t');

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_get_scene_node("${gdEscape(parentPath)}")
\tif root == null:
\t\t_mcp_output("error", "Parent not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar parent = root
\tvar node: Node
${buildBlock}
\t_mcp_output("layout_built", {"parent": "${gdEscape(parentPath)}", "root_type": "${gdEscape(tree.type)}", "root_name": "${gdEscape(tree.name)}"})
\t_mcp_done()
`;
}

// ─── theme_create ──────────────────────────────────────────────────────────

export function genThemeCreateScript(
  scenePath: string,
  action: 'create' | 'extract',
  sourceNodePath?: string,
  savePath?: string,
): string {
  let actionBlock = '';

  if (action === 'create') {
    actionBlock = `
\tvar theme = Theme.new()`;
  } else {
    // extract
    if (!sourceNodePath) throw new Error('source_node_path is required for extract action');
    actionBlock = `
\tvar source = _mcp_get_scene_node("${gdEscape(sourceNodePath)}")
\tif source == null:
\t\t_mcp_output("error", "Source node not found: ${gdEscape(sourceNodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not source is Control:
\t\t_mcp_output("error", "Source node is not a Control: " + source.get_class())
\t\t_mcp_done()
\t\treturn
\tvar theme = source.theme
\tif theme == null:
\t\t_mcp_output("error", "Source node has no theme")
\t\t_mcp_done()
\t\treturn`;
  }

  let saveBlock = '';
  if (savePath) {
    saveBlock = `
\tvar dir = "${gdEscape(savePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar err = ResourceSaver.save(theme, "${gdEscape(savePath)}")
\tif err != OK:
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("saved", {"resource_path": "${gdEscape(savePath)}"})
\t_mcp_done()
\treturn`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn${actionBlock}${saveBlock}
\t_mcp_output("theme_created", {"action": "${action}"})
\t_mcp_done()
`;
}

// ─── theme_set_property ────────────────────────────────────────────────────

export function genThemeSetPropertyScript(
  projectPath: string,
  themeNodePath: string,
  itemType: 'default_font' | 'color' | 'constant' | 'stylebox',
  name: string,
  value: unknown,
  themeType?: string,
  scenePath?: string,
): string {
  const sceneLine = scenePath
    ? `\tif not _mcp_load_scene("${gdEscape(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n`
    : '';

  let setLine = '';
  const tt = themeType ? `"${gdEscape(themeType)}"` : '""';
  const safeName = gdEscape(name);

  switch (itemType) {
    case 'default_font': {
      const fontPath = String(value);
      if (fontPath.includes('/../') || fontPath.includes('/..') || fontPath.includes('\\')) {
        throw new Error('fontPath contains path traversal');
      }
      setLine = `\ttheme.set_default_font(load("${gdEscape(fontPath)}"))`;
      break;
    }
    case 'color': {
      const c = value as number[];
      if (!Array.isArray(c) || c.length < 3) throw new Error('Color value must be array [r, g, b] or [r, g, b, a]');
      const a = c.length >= 4 ? c[3] : 1.0;
      setLine = `\ttheme.set_color("${safeName}", ${tt}, Color(${c[0]}, ${c[1]}, ${c[2]}, ${a}))`;
      break;
    }
    case 'constant': {
      setLine = `\ttheme.set_constant("${safeName}", ${tt}, ${Number(value)})`;
      break;
    }
    case 'stylebox': {
      const sbPath = String(value);
      if (sbPath.includes('/../') || sbPath.includes('/..') || sbPath.includes('\\')) {
        throw new Error('stylebox path contains path traversal');
      }
      setLine = `\ttheme.set_stylebox("${safeName}", ${tt}, load("${gdEscape(sbPath)}"))`;
      break;
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
${sceneLine}\tvar node = _mcp_get_scene_node("${gdEscape(themeNodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(themeNodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn
\tif not theme is Theme:
\t\t_mcp_output("error", "Node.theme is not a Theme")
\t\t_mcp_done()
\t\treturn
${setLine}
\t_mcp_output("property_set", {"node": "${gdEscape(themeNodePath)}", "item_type": "${itemType}", "name": "${safeName}"})
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui_create_control',
      description: `Add a UI Control node to a scene. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'Control 子类类型',
          },
          node_name: { type: 'string', description: '新节点名称' },
          parent_node_path: { type: 'string', description: '父节点路径（默认 root）' },
          properties: {
            type: 'object',
            description: '可选属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_type', 'node_name'],
      },
    },
    {
      name: 'ui_set_layout',
      description: `Set layout properties (anchors, offsets, min size) on a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          anchors: {
            type: 'object',
            description: '锚点 {left, right, top, bottom}，值 0-1',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          offsets: {
            type: 'object',
            description: '边距 {left, right, top, bottom}，像素值',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          min_size: {
            type: 'object',
            description: '最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          custom_minimum_size: {
            type: 'object',
            description: '自定义最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          grow_direction: {
            type: 'string',
            enum: ['both', 'up', 'down', 'left', 'right'],
            description: '增长方向',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path'],
      },
    },
    {
      name: 'ui_get_layout',
      description: `Get layout info (anchors, offsets, position, size) of a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path'],
      },
    },
    {
      name: 'ui_anchor_preset',
      description: `Apply an anchor preset to a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          preset: {
            type: 'string',
            enum: Object.keys(ANCHOR_PRESETS),
            description: '锚点预设名称',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path', 'preset'],
      },
    },
    {
      name: 'ui_set_theme',
      description: `Set/create/save/load Theme on a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          action: {
            type: 'string',
            enum: ['set_params', 'create', 'save', 'load'],
            description: '操作类型：set_params 设置属性 | create 创建新 Theme | save 保存到 .tres | load 从 .tres 加载',
          },
          theme_path: { type: 'string', description: 'Theme 资源路径（save/load 时必填，res://themes/xxx.tres）' },
          params: {
            type: 'object',
            description: 'set_params 时的键值对（number/bool/string/array[4]→Color）',
            additionalProperties: true,
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path', 'action'],
      },
    },
    {
      name: 'ui_container_add',
      description: `Add a child Control node to a Container. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Container 节点路径' },
          child_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: '子节点 Control 类型',
          },
          child_name: { type: 'string', description: '子节点名称' },
          child_properties: {
            type: 'object',
            description: '子节点属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path', 'child_type', 'child_name'],
      },
    },
    {
      name: 'theme_create',
      description: `Create empty Theme or extract Theme from a node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: ['create', 'extract'],
            description: 'create 创建空 Theme | extract 从节点提取 Theme',
          },
          source_node_path: { type: 'string', description: '源节点路径（extract 时必填）' },
          scene_path: { type: 'string', description: 'Scene file path (res://...)' },
          save_path: { type: 'string', description: '可选，保存到 .tres 文件路径（res://themes/xxx.tres）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'action'],
      },
    },
    {
      name: 'theme_set_property',
      description: `Set Theme property (font, color, constant, stylebox). ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          theme_node_path: { type: 'string', description: '拥有 Theme 的节点路径' },
          item_type: {
            type: 'string',
            enum: ['default_font', 'color', 'constant', 'stylebox'],
            description: '属性类型',
          },
          name: { type: 'string', description: '属性名' },
          theme_type: { type: 'string', description: 'Theme 类型名（可选）' },
          value: {
            description: '属性值：default_font/stylebox 为资源路径字符串，color 为 [r,g,b,a] 数组，constant 为数字',
          },
          scene_path: { type: 'string', description: 'Scene path（可选，如提供则先加载场景）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'theme_node_path', 'item_type', 'name', 'value'],
      },
    },
    {
      name: 'ui_draw_recipe',
      description: `Attach declarative vector draw operations to a Control node via _draw(). Bypasses layout calculation. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          ops: {
            type: 'array',
            description: '绘图操作数组（最多 200 个）',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...DRAW_OP_KINDS], description: '操作类型' },
                position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
                size: { type: 'array', items: { type: 'number' }, description: '[w, h]' },
                center: { type: 'array', items: { type: 'number' }, description: '[x, y] 圆心' },
                radius: { type: 'number', description: '半径' },
                from: { type: 'array', items: { type: 'number' }, description: '[x, y] 起点' },
                to: { type: 'array', items: { type: 'number' }, description: '[x, y] 终点' },
                start_angle: { type: 'number', description: '起始角度（弧度）' },
                end_angle: { type: 'number', description: '结束角度（弧度）' },
                points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y], ...]' },
                text: { type: 'string', description: '文本' },
                color: { type: 'array', items: { type: 'number' }, description: '[r,g,b] 或 [r,g,b,a]，0-1' },
                width: { type: 'number', description: '线宽' },
                filled: { type: 'boolean', description: '是否填充（默认 true）' },
                font_size: { type: 'number', description: '字号（默认 16）' },
              },
              required: ['kind'],
            },
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path', 'ops'],
      },
    },
    {
      name: 'ui_build_layout',
      description: `Build a UI tree from a nested spec. ui_create_control is the single-node version; this supports recursive tree creation. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          parent_path: { type: 'string', description: '父节点路径' },
          tree: {
            type: 'object',
            description: 'UI 节点树（最大深度 10）',
            properties: {
              type: { type: 'string', enum: [...CONTROL_TYPES], description: 'Control 子类' },
              name: { type: 'string', description: '节点名称' },
              properties: { type: 'object', additionalProperties: true, description: '节点属性' },
              anchor_preset: { type: 'string', enum: Object.keys(ANCHOR_PRESETS), description: '锚点预设' },
              children: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '子节点' },
            },
            required: ['type', 'name'],
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'parent_path', 'tree'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (name) {
      case 'ui_create_control': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodeType = args.node_type as string;
        const nodeName = args.node_name as string;
        if (!CONTROL_TYPES.includes(nodeType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid node_type "${nodeType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        if (!nodeName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'node_name is required');
        }
        const parentPath = normalizeNodePath((args.parent_node_path as string) || 'root');
        const properties = args.properties as Record<string, unknown> | undefined;
        script = genUiCreateControlScript(scenePath, nodeType, nodeName, parentPath, properties);
        break;
      }
      case 'ui_set_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const anchors = args.anchors as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const offsets = args.offsets as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const minSize = args.min_size as { x?: number; y?: number } | undefined;
        const customMinSize = args.custom_minimum_size as { x?: number; y?: number } | undefined;
        const growDirection = args.grow_direction as string | undefined;
        script = genUiSetLayoutScript(scenePath, nodePath, anchors, offsets, minSize, customMinSize, growDirection);
        break;
      }
      case 'ui_get_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genUiGetLayoutScript(scenePath, nodePath);
        break;
      }
      case 'ui_anchor_preset': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const presetName = args.preset as string;
        if (!(presetName in ANCHOR_PRESETS)) {
          return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET,
            `Invalid preset "${presetName}". Must be one of: ${Object.keys(ANCHOR_PRESETS).join(', ')}`);
        }
        const presetValue = ANCHOR_PRESETS[presetName];
        script = genUiAnchorPresetScript(scenePath, nodePath, presetValue, presetName);
        break;
      }
      case 'ui_set_theme': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const action = args.action as string;
        if (!['set_params', 'create', 'save', 'load'].includes(action)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid action "${action}". Must be one of: set_params, create, save, load`);
        }
        const themePath = args.theme_path as string | undefined;
        if ((action === 'save' || action === 'load') && !themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `theme_path is required for ${action} action`);
        }
        if (themePath && (themePath.includes('/../') || themePath.includes('/..') || themePath.includes('\\'))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
        }
        const params = args.params as Record<string, unknown> | undefined;
        script = genUiSetThemeScript(scenePath, nodePath, action as 'set_params' | 'create' | 'save' | 'load', themePath, params);
        break;
      }
      case 'ui_container_add': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const childType = args.child_type as string;
        if (!CONTROL_TYPES.includes(childType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid child_type "${childType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        const childName = args.child_name as string;
        if (!childName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'child_name is required');
        }
        const childProperties = args.child_properties as Record<string, unknown> | undefined;
        script = genUiContainerAddScript(scenePath, nodePath, childType, childName, childProperties);
        break;
      }
      case 'theme_create': {
        const action = args.action as string;
        if (!['create', 'extract'].includes(action)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid action "${action}". Must be one of: create, extract`);
        }
        const sourceNodePath = args.source_node_path as string | undefined;
        const savePath = args.save_path as string | undefined;
        if (savePath && (savePath.includes('/../') || savePath.includes('/..') || savePath.includes('\\'))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'save_path contains path traversal');
        }
        if (action === 'extract' && !sourceNodePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'source_node_path is required for extract action');
        }
        // theme_create needs a scene context — use scene_path if provided, otherwise fallback
        const scenePath = args.scene_path as string | undefined;
        const resolvedScenePath = scenePath
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePath))
          : '';
        if (!resolvedScenePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'scene_path is required for theme_create');
        }
        const normalizedSourcePath = sourceNodePath ? normalizeNodePath(sourceNodePath) : undefined;
        script = genThemeCreateScript(resolvedScenePath, action as 'create' | 'extract', normalizedSourcePath, savePath);
        break;
      }
      case 'theme_set_property': {
        const themeNodePath = normalizeNodePath(args.theme_node_path as string);
        const itemType = args.item_type as string;
        if (!['default_font', 'color', 'constant', 'stylebox'].includes(itemType)) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_ITEM_TYPE,
            `Invalid item_type "${itemType}". Must be one of: default_font, color, constant, stylebox`);
        }
        const propName = args.name as string;
        if (!propName) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'name is required');
        }
        const value = args.value;
        if (value === undefined || value === null) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'value is required');
        }
        const themeType = args.theme_type as string | undefined;
        const scenePathParam = args.scene_path as string | undefined;
        const resolvedScenePath = scenePathParam
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePathParam))
          : undefined;
        script = genThemeSetPropertyScript(
          projectPath, themeNodePath,
          itemType as 'default_font' | 'color' | 'constant' | 'stylebox',
          propName, value, themeType, resolvedScenePath,
        );
        break;
      }
      case 'ui_draw_recipe': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const ops = args.ops as DrawOp[];
        if (!Array.isArray(ops)) {
          return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, 'ops must be an array');
        }
        try {
          script = genUiDrawRecipeScript(scenePath, nodePath, ops);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('Unknown draw op kind') || msg.includes('Maximum') || msg.includes('Color must be')) {
            return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_build_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const tree = args.tree as UiNodeSpec;
        if (!tree || typeof tree !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'tree is required and must be an object');
        }
        try {
          script = genUiBuildLayoutScript(scenePath, parentPath, tree);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('INVALID_CONTROL_TYPE')) {
            return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE, msg);
          }
          if (msg.includes('INVALID_ANCHOR_PRESET')) {
            return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET, msg);
          }
          if (msg.includes('name is required') || msg.includes('Maximum nesting')) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
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

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
      if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
      if (msg.includes('no theme')) return ERROR_CODES.THEME_NOT_FOUND;
      if (msg.includes('not a Theme')) return ERROR_CODES.THEME_NOT_FOUND;
      return ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ui_create_control: { readonly: false, long_running: false },
  ui_set_layout: { readonly: false, long_running: false },
  ui_get_layout: { readonly: true, long_running: false },
  ui_anchor_preset: { readonly: false, long_running: false },
  ui_set_theme: { readonly: false, long_running: false },
  ui_container_add: { readonly: false, long_running: false },
  theme_create: { readonly: false, long_running: false },
  theme_set_property: { readonly: false, long_running: false },
  ui_draw_recipe: { readonly: false, long_running: false },
  ui_build_layout: { readonly: false, long_running: false },
};

export { colorToGd };
