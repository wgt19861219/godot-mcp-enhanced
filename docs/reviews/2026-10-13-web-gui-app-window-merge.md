# feat/web-gui-app-window 分支全面审查与合入报告

> 审查日期:2026-10-13
> 审查对象:`feat/web-gui-app-window`(独有提交 `4d66da8e`,2026-09-17;分叉点 `6e66e4e8`,落后 master 232 提交)
> 合入结果:merge commit `ac670ed9`(master)
> 审查者:ZCode 主会话(独立复审,不预设分支自带审查 `docs/reviews/2026-09-16-面板独立窗口.md`(SHIPPED WITH NITS 全处置)的结论为真,关键声明全仓实测)

## 总体判定:SHIPPED(含两处审查发现的 master 侧既有问题移交)

分支本身代码质量合格、功能在 master 上无重复、401 误报 bug 在 master 上仍未修复(合入有效)。6 文件冲突全部语义级解决,master 后续演进(安全加固/daemon/实例管理/preferredPort)语义完整保留。验证全绿(残余 flaky 已逐一单跑甄别)。

---

## 一、功能重复性核查(合入必要性)

| 核查项 | 方法 | 结论 |
|---|---|---|
| appWindow / --app 等价实现 | merge 前 `grep -rn "ensurePackageRootAppLauncher\|APP_LAUNCHER_NAME\|app-window" src/` | 零命中(master 无重复,分支全量带入干净) |
| 401 空体误报是否已修 | merge 前 `grep -c "r.json().then" src/web-gui/html.ts` | 15 处旧模式仍在,**bug 未修**,分支修复有效 |
| `.gitignore` 忽略行 | `git diff HEAD -- .gitignore`(merge 后) | 无差异——master 后续批次已带入 `面板独立窗口.bat` 忽略行,分支该文件改动为空集 |
| TUI 修复(LogReader UTC) | `grep -n "getTodayFile\|UTC/本地" CHANGELOG.md` | master 已有(见 §五 重复登记问题) |
| 依赖完整性 | `grep -n "PROJECT_ENTRY_NAME" src/web-gui/portal.ts` | 113 行在位,`app-window.ts` import 依赖成立 |

佐证:master 的 2026-10-08 根治批 CHANGELOG 已在描述 `面板独立窗口.bat` 真机跳转 bug 并修复入口页挑选(preferredPort)——该功能在真机已被使用近一个月,但代码从未合入;本 merge 补上代码本体。

## 二、冲突解决决策(6 文件)

| 文件 | 冲突本质 | 解决决策 |
|---|---|---|
| `.gitignore` | master 加 `.tmp-*.log` vs 分支空 | 保留 master 行;分支的忽略行已在 master(零净变化) |
| `CHANGELOG.md` | 版本段交叠 | 取 HEAD 全量;分支侧 TUI 条目丢弃(已重复);401+功能改写为 `[Unreleased]` 完整条目(补上分支缺失的功能登记) |
| `src/cli/router.ts` | master `hasFlag`+`--rotate-token`/`--show-token` vs 分支 `--app` | 两侧共存:守卫/旗标合并,`openWebDashboard({ showToken, appWindow })` 双选项透传,统一 `hasFlag` 风格 |
| `src/web-gui/open.ts` | 接口选项 + `defaultOpener` 签名;**token 通道语义分叉** | **以 master 安全语义为准**:`#token=` hash 通道(批4-T10)+ console 默认打码(M-2)保留;叠加 `appWindow` 第二参。分支旧 `?token=` query 通道被丢弃——这是 master 分叉后的安全演进,不能被旧分支回退 |
| `src/web-gui/server.ts` | `refreshProjectEntries` 双改 | master 的 READ_ONLY 短路 + `GODOT_MCP_WEB_GUI_ENTRY=0` 短路(M-3)+ 三参 `ensurePackageRootEntry(portValue)`(2026-10-08 preferredPort)为准,分支 `ensurePackageRootAppLauncher` 叠加进同 try 块;import 双行 union |
| `test/web-gui/open.test.ts` | 两侧各加一个用例 | 双用例保留;分支用例 URL 断言从 `?token=` 适配为 `#token=`(master hash 通道) |

## 三、审查驱动的扩展修复(合入必要性与质量延伸)

分支测试断言 `INDEX_HTML` `not.toContain('r.json().then')` 是修复契约的一部分,master 分叉后新增的 fetch 与 stash 恢复的 kb-linkage 批次 fetch 均未走 `safeBody`(同一 401 空体误报 bug 形态),统一接入:

