import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process and fs before importing the module under test.
// godot-finder uses execFile (promisified) and existsSync/readdirSync.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { existsSync, readFileSync, statSync } from 'fs';
import {
  clearGodotPathCache,
  getCachedGodotPath,
  findGodot,
  validateGodotBinary,
  isGodotPathAllowed,
} from '../src/core/godot-finder.js';

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(existsSync);
const readFileSyncMock = vi.mocked(readFileSync);
const statSyncMock = vi.mocked(statSync);

beforeEach(() => {
  clearGodotPathCache();
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  statSyncMock.mockReset();
});

// Helper: make execFile return successfully for a given stdout.
function mockExecFileSuccess(stdout) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    // Handle (cmd, args, cb) form and (cmd, args, opts, cb) form
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(null, { stdout, stderr: '' });
    return undefined;
  });
}

function mockExecFileError() {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(new Error('not found'), null);
    return undefined;
  });
}

// ─── clearGodotPathCache / getCachedGodotPath ────────────────────────────────

describe('clearGodotPathCache', () => {
  it('resets cache to null', async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    await findGodot();
    expect(getCachedGodotPath()).toBeTruthy();

    clearGodotPathCache();
    expect(getCachedGodotPath()).toBeNull();
  });
});

describe('getCachedGodotPath', () => {
  it('returns null initially', () => {
    expect(getCachedGodotPath()).toBeNull();
  });
});

// ─── findGodot ───────────────────────────────────────────────────────────────

