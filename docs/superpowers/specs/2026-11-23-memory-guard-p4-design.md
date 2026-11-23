# memory-guard 四期设计：采样落盘 + 档位回看判定标准

日期：2026-11-23 · 状态：v2（按独立审查 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\reviews\2026-11-23-memory-guard-p4-design-review.md` 修订，B1–B5/I1–I6/M/N 全清）· 前置：三期 0.40.0（`9cac529b`）、清债批 0.40.1（`e90c476b`）

## 意图与为什么

三期收口后，`[Unreleased]` 挂账项中与"数据"直接相关的是档位回看（`GODOT_MCP_DECLARED_MB_*` 四档与软/硬阈值用 L3 面板数据校准）与杀事件入 JSONL 审计通道（T3-M-3）——两者的共同前置是**数据不会自己攒起来**：`godot_get_context`/doctor 是运行时查询，查完即散；MEMGUARD 杀事件只在 stderr 与 console.error。

四期做三件事：
1. **杀事件入既有审计通道**（清偿 T3-M-3 挂账，kill/evict 写 `~/.godot-mcp/machine-audit.jsonl`）；
2. **采样落盘**——治理面事件追加到独立采样 JSONL（机器级单文件，复用既有轮转机制），让档位/阈值数据自动积累；
3. **档位回看判定标准 spec**——"什么数据表现 → 触发什么调整动作 → 攒多少数据才动手"成文，配只读分析工具。

## 目标

- 事件驱动轻量采样：治理事件发生时追加一行 JSONL（附当时机器水位快照，能复用则复用不新起采样）
- 数据能回答三个问题：
  1. **档位偏差**——各 kind 的声明 MB vs 实测 RSS 分布（按 `leaseId` 进程聚合，含被杀进程的峰值证据）
  2. **事件频率**——拒绝（区分第几查）/驱逐/硬帽杀/空闲回收/退出回收的发生频次与原因分布
  3. **pressure 行为**——episode 重建（进入→升级→降级→恢复）、hard 抖动率、episode 时长分布
- 判定标准 8 条成文且**每条可触发**（按状态机源码反推过前置条件，见审查 B1 教训）
- 回看工具：只读分析脚本，输出命中/未命中/数据不足三态，不自动调档

## 非目标（anti-goals）

- 不做定期轮询整机采样（机器空闲时无决策价值；rss_sample 是 watchdog 既有采样的旁挂落盘，不新增采样源）
- 不做自动调档——分析只出建议，改 env/常量是人做的决策
- 不动治理行为本身——采样纯观察面旁挂：写盘 fail-open，绝不因采样炸 spawn/驱逐路径
- 不做跨机器聚合/遥测（单机本地文件）
- **不做 CLI 子命令**（memguard-review 保持仓库运维脚本定位；安装用户面需求未出现，YAGNI——出现时再升级）

## 约束

- **双通道分工（清偿 T3-M-3）**：
  - **审计通道**（既有）：`budget_kill`/`evict`/`evict_exhausted` 三类杀事件写 `~/.godot-mcp/machine-audit.jsonl`（`appendMachineAuditLine`，`AuditEntry` 结构）——跨 server 杀可见性是 T3-M-3 的原始诉求；顺带给该文件补接 `rotateIfNeeded`（当前只 append 无轮转，既有债随批清偿）
  - **采样通道**（新建）：`~/.godot-mcp/memory-guard-events.jsonl`——高频观察数据（spawn/rss_sample/pressure_change 等）；命名对齐 `memory-leases.json`/`machine-audit.jsonl` 既有风格
  - **join 键**：`leaseId` + `ts`——杀事件两处都落（审计行按 AuditEntry、采样行按本 schema），分析端以采样行为准、审计行为跨 server 补充
- **轮转复用既有机制**：采样文件轮转用 `audit-log.ts` `rotateIfNeeded` 同款实现参数化（链式 `.1→.2→…` 代际 + `<file>.lock` pid 跨进程锁 + 持有者存活跳过 + best-effort 失败语义）——不重写轮转逻辑
- **写盘失败 fail-open**：`void appendFile(...).catch(err => warnOnce(err))`——未处理 rejection 在 Node 20 会崩进程，必须挂 catch；首次失败一行 warn，同因去重（对齐 N1 统一口径）
- **快照零新增成本**：`memSample` 接受 `snap?: MachineMemorySnapshot`——调用点有现成快照则复用（`spawn_reject`/`spawn_ok`（非 editor）/pressure 切换/kill 路径都有）；无快照且缓存冷时置 `machine:null`（editor `exemptChecks:true` 路径与 idle_reap 同款），**绝不新起 PowerShell**（同步 2×5s 超时打脸"延迟零感知"）
- `GODOT_MCP_MEMORY_GUARD=0` 零写盘（dummy 租约同短路位）；`GODOT_MCP_MEM_SAMPLE`（接受 `0`/`false` 关，实时读不缓存——对齐 `WATCHDOG_EXEMPT` 读法）单独关采样
- 文件权限 `0o600`（对齐 `user-settings.ts` settings 先例）；`~/.godot-mcp/` 整目录已被 `uninstall --purge` 覆盖（`src\cli\uninstall.ts:333-351`），README 披露文件位置/含项目路径与 pid/如何关闭与删除
- 非 Windows 无 RSS 通道（`sampleRssBytes` 恒空 `{}` 降级）——**档位回看判定 Windows-only**，工具在非 Windows 数据上明报不适用

## 已定决策

| 决策点 | 裁定 | 来源 |
|---|---|---|
| 触发形态 | 事件驱动追加，无轮询 | 用户裁定 |
| 杀事件通道 | 写既有 `machine-audit.jsonl`（T3-M-3 清偿）+ 采样行双落 | 审查 B5 方案 A 变体（本设计定稿） |
| 采样文件 | `~/.godot-mcp/memory-guard-events.jsonl`，轮转复用 `rotateIfNeeded` 参数化 | 审查 B4/B5 + N5 |
| 聚合键 | `leaseId`（非 pid——14 天窗口 Windows pid 复用会并错进程） | 审查 B2 |
| `PRESSURE_RECOVER_MS`/`KILL_FACTOR` 不 env 化 | review 命中 #2/#5 时建议文案指路源码常量；mjs 硬编码复制 + **机械比对测试**（读源码抽常量断言相等，defects 体系"静态检测兜底"纪律——注释登记不构成防线） | 用户裁定（2026-11-23）+ 审查 I3 |
| 默认开采样 | 是（否则数据永远攒不起来）；测试隔离见专门节 | 设计裁量 |
| 回看工具定位 | 仓库运维脚本 `node scripts/memguard-review.mjs`（scripts/ 已进 npm 包 files）；不做 CLI 子命令（YAGNI） | 设计裁量（审查 I3 二选一取后者） |

## 事件 schema

### 公共壳（全部事件）

```jsonc
{ "ts": 1760000000000,        // 本地毫秒（server_start 记 tzOffsetMin 供跨 DST 分析）
  "v": 1, "event": "spawn_ok",
  "serverPid": 12345,          // 状态机身份：pressure 是进程内单例,多 server 共写必须可分段
  "kind": "headless", "project": "D:/proj",
  "leaseId": "p12345-1760000000-7",   // 贯穿 spawn→rss→kill/reject 的进程身份
  "pid": 12346,                // bind 后的事件才有;spawn 时刻为 null
  "machine": { "freePhysMB": 4096, "commitAvailMB": null, "totalPhysMB": 32768,
               "godotProcCount": 3, "degraded": false },  // 快照原样序列化(防逐字段漂移);
                                                           // editor 豁免路径/idle_reap 置 null(见约束)
  "pressure": "normal" }       // after-state(事件生效后的态);pressure_change 行省略此字段只用 from/to
