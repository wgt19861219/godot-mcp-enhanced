import { expect } from 'vitest';
import fc from 'fast-check';
import { parseTscn, parseTscnSummary } from '../src/tscn-parser.js';

function toSerializable(result) {
  if (result.nodeMap instanceof Map) {
    return { ...result, nodeMap: Object.fromEntries(result.nodeMap) };
  }
  return result;
}

describe('parseTscn', () => {
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
    expect(typeof summary === 'string').toBeTruthy();
    expect(summary.includes('Main')).toBeTruthy();
    expect(summary.includes('Nodes (2 total)')).toBeTruthy();
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
