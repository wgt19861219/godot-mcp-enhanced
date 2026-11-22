# Memory Guard 二期实施计划（L0 生命周期 + L2 整机软/硬阈值 + L3 面板）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐治理面：非 preview 会话 15min 空闲回收（治「用完忘 stop」常驻泄漏）+ server 退出时回收全部会话（治孤儿积累）+ 整机内存压力软/硬阈值状态机（软=拒新保旧上报，硬=按「实测÷声明」驱逐排序）+ doctor/get_context 内存面板与 registry 心跳 RSS 字段（跨会话可见）。

**Architecture:** IdleTimer 与退出 watchdog 挂在既有 process-state 会话桶上（poke 由 bridge-client 查询路径驱动）；软/硬阈值是 mem-watchdog 内新增的状态机（复用一期快照与租约）；面板聚合快照+租约+采样读数。**前置依赖：一期已落地**（`2026-11-22-memory-guard-phase1.md` 全部合入）。

**Tech Stack:** TypeScript（vitest）+ GDScript（registry 心跳加字段，一处）。

**Spec:** `docs\superpowers\specs\2026-11-22-memory-guard-design.md`（拍板：15min 默认；软阈值 <3GB 持续 30s、硬阈值 <1.5GB、去抖 5min、minimum-reclaim 2GB）

## Global Constraints

- 同一期（版本四件套 Task 5 一笔、lint 533 零新增、中文注释、分支 `feat/memory-guard-p2`、不引新依赖；**覆盖率门禁 `npx vitest run --coverage`（76/67/80/77）+ CHANGELOG [Unreleased] >50 字符 `check:changelog-sync` + docs/reviews/ 独立审查 + memory 登记**——同一期 Task 6 口径）。
- **外部进程永不杀**（硬阈值驱逐只在一期租约集合＝本 server spawn 的进程内选；用户手开编辑器/游戏不碰）。
- **preview 豁免 IdleTimer**（用户在看的窗口）；preview/editor 在驱逐排序中**最后**（`GODOT_MCP_WATCHDOG_EXEMPT=preview,editor` 全豁免时，二者单进程硬帽（声明×3，一期已有）仍生效——Docker 反模式禁令）。
- **模块归属防循环依赖（审查二期）**：pressure 状态机（含软/硬阈值判定与去抖）落 `memory-guard.ts`（唯一写者），watchdog 轮询只消费 `getPressureState()`——一期已存在 watchdog→memory-guard 依赖，反向引用会成环。
- **GD 侧改动最小化（审查降本裁定）**：registry RSS 由 TS 按 registry 已有 pid 做 WMI 采样，**不动 GD 心跳结构**；GD 仅补 `_cmd_get_performance` 的 `static_mem` 一行（修既有 performance 恒 null 缺陷）——`BRIDGE_SCRIPT_VERSION` 由 `npm run version-sync` 自动同步，无手动 bump。

## Review Focus

1. **preview 数据源前置**——`RunSession`（process-state.ts:143-153）现无 preview 字段（preview 只是 run_project 参数 :176）：Task 1 显式补字段+建桶处落值，否则 Task 1/3 的 preview 豁免无数据源（审查二期前置）→ Task 1 测试。
2. **软阈值 30s 持续判定**——瞬时跌破不算（防抖），持续 30s 才进 pressure；pressure 期间准入全拒但**在跑任务与既有租约不动** → Task 2 测试。
3. **状态去抖 5min**——pressure→normal 翻转需连续 5min 高于软阈值（kubelet transition-period 同款），防边缘反复 → Task 2 测试。
4. **驱逐循环的采样新鲜度**——10s 快照缓存会让「杀一个重采样」读到旧值反复多杀：驱逐循环内用 `getMachineMemorySnapshot({force:true})` 强制刷新（审查二期）→ Task 3 测试。
5. **驱逐排序键**——`rss÷declaredMB` 降序杀，杀到脱离硬阈值+2GB 余量即停（minimum-reclaim）；不是全杀 → Task 3 测试。
6. **IdleTimer poke 覆盖面**——bridge 查询/输入/截图都算交互；仅 spawn 不算（spawn 后 0 交互 15min 该收）→ Task 1 测试。
7. **退出链二次触发语义**——第一次 SIGINT/stdin-close 优雅回收（有限等待 10s）→ 期间再触发立即强杀全部 → 30s 兜底 process.exit（Playwright 语义）→ Task 4 测试。

---

### Task 1: RunSession preview 字段 + IdleTimer 空闲回收（非 preview 会话 15min）

