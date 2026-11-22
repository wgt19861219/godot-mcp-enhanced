# Memory Guard 设计 + 两期计划 第三方审查

- **日期**：2026-11-22
- **审查对象**（三份，均为待执行态）：
  1. `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-22-memory-guard-design.md`（设计 v1，已拍板）
  2. `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\plans\2026-11-22-memory-guard-phase1.md`（一期，6 任务）
  3. `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\plans\2026-11-22-memory-guard-phase2.md`（二期，5 任务）
- **审查方式**：逐条 `file:line` 实测核对（read/grep）+ 仓库门禁与 CI 现状核对（`.github/workflows/ci.yml`、`scripts/*.mjs`、`vitest.config.ts`、`package.json`）+ 上游反馈库回读（`D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md`）+ 同批并行计划交叉核对（`docs\superpowers\plans\2026-11-22-feedback-batch-20261122.md`）。
- **本次限制（诚实声明）**：本会话 shell 被 Windows 沙箱 ACL 授权故障阻断（`pwsh` 全部拒绝执行），**未能实跑** PowerShell 采样、`npm run lint`、`vitest`、覆盖率与门禁命令。因此：凡"数字/口径"类结论，凡可静态定谳的写死（file:line、字段名、脚本行为）；凡需实跑才能定值的（`os.freemem()` 口径、WMI 字段实际读数、覆盖率余量）**只给判据 + 复核命令**，不给编造数字。

---

## 0. 总体判定

| 文档 | 判定 | 一句话 |
|------|------|--------|
| 设计 v1 | **BLOCKING（4 处事实/口径必改，改后可拍板）** | 语义来源（kubelet/Bazel/Docker 反模式）扎实、责任边界清楚；但"两个 spawn 漏斗"与实证归纳两处失真，commit 口径字段与自身 §2 定义矛盾，预算闸用声明值低估时会漏掉 11-22 那类多实例场景 |
| 一期 | **BLOCKING（B1/B2/B3/B6 未修则目标落空或 CI 必红）** | 任务粒度/TDD 步骤/错误码契约都到位，但**主炸弹 spawn 点、launch_editor 接线点、commit 口径字段、CI/门禁对齐**四处错位——照字面执行会"建了闸门但闸门不在炸弹所在的路上" |
| 二期 | **SHIPPED WITH NITS（1 项前置依赖必须先落）** | 状态机/驱逐排序/退出链语义设计合理；但依赖一期不存在的 `preview` 会话字段，且有快照缓存与驱逐循环的冲突、pressure 状态机的循环依赖、以及一个可显著降本既有缺陷（`get_performance` 内存字段根本没实现） |

---

## 1. 事实核验表（逐条实测）

### 1.1 引用命中（PASS）

| 文档声明 | 实测 | 结论 |
|---|---|---|
| `taskkill /F /T` 树杀在 `process-state.ts:30/:78` | `src\core\process-state.ts:30`、`:78` 均 `spawn('taskkill', ['/F','/T','/PID',…])` | ✅ |
| 漏斗 A 含 `gdscript-executor.ts:905` | `src\gdscript-executor.ts:905` `spawn(godotPath, godotArgs, …)` | ✅ |
| 漏斗 A 含 `headless-process.ts:18` | `src\core\headless-process.ts:18` `spawn(binPath, args, …)` | ✅ |
| 漏斗 B 含 `runtime.ts` run_project 先停旧 `:197-205` | `src\tools\runtime.ts:197-205` "Stop existing" 段 | ✅ |
| PowerShell 复用 `orphan-cleanup.ts:102` spawn 模式 | `src\core\orphan-cleanup.ts:102` `spawn(command, shellArgs, …)`（`fullSystemScanGodot` 的 `Get-CimInstance Win32_Process` 同款） | ✅ |
| 原子写走 `fs-atomic.ts` | `src\core\fs-atomic.ts:21` `writeFileAtomicWithMode` / `:41` `writeFileAtomic` 别名 | ✅ |
| 看门狗挂载点 `GodotServer.ts:775-777`（既有 60s 周期扫描） | `src\GodotServer.ts:775-777` `setInterval(… killOrphanGodotProcesses …, 60_000)` | ✅ |
| registry 心跳 `mcp_bridge.gd:960-971` | `src\scripts\mcp_bridge.gd:960-971` entry 字典（id/projectPath/port/pid/lastSeen…） | ✅ |
| machine registry `~/.godot-mcp/instances` | `src\core\instance-manager.ts:85`；GD 侧 `mcp_bridge.gd:936` 推导到同一路径 | ✅ |
| `GODOT_MCP_MAX_SESSIONS` 仅单 server 进程内、默认 4 | `src\core\process-state.ts:450` `Math.max(1, Number(env) || 4)`；`_sessions` 是进程内 Map（`:161`） | ✅ |
| lint 基线 533 | `package.json:41` `eslint … --max-warnings 533` | ✅ |
| `check:tool-count` / `check:ssot-params` 存在 | `package.json:70-71` | ✅ |
| `godot_get_context` 工具存在、有 `server` 字段族 | `src\tools\get-context.ts:50`、`:75`（server）、`:156` | ✅ |
| doctor 实现在 CLI | `src\cli\doctor.ts` 存在（AGENTS.md 同述） | ✅ |
| 二期 Task 4 grep 清单的行号（`godot-finder.ts:4`、`editor-auth.ts:5`、`instance-manager.ts:18`、`bridge-client.ts:20`、`screenshot.ts:21`） | 逐个命中（分别为 `execFile`/`execFileSync` 的 import 行） | ✅ |
| "全仓 `os.freemem()` 零命中" | 全仓 grep 仅命中设计文档自身三处，代码零处 | ✅（表述见 N4） |

