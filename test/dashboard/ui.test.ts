import { describe, it, expect } from 'vitest';
import { visibleLen, truncW, padRight } from '../../src/dashboard/ui.js';
import { fg, bold, dim, reset, colorize } from '../../src/dashboard/themes.js';

// ─── 测试 themes 辅助函数 ─────────────────────────────────────────────────────

describe('themes ANSI helpers', () => {
  it('fg() 生成正确的 256 色前景序列', () => {
    expect(fg(196)).toBe('\x1b[38;5;196m');
    expect(fg(82)).toBe('\x1b[38;5;82m');
  });

  it('bold() 生成加粗序列', () => {
    expect(bold()).toBe('\x1b[1m');
  });

  it('dim() 生成暗淡序列', () => {
    expect(dim()).toBe('\x1b[2m');
  });

  it('reset() 生成重置序列', () => {
    expect(reset()).toBe('\x1b[0m');
  });

  it('colorize() 包裹文本并自动 reset', () => {
    const result = colorize('hello', 82);
    expect(result).toBe('\x1b[38;5;82mhello\x1b[0m');
  });

  it('colorize() 不改变 CJK 文本内容', () => {
    const result = colorize('测试CJK', 196);
    expect(result).toContain('测试CJK');
    expect(result).toContain('\x1b[38;5;196m');
    expect(result).toContain('\x1b[0m');
  });
});

// ─── 测试 visibleLen / truncW / padRight ────────────────────────────────────────
// 批4审查 Nit-3:改为测 ui.ts 导出的真身(原复制体测试锁不住源实现,源改测试不红)

describe('visibleLen', () => {
  it('纯 ASCII', () => {
    expect(visibleLen('hello')).toBe(5);
    expect(visibleLen('')).toBe(0);
  });

  it('CJK 双宽字符', () => {
    expect(visibleLen('中文')).toBe(4);
    expect(visibleLen('测试A')).toBe(5);
  });

  it('忽略 ANSI 转义', () => {
    expect(visibleLen('\x1b[38;5;82mhello\x1b[0m')).toBe(5);
  });

  it('ANSI + CJK 混合', () => {
    expect(visibleLen('\x1b[38;5;196m中文\x1b[0mtest')).toBe(8);
  });

  it('正确处理 surrogate pair', () => {
    expect(visibleLen('\u{1F600}')).toBe(2);
    expect(visibleLen('\u{1F600}abc')).toBe(5);
  });

  it('多个 emoji 不重复计算', () => {
    expect(visibleLen('\u{1F600}\u{1F601}')).toBe(4);
  });
});

describe('truncW', () => {
  it('短字符串不截断', () => {
    expect(truncW('hello', 10)).toBe('hello');
  });

  it('ASCII 截断', () => {
    // 'hello' = 5 列刚好等于 maxCols=5，' ' 触发截断 → 'hello~'
    expect(truncW('hello world', 5)).toBe('hello~');
    // maxCols=4 时 'hell' = 4 刚好等于，'o' 触发 → 'hell~'
    expect(truncW('hello world', 4)).toBe('hell~');
  });

  it('CJK 截断', () => {
    // '中文测' = 6 列刚好等于 maxCols=6，'试' 触发 → '中文测~'
    expect(truncW('中文测试文字', 6)).toBe('中文测~');
  });

  it('保留 ANSI 转义前缀', () => {
    const result = truncW('\x1b[38;5;82mhello world\x1b[0m', 5);
    expect(result).toContain('\x1b[38;5;82m');
    expect(result).toContain('~');
    // 'hello~' = 6 列
    expect(visibleLen(result)).toBe(6);
  });

  it('ANSI 不影响截断位置', () => {
    const result = truncW('\x1b[1m\x1b[38;5;196mABCDE\x1b[0m', 3);
    // 'ABC' = 3 列刚好等于 maxCols，'D' 触发
    expect(result).toBe('\x1b[1m\x1b[38;5;196mABC~');
  });

  it('CJK + ANSI 混合截断', () => {
    const result = truncW('\x1b[38;5;82m中文测试\x1b[0m', 4);
    // '中文' = 4 列刚好等于 maxCols，'测' 触发 → '中文~' = 2+2+1 = 5
    expect(visibleLen(result)).toBe(5);
  });

  it('恰好等于最大宽度时不截断', () => {
    expect(truncW('hello', 5)).toBe('hello');
    expect(truncW('中文', 4)).toBe('中文');
  });

  it('CJK 边界截断', () => {
    // '中' = 2 列，'文' = 2 列，2+2 > 3 → 截断 → '中~' = 2+1 = 3
    expect(truncW('中文', 3)).toBe('中~');
  });

  it('空字符串', () => {
    expect(truncW('', 10)).toBe('');
  });
});

describe('padRight', () => {
  it('短文本填充空格', () => {
    const result = padRight('hi', 5);
    expect(result).toBe('hi   ');
    expect(visibleLen(result)).toBe(5);
  });

  it('已满不填充', () => {
    expect(padRight('hello', 5)).toBe('hello');
  });

  it('含 ANSI 的填充', () => {
    const result = padRight(colorize('hi', 82), 5);
    expect(visibleLen(result)).toBe(5);
  });

  it('CJK 填充', () => {
    const result = padRight('中文', 6);
    expect(visibleLen(result)).toBe(6);
    expect(result.endsWith('  ')).toBe(true);
  });
});
