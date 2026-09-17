/**
 * P2-D (2026-08-08): tscn-editor-add.ts 纯函数单测。
 *
 * src/tscn/tscn-editor-add.ts 的 addNode/addNodes 需 Godot 进程（集成测试覆盖），
 * 但 canSerializeProperty + formatPropertyValue 是纯函数（无副作用），适合单测。
 * 覆盖 F-2（非有限数拒绝/null 序列化）+ 类型分派（Color/Vector2/Vector3/Rect2/_type）+ Array。
 */
import { canSerializeProperty, formatPropertyValue } from '../src/tscn/tscn-editor-add.js';
import { nodePathToNameAndParent } from '../src/tscn/tscn-editor-detach.js';

describe('P2-D: canSerializeProperty', () => {
  it('接受 null/undefined/string/boolean', () => {
    expect(canSerializeProperty(null)).toBe(true);
    expect(canSerializeProperty(undefined)).toBe(true);
    expect(canSerializeProperty('hello')).toBe(true);
    expect(canSerializeProperty(true)).toBe(false === false || true); // true
    expect(canSerializeProperty(false)).toBe(true);
  });

  it('接受有限数，拒绝 NaN/Infinity（F-2）', () => {
    expect(canSerializeProperty(42)).toBe(true);
    expect(canSerializeProperty(3.14)).toBe(true);
    expect(canSerializeProperty(0)).toBe(true);
    expect(canSerializeProperty(-1)).toBe(true);
    // F-2: 非有限数拒绝（防 .tscn 写出 NaN/Infinity 损坏场景文件）
    expect(canSerializeProperty(NaN)).toBe(false);
    expect(canSerializeProperty(Infinity)).toBe(false);
    expect(canSerializeProperty(-Infinity)).toBe(false);
  });

  it('B3-text(反馈批次 B): 数组一律 fallback(修复前 primitive Array 落盘裸数组,Godot 静默丢属性)', () => {
    expect(canSerializeProperty([1, 2, 3])).toBe(false);
    expect(canSerializeProperty(['a', 'b'])).toBe(false);
    expect(canSerializeProperty([true, false])).toBe(false);
    expect(canSerializeProperty([1, null, 'x'])).toBe(false);
    expect(canSerializeProperty([1, NaN, 3])).toBe(false);
    expect(canSerializeProperty([1, Infinity])).toBe(false);
  });

  it('接受扁平对象（基本类型值），拒绝嵌套对象', () => {
    expect(canSerializeProperty({ x: 1, y: 2 })).toBe(true);
    expect(canSerializeProperty({ name: 'test', visible: true })).toBe(true);
    expect(canSerializeProperty({})).toBe(true);
    // 嵌套对象拒绝（文本路径无法安全序列化）
    expect(canSerializeProperty({ nested: { a: 1 } })).toBe(false);
    expect(canSerializeProperty({ arr: [1, 2] })).toBe(false); // Array 是 object
  });

  it('拒绝对象中的非有限数（F-2）', () => {
    expect(canSerializeProperty({ x: NaN })).toBe(false);
    expect(canSerializeProperty({ x: 1, y: Infinity })).toBe(false);
  });

  it('拒绝 function/symbol', () => {
    expect(canSerializeProperty(() => {})).toBe(false);
    expect(canSerializeProperty(Symbol('x'))).toBe(false);
  });
});

