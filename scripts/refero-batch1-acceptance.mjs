#!/usr/bin/env node
// scripts/refero-batch1-acceptance.mjs
// 批1 Task 7 靶子手工验收驱动——DotaLegendGodot daily_login 双档闭环(spec 批1 验收 1-5)。
//
// 手工流程脚本(spec 约束 P1-5):靶子路径不在本仓,CI 永不跑;GODOT_PATH + 靶子项目存在
// 双门控,缺任一直接退出。流程(brief Step 1-5):
//   baseline —— ① 挂主题 g960 measure 取基线(1b 格式:rect + anchors/offsets 原值),
//                快照存 docs/superpowers/plans/refero-batch1-acceptance/baseline-g960.json;
//                打印 quality/order 报告全命中项(Step 2 名单化处置的基数)。
//   plan     —— ② solve_from_current(dry_run=true) 出计划不写盘,核对 toWrite/skips。
//   write    —— ③ dry_run=false 写盘(工具 34 节点)+ Panel 本体人工补笔(见下)。
//   verify   —— ④ 复测 measure,compareBaseline 0 容差(ok===true);失败自动
//                `git -C 靶子 checkout -- <scene>` 回滚并 exit 1(全局约束:不许放宽)。
//   g800     —— ⑤ viewport 800×480 复测(SubViewport 通道):视口生效硬证据 /
//                一级 Panel 不越视口 / 中心线对齐 / 位置比例落位 / 尺寸容偏记录。
//
// 【Panel 人工补笔的边界说明】solve_from_current 的已知边界(anchor-rebase.ts 头注 +
// Task5 报告自查 3):场景根的直接子节点因父尺寸=视口依赖进 skippedUnresolvedParent,
// brief 参数集无 viewport 形参,工具不可解 Panel。而 g800 验收硬指标(一级 Panel 不越
// 800 视口 + 中心线 400)只有 Panel 比例锚点可达——本脚本用**同一导出原语 + 同一 f32
// 感知数学**(parseAuthoredGeometry/simulateMargins/snap/applyRebasePatch,公式与
// planRebase.solve 逐字同源)对 Panel 单节点补一 Entry,同样段落级文本 patch + 原子写,
// 同样被 Step ④ 的 0 容差门禁覆盖(数学错则 g960 比对必挂并回滚)。父尺寸取靶子
// project.godot 声明视口 960×540(脚本内实读断言,不硬编码信任)。
//
// 用法:GODOT_PATH=<godot 可执行> node scripts/refero-batch1-acceptance.mjs <stage>
//   stage ∈ baseline | plan | write | verify | g800 | all
// 排练通道:ACCEPTANCE_SCENE=res://scenes/ui/_xxx.tscn 指向靶子内场景副本(须先手工
// copy 存在)——真改造前的全链演练(写盘作用于副本;git 干净门禁仅对真靶子场景生效)。

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTool } from '../build/tools/ui/index.js';
import { compareBaseline } from '../build/tools/ui/quality-check.js';
import { parseAuthoredGeometry, applyRebasePatch, simulateMargins } from '../build/tools/ui/anchor-rebase.js';
import { snap } from '../build/tools/ui/anchor-solver.js';

