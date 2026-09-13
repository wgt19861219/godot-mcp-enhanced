import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  escapeRegExp,
  detectAutoloadUsage,
  parseAutoloadNames,
  _resetAutoloadCache,
  parseMcpMarkers,
  scanGdscriptSandbox,
} from '../src/gdscript-executor.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

const TMP = join(tmpdir(), 'autoload-test-' + process.pid);

beforeEach(() => {
  _resetAutoloadCache();
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

describe('escapeRegExp', () => {
  it('转义正则元字符', () => {
    expect(escapeRegExp('My-Singleton')).toBe('My-Singleton');
    expect(escapeRegExp('UI.Manager')).toBe('UI\\.Manager');
    expect(escapeRegExp('NormalName')).toBe('NormalName');
  });
});

describe('parseAutoloadNames', () => {
  it('解析 autoload 名称列表', () => {
    writeFileSync(join(TMP, 'project.godot'), [
      '[autoload]',
      'GameManager="*res://game_manager.gd"',
      'DataTables="*res://data_tables.gd"',
    ].join('\n'), 'utf-8');
    expect(parseAutoloadNames(TMP)).toEqual(['GameManager', 'DataTables']);
  });

  it('无 autoload 段返回空数组', () => {
    writeFileSync(join(TMP, 'project.godot'), '[application]\nconfig/name="Test"', 'utf-8');
    expect(parseAutoloadNames(TMP)).toEqual([]);
  });

  it('文件不存在返回空数组', () => {
    expect(parseAutoloadNames(join(tmpdir(), 'noexist-' + Date.now()))).toEqual([]);
  });

  it('缓存命中', () => {
    writeFileSync(join(TMP, 'project.godot'), '[autoload]\nX="*res://x.gd"', 'utf-8');
    const first = parseAutoloadNames(TMP);
    rmSync(join(TMP, 'project.godot'));
    expect(parseAutoloadNames(TMP)).toEqual(first);
  });
});

describe('detectAutoloadUsage', () => {
  it('检测 autoload 引用', () => {
    const code = 'GameManager.get_hp()\nDataTables.fetch()';
    const r = detectAutoloadUsage(code, ['GameManager', 'DataTables', 'Unused']);
    expect(r).toContain('GameManager');
    expect(r).toContain('DataTables');
    expect(r).not.toContain('Unused');
  });

  it('无匹配返回空数组', () => {
    expect(detectAutoloadUsage('var x = 1', ['GameManager'])).toEqual([]);
  });

  it('空代码返回空数组', () => {
    expect(detectAutoloadUsage('', ['GameManager'])).toEqual([]);
  });

  it('正则元字符名正确匹配', () => {
    expect(detectAutoloadUsage('My-Singleton.run()', ['My-Singleton'])).toContain('My-Singleton');
  });

  it('词边界：不匹配部分名', () => {
    expect(detectAutoloadUsage('MyGameManager.get()', ['GameManager'])).toEqual([]);
  });
});

describe('autoload auto-detection 集成', () => {
  it('空项目（无 autoload）不会误触发', () => {
    writeFileSync(join(TMP, 'project.godot'), '[application]\nconfig/name="Empty"', 'utf-8');
    const names = parseAutoloadNames(TMP);
    expect(names).toEqual([]);
    const detected = detectAutoloadUsage('var x = 1', names);
    expect(detected).toEqual([]);
  });

  it('autoload 名含下划线正确匹配', () => {
    const code = 'var x = My_Module.fetch()';
    const result = detectAutoloadUsage(code, ['My_Module']);
    expect(result).toContain('My_Module');
  });

  it('多个 autoload 部分引用只返回匹配的', () => {
    const code = 'GameManager.reset()';
    const result = detectAutoloadUsage(code, ['GameManager', 'DataTables', 'GameEvents']);
    expect(result).toEqual(['GameManager']);
  });
});

// === 原有测试继续 ===

const MARKER_RESULT = '___MCP_RESULT___';
const MARKER_ERROR = '___MCP_ERROR___';

describe('parseMcpMarkers', () => {
  it('parses result marker with outputs', () => {
    const raw = `Hello world
${MARKER_RESULT}{"success":true,"outputs":[{"key":"x","value":"42"}]}`;
    const { parsed, logLines } = parseMcpMarkers(raw);
    expect(parsed).toEqual({ success: true, outputs: [{ key: 'x', value: '42' }] });
    expect(logLines).toEqual(['Hello world']);
  });

  it('parses error marker', () => {
    const raw = `${MARKER_ERROR}{"success":false,"error":"compile failed"}`;
    const { parsed } = parseMcpMarkers(raw);
    expect(parsed).toEqual({ success: false, error: 'compile failed' });
  });

  it('returns null when no marker found', () => {
    const raw = 'Just some output\nNo markers here';
    const { parsed, logLines } = parseMcpMarkers(raw);
    expect(parsed).toBe(null);
    expect(logLines.length).toBe(2);
  });

  it('handles malformed JSON in marker', () => {
    const raw = `${MARKER_RESULT}{broken json}`;
    const { parsed } = parseMcpMarkers(raw);
    expect(parsed.success).toBe(false);
  });
});

describe('wrapSnippet code detection', () => {
  it('detects full class with extends', () => {
    const code = 'extends SceneTree\n\nfunc _initialize():\n\tprint("hi")';
    expect(/^\s*extends\s+/m.test(code)).toBe(true);
  });

  it('snippet without extends is not full class', () => {
    const code = 'var x = 1\nprint(x)';
    expect(/^\s*extends\s+/m.test(code)).toBeFalsy();
  });
});

describe('scanGdscriptSandbox', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
  });

  it('should detect OS.execute by default (sandbox on)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('should detect OS.create_process by default (F-1: equivalent to OS.execute)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // create_process 与 execute 等价(启动任意可执行文件),必须被同等拦截
    const warnings = scanGdscriptSandbox('OS.create_process("cmd.exe", PackedStringArray(["/c", "whoami"]))');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('should detect OS.create_process string-concatenation bypass (F-1)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // DANGEROUS_API_TOKENS 的 OS.create_process token 拦截拼接绕过
    const warnings = scanGdscriptSandbox('var api = "OS" + ".create_process"');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('should skip scanning when explicitly disabled', () => {
    process.env.GODOT_MCP_SANDBOX = 'disabled';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings).toEqual([]);
  });

  it('should not flag safe code', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('var x = 1 + 2');
    expect(warnings).toEqual([]);
  });

  it('should detect DirAccess.remove by default', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('DirAccess.remove("user://save.dat")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Directory removal');
  });

  it('should detect FileAccess.open WRITE mode by default (C-03: READ is allowed)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.WRITE)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('File write access');
  });

  it('should allow FileAccess.open READ mode by default (C-03)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.READ)');
    expect(warnings.length).toBe(0);
  });

  // 2026-08-07 审查 P2 修复（决策2 升级版）：默认模式拦非 Godot 协议路径读（信息泄露面）
  // res:// / user:// 放行（项目内资源 + 用户数据目录），绝对路径/~ /.. 拦截
  it('should block FileAccess.open READ of non-Godot-protocol path by default (2026-08-07 P2)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // 绝对路径（~/.ssh）应被拦
    const warnings1 = scanGdscriptSandbox('FileAccess.open("~/.ssh/id_rsa", FileAccess.READ)');
    expect(warnings1.length).toBeGreaterThan(0);
    expect(warnings1[0]).toContain('non-resource path');
    // res:// 放行
    const warnings2 = scanGdscriptSandbox('FileAccess.open("res://data.txt", FileAccess.READ)');
    expect(warnings2.length).toBe(0);
    // user:// 放行（Godot 用户数据目录）
    const warnings3 = scanGdscriptSandbox('FileAccess.open("user://save.json", FileAccess.READ)');
    expect(warnings3.length).toBe(0);
  });

  // 2026-08-07 审查 P2: 网络回连 API 拦截（WebSocketPeer/HTTPClient/StreamPeer/connect_to_url）
  it('should block network callback APIs (2026-08-07 P2)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    expect(scanGdscriptSandbox('var ws = WebSocketPeer.new()').length).toBeGreaterThan(0);
    expect(scanGdscriptSandbox('var c = HTTPClient.new()').length).toBeGreaterThan(0);
    expect(scanGdscriptSandbox('var p = StreamPeerTCP.new()').length).toBeGreaterThan(0);
    expect(scanGdscriptSandbox('ws.connect_to_url("ws://evil")').length).toBeGreaterThan(0);
  });

  it('should detect Engine.set_singleton by default', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('Engine.set_singleton("MySingleton", node)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Engine singleton modification');
  });

  it('should detect multiple dangerous patterns in one script', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const code = 'OS.execute("ls", [])\nDirAccess.remove_absolute("/tmp/test")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.length).toBe(2);
  });

  it('should detect OS singleton aliasing bypass (C-SEC-4: var s = OS)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // C-SEC-4 绕过:把 OS 单例赋值给变量,再通过变量调用 execute,
    // 避开 /OS\.execute/ 字面量匹配。沙箱应拦截单例别名赋值(纵深防御,
    // 文件头已声明此为已知限制类目,本模式提高常见绕过的拦截成本)。
    const code = 'var s = OS\ns.execute("calc")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('alias') || w.includes('bypass'))).toBe(true);
  });

  it('should NOT false-positive on OS method call assignment (C-SEC-4 precision)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // 精度保证:= OS.get_xxx() 是合法方法调用赋值,负向预查须排除,
    // 不可被单例别名模式误报。
    const warnings = scanGdscriptSandbox('var name = OS.get_name()');
    expect(warnings).toEqual([]);
  });

  it('should NOT false-positive on OS equality comparison (C-SEC-4 review I-1)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    // lookbehind (?<![=!<>]) 排除 == / != / <= / >= 比较操作符的第二 =,
    // 避免误报 if current_os == OS: 这类合法比较表达式。
    const warnings = scanGdscriptSandbox('if current_os == OS: pass');
    expect(warnings).toEqual([]);
  });

  it('should still scan when GODOT_MCP_SANDBOX is set to other values', () => {
    process.env.GODOT_MCP_SANDBOX = 'warn';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('should not false-positive on bare "%s" format strings (I-1 fix)', () => {
    // Tokens starting with '.' like '.call(' have empty prefixPart and must NOT
    // trigger a match on bare "%s", "%d", "%i" strings.
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('var label = "%s" % player_name');
    expect(warnings).toEqual([]);
  });

  it('should still detect dangerous prefix + %s concatenation', () => {
    // "OS%s" should still be detected — OS is a non-empty prefix
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('var api = "OS%s" % "execute"');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('% format string'))).toBe(true);
  });

  it('should detect OS["execute"] indexed-access bypass (C-SEC-3)', () => {
    // 索引访问把句点换成方括号,绕过 OS.execute 正则 — 须单独拦截
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('OS["execute"]("cmd", [], false)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('indexed access'))).toBe(true);
  });

  // P0-1 (2026-07-06 RCE 审查): 双开关 — SANDBOX=disabled 需同时设 UNRESTRICTED=true 才生效
  it('SANDBOX=disabled alone (no UNRESTRICTED) keeps sandbox active (P0-1)', () => {
    const prevU = process.env.GODOT_MCP_UNRESTRICTED;
    delete process.env.GODOT_MCP_UNRESTRICTED;  // 覆盖 setup.js 默认 true
    try {
      process.env.GODOT_MCP_SANDBOX = 'disabled';
      const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
      expect(warnings.length).toBeGreaterThan(0);  // 沙箱仍开启
    } finally {
      if (prevU !== undefined) process.env.GODOT_MCP_UNRESTRICTED = prevU;
      else delete process.env.GODOT_MCP_UNRESTRICTED;
    }
  });

  it('SANDBOX=disabled + UNRESTRICTED=true bypasses sandbox (P0-1)', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    process.env.GODOT_MCP_SANDBOX = 'disabled';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings).toEqual([]);  // 双开关满足,沙箱关闭
  });
});
// ─── I-3: executor 并发警告按目标桶判定(设计 §4.5,per-project 会话 Task 5) ──

