import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';
import { readdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSuccessResult } from './helpers/mock-results.js';

// Mock the executor
// SEC-P1-1: 用 importOriginal 保留 scanGdscriptSandbox 真实实现
vi.mock('../src/gdscript-executor.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeGdscript: vi.fn(() => Promise.resolve(mockSuccessResult())),
    parseMcpMarkers: vi.fn((raw) => ({
      parsed: null,
      logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
    })),
  };
});

// Mock batchValidateScripts so validate_scripts doesn't spawn Godot
vi.mock('../src/tools/validation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    batchValidateScripts: vi.fn(() => Promise.resolve([
      { file: 'scripts/main.gd', errors: [], warnings: [] },
    ])),
  };
});

import * as script from '../src/tools/script.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';

// ─── project_replace atomic write ──────────────────────────────────────────

describe('project_replace atomic write', () => {
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    dirRef.path = createTempProject({
      'project.godot': '; Engine config\n[application]\nconfig/name="Test"\n',
      'scripts/a.gd': 'extends Node\n\nfunc foo():\n\told_name()\n',
      'scripts/b.gd': 'extends Node\n\nvar x = old_name\n',
      'scripts/c.gd': 'extends Node\n\n# no match here\n',
    });
    ctx = createToolContext(dirRef.path);
  });

  it('replaces text in multiple files atomically (no leftover .tmp files)', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'old_name',
      replace: 'new_name',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.isError).toBeFalsy();

    // 验证文件内容已正确替换
    const aContent = readFileSync(join(dirRef.path, 'scripts', 'a.gd'), 'utf-8');
    expect(aContent).toContain('new_name()');
    expect(aContent).not.toContain('old_name');

    const bContent = readFileSync(join(dirRef.path, 'scripts', 'b.gd'), 'utf-8');
    expect(bContent).toContain('new_name');
    expect(bContent).not.toContain('old_name');

    // c.gd 不匹配，应保持原样
    const cContent = readFileSync(join(dirRef.path, 'scripts', 'c.gd'), 'utf-8');
    expect(cContent).toContain('no match here');

    // 不应残留任何 .tmp 文件
    const tmpFiles = readdirSync(join(dirRef.path, 'scripts')).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('全仓审查 B-1: replace 注入危险 API 到 .gd 被沙箱拒绝(整批原子,文件不动)', async () => {
    // 攻击路径与 SEC-P1-1 同构:project_replace 曾绕过 scanScriptSandboxOrThrow
    // (script/shared.ts 声明"全仓所有写 .gd 落盘前必须过此扫描")——replace 注入
    // OS.execute 后 run_project/编辑器打开即执行。修复:批量落盘前对 .gd 内容过扫描。
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'old_name()',
      replace: 'OS.execute("malicious.exe", [])',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
    const text = result.content?.map(c => c.text ?? '').join('') ?? '';
    expect(text).toContain('sandbox');

    // 整批原子:任何文件都不该被改动
    const aContent = readFileSync(join(dirRef.path, 'scripts', 'a.gd'), 'utf-8');
    expect(aContent).toContain('old_name()');
    expect(aContent).not.toContain('OS.execute');
    const tmpFiles = readdirSync(join(dirRef.path, 'scripts')).filter(f => f.endsWith('.tmp') || f.endsWith('.bak'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('dry_run does not modify files and shows preview', async () => {
    const aBefore = readFileSync(join(dirRef.path, 'scripts', 'a.gd'), 'utf-8');

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'old_name',
      replace: 'new_name',
      extensions: ['.gd'],
      dry_run: true,
    }, ctx);

    expect(result).toBeTruthy();
    // dry_run 不应修改文件
    const aAfter = readFileSync(join(dirRef.path, 'scripts', 'a.gd'), 'utf-8');
    expect(aAfter).toBe(aBefore);
    expect(aAfter).toContain('old_name');

    // 结果应包含 DRY RUN 标记
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('[DRY RUN]');
  });

  it('preserves CRLF line endings after replacement', async () => {
    // 创建包含 CRLF 的文件
    dirRef.path = createTempProject({
      'project.godot': '; Engine config\n[application]\nconfig/name="Test"\n',
      'scripts/crlf.gd': 'extends Node\r\n\r\nfunc foo():\r\n\told_name()\r\n',
    });
    ctx = createToolContext(dirRef.path);

    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'old_name',
      replace: 'new_name',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    const content = readFileSync(join(dirRef.path, 'scripts', 'crlf.gd'), 'utf-8');
    expect(content).toContain('new_name()');
    expect(content).toContain('\r\n');
    expect(content).not.toContain('old_name');
  });

  it('no-op when no files match search text', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'nonexistent_pattern_xyz',
      replace: 'replacement',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('No files contained the search text');
  });

  it('returns error when search is empty', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: '',
      replace: 'replacement',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
  });
});
