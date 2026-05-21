/** 最小可运行项目 */
export const MINIMAL_PROJECT = {
  'project.godot': `; Engine configuration file.
[application]
config/name="TestProject"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`,
  'scenes/main.tscn': `[gd_scene load_steps=2 format=3 uid="uid://test001"]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Root" type="Node2D"]

[node name="Main" parent="." index="0"]
script = ExtResource("1")
`,
  'scripts/main.gd': `extends Node2D

func _ready():
\tpass
`,
};

/** 含无效 ext_resource 引用的项目（用于 validate_project 测试） */
export const BROKEN_REF_PROJECT = {
  'project.godot': `; Engine configuration file.
[application]
config/name="BrokenRefProject"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`,
  'scenes/main.tscn': `[gd_scene load_steps=2 format=3 uid="uid://test002"]

[ext_resource type="Script" path="res://scripts/MISSING.gd" id="1"]

[node name="Root" type="Node2D"]

[node name="Main" parent="." index="0"]
script = ExtResource("1")
`,
};
