import { expect } from 'vitest';
import fc from 'fast-check';
import { isErrorFalsePositive, KNOWN_BASE_METHODS } from '../src/tools/validation.js';

// ─── Helper: build a realistic Godot headless parser error line ──────────────
function parseError(message) {
  return `SCRIPT ERROR: Parse Error: ${message}`;
}
function notFoundInBase(method) {
  return parseError(`Function "${method}()" not found in base self.`);
}
function propNotFoundInBase(prop) {
  return parseError(`Identifier "${prop}" not found in base self.`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validation-filter: KNOWN_BASE_METHODS coverage', () => {

  describe('original whitelist entries', () => {
    const originalMethods = [
      'add_child', 'remove_child', 'get_child', 'get_children',
      'get_parent', 'get_tree', 'get_node', 'queue_free',
      'move_and_slide', 'velocity', 'position', 'rotation', 'scale',
      'visible', 'modulate', 'z_index', 'emit_signal', 'connect',
      'wait_time', 'autostart', 'one_shot',
    ];

    for (const method of originalMethods) {
      it(`filters "${method}" as method call`, () => {
        expect(isErrorFalsePositive(notFoundInBase(method))).toBeTruthy();
      });
    }
  });

  describe('Input events', () => {
    const inputMethods = [
      'is_action_pressed', 'is_action_just_pressed', 'is_action_just_released',
      'get_vector', 'get_strength', 'mouse_mode', 'set_mouse_mode',
    ];
    for (const method of inputMethods) {
      it(`filters "${method}" (Input.is_action_pressed pattern)`, () => {
        const line = parseError(`Function "${method}()" not found in base self.`);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Area2D / Collision', () => {
    const collisionItems = [
      'get_overlapping_bodies', 'get_overlapping_areas',
      'monitoring', 'monitorable', 'collision_mask', 'collision_layer',
      'set_collision_mask_value',
    ];
    for (const item of collisionItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('AnimationPlayer', () => {
    const animItems = [
      'play', 'stop', 'pause', 'seek',
      'get_current_animation_position', 'current_animation', 'speed_scale', 'autoplay',
    ];
    for (const item of animItems) {
      it(`filters "${item}"`, () => {
        const line = notFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('AudioStreamPlayer', () => {
    const audioItems = ['playing', 'volume_db', 'pitch_scale', 'stream'];
    for (const item of audioItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('TileMap / TileMapLayer', () => {
    const tileItems = ['set_cell', 'get_cell', 'get_used_cells', 'map_to_local', 'local_to_map'];
    for (const item of tileItems) {
      it(`filters "${item}"`, () => {
        const line = notFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Sprite2D / Texture', () => {
    const spriteItems = ['texture', 'hframes', 'vframes', 'frame', 'region_enabled', 'region_rect'];
    for (const item of spriteItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Label / RichTextLabel', () => {
    const labelItems = [
      'horizontal_alignment', 'vertical_alignment', 'autowrap_mode',
      'bbcode_text', 'append_text', 'scroll_to_line',
    ];
    for (const item of labelItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Timer extended', () => {
    const timerItems = ['start', 'time_left', 'paused'];
    for (const item of timerItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Tween', () => {
    const tweenItems = ['tween_property', 'tween_callback', 'set_parallel', 'set_trans', 'set_ease'];
    for (const item of tweenItems) {
      it(`filters "${item}"`, () => {
        const line = notFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });

  describe('Window', () => {
    const windowItems = ['get_window', 'set_flag', 'borderless', 'transparent'];
    for (const item of windowItems) {
      it(`filters "${item}"`, () => {
        const line = propNotFoundInBase(item);
        expect(isErrorFalsePositive(line)).toBeTruthy();
      });
    }
  });
});

describe('validation-filter: await rule', () => {
  it('filters lines containing await keyword', () => {
    const line = parseError('Identifier "some_coroutine" not found in base self. at: await some_coroutine()');
    expect(isErrorFalsePositive(line)).toBeTruthy();
  });

  it('does NOT filter real await parse errors without "not found in base self"', () => {
    // Real parse errors about await syntax should NOT be filtered
    const line = 'SCRIPT ERROR: Parse Error: Cannot use await outside of a coroutine function.';
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  it('does NOT filter a real error line without await or whitelist match', () => {
    const line = parseError('Identifier "unknown_variable" not found in the current scope.');
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });
});

describe('validation-filter: non-whitelist items pass through', () => {
  it('does NOT filter unknown method "foobar_custom"', () => {
    const line = notFoundInBase('foobar_custom');
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  it('does NOT filter unknown property "xyz_private"', () => {
    const line = propNotFoundInBase('xyz_private');
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  it('does NOT filter real syntax errors', () => {
    const line = parseError('Unexpected token ".".');
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });
});

describe('validation-filter: no duplicate entries in whitelist', () => {
  it('KNOWN_BASE_METHODS has no duplicates', () => {
    const seen = new Set();
    const dupes = [];
    for (const item of KNOWN_BASE_METHODS) {
      if (seen.has(item)) dupes.push(item);
      seen.add(item);
    }
    expect(dupes.length).toBe(0);
  });
});

describe('Property: validation-filter fuzz', () => {
  it('isErrorFalsePositive never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (line) => {
        expect(() => isErrorFalsePositive(line)).not.toThrow();
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('isErrorFalsePositive returns boolean for any input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (line) => {
        const result = isErrorFalsePositive(line);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });
});
