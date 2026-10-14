// Web GUI 单文件前端(设计 §4):原生 JS + 内联 CSS,无构建链无外链。
// token 经 URL query 进入 → sessionStorage → replaceState 清 query(设计 §5.2);
// 动态内容一律 textContent(防日志内容 XSS);EventSource 断线原生重连,hello 即整体重置。
// i18n(2026-10-13 批):双语字典经 serializeI18nForInline() 以 JSON 内联(插值不经模板
// 转义);静态段中文为 zh 兜底 + data-i18n* 属性,en 时 JS 启动即替换;切换按钮 reload 重建。

import { createHash } from 'node:crypto';
import { serializeI18nForInline } from './i18n.js';

export const INDEX_HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>godot-mcp-enhanced 监控面板</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%231a1f26'/%3E%3Ctext x='16' y='23' font-size='19' font-family='monospace' font-weight='bold' fill='%2358a6ff' text-anchor='middle'%3EG%3C/text%3E%3C/svg%3E">
<style>
  :root { --bg:#111418; --panel:#1a1f26; --line:#2a313b; --fg:#d7dde5; --dim:#8b949e;
          --green:#3fb950; --blue:#58a6ff; --yellow:#d29922; --red:#f85149; --orange:#db6d28; --grey:#6e7681; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.5 "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 14px; font-weight: 600; }
  header .dim { color: var(--dim); font-size: 12px; }
  /* i18n(2026-10-13):语言切换按钮推 header 最右;文本由 JS 按 LANG 设置(EN/中文) */
  #langBtn { margin-left: auto; }
  #warn, #cfgWarn { display: none; background: #3d2e00; color: var(--yellow); padding: 4px 12px; font-size: 12px; }
  main { flex: 1; display: grid; grid-template-columns: 340px minmax(0,1fr) 420px; gap: 8px; padding: 8px; min-height: 0; }   /* minmax(0,1fr):grid 版 min-width:auto 陷阱修复(2026-10-08)——1fr 的 auto 最小值会被中列内容 min-content 撑死(窄视口实测 465px),整页横向溢出 */
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; min-height: 0; }
  section h2 { font-size: 12px; color: var(--dim); padding: 6px 10px; border-bottom: 1px solid var(--line); font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  .scroll { overflow-y: auto; flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); position: sticky; top: 0; background: var(--panel); }
  .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 11px; }
  .st-running { background:#0f2e17; color: var(--green); } .st-starting { background:#0c2d5e; color: var(--blue); }
  .st-stopping { background:#3a2c00; color: var(--yellow); } .st-exited_early { background:#4a1618; color: var(--red); }
  .st-errored { background:#43230d; color: var(--orange); } .st-exited { background:#23282f; color: var(--grey); }
  #logList { padding: 4px 0; }
  .log-line { padding: 0 10px; white-space: pre-wrap; word-break: break-all; font-family: Consolas, monospace; font-size: 12px; }
  .log-line.warn { color: var(--yellow); } .log-line.error { color: var(--red); }
  .log-line .t { color: var(--dim); margin-right: 6px; }
  .log-tools { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .log-tools input, .log-tools select { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
  .log-tools input { flex: 1; }
  #chart { display: flex; align-items: flex-end; gap: 2px; height: 90px; padding: 8px 10px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; position: relative; }
  .bar .calls { background: #2f4b6e; border-radius: 2px 2px 0 0; }
  .bar .errors { background: var(--red); border-radius: 0 0 2px 2px; }
  .empty { color: var(--dim); padding: 16px; text-align: center; }
  .ctl { background: var(--bg); color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 1px 8px; font: 11px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
  .ctl:hover { color: var(--fg); border-color: var(--dim); }
  .ctl.stop:hover { color: var(--red); border-color: var(--red); }
  .ctl:disabled { opacity: .4; cursor: default; }
  /* a11y(2026-10-01 NIT-4):DevTools「No label associated with a form field」只认
     label 元素关联(aria-label 不计),sr-only 供无自然文本标签的控件挂视觉隐藏 label */
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  /* 项目面板批(spec §7.1):左列上项目(~55%)下会话(~45%),三列外框不变
     实例管理批(2026-09-30):左列改三段——项目 42/会话 33/实例 25(原 55/45) */
  #left { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  #projPane { flex: 42 1 0; }
  #sessionsPane { flex: 33 1 0; }
  #instPane { flex: 25 1 0; }
  /* daemon 前端批(2026-09-30):实例类型列的弱化文本(daemon 空闲态/跨实例指引文案) */
  .inst-dim { color: var(--dim); font-size: 11px; }
  /* 布局优化批(2026-10-08):会话/实例由 6/5 列 nowrap 表格改紧凑行式——340px 窄列
     塞不下表格 min-content(实测横向溢出滚动条,操作按钮滚出视口);行式 flex+ellipsis
     天然自适应,操作按钮(停止/清理/重启)恒可见 */
  .sess-row, .inst-row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  /* 实例分类批(2026-10-08):分组标题行(本实例/daemon/stdio/早期实例),hover 出类型说明 */
  .inst-group { padding: 5px 10px 3px; color: var(--dim); font-size: 11px; border-bottom: 1px solid var(--line); cursor: help; }
  .sess-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-pid { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .sess-busy { color: var(--yellow); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 96px; }
  .inst-id { font-family: Consolas, monospace; font-size: 11px; white-space: nowrap; }
  .inst-id.dim2 { color: var(--dim); }
  .inst-badges { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; flex: 1; }
  .inst-act { color: var(--dim); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .proj-row { display: flex; align-items: center; gap: 5px; padding: 3px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .proj-row .ctl { padding: 1px 6px; }
  .proj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-time { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .dot { font-size: 10px; line-height: 1; }
  .dot.run { color: var(--green); }
  .dot.missing { color: var(--red); }
  #addRow { display: none; }   /* 内联添加行,+添加按钮显隐切换(JS 置 style.display='flex') */
  /* 资源管理批(spec §6.1,2026-09-15):中列 tab 条 + 文件浏览视图
     布局优化批(2026-10-08):tab 命中区加大(padding 4px→6px)+ hover 背景态;
     「设置」低频配置 tab 推最右(margin-left:auto),与查看型 tab(日志/文件/知识库)视觉分组 */
  .tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--dim);
         font: 12px "Segoe UI", system-ui, sans-serif; padding: 6px 12px; cursor: pointer; border-radius: 4px 4px 0 0; }
  .tab:hover { color: var(--fg); background: rgba(88,166,255,.08); }
  .tab.on { color: var(--fg); border-bottom-color: var(--blue); }
  .tab.on:hover { background: none; }
  #tabSettings { margin-left: auto; }
  /* 中列分割批(2026-10-08,用户反馈)+对调批:上半日志流常驻(52%)/下半工具统计·分钟
     时序(48%,原右列位移来——6 列统计表在宽中列舒展免横滚);文件/知识库/设置移右列 */
  #logsPane { flex: 52 1 0; min-height: 0; display: flex; flex-direction: column; }
  #bottomPane { flex: 48 1 0; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  #filesPane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #filesPane { overflow: hidden; }   /* 面包屑固定 + 列表区(.scroll)自滚 */
  .breadcrumb { display: flex; flex-wrap: wrap; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .crumb { color: var(--blue); cursor: pointer; }
  .crumb:hover { text-decoration: underline; }
  .breadcrumb .sep { color: var(--dim); padding: 0 2px; }
  .file-row { display: flex; align-items: center; gap: 8px; padding: 3px 10px; border-bottom: 1px solid var(--line); font-size: 12px; cursor: pointer; }
  .file-row:hover { background: var(--bg); }
  .f-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f-size, .f-time { color: var(--dim); font-size: 11px; white-space: nowrap; }
  /* 编辑视图(spec §6.3,2026-09-15):工具行复用 .log-tools;banner/conflict 默认隐藏 */
  .ed-banner { display: none; align-items: center; gap: 8px; padding: 4px 10px; background: #3a2c00; color: var(--yellow); font-size: 12px; }
  .ed-conflict { display: none; align-items: center; flex-wrap: wrap; gap: 8px; padding: 4px 10px; background: #4a1618; color: var(--red); font-size: 12px; }
  .ed-conflict .ctl { color: var(--fg); }
  .ed-host { flex: 1; min-height: 0; display: flex; }
  .ed-host textarea { flex: 1; resize: none; border: none; outline: none; background: var(--bg); color: var(--fg); padding: 8px; font: 12px/1.5 Consolas, monospace; }
  .CodeMirror { height: 100%; flex: 1; font: 12px/1.5 Consolas, monospace; }   /* CM 升级 .ed-host 后填满 */
  .ed-status { padding: 3px 10px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 预览视图(Plan B Task 1,spec §6.4):img 限幅防大图撑爆中列;音频控件留边;下载链接复用 .ctl 需去下划线 */
  #filesPane img { max-width: calc(100% - 20px); max-height: 60vh; margin: 8px 10px; border: 1px solid var(--line); }
  #filesPane audio { margin: 10px; width: calc(100% - 20px); }
  a.ctl { text-decoration: none; color: var(--dim); }
  /* hex 视图(Plan B Task 2,spec §6.4):等宽三列网格,滚动容器复用 .scroll(与日志区同款) */
  .hex-box { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .hex-title { padding: 3px 10px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hex-grid { font: 12px/1.5 Consolas, monospace; padding: 4px 0; }
  .hex-row { display: flex; white-space: pre; padding: 0 10px; }
  .hex-off { color: var(--dim); margin-right: 14px; }
  .hex-bytes { min-width: 47ch; }   /* 16 字节两位 hex+15 空格:末行不足 16 字节时 ASCII 列仍对齐(等宽字体下 ch 精确) */
  .hex-ascii { color: var(--dim); }
  /* 设置面板(2026-09-29 设置批):表单分区 + 候选点选 + 只读信息区 */
  #settingsPane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
  .set-section { padding: 8px 10px; border-bottom: 1px solid var(--line); }
  /* 2026-10-01 NIT-4:区块标题改 .set-lbl(span)——纯样式标题误用 label 元素会触发
     DevTools「A label isn't associated with a form field」issue;真字段标签仍用 label[for] */
  .set-section label, .set-section .set-lbl { display: block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
  .set-row { display: flex; gap: 6px; }
  .set-row input { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
  .set-hint { color: var(--dim); font-size: 11px; margin-top: 4px; }
  .set-result { font-size: 12px; margin-top: 4px; word-break: break-all; }
  .set-result.ok { color: var(--green); } .set-result.err { color: var(--red); }
  #setAllowed { width: 100%; min-height: 72px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; font: 12px/1.5 Consolas, monospace; resize: vertical; }
  .set-cand { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .set-info { color: var(--dim); font-size: 11px; line-height: 1.7; word-break: break-all; }
  .set-actions { padding: 8px 10px; display: flex; gap: 8px; align-items: center; }
  .set-actions .ctl { color: var(--fg); }
  /* 知识库联动批(2026-10-08):总览卡片 + 详情分节摘要 + 日志行 + 正文 pre */
  #kbPane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .kb-card { padding: 8px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .kb-card:hover { background: var(--bg); }
  .kb-head { display: flex; align-items: center; gap: 6px; font-size: 12px; min-width: 0; }
  .kb-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* count 可收缩+省略号(视觉验收 2026-10-08:nowrap 无 min-width:0 时 flex 项 min-width:auto
     撑破卡片 → 整列横向溢出丢字);stall/fresh 徽标固定不收缩 */
  .kb-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); font-size: 11px; }
  .kb-stall { flex-shrink: 0; color: var(--red); font-size: 11px; white-space: nowrap; }
  .kb-fresh { flex-shrink: 0; color: var(--green); font-size: 11px; }
  .kb-none { flex-shrink: 0; color: var(--dim); font-size: 11px; }
  .kb-meta { color: var(--dim); font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 布局优化批(2026-10-08):「最近日志」行承载日期+标题两个关键信息却整行 dim(视觉
     验收:扫读成本高);日期提亮一档作锚点,标题维持 dim */
  .kb-meta-date { color: #aab4c0; }
  .kb-sub { padding: 6px 10px; color: var(--dim); font-size: 11px; border-bottom: 1px solid var(--line); }
  .kb-section { padding: 2px 10px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-log-row { display: flex; gap: 8px; padding: 3px 10px; border-bottom: 1px solid var(--line); font-size: 12px; cursor: pointer; }
  .kb-log-row:hover { background: var(--bg); }
  .kb-log-date { flex-shrink: 0; color: var(--dim); white-space: nowrap; }
  .kb-log-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-log-status { flex-shrink: 0; color: var(--dim); font-size: 11px; white-space: nowrap; }
  .kb-log-body { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 8px 10px; font: 12px/1.6 Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  /* 会话输出视图(2026-10-08 输出查看批):非 tab 浮层视图,会话行 📋 触发——游戏进程
     stdout/stderr 只存 process-state 内存桶(面板日志流仅含 server 工具调用日志),
     本视图是查看进程报错的唯一面板入口 */
  #outPane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* 输出浮层打开态:隐藏上半日志(h2+logsPane)与下半切换区,outPane 独占中列 */
  #midPane.out-open > h2, #midPane.out-open > #logsPane, #midPane.out-open > #bottomPane { display: none; }
  #outRefresh { margin-left: auto; }
  .out-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; font: 12px/1.5 Consolas, monospace; }
  .out-line { padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
  /* Godot 报错行高亮:ERROR:/SCRIPT ERROR: 红、WARNING: 黄(与日志流 .log-line 同语义) */
  .out-line.err { color: var(--red); }
  .out-line.warn { color: var(--yellow); }
  /* 窄视口存量溢出修复(2026-10-08 知识库批验证时观测):右列 stats 表 th/td 全 nowrap,
     min-content 超过 420px 固定列时撑破 grid → 整页横向滚动;表格容器自己横滚,页面不破 */
  #statsScroller { overflow-x: auto; }
</style>
</head>
<body>
<header>
  <h1 data-i18n="header.title">godot-mcp-enhanced 监控面板</h1>
  <span class="dim" id="statusBar" data-i18n="status.connecting">连接中…</span>
  <span class="dim" id="connInfo"></span>
  <button type="button" class="ctl" id="langBtn" title="Language / 语言"></button>
</header>
<div id="warn"></div>
<!-- 首启预检提示(终验收 V1,spec §3.10 条款 3):hello.settingsConfigured=false 显示;
     与 #warn(断线黄条)同款样式、独立容器(互不抢位) -->
<div id="cfgWarn"></div>
<main>
  <div id="left">
    <!-- 易用性批5 (2026-09-19):面板虽名「监控」,但项目/会话/文件区含写操作
         (停止/清理/增删项目/保存文件),给操作后果一行预期,防误触
         布局优化批(2026-10-08):后果说明从 h2 行内文本挪 title(hover 显示)——
         长文案挤压 340px 窄列标题(实测「实例」标题被压竖排换行) -->
    <section id="projPane"><h2 data-i18n="proj.pane" data-i18n-title="proj.pane.title" title="增删/扫描影响 server 登记状态">项目</h2>
      <div class="log-tools"><label class="sr-only" for="projSearch" data-i18n="proj.search.label">搜索项目:名称/路径</label><input id="projSearch" data-i18n-aria-label="proj.search.label" data-i18n-placeholder="proj.search.ph" aria-label="搜索项目:名称/路径" placeholder="搜索:名称/路径"><button class="ctl" data-action="scan" data-i18n="proj.btn.scan">扫描</button><button class="ctl" data-action="add" data-i18n="proj.btn.add">+添加</button></div>
      <div class="log-tools" id="addRow"><label class="sr-only" for="addPath" data-i18n="proj.addpath.label">项目绝对路径(须在白名单内)</label><input id="addPath" data-i18n-aria-label="proj.addpath.label" data-i18n-placeholder="proj.addpath.label" aria-label="项目绝对路径(须在白名单内)" placeholder="项目绝对路径(须在白名单内)"><button class="ctl" data-action="add-confirm" data-i18n="proj.btn.addConfirm">确定</button></div>
      <div class="scroll" id="projList"><div class="empty" data-i18n="common.loading">加载中…</div></div></section>
    <section id="sessionsPane"><h2 data-i18n="sess.pane" data-i18n-title="sess.pane.title" title="「停止/清理」影响运行中的游戏进程">运行会话</h2><div class="scroll" id="sessions"><div class="empty" data-i18n="sess.empty">暂无会话</div></div></section>
    <!-- 实例管理批(2026-09-30):本机全部 MCP server 实例(=各 MCP 客户端会话拉起的
         godot-mcp-enhanced 进程),面板自身的宿主也在其中;「重启」用于让实例吃到新 build -->
    <section id="instPane"><h2 data-i18n="inst.pane" data-i18n-title="inst.pane.title" title="「重启」中断该实例的 MCP 会话,客户端重连拉起新进程">实例</h2><div class="scroll" id="instList"><div class="empty" data-i18n="common.loading">加载中…</div></div></section>
  </div>
  <!-- 中列分割批(2026-10-08,用户反馈):日志流是监控面板核心,不该与文件/知识库
       挤同一 tab 互抢——改为上下分割:上半日志流常驻(约 52%),下半放工具统计·分钟
       时序;文件/知识库/设置移右列(对调批:用户反馈"和工具统计换一个位置"——统计表
       6 列在宽中列舒展免横滚,查看型窄列表适合 420px 右列)。outPane 仍整体覆盖。 -->
  <section id="midPane"><h2><span data-i18n="logs.pane">日志流</span> <span class="dim" id="logCount"></span></h2>
    <div id="logsPane">
      <div class="log-tools"><label class="sr-only" for="logFilter" data-i18n="logs.filter.label">过滤日志:工具/模块/项目</label><input id="logFilter" data-i18n-aria-label="logs.filter.label" data-i18n-placeholder="logs.filter.ph" aria-label="过滤日志:工具/模块/项目" placeholder="过滤:工具/模块/项目"><label class="sr-only" for="logLevel" data-i18n="logs.level.label">日志级别</label><select id="logLevel" data-i18n-aria-label="logs.level.label" aria-label="日志级别"><option>ALL</option><option>INFO</option><option>WARN</option><option>ERROR</option></select></div>
      <div class="scroll" id="logList"></div>
    </div>
    <div id="bottomPane">
      <h2><span data-i18n="stats.pane">工具统计</span> <label class="sr-only" for="projSel" data-i18n="stats.projsel.label">工具统计项目筛选</label><select id="projSel" data-i18n-aria-label="stats.projsel.label" aria-label="工具统计项目筛选"><option value="" data-i18n="stats.all">全部</option></select></h2>
      <div class="scroll" id="statsScroller"><table id="statsTable"><thead><tr><th>tool</th><th>calls</th><th>err</th><th>avg</th><th>min</th><th>max</th></tr></thead><tbody></tbody></table></div>
      <h2 style="border-top:1px solid var(--line)" data-i18n="stats.timeline">分钟时序</h2><div id="chart"><div class="empty" style="flex:1" data-i18n="stats.waiting">等待数据…</div></div>
    </div>
    <!-- 会话输出视图(2026-10-08 输出查看批):非 tab 浮层,左列会话行 📋 触发 showOutput,
         打开时经 .out-open 隐藏上半日志+下半统计(整体覆盖中列);工具条按钮为静态 DOM
         直接绑定,返回走 closeOutput() 恢复分割布局 -->
    <div id="outPane" style="display:none">
      <div class="log-tools"><button type="button" class="ctl" id="outBack" data-i18n="out.back">← 返回</button><span class="dim" id="outTitle"></span><button type="button" class="ctl" id="outRefresh" data-i18n="out.refresh">⟳ 刷新</button></div>
      <div class="out-body" id="outBody"><div class="empty" data-i18n="common.loading">加载中…</div></div>
    </div></section>
  <!-- 右列(对调批 2026-10-08):原工具统计位移中列下半,本列改查看型切换区
       (文件/知识库/设置);tab 条即列头,查看型聚左配置靠右 -->
  <section id="rightPane">
    <div class="tabs"><button type="button" id="tabFiles" class="tab on" data-i18n="tab.files">文件</button><button type="button" id="tabKb" class="tab" data-i18n="tab.kb">知识库</button><button type="button" id="tabSettings" class="tab" data-i18n="tab.settings">设置</button></div>
    <div id="filesPane"><div class="empty" data-i18n="files.emptyHint">点击左侧项目行的「文件」按钮浏览项目目录</div></div>
    <!-- 设置面板(2026-09-29 设置批):静态 DOM,进 tab 时 GET /api/settings 填充;
         保存 = 完整表单语义(路径留空/白名单清空 = 清除该设置,恢复启动 env 快照) -->
    <div id="settingsPane" style="display:none">
      <div class="set-section">
        <label for="setGodotPath" data-i18n="set.godotpath.label">Godot 可执行路径</label>
        <div class="set-row"><input id="setGodotPath" aria-label="Godot 可执行路径" placeholder="D:\\godot\\Godot_v4.7.1-stable_win64.exe"><button type="button" class="ctl" id="setVerifyBtn" data-i18n="set.btn.verify">验证</button></div>
        <div class="set-result" id="setGodotResult"></div>
        <div class="set-cand" id="setCands"></div>
        <div class="set-hint" data-i18n="set.godotpath.hint">候选来自 ~/.godot-mcp/godot-paths.json(CLI install 登记),点击即填入并验证;「验证」会运行 --version 确认版本;留空 = 清除设置,恢复启动时配置。注:项目若配了 .godot/mcp-godot.json 等项目级 override,该项目仍优先用 override 的路径</div>
      </div>
      <div class="set-section">
        <label for="setAllowed" data-i18n="set.allowed.label">项目目录白名单(每行一个绝对路径)</label>
        <textarea id="setAllowed" data-i18n-aria-label="set.allowed.label" aria-label="项目目录白名单,每行一个绝对路径" placeholder="D:\\GitHub\\my-game&#10;D:\\Projects\\demo"></textarea>
        <div class="set-hint" data-i18n="set.allowed.hint">即 ALLOWED_PROJECT_PATHS,影响所有工具可访问的目录范围;清空 = 恢复启动时配置(deny-by-default 收缩到工作目录)</div>
      </div>
      <!-- 知识库联动批(2026-10-08):vault 根配置;独立保存(真机反馈修复:原与 Godot 表单
           共用「保存设置」——godotPath 校验失败(如白名单拒)会整体 400 把 vault 一起拖死
           不落盘,用户"设置了却没数据";解耦后互不拖累,留空 = 清除) -->
      <div class="set-section">
        <label for="setVaultPath" data-i18n="set.vault.label">知识库 vault 根目录(Obsidian)</label>
        <div class="set-row"><input id="setVaultPath" data-i18n-aria-label="set.vault.label" aria-label="知识库 vault 根目录" placeholder="D:\\workspace\\Obsidian"><button type="button" class="ctl" id="setVaultSave" data-i18n="set.btn.vaultSave">保存</button></div>
        <div class="set-result" id="setVaultResult"></div>
        <div class="set-hint" data-i18n="set.vault.hint">即 GODOT_MCP_VAULT_PATH,「知识库」tab 据此展示各项目的待办进度/开发日志/断流检测;留空 = 清除设置。只读联动,面板不写 vault;独立于上方 Godot 设置单独保存</div>
      </div>
      <div class="set-actions">
        <button type="button" class="ctl" id="setSave" data-i18n="set.btn.save">保存设置</button>
        <span class="set-hint" id="setSaveHint"></span>
      </div>
      <div class="set-section">
        <span class="set-lbl" data-i18n="set.info.label">当前生效(只读)</span>
        <div class="set-info" id="setInfo"></div>
      </div>
    </div>
    <!-- 知识库联动批(2026-10-08):三态视图(总览卡片/项目详情/日志正文)全部由 JS 渲染进
         本容器,工具行按钮零监听器、只带 data-action,由 #kbPane 容器一次性委托接管
         对调批(2026-10-08):随文件/设置同列右列切换区,默认隐藏(files 默认 on) -->
    <div id="kbPane" style="display:none"><div class="empty" data-i18n="common.loading">加载中…</div></div>
  </section>
</main>
<script>
(function () {
  'use strict';
  // ── i18n 基础设施(2026-10-13 批)─────────────────────────────────────────
  // 字典由构建侧 JSON 内联(不经模板转义);LANG 检测:localStorage(手动切换持久化)
  // > navigator.language(zh* → zh,其余 en)> 默认 zh。t() 缺 key 回落 zh 再回落
  // key 本身(漏译可见但不破布局)。静态 HTML 段中文即 zh 字典镜像 + noscript 兜底,
  // en 时 applyStaticI18n 按 data-i18n / -title / -placeholder / -aria-label 替换。
  var I18N = ${serializeI18nForInline()};
  var LANG = (function () {
    var saved = null;
    try { saved = localStorage.getItem('gui-lang'); } catch (e) { /* 私有模式忽略 */ }
    if (saved === 'zh' || saved === 'en') return saved;
    return String(navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  })();
  function t(key, params) {
    var s = (I18N[LANG] && I18N[LANG][key]) || I18N.zh[key] || key;
    if (params) { for (var k in params) s = s.split('{' + k + '}').join(String(params[k])); }
    return s;
  }
  function applyStaticI18n() {
    if (LANG !== 'en') return;
    document.title = t('header.title');
    document.documentElement.lang = 'en';
    var els = document.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var k = el.getAttribute('data-i18n'); if (k) el.textContent = t(k);
      k = el.getAttribute('data-i18n-title'); if (k) el.title = t(k);
      k = el.getAttribute('data-i18n-placeholder'); if (k) el.placeholder = t(k);
      k = el.getAttribute('data-i18n-aria-label'); if (k) el.setAttribute('aria-label', t(k));
    }
  }
  applyStaticI18n();
  var qs = new URLSearchParams(location.search);
  // 2B (2026-09-19 安全加固批2): 补 hash 通道(#token=)——portal 入口页改用 hash 传递,
  // token 不进 query(服务器访问日志/Referer 不含);面板读 hash 握手 cookie 后 replaceState
  // 连 hash 一并清除(session/history 最终为干净 URL)。query 通道保留(CLI 打开旧链兼容)。
  var hm = /[#&]token=([^&]+)/.exec(location.hash);
  var hashToken = hm ? decodeURIComponent(hm[1]) : '';
  var token = qs.get('token') || hashToken || sessionStorage.getItem('gui-token') || '';
  if (token) { sessionStorage.setItem('gui-token', token); history.replaceState(null, '', location.pathname); }
  // cookie 双通道握手:用手头 token 换 HttpOnly cookie,此后请求 cookie 自动携带——
  // 免疫 URL query 被隐私扩展剥除/截断(query 丢失导致面板全断的真机事件)。
  // 失败不阻塞:query 通道兜底,哪个通用哪个;响应体无需处理。
  if (token) { fetch('/api/auth?token=' + encodeURIComponent(token)).catch(function () { /* 握手失败不阻塞:query 通道兜底 */ }); }
  var $ = function (id) { return document.getElementById(id); };
  var state = { logs: [], stats: null, sessions: [], projects: null, dedup: new Set(), readOnly: false, instances: [], mePid: 0 };
  var stopped = false;   // 401 凭据失效后停 SSE 死循环(M-2 语义,2026-09-16 保留)
  // 文件浏览状态(spec §6.1,Task 5 消费):当前项目/当前子目录/当前目录条目快照。
  var filesState = { project: null, sub: '', entries: [] };
  // 编辑视图状态(spec §6.3,Task 5):固定对象只改字段、从不重建——CM change 回调
  // 闭包引用须稳定;latest 为 409 冲突时的服务端最新版(Task 2 契约 {content,mtime})。
  // readOnly 信号源:hello 无此字段(不发明协议),复用现有 403 响应体 'read-only' 判定
  // (startSession I-2 先例 + 保存 POST 403 触发 enterReadOnly 置位)。
  var editorState = { rel: null, baseMtime: 0, dirty: false, cm: null, latest: null };
  // 预览视图状态(Plan B Task 1+2,spec §6.4):当前预览文件与类型
  // ('img'|'audio'|'hex');预览无脏标,无拦截语义,仅供状态记录。
  var previewState = { rel: null, kind: null };
  // 知识库联动状态(2026-10-08 批):overview 缓存(左列 📚 徽标复用,启动后台预取一次);
  // view 三态 list/detail/log;detail/log 为当前打开的 API 响应。
  var kbState = { loaded: false, view: 'list', overview: null, detail: null, log: null, logFile: '' };

  function authFetch(path) { return fetch(path, { headers: { 'X-GUI-Token': token } }); }

  // 后端消息语言跟随面板语言(审查 Nit-1):settings/files 的错误消息按请求
  // Accept-Language 双语——浏览器默认与界面语言同源,但手动切换(langBtn 写
  // localStorage)后两者可能分叉(浏览器 zh + 面板 en → 消息仍中文混排)。
  // 此处对全部 fetch 统一注入面板 LANG(SSE 的 EventSource 与 img/audio src
  // 不走 fetch,无语言诉求;同源请求无 CORS 顾虑)。
  var rawFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    init.headers = Object.assign({}, init.headers, { 'accept-language': LANG });
    return rawFetch(input, init);
  };

  function dedupKey(e) { return e.ts + '|' + (e.call_id || '') + '|' + (e.msg || '').slice(0, 40); }

  function pushLogs(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]; var k = dedupKey(e);
      if (state.dedup.has(k)) continue;
      state.dedup.add(k); state.logs.push(e);
    }
    if (state.logs.length > 500) { state.logs = state.logs.slice(-500); state.dedup = new Set(state.logs.map(dedupKey)); }
    renderLogs();
  }

  function resetAll(payload) {
    state.logs = []; state.dedup = new Set();
    if (payload.logs) pushLogs(payload.logs);
    if (payload.sessions) { state.sessions = payload.sessions; renderSessions(); }
    if (payload.stats) { state.stats = payload.stats; renderStats(); }
    if (payload.projects !== undefined) { state.projects = payload.projects; renderProjects(); }   // null → 未配置空态
    $('statusBar').textContent = t('status.connected');
    $('connInfo').textContent = payload.stats && payload.stats.mode ? ('mode: ' + payload.stats.mode) : '';
    // 首启预检(终验收 V1):仅显式 false 显示(旧实例 hello 无此字段 → undefined → 隐藏,向后兼容)
    updateCfgWarn(payload.settingsConfigured !== false);
  }

  // 首启预检提示黄条(终验收 V1,spec §3.10 条款 3):settings.json 与 env 均无 Godot
  // 路径/白名单 → 显著提示。刷新入口两处:hello(连接/重连)与 loadSettings(保存成功
  // 后按 effective 刷新——保存即热生效,提示即隐;清空保存则重现)。
  function updateCfgWarn(ok) {
    var w = $('cfgWarn');
    w.style.display = ok ? 'none' : 'block';
    w.textContent = ok ? '' : t('warn.cfg');
  }

  // 面板控制(2026-09-14):alive 态(starting/running/stopping)→「停止」;
  // ended 态(exited/exited_early/errored)→「清理」。
  // 2026-09-15 真机 bug 修复:SSE sessions 帧每 500ms 触发 renderSessions 全量
  // 重建表格 DOM,按下按钮的瞬间(mousedown→mouseup 间隙)按钮 DOM 被替换,逐按钮
  // addEventListener 的 click 随旧 DOM 丢弃。改为按钮零监听器、只携带 data-action /
  // data-project 数据属性,点击由 #sessions 容器的一次性委托处理器接管(见初始化区
  // 委托注册——容器本体在重绘中从不被替换,只有内部被清空重建,委托永续)。
  var ALIVE_STATUS = { starting: 1, running: 1, stopping: 1 };

  function sessionControl(s) {
    var alive = ALIVE_STATUS[s.status] === 1;
    var btn = document.createElement('button');
    btn.className = 'ctl' + (alive ? ' stop' : '');
    btn.textContent = alive ? t('sess.btn.stop') : t('sess.btn.clean');
    btn.setAttribute('data-action', alive ? 'stop' : 'remove');
    btn.setAttribute('data-project', s.projectPath);
    return btn;
  }

  function renderSessions() {
    var host = $('sessions'); host.textContent = '';
    if (!state.sessions.length) { var d = document.createElement('div'); d.className = 'empty'; d.textContent = t('sess.empty'); host.appendChild(d); return; }
    // 布局优化批(2026-10-08):6 列 nowrap 表格 → 紧凑行式(flex+ellipsis)——340px 窄列
    // 塞不下表格 min-content(操作列滚出视口);次要信息(pid/busy/输出行数)全路径进 title。
    // 按钮零监听器/委托模式不变(见上方注释)。
    var frag = document.createDocumentFragment();
    state.sessions.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'sess-row';
      row.title = t('sess.row.title', { path: s.displayPath || s.projectPath || '', pid: s.pid, lines: s.outputLines, busy: s.busy ? t('sess.busySuffix', { owner: s.busyOwner }) : '' });
      var name = document.createElement('span'); name.className = 'sess-name';
      name.textContent = (s.displayPath || s.projectPath || '').split(/[\\\\/]/).pop() || s.projectPath;
      var badge = document.createElement('span'); badge.className = 'badge st-' + s.status; badge.textContent = s.status;
      var pid = document.createElement('span'); pid.className = 'sess-pid'; pid.textContent = 'pid ' + s.pid;
      // 输出查看(2026-10-08 输出查看批):📋 打开 #outPane——运行中实时输出/已结束回查
      // 报错,读操作零监听器走 #sessions 委托 sess-output 分支
      var ob = document.createElement('button'); ob.className = 'ctl'; ob.type = 'button'; ob.textContent = '📋';
      ob.title = t('sess.output.tip');
      ob.setAttribute('data-action', 'sess-output'); ob.setAttribute('data-project', s.projectPath);
      row.append(name, badge, pid);
      if (s.busy) { var busy = document.createElement('span'); busy.className = 'sess-busy'; busy.textContent = '🔒 ' + s.busyOwner; busy.title = 'busy: ' + s.busyOwner; row.appendChild(busy); }
      row.append(ob, sessionControl(s));
      frag.appendChild(row);
    });
    host.appendChild(frag);
  }

  // ── 会话输出视图(2026-10-08 输出查看批)────────────────────────────────────
  // 契约:GET /api/sessions/output?project= → {status,running,lines[],total,truncated};
  // 404=桶不存在(从未运行/已清理)。ERROR:/SCRIPT ERROR: 行红色、WARNING: 行黄色
  // (Godot 报错格式,与日志流 .log-line 同语义)。运行为实时快照(⟳ 手动刷新拉最新)。
  var outState = { project: '' };

  function showOutput(project) {
    outState.project = project;
    // 中列分割批(2026-10-08):浮层经 .out-open 隐藏上半日志+下半切换区(CSS 一处管)
    document.getElementById('midPane').classList.add('out-open');
    $('outPane').style.display = 'flex';
    loadSessionOutput();
  }

  // 输出浮层收起:恢复分割布局(上半日志+下半当前 tab 原样,不动 tab 状态)
  function closeOutput() {
    document.getElementById('midPane').classList.remove('out-open');
    $('outPane').style.display = 'none';
  }

  function loadSessionOutput() {
    renderOutEmpty(t('common.loading'));
    authFetch('/api/sessions/output?project=' + encodeURIComponent(outState.project)).then(safeBody).then(function (r) {
      if (r.status === 404) { renderOutEmpty(t('out.empty404')); return; }
      if (!r.ok) { renderOutEmpty(t('out.readFail', { n: r.status })); return; }
      if (r.body) renderOutLines(r.body);
    }).catch(function () { renderOutEmpty(t('net.outRead')); });
  }

  function renderOutEmpty(msg) {
    var b = $('outBody'); b.textContent = '';
    var e = document.createElement('div'); e.className = 'empty'; e.textContent = msg;
    b.appendChild(e);
  }

  function renderOutLines(v) {
    $('outTitle').textContent = t('out.title', {
      state: v.running ? t('out.running') : t('out.ended'),
      status: v.status, n: v.lines.length,
      trunc: v.truncated ? t('out.truncSuffix', { n: v.lines.length, total: v.total }) : '',
    });
    var b = $('outBody'); b.textContent = '';
    if (!v.lines.length) {
      renderOutEmpty(v.running ? t('out.noOutputYet') : t('out.noOutputLast'));
      return;
    }
    var frag = document.createDocumentFragment();
    v.lines.forEach(function (l) {
      var d = document.createElement('div');
      d.className = 'out-line' + (/^\\s*(SCRIPT ERROR|ERROR)/.test(l) ? ' err' : (/^\\s*WARNING/.test(l) ? ' warn' : ''));
      d.textContent = l; frag.appendChild(d);
    });
    b.appendChild(frag); b.scrollTop = b.scrollHeight;
  }

  // ── 实例管理(2026-09-30)────────────────────────────────────────────────────
  // GET /api/instances → {me, instances:[{pid,port,startedAt,version,kind,respawnOf,
  // sessionActive?,current}]}。version/kind null = 早期实例(登记无对应字段,面板
  // 死锁修复前的 build)——用户判断哪个实例该重启的判据。daemon 前端批 C(2026-09-30):
  // kind 三态徽标 + daemon 会话占用(sessionActive 仅本实例行且注入在场才有,undefined
  // = 数据不可得不显示)+ 交接中标注 + 跨实例对 daemon 的重启指引。行按钮零监听器、
  // 只带 data-action + data-pid,#instPane 容器一次性委托(同 #sessions 模式);列表
  // 低频变化,15s 静默轮询 + 重启后定向确认。
  function loadInstances() {
    authFetch('/api/instances').then(safeBody).then(function (r) {
      if (!r.ok || !r.body) return;
      var v = r.body;
      state.mePid = v.me || 0;
      state.instances = Array.isArray(v.instances) ? v.instances : [];
      renderInstances();
    }).catch(function () { /* 静默轮询,失败下轮再试 */ });
  }

  function renderInstances() {
    var host = $('instList'); host.textContent = '';
    if (!state.instances.length) {
      var d = document.createElement('div'); d.className = 'empty'; d.textContent = t('inst.empty');
      host.appendChild(d); return;
    }
    // 实例分类批(2026-10-08):按类型分组渲染(本实例 → daemon → stdio → 早期实例)——
    // 用户反馈"都是早期实例分不清";类型徽标上移为组标题,行内保留 daemon 状态徽标
    // (占用中/交接中/空闲)+版本。根因同批修复:stdio 侧此前不写 kind 字段,新代码
    // 实例也被误标「早期实例」(GodotServer 现登记 kind='stdio')。
    // 按钮零监听器/委托模式不变(见上方注释);startedAt/交接中判定进 title。
    var handingOverOf = function (e) {
      return e.respawnOf != null && state.instances.some(function (o) { return o.pid === e.respawnOf; });
    };
    function instRow(e) {
      var handingOver = handingOverOf(e);
      var row = document.createElement('div'); row.className = 'inst-row';
      row.title = t('inst.started', { time: e.startedAt || '-', handover: handingOver ? t('inst.handoverSuffix', { pid: e.respawnOf }) : '' });
      var id = document.createElement('span'); id.className = 'inst-id';
      id.textContent = (e.current ? e.pid + t('inst.selfSuffix') : String(e.pid)) + ' ';
      var port = document.createElement('span'); port.className = 'inst-id dim2'; port.textContent = ':' + e.port;
      var badges = document.createElement('span'); badges.className = 'inst-badges';
      // daemon 专属状态标注(类型已由组标题承载):交接中优先于占用显示(交接窗口的
      // 会话占用意义有限)。sessionActive undefined(数据不可得)不显示。
      if (e.kind === 'daemon') {
        if (handingOver) {
          var hb = document.createElement('span'); hb.className = 'badge st-stopping'; hb.textContent = t('inst.handingOver');
          hb.title = t('inst.handingOverTip', { pid: e.respawnOf });
          badges.appendChild(hb);
        } else if (e.sessionActive === true) {
          var ab = document.createElement('span'); ab.className = 'badge st-running'; ab.textContent = t('inst.inUse');
          ab.title = t('inst.inUseTip');
          badges.appendChild(ab);
        } else if (e.sessionActive === false) {
          var fb = document.createElement('span'); fb.className = 'inst-dim'; fb.textContent = t('inst.idle');
          badges.appendChild(fb);
        }
      }
      var ver = e.version ? 'v' + e.version : '-';
      if (e.current) { var vb = document.createElement('span'); vb.className = 'badge st-running'; vb.textContent = ver; badges.appendChild(vb); }
      else { var vd = document.createElement('span'); vd.className = 'inst-dim'; vd.textContent = ver; badges.appendChild(vd); }
      // 跨实例指引(M-1,daemon 前端批 C):他实例视角对 daemon 的重启按钮换指引——
      // 跨实例 kill 会绕过受控关停链(误伤交接对端/丢登记);自身实例保留按钮(T1 通道)。
      if (e.kind === 'daemon' && !e.current) {
        var guide = document.createElement('span'); guide.className = 'inst-act';
        guide.textContent = t('inst.guideText');
        guide.title = t('inst.guideTip');
        row.append(id, port, badges, guide);
      } else {
        var btn = document.createElement('button');
        btn.className = 'ctl'; btn.textContent = t('inst.btn.restart');
        btn.setAttribute('data-action', 'inst-restart');
        btn.setAttribute('data-pid', String(e.pid));
        row.append(id, port, badges, btn);
      }
      return row;
    }
    var frag = document.createDocumentFragment();
    [
      { title: t('inst.group.self'), tip: t('inst.group.self.tip'), match: function (e) { return !!e.current; } },
      { title: 'daemon', tip: t('inst.group.daemon.tip'), match: function (e) { return e.kind === 'daemon' && !e.current; } },
      { title: 'stdio', tip: t('inst.group.stdio.tip'), match: function (e) { return e.kind === 'stdio' && !e.current; } },
      { title: t('inst.group.legacy'), tip: t('inst.group.legacy.tip'), match: function (e) { return e.kind !== 'daemon' && e.kind !== 'stdio' && !e.current; } },
    ].forEach(function (g) {
      var rows = state.instances.filter(g.match);
      if (!rows.length) return;
      var head = document.createElement('div'); head.className = 'inst-group'; head.textContent = g.title;
      head.title = g.tip;
      frag.appendChild(head);
      rows.forEach(function (e) { frag.appendChild(instRow(e)); });
    });
    host.appendChild(frag);
  }

  // 重启后定向确认:2s×5 轮詢目标 pid 是否退出(客户端重连拉起新进程是另一 pid,
  // 会以新行出现——statusBar 提示用户;新实例 version 即当前 build 的判据)。
  function pollInstancesGone(pid) {
    var n = 0;
    var t0 = setInterval(function () {
      n++;
      loadInstances();
      var gone = !state.instances.some(function (e) { return e.pid === pid; });
      if (gone || n >= 5) {
        clearInterval(t0);
        $('statusBar').textContent = gone
          ? t('inst.gone', { pid: pid })
          : t('inst.stillRunning', { pid: pid });
      }
    }, 2000);
  }

  // ── 项目面板(spec §7.2/§7.3,2026-09-15)────────────────────────────────────
  // ProjectView 契约(Task 3):{path,name,addedAt,source,mtime,missing,running,sessionId}
  // 行按钮零监听器、只带 data-action(reimport|run|edit|files|remove)+data-path,点击由 #projPane
  // 容器一次性委托接管(同 #sessions 2026-09-15 修复模式:容器本体在重绘中不被替换)。
  function fmtAgo(ms) {
    if (ms == null) return '-';
    var diff = Date.now() - ms; if (diff < 0) diff = 0;
    if (diff < 60000) return t('time.justNow');
    if (diff < 3600000) return t('time.minAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('time.hourAgo', { n: Math.floor(diff / 3600000) });
    var d = new Date(ms);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  // 字节数人性化(spec §6.2,M-11):日志面板无现成实现,此处新写。
  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function renderProjects() {
    var host = $('projList'); host.textContent = '';
    if (state.projects === null) {   // hello projects:null → 注入缺席(设计 v2/M6)
      var d = document.createElement('div'); d.className = 'empty'; d.textContent = t('proj.notConfigured');
      host.appendChild(d); return;
    }
    var q = $('projSearch').value.toLowerCase();
    var rows = state.projects.filter(function (p) {   // 名称/路径子串,不区分大小写
      if (!q) return true;
      return ((p.name || '') + (p.path || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = state.projects.length ? t('proj.noMatch') : t('proj.emptyHint');
      host.appendChild(e); return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (p) {
      var row = document.createElement('div'); row.className = 'proj-row';
      // ⟳ 重导入(资源重导入批 2026-10-08):引擎级扫描+重导入(--headless --import),
      // 异步起、完成经 SSE import 事件接管 statusBar。
      var imp = document.createElement('button'); imp.className = 'ctl'; imp.textContent = '⟳'; imp.title = t('proj.btn.reimport');
      imp.setAttribute('data-action', 'reimport'); imp.setAttribute('data-path', p.path);
      var run = document.createElement('button'); run.className = 'ctl'; run.textContent = '▶'; run.title = t('proj.btn.run');
      run.setAttribute('data-action', 'run'); run.setAttribute('data-path', p.path);
      var edit = document.createElement('button'); edit.className = 'ctl'; edit.textContent = '✎'; edit.title = t('proj.btn.edit');
      edit.setAttribute('data-action', 'edit'); edit.setAttribute('data-path', p.path);
      var files = document.createElement('button'); files.className = 'ctl'; files.textContent = t('proj.btn.files'); files.title = t('proj.btn.filesTip');
      files.setAttribute('data-action', 'files'); files.setAttribute('data-path', p.path);
      if (p.missing) { run.disabled = true; edit.disabled = true; files.disabled = true; imp.disabled = true; run.title = t('proj.missing'); edit.title = t('proj.missing'); files.title = t('proj.missing'); imp.title = t('proj.missing'); }
      else if (p.running) { imp.disabled = true; imp.title = t('proj.runningNoReimport'); }   // 409 前移为 UX(用户裁决 2026-10-08)
      var name = document.createElement('span'); name.className = 'proj-name';
      name.textContent = p.name || (p.path || '').split(/[\\\\/]/).pop() || p.path; name.title = p.path;   // title=完整路径
      var time = document.createElement('span'); time.className = 'proj-time'; time.textContent = fmtAgo(p.mtime);
      var badge = document.createElement('span');
      if (p.missing) { badge.className = 'dot missing'; badge.textContent = '●'; badge.title = t('proj.missing'); }
      else if (p.running) { badge.className = 'dot run'; badge.textContent = '●'; badge.title = t('common.running'); }
      var rm = document.createElement('button'); rm.className = 'ctl stop'; rm.textContent = '×'; rm.title = t('proj.btn.remove');
      rm.setAttribute('data-action', 'remove'); rm.setAttribute('data-path', p.path);
      // 知识库徽标(2026-10-08 批):repoPath 精确匹配(大小写不敏感)→ 📚,点击进知识库详情
      var kbc = findKbByPath(p.path);
      if (kbc) {
        var kbBtn = document.createElement('button'); kbBtn.className = 'ctl'; kbBtn.type = 'button'; kbBtn.textContent = '📚';
        kbBtn.title = t('proj.badgeKb', { log: kbc.lastLogDate ? t('proj.lastLog', { date: kbc.lastLogDate }) : t('proj.noLog') }) + (kbc.stall ? t('proj.stallMark') : '');
        kbBtn.setAttribute('data-action', 'kb'); kbBtn.setAttribute('data-kbname', kbc.name);
        row.append(imp, run, edit, files, kbBtn, name, time, badge, rm);
      } else {
        row.append(imp, run, edit, files, name, time, badge, rm);
      }
      frag.appendChild(row);
    });
    host.appendChild(frag);
  }

  // 行内 Run/Edit → POST /api/sessions/start(spec §4:mode 缺省 run;此处恒显式)
  function startSession(path, mode) {
    $('statusBar').textContent = t(mode === 'run' ? 'status.starting' : 'status.startingEditor', { path: path });
    fetch('/api/sessions/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ projectPath: path, mode: mode }),
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (txt) {
          // 403 双源区分(I-2):READ_ONLY 拦截响应体 {error:'read-only mode'},提示只读
          // 而非误导用户排查白名单;白名单外仍是原文案。Task 5:判定命中时同步置
          // state.readOnly——编辑视图打开即只读,免得用户编辑半天才在保存时被 403。
          // (i18n 批:回调参数 txt——全局 t() 是 i18n 函数,不可遮蔽)
          var msg;
          if (r.status === 403 && txt.indexOf('read-only') !== -1) { state.readOnly = true; msg = t('err.readonlyStart'); }
          else if (r.status === 403) msg = t('err.notAllowed');
          else msg = r.status === 404 ? t('err.notGodotProject') : txt.slice(0, 80);
          $('statusBar').textContent = t('status.startFail', { msg: msg });
        });
      }
      $('statusBar').textContent = mode === 'run' ? t('status.startSent') : t('status.editorLaunched');
    }).catch(function () { $('statusBar').textContent = t('net.start'); });
  }

  // ⟳ 重导入(资源重导入批 2026-10-08):POST /api/projects/reimport 异步起,
  // 完成经 SSE import 事件接管 statusBar(--import 无进度回调,只能报进行中/完成)。
  function reimportProject(path) {
    $('statusBar').textContent = t('status.importing', { path: path });
    fetch('/api/projects/reimport', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ projectPath: path }),
    }).then(safeBody).then(function (r) {   // safeBody 统一(2026-10-13 merge 适配):旧 !r.ok 分支手工 r.text 先行、成功路径 r.json() 空体仍 reject;401 原落 else 显示空文案
      var ts = r.body === null ? '' : JSON.stringify(r.body);
      if (!r.ok) {
        var msg;
        if (r.status === 401) msg = t('err.authExpired');
        else if (r.status === 403 && ts.indexOf('read-only') !== -1) { state.readOnly = true; msg = t('err.readonlyReimport'); }
        else if (r.status === 403) msg = t('err.notAllowed');
        else if (r.status === 404) msg = t('err.notGodotProject');
        else if (r.status === 409) msg = t('err.running409');
        else msg = ts.slice(0, 80);
        $('statusBar').textContent = t('status.reimportFail', { msg: msg });
        return;
      }
      if (r.body && r.body.started === false) { $('statusBar').textContent = t('status.alreadyImporting'); return; }
      $('statusBar').textContent = t('status.importSent');
    }).catch(function () { $('statusBar').textContent = t('net.reimport'); });
  }

  // 移除仅出清单不删文件;原生 confirm(CSP 不受限)
  function removeProject(path) {
    var name = (path || '').split(/[\\\\/]/).pop() || path;
    if (!confirm(t('proj.confirmRemove', { name: name }))) return;
    $('statusBar').textContent = t('status.removing', { name: name });
    fetch('/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ path: path }),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (txt) { $('statusBar').textContent = t('status.removeFail', { msg: txt.slice(0, 80) }); });
      $('statusBar').textContent = t('status.removed', { name: name });   // 列表本身由 SSE projects 快照刷新
    }).catch(function () { $('statusBar').textContent = t('net.remove'); });
  }

  // 响应体安全解析(2026-09-16 网络异常误报修复):server 鉴权失败只写状态码无响应体
  // (writeHead(401/403).end()),先 r.json() 必 parse('') reject 落 catch,把「鉴权失效」
  // 伪装成「网络异常,XX请求未送达」(真机反馈:扫描按钮 401 显示网络异常)。统一 text
  // 先行:空体/非 JSON → body:null,控制流落第二层 !r.ok 分支按 status 给准确文案;
  // 只有真网络层失败(连接拒绝/中断)才落 catch 的「网络异常」。
  // (i18n 批:回调参数 txt——不遮蔽全局 t())
  function safeBody(r) {
    return r.text().then(function (txt) {
      var j = null;
      try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
      return { ok: r.ok, status: r.status, body: j };
    });
  }

  // 扫描:异步起,立即返回;进度与结果由 SSE projects 事件接管(spec §4/§5)
  function startScan() {
    $('statusBar').textContent = t('status.scanning');
    fetch('/api/projects/scan', { method: 'POST', headers: { 'x-gui-token': token } })
      .then(safeBody)
      .then(function (r) {
        if (!r.ok) {
          $('statusBar').textContent = t('status.scanFail', { msg: r.status === 401 ? t('err.authExpired') : JSON.stringify(r.body).slice(0, 80) });
          return;
        }
        if (r.body && r.body.started === false) { $('statusBar').textContent = t('status.scanInProgress'); return; }   // §3.1.1 互斥
        $('statusBar').textContent = t('status.scanning');   // SSE 接管进度显示
      })
      .catch(function () { $('statusBar').textContent = t('net.scan'); });
  }

  // +添加:内联输入行显隐(spec §7.2,非弹窗)
  function toggleAddRow() {
    var row = $('addRow');
    row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
    if (row.style.display === 'flex') $('addPath').focus();
  }

  // sessions 帧对照 alive 会话刷新项目行 running 徽章(spec §7.3,Fix round 1/I-1)。
  // 覆盖 AI 侧 run_project 启动的会话——不经面板 start 端点、不触发 broadcastProjects
  // 快照推送,徽章只能经此路径变绿。匹配键与 store 同源:会话 projectPath 即归一化桶键
  // (resolve + win lowercase,projects-store.ts:182 同语义),项目行 path 对照时 lowercase。
  // 500ms 帧频率取舍:仅行 running 态实际变化时才重渲染,帧到达但不变不重绘。
  function refreshRunningBadges() {
    if (state.projects === null) return;   // 项目功能未配置(hello projects:null)跳过
    var alive = {};
    state.sessions.forEach(function (s) {
      if (ALIVE_STATUS[s.status] === 1) alive[(s.projectPath || '').toLowerCase()] = 1;
    });
    var changed = false;
    state.projects.forEach(function (p) {
      var r = alive[(p.path || '').toLowerCase()] === 1;
      if (p.running !== r) { p.running = r; changed = true; }
    });
    if (changed) renderProjects();
  }

  function submitAdd() {
    var p = $('addPath').value.trim();
    if (!p) { $('statusBar').textContent = t('status.enterPath'); return; }
    $('statusBar').textContent = t('status.adding');
    fetch('/api/projects/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ path: p }),
    }).then(safeBody)   // safeBody 携带 status——旧打包漏 status,下面 403/404 分支从不命中
      .then(function (r) {
        var body = r.body || {};
        if (r.ok && body.ok === false) {   // 200 + {ok:false,reason}(Task 3 契约:duplicate|full)
          $('statusBar').textContent = body.reason === 'duplicate' ? t('err.duplicate') : t('err.listFull');
          return;
        }
        if (!r.ok) {
          $('statusBar').textContent = r.status === 401 ? t('err.authExpired')
            : (r.status === 403 ? t('err.notAllowed')
            : (r.status === 404 ? t('err.notGodotProjectDetail') : t('status.addFail', { msg: JSON.stringify(body).slice(0, 80) })));
          return;
        }
        $('statusBar').textContent = t('status.added');
        $('addRow').style.display = 'none'; $('addPath').value = '';
      })
      .catch(function () { $('statusBar').textContent = t('net.add'); });
  }

  // ── 文件浏览(spec §6.1/§6.2,2026-09-15 资源管理批)────────────────────────
  // 契约(Task 2):GET /api/projects/files?project=&sub= → {entries:[{name,isDir,size,mtime}]};
  // 目录先排序与隐藏目录(.godot/.git 等)降噪均由 server 侧完成(files-api.ts),前端不重复。
  // 下半切换区 tab(中列分割批 2026-10-08):日志流已常驻上半,本函数只切下半三态
  // (files/kb/settings);脏标防误切——编辑器有未保存修改时离开「文件」需 confirm
  // (spec §6.3 语义随日志 tab 移除改为"离开文件 tab"拦截)。
  function showTab(name) {
    if (name !== 'files' && dirtyBlock()) return;
    // 输出浮层收起(输出查看批):任何 tab 切换退出 out-open 覆盖态
    closeOutput();
    $('tabFiles').className = 'tab' + (name === 'files' ? ' on' : '');
    $('tabSettings').className = 'tab' + (name === 'settings' ? ' on' : '');
    $('tabKb').className = 'tab' + (name === 'kb' ? ' on' : '');
    $('filesPane').style.display = name === 'files' ? 'flex' : 'none';
    $('settingsPane').style.display = name === 'settings' ? 'flex' : 'none';
    $('kbPane').style.display = name === 'kb' ? 'flex' : 'none';
    if (name === 'settings') loadSettings();
    if (name === 'kb' && !kbState.loaded) loadKbOverview();
  }

  // ── 设置面板(2026-09-29 设置批)────────────────────────────────────────────
  // 契约:GET /api/settings → {persisted, effective, candidates, readOnly};
  // POST /api/settings {godotPath, allowedProjectPaths}(完整表单语义:空 = 清除);
  // POST /api/settings/verify {path} → {ok, version} | {ok:false, stage, detail}。
  // 表单填充用 persisted(用户上次的显式设置),生效值另列只读信息区。
  function loadSettings() {
    authFetch('/api/settings').then(safeBody).then(function (r) {
      if (r.status === 401 || r.status === 403) { $('setSaveHint').textContent = t('set.readFail'); return; }
      if (!r.ok || !r.body) return;
      var v = r.body;
      $('setGodotPath').value = (v.persisted && v.persisted.godotPath) || '';
      $('setAllowed').value = v.persisted && v.persisted.allowedProjectPaths ? v.persisted.allowedProjectPaths.join('\\n') : '';   // 反斜杠n须双写:模板字符串内单写会被求值成真实换行,炸掉浏览器脚本语法(2026-09-30 面板死锁根因)
      $('setVaultPath').value = (v.persisted && v.persisted.vaultPath) || '';
      renderSettingsCands(v.candidates || []);
      renderSettingsInfo(v);
      $('setGodotResult').textContent = '';
      $('setSaveHint').textContent = '';
      if (v.readOnly) { $('setSave').disabled = true; $('setSaveHint').textContent = t('set.roDisabled'); }
      // 首启预检黄条随保存刷新(终验收 V1):effective 反映热生效后 env(保存成功
      // 回调重拉本视图);hello 重连前提示状态由此保持最新。
      updateCfgWarn(!!(v.effective && (v.effective.godotPath !== '' || (v.effective.allowedProjectPaths && v.effective.allowedProjectPaths.length > 0))));
    }).catch(function () { $('setSaveHint').textContent = t('net.setRead'); });
  }

  // 候选按钮零监听器、只带 data-cand(对齐 filesPane 委托模式);basename 显示,title 全路径。
  function renderSettingsCands(cands) {
    var host = $('setCands'); host.textContent = '';
    cands.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'ctl'; b.type = 'button';
      b.textContent = (c.split(/[\\\\/]/).pop()) || c; b.title = c;
      b.setAttribute('data-cand', c);
      host.appendChild(b);
    });
  }

  // 只读信息区:当前生效 env 值(textContent 逐行建 div)。
  function renderSettingsInfo(v) {
    var eff = v.effective || {};
    var lines = [
      t('set.info.godotPath') + (eff.godotPath || t('set.info.godotPathEmpty')),
      t('set.info.allowed') + (eff.allowedProjectPaths && eff.allowedProjectPaths.length ? eff.allowedProjectPaths.join(' ; ') : t('set.info.allowedEmpty')),
      'UNRESTRICTED: ' + (eff.unrestricted ? t('set.info.unrestrictedTrue') : 'false'),
      t('set.info.godotAllowed') + (eff.godotAllowedList || t('set.info.godotAllowedEmpty')),
      t('set.info.vault') + (eff.vaultPath || t('set.info.vaultEmpty')),
    ];
    if (v.readOnly) lines.push('READ_ONLY: true');
    var host = $('setInfo'); host.textContent = '';
    lines.forEach(function (l) { var d = document.createElement('div'); d.textContent = l; host.appendChild(d); });
  }

  function verifyGodot() {
    var p = $('setGodotPath').value.trim();
    var out = $('setGodotResult');
    if (!p) { out.className = 'set-result'; out.textContent = t('set.emptyHint'); return; }
    out.className = 'set-result'; out.textContent = t('set.verifying');
    fetch('/api/settings/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ path: p }),
    }).then(safeBody).then(function (r) {
      if (!r.ok) { out.className = 'set-result err'; out.textContent = r.status === 401 ? '✗ ' + t('err.authExpired') : t('set.verifyFail'); return; }
      var v = r.body;
      if (v && v.ok) { out.className = 'set-result ok'; out.textContent = '✓ ' + v.version; }
      else { out.className = 'set-result err'; out.textContent = '✗ ' + ((v && (v.detail || v.stage)) || t('set.verifyFailShort')); }
    }).catch(function () { out.className = 'set-result err'; out.textContent = t('net.verify'); });
  }

  function saveSettings() {
    var godot = $('setGodotPath').value.trim();
    var allowed = $('setAllowed').value.split('\\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });   // \\n:同上,模板字符串内双转义
    var btn = $('setSave'); btn.disabled = true;
    $('setSaveHint').textContent = t('set.saving');
    // vaultPath 不在此表单(真机反馈修复):独立保存按钮 saveVaultSettings——Godot 校验
    // 失败不再连带吞掉 vault 的保存。
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ godotPath: godot, allowedProjectPaths: allowed }),
    }).then(safeBody)
      .then(function (r) {
        if (r.ok) { $('setSaveHint').textContent = t('set.saved'); loadSettings(); return; }
        btn.disabled = false;
        if (r.status === 401) { $('setSaveHint').textContent = t('set.saveFail', { msg: t('err.authExpired') }); return; }
        if (r.status === 403 && JSON.stringify(r.body).indexOf('read-only') !== -1) {   // 对齐 startSession/saveEditor I-2 判定;body 可能 null(JSON.stringify('null') 不含 read-only,安全)
          state.readOnly = true;
          $('setSaveHint').textContent = t('set.roDisabled');
          return;
        }
        $('setSaveHint').textContent = t('set.saveFail', { msg: (r.body && r.body.error) ? r.body.error : JSON.stringify(r.body).slice(0, 100) });
      })
      .catch(function () { btn.disabled = false; $('setSaveHint').textContent = t('net.save'); });
  }

  // 知识库 vault 独立保存(2026-10-08 真机反馈修复):单字段 patch,与 Godot 表单互不拖累;
  // 成功后静默重拉知识库总览(vault 可能刚配/刚清)。
  function saveVaultSettings() {
    var vault = $('setVaultPath').value.trim();
    var btn = $('setVaultSave'); var out = $('setVaultResult'); btn.disabled = true;
    out.className = 'set-result'; out.textContent = t('status.saving');
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ vaultPath: vault }),
    }).then(safeBody)
      .then(function (r) {
        btn.disabled = false;
        if (r.ok) {
          out.className = 'set-result ok'; out.textContent = vault ? t('set.vaultSaved') : t('set.vaultCleared');
          kbState.loaded = false; loadKbOverview(true);
          return;
        }
        if (r.status === 403 && JSON.stringify(r.body).indexOf('read-only') !== -1) {
          state.readOnly = true;
          out.className = 'set-result err'; out.textContent = t('set.roDisabled');
          return;
        }
        out.className = 'set-result err';
        out.textContent = '✗ ' + ((r.body && r.body.error) ? r.body.error : JSON.stringify(r.body).slice(0, 100));
      })
      .catch(function () { btn.disabled = false; out.className = 'set-result err'; out.textContent = t('net.save'); });
  }

  // ── 知识库联动(2026-10-08 批)──────────────────────────────────────────────
  // 契约:GET /api/kb/overview → {configured, vaultExists, vaultName, projects[]};
  // GET /api/kb/project?name= → {name, board|null, logs[]};GET /api/kb/file?name=&path= → {content,size}。
  // 渲染铁律同全面板:动态内容一律 DOM API + textContent;重绘容器内按钮零监听器、
  // 只带 data-action,由 #kbPane 容器一次性委托接管。
  // obsidian:// 跳转用 <a href>(外部协议导航,非 fetch——不受 CSP connect-src 管辖)。
  function obsidianUri(vaultName, rel) {
    return 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(rel.replace(/\\.md$/, ''));   // \\. 双写:模板串内单写求值后退化为通配符 .(2026-09-30 死锁根因同族)
  }

  // 左列徽标匹配:面板项目路径与总览 repoPath 精确相等(大小写不敏感,Windows 路径)。
  function findKbByPath(path) {
    if (!kbState.overview || !kbState.overview.projects) return null;
    var lower = (path || '').toLowerCase();
    for (var i = 0; i < kbState.overview.projects.length; i++) {
      var p = kbState.overview.projects[i];
      if (p.repoPath && p.repoPath.toLowerCase() === lower) return p;
    }
    return null;
  }

  function loadKbOverview(silent) {
    authFetch('/api/kb/overview').then(safeBody)
      .then(function (r) {
        kbState.loaded = true;
        if (!r.ok || !r.body) {
          if (!silent) $('statusBar').textContent = t('kb.overviewFail', { n: r.status });
          return;
        }
        kbState.overview = r.body;
        kbState.view = 'list';
        renderKb();
        renderProjects();   // 📚 徽标数据就绪,重绘左列
      })
      .catch(function () { if (!silent) $('statusBar').textContent = t('net.kb'); });
  }

  function kbTools(host, actions) {
    // actions: [{t:'按钮文案', a:'data-action 值', primary}] + 可选 {link:{t,href,tint}}
    // 布局优化批(2026-10-08):Obsidian 链接推到工具条最右(margin-left:auto)+ ↗ 前缀
    // ——原样与按钮同权重混排在左侧,视觉上像输入框占位文字(视觉验收反馈)
    // (i18n 批:action 项的 t 字段改为 key,此处查 t();对象形态 {t,a} 兼容保留)
    var bar = document.createElement('div'); bar.className = 'log-tools';
    actions.forEach(function (it) {
      if (it.link) {
        var a = document.createElement('a'); a.className = 'ctl'; a.textContent = '↗ ' + t(it.link.key); a.href = it.link.href; a.title = t('kb.openInObsidian');
        a.style.marginLeft = 'auto';
        bar.appendChild(a); return;
      }
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ctl' + (it.primary ? '' : '');
      b.textContent = t(it.key, it.params); b.setAttribute('data-action', it.a);
      bar.appendChild(b);
    });
    host.appendChild(bar);
  }

  function renderKbList(host) {
    var ov = kbState.overview;
    if (!ov || !ov.configured) {
      kbTools(host, [
        { key: 'kb.refresh', a: 'kb-refresh' },
        { key: 'kb.gotoSettings', a: 'kb-goto-settings', primary: true },
      ]);
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = t('kb.notConfigured');
      host.appendChild(e);
      return;
    }
    if (!ov.vaultExists) {
      kbTools(host, [{ key: 'kb.refresh', a: 'kb-refresh' }, { key: 'kb.gotoSettingsShort', a: 'kb-goto-settings' }]);
      var e2 = document.createElement('div'); e2.className = 'empty';
      e2.textContent = t('kb.vaultMissing');
      host.appendChild(e2);
      return;
    }
    kbTools(host, [
      { key: 'kb.refresh', a: 'kb-refresh' },
      { link: { key: 'kb.obsidianHome', href: obsidianUri(ov.vaultName, 'Dashboard') } },
    ]);
    var list = document.createElement('div'); list.className = 'scroll';
    if (!ov.projects.length) {
      var empty = document.createElement('div'); empty.className = 'empty';
      empty.textContent = t('kb.noProjects');
      list.appendChild(empty);
    }
    ov.projects.forEach(function (p) {
      var card = document.createElement('div'); card.className = 'kb-card';
      card.setAttribute('data-action', 'kb-project'); card.setAttribute('data-name', p.name);
      var head = document.createElement('div'); head.className = 'kb-head';
      var name = document.createElement('span'); name.className = 'kb-name'; name.textContent = p.name;
      if (p.repoPath) name.title = p.repoPath;
      var count = document.createElement('span'); count.className = 'kb-count';
      count.textContent = (p.total !== null && p.total !== undefined && p.total > 0)
        ? ('✔ ' + p.done + '/' + p.total + (p.boardFile ? ' · ' + p.boardFile : ''))
        : (p.boardFile ? t('kb.noTasks', { file: p.boardFile }) : t('kb.noBoard'));
      var badge = document.createElement('span');
      if (p.stall) { badge.className = 'kb-stall'; badge.textContent = (p.stallDays !== null && p.stallDays !== undefined) ? t('kb.stallDays', { n: p.stallDays }) : t('kb.stallNoLog'); }
      else if (p.lastCommitDate && p.lastLogDate) { badge.className = 'kb-fresh'; badge.textContent = t('kb.fresh'); badge.title = t('kb.lastCommit', { date: p.lastCommitDate.slice(0, 10) }); }
      else if (p.lastCommitDate) { badge.className = 'kb-none'; badge.textContent = t('kb.noLog'); badge.title = t('kb.deadProjectTip', { date: p.lastCommitDate.slice(0, 10) }); }
      else { badge.className = 'kb-none'; badge.textContent = p.repoPath ? t('kb.repoUnreadable') : t('kb.unmapped'); }
      head.append(name, count, badge);
      var meta = document.createElement('div'); meta.className = 'kb-meta';
      // 布局优化批(2026-10-08):日期独立 span 提亮(.kb-meta-date)——整行 dim 时
      // 「最近日志」行的关键锚点(哪天)扫读不出
      if (p.lastLogDate) {
        var ld = document.createElement('span'); ld.className = 'kb-meta-date'; ld.textContent = p.lastLogDate;
        meta.appendChild(ld); meta.appendChild(document.createTextNode(' ' + (p.lastLogTitle || '')));
      } else { meta.textContent = t('kb.noLogs'); }
      card.append(head, meta);
      list.appendChild(card);
    });
    host.appendChild(list);
  }

  function renderKbDetail(host) {
    var d = kbState.detail;
    var ov = kbState.overview || {};
    kbTools(host, [
      { key: 'kb.backList', a: 'kb-back-list' },
      { link: { key: 'kb.obsidianOpen', href: obsidianUri(ov.vaultName || '', d.name + '/' + (d.board ? d.board.file : '')) } },
    ]);
    var list = document.createElement('div'); list.className = 'scroll';
    var bSub = document.createElement('div'); bSub.className = 'kb-sub';
    bSub.textContent = d.board
      ? t('kb.boardLine', { file: d.board.file, done: (d.board.done !== null && d.board.done !== undefined ? d.board.done : '-'), total: (d.board.total !== null && d.board.total !== undefined ? d.board.total : '-') })
      : t('kb.noBoardDetail');
    list.appendChild(bSub);
    if (d.board && d.board.sections && d.board.sections.length) {
      d.board.sections.forEach(function (s) {
        var line = document.createElement('div'); line.className = 'kb-section';
        line.textContent = '· ' + s.text; line.title = s.text;
        list.appendChild(line);
      });
    }
    var lSub = document.createElement('div'); lSub.className = 'kb-sub';
    lSub.textContent = t('kb.logsLabel', { n: d.logs.length });
    list.appendChild(lSub);
    if (!d.logs.length) {
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = t('kb.noLogs');
      list.appendChild(empty);
    }
    d.logs.forEach(function (lg) {
      var row = document.createElement('div'); row.className = 'kb-log-row';
      row.setAttribute('data-action', 'kb-log'); row.setAttribute('data-file', lg.file);
      var date = document.createElement('span'); date.className = 'kb-log-date'; date.textContent = lg.date;
      var title = document.createElement('span'); title.className = 'kb-log-title'; title.textContent = lg.title; title.title = lg.file;
      var st = document.createElement('span'); st.className = 'kb-log-status'; st.textContent = lg.status || '';
      row.append(date, title, st);
      list.appendChild(row);
    });
    host.appendChild(list);
  }

  function renderKbLog(host) {
    var d = kbState.detail;
    var ov = kbState.overview || {};
    kbTools(host, [
      { key: 'kb.backDetail', a: 'kb-back-detail', params: { name: d ? d.name : '' } },
      { link: { key: 'kb.obsidianOpen', href: obsidianUri(ov.vaultName || '', (d ? d.name + '/' : '') + '开发日志/' + kbState.logFile) } },
    ]);
    var pre = document.createElement('pre'); pre.className = 'kb-log-body';
    pre.textContent = kbState.log ? kbState.log.content : t('kb.emptyFile');
    host.appendChild(pre);
  }

  function openKbProject(name) {
    $('statusBar').textContent = t('status.kbDetailLoading', { name: name });
    authFetch('/api/kb/project?name=' + encodeURIComponent(name))
      .then(safeBody)
      .then(function (r) {
        if (!r.ok) {
          $('statusBar').textContent = t('kb.detailFail', { msg: r.status === 404 ? t('err.dirMissing') : (r.body && r.body.error ? r.body.error : 'HTTP ' + r.status) });
          return;
        }
        kbState.detail = r.body; kbState.view = 'detail'; kbState.log = null;
        renderKb();
        $('statusBar').textContent = t('status.loaded', { name: name });
      })
      .catch(function () { $('statusBar').textContent = t('net.kbDetail'); });
  }

  function openKbLog(name, file) {
    $('statusBar').textContent = t('status.kbLogLoading', { file: file });
    authFetch('/api/kb/file?name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(file))
      .then(safeBody)
      .then(function (r) {
        if (!r.ok) {
          $('statusBar').textContent = t('kb.logFail', { msg: (r.body && r.body.error ? r.body.error : 'HTTP ' + r.status) });
          return;
        }
        kbState.log = r.body; kbState.logFile = file; kbState.view = 'log';
        renderKb();
        $('statusBar').textContent = t('status.loaded', { name: file });
      })
      .catch(function () { $('statusBar').textContent = t('net.kbLog'); });
  }

  function renderKb() {
    var host = $('kbPane'); host.textContent = '';
    if (kbState.view === 'log' && kbState.log) { renderKbLog(host); return; }
    if (kbState.view === 'detail' && kbState.detail) { renderKbDetail(host); return; }
    renderKbList(host);
  }


  function openFiles(projectPath) {
    if (dirtyBlock()) return;   // 换项目浏览=丢弃当前编辑视图,同属脏标防误切
    // entries 重置(Task 4 审查 Minor 1):防 loadDir 失败时 #filesPane 保留上一项目旧渲染。
    filesState.project = projectPath; filesState.sub = ''; filesState.entries = [];
    showTab('files'); loadDir();
  }

  function loadDir() {
    if (!filesState.project) return;
    $('statusBar').textContent = t('status.readingDir');
    fetch('/api/projects/files?project=' + encodeURIComponent(filesState.project) + '&sub=' + encodeURIComponent(filesState.sub),
      { headers: { 'x-gui-token': token } })
      .then(safeBody)
      .then(function (r) {
        if (!r.ok) {
          var msg = r.status === 401 ? t('err.authExpired')
            : (r.status === 403 ? t('err.notAllowed')
            : (r.status === 404 ? t('err.notGodotProjectDetail')
            : (r.status === 503 ? t('err.filesNotConfigured') : JSON.stringify(r.body).slice(0, 80))));
          $('statusBar').textContent = t('status.dirReadFail', { msg: msg });
          return;
        }
        filesState.entries = (r.body && r.body.entries) || [];
        renderFiles();
        $('statusBar').textContent = t('status.dirLoaded');
      })
      .catch(function () { $('statusBar').textContent = t('net.dir'); });
  }

  // 面包屑 + 列表行均为零监听器、只带数据属性([data-sub]/[data-dir]/[data-file]),
  // 点击由 #filesPane 容器一次性委托接管(同 #sessions/#projPane 模式:renderFiles
  // 重绘只清空内部,容器本体永续)。
  function renderFiles() {
    // 列表重绘=编辑视图销毁:脏标/CM 句柄/latest 随视图失效(切走前已有 dirtyBlock
    // 把守,此处兜底防绕过路径残留状态拦截后续导航)。
    editorState.rel = null; editorState.baseMtime = 0; editorState.dirty = false;
    editorState.cm = null; editorState.latest = null;
    var host = $('filesPane'); host.textContent = '';
    var crumb = document.createElement('div'); crumb.className = 'breadcrumb';
    var root = document.createElement('span'); root.className = 'crumb';
    root.textContent = (filesState.project || '').split(/[\\\\/]/).pop() || filesState.project;
    root.title = filesState.project || '';   // 悬停看完整项目路径
    root.setAttribute('data-sub', '');       // 项目名段 → 回根
    crumb.appendChild(root);
    var acc = '';
    (filesState.sub ? filesState.sub.split('/') : []).forEach(function (seg) {
      acc = acc ? acc + '/' + seg : seg;   // 逐段累积路径,点击回跳该层
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/';
      var c = document.createElement('span'); c.className = 'crumb'; c.textContent = seg;
      c.setAttribute('data-sub', acc);
      crumb.append(sep, c);
    });
    host.appendChild(crumb);
    var list = document.createElement('div'); list.className = 'scroll';
    if (!filesState.entries.length) {
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = t('files.emptyDir');
      list.appendChild(empty);
    } else {
      var frag = document.createDocumentFragment();
      filesState.entries.forEach(function (en) {
        var row = document.createElement('div'); row.className = 'file-row';
        row.setAttribute(en.isDir ? 'data-dir' : 'data-file', en.name);
        var nm = document.createElement('span'); nm.className = 'f-name';
        nm.textContent = (en.isDir ? '📁 ' : '') + en.name; nm.title = en.name;
        var sz = document.createElement('span'); sz.className = 'f-size'; sz.textContent = en.isDir ? '' : fmtSize(en.size);
        var tm = document.createElement('span'); tm.className = 'f-time'; tm.textContent = fmtAgo(en.mtime);
        row.append(nm, sz, tm); frag.appendChild(row);
      });
      list.appendChild(frag);
    }
    host.appendChild(list);
  }

  // 扩展名分类前端副本(与 server files-api.ts TEXT_EXTS/IMG_EXTS/AUDIO_EXTS 同清单):
  // Task 5 在此分发点接文本编辑(CodeMirror)/图片预览/音频播放/十六进制视图,
  // 本任务先落占位提示。dotfile(.gdignore/.gitignore)按整名去点匹配,与 server ext() 同语义。
  var TEXT_EXTS = ['gd', 'tscn', 'tres', 'json', 'md', 'cfg', 'import', 'txt', 'gdignore', 'gitignore', 'bat', 'sh', 'ps1'];
  var IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
  var AUDIO_EXTS = ['ogg', 'wav', 'mp3'];

  function fileExt(name) {
    var i = name.lastIndexOf('.');
    if (i > 0) return name.slice(i + 1).toLowerCase();
    if (i === 0) return name.slice(1).toLowerCase();   // dotfile:.gdignore → 'gdignore'
    return '';
  }

  function openFileEntry(name, isDir) {
    if (isDir) {   // 防御:#filesPane 委托已直接处理目录行,此分支保证契约自洽
      filesState.sub = filesState.sub ? filesState.sub + '/' + name : name;
      loadDir(); return;
    }
    var e = fileExt(name);
    // TEXT → 编辑视图(spec §6.3,Task 5);IMG/AUDIO → 内联预览(spec §6.4,
    // Plan B Task 1);其余二进制 → hex 视图(Plan B Task 2)。rel=sub 前缀
    // 拼全(text/hex 端点契约 path 相对项目根)。
    var rel = filesState.sub ? filesState.sub + '/' + name : name;
    if (TEXT_EXTS.indexOf(e) !== -1) { openEditor(rel); return; }
    if (IMG_EXTS.indexOf(e) !== -1) { openPreview(rel, 'img'); return; }
    if (AUDIO_EXTS.indexOf(e) !== -1) { openPreview(rel, 'audio'); return; }
    openPreview(rel, 'hex');
  }

  // ── 预览视图(spec §6.4,Plan B Task 1+2)───────────────────────────────────
  // IMG/AUDIO 内联消费 mode=raw 端点(content-type 映射与 CSP/nosniff 响应头
  // 防线);HEX 走 mode=hex JSON 通道(x-gui-token 头)由 renderHex 渲染。rawUrl
  // 一律 JS 变量拼 token(M-9:URL query 里的 token 已被 replaceState 清除,且
  // img/audio 元素无法带请求头,query 是唯一鉴权通道)。SVG 经 img 上下文加载
  // 其内嵌脚本不执行,叠加上述 CSP。
  function openPreview(rel, kind) {
    if (!rel || !filesState.project) return;
    previewState = { rel: rel, kind: kind };
    var name = (rel || '').split('/').pop() || rel;   // basename:下载文件名与 entries 匹配键
    var rawUrl = '/api/projects/file?project=' + encodeURIComponent(filesState.project) + '&path=' + encodeURIComponent(rel) + '&mode=raw&token=' + token;
    var host = $('filesPane'); host.textContent = '';
    // 工具行:返回列表 + 下载链接(<a download> 静态安全;raw 响应头防线保证
    // 直接导航也不执行 script)。按钮/链接零监听器,由 #filesPane 委托接管。
    var tools = document.createElement('div'); tools.className = 'log-tools';
    var back = document.createElement('button'); back.className = 'ctl'; back.textContent = t('preview.back');
    back.setAttribute('data-action', 'preview-back');
    var dl = document.createElement('a'); dl.className = 'ctl'; dl.href = rawUrl;
    dl.setAttribute('download', name); dl.textContent = t('preview.download', { name: name });
    tools.append(back, dl); host.appendChild(tools);
    if (kind === 'img') {
      var img = document.createElement('img');
      img.src = rawUrl; img.alt = rel;
      img.onload = function () {   // 尺寸显示(spec §6.4):加载完成后在下方元信息
        // 行 size 旁追加 W×H。st 在本函数末尾创建,onload 异步触发时已赋值(闭包
        // 捕获变量引用),跨目录进入(size 为 null)时同样追加。
        st.textContent = st.textContent + ' · ' + img.naturalWidth + '×' + img.naturalHeight;
      };
      img.onerror = function () {   // token 失效(server 重启)/超限(too_large)时 raw 非 2xx
        var d = document.createElement('div'); d.className = 'empty';
        d.textContent = t('preview.imgFail');
        if (img.parentNode) img.parentNode.replaceChild(d, img);
      };
      host.appendChild(img);
    } else if (kind === 'audio') {
      // audio 元素经 DOM API 构建,形态等价 <audio controls src=rawUrl>
      var au = document.createElement('audio');
      au.controls = true; au.src = rawUrl;
      au.onerror = function () {   // 同 img 模式:token 失效/超限时 raw 非 2xx,占位可见反馈
        var d = document.createElement('div'); d.className = 'empty';
        d.textContent = t('preview.audioFail');
        if (au.parentNode) au.parentNode.replaceChild(d, au);
      };
      host.appendChild(au);
    } else if (kind === 'hex') {
      // hex 视图(spec §6.4,Plan B Task 2):JSON 通道(x-gui-token 头,同
      // loadDir/openEditor 模式)取前 4KB 采样;读取中/失败均以占位文本呈现
      // (401/403/404 等错误显示在预览区,不落 statusBar)。完整文件走工具行
      // 下载链接(raw 同 URL+download,Task 1 已建)。
      var box = document.createElement('div'); box.className = 'hex-box';
      var ph = document.createElement('div'); ph.className = 'empty';
      ph.textContent = t('status.readingHex');
      box.appendChild(ph); host.appendChild(box);
      fetch('/api/projects/file?project=' + encodeURIComponent(filesState.project) + '&path=' + encodeURIComponent(rel) + '&mode=hex',
        { headers: { 'x-gui-token': token } })
        .then(safeBody)   // 401/403 空体防线(审查 I-1 → 2026-09-16 统一 safeBody,旧哨兵只挡 401)
        .then(function (r) {
          if (!r.ok) {
            var msg = r.status === 401 ? t('err.authExpired')
              : (r.status === 403 ? t('err.notAllowed')
              : (r.status === 404 ? t('err.fileNotFound') : JSON.stringify(r.body).slice(0, 80)));
            ph.textContent = t('status.hexReadFail', { msg: msg });
            return;
          }
          renderHex(box, rel, r.body.bytes || [], r.body.size || 0);
        })
        .catch(function () { ph.textContent = t('net.hex'); });
    }
    // 元信息行:size 从列表 entries 快照取(打开预览不经 JSON 通道,raw 响应无从
    // 知大小);跨目录进入(entries 不含该名)时省略,只显示 rel。
    var size = null;
    filesState.entries.forEach(function (en) { if (en.name === name && !en.isDir) size = en.size; });
    var st = document.createElement('div'); st.className = 'ed-status';
    st.textContent = rel + (size != null ? ' · ' + fmtSize(size) : '');
    host.appendChild(st);
    $('statusBar').textContent = t('status.previewOpened', { rel: rel });
  }

  // ── hex 渲染(spec §6.4,Plan B Task 2)─────────────────────────────────────
  // 三列全 textContent:偏移 8 位 hex/16 字节两位 hex 空格分隔/ASCII 32-126 可打
  // 印否则点号;4KB/16=256 行,无渲染压力。size>bytes.length(>4KB 截断)时提示
  // 「仅前 4KB」,完整内容由工具行下载链接获取(raw 同 URL+download,复用 Task 1)。
  // 标题行 size 取自 hex 响应体真实值(比 entries 快照可靠,跨目录进入也有)。
  function renderHex(box, rel, bytes, size) {
    box.textContent = '';
    var title = document.createElement('div'); title.className = 'hex-title';
    title.textContent = rel + ' (' + fmtSize(size) + ')';
    box.appendChild(title);
    if (size > bytes.length) {
      var tr = document.createElement('div'); tr.className = 'hex-title';
      tr.textContent = t('hex.truncated');
      box.appendChild(tr);
    }
    var grid = document.createElement('div'); grid.className = 'scroll hex-grid';
    var frag = document.createDocumentFragment();
    for (var off = 0; off < bytes.length; off += 16) {
      var row = document.createElement('div'); row.className = 'hex-row';
      var o = document.createElement('span'); o.className = 'hex-off';
      o.textContent = ('00000000' + off.toString(16)).slice(-8);
      var hs = [], as = [];
      for (var i = off; i < off + 16 && i < bytes.length; i++) {
        var b = bytes[i];
        hs.push((b < 16 ? '0' : '') + b.toString(16));   // 两位 hex,不足补 0
        as.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');   // 32-126 可打印
      }
      var h = document.createElement('span'); h.className = 'hex-bytes';
      h.textContent = hs.join(' ');
      var a = document.createElement('span'); a.className = 'hex-ascii';
      a.textContent = as.join('');
      row.append(o, h, a); frag.appendChild(row);
    }
    grid.appendChild(frag); box.appendChild(grid);
  }

  // ── 编辑视图(spec §6.3,2026-09-15 资源管理批 Task 5)──────────────────────
  // 脏标防误切:一切离开编辑视图的动作(切日志 tab/目录导航/换项目浏览/重新加载/
  // 返回列表)统一走此把守;rel 为 null(不在编辑视图)时不拦。
  function dirtyBlock() {
    return !!(editorState.rel && editorState.dirty && !confirm(t('ed.dirtyConfirm')));
  }

  // CM 动态加载(spec §6.3/M-9):首次进编辑视图才取资产,cmLoaded 保证只加载一次;
  // 并发打开文件时后来的回调在 cmPending 排队,全 onload 后统一 flush。css+codemirror.js
  // 先载,4 个 mode 后载(mode-xml 为 markdown 内嵌 HTML 块的依赖,spec §5.1/M-8)。
  // src 一律拼 '?token=' + token JS 变量——URL query 里的 token 已被 replaceState 清除。
  var cmLoaded = false, cmPending = [];
  function ensureCodeMirror(cb) {
    if (cmLoaded) { cb(); return; }
    cmPending.push(cb);
    if (cmPending.length > 1) return;
    var link = document.createElement('link'); link.rel = 'stylesheet';
    link.href = '/assets/codemirror.css?token=' + token; document.head.appendChild(link);
    var s1 = document.createElement('script'); s1.src = '/assets/codemirror.js?token=' + token;
    s1.onload = function () {
      var n = 0, modes = ['mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js'];
      modes.forEach(function (m) {
        var s = document.createElement('script'); s.src = '/assets/' + m + '?token=' + token;
        s.onload = function () { if (++n === modes.length) { cmLoaded = true; cmPending.forEach(function (f) { f(); }); cmPending = []; } };
        document.head.appendChild(s);
      });
    };
    document.head.appendChild(s1);
  }

  // mode 路由(spec §6.3):gd 无官方 mode→python 近似;json 走 javascript mode 的
  // application/json 变体;md→markdown;其余 null=plain 无高亮。
  function modeForFile(rel) {
    var e = fileExt(rel || '');
    if (e === 'gd') return 'python';
    if (e === 'json') return { name: 'javascript', json: true };
    if (e === 'md') return 'markdown';
    return null;
  }

  function openEditor(rel) {
    if (!rel || !filesState.project) return;
    $('statusBar').textContent = t('status.readingFile', { rel: rel });
    fetch('/api/projects/file?project=' + encodeURIComponent(filesState.project) + '&path=' + encodeURIComponent(rel) + '&mode=text',
      { headers: { 'x-gui-token': token } })
      .then(safeBody)
      .then(function (r) {
        if (!r.ok) {
          var msg = r.status === 401 ? t('err.authExpired')
            : (r.status === 400 ? t('err.unsupportedExt')
            : (r.status === 403 ? t('err.notAllowed')
            : (r.status === 404 ? t('err.fileNotFound')
            : (r.status === 413 ? t('err.fileTooLarge') : JSON.stringify(r.body).slice(0, 80)))));
          $('statusBar').textContent = t('status.fileReadFail', { msg: msg });
          return;
        }
        editorState.rel = rel; editorState.baseMtime = r.body.mtime; editorState.dirty = false; editorState.latest = null;
        renderEditor(rel, r.body.content, r.body.mtime, r.body.size);
      })
      .catch(function () { $('statusBar').textContent = t('net.file'); });
  }

  // 编辑子视图(替换 #filesPane 内容):工具行(保存/重新加载/返回列表)+ 只读横幅 +
  // 409 冲突条(默认隐藏)+ CM 宿主 textarea + 状态栏。按钮全部零监听器、只带
  // data-action,由 #filesPane 容器委托接管(同 renderFiles 模式:容器本体永续)。
  function renderEditor(rel, content, mtime, size) {
    editorState.cm = null;   // 旧实例随上一次视图 DOM 丢弃;新 textarea 待 CM 回调升级
    var host = $('filesPane'); host.textContent = '';
    var tools = document.createElement('div'); tools.className = 'log-tools';
    var save = document.createElement('button'); save.className = 'ctl'; save.id = 'edSave'; save.textContent = t('ed.btn.save');
    save.setAttribute('data-action', 'editor-save');
    var reload = document.createElement('button'); reload.className = 'ctl'; reload.textContent = t('ed.btn.reload');
    reload.setAttribute('data-action', 'editor-reload');
    var back = document.createElement('button'); back.className = 'ctl'; back.textContent = t('ed.btn.backList');
    back.setAttribute('data-action', 'editor-back');
    if (state.readOnly) save.style.display = 'none';   // readOnly:保存钮隐藏(spec §6.3)
    tools.append(save, reload, back); host.appendChild(tools);
    var ro = document.createElement('div'); ro.className = 'ed-banner'; ro.id = 'edRoBanner';
    ro.textContent = t('ed.roBanner');
    if (state.readOnly) ro.style.display = 'flex';
    host.appendChild(ro);
    var cf = document.createElement('div'); cf.className = 'ed-conflict'; cf.id = 'edConflict';
    var cfTxt = document.createElement('span'); cfTxt.textContent = t('ed.conflict');
    var cfReload = document.createElement('button'); cfReload.className = 'ctl'; cfReload.textContent = t('ed.btn.reload');
    cfReload.setAttribute('data-action', 'conflict-reload');
    var cfCopy = document.createElement('button'); cfCopy.className = 'ctl'; cfCopy.textContent = t('ed.btn.copyMine');
    cfCopy.setAttribute('data-action', 'conflict-copy');
    cf.append(cfTxt, cfReload, cfCopy); host.appendChild(cf);
    var wrap = document.createElement('div'); wrap.className = 'ed-host';
    var ta = document.createElement('textarea'); ta.id = 'cmHost'; ta.value = content;   // CM 就绪前原生可编辑兜底,就绪后 fromTextArea 升级
    wrap.appendChild(ta); host.appendChild(wrap);
    var st = document.createElement('div'); st.className = 'ed-status'; st.id = 'edStatus';
    st.textContent = rel + ' · ' + fmtSize(size) + ' · ' + (mtime ? new Date(mtime).toLocaleString() : '-');
    host.appendChild(st);
    ensureCodeMirror(function () {
      var ta2 = document.getElementById('cmHost');
      if (!ta2 || editorState.cm) return;   // 已离开编辑视图/已被更早回调升级(快速重开竞态)
      editorState.cm = CodeMirror.fromTextArea(ta2, {
        lineNumbers: true,
        mode: modeForFile(editorState.rel),
        readOnly: state.readOnly ? true : false,
      });
      editorState.cm.on('change', function () {
        editorState.dirty = true;
        var b = $('edSave'); if (b) b.textContent = t('ed.btn.saveDirty');   // 未保存指示(spec §6.3)
      });
    });
    $('statusBar').textContent = t('status.opened', { rel: rel });
  }

  // edStatus 异步写入统一守卫(Task 5 审查 Minor + Fix R1 勘误):saveEditor 的
  // then/catch 回调及其 409→showConflict / 403→enterReadOnly 延伸调用、conflictCopy
  // 的 clipboard 回调均为异步路径——执行时用户可能已切走 tab 致 DOM 重建,
  // $('edStatus') 可为 null,null.textContent 抛 TypeError 会落入 catch"网络异常"
  // 误语义;打开/conflictReload/conflictCopy 的点击入口为同步路径,DOM 刚创建
  // 必然在场,不强制改。
  function setEdStatus(msg) { var st = $('edStatus'); if (st) st.textContent = msg; }

  // 保存流(spec §3.3 三重护栏的 UI 端):POST 携 baseMtime 乐观锁;200 前进本地
  // mtime+清脏标;409 弹冲突条(latest 消费);413/403/404 就地报错。
  function saveEditor() {
    if (!editorState.rel || !filesState.project) return;
    var content = editorState.cm ? editorState.cm.getValue() : ($('cmHost') ? $('cmHost').value : '');
    var btn = $('edSave'); if (btn) btn.disabled = true;
    $('edStatus').textContent = t('status.saving');
    fetch('/api/projects/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ project: filesState.project, path: editorState.rel, content: content, baseMtime: editorState.baseMtime }),
    }).then(safeBody)
      .then(function (r) {
        if (btn) btn.disabled = false;
        if (r.ok) {
          editorState.baseMtime = r.body.mtime; editorState.dirty = false;
          if (btn) btn.textContent = t('ed.btn.save');
          setEdStatus(t('status.saved', { time: new Date(r.body.mtime).toLocaleString() }));
          return;
        }
        if (r.status === 409) { showConflict(r.body && r.body.latest); return; }
        if (r.status === 401) { setEdStatus(t('status.saveFail', { msg: t('err.authExpired') })); return; }
        if (r.status === 403) {   // 双源区分(对齐 startSession I-2 判定)
          if (JSON.stringify(r.body).indexOf('read-only') !== -1) { enterReadOnly(); return; }
          setEdStatus(t('status.saveFail', { msg: t('err.notAllowed') }));
          return;
        }
        var msg = r.status === 413 ? t('err.contentTooLarge') : (r.status === 404 ? t('err.fileDeleted') : JSON.stringify(r.body).slice(0, 80));
        setEdStatus(t('status.saveFail', { msg: msg }));
      })
      .catch(function () { if (btn) btn.disabled = false; setEdStatus(t('net.save')); });
  }

  // 409 冲突条显示:latest 存 editorState 供「重新加载」按钮消费(Task 2 契约
  // 409 body {error, latest:{content,mtime}})。
  function showConflict(latest) {
    editorState.latest = latest || null;
    var bar = $('edConflict'); if (bar) bar.style.display = 'flex';
    setEdStatus(t('status.conflict', { rel: editorState.rel || '' }));   // Fix R1:唯一调用点在 saveEditor then 回调 409 分支(异步)
  }

  // readOnly 置位(spec §6.3):保存 403 read-only 响应体触发;此后打开的编辑器
  // 直接只读(服务端 READ_ONLY 为启动期 env,运行期不变,置位后无需复位)。
  function enterReadOnly() {
    state.readOnly = true;
    if (editorState.cm) editorState.cm.setOption('readOnly', true);
    var b = $('edSave'); if (b) b.style.display = 'none';
    var banner = $('edRoBanner'); if (banner) banner.style.display = 'flex';
    setEdStatus(t('ed.roDisabled'));   // Fix R1:唯一调用点在 saveEditor then 回调 403 read-only 分支(异步)
  }

  // 409 冲突条「重新加载」:丢弃本地修改,重设为服务端最新版+baseMtime 前进。
  function conflictReload() {
    var lt = editorState.latest;
    if (!lt) return;
    if (editorState.cm) editorState.cm.setValue(lt.content || '');
    else if ($('cmHost')) $('cmHost').value = lt.content || '';
    editorState.baseMtime = lt.mtime; editorState.dirty = false;   // setValue 同步触发 change→dirty=true,此处统一覆盖
    editorState.latest = null;
    var bar = $('edConflict'); if (bar) bar.style.display = 'none';
    var sb = $('edSave'); if (sb) sb.textContent = t('ed.btn.save');
    $('edStatus').textContent = t('status.reloaded', { time: new Date(lt.mtime).toLocaleString() });
  }

  // 409 冲突条「复制我的修改」:抢救本地输入到剪贴板(localhost 为 secure context,
  // clipboard API 可用;失败给手动兜底提示)。
  function conflictCopy() {
    var mine = editorState.cm ? editorState.cm.getValue() : ($('cmHost') ? $('cmHost').value : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mine).then(
        function () { setEdStatus(t('ed.copied')); },
        function () { setEdStatus(t('ed.copyFail')); });
    } else { $('edStatus').textContent = t('ed.clipboardNa'); }
  }

  function renderLogs() {
    var filter = $('logFilter').value.toLowerCase();
    var level = $('logLevel').value;
    var host = $('logList');
    var stick = host.scrollHeight - host.scrollTop - host.clientHeight < 30;   // 贴底判断:用户上翻查历史时不拽回
    host.textContent = '';
    var shown = state.logs.filter(function (e) {
      if (level !== 'ALL' && e.level.toUpperCase() !== level) return false;
      if (!filter) return true;
      return ((e.msg || '') + (e.module || '') + (e.tool || '') + (e.project || '')).toLowerCase().indexOf(filter) !== -1;
    }).slice(-300);
    var frag = document.createDocumentFragment();
    shown.forEach(function (e) {
      var div = document.createElement('div'); div.className = 'log-line ' + e.level;
      var ts = document.createElement('span'); ts.className = 't'; ts.textContent = (e.ts || '').slice(11, 19);
      div.appendChild(ts); div.appendChild(document.createTextNode(e.msg || ''));
      frag.appendChild(div);
    });
    host.appendChild(frag); if (stick) host.scrollTop = host.scrollHeight;
    $('logCount').textContent = t('logs.count', { n: state.logs.length });
  }

  function renderStats() {
    var s = state.stats; if (!s) return;
    var sel = $('projSel'); var cur = sel.value;
    var view = cur && s.projects && s.projects[cur] ? s.projects[cur] : s;
    var rows = (view.toolStats || []).slice().sort(function (a, b) { return b.calls - a.calls; });
    var tbody = $('statsTable').querySelector('tbody'); tbody.textContent = '';
    // 布局优化批(2026-10-08):零调用(server 刚启动)空表体给占位——原样六列空壳
    // 在 420px 全高右列渲染成"半成品";toolStats 非空但被 projSel 过滤到空时同占位
    if (!rows.length) {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td'); td0.colSpan = 6;
      var ph = document.createElement('div'); ph.className = 'empty';
      ph.textContent = t('stats.emptyTools');
      td0.appendChild(ph); tr0.appendChild(td0); tbody.appendChild(tr0);
    }
    rows.forEach(function (rowStat) {
      var tr = document.createElement('tr');
      [rowStat.tool, rowStat.calls, rowStat.errors, Math.round(rowStat.totalDurationMs / Math.max(1, rowStat.calls)), rowStat.minDurationMs, rowStat.maxDurationMs].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // 项目切换器选项刷新(保留当前选择)
    var keys = s.projects ? Object.keys(s.projects) : [];
    if (cur && keys.indexOf(cur) === -1) keys.unshift(cur);
    sel.textContent = '';
    var optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = t('stats.all'); sel.appendChild(optAll);
    keys.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k.split(/[\\\\/]/).pop() || k; o.title = k; sel.appendChild(o); });
    sel.value = cur;
    // 时序柱状图(纯 CSS);空序列给占位(布局优化批 2026-10-08:收到 stats 但
    // timeSeries 空(如刚启动首帧)时原样清空成纯空白,右列下半区像未实现)
    var chart = $('chart'); chart.textContent = '';
    var ts2 = view.timeSeries || []; var max = 1;
    ts2.forEach(function (b) { max = Math.max(max, b.calls); });
    if (!ts2.length) {
      var ph2 = document.createElement('div'); ph2.className = 'empty'; ph2.style.flex = '1';
      ph2.textContent = t('stats.emptyTimeline');
      chart.appendChild(ph2); return;
    }
    ts2.forEach(function (b) {   // ts2(审查 B-1 修复):防遮蔽改名 t→ts2 的引用残留,机械改名须全文 grep 收尾
      var bar = document.createElement('div'); bar.className = 'bar'; bar.title = b.minute + ' calls=' + b.calls + ' errors=' + b.errors;
      var c = document.createElement('div'); c.className = 'calls'; c.style.height = Math.round(b.calls / max * 70) + 'px';
      var er = document.createElement('div'); er.className = 'errors'; er.style.height = Math.min(18, b.errors * 3) + 'px';
      bar.append(c, er); chart.appendChild(bar);
    });
  }

  $('logFilter').addEventListener('input', renderLogs);
  $('logLevel').addEventListener('change', renderLogs);
  $('projSel').addEventListener('change', renderStats);
  $('projSearch').addEventListener('input', renderProjects);   // 搜索即时过滤
  // 语言切换(2026-10-13 i18n 批):写 localStorage 后 reload——动态文本全部经 render*
  // 从 state 重建,reload 是唯一无残留重建方式(避免遍历 DOM 手动更新的遗漏面)。
  $('langBtn').textContent = t('lang.switchTo');
  $('langBtn').addEventListener('click', function () {
    try { localStorage.setItem('gui-lang', LANG === 'zh' ? 'en' : 'zh'); } catch (e) { /* 私有模式忽略 */ }
    location.reload();
  });

  // 项目区容器一次性事件委托(spec §7.2):工具行(扫描/+添加/确定)与列表行(Run/Edit/×)
  // 按钮全部零监听器、只带 data-action(+data-path),由 #projPane section 本体接管——
  // 容器在 renderProjects 重绘中从不被替换,只有 #projList 内部被清空重建,委托永续。
  $('projPane').addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var path = btn.getAttribute('data-path') || '';
    if (action === 'scan') { startScan(); return; }
    if (action === 'add') { toggleAddRow(); return; }
    if (action === 'add-confirm') { submitAdd(); return; }
    if (action === 'run' || action === 'edit') { startSession(path, action); return; }
    if (action === 'reimport') { reimportProject(path); return; }
    if (action === 'files') { openFiles(path); return; }
    if (action === 'kb') {   // 📚 徽标(2026-10-08 批):切知识库 tab 并直达该项目详情
      showTab('kb');
      openKbProject(btn.getAttribute('data-kbname') || '');
      return;
    }
    if (action === 'remove') { removeProject(path); }
  });

  // #sessions 容器一次性事件委托(2026-09-15 修复):renderSessions 每 500ms 清空
  // 重建容器内部,#sessions 本体持续存在 → 委托处理器永续,按钮随 SSE 帧任意替换
  // 也不丢 click。按钮只带 data-action(stop|remove) + data-project(见 sessionControl)。
  $('sessions').addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var project = btn.getAttribute('data-project') || '';
    // 输出查看(2026-10-08 输出查看批):读操作,不走下方 POST 分支(disable/状态栏流程)
    if (action === 'sess-output') { showOutput(project); return; }
    $('statusBar').textContent = t(action === 'stop' ? 'status.stopping' : 'status.cleaning', { project: project });
    btn.disabled = true;
    fetch(action === 'stop' ? '/api/sessions/stop' : '/api/sessions/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ projectPath: project }),
    }).then(function (r) {
      if (!r.ok) {
        // 失败恢复:按钮尚未被重绘时可立即重试;已被 500ms 帧替换则此为孤儿节点,
        // disabled 复位无害(状态栏提示已足够)。
        btn.disabled = false;
        return r.text().then(function (txt) { $('statusBar').textContent = t('status.opFail', { msg: txt.slice(0, 80) }); });
      }
      $('statusBar').textContent = t('status.opSent');
    }).catch(function () {
      btn.disabled = false;
      $('statusBar').textContent = t('net.op');
    });
  });

  // #instPane 容器一次性事件委托(实例管理批 2026-09-30,同 #sessions 模式):
  // 重启按钮 data-action=inst-restart + data-pid。confirm 文案语义诚实——不承诺
  // 客户端自动重连(ZCode 重连行为未定论,实测前按"可能需手动重连"告知)。
  $('instPane').addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action="inst-restart"]') : null;
    if (!btn) return;
    var pid = Number(btn.getAttribute('data-pid')) || 0;
    var isSelf = pid !== 0 && pid === state.mePid;
    var msg = isSelf ? t('inst.confirm.self') : t('inst.confirm.other', { pid: pid });
    if (!window.confirm(msg)) return;
    btn.disabled = true;
    $('statusBar').textContent = t('inst.restarting', { pid: pid });
    fetch('/api/instances/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ pid: pid }),
    }).then(function (r) {
      if (!r.ok) {
        btn.disabled = false;
        return r.text().then(function (txt) { $('statusBar').textContent = t('inst.restartFail', { msg: txt.slice(0, 80) }); });
      }
      if (isSelf) { $('statusBar').textContent = t('inst.selfRestarting'); return; }
      $('statusBar').textContent = t('inst.restartRequested', { pid: pid });
      pollInstancesGone(pid);
    }).catch(function () {
      btn.disabled = false;
      $('statusBar').textContent = t('net.restart');
    });
  });

  // 实例列表:初始拉取 + 15s 静默轮询(实例清单非 SSE 推送——server 侧感知不到其他
  // 实例的 registry 变化,客户端拉取是唯一真相源;静默失败,下轮再试)。
  loadInstances();
  setInterval(loadInstances, 15000);

  // 中列 tab 切换(资源管理批 spec §6.1):tab 按钮为静态 DOM、从不重绘,直接绑定
  // (与 logFilter/projSearch 静态控件同模式;重绘容器内的按钮才须走 data-action 委托)。
  // 下半切换区 tab(中列分割批):静态 DOM 直接绑定;「日志」tab 已移除(日志流常驻上半)
  $('tabFiles').addEventListener('click', function () { showTab('files'); });
  $('tabSettings').addEventListener('click', function () { showTab('settings'); });
  $('tabKb').addEventListener('click', function () { showTab('kb'); });
  // 输出视图工具条(2026-10-08 输出查看批):静态 DOM 直接绑定(同 tab 按钮模式);
  // 返回走 closeOutput() 恢复分割布局(上半日志+下半当前 tab 原样)
  $('outBack').addEventListener('click', closeOutput);
  $('outRefresh').addEventListener('click', function () { if (outState.project) loadSessionOutput(); });
  // 知识库总览后台预取(2026-10-08 批):左列 📚 徽标数据源;静默失败(未配置/网络异常
  // 均不惊扰——进知识库 tab 时 loadKbOverview 有带 statusBar 反馈的重试)。
  loadKbOverview(true);
  // #kbPane 容器一次性事件委托(2026-10-08 批,同 #filesPane 模式):工具行/卡片/日志行
  // 按钮与可点行全部零监听器、只带 data-action(+data-name/data-file),重绘只清容器
  // 内部,委托永续;obsidian:// 跳转是原生 <a href> 导航,不经本委托。
  $('kbPane').addEventListener('click', function (ev) {
    if (!ev.target || !ev.target.closest) return;
    var el = ev.target.closest('[data-action]');
    if (!el || !($('kbPane').contains(el))) return;
    var action = el.getAttribute('data-action');
    if (action === 'kb-refresh') { loadKbOverview(); return; }
    if (action === 'kb-goto-settings') { showTab('settings'); return; }
    if (action === 'kb-back-list') { kbState.view = 'list'; kbState.log = null; renderKb(); return; }
    if (action === 'kb-back-detail') { kbState.view = 'detail'; kbState.log = null; renderKb(); return; }
    if (action === 'kb-project') { openKbProject(el.getAttribute('data-name') || ''); return; }
    if (action === 'kb-log' && kbState.detail) { openKbLog(kbState.detail.name, el.getAttribute('data-file') || ''); }
  });
  // 设置面板静态控件直接绑定(tab/输入/按钮均为静态 DOM,从不重绘);候选列表是唯一
  // 动态区,容器一次性委托(data-cand 点选即填入并验证)。
  $('setVerifyBtn').addEventListener('click', verifyGodot);
  $('setSave').addEventListener('click', saveSettings);
  $('setVaultSave').addEventListener('click', saveVaultSettings);   // vault 独立保存(真机反馈修复)
  $('setCands').addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button[data-cand]') : null;
    if (!b) return;
    $('setGodotPath').value = b.getAttribute('data-cand') || '';
    verifyGodot();
  });

  // #filesPane 容器一次性事件委托(资源管理批 spec §6.2/§6.3):面包屑段([data-sub]
  // 回根/回跳层级)、目录行([data-dir] 进子目录)、文件行([data-file] →
  // openFileEntry)与编辑/预览视图工具行按钮(button[data-action]:editor-save|
  // editor-reload|editor-back|conflict-reload|conflict-copy|preview-back)全部
  // 零监听器——renderFiles/renderEditor/openPreview 重绘只清空容器内部,委托永续;
  // 目录导航类动作进编辑器脏标把守(spec §6.3)。
  $('filesPane').addEventListener('click', function (ev) {
    if (!ev.target || !ev.target.closest) return;
    var act = ev.target.closest('button[data-action]');
    if (act) {
      var action = act.getAttribute('data-action');
      if (action === 'editor-save') { saveEditor(); return; }
      if (action === 'editor-reload') {   // 重新拉服务端版本=丢弃本地,脏标把守
        if (dirtyBlock()) return;
        openEditor(editorState.rel);
        return;
      }
      if (action === 'editor-back') {
        if (dirtyBlock()) return;
        renderFiles();
        return;
      }
      if (action === 'preview-back') {   // 预览无脏标,直接回列表
        renderFiles();
        return;
      }
      if (action === 'conflict-reload') { conflictReload(); return; }
      if (action === 'conflict-copy') { conflictCopy(); return; }
      return;
    }
    var subEl = ev.target.closest('[data-sub]');
    if (subEl) {
      if (dirtyBlock()) return;
      filesState.sub = subEl.getAttribute('data-sub') || ''; loadDir(); return;
    }
    var dir = ev.target.closest('[data-dir]');
    if (dir) {
      if (dirtyBlock()) return;
      var d = dir.getAttribute('data-dir') || '';
      filesState.sub = filesState.sub ? filesState.sub + '/' + d : d;
      loadDir(); return;
    }
    var file = ev.target.closest('[data-file]');
    if (file) openFileEntry(file.getAttribute('data-file') || '', false);
  });

  var es = new EventSource('/events?token=' + encodeURIComponent(token));
  // 自愈(2026-09-16 入口简化批):onopen 时间戳 + 持续失联/401 都进 recoverPanel
  // (扫端口段找活实例迁移,不再躺平等死);共享持久 token 保证 cookie 跨实例有效。
  var lastOpenAt = Date.now();
  var recovering = false;
  es.onopen = function () { lastOpenAt = Date.now(); recovering = false; };
  function recoverPanel() {
    if (recovering) return;
    recovering = true;
    $('statusBar').textContent = t('warn.reconnecting');
    var probes = [];
    for (var p = 9550; p <= 9569; p++) probes.push(probeHealth(p));
    Promise.all(probes).then(function (alive) {
      var here = Number(location.port) || 80;
      // 环防护(真机实测教训):sessionStorage 记录已迁移过的端口,跳过的实例再跳回=乒乓死循环
      var visited = {};
      try { visited = JSON.parse(sessionStorage.getItem('gui-visited') || '{}'); } catch (e) { visited = {}; }
      visited[here] = 1;
      var pick = -1;
      for (var i = 0; i < alive.length; i++) { if (alive[i] >= 0 && alive[i] !== here && !visited[alive[i]]) { pick = alive[i]; break; } }
      if (pick >= 0) {
        visited[pick] = 1;
        try { sessionStorage.setItem('gui-visited', JSON.stringify(visited)); } catch (e) { /* 私有模式忽略 */ }
        location.replace('http://127.0.0.1:' + pick + '/'); return;   // 迁移:cookie 随导航带
      }
      showDeadPanel();                                               // 无未访问活实例:友好指引
    });
  }
  function probeHealth(port) {
    return new Promise(function (resolve) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); resolve(-1); }, 2000);
      fetch('http://127.0.0.1:' + port + '/api/health', { signal: ctl.signal }).then(function (r) {
        clearTimeout(timer);
        resolve(r.ok ? port : -1);
      }).catch(function () { clearTimeout(timer); resolve(-1); });
    });
  }
  function showDeadPanel() {
    $('statusBar').textContent = t('warn.allDeadShort');
    var w = $('warn'); w.style.display = 'block';
    w.textContent = t('warn.allDead');
    recovering = false;
  }
  es.addEventListener('hello', function (ev) { $('warn').style.display = 'none'; resetAll(JSON.parse(ev.data)); });
  es.addEventListener('log', function (ev) { pushLogs(JSON.parse(ev.data).entries || []); });
  es.addEventListener('sessions', function (ev) { state.sessions = JSON.parse(ev.data); renderSessions(); refreshRunningBadges(); });
  es.addEventListener('stats', function (ev) { state.stats = JSON.parse(ev.data); renderStats(); });
  // projects 事件按字段在场性消费(Task 3 契约):
  //   {scanning:true, found, scanned} 进度 / {scanning:false, added} 完成 /
  //   {scanning:false, failed:true} 失败兜底(F-1) / {projects:[...]} 快照。
  // 快照与扫描态独立处理——扫描进行中 add 成功的快照不清扫描指示器。
  es.addEventListener('projects', function (ev) {
    var p = JSON.parse(ev.data);
    if (p && Array.isArray(p.projects)) { state.projects = p.projects; renderProjects(); }
    if (p && p.scanning === true) { $('statusBar').textContent = t('status.scanProgress', { found: p.found || 0, scanned: p.scanned || 0 }); return; }
    if (p && p.scanning === false) { $('statusBar').textContent = p.failed ? t('status.scanFailedEvt') : t('status.scanDone', { n: p.added || 0 }); }
  });
  // 资源重导入批(2026-10-08):{type:'done', projectPath, ok, report|error}。
  // report.gutted 非空 = .import 疑似被 --import 重写损坏(TMXYH5 教训),显式警示。
  es.addEventListener('import', function (ev) {
    var d = JSON.parse(ev.data);
    if (!d || d.type !== 'done') return;
    if (d.ok) {
      var gutted = d.report && Array.isArray(d.report.gutted) ? d.report.gutted.length : 0;
      $('statusBar').textContent = gutted > 0
        ? t('status.importDoneGutted', { n: gutted, path: d.projectPath || '' })
        : t('status.importDone', { path: d.projectPath || '' });
    } else {
      $('statusBar').textContent = t('status.importFail', { msg: String(d.error || '').slice(0, 120) });
    }
  });
  es.onerror = function () {
    $('statusBar').textContent = t('warn.reconnectingShort');
    // 持续失联 >10s(无 onopen):实例大概率已死,不再等自动重连,进自愈扫描(2026-09-16)
    if (Date.now() - lastOpenAt > 10000) { es.close(); recoverPanel(); return; }
    // 凭据失效(401/403)躺平提示(对齐 M-2 语义,真机实测教训):此场景实例活着但浏览器
    // 无有效凭据——迁移到别的实例同样 401,只会乒乓死循环;恢复指引用户重新打开。
    // (共享持久 token 下 401 基本只剩 cookie 被清/换浏览器场景)
    // 易用性批5 (2026-09-19):措辞从「凭证已失效」改为「需经 CLI 授权」——直访 URL
    // (无 token)的首个 401 不是"失效"是"尚未授权",原措辞误导首次直访用户。
    authFetch('/api/stats').then(function (r) {
      if (r.status === 401 || r.status === 403) {
        stopped = true; es.close();
        $('statusBar').textContent = t('warn.needAuth');
        var w = $('warn'); w.style.display = 'block';
        w.textContent = t('warn.needAuthDetail');
      }
    }).catch(function () { /* 网络瞬断,EventSource 自动重连 */ });
  };
})();
</script>
</body>
</html>
`;

/**
 * INDEX_HTML 内联脚本的 sha256/base64(CSP script-src 精确放行,审查 Low 2026-09-17 批 3)。
 * 模块加载时对模板静态计算——脚本内容变更后 hash 天然同步,无手工维护漂移面;
 * INDEX_HTML 仅一段无属性 <script>(代码评审契约:新增内联脚本须并段或同步改 CSP 消费方)。
 * 提取规则:**浏览器不剥前导换行**(2026-09-17 playwright 实证:真机面板 CSP violation,
 * 浏览器期望 hash 与"含前导换行"版逐字节匹配 txMCHDj5…;原"剥前导换行"实现被证伪,
 * OZf9I8dd… 被浏览器拒;html5lib RAWTEXT 解析旁证——script 内容原样进入 hash),
 * 仅 CRLF 归一 `\r\n→\n`(换行序列差异),尾换行保留——逐字节一致是 CSP hash 生效前提。
 */
export const INDEX_SCRIPT_SHA256: string = (() => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
  if (!m || m[1] === undefined) throw new Error('INDEX_HTML: inline <script> block not found for CSP hash');
  const body = m[1].replace(/\r\n/g, '\n');
  return createHash('sha256').update(body).digest('base64');
})();
