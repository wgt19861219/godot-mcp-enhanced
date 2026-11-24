# 反馈批次 20261122 实施计划 v2 —— 独立审查（第二轮）

**审查对象**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\docs\superpowers\plans\2026-11-22-feedback-batch-20261122.md`（工作区未提交的 v2；行号锚定基线 `d57e376a`，该提交同时是当前 `master` 头，`git rev-parse master` 与 `HEAD` 同值）。

**对照材料**：
- v1 审查：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\docs\reviews\2026-11-22-feedback-batch-plan-review.md`
- 反馈库（spec，只读）：`D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md`——:243（11-12 DPI）、:613（11-22 互杀与归属）、:625（11-14 回写）、:644（11-12 run_tests）、:741（11-18 help）、:749/:757（11-08 与 11-20 复发）、:823（10-29）、:1039-1073（11-18 UI 五条）
- 仓库级约束：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\AGENTS.md`、`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\.github\workflows\ci.yml`

**审查方式**：
- 静态核对：八个任务的 Files 行号、函数签名、测试代码、mock 顺序、夹具内容逐条对照源码与测试源码。
- 实跑：仓库外只读探针 5 个（导入 `build` 产物，未写仓库）；定向 vitest 14 个文件 518 条取基线；`npm run lint`、`node scripts/check-test-quality.mjs`、`node scripts/check-token-budget.mjs`、`node scripts/version-sync.mjs --check`、`npm run score:gate`。未跑 `build-matrix`、`gen:tool-docs` 等会改写仓库生成物的命令。
- 下文路径前缀 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\` 省略时均指 worktree 根；每处证据仍写完整绝对路径。

**总体判定**：**BLOCKING ISSUES**（1 条阻断、9 条重要、7 条小问题）。

Task 1–6 的锚点、签名、夹具与 mock 顺序基本可照写照跑，版本链与仓库级约束的主体处置成立，附录 A 的 27 条映射中 25 条成立。阻断点集中在 Task 7 ③（anchor-rebase）：验收测试的传参形态错误、规则的触发条件与计划自己的夹具不匹配、且计划对现状的「实测」结论不成立——正确传参下，现状会把全铺层静默写成全零锚。另有 4 处「按计划文字必红」的门禁与断言（lint 贴顶、`version-sync --check` 位置、`score:gate` 前置、字节数断言），都是一两行可解，但须先改计划文字再执行。

---

## 一、逐维度结论

| 维度 | 结论 | 证据 |
|---|---|---|
| 可执行性（Task 1） | 🟢 可照写 | 注入点 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\core\ToolDispatcher.ts:347-357`、校验点 `:375-383`；名单 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\core\tool-registry.ts:349-359`；探针实测 46 个工具、名单外未声明 `project_path` 的恰为 `["debug","engine","help"]`；`...\test\core\get-context-registration.test.ts:9,24-25` 已 import `skipProjectPath` |
| 可执行性（Task 2） | 🟡 基本可写，1 处断言与文案不符 | 三条路径与变量名 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\script\edit.ts:412`（`finalContent`）、`:474`、`:613`（`result`）；mock 基座 `...\test\script-editing-mock.test.js:23-41,76-81`；见 Important-4 |
| 可执行性（Task 3） | 🟢 可照写 | 拷贝段 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\game-bridge.ts:666-684`；`scriptNote` 进两条响应分支 `:729-731`、`:747-753`；夹具 bundled 脚本 `'extends Node\n'` 见 `...\test\game-bridge-autoload-key.test.ts:42` |
| 可执行性（Task 4） | 🟢 可照写（lint 余量除外） | 停旧段 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\runtime.ts:213-221`、两处 spawn `:280-283`/`:301-304`、尾注 `:406-408`；四条成功响应 `:432,434,437,439` 均以 `+ sessionNote` 结尾；`...\test\core\memory-guard-funnels.test.ts:36-63,137-174,238-289,482-501` 基座齐全 |
| 可执行性（Task 5） | 🟢 可照写 | measure 链 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\ui\index.ts:676-695`（调用点 `:680`）、import 链 `:1085-1098`、`:1132-1135`；夹具 `...\test\ui-quality-check.test.ts:502-594,596-648`；探针复核：全 0 输入下 `quality=null`、`order.equidistant` 两条 gap=0 |
| 可执行性（Task 6） | 🟡 GD 代码块合法，门禁顺序有误 | 现状 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\scripts\mcp_bridge.gd:2994-2998`；规则双副本 `...\.claude\rules\godot-mcp-bridge.md:56` 与 `...\src\tools\rule-templates.ts:249`；见 Important-2 |
| 可执行性（Task 7） | 🔴 ③ 不可按文字执行 | `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\ui\anchor-rebase.ts:193-196` 第三参形态；见 Blocking-1。①② 可写（`...\src\tools\ui\index.ts:380-406,1253-1258,1275-1285`、`...\src\tools\ui\ui-theme.ts:116-183`） |
| 设计正确性（Task 1） | 🟢 成立 | `skipProjectPath` 全仓唯一消费点 `...\src\core\ToolDispatcher.ts:347`；editor 转发 `:1103` 原样送 args、`...\src\core\EditorToolExecutor.ts` 全文无 `project_path`、addon 侧无读取；审计回落 `:708-711`、telemetry 守卫 `:632`、tool 日志回落 `:1127-1131`；平铺动态名无 schema 故不受未知参数检查影响 |
| 设计正确性（Task 4） | 🟢 主体成立，三点边界未声明 | `resolveBridgePort` 四个消费点同享偏好（`...\src\core\bridge-client.ts:515,652,1236`、`...\src\tools\game-bridge.ts:1150`）；游戏窗口形态的 spawn 只有 `runtime.ts` 两处（`run_tests` `:530`、截图、编辑器、headless 不属归属面）；「跨 server 无互杀」成立——看门狗按 `serverPid` 过滤 `...\src\core\mem-watchdog.ts:8,134`；见 Important-9 |
| 设计正确性（Task 5/6/7） | 🟡 | Task 5 守卫只压推导、事实照出，成立；Task 6 诊断字段 + 文档换算对齐反馈 :247 建议②；Task 7 ③ 见 Blocking-1，既有三条语义锚不受新规则影响（`...\test\ui-anchor-rebase.test.ts:345-374` 的 `AnchoredChild` 带非零 offset `:359-360`，`:575-615` 与 `:531-549` 的夹具无「一级子 + 全锚 + 零 offset」形态） |
| 版本链 | 🟡 主体成立，1 处门禁必红 | `BRIDGE_SCRIPT_VERSION` 由 `...\scripts\version-sync.mjs:29,121-123` 写入；`check-rules-version-bump.mjs:55-66,81-82` 以 HEAD 对工作区、`git diff HEAD -- package.json` 判 bump，是本地 pre-commit 门禁（提交后 CI 恒跳过）——「模板与 bump 同提交」的推理成立；Task 6 `git add` 清单覆盖 A 类六文件 + 生成物；存量漂移属实（`...\docs\tools\ui.md` 页脚 v0.38.0，`...\docs\capability-matrix.json:2` 为 0.41.0）；见 Important-2 |
| 仓库级约束 | 🟡 | 第三方审查文档与 memory 登记已入 Task 8 Step 6；`verify_delivery` 不适用的判断正确；lint 已贴顶（Important-1）、每任务提交缺 build（Important-6）、CI 清单缺项（Important-5）、README.en.md 描述不准（Nit-1） |
| 测试设计 | 🟡 | 新增用例无弱断言形态（`check:test-quality` 实跑 911，与计划一致）；`as any` 三处会顶破 lint；Task 2 字节断言与 Task 7 ③ 传参两处按文字必红；Review Focus 3 的「编码穿越」无用例 |
| v1 审查条目处置 | 🟢 25/27 成立 | B7（anchor-rebase）选了正确的实现形态但验收测试与条件有误；I1（CI 清单补齐）不完整；其余成立，逐条见第六节 |

