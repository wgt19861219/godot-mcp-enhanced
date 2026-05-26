import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock gdscript-executor before importing the module under test
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => ({
    success: true,
    compile_success: true,
    compile_error: '',
    errors: [],
    run_success: true,
    run_error: '',
    outputs: [{ key: 'result', value: '{"ok":true}' }],
    raw_output: '',
    duration_ms: 100,
  })),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/particles.js';
import { executeGdscript } from '../src/gdscript-executor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(),
  };
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('particles getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has 5 tool definitions matching the module tools', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(5);
    const names = defs.map(d => d.name);
    expect(names).toContain('particles_create');
    expect(names).toContain('particles_set_emission');
    expect(names).toContain('particles_set_process');
    expect(names).toContain('particles_load_preset');
    expect(names).toContain('particles_set_material');
  });

  it('each definition has required inputSchema fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('particles TOOL_META', () => {
  it('has entries for all 5 tools', () => {
    expect(Object.keys(TOOL_META).length).toBe(5);
    expect(TOOL_META.particles_create).toBeDefined();
    expect(TOOL_META.particles_set_emission).toBeDefined();
    expect(TOOL_META.particles_set_process).toBeDefined();
    expect(TOOL_META.particles_load_preset).toBeDefined();
    expect(TOOL_META.particles_set_material).toBeDefined();
  });

  it('all tools are marked non-readonly and non-long-running', () => {
    for (const [, meta] of Object.entries(TOOL_META)) {
      expect(meta.readonly).toBe(false);
      expect(meta.long_running).toBe(false);
    }
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('particles handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — particles_create ──────────────────────────────────────────

describe('particles handleTool — particles_create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript and returns result for GPUParticles3D', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles3D',
      name: 'FireParticles',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('GPUParticles3D.new()');
    expect(callArgs.code).toContain('FireParticles');
  });

  it('uses Vector2 for GPUParticles2D position', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles2D',
      name: 'Spark',
      position: { x: 10, y: 20 },
    }, ctx);

    expect(result).not.toBeNull();
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Vector2(10, 20)');
  });

  it('uses Vector3 for GPUParticles3D position', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles3D',
      name: 'Smoke3D',
      position: { x: 1, y: 2, z: 3 },
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Vector3(1, 2, 3)');
  });

  it('returns error for invalid node_type', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'InvalidType',
      name: 'Bad',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_TYPE');
  });

  it('returns error for empty name', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles3D',
      name: '',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });

  it('applies fire preset lines when preset is specified', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles3D',
      name: 'MyFire',
      preset: 'fire',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('preset_applied');
  });

  it('returns error for unknown preset', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_create', {
      project_path: '/fake/project',
      node_type: 'GPUParticles3D',
      name: 'MyParticles',
      preset: 'nonexistent',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('PRESET_NOT_FOUND');
  });
});

// ─── handleTool — particles_set_emission ────────────────────────────────────

describe('particles handleTool — particles_set_emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates emission script with amount', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_set_emission', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      amount: 100,
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('node.amount = 100');
  });

  it('generates emission script with emission_shape sphere', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_set_emission', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      emission_shape: 'sphere',
      emission_sphere_radius: 5,
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('EMISSION_SHAPE_SPHERE');
    expect(callArgs.code).toContain('emission_sphere_radius = 5');
  });

  it('returns error for invalid emission_shape', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_set_emission', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      emission_shape: 'invalid',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });
});

// ─── handleTool — particles_set_process ─────────────────────────────────────

describe('particles handleTool — particles_set_process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates process script with gravity', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_set_process', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      gravity: { x: 0, y: -9.8, z: 0 },
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Vector3(0, -9.8, 0)');
  });

  it('generates process script with lifetime and speed_scale', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_set_process', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      lifetime: 3.0,
      speed_scale: 2.0,
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('node.speed_scale = 2');
    expect(callArgs.code).toContain('node.lifetime = 3');
  });

  it('returns error for negative lifetime', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_set_process', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      lifetime: -1,
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });
});

// ─── handleTool — particles_load_preset ─────────────────────────────────────

describe('particles handleTool — particles_load_preset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads fire preset and calls executor', async () => {
    const ctx = createMockCtx();
    await handleTool('particles_load_preset', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      preset: 'fire',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('preset_loaded');
    expect(callArgs.code).toContain('fire');
  });

  it('returns error for unknown preset', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_load_preset', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
      preset: 'nonexistent',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('PRESET_NOT_FOUND');
  });
});

// ─── handleTool — particles_set_material ────────────────────────────────────

describe('particles handleTool — particles_set_material', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates material creation script', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('particles_set_material', {
      project_path: '/fake/project',
      node_path: 'root/Particles',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('ParticleProcessMaterial.new()');
  });
});
