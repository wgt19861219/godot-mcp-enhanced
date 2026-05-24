import { expect } from 'vitest';
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
    expect(TOOL_NAMES.length).toBe(4);
  });
  it('includes physics_raycast', () => {
    expect(TOOL_NAMES.includes('physics_raycast')).toBeTruthy();
  });
  it('includes physics_body_info', () => {
    expect(TOOL_NAMES.includes('physics_body_info')).toBeTruthy();
  });
  it('includes diagnose_physics', () => {
    expect(TOOL_NAMES.includes('diagnose_physics')).toBeTruthy();
  });
  it('includes query_spatial', () => {
    expect(TOOL_NAMES.includes('query_spatial')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('physics-ops getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      expect(names.includes(tn)).toBeTruthy();
    }
  });
});

// ─── genRaycastScript ───────────────────────────────────────────────────────

describe('genRaycastScript', () => {
  it('contains PhysicsRayQueryParameters3D.create', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0});
    expect(script.includes('PhysicsRayQueryParameters3D.create')).toBeTruthy();
    expect(script.includes('Vector3(0, 0, 0)')).toBeTruthy();
    expect(script.includes('Vector3(10, 0, 0)')).toBeTruthy();
    expect(script.includes('root.get_world_3d()')).toBeTruthy();
  });
  it('includes collision_mask when provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, 0b111);
    expect(script.includes('collision_mask = 7')).toBeTruthy();
  });
  it('includes exclude logic when paths provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, undefined, ['/root/Wall', '/root/Floor']);
    expect(script.includes('exclude')).toBeTruthy();
    expect(script.includes('/root/Wall')).toBeTruthy();
    expect(script.includes('/root/Floor')).toBeTruthy();
  });
});

// ─── genBodyInfoScript ──────────────────────────────────────────────────────

describe('genBodyInfoScript', () => {
  it('contains CollisionShape3D scan', () => {
    const script = genBodyInfoScript('/root/Player');
    expect(script.includes('CollisionShape3D')).toBeTruthy();
    expect(script.includes('_mcp_get_node("/root/Player")')).toBeTruthy();
    expect(script.includes('has_collision')).toBeTruthy();
  });
  it('contains collision_layer and collision_mask', () => {
    const script = genBodyInfoScript('/root/Player');
    expect(script.includes('collision_layer')).toBeTruthy();
    expect(script.includes('collision_mask')).toBeTruthy();
  });
});

// ─── genDiagnosePhysicsScript ───────────────────────────────────────────────

describe('genDiagnosePhysicsScript', () => {
  it('contains move_and_collide', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    expect(script.includes('move_and_collide')).toBeTruthy();
    expect(script.includes('ConcavePolygonShape3D')).toBeTruthy();
  });
  it('contains velocity and position info', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    expect(script.includes('velocity')).toBeTruthy();
    expect(script.includes('position')).toBeTruthy();
  });
});

// ─── genQuerySpatialScript ──────────────────────────────────────────────────

describe('genQuerySpatialScript', () => {
  it('contains intersect_shape', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10);
    expect(script.includes('intersect_shape')).toBeTruthy();
    expect(script.includes('SphereShape3D')).toBeTruthy();
    expect(script.includes('radius = 10')).toBeTruthy();
  });
  it('includes collision_mask when provided', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10, 0xFF);
    expect(script.includes('collision_mask')).toBeTruthy();
  });
});
