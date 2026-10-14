// Web GUI file:// 入口页(2026-09-16 入口简化批补强)
// 动机:http 书签 9550 在端口空置时浏览器直接 ERR_CONNECTION_REFUSED——连 HTML 都拿不到,
// 自愈无从谈起。本模块幂等写一个本地 portal.html 到 registry 目录,file:/// 书签永远可用:
// 页面 JS 扫描 9550-9569(no-cors fetch GET /,连接成功 resolve/失败 reject,兼容新旧 build),
// 命中活实例自动跳转(共享 token 的 cookie 随导航带),全死显示启动指引。
// 项目入口批(2026-09-16):同一份 HTML 再落一份「面板入口.html」到各 Godot 项目目录
// (ensureProjectPortalEntry)——registry 深路径难找,入口放用户天天开的项目文件夹。
// 零门槛授权(2026-09-16 用户裁决):包根入口页内嵌 token(ensurePackageRootEntry,跳转 URL
// 自动带 #token=,双击直达免 CLI 首授权);项目目录版不内嵌(目录可能被 git 跟踪/分享,
// token 进公开仓库会配合恶意网页形成攻击链),registry 版保持纯净模板。
// 2B (2026-09-19 安全加固批2): 传递形态 query → hash——token 不进服务器访问日志/Referer。

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webGuiRegistryDir, hardenFilePermissionsWindows, SHARED_TOKEN_RE } from './registry.js';
import { serializeI18nForInline } from './i18n.js';

/** 构建入口页 HTML。token 非空时内嵌(跳转 URL 带 #token=,面板读 hash 握手 cookie 后清 URL,
 *  首次即过鉴权;token 不进 query/服务器日志);形状不符 SHARED_TOKEN_RE 一律按空处理(插值安全:hex 字符集,JSON.stringify 再兜底)。
 *  preferredPort(根治批 2026-10-08):写入方(server 实例)内嵌自身端口——新实例启动必重写
 *  入口页,start() 即写,故 preferred = 最近启动的实例;打开时探测活着优先跳它,死了或未内嵌
 *  (CLI/registry 层重写,无实例上下文)回退挑最大端口(顺延语义下后占高位的多为新实例)。
 *  修复前挑 found[0](第一个活实例):9550 旧实例常驻时新实例永远轮不到(真机验收发现)。 */
