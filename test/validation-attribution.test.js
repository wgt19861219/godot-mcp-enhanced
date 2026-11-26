import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock spawnGodot —— 用实测的 Godot 4.6.2 输出做 fixture,无需真跑 Godot
vi.mock('../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(),
}));

import { spawnGodot } from '../src/tools/spawn-helper.js';
import { batchValidateScripts, isErrorFalsePositive } from '../src/tools/validation.js';

const IS_WIN = process.platform === 'win32';
const PROJECT = IS_WIN ? 'C:\\proj' : '/proj';
const SEP = IS_WIN ? '\\' : '/';
const f = (rel) => PROJECT + SEP + rel.split('/').join(SEP);

// 实测的 Godot 4.6.2 输出格式(本会话验证复现):
//   SCRIPT ERROR: Parse Error: <msg>
//      at: GDScript::reload (res://<rel>:<line>)
//   ERROR: Failed to load script "res://<rel>" with error "Parse error".
function godotOutput(errors) {
  const lines = ['Godot Engine v4.6.2.stable...', ''];
  for (const e of errors) {
    lines.push(`SCRIPT ERROR: Parse Error: ${e.msg}`);
    lines.push(`   at: GDScript::reload (res://${e.rel}:${e.line})`);
    lines.push(`ERROR: Failed to load script "res://${e.rel}" with error "Parse error".`);
  }
  lines.push('MCP_VALIDATE_DONE');
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0, timedOut: false };
}

// load 失败但 Godot 未打印标准 Parse Error(模拟非典型加载失败)
function godotLoadNullOutput(rels) {
  const lines = ['Godot Engine v4.6.2.stable...', ''];
  for (const rel of rels) {
    lines.push(`MCP_LOAD_NULL: res://${rel}`);
  }
  lines.push('MCP_VALIDATE_DONE');
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0, timedOut: false };
}

describe('batchValidateScripts 归因 (Godot 4.6.2 单行 at: 格式)', () => {
  beforeEach(() => { vi.mocked(spawnGodot).mockReset(); });

  it('缩进错误(Expected indented block)被归因到文件', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutput([
      { rel: 'scripts/bad_indent.gd', line: 5, msg: 'Expected indented block after "for" block.' },
    ]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_indent.gd')], 5000);
    const entry = results.find(r => r.file.includes('bad_indent'));
    expect(entry).toBeTruthy();
    expect(entry.errors.length).toBeGreaterThan(0);
    expect(entry.errors.some(e => e.includes('indented block'))).toBe(true);
  });

  it('未声明变量错误被归因到文件', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutput([
      { rel: 'scripts/bad_undeclared.gd', line: 6, msg: 'Identifier "j" not declared in the current scope.' },
    ]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_undeclared.gd')], 5000);
    const entry = results.find(r => r.file.includes('bad_undeclared'));
    expect(entry).toBeTruthy();
    expect(entry.errors.some(e => e.includes('Identifier "j"'))).toBe(true);
  });

  it('成员变量与函数重名错误被归因到文件', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutput([
      { rel: 'scripts/bad_redeclare.gd', line: 5, msg: 'Function "_sky_ads" has the same name as a previously declared variable.' },
    ]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_redeclare.gd')], 5000);
    const entry = results.find(r => r.file.includes('bad_redeclare'));
    expect(entry).toBeTruthy();
    expect(entry.errors.some(e => e.includes('same name'))).toBe(true);
  });

  it('MCP_LOAD_NULL 降级警告(Task D2): load 失败无 Parse Error 时归 headless_limitations 而非 errors', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotLoadNullOutput(['scripts/odd.gd']));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/odd.gd')], 5000);
    const entry = results.find(r => r.file.includes('odd'));
    expect(entry).toBeTruthy();
    // 不进 errors(否则 edit_script 的 D1 回滚条件 errors.length>0 仍会触发)
    expect(entry.errors.length).toBe(0);
    // 归入警告通道,文案引导复核
    expect(entry.headless_limitations).toBeTruthy();
    expect(entry.headless_limitations.some(w => w.includes('load() returned null'))).toBe(true);
    expect(entry.headless_limitations.some(w => w.includes('编辑已保留'))).toBe(true);
  });

  it('正常脚本(无错误)不产生错误条目', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutput([]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/ok.gd')], 5000);
    const entry = results.find(r => r.file.includes('ok'));
    expect(entry).toBeFalsy();
  });
});

