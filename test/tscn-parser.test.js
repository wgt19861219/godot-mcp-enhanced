import { expect, vi } from 'vitest';
import fc from 'fast-check';
import { parseTscn, parseTscnSummary } from '../src/tscn/tscn-parser.js';

function toSerializable(result) {
  if (result.nodeMap instanceof Map) {
    return { ...result, nodeMap: Object.fromEntries(result.nodeMap) };
  }
  return result;
}

describe('parseTscn', () => {
  it('warns when input has no [gd_scene] header (C1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseTscn('[ext_resource type="Script" path="res://x.gd" id="1"]\n[node name="A" type="Node"]');
    expect(result.header).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no [gd_scene] header'));
    warnSpy.mockRestore();
  });

  it('does NOT warn for valid input with [gd_scene] header (C1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseTscn('[gd_scene load_steps=1 format=2]\n[node name="A" type="Node"]');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[gd_scene] header'));
    warnSpy.mockRestore();
  });

  it('parses a minimal scene with one node', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")

[node name="Sprite" type="Sprite2D" parent="."]
texture = ExtResource("1")
`;

    const result = parseTscn(content);
    expect(result).toBeTruthy();
    expect(Array.isArray(result.nodes)).toBeTruthy();
    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].name).toBe('Player');
    expect(result.nodes[0].type).toBe('CharacterBody2D');
    expect(result.nodes[1].name).toBe('Sprite');
    expect(result.nodes[1].type).toBe('Sprite2D');
    expect(result.nodes[0].children.length).toBe(1);
    expect(result.nodes[0].children[0].name).toBe('Sprite');
    expect(toSerializable(result)).toMatchSnapshot('minimal-scene');
  });

  it('parses root node without parent', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node2D"]
`;

    const result = parseTscn(content);
    expect(result.nodes[0].parent).toBe('');
  });

  // CRITICAL-2 regression guard: header `[gd_scene ...]` must parse format/load_steps/uid.
  it('parses [gd_scene] header attributes (CRITICAL-2)', () => {
    const content = `[gd_scene load_steps=4 format=3 uid="uid://abc123xyz"]

[node name="Root" type="Node"]
`;
    const result = parseTscn(content);
    expect(result.header.format).toBe(3);
    expect(result.header.load_steps).toBe(4);
    expect(result.header.uid).toBe('uid://abc123xyz');
  });

  it('handles header without uid', () => {
    const content = `[gd_scene load_steps=1 format=2]

[node name="Root" type="Node"]
`;
    const result = parseTscn(content);
    expect(result.header.format).toBe(2);
    expect(result.header.load_steps).toBe(1);
    expect(result.header.uid).toBeUndefined();
  });

  it('handles empty scene gracefully', () => {
    const content = `[gd_scene load_steps=1 format=3]
`;
    const result = parseTscn(content);
    expect(result).toBeTruthy();
    expect(result.nodes.length).toBe(0);
  });

  it('handles parent="." multi-level nesting', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node3D"]

[node name="Child" type="Node3D" parent="."]

[node name="GrandChild" type="Node3D" parent="Child"]
`;
    const result = parseTscn(content);
    expect(result.nodes.length).toBe(3);
    expect(result.nodes[0].name).toBe('Root');
    expect(result.nodes[0].children.length).toBe(1);
    expect(result.nodes[0].children[0].name).toBe('Child');
    expect(result.nodes[0].children[0].children.length).toBe(1);
    expect(result.nodes[0].children[0].children[0].name).toBe('GrandChild');
  });

  it('handles 4+ level nesting with slash parent paths', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node3D"]

[node name="Child" type="Node3D" parent="."]

[node name="GrandChild" type="Node3D" parent="Child"]

[node name="GreatGrand" type="Node3D" parent="Child/GrandChild"]
`;
    const result = parseTscn(content);
    expect(result.nodes.length).toBe(4);
    expect(result.nodes[0].name).toBe('Root');
    expect(result.nodes[0].children[0].name).toBe('Child');
    expect(result.nodes[0].children[0].children[0].name).toBe('GrandChild');
    expect(result.nodes[0].children[0].children[0].children[0].name).toBe('GreatGrand');
  });

  it('parses instance ExtResource references', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://player.tscn" id="1"]

[node name="Player" parent="." instance=ExtResource("1")]
`;
    const result = parseTscn(content);
    expect(result.nodes[0].instance).toBe(1);
    expect(result.nodes[0].instance_of).toBe('res://player.tscn');
  });

  // CRITICAL-1 regression guards: node multi-line properties use `key = value`.
  // parseTypedValue previously searched for ':' and never split on '=', so every
  // property value was stored verbatim as the name AND value. These checks pin
  // the correct ExtResource / Vector2 / Color / NodePath / number / string paths.
  it('parses ExtResource multi-line property (CRITICAL-1)', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")
`;
    const result = parseTscn(content);
    const prop = result.nodes[0].properties.find(p => p.name === 'script');
    expect(prop).toBeTruthy();
    expect(prop.value).toEqual({ __type: 'ExtResource', id: 1 });
  });

  it('parses Vector2 / Color / number / string properties (CRITICAL-1)', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Player" type="Node2D"]
position = Vector2(100, 200)
modulate = Color(1, 0.5, 0, 1)
frame = 3
label_text = "Hello World"
`;
    const result = parseTscn(content);
    const props = result.nodes[0].properties;
    expect(props.find(p => p.name === 'position')?.value)
      .toEqual({ __type: 'Vector2', value: '100, 200' });
    expect(props.find(p => p.name === 'modulate')?.value)
      .toEqual({ __type: 'Color', value: '1, 0.5, 0, 1' });
    expect(props.find(p => p.name === 'frame')?.value).toBe(3);
    expect(props.find(p => p.name === 'label_text')?.value).toBe('Hello World');
  });

  it('parses Vector2i / Vector3i / PackedInt32Array / Transform3D (Tier2-2)', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Grid" type="Node2D"]
cell = Vector2i(1, 2)
offset = Vector3i(1, 2, 3)
tile_data = PackedInt32Array(1, 2, 3)
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 5)
`;
    const result = parseTscn(content);
    const props = result.nodes[0].properties;
    expect(props.find(p => p.name === 'cell')?.value)
      .toEqual({ __type: 'Vector2i', value: '1, 2' });
    expect(props.find(p => p.name === 'offset')?.value)
      .toEqual({ __type: 'Vector3i', value: '1, 2, 3' });
    expect(props.find(p => p.name === 'tile_data')?.value)
      .toEqual({ __type: 'PackedInt32Array', value: '1, 2, 3' });
    expect(props.find(p => p.name === 'transform')?.value)
      .toEqual({ __type: 'Transform3D', value: '1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 5' });
  });

  it('preserves slash in property name (theme_override_styles/panel)', () => {
    const content = `[gd_scene load_steps=1 format=3]

[ext_resource type="StyleBox" path="res://style.tres" id="1"]

[node name="Panel" type="Panel"]
theme_override_styles/panel = ExtResource("1")
`;
    const result = parseTscn(content);
    const prop = result.nodes[0].properties.find(p => p.name === 'theme_override_styles/panel');
    expect(prop).toBeTruthy();
    expect(prop.value).toEqual({ __type: 'ExtResource', id: 1 });
  });

  it('parses SubResource reference in node property', () => {
    const content = `[gd_scene load_steps=1 format=3]

[sub_resource type="AnimationNode" id="anim_1"]

[node name="Player" type="AnimationTree"]
tree_root = SubResource("anim_1")
`;
    const result = parseTscn(content);
    const prop = result.nodes[0].properties.find(p => p.name === 'tree_root');
    expect(prop).toBeTruthy();
    expect(prop.value).toEqual({ __type: 'SubResource', id: 'anim_1' });
  });

  it('handles connections', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node"]

[connection signal="pressed" from="Root/Button" to="Root" method="_on_pressed"]
`;
    const result = parseTscn(content);
    expect(result.connections.length).toBe(1);
    expect(result.connections[0].signal).toBe('pressed');
    expect(result.connections[0].from).toBe('Root/Button');
    expect(result.connections[0].to).toBe('Root');
    expect(result.connections[0].method).toBe('_on_pressed');
    expect(toSerializable(result)).toMatchSnapshot('scene-with-connections');
  });
});

describe('parseTscnSummary', () => {
  it('returns human-readable summary', () => {
    const content = `[gd_scene load_steps=2 format=3]

[node name="Main" type="Node2D"]

[node name="Label" type="Label" parent="."]
text = "Hello"
`;

    const summary = parseTscnSummary(content);
    expect(typeof summary === 'string').toBe(true);
    expect(summary).toContain('Main');
    expect(summary).toContain('Nodes (2 total)');
    expect(summary).toMatchSnapshot('scene-summary');
  });
});

describe('parseTscn snapshots', () => {
  it('snapshots complex nested scene', () => {
    const tscn = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]
[ext_resource type="Texture2D" path="res://icon.svg" id="2"]

[node name="Root" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
position = Vector2(100, 200)

[node name="Sprite" type="Sprite2D" parent="Player"]
texture = ExtResource("2")

[node name="Camera" type="Camera2D" parent="Player"]
zoom = Vector2(2, 2)

[node name="UI" type="CanvasLayer" parent="."]

[node name="HUD" type="Control" parent="UI"]
layout_mode = 3

[connection signal="pressed" from="UI/HUD" to="Root" method="_on_pressed"]
`;
    const result = parseTscn(tscn);
    expect(toSerializable(result)).toMatchSnapshot('complex-nested-scene');
  });
});

