# memory-guard 二期全分支终审报告

**日期**：2026-11-22　**审查范围**：31a0683d..56d89019（7 commits，44 文件 +2412/-99）　**审查模型**：opus（分五遍读完 287KB review package）
**上游**：计划 `docs/superpowers/plans/2026-11-22-memory-guard-phase2.md` + spec `docs/superpowers/specs/2026-11-22-memory-guard-design.md`
**流程**：每任务过任务审查（spec+质量双 verdict）+ fix round（Task 1 一轮：keepalive 续命漏洞；Task 4 一轮：二次强杀不可达/兜底被拆/preview 豁免失效），全量门禁绿（8088 测试 0 失败、coverage 82.41/74.88/85.64/84.19 过下限 76/67/80/77、lint 533 持平、tsc 0、check:gdscript errors=0、STRICT rules-sync/build/version-check/changelog-sync 全过）。

## 结论

**Ready to merge: Yes** —— 0 Critical / 0 Important / 5 Minor（三处一行修作为随手建议已执行，见文末）。

## 交付面核对（五任务逐项）

| 任务 | commit | 核对结果 |
|---|---|---|
| T1 IdleTimer+preview 字段 | ceb82341 + be42c0cd（fix） | ✅ keepalive 自动 ping 不续命（行为级三段对照测试）；回收链幂等；preview 数据源前置（Review Focus 1 锚定） |
| T2 软阈值 pressure 状态机 | 95506066 | ✅ 30s 持续判定/5min 去抖（恰边界用例闭环）；唯一写者 memory-guard；拒新保旧 |
| T3 硬阈值驱逐 | 92d54e7a | ✅ ratio 降序+force 采样+2GB minimum-reclaim+preview/editor 殿后+租约耗尽诚实上报；外部进程永不杀 |
| T4 退出 watchdog+spawn 自查 | 721d86c6 + 7f9f1be7（fix） | ✅ 注册序=执行序（源码锚）；close 链不拆兜底（反向断言）；killAllRunSessions preview 跳过（spec §L0 口径）；32 点 spawn 自查属实 |
| T5 面板+static_mem+版本收口 | 56d89019 | ✅ buildMemoryPanel 单源（doctor/get_context 共享）；GD 心跳零改动；版本四件套 10 处一致 0.39.0 |

## 跨任务咬合面（源码级交叉验证，任务审查各自为战最易漏处）

- **poke/preview**：getSession 归一键与 run_project 建桶链同键；preview 桥接 memory-guard→process-state 方向安全无环
- **退出链时序**：index.ts `setupExitWatchdog()` 先于 `process.on('SIGINT')`（文本序=执行序，锚测试锁定）；stdin 'end'（gracefulShutdown）与 'close'（watchdog）双事件双链幂等（先到清桶后到跳过）
- **三路回收竞争**（IdleTimer/驱逐循环/close 回调对同一会话）：三方全幂等（clearRunSession/releaseLease 幂等、close 回调桶内 proc 比对守卫、killPidTree 对死进程 no-op）
- **面板聚合**：registry 条目形态对 GD 写侧（mcp_bridge.gd:960-971）逐字对齐；guard=0 时 lightSnapshotWithoutWmi 零 PowerShell（保住全局测试约定）
- **向后兼容**：SendOptions.poke 可选、getMachineMemorySnapshot(opts?) 可选、GD 新增 static_mem 键旧 TS 忽略无害——既有调用方零改动

## Spec 偏离（1 项，处置可接受）

`GODOT_MCP_WATCHDOG_EXEMPT`：spec L2 提及但二期计划未分配实现任务、代码零消费者、README 未载。实现语义（固定 preview/editor 殿后）是 spec 豁免语义的**保守子集**——无 env 即无「全豁免」路径，Docker 反模式禁令实质（无上限豁免）不可触达（单进程硬帽 ×3 常开）。CHANGELOG [Unreleased] 显式登记差分、不写假文档（v0.36.8 B4 前科）。**三期跟进要求**：要么补 env 实现（含硬帽联动），要么修订 spec 删该提法。

## Minor（5 项）与处置

1. doctor pressure 行 `✗` 与同文件 warn 判例矛盾 → **已修**（warn 对齐）
2. 驱逐竞态注释「最坏多杀一笔」偏乐观（真实最坏杀光全部候选，attempted 保证有界非最小）→ **已修**（注释如实）
3. hard enter 日志「驱逐超声明租约」不精确（ratio 可<1）→ **已修**（「驱逐 ratio 最高租约」）
4. 查⓪ 拒绝报文 pressure 历史态下即时读数可能显示健康值 → 可留（UX 微瑕，主旨句正确；建议 pressure 分支附持续时长）
5. 两处集成正交性无测试钉住（pressure×exit-watchdog 正交、IdleTimer×驱逐循环幂等）→ 三期补测试

## Deferred minors triage（任务审查登记 13 条）

- **可留**（10 条）：_resendSubscriptions 一次性续命（建议 game-bridge.ts 重发处加勿续命 TODO）、退避盲区计时（fail-safe 方向）、诚实上报 10s/条（kubelet 同款）、报告数字标签、forced 不清 timer、preview 判据口径、indexOf 锚脆性、lastPokeAt 项目键控、guard=0 计数标注、（归并入 Minor-2 的注释项）
- **升级为终审 Minor**（3 条）：即上节 1/2/3，已随手修

## Declined to judge（10 项，均为边界外或既有口径）

一期遗留（租约互斥/JSONL 审计/killPidTree promise 化/blender 档位，CHANGELOG 已登记）、非 Windows 驱逐不工作（一期已知边界+skipIf 诚实锚定）、registry 心跳不滤 lastSeen（面板语义正确）、gracefulShutdown exit(0) 可能中断 watchdog 收尾（90s 陈旧清理自愈+文件头注释声明）、forceReapSessions 后不等 taskkill（独立进程不受父进程退出影响）、coverage CI 口径全量（已用定向 317 绿提供行为证据）、killAllRunSessions 自然退出桶口径（一期行为非本次引入）。

## 后续建议（三期候选）

1. `GODOT_MCP_WATCHDOG_EXEMPT` spec↔实现收敛（补实现或修订 spec）
2. 集成正交性/幂等性测试两条（Minor-5）
3. game-bridge.ts 订阅重发处加勿续命 TODO 注释
4. 查⓪ 拒绝报文 pressure 分支附持续时长（Minor-4）

---

*本报告由 SDD 最终全分支审查生成（opus），审查包 `.superpowers/sdd/2026-11-22-memory-guard-phase2/review-31a0683d..56d89019.diff`（287KB/4396 行）。*
