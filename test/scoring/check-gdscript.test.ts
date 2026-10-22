import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseGdscriptOutput, extractClassNames, listGd, listPluginAssets } from '../../src/scoring/check-gdscript.js';

describe('parseGdscriptOutput', () => {
  it('SCRIPT ERROR 行计入 errors', () => {
    const r = parseGdscriptOutput('SCRIPT ERROR: res://a.gd:1: "x" was not found');
    expect(r.errors).toBe(1);
    expect(r.warnings).toBe(0);
    expect(r.details[0]).toContain('SCRIPT ERROR');
  });

  it('Parse Error 行计入 errors', () => {
    const r = parseGdscriptOutput('res://a.gd:42 - Parse Error: Unexpected token');
    expect(r.errors).toBe(1);
  });

  it('WARNING 行计入 warnings(不计 errors)', () => {
    const r = parseGdscriptOutput('WARNING: "x" is never used');
    expect(r.warnings).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('errors 优先排前 details,≤20 条截断', () => {
    const lines = [
      'WARNING: w1', 'WARNING: w2',
      ...Array.from({ length: 25 }, (_, i) => `SCRIPT ERROR: e${i}`),
    ].join('\n');
    const r = parseGdscriptOutput(lines);
    expect(r.errors).toBe(25);
    expect(r.warnings).toBe(2);
    expect(r.details.length).toBe(20);
    expect(r.details[0]).toContain('SCRIPT ERROR'); // errors 优先
  });

  it('未知行不计数不崩(保留诊断)', () => {
    const r = parseGdscriptOutput('some random godot banner\n  at scope\n');
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(0);
  });

  it('detailsTotal = errors + warnings', () => {
    const r = parseGdscriptOutput('SCRIPT ERROR: e1\nWARNING: w1\nWARNING: w2');
    expect(r.detailsTotal).toBe(3);
  });
});

describe('extractClassNames', () => {
  it('从 class_name 声明提取类名', () => {
    const names = extractClassNames([
      'D:\\addons\\godot_mcp_server\\commands\\command_helpers.gd',
    ], { 'D:\\addons\\godot_mcp_server\\commands\\command_helpers.gd': '@tool\nclass_name CommandHelpers\nextends RefCounted\n' });
    expect(names).toEqual(['CommandHelpers']);
  });

  it('无 class_name 的脚本不返回', () => {
    const names = extractClassNames(['a.gd'], { 'a.gd': 'extends Node\nvar x = 1\n' });
    expect(names).toEqual([]);
  });
});

describe('listGd', () => {
  it('递归收集 .gd 文件(排除非 .gd)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listgd-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.gd'), 'x');
      fs.mkdirSync(path.join(tmp, 'sub'));
      fs.writeFileSync(path.join(tmp, 'sub', 'b.gd'), 'x');
      fs.writeFileSync(path.join(tmp, 'c.txt'), 'x');
      const files = listGd(tmp);
      expect(files.length).toBe(2);
      expect(files.some(f => f.endsWith('a.gd'))).toBe(true);
      expect(files.some(f => f.endsWith('b.gd'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('跳过 symlink 目录(B6:防逃逸出 root)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listgd-sym-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'listgd-out-'));
    try {
      fs.writeFileSync(path.join(tmp, 'real.gd'), 'x');
      fs.writeFileSync(path.join(outside, 'evil.gd'), 'x');
      let linked = false;
      try { fs.symlinkSync(outside, path.join(tmp, 'link')); linked = true; } catch { /* Windows 非 dev mode 无 symlink 权限 */ }
      if (!linked) return; // 平台不支持 symlink 创建 → 跳过(CI Linux 会真跑)
      const files = listGd(tmp);
      expect(files.some(f => f.includes('evil.gd'))).toBe(false); // 不跟随 symlink
      expect(files.some(f => f.endsWith('real.gd'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ─── listPluginAssets(2026-10-22 审查 Major-F1:插件加载面资产随链填充)───────

describe('listPluginAssets', () => {
  it('递归收集 .cfg/.tscn(排除 .gd 与其他扩展名)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listassets-'));
    try {
      fs.writeFileSync(path.join(tmp, 'plugin.cfg'), 'x');
      fs.mkdirSync(path.join(tmp, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'ui', 'panel.tscn'), 'x');
      fs.writeFileSync(path.join(tmp, 'a.gd'), 'x');
      fs.writeFileSync(path.join(tmp, 'a.gd.uid'), 'x');
      fs.writeFileSync(path.join(tmp, 'icon.png'), 'x');
      const files = listPluginAssets(tmp);
      expect(files.length).toBe(2);
      expect(files.some(f => f.endsWith('plugin.cfg'))).toBe(true);
      expect(files.some(f => f.endsWith('panel.tscn'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
