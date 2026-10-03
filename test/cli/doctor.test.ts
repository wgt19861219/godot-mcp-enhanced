import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
  // 易用性批4:默认返回受支持版本,个别用例用 mockResolvedValueOnce 覆盖
  detectGodotVersion: vi.fn().mockResolvedValue('4.7.2.stable'),
}));

vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(true); this.isConfigured = vi.fn().mockResolvedValue(true);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/gemini-cli.js', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Gemini CLI'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/qwen-code.js', () => ({
  QwenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Qwen Code'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/claude-desktop.js', () => ({
  ClaudeDesktopAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Desktop'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/windsurf.js', () => ({
  WindsurfAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Windsurf'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cline.js', () => ({
  ClineAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cline'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/zed.js', () => ({
  ZedAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Zed'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/antigravity.js', () => ({
  AntigravityAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Antigravity'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/trae.js', () => ({
  TraeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Trae'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cherry-studio.js', () => ({
  CherryStudioAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cherry Studio'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

describe('doctor', () => {
  it('runDoctor completes and reports Node version', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Node.js');
    expect(output).toContain('Godot');
    consoleSpy.mockRestore();
  });

  it('logs client scope (project|global) on each status line', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    expect(logSpy.mock.calls.some(c => /\(project\)/.test(String(c[0] ?? '')))).toBe(true);
    expect(logSpy.mock.calls.some(c => /\(global\)/.test(String(c[0] ?? '')))).toBe(true);
    logSpy.mockRestore();
  });

  // ─── 易用性批4 (2026-09-19):版本检查 / 白名单提示 / 不适用标记 ───

  it('reports supported version 4.5–4.7 as ✓', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('4.6.1.stable');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});  // mock 环境下 Node/Godot 全 ✓ 不 exit,catch 兜底
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot version 4.6.1.stable (supported 4.5–4.7)');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('reports unsupported Godot 3.x as ✗ and exits 1', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('3.5.stable.official');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(runDoctor([])).rejects.toThrow('exit');
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('✗ Godot version 3.5.stable.official unsupported (requires 4.5–4.7)');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('reports Godot > 4.7 as warn (unverified, not error)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('4.8.1.stable');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('! Godot version 4.8.1.stable > 4.7');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('skips version check gracefully when detectGodotVersion throws', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockRejectedValueOnce(new Error('godot path not in whitelist'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot version check skipped');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  // B-7③ (2026-10-03): findGodot 对显式 GODOT_PATH 校验失败带 stage 消息 throw,
  // doctor 须透出具体原因——不再一律显示"set GODOT_PATH"误导已配置的用户。
  it('surfaces findGodot rejection reason (B-7③ stage message) instead of generic hint', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { findGodot } = await import('../../src/core/godot-finder.js');
    vi.mocked(findGodot).mockRejectedValueOnce(new Error('GODOT_PATH is rejected by the GODOT_MCP_ALLOWED_GODOT_PATHS whitelist. Add the executable (or its parent directory) to the whitelist, or unset GODOT_PATH to fall back to auto-discovery.'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('GODOT_MCP_ALLOWED_GODOT_PATHS whitelist');
    expect(output).not.toContain('set GODOT_PATH 或运行');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('warns with config example when ALLOWED_PROJECT_PATHS unset', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const orig = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.ALLOWED_PROJECT_PATHS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('ALLOWED_PROJECT_PATHS not set');
    expect(output).toContain('ALLOWED_PROJECT_PATHS="D:/proj/A;D:/proj/B"');
    if (orig !== undefined) process.env.ALLOWED_PROJECT_PATHS = orig;
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('marks not-installed clients and non-project dir with neutral ⊘ instead of ✗', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    // 在非 Godot 目录跑(临时目录),Cursor mock detect=false → ⊘ not installed
    const tempDir = join(tmpdir(), 'doctor-na-' + Math.random().toString(36).slice(2));
    mkdirSync(tempDir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try { await runDoctor([]).catch(() => {}); } finally { process.chdir(originalCwd); rmSync(tempDir, { recursive: true, force: true }); }
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('⊘ Cursor (project): not installed');
    expect(output).toContain('⊘ project.godot not found');
    expect(output).not.toContain('✗ Cursor');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('handles BOM in mcp-godot.json without throwing', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const tempDir = join(tmpdir(), 'doctor-test-' + Math.random().toString(36).slice(2));
    const godotDir = join(tempDir, '.godot');
    mkdirSync(godotDir, { recursive: true });

    const configPath = join(godotDir, 'mcp-godot.json');
    const BOM = '﻿';
    const configContent = BOM + JSON.stringify({ godot_path: '/custom/godot' });
    writeFileSync(configPath, configContent, 'utf-8');

    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Change to temp dir to test project-level config
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);

      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');

      // Should not throw, and should read the Godot override correctly
      expect(output).toContain('Project Godot override: /custom/godot');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Addons 同步检查(项目待办 :150) ──

describe('doctor addons sync — compareAddons / listAddonFiles 纯函数', () => {
  /** 造临时 addon 目录结构:root/plugin.gd + root/commands/foo.gd */
  function makeAddon(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }
  }

  it('in sync when upstream and target have identical files', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    const files = { 'plugin.cfg': 'v1', 'plugin.gd': 'extends EditorPlugin', 'commands/foo.gd': 'func bar()' };
    makeAddon(upstream, files);
    makeAddon(target, files);
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(result.missing).toEqual([]);
    expect(result.differing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('reports missing when target lacks files upstream has', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.cfg': 'v1', 'plugin.gd': 'x', 'commands/foo.gd': 'y' });
    makeAddon(target, { 'plugin.cfg': 'v1' });  // 缺 plugin.gd + commands/foo.gd
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(false);
    expect(result.missing).toContain('plugin.gd');
    expect(result.missing).toContain('commands/foo.gd');
    expect(result.missing).not.toContain('plugin.cfg');
    rmSync(base, { recursive: true, force: true });
  });

  it('reports differing when content differs', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.cfg': 'version=1', 'plugin.gd': 'extends EditorPlugin' });
    makeAddon(target, { 'plugin.cfg': 'version=2', 'plugin.gd': 'extends EditorPlugin' });  // plugin.cfg 内容不同
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(false);
    expect(result.differing).toEqual(['plugin.cfg']);  // sorted
    expect(result.missing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('extra files in target do not break sync (reported but not a failure)', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.gd': 'x' });
    makeAddon(target, { 'plugin.gd': 'x', 'custom.gd': 'y' });  // 目标多一个文件
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);  // extra 不影响 inSync
    expect(result.extra).toEqual(['custom.gd']);
    rmSync(base, { recursive: true, force: true });
  });

  it('listAddonFiles skips symlinks (B6 escape prevention)', async () => {
    const { listAddonFiles } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    writeFileSync(join(base, 'real.gd'), 'content', 'utf-8');
    // 造 symlink 指向 base 自身(防逃逸测试);某些平台/CI 不支持 symlink,try-catch 跳过
    try {
      symlinkSync(base, join(base, 'escape-link'));
    } catch {
      rmSync(base, { recursive: true, force: true });
      return;  // 无 symlink 权限(如 Windows 非 admin),跳过本测试
    }
    const files = listAddonFiles(base);
    expect(files.some(f => f.endsWith('real.gd'))).toBe(true);
    expect(files.some(f => f.includes('escape-link'))).toBe(false);  // symlink 跳过
    rmSync(base, { recursive: true, force: true });
  });

  it('treats CRLF vs LF as in sync (审查 Nit #1 行尾归一)', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    // 上游 LF,目标 CRLF(Windows 编辑器写回场景)——内容等价,行尾不同
    makeAddon(upstream, { 'plugin.gd': 'line1\nline2\n' });
    makeAddon(target, { 'plugin.gd': 'line1\r\nline2\r\n' });
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);  // CRLF 归一后等价,不误报 differing
    expect(result.differing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('doctor addons sync — 集成检查', () => {
  it('reports OUT OF SYNC when target addon differs from upstream', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    // 用真实上游 addons(本仓库)对比一个造的 stale 目标
    const tempDir = mkdtempSync(join(tmpdir(), 'doctor-sync-'));
    const targetAddon = join(tempDir, 'addons', 'godot_mcp_server');
    // 造一个 stale plugin.cfg(内容与上游不同)
    mkdirSync(targetAddon, { recursive: true });
    writeFileSync(join(targetAddon, 'plugin.cfg'), 'STALE-CONTENT', 'utf-8');
    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);
      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('OUT OF SYNC');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips sync check when project has no addon', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const tempDir = mkdtempSync(join(tmpdir(), 'doctor-noaddon-'));
    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);
      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('skip sync check');
      expect(output).not.toContain('OUT OF SYNC');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