const fr = Math.fround;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓根
const GODOT = process.env.GODOT_PATH || '';
const TARGET = 'D:/workspace/projects/DotaLegendGodot';
const SCENE_RES = process.env.ACCEPTANCE_SCENE || 'res://scenes/ui/daily_login_content.tscn';
const SCENE_ABS = join(TARGET, SCENE_RES.replace(/^res:\/\//, ''));
const REHEARSAL = process.env.ACCEPTANCE_SCENE !== undefined;
const THEME = 'res://resources/themes/default_theme.tres';
const DATA_DIR = join(ROOT, 'docs/superpowers/plans/refero-batch1-acceptance');
const G800 = { w: 800, h: 480 };

if (!GODOT || !existsSync(GODOT)) {
  console.error('[gate] 缺 GODOT_PATH 或路径不存在——手工流程双门控,退出');
  process.exit(1);
}
if (!existsSync(TARGET)) {
  console.error('[gate] 靶子项目不存在:', TARGET);
  process.exit(1);
}
// 路径白名单:本机 env 的 ALLOWED_PROJECT_PATHS 不一定含靶子(与本仓 e2e 同一现实)。
// 驱动脚本显式把声明的 TARGET 追加进进程内白名单(官方扩展机制,分号分隔)——只在
// 本进程生效,不改用户环境。
if (!(process.env.ALLOWED_PROJECT_PATHS ?? '').split(';').some(p => p.replace(/\\/g, '/').toLowerCase() === TARGET.toLowerCase())) {
  process.env.ALLOWED_PROJECT_PATHS = (process.env.ALLOWED_PROJECT_PATHS ? process.env.ALLOWED_PROJECT_PATHS + ';' : '') + TARGET;
  console.log('[gate] ALLOWED_PROJECT_PATHS 进程内追加靶子根:', TARGET);
}

const ctx = { findGodot: async () => GODOT };

function fail(msg) { console.error('[FAIL]', msg); process.exit(1); }

/** 引擎 float32 语义重算边距(与 ui-anchor-rebase.test.ts 的 recompose 同式)。 */
function recompose(a, p, o) { return fr(fr(fr(a) * p) + fr(o)); }

/** measure 一次(ui_measure_layout 全链:校验→生成→spawn→后处理),返回完整 body。 */
async function measure(viewport) {
  const args = {
    action: 'ui_measure_layout', project_path: TARGET, scene_path: SCENE_RES,
    theme_path: THEME, max_depth: 16,
  };
  if (viewport) args.viewport = viewport;
  const r = await handleTool('ui', args, ctx);
  if (r?.isError) fail(`measure isError: ${(r.content?.[0])?.text ?? ''}`);
  const body = JSON.parse((r.content?.[0])?.text ?? '{}');
  if (body.success !== true) fail(`measure success !== true: ${JSON.stringify(body).slice(0, 400)}`);
  if (body.data.measure.stalled === true) fail('measure.stalled === true(布局未收敛,rect 不可信,不出判定)');
  return body;
}

function saveJson(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = join(DATA_DIR, REHEARSAL ? name.replace(/\.json$/, '-rehearsal.json') : name);
  writeFileSync(p, JSON.stringify(obj, null, 1), 'utf-8');
  console.log(`[save] ${p}`);
}

function loadJson(name) {
  const file = REHEARSAL ? name.replace(/\.json$/, '-rehearsal.json') : name;
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));
}

/** 靶子场景文件必须干净(写盘幂等护栏:防在已改造场景上二次跑基线)。排练副本豁免。 */
function assertSceneClean() {
  if (REHEARSAL) { console.log('[gate] 排练模式,git 干净门禁豁免'); return; }
  const out = execSync(`git -C "${TARGET}" status --porcelain -- scenes/ui/daily_login_content.tscn`, { encoding: 'utf-8' });
  if (out.trim() !== '') fail(`靶子场景已有未提交改动(验收须从干净基线起跑):\n${out}`);
  console.log('[gate] 靶子场景 git 干净 ✓');
}

/** 打印 quality/order 报告节(Step 2 名单化基数)。 */
function printReport(body) {
  const q = body.data.quality;
  const o = body.data.order;
  console.log(`[report] 裸壳 A.1 x${q ? q.bare_shells.length : 0}: ${JSON.stringify((q?.bare_shells ?? []).map(b => b.path))}`);
  console.log(`[report] 应跟随 A.2 x${q ? q.should_follow.length : 0}: ${JSON.stringify((q?.should_follow ?? []).map(s => s.path))}`);
  console.log(`[report] 父级越界 x${q ? q.out_of_bounds.length : 0} / 视口溢出 x${q ? q.viewport_overflow.length : 0}`);
  console.log(`[report] 等距组 A.3 x${o ? o.equidistant.length : 0}`);
  for (const g of o?.equidistant ?? []) console.log(`  - ${g.parent} ${g.axis} gap=${g.gap.toFixed(2)} members=${g.members.length}`);
  return { quality: q ?? null, order: o ?? null };
}

// ─── ① baseline ─────────────────────────────────────────────────────────────

