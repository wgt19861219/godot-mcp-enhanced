#!/usr/bin/env node
// scripts/refero-batch2-acceptance.mjs
// 批2 Task 5 靶子轻量验收驱动——order 报告数字存档 + viewport 形参重演。
//
// 手工流程脚本(批1 Task 7 同款纪律):靶子路径不在本仓,CI 永不跑;GODOT_PATH + 靶子
// 项目存在双门控,缺任一直接退出。靶子真实文件**只读**——暂存区有用户未裁决的锚点化
// 改造(批1 验收产物),全部验收经**副本场景**进行,finally 删除临时文件,靶子 git
// 状态验收前后必须一致(硬断言,形态 = 仅 staged 的 daily_login_content.tscn)。
//
// 两个 stage(brief Step 1-2):
//   order   —— ① 副本 A = 工作区真场景(锚点化形态)逐字节复制;三轮 measure:
//              g960(default_theme,无 DesignTokens → 空档跳过 spacing_scale/visual_groups,
//              对齐线恒跑)、g800(viewport 通道)、g960×fixture theme(default_theme 全文 +
//              [resource] 段尾追加 DesignTokens/constants/space_* 档位;走 viewport 通道
//              挂场景根——root 通道挂载被靶子 autoload ThemeManager._ready 覆盖,实测
//              暴露的竞态;挂 fixture 档 rect 与 default 档 0 容差,证明 constants 不
//              影响布局,档位轮数字同源可信)。
//              记录 spacing_scale / alignment_lanes / visual_groups 真实数字,并断言
//              Task 3 已实测真发现(MoneyLay bottom/vc 线、TopRigLay vc 线 8 多数派 +
//              10 离群)复现。
//   replay  —— ② 副本 B = `git show HEAD:` 版本(批1 改造前裸 offset 形态,git 是原
//              文件逐字节快照,比手工重构可靠);链路:measure 与批1 baseline-g960.json
//              rect 0 容差(还原正确性强证)→ solve_from_current 无 viewport 复现批1
//              计划(['.','Panel'] skip)→ 传 viewport={960,540} Panel 进 toWrite 且
//              anchors 与批1 人工补笔值逐值恒等(同一 f32 数学殊途同归)→ 写盘 35 节点
//              → 复测 compareBaseline 0 容差。批1 Panel 人工补笔路径的自动化闭环证明。
//
// 用法:GODOT_PATH=<godot 可执行> node scripts/refero-batch2-acceptance.mjs <stage>
//   stage ∈ order | replay | all(默认 all)
// 快照落 docs/superpowers/plans/refero-batch2-acceptance/(与批1 同款归档)。

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTool } from '../build/tools/ui/index.js';
import { compareBaseline } from '../build/tools/ui/quality-check.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓根
const GODOT = process.env.GODOT_PATH || '';
const TARGET = 'D:/workspace/projects/DotaLegendGodot';
const TRUE_SCENE_RES = 'res://scenes/ui/daily_login_content.tscn';
const THEME_RES = 'res://resources/themes/default_theme.tres';
const DATA_DIR = join(ROOT, 'docs/superpowers/plans/refero-batch2-acceptance');
const BATCH1_BASE = join(ROOT, 'docs/superpowers/plans/refero-batch1-acceptance/baseline-g960.json');

// 靶子项目内临时文件(untracked,finally 删除——git 状态验收前后一致)
const ORDER_COPY_RES = 'res://scenes/ui/_batch2_order_copy.tscn';
const REPLAY_COPY_RES = 'res://scenes/ui/_batch2_replay_copy.tscn';
const FIXTURE_THEME_RES = 'res://resources/themes/_batch2_tokens.tres';

