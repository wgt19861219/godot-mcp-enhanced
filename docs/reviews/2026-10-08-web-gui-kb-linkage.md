# 2026-10-08 Web GUI × Obsidian 知识库联动 批第三方审查

> 审查者:code-reviewer 子代理(独立上下文,不预设实现者声明为真,全部声明 grep/read 实测)。
> 审查范围:git 未提交改动(kb-api 新建 + server/user-settings/settings-api/GodotServer/html 扩展 + 6 个测试文件 + CHANGELOG/README)。
> 真机 vault 数据(`D:\workspace\Obsidian`)抽验。审查环境无命令执行工具,`npm test 7218 用例`声明无法独立复跑(详见 §6)。

## 总体判定:SHIPPED WITH NITS

无 Blocking Issue。核心安全链(防穿越、鉴权、CSP)、设计核心(看板判定/断流/映射解析)均实测成立且测试锁行为。7 条 Nits 如下,均不阻断合并;**N-1~N-7 全部于审查当日修复**(N-2/N-4 首轮修复,N-1/N-3/N-5/N-6/N-7 二轮"处理暴露的所有问题"批修复,见文末附记)。

## 逐维度结论(每条带 file:line 证据)

### 1. 设计正确性 — 通过(1 处口径 nit)

- **活跃看板判定** ✅:候选顺序 `[项目待办.md, 任务看板.md]` + `status != archived` 跳过,循环 continue 语义正确(`src/web-gui/kb-api.ts:181-203`);两候选均归档返回 null(:202)。测试锁两派形态(`test/web-gui/kb-api.test.ts:116-139`,ProjA 项目待办派 / ProjB 活跃看板派)。
- **计数口径** ✅:`Number.isFinite && fmTotal > 0` 门控 frontmatter 优先,`Number('') === 0`、`Number(undefined) === NaN` 等边界均正确落入全文兜底(kb-api.ts:190-199);全文正则 `-\s?\[[xX]\]` / `-\s?\[\s\]` 含缩进嵌套与大小写(:167-171);2MB 上限显式拒绝(:32, :197)。
- **断流判定** ✅,一处口径 nit(N-6):三分支(有日志有 commit 比 stallDays / 有 commit 无日志比距今 / 无 commit 不冤枉)逻辑正确(kb-api.ts:348-351),`Date.parse` 失败 NaN 比较为 false 的防御成立;测试覆盖三态 + stallDays=7 边界(kb-api.test.ts:151-179)。**N-6**:无日志分支用 `Date.now() - commit > 3d`,死项目(commit 半年前、从未建知识库)也会标 🔴"断流(有提交无日志)"——与注释"代码在动而知识库停滞"(kb-api.ts:75)语义有偏差,代码没动也算。保守方向可接受,建议未来区分归档态。
- **CLAUDE.md 映射解析** ✅(真机抽验通过):`首对=repoPath/末对=kbDir` 策略对真机 `D:\workspace\Obsidian\CLAUDE.md` 三类特殊行全部正确——①GodotMCP 行(:62,附注含旧路径反引号段,居中取第 2 对确会误读,首末取对正确提取 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced` + `GodotMCP`);②FR2Server 行(:82,附注含两个反引号旧仓路径,同形态兼容);③单反引号行 TimeSlotWorkshop/fnOS(:84-85)ticks.length < 2 正确跳过。且有真机回归用例锁第①类(kb-api.test.ts:252-257)。`readRepoMap` 的 CLAUDE.md 命中即不读 AGENTS.md(kb-api.ts:245)与文件头契约一致。

### 2. 安全 — 通过(2 处 nit)

- **readFile 防穿越链** ✅:完整复用 `resolveWithinRoot`(kb-api.ts:408),该函数五层防护齐备——UNC 拒 / Windows 设备名拒 / 迭代 URL 解码 / 段级 `..` 拒 / realpath+relative(`src/core/path-utils.ts:156-206`);root 固化为 `<vault>/<name>/开发日志`。`safeProjectName` 拒空/`.`/`..`/含分隔符(kb-api.ts:260-265),URL 编码 `%2e%2e` 经 searchParams 解码后同走段级拦截(测试 kb-api.test.ts:221-226 显式覆盖三种穿越形态)。
- **vaultPath 设置校验** ✅:trim / 空串=清除 / `isAbsolute` / `stat().isDirectory()` / 失败审计留痕(`src/web-gui/settings-api.ts:198-220`),与 allowedProjectPaths 单条目预检同层。写端点受 READ_ONLY 403 拦截(server.ts:864-867)。
- **只读面** ✅:kb-api.ts 无任何写 API(grep 全文件仅 open('r')/readFile/readdir/stat);server 三端点全 GET(server.ts:534-544),POST 分发白名单不含 kb 路径(kb 无注册——GET-only 设计自洽)。
- **错误信息** ✅ 基本合规,一处 nit(N-3):KbError 消息全部固定文本无路径('path escapes log dir' 等);但 `kbErr` 500 分支透传 `e.message`(server.ts:1151),未知 fs 异常(EPERM/EBUSY)message 常含本地绝对路径。与 `filesErr` 同模式先例(server.ts:1208+),本地 token 保护面下一致性优先,nit 不改判。
- **N-1(项目集不一致)**:`overview` 经 `isKbProjectDir` 过滤(kb-api.ts:268-279, 333-334),但 `projectDetail`/`readFile` 不复该校验(:375-381, :402-417)——vault 下任意存在子目录可探测(404 vs 200 差分),readFile 可读任意目录 `开发日志/` 内 .md。前提是已持 token 的本机用户 + vault 为用户显式配置的信任根,泄露面窄,定性低危设计不一致。

### 3. TS-GD/仓库级约束 — 全部通过

- **rule-templates/.claude/rules 未触碰** ✅:`src/tools/rule-templates.ts` 与 `.claude/rules/` 全目录 grep `vault|kb-api|知识库联动` 零匹配;CHANGELOG 声明"不 bump 版本——未动 rule-templates/.claude/rules"(CHANGELOG.md:9)与实测一致,版本链门禁不触发。
- **build 产物一致** ✅:`build/web-gui/kb-api.js` 已存在(Glob 实测),build 已跑。
- **module-loader 无关改动** ✅:grep 零匹配,kb 非 MCP 工具模块无需登记;capability-matrix 不涉及(无新 MCP 工具,web-gui 路由不在工具清单)。
- **依赖方向** ✅:kb-api(web-gui)→ `core/path-utils.js` 为 web-gui→core 合法方向(kb-api.ts:23);`core/user-settings.ts` 零反向依赖;无新增模块级 setter——`KbApi` 构造器注入 opts(kb-api.ts:303-306),`resetUserSettingsSnapshotForTest` 是 2026-09-29 批既有测试隔离出口非本批新增。
- **接线完备** ✅:stdio 侧 `GodotServer.ts:681` 注入 `kb: new KbApi()`;daemon 侧 `src/daemon/main.ts:126` 经 `buildWebGuiOptions` 工厂复用自动携带,无 daemon 模式 503 缺口;启动重放 `src/index.ts:85`(applyUserSettingsAtStartup 在 C-08 提示前)使 settings.json 的 vaultPath 跨重启生效。

### 4. 测试质量 — 良好(2 处缺口 nit)

- **锁行为非实现** ✅:kb-api 18 用例断言返回结构/错误码/计数语义(mkdtemp 隔离 + git fake 注入);server-kb 6 用例锁 HTTP 状态码与鉴权(`test/web-gui/server-kb.test.ts:53-115`);settings-api +3 锁校验/热生效/快照恢复链(`test/web-gui/settings-api.test.ts:204-233`,含 env 热生效断言 :221)。
- **N-4(已修)**:`KB_ERR_STATUS` 五错误码(server.ts:1138-1144)中 too_large→413 原缺路由层用例。
- **N-5**:`BOARD_HEAD_BYTES` 8KB 截断与 UTF-8 撕裂 U+FFFD 的声明行为(kb-api.ts:17-18)无显式用例;mapLimit 并发正确性无直接单测(实现简单 + overview 间接跑过,风险低)。
- **N-7**:html.test.ts +5 全为 `toContain` 代码字符串断言(html.test.ts:268-304)——锁实现文本非行为,重构变量名即假红。是该文件既有模式(UI 层无 jsdom 设施)的延续,提一嘴不改判。

### 5. 前端纪律 — 全部通过

- **唯一内联 script** ✅:全文件仅一处 `<script>` 开闭(grep 证实),script 体内无 `</script>` 字面量,提取正则不会提前截断(`src/web-gui/html.ts:210, 1676, 1691`)。
- **事件委托** ✅:#kbPane 容器一次性委托(html.ts:1516-1527),卡片/日志行/工具按钮零监听器只带 data-action;左列 📚 徽标挂 #projPane 既有委托(:1431-1435);tabKb 静态 DOM 直接绑定(:1509);容器 `contains` 守卫防委托越过容器(:1519)。
- **textContent 无 innerHTML** ✅:全文件 grep `innerHTML|insertAdjacentHTML|eval\(|new Function` 零匹配;obsidian:// 跳转走原生 `a.href` 属性赋值 + encodeURIComponent,外部协议导航不受 CSP connect-src 管辖(:754 注释声明正确)。
- **模板串 `\\` 双写纪律** ✅:`/\\.md$/`(:756)、placeholder `D:\\workspace\\Obsidian`(:191)均双写。
- **CSS ellipsis 修复** ✅:`.kb-count`/`.kb-log-title`/`.kb-name`/`.kb-meta` 均带 `min-width:0` + `text-overflow:ellipsis`(:125-139),flex 项 min-width:auto 撑破问题对症。

### 6. 验证完整性 — 声明与实测吻合(执行类声明无法复跑)

- **CSP hash 独立重验** ✅(结构级):`INDEX_SCRIPT_SHA256` 模块加载时动态计算非硬编码(html.ts:1690-1695);`server-http.test.ts:105-109` 用独立提取路径(split vs 实现的 exec regex)+ CRLF 归一重算,三方互证 + 硬编码锚 `NrJgJn3KjG+zJrBYgf9OJjPfVjisTAQOFUIk1uoAHS8=`;九次重锚注释链与本批脚本改动对应。
- **kb 端点注册无遗漏** ✅:server.ts 三路由(:534-544)+ 三 handler(:1155-1204)grep 证实;POST 白名单确认无需 kb 条目(全 GET)。
- **真机声明抽验** ✅(部分):映射表三特殊行兼容性实测通过(见 §1);vault 项目规模量级吻合(Glob `*/开发日志/*.md` 数十个项目目录,与"50 项目"量级一致);开发日志 `D:\workspace\Obsidian\GodotMCP\开发日志\2026-10-08 Web面板知识库联动.md` 已存在。"断流 6 个/7218 用例/视觉验收两轮 PASS"无法在本环境独立复现(无执行工具),采信测试文件实测内容 + CHANGELOG 记录。

## Blocking Issues

无。

## Nits

| # | 内容 | 位置 | 置信度 | 状态 |
|---|------|------|--------|------|
| N-1 | `projectDetail`/`readFile` 不复用 `isKbProjectDir` 校验,与 overview 项目集不一致——vault 任意子目录可探测存在性(token 保护下的本机面,低危) | kb-api.ts:375-381, 402-417 | 85 | 🟢 已修(同日二轮:detail/readFile 前置 isKbProjectDir,非项目目录统一 not_found,readFile 另补 logRoot 存在性;测试 +1 锁 杂项/无日志目录两形态) |
| N-2 | `listLogs` 内 `readHead` 无 try 兜底——一个日志文件被锁(Windows EBUSY)即炸整个 overview 为 500 | kb-api.ts:214 | 85 | 🟢 已修(同日,单文件失败跳过、status 置空,注释标 N-2) |
| N-3 | `kbErr` 500 分支透传 `e.message` 可能含本地绝对路径;与 filesErr 同模式先例,建议后续统一归一 | server.ts:1151 | 80 | 🟢 已修(同日二轮:500 归一固定文本 'internal error' + getLogger().warn 留详情;测试 +1 断言响应不含异常消息路径) |
| N-4 | too_large→413 缺路由层用例 | server.ts:1142 | 90 | 🟢 已修(同日,server-kb.test.ts 补 413 断言含 code:'too_large') |
| N-5 | BOARD_HEAD_BYTES 8KB 截断/UTF-8 撕裂无显式用例;mapLimit 并发无直接单测 | kb-api.ts:17-18, 121-133 | 80 | 🟢 已修(同日二轮:mapLimit 导出 + 并发峰值/保序单测;parseFrontmatterHead 不闭合用例;20KB 看板文件容错端到端用例;UTF-8 撕裂不加显式断言——构造脆弱,声明为可接受行为) |
| N-6 | 无日志分支 stall 口径:死项目(commit 陈旧+从未建知识库)也标 🔴,与"代码在动"文案语义有偏 | kb-api.ts:349-351 | 85 | 🟢 已修(同日二轮:新增 RECENT_COMMIT_WINDOW_DAYS=90 观察窗——commit 距今 3~90 天且无日志才断流,刚起步(≤3天)与死项目(>90天)不冤枉;前端徽标第四态「· 无日志」中性灰替代误导性 🟢;测试 10/100/1 天三窗点;真机 GameSign(commit 2026-05-01)不再误报,5 个真断流保留) |
| N-7 | html.test.ts 新增断言锁实现文本,重构即假红——既有模式延续,长期宜引 jsdom 锁行为 | html.test.ts:268-304 | 80 | 🟢 已修(同日二轮:本批新增断言全部改契约锚——DOM id/API 路径/data-action 值/用户可见文案,删 showTab 语句串/kbState 变量名等实现细节断言;jsdom 不引——测试栈级变更超出本批,留独立批次评估) |

## 审查后附记(N-2/N-4 当日修复)

- **N-2 修复**:`listLogs` 单文件 `readHead` 包 try-catch,失败跳过该文件的 status 提取(文件名+日期仍展示)——单文件异常不再炸 overview。
- **N-4 修复**:`server-kb.test.ts` 413 用例补齐(造 512KB+1 文件断言 HTTP 413 + `code:'too_large'`),`KB_ERR_STATUS` 五码映射面路由层全覆盖。
- 修复后复验:`npm run build` 0 错误;`npx vitest run kb-api + server-kb` 24 用例全绿;lint 通过。

## 审查后附记二(N-1/N-3/N-5/N-6/N-7 同日二轮修复,"处理暴露的所有问题"批)

用户指令"先处理暴露的所有问题",剩余 5 条 open Nits 全修:

- **N-1 修复**:`projectDetail`/`readFile` 前置 `isKbProjectDir`(与 overview 项目集同源),非项目目录统一 not_found;`readFile` 另补 `开发日志/` 根存在性检查(项目目录但无日志目录 → not_found 而非穿越链误报)。探测面(404 vs 200 差分)消除。
- **N-3 修复**:`kbErr` 未知异常分支归一 `{error:'internal error'}`,详情经 `getLogger().warn('web-gui','action=kb_internal_error detail=...')` 落 server 日志——响应面 PII-safe。
- **N-5 修复**:`mapLimit` 导出 + 直接单测(并发峰值 ≤ limit 且 ≥2 证真并发、结果保序);`parseFrontmatterHead` 不闭合用例(head 截断场景返回已收集键);20KB 看板文件端到端容错用例(frontmatter 超截断区 → 全文计数兜底)。UTF-8 撕裂不加显式断言(构造脆弱),维持文件头"可接受"声明。
- **N-6 修复**:新增 `RECENT_COMMIT_WINDOW_DAYS=90` 观察窗常量——无日志分支仅当 commit 距今 3~90 天(近期在开发却从未记录)才 stall;≤3 天(刚起步)与 >90 天(死项目)不冤枉。前端徽标第四态:有 commit 无日志且非断流显示中性「· 无日志」灰徽标(替代误导性 🟢)。真机验证:GameSign(commit 2026-05-01)不再误报,断流 6→5(真断流全保留),GameSign 卡片实测显示「· 无日志」。
- **N-7 修复**:本批新增的 5 条 html.test 断言全部改契约锚(DOM id / API 路径 / data-action 值 / 用户可见文案 / `loadKbOverview(true)` 出现次数 ≥2),删除 showTab 语句串、kbState 变量名等实现细节断言——重构变量名不再假红。jsdom 不引(测试栈级变更,独立批次评估)。
- **随批存量修复(验证过程观测)**:①右列 stats 表格容器加 `#statsScroller{overflow-x:auto}`(表格自滚);②根治——`main` grid `340px 1fr 420px` 改 `340px minmax(0,1fr) 420px`(grid 版 min-width:auto 陷阱:1fr 的 auto 最小值被中列内容 min-content 实测撑到 465px → 整页横向溢出 365px;minmax(0,1fr) 后 900px 视口三态零溢出,页面宽恒 900/900)。
- 二轮修复验证:lint 0 错误 + build 0 错误 + 全量 **7223 用例全绿**(+5:mapLimit 并发/frontmatter 不闭合/20KB 容错/非项目目录拒绝/500 归一;N-6 用例重写为 10/100/1 天三窗点);真机 API(GameSign stall=false、断流 5 个保留)+ UI(900px 三态零溢出、「· 无日志」徽标渲染);CSP hash 十次重锚(N-6 徽标分支改 script 内容)。

## 值得进 memory 的工程教训

1. **外部数据契约的解析器必须先实测数据形态再定提取策略,并锁真机回归用例**:`parseRepoMapLine` 的"首对=repo/末对=kbDir"不是任意选择——真机 CLAUDE.md 映射表的附注里嵌着反引号包裹的旧路径(`D:\workspace\Obsidian\CLAUDE.md:62, 82`),"居中取第 2 对"这类直觉策略会把失效路径误当 kbDir 导致映射静默丢失。解析用户手写的 markdown 表格时,"看起来规范的格式"假设都不可靠。
2. **内联脚本的 CSP hash 安全网 = 三方互证**:实现侧动态计算(内容变更 hash 天然轮换)+ 测试侧独立路径重算(split vs regex,抓提取逻辑漂移)+ 真实浏览器实证锚硬编码(抓双侧同款漂移),九次重锚零事故。可作为"带 hash 锁的内联资产演进"通用范式。
