# Web GUI 资源管理工作台 — 设计文档

> 状态:v2(2026-09-15,独立审阅 1B+7I+8M 全采纳修订;审阅者实测证据见修订记录)
> 前置:Web GUI 监控面板(2026-09-14)+ 项目面板(2026-09-15)已合并 master。
> 用户决策记录(2026-09-15 AskUserQuestion 两轮):三阶段全做(浏览+编辑+二进制预览)/内嵌 CodeMirror/同源资产端点/三重护栏/项目行入口/单 spec 双 plan。

## 1. 目标与成功标准

在 Web GUI 面板上管理 Godot 项目的游戏资源:从项目面板行进入该项目文件树,浏览目录、编辑文本资源(.gd/.tscn/.tres/.json 等)、预览二进制资源(图片/音频内联,其余 hex 视图)。

**成功标准**:
1. 浏览:点项目行「文件」→ 中列日志区(主区)切「文件」tab → 逐层目录导航,目录在前字母序,`.godot/`/`.git/` 默认隐藏
2. 编辑:文本文件进 CodeMirror(gd 用 python 近似高亮/json/markdown),保存走三重护栏,readOnly 模式只读
3. 预览:png/jpg/webp/svg 内联显示,ogg/wav/mp3 audio 播放,其余二进制 hex 视图(前 4KB 采样)
4. 安全:全链路白名单 + 路径逃逸防御,浏览器永不直接碰文件系统,所有读写经 server
5. 真机验收:fixture 项目浏览→编辑→保存→backups 生成→人为并发改文件→409 冲突提示

## 2. 范围

### 范围内
- files-api 模块(列目录/读文件三模式/保存三护栏/hex 采样)
- server 4 组新端点(files/file POST file/assets)+ CSP 放宽
- CodeMirror 5 构建链(npm dep + build 按需拷贝)
- 前端文件 tab(浏览视图 + 编辑器视图 + 预览视图)
- 集中式备份目录 `~/.godot-mcp/web-gui/backups/`

### 范围外(明确不做)
- 视频预览(体积+解码成本,后置)
- 文件/目录的创建/删除/重命名(本批只读浏览+编辑保存,管理操作后置)
- GDScript 精确语法高亮(simple-mode 自定义 token 是后续 nice-to-have,第一版 python 近似)
- 文件上传(方向性功能,后置)
- 大文件流式编辑(>512KB 拒入文本编辑器)

## 3. 数据层(files-api.ts)

### 3.1 模块形态

对齐 projects-store.ts 模式:独立可测模块,经 GodotServer IIFE 组装注入 server(缺席 503)。无持久清单文件(与 projects-store 不同:文件系统即真相源,无需 projects.json 类清单)。

```ts
export interface DirEntry { name: string; isDir: boolean; size: number; mtime: number; }
export interface TextFileContent { content: string; mtime: number; size: number; }
export interface RawFile { bytes: Buffer; contentType: string; size: number; }
export interface HexSample { size: number; bytes: number[]; }   // 前 HEX_SAMPLE_BYTES 字节
export interface FilesApi {
  listDir(projectPath: string, sub: string): Promise<{ entries: DirEntry[]; }>;
  readText(projectPath: string, rel: string): Promise<TextFileContent>;
  readRaw(projectPath: string, rel: string): Promise<RawFile>;   // contentType 扩展名映射,server 端点直接 end(bytes)
  readHex(projectPath: string, rel: string): Promise<HexSample>;
  saveText(projectPath: string, rel: string, content: string, baseMtime: number): Promise<{ mtime: number }>;
}
```

### 3.2 路径安全链(硬性规则)

