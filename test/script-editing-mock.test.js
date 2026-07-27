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

// v0.25.0: validation 输出改为双轨（人类可读文本 + 尾部 ---JSON--- JSON）
function parseDualTrack(text) {
  const marker = '---JSON---\n';
  const idx = text.lastIndexOf(marker);
  return JSON.parse(idx >= 0 ? text.slice(idx + marker.length) : text);
}

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
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'scripts/new_script.gd',
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);
    expect(!result.isError).toBeTruthy();
    expect(existsSync(join(dirRef.path, 'scripts', 'new_script.gd'))).toBeTruthy();
  });

  // 用例 2: edit_script — search_and_replace 模式替换内容
  it('search and replace edit', async () => {
    const scriptPath = 'scripts/main.gd';
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
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

    const result = await validation.handleTool('validation', {
      project_path: dirRef.path,
      action: 'validate_scripts',
      scripts: ['scripts/main.gd'],
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const text = result.content[0].text;
    const parsed = parseDualTrack(text);
    expect(parsed.validated > 0).toBeTruthy();
    expect(parsed.total_errors === 0 || parsed.total_errors === undefined).toBeTruthy();
  });

  // 用例 4: edit_script — 不存在的文件应返回错误
  it('edit nonexistent script', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
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

  // #2 路径解析统一: res:// 前缀应被正确剥离
  it('write_script with res:// prefix', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'res://scripts/res_path_test.gd',
      content: 'extends Node\n',
      overwrite: true,
    }, ctx);
    expect(!result.isError).toBeTruthy();
    expect(existsSync(join(dirRef.path, 'scripts', 'res_path_test.gd'))).toBeTruthy();
  });

  it('read_script with res:// prefix', async () => {
    // 先写入
    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'res://scripts/res_read_test.gd',
      content: 'extends Node\n# test comment\n',
    }, ctx);
    // 再用 res:// 读取
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'read_script',
      script_path: 'res://scripts/res_read_test.gd',
    }, ctx);
    expect(!result.isError).toBeTruthy();
    expect(result.content[0].text.includes('test comment')).toBeTruthy();
  });

  it('edit_script with res:// prefix and path traversal fails', async () => {
    // resolveWithinRoot 应阻止 res://../ 路径遍历
    await expect(script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'res://../etc/passwd',
      start_line: 1,
      end_line: 1,
      new_content: 'hacked',
    }, ctx)).rejects.toThrow('Path traversal');
  });

  // #6 smart indent: 空格缩进文件应正确调整
  it('edit_script with space-indented file adjusts indent correctly', async () => {
    // 先创建空格缩进文件（2 空格）
    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'scripts/space_indent.gd',
      content: 'extends Node\n\nfunc _ready():\n  var x = 1\n  if x > 0:\n    print(x)\n',
    }, ctx);
    // 用 smart indent 编辑，替换 if 块
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/space_indent.gd',
      start_line: 5,
      end_line: 6,
      new_content: 'if x > 0:\n  print("positive")\n  print("done")',
      indent_mode: 'smart',
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const content = readFileSync(join(dirRef.path, 'scripts', 'space_indent.gd'), 'utf-8');
    // 新内容应保持 2 空格缩进（与原文件一致）
    expect(content.includes('  print("positive")')).toBeTruthy();
  });

  // #6 smart indent: tab 缩进文件行为不变（向后兼容）
  it('edit_script with tab-indented file keeps tab indent', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'func new_func():\n\tpass',
      indent_mode: 'smart',
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const content = readFileSync(join(dirRef.path, 'scripts', 'main.gd'), 'utf-8');
    expect(content.includes('\tpass')).toBeTruthy();
  });

  // #3 级联删除信息: parse error 应显示结构化行号和标识符
  it('edit_script revert shows structured parse error with line and identifier', async () => {
    // 让 batchValidateScripts 返回结构化 parse error
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: [
        'scripts/main.gd:15 - Parse Error: identifier "MAX_SPEED" not declared in current scope',
        'scripts/main.gd:23 - Parse Error: Unexpected identifier: "calc_damage"',
      ],
      warnings: [],
    }]);

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'bad code',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    // 应包含结构化行号信息
    expect(text.includes('Line 15')).toBeTruthy();
    expect(text.includes('Line 23')).toBeTruthy();
    // 应包含标识符
    expect(text.includes('MAX_SPEED')).toBeTruthy();
    expect(text.includes('calc_damage')).toBeTruthy();
    // 文件应被恢复到原始状态
    expect(text.includes('Original file restored')).toBeTruthy();
  });
});
