// test/layout-compare.test.ts — 能力 B：analysis.layout_compare 布局树读数比对
//
// 用例来源：方案验收五件套（DRIFT/MISSING/EXTRA/null 跳过/rebase）+ tol 边界
// （恰好等于 tol 不判 DRIFT——与 TMXYH5 visual_gate.py `abs(r-c) > tol` 语义一致）
// + 白名单拒绝 + 包装格式（_anchored 锚点跳过）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { handleTool } from '../src/tools/analysis/index.js';

let dir: string;
const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;

function ctxStub(): Parameters<typeof handleTool>[2] {
  return {} as Parameters<typeof handleTool>[2];
}

async function compare(args: Record<string, unknown>): Promise<{ text: string }> {
  const res = await handleTool('analysis', { action: 'layout_compare', ...args }, ctxStub());
  return { text: res?.content[0]?.type === 'text' ? res.content[0].text : '' };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'layout-compare-'));
  process.env.ALLOWED_PROJECT_PATHS = dir; // 白名单限定临时目录
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
  else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
});

function writeJson(name: string, data: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data), 'utf-8');
  return p;
}

describe('analysis.layout_compare', () => {
  it('DRIFT/MISSING/EXTRA 三类差异全检出，tol 边界（恰好=tol 不判）', async () => {
    const ref = writeJson('ref.json', {
      a: [10, 20, 100, 50],  // x+3 判 DRIFT；y+2 恰好=tol 不判
      b: [30, 40, 80, 30],
      c: [50, 60, 70, 20],   // cand 缺 → MISSING
    });
    const cand = writeJson('cand.json', {
      a: [13, 22, 100, 50],
      b: [30, 44, 81, 31],   // y+4 DRIFT；w+1/h+1 容差内
      e: [1, 2, 3, 4],       // cand 多 → EXTRA
    });
    const { text } = await compare({ ref_path: ref, cand_path: cand, tol: 2 });
    expect(text).toContain('DRIFT   a：x 10→13');
    expect(text).not.toContain('a：x 10→13; y 20→22'); // y 恰好=tol 不进 DRIFT 行
    expect(text).toContain('DRIFT   b：y 40→44');
    expect(text).not.toContain('w 80→81');             // w+1 容差内
    expect(text).toContain('MISSING cand 缺控件 c（ref x=50 y=60）');
    expect(text).toContain('EXTRA   cand 多控件 e');
    expect(text).toContain('TREE FAIL');
    expect(text).toContain('比对 2 项');
  });

  it('全一致时 TREE PASS', async () => {
    const same = { a: [10, 20, 100, 50], b: [0, 0, 30, 30] };
    const ref = writeJson('r2.json', same);
    const cand = writeJson('c2.json', same);
    const { text } = await compare({ ref_path: ref, cand_path: cand });
    expect(text).toContain('TREE PASS（比对 2 项 / 跳过 0');
    expect(text).not.toContain('DRIFT');
  });

  it('null 坐标项跳过并计数（不产假 DIFF）', async () => {
    const ref = writeJson('r3.json', { a: [10, 20, 100, 50], d: [1, 2, 3, 4] });
    const cand = writeJson('c3.json', { a: [10, 20, 100, 50], d: [null, null, 3, 4] });
    const { text } = await compare({ ref_path: ref, cand_path: cand });
    expect(text).toContain('TREE PASS');
    expect(text).toContain('跳过 1 锚点·null 项');
  });

  it('包装格式 _anchored 锚点项跳过（两侧标注并集）', async () => {
    const ref = writeJson('r4.json', {
      controls: { a: [10, 20, 100, 50], anchor1: [5, 5, 5, 5], anchor2: [6, 6, 6, 6] },
      _anchored: ['anchor1'],
    });
    const cand = writeJson('c4.json', {
      controls: { a: [10, 20, 100, 50], anchor1: [500, 500, 5, 5], anchor2: [600, 600, 6, 6] },
      _anchored: ['anchor2'],
    });
    const { text } = await compare({ ref_path: ref, cand_path: cand });
    // anchor1（ref 标注）与 anchor2（cand 标注）都跳过，巨大坐标差不算 DRIFT
    expect(text).toContain('TREE PASS');
    expect(text).toContain('跳过 2 锚点·null 项');
  });

  it('rebase 相对化：整体平移的 cand 比对归零', async () => {
    // ref 已是皮肤根相对坐标（设计稿提取侧）；cand 是全局坐标、整体平移 (50,80)
    const ref = writeJson('r5.json', { root: [0, 0, 200, 300], btn: [10, 30, 50, 20], lbl: [20, 160, 60, 16] });
    const cand = writeJson('c5.json', { root: [150, 180, 200, 300], btn: [160, 210, 50, 20], lbl: [170, 340, 60, 16] });
    const { text } = await compare({ ref_path: ref, cand_path: cand, rebase: 'root' });
    expect(text).toContain('TREE PASS');
    expect(text).toContain('rebase=root');
  });

  it('rebase 锚控件缺失或 null 时报参数错误', async () => {
    const ref = writeJson('r6.json', { a: [1, 2, 3, 4] });
    const cand = writeJson('c6.json', { a: [1, 2, 3, 4] });
    const res = await handleTool('analysis', {
      action: 'layout_compare', ref_path: ref, cand_path: cand, rebase: 'nonexistent',
    }, ctxStub());
    const text = res?.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('nonexistent');
    expect(text).toContain('INVALID_PARAMS');
  });

  it('白名单外路径拒绝（deny-by-default 护城河一致性）', async () => {
    // test/setup.js 全局 GODOT_MCP_UNRESTRICTED=true 绕过白名单——本用例验证的是
    // 白名单分支本身,临时关掉 unrestricted 再还原
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', '');
    try {
      const ref = writeJson('r7.json', { a: [1, 2, 3, 4] });
      const res = await handleTool('analysis', {
        action: 'layout_compare',
        ref_path: resolve(dir, 'r7.json'),
        cand_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts.json', // 白名单外
      }, ctxStub());
      const text = res?.content[0]?.type === 'text' ? res.content[0].text : '';
      expect(text).toContain('INVALID_PARAMS');
      expect(text).toContain('白名单');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('坏格式（坐标非数值/非数组）报参数错误', async () => {
    const ref = writeJson('r8.json', { a: [1, 2, 3, 4] });
    const bad = writeJson('c8.json', { a: 'not-a-rect' });
    const res = await handleTool('analysis', {
      action: 'layout_compare', ref_path: ref, cand_path: bad,
    }, ctxStub());
    const text = res?.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('[x, y, w, h]');
  });

  it('缺 ref_path/cand_path 报参数错误', async () => {
    const res = await handleTool('analysis', { action: 'layout_compare' }, ctxStub());
    const text = res?.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('ref_path');
  });
});
