import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => {
    if (_cmd === 'codex' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'list') cb(null, { stdout: 'godot' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'add') cb(null, { stdout: 'Added' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'remove') cb(null, { stdout: 'Removed' });
    else cb(new Error('not found'));
  }),
}));

describe('CodexAdapter', () => {
  let fakeHome: string;
  beforeEach(() => {
    vi.resetModules();
    // execFile 在顶层 vi.mock 工厂内定义,mock.calls 会跨测试累积。
    // clearAllMocks 清 calls/results 但保留工厂实现(顶层 vi.mock 不被重置)。
    vi.clearAllMocks();
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-codex-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('has correct name', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe('Codex');
  });

  it('has global scope', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(adapter.scope).toBe('global');
  });

  it('detects installed codex', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(await adapter.detect()).toBe(true);
  });

  it('isConfigured returns true when godot listed', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(await adapter.isConfigured('/tmp')).toBe(true);
  });

  it('configure calls mcp add', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    await expect(adapter.configure('/tmp', '/godot', 'npx', ['godot-mcp-enhanced'])).resolves.toBeUndefined();
  });

  // C1 (cli-configure-env-field-overwrite): codex adapter 通过 --env flag 传 env。
  // 必须从 ~/.codex/config.toml 读旧 godot entry 的白名单 env,作为额外 --env flag 传入。
  it('configure passes whitelisted env from config.toml as additional --env flags (C1)', async () => {
    // 模拟 codex CLI 写出的 config.toml 含 godot server + env 内联表
    const codexDir = join(fakeHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), [
      'model = "x"',
      '',
      '[mcp_servers.godot]',
      'command = "npx"',
      'args = ["-y", "godot-mcp-enhanced"]',
      'env = { GODOT_PATH = "/old", ALLOWED_PROJECT_PATHS = "/projects;/other", GODOT_MCP_BRIDGE_PERSISTENT_SECRET = "true", HACKER_INJECTED = "evil" }',
      '',
    ].join('\n'));

    const cp = await import('child_process');
    const execFileSpy = vi.mocked(cp.execFile);
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    await new CodexAdapter().configure('/ignored', '/new/godot', 'npx', ['godot-mcp-enhanced']);

    const addCall = execFileSpy.mock.calls.find((c: unknown[]) => {
      const a = c[1] as string[];
      return c[0] === 'codex' && a[0] === 'mcp' && a[1] === 'add';
    });
    expect(addCall).toBeDefined();
    const args = addCall![1] as string[];
    const envFlags = args.filter((_, i) => args[i - 1] === '--env');

    // 至少含 GODOT_PATH(新)+ 白名单两项;脏值不在
    expect(envFlags).toContain('GODOT_PATH=/new/godot');
    expect(envFlags).toContain('ALLOWED_PROJECT_PATHS=/projects;/other');
    expect(envFlags).toContain('GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true');
    expect(envFlags.some(f => f.startsWith('HACKER_INJECTED'))).toBe(false);
  });

  it('configure passes only GODOT_PATH when config.toml absent (C1 fallback)', async () => {
    // 不写 config.toml — 应 fallback 到只传 GODOT_PATH
    const cp = await import('child_process');
    const execFileSpy = vi.mocked(cp.execFile);
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    await new CodexAdapter().configure('/ignored', '/godot', 'npx', ['godot-mcp-enhanced']);
    const addCall = execFileSpy.mock.calls.find((c: unknown[]) => {
      const a = c[1] as string[];
      return c[0] === 'codex' && a[0] === 'mcp' && a[1] === 'add';
    });
    const args = addCall![1] as string[];
    const envFlags = args.filter((_, i) => args[i - 1] === '--env');
    expect(envFlags).toEqual(['GODOT_PATH=/godot']);
  });

  // ── unconfigure(uninstall 反向操作;CLI 调用型:codex mcp remove)──

  it('unconfigure calls codex mcp remove when configured', async () => {
    const cp = await import('child_process');
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    expect(await new CodexAdapter().unconfigure!('/ignored')).toBe(true);
    const removeCall = vi.mocked(cp.execFile).mock.calls.find((c: unknown[]) => {
      const a = c[1] as string[];
      return (c[0] as string) === 'codex' && a[0] === 'mcp' && a[1] === 'remove' && a[2] === 'godot';
    });
    expect(removeCall).toBeDefined();
  });

  it('unconfigure is a no-op when not configured(mcp list 无 godot → 不调 remove)', async () => {
    const cp = await import('child_process');
    vi.mocked(cp.execFile).mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === '--version') cb(null, { stdout: '1.0.0' });
      else if (args[0] === 'mcp' && args[1] === 'list') cb(null, { stdout: 'other-server' });  // 精确匹配不中
      else cb(new Error('unexpected: ' + JSON.stringify(args)));
    }) as never);
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    expect(await new CodexAdapter().unconfigure!('/ignored')).toBe(false);
    const removeCalls = vi.mocked(cp.execFile).mock.calls.filter((c: unknown[]) => {
      const a = c[1] as string[];
      return (c[0] as string) === 'codex' && a[0] === 'mcp' && a[1] === 'remove';
    });
    expect(removeCalls.length).toBe(0);
  });
});
