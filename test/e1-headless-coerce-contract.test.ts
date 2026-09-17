import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 批 E (2026-08-14) E-1 契约测试:headless 数学类型真转换(godot_operations.gd)。
// 修复前:数学分支只 _has_components 校验不转换,coerced 仍是原 Array/Dict,
// node.set(Array→数学类型) 是静默 no-op 但返 "edited successfully"(假成功)。
// 修复后:校验通过后 _coerce_math_value 按 prop_type 构造真数学类型。
//
// ⚠️ 局限(对齐 g1-playtest-control-contract 范式的过渡手段):源码字符串断言验证
// "修复模式落位"而非运行时行为。运行时行为由 headless 真跑覆盖(见 task-E-report.md)。

const gd = readFileSync('src/scripts/godot_operations.gd', 'utf8');

function sliceBetween(startAnchor: string, endAnchor: string): string {
  const start = gd.indexOf(startAnchor);
  expect(start, `锚点未找到: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf(endAnchor, start);
  expect(end, `结束锚点未找到: ${endAnchor}`).toBeGreaterThan(start);
  return gd.slice(start, end);
}

const coerceFn = () => sliceBetween('func _coerce_math_value', 'func _math_comp');
const compFn = () => sliceBetween('func _math_comp', 'func _set_property_with_coerce');
const setFn = () => sliceBetween('func _set_property_with_coerce', 'func _init');

describe('E-1: headless 数学类型真转换(godot_operations.gd)', () => {
  it('E1-a: _coerce_math_value 转换函数存在', () => {
    expect(gd.includes('func _coerce_math_value(prop_type: int, value: Variant) -> Variant'), '缺 _coerce_math_value 定义').toBe(true);
  });

  it('E1-b: DUPLICATE 三副本同步注释(源=command_helpers.gd)', () => {
    // 三副本:command_helpers.gd(源/editor) + godot_operations.gd(headless) + mcp_bridge.gd(bridge)
    // 改任一处须同步另外两处——同步注释是硬要求
    const s = sliceBetween('# E-1 (2026-08-14): MCP JSON Array/Dict 输入', 'func _coerce_math_value');
    expect(s.includes('addons/godot_mcp_server/commands/command_helpers.gd'), '缺源副本指向(command_helpers.gd)').toBe(true);
    expect(s.includes('src/scripts/mcp_bridge.gd'), '缺 bridge 副本指向').toBe(true);
    expect(s.toLowerCase().includes('duplicate'), '缺 DUPLICATE 同步声明').toBe(true);
  });

  it('E1-c: _set_property_with_coerce 数学分支调用转换,且先于 node.set', () => {
    const s = setFn();
    const callIdx = s.indexOf('_coerce_math_value(prop_type, value)');
    expect(callIdx, '数学分支缺 _coerce_math_value 调用').toBeGreaterThanOrEqual(0);
    // 转换必须先于 set(否则 no-op 复活)
    expect(callIdx, '转换应先于 node.set').toBeLessThan(s.indexOf('node.set(key, coerced)'));
    // 转换结果必须回写 coerced(原 bug:coerced 仍是原 Array/Dict)
    expect(s.includes('coerced = converted'), '转换结果未回写 coerced').toBe(true);
  });

  it('E1-d: 类型矩阵覆盖 11 种(Vector2/2i/3/3i/4/4i/Color/Plane/Quaternion/Rect2/2i)', () => {
    const s = coerceFn();
    for (const t of ['TYPE_VECTOR2', 'TYPE_VECTOR2I', 'TYPE_VECTOR3', 'TYPE_VECTOR3I', 'TYPE_VECTOR4', 'TYPE_VECTOR4I', 'TYPE_COLOR', 'TYPE_PLANE', 'TYPE_QUATERNION', 'TYPE_RECT2', 'TYPE_RECT2I']) {
      expect(s.includes(t), `_coerce_math_value 缺 ${t} 分支`).toBe(true);
    }
    // 构造器存在
    for (const ctor of ['Vector2(', 'Vector2i(', 'Vector3(', 'Vector3i(', 'Vector4(', 'Vector4i(', 'Color(', 'Plane(', 'Quaternion(', 'Rect2(', 'Rect2i(']) {
      expect(s.includes(ctor), `缺构造器 ${ctor}`).toBe(true);
    }
  });

  it('E1-e: 整型向量用 int() 构造(防 float 静默截断语义漂移)', () => {
    const s = coerceFn();
    expect(s.includes('Vector2i(int(x), int(y))'), 'Vector2i 构造缺 int()').toBe(true);
    expect(s.includes('Vector3i(int(x), int(y), int(z))'), 'Vector3i 构造缺 int()').toBe(true);
  });

  it('E1-f: Color 3 分量输入 alpha 默认 1.0(对齐 editor 源版)', () => {
    const s = coerceFn();
    expect(s.includes('float(a) if a != null else 1.0'), 'Color alpha 默认 1.0 缺失').toBe(true);
  });

  it('E1-g: Array 与 Dict 两种输入都支持(Dict 按 x/y/z/w 与 r/g/b/a 键)', () => {
    const s = compFn();
    expect(s.includes('if value is Array'), '缺 Array 分量读取').toBe(true);
    expect(s.includes('if value is Dictionary'), '缺 Dict 分量读取').toBe(true);
    expect(s.includes('dict.has(key)'), '缺 Dict 键存在检查').toBe(true);
    // 非 Array/Dict 输入透传(已是数学类型/标量交 node.set)
    expect(coerceFn().includes('return value  # 已是数学类型/标量等'), '缺非 Array/Dict 透传').toBe(true);
  });

  it('E1-h: null 分量防御(报错拒绝,防 float(null) 运行时崩溃)', () => {
    const s = compFn();
    // H-1(2026-09-17,Task B)白名单形态:null/容器/非法串分量统一被类型白名单拒绝
    // 返 null(旧 `!= null` 显式检查是其子集,已并入白名单)。真机行为锚定见
    // scene-gd-operations-e2e.test.ts「Task B」describe(毒分量 add_node → exit 1 无 SCRIPT ERROR)。
    expect(s.includes('out is int or out is float'), '_math_comp 缺分量类型白名单').toBe(true);
    expect(s.includes('is_valid_float()'), '_math_comp 缺合法数字串放行').toBe(true);
    expect(s.includes('return null'), '_math_comp 缺白名单拒绝路径').toBe(true);
    // 调用方对转换失败(返 null)报错拒绝,不再假成功
    const setS = setFn();
    expect(setS.includes('cannot coerce'), '调用方缺 cannot coerce 报错').toBe(true);
    expect(setS.includes('return false'), '转换失败应 return false').toBe(true);
  });

  it('E1-k: H-1 数学分量白名单与 bridge 副本 Keep-in-sync 声明(对齐 mcp_bridge.gd Task A 0e426ab1)', () => {
    // 函数头注释在 slice 锚点(func 定义行)之前,故对全文断言
    expect(gd.includes('Keep in sync with mcp_bridge.gd'), '缺 Keep-in-sync 双副本声明').toBe(true);
    const s = compFn();
    // 放行面仅三态:int / float / is_valid_float 数字串——其余(容器/null/bool/非法串)拒
    expect(s.match(/out is int or out is float or \(out is String and String\(out\)\.is_valid_float\(\)\)/), '白名单三元条件不完整').toBeTruthy();
  });

  it('E1-i: 分量数校验保留(CMP-10 报错文案不回归)', () => {
    const s = setFn();
    expect(s.includes('_has_components(value, math_needed)'), '缺分量数校验').toBe(true);
    expect(s.includes('Property %s expects %s, got: %s'), '缺 expects 报错格式').toBe(true);
  });

  it('E1-j: 校验类型面扩至 Vector4/4i/Plane/Quaternion(对齐 editor coerce 面)', () => {
    const s = setFn();
    expect(s.includes('TYPE_VECTOR4 or prop_type == TYPE_VECTOR4I'), '缺 Vector4/4i 收集分支').toBe(true);
    expect(s.includes('TYPE_PLANE or prop_type == TYPE_QUATERNION'), '缺 Plane/Quaternion 收集分支').toBe(true);
  });
});
