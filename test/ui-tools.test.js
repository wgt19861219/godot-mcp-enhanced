import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genUiCreateControlScript,
  genUiSetLayoutScript,
  genUiGetLayoutScript,
  genUiAnchorPresetScript,
  genUiSetThemeScript,
  genUiContainerAddScript,
  genUiDrawRecipeScript,
  genThemeCreateScript,
  genThemeSetPropertyScript,
  colorToGd,
} from '../build/tools/ui-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 8 UI tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 8);
  });
  it('includes ui_create_control', () => {
    assert.ok(TOOL_NAMES.includes('ui_create_control'));
  });
  it('includes ui_set_layout', () => {
    assert.ok(TOOL_NAMES.includes('ui_set_layout'));
  });
  it('includes ui_get_layout', () => {
    assert.ok(TOOL_NAMES.includes('ui_get_layout'));
  });
  it('includes ui_anchor_preset', () => {
    assert.ok(TOOL_NAMES.includes('ui_anchor_preset'));
  });
  it('includes ui_set_theme', () => {
    assert.ok(TOOL_NAMES.includes('ui_set_theme'));
  });
  it('includes ui_container_add', () => {
    assert.ok(TOOL_NAMES.includes('ui_container_add'));
  });
  it('includes theme_create', () => {
    assert.ok(TOOL_NAMES.includes('theme_create'));
  });
  it('includes theme_set_property', () => {
    assert.ok(TOOL_NAMES.includes('theme_set_property'));
  });
});

// ─── genUiCreateControlScript ───────────────────────────────────────────────

describe('genUiCreateControlScript', () => {
  it('generates GDScript that creates a Control node', () => {
    const script = genUiCreateControlScript('/path/to/scene.tscn', 'Button', 'MyButton', '/root');
    assert.ok(script.includes('Button.new()'));
    assert.ok(script.includes('node.name = "MyButton"'));
    assert.ok(script.includes('parent.add_child(node)'));
    assert.ok(script.includes('_mcp_load_scene'));
    assert.ok(script.includes('_mcp_get_scene_node'));
    assert.ok(script.includes('_mcp_output("created"'));
  });

  it('includes property assignments when provided', () => {
    const props = { text: 'Click Me', disabled: true, size: 42 };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    assert.ok(script.includes('node.set("text", "Click Me")'));
    assert.ok(script.includes('node.set("disabled", true)'));
    assert.ok(script.includes('node.set("size", 42)'));
  });

  it('handles null property value', () => {
    const props = { icon: null };
    const script = genUiCreateControlScript('/scene.tscn', 'Button', 'Btn', '/root', props);
    assert.ok(script.includes('node.set("icon", null)'));
  });

  it('escapes special characters in strings', () => {
    const props = { text: 'Hello "World"' };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    assert.ok(script.includes('node.set("text", "Hello \\"World\\"")'));
  });

  it('uses provided parent path', () => {
    const script = genUiCreateControlScript('/scene.tscn', 'Panel', 'MyPanel', '/root/UI');
    assert.ok(script.includes('_mcp_get_scene_node("/root/UI")'));
  });
});

// ─── genUiSetLayoutScript ───────────────────────────────────────────────────

