// test/qa-report.test.ts — QA 报告落盘/读取/diff（env 重定向到 tmp 目录隔离）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeReport, readReport, listReports, diffReports, sanitizeSuiteName, findPreviousReport, makeRunId,
  type QaReport, type StepRecord,
} from '../src/tools/qa/report.js';

let dir: string;
const prevEnv = process.env.GODOT_MCP_QA_REPORTS_DIR;

function step(i: number, label: string | undefined, type: string, status: StepRecord['status']): StepRecord {
  return { index: i, label, type, status, elapsed_ms: 5 };
}

function report(runId: string, name: string, steps: StepRecord[], setupError?: string): QaReport {
  const passed = steps.filter(s => s.status === 'PASSED').length;
  const failed = steps.filter(s => s.status === 'FAILED').length;
  const errors = steps.filter(s => s.status === 'ERROR').length;
  const skipped = steps.filter(s => s.status === 'SKIPPED').length;
  return {
    version: 1, run_id: runId,
    suite: { name, project_path: 'D:/p', started_at: '2026-08-15T00:00:00Z', spec_source: 'inline' },
    options: {}, setup_error: setupError,
    summary: { total: steps.length, passed, failed, errors, skipped, status: failed + errors + skipped > 0 || setupError ? 'FAILED' : 'PASSED', duration_ms: 10 },
    steps,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-reports-test-'));
  process.env.GODOT_MCP_QA_REPORTS_DIR = dir;
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  else process.env.GODOT_MCP_QA_REPORTS_DIR = prevEnv;
});

