// Web GUI 单文件前端(设计 §4):原生 JS + 内联 CSS,无构建链无外链。
// token 经 URL query 进入 → sessionStorage → replaceState 清 query(设计 §5.2);
// 动态内容一律 textContent(防日志内容 XSS);EventSource 断线原生重连,hello 即整体重置。

export const INDEX_HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>godot-mcp-enhanced 监控面板</title>
<style>
  :root { --bg:#111418; --panel:#1a1f26; --line:#2a313b; --fg:#d7dde5; --dim:#7b8694;
          --green:#3fb950; --blue:#58a6ff; --yellow:#d29922; --red:#f85149; --orange:#db6d28; --grey:#6e7681; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.5 "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 14px; font-weight: 600; }
  header .dim { color: var(--dim); font-size: 12px; }
  #warn { display: none; background: #3d2e00; color: var(--yellow); padding: 4px 12px; font-size: 12px; }
  main { flex: 1; display: grid; grid-template-columns: 340px 1fr 420px; gap: 8px; padding: 8px; min-height: 0; }
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
  /* 项目面板批(spec §7.1):左列上项目(~55%)下会话(~45%),三列外框不变 */
  #left { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  #projPane { flex: 55 1 0; }
  #left > section:last-child { flex: 45 1 0; }
  .proj-row { display: flex; align-items: center; gap: 5px; padding: 3px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .proj-row .ctl { padding: 1px 6px; }
  .proj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-time { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .dot { font-size: 10px; line-height: 1; }
  .dot.run { color: var(--green); }
  .dot.missing { color: var(--red); }
  #addRow { display: none; }   /* 内联添加行,+添加按钮显隐切换(JS 置 style.display='flex') */
  /* 资源管理批(spec §6.1,2026-09-15):中列 tab 条 + 文件浏览视图 */
  .tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--dim);
         font: 12px "Segoe UI", system-ui, sans-serif; padding: 4px 10px; cursor: pointer; }
  .tab.on { color: var(--fg); border-bottom-color: var(--blue); }
  #logsPane, #filesPane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
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
</style>
</head>
<body>
<header>
  <h1>godot-mcp-enhanced 监控面板</h1>
  <span class="dim" id="statusBar">连接中…</span>
  <span class="dim" id="connInfo"></span>
</header>
<div id="warn"></div>
<main>
  <div id="left">
    <section id="projPane"><h2>项目</h2>
      <div class="log-tools"><input id="projSearch" placeholder="搜索:名称/路径"><button class="ctl" data-action="scan">扫描</button><button class="ctl" data-action="add">+添加</button></div>
      <div class="log-tools" id="addRow"><input id="addPath" placeholder="项目绝对路径(须在白名单内)"><button class="ctl" data-action="add-confirm">确定</button></div>
      <div class="scroll" id="projList"><div class="empty">加载中…</div></div></section>
    <section><h2>运行会话</h2><div class="scroll" id="sessions"><div class="empty">暂无会话</div></div></section>
  </div>
  <section><h2><span id="midTitle">日志流</span> <span class="dim" id="logCount"></span></h2>
    <div class="tabs"><button type="button" id="tabLogs" class="tab on">日志</button><button type="button" id="tabFiles" class="tab">文件</button></div>
    <div id="logsPane">
      <div class="log-tools"><input id="logFilter" placeholder="过滤:工具/模块/项目"><select id="logLevel"><option>ALL</option><option>INFO</option><option>WARN</option><option>ERROR</option></select></div>
      <div class="scroll" id="logList"></div>
    </div>
    <div id="filesPane" style="display:none"><div class="empty">点击左侧项目行的「文件」按钮浏览项目目录</div></div></section>
  <section><h2>工具统计 <select id="projSel"><option value="">全部</option></select></h2>
    <div class="scroll"><table id="statsTable"><thead><tr><th>tool</th><th>calls</th><th>err</th><th>avg</th><th>min</th><th>max</th></tr></thead><tbody></tbody></table></div>
    <h2 style="border-top:1px solid var(--line)">分钟时序</h2><div id="chart"><div class="empty" style="flex:1">等待数据…</div></div></section>
</main>
<script>
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || sessionStorage.getItem('gui-token') || '';
  if (token) { sessionStorage.setItem('gui-token', token); history.replaceState(null, '', location.pathname); }
  // cookie 双通道握手:用手头 token 换 HttpOnly cookie,此后请求 cookie 自动携带——
  // 免疫 URL query 被隐私扩展剥除/截断(query 丢失导致面板全断的真机事件)。
  // 失败不阻塞:query 通道兜底,哪个通用哪个;响应体无需处理。
  if (token) { fetch('/api/auth?token=' + encodeURIComponent(token)).catch(function () { /* 握手失败不阻塞:query 通道兜底 */ }); }
  var $ = function (id) { return document.getElementById(id); };
  var state = { logs: [], stats: null, sessions: [], projects: null, dedup: new Set(), readOnly: false };
  var stopped = false;
  // 文件浏览状态(spec §6.1,Task 5 消费):当前项目/当前子目录/当前目录条目快照。
  var filesState = { project: null, sub: '', entries: [] };
  // 编辑视图状态(spec §6.3,Task 5):固定对象只改字段、从不重建——CM change 回调
  // 闭包引用须稳定;latest 为 409 冲突时的服务端最新版(Task 2 契约 {content,mtime})。
  // readOnly 信号源:hello 无此字段(不发明协议),复用现有 403 响应体 'read-only' 判定
  // (startSession I-2 先例 + 保存 POST 403 触发 enterReadOnly 置位)。
  var editorState = { rel: null, baseMtime: 0, dirty: false, cm: null, latest: null };

  function authFetch(path) { return fetch(path, { headers: { 'X-GUI-Token': token } }); }

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
    $('statusBar').textContent = '已连接';
    $('connInfo').textContent = payload.stats && payload.stats.mode ? ('mode: ' + payload.stats.mode) : '';
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
    btn.textContent = alive ? '停止' : '清理';
    btn.setAttribute('data-action', alive ? 'stop' : 'remove');
    btn.setAttribute('data-project', s.projectPath);
    return btn;
  }

  function renderSessions() {
    var host = $('sessions'); host.textContent = '';
    if (!state.sessions.length) { var d = document.createElement('div'); d.className = 'empty'; d.textContent = '暂无会话'; host.appendChild(d); return; }
    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    thead.textContent = '';
    var htr = document.createElement('tr');
    ['项目', '状态', 'pid', 'busy', '输出行', '操作'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    var tbody = document.createElement('tbody');
    state.sessions.forEach(function (s) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); td1.textContent = (s.displayPath || s.projectPath || '').split(/[\\\\/]/).pop() || s.projectPath; td1.title = s.displayPath;
      var td2 = document.createElement('td'); var b = document.createElement('span'); b.className = 'badge st-' + s.status; b.textContent = s.status; td2.appendChild(b);
      var td3 = document.createElement('td'); td3.textContent = String(s.pid == null ? '-' : s.pid);
      var td4 = document.createElement('td'); td4.textContent = s.busy ? '🔒 ' + s.busyOwner : '';
      var td5 = document.createElement('td'); td5.textContent = String(s.outputLines);
      var td6 = document.createElement('td'); td6.appendChild(sessionControl(s));
      tr.append(td1, td2, td3, td4, td5, td6); tbody.appendChild(tr);
    });
    tbl.append(thead, tbody); host.appendChild(tbl);
  }

  // ── 项目面板(spec §7.2/§7.3,2026-09-15)────────────────────────────────────
  // ProjectView 契约(Task 3):{path,name,addedAt,source,mtime,missing,running,sessionId}
  // 行按钮零监听器、只带 data-action(run|edit|remove)+data-path,点击由 #projPane
  // 容器一次性委托接管(同 #sessions 2026-09-15 修复模式:容器本体在重绘中不被替换)。
  function fmtAgo(ms) {
    if (ms == null) return '-';
    var diff = Date.now() - ms; if (diff < 0) diff = 0;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
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
      var d = document.createElement('div'); d.className = 'empty'; d.textContent = '项目功能未配置';
      host.appendChild(d); return;
    }
    var q = $('projSearch').value.toLowerCase();
    var rows = state.projects.filter(function (p) {   // 名称/路径子串,不区分大小写
      if (!q) return true;
      return ((p.name || '') + (p.path || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = state.projects.length ? '无匹配项目' : '暂无项目,点击「扫描」发现';
      host.appendChild(e); return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (p) {
      var row = document.createElement('div'); row.className = 'proj-row';
      var run = document.createElement('button'); run.className = 'ctl'; run.textContent = '▶'; run.title = '运行';
      run.setAttribute('data-action', 'run'); run.setAttribute('data-path', p.path);
      var edit = document.createElement('button'); edit.className = 'ctl'; edit.textContent = '✎'; edit.title = '编辑';
      edit.setAttribute('data-action', 'edit'); edit.setAttribute('data-path', p.path);
      var files = document.createElement('button'); files.className = 'ctl'; files.textContent = '文件'; files.title = '浏览文件';
      files.setAttribute('data-action', 'files'); files.setAttribute('data-path', p.path);
      if (p.missing) { run.disabled = true; edit.disabled = true; files.disabled = true; run.title = '路径不存在'; edit.title = '路径不存在'; files.title = '路径不存在'; }
      var name = document.createElement('span'); name.className = 'proj-name';
      name.textContent = p.name || (p.path || '').split(/[\\\\/]/).pop() || p.path; name.title = p.path;   // title=完整路径
      var time = document.createElement('span'); time.className = 'proj-time'; time.textContent = fmtAgo(p.mtime);
      var badge = document.createElement('span');
      if (p.missing) { badge.className = 'dot missing'; badge.textContent = '●'; badge.title = '路径不存在'; }
      else if (p.running) { badge.className = 'dot run'; badge.textContent = '●'; badge.title = '运行中'; }
      var rm = document.createElement('button'); rm.className = 'ctl stop'; rm.textContent = '×'; rm.title = '从列表移除';
      rm.setAttribute('data-action', 'remove'); rm.setAttribute('data-path', p.path);
      row.append(run, edit, files, name, time, badge, rm); frag.appendChild(row);
    });
    host.appendChild(frag);
  }

  // 行内 Run/Edit → POST /api/sessions/start(spec §4:mode 缺省 run;此处恒显式)
  function startSession(path, mode) {
    $('statusBar').textContent = (mode === 'run' ? '启动中… ' : '编辑器拉起中… ') + path;
    fetch('/api/sessions/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ projectPath: path, mode: mode }),
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          // 403 双源区分(I-2):READ_ONLY 拦截响应体 {error:'read-only mode'},提示只读
          // 而非误导用户排查白名单;白名单外仍是原文案。Task 5:判定命中时同步置
          // state.readOnly——编辑视图打开即只读,免得用户编辑半天才在保存时被 403。
          var msg;
          if (r.status === 403 && t.indexOf('read-only') !== -1) { state.readOnly = true; msg = '只读模式，面板启动已禁用'; }
          else if (r.status === 403) msg = '路径在白名单之外';
          else msg = r.status === 404 ? '不是 Godot 项目' : t.slice(0, 80);
          $('statusBar').textContent = '启动失败: ' + msg;
        });
      }
      $('statusBar').textContent = mode === 'run' ? '启动指令已发出,等待会话出现' : '编辑器已拉起';
    }).catch(function () { $('statusBar').textContent = '网络异常,启动请求未送达'; });
  }

  // 移除仅出清单不删文件;原生 confirm(CSP 不受限)
  function removeProject(path) {
    var name = (path || '').split(/[\\\\/]/).pop() || path;
    if (!confirm('仅从列表移除，不删除文件。确定移除 ' + name + '?')) return;
    $('statusBar').textContent = '移除中… ' + name;
    fetch('/api/projects/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ path: path }),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { $('statusBar').textContent = '移除失败: ' + t.slice(0, 80); });
      $('statusBar').textContent = '已从列表移除 ' + name;   // 列表本身由 SSE projects 快照刷新
    }).catch(function () { $('statusBar').textContent = '网络异常,移除请求未送达'; });
  }

  // 扫描:异步起,立即返回;进度与结果由 SSE projects 事件接管(spec §4/§5)
  function startScan() {
    $('statusBar').textContent = '扫描中…';
    fetch('/api/projects/scan', { method: 'POST', headers: { 'x-gui-token': token } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        if (!r.ok) { $('statusBar').textContent = '扫描失败: ' + JSON.stringify(r.body).slice(0, 80); return; }
        if (r.body && r.body.started === false) { $('statusBar').textContent = '扫描已在进行中,进度见状态栏'; return; }   // §3.1.1 互斥
        $('statusBar').textContent = '扫描中…';   // SSE 接管进度显示
      })
      .catch(function () { $('statusBar').textContent = '网络异常,扫描请求未送达'; });
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
    if (!p) { $('statusBar').textContent = '请输入项目绝对路径'; return; }
    $('statusBar').textContent = '添加中…';
    fetch('/api/projects/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ path: p }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        var body = r.body || {};
        if (r.ok && body.ok === false) {   // 200 + {ok:false,reason}(Task 3 契约:duplicate|full)
          $('statusBar').textContent = body.reason === 'duplicate' ? '该路径已在清单中' : '清单已满(200 上限)';
          return;
        }
        if (!r.ok) {
          $('statusBar').textContent = r.status === 403 ? '路径在白名单之外'
            : (r.status === 404 ? '不是 Godot 项目(缺 project.godot)' : '添加失败: ' + JSON.stringify(body).slice(0, 80));
          return;
        }
        $('statusBar').textContent = '已添加';
        $('addRow').style.display = 'none'; $('addPath').value = '';
      })
      .catch(function () { $('statusBar').textContent = '网络异常,添加请求未送达'; });
  }

  // ── 文件浏览(spec §6.1/§6.2,2026-09-15 资源管理批)────────────────────────
  // 契约(Task 2):GET /api/projects/files?project=&sub= → {entries:[{name,isDir,size,mtime}]};
  // 目录先排序与隐藏目录(.godot/.git 等)降噪均由 server 侧完成(files-api.ts),前端不重复。
  // 中列 tab 切换:切 display + tab 按钮高亮 + 列标题同步(Task 4 审查 Minor 2:文件
  // tab 激活时中列头不再误显「日志流」);Task 5 补脏标防误切——编辑器有未保存修改时
  // 切回日志 tab 需 confirm(spec §6.3;切「文件」不拦,编辑视图仍保留可切回)。
  function showTab(name) {
    var logs = name === 'logs';
    if (logs && dirtyBlock()) return;
    $('tabLogs').className = 'tab' + (logs ? ' on' : '');
    $('tabFiles').className = 'tab' + (logs ? '' : ' on');
    $('midTitle').textContent = logs ? '日志流' : '文件';
    $('logsPane').style.display = logs ? 'flex' : 'none';
    $('filesPane').style.display = logs ? 'none' : 'flex';
  }

  function openFiles(projectPath) {
    if (dirtyBlock()) return;   // 换项目浏览=丢弃当前编辑视图,同属脏标防误切
    // entries 重置(Task 4 审查 Minor 1):防 loadDir 失败时 #filesPane 保留上一项目旧渲染。
    filesState.project = projectPath; filesState.sub = ''; filesState.entries = [];
    showTab('files'); loadDir();
  }

  function loadDir() {
    if (!filesState.project) return;
    $('statusBar').textContent = '读取目录中…';
    fetch('/api/projects/files?project=' + encodeURIComponent(filesState.project) + '&sub=' + encodeURIComponent(filesState.sub),
      { headers: { 'x-gui-token': token } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (r) {
        if (!r.ok) {
          var msg = r.status === 403 ? '路径在白名单之外'
            : (r.status === 404 ? '不是 Godot 项目(缺 project.godot)'
            : (r.status === 503 ? '文件功能未配置' : JSON.stringify(r.body).slice(0, 80)));
          $('statusBar').textContent = '目录读取失败: ' + msg;
          return;
        }
        filesState.entries = (r.body && r.body.entries) || [];
        renderFiles();
        $('statusBar').textContent = '目录已加载';
      })
      .catch(function () { $('statusBar').textContent = '网络异常,目录请求未送达'; });
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
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '空目录';
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
    // TEXT → 编辑视图(spec §6.3,Task 5):rel=sub 前缀拼全(Task 2 契约 path 相对项目根);
    // IMG/AUDIO/其余仍为占位,由 Plan B 替换为预览视图(spec §6.4)。
    if (TEXT_EXTS.indexOf(e) !== -1) { openEditor(filesState.sub ? filesState.sub + '/' + name : name); return; }
    if (IMG_EXTS.indexOf(e) !== -1) { $('statusBar').textContent = '图片预览(Plan B): ' + name; return; }
    if (AUDIO_EXTS.indexOf(e) !== -1) { $('statusBar').textContent = '音频播放(Plan B): ' + name; return; }
    $('statusBar').textContent = '二进制预览(Plan B): ' + name;
  }

  // ── 编辑视图(spec §6.3,2026-09-15 资源管理批 Task 5)──────────────────────
  // 脏标防误切:一切离开编辑视图的动作(切日志 tab/目录导航/换项目浏览/重新加载/
  // 返回列表)统一走此把守;rel 为 null(不在编辑视图)时不拦。
  function dirtyBlock() {
    return !!(editorState.rel && editorState.dirty && !confirm('有未保存修改,离开将丢失'));
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
    $('statusBar').textContent = '读取文件中… ' + rel;
    fetch('/api/projects/file?project=' + encodeURIComponent(filesState.project) + '&path=' + encodeURIComponent(rel) + '&mode=text',
      { headers: { 'x-gui-token': token } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (r) {
        if (!r.ok) {
          var msg = r.status === 400 ? '不支持的扩展名(非文本类)'
            : (r.status === 403 ? '路径在白名单之外'
            : (r.status === 404 ? '文件不存在'
            : (r.status === 413 ? '文件超限' : JSON.stringify(r.body).slice(0, 80))));
          $('statusBar').textContent = '文件读取失败: ' + msg;
          return;
        }
        editorState.rel = rel; editorState.baseMtime = r.body.mtime; editorState.dirty = false; editorState.latest = null;
        renderEditor(rel, r.body.content, r.body.mtime, r.body.size);
      })
      .catch(function () { $('statusBar').textContent = '网络异常,文件请求未送达'; });
  }

  // 编辑子视图(替换 #filesPane 内容):工具行(保存/重新加载/返回列表)+ 只读横幅 +
  // 409 冲突条(默认隐藏)+ CM 宿主 textarea + 状态栏。按钮全部零监听器、只带
  // data-action,由 #filesPane 容器委托接管(同 renderFiles 模式:容器本体永续)。
  function renderEditor(rel, content, mtime, size) {
    editorState.cm = null;   // 旧实例随上一次视图 DOM 丢弃;新 textarea 待 CM 回调升级
    var host = $('filesPane'); host.textContent = '';
    var tools = document.createElement('div'); tools.className = 'log-tools';
    var save = document.createElement('button'); save.className = 'ctl'; save.id = 'edSave'; save.textContent = '保存';
    save.setAttribute('data-action', 'editor-save');
    var reload = document.createElement('button'); reload.className = 'ctl'; reload.textContent = '重新加载';
    reload.setAttribute('data-action', 'editor-reload');
    var back = document.createElement('button'); back.className = 'ctl'; back.textContent = '返回列表';
    back.setAttribute('data-action', 'editor-back');
    if (state.readOnly) save.style.display = 'none';   // readOnly:保存钮隐藏(spec §6.3)
    tools.append(save, reload, back); host.appendChild(tools);
    var ro = document.createElement('div'); ro.className = 'ed-banner'; ro.id = 'edRoBanner';
    ro.textContent = '只读模式:服务端为 READ_ONLY,保存已禁用';
    if (state.readOnly) ro.style.display = 'flex';
    host.appendChild(ro);
    var cf = document.createElement('div'); cf.className = 'ed-conflict'; cf.id = 'edConflict';
    var cfTxt = document.createElement('span'); cfTxt.textContent = '文件已被外部修改(可能是 Godot 编辑器或 AI)';
    var cfReload = document.createElement('button'); cfReload.className = 'ctl'; cfReload.textContent = '重新加载';
    cfReload.setAttribute('data-action', 'conflict-reload');
    var cfCopy = document.createElement('button'); cfCopy.className = 'ctl'; cfCopy.textContent = '复制我的修改';
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
        var b = $('edSave'); if (b) b.textContent = '● 保存';   // 未保存指示(spec §6.3)
      });
    });
    $('statusBar').textContent = '已打开 ' + rel;
  }

  // 保存流(spec §3.3 三重护栏的 UI 端):POST 携 baseMtime 乐观锁;200 前进本地
  // mtime+清脏标;409 弹冲突条(latest 消费);413/403/404 就地报错。
  function saveEditor() {
    if (!editorState.rel || !filesState.project) return;
    var content = editorState.cm ? editorState.cm.getValue() : ($('cmHost') ? $('cmHost').value : '');
    var btn = $('edSave'); if (btn) btn.disabled = true;
    $('edStatus').textContent = '保存中…';
    fetch('/api/projects/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gui-token': token },
      body: JSON.stringify({ project: filesState.project, path: editorState.rel, content: content, baseMtime: editorState.baseMtime }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (r) {
        if (btn) btn.disabled = false;
        if (r.ok) {
          editorState.baseMtime = r.body.mtime; editorState.dirty = false;
          if (btn) btn.textContent = '保存';
          $('edStatus').textContent = '已保存 · ' + new Date(r.body.mtime).toLocaleString();
          return;
        }
        if (r.status === 409) { showConflict(r.body && r.body.latest); return; }
        if (r.status === 403) {   // 双源区分(对齐 startSession I-2 判定)
          if (JSON.stringify(r.body).indexOf('read-only') !== -1) { enterReadOnly(); return; }
          $('edStatus').textContent = '保存失败: 路径在白名单之外';
          return;
        }
        var msg = r.status === 413 ? '内容超限(600KB)' : (r.status === 404 ? '文件不存在(可能已被删除)' : JSON.stringify(r.body).slice(0, 80));
        $('edStatus').textContent = '保存失败: ' + msg;
      })
      .catch(function () { if (btn) btn.disabled = false; $('edStatus').textContent = '网络异常,保存请求未送达'; });
  }

  // 409 冲突条显示:latest 存 editorState 供「重新加载」按钮消费(Task 2 契约
  // 409 body {error, latest:{content,mtime}})。
  function showConflict(latest) {
    editorState.latest = latest || null;
    var bar = $('edConflict'); if (bar) bar.style.display = 'flex';
    $('edStatus').textContent = '保存冲突: ' + (editorState.rel || '');
  }

  // readOnly 置位(spec §6.3):保存 403 read-only 响应体触发;此后打开的编辑器
  // 直接只读(服务端 READ_ONLY 为启动期 env,运行期不变,置位后无需复位)。
  function enterReadOnly() {
    state.readOnly = true;
    if (editorState.cm) editorState.cm.setOption('readOnly', true);
    var b = $('edSave'); if (b) b.style.display = 'none';
    var banner = $('edRoBanner'); if (banner) banner.style.display = 'flex';
    $('edStatus').textContent = '只读模式:保存已禁用';
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
    var sb = $('edSave'); if (sb) sb.textContent = '保存';
    $('edStatus').textContent = '已重载外部版本 · ' + new Date(lt.mtime).toLocaleString();
  }

  // 409 冲突条「复制我的修改」:抢救本地输入到剪贴板(localhost 为 secure context,
  // clipboard API 可用;失败给手动兜底提示)。
  function conflictCopy() {
    var mine = editorState.cm ? editorState.cm.getValue() : ($('cmHost') ? $('cmHost').value : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mine).then(
        function () { $('edStatus').textContent = '已复制我的修改到剪贴板'; },
        function () { $('edStatus').textContent = '复制失败,请手动全选复制'; });
    } else { $('edStatus').textContent = '剪贴板不可用,请手动全选复制'; }
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
      var t = document.createElement('span'); t.className = 't'; t.textContent = (e.ts || '').slice(11, 19);
      div.appendChild(t); div.appendChild(document.createTextNode(e.msg || ''));
      frag.appendChild(div);
    });
    host.appendChild(frag); if (stick) host.scrollTop = host.scrollHeight;
    $('logCount').textContent = state.logs.length + ' 条';
  }

  function renderStats() {
    var s = state.stats; if (!s) return;
    var sel = $('projSel'); var cur = sel.value;
    var view = cur && s.projects && s.projects[cur] ? s.projects[cur] : s;
    var rows = (view.toolStats || []).slice().sort(function (a, b) { return b.calls - a.calls; });
    var tbody = $('statsTable').querySelector('tbody'); tbody.textContent = '';
    rows.forEach(function (t) {
      var tr = document.createElement('tr');
      [t.tool, t.calls, t.errors, Math.round(t.totalDurationMs / Math.max(1, t.calls)), t.minDurationMs, t.maxDurationMs].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // 项目切换器选项刷新(保留当前选择)
    var keys = s.projects ? Object.keys(s.projects) : [];
    if (cur && keys.indexOf(cur) === -1) keys.unshift(cur);
    sel.textContent = '';
    var optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部'; sel.appendChild(optAll);
    keys.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k.split(/[\\\\/]/).pop() || k; o.title = k; sel.appendChild(o); });
    sel.value = cur;
    // 时序柱状图(纯 CSS)
    var chart = $('chart'); chart.textContent = '';
    var ts = view.timeSeries || []; var max = 1;
    ts.forEach(function (b) { max = Math.max(max, b.calls); });
    ts.forEach(function (b) {
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
    if (action === 'files') { openFiles(path); return; }
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
    $('statusBar').textContent = action === 'stop' ? '停止中… ' + project : '清理中… ' + project;
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
        return r.text().then(function (t) { $('statusBar').textContent = '操作失败: ' + t.slice(0, 80); });
      }
      $('statusBar').textContent = '操作已提交';
    }).catch(function () {
      btn.disabled = false;
      $('statusBar').textContent = '网络异常,操作未送达';
    });
  });

  // 中列 tab 切换(资源管理批 spec §6.1):tab 按钮为静态 DOM、从不重绘,直接绑定
  // (与 logFilter/projSearch 静态控件同模式;重绘容器内的按钮才须走 data-action 委托)。
  $('tabLogs').addEventListener('click', function () { showTab('logs'); });
  $('tabFiles').addEventListener('click', function () { showTab('files'); });

  // #filesPane 容器一次性事件委托(资源管理批 spec §6.2/§6.3):面包屑段([data-sub]
  // 回根/回跳层级)、目录行([data-dir] 进子目录)、文件行([data-file] →
  // openFileEntry)与编辑视图工具行/冲突条按钮(button[data-action]:editor-save|
  // editor-reload|editor-back|conflict-reload|conflict-copy)全部零监听器——
  // renderFiles/renderEditor 重绘只清空容器内部,委托永续;目录导航类动作进
  // 编辑器脏标把守(spec §6.3)。
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
    if (p && p.scanning === true) { $('statusBar').textContent = '扫描中 已发现 ' + (p.found || 0) + ' / 已扫描 ' + (p.scanned || 0); return; }
    if (p && p.scanning === false) { $('statusBar').textContent = p.failed ? '扫描失败,可重试;详情见 server 日志' : '扫描完成 新增 ' + (p.added || 0) + ' 个项目'; }
  });
  es.onerror = function () {
    $('statusBar').textContent = '连接中断,重连中…';
    // token 失效(server 重启端口复用)探测:401 时停 EventSource 防死循环(设计 M-2)
    if (stopped) return;
    authFetch('/api/stats').then(function (r) {
      if (r.status === 401 || r.status === 403) {
        stopped = true; es.close();
        $('statusBar').textContent = '面板已失效(server 已重启),请重新运行 dashboard --web';
        $('warn').style.display = 'block'; $('warn').textContent = '会话凭证已失效,请重新打开面板';
      }
    }).catch(function () { /* 网络瞬断,EventSource 自动重连 */ });
  };
})();
</script>
</body>
</html>
`;
