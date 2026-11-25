import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runInit } from '../../src/cli/init.js';

describe('init', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-init-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // 带重试:删除进行时目录里仍有(或又出现)目录项,rmSync 会报 ENOTEMPTY / EPERM——刚写完的
    // 文件可能被其它进程(杀软扫描、索引器)短暂占用。默认不重试,全量并发下偶发失败
    // (2026-11-25 全量实测 ENOTEMPTY);重试按 100/200/300/400/500ms 线性退避,合计 1.5s。
    rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('creates project directory with project.godot', async () => {
    const origCwd = process.cwd();
    process.chdir(testDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInit(['test-game']);
    consoleSpy.mockRestore();
    process.chdir(origCwd);

    const projectDir = join(testDir, 'test-game');
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'project.godot'))).toBe(true);

    const content = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(content).toContain('test-game');
    expect(existsSync(join(projectDir, 'scenes'))).toBe(true);
  });

  it('uses default name when no args', async () => {
    const origCwd = process.cwd();
    process.chdir(testDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInit([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    consoleSpy.mockRestore();
    process.chdir(origCwd);
    expect(existsSync(join(testDir, 'my-game', 'project.godot'))).toBe(true);
    // 易用性批3:非 TTY 无参时打印默认名提示且继续创建(不询问、不取消)
    expect(output).toContain('使用默认名 "my-game"');
  });

  it('exits with error if directory already exists', async () => {
    mkdirSync(join(testDir, 'existing'), { recursive: true });
    const origCwd = process.cwd();
    process.chdir(testDir);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runInit(['existing'])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    process.chdir(origCwd);
  });
});