describe('writeReport / readReport', () => {
  it('落盘 .json + .md，latest/prev 按文件名倒序解析', () => {
    const p1 = writeReport(report('20260815-100000-alpha', 'alpha', [step(0, 's0', 'input', 'PASSED')]));
    expect(existsSync(p1.json_path)).toBe(true);
    expect(p1.md_path.endsWith('.md')).toBe(true);
    writeReport(report('20260815-100001-beta', 'beta', [step(0, 's0', 'input', 'FAILED')]));

    expect(readReport('latest').run_id).toBe('20260815-100001-beta');
    expect(readReport('prev').run_id).toBe('20260815-100000-alpha');
    expect(readReport('20260815-100000-alpha').suite.name).toBe('alpha'); // 裸 run_id
    expect(readReport('20260815-100000-alpha.json').suite.name).toBe('alpha'); // 文件名
    expect(listReports()).toHaveLength(2);
  });

  it('目录空时 latest/prev 抛可读错误', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qa-reports-empty-'));
    process.env.GODOT_MCP_QA_REPORTS_DIR = empty;
    expect(() => readReport('latest')).toThrow(/先 qa run/);
    expect(() => readReport('prev')).toThrow(/不足 2 份/);
    process.env.GODOT_MCP_QA_REPORTS_DIR = dir;
    rmSync(empty, { recursive: true, force: true });
  });

  it('安全（审查 Important-1）：白名单外绝对路径拒绝读取', () => {
    // 任意路径读是 v0.30 修复的口子——qa 报告只允许读 qa-reports 目录内
    expect(() => readReport('C:/Windows/win.ini')).toThrow(/必须位于|不可解析/);
    expect(() => readReport('C:\\Windows\\win.ini')).toThrow(/必须位于|不可解析/);
    expect(() => readReport('/etc/passwd')).toThrow(/必须位于|不可解析/);
    // 目录内合法路径仍可（构造 dir 内绝对路径）
    const r = readReport(join(dir, '20260815-100000-alpha.json'));
    expect(r.run_id).toBe('20260815-100000-alpha');
  });

  it('安全P3-3: qa-reports 内预置 symlink 指向外部文件 → realpath 后拒绝（字符串前缀可绕）', () => {
    // 攻击面:攻击者能写 qa-reports 目录时放一个 link.json -> 外部文件的 symlink,
    // 字符串前缀比对放行;realpath 解析真实目标后才校验即拦。
    const outside = mkdtempSync(join(tmpdir(), 'qa-outside-'));
    const outsideJson = join(outside, 'secret.json');
    writeFileSync(outsideJson, JSON.stringify(report('20260815-999999-evil', 'evil', [step(0, 's', 'sleep', 'PASSED')])), 'utf-8');
    try {
      symlinkSync(outsideJson, join(dir, '20260815-999999-evil.json'));
    } catch {
      // Windows 无开发者模式时 symlink 需特权——skip 该断言组(POSIX CI 会真跑);
      // 审查N-4:显式 warn 让「绿而未验」在测试输出可见,防误读为已验证
      console.warn('[qa-report.test] symlink unavailable on this machine, POSIX-branch assertion skipped');
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      expect(() => readReport(join(dir, '20260815-999999-evil.json')), 'symlink 指向外部必须拒').toThrow(/必须位于/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('md 渲染含状态表与 setup error', () => {
    const r = report('20260815-100002-gamma', 'gamma', [step(0, 'a', 'assert', 'FAILED')], 'run_project 失败: x');
    const { md_path } = writeReport(r);
    const md = readFileSync(md_path, 'utf-8');
    expect(md).toContain('FAILED');
    expect(md).toContain('setup error');
    expect(md).toContain('| 0 | a | assert | FAILED |');
  });

  it('B2: UNMEASURED 渲染——状态行 + summary 计数;unmeasured=0 时旧格式不变', () => {
    const r = report('20261019-b2a', 'b2a', [
      step(0, 'pre', 'input', 'PASSED'),
      step(1, 'gate', 'wait', 'UNMEASURED'),
    ]);
    r.summary.unmeasured = 1;
    r.summary.status = 'FAILED';
    const { md_path } = writeReport(r);
    const md = readFileSync(md_path, 'utf-8');
    expect(md).toContain('| 1 | gate | wait | UNMEASURED |');
    expect(md).toContain('1 unmeasured');
    // unmeasured=0/缺省 → 不输出该段(旧报告渲染形态不变)
    const r0 = report('20261019-b2b', 'b2b', [step(0, 'x', 'sleep', 'PASSED')]);
    const md0 = readFileSync(writeReport(r0).md_path, 'utf-8');
    expect(md0).not.toContain('unmeasured');
  });
});

describe('diffReports', () => {
  const base = report('b', 'b', [
    step(0, 'case-a', 'assert', 'PASSED'),
    step(1, 'case-b', 'assert', 'FAILED'),
    step(2, 'case-c', 'input', 'PASSED'),
  ]);
  const head = report('h', 'h', [
    step(0, 'case-a', 'assert', 'FAILED'),  // 回归
    step(1, 'case-b', 'assert', 'PASSED'),  // 修复
    step(2, 'case-d', 'input', 'PASSED'),   // case-c 移除 + case-d 新增
  ]);

  it('回归/修复/新增/移除/判定', () => {
    const d = diffReports(base, head);
    expect(d.regressions.map(r => r.case)).toEqual(['case-a']);
    expect(d.fixed.map(f => f.case)).toEqual(['case-b']);
    expect(d.added.map(a => a.case)).toEqual(['case-d']);
    expect(d.removed.map(r => r.case)).toEqual(['case-c']);
    expect(d.verdict).toBe('REGRESSED');
    expect(d.regressions[0]).toMatchObject({ base: 'PASSED', head: 'FAILED' });
  });

  it('全修复 → IMPROVED；无变化 → NO_STATUS_CHANGE', () => {
    const b2 = report('b2', 'b2', [step(0, 'x', 'assert', 'FAILED')]);
    const h2 = report('h2', 'h2', [step(0, 'x', 'assert', 'PASSED')]);
    expect(diffReports(b2, h2).verdict).toBe('IMPROVED');
    const b3 = report('b3', 'b3', [step(0, 'x', 'assert', 'PASSED')]);
    const h3 = report('h3', 'h3', [step(0, 'x', 'assert', 'PASSED')]);
    expect(diffReports(b3, h3).verdict).toBe('NO_STATUS_CHANGE');
  });

  it('ERROR 视为 not-passed（回归判定覆盖 error）', () => {
    const b4 = report('b4', 'b4', [step(0, 'x', 'input', 'PASSED')]);
    const h4 = report('h4', 'h4', [step(0, 'x', 'input', 'ERROR')]);
    expect(diffReports(b4, h4).verdict).toBe('REGRESSED');
  });

  it('无 label 时按 index:type 对齐', () => {
    const b5 = report('b5', 'b5', [step(0, undefined, 'input', 'PASSED')]);
    const h5 = report('h5', 'h5', [step(0, undefined, 'input', 'FAILED')]);
    expect(diffReports(b5, h5).regressions[0]!.case).toBe('0:input');
  });

  it('B2: UNMEASURED 视为 not-passed(回归判定覆盖);与旧格式报告(无 unmeasured 字段)diff 不炸', () => {
    // PASSED → UNMEASURED = 回归(前提不成立不是通过)
    const b6 = report('b6', 'b6', [step(0, 'x', 'wait', 'PASSED')]);
    const h6 = report('h6', 'h6', [step(0, 'x', 'wait', 'UNMEASURED')]);
    const d = diffReports(b6, h6);
    expect(d.verdict).toBe('REGRESSED');
    expect(d.regressions[0]).toMatchObject({ base: 'PASSED', head: 'UNMEASURED' });
    // UNMEASURED → PASSED = 修复
    const h7 = report('h7', 'h7', [step(0, 'x', 'wait', 'PASSED')]);
    const b7 = report('b7', 'b7', [step(0, 'x', 'wait', 'UNMEASURED')]);
    expect(diffReports(b7, h7).verdict).toBe('IMPROVED');
    // 向后兼容:旧格式 head 报告(无 summary.unmeasured 字段)参与 diff 不报错、归类正确
    const legacy = JSON.parse(JSON.stringify(h6)) as QaReport;
    delete legacy.summary.unmeasured;
    const d2 = diffReports(b6, legacy);
    expect(d2.verdict).toBe('REGRESSED');
  });
});

describe('sanitizeSuiteName', () => {
  it('非法字符替换为 _ 并折叠连续、空回退 suite', () => {
    expect(sanitizeSuiteName('存档/读档: 冒烟!')).toBe('_'); // 全非法 → 折叠为单个 _
    expect(sanitizeSuiteName('save-load_smoke v1')).toBe('save-load_smoke_v1');
    expect(sanitizeSuiteName('!!!')).toBe('_');
    expect(sanitizeSuiteName('')).toBe('suite');
  });
});

// ═══ QA 收尾批②（2026-08-16）：nightly 基线查找 ═══

describe('findPreviousReport（nightly 同套件基线）', () => {
  it('跳过当前 run，取同套件名最近一次；跨套件名跳过', () => {
    writeReport(report('20260815-100000-smoke', 'smoke', [step(0, 'a', 'sleep', 'PASSED')]));
    writeReport(report('20260815-110000-other', 'other', [step(0, 'b', 'sleep', 'PASSED')]));
    writeReport(report('20260815-120000-smoke', 'smoke', [step(0, 'a', 'sleep', 'FAILED')]));
    const cur = writeReport(report('20260816-090000-smoke', 'smoke', [step(0, 'a', 'sleep', 'PASSED')]));

    const prev = findPreviousReport('20260816-090000-smoke', 'smoke');
    expect(prev?.run_id).toBe('20260815-120000-smoke'); // 不是 other，也不是更早的 100000

    // 首次运行（无同套件历史）→ null
    expect(findPreviousReport('20260816-090001-newbie', 'newbie')).toBeNull();
    // 中文套件名 sanitize 后仍可对齐
    void cur;
    writeReport(report('20260816-091000-_smoke', '冒烟', [step(0, 'a', 'sleep', 'PASSED')]));
    const prev2 = findPreviousReport('20260816-091000-_smoke', '冒烟');
    expect(prev2).toBeNull(); // '冒烟'→'_'，之前无同后缀
  });
});

describe('findPreviousReport 碰撞防护（审查 Important-2）', () => {
  it('sanitize 后缀碰撞（"冒烟"→"_" vs 字面 "_"）：不误拿他套件当基线，跨碰撞命中同名', () => {
    // 注意 run_id 后缀 = sanitize(套件名)："冒烟"→"_"，与字面 "_" 套件完全同后缀（碰撞）
    writeReport(report('20260815-130000-_', '_', [step(0, 'other-case', 'PASSED')]));
    writeReport(report('20260816-100000-_', '冒烟', [step(0, 'case-a', 'PASSED')]));
    // 冒烟无同名历史：唯一同后缀候选是字面 _ 套件 → name 校验拒绝 → null（不误拿）
    expect(findPreviousReport('20260816-100000-_', '冒烟')).toBeNull();
    // 字面 _ 查询自己的历史 → 正常命中
    writeReport(report('20260816-100001-_', '_', [step(0, 'other-case', 'PASSED')]));
    expect(findPreviousReport('20260816-100001-_', '_')?.run_id).toBe('20260815-130000-_');
    // 冒烟补历史后再跑：候选倒序跨过字面 _（100001）命中最近的同名冒烟（100000）
    writeReport(report('20260816-090000-_', '冒烟', [step(0, 'case-a', 'FAILED')]));
    writeReport(report('20260816-100002-_', '冒烟', [step(0, 'case-a', 'PASSED')]));
    expect(findPreviousReport('20260816-100002-_', '冒烟')?.run_id).toBe('20260816-100000-_',);
  });
});

// ═══ PR-1b Task 3：CANCELLED 报告不作 nightly 基线 ═══

describe('findPreviousReport 跳过 CANCELLED（PR-1b）', () => {
  it('CANCELLED 报告不作为基线候选，继续往前找', () => {
    // old-PASSED（base 期望）→ mid-CANCELLED（应被跳过）→ new-PASSED（exclude）
    writeReport(report('20260817-080000-suiteX', 'suiteX', [step(0, 'a', 'sleep', 'PASSED')]));
    const mid = report('20260817-090000-suiteX', 'suiteX', [step(0, 'a', 'sleep', 'FAILED')]);
    mid.summary.status = 'CANCELLED'; // 手动取消的半途报告（取消优先于 FAILED，Task 2 终态）
    writeReport(mid);
    writeReport(report('20260817-100000-suiteX', 'suiteX', [step(0, 'a', 'sleep', 'PASSED')]));

    const prev = findPreviousReport('20260817-100000-suiteX', 'suiteX');
    expect(prev?.run_id).toBe('20260817-080000-suiteX'); // 不是 mid-CANCELLED
  });

  it('同套件历史全为 CANCELLED → 无基线 null（nightly 跳过 diff 只报告本次）', () => {
    const c1 = report('20260817-110000-suiteC', 'suiteC', [step(0, 'a', 'sleep', 'SKIPPED')]);
    c1.summary.status = 'CANCELLED'; // 取消时未跑到的步骤按 SKIPPED 收尾
    writeReport(c1);
    writeReport(report('20260817-120000-suiteC', 'suiteC', [step(0, 'a', 'sleep', 'PASSED')]));

    expect(findPreviousReport('20260817-120000-suiteC', 'suiteC')).toBeNull();
  });
});

// ═══ PR-2 Task 1:makeRunId 随机后缀 + findPreviousReport 匹配适配(双兼容) ═══

describe('makeRunId 随机后缀与 findPreviousReport 适配(PR-2)', () => {
  it('同秒内两次 makeRunId 同名套件 → run_id 不同(随机后缀)', () => {
    const a = makeRunId('suiteX');
    let b = makeRunId('suiteX');
    if (a === b) b = makeRunId('suiteX');   // rand4 碰撞重采样一次,残余概率 ~(1/65536)^2
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{8}-\d{6}-suiteX-[0-9a-f]{4}$/); // 时间戳-sanitize-rand4 三段
    expect(b).toMatch(/-suiteX-[0-9a-f]{4}$/);
  });

  it('findPreviousReport 仍能跨随机后缀找到同套件基线(三段式形态)', () => {
    // old-PASSED → new-PASSED,均带随机后缀形态(时间戳取晚于既有 20260817-12xx 文件,避免跨用例污染)
    writeReport(report('20260817-130000-suiteX-0d10', 'suiteX', [step(0, 'a', 'sleep', 'PASSED')]));
    writeReport(report('20260817-140000-suiteX-1c2e', 'suiteX', [step(0, 'a', 'sleep', 'PASSED')]));

    const prev = findPreviousReport('20260817-140000-suiteX-1c2e', 'suiteX');
    expect(prev?.run_id).toBe('20260817-130000-suiteX-0d10');
  });

  it('findPreviousReport 双兼容:历史两段式报告在新代码下仍可作基线', () => {
    // PR-2 前落盘的 run_id 是两段式(时间戳-套件名);粗筛兼容旧 endsWith 形态,历史基线不丢
    writeReport(report('20260816-235959-legacy', 'legacy', [step(0, 'a', 'sleep', 'PASSED')]));
    writeReport(report('20260817-150000-legacy-7e8f', 'legacy', [step(0, 'a', 'sleep', 'PASSED')]));

    const prev = findPreviousReport('20260817-150000-legacy-7e8f', 'legacy');
    expect(prev?.run_id).toBe('20260816-235959-legacy');
  });

  it('findPreviousReport 不误配 sanitize 相同的不同套件(碰撞防护回归,随机后缀形态)', () => {
    // 'suite X' 与 'suite_X' sanitize 后同段;碰撞候选被 suite.name 精校拒后继续往前找真同名
    writeReport(report('20260816-060000-suite_X-0a1b', 'suite_X', [step(0, 'mine', 'sleep', 'PASSED')]));
    writeReport(report('20260816-070000-suite_X-e5f6', 'suite X', [step(0, 'other', 'sleep', 'PASSED')]));
    writeReport(report('20260816-080000-suite_X-1a2b', 'suite_X', [step(0, 'mine', 'sleep', 'PASSED')]));

    const prev = findPreviousReport('20260816-080000-suite_X-1a2b', 'suite_X');
    expect(prev?.run_id).toBe('20260816-060000-suite_X-0a1b'); // 不是碰撞的 'suite X'
  });
});