---

## 二、Blocking Issues

### B1. Task 7 ③（anchor-rebase）：验收测试传参形态错误 + 规则触发条件与计划夹具不匹配 + 对现状的「实测」不成立

**位置**：计划 Task 7 Step 1c 的 `const VP = { w: 800, h: 480 };` 与 `planRebase(INHERIT, undefined, VP)`；Interfaces ③「父尺寸静态不可解」；Step 2 Expected「传 viewport 时 Bg 仍 skip」；以及计划修订者交来的实测事实「传不传 viewport 都是 `skippedUnresolvedParent = ["BaseLayer","BaseLayer/Bg"]`、toWrite=0」。

**证据**：

1. 第三参形态。`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\ui\anchor-rebase.ts:193-196` 的签名是 `opts?: { viewport?: { w; h } }`，`:225` 取 `opts?.viewport`。既有测试的写法是 `const VP = { viewport: { w: 960, h: 540 } }`（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\test\ui-anchor-rebase.test.ts:298`）。计划把 `{ w, h }` 直接当第三参，`opts.viewport` 恒为 `undefined`。探针按计划写法实跑：`skippedUnresolvedParent = ["BaseLayer","BaseLayer/Bg"]`、`toWrite = 0`，与「不传 viewport」逐字段相同。
2. 现状不是「toWrite=0」。用正确形态 `{ viewport: { w: 800, h: 480 } }` 探现状：`toWrite = [BaseLayer]`，其 anchors 与 offsets **全 0**；`skippedUnresolvedParent = ["BaseLayer/Bg"]`。原因链：根无布局行 → `simulate`（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\ui\anchor-rebase.ts:126-155`）按零锚为根算出边距并写入**真值**尺寸条目 `{w:0,h:0}`（`:149-152`）→ BaseLayer 非零锚、父尺寸取到这份真值 `{0,0}`（`:139-147`）→ 边距算成 `{0,0,0,0}` 进 margins → `planRebase` ⑤（`:217-231`）因尺寸非正进 viewport 兜底，`margins.has` 守卫对这份退化边距放行 → 以视口求解出全零锚。也就是说现状对这类场景是**静默错写**：`dry_run=false` 会把全铺层改成 0×0 零锚。
3. 条件口径。Interfaces ③ 写「父尺寸静态不可解」。在该夹具（即反馈 :1054-1059 的原始形态，根 `HeroDetailContent` 无布局行）下，父尺寸不是「不可解」而是「解成 0×0」。探针按字面 `!ps` 模拟新规则：BaseLayer 仍写全零锚、Bg 仍 skip；把条件写成「不可解**或非正**」才得到计划测试期望的结果——BaseLayer 锚 `0/1/0/1`、offset 全为 `+0`，Bg 的 `restore` 为 `10/20/790/460`。

