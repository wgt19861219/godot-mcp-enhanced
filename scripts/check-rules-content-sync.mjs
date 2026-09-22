#!/usr/bin/env node
// scripts/check-rules-content-sync.mjs
// 2026-08-07 审查 P2 建立;2026-08-16 原型翻译层审查遗留③升级:
// .claude/rules/godot-mcp-*.md 与 src/tools/rule-templates.ts 的 DETAILED_RULE_TEMPLATES
// 是两份独立副本(非生成关系,见 rule-templates.ts 头注释),check-rules-version-bump.mjs
// 只校验版本 bump 不校验内容——内容 drift 静默放过(2026-07-27 get_node_layout PR
// 第三方审查才发现 B-1 BLOCKING drift 的根因)。本脚本机械归一化 diff 堵此盲区。
//
// 2026-08-16 升级(历史 drift 已清零,本批启用 STRICT):
// 1. 归一化收紧:旧版把全文所有 semver 抹成 VERSION(会掩盖 Godot 4.6/4.7 等真实版本
//    差异)+压缩全部空白(diff 粒度退化)。现改为:CRLF→LF + 仅锚定版本行
//    "godot-mcp-enhanced v0.17.0+"(文件侧)↔"godot-mcp-enhanced {{MCP_VERSION}}+"(模板侧)
//    互抹(支持两段版本号如 v0.19),其余内容逐字比对。
// 2. 双向对账:模板键↔.claude/rules/godot-mcp-*.md 文件名双向(旧版只查单向且 WARN 不计)。
// 3. 差异定位改行级(旧版压缩后 char 定位难读)。
//
// 模式:
//   默认(advisory) = drift 时 exit 0 + stderr WARN(本地快速查)
//   STRICT=1        = drift 时 exit 1(CI 阻断,2026-08-16 起接入,新 drift 防护)
//
// 用法: node scripts/check-rules-content-sync.mjs(需先 npm run build)
// 退出码: advisory 恒 0 / STRICT 0=一致 1=drift 或 build 产物不可加载

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// 动态 import rule-templates.ts 编译产物(build/tools/rule-templates.js)
const templatesPath = join(repoRoot, 'build', 'tools', 'rule-templates.js');
if (!existsSync(templatesPath)) {
  console.error('[check-rules-content-sync] build/tools/rule-templates.js 不存在，请先 npm run build');
  process.exit(1);
}
const { DETAILED_RULE_TEMPLATES } = await import(pathToFileURL(templatesPath).href);

const rulesDir = join(repoRoot, '.claude', 'rules');

/**
 * normalize:CRLF→LF + 版本行互抹。锚定 "> 适用于 godot-mcp-enhanced " 前缀(审查 N-4 收紧:
 * 防误抹正文叙述性版本引用),支持 v0.19 两段式与 pre-release/build 后缀;不触碰 Godot 4.x
 * 等其他版本号。已知限制:版本行互抹会掩盖"最低适用版本"语义变更(如 v0.17.0+→v0.25.0+),
 * 属有意归一(分发模板恒为 {{MCP_VERSION}} 占位,真值只在 rules 侧)。
 */
function normalize(s) {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/> 适用于 godot-mcp-enhanced v[\d.]+(?:[-+][\w.+-]*)?/g, '> 适用于 godot-mcp-enhanced VER')
    .replace(/> 适用于 godot-mcp-enhanced \{\{MCP_VERSION\}\}(?:\+)?/g, '> 适用于 godot-mcp-enhanced VER');
}

/** 行级首个差异描述(两侧已 normalize)。 */
function lineDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  return `首个差异在第 ${i + 1} 行\n    模板: ${JSON.stringify(al[i] ?? '(EOF)')}\n    文件: ${JSON.stringify(bl[i] ?? '(EOF)')}`;
}

const templateKeys = Object.keys(DETAILED_RULE_TEMPLATES);
const ruleFiles = readdirSync(rulesDir).filter(f => /^godot-mcp-[^/]*\.md$/.test(f));

const problems = [];
for (const filename of templateKeys) {
  const rulesPath = join(rulesDir, filename);
  if (!existsSync(rulesPath)) {
    problems.push(`模板有而 .claude/rules/ 缺文件: ${filename}`);
    continue;
  }
  const a = normalize(DETAILED_RULE_TEMPLATES[filename]);
  const b = normalize(readFileSync(rulesPath, 'utf8'));
  if (a !== b) problems.push(`${filename} 内容不一致(归一化后): ${lineDiff(a, b)}`);
}
for (const f of ruleFiles) {
  if (!templateKeys.includes(f)) problems.push(`.claude/rules/ 有而模板缺键: ${f}`);
}

