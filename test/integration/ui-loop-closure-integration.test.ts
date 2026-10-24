// A0 配套集成测试(UI 迁移构建侧整改方案 §三 A0):把「布局收敛闭环(v2)」规则声称的
// 流程用真实 Godot 钉死——ui_build_layout(persist=true) 写盘 → **独立进程**
// ui_measure_layout(expect_tree=同树含 rect) → TS 侧 diffLayout 判定全绿非空。
//
// 为什么必须独立进程:measure 的 _mcp_load_scene 从磁盘加载场景,persist=false 的
// 运行时树随进程退出即丢(docs/reviews/2026-08-16-prototype-import-spec.md B-1 条
// 记录的旧账;规则文本已于 2026-10-24 修正为每轮 persist=true)。本测试即该闭环的
// 可执行证据:两段 executeGdscriptTrusted 各起一个 Godot 进程,中间无共享状态。
//
// 前置呼应(A0 规则第二 bullet):目标场景文件须先存在——fixture 先写 loop.tscn,
// build 的 _mcp_load_scene 才能加载;对不存在的场景 persist 无从执行。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { executeGdscriptTrusted } from '../../src/gdscript-executor.js';
import { genUiBuildLayoutScript } from '../../src/tools/ui/ui-layout.js';
import { genUiMeasureScript } from '../../src/tools/ui/ui-measure.js';
import { diffLayout, flattenTargets } from '../../src/tools/ui/layout-diff.js';
import type { MeasuredNode } from '../../src/tools/ui/layout-diff.js';
import type { UiNodeSpec } from '../../src/tools/ui/types.js';

const GODOT = process.env.GODOT_PATH;
const run = !!GODOT && process.platform === 'win32';

describe.skipIf(!run)('布局收敛闭环(v2):build persist=true → 独立进程 measure → diff 全绿(GODOT_PATH)', () => {
  let dir: string;

  beforeAll(() => {
    // 测试数据落项目目录内(磁盘卫生规则:禁止 C 盘写测试文件),mkdtemp 保证唯一,收尾统一清理
    const outRoot = join(process.cwd(), 'test-output');
    mkdirSync(outRoot, { recursive: true });
    dir = mkdtempSync(join(outRoot, 'ui-loop-'));
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\n');
    // A0 前置:临时场景文件须先存在(空 Control 根,锚点无关,直接 offsets 定尺寸)
    writeFileSync(join(dir, 'loop.tscn'),
      '[gd_scene format=3]\n\n[node name="Main" type="Control"]\noffset_right = 1280.0\noffset_bottom = 720.0\n');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function runScript(code: string) {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT!, projectPath: dir, code, timeout: 30, loadAutoloads: false,
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    return res.outputs;
  }

  it('persist=true 落盘后,独立进程 measure(expect_tree 同树含 rect)diff 全绿且非空', async () => {
    // 与 ui-layout-integration buildThenMeasureRect 同构的嵌套 rect(该文件 :195 已
    // 验证数值在 2px 容差内),差异仅在流程:此处走 persist 落盘 → 独立进程重载。
    const tree: UiNodeSpec = {
      type: 'Panel', name: 'P', rect: { x: 100, y: 50, w: 600, h: 400 },
      children: [{ type: 'Button', name: 'Btn', rect: { x: 50, y: 30, w: 120, h: 48 } }],
    };

    // 进程 1:build + persist=true 写盘(pack → tmp → rename 覆盖写)
    const build = genUiBuildLayoutScript(join(dir, 'loop.tscn'), 'root', tree, { w: 1280, h: 720 }, true);
    const outs1 = await runScript(build);
    const persist = JSON.parse(String(outs1.find(o => o.key === 'persist')!.value)) as { saved: boolean };
    expect(persist.saved).toBe(true);

    // 进程 2:独立 measure(_mcp_load_scene 从磁盘加载 persist 产物)
    const outs2 = await runScript(genUiMeasureScript(join(dir, 'loop.tscn'), undefined, 16));
    const measure = JSON.parse(String(outs2.find(o => o.key === 'measure')!.value)) as {
      nodes: MeasuredNode[];
    };

    // TS 侧复现 handler 组装(src/tools/ui/index.ts ui_measure_layout expect_tree 注入):
    // flattenTargets 只收含 rect 节点 → diffLayout 全量条目逐项 ok 判定(容差 2px)
    const targets = flattenTargets(tree);
    expect(targets.length).toBe(2); // 非空:树根 Panel 与子 Button 均含 rect
    const diff = diffLayout(measure.nodes, targets, 2);
    expect(diff).toHaveLength(2);
    // 全绿:每条 ok=true(actual 非 null → 排除 persist 丢树导致的 NaN 缺失语义)
    for (const e of diff) {
      expect(e.ok, `${e.path} delta=${JSON.stringify(e.delta)}`).toBe(true);
    }
  });
});
