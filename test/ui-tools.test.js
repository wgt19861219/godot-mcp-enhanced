import { expect } from 'vitest';
import {
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
  findBlockedProps,
  handleTool,
} from '../src/tools/ui-tools.js';

// ─── Actions (via schema) ─────────────────────────────────────────────────

describe('UI actions (via tool schema)', () => {
  it('action enum contains exactly 13 entries', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum.length).toBe(13);
  });
  it('includes ui_create_control', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_create_control');
  });
  it('includes ui_set_layout', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_set_layout');
  });
  it('includes ui_get_layout', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_get_layout');
  });
  it('includes ui_anchor_preset', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_anchor_preset');
  });
  it('includes ui_set_theme', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_set_theme');
  });
  it('includes ui_container_add', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_container_add');
  });
  it('includes theme_create', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('theme_create');
  });
  it('includes theme_set_property', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('theme_set_property');
  });
  it('includes ui_draw_recipe', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_draw_recipe');
  });
  it('includes ui_build_layout', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.properties.action.enum).toContain('ui_build_layout');
  });
});

// ─── genUiCreateControlScript ───────────────────────────────────────────────

describe('genUiCreateControlScript', () => {
  it('generates GDScript that creates a Control node', () => {
    const script = genUiCreateControlScript('/path/to/scene.tscn', 'Button', 'MyButton', '/root');
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('node.name = "MyButton"');
    expect(script).toContain('parent.add_child(node)');
    expect(script).toContain('_mcp_load_scene');
    expect(script).toContain('_mcp_get_scene_node');
    expect(script).toContain('_mcp_output("created"');
  });

  it('includes property assignments when provided', () => {
    const props = { text: 'Click Me', disabled: true, size: 42 };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    expect(script).toContain('node.set("text", "Click Me")');
    expect(script).toContain('node.set("disabled", true)');
    expect(script).toContain('node.set("size", 42)');
  });

  it('handles null property value', () => {
    const props = { icon: null };
    const script = genUiCreateControlScript('/scene.tscn', 'Button', 'Btn', '/root', props);
    expect(script).toContain('node.set("icon", null)');
  });

  it('escapes special characters in strings', () => {
    const props = { text: 'Hello "World"' };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    expect(script).toContain('node.set("text", "Hello \\"World\\"")');
  });

  it('uses provided parent path', () => {
    const script = genUiCreateControlScript('/scene.tscn', 'Panel', 'MyPanel', '/root/UI');
    expect(script).toContain('_mcp_get_scene_node("/root/UI")');
  });
});

// ─── genUiSetLayoutScript ───────────────────────────────────────────────────

describe('genUiSetLayoutScript', () => {
  it('generates GDScript that checks Control type', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/UI/Panel');
    expect(script).toContain('if not node is Control:');
    expect(script).toContain('_mcp_output("layout_set"');
  });

  it('includes anchor settings', () => {
    const anchors = { left: 0, right: 1, top: 0, bottom: 1 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', anchors);
    expect(script).toContain('node.anchor_left = 0');
    expect(script).toContain('node.anchor_right = 1');
    expect(script).toContain('node.anchor_top = 0');
    expect(script).toContain('node.anchor_bottom = 1');
  });

  it('includes offset settings', () => {
    const offsets = { left: 10, right: -10, top: 5, bottom: -5 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, offsets);
    expect(script).toContain('node.offset_left = 10');
    expect(script).toContain('node.offset_right = -10');
    expect(script).toContain('node.offset_top = 5');
    expect(script).toContain('node.offset_bottom = -5');
  });

  it('includes min_size settings', () => {
    const minSize = { x: 100, y: 50 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, minSize);
    expect(script).toContain('custom_minimum_size');
    expect(script).toContain('100');
    expect(script).toContain('50');
  });

  it('includes custom_minimum_size settings', () => {
    const customMinSize = { x: 200, y: 100 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, customMinSize);
    expect(script).toContain('node.custom_minimum_size = Vector2(200, 100)');
  });

  it('includes grow_direction', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, undefined, 'both');
    expect(script).toContain('Control.GROW_DIRECTION_BOTH');
  });

  it('generates minimal script with no optional params', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel');
    expect(script).toContain('_mcp_load_scene');
    expect(script).toContain('_mcp_get_scene_node("/root/Panel")');
    expect(script).toContain('if not node is Control:');
  });
});

