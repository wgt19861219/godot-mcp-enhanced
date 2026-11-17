#!/usr/bin/env node
// scripts/refero-batch4-acceptance.mjs
// 批4 Task 4 靶子轻量验收驱动——periphery 层(extract_tree / export_doc / detail=compact)数字存档。
//
// 手工流程脚本(批1/2/3 同款纪律):靶子路径不在本仓,CI 永不跑;GODOT_PATH + 靶子
// 项目存在双门控,缺任一直接退出。
//
// 靶子实况(v1 计划审查实测,本驱动前置复核):daily_login_content.tscn **0 处
// theme_override 且无 Panel 类型节点**(名为 Panel 的节点是 Control)——直接
// extract_tree 必得空报告。故验收走「import 造 override 副本链」:副本场景逐字节
// 复制 → 小 geometry 经 ui_import_prototype persist 注入带 override 的节点 →
// extract_tree 跑副本 → 报告数字与输入 geometry **自洽对账**(场景原有 0 override,
// 报告全部来自 import 注入——这是对账成立的根基)。
//
// 靶子真实文件的读写面:
// - 场景:唯一副本 `_batch4_copy.tscn`(逐字节复制,import persist 落盘目标),finally 删除;
// - theme(default_theme.tres)**不复制**:两个消费点均只读——export_doc 巡检无
//   ResourceSaver(ui-export.ts 契约「不落盘」);ui_measure_layout 的 theme_path 是
//   运行时挂载(genUiMeasureScript load 后挂 root,不写盘)。
//
// **靶子 git 断言 = 与验收前形态一致**(批3 同款 orchestrator 裁决):验收开始前记录
// `git -C 靶子 status --porcelain` 快照,finally 清理副本后断言逐行一致。快照前幂等
// 预清理 `_batch4_*` 残留;fail() 抛异常不 process.exit(批3 教训:exit 跳 finally)。
//
// 三步(brief Step 1 的 ①②③,④为快照落盘):
//   ① override 副本链 —— 小 geometry(与 T3 e2e fixture 同构便于对账:PanelA
//      bg #4080bf + borderRadius 8 / PanelB 异 bg #8040bf / Label fontSize 20 +
//      color #ff8040)→ ui_import_prototype(副本场景, persist)→ extract_tree(副本)
//      → report/draft 数字对账:stylebox 组恰 2(两 Panel spec 互异)、font_size 组 1
//      (value 20)、font_color 组 1(#ff8040)、suggested_token 全部可从输入推出
//      (style_panel_4080bf / style_panel_8040bf / font_size_20 / text_ff8040)、
//      draft 平票取首见(PanelA spec 先 walk → style_panel_4080bf 胜出,M6 平票锚真机复现)。
//   ② export_doc    —— 真主题只读巡检 → DESIGN.md 视图数字:DesignTokens 空档行、
//      类型 top 20 截断(379 type → (+359 types),预期触发)、引擎约束节。
//   ③ compact 分档  —— 副本场景 ui_measure_layout(theme_path=真主题只读挂载,
//      detail='compact')→ quality/order 列表字段对象化({entries, summary})形态的
//      靶子真数字(真场景大概率有裸壳发现——如实记录,不修饰)。
//
// 用法:GODOT_PATH=<godot 可执行> node scripts/refero-batch4-acceptance.mjs
//   node scripts/refero-batch4-acceptance.mjs clean  # 兜底清理副本
// 快照落 docs/superpowers/plans/refero-batch4-acceptance/(与批1/2/3 同款归档)。

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTool } from '../build/tools/ui/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓根
const GODOT = process.env.GODOT_PATH || '';
const TARGET = 'D:/workspace/projects/DotaLegendGodot';
const TRUE_THEME_RES = 'res://resources/themes/default_theme.tres';
const TRUE_SCENE_RES = 'res://scenes/ui/daily_login_content.tscn';
const DATA_DIR = join(ROOT, 'docs/superpowers/plans/refero-batch4-acceptance');