// ─── 第三层:事实对账(factual drift,2026-08-21 七维度审核 S-1)──────────────
// 第一二层的双副本逐字一致挡不住"一致地错"——P1-2 案例:recording 旧 action 名 17 处
// 双副本一致地错,本脚本此前恒绿;P1-5 案例:13100 端口与同文件自我纠正条目并存。
// 本层对照代码事实机械拦截:
//   A. 模板中 `tool(action="name")` 精确引用 → name 必须 ∈ 运行时注册表该工具的 enum
//      (真相源 = build/module-loader 注册态,与 capability-matrix 同源)。
//      通配/无引号列表式(如 `runtime(record_*)`、`signal(action=connect/...)`)不查——
//      带引号单值才是"AI 按规则调用必被 inputSchema 拒绝"的高危形态。
//   B. 模板中 `端口 NNNN` 声明 → NNNN 必须 ∈ editor BASE_PORT..MAX_PORT ∪ bridge
//      PORT_DEFAULT..+ATTEMPTS-1(常量从 GD 源文件提取,不硬编码防漂移)。
{
  const { registerAllModules } = await import(pathToFileURL(join(repoRoot, 'build', 'module-loader.js')).href);
  registerAllModules();
  const { getAllToolDefinitions } = await import(pathToFileURL(join(repoRoot, 'build', 'core', 'tool-registry.js')).href);
  const actionEnums = new Map(
    getAllToolDefinitions().map(d => [d.name, d.inputSchema?.properties?.action?.enum]),
  );

  for (const filename of templateKeys) {
    const text = String(DETAILED_RULE_TEMPLATES[filename]);
    for (const m of text.matchAll(/([a-z_][a-z0-9_]*)\(action="([a-z0-9_]+)"/g)) {
      const tool = m[1], action = m[2];
      if (!actionEnums.has(tool)) {
        problems.push(`[factual] ${filename}: 引用不存在的工具 \`${tool}(action="${action}")\`——工具名漂移`);
      } else if (!(actionEnums.get(tool) ?? []).includes(action)) {
        problems.push(`[factual] ${filename}: \`${tool}(action="${action}")\` 不在运行时 enum——旧 action 名或拼写漂移(AI 按此调用必被 inputSchema 拒绝)`);
      }
    }
  }

  const gdConst = (file, name) => {
    // 2026-09-22 顺带修复:P4(0.33.8 端口可配)把 editor 常量从 `const BASE_PORT` 改为
    // `var _base_port`(ProjectSettings 可配,默认值即文档口径)——正则覆盖 const NAME 与
    // var _NAME 两形态,提取默认值。此失败为 P4 遗留(master 上即失败),非内容 drift。
    const mm = readFileSync(join(repoRoot, file), 'utf8').match(new RegExp(`(?:const|var)\\s+_?${name}\\s*:?=?\\s*(\\d+)`));
    return mm ? Number(mm[1]) : null;
  };
  // editor 侧 P4 起为 var _base_port/_max_port(ProjectSettings 可配);bridge 侧仍是 const PORT_*
  const editorBase = gdConst('addons/godot_mcp_server/websocket_server.gd', '_base_port');
  const editorMax = gdConst('addons/godot_mcp_server/websocket_server.gd', '_max_port');
  const bridgeBase = gdConst('src/scripts/mcp_bridge.gd', 'PORT_DEFAULT');
  const bridgeAttempts = gdConst('src/scripts/mcp_bridge.gd', 'PORT_ATTEMPTS');
  if (editorBase === null || editorMax === null || bridgeBase === null || bridgeAttempts === null) {
    problems.push('[factual] GD 端口常量提取失败(BASE_PORT/MAX_PORT/PORT_DEFAULT/PORT_ATTEMPTS)——常量改名/移位需同步本脚本正则');
  } else {
    const legalPorts = new Set();
    for (let p = editorBase; p <= editorMax; p++) legalPorts.add(p);
    for (let p = bridgeBase; p < bridgeBase + bridgeAttempts; p++) legalPorts.add(p);
    // P9 (2026-09-12): dap 工具的 editor 内置 DAP server 端口(引擎默认 6006,非本仓 GD 常量)
    legalPorts.add(6006);
    for (const filename of templateKeys) {
      for (const m of String(DETAILED_RULE_TEMPLATES[filename]).matchAll(/端口 (\d{4,5})/g)) {
        if (!legalPorts.has(Number(m[1]))) {
          problems.push(`[factual] ${filename}: 端口 ${m[1]} 不在合法集合(editor ${editorBase}-${editorMax} ∪ bridge ${bridgeBase}-${bridgeBase + bridgeAttempts - 1})——历史错误端口(如 13100)或引擎端口常量已变更`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  const mode = process.env.STRICT === '1' ? 'STRICT' : 'advisory';
  console.error(`[check-rules-content-sync] ${mode}: ${problems.length} 处不一致/失实:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  修复：副本 drift 双向同步两处内容(AGENTS.md「独立副本同步约束」)；[factual] 条目对照代码事实改内容(不是同步,是内容错了)');
  if (process.env.STRICT === '1') process.exit(1);
} else {
  console.log(`[check-rules-content-sync] OK: ${templateKeys.length} 个模板与 .claude/rules/ 双向对账一致(归一化: 换行/版本行) + 事实对账通过(action 引用 ⊆ 运行时 enum;端口 ∈ GD 常量范围)`);
}
