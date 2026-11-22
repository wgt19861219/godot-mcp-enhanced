# 2026-11-22 反馈批次 20261122 实施计划 —— 独立审查

**审查对象**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\plans\2026-11-22-feedback-batch-20261122.md`（182 行，8 任务）
**审查方式**：静态核对（逐条 read/grep 比对 file:line 锚点 + 反馈库原文 + 仓库级约束脚本），**未执行测试**（原因见末节「验证边界」）。
**审查结论**：**BLOCKING ISSUES** —— 方向正确（守卫/可观测性/诚实暴露，不预设根因），多数锚点精确，但有 10 处阻断级问题，按现状执行会返工或产出不成立的修复。

---

## 一、总体维度结论

| 维度 | 结论 | 说明 |
|---|---|---|
| 需求覆盖 | 🟡 基本对齐 | Task 1~7 与反馈库 10 条条目一一对应（"9 条"是 9 个工作项折叠 10 条反馈）；deferred 显式登记。但 11-14 根因不成立（B2）、theme_create 分支未决（B5）。 |
| 技术可行性 | 🔴 | 4 处按计划文字不可实现/会落错位置：B1（文件不存在）、B3（数据通道缺）、B4（env 注入机制自相矛盾）、B6/B7（归一值不落调用点、viewport 线程矛盾）。 |
| 版本链正确性 | 🔴 | B8：`BRIDGE_SCRIPT_VERSION` 是 version-sync A 类写入项，手改 +1 会与 package.json 漂移；B9：规则模板改动与 bump 不同 commit。 |
| 仓库级约束 | 🔴 | B10：缺 AGENTS.md 强制的第三方审查文档与 memory 登记；I1：Task 8「全量门禁」缺 5 条 CI 实跑项。 |
| 测试设计 | 🟡 | 每任务有 TDD 步骤，但 mtime 断言不稳定（I4）、字段名不统一（I5）、既有语义锚未点名（I6）。 |
| 回滚/兼容 | 🟢 | Task 4 的「旧条目无 ownerPid 回落现行为」已进 Review Focus 2 与测例，方向对；补 I7 的回落细节即可。 |

---

## 二、Blocking Issues

### B1. Task 4 Files 指向已删除的 `src/helpers.ts`（文件不存在）

计划第 93 行：`Modify: src/helpers.ts buildSafeEnv`。该文件已于可维护性批 2 删除（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\CHANGELOG.md:276`「`src/helpers.ts` 删除」）；`buildSafeEnv` 现居 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\godot-finder.ts:567`（白名单前缀在 :570-572，exact 透传在 :565）。
行内虽有「grep `buildSafeEnv` 定位」可自愈，但计划自称锚点经探查确认，交付级文档不应列不存在的路径。**改**：Files 改为 `src/core/godot-finder.ts:565-576`。

### B2. Task 3 的「确凿漂移源」不成立，修复不对症

反馈原文（`D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md:624-632`）的症状是 **内容 0.36.2→0.36.7 的改写**弄脏 git。而 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\tools\game-bridge.ts:669-684` 的逻辑是：

- 内容不同 + 无 force → **保持原样**（:676-678）；
- 内容不同 + force → 覆盖（:671-675）；
- 内容相同 → 拷贝（:679-681）。

即 **无 force 时任何路径都不会把内容从 0.36.2 改成 0.36.7**。全仓 `game_bridge_install` 的自动调用点（`src\tools\qa\runner.ts:133-141`、`src\cli\bridge-session.ts:36`）都不传 `force`，e2e 测试也不传。因此 :680 只影响 **mtime**；而 mtime 刷新不会让 `git status` 变脏（git 按内容判定），计划「mtime 每次刷新→git 状态面被扰动」的说法不成立。

结论：Task 3 的改动本身无害（保 mtime 有价值、可测），但**不是 11-14 条的解**。**改**：重写根因段为「真实写入者未定位」，回标 11-14 为 🟡（而非 🟢），并加一条 install 决策日志（bundled/project 版本 + kept/overwritten/skipped）供下次复现定谳。

### B3. Task 4 ⑤ 缺数据通道：ping 响应没有 ownerPid

Interfaces ⑤ 要求「选中实例 ownerPid 存在且 ≠ 本 server pid 时附一行 note」，挂在 `annotatePingWithVersion`（`src\tools\game-bridge.ts:126-158`）通道。但 GD 的 `_cmd_ping` 响应（`src\scripts\mcp_bridge.gd:1380-1396`）字段为 pong/version/bridgeVersion/capabilities/scriptFingerprint/scene/fps/pid/project，**没有 ownerPid**；计划 GD 侧只改心跳条目（:960-971）。
**改**：二选一写死——(a) `_cmd_ping` 增 `ownerPid`（Files 补 `:1380-1396`，env 缺省省键），(b) 让 `resolveBridgePort` 同时返回被选条目 owner（改动面更大，不推荐）。

