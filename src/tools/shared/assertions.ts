// Assertion infrastructure for dev_loop acceptance and delivery.ts assertions.

import { escapeForGdLiteral, normalizeIndentToTabs } from './value-serializer.js';
import { SCENE_TREE_HEADER } from '../../core/shared/gdscript-templates.js';
import { scanGdscriptSandbox } from '../../gdscript-executor.js';

/** Shared assertion wrapper — called by both dev_loop.acceptance and delivery.ts assertions.
 *  Scans user assertion code through the GDScript sandbox before wrapping (C-SEC-07).
 *
 *  ASSERT 协议生成(反假绿):wrapper 在用户代码后强制从 _mcp_outputs 的 assert_result 派生
 *  ASSERT PASS/FAIL 并 print,用户无法手写 print 伪造(defect visual-proof-assert-protocol-implicit)。
 *  expected 给出 → actual==expected 才 PASS;未给 → assert_result 非空即 PASS(证据)。 */
export function wrapAssertionCode(assertionCode: string, description: string, loadScene = true, expected?: string): string {
  const sandboxWarnings = scanGdscriptSandbox(assertionCode);
  if (sandboxWarnings.length > 0) {
    throw new Error(`Assertion code blocked by sandbox: ${sandboxWarnings.join('; ')}`);
  }
  // 纯字面量上下文(_desc 仅 print 显示 / expected 仅字符串比较,均非 % 格式串)→ escapeForGdLiteral
  const escapedDesc = escapeForGdLiteral(description);
  const sceneLoadLine = loadScene ? '\t_mcp_load_main_scene()\n' : '';
  // Normalize spaces to tabs BEFORE joining with tab prefix to avoid mixed indentation
  const normalizedCode = normalizeIndentToTabs(assertionCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const indentedCode = normalizedCode.split('\n').join('\n\t');
  // ASSERT 协议派生(反假绿):读 _mcp_outputs.assert_result → 比对 expected → print ASSERT PASS/FAIL。
  // wrapper 强制生成,用户无法手写 print 伪造通过状态。
  // H-3(2026-10-22 审查):pass/fail 两分支各输出结构化协议字段 assert_protocol_pass,TS 侧
  // (workflow/delivery 经 resolveAssertionPass)以此字段为唯一判定口径——print 文本仅供人类
  // 可读日志。无 expect 时 "false" 字符串视为失败证据(原 != "" 语义错误)。
  const escapedExpected = expected != null ? escapeForGdLiteral(expected) : '';
  const passCond = expected != null ? `if _ar == "${escapedExpected}":` : 'if _ar != "" and _ar != "false":';
  const assertGenCode = [
    '\tvar _ar: String = ""',
    '\tfor _e in _mcp_outputs:',
    '\t\tvar _entry: Dictionary = _e',
    '\t\tif String(_entry["key"]) == "assert_result":',
    '\t\t\t_ar = String(_entry["value"])',
    '\t\t\tbreak',
    `\t${passCond}`,
    '\t\t_mcp_output("assert_protocol_pass", "true")',
    '\t\tprint("ASSERT PASS: " + _desc)',
    '\telse:',
    '\t\t_mcp_output("assert_protocol_pass", "false")',
    '\t\tprint("ASSERT FAIL: " + _desc)',
  ].join('\n') + '\n';
  return `${SCENE_TREE_HEADER}

func _initialize():
${sceneLoadLine}\tvar _desc = "${escapedDesc}"
\t# --- user assertion code ---
\t${indentedCode}
\t# --- end user code ---
${assertGenCode}\t_mcp_done()
`;
}

/** H-3(2026-10-22 审查): acceptance 断言唯一判定口径——wrapper 生成的结构化协议字段
 * assert_protocol_pass 必须存在且为 "true";协议缺失(空代码提前 return/忘执行 wrapper/
 * 旧形态输出)一律 fail(fail-closed)。expect 匹配虽已内嵌 wrapper 生成条件,TS 侧对
 * assert_result 再校验一次作双保险(防协议字段与实际值不一致的畸形 outputs)。 */
export function resolveAssertionPass(
  outputs: Array<{ key: string; value: unknown }>,
  expect?: string,
): boolean {
  const protocol = outputs.find(e => e.key === 'assert_protocol_pass');
  if (!protocol || String(protocol.value) !== 'true') return false;
  if (expect !== undefined) {
    const actual = String(outputs.find(e => e.key === 'assert_result')?.value ?? '');
    if (actual !== expect) return false;
  }
  return true;
}
