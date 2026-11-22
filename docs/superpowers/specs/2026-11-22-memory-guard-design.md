# Memory Guard 内存治理机制设计（v1.1）

**日期**：2026-11-22　**状态**：已拍板 + 已过第三方审查（`docs\reviews\2026-11-22-memory-guard-design-review.md`，6 Blocking/9 中等/14 Nits 已吸收）　**上游反馈条**：11-12 死机定谳条 / 11-22 多会话条（`D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md`）

## 1. 问题定义（实证形态）

| 形态 | 实证 | 现有防线 |
|------|------|---------|
| **单进程内存炸弹（唯一整机死机实证）** | GUT 全量 3150 测试线性泄漏 88MB→22.5GB→整机死机（11-12，多次复现） | D6 分片后单片仍 7.5GB 峰值，无上限 |
| **多实例并发叠加** | 双会话并行 B 侧 8 实例齐起——A 侧窗口被挤崩+门禁偶发挂+ping 连错实例（11-22，**验收错位与资源竞争，非整机死机**；其归属可见性建议由反馈批 Task 4 承担，本机制治资源维度） | `GODOT_MCP_MAX_SESSIONS=4` 仅单 server 进程内，跨会话（多 server）无总闸 |
| **常驻泄漏积累** | 多会话各留 1-7GB 游戏进程无人回收 | 无空闲回收机制 |
| **零内存维度** | 全仓 `os.freemem()` 零命中 | spawn 前不看水位、spawn 后不看占用、registry 无内存足迹 |

## 2. 调研结论（两份报告要点，引用见调研底稿）

**MCP 生态全空白**（playwright-mcp / unity-mcp / tugcantopaloglu-godot-mcp / sc-lacanlale / Claude Code host 五方向核到源码级）：无内存准入、无 RSS 看门狗。可移植的是四类**生命周期**机制：Playwright 分级关闭链（优雅→有限等待→`taskkill /T /F` 杀树；二次触发强杀；30s 兜底）+ IdleTimer 空闲回收（默认 1h，仅自己启动的）；unity-mcp 注册表加固（PID 信任窗 6h + kill 前验身份）；超时+maxBuffer 全覆盖（16MB 基准）。

**跨领域成熟语义**（照抄参数语义，来源：Bazel/kubelet/Jest/Vitest/Docker/libuv 源码级核读）：
- **准入**＝Bazel 声明式预算闸：机器预算默认 `totalmem × 0.67`（其源码常数），每类 spawn 声明预估内存，「已声明占用 + 新需求 ≤ 预算」才放行；估计"very crude"不要紧——**字节闸才是目的，计数闸挡不住 22.5GB**
- **看门狗**＝kubelet 三层：软阈值（低压持续→上报状态+拒新，保留在跑）→ 硬阈值（0s 宽限杀）→ 驱逐排序（超声明预算最多者优先杀）；配套 10s 采样 / 5m 状态去抖 / minimum-reclaim（一次杀够本防连环杀）
- **检查点**＝Jest `workerIdleMemoryLimit`：任务边界采样+回收（不打断运行中）；阈值**必须绝对字节数**（百分比在内存读数失真环境翻车，Jest 有前科）
- **Windows 硬约束**：采样走 `Get-CimInstance`（Win11 24H2 wmic 已移除）；水位双口径（`os.freemem()` 物理口径偏保守 + commit 口径 `CommitLimit−CommitTotal`，kubelet Windows 节点同款）；`process.constrainedMemory()` Windows 恒 0 禁用；**退出码不可归因 OOM**（137 是 Linux 语义），只能主动采样；杀＝`taskkill /T /F` 直接杀（Vitest 官方结论：进程回收便宜，勿做优雅等待）
- **反模式禁令**（Docker 官方警告）：任何「豁免不被杀」的配置必须同时有硬上限，否则等于把整机死机留作兜底

## 3. 设计：四层机制

### L0 生命周期基础层（治「常驻泄漏积累」）

