import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AntigravityAdapter', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('has global scope', async () => {
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(new AntigravityAdapter().scope).toBe('global');
  });

  it('configure writes to new ~/.gemini/config/ path + seeds disabled:false', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    await new AntigravityAdapter().configure('/ignored', '/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(join(fakeHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'));
    expect(config.mcpServers.godot.env.GODOT_PATH).toBe('/godot');
    expect(config.mcpServers.godot.disabled).toBe(false);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('isConfigured recognizes legacy ~/.gemini/antigravity/ path (双路径兼容)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const legacyPath = join(fakeHome, '.gemini', 'antigravity', 'mcp_config.json');
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ mcpServers: { godot: { command: 'npx' } } }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(await new AntigravityAdapter().isConfigured('/ignored')).toBe(true);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('configure preserves disabled + disabledTools on reconfigure', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const filePath = join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      mcpServers: { godot: { command: 'old', disabled: true, disabledTools: ['t1'] } },
    }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    await new AntigravityAdapter().configure('/ignored', '/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(config.mcpServers.godot.disabled).toBe(true);
    expect(config.mcpServers.godot.disabledTools).toEqual(['t1']);
    expect(config.mcpServers.godot.command).toBe('npx');
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // 反向断言(spec §4):无配置→false / 有配置无 godot key→false,防 isConfigured 假绿
  it('detect + isConfigured return false when no config path exists', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(await new AntigravityAdapter().detect()).toBe(false);
    expect(await new AntigravityAdapter().isConfigured('/ignored')).toBe(false);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('isConfigured returns false when mcpServers has no godot key (其他 server 占位)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const newPath = join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(join(newPath, '..'), { recursive: true });
    writeFileSync(newPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(await new AntigravityAdapter().detect()).toBe(true);        // 文件存在
    expect(await new AntigravityAdapter().isConfigured('/ignored')).toBe(false);  // 无 godot key
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // C1 (cli-configure-env-field-overwrite): USER_STATE_KEYS 保留路径之外,env 白名单也必须保留
  it('configure preserves whitelisted user env on reconfigure (C1)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const filePath = join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      mcpServers: {
        godot: {
          command: 'old',
          disabled: true,
          env: {
            GODOT_PATH: '/old',
            ALLOWED_PROJECT_PATHS: '/projects',
            GODOT_MCP_BRIDGE_PERSISTENT_SECRET: 'true',
            HACKER_INJECTED: 'evil',
          },
        },
      },
    }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    await new AntigravityAdapter().configure('/ignored', '/new/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(filePath, 'utf-8'));
    const env = config.mcpServers.godot.env;
    expect(env.GODOT_PATH).toBe('/new/godot');
    expect(env.ALLOWED_PROJECT_PATHS).toBe('/projects');
    expect(env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET).toBe('true');
    expect(env.HACKER_INJECTED).toBeUndefined();
    // user-state 保留路径同时生效
    expect(config.mcpServers.godot.disabled).toBe(true);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // ── unconfigure(uninstall 反向操作;新/旧双路径都清)──

  it('unconfigure removes godot from both new and legacy paths', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const newPath = join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    const legacyPath = join(fakeHome, '.gemini', 'antigravity', 'mcp_config.json');
    mkdirSync(join(newPath, '..'), { recursive: true });
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(newPath, JSON.stringify({ mcpServers: { godot: { command: 'npx' }, other: { command: 'x' } } }));
    writeFileSync(legacyPath, JSON.stringify({ mcpServers: { godot: { command: 'npx' } } }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(await new AntigravityAdapter().unconfigure!('/ignored')).toBe(true);
    const afterNew = JSON.parse(readFileSync(newPath, 'utf-8'));
    const afterLegacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    expect(afterNew.mcpServers.godot).toBeUndefined();
    expect(afterNew.mcpServers.other).toBeDefined();        // 同文件其他 server 不连坐
    expect(afterLegacy.mcpServers.godot).toBeUndefined();    // 旧路径残留也清
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('unconfigure returns false when nothing configured', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-ag-'));
    vi.doMock('os', () => ({ homedir: () => fakeHome }));
    const { AntigravityAdapter } = await import('../../../src/cli/clients/antigravity.js');
    expect(await new AntigravityAdapter().unconfigure!('/ignored')).toBe(false);
    rmSync(fakeHome, { recursive: true, force: true });
  });
});
