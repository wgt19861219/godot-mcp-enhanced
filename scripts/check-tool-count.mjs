#!/usr/bin/env node
// scripts/check-tool-count.mjs
// 工具数口径一致性门禁：校验 README/manifest/规则文件等手写位置的工具数/action 数
// 与 docs/capability-matrix.json（build-matrix 产出的 committed 快照，单一真相源）一致。
//
// 风格遵循 scripts/check-token-budget.mjs（readFileSync 读工作区不走 git、
// 导出纯函数供单测、[tool-count] 日志前缀、退出码 0=一致/1=漂移）。
//
// 用法：node scripts/check-tool-count.mjs
// 退出码：0=全部一致，1=检测到漂移
//
// 修复指引：改了工具清单后跑 `npm run build-matrix` 重算 docs/capability-matrix.json，
// 然后按报错信息手动同步下列文件中的手写数字。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从 capability-matrix.json 读取权威值。
 * @param {string} root 项目根
 * @returns {{toolCount:number, actionCount:number}} */
export function readAuthority(root) {
  const matrixPath = join(root, 'docs', 'capability-matrix.json');
  if (!existsSync(matrixPath)) {
    throw new Error(`[tool-count] 权威源缺失：${matrixPath}（先跑 npm run build-matrix）`);
  }
  const { tools } = JSON.parse(readFileSync(matrixPath, 'utf8'));
  // action 总数 = 各工具 riskDistribution 四级计数之和（与 matrix-integrity.test.ts 的不变量一致）
  const actionCount = tools.reduce((sum, t) => {
    const r = t.riskDistribution;
    if (!r) return sum;
    return sum + (r.read || 0) + (r.write || 0) + (r.destructive || 0) + (r.process || 0);
  }, 0);
  return { toolCount: tools.length, actionCount };
}

/**
 * 校验规则表：文件 → 一组 check。
 * - check.re：带捕获组的正则，捕获组 1 提取实际数字
 * - check.expectKey：'toolCount' | 'actionCount'，标记与权威值的哪个字段比较（运行时从 readAuthority 注入）
 * - check.negate：true 时反向断言（命中即漂移，用于"不应残留 130+"这种过时口径）
 * - check.asString：true 时按字符串比较（用于 "35 merged" 这种非纯数字场景）
 * - check.expect2Key：第二捕获组的权威字段（用于 rule-templates/core.md 的双校验：工具数+action 数）
 * @typedef {{re:RegExp, desc:string, expectKey?:'toolCount'|'actionCount', negate?:boolean, asString?:boolean, expect2Key?:'toolCount'|'actionCount', desc2?:string}} Check
 * @typedef {{file:string, checks:Check[]}} Rule
 */