**为什么阻断**：

- 计划自己的验收用例按文字无法转绿：实现完全正确时第一条新用例仍红。
- 规则按字面落地修不到反馈里的原始场景：`simulate` 的判据是「尺寸条目有无」，`planRebase` ⑤ 的判据是「有无且为正」，两者口径不同，计划沿用了前者的措辞。
- 计划的现状认知有误，并漏掉一个既有缺陷：现状会把 BaseLayer 写成全零锚。新规则恰好能修掉它，但计划未点名、未钉回归；实现者若按「兜底段不动」只在 `simulate` 加分支而条件写偏，错写原样留下。

**建议改法**：

1. 测试：`const VP = { viewport: { w: 800, h: 480 } };`，调用保持 `planRebase(INHERIT, undefined, VP)`。
2. Interfaces ③ 条件改为：「父尺寸静态不可解**或非正**——根无布局行时 `simulate` 会为根写入真值的 `{w:0,h:0}` 尺寸条目，须按 `!(ps.w > 0 && ps.h > 0)` 判定，与 `planRebase` ⑤ 同口径」。
3. Step 1c 增一条回归锚：「传 viewport 时 BaseLayer 不得被写成全零锚（改动前现状即如此）」，并把 Step 2 的 Expected 改为「传 viewport 时现状产出 BaseLayer 全零锚条目 + Bg skip」。
4. Step 3 补一句实现自检：规则命中后 BaseLayer 的边距应为 `{l:0,t:0,r:W,b:H}`（探针模拟值 `{0,0,800,480}`），尺寸 `800×480`。
5. `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\ui\anchor-rebase.ts:20-24` 头注「已知边界」与 `:187-192` docstring 随新规则更新。