describe('findGodot', () => {
  it('throws when no godot found anywhere', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('returns GODOT_PATH when valid', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/local/bin/godot4');
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot();
    expect(result).toBe('/usr/local/bin/godot4');
    expect(getCachedGodotPath()).toBe('/usr/local/bin/godot4');
  });

  it('skips GODOT_PATH when file does not exist', async () => {
    vi.stubEnv('GODOT_PATH', '/nonexistent/godot');
    // existsSync returns false for GODOT_PATH, true for nothing else needed
    existsSyncMock.mockReturnValue(false);
    // PATH godot also fails
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('G-CONF (2026-09-01): GODOT_PATH 指向目录 → 显性报错而非静默落入搜索链', async () => {
    // 对标 godot-ai 69ba29f「拒绝指向目录的 GODOT_BIN」:此前目录候选只在 execFile
    // 报错后落 debug 日志,用户只见含混的 "Godot binary not found"(且可能被后续
    // registry/scoop fallback 掩盖配置错误)
    vi.stubEnv('GODOT_PATH', '/opt/godot-dir');
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockImplementation(() => ({ isDirectory: () => true }));

    await expect(findGodot()).rejects.toThrow(/directory, not an executable/);
  });

  it('G-CONF: validateGodotBinary 对目录候选返回 false 且不 spawn', async () => {
    statSyncMock.mockImplementation(() => ({ isDirectory: () => true }));

    await expect(validateGodotBinary('/opt/godot-dir')).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('skips GODOT_PATH when validation fails', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/bin/not-godot');
    // Only GODOT_PATH exists; all other candidates (POSIX paths, etc.) do not
    existsSyncMock.mockImplementation((p) => p === '/usr/bin/not-godot');
    // execFile returns something that is NOT a godot version
    mockExecFileSuccess('some-other-binary 1.0');

    // Will fall through to PATH search (also fails due to mock) then POSIX candidates (all !existsSync)
    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('falls back to PATH godot', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);

    // execFile called with 'godot' succeeds
    mockExecFileSuccess('4.3.stable');

    const result = await findGodot();
    expect(result).toBe('godot');
    expect(getCachedGodotPath()).toBe('godot');
  });

  it('accepts godot --version output containing "Godot"', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('Godot Engine v4.2.1.stable.official');

    const result = await findGodot();
    expect(result).toBe('godot');
  });

  it('caches result and does not re-search on second call', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('4.3.stable');

    const first = await findGodot();
    expect(first).toBe('godot');

    // Reset mock to track second-call count
    execFileMock.mockClear();

    const second = await findGodot();
    expect(second).toBe('godot');

    // execFile should NOT have been called again (cache hit)
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ─── Project-level override tests ──────────────────────────────────────────────

describe('findGodot with projectPath', () => {
  it('reads godot_path from .godot/mcp-godot.json', async () => {
    const projectPath = '/projects/my-game';
    const godotBin = '/opt/godot/Godot_v4.6.3';

    // existsSync: mcp-godot.json exists, godotBin exists
    existsSyncMock.mockImplementation((p) =>
      p === godotBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: 1, godot_path: godotBin }));
    mockExecFileSuccess('Godot v4.6.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(godotBin);
    expect(getCachedGodotPath(projectPath)).toBe(godotBin);
  });

  it('reads godot_path from project.godot [godot_mcp] section', async () => {
    const projectPath = '/projects/my-game';
    const godotBin = '/opt/godot/Godot_v4.5';

    existsSyncMock.mockImplementation((p) =>
      p === godotBin || p.endsWith('project.godot')
    );
    // mcp-godot.json does NOT exist, but project.godot does
    readFileSyncMock.mockReturnValue(
      '[application]\nconfig/name="Test"\n\n[godot_mcp]\ngodot_path=/opt/godot/Godot_v4.5\n'
    );
    mockExecFileSuccess('Godot v4.5');

    const result = await findGodot(projectPath);
    expect(result).toBe(godotBin);
  });

  it('mcp-godot.json takes priority over project.godot', async () => {
    const projectPath = '/projects/my-game';
    const mcpBin = '/opt/godot/Godot_mcp';
    const pgBin = '/opt/godot/Godot_pg';

    existsSyncMock.mockImplementation((p) =>
      p === mcpBin || p.endsWith('mcp-godot.json') || p.endsWith('project.godot')
    );
    let readCount = 0;
    readFileSyncMock.mockImplementation(() => {
      readCount++;
      if (readCount === 1) return JSON.stringify({ godot_path: mcpBin });
      return `[godot_mcp]\ngodot_path=${pgBin}\n`;
    });
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(mcpBin);
  });

  it('project config takes priority over GODOT_PATH env', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(projectBin);
  });

  it('falls back to GODOT_PATH when project config has no godot_path', async () => {
    const projectPath = '/projects/my-game';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    // mcp-godot.json exists but has no godot_path
    existsSyncMock.mockImplementation((p) =>
      p === envBin || p.endsWith('mcp-godot.json') || p.endsWith('project.godot')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: 1 }));
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(envBin);
  });

  it('gracefully handles invalid mcp-godot.json', async () => {
    const projectPath = '/projects/my-game';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) =>
      p === envBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue('not valid json {{{');
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(envBin); // falls back to env var
  });

  it('per-project cache is independent from global cache', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const globalBin = '/opt/godot/Global';

    // First: resolve for project
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    const projectResult = await findGodot(projectPath);
    expect(projectResult).toBe(projectBin);

    // Second: resolve globally (different path)
    vi.stubEnv('GODOT_PATH', globalBin);
    existsSyncMock.mockImplementation((p) => p === globalBin);
    const globalResult = await findGodot();
    expect(globalResult).toBe(globalBin);

    // Both caches are independent
    expect(getCachedGodotPath(projectPath)).toBe(projectBin);
    expect(getCachedGodotPath()).toBe(globalBin);
  });

  it('clearGodotPathCache(projectPath) only clears that project', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    // Setup project cache
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    await findGodot(projectPath);

    // Setup global cache
    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) => p === envBin);
    await findGodot();

    // Clear only project cache
    clearGodotPathCache(projectPath);
    expect(getCachedGodotPath(projectPath)).toBeNull();
    expect(getCachedGodotPath()).toBe(envBin); // global still cached
  });

  it('clearGodotPathCache() without args clears all caches', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    await findGodot(projectPath);

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) => p === envBin);
    await findGodot();

    // Clear all
    clearGodotPathCache();
    expect(getCachedGodotPath(projectPath)).toBeNull();
    expect(getCachedGodotPath()).toBeNull();
  });

  it('error message suggests project config when projectPath is given', async () => {
    const projectPath = '/projects/my-game';

    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue('');
    mockExecFileError();

    await expect(findGodot(projectPath)).rejects.toThrow('mcp-godot.json');
  });

  it('error message does NOT mention project config without projectPath', async () => {
    existsSyncMock.mockReturnValue(false);
    mockExecFileError();

    await expect(findGodot()).rejects.not.toThrow('mcp-godot.json');
  });
});

// ─── validateGodotBinary (C-SEC-2: 收紧弱校验防 RCE) ─────────────────────────

