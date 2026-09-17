/**
 * 反馈批次C(2026-09-17,09-10/09-12 定谳)契约级锁定:
 * - send_mouse_click/mouse_move 注入事件显式 device=0(对齐真实鼠标事件;不依赖引擎
 *   对默认 -1 的未文档化规范化——真机 4.6.3 实测派发链会规范化,锚定防引擎行为漂移)
 * - click_button real_event 路径 press/release 同款 device=0
 * - _cmd_send_mouse_click/touch 的 x/y 从裸 float() 收口为 _num 守卫(2026-09-03 审查
 *   I-C 漏网点:mouse_move/drag 已改守卫,这两处漏改——null/容器参数触发 SCRIPT ERROR,
 *   同步分发无异常隔离 → 响应静默变 result:null;真机 headless 实证)
 * 行为级 e2e 见 test/e2e-bridge-mouse-gui.test.ts(L2 opt-in,带窗口+headless 双形态)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function funcSlice(name: string): string {
  const start = gd.indexOf(`func ${name}`);
  expect(start, `${name} 须存在`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf('\nfunc ', start + 10);
  return gd.slice(start, end === -1 ? undefined : end);
}

describe('批次C: 注入事件字段与真实管线一致', () => {
  it('send_mouse_click: device=0 + global_position 同步落位', () => {
    const s = funcSlice('_cmd_send_mouse_click');
    expect(s.includes('event.device = 0'), '须显式 device=0(真实鼠标事件 device=0)').toBe(true);
    expect(s.includes('event.global_position = Vector2(x, y)'), 'global_position 须落位(2026-05 起在位,防回归)').toBe(true);
  });

  it('send_mouse_move: device=0 + global_position', () => {
    const s = funcSlice('_cmd_send_mouse_move');
    expect(s.includes('event.device = 0'), '须显式 device=0').toBe(true);
    expect(s.includes('event.global_position = Vector2(x, y)'), 'global_position 须落位').toBe(true);
  });

  it('click_button real_event: press/release 均 device=0', () => {
    const s = funcSlice('_await_click_verify_and_respond');
    const devices = s.match(/\.device = 0/g) ?? [];
    expect(devices.length, 'press/release 两处均须 device=0').toBe(2);
  });
});

describe('批次C: x/y 数值守卫收口(I-C 漏网点)', () => {
  it('send_mouse_click: x/y 走 _num 守卫,无裸 float(params.get', () => {
    const s = funcSlice('_cmd_send_mouse_click');
    expect(s.includes('_num(params.get("x", 0), 0.0)'), 'x 须走 _num 守卫').toBe(true);
    expect(s.includes('_num(params.get("y", 0), 0.0)'), 'y 须走 _num 守卫').toBe(true);
    expect(s.includes('float(params.get'), '不得残留裸 float(params.get(...))(null/容器 → SCRIPT ERROR → result:null)').toBe(false);
  });

  it('send_touch: x/y 走 _num 守卫,无裸 float(params.get', () => {
    const s = funcSlice('_cmd_send_touch');
    expect(s.includes('_num(params.get("x", 0), 0.0)'), 'x 须走 _num 守卫').toBe(true);
    expect(s.includes('_num(params.get("y", 0), 0.0)'), 'y 须走 _num 守卫').toBe(true);
    expect(s.includes('float(params.get'), '不得残留裸 float(params.get(...))').toBe(false);
  });
});
