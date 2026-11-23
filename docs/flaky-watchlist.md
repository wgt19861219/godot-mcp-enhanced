# flaky 测试观察名单

> 活文档：登记**偶发失败（flaky）但未修复**的测试用例，追踪复发频次。
> 与 `test/regression/defects.ts` 的分工：defects 体系管**源码缺陷的防复发断言**（静态 grep / 行为断言，稳定可测）；本档案管**测试基建自身的偶发行为**（竞态、环境态污染、时序敏感），无法用稳定断言钉住，只能靠复发时人工计数。
>
> **记录规则**：每次全量测试遇到下表用例失败，先单跑复验（`npx vitest run <file> -t "<用例名>"`）——单跑绿 = flaky 复发，追加一行复发记录；单跑也红 = 已转稳定失败，升级为缺陷（开 defects 条目或 issue）。连续两次全量绿不删条目（保留累计视角）。
>
> 里程碑基线（2026-11-23，0.40.0 → 0.40.1 清债批）：coverage 82.4/74.92/85.59/84.18、lint 533 warnings、vitest 全量首跑 1 skip。

---

## FLAKY-001 · defects-fixed 复发计数偶发非 0

- **首见**：2026-11-22（memory-guard 三期全量首跑，终审 Deferred #9）
- **位置**：`test/regression/defects-fixed.test.ts`（FIXED 33 条 `detect() === 0` 硬断言族中的某条；具体用例名三期会话 worktree 已清理不可考，**复发时补名**）
- **现象**：全量跑偶发某条 FIXED 用例 `detect()` 返回非 0（复发误报）；单跑即绿
- **疑似机理**：全量并发下其它测试用例污染源码形态扫描的输入（文件系统/模块状态竞态），非真复发
- **处置倾向**：观察。若复发频次 ≥ 1 次/周，考虑给 defects-fixed 单独开 worker（vitest config pool 隔离）
- **复发记录**：（暂无）

## FLAKY-002 · vitest worker teardown 竞态

- **首见**：2026-11-22（memory-guard 三期全量首跑，终审 Deferred #9）
- **位置**：vitest worker teardown 阶段（非业务用例断言；具体 worker/用例归属三期会话不可考，**复发时补名**）
- **现象**：全量跑偶发 worker teardown 报未捕获错误/句柄未关类失败，测试本体已过
- **疑似机理**：fake timers / PowerShell 子进程 / 临时文件句柄在 worker 撤收时序里未完全释放（memory-guard 相关测试大量使用三者）
- **处置倾向**：观察。teardown 失败不影响用例判定语义，优先级低
- **复发记录**：（暂无）
