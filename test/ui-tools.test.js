import { expect } from 'vitest';
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
  genUiBuildLayoutScript,
  genThemeCreateScript,
  genThemeSetPropertyScript,
  colorToGd,
} from '../build/tools/ui-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 10 UI tool names', () => {
    expect(TOOL_NAMES.length).toBe(10);
  });
  it('includes ui_create_control', () => {
    expect(TOOL_NAMES.includes('ui_create_control')).toBeTruthy();
  });
  it('includes ui_set_layout', () => {
    expect(TOOL_NAMES.includes('ui_set_layout')).toBeTruthy();
  });
  it('includes ui_get_layout', () => {
    expect(TOOL_NAMES.includes('ui_get_layout')).toBeTruthy();
  });
  it('includes ui_anchor_preset', () => {
    expect(TOOL_NAMES.includes('ui_anchor_preset')).toBeTruthy();
  });
  it('includes ui_set_theme', () => {
    expect(TOOL_NAMES.includes('ui_set_theme')).toBeTruthy();
  });
  it('includes ui_container_add', () => {
    expect(TOOL_NAMES.includes('ui_container_add')).toBeTruthy();
  });
  it('includes theme_create', () => {
    expect(TOOL_NAMES.includes('theme_create')).toBeTruthy();
  });
  it('includes theme_set_property', () => {
    expect(TOOL_NAMES.includes('theme_set_property')).toBeTruthy();
  });
  it('includes ui_draw_recipe', () => {
    expect(TOOL_NAMES.includes('ui_draw_recipe')).toBeTruthy();
  });
  it('includes ui_build_layout', () => {
    expect(TOOL_NAMES.includes('ui_build_layout')).toBeTruthy();
  });
});

// ─── genUiCreateControlScript ───────────────────────────────────────────────

describe('genUiCreateControlScript', () => {
  it('generates GDScript that creates a Control node', () => {
    const script = genUiCreateControlScript('/path/to/scene.tscn', 'Button', 'MyButton', '/root');
    expect(script.includes('ClassDB.instantiate("Button")')).toBeTruthy();
    expect(script.includes('node.name = "MyButton"')).toBeTruthy();
    expect(script.includes('parent.add_child(node)')).toBeTruthy();
    expect(script.includes('_mcp_load_scene')).toBeTruthy();
    expect(script.includes('_mcp_get_scene_node')).toBeTruthy();
    expect(script.includes('_mcp_output("created"')).toBeTruthy();
  });

  it('includes property assignments when provided', () => {
    const props = { text: 'Click Me', disabled: true, size: 42 };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    expect(script.includes('node.set("text", "Click Me")')).toBeTruthy();
    expect(script.includes('node.set("disabled", true)')).toBeTruthy();
    expect(script.includes('node.set("size", 42)')).toBeTruthy();
  });

  it('handles null property value', () => {
    const props = { icon: null };
    const script = genUiCreateControlScript('/scene.tscn', 'Button', 'Btn', '/root', props);
    expect(script.includes('node.set("icon", null)')).toBeTruthy();
  });

  it('escapes special characters in strings', () => {
    const props = { text: 'Hello "World"' };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    expect(script.includes('node.set("text", "Hello \\"World\\"")')).toBeTruthy();
  });

  it('uses provided parent path', () => {
    const script = genUiCreateControlScript('/scene.tscn', 'Panel', 'MyPanel', '/root/UI');
    expect(script.includes('_mcp_get_scene_node("/root/UI")')).toBeTruthy();
  });
});

// ─── genUiSetLayoutScript ───────────────────────────────────────────────────

