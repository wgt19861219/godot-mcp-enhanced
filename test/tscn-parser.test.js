import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn, parseTscnSummary } from '../build/tscn-parser.js';

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
    assert.ok(result);
    assert.ok(Array.isArray(result.nodes));
    assert.strictEqual(result.nodes.length, 2);
    assert.strictEqual(result.nodes[0].name, 'Player');
    assert.strictEqual(result.nodes[0].type, 'CharacterBody2D');
    assert.strictEqual(result.nodes[1].name, 'Sprite');
    assert.strictEqual(result.nodes[1].type, 'Sprite2D');
    assert.strictEqual(result.nodes[0].children.length, 1);
    assert.strictEqual(result.nodes[0].children[0].name, 'Sprite');
  });

  it('parses root node without parent', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node2D"]
`;

    const result = parseTscn(content);
    assert.strictEqual(result.nodes[0].parent, '');
  });

  it('handles empty scene gracefully', () => {
    const content = `[gd_scene load_steps=1 format=3]
`;
    const result = parseTscn(content);
    assert.ok(result);
    assert.strictEqual(result.nodes.length, 0);
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
    assert.ok(typeof summary === 'string');
    assert.ok(summary.includes('Main'));
    assert.ok(summary.includes('Nodes (2 total)'));
  });
});