---

## 三、Important

**I1. lint 已贴顶，新测试里的 `as any` 必顶破 `npm run lint`。**
实跑 `npm run lint`：`533 problems (0 errors, 533 warnings)`；`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\package.json:41` 是 `--max-warnings 533`，零余量。测试目录下 `no-explicit-any` 为 warn（`...\eslint.config.js:85,106`）。计划 Task 4 ⑤ 的 `const ctx = { projectDir: '/p' } as any;`（1 处）与 Task 7 ①b 的 `createMockCtx() as any`（2 处）合计 +3。这三处照抄了既有写法（`...\test\persistence-warning.test.ts:524,536,549,561`），但基线已被既有写法占满。改法：新用例一律 `as never` 或 `as unknown as ToolContext`；Global Constraints 注明「余量为 0」。

**I2. Task 6 Step 4 第 4 项的 `node scripts/version-sync.mjs --check` 在 bump 之后、Task 8 之前必红。**
`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\scripts\version-sync.mjs:34-35` 的 B 类校验含 `changelog` 与 `readme`，`:76-84` 取 CHANGELOG 首个带日期段与 README 版本表首行，`:148-158` 逐项比对。当前 `...\CHANGELOG.md:13` 是 `## [0.41.0] - 2026-11-23`、`...\README.md:910` 是 `| **v0.41.0**`（实跑 `--check` 输出「✓ 版本元数据一致 (0.41.0)」）。Task 6 把 package.json 提到 0.41.1 后立即跑该项，B 类两项不一致，exit 1，与「Expected: 四条全 exit 0」矛盾。改法：Task 6 该项去掉 `--check`（或只验 A 类），完整 `--check` 放在 Task 8 Step 1 之后——Task 8 Step 2 已有。

**I3. Task 8 Step 2 的 `npm run score:gate` 缺前置 `npm run score`。**
`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\scoring\cli.ts:12` 在 `coverage/score.json` 不存在时抛「score.json 不存在,先跑 npm run score」，`:31-39` 转 exit 1；worktree 无 `coverage/` 目录。按计划文字实跑 `npm run score:gate` → exit 1。CI 的顺序是 `npm run build && npm run score`（`...\.github\workflows\ci.yml:160-164`）再 `score:gate`（`:166`），且其 vitest 带 `--coverage --reporter=json --outputFile=coverage/test-report.json`（`:150`），否则 score 的 coverage/performance 两维为 na（`...\src\scoring\generate-score.ts:37-41`）。改法：清单补 `npm run score`，并注明全量 vitest 需带 coverage 与 json reporter。

