# memory-guard 四期设计独立审查（采样落盘 + 档位回看判定标准）

- **日期**：2026-11-23
- **审查对象**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-23-memory-guard-p4-design.md`（状态：待用户批准）
- **审查方式**：逐条 `file:line` 静态核对（read/grep）+ 仓库级约束与既有通道核对（`package.json`、`README.md`、`CHANGELOG.md`、`.claude/rules/`、`test/regression/defects.ts`、`.git/logs/HEAD`、`docs/superpowers/plans/` 与既有三份 review）。下文的 `design:NN` 均指审查对象的行号。
- **本次限制（诚实声明）**：本会话 shell 被 Windows 沙箱 ACL 授权故障阻断（`pwsh` 全部拒绝执行，报 `windows-acl workspace grant failed`），**未能实跑** `git log`、`npm run lint/build/test`、vitest 与任何 Node 脚本。因此：可静态定谳的（文件/行号/常量/门禁脚本/既有约定）给实测结论；`git` commit 以 `.git/logs/HEAD` 文本核对；行宽/保留天数/采样量为**按 schema 与常量推算的公式估算**，不冒充实测值。shell 故障与 `docs/reviews/2026-11-22-memory-guard-design-review.md:9` 所记同一环境问题。

---

## 0. 总体判定

| 维度 | 判定 | 一句话 |
|---|---|---|
| 方向与边界 | **PASS** | 事件驱动、fail-open、只观察不改档、不做遥测/自动调档，定位正确；复用看门狗既有 10s RSS 采样缓存也是对的 |
| 判定标准表（spec 核心） | **BLOCKING** | #5 结构性不可触发；#2 按 rss_sample 口径右删失后同样近乎不可触发；#6 分母口径与"软硬间距"语义不符；表与"聚合口径"节互相矛盾 |
| 事件 schema | **BLOCKING** | 缺 `serverPid`/`leaseId`/事件时刻阈值；`spawn_ok` 是"准入成功"不是"进程起来"；`evict` 专有字段与代码不符 |
| 采样通道与保留 | **BLOCKING** | 60s + N=6 计数对短命 headless 产 0 样本（恰是档位校准最缺的类）；N=6≈60s 仅默认轮询间隔成立；16MB 保留窗口与"持续两周"判据不自洽；旋转重复造轮子 |
| 既有通道一致性 | **BLOCKING** | 仓库已有 JSONL append+轮转（含跨进程锁）与 `machine-audit.jsonl`，且 CHANGELOG 明确挂账"杀事件入 JSONL 审计通道"并裁定"不制造第三种形态"——本设计未引用、另起炉灶 |
| 仓库级流程约束 | **PARTIAL** | 版本 bump、规则双副本、README env 行、defects 基线在列；`docs/reviews` 审查、memory 登记、覆盖率门禁、`STRICT=1 check:rules-sync`、`[Unreleased]` 保留、绝对路径均缺 |
| 文档准确性 | **PARTIAL** | "README 内存治理段"不存在；"唯一挂账的四期候选"不实；"待裁定"节不存在；"两切换""unref 语义""与租约账本同风格"等技术表述有误 |

**结论：不建议按现稿批准。** 修完 §2 的 B1–B5 后可以批准（都属于"改 spec 文本/schema 即可，不需要先写代码"的层次）；§3 的 Important 项应写进计划，不得留到实现时即兴决定。

---

## 1. 事实核验

### 1.1 引用命中（PASS）

| 设计声明 | 实测 | 结论 |
|---|---|---|
| `KILL_FACTOR`：headless/gut_shard ×2、game_window/editor ×3 | `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts:46-48` | ✅ 逐值一致 |
| `PRESSURE_RECOVER_MS`=5min 为源码常量 | `src\core\memory-guard.ts:315`（模块私有，未导出） | ✅ |
| `DenialCode` 三值 `MEMGUARD_LOW_WATER`/`MEMGUARD_BUDGET`/`MEMGUARD_INSTANCE_CAP` | `src\core\memory-guard.ts:541` | ✅ |
| 准入门在同一函数、`spawn_ok` 时 `pid` 尚为 null | `src\core\memory-guard.ts:641-750`（租约返回时 `pid: null`）、`:754-761`（spawn 后 `bindLeasePid`） | ✅ 设计对时序的描述正确 |
| `IdleTimer` 一次回收的存活时长源 `RunSession.processStartTime` | `src\core\process-state.ts:143-155`（字段在）、`src\core\session-idle-timer.ts:60-86`（回收路径） | ✅ 字段存在（但见 M3 的取值时序坑） |
| 看门狗默认 10s 轮询、可调 5–3600s | `src\core\mem-watchdog.ts:72-78` | ✅ |
| 看门狗 10s 缓存 RSS 与准入共享 | `src\core\memory-guard.ts:189-207`、`:592`、`mem-watchdog.ts:108-114` | ✅ 无需二次 PowerShell |
| 非 Windows 无 RSS 通道（`{}` 降级） | `src\core\memory-guard.ts:209-230` | ✅（但设计未声明影响，见 M5） |
| 总开关关闭走 dummy 租约、零落盘 | `src\core\memory-guard.ts:646-660`、`:773-779` | ✅ |
| 版本 0.40.1、HEAD=`e90c476b`、三期基线 `9cac529b` 均存在 | `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\package.json:3`；`.git\logs\HEAD:2871-2874`（`9cac529b` 在、`e90c476b` 为末行 HEAD，提交信息即 0.40.1 清债批） | ✅ |
| `lint 533` 基线 | `package.json:41` | ✅ |
| `module-level-mutable-state` 当前基线 | `test\regression\defects.ts:1676-1681`（`baseline: 110`） | ✅（设计只写 +N，未给当前值） |
| 规则双副本「内存治理」段存在 | `src\tools\rule-templates.ts:139-147`、`.claude\rules\godot-mcp-core.md:125-133` | ✅ 两处都在，设计"补采样语义"可落地 |
| 仓库已有 JSONL append + 链式轮转 + 跨进程轮转锁 | `src\core\audit-log.ts:140-175`（append）、`:177-236`（rotate，10MB/保留 3 代/pid 锁）；`machine-audit.jsonl` 在 `:484-493` | ✅（设计未引用，见 B5） |
| `~/.godot-mcp/` 会被 `uninstall --purge` 整删 | `src\cli\uninstall.ts:333-351` | ✅ 新文件天然在清理面内 |
| 测试全局 `GODOT_MCP_MEMORY_GUARD=0` | `test\setup.js:33-38`；另有 audit/registry 目录隔离先例 `:12-31` | ✅（新写盘点的隔离须照此办，见 I1） |

### 1.2 事实错误 / 失真（FAIL）

| # | 设计声明 | 实测 | 严重度 |
|---|---|---|---|
| F1 | 判定标准落档："本设计文档 + README 内存治理段引用"（design:100） | `README.md` **没有**「内存治理」小节；grep 命中只有 env 表行 `README.md:726-735` 与版本表 `:906-908`。真正的「内存治理」段在规则副本（`src\tools\rule-templates.ts:139-147` 分布式模板 + `.claude\rules\godot-mcp-core.md:125-133` 仓库自用副本），不是 README | 高 |
| F2 | "档位回看是**唯一**挂账的四期候选"（design:7） | `CHANGELOG.md:9` 的 `[Unreleased]` 明确挂账四项：租约互斥、**杀事件入 JSONL 审计通道（T3-M-3）**、killPidTree promise 化、blender 档位；`docs/superpowers/plans/2026-11-22-memory-guard-phase3.md:21` 也把"档位回看"与"JSONL 审计"并列为排除项 | 高（动机层） |
| F3 | #2/#5 仍写"是否 env 化**待裁定**，见'待裁定'节"（design:88、:91-92） | 同文 `:96-98` 已写"已裁定（2026-11-23 用户确认）：PRESSURE_RECOVER_MS 与 KILL_FACTOR **不随四期 env 化**"；全文**没有**"待裁定"节，`design:57` 的"见'约束'段"也未在约束段（`:30-36`）提到快照例外 | 中（自相矛盾） |
| F4 | "8MB（约 6-8 万行）"（design:79） | 按 schema 每行含 `ts/v/event/kind/project/pid/declaredMB/machine{3}/pressure`，最短也 >200 B（project 40–60 字符时约 250–300 B）；8MB/70k≈120 B/行，**高估 2–3 倍**，实际约 2.5–3.5 万行 | 中（保留推算基础错） |
| F5 | "每 N 次 poll（默认 N=6，**约 60s**）"（design:69） | `pollIntervalSeconds()` 默认 10s 但 clamp 5–3600（`mem-watchdog.ts:72-78`）：5s 时 30s/次，60s 时 6min/次，300s 时 30min/次；"压力态加密到每轮"在 300s 时变成半小时一行 | 中 |
| F6 | "updatePressureState **两切换**"（design:108） | 实际 4 处切换：hard→pressure `memory-guard.ts:372-381`、任意→hard `:388-400`、normal→pressure `:412-422`、pressure→normal `:427-439`。只接"两切换"会漏 hard→pressure 降级与 hard 直进 | 中（会漏事件） |
| F7 | "appendFile 即发即忘 + **unref 语义**"（design:36） | `fs.promises.appendFile` 没有 `unref`；未完成的 fs 请求在 libuv 线程池里自然保持事件循环，不能像 timer 一样 unref。更关键的是**必须挂 `.catch()`**：Node 20 下未处理的 Promise rejection 会终止进程，恰好违反"绝不因采样炸 spawn/驱逐路径" | 高（非功能承诺失真） |
| F8 | "写盘单点：与**租约账本同风格**（…append 语义）"（design:32） | 租约账本是全量重写 + `writeFileAtomic`（`memory-guard.ts:259-271`），不是 append；真正的 append+轮转先例是 `audit-log.ts:140-236`。设计把两种既有形态混成一句 | 中 |
| F9 | "doctor 附属只读命令：`node scripts/memguard-review.mjs`（npm script）"（design:104） | `doctor` 是 CLI 子命令（`src\cli\doctor.ts`）；`scripts/` 虽进 npm 包（`package.json:32`），但**依赖包的 npm scripts 不会出现在消费者项目里**，安装用户只能手敲 `node node_modules/godot-mcp-enhanced/scripts/memguard-review.mjs`。要么做成 CLI 子命令，要么别叫"doctor 附属" | 中（部署面） |

---

## 2. Blocking Issues（批准前必改）

### B1　判定表有 2 条判据按设计口径不可触发，#6 口径还会系统性稀释

**证据**

1. **#5 结构性死亡**：`to:'normal'` 只能在 `pressure` 态、且 `_recoverSince` 连续 **5min** 健康后发生（`src\core\memory-guard.ts:313-315`、`:427-439`）；hard 态脱离也只降到 `pressure`（`:372-381`），不直接回 normal。因此任何 `pressure_change(to:'normal')` 的压力期时长**必 ≥5min**，"5min 内 exit 占比 >50%"恒为 0。
2. **#5 的备选口径也不对**：`design:75` 把分子写成"`to:'normal'` 行"、分母写成"全部 pressure_change 行"——这不是"5min 内"的测度，而是"恢复占比"；在健康机器上恢复占比本来就可以 >50%，会把正常恢复误判成"阈值边界抖动"。
3. **#2 右删失**：单进程超 `declared×KILL_FACTOR` 会被看门狗在同一轮杀掉（`mem-watchdog.ts:125-132`）；设计**没有规定在 kill 轮补一行 `rss_sample`**，能确定进入持久档的超线实测读数只有 `budget_kill.rssBytes`（`mem-watchdog.ts:203-216`）。按设计的聚合口径（只用 `rss_sample` 的每进程 max），被杀进程留下的采样最大值通常**低于**杀线，于是"某档 P95(rss) > declared×KILL_FACTOR"对存活进程几乎永远不成立——判据只能靠 `budget_kill.rssBytes` 才能触发，设计两处都没写这个数据源。
4. **#6 分母**：`design:75` 的分母"全部 pressure_change 行"同时包含进入与退出；一次完整压力期通常产生"进 pressure + 出 normal"两行，会把进入 hard 的占比压到 50% 以下；且 `from:'pressure' → to:'hard'` 是"升级"，不是"直进"，与建议动作"SOFT/HARD 间距拉开"的语义都对不上。
5. **#5 建议动作也指错旋钮**：能防 hard 边缘反复杀的是 `HARD_MIN_RECLAIM_MB`（`memory-guard.ts:319`、退出线 `:369-370`）或 HARD 阈值；`PRESSURE_RECOVER_MS` 只控制 pressure→normal，与 hard 抖动无关。

**后果**：四期交付物的一半（"判定标准 spec"）里，2/8 条判据永远不会命中，1/8 条会在正常情况下误报。工具照表实现后，"命中/未命中/数据不足"三态里前两条恒为"未命中"，等于把"拍脑袋"换成了"假阴性/假阳性"。

**修法（建议直接改表）**

- #2 明确数据源：每进程 `max(rss_sample.rssBytes, budget_kill.rssBytes)`；并在表头注明"被 kill 的观测是峰值证据，rss_sample 是右删失下界"。
- #5 重写为可算的抖动指标，三选一（推荐 a+b）：
  - a. **hard 抖动**：`hard→pressure` 降级后 10min 内再次 `→hard` 的次数 / `hard` 进入次数 > 30%；
  - b. **短压力期**：`pressure` 进入→离开的中位时长 < `PRESSURE_RECOVER_MS` 的占比（**注意**：离开 normal 必 ≥5min，所以要把"离开"定义为 `to:'pressure'` 的 hard 降级或 `to:'normal'` 的最终恢复，并明确口径）；
  - c. 同一次压力期内 `pressure_change` 行数中位数 > 2（频繁在 pressure/hard 间切换）。
- #6 分母改为"`pressure`/`hard` **进入**行"，或按"压力期"为单位（每期是否升级到 hard），并在表中写清"直进"仅指 `from:'normal' → to:'hard'`、升级另计。
- 所有判据的"天"统一为"**有数据的观察窗**"（首个事件至末个事件的并集天数），不是日历天；否则短跑一次会算出 24 倍频次。

### B2　事件 schema 缺"状态机身份"：单机共享文件 + per-process 状态机会算出伪比率

**证据**

- `PressureState` 是**进程内模块级状态**（`src\core\memory-guard.ts:321-324`），每个 MCP server 进程各有一份，由各自的 watchdog 每 10s 喂快照推进（`mem-watchdog.ts:107`、`:155`）。多个 server 同时写同一个 `memguard-events.jsonl` 时，`pressure_change` 行来自**互相独立的时序**（A 可能 pressure、B 同时 normal），而设计把文件定位为"机器级单文件"（design:43）却**没有 `serverPid` 字段**，也没有"进程重启即状态归 normal"的边界事件。
- 设计也承认跨 server 双写（design:32），但只考虑了"交错行可接受"，没考虑"状态机不能混算"。
- `spawn_ok` 在 `acquireLease` 成功即记，`pid` 为 null（design:62），而 `rss_sample` 只带 `pid`；设计要求"按进程聚合"，但**没有 `leaseId`**。`MemLease.id` 本来存在（`memory-guard.ts:34-37`，形如 `p<serverPid>-<ts>-<seq>`，`:737-747`），完全可以在事件里带上。
- 14 天窗口内 Windows pid 会被复用；按 `pid` 聚合会把两个不同进程的 max 合并，P50/P95 失真。

**后果**：#5/#6 的"同一次压力期"无法从行序列重建；跨 server 混算会让比率无意义；重启后上一期"悬挂"没有结束行；#1/#2 的按进程分位在长窗口上不可靠。

**修法**

- 每行公共壳加 `serverPid`；新增 `server_start`（或 `guard_start`）事件：`{ts, v, event:'server_start', serverPid, pkgVersion, pressure:'normal', thresholds:{minFreeMB,budgetPct,maxInstances,softMB,hardMB}, declaredMB:{...}, killFactor:{...}, pollSeconds}`。分析端按 `serverPid` 分段，未闭合的 episode 丢弃或标 unresolved。
- `spawn_ok`/`rss_sample`/`budget_kill`/`evict`/`spawn_reject` 都带 `leaseId`（spawn 时租约已生成；kill 时 `lease.id` 在手）。`idle_reap` 可带反查到的 `leaseId`（`releaseGameWindowLeases` 已按 project 反查）。
- 阈值不再靠"分析时读当前 env"：要么随 `server_start` 落一份，要么在 `spawn_reject`/`pressure_change` 行内联当时生效的阈值。否则用户改过 `MIN_FREE_MB`/`SOFT_MB` 后，历史数据会被按今天的默认值判。

### B3　60s 采样 + N=6 计数会让短命 headless 档 0 样本；采样峰值本身是下界

**证据**

- 设计：watchdog 每 N 次 poll（N=6）对每个活跃租约落一行 `rss_sample`（design:69）。默认 10s → 首次采样在 **第 60s**；`execute_gdscript`/`validate`/`screenshot` 这类 headless 作业通常几秒到几十秒结束（`gdscript-executor`/`screenshot` 漏斗），**整个生命周期拿不到一行 rss_sample**。
- 看门狗只对 `serverPid === process.pid` 且 `pid` 非 null 的租约采样（`mem-watchdog.ts:108-110`）；进程自然退出后也不会补最后一次采样（release 路径在漏斗里，不在 watchdog）。
- 于是"档位偏差（各 kind 声明 MB vs 实测 RSS 分布）"这一目标 #1，对**短命 headless**只能得到 `spawn_ok` 计数、没有 RSS 分布；而 headless 正是默认 1GB 档最需要校准的类。GUT shard 长、editor/game_window 长，反而数据最多——样本结构系统性偏向长活进程。
- 10s 采样得到的"每进程 max"只是真实峰值的下界；再叠加 B1 的 kill 右删失，P95 会更偏低。

**修法**

- **每个租约的首轮 poll 必采一次**（不论 N 计数），之后再按时间窗降频；
- 60s 改为**时间驱动**（`now - lastSampleAt >= 60000`），不用"N 次 poll"，否则 `GODOT_MCP_MEM_POLL_SECONDS` 一改就漂；
- 在 kill 路径（`killOverBudget`/`killForEviction`）**落 rss_sample 或用 kill 事件携带的读数**，并在分析端并入每进程 max（见 B1）；
- 对自然退出的短命进程，至少在漏斗的 `releaseLease` 处补一次"final rss"（可从 watchdog 最近一次 `rssMap` 取值，不需要再起 PowerShell）——如果实现成本高，至少在设计和 README 里诚实声明"短命 headless 档位校准数据不足"，并把触发条件改成按 kind 判定数据是否足够（而不是全局 30 进程）。

### B4　16MB 保留窗口与"持续两周"判据不自洽；轮转策略在并发/失败下不满足"体积有界"

**证据与推算**（按 250–300 B/行、1 行/分钟/租约）

- 8MB 主文件 + 8MB `.1` = 16MB；1 个常驻租约 ≈ 0.36–0.43 MB/天 → **16MB ≈ 40 租约·天**：1 租约约 40 天、2 租约约 20 天、**3 租约约 13 天（已不足两周）**、4 租约约 10 天。加上 spawn/reject/kill 行还会更短。
- 压力态"每轮落行"：10s → 8640 行/天/租约 ≈ 2.2–2.6 MB/天/租约；两个租约一天就 4–5 MB，16MB 只够 3–4 天。
- 因此 #8 "全档 P95(rss) < declared×0.5 **持续两周**"在常见多会话负载下**永远无法满足**，工具只会报"数据不足"；这不是数据积累问题，是保留策略与判据窗口未对齐。
- 轮转实现只保留 `.1`，且设计说"rename 覆盖旧 .1"；多 server 并发轮转、Windows 上 rename 与 append 的竞争、轮转失败只 warn 不重试，都会让"体积有界"退化。仓库既有 `rotateIfNeeded` 已经踩过并解决了这个问题：`audit-log.ts:189-236`（链式 .1→.2→.3、10MB、`<file>.lock` pid 锁、持有者存活则跳过、失败 best-effort）。设计没有引用它。

**修法（任选，推荐 a+b）**

- a. 保留窗口由判据反推：至少 14 天 × 峰值行速率；把上限提到 32MB/保留 4 代（与 audit 的 10MB×4 同量级），或对"存活 >1h 的租约"降频到 5min/次、并保留 `budget_kill` 全量；或落盘前按小时聚合（但会丢掉"每进程 max"，需要保留每进程的 max 摘要行）。
- b. **复用 `rotateIfNeeded`**（或抽出可参数化的同款实现）：链式代际 + 跨进程锁，保留 audit 已验证的锁/失败语义；若坚持 8MB/2 代，也至少用同一把锁，并显式记录"轮转失败后每 500 次重试"。
- c. 分析工具输出"数据覆盖窗（首事件~末事件、实际天数、每档进程数）"，并在 `< 14 天` 时明确报"窗口不足"而不是"未命中"；同时修正"6–8 万行"为按 schema 实测的行宽估算。

### B5　另起第三种 JSONL 通道，绕过仓库既有审计通道与已挂账的 T3-M-3 裁定

**证据**

- 仓库已有两条机器级 JSONL：项目/外置 `audit.jsonl`（`audit-log.ts:140-175`，带轮转）与 `~/.godot-mcp/machine-audit.jsonl`（`:484-493`，append 复用 `AuditEntry`，供同一套回放/统计工具消费）。
- `CHANGELOG.md:9` 的 `[Unreleased]` 明确挂账："**杀事件入 JSONL 审计通道**(Task 3 终审 deferred M-3)"。
- 一期终审 `docs/reviews/2026-11-22-memory-guard-p1-review.md:69` 对该项的裁定原文："留二期…**跨 server 杀可见性需随审计通道统一设计，单独改通道反而制造第三种形态**"。
- 三期计划 `docs/superpowers/plans/2026-11-22-memory-guard-phase3.md:21` 再次把"JSONL 审计"列为不进三期的 deferred。
- 本设计新建 `~/.godot-mcp/memguard-events.jsonl`，既未引用 `machine-audit.jsonl`，也未说明与 T3-M-3 的关系，等于把当时明确否决的"第三种形态"又造了一遍。

**后果**：同一台机器出现三份 JSONL（项目 audit / machine-audit / memguard-events），轮转策略、字段、消费工具各不相同；T3-M-3 的"跨 server 杀可见性"问题表面解决了、实际仍然分裂；未来读日志的人不知道该看哪份。

**修法（二选一，设计必须明写）**

- **A（推荐）复用审计通道**：kill/evict 事件写 `machine-audit.jsonl`（`appendMachineAuditLine` + 给该文件补 `rotateIfNeeded`），高频 rss_sample 仍可另落采样文件，但要在设计里说明"审计事件"与"采样时序"两条数据分的分工与 join 键（`leaseId/ts`）；同时在 CHANGELOG 把 T3-M-3 标为"四期随采样统一"。
- **B 保持独立文件**：明写"为什么 machine-audit 不适合（审计要等待写成功/字段是 AuditEntry/高频采样不能污染审计）"，但**轮转必须复用 `rotateIfNeeded` 的锁与代际语义**，并把 T3-M-3 在 `[Unreleased]` 中回标"四期部分收口/采样通道不等于审计通道"。

---

## 3. Important（应写进计划，不能留到实现时决定）

### I1　默认开 + 测试隔离：4 个已开守卫的测试文件会把样本写进真实 `~/.godot-mcp/`

`test/setup.js:33-38` 全局关守卫，但 `test/core/{memory-guard,mem-watchdog,session-idle-timer,exit-watchdog}.test.ts` 会在用例里 `stubEnv('GODOT_MCP_MEMORY_GUARD','1')`（grep 命中 6 处）。这些用例都会调用 `acquireLease`/杀路径，若采样默认开且路径无隔离，**每个开发者的真实 home 目录都会被测试写入**，且并发 worker 会互相追加。

设计只写"tmp 文件注入"（design:110），没有点名机制。仓库现成先例是 `GODOT_MCP_AUDIT_EXTERNAL_DIR`/`GODOT_MCP_BRIDGE_REGISTRY_DIR` 在 `test/setup.js:12-31` 统一重定向。建议：
- 给采样文件路径加 **env 覆盖**（如 `GODOT_MCP_MEM_SAMPLE_FILE`，默认 `~/.godot-mcp/memguard-events.jsonl`），在 `test/setup.js` 指向 `mkdtempSync`；
- 或至少在四个 guard-on 测试文件的 `beforeEach` 调 `_setSampleFilePathForTest(tmp)` 并在 `afterEach` 还原；
- 新增 `_resetForTest` 清理计数器/去重 warn/路径 override（同名模式已有 `_resetForTest`/`_setLeasesFilePathForTest`，`memory-guard.ts:959-976`）。

同时 `test/setup.js` 的全局关守卫意味着**采样路径在默认测试中零覆盖**；采样专属测试要显式开守卫 + 显式路径，且要测"守卫关 → 零写盘"。

### I2　判定标准的"落档位置"需要永久文档，README 没有可引用段

见 F1。当前唯一像样的规则段在规则双副本（`src\tools\rule-templates.ts:139-147` 分布式模板 + `.claude\rules\godot-mcp-core.md:125-133` 仓库自用副本）——模板会分发给所有目标 Godot 项目，把"维护者回看判据"塞进去不合适。建议：
- 新增 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\memory-guard-lookback.md`（或 `docs\guides\`），把 8 条判据、聚合口径、触发条件、分析工具用法固化；
- README 的 env 表/版本表附近加一句指向该文档的链接（README 目前没有"内存治理"小节，不要假装它存在）；
- 规则双副本只补**用户面**采样语义（开关/文件位置/关断），不要塞维护者回看流程。

### I3　分析工具的"可发现性"与测试面

- `scripts/` 虽进 npm 包（`package.json:32`），但**消费者不能 `npm run memguard:review`**（依赖包的 scripts 不生效）。如果目标用户/未来的维护者是安装用户，建议做成 `godot-mcp-enhanced doctor --memguard`（CLI 子命令）或 `npx godot-mcp-enhanced memguard:review`；如果只服务仓库维护者，就删掉"doctor 附属"的说法，README 写清 `node node_modules/.../scripts/memguard-review.mjs`。
- 设计测试面只列了采样单测，**没有一行提到 `memguard-review.mjs` 的测试**。这个脚本承载 8 条判据，是四期真正的"判定标准实现"，必须给它 golden fixture（构造含 spawn_ok/rss_sample/kill/pressure_change 的 JSONL，断言命中/未命中/数据不足三态；含坏行、`.1`、跨 server、pid 复用、短样本）。零依赖 `.mjs` 也能用 `node --test` 或 vitest 的 `node:child_process` 直跑。
- 常量漂移（KILL_FACTOR、PRESSURE_RECOVER_MS、默认阈值）目前只靠"scripts 内注释登记"（design:98）。仓库教训明确："plan 的安全命脉声明不能依赖实现者自律，必须有 defects.ts 检测兜底"（`docs/reviews/2026-08-06-p2-wave1-wave2.md`）。至少加一条单测：读 `src/core/mem-watchdog.ts` 的 `KILL_FACTOR` 与 mjs 里的表，**机械比对相等**；`PRESSURE_RECOVER_MS` 同理。

### I4　"延迟零感知"的三个反例：冷快照、appendFile 的 catch、idle 路径的缓存假设

- **冷快照**：`acquireLease` 在 `exemptChecks !== true` 时已经取过快照（`memory-guard.ts:663`），把这份 `snap` 直接传给 `memSample` 即可；但 **editor 的 `exemptChecks:true` 路径不取快照**（`runtime.ts:693`、`GodotServer.ts:711`），若事件统一要求 `machine`，`memSample` 会调用 `getMachineMemorySnapshot()`——缓存冷时是 **2 次同步 PowerShell，单次超时 5s**（`memory-guard.ts:99-113`、`:135-183`）。这会把 editor spawn 延迟最坏拉长 10s，恰好打在"延迟零感知"的承诺上。建议：`memSample` 接受 `snap?: MachineMemorySnapshot`，有则复用；editor 路径要么 `machine:null`（与 idle_reap 同款），要么只读缓存（新增 `cacheOnly` 选项，不触发新采样）。
- **appendFile**：必须 `void appendFile(...).catch(err => warnOnce(err))`；否则未处理 rejection 会崩进程（F7）。"unref 语义"删掉。
- **idle_reap 的 machine=null**：理由"回收关键路径不取快照"只在缓存冷时成立；watchdog 每 10s 喂快照，缓存通常 <10s，`getMachineMemorySnapshot()` 是纯命中。保留 null 可以，但理由要改成"idle 路径与 watchdog 解耦，不保证缓存新鲜，避免为一条采样引入 2 次 PowerShell"，并允许未来复用缓存快照。

### I5　schema 字段与缺失事件（按"能回答三个问题"逐项补）

| 缺口 | 为什么需要 | 建议 |
|---|---|---|
| 无"拒绝发生在第几查" | check⓪（pressure）与 check①（即时水位）共用 `MEMGUARD_LOW_WATER`（`memory-guard.ts:669-709`） | `spawn_reject` 加 `check: 0|1|2|3` + 当时阈值 |
| `machine` 缺 `godotProcCount`/`degraded` | #4 的实例计数、采样可信度都依赖 | 补两字段（或 `machine` 原样序列化快照，避免逐字段漂移） |
| 无 `spawn_failed` | `spawn_ok` 在 spawn 之前（B2），进程可能根本没起来；四个漏斗都在 spawn 失败路径 `releaseLease`（如 `spawn-helper.ts:73`、`gdscript-executor.ts:947`） | 要么把 `spawn_ok` 改名 `lease_acquired` 并在 `bindLeasePid` 另发 `spawn_started`；要么在失败 release 处补 `spawn_failed` |
| 无 watchdog 降级事件 | 连续 3 轮采样失败会退避（`mem-watchdog.ts:80-93`），这段时间 RSS 数据缺失；分析会把"缺数据"当"低 RSS" | `watchdog_degraded`/`watchdog_recovered` 事件，或至少每轮失败计数落行 |
| 无 exit-watchdog 回收 | 退出链也回收会话（`docs/superpowers/specs/2026-11-22-memory-guard-design.md:30`），与 idle_reap 是两种回收；目标 #2 说"空闲回收"但用户关客户端也会回收 | 加 `exit_reap`（或明写四期不含 exit 链） |
| `evict` 的"同上 + evictReason"与代码不符 | `killForEviction` 用 `ratio×declared` 反推字节（`mem-watchdog.ts:181-195`），没有 `killFactor`；reason 只有 hard 阈值一种，没有"hard-exhausted 等" | 字段改为 `declaredMB/rssBytes/ratio/reason:'hard'`；候选耗尽另发 `evict_exhausted`（带 `envExempted` 计数） |
| common `pressure` 在 `pressure_change` 行歧义 | 它等于 from 还是 to？ | 明写"after-state"，或对该事件省略，只用 from/to |

### I6　仓库流程收口缺失（计划里必须补齐）

AGENTS.md 的强制项在设计"留给 builder 的"段一个都没出现：
- `npm run lint` + `npm run build` + **`npx vitest run --coverage`**（76/67/80/77 不回退；三期计划 `:15` 明确写了的，本设计只写 lint 533）；
- `STRICT=1 npm run check:rules-sync`（改规则双副本后；三期计划 `:119` 有先例）+ `check:rules-version-bump`（0.41.0 bump 满足）；
- `STRICT=1 npm run check:changelog-sync`，`[Unreleased]` 保留 >50 字符实质内容（一期 design review `§5` 已踩过）；
- `docs/reviews/YYYY-MM-DD-<feature>.md` 独立审查文档（AGENTS.md §8 强制）；
- memory 登记（AGENTS.md"完成前必登 memory"）；
- **bump ≠ 发版**：0.41.0 只是规则模板门禁触发的版本演进，npm publish/tag/GitHub Release 仍待用户明确指令（AGENTS.md 2026-08-20 N-C）；
- 无工具面变更 → `capability-matrix` 不必重建（写明，免得 executor 顺手跑）；`verify_delivery` 不适用（非发版）；
- 文档一律绝对路径（本设计多处 `scripts/memguard-review.mjs`、`memory-guard.ts` 相对写法，与 AGENTS.md 路径规范不符）。

---

## 4. 中等与 Nits

| # | 位置 | 内容 |
|---|---|---|
| M1 | design:90 #4 | 默认 `MIN_FREE_MB=3072` 与 `PRESSURE_SOFT_MB=3072` 相等时，check① 只在跌破后的 30s 窗口内、pressure 尚未进入时命中；"LOW_WATER 且 pressure=normal"更像"瞬时毛刺"而非"水位线过紧"，建议动作除了下调 MIN_FREE，还应包含"评估去抖窗口/瞬时分配源"；用户自定义 SOFT<MIN_FREE 时该判据含义又变，需在表里注明前提 |
| M2 | design:89/92/94 | #3"同 kind 复发"与"≥1/天"字面矛盾（复发暗示多日）；#8"全档"未说"每 kind 独立"还是"四档合计"；#8 只看 P95 不看 max，降档前应同时约束 max < declared×0.8；P95 的算法（nearest-rank/线性插值）未定，n=30 时 P95≈max，需注明最小样本与算法 |
| M3 | `session-idle-timer.ts:79-82` | `clearRunSession` 之后才打既有日志；`clearRunSession` 会把 `processStartTime` 清 0（`process-state.ts:391-399`）。若 `memSample` 放在既有 console.error 旁，存活时长会恒为 0。必须先捕获 `s.processStartTime`（以及 `s.lastPokeAt`/`s.preview`）再清桶 |
| M4 | design:65 | `evict` 专有字段见 I5；另外 `budget_kill` 建议同时带 `budgetBytes = declaredMB×factor`，便于核对 |
| M5 | design:62 + `spawn-helper.ts:73` | `spawn_ok` 名不副实（准入成功≠进程启动）；建议改名 `lease_acquired`，或按 I5 在 `bindLeasePid` 处发 `spawn_started`；否则"每档 ≥30 进程"的分母包含 spawn 失败 |
| M6 | design:56 | 公共壳的 `pressure` 对 `pressure_change` 歧义（见 I5）；对 `idle_reap` 的 `kind` 实际恒为 `game_window`（IdleTimer 只扫 RunSession），写明免得分析端当通用字段 |
| M7 | design:34/45 | `GODOT_MCP_MEM_SAMPLE=0` 建议同时接受 `false`（与 `MEMORY_GUARD` 一致）；明确"实时读 env 还是缓存"（建议实时，与 `WATCHDOG_EXEMPT` 同法）；`MEM_SAMPLE=0` 时分析工具应报"采样关闭/数据过期"而不是"数据不足" |
| M8 | design:43 | 新文件权限：建议创建时 `mode:0o600`（对齐 `user-settings.ts` 的 settings 0600 先例），README 写明"本地文件、含项目路径/pid、如何关闭与删除"；`uninstall --purge` 已覆盖整目录（`uninstall.ts:333-351`），可写一句说明 |
| M9 | `memguard-review.mjs` | 需明确：坏行/半行跳过；`.1` 与主文件都读且按 ts 排序；未知 `event`/更高 `v` 忽略并计数；`--file` 便于测试；退出码（0=有结论/1=数据不足/2=读失败）；输出"最后事件距今"（采样被关时能看出来） |
| M10 | design 多处 | 文档精度：`design:108`"两切换"实为 4 处（见 F6）；`design:57`"见约束段"无此内容；`design:88/91` 引用不存在的"待裁定"节（F3）；`design:32`"与租约账本同风格"实为 append 与全量原子写两种形态（F8）；`design:79` 行数估算偏高（F4）；`design:104`"doctor 附属"不准确（F9）；`design:36`"unref"（F7）；全文相对路径（I6） |
| M11 | design:69/73 | `machine` 落在每条 `rss_sample` 上是冗余（10s 缓存的同一快照），建议只在 spawn/reject/pressure/kill 行带，rss_sample 只带 `declaredMB/rssBytes`，可省 20–30% 体积、缓解 B4 |
| M12 | design:52 | `ts` 是本地毫秒；跨时区/DST 的"按天"分析会漂。分析端按同一机器本地日期即可，但建议在 `server_start` 记录时区偏移（`tzOffsetMin`），或统一用 ISO+offset |
| N1 | design:46 | "fail-open 静默"与"stderr 一行去重 warn"措辞打架，建议统一为"fail-open；首次失败一行 warn，后续同因去重" |
| N2 | design:111 | 当前 `module-level-mutable-state` 基线是 **110**（`defects.ts:1681`），不是 533 那一套；计划里把新增变量逐个点名（`_sampleSeq`/`_sampleWarned`/`_samplePathOverride`/`_appendCount`/`_lastSizeCheck` 等），并同步 `_resetForTest` |
| N3 | design:69 | `N=6` 建议写成时间常量（如 `SAMPLE_INTERVAL_MS=60_000`），不要把"6 次 poll"当语义；否则改轮询间隔就把采样周期改坏 |
| N4 | design:79 | 轮转首次基线：进程启动时先 stat 一次当前 size；若已超限先轮转再 append（否则"500 次后检查"在已有大文件时形同虚设）；轮转失败要置"重试标志"而不是等下个 500 次 |
| N5 | design:43 | 文件名 `memguard-events.jsonl` 与既有 `memory-leases.json`/`machine-audit.jsonl` 风格不统一；要么 `memory-guard-events.jsonl`，要么在文档里说明 `memguard` 前缀对应日志前缀，避免读者以为是第三套命名 |
| N6 | design:111 | 新增 env 后建议在 `doctor` Memory guard 段加一行"sampling: on/off, file size, last event age"——否则用户遇到"数据不足"时无法自证采样是否在跑；不加则 README 必须给手工检查命令 |

---

## 5. 仓库级约束（AGENTS.md）覆盖核查

| 约束 | 设计覆盖 | 缺口 |
|---|---|---|
| 完成前 `lint`/`build`/`test` | 🔶 只写"lint 533" | 补 `npm run lint`、`npm run build`、`npx vitest run --coverage`（76/67/80/77） |
| 发版门禁 `verify_delivery` | ✅ 不适用（非发版） | 写明"0.41.0 bump ≠ 发版，publish/tag 待用户" |
| 改规则双副本 → `STRICT=1 npm run check:rules-sync` | 🔶 双副本在列 | 补命令与顺序（先 build 再 sync）；补 `check:rules-version-bump` |
| 规则模板变更强制 bump | ✅ 0.41.0 | ✅（记得 commit 顺序：规则与 bump 同笔，否则门禁拦） |
| CHANGELOG `[Unreleased]` >50 字符 + `check:changelog-sync` | 🔶 只写"CHANGELOG" | 补 `[Unreleased]` 保留；把 T3-M-3 回标 |
| README env 表新增行 | ✅ | 还需 README 的内存治理段/永久文档链接（F1） |
| `docs/reviews/YYYY-MM-DD-<feature>.md` 独立审查 | ❌ | 补到计划收口步骤 |
| 完成前 memory 登记 | ❌ | 补（feature-decision-log + lesson） |
| 绝对路径引用 | ❌ | 设计内多处相对路径 |
| 禁止新增模块级 setter 注入点 | 🔶 "tmp 文件注入"模糊 | 优先 env 覆盖（I1 方案 a），若走 `_set*ForTest` 需对齐存量测试钩子并登记 baseline |
| 不引新依赖 | ✅ | 零依赖 mjs 符合 |
| capability-matrix / tool 面 | ✅ 无工具变更 | 写明"不跑 build-matrix"，避免 executor 多跑 |
| CI 语义开关 | 🔶 未提 | 默认开采样会在 CI 真 server 跑时写 runner home；`test/setup.js` 需隔离（I1）。建议 CI 不强制 `MEMORY_GUARD=0`（否则 e2e 覆盖不到 guard），但采样文件指向 tmp |

---

## 6. 建议的修订（可直接抄进设计）

1. **重写 §5「回看判定标准」**：
   - 表头加"数据源/右删失/每进程聚合键（`leaseId`）/观察窗/最小样本/百分位算法"；
   - #2 数据源改为 `max(rss_sample.rssBytes, budget_kill.rssBytes)`，并注明被 kill 的观测是峰值证据；
   - #5 改为"hard 抖动率"或"压力期 episode 时长分布"，删掉"5min 内 exit 占比"与"PRESSURE_RECOVER_MS 延长"；
   - #6 分母改"进入行/压力期"，"直进"只算 `from:'normal'→to:'hard'`，升级另计；
   - #3/#4/#7 的"天"统一为"有数据观察窗的天"；
   - #8 加"每 kind 独立判定 + max 约束 + 数据覆盖率 ≥14 天（不足则报窗口不足）"。
2. **§ 事件 schema**：公共壳加 `serverPid`；新增 `server_start`（含阈值/版本/时区）；`leaseId` 贯穿 spawn/rss/kill/reject；`spawn_ok` 改名或补 `spawn_started`；`spawn_reject` 加 `check`；`machine` 沿用快照字段（含 `godotProcCount`/`degraded`）；`evict` 用 `ratio/rssBytes/reason`；补 `watchdog_degraded`、`exit_reap`、`evict_exhausted`（或明写不做）。
3. **§ RSS 采样**：首轮必采；60s 时间驱动；kill 轮落样本或用 kill RSS；压力态按"每轮"改为"每 max(interval, 10s)"；声明非 Windows 无 RSS → 档位回看 Windows-only；声明短命 headless 需 final sample/数据不足判定。
4. **§ 旋转**：窗口由 14 天反推（建议 4 代/32MB 或降频/日聚合）；复用 `rotateIfNeeded` 的锁与代际语义；首次 stat；轮转失败重试标志；修正行宽估算与并发说明。
5. **§ 与既有通道的关系**：在"约束/已定决策"里明写 `machine-audit.jsonl` / `audit-log.ts rotateIfNeeded` / T3-M-3 的处置（A 或 B 方案）；CHANGELOG `[Unreleased]` 回标。
6. **§ 开关与落盘**：`MEM_SAMPLE` 接受 `0/false`、实时读；默认开的理由、权限 0600、README 披露、`test/setup.js` 隔离；`_resetForTest` 清全部新状态。
7. **§ 回看工具**：改称 CLI 子命令或明确"仓库内运维脚本 + 安装包手敲路径"；加 `--file`/退出码/坏行容错/最后事件年龄；加 golden fixture 测试；加常量机械同步测试（KILL_FACTOR/PRESSURE_RECOVER_MS/默认阈值）。
8. **§ 落档位置**：新增 `docs/memory-guard-lookback.md`，README 加链接；规则双副本只写用户面采样语义。
9. **§ 留给 builder**：补 lint/build/coverage、`check:rules-sync`、`check:rules-version-bump`、`check:changelog-sync`、`docs/reviews/`、memory 登记、bump≠publish、绝对路径、`build-matrix` 不适用。
10. **§ 事实修正**：删"唯一挂账"、补 README 无段的现实、删"待裁定"引用、"两切换"改 4 处、删"unref"、改"与租约账本同风格"、改行数估算、改"doctor 附属"。

---

## 7. 值得进 memory 的工程教训

1. **判据表必须用状态机源码反推"可触发性"**：`PRESSURE_RECOVER_MS=5min` 让"5min 内恢复到 normal"恒不成立（`memory-guard.ts:313-315`、`:427-439`）——写判据前先把每个状态转移的前置条件代入一遍，否则会交付一整套"永不命中"的标准。
2. **右删失是监控判据的隐形杀手**：单进程超杀线即被移除，采样 max 是下界；"P95 > 杀线"这类判据必须消费 kill 事件的实测读数（`mem-watchdog.ts:203-216`），否则永远看不到尾巴。
3. **共享单机文件聚合前，先确认状态机是 per-process 还是 per-machine**：`PressureState` 是进程内单例（`memory-guard.ts:321-324`），跨 server 混算会把独立的时序当同一 episode；`serverPid` 不是可选字段。
4. **进程身份用 `leaseId`，不要用 `pid`**：14 天窗口下 Windows pid 复用会把两个进程合并；`spawn_ok` 时 `pid` 还是 null，只有 `leaseId` 能贯穿 spawn→rss→kill。
5. **保留窗口必须由判据窗口反推**：8MB×2 与"持续两周"是两条独立的数字，没做除法就会交付一个"判据永远数据不足"的工具；顺带，行宽估算要按 schema 实测，不能凭"6–8 万行"的直觉。
6. **新通道前先 grep 既有通道与 deferred 档**：`audit-log.ts:198-236` 已有锁+链式轮转，`[Unreleased]` 已挂 T3-M-3 且一期 review 明确"不制造第三种形态"（p1 review:69）——这两条任何一条先看到，都能省掉 B5。
7. **"注释登记漂移风险"不构成防线**：KILL_FACTOR/PRESSURE_RECOVER_MS 在零依赖 mjs 里复制，必须加机械比对测试（对齐 defects 体系"静态检测兜底"的既有纪律）。
8. **默认开的新写盘点必须同时设计测试隔离**：`test/setup.js:33-38` 关守卫只保护了"未开守卫"的测试，4 个 guard-on 测试文件会直接写真实 home；新增写盘点的第一件事是找 `GODOT_MCP_*_DIR` 先例做 tmp 重定向。

---

## 8. 结论

**BLOCKING（不建议按现稿批准；修完 B1–B5 后可批准）。**

- 设计的**方向正确**：事件驱动、纯观察面、fail-open、不做自动调档/遥测，与三期"不动治理行为"的边界一致；复用看门狗 10s RSS 缓存、按进程而非按行聚合（design:73）这两个判断尤其对。
- 但**判定标准表的核心三条**（#2 右删失、#5 结构性不可触发、#6 分母口径）会让"回看"从"拍脑袋"变成"假阴性/假阳性"；**schema 缺 serverPid/leaseId/阈值**使跨 server 与 14 天窗口的聚合不成立；**60s 采样让短命 headless 0 样本**，恰好缺的是档位校准最需要的类；**16MB 保留窗口 < 14 天判据**，使 #8 永远数据不足；**另起第三种 JSONL** 违反既有 deferred 裁定。
- B1–B5 都能在 spec 层修完（不需要先改代码）；I1–I6 应写进计划，特别是测试隔离（默认开 + 4 个 guard-on 测试文件）、永久文档落点、`check:rules-sync`/coverage/审查文档/memory 收口、常量机械同步、冷快照延迟。
- **本次未实跑任何命令**（shell 被 Windows 沙箱 ACL 故障阻断）；以上结论均为静态 `file:line` 核对与公式推算。修复落地后，复跑 `npm run lint && npm run build && npx vitest run --coverage`、`STRICT=1 npm run check:rules-sync`、`npm run check:rules-version-bump`、`STRICT=1 npm run check:changelog-sync` 是计划的硬门禁。
