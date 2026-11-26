import { describe, it, expect, vi } from 'vitest';
import {
  KNOWN_BASE_METHODS,
  isErrorFalsePositive,
  getToolDefinitions,
  handleTool,
  TOOL_META,
  readProjectSymbolContext,
  batchValidateScripts,
} from '../src/tools/validation.js';
import { mockSuccessResult } from './helpers/mock-results.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock executor ──────────────────────────────────────────────────────────

vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => mockSuccessResult({
    outputs: [{ key: 'result', value: '{"ok":true}' }],
  })),
}));

vi.mock('../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(async () => ({
    stdout: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    stderr: '',
    output: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    exitCode: 0,
    timedOut: false,
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/usr/bin/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('validation-tools: KNOWN_BASE_METHODS', () => {
  it('is non-empty', () => {
    expect(KNOWN_BASE_METHODS.size).toBeGreaterThan(0);
  });

  it('contains common lifecycle methods', () => {
    expect(KNOWN_BASE_METHODS.has('_ready')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('_process')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('_physics_process')).toBe(true);
  });

  it('contains common node methods', () => {
    expect(KNOWN_BASE_METHODS.has('add_child')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('queue_free')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('get_tree')).toBe(true);
  });
});

describe('validation-tools: getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('includes validation merged tool with all actions', () => {
    const defs = getToolDefinitions();
    const vd = defs.find(d => d.name === 'validation');
    expect(vd).toBeDefined();
    const actionEnum = vd.inputSchema.properties.action.enum;
    expect(actionEnum).toContain('validate_scripts');
    expect(actionEnum).toContain('validate_project');
    expect(actionEnum).toContain('run_and_verify');
    expect(actionEnum).toContain('analyze_error');
    expect(actionEnum).toContain('import_resources');
  });
});

describe('validation-tools: TOOL_META', () => {
  it('has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThan(0);
  });

  it('has validation entry with correct flags', () => {
    expect(TOOL_META.validation).toBeDefined();
    expect(TOOL_META.validation.readonly).toBe(false);
    expect(TOOL_META.validation.long_running).toBe(true);
  });
});

describe('validation-tools: handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool_xyz', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns null for empty tool name', async () => {
    const result = await handleTool('', {}, makeCtx());
    expect(result).toBeNull();
  });
});

describe('validation-tools: isErrorFalsePositive additional cases', () => {
  it('returns true for Condition "is true" engine noise', () => {
    const line = 'Condition "!editor_preview" is true.';
    expect(isErrorFalsePositive(line)).toBe(true);
  });

  it('returns true for ScriptBus internal error', () => {
    const line = 'SCRIPT ERROR: Parse Error: Function "ScriptBus" not found in base self.';
    expect(isErrorFalsePositive(line)).toBe(true);
  });

  it('returns false for real syntax error', () => {
    const line = 'SCRIPT ERROR: Parse Error: Unexpected indent.';
    expect(isErrorFalsePositive(line)).toBe(false);
  });

  it('returns false for real identifier not found', () => {
    const line = 'SCRIPT ERROR: Parse Error: Identifier "my_custom_func" not found in the current scope.';
    expect(isErrorFalsePositive(line)).toBe(false);
  });
});

// ─── Task D2 (2026-11-12): readProjectSymbolContext 抽取 + batchValidateScripts 接线 ──
// 背景: autoload/class_name 识别机制此前只在 run_and_verify 接线(error-analyzer
// headless_limitation 分类),edit_script 自动验证链(batchValidateScripts)没有——
// 引用 autoload 的合法脚本被 headless 误报 Identifier not declared 计入 errors,
// 触发 D1 之前的回滚链路误回滚正确编辑。

function makeSymbolFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'd2-symbols-'));
  writeFileSync(join(dir, 'project.godot'), [
    'config_version=5',
    '',
    '[autoload]',
    '',
    'GameData="*res://scripts/game_data.gd"',
    'AudioManager="*res://scripts/audio_manager.gd"',
    '',
  ].join('\n'), 'utf-8');
  mkdirSync(join(dir, '.godot'), { recursive: true });
  writeFileSync(join(dir, '.godot', 'global_script_class_cache.cfg'), [
    'list=Array[Dictionary]([{',
    '"base": "Node",',
    '"class": &"PlayerStats",',
    '"icon": "",',
    '"language": &"GDScript",',
    '"path": "res://scripts/player_stats.gd"',
    '}])',
  ].join('\n'), 'utf-8');
  return dir;
}

