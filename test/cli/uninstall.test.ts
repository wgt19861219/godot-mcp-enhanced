import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// ── os mock(hoisted state,可变 fakeHome):purge 阶段的 homedir() 指向临时目录 ──
const state = vi.hoisted(() => ({ fakeHome: '' }));
vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof import('os')>();
  return { ...actual, homedir: () => state.fakeHome };
});

// 审计写面 mock:单元测试不测审计副作用(真写会经 homedir 落盘)
vi.mock('../../src/cli/audit-helper.js', () => ({
  auditClientRemoved: vi.fn(),
  auditCliProjectWrite: vi.fn(),
}));

// InstanceManager mock:经 hoisted 共享状态驱动(直接 patch 工厂导出的 mock fn 在
// vitest 4.1 模块 mock 下不可靠)。impl 必须是普通 function——vitest 4 的 new mockFn()
// 会把 impl 当构造器调用,箭头函数不可构造直接 TypeError(被 findAliveInstances 的
// try/catch 吞成"无在跑实例",曾致本用例假失败)。默认空列表=无在跑实例。
const mockInstances = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../src/core/instance-manager.js', () => ({
  InstanceManager: vi.fn().mockImplementation(function () {
    return {
      loadFromRegistry: vi.fn().mockResolvedValue(mockInstances.list),
      getStatus: vi.fn().mockReturnValue(mockInstances.list.length > 0 ? 'alive' : 'stale'),
    };
  }),
}));