// C-1(2026-11-26) 真实流布局:A-04(6177ddfc)起 spawnGodot 把 stderr 单独返回,而 Godot 的 Parse Error
// 全部写在 stderr(4.7.2 / 4.6.3 实测一致)。上方 godotOutput 是拆分之前的布局,保留以兼容 stdout 形态。
function godotOutputStderr(errors) {
  const stdout = ['Godot Engine v4.7.2.stable.official - https://godotengine.org', '', 'MCP_VALIDATE_DONE'].join('\n');
  const errLines = [];
  for (const e of errors) {
    errLines.push(`SCRIPT ERROR: Parse Error: ${e.msg}`);
    errLines.push(`   at: GDScript::reload (res://${e.rel}:${e.line})`);
    errLines.push('   GDScript backtrace (most recent call first):');
    errLines.push('       [0] _initialize (C:/tmp/godot-mcp-exec/validate-abcd1234.gd:19)');
    errLines.push(`ERROR: Failed to load script "res://${e.rel}" with error "Parse error".`);
    errLines.push('   at: load (modules/gdscript/gdscript_resource_format.cpp:46)');
    errLines.push('   GDScript backtrace (most recent call first):');
    errLines.push('       [0] _initialize (C:/tmp/godot-mcp-exec/validate-abcd1234.gd:19)');
  }
  const stderr = errLines.join('\n');
  return { stdout, stderr, output: stdout + stderr, exitCode: 0, timedOut: false };
}

describe('batchValidateScripts 归因 (C-1:错误行在 stderr 的真实流布局)', () => {
  beforeEach(() => { vi.mocked(spawnGodot).mockReset(); });

  it('Parse Error 与 at: 行只在 stderr 时归因到文件(修复前返回 [])', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutputStderr([
      { rel: 'scripts/bad_paren.gd', line: 3, msg: 'Expected expression as the function argument.' },
    ]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_paren.gd')], 5000);
    const entry = results.find(r => r.file.includes('bad_paren'));
    expect(entry?.errors).toEqual(['SCRIPT ERROR: Parse Error: Expected expression as the function argument.']);
  });

  it('带回溯行与第二处 at: 时每个错误只归因一次,且校验器完成不产生 <validator> 条目', async () => {
    vi.mocked(spawnGodot).mockResolvedValue(godotOutputStderr([
      { rel: 'scripts/bad_indent.gd', line: 5, msg: 'Expected indented block after "else" block.' },
      { rel: 'scripts/bad_undeclared.gd', line: 6, msg: 'Identifier "j" not declared in the current scope.' },
    ]));
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_indent.gd'), f('scripts/bad_undeclared.gd')], 5000);
    const indent = results.find(r => r.file.includes('bad_indent'));
    const undeclared = results.find(r => r.file.includes('bad_undeclared'));
    expect(indent?.errors).toEqual(['SCRIPT ERROR: Parse Error: Expected indented block after "else" block.']);
    expect(undeclared?.errors).toEqual(['SCRIPT ERROR: Parse Error: Identifier "j" not declared in the current scope.']);
    expect(results.filter(r => r.file.startsWith('<validator')).map(r => r.file)).toEqual([]);
  });

  it('同一脚本既有 Parse Error 又打印 MCP_LOAD_NULL 时 errors 优先,不再挂「编辑已保留」的 load-null 警告', async () => {
    const run = godotOutputStderr([{ rel: 'scripts/bad_paren.gd', line: 3, msg: 'Expected expression as the function argument.' }]);
    run.stdout = run.stdout.replace('MCP_VALIDATE_DONE', 'MCP_LOAD_NULL: res://scripts/bad_paren.gd\nMCP_VALIDATE_DONE');
    vi.mocked(spawnGodot).mockResolvedValue(run);
    const results = await batchValidateScripts('godot', PROJECT, [f('scripts/bad_paren.gd')], 5000);

    expect(results).toHaveLength(1);
    expect(results[0].errors).toEqual(['SCRIPT ERROR: Parse Error: Expected expression as the function argument.']);
    expect(results[0].headless_limitations).toBeUndefined();
  });
});

describe('isErrorFalsePositive 收窄 (signature 不再误杀真实错误)', () => {
  // 回归锁: Edit A 之前,含 _process + signature 的真实错误被规则2误过滤 → 漏报
  it('_process 签名不匹配的真实错误不再被过滤', () => {
    const line = 'SCRIPT ERROR: Parse Error: The function signature for "_process()" doesn\'t match the parent.';
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  it('_ready 重写参数个数错误的真实 Parse Error 不再被过滤', () => {
    const line = 'SCRIPT ERROR: Parse Error: The function signature for "_ready(a, b)" is wrong.';
    expect(isErrorFalsePositive(line)).toBeFalsy();
  });

  // 不破坏原误报过滤: 虚拟方法 "not found in base self" 仍应过滤(headless parser 限制)
  it('_ready not found in base self 仍被过滤(headless 误报)', () => {
    const line = 'SCRIPT ERROR: Parse Error: Function "_ready()" not found in base self.';
    expect(isErrorFalsePositive(line)).toBeTruthy();
  });

  it('_process not found in base self 仍被过滤(headless 误报)', () => {
    const line = 'SCRIPT ERROR: Parse Error: Function "_process()" not found in base self.';
    expect(isErrorFalsePositive(line)).toBeTruthy();
  });
});
