import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock the executor — hoisted to top by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [],
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
    batchValidateScripts: vi.fn(() => Promise.resolve([])),
  };
});

import { executeGdscript } from '../src/gdscript-executor.js';
import * as project from '../src/tools/project.js';
import * as validation from '../src/tools/validation.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

describe('Level B: Project management', () => {
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

  // 用例 1: create_project — 创建完整项目结构
  it('create project', async () => {
    const newDir = join(dirRef.path, 'new-project');
    const result = await project.handleTool('create_project', {
      project_path: newDir,
    }, ctx);
    expect(!result.isError).toBeTruthy();
    expect(existsSync(join(newDir, 'project.godot'))).toBeTruthy();
  });

  // 用例 2: read_project_config — 解析项目配置
  it('read project config', async () => {
    const result = await project.handleTool('read_project_config', {
      project_path: dirRef.path,
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    const appSection = parsed.application || parsed['application'];
    expect(appSection).toBeTruthy();
    expect(appSection['config/name']).toBe('TestProject');
  });

  // 用例 3: validate_project — 最小项目应通过验证（纯文件系统操作，不调用 Godot）
  it('validate project', async () => {
    const result = await validation.handleTool('validate_project', {
      project_path: dirRef.path,
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.valid !== false).toBeTruthy();
  });

  // 用例 4: list_files 带 .gd 扩展名过滤
  it('list files with filter', async () => {
    const result = await project.handleTool('list_files', {
      project_path: dirRef.path,
      extensions: ['.gd'],
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    const files = parsed.files || [];
    expect(files.length > 0).toBeTruthy();
    for (const f of files) {
      expect(f.endsWith('.gd')).toBeTruthy();
    }
  });

  // 用例 5: validate_scripts 空数组不应崩溃
  it('validate scripts with empty array', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([]);

    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: [],
    }, ctx);
    expect(!result.isError).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.validated === 'number').toBeTruthy();
  });
});
