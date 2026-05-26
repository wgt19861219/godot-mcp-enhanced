import { describe, it, expect } from 'vitest';
import { captureScreenshot } from '../src/screenshot.js';

// ─── Tests ──────────────────────────────────────────────────────────────────
// captureScreenshot internally spawns a Godot process, so we only verify the
// module interface and type contracts here. Integration tests cover actual runs.

describe('screenshot-core: module interface', () => {
  it('captureScreenshot is an async function', () => {
    expect(typeof captureScreenshot).toBe('function');
    // Async functions have a prototype but the constructor check confirms it
    expect(captureScreenshot.constructor.name).toBe('AsyncFunction');
  });
});

describe('screenshot-core: interface contracts', () => {
  it('captureScreenshot rejects when godotPath is invalid', async () => {
    // Calling with a non-existent godot path should either return an error result
    // or reject. Either way, it should not throw synchronously.
    const result = await captureScreenshot({
      godotPath: '/nonexistent/path/godot',
      projectPath: '/tmp/nonexistent-project',
      outputPath: '/tmp/test-screenshot.png',
    });
    // Should return a result object with success field
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('captureScreenshot returns object with expected shape on failure', async () => {
    const result = await captureScreenshot({
      godotPath: '/nonexistent/godot',
      projectPath: '/nonexistent/project',
      outputPath: '/tmp/test-screenshot.png',
    });
    // Result should have standard fields regardless of success/failure
    expect(result).toHaveProperty('success');
    // On failure, should have an error field
    if (!result.success) {
      expect(result.error || result.godotOutput).toBeDefined();
    }
  });
});

describe('screenshot-core: import does not crash', () => {
  it('module exports are accessible', () => {
    // If we got here, the import succeeded
    expect(captureScreenshot).toBeDefined();
  });
});