### 1.2 事实错误 / 失真（FAIL）

| # | 文档声明 | 实测 | 严重度 |
|---|---|---|---|
| F1 | 设计 §3 L1："**两个** spawn 漏斗前置同一个守门函数"；"漏斗 A：短命 headless 链（… execute_gdscript / run_tests / validate / screenshot / dev_loop 共用）" | Godot 进程 spawn 点至少 7 处：`gdscript-executor.ts:905`、`headless-process.ts:18`、`tools\spawn-helper.ts:46`、`screenshot.ts:79`、`runtime.ts:234`/`:254`、`runtime.ts:450`、`runtime.ts:585`、`GodotServer.ts:687`。其中 **screenshot 完全不走漏斗 A**（`src\screenshot.ts:79` 自建 spawn）；`tools\spawn-helper.ts:46` 被 `validation.ts:19`、`workflow.ts:13`、`scene\index.ts:18`、`batch-tools.ts:13`、`android.ts:8` 五个工具模块复用；`run_tests` 的两条路径（分片 `runtime.ts:526`、单片 `runtime.ts:727`）都只经 `runGutProcess`（`runtime.ts:450`），**与 executor 无关** | **BLOCKING（B1）** |
| F2 | 一期 Task 4 Files：`Modify: src/GodotServer.ts:687（launch_editor：admitSpawn('editor',{exemptChecks:true}) → spawn → bindLeasePid(child.pid)）` | `GodotServer.ts:687` 是 **Web GUI 面板"编辑"按钮** `editProject`（注释明说"launch_editor 链复刻"）；工具层 `launch_editor` 在 `src\tools\runtime.ts:579-591`（spawn 在 `:585`）。一期 Files **未列入** `runtime.ts:585` | **BLOCKING（B2）** |
| F3 | 设计 §1 形态 2："多实例并发叠加 … 双会话并行 B 侧 8 实例齐起**挤崩** A 侧+门禁偶发挂"（表格标题为"实证死机形态"） | 上游反馈库 2026-11-22 条原文（`插件反馈与改进建议.md:617-619`）现象是：A 的 preview 窗口**被顶替** + ping 连到陌生实例（pid 漂移 fps=1）+ "连跑两次全量门禁在不同片偶发挂（多实例资源竞争叠加）"；**该条未记录整机死机**，其建议四条全指向归属/可见性，无任何内存项（该条修复归 `2026-11-22-feedback-batch-20261122.md` Task 4）。真正实证死机只有 11-12 GUT 22.5GB 一条（`:645-647`） | 高（设计叙事层） |
| F4 | 设计 §3 L1 水位查：commit 余量 = `Get-CimInstance Win32_OperatingSystem` 算 `FreeSpaceInPagingFiles`；一期 Task 1 同（"commit 余量 = FreeSpaceInPagingFiles×1024"） | 与设计 §2 自述的 commit 口径（`CommitLimit−CommitTotal`）**不是同一个量**：`Win32_OperatingSystem` 的 commit 等价字段是 `TotalVirtualMemorySize`（limit）与 `FreeVirtualMemory`（avail）；`FreeSpaceInPagingFiles` 只是页文件空闲量，不含由 RAM 承载的 commit 部分 | **BLOCKING（B3）** |
| F5 | 设计 §3 L2 正文："某 spawn 进程实测 RSS > **声明值 × 2** → 直接杀" | 同文档 §5 补充裁定：headless/gut=×2、game/editor=×3；一期 `KILL_FACTOR` 也按 ×3 实现。§3 正文与 §5 裁定不一致（§3 的豁免段又写"声明 × 3"），三处表述需统一到一张 `KILL_FACTOR` 表 | 中（N1） |
| F6 | 二期 Task 1 假设"会话元数据中 preview 标记——…缺则补" | `RunSession`（`process-state.ts:143-153`）**无 preview 字段**；preview 只是 `run_project` 的调用参数（`runtime.ts:176`/`:277`/`:360`/`:365`）。一期 Review Focus 4 又明确"preview 不在本期特判"→ 二期 Task 1/3 的 preview 豁免**无数据源**，且 plan2 的 Files 未列 `process-state.ts` 补字段 | **BLOCKING（二期，M7 升为前置）** |
| F7 | 一期 Task 6：README env 表"新增 7 项" | 实际新增 9 项（MEMORY_GUARD / MIN_FREE_MB / MEM_BUDGET_PCT / MAX_MACHINE_INSTANCES / MEM_POLL_SECONDS / DECLARED_MB_×4），说法模糊 | 低（N7） |

