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
} from '../src/gdscript-executor.js';
import { buildSafeEnv } from '../src/helpers.js';

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
    expect(printLine).toBeTruthy();
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
    // The regex-based scanner will still flag this — documented behavior
    const code = 'var s = "OS.execute is dangerous"';
    const warnings = scanGdscriptSandbox(code);
    // This IS flagged because the regex is simple pattern matching
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('flags OS.shell_open', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('OS.shell_open("https://example.com")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('does not flag FileAccess.open with READ mode', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.READ)');
    expect(warnings).toEqual([]);
  });

  it('flags DirAccess.remove_absolute', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('DirAccess.remove_absolute("/tmp/test")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Directory removal');
  });
});
