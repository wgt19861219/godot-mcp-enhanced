# Web GUI 资源管理工作台 Plan B(二进制预览) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件 tab 的二进制资源预览:图片/音频内联 + 其余二进制 hex 视图,补全 spec §6.4 与真机验收第 4 条。

**Architecture:** 纯前端视图层(Plan A 已备好全部端点:raw 带 content-type 映射与响应头防线、hex 前 4KB 流式采样);顺手收 Plan A 终审 deferred M-3(files-api 目录路径 500→bad_request)与 M-7(注释措辞)。

**Tech Stack:** TypeScript(ES2022/strict/ESM)+ Vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-web-gui-files-design.md`(v2)§6.4/§8-4/§9-Plan B——执行者必须同时读 spec。

## Global Constraints(继承 Plan A,每任务隐含遵守)

- 简体中文注释;Conventional Commits(type 英文+subject 中文);ESM .js import;禁 any;默认不发版
- 前端零 innerHTML(动态内容全 textContent/属性赋值);零外链;**src 一律拼 `?token=' + token` JS 变量**(M-9:URL query 已被 replaceState 清)
- raw 消费只经 `<img>`/`<audio>` 标签(响应头防线已在 server 侧,直接导航也不执行 svg script)
- 完成前 `npm run lint` + `npm run build` + `npm test` 全绿
- Plan A 已落地勿重复实现:`GET /api/projects/file?mode=raw|hex` 端点/IMG_EXTS(png,jpg,jpeg,webp,svg)/AUDIO_EXTS(ogg,wav,mp3)/前端 fileExt 与三组扩展名副本/openFileEntry 的 IMG/AUDIO/二进制占位分支

---

### Task 1: 图片/音频内联预览 + M-3/M-7 顺手收

**Files:**
- Modify: `src/web-gui/html.ts`
- Modify: `test/web-gui/html.test.ts`(追加)
- Modify: `src/web-gui/files-api.ts`(M-3)
- Modify: `test/web-gui/files-api.test.ts`(M-3 用例)
- Modify: `scripts/copy-codemirror.mjs:1`(M-7)

