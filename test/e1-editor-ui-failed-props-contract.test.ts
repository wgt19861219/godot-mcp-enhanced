import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Task D5 (2026-11-12) editor 契约:ui_create_control 属性失败/跳过上报 failed_props。
// 修复前:coerce_property_value 已在(609761e1d),但 r.ok 失败无 else 分支(静默吞),
// ":"/"/" 子属性键直接 continue 丢弃——调用方看到 "created" 但属性没落,无从排查。
// 修复后:失败/跳过逐键收集进响应 failed_props 字段。
//
// ⚠️ 局限(对齐 e1-headless-coerce-contract 范式):源码字符串断言验证"修复模式落位"
// 而非运行时行为(editor 运行时行为由 editor e2e 手动验证覆盖)。

const uiGd = readFileSync('addons/godot_mcp_server/commands/ui_commands.gd', 'utf8');
const fixtureGd = readFileSync('test/fixtures/real-project/addons/godot_mcp_server/commands/ui_commands.gd', 'utf8');

function sliceCreateControl(source: string): string {
  const start = source.indexOf('func handle_ui_create_control');
  expect(start, 'handle_ui_create_control 未找到').toBeGreaterThanOrEqual(0);
  const end = source.indexOf('func handle_ui_set_layout', start);
  expect(end, 'handle_ui_set_layout 锚点未找到').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('D5: editor ui_create_control 属性失败上报(ui_commands.gd)', () => {
  it('FP-a: coerce 失败(r.ok=false)进 failed_props,不再静默吞', () => {
    const s = sliceCreateControl(uiGd);
    expect(s.includes('var failed_props: Array = []'), '缺 failed_props 收集变量').toBe(true);
    const okIdx = s.indexOf('if r["ok"]:');
    expect(okIdx, '缺 r["ok"] 分支').toBeGreaterThanOrEqual(0);
    const elseIdx = s.indexOf('else:', okIdx);
    expect(elseIdx, 'r["ok"] 缺 else 分支(失败静默吞)').toBeGreaterThan(okIdx);
    const elseBlock = s.slice(elseIdx, s.indexOf('return', elseIdx));
    expect(elseBlock.includes('failed_props.append'), 'else 分支缺 failed_props.append').toBe(true);
  });

  it('FP-b: ":"/"/" 子属性键跳过进 failed_props(不再静默 continue 丢弃)', () => {
    const s = sliceCreateControl(uiGd);
    const skipIdx = s.indexOf('if ":" in key or "/" in key:');
    expect(skipIdx, '缺 :// 子属性键过滤分支').toBeGreaterThanOrEqual(0);
    const branch = s.slice(skipIdx, s.indexOf('var val', skipIdx));
    expect(branch.includes('failed_props.append'), '":"//"" 跳过分支未收集 failed_props').toBe(true);
  });

  it('FP-c: 响应 result 携带 failed_props 字段', () => {
    const s = sliceCreateControl(uiGd);
    expect(s.includes('"failed_props"'), '响应缺 failed_props 字段').toBe(true);
  });

  it('FP-d: real-project fixture 副本同步 failed_props 模式(防 fixture 漂移)', () => {
    const fixture = sliceCreateControl(fixtureGd);
    expect(fixture.includes('failed_props'), 'fixture 副本缺 failed_props 收集').toBe(true);
  });
});
