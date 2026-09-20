import { expect, describe, it, afterEach } from 'vitest';
import {
  wrapSnippet,
  wrapSnippetAsNode,
  isFullClass,
  injectHelpers,
  createAutoloadLoaderScript,
  createAutoloadLoaderScene,
  parseMcpMarkers,
  scanGdscriptSandbox,
  stripLiterals,
  loadExtraDangerousPatterns,
  _resetExtraDangerousPatternsCache,
} from '../src/gdscript-executor.js';
import { buildSafeEnv } from '../src/core/godot-finder.js';

// ─── wrapSnippet ──────────────────────────────────────────────────────────────

describe('wrapSnippet', () => {
  it('wraps plain snippet code with extends SceneTree', () => {
    const code = 'var x = 1\nprint(x)';
    const result = wrapSnippet(code);
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _initialize():');
    expect(result).toContain('_mcp_output');
    expect(result).toContain('var x = 1');
    expect(result).toContain('print(x)');
  });

  it('wraps empty code into a valid SceneTree script', () => {
    const result = wrapSnippet('');
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _initialize():');
    expect(result).toContain('___MCP_RESULT___');
  });

  it('uses custom result marker when provided', () => {
    const code = '_mcp_output("k", "v")';
    const customMarker = '__CUSTOM_MARKER__';
    const result = wrapSnippet(code, customMarker);
    expect(result).toContain(customMarker);
    expect(result).not.toContain('___MCP_RESULT___');
  });

  it('separates func declarations into class scope', () => {
    const code = 'func my_helper():\n\treturn 42\nprint(my_helper())';
    const result = wrapSnippet(code);
    // func declaration should be at class level (not indented under _initialize)
    expect(result).toContain('func my_helper():');
    expect(result).toContain('\treturn 42');
    // print call should be indented under _initialize
    const lines = result.split('\n');
    const printLine = lines.find(l => l.includes('print(my_helper())'));
    expect(printLine).toBeDefined();
    expect(printLine.startsWith('\t')).toBe(true);
  });

  it('handles var and const declarations at class scope', () => {
    const code = 'const MAX = 100\nvar count = 0\n_mcp_output("c", str(count))';
    const result = wrapSnippet(code);
    expect(result).toContain('const MAX = 100');
    expect(result).toContain('var count = 0');
    // These should be in the declarations section (before _initialize)
    const initIdx = result.indexOf('func _initialize():');
    const constIdx = result.indexOf('const MAX = 100');
    expect(constIdx).toBeLessThan(initIdx);
  });

  it('handles comment-only lines in declarations', () => {
    const code = '# This is a comment\n_mcp_output("ok", "1")';
    const result = wrapSnippet(code);
    expect(result).toContain('# This is a comment');
  });

  it('handles static func declarations', () => {
    const code = 'static func add(a, b):\n\treturn a + b\n_mcp_output("r", str(add(1, 2)))';
    const result = wrapSnippet(code);
    expect(result).toContain('static func add(a, b):');
    expect(result).toContain('\treturn a + b');
  });
});

// ─── wrapSnippetAsNode ────────────────────────────────────────────────────────

describe('wrapSnippetAsNode', () => {
  it('wraps code as extends Node', () => {
    const code = '_mcp_output("k", "v")';
    const result = wrapSnippetAsNode(code);
    expect(result).toContain('extends Node');
    expect(result).toContain('func _initialize() -> void:');
  });

  it('renames user _initialize to _mcp_user_init', () => {
    const code = 'func _initialize():\n\tprint("hi")\n_mcp_output("x", "1")';
    const result = wrapSnippetAsNode(code);
    expect(result).toContain('func _mcp_user_init():');
    expect(result).not.toContain('func _initialize():');
    expect(result).toContain('_mcp_user_init()');
  });

  it('uses custom marker', () => {
    const result = wrapSnippetAsNode('pass', '__CUSTOM__');
    expect(result).toContain('__CUSTOM__');
  });
});

// ─── isFullClass ──────────────────────────────────────────────────────────────

