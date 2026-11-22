# memory-guard 三期（实现收敛批）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛二期遗留的 spec↔实现差分（WATCHDOG_EXEMPT 补 env 实现）+ 用测试钉住两处靠注释论证的正交性/幂等性 + static_mem 真机实测 + 查⓪ 报文 UX 微瑕。

**Architecture:** 三期是 `2026-11-22-memory-guard-design.md`（已过审）的实现收敛批，不新写 spec。驱逐候选生成的唯一写者保持在 `memory-guard.ts`（getEvictionCandidates），env 豁免在该单点过滤；单进程硬帽（KILL_FACTOR）与驱逐豁免严格正交（Docker 反模式禁令）；L3 面板（buildMemoryPanel 单源）透出豁免配置。

**Tech Stack:** TypeScript (Node, vitest) + GDScript（仅真机实测，无 GD 改动）。

**Spec:** `docs/superpowers/specs/2026-11-22-memory-guard-design.md`（§L2 豁免规则、§L3 可观测性）；二期终审 `docs/reviews/2026-11-22-memory-guard-phase2-review.md`（Spec 偏离段 + 后续建议段 = 本期需求来源）。

## Global Constraints

- 同一期（版本四件 Task 6 一笔、lint 零新增、中文注释、分支 `feat/memory-guard-p3`、不引新依赖；覆盖率门禁 `npx vitest run --coverage`（二期口径 76/67/80/77 不回退）+ CHANGELOG `check:changelog-sync` + docs/reviews/ 独立审查 + memory 登记）。
- **单进程硬帽独立于驱逐豁免**（Docker 反模式禁令）：`KILL_FACTOR`（headless/gut_shard ×2，game_window/editor ×3）恒常开，`GODOT_MCP_WATCHDOG_EXEMPT` 只影响**驱逐候选集合**，不影响单进程杀线（spec §L2 原文语义；mem-watchdog.ts 头注释既有声明）。
- **殿后语义与 env 豁免正交**：未设 env 时 preview/editor 殿后（二期现状不变）；env 命中的组整体不进候选，未命中的组维持殿后。
- **外部进程永不杀**（候选只来自本 serverPid 租约账本，一期管辖口径不动）。
- env 语义（spec §L2 提法落地）：`GODOT_MCP_WATCHDOG_EXEMPT` 逗号分隔 token，合法值 `preview`（豁免 preview===true 的 game_window 会话）/ `editor`（豁免 editor kind）；未知 token stderr warn 一行 + 忽略该 token（合法 token 照常生效——部分生效优于整体失效，豁免不生效是保守方向但必须让用户看见）；未设/空串回默认（无豁免）。
- 版本 0.39.0 → **0.40.0**（minor：新 env 面触及工具行为，按 version-bump-discipline）。
- 排除范围（挂账不动）：档位回看（面板数据未积累，推迟）；CHANGELOG [Unreleased] 其余 deferred 备案（租约互斥/JSONL 审计/killPidTree promise 化/blender 档位）不进本期。

## Review Focus

1. **env 部分非法**（如 `prevew,editor` 拼错）→ 不得整体失效：合法 token 照常豁免 + stderr warn 点名非法 token（Task 1 测试）。
2. **豁免组残留殿后**（env 只豁免 editor）→ preview 仍殿后、普通候选 ratio 降序不变（Task 1 测试）。
3. **单进程硬帽与豁免正交**（env 豁免 editor 后 editor RSS 超声明×3）→ 仍被单进程杀（Docker 禁令核心语义，Task 1 测试）。
4. **候选耗尽报文区分「真无租约」vs「全被 env 豁免」**→ 耗尽仍 hard 时报文附豁免笔数，不误报「无本 server 可驱逐进程」（Task 1 测试）。
5. **查⓪ enteredAt null 防御**：报文拼持续时长时 `getPressureEnteredAt()` 理论非 null（状态机保证），防御性 null 跳过时长后缀不炸（Task 6 测试）。

---

### Task 1: WATCHDOG_EXEMPT 驱逐候选过滤（行为层）