// ─── genUiGetLayoutScript ───────────────────────────────────────────────────

describe('genUiGetLayoutScript', () => {
  it('generates GDScript that reads layout properties', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/UI/Button');
    expect(script).toContain('node.anchor_left');
    expect(script).toContain('node.anchor_right');
    expect(script).toContain('node.anchor_top');
    expect(script).toContain('node.anchor_bottom');
    expect(script).toContain('node.offset_left');
    expect(script).toContain('node.offset_right');
    expect(script).toContain('node.offset_top');
    expect(script).toContain('node.offset_bottom');
    expect(script).toContain('node.global_position');
    expect(script).toContain('node.size');
    expect(script).toContain('_mcp_output("layout"');
  });

  it('checks Control type', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/Button');
    expect(script).toContain('if not node is Control:');
  });
});

// ─── genUiAnchorPresetScript ────────────────────────────────────────────────

describe('genUiAnchorPresetScript', () => {
  it('generates GDScript that calls set_anchors_preset', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Panel', 15, 'full_rect');
    expect(script).toContain('node.set_anchors_preset(15)');
    expect(script).toContain('_mcp_output("preset_applied"');
    expect(script).toContain('"preset": "full_rect"');
    expect(script).toContain('"value": 15');
  });

  it('checks Control type', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    expect(script).toContain('if not node is Control:');
  });

  it('uses correct preset value for top_left (0)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    expect(script).toContain('node.set_anchors_preset(0)');
  });

  it('uses correct preset value for center (8)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 8, 'center');
    expect(script).toContain('node.set_anchors_preset(8)');
  });
});

// ─── genUiSetThemeScript ────────────────────────────────────────────────────

describe('genUiSetThemeScript', () => {
  it('generates create action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    expect(script).toContain('Theme.new()');
    expect(script).toContain('node.theme = theme');
    expect(script).toContain('_mcp_output("theme_set"');
  });

  it('generates set_params action script', () => {
    const params = { default_font_size: 16, font_color: [1, 0, 0, 1] };
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'set_params', undefined, params);
    expect(script).toContain('node.theme');
    expect(script).toContain('theme.set("default_font_size", 16)');
    expect(script).toContain('Color(1, 0, 0, 1)');
  });

  it('generates save action script with ResourceSaver', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save', 'res://themes/my_theme.tres');
    expect(script).toContain('ResourceSaver.save');
    expect(script).toContain('res://themes/my_theme.tres');
    expect(script).toContain('_mcp_output("saved"');
  });

  it('generates load action script', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load', 'res://themes/my_theme.tres');
    expect(script).toContain('load("res://themes/my_theme.tres")');
    expect(script).toContain('node.theme = res');
    expect(script).toContain('_mcp_output("loaded"');
  });

  it('T2b (debt-cleanup-20260818): save themePath 含 % 不双写——纯字面量内插走 escapeForGdLiteral', () => {
    // themePath 消费点全部为纯字符串字面量(get_base_dir/_full/_mcp_output 字典),
    // 不参与 % 格式化——gdEscape 会把 a%b 双写成 a%%b 导致含 % 的资源路径被静默改写。
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save', 'res://themes/a%b.tres');
    expect(script).toContain('var dir = "res://themes/a%b.tres".get_base_dir()');
    expect(script).toContain('var _full := "res://themes/a%b.tres"');
    // :90 outputValue(TS 字符串拼接进 _mcp_output 字典字面量)同为纯字面量
    expect(script).toContain('{"resource_path": "res://themes/a%b.tres"}');
    expect(script).not.toContain('a%%b');
  });

  it('T2b: load themePath 含 % 不双写', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load', 'res://themes/a%b.tres');
    expect(script).toContain('var res = load("res://themes/a%b.tres")');
    expect(script).toContain('Failed to load theme from: res://themes/a%b.tres');
    expect(script).not.toContain('a%%b');
  });

  it('throws for save without theme_path', () => {
    expect(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'save')).toThrow(/theme_path is required/);
  });

  it('throws for load without theme_path', () => {
    expect(() => genUiSetThemeScript('/scene.tscn', '/root/Panel', 'load')).toThrow(/theme_path is required/);
  });

  it('checks Control type', () => {
    const script = genUiSetThemeScript('/scene.tscn', '/root/Panel', 'create');
    expect(script).toContain('if not node is Control:');
  });
});

