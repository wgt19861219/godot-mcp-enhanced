import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
    if (_cmd === 'opencode' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else cb(new Error('unexpected execFile: ' + _cmd + ' ' + JSON.stringify(_args)));
  }),
}));

// BOM 必须运行时构建——Write 工具会把 '' 转义解析为字面 BOM 字符写入源码（不可见）
const BOM = String.fromCharCode(0xFEFF);
const TEST_DIR = join(tmpdir(), 'godot-mcp-test-opencode');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('OpenCodeAdapter', () => {
  it('has correct name', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(new OpenCodeAdapter().name).toBe('OpenCode');
  });

  it('has project scope', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(new OpenCodeAdapter().scope).toBe('project');
  });

  it('detects installed opencode via --version', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().detect()).toBe(true);
  });

  it('isConfigured returns false when no opencode.json', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(false);
  });

  it('isConfigured returns true when godot present in mcp', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({ mcp: { godot: { type: 'local', command: ['x'] } } }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(true);
  });

  it('isConfigured returns false for malformed json', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), '{bad');
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(false);
  });

  it('configure writes opencode.json + seeds enabled:true (spec §3.1 首次创建默认)', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot/bin', 'npx', ['godot-mcp-enhanced']);
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.godot).toEqual({
      enabled: true,
      type: 'local',
      command: ['npx', 'godot-mcp-enhanced'],
      environment: { GODOT_PATH: '/godot/bin' },
    });
  });

  it('configure preserves existing top-level keys and other MCP servers', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'node', ['/abs/index.js']);
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcp.other).toBeDefined();
    expect(cfg.mcp.godot.command).toEqual(['node', '/abs/index.js']);
  });

  it('configure does NOT call interactive `mcp add` (IMPORTANT-6 regression guard)', async () => {
    const cp = await import('child_process');
    const execFileSpy = vi.mocked(cp.execFile);
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'npx', ['godot-mcp-enhanced']);
    const mcpAddCalls = execFileSpy.mock.calls.filter((c: unknown[]) => {
      const cmd = c[0] as string;
      const a = c[1] as string[];
      return cmd === 'opencode' && a[0] === 'mcp' && a[1] === 'add';
    });
    expect(mcpAddCalls.length).toBe(0);
    expect(existsSync(join(TEST_DIR, 'opencode.json'))).toBe(true);
  });

  it('configure backs up corrupted opencode.json before overwriting (F3)', async () => {
    const corrupt = '{ "mcp": { broken';
    writeFileSync(join(TEST_DIR, 'opencode.json'), corrupt);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'npx', ['godot-mcp-enhanced']);
    const backups = readdirSync(TEST_DIR).filter(f => f.startsWith('opencode.json.corrupt.') && f.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(TEST_DIR, backups[0]!), 'utf-8')).toBe(corrupt);
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.godot.command).toEqual(['npx', 'godot-mcp-enhanced']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('isConfigured returns true for BOM-prefixed valid JSON (BOM 防御)', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), BOM + JSON.stringify({
      mcp: { godot: { type: 'local', command: ['npx'] } },
    }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(true);
  });

  it('configure preserves existing enabled user-state (reconfigure)', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({
      mcp: { godot: { type: 'local', command: ['old'], enabled: false } },
    }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(config.mcp.godot.enabled).toBe(false);   // 用户旧值保留
    expect(config.mcp.godot.command).toEqual(['npx', 'godot-mcp-enhanced']); // 配置更新
  });

  // C1 (cli-configure-env-field-overwrite): opencode 用 environment 字段(非 env),也必须保留白名单
  it('configure preserves whitelisted user env on reconfigure (C1, environment 字段)', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({
      mcp: {
        godot: {
          type: 'local',
          command: ['old'],
          enabled: true,
          environment: {
            GODOT_PATH: '/old',
            ALLOWED_PROJECT_PATHS: '/projects',
            GODOT_MCP_BRIDGE_PERSISTENT_SECRET: 'true',
            HACKER_INJECTED: 'evil',
          },
        },
      },
    }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/new/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    const env = config.mcp.godot.environment;
    expect(env.GODOT_PATH).toBe('/new/godot');
    expect(env.ALLOWED_PROJECT_PATHS).toBe('/projects');
    expect(env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET).toBe('true');
    expect(env.HACKER_INJECTED).toBeUndefined();
  });

  // ── unconfigure(uninstall 反向操作;非 JsonAdapterBase 的独立实现)──

  it('unconfigure removes mcp.godot, keeps other entries and container', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({
      theme: 'dark',
      mcp: {
        other: { type: 'local', command: ['foo'] },
        godot: { type: 'local', command: ['npx', 'godot-mcp-enhanced'] },
      },
    }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().unconfigure!(TEST_DIR)).toBe(true);
    const config = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(config.mcp.godot).toBeUndefined();
    expect(config.mcp.other).toBeDefined();
    expect(config.theme).toBe('dark');
  });

  it('unconfigure returns false when no godot entry(no-op)', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({ mcp: { other: {} } }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().unconfigure!(TEST_DIR)).toBe(false);
  });
});
