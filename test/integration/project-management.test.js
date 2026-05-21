import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import * as project from '../../build/tools/project.js';
import * as validation from '../../build/tools/validation.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT, BROKEN_REF_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Project management', async () => {
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

  // 用例 16: create_project — 纯文件系统操作，不需要 Godot
  it('create project', async () => {
    const newDir = join(dirRef.path, 'new-project');
    const result = await project.handleTool('create_project', {
      project_path: newDir,
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    assert.ok(existsSync(join(newDir, 'project.godot')), 'project.godot should exist');
    assert.ok(existsSync(join(newDir, 'scenes', 'main.tscn')), 'scenes/main.tscn should exist');
    assert.ok(existsSync(join(newDir, 'scripts', 'main.gd')), 'scripts/main.gd should exist');
    assert.ok(existsSync(join(newDir, 'assets')), 'assets directory should exist');
  });

  // 用例 17: read_project_config — 纯文件系统操作，不需要 Godot
  it('read project config', async () => {
    const result = await project.handleTool('read_project_config', {
      project_path: dirRef.path,
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    // parseGodotConfig 返回以 section 为 key 的对象
    assert.ok(parsed.application || parsed['application'],
      'Should contain application section');
    // parseGodotConfig 保留完整 key: "config/name"
    const appSection = parsed.application || parsed['application'];
    assert.ok(appSection, 'Should have application section');
    assert.equal(appSection['config/name'], 'TestProject', 'Should parse config/name');
  });

  // 用例 18: validate_project with missing references — 纯静态扫描，不需要 Godot
  it('validate project with missing references', async () => {
    dirRef.path = createTempProject(BROKEN_REF_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await validation.handleTool('validate_project', {
      project_path: dirRef.path,
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    // validate_project 返回 JSON，其中 issues 包含 missing_resource 类型
    assert.ok(text.includes('MISSING.gd') || text.includes('missing_resource') || text.includes('Referenced resource not found'),
      'Should report missing resource reference');
    // 验证 JSON 格式
    const parsed = JSON.parse(text);
    assert.equal(parsed.valid, false, 'Project with broken refs should not be valid');
    assert.ok(parsed.issue_count > 0, 'Should have at least one issue');
  });

  // 用例 19: list_files with extension filter — 纯文件系统操作，不需要 Godot
  it('list files with extension filter', async () => {
    const result = await project.handleTool('list_files', {
      project_path: dirRef.path,
      extensions: ['.gd'],
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    const files = parsed.files || [];
    assert.ok(files.length > 0, 'Should find at least one .gd file');
    for (const f of files) {
      assert.ok(f.endsWith('.gd'), `File ${f} should end with .gd`);
    }
  });

  // 用例 20: validate_scripts with non-existent path doesn't crash
  itIfGodot('validate scripts with non-existent path', async () => {
    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: ['scripts/DOES_NOT_EXIST.gd'],
    }, ctx);
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    // Godot silently skips missing files — verify tool doesn't crash
    assert.ok(typeof parsed.validated === 'number',
      'Should return valid structured result');
  });

  // 用例 21: validate_scripts with Godot — 需要 Godot headless
  itIfGodot('validate scripts on valid project', async () => {
    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.validated > 0, 'Should validate at least one script');
    // MINIMAL_PROJECT 的 main.gd 是合法的，不应有 parse error
    assert.ok(parsed.total_errors === 0 || parsed.total_errors === undefined,
      `Valid scripts should have zero parse errors, got: ${parsed.total_errors}`);
  });
});
