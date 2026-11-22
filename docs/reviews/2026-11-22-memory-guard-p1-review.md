# Memory Guard 一期全分支终审（feat/memory-guard-p1，88148e1d..83be1f22）

**日期**：2026-11-22　**审查员**：全分支终审（合并前最后一道闸）　**输入**：终审包 diff（`.superpowers/sdd/2026-11-22-memory-guard-phase1/review-88148e1d..83be1f22.diff`）+ 执行台账（同目录 `progress.md`）+ 设计 v1.1（`docs/superpowers/specs/2026-11-22-memory-guard-design.md`）

---

## ① 总体判定

**SHIPPED WITH NITS** —— 核心机制（快照/租约/三查/看门狗/七漏斗/归因）设计忠实、实现干净、测试与版本收口完整，无 Critical；但两处跨任务组合效应的小缺口（pid=null 租约泄漏被心跳无限续命、doctor flaky 用例超时配置矛盾）建议合并前顺手修掉，均为 ≤ 半小时改动。

**实跑验证**（终审本机）：memory-guard 四核心测试文件 105 绿（1 skip 为平台预期）；runtime/executor/gut 五文件 93 绿；回归基线+shared 26 绿；`tsc --noEmit` 干净；版本四件套（package.json / plugin.cfg / manifest.json / server.json / capability-matrix.json / mcp_bridge.gd BRIDGE_SCRIPT_VERSION）全 0.38.2 一致，Dockerfile 随动，CHANGELOG [Unreleased] 已预登二期项。

---

## ② 阶段 A 发现（跨任务整体视角）

**C（Critical）：0　I（Important）：2　M（Minor）：3**

### I-1　pid=null 租约泄漏 × 60s 心跳无限续命 = 非自愈的账本污染（T4-M-1 升级，跨任务组合效应）

三个任务各自正确的接线，组合出逐任务审查不可见的漏洞链：

1. **泄漏窗口**：四处 spawn 在 `acquireLease` 之后、`bindLeasePid` 之前无 try-catch——`src/core/headless-process.ts:28`、`src/screenshot.ts:94`、`src/tools/runtime.ts:691`（launch_editor）、`src/GodotServer.ts:703`（Web GUI editProject）。spawn 同步抛 → 租约建了、pid 未绑、无人归还。
2. **触发面比台账记录的「编程错误级」宽**：launch_editor 双入口在 acquire 与 spawn 之间夹着 `await findGodot()`（`src/tools/runtime.ts:690`、`src/GodotServer.ts:702`）——findGodot 失败（GODOT_PATH 配错 / PATH 无 godot）是**环境级常态错误**，非编程错误。用户在坏环境下每点一次 launch_editor 泄漏一笔 4GB editor 声明租约。其余 headless 链（executor/spawn-helper/screenshot/gut）的 findGodot 均在 acquire 之前由调用方解析，无此窗口。
3. **非自愈**：`LEASE_HEARTBEAT_STALE_MS=90s` 的设计意图是让无 pid 租约自清，但 `heartbeatLeases()`（`src/core/memory-guard.ts:510`）刷新**本 serverPid 全部租约**的心跳，而 `src/GodotServer.ts:803` 的 60s 心跳定时器使泄漏租约的 lastHeartbeat 永不陈旧——90s 清理线永不到期，租约直到 server 重启才消失。32GB 机预算 21.4GB，泄漏 5-6 笔即把后续 headless/gut spawn 全部推入 `MEMGUARD_BUDGET` 误拒。
4. **同根放大器**：`bindLeasePid` 与并发 `writeLeases` 的 last-writer-wins 竞态（双 server 同瞬间 spawn）也会把已绑 pid 的租约覆盖回 pid=null——同样落入无限续命。修「续命规则」一处即同时治这两个入口。

**影响定级理由**：不构成 Critical（不回归死机形态、不丢数据；触发前提仍是窄窗口 + 重复调用），但预算账本是本机制的核心资产，「无进程却占预算」会直接侵蚀用户对 guard 的信任（观察：用户看到此类误拒的第一反应是 `GODOT_MCP_MEMORY_GUARD=0` 全关，机制归零）。

### I-2　main-entry-symlink doctor 用例超时配置矛盾（T6-⚠️ 坐实）

`test/cli/main-entry-symlink.test.ts:78` 的 spawnSync 内层 `timeout: 60_000`，但 `vitest.config.ts:15` 全局 `testTimeout: 10_000` 先掐——内层 60s 永不可达，全量并发下 doctor 子进程冷启动（node 起 build/index.js + doctor 全扫描）超 10s 即 flaky。Task 6 记录的「全量首跑 flaky、单跑绿」与此完全吻合。CI Linux 必跑 symlink describe（Windows 本机无权限跳过），稳定性缺口持续存在。修法一行：该用例显式 `{ timeout: 30_000 }`（与直跑 describe 的 30s 先例对齐）。

### M-1　test/setup.js 全局 `GODOT_MCP_MEMORY_GUARD='0'` 的长期测试面影响