1. `projectPath` 过 `isPathInAllowedRoots`(false → 403,文案对齐现有 add/start)+ **`project.godot` 存在校验**(缺失 → 404;对齐 `POST /api/sessions/start` 的 server.ts:414 先例)——files API 边界 = 白名单内的 **Godot 项目**,不是白名单全域文件浏览器(v2/审阅 I-4:白名单根通常配置宽泛,无此校验则任意目录可读写)
2. `rel` 过 `resolveWithinRoot(projectPath, rel)`(逃逸 `../`/符号链接出 root → 403;resolve 抛错 catch 转 403,与项目面板 I-4 坏根容错语义对齐)
3. 隐藏目录过滤:`.godot`/`.git`/`__pycache__`/`node_modules` 在 listDir 结果中不返回(不阻止直接访问其内已知路径——过滤是浏览层降噪,非访问控制;访问控制全靠 1+2)

### 3.3 保存三重护栏(硬性规则)

1. **readOnly 门**:server 层检查(对齐现有 isReadOnly 注入),true → 403
2. **mtime 乐观锁**:saveText 收 `baseMtime`;当前文件 mtime !== baseMtime → **409 + 当前最新内容**(前端提示「文件已被修改(可能是 Godot 编辑器或 AI),请重新加载」);**文件不存在 → 一律 404**(v2/审阅 I-5:本批保存仅覆盖既有文件,baseMtime=0 也不创建——创建文件属 §2 范围外,不留端点后门)
   - 诚实边界:stat(比 mtime)→备份→写之间存在 TOCTOU 窗口,两个并发保存可同时过校验造成丢更新;本地单用户面板场景接受该残留风险(标注风格对齐 path-utils.ts:150 先例)
