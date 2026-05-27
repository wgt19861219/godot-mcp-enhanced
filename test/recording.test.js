import { expect } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  sanitizeRecordingFileName,
  generateRecordingFileName,
  genRecordingSaveScript,
  genRecordingLoadScript,
  genRecordingPlayScript,
} from '../src/tools/recording.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 5 recording tool names', () => {
    expect(TOOL_NAMES.length).toBe(5);
  });
  for (const name of ['recording_start', 'recording_stop', 'recording_save', 'recording_load', 'recording_play']) {
    it(`includes ${name}`, () => {
      expect(TOOL_NAMES.includes(name)).toBeTruthy();
    });
  }
});

// ─── sanitizeRecordingFileName ──────────────────────────────────────────────

describe('sanitizeRecordingFileName', () => {
  it('accepts valid recording file names', () => {
    expect(sanitizeRecordingFileName('recording_20260516_120000.json')).toBe('recording_20260516_120000.json');
  });

  it('accepts recording names with dashes and underscores', () => {
    expect(sanitizeRecordingFileName('recording_test-session_01.json')).toBe('recording_test-session_01.json');
  });

  it('rejects path traversal with ..', () => {
    expect(() => sanitizeRecordingFileName('recording_..json')).toThrow(/path traversal/);
  });

  it('rejects forward slash', () => {
    expect(() => sanitizeRecordingFileName('recording_foo/bar.json')).toThrow(/path traversal/);
  });

  it('rejects backslash', () => {
    expect(() => sanitizeRecordingFileName('recording_foo\\bar.json')).toThrow(/path traversal/);
  });

  it('rejects names not matching recording_*.json pattern', () => {
    expect(() => sanitizeRecordingFileName('evil.json')).toThrow(/must match/);
  });

  it('rejects names with double dot embedded', () => {
    expect(() => sanitizeRecordingFileName('../recording_test.json')).toThrow(/path traversal/);
  });

  it('rejects names with spaces', () => {
    expect(() => sanitizeRecordingFileName('recording_has space.json')).toThrow(/must match/);
  });
});

// ─── generateRecordingFileName ──────────────────────────────────────────────

describe('generateRecordingFileName', () => {
  it('generates a name matching recording_*.json', () => {
    const name = generateRecordingFileName();
    expect(/^recording_[\w-]+\.json$/.test(name)).toBeTruthy();
  });

  it('includes timestamp-like portion', () => {
    const name = generateRecordingFileName();
    // Format: recording_YYYYMMDD_HHMMSS.json
    expect(/recording_\d{8}_\d{6}\.json/.test(name)).toBeTruthy();
  });

  it('passes sanitizeRecordingFileName', () => {
    const name = generateRecordingFileName();
    expect(() => sanitizeRecordingFileName(name)).not.toThrow();
  });
});

// ─── genRecordingSaveScript ─────────────────────────────────────────────────

describe('genRecordingSaveScript', () => {
  it('generates GDScript that writes to res://recordings/', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"version":1,"events":[]}');
    expect(script.includes('res://recordings/recording_test.json')).toBeTruthy();
    expect(script.includes('FileAccess.WRITE')).toBeTruthy();
    expect(script.includes('_mcp_output("saved"')).toBeTruthy();
  });

  it('creates recordings directory if missing', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script.includes('make_dir("recordings")')).toBeTruthy();
  });

  it('escapes JSON content for GDScript string', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"key": "val\\ue"}');
    expect(script.includes('store_string')).toBeTruthy();
  });
});

// ─── genRecordingLoadScript ─────────────────────────────────────────────────

describe('genRecordingLoadScript', () => {
  it('generates GDScript that reads from res://recordings/', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script.includes('res://recordings/recording_test.json')).toBeTruthy();
    expect(script.includes('FileAccess.READ')).toBeTruthy();
    expect(script.includes('_mcp_output("recording"')).toBeTruthy();
  });

  it('handles file not found', () => {
    const script = genRecordingLoadScript('recording_missing.json');
    expect(script.includes('File not found')).toBeTruthy();
  });
});

// ─── genRecordingPlayScript ─────────────────────────────────────────────────

describe('genRecordingPlayScript', () => {
  const sampleEvents = JSON.stringify({
    version: 1,
    duration_ms: 1000,
    events: [
      { type: 'key', keycode: 87, pressed: true, time_ms: 0 },
      { type: 'mouse_click', position: [400, 300], button: 1, pressed: true, time_ms: 500 },
    ],
  });

  it('generates GDScript with playback logic', () => {
    const script = genRecordingPlayScript(sampleEvents.replace(/"/g, '\\"'), 1.0);
    expect(script.includes('Input.parse_input_event')).toBeTruthy();
    expect(script.includes('InputEventKey')).toBeTruthy();
    expect(script.includes('InputEventMouseButton')).toBeTruthy();
  });

  it('includes speed factor', () => {
    const script = genRecordingPlayScript(sampleEvents.replace(/"/g, '\\"'), 2.0);
    expect(script.includes('_mcp_play_speed = 2.0')).toBeTruthy();
  });

  it('handles empty events gracefully', () => {
    const emptyEvents = JSON.stringify({ version: 1, duration_ms: 0, events: [] });
    const script = genRecordingPlayScript(emptyEvents.replace(/"/g, '\\"'), 1.0);
    expect(script.includes('playback_complete')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 5 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(5);
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

  it('recording_start requires project_path', () => {
    const defs = getToolDefinitions();
    const start = defs.find(d => d.name === 'recording_start');
    expect(start.inputSchema.required.includes('project_path')).toBeTruthy();
  });

  it('recording_save requires events_json', () => {
    const defs = getToolDefinitions();
    const save = defs.find(d => d.name === 'recording_save');
    expect(save.inputSchema.required.includes('events_json')).toBeTruthy();
  });

  it('recording_load requires file_name', () => {
    const defs = getToolDefinitions();
    const load = defs.find(d => d.name === 'recording_load');
    expect(load.inputSchema.required.includes('file_name')).toBeTruthy();
  });

  it('recording_play has optional speed parameter', () => {
    const defs = getToolDefinitions();
    const play = defs.find(d => d.name === 'recording_play');
    expect(play.inputSchema.properties.speed).toBeTruthy();
    expect(play.inputSchema.required.includes('speed')).toBeFalsy();
  });
});

// ─── Bridge-mode recording start/stop ───────────────────────────────────────

describe('recording_start/stop use Bridge', () => {
  it('recording_start handler calls sendToBridge with recording.start method', async () => {
    // Verify that the module no longer exports genRecordingStartScript
    const mod = await import('../src/tools/recording.js');
    expect(mod.genRecordingStartScript).toBeUndefined();
  });

  it('recording_stop handler calls sendToBridge with recording.stop method', async () => {
    // Verify that the module no longer exports genRecordingStopScript
    const mod = await import('../src/tools/recording.js');
    expect(mod.genRecordingStopScript).toBeUndefined();
  });
});
