import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintGDScript } from '../build/tools/gdscript-lint.js';

describe('GDScript Lint', () => {
  it('returns empty results for clean code', () => {
    const code = 'extends Node3D\n\nfunc _ready():\n\tpass';
    const result = lintGDScript(code);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.meta.godot_target, '4.6');
  });

  it('returns meta information', () => {
    const result = lintGDScript('');
    assert.ok(result.meta.rules_count >= 16);
    assert.ok(result.meta.last_reviewed);
  });

  // L003
  describe('L003 CylinderMesh.radius', () => {
    it('命中: CylinderMesh_inst.radius 赋值', () => {
      assert.ok(lintGDScript('CylinderMesh.radius = 0.5').errors.some(e => e.rule === 'L003'));
    });
    it('忽略: SphereMesh.radius 合法', () => {
      assert.ok(!lintGDScript('var mesh := SphereMesh.new()\nmesh.radius = 0.5').errors.some(e => e.rule === 'L003'));
    });
    it('边界: 变量名包含 radius', () => {
      assert.ok(!lintGDScript('var cylinder_radius = 0.5').errors.some(e => e.rule === 'L003'));
    });
  });

  // L004
  describe('L004 Environment.adjustments_*', () => {
    it('命中: adjustments_enabled 赋值', () => {
      assert.ok(lintGDScript('env.adjustments_enabled = true').errors.some(e => e.rule === 'L004'));
    });
    it('忽略: adjustment_enabled 正确', () => {
      assert.ok(!lintGDScript('env.adjustment_enabled = true').errors.some(e => e.rule === 'L004'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# adjustments_enabled is deprecated').errors.some(e => e.rule === 'L004'));
    });
  });

  // L005
  describe('L005 Environment.tone_mapper', () => {
    it('命中: tone_mapper 赋值', () => {
      assert.ok(lintGDScript('env.tone_mapper = 1').errors.some(e => e.rule === 'L005'));
    });
    it('忽略: tonemap_mode 正确', () => {
      assert.ok(!lintGDScript('env.tonemap_mode = 1').errors.some(e => e.rule === 'L005'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var tone_mapper_value = 1').errors.some(e => e.rule === 'L005'));
    });
  });

  // L006
  describe('L006 SoftBody3D.mass', () => {
    it('命中: SoftBody3D.mass 赋值', () => {
      assert.ok(lintGDScript('SoftBody3D.mass = 2.0').errors.some(e => e.rule === 'L006'));
    });
    it('忽略: RigidBody3D.mass 合法', () => {
      assert.ok(!lintGDScript('var body := RigidBody3D.new()\nbody.mass = 2.0').errors.some(e => e.rule === 'L006'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var softbody_mass = 2.0').errors.some(e => e.rule === 'L006'));
    });
  });

  // L008
  describe('L008 ArrayMesh.create_triangle_shape', () => {
    it('命中: create_triangle_shape 调用', () => {
      assert.ok(lintGDScript('mesh.create_triangle_shape()').errors.some(e => e.rule === 'L008'));
    });
    it('忽略: create_triangle_mesh 正确', () => {
      assert.ok(!lintGDScript('mesh.create_triangle_mesh()').errors.some(e => e.rule === 'L008'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# mesh.create_triangle_shape()').errors.some(e => e.rule === 'L008'));
    });
  });

  // L009
  describe('L009 Node.get_child_or_null', () => {
    it('命中: get_child_or_null 调用', () => {
      assert.ok(lintGDScript('var child = get_child_or_null(0)').errors.some(e => e.rule === 'L009'));
    });
    it('忽略: get_child 正确', () => {
      assert.ok(!lintGDScript('var child = get_child(0)').errors.some(e => e.rule === 'L009'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# get_child_or_null').errors.some(e => e.rule === 'L009'));
    });
  });

  // L010
  describe('L010 FogMaterial.albedo_color', () => {
    it('命中: FogMaterial.albedo_color 赋值', () => {
      const r = lintGDScript('FogMaterial.albedo_color = Color.RED');
      assert.ok(r.errors.some(e => e.rule === 'L010'));
      const l010 = r.errors.find(e => e.rule === 'L010');
      assert.ok(l010.suggestion.includes('albedo'));
      assert.ok(!l010.suggestion.includes('emission'));
    });
    it('忽略: FogMaterial.albedo 正确', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.albedo = Color.RED').errors.some(e => e.rule === 'L010'));
    });
    it('边界: FogMaterial.emission 合法', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.emission = Color.RED').errors.some(e => e.rule === 'L010'));
    });
  });

  // L011
  describe('L011 Environment.physically_based_lights_enabled', () => {
    it('命中: physically_based_lights_enabled 赋值', () => {
      assert.ok(lintGDScript('env.physically_based_lights_enabled = true').errors.some(e => e.rule === 'L011'));
    });
    it('忽略: 其他属性', () => {
      assert.ok(!lintGDScript('env.ambient_light_source = 1').errors.some(e => e.rule === 'L011'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# physically_based_lights_enabled').errors.some(e => e.rule === 'L011'));
    });
  });

  // L012
  describe('L012 Line2D.dash_pattern', () => {
    it('命中: dash_pattern 使用普通数组', () => {
      assert.ok(lintGDScript('line.dash_pattern = [1.0, 2.0]').errors.some(e => e.rule === 'L012'));
    });
    it('忽略: PackedFloat32Array 正确', () => {
      assert.ok(!lintGDScript('line.dash_pattern = PackedFloat32Array([1.0, 2.0])').errors.some(e => e.rule === 'L012'));
    });
    it('边界: 变量间接赋值', () => {
      assert.ok(!lintGDScript('var p := PackedFloat32Array([1, 2])\nline.dash_pattern = p').errors.some(e => e.rule === 'L012'));
    });
  });

  // L013
  describe('L013 CharacterBody3D.body_entered', () => {
    it('命中: CharacterBody3D 使用 body_entered', () => {
      assert.ok(lintGDScript('CharacterBody3D.body_entered.connect(_on_enter)').errors.some(e => e.rule === 'L013'));
    });
    it('忽略: Area3D 使用 body_entered 合法', () => {
      assert.ok(!lintGDScript('extends Area3D\narea.body_entered.connect(_on_enter)').errors.some(e => e.rule === 'L013'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# body_entered signal').errors.some(e => e.rule === 'L013'));
    });
  });

  // L002
  describe('L002 RigidBody3D.bounce', () => {
    it('命中: RigidBody3D.bounce 直接赋值', () => {
      assert.ok(lintGDScript('var rb := RigidBody3D.new()\nrb.bounce = 0.4').errors.some(e => e.rule === 'L002'));
    });
    it('忽略: PhysicsMaterial.bounce 合法', () => {
      assert.ok(!lintGDScript('var phys_mat := PhysicsMaterial.new()\nphys_mat.bounce = 0.4').errors.some(e => e.rule === 'L002'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# rb.bounce = 0.4').errors.some(e => e.rule === 'L002'));
    });
    it('边界: 注释中的 RigidBody3D 不影响非 RigidBody 代码', () => {
      const code = '# RigidBody3D says bounce deprecated\nvar mat := SomeMaterial.new()\nmat.bounce = 0.4';
      assert.ok(!lintGDScript(code).errors.some(e => e.rule === 'L002'));
    });
  });

  // L007
  describe('L007 Node3D.visibility_range_*', () => {
    it('命中: Node3D 上下文引用 visibility_range', () => {
      assert.ok(lintGDScript('var node := Node3D.new()\nnode.visibility_range_begin = 5.0').errors.some(e => e.rule === 'L007'));
    });
    it('忽略: MeshInstance3D 合法', () => {
      assert.ok(!lintGDScript('var mesh := MeshInstance3D.new()\nmesh.visibility_range_begin = 5.0').errors.some(e => e.rule === 'L007'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# visibility_range_begin').errors.some(e => e.rule === 'L007'));
    });
  });

  // L001
  describe('L001 look_at order', () => {
    it('命中: _ready 内 look_at 在 add_child 前', () => {
      const code = 'func _ready():\n\tvar cam := Camera3D.new()\n\tcam.look_at(target)\n\tadd_child(cam)';
      assert.ok(lintGDScript(code).errors.some(e => e.rule === 'L001'));
    });
    it('忽略: add_child 在 look_at 前', () => {
      const code = 'func _ready():\n\tvar cam := Camera3D.new()\n\tadd_child(cam)\n\tcam.look_at(target)';
      assert.ok(!lintGDScript(code).errors.some(e => e.rule === 'L001'));
    });
    it('边界: 跨函数不在检测范围', () => {
      const code = 'func _ready():\n\tadd_child(cam)\nfunc _process(delta):\n\tcam.look_at(target)';
      assert.ok(!lintGDScript(code).errors.some(e => e.rule === 'L001'));
    });
  });

  // L014
  describe('L014 AStarGrid2D update', () => {
    it('命中: 先 set_point_solid 后 update', () => {
      const code = 'func _ready():\n\tgrid.set_point_solid(Vector2i(1, 1))\n\tgrid.update()';
      assert.ok(lintGDScript(code).warnings.some(w => w.rule === 'L014'));
    });
    it('忽略: 先 update 后 set_point_solid', () => {
      const code = 'func _ready():\n\tgrid.update()\n\tgrid.set_point_solid(Vector2i(1, 1))';
      assert.ok(!lintGDScript(code).warnings.some(w => w.rule === 'L014'));
    });
    it('边界: 无 update 调用', () => {
      const code = 'func _ready():\n\tgrid.set_point_solid(Vector2i(1, 1))';
      assert.ok(!lintGDScript(code).warnings.some(w => w.rule === 'L014'));
    });
  });

  // L015
  describe('L015 RigidBody3D.look_at in _process', () => {
    it('命中: _physics_process 内 look_at', () => {
      assert.ok(lintGDScript('func _physics_process(delta):\n\tvar rb: RigidBody3D = get_node("rb")\n\trb.look_at(target)').errors.some(e => e.rule === 'L015'));
    });
    it('忽略: _integrate_forces 内', () => {
      assert.ok(!lintGDScript('func _integrate_forces(state):\n\tpass').errors.some(e => e.rule === 'L015'));
    });
    it('边界: _ready 内一次性 look_at', () => {
      assert.ok(!lintGDScript('func _ready():\n\tvar cam := Camera3D.new()\n\tadd_child(cam)\n\tcam.look_at(target)').errors.some(e => e.rule === 'L015'));
    });
  });

  // L016
  describe('L016 add_child followed by method call', () => {
    it('命中: add_child 后立即调用方法', () => {
      const code = 'func _ready():\n\tvar node := Node3D.new()\n\tadd_child(node)\n\tnode.set_something()';
      assert.ok(lintGDScript(code).warnings.some(w => w.rule === 'L016'));
    });
    it('忽略: await 后访问', () => {
      const code = 'func _ready():\n\tadd_child(node)\n\tawait get_tree().process_frame\n\tnode.set_something()';
      assert.ok(!lintGDScript(code).warnings.some(w => w.rule === 'L016'));
    });
    it('边界: 跨函数不在范围', () => {
      const code = 'func _ready():\n\tadd_child(node)\nfunc _process(delta):\n\tnode.set_something()';
      assert.ok(!lintGDScript(code).warnings.some(w => w.rule === 'L016'));
    });
  });

  describe('KNOWN_BASE_METHODS cleanup', () => {
    it('RigidBody3D.mass 不触发 L006', () => {
      assert.ok(!lintGDScript('var body := RigidBody3D.new()\nbody.mass = 2.0').errors.some(e => e.rule === 'L006'));
    });
    it('bounce 由 lint 接管', () => {
      assert.ok(lintGDScript('var rb := RigidBody3D.new()\nrb.bounce = 0.4').errors.some(e => e.rule === 'L002'));
    });
    it('friction 清理后不崩溃', () => {
      const r = lintGDScript('var rb := RigidBody3D.new()\nrb.friction = 0.3');
      assert.ok(r.meta.rules_count > 0);
    });
  });
});