**Interfaces:**
- Consumes: Plan A 的 `openFileEntry(name, isDir)` 占位分支(html.ts:440 附近,IMG/AUDIO/其余三类)、`filesState`、`mode=raw` 端点(contentType 已映射:png→image/png…svg→image/svg+xml,ogg/wav/mp3→audio/*)
- Produces: 预览视图函数 `openPreview(rel, kind)`(kind ∈ 'img'|'audio'|'hex';Task 2 消费 hex 分支);M-3 修复后 readText/readRaw/readHex 对目录路径抛 `FilesError('bad_request','is a directory')` 而非裸 EISDIR

- [ ] **Step 1: 写失败测试(html.test.ts 追加)**

```ts
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
```

(M-3 测试在 files-api.test.ts readText/readRaw/readHex 三个 describe 各补一条目录路径用例:)

```ts
    it('路径是目录 → bad_request 而非裸 EISDIR(M-3)', async () => {
      await mkdir(join(proj, 'adir'), { recursive: true });
      await expect(api.readText(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
      await expect(api.readRaw(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
      await expect(api.readHex(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
    });
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/html.test.ts test/web-gui/files-api.test.ts`
Expected: 新用例 FAIL（openPreview/mode=raw&token 不存在;目录用例得非 bad_request 错误）

- [ ] **Step 3: 实现**

**html.ts**（openFileEntry 的 IMG/AUDIO 占位分支替换）:
1. `var previewState = { rel: null, kind: null };` 全局
2. `function openPreview(rel, kind)`：
   - `previewState = { rel, kind }`;切编辑子视图同款布局(工具行+返回列表按钮 data-action="preview-back"+内容区)
   - IMG 分支:`var img = document.createElement('img'); img.src = '/api/projects/file?project=' + encodeURIComponent(filesState.project) + '&path=' + encodeURIComponent(rel) + '&mode=raw&token=' + token;` + alt=rel;img.onerror 显示「加载失败(token 失效或文件超限)」占位文本;旁边 textContent 显示 rel 与 fmtSize(从列表 entries 取 size,查不到显示 raw 响应无从知,省略)
   - AUDIO 分支:同 URL 拼接,`var au = document.createElement('audio'); au.controls = true; au.src = rawUrl;`
   - 两分支共用:下载链接 `var dl = document.createElement('a'); dl.href = rawUrl; dl.setAttribute('download', basename); dl.textContent = '下载 ' + basename;`(`<a>` 静态安全,download 属性触发另存;raw 响应头防线保证直接导航不执行 script)
   - 工具行返回按钮 data-action="preview-back" → 委托分发回 `renderFiles()`
3. `openFileEntry` 的 IMG 分支 → `openPreview(name, 'img')`;AUDIO 分支 → `openPreview(name, 'audio')`;二进制占位保留给 Task 2(hex)
4. #filesPane 委托加 preview-back 分支;离开路径过 dirtyBlock(预览无脏标,直接返回)

**files-api.ts（M-3）**:readText/readRaw/readHex 三方法的 stat 成功后加:
```ts
if (st.isDirectory()) throw new FilesError('bad_request', 'is a directory');
```
（三处同款,一行的防御,消除裸 EISDIR 冒 500）

**copy-codemirror.mjs:1（M-7）**:注释「构建期拷贝 CodeMirror 6 文件」→「构建期拷贝 CodeMirror 5(CM5)的 6 个文件」

- [ ] **Step 4: 跑测试确认绿+回归**

Run: `npx vitest run test/web-gui/html.test.ts test/web-gui/files-api.test.ts && npm run build`
Expected: 全 PASS

- [ ] **Step 5: lint+commit**

```bash
npm run lint
git add src/web-gui/html.ts src/web-gui/files-api.ts test/web-gui/html.test.ts test/web-gui/files-api.test.ts scripts/copy-codemirror.mjs
git commit -m "feat(web-gui): 图片/音频内联预览(raw 拼 token/下载链接)+files-api 目录路径 bad_request(M-3)+CM 注释勘误(M-7)"
```

---

### Task 2: hex 视图 + 真机验收补全

**Files:**
- Modify: `src/web-gui/html.ts`
- Modify: `test/web-gui/html.test.ts`(追加)
- Create: `.superpowers/sdd/2026-09-15-web-gui-files-b/acceptance.mjs`(真机验收)

**Interfaces:**
- Consumes: Task 1 的 `openPreview(rel, kind)`(hex 分支)、Plan A 的 `mode=hex` 端点(→ 200 `{size, bytes:[...]}`,bytes ≤4096)
- Produces: 完整预览能力(spec §6.4 全量)+真机验收 §8 第 4 条通过

- [ ] **Step 1: 写失败测试(html.test.ts 追加)**

```ts
  // ── 资源管理批(Plan B Task 2,spec §6.4 hex)───────────────────────────────
  it('hex 视图:三列网格 + >4KB 截断提示 + 下载', () => {
    expect(INDEX_HTML).toContain("kind === 'hex'");
    expect(INDEX_HTML).toContain('renderHex');                     // 渲染函数
    expect(INDEX_HTML).toContain('仅前 4KB');                       // 截断提示
    expect(INDEX_HTML).toContain('toString(16)');                   // 偏移 hex 化
  });
  it('二进制路由:openFileEntry 其余分支走 hex', () => {
    expect(INDEX_HTML).toContain("openPreview(name, 'hex')");      // 或等价拼接形态
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/html.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现 hex 分支（openPreview 内）**

1. fetch `mode=hex`(x-gui-token 头,同 loadDir 模式)→ `{size, bytes}`
2. `renderHex(bytes, size)`:
   - 标题行 textContent:`rel + ' (' + fmtSize(size) + ')'`
   - 若 size > bytes.length → 提示行「仅前 4KB,完整内容请下载后查看」+下载链接(raw 同 URL+download,复用 Task 1)
   - 每 16 字节一行,行内三段全 textContent:偏移(8 位十六进制,`('00000000' + off.toString(16)).slice(-8)`)/16 字节 hex(`b < 16 ? '0' : '' + b.toString(16)` 两位,空格分隔)/ASCII(`b >= 32 && b < 127` 用 `String.fromCharCode(b)`,否则 `.`)
   - 容器可滚动(与日志区同款 overflow 样式);行数多时不卡(4KB/16=256 行,安全)
3. `openFileEntry` 二进制占位分支 → `openPreview(name, 'hex')`
4. 401/403/404 错误显示在预览区占位文本

- [ ] **Step 4: 跑测试确认绿+build**

Run: `npx vitest run test/web-gui/html.test.ts && npm run build`
Expected: 全 PASS

- [ ] **Step 5: 真机验收补全(spec §8 第 4 条 + Plan A 遗留复核)**

脚本 `.superpowers/sdd/2026-09-15-web-gui-files-b/acceptance.mjs`（对齐 Plan A files-acceptance.mjs 形态,环境坑同款:env -u GODOT_MCP_ALLOW_UNSAFE_CONFIRM、sleep 保活、registry 取端口 token、结束 kill+清理）:
1. fixture 项目预置:1×1 png(手写最小 PNG 头字节)/短 ogg(或任意字节文件后缀 .ogg——audio 控件渲染验证留给 Playwright)/data.bin(256 字节 0x00-0xFF)
2. curl:raw png 200+content-type image/png+响应头防线两头;hex .bin 200 且 bytes[0]==0/b bytes[255]==255
3. Playwright:项目行「文件」→ 点 png → img 元素出现(naturalWidth>0);点 data.bin → hex 三列渲染(取首行文本含 00000000);「下载」链接存在
4. 清理:fixture+进程+registry 归零

- [ ] **Step 6: lint+commit**

```bash
npm run lint
git add src/web-gui/html.ts test/web-gui/html.test.ts
git commit -m "feat(web-gui): hex 视图(三列网格/4KB 截断提示/下载)+真机验收补全(资源管理 Plan B 收口)"
```

---

## Self-Review(controller 执行)

1. **Spec 覆盖**:§6.4 图片(Task 1)/音频(Task 1)/hex+下载(Task 2)/401 占位(Task 1 onerror+Task 2 错误占位);§8-4(Task 2 验收);§9 Plan B 任务 7/8 对应 Task 1/2;deferred M-3/M-7(Task 1)。gap:无(M-5/M-6 继续留给后续,已在审查文档持久化)。
2. **占位符扫描**:两任务步骤均含实码;验收脚本给要点清单(环境坑全列,形态对齐 Plan A 已验证脚本)。
3. **类型一致性**:`openPreview(rel, kind)` Task 1 定义 hex 分支占位/Task 2 填充,kind 三值一致;raw URL 拼接形态 Task 1 定义(`mode=raw&token=' + token`)Task 2 下载链接复用;fmtSize Task 1(Plan A 已有)Task 2 复用。