const RULES = [
  {
    file: 'README.md',
    checks: [
      { re: /工具层:(\d+)\s*个 MCP 工具/, expectKey: 'toolCount', desc: 'README:7 顶层工具数' },
      { re: /\| 工具数 \| \*\*(\d+)\*\*/, expectKey: 'toolCount', desc: 'README:22 对比表' },
      { re: /共\s*(\d+)\s*个 MCP 工具\(merged tool definition/, expectKey: 'toolCount', desc: 'README:140 工具一览' },
      { re: /协议层实测通过（(\d+) 工具全发现/, expectKey: 'toolCount', desc: 'README:496 Warp 实测' },
      // Task 3(2026-08-19)防复发:README 正文 action 数与 :144 双口径曾漂移(235/36/205),
      // 旧 20 处校验只覆盖工具数不覆盖正文 action 数。正则锚定正文专属措辞
      // (merged, / merged tool definition, / 顶层工具数: / action 总数:),
      // 版本表历史行无这些措辞(grep 已核),不会误伤。
      { re: /个 MCP 工具\(merged,共\s*(\d+)\s*个 action/, expectKey: 'actionCount', desc: 'README:7 正文 action 数' },
      { re: /个 MCP 工具\(merged tool definition,共\s*(\d+)\s*个 action/, expectKey: 'actionCount', desc: 'README:142 工具一览 action 数' },
      { re: /\*\*顶层工具数:(\d+)\*\*/, expectKey: 'toolCount', desc: 'README:144 顶层工具数' },
      { re: /\*\*action 总数:(\d+)\*\*/, expectKey: 'actionCount', desc: 'README:144 action 总数' },
    ],
  },
  {
    file: 'manifest.json',
    checks: [
      { re: /130\+\s*tools?/, negate: true, desc: 'manifest:6 不应残留 130+' },
      { re: /and\s+(\d+)\+?\s*merged tools/, expectKey: 'toolCount', asString: true, desc: 'manifest:6 顶层工具数' },
      { re: /provides\s+(\d+)\s*merged MCP tools/, expectKey: 'toolCount', asString: true, desc: 'manifest:7 long_description' },
      // B-1 fix(2026-10-01 审查):manifest 两处 action 数曾漂移(248 vs 权威 272)长期
      // 隐身——此前只校验工具数不校验 action 数。捕获组锚定 "(N actions)" 措辞。
      { re: /(\d+)\s*merged tools\s*\((\d+)\s*actions\)/, expectKey: 'toolCount', asString: true, desc: 'manifest:6 顶层工具数(双口径)', expect2Key: 'actionCount', desc2: 'manifest:6 action 数' },
      { re: /(\d+)\s*merged MCP tools\s*\((\d+)\s*actions\)/, expectKey: 'toolCount', asString: true, desc: 'manifest:7 工具数(双口径)', expect2Key: 'actionCount', desc2: 'manifest:7 action 数' },
    ],
  },
  {
    file: 'README.en.md',
    checks: [
      { re: /:\s*(\d+)\s*MCP tools?\s*\(merged/, expectKey: 'toolCount', desc: 'README.en:5' },
      { re: /\|\s*Tools\s*\|\s*\*\*(\d+)\*\*/, expectKey: 'toolCount', desc: 'README.en:20 对比表' },
      { re: /^## Tools \((\d+)\)/m, expectKey: 'toolCount', desc: 'README.en:112 章节标题' },
      { re: />\s*\*\*(\d+)\s*MCP tools\*\*/, expectKey: 'toolCount', desc: 'README.en:114' },
      // B-1 fix(2026-10-01 审查):README.en 正文 action 数曾漂移(248 vs 权威 272)——补捕获组。
      { re: /merged tool definitions,\s*(\d+)\s*actions/, expectKey: 'actionCount', desc: 'README.en:186 正文 action 数' },
    ],
  },
  {
    file: 'server.json',
    checks: [
      { re: /—\s*(\d+)\s*tools/, expectKey: 'toolCount', asString: true, desc: 'server.json description MCP Registry 材料' },
    ],
  },
  {
    file: 'docs/distribution/README.md',
    checks: [
      { re: /with\s+(\d+)\s*merged tools/, expectKey: 'toolCount', asString: true, desc: 'distribution/README:21 PR 文案' },
      { re: /,(\d+)\s*个工具覆盖/, expectKey: 'toolCount', desc: 'distribution/README:31 中文草稿' },
      { re: /engine\.\s*(\d+)\s*tools\s*\(/, expectKey: 'toolCount', asString: true, desc: 'distribution/README:35 英文草稿' },
    ],
  },
  {
    file: 'docs/migration-from-coding-solo.md',
    checks: [
      { re: /进化为\s*(\d+)\s*个 grouped tool/, expectKey: 'toolCount', desc: 'migration:17' },
      { re: /→\s*(\d+)\s*个 grouped tool/, expectKey: 'toolCount', desc: 'migration:53' },
    ],
  },
  // 独立副本同步约束（AGENTS.md）：rule-templates.ts 与 .claude/rules/godot-mcp-core.md
  // 是两份独立副本，必须手动同步。CI 的 check-rules-version-bump 只校验版本 bump，
  // 不校验内容一致性——本表补这个盲区。
  {
    file: 'src/tools/rule-templates.ts',
    checks: [
      { re: /130\+\s*工具/, negate: true, desc: 'rule-templates.ts 不应残留 130+（防 setup_project_rules 下游污染）' },
      { re: /提供\s*(\d+)\s*个 MCP 工具（(\d+)\s*个 action/, expectKey: 'toolCount', desc: 'rule-templates.ts:24 工具数（分发模板源）', expect2Key: 'actionCount', desc2: 'rule-templates.ts:24 action 数' },
    ],
  },
  {
    file: '.claude/rules/godot-mcp-core.md',
    checks: [
      { re: /提供\s*(\d+)\s*个 MCP 工具（(\d+)\s*个 action/, expectKey: 'toolCount', desc: 'godot-mcp-core.md:10 工具数', expect2Key: 'actionCount', desc2: 'godot-mcp-core.md:10 action 数' },
    ],
  },
];

/**
 * 纯函数：跑全部规则，返回漂移清单。
 * @param {string} root 项目根
 * @returns {{consistent:boolean, expected:{toolCount:number,actionCount:number}, mismatches:string[]}} */
export function checkToolCount(root) {
  const expected = readAuthority(root);
  const mismatches = [];

  for (const rule of RULES) {
    const filePath = join(root, rule.file);
    if (!existsSync(filePath)) {
      mismatches.push(`[tool-count] MISS ${rule.file}: 文件不存在`);
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    for (const c of rule.checks) {
      const m = content.match(c.re);
      if (c.negate) {
        if (m) mismatches.push(`[tool-count] FAIL ${c.desc}: 命中不应出现的 "${m[0]}"`);
        continue;
      }
      if (!m) {
        mismatches.push(`[tool-count] FAIL ${c.desc}: 未匹配模式 ${c.re}`);
        continue;
      }
      // 主捕获组校验（期望值从 readAuthority 动态注入，asString 时按字符串比较）
      const want = expected[c.expectKey];
      const actual = c.asString ? m[1] : Number(m[1]);
      const wantCmp = c.asString ? String(want) : want;
      if (actual !== wantCmp) {
        mismatches.push(`[tool-count] FAIL ${c.desc}: 文档=${m[1]} ≠ 权威=${want}`);
      }
      // 第二捕获组（action 数，rule-templates/core.md 双校验）
      if (c.expect2Key !== undefined && m[2] !== undefined) {
        const want2 = expected[c.expect2Key];
        if (Number(m[2]) !== want2) {
          mismatches.push(`[tool-count] FAIL ${c.desc2}: 文档=${m[2]} ≠ 权威=${want2}`);
        }
      }
    }
  }

  return { consistent: mismatches.length === 0, expected, mismatches };
}

function main() {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { consistent, expected, mismatches } = checkToolCount(projectRoot);

  console.log('[tool-count] 权威值：tools=%d / actions=%d（来自 docs/capability-matrix.json）',
    expected.toolCount, expected.actionCount);

  if (!consistent) {
    console.error('[tool-count] ✗ 检测到 %d 处漂移：', mismatches.length);
    for (const m of mismatches) console.error('  ' + m);
    console.error('[tool-count] 修复：改工具清单后跑 `npm run build-matrix`，再按上述位置同步手写数字');
    process.exit(1);
  }

  // 2026-08-07 审查 P2: 校验 matrix.json.version 与 package.json 同步（防 build-matrix 后忘 commit）
  const matrixPath = join(projectRoot, 'docs', 'capability-matrix.json');
  const matrixVersion = JSON.parse(readFileSync(matrixPath, 'utf8')).version;
  const pkgVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
  if (matrixVersion !== pkgVersion) {
    console.error(`[tool-count] ✗ matrix version 漂移：matrix.json.version=${matrixVersion} vs package.json.version=${pkgVersion}`);
    console.error('[tool-count] 修复：跑 `npm run build-matrix` 重建 matrix（含 version 字段）');
    process.exit(1);
  }

  console.log('[tool-count] ✓ 全部一致（%d 处校验通过，matrix version=%s）',
    RULES.reduce((s, r) => s + r.checks.length, 0), pkgVersion);
}

main();