function godotSpawnResult(lines) {
  return { stdout: ['Godot Engine v4.6.2.stable...', '', ...lines].join('\n'), stderr: '', exitCode: 0, timedOut: false };
}

describe('readProjectSymbolContext (Task D2)', () => {
  it('reads autoload names from project.godot [autoload] section', async () => {
    const dir = makeSymbolFixture();
    try {
      const ctx = await readProjectSymbolContext(dir);
      expect(ctx.autoloadNames).toContain('GameData');
      expect(ctx.autoloadNames).toContain('AudioManager');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads class_name list from .godot/global_script_class_cache.cfg', async () => {
    const dir = makeSymbolFixture();
    try {
      const ctx = await readProjectSymbolContext(dir);
      expect(ctx.classNames).toContain('PlayerStats');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty arrays (no throw) for a project without configs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd2-empty-'));
    try {
      const ctx = await readProjectSymbolContext(dir);
      expect(ctx.autoloadNames).toEqual([]);
      expect(ctx.classNames).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('batchValidateScripts: autoload 误报过滤 + MCP_LOAD_NULL 降级 (Task D2)', () => {
  it('Identifier "GameData" not declared(GameData 为声明的 autoload)不计入 errors', async () => {
    const dir = makeSymbolFixture();
    try {
      const { spawnGodot } = await import('../src/tools/spawn-helper.js');
      vi.mocked(spawnGodot).mockResolvedValueOnce(godotSpawnResult([
        'SCRIPT ERROR: Parse Error: Identifier "GameData" not declared in the current scope.',
        '   at: GDScript::reload (res://scripts/main.gd:7)',
        'MCP_VALIDATE_DONE',
      ]));
      const results = await batchValidateScripts('/usr/bin/godot', dir, [join(dir, 'scripts', 'main.gd')], 5000);
      // 误报被过滤: 全部条目 errors 为空(不触发 edit_script 回滚条件)
      for (const r of results) {
        expect(r.errors).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未知 Identifier 仍计入 errors(真实错误不被误滤)', async () => {
    const dir = makeSymbolFixture();
    try {
      const { spawnGodot } = await import('../src/tools/spawn-helper.js');
      vi.mocked(spawnGodot).mockResolvedValueOnce(godotSpawnResult([
        'SCRIPT ERROR: Parse Error: Identifier "typo_var" not declared in the current scope.',
        '   at: GDScript::reload (res://scripts/main.gd:7)',
        'MCP_VALIDATE_DONE',
      ]));
      const results = await batchValidateScripts('/usr/bin/godot', dir, [join(dir, 'scripts', 'main.gd')], 5000);
      const entry = results.find(r => r.file.includes('main.gd'));
      expect(entry).toBeTruthy();
      expect(entry.errors.some(e => e.includes('Identifier "typo_var"'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C-1(2026-11-26):真实流布局——Godot 的错误行在 stderr,校验器自己的 print(MCP_VALIDATE_DONE 等)在 stdout。
  function godotSpawnResultSplit(lines) {
    const isErr = (l) => /^(SCRIPT ERROR:|ERROR:|USER ERROR:)|^\s+at:/.test(l);
    const stdout = ['Godot Engine v4.7.2.stable.official - https://godotengine.org', ''];
    const stderr = [];
    for (const l of lines) (isErr(l) ? stderr : stdout).push(l);
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: 0, timedOut: false };
  }

  it('真实流布局(错误行在 stderr):autoload Identifier 误报仍被过滤', async () => {
    const dir = makeSymbolFixture();
    try {
      const { spawnGodot } = await import('../src/tools/spawn-helper.js');
      vi.mocked(spawnGodot).mockResolvedValueOnce(godotSpawnResultSplit([
        'SCRIPT ERROR: Parse Error: Identifier "GameData" not declared in the current scope.',
        '   at: GDScript::reload (res://scripts/main.gd:7)',
        'MCP_VALIDATE_DONE',
      ]));
      const results = await batchValidateScripts('/usr/bin/godot', dir, [join(dir, 'scripts', 'main.gd')], 5000);
      // 须是「读到并过滤」,而不是「根本没读到」:<filtered> 条目 + filtered_count
      expect(results.map(r => r.file)).toEqual(['<filtered>']);
      expect(results[0].filtered_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('真实流布局(错误行在 stderr):未知 Identifier 仍计入 errors(修复前恒为空)', async () => {
    const dir = makeSymbolFixture();
    try {
      const { spawnGodot } = await import('../src/tools/spawn-helper.js');
      vi.mocked(spawnGodot).mockResolvedValueOnce(godotSpawnResultSplit([
        'SCRIPT ERROR: Parse Error: Identifier "typo_var" not declared in the current scope.',
        '   at: GDScript::reload (res://scripts/main.gd:7)',
        'MCP_VALIDATE_DONE',
      ]));
      const results = await batchValidateScripts('/usr/bin/godot', dir, [join(dir, 'scripts', 'main.gd')], 5000);
      expect(results.flatMap(r => r.errors)).toEqual([
        'SCRIPT ERROR: Parse Error: Identifier "typo_var" not declared in the current scope.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MCP_LOAD_NULL 归入 headless_limitations 警告而非 errors(不触发 D1 回滚)', async () => {
    const dir = makeSymbolFixture();
    try {
      const { spawnGodot } = await import('../src/tools/spawn-helper.js');
      vi.mocked(spawnGodot).mockResolvedValueOnce(godotSpawnResult([
        'MCP_LOAD_NULL: res://scripts/main.gd',
        'MCP_VALIDATE_DONE',
      ]));
      const results = await batchValidateScripts('/usr/bin/godot', dir, [join(dir, 'scripts', 'main.gd')], 5000);
      const entry = results.find(r => r.file.includes('main.gd'));
      expect(entry).toBeTruthy();
      expect(entry.errors).toEqual([]);
      expect(entry.headless_limitations).toBeTruthy();
      expect(entry.headless_limitations.some(w => w.includes('load() returned null'))).toBe(true);
      expect(entry.headless_limitations.some(w => w.includes('编辑已保留'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── run_and_verify: spawnGodot path (V-01 fix → §4.7 裁决收窄) ──────────────

describe('run_and_verify: spawnGodot path (V-01 fix → §4.7)', () => {
  it('does NOT call ctx.setProjectDir (设计 §4.7: validate_scripts 不再切活跃指针)', async () => {
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    await handleTool('validation', args, ctx);
    expect(ctx.setProjectDir).not.toHaveBeenCalled();
  });

  it('run_and_verify 后真实活跃指针保持旧值 (§4.7 行为级: getProjectDir 不被切走)', async () => {
    const { resetState, setProjectDir: realSetProjectDir, getProjectDir } = await import('../src/core/process-state.js');
    resetState();
    realSetProjectDir('/proj/active');
    // ctx.setProjectDir 绑定真实实现(模拟 server 注入),防 mock 掩盖行为
    const ctx = makeCtx({ setProjectDir: vi.fn((d) => realSetProjectDir(d)) });
    await handleTool('validation', { action: 'run_and_verify', project_path: '/fake/other' }, ctx);
    expect(getProjectDir()).toBe('/proj/active');
    resetState();
  });

  it('returns analysis with timed out message when spawnGodot times out', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: 'some output\n',
      stderr: '',
      output: 'some output\n',
      exitCode: null,
      timedOut: true,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project', timeout: 5 };
    const result = await handleTool('validation', args, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toContain('timed out');
  });

  it('returns analysis with exit code message when spawnGodot exits non-zero', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: '',
      stderr: 'SCRIPT ERROR: something broke\n',
      output: 'SCRIPT ERROR: something broke\n',
      exitCode: 1,
      timedOut: false,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    const result = await handleTool('validation', args, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toContain('exited with code 1');
  });
});
