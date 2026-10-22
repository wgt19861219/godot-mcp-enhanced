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

// M-6(2026-10-22 审查): detectMcpCommand 路径判定——点目录启发式误判 npx 缓存/
// npm-global 为临时安装,写死 node 绝对路径,缓存清理后客户端配置即损坏。
describe('detectMcpCommand 路径判定（M-6）', () => {
  const realArgv = process.argv;
  const realGlobal = process.env.npm_config_global;

  afterEach(() => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(realArgv);
    if (realGlobal === undefined) delete process.env.npm_config_global;
    else process.env.npm_config_global = realGlobal;
    vi.restoreAllMocks();
  });

  function withEntry(entry: string): void {
    delete process.env.npm_config_global;  // 排除强信号,纯测路径段判定
    // realArgv 须在 describe 顶部捕获——spyOn 安装瞬间 argv getter 即被接管,
    // 此处再读 process.argv 拿到的是 mock 的 undefined。
    const nodeBin = realArgv[0] ?? 'node';
    vi.spyOn(process, 'argv', 'get').mockReturnValue([nodeBin, entry]);
  }

  it('npx 缓存路径判为全局 → 输出 npx 命令(缓存清理后配置不损坏)', async () => {
    const { detectMcpCommand } = await import('../../src/cli/setup.js');
    withEntry('/home/u/.npm/_npx/a1b2c3/node_modules/godot-mcp-enhanced/build/index.js');
    expect(detectMcpCommand()).toEqual({ command: 'npx', args: ['godot-mcp-enhanced'] });
  });

  it('Windows 反斜杠 npx 缓存路径同判全局', async () => {
    const { detectMcpCommand } = await import('../../src/cli/setup.js');
    withEntry('C:\\Users\\u\\.npm\\_npx\\a1b2c3\\node_modules\\godot-mcp-enhanced\\build\\index.js');
    expect(detectMcpCommand()).toEqual({ command: 'npx', args: ['godot-mcp-enhanced'] });
  });

  it('npm-global 目录(点开头)判为全局', async () => {
    const { detectMcpCommand } = await import('../../src/cli/setup.js');
    withEntry('/home/u/.npm-global/lib/node_modules/godot-mcp-enhanced/build/index.js');
    expect(detectMcpCommand()).toEqual({ command: 'npx', args: ['godot-mcp-enhanced'] });
  });

  it('npm pack 解压临时段(.package/.staging)仍判本地 → node 绝对路径', async () => {
    const { detectMcpCommand } = await import('../../src/cli/setup.js');
    withEntry('/tmp/.package/.staging/a1b2/node_modules/godot-mcp-enhanced/build/index.js');
    const r = detectMcpCommand();
    expect(r.command).toBe('node');
    expect(r.args[0]).toContain('index.js');
  });

  it('仓库开发布局(无 node_modules 段)→ node 绝对路径', async () => {
    const { detectMcpCommand } = await import('../../src/cli/setup.js');
    withEntry('/repo/godot-mcp-enhanced/build/index.js');
    const r = detectMcpCommand();
    expect(r.command).toBe('node');
    expect(r.args[0]).toContain('index.js');
  });
});

describe('setup', () => {
  it('runSetup completes without error', async () => {    const { runSetup } = await import('../../src/cli/setup.js');
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