- **IdleTimer 空闲回收**（Playwright 模式）：非 preview 游戏会话无 bridge 交互 N 分钟（默认 15min，env `GODOT_MCP_SESSION_IDLE_MINUTES`，0=关）自动走既有 kill 链回收；每次 bridge 查询/输入 poke 续命。**preview=true 会话豁免**（窗口是给用户看的，用户关窗即结束——core.md preview 语义）。
- **退出 watchdog**（Playwright `setupExitWatchdog` 模式）：server 进程退出（stdin close=宿主断连/SIGINT/SIGTERM）→ 回收全部本 server spawn 的非 preview 会话 + 二次触发立即强杀 + 30s 兜底 `process.exit`。
- **spawn 点超时+maxBuffer 自查**：全部 `execFile/spawn` 点位显式 timeout+maxBuffer（16MB 基准），消灭无超时挂死积累。
- 基础已有：`taskkill /F /T` 树杀（`process-state.ts:30/:78`）已在位，L0 主要是补 IdleTimer+退出链。

### L1 准入控制（治「多实例叠开」）——Bazel 声明式预算闸

**七处 Godot spawn 点前置同一个守门函数** `admitSpawn(kind, projectPath)`（审查 F1 修正：「两个漏斗」实为七处，全部点名）：

| # | spawn 点 | kind |
|---|---------|------|
| 1 | `src/tools/runtime.ts:450` `runGutProcess`（run_tests 分片 :526/单片 :727 两路径共用——**主炸弹所在链，与 executor 无关**） | `gut_shard` |
| 2 | `src/gdscript-executor.ts:905` + `src/core/headless-process.ts:18`（execute_gdscript 等短命 headless） | `headless` |
| 3 | `src/tools/spawn-helper.ts:46` `spawnGodot`（validation/workflow/scene/batch/android 五模块共用） | `headless` |
| 4 | `src/screenshot.ts:79`（截图捕获） | `headless` |
| 5 | `src/tools/runtime.ts` run_project（长命游戏会话） | `game_window` |
| 6 | `src/tools/runtime.ts:579` launch_editor（工具层） | `editor`（豁免检查必记账） |
| 7 | `src/GodotServer.ts:687`（Web GUI 面板「编辑」按钮，launch_editor 链复刻——与 #6 同语义两入口都要接） | `editor`（同上） |

- editor **纳入记账、豁免检查**（用户显式要开编辑器，拒绝体验极差；但记账让后续 spawn 看到真实占用）

**三查（全部通过才放行）**：
1. **水位查**：`os.freemem()`（物理）与 commit 余量（`Get-CimInstance Win32_OperatingSystem` 的 **`FreeVirtualMemory`**——= CommitLimit−CommitTotal 语义；~~FreeSpaceInPagingFiles~~ 只反映页文件空闲不含 RAM 承载 commit，固定/关闭 pagefile 机器上恒低会误拒，审查 F3 修正）均 ≥ 保留水位（默认 3GB，env `GODOT_MCP_MIN_FREE_MB`）；`commitTotalBytes` 取 `TotalVirtualMemorySize`
2. **预算查**：机器级「**Σ max(declaredMB, 实测RSS MB)** + 本类声明值 ≤ totalmem × 0.67」（env `GODOT_MCP_MEM_BUDGET_PCT` 覆盖）——max 取大防声明低估失效（审查设计层修正：32GB 机 game 声明 3GB 允许 7 会话，实测最坏 49GB 任一杀线前整机先死；RSS 用采样缓存，无读数的租约退 declared）
3. **计数查**：机器级 Godot 进程总数（registry 心跳 + tasklist 兜底扫描）≤ 上限（默认 8，env `GODOT_MCP_MAX_MACHINE_INSTANCES`）

