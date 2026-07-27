import { describe, it, expect } from 'vitest';
import { formatIssues, dualTrackOutput, parseDualTrack } from '../src/tools/shared/issue-formatter.js';
import type { NormalizedIssue } from '../src/tools/shared/issue-formatter.js';

// ─── formatIssues ────────────────────────────────────────────────────────────

describe('formatIssues', () => {
  it('returns "No issues found." for empty array', () => {
    expect(formatIssues([])).toBe('No issues found.');
  });

  it('groups by severity in fixed order (critical → error → warning → info)', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'info', location: 'a.gd', message: 'info msg' },
      { severity: 'critical', location: 'b.gd', message: 'crit msg' },
      { severity: 'warning', location: 'c.gd', message: 'warn msg' },
      { severity: 'error', location: 'd.gd', message: 'err msg' },
    ];
    const out = formatIssues(issues);
    // critical 应在 error 之前，error 在 warning 之前，warning 在 info 之前
    const critIdx = out.indexOf('Critical');
    const errIdx = out.indexOf('Errors');
    const warnIdx = out.indexOf('Warnings');
    const infoIdx = out.indexOf('Info');
    expect(critIdx).toBeLessThan(errIdx);
    expect(errIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(infoIdx);
  });

  it('formats each issue with location + message + suggestion arrow', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'error', location: 'src/foo.gd', message: 'undefined var', suggestion: 'add var x' },
    ];
    const out = formatIssues(issues);
    expect(out).toContain('Errors (1):');
    expect(out).toContain('  src/foo.gd: undefined var');
    expect(out).toContain('    → add var x');
  });

  it('handles issue without location (empty string)', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'warning', location: '', message: 'no loc msg' },
    ];
    const out = formatIssues(issues);
    expect(out).toContain('  no loc msg');
    expect(out).not.toContain(': no loc msg');
  });

  it('handles issue without suggestion', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'warning', location: 'x.gd', message: 'msg' },
    ];
    const out = formatIssues(issues);
    expect(out).not.toContain('→');
  });

  it('truncates with "... and N more not shown" when truncate opt set', () => {
    const issues: NormalizedIssue[] = Array.from({ length: 5 }, (_, i) => ({
      severity: 'error', location: `f${i}.gd`, message: `msg${i}`,
    }));
    const out = formatIssues(issues, { truncate: 2 });
    expect(out).toContain('Errors (5):');
    expect(out).toContain('  f0.gd: msg0');
    expect(out).toContain('  f1.gd: msg1');
    expect(out).not.toContain('f2.gd');
    expect(out).toContain('  ... and 3 more not shown');
  });

  it('does not truncate when truncate opt undefined', () => {
    const issues: NormalizedIssue[] = Array.from({ length: 150 }, (_, i) => ({
      severity: 'error', location: `f${i}.gd`, message: `m${i}`,
    }));
    const out = formatIssues(issues);
    expect(out).toContain('Errors (150):');
    expect(out).toContain('  f149.gd: m149');
    expect(out).not.toContain('more not shown');
  });

  it('maps unknown severity to info group', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'weird', location: 'x', message: 'm' },
    ];
    const out = formatIssues(issues);
    expect(out).toContain('Info (1):');
    expect(out).not.toContain('weird');
  });

  it('only shows first line of multi-line suggestion', () => {
    const issues: NormalizedIssue[] = [
      { severity: 'error', location: 'x', message: 'm', suggestion: 'line1\nline2\nline3' },
    ];
    const out = formatIssues(issues);
    expect(out).toContain('→ line1');
    expect(out).not.toContain('line2');
    expect(out).not.toContain('line3');
  });
});

// ─── dualTrackOutput ─────────────────────────────────────────────────────────

describe('dualTrackOutput', () => {
  it('concatenates human text + ---JSON--- marker + compact JSON', () => {
    const out = dualTrackOutput('Summary: 2 errors', { count: 2 });
    expect(out).toContain('Summary: 2 errors');
    expect(out).toContain('---JSON---\n');
    // 紧凑 JSON（无缩进）
    expect(out).toContain('{"count":2}');
  });

  it('produces parseable JSON via parseDualTrack round-trip', () => {
    const data = { passed: false, issues: [{ severity: 'error', message: 'x' }] };
    const out = dualTrackOutput('human', data);
    const parsed = parseDualTrack(out);
    expect(parsed).toEqual(data);
  });
});

// ─── parseDualTrack ──────────────────────────────────────────────────────────

describe('parseDualTrack', () => {
  it('parses JSON after the last ---JSON--- marker', () => {
    const text = 'Some report\n\n---JSON---\n{"a":1}';
    expect(parseDualTrack(text)).toEqual({ a: 1 });
  });

  it('handles JSON content containing the marker string (uses lastIndexOf)', () => {
    // 罕见但可能：JSON 内部含 ---JSON--- 字面量，应取最后一个分隔符
    const text = 'report\n\n---JSON---\n{"msg":"---JSON---\\n trailing"}';
    const parsed = parseDualTrack(text) as { msg: string };
    expect(parsed.msg).toBe('---JSON---\n trailing');
  });

  it('falls back to parsing entire text when no marker present (backward compat)', () => {
    const text = '{"legacy":true}';
    expect(parseDualTrack(text)).toEqual({ legacy: true });
  });
});
