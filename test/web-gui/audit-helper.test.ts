// test/web-gui/audit-helper.test.ts
// 批6-N-e(批5审查挂账): auditWebGui 失败调用 + 路径不存在的分流语义——
// 此前 existsSync 守卫把假路径越权探测的证据连同垃圾目录一起挡掉;现为:
//   失败 + 路径不存在 → 机器级 ~/.godot-mcp/machine-audit.jsonl 承接(不建目录零垃圾)
//   成功 + 路径不存在 → 跳过(成功路径必存在,竞态下无项目可归属——维持批4语义)
//   失败 + 路径存在   → 项目审计 .godot/mcp_audit.jsonl 照旧(批5-N4② 语义不回归)
// 双 stub HOME+USERPROFILE:Windows os.homedir() 只认 USERPROFILE(2026-09-19 实测)。

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWebGui } from '../../src/web-gui/audit-helper.js';
import { getMachineAuditFile } from '../../src/core/audit-log.js';

let fakeHome = '';
let proj = '';

function readMachineLines(): Record<string, unknown>[] {
  try {
    return readFileSync(getMachineAuditFile(), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}

/** fire-and-forget 审计落盘轮询(对齐 server-http.test.ts 批4-T8 模式)。 */
async function waitMachineEntry(pred: (e: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 20; i++) {
    const hit = readMachineLines().find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

describe('批6-N-e: auditWebGui 失败留痕分流(existsSync 守卫语义升级)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'gme-audith-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    proj = mkdtempSync(join(tmpdir(), 'gme-auditp-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it('失败 + 路径不存在 → machine-audit 落 ok:false(假路径探测留痕,不建项目目录)', async () => {
    const probe = join(fakeHome, 'recon', 'no-such-project');
    auditWebGui('sessions', 'start', 'process', probe, { ok: false, error: 'path outside allowed roots', details: { mode: 'run' } });
    const hit = await waitMachineEntry((e) => e.action === 'start' && e.ok === false);
    expect(hit, '机器级审计行应落盘').toBeDefined();
    expect(hit!.caller).toBe('web-gui:sessions');
    expect(hit!.project_path).toBe(probe);
    const det = hit!.details as { error?: string; project_path_absent?: boolean; mode?: string };
    expect(det.error).toBe('path outside allowed roots');
    expect(det.project_path_absent).toBe(true);
    expect(det.mode).toBe('run');
    // 不建目录零垃圾:假路径处不得出现 .godot(mkdir 副作用是守卫存在的原始理由)
    expect(existsSync(join(probe, '.godot'))).toBe(false);
    expect(existsSync(join(probe))).toBe(false);
  });

  it('成功 + 路径不存在 → 跳过(机器级零新条目,维持批4"成功无项目可归属"语义)', async () => {
    const ghost = join(fakeHome, 'deleted-project');
    auditWebGui('projects', 'add', 'write', ghost);
    await new Promise((r) => setTimeout(r, 250));   // fire-and-forget 静默窗口
    expect(readMachineLines().length).toBe(0);
    expect(existsSync(join(ghost, '.godot'))).toBe(false);
  });

  it('失败 + 路径存在 → 项目审计照旧落 ok:false,machine-audit 零条目(批5-N4② 不回归)', async () => {
    auditWebGui('sessions', 'stop', 'process', proj, { ok: false, error: 'process crash mid-kill' });
    const auditPath = join(proj, '.godot', 'mcp_audit.jsonl');
    let hit: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !hit; i++) {
      try {
        hit = readFileSync(auditPath, 'utf8').trim().split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((e) => e.action === 'stop' && e.ok === false);
      } catch { /* 尚未落盘 */ }
      if (!hit) await new Promise((r) => setTimeout(r, 50));
    }
    expect(hit, '项目级失败审计行应落盘').toBeDefined();
    expect((hit!.details as { error?: string; project_path_absent?: boolean })?.error).toBe('process crash mid-kill');
    expect((hit!.details as { project_path_absent?: boolean })?.project_path_absent).toBeUndefined();
    expect(readMachineLines().length).toBe(0);
  });

  it('GODOT_MCP_AUDIT=false → 全通道不落(开关语义覆盖新分流路径)', async () => {
    vi.stubEnv('GODOT_MCP_AUDIT', 'false');
    try {
      auditWebGui('sessions', 'start', 'process', join(fakeHome, 'recon2', 'p'), { ok: false, error: 'x' });
      auditWebGui('sessions', 'stop', 'process', proj, { ok: false, error: 'y' });
      await new Promise((r) => setTimeout(r, 250));
      expect(readMachineLines().length).toBe(0);
      expect(existsSync(join(proj, '.godot', 'mcp_audit.jsonl'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv('HOME', fakeHome);   // 恢复 afterEach 清理所需的 stub 状态语义(实际清理用变量路径)
      vi.stubEnv('USERPROFILE', fakeHome);
    }
  });
});

// 项目审计文件已存在的追加形态(不覆盖既有行)——分流改造不得动 appendAuditLine 语义,
// 此用例锁"分流分支不误清/不重写既有审计历史"。
describe('批6-N-e: 既有项目审计历史不受分流改造影响', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'gme-audith2-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    proj = mkdtempSync(join(tmpdir(), 'gme-auditp2-'));
    mkdirSync(join(proj, '.godot'), { recursive: true });
    writeFileSync(join(proj, '.godot', 'mcp_audit.jsonl'),
      JSON.stringify({ timestamp: '2026-09-19T00:00:00Z', trace_id: 'legacy-line', tool: 't' }) + '\n', 'utf-8');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it('失败追加保留 legacy 行(append 语义)', async () => {
    auditWebGui('projects', 'remove', 'write', proj, { ok: false, error: 'boom' });
    await new Promise((r) => setTimeout(r, 250));
    const lines = readFileSync(join(proj, '.godot', 'mcp_audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).trace_id).toBe('legacy-line');
    expect(JSON.parse(lines[1]!).trace_id).toMatch(/^web-gui-/);
  });
});