---

## 2. Blocking Issues（一期必改，否则目标落空或 CI 红）

### B1 主炸弹的 spawn 点不在计划点名的漏斗上（最严重）

- **证据**：`run_tests` 的单片与分片两条路径都走 `runGutProcess`（`src\tools\runtime.ts:439-487`，spawn 在 `:450`；调用点 `:526` 与 `:727`）。一期 Task 4 却写"`src\gdscript-executor.ts`（spawn 点 :905 前置 admit + **公开 API 透传 spawnKind**）… **run_tests 调用点传 `'gut_shard'`**"——run_tests 根本不 import executor。
- **后果**：若执行者照字面落码（给 `executeGdscript` 加 `spawnKind` 参数 + 在 run_tests 传参），executor 上的参数是**死代码**，而 `runGutProcess` 未接 admit → **22.5GB GUT 主炸弹既不被准入拦截、也不被看门狗杀**（看门狗只采样"有租约的 pid"）。一期 Goal 第一条直接落空。
- **修法**：Task 4 Files 与 Interfaces 改为
  - `src\tools\runtime.ts:450`（`runGutProcess` 内 spawn 前）`admitSpawn('gut_shard') → spawn → bindLeasePid`，exit/close/超时三路 `releaseLease`（该函数已有 timeout/close/error 三路 resolve，挂钩点现成）；
  - 删除"executor 透传 spawnKind"，改为"executor 恒 `headless`"。
- **顺带**：Task 4 的四个漏斗应显式补第五个 `src\tools\spawn-helper.ts:46`（`validation` / `workflow` / `scene` / `batch-tools` / `android` 共用的 Godot headless 通道）——这是 AI 批量作业最常用、最容易堆内存的通道之一；`screenshot.ts:79` 可归入"二期自查 + 声明 headless 但不影响炸弹治理"或同样接入。

### B2 launch_editor 接线点错位（editor 4GB 记账落空）

- **证据**：见 F2。工具层入口 `runtime.ts:579-591`（`case 'launch_editor'`，spawn `:585`，`detached + unref`）；`GodotServer.ts:687` 是面板 `editProject`。
- **后果**：只改 `:687` → AI 调 `launch_editor` 起编辑器**不建租约、不计 4GB、看门狗不采样**；一期 Review Focus 3 声称的"editor 豁免检查但仍记账"实际只覆盖面板按钮。
- **修法**：Files 同时列 `runtime.ts:585`（主）与 `GodotServer.ts:687`（面板链），两处同款 `admitSpawn('editor',{exemptChecks:true})`；注意 `detached:true` 下 pid 存活探测要允许"pid 复用/编辑器中转"（见 M6）。

### B3 commit 口径字段取错（会系统性误拒）

- **证据**：设计 §2 定义 commit 余量 = `CommitLimit − CommitTotal`；一期 Task 1 的 PowerShell 却取 `FreeSpaceInPagingFiles`，且 snapshot 接口声明了 `commitTotalBytes` 却没取 `TotalVirtualMemorySize`。
- **后果**：`FreeSpaceInPagingFiles` 不含 RAM 承载的 commit；在"固定大小页文件"或"关闭页文件"的机器上读数会显著偏小甚至接近 0 → `MEMGUARD_LOW_WATER` **恒拒**（把可用机器锁死）。这与设计 §4"降级不放大通过面"的初衷相反：口径错会放大**拒绝面**。
- **修法**：采样改为
  ```
  Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json
  ```
  `commitTotalBytes = TotalVirtualMemorySize×1024`、`commitAvailBytes = FreeVirtualMemory×1024`；并给 `commitAvailBytes` 单独 env 阈值（见 M2），而不是复用 `GODOT_MCP_MIN_FREE_MB`。
- **复核命令**（执行者落盘前必跑，本会话无法执行）：
  `powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory,FreeSpaceInPagingFiles | Format-List"` —— 四个字段对照，确认 commitAvail 与 `CommitLimit−CommitTotal` 同量级。

### B4 预算闸用"声明值"求和，声明低估时闸门失真（设计层，一期就存在）

