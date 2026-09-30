// test/web-gui/html.test.ts
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
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
    expect(INDEX_HTML).toContain('naturalWidth');                  // onload 追加 W×H 尺寸显示(fix F-3,spec §6.4「显示尺寸与大小」)
  });
  it('音频预览:audio controls + 同 raw 通道', () => {
    expect(INDEX_HTML).toContain('au.controls = true');            // audio 控件行为码(锁真码,fix I-1:原 '<audio controls' 由注释桥接假绿)
    expect(INDEX_HTML).toContain("kind === 'audio'");
    expect(INDEX_HTML).toContain('au.onerror');                    // 加载失败占位行为码(fix F-2,对齐 img onerror 模式)
  });
  it('下载链接:raw 同 URL + download 属性 + 恢复列表入口', () => {
    expect(INDEX_HTML).toContain("download");                      // 下载属性
    expect(INDEX_HTML).toContain('preview-back');                  // 返回列表 data-action
  });

  // ── 资源管理批(Plan B Task 2,spec §6.4 hex)───────────────────────────────
  it('hex 视图:三列网格 + >4KB 截断提示 + 下载', () => {
    expect(INDEX_HTML).toContain("kind === 'hex'");
    expect(INDEX_HTML).toContain('renderHex');                     // 渲染函数
    expect(INDEX_HTML).toContain('仅前 4KB');                       // 截断提示
    expect(INDEX_HTML).toContain('toString(16)');                   // 偏移 hex 化
    expect(INDEX_HTML).toContain('!r.ok && r.status === 401');    // 401 哨兵对象行为码(fix 复审 round 2:锁先判状态的分支结构,非旧代码已有的字面量)
  });
  it('二进制路由:openFileEntry 其余分支走 hex', () => {
    expect(INDEX_HTML).toContain("openPreview(rel, 'hex')");       // 等价拼接形态:rel=sub+name(hex 端点契约 path 相对项目根),同 img/audio 分支
  });

  // ── 入口简化+自愈批(2026-09-16,用户确认):断线自动找活实例 + 友好死页 ──────
  it('自愈:recoverPanel 扫描端口段 + health 探测 + location.replace 迁移', () => {
    expect(INDEX_HTML).toContain('function recoverPanel');          // 自愈入口函数
    expect(INDEX_HTML).toContain('/api/health');                    // 无鉴权探测端点
    expect(INDEX_HTML).toContain('9550');                           // 端口段起点常量
    expect(INDEX_HTML).toContain('9569');                           // 端口段终点常量
    expect(INDEX_HTML).toContain('location.replace');               // 命中活实例整页迁移(cookie 随导航带)
  });
  it('自愈:持续失联触发 + 401 不再躺平 + 全死友好指引页', () => {
    expect(INDEX_HTML).toContain('lastOpenAt');                      // onopen 时间戳(持续失联判定)
    expect(INDEX_HTML).toContain('recoverPanel()');                  // onerror/401 路径都进自愈(非 stopped 躺平)
    expect(INDEX_HTML).toContain('面板服务已全部停止');                // 全死友好文案
    expect(INDEX_HTML).toContain('dashboard --web');                 // 指引命令
  });

  // ── 设置面板批(2026-09-29)───────────────────────────────────────────────────
  it('设置 tab 三态切换 + 进 tab 拉取视图', () => {
    expect(INDEX_HTML).toContain('tabSettings');                       // tab 按钮
    expect(INDEX_HTML).toContain("showTab('settings')");               // 绑定接线
    expect(INDEX_HTML).toContain("name === 'settings' ? 'flex' : 'none'");   // 三态 display
    expect(INDEX_HTML).toContain('settingsPane');                      // 面板容器
    expect(INDEX_HTML).toContain('loadSettings()');                    // 进 tab 即拉取
  });
  it('设置面板三端点接线 + 完整表单语义(空=清除)', () => {
    expect(INDEX_HTML).toContain("authFetch('/api/settings')");        // GET 视图
    expect(INDEX_HTML).toContain("fetch('/api/settings',");            // POST 保存
    expect(INDEX_HTML).toContain("fetch('/api/settings/verify'");      // POST 验证
    expect(INDEX_HTML).toContain('godotPath: godot');                  // 恒发两字段(完整表单)
    expect(INDEX_HTML).toContain('allowedProjectPaths: allowed');
  });
  it('设置面板:候选点选委托 + readOnly 403 判定 + 版本结果显示', () => {
    expect(INDEX_HTML).toContain("closest('button[data-cand]')");      // 候选容器委托(对齐 filesPane 模式)
    expect(INDEX_HTML).toContain("'read-only'");                       // 保存 403 判定(对齐 startSession I-2)
    expect(INDEX_HTML).toContain('setGodotResult');                    // 版本/错误结果显示位
    expect(INDEX_HTML).toContain('renderSettingsInfo');                // 只读生效值信息区
  });

  // ── 实例管理批(2026-09-30):左列第三区——实例列表 + 一键重启 ──────────────────
  it('实例区:section 结构 + 三段 flex(CSS) + 加载/空态', () => {
    expect(INDEX_HTML).toContain('id="instPane"');                      // 左列第三个 section
    expect(INDEX_HTML).toContain('id="instList"');                      // 列表容器(.scroll)
    expect(INDEX_HTML).toContain('#projPane { flex: 42 1 0; }');        // 三段 flex:42/33/25
    expect(INDEX_HTML).toContain('#sessionsPane { flex: 33 1 0; }');
    expect(INDEX_HTML).toContain('#instPane { flex: 25 1 0; }');
  });
  it('实例区:GET /api/instances 接线 + 渲染契约(早期实例/本实例标记/委托)', () => {
    expect(INDEX_HTML).toContain("authFetch('/api/instances')");       // 列表拉取
    expect(INDEX_HTML).toContain('function renderInstances');           // 渲染函数
    expect(INDEX_HTML).toContain('早期实例');                            // kind null(登记无字段)的显示文案;daemon 前端批起「早期」语义由类型列承载,版本缺显示 '-'
    expect(INDEX_HTML).toContain('·本实例');                            // current 标记
    expect(INDEX_HTML).toContain('data-action="inst-restart"');         // 重启按钮零监听器 + 数据属性
    expect(INDEX_HTML).toContain("closest('button[data-action=\"inst-restart\"]')");   // #instPane 容器委托(对齐 #sessions 模式)
  });
  it('实例区:重启 POST 接线 + confirm 语义诚实文案 + 轮询确认', () => {
    expect(INDEX_HTML).toContain("fetch('/api/instances/restart'");    // POST 重启
    expect(INDEX_HTML).toContain('window.confirm');                     // 二次确认
    expect(INDEX_HTML).toContain('客户端手动重连');                       // 不承诺自动恢复的诚实文案
    expect(INDEX_HTML).toContain('function pollInstancesGone');        // 2s×5 定向确认
    expect(INDEX_HTML).toContain('setInterval(loadInstances, 15000)');  // 15s 静默轮询
  });

  // ── daemon 前端批(2026-09-30 批 C):kind 徽标/会话占用/交接中/跨实例指引 ──────
  it('实例区:kind 徽标三态渲染(daemon/stdio/早期实例)+ 新「类型」列', () => {
    expect(INDEX_HTML).toContain("'类型'");   // 表头新列(kind + daemon 状态的承载列)
    // 三态链(锁行为码):daemon / stdio / 登记无 kind 字段的早期实例(对齐 version 先例)
    expect(INDEX_HTML).toContain("e.kind === 'daemon' ? 'daemon' : (e.kind === 'stdio' ? 'stdio' : '早期实例')");
  });
  it('实例区:daemon 会话占用状态(sessionActive 三值:占用中/空闲/数据不可得不显示)', () => {
    expect(INDEX_HTML).toContain('e.sessionActive === true');    // 仅 true/false 显式判定,undefined(注入缺席/他实例)不显示
    expect(INDEX_HTML).toContain('e.sessionActive === false');
    expect(INDEX_HTML).toContain('占用中');
    expect(INDEX_HTML).toContain('空闲');
  });
  it('实例区:交接中判定 = respawnOf 在场 且 指向的旧 pid 登记仍在 instances 数组(防永久残留误报)', () => {
    // 批 B 审查关键输入:respawnOf 交接完成后永久残留(指向已死 pid),只有旧 pid 登记
    // 仍在清单(数据源=本数组)才显示「交接中」;旧登记消失后是历史痕迹,不显示。
    expect(INDEX_HTML).toContain('e.respawnOf != null && state.instances.some');
    expect(INDEX_HTML).toContain('交接中');
  });
  it('实例区:跨实例指引(M-1)——他实例视角 daemon 行重启按钮替换为指引;自身实例保留按钮(T1 通道)', () => {
    expect(INDEX_HTML).toContain("e.kind === 'daemon' && !e.current");   // 他实例 + daemon 双条件
    expect(INDEX_HTML).toContain('在 daemon 面板或 CLI');                 // 指引文案
    expect(INDEX_HTML).toContain('daemon restart');                       // title 内完整 CLI 指引命令
  });
});

