import { describe, it, expect, vi } from 'vitest';

// Mock godot-finder
vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

// Mock all 13 client adapters (each carries scope so the log asserts can match)
vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(true);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/gemini-cli.js', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Gemini CLI';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/qwen-code.js', () => ({
  QwenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Qwen Code';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/claude-desktop.js', () => ({
  ClaudeDesktopAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Desktop';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/windsurf.js', () => ({
  WindsurfAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Windsurf';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/cline.js', () => ({
  ClineAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cline';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/zed.js', () => ({
  ZedAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Zed';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/antigravity.js', () => ({
  AntigravityAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Antigravity';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/trae.js', () => ({
  TraeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Trae';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/cherry-studio.js', () => ({
  CherryStudioAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cherry Studio';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/zcode.js', () => ({
  ZCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'ZCode';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/warp.js', () => ({
  WarpAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Warp';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

describe('setup', () => {
  it('runSetup completes without error', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSetup([]);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot found');
    expect(output).toContain('Claude Code');
    consoleSpy.mockRestore();
    consoleError.mockRestore();
  });

  // 易用性批3 (2026-09-19):配置成功出口必须给「重启生效 + 验证方式」下一步
  // (本 mock 下 Claude Code detect=true 且未配置 → configured ≥ 1,走成功分支)
  it('prints restart-and-verify hint after configuring clients', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSetup([]);
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('client(s) configured');
    expect(output).toContain('重启 AI 客户端会话后生效');
    expect(output).toContain('get_godot_version');
    expect(output).toContain('doctor');
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('logs client scope (project|global) on each line', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSetup([]);
    // Each adapter log line carries its scope — at least one project (Claude Code) and one global (Codex) appear
    expect(logSpy.mock.calls.some(c => /\(project\)/.test(String(c[0] ?? '')))).toBe(true);
    expect(logSpy.mock.calls.some(c => /\(global\)/.test(String(c[0] ?? '')))).toBe(true);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