3. **备份**:写前拷当前内容 → `~/.godot-mcp/web-gui/backups/<项目路径 percent-encode>/<rel percent-encode>.bak`(转义用 percent-encode:`\`→`%5C`、`:`→`%3A`,可逆无碰撞,v2/审阅 M-12;项目路径整段编码防不同位置同名项目互混;目录不存在递归建 0o700;单文件滚动覆盖 0o600,权限对齐 projects.json 惯例)
4. **原子写**:tmp 文件 + rename(对齐 registry/projects.json 既有惯例)

### 3.4 大小上限(硬性常量)

| 操作 | 上限 | 超限行为 |
|---|---|---|
| 文本读入编辑器 | 512KB | 413 + 提示「文件过大,请用 Godot 编辑器打开」 |
| 图片 raw | 10MB | 413 |
| 音频 raw | 20MB | 413 |
| hex 采样 | 4KB(HEX_SAMPLE_BYTES,server 侧截断非错误) | — |

二进制嗅探:扩展名不在文本白名单(TEXT_EXTS:gd/tscn/tres/json/md/cfg/import/txt/gdignore/gitignore/bat/sh/ps1)→ 前端直接走预览路径不请求 text 模式;server 侧 readText 同样校验扩展名(纵深防御,非白名单扩展 → 400 提示用预览)。

## 4. 操作端点(server.ts)

全部走现有 `authorized()` 三通道鉴权(query/头/cookie)+ Origin 白名单。**`/assets/*` 同样走 authorized()**(v2/审阅 I-2:与 `GET /` 的无 token 语义**不同**——GET / 是静态壳无 token 放行,资产是能力面必须有 token;动态插入的 script/link src 由前端拼 JS 变量 token,见 §6.3)。

**写端点可观测性**:保存成功/失败均记 `getLogger().info('web-gui', 'action=file_save project=... path=... result=...')`(对齐现有 add/remove/start 日志惯例,v2/审阅 M-16)。

| 端点 | 方法 | 语义 | 失败码 |
|---|---|---|---|
| `/api/projects/files` | GET | 列目录 `?project=&sub=`(sub 默认空=项目根) | 403 白名单/路径;404 project.godot 不存在 |
| `/api/projects/file` | GET | 读文件 `?project=&path=&mode=text\|raw\|hex` | 403;404;413 超限;400 mode 非法/非文本扩展 |
| `/api/projects/file` | POST | 保存 `{project, path, content, baseMtime}` | 403;404(含文件不存在);409 mtime 冲突;413 |
| `/assets/{name}` | GET | CodeMirror 静态资产,**枚举式清单**(见 §5.3) | 404 清单外;401/403 鉴权 |

raw 模式 content-type 按扩展名映射(png→image/png 等);svg → `image/svg+xml`。**raw 响应统一附加响应头防线**(v2/审阅 B-1,Blocking 修复):`content-security-policy: default-src 'none'` + `x-content-type-options: nosniff`——`<img>`/`<audio>` 上下文照常渲染,但 svg 被直接导航(地址栏/下载打开)时其内嵌 `<script>` 因 CSP 拒绝执行,堵同源 XSS 偷 token 路径;不依赖「前端只经 img 消费」的单点假设。

**POST body 上限**:handle 层在读 body 前检查 `content-length` > 600KB → 413(v2/审阅 I-6:readJsonBody 现状无界累积,解析后校验拦不住内存先爆);§7 server 层补超限用例。

### 4.1 SSE 事件

**无新增 SSE 事件**(文件操作是请求-响应型,无推送需求;项目 running 徽章联动已有机制覆盖)。

## 5. CodeMirror 构建链

### 5.1 依赖与拷贝

- `package.json` dependencies 加 `codemirror@^5.65`(v2/审阅 M-15 更正理由:构建期依赖——运行时读的是 build 拷贝产物而非 node_modules;放 dependencies 保障 git-install/fork 场景 prepare 构建可用)
- **包内无 .min 文件**(npm 实测 2026-09-15:lib/codemirror.js 402KB 原始,CDN 的 min 是 CDN 打包的);第一版原样拷贝,不引入压缩工具链——localhost 场景 402KB 可接受,cache-control 缓存后仅首次传输;后续优化可加 zlib
- build 脚本(package.json build 链尾部)拷贝固定清单:
  ```
  node_modules/codemirror/lib/codemirror.js   → build/web-gui/assets/codemirror.js   (402KB)
  node_modules/codemirror/lib/codemirror.css  → build/web-gui/assets/codemirror.css  (8.7KB)
  node_modules/codemirror/mode/python/python.js         → assets/mode-python.js      (15KB)
  node_modules/codemirror/mode/javascript/javascript.js → assets/mode-javascript.js  (38.9KB,json 用 javascript mode 的 application/json)
  node_modules/codemirror/mode/markdown/markdown.js     → assets/mode-markdown.js    (31.3KB)
  node_modules/codemirror/mode/xml/xml.js               → assets/mode-xml.js         (~11KB,v2/审阅 M-8:markdown mode 依赖 xml,缺则 md 内嵌 HTML 块高亮降级)
  ```
- 拷贝失败(build 时包未装)→ 构建报错(不静默降级,防发布残缺资产)
- **package.json `files` 白名单补 `build/web-gui/assets/**`**(v2/审阅 I-3:现 files 只含 `build/**/*.js`,codemirror.css 不匹配任何条目,npm publish 后安装用户编辑器无样式;任务 3 范围含此变更 + 发布产物存在性检查)

### 5.2 CSP 放宽(唯一安全面变更)

```
default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self';
img-src 'self'; media-src 'self'; connect-src 'self'
```

img-src/media-src 为预览必需;`'self'` script/style 为资产文件必需。不加 `object-src`/`frame-src`(保持 none 继承)。font-src 不加(CM 用系统字体)。

### 5.3 /assets/* 枚举式清单(防遍历,硬性规则)

server 持固定文件名→绝对路径映射(固定 6 文件,见 §5.1),URL path 必须精确命中清单内名字;任何含 `/`、`..`、清单外名字 → 404。**不做目录读、不做通配**。响应带 `cache-control: private, max-age=86400`(资产带版本指纹时可再强化,第一版 1 天)。

**assets 根解析与注入**(v2/审阅 I-7+M-14):
- 默认 `join(__dirname, 'assets')`(server.js 编译产物位于 build/web-gui/,与 assets 同目录;bin 场景 cwd 不可依赖)
- `WebGuiServerOptions` 加 `assetsDir?: string` 注入(对齐 registryDir/logDir 先例)——任务 2 单测注入临时目录,不依赖任务 3 的构建链落地

## 6. 前端(html.ts)

### 6.1 布局与导航

- 项目行新增「文件」按钮(data-action="files",Missing 行 disabled 对齐 Run/Edit)
- **中列日志区(主区)加 tab**:「日志」|「文件」(默认日志;点「文件」按钮切到文件 tab 并加载该项目;v2/审阅 M-10:现有三列布局左=项目/会话、**中=日志流(1fr 主区)**、右=工具统计,tab 落中列)
- 文件 tab 状态机:`{ project, cwd(相对路径), 视图: list|edit|preview, 编辑器状态 }`
- 面包屑:`项目名 / sub1 / sub2`(逐级可点回跳)

### 6.2 列表视图

- 行:图标(📁/📄 按扩展名)+ 名称 + 大小(**新写 fmtSize**,v2/审阅 M-11:现有只有 fmtAgo)+ mtime(复用 fmtAgo)
- 目录行点击 → 进入;文件行点击 → 按扩展名路由:TEXT_EXTS → 编辑视图;IMG_EXTS(png/jpg/jpeg/webp/svg)→ 图片预览;AUDIO_EXTS(ogg/wav/mp3)→ 音频预览;其余 → hex 视图
- 隐藏目录已在 server 侧过滤,前端不重复过滤
- 事件委托对齐现有模式(容器级 click + closest('button[data-action]'),防重绘吞点击教训)

### 6.3 编辑视图

- `<script src="/assets/codemirror.js">` 等资产引用(动态加载:首次进编辑视图时 createElement('script') + src 赋值——不触碰零 innerHTML 铁律;**src 一律拼 `?token=' + token` JS 变量**——URL query 里的 token 已被启动时 replaceState 清除,cookie 种成后可省略,v2/审阅 M-9)
- mode 路由:gd→python / json→javascript(application/json) / md→markdown / 其余→无高亮
- 工具行:保存按钮(显示未保存 ●)/重新加载/返回列表;状态栏显示 mtime 与大小
- 保存流:POST → 200 更新本地 mtime + 清脏标 → 409 弹确认框「文件已被外部修改」+ 提供重新加载(丢弃本地改动)/复制我的修改到剪贴板 → 413/403 提示
- readOnly:编辑器 cm.setOption('readOnly', true) + 保存按钮隐藏(顶部横幅「只读模式」)
- 脏标防误切:视图切换时 dirty → confirm

### 6.4 预览视图

- 图片:`<img src="/api/projects/file?...&mode=raw&token=...">`(**token 拼 JS 变量**,query 已被清,同 §6.3;img/audio 标签无法带自定义头);显示尺寸与大小
- 音频:`<audio controls src=同上>`
- hex:三列网格 `偏移(8位hex) | 16 字节 hex | ASCII`;>4KB 显示「仅前 4KB,完整内容请下载后查看」;提供「下载」链接(raw 模式同 URL + `download` 属性,浏览器原生另存;raw 响应头防线见 §4,直接导航也不执行 svg script)
- 前端所有动态文本 textContent(防注入铁律延续)

### 6.5 鉴权与 token

资产与 raw 的 img/audio src 无法带 X-GUI-Token 头 → 依赖 query token 或 cookie(既有 /api/auth Set-Cookie 通道);401 时显示占位文案。

## 7. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| files-api 单测 | test/web-gui/files-api.test.ts | 列目录/隐藏过滤/排序;读 text/raw/hex;保存三护栏(mtime 409+bak 生成+原子写;**文件不存在一律 404 含 baseMtime=0 用例**;readOnly server 层测);白名单 403;**无 project.godot 404**;逃逸 403;413 上限;非文本扩展 400 |
| server 端点 | test/web-gui/server-files.test.ts | 路由/鉴权(无 token 401,错 Origin 403;**/assets 鉴权同门**)/assets 枚举(清单外 404 含 ../ 变体;**cache-control 头断言**;assetsDir 注入临时目录)/CSP 头精确断言/**raw 响应头防线断言(default-src 'none' + nosniff)**/**POST content-length>600KB 预检 413**/4 组失败码 |
| 前端机制标记 | test/web-gui/html.test.ts 追加 | 「文件」按钮/tab 切换/CM 动态加载/**src 拼 JS 变量 token**/脏标 confirm/hex 网格标记 |
| 接线 | test/web-gui/wiring-files.test.ts | GodotServer 组装注入真实 files-api;缺席 503 |
| 真机验收 | 脚本 .superpowers/sdd/ | fixture 项目浏览→编辑→保存→backups 文件存在→外部改文件→409 |

## 8. 验收标准(真机)

1. 面板点项目「文件」→ tab 切换 → 目录逐层进出 → `.godot` 不可见
2. 打开 .gd 文件 → CodeMirror 高亮(近似)→ 改一行 → 保存 → 文件真实变更(server 侧 cat 验证)→ backups 目录出现 .bak
3. 外部(node 脚本)改同一文件 → 面板再保存 → 409 冲突框出现
4. 打开 png → 内联显示;打开 .ogg → audio 控件;打开 fixture 预置的 `.bin` 文件 → hex 视图(v2/审阅矛盾修复:`.import` 属 TEXT_EXTS 走文本编辑,hex 验收改用真二进制 `.bin` 样例)
5. GODOT_MCP_READ_ONLY=true 起 server → 编辑器只读 + 保存不可用
6. 白名单外 project 参数 → 403 文案与 add/start 一致

## 9. 任务切分(单 spec 双 plan)

**Plan A:浏览+编辑(6 任务)**
1. files-api 模块 + 单测(纯逻辑,无 server;含 project.godot 校验/三护栏/percent-encode 备份)
2. server 4 端点 + CSP + assets 枚举(**assetsDir 注入**,测试不依赖构建链)+ 单测(含 raw 响应头防线/POST body 预检)
3. CodeMirror 构建链(npm dep + build 拷贝 6 文件 + **package.json files 补 build/web-gui/assets/** + 拷贝失败报错)
4. 前端文件 tab + 列表视图(中列 tab/导航/面包屑/委托/fmtSize)
5. 前端编辑视图(CM 动态加载+src 拼 token/护栏 UI/409 流)
6. GodotServer 接线 + wiring 测试 + 真机验收

**Plan B:二进制预览(2 任务)**
7. 图片/音频内联预览(含 raw content-type 映射单测)
8. hex 视图 + 真机验收补全(§8 第 4 条)

## 10. 实施基线

- 分支:`feat/web-gui-files-a` / `feat/web-gui-files-b`(从 master 切)
- 前置依赖:master 已含项目面板批(05b401a0)+ F-1(merge)
- 遵循:AGENTS.md 全部(默认不发版/门禁三连/Subagent-Driven 流程/独立审查文档)

## 11. 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-15 | brainstorming 六节设计展开;六项用户决策入档 |
| v2 | 2026-09-15 | 独立审阅(1 Blocking+7 Important+8 Minor)全采纳修订:B-1 raw 响应头防线(CSP default-src 'none'+nosniff,堵 svg 直接导航 XSS);I-2 /assets 鉴权明确走 authorized() 三通道(GET / 无 token 语义澄清);I-3 package.json files 补 assets/**;I-4 project.godot 存在校验(files 边界=Godot 项目非白名单全域);I-5 文件不存在一律 404(堵创建后门);I-6 POST content-length 预检 600KB;I-7 assetsDir 注入(任务 2 测试不依赖任务 3);矛盾 .png.import→.bin 验收样例;M-8 补 xml mode(6 文件);M-9 src 拼 JS 变量 token;M-10 右列→中列;M-11 fmtSize 新写;M-12 备份 percent-encode+0o600;M-13 TOCTOU 诚实标注;M-14 __dirname 基准;M-15 dependencies 理由更正;M-16 audit log+测试锚点补全 |
