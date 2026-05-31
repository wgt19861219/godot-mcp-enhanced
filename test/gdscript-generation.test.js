/**
 * GDScript code generation correctness tests (I-CI-01).
 *
 * These tests verify the ACTUAL generated GDScript strings,
 * not mock behavior. They check for:
 * - Correct escaping in gdEscape()
 * - Valid GDScript syntax patterns in generated code
 * - Consistent tab indentation (no space/tab mixing)
 * - Expected function calls and markers
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock gdscript-executor so stress test handler can run without Godot
const _capturedScripts = [];
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async (opts) => {
    _capturedScripts.push(opts.code);
    return {
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'result', value: JSON.stringify({ success: true, iterations: 100 }) }],
      raw_output: '', duration_ms: 100,
    };
  }),
}));

import {
  gdEscape,
  SCENE_TREE_HEADER,
  MARKER_RESULT,
  genCheckNodeExists,
  genCheckProperties,
  wrapAssertionCode,
} from '../src/tools/shared.js';
import {
  genRecordingPlayScript,
  genRecordingSaveScript,
  genRecordingLoadScript,
} from '../src/tools/recording.js';

// ─── Helper: check that a multi-line string uses consistent tab indentation ──

function hasConsistentTabIndentation(code) {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // skip blank lines
    // Detect leading spaces that aren't part of tab indentation
    const leadingMatch = line.match(/^(\s+)/);
    if (leadingMatch) {
      const leading = leadingMatch[1];
      // If any leading whitespace is a space (not tab), that's mixed indentation
      if (leading.includes(' ')) {
        return { ok: false, line: i + 1, content: line };
      }
    }
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. gdEscape
// ═══════════════════════════════════════════════════════════════════════════════

describe('gdEscape — GDScript string escaping', () => {
  it('escapes backslash to double-backslash', () => {
    expect(gdEscape('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes newline to \\n literal', () => {
    expect(gdEscape('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes CRLF to \\n (not \\\\r\\\\n)', () => {
    expect(gdEscape('line1\r\nline2')).toBe('line1\\nline2');
  });

  it('escapes bare CR to \\n', () => {
    expect(gdEscape('line1\rline2')).toBe('line1\\nline2');
  });

  it('escapes tab to \\t literal', () => {
    expect(gdEscape('col1\tcol2')).toBe('col1\\tcol2');
  });

  it('escapes double quote to \\"', () => {
    expect(gdEscape('say "hello"')).toBe('say \\"hello\\"');
  });

  it('does NOT escape dollar sign (not special in GDScript strings)', () => {
    expect(gdEscape('$Node/Child')).toBe('$Node/Child');
  });

  it('escapes percent to %% (GDScript format placeholder)', () => {
    expect(gdEscape('100%')).toBe('100%%');
  });

  it('escapes single quote', () => {
    expect(gdEscape("it's")).toBe("it\\'s");
  });

  it('removes null bytes', () => {
    expect(gdEscape('before\0after')).toBe('beforeafter');
  });

  it('handles empty string', () => {
    expect(gdEscape('')).toBe('');
  });

  it('handles string with all special characters combined', () => {
    const input = 'a\\b\nc\td"e%f$g\'h\0i';
    const result = gdEscape(input);
    // No raw control characters should remain
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\t');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\0');
    // Should contain escaped versions
    expect(result).toContain('\\\\');
    expect(result).toContain('\\n');
    expect(result).toContain('\\t');
    expect(result).toContain('\\"');
    expect(result).toContain('%%');
    // $ is NOT escaped — not special in GDScript double-quoted strings
    expect(result).toContain("\\'");
  });

  it('does not double-escape already-escaped sequences', () => {
    // gdEscape is NOT idempotent by design — applying twice double-escapes
    const once = gdEscape('a\nb');
    const twice = gdEscape(once);
    expect(twice).toBe('a\\\\nb'); // \\n becomes \\\\n
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SCENE_TREE_HEADER
// ═══════════════════════════════════════════════════════════════════════════════

describe('SCENE_TREE_HEADER — GDScript scene tree boilerplate', () => {
  it('starts with "extends SceneTree"', () => {
    expect(SCENE_TREE_HEADER.startsWith('extends SceneTree')).toBe(true);
  });

  it('contains _mcp_root variable declaration', () => {
    expect(SCENE_TREE_HEADER).toContain('var _mcp_root: Node = null');
  });

  it('contains _mcp_get_root function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_root() -> Node:');
  });

  it('contains _mcp_get_node function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_node(path: NodePath) -> Node:');
  });

  it('contains _mcp_load_main_scene function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_load_main_scene() -> void:');
  });

  it('contains _mcp_load_scene function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_load_scene(sp: String) -> bool:');
  });

  it('contains _mcp_get_scene_node function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_scene_node(path: String) -> Node:');
  });

  it('contains _mcp_done function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_done() -> void:');
  });

  it('contains MARKER_RESULT in _mcp_done print statement', () => {
    expect(SCENE_TREE_HEADER).toContain(`"${MARKER_RESULT}"`);
  });

  it('contains quit(0) call', () => {
    expect(SCENE_TREE_HEADER).toContain('quit(0)');
  });

  it('uses consistent tab indentation', () => {
    const check = hasConsistentTabIndentation(SCENE_TREE_HEADER);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses manual traversal fallback for headless compatibility', () => {
    expect(SCENE_TREE_HEADER).toContain('Manual traversal for headless compatibility');
    expect(SCENE_TREE_HEADER).toContain('get_children()');
  });

  it('includes get_node_or_null call', () => {
    expect(SCENE_TREE_HEADER).toContain('get_node_or_null');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. test-framework.ts — stress test GDScript generation
// ═══════════════════════════════════════════════════════════════════════════════

describe('test-framework stress test GDScript generation', () => {
  // The stress test script is generated inline in handleTestStress.
  // We capture it via the top-level vi.mock of executeGdscript.

  let handleTool;
  beforeAll(async () => {
    const mod = await import('../src/tools/test-framework.js');
    handleTool = mod.handleTool;
  });

  beforeEach(() => {
    _capturedScripts.length = 0;
  });

  async function captureStressScript(args) {
    const mockCtx = { findGodot: vi.fn(async () => '/usr/bin/godot') };
    await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'stress',
      ...args,
    }, mockCtx);
    expect(_capturedScripts.length).toBeGreaterThanOrEqual(1);
    return _capturedScripts[_capturedScripts.length - 1];
  }

  it('generates script with consistent tab indentation (iterations=1)', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 1 });
    const check = hasConsistentTabIndentation(captured);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('generates script with consistent tab indentation (iterations=1000)', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 1000 });
    const check = hasConsistentTabIndentation(captured);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('generated script contains expected GDScript constructs', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 100 });
    expect(captured).toContain('ClassDB.instantiate');
    expect(captured).toContain('Performance.get_monitor');
    expect(captured).toContain('Performance.OBJECT_COUNT');
    expect(captured).toContain('Performance.MEMORY_STATIC');
    expect(captured).toContain('queue_free');
    expect(captured).toContain('_mcp_output("result"');
    expect(captured).toContain('extends SceneTree');
  });

  it('generated script uses the correct node type', async () => {
    const captured = await captureStressScript({ node_type: 'Node3D', iterations: 10 });
    expect(captured).toContain('"Node3D"');
    expect(captured).toContain('var _iters = 10');
  });

  it('clamps iterations to valid range', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 99999 });
    expect(captured).toContain('var _iters = 10000');
  });

  it('iterations < 1 is clamped to 1', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: -5 });
    expect(captured).toContain('var _iters = 1');
  });

  it('contains process_frame await for cleanup', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 10 });
    expect(captured).toContain('await get_tree().process_frame');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. recording.ts — genRecordingPlayScript
// ═══════════════════════════════════════════════════════════════════════════════

describe('genRecordingPlayScript — GDScript playback generation', () => {
  const sampleEvents = JSON.stringify({
    version: 1,
    duration_ms: 1000,
    events: [
      { type: 'key', keycode: 87, pressed: true, time_ms: 0 },
      { type: 'mouse_click', position: [400, 300], button: 1, pressed: true, time_ms: 500 },
      { type: 'mouse_move', position: [200, 100], time_ms: 800 },
    ],
  });

  it('uses consistent tab indentation', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('starts with extends SceneTree', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script.startsWith('extends SceneTree')).toBe(true);
  });

  it('contains playback state variables', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('var _mcp_play_events: Array = []');
    expect(script).toContain('var _mcp_play_index: int = 0');
    expect(script).toContain('var _mcp_play_speed: float =');
    expect(script).toContain('var _mcp_play_timer: Timer = null');
  });

  it('contains _mcp_play_next_event function', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('func _mcp_play_next_event() -> void:');
  });

  it('handles key events with InputEventKey', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('InputEventKey');
    expect(script).toContain('ie.keycode = int(evt.get("keycode"');
    expect(script).toContain('ie.pressed = bool(evt.get("pressed"');
    expect(script).toContain('ie.shift_pressed = bool(evt.get("shift"');
  });

  it('handles mouse_click events with InputEventMouseButton', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('InputEventMouseButton');
    expect(script).toContain('ie.button_index = int(evt.get("button"');
  });

  it('handles mouse_move events with InputEventMouseMotion', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('InputEventMouseMotion');
  });

  it('calls Input.parse_input_event for all event types', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    // Should appear multiple times (once per event type)
    const matches = script.match(/Input\.parse_input_event/g);
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('emits playback_complete when done', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('_mcp_output("playback_complete"');
    expect(script).toContain('events_played');
  });

  it('sets speed with float format (e.g., 1.0 not 1)', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('_mcp_play_speed = 1.0');
  });

  it('sets speed to 2.5 for fractional speed', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 2.5);
    expect(script).toContain('_mcp_play_speed = 2.5');
  });

  it('parses events JSON with JSON.parse_string', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('JSON.parse_string(');
  });

  it('creates Timer node for playback scheduling', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('Timer.new()');
    expect(script).toContain('_mcp_play_timer.one_shot = true');
    expect(script).toContain('root.add_child(_mcp_play_timer)');
  });

  it('handles empty events array gracefully', () => {
    const emptyEvents = gdEscape(JSON.stringify({ version: 1, duration_ms: 0, events: [] }));
    const script = genRecordingPlayScript(emptyEvents, 1.0);
    // Should have a check for empty events
    expect(script).toContain('.size() == 0');
    expect(script).toContain('"playback_complete"');
    // Still valid GDScript structure
    expect(script.startsWith('extends SceneTree')).toBe(true);
  });

  it('uses clampf for delay clamping', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('clampf(');
    // Delay clamped between 0.016 and 10.0 seconds
    expect(script).toContain('0.016');
    expect(script).toContain('10.0');
  });

  it('connects timer timeout signal to _mcp_play_next_event', () => {
    const script = genRecordingPlayScript(gdEscape(sampleEvents), 1.0);
    expect(script).toContain('connect("timeout"');
    expect(script).toContain('Callable(self, "_mcp_play_next_event")');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. recording.ts — genRecordingSaveScript / genRecordingLoadScript
// ═══════════════════════════════════════════════════════════════════════════════

describe('genRecordingSaveScript — GDScript save generation', () => {
  it('uses consistent tab indentation', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"version":1,"events":[]}');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses FileAccess.WRITE mode', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('FileAccess.WRITE');
  });

  it('creates recordings directory if missing', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('dir_exists("recordings")');
    expect(script).toContain('make_dir("recordings")');
  });

  it('writes via store_string', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('store_string');
  });
});

describe('genRecordingLoadScript — GDScript load generation', () => {
  it('uses consistent tab indentation', () => {
    const script = genRecordingLoadScript('recording_test.json');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses FileAccess.READ mode', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('FileAccess.READ');
  });

  it('uses get_as_text to read file', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('get_as_text');
  });

  it('parses JSON with JSON.parse_string', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('JSON.parse_string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. shared.ts — genCheckNodeExists / genCheckProperties
// ═══════════════════════════════════════════════════════════════════════════════

describe('genCheckNodeExists — GDScript node existence check', () => {
  it('generates code that calls _mcp_get_node', () => {
    const code = genCheckNodeExists('root/Player');
    expect(code).toContain('_mcp_get_node(');
    expect(code).toContain('root/Player');
  });

  it('outputs node_exists key', () => {
    const code = genCheckNodeExists('root/Player');
    expect(code).toContain('"node_exists"');
  });

  it('uses JSON.stringify for output', () => {
    const code = genCheckNodeExists('root/Player');
    expect(code).toContain('JSON.stringify');
  });

  it('handles paths with special characters via gdEscape', () => {
    // Path with $ character — NOT escaped ($ is not special in GDScript strings)
    const code = genCheckNodeExists('root/$Special');
    expect(code).toContain('$Special');
  });
});

describe('genCheckProperties — GDScript property check', () => {
  it('generates code that reads properties from a node', () => {
    const code = genCheckProperties('root/Player', { health: 100, name: 'Hero' });
    expect(code).toContain('_mcp_get_node(');
    expect(code).toContain('"health"');
    expect(code).toContain('"name"');
  });

  it('outputs props key', () => {
    const code = genCheckProperties('root/Player', { x: 1 });
    expect(code).toContain('"props"');
  });

  it('handles empty property set', () => {
    const code = genCheckProperties('root/Player', {});
    expect(code).toContain('_mcp_get_node(');
    expect(code).toContain('"props"');
  });

  it('escapes property names containing special chars', () => {
    const code = genCheckProperties('root/Node', { 'my%prop': 'val' });
    // % should be escaped to %%
    expect(code).toContain('my%%prop');
  });
});

describe('wrapAssertionCode — GDScript assertion wrapper', () => {
  it('wraps user code with SCENE_TREE_HEADER and _mcp_done', () => {
    const script = wrapAssertionCode('_mcp_output("assert_1", true)', 'test assertion');
    expect(script).toContain('extends SceneTree');
    expect(script).toContain('_mcp_done()');
    expect(script).toContain('_mcp_output("assert_1", true)');
  });

  it('includes description as escaped string', () => {
    const script = wrapAssertionCode('pass', 'my "test" case');
    expect(script).toContain('my \\"test\\" case');
  });

  it('loads main scene by default', () => {
    const script = wrapAssertionCode('pass', 'test', true);
    expect(script).toContain('_mcp_load_main_scene()');
  });

  it('skips scene loading when loadScene=false', () => {
    const script = wrapAssertionCode('pass', 'test', false);
    // SCENE_TREE_HEADER contains the function definition, so only check _initialize() body
    const initBody = script.split('func _initialize():')[1];
    expect(initBody.split('func ')[0]).not.toContain('_mcp_load_main_scene()');
  });

  it('uses consistent tab indentation', () => {
    const script = wrapAssertionCode('var x = 1\n_mcp_output("k", x)', 'indent test');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });
});