// ── 语法防回归(2026-09-30 面板死锁根因)────────────────────────────────────
// 设置批(2b9b4efa)曾在 INDEX_HTML 模板字符串内给 join/split 写了单反斜杠 n 分隔符,
// TS 模板求值把它变成真实换行写进内联脚本 → 字符串字面量裸断行 → 浏览器 SyntaxError
// → 整个脚本不执行,面板永远停在"连接中…"。CSP hash 对同一份损坏脚本求值,自洽放行;
// 子串契约测试也拦不住。vm.Script 编译(不执行)在 CI 即拦——比子串契约强一级。
describe('INDEX_HTML 内联脚本语法可解析(2026-09-30 死锁根因防回归)', () => {
  it('内联脚本经 vm.Script 编译通过(经典脚本语义,含 strict 指令)', () => {
    const m = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
    expect(m).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const body = m![1];
    expect(() => new vm.Script(body, { filename: 'index-inline.js' })).not.toThrow();
  });
  it('模板字符串转义陷阱定向定位:join/split 分隔符求值后须为字面反斜杠n', () => {
    // String.raw 消 TS 源转义歧义:断言 body 含 join(单引号+反斜杠n+单引号) 字面形态。
    // 若源码回归成模板内单写,求值结果变成真实换行,vm.Script 编译测试同步失败。
    const m = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const body = m![1];
    expect(body).toContain(String.raw`.join('\n')`);
    expect(body).toContain(String.raw`.split('\n')`);
    // 裸换行检测不另写正则("单引号+行尾"形态正常代码遍地必误报),vm.Script 编译是权威。
  });
});
