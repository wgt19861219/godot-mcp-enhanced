#!/usr/bin/env node
// scripts/refero-batch3-acceptance.mjs
// 批3 Task 5 靶子轻量验收驱动——tokens 层(token_set/token_list/$token import 链)数字存档。
//
// 手工流程脚本(批1/批2 同款纪律):靶子路径不在本仓,CI 永不跑;GODOT_PATH + 靶子
// 项目存在双门控,缺任一直接退出。靶子真实文件**只读**——全部验收经 `_batch3_*` 副本
// (theme 逐字节复制 + 场景复制)进行,finally 删除临时文件。
//
// **靶子 git 断言 = 与验收前形态一致**(非"干净"断言,orchestrator 裁决覆盖 brief 原文):
// 验收开始前记录 `git -C 靶子 status --porcelain` 快照(靶子暂存区可能有用户未裁决改动),
// finally 清理副本后断言当前状态与快照逐行一致——验收不得改变靶子任何形态。
// 快照前幂等预清理 `_batch3_*` 残留(fail 抛异常保 finally 必跑,但防御历史残留混入快照)。
//
// 三步(brief Step 2 的 ①②③,④为快照落盘):
//   ① 空档   —— 副本 theme(default_theme.tres 逐字节复制,无 DesignTokens)→ token_list
//              → 空 {colors:{}, constants:{}}(诚实空,审计语义缺失≠错误);探针记
//              主题完整性 before 快照(get_type_list + 每 type 全量读数,值级)。
//   ② 写入   —— token_set ×3(两色 + 一常量,全 float32 安全值 2 的幂次:0.5/0.25/0.75/1
//              与 8)→ token_list 逐值 === 读回;**主题完整性断言**——token_set 前后探针
//              比对:types 恰多出 "DesignTokens",其余 type 的 colors/constants/font_sizes
//              值 + fonts/styleboxes/variations 名单逐项一致(ResourceSaver 对真 .tres 的
//              load+save 未破坏既有内容,compareBaseline 思路的 theme 版,强度 = 全量
//              而非代表项抽样)。
//   ③ import —— 副本场景(daily_login_content.tscn 复制)+ 小 geometry(两 Panel 的 bg
//              $ 引用副本 theme token)+ theme_path → ui_import_prototype → style_verify
//              bg 槽分量 delta 0(float32 位级 roundtrip)+ tokens_resolved 数字。
//
// 主题完整性探针的实现载体(前置事实裁决):驱动脚本自己 spawn 一次 Godot(headless
// --path 靶子 --script 临时 .gd,探针文件写 os.tmpdir() 不留靶子),读 Theme 的
// get_type_list/get_color_list+get_color/get_constant_list+get_constant/get_font_size_list+
// get_font_size/get_font_list/get_stylebox_list/get_type_variation_list;输出带
// __BATCH3_PROBE__ 前缀的 JSON 行,驱动侧按前缀过滤解析(引擎 banner 噪音隔离)。
// 不走 execute_gdscript(handleTool 直调不含该工具,引入 gdscript handler 依赖不如
// 单 spawn 直读稳)。
//
// 用法:GODOT_PATH=<godot 可执行> node scripts/refero-batch3-acceptance.mjs
//   (无 stage 参数——三步共享同一副本 theme 生命周期,分步会让 ② 的写入无法供 ③ 消费)
//   node scripts/refero-batch3-acceptance.mjs clean  # 兜底清理副本
// 快照落 docs/superpowers/plans/refero-batch3-acceptance/(与批1/批2 同款归档)。

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { handleTool } from '../build/tools/ui/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓根
const GODOT = process.env.GODOT_PATH || '';
const TARGET = 'D:/workspace/projects/DotaLegendGodot';
const TRUE_THEME_RES = 'res://resources/themes/default_theme.tres';
const TRUE_SCENE_RES = 'res://scenes/ui/daily_login_content.tscn';
const DATA_DIR = join(ROOT, 'docs/superpowers/plans/refero-batch3-acceptance');

