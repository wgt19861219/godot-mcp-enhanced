// src/tools/qa/report.ts — QA 报告落盘 / 读取 / 回归 diff
//
// 报告写 ~/.godot-mcp/qa-reports/<YYYYMMDD-HHmmss>-<suite>-<rand4>.{json,md}（不污染用户项目）。
// JSON 是 diff 的机器可读真相源；md 是人读摘要。run_id = 文件名 stem（时间戳+套件名+4位随机,PR-2）。

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'fs';
import { join, isAbsolute, resolve, sep } from 'path';
import { homedir } from 'os';

/** B2 (2026-10-19): UNMEASURED = 前提不成立(目标节点/属性不存在),测不了而非测了没过。
 * Feel Gate 语义:无法测量的检查不是通过——summary.unmeasured>0 时整体仍 FAILED,但计数可辨,
 * 排查方向从"值不对"转向"前置步骤没建出目标"。 */
export type StepStatus = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED' | 'UNMEASURED';

export interface StepRecord {
  index: number;
  label?: string;
  type: string;
  status: StepStatus;
  /** 简短结果描述（错误消息/mismatch 摘要），≤200 字符 */
  detail?: string;
  /** SKIPPED 原因（budget exhausted / aborted after failure / setup failed） */
  skip_reason?: string;
  mismatch?: Record<string, { expected: unknown; actual: unknown }>;
  evidence?: { screenshot_path?: string };
  elapsed_ms: number;
}

export interface QaReport {
  version: 1;
  run_id: string;
  suite: {
    name: string;
    project_path: string;
    started_at: string; // ISO
    spec_source: 'inline' | 'file' | 'cli';
  };
  options: Record<string, unknown>;
  setup_error?: string;
  /** teardown（stop_project 等）尽力收尾的失败记录，不影响 status 判定 */
  teardown_warnings?: string[];
  /** record_on_failure 且结果非 PASSED 时，录制文件路径（qa-reports/<run_id>-recording.json，格式与 recording_play 的 events_json 兼容） */
  recording_path?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    /** B2: 前提不成立的步骤数(节点/属性不存在)。旧报告无此字段按 0 处理(diff/render 兼容)。 */
    unmeasured?: number;
    status: 'PASSED' | 'FAILED' | 'CANCELLED';
    duration_ms: number;
  };
  steps: StepRecord[];
}

export function qaReportsDir(): string {
  // env 覆盖：测试隔离（tmp 目录）+ 用户可重定向报告位置
  return process.env.GODOT_MCP_QA_REPORTS_DIR || join(homedir(), '.godot-mcp', 'qa-reports');
}

/** 文件名安全化：非 [A-Za-z0-9_-] 一律 _ */
export function sanitizeSuiteName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  return (s || 'suite').slice(0, 60);
}

export function timestampStem(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 落盘 .json + .md，返回两个路径 */
export function writeReport(report: QaReport): { json_path: string; md_path: string } {
  const dir = qaReportsDir();
  mkdirSync(dir, { recursive: true });
  const stem = report.run_id;
  const jsonPath = join(dir, `${stem}.json`);
  const mdPath = join(dir, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(mdPath, renderMarkdown(report), 'utf-8');
  return { json_path: jsonPath, md_path: mdPath };
}

/** 落盘前生成 run_id(时间戳-套件名-4位随机;PR-2 加随机后缀防同秒同名覆盖,PR-1b M-7)。
 * rand4 兜底:Math.random().toString(16) 可能短于 4 位,padEnd 补 '0'。 */
export function makeRunId(suiteName: string): string {
  const rand4 = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${timestampStem()}-${sanitizeSuiteName(suiteName)}-${rand4}`;
}

export function renderMarkdown(report: QaReport): string {
  const s = report.summary;
  const lines: string[] = [
    `# QA Report: ${report.suite.name}`,
    '',
    `- run_id: \`${report.run_id}\``,
    `- project: \`${report.suite.project_path}\``,
    `- started: ${report.suite.started_at} · duration: ${(s.duration_ms / 1000).toFixed(1)}s`,
    `- result: **${s.status}** (${s.passed} passed / ${s.failed} failed / ${s.errors} errors / ${s.skipped} skipped${s.unmeasured ? ` / ${s.unmeasured} unmeasured` : ''} of ${s.total})`,
  ];
  if (report.setup_error) lines.push(`- setup error: ${report.setup_error}`);
  lines.push('', '| # | label | type | status | detail |', '|---|---|---|---|---|');
  for (const st of report.steps) {
    const label = st.label ?? '';
    const detail = (st.skip_reason ? `[skip] ${st.skip_reason}` : st.detail ?? '').replace(/\|/g, '\\|').slice(0, 160);
    lines.push(`| ${st.index} | ${label} | ${st.type} | ${st.status} | ${detail} |`);
  }
  return lines.join('\n') + '\n';
}

/** 列出报告文件名（stem.json，按时间倒序 = 最新在前） */
export function listReports(): string[] {
  const dir = qaReportsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
}

/** 读报告：'latest'/'prev'/空 → 最新/次新；裸 run_id 或文件名在 qa-reports 内查。
 * 审查 Important-1 修复：带路径分隔符的 ref 必须解析进 qaReportsDir() 内——
 * 拒绝任意路径读取（此前 existsSync(ref) 直读绝对路径绕过白名单）。 */
export function readReport(pathRef: string): QaReport {
  const all = listReports();
  const dir = qaReportsDir();
  let ref: string | undefined;
  if (!pathRef || pathRef === 'latest') ref = all[0];
  else if (pathRef === 'prev') ref = all[1];
  else ref = pathRef;
  if (!ref) {
    // P2-17(2026-08-21 七维度审核): 不回显 qaReportsDir() 绝对路径(含用户名),
    // 此消息经 qa/index 顶层 catch 直达 client
    throw new Error(`无 QA 报告（${pathRef === 'prev' ? '不足 2 份' : '为空'}）。先 qa run。`);
  }

  let full: string;
  if (isAbsolute(ref) || ref.includes('/') || ref.includes('\\')) {
    // 安全P3-3(2026-08-20 审查):前缀检查前先过 realpath——qa-reports 内预置 symlink
    // 指向外部文件可绕过字符串前缀比对读任意 JSON。dir 同步 realpath 对称。
    // 审查N-1:dir 不存在时归友好语义而非裸 ENOENT 冒泡。
    // P2-17:错误消息不回显 resolve 后的绝对目录(与 master 侧口径一致),ref 是用户原始输入可回显。
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      throw new Error(`报告目录不存在(先 qa run)`);
    }
    let real: string;
    try {
      real = realpathSync(resolve(ref));
    } catch {
      throw new Error(`report_path 不存在或不可解析: ${ref}`);
    }
    if (!(real === realDir || real.startsWith(realDir + sep))) {
      throw new Error(`report_path 必须位于 QA 报告目录内（拒绝任意路径读取）: ${ref}`);
    }
    full = real;
  } else {
    // 裸 run_id 或文件名(审查N-2 对称:统一过 realpath,与带路径分支同威胁模型同防护)
    full = realpathSync(join(dir, ref.endsWith('.json') ? ref : `${ref}.json`));
  }
  if (!existsSync(full)) {
    throw new Error(`QA 报告不存在: ${ref}`);
  }
  return JSON.parse(readFileSync(full, 'utf-8')) as QaReport;
}