**Files:**
- Modify: `src/core/process-state.ts`（**前置（审查二期）**：`RunSession`（:143-153）加 `preview: boolean` 与 `lastPokeAt: number` 字段；`newSession` 初始化；`pokeRunSession(projectPath)` 导出）
- Modify: `src/tools/runtime.ts`（run_project 建桶处（`setRunSessionProc` 调用点，preview 参数在 :176 附近）落 `preview` 值进会话桶）
- Create: `src/core/session-idle-timer.ts`（60s 周期扫描：`now - lastPokeAt > idleMinutes×60s` 且 `preview===false` 的会话 → 走既有 kill 链回收 + releaseLease + 日志 `MEMGUARD idle-reap`）
- Modify: `src/core/bridge-client.ts`（查询/输入路径成功后调 `pokeRunSession(projectPath)`——grep 既有 projectPath 可得调用点）
- Modify: `src/GodotServer.ts`（启动挂 idle timer；env `GODOT_MCP_SESSION_IDLE_MINUTES` 默认 15，0=关）
- Test: `test/core/session-idle-timer.test.ts`

**Interfaces:** Produces `pokeRunSession(projectPath: string): void`、`startIdleTimer()/stopIdleTimer()`；回收复用 process-state kill 链与一期 releaseLease。

- [ ] **Step 1: 失败测试**——①超 15min 未 poke 且 `preview:false` → 杀+释放租约；②poke 重置计时；③`preview:true` 会话超时不动（**字段数据源锚**）；④env=0 关；⑤杀日志含 MEMGUARD idle-reap 可 grep。
- [ ] **Step 2-4: 失败→实现→通过**（mock 时钟 `vi.useFakeTimers`）。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): RunSession 补 preview 字段+非 preview 会话 IdleTimer 空闲回收——15min 默认/bridge 交互续命/preview 豁免(Playwright IdleTimer 模式)"`

### Task 2: 整机软阈值——pressure 状态机（拒新保旧+上报）

**Files:**
- Modify: `src/core/memory-guard.ts`（**状态机落本模块（唯一写者，防循环依赖——审查二期）**：快照消费端判定双口径任一 < `GODOT_MCP_MEM_PRESSURE_SOFT_MB`（默认 3072）持续 30s → state='pressure'；恢复需连续 5min 高于阈值 → 'normal'；导出 `getPressureState(): 'normal'|'pressure'|'hard'` 与进入时间戳；acquireLease 三查前加第四查：pressure → 拒，code 复用 `MEMGUARD_LOW_WATER`，message 前缀「整机内存压力(软阈值)持续 30s——拒新保旧」）
- Modify: `src/core/mem-watchdog.ts`（pollOnce 每轮把快照喂给状态机（`updatePressureState(snapshot)`），watchdog 只消费不拥有状态）
- Test: `test/core/memory-guard.test.ts` 追加

- [ ] **Step 1: 失败测试**——①瞬时跌破 10s 回升 → 不进 pressure；②持续 30s → pressure 且 acquireLease 拒（软阈值码）；③在跑租约不被杀；④pressure→normal 需连续 5min（中途再跌破重计）。
- [ ] **Step 2-4: 失败→实现→通过**（fake timers 推进多轮 updatePressureState）。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): 整机内存软阈值状态机(落 memory-guard 防循环依赖)——双口径<3GB 持续 30s 进 pressure 拒新保旧,5min 去抖恢复(kubelet 语义)"`

### Task 3: 整机硬阈值——驱逐排序（实测÷声明 降序，minimum-reclaim 2GB）

**Files:**
- Modify: `src/core/memory-guard.ts`（硬阈值判定入状态机（state='hard'），驱逐候选计算 `getEvictionCandidates(): Array<{lease, ratio}>` 按 `rss÷declaredMB` 降序、preview/editor 排最后）
- Modify: `src/core/mem-watchdog.ts`（pollOnce 消费 hard 状态 → 驱逐循环：逐个树杀直至**强制刷新快照**（`getMachineMemorySnapshot({force:true})`——10s 缓存会让重采样读旧值反复多杀，审查二期）脱离硬阈值+2048MB；全杀光仍低压 → 日志诚实上报「已无本 server 可驱逐进程，外部占用需人工处理」）
- Test: `test/core/mem-watchdog.test.ts` 追加