```

### 事件清单

| event | 触发点 | 专有字段 | 通道 |
|---|---|---|---|
| `server_start` | server 进程首个 memSample 调用前（一次性） | `pkgVersion`、`thresholds:{minFreeMB,budgetPct,maxInstances,softMB,hardMB}`、`declaredMB:{...四档}`、`killFactor:{...}`、`pollSeconds`、`tzOffsetMin`——**历史数据按事件时刻阈值判定，不按分析时的当前 env** | 采样 |
| `lease_acquired`（原 spawn_ok 改名，M5） | acquireLease 成功 | `declaredMB`——准入成功≠进程起来（pid 此时 null） | 采样 |
| `spawn_started` | bindLeasePid（spawn 成功后） | `pid`——进程身份确立点 | 采样 |
| `spawn_failed` | 漏斗 spawn 失败路径 releaseLease（如 `spawn-helper.ts:73`） | 失败原因摘要——防"每档 ≥30 进程"分母掺入未启动进程 | 采样 |
| `spawn_reject` | 查⓪①②③任一拒绝 | `check: 0\|1\|2\|3`（⓪pressure 与 ①水位共用 LOW_WATER，须区分）+ `reason`（`MEMGUARD_LOW_WATER`/`MEMGUARD_BUDGET`/`MEMGUARD_INSTANCE_CAP`，DenialCode 三值）+ 当时阈值 | 采样 |
| `rss_sample` | watchdog poll（策略见下节） | `pid`、`declaredMB`、`rssBytes`——**不带 machine**（10s 缓存同一快照，省 20-30% 体积，M11） | 采样 |
| `budget_kill` | killOverBudget | `pid`、`declaredMB`、`rssBytes`、`budgetBytes`（=declared×factor）、`killFactor` | 采样+审计 |
| `evict` | killForEviction | `pid`、`declaredMB`、`rssBytes`、`ratio`、`reason:'hard'`——无 killFactor/evictReason 字段（与代码不符已修，I5） | 采样+审计 |
| `evict_exhausted` | 候选耗尽仍 hard | `envExempted:{preview,editor}` 计数 | 采样+审计 |
| `pressure_change` | updatePressureState **全部 4 处**切换（normal→pressure/任意→hard/hard→pressure 降级/pressure→normal） | `from`、`to`——省略公共壳 pressure | 采样 |
| `watchdog_degraded` / `watchdog_recovered` | 连续 3 轮采样失败退避 / 恢复 | 连续失败轮数——防分析把"缺数据"当"低 RSS" | 采样 |
| `idle_reap` | IdleTimer 回收 | `存活时长`（**先捕获 `s.processStartTime` 再 clearRunSession**——clear 后恒 0，M3 坑）、kind 恒 game_window（IdleTimer 只扫 RunSession，M6 明示）、machine=null | 采样 |
| `exit_reap` | 退出链回收会话 | 同 idle_reap——与空闲回收是两种路径，事件频率问题（目标 #2）需要分 | 采样 |

## RSS 采样策略（治"短命 headless 0 样本"）

- **首轮必采**：租约 bind 后 watchdog 首个 poll 轮必落一行 rss_sample（不受降频节流）——几秒结束的 `execute_gdscript`/`validate`/`screenshot` 作业至少留一行
- **时间驱动降频**（非"N 次 poll"计数，N3）：`now - lastSampleAt[leaseId] >= 60000` 才采——`GODOT_MCP_MEM_POLL_SECONDS` 改动不漂（clamp 5-3600 都成立）
- **长活降频**：存活 >1h 的租约降到 300s/次——editor/game_window 常驻进程的边际信息量小，省体积
- **压力态加密**：pressure/hard 态恢复 60s 档（非"每轮"——300s 轮询下每轮=半小时一行没意义，改为 `max(interval, 60s)`）
- **kill 轮必采**：killOverBudget/killForEviction 路径落 rss_sample（或保证 kill 事件行带 rssBytes——被杀进程的读数是超线峰值证据，B1 右删失）
- **final sample**：漏斗 releaseLease 处（自然退出路径）若 watchdog 最近 rssMap 有本租约读数，补一行 final rss（零 PowerShell 成本）——短命进程的末值
- **诚实声明**：即便如此，亚 10 秒进程仍可能只有 1 行样本；按 kind 判定数据足不足（非全局 30 进程），不足报"数据不足"不硬算

## 旋转与保留（窗口由判据反推）

- **参数**：8MB/代 × 保留 4 代（=40MB 峰值，对齐 audit 10MB×3 量级）；写入前每 500 次 append 查一次 size（内存计数）+ **进程启动时先 stat 一次**（防已有大文件时"500 次后检查"形同虚设，N4）；轮转失败置重试标志（下一条 append 即重试，非等下个 500 次）
- **数学**（按实测行宽 250-300B 估）：常态 60s/租约 + 长活 300s + 首末各一，1 常驻租约 ≈ 0.2MB/天 → 40MB ≈ 单租约 200 天 / 3 租约约 60 天——覆盖 #8 的 14 天窗口有余量；压力态高峰（60s 档 ×多租约）日增量 ≤3MB，窗口仍 ≥2 周
- 轮转机制复用 `rotateIfNeeded` 参数化（`src\core\audit-log.ts:198-236` 抽出尺寸/代际参数或导出同款函数）——锁与代际语义不重写

## 聚合口径（分析核心）

- **进程 = leaseId**：每进程 RSS 值 = `max(所有 rss_sample.rssBytes, budget_kill.rssBytes, evict.rssBytes, final sample)`——被杀读数是峰值证据，rss_sample 是右删失下界（B1）
- **百分位**：nearest-rank 算法；n<20 的档报"样本不足不计算分位"（n=30 时 P95≈max，需注明）
- **观察窗**：首事件至末事件并集天数（非日历天——短跑一次不该算出 24 倍频次）；所有"X/天"判据的分母
- **pressure episode**：按 `serverPid` 分段重建（多 server 状态机独立时序不可混算，B2）——`server_start` 后首个进入行起、`to:'normal'` 行止；server 重启无闭合行的悬挂 episode 标 unresolved 丢弃
- **"直进" vs "升级"**：`from:'normal'→to:'hard'` 是直进；`from:'pressure'→to:'hard'` 是升级——分别计数不合并

## 回看判定标准（8 条，全部按状态机可触发性反推过）

**触发条件**（满足其一）：某 kind `spawn_started` ≥30 进程，或观察窗 ≥14 天。工具输出数据覆盖窗（首末事件/实际天数/每档进程数），不足明报"窗口不足"。

| # | 数据表现 | 判定 | 建议动作 |
|---|---|---|---|
| 1 | 某档 P50(进程max) > declared×1.0（n≥20） | 声明常态性低估 | 上调该档 `DECLARED_MB_<KIND>` 至 P50×1.2 取整 |
| 2 | 某档 P95(进程max, 含 kill 读数) > declared×KILL_FACTOR | 逼近硬帽误杀线（存活样本右删失，kill 读数是峰值证据） | 上调档位优先；KILL_FACTOR 为源码常量（`mem-watchdog.ts`）非 env——需改源码 |
| 3 | budget_kill ≥1/观察窗天（同 kind 跨多日复发） | 硬帽过紧 | 核对该档进程分布后上调档位 |
| 4 | spawn_reject(check=1, LOW_WATER) ≥3/观察窗天 且事件行 pressure='normal' | 瞬时水位毛刺偏频 | MIN_FREE_MB 下调 512MB 档评估 + 评估瞬时分配源（M1：MIN_FREE=SOFT=3072 默认下此判据专捕 30s 去抖窗内的瞬时毛刺；SOFT<MIN_FREE 的自定义配置下含义不同，工具注明前提） |
| 5a | hard 抖动率：hard→pressure 降级后 10min 内再次 →hard 的次数 / hard 进入次数 >30% | 硬阈值边缘反复杀 | HARD_MIN_RECLAIM_MB（`memory-guard.ts:319` 源码常量）或 HARD_MB 调整评估——PRESSURE_RECOVER_MS 只管 pressure→normal 与此无关（B1#5 指错旋钮已修） |
| 5b | 压力期 episode 时长：中位 <15min（恢复下限 5min 的 3 倍）的 episode 占比 >50% | 软阈值边缘抖动 | SOFT_MB 上调评估（pressure 恢复天然 ≥5min——"5min 内 exit"类判据结构性恒 0，禁用） |
| 6 | hard 直进（from:'normal'→to:'hard'）占**进入行**（from='normal' 的 pressure/hard 进入）比 >30% | 软硬间距过窄（升级另计不稀释分母） | SOFT_MB/HARD_MB 间距拉开（SOFT 上调优先） |
| 7 | idle_reap+exit_reap ≥5/观察窗天 | 会话常忘收 | 非档位问题——提示用户侧工作流（preview 模式/显式 stop），不调参 |
| 8 | **每 kind 独立**：P95(进程max) < declared×0.5 且 max(进程max) < declared×0.8，且该 kind 覆盖窗 ≥14 天 | 声明常态性高估（P95+max 双约束防单峰假象） | 下调该档释放预算空间 |

## 回看工具

`node scripts/memguard-review.mjs`（仓库运维脚本，scripts/ 进 npm 包；安装用户手敲 `node node_modules/godot-mcp-enhanced/scripts/memguard-review.mjs`，README 写明）：

- 读主文件+全部代际（`.1`-`.4`），按 ts 排序；坏行/半行跳过并计数；未知 event/更高 v 忽略并计数（前向兼容）
- `--file <path>` 便于测试；退出码 0=有结论 / 1=数据不足 / 2=读失败
- 输出：覆盖窗、每档进程数与 RSS 分布（P50/P95/max/nearest-rank）、事件频次表（按 check 分的拒绝/两种回收/杀）、8 条判定逐条三态、最后事件距今（采样被关时可看出）
- `MEM_SAMPLE=0` 时段报"采样已关闭/数据可能过期"（非"数据不足"）

**测试（golden fixture 必备，I3）**：构造含全事件类型的 JSONL（含坏行/代际文件/跨 server 双写/pid 复用场景/短样本/悬挂 episode），断言 8 条判据三态；**常量机械比对**：读 `src/core/mem-watchdog.ts` 源码文本抽 KILL_FACTOR 表、`memory-guard.ts` 抽 PRESSURE_RECOVER_MS，与 mjs 常量表断言相等（防漂移，defects 纪律）。

## 测试隔离（I1，默认开的代价必须同时设计）

- 采样文件路径 env 覆盖 `GODOT_MCP_MEM_SAMPLE_FILE`（默认 `~/.godot-mcp/memory-guard-events.jsonl`）；`test/setup.js` 统一重定向到 `mkdtempSync` tmp（照 `GODOT_MCP_AUDIT_EXTERNAL_DIR`/`GODOT_MCP_BRIDGE_REGISTRY_DIR` 先例，`test\setup.js:12-31`）——4 个 guard-on 测试文件（memory-guard/mem-watchdog/session-idle-timer/exit-watchdog）stubEnv GUARD=1 时不会写真实 home
- 机器审计隔离已有先例覆盖（setup.js AUDIT_EXTERNAL_DIR 指向的是项目外置副本目录；machine-audit.jsonl 在 home——`appendMachineAuditLine` 的测试路径需同样 tmp 重定向，沿用本批 env 或加专属 env，builder 按 audit-log.test.ts 既有做法对齐）
- `_resetForTest` 清全部新增状态（采样计数器/lastSampleAt 表/去重 warn/路径 override/重试标志）；禁新增模块级 setter 注入点——路径用 env 不用 `_set*ForTest`（AGENTS.md 约束）
- 采样专属测试显式开守卫+显式路径；必测"守卫关→零写盘"与"MEM_SAMPLE=0→零写盘"
- module-level-mutable-state baseline 110 → +N（新模块级变量逐个点名：`_sampleAppendCount`/`_lastSizeCheckAt`/`_sampleWarned`/`_serverStartedAt` 等，defects.ts 注释按既有格式登记）

## 落档位置（I2）

- 判定标准/聚合口径/触发条件/工具用法 → **新文档 `docs/memory-guard-lookback.md`**（永久，维护者回看时照表执行）——本设计文档是其源头
- README env 表加 `GODOT_MCP_MEM_SAMPLE`/`GODOT_MCP_MEM_SAMPLE_FILE` 行 + 版本表附近一行链接指向 lookback 文档（README 无"内存治理"小节，不假装它存在）
- 规则双副本（`src\tools\rule-templates.ts` + `.claude\rules\godot-mcp-core.md`）只补**用户面**采样语义（开关/文件位置/如何删除）——维护者回看判据不进分发模板

## 留给 builder 的（含 AGENTS.md 全部门禁）

实现：
- `memory-guard.ts` memSample 单点（event/fields/snap 可选参数）+ 各事件点接线（acquireLease 两分支/bindLeasePid/漏斗失败 release/pressure 4 处切换/idle 与 exit 两回收/kill 两路径）+ server_start 惰性首发
- watchdog poll 接 rss_sample 策略（首轮必采/时间驱动/长活降频/压力档/kill 轮）；releaseLease final sample
- `rotateIfNeeded` 参数化（或导出同款）+ machine-audit.jsonl 补轮转；kill 事件双落（appendMachineAuditLine + memSample）
- `scripts/memguard-review.mjs` + golden fixture 测试 + 常量机械比对测试
- doctor Memory guard 段加一行 sampling 状态（on/off/file size/last event age，N6——用户遇"数据不足"可自证采样在跑）

收口门禁（AGENTS.md 强制）：
- `npm run lint`（533 基线）+ `npm run build` + `npm run test:coverage`（coverage 82.4/74.92/85.59/84.18 不回退——0.40.0 口径基线）
- 改规则双副本后：`npm run build` 先行 + `STRICT=1 npm run check:rules-sync` + `npm run check:rules-version-bump`
- `STRICT=1 npm run check:changelog-sync`；`[Unreleased]` 段保留（T3-M-3 回标"四期随采样统一收口"，其余三项挂账保留）
- 版本 bump 0.41.0 四件套（规则模板变更触发硬门禁）；**bump ≠ 发版**——npm publish/tag/GitHub Release 待用户明确指令（N-C 裁定）
- 无工具面变更 → capability-matrix 不重建（写明防 executor 顺手跑）；verify_delivery 不适用（非发版）
- 独立审查文档 `docs/reviews/2026-11-23-memory-guard-p4-review.md`（AGENTS.md §8）
- 完成前 memory 登记（feature-decision-log + lesson）
- 文档引用一律绝对路径（AGENTS.md 路径规范）

## 修订记录

- v1（2026-11-23 上午）：初稿，builder check 4 问闭环（1 用户裁定 env 化=否 + 3 自决）
- v2（2026-11-23）：按独立审查（B1–B5/I1–I6/M1-M12/N1-N6）全量修订——判定表重写（#2 数据源/#5 拆 5a5b/#6 分母）、schema 加 serverPid/leaseId/server_start/6 新事件、采样策略五条（首轮必采/时间驱动/长活降频/kill 轮/final）、轮转复用 rotateIfNeeded 8MB×4、双通道分工清偿 T3-M-3、测试隔离 env 重定向、lookback 永久文档、AGENTS.md 门禁全列、事实修正（F1-F9）