**Files:**
- Modify: `src/core/memory-guard.ts:459-486`（getEvictionCandidates 签名与过滤 + 新导出 watchdogExemptGroups）
- Modify: `src/core/mem-watchdog.ts:147-162`（evictForHardThreshold 消费新签名 + 耗尽报文附豁免计数）
- Test: `test/core/memory-guard.test.ts`（候选过滤 describe）
- Test: `test/core/mem-watchdog.test.ts`（豁免行为 describe）

**Interfaces:**
- Consumes: 既有 `listActiveLeases` / `sampleRssBytesCached` / `getSession`（process-state）/ `readPositiveIntEnv` 惯例（列表 env 需新解析函数，非正整数）。
- Produces:
  - `export function watchdogExemptGroups(): ReadonlySet<'preview' | 'editor'>`（每次调用实时读 env，不缓存——对齐 readPositiveIntEnv 低频惯例；Task 2 的 buildMemoryPanel 与 doctor 消费）
  - `export function getEvictionCandidates(): { candidates: Array<{ lease: MemLease; ratio: number }>; envExempted: { preview: number; editor: number } }`（唯一消费方 mem-watchdog 同步改）

- [ ] **Step 1: 写失败测试（memory-guard.test.ts 加 describe「⑭ 三期：WATCHDOG_EXEMPT 候选过滤」）**

测试用例（mock 租约账本 + `_setPsRunnerForTest` 既有基建，`_resetForTest` 隔离）：
- env 未设：返回结构与二期语义等价（candidates 为既有排序清单、envExempted 全零）——注意签名变了，既有驱逐测试同步适配。
- env=`editor`：editor kind 租约不进 candidates、envExempted.editor=计数值；preview 会话仍殿后、headless 普通候选 ratio 降序不变（Review Focus 2）。
- env=`preview,editor`：preview===true 的 game_window 与 editor 均不进候选；非 preview 的 game_window 视为普通候选。
- env=`prevew,editor`（拼错）：仅 editor 生效 + stderr warn 含 `prevew`（Review Focus 1；spy console.error）。
- env=空串/`,,`：等同未设（envExempted 全零、候选含全部组）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/memory-guard.test.ts -t "WATCHDOG_EXEMPT"`
Expected: FAIL（watchdogExemptGroups 未定义 / 签名不匹配）

- [ ] **Step 3: 实现 memory-guard.ts**

- `watchdogExemptGroups()`：parse `process.env.GODOT_MCP_WATCHDOG_EXEMPT`——split `,` → trim → toLowerCase → 命中 `preview`/`editor` 进 Set；未命中非空 token 记 `console.error('MEMGUARD WATCHDOG_EXEMPT 未知 token「<raw>」(合法: preview,editor),已忽略——其余合法 token 照常生效')` 一行/每 token。
- `getEvictionCandidates()`：rows 构建后先按 env 剔除（`preview` 组 = game_window 且 session preview===true；`editor` 组 = kind==='editor'），剔除计数进 `envExempted`；剩余 rows 维持既有 exempt（殿后）排序逻辑原样。
- 更新函数头注释：殿后≠永不杀 + env 豁免组不进候选 + 单进程硬帽独立（对齐 mem-watchdog.ts 头注释既有声明）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/core/memory-guard.test.ts`
Expected: PASS（含既有驱逐 describe 适配后全绿）

- [ ] **Step 5: 写失败测试（mem-watchdog.test.ts 加 describe「三期：env 豁免×驱逐×单进程硬帽正交」）**

