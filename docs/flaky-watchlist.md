# flaky 测试观察名单

> 活文档：登记**偶发失败（flaky）但未修复**的测试用例，追踪复发频次。
> 与 `test/regression/defects.ts` 的分工：defects 体系管**源码缺陷的防复发断言**（静态 grep / 行为断言，稳定可测）；本档案管**测试基建自身的偶发行为**（竞态、环境态污染、时序敏感），无法用稳定断言钉住，只能靠复发时人工计数。
>
> **记录规则**：每次全量测试遇到下表用例失败，先单跑复验（`npx vitest run <file> -t "<用例名>"`）——单跑绿 = flaky 复发，追加一行复发记录；单跑也红 = 已转稳定失败，升级为缺陷（开 defects 条目或 issue）。连续两次全量绿不删条目（保留累计视角）。
>
> 里程碑基线（2026-11-23，0.40.0 → 0.40.1 清债批）：coverage 82.4/74.92/85.59/84.18、lint 533 warnings、vitest 全量首跑 1 skip。
>
> **并发口径差异（2026-11-25 注）**：CI 的全量 vitest 是 `--maxWorkers=2`（`.github/workflows/ci.yml` 的 Run vitest 步），本地 `npm test` 不限 worker 数（默认按核数，20 核机器上并发压力远大于 CI）。下面 FLAKY-003 起的三条都出现在本地全量里，单跑均绿。

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

## FLAKY-003 · qa「立即返回」计时断言与被 mock 的套件时长没有余量（已修复）

- **首见**：2026-11-25（门禁修复批 `fix/ci-gates-20261125` 顶点 `928961ad` 全量首跑）
- **位置**：`test/qa-tasks-wire.test.ts`，用例「声明 tasks 能力的客户端：qa run → 立即返回 + _meta.relatedTask.taskId = run_id；tasks/get 轮询到终态」
- **现象**：`expect(Date.now() - t0).toBeLessThan(150)` 实测 159ms；同顶点第二跑通过；单跑 3 次通过
- **根因（已证实）**：阈值 150ms 与被 mock 的后台套件时长（`sleep(150)`）相同，零余量——事件循环停顿一次就越线，而行为本身是对的（同用例的 `status` 快照断言已证明返回早于完成）。复现：40 个忙循环进程压 20 核，12 轮里 1 轮失败（实测 403ms）
- **修复**：commit `2d1fb9dd`——模拟套件改 2000ms、阈值改 1000ms。变异检验：把实现临时改成同步路径（等套件完成再返回），用例仍失败在计时断言上（实测 2036ms）；同款负载下复跑 20 轮 0 失败
- **代价**：用例耗时由约 0.2s 增至约 2s；能抓到的「返回前等待」从 ≥150ms 变为 ≥1000ms
- **同族暴露面（未修，风险假设）**：① `test/qa-index.test.ts` 两处同形态断言，余量同样很小——阈值 150ms 对后台 200ms、阈值 80ms 对后台 100ms，测的是同一条自动异步分流路径，但直接调 handler，比 dispatcher 往返轻；② `test/tools/workflow.test.ts` 的「waitMs(0) 立即通过」阈值 80ms，比较对象是被测实现内部的 100ms 定时器，要确定性得上 fake timers。**复现尝试**：`qa-index` 整文件在 40 个与 100 个忙循环进程压 20 核下各跑 15 与 10 轮，均未复现（三次全量里也都通过）——按「无法复现只记录不修」登记。该负载只在启动突发的那一轮复现过上面已修的那条，对全量里的真实压力（同步 I/O 阻塞、GC 停顿）不是好的代理，不等于没有风险。定位命令：`grep -nE 'Date\.now\(\) - t0\)\.toBeLessThan' test/qa-index.test.ts`。仓内同形态的「`Date.now()` 差值 < 阈值」断言共 4 个文件（`grep -rlE 'Date\.now\(\) *- *[A-Za-z_0-9]+ *\)\.toBeLessThan' test/`），另两处余量充足（5s 对 30s 超时、2s 对快速停止）
- **复发记录**：（修复后暂无）

## FLAKY-004 · init.test.ts 的 afterEach 清理临时目录偶发 ENOTEMPTY（已加修复，真实触发者未定）