import { executeGdscript } from '../src/gdscript-executor.js';
import { spawn } from 'child_process';
import { setProjectDir, setRunSessionProc, resetState } from '../src/core/process-state.js';
import { getLogger } from '../src/core/logger.js';

// 隔离 mock(vitest 自动提升到 import 前):spawn 可控(import warmup 也走它,一并拦掉)。
// I-4 统一策略:importOriginal 部分覆盖——forceKillTree 等依赖 child_process 其余导出(execFile),
// 只 stub spawn,其余透传真实模块。
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../src/tools/import-check.js', () => ({
  needsImport: vi.fn(() => false),   // 跳过 import warmup(防 spawn 到 runGodotHeadless 挂起)
  runImport: vi.fn(),
}));

describe('I-3: executor 并发警告按目标桶判定(设计 §4.5)', () => {
  const GODOT_BIN = join(TMP, 'godot-fake.exe');
  const fakeProc = () => {
    const p = new EventEmitter();
    p.pid = 4242;
    p.killed = false;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { write: vi.fn(), end: vi.fn() };
    return p;
  };

  let warnSpy;

  beforeEach(() => {
    resetState();
    // existsSync(godotPath) 校验需要真实文件;basename 含 'godot'
    writeFileSync(GODOT_BIN, '');
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    spawn.mockImplementation(() => {
      const p = fakeProc();
      process.nextTick(() => p.emit('close', 0));
      return p;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetState();
  });

  it('目标桶有活进程(即使活跃桶是别的项目)→ 警告(修复前活跃桶判定漏报)', async () => {
    setRunSessionProc('/proj/a', fakeProc());   // A 桶活进程
    setProjectDir('/proj/b');                   // 活跃指针指向 B ≠ A
    await executeGdscript({ godotPath: GODOT_BIN, projectPath: '/proj/a', code: 'var x = 1' });
    expect(warnSpy).toHaveBeenCalledWith('gdscript', expect.stringContaining('is also being used by a running game process'));
  });

  it('目标桶无进程 + 活跃桶在跑其他项目 → 不警告(按目标桶,不按活跃桶)', async () => {
    setRunSessionProc('/proj/b', fakeProc());   // 活跃桶 B 有进程
    setProjectDir('/proj/b');
    await executeGdscript({ godotPath: GODOT_BIN, projectPath: '/proj/a', code: 'var x = 1' });
    expect(warnSpy).not.toHaveBeenCalledWith('gdscript', expect.stringContaining('is also being used'));
  });
});
