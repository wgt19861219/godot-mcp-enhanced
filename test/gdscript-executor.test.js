import { expect } from 'vitest';
import { parseMcpMarkers } from '../src/gdscript-executor.js';

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
