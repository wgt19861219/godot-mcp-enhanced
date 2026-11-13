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
 * P1-4 (2026-09-11): GDA_CALLABLE per-node 声明白名单 — 行为探针 + 契约。
 * 游戏侧声明 const GDA_CALLABLE := ["take_damage"];bridge 沿脚本基类链静态读
 * get_script_constant_map() 枚举(零项目代码执行,default deny)。来源 aigengame
 * gda_harness.gd:687-764,同名约定保持生态互认。
 */

async function runGdaProbe(lines: string[]): Promise<{ realError: boolean; values: Record<string, string> }> {
  const code = [
    'extends SceneTree',
    '',
    'func _init():',
    '\tvar B = load("res://src/scripts/mcp_bridge.gd")',
    ...lines.map(l => '\t' + l),
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
  return { realError, values };
}

describe.skipIf(!hasGodot)('P1-4: _declared_callables 行为探针(真跑 Godot)', () => {
  it('GDA-a: 动态脚本声明被枚举;无脚本节点 default deny 返空', async () => {
    const { realError, values } = await runGdaProbe([
      'var gs = GDScript.new()',
      'gs.source_code = "extends Node\\nconst GDA_CALLABLE := [\\"take_damage\\", \\"add_velocity\\"]\\n"',
      'gs.reload()',
      'var n = Node.new()',
      'n.set_script(gs)',
      'var names = B._declared_callables(n)',
      'print("RESULT has_take=" + str(names.has("take_damage")))',
      'print("RESULT has_add=" + str(names.has("add_velocity")))',
      'print("RESULT size=" + str(names.size()))',
      'var bare = Node.new()',
      'print("RESULT bare_size=" + str(B._declared_callables(bare).size()))',
    ]);
    expect(realError).toBe(false);
    expect(values.has_take).toBe('true');
    expect(values.has_add).toBe('true');
    expect(values.size).toBe('2');
    expect(values.bare_size, '无脚本节点 default deny').toBe('0');
  });

  it('GDA-b: StringName 项(&"x" 字面量)也被枚举', async () => {
    const { realError, values } = await runGdaProbe([
      'var gs = GDScript.new()',
      'gs.source_code = "extends Node\\nconst GDA_CALLABLE := [&\\"sn_action\\", \\"s_action\\"]\\n"',
      'gs.reload()',
      'var n = Node.new()',
      'n.set_script(gs)',
      'var names = B._declared_callables(n)',
      'print("RESULT has_sn=" + str(names.has("sn_action")))',
      'print("RESULT has_s=" + str(names.has("s_action")))',
    ]);
    expect(realError).toBe(false);
    // 动态脚本若不支持 & 字面量则 realError 会 true;支持则两项都在(aigengame 收 String/StringName)
    expect(values.has_sn).toBe('true');
    expect(values.has_s).toBe('true');
  });
});

describe('P1-4: 白名单分支接线契约', () => {
  it('GDA-c: _cmd_call_method 白名单检查含 _gda_ok 三分支 + BLOCKLIST 统一拦截', () => {
    const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');
    const fnStart = gd.indexOf('func _cmd_call_method');
    const fnEnd = gd.indexOf('\nfunc ', fnStart + 10);
    const slice = gd.slice(fnStart, fnEnd);
    expect(slice.includes('_gda_ok := method in _declared_callables(node)'), '缺 _gda_ok 声明').toBe(true);
    expect(slice.includes('if not method in ALLOWED_METHODS and not _extra_ok and not _gda_ok:'), '白名单三分支').toBe(true);
    // A3 (2026-11-12 反馈批次): BLOCKLIST 预检前置为无条件形态(旧 (_extra_ok or _gda_ok)
    // 前缀使普通调用 blocklist 方法先落 -2 "allow via" 误导文案,照做设 env 后再撞 -6,
    // 误导死路)。语义不变且更强:无条件拦截,env/声明均不可越过。
    const blIdx = slice.indexOf('if method in EXTRA_METHODS_BLOCKLIST:');
    expect(blIdx, 'BLOCKLIST 预检须为无条件形态').toBeGreaterThanOrEqual(0);
    expect(slice.indexOf('var _extra_env :='), 'env 解析须在预检之后(首条报错即终判)').toBeGreaterThan(blIdx);
    expect(slice.includes('GDA_CALLABLE'), '拒绝消息教开发者声明').toBe(true);
  });

  it('GDA-d: 双副本规则同步(描述含 GDA_CALLABLE)', () => {
    const ts = readFileSync('src/tools/game-bridge.ts', 'utf8');
    expect(ts.includes('GDA_CALLABLE'), '工具描述').toBe(true);
    const rt = readFileSync('src/tools/rule-templates.ts', 'utf8');
    expect((rt.match(/GDA_CALLABLE/g) ?? []).length >= 2, 'rule-templates 工具表+陷阱条目').toBe(true);
    const rules = readFileSync('.claude/rules/godot-mcp-bridge.md', 'utf8');
    expect((rules.match(/GDA_CALLABLE/g) ?? []).length >= 2, '.claude/rules 独立副本同步').toBe(true);
  });
});
