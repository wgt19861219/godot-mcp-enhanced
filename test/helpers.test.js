import { expect, describe, it, beforeEach, afterEach, afterAll } from 'vitest';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { validatePath, resolveWithinRoot, normalizeUserProjectPath, isPathInAllowedRoots, allowOutsideProjectPaths } from '../src/core/path-utils.js';
import { ensureDir } from '../src/core/fs-atomic.js';
import { parseConfigValue } from '../src/core/config-parser.js';
import { buildSafeEnv } from '../src/core/godot-finder.js';
import { isolatePathEnv } from './helpers/path-isolation.js';
import { getLogger, resetLogger } from '../src/core/logger.js';

// I-01: Reset logger singleton between tests to prevent state leakage
afterEach(() => { resetLogger(); });

describe('validatePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = validatePath('some/relative/path');
    expect(result).toBe(resolve('some/relative/path'));
  });

  it('passes through absolute paths unchanged', () => {
    const abs = resolve('/tmp/test');
    expect(validatePath(abs)).toBe(abs);
  });
});

describe('resolveWithinRoot', () => {
  const root = resolve('/tmp/test-project');

  it('resolves a simple relative path within root', () => {
    const result = resolveWithinRoot(root, 'scripts/player.gd');
    expect(result).toBe(resolve(root, 'scripts/player.gd'));
  });

  it('rejects parent traversal with ..', () => {
    expect(() => resolveWithinRoot(root, '../../../etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects absolute path outside root', () => {
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('accepts paths after stripping res:// prefix', () => {
    const result = resolveWithinRoot(root, 'res://scenes/main.tscn'.replace('res://', ''));
    expect(result.startsWith(root)).toBe(true);
  });

  it('handles deep relative paths within root', () => {
    const result = resolveWithinRoot(root, 'a/b/c/d/file.gd');
    expect(result.startsWith(root + sep)).toBe(true);
  });

  it('rejects path with .. on Windows-style traversal', () => {
    expect(() => resolveWithinRoot(root, '..\\..\\etc\\passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects mixed slash traversal', () => {
    expect(() => resolveWithinRoot(root, 'valid/../../etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects UNC paths', () => {
    expect(() => resolveWithinRoot(root, '\\\\evil-server\\share\\passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects Windows device name CON', () => {
    expect(() => resolveWithinRoot(root, 'CON')).toThrow(/Path traversal detected/);
  });

  it('rejects Windows device name AUX.txt', () => {
    expect(() => resolveWithinRoot(root, 'AUX.txt')).toThrow(/Path traversal detected/);
  });

  it('rejects Windows device name COM1', () => {
    expect(() => resolveWithinRoot(root, 'COM1')).toThrow(/Path traversal detected/);
  });

  it('rejects Windows device name in nested path', () => {
    expect(() => resolveWithinRoot(root, 'scripts/NUL.gd')).toThrow(/Path traversal detected/);
  });

  it('rejects double-encoded traversal', () => {
    expect(() => resolveWithinRoot(root, '%2e%2e/etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects triple-encoded traversal', () => {
    expect(() => resolveWithinRoot(root, '%252e%252e/etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('allows normal files with no traversal', () => {
    const result = resolveWithinRoot(root, 'scenes/main.tscn');
    expect(result.startsWith(root)).toBe(true);
  });
});

describe('ensureDir', () => {
  const testBase = resolve('/tmp/godot-mcp-test-ensuredir');

  it('creates parent directories if missing', () => {
    const target = `${testBase}/a/b/c/file.gd`;
    ensureDir(target);
    expect(existsSync(`${testBase}/a/b/c`)).toBeTruthy();
    // cleanup
    rmSync(testBase, { recursive: true, force: true });
  });

  it('does not throw when directory already exists', () => {
    mkdirSync(`${testBase}/existing`, { recursive: true });
    writeFileSync(`${testBase}/existing/file.txt`, 'test');
    expect(() => ensureDir(`${testBase}/existing/other.txt`)).not.toThrow();
    rmSync(testBase, { recursive: true, force: true });
  });
});

describe('normalizeUserProjectPath', () => {
  it('strips res:// prefix', () => {
    expect(normalizeUserProjectPath('res://scenes/main.tscn')).toBe('scenes/main.tscn');
  });

  it('returns plain relative path unchanged', () => {
    expect(normalizeUserProjectPath('assets/ui')).toBe('assets/ui');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeUserProjectPath('')).toBe('');
    expect(normalizeUserProjectPath(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(normalizeUserProjectPath(null)).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeUserProjectPath('   ')).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeUserProjectPath('  res://foo  ')).toBe('foo');
  });

  it('does not strip nested res:// in path body', () => {
    expect(normalizeUserProjectPath('res://res://foo')).toBe('res://foo');
  });
});

// ─── parseConfigValue ──────────────────────────────────────────────────────────

describe('parseConfigValue (I-06)', () => {
  it('parses integers', () => {
    expect(parseConfigValue('42')).toBe(42);
  });

  it('parses floats', () => {
    expect(parseConfigValue('3.14')).toBe(3.14);
  });

  it('parses negative numbers', () => {
    expect(parseConfigValue('-1')).toBe(-1);
  });

  it('parses zero', () => {
    expect(parseConfigValue('0')).toBe(0);
  });

  it('returns string for non-numeric text', () => {
    expect(parseConfigValue('hello')).toBe('hello');
  });

  it('returns string for whitespace-only input (I-06 fix)', () => {
    expect(parseConfigValue(' ')).toBe(' ');
    expect(parseConfigValue('  ')).toBe('  ');
    expect(parseConfigValue('\t')).toBe('\t');
  });

  it('parses booleans', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('false')).toBe(false);
  });

  it('parses null', () => {
    expect(parseConfigValue('null')).toBe(null);
  });

  it('strips double quotes', () => {
    expect(parseConfigValue('"hello"')).toBe('hello');
  });

  it('parses empty array', () => {
    expect(parseConfigValue('[]')).toEqual([]);
  });
});

// ─── allowOutsideProjectPaths ──────────────────────────────────────────────

describe('allowOutsideProjectPaths', () => {
  let restore = () => {};

  beforeEach(() => {
    restore = isolatePathEnv();   // 清 UNRESTRICTED + 删 ALLOWED + reset
  });
  afterEach(() => restore());

  it('should return true when GODOT_MCP_UNRESTRICTED=true', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect(allowOutsideProjectPaths()).toBe(true);
  });

  it('should return true when ALLOWED_PROJECT_PATHS is configured', () => {
    process.env.ALLOWED_PROJECT_PATHS = '/tmp';
    expect(allowOutsideProjectPaths()).toBe(true);
  });

  it('should return false when nothing is configured', () => {
    expect(allowOutsideProjectPaths()).toBe(false);
  });

  it('should return false when ALLOWED_PROJECT_PATHS is empty string', () => {
    process.env.ALLOWED_PROJECT_PATHS = '';
    expect(allowOutsideProjectPaths()).toBe(false);
  });
});

// ─── isPathInAllowedRoots ──────────────────────────────────────────────────

describe('isPathInAllowedRoots', () => {
  let restore = () => {};

  beforeEach(() => {
    restore = isolatePathEnv();   // 清 UNRESTRICTED + 删 ALLOWED + reset
  });
  afterEach(() => restore());

  it('should allow all paths when GODOT_MCP_UNRESTRICTED=true', () => {
    // C-07: deny-by-default — unrestricted flag is the only way to allow all paths
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect(isPathInAllowedRoots('/definitely/outside/path')).toBe(true);
    expect(isPathInAllowedRoots('/any/other/path')).toBe(true);
    process.env.GODOT_MCP_UNRESTRICTED = undefined;
  });

  it('should restrict to cwd when no whitelist set (deny-by-default)', () => {
    // C-07: deny-by-default — all unconfigured environments restrict to cwd
    expect(isPathInAllowedRoots(process.cwd())).toBe(true);
    expect(isPathInAllowedRoots('/definitely/outside/path')).toBe(false);
  });

  it('should allow GODOT_MCP_UNRESTRICTED to bypass', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect(isPathInAllowedRoots('/any/path')).toBe(true);
  });

  it('should respect ALLOWED_PROJECT_PATHS whitelist', () => {
    const tmp = tmpdir();
    process.env.ALLOWED_PROJECT_PATHS = tmp;
    expect(isPathInAllowedRoots(tmp)).toBe(true);
    expect(isPathInAllowedRoots('/not/in/whitelist')).toBe(false);
  });

  it('should allow subdirectories of whitelisted paths', () => {
    const tmp = tmpdir();
    process.env.ALLOWED_PROJECT_PATHS = tmp;
    expect(isPathInAllowedRoots(resolve(tmp, 'subdir'))).toBe(true);
  });

  it('should log warning only once when no whitelist set', () => {
    // In test environment (non-TTY, no CI env), the code uses warn level
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    isPathInAllowedRoots('/a');
    isPathInAllowedRoots('/b');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toContain('ALLOWED_PROJECT_PATHS not configured');
    warnSpy.mockRestore();
  });

  it('should support semicolon-separated multiple paths in whitelist', () => {
    const tmp = tmpdir();
    const alt = resolve(tmp, 'alt');
    mkdirSync(alt, { recursive: true });
    process.env.ALLOWED_PROJECT_PATHS = `${tmp};${alt}`;
    expect(isPathInAllowedRoots(tmp)).toBe(true);
    expect(isPathInAllowedRoots(alt)).toBe(true);
    expect(isPathInAllowedRoots('/not/in/either')).toBe(false);
  });

  it('should handle trailing semicolons in whitelist gracefully', () => {
    const tmp = tmpdir();
    process.env.ALLOWED_PROJECT_PATHS = `${tmp};`;
    expect(isPathInAllowedRoots(tmp)).toBe(true);
    expect(isPathInAllowedRoots('/not/in/whitelist')).toBe(false);
  });
});

// ─── buildSafeEnv ──────────────────────────────────────────────────────────

describe('buildSafeEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // 隔离 env:复制一份再改,不污染其他测试
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('透传 GODOT_MCP_BRIDGE_* env 给 godot 子进程(S4/S5 GDScript 修复依赖)', () => {
    // mcp_bridge.gd 读这两个 env 启用 PERSISTENT_SECRET 复用 / EXTRA_METHODS 白名单扩展。
    // 若 buildSafeEnv 截断,spawn 出的 godot 进程读不到,GDScript 修复永远不触发。
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
    process.env.GODOT_MCP_BRIDGE_EXTRA_METHODS = 'emit_signal';
    const env = buildSafeEnv();
    expect(env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET).toBe('true');
    expect(env.GODOT_MCP_BRIDGE_EXTRA_METHODS).toBe('emit_signal');
  });

  it('透传 GODOT_MCP_EDITOR_* env 给 editor 子进程(S4-editor GDScript 修复依赖)', () => {
    // websocket_server.gd 读这个 env 启用 PERSISTENT_SECRET 复用。launch_editor
    // (runtime.ts:128)用 buildSafeEnv spawn 编辑器,若截断则 editor plugin
    // OS.get_environment() 读不到,PERSISTENT 永不触发。对称 BRIDGE_(见上测)。
    process.env.GODOT_MCP_EDITOR_PERSISTENT_SECRET = 'true';
    const env = buildSafeEnv();
    expect(env.GODOT_MCP_EDITOR_PERSISTENT_SECRET).toBe('true');
  });

  it('透传 GODOT_MCP_BRIDGE_*/EDITOR_* 子命名空间,但不透传服务端安全开关', () => {
    // 边界:只透传 mcp_bridge.gd/websocket_server.gd 运行时配置(BRIDGE_/EDITOR_ 子前缀);
    // 服务端安全开关(UNRESTRICTED/ALLOW_UNSAFE 等)必须隔离 —— 子进程不能自行解锁路径/沙箱限制。
    process.env.GODOT_MCP_BRIDGE_FUTURE_FLAG = '1';
    process.env.GODOT_MCP_EDITOR_PERSISTENT_SECRET = 'true';
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    process.env.GODOT_MCP_ALLOW_UNSAFE = 'true';
    const env = buildSafeEnv();
    expect(env.GODOT_MCP_BRIDGE_FUTURE_FLAG).toBe('1');
    expect(env.GODOT_MCP_EDITOR_PERSISTENT_SECRET).toBe('true');
    expect(env.GODOT_MCP_UNRESTRICTED).toBeUndefined();
    expect(env.GODOT_MCP_ALLOW_UNSAFE).toBeUndefined();
  });

  it('仍 strip 非 GODOT_MCP_* 凭据 env(I-04 安全不退化)', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'leak-me';
    process.env.DATABASE_URL = 'postgres://user:pass@host';
    process.env.MY_CUSTOM_TOKEN = 'leak-me';
    const env = buildSafeEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MY_CUSTOM_TOKEN).toBeUndefined();
  });

  it('仍保留 Godot 运行必需 env(PATH/HOME 等)', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/user';
    const env = buildSafeEnv();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
  });

  it('透传 XAUTHORITY 给 godot 子进程(xvfb-run 下 X11 认证依赖)', () => {
    // DISPLAY 的配对凭证文件。缺它 CI xvfb-run(如 matrix job L2)spawn 的 Godot 游戏
    // 无法认证 X 连接 → 进程秒退 → bridge 永不就绪(2026-08-15 run#122 平台债根因 ③)。
    process.env.DISPLAY = ':99';
    process.env.XAUTHORITY = '/tmp/xvfb-run.XXXX/Xauthority';
    const env = buildSafeEnv();
    expect(env.DISPLAY).toBe(':99');
    expect(env.XAUTHORITY).toBe('/tmp/xvfb-run.XXXX/Xauthority');
  });
});