// ─── genUiContainerAddScript ────────────────────────────────────────────────

describe('genUiContainerAddScript', () => {
  it('generates GDScript that adds child to container', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/VBox', 'Button', 'MyBtn');
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('child.name = "MyBtn"');
    expect(script).toContain('container.add_child(child)');
    expect(script).toContain('child.owner =');
    expect(script).toContain('_mcp_output("child_added"');
  });

  it('includes child properties when provided', () => {
    const props = { text: 'Hello', disabled: true };
    const script = genUiContainerAddScript('/scene.tscn', '/root/HBox', 'Label', 'Lbl', props);
    expect(script).toContain('child.set("text", "Hello")');
    expect(script).toContain('child.set("disabled", true)');
  });

  it('handles node path correctly', () => {
    const script = genUiContainerAddScript('/scene.tscn', '/root/UI/VBox', 'Panel', 'MyPanel');
    expect(script).toContain('_mcp_get_scene_node("/root/UI/VBox")');
  });
});

// ─── genUiDrawRecipeScript ─────────────────────────────────────────────────

describe('genUiDrawRecipeScript', () => {
  it('generates rect draw op', () => {
    const ops = [{ kind: 'rect', position: [10, 20], size: [100, 50], color: [1, 0, 0, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_rect');
    expect(script).toContain('Rect2(10, 20, 100, 50)');
    expect(script).toContain('Color(1, 0, 0, 1)');
    expect(script).toContain('_mcp_load_scene');
    expect(script).toContain('_mcp_output("draw_recipe_attached"');
  });

  it('generates circle draw op', () => {
    const ops = [{ kind: 'circle', center: [50, 50], radius: 30, color: [0, 1, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Circle', ops);
    expect(script).toContain('draw_circle');
    expect(script).toContain('Vector2(50, 50)');
    expect(script).toContain('Color(0, 1, 0, 1)');
  });

  it('generates line draw op', () => {
    const ops = [{ kind: 'line', from: [0, 0], to: [100, 100], color: [0, 0, 1, 0.8], width: 2 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_line');
    expect(script).toContain('Vector2(0, 0)');
    expect(script).toContain('Vector2(100, 100)');
    expect(script).toContain('Color(0, 0, 1, 0.8)');
    expect(script).toContain(', 2)');
  });

  it('generates arc draw op', () => {
    const ops = [{ kind: 'arc', center: [50, 50], radius: 25, start_angle: 0, end_angle: 3.14, color: [1, 1, 0, 1], width: 1.5 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_arc');
    expect(script).toContain('25');
    expect(script).toContain('3.14');
    expect(script).toContain('Color(1, 1, 0, 1)');
    expect(script).toContain(', 1.5)');
  });

  it('generates polygon draw op (filled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [0.5, 0.5, 0.5], filled: true }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_colored_polygon');
    expect(script).toContain('PackedVector2Array');
    expect(script).toContain('Color(0.5, 0.5, 0.5, 1)');
  });

  it('generates polygon draw op (unfilled)', () => {
    const ops = [{ kind: 'polygon', points: [[0, 0], [100, 0], [50, 80]], color: [1, 0, 0], filled: false }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_polyline');
    expect(script).toContain('PackedVector2Array');
  });

  it('generates polyline draw op', () => {
    const ops = [{ kind: 'polyline', points: [[10, 10], [20, 30], [30, 10]], color: [1, 1, 1, 1], width: 3 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_polyline');
    expect(script).toContain('PackedVector2Array');
    expect(script).toContain(', 3)');
  });

  it('generates string draw op', () => {
    const ops = [{ kind: 'string', text: 'Hello World', position: [10, 30], color: [1, 1, 1, 1], font_size: 24 }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_string');
    expect(script).toContain('"Hello World"');
    expect(script).toContain('Vector2(10, 30)');
    expect(script).toContain('24');
    expect(script).toContain('ThemeDB.fallback_font');
  });

  it('generates string draw op with default font_size', () => {
    const ops = [{ kind: 'string', text: 'Test', position: [0, 0] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_string');
    expect(script).toContain('16');
  });

  it('generates string draw op with % text rendered as-is (literal escape, not doubled)', () => {
    // I-1d 回归:draw_string 渲染文本是纯字面量(非 % 格式串),"50%" 不应被双写成 "50%%"
    const ops = [{ kind: 'string', text: 'Progress: 50%', position: [10, 30], color: [1, 1, 1, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('"Progress: 50%"');
    expect(script).not.toContain('50%%');
  });

  it('generates multiple ops in sequence', () => {
    const ops = [
      { kind: 'rect', position: [0, 0], size: [200, 100], color: [0, 0, 0, 1] },
      { kind: 'line', from: [0, 0], to: [200, 100], color: [1, 1, 1, 1] },
    ];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('draw_rect');
    expect(script).toContain('draw_line');
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
    expect(script).toContain('_mcp_output("draw_recipe_attached"');
    expect(script).toContain('"ops_count": 0');
  });

  it('validates node is Control', () => {
    const ops = [{ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    expect(script).toContain('if not node is Control:');
  });

  // P2-6 (2026-08-06): draw_result 验证闭环——绘制后 await 一帧再读回,非 fire-and-forget
  it('P2-6: emits draw_result verification after awaiting one frame', () => {
    const ops = [{ kind: 'rect', position: [0, 0], size: [1, 1], color: [1, 1, 1] }];
    const script = genUiDrawRecipeScript('/scene.tscn', 'root/Panel', ops);
    // await process_frame 让 _draw 触发(参考 material-ops.ts:470 / navigation.ts:42 先例)
    expect(script).toContain('await process_frame');
    // draw_result 读回:确认 draw 信号仍连接 + 节点仍有效
    expect(script).toContain('_mcp_output("draw_result"');
    expect(script).toContain('draw_signal_connected');
    expect(script).toContain('is_instance_valid(node)');
    // 原 attach 确认保留(attach 在 await 前,result 在 await 后,语义分层)
    expect(script).toContain('_mcp_output("draw_recipe_attached"');
  });
});

// ─── genUiBuildLayoutScript ────────────────────────────────────────────────

describe('genUiBuildLayoutScript', () => {
  it('generates single node creation', () => {
    const tree = { type: 'Button', name: 'MyButton' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('node.name = "MyButton"');
    expect(script).toContain('parent.add_child(node)');
    expect(script).toContain('_mcp_output("layout_built"');
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
    expect(script).toContain('ClassDB.instantiate("VBoxContainer")');
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('ClassDB.instantiate("Label")');
    expect(script).toContain('node.name = "Btn1"');
    expect(script).toContain('node.name = "Lbl1"');
  });

  it('includes anchor_preset', () => {
    const tree = { type: 'Panel', name: 'Bg', anchor_preset: 'full_rect' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).toContain('set_anchors_preset(15)');
  });

  it('includes properties', () => {
    const tree = { type: 'Label', name: 'Title', properties: { text: 'Hello' } };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).toContain('node.set("text", "Hello")');
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
    expect(script).toContain('ClassDB.instantiate');
  });
});

// ─── genThemeCreateScript ───────────────────────────────────────────────────

describe('genThemeCreateScript', () => {
  it('generates create action script', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create');
    expect(script).toContain('Theme.new()');
    expect(script).toContain('_mcp_output("theme_created"');
    expect(script).toContain('"action": "create"');
  });

  it('generates extract action script with source node', () => {
    const script = genThemeCreateScript('/scene.tscn', 'extract', '/root/Panel');
    expect(script).toContain('_mcp_get_scene_node("/root/Panel")');
    expect(script).toContain('source.theme');
    expect(script).toContain('if not source is Control:');
    expect(script).toContain('"action": "extract"');
  });

  it('generates script with save_path', () => {
    const script = genThemeCreateScript('/scene.tscn', 'create', undefined, 'res://themes/new.tres');
    expect(script).toContain('ResourceSaver.save');
    expect(script).toContain('res://themes/new.tres');
    expect(script).toContain('_mcp_output("saved"');
  });

  it('throws for extract without source_node_path', () => {
    expect(() => genThemeCreateScript('/scene.tscn', 'extract')).toThrow(/source_node_path is required/);
  });
});

// ─── genThemeSetPropertyScript ──────────────────────────────────────────────

describe('genThemeSetPropertyScript', () => {
  it('generates default_font script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'default_font', 'font', 'res://font.ttf');
    expect(script).toContain('theme.set_default_font');
    expect(script).toContain('load("res://font.ttf")');
    expect(script).toContain('_mcp_output("property_set"');
    expect(script).toContain('"item_type": "default_font"');
  });

  it('generates color script with RGBA array', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'font_color', [1, 0.5, 0, 0.8], 'Button');
    expect(script).toContain('theme.set_color');
    expect(script).toContain('Color(1, 0.5, 0, 0.8)');
    expect(script).toContain('"Button"');
    expect(script).toContain('"name": "font_color"');
  });

  it('generates color script with RGB array (alpha defaults to 1)', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', [0.2, 0.3, 0.4]);
    expect(script).toContain('Color(0.2, 0.3, 0.4, 1)');
  });

  it('generates constant script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'font_size', 16, 'Label');
    expect(script).toContain('theme.set_constant');
    expect(script).toContain('"font_size"');
    expect(script).toContain('16');
    expect(script).toContain('"Label"');
  });

  it('generates stylebox script', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'stylebox', 'panel', 'res://styles/panel.tres', 'Button');
    expect(script).toContain('theme.set_stylebox');
    expect(script).toContain('load("res://styles/panel.tres")');
  });

  it('validates theme node exists', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4);
    expect(script).toContain('_mcp_get_scene_node');
    expect(script).toContain('if theme == null:');
    expect(script).toContain('if not theme is Theme:');
  });

  it('throws for color with invalid value', () => {
    expect(() => genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', 'not-array')).toThrow(/array/);
  });

  it('parses stringified color array [r,g,b]', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', '[0.2, 0.3, 0.4]');
    expect(script).toContain('Color(0.2, 0.3, 0.4, 1)');
  });

  it('parses stringified color array [r,g,b,a]', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', '[1, 0.5, 0, 0.8]');
    expect(script).toContain('Color(1, 0.5, 0, 0.8)');
  });

  it('throws for unparseable string color', () => {
    expect(() => genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', 'not-json')).toThrow(/array/);
  });

  it('阶段1b: throws for constant value coercing to NaN', () => {
    expect(() => genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 'not-a-number')).toThrow(/finite|NaN|number/i);
  });

  it('阶段1b: throws for color array with non-numeric elements', () => {
    expect(() => genThemeSetPropertyScript('/project', '/root/Panel', 'color', 'bg', ['a', 'b', 'c'])).toThrow(/finite|NaN|number/i);
  });

  it('includes scene loading when scene_path provided', () => {
    const script = genThemeSetPropertyScript('/project', '/root/Panel', 'constant', 'sep', 4, undefined, '/scene.tscn');
    expect(script).toContain('_mcp_load_scene("/scene.tscn")');
  });
});

// ─── getToolDefinitions (merged single tool) ─────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 1 merged tool definition named "ui"', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('ui');
  });
  it('definition has inputSchema with required fields including action', () => {
    const defs = getToolDefinitions();
    const def = defs[0];
    expect(def.inputSchema).toBeTruthy();
    expect(def.inputSchema.required).toContain('action');
  });
  it('action enum contains all 13 ACTIONS', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum.length).toBe(13);
    expect(actionEnum).toContain('ui_create_control');
    expect(actionEnum).toContain('ui_build_layout');
    expect(actionEnum).toContain('ui_measure_layout');
    expect(actionEnum).toContain('ui_import_prototype');
    expect(actionEnum).toContain('ui_pixel_verify');
    expect(actionEnum).toContain('theme_create');
    expect(actionEnum).toContain('theme_set_property');
  });
  it('node_type enum has all 31 Control types (B1 反馈批次 B: +TextureButton/ColorRect)', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.node_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(31);
    expect(enumValues).toContain('Button');
    expect(enumValues).toContain('Label');
    expect(enumValues).toContain('NinePatchRect');
    expect(enumValues).toContain('TextureButton');
    expect(enumValues).toContain('ColorRect');
  });
  it('preset enum has all 16 anchor presets', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.preset.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(16);
    expect(enumValues).toContain('top_left');
    expect(enumValues).toContain('full_rect');
    expect(enumValues).toContain('center');
  });
  it('theme_action enum has set_params/create/save/load', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.theme_action.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(4);
    expect(enumValues).toContain('set_params');
    expect(enumValues).toContain('create');
    expect(enumValues).toContain('save');
    expect(enumValues).toContain('load');
  });
  it('child_type enum has all Control types', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.child_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues).toContain('Button');
    expect(enumValues).toContain('Label');
  });
  it('theme_create_action enum has create and extract', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.theme_create_action.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(2);
    expect(enumValues).toContain('create');
    expect(enumValues).toContain('extract');
  });
  it('item_type enum has 4 values', () => {
    const defs = getToolDefinitions();
    const enumValues = defs[0].inputSchema.properties.item_type.enum;
    expect(enumValues).toBeTruthy();
    expect(enumValues.length).toBe(4);
    expect(enumValues).toContain('default_font');
    expect(enumValues).toContain('color');
    expect(enumValues).toContain('constant');
    expect(enumValues).toContain('stylebox');
  });
  it('ops items have kind enum with 7 draw op kinds', () => {
    const defs = getToolDefinitions();
    const kindEnum = defs[0].inputSchema.properties.ops.items.properties.kind.enum;
    expect(kindEnum.length).toBe(7);
    expect(kindEnum).toContain('rect');
    expect(kindEnum).toContain('string');
  });
  it('tree.type enum has Control types', () => {
    const defs = getToolDefinitions();
    const typeEnum = defs[0].inputSchema.properties.tree.properties.type.enum;
    expect(typeEnum).toContain('Button');
    expect(typeEnum).toContain('VBoxContainer');
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
  it('returns fallback for array shorter than 3 (no throw)', () => {
    // colorToGd no longer throws — it falls back to valueToGd
    const result = colorToGd([0.5, 0.8]);
    expect(typeof result).toBe('string');
  });
  it('returns fallback for non-array input (no throw)', () => {
    // colorToGd no longer throws — it falls back to valueToGd
    const result = colorToGd('red');
    expect(typeof result).toBe('string');
  });
});

