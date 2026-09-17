/**
 * 报告③阶段1：GDScript 纯函数行为测试。
 *
 * 用 executeGdscript 在 headless `--script` 模式跑 addons/godot_mcp_server/commands/command_helpers.gd
 * 的纯函数（values_equal / parse_vec3 / has_path_traversal），补强 GDScript 侧零行为覆盖
 * （capability-matrix L2=0/35 自承认）。command_helpers.gd 有 class_name CommandHelpers 且无 @tool，
 * gdscript-check fixture 启用了插件，class cache 含 CommandHelpers，可直接 CommandHelpers.xxx()。
 *
 * 复用 e2e-p1-p5.test.ts 的 skipIf 无 GODOT_PATH 模式（防 CI 假绿）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeGdscript } from '../src/gdscript-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const CHECK_PROJECT = resolve(__dirname, 'fixtures', 'gdscript-check');

if (!hasGodot) {
  process.stderr.write(
    `[gdscript-unit-SKIP] 未找到 GODOT_PATH (${GODOT_PATH}) — GDScript 纯函数测试将被跳过。\n` +
    `  设置 GODOT_PATH 环境变量以启用（CI godot-matrix job 已配置）。\n`,
  );
}

/** 从 executeGdscript 结果里按 key 找 _mcp_output 收集的值 */
function out(result: { outputs: { key: string; value: string }[] }, key: string): string {
  const entry = result.outputs.find(o => o.key === key);
  if (!entry) throw new Error(`未找到 _mcp_output key="${key}"，已有 keys: ${result.outputs.map(o => o.key).join(',')}`);
  return entry.value;
}

describe.skipIf(!hasGodot)('CommandHelpers 纯函数行为测试（报告③阶段1）', () => {
  it('values_equal: 同类型直接 ==', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: CHECK_PROJECT,
      timeout: 30,
      code: [
        '_mcp_output("int_eq", str(CommandHelpers.values_equal(1, 1)))',
        '_mcp_output("str_eq", str(CommandHelpers.values_equal("a", "a")))',
        '_mcp_output("vec3_same", str(CommandHelpers.values_equal(Vector3(1, 2, 3), Vector3(1, 2, 3))))',
        '_mcp_output("int_ne", str(CommandHelpers.values_equal(1, 2)))',
        '_mcp_done()',
      ].join('\n'),
    });
    expect(result.run_success).toBe(true);
    expect(out(result, 'int_eq')).toBe('true');
    expect(out(result, 'str_eq')).toBe('true');
    expect(out(result, 'vec3_same')).toBe('true');
    expect(out(result, 'int_ne')).toBe('false');
  });

  it('values_equal: Array ↔ Vector3 分量比（C9 修复点，JSON [1,2,3] 对 Vector3）', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: CHECK_PROJECT,
      timeout: 30,
      code: [
        '_mcp_output("arr_vec3", str(CommandHelpers.values_equal(Vector3(1, 2, 3), [1, 2, 3])))',
        '_mcp_output("arr_vec3_ne", str(CommandHelpers.values_equal(Vector3(1, 2, 3), [1, 2, 4])))',
        '_mcp_output("arr_short", str(CommandHelpers.values_equal(Vector3(1, 2, 3), [1, 2])))',
        '_mcp_output("arr_vec2", str(CommandHelpers.values_equal(Vector2(1, 2), [1, 2])))',
        '_mcp_done()',
      ].join('\n'),
    });
    expect(result.run_success).toBe(true);
    expect(out(result, 'arr_vec3')).toBe('true');
    expect(out(result, 'arr_vec3_ne')).toBe('false');
    expect(out(result, 'arr_short')).toBe('false');   // 长度不足，分量不比
    expect(out(result, 'arr_vec2')).toBe('true');
  });

  it('values_equal: int↔float 数字宽松；bool↔int fallback→false（语义正确）', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: CHECK_PROJECT,
      timeout: 30,
      code: [
        '_mcp_output("int_float", str(CommandHelpers.values_equal(1, 1.0)))',
        '_mcp_output("float_int", str(CommandHelpers.values_equal(1.0, 1)))',
        '_mcp_output("bool_int", str(CommandHelpers.values_equal(true, 1)))',
        '_mcp_output("bool_int_ne", str(CommandHelpers.values_equal(true, 0)))',
        '_mcp_done()',
      ].join('\n'),
    });
    expect(result.run_success).toBe(true);
    expect(out(result, 'int_float')).toBe('true');
    expect(out(result, 'float_int')).toBe('true');
    // bool↔int 走 str fallback：str(true)="true" ≠ str(1)="1" → false（文档明确语义正确）
    expect(out(result, 'bool_int')).toBe('false');
    expect(out(result, 'bool_int_ne')).toBe('false');
  });

  it('parse_vec3: Array / PackedFloat64Array / 短数组 / 非 array', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: CHECK_PROJECT,
      timeout: 30,
      code: [
        '_mcp_output("arr", str(CommandHelpers.parse_vec3([1.0, 2.0, 3.0])))',
        '_mcp_output("packed", str(CommandHelpers.parse_vec3(PackedFloat64Array([4, 5, 6]))))',
        '_mcp_output("short", str(CommandHelpers.parse_vec3([1, 2])))',
        '_mcp_output("non_arr", str(CommandHelpers.parse_vec3("not array")))',
        '_mcp_done()',
      ].join('\n'),
    });
    expect(result.run_success).toBe(true);
    expect(out(result, 'arr')).toBe('(1.0, 2.0, 3.0)');
    expect(out(result, 'packed')).toBe('(4.0, 5.0, 6.0)');
    expect(out(result, 'short')).toBe('(0.0, 0.0, 0.0)');     // 短数组返回 ZERO
    expect(out(result, 'non_arr')).toBe('(0.0, 0.0, 0.0)');   // 非 array 返回 ZERO
  });

  it('has_path_traversal: ../ 各形态 + 正常路径', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: CHECK_PROJECT,
      timeout: 30,
      code: [
        '_mcp_output("mid", str(CommandHelpers.has_path_traversal("a/../b")))',
        '_mcp_output("prefix", str(CommandHelpers.has_path_traversal("../etc")))',
        '_mcp_output("suffix", str(CommandHelpers.has_path_traversal("a/..")))',
        '_mcp_output("only", str(CommandHelpers.has_path_traversal("..")))',
        '_mcp_output("clean", str(CommandHelpers.has_path_traversal("res://scripts/a.gd")))',
        '_mcp_done()',
      ].join('\n'),
    });
    expect(result.run_success).toBe(true);
    expect(out(result, 'mid')).toBe('true');
    expect(out(result, 'prefix')).toBe('true');
    expect(out(result, 'suffix')).toBe('true');
    expect(out(result, 'only')).toBe('true');
    expect(out(result, 'clean')).toBe('false');
  });
});

