// test/web-gui/html.test.ts
import { describe, it, expect } from 'vitest';
import { INDEX_HTML } from '../../src/web-gui/html.js';

describe('INDEX_HTML 导出完整性(前端行为靠 Task 6/7 契约+真机验收)', () => {
  it('非空且含关键机制标记', () => {
    expect(INDEX_HTML.length).toBeGreaterThan(5000);
    expect(INDEX_HTML).toContain('EventSource');
    expect(INDEX_HTML).toContain('sessionStorage');
    expect(INDEX_HTML).toContain("history.replaceState");
    expect(INDEX_HTML).toContain('textContent');   // XSS 防护:动态内容不走 innerHTML
  });
  it('不含硬编码 token 或外链资源(零依赖单文件)', () => {
    expect(INDEX_HTML).not.toMatch(/token\s*[:=]\s*['"][0-9a-f]{16,}/i);
    expect(INDEX_HTML).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i);
  });
});
