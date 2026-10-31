// 批 B1 (2026-10-26): scene.commit dry_run 只读预检测试。
// 生成器结构断言 + parseValidateResult + handler 分流(mock executeGdscript)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const probeMock = vi.fn();
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscriptRuntime: (...a: unknown[]) => probeMock(...a),
}));

import { generateValidateScript } from '../src/tools/scene/scene-commit.js';
import { parseValidateResult, handleCommitAction } from '../src/tools/scene/scene-commit-tool.js';
import { requiresConfirmation } from '../src/core/guard.js';

describe('generateValidateScript(批 B1)', () => {
  it('tile op 生成节点存在性+类型探测块', () => {
    const s = generateValidateScript('res://a.tscn', [
      { op: 'tile_set', node_path: 'Grid', coords: { x: 1, y: 1 }, source_id: 0, atlas: { x: 0, y: 0 } } as never,
    ]);
    expect(s).toContain('get_node_or_null("Grid")');
    expect(s).toContain('NODE_NOT_FOUND');
    expect(s).toContain('NODE_TYPE_MISMATCH');
    expect(s).toContain('expected TileMap/TileMapLayer');
    expect(s).not.toContain('set_cell'); // 只读:不含任何写操作
    expect(s).not.toContain('ResourceSaver'); // 不落盘
  });

  it('layer 越界检查嵌在 load 成功分支内(防 null.get_... 崩溃回归)', () => {
    const s = generateValidateScript('res://a.tscn', [
      { op: 'tileset_physics_layer_set', tileset_path: 'res://t.tres', layer: 5 } as never,
    ]);
    const lines = s.split('\n');
    const nullIdx = lines.findIndex(l => l.includes('_0ts == null'));
    const elseIdx = lines.findIndex(l => l === '\t\telse:'); // load-null 分支的 else(2-tab 精确匹配)
    const layerIdx = lines.findIndex(l => l.includes('get_physics_layers_count() <= 5'));
    expect(nullIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeGreaterThan(nullIdx); // load-null 的 else 在其后
    expect(layerIdx).toBeGreaterThan(elseIdx); // layer 检查在 else 内
    expect(lines[layerIdx]!.startsWith('\t\t\tif')).toBe(true); // 3-tab = else 分支体内(2-tab else 一层里)
    expect(s).toContain('TILESET_NOT_FOUND');
    expect(s).toContain('LAYER_OUT_OF_RANGE');
  });

  it('node_add 探测 parent 存在性;"."/"root" 豁免(与执行侧语义一致)', () => {
    const s = generateValidateScript('res://a.tscn', [
      { op: 'node_add', name: 'N', type: 'Node2D', parent: 'BadParent' } as never,
    ]);
    expect(s).toContain('get_node_or_null("BadParent")');
    expect(s).toContain('PARENT_NOT_FOUND');
    const s2 = generateValidateScript('res://a.tscn', [
      { op: 'node_add', name: 'N', type: 'Node2D', parent: '.' } as never,
    ]);
    expect(s2).not.toContain('PARENT_NOT_FOUND');
  });

  it('node_property 探测目标节点;无可探测前置的 op 保留占位注释', () => {
    const s = generateValidateScript('res://a.tscn', [
      { op: 'node_property', path: 'Bad/Path', property: 'x', value: 1 } as never,
      { op: 'node_add', name: 'N', type: 'Node2D' } as never, // 无 parent(默认挂根)→ 无探测面
    ]);
    expect(s).toContain('get_node_or_null("Bad/Path")');
    expect(s).toContain('no probeable preconditions'); // 显式占位
  });

  it('顶层输出 VALIDATE_RESULT;场景加载失败报 SCENE_LOAD_FAILED 且 ok=false', () => {
    const s = generateValidateScript('res://a.tscn', []);
    expect(s).toContain('print("VALIDATE_RESULT: "');
    expect(s).toContain('"ok": _issues.is_empty()');
    expect(s).toContain('SCENE_LOAD_FAILED');
  });
});

// 三审遗留2(L-2 收尾):探测脚本动态生成、从未过真 Godot 编译(批 B 审查 Nit-5 自知)。
// 补法:代表性 ops 的生成输出固化为静态 fixture 落进 gdscript-check 项目,由
// check:gdscript(godot --headless --import 项目级编译)覆盖;本测试锚定 fixture 与
// 生成器同步——生成器改动使输出漂移时此处红,UPDATE_FIXTURE=1 重生成并人工复核 diff。
const PROBE_SAMPLE_OPS = [
  // 块1:tile op 节点存在性+类型
  { op: 'tile_set', node_path: 'Grid', coords: { x: 1, y: 1 }, source_id: 0, atlas: { x: 0, y: 0 } },
  // 块2+3:TileSet 资源存在性 + physics layer 越界
  { op: 'tileset_physics_layer_set', tileset_path: 'res://fixtures/tileset.tres', layer: 5, collision_layer: 1, collision_mask: 1 },
  // 块2 无 layer 形态(资源存在性独立)
  { op: 'tileset_custom_data_layer_add', tileset_path: 'res://fixtures/tileset.tres', name: 'cd', type: 'int' },
  // 块3:node_add 父节点存在性
  { op: 'node_add', name: 'Marker', type: 'Node2D', parent: 'Sub' },
  // 块4:node_property 目标节点存在性
  { op: 'node_property', path: 'Marker', property: 'position', value: 1 },
  // 块5:无探测面占位(默认挂根,无 parent)
  { op: 'node_add', name: 'RootChild', type: 'Node2D' },
] as never[];

describe('探测脚本真 Godot 编译锚(三审遗留2)', () => {
  it('代表性 ops 生成输出 == fixture 快照(validate_probe_sample.gd 随 check:gdscript 编译)', () => {
    const generated = generateValidateScript('res://test_main.tscn', PROBE_SAMPLE_OPS);
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/gdscript-check/validate_probe_sample.gd');
    if (process.env.UPDATE_FIXTURE === '1') {
      writeFileSync(fixturePath, generated, 'utf8');
      return;
    }
    const fixture = readFileSync(fixturePath, 'utf8');
    expect(generated).toBe(fixture);
  });
});

describe('parseValidateResult', () => {  it('解析 VALIDATE_RESULT marker;与 COMMIT_RESULT 不串扰', () => {
    const out = 'noise\nVALIDATE_RESULT: {"ok":false,"issues":[{"op_index":0,"code":"NODE_NOT_FOUND","message":"m"}]}';
    const r = parseValidateResult(out);
    expect(r).toEqual({ ok: false, issues: [{ op_index: 0, code: 'NODE_NOT_FOUND', message: 'm' }] });
    expect(parseValidateResult('COMMIT_RESULT: {"success":true}')).toBeNull();
    expect(parseValidateResult('no marker')).toBeNull();
  });
});

describe('handleCommitAction dry_run 分流(批 B1)', () => {
  beforeEach(() => { probeMock.mockReset(); });

  const mkCtx = () => ({
    findGodot: async () => 'godot',
    checkEditorSceneSave: undefined,
  }) as never;

  it('dry_run=true:执行探测脚本,返回 plan/issues/would_write,不生成变更脚本', async () => {
    probeMock.mockResolvedValue({
      raw_output: 'VALIDATE_RESULT: {"ok":false,"issues":[{"op_index":0,"code":"NODE_NOT_FOUND","message":"node not found: Bad"}]}',
    });
    const r = await handleCommitAction({
      project_path: 'D:/proj', scene_path: 'scenes/a.tscn', dry_run: true, save: true,
      operations: [
        { op: 'tile_set', node_path: 'Bad', coords: { x: 1, y: 1 }, source_id: 0, atlas: { x: 0, y: 0 } },
        { op: 'tileset_physics_layer_add', tileset_path: 'res://t.tres', collision_layer: 1, collision_mask: 1 },
      ],
    }, mkCtx());
    const text = (r!.content![0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.dry_run).toBe(true);
    expect(parsed.ok).toBe(false);
    expect((parsed.issues as Array<{ code: string }>)[0]!.code).toBe('NODE_NOT_FOUND');
    expect((parsed.plan as Array<{ op: string; target?: string }>)).toHaveLength(2);
    expect((parsed.plan as Array<{ op: string; target?: string }>)[0]!.target).toBe('Bad');
    expect(parsed.would_write).toEqual(['scenes/a.tscn', 'res://t.tres']);
    // 探测脚本特征:无 set_cell/ResourceSaver(单对象参数:{code, ...})
    const call = probeMock.mock.calls[0]![0] as { code: string };
    expect(call.code).not.toContain('ResourceSaver');
    expect(call.code).toContain('VALIDATE_RESULT');
  });

  it('dry_run + save=false:would_write 为空;VALIDATE_RESULT 缺失时降级 VALIDATE_RESULT_MISSING', async () => {
    probeMock.mockResolvedValue({ raw_output: 'script crashed without marker' });
    const r = await handleCommitAction({
      project_path: 'D:/proj', scene_path: 'scenes/a.tscn', dry_run: true, save: false,
      operations: [{ op: 'node_property', path: 'P', property: 'x', value: 1 }],
    }, mkCtx());
    const parsed = JSON.parse((r!.content![0] as { text: string }).text) as Record<string, unknown>;
    expect(parsed.would_write).toEqual([]);
    expect((parsed.issues as Array<{ code: string }>)[0]!.code).toBe('VALIDATE_RESULT_MISSING');
  });
});

describe('dry_run 风险豁免(批 B1)', () => {
  it('requiresConfirmation: dry_run=true 免确认(不依赖 registry 元数据即可生效)', () => {
    expect(requiresConfirmation('scene', { action: 'commit', dry_run: true })).toBe(false);
  });
});