describe('genUiSetLayoutScript', () => {
  it('generates GDScript that checks Control type', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/UI/Panel');
    expect(script.includes('if not node is Control:')).toBeTruthy();
    expect(script.includes('_mcp_output("layout_set"')).toBeTruthy();
  });

  it('includes anchor settings', () => {
    const anchors = { left: 0, right: 1, top: 0, bottom: 1 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', anchors);
    expect(script.includes('node.anchor_left = 0')).toBeTruthy();
    expect(script.includes('node.anchor_right = 1')).toBeTruthy();
    expect(script.includes('node.anchor_top = 0')).toBeTruthy();
    expect(script.includes('node.anchor_bottom = 1')).toBeTruthy();
  });

  it('includes offset settings', () => {
    const offsets = { left: 10, right: -10, top: 5, bottom: -5 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, offsets);
    expect(script.includes('node.offset_left = 10')).toBeTruthy();
    expect(script.includes('node.offset_right = -10')).toBeTruthy();
    expect(script.includes('node.offset_top = 5')).toBeTruthy();
    expect(script.includes('node.offset_bottom = -5')).toBeTruthy();
  });

  it('includes min_size settings', () => {
    const minSize = { x: 100, y: 50 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, minSize);
    expect(script.includes('custom_minimum_size')).toBeTruthy();
    expect(script.includes('100')).toBeTruthy();
    expect(script.includes('50')).toBeTruthy();
  });

  it('includes custom_minimum_size settings', () => {
    const customMinSize = { x: 200, y: 100 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, customMinSize);
    expect(script.includes('node.custom_minimum_size = Vector2(200, 100)')).toBeTruthy();
  });

  it('includes grow_direction', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, undefined, 'both');
    expect(script.includes('Control.GROW_DIRECTION_BOTH')).toBeTruthy();
  });

  it('generates minimal script with no optional params', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel');
    expect(script.includes('_mcp_load_scene')).toBeTruthy();
    expect(script.includes('_mcp_get_scene_node("/root/Panel")')).toBeTruthy();
    expect(script.includes('if not node is Control:')).toBeTruthy();
  });
});

// ─── genUiGetLayoutScript ───────────────────────────────────────────────────

describe('genUiGetLayoutScript', () => {
  it('generates GDScript that reads layout properties', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/UI/Button');
    expect(script.includes('node.anchor_left')).toBeTruthy();
    expect(script.includes('node.anchor_right')).toBeTruthy();
    expect(script.includes('node.anchor_top')).toBeTruthy();
    expect(script.includes('node.anchor_bottom')).toBeTruthy();
    expect(script.includes('node.offset_left')).toBeTruthy();
    expect(script.includes('node.offset_right')).toBeTruthy();
    expect(script.includes('node.offset_top')).toBeTruthy();
    expect(script.includes('node.offset_bottom')).toBeTruthy();
    expect(script.includes('node.global_position')).toBeTruthy();
    expect(script.includes('node.size')).toBeTruthy();
    expect(script.includes('_mcp_output("layout"')).toBeTruthy();
  });

  it('checks Control type', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/Button');
    expect(script.includes('if not node is Control:')).toBeTruthy();
  });
});

// ─── genUiAnchorPresetScript ────────────────────────────────────────────────

describe('genUiAnchorPresetScript', () => {
  it('generates GDScript that calls set_anchors_preset', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Panel', 15, 'full_rect');
    expect(script.includes('node.set_anchors_preset(15)')).toBeTruthy();
    expect(script.includes('_mcp_output("preset_applied"')).toBeTruthy();
    expect(script.includes('"preset": "full_rect"')).toBeTruthy();
    expect(script.includes('"value": 15')).toBeTruthy();
  });

  it('checks Control type', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    expect(script.includes('if not node is Control:')).toBeTruthy();
  });

  it('uses correct preset value for top_left (0)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    expect(script.includes('node.set_anchors_preset(0)')).toBeTruthy();
  });

  it('uses correct preset value for center (8)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 8, 'center');
    expect(script.includes('node.set_anchors_preset(8)')).toBeTruthy();
  });
});

// ─── genUiSetThemeScript ────────────────────────────────────────────────────

