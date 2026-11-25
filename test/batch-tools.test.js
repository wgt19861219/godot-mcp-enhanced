import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  handleTool,
} from '../src/tools/batch-tools.js';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('batch-tools getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });
  it('includes batch tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('batch');
  });
  it('batch tool has action enum with create_files, run_verify, diff_scenes', () => {
    const defs = getToolDefinitions();
    const batch = defs.find(d => d.name === 'batch');
    const actionEnum = batch.inputSchema.properties.action.enum;
    expect(actionEnum).toContain('create_files');
    expect(actionEnum).toContain('run_verify');
    expect(actionEnum).toContain('diff_scenes');
  });
  it('returns exactly 1 merged tool', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('batch');
  });
  it('each definition has name and inputSchema', () => {
    for (const def of getToolDefinitions()) {
      expect(def).toMatchObject({ name: expect.stringMatching(/\S/), inputSchema: expect.any(Object) });
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('batch-tools TOOL_META', () => {
  it('has entry for merged batch tool', () => {
    expect('batch' in TOOL_META).toBe(true);
  });
  it('batch is non-readonly and not long_running', () => {
    expect(TOOL_META.batch.readonly).toBe(false);
    expect(TOOL_META.batch.long_running).toBe(false);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('batch-tools handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, {});
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, {});
    expect(result).toBe(null);
  });

  it('batch create_files rejects empty files array', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
      files: [],
    }, {});
    expect(result?.content?.[0]?.text).toContain('error');
  });

  it('batch create_files rejects missing files', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
    }, {});
    expect(result?.content?.[0]?.text).toContain('error');
  });

  it('batch create_files rejects too many files (>50, H-06 OOM guard)', async () => {
    // G8（报告4 :100 guard 审计）: MAX_FILE_COUNT=50 OOM 防护拒绝路径——审计发现零覆盖，补测。
    // 断言绑定守卫专属错误文本（防假绿：neuter 守卫后此断言应红，delete-red 已验）。
    const files = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }));
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
      files,
    }, {});
    expect(result?.content?.[0]?.text).toContain('Too many files');
    expect(result.content[0].text).toContain('Maximum is 50');
  });

  it('batch create_files rejects oversized file (>1MB, H-06 OOM guard)', async () => {
    // G8: MAX_FILE_SIZE=1MB 单文件 OOM 防护拒绝路径——审计发现零覆盖，补测。
    const big = 'x'.repeat(1_000_001);
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
      files: [{ path: 'big.txt', content: big }],
    }, {});
    expect(result?.content?.[0]?.text).toContain('exceeds maximum size');
  });

  it('batch run_verify rejects empty scenes array', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'run_verify',
      scenes: [],
    }, { findGodot: async () => '/fake/godot' });
    expect(result?.content?.[0]?.text).toContain('error');
  });

  it('batch diff_scenes rejects non-existent scene files', async () => {
    const tmpDir = join(tmpdir(), `batch-test-diff-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const result = await handleTool('batch', {
        project_path: tmpDir,
        action: 'diff_scenes',
        scene_a: 'nonexistent_a.tscn',
        scene_b: 'nonexistent_b.tscn',
      }, {});
      expect(result?.content?.[0]?.text).toContain('not found');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── batch_create_files real file creation ────────────────────────────────────

describe('batch_create_files real file creation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `batch-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates files on disk', async () => {
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://test.txt', content: 'hello world' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failed).toBe(0);
    // Verify file actually exists
    expect(existsSync(join(tmpDir, 'test.txt'))).toBe(true);
  });

  it('creates multiple files', async () => {
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://a.txt', content: 'aaa' },
        { path: 'res://sub/b.txt', content: 'bbb' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(2);
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'sub', 'b.txt'))).toBe(true);
  });

  it('skips existing files without overwrite', async () => {
    // Pre-create a file
    writeFileSync(join(tmpDir, 'existing.txt'), 'old', 'utf-8');
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://existing.txt', content: 'new' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skipped).toBe(1);
    expect(parsed.created).toBe(0);
  });

  it('overwrites existing files with overwrite=true', async () => {
    writeFileSync(join(tmpDir, 'overwrite.txt'), 'old', 'utf-8');
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://overwrite.txt', content: 'new', overwrite: true },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(1);
    expect(parsed.skipped).toBe(0);
  });
});

