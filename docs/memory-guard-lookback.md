# memory-guard 档位回看判定标准

> **真源链条**：设计文档 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-23-memory-guard-p4-design.md`（四期设计 v2）是源头 → **本文档是判定标准的永久落档**（按四期 Task 1–7 的已实现口径整理；设计文档字面与实现不一致处以本文档为准）→ 实现是只读分析工具 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\memguard-review.mjs`（聚合与判定）和采样单点 `memSample`（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`，数据生产）。
>
> 适用版本：0.41.0+。本文回答三个问题：**什么数据表现 → 触发什么调整动作 → 攒多少数据才动手**。工具只出建议、不自动调档——改 env 或源码常量是人的决策。

## 1. 数据从哪来

治理面有两条落盘通道，职责不同：**采样通道**是回看分析的主数据，**审计通道**给跨 server 的杀事件可见性。

### 1.1 采样通道（分析主数据）

| 项 | 口径 |
|---|---|
| 文件 | `~/.godot-mcp/memory-guard-events.jsonl`（`GODOT_MCP_MEM_SAMPLE_FILE` 覆盖路径） |
| 开关 | 默认开。`GODOT_MCP_MEMORY_GUARD=0` 或 `GODOT_MCP_MEM_SAMPLE=0/false` 任一成立即**零写盘**（文件不创建级别；`GODOT_MCP_MEM_SAMPLE` 的其余值与未设均视为开） |
| 权限 | 0600（仅文件首建时生效，已有文件不重设） |
| 内容 | 每行一个 JSON 事件；**含项目路径（`project`）与 pid** |
| 形态 | 事件驱动追加（治理事件发生时写一行），无轮询；写盘失败只 warn、不影响治理（fail-open）；同一进程内追加严格串行，行序 = 调用序 |
| 轮转 | 8MB/代 × 4 代（`.1`–`.4`，峰值 40MB）：首条写入前 stat 一次、每 500 次追加查一次大小、轮转失败下一条即重试 |
| 清空 | 删除文件即清空；`uninstall --purge` 清掉整个 `~/.godot-mcp/` 目录 |

**公共壳**：每行固定带 `ts`（本地毫秒）、`v`（schema 版本，当前 1）、`event`、`serverPid`（pressure 状态机是进程内单例，多 server 共写靠它分段）、`machine`（当时机器水位快照；无现成快照时为 `null`，绝不为此新起采样）、`pressure`（事件生效后的态）；`kind`/`project`/`leaseId`（贯穿 spawn→RSS→杀 的租约身份；拒绝行不带）/`pid` 四个身份键由调用方按事件传入，**并非每行都有**，在场情况见下表「身份键」列。两个例外：`rss_sample` 行无 `machine`，`pressure_change` 行无 `pressure`（只有 `from`/`to`）。

**事件清单**（13 个，全部进采样通道；「身份键」列只列在场的 `kind`/`project`/`leaseId`/`pid`，未列即无该键）：

| event | 触发点 | 身份键 | 专有字段 |
|---|---|---|---|
| `server_start` | server 进程首个事件落盘前（惰性首发，每进程一次） | 均无 | `pkgVersion`、`thresholds{minFreeMB,budgetPct,maxInstances,softMB,hardMB}`、`declaredMB`（四档）、`killFactor`（四档）、`pollSeconds`、`tzOffsetMin`——**历史数据按事件时刻阈值判定，不按分析时的当前 env** |
| `lease_acquired` | 准入成功（`acquireLease`） | `kind`、`project`、`leaseId`（**无 `pid` 键**） | `declaredMB`——准入成功≠进程起来 |
| `spawn_started` | 租约绑定 pid（spawn 成功后） | 四者齐全——`pid` 自此确立（进程身份确立点） | 无 |
| `spawn_reject` | 准入四查任一拒绝 | `kind`、`project`；**无 `leaseId` 键**；**无 `pid` 键** | `check`（⓪压力=`0` / ①水位=`1` / ②预算=`2` / ③实例=`3`）、`reason`（`MEMGUARD_LOW_WATER`/`MEMGUARD_BUDGET`/`MEMGUARD_INSTANCE_CAP`）、`thresholds`（查⓪ `{softMB}` / 查① `{minFreeMB}` / 查② `{budgetPct, usedMB}` / 查③ `{maxInstances}`）。⓪与①共用 LOW_WATER，`check` 是唯一区分 |
| `rss_sample` | 看门狗轮询策略采样 + 租约释放时的 final sample | 四者齐全 | `declaredMB`、`rssBytes`；无 `machine` |
| `budget_kill` | 单进程超预算杀（`killOverBudget`） | 四者齐全 | `declaredMB`、`rssBytes`（杀时读数）、`budgetBytes`（=声明×系数）、`killFactor` |
| `evict` | 硬阈值驱逐杀（`killForEviction`） | 四者齐全 | `declaredMB`、`rssBytes`（**推算值** = ratio×声明）、`ratio`、`reason:'hard'` |
| `evict_exhausted` | 驱逐候选耗尽仍处 hard | 均无 | `envExempted{preview,editor}` |
| `pressure_change` | pressure 状态机全部 4 处切换 | 均无 | `from`、`to`（normal→pressure / 任意→hard / hard→pressure 降级 / pressure→normal） |
| `watchdog_degraded` / `watchdog_recovered` | 连续 3 轮采样失败退避 / 降级后恢复的首轮 | 均无 | degraded 带 `consecutiveRounds` |
| `idle_reap` | IdleTimer 空闲回收 | `kind`（恒 `game_window`）、`project`、`pid`；**无 `leaseId`** | `aliveMs`（回收前捕获的存活毫秒）；`machine:null` |
| `exit_reap` | server 退出链回收 | 同 `idle_reap` | 同 `idle_reap`；`machine:null` |

**`rss_sample` 何时落**：首轮必采（租约绑定 pid 后首个拿到读数的轮询，不受节流——几秒结束的作业至少留一行）；此后时间驱动 60s 一行（非轮次计数，`GODOT_MCP_MEM_POLL_SECONDS` 改动不漂）；存活 >1h 的租约降频到 300s；pressure/hard 态收回 60s 档；租约释放时按 leaseId 取看门狗最近一轮读数补一行 final sample（零采样成本；**不依赖租约账本是否已被清理**——自然退出路径进程已死、租约多半已被读时清理移出账本，照样落行；快照读后即删，超 10 分钟无人释放的快照自动回收）。被杀进程的读数由 `budget_kill`/`evict` 行携带。**亚 10 秒进程仍可能只有 1 行样本**——数据够不够按 kind 判定，不够报「数据不足」不硬算。

### 1.2 审计通道（跨 server 杀可见性）

- 三类杀事件 `budget_kill`/`evict`/`evict_exhausted` 在采样行之外**同时**写 `~/.godot-mcp/machine-audit.jsonl`（清偿二期 Task 3 终审 deferred M-3）。
- 行形态：`trace_id: 'memguard'`、`tool: 'memory-guard'`、`action`（三类事件名）、`risk: 'process'`；`details` 含 leaseId/pid/kind/declaredMB/rssBytes，另带 `budgetBytes`（budget_kill）/ `ratio`（evict）/ `envExempted`（evict_exhausted，`project_path` 为空）。
- **不受 `GODOT_MCP_AUDIT` 开关控制**——机器级审计对启动/杀进程类事件的既有契约是「审计关闭仍留痕」。审计写失败只计数（`recordAuditWriteFailure`），kill 与采样不受影响。
- 该文件自 0.41.0 起有大小轮转：10MB × 3 代（此前只追加无轮转）。
- 分工：**分析以采样行为准**，审计行用于跨 server 交叉核对；审计行**同一进程内追加串行**（行序 = 调用序，并发追加不触发并发轮转），跨进程（多 server 共写）仍无序。

## 2. 聚合口径

| 口径 | 定义 |
|---|---|
| 进程 | = `leaseId`（**不是 pid**——长窗口内 Windows pid 会复用，同 pid 多 leaseId 分开聚合） |
| 每进程 RSS | = max(该进程全部 `rss_sample` / `budget_kill` / `evict` 行的 `rssBytes`)。被杀读数是峰值证据；存活样本是右删失下界 |
| 分位 | nearest-rank（升序，1 基秩 = ceil(p·n)）；**n<20 不计算分位，报样本不足**；n=30 时 P95≈max；n<40 时 P95 落在最大两个样本之内 |
| 比值 | 按各进程**自身**的 `declaredMB` 折算（历史数据按事件时刻档位；kind 内声明混合时也自洽）；ratio 分位按 ratio 自身升序取秩，MB 绝对值分位同时给出 |
| 观察窗 | `max(1, (末事件 ts − 首事件 ts) / 24h)` 天。不足 1 天按 1 天计（不折 24 倍频次）；≥1 天取小数，所以「≥14 天」是严格判定。所有「X/天」判据共用这个分母 |
| kind 覆盖窗 | 该 kind 的 `lease_acquired`/`spawn_started`/`rss_sample`/`budget_kill`/`evict` 五类行（且 `leaseId` 为字符串）的首末事件跨度（小数天，不设下限）；带 `kind` 的 `spawn_reject` 行不计——#8 的「≥14 天」用它 |
| spawn 失败数 | 无 `spawn_failed` 事件，按 kind 用 `lease_acquired − spawn_started` 差值推导（轮转窗可为负，钳 0） |
| pressure episode | 按 `serverPid` 分段重建（多 server 状态机独立时序不可混算）：首个进入行起、`to:'normal'` 行止。同一 serverPid 再见 `server_start` = pid 已被新 server 复用，此前未闭合段悬挂 |
| 悬挂 episode | server 退出前没有 `to:'normal'` 闭合行的段，计为 unresolved：**只从 #5b 的时长集合剔除**；它的切换行在 #5a 与 #6 里**照常计入**（这两条按行定义，未闭合只让时长不可知） |
| 直进 vs 升级 | `from:'normal'→to:'hard'` 是直进；`from:'pressure'→to:'hard'` 是升级——分别计数不合并 |
| 孤立闭合行 | 有 `to:'normal'` 却无进入行（进入行已被轮转掉），单独计数不进任何 episode |
| 历史阈值 | #4 的前提以 `server_start` 行的阈值快照为准；各档声明取各进程自身事件行的 `declaredMB`（见「比值」行），`server_start` 的 `declaredMB` 仅为展示快照；#2 的 KILL_FACTOR 用脚本硬编码，见第 5 节 |

## 3. 回看判定标准

**触发条件**（满足其一）：某 kind `spawn_started` ≥ 30 进程，或观察窗 ≥ 14 天。工具先输出覆盖窗（首末事件 / 实际天数 / 每档进程数）；不满足时报告首部明报「窗口不足，以下判定仅供参考」。

| # | 数据表现 | 判定 | 建议动作 |
|---|---|---|---|
| 1 | 某档 P50(进程max) > declared×1.0（n≥20） | 声明常态性低估 | 上调该档 `DECLARED_MB_<KIND>` 至 P50×1.2 取整 |
| 2 | 某档 P95(进程max, 含 kill 读数) > declared×KILL_FACTOR | 逼近硬帽误杀线（存活样本右删失，kill 读数是峰值证据） | 上调档位优先；KILL_FACTOR 为源码常量（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`）非 env——需改源码 |
| 3 | 同 kind 的 budget_kill 数 ÷ 观察窗天 ≥ 1 | 硬帽过紧 | 核对该档进程分布后上调档位 |
| 4 | spawn_reject(check=1, LOW_WATER) ≥3/观察窗天 且事件行 pressure='normal' | 瞬时水位毛刺偏频 | MIN_FREE_MB 下调 512MB 档评估 + 评估瞬时分配源（MIN_FREE=SOFT=3072 默认下此判据专捕 30s 去抖窗内的瞬时毛刺；SOFT<MIN_FREE 的自定义配置下含义不同，工具注明前提） |
| 5a | hard 抖动率：hard→pressure 降级后 10min 内再次 →hard 的次数 / hard 进入次数 >30% | 硬阈值边缘反复杀 | HARD_MIN_RECLAIM_MB（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts` 源码常量）或 HARD_MB 调整评估——PRESSURE_RECOVER_MS 只管 pressure→normal 与此无关 |
| 5b | 闭合 episode 中时长 <15min（恢复下限 5min 的 3 倍）的占比 >50% | 软阈值边缘抖动 | SOFT_MB 上调评估（pressure 恢复天然 ≥5min——「5min 内 exit」类判据结构性恒 0，禁用） |
| 6 | hard 直进（from:'normal'→to:'hard'）占**进入行**（from='normal' 的 pressure/hard 进入）比 >30% | 软硬间距过窄（升级另计不稀释分母） | SOFT_MB/HARD_MB 间距拉开（SOFT 上调优先） |
| 7 | idle_reap+exit_reap ≥5/观察窗天 | 会话常忘收 | 非档位问题——提示用户侧工作流（preview 模式/显式 stop），不调参 |
| 8 | **每 kind 独立**：P95(进程max) < declared×0.5 且 max(进程max) < declared×0.8，且该 kind 覆盖窗 ≥14 天 | 声明常态性高估（P95+max 双约束防单峰假象） | 下调该档释放预算空间 |

各条的口径细节：

- **#1/#2/#3/#8 按 kind 独立判定**（headless / gut_shard / game_window / editor 各出一态），顶层聚合态为「任一档命中即命中，否则任一档未命中即未命中，全不足即不足」。#4/#5a/#5b/#6/#7 是全局判定。
- **#3** 的触发条件只有字面的「同 kind 的 budget_kill 数 ÷ 观察窗天 ≥ 1」；括注的「同 kind 跨多日复发」**不是**触发条件，工具把它作为辅助信息列出（该 kind 出现 budget_kill 的不同本地日）。
- **#4** 的分子只数 `check=1` 且 `reason=MEMGUARD_LOW_WATER` 且事件行 `pressure='normal'` 的拒绝（pressure/hard 态的拒绝走查⓪，不计）。前提由 `server_start` 行阈值快照核对：全部 `minFreeMB === softMB` → 前提成立；存在不等的自定义配置 → 明报「含义不同」；窗口内无 `server_start` 行 → 「不可核」。
- **#5a** 的分母是全部 episode（闭合 + 悬挂）的 hard 进入次数（直进 + 升级）；分子是 `hard→pressure` 降级后 10min 内出现再升级行的次数。直进 hard 本身不贡献分子（分子需要先有一次降级），所以「normal→hard→pressure→normal」恒为 0%。
- **#5b** 只用闭合 episode：「时长 <15min 的 episode 占比 >50%」与「中位时长 <15min」同义。
- **#6** 的分母是全部 episode 的 `from='normal'` 进入行（经 pressure 进 + 直进）；升级（pressure→hard）另计，不进分母。
- **#7** 是两种回收路径之和：`idle_reap`（空闲回收）与 `exit_reap`（退出链回收）。

**三态**：每条判定输出 命中 / 未命中 / 数据不足。数据不足的条件——#1/#2：该档 n<20；#8：该档 n<20（样本不足）或该 kind 覆盖窗 <14 天（窗口不足），两者可并列报出；#3/#4/#7：无观察窗（零有效行）；#5a：任何 episode 内无 hard 进入；#5b：无闭合 episode；#6：任何 episode 内无 `from='normal'` 进入行。建议动作只在命中时打印。

## 4. 回看工具

```
node scripts/memguard-review.mjs [--file <path>]
```

- **只读、不自动调档**；零依赖（Node 内置模块），随 npm 包分发——安装用户运行 `node node_modules/godot-mcp-enhanced/scripts/memguard-review.mjs`。
- 默认路径与采样通道同源：`GODOT_MCP_MEM_SAMPLE_FILE` 优先，否则 `~/.godot-mcp/memory-guard-events.jsonl`；自动并入轮转代际 `.1`–`.4`（`<file>.lock` 是轮转锁，不是代际），按 `ts` 排序合并。
- 坏行 / 半行 / 空行跳过并计数；未知 `event`、更高 `v` 分别计数后忽略（前向兼容）。缺 `leaseId` 或 kind 不在四档内的行不进每档聚合。
- 输出：覆盖窗、阈值快照（`server_start` 行）、每档进程数与 RSS 分布（P50/P95/max）、事件频次表（按 `check` 分的拒绝 / 两种回收 / 杀）、pressure episode 重建、九条判定三态、提示。
- 提示（非判定）：非 Windows 零读数；当前 env `GODOT_MCP_MEM_SAMPLE=0/false`；最后事件距今 >24h（启发式）；`evict_exhausted` 与 `watchdog_recovered` 的计数口径（见第 5 节）。

**退出码**：

| 码 | 含义 |
|---|---|
| 0 | 有结论——触发条件满足且至少一条判定有结论 |
| 1 | 数据不足——触发条件不满足（即使个别判定已有结论），或无任何判定可下结论 |
| 2 | 读失败——主文件缺失且无任何代际 / 任一已存在的文件不可读 / 参数错误。**只要有任一代际文件读失败**（部分读失败），退出码钳为 2，报告照常输出已读部分并在首部提示「数据不完整」 |

**doctor 可见性**：`doctor` 的 Memory guard 段末尾有一行 `sampling: …`（有效态 = 守卫开且 `GODOT_MCP_MEM_SAMPLE` 开）——有数据显示文件大小与最后事件距今；文件不存在或为空显示 `no data yet`；文件非空却无可解析完整行显示 `no readable event`（异常态：文件损坏或路径指向别的文件）；任一开关关显示 `off (<原因>)`。读取/解析出错降级为一行 `sampling check skipped`，不影响 doctor 退出码。

## 5. 已知局限

- **非 Windows 没有 RSS 通道**（`sampleRssBytes` 恒空），档位类判定（#1/#2/#8）不适用——工具以提示形式报出，判定本身仍是数据不足。
- **`GODOT_MCP_MEM_SAMPLE=0` 的「时段」无法从数据反推**（关闭即零写盘）：工具只能结合当前 env 与「最后事件距今 >24h」做启发式提示。
- **`evict.rssBytes` 是推算值**（ratio×声明）却计入进程 max——evict 多的窗口可能抬高 #2 的 P95。
- **`evict_exhausted` 在 hard 持续期间每个轮询周期落一行**（无节流），计数偏大，只作「候选耗尽仍 hard 曾发生」的证据；**审计通道同样无节流**——hard 持续且无可杀候选时 `machine-audit.jsonl` 约每 10s 一行。
- **`exit_reap` 在退出链上是 best-effort**：server 退出时若先走到 `process.exit`，在途的该行可能丢失（回收链上的 stderr 同步行不存在在途丢失问题）。
- **`project` 字段有两种形态**（租约的项目路径 / 回收行的会话桶 key）：仅展示性字段，工具不据它做任何关联（当前报告也不展示）。
- **没有 `spawn_failed` 事件**：spawn 失败数按 kind 用 `lease_acquired − spawn_started` 差值推导。
- **`watchdog_recovered` 在零租约轮次也可能出现**（无读数证据），不宜作为通道健康时长的依据。
- **`exit_reap.aliveMs` 含 kill 链等待**（0–5s 量级）；**二次强杀段不发 `exit_reap`**。工具不消费 `aliveMs`。
- **#5a 有轻微右删失**：降级后不久 server 崩溃时，那个本可能发生的再升级不会被观测到，也不计入分子——方向是低估抖动率，不产生假命中。
- **审计行时间戳与采样行 `ts` 不保证同毫秒**，交叉核对以 `leaseId` 为主键。
- **`server_start` 快照每进程只落一次**：窗口内该行被轮转掉时，#4 的前提只能报「不可核」。
- **#2 用脚本内硬编码的 KILL_FACTOR** 而非 `server_start` 行的快照（按「mjs 硬编码复制 + 机械比对」的既定决策）：常量将来改值时，历史行按新常量判定。

## 6. 调整旋钮对照

| 旋钮 | 类型 | 影响的判定 |
|---|---|---|
| `GODOT_MCP_DECLARED_MB_<KIND>`（`_HEADLESS`/`_GUT_SHARD`/`_GAME_WINDOW`/`_EDITOR`） | env | #1 / #2 / #3（上调）、#8（下调） |
| `GODOT_MCP_MIN_FREE_MB` | env | #4 |
| `GODOT_MCP_MEM_PRESSURE_SOFT_MB` | env | #5b、#6 |
| `GODOT_MCP_MEM_PRESSURE_HARD_MB` | env | #5a、#6 |
| `KILL_FACTOR` | 源码常量（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`） | #2 |
| `HARD_MIN_RECLAIM_MB`（2048） | 源码常量（`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`） | #5a |
| `PRESSURE_RECOVER_MS`（5min） | 源码常量（同上文件） | #5b 的 15min 阈值 = 3× |
| #7 | 无旋钮 | 用户侧工作流问题（preview 模式 / 显式 stop） |

- `KILL_FACTOR` / `HARD_MIN_RECLAIM_MB` / `PRESSURE_RECOVER_MS` **不是 env**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\memguard-review.mjs` 里是硬编码复制（`memory-guard.ts` 的 `SAMPLE_KILL_FACTOR` 同理——反向 import 会成环），由测试读源码文本机械比对防漂移。**改值须源码与脚本同改**，否则比对测试红。
- 判定阈值本身（n≥20、覆盖 14 天、触发 30 进程、#3 1/天、#4 3/天、#5a 10min/30%、#5b 50%、#6 30%、#7 5/天、#8 0.5/0.8）是脚本的 `JUDGE` 常量表，调整属改脚本并同步其测试。
- 采样侧旋钮：`GODOT_MCP_MEM_SAMPLE` / `GODOT_MCP_MEM_SAMPLE_FILE` 是 env；轮转参数 `SAMPLE_ROTATE_SIZE` / `SAMPLE_ROTATE_KEEP` 在 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\memory-guard.ts`，`RSS_SAMPLE_*` 采样节奏在 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\core\mem-watchdog.ts`。