// ─── Flex Layout Translation ────────────────────────────────────────────────

describe('Flex Layout: direction', () => {
  it('direction: row -> HBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'row' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("HBoxContainer")');
    expect(script.includes('ClassDB.instantiate("Panel")')).toBeFalsy();
  });

  it('direction: column -> VBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("VBoxContainer")');
    expect(script.includes('ClassDB.instantiate("Panel")')).toBeFalsy();
  });

  it('direction: row-reverse -> HBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'row-reverse' },
      children: [
        { type: 'Button', name: 'A' },
        { type: 'Button', name: 'B' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("HBoxContainer")');
    const idxB = script.indexOf('node.name = "B"');
    const idxA = script.indexOf('node.name = "A"');
    expect(idxB < idxA).toBe(true);
  });

  it('direction: column-reverse -> VBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'column-reverse' },
      children: [
        { type: 'Label', name: 'X' },
        { type: 'Label', name: 'Y' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("VBoxContainer")');
    const idxY = script.indexOf('node.name = "Y"');
    const idxX = script.indexOf('node.name = "X"');
    expect(idxY < idxX).toBe(true);
  });
});

describe('Flex Layout: justify', () => {
  it('justify: center -> alignment = 1', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'center' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('node.alignment = 1');
  });

  it('justify: flex-start -> alignment = 0', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-start' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('node.alignment = 0');
  });

  it('justify: flex-end -> alignment = 2', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-end' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('node.alignment = 2');
  });

  it('justify: space-between -> injected spacer nodes with warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'space-between' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script.includes('node.alignment = 0')).toBeFalsy(); // 旧近似(space-between→BEGIN)已移除
    expect(script).toContain('injected spacer nodes');
  });
});