- **证据**：一期 Task 2 预算查 `Σ activeLeases.declaredMB + 本kind声明MB ≤ totalmem × 67%`。11-22 场景：32GB 机 → 预算 21.4GB；`game_window` 声明 3072MB → 数学上**允许 7 个 game 会话**（21GB）；但设计 §3 L1 自己写"实测 1-7GB 取中位偏上"，最坏 7×7=49GB —— 而单进程杀线是 9GB/实例，整机在任一实例到 9GB 前就先死。
- **后果**：一期"治多实例叠开"对**声明低估**的场景无效（Bazel 的闸门前提是声明可信；这里已经知道不可信）。
- **修法（零额外采样成本）**：预算求和改 `Σ max(declaredMB, 实测RSS)`（L2 的 10s RSS 采样本来就采了本 server 的 pid；跨 server 租约可用 lease 上缓存的最近读数）。或者退一步：把 `GODOT_MCP_MEM_BUDGET_PCT` 默认 67 降到 50 并在 design 里写明"声明值是下界假设"。前者更好，建议写进一期 Task 2 与二期 Task 3 的判据。

### B5 租约存储的两个硬缺陷（会"第一次就炸"）

- **(a) 父目录不保证存在**：`writeFileAtomicWithMode`（`src\core\fs-atomic.ts:21-37`）**不建父目录**（`writeFileSync(tmpPath)` 直接抛 ENOENT）；仓库另有 `ensureDir(filePath)`（`:46-50`）却不在本计划里。而 `~/.godot-mcp/` 并非启动即存在：`cli\uninstall.ts:338-351` 的 `--purge` 会整目录删除；新机/CI/Linux runner 也未必有。设计 §3 L1 那句"目录已存在——machine registry 同级"是**假设**，不是事实。
- **(b) 读写失败语义未定义**：设计说"准入是保险丝不是精确配额"，但没写"leases 文件读不出/写不进"时是 fail-open 还是 fail-closed。若实现成抛错上浮，结果是**所有 spawn 全拒**（比没有闸门更坏）。
- **修法**：`ensureDir(leasesFilePath())` 落在 acquire/list 两个入口；读侧 JSON 损坏 → 记一行 `MEMGUARD lease-store unreadable` + 视为空表（fail-open）；写侧失败 → 放行 + 降级标记（doctor 可见）；这三种情形各补一条测试。

### B6 一期缺 CI/门禁对齐（按现计划合并会红）

1. **覆盖率门禁**：CI 的 check job 装 Godot 4.6.3 并 `npx vitest run … --coverage`（`.github\workflows\ci.yml:127-152`），阈值 statements 76 / branches 67 / functions 80 / lines 77（`vitest.config.ts:91-96`）。一期新增两个体量不小的 Windows-only 核心文件，且**降级分支**（非 Windows / PowerShell 失败 / 解析失败）必须被覆盖到才能过阈值；一期 Task 6 门禁只写 `npx vitest run`（不带 `--coverage`）→ **本地绿 ≠ CI 绿**。
2. **changelog 门禁**：CI 以 `STRICT=1` 跑 `check:changelog-sync`（`ci.yml:104-114`），规则是"最近版本日期之后的 feat/fix commit 必须能在 `[Unreleased]`（>50 字符实质内容）或最近版本段中找到"（`scripts\check-changelog-sync.mjs:108-119`）。一期做版本四件套会把内容写进 `## [0.38.2]` 段；若 `[Unreleased]` 被清空，同日后续 feat commit（就是本批自己）会触发阻断。**旁证**：同批 `2026-11-22-feedback-batch-20261122.md:15` 已明确写"（[Unreleased] 保留实质内容 >50 字符）"，一期/二期都漏了这句。
3. **CI 语义开关**：check job 里 Godot 真跑（`GODOT_PATH` 生效），guard 默认启用且 Linux 走 degraded（`godotProcCount=0` 跳计数、commit 置 null）——只剩 `os.freemem()` 水位一条。共享 runner 上 `freemem` 波动会变成**随机拒绝 spawn → 测试红**。应对齐 `GODOT_MCP_BRIDGE_DISABLE` 先例，在 `ci.yml` 的 check/e2e job 显式 `GODOT_MCP_MEMORY_GUARD: '0'`（或把 watermark 调到 512MB）。两期计划的 Files 都**没有** `.github/workflows/ci.yml`。
4. **门禁清单本身**：一期 Task 6 建议补 `npm run test:coverage`、`STRICT=1 npm run check:changelog-sync`；`version-check`/`check:modules-sync`/`check:test-quality` 虽不受影响，但 CI 是全量跑，本地逐项对齐更省一轮返工。

---

## 3. 中等（建议改，不改也能落地）

### M1 新错误码未收编注册表（retryable 语义自相矛盾）

`MEMGUARD_LOW_WATER` / `MEMGUARD_BUDGET` / `MEMGUARD_INSTANCE_CAP` / `MEM_BUDGET_EXCEEDED` 未进 `ERROR_CODES`（`src\core\error-codes.ts:34-88`）与 `docs\error-codes.md`（两向对账测试 `test\core\error-codes-doc.test.ts:19-27`）。未登记时 `opsError` 走兜底：`retryable=false` + 一次性 warn（`src\core\shared\errors.ts:31-38`）——但拒绝文案本身在建议"稍后重试"，**响应体说不可重试、文案说稍后重试**。建议按语义登记：前三个 `retryable:true, category:'guard'`，`MEM_BUDGET_EXCEEDED` `retryable:false, category:'guard'`；两期计划各加一步。