describe('Property: parseTscn fuzz', () => {
  it('never crashes on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (input) => {
        // parseTscn 不应抛错，应优雅处理任意输入
        expect(() => parseTscn(input)).not.toThrow();
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('returns array for nodes on any input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (input) => {
        const result = parseTscn(input);
        expect(Array.isArray(result.nodes)).toBe(true);
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });
});

describe('parseTscn input size limit', () => {
  it('rejects input exceeding 10MB size limit', () => {
    const hugeContent = 'x'.repeat(10 * 1024 * 1024 + 1);
    expect(() => parseTscn(hugeContent)).toThrow('tscn input too large');
  });
});

// ── L-25(2026-10-22 审查第二轮): 摘要递归环防护(纵深防御) ──
// 实测当前 nodeMap 键构造下互指 parent 环挂不进 children(键含完整 parent 路径,
// 查找键不对称),环不可达——本用例固化该输入形态的安全行为(不炸、可产出摘要),
// 并为键逻辑演进时 printNode 的 visited/深度防护兜底。
describe('parseTscnSummary cycle safety (L-25)', () => {
  it('互指 parent 环(C↔D)输入不抛异常,产出有限摘要', () => {
    const cyclic = `[gd_scene format=3]

[node name="Root" type="Node2D"]

[node name="C" type="Node2D" parent="D"]

[node name="D" type="Node2D" parent="C"]
`;
    const summary = parseTscnSummary(cyclic);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeLessThan(100_000);  // 无限递归会先栈溢出,长度上限双保险
    expect(summary).toContain('Root');
  });
});
