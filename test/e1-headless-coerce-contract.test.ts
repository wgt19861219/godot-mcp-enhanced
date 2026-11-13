import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCENE_TREE_HEADER } from '../src/core/shared/gdscript-templates.js';
import { genPropertyLines } from '../src/tools/ui/types.js';
import { genUiCreateControlScript, genUiContainerAddScript } from '../src/tools/ui/ui-create.js';

// 批 E (2026-08-14) E-1 契约测试:headless 数学类型真转换(godot_operations.gd)。
// 修复前:数学分支只 _has_components 校验不转换,coerced 仍是原 Array/Dict,
// node.set(Array→数学类型) 是静默 no-op 但返 "edited successfully"(假成功)。
// 修复后:校验通过后 _coerce_math_value 按 prop_type 构造真数学类型。
//
// ⚠️ 局限(对齐 g1-playtest-control-contract 范式的过渡手段):源码字符串断言验证
// "修复模式落位"而非运行时行为。运行时行为由 headless 真跑覆盖(见 task-E-report.md)。

const gd = readFileSync('src/scripts/godot_operations.gd', 'utf8');
const editorGd = readFileSync('addons/godot_mcp_server/commands/command_helpers.gd', 'utf8');
const bridgeGd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

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

  it('E1-k: H-1 数学分量白名单与三副本 Keep-in-sync 声明(headless ↔ bridge ↔ editor)', () => {
    // 函数头注释在 slice 锚点(func 定义行)之前,故对全文断言(fix round 1 起升级为三副本指向)
    expect(gd.includes('Keep in sync(三副本分量白名单)'), '缺三副本 Keep-in-sync 声明').toBe(true);
    expect(gd.includes('mcp_bridge.gd _math_comp'), '缺 bridge 指向').toBe(true);
    expect(gd.includes('command_helpers.gd _comp_white'), '缺 editor 指向').toBe(true);
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

  it('E1-l: editor 第三副本(coerce_value_for_property)Array 分量白名单 + 三向 Keep-in-sync 链(fix round 1)', () => {
    const start = editorGd.indexOf('static func coerce_value_for_property');
    expect(start, 'editor 源副本函数未找到').toBeGreaterThanOrEqual(0);
    const s = editorGd.slice(start, editorGd.indexOf('## C12:', start));
    // 分量白名单守卫落位(_comp_white,形态对齐 headless/bridge 的 _math_comp)
    expect(s.includes('_comp_white(a, 0)'), '缺 _comp_white 白名单取分量').toBe(true);
    // 毒/缺分量 → 返回 null(不再透传原 Array 致 set 静默 no-op 假成功)
    expect(s.includes('return null'), '缺守卫拒绝路径 return null').toBe(true);
    // editor 侧反向 Keep-in-sync 指向两副本(注释放 _comp_white 函数头)
    const compStart = editorGd.indexOf('static func _comp_white');
    expect(compStart, '缺 _comp_white 定义').toBeGreaterThanOrEqual(0);
    const compDoc = editorGd.slice(Math.max(0, compStart - 800), compStart);
    expect(compDoc.includes('godot_operations.gd'), '反向缺 headless 指向').toBe(true);
    expect(compDoc.includes('mcp_bridge.gd'), '反向缺 bridge 指向').toBe(true);
    // bridge 侧 _math_comp 反向指向(reviewer Minor 1 清偿:注明三副本同步关系)
    const bStart = bridgeGd.indexOf('func _math_comp');
    expect(bStart, 'bridge _math_comp 未找到').toBeGreaterThanOrEqual(0);
    const bDoc = bridgeGd.slice(Math.max(0, bStart - 600), bStart);
    expect(bDoc.includes('godot_operations.gd'), 'bridge _math_comp 缺 headless 反向指向').toBe(true);
    expect(bDoc.includes('command_helpers'), 'bridge _math_comp 缺 editor 反向指向').toBe(true);
  });
});