async function stageBaseline() {
  assertSceneClean();
  const body = await measure();
  const m = body.data.measure;
  console.log(`[baseline] 节点数=${m.nodes.length} viewport=${JSON.stringify(m.viewport)} stable_after_frames=${m.stable_after_frames}`);
  const rep = printReport(body);
  saveJson('baseline-g960.json', { measure: m, quality: rep.quality, order: rep.order, warnings: body.warnings ?? [] });
}

// ─── ② plan(dry_run 核对)───────────────────────────────────────────────────

async function solveFromCurrent(dryRun) {
  const r = await handleTool('ui', {
    action: 'solve_from_current', project_path: TARGET, scene_path: SCENE_RES, dry_run: dryRun,
  }, ctx);
  if (r?.isError) fail(`solve_from_current isError: ${(r.content?.[0])?.text ?? ''}`);
  const body = JSON.parse((r.content?.[0])?.text ?? '{}');
  if (body.success !== true) fail(`solve_from_current success !== true: ${JSON.stringify(body).slice(0, 400)}`);
  return body.data;
}

async function stagePlan() {
  assertSceneClean();
  const d = await solveFromCurrent(true);
  console.log(`[plan] dry_run=true toWrite=${d.toWrite.length} skippedUnresolvedParent=${JSON.stringify(d.skippedUnresolvedParent)}`);
  console.log(`[plan] skippedContainerChildren=${JSON.stringify(d.skippedContainerChildren)} skippedByFilter=${JSON.stringify(d.skippedByFilter)} skippedNoGeometry=${JSON.stringify(d.skippedNoGeometry)}`);
  // 硬预期:36 节点场景,根 '.' 与 Panel(父=视口)进 skippedUnresolvedParent,其余 34 全写
  if (d.toWrite.length !== 34) fail(`toWrite 预期 34,实际 ${d.toWrite.length}`);
  if (JSON.stringify(d.skippedUnresolvedParent) !== JSON.stringify(['.', 'Panel'])) {
    fail(`skippedUnresolvedParent 预期 [".","Panel"],实际 ${JSON.stringify(d.skippedUnresolvedParent)}`);
  }
  // 名单化锚点:三报告项相关子树必须在计划内
  for (const p of ['Panel/Bj', 'Panel/MoneyLay', 'Panel/MoneyLay/DataImg2', 'Panel/TopRigLay', 'Panel/TopRigLay/ProgressBar']) {
    if (!d.toWrite.some(e => e.path === p)) fail(`计划缺名单项: ${p}`);
  }
  console.log('[plan] 名单项(Bj/MoneyLay 系/TopRigLay 系)全部在计划内 ✓');
  saveJson('plan-dryrun.json', d);
}

// ─── ③ write(工具写盘 + Panel 人工补笔)───────────────────────────────────