describe('genUiSetThemeScript', () => {
  it('generates create action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    expect(script.includes('Theme.new()')).toBeTruthy();
    expect(script.includes('node.theme = theme')).toBeTruthy();
    expect(script.includes('_mcp_output("theme_set"')).toBeTruthy();
  });

  it('generates set_params action script', () => {
    const params = { default_font_size: 16, font_color: [1, 0, 0, 1] };
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'set_params', undefined, params);
    expect(script.includes('node.theme')).toBeTruthy();
    expect(script.includes('theme.set("default_font_size", 16)')).toBeTruthy();
    expect(script.includes('Color(1, 0, 0, 1)')).toBeTruthy();
  });

  it('generates save action script with ResourceSaver', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save', 'res://themes/my_theme.tres');
    expect(script.includes('ResourceSaver.save')).toBeTruthy();
    expect(script.includes('res://themes/my_theme.tres')).toBeTruthy();
    expect(script.includes('_mcp_output("saved"')).toBeTruthy();
  });

  it('generates load action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load', 'res://themes/my_theme.tres');
    expect(script.includes('load("res://themes/my_theme.tres")')).toBeTruthy();
    expect(script.includes('node.theme = res')).toBeTruthy();
    expect(script.includes('_mcp_output("loaded"')).toBeTruthy();
  });

  it('throws for save without theme_path', () => {
    expect(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save')).toThrow(/theme_path is required/);
  });

  it('throws for load without theme_path', () => {
    expect(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load')).toThrow(/theme_path is required/);
  });

  it('checks Control type', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    expect(script.includes('if not node is Control:')).toBeTruthy();
  });
});

// ─── genUiContainerAddScript ────────────────────────────────────────────────

describe('genUiContainerAddScript', () => {
  it('generates GDScript that adds child to container', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/VBox', 'Button', 'MyBtn');
    expect(script.includes('ClassDB.instantiate("Button")')).toBeTruthy();
    expect(script.includes('child.name = "MyBtn"')).toBeTruthy();
    expect(script.includes('container.add_child(child)')).toBeTruthy();
    expect(script.includes('child.owner =')).toBeTruthy();
    expect(script.includes('_mcp_output("child_added"')).toBeTruthy();
  });

  it('includes child properties when provided', () => {
    const props = { text: 'Hello', disabled: true };
    const script = genUiContainerAddScript('/scene.tscn', '/root/HBox', 'Label', 'Lbl', props);
    expect(script.includes('child.set("text", "Hello")')).toBeTruthy();
    expect(script.includes('child.set("disabled", true)')).toBeTruthy();
  });

  it('handles node path correctly', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/UI/VBox', 'Panel', 'MyPanel');
    expect(script.includes('_mcp_get_scene_node("/root/UI/VBox")')).toBeTruthy();
  });
});

// ─── genUiDrawRecipeScript ─────────────────────────────────────────────────

