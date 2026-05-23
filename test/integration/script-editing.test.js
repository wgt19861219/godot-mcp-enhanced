import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as script from '../../build/tools/script.js';
import * as validation from '../../build/tools/validation.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

// itIfGodot 通过全局变量引用 it
globalThis.it = it;

describe('Level B: Script editing', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  // 用例 1: write_script — 创建新脚本文件
  itIfGodot('write new script', async () => {
    const result = await script.handleTool('write_script', {
      project_path: dirRef.path,
      script_path: 'scripts/new_script.gd',
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    assert.ok(existsSync(join(dirRef.path, 'scripts', 'new_script.gd')),
      'Script file should exist');
  });

  // 用例 2: edit_script — search_and_replace 模式替换内容
  itIfGodot('search and replace edit', async () => {
    const scriptPath = 'scripts/main.gd';
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: scriptPath,
      start_line: 1,
      end_line: 1,
      new_content: '',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    const content = readFileSync(join(dirRef.path, scriptPath), 'utf-8');
    assert.ok(content.includes('edited'), 'Should contain replaced content');
  });

  // 用例 3: validate_scripts — 合法脚本应通过验证
  itIfGodot('validate scripts', async () => {
    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: ['scripts/main.gd'],
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.validated > 0, 'Should validate at least one script');
    assert.ok(parsed.total_errors === 0 || parsed.total_errors === undefined,
      `Valid scripts should have zero parse errors, got: ${parsed.total_errors}`);
  });

  // 用例 4: edit_script — 不存在的文件应返回错误
  itIfGodot('edit nonexistent script', async () => {
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: 'scripts/DOES_NOT_EXIST.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    assert.ok(
      text.includes('Error') || text.includes('not found'),
      `Should indicate file not found, got: ${text}`
    );
  });
});
