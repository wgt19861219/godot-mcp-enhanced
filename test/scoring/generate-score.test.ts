import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { generateScore } from '../../src/scoring/generate-score.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_gen__');
const LCOV = resolve(TMP, 'lcov.info');
const OUT = resolve(TMP, 'score.json');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('generateScore', () => {
  it('读 lcov → 写 score.json,coverage 维度有值,其余 5 维 n/a', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, godotVersion: '4.6' });
    expect(s.total).toBe(100);
    expect(s.pass).toBe(true);
    expect(s.partial).toBe(true);
    expect(s.dimensions.coverage.status).toBe('pass');
    expect(s.dimensions.security.status).toBe('na');
    expect(s.unverified).toHaveLength(5);
    expect(s.unverified).not.toContain('coverage');

    // 文件落地
    expect(existsSync(OUT)).toBe(true);
    const onDisk = JSON.parse(readFileSync(OUT, 'utf8'));
    expect(onDisk.total).toBe(100);
    expect(onDisk.godotVersion).toBe('4.6');
  });

  it('lcov 缺失 → coverage 也 n/a,total=0,pass=false', () => {
    const s = generateScore({ lcovPath: resolve(TMP, 'nope.info'), outPath: OUT });
    expect(s.total).toBe(0);
    expect(s.pass).toBe(false);
    expect(s.unverified).toHaveLength(6);
  });

  it('生成的 JSON 含 generatedAt(ISO 字符串)', () => {
    writeFileSync(LCOV, ['SF:x', 'DA:1,1', 'end_of_record'].join('\n'));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT });
    expect(() => new Date(s.generatedAt).toISOString()).not.toThrow();
  });

  it('有 e2e json → integration 维度有值,通过率 = passed/(passed+failed)', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n')); // coverage 100
    const E2E = resolve(TMP, 'e2e.json');
    writeFileSync(E2E, JSON.stringify({
      numTotalTests: 40, numPassedTests: 36, numFailedTests: 4, numPendingTests: 0,
    })); // integration 36/40 = 90
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, e2eReportPath: E2E });
    expect(s.dimensions.integration.score).toBe(90);
    expect(s.dimensions.integration.status).toBe('pass');
    expect(s.unverified).not.toContain('integration');
    expect(s.unverified).not.toContain('coverage');
    // 仍 partial(security/flaky/performance/gdscript 4 维 na)
    expect(s.partial).toBe(true);
    expect(s.unverified).toHaveLength(4);
  });

  it('有 audit json → security 维度有值,severity 扣分', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n')); // coverage 100
    const AUD = resolve(TMP, 'audit.json');
    writeFileSync(AUD, JSON.stringify({
      auditReportVersion: 2, vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } },
    })); // security 100-20=80
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, auditJsonPath: AUD });
    expect(s.dimensions.security.score).toBe(80);
    expect(s.dimensions.security.status).toBe('pass');
    expect(s.unverified).not.toContain('security');
    expect(s.unverified).not.toContain('coverage');
    expect(s.partial).toBe(true); // integration/flaky/performance/gdscript 仍 na
    expect(s.unverified).toHaveLength(4);
  });

  it('写 score-report.md(M3b),内容含总分 + 标题', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT });
    const reportPath = OUT.replace('score.json', 'score-report.md');
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain('质量评分报告');
    expect(md).toContain(String(s.total));
  });

  // L-24(2026-10-22 审查第二轮): outPath 非 score.json 结尾时报告曾反向覆盖 JSON 输入。
  it('L-24: outPath 自定义名(custom.json)→ 报告落旁侧 score-report.md,JSON 不被覆盖', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const CUSTOM = resolve(TMP, 'custom.json');
    generateScore({ lcovPath: LCOV, outPath: CUSTOM });
    // JSON 输入仍为 JSON(未被 Markdown 覆盖)
    const onDisk = JSON.parse(readFileSync(CUSTOM, 'utf8'));
    expect(typeof onDisk.total).toBe('number');
    // 报告固定落在同目录 score-report.md
    const md = readFileSync(resolve(TMP, 'score-report.md'), 'utf8');
    expect(md).toContain('质量评分报告');
  });

  it('有 gdscript report → gdscript 维度有值,incomplete→fail', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const GD = resolve(TMP, 'gd.json');
    writeFileSync(GD, JSON.stringify({ errors: 0, warnings: 5, files: 19, details: [], detailsTotal: 5 }));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, gdscriptReportPath: GD });
    expect(s.dimensions.gdscript.score).toBe(90); // 100-5*2
    expect(s.dimensions.gdscript.status).toBe('pass');
    expect(s.unverified).not.toContain('gdscript');
  });

  it('gdscript report incomplete → gdscript score=0 fail(hardFail)', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const GD = resolve(TMP, 'gd.json');
    writeFileSync(GD, JSON.stringify({ errors: 0, warnings: 0, files: 0, details: [], detailsTotal: 0, incomplete: true, reason: 'GODOT_PATH 缺失' }));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, gdscriptReportPath: GD });
    expect(s.dimensions.gdscript.score).toBe(0);
    expect(s.hardFails.some(h => h.dimension === 'gdscript')).toBe(true);
    expect(s.pass).toBe(false);
  });

  it('gdscript report 缺失 → gdscript 维度 na', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, gdscriptReportPath: resolve(TMP, 'nope.json') });
    expect(s.dimensions.gdscript.status).toBe('na');
    expect(s.unverified).toContain('gdscript');
  });

  it('有 performance report → performance 维度有值', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const PERF = resolve(TMP, 'perf.json');
    writeFileSync(PERF, JSON.stringify({
      numTotalTests: 10, numPassedTests: 10, startTime: 0,
      testResults: [{ name: 'a.test.ts', startTime: 0, endTime: 5000, status: 'passed', assertionResults: [] }],
    }));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, performanceReportPath: PERF });
    expect(s.dimensions.performance.score).toBe(100); // 5s ≤ T_PASS_MS
    expect(s.dimensions.performance.status).toBe('pass');
    expect(s.unverified).not.toContain('performance');
  });

  it('performance report 缺失 → performance 维度 na', () => {
    writeFileSync(LCOV, ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n'));
    const s = generateScore({ lcovPath: LCOV, outPath: OUT, performanceReportPath: resolve(TMP, 'nope.json') });
    expect(s.dimensions.performance.status).toBe('na');
    expect(s.unverified).toContain('performance');
  });
});
