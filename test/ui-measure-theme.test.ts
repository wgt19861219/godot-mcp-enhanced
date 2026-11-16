import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { genUiMeasureScript } from '../src/tools/ui/ui-measure.js';
import { genUiImportSingleScript } from '../src/tools/ui/ui-import-single.js';
import { executeGdscriptTrusted } from '../src/gdscript-executor.js';

// 批1 1a(spec §「开放问题 3」spike):measure 链 theme_path 挂载。
// 单测锚定生成器契约(无 themePath 逐字节不变/有 themePath 注入挂载行);
// e2e 双门控(GODOT_PATH + 靶子项目存在)锚定真机行为:挂主题前后两轮 measure
// 均成功且 viewport 相同(主题偏差量级记录进 spec 开放问题 3)、错路径显式报错。

const GODOT_PATH = process.env.GODOT_PATH || '';
const TARGET_PROJECT = 'D:/workspace/projects/DotaLegendGodot';
const hasE2e = GODOT_PATH !== '' && existsSync(GODOT_PATH) && existsSync(TARGET_PROJECT);
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

describe('genUiMeasureScript theme 挂载', () => {
  it('无 themePath 时生成脚本与旧行为一致(不含 set_theme 行)', () => {
    const script = genUiMeasureScript('res://a.tscn', undefined, 16);
    expect(script).not.toContain('set_theme');
  });
  it('有 themePath 时注入挂载行且在场景加载之后', () => {
    const script = genUiMeasureScript('res://a.tscn', undefined, 16, undefined, { themePath: 'res://resources/themes/default_theme.tres' });
    // brief Step 3 实现带 null/非 Theme 显式报错(Review Focus 1),set_theme 作用于
    // 预载变量 _theme_res 而非内联 load()——断言锚定 load 行与挂载行分别存在。
    expect(script).toContain('load("res://resources/themes/default_theme.tres")');
    expect(script).toContain('root.set_theme(_theme_res)');
    expect(script.indexOf('set_theme')).toBeGreaterThan(script.indexOf('_mcp_load_scene'));
  });
});

// import 链注入通道锚定(Task1 审查 Important#1):genUiImportSingleScript 与 measure 链
// materially 不同——不同函数体、不同截取拼接机制(_initialize 整体剥离,挂载必须由
// _measure_go 重注),本组锚定注入存在性与位置(reload add_child 之后、connect 之前)。
// 注:该函数 themePath 为第 6 位裸形参(非 genUiMeasureScript 的 opts 对象),以代码现状为准。
describe('genUiImportSingleScript theme 挂载(import 链注入通道)', () => {
  const tree = {
    type: 'VBoxContainer', name: 'Root',
    children: [{ type: 'Label', name: 'L', properties: { text: '你好' } }],
  };
  function gen(themePath?: string): string {
    return genUiImportSingleScript('D:/proj/main.tscn', 'root', tree, { w: 1280, h: 720 }, undefined, themePath);
  }
  it('无 themePath 时产物不含 set_theme 行', () => {
    expect(gen()).not.toContain('set_theme');
  });
  it('有 themePath 时挂载行在 _measure_go:场景 add_child 之后、process_frame.connect 之前', () => {
    const s = gen('res://themes/x.tres');
    // Task 2(批1 1a)后 import 链 viewport(必填形参)驱动 SubViewport 挂载,主题传播不跨
    // Viewport 边界(spike 探针4 实测)——挂载行从 root.set_theme 改为场景根挂载
    expect(s).toContain('(_mcp_scene_instance as Control).set_theme(_theme_res)');
    const mount = s.indexOf('(_mcp_scene_instance as Control).set_theme(_theme_res)');
    // _vp_sub.add_child(_mcp_scene_instance) 在合成产物中仅 _measure_go 出现一次
    // (header 的 _mcp_load_scene 用 _r.add_child,build 段不重复该行)
    expect(mount).toBeGreaterThan(s.lastIndexOf('_vp_sub.add_child(_mcp_scene_instance)'));
    expect(mount).toBeLessThan(s.indexOf('process_frame.connect'));
  });
});

