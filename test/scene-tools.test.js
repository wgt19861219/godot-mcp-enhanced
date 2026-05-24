import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToolDefinitions } from '../build/tools/scene.js';

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('scene-tools getToolDefinitions', () => {
  const defs = getToolDefinitions();

  it('returns 14 tool definitions', () => {
    assert.strictEqual(defs.length, 14);
  });

  const expected = [
    'read_scene', 'create_scene', 'add_node', 'save_scene', 'load_sprite',
    'quick_scene', 'query_scene_tree', 'inspect_node', 'batch_add_nodes',
    'edit_node', 'remove_node', 'instance_scene', 'set_instance_property',
    'detach_instance',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      assert.ok(defs.some(d => d.name === name), `missing: ${name}`);
    });
  }

  it('every tool has description and inputSchema', () => {
    for (const d of defs) {
      assert.ok(d.description, `${d.name} missing description`);
      assert.ok(d.inputSchema, `${d.name} missing inputSchema`);
      assert.strictEqual(d.inputSchema.type, 'object');
    }
  });

  it('destructive tools have project_path as required', () => {
    const destructive = ['add_node', 'edit_node', 'remove_node', 'create_scene'];
    for (const name of destructive) {
      const d = defs.find(t => t.name === name);
      assert.ok(d?.inputSchema.required?.includes('project_path'), `${name} missing project_path required`);
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
    const { parseTscn } = await import('../build/tscn-parser.js');
    const content = readFileSync(sceneFile, 'utf-8');
    const parsed = parseTscn(content);

    assert.strictEqual(parsed.nodes.length, 3);
    assert.strictEqual(parsed.nodes[0].name, 'Player');
    assert.strictEqual(parsed.nodes[0].type, 'CharacterBody2D');
    assert.strictEqual(parsed.nodes[1].name, 'Sprite2D');
    assert.strictEqual(parsed.nodes[1].parent, '.');
    assert.strictEqual(parsed.extResources.length, 1);
    assert.strictEqual(parsed.extResources[0].path, 'res://player.gd');
  });
});