describe('genUiSetLayoutScript', () => {
  it('generates GDScript that checks Control type', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/UI/Panel');
    assert.ok(script.includes('if not node is Control:'));
    assert.ok(script.includes('_mcp_output("layout_set"'));
  });

  it('includes anchor settings', () => {
    const anchors = { left: 0, right: 1, top: 0, bottom: 1 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', anchors);
    assert.ok(script.includes('node.anchor_left = 0'));
    assert.ok(script.includes('node.anchor_right = 1'));
    assert.ok(script.includes('node.anchor_top = 0'));
    assert.ok(script.includes('node.anchor_bottom = 1'));
  });

  it('includes offset settings', () => {
    const offsets = { left: 10, right: -10, top: 5, bottom: -5 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, offsets);
    assert.ok(script.includes('node.offset_left = 10'));
    assert.ok(script.includes('node.offset_right = -10'));
    assert.ok(script.includes('node.offset_top = 5'));
    assert.ok(script.includes('node.offset_bottom = -5'));
  });

  it('includes min_size settings', () => {
    const minSize = { x: 100, y: 50 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, minSize);
    assert.ok(script.includes('custom_minimum_size'));
    assert.ok(script.includes('100'));
    assert.ok(script.includes('50'));
  });

  it('includes custom_minimum_size settings', () => {
    const customMinSize = { x: 200, y: 100 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, customMinSize);
    assert.ok(script.includes('node.custom_minimum_size = Vector2(200, 100)'));
  });

  it('includes grow_direction', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, undefined, 'both');
    assert.ok(script.includes('Control.GROW_DIRECTION_BOTH'));
  });

  it('generates minimal script with no optional params', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel');
    assert.ok(script.includes('_mcp_load_scene'));
    assert.ok(script.includes('_mcp_get_scene_node("/root/Panel")'));
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genUiGetLayoutScript ───────────────────────────────────────────────────

describe('genUiGetLayoutScript', () => {
  it('generates GDScript that reads layout properties', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/UI/Button');
    assert.ok(script.includes('node.anchor_left'));
    assert.ok(script.includes('node.anchor_right'));
    assert.ok(script.includes('node.anchor_top'));
    assert.ok(script.includes('node.anchor_bottom'));
    assert.ok(script.includes('node.offset_left'));
    assert.ok(script.includes('node.offset_right'));
    assert.ok(script.includes('node.offset_top'));
    assert.ok(script.includes('node.offset_bottom'));
    assert.ok(script.includes('node.global_position'));
    assert.ok(script.includes('node.size'));
    assert.ok(script.includes('_mcp_output("layout"'));
  });

  it('checks Control type', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/Button');
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genUiAnchorPresetScript ────────────────────────────────────────────────

describe('genUiAnchorPresetScript', () => {
  it('generates GDScript that calls set_anchors_preset', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Panel', 15, 'full_rect');
    assert.ok(script.includes('node.set_anchors_preset(15)'));
    assert.ok(script.includes('_mcp_output("preset_applied"'));
    assert.ok(script.includes('"preset": "full_rect"'));
    assert.ok(script.includes('"value": 15'));
  });

  it('checks Control type', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    assert.ok(script.includes('if not node is Control:'));
  });

  it('uses correct preset value for top_left (0)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    assert.ok(script.includes('node.set_anchors_preset(0)'));
  });

  it('uses correct preset value for center (8)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 8, 'center');
    assert.ok(script.includes('node.set_anchors_preset(8)'));
  });
});

// ─── genUiSetThemeScript ────────────────────────────────────────────────────

