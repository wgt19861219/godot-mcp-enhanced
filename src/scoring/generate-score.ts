import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DimensionName, DimensionResult, ScoreJson } from './types.js';
import { computeScore } from './aggregate.js';
import { collectCoverage } from './collectors/coverage.js';
import { collectIntegration } from './collectors/integration.js';
import { collectSecurity } from './collectors/security.js';
import { collectGdscript } from './collectors/gdscript.js';
import { collectPerformance } from './collectors/performance.js';
import { WEIGHTS, NA_SCORE } from './dimensions.js';
import { renderScoreReport } from './report.js';

export interface GenerateScoreOptions {
  lcovPath: string;
  outPath: string;
  godotVersion?: string;
  /** vitest --reporter=json 产出路径;缺失→integration 维度 na */
  e2eReportPath?: string;
  /** npm audit --json 产出路径;缺失→security 维度 na */
  auditJsonPath?: string;
  /** check-gdscript 产出路径;缺失→gdscript 维度 na */
  gdscriptReportPath?: string;
  /** vitest --reporter=json 全套产出;缺失→performance 维度 na */
  performanceReportPath?: string;
}

/** n/a 维度占位(权重保留,供 aggregate 重分配) */
function na(name: DimensionName): DimensionResult {
  return { score: NA_SCORE, weight: WEIGHTS[name], status: 'na' };
}

/**
 * 组装 6 维(M1 coverage + M2 integration + M3a security + M3c gdscript + M3d performance 有值),聚合,写 score.json。
 * 返回 ScoreJson。后续里程碑只需替换对应 na() 为真实采集器结果。
 */
export function generateScore(opts: GenerateScoreOptions): ScoreJson {
  const coverage = collectCoverage(opts.lcovPath);
  const integration = opts.e2eReportPath ? collectIntegration(opts.e2eReportPath) : na('integration');
  const security = opts.auditJsonPath ? collectSecurity(opts.auditJsonPath) : na('security');
  const gdscript = opts.gdscriptReportPath ? collectGdscript(opts.gdscriptReportPath) : na('gdscript');
  const performance = opts.performanceReportPath ? collectPerformance(opts.performanceReportPath) : na('performance');
  const dims: Record<DimensionName, DimensionResult> = {
    integration,
    coverage,
    security,
    flaky: na('flaky'),
    performance,
    gdscript,
  };
  const score = computeScore(dims, {
    godotVersion: opts.godotVersion,
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(opts.outPath, JSON.stringify(score, null, 2) + '\n', 'utf8');
  // L-24(2026-10-22 审查):outPath 非 score.json 结尾时,原 replace 不命中 →
  // reportPath === outPath,Markdown 报告反向覆盖刚写的 JSON。改固定落在输入旁的
  // score-report.md(报告路径与输入文件名解耦)。
  const reportPath = join(dirname(opts.outPath), 'score-report.md');
  writeFileSync(reportPath, renderScoreReport(score), 'utf8');
  return score;
}
