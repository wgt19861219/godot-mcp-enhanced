import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('instructions.md 内容契约', () => {
  const content = readFileSync(join(process.cwd(), 'src', 'instructions.md'), 'utf-8');

  it('含三层模式标记', () => {
    expect(content).toMatch(/headless/);
    expect(content).toMatch(/editor/);
    expect(content).toMatch(/bridge/);
  });

  it('含 5 条陷阱关键词', () => {
    expect(content).toMatch(/持久化/);              // T1 运行时
    expect(content).toMatch(/search_and_replace/);  // T2
    expect(content).toMatch(/BLANK_DETECTED/);      // T3
    expect(content).toMatch(/\/root\//);            // T4
    expect(content).toMatch(/PERSISTENT_SECRET/);   // T5
  });

  it('指向 manage_tools / godot_get_context', () => {
    expect(content).toMatch(/manage_tools/);
    expect(content).toMatch(/godot_get_context/);
  });

  it('含失败处理契约（批 A/A3: retryable 语义 + 语义表入口）', () => {
    expect(content).toMatch(/retryable/);
    expect(content).toMatch(/error-codes\.md/);
  });

  it('长度 < 2000 字符（精简速查卡防膨胀）', () => {
    expect(content.length).toBeLessThan(2000);
  });
});

import { readInstructions } from '../src/core/instructions.js';

describe('readInstructions', () => {
  it('默认路径返回非空字符串且含 headless 标记', () => {
    const result = readInstructions();
    expect(typeof result).toBe('string');
    expect(result).toMatch(/headless/);
  });

  it('默认路径返回值与 src/instructions.md 一致', () => {
    // 顶部已 import readFileSync/join（line 2-3），函数内 require 冗余且与 ESM 不一致（M3-T2）
    const direct = readFileSync(join(process.cwd(), 'src', 'instructions.md'), 'utf-8');
    expect(readInstructions()).toBe(direct);
  });

  it('filePath 指向不存在路径时返回 undefined 且不抛', () => {
    const result = readInstructions('/nonexistent/path/does-not-exist.md');
    expect(result).toBeUndefined();
  });
});
