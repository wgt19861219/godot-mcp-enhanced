import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process and fs before importing the module under test.
// godot-finder uses execFile (promisified) and existsSync/readdirSync.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import {
  clearGodotPathCache,
  getCachedGodotPath,
  findGodot,
} from '../src/core/godot-finder.js';

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(existsSync);

beforeEach(() => {
  clearGodotPathCache();
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  existsSyncMock.mockReset();
});

// Helper: make execFile return successfully for a given stdout.
function mockExecFileSuccess(stdout) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    // Handle (cmd, args, cb) form and (cmd, args, opts, cb) form
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(null, { stdout, stderr: '' });
    return undefined;
  });
}

function mockExecFileError() {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(new Error('not found'), null);
    return undefined;
  });
}

// ─── clearGodotPathCache / getCachedGodotPath ────────────────────────────────

describe('clearGodotPathCache', () => {
  it('resets cache to null', async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    await findGodot();
    expect(getCachedGodotPath()).toBeTruthy();

    clearGodotPathCache();
    expect(getCachedGodotPath()).toBeNull();
  });
});

describe('getCachedGodotPath', () => {
  it('returns null initially', () => {
    expect(getCachedGodotPath()).toBeNull();
  });
});

// ─── findGodot ───────────────────────────────────────────────────────────────

describe('findGodot', () => {
  it('throws when no godot found anywhere', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('returns GODOT_PATH when valid', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/local/bin/godot4');
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot();
    expect(result).toBe('/usr/local/bin/godot4');
    expect(getCachedGodotPath()).toBe('/usr/local/bin/godot4');
  });

  it('skips GODOT_PATH when file does not exist', async () => {
    vi.stubEnv('GODOT_PATH', '/nonexistent/godot');
    // existsSync returns false for GODOT_PATH, true for nothing else needed
    existsSyncMock.mockReturnValue(false);
    // PATH godot also fails
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('skips GODOT_PATH when validation fails', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/bin/not-godot');
    existsSyncMock.mockReturnValue(true);
    // execFile returns something that is NOT a godot version
    mockExecFileSuccess('some-other-binary 1.0');

    // Will fall through to PATH search which also fails
    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('falls back to PATH godot', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);

    // execFile called with 'godot' succeeds
    mockExecFileSuccess('4.3.stable');

    const result = await findGodot();
    expect(result).toBe('godot');
    expect(getCachedGodotPath()).toBe('godot');
  });

  it('accepts godot --version output containing "Godot"', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('Godot Engine v4.2.1.stable.official');

    const result = await findGodot();
    expect(result).toBe('godot');
  });

  it('caches result and does not re-search on second call', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('4.3.stable');

    const first = await findGodot();
    expect(first).toBe('godot');

    // Reset mock to track second-call count
    execFileMock.mockClear();

    const second = await findGodot();
    expect(second).toBe('godot');

    // execFile should NOT have been called again (cache hit)
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
