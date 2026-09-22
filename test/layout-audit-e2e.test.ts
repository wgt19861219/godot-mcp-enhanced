// test/layout-audit-e2e.test.ts — 布局审计 A→B 端到端闭环（真跑 Godot）
//
// 兑现方案验收两项（2026-09-22 布局审计批遗留待办）：
//   1. 能力 A "同皮肤行实例×3" 真机验收——3 棵同构行子树（各含同名内部节点
//      nameLabel/priceLabel，等价于 ShopCommonItemSkin 实例×3 的重名形态），
//      断言 _2/_3 平铺后缀 + hidden 分组 + visible_only 剪枝。
//   2. A→B 闭环——GD 侧 dump_layout_tree 的导出 JSON 直接喂给 TS 侧
//      analysis.layout_compare，断言 DRIFT/MISSING/EXTRA 检出（数值审计工作流
//      的最小闭环验证，不依赖单测的自造 fixture）。
// 探针模式同 p7-unit：实例化 mcp_bridge.gd（不 add_child，server 不启），
// RESULT 行回传；skipIf 无 GODOT_PATH。
import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeGdscript } from '../src/gdscript-executor.js';
import { handleTool } from '../src/tools/analysis/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CHECK_PROJECT = resolve(REPO, 'test/fixtures/gdscript-check');
const GODOT_PATH = process.env.GODOT_PATH ?? '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

const PROBE = [
  'extends SceneTree',
  'func _init():',
  '\tvar B = load("res://src/scripts/mcp_bridge.gd")',
  '\tvar b = B.new()',
  // 商城面板形态：3 棵同构行子树（内部同名 nameLabel/priceLabel）+ 隐藏层（内含又一个 nameLabel）
  '\tvar panel := Control.new()',
  '\tpanel.name = "ShopPanel"',
  '\tpanel.position = Vector2(10, 20)',
  '\tpanel.size = Vector2(400, 300)',
  '\tfor i in 3:',
  '\t\tvar row := Control.new()',
  '\t\trow.name = "row%d" % i',
  '\t\tvar nl := Label.new()',
  '\t\tnl.name = "nameLabel"',
  '\t\tnl.position = Vector2(5, 3 + i * 30)',
  '\t\tnl.size = Vector2(80, 24)',
  '\t\tvar pl := Label.new()',
  '\t\tpl.name = "priceLabel"',
  '\t\tpl.position = Vector2(200, 3 + i * 30)',
  '\t\tpl.size = Vector2(50, 24)',
  '\t\trow.add_child(nl)',
  '\t\trow.add_child(pl)',
  '\t\tpanel.add_child(row)',
  '\tvar locked := Control.new()',
  '\tlocked.name = "lockedLayer"',
  '\tlocked.visible = false',
  '\tvar hl := Label.new()',
  '\thl.name = "nameLabel"',
  '\tlocked.add_child(hl)',
  '\tpanel.add_child(locked)',
  '\troot.add_child(panel)',
  '\tawait process_frame',
  '\tvar out := {}',
  '\tvar hidden := {}',
  '\tb._collect_layout(panel, out, hidden, 0, 32, false)',
  '\tprint("RESULT controls=", JSON.stringify(out))',
  '\tprint("RESULT hidden=", JSON.stringify(hidden))',
  '\tvar out2 := {}',
  '\tvar hidden2 := {}',
  '\tb._collect_layout(panel, out2, hidden2, 0, 32, true)',
  '\tprint("RESULT vo_controls=", JSON.stringify(out2))',
  '\tprint("RESULT vo_hidden=", JSON.stringify(hidden2))',
  '\tb.free()',
  '\tquit()',
].join('\n');

