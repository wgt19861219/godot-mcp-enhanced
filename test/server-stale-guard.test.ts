import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkServerFresh, PKG_VERSION } from '../src/core/update-checker.js';
import * as updateChecker from '../src/core/update-checker.js';
import { handleTool as selfUpdateTool } from '../src/tools/self-update.js';
import { handleTool as projectTool } from '../src/tools/project.js';

// P0（2026-10-24 规则分发可靠性批）：毒化拦截——server 进程固化版本（PKG_VERSION，
// 模块加载时与模板同源固化）落后于磁盘包版本时，拒绝规则分发与 addon 更新，
// 防"新版本号 + 旧内容"毒化文件（实证：2026-10-24 godot-test-project 0.36.1 版本行
// + 0.36.0 内容）。checkServerFresh 为注入式纯函数，两工具入口共用。

describe('checkServerFresh 纯函数（注入两侧值）', () => {
  it('两侧一致 → ok:true', () => {
    expect(checkServerFresh('0.36.1', '0.36.1')).toEqual({ ok: true });
  });

  it('进程旧于磁盘 → ok:false + SERVER_STALE + 含两侧版本与重启指引', () => {
    const r = checkServerFresh('0.36.0', '0.36.1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('SERVER_STALE');
      expect(r.message).toContain('0.36.0');
      expect(r.message).toContain('0.36.1');
      expect(r.message).toContain('重启');
    }
  });

  it('进程新于磁盘（理论上不发生）同样拒绝——比对是双向不等,非单向', () => {
    const r = checkServerFresh('0.36.2', '0.36.1');
    expect(r.ok).toBe(false);
  });
});

// ─── 工具入口拦截（spy readInstalledPkgVersion 注入磁盘读数）────────────────────

interface ParsedError { success: boolean; error_code?: string; error?: string }

function parse(r: unknown): ParsedError {
  return JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
}

// 对齐 project-tools.test.js createMockCtx 的最小形态（setup_project_rules 的
// CLAUDE.md/AGENTS.md 段需要 ctx.parseGodotConfig）
const anyCtx = {
  parseGodotConfig: () => ({
    application: { 'config/name': 'TestProject' },
    rendering: { 'renderer/rendering_method': 'forward_plus' },
  }),
} as unknown as Parameters<typeof projectTool>[2];

let tmpProject: string;
beforeEach(() => {
  process.env.GODOT_MCP_UNRESTRICTED = 'true';
  tmpProject = mkdtempSync(join(tmpdir(), 'stale-'));
  writeFileSync(join(tmpProject, 'project.godot'), '');
});
afterEach(() => {
  delete process.env.GODOT_MCP_UNRESTRICTED;
  rmSync(tmpProject, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('setup_project_rules 毒化拦截', () => {
  it('磁盘版本新于进程 → SERVER_STALE 拒绝分发（error 通道，非 textResult）', async () => {
    const spy = vi.spyOn(updateChecker, 'readInstalledPkgVersion').mockReturnValue('99.0.0');
    try {
      const r = await projectTool('project',
        { action: 'setup_project_rules', project_path: tmpProject }, anyCtx);
      const parsed = parse(r);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('SERVER_STALE');
      expect(parsed.error).toContain('99.0.0');
      expect(parsed.error).toContain(PKG_VERSION);
    } finally {
      spy.mockRestore();
    }
  });

  it('磁盘读失败（null）→ 跳过拦截走正常分发（包根不可读不阻断可用性）', async () => {
    const spy = vi.spyOn(updateChecker, 'readInstalledPkgVersion').mockReturnValue(null);
    try {
      const r = await projectTool('project',
        { action: 'setup_project_rules', project_path: tmpProject }, anyCtx);
      // 正常分发路径是 textResult(JSON.stringify(report))，含 actions 数组（非 ops 错误包装）
      const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
      expect(text).not.toContain('SERVER_STALE');
      expect(text).toContain('actions');
    } finally {
      spy.mockRestore();
    }
  });

  it('两侧一致（磁盘 = 进程固化值）→ 放行正常分发', async () => {
    const spy = vi.spyOn(updateChecker, 'readInstalledPkgVersion').mockReturnValue(PKG_VERSION);
    try {
      const r = await projectTool('project',
        { action: 'setup_project_rules', project_path: tmpProject }, anyCtx);
      const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
      expect(text).not.toContain('SERVER_STALE');
      expect(text).toContain('actions');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('self_update update 毒化拦截', () => {
  it('磁盘版本新于进程 → SERVER_STALE 拒绝 addon 更新（旧进程装出旧 addon 同族缺陷）', async () => {
    const spy = vi.spyOn(updateChecker, 'readInstalledPkgVersion').mockReturnValue('99.0.0');
    try {
      const r = await selfUpdateTool('self_update',
        { action: 'update', project_path: tmpProject }, undefined as unknown as Parameters<typeof selfUpdateTool>[2]);
      const parsed = parse(r);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('SERVER_STALE');
    } finally {
      spy.mockRestore();
    }
  });

  it('check action 不拦截（只读,无写面）', async () => {
    const spy = vi.spyOn(updateChecker, 'readInstalledPkgVersion').mockReturnValue('99.0.0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    try {
      const r = await selfUpdateTool('self_update', { action: 'check', project_path: tmpProject }, undefined as unknown as Parameters<typeof selfUpdateTool>[2]);
      const parsed = parse(r);
      expect(parsed.success).toBe(true);
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