describe('genUiDrawRecipeScript', () => {
  it('generates rect draw op', () => {
    const ops = [{ kind: 'rect', position: [10, 20], size: [100, 50], color: [1, 0, 0, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_rect')).toBeTruthy();
    expect(script.includes('Rect2(10, 20, 100, 50)')).toBeTruthy();
    expect(script.includes('Color(1, 0, 0, 1)')).toBeTruthy();
    expect(script.includes('_mcp_load_scene')).toBeTruthy();
    expect(script.includes('_mcp_output("draw_recipe_attached"')).toBeTruthy();
  });

  it('generates circle draw op', () => {
    const ops = [{ kind: 'circle', center: [50, 50], radius: 30, color: [0, 1, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Circle', ops);
    expect(script.includes('draw_circle')).toBeTruthy();
    expect(script.includes('Vector2(50, 50)')).toBeTruthy();
    expect(script.includes('Color(0, 1, 0, 1)')).toBeTruthy();
  });

  it('generates line draw op', () => {
    const ops = [{ kind: 'line', from: [0, 0], to: [100, 100], color: [0, 0, 1, 0.8], width: 2 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_line')).toBeTruthy();
    expect(script.includes('Vector2(0, 0)')).toBeTruthy();
    expect(script.includes('Vector2(100, 100)')).toBeTruthy();
    expect(script.includes('Color(0, 0, 1, 0.8)')).toBeTruthy();
    expect(script.includes(', 2)')).toBeTruthy();
  });

  it('generates arc draw op', () => {
    const ops = [{ kind: 'arc', center: [50, 50], radius: 25, start_angle: 0, end_angle: 3.14, color: [1, 1, 0, 1], width: 1.5 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_arc')).toBeTruthy();
    expect(script.includes('25')).toBeTruthy();
    expect(script.includes('3.14')).toBeTruthy();
    expect(script.includes('Color(1, 1, 0, 1)')).toBeTruthy();
    expect(script.includes(', 1.5)')).toBeTruthy();
  });

  it('generates polygon draw op (filled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [0.5, 0.5, 0.5], filled: true }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_colored_polygon')).toBeTruthy();
    expect(script.includes('PackedVector2Array')).toBeTruthy();
    expect(script.includes('Color(0.5, 0.5, 0.5, 1)')).toBeTruthy();
  });

  it('generates polygon draw op (unfilled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [1, 0, 0], filled: false }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_polyline')).toBeTruthy();
    expect(script.includes('PackedVector2Array')).toBeTruthy();
  });

  it('generates polyline draw op', () => {
    const ops = [{ kind: 'polyline', points: [[10, 10], [20, 30], [30, 10]], color: [1, 1, 1, 1], width: 3 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_polyline')).toBeTruthy();
    expect(script.includes('PackedVector2Array')).toBeTruthy();
    expect(script.includes(', 3)')).toBeTruthy();
  });

  it('generates string draw op', () => {
    const ops = [{ kind: 'string', text: 'Hello World', position: [10, 30], color: [1, 1, 1, 1], font_size: 24 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_string')).toBeTruthy();
    expect(script.includes('"Hello World"')).toBeTruthy();
    expect(script.includes('Vector2(10, 30)')).toBeTruthy();
    expect(script.includes('24')).toBeTruthy();
    expect(script.includes('ThemeDB.fallback_font')).toBeTruthy();
  });

  it('generates string draw op with default font_size', () => {
    const ops = [{ kind: 'string', text: 'Test', position: [0, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_string')).toBeTruthy();
    expect(script.includes('16')).toBeTruthy();
  });

  it('generates multiple ops in sequence', () => {
    const ops = [
      { kind: 'rect', position: [0, 0], size: [200, 100], color: [0, 0, 0, 1] },
      { kind: 'line', from: [0, 0], to: [200, 100], color: [1, 1, 1, 1] },
    ];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('draw_rect')).toBeTruthy();
    expect(script.includes('draw_line')).toBeTruthy();
  });

  it('throws for unknown kind', () => {
    expect(() => genUiDrawRecipeScript('/scene.tscn', 'root/Panel', [{ kind: 'unknown' }])).toThrow(/Unknown draw op kind/);
  });

  it('throws for ops exceeding max limit', () => {
    const ops = Array(201).fill({ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] });
    expect(() => genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops)).toThrow(/Maximum 200 draw ops/);
  });

  it('handles empty ops array', () => {
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', []);
    expect(script.includes('_mcp_output("draw_recipe_attached"')).toBeTruthy();
    expect(script.includes('"ops_count": 0')).toBeTruthy();
  });

  it('validates node is Control', () => {
    const ops = [{ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script.includes('if not node is Control:')).toBeTruthy();
  });
});

// ─── genUiBuildLayoutScript ────────────────────────────────────────────────

describe('genUiBuildLayoutScript', () => {
  it('generates single node creation', () => {
    const tree = { type: 'Button', name: 'MyButton' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("Button")')).toBeTruthy();
    expect(script.includes('node.name = "MyButton"')).toBeTruthy();
    expect(script.includes('parent.add_child(node)')).toBeTruthy();
    expect(script.includes('_mcp_output("layout_built"')).toBeTruthy();
  });

  it('generates nested children', () => {
    const tree = {
      type: 'VBoxContainer', name: 'VBox',
      children: [
        { type: 'Button', name: 'Btn1' },
        { type: 'Label', name: 'Lbl1' },
      ],
    };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VBoxContainer")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("Button")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("Label")')).toBeTruthy();
    expect(script.includes('node.name = "Btn1"')).toBeTruthy();
    expect(script.includes('node.name = "Lbl1"')).toBeTruthy();
  });

  it('includes anchor_preset', () => {
    const tree = { type: 'Panel', name: 'Bg', anchor_preset: 'full_rect' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('set_anchors_preset(15)')).toBeTruthy();
  });

  it('includes properties', () => {
    const tree = { type: 'Label', name: 'Title', properties: { text: 'Hello' } };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('node.set("text", "Hello")')).toBeTruthy();
  });

  it('throws for type not in whitelist', () => {
    expect(() => genUiBuildLayoutScript('/scene.tscn', 'root', { type: 'Node3D', name: 'X' })).toThrow(/INVALID_CONTROL_TYPE/);
  });

  it('throws for empty name', () => {
    expect(() => genUiBuildLayoutScript('/scene.tscn', 'root', { type: 'Button', name: '' })).toThrow(/name is required/);
  });

  it('throws for unknown anchor_preset', () => {
    expect(() => genUiBuildLayoutScript('/scene.tscn', 'root', { type: 'Button', name: 'X', anchor_preset: 'invalid' })).toThrow(/INVALID_ANCHOR_PRESET/);
  });

  it('throws for recursion depth > 10', () => {
    let tree = { type: 'Panel', name: 'L0', children: [] };
    let current = tree;
    for (let i = 1; i <= 11; i++) {
      current.children = [{ type: 'Panel', name: `L${i}`, children: [] }];
      current = current.children[0];
    }
    expect(() => genUiBuildLayoutScript('/scene.tscn', 'root', tree)).toThrow(/Maximum nesting depth/);
  });

  it('allows depth exactly 10', () => {
    let tree = { type: 'Panel', name: 'L0', children: [] };
    let current = tree;
    for (let i = 1; i <= 9; i++) {
      current.children = [{ type: 'Panel', name: `L${i}`, children: [] }];
      current = current.children[0];
    }
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate')).toBeTruthy();
  });
});

// ─── genThemeCreateScript ───────────────────────────────────────────────────

describe('genThemeCreateScript', () => {
  it('generates create action script', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create');
    expect(script.includes('Theme.new()')).toBeTruthy();
    expect(script.includes('_mcp_output("theme_created"')).toBeTruthy();
    expect(script.includes('"action": "create"')).toBeTruthy();
  });

  it('generates extract action script with source node', () => {
    const script = genThemeCreateScript('/scene.tscn', 'extract', '/root/Panel');
    expect(script.includes('_mcp_get_scene_node("/root/Panel")')).toBeTruthy();
    expect(script.includes('source.theme')).toBeTruthy();
    expect(script.includes('if not source is Control:')).toBeTruthy();
    expect(script.includes('"action": "extract"')).toBeTruthy();
  });

  it('generates script with save_path', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create', undefined, 'res://themes/new.tres');
    expect(script.includes('ResourceSaver.save')).toBeTruthy();
    expect(script.includes('res://themes/new.tres')).toBeTruthy();
    expect(script.includes('_mcp_output("saved"')).toBeTruthy();
  });

  it('throws for extract without source_node_path', () => {
    expect(() => genThemeCreateScript('/scene.tscn', 'extract')).toThrow(/source_node_path is required/);
  });
});

// ─── genThemeSetPropertyScript ──────────────────────────────────────────────

describe('genThemeSetPropertyScript', () => {
  it('generates default_font script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'default_font', 'font', 'res://font.ttf');
    expect(script.includes('theme.set_default_font')).toBeTruthy();
    expect(script.includes('load("res://font.ttf")')).toBeTruthy();
    expect(script.includes('_mcp_output("property_set"')).toBeTruthy();
    expect(script.includes('"item_type": "default_font"')).toBeTruthy();
  });

  it('generates color script with RGBA array', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'font_color', [1, 0.5, 0, 0.8], 'Button');
    expect(script.includes('theme.set_color')).toBeTruthy();
    expect(script.includes('Color(1, 0.5, 0, 0.8)')).toBeTruthy();
    expect(script.includes('"Button"')).toBeTruthy();
    expect(script.includes('"name": "font_color"')).toBeTruthy();
  });

  it('generates color script with RGB array (alpha defaults to 1)', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', [0.2, 0.3, 0.4]);
    expect(script.includes('Color(0.2, 0.3, 0.4, 1)')).toBeTruthy();
  });

  it('generates constant script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'font_size', 16, 'Label');
    expect(script.includes('theme.set_constant')).toBeTruthy();
    expect(script.includes('"font_size"')).toBeTruthy();
    expect(script.includes('16')).toBeTruthy();
    expect(script.includes('"Label"')).toBeTruthy();
  });

  it('generates stylebox script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'stylebox', 'panel', 'res://styles/panel.tres', 'Button');
    expect(script.includes('theme.set_stylebox')).toBeTruthy();
    expect(script.includes('load("res://styles/panel.tres")')).toBeTruthy();
  });

  it('validates theme node exists', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4);
    expect(script.includes('_mcp_get_scene_node')).toBeTruthy();
    expect(script.includes('if theme == null:')).toBeTruthy();
    expect(script.includes('if not theme is Theme:')).toBeTruthy();
  });

  it('throws for color with invalid value', () => {
    expect(() => genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', 'not-array')).toThrow(/array/);
  });

  it('includes scene loading when scene_path provided', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4, undefined, '/scene.tscn');
    expect(script.includes('_mcp_load_scene("/scene.tscn")')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 10 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(10);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      expect(names.includes(tn)).toBeTruthy();
    }
  });
  it('each definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.required).toBeTruthy();
    }
  });
  it('ui_create_control has node_type enum with all Control types', () => {
    const defs = getToolDefinitions();
    const createDef = defs.find(d => d.name === 'ui_create_control');
    expect(createDef).toBeTruthy();
    const enumValues = createDef.inputSchema.properties.node_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(29);
    expect(enumValues.includes('Button')).toBeTruthy();
    expect(enumValues.includes('Label')).toBeTruthy();
    expect(enumValues.includes('NinePatchRect')).toBeTruthy();
  });
  it('ui_anchor_preset has preset enum with all 16 presets', () => {
    const defs = getToolDefinitions();
    const anchorDef = defs.find(d => d.name === 'ui_anchor_preset');
    expect(anchorDef).toBeTruthy();
    const enumValues = anchorDef.inputSchema.properties.preset.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(16);
    expect(enumValues.includes('top_left')).toBeTruthy();
    expect(enumValues.includes('full_rect')).toBeTruthy();
    expect(enumValues.includes('center')).toBeTruthy();
  });
  it('ui_set_theme has action enum with 4 values', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_set_theme');
    expect(def).toBeTruthy();
    const enumValues = def.inputSchema.properties.action.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(4);
    expect(enumValues.includes('set_params')).toBeTruthy();
    expect(enumValues.includes('create')).toBeTruthy();
    expect(enumValues.includes('save')).toBeTruthy();
    expect(enumValues.includes('load')).toBeTruthy();
  });
  it('ui_container_add has child_type enum with Control types', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_container_add');
    expect(def).toBeTruthy();
    const enumValues = def.inputSchema.properties.child_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.includes('Button')).toBeTruthy();
    expect(enumValues.includes('Label')).toBeTruthy();
  });
  it('theme_create has action enum with create and extract', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'theme_create');
    expect(def).toBeTruthy();
    const enumValues = def.inputSchema.properties.action.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(2);
    expect(enumValues.includes('create')).toBeTruthy();
    expect(enumValues.includes('extract')).toBeTruthy();
  });
  it('theme_set_property has item_type enum with 4 values', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'theme_set_property');
    expect(def).toBeTruthy();
    const enumValues = def.inputSchema.properties.item_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(4);
    expect(enumValues.includes('default_font')).toBeTruthy();
    expect(enumValues.includes('color')).toBeTruthy();
    expect(enumValues.includes('constant')).toBeTruthy();
    expect(enumValues.includes('stylebox')).toBeTruthy();
  });
  it('ui_draw_recipe has ops with kind enum', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_draw_recipe');
    expect(def).toBeTruthy();
    const kindEnum = def.inputSchema.properties.ops.items.properties.kind.enum;
    expect(kindEnum.length).toBe(7);
    expect(kindEnum.includes('rect')).toBeTruthy();
    expect(kindEnum.includes('string')).toBeTruthy();
  });
  it('ui_build_layout has tree with type enum', () => {
    const defs = getToolDefinitions();
    const def = defs.find(d => d.name === 'ui_build_layout');
    expect(def).toBeTruthy();
    const typeEnum = def.inputSchema.properties.tree.properties.type.enum;
    expect(typeEnum.includes('Button')).toBeTruthy();
    expect(typeEnum.includes('VBoxContainer')).toBeTruthy();
  });
});

