import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as validation from '../src/tools/validation.js';
import { createToolContext } from './helpers/tool-context.js';

// C-1(2026-11-26) 的教训:替身夹具把错误行放在 stdout,与 A-04(6177ddfc)之后的真实流布局脱节,
// 「只读 stdout」的回归五个月没被测试拦住。本用例跑真实 Godot 并走 validate_scripts 工具层(含输出组装),
// 脚本放在子目录——同时钉住「Parse Error 在 stderr 也能归因」与「结果键/查找键在 Windows 上对得上」(审查 B-1)。
// 仅在设了 GODOT_PATH 且二进制存在时运行(无 Godot 的环境整组跳过)。
const GODOT = process.env.GODOT_PATH ?? '';
const HAS_GODOT = GODOT !== '' && existsSync(GODOT);

describe.skipIf(!HAS_GODOT)('validate_scripts 真机(真实 Godot 输出布局,经工具层)', () => {
  let proj;
  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), 'validate-real-'));
    mkdirSync(join(proj, 'scripts'), { recursive: true });
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="validate-real"\n', 'utf-8');
    writeFileSync(join(proj, 'scripts', 'ok.gd'), 'extends Node\nfunc _ready() -> void:\n\tprint("ok")\n', 'utf-8');
    writeFileSync(join(proj, 'scripts', 'bad.gd'), 'extends Node\nfunc _ready() -> void:\n\tprint(\n', 'utf-8');
  });
  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  it('子目录坏脚本的 Parse Error 进入 scripts[].errors,正常脚本无错误', async () => {
    const ctx = createToolContext(proj);
    ctx.findGodot = async () => GODOT;
    const result = await validation.handleTool('validation', {
      action: 'validate_scripts', project_path: proj, scripts: ['scripts/ok.gd', 'scripts/bad.gd'], timeout: 10,
    }, ctx);
    const summary = JSON.parse(result.content[0].text.split('\n_duration_ms')[0]);
    const byFile = new Map(summary.scripts.map(s => [String(s.file).replace(/\\/g, '/'), s]));

    expect(result.isError).not.toBe(true);
    expect('incomplete' in summary).toBe(false);
    expect(summary.validated).toBe(2);
    expect(summary.total_errors).toBe(1);
    expect(summary.scripts_with_errors).toBe(1);
    expect(byFile.get('scripts/bad.gd').has_errors).toBe(true);
    expect(byFile.get('scripts/bad.gd').errors).toHaveLength(1);
    expect(byFile.get('scripts/bad.gd').errors[0]).toContain('SCRIPT ERROR: Parse Error:');
    expect(byFile.get('scripts/ok.gd').errors).toEqual([]);
    expect(byFile.get('scripts/ok.gd').has_errors).toBe(false);
  }, 60000);
});
