import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

// Mock fs before importing the module under test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

// Mock child_process to avoid actually spawning Godot
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock logger
vi.mock('../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock process-state: 仅 stub forceKillTree(godot-spawn 消费),其余导出透传真实模块
// (Task 3/设计 §7 I-4 统一策略,根治新增导出缺透传的漂移)
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/process-state.js')>();
  return { ...actual, forceKillTree: vi.fn() };
});

// Mock helpers (buildSafeEnv used in spawn options)
vi.mock('../src/helpers.js', () => ({
  buildSafeEnv: () => ({ PATH: '/usr/bin' }),
}));

import { needsImport, runImport, resetImportCache } from '../src/tools/import-check.js';
import { spawn } from 'child_process';

const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedSpawn = vi.mocked(spawn);

const TEST_PROJECT = 'D:/GitHub/mcp-e2e-platformer';

describe('import-check', () => {
  beforeEach(() => {
    resetImportCache();
    vi.clearAllMocks();
    // Default: env var not set
    delete process.env.GODOT_MCP_AUTO_IMPORT;
  });

  // ─── needsImport ──────────────────────────────────────────────────────────

  describe('needsImport', () => {
    it('returns true when .godot/imported does not exist', () => {
      mockedExistsSync.mockReturnValue(false);
      expect(needsImport(TEST_PROJECT)).toBe(true);
      // Should check for the imported directory
      expect(mockedExistsSync).toHaveBeenCalledWith(join(TEST_PROJECT, '.godot', 'imported'));
    });

    it('returns false when imported exists and no asset dirs', () => {
      // .godot/imported exists
      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) return true;
        // asset dirs don't exist
        return false;
      });

      expect(needsImport(TEST_PROJECT)).toBe(false);
    });

    it('returns false when imported exists and is fresh (newer than assets)', () => {
      const now = Date.now();
      // .godot/imported exists
      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) return true;
        if (typeof p === 'string' && p.endsWith('assets')) return true;
        return false;
      });

      // imported dir mtime is recent
      mockedStatSync.mockReturnValue({ mtimeMs: now } as ReturnType<typeof statSync>);

      // assets dir has a file with older mtime
      mockedReaddirSync.mockReturnValue([
        { name: 'sprite.png', isFile: () => true, isDirectory: () => false } as any,
      ] as ReturnType<typeof readdirSync>);

      // First call is for imported dir stat, second for file stat
      let statCallCount = 0;
      mockedStatSync.mockImplementation((p) => {
        statCallCount++;
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) {
          return { mtimeMs: now } as ReturnType<typeof statSync>;
        }
        // asset file is older
        return { mtimeMs: now - 10000 } as ReturnType<typeof statSync>;
      });

      expect(needsImport(TEST_PROJECT)).toBe(false);
    });

    it('returns true when imported exists but is stale (older than assets)', () => {
      const now = Date.now();
      // .godot/imported exists
      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string') {
          if (p.endsWith(join('.godot', 'imported'))) return true;
          if (p.endsWith('assets')) return true;
        }
        return false;
      });

      // imported dir is old, asset file is new
      mockedStatSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) {
          return { mtimeMs: now - 20000 } as ReturnType<typeof statSync>;
        }
        return { mtimeMs: now } as ReturnType<typeof statSync>;
      });

      mockedReaddirSync.mockReturnValue([
        { name: 'sprite.png', isFile: () => true, isDirectory: () => false } as any,
      ] as ReturnType<typeof readdirSync>);

      expect(needsImport(TEST_PROJECT)).toBe(true);
    });

    it('uses cache — returns false on second call with same project', () => {
      // Setup: imported exists, no assets
      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) return true;
        return false;
      });

      // First call
      expect(needsImport(TEST_PROJECT)).toBe(false);
      const firstCallCount = mockedExistsSync.mock.calls.length;

      // Second call should use cache — no new scanning needed
      // (existsSync will still be called for .godot/imported)
      expect(needsImport(TEST_PROJECT)).toBe(false);
    });

    it('detects new files added during session', () => {
      const now = Date.now();
      let assetMtime = now - 10000;

      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string') {
          if (p.endsWith(join('.godot', 'imported'))) return true;
          if (p.endsWith('assets')) return true;
        }
        return false;
      });

      mockedStatSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith(join('.godot', 'imported'))) {
          return { mtimeMs: now } as ReturnType<typeof statSync>;
        }
        return { mtimeMs: assetMtime } as ReturnType<typeof statSync>;
      });

      mockedReaddirSync.mockReturnValue([
        { name: 'sprite.png', isFile: () => true, isDirectory: () => false } as any,
      ] as ReturnType<typeof readdirSync>);

      // First call — no import needed
      expect(needsImport(TEST_PROJECT)).toBe(false);

      // Simulate a new file being added (newer mtime)
      assetMtime = now + 5000;

      // Second call — should detect the new file
      expect(needsImport(TEST_PROJECT)).toBe(true);
    });

    it('respects GODOT_MCP_AUTO_IMPORT=false', () => {
      process.env.GODOT_MCP_AUTO_IMPORT = 'false';
      // Even with no imported dir, should return false
      mockedExistsSync.mockReturnValue(false);
      expect(needsImport(TEST_PROJECT)).toBe(false);
    });
  });

  // ─── runImport ────────────────────────────────────────────────────────────

  describe('runImport', () => {
    it('resolves on successful import (exit code 0)', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        killed: false,
        pid: 12345,
      };

      // Simulate the process closing with code 0
      mockedSpawn.mockReturnValue(mockProc as any);

      // Capture the 'close' handler
      mockProc.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'close') {
          // Simulate async close with code 0
          setTimeout(() => handler(0), 10);
        }
      });

      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);

      await expect(
        runImport(TEST_PROJECT, '/path/to/godot', 5000),
      ).resolves.toBeUndefined();
    });

    it('rejects on non-zero exit code', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        killed: false,
        pid: 12346,
      };

      mockedSpawn.mockReturnValue(mockProc as any);

      mockProc.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'close') {
          setTimeout(() => handler(1), 10);
        }
      });

      mockProc.stdout.on.mockImplementation((_event: string, handler: Function) => {
        // no output
      });

      mockProc.stderr.on.mockImplementation((_event: string, handler: Function) => {
        // no output
      });

      await expect(
        runImport(TEST_PROJECT, '/path/to/godot', 5000),
      ).rejects.toThrow('exited with code 1');
    });

    it('rejects on spawn error', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        killed: false,
        pid: 12347,
      };

      mockedSpawn.mockReturnValue(mockProc as any);

      mockProc.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('ENOENT: godot not found')), 10);
        }
      });

      await expect(
        runImport(TEST_PROJECT, '/bad/path/godot', 5000),
      ).rejects.toThrow('failed to spawn');
    });

    it('rejects on timeout and kills the process', async () => {
      const { forceKillTree } = await import('../src/core/process-state.js');
      const mockedKillTree = vi.mocked(forceKillTree);

      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        killed: false,
        pid: 12348,
      };

      mockedSpawn.mockReturnValue(mockProc as any);

      // Don't trigger any events — let it timeout
      mockProc.on.mockImplementation(() => {});
      mockProc.stdout.on.mockImplementation(() => {});
      mockProc.stderr.on.mockImplementation(() => {});

      await expect(
        runImport(TEST_PROJECT, '/path/to/godot', 100),
      ).rejects.toThrow('timed out');

      // Process tree should have been killed
      expect(mockedKillTree).toHaveBeenCalledWith(mockProc);
    });
  });
});