### M2 准入快照不能同步阻塞 event loop

一期接口 `getMachineMemorySnapshot(): MachineMemorySnapshot`（同步返回）暗示用 `execFileSync` 跑 PowerShell；PowerShell/WMI 单次 50-500ms、超时 5s。MCP server 是单线程，每 10s 冻结最多 5s 会打崩交互体验，且与设计自己引用的"30s 硬超时"叠加。建议：**后台定时器异步采样（`setInterval(...).unref()`）写缓存，准入只读缓存**；首启无快照按"降级放行"。同时合并采样调用：水位 + Godot 计数 + 本机 RSS 用**一次** PowerShell 取（一期 Task 1 现列 3 条独立命令：水位快照、`Get-Process` 计数、`Get-CimInstance Win32_Process` RSS，每轮三次进程开销）。

### M3 测试注入方式与仓库先例不一致

- Task 1 Step 1 用 `USERPROFILE` 重定向夹具：会波及同进程所有 `homedir()` 消费者（`instance-manager.ts:85`、`godot-finder.ts:76`、`core\inflight.ts:26`、`update-checker.ts:67`、`qa\report.ts:60` …），无关测试可能连带红。
- 仓库已有更干净的先例：`GODOT_MCP_INFLIGHT_DIR`（`core\inflight.ts:26`）、`GODOT_MCP_QA_REPORTS_DIR`、`restore-points` 的 env 覆盖。建议直接 `GODOT_MCP_MEMORY_LEASES_PATH`（默认 `~/.godot-mcp/memory-leases.json`），既满足测试隔离，也符合 AGENTS.md"新依赖走注入、禁止新增模块级 setter"。
- 模块级单例状态（快照缓存 / 租约缓存 / 看门狗 timer）需一个 `resetMemoryGuardState()`（对齐 `process-state.ts:702 resetState`、`error-codes.ts:107 resetUnregisteredCodeWarnings`），否则测试间串味。
- 测试手法：`vi.spyOn(process,'kill')` 可行；但"spy `fs-atomic` 模块"在 ESM 下不能对 namespace `vi.spyOn`，须 `vi.mock('../../src/core/fs-atomic.js', importOriginal)`。

### M4 IdleTimer 的 poke 归属（二期）

二期 Task 1 写"Modify `bridge-client.ts`（查询/输入路径成功后调 `pokeRunSession(projectPath)`——grep 既有 projectPath 可得调用点）"。实际 `sendToBridge`（`bridge-client.ts:929`）**不带 projectPath**，端口由模块级活跃指针解析；多项目并存时"活跃指针"未必等于本次响应的会话桶。更稳的做法：在工具层 `src\tools\game-bridge.ts`（`:552`/`:556`/`:558` 已按调用切换 `setBridgeProjectDir`）poke 明确 projectPath；bridge-client 内只做兜底。

### M5 二期：快照 10s 缓存 vs 驱逐循环"杀一个重采样"

二期 Task 3 要求逐杀逐采样，但一期 `getMachineMemorySnapshot()` 有 10s 缓存 → 杀完仍读到旧水位，会**多杀**。建议接口补 `getMachineMemorySnapshot({force?:true})` 或在驱逐循环里走一次性采样函数；plan2 应显式写这条。

### M6 二期：pressure 状态机归属会成环

一期 `mem-watchdog.ts` import `memory-guard.ts`（Task 3 Consumes）；二期 Task 2 又要 `memory-guard.acquireLease` import `mem-watchdog.getPressureState` → **循环依赖**。建议把 pressure 状态机放进 `memory-guard.ts`，或抽 `src\core\memory-pressure-state.ts`（零依赖叶子），watchdog 只负责采样与驱逐。

### M7 二期：preview 字段必须先落（已升为前置）

见 F6。建议二期 Task 1 Files 显式加 `src\core\process-state.ts`：`RunSession.preview: boolean` + `setSessionPreview(projectPath, preview)`；并处理"同项目重跑覆盖"（每次 `run_project` 都按本次 `args.preview` 覆写，`runtime.ts:176` 已有该值）。二期 Task 3 的"preview/editor 排最后"也依赖它。

### M8 二期：exit-watchdog 与 daemon 共存

`GodotServer` 在 daemon 内也实例化（`src\daemon\main.ts`），daemon 另有受控重启链（`src\daemon\controlled-restart.ts:124-140`）；stdio `'close'` 在 daemon 语义下不可靠。建议：exit-watchdog 只在 stdio 入口注册；daemon 侧由 `SIGTERM`/`close()` 链调同一回收函数（`GodotServer.close()` 已有清理链），避免"双杀/漏杀"。plan2 Task 4 只写"现场确认"，建议直接写成 Files 清单 + 判据。

