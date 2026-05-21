import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as script from '../../build/tools/script.js';
import * as validation from '../../build/tools/validation.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

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

  // 用例 12: write_script — 创建新脚本文件
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

  // 用例 13: edit_script — search_and_replace 模式
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

  // 用例 14: validate_scripts — 检测语法错误
  itIfGodot('validate scripts with syntax error', async () => {
    const badScriptRel = 'scripts/bad.gd';
    writeFileSync(join(dirRef.path, badScriptRel), 'extends Node2D\n\nfunc foo(\n', 'utf-8');

    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: [badScriptRel],
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.total_errors > 0,
      `Should report syntax errors, got: ${text}`);
    const badEntry = parsed.scripts.find(s => s.file.includes('bad.gd'));
    assert.ok(badEntry && badEntry.has_errors, 'bad.gd should be flagged with errors');
  });

  // 用例 15: edit_script — 不存在的文件应返回错误
  // TODO: script.ts should use errorResult() for file-not-found instead of textResult(),
  // so isError would be set and tests could assert on it directly.
  itIfGodot('edit non-existent script returns error', async () => {
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: 'scripts/DOES_NOT_EXIST.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);
    // script.handleTool 使用 textResult (不含 isError)，通过内容判断失败
    const text = result.content?.[0]?.text || '';
    assert.ok(
      text.includes('Error') || text.includes('not found'),
      `Should indicate file not found, got: ${text}`
    );
  });
});