describe('Flex Layout: align', () => {
  it('align: stretch -> SIZE_EXPAND_FILL on cross axis', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'stretch' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('SIZE_EXPAND_FILL');
  });

  it('align: center -> SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'center' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('SIZE_SHRINK_CENTER');
  });
});

describe('Flex Layout: wrap', () => {
  it('wrap: wrap + row -> HFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("HFlowContainer")');
  });

  it('wrap: wrap + column -> VFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("VFlowContainer")');
  });
});

describe('Flex Layout: gap', () => {
  it('BoxContainer gap -> separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', gap: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('add_theme_constant_override("separation", 10)');
  });

  it('HFlowContainer gap -> h_separation + v_separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('add_theme_constant_override("h_separation", 8)');
    expect(script).toContain('add_theme_constant_override("v_separation", 8)');
  });

  it('row_gap in wrap mode', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8, row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('add_theme_constant_override("h_separation", 8)');
    expect(script).toContain('add_theme_constant_override("v_separation", 5)');
  });

  it('row_gap without wrap -> warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('row_gap');
  });
});

describe('Flex Layout: padding', () => {
  it('BoxContainer padding -> theme override margin_*', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('add_theme_constant_override("margin_top", 10)');
    expect(script).toContain('add_theme_constant_override("margin_right", 10)');
    expect(script).toContain('add_theme_constant_override("margin_bottom", 10)');
    expect(script).toContain('add_theme_constant_override("margin_left", 10)');
    expect(script.includes('MarginContainer')).toBeFalsy();
  });

  it('BoxContainer padding array -> individual margins', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: [1, 2, 3, 4] } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('add_theme_constant_override("margin_top", 1)');
    expect(script).toContain('add_theme_constant_override("margin_right", 2)');
    expect(script).toContain('add_theme_constant_override("margin_bottom", 3)');
    expect(script).toContain('add_theme_constant_override("margin_left", 4)');
  });

  it('FlowContainer padding -> MarginContainer wrapper', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', padding: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("MarginContainer")');
    expect(script).toContain('R_margin');
  });
});