**拒绝语义（已拍板）**：快失败——错误信息含当前占用清单（pid/项目/声明值/实测 RSS）+ 可操作建议（stop_project / 等待 / 调 env 豁免 `GODOT_MCP_MEMORY_GUARD=0`）。错误码进 `src/core/error-codes.ts` 注册表（MEMGUARD_LOW_WATER/BUDGET/INSTANCE_CAP `retryable:true`——释放后重试可过；MEM_BUDGET_EXCEEDED `retryable:false`——run 本身已死），禁用未注册码（兜底 retryable=false 与「稍后重试」文案自相矛盾，审查制度项）。

**跨 server 协调**：机器预算记账走 machine registry 同级新文件 `~/.godot-mcp/memory-leases.json`——**写前 `ensureDir` 自建目录**（`~/.godot-mcp` 会被 `uninstall --purge` 整删，不能假设存在；writeFileAtomic 不建父目录，审查 F4）+ **读写失败 fail-open**（guard 层文件故障降级放行+日志一行 `MEMGUARD degraded: lease-store unavailable`——防死机机制自己弄死工作流是本末倒置，降级日志可 grep）；每个 server 启动时登记自己的声明占用，心跳维持；无全局锁（每个 spawn 前重读+写回自己的份额，竞态窗口 ≤ 秒级，准入是保险丝不是精确配额——Bazel 自己也承认 crude）。

**声明档位表（初值，env 可逐类覆盖，首版后按实测调）**：

| kind | 声明值 | 依据 |
|------|--------|------|
| headless 短命（execute/validate/screenshot） | 1GB | 短命进程典型占用 |
| GUT 测试片（run_tests 单片） | 8GB | CardGame2 分片实测 7.5GB 峰值 |
| 带窗口游戏会话（run_project） | 3GB | 实测 1-7GB 取中位偏上 |
| 编辑器（launch_editor） | 4GB | Godot 编辑器典型 2-4GB |

### L2 内存看门狗（治「单进程炸弹 + 整机压力」）——kubelet 三层映射

- **采样**：10s 周期（env `GODOT_MCP_MEM_POLL_SECONDS`，下限 5s——每次采样有 PowerShell 进程开销）；采集=整机双口径水位 + 本 server spawn 全部 PID 的 WorkingSet（`Get-CimInstance Win32_Process`，结果缓存 10s 供准入复用）。
- **单进程预算**：某 spawn 进程实测 RSS > 声明值 × 2 → 直接杀（治 22.5GB 炸弹：GUT 声明 8GB，16GB 处被杀，机器活）；杀后向等待中的工具调用抛明确 `MEM_BUDGET_EXCEEDED` 错误（含峰值曲线最后读数）。
- **整机软阈值**：双口径任一 < 3GB 持续 30s → 进 `memory_pressure` 状态（doctor / godot_get_context 上报）+ 准入全拒（错误注明 pressure）+ **保留在跑任务**。
- **整机硬阈值**：双口径任一 < 1.5GB → 立即驱逐：**驱逐排序**＝本 server spawn 集合内「实测 RSS ÷ 声明值」最大者优先杀，杀到脱离硬阈值+minimum-reclaim 余量（一次杀够 2GB 防 1.5GB 边缘反复杀）；外部进程（用户手开）**永不杀**。
- **状态去抖**：pressure 状态翻转需保持 5min（kubelet `eviction-pressure-transition-period` 同款）。
- **豁免规则（Docker 反模式禁令合规）**：preview 会话与编辑器**不豁免记账**（L1 已计入）但**驱逐排序最后**；若 env 显式 `GODOT_MCP_WATCHDOG_EXEMPT=preview,editor` 全豁免，则同时强制它们的单进程硬帽（声明 × 3）仍生效——无上限豁免被禁令禁止。

### L3 可观测性

- `doctor` + `godot_get_context` 附内存面板：双口径水位 / 预算与已声明占用 / pressure 状态 / 活跃实例表（pid / 项目 / kind / 声明 / 实测 RSS / 最后交互）——实例 RSS 由 TS 侧按 registry 已有 pid 做 WMI 采样，不动 GD 心跳（§5 降本裁定）。
- 每次拒绝/驱逐/回收的错误与日志一行结构化摘要（可 grep `MEMGUARD`）。