1. **master 分叉后新增 5 处**(merge 时):`loadInstances` / `reimportProject` 成功路径 / `loadSettings` / `verifySettings` / `saveSettings`。其中 `saveSettings`、`verifySettings` 是真 bug(401 空体必落「网络异常」误报);`loadInstances`/`loadSettings` 有前置状态码拦截但保留字面量会假红回归断言。`reimportProject` 401 原落 else 显示空文案,顺带补准确文案。
2. **kb-linkage 批次 5 处**(stash pop 恢复后):`loadSessionOutput` / `saveVaultSettings` / `loadKbOverview` / `openKbProject` / `openKbLog`——不统一则用户接手时测试即红。
3. **CSP hash 重锚**:内联脚本六次变更(merge 侧 1 次 + kb 恢复叠加 1 次 + kb 侧 5 处统一 1 次),最终锚 `sha256-2PtU6kEr6rKAkezbZxAWUX14Nl/+ugO9kEiJ7fx44oI=`(第十七次,从 build 产物实算,见 §六教训 3)。

## 四、用户进行中工作(kb-linkage)的保护与恢复

工作区有未提交 kb-linkage 批次(12 修改 + 4 未跟踪),与分支改动 4 文件重叠,直接 merge 会被拒绝。处置链:`git stash push`(未跟踪文件不动)→ merge + 验证 + commit(`ac670ed9`)→ `git stash pop`(3 文件冲突,均按"两侧叠加"解决)→ 对账(`git diff stash@{0}` 删除行全部为被替换的旧 fetch 模式,零 kb 功能丢失)→ drop stash → `git restore --staged .` 统一恢复为用户离开时的未暂存状态。

kb-linkage 侧适配(随恢复落在工作区,未提交,由用户决定提交时机):`loadSettings` 冲突合并保留 `setVaultPath` 行 + 上述 5 处 safeBody + CHANGELOG Unreleased 条目 union(merge 条目在上、kb 7 条在下)。

## 五、审查发现的 master 侧既有问题(移交,非本 merge 引入)

1. ~~CHANGELOG TUI 修复条目重复登记~~ **(2026-10-13 复核更正:误报,撤销)**。初版报告称同文 TUI 条目在 0.33.5/0.33.4 段各一次,依据是 merge 冲突进行中 `grep -c` = 2——复核实证(`git show 5bab745c:CHANGELOG.md | grep -n` 仅 206 行一条;分叉点 `6e66e4e8` 亦仅一条):第二处是**冲突块内的分支侧条目**(分支把该修复定版进它的 0.33.4,master 定版进 0.33.5,两侧各一条;`checkout --ours` 丢分支侧时已正确消解),不是 master 自身重复。CHANGELOG 当前一条为正确状态,无需清理。教训:冲突进行中的工作区含双侧内容,不能作为"某一方现状"的 grep 证据——考古典档 commit 才是。
2. (轻)`reimportProject` 错误分支原先手工 `r.text()` 先行——与分支 `safeBody` 理念重复实现,本 merge 已统一,提请后续新 fetch 一律走 `safeBody`(回归断言已锁死该契约)。

## 六、验证记录(实测输出)

| 项 | 命令 | 结果 |
|---|---|---|
| 编译 | `npm run build` | 零错误(grep error/warning 零匹配) |
| Lint | `npm run lint` | 零警告零错误(eslint 无输出) |
| merge 态全量(kb 移出) | `npm test` | **7223 passed**,残余 1 例 `ui-import` 性能绊线 10068ms<10000ms(超 68ms)单跑绿 |
| kb 恢复态全量 | `npm test` | **7245 passed**,3 failed(`gdscript-executor-audit-runtime` ×2 + `ui-layout`)单跑 **20/20 全绿**——Godot spawn 资源竞争 flaky,失败集合两轮漂移,与本批无关(两文件本批零改动) |
| 冲突标记 | `git diff --check` | 干净 |
| web-gui 聚焦 | `npx vitest run test/web-gui/{server-http,html,kb-api,server-kb,settings-api,open,server-projects}.test.ts` | 147+11 全绿 |
| flaky 甄别 | `npx vitest run <3 个失败文件>` | 20 passed(单跑) |

## 七、值得进 memory 的工程教训

1. **旧分支合入前先 dry-run**:`git merge-tree --write-tree master <branch>`(git 2.38+)零副作用预演冲突面,决定解冲突策略——本次 6 冲突预演与实际完全一致。
2. **stash 期间跑全量,未跟踪测试文件会假红**:它测的实现刚被 stash 走,必然失败。验证 merge 时移出未跟踪测试文件(`mv` 到 `$TEMP`),恢复后再全量。
3. **CSP/hash 类断言必须从 build 产物(求值后)算,不能从源码文本算**:模板字符串内 `\\n`/`\\s` 双写在源码与运行时形态不同,源码口径 hash 与测试实算必然不一致(本次两口径实测不同,取 build 产物口径)。
4. **Edit 大块冲突合并时核对两侧完整性**:本次 open.test.ts 合并曾丢 HEAD 侧 `it(` 开头只剩孤儿 `finally`(PARSE_ERROR 揪出)——合并后必须立即单跑该文件验证语法。
5. **跨 232 提交的分支合入,auto-merge 干净 ≠ 语义安全**:html.ts auto-merge 零冲突,但 master 新增 fetch 未走分支的 safeBody 契约、token 通道已换代(query→hash)——冲突文件之外更要审"分支契约断言"在演进后的master上是否仍成立。