describe('isFullClass', () => {
  it('returns true for code with extends SceneTree', () => {
    expect(isFullClass('extends SceneTree\npass')).toBe(true);
  });

  it('returns true for code with extends Node', () => {
    expect(isFullClass('extends Node2D\nfunc _ready(): pass')).toBe(true);
  });

  it('returns false for plain snippets', () => {
    expect(isFullClass('var x = 1\nprint(x)')).toBe(false);
  });

  it('returns false for empty code', () => {
    expect(isFullClass('')).toBe(false);
  });

  it('returns true when extends is indented', () => {
    // "extends" at the start of a line (with leading whitespace)
    expect(isFullClass('  extends Node\npass')).toBe(true);
  });

  it('ignores extends inside comments/strings', () => {
    // The regex is /^\s*extends\s+/m, so a comment like "# extends" won't match
    // But "extends" at start of a line will match even in a string context
    expect(isFullClass('# extends Node\nvar x = 1')).toBe(false);
  });
});

// ─── injectHelpers ────────────────────────────────────────────────────────────

describe('injectHelpers', () => {
  it('injects _mcp_outputs var and _mcp_output func after extends line', () => {
    const code = 'extends SceneTree\n\nfunc _initialize():\n\tprint("hi")';
    const result = injectHelpers(code);
    expect(result).toContain('var _mcp_outputs: Array = []');
    expect(result).toContain('func _mcp_output(key: String, value: Variant) -> void:');
  });

  it('does not duplicate _mcp_outputs if already present', () => {
    const code = 'extends SceneTree\n\nvar _mcp_outputs: Array = []\n\nfunc _initialize():\n\tprint("hi")';
    const result = injectHelpers(code);
    const count = (result.match(/var _mcp_outputs:/g) || []).length;
    expect(count).toBe(1);
  });

  it('does not duplicate _mcp_output func if already present', () => {
    const code = 'extends Node\n\nfunc _mcp_output(key, val):\n\tpass\n\nfunc _ready():\n\tpass';
    const result = injectHelpers(code);
    const count = (result.match(/func _mcp_output\(/g) || []).length;
    expect(count).toBe(1);
  });
});

// ─── createAutoloadLoaderScript ────────────────────────────────────────────────

describe('createAutoloadLoaderScript', () => {
  it('escapes Windows backslashes in paths', () => {
    const result = createAutoloadLoaderScript('C:\\Users\\test\\script.gd');
    expect(result).toContain('C:/Users/test/script.gd');
    expect(result).not.toContain('C:\\Users\\test\\script.gd');
  });

  it('handles normal Unix paths correctly', () => {
    const result = createAutoloadLoaderScript('/tmp/godot/script.gd');
    expect(result).toContain('/tmp/godot/script.gd');
  });

  it('generates extends Node script', () => {
    const result = createAutoloadLoaderScript('/path/to/script.gd');
    expect(result).toContain('extends Node');
    expect(result).toContain('func _ready() -> void:');
    expect(result).toContain('load("/path/to/script.gd")');
  });

  it('escapes double quotes in paths', () => {
    const result = createAutoloadLoaderScript('/path/with"quote/script.gd');
    expect(result).toContain('/path/with\\"quote/script.gd');
  });
});

// ─── createAutoloadLoaderScene ─────────────────────────────────────────────────

describe('createAutoloadLoaderScene', () => {
  it('generates valid .tscn content', () => {
    const result = createAutoloadLoaderScene('/path/to/loader.gd');
    expect(result).toContain('[gd_scene load_steps=2 format=3]');
    expect(result).toContain('[ext_resource type="Script" path="/path/to/loader.gd" id="1"]');
    expect(result).toContain('[node name="MCPLoader" type="Node"]');
    expect(result).toContain('script = ExtResource("1")');
  });

  it('escapes backslashes in script path', () => {
    const result = createAutoloadLoaderScene('C:\\Users\\test\\loader.gd');
    expect(result).toContain('C:/Users/test/loader.gd');
    expect(result).not.toContain('C:\\Users\\test\\loader.gd');
  });
});

// ─── buildSafeEnv ──────────────────────────────────────────────────────────────

describe('buildSafeEnv', () => {
  it('includes PATH', () => {
    const env = buildSafeEnv();
    expect(env).toHaveProperty('PATH');
    expect(typeof env.PATH).toBe('string');
  });

  it('does NOT leak GODOT_MCP_UNRESTRICTED to subprocess', () => {
    const original = process.env.GODOT_MCP_UNRESTRICTED;
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    const env = buildSafeEnv();
    expect(env).not.toHaveProperty('GODOT_MCP_UNRESTRICTED');
    // Restore
    if (original === undefined) {
      delete process.env.GODOT_MCP_UNRESTRICTED;
    } else {
      process.env.GODOT_MCP_UNRESTRICTED = original;
    }
  });

  it('includes Windows-specific paths (USERPROFILE)', () => {
    const env = buildSafeEnv();
    expect(env).toHaveProperty('USERPROFILE');
    expect(env).toHaveProperty('HOME');
  });

  it('includes TEMP and TMP', () => {
    const env = buildSafeEnv();
    expect(env).toHaveProperty('TEMP');
    expect(env).toHaveProperty('TMP');
  });

  it('does NOT include ALLOW_EXECUTE_GDSCRIPT', () => {
    const original = process.env.ALLOW_EXECUTE_GDSCRIPT;
    process.env.ALLOW_EXECUTE_GDSCRIPT = 'false';
    const env = buildSafeEnv();
    expect(env).not.toHaveProperty('ALLOW_EXECUTE_GDSCRIPT');
    // Restore
    if (original === undefined) {
      delete process.env.ALLOW_EXECUTE_GDSCRIPT;
    } else {
      process.env.ALLOW_EXECUTE_GDSCRIPT = original;
    }
  });

  it('includes GODOT env var', () => {
    const env = buildSafeEnv();
    expect(env).toHaveProperty('GODOT');
  });
});

// ─── parseMcpMarkers (extended edge cases) ────────────────────────────────────

describe('parseMcpMarkers extended', () => {
  const MARKER_RESULT = '___MCP_RESULT___';
  const MARKER_ERROR = '___MCP_ERROR___';

  it('handles multiline output with multiple log lines', () => {
    const raw = `line1
line2
${MARKER_RESULT}{"success":true,"outputs":[]}
line3`;
    const { parsed, logLines } = parseMcpMarkers(raw);
    expect(parsed).toEqual({ success: true, outputs: [] });
    // line3 appears after the marker but is still a log line
    expect(logLines).toContain('line1');
    expect(logLines).toContain('line2');
  });

  it('handles both result and error markers (last wins)', () => {
    const raw = `${MARKER_RESULT}{"success":true,"outputs":[]}
${MARKER_ERROR}{"success":false,"error":"crash"}`;
    const { parsed } = parseMcpMarkers(raw);
    // Error marker comes after result, so it overwrites
    expect(parsed).toEqual({ success: false, error: 'crash' });
  });

  it('handles custom markers', () => {
    const customResult = '__CUSTOM_R__';
    const customError = '__CUSTOM_E__';
    const raw = `${customResult}{"success":true,"outputs":[{"key":"x","value":"1"}]}`;
    const { parsed } = parseMcpMarkers(raw, customResult, customError);
    expect(parsed).toEqual({ success: true, outputs: [{ key: 'x', value: '1' }] });
  });
});

// ─── scanGdscriptSandbox (edge cases) ────────────────────────────────────────

describe('scanGdscriptSandbox extended', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
  });

  it('does not flag OS.execute inside a string literal context', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var s = "OS.execute is dangerous"';
    const warnings = scanGdscriptSandbox(code);
    // stripLiterals 剥去字符串内容后,Phase 1 不再误报
    expect(warnings).toEqual([]);
  });

  it('does not flag OS.execute inside a line comment', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '# OS.execute("ls") is just a comment';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings).toEqual([]);
  });

  it('does not flag DirAccess.remove inside a string literal', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var desc = "DirAccess.remove deletes a directory"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings).toEqual([]);
  });

  it('still flags a real OS.execute call (regression guard)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('OS.execute("ls")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('flags OS.shell_open', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('OS.shell_open("https://example.com")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('flags FileAccess.open with READ mode in strict mode (C-03: strict blocks all file access)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.READ)');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some(w => w.includes('File access'))).toBe(true);
  });

  it('flags DirAccess.remove_absolute', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('DirAccess.remove_absolute("/tmp/test")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Directory removal');
  });

  // IMPORTANT-2 (review): Engine["get_singleton"] 索引访问绕过 Engine.get_singleton 点访问正则。
  // OS 已有 /\bOS\s*\[/ (:50),Engine 漏堵。举一反三覆盖 FileAccess/DirAccess/JavaScriptBridge。
  it('flags Engine["get_singleton"] indexed access (IMPORTANT-2)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('Engine["get_singleton"]("FileAccess")');
    expect(warnings.some(w => w.includes('indexed access'))).toBe(true);
  });

  it('flags DirAccess["remove"] indexed access (举一反三)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('DirAccess["remove"]("/tmp")');
    expect(warnings.some(w => w.includes('indexed access'))).toBe(true);
  });

  // P1-8 (批次 E): var2str + get_script 是 S-1-review 新增 DANGEROUS_PATTERNS（gdscript-executor.ts:86,88），
  // 此前 test/ 零触发覆盖。误删→var2str+str2var 重建任意对象链 / .get_script 反射逃逸沙箱。
  it('flags var2str serialization bypass (P1-8)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('var s = var2str(obj)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('var2str'))).toBe(true);
  });

  it('flags get_script reflection escape (P1-8)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('var s = node.get_script()');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('get_script'))).toBe(true);
  });

  // IMPORTANT-3 (review): Expression.execute 正则 . 不跨行,
  // var e = Expression.new()\ne.execute() 分行写即绕过。
  it('flags Expression.execute split across lines (IMPORTANT-3)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var e = Expression.new()\ne.execute([], [])';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('Expression.execute'))).toBe(true);
  });
});