// ─── colorToGd ──────────────────────────────────────────────────────────────

describe('colorToGd', () => {
  it('converts [r,g,b] to Color(r,g,b,1)', () => {
    expect(colorToGd([0.5, 0.8, 1.0])).toBe('Color(0.5, 0.8, 1, 1)');
  });
  it('converts [r,g,b,a] to Color(r,g,b,a)', () => {
    expect(colorToGd([1, 0, 0, 0.5])).toBe('Color(1, 0, 0, 0.5)');
  });
  it('throws for array shorter than 3', () => {
    expect(() => colorToGd([0.5, 0.8])).toThrow(/Color must be \[r, g, b\] or \[r, g, b, a\]/);
  });
  it('throws for non-array input', () => {
    expect(() => colorToGd('red')).toThrow(/Color must be \[r, g, b\] or \[r, g, b, a\]/);
  });
});

// ─── Flex Layout Translation ────────────────────────────────────────────────

describe('Flex Layout: direction', () => {
  it('direction: row → HBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'row' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("HBoxContainer")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("Panel")')).toBeFalsy();
  });

  it('direction: column → VBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VBoxContainer")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("Panel")')).toBeFalsy();
  });

  it('direction: row-reverse → HBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'row-reverse' },
      children: [
        { type: 'Button', name: 'A' },
        { type: 'Button', name: 'B' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("HBoxContainer")')).toBeTruthy();
    const idxB = script.indexOf('node.name = "B"');
    const idxA = script.indexOf('node.name = "A"');
    expect(idxB < idxA).toBeTruthy();
  });

  it('direction: column-reverse → VBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'column-reverse' },
      children: [
        { type: 'Label', name: 'X' },
        { type: 'Label', name: 'Y' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VBoxContainer")')).toBeTruthy();
    const idxY = script.indexOf('node.name = "Y"');
    const idxX = script.indexOf('node.name = "X"');
    expect(idxY < idxX).toBeTruthy();
  });
});