// ── 客户端适配器 mock(对齐 setup.test.ts 模式;附 unconfigure 反向操作)──
vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(true);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(true);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/gemini-cli.js', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Gemini CLI';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/qwen-code.js', () => ({
  QwenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Qwen Code';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/claude-desktop.js', () => ({
  ClaudeDesktopAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Desktop';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/windsurf.js', () => ({
  WindsurfAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Windsurf';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cline.js', () => ({
  ClineAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cline';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/zed.js', () => ({
  ZedAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Zed';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/antigravity.js', () => ({
  AntigravityAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Antigravity';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/trae.js', () => ({
  TraeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Trae';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cherry-studio.js', () => ({
  CherryStudioAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cherry Studio';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/zcode.js', () => ({
  ZCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'ZCode';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/warp.js', () => ({
  WarpAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Warp';
    this.scope = 'global';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
    this.unconfigure = vi.fn().mockResolvedValue(false);
  }),
}));

// ── fixture ──

const PROJECT_GODOT = [
  'config_version=5',
  '',
  '[application]',
  'config/name="Test"',
  '',
  '[autoload]',
  '',
  'OtherAutoload="*res://other.gd"',
  'MCPBridge="*res://mcp_bridge.gd"',
  'autoload/MCPBridge="*res://mcp_bridge.gd"',
  '',
  '[editor_plugins]',
  '',
  'enabled=PackedStringArray("other_plugin", "godot_mcp_server")',
  '',
  '[godot_mcp]',
  '',
  'editor_port=9090',
  '',
  '[physics]',
  '',
  'some_setting=true',
  '',
].join('\n');

function makeProject(dir: string, opts?: { bridgeScriptContent?: string }): void {
  mkdirSync(join(dir, 'addons', 'godot_mcp_server'), { recursive: true });
  writeFileSync(join(dir, 'addons', 'godot_mcp_server', 'plugin.cfg'), '[plugin]\nname="MCP Server"\nversion="0.0.0"\n');
  writeFileSync(join(dir, 'project.godot'), PROJECT_GODOT);
  if (opts?.bridgeScriptContent !== undefined) {
    writeFileSync(join(dir, 'mcp_bridge.gd'), opts.bridgeScriptContent);
  }
  mkdirSync(join(dir, '.godot'), { recursive: true });
  writeFileSync(join(dir, '.godot', 'mcp_bridge_9081.secret'), 'abc123');
  mkdirSync(join(dir, '.godot', 'mcp-instances'), { recursive: true });
  writeFileSync(join(dir, '.godot', 'mcp-instances', 'ts-123-abc.json'), '{}');
  writeFileSync(join(dir, '.godot', 'mcp-godot.json'), '{"godot_path":"D:/godot"}');
}

/** 包内 bundled bridge 脚本内容(工具自管判定基准;pretest build 后存在于 build/scripts/)。 */
function bundledBridgeContent(): string {
  return readFileSync(resolve(process.cwd(), 'build', 'scripts', 'mcp_bridge.gd'), 'utf-8');
}

describe('uninstall — stripAddonReferences(纯函数)', () => {
  it('移除 bridge autoload 双键,保留其他 autoload', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const r = stripAddonReferences(PROJECT_GODOT);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('OtherAutoload=');
    expect(r.text).not.toContain('MCPBridge=');
    expect(r.text).not.toContain('autoload/MCPBridge=');
  });

  it('editor_plugins 段内 enabled 去掉本工具项,保留其他插件', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const r = stripAddonReferences(PROJECT_GODOT);
    expect(r.text).toContain('enabled=PackedStringArray("other_plugin")');
    expect(r.text).not.toContain('godot_mcp_server');
  });

  it('enabled 匹配 Godot 4 编辑器真实写入的 res:// 路径形式(审查 Important-1)', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const cfg = [
      '[editor_plugins]',
      '',
      'enabled=PackedStringArray("res://addons/other/plugin.cfg", "res://addons/godot_mcp_server/plugin.cfg")',
    ].join('\n');
    const r = stripAddonReferences(cfg);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('enabled=PackedStringArray("res://addons/other/plugin.cfg")');
    expect(r.text).not.toContain('godot_mcp_server');
  });

  it('enabled 只含本工具时清空为 PackedStringArray()(空数组分支)', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const r = stripAddonReferences('[editor_plugins]\n\nenabled=PackedStringArray("godot_mcp_server")\n');
    expect(r.changed).toBe(true);
    expect(r.text).toContain('enabled=PackedStringArray()');
  });

  it('整段删除 [godot_mcp],保留其他段', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const r = stripAddonReferences(PROJECT_GODOT);
    expect(r.text).not.toContain('[godot_mcp]');
    expect(r.text).not.toContain('editor_port');
    expect(r.text).toContain('[physics]');
    expect(r.text).toContain('some_setting=true');
  });

  it('无引用时 changed=false 且文本不变', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const clean = 'config_version=5\n\n[autoload]\n\nOther="*res://o.gd"\n';
    expect(stripAddonReferences(clean)).toEqual({ text: clean, changed: false });
  });

  it('段感知:其他段的 enabled= 行不被误改', async () => {
    const { stripAddonReferences } = await import('../../src/cli/uninstall.js');
    const cfg = '[some_section]\n\nenabled=PackedStringArray("godot_mcp_server")\n';
    expect(stripAddonReferences(cfg).changed).toBe(false);
  });
});

describe('uninstall — runUninstall(命令层)', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-uninstall-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-uninstall-home-'));
    state.fakeHome = fakeHome;
    mockInstances.list = [];
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('非交互且未传 --yes → exit 2 拒绝,零写入', async () => {
    makeProject(testDir);
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // vitest stdin 非 TTY → 确认门自然触发
    await runUninstall(['--project', testDir]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    const out = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('--dry-run');
    expect(out).toContain('--yes');
    // 零写入:项目完整
    expect(existsSync(join(testDir, 'addons', 'godot_mcp_server', 'plugin.cfg'))).toBe(true);
    expect(readFileSync(join(testDir, 'project.godot'), 'utf-8')).toBe(PROJECT_GODOT);
  });

  it('--dry-run:列出将执行的操作,零写入', async () => {
    makeProject(testDir, { bridgeScriptContent: bundledBridgeContent() });
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--dry-run']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('Claude Code: 将移除 godot 注册');
    expect(out).toContain('将清理 project.godot 引用');
    expect(out).toContain('将删除');
    expect(out).toContain('mcp_bridge.gd');
    // 零写入
    expect(existsSync(join(testDir, 'addons', 'godot_mcp_server'))).toBe(true);
    expect(readFileSync(join(testDir, 'project.godot'), 'utf-8')).toBe(PROJECT_GODOT);
    expect(existsSync(join(testDir, '.godot', 'mcp_bridge_9081.secret'))).toBe(true);
  });

  it('--yes:完整清理项目 addon/引用/残留,其他内容保留', async () => {
    makeProject(testDir, { bridgeScriptContent: bundledBridgeContent() });
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('Claude Code: 已移除');
    expect(out).toContain('1 个客户端注册已移除');
    expect(out).toContain('project.godot 引用已清理');
    expect(out).toContain('addons/godot_mcp_server 已删除');
    expect(out).toContain('mcp_bridge.gd 已删除');
    expect(out).toContain('bridge secret 已删除');
    // 审查 Nit-2:审计接线断言——客户端移除写面必须落机器级审计(auditClientRemoved)
    const audit = await import('../../src/cli/audit-helper.js');
    const removedCalls = vi.mocked(audit.auditClientRemoved).mock.calls;
    expect(removedCalls.some(c => c[0] === 'Claude Code')).toBe(true);
    // 文件系统断言
    expect(existsSync(join(testDir, 'addons', 'godot_mcp_server'))).toBe(false);
    expect(existsSync(join(testDir, 'mcp_bridge.gd'))).toBe(false);
    expect(existsSync(join(testDir, 'mcp_bridge.gd.uid'))).toBe(false);
    expect(existsSync(join(testDir, '.godot', 'mcp_bridge_9081.secret'))).toBe(false);
    expect(existsSync(join(testDir, '.godot', 'mcp-instances'))).toBe(false);
    expect(existsSync(join(testDir, '.godot', 'mcp-godot.json'))).toBe(false);
    const after = readFileSync(join(testDir, 'project.godot'), 'utf-8');
    expect(after).toContain('OtherAutoload=');
    expect(after).toContain('enabled=PackedStringArray("other_plugin")');
    expect(after).toContain('some_setting=true');
    expect(after).not.toContain('MCPBridge=');
    expect(after).not.toContain('[godot_mcp]');
  });

  it('用户自管的 mcp_bridge.gd(内容与包内不一致)保留并提示', async () => {
    makeProject(testDir, { bridgeScriptContent: '# user modified locally\n' });
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('用户自管');
    expect(existsSync(join(testDir, 'mcp_bridge.gd'))).toBe(true);
  });

  it('空项目(无 addon 无引用)→ ⊘ 提示,不报错', async () => {
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('未发现项目 addon/引用/残留');
  });

  it('--purge --yes:删除 ~/.godot-mcp/ 共享状态', async () => {
    makeProject(testDir, { bridgeScriptContent: bundledBridgeContent() });
    const stateDir = join(fakeHome, '.godot-mcp');
    mkdirSync(join(stateDir, 'instances'), { recursive: true });
    writeFileSync(join(stateDir, 'godot-paths.json'), '{}');
    writeFileSync(join(stateDir, 'instances', 'x.json'), '{}');
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes', '--purge']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('~/.godot-mcp/ 已删除');
    expect(existsSync(stateDir)).toBe(false);
  });

  it('无 --purge:共享状态保留并提示出口', async () => {
    makeProject(testDir, { bridgeScriptContent: bundledBridgeContent() });
    const stateDir = join(fakeHome, '.godot-mcp');
    mkdirSync(stateDir, { recursive: true });
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('--purge');
    expect(existsSync(stateDir)).toBe(true);
  });

  it('在跑实例警示:alive 实例列名输出', async () => {
    mockInstances.list = [{
      id: 'ts-1-abc', projectPath: 'D:/proj/demo', projectName: 'demo',
      port: 9081, pid: 4242, lastSeen: new Date().toISOString(),
      godotVersion: '4.7.2', capabilities: [],
    }];
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--project', testDir, '--yes']);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('在跑实例');
    expect(out).toContain('D:/proj/demo');
  });
});