// ─── Phase 2: String concatenation bypass detection ─────────────────────────

describe('scanGdscriptSandbox Phase 2 — concatenation bypass', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
  });

  it('detects OS.execute built from two string parts', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var cmd = "OS" + ".execute"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('OS.execute'))).toBe(true);
  });

  it('detects str2var built from string concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'call("str" + "2var", data)';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('str2var'))).toBe(true);
  });

  it('detects JavaScriptBridge.eval concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"JavaScriptBridge" + ".eval"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('JavaScriptBridge.eval'))).toBe(true);
  });

  it('does not flag harmless string concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var msg = "Hello" + " " + "World"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('SANDBOX-P2'))).toEqual([]);
  });

  it('detects preload with computed path', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'preload(var_path)';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('preload'))).toBe(true);
  });

  it('does not flag preload with res:// literal', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'preload("res://scenes/main.tscn")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('preload'))).toEqual([]);
  });

  it('detects bypass built from 3 string parts', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"Dir" + "Access" + ".remove"';
    // Combined = "DirAccess.remove" which matches
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2'))).toBe(true);
  });

  it('skips Phase 2 when GODOT_MCP_SANDBOX=disabled', () => {
    process.env.GODOT_MCP_SANDBOX = 'disabled';
    const code = 'var cmd = "OS" + ".execute"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings).toEqual([]);
  });

  it('detects OS.kill concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"OS" + ".kill"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('OS.kill'))).toBe(true);
  });

  it('detects bytes2var concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"bytes" + "2var"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('bytes2var'))).toBe(true);
  });

  it('does not detect tokens spread across 5+ strings (window limit 4)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    // 5 separate strings, window max is 4, so no combination of ≤4 covers the full token
    const code = '"a" + "b" + "O" + "S" + ".execute"';
    const warnings = scanGdscriptSandbox(code);
    // "OS" + ".execute" are adjacent (indices 2,3) — window=4 includes them,
    // so this actually IS detected. Design: window covers up to 4 adjacent strings.
    expect(warnings.some(w => w.includes('SANDBOX-P2'))).toBe(true);
  });

  // ─── C-SEC-01: Reflection bypass detection (Phase 1 + Phase 2) ────────────

  it('Phase 1: flags ClassDB reflection', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('var methods = ClassDB.class_get_method_list("OS")');
    expect(warnings.some(w => w.includes('ClassDB'))).toBe(true);
  });

  it('Phase 1: flags indirect .call() with string arg (reflection)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('OS.call("execute", "whoami", [], false)');
    expect(warnings.some(w => w.includes('.call('))).toBe(true);
  });

  it('Phase 1: does NOT flag .call() with variable arg (legitimate Callable)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    // _collect_fn.call(child) is a legitimate Callable invocation — not reflection
    const warnings = scanGdscriptSandbox('_collect_fn.call(child)');
    expect(warnings.filter(w => w.includes('.call('))).toEqual([]);
  });

  it('Phase 1: flags indirect .callv() with string arg (reflection)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('node.callv("set_script", [script_obj])');
    expect(warnings.some(w => w.includes('.callv('))).toBe(true);
  });

  it('Phase 1: does NOT flag .callv() with variable arg', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('my_callable.callv(args_array)');
    expect(warnings.filter(w => w.includes('.callv('))).toEqual([]);
  });

  it('Phase 2: detects ClassDB built from concatenation', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"Class" + "DB"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('ClassDB'))).toBe(true);
  });

  // IMPORTANT-1 (review): 拼接检测窗口原固定=4。无 '.' 的 token(如 str2var)只能整体匹配,
  // 5 段拆分需窗口>4 才能拼出,故原窗口漏。扩大窗口后应检测。
  it('Phase 2: detects str2var built from 5 string parts (IMPORTANT-1)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '"st" + "r" + "2" + "v" + "ar"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('SANDBOX-P2') && w.includes('str2var'))).toBe(true);
  });
});