### M9 二期：memBytes 可降本为一行的既有缺陷修复

- 事实：`godot_get_context.performance` 已在 TS 侧按 `get_performance` 的 `static_mem`/`memory` 取内存（`src\tools\get-context.ts:297-307`，测试 `test\tools\get-context.test.ts:232` 也是 mock `static_mem`），但 GD 侧 `_cmd_get_performance`（`src\scripts\mcp_bridge.gd:2983-2990`）只返回 `fps/frame_time/physics_time/object_count/node_count` —— **既无 `static_mem` 也无 `memory`**，所以真实 bridge 模式下 `performance` **恒为 null**（既有静默缺陷，属本次审查顺带发现）。
- 建议：二期 Task 5 先修 `_cmd_get_performance` 增 `static_mem = Performance.get_monitor(Performance.MEMORY_STATIC)`（1 行，同时修好既有面板）；registry 心跳的 `memBytes` 变得**可选**——跨会话要 RSS，拿 registry 条目里已有的 `pid` 走 `Win32_Process.WorkingSetSize` 就行，无需 GD 改动。这样可省掉"GD 心跳字段 + BRIDGE_SCRIPT_VERSION + 规则双副本 + 版本链"的连锁（而这正是二期风险最高的一段）。

---

## 4. Nits

| # | 位置 | 内容 |
|---|---|---|
| N1 | 设计 §3 L2 / §5 | ×2 与 ×3 三处表述不一致（见 F5），建议 §3 直接贴 `KILL_FACTOR` 表并让段落引用它 |
| N2 | 设计 §3 L1 | "两个 spawn 漏斗"是错的（见 F1）；即使不扩到 spawn-helper，也至少要写"共 7 处 Godot spawn，一期接 5 处，其余二期" |
| N3 | 设计 §3 L1 ③ / 一期 Task 1 | 设计写"tasklist 兜底扫描"，计划用 `Get-Process ... Name -like 'Godot*'`（又一条 PowerShell）；且按进程名匹配会漏"改名过的 Godot 二进制/导出的游戏 exe"。建议：计数 = 活租约 pid ∪ `Win32_Process` 里 `Name LIKE 'Godot%' OR CommandLine LIKE '%--path%'`，并与水位/RSS 合并成一次调用 |
| N4 | 设计 §2 | "`os.freemem()` 物理口径偏保守"待实测（Node 在 Windows 走 `GlobalMemoryStatusEx.ullAvailPhys`，与任务管理器"可用"同源，未必"保守"）；复核：`node -e "const os=require('os');console.log(os.freemem()/2**30,os.totalmem()/2**30)"` 与任务管理器对照 |
| N5 | 设计 §2 | "引用见调研底稿"但未给路径（可追溯性）；建议补 `D:\workspace\Obsidian\...` 具体文件 |
| N6 | 设计 §3 L3 / 一期 Task 5 | 一期就出 doctor 两行属 L3 成分，与裁定③"L3 面板二期"字面冲突；建议在裁定③备注"一期允许最小两行，完整面板二期" |
| N7 | 一期 Task 6 | env 实为 9 项（见 F7）；另建议 `GODOT_MCP_MEMORY_LEASES_PATH`、`GODOT_MCP_PRESSURE_SOFT_MB` 等也进 README 表（含默认值与"0=关"语义） |
| N8 | 二期 Task 2 | 软阈值拒绝复用 `MEMGUARD_LOW_WATER`，日志/doctor 里无法区分"水位不足"与"压力持续"；建议独立 `MEMGUARD_PRESSURE` |
| N9 | 二期 Task 4 | spawn/execFile 自查清单只列 7 处；实测另有 `src\web-gui\open.ts:35/47/51/55`（4 处**无 timeout**）、`src\cli\clients\codex.ts:83`（无 timeout）、`src\tools\spawn-helper.ts:46`、`src\screenshot.ts:79` 等未列；建议改成"grep 全量清单打勾表"并把无 timeout 的逐个补 |
| N10 | 二期 Task 5 | "BRIDGE_SCRIPT_VERSION bump"由 `npm run version-sync` **自动同步**（`scripts\version-sync.mjs:29`/`:88-90`/`:122`，CI `version-sync --check` 会拦手改），措辞改为"随版本四件套自动同步，无需手改" |
| N11 | 一期 Global Constraints | 版本 0.38.2/0.38.3 与当前 `package.json:3`（0.38.1）逻辑成立；但同批 `2026-11-22-feedback-batch-20261122.md` 也声明 0.38.1→0.38.2，两计划若同分支/同 PR 落地只有一个 patch bump（另一份退让或合并成 0.39.0）。建议写明"与反馈批的落地顺序约定：后落地者 bump；同 PR 时合并为一笔并声明" |
| N12 | 一期 Review Focus 5 | "归因窗口保留 10min"与 `wasMemKilled` 的 pid 复用风险：Windows pid 复用窗口短，但建议记录 `(pid, startedAt)` 双键比对，并在 lease 释放时顺手清归因（现有 10min TTL 兜底也够） |
| N13 | 一期 Task 3 挂载 | `startWatchdog()` 只挂在 `GodotServer` 启动序列——daemon 模式同样会跑（共享该类），但 `stopWatchdog()` 在 `close()` 里要补，否则 daemon 受控重启后旧 timer 残留（plan 未提） |
| N14 | 设计 §4 | "preview 会话与编辑器不豁免记账、驱逐排序最后"与 §3 L2 的"单进程硬帽 ×3"关系表述绕；建议一句话：`KILL_FACTOR` 恒定生效，`WATCHDOG_EXEMPT` 只影响**驱逐排序**，不影响单进程杀线 |