### B4. Task 4 env 注入机制自相矛盾，注入点写错位置

`buildSafeEnv` 只从 `process.env` 复制（`src\core\godot-finder.ts:567-576`）：**只往白名单加 `GODOT_MCP_OWNER_PID` 不会让变量出现**，必须有来源。计划同时要求「白名单加」+「spawn 注入」，但没规定哪条为真：

- 若 spawn 处 `{ ...buildSafeEnv(), GODOT_MCP_OWNER_PID: String(process.pid) }` → 白名单改动**多余**；
- 若启动时写 `process.env.GODOT_MCP_OWNER_PID` → **必须**加白名单，且 Files 要补服务入口（`src\index.ts` 或 `GodotServer` 启动点，现均未列）。

另：注入点写 `runtime.ts:333`，那是 `registerSpawnedGodotPid`（spawn 之后）；真实 spawn 在 `src\tools\runtime.ts:233-237`（profiling 分支）与 `:254-257`（普通分支），**两条都要加**，否则 `--debug` 路径无归属。

### B5. Task 6 ②「theme_create create 免 scene_path」按现状 Files 不可实现

计划判定条件问错了对象：「若 `genThemeCreateScript`（`src\tools\ui\ui-theme.ts:114` 起）create 路径确不消费场景则直接免」。create 的 actionBlock 确实不消费（:124-126），但生成脚本的 **prelude 无条件 `_mcp_load_scene(scenePath)`**（`src\tools\ui\ui-theme.ts:175-179`），所以「直接免」必须改 `ui-theme.ts` 的 prelude（按 action 分支），而该文件**不在 Task 6 Files 里**；否则只能走计划备选的「降级为 description 修正」，那 Step 1 ② 的「create 无 scene_path 成功」测例会红。

**改**：二选一写死并把 `src/tools/ui/ui-theme.ts` 补进 Files（含生成器单测），或明确降级为 description-only 并删掉 create 免参的测例。

### B6. Task 6 ① draft_path 归一值没有落回调用点（功能不生效）

`src\tools\ui\index.ts:1253-1258` 的 `draftRaw` 只用于校验；实际落盘用 `genDraftSaveScript(String(draftRaw), draft)`（:1278），回执用 `payload.persist.path = String(draftRaw)`（:1283）。若只改校验块，相对路径仍原样传给 GD，归一不生效（甚至写到 CWD）。**改**：把归一结果赋回 `draftRaw`（或新变量）并用于 :1278/:1283；测例断言 `persist.path === 'res://tmp/...'`。

### B7. Task 6 ③ anchor-rebase：viewport 线程矛盾，"推进一层"按现状跑不通

- `simulate(parsed)`（`src\tools\ui\anchor-rebase.ts:126-155`）**不接收 viewport**，`sizes`/`margins` 一次算完；
- 根形态全锚节点在 simulate 里 `margins` 缺失（:139-148 需要父尺寸）；
- planRebase 的 viewport 兜底（:217-231）又被 `!margins.has(n.path)`（:227）挡住；
- 计划 Files 说改 `:126-155` 且「`:217-231` 兜底段不动」，Interfaces ③ 却说「经既有 :217-231 兜底链解根后同样继承」——viewport 只存在于 planRebase（:193-196），两处指令互斥。

**改**：明确实现形态——(a) `simulate(parsed, viewport?)` 签名扩展（Files/测试随动），或 (b) planRebase 内先为根形态全锚零 offset 节点补 `margins`/`sizes` 再继续求解（此时 :217-231 的约束不变，但 Files 要写 planRebase 而非 simulate）。并写明「只推进一层」是否够覆盖反馈的 `根>BaseLayer>Bg`（够）以及多层链的诚实跳过语义。

### B8. 版本链：`BRIDGE_SCRIPT_VERSION` 不能手改 +1

`BRIDGE_SCRIPT_VERSION` 是 version-sync 的 **A 类写入项**（`src\scripts\mcp_bridge.gd:25` 当前 `"0.38.1"`；`scripts\version-sync.mjs:29,33,87-92,121-123` 由 package.json 单向写入）。计划 Global Constraints 与 Task 4 Step 4 / Task 7 Step 1 要求「同批 bump / 常量 +1」，会与 package.json 漂移：CI 实跑 `version-sync.mjs --check`（`.github\workflows\ci.yml:90-91`），中间 commit 若 bridge=0.38.2 而 package=0.38.1 必红。且 2026-11-12 批次计划已写明「BRIDGE_SCRIPT_VERSION 由 scripts/version-sync.mjs 管，勿手改」（`docs\superpowers\plans\2026-11-12-反馈批次全量修复方案.md:16`）。
**改**：删掉手改指令，写「Task 8 `npm version patch` 后由 `npm run version-sync` 自动写入 0.38.2」；若要前置 bump，必须同 commit 把 package.json 也提到 0.38.2。

