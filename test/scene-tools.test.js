import { expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToolDefinitions } from '../src/tools/scene.js';
import { SCENE_TREE_HEADER, parseGdscriptResult } from '../src/tools/shared.js';

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('scene-tools getToolDefinitions', () => {
  const defs = getToolDefinitions();

  it('returns 1 merged tool definition (scene)', () => {
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('scene');
  });

  it('action enum includes all 14 operations', () => {
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    const expected = [
      'read_scene', 'create_scene', 'add_node', 'save_scene', 'load_sprite',
      'quick_scene', 'query_scene_tree', 'inspect_node', 'batch_add_nodes',
      'edit_node', 'remove_node', 'instance_scene', 'set_instance_property',
      'detach_instance',
    ];
    for (const op of expected) {
      expect(actionEnum).toContain(op);
    }
  });

  it('tool has description and inputSchema', () => {
    const d = defs[0];
    expect(d.description).toBeTruthy();
    expect(d.inputSchema).toBeTruthy();
    expect(d.inputSchema.type).toBe('object');
  });

  it('tool has action as required', () => {
    const d = defs[0];
    expect(d.inputSchema.required).toContain('action');
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
    const { parseTscn } = await import('../src/tscn/tscn-parser.js');
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

// ─── scene 加载失败诊断增强（Task D4, 2026-11-12）──────────────────────────
// 反馈：headless 加载绑 autoload 依赖脚本的场景必编译失败，裸 "Failed to load scene"
// 无归因、引擎原始错误行被 parseGdscriptResult 整组丢弃。

describe('scene load 失败诊断增强（Task D4）', () => {
  it('SCENE_TREE_HEADER 的 _mcp_load_scene null 分支含编译失败归因提示', () => {
    // 归因文案锚点（brief Step 1）：scene or its attached scripts failed to compile — check script dependencies/autoloads
    expect(SCENE_TREE_HEADER).toContain('scene or its attached scripts failed to compile');
    expect(SCENE_TREE_HEADER).toContain('check script dependencies/autoloads');
    // 前缀保持 "Failed to load scene"（scene-instance errorMapper 的 LOAD_FAILED 匹配依赖此子串）
    const m = SCENE_TREE_HEADER.match(/_mcp_output\("error", "Failed to load scene: " \+ sp[^)]*\)/);
    expect(m).toBeTruthy();
  });

  it('compile 失败消息附引擎原始错误行（前 5 行 + 溢出计数，不再裸丢）', () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({
      type: 'parse_error',
      message: `Parse Error: unexpected token on line ${i + 1}`,
      file: `res://script_${i}.gd`,
      line: i + 1,
      suggestion: 'fix syntax',
    }));
    const r = parseGdscriptResult({
      success: false,
      compile_success: false,
      compile_error: 'SCRIPT ERROR: Parse Error: ...',
      errors,
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: 0,
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('SCRIPT_EXEC_FAILED');
    expect(parsed.error).toContain('SCRIPT ERROR: Parse Error: ...');
    // 前 5 行逐条可见（file:line: message 形态）
    expect(parsed.error).toContain('res://script_0.gd:1: Parse Error: unexpected token on line 1');
    expect(parsed.error).toContain('res://script_4.gd:5: Parse Error: unexpected token on line 5');
    // 第 6 行起截断，附溢出计数
    expect(parsed.error).not.toContain('res://script_5.gd');
    expect(parsed.error).toContain('+2 more');
  });

  it('errorMapper 出的 LOAD_FAILED 消息同样附引擎错误行（场景加载失败路径）', () => {
    // 复刻 scene-instance.ts 的 errorMapper（LOAD_FAILED 分支）
    const mapper = (msg) => {
      if (msg.includes('not found')) return 'NODE_NOT_FOUND';
      if (msg.includes('not a PackedScene')) return 'INVALID_RESOURCE';
      if (msg.includes('Failed to load')) return 'LOAD_FAILED';
      return 'SCRIPT_EXEC_FAILED';
    };
    const r = parseGdscriptResult({
      success: false,
      compile_success: true,
      compile_error: '',
      errors: [
        {
          type: 'script_error',
          message: 'Identifier not found: DataRegistry',
          file: 'res://player.gd',
          line: 12,
          suggestion: '',
        },
      ],
      run_success: true,
      run_error: '',
      outputs: [{
        key: 'error',
        value: 'Failed to load scene: D:/proj/scenes/main.tscn — scene or its attached scripts failed to compile, check script dependencies/autoloads',
      }],
      raw_output: '',
      duration_ms: 0,
    }, [], mapper);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('LOAD_FAILED');
    expect(parsed.error).toContain('Failed to load scene');
    expect(parsed.error).toContain('res://player.gd:12: Identifier not found: DataRegistry');
  });

  it('errors 为空时消息保持原样（不拼空段）', () => {
    const r = parseGdscriptResult({
      compile_success: false, compile_error: 'syntax error',
      errors: [], run_success: false, run_error: '', outputs: [],
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('syntax error');
  });
});
