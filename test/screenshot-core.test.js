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

// ─── H-1 (2026-10-22 审查第二轮): 运行前删除旧输出,堵陈旧截图假成功 ──────────
// 修复前:captureScreenshot 在校验 Godot 退出码之前仅凭 existsSync(outputPath) 返回
// success:true——Godot 本次失败/超时时,上一次的旧文件命中 existsSync 返回假成功。
// 修复:runScreenshot 首次调用前 unlinkSync 旧输出;本用例预置旧文件 + 无效 godotPath
// (进程必失败、不产出新文件),断言失败结果且旧文件不存活充当假证据。
describe('screenshot-core: H-1 stale output removal', () => {
  it('H-1: Godot 失败且存在旧截图文件时必须返回失败并删除旧文件', async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tmpProjDir = mkdtempSync(join(tmpdir(), 'ss-h1-'));
    try {
      const outputPath = join(tmpProjDir, 'screenshot.png');
      writeFileSync(outputPath, Buffer.from('stale-png-bytes'));
      const result = await captureScreenshot({
        godotPath: '/nonexistent/godot-binary',
        projectPath: tmpProjDir,
        outputPath,
      });
      expect(result.success).toBe(false);
      // H-1 核心:旧文件不得存活充当假证据(运行前已删且本次未产出)
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(tmpProjDir, { recursive: true, force: true });
    }
  });
});
