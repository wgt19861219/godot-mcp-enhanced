import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

// C-2(2026-11-26):validate_scripts / create_files 的校验器没拉起 / 没跑完时,此前组装输出只遍历脚本清单,
// batchValidateScripts 返回的 <validator…> 条目被静默丢弃,报成「found 0 errors」。
// 只替换 spawnGodot(batchValidateScripts 保持真实逻辑),走真实归因与输出组装。
vi.mock('../src/tools/spawn-helper.js', () => ({ spawnGodot: vi.fn() }));

import { spawnGodot } from '../src/tools/spawn-helper.js';
import * as validation from '../src/tools/validation.js';
import * as batch from '../src/tools/batch-tools.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

const BANNER = 'Godot Engine v4.7.2.stable.official - https://godotengine.org\n';
const SPAWN_FAILED = 'SPAWN_FAILED: spawn godot ENOENT';
const PARSE_ERROR = 'SCRIPT ERROR: Parse Error: Expected expression as the function argument.';

const okRun = () => {
  const done = BANNER + 'MCP_VALIDATE_DONE\n';
  return { stdout: done, stderr: '', output: done, exitCode: 0, timedOut: false };
};
/** 真实流布局:Parse Error 与 at: 行在 stderr,校验器自己的 print 在 stdout */
const parseErrorRun = (rel) => ({
  stdout: BANNER + 'MCP_VALIDATE_DONE\n',
  stderr: `${PARSE_ERROR}\n   at: GDScript::reload (res://${rel}:3)\n`,
  output: '', exitCode: 0, timedOut: false,
});
const spawnFailedRun = () => ({ stdout: SPAWN_FAILED, stderr: '', output: SPAWN_FAILED, exitCode: -1, timedOut: false });

function parseToolResult(result) {
  return JSON.parse(result.content[0].text.split('\n_duration_ms')[0]);
}

describe('validate_scripts / create_files:校验结果必须到达输出层', () => {
  const dirRef = { path: null };
  let ctx;

  beforeEach(() => {
    vi.mocked(spawnGodot).mockReset();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  afterEach(() => {
    if (dirRef.path) {
      rmSync(dirRef.path, { recursive: true, force: true });
      dirRef.path = null;
    }
  });

  async function callValidateScripts(extra = {}) {
    const result = await validation.handleTool('validation', { action: 'validate_scripts', project_path: dirRef.path, ...extra }, ctx);
    return parseToolResult(result);
  }

  it('validate_scripts:校验器超时(没跑完)→ 标注 INCOMPLETE,不再报已校验', async () => {
    vi.mocked(spawnGodot).mockResolvedValue({ stdout: BANNER, stderr: '', output: BANNER, exitCode: null, timedOut: true });
    const summary = await callValidateScripts();

    expect(summary.incomplete).toBe(true);
    expect(summary.validated).toBe(0);
    expect(summary.total_errors).toBe(1);
    expect(summary.validator_failures.map(f => f.file)).toEqual(['<validator>']);
    expect(new Set(summary.validator_failures[0].not_validated)).toEqual(new Set(summary.scripts.map(s => s.file)));
    expect(summary.scripts.map(s => s.validated)).toEqual(summary.scripts.map(() => false));
    expect(summary.summary.startsWith('VALIDATION INCOMPLETE')).toBe(true);
  });

  it('validate_scripts:校验器没拉起 → 标注 INCOMPLETE 并透出 SPAWN_ERROR', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(spawnFailedRun());
    const summary = await callValidateScripts();

    expect(summary.incomplete).toBe(true);
    expect(summary.validated).toBe(0);
    expect(summary.validator_failures.map(f => f.file)).toEqual(['<validator:spawn>']);
    expect(summary.validator_failures[0].errors[0]).toBe('SPAWN_ERROR: spawn godot ENOENT');
  });

  // 审查 B-1:batchValidateScripts 的结果键恒正斜杠,win32 上 relPathOf 恒反斜杠——不归一时子目录脚本的
  // 错误在输出层查不到(真项目脚本几乎都在子目录)。
  it('validate_scripts:子目录脚本的 Parse Error(在 stderr)进入 scripts[].errors 与 total_errors', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(parseErrorRun('scripts/main.gd'));
    const summary = await callValidateScripts({ scripts: ['scripts/main.gd'] });

    expect(summary.total_errors).toBe(1);
    expect(summary.scripts_with_errors).toBe(1);
    expect(summary.scripts).toHaveLength(1);
    expect(summary.scripts[0].has_errors).toBe(true);
    expect(summary.scripts[0].errors).toEqual([PARSE_ERROR]);
  });

  it('对照组:校验器正常完成时输出不变(无 incomplete,脚本条目不带 validated: false)', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(okRun());
    const summary = await callValidateScripts();

    expect('incomplete' in summary).toBe(false);
    expect(summary.validated).toBe(summary.scripts.length);
    expect(summary.total_errors).toBe(0);
    expect(summary.scripts.some(s => 'validated' in s)).toBe(false);
  });

  // 审查 B-2:此前对已是相对路径的 r.file 调 relPathOf 会抛异常,整个响应退化成错误且校验结果丢失。
  describe('create_files(validate=true)', () => {
    const createFilesArgs = () => ({
      action: 'create_files',
      project_path: dirRef.path,
      files: [{ path: 'res://scripts/new_file.gd', content: 'extends Node\n' }],
      validate: true,
    });

    it('新建脚本有 Parse Error → 进入 validation_errors,响应仍是正常结果', async () => {
      vi.mocked(spawnGodot).mockResolvedValue(parseErrorRun('scripts/new_file.gd'));
      const result = await batch.handleTool('batch', createFilesArgs(), ctx);
      const parsed = parseToolResult(result);

      expect(result.isError).not.toBe(true);
      expect(parsed.created).toBe(1);
      expect(Object.keys(parsed.validation_errors)).toEqual(['scripts/new_file.gd']);
      expect(parsed.validation_errors['scripts/new_file.gd']).toEqual([PARSE_ERROR]);
      expect(parsed.validator_failures).toBeUndefined();
    });

    it('校验器没拉起 → validator_failures 显式暴露,不计入 validation_errors', async () => {
      vi.mocked(spawnGodot).mockResolvedValue(spawnFailedRun());
      const result = await batch.handleTool('batch', createFilesArgs(), ctx);
      const parsed = parseToolResult(result);

      expect(result.isError).not.toBe(true);
      expect(parsed.created).toBe(1);
      expect(parsed.validation_errors).toBeUndefined();
      expect(parsed.validator_failures.map(f => f.file)).toEqual(['<validator:spawn>']);
      expect(parsed.validator_failures[0].not_validated).toEqual(['scripts/new_file.gd']);
      expect(parsed.incomplete).toBe(true);
    });

    it('校验器正常完成且无错 → 不出现校验相关字段', async () => {
      vi.mocked(spawnGodot).mockResolvedValue(okRun());
      const parsed = parseToolResult(await batch.handleTool('batch', createFilesArgs(), ctx));

      expect(parsed.created).toBe(1);
      expect(parsed.validation_errors).toBeUndefined();
      expect(parsed.validator_failures).toBeUndefined();
      expect(parsed.incomplete).toBeUndefined();
    });
  });
});
