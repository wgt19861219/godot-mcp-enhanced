import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock the executor — hoisted to top by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [{ key: 'result', value: '{"validated":1,"total_errors":0}' }],
    raw_output: '', duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

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

import { executeGdscript } from '../src/gdscript-executor.js';
import * as script from '../src/tools/script.js';
import * as validation from '../src/tools/validation.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

describe('Level B: Script editing', () => {
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  // 用例 1: write_script — 创建新脚本文件
  it('write new script', async () => {
    const result = await script.handleTool('write_script', {
      project_path: dirRef.path,
      script_path: 'scripts/new_script.gd',
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);
    expect(!result.isError).toBeTruthy();
    expect(existsSync(join(dirRef.path, 'scripts', 'new_script.gd'))).toBeTruthy();
  });

  // 用例 2: edit_script — search_and_replace 模式替换内容
  it('search and replace edit', async () => {
    const scriptPath = 'scripts/main.gd';
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: scriptPath,
      start_line: 1,
      end_line: 1,
      new_content: '',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const content = readFileSync(join(dirRef.path, scriptPath), 'utf-8');
    expect(content.includes('edited')).toBeTruthy();
  });

  // 用例 3: validate_scripts — 合法脚本应通过验证
  it('validate scripts', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([
      { file: 'scripts/main.gd', errors: [], warnings: [] },
    ]);

    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: ['scripts/main.gd'],
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.validated > 0).toBeTruthy();
    expect(parsed.total_errors === 0 || parsed.total_errors === undefined).toBeTruthy();
  });

  // 用例 4: edit_script — 不存在的文件应返回错误
  it('edit nonexistent script', async () => {
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: 'scripts/DOES_NOT_EXIST.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    expect(
      text.includes('Error') || text.includes('not found'),
    ).toBeTruthy();
  });
});
