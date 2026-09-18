/**
 * P7 批 (2026-09-11): 语义观察层(gua 移植)——观察 profile + 可见性级联 + 字段投影 + UI role。
 *
 * 断言分层:
 * - 源码契约层(全平台必跑): 关键实现段存在性——投影核心(fail-closed 降级/级联/分量键/
 *   role 表)、六接线点(find_nodes/properties/layout/monitor/watch/ui)、near × 投影联动
 *   (-11)、profile 门禁(-20/-21)、TS 侧三 case 透传 + schema 枚举。
 * - 行为探针层(需 GODOT_PATH): 直接实例化 mcp_bridge.gd(不 add_child,_ready 不跑,server 不启)
 *   调内部函数,验证投影语义矩阵(对齐 p3-network-behavior 探针模式)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeGdscript } from '../src/gdscript-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const GD = readFileSync(resolve(REPO, 'src/scripts/mcp_bridge.gd'), 'utf-8');
const TS = readFileSync(resolve(REPO, 'src/tools/game-bridge.ts'), 'utf-8');
const FIXTURE_MAIN = readFileSync(resolve(REPO, 'test/fixtures/p3-e2e/main.gd'), 'utf-8');

const GODOT_PATH = process.env.GODOT_PATH ?? '';
const CHECK_PROJECT = resolve(__dirname, 'fixtures', 'gdscript-check');
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

// ─── 源码契约层 ─────────────────────────────────────────────────────────────

describe('P7: 语义观察层 — GD 源码契约', () => {
  it('GD-a: 投影核心函数齐备(规则加载/值应用/dict投影/级联/profile解析/near联动/role表)', () => {
    for (const fn of [
      'func _load_field_rules(', 'func _apply_field_rule(', 'func _project_dict(',
      'func _observable_in_player(', 'func _resolve_observation_profile(',
      'func _position_rule_state(', 'func _ui_role(', 'func _ui_label(',
    ]) {
      expect(GD.includes(fn), `缺少 ${fn}`).toBe(true);
    }
  });

  it('GD-b: 五模式全覆盖——keep 跳过/omit+redact/replace 需 replacement/quantize 需 quantum>0', () => {
    // fail-closed 降级三分支(未知 mode / 缺 replacement / 坏 quantum → redact)
    expect(GD.includes('"keep":')).toBe(true);
    expect(GD.includes('"omit", "redact":')).toBe(true);
    expect(GD.match(/fail-closed/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // quantize 走 snapped(尽调许可的简化,非 gua frexp/ldexp 精确有理数)
    expect(GD.includes('snapped(float(value), float(rule["quantum"]))')).toBe(true);
    // 重复 path 后者覆盖(gua 同款)
    expect(GD.includes('rules[path] = rule  # 重复 path 后者覆盖')).toBe(true);
    // 规则数上限
    expect(GD.includes('MAX_FIELD_RULES')).toBe(true);
  });

  it('GD-c: 可见性级联——两维度声明(private/visible_to_player)+深度上限+宽容解析', () => {
    expect(GD.includes('CASCADE_MAX_DEPTH')).toBe(true);
    expect(GD.includes('str(current.get_meta(EXPOSURE_META)).to_lower() == "private"')).toBe(true);
    // 宽容解析:类型分支(bool false / 字符串 "false" 大小写不敏感)——GDScript 4 的 ==
    // 不做 String↔bool 隐式转换,裸 `v == false` 在字符串值时是运行时错误(探针实测)
    expect(GD.includes('if v is bool:')).toBe(true);
    expect(GD.includes('v_hidden = (v as String).to_lower() == "false"')).toBe(true);
  });

  it('GD-d: profile 门禁——env 白名单(_ready 读一次)+-20 非法值+-21 未授权', () => {
    expect(GD.includes('GODOT_MCP_BRIDGE_ALLOWED_PROFILES')).toBe(true);
    expect(GD.includes('"code": -20')).toBe(true);
    expect(GD.includes('"code": -21')).toBe(true);
    expect(GD.includes('var _allowed_profiles: Array = ["debug"]')).toBe(true);
  });

  it('GD-e: 六接线点——player 档级联过滤/投影挂到全部 read 输出通道', () => {
    // find_nodes: callback 级联过滤 + 序列化投影
    expect(GD.includes('if player_mode:\n\t\t\t\tif not _observable_in_player(node):')).toBe(true);
    expect(GD.includes('_project_dict(node, info)  # P7: 字段投影')).toBe(true);
    // get_node_properties / get_node_layout: 不可观察 → not found(存在性不泄露)+ 投影
    const propsBlock = GD.slice(GD.indexOf('func _cmd_get_node_properties('));
    expect(propsBlock.includes('if player_mode and not _observable_in_player(node):')).toBe(true);
    expect(propsBlock.includes('_project_dict(node, props)')).toBe(true);
    const layoutBlock = GD.slice(GD.indexOf('func _cmd_get_node_layout('));
    expect(layoutBlock.includes('_project_dict(node, data)')).toBe(true);
    // monitor: start 校验 + 状态存 profile + 采样/补采投影(实时读 meta)
    expect(GD.includes('"profile": profile,  # P7: 采样时按此档位投影')).toBe(true);
    expect(GD.includes('if str(ms.get("profile", "debug")) == "player":\n\t\t\t\t_project_dict(node, values)')).toBe(true);
    expect(GD.includes('_project_dict(_stop_node, _stop_values)  # P7: 补采同样投影')).toBe(true);
    // watch: start 校验 + 中途可见性复查(args 不投影的设计偏离在注释中声明)
    expect(GD.includes('"profile": profile,  # P7: 事件记录时按此档位复查可见性')).toBe(true);
    expect(GD.includes('if str(ws.get("profile", "debug")) == "player":')).toBe(true);
    // find_ui_elements: 级联过滤 + 投影
    expect(GD.includes('if player_mode and not _observable_in_player(ctrl):')).toBe(true);
  });

  it('GD-f: near × 投影联动(P5 钩子清偿)——锚点/候选 position 有规则即排除,-11 防差分反推', () => {
    expect(GD.includes('"code": -11')).toBe(true);
    expect(GD.includes('anti distance-differencing')).toBe(true);
    // 候选侧:position 被规则的节点不进 near 结果
    expect(GD.includes('if near_anchor != null and _position_rule_state(node) != "":\n\t\t\t\t\treturn false')).toBe(true);
  });

  it('GD-g: role/label 适配表——gua _control_role 移植 + 子类先判顺序', () => {
    for (const [klass, role] of [
      ['OptionButton', 'combobox'], ['ItemList', 'list'], ['TabContainer', 'tablist'],
      ['CheckBox', 'checkbox'], ['CheckButton', 'checkbox'], ['ProgressBar', 'progressbar'],
      ['BaseButton', 'button'], ['Label', 'text'], ['LineEdit', 'textbox'],
      ['Slider', 'slider'], ['SpinBox', 'slider'], ['ScrollContainer', 'scrollarea'],
    ] as const) {
      expect(GD.includes(`ctrl is ${klass}`), `role 表缺 ${klass}`).toBe(true);
    }
    // 子类先判:CheckBox 分支必须出现在 BaseButton 分支之前(否则被 button 吞掉)
    const roleFn = GD.slice(GD.indexOf('func _ui_role('), GD.indexOf('func _ui_label('));
    expect(roleFn.indexOf('CheckBox')).toBeLessThan(roleFn.indexOf('if ctrl is BaseButton'));
    // label: OptionButton 用 name(其 text 是选中项文本,与 value 语义混淆)
    expect(GD.includes('ctrl is BaseButton and not ctrl is OptionButton')).toBe(true);
  });

  it('GD-h: 设计偏离清单落注释(审查锚)——watch args 不投影/动作白名单不移植/坏规则 fail-closed', () => {
    expect(GD.includes('设计偏离清单(相对 gua,审查用)')).toBe(true);
    expect(GD.includes('watch 事件 args 不做字段投影')).toBe(true);
    expect(GD.includes('agent_allowed_actions 位掩码不移植')).toBe(true);
  });

  it('GD-i: B-1 清偿——四读出口接线(get_tree/wait×2/call_method/report)+snapshot 拒+强制档', () => {
    // get_tree: player 剪枝 + 投影 + 根不可观察空树
    const treeBlock = GD.slice(GD.indexOf('func _cmd_get_tree('), GD.indexOf('# 批 2 readScene'));
    expect(treeBlock.includes('_resolve_observation_profile(params)')).toBe(true);
    expect(treeBlock.includes('player_mode')).toBe(true);
    expect(treeBlock.includes('_observable_in_player(root_node)')).toBe(true);
    expect(GD.includes('continue  # B-1: 不可观察子树整枝剪除(与 find_nodes 级联语义一致)')).toBe(true);
    expect(GD.includes('return brief'), '截断分支也投影').toBe(true);
    // wait_for_node: 不可观察 exists=false(存在性侧信道封堵)
    const wfnBlock = GD.slice(GD.indexOf('func _cmd_wait_for_node('), GD.indexOf('func _cmd_wait_for_property('));
    expect(wfnBlock.includes('node_exists = false')).toBe(true);
    // wait_for_property: match 基于投影后值(防真值二分探测)
    const wfpBlock = GD.slice(GD.indexOf('func _cmd_wait_for_property('), GD.indexOf('# ─── Visual'));
    expect(wfpBlock.includes('match_src = shown  # match 也基于投影后值')).toBe(true);
    // call_method: 不可观察 not found + 枚举方法拒 -22 + get 投影(同步与协程两路)
    const cmBlock = GD.slice(GD.indexOf('func _cmd_call_method('));
    expect(cmBlock.includes('PLAYER_BLOCKED_ENUM_METHODS')).toBe(true);
    expect(GD.includes('"code": -22')).toBe(true);
    expect(cmBlock.includes('"player_mode": player_mode')).toBe(true);
    expect(cmBlock.includes('await_completion 旁路')).toBe(true);
    // report 搭车: profile 随 pending 传 + 求值投影(O1 批5:消费端从 _deferred payload 取,原 _step_profile 局部变量收敛)
    expect(GD.includes('"profile": str(p.get("profile", "debug")),  # B-1: report 求值按此档位投影')).toBe(true);
    expect(GD.includes('_eval_structured_report(_step_report_specs, str(entry.get("profile", "debug")))')).toBe(true);
    expect(GD.includes('_eval_structured_report(_su_report_specs, str(su_entry.get("profile", "debug")))')).toBe(true);
    // conditions: player 档同 wait_for_property 语义
    expect(GD.includes('var _su_player := str(su_entry.get("profile", "debug")) == "player"')).toBe(true);
    // snapshot/restore: player 档拒 -23(保真语义)
    expect(GD.includes('"code": -23')).toBe(true);
    // 强制档: 单值 env 锁定,请求级被静默提升
    expect(GD.includes('var _forced_profile: String = ""')).toBe(true);
    expect(GD.includes('if _parsed.size() == 1:')).toBe(true);
    expect(GD.includes('if _forced_profile != "":\n\t\treturn {"profile": _forced_profile, "forced": true}')).toBe(true);
    // N-1: replacement 安全标量检查
    expect(GD.includes('e.has("replacement") and _is_safe_value(e["replacement"])')).toBe(true);
  });
});

describe('P7: 语义观察层 — TS 源码契约', () => {
  it('TS-a: 三 case 透传 observation_profile(默认 debug)', () => {
    const monitorBlock = TS.slice(TS.indexOf("case 'monitor_start'"), TS.indexOf('case \'monitor_stop\''));
    expect(monitorBlock.includes("observation_profile: (args.observation_profile as string) ?? 'debug'")).toBe(true);
    const watchBlock = TS.slice(TS.indexOf("case 'watch_start'"), TS.indexOf('case \'watch_stop\''));
    expect(watchBlock.includes("observation_profile: (args.observation_profile as string) ?? 'debug'")).toBe(true);
    const uiBlock = TS.slice(TS.indexOf("case 'find_ui_elements'"), TS.indexOf('case \'click_button\''));
    expect(uiBlock.includes("observation_profile: (args.observation_profile as string) ?? 'debug'")).toBe(true);
  });

  it('TS-b: schema 枚举 + params 描述携带 observation_profile(game_query 走 params 同名键)', () => {
    expect(TS.includes("observation_profile: { type: 'string', enum: ['debug', 'player']")).toBe(true);
    expect(TS.includes('observation_profile?}(near_node 近邻')).toBe(true);
    expect(TS.includes('get_node_properties{path,observation_profile?}')).toBe(true);
  });

  it('TS-c: fixture P7 节点声明——SecretEnemy 四规则/HiddenParent private/ChildOfHidden 级联/FoggedOut/PlainNode', () => {
    expect(FIXTURE_MAIN.includes('SecretEnemy')).toBe(true);
    expect(FIXTURE_MAIN.includes('{"path": "position", "mode": "quantize", "quantum": 64}')).toBe(true);
    expect(FIXTURE_MAIN.includes('{"path": "hp", "mode": "redact"}')).toBe(true);
    expect(FIXTURE_MAIN.includes('hidden.set_meta("agent_exposure", "private")')).toBe(true);
    expect(FIXTURE_MAIN.includes('fogged.set_meta("visible_to_player", false)')).toBe(true);
    // GDA_CALLABLE 扩展(游戏中途藏/恢复节点 + 读真实位置 + watch 信号)
    expect(FIXTURE_MAIN.includes('"hide_secret_enemy", "unhide_secret_enemy", "get_secret_position", "emit_p7_ping", "hide_main", "unhide_main"')).toBe(true);
  });
});

// ─── 行为探针层(真跑 Godot) ─────────────────────────────────────────────────

async function runP7Probe(lines: string[]): Promise<{ realError: boolean; values: Record<string, string>; raw: string }> {
  const code = [
    'extends SceneTree',
    '',
    'func _init():',
    '\tvar B = load("res://src/scripts/mcp_bridge.gd")',
    '\tvar b = B.new()',
    ...lines.map(l => '\t' + l),
    '\tb.free()',
    '\tquit()',
  ].join('\n');
  const result = await executeGdscript({ godotPath: GODOT_PATH, projectPath: CHECK_PROJECT, timeout: 30, code });
  const raw = result.raw_output;
  const realError = /\b(Parse Error|SCRIPT ERROR|Invalid |ENGINE ERROR)\b/.test(raw);
  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^RESULT\s+(\S+?)=(.*)$/);
    if (m) values[m[1]!] = m[2]!;
  }
  if (realError) process.stderr.write(`[probe code]\n${code.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}\n[probe raw]\n${raw}\n`);
  return { realError, values, raw };
}

/** 探针公共前缀:建测试节点树(parent/child 入树才能测级联)。 */
const SETUP_TREE = [
  'var parent_n := Node2D.new()',
  'var child_n := Node2D.new()',
  'parent_n.add_child(child_n)',
  'root.add_child(parent_n)',
];