// ─── Task D5 (2026-11-12): headless ui 属性 coerce helper(_mcp_set_prop) ────
// 修复前:genPropertyLines(types.ts) 裸 node.set + valueToGd 按**值形状**预猜类型——
// texture 等 Resource 属性传 "res://a.png" 是静默 no-op(Godot set() 不 load,4.7
// verified);[1,0,0,1] 无条件猜成 Color,目标属性是 Vector4/Quaternion 时类型错配
// 同样 no-op。修复后:属性经 SCENE_TREE_HEADER 内 _mcp_set_prop 运行时按
// typeof(node.get(key)) **目标类型**分派 coerce(对齐 editor coerce_value_for_property
// 的 typeof(current) 分派语义 + headless _set_property_with_coerce 的 TYPE_OBJECT→load)。

describe('D5: headless ui 属性 coerce helper(_mcp_set_prop, gdscript-templates.ts)', () => {
  it('D5-a: SCENE_TREE_HEADER 含 _mcp_set_prop helper 定义', () => {
    expect(SCENE_TREE_HEADER.includes('func _mcp_set_prop(node: Node, key: String, val: Variant) -> void:'), '缺 _mcp_set_prop 定义').toBe(true);
  });

  it('D5-b: 按目标属性运行时类型(typeof(node.get(key)))分派 Vector2/3/4/Color', () => {
    for (const t of ['TYPE_VECTOR2', 'TYPE_VECTOR3', 'TYPE_VECTOR4', 'TYPE_COLOR']) {
      expect(SCENE_TREE_HEADER.includes(t), `_mcp_set_prop 缺 ${t} 分派分支`).toBe(true);
    }
    for (const ctor of ['Vector2(', 'Vector3(', 'Vector4(', 'Color(']) {
      expect(SCENE_TREE_HEADER.includes(ctor), `_mcp_set_prop 缺构造器 ${ctor}`).toBe(true);
    }
    // 分派基准是 node.get(key) 的 typeof,不是值形状猜测
    expect(SCENE_TREE_HEADER.includes('typeof('), '缺 typeof 分派').toBe(true);
    expect(SCENE_TREE_HEADER.includes('node.get(key)'), '分派须读目标属性当前值 node.get(key)').toBe(true);
  });

  it('D5-c: TYPE_OBJECT + res:// 字符串 → load()(texture 类 Resource 属性)', () => {
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    expect(start).toBeGreaterThanOrEqual(0);
    const s = SCENE_TREE_HEADER.slice(start);
    expect(s.includes('TYPE_OBJECT'), '缺 TYPE_OBJECT 分支').toBe(true);
    expect(s.includes('begins_with("res://")'), '缺 res:// 前缀判定').toBe(true);
    expect(s.includes('load('), '缺 load() 调用').toBe(true);
  });

  it('D5-i: Object 分支按声明类型判定(get_property_list)——Object 属性默认值是 null,typeof(current) 得 TYPE_NIL,load 分支永不可达', () => {
    expect(SCENE_TREE_HEADER.includes('func _mcp_prop_declared_type'), '缺声明类型 helper(_mcp_prop_declared_type)').toBe(true);
    expect(SCENE_TREE_HEADER.includes('get_property_list()'), '声明类型须走 get_property_list').toBe(true);
    // Object 分支不得用 typeof(current) 判定(texture 默认 null 陷阱,对齐 editor/headless 副本的声明类型路径)
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    const loadBranch = SCENE_TREE_HEADER.slice(start, SCENE_TREE_HEADER.indexOf('node.set(key, val)', start));
    expect(loadBranch).not.toContain('typeof(current) == TYPE_OBJECT');
  });

  it('D5-d: node.get(key) 为 null(属性不存在/无默认值) → 原样 set 交引擎报错,不吞', () => {
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    const s = SCENE_TREE_HEADER.slice(start);
    // Array 分支仅 current != null 才进入分派(否则属性不存在,get 为 null)
    expect(s.includes('current != null'), 'Array 分派缺 current != null 守卫').toBe(true);
    // 兜底路径:原样 set
    expect(s.includes('node.set(key, val)'), '缺原样 set 兜底').toBe(true);
  });

  it('D5-e: 分量类型白名单防毒分量(float({}/null) 是 SCRIPT ERROR,engine-quirks 真机实证)', () => {
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    const s = SCENE_TREE_HEADER.slice(start);
    expect(s.includes('is int or'), '缺分量类型白名单(int/float)').toBe(true);
    expect(s.includes('is_valid_float()'), '缺合法数字串放行').toBe(true);
  });

  it('D5-f: genPropertyLines 生成 _mcp_set_prop 调用,Array 以数组字面量传入(不预猜 Color)', () => {
    const lines = genPropertyLines({ texture: 'res://a.png', modulate: [1, 0, 0, 1] });
    expect(lines).toContain('_mcp_set_prop(node, "texture", "res://a.png")');
    expect(lines).toContain('_mcp_set_prop(node, "modulate", [1, 0, 0, 1])');
    // Array 不被 valueToGd 按值形状预转——目标类型由运行时 helper 决定
    expect(lines).not.toContain('Color(1, 0, 0, 1)');
  });

  it('D5-g: genUiCreateControlScript 整脚本含 helper 定义 + 调用', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'TextureRect', 'T', '.', { texture: 'res://a.png', modulate: [1, 0, 0, 1] });
    expect(script).toContain('func _mcp_set_prop(');
    expect(script).toContain('_mcp_set_prop(node, "texture", "res://a.png")');
    expect(script).toContain('_mcp_set_prop(node, "modulate", [1, 0, 0, 1])');
  });

  it('D5-h: genUiContainerAddScript 属性调用换用 child 变量(replace 联动)', () => {
    const script = genUiContainerAddScript('res://main.tscn', '/root/HBox', 'Label', 'L', { text: 'Hi' });
    expect(script).toContain('_mcp_set_prop(child, "text", "Hi")');
    // child 脚本无 node 变量——漏联动 replace 会生成引用不存在变量的调用
    expect(script).not.toMatch(/_mcp_set_prop\(node,/);
  });

  // 终审 Important-2(2026-11-12) D5 M1: res:// load 前路径防护——裸 load(String(val))
  // 无 path 防护,注入面可喂 res://../ 穿越/null byte/反斜杠/%2e%2e 编码路径。
  it('D5-j: res:// load 前过 _mcp_res_path_ok 防护,非法路径 → prop_error 跳过不 load', () => {
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    const s = SCENE_TREE_HEADER.slice(start);
    // 防护 helper 存在,覆盖 null byte / 反斜杠 / percent-decode / 穿越段四向量
    expect(s.includes('func _mcp_res_path_ok'), '缺 _mcp_res_path_ok 防护 helper').toBe(true);
    expect(s.includes('char(0)'), '缺 null byte 防护').toBe(true);
    expect(s.includes('uri_decode()'), '缺 percent-decode 防护').toBe(true);
    expect(s.includes('"\\\\"'), '缺反斜杠防护').toBe(true);
    expect(s.includes('".."'), '缺 .. 穿越段拒绝').toBe(true);
    // load 前必须过防护(helper 调用在 load 之前)
    const guardIdx = s.indexOf('if not _mcp_res_path_ok(res_path):');
    expect(guardIdx, '缺防护调用分支').toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(s.indexOf('var res: Variant = load(res_path)'));
    // 非法路径 → prop_error 上报并跳过(不静默,也不裸 load)
    expect(s.includes('"Unsafe res:// path blocked for "'), '非法路径缺 prop_error 上报').toBe(true);
  });

  // 终审 Important-2(2026-11-12) D5 M2: TYPE_OBJECT 收非 res:// 字符串 → prop_error
  // (旧实现落兜底 node.set 静默 no-op 假成功;文案对齐 editor 副本 command_helpers.gd
  // coerce_property_value "expects Resource, got plain String" )。
  it('D5-k: TYPE_OBJECT 收非 res:// 字符串 → prop_error,不再静默 no-op', () => {
    const start = SCENE_TREE_HEADER.indexOf('func _mcp_set_prop');
    const s = SCENE_TREE_HEADER.slice(start);
    expect(s.includes('expects Resource, got plain String'), '缺非 res:// 字符串 prop_error 分支').toBe(true);
    // Object 分支收任意 String(不再以 begins_with("res://") 作为进分支条件——
    // 非 res:// 字符串须进分支报错,而不是漏到兜底 set)
    const branchLine = 'elif val is String and _mcp_prop_declared_type(node, key) == TYPE_OBJECT:';
    expect(s.includes(branchLine), 'Object 分支条件应收任意 String(非 res:// 也进分支报错)').toBe(true);
    const branchIdx = s.indexOf(branchLine);
    expect(s.indexOf('expects Resource, got plain String')).toBeGreaterThan(branchIdx);
  });
});