**I4. Task 2 Step 1 用例 3 的断言与 Interfaces 的单次路径文案不匹配。**
用例未传 `occurrence`，走单次路径（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\script\edit.ts:402` 缺省 1，返回点 `:508`）。Interfaces 给该路径的文案是 `…(${foundCount} total matches found, ${bytes} bytes written)`，不含断言要求的子串 `(N bytes written)`——只有 replace-all 路径的文案 `(${bytes} bytes written).` 能匹配。按文字实现后该用例仍红。改法：断言去掉括号，或用例改传 `occurrence: 0`。

**I5. 附录 A「I1 已按 ci.yml 补齐」不成立，Task 8 清单仍有缺项。**
缺 `node scripts/check-e2e-l2-coverage.mjs`（`...\.github\workflows\ci.yml:60-64`，阻断步，本批不新增 L2 文件故不会红，但清单自称「CI 同款」）；缺 `node scripts/check-env-isolation.mjs`（`:98-103`，advisory）与 `npm run audit:json`（`:157-159`，non-blocking）；godot-matrix 的 4.6.3/4.7.2 gdscript 门与 L2 e2e（`:206-279`）本地不可复现，应作为边界声明而非省略。另 `check:test-quality` 在 CI 是阻断步（`:92-93`）且当前已红（实跑 `911 > 上限 860`，exit 1），计划写「另跑并记录数字」弱化了它的阻断性质。

**I6. 每任务提交前未列 `npm run build`（或 `npx tsc --noEmit`）。**
`AGENTS.md`「提交前必跑 lint + test + build」；计划的 Global Constraints 只要求 lint，`npm run build` 首次出现在 Task 6 Step 4（Task 1–5 已提交之后）与 Task 8。vitest 经 esbuild 不做类型检查，`npm run typecheck:helpers` 只覆盖 `test/helpers`，`test/` 下新测试文件没有类型检查通道——B1 的 `opts` 形态错误恰是 TypeScript 弱类型检查能报、但没有任何门禁会报的那一类。改法：每个改 `src/` 或 `test/` 的任务在 commit 前加 `npx tsc --noEmit`。

**I7. Review Focus 3 的「编码穿越」没有测试落实。**
Task 7 Step 1 ① 的拒绝面清单是 `['../evil.tres', 'a/../b.tres', 'res://a/../b.tres', 'tmp\\x.tres', '/abs/x.tres', 'C:/abs/x.tres']`，无编码形态。设计上由 `sanitizeResPath` 兜住（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\tools\shared\value-serializer.ts:98-120`，迭代解码后查 `/../` 与 `\`），但未被钉住。建议补 `'tmp/%2e%2e/x.tres'`。

**I8. Task 7 的 `scene_path` 描述加长贴近预算硬线，Step 4 未列预算检查。**
实跑 `node scripts/check-token-budget.mjs`：`ui: schema 13242B / total 14277B`，error 线 `perToolSchema 13600`、`perToolTotal 14400`（`...\scripts\check-token-budget.mjs:29-30`）。计划文案 `;theme_create 仅 extract 必填(create 空 theme 不需要场景)` 按 UTF-8 为 66B，落地后 `perToolTotal` 余 57B。可通过，但措辞稍有加长即红，且 Task 7 Step 4 只列了 `build-matrix`、`gen:tool-docs`、`check:ssot-params`。改法：Step 4 补 `npm run check:budget`，并写明文案不得加长。

**I9. Task 4 的三点设计边界未在计划中声明（非缺陷）。**
(a) owner 偏好只对已写心跳的条目生效；`isBridgeReady`（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\src\core\bridge-client.ts:1224-1260`）只做 auth 探测、不核对 `ping.pid` 与 `proc.pid`，`run_project` 之后、本实例首个心跳落地之前，仍可能命中他人同项目实例。(b) 反馈 :619 建议②的「get_debug_output 响应透出 owner」未做，计划未声明取舍。(c) 反馈建议③是结构化的 `killed_previous_instances: [pid,...]`，计划改为文本尾注——受四条纯文本响应前缀契约限制，可接受，但回标时应写明是文本形态。

---

## 四、Nits

- **N1.** Task 8 Files 写「`README.md` 与 `README.en.md`（版本表 v0.41.1 行）」——`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.claude\worktrees\fix-feedback-batch-20261122\README.en.md` 无版本表（全文 300 行，`:298-300` 仅 `## Changelog` 链接；0.41.0 发版提交 `2972bfa5` 对它只加了 env 表行）。本批无新用户面 env，README.en.md 不需要动。
- **N2.** 行号小偏差：`extractBridgeScriptVersion` 在 `...\src\tools\game-bridge.ts:77`（`:76` 是 JSDoc）；`_write_registry_entry` 函数体到 `...\src\scripts\mcp_bridge.gd:982`。
- **N3.** Task 1 新建的不变量测试里，第二个用例的 `getToolDefinition('help')!` 依赖第一个用例调用 `registerAllModules()` 的副作用（`...\src\module-loader.ts:280-295` 幂等），用例顺序耦合，建议提到 `beforeAll`。
- **N4.** Task 5 的 `isCollapsedMeasure` 取「全树 0 尺寸」，比反馈 :1051 建议的「整树全 0（或根 size 0）」更严：根 0×0 而树内另有显式尺寸的节点时不出警告。属诚实降级，可接受，在 Interfaces 写明即可。
- **N5.** 各任务 commit subject 远超 `AGENTS.md`「≤72 字符（英文）或 ≤40 汉字」（仓库既有提交同样超长，属惯例偏差，非本批特有）。
- **N6.** Task 3 决策日志直接 `console.error`，未经 `getLogger()`。仓库对「可 grep 的一行」有直写 stderr 的先例（如 `...\src\core\mem-watchdog.ts`），可接受；建议在 Step 3 注明是有意不走 logger（避免被日志级别过滤）。
- **N7.** Task 2 的对账提示可补一句外部覆盖的可能：`checkTextResourceGuard` 只在 editor 模式接线（`...\src\core\ToolDispatcher.ts:1161-1167`），headless 改盘后若编辑器持有该脚本的脏缓冲，后续保存会把旧内容写回——与「回执成功、随后 git diff 为空」的形态吻合，与计划「不预设根因」不冲突，只是观测面补全。

