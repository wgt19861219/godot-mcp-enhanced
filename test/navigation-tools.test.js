import { expect, it, describe } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  handleTool,
  genNavQueryScript,
} from '../src/tools/navigation.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('navigation getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBeGreaterThan(0);
  });
  it('returns 6 definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(6);
  });
  const expected = [
    'nav_create_region',
    'nav_bake_mesh',
    'nav_create_agent',
    'nav_set_params',
    'nav_create_link',
    'nav_query_path',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names.includes(name)).toBeTruthy();
    });
  }
  it('each definition has name and inputSchema', () => {
    for (const def of getToolDefinitions()) {
      expect(def.name).toBeTruthy();
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('navigation TOOL_META', () => {
  it('has entries for all nav tools', () => {
    const expected = [
      'nav_create_region',
      'nav_bake_mesh',
      'nav_create_agent',
      'nav_set_params',
      'nav_create_link',
      'nav_query_path',
    ];
    for (const name of expected) {
      expect(name in TOOL_META).toBeTruthy();
    }
  });
  it('nav_bake_mesh is long_running', () => {
    expect(TOOL_META.nav_bake_mesh.long_running).toBe(true);
  });
  it('nav_query_path is readonly', () => {
    expect(TOOL_META.nav_query_path.readonly).toBe(true);
  });
  it('nav_create_region is non-readonly and not long_running', () => {
    expect(TOOL_META.nav_create_region.readonly).toBe(false);
    expect(TOOL_META.nav_create_region.long_running).toBe(false);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('navigation handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('nav_create_region rejects missing name', async () => {
    const result = await handleTool('nav_create_region', {
      project_path: '/fake/project',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('nav_set_params rejects missing params', async () => {
    const result = await handleTool('nav_set_params', {
      project_path: '/fake/project',
      node_path: 'root/Agent',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('nav_set_params rejects empty params object', async () => {
    const result = await handleTool('nav_set_params', {
      project_path: '/fake/project',
      node_path: 'root/Agent',
      params: {},
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('nav_create_link rejects missing name', async () => {
    const result = await handleTool('nav_create_link', {
      project_path: '/fake/project',
      start_position: { x: 0, y: 0, z: 0 },
      end_position: { x: 1, y: 0, z: 1 },
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('nav_create_agent rejects missing name', async () => {
    const result = await handleTool('nav_create_agent', {
      project_path: '/fake/project',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// ─── genNavQueryScript (pure function, no mock needed) ───────────────────────

describe('genNavQueryScript', () => {
  it('generates script with NavigationServer3D calls', () => {
    const script = genNavQueryScript(
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    );
    expect(script.includes('NavigationServer3D')).toBeTruthy();
    expect(script.includes('map_get_path')).toBeTruthy();
  });

  it('includes start_pos coordinates', () => {
    const script = genNavQueryScript(
      { x: 10, y: 20, z: 30 },
      { x: 40, y: 50, z: 60 },
    );
    expect(script.includes('Vector3(10, 20, 30)')).toBeTruthy();
    expect(script.includes('Vector3(40, 50, 60)')).toBeTruthy();
  });

  it('includes default map resolution when no region', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect(script.includes('NavigationServer3D.get_maps()')).toBeTruthy();
  });

  it('includes region lookup when navigationRegion is provided', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      'root/Level/NavRegion',
    );
    expect(script.includes('root/Level/NavRegion')).toBeTruthy();
    expect(script.includes('region_get_map')).toBeTruthy();
  });

  it('outputs path data and length', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect(script.includes('_mcp_output("path"')).toBeTruthy();
    expect(script.includes('_mcp_output("path_length"')).toBeTruthy();
  });

  it('handles zero coordinates', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    );
    expect(script.includes('Vector3(0, 0, 0)')).toBeTruthy();
  });
});
