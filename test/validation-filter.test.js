import { expect } from 'vitest';
import fc from 'fast-check';
import { isErrorFalsePositive, KNOWN_BASE_METHODS, stripProjectPrefix } from '../src/tools/validation.js';

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

// ─── Task D2 (2026-11-12): autoload/class_name 符号集误报过滤 ────────────────
// 背景: headless 验证器无法实例化 autoload 单例/解析跨文件 class_name,引用它们的
// 合法脚本报 Identifier "X" not declared → 计入 errors → edit_script 误回滚。
// run_and_verify 侧 error-analyzer 早有 headless_limitation 分类,但
// batchValidateScripts(edit_script 自动验证链)未接线符号集——D2 补齐。

describe('validation-filter: autoload/class_name 符号集规则 (Task D2)', () => {
  const symbols = { autoloadNames: ['GameData'], classNames: ['PlayerStats'] };

  it('filters Identifier "GameData" not declared when GameData is a declared autoload', () => {
    const line = parseError('Identifier "GameData" not declared in the current scope.');
    expect(isErrorFalsePositive(line, symbols)).toBeTruthy();
  });

  it('filters Identifier "PlayerStats" not found when PlayerStats is a global class_name', () => {
    const line = parseError('Identifier "PlayerStats" not found.');
    expect(isErrorFalsePositive(line, symbols)).toBeTruthy();
  });

  it('filters any Identifier reference to an autoload symbol (不限 not found,对齐 error-analyzer 语义)', () => {
    const line = parseError('Cannot call method on Identifier "GameData".');
    expect(isErrorFalsePositive(line, symbols)).toBeTruthy();
  });

  it('does NOT filter unknown identifiers even when symbols are supplied', () => {
    const line = parseError('Identifier "typo_name" not declared in the current scope.');
    expect(isErrorFalsePositive(line, symbols)).toBeFalsy();
  });

  it('does NOT filter autoload-named identifiers when no symbols supplied (向后兼容)', () => {
    const line = parseError('Identifier "GameData" not declared in the current scope.');
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  it('empty symbol set behaves like no symbols', () => {
    const line = parseError('Identifier "GameData" not declared in the current scope.');
    expect(isErrorFalsePositive(line, { autoloadNames: [], classNames: [] })).toBeFalsy();
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

// ─── stripProjectPrefix: relOf 双形态(批 K P2, 2026-08-16) ────────────────
// 回归背景: batchValidateScripts 原实现用 pathSep 精确前缀匹配,正斜杠形态的
// project_path 下失配 → 绝对路径泄漏进 res:// 列表 → script_health 全量误报
// load null(历史 0404f75 引入)。修复后两侧分隔符归一化,双形态等价。

describe('stripProjectPrefix: 双分隔符形态等价(批 K P2)', () => {
  const proj = 'D:/work/demo';  // 正斜杠形态(修复前触发误报的形态)

  it('正斜杠 project_path + 正斜杠文件路径 → 正确剥前缀', () => {
    expect(stripProjectPrefix('D:/work/demo/scripts/a.gd', proj)).toBe('scripts/a.gd');
  });

  it('正斜杠 project_path + 反斜杠文件路径 → 正确剥前缀(修复前泄漏绝对路径)', () => {
    expect(stripProjectPrefix('D:\\work\\demo\\scripts\\a.gd', proj)).toBe('scripts/a.gd');
  });

  it('反斜杠 project_path + 正斜杠文件路径 → 正确剥前缀(反向失配)', () => {
    expect(stripProjectPrefix('D:/work/demo/scripts/a.gd', 'D:\\work\\demo')).toBe('scripts/a.gd');
  });

  it('反斜杠 project_path + 反斜杠文件路径 → 既有门禁形态不回归', () => {
    expect(stripProjectPrefix('D:\\work\\demo\\scripts\\a.gd', 'D:\\work\\demo')).toBe('scripts/a.gd');
  });

  it('project_path 带尾斜杠 → 不重复剥/不残留', () => {
    expect(stripProjectPrefix('D:/work/demo/scripts/a.gd', 'D:/work/demo/')).toBe('scripts/a.gd');
  });

  it('前缀不匹配的外部路径 → 原样返回(不误剥)', () => {
    expect(stripProjectPrefix('E:/other/x.gd', proj)).toBe('E:/other/x.gd');
  });
});