// 靶子项目内临时副本(untracked,finally 删除——git 状态验收前后一致)
const SCENE_COPY_RES = 'res://scenes/ui/_batch4_copy.tscn';

// 小 geometry(与 T3 e2e fixture test/ui-extract.test.ts 同构:bg 0-1 数组全 2 的幂次
// float32 位级安全;token 可从输入推出:#4080bf=64,128,191 / #8040bf=128,64,191 / #ff8040)。
// 视口 960×540 与靶子项目一致;三 rect y 向分离不交叉(不触 INVALID_PARAMS 交叉重叠拒);
// Label rect.h=48 ≥ fontSize*1.5=30(避开字体行高钳制 warning)。
const GEO = {
  viewport: { w: 960, h: 540 },
  nodes: [
    { name: 'ExtractPanelA', rect: { x: 40, y: 40, w: 240, h: 80 }, type: 'Panel', bg: [0.25, 0.5, 0.75, 1], borderRadius: 8 },
    { name: 'ExtractPanelB', rect: { x: 40, y: 140, w: 240, h: 40 }, type: 'Panel', bg: [0.5, 0.25, 0.75, 1] },
    { name: 'ExtractLabel', rect: { x: 40, y: 220, w: 240, h: 48 }, type: 'Label', text: 'Batch4 Extract Chain', fontSize: 20, color: [1, 0.5, 0.25, 1] },
  ],
};

if (!GODOT || !existsSync(GODOT)) {
  console.error('[gate] 缺 GODOT_PATH 或路径不存在——手工流程双门控,退出');
  process.exit(1);
}
if (!existsSync(TARGET)) {
  console.error('[gate] 靶子项目不存在:', TARGET);
  process.exit(1);
}
// 路径白名单:本机 env 的 ALLOWED_PROJECT_PATHS 不一定含靶子(批1/2/3 同款现实)。
if (!(process.env.ALLOWED_PROJECT_PATHS ?? '').split(';').some(p => p.replace(/\\/g, '/').toLowerCase() === TARGET.toLowerCase())) {
  process.env.ALLOWED_PROJECT_PATHS = (process.env.ALLOWED_PROJECT_PATHS ? process.env.ALLOWED_PROJECT_PATHS + ';' : '') + TARGET;
  console.log('[gate] ALLOWED_PROJECT_PATHS 进程内追加靶子根:', TARGET);
}

const ctx = { findGodot: async () => GODOT };

// fail 用抛异常而非 process.exit——exit 会跳过 finally,副本清理不执行即污染靶子(批3 教训)。
function fail(msg) { throw new Error(msg); }