---

## 5. 仓库级约束（AGENTS.md）覆盖核查

| 约束 | 计划覆盖 | 缺口 |
|---|---|---|
| 完成前三件套 `lint` / `build` / `test` | 一期 Task 6 ✅（二期 Task 5 隐含） | `test` 未带 `--coverage`（CI 用带覆盖率的跑法，见 B6-1） |
| `check:rules-sync` STRICT（改规则后） | 二期 Task 5 ✅ | 一期不碰规则 ✅ 一致（N10 的自动版本同步需注意顺序：`build` 在前） |
| `check-rules-version-bump` 硬门禁 | 二期做版本四件套 ✅ | 一期不动 rules ✅ |
| CHANGELOG `[Unreleased]` 留 >50 字符 | **两期都缺** | 见 B6-2（实证：同批另一计划已写） |
| `docs/reviews/YYYY-MM-DD-<feature>.md` 第三方审查文档 | **两期都缺** | AGENTS.md §8 强制；建议二期 Task 5 收口时一并产出（或一期 Task 6 出一份） |
| 完成前必登 memory（`create_entities`） | **两期都缺** | AGENTS.md 强制；建议在两期收口各加一步 |
| 不引新依赖 | 两期 ✅ | ✅ |
| 禁止新增模块级 setter 注入点 | 一期 🔶（Task 1 提"或抽 `leasesFilePath()` 可注入"，属模糊地带） | 走 env 覆盖（M3）即可避开 |
| 具体 file:line（禁模糊定位） | 一期 Task 5 "grep `doctor` 定位 src/cli 或 tools 实现" ❌ | 直接写 `src\cli\doctor.ts`（已核实存在） |
| 绝对路径引用 | 一期 ✅（spec 用绝对路径）/ 二期 🔶（Spec 行用相对路径 `docs\superpowers\...`） | 二期 Spec 行改绝对路径 |

---

## 6. 建议的修订（可直接抄进文档）

### 6.1 设计 v1 补丁

1. §3 L1 漏斗段替换为：
   > **Godot spawn 点共 7 处**（一期实测）：`gdscript-executor.ts:905`（execute_gdscript 家族）、`core/headless-process.ts:18`（runGodotHeadless：import-check / check-gdscript / blender）、`tools/spawn-helper.ts:46`（validation / workflow / scene / batch-tools / android）、`screenshot.ts:79`、`runtime.ts:234/:254`（run_project）、`runtime.ts:450`（run_tests 单片+分片）、`runtime.ts:585` + `GodotServer.ts:687`（launch_editor 双入口）。一期接入：executor / headless-process / runGutProcess / run_project / launch_editor(×2)；`spawn-helper`、`screenshot` 归二期自查批。
2. §3 L1 水位查 commit 口径改 `FreeVirtualMemory` / `TotalVirtualMemorySize`（B3）。
3. §3 L2 单进程预算改用 `KILL_FACTOR` 表表述（N1），并补一句"杀线按 `max(declared, measured)` 记账的预算联动"（B4）。
4. §1 形态 2 证据改写为"多会话/多 worktree 并行：窗口被顶替 + ping 连错实例 + 门禁偶发挂（11-22，非整机死机）；内存侧的叠加风险为外推"（F3）。
5. 新增 §3.5"租约存储健壮性"：父目录 `ensureDir`、损坏 fail-open、写失败降级、doctor 可见（B5）。

### 6.2 一期补丁

1. Task 4 Files/Interfaces 按 B1+B2 重写（`runGutProcess:450`、`runtime.ts:585`、`GodotServer.ts:687`、`spawn-helper:46` 是否入一期需一次决策）。
2. Task 1 采样命令换字段（B3）+ 合并为一次 PowerShell + 异步采样（M2）+ `GODOT_MCP_MEMORY_LEASES_PATH` 注入（M3）+ `ensureDir` / 损坏容错（B5）+ `resetMemoryGuardState()`（M3）。
3. Task 2 预算查改 `Σ max(declared, measured)`（B4）。
4. 新增 Task 5'（可与 Task 5 合并）：`src\core\error-codes.ts` + `docs\error-codes.md` 登记 4 码 + 对账测试（M1）。
5. Task 6：
   - 门禁补 `npm run test:coverage`、`STRICT=1 npm run check:changelog-sync`；
   - README env 表 9 项（N7）；
   - CHANGELOG 定版段 + `[Unreleased]` 保留 >50 字符（B6-2）；
   - 新增一个 commit：`.github/workflows/ci.yml` 加 `GODOT_MCP_MEMORY_GUARD: '0'`（B6-3）；
   - 新增 `docs/reviews/2026-11-22-memory-guard.md` 步骤 + memory 登记步骤（§5 表）。
