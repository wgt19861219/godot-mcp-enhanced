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

  // ── Fix round 1(I-1/I-2)──────────────────────────────────────────────────
  it('sessions 帧联动刷新项目 running 徽章(spec §7.3:覆盖 AI 侧启动的会话)', () => {
    expect(INDEX_HTML).toContain('function refreshRunningBadges');          // 对照函数存在
    expect(INDEX_HTML).toContain('renderSessions(); refreshRunningBadges()'); // sessions 处理器接线
    expect(INDEX_HTML).toContain('state.projects === null) return;');       // 未配置跳过
  });
  it('start 403 文案区分 readOnly 与白名单外(I-2)', () => {
    expect(INDEX_HTML).toContain("'read-only'");                  // 响应体判定依据
    expect(INDEX_HTML).toContain('只读模式，面板启动已禁用');      // readOnly 403 文案
    expect(INDEX_HTML).toContain('路径在白名单之外');              // 其余 403 仍是白名单文案
  });

  // ── F-1 follow-up(2026-09-15 项目面板批审查)──────────────────────────────
  it('扫描失败兜底事件识别:失败不误显"扫描完成"', () => {
    expect(INDEX_HTML).toContain('p.failed');   // 兜底事件 {scanning:false, failed:true} 的判定
    expect(INDEX_HTML).toContain('扫描失败');    // 失败文案(区分于"扫描完成")
  });

  // ── 资源管理批(Plan A Task 4,spec §6.1/§6.2)──────────────────────────────
  it('文件 tab 与项目行「文件」按钮(中列主区,spec M-10)', () => {
    expect(INDEX_HTML).toContain("showTab");                    // tab 切换函数
    expect(INDEX_HTML).toContain("'files'");                    // tab 名
    expect(INDEX_HTML).toContain("data-action");                // 委托覆盖 files action
    expect(INDEX_HTML).toContain('filesPane');                  // 文件视图容器
    expect(INDEX_HTML).toContain("action === 'files'");         // 项目行「文件」按钮分发
  });
  it('文件列表:fmtSize 新写+面包屑+目录先排序渲染+隐藏目录由 server 过滤(前端不重复)', () => {
    expect(INDEX_HTML).toContain('function fmtSize');           // 新写(M-11)
    expect(INDEX_HTML).not.toContain("fmtSize 复用");
    expect(INDEX_HTML).toContain('breadcrumb');                 // 面包屑导航
    expect(INDEX_HTML).toContain('/api/projects/files');        // 列目录端点
    expect(INDEX_HTML).toContain('isDir');                      // 目录/文件行区分
  });
  it('文件 tab 请求拼 token(JS 变量,M-9):fetch 对 files 端点带鉴权', () => {
    expect(INDEX_HTML).toContain("'x-gui-token'");              // 现有请求头模式延续到 files 端点
  });

  // ── 资源管理批(Plan A Task 5,spec §6.3)──────────────────────────────────
  it('CM 动态加载:createElement script + src 拼 JS 变量 token(M-9)+只加载一次', () => {
    expect(INDEX_HTML).toContain("createElement('script')");
    expect(INDEX_HTML).toContain("'/assets/codemirror.js?token=' + token");   // 变量拼接,非字符串字面量
    expect(INDEX_HTML).toContain('cmLoaded');                                 // 一次加载标志
    expect(INDEX_HTML).toContain("'/assets/codemirror.css?token=' + token");  // css 同通道
  });
  it('mode 路由:gd→python 近似/json→javascript/md→markdown/其余 plain', () => {
    expect(INDEX_HTML).toContain("modeForFile");                              // 路由函数
    expect(INDEX_HTML).toContain("'python'");
    expect(INDEX_HTML).toContain("'javascript'");
    expect(INDEX_HTML).toContain("'markdown'");
  });
  it('保存三重护栏 UI:baseMtime 随请求/409 latest 消费/脏标 confirm', () => {
    expect(INDEX_HTML).toContain('baseMtime');
    expect(INDEX_HTML).toContain('latest');                                   // 409 响应体消费
    expect(INDEX_HTML).toContain('文件已被外部修改');                          // 冲突文案(spec §3.3-2)
    expect(INDEX_HTML).toContain('dirty');                                    // 脏标
  });
  it('readOnly:编辑器只读+保存隐藏', () => {
    expect(INDEX_HTML).toContain("setOption('readOnly'");
    expect(INDEX_HTML).toContain('只读模式');                                  // 横幅文案
  });
  it('mode 资产与下载链接(预览占位由 Plan B 替换)', () => {
    expect(INDEX_HTML).toContain('mode-python.js');
    expect(INDEX_HTML).toContain('mode-javascript.js');
    expect(INDEX_HTML).toContain('mode-markdown.js');
  });

  // ── 资源管理批(Plan B Task 1,spec §6.4)────────────────────────────────────
  it('图片预览:img 标签 + raw URL 拼 JS 变量 token + 尺寸/大小显示', () => {
    expect(INDEX_HTML).toContain("mode=raw&token=' + token");     // src 变量拼接(M-9)
    expect(INDEX_HTML).toContain('openPreview');                   // 预览视图函数
    expect(INDEX_HTML).toContain("kind === 'img'");                // img 分支
  });
  it('音频预览:audio controls + 同 raw 通道', () => {
    expect(INDEX_HTML).toContain('<audio controls');               // audio 元素(静态壳内)
    expect(INDEX_HTML).toContain("kind === 'audio'");
  });
  it('下载链接:raw 同 URL + download 属性 + 恢复列表入口', () => {
    expect(INDEX_HTML).toContain("download");                      // 下载属性
    expect(INDEX_HTML).toContain('preview-back');                  // 返回列表 data-action
  });
});
