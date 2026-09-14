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
  <section><h2>运行会话</h2><div class="scroll" id="sessions"><div class="empty">暂无会话</div></div></section>
  <section><h2>日志流 <span class="dim" id="logCount"></span></h2>
    <div class="log-tools"><input id="logFilter" placeholder="过滤:工具/模块/项目"><select id="logLevel"><option>ALL</option><option>INFO</option><option>WARN</option><option>ERROR</option></select></div>
    <div class="scroll" id="logList"></div></section>
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
  var state = { logs: [], stats: null, sessions: [], dedup: new Set() };
  var stopped = false;

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
    $('statusBar').textContent = '已连接';
    $('connInfo').textContent = payload.stats && payload.stats.mode ? ('mode: ' + payload.stats.mode) : '';
  }

  function renderSessions() {
    var host = $('sessions'); host.textContent = '';
    if (!state.sessions.length) { var d = document.createElement('div'); d.className = 'empty'; d.textContent = '暂无会话'; host.appendChild(d); return; }
    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    thead.textContent = '';
    var htr = document.createElement('tr');
    ['项目', '状态', 'pid', 'busy', '输出行'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    var tbody = document.createElement('tbody');
    state.sessions.forEach(function (s) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); td1.textContent = (s.displayPath || s.projectPath || '').split(/[\\\\/]/).pop() || s.projectPath; td1.title = s.displayPath;
      var td2 = document.createElement('td'); var b = document.createElement('span'); b.className = 'badge st-' + s.status; b.textContent = s.status; td2.appendChild(b);
      var td3 = document.createElement('td'); td3.textContent = String(s.pid == null ? '-' : s.pid);
      var td4 = document.createElement('td'); td4.textContent = s.busy ? '🔒 ' + s.busyOwner : '';
      var td5 = document.createElement('td'); td5.textContent = String(s.outputLines);
      tr.append(td1, td2, td3, td4, td5); tbody.appendChild(tr);
    });
    tbl.append(thead, tbody); host.appendChild(tbl);
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

  var es = new EventSource('/events?token=' + encodeURIComponent(token));
  es.addEventListener('hello', function (ev) { $('warn').style.display = 'none'; resetAll(JSON.parse(ev.data)); });
  es.addEventListener('log', function (ev) { pushLogs(JSON.parse(ev.data).entries || []); });
  es.addEventListener('sessions', function (ev) { state.sessions = JSON.parse(ev.data); renderSessions(); });
  es.addEventListener('stats', function (ev) { state.stats = JSON.parse(ev.data); renderStats(); });
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