describe.skipIf(!hasGodot)('P7: 投影核心行为探针(真跑 Godot)', () => {
  it('PB-a: _load_field_rules 归一化——四模式入表 + keep 跳过 + 重复 path 后者覆盖', async () => {
    const { realError, values } = await runP7Probe([
      'var n := Node2D.new()',
      'n.set_meta("agent_field_rules", [',
      '\t{"path": "position", "mode": "quantize", "quantum": 64},',
      '\t{"path": "hp", "mode": "redact"},',
      '\t{"path": "keepme", "mode": "keep"},',
      '\t{"path": "dup", "mode": "omit"},',
      '\t{"path": "dup", "mode": "redact"},',
      '])',
      'var rules: Dictionary = b._load_field_rules(n)',
      'print("RESULT size=" + str(rules.size()))',
      'print("RESULT keepme_absent=" + str(not rules.has("keepme")))',
      'print("RESULT dup_mode=" + str(rules["dup"]["mode"]))',
      'print("RESULT q=" + str(rules["position"]["quantum"]))',
    ]);
    expect(realError).toBe(false);
    expect(values.size).toBe('3');  // position/hp/dup(keepme skip 不入表,dup 后者覆盖)
    expect(values.keepme_absent).toBe('true');
    expect(values.dup_mode).toBe('redact');  // 后者覆盖
    expect(values.q).toBe('64.0');
  });

  it('PB-b: fail-closed 降级——未知 mode/缺 replacement/quantum<=0 → redact;坏条目/坏 meta 容错', async () => {
    const { realError, values } = await runP7Probe([
      'var n := Node2D.new()',
      'n.set_meta("agent_field_rules", [',
      '\t{"path": "a", "mode": "weird"},',
      '\t{"path": "b", "mode": "replace"},',
      '\t{"path": "c", "mode": "quantize", "quantum": -5},',
      '\t"not-a-dict",',
      '\t{"mode": "omit"},',
      '])',
      'var rules: Dictionary = b._load_field_rules(n)',
      'print("RESULT a=" + str(rules["a"]["mode"]))',
      'print("RESULT b=" + str(rules["b"]["mode"]))',
      'print("RESULT c=" + str(rules["c"]["mode"]))',
      'var n2 := Node2D.new()',
      'n2.set_meta("agent_field_rules", "garbage")',
      'print("RESULT badmeta=" + str(b._load_field_rules(n2).is_empty()))',
      'var n3 := Node2D.new()',
      'print("RESULT nometa=" + str(b._load_field_rules(n3).is_empty()))',
    ]);
    expect(realError).toBe(false);
    expect(values.a).toBe('redact');
    expect(values.b).toBe('redact');
    expect(values.c).toBe('redact');
    expect(values.badmeta).toBe('true');
    expect(values.nometa).toBe('true');
  });

  it('PB-c: _apply_field_rule——redact 三形态(数值0/bool false/字符串)/quantize snapped/replace 原样', async () => {
    const { realError, values } = await runP7Probe([
      'print("RESULT red_num=" + str(b._apply_field_rule(75, {"mode": "redact"})))',
      'print("RESULT red_bool=" + str(b._apply_field_rule(true, {"mode": "redact"})))',
      'print("RESULT red_str=" + str(b._apply_field_rule("secret", {"mode": "redact"})))',
      // snapped(300, 64) = 5*64 = 320(round-to-nearest,非 floor)
      'print("RESULT quant=" + str(b._apply_field_rule(300.0, {"mode": "quantize", "quantum": 64.0})))',
      'print("RESULT quant_nonnum=" + str(b._apply_field_rule("x", {"mode": "quantize", "quantum": 64.0})))',
      'print("RESULT repl=" + str(b._apply_field_rule(12, {"mode": "replace", "replacement": 999})))',
    ]);
    expect(realError).toBe(false);
    expect(values.red_num).toBe('0');
    expect(values.red_bool).toBe('false');
    expect(values.red_str).toBe('[redacted]');
    expect(values.quant).toBe('320.0');
    expect(values.quant_nonnum).toBe('[redacted]');
    expect(values.repl).toBe('999');
  });

  it('PB-d: _project_dict——整键 quantize/omit 删键/分量键 position.x omit 删分量/分量 redact', async () => {
    const { realError, values } = await runP7Probe([
      'var n := Node2D.new()',
      'n.set_meta("agent_field_rules", [',
      '\t{"path": "score", "mode": "omit"},',
      '\t{"path": "hp", "mode": "redact"},',
      '])',
      'var d := {"score": 12, "hp": 75, "untouched": "keep"}',
      'b._project_dict(n, d)',
      'print("RESULT score_absent=" + str(not d.has("score")))',
      'print("RESULT hp=" + str(d["hp"]))',
      'print("RESULT untouched=" + str(d["untouched"]))',
      'var n2 := Node2D.new()',
      'n2.set_meta("agent_field_rules", [',
      '\t{"path": "position.x", "mode": "omit"},',
      '\t{"path": "position.y", "mode": "redact"},',
      '])',
      'var d2 := {"position": {"x": 300.0, "y": 400.0}}',
      'b._project_dict(n2, d2)',
      'print("RESULT x_absent=" + str(not d2["position"].has("x")))',
      'print("RESULT y=" + str(d2["position"]["y"]))',
      // 整键规则作用于 dict 值——逐分量应用(e2e OBS-b 教训:整 dict 直接 quantize 曾变 "[redacted]")
      'var n3 := Node2D.new()',
      'n3.set_meta("agent_field_rules", [',
      '\t{"path": "position", "mode": "quantize", "quantum": 64},',
      '])',
      'var d3 := {"position": {"x": 300.0, "y": 400.0}}',
      'b._project_dict(n3, d3)',
      'print("RESULT whole_qx=" + str(d3["position"]["x"]))',
      'print("RESULT whole_qy=" + str(d3["position"]["y"]))',
    ]);
    expect(realError).toBe(false);
    expect(values.score_absent).toBe('true');
    expect(values.hp).toBe('0');
    expect(values.untouched).toBe('keep');
    expect(values.x_absent).toBe('true');
    expect(values.y).toBe('0');
    expect(values.whole_qx).toBe('320.0');
    expect(values.whole_qy).toBe('384.0');
  });

  it('PB-e: _observable_in_player——private/visible=false/字符串"false"/祖先级联/无 meta 可见', async () => {
    const { realError, values } = await runP7Probe([
      ...SETUP_TREE,
      'print("RESULT plain=" + str(b._observable_in_player(child_n)))',
      'parent_n.set_meta("agent_exposure", "private")',
      'print("RESULT parent_private=" + str(b._observable_in_player(parent_n)))',
      'print("RESULT child_cascade=" + str(b._observable_in_player(child_n)))',
      'parent_n.set_meta("agent_exposure", "auto")',
      'parent_n.remove_meta("agent_exposure")',
      'child_n.set_meta("visible_to_player", false)',
      'print("RESULT self_invisible=" + str(not b._observable_in_player(child_n)))',
      'child_n.set_meta("visible_to_player", "False")',
      'print("RESULT str_false=" + str(not b._observable_in_player(child_n)))',
      'child_n.remove_meta("visible_to_player")',
      'print("RESULT recovered=" + str(b._observable_in_player(child_n)))',
    ]);
    expect(realError).toBe(false);
    expect(values.plain).toBe('true');
    expect(values.parent_private).toBe('false');
    expect(values.child_cascade).toBe('false');  // 祖先 private → 子树不可观察
    expect(values.self_invisible).toBe('true');
    expect(values.str_false).toBe('true');  // 宽容解析字符串 "False"
    expect(values.recovered).toBe('true');
  });

  it('PB-f: _resolve_observation_profile——默认 debug/非法值 -20/player 未授权 -21', async () => {
    const { realError, values } = await runP7Probe([
      'print("RESULT def=" + str(b._resolve_observation_profile({})["profile"]))',
      'var bad = b._resolve_observation_profile({"observation_profile": "yolo"})',
      'print("RESULT bad_code=" + str(bad["error"]["code"]))',
      'var unauth = b._resolve_observation_profile({"observation_profile": "player"})',
      'print("RESULT unauth_code=" + str(unauth["error"]["code"]))',
      // 探针进程未设 env,_ready 未跑 → _allowed_profiles 保持默认 ["debug"]
      'print("RESULT allowed=" + str(b._allowed_profiles))',
    ]);
    expect(realError).toBe(false);
    expect(values.def).toBe('debug');
    expect(values.bad_code).toBe('-20');
    expect(values.unauth_code).toBe('-21');
    expect(values.allowed).toBe('["debug"]');
  });

  it('PB-h: host 强制档——_forced_profile 下请求级 debug 被静默提升为 player(防自降级绕过)', async () => {
    const { realError, values } = await runP7Probe([
      'b._forced_profile = "player"',
      'var forced = b._resolve_observation_profile({"observation_profile": "debug"})',
      'print("RESULT forced_profile=" + str(forced["profile"]))',
      'print("RESULT forced_flag=" + str(forced.get("forced", false)))',
      'var forced2 = b._resolve_observation_profile({})',
      'print("RESULT forced_default=" + str(forced2["profile"]))',
      // 非法值仍 -20(参数形态错误与档位提升正交)
      'var bad = b._resolve_observation_profile({"observation_profile": "yolo"})',
      'print("RESULT still_bad=" + str(bad["error"]["code"]))',
    ]);
    expect(realError).toBe(false);
    expect(values.forced_profile).toBe('player');
    expect(values.forced_flag).toBe('true');
    expect(values.forced_default).toBe('player');
    expect(values.still_bad).toBe('-20');
  });

  it('PB-g: _ui_role/_ui_label——子类先判(CheckBox 不被 button 吞)+OptionButton label 用 name', async () => {
    const { realError, values } = await runP7Probe([
      'print("RESULT checkbox=" + b._ui_role(CheckBox.new()))',
      'print("RESULT button=" + b._ui_role(Button.new()))',
      'print("RESULT combo=" + b._ui_role(OptionButton.new()))',
      'print("RESULT slider=" + b._ui_role(HSlider.new()))',
      'print("RESULT progress=" + b._ui_role(ProgressBar.new()))',
      'print("RESULT text=" + b._ui_role(Label.new()))',
      'print("RESULT panel=" + b._ui_role(Panel.new()))',
      'var btn := Button.new()',
      'btn.text = "Fire"',
      'print("RESULT btn_label=" + b._ui_label(btn))',
      'var ob := OptionButton.new()',
      'ob.name = "Difficulty"',
      'print("RESULT ob_label=" + b._ui_label(ob))',
    ]);
    expect(realError).toBe(false);
    expect(values.checkbox).toBe('checkbox');
    expect(values.button).toBe('button');
    expect(values.combo).toBe('combobox');
    expect(values.slider).toBe('slider');
    expect(values.progress).toBe('progressbar');
    expect(values.text).toBe('text');
    expect(values.panel).toBe('panel');
    expect(values.btn_label).toBe('Fire');
    expect(values.ob_label).toBe('Difficulty');
  });
});