describe('Flex Layout: justify', () => {
  it('justify: center → alignment = 1', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'center' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('node.alignment = 1')).toBeTruthy();
  });

  it('justify: flex-start → alignment = 0', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-start' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('node.alignment = 0')).toBeTruthy();
  });

  it('justify: flex-end → alignment = 2', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-end' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('node.alignment = 2')).toBeTruthy();
  });

  it('justify: space-between → approximated with warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'space-between' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('node.alignment = 0')).toBeTruthy();
    expect(script.includes('approximated')).toBeTruthy();
  });
});

describe('Flex Layout: align', () => {
  it('align: stretch → SIZE_EXPAND_FILL on cross axis', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'stretch' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('SIZE_EXPAND_FILL')).toBeTruthy();
  });

  it('align: center → SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'center' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('SIZE_SHRINK_CENTER')).toBeTruthy();
  });
});

describe('Flex Layout: wrap', () => {
  it('wrap: wrap + row → HFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("HFlowContainer")')).toBeTruthy();
  });

  it('wrap: wrap + column → VFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VFlowContainer")')).toBeTruthy();
  });
});

describe('Flex Layout: gap', () => {
  it('BoxContainer gap → separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', gap: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('add_theme_constant_override("separation", 10)')).toBeTruthy();
  });

  it('HFlowContainer gap → h_separation + v_separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('add_theme_constant_override("h_separation", 8)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("v_separation", 8)')).toBeTruthy();
  });

  it('row_gap in wrap mode', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8, row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('add_theme_constant_override("h_separation", 8)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("v_separation", 5)')).toBeTruthy();
  });

  it('row_gap without wrap → warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('row_gap')).toBeTruthy();
  });
});