function targetAbs(res) { return join(TARGET, res.replace(/^res:\/\//, '')); }

function saveJson(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  writeFileSync(p, JSON.stringify(obj, null, 1), 'utf-8');
  console.log(`[save] ${p}`);
}

/** handleTool('ui', ...) 直调一次,断言成功,返回 data 段。 */
async function callUi(args, label) {
  const r = await handleTool('ui', args, ctx);
  if (r?.isError) fail(`${label} isError: ${(r.content?.[0])?.text ?? ''}`);
  const body = JSON.parse((r.content?.[0])?.text ?? '{}');
  if (body.success !== true) fail(`${label} success !== true: ${JSON.stringify(body).slice(0, 400)}`);
  return body.data;
}

/** 颜色四分量数组逐项 ===(float32 安全值位级 roundtrip 断言依据)。 */
function colorEq(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== 4) fail(`${label} 非四分量数组: ${JSON.stringify(actual)}`);
  for (let i = 0; i < 4; i++) {
    if (actual[i] !== expected[i]) fail(`${label}[${i}] 预期 ${expected[i]},实际 ${actual[i]}`);
  }
}

/** corner_radius 四角 ===。 */
function cornerEq(cr, expected, label) {
  if (!cr || cr.tl !== expected || cr.tr !== expected || cr.br !== expected || cr.bl !== expected) {
    fail(`${label} corner_radius 预期四角 ${expected},实际 ${JSON.stringify(cr)}`);
  }
}

/** compact 对象化列表字段形态断言:{entries, summary:{total, truncated}} 且截断数学自洽。 */
function assertCompactField(field, label) {
  if (field === undefined || field === null) return;
  if (typeof field !== 'object' || !Array.isArray(field.entries) || !field.summary ||
      typeof field.summary.total !== 'number' || typeof field.summary.truncated !== 'number') {
    fail(`${label} 非 compact 对象化形态 {entries, summary}: ${JSON.stringify(field).slice(0, 200)}`);
  }
  const { entries, summary } = field;
  if (entries.length !== Math.min(summary.total, 20) || summary.truncated !== summary.total - entries.length) {
    fail(`${label} 截断数学不自洽: entries=${entries.length} summary=${JSON.stringify(summary)}`);
  }
}

// ─── 靶子 git 状态核验(验收前后必须与快照逐行一致,非"干净"断言)──────────────

function targetGitPorcelain() {
  return execSync(`git -C "${TARGET}" status --porcelain`, { encoding: 'utf-8' });
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

if (process.argv[2] === 'clean') {
  rmSync(targetAbs(SCENE_COPY_RES), { force: true });
  console.log('[clean] 临时副本清理完成');
  process.exit(0);
}
if (process.argv[2] !== undefined) {
  console.error(`本驱动无 stage 参数(三步共享副本生命周期);可用: clean。收到: ${process.argv[2]}`);
  process.exit(1);
}

// 幂等预清理:上次异常中断残留的 _batch4_* 副本不能进"验收前快照"(批3 同款防线)。
if (existsSync(targetAbs(SCENE_COPY_RES))) {
  rmSync(targetAbs(SCENE_COPY_RES), { force: true });
  console.log(`[gate] 预清理上次运行残留副本: ${SCENE_COPY_RES}`);
}

const GIT_SNAPSHOT = targetGitPorcelain();
console.log(`[gate] 靶子 git 验收前快照(${GIT_SNAPSHOT.trim() === '' ? '干净' : `${GIT_SNAPSHOT.trim().split('\n').length} 行`}):\n${GIT_SNAPSHOT || '(empty)'}`);

cpSync(targetAbs(TRUE_SCENE_RES), targetAbs(SCENE_COPY_RES));
console.log(`[setup] 副本场景 ← ${TRUE_SCENE_RES}(逐字节复制,import persist 落盘目标)`);

// 外层 catch 兜底所有 fail 抛出的异常(内层 finally 先清理副本再冒泡)——批3 同款双层结构。
try {
try {
  // ── ① override 副本链:import 注入 → extract 逆向 → 自洽对账 ────────────────
  const importData = await callUi({
    action: 'ui_import_prototype', project_path: TARGET, scene_path: SCENE_COPY_RES,
    parent_path: 'root', geometry: GEO,
  }, 'ui_import_prototype(副本链)');
  if (importData.persist?.saved !== true) fail(`import persist 未成功: ${JSON.stringify(importData.persist)}`);
  const lv = importData.layout_verify ?? {};
  const okDiff = (lv.diff ?? []).filter(d => d.ok === true).length;
  console.log(`[① import] persist saved ✓;layout_verify:targets x${(lv.targets ?? []).length} / diff ok ${okDiff}/${(lv.diff ?? []).length} / overlaps x${(lv.overlaps ?? []).length} / out_of_bounds x${(lv.out_of_bounds ?? []).length}`);

  const ex = await callUi({ action: 'extract_tree', project_path: TARGET, scene_path: SCENE_COPY_RES }, 'extract_tree(副本链)');
  const report = ex.report;
  const draft = ex.draft;
  const notes = ex.notes ?? [];
  if (!report) fail(`extract_tree 响应缺 report: ${JSON.stringify(ex).slice(0, 300)}`);

  // 对账根基:场景原有 0 override → 报告全部来自 import 注入(3 节点)
  const scanNodes = new Set([
    ...(report.stylebox_groups ?? []).flatMap(g => g.nodes),
    ...(report.font_size_groups ?? []).map(g => g.nodes[0]),
    ...(report.font_color_groups ?? []).map(g => g.nodes[0]),
  ]);
  if (scanNodes.size !== 3) fail(`逆向节点并集预期 3(两 Panel + 一 Label),实际 ${scanNodes.size}: ${JSON.stringify([...scanNodes])}`);
  for (const p of scanNodes) {
    if (!p.includes('_PrototypeRoot/')) fail(`逆向节点 path 预期在 _PrototypeRoot 子树: ${p}`);
  }
  console.log(`[① extract] 逆向节点并集 x${scanNodes.size}(场景原有 0 override,全部来自 import 注入)✓`);

  // stylebox 组:恰 2(两 Panel spec 互异——bg 不同即不同组)
  const sgs = report.stylebox_groups ?? [];
  if (sgs.length !== 2) fail(`stylebox_groups 预期 2,实际 ${sgs.length}: ${JSON.stringify(sgs.map(g => g.suggested_token))}`);
  // 组序:count 降序平票保持首见(场景 walk 序 = geometry nodes 序,PanelA 先)——M6 平票锚
  if (sgs[0].suggested_token !== 'style_panel_4080bf' || sgs[1].suggested_token !== 'style_panel_8040bf') {
    fail(`stylebox_groups token 序预期 [style_panel_4080bf, style_panel_8040bf](平票首见),实际 ${JSON.stringify(sgs.map(g => g.suggested_token))}`);
  }
  if (sgs[0].count !== 1 || sgs[1].count !== 1) fail(`stylebox 组 count 预期各 1,实际 ${sgs[0].count}/${sgs[1].count}`);
  colorEq(sgs[0].spec.bg_color, [0.25, 0.5, 0.75, 1], 'PanelA 组 bg_color');
  cornerEq(sgs[0].spec.corner_radius, 8, 'PanelA 组');
  colorEq(sgs[1].spec.bg_color, [0.5, 0.25, 0.75, 1], 'PanelB 组 bg_color');
  cornerEq(sgs[1].spec.corner_radius, 0, 'PanelB 组(无 borderRadius)');
  for (const g of sgs) {
    if (JSON.stringify(g.slots) !== JSON.stringify(['panel'])) fail(`stylebox 组 slots 预期 ['panel'],实际 ${JSON.stringify(g.slots)}`);
  }
  console.log(`[① extract] stylebox_groups x2:style_panel_4080bf(bg 0.25/0.5/0.75 + radius 8)/ style_panel_8040bf(bg 0.5/0.25/0.75)——bg 分量位级 === 输入,token 可从输入推出 ✓`);

  // font_size / font_color 组:各 1,值与输入一致
  const fsg = report.font_size_groups ?? [];
  if (fsg.length !== 1 || fsg[0].value !== 20 || fsg[0].count !== 1 || fsg[0].suggested_token !== 'font_size_20') {
    fail(`font_size_groups 预期 [{value:20, count:1, token:font_size_20}],实际 ${JSON.stringify(fsg)}`);
  }
  const fcg = report.font_color_groups ?? [];
  if (fcg.length !== 1 || fcg[0].count !== 1 || fcg[0].suggested_token !== 'text_ff8040') {
    fail(`font_color_groups 预期 1 组 token text_ff8040,实际 ${JSON.stringify(fcg)}`);
  }
  colorEq(fcg[0].value, [1, 0.5, 0.25, 1], 'font_color 组 value');
  console.log(`[① extract] font_size_groups x1(value 20)/ font_color_groups x1(#ff8040 分量 === 输入)✓`);

  // draft:Panel 平票取首见(PanelA spec);colors = stylebox bg token + text token;constants = font_size
  if (!draft) fail('draft 预期非空(有可映射发现)');
  if (draft.styleboxes?.length !== 1 || draft.styleboxes[0].type !== 'Panel' ||
      draft.styleboxes[0].slot !== 'panel' || draft.styleboxes[0].token !== 'style_panel_4080bf') {
    fail(`draft.styleboxes 预期 [Panel/panel/style_panel_4080bf(平票首见)],实际 ${JSON.stringify(draft.styleboxes)}`);
  }
  cornerEq(draft.styleboxes[0].spec.corner_radius, 8, 'draft PanelA spec');
  if (draft.colors?.length !== 2) fail(`draft.colors 预期 2 条,实际 ${JSON.stringify(draft.colors)}`);
  const colorByName = Object.fromEntries((draft.colors ?? []).map(c => [c.name, c.value]));
  colorEq(colorByName['style_panel_4080bf'], [0.25, 0.5, 0.75, 1], 'draft colors[style_panel_4080bf]');
  colorEq(colorByName['text_ff8040'], [1, 0.5, 0.25, 1], 'draft colors[text_ff8040]');
  if (JSON.stringify(draft.constants) !== JSON.stringify([{ name: 'font_size_20', value: 20 }])) {
    fail(`draft.constants 预期 [{font_size_20, 20}],实际 ${JSON.stringify(draft.constants)}`);
  }
  console.log(`[① extract] draft:styleboxes x1(style_panel_4080bf 平票首见胜出)/ colors x2 / constants x1 ✓`);
  if (notes.some(n => n.includes('无任何 theme override'))) fail(`notes 不应含空扫描说明: ${JSON.stringify(notes)}`);
  console.log(`[① extract] notes x${notes.length}(无空扫描说明;Panel/Label 均在草稿映射四类)✓`);

  // ── ② export_doc:真主题只读巡检 → DESIGN.md 视图数字 ──────────────────────
  const doc = await callUi({ action: 'export_doc', project_path: TARGET, theme_path: TRUE_THEME_RES }, 'export_doc(真主题只读)');
  const document = doc.document;
  if (typeof document !== 'string' || !document.startsWith('# DESIGN')) fail('export_doc document 形态异常(非 # DESIGN 头)');
  if (!document.includes('(空:该 Theme 无 DesignTokens token')) fail('DesignTokens 空档行缺失(真主题无 DesignTokens,预期空档说明)');
  const moreTypes = document.match(/\(\+(\d+) types\)/);
  if (!moreTypes) fail('类型 top 20 截断标记 (+N types) 未触发(379 type 预期触发)');
  const docTypeRows = document.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| 类型') && !l.startsWith('|------')).length;
  // 文档类型表体行(排除表头与分隔行;DesignTokens 表在空档时无表体行,不干扰)
  console.log(`[② export_doc] DesignTokens 空档 ✓;类型摘要表体 ${docTypeRows} 行 + (+${moreTypes[1]} types) 截断触发(合计 ${docTypeRows + Number(moreTypes[1])} type)✓`);
  if (!document.includes('## 引擎约束提示')) fail('引擎约束提示节缺失');
  const fontLine = document.split('\n').find(l => l.startsWith('- 默认字体:'));
  console.log(`[② export_doc] 引擎约束节 ✓;${fontLine ?? '(默认字体行未找到)'}`);
  const docLines = document.split('\n').length;

  // ── ③ compact 分档:副本场景 measure + detail='compact' ────────────────────
  const m = await callUi({
    action: 'ui_measure_layout', project_path: TARGET, scene_path: SCENE_COPY_RES,
    theme_path: TRUE_THEME_RES, detail: 'compact',
  }, 'ui_measure_layout(compact)');
  const q = m.quality;
  const o = m.order;
  if (m.detail !== 'compact') fail(`data.detail 预期 'compact'(quality/order 有发现时挂出),实际 ${JSON.stringify(m.detail)}`);
  const qTotals = {};
  if (q) {
    for (const k of ['bare_shells', 'should_follow', 'out_of_bounds', 'viewport_overflow']) {
      assertCompactField(q[k], `quality.${k}`);
      qTotals[k] = q[k]?.summary?.total;
    }
  }
  const oTotals = {};
  if (o) {
    for (const k of ['equidistant', 'alignment_lanes', 'visual_groups']) {
      assertCompactField(o[k], `order.${k}`);
      oTotals[k] = o[k]?.summary?.total;
    }
    if (o.spacing_scale) {
      if (typeof o.spacing_scale.on_scale !== 'number' || typeof o.spacing_scale.total !== 'number') {
        fail(`order.spacing_scale 标量字段形态异常: ${JSON.stringify(o.spacing_scale).slice(0, 200)}`);
      }
      assertCompactField(o.spacing_scale.off_scale, 'order.spacing_scale.off_scale');
      oTotals.spacing_scale = `${o.spacing_scale.on_scale}/${o.spacing_scale.total}(rate ${o.spacing_scale.rate})`;
    }
  }
  console.log(`[③ compact] detail='compact' ✓;quality ${q ? '挂出' : '无发现未挂'} ${JSON.stringify(qTotals)} / order ${o ? '挂出' : '无发现未挂'} ${JSON.stringify(oTotals)}`);
  console.log(`[③ compact] measure:viewport ${JSON.stringify(m.measure?.viewport)} / stalled=${m.measure?.stalled} / stable_after_frames=${m.measure?.stable_after_frames}`);

  // ── ④ 快照 ×3 落盘 ─────────────────────────────────────────────────────────
  saveJson('extract-import-chain.json', {
    geometry: GEO, scene_path: SCENE_COPY_RES,
    import: {
      persist: importData.persist,
      verify_coverage: importData.verify_coverage,
      layout_verify_counts: {
        targets: (lv.targets ?? []).length,
        diff_total: (lv.diff ?? []).length, diff_ok: okDiff,
        overlaps: (lv.overlaps ?? []).length, out_of_bounds: (lv.out_of_bounds ?? []).length,
      },
      style_verify: importData.style_verify ?? [],
      build_warnings: importData.build_warnings ?? [],
    },
    extract: { scan_nodes_union: [...scanNodes], report, draft, notes },
  });
  saveJson('export-doc-default-theme.json', {
    theme_path: TRUE_THEME_RES, document,
    derived: { doc_lines: docLines, type_rows_shown: docTypeRows, more_types: Number(moreTypes[1]), types_total: docTypeRows + Number(moreTypes[1]), design_tokens_empty: true },
  });
  saveJson('measure-compact-report.json', {
    scene_path: SCENE_COPY_RES, theme_path: TRUE_THEME_RES, detail: 'compact',
    // measure 段只存元数据(nodes 全量读数 35KB 级,与本快照主角 quality/order 对象化形态无关)
    measure: {
      viewport: m.measure?.viewport, stalled: m.measure?.stalled,
      stable_after_frames: m.measure?.stable_after_frames,
      node_count: Array.isArray(m.measure?.nodes) ? m.measure.nodes.length : undefined,
    },
    quality: q, order: o,
    compact_totals: { quality: qTotals, order: oTotals },
  });
} finally {
  rmSync(targetAbs(SCENE_COPY_RES), { force: true });
  console.log('[finally] 临时副本场景已清理');
}

const gitNow = targetGitPorcelain();
if (gitNow !== GIT_SNAPSHOT) {
  fail(`靶子 git 状态与验收前快照不一致:\n--- 验收前 ---\n${GIT_SNAPSHOT}--- 验收后 ---\n${gitNow}`);
}
console.log('[gate] 靶子 git 状态与验收前快照逐行一致 ✓(真主题零写入,场景副本已清理)');
console.log('\n[done] 批4 验收驱动全流程结束');
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
