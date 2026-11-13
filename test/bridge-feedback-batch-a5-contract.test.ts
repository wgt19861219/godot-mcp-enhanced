/**
 * 反馈批次 2026-11-12 Task A5 契约级锁定(模式同 bridge-feedback-batch-a2a3-contract):
 * - 源码契约:send_mouse_click/send_mouse_move/send_touch 三处 `Input.parse_input_event`
 *   注入后紧跟 `Input.flush_buffered_events()`(反馈 2026-10-09 延迟队列重放污染——注入
 *   事件坐引擎输入缓冲到下一帧才派发);timeline 逐帧注入(_inject_timeline_event)**不
 *   flush**(at_frame 帧对齐是有意延迟)。行为级 e2e 见 test/e2e-bridge-mouse-gui.test.ts
 *   A5 describe(GODOT_PATH 门控,Engine.max_fps=1 分帧定谳当帧派发)。
 * - 文档契约:rule-templates 模板 + .claude/rules 双副本「输入注入管线要点」含五要点
 *   关键词——①即时生效语义(flush 当帧派发/逻辑消费下一帧/查询前等 ≥1 帧/timeline 不
 *   flush)②坐标系=窗口像素 vs get_node_properties 逻辑坐标差窗口缩放倍数 ③headless
 *   CanvasLayer 拾取可能不达→结构直驱(EXTRA_METHODS/GDA_CALLABLE)④排查清单补 DPI/
 *   窗口缩放 + click_button 对照 ⑤headless BaseButton 点击链不达(A2A3 真机定谳,
 *   Button e2e 须带窗口)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DETAILED_RULE_TEMPLATES } from '../src/tools/rule-templates.js';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function funcSlice(name: string): string {
  const start = gd.indexOf(`func ${name}`);
  expect(start, `${name} 须存在`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf('\nfunc ', start + 10);
  return gd.slice(start, end === -1 ? undefined : end);
}

const INJECT_FUNCS = ['_cmd_send_mouse_click', '_cmd_send_mouse_move', '_cmd_send_touch'] as const;

describe('A5: 三处直接注入 parse 后紧跟 flush(延迟队列重放污染修复)', () => {
  for (const fn of INJECT_FUNCS) {
    it(`${fn}: parse_input_event 后紧跟 do_flush 守卫的 flush_buffered_events`, () => {
      const s = funcSlice(fn);
      const parseIdx = s.indexOf('Input.parse_input_event(event)');
      expect(parseIdx, `${fn} 须有 parse 注入`).toBeGreaterThanOrEqual(0);
      const guardIdx = s.indexOf('if do_flush:');
      expect(guardIdx, `${fn} 须有 do_flush 守卫分支`).toBeGreaterThan(parseIdx);
      const flushIdx = s.indexOf('Input.flush_buffered_events()');
      expect(flushIdx, `${fn} 须调 flush_buffered_events`).toBeGreaterThan(guardIdx);
      // 紧跟:parse 与 flush 之间只允许注释/守卫行(距 parse < 500 字符,防中间插其他逻辑)
      expect(flushIdx - parseIdx,
        `${fn} flush 须紧跟 parse(中间只留注释与守卫,不得插其他逻辑)`).toBeLessThan(500);
      // 默认参数形态:直接调用路径默认 flush=true;timeline 显式传 false
      expect(s.includes(`${fn}(params: Dictionary, do_flush := true)`),
        `${fn} 签名须带 do_flush := true 默认参数(直接路径默认 flush)`).toBe(true);
    });
  }

  it('_inject_timeline_event 不 flush(有意延迟):三处复用显式传 do_flush=false', () => {
    const s = funcSlice('_inject_timeline_event');
    expect(s.includes('flush_buffered_events'),
      'timeline 逐帧注入不得 flush(at_frame 帧对齐是有意延迟)').toBe(false);
    expect(s.includes('_cmd_send_mouse_click(ev, false)'), 'mouse_click 复用须传 false').toBe(true);
    expect(s.includes('_cmd_send_mouse_move(ev, false)'), 'mouse_move 复用须传 false').toBe(true);
    expect(s.includes('_cmd_send_touch(ev, false)'), 'touch 复用须传 false').toBe(true);
  });

  it('flush_buffered_events 全文件调用点恰好三处(均在三注入函数内,timeline/其他路径零调用)', () => {
    const count = (gd.match(/Input\.flush_buffered_events\(\)/g) ?? []).length;
    expect(count, '三处注入函数各一,别处不得出现(全局 flush 会破坏 timeline 延迟语义)').toBe(3);
  });
});

describe('A5: 文档五要点契约(双副本「输入注入管线要点」)', () => {
  const tpl = DETAILED_RULE_TEMPLATES['godot-mcp-bridge.md'];
  const rulesCopy = readFileSync('.claude/rules/godot-mcp-bridge.md', 'utf8');

  // 五要点关键词:每条须在模板与 rules 双副本同时出现(rules-sync 之外的关键词级锚定)
  const FIVE_POINTS: Array<{ label: string; keywords: string[] }> = [
    {
      label: '① 即时生效语义:flush 当帧派发/逻辑消费下一帧/查询前等 ≥1 帧/timeline 不 flush',
      keywords: ['flush_buffered_events', '当帧派发', '下一帧', '≥1 帧', '不 flush'],
    },
    {
      label: '② 坐标系=窗口/视口像素 vs 逻辑坐标差窗口缩放倍数(高 DPI/stretch 换算公式)',
      keywords: ['逻辑坐标', '窗口缩放', '窗口实际尺寸 / 视口尺寸', '高 DPI'],
    },
    {
      label: '③ headless CanvasLayer 拾取可能不达 → 结构直驱(EXTRA_METHODS/GDA_CALLABLE)',
      keywords: ['CanvasLayer', '结构直驱', 'GDA_CALLABLE'],
    },
    {
      label: '④ 排查清单补 DPI/窗口缩放 + click_button 对照',
      keywords: ['DPI', 'click_button', '坐标换算'],
    },
    {
      label: '⑤ headless BaseButton 点击链不达(A2A3 真机定谳,Button e2e 须带窗口)',
      keywords: ['BaseButton', '带窗口'],
    },
  ];

  for (const point of FIVE_POINTS) {
    it(`模板含: ${point.label}`, () => {
      expect(tpl, '模板须存在').toBeTruthy();
      for (const kw of point.keywords) {
        expect(tpl!.includes(kw), `模板缺关键词「${kw}」`).toBe(true);
      }
    });
    it(`rules 副本含: ${point.label}`, () => {
      for (const kw of point.keywords) {
        expect(rulesCopy.includes(kw), `rules 副本缺关键词「${kw}」`).toBe(true);
      }
    });
  }
});
