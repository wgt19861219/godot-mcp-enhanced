import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/self-update.js';
import { GODOT_MCP_RULES } from '../src/tools/claudemd-builder.js';
import { hashContent } from '../src/tools/rules-manifest.js';
import { _resetPathAllowWarned } from '../src/core/path-utils.js';
import { isReadOnly } from '../src/core/tool-registry.js';
import { registerAllModules } from '../src/module-loader.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkgVersion: string = require('../package.json').version;

// 注册所有工具模块（isReadOnly 锚点需要工具已注册到 registry）
registerAllModules();

const anyCtx = {} as any;
let tmpProject: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GODOT_MCP_UNRESTRICTED = 'true';
  _resetPathAllowWarned();
  tmpProject = mkdtempSync(join(tmpdir(), 'su-'));
  writeFileSync(join(tmpProject, 'project.godot'), '');  // validateProjectRoot 需要
});
afterEach(() => {
  delete process.env.GODOT_MCP_UNRESTRICTED;
  _resetPathAllowWarned();
  rmSync(tmpProject, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('getToolDefinitions', () => {
  it('工具名 self_update + action enum', () => {
    const def = getToolDefinitions()[0];
    expect(def.name).toBe('self_update');
    expect((def.inputSchema as any).properties.action.enum).toEqual(['check', 'update']);
    expect((def.inputSchema as any).required).toEqual(['action']);
  });
});

describe('TOOL_META', () => {
  it('check=read / update=write', () => {
    expect(TOOL_META.self_update.actionRisks.check).toBe('read');
    expect(TOOL_META.self_update.actionRisks.update).toBe('write');
  });
});

function parse(r: any) { return JSON.parse(r.content[0].text); }

describe('handleTool check', () => {
  it('返回 npm + addons 结构，project_path 指定只查该个', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.24.0' }) }));
    mkdirSync(join(tmpProject, 'addons', 'godot_mcp_server'), { recursive: true });
    writeFileSync(join(tmpProject, 'addons', 'godot_mcp_server', 'plugin.cfg'),
      '[plugin]\nversion="0.22.0"\nscript="plugin.gd"');
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(true);
    expect(parsed.data.npm.latest).toBe('0.24.0');
    expect(parsed.data.addons[0]).toMatchObject({
      project_path: tmpProject, installed_version: '0.22.0', installed: true, matches: false,
    });
  });

  it('未安装 addon → installed:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.24.0' }) }));
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.addons[0].installed).toBe(false);
    expect(parsed.data.addons[0].installed_version).toBeNull();
  });
});

