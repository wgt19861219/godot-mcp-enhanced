import { expect } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genIkCreateScript,
  genIkGetScript,
  genIkSetScript,
  genListBonesScript,
} from '../src/tools/ik-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('ik-tools TOOL_NAMES', () => {
  it('contains exactly 4 tool names', () => {
    expect(TOOL_NAMES.length).toBe(4);
  });
  const expected = ['ik_modifier_create', 'ik_modifier_get', 'ik_modifier_set', 'ik_list_bones'];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(TOOL_NAMES.includes(name)).toBeTruthy();
    });
  }
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('ik-tools getToolDefinitions', () => {
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

// ─── genIkCreateScript ──────────────────────────────────────────────────────

describe('genIkCreateScript', () => {
  it('generates valid GDScript with type and name', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'RightArmIK', 'root/Player/Skeleton3D');
    expect(script.includes('TwoBoneIK3D.new()')).toBeTruthy();
    expect(script.includes('RightArmIK')).toBeTruthy();
    expect(script.includes('root/Player/Skeleton3D')).toBeTruthy();
  });
  it('includes position when provided', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', { x: 1, y: 2, z: 3 });
    expect(script.includes('Vector3(1, 2, 3)')).toBeTruthy();
  });
  it('includes bone_name and target_nodepath', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', undefined, 'RightArm', 'root/Target');
    expect(script.includes('RightArm')).toBeTruthy();
    expect(script.includes('root/Target')).toBeTruthy();
    expect(script.includes('NodePath')).toBeTruthy();
  });
});

// ─── genIkGetScript ─────────────────────────────────────────────────────────

describe('genIkGetScript', () => {
  it('contains node path and property reads', () => {
    const script = genIkGetScript('root/Player/IK');
    expect(script.includes('root/Player/IK')).toBeTruthy();
    expect(script.includes('ik_node.active')).toBeTruthy();
    expect(script.includes('ik_node.influence')).toBeTruthy();
    expect(script.includes('bone_name')).toBeTruthy();
    expect(script.includes('target_nodepath')).toBeTruthy();
  });
});

// ─── genIkSetScript ─────────────────────────────────────────────────────────

describe('genIkSetScript', () => {
  it('sets active and influence', () => {
    const script = genIkSetScript('root/IK', { active: true, influence: 0.5 });
    expect(script.includes('ik_node.active = true')).toBeTruthy();
    expect(script.includes('ik_node.influence = 0.5')).toBeTruthy();
  });
  it('sets bone_name and magnet_position', () => {
    const script = genIkSetScript('root/IK', {
      bone_name: 'RightArm',
      magnet_position: { x: 0.1, y: 0.2, z: 0.3 },
    });
    expect(script.includes('RightArm')).toBeTruthy();
    expect(script.includes('Vector3(0.1, 0.2, 0.3)')).toBeTruthy();
  });
});

// ─── genListBonesScript ─────────────────────────────────────────────────────

describe('genListBonesScript', () => {
  it('contains Skeleton3D check and bone iteration', () => {
    const script = genListBonesScript('root/Player/Skeleton3D');
    expect(script.includes('Skeleton3D')).toBeTruthy();
    expect(script.includes('get_bone_count')).toBeTruthy();
    expect(script.includes('get_bone_name')).toBeTruthy();
    expect(script.includes('get_bone_rest')).toBeTruthy();
  });
  it('includes limit when provided', () => {
    const script = genListBonesScript('root/Skeleton3D', 10);
    expect(script.includes('10')).toBeTruthy();
  });
});