### B9. 规则模板变更与 bump 分属不同 commit

Task 6（条件分支）/Task 7 改 `src\tools\rule-templates.ts`，bump 在 Task 8。AGENTS.md:311 与 `scripts\check-rules-version-bump.mjs:44-90` 的语义是「工作区模板变了 → 同工作区必须有 package.json +version」；Task 7 commit 前本地跑门禁必红（提交后 HEAD==工作区才不触发）。仓库已有同形态判例：`docs\reviews\2026-11-17-refero-batch4-plan-review.md:83` 已把「bump 推到后续 Task」判为问题。
**改**：bump 提前到首个改模板的 commit（与模板改动同 commit），Task 8 只做收口；或把规则文档改动整体并入 Task 8 commit（破坏任务边界，不推荐）。

### B10. 缺 AGENTS.md 强制产物：第三方审查文档 + memory 登记

- 「plan 落地后必出第三方审查文档」要求 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\reviews\YYYY-MM-DD-<feature>.md`（现有最新为 `2026-11-17-*` 四份），计划 Task 8 无此步；
- 「完成前必登 memory」要求 feature-decision-log（feature/commit 清单/决策/实现位置/deferred）+ 至少一条 engineering/testing lesson，计划也无。

两条都是 AGENTS.md 明文强制。**改**：Task 8 增 Step「派 `code-reviewer` 出独立审查文档」与 Step「memory create_entities（feature-decision-log + lessons）」，并把两者写成完成判据。

---

## 三、Important（不阻塞，但不改会门禁红/返工/误导）

- **I1. Task 8「全量门禁」清单缺 CI 实跑项**：`check-rules-version-bump`（ci.yml:88-89）、`version-sync --check`（:90-91）、`check:budget`（:44-49，Task 6 改描述会动 ui schema 体积，当前 perToolSchema error 线余量约 640B）、`check:changelog-sync`（STRICT，:104-112）、`score:gate`（:166）。其中 budget/version-check 是硬失败。
- **I2. Task 2「bytes written」用 `finalContent.length` 是 UTF-16 码元，不是字节**。GDScript 常含中文注释，标 bytes 会误导对账；用 `Buffer.byteLength(finalContent, 'utf8')` 或文案改 chars。
- **I3. Task 2 第三路径变量名是 `result` 不是 `finalContent`**（`src\tools\script\edit.ts:613,619,621,659,661`），按 Step 3 照抄会编译失败；且 diff 模式收尾是多行 diff，尾注建议放 header 行（:638）。
- **I4. Task 3 的 mtime 断言不稳定**：同秒 copy 可能 mtime 相同。仓库已有确定性范式：`test\web-gui\portal.test.ts:113-146` 先把 mtime 钉到 2 分钟前再断言不变，建议照搬。
- **I5. Task 5 warnings 字段名不统一**：measure 链路是 `parsed.warnings`（`src\tools\ui\index.ts:602,659-663`），import 链路是 `build_warnings`（:1141）。计划笼统写「响应 warnings 数组」，import 测例会找不到字段。
- **I6. Task 6 ③ 需点名既有语义锚**：`test\ui-anchor-rebase.test.ts:345-374`（「深层链断不被 viewport 兜底」）与 `:575-615`（真靶子两态 `written=0`）。前者因 offset 非零（:359-366）不受新规则影响，后者若命中全锚零 offset 会翻转——计划要写明「哪条是语义升级需改断言、哪条必须保持」。
- **I7. Task 4 回落细节**：owner 过滤后子集为空必须回落现行为，不能直接跳 `scanSecretWindow`；且 `GODOT_MCP_BRIDGE_PORT_OVERRIDE` 早退（`src\core\bridge-client.ts:139-140`）应保持最高优先级（override 语义不变）。
- **I8. Task 5 `isCollapsedMeasure` 判定口径未定**：`MeasuredNode[]` 的"根节点"如何取（nodes[0]？path '.'？）、空数组返回什么、单节点 0 尺寸是否算塌。需在任务里定死，否则实现分歧。
- **I9. GD 侧改动无源码契约测试**：Task 4（心跳 ownerPid）与 Task 7（viewport 三键）只有 `check:gdscript` 编译验证，行为回归无护栏。仓库有源码契约测试先例（`test\bridge-feedback-batch-b1b2-contract.test.ts`），建议各补一条 grep 断言。

## 四、Nits

- **N1.** Task 1 Step 3 说集合字面量在 `args-validator.ts:58`，实际是 **:65**（:57-64 是注释块）。Files 的 `:57-65` 写法 OK。
- **N2.** Task 1 Test 路径写 `test/core/args-validator.test.ts`，实际是 `test\args-validator.test.ts`（计划已带 grep 兜底，可直接改对）。
- **N3.** `src\core\args-validator.ts:63` 注释说与 `scripts\check-ssot-params.mjs` 的 godot_path 特判同源；加 project_path 后该脚本 :153 仍只特判 godot_path。当前不会红（无 handler 读未声明的 project_path），但注释应说明「check 脚本特判不跟进」的理由。
- **N4.** Task 4「三种成功文案」实际是四处 return（`src\tools\runtime.ts:361/363/366/368`）；「三种前缀」表述可，测试要覆盖 4 条分支。
- **N5.** Task 6 ① 归一规则还应收紧「以 `/` 开头的绝对路径」（否则拼成 `res:///abs`），计划只列了 `..` 与 `\`。
- **N6.** 「9 条」是 9 个工作项覆盖 10 条反馈（11-18 的空根与塌 0 合并为一项）；Task 8 回标写「UI 五条」是对的，Goal 处点明口径更可审计。
- **N7.** 反馈库 11-12 run_tests（`插件反馈与改进建议.md:643-650`）仍标 🔴 open，但 11-13 回标表（:19）标 🟢（D6 已修）——Task 8 回标时顺手校正状态行，或注明排除理由。
- **N8.** 11-14 条原文（:627-628）写「全程未用任何 mcp__godot:* 工具」，与计划「自动触发链是 qa runner / CLI bridge-session」的前提冲突——恰是 B2 的另一证据，重写根因时一并处理。