export function stepCaseId(st: StepRecord): string {
  return st.label ?? `${st.index}:${st.type}`;
}

/**
 * 找同套件的上一次运行报告（QA 收尾批② nightly 基线）：按 run_id 文件名时间序，
 * 从 excludeRunId 之后往前找第一个同 sanitizeSuiteName 后缀的报告；找不到返回 null
 * （首次运行无基线，nightly 对该套件跳过 diff 只报告本次结果）。
 * 审查 Important-2：sanitize 是有损压缩（'a b' 与 'a_b' 同后缀），文件名只做粗筛，
 * 命中后必读 JSON 校验原始 suite.name——碰撞套件的历史报告不作为基线（防止 diff 静默失真）。
 * PR-2 粗筛双兼容：run_id 加随机后缀后为三段式（...-{sanitize}-{rand4}），中段匹配；
 * 两段式历史落盘报告（...-{sanitize}.json）仍按 endsWith 命中——旧基线不丢。
 */
export function findPreviousReport(excludeRunId: string, suiteName: string): QaReport | null {
  const sanitize = sanitizeSuiteName(suiteName);
  const legacySuffix = `-${sanitize}.json`; // 两段式（PR-2 前历史报告）
  const midSegment = `-${sanitize}-`;      // 三段式（随机后缀形态）
  const all = listReports(); // 倒序，最新在前
  const curIdx = all.indexOf(`${excludeRunId}.json`);
  const candidates = curIdx >= 0 ? all.slice(curIdx + 1) : all;
  for (const f of candidates) {
    if (!f.endsWith(legacySuffix) && !f.includes(midSegment)) continue;
    try {
      const rep = JSON.parse(readFileSync(join(qaReportsDir(), f), 'utf8')) as QaReport;
      if (rep.suite?.name === suiteName) {
        if (rep.summary?.status === 'CANCELLED') continue; // 半途报告不作基线（PR-1b I-5），继续往前找
        return rep;
      }
    } catch { /* 损坏的候选报告跳过，继续往前找 */ }
  }
  return null;
}

export interface QaDiff {
  base_run_id: string;
  head_run_id: string;
  regressions: { case: string; base: StepStatus; head: StepStatus; head_detail?: string }[];
  fixed: { case: string; base: StepStatus; head: StepStatus }[];
  added: { case: string; head: StepStatus }[];
  removed: { case: string; base: StepStatus }[];
  unchanged_passed: number;
  verdict: 'REGRESSED' | 'IMPROVED' | 'NO_STATUS_CHANGE';
}

/** 按用例 id（label 优先，回退 index:type）对比两份报告。PASSED 之外的都算 not-passed。 */
export function diffReports(base: QaReport, head: QaReport): QaDiff {
  const baseMap = new Map(base.steps.map(s => [stepCaseId(s), s]));
  const headMap = new Map(head.steps.map(s => [stepCaseId(s), s]));

  const regressions: QaDiff['regressions'] = [];
  const fixed: QaDiff['fixed'] = [];
  const added: QaDiff['added'] = [];
  const removed: QaDiff['removed'] = [];
  let unchangedPassed = 0;

  for (const [id, h] of headMap) {
    const b = baseMap.get(id);
    if (!b) {
      added.push({ case: id, head: h.status });
      continue;
    }
    const bOk = b.status === 'PASSED';
    const hOk = h.status === 'PASSED';
    if (bOk && !hOk) regressions.push({ case: id, base: b.status, head: h.status, head_detail: h.detail });
    else if (!bOk && hOk) fixed.push({ case: id, base: b.status, head: h.status });
    else if (bOk && hOk) unchangedPassed++;
  }
  for (const [id, b] of baseMap) {
    if (!headMap.has(id)) removed.push({ case: id, base: b.status });
  }

  const verdict = regressions.length > 0 ? 'REGRESSED' : fixed.length > 0 ? 'IMPROVED' : 'NO_STATUS_CHANGE';
  return {
    base_run_id: base.run_id,
    head_run_id: head.run_id,
    regressions, fixed, added, removed,
    unchanged_passed: unchangedPassed,
    verdict,
  };
}
