import { expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveWithinRoot } from '../src/core/path-utils.js';
import { isPathInAllowedRoots } from '../src/core/path-utils.js';
import { isolatePathEnv } from './helpers/path-isolation.js';
import { sanitizeResPath, gdEscape } from '../src/tools/shared.js';

// ─── sanitizeResPath ──────────────────────────────────────────────────────────

describe('sanitizeResPath', () => {
  it('accepts valid res:// path', () => {
    expect(sanitizeResPath('res://scenes/main.tscn', 'path')).toBe('res://scenes/main.tscn');
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeResPath(123, 'path')).toThrow(/must be a string/);
    expect(() => sanitizeResPath(null, 'path')).toThrow(/must be a string/);
  });

  it('rejects missing res:// prefix', () => {
    expect(() => sanitizeResPath('scenes/main.tscn', 'path')).toThrow(/must be a string starting with res:\/\//);
  });

  it('blocks single-encoded traversal (%2e%2e)', () => {
    expect(() => sanitizeResPath('res://scenes/%2e%2e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks double-encoded traversal (%252e)', () => {
    expect(() => sanitizeResPath('res://scenes/%252e%252e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks triple-encoded traversal (%25252e)', () => {
    expect(() => sanitizeResPath('res://scenes/%25252e%25252e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks backslash traversal', () => {
    expect(() => sanitizeResPath('res://scenes\\..\\secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('accepts encoded spaces in legitimate path', () => {
    expect(sanitizeResPath('res://assets/my%20file.png', 'path')).toBe('res://assets/my file.png');
  });

  it('accepts unicode in path', () => {
    expect(sanitizeResPath('res://素材/图片.png', 'path')).toBe('res://素材/图片.png');
  });

  it('accepts res:// root path', () => {
    expect(sanitizeResPath('res://', 'path')).toBe('res://');
  });

  it('blocks suffix traversal (res://scenes/..)', () => {
    expect(() => sanitizeResPath('res://scenes/..', 'path')).toThrow(/path traversal/);
  });
});

// ─── resolveWithinRoot iterative decoding ──────────────────────────────────────

describe('resolveWithinRoot iterative decoding', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-security-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks double-encoded traversal (%252e%252e)', () => {
    // %252e%252e → %2e%2e → .. → escapes root
    expect(() => resolveWithinRoot(root, '%252e%252e/secret.txt')).toThrow(/traversal/i);
  });

  it('blocks triple-encoded traversal (%25252e%25252e)', () => {
    expect(() => resolveWithinRoot(root, '%25252e%25252e/secret.txt')).toThrow(/traversal/i);
  });

  it('blocks percent-encoded parent traversal', () => {
    expect(() => resolveWithinRoot(root, '%2e%2e/secret.txt')).toThrow(/traversal/i);
  });

  it('resolves encoded spaces in legitimate path', () => {
    // Just verifying no throw for a legit encoded path
    // The actual resolved path may not exist, but traversal check should pass
    const result = resolveWithinRoot(root, 'my%20file.txt');
    expect(result).toContain('my file.txt');
  });

  it('does NOT reject filenames containing ".." (F-4: segment-level match, not substring)', () => {
    // 旧 includes('..') 子串匹配会误拒含 ".." 的合法文件名;段级匹配只拒整段为 ".." 的遍历
    for (const p of ['my..file.txt', 'foo/..bar.png', '..hidden.txt']) {
      try {
        resolveWithinRoot(root, p);
      } catch (e) {
        // 文件可能不存在抛 ENOENT,但绝不能被误判为 path traversal
        expect(e.message).not.toMatch(/traversal/i);
      }
    }
  });
});

// ─── gdEscape edge cases ──────────────────────────────────────────────────────

describe('gdEscape edge cases', () => {
  it('escapes standalone CR (\\r without \\n)', () => {
    // \r alone becomes \n (normalized to LF, then escaped as \\n)
    expect(gdEscape('hello\rworld')).toBe('hello\\nworld');
  });

  it('handles mixed CR and CRLF', () => {
    // CRLF → LF → \\n, standalone CR → LF → \\n
    expect(gdEscape('a\r\nb\rc')).toBe('a\\nb\\nc');
  });

  it('escapes tabs', () => {
    expect(gdEscape('a\tb')).toBe('a\\tb');
  });

  it('handles string with only special characters', () => {
    expect(gdEscape('\t\r\n')).toBe('\\t\\n');
  });

  it('escapes percent sign', () => {
    expect(gdEscape('100%')).toBe('100%%');
  });

  it('does NOT escape dollar sign (not special in GDScript strings)', () => {
    expect(gdEscape('$var')).toBe('$var');
  });

  it('escapes double quote', () => {
    expect(gdEscape('say "hi"')).toBe('say \\"hi\\"');
  });

  it('removes null bytes', () => {
    expect(gdEscape('a\0b')).toBe('ab');
  });

  it('escapes single quote', () => {
    expect(gdEscape("it's")).toBe("it\\'s");
  });

  it('passes through \\uXXXX unchanged (GDScript does not interpret \\u escapes)', () => {
    // GDScript has no \uXXXX escape sequences, so A is literal text.
    // The backslash is still escaped by the general \\ rule.
    expect(gdEscape('\\u0041')).toBe('\\\\u0041');
  });
});

// ─── isPathInAllowedRoots — C-SEC-1 path traversal bypass ──────────────────────

describe('isPathInAllowedRoots — C-SEC-1 path traversal', () => {
  // setup.js 默认 GODOT_MCP_UNRESTRICTED=true 方便多数测试;C-SEC-1 须在 allowlist 模式下验证
  let restore = () => {};
  let tmpRoots = [];

  beforeEach(() => {
    restore = isolatePathEnv();   // 清 UNRESTRICTED + reset（ALLOWED 由各 it 内 makeRoot 后手动设）
    tmpRoots = [];
  });

  afterEach(() => {
    restore();
    for (const r of tmpRoots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const makeRoot = () => {
    const r = mkdtempSync(join(tmpdir(), 'mcp-allow-'));
    tmpRoots.push(r);
    return r;
  };

  it('rejects absolute path whose ".." escapes the allowed root (Windows backslash)', () => {
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    // root\..\..\Windows\... — resolvePath 对绝对路径原样返回,startsWith(ensureSep(root)) 命中
    // → 修复前 BUG 放行。normalize 消除 ".." 后应落回 root 之外 → 拒绝。
    const attack = root + '\\..\\..\\Windows\\System32\\drivers\\etc\\hosts';
    expect(isPathInAllowedRoots(attack)).toBe(false);
  });

  it('rejects forward-slash ".." escape variant', () => {
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    const attack = root.replace(/\\/g, '/') + '/../../etc/passwd';
    expect(isPathInAllowedRoots(attack)).toBe(false);
  });

  it('still accepts a legitimate path inside the allowed root', () => {
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    expect(isPathInAllowedRoots(join(root, 'scenes', 'main.tscn'))).toBe(true);
  });

  it('still accepts the root itself', () => {
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    expect(isPathInAllowedRoots(root)).toBe(true);
  });
});

// ─── isPathInAllowedRoots — C-1 junction/symlink bypass (2026-06-24 审查 Critical) ─

describe('isPathInAllowedRoots — C-1 junction/symlink bypass', () => {
  // C-1: allowlist 内建 junction/symlink 指向外部目录,诱导 agent 传 reparse 子路径。
  // 修复前:isPathInAllowedRoots 只 normalize,reparse 不解析 → startsWith(root) 放行;
  //   下游 resolveWithinRoot 把 base realpath 成 reparse 目标 → 读写 allowlist 外任意文件。
  // 修复后:requestedPath 与 allowlist 条目都 realpath → reparse 解析到外部 → 不匹配 → 拒绝。
  let restore = () => {};
  let tmpRoots = [];

  beforeEach(() => {
    restore = isolatePathEnv();
    tmpRoots = [];
  });

  afterEach(() => {
    restore();
    for (const r of tmpRoots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const makeRoot = () => {
    const r = mkdtempSync(join(tmpdir(), 'mcp-c1-'));
    tmpRoots.push(r);
    return r;
  };

  // 跨平台目录 reparse 点:Windows 用 junction(普通用户权限即可,区别于 symlink);
  // Unix 用 symlink(dir)。Windows symlink 需管理员/开发者模式,用 junction 保证 CI 稳定。
  const linkDir = (target, linkPath) => {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  };

  it('C-1: rejects path escaping root via junction/symlink nested inside allowlist', () => {
    const root = makeRoot();      // allowlist 内合法根
    const outside = makeRoot();   // allowlist 外目标目录
    process.env.ALLOWED_PROJECT_PATHS = root;
    const evilLink = join(root, 'evil');
    linkDir(outside, evilLink);   // root/evil → outside
    // 修复前:normalize(root/evil/secret) 不解析 junction → startsWith(root) → true(放行,BUG)
    expect(isPathInAllowedRoots(join(evilLink, 'secret.txt'))).toBe(false);
  });

  it('C-1: rejects when requested path is the junction/symlink itself', () => {
    const root = makeRoot();
    const outside = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    const evilLink = join(root, 'evil');
    linkDir(outside, evilLink);
    expect(isPathInAllowedRoots(evilLink)).toBe(false);
  });

  it('C-1: allowlist entry that is itself a junction resolves to its real target', () => {
    // allowlist 写 junction 路径(指向 realRoot),实际文件在 realRoot 下。
    // allowlist 条目也要 realpath,否则 requestedPath(realpath=realRoot/x)与 allowlist(junction 字面)不匹配 → 误拒。
    const realRoot = makeRoot();
    const linkParent = mkdtempSync(join(tmpdir(), 'mcp-c1-linkparent-'));
    tmpRoots.push(linkParent);
    const linkRoot = join(linkParent, 'linkroot');
    linkDir(realRoot, linkRoot);
    process.env.ALLOWED_PROJECT_PATHS = linkRoot;  // allowlist = junction 路径
    expect(isPathInAllowedRoots(join(realRoot, 'scenes', 'main.tscn'))).toBe(true);
  });

  it('C-1: legitimate child path (no reparse point) still allowed — regression guard', () => {
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = root;
    expect(isPathInAllowedRoots(join(root, 'scenes', 'main.tscn'))).toBe(true);
    expect(isPathInAllowedRoots(root)).toBe(true);
  });

  it('I-4: allowlist 含不存在条目不影响其他条目匹配', () => {
    // 守护多条目 allowlist 坏条目不污染整体。不存在条目 safeRealPath 向上到根成功(不抛 :128),返回原路径 → 不匹配 → false;
    // 存在条目正常匹配。注(审查#4):I-4 的 :128 throw catch 分支需祖先权限拒绝场景(跨平台难造),此处覆盖"不匹配"分支。
    const root = makeRoot();
    process.env.ALLOWED_PROJECT_PATHS = join(tmpdir(), 'mcp-nonexistent-zzz') + ';' + root;
    expect(isPathInAllowedRoots(join(root, 'scenes', 'main.tscn'))).toBe(true);
  });
});