## 五、已核实锚点（供修订时保留）

| 任务 | 锚点 | 核对结果 |
|---|---|---|
| 1 | args-validator.ts:57-65/:68-92/:75；ToolDispatcher.ts:344-357/:375-383；help.ts:28-47；help 不在 NO_PROJECT_PATH_TOOLS（tool-registry.ts:349-359） | ✅ 全部命中 |
| 2 | edit.ts:452/:508/:661 成功路径；:89 回滚；:203-206 C#；:417-418/:477-478/:617-618 沙箱扫描；verifyWriteResult :143-154 | ✅ 全部命中 |
| 3 | game-bridge.ts:659-684，:680 同内容无条件 copy；qa/runner.ts:133-141；qa/spec.ts:167 默认 true；bridge-session.ts:36-39 | ✅ 命中（但根因见 B2） |
| 4 | instance-manager.ts:26-39；bridge-client.ts:133-175/:161-167/:185-207；runtime.ts:197-205/:333；process-state.ts:161；GodotServer.ts:794-796；mcp_bridge.gd:960-971；annotatePing :126-158 | ✅ 命中（数据通道见 B3） |
| 5 | ui/index.ts:680；:1133-1135；:1079-1098；:993 normalizeNodePath；MeasuredNode.rect（layout-diff.ts:12-17） | ✅ 命中 |
| 6 | ui/index.ts:1253-1258/:380-402/:50；anchor-rebase.ts:126-155/:217-231；ui-theme.ts:114（函数在 :116，create 分支 :124） | ✅ 命中（实现缺口见 B5/B6/B7） |
| 7 | mcp_bridge.gd:2993-2997；method 表 :1267-1268 与 game-bridge.ts:403 已暴露；规则双副本 :53-60 与 rule-templates.ts:234-241 | ✅ 命中 |

## 六、验证边界（本次审查没做什么）

- **未执行任何测试/门禁命令**：本会话 `pwsh` 被 Windows 沙箱 ACL 挡住（`windows-acl workspace grant failed`，SetNamedSecurityInfoW Win32 5），所有 shell 命令无法启动。因此「某测试会红/绿」的判断均来自**读测试源码**（如 ui-anchor-rebase.test.ts、script-editing-mock.test.js、game-bridge-workspace-guard.test.ts），不是执行结果。
- 已核对的外部输入：反馈库原文（11-12/11-14/11-18×6/11-20/11-22 各条）、CHANGELOG、package.json、ci.yml、version-sync/check-* 脚本、AGENTS.md 对应条款。
- 未修改计划文档；本文件为唯一新增。

## 七、建议修订顺序

1. 先修 B1/B3/B4/B8（Task 4 的可执行性与版本链）→ Task 4 重写 Files/Interfaces/Steps。
2. 修 B5/B6/B7（Task 6 三个分支各写死一条实现路径）。
3. 重写 Task 3 根因与回标口径（B2），把 11-14 降为 🟡。
4. 版本/规则/审查/memory 的流程点（B9/B10/I1）并入 Task 8。
5. 最后清 I2-I9 与 Nits；重跑一遍锚点核对再交实现。
