#!/usr/bin/env node
// scripts/check-token-budget.mjs
// MCP 工具 description/inputSchema 体积门禁（warn-only 基线）。
// 读 docs/capability-matrix.json（build-matrix 产出的 committed 快照，非实时），
// 按分层阈值 warn（提醒）/ error（exit 1）。size 不进 diff-matrix drift，由本脚本独立把关。
//
// 用法：node scripts/check-token-budget.mjs
// 退出码：0=无 error（可能有 warn），1=有 error

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = {
  perToolDesc:   { warn: 800,        error: 2000 },
  perToolSchema: { warn: 6000,       error: 12000 },
  perToolTotal:  { warn: 7000,       error: 14000 },
  // totalSum warn 基线校准(2026-08-16 原型翻译层审查遗留⑤):实测 86412B,超旧线 80KB 5.5%,
  // 按项目"覆盖率阈值持续超 4% 应上调"惯例(vitest.config.ts 先例)上调至 90KB,消除长期
  // 恒 warn 噪声;error 120KB 硬线不动。单工具 desc warn(engine/game/ui 3 条)是有意义的
  // 瘦身提醒(P2-11/blender generic 化历史批次均由它驱动),不随本批调整。
  // P4-1 (2026-09-11) game 描述瘦身(schema 8198→~5.2KB,总 -3.5KB)后全量 ~94KB,且明确
  // 边界结论:scene/workflow 的 schema 膨胀是结构形状信息不可砍——warn 调至 95KB(瘦身后
  // 转绿,回弹 >1KB 即警,error 线不动)。
  // P4 (2026-09-11) 曾定"回弹即警"(当时瘦身后 ~90KB);P8(热加载+SSOT 描述)与 P9(新增 dap 工具
  // 3.4KB)两批正当增量推到 ~103.9KB 越此 warn 线(审查 N-5 记录,2026-09-12)——接受当前水位,
  // warn 线校准至 105KB 给 ~1KB 余量;error 线 120KB 不变。回弹语义保留:越过 105KB 仍应警。
  // 易用性批 1 (2026-09-19) 23 工具 action 描述补全+project_path 统一+5 工具英译中(审查 A-1/2/3,
  // 报告 docs/reviews/2026-09-19-易用性审查-用户界面三层.md)正当增量 ~4.7KB 推到 111019B(~108.4KiB)——同前例
  // 接受水位,warn 线校准至 112KB 给 ~1.2KB 余量;error 120KB 硬线不动。回弹语义保留。
  totalSum:      { warn: 112 * 1024, error: 120 * 1024 },
};

/** @typedef {{name:string,size:{descBytes:number,schemaBytes:number,totalBytes:number}}} CapLike */

/**
 * @param {CapLike[]} caps
 * @returns {{warnings:string[],errors:string[],sum:number}} */
export function checkBudget(caps) {
  const warnings = [];
  const errors = [];
  let sum = 0;

  const checkDim = (cap, bytes, dim, label) => {
    const t = THRESHOLDS[dim];
    if (bytes >= t.error) errors.push(`${cap.name} ${label} ${bytes}B ≥ error ${t.error}B`);
    else if (bytes >= t.warn) warnings.push(`${cap.name} ${label} ${bytes}B ≥ warn ${t.warn}B`);
  };

  for (const cap of caps) {
    const s = cap.size;
    sum += s.totalBytes;
    checkDim(cap, s.descBytes, 'perToolDesc', 'desc');
    checkDim(cap, s.schemaBytes, 'perToolSchema', 'schema');
    checkDim(cap, s.totalBytes, 'perToolTotal', 'total');
  }

  if (sum >= THRESHOLDS.totalSum.error) errors.push(`total ${sum}B ≥ error ${THRESHOLDS.totalSum.error}B`);
  else if (sum >= THRESHOLDS.totalSum.warn) warnings.push(`total ${sum}B ≥ warn ${THRESHOLDS.totalSum.warn}B`);

  return { warnings, errors, sum };
}

function main() {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const matrixPath = join(projectRoot, 'docs', 'capability-matrix.json');
  const { tools } = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const { warnings, errors, sum } = checkBudget(tools);

  // 体积报告（始终打印）
  const top5 = [...tools].sort((a, b) => b.size.totalBytes - a.size.totalBytes).slice(0, 5);
  console.log('[token-budget] 总量 %dB (~%d tokens)', sum, Math.round(sum / 4));
  console.log('[token-budget] TOP5:');
  for (const t of top5) {
    console.log('  %s: desc %dB / schema %dB / total %dB', t.name, t.size.descBytes, t.size.schemaBytes, t.size.totalBytes);
  }

  for (const w of warnings) console.warn('[token-budget] WARN: ' + w);
  for (const e of errors) console.error('[token-budget] ERROR: ' + e);

  if (errors.length > 0) {
    console.error(`[token-budget] %d error(s), %d warning(s) — 阻塞`, errors.length, warnings.length);
    process.exit(1);
  }
  console.log('[token-budget] %d warning(s), 0 error — 通过', warnings.length);
}

main();