describe('Flex Layout: flex child properties', () => {
  it('flex.grow -> stretch_ratio + SIZE_EXPAND', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { grow: 2 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('size_flags_stretch_ratio = 2');
    expect(script).toContain('SIZE_EXPAND');
  });

  it('flex.align_self: center -> SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { align_self: 'center' } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('SIZE_SHRINK_CENTER');
  });

  it('flex.min_width -> custom_minimum_size', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { min_width: 200 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('custom_minimum_size = Vector2(200');
  });

  it('flex.shrink -> warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { shrink: 1 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('shrink');
  });

  it('flex.max_width -> warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { max_width: 300 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('max_width');
  });
});

describe('Flex Layout: backward compatibility', () => {
  it('no layout field -> existing behavior unchanged', () => {
    const tree = { type: 'Button', name: 'MyButton' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('node.name = "MyButton"');
    expect(script.includes('HBoxContainer')).toBeFalsy();
    expect(script.includes('VBoxContainer')).toBeFalsy();
  });

  it('layout overrides type', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    expect(script).toContain('ClassDB.instantiate("VBoxContainer")');
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
    expect(script).toContain('ClassDB.instantiate("VBoxContainer")');
    expect(script).toContain('ClassDB.instantiate("HBoxContainer")');
    expect(script).toContain('separation", 10)');
    expect(script).toContain('separation", 5)');
  });
});