- [ ] **Step 1: 失败测试**——①硬阈值触发按 ratio 排序杀最大者；②杀一个够（force 快照脱离+2GB）即停不全杀（断言 force 通道被调）；③preview/editor 排最后（构造 ratio 更高的 preview 验证不先杀）；④租约耗尽仍低压 → 诚实日志不抛崩；⑤外部进程（无租约 pid）不在候选集。
- [ ] **Step 2-4: 失败→实现→通过**。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): 整机硬阈值驱逐——实测÷声明降序树杀+force 采样+2GB minimum-reclaim+preview/editor 最后+租约耗尽诚实上报(kubelet 驱逐映射)"`

### Task 4: 退出 watchdog + spawn 点超时/maxBuffer 自查

**Files:**
- Create: `src/core/exit-watchdog.ts`（stdin 'close'/SIGINT/SIGTERM → 优雅回收全部本 server 非 preview 会话（既有 kill 链，10s 有限等待）→ 期间二次触发立即全强杀 → 30s 兜底 `process.exit(0)`；一次性注册）
- Modify: `src/GodotServer.ts`（启动注册；exit-watchdog 与 daemon 模式共存性现场确认——daemon 有自身重启链，勿双杀）
- Modify: 全部 `execFile/spawn` 点位自查（grep 清单：`src/core/godot-finder.ts:4`、`editor-auth.ts:5`、`instance-manager.ts:18`、`bridge-client.ts:20`、`gdscript-executor.ts`、`screenshot.ts:21`、`headless-process.ts:18` 等）——无 timeout/maxBuffer 的补显式值（timeout 参照同类：短命令 15s；maxBuffer 16MB）
- Test: `test/core/exit-watchdog.test.ts`

- [ ] **Step 1: 失败测试**——①stdin close → 逐会话回收+释放租约；②10s 内二次触发 → 立即强杀；③30s 兜底 exit；④preview 会话不回收（用户窗口）。
- [ ] **Step 2-4: 失败→实现→通过 + 自查清单逐点核对（表格落开发日志）**。
- [ ] **Step 5: Commit**——`git commit -m "feat(core): 退出 watchdog(优雅10s→二次强杀→30s兜底)+全 spawn 点 timeout/maxBuffer 自查(Playwright setupExitWatchdog 模式)"`

### Task 5: L3 面板（TS 侧 WMI 采样）+ static_mem 既有缺陷修复 + 版本收口

**Files:**
- Modify: doctor / `godot_get_context`（内存面板：双口径水位/预算与已占用/pressure 状态/活跃实例表 pid·项目·kind·声明·实测 RSS·最后交互——**实例 RSS 由 TS 按 registry 已有 pid（`InstanceInfo.pid`）走一期 `sampleRssBytes` 采样，不动 GD 心跳结构（审查降本裁定）**；get_context 走既有 `server` 字段族旁挂 `memory` 对象）
- Modify: `src/scripts/mcp_bridge.gd:2983-2990`（**顺手修既有缺陷**：`_cmd_get_performance` 返回值补 1 行 `"static_mem": Performance.get_monitor(Performance.MEMORY_STATIC)`——`get-context.ts:301-305` 一直在读 `static_mem` 但 GD 不返回 → performance 恒 null；`BRIDGE_SCRIPT_VERSION` 由 version-sync 自动同步，无手动 bump）
- Modify: README env 表（二期 env：SESSION_IDLE_MINUTES/PRESSURE_SOFT_MB/PRESSURE_HARD_MB/WATCHDOG_EXEMPT）+ 规则文档 core.md 双副本补「内存治理」段 + CHANGELOG + 版本四件套
- Obsidian：开发日志二期 + 反馈库回标

- [ ] **Step 1: 面板失败测试**（get_context 含 memory 对象与字段断言；doctor 两行升级为面板行；RSS 采样走 mock pid 集合）。
- [ ] **Step 2: GD static_mem 补行 + `npm run check:gdscript`**（有真机窗口环境时 `get_performance` 实测 static_mem 非 null，无则记 skip）。
- [ ] **Step 3: 规则文档双副本 + `npm run build && STRICT=1 npm run check:rules-sync`**。
- [ ] **Step 4: 版本四件套 + 全量门禁（CI 口径：coverage+changelog-sync）+ AGENTS.md 流程（docs/reviews/ 独立审查 + memory 登记）**。
- [ ] **Step 5: Commit + Obsidian 收口**——`git commit -m "chore(release): memory-guard 二期收口——IdleTimer+软硬阈值+退出链+面板(TS侧采样)+static_mem 缺陷修复,版本四件套"`。