// ─── Task A(2026-09-17 架构审查 H-1/H-2): mcp_bridge 参数守卫行为测试 ──────────
// 毒参数(null/容器)直驱 fixture 内 mcp_bridge.gd 实例(.new() 不入树 → _ready 不触发,
// 零服务器副作用),断言守卫生效:无 SCRIPT ERROR + 可读回退,而非裸转中断。
// 执行模式取舍(对齐 gdscript-bridge-error-capture.test.ts 踩坑记录):本文件既有的
// _mcp_output/_mcp_done(wrapper 模式)对 mcp_bridge 实例字段绑定有怪异行为,故本段
// 用 SceneTree full-class 模式 + print("RESULT key=") 解析;run_success=false 是预期
// (RID leak cleanup),真失败信号 = SCRIPT ERROR / Parse Error,断言基于 RESULT 行。
async function runBridgeGuardProbe(bodyLines: string[]): Promise<{ realError: boolean; values: Record<string, string> }> {
  const code = [
    'extends SceneTree',
    '',
    'func _init():',
    '\tvar b = load("res://src/scripts/mcp_bridge.gd").new()',
    ...bodyLines.map(l => '\t' + l),
    '\tquit()',
  ].join('\n');
  const result = await executeGdscript({
    godotPath: GODOT_PATH,
    projectPath: CHECK_PROJECT,
    timeout: 30,
    code,
  });
  const raw = result.raw_output;
  const realError = /\b(Parse Error|SCRIPT ERROR|Invalid |ENGINE ERROR)\b/.test(raw);
  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^RESULT\s+(\S+?)=(.*)$/);
    if (m) {
      values[m[1]!] = m[2]!;
    }
  }
  return { realError, values };
}

