import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn } from '../build/tscn-parser.js';

describe('tscn-parser instance_of', () => {
  it('should resolve instance_of path from ext_resources', () => {
    const tscn = `[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" uid="uid://abc" path="res://scenes/player.tscn" id="1"]
[ext_resource type="Script" path="res://scripts/main.gd" id="2"]

[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
[node name="Label" parent="Player" type="Label"]
`;
    const result = parseTscn(tscn);
    const player = result.nodes.find(n => n.name === 'Player');
    assert.ok(player);
    assert.equal(player.instance, 1);
    assert.equal(player.instance_of, 'res://scenes/player.tscn');
  });

  it('should not set instance_of for non-instance nodes', () => {
    const tscn = `[gd_scene format=3]
[node name="Main" type="Node2D"]
[node name="Label" parent="." type="Label"]
`;
    const result = parseTscn(tscn);
    const label = result.nodes.find(n => n.name === 'Label');
    assert.ok(label);
    assert.equal(label.instance_of, undefined);
  });
});
