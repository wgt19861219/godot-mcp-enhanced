import { expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToolDefinitions } from '../src/tools/scene.js';

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('scene-tools getToolDefinitions', () => {
  const defs = getToolDefinitions();

  it('returns 14 tool definitions', () => {
    expect(defs.length).toBe(14);
  });

  const expected = [
    'read_scene', 'create_scene', 'add_node', 'save_scene', 'load_sprite',
    'quick_scene', 'query_scene_tree', 'inspect_node', 'batch_add_nodes',
    'edit_node', 'remove_node', 'instance_scene', 'set_instance_property',
    'detach_instance',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(defs.some(d => d.name === name)).toBeTruthy();
    });
  }

  it('every tool has description and inputSchema', () => {
    for (const d of defs) {
      expect(d.description).toBeTruthy();
      expect(d.inputSchema).toBeTruthy();
      expect(d.inputSchema.type).toBe('object');
    }
  });

  it('destructive tools have project_path as required', () => {
    const destructive = ['add_node', 'edit_node', 'remove_node', 'create_scene'];
    for (const name of destructive) {
      const d = defs.find(t => t.name === name);
      expect(d?.inputSchema.required?.includes('project_path')).toBeTruthy();
    }
  });
});

// ─── read_scene with tscn parsing (file-system test) ──────────────────────

describe('scene-tools read_scene (tscn parsing)', () => {
  const tmpDir = join(import.meta.dirname, '__test_scene_read__');
  const sceneFile = join(tmpDir, 'test.tscn');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(sceneFile, [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[ext_resource type="Script" path="res://player.gd" id="1"]',
      '',
      '[node name="Player" type="CharacterBody2D"]',
      'script = ExtResource("1")',
      '',
      '[node name="Sprite2D" type="Sprite2D" parent="."]',
      '',
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="."]',
      '',
    ].join('\n'), 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parseTscn resolves the written file correctly', async () => {
    const { parseTscn } = await import('../src/tscn-parser.js');
    const content = readFileSync(sceneFile, 'utf-8');
    const parsed = parseTscn(content);

    expect(parsed.nodes.length).toBe(3);
    expect(parsed.nodes[0].name).toBe('Player');
    expect(parsed.nodes[0].type).toBe('CharacterBody2D');
    expect(parsed.nodes[1].name).toBe('Sprite2D');
    expect(parsed.nodes[1].parent).toBe('.');
    expect(parsed.extResources.length).toBe(1);
    expect(parsed.extResources[0].path).toBe('res://player.gd');
  });
});
