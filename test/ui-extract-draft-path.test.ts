// test/ui-extract-draft-path.test.ts
// 反馈 2026-11-18:extract_tree 的 draft_path 多级相对路径自动补 res://(此前非 res:// 形态
// 一律被拒「path traversal」,与 schema 描述「相对项目」不符)。拒绝面锚在
// test/ui-extract.test.ts handler 段;本文件锁归一值同时用于落盘脚本与 persist.path 回执。
// executor mock 与 createCtx 照 test/ui-import-prototype.test.ts。
import { describe, it, expect, vi } from 'vitest';
import { mockSuccessResult } from './helpers/mock-results.js';

// vi.mock 提升优先于 import,共享 mock 引用须经 vi.hoisted(参照 test/ui-import-prototype.test.ts)
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(),
  executeGdscriptTrusted: execMock,
}));

import { handleTool } from '../src/tools/ui/index.js';
import type { ToolResult } from '../src/types.js';

function textOf(result: ToolResult | null, index = 0): string {
  const el = result?.content?.[index];
  if (!el || el.type !== 'text') throw new Error(`content[${index}] is not text`);
  return el.text;
}

function createCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null, setRunningProcess: vi.fn(),
    outputBuffer: [], setOutputBuffer: vi.fn(),
    processStartTime: 0, setProcessStartTime: vi.fn(),
    projectDir: '/fake/project', setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
  } as never;
}

describe('extract_tree draft_path 归一(反馈 2026-11-18)', () => {
  const SCAN_NODES = [{
    path: 'PanelA', type: 'Panel',
    styles: [{ slot: 'panel', flat: true, bg_color: [0.25, 0.5, 0.75, 1],
      corner_radius: { tl: 0, tr: 0, br: 0, bl: 0 }, border_width: { left: 0, top: 0, right: 0, bottom: 0 },
      border_color: [0, 0, 0, 1], draw_center: true }],
  }];
  // 两次 executor 调用:第 1 次扫描(产出非空 draft),第 2 次草稿落盘——都要有成功返回值
  const mockScan = () => execMock.mockReset()
    .mockResolvedValueOnce(mockSuccessResult({
      outputs: [{ key: 'extract_scan', value: JSON.stringify({ nodes: SCAN_NODES }) }],
    }))
    .mockResolvedValueOnce(mockSuccessResult({ outputs: [] }));

  it('多级相对路径自动补 res://: 草稿落盘脚本与 persist.path 都用归一值(反馈 2026-11-18)', async () => {
    mockScan();
    const r = await handleTool('ui', { action: 'extract_tree', project_path: '/fake/p', scene_path: 'res://main.tscn', draft_path: 'tmp/b1_assets/_draft.tres' }, createCtx());
    const body = JSON.parse(textOf(r));
    expect(body.data.persist.path).toBe('res://tmp/b1_assets/_draft.tres');
    expect(execMock.mock.calls.length).toBe(2);
    expect(execMock.mock.calls[1]![0].code).toContain('res://tmp/b1_assets/_draft.tres');
  });

  it('已带 res:// 前缀: 原样通过', async () => {
    mockScan();
    const r = await handleTool('ui', { action: 'extract_tree', project_path: '/fake/p', scene_path: 'res://main.tscn', draft_path: 'res://ui/draft.tres' }, createCtx());
    expect(JSON.parse(textOf(r)).data.persist.path).toBe('res://ui/draft.tres');
  });
});
