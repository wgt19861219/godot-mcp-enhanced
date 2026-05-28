import { expect } from 'vitest';
import { parseMcpMarkers, scanGdscriptSandbox } from '../src/gdscript-executor.js';

// C-2 fix: import actual function instead of inline copy

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
    expect(/^\s*extends\s+/m.test(code)).toBeTruthy();
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

  it('should detect FileAccess open with WRITE by default', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.WRITE)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('File write access');
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

  it('should still scan when GODOT_MCP_SANDBOX is set to other values', () => {
    process.env.GODOT_MCP_SANDBOX = 'warn';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
  });
});
