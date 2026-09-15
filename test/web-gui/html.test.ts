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
  it('会话控制按钮走 #sessions 容器事件委托(2026-09-15 修复 500ms 重绘吞点击)', () => {
    // 委托处理器存在:挂在重绘中从不被替换的 #sessions 容器上,识别 button[data-action]
    expect(INDEX_HTML).toContain("closest('button[data-action]')");
    // 按钮零监听器、只带数据属性:alive→stop / ended→remove + data-project(值=projectPath)
    expect(INDEX_HTML).toContain("'data-action'");
    expect(INDEX_HTML).toContain("alive ? 'stop' : 'remove'");
    expect(INDEX_HTML).toContain("'data-project'");
    // 旧逐按钮绑定(500ms 重绘吞 click 的载体)已删除
    expect(INDEX_HTML).not.toContain('btn.addEventListener');
  });

  // ── 项目面板批(Task 4,spec §7):上项目下会话左列改造 ────────────────────
  it('项目面板机制标记(委托/搜索/添加/确认文案)', () => {
    expect(INDEX_HTML).toContain("closest('button[data-action]')");   // 委托(项目区复用会话行委托模式)
    expect(INDEX_HTML).toContain('data-action');                       // run|edit|remove|scan|add
    expect(INDEX_HTML).toContain('projSearch');                        // 搜索框
    expect(INDEX_HTML).toContain('仅从列表移除');                       // confirm 文案
    expect(INDEX_HTML).toContain('项目功能未配置');                     // hello projects:null 空态
  });
  it('项目面板 data-action 值集与端点接线', () => {
    // 委托覆盖的 action 值:run|edit|remove|scan|add(+ 内联添加行确认)
    ["'run'", "'edit'", "'remove'", "'scan'", "'add'"].forEach(a => expect(INDEX_HTML).toContain(a));
    expect(INDEX_HTML).toContain('/api/projects/scan');
    expect(INDEX_HTML).toContain('/api/projects/add');
    expect(INDEX_HTML).toContain('/api/projects/remove');
    expect(INDEX_HTML).toContain('/api/sessions/start');
    expect(INDEX_HTML).toContain("es.addEventListener('projects'");    // SSE projects 事件
    expect(INDEX_HTML).toContain('payload.projects');                  // hello 分支 projects 字段消费
  });
  it('项目面板 Missing 态/相对时间/零 innerHTML', () => {
    expect(INDEX_HTML).toContain('路径不存在');      // missing 行 Run/Edit disabled 的 title
    expect(INDEX_HTML).toContain('fmtAgo');          // 相对时间函数
    expect(INDEX_HTML).toContain('分钟前');          // 相对时间文案
    expect(INDEX_HTML).not.toContain('innerHTML');   // 防注入铁律:动态内容全 textContent
  });
});