describe('validateGodotBinary', () => {
  // C-SEC-2: 旧校验 stdout.includes('godot') || /^\d+\.\d+/ 过于宽松——
  // 任何打印 "4.6" 的二进制即通过,经 godot_path override 被 spawn 执行(RCE)。
  // 收紧后:裸两段版本号(无 godot 关键字、无三段、无状态后缀)必须被拒绝。

  it('rejects bare two-part version (C-SEC-2 attack payload)', async () => {
    mockExecFileSuccess('4.6');
    expect(await validateGodotBinary('/fake/godot-evil.exe')).toBe(false);
  });

  it('rejects arbitrary output with no godot signature', async () => {
    mockExecFileSuccess('some-other-binary 1.0');
    expect(await validateGodotBinary('/fake/godot-evil.exe')).toBe(false);
  });

  it('rejects bare godot keyword without version number', async () => {
    mockExecFileSuccess('godot');
    expect(await validateGodotBinary('/fake/godot.exe')).toBe(false);
  });

  it('accepts Godot keyword + major.minor version', async () => {
    mockExecFileSuccess('Godot v4.3');
    expect(await validateGodotBinary('/real/godot.exe')).toBe(true);
  });

  it('accepts bare version + Godot status suffix (4.3.stable)', async () => {
    mockExecFileSuccess('4.3.stable');
    expect(await validateGodotBinary('/real/godot.exe')).toBe(true);
  });

  it('accepts full Godot stable output', async () => {
    mockExecFileSuccess('Godot Engine v4.2.1.stable.official');
    expect(await validateGodotBinary('/real/godot.exe')).toBe(true);
  });

  // 2026-10-01 加固:spawn 固定 cwd 临时目录——候选为 cmd.exe 等外壳时,`--version`
  // 会在继承的 server CWD 留副作用目录(实证:cmd.exe 于仓库根建 --version/ 与 .exe/)。
  it('spawn 传 cwd=系统临时目录(不在 server CWD 留副作用)', async () => {
    mockExecFileSuccess('Godot v4.3');
    await validateGodotBinary('/real/godot.exe');
    const opts = execFileMock.mock.calls.at(-1)?.[2];
    expect(opts?.cwd).toBe(tmpdir());
  });

  it('accepts three-part semantic version', async () => {
    mockExecFileSuccess('4.6.3');
    expect(await validateGodotBinary('/real/godot.exe')).toBe(true);
  });

  it('returns false on exec error', async () => {
    mockExecFileError();
    expect(await validateGodotBinary('/fake/godot.exe')).toBe(false);
  });
});

// ─── detectGodotVersion(template-check Task1)──────────────────────────────────

describe('detectGodotVersion', () => {
  it('返回 --version stdout(trim)', async () => {
    mockExecFileSuccess('4.6.2.stable\n');
    const { detectGodotVersion } = await import('../src/core/godot-finder.js');
    const v = await detectGodotVersion('/fake/godot');
    expect(v).toBe('4.6.2.stable');
  });

  it('非 Godot 签名 → throw(Invalid signature)', async () => {
    mockExecFileSuccess('not a godot binary\n');
    const { detectGodotVersion } = await import('../src/core/godot-finder.js');
    await expect(detectGodotVersion('/fake/godot')).rejects.toThrow(/Invalid Godot version signature/);
  });

  it('非零退出(execFile 抛)→ throw(godot --version failed)', async () => {
    mockExecFileError();
    const { detectGodotVersion } = await import('../src/core/godot-finder.js');
    await expect(detectGodotVersion('/fake/godot')).rejects.toThrow(/godot --version failed/);
  });
});

// ─── isGodotPathAllowed / GODOT_MCP_ALLOWED_GODOT_PATHS (A-RCE #4) ───────────
//
// Task 4 (ADVISORY): godot_path 白名单。签名校验(isGodotVersionSignature)之上的
// 硬隔离——防 AI 可控的 godot_path 工具参数/project override/env 指向任意二进制被 spawn。
// 注意:test/setup.js:6 全局设 GODOT_MCP_UNRESTRICTED=true,本 describe 用 beforeEach
// 显式清空才能测白名单逻辑(否则恒 true 平凡通过)。

describe('GODOT_MCP_ALLOWED_GODOT_PATHS', () => {
  beforeEach(() => {
    vi.stubEnv('GODOT_MCP_ALLOWED_GODOT_PATHS', '');
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', '');
    // 批 2:白名单优先级链在 env 未设时读真实 ~/.godot-mcp/godot-paths.json——
    // 本文件 mock 了 fs,当前不会真读到;但为防 mock 移除后静默变环境依赖
    // (跑过 CLI install 的机器 config 非空),HOME 一并隔离到空临时目录(审查 I-2 防御)。
    const { tmpdir } = require('os');
    vi.stubEnv('HOME', tmpdir());
    vi.stubEnv('USERPROFILE', tmpdir());
  });

  it('when set, rejects godot path outside whitelist', () => {
    vi.stubEnv('GODOT_MCP_ALLOWED_GODOT_PATHS', 'C:\\Godot\\bin;D:\\godot');
    expect(isGodotPathAllowed('C:\\malware\\fake-godot.exe')).toBe(false);
  });

  it('when set, allows whitelisted path (realpath normalized)', () => {
    const os = require('os');
    const path = require('path');
    const tmpDir = os.tmpdir();
    vi.stubEnv('GODOT_MCP_ALLOWED_GODOT_PATHS', path.join(tmpDir, 'godot'));
    expect(isGodotPathAllowed(path.join(tmpDir, 'godot', 'godot.exe'))).toBe(true);
  });

  it('when unset (empty), allows any (back-compat,签名校验仍兜底)', () => {
    expect(isGodotPathAllowed('C:\\any\\godot.exe')).toBe(true);
  });

  it('UNRESTRICTED=true bypasses', () => {
    vi.stubEnv('GODOT_MCP_ALLOWED_GODOT_PATHS', 'D:\\only');
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', 'true');
    expect(isGodotPathAllowed('C:\\other')).toBe(true);
  });
});
