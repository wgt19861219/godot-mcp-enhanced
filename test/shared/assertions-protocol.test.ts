import { describe, it, expect } from 'vitest';
import { wrapAssertionCode, resolveAssertionPass } from '../../src/tools/shared/assertions.js';

// H-3 (2026-10-22 审查第二轮): 断言协议结构化。
// 修复前缺陷三连:
//   a) workflow/delivery 判定 `a.expect ? actual === a.expect : true`——无 expect 时只要
//      脚本跑成功即 passed:true(空代码/忘输出 assert_result 假绿);
//   b) wrapper PASS 条件 `assert_result != ""`——值为字符串 "false" 也打 PASS(语义错误);
//   c) wrapper 的 ASSERT PASS/FAIL print 与 TS 判定各说各话,无结构化协议。
// 修复:wrapper 输出结构化 _mcp_output("assert_protocol_pass","true"/"false");TS 侧唯一
// 判定口径 resolveAssertionPass——协议字段缺失或非 "true" 一律 fail(fail-closed)。
describe('H-3 断言协议（2026-10-22 审查第二轮）', () => {
  it('wrapper 生成结构化 assert_protocol_pass 两分支', () => {
    const code = wrapAssertionCode('pass', 'd', true);
    expect(code).toContain('_mcp_output("assert_protocol_pass", "true")');
    expect(code).toContain('_mcp_output("assert_protocol_pass", "false")');
  });
  it('无 expect:协议字段缺失 → fail（空代码/忘输出必假红）', () => {
    expect(resolveAssertionPass([{ key: 'assert_result', value: 'anything' }])).toBe(false);
    expect(resolveAssertionPass([])).toBe(false);
  });
  it('无 expect:协议 pass 且 assert_result 有证据 → pass', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'true' },
      { key: 'assert_result', value: 'ok' },
    ])).toBe(true);
  });
  it('无 expect:assert_result 为字符串 "false" → wrapper 打协议 false → fail（修语义错误）', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'false' },
      { key: 'assert_result', value: 'false' },
    ])).toBe(false);
  });
  it('有 expect:协议 pass 且 actual==expect → pass', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'true' },
      { key: 'assert_result', value: '42' },
    ], '42')).toBe(true);
  });
  it('有 expect:协议 pass 但 actual!=expect → fail', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'true' },
      { key: 'assert_result', value: '43' },
    ], '42')).toBe(false);
  });
});