// 靶子项目内临时副本(untracked,finally 删除——git 状态验收前后一致)
const THEME_COPY_RES = 'res://resources/themes/_batch3_tokens.tres';
const SCENE_COPY_RES = 'res://scenes/ui/_batch3_import_copy.tscn';

// float32 安全值(全 2 的幂次,.tres → Color(float32) → JSON → 字面量 → build Color →
// measure 读回全链位级无损,Task 3 e2e 同款取值依据)
const TOKEN_COLOR_A = [0.5, 0.25, 0.75, 1];
const TOKEN_COLOR_B = [0.25, 0.5, 0.75, 1];
const TOKEN_CONST = 8;

// ③ import 链小 geometry:两 Panel 的 bg 均 $ 引用(视口与靶子项目一致 960×540;
// 两 rect y 向分离不交叉,不触 INVALID_PARAMS 的交叉重叠拒)
const GEO = {
  viewport: { w: 960, h: 540 },
  nodes: [
    { name: 'TokenPanel', rect: { x: 40, y: 40, w: 240, h: 80 }, type: 'Panel', bg: '$brand' },
    { name: 'AccentPanel', rect: { x: 40, y: 140, w: 240, h: 40 }, type: 'Panel', bg: '$accent' },
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
// 路径白名单:本机 env 的 ALLOWED_PROJECT_PATHS 不一定含靶子(批1 同款现实)。
// 驱动脚本显式把声明的 TARGET 追加进进程内白名单(官方扩展机制)——只在本进程生效。
if (!(process.env.ALLOWED_PROJECT_PATHS ?? '').split(';').some(p => p.replace(/\\/g, '/').toLowerCase() === TARGET.toLowerCase())) {
  process.env.ALLOWED_PROJECT_PATHS = (process.env.ALLOWED_PROJECT_PATHS ? process.env.ALLOWED_PROJECT_PATHS + ';' : '') + TARGET;
  console.log('[gate] ALLOWED_PROJECT_PATHS 进程内追加靶子根:', TARGET);
}

const ctx = { findGodot: async () => GODOT };

// fail 用抛异常而非 process.exit——exit 会跳过 finally,副本清理不执行即污染靶子
// (首跑 parse error 实测教训:残留 _batch3_* 副本,次跑快照记入残留导致断言语义漂移)。
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

// ─── 主题完整性探针(spawn 一次 Godot 读 Theme 全量值级读数)──────────────────

/** 探针 GD 脚本(写 os.tmpdir(),不留靶子;theme_res 内插为 res:// 字面量)。 */
function writeProbeScript(themeRes) {
  const gd = `extends SceneTree

func _initialize():
	var t = load("${themeRes}")
	if t == null or not t is Theme:
		print("__BATCH3_PROBE__" + JSON.stringify({"error": "load failed: ${themeRes}"}))
		quit(1)
		return
	var types: Array = []
	for ty in t.get_type_list():
		types.append(str(ty))
	types.sort()
	var probe := {}
	for ty in types:
		var colors := {}
		for c in t.get_color_list(ty):
			var v: Color = t.get_color(c, ty)
			colors[str(c)] = [v.r, v.g, v.b, v.a]
		var constants := {}
		for k in t.get_constant_list(ty):
			constants[str(k)] = t.get_constant(k, ty)
		var font_sizes := {}
		for fs in t.get_font_size_list(ty):
			font_sizes[str(fs)] = t.get_font_size(fs, ty)
		var fonts: Array = []
		for f in t.get_font_list(ty):
			fonts.append(str(f))
		fonts.sort()
		var styleboxes: Array = []
		for s in t.get_stylebox_list(ty):
			styleboxes.append(str(s))
		styleboxes.sort()
		var variations: Array = []
		var base: StringName = t.get_type_variation_base(ty)
		if base != &"" and base != "":
			variations.append(str(base))
		probe[ty] = {"colors": colors, "constants": constants, "font_sizes": font_sizes, "fonts": fonts, "styleboxes": styleboxes, "variations": variations}
	print("__BATCH3_PROBE__" + JSON.stringify({"types": types, "probe": probe}))
	quit(0)
`;
  const p = join(tmpdir(), `batch3-theme-probe-${process.pid}.gd`);
  writeFileSync(p, gd, 'utf-8');
  return p;
}

/** 跑探针一次,返回 {types: string[], probe: Record<string, {...}>}(失败 fail)。 */
function probeTheme(themeRes) {
  const scriptPath = writeProbeScript(themeRes);
  try {
    const r = spawnSync(GODOT, ['--headless', '--path', TARGET, '--script', scriptPath], {
      encoding: 'utf-8', timeout: 120_000,
    });
    if (r.error) fail(`探针 spawn 失败: ${r.error.message}`);
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('__BATCH3_PROBE__'));
    if (!line) fail(`探针输出未命中 __BATCH3_PROBE__ 前缀(stderr 尾: ${(r.stderr ?? '').slice(-300)})`);
    try {
      return JSON.parse(line.slice('__BATCH3_PROBE__'.length));
    } catch (e) {
      fail(`探针 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

/** 键序无关的规范化序列化(结构化深度比对,不依赖 GD Dictionary 插入序)。 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ─── 靶子 git 状态核验(验收前后必须与快照逐行一致,非"干净"断言)──────────────

function targetGitPorcelain() {
  return execSync(`git -C "${TARGET}" status --porcelain`, { encoding: 'utf-8' });
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

if (process.argv[2] === 'clean') {
  for (const f of [THEME_COPY_RES, SCENE_COPY_RES]) rmSync(targetAbs(f), { force: true });
  console.log('[clean] 临时副本清理完成');
  process.exit(0);
}
if (process.argv[2] !== undefined) {
  console.error(`本驱动无 stage 参数(三步共享副本生命周期);可用: clean。收到: ${process.argv[2]}`);
  process.exit(1);
}

// 幂等预清理:上次异常中断残留的 _batch3_* 副本不能进"验收前快照"(那会把本驱动的
// 历史垃圾误当用户未裁决改动)。_batch3_ 前缀是本驱动自有的临时命名空间,预清理安全。
for (const f of [THEME_COPY_RES, SCENE_COPY_RES]) {
  if (existsSync(targetAbs(f))) {
    rmSync(targetAbs(f), { force: true });
    console.log(`[gate] 预清理上次运行残留副本: ${f}`);
  }
}

const GIT_SNAPSHOT = targetGitPorcelain();
console.log(`[gate] 靶子 git 验收前快照(${GIT_SNAPSHOT.trim() === '' ? '干净' : `${GIT_SNAPSHOT.trim().split('\n').length} 行`}):\n${GIT_SNAPSHOT || '(empty)'}`);

cpSync(targetAbs(TRUE_THEME_RES), targetAbs(THEME_COPY_RES));
cpSync(targetAbs(TRUE_SCENE_RES), targetAbs(SCENE_COPY_RES));
console.log(`[setup] 副本 theme ← ${TRUE_THEME_RES};副本场景 ← ${TRUE_SCENE_RES}`);

// 外层 catch 兜底所有 fail 抛出的异常(内层 finally 先清理副本再冒泡)——失败也保证
// 靶子回到验收前形态,退出码 1 由 exitCode 设置(node 自然退出,不截断清理)。
try {
try {
  // ── ① 空档:token_list 空 dict + 主题完整性 before 快照 ────────────────────
  const emptyData = await callUi({ action: 'token_list', project_path: TARGET, theme_path: THEME_COPY_RES }, 'token_list(空档)');
  const emptyList = emptyData.token_list;
  if (JSON.stringify(emptyList) !== JSON.stringify({ colors: {}, constants: {} })) {
    fail(`空档预期 {colors:{}, constants:{}},实际 ${JSON.stringify(emptyList)}`);
  }
  console.log(`[① 空档] token_list → {colors:{}, constants:{}}(default_theme 无 DesignTokens,诚实空)✓`);
  const before = probeTheme(THEME_COPY_RES);
  if (before.error) fail(`探针 before 失败: ${before.error}`);
  if (before.types.includes('DesignTokens')) fail('探针 before 不应含 DesignTokens(副本是逐字节复制)');
  console.log(`[① 探针] before:types x${before.types.length}(无 DesignTokens),值级读数快照入内存`);

  // ── ② 写入 + 审计 + 主题完整性 ─────────────────────────────────────────────
  const setResults = [];
  const setPlan = [
    ['brand', TOKEN_COLOR_A, 'color'],
    ['accent', TOKEN_COLOR_B, 'color'],
    ['space_1', TOKEN_CONST, 'constant'],
  ];
  for (const [name, value, kind] of setPlan) {
    const d = await callUi({ action: 'token_set', project_path: TARGET, theme_path: THEME_COPY_RES, token_name: name, token_value: value }, `token_set(${name})`);
    const ts = d.token_set;
    if (ts?.name !== name || ts?.kind !== kind) fail(`token_set(${name}) 返回 ${JSON.stringify(ts)}`);
    setResults.push(ts);
  }
  console.log('[② 写入] token_set ×3(brand/accent 色 + space_1 常量,kind 逐项匹配)✓');

  const afterList = (await callUi({ action: 'token_list', project_path: TARGET, theme_path: THEME_COPY_RES }, 'token_list(写入后)')).token_list;
  for (let i = 0; i < 4; i++) {
    if (afterList.colors.brand?.[i] !== TOKEN_COLOR_A[i]) fail(`colors.brand[${i}] 预期 ${TOKEN_COLOR_A[i]},实际 ${afterList.colors.brand?.[i]}`);
    if (afterList.colors.accent?.[i] !== TOKEN_COLOR_B[i]) fail(`colors.accent[${i}] 预期 ${TOKEN_COLOR_B[i]},实际 ${afterList.colors.accent?.[i]}`);
  }
  if (afterList.constants.space_1 !== TOKEN_CONST) fail(`constants.space_1 预期 ${TOKEN_CONST},实际 ${afterList.constants.space_1}`);
  if (Object.keys(afterList.colors).length !== 2 || Object.keys(afterList.constants).length !== 1) {
    fail(`token_list 计数预期 2 色 + 1 常量,实际 ${JSON.stringify(Object.keys(afterList))}`);
  }
  console.log('[② 审计] token_list 逐值 === 读回(brand [0.5,0.25,0.75,1] / accent [0.25,0.5,0.75,1] / space_1 8,无多余键)✓');

  const after = probeTheme(THEME_COPY_RES);
  if (after.error) fail(`探针 after 失败: ${after.error}`);
  // types 恰多出 DesignTokens(不多不少)
  const added = after.types.filter(t => !before.types.includes(t));
  const removed = before.types.filter(t => !after.types.includes(t));
  if (JSON.stringify(added) !== JSON.stringify(['DesignTokens']) || removed.length !== 0) {
    fail(`探针 types 变化预期恰 +["DesignTokens"],实际 +${JSON.stringify(added)} -${JSON.stringify(removed)}`);
  }
  // 既有 type 的值级读数逐项一致(全量比对,强于"代表项抽样")
  let checked = 0;
  for (const ty of before.types) {
    if (canonical(before.probe[ty]) !== canonical(after.probe[ty])) {
      fail(`探针 type "${ty}" 前后读数不一致:\nbefore=${canonical(before.probe[ty]).slice(0, 300)}\nafter =${canonical(after.probe[ty]).slice(0, 300)}`);
    }
    checked++;
  }
  // 新增 DesignTokens 段恰为写入的三 token
  const dt = after.probe['DesignTokens'];
  if (canonical(dt?.colors) !== canonical({ brand: TOKEN_COLOR_A, accent: TOKEN_COLOR_B }) ||
      canonical(dt?.constants) !== canonical({ space_1: TOKEN_CONST })) {
    fail(`DesignTokens 段读数异常: ${JSON.stringify(dt)}`);
  }
  console.log(`[② 完整性] 主题完整性 ✓:types 恰 +"DesignTokens";既有 ${checked} type 值级读数(colors/constants/font_sizes 值 + fonts/styleboxes 名单)前后一致;DesignTokens 段 = 3 token`);

  // ── ③ import 链:$ 引用 + style_verify 位级 delta + tokens_resolved ────────
  const importData = await callUi({
    action: 'ui_import_prototype', project_path: TARGET, scene_path: SCENE_COPY_RES,
    geometry: GEO, theme_path: THEME_COPY_RES,
  }, 'ui_import_prototype($token)');
  const tr = importData.tokens_resolved;
  if (tr?.theme_path !== THEME_COPY_RES || tr?.refs !== 2 ||
      JSON.stringify(tr?.tokens) !== JSON.stringify(['brand', 'accent'])) {
    fail(`tokens_resolved 预期 {theme_path, refs:2, tokens:[brand,accent]},实际 ${JSON.stringify(tr)}`);
  }
  console.log(`[③ import] tokens_resolved = {refs: ${tr.refs}, tokens: [${tr.tokens.join(', ')}]} ✓`);
  for (const nodeName of ['TokenPanel', 'AccentPanel']) {
    const entry = (importData.style_verify ?? []).find(
      e => e.path.endsWith(`/${nodeName}`) && e.slot === 'panel' && e.field === 'bg_color');
    if (!entry) fail(`style_verify 缺 ${nodeName} 的 panel 槽 bg_color 条目(实际 ${JSON.stringify(importData.style_verify ?? []).slice(0, 300)})`);
    const deltas = entry.delta;
    if (!Array.isArray(deltas) || deltas.some(d => d !== 0) || entry.ok !== true) {
      fail(`${nodeName} bg_color 分量 delta 预期全 0,实际 ${JSON.stringify(deltas)} ok=${entry.ok}`);
    }
    console.log(`[③ import] ${nodeName} panel 槽 bg_color delta = ${JSON.stringify(deltas)}(float32 位级 roundtrip)✓`);
  }
  const lv = importData.layout_verify ?? {};
  console.log(`[③ import] layout_verify:diff x${(lv.diff ?? []).length} / overlaps x${(lv.overlaps ?? []).length} / out_of_bounds x${(lv.out_of_bounds ?? []).length}`);

  // ── ④ 快照 ×3 落盘 ─────────────────────────────────────────────────────────
  saveJson('token-empty-baseline.json', { token_list: emptyList, probe_types_before: before.types.length });
  saveJson('token-after-write.json', {
    token_set: setResults, token_list: afterList,
    probe: { types: after.types, design_tokens: dt },
    integrity: { types_before: before.types.length, types_after: after.types.length, existing_types_checked: checked },
  });
  saveJson('import-token-chain.json', {
    geometry: GEO, theme_path: THEME_COPY_RES,
    tokens_resolved: tr,
    style_verify: importData.style_verify ?? [],
    layout_verify: lv,
    build_warnings: importData.build_warnings ?? [],
  });
} finally {
  rmSync(targetAbs(THEME_COPY_RES), { force: true });
  rmSync(targetAbs(SCENE_COPY_RES), { force: true });
  console.log('[finally] 临时副本已清理(副本 theme + 副本场景)');
}

const gitNow = targetGitPorcelain();
if (gitNow !== GIT_SNAPSHOT) {
  fail(`靶子 git 状态与验收前快照不一致:\n--- 验收前 ---\n${GIT_SNAPSHOT}--- 验收后 ---\n${gitNow}`);
}
console.log('[gate] 靶子 git 状态与验收前快照逐行一致 ✓(真实文件零读写,副本已清理)');
console.log('\n[done] 批3 验收驱动全流程结束');
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