export function buildPortalHtml(token?: string, preferredPort?: number): string {
  const safeToken = token && SHARED_TOKEN_RE.test(token) ? token : '';
  const safePort = Number.isInteger(preferredPort) && preferredPort! > 0 && preferredPort! < 65536 ? preferredPort! : 0;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title data-i18n="portal.title">godot-mcp-enhanced 面板入口</title>
<style>
body{font-family:system-ui,sans-serif;background:#16181d;color:#d7dce3;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{max-width:520px;padding:32px}
h1{font-size:18px;margin:0 0 12px}
p{font-size:14px;line-height:1.7;color:#9aa3ad;margin:8px 0}
code{background:#22262d;padding:2px 6px;border-radius:4px;font-size:13px}
ul{padding-left:0;list-style:none}
a.btn{display:inline-block;margin:6px 8px 6px 0;padding:8px 16px;background:#2d6cdf;color:#fff;border-radius:6px;text-decoration:none;font-size:14px}
.status{margin-top:16px;font-size:13px;color:#6f7882}
</style>
</head>
<body>
<div class="box">
<h1 data-i18n="header.title">godot-mcp-enhanced 监控面板</h1>
<div id="list"></div>
<div id="dead" style="display:none">
<p data-i18n="portal.dead.p1">当前没有运行中的面板服务(godot-mcp server 未启动)。</p>
<p><span data-i18n="portal.dead.p2">启动方式:打开任一 AI 客户端会话(面板随 godot-mcp server 自动启动),或运行</span><br><code>npx godot-mcp-enhanced dashboard --web</code></p>
<p><span data-i18n="portal.dead.p3pre">启动后</span><a href="#" onclick="location.reload();return false" data-i18n="portal.dead.refresh">刷新本页</a><span data-i18n="portal.dead.p3post">即可自动进入。</span></p>
</div>
<p class="status" id="status" data-i18n="portal.scanning">正在扫描本机面板服务…</p>
</div>
<script>
// i18n(2026-10-13):navigator.language 自动检测(zh* → zh,其余 en),无手动切换——
// 入口页存活数秒即跳转,与主面板语言偏好(localStorage)不联动(file:// 与 http
// origin 隔离,读不到);中文为 zh 兜底,en 时下方 data-i18n 替换。
var I18N = ${serializeI18nForInline(['portal.', 'header.'])};
var LANG = String(navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
function t(key, params) {
  var s = (I18N[LANG] && I18N[LANG][key]) || I18N.zh[key] || key;
  if (params) { for (var k in params) s = s.split('{' + k + '}').join(String(params[k])); }
  return s;
}
if (LANG === 'en') {
  document.title = t('portal.title');
  document.documentElement.lang = 'en';
  var els = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
}
var TOKEN = ${JSON.stringify(safeToken)};
var PREFERRED = ${JSON.stringify(safePort)};
// 2B (2026-09-19 安全加固批2): token 经 hash(#token=)传递而非 query——hash 不发给服务器
// (访问日志/Referer 不含 token),面板侧读 hash 握手 cookie 后 replaceState 连 hash 清除,
// session/history 最终为干净 URL。query 通道由 CLI 打开旧链保留,portal 不再使用。
function withToken(url) {
  return TOKEN ? url + '#token=' + encodeURIComponent(TOKEN) : url;
}
function probe(port) {
  return new Promise(function (resolve) {
    fetch('http://127.0.0.1:' + port + '/', { mode: 'no-cors' })
      .then(function () { resolve(port); })
      .catch(function () { resolve(-1); });
  });
}
var probes = [];
for (var p = 9550; p <= 9569; p++) probes.push(probe(p));
Promise.all(probes).then(function (alive) {
  var found = alive.filter(function (p) { return p >= 0; });
  var st = document.getElementById('status');
  var list = document.getElementById('list');
  if (found.length === 0) {
    document.getElementById('dead').style.display = 'block';
    st.textContent = t('portal.scanDone');
    return;
  }
  // 挑选(根治批 2026-10-08):preferred 活着优先(写入入口页的最近启动实例);
  // 否则回退最大端口。探测为 no-cors opaque(读不到版本,给 health 开 CORS 会推翻
  // M-4 收紧决策),故 preferred 是零安全代价下最准的"最新实例"判据。
  var target = (PREFERRED && found.indexOf(PREFERRED) !== -1) ? PREFERRED : found[found.length - 1];
  st.textContent = t('portal.found', { n: found.length, port: target });
  for (var i = 0; i < found.length; i++) {
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = withToken('http://127.0.0.1:' + found[i] + '/');
    a.textContent = (found[i] === target ? '★ ' : '') + t('portal.instance', { port: found[i] });
    list.appendChild(a);
  }
  // 自动进入 target(★ 标注;点击上方按钮可选其他实例);
  // 内嵌 token 时 URL 带 #token= → 首次即过鉴权,前端握手种 cookie 后长期免带。
  location.replace(withToken('http://127.0.0.1:' + target + '/'));
});
</script>
</body>
</html>
`;
}

/** 幂等写入口页到 registry 目录,返回绝对路径(dashboard --web 与 server.start 共用)。
 *  preferredPort 由 server 侧传入(自身端口);CLI 调用方无实例上下文,缺省不内嵌(回退最大端口)。 */
export function ensurePortalPage(dir?: string, preferredPort?: number): string {
  const d = dir ?? webGuiRegistryDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const filePath = join(d, 'portal.html');
  writeFileSync(filePath, buildPortalHtml(undefined, preferredPort), { encoding: 'utf-8' });
  return filePath;
}

/** 项目目录入口文件名(中文,用户在项目文件夹一眼可辨;双击即扫描跳转活实例)。 */
export const PROJECT_ENTRY_NAME = '面板入口.html';

/** 幂等写入口页到 Godot 项目目录(2026-09-16 项目入口批)。不内嵌 token。
 * 动机:registry 深路径(~/.godot-mcp/web-gui/portal.html)真机反馈难找——入口直接放
 * 项目文件夹,资源管理器双击即用。护栏:dir/project.godot 存在才写,非 Godot 目录
 * 返回 null 不留文件;内容与 portal.html 同源(同一模板)。 */
export function ensureProjectPortalEntry(dir: string, preferredPort?: number): string | null {
  if (!existsSync(join(dir, 'project.godot'))) return null;
  const filePath = join(dir, PROJECT_ENTRY_NAME);
  writeFileSync(filePath, buildPortalHtml(undefined, preferredPort), { encoding: 'utf-8' });
  return filePath;
}

/** 幂等写入口页到 server 包根目录,内嵌 token(2026-09-16 零门槛授权,用户裁决)。
 * 双击即带 ?token= 跳转——首次访问即过鉴权并种 cookie,免 CLI/bat 首授权。
 * 开发模式即本仓库根(已 gitignore),npm 模式为 node_modules 内(不入用户 git)。
 * token 落盘按 registry 同款收紧:0o600 + Windows icacls(同机多用户防读)。 */
export function ensurePackageRootEntry(root: string, token: string, preferredPort?: number): string {
  const filePath = join(root, PROJECT_ENTRY_NAME);
  writeFileSync(filePath, buildPortalHtml(token, preferredPort), { encoding: 'utf-8', mode: 0o600 });
  hardenFilePermissionsWindows(filePath);
  return filePath;
}