describe('Flex Layout: validation', () => {
  it('invalid direction -> error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'diagonal' } })).toThrow(/INVALID_LAYOUT/);
  });

  it('negative gap -> error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'row', gap: -1 } })).toThrow(/INVALID_LAYOUT/);
  });

  it('invalid padding format -> error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'Panel', name: 'R', layout: { direction: 'row', padding: 'big' } })).toThrow(/INVALID_LAYOUT/);
  });

  it('invalid align_self -> error', () => {
    expect(() => genUiBuildLayoutScript('/s.tscn', 'root', {
        type: 'Panel', name: 'R', layout: { direction: 'row' },
        children: [{ type: 'Button', name: 'B', flex: { align_self: 'middle' } }],
      })).toThrow(/INVALID_FLEX/);
  });
});

// ─── 阶段4: UI BLOCKED_PROPS 同源对齐(对齐 material IMP-1 / scene S1) ────────

describe('findBlockedProps (阶段4: UI BLOCKED_PROPS 同源对齐)', () => {
  it('returns [] for undefined / properties without blocked keys', () => {
    expect(findBlockedProps(undefined)).toEqual([]);
    expect(findBlockedProps({})).toEqual([]);
    expect(findBlockedProps({ text: 'x', disabled: true })).toEqual([]);
  });
  it('detects script/owner/name/instance', () => {
    const blocked = findBlockedProps({ script: 'x', text: 'ok', owner: 'y', instance: 'z' });
    expect(blocked).toEqual(expect.arrayContaining(['script', 'owner', 'instance']));
    expect(blocked).not.toContain('text');
  });
});

