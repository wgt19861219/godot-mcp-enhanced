# 2026-09-14 per-project 运行会话分桶 — 最终全分支审查报告

- **分支**:`feat/per-project-run-sessions`(17 commits,`d840d1e3..f52dbe0c`,版本 0.33.3)
- **审查者**:最终全分支审查子代理(独立隔离,门禁全量实跑)
- **前置**:设计 v3.1(三轮独立审阅闭环,`docs/superpowers/specs/2026-09-13-per-project-run-sessions-design.md`)+ 实施计划 7 任务(Subagent-Driven 逐任务审查,含 Task 2 一轮 fix)
- **总体判定**:**READY WITH FOLLOW-UPS**(零 Critical/Important;4 项 merge 后跟进)

## 功能摘要

process-state 游戏进程/输出/快照/busy 从全局单例改为 `Map<projectKey, RunSession>` 分桶:单 MCP 会话内多 Godot 项目并行运行(多窗口并存,`GODOT_MCP_MAX_SESSIONS` 默认 4)、输出/快照 per-project 隔离、`stop_project`/`get_debug_output` 支持可选 `project_path`、orphan 链三层协同防误杀、活跃指针单写入方、audit 归属修正、logger `project` 字段(子项目 2 Web GUI 数据基础)。单项目场景与既有消费方零行为变化(78 旧用例零改动通过)。

## 验证证据(最终审查者实跑)

| 门禁 | 结果 |
|------|------|
| `npm run build` | exit 0 |
| `npm run lint` | 零输出 |
| `npm test` | 6427 passed / 1 failed(ui-layout-integration 高负载 flaky,单跑复验 7/7 @9.57s) |
| `STRICT=1 npm run check:rules-sync` | 9 模板双向对账一致 |
| `npm run version-check` | 版本元数据一致 (0.33.3) |
| `npm run diff-matrix` | no drift |
| `node scripts/check-rules-version-bump.mjs` | exit 0 |

**双项目真机验收(Task 7,OVERALL PASS)**:两 fixture 窗口并存 35s(跨 20s TTL 与 30s orphan 周期扫描)→ 输出隔离(特征行只在 B 桶)→ 关 A 后 `get_debug_output(project_path=A)` 返回 `source:"last_finished_run"` 且 B 仍 running → 全关后 B 快照 26 行可读。判据③人肉关窗由 WM_CLOSE 程序化替代(等效 exit 链路,可复核:`node .superpowers/sdd/multi-project-acceptance.mjs`)。

## 跨任务一致性(5/5 实测通过)

1. **守卫总纲贯穿**:sessionKey 19 个消费点(同步 13+异步 6)逐一核对;`setRunningProcess` 在 runtime.ts 运行路径零出现。
2. **兼容层**:ToolDispatcher ctx 直通零改动;qa/gif/bridge-session 消费链等价。
3. **orphan 三层协同**:getActiveRunPids 排除 + pid Map 归属 + 节流 per-project;周期扫描/killAllRunSessions/B-T4 短进程兜底三层并集无漏杀。
4. **活跃指针单写入方**:全仓 grep 仅 run_project 一处;audit fallback 链与工具实际目标一致;logger project 三写点齐全。
5. **版本链/产物**:7 版本文件 0.33.3;matrix/tool-docs 与源码一致。

## 设计审阅链(三轮独立闭环)

v1 BLOCKING(4B+2I+9N:输出串桶/orphan 周期杀窗/活跃指针第二写入方/守卫清错桶)→ v2.1 APPROVE → 第三轮全新视角 BLOCKING(1C+5I+7M:**主流程同步写入点 C-1**——setRunningProcess 内嵌 forceKillTree 并发杀错窗/profiler 误销毁/audit 归属/15 mock 工厂)→ v3/v3.1 APPROVE。实施回流一处:空 '' 桶随首次 setProjectDir 重绑(测试倒逼)。

## Minor triage(merge 后跟进 4 项)

| # | 事项 | 处置 |
|---|------|------|
| 1 | getOrCreateSession 直接路径 displayPath 首次小写缝隙(win,仅显示层) | merge 后跟进(~2 行) |
| 2 | evictExitedIfNeeded 兜底分支无直接专项测试 | merge 后跟进(补一条用例) |
| 5 | ui-layout-integration 高负载 flaky(CI 建议显式 timeout) | merge 后跟进 |
| 8 | 双项目验收判据③人肉关窗环节待用户补跑 | merge 后用户动作:`node .superpowers/sdd/multi-project-acceptance.mjs` |

记录即可:节流 Map 理论无上限 / profiler 属主弱关联的极窄残余窗口 / dashboard aggregator 既有死逻辑(留子项目 2)/ 判据②单向 / 兼容层 setRunningProcess FIFO 手动 push 不对称(src/ 零调用方,兜底防线已兜)。

## 工程教训(已登 memory)

1. 守卫总纲类统一约束的终验 = 目标文件全文通读 + 双 grep(符号零出现 + 调用方清单比对)——grep 只能证明"没有漏网",不能证明"该 key 化的都 key 化了"。
2. FIFO+惰性桶+活跃指针三机制叠加时,兜底分支是兼容层残留不一致的静默防线——防御纵深自身也需要直接测试。
