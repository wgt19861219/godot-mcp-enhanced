// Web GUI file:// 入口页(2026-09-16 入口简化批补强)
// 动机:http 书签 9550 在端口空置时浏览器直接 ERR_CONNECTION_REFUSED——连 HTML 都拿不到,
// 自愈无从谈起。本模块幂等写一个本地 portal.html 到 registry 目录,file:/// 书签永远可用:
// 页面 JS 扫描 9550-9569(no-cors fetch GET /,连接成功 resolve/失败 reject,兼容新旧 build),
// 命中活实例自动跳转(共享 token 的 cookie 随导航带),全死显示启动指引。
// 项目入口批(2026-09-16):同一份 HTML 再落一份「面板入口.html」到各 Godot 项目目录
// (ensureProjectPortalEntry)——registry 深路径难找,入口放用户天天开的项目文件夹。

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webGuiRegistryDir } from './registry.js';

const PORTAL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>godot-mcp-enhanced 面板入口</title>
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
<h1>godot-mcp-enhanced 监控面板</h1>
<div id="list"></div>
<div id="dead" style="display:none">
<p>当前没有运行中的面板服务(godot-mcp server 未启动)。</p>
<p>启动方式:打开任一 AI 客户端会话(面板随 godot-mcp server 自动启动),或运行<br><code>npx godot-mcp-enhanced dashboard --web</code></p>
<p>启动后<a href="#" onclick="location.reload();return false">刷新本页</a>即可自动进入。</p>
</div>
<p class="status" id="status">正在扫描本机面板服务…</p>
</div>
<script>
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
    st.textContent = '扫描完成:9550-9569 无响应。';
    return;
  }
  st.textContent = '发现 ' + found.length + ' 个实例,正在进入最新的一个…';
  for (var i = 0; i < found.length; i++) {
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = 'http://127.0.0.1:' + found[i] + '/';
    a.textContent = '实例 :' + found[i];
    list.appendChild(a);
  }
  // 自动进入第一个活实例(探测序即端口序;点击上方按钮可选其他实例)
  location.replace('http://127.0.0.1:' + found[0] + '/');
});
</script>
</body>
</html>
`;

/** 幂等写入口页到 registry 目录,返回绝对路径(dashboard --web 与 server.start 共用)。 */
export function ensurePortalPage(dir?: string): string {
  const d = dir ?? webGuiRegistryDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const filePath = join(d, 'portal.html');
  writeFileSync(filePath, PORTAL_HTML, { encoding: 'utf-8' });
  return filePath;
}

/** 项目目录入口文件名(中文,用户在项目文件夹一眼可辨;双击即扫描跳转活实例)。 */
export const PROJECT_ENTRY_NAME = '面板入口.html';

/** 幂等写入口页到 Godot 项目目录(2026-09-16 项目入口批)。
 * 动机:registry 深路径(~/.godot-mcp/web-gui/portal.html)真机反馈难找——入口直接放
 * 项目文件夹,资源管理器双击即用。护栏:dir/project.godot 存在才写,非 Godot 目录
 * 返回 null 不留文件;内容与 portal.html 同源(同一 PORTAL_HTML)。 */
export function ensureProjectPortalEntry(dir: string): string | null {
  if (!existsSync(join(dir, 'project.godot'))) return null;
  const filePath = join(dir, PROJECT_ENTRY_NAME);
  writeFileSync(filePath, PORTAL_HTML, { encoding: 'utf-8' });
  return filePath;
}

/** 幂等写入口页到 server 包根目录(2026-09-16 用户裁决:入口放本仓库根目录)。
 * 包根是自己的地盘,无 project.godot 护栏,无条件写——开发模式即仓库根,
 * npm 安装模式为 node_modules/godot-mcp-enhanced/(无害)。 */
export function ensurePackageRootEntry(root: string): string {
  const filePath = join(root, PROJECT_ENTRY_NAME);
  writeFileSync(filePath, PORTAL_HTML, { encoding: 'utf-8' });
  return filePath;
}