- **首见**：2026-11-25（同分支同顶点全量第二跑）
- **位置**：`test/cli/init.test.ts` 的 `afterEach`（`rmSync(testDir, { recursive: true, force: true })`），报在用例「uses default name when no args」之后
- **现象**：`ENOTEMPTY, Directory not empty: 'C:\Users\wgt\AppData\Local\Temp\mcp-init-test-…'`；首跑通过；单跑 3 次通过
- **已排除**：`init` 命令全是同步 fs 调用，目录名按毫秒唯一，进程内没有并发写入者
- **已证实（错误码的来向）**：删除进行时目录里仍有或又出现目录项。另一线程持续往目录里写文件时，默认选项稳定报 `ENOTEMPTY`（3/3，约 105ms）。别的进程以不含删除共享的方式占用文件或目录句柄、或把 cwd 放在目录内时，默认报 `EPERM`。本机（Windows 11 + Node 24）上含删除共享的句柄不阻塞删除
- **未定**：真实运行里是哪个外部进程造成目录项残留（杀软扫描、索引器是常见嫌疑，未能复现）
- **修复**：commit `b8a8f0a2`——`maxRetries: 5, retryDelay: 100`（线性退避，合计 1.5s，只在被干扰时才等）。实验里干扰一停即删成功（约 0.9s）
- **同类暴露面（未修，已登记待立项）**：全仓调用 `tmpdir()` 的测试文件 161 个（`grep -rlE 'tmpdir\(\)' test/ --include=*.ts --include=*.js | wc -l`），其中带删除重试的只有本文件（`grep -rlE 'maxRetries|retryDelay' test/`）；`test/cli/clients/cursor.test.ts` 有一段自制重试循环，重试之间没有等待。且这些目录都落在 C 盘系统临时目录，与「测试数据放项目目录内」的约定不一致
- **复发记录**：（修复后暂无）

## FLAKY-005 · B2「DISABLE 下不得起监听」全局探测 9081 端口，受并发 e2e 干扰（未修复）

- **首见**：2026-11-25（同分支顶点 `b8a8f0a2` 全量第三跑）
- **位置**：`test/e2e-bridge-port-linear-b1b2.test.ts`，用例「B2: GODOT_MCP_BRIDGE_DISABLE=1 spawn → 无监听日志无窗口 secret 文件」
- **现象**：`DISABLE 下不得在默认窗口起监听: expected true to be false`；前两跑通过；单跑 2 次通过
- **疑似机理**：用例起一个 `GODOT_MCP_BRIDGE_DISABLE=1` 的游戏进程后，全局探测 9081 端口 8 秒并断言无人监听，前提是「窗口内只可能有本实例」。本地全量并发时，别的 e2e 文件也在起带 bridge 的游戏（默认随机起点落在 9081–9090 窗），任一个恰好占住 9081 就会误报。未直接观测到占用者，属推断。**佐证**：失败那次用例只跑了 450ms 就判定 9081 可达（单跑时 B1 先后起两个实例、等到各自监听共约 1.7 秒），提示探测一开始端口就已被别的进程占着，不是本实例自己起的监听
- **处置倾向**：把断言收窄到本实例——stdout 无 `Listening on`（用例后半已有这条）+ 按 PID 核对该进程没有监听套接字，去掉全局端口探测。未动手
- **附带发现（非 flaky，稳定残留）**：同文件 `afterAll` 先杀进程、紧接着 `rmSync` 夹具目录且吞错，进程未退干净时删除失败——每跑必留一个夹具目录在系统临时目录。2026-11-25 实测 `%TEMP%` 下 `b1b2-port-e2e-*` 共 74 个、17.7MB（11-22 起 45 个、11-23 17 个、11-24 6 个、11-25 6 个），即当天每个全量/单跑各留一个。修法：等进程退出后再删，并带重试
- **复发记录**：2026-11-25 全量第三跑 1 次

## FLAKY-006 · dap「断点上限」用例 257 次串行请求共用默认超时，负载下超时（未修复）

- **首见**：2026-11-25（同分支顶点 `98384820`，不限 worker 的全量）
- **位置**：`test/dap.test.ts`，用例「DAP-d: 断点上限 256/source 与 512 sources(dap_limit_exceeded)」
- **现象**：`Test timed out in 10000ms`，同文件另报 2 个 `read ECONNRESET` 未处理错误；单跑通过，同顶点按 CI 口径（`--maxWorkers=2`）的全量也通过
- **机理（读码可得，未做负载复现）**：用例对 mock DAP server 串行发 257 次 `set_breakpoint`，每次调用都要经工具发请求并等响应，而用例没设自己的超时，共用 vitest 的默认用例超时 10s（用例注释假定 mock 即时回、速度快）。并发压力下 257 次请求的累计耗时越线。`ECONNRESET` 的来源没有直接观测到，推断是超时后 `afterEach` 关闭 mock 时的残留连接
- **处置倾向**：给用例显式的超时预算，或减少构造簿记超限所需的请求次数；归入 flaky 清理批。未动手
- **核查**：请求次数与默认超时 `grep -n "i <= 257" test/dap.test.ts`、`grep -n "testTimeout" vitest.config.ts`；超时现场是当日不限 worker 的全量日志（`test-output/full-run-98384820.log`，在 ignored 目录里，可能已清；其中 `ECONNRESET` 相关行为每个错误两行）
- **复发记录**：2026-11-25 不限 worker 的全量 1 次