// 原生后缀名碰撞（审查 R2-5 回归）：row0 内原生就有 nameLabel_2（皮肤自带
// Foo_2 形态），row1 跨子树重名 nameLabel 平铺 _2 时撞原生 → N-1 while 循环
// 递增至 _3，原生条目不被覆盖。坐标故意错开以区分两个来源。
const PROBE2 = [
  'extends SceneTree',
  'func _init():',
  '\tvar B = load("res://src/scripts/mcp_bridge.gd")',
  '\tvar b = B.new()',
  '\tvar panel := Control.new()',
  '\tpanel.name = "panel2"',
  '\tpanel.position = Vector2(10, 20)',
  '\tpanel.size = Vector2(400, 120)',
  '\tvar row0 := Control.new()',
  '\trow0.name = "row0"',
  '\tvar a := Label.new()',
  '\ta.name = "nameLabel"',
  '\ta.position = Vector2(5, 5)',
  '\ta.size = Vector2(80, 24)',
  '\tvar native2 := Label.new()',
  '\tnative2.name = "nameLabel_2"',
  '\tnative2.position = Vector2(90, 5)',
  '\tnative2.size = Vector2(80, 24)',
  '\trow0.add_child(a)',
  '\trow0.add_child(native2)',
  '\tpanel.add_child(row0)',
  '\tvar row1 := Control.new()',
  '\trow1.name = "row1"',
  '\tvar c := Label.new()',
  '\tc.name = "nameLabel"',
  '\tc.position = Vector2(5, 35)',
  '\tc.size = Vector2(80, 24)',
  '\trow1.add_child(c)',
  '\tpanel.add_child(row1)',
  '\troot.add_child(panel)',
  '\tawait process_frame',
  '\tvar out := {}',
  '\tvar hidden := {}',
  '\tb._collect_layout(panel, out, hidden, 0, 32, false)',
  '\tprint("RESULT controls=", JSON.stringify(out))',
  '\tprint("RESULT hidden=", JSON.stringify(hidden))',
  '\tvar out2 := {}',
  '\tvar hidden2 := {}',
  '\tb._collect_layout(panel, out2, hidden2, 0, 32, true)',
  '\tprint("RESULT vo_controls=", JSON.stringify(out2))',
  '\tprint("RESULT vo_hidden=", JSON.stringify(hidden2))',
  '\tb.free()',
  '\tquit()',
].join('\n');

interface ProbeResult {
  controls: Record<string, number[]>;
  hidden: Record<string, number[]>;
  vo_controls: Record<string, number[]>;
  vo_hidden: Record<string, number[]>;
}

async function runProbe(code: string = PROBE): Promise<ProbeResult> {
  const result = await executeGdscript({ godotPath: GODOT_PATH, projectPath: CHECK_PROJECT, timeout: 30, code });
  const values: Record<string, string> = {};
  for (const line of result.raw_output.split('\n')) {
    const m = line.match(/^RESULT\s+(\S+?)=(.*)$/);
    if (m) values[m[1]!] = m[2]!;
  }
  const parse = (key: string): Record<string, number[]> => {
    const raw = values[key];
    if (!raw) throw new Error(`probe missing RESULT ${key}; raw=${result.raw_output.slice(0, 400)}`);
    return JSON.parse(raw) as Record<string, number[]>;
  };
  return { controls: parse('controls'), hidden: parse('hidden'), vo_controls: parse('vo_controls'), vo_hidden: parse('vo_hidden') };
}