---

## 五、已核实无误的锚点（修订时保留）

| 任务 | 锚点 | 核对方式 |
|---|---|---|
| 1 | `...\src\core\tool-registry.ts:102`（`getAllToolNames`）、`:123-129`（`getToolDefinition`）、`:349-359`、`:362-364`；`...\src\core\ToolDispatcher.ts:347-357`、`:375-383`；`...\src\core\args-validator.ts:65`、`:140-153`；`...\src\module-loader.ts:283`；`...\src\tools\help.ts:34-44`、`...\src\tools\debug.ts:51-92`、`...\src\tools\engine.ts:40-72` | 读源码 + 探针 |
| 2 | `...\src\tools\script\edit.ts:85-98`、`:143-154`、`:203-213`、`:406-453`、`:470-508`、`:611-661`；沙箱扫描先于写盘 `:417/:477/:617`，写盘 `:421/:479/:619`；`...\test\script-editing-mock.test.js:263-345`；`...\test\helpers\fixtures.js:23-27`（`main.gd` 原文） | 读源码 |
| 3 | `...\src\tools\game-bridge.ts:666-684`、`:729-731`、`:747-753`；自动调用点不传 force：`...\src\cli\bridge-session.ts:36`、`...\src\tools\qa\runner.ts:134`；`...\test\game-bridge-autoload-key.test.ts:20-54,88-92`；GD 侧无写入点（addon 与 `src/scripts` 全文检索）；`D:\workspace\projects\wt-godot\mcp_bridge.gd:25` 为 0.36.2、受跟踪且干净 | 读源码 + 只读 git |
| 4 | `...\src\tools\runtime.ts:213-221,280-283,301-304,406-408`；`...\src\core\bridge-client.ts:135-177`（`:141-142` 覆盖早退、`:163-169` 平票决胜、`:187-211` 不动）；`...\src\tools\game-bridge.ts:119-158,948-951`；`...\src\scripts\mcp_bridge.gd:1380-1396`；`...\src\core\godot-finder.ts:567-576`；`...\test\game-bridge-registry.test.ts:33-44,75,187`；`...\test\game-bridge-validation.test.ts:201`；`...\test\game-bridge.test.ts:67-84,147-152`；`...\test\bridge-feedback-batch-b1b2-contract.test.ts:18-26`；响应消费方 `...\src\GodotServer.ts:694-700`、`...\src\cli\bridge-session.ts:46-47`、`...\src\tools\qa\runner.ts:153-156` 均为前缀或子串匹配 | 读源码 |
| 5 | `...\src\tools\ui\index.ts:659-663,676-695,1085-1098,1132-1135,1141`；`...\src\tools\ui\layout-diff.ts:23-29,39-70`（`actual` 形态支持 `d.actual.w` 断言）；`...\test\ui-quality-check.test.ts:502-594,596-648` | 读源码 + 探针 |
| 6 | `...\src\scripts\mcp_bridge.gd:2994-2998`；`...\.claude\rules\godot-mcp-bridge.md:56`、`...\src\tools\rule-templates.ts:249`；`...\scripts\version-sync.mjs:33`（A 类六文件）、`:29`（`bridgeGd`）；`...\scripts\gen-tool-docs.mjs:122,138-139`；`...\package-lock.json:3,9` 根版本 0.39.0（既有陈旧）；无测试写死 `0.41.0` 与 package.json 耦合（仅 `...\test\scripts\memguard-review.test.ts:42,389` 的样本数据） | 读源码 |
| 6 | GD 代码块合法性（4.5–4.7，静态判断）：`get_viewport()`/`get_window()` 返回具体类型，`:=` 推断成立；`Viewport.content_scale_factor`、`Window.size`（`Vector2i`）、`String.to_int()`、`OS.get_environment()` 均为 4.0 起即有的 API；字典尾逗号、`"…" % [` 跨行数组字面量合法。注意 `window_size` 两键是 int、`size` 两键是 float，JSON 形态不同但不影响 `scale_hint` | 读源码 |
| 7 ①② | `...\src\tools\ui\index.ts:50,380-406,1253-1258,1275-1285`；`...\src\tools\ui\ui-theme.ts:116-183`（prelude `:175-179`）；`...\src\tools\ui\ui-extract.ts:20-28,325-333`；`...\test\ui-extract.test.ts:108-117,256-289`；`...\test\ui-import-prototype.test.ts:14-19,85-95`；`...\test\persistence-warning.test.ts:19-23,42-63,520` | 读源码 |
| 7 ③ | 新规则不改变 `...\test\ui-anchor-rebase.test.ts:296-343`、`:345-374`、`:531-549`、`:575-615` 的结果（逐夹具核对：无「一级子 + 全锚 + 零 offset」形态，`:575-615` 不传 viewport）；规则命中后的数值（BaseLayer `0/1/0/1` 与 `+0`、Bg restore `10/20/790/460`）经探针模拟成立 | 读源码 + 探针 |

