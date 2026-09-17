// 反馈批次 B(2026-09-16)契约测试:scene 序列化修复的跨文件对齐约束
// B1: TextureButton/ColorRect 白名单三方同步(godot_operations.gd / ui_commands.gd / TS types.ts)
//     + 规则模板双副本 31 种同步
// B5: godot_operations.gd 六个 scene 写 handler 的落盘后回读自检接线
// 快照护栏:计数类断言(31/六 handler)与实现联动,漂移即红
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROL_TYPES } from '../src/tools/ui/types.js';
import { inferSceneRootName } from '../src/tools/scene/helpers.js';

const root = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf-8');

function gdArrayItems(src: string, constName: string): string[] {
  const m = src.match(new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`const ${constName} not found`);
  return Array.from(m[1]!.matchAll(/"([A-Za-z0-9_]+)"/g)).map(x => x[1]!);
}

describe('B1 反馈批次 B: TextureButton/ColorRect 白名单三方对齐', () => {
  it('godot_operations.gd ALLOWED_HEADLESS_TYPES 含新增两类', () => {
    const items = gdArrayItems(read('src/scripts/godot_operations.gd'), 'ALLOWED_HEADLESS_TYPES');
    expect(items).toContain('TextureButton');
    expect(items).toContain('ColorRect');
  });

  it('ui_commands.gd ALLOWED_CONTROL_TYPES 与 TS CONTROL_TYPES 逐项一致(31 种)', () => {
    const gdItems = gdArrayItems(read('addons/godot_mcp_server/commands/ui_commands.gd'), 'ALLOWED_CONTROL_TYPES');
    const tsItems = [...CONTROL_TYPES];
    expect(gdItems.length).toBe(tsItems.length);
    for (const t of tsItems) {
      expect(gdItems).toContain(t);
    }
    expect(tsItems).toContain('TextureButton');
    expect(tsItems).toContain('ColorRect');
  });

  it('规则模板双副本同步 31 种清单(rule-templates.ts / .claude/rules/godot-mcp-ui.md)', () => {
    for (const rel of ['src/tools/rule-templates.ts', '.claude/rules/godot-mcp-ui.md']) {
      const content = read(rel);
      expect(content).toContain('TextureButton, ColorRect');
      expect(content).toContain('31 种');
    }
  });

  it('ui_commands.gd docs 描述与白名单数量一致(防文案漂移)', () => {
    const content = read('addons/godot_mcp_server/commands/ui_commands.gd');
    expect(content).not.toContain('29 种');
    expect(content).toContain('31 种');
  });
});

describe('B5 反馈批次 B: GD 落盘后回读自检接线', () => {
  const ops = () => read('src/scripts/godot_operations.gd');

  it('_verify_saved_scene helper 存在且用 CACHE_MODE_IGNORE 绕缓存直读盘上文件', () => {
    const src = ops();
    expect(src).toContain('func _verify_saved_scene');
    expect(src).toContain('CACHE_MODE_IGNORE');
  });

  it('六个 scene 写 handler 全部接入自检(add_node/edit_node/remove_node/batch_add_nodes/load_sprite/save_scene)', () => {
    const src = ops();
    const count = (src.match(/_verify_saved_scene\(/g) ?? []).length;
    // 1 处定义 + 6 处调用 = 7(定义行是 func 声明,调用带路径参数)
    expect(count).toBeGreaterThanOrEqual(7);
    // 逐 handler 确认:成功 print 前有自检(取各 handler 特征成功消息定位)
    for (const marker of [
      'added successfully',
      'edited successfully',
      'removed successfully from',
      'Batch add completed',
      'Sprite loaded successfully',
      'Scene saved successfully',
    ]) {
      const idx = src.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      // 成功消息前 300 字符内应有自检调用
      const before = src.slice(Math.max(0, idx - 300), idx);
      expect(before).toContain('_verify_saved_scene');
    }
  });
});

describe('B2 反馈批次 B: inferSceneRootName(文本路径 parent 根名剥离的依据)', () => {
  it('root [node] 带 name 属性时取之', () => {
    expect(inferSceneRootName('[gd_scene format=3]\n\n[node name="GetNewHeroContent" type="Control"]\n', 'scenes/other.tscn')).toBe('GetNewHeroContent');
  });

  it('root 无 name 属性时回退场景文件名(Godot 同款行为)', () => {
    expect(inferSceneRootName('[gd_scene format=3]\n\n[node type="Control"]\n', 'scenes/get_new_hero_content.tscn')).toBe('get_new_hero_content');
  });

  it('unparseable content 回退文件名不抛错', () => {
    expect(inferSceneRootName('garbage', 'scenes/foo.tscn')).toBe('foo');
  });
});

describe('审查 N1(2026-09-17): real-project fixture 插件副本白名单锚定(防 fixture 与主 addons 漂移)', () => {
  it('fixture ui_commands.gd 白名单与主 addons 逐项一致', () => {
    const main = gdArrayItems(read('addons/godot_mcp_server/commands/ui_commands.gd'), 'ALLOWED_CONTROL_TYPES');
    const fixture = gdArrayItems(read('test/fixtures/real-project/addons/godot_mcp_server/commands/ui_commands.gd'), 'ALLOWED_CONTROL_TYPES');
    expect(fixture.length).toBe(main.length);
    for (const t of main) {
      expect(fixture).toContain(t);
    }
  });
});
