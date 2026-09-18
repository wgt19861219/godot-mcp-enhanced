import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { executeGdscript } from '../src/gdscript-executor.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GODOT_PATH = process.env.GODOT_PATH ?? '';
const CHECK_PROJECT = resolve(__dirname, 'fixtures', 'gdscript-check');
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

/**
 * P2-2 (2026-09-11): report 结构化搭车 — step/step_until 响应自带终态读数(省观察往返)。
 * 来源 satellite mcp_game_bridge.gd;刻意结构化 {path,property}(不引入 Expression,
 * 对齐 step_until conditions 的 RCE 规避边界);属性过 _is_blocked_property;逐条失败不炸。
 * P2-3 (2026-09-11): freeze 竞争上报 — 游戏代码对抗 freeze 的 unpause 计数 + re-assert,
 * unfreeze 响应报 frozen_for_ms/contested_reasserts(satellite freeze_contested 变体)。
 */

describe('P2-2/2-3: bridge 源码契约', () => {
  const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

  it('RP-a: report 校验+求值函数存在(结构化,无 Expression)', () => {
    expect(gd.includes('func _validate_report_spec'), '校验函数').toBe(true);
    expect(gd.includes('func _eval_structured_report'), '求值函数').toBe(true);
    expect(gd.includes('_REPORT_MAX_ENTRIES := 16'), '条数上限').toBe(true);
    expect(gd.includes('_is_blocked_property(rprop)'), '属性黑名单过滤').toBe(true);
    expect(gd.includes('_jsonify(n.get(rprop))'), '值经 _jsonify 序列化').toBe(true);
    // RCE 边界:求值路径不得引入 Expression
    const evalFn = gd.slice(gd.indexOf('func _eval_structured_report'), gd.indexOf('\nfunc ', gd.indexOf('func _eval_structured_report') + 10));
    expect(evalFn.includes('Expression'), '求值不得用 Expression').toBe(false);
  });

  it('RP-b: step 与 step_until 两路全链路(入口校验→哨兵→pending→完成响应)', () => {
    const fnSlice = (name: string): string => {
      const start = gd.indexOf(`func ${name}`);
      const end = gd.indexOf('\nfunc ', start + 10);
      return gd.slice(start, end);
    };
    // step 入口
    const stepFn = fnSlice('_cmd_playtest_step');
    expect(stepFn.includes('_validate_report_spec(params)'), 'step 入口校验').toBe(true);
    expect(stepFn.includes('"__deferred__": "playtest_step"'), 'step 延迟哨兵(O1 批5:report/profile 平铺进 payload,原临时变量已收敛)').toBe(true);
    // step_until 入口(哨兵构造带 report)
    const suFn = fnSlice('_cmd_control_step_until');
    expect(suFn.includes('_validate_report_spec(params)'), 'step_until 入口校验').toBe(true);
    expect(suFn.includes('"report": su_vr[1]'), '哨兵携带 report').toBe(true);
    // 两路 pending 存 report + 完成响应求值
    expect((gd.match(/"report": p\.get\("report", \[\]\)/g) ?? []).length, '两路 pending 存 report').toBe(2);
    expect((gd.match(/_eval_structured_report\(_step_report_specs|_eval_structured_report\(_su_report_specs/g) ?? []).length, '两路完成响应求值').toBe(2);
  });

  it('RP-c: freeze 竞争检测(被解开才计数 + re-assert;unfreeze 报终值)', () => {
    expect(gd.includes('_freeze_contested_count += 1'), '竞争计数').toBe(true);
    expect(gd.includes('if not get_tree().paused:'), '仅被解开才计(已 paused 不重复)').toBe(true);
    expect(gd.includes('"contested_reasserts"'), 'unfreeze 报竞争数').toBe(true);
    expect(gd.includes('"frozen_for_ms"'), 'unfreeze 报持冻时长').toBe(true);
    // 竞争计数逻辑在维持段(_control_frozen 分支内)
    const maintain = gd.slice(gd.indexOf('# ─── G1 (2026-08-13) control-first'), gd.indexOf('# step_until 轮询'));
    expect(maintain.includes('_freeze_contested_count'), '计数在维持段').toBe(true);
  });
});

describe.skipIf(!hasGodot)('P2-2: _validate_report_spec 行为探针(真跑 Godot)', () => {
  async function runProbe(lines: string[]): Promise<{ realError: boolean; values: Record<string, string> }> {
    const code = ['extends SceneTree', '', 'func _init():', '\tvar B = load("res://src/scripts/mcp_bridge.gd")', ...lines.map(l => '\t' + l), '\tquit()', ''].join('\n');
    const result = await executeGdscript({ godotPath: GODOT_PATH, projectPath: CHECK_PROJECT, timeout: 30, code });
    const realError = /\b(Parse Error|SCRIPT ERROR|Invalid |ENGINE ERROR)\b/.test(result.raw_output);
    const values: Record<string, string> = {};
    for (const line of result.raw_output.split('\n')) {
      const m = line.match(/^RESULT\s+(\S+?)=(.*)$/);
      if (m) values[m[1]!] = m[2]!;
    }
    return { realError, values };
  }

  it('RP-d: 校验矩阵——空放行/合法通过/缺键拒/blocked property 拒/超限拒', async () => {
    const { realError, values } = await runProbe([
      'var b = B.new()',
      'var r0 = b._validate_report_spec({})',
      'print("RESULT empty_ok=" + str(bool(r0[0]) and (r0[1] as Array).is_empty()))',
      'var r1 = b._validate_report_spec({"report": [{"path": "/root/Main", "property": "position"}]})',
      'print("RESULT valid_ok=" + str(bool(r1[0]) and (r1[1] as Array).size() == 1))',
      'var r2 = b._validate_report_spec({"report": [{"path": "/root/Main"}]})',
      'print("RESULT missing_key_rejected=" + str(not bool(r2[0])))',
      'var r3 = b._validate_report_spec({"report": [{"path": "/root/Main", "property": "script"}]})',
      'print("RESULT blocked_rejected=" + str(not bool(r3[0])))',
      'var many: Array = []',
      'for i in range(17): many.append({"path": "/root/N%d" % i, "property": "name"})',
      'var r4 = b._validate_report_spec({"report": many})',
      'print("RESULT over_limit_rejected=" + str(not bool(r4[0])))',
    ]);
    expect(realError).toBe(false);
    expect(values.empty_ok).toBe('true');
    expect(values.valid_ok).toBe('true');
    expect(values.missing_key_rejected).toBe('true');
    expect(values.blocked_rejected).toBe('true');
    expect(values.over_limit_rejected).toBe('true');
  });
});