describe('genUiSetThemeScript', () => {
  it('generates create action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    assert.ok(script.includes('Theme.new()'));
    assert.ok(script.includes('node.theme = theme'));
    assert.ok(script.includes('_mcp_output("theme_set"'));
  });

  it('generates set_params action script', () => {
    const params = { default_font_size: 16, font_color: [1, 0, 0, 1] };
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'set_params', undefined, params);
    assert.ok(script.includes('node.theme'));
    assert.ok(script.includes('theme.set("default_font_size", 16)'));
    assert.ok(script.includes('Color(1, 0, 0, 1)'));
  });

  it('generates save action script with ResourceSaver', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save', 'res://themes/my_theme.tres');
    assert.ok(script.includes('ResourceSaver.save'));
    assert.ok(script.includes('res://themes/my_theme.tres'));
    assert.ok(script.includes('_mcp_output("saved"'));
  });

  it('generates load action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load', 'res://themes/my_theme.tres');
    assert.ok(script.includes('load("res://themes/my_theme.tres")'));
    assert.ok(script.includes('node.theme = res'));
    assert.ok(script.includes('_mcp_output("loaded"'));
  });

  it('throws for save without theme_path', () => {
    assert.throws(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save'), /theme_path is required/);
  });

  it('throws for load without theme_path', () => {
    assert.throws(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load'), /theme_path is required/);
  });

  it('checks Control type', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genUiContainerAddScript ────────────────────────────────────────────────

describe('genUiContainerAddScript', () => {
  it('generates GDScript that adds child to container', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/VBox', 'Button', 'MyBtn');
    assert.ok(script.includes('Button.new()'));
    assert.ok(script.includes('child.name = "MyBtn"'));
    assert.ok(script.includes('container.add_child(child)'));
    assert.ok(script.includes('child.owner ='));
    assert.ok(script.includes('_mcp_output("child_added"'));
  });

  it('includes child properties when provided', () => {
    const props = { text: 'Hello', disabled: true };
    const script = genUiContainerAddScript('/scene.tscn', '/root/HBox', 'Label', 'Lbl', props);
    assert.ok(script.includes('child.set("text", "Hello")'));
    assert.ok(script.includes('child.set("disabled", true)'));
  });

  it('handles node path correctly', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/UI/VBox', 'Panel', 'MyPanel');
    assert.ok(script.includes('_mcp_get_scene_node("/root/UI/VBox")'));
  });
});

// ─── genUiDrawRecipeScript ─────────────────────────────────────────────────

describe('genUiDrawRecipeScript', () => {
  it('generates rect draw op', () => {
    const ops = [{ kind: 'rect', position: [10, 20], size: [100, 50], color: [1, 0, 0, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_rect'));
    assert.ok(script.includes('Rect2(10, 20, 100, 50)'));
    assert.ok(script.includes('Color(1, 0, 0, 1)'));
    assert.ok(script.includes('_mcp_load_scene'));
    assert.ok(script.includes('_mcp_output("draw_recipe_attached"'));
  });

  it('generates circle draw op', () => {
    const ops = [{ kind: 'circle', center: [50, 50], radius: 30, color: [0, 1, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Circle', ops);
    assert.ok(script.includes('draw_circle'));
    assert.ok(script.includes('Vector2(50, 50)'));
    assert.ok(script.includes('Color(0, 1, 0, 1)'));
  });

  it('generates line draw op', () => {
    const ops = [{ kind: 'line', from: [0, 0], to: [100, 100], color: [0, 0, 1, 0.8], width: 2 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_line'));
    assert.ok(script.includes('Vector2(0, 0)'));
    assert.ok(script.includes('Vector2(100, 100)'));
    assert.ok(script.includes('Color(0, 0, 1, 0.8)'));
    assert.ok(script.includes(', 2)'));
  });

  it('generates arc draw op', () => {
    const ops = [{ kind: 'arc', center: [50, 50], radius: 25, start_angle: 0, end_angle: 3.14, color: [1, 1, 0, 1], width: 1.5 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_arc'));
    assert.ok(script.includes('25'));
    assert.ok(script.includes('3.14'));
    assert.ok(script.includes('Color(1, 1, 0, 1)'));
    assert.ok(script.includes(', 1.5)'));
  });

  it('generates polygon draw op (filled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [0.5, 0.5, 0.5], filled: true }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_colored_polygon'));
    assert.ok(script.includes('PackedVector2Array'));
    assert.ok(script.includes('Color(0.5, 0.5, 0.5, 1)'));
  });

  it('generates polygon draw op (unfilled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [1, 0, 0], filled: false }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_polyline'));
    assert.ok(script.includes('PackedVector2Array'));
  });

  it('generates polyline draw op', () => {
    const ops = [{ kind: 'polyline', points: [[10, 10], [20, 30], [30, 10]], color: [1, 1, 1, 1], width: 3 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_polyline'));
    assert.ok(script.includes('PackedVector2Array'));
    assert.ok(script.includes(', 3)'));
  });

  it('generates string draw op', () => {
    const ops = [{ kind: 'string', text: 'Hello World', position: [10, 30], color: [1, 1, 1, 1], font_size: 24 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_string'));
    assert.ok(script.includes('"Hello World"'));
    assert.ok(script.includes('Vector2(10, 30)'));
    assert.ok(script.includes('24'));
    assert.ok(script.includes('ThemeDB.fallback_font'));
  });

  it('generates string draw op with default font_size', () => {
    const ops = [{ kind: 'string', text: 'Test', position: [0, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_string'));
    assert.ok(script.includes('16'));
  });

  it('generates multiple ops in sequence', () => {
    const ops = [
      { kind: 'rect', position: [0, 0], size: [200, 100], color: [0, 0, 0, 1] },
      { kind: 'line', from: [0, 0], to: [200, 100], color: [1, 1, 1, 1] },
    ];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('draw_rect'));
    assert.ok(script.includes('draw_line'));
  });

  it('throws for unknown kind', () => {
    assert.throws(
      () => genUiDrawRecipeScript('/scene.tscn', 'root/Panel', [{ kind: 'unknown' }]),
      /Unknown draw op kind/,
    );
  });

  it('throws for ops exceeding max limit', () => {
    const ops = Array(201).fill({ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] });
    assert.throws(
      () => genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops),
      /Maximum 200 draw ops/,
    );
  });

  it('handles empty ops array', () => {
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', []);
    assert.ok(script.includes('_mcp_output("draw_recipe_attached"'));
    assert.ok(script.includes('"ops_count": 0'));
  });

  it('validates node is Control', () => {
    const ops = [{ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genThemeCreateScript ───────────────────────────────────────────────────

describe('genThemeCreateScript', () => {
  it('generates create action script', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create');
    assert.ok(script.includes('Theme.new()'));
    assert.ok(script.includes('_mcp_output("theme_created"'));
    assert.ok(script.includes('"action": "create"'));
  });

  it('generates extract action script with source node', () => {
    const script = genThemeCreateScript('/scene.tscn', 'extract', '/root/Panel');
    assert.ok(script.includes('_mcp_get_scene_node("/root/Panel")'));
    assert.ok(script.includes('source.theme'));
    assert.ok(script.includes('if not source is Control:'));
    assert.ok(script.includes('"action": "extract"'));
  });

  it('generates script with save_path', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create', undefined, 'res://themes/new.tres');
    assert.ok(script.includes('ResourceSaver.save'));
    assert.ok(script.includes('res://themes/new.tres'));
    assert.ok(script.includes('_mcp_output("saved"'));
  });

  it('throws for extract without source_node_path', () => {
    assert.throws(() => genThemeCreateScript('/scene.tscn', 'extract'), /source_node_path is required/);
  });
});

// ─── genThemeSetPropertyScript ──────────────────────────────────────────────

describe('genThemeSetPropertyScript', () => {
  it('generates default_font script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'default_font', 'font', 'res://font.ttf');
    assert.ok(script.includes('theme.set_default_font'));
    assert.ok(script.includes('load("res://font.ttf")'));
    assert.ok(script.includes('_mcp_output("property_set"'));
    assert.ok(script.includes('"item_type": "default_font"'));
  });

  it('generates color script with RGBA array', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'font_color', [1, 0.5, 0, 0.8], 'Button');
    assert.ok(script.includes('theme.set_color'));
    assert.ok(script.includes('Color(1, 0.5, 0, 0.8)'));
    assert.ok(script.includes('"Button"'));
    assert.ok(script.includes('"name": "font_color"'));
  });

  it('generates color script with RGB array (alpha defaults to 1)', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', [0.2, 0.3, 0.4]);
    assert.ok(script.includes('Color(0.2, 0.3, 0.4, 1)'));
  });

  it('generates constant script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'font_size', 16, 'Label');
    assert.ok(script.includes('theme.set_constant'));
    assert.ok(script.includes('"font_size"'));
    assert.ok(script.includes('16'));
    assert.ok(script.includes('"Label"'));
  });

  it('generates stylebox script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'stylebox', 'panel', 'res://styles/panel.tres', 'Button');
    assert.ok(script.includes('theme.set_stylebox'));
    assert.ok(script.includes('load("res://styles/panel.tres")'));
  });

  it('validates theme node exists', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4);
    assert.ok(script.includes('_mcp_get_scene_node'));
    assert.ok(script.includes('if theme == null:'));
    assert.ok(script.includes('if not theme is Theme:'));
  });

  it('throws for color with invalid value', () => {
    assert.throws(() => genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', 'not-array'), /array/);
  });

  it('includes scene loading when scene_path provided', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4, undefined, '/scene.tscn');
    assert.ok(script.includes('_mcp_load_scene("/scene.tscn")'));
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 8 tool definitions', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 8);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      assert.ok(names.includes(tn), `missing tool definition for ${tn}`);
    }
  });
  it('each definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      assert.ok(def.inputSchema, `${def.name} missing inputSchema`);
      assert.ok(def.inputSchema.required, `${def.name} missing required fields`);
    }
  });
  it('ui_create_control has node_type enum with all Control types', () => {
    const defs = getToolDefinitions();
    const createDef = defs.find(d => d.name === 'ui_create_control');
    assert.ok(createDef);
    const enumValues = createDef.inputSchema.properties.node_type.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 29);
    assert.ok(enumValues.includes('Button'));
    assert.ok(enumValues.includes('Label'));
    assert.ok(enumValues.includes('NinePatchRect'));
  });
  it('ui_anchor_preset has preset enum with all 16 presets', () => {
    const defs = getToolDefinitions();
    const anchorDef = defs.find(d => d.name === 'ui_anchor_preset');
    assert.ok(anchorDef);
    const enumValues = anchorDef.inputSchema.properties.preset.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 16);
    assert.ok(enumValues.includes('top_left'));
    assert.ok(enumValues.includes('full_rect'));
    assert.ok(enumValues.includes('center'));
  });
  it('ui_set_theme has action enum with 4 values', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_set_theme');
    assert.ok(def);
    const enumValues = def.inputSchema.properties.action.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 4);
    assert.ok(enumValues.includes('set_params'));
    assert.ok(enumValues.includes('create'));
    assert.ok(enumValues.includes('save'));
    assert.ok(enumValues.includes('load'));
  });
  it('ui_container_add has child_type enum with Control types', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_container_add');
    assert.ok(def);
    const enumValues = def.inputSchema.properties.child_type.enum;
    assert.ok(enumValues);
    assert.ok(enumValues.includes('Button'));
    assert.ok(enumValues.includes('Label'));
  });
  it('theme_create has action enum with create and extract', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'theme_create');
    assert.ok(def);
    const enumValues = def.inputSchema.properties.action.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 2);
    assert.ok(enumValues.includes('create'));
    assert.ok(enumValues.includes('extract'));
  });
  it('theme_set_property has item_type enum with 4 values', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'theme_set_property');
    assert.ok(def);
    const enumValues = def.inputSchema.properties.item_type.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 4);
    assert.ok(enumValues.includes('default_font'));
    assert.ok(enumValues.includes('color'));
    assert.ok(enumValues.includes('constant'));
    assert.ok(enumValues.includes('stylebox'));
  });
});

// ─── colorToGd ──────────────────────────────────────────────────────────────

describe('colorToGd', () => {
  it('converts [r,g,b] to Color(r,g,b,1)', () => {
    assert.strictEqual(colorToGd([0.5, 0.8, 1.0]), 'Color(0.5, 0.8, 1, 1)');
  });
  it('converts [r,g,b,a] to Color(r,g,b,a)', () => {
    assert.strictEqual(colorToGd([1, 0, 0, 0.5]), 'Color(1, 0, 0, 0.5)');
  });
  it('throws for array shorter than 3', () => {
    assert.throws(() => colorToGd([0.5, 0.8]), /Color must be \[r, g, b\] or \[r, g, b, a\]/);
  });
  it('throws for non-array input', () => {
    assert.throws(() => colorToGd('red'), /Color must be \[r, g, b\] or \[r, g, b, a\]/);
  });
});