describe.skipIf(!hasGodot)('mcp_bridge 参数守卫行为测试(H-1/H-2 毒参数负向)', () => {
  it('_math_comp 分量白名单: 容器/null/非法数字串分量 → null;数值与合法数字串放行', async () => {
    const { realError, values } = await runBridgeGuardProbe([
      'print("RESULT dict_container=" + str(b._math_comp({"x": {}}, 0, "x")))',
      'print("RESULT arr_container=" + str(b._math_comp([[], 2], 0, "x")))',
      'print("RESULT comp_null=" + str(b._math_comp([null, 2], 0, "x")))',
      'print("RESULT bad_str=" + str(b._math_comp({"x": "abc"}, 0, "x")))',
      'print("RESULT good_str=" + str(b._math_comp({"x": "3.5"}, 0, "x")))',
      'print("RESULT good_int=" + str(b._math_comp([7, 2], 1, "y")))',
      'print("RESULT missing_key=" + str(b._math_comp({"y": 2}, 0, "x")))',
      'print("RESULT oob_index=" + str(b._math_comp([1], 5, "x")))',
    ]);
    expect(realError, '不应有 SCRIPT ERROR(容器分量穿透到 float() 即崩)').toBe(false);
    expect(values.dict_container).toBe('<null>');
    expect(values.arr_container).toBe('<null>');
    expect(values.comp_null).toBe('<null>');
    expect(values.bad_str).toBe('<null>');
    expect(values.good_str).toBe('3.5');
    expect(values.good_int).toBe('2');
    expect(values.missing_key).toBe('<null>');
    expect(values.oob_index).toBe('<null>');
  });

  it('_coerce_math_value 毒分量(game_write set_node_property position={"x":{}} 路径)→ null 无 SCRIPT ERROR,上游走 -8 可读错误', async () => {
    const { realError, values } = await runBridgeGuardProbe([
      'print("RESULT coerce_dict_poison=" + str(b._coerce_math_value(TYPE_VECTOR2, {"x": {}, "y": 2})))',
      'print("RESULT coerce_arr_poison=" + str(b._coerce_math_value(TYPE_VECTOR3, [{}, 2, 3])))',
      'print("RESULT coerce_valid=" + str(b._coerce_math_value(TYPE_VECTOR2, {"x": 1.5, "y": 2})))',
    ]);
    expect(realError, '不应有 SCRIPT ERROR(H-1: float({}) = Nonexistent float constructor)').toBe(false);
    expect(values.coerce_dict_poison).toBe('<null>');   // 上游 _cmd_set_node_property 返 -8 可读错误
    expect(values.coerce_arr_poison).toBe('<null>');
    expect(values.coerce_valid).toBe('(1.5, 2.0)');
  });

  it('_int_guarded 守卫全形态: 整值/整值 float/合法数字串放行,其余回 fallback', async () => {
    const { realError, values } = await runBridgeGuardProbe([
      'print("RESULT ig_int=" + str(b._int_guarded(7, -1)))',
      'print("RESULT ig_float_whole=" + str(b._int_guarded(4.0, -1)))',
      'print("RESULT ig_float_frac=" + str(b._int_guarded(4.7, -1)))',
      'print("RESULT ig_inf=" + str(b._int_guarded(INF, -1)))',
      'print("RESULT ig_nan=" + str(b._int_guarded(NAN, -1)))',
      'print("RESULT ig_str=" + str(b._int_guarded("42", -1)))',
      'print("RESULT ig_str_float=" + str(b._int_guarded("4.0", -1)))',
      'print("RESULT ig_badstr=" + str(b._int_guarded("abc", -1)))',
      'print("RESULT ig_null=" + str(b._int_guarded(null, -1)))',
      'print("RESULT ig_dict=" + str(b._int_guarded({}, -1)))',
      'print("RESULT ig_arr=" + str(b._int_guarded([], -1)))',
      'print("RESULT ig_bool=" + str(b._int_guarded(true, -1)))',
    ]);
    expect(realError, '不应有 SCRIPT ERROR').toBe(false);
    expect(values.ig_int).toBe('7');
    expect(values.ig_float_whole).toBe('4');
    expect(values.ig_float_frac).toBe('-1');
    expect(values.ig_inf).toBe('-1');      // is_finite 拦截
    expect(values.ig_nan).toBe('-1');
    expect(values.ig_str).toBe('42');
    expect(values.ig_str_float).toBe('-1'); // "4.0" 非合法 int 串(is_valid_int 拒)
    expect(values.ig_badstr).toBe('-1');
    expect(values.ig_null).toBe('-1');
    expect(values.ig_dict).toBe('-1');
    expect(values.ig_arr).toBe('-1');
      expect(values.ig_bool).toBe('-1');     // bool 在 Godot 4 Variant 里不是 int(true is int == false)
  });

  it('_num 守卫既有行为复核(float 裸转统一复用面): null/容器 → fallback', async () => {
    const { realError, values } = await runBridgeGuardProbe([
      'print("RESULT num_null=" + str(b._num(null, 0.0)))',
      'print("RESULT num_dict=" + str(b._num({}, 0.0)))',
      'print("RESULT num_arr=" + str(b._num([], 7.5)))',
      'print("RESULT num_badstr=" + str(b._num("abc", 7.5)))',
      'print("RESULT num_str=" + str(b._num("3.5", 0.0)))',
    ]);
    expect(realError, '不应有 SCRIPT ERROR').toBe(false);
    expect(values.num_null).toBe('0.0');
    expect(values.num_dict).toBe('0.0');
    expect(values.num_arr).toBe('7.5');
    expect(values.num_badstr).toBe('7.5');
    expect(values.num_str).toBe('3.5');
  });
});