6. Global Constraints 加"与反馈批 20261122 的版本/文件冲突约定"（N11：两计划都改 `runtime.ts:197-205`、`mcp_bridge.gd:960-971`）。

### 6.3 二期补丁

1. Task 1 Files 加 `process-state.ts`（`preview` 字段 + `setSessionPreview`），poke 改工具层（M4/M7）。
2. Task 2 pressure 状态机落 `memory-guard.ts` 或独立叶子模块（M6）；拒绝码独立 `MEMGUARD_PRESSURE`（N8）。
3. Task 3 明确"驱逐循环用 force 采样"（M5）。
4. Task 4 Files 写明 `ci.yml`/`daemon` 判据与 stdio-only 注册条件（M8）；spawn 自查清单改全量打勾表（N9）。
5. Task 5 先修 `_cmd_get_performance` 的 `static_mem`（M9），`memBytes` 视需要再定；措辞改"N10 自动同步"。

---

## 7. 执行前必须实跑验证的顺序（本会话无法执行，留给执行者）

```powershell
# 1) WMI 口径核对（B3）——确认 commit 字段含义与量级
powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory,FreeSpaceInPagingFiles | Format-List"

# 2) os.freemem 口径核对（N4）
node -e "const os=require('os');console.log('free',(os.freemem()/2**30).toFixed(2),'total',(os.totalmem()/2**30).toFixed(2))"

# 3) Godot spawn 全量清单（B1）——确认无漏
#    期望命中：gdscript-executor.ts:905, headless-process.ts:18, spawn-helper.ts:46,
#    screenshot.ts:79, runtime.ts:234/254/450/585, GodotServer.ts:687
Get-ChildItem src -Recurse -Filter *.ts | Select-String -Pattern "spawn\(godot|spawn\(godotPath|spawn\(binPath|spawn\(effective" | Select-Object Path,LineNumber,Line

# 4) 门禁（B6）——按 CI 同款跑，不要只跑不带覆盖率的 vitest
npm run build; npm run lint; npx vitest run --coverage
STRICT=1 npm run check:changelog-sync
STRICT=1 npm run check:rules-sync
npm run check:tool-count; npm run check:ssot-params
```

---

## 8. 值得进 memory 的工程教训（建议登记）

1. **"漏斗"结论必须用 grep 全量核对，不能按模块直觉归纳**：`run_tests` 的 GUT spawn 在 `runtime.ts:450`，不在 `gdscript-executor.ts`——这类"以为共用、实际各写一份"的 spawn 在本仓至少 7 处（`spawn-helper.ts:46` 被 5 个工具复用却最容易被漏）。
2. **同仓同名能力有两份实现**：`launch_editor` 有 `runtime.ts:585`（工具）与 `GodotServer.ts:687`（面板）两条链；改一处必查另一处（同类先例：`stop_project` 的 orphan 分支）。
3. **写机器级状态前先 `ensureDir`**：`writeFileAtomic` 不建父目录，而 `~/.godot-mcp` 会被 `uninstall --purge` 整删——任何新文件写入点都要显式建目录，否则"新机首跑炸"。
4. **`get_performance` 的 `static_mem` 从未在 GD 侧实现**（`get-context.ts:297-307` 期待、`mcp_bridge.gd:2983-2990` 未返回）→ `get_context.performance` 真实环境恒 null；新做内存面板前先修这个一行缺陷，可省一次 GD 改动与规则双副本连锁。
5. **CI 覆盖率/changelog 是"本地绿≠CI 绿"的两处经典断层**：`--coverage` 才触发阈值；`check:changelog-sync` 在 STRICT 下要求 `[Unreleased]` 留 >50 字符实质内容。

---

## 9. 结论

- **设计 v1 方向正确、边界清晰**，可保留四层结构与拍板结论；但 F1/F2/F3/F4 + B4/B5 是"落地会打不中目标"或"会永远拒绝"级别的缺陷，建议**改完再进实现**。
- **一期可以开工**，前提是先把 B1（runGutProcess）/B2（runtime.ts:585）/B3（commit 口径）/B6（CI 三件）四处修进计划；B4/B5 建议同批修，成本都很低。
- **二期在一期落地后再启动**，但 M7（preview 字段）与 M5（force 采样）必须在一期实现时预留接口，否则二期要返工一期文件。