- env=`editor` + hard 态 + 仅 editor 租约存活（超 RSS mock）→ `evictForHardThreshold` 路径不杀 editor（pollOnce 进驱逐循环、耗尽 break）；console.error 耗尽报文含「被 GODOT_MCP_WATCHDOG_EXEMPT 豁免」与笔数（Review Focus 4）。
- env=`editor` + editor RSS 超 declaredMB×3 → pollOnce **单进程杀路径照杀**（Review Focus 3，Docker 禁令：硬帽不受豁免影响）——断言 killPidTree spy 被调 + 归因记录。
- env=`editor` + hard 态 + headless 与 editor 并存 → 驱逐只杀 headless；杀后脱离 hard 即停（未越界杀 editor）。

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run test/core/mem-watchdog.test.ts -t "env 豁免"`
Expected: FAIL

- [ ] **Step 7: 实现 mem-watchdog.ts**

- `evictForHardThreshold`：`getEvictionCandidates().candidates.find(...)`；耗尽分支报文在既有句后追加豁免信息——`envExempted` 任一非零时附 `（另有 N 笔租约被 GODOT_MCP_WATCHDOG_EXEMPT 豁免: preview X, editor Y——需人工处理或调 env）`，全零保持原句。
- pollOnce 单进程杀循环（123-130 行）**零改动**（硬帽独立性靠不动实现+测试钉住）。

- [ ] **Step 8: 跑全量两文件测试确认通过**

Run: `npx vitest run test/core/memory-guard.test.ts test/core/mem-watchdog.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/memory-guard.ts src/core/mem-watchdog.ts test/core/memory-guard.test.ts test/core/mem-watchdog.test.ts
git commit -m "feat(core): WATCHDOG_EXEMPT 驱逐豁免 env——候选单点过滤+耗尽报文附豁免计数,单进程硬帽恒独立(Docker 禁令)"
```

### Task 2: L3 可见性与文档（panel/doctor/README/规则双副本）

**Files:**
- Modify: `src/core/memory-guard.ts`（MemoryPanelData 加字段 + buildMemoryPanel 落值）
- Modify: `src/cli/doctor.ts:366`（Memory guard 第一行附 exempt）
- Modify: `README.md:734` 后（env 表新行）
- Modify: `src/tools/rule-templates.ts:147` 附近（「内存治理」段补一句）
- Modify: `.claude/rules/godot-mcp-core.md`（「内存治理」段同步——双副本）
- Modify: `CHANGELOG.md`（[Unreleased] WATCHDOG_EXEMPT deferred 备案行回标 + 新条目挂 [0.40.0]）
- Test: `test/core/memory-guard.test.ts`（⑬ buildMemoryPanel describe 内加断言）

**Interfaces:**
- Consumes: Task 1 的 `watchdogExemptGroups()`。
- Produces: `MemoryPanelData.watchdogExempt: Array<'preview' | 'editor'>`（固定序 preview→editor，doctor 与 godot_get_context 的 memory 对象经既有单源自动透出）。

- [ ] **Step 1: 写失败测试**——buildMemoryPanel 断言：env 未设 → `watchdogExempt: []`；env=`editor` → `['editor']`；env=`preview,editor` → `['preview','editor']`（固定序）。
- [ ] **Step 2: 跑测试确认失败**（`npx vitest run test/core/memory-guard.test.ts -t "buildMemoryPanel"`，Expected: FAIL）
- [ ] **Step 3: 实现**——buildMemoryPanel 里 `[...watchdogExemptGroups()]` 按 `['preview','editor']` 固定序排列；doctor 第一行 `enabled` 时非空附 ` — exempt preview,editor`（disabled 不附，避免暗示豁免生效）。guard=0 面板照常显示（既有口径，exempt 字段照出）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 文档四面**——README env 表加行（说明列写清：驱逐候选豁免+殿后不变+单进程硬帽不受影响+未知 token warn，默认「未设」）；rule-templates.ts 内存治理段「机器实例 ≤ 8 / 二期软阈值」句群后补一句 env 豁免语义；`npm run build && STRICT=1 npm run check:rules-sync` 过；CHANGELOG [Unreleased] 的 WATCHDOG_EXEMPT deferred 备案短语回标「三期已实现」，[0.40.0] 段落骨架本 Task 先立（条目后续任务补）。
- [ ] **Step 6: 验证**——`npm run build && npx vitest run test/core/memory-guard.test.ts && STRICT=1 npm run check:rules-sync && npm run check:changelog-sync` 全绿。
- [ ] **Step 7: Commit**

```bash
git add src/core/memory-guard.ts src/cli/doctor.ts README.md src/tools/rule-templates.ts .claude/rules/godot-mcp-core.md CHANGELOG.md test/core/memory-guard.test.ts
git commit -m "docs(core): WATCHDOG_EXEMPT 可见性四件——panel exempt 字段+doctor 行+README env 表+规则双副本"
```

### Task 3: 正交性/幂等性集成测试两条（终审 Minor-5）

**Files:**
- Test: `test/core/exit-watchdog.test.ts`（pressure×exit-watchdog 正交 describe）
- Test: `test/core/session-idle-timer.test.ts`（IdleTimer×驱逐循环双路回收幂等 describe；跨模块组合,落点选消费双方的 idle-timer 侧）

**Interfaces:**
- Consumes: Task 1 后的 `getEvictionCandidates`（新签名）；既有 `updatePressureState`/`_resetForTest`、`scanIdleSessions`、`pollOnce`、`_resetWatchdogForTest`、process-state 会话桶基建。
- Produces: 无（纯测试，钉住架构注释论证的行为契约）。

- [ ] **Step 1: 写正交性测试一（pressure 态不改变 exit-watchdog 行为）**——同组会话桶（非 preview + preview 各一）：normal 态与 hard 态（喂低压快照 `updatePressureState` 推进）分别触发 `handleExitTrigger('SIGINT')`（`_resetExitWatchdogForTest` mock exit fn），断言两态下回收目标集合、跳过 preview 的口径、优雅→强杀链路调用序**完全一致**——钉住「exit 链永不读 pressure」（防未来往 exit-watchdog 加 pressure 分支）。
- [ ] **Step 2: 写幂等性测试二（IdleTimer×驱逐对同一会话双路回收）**——建会话桶+绑定 pid 租约（mock 采样与 killPidTree spy）：先走驱逐路径（pollOnce 进 evictForHardThreshold 杀掉：releaseLease+树杀记一次）→ 再跑 `scanIdleSessions`：断言无二次树杀（杀前探活 dead → 仅清不杀）、会话桶与租约账本终态一致、无异常抛出；反向序（先 idle 回收再驱逐循环 → 候选空/无该租约，同样 no-op 不炸）各一条。
- [ ] **Step 3: 跑两个文件确认通过**——`npx vitest run test/core/exit-watchdog.test.ts test/core/session-idle-timer.test.ts`（若断言与实现冲突即实现 bug：按 systematic-debugging 处理，测试是契约）。
- [ ] **Step 4: Commit**

```bash
git add test/core/exit-watchdog.test.ts test/core/session-idle-timer.test.ts
git commit -m "test(core): 钉住两处注释论证的契约——pressure×exit-watchdog 正交+IdleTimer×驱逐双路回收幂等"
```

### Task 4: bridge-client 订阅重发勿续命 TODO 注释（终审 Minor triage）

**Files:**
- Modify: `src/core/bridge-client.ts:446-447`（_resendSubscriptions doc 注释）

**Interfaces:** 无（纯注释；现状 `sendToBridge(sub.method, sub.params, DEFAULT_TIMEOUT)` 未传 `poke:false` → 一次性续命，终审判例可容忍）。

- [ ] **Step 1: 注释补段**——警示：重发流量会刷新会话空闲钟（SendOptions.poke 缺省 true）；当前「断线重连一次性触发」可容忍（终审 2026-11-22 triage）；**未来若改为周期重试/定时重发，必须传 `{ poke: false }`**——否则 IdleTimer 对已连接 bridge 的会话永久失效（二期 Task 1 审查 Critical-1 同款根因，keepalive 已排,此处勿再踩）。
- [ ] **Step 2: 验证**——`npm run build` 过（注释无行为影响，防笔误）。
- [ ] **Step 3: Commit**

```bash
git add src/core/bridge-client.ts
git commit -m "docs(bridge): 订阅重发勿续命 TODO——周期重试改造时必须 poke:false(IdleTimer 防线)"
```

### Task 5: static_mem 真机实测（二期 Task 5 Step 2 遗留 skip 清账）

**Files:**
- 无源码改动（GD 行二期已写好：`src/scripts/mcp_bridge.gd` `_cmd_get_performance` 的 `static_mem`）；产物为验证记录（CHANGELOG 条目 + Obsidian 日志留证）。

**Interfaces:** Consumes: MCP 工具 `game_bridge_install` / `run_project(wait_for_bridge=true)` / `game_query(get_performance)` / `stop_project`；GODOT_PATH 已确认可用（`D:\godot\Godot_v4.7.2-stable_win64.exe`）。

- [ ] **Step 1: 选 fixture**——`ls test/fixtures/` 选一个小型带主场景的项目（无则建最小 main.tscn fixture）。
- [ ] **Step 2: 真机窗口跑 bridge**——`game_bridge_install(project_path)` → `run_project(project_path, wait_for_bridge=true)`（**非 headless**，窗口模式）→ `game_query(method="get_performance")`。
- [ ] **Step 3: 断言并留证**——响应含 `static_mem` 键且为有限数字（非 null）；响应 JSON 原文贴 Obsidian 日志。失败（null/缺键）→ 按 systematic-debugging 查 GD 行（`Performance.get_monitor(Performance.MEMORY_STATIC)`）与版本同步（BRIDGE_SCRIPT_VERSION），修复走新 TDD 小步。
- [ ] **Step 4: 收尾**——`stop_project`；CHANGELOG [0.40.0] 条目记「static_mem 真机实测非 null（二期 skip 清账,Godot 4.7.2 窗口模式）」。
- [ ] **Step 5: Commit**（CHANGELOG）

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): static_mem 真机实测非 null——二期 skip 清账(4.7.2 窗口模式)"
```

