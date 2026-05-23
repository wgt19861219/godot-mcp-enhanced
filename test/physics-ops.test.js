import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genRaycastScript,
  genBodyInfoScript,
  genDiagnosePhysicsScript,
  genQuerySpatialScript,
} from '../build/tools/physics-ops.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('physics-ops TOOL_NAMES', () => {
  it('contains exactly 4 tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 4);
  });
  it('includes physics_raycast', () => {
    assert.ok(TOOL_NAMES.includes('physics_raycast'));
  });
  it('includes physics_body_info', () => {
    assert.ok(TOOL_NAMES.includes('physics_body_info'));
  });
  it('includes diagnose_physics', () => {
    assert.ok(TOOL_NAMES.includes('diagnose_physics'));
  });
  it('includes query_spatial', () => {
    assert.ok(TOOL_NAMES.includes('query_spatial'));
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('physics-ops getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      assert.ok(names.includes(tn), `missing tool definition for ${tn}`);
    }
  });
});

// ─── genRaycastScript ───────────────────────────────────────────────────────

describe('genRaycastScript', () => {
  it('contains PhysicsRayQueryParameters3D.create', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0});
    assert.ok(script.includes('PhysicsRayQueryParameters3D.create'));
    assert.ok(script.includes('Vector3(0, 0, 0)'));
    assert.ok(script.includes('Vector3(10, 0, 0)'));
    assert.ok(script.includes('root.get_world_3d()'));
  });
  it('includes collision_mask when provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, 0b111);
    assert.ok(script.includes('collision_mask = 7'));
  });
  it('includes exclude logic when paths provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, undefined, ['/root/Wall', '/root/Floor']);
    assert.ok(script.includes('exclude'));
    assert.ok(script.includes('/root/Wall'));
    assert.ok(script.includes('/root/Floor'));
  });
});

// ─── genBodyInfoScript ──────────────────────────────────────────────────────

describe('genBodyInfoScript', () => {
  it('contains CollisionShape3D scan', () => {
    const script = genBodyInfoScript('/root/Player');
    assert.ok(script.includes('CollisionShape3D'));
    assert.ok(script.includes('get_node("/root/Player")'));
    assert.ok(script.includes('has_collision'));
  });
  it('contains collision_layer and collision_mask', () => {
    const script = genBodyInfoScript('/root/Player');
    assert.ok(script.includes('collision_layer'));
    assert.ok(script.includes('collision_mask'));
  });
});

// ─── genDiagnosePhysicsScript ───────────────────────────────────────────────

describe('genDiagnosePhysicsScript', () => {
  it('contains move_and_collide', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    assert.ok(script.includes('move_and_collide'));
    assert.ok(script.includes('ConcavePolygonShape3D'));
  });
  it('contains velocity and position info', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    assert.ok(script.includes('velocity'));
    assert.ok(script.includes('position'));
  });
});

// ─── genQuerySpatialScript ──────────────────────────────────────────────────

describe('genQuerySpatialScript', () => {
  it('contains intersect_shape', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10);
    assert.ok(script.includes('intersect_shape'));
    assert.ok(script.includes('SphereShape3D'));
    assert.ok(script.includes('radius = 10'));
  });
  it('includes collision_mask when provided', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10, 0xFF);
    assert.ok(script.includes('collision_mask'));
  });
});
