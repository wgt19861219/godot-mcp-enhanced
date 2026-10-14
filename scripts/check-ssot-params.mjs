#!/usr/bin/env node
// scripts/check-ssot-params.mjs
/**
 * P8-3 (2026-09-11): SSOT params 审计器(regiellis 移植的第二道防线,真正落仓——
 * 尽调 5.3.1 教训:regiellis 的 params 审计"proven by comment"不在仓库中)。
 *
 * 对账方向(双向):
 *   ① TS handler 源码读取的顶层 args 键 ⊆ matrix inputSchema.properties ∪ 白名单
 *      ——handler 读未声明键 = agent 无法经正规 schema 传 + typo 静默黑洞(SSOT 漂移)。
 *   ② matrix optionalParams/requiredParams ⊆ schema properties(生成产物自洽)。
 *
 * 白名单:scripts/ssot-allowlist.json —— 人工核对的合法豁免键(per-tool)。
 * 退出码:0 通过 / 1 发现漂移(CI 阻断)。
 * 用法:node scripts/check-ssot-params.mjs [--fix 生成白名单初稿]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MATRIX_PATH = join(ROOT, 'docs', 'capability-matrix.json');
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'ssot-allowlist.json');
const SRC_TOOLS = join(ROOT, 'src', 'tools');

// ─── 工具名 → handler 源文件归属(文件自证) ──────────────────────────────────
// module-loader 是 namespace import + 对象传参,工具名不在 loader 文本里——
// 改为每个 tools 源文件自证:①TOOL_META = { xxx: {...} } 的顶层键;
// ②getToolDefinitions 里的 name: 'xxx' 字面量(首层,不进嵌套)。
function loadModuleMap() {
  const map = new Map(); // toolName -> srcFile(相对根)
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { visit(full); continue; }
      if (!entry.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf-8');
      const rel = relative(ROOT, full).replace(/\\/g, '/');
      if (!rel.startsWith('src/tools/')) continue;
      // TOOL_META 顶层键:块内缩进键(扫描 TOOL_META = { 起 200 行窗口的顶层两空格键)
      const metaIdx = src.indexOf('TOOL_META');
      if (metaIdx !== -1) {
        const braceStart = src.indexOf('{', metaIdx);
        if (braceStart !== -1) {
          let depth = 0, i = braceStart;
          for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) break; }
          }
          const body = src.slice(braceStart + 1, i);
          let m2;
          const keyRe = /\n\s{2}([a-z_][\w]*):\s*\{/g;
          while ((m2 = keyRe.exec(body)) !== null) {
            if (!map.has(m2[1])) map.set(m2[1], rel);
          }
        }
      }
      // getToolDefinitions 的 name 字面量
      let m3;
      const nameRe = /name:\s*'([\w]+)'/g;
      while ((m3 = nameRe.exec(src)) !== null) {
        if (!map.has(m3[1])) map.set(m3[1], rel);
      }
    }
  };
  visit(SRC_TOOLS);
  return map;
}

// ─── 提取 handler 源码读取的顶层 args 键 ────────────────────────────────────
// 形态:args.get("key") / args.get('key') / args.key(属性访问,排除 args.xxx 误报
// 用词边界+常见非键形态过滤)。只扫每个工具的归属文件(+ 同目录同名目录工具)。
function extractArgKeys(filePath) {
  if (!existsSync(filePath)) return new Set();
  const files = [filePath];
  // 目录形态工具(src/tools/scene/):同目录全部 .ts 一并扫
  const dir = dirname(filePath);
  const baseName = filePath.split(/[\\/]/).pop().replace(/\.ts$/, '');
  const pkg = join(dir, baseName);
  if (existsSync(pkg) && statSync(pkg).isDirectory()) {
    for (const f of readdirSync(pkg)) if (f.endsWith('.ts')) files.push(join(pkg, f));
  }
  const keys = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    let m;
    const getRe = /args\.get\(\s*['"]([\w.]+)['"]/g;
    while ((m = getRe.exec(src)) !== null) keys.add(m[1]);
    // 属性访问形态:args.foo(排除链式 args.foo.bar 只取第一段)。单词边界防 matchesArgs 误报。
    const propRe = /(?<![.\w])(?:args|effectiveArgs)\.([a-z_][A-Za-z0-9_]*)/g;
    while ((m = propRe.exec(src)) !== null) keys.add(m[1]);
  }
  // 通用噪音键(非业务参数):dispatcher 已消费或 JS 内部用法
  const NOISE = new Set(['then', 'catch', 'length', 'map', 'filter', 'join', 'toString',
    'hasOwnProperty', 'constructor', 'prototype', 'keys', 'size']);
  for (const n of NOISE) keys.delete(n);
  return keys;
}

// ─── 跨文件委托追踪(C1 2026-10-14) ─────────────────────────────────────────
// handler 的 args 读取可发生在被委托文件(如 workflow 的 batch 三 action 委托
// batch-tools.ts handleBatchAction——schema 在 workflow 声明,读取在 batch-tools)。
// 源文件内显式标记 `// SSOT-DELEGATE: src/tools/xxx.ts` 即把目标文件的 handler
// 键池并入本文件对账范围:防"schema 声明在此、读取在彼"形态静默逃过审计;反向,
// 若 schema 再删被委托参数,委托键池立刻触发漂移报警。
function extractDelegates(filePath) {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, 'utf-8');
  const out = [];
  let m;
  const re = /\/\/\s*SSOT-DELEGATE:\s*((?:src|test|scripts)\/[\w./-]+\.(?:ts|js))/g;
  while ((m = re.exec(src)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf-8'));
const tools = matrix.tools ?? matrix;
const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'))
  : {};
const moduleMap = loadModuleMap();

const fixMode = process.argv.includes('--fix');
const draft = {};
const violations = [];

// 对账单位 = 文件(同文件多工具共享 handler 源码——advanced-proxy 的
// handleListDynamicRoutes 读 tool/search 但归属 godot_list_dynamic_routes,
// 文件级首个工具名归属会误报;文件级键池 ⊆ 该文件全部工具声明键并集 ∪ 白名单)。
// 每文件聚合:声明键并集(全部工具) + handler 键池(全部 .ts)。
const fileAgg = new Map(); // srcFile -> {declared:Set, tools:[], handlerKeys:Set}
for (const t of tools) {
  const name = t.name;
  const props = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [];
  // ② matrix 参数清单 ⊆ schema properties(生成产物自洽)
  for (const p of [...(t.requiredParams ?? []), ...(t.optionalParams ?? [])]) {
    if (!props.includes(p)) violations.push(`[matrix自洽] ${name}: ${p} 在 required/optionalParams 但不在 inputSchema.properties`);
  }
  const file = moduleMap.get(name);
  if (!file) continue;
  const agg = fileAgg.get(file) ?? { declared: new Set(), tools: [], hasSchemaProps: false };
  for (const p of props) agg.declared.add(p);
  if (props.length > 0) agg.hasSchemaProps = true;
  for (const a of (allowlist[name] ?? [])) agg.declared.add(a);
  agg.tools.push(name);
  fileAgg.set(file, agg);
}
for (const [file, agg] of fileAgg) {
  // godot_path 是 dispatcher 级公共覆盖键(全部工具可传)
  agg.declared.add('godot_path');
  if (!agg.hasSchemaProps) continue; // 全文件无 properties(自由 dict 工具)= P8-2 不查,审计同语义跳过
  const keys = extractArgKeys(join(ROOT, file));
  // C1: 并入 SSOT-DELEGATE 标记的被委托文件键池(schema 声明在此、读取在彼)
  for (const dep of extractDelegates(join(ROOT, file))) {
    for (const k of extractArgKeys(join(ROOT, dep))) keys.add(k);
  }
  for (const k of keys) {
    if (agg.declared.has(k)) continue;
    if (fixMode) {
      for (const name of agg.tools) (draft[name] ??= []).push(k);
    } else {
      violations.push(`[SSOT漂移] ${agg.tools.join('|')}(${file}): handler 读取 args 键 '${k}' 但 inputSchema 未声明——agent 无法经正规 schema 传递该参数(typo 黑洞风险)。修 schema properties 或进 scripts/ssot-allowlist.json(人工核对后)`);
    }
  }
}

if (fixMode) {
  writeFileSync(ALLOWLIST_PATH, JSON.stringify(draft, null, 2) + '\n');
  console.log(`[check-ssot-params] --fix: 白名单初稿已写入 ${ALLOWLIST_PATH}(${Object.keys(draft).length} 工具)——请人工核对后提交`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error(`[check-ssot-params] ✗ ${violations.length} 处漂移:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`[check-ssot-params] ✓ 通过:${tools.length} 工具对账零漂移(handler args 键 ⊆ schema ∪ 白名单;matrix 参数清单自洽)`);