### Task 6: 查⓪ pressure 报文附持续时长 + 版本收口

**Files:**
- Modify: `src/core/memory-guard.ts:621-629`（查⓪ 拒绝报文）
- Test: `test/core/memory-guard.test.ts`（⑫ pressure describe 内加断言）
- Modify: `package.json:3`（0.40.0）+ `CHANGELOG.md`（[0.40.0] 收口段）+ `README.md`（版本相关行若 version-sync 覆盖则免）
- Obsidian：`D:\workspace\Obsidian\GodotMCP\开发日志\2026-11-22 memory-guard三期.md`（或当天已有文件追段）

**Interfaces:**
- Consumes: 既有 `getPressureEnteredAt()`（已导出未消费于报文——本期接上）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**——pressure 态（状态机推进后）`acquireLease` 拒绝报文 message 含 `已持续 Ns`（N 与 mock 时钟/enteredAt 差一致）；enteredAt 为 null 的防御分支不拼时长后缀（直调内部分支或构造态，Review Focus 5——若不可构造则断言现有分支恒有 enteredAt,注释注明防御不可达）。
- [ ] **Step 2: 跑测试确认失败**（`npx vitest run test/core/memory-guard.test.ts -t "持续"`，Expected: FAIL）
- [ ] **Step 3: 实现**——查⓪ 分支报文 message 拼 `——已持续 ${Math.round((Date.now() - enteredAt) / 1000)}s`（enteredAt null 跳过后缀）；主旨句「持续 30s」保持（进入条件语义），后缀是**当前已持续时长**（状态可含 hard 态,由 enteredAt 覆盖）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 版本四件套**——`package.json` → 0.40.0；`npm run version-sync`（BRIDGE_SCRIPT_VERSION 等自动同步）；CHANGELOG [0.40.0] 段收口（>50 字符满足 changelog-sync）；README 版本行随脚本。
- [ ] **Step 6: 全量门禁**——`npm run build && npm run lint && npx vitest run --coverage`（覆盖率不低于二期口径）+ `npm run check:changelog-sync && STRICT=1 npm run check:rules-sync`。
- [ ] **Step 7: 独立审查**——docs/reviews/ 落 `2026-11-22-memory-guard-phase3-review.md`（fresh reviewer，聚焦 Review Focus 五条 + 豁免语义与 spec §L2 逐句对照）。
- [ ] **Step 8: memory + Obsidian 登记**——memory 更新 `memory-guard-p3-pending.md` → 三期完成态（或并入 p2-facts 改名）；挂账「档位回看推迟」保留；Obsidian 开发日志（frontmatter + callouts 按全局规范）。
- [ ] **Step 9: Commit**

```bash
git add src/core/memory-guard.ts test/core/memory-guard.test.ts package.json CHANGELOG.md README.md
git commit -m "feat(core): 查⓪ pressure 报文附持续时长+版本收口 0.40.0(getPressureEnteredAt 接入拒绝报文)"
```

---

## 执行顺序与依赖

Task 1 → Task 2（消费 watchdogExemptGroups）→ Task 3（消费新签名，可与 Task 4/5 并行）→ Task 4/5（独立）→ Task 6（收口，最后）。
