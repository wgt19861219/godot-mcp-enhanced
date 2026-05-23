import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genIkCreateScript,
  genIkGetScript,
  genIkSetScript,
  genListBonesScript,
} from '../build/tools/ik-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('ik-tools TOOL_NAMES', () => {
  it('contains exactly 4 tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 4);
  });
  const expected = ['ik_modifier_create', 'ik_modifier_get', 'ik_modifier_set', 'ik_list_bones'];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      assert.ok(TOOL_NAMES.includes(name));
    });
  }
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('ik-tools getToolDefinitions', () => {
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

// ─── genIkCreateScript ──────────────────────────────────────────────────────

describe('genIkCreateScript', () => {
  it('generates valid GDScript with type and name', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'RightArmIK', 'root/Player/Skeleton3D');
    assert.ok(script.includes('TwoBoneIK3D.new()'));
    assert.ok(script.includes('RightArmIK'));
    assert.ok(script.includes('root/Player/Skeleton3D'));
  });
  it('includes position when provided', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', { x: 1, y: 2, z: 3 });
    assert.ok(script.includes('Vector3(1, 2, 3)'));
  });
  it('includes bone_name and target_nodepath', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', undefined, 'RightArm', 'root/Target');
    assert.ok(script.includes('RightArm'));
    assert.ok(script.includes('root/Target'));
    assert.ok(script.includes('NodePath'));
  });
});

// ─── genIkGetScript ─────────────────────────────────────────────────────────

describe('genIkGetScript', () => {
  it('contains node path and property reads', () => {
    const script = genIkGetScript('root/Player/IK');
    assert.ok(script.includes('root/Player/IK'));
    assert.ok(script.includes('ik_node.active'));
    assert.ok(script.includes('ik_node.influence'));
    assert.ok(script.includes('bone_name'));
    assert.ok(script.includes('target_nodepath'));
  });
});

// ─── genIkSetScript ─────────────────────────────────────────────────────────

describe('genIkSetScript', () => {
  it('sets active and influence', () => {
    const script = genIkSetScript('root/IK', { active: true, influence: 0.5 });
    assert.ok(script.includes('ik_node.active = true'));
    assert.ok(script.includes('ik_node.influence = 0.5'));
  });
  it('sets bone_name and magnet_position', () => {
    const script = genIkSetScript('root/IK', {
      bone_name: 'RightArm',
      magnet_position: { x: 0.1, y: 0.2, z: 0.3 },
    });
    assert.ok(script.includes('RightArm'));
    assert.ok(script.includes('Vector3(0.1, 0.2, 0.3)'));
  });
});

// ─── genListBonesScript ─────────────────────────────────────────────────────

describe('genListBonesScript', () => {
  it('contains Skeleton3D check and bone iteration', () => {
    const script = genListBonesScript('root/Player/Skeleton3D');
    assert.ok(script.includes('Skeleton3D'));
    assert.ok(script.includes('get_bone_count'));
    assert.ok(script.includes('get_bone_name'));
    assert.ok(script.includes('get_bone_rest'));
  });
  it('includes limit when provided', () => {
    const script = genListBonesScript('root/Skeleton3D', 10);
    assert.ok(script.includes('10'));
  });
});