// ─── runSingleVerify settled guard ────────────────────────────────────────────

describe('runSingleVerify settled guard', () => {
  let mockProc;
  let mockSpawn;
  let tmpDir;

  beforeEach(() => {
    vi.resetModules();
    mockProc = {
      killed: false,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    mockSpawn = vi.fn(() => mockProc);
    vi.doMock('child_process', () => ({ spawn: mockSpawn, exec: vi.fn(), execFile: vi.fn() }));

    // Create a temp dir with a fake scene file so existsSync passes
    tmpDir = join(tmpdir(), `batch-settled-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'test.tscn'), '[gd_scene]\n', 'utf-8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock('child_process');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('timeout fires first, then close is ignored (settled guard)', async () => {
    let closeHandler;
    mockProc.on.mockImplementation((event, cb) => {
      if (event === 'close') closeHandler = cb;
    });

    // Dynamic import AFTER doMock so it uses the mock
    const mod = await import('../src/tools/batch-tools.js');
    const { handleTool: ht } = mod;

    const resultPromise = ht('batch', {
      project_path: tmpDir,
      action: 'run_verify',
      scenes: ['test.tscn'],
      timeout: 1,
    }, { findGodot: async () => '/fake/godot' });

    // Wait for timeout to fire (1s + margin)
    await new Promise(r => setTimeout(r, 1100));

    // Now fire close (simulating race condition — should be ignored by settled guard)
    if (closeHandler) closeHandler(0);

    const result = await resultPromise;
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.results)).toBe(true);
    // Should be timed_out (timeout won the race), not passed (close was ignored)
    const scene = parsed.results[0];
    expect(scene.status).toBe('timed_out');
  });

  it('close fires first, then error is ignored (settled guard)', async () => {
    let closeHandler, errorHandler;
    mockProc.on.mockImplementation((event, cb) => {
      if (event === 'close') closeHandler = cb;
      if (event === 'error') errorHandler = cb;
    });

    const mod = await import('../src/tools/batch-tools.js');
    const { handleTool: ht } = mod;

    const resultPromise = ht('batch', {
      project_path: tmpDir,
      action: 'run_verify',
      scenes: ['test.tscn'],
      timeout: 30,
    }, { findGodot: async () => '/fake/godot' });

    await new Promise(r => setTimeout(r, 20));

    // Fire close first (settles the promise)
    if (closeHandler) closeHandler(0);
    // Then fire error — should be ignored (settled = true)
    if (errorHandler) errorHandler(new Error('spawn ENOENT'));

    const result = await resultPromise;
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.results)).toBe(true);
    const scene = parsed.results[0];
    // Should be 'passed' from close, NOT 'error' from error handler
    expect(scene.status).toBe('passed');
  });

  it('timeout fires first, then error is also ignored', async () => {
    let errorHandler;
    mockProc.on.mockImplementation((event, cb) => {
      if (event === 'error') errorHandler = cb;
    });

    const mod = await import('../src/tools/batch-tools.js');
    const { handleTool: ht } = mod;

    const resultPromise = ht('batch', {
      project_path: tmpDir,
      action: 'run_verify',
      scenes: ['test.tscn'],
      timeout: 1,
    }, { findGodot: async () => '/fake/godot' });

    // Wait for timeout to fire (1s + margin)
    await new Promise(r => setTimeout(r, 1100));

    // Then fire error — should be ignored
    if (errorHandler) errorHandler(new Error('late error'));

    const result = await resultPromise;
    expect(result).toBeInstanceOf(Object);
    const parsed = JSON.parse(result.content[0].text);
    const scene = parsed.results[0];
    expect(scene.status).toBe('timed_out');
  });
});