describe('handleTool update', () => {
  it('降级拒绝（installed > 包版本）', async () => {
    mkdirSync(join(tmpProject, 'addons', 'godot_mcp_server'), { recursive: true });
    writeFileSync(join(tmpProject, 'addons', 'godot_mcp_server', 'plugin.cfg'),
      '[plugin]\nversion="9.9.9"\nscript="plugin.gd"');
    const r = await handleTool('self_update', { action: 'update', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('DOWNGRADE_REFUSED');
  });

  it('null 分支（未安装）直 cp', async () => {
    const r = await handleTool('self_update', { action: 'update', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(true);
    expect(parsed.data.updated_from).toBeNull();
    expect(parsed.data.verifyOk).toBe(true);
  });

  it('缺 project_path 报 INVALID_PARAMS', async () => {
    const r = await handleTool('self_update', { action: 'update' }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  it('未知 action 报 UNKNOWN_ACTION', async () => {
    const r = await handleTool('self_update', { action: 'bogus' }, anyCtx);
    const parsed = parse(r);
    expect(parsed.error_code).toBe('UNKNOWN_ACTION');
  });

  it('正常升级分支（installed < pkgVersion）→ updated_from/to 正确', async () => {
    // 造 plugin.cfg version="0.22.0"（< pkgVersion 0.23.0），compareVersion 不拒绝
    mkdirSync(join(tmpProject, 'addons', 'godot_mcp_server'), { recursive: true });
    writeFileSync(join(tmpProject, 'addons', 'godot_mcp_server', 'plugin.cfg'),
      `[plugin]\n\nname="MCP Server"\nversion="0.22.0"\nscript="plugin.gd"`);
    const r = await handleTool('self_update', { action: 'update', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(true);
    expect(parsed.data.updated_from).toBe('0.22.0');
    expect(parsed.data.updated_to).toBe(pkgVersion);
    expect(parsed.data.verifyOk).toBe(true);
  });

  it('readAddonVersion throw 时返 PATH_NOT_ALLOWED（I-1，不冒泡 -32603）', async () => {
    // 验证 handleUpdate 对 readAddonVersion 的调用包了 try/catch，
    // throw 时返结构化错误（AI 可见），而非让 ToolDispatcher re-throw 成 MCP -32603 generic error
    const addonVersion = await import('../src/core/addon-version.js');
    const spy = vi.spyOn(addonVersion, 'readAddonVersion').mockImplementation(() => {
      throw new Error('不在白名单');
    });
    try {
      const r = await handleTool('self_update',
        { action: 'update', project_path: '/nonexistent' }, anyCtx);
      const parsed = parse(r);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
      expect(parsed.error).toContain('不在白名单');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('handleTool check hint（M7）', () => {
  it('无 project_path 且未配置 ALLOWED_PROJECT_PATHS 时返 hint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.24.0' }) }));
    const savedAllowed = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.ALLOWED_PROJECT_PATHS;
    try {
      const r = await handleTool('self_update', { action: 'check' }, anyCtx);
      const parsed = parse(r);
      expect(parsed.success).toBe(true);
      expect(parsed.data.addons).toEqual([]);
      expect(typeof parsed.data.hint).toBe('string');
      expect(parsed.data.hint).toMatch(/ALLOWED_PROJECT_PATHS/);
    } finally {
      if (savedAllowed !== undefined) process.env.ALLOWED_PROJECT_PATHS = savedAllowed;
    }
  });

  it('传 project_path 时不返 hint（即便 allowed 为空也走单项目分支）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.24.0' }) }));
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.success).toBe(true);
    expect(parsed.data.hint).toBeUndefined();
  });
});

describe('self_update 注册 + readOnly 锚点', () => {
  it('isReadOnly(self_update)===false（未误标 readonly:true，避免 update 绕过 readOnly 保护）', () => {
    expect(isReadOnly('self_update')).toBe(false);
  });
});

// ─── P1-3（2026-10-24 可靠性批）：check 的规则分发状态巡检 ──

describe('handleTool check — rules 分发状态三态 + 毒化检测', () => {
  const tplContent = GODOT_MCP_RULES.replace(/\{\{MCP_VERSION\}\}/g, pkgVersion);

  /** 造 fixture：.claude/rules/godot-mcp.md + manifest（给定安装版本与文件内容） */
  function makeRulesFixture(installedVersion: string, fileContent: string): void {
    mkdirSync(join(tmpProject, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(tmpProject, '.claude', 'rules', 'godot-mcp.md'), fileContent);
    writeFileSync(join(tmpProject, '.claude', 'rules', '.godot-mcp-manifest.json'), JSON.stringify({
      manifest_version: 1,
      rules_installed_at_version: installedVersion,
      installed_at: '2026-10-24T00:00:00Z',
      rules: { 'godot-mcp.md': { source: 'base', hash: hashContent(fileContent) } },
    }));
  }

  it('版本同 + 内容指纹一致 → current', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    makeRulesFixture(pkgVersion, tplContent);
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.rules[0].status).toBe('current');
    expect(parsed.data.rules[0].installed_version).toBe(pkgVersion);
  });

  it('manifest 版本旧 → stale', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    makeRulesFixture('0.35.0', tplContent);
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.rules[0].status).toBe('stale');
  });

  it('版本行同但内容指纹不符 → content-drift（毒化检测）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    // 复现毒化形态：manifest 版本行 = 当前版本，但安装内容是旧模板（磁盘与 manifest 一致 → 用户未动过）
    makeRulesFixture(pkgVersion, '0.36.0 旧模板内容');
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.rules[0].status).toBe('content-drift');
  });

  it('无 manifest → missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.rules[0].status).toBe('missing');
  });

  it('审查 Important-1:manifest 记录的文件部分缺失 → missing(不误报 current)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    // fixture:manifest 记录 2 个文件,磁盘只留 1 个
    mkdirSync(join(tmpProject, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(tmpProject, '.claude', 'rules', 'godot-mcp.md'), tplContent);
    writeFileSync(join(tmpProject, '.claude', 'rules', '.godot-mcp-manifest.json'), JSON.stringify({
      manifest_version: 1,
      rules_installed_at_version: pkgVersion,
      installed_at: '2026-10-24T00:00:00Z',
      rules: {
        'godot-mcp.md': { source: 'base', hash: hashContent(tplContent) },
        'core.md': { source: 'detail', hash: hashContent('x') },
      },
    }));
    const r = await handleTool('self_update', { action: 'check', project_path: tmpProject }, anyCtx);
    const parsed = parse(r);
    expect(parsed.data.rules[0].status).toBe('missing');
    expect(parsed.data.rules[0].detail).toContain('部分缺失');
  });

  it('审查 Important-2:显式 project_path 白名单外 → error 记录(防文件系统结构探测)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.36.1' }) }));
    const savedUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
    const savedAllowed = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    process.env.ALLOWED_PROJECT_PATHS = tmpProject;  // 只放行 tmpProject
    try {
      const outside = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        const r = await handleTool('self_update', { action: 'check', project_path: outside }, anyCtx);
        const parsed = parse(r);
        expect(parsed.data.rules[0].status).toBe('missing');
        expect(parsed.data.rules[0].error).toContain('白名单');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      process.env.GODOT_MCP_UNRESTRICTED = savedUnrestricted;
      if (savedAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
      else process.env.ALLOWED_PROJECT_PATHS = savedAllowed;
    }
  });
});