`test/setup.js:38` 使**全部**非 guard 专属测试跑在守卫关闭态——guard 开启态的漏斗真实链路（denial 透传分类、lease 与真实进程事件时序）只有 mock 层（`memory-guard-funnels.test.ts`）+ Task 6 一次性真机四场景覆盖，无自动化回归网。评估：**可接受的权衡**（否则每测试文件真起 PowerShell + 写真实 `~/.godot-mcp/`，代价远超收益；CI 无 Windows runner 使「开 guard 的 CI 回归」在 Linux 上也只能测降级路径），但应作为已知限制留档，二期可选补一项 `guard=1 + mock 采样层` 的漏斗端到端断言（本机 GODOT_PATH 门控）。

### M-2　看门狗判杀读数的陈旧方向未声明

watchdog 与准入共享 10s RSS 缓存（`memory-guard.ts:49`）——判杀用到的读数最多陈旧 10s：进程在读数采集后、判杀前降回线下仍会被杀（反向：暴涨 10s 内来不及杀是设计 §4 已声明方向）。`mem-watchdog.ts` 头注只提「来不及」单向。建议补一行注释声明双向 10s 粒度误差（kubelet 同款语义），防后续维护者误以为只有漏杀无误杀。纯文档项。

### M-3　T3-M-2 未登记 CHANGELOG [Unreleased]

CHANGELOG [Unreleased] 已登记 T1-M-3/T4-M-1/T3-M-3/blender 档位四项二期项，唯独 T3-M-2（树杀异步吞错 → 归因虚报 + 失管）漏登。本报告 triage 裁定其留二期（见下表 #9），需补一行登记。

### 阶段 A 复核通过项（无发现）

- **七处漏斗全局一致性 ✓**：全仓 grep 复核，所有 Godot 执行汇聚 7 个已接入漏斗（runGutProcess/executor/spawn-helper/screenshot/run_project·双 spawn 语句同漏斗/launch_editor×2/headless-process）；blender（`blender-spawn.ts`）与 runImport/check:gdscript（`godot-spawn.ts`）经 `runHeadlessCollector` 共用 headless 档（Task 4 裁定①留档在案）；ui capture 特殊链经 `runScreenshot`；dashboard/daemon/web-gui spawn 均非 Godot 进程。**无遗漏的第 8 处**。kind 分配与设计表逐一吻合（gut_shard 主炸弹链/game_window/editor 双入口 exemptChecks 必记账均核实）。
- **看门狗 vs 准入缓存相位 ✓**：watchdog（本 server 租约 pid 集）与准入（全部租约 pid 集）键不同各采各的，单 server 重合时 10s TTL 兜住互击，最坏每 10s 两次 PowerShell 有界；杀前 `killPidProbe` 探活防杀死进程；releaseLease/acquireLease 并发 last-writer-wins 的最坏后果是已杀租约短暂复活（pid 死 → 下次读时清理自愈），在设计的竞态容忍声明内。
- **归因链闭环 ✓**：executor（close→`mem_budget_exceeded`→`parseGdscriptResult` 改码 MEM_BUDGET_EXCEEDED）、run_project close→recentMemKills、stop_project 无进程分支（runtime.ts:732）、get_debug_output（runtime.ts:857）、分片片级标注（runtime.ts:559/640）五路齐全；`formatMemKillMessage` 单一来源防漂移；错误码注册（3×retryable:true + MEM_BUDGET_EXCEEDED false，resource category）与 docs/error-codes.md 语义表双向锚定。
- **版本/文档/CHANGELOG 收口 ✓**：六处版本号 + Dockerfile + README 双语版本行/env 表（7 项含「0 不代表禁用」注记闭环 T2-M-2）+ doctor 两行（与判定同源导出 minFreeMB/budgetPct 防漂移）全部到位。
- **server 崩溃残留（一期边界备注，非发现）**：server 死后其租约 pid 活则账本保留（预算查安全侧拒新 spawn）、孤儿进程无人杀——二期 L0 退出链的治理面，一期边界已声明。

---

## ③ Deferred minors triage（13 项）