const G960 = { w: 960, h: 540 };
const G800 = { w: 800, h: 480 };
// fixture 档位:典型设计档 4 的倍数阶梯(不凑靶子真实间距——落档率是靶子真实状态的
// 诚实呈现,验收意义在「有档时检测链路真实跑通、数字可解释」)。
const SPACE_SCALE = { space_1: 4, space_2: 8, space_3: 12, space_4: 16, space_5: 24, space_6: 32 };
// 批1 验收记录 §3.3 的 Panel 人工补笔值(同一 f32 感知数学,工具 viewport 兜底应逐值恒等)
const PANEL_MANUAL = {
  anchor_left: 0.10494791716337204, anchor_top: 0.06712962687015533,
  anchor_right: 0.8950520753860474, anchor_bottom: 0.9810185432434082,
  offset_left: 0, offset_top: 0, offset_right: 0, offset_bottom: 0,
};

if (!GODOT || !existsSync(GODOT)) {
  console.error('[gate] 缺 GODOT_PATH 或路径不存在——手工流程双门控,退出');
  process.exit(1);
}
if (!existsSync(TARGET)) {
  console.error('[gate] 靶子项目不存在:', TARGET);
  process.exit(1);
}
// 路径白名单:本机 env 的 ALLOWED_PROJECT_PATHS 不一定含靶子(批1 同款现实)。
// 驱动脚本显式把声明的 TARGET 追加进进程内白名单(官方扩展机制)——只在本进程生效。
if (!(process.env.ALLOWED_PROJECT_PATHS ?? '').split(';').some(p => p.replace(/\\/g, '/').toLowerCase() === TARGET.toLowerCase())) {
  process.env.ALLOWED_PROJECT_PATHS = (process.env.ALLOWED_PROJECT_PATHS ? process.env.ALLOWED_PROJECT_PATHS + ';' : '') + TARGET;
  console.log('[gate] ALLOWED_PROJECT_PATHS 进程内追加靶子根:', TARGET);
}

const ctx = { findGodot: async () => GODOT };

function fail(msg) { console.error('[FAIL]', msg); process.exit(1); }