async function stageWrite() {
  assertSceneClean();
  const before = readFileSync(SCENE_ABS, 'utf-8');

  // 工具链写盘:34 节点(根与 Panel 按边界跳过)
  const d = await solveFromCurrent(false);
  if (d.written !== 34) fail(`工具写盘 written 预期 34,实际 ${d.written}`);
  console.log(`[write] solve_from_current(dry_run=false) written=${d.written} ✓`);

  // Panel 人工补笔(头注【Panel 人工补笔的边界说明】):同一 f32 感知数学,父=视口。
  const proj = readFileSync(join(TARGET, 'project.godot'), 'utf-8');
  const vw = Number(/window\/size\/viewport_width=(\d+)/.exec(proj)?.[1] ?? NaN);
  const vh = Number(/window\/size\/viewport_height=(\d+)/.exec(proj)?.[1] ?? NaN);
  if (!(vw > 0) || !(vh > 0)) fail(`靶子 project.godot 视口解析失败: ${vw}x${vh}`);
  const text = readFileSync(SCENE_ABS, 'utf-8');
  const parsed = parseAuthoredGeometry(text);
  const root = parsed.find(n => n.parentPath === '');
  if (!root) fail('场景根未解析');
  // 前提核验:根确为全铺锚点(其尺寸=视口,960×540 才是合法父尺寸)
  if (!(root.anchors.left === 0 && root.anchors.right === 1 && root.anchors.top === 0 && root.anchors.bottom === 1)) {
    fail(`场景根非全铺锚点(${JSON.stringify(root.anchors)}),视口父尺寸假设不成立`);
  }
  const margins = simulateMargins(parsed);
  const pm = margins.get('Panel');
  if (!pm) fail('Panel 边距模拟缺失');
  console.log(`[write-manual] Panel 当前边距(=授权 offset)l=${pm.l} t=${pm.t} r=${pm.r} b=${pm.b},父=场景根(视口 ${vw}x${vh})`);
  const solve = (t, p) => { const a = fr(snap(t / p)); return { a, o: t - fr(a * p) }; };
  const L = solve(pm.l, vw), T = solve(pm.t, vh), R = solve(pm.r, vw), B = solve(pm.b, vh);
  // 写前核对(dry_run 等价物):f32 重算 === 当前边距,位级恒等
  const checks = [
    [recompose(L.a, vw, L.o), pm.l, 'left'], [recompose(T.a, vh, T.o), pm.t, 'top'],
    [recompose(R.a, vw, R.o), pm.r, 'right'], [recompose(B.a, vh, B.o), pm.b, 'bottom'],
  ];
  for (const [got, want, side] of checks) {
    if (got !== want) fail(`Panel ${side} f32 重算 ${got} !== 边距 ${want}(数学守卫失败,不写盘)`);
  }
  const entry = {
    path: 'Panel', name: 'Panel', tscnParent: '.',
    anchors: {
      anchor_left: L.a, anchor_right: R.a, anchor_top: T.a, anchor_bottom: B.a,
      offset_left: L.o, offset_right: R.o, offset_top: T.o, offset_bottom: B.o,
    },
  };
  console.log(`[write-manual] Panel 补笔锚点: anchor=(${L.a}, ${T.a}, ${R.a}, ${B.a}) offset=(${L.o}, ${T.o}, ${R.o}, ${B.o})`);
  const patch = applyRebasePatch(text, [entry]);
  if (patch.patched !== 1 || patch.warnings.length > 0) fail(`Panel patch 异常: patched=${patch.patched} warnings=${JSON.stringify(patch.warnings)}`);
  const tmp = SCENE_ABS + '.mcp-rebase-tmp';
  writeFileSync(tmp, patch.text, 'utf-8');
  renameSync(tmp, SCENE_ABS);
  console.log('[write-manual] Panel 段落 patch 落盘 ✓(tmp+rename 原子写)');

  // 落盘后快照断言:注释保留 + Panel 段 layout_mode=1 + 全树 35 段已锚点化
  const after = readFileSync(SCENE_ABS, 'utf-8');
  const beforeComments = before.split('\n').filter(l => l.trim().startsWith(';'));
  const afterComments = after.split('\n').filter(l => l.trim().startsWith(';'));
  if (JSON.stringify(afterComments) !== JSON.stringify(beforeComments)) fail('注释行有增删(tscn 审计线索必须逐字节保留)');
  const panelSec = after.split('[node name="Panel"')[1].split('[node')[0];
  if (!panelSec.includes('layout_mode = 1') || !panelSec.includes('anchor_left = ')) fail('Panel 段未锚点化');
  const reParsed = parseAuthoredGeometry(after);
  const anchored = reParsed.filter(n => n.path !== '.'
    && (n.anchors.left !== 0 || n.anchors.right !== 0 || n.anchors.top !== 0 || n.anchors.bottom !== 0));
  if (anchored.length !== 35) fail(`非根锚点化节点数预期 35(34 工具 + Panel;场景根本就全铺锚定不计),实际 ${anchored.length}`);
  console.log(`[write] 合计写盘 35 节点(工具 34 + Panel 人工补笔 1);注释 ${afterComments.length} 行逐字节保留 ✓`);
}

// ─── ④ verify(0 容差回归)─────────────────────────────────────────────────