describe('P2-D: formatPropertyValue', () => {
  it('null/undefined → "null"', () => {
    expect(formatPropertyValue(null)).toBe('null');
    expect(formatPropertyValue(undefined)).toBe('null');
  });

  it('boolean → "true"/"false"', () => {
    expect(formatPropertyValue(true)).toBe('true');
    expect(formatPropertyValue(false)).toBe('false');
  });

  it('有限数 → 字符串，非有限数 → "null"（F-2）', () => {
    expect(formatPropertyValue(42)).toBe('42');
    expect(formatPropertyValue(3.14)).toBe('3.14');
    expect(formatPropertyValue(0)).toBe('0');
    expect(formatPropertyValue(-1)).toBe('-1');
    // F-2: NaN/Infinity → null（保持 .tscn 可解析）
    expect(formatPropertyValue(NaN)).toBe('null');
    expect(formatPropertyValue(Infinity)).toBe('null');
  });

  it('Array → PackedArray 语法 [v1, v2]', () => {
    expect(formatPropertyValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(formatPropertyValue(['a', 'b'])).toBe('["a", "b"]'); // 数组内 string 加引号不加 & 前缀
    expect(formatPropertyValue([])).toBe('[]');
  });

  it('Color 自动推断（r/g/b 数字）', () => {
    expect(formatPropertyValue({ r: 1, g: 0, b: 0 }))
      .toBe('Color(1, 0, 0, 1)'); // 默认 alpha=1
    expect(formatPropertyValue({ r: 0.5, g: 0.5, b: 0.5, a: 0.8 }))
      .toBe('Color(0.5, 0.5, 0.5, 0.8)');
  });

  it('Vector2 自动推断（x/y 无 z/w/h）', () => {
    expect(formatPropertyValue({ x: 10, y: 20 })).toBe('Vector2(10, 20)');
  });

  it('Vector3 自动推断（x/y/z）', () => {
    expect(formatPropertyValue({ x: 1, y: 2, z: 3 })).toBe('Vector3(1, 2, 3)');
  });

  it('_type 显式覆盖优先', () => {
    expect(formatPropertyValue({ _type: 'Color', r: 1, g: 1, b: 1 }))
      .toBe('Color(1, 1, 1, 1)');
    expect(formatPropertyValue({ _type: 'Vector2', x: 5, y: 10 }))
      .toBe('Vector2(5, 10)');
    expect(formatPropertyValue({ _type: 'Vector3', x: 1, y: 2, z: 3 }))
      .toBe('Vector3(1, 2, 3)');
    expect(formatPropertyValue({ _type: 'Rect2', x: 0, y: 0, w: 100, h: 50 }))
      .toBe('Rect2(0, 0, 100, 50)');
  });

  it('_type 非有限数用 fallback（F-2 纵深防御）', () => {
    // _type Color 的 NaN r → fallback 1（Color 分支 r fallback=1，对齐源码 fmtNum(obj.r, 1)）
    expect(formatPropertyValue({ _type: 'Color', r: NaN, g: 0, b: 0, a: 1 }))
      .toBe('Color(1, 0, 0, 1)');
  });
});

describe('P2-D: nodePathToNameAndParent（tscn-editor-detach）', () => {
  it('root 子节点 → parent="."（.tscn 根层级）', () => {
    const r = nodePathToNameAndParent('/root/MyNode');
    expect(r.nodeName).toBe('MyNode');
    expect(r.parent).toBe('.');
  });

  it('嵌套节点 → parent 为父路径', () => {
    const r = nodePathToNameAndParent('/root/Parent/Child');
    expect(r.nodeName).toBe('Child');
    expect(r.parent).toBe('Parent');
  });

  it('深层嵌套 → parent 为多级路径', () => {
    const r = nodePathToNameAndParent('/root/A/B/C');
    expect(r.nodeName).toBe('C');
    expect(r.parent).toBe('A/B');
  });

  it('无 / 前缀也能处理', () => {
    const r = nodePathToNameAndParent('root/MyNode');
    expect(r.nodeName).toBe('MyNode');
    expect(r.parent).toBe('.');
  });

  it('无 root/ 前缀的路径', () => {
    const r = nodePathToNameAndParent('Parent/Child');
    expect(r.nodeName).toBe('Child');
    expect(r.parent).toBe('Parent');
  });

  it('拒绝 detach root 本身', () => {
    expect(() => nodePathToNameAndParent('/root')).toThrow(/root/i);
    expect(() => nodePathToNameAndParent('root')).toThrow(/root/i);
  });
});