function targetAbs(res) { return join(TARGET, res.replace(/^res:\/\//, '')); }

function saveJson(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, name);
  writeFileSync(p, JSON.stringify(obj, null, 1), 'utf-8');
  console.log(`[save] ${p}`);
}

/** measure 一次(ui_measure_layout 全链:校验→生成→spawn→后处理),返回完整 body。 */
async function measure(sceneRes, themeRes, viewport) {
  const args = {
    action: 'ui_measure_layout', project_path: TARGET, scene_path: sceneRes,
    theme_path: themeRes, max_depth: 16,
  };
  if (viewport) args.viewport = viewport;
  const r = await handleTool('ui', args, ctx);
  if (r?.isError) fail(`measure isError: ${(r.content?.[0])?.text ?? ''}`);
  const body = JSON.parse((r.content?.[0])?.text ?? '{}');
  if (body.success !== true) fail(`measure success !== true: ${JSON.stringify(body).slice(0, 400)}`);
  if (body.data.measure.stalled === true) fail('measure.stalled === true(布局未收敛,rect 不可信,不出判定)');
  return body;
}

/** solve_from_current 一次,返回 data 段。 */
async function solve(sceneRes, dryRun, viewport) {
  const args = {
    action: 'solve_from_current', project_path: TARGET, scene_path: sceneRes, dry_run: dryRun,
  };
  if (viewport) args.viewport = viewport;
  const r = await handleTool('ui', args, ctx);
  if (r?.isError) fail(`solve_from_current isError: ${(r.content?.[0])?.text ?? ''}`);
  const body = JSON.parse((r.content?.[0])?.text ?? '{}');
  if (body.success !== true) fail(`solve_from_current success !== true: ${JSON.stringify(body).slice(0, 400)}`);
  return body.data;
}

/** 0 容差比对,失败打前 10 条 mismatch 后 fail(返回 bool 供调用方分支)。 */
function demandZeroTolerance(actual, baseline, label) {
  const cmp = compareBaseline(actual, baseline);
  if (!cmp.ok) {
    console.error(`[${label}] 0 容差失败!mismatches 前 10 条:`);
    for (const mm of cmp.mismatches.slice(0, 10)) console.error(`  ${mm.path}.${mm.field}: expected=${mm.expected} actual=${mm.actual}`);
    console.error(`[${label}] 共 ${cmp.mismatches.length} 处`);
  }
  return cmp.ok;
}

/** order 报告三检测简表(数字进验收记录的打印面)。 */
function summarizeOrder(tag, order) {
  if (!order) { console.log(`[${tag}] order 节缺席(无发现,D8)`); return; }
  console.log(`[${tag}] equidistant x${order.equidistant.length}`);
  for (const g of order.equidistant) console.log(`  - ${g.parent} ${g.axis} gap=${g.gap.toFixed(2)} members=${g.members.length}`);
  console.log(`[${tag}] alignment_lanes x${order.alignment_lanes.length}`);
  for (const l of order.alignment_lanes) {
    console.log(`  - ${l.parent} ${l.kind} lane=${l.lane.toFixed(3)} majority=${l.majority.length} outliers=${l.outliers.length}` +
      (l.outliers.length <= 4 ? ` [${l.outliers.map(o => `${o.path.split('/').pop()}${o.offset >= 0 ? '+' : ''}${o.offset.toFixed(2)}`).join(', ')}]` : ` [离群名群体见快照]`));
  }
  if (order.spacing_scale) {
    const s = order.spacing_scale;
    console.log(`[${tag}] spacing_scale on=${s.on_scale}/${s.total} rate=${(s.rate * 100).toFixed(1)}% off_scale x${s.off_scale.length}`);
    for (const o of s.off_scale.slice(0, 8)) console.log(`  - ${o.a.split('/').pop()}→${o.b.split('/').pop()} gap=${o.gap.toFixed(2)} nearest=${o.nearest}`);
    if (s.off_scale.length > 8) console.log(`  ...共 ${s.off_scale.length} 条(全量见快照)`);
  } else {
    console.log(`[${tag}] spacing_scale 缺席(无档位声明,空档跳过)`);
  }
  if (order.visual_groups) {
    console.log(`[${tag}] visual_groups x${order.visual_groups.length}`);
    for (const g of order.visual_groups) {
      console.log(`  - ${g.parent} ${g.axis} ${g.groups.length} 组:` + g.groups.map(x => `${x.members.length}成员(intraGap=${x.intraGap.toFixed(2)})`).join(' + '));
    }
  } else {
    console.log(`[${tag}] visual_groups 缺席(无档位未传阈值,跳过)`);
  }
}

/** fixture theme 构造:default_theme.tres 全文 + [resource] 段尾追加 DesignTokens 档位
 * (Theme 资源属性路径语法 `DesignTokens/constants/space_N = V`,Task2 e2e fixture 同款;
 * 字号/样式等全保留 → 挂 fixture 档 rect 应与 default 档一致,由调用方 0 容差断言)。 */
function buildFixtureTheme() {
  const base = readFileSync(targetAbs(THEME_RES), 'utf-8');
  const lines = Object.entries(SPACE_SCALE).map(([k, v]) => `DesignTokens/constants/${k} = ${v}`);
  writeFileSync(targetAbs(FIXTURE_THEME_RES), base + (base.endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n', 'utf-8');
  console.log(`[fixture] theme 写入 ${FIXTURE_THEME_RES}(${lines.length} 档位: ${Object.values(SPACE_SCALE).join('/')})`);
}

// ─── ① order 报告实跑(brief Step 1)─────────────────────────────────────────

async function stageOrder() {
  cpSync(targetAbs(TRUE_SCENE_RES), targetAbs(ORDER_COPY_RES));
  console.log(`[order] 副本 A(锚点化工作区形态)← ${TRUE_SCENE_RES}`);
  try {
    // 轮 1:g960 × default_theme(无 DesignTokens)
    const b960 = await measure(ORDER_COPY_RES, THEME_RES);
    const m960 = b960.data.measure;
    console.log(`[order] g960: 节点数=${m960.nodes.length} viewport=${JSON.stringify(m960.viewport)} stable_after_frames=${m960.stable_after_frames}`);
    if (JSON.stringify(m960.theme_constants ?? {}) !== '{}') fail(`theme_constants 预期 {}(default_theme 无 DesignTokens),实际 ${JSON.stringify(m960.theme_constants)}`);
    const o960 = b960.data.order;
    if (o960?.spacing_scale !== undefined) fail('空档必须跳过 spacing_scale(无声明不发噪音)');
    if (o960?.visual_groups !== undefined) fail('无档位未传阈值必须跳过 visual_groups');
    summarizeOrder('g960', o960);
    // Task 3 真发现复现:MoneyLay bottom/vc 线 + TopRigLay vc 线(8 多数派 + 10 离群)
    const lanes = o960?.alignment_lanes ?? [];
    const moneyKinds = lanes.filter(l => l.parent === 'Panel/MoneyLay').map(l => l.kind);
    if (!moneyKinds.includes('bottom') || !moneyKinds.includes('vc')) fail(`MoneyLay bottom/vc 线未复现,实际 [${moneyKinds}]`);
    const trVc = lanes.find(l => l.parent === 'Panel/TopRigLay' && l.kind === 'vc');
    if (!trVc || trVc.majority.length !== 8 || trVc.outliers.length !== 10) {
      fail(`TopRigLay vc 线预期 8 多数派 + 10 离群,实际 ${trVc ? `${trVc.majority.length}+${trVc.outliers.length}` : '未命中'}`);
    }
    console.log('[order] Task3 真发现复现 ✓(MoneyLay bottom/vc;TopRigLay vc 8+10)');

    // 轮 2:g800 × default_theme(viewport 通道)
    const b800 = await measure(ORDER_COPY_RES, THEME_RES, G800);
    const m800 = b800.data.measure;
    if (m800.viewport_check !== 'effective') fail('g800 viewport_check !== effective(注入视口未证实生效)');
    console.log(`[order] g800: viewport_check=effective 节点数=${m800.nodes.length}`);
    summarizeOrder('g800', b800.data.order);

    // 轮 3:g960 × fixture theme(带 DesignTokens 档位)。**必须走 viewport 通道**
    // (传与项目一致的 960×540,SubViewport 同尺寸 → rect 不变):root 通道挂载会被靶子
    // autoload ThemeManager 的 _ready 覆盖(theme_manager.gd:19 root.set_theme(default)),
    // 读回恒为无档 default——实测暴露的覆盖竞态;viewport 通道挂**场景根**,ThemeManager
    // 不碰场景根 theme,constants 读回正常(SubViewport 960×540 同尺寸,布局语境不变)。
    buildFixtureTheme();
    const bf = await measure(ORDER_COPY_RES, FIXTURE_THEME_RES, G960);
    const mf = bf.data.measure;
    if (mf.viewport_check !== 'effective') fail('fixture 轮 viewport_check !== effective');
    if (JSON.stringify(mf.theme_constants) !== JSON.stringify(SPACE_SCALE)) {
      fail(`fixture theme_constants 预期 ${JSON.stringify(SPACE_SCALE)},实际 ${JSON.stringify(mf.theme_constants)}`);
    }
    // constants 不影响布局:fixture 档 rect 与 default 档 0 容差(档位轮数字同源可信的强证)
    if (!demandZeroTolerance(mf.nodes, m960.nodes, 'order-fixture')) {
      fail('fixture theme(仅追加 DesignTokens constants)改变了布局——档位轮数字不可信');
    }
    console.log('[order] fixture 档 rect 与 default 档 0 容差 ✓(constants 不影响布局)');
    if (bf.data.order?.spacing_scale === undefined) fail('有档轮 spacing_scale 必须挂出');
    summarizeOrder('fixture-g960', bf.data.order);

    saveJson('order-g960.json', { measure: { viewport: m960.viewport, nodes: m960.nodes, theme_constants: m960.theme_constants }, order: o960 ?? null, quality: b960.data.quality ?? null, warnings: b960.warnings ?? [] });
    saveJson('order-g800.json', { measure: { viewport: m800.viewport, nodes: m800.nodes }, order: b800.data.order ?? null, quality: b800.data.quality ?? null, warnings: b800.warnings ?? [] });
    saveJson('order-fixture-g960.json', { measure: { viewport: mf.viewport, nodes: mf.nodes, theme_constants: mf.theme_constants }, order: bf.data.order ?? null, spacing_scale_declared: Object.values(SPACE_SCALE), warnings: bf.warnings ?? [] });
  } finally {
    rmSync(targetAbs(ORDER_COPY_RES), { force: true });
    rmSync(targetAbs(FIXTURE_THEME_RES), { force: true });
    console.log('[order] 临时文件已清理(副本 A + fixture theme)');
  }
}

// ─── ② viewport 形参重演(brief Step 2)──────────────────────────────────────

async function stageReplay() {
  // 副本 B:HEAD 版本 = 批1 改造前裸 offset 形态(git 逐字节快照,优于手工重构)
  const headText = execSync(`git -C "${TARGET}" show HEAD:${TRUE_SCENE_RES.replace(/^res:\/\//, '')}`, { encoding: 'utf-8' });
  writeFileSync(targetAbs(REPLAY_COPY_RES), headText, 'utf-8');
  console.log(`[replay] 副本 B(HEAD 裸 offset 形态)← git show HEAD:${TRUE_SCENE_RES}`);
  try {
    // 形态证:Panel 段无 anchor_*(裸 offset;注释行有中文,段切分用首个 [node 边界)
    const panelSec = headText.split('[node name="Panel"')[1].split('[node')[0];
    if (/anchor_(left|right|top|bottom)\s*=/.test(panelSec)) fail('副本 B 的 Panel 段含 anchor 行,非批1 改造前形态');
    console.log('[replay] Panel 段无 anchor 行(裸 offset 形态)✓');

    // ① 还原正确性:HEAD 形态 measure 与批1 baseline-g960.json rect 0 容差
    const before = await measure(REPLAY_COPY_RES, THEME_RES);
    const batch1 = JSON.parse(readFileSync(BATCH1_BASE, 'utf-8'));
    if (!demandZeroTolerance(before.data.measure.nodes, batch1.measure.nodes, 'replay-batch1')) {
      fail('HEAD 还原形态与批1 改造前基线 rect 不一致——git show 来源不可信,中止');
    }
    console.log(`[replay] 还原形态 rect === 批1 baseline-g960(${batch1.measure.nodes.length} 节点,0 容差)✓`);

    // ② 无 viewport:复现批1 计划(根 '.' 与 Panel 进 skippedUnresolvedParent)
    const d1 = await solve(REPLAY_COPY_RES, true, undefined);
    if (d1.toWrite.length !== 34 || JSON.stringify(d1.skippedUnresolvedParent) !== JSON.stringify(['.', 'Panel'])) {
      fail(`无 viewport 计划预期 toWrite=34 / skip=[".","Panel"],实际 ${d1.toWrite.length} / ${JSON.stringify(d1.skippedUnresolvedParent)}`);
    }
    console.log('[replay] 无 viewport:toWrite=34,skippedUnresolvedParent=[".","Panel"](批1 盲区现状锚)✓');

    // ③ viewport={960,540}:Panel 进 toWrite,不再 skippedUnresolvedParent
    const d2 = await solve(REPLAY_COPY_RES, true, G960);
    if (JSON.stringify(d2.skippedUnresolvedParent) !== JSON.stringify(['.'])) {
      fail(`viewport 计划 skippedUnresolvedParent 预期 ["."],实际 ${JSON.stringify(d2.skippedUnresolvedParent)}`);
    }
    const panelEntry = d2.toWrite.find(e => e.path === 'Panel');
    if (!panelEntry) fail('viewport 计划缺 Panel(一级子盲区未根治)');
    if (d2.toWrite.length !== 35) fail(`viewport 计划 toWrite 预期 35(34+Panel),实际 ${d2.toWrite.length}`);
    // 与批1 人工补笔值逐值恒等:同一 f32 感知数学,自动化与人工殊途同归
    for (const [k, v] of Object.entries(PANEL_MANUAL)) {
      if (panelEntry.anchors[k] !== v) fail(`Panel anchors.${k} 预期 ${v}(批1 人工补笔值),实际 ${panelEntry.anchors[k]}`);
    }
    console.log(`[replay] viewport={w:960,h:540}:toWrite=35,skippedUnresolvedParent=["."],Panel anchors === 批1 人工补笔值(逐值恒等)✓`);

    // ④ 写盘(dry_run=false)
    const d3 = await solve(REPLAY_COPY_RES, false, G960);
    if (d3.written !== 35) fail(`写盘 written 预期 35,实际 ${d3.written}`);
    console.log('[replay] dry_run=false 写盘 35 节点(工具 34 + Panel viewport 兜底 1,零人工补笔)✓');

    // ⑤ 0 容差回归:写盘后 measure 与写盘前基线(compareBaseline ok===true)
    const after = await measure(REPLAY_COPY_RES, THEME_RES);
    if (!demandZeroTolerance(after.data.measure.nodes, before.data.measure.nodes, 'replay-verify')) {
      fail('viewport 重演写盘后 0 容差失败(数学守卫失守,副本保留供排查时请重跑清理)');
    }
    console.log(`[replay] compareBaseline ok=true(0 容差,${before.data.measure.nodes.length} 节点 × rect 四值严格 ===)✓`);

    // ⑥ 锚点化形态证 + 注释保留
    const afterText = readFileSync(targetAbs(REPLAY_COPY_RES), 'utf-8');
    const ps2 = afterText.split('[node name="Panel"')[1].split('[node')[0];
    if (!ps2.includes('layout_mode = 1') || !ps2.includes('anchor_left = ')) fail('写盘后 Panel 段未锚点化');
    const beforeComments = headText.split('\n').filter(l => l.trim().startsWith(';'));
    const afterComments = afterText.split('\n').filter(l => l.trim().startsWith(';'));
    if (JSON.stringify(afterComments) !== JSON.stringify(beforeComments)) fail('注释行有增删(审计线索须逐字节保留)');
    console.log(`[replay] 写盘后 Panel 段锚点化 ✓,注释 ${afterComments.length} 行逐字节保留 ✓`);

    saveJson('replay-plan-noviewport.json', d1);
    saveJson('replay-plan-viewport.json', d2);
    saveJson('replay-after-g960.json', { measure: after.data.measure, warnings: after.warnings ?? [] });
  } finally {
    rmSync(targetAbs(REPLAY_COPY_RES), { force: true });
    console.log('[replay] 临时文件已清理(副本 B)');
  }
}

// ─── 靶子 git 状态核验(验收前后必须一致)────────────────────────────────────

function assertTargetGitState() {
  const out = execSync(`git -C "${TARGET}" status --porcelain`, { encoding: 'utf-8' }).trim();
  // 验收前实测形态:仅 staged 的 daily_login_content.tscn(用户未裁决的批1 锚点化改动)
  if (out !== 'M  scenes/ui/daily_login_content.tscn') {
    fail(`靶子 git 状态与验收前不一致(预期仅 "M  scenes/ui/daily_login_content.tscn"):\n${out}`);
  }
  console.log('[gate] 靶子 git 状态与验收前一致(M  scenes/ui/daily_login_content.tscn,staged 只读未动)✓');
}

// ─── main ────────────────────────────────────────────────────────────────────

const stage = process.argv[2] ?? 'all';
if (stage === 'clean') {
  for (const f of [ORDER_COPY_RES, REPLAY_COPY_RES, FIXTURE_THEME_RES]) rmSync(targetAbs(f), { force: true });
  console.log('[clean] 临时文件清理完成');
  process.exit(0);
}
const stages = { order: stageOrder, replay: stageReplay };
if (!(stage in stages || stage === 'all')) {
  console.error(`未知 stage: ${stage}(可用: order|replay|all|clean)`);
  process.exit(1);
}
assertTargetGitState();
const order = stage === 'all' ? ['order', 'replay'] : [stage];
for (const s of order) {
  console.log(`\n===== stage: ${s} =====`);
  await stages[s]();
}
assertTargetGitState();
console.log('\n[done] 批2 验收驱动全流程结束');
