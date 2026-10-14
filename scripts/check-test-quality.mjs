#!/usr/bin/env node
// scripts/check-test-quality.mjs
// 测试套件自身质量门禁（E-P2，报告4 :98）。三检测器任一 fail → exit 1：
//   ① 死文件：test/ 下非 *.test.* 文件 0 引用（代码 import/require + 配置 setupFiles/glob）
//   ② mock/src drift：vi.mock 工厂顶层 key ∉ 对应 src 导出集（括号深度解析 + export* 追溯）
//   ③ 弱断言占比上限：防恶化，不强制消除
//
// 详见 docs/superpowers/specs/2026-07-30-e-p2-test-quality-gate-design.md
//
// 用法：node scripts/check-test-quality.mjs
// 退出码：0=全过，1=有检测器 fail

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';

// ─── 共用工具 ───────────────────────────────────────────────────────────────

/** 递归遍历目录返回全部文件路径（相对 cwd）。 */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const CODE_EXT = /\.(ts|js|mjs|cjs)$/;
const CONFIG_FILES = ['vitest.config.ts', 'package.json', 'tsconfig.json'];

// ─── 检测器 1：死文件 ───────────────────────────────────────────────────────

/**
 * 扫 test/ 下所有 .js/.ts 非 .test. 文件，查代码 import/require + 配置引用。
 * @returns {{dead: string[]}} dead = 0 引用文件路径列表
 */
function detectDeadFiles() {
  const allCode = [
    ...walk('test'),
    ...walk('src'),
    ...walk('scripts'),
  ].filter(f => CODE_EXT.test(f));

  const candidates = walk('test')
    .filter(f => /\.(ts|js)$/.test(f) && !/\.test\./.test(f));

  const dead = [];
  for (const tf of candidates) {
    const stem = basename(tf, extname(tf));
    // 代码引用：import/require（basename 可带可不带 .js/.ts 后缀）
    const codeRe = new RegExp(
      `(from ['"][^'"]*${stem}(?:\\.js|\\.ts)?['"]|require\\(['"][^'"]*${stem})`
    );
    const codeRefs = allCode.some(f => f !== tf && codeRe.test(readFileSync(f, 'utf8')));
    // 配置引用：vitest.config.ts/package.json/tsconfig.json 含 basename
    // （覆盖 setupFiles/glob 等非 import 引入方式，防 setup.js 误判）
    const configRefs = CONFIG_FILES.some(
      cf => existsSync(cf) && readFileSync(cf, 'utf8').includes(stem)
    );
    if (!codeRefs && !configRefs) dead.push(tf);
  }
  return { dead };
}

// ─── 检测器 2：mock/src drift（括号深度解析器） ─────────────────────────────

/**
 * 括号配对提取所有完整 vi.mock(...) 调用块。
 * 扁平正则会把 mock 返回值嵌套字段误判为 key，必须深度配对。
 */
function extractMockCalls(txt) {
  const out = [];
  let i = 0;
  while ((i = txt.indexOf('vi.mock(', i)) !== -1) {
    let depth = 0, inStr = false, q = null, j;
    for (j = i + 8; j < txt.length; j++) {
      const c = txt[j];
      if (inStr) {
        if (c === q && txt[j - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) { out.push(txt.slice(i, j + 1)); break; } depth--; }
    }
    i = j + 1;
  }
  return out;
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'return', 'const', 'let', 'var', 'true', 'false',
  'null', 'case', 'default', 'break', 'continue', 'new', 'typeof',
]);

/**
 * 提取 vi.mock 工厂对象的【顶层】key（花括号 depth=1 且圆括号 depth=0 层的 标识符:）。
 * 同时追踪 {} 和 () 深度 + 跳过注释/字符串：
 *   - 花括号 depth≥2 的嵌套返回值字段（getLogger: () => ({ info }) 的 info）被忽略
 *   - 圆括号 depth≥1 的箭头函数参数类型注解（(_root: string) 的 _root）被忽略
 *   - 行注释、块注释内的标识符被忽略（防注释里的 T4 等误判）
 *   - 泛型 <T> 不含 : 属性语法，天然不受影响
 */
function factoryTopKeys(mc) {
  const ai = mc.indexOf('=>');
  if (ai === -1) return [];
  let i = ai;
  while (i < mc.length && mc[i] !== '{') i++; // 工厂对象起始 {
  if (i >= mc.length) return [];
  i++; // 跳过起始 {
  let brace = 1, paren = 0, inStr = false, q = null;
  const keys = [];
  for (let j = i; j < mc.length && brace > 0; j++) {
    const c = mc[j];
    const next = mc[j + 1];
    if (inStr) {
      if (c === q && mc[j - 1] !== '\\') inStr = false;
      continue;
    }
    // 跳过 // 行注释
    if (c === '/' && next === '/') {
      while (j < mc.length && mc[j] !== '\n') j++;
      continue;
    }
    // 跳过 /* */ 块注释
    if (c === '/' && next === '*') {
      j += 2;
      while (j < mc.length && !(mc[j] === '*' && mc[j + 1] === '/')) j++;
      j++; // 跳过结束 /
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '{') brace++;
    if (c === '}') brace--;
    if (c === '(') paren++;
    if (c === ')') paren--;
    // 仅在工厂对象顶层（brace===1）且不在任何圆括号内（paren===0）识别 标识符:
    if (brace === 1 && paren === 0 && /[A-Za-z_$]/.test(c)) {
      let k = j, id = '';
      while (k < mc.length && /[\w$]/.test(mc[k])) { id += mc[k]; k++; }
      if (mc[k] === ':' && !KEYWORDS.has(id)) keys.push(id);
      j = k - 1;
    }
  }
  return keys;
}