describe.skipIf(!hasGodot)('布局审计 e2e（真跑 Godot：dump_layout_tree → layout_compare 闭环）', () => {
  it('E2E-1: 同构行实例×3 → nameLabel/_2/_3 平铺 + hidden 分组 + visible_only 剪枝', async () => {
    const { controls, hidden, vo_controls, vo_hidden } = await runProbe();

    // 3 行同名内部节点 → _2/_3 递增平铺（方案验收标准）。
    // 第 4 个 nameLabel 来自隐藏层 lockedLayer 的子节点——其自身 visible=true
    // （数据态正常）而父 visible=false：分组按「自身 visible」口径（参考 _probe.gd，
    // "内容态隐藏"指自身标志），故进 controls 拿 _4 后缀而非进 hidden。
    expect(Object.keys(controls).sort()).toEqual([
      'ShopPanel', 'nameLabel', 'nameLabel_2', 'nameLabel_3', 'nameLabel_4',
      'priceLabel', 'priceLabel_2', 'priceLabel_3', 'row0', 'row1', 'row2',
    ]);
    // hidden 分组只收自身 visible=false 的（lockedLayer 自身）
    expect(Object.keys(hidden).sort()).toEqual(['lockedLayer']);
    // 运行态 global 坐标（panel 10,20 偏移进 nameLabel 的 5,3 → 15,23）
    expect(controls['nameLabel']).toEqual([15, 23, 80, 24]);
    expect(controls['nameLabel_3']).toEqual([15, 83, 80, 24]); // 第三行 +60
    // visible_only 是视觉口径（is_visible_in_tree 等价：父隐藏整棵剪枝）——与分组
    // 的数据态口径有意不同：父隐藏但自身 visible=true 的 nameLabel_4 被剪掉
    expect(Object.keys(vo_controls).sort()).toEqual([
      'ShopPanel', 'nameLabel', 'nameLabel_2', 'nameLabel_3',
      'priceLabel', 'priceLabel_2', 'priceLabel_3', 'row0', 'row1', 'row2',
    ]);
    expect(Object.keys(vo_hidden)).toEqual([]);
  });

  it('E2E-2: GD 导出 JSON → layout_compare 检出 DRIFT/MISSING/EXTRA（A→B 闭环）', async () => {
    const { controls } = await runProbe();
    const dir = mkdtempSync(join(tmpdir(), 'layout-e2e-'));
    try {
      // ref = GD 导出原样；cand = 模拟迁移偏差：nameLabel x+5（DRIFT）、删 priceLabel_2（MISSING）、多 extraBtn（EXTRA）
      const cand: Record<string, number[]> = { ...controls };
      cand['nameLabel'] = [cand['nameLabel']![0]! + 5, cand['nameLabel']![1]!, 80, 24];
      delete cand['priceLabel_2'];
      cand['extraBtn'] = [1, 2, 30, 12];
      const refPath = join(dir, 'ref.json');
      const candPath = join(dir, 'cand.json');
      writeFileSync(refPath, JSON.stringify(controls), 'utf-8');
      writeFileSync(candPath, JSON.stringify(cand), 'utf-8');

      const ctxStub = {} as Parameters<typeof handleTool>[2];
      const res = await handleTool('analysis', { action: 'layout_compare', ref_path: refPath, cand_path: candPath, tol: 2 }, ctxStub);
      const text = res?.content[0]?.type === 'text' ? res.content[0].text : '';
      expect(text).toContain('DRIFT   nameLabel：x 15→20');
      expect(text).toContain('MISSING cand 缺控件 priceLabel_2');
      expect(text).toContain('EXTRA   cand 多控件 extraBtn');
      expect(text).toContain('TREE FAIL');
      expect(text).toContain('比对 10 项'); // 双侧共有 11-1(缺 priceLabel_2)=10；EXTRA/MISSING 不计入 comparedCount
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2E-3: 原生 nameLabel_2 碰撞——平铺避让递增至 _3 且原生条目不被覆盖', async () => {
    const { controls } = await runProbe(PROBE2);

    // row1 的跨子树重名 nameLabel：_2 撞原生 → N-1 while 递增至 _3
    expect(Object.keys(controls).sort()).toEqual([
      'nameLabel', 'nameLabel_2', 'nameLabel_3', 'panel2', 'row0', 'row1',
    ]);
    // 原生 nameLabel_2 保持自身坐标（一次性改名会静默覆盖成 row1 的坐标）
    expect(controls['nameLabel_2']).toEqual([100, 25, 80, 24]); // panel2(10,20)+native2(90,5)
    // 避让出的 _3 坐标来自 row1（panel2(10,20)+(5,35)）
    expect(controls['nameLabel_3']).toEqual([15, 55, 80, 24]);
  });
});
