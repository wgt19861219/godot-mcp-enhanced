import { describe, it, expect } from 'vitest';
import { mergeTscn } from '../../src/tools/scene.js';

describe('mergeTscn — .tscn 合并冲突修复', () => {
  const ours = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://b.gd" id="2"]

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")

[node name="Enemy" type="CharacterBody3D" parent="."]
script = ExtResource("2")
`;

  const theirs = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://c.gd" id="2"]

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")

[node name="Boss" type="CharacterBody3D" parent="."]
script = ExtResource("2")
`;

  it('应合并两个分支的 ext_resource（去重 + 合并新资源）', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('res://a.gd');
    expect(result).toContain('res://b.gd');
    expect(result).toContain('res://c.gd');
  });

  it('应合并两个分支的 node（ours + theirs 新增节点）', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('name="Player"');
    expect(result).toContain('name="Enemy"');
    expect(result).toContain('name="Boss"');
  });

  it('应保留有效的 [gd_scene] 头', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('[gd_scene');
  });

  it('对相同内容应返回原样', () => {
    const result = mergeTscn(ours, ours);
    expect(result).toContain('res://a.gd');
    expect(result).toContain('res://b.gd');
    expect(result).toContain('name="Enemy"');
  });

  it('应保留原始 ext_resource id（无碰撞时）', () => {
    const result = mergeTscn(ours, theirs);
    // ours 的 ext_resource 应保留原始 id
    expect(result).toContain('path="res://a.gd" id="1"');
    expect(result).toContain('path="res://b.gd" id="2"');
    const extMatches = result.match(/\[ext_resource[^[]*id="([^"]+)"/g);
    expect(extMatches).toBeTruthy();
    const ids = extMatches!.map(m => m.match(/id="([^"]+)"/)![1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('应合并 sub_resource 段', () => {
    const withSub = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]

[sub_resource type="BoxShape3D" id="1"]
size = Vector3(1, 1, 1)

[node name="Root" type="Node3D"]
`;
    const withSub2 = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]

[sub_resource type="SphereShape3D" id="1"]
radius = 2.0

[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(withSub, withSub2);
    expect(result).toContain('BoxShape3D');
    expect(result).toContain('SphereShape3D');
  });

  it('应重映射 SubResource 引用', () => {
    const ours = `[gd_scene load_steps=3 format=3]

[sub_resource type="BoxShape3D" id="1"]
size = Vector3(1, 1, 1)

[node name="Root" type="Node3D"]

[node name="Body" type="StaticBody3D" parent="."]

[node name="Shape" type="CollisionShape3D" parent="Body"]
shape = SubResource("1")
`;
    const theirs = `[gd_scene load_steps=2 format=3]

[node name="Root" type="Node3D"]

[node name="Extra" type="Node3D" parent="."]
`;
    const result = mergeTscn(ours, theirs);
    // SubResource 引用应被重映射到新 id
    const subRef = result.match(/SubResource\("(\d+)"\)/);
    expect(subRef).toBeTruthy();
    // 对应的 sub_resource id 应与引用一致
    expect(result).toContain(`id="${subRef![1]}"]`);
  });

  it('应处理 ID 碰撞（theirs 的 ID 已被 ours 使用）', () => {
    const a = `[gd_scene format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[ext_resource type="Script" path="res://c.gd" id="2"]
[ext_resource type="Script" path="res://d.gd" id="3"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('path="res://a.gd" id="1"');
    expect(result).toContain('path="res://b.gd" id="2"');
    expect(result).toContain('path="res://c.gd" id="3"');
    expect(result).toContain('path="res://d.gd" id="4"');
    const ids = result.match(/id="(\d+)"/g);
    expect(new Set(ids).size).toBe(ids!.length);
  });

  it('应保留字符串 UID 的 sub_resource id', () => {
    const a = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="BoxShape3D_gds123"]
size = Vector3(1, 1, 1)
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[node name="Extra" type="Node3D" parent="."]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('id="BoxShape3D_gds123"');
  });

  it('应处理字符串 UID 二次碰撞（while 循环）', () => {
    const a = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="Box3D_abc"]
size = Vector3(1, 1, 1)

[sub_resource type="SphereShape3D" id="Box3D_abc_m1"]
radius = 2.0

[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="Box3D_abc"]
size = Vector3(3, 3, 3)

[node name="Extra" type="Node3D" parent="."]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('id="Box3D_abc"]');
    expect(result).toContain('id="Box3D_abc_m1"]');
    expect(result).toContain('id="Box3D_abc_m2"]');
    expect(result).toContain('size = Vector3(3, 3, 3)');
  });

  it('应更新 header 的 load_steps', () => {
    const a = `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('load_steps=3');
  });

  it('应在 format 不匹配时添加警告注释', () => {
    const a = `[gd_scene format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=2]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('WARNING: format mismatch');
  });
});