// ─── stripLiterals ───────────────────────────────────────────────────────────

describe('stripLiterals', () => {
  it('strips content of double-quoted string but keeps quotes', () => {
    expect(stripLiterals('var s = "OS.execute is dangerous"')).toBe('var s = ""');
  });

  it('strips content of single-quoted string', () => {
    expect(stripLiterals("var s = 'OS.kill'")).toBe("var s = ''");
  });

  it('strips a full-line comment', () => {
    expect(stripLiterals('# OS.execute("ls")')).toBe('');
  });

  it('strips trailing comment but preserves code and newline', () => {
    expect(stripLiterals('var a = 1 # OS.execute\nvar b = 2')).toBe('var a = 1 \nvar b = 2');
  });

  it('does not treat # inside a string as a comment', () => {
    expect(stripLiterals('var s = "a#b"')).toBe('var s = ""');
  });

  it('handles triple-quoted string', () => {
    // 三引号开/闭引号归一化为单个(stripLiterals :271/:283),内容仍剥光。
    expect(stripLiterals('var s = """OS.execute"""')).toBe('var s = ""');
  });

  it('handles escaped quote inside string without early close', () => {
    // GDScript 源码: var s = "a\"b"  (JS 字符串里 \\ 代表一个反斜杠)
    expect(stripLiterals('var s = "a\\"b"')).toBe('var s = ""');
  });

  it('preserves a real dangerous call so Phase 1 still detects it', () => {
    expect(stripLiterals('OS.execute("ls")')).toBe('OS.execute("")');
  });

  it('preserves reflection pattern so .call("x") is still detectable', () => {
    expect(stripLiterals('obj.call("execute")')).toBe('obj.call("")');
  });

  // C-RES: 保留 res:// 协议前缀,使 load("res://...") 在骨架上仍被正则放行。
  it('preserves res:// prefix of double-quoted resource path', () => {
    expect(stripLiterals('load("res://scripts/test_helper.gd")')).toBe('load("res://")');
  });

  it('preserves res:// prefix of single-quoted resource path', () => {
    expect(stripLiterals("preload('res://scenes/main.tscn')")).toBe("preload('res://')");
  });

  it('preserves res:// prefix inside triple-quoted string', () => {
    // 三引号开/闭引号归一化为单个,res:// 前缀仍保留。
    expect(stripLiterals('var s = """res://x.gd"""')).toBe('var s = "res://"');
  });

  it('does not preserve non-res:// string content (except user:// since 2026-08-07 P2)', () => {
    // 2026-08-07 审查 P2: user:// 现在和 res:// 同等保留（Godot 用户数据目录，合法用途）
    expect(stripLiterals('load("user://evil.gd")')).toBe('load("user://")');
    // 其他非协议字符串仍被剥光
    expect(stripLiterals('load("foo/bar.gd")')).toBe('load("")');
  });
});

