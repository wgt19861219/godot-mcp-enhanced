import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readEditorSecret, waitForEditorSecret } from '../build/core/editor-auth.js';

let tempDir = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'editor-auth-test-'));
});

afterEach(() => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    tempDir = null;
  }
});

function createSecretFile(projectPath, content) {
  const godotDir = join(projectPath, '.godot');
  mkdirSync(godotDir, { recursive: true });
  writeFileSync(join(godotDir, 'mcp_editor.key'), content, 'utf-8');
}

// ─── readEditorSecret ────────────────────────────────────────────────────────

describe('readEditorSecret', () => {
  it('returns null when file is missing', () => {
    const result = readEditorSecret(tempDir);
    expect(result).toBeNull();
  });

  it('returns content when file exists', () => {
    createSecretFile(tempDir, 'my-secret-key-123');
    const result = readEditorSecret(tempDir);
    expect(result).toBe('my-secret-key-123');
  });

  it('trims whitespace from content', () => {
    createSecretFile(tempDir, '  secret-with-spaces  \n');
    const result = readEditorSecret(tempDir);
    expect(result).toBe('secret-with-spaces');
  });

  it('returns trimmed content even with multiple lines', () => {
    createSecretFile(tempDir, '\n  key-abc  \n\n');
    const result = readEditorSecret(tempDir);
    expect(result).toBe('key-abc');
  });
});

// ─── waitForEditorSecret ─────────────────────────────────────────────────────

describe('waitForEditorSecret', () => {
  it('returns immediately if file already exists', async () => {
    createSecretFile(tempDir, 'instant-secret');
    const result = await waitForEditorSecret(tempDir, 1000);
    expect(result).toBe('instant-secret');
  });

  it('returns null on timeout when file never appears', async () => {
    const result = await waitForEditorSecret(tempDir, 200);
    expect(result).toBeNull();
  });

  it('picks up file that appears during wait', async () => {
    // Create the file after a short delay (within the timeout window)
    const projectPath = tempDir;
    setTimeout(() => {
      createSecretFile(projectPath, 'delayed-secret');
    }, 100);

    const result = await waitForEditorSecret(projectPath, 2000);
    expect(result).toBe('delayed-secret');
  });
});