| # | 项 | 裁定 | 理由 |
|---|---|---|---|
| 1 | T1-M-1 `parseInt` 非整数宽松（'12.5'→12 接受） | **接受不改** | 与全仓 env 解析惯例一致（`readPositiveIntEnv` 同款）；触发需用户故意写非整数 env；影响方向可控（截小=杀线更紧，非放宽） |
| 2 | T1-M-2 快照缓存过期重采路径无测试 | **接受不改** | 8 行纯缓存逻辑风险薄；二期若动 snapshot 实现时顺手补，单独补测的扰动大于收益 |
| 3 | T1-M-3 租约读-改-写无互斥（last-writer-wins） | **留二期**（已登记 Unreleased） | 设计 §3 已裁定窗口容忍；终审复核：丢租约有计数查独立口径兜底、重复租约属 fail-closed 安全侧。其衍生（bindLeasePid 竞态产 pid=null 租约）并入本批 I-1 修复面——续命规则修掉后此竞态的最坏后果降级为「短暂多记一笔」 |
| 4 | T1-M-4 PS 成功但字段畸形 → commit null 无 degraded 标记 | **接受不改** | null=未知=不查该口径，行为语义正确（水位查降级走物理口径是设计路径）；缺的仅是「为什么 null」诊断标签，窄场景 |
| 5 | T2-M-1 通过路径每笔 spawn 一次同步 RSS 采样（~3 PS 进程） | **接受不改** | 10s 缓存在，连续 spawn 不重复采样；单次 50-200ms 对 MCP 30s 超时无碍；二期做租约互斥/性能优化时统一 |
| 6 | T2-M-2 `MAX_MACHINE_INSTANCES=0` 拒析回默认 | **接受不改** | Task 6 已兑现文档点名——README env 表注记「**0 不代表禁用**——非正整数拒析回默认」闭环 |
| 7 | T2-M-3 拒绝模板空格微差 | **接受不改** | 任务审查自判不改，终审无新证据推翻 |
| 8 | T3-M-1 fmtGB 双份实现 | **接受不改** | 4 行纯函数双份各有测试锚定；合并成导出反而加跨模块耦合，「不为单次使用建抽象层」 |
| 9 | T3-M-2 树杀异步吞错 → 失败路径归因虚报 + 进程失管 | **留二期**（**本批补登记 Unreleased**，当前漏登） | taskkill 同用户态失败率极低；杀前探活收窗 + 60s orphan 扫描（`killOrphanGodotProcesses` 清本会话注册 pid）双兜底在位；二期 killPidTree promise 化 + 杀后验证收口 |
| 10 | T3-M-3 杀事件 console.error 不入 JSONL 审计、与降级日志双通道不一致 | **留二期**（已登记 Unreleased） | 跨 server 杀可见性（他 server 的杀本 server 的 doctor 看不到）需随审计通道统一设计，单独改通道反而制造第三种形态 |
| 11 | T4-M-1 spawn 同步抛四处未归还租约 + 无 pid 租约心跳无限续命 | **本批必须修** | 终审升级（详见阶段 A I-1）：触发面含环境级 findGodot 失败非纯编程错误；心跳无限续命使泄漏非自愈，违背 90s 陈旧线设计意图；账本污染直接削弱机制可信度 |
| 12 | T6-M1 task-6-report commit 清单陈述失实 | **接受不改** | 工作区文档（.superpowers 在 gitignore 不入 commit），零运行时影响 |
| 13 | T6-⚠️ main-entry-symlink doctor 全量并发 10s testTimeout flaky | **本批必须修** | 机制已坐实（I-2）：vitest 全局 10s 与 spawnSync 60s 配置矛盾，内层超时永不可达；CI Linux 持续受害；一行修复 |

**统计：本批必须修 2 / 留二期 3（#3 #9 #10）/ 接受不改 8**

---

## ④ 合并建议清单

无 Critical；两处必须修均为小改动，修完即可合并（不必重回逐任务审查，跑门禁四件套即可）：

1. **【必须】修 I-1（T4-M-1）**，最小集三选二（建议全做，合计 ~30 行 + 测试）：
   - a. `heartbeatLeases()`（`src/core/memory-guard.ts:510`）对「startedAt 超固定窗（建议 5min）仍 pid=null」的租约**停续命**——一处改动覆盖全部四个泄漏源 + bindLeasePid 竞态，治本；
   - b. launch_editor 双入口（`src/tools/runtime.ts:690`、`src/GodotServer.ts:702`）把 `await findGodot()` 挪到 `acquireLease` **之前**——消除唯一的环境级触发窗口；
   - c. 四处 spawn 补 try-catch 归还（headless-process.ts:28 / screenshot.ts:94 / runtime.ts:691 / GodotServer.ts:703，各 ~5 行，spawn-helper.ts:71-81 已有现成模板）——防御纵深。
   - 同步：CHANGELOG [Unreleased] 移除「spawn 同步抛路径四处租约归还」条目，改记入 0.38.2 段（或 0.38.2.1 修复段）。
2. **【必须】修 I-2（T6-⚠️）**：`test/cli/main-entry-symlink.test.ts:77` doctor 用例加显式 `{ timeout: 30_000 }`。
3. **【随修复顺手】**：CHANGELOG [Unreleased] 补登 T3-M-2 一行（triage #9）。
4. **【留二期登记】**：M-1（setup.js 全局关守卫的已知限制 + 二期可选 guard=1 冒烟 e2e）建议在二期计划文档补一句，不阻塞本批。

**结论**：`feat/memory-guard-p1` 完成 ①③ 后可合 master。核心判据——两个实证死机形态（GUT 22.5GB 单进程炸弹 / 多会话叠开）在本批分别获得「spawn 前预算声明闸 + 运行中超线树杀」双层防线，真机四场景验证在案，跨 server 账本/豁免纪律/归因链均忠实于设计 v1.1。