## 4. 边界与不做

- **责任边界**：只对**本 server spawn 的进程**行使杀权；外部 Godot（用户手开编辑器/游戏）只在准入计数中避让，永不杀。整机被用户自己的 20 个编辑器干爆不在本机制责任面。
- **不是 cgroup**：无内核级强制，采样窗口（10s）内秒级暴涨仍可能来不及——硬阈值因此设得比直觉早（GB 级），且 L1 准入在源头限流。
- **不引新依赖**：采样零依赖自写（复用 `orphan-cleanup.ts:102` 的 PowerShell spawn 模式），不引 systeminformation/pidusage。
- **CI 连跑场景**：`GODOT_MCP_MEMORY_GUARD=0` 一键全关（对标 `GODOT_MCP_BRIDGE_DISABLE` 先例）。

## 5. 裁定点（已拍板 2026-11-22；④⑤ 为审查后追加）

| # | 问题 | 裁定 | 备注 |
|---|------|------|------|
| ① | 准入不足时：快拒绝 or 排队？ | **快拒绝** | MCP 调用层 30s 硬超时实证在案；拒绝时附占用清单+可操作建议 |
| ② | 非 preview 会话空闲回收默认值 | **15min** | `GODOT_MCP_SESSION_IDLE_MINUTES` 可调，0=关；preview 窗口豁免（二期；`RunSession`（process-state.ts:143-153）现无 preview 字段，二期 Task 1 显式补——审查二期前置） |
| ③ | 实施切分 | **两期** | 一期＝L1 准入三查+L2 单进程预算杀（最小防死机核心）；二期＝IdleTimer+整机软/硬阈值+L0 退出链+L3 面板。计划：`docs/superpowers/plans/2026-11-22-memory-guard-phase1.md` / `2026-11-22-memory-guard-phase2.md` |
| ④ | 租约存储故障语义 | **fail-open** | 文件读写失败降级放行 + `MEMGUARD degraded` 日志一行（guard 不阻断工作流）；目录写前 `ensureDir` 自建（`~/.godot-mcp` 会被 `uninstall --purge` 整删，writeFileAtomic 不建父目录——审查 F4） |
| ⑤ | 与反馈批 20261122 的合并顺序 | **本一期先落（0.38.2），反馈批后落（0.38.3）**（2026-11-22 用户授权执行方裁定翻转：guard 缺位期间任何批次执行都在死机风险敞口内，含反馈批自身的真机验证步骤） | 两批同改 `runtime.ts` 先停旧段与 `mcp_bridge.gd`——后落者 rebase 消解；冲突面两个方向对称 |

**单进程杀系数补充裁定**：`headless`/`gut_shard` 杀线=声明×2（治炸弹，GUT 8GB 声明→16GB 杀）；`game_window`/`editor` 杀线=声明×3（合法重会话余量，游戏实测可至 7GB——3GB 声明×3=9GB 不误杀）。

**模块归属（审查二期循环依赖修正）**：pressure 状态机落 `memory-guard.ts`（唯一写者），watchdog 只消费 `getPressureState()`——避免一期 watchdog→memory-guard、二期反向成环。

**L3 实现降本（审查裁定采纳）**：registry `memBytes` 不动 GD 心跳——TS 侧按 registry 已有 pid 做 WMI 采样即可（省心跳字段与 schema 变更）。**顺手修既有缺陷**：`get-context.ts:301-305` 读 `result.static_mem` 但 `_cmd_get_performance`（`mcp_bridge.gd:2983-2990`）只返 fps 等 5 项不含 `static_mem` → performance 恒 null——GD 侧补 1 行 `"static_mem": Performance.get_monitor(Performance.MEMORY_STATIC)`（`BRIDGE_SCRIPT_VERSION` 由 `npm run version-sync` 自动同步 `package.json` 版本，见 scripts/version-sync.mjs:89-122，无手动 bump）。