async function stageVerify() {
  const baseline = loadJson('baseline-g960.json').measure.nodes;
  const body = await measure();
  saveJson('after-g960.json', { measure: body.data.measure, warnings: body.warnings ?? [] });
  const cmp = compareBaseline(body.data.measure.nodes, baseline);
  if (!cmp.ok) {
    console.error('[verify] 0 容差失败!mismatches 前 10 条:');
    for (const mm of cmp.mismatches.slice(0, 10)) console.error(`  ${mm.path}.${mm.field}: expected=${mm.expected} actual=${mm.actual}`);
    console.error(`[verify] 共 ${cmp.mismatches.length} 处——按全局约束回滚写盘`);
    if (REHEARSAL) {
      console.error('[verify] 排练模式不触靶子真文件,副本保留供排查:', SCENE_ABS);
    } else {
      execSync(`git -C "${TARGET}" checkout -- scenes/ui/daily_login_content.tscn`);
      console.error('[verify] 已回滚:git -C 靶子 checkout -- scenes/ui/daily_login_content.tscn');
    }
    process.exit(1);
  }
  console.log(`[verify] compareBaseline ok=true(0 容差,${baseline.length} 节点 × rect 四值严格 ===)✓`);
}

// ─── ⑤ g800 复测(SubViewport 通道)────────────────────────────────────────

function nodeOf(nodes, path) {
  const n = nodes.find(x => x.path === path);
  if (!n) fail(`g800 测量缺节点: ${path}`);
  return n;
}