describe('handleTool BLOCKED_PROPS (阶段4 路径1&2: ui_create_control / ui_container_add 前置校验)', () => {
  const fakeCtx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
  it('ui_create_control rejects "script" property before exec', async () => {
    const result = await handleTool('ui', {
      action: 'ui_create_control', project_path: '/fake/p',
      scene_path: '/fake/p/scene.tscn', node_type: 'Button', node_name: 'Btn',
      properties: { script: 'res://evil.gd' },
    }, fakeCtx);
    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked|BLOCKED_PROPS/i);
  });
  it('ui_container_add rejects "owner" child property before exec', async () => {
    const result = await handleTool('ui', {
      action: 'ui_container_add', project_path: '/fake/p',
      scene_path: '/fake/p/scene.tscn', node_path: 'root/VBox',
      child_type: 'Button', child_name: 'Btn',
      child_properties: { owner: 'x' },
    }, fakeCtx);
    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked|BLOCKED_PROPS/i);
  });
});

describe('genUiBuildLayoutScript BLOCKED_PROPS (阶段4 路径3: 生成层过滤 + warnings)', () => {
  it('drops "script" property, keeps safe props, emits warning', () => {
    const tree = { type: 'Button', name: 'Btn', properties: { script: 'res://evil.gd', text: 'OK' } };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).not.toContain('node.set("script"');
    expect(script).toContain('node.set("text", "OK")');
    expect(script).toContain('_mcp_output("warnings"');
  });
  it('drops blocked property in nested children', () => {
    const tree = {
      type: 'VBoxContainer', name: 'VBox',
      children: [{ type: 'Button', name: 'Btn', properties: { instance: '1' } }],
    };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).not.toContain('node.set("instance"');
    expect(script).toContain('_mcp_output("warnings"');
  });
  it('no blocked props -> no warnings output', () => {
    const tree = { type: 'Button', name: 'Btn', properties: { text: 'OK' } };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    expect(script).not.toContain('_mcp_output("warnings"');
  });
});
