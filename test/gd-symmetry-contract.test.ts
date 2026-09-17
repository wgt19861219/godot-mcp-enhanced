import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// 2026-08-21 审查修复批 2(GD bridge 对称性)契约测试。验证 src/scripts/mcp_bridge.gd 源码签约:
// - 审查G-1(P2): _compare_values 数值分支类型白名单(对齐 Vector 分支 N-1)
// - 可靠性P2: freeze 入口 pending 守卫(对齐 step 的 D-6 范式)
// - 审查G-2(P3): send_input_sequence 深预检扩展(mouse_click button / touch·drag index)
//               + 底层 _cmd_send_mouse_click button 语义(left/right/middle 映射)
// - F-4(Nit): isq_result 补 all_applied 诊断字段
// - 审查G-3(P3·可疑顺手修): _coerce_bridge_single TYPE_INT/TYPE_FLOAT String 裸转改严格判定
//
// ⚠️ 局限(对齐 g1-playtest-control-contract 范式):源码字符串断言验证"修复模式落位"而非
// 运行时行为;运行时行为由 bridge 真机 e2e 覆盖。
const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function sliceBetween(startAnchor: string, endAnchor: string): string {
  const start = gd.indexOf(startAnchor);
  expect(start, `锚点未找到: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf(endAnchor, start);
  expect(end, `结束锚点未找到: ${endAnchor}`).toBeGreaterThan(start);
  return gd.slice(start, end);
}

describe('审查G-1 [P2]: _compare_values 数值分支类型白名单(防 String 条件值 float() 静默 0 比较假阳性)', () => {
  const numericSlice = () => sliceBetween('func _compare_values', 'if actual is String or actual is bool');
  it('G-1a: 数值分支在 float(target) 前有 target 类型白名单(int/float 否则 return false)', () => {
    const s = numericSlice();
    expect(s.includes('if not (target is int or target is float):'), '数值分支缺 target 白名单').toBe(true);
    expect(s.includes('return false'), '白名单缺 return false').toBe(true);
  });
  it('G-1b [顺序]: 白名单必须先于 float(target) 裸转(守卫在前才有防御)', () => {
    const s = numericSlice();
    expect(
      s.indexOf('if not (target is int or target is float):'),
      '白名单应在 float(target) 之前'
    ).toBeLessThan(s.indexOf('float(target)'));
  });
});

describe('可靠性P2: freeze 入口 pending 守卫(开窗期间并发 freeze 拒,防时间线假成功)', () => {
  const freezeSlice = () => sliceBetween('func _cmd_control_freeze', 'func _cmd_control_unfreeze');
  it('P2a: freeze 段含两 pending 数组非空拒绝', () => {
    const s = freezeSlice();
    expect(s.includes('_control_input_seq_pending.is_empty()'), '缺 input_seq pending 检查').toBe(true);
    expect(s.includes('_control_step_until_pending.is_empty()'), '缺 step_until pending 检查').toBe(true);
    expect(s.includes('control layer busy'), '缺 busy error 文案').toBe(true);
  });
  it('P2b [顺序]: pending 守卫先于 owner_pid 赋值(拒绝路径不得先占 owner)', () => {
    const s = freezeSlice();
    expect(
      s.indexOf('_control_input_seq_pending.is_empty()'),
      'pending 守卫应在 _control_owner_pid = pid 之前'
    ).toBeLessThan(s.indexOf('_control_owner_pid = pid'));
  });
});

describe('审查G-2 [P3]: 深预检扩展 + 底层 button 语义(mouse_click 误型不再假成功)', () => {
  const precheckSlice = () => sliceBetween('const _INPUT_SEQ_TYPES', 'var settle: int');
  const clickSlice = () => sliceBetween('func _cmd_send_mouse_click', 'func _cmd_send_mouse_move');
  it('G-2a: 深预检段含 mouse_click button 校验(_mouse_button_from_value == -1 拒)', () => {
    expect(precheckSlice().includes('_mouse_button_from_value(e.get("button", 1)) == -1'), '深预检缺 button 校验').toBe(true);
  });
  it('G-2b: 深预检段含 touch/drag index 校验(_is_valid_touch_index)', () => {
    expect(precheckSlice().includes('_is_valid_touch_index(e.get("index", 0))'), '深预检缺 index 校验').toBe(true);
  });
  it('G-2c: _mouse_button_from_value 定义存在(int 1-9 直通 + left/right/middle 映射)', () => {
    const s = sliceBetween('func _mouse_button_from_value', 'func _is_valid_touch_index');
    expect(s.includes('MOUSE_BUTTON_LEFT'), '缺 left 映射').toBe(true);
    expect(s.includes('MOUSE_BUTTON_RIGHT'), '缺 right 映射').toBe(true);
    expect(s.includes('MOUSE_BUTTON_MIDDLE'), '缺 middle 映射').toBe(true);
    expect(s.includes('return -1'), '缺非法返 -1 哨兵').toBe(true);
  });
  it('G-2d: 底层 _cmd_send_mouse_click 不再裸转 int(params.get("button"(经 helper + -1 拒)', () => {
    const s = clickSlice();
    expect(s.includes('int(params.get("button"'), '底层仍裸转 int()').toBe(false);
    expect(s.includes('_mouse_button_from_value(params.get("button", 1))'), '底层未走 helper').toBe(true);
    expect(s.includes('Invalid mouse button'), '缺 -1 结构化 error').toBe(true);
  });
  it('G-2e [负向]: 全文不再有 button 相关 int() 裸转残留(_cmd_send_mouse_click 段)', () => {
    expect(gd.includes('var button: int = int(params.get'), 'button 裸转残留').toBe(false);
  });
  it('G-2f [审查N-1 对称]: send_touch/send_drag 直接调用路径 index 同款严格校验', () => {
    const touchSlice = sliceBetween('func _cmd_send_touch', 'func _cmd_send_drag');
    const dragSlice = sliceBetween('func _cmd_send_drag', 'func _cmd_send_text');
    expect(touchSlice.includes('_is_valid_touch_index(params.get("index", 0))'), 'send_touch 缺 index 校验').toBe(true);
    expect(dragSlice.includes('_is_valid_touch_index(params.get("index", 0))'), 'send_drag 缺 index 校验').toBe(true);
    // H-2(2026-09-17 审查)后裸转收口为 _int_guarded;断言严格校验必须先于守卫取值
    for (const [name, s] of [['touch', touchSlice], ['drag', dragSlice]] as const) {
      expect(
        s.indexOf('_is_valid_touch_index('), `${name}: index 严格校验应在 _int_guarded 之前`
      ).toBeLessThan(s.indexOf('var index: int = _int_guarded(params.get'));
    }
  });
});

describe('F-4 [Nit]: isq_result 补 all_applied 诊断字段(部分事件 ok:false 一眼可辨)', () => {
  const isqSlice = () => sliceBetween('"applied_count":', '"frames_elapsed":');
  it('F-4a: isq 响应含 all_applied(对 applied 数组 .all() 折叠)', () => {
    const s = isqSlice();
    expect(s.includes('"all_applied"'), '缺 all_applied 字段').toBe(true);
    expect(s.includes('.all(func(r)'), '缺 .all() 折叠实现').toBe(true);
  });
});

describe('审查G-3 [P3]: _coerce_bridge_single String 数值严格判定(裸转零值/部分解析消除)', () => {
  const coerceSlice = () => sliceBetween('TYPE_INT:', 'TYPE_STRING:');
  it('G-3a: TYPE_INT/TYPE_FLOAT String 分支用 is_valid_int/is_valid_float 严格判定', () => {
    const s = coerceSlice();
    expect(s.includes('is_valid_int()'), 'TYPE_INT 缺 is_valid_int 判定').toBe(true);
    expect(s.includes('is_valid_float()'), 'TYPE_FLOAT 缺 is_valid_float 判定').toBe(true);
  });
  it('G-3b [负向]: String 分支不再无条件裸转(float→int 等合法分支不受影响)', () => {
    const s = coerceSlice();
    expect(/if raw is String:\s*\n\s*return int\(raw\)/.test(s), 'TYPE_INT String 分支仍无条件裸转').toBe(false);
    expect(/if raw is String:\s*\n\s*return float\(raw\)/.test(s), 'TYPE_FLOAT String 分支仍无条件裸转').toBe(false);
  });
});