/**
 * 溯源 src 文件导出集：自身 export + export * 递归追溯（seen 防环）。
 * 处理 src/tools/shared.ts 这类纯 re-export 文件。
 */
function srcExports(srcPath, seen = new Set()) {
  if (seen.has(srcPath) || !existsSync(srcPath)) return new Set();
  seen.add(srcPath);
  const txt = readFileSync(srcPath, 'utf8');
  const ex = new Set();
  // export function/const/class/let/var/async function NAME
  for (const m of txt.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    ex.add(m[1]);
  }
  // export { a, b as c } named re-export（取 as 前原名）
  for (const m of txt.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (let name of m[1].split(',')) {
      name = name.trim().split(/\s+as\s+/)[0].trim();
      if (name) ex.add(name);
    }
  }
  // export * from './x.js' → 递归追溯
  for (const m of txt.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const dep = resolve(dirname(srcPath), m[1].replace(/\.js$/, '.ts'));
    for (const e of srcExports(dep, seen)) ex.add(e);
  }
  return ex;
}

/**
 * 扫所有 test/ 测试文件的 vi.mock，对比顶层 key 与 src 导出集。
 * @returns {{drifts: Array<{file:string, mod:string, drift:string[]}>}}
 */
function detectMockDrift() {
  const testFiles = walk('test').filter(f => /\.test\.(ts|js)$/.test(f));
  const drifts = [];
  for (const f of testFiles) {
    const txt = readFileSync(f, 'utf8');
    for (const mc of extractMockCalls(txt)) {
      const modM = mc.match(/vi\.mock\(\s*(['"`])([^'"`]+)\1/);
      if (!modM) continue;
      const mod = modM[2];
      if (!/[.]+\/src\//.test(mod)) continue; // 只看 src 模块，跳过 node 内建
      const keys = factoryTopKeys(mc);
      if (keys.length === 0) continue;
      const rel = mod.replace(/^.*\/src\//, 'src/');
      // 兜底:无后缀或 .js 后缀都规整到 .ts(防 mock 路径省略后缀致 srcPath 落空 → 全 drift 误报)
      const srcPath = rel.replace(/\.(js|ts)$/, '') + '.ts';
      const ex = srcExports(srcPath);
      const drift = keys.filter(k => !ex.has(k));
      if (drift.length) drifts.push({ file: f, mod: rel, drift });
    }
  }
  return { drifts };
}

// ─── 检测器 3：弱断言占比上限（防恶化） ─────────────────────────────────────

/**
 * 基线 2026-08-15 实测 819（2026-08 上半月各批次加测试时未同步上限,原 810 已被存量超越）。
 * 阈值：基线 + ~5% 容差 = 860。粗 grep 含合理用法（字段访问前存在性前置等），作"防恶化上限"非"消除目标"。
 */
const WEAK_ASSERTION_LIMIT = 860;
const WEAK_RE = /(\.toBeTruthy\(\)|\.toBeDefined\(\)|\.not\.toBeNull\(\))/g;

/**
 * @returns {{count:number, limit:number}}
 */
function countWeakAssertions() {
  const testFiles = walk('test').filter(f => /\.test\.(ts|js)$/.test(f));
  let count = 0;
  for (const f of testFiles) {
    const txt = readFileSync(f, 'utf8');
    const m = txt.match(WEAK_RE);
    if (m) count += m.length;
  }
  return { count, limit: WEAK_ASSERTION_LIMIT };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  let failed = false;

  // 检测器 1
  const { dead } = detectDeadFiles();
  if (dead.length > 0) {
    failed = true;
    console.error(`❌ [检测器1 死文件] ${dead.length} 个 test/ 文件 0 引用（代码+配置）：`);
    for (const f of dead) console.error(`   ${f}`);
  } else {
    console.log('✅ [检测器1 死文件] 无死文件');
  }

  // 检测器 2
  const { drifts } = detectMockDrift();
  if (drifts.length > 0) {
    failed = true;
    console.error(`❌ [检测器2 mock/src drift] ${drifts.length} 处顶层 mock key ∉ src 导出集：`);
    for (const d of drifts) {
      console.error(`   [${d.file}] ${d.mod}  drift: ${d.drift.join(', ')}`);
    }
  } else {
    console.log('✅ [检测器2 mock/src drift] 无 drift');
  }

  // 检测器 3
  const { count, limit } = countWeakAssertions();
  if (count > limit) {
    failed = true;
    console.error(`❌ [检测器3 弱断言] ${count} > 上限 ${limit}（防恶化，改善后下调）`);
  } else {
    console.log(`✅ [检测器3 弱断言] ${count} ≤ 上限 ${limit}`);
  }

  if (failed) {
    console.error('\n测试质量门禁 FAIL');
    process.exit(1);
  }
  console.log('\n测试质量门禁 PASS');
}

main();