describe('scanGdscriptSandbox res:// load regression (C-RES)', () => {
  // C-RES 回归:commit 1413a34 改用骨架扫描后,load("res://...") 被误报为
  // "load() with non-resource path"(因骨架剥光了 res:// 内容)。必须放行。
  it('does not flag load() with res:// literal path', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var helper = load("res://scripts/test_helper.gd")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('non-resource'))).toEqual([]);
  });

  it('still flags load() with non-resource path', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var helper = load("user://evil.gd")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.some(w => w.includes('load() with non-resource path'))).toBe(true);
  });

  // I-1 (review): load("""res://...""") 三引号端到端放行。
  // stripLiterals 已为三引号保留 res://,但 :65 正则须用 "{1,3}" 才不在首 " 后误报。
  it('does not flag load() with triple-quoted res:// path', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var helper = load("""res://scripts/test_helper.gd""")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('non-resource'))).toEqual([]);
  });

  // M-2 (review): preload("res://...") 当前由 :199 正则正确放行,补 guard 防回归。
  it('does not flag preload() with res:// path', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var scn = preload("res://scenes/main.tscn")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('preload'))).toEqual([]);
  });

  // A-3 (advisory): ResourceLoader.load("res://...") 不再误报(原 [^)]* 贪婪致误报)。
  it('does not flag ResourceLoader.load() with res:// path (A-3)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var t = ResourceLoader.load("res://a.tres")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.filter(w => w.includes('ResourceLoader.load'))).toEqual([]);
  });
});