describe('Flex Layout: padding', () => {
  it('BoxContainer padding → theme override margin_*', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('add_theme_constant_override("margin_top", 10)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_right", 10)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_bottom", 10)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_left", 10)')).toBeTruthy();
    expect(script.includes('MarginContainer')).toBeFalsy();
  });

  it('BoxContainer padding array → individual margins', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: [1, 2, 3, 4] } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('add_theme_constant_override("margin_top", 1)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_right", 2)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_bottom", 3)')).toBeTruthy();
    expect(script.includes('add_theme_constant_override("margin_left", 4)')).toBeTruthy();
  });

  it('FlowContainer padding → MarginContainer wrapper', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', padding: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("MarginContainer")')).toBeTruthy();
    expect(script.includes('R_margin')).toBeTruthy();
  });
});

describe('Flex Layout: flex child properties', () => {
  it('flex.grow → stretch_ratio + SIZE_EXPAND', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { grow: 2 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('size_flags_stretch_ratio = 2')).toBeTruthy();
    expect(script.includes('SIZE_EXPAND')).toBeTruthy();
  });

  it('flex.align_self: center → SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { align_self: 'center' } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('SIZE_SHRINK_CENTER')).toBeTruthy();
  });

  it('flex.min_width → custom_minimum_size', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { min_width: 200 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('custom_minimum_size = Vector2(200')).toBeTruthy();
  });

  it('flex.shrink → warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { shrink: 1 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('shrink')).toBeTruthy();
  });

  it('flex.max_width → warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { max_width: 300 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('max_width')).toBeTruthy();
  });
});

