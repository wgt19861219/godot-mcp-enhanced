import { expect } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genSignalConnectScript,
  genSignalDisconnectScript,
  genSignalEmitScript,
  genSignalListScript,
} from '../src/tools/signal-ops.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 4 signal tool names', () => {
    expect(TOOL_NAMES.length).toBe(4);
  });
  it('includes signal_connect', () => {
    expect(TOOL_NAMES.includes('signal_connect')).toBeTruthy();
  });
  it('includes signal_disconnect', () => {
    expect(TOOL_NAMES.includes('signal_disconnect')).toBeTruthy();
  });
  it('includes signal_emit', () => {
    expect(TOOL_NAMES.includes('signal_emit')).toBeTruthy();
  });
  it('includes signal_list', () => {
    expect(TOOL_NAMES.includes('signal_list')).toBeTruthy();
  });
});

// ─── genSignalConnectScript ─────────────────────────────────────────────────

describe('genSignalConnectScript', () => {
  it('generates GDScript with connect call', () => {
    const script = genSignalConnectScript('/root/Player', 'hit', '/root/UI', 'on_hit');
    expect(script.includes('source.connect("hit"')).toBeTruthy();
    expect(script.includes('Callable(target, "on_hit")')).toBeTruthy();
    expect(script.includes('_mcp_get_node')).toBeTruthy();
  });
  it('includes flags when provided', () => {
    const script = genSignalConnectScript('/root/A', 'sig', '/root/B', 'fn', 4);
    expect(script.includes('4)')).toBeTruthy();
  });
});

// ─── genSignalDisconnectScript ──────────────────────────────────────────────

describe('genSignalDisconnectScript', () => {
  it('generates GDScript with disconnect call', () => {
    const script = genSignalDisconnectScript('/root/Player', 'hit', '/root/UI', 'on_hit');
    expect(script.includes('source.disconnect("hit"')).toBeTruthy();
    expect(script.includes('Callable(target, "on_hit")')).toBeTruthy();
    expect(script.includes('_mcp_output("disconnected"')).toBeTruthy();
  });
});

// ─── genSignalEmitScript ───────────────────────────────────────────────────

describe('genSignalEmitScript', () => {
  it('generates GDScript with emit_signal call (no args)', () => {
    const script = genSignalEmitScript('/root/Player', 'died');
    expect(script.includes('source.emit_signal("died")')).toBeTruthy();
    expect(script.includes('_mcp_output("emitted"')).toBeTruthy();
  });
  it('serializes string args', () => {
    const script = genSignalEmitScript('/root/Player', 'msg', ['hello']);
    expect(script.includes('"hello"')).toBeTruthy();
  });
  it('serializes number args', () => {
    const script = genSignalEmitScript('/root/Player', 'damage', [42]);
    expect(script.includes('42')).toBeTruthy();
  });
  it('serializes boolean args', () => {
    const script = genSignalEmitScript('/root/Player', 'toggle', [true]);
    expect(script.includes('true')).toBeTruthy();
  });
  it('serializes null args', () => {
    const script = genSignalEmitScript('/root/Player', 'reset', [null]);
    expect(script.includes('null')).toBeTruthy();
  });
  it('throws on unsupported arg types', () => {
    expect(() => genSignalEmitScript('/root/A', 'sig', [{}])).toThrow(/basic types/);
  });
});

// ─── genSignalListScript ───────────────────────────────────────────────────

describe('genSignalListScript', () => {
  it('generates GDScript with get_signal_list call', () => {
    const script = genSignalListScript('/root/Player');
    expect(script.includes('node.get_signal_list()')).toBeTruthy();
    expect(script.includes('_mcp_output("signals"')).toBeTruthy();
    expect(script.includes('_mcp_get_node')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      expect(names.includes(tn)).toBeTruthy();
    }
  });
  it('each definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.required).toBeTruthy();
    }
  });
});