// ─── loadExtraDangerousPatterns (env-injected extra danger patterns) ────────

describe('loadExtraDangerousPatterns', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
    _resetExtraDangerousPatternsCache();
  });

  it('returns empty array when env is not set', () => {
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('loads valid patterns from env', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\\.request', label: 'HTTP request (project policy)' },
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('HTTP request (project policy)');
    expect(patterns[0].pattern.test('HTTPRequest.request("url")')).toBe(true);
  });

  it('skips invalid regex without crashing and keeps valid ones', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: '(', label: 'bad regex' },
      { pattern: 'ValidPattern', label: 'good' },
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('good');
  });

  it('ignores non-array JSON', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify({ not: 'array' });
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('ignores malformed JSON', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = 'not json {{{';
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('skips entries with missing/non-string fields', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'OK', label: 'valid' },
      { pattern: 123, label: 'bad-type' },
      { pattern: 'OK2' },
      'not-an-object',
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('valid');
  });

  it('memoizes: same env returns same array reference', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'X', label: 'Y' },
    ]);
    const a = loadExtraDangerousPatterns();
    const b = loadExtraDangerousPatterns();
    expect(a).toBe(b);
  });

  it('re-parses when env value changes', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'A', label: 'a' },
    ]);
    const first = loadExtraDangerousPatterns();
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'B', label: 'b' },
    ]);
    const second = loadExtraDangerousPatterns();
    expect(first).not.toBe(second);
    expect(second[0].label).toBe('b');
  });
});

// ─── scanGdscriptSandbox extra patterns (env-injected, end-to-end) ──────────

describe('scanGdscriptSandbox extra patterns (env-injected)', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
    delete process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
    _resetExtraDangerousPatternsCache();
  });

  it('blocks code matching a user-defined extra pattern', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\.request', label: 'HTTP request (project policy)' },
    ]);
    const warnings = scanGdscriptSandbox('HTTPRequest.request("https://example.com")');
    expect(warnings.some(w => w.includes('HTTP request (project policy)'))).toBe(true);
  });

  it('does not block when extra pattern env is unset', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('HTTPRequest.request("https://example.com")');
    expect(warnings.filter(w => w.includes('HTTP request'))).toEqual([]);
  });

  it('extra pattern runs on skeleton: string content does not trigger', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\.request', label: 'HTTP policy' },
    ]);
    const warnings = scanGdscriptSandbox('var s = "HTTPRequest.request is blocked by policy"');
    expect(warnings.filter(w => w.includes('HTTP policy'))).toEqual([]);
  });

  it('extra pattern runs on skeleton: comment content does not trigger', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\.request', label: 'HTTP policy' },
    ]);
    const warnings = scanGdscriptSandbox('# HTTPRequest.request mentioned in comment');
    expect(warnings.filter(w => w.includes('HTTP policy'))).toEqual([]);
  });
});
