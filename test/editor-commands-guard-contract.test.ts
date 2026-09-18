// editor-commands-guard-contract.test.ts — 2026-09-17 架构审查批4 范围增补(I-1):
// 批1 终审发现 addons editor 命令族 40 处 `int/float(params.get(...))` 同款裸转(2026-09-17
// 审查 H-2 只锁了 src/scripts/mcp_bridge.gd 的覆盖盲区)。风险低于 bridge(editor 常驻进程
// 不挂死 + TS zod 前置),但毒参数(null/容器/非法串)仍触发 SCRIPT ERROR 中断命令处理。
//
// 守卫先例:批1 在 command_helpers.gd 建 editor 侧守卫副本(_comp_white);本批补数值守卫
// num_guarded/int_guarded(Keep in sync 三副本:mcp_bridge.gd _num/_int_guarded +
// godot_operations.gd 同名 + 本文件)。
//
// ⚠️ 局限(对齐 gd-symmetry-contract 范式):源码字符串断言验证"守卫模式全量落位"而非运行时
// 行为;运行时行为由 npm run check:gdscript(项目级完整编译)+ gdscript-unit 行为级用例覆盖。
// 引擎内部数据(get_property_list() 的 p.get/p["type"],非用户参数面)不在此约束内。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS_DIR = join(ROOT, 'addons', 'godot_mcp_server', 'commands');

/** 递归收集 commands/ 下全部 .gd(含 asset/ 子目录)。 */
function collectGdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectGdFiles(p));
    else if (name.endsWith('.gd')) out.push(p);
  }
  return out;
}

const files = collectGdFiles(COMMANDS_DIR);
const helpers = readFileSync(join(COMMANDS_DIR, 'command_helpers.gd'), 'utf8');

describe('I-1(批4 范围增补): editor 命令族数值参数守卫全量落位', () => {
  it('I-1a: 守卫函数存在于 command_helpers.gd(三副本同步锚,Keep in sync 注释在位)', () => {
    expect(helpers).toContain('static func num_guarded(');
    expect(helpers).toContain('static func int_guarded(');
    expect(helpers).toContain('is_valid_float()');
    expect(helpers).toContain('is_valid_int()');
    expect(helpers).toMatch(/Keep in sync/);
  });

  it('I-1b: command_helpers.gd 自身守卫形态不裸转(parse_vec3 分量经白名单)', () => {
    // H-1 同款:parse_vec3 的 Array 分量此前三处裸 float(a[i]),毒分量进 float() 即 SCRIPT ERROR
    expect(helpers).not.toMatch(/\bfloat\(a\[/);
  });

  // I-1c [负向]: 全命令族禁绝 int/float(params.xxx) 裸转——守卫必须经
  // CommandHelpers.num_guarded/int_guarded(引擎内部 p.get/p["type"] 数据不在 params 面,天然不匹配)
  it.each(files.map(f => [f.replace(ROOT + '\\', '').replace(/\\/g, '/'), f] as const))(
    'I-1c: %s 无 int/float(params.…) 裸转',
    (_rel, abs) => {
      const src = readFileSync(abs, 'utf8');
      expect(src, `${_rel} 存在裸转,须替换为 CommandHelpers 守卫`).not.toMatch(/\b(?:int|float)\(params\./);
    },
  );
});