describe.skipIf(!hasE2e)('measure theme 挂载靶子 e2e(DotaLegendGodot)', () => {
  async function runMeasure(themePath?: string) {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH,
      projectPath: TARGET_PROJECT,
      code: genUiMeasureScript(
        join(TARGET_PROJECT, 'scenes/ui/daily_login_content.tscn'),
        undefined, 16, undefined,
        themePath ? { themePath } : undefined,
      ),
      timeout: 60,
      loadAutoloads: false,
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    return res.outputs;
  }

  /** 从 measure 输出取 {viewport, LoginMonthLabel rect.h}。 */
  function pickMeasure(outputs: Array<{ key: string; value: string }>) {
    const raw = outputs.find(o => o.key === 'measure');
    expect(raw, 'measure 输出存在').toBeDefined();
    const m = JSON.parse(String(raw!.value)) as {
      viewport: { w: number; h: number };
      nodes: Array<{ path: string; rect: { h: number } }>;
    };
    const label = m.nodes.find(n => n.path.endsWith('LoginMonthLabel'));
    expect(label, 'LoginMonthLabel 在测量结果中').toBeDefined();
    return { viewport: m.viewport, labelH: label!.rect.h };
  }

  it('无主题 vs 挂主题:两轮 measure 均成功且 viewport 相同,记录 LoginMonthLabel rect.h 量级', async () => {
    const plain = pickMeasure(await runMeasure());
    const themed = pickMeasure(await runMeasure('res://resources/themes/default_theme.tres'));
    expect(plain.viewport).toEqual(themed.viewport);
    // 量化 spec 开放问题 3(主题敏感高度偏差量级):数值相等或不同均记录,断言只要求
    // 两轮成功 + viewport 相同——量级结论进 spec 文件「开放问题 3」节。
    console.log(`[theme-spike] LoginMonthLabel rect.h 无主题=${plain.labelH} 挂主题=${themed.labelH} Δ=${themed.labelH - plain.labelH}`);
  }, 120_000);

  it('传错 theme 路径:返回 error 而非成功', async () => {
    const outputs = await runMeasure('res://resources/themes/no_such_theme.tres');
    const err = outputs.find(o => o.key === 'error');
    expect(err, '错误输出存在').toBeDefined();
    expect(String(err!.value)).toContain('theme_path load failed');
    expect(outputs.find(o => o.key === 'measure'), '错路径不产出 measure').toBeUndefined();
  }, 120_000);
});

// 挂载生效性锚定(无 autoload fixture):靶子项目 autoload ThemeManager 在 --script
// 模式下仍会被引擎加载(实测 MCP Bridge 监听 + root.theme 已挂),其「无 theme_path 也
// 是主题语境」不能证明挂载本身生效——本组用无 autoload 的最小 fixture 隔离验证:
// theme_type_variation 节点在挂主题后 rect.h 被主题字号行高顶开。
describe.skipIf(!hasGodot)('measure theme 挂载生效性(无 autoload fixture)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-theme-mount-'));
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\n');
    // Label 显式高 24px(offsets),variation 字号 30 → 挂主题后行高顶开超过 24
    writeFileSync(join(dir, 'main.tscn'), `[gd_scene format=3]

[node name="Main" type="Control"]
offset_right = 200.0
offset_bottom = 100.0

[node name="MyLabel" type="Label" parent="."]
offset_top = 10.0
offset_bottom = 34.0
theme_type_variation = &"MyVar"
text = "测试文本"
`);
    mkdirSync(join(dir, 'themes'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'big.tres'), `[gd_resource type="Theme" format=3]

[resource]
MyVar/base_type = &"Label"
MyVar/font_sizes/font_size = 30
`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  async function measure(themePath?: string) {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH, projectPath: dir, timeout: 60, loadAutoloads: false,
      code: genUiMeasureScript(join(dir, 'main.tscn'), undefined, 16, undefined, themePath ? { themePath } : undefined),
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    const raw = res.outputs.find(o => o.key === 'measure')!;
    expect(raw, 'measure 输出存在').toBeDefined();
    const m = JSON.parse(String(raw.value)) as { nodes: Array<{ path: string; rect: { h: number } }> };
    const label = m.nodes.find(n => n.path === 'MyLabel')!;
    expect(label, 'MyLabel 在测量结果中').toBeDefined();
    return label.rect.h;
  }

  it('无主题回落默认字号,挂主题后行高顶开 rect.h 增大', async () => {
    const plain = await measure();
    const themed = await measure('res://themes/big.tres');
    console.log(`[theme-mount] MyLabel rect.h 无主题=${plain} 挂主题=${themed}`);
    // 默认 16 号行高 < 24(不顶开);30 号行高 > 24(顶开)——挂载生效的直接断言
    expect(themed).toBeGreaterThan(plain);
    expect(themed).toBeGreaterThanOrEqual(34);
  }, 120_000);

  it('错路径在无 autoload fixture 同样显式报错', async () => {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH, projectPath: dir, timeout: 60, loadAutoloads: false,
      code: genUiMeasureScript(join(dir, 'main.tscn'), undefined, 16, undefined, { themePath: 'res://themes/missing.tres' }),
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    expect(String(res.outputs.find(o => o.key === 'error')?.value)).toContain('theme_path load failed');
  }, 120_000);
});
