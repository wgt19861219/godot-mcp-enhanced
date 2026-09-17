/**
 * 反馈批次D(2026-09-17, 批次C审查 Nit3 挂账)契约级锁定:
 * - touch/drag/key/text 注入链 device=0 对称收口(mouse 链批次C已收,本批补齐
 *   InputEventKey/ScreenTouch/ScreenDrag——不依赖引擎对默认 -1 的未文档化规范化,
 *   真机 4.6.3 实测派发链会规范化,锚定防引擎行为漂移)
 * - timeline 注入(send_input_sequence)复用同函数,自动跟随
 * 行为级 e2e 见 test/e2e-bridge-mouse-gui.test.ts(D5 用例,touch/key 探针断 device=0)。
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

describe('批次D: 注入链 device=0 对称收口(批次C Nit3 挂账清偿)', () => {
  it('send_key: InputEventKey 显式 device=0', () => {
    const s = funcSlice('_cmd_send_key');
    expect(s.includes('event.device = 0'), '须显式 device=0(同 mouse 链;默认 -1 依赖引擎规范化)').toBe(true);
  });

  it('send_touch: InputEventScreenTouch 显式 device=0', () => {
    const s = funcSlice('_cmd_send_touch');
    expect(s.includes('event.device = 0'), '须显式 device=0').toBe(true);
  });

  it('send_drag: InputEventScreenDrag 显式 device=0', () => {
    const s = funcSlice('_cmd_send_drag');
    expect(s.includes('event.device = 0'), '须显式 device=0').toBe(true);
  });

  it('send_text: 逐字符 InputEventKey 同款 device=0(对称收口)', () => {
    const s = funcSlice('_cmd_send_text');
    expect(s.includes('event.device = 0'), '须显式 device=0(同 _cmd_send_key)').toBe(true);
  });
});