describe('Flex Layout: backward compatibility', () => {
  it('no layout field → existing behavior unchanged', () => {
    const tree = { type: 'Button', name: 'MyButton' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("Button")')).toBeTruthy();
    expect(script.includes('node.name = "MyButton"')).toBeTruthy();
    expect(script.includes('HBoxContainer')).toBeFalsy();
    expect(script.includes('VBoxContainer')).toBeFalsy();
  });

  it('layout overrides type', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VBoxContainer")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("Panel")')).toBeFalsy();
  });

  it('nested layout: row inside column', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'column', gap: 10 },
      children: [
        {
          type: 'Panel', name: 'TopRow', layout: { direction: 'row', gap: 5 },
          children: [
            { type: 'Button', name: 'A' },
            { type: 'Button', name: 'B' },
          ],
        },
        { type: 'Label', name: 'Title' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('ClassDB.instantiate("VBoxContainer")')).toBeTruthy();
    expect(script.includes('ClassDB.instantiate("HBoxContainer")')).toBeTruthy();
    expect(script.includes('separation", 10)')).toBeTruthy();
    expect(script.includes('separation", 5)')).toBeTruthy();
  });
});

describe('Flex Layout: validation', () => {
  it('invalid direction → error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'diagonal' } })).toThrow(/INVALID_LAYOUT/);
  });

  it('negative gap → error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'row', gap: -1 } })).toThrow(/INVALID_LAYOUT/);
  });

  it('invalid padding format → error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'row', padding: 'big' } })).toThrow(/INVALID_LAYOUT/);
  });

  it('invalid align_self → error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', {
        type: 'Panel', name: 'R', layout: { direction: 'row' },
        children: [{ type: 'Button', name: 'B', flex: { align_self: 'middle' } }],
      })).toThrow(/INVALID_FLEX/);
  });
});
