// test/import-integrity.test.ts — 能力 D：.import 砍残自检
//
// 场景来源（TMXYH5 2026-09-21 反馈）：`--headless --import` 后部分 .png.import
// 被重写为只剩 [remap] 段（importer=/uid/[params] 全删）。
// 正向重点：正常 .import 不误报、砍残文件必检出、排除目录不扫、git M 增强生效。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

import { checkImportIntegrity, formatImportIntegrity } from '../src/tools/import-integrity.js';

let projDir: string;

const GOOD_IMPORT = [
  '[remap]', '',
  'importer="texture"', 'type="CompressedTexture2D"',
  'uid="uid://abc123"', 'path="res://.godot/imported/x.ctex"', '',
  '[deps]', '',
  'source_file="res://assets/x.png"', '',
  '[params]', '',
  'compress/mode=0', '',
].join('\n');

// 砍残形态：只剩 [remap] 重定向段，无 importer= 行
const GUTTED_IMPORT = [
  '[remap]', '',
  'path="res://.godot/imported/x.ctex"', '',
].join('\n');

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.email=t@t.local', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  projDir = mkdtempSync(join(tmpdir(), 'import-integrity-'));
  mkdirSync(join(projDir, 'assets', 'atlas_font'), { recursive: true });
  mkdirSync(join(projDir, '.godot', 'imported'), { recursive: true });
  writeFileSync(join(projDir, 'assets', 'good.png.import'), GOOD_IMPORT, 'utf-8');
  writeFileSync(join(projDir, 'assets', 'atlas_font', 'f1.png.import'), GUTTED_IMPORT, 'utf-8');
  writeFileSync(join(projDir, 'assets', 'atlas_font', 'f2.png.import'), GUTTED_IMPORT, 'utf-8');
  // 排除目录内（.godot）的砍残文件不应被扫到
  writeFileSync(join(projDir, '.godot', 'stale.png.import'), GUTTED_IMPORT, 'utf-8');
});

afterAll(() => {
  rmSync(projDir, { recursive: true, force: true });
});

describe('checkImportIntegrity', () => {
  it('检出砍残 .import 且不误报正常文件', () => {
    const report = checkImportIntegrity(projDir);
    expect(report.scanned).toBe(3); // .godot 内的不计
    expect(report.gutted).toEqual(['assets/atlas_font/f1.png.import', 'assets/atlas_font/f2.png.import']);
    // 非 git 项目：git 增强层为 null（而非空数组——区分"无 git"与"git 干净"）
    expect(report.gitModified).toBeNull();
  });

  it('subdirs 限定扫描范围', () => {
    const report = checkImportIntegrity(projDir, ['assets/atlas_font']);
    expect(report.scanned).toBe(2);
    expect(report.gutted.length).toBe(2);
  });

  it('git 项目：M 状态 .import 列入 gitModified', () => {
    git(['init'], projDir);
    git(['add', '.'], projDir);
    git(['commit', '-m', 'init'], projDir);
    // 提交后再改一个 .import → 工作区 M
    writeFileSync(join(projDir, 'assets', 'good.png.import'), GOOD_IMPORT.replace('compress/mode=0', 'compress/mode=1'), 'utf-8');

    const report = checkImportIntegrity(projDir);
    expect(report.gitModified).toContain('assets/good.png.import');
    expect(report.gutted.length).toBe(2); // 砍残检测独立于 git 层
  });

  it('无 .import 的空项目：零扫描零砍残、git 层为 null', () => {
    // 无 .import 目录的项目 → 零扫描零砍残
    const empty = mkdtempSync(join(tmpdir(), 'import-integrity-empty-'));
    try {
      const report = checkImportIntegrity(empty);
      expect(report.scanned).toBe(0);
      expect(report.gutted).toEqual([]);
      expect(report.gitModified).toBeNull(); // 临时目录无 .git → git 层静默降级 null（标题第三项的对应断言）
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('formatImportIntegrity', () => {
  it('干净报告返回空串（调用方无附加）', () => {
    expect(formatImportIntegrity({ scanned: 5, gutted: [], gitModified: null })).toBe('');
    expect(formatImportIntegrity({ scanned: 5, gutted: [], gitModified: [] })).toBe('');
  });

  it('砍残 + git 修改均产出人读警告段', () => {
    const text = formatImportIntegrity({ scanned: 9, gutted: ['a.png.import'], gitModified: ['b.png.import'] });
    expect(text).toContain('a.png.import');
    expect(text).toContain('砍残');
    expect(text).toContain('b.png.import');
    expect(text).toContain('git');
  });
});
