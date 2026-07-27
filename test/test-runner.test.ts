import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TOOL_NAMES,
  ACTIONS,
  getToolDefinitions,
  TOOL_META,
  handleTool,
} from '../src/tools/test-runner.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── TOOL_NAMES / ACTIONS / TOOL_META ───────────────────────────────────────

describe('test_runner TOOL_NAMES', () => {
  it('contains test_runner', () => {
    expect(TOOL_NAMES).toEqual(['test_runner']);
  });
});

describe('test_runner ACTIONS', () => {
  it('has 4 actions', () => {
    expect(ACTIONS).toEqual(['check_gut', 'list_suites', 'run', 'generate']);
  });
});

describe('test_runner getToolDefinitions', () => {
  it('returns 1 definition with action enum', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0]!.name).toBe('test_runner');
    expect(defs[0]!.inputSchema.properties.action.enum).toEqual([...ACTIONS]);
  });
});

describe('test_runner TOOL_META', () => {
  it('marks read actions as read, write actions as write', () => {
    const risks = TOOL_META.test_runner.actionRisks!;
    expect(risks.check_gut).toBe('read');
    expect(risks.list_suites).toBe('read');
    expect(risks.run).toBe('write');
    expect(risks.generate).toBe('write');
  });
});

// ─── handleTool routing ─────────────────────────────────────────────────────

describe('test_runner handleTool routing', () => {
  it('returns null for unknown tool name', async () => {
    expect(await handleTool('unknown', {}, fakeCtx)).toBe(null);
  });
  it('rejects missing action', async () => {
    const r = await handleTool('test_runner', { project_path: '/tmp' }, fakeCtx);
    expect(r!.content[0]!.text).toContain('action is required');
  });
});

// ─── check_gut ──────────────────────────────────────────────────────────────

describe('test_runner check_gut', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'test-runner-gut-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reports installed when addons/gut exists', async () => {
    mkdirSync(join(tmpDir, 'addons', 'gut'), { recursive: true });
    const r = await handleTool('test_runner', { project_path: tmpDir, action: 'check_gut' }, fakeCtx);
    const text = r!.content[0]!.text;
    expect(text).toContain('✓ installed');
    // 尾部 JSON 可解析
    const json = JSON.parse(text.split('---JSON---\n')[1]!);
    expect(json.installed).toBe(true);
  });

  it('reports not installed + install hint when addons/gut missing', async () => {
    const r = await handleTool('test_runner', { project_path: tmpDir, action: 'check_gut' }, fakeCtx);
    const text = r!.content[0]!.text;
    expect(text).toContain('✗ not found');
    expect(text).toContain('https://github.com/bitwes/Gut/releases');
    const json = JSON.parse(text.split('---JSON---\n')[1]!);
    expect(json.installed).toBe(false);
  });
});

// ─── list_suites ────────────────────────────────────────────────────────────

describe('test_runner list_suites', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'test-runner-list-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reports no test/ directory when absent', async () => {
    const r = await handleTool('test_runner', { project_path: tmpDir, action: 'list_suites' }, fakeCtx);
    expect(r!.content[0]!.text).toContain('No test/ directory');
  });

  it('lists test files with test_ function counts', async () => {
    mkdirSync(join(tmpDir, 'test'), { recursive: true });
    writeFileSync(join(tmpDir, 'test', 'test_player.gd'),
      'extends GutTest\n\nfunc test_health():\n\tpass\n\nfunc test_speed():\n\tpass\n');
    writeFileSync(join(tmpDir, 'test', 'not_a_test.gd'),
      'extends Node\n\nfunc do_something():\n\tpass\n');  // 无 test_ 函数，应被过滤

    const r = await handleTool('test_runner', { project_path: tmpDir, action: 'list_suites' }, fakeCtx);
    const text = r!.content[0]!.text;
    expect(text).toContain('1 test file');
    expect(text).toContain('test_player.gd');
    expect(text).toContain('test_health');
    expect(text).toContain('test_speed');
    expect(text).not.toContain('not_a_test.gd');
  });
});

// ─── generate ───────────────────────────────────────────────────────────────

describe('test_runner generate', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'test-runner-gen-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('rejects missing script_path', async () => {
    const r = await handleTool('test_runner', { project_path: tmpDir, action: 'generate' }, fakeCtx);
    expect(r!.content[0]!.text).toContain('script_path is required');
  });

  it('rejects non-existent script', async () => {
    const r = await handleTool('test_runner', {
      project_path: tmpDir, action: 'generate', script_path: 'scripts/missing.gd',
    }, fakeCtx);
    expect(r!.content[0]!.text).toContain('Script not found');
  });

  it('generates GUT test code and saves to test/scripts/', async () => {
    mkdirSync(join(tmpDir, 'scripts'), { recursive: true });
    writeFileSync(join(tmpDir, 'scripts', 'player.gd'),
      'class_name Player\nextends Node2D\n\nfunc get_health() -> int:\n\treturn 100\n\nfunc take_damage(amount: int) -> void:\n\tpass\n');

    const r = await handleTool('test_runner', {
      project_path: tmpDir, action: 'generate', script_path: 'scripts/player.gd',
    }, fakeCtx);
    const text = r!.content[0]!.text;
    expect(text).toContain('Generated GUT test');
    expect(text).toContain('get_health');
    expect(text).toContain('take_damage');
    expect(text).toContain('Saved to:');

    // 验证落盘
    const savedPath = join(tmpDir, 'test', 'scripts', 'test_player.gd');
    expect(existsSync(savedPath)).toBe(true);
    const saved = require('node:fs').readFileSync(savedPath, 'utf-8');
    expect(saved).toContain('extends GutTest');
    expect(saved).toContain('func before_each():');
    expect(saved).toContain('func test_get_health():');
    expect(saved).toContain('func test_take_damage():');
  });

  it('handles filename collision with _N suffix', async () => {
    mkdirSync(join(tmpDir, 'scripts'), { recursive: true });
    mkdirSync(join(tmpDir, 'test', 'scripts'), { recursive: true });
    writeFileSync(join(tmpDir, 'scripts', 'player.gd'),
      'class_name Player\nextends Node2D\n\nfunc foo() -> int:\n\treturn 1\n');
    writeFileSync(join(tmpDir, 'test', 'scripts', 'test_player.gd'),
      '# pre-existing\n');  // 占位，触发碰撞

    const r = await handleTool('test_runner', {
      project_path: tmpDir, action: 'generate', script_path: 'scripts/player.gd',
    }, fakeCtx);
    const text = r!.content[0]!.text;
    expect(text).toContain('test_player_1.gd');  // 碰撞自增
    expect(existsSync(join(tmpDir, 'test', 'scripts', 'test_player_1.gd'))).toBe(true);
  });
});

// ─── parseGutOutput（结构化解析，修复 runtime.ts 字符串数组 bug）─────────────

describe('parseGutOutput structuring（via run action 的 JSON 输出）', () => {
  // 注：run action 依赖 spawn，这里只验证 parseGutOutput 的逻辑通过 list_suites 间接不可达，
  // 改为验证 TOOL_META + 结构约定。run 的集成测试需真实 Godot，留 e2e。
  it('TOOL_META.actionRisks covers all ACTIONS', () => {
    const risks = TOOL_META.test_runner.actionRisks!;
    for (const a of ACTIONS) {
      expect(a in risks, `${a} missing from actionRisks`).toBe(true);
    }
  });
});