---

## 六、附录 A 映射逐条核对

| v1 条目 | v2 处置是否成立 | 依据 |
|---|---|---|
| B1（`src/helpers.ts` 已删） | ✅ | 改列 `...\src\core\godot-finder.ts:567-576` 且不改，锚点精确 |
| B2（Task 3 根因不成立） | ✅ | 根因段重写、回标 🟡、加 stderr 决策日志；代码侧「无 force 不覆盖」与「GD 无写入点」均复核成立 |
| B3（ping 无 ownerPid） | ✅ | `_cmd_ping` 增 `ownerPid`，Files 含 `...\src\scripts\mcp_bridge.gd:1380-1396` |
| B4（env 注入自相矛盾） | ✅ | 两个 spawn 点 `:280-283`/`:301-304`；env 名落入 `GODOT_MCP_BRIDGE_` 透传前缀（`...\src\core\godot-finder.ts:570`），白名单未动 |
| B5（缺 `ui-theme.ts`） | ✅ | prelude 按 action 分支，Files 与测试已补 |
| B6（归一值未落回调用点） | ✅ | 落盘 `:1278` 与回执 `:1283` 同用归一值，新测试钉 `persist.path` 与第二次 executor 调用 |
| B7（viewport 线程矛盾） | ⚠️ 形态选对，验收有误 | `simulate(parsed, viewport?)` 是正确落点、兜底段不动；但验收测试传参与规则条件有误，见 B1 |
| B8（`BRIDGE_SCRIPT_VERSION` 手改） | ✅ | 交 Task 6 的 `version-sync` 写入，Task 4 明写「不手改」 |
| B9（模板与 bump 分属不同提交） | ✅ | bump 并入 Task 6，Task 6/7 对调；`check-rules-version-bump.mjs` 的本地语义支持该做法 |
| B10（缺审查文档与 memory） | ✅ | Task 8 Step 6 |
| I1（CI 清单缺 5 项） | ❌ 不完整 | 原缺的 5 项已补，但仍缺 `check-e2e-l2-coverage` 等，见 I5 |
| I2（`finalContent.length` 非字节） | ✅ | 改 `Buffer.byteLength(…, 'utf8')` |
| I3（第三路径变量名） | ✅ | `result` 已点名，尾注落 header 行 |
| I4（mtime 断言不稳） | ✅ | 先钉到 2 分钟前 |
| I5（warnings 字段名） | ✅ | `warnings` 与 `build_warnings` 分列 |
| I6（既有语义锚未点名） | ✅ | Review Focus 4 与 Step 1c/2 已点名，两条锚确不受影响 |
| I7（owner 回落细节） | ✅ | Step 1 ② 覆盖「本 server 端口失败 → 回落他人条目」，覆盖早退保持最先 |
| I8（`isCollapsedMeasure` 口径） | ✅ | 已写死（口径偏严见 N4） |
| I9（GD 无契约测试） | ✅ | Task 4/6 共用契约测试文件，辅助函数可照抄 |
| N1/N2/N3 | ✅ | 不适用成立（不再改 `args-validator.ts`） |
| N4（成功文案四处 return） | ✅ | 经 `sessionNote` 单点追加，测试覆盖四条前缀与首跑不附 |
| N5（归一应拒绝对路径） | ✅ | 拒 `/` 开头与盘符路径 |
| N6（「9 条」口径） | ✅ | Goal 改为「9 个工作项覆盖 10 条反馈」 |
| N7（run_tests 状态行） | ✅ | Task 8 Step 4 回标 |
| N8（与 B2 合并） | ✅ | 已并入 Task 3 根因段 |