async function stageG800() {
  const baseNodes = loadJson('baseline-g960.json').measure.nodes;
  const body = await measure(G800);
  const m = body.data.measure;
  saveJson('g800.json', { measure: m, quality: body.data.quality ?? null, order: body.data.order ?? null, warnings: body.warnings ?? [] });

  // ① 视口生效硬证据(假绿防护主判据):全铺场景根 rect = 800×480
  console.log(`[g800] viewport_check=${m.viewport_check ?? '(无)'} 上报 viewport=${JSON.stringify(m.viewport)}`);
  if (m.viewport_check !== 'effective') fail('viewport_check !== effective(注入视口未证实生效)');
  const root = nodeOf(m.nodes, '.');
  if (root.rect.w !== G800.w || root.rect.h !== G800.h) fail(`全铺场景根 rect=${JSON.stringify(root.rect)} ≠ 800×480`);
  console.log(`[g800] 全铺场景根 rect=${root.rect.w}x${root.rect.h} ✓(唯一真全铺节点,视口生效直接证据)`);

  // ② 一级 Panel 不越视口(硬门禁,margin 4px 同 quality 口径)
  const panel = nodeOf(m.nodes, 'Panel');
  const pr = panel.rect.x + panel.rect.w, pb = panel.rect.y + panel.rect.h;
  console.log(`[g800] Panel rect=(x=${panel.rect.x}, y=${panel.rect.y}, w=${panel.rect.w}, h=${panel.rect.h}) 右缘=${pr.toFixed(3)} 下缘=${pb.toFixed(3)}`);
  if (pr > G800.w + 4 || pb > G800.h + 4) fail(`Panel 越视口: 右缘 ${pr} / 下缘 ${pb} vs 800/480`);

  // ③ 中心线对齐:面板水平中心 = 视口中心 400(官方 g960 即居中设计,比例锚点保中心)
  const cx = panel.rect.x + panel.rect.w / 2;
  console.log(`[g800] Panel 水平中心=${cx.toFixed(4)}(视口中心 400,Δ=${Math.abs(cx - 400).toFixed(4)})`);
  if (Math.abs(cx - 400) > 0.5) fail(`Panel 中心线偏离视口中心 ${(cx - 400).toFixed(4)}px`);

  // ④ 应跟随改造生效:Bj(A.2 项)rect === Panel rect(全铺跟随)
  const bj = nodeOf(m.nodes, 'Panel/Bj');
  const eq = (a, b) => Math.abs(a - b) <= 1e-4;
  if (!(eq(bj.rect.x, panel.rect.x) && eq(bj.rect.y, panel.rect.y) && eq(bj.rect.w, panel.rect.w) && eq(bj.rect.h, panel.rect.h))) {
    fail(`Bj 未跟随 Panel: Bj=${JSON.stringify(bj.rect)} Panel=${JSON.stringify(panel.rect)}`);
  }
  console.log(`[g800] Bj rect === Panel rect ✓(A.2 应跟随项改造后全铺跟随,w=${bj.rect.w.toFixed(3)})`);

  // ⑤ 位置比例落位抽查(位置/中心线对齐基准):g800 = g960 × (5/6, 8/9)
  const SX = G800.w / 960, SY = G800.h / 540;
  console.log(`[g800] 位置比例落位抽查(容差 0.5px;尺寸容偏另行记录)——换算 x×${SX.toFixed(4)} y×${SY.toFixed(4)}`);
  for (const path of ['.', 'Panel', 'Panel/MoneyLay', 'Panel/TopRigLay', 'Panel/DayItemPos', 'Panel/MoneyLay/DataImg2', 'Panel/CloseBtn']) {
    const b = nodeOf(baseNodes, path), g = nodeOf(m.nodes, path);
    const dx = g.rect.x - b.rect.x * SX, dy = g.rect.y - b.rect.y * SY;
    const dw = g.rect.w - b.rect.w * SX, dh = g.rect.h - b.rect.h * SY;
    console.log(`  ${path}: Δx=${dx.toFixed(3)} Δy=${dy.toFixed(3)} Δw=${dw.toFixed(3)} Δh=${dh.toFixed(3)} | g800=(${g.rect.x.toFixed(2)},${g.rect.y.toFixed(2)},${g.rect.w.toFixed(2)},${g.rect.h.toFixed(2)})`);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) fail(`${path} 位置偏离比例落位超 0.5px`);
  }

  // ⑥ 尺寸容偏记录(D2:g800 位置对齐尺寸容偏——h 按 8/9 而非美术等比 5/6,非均匀换算差)
  const bp = nodeOf(baseNodes, 'Panel');
  console.log(`[g800] 尺寸容偏记录: Panel w ${bp.rect.w}→${panel.rect.w.toFixed(3)}(×${(panel.rect.w / bp.rect.w).toFixed(5)},等比宽 5/6=${(5 / 6).toFixed(5)}) h ${bp.rect.h}→${panel.rect.h.toFixed(3)}(×${(panel.rect.h / bp.rect.h).toFixed(5)},高度档 8/9=${(8 / 9).toFixed(5)})——h 相对美术等比(5/6)偏 +6.7%,即 D2 声明的容偏区间`);

  // ⑦ Label 类(最小行高钳制域)只记录不断言
  for (const path of ['Panel/MoneyLay/LoginMonthLabel', 'Panel/TopRigLay/DayNum1', 'Panel/CountdownPre']) {
    const b = baseNodes.find(x => x.path === path), g = m.nodes.find(x => x.path === path);
    if (b && g) console.log(`  [label] ${path}: g960=(${b.rect.x},${b.rect.y},${b.rect.w},${b.rect.h}) g800=(${g.rect.x.toFixed(2)},${g.rect.y.toFixed(2)},${g.rect.w.toFixed(2)},${g.rect.h.toFixed(2)})`);
  }

  // ⑧ g800 档 quality 报告(改造后预期无视口溢出)
  printReport(body);
  const vpOv = body.data.quality?.viewport_overflow ?? [];
  if (vpOv.length > 0) {
    console.error('[g800] 视口溢出残留:', JSON.stringify(vpOv));
    fail('g800 档仍有视口溢出命中');
  }
  console.log('[g800] 视口溢出 ×0 ✓ —— 全部硬门禁通过');
}

// ─── main ────────────────────────────────────────────────────────────────────

const stage = process.argv[2] ?? 'all';
const stages = { baseline: stageBaseline, plan: stagePlan, write: stageWrite, verify: stageVerify, g800: stageG800 };
if (!(stage in stages || stage === 'all')) {
  console.error(`未知 stage: ${stage}(可用: baseline|plan|write|verify|g800|all)`);
  process.exit(1);
}
const order = stage === 'all' ? ['baseline', 'plan', 'write', 'verify', 'g800'] : [stage];
for (const s of order) {
  console.log(`\n===== stage: ${s} =====`);
  await stages[s]();
}
console.log('\n[done] 验收驱动全流程结束');