---

## 七、验证边界

**做了什么（实跑）**：
- 只读探针（仓库外 `C:\Users\wgt\AppData\Local\Temp\plan-review-r2\`，导入 worktree 的 `build` 产物；该目录的清理命令被权限系统拒绝，文件留在仓库外）：Task 1 不变量（46 个工具、offender 集合）；Task 5 塌 0（`quality=null`、`order.equidistant` gap=0）；Task 7 ③ 现状与规则模拟（三种传参形态对照）。
- 定向 vitest：计划涉及的 14 个既有测试文件，518 条全过（基线）；跑后已 `git checkout -- test/fixtures/gdscript-check/project.godot`，`git status --short` 仅剩计划文件。本次运行触发了这些文件里既有的 GODOT_PATH 门控 e2e，它们会向 `D:\workspace\projects\DotaLegendGodot\scenes\ui\` 写临时副本场景——已确认自清理、该目录 `git status` 无变化。
- `npm run lint`（533/0）、`node scripts/check-test-quality.mjs`（911，exit 1）、`node scripts/check-token-budget.mjs`（0 error）、`node scripts/version-sync.mjs --check`（✓ 0.41.0）、`npm run score:gate`（exit 1，缺 score.json）。
- 只读 git：`D:\workspace\projects\wt-godot` 的 `mcp_bridge.gd` 跟踪、干净、版本 0.36.2。

**没做什么**：
- 未跑全量 vitest；未跑 `build-matrix`、`gen:tool-docs`（会改写仓库生成物，不在授权写入范围）——「`docs/tools` 重生成会产出与本次无关的存量差异、并顺带清掉 master 上 H-5 门的既有漂移」是按 `...\scripts\gen-tool-docs.mjs:122,138-139` 与两份文件现状的推断，非实跑结果。
- 未跑 `check:gdscript`、L2 e2e、godot-matrix：Task 6/4 的 GD 代码块合法性为静态判断，未经 Godot 编译。
- 各「会红/会绿」的结论除上列探针外均来自读测试源码与实现源码；未把计划里的测试片段写进仓库试跑。
- 未修改计划、源码或测试；本文件是唯一写入仓库的产物。

**值得进 memory 的工程教训**：
1. 计划作者交来的「实测事实」可能与测试代码同源同错（本例是同一个传参形态错误）——审查者应用自己的探针独立复测，尤其是当实测结论与测试期望互相印证时。
2. `anchor-rebase.ts` 的 `simulate` 以「尺寸条目有无」判可解，`planRebase` ⑤ 以「有无且为正」判——零锚节点恒产生真值条目（0×0 也是真值）。在该模块加规则须对齐后者口径，否则反馈的原始形态（根无布局行）不命中。
3. `npm run lint --max-warnings 533` 已贴顶即零余量：照抄既有 `as any` 写法必顶破，新测试一律 `as never`。
4. `check-rules-version-bump.mjs` 以 `git diff HEAD -- package.json` 判 bump，提交后在 CI 恒跳过，只是本地 pre-commit 门禁。
