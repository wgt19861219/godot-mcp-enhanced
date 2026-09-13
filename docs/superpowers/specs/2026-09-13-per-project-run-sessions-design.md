# per-project 运行会话分桶 — 设计文档

- **日期**:2026-09-13
- **状态**:v2(第三方审阅 4 Blocking + 2 Important + 9 Nits 全部落实,见 §10)
- **分支**:feat/per-project-run-sessions(基于 master@d840d1e3,含预览模式 0.33.2)
- **类型**:feature(架构级:process-state 进程槽分桶)
- **前置 feature**:[2026-09-13-run-project-preview-mode-design.md](2026-09-13-run-project-preview-mode-design.md)(preview/快照机制,本设计将其 per-project 化)
- **后置依赖**:子项目 2「Web GUI 面板」(会话面板数据来自本设计的 RunSession 模型)

---

## 1. 背景与问题

预览模式(0.33.2)交付后,单项目场景闭环良好;多项目场景暴露三个问题(均根源于 `process-state` 模块单例,CR-3 注释 `src/core/process-state.ts:104-120` 已知约束):

1. **窗口互杀**:游戏进程全局单槽(`acquireProcessSlot`),项目 B 的 `run_project` 会无声杀掉项目 A 常驻中的 preview 窗口(`runtime.ts:169-173` Stop existing 不分项目)。
2. **快照互覆盖**:`_lastFinishedRunOutput` 单份,B 运行后覆盖 A 的快照,A 关窗查错读到 B 的输出。
3. **上下文单槽**:`_projectDir`/输出缓冲/`processStartTime` 全部单份,跨项目互相踩。

用户确认的并行形态:**多窗口同时开(真并行)**——看 A 的窗口时 AI 改 B 并弹 B 的窗口,A 保持存活。多会话多项目(每项目一个 MCP server 实例)天然隔离不受影响。

## 2. 目标 / 非目标

**目标**:
1. 单会话内按 `project_path` 并行运行多个 Godot 项目(各自游戏进程/输出/快照隔离,多窗口并存)。
2. 兼容层:单项目场景与现有消费方(qa/gif/bridge-session/GodotServer)零改动、零行为变化。
3. 事件与工具调用携带显式项目标识(为子项目 2 Web GUI 面板按 key 归属铺路)。

**非目标**:
- bridge/profiler 的 per-project 并行(本批单选跟随活跃项目;bridge"每请求建连"模型使未来可行,见 §7)。
- 面板控制按钮、会话自动重启策略(PM2 式 restart/backoff 不做——我们是验证工作流不是守护进程)。
- dashboard TUI 改动(子项目 2 处理)。

## 3. 竞品依据(两轮调研校准)

### 3.1 验证成立的设计

| 模式 | 来源 | 对应设计 |
|------|------|---------|
| 活跃指针 + 显式 key **分层**(消息层全显式 id,UX 层活跃指针+显式切换工具) | CDP flat session(Chromium 官方推进默认)/ puppeteer `Map<sessionId,Session>` / microsoft/playwright-mcp 当前 tab + browser_tabs | 事件带 projectPath、工具默认活跃+可选 `project_path` 覆盖 |
| 进程结束**桶保留快照** | PM2 EXITED 记录留存 / CDP detach 后 target 可查 | `_lastFinishedRunOutput` per-project,桶不随进程死 |
| **陈旧 exit 事件按身份校验**后忽略 | PM2 `handleExit` 槽位校验 / Erodenn `sessionEpoch` | close handler 守卫按**桶内 proc 身份**比对(预览模式批 Imp-4 守卫的分桶版) |
| 同实例**关单个 vs 关全部分层** | playwright-mcp(关单 tab vs 关 context) | `stop_project`(单项目) vs `GodotServer.close`(全部) |
| per-key 资源桶三件套(Map+Set+FIFO 逐出) | better-godot-mcp `Map<pid,LogBuffer>`+`exitedPidOrder` | `Map<projectKey, RunSession>` + 已结束桶上限 FIFO |
| 状态机:少量状态+分组谓词+**启动早退单独成态** | Supervisor `states.py` | RunSession.status(§4.2) |

### 3.2 修订项(头部实践推翻初稿)

1. **并发上限可配置**而非硬编码:PM2 无进程数上限(治理靠行为参数)——上限是我们自设,做成 `GODOT_MCP_MAX_SESSIONS`(默认 4),溢出**拒绝并列出在跑会话**(不自动杀,区别于 FIFO 逐出)。
2. **活跃指针死亡不转移**:活跃项目进程结束后指针保持指向该桶(快照可查),不自动切到别的桶;下一次 `run_project` 显式切换(playwright-mcp close 分层语义)。
3. 每条运行事件的归属**必须显式**(CDP 教训:头部项目消息层无隐式"当前")。

## 4. 详细设计

### 4.1 数据模型(`src/core/process-state.ts`)

```ts
export interface RunSession {
  proc: ChildProcess | null;
  status: 'starting' | 'running' | 'stopping' | 'exited' | 'exited_early' | 'errored';
  outputBuffer: string[];            // 上限 5000(现状 MAX_OUTPUT_BUFFER_SIZE 不变)
  lastFinishedRunOutput: string[];   // per-project 快照(B-1 机制分桶版)
  processStartTime: number;
  busy: boolean; busyOwner: string; busySince: number;   // 长运行锁 per-project
}
_sessions: Map<string, RunSession>;  // key = 归一化项目路径(见下)
_exitedSessionOrder: string[];       // 已结束桶的 FIFO(逐出最旧)
_projectDir: string;                 // 语义升级:活跃项目(最近一次 run_project)
```

- **key 归一化**:`path.resolve(p)`;Windows 下再 `toLowerCase()`(盘符大小写)。仅作 Map 索引,显示/返回保留原路径(session 内存 `displayPath`)。
- **桶生命周期**:run 创建(starting→running)→ 进程结束(status→exited/exited_early/errored,proc=null,**桶保留**,输出挪入快照)→ 同项目新 run **覆盖**该桶 → 已结束桶总数上限 16(`GODOT_MCP_MAX_FINISHED_SESSIONS` 可配),超限 FIFO 逐出最旧(better-godot-mcp `exitedPidOrder` 模式)。**逐出后** `get_debug_output(project_path=X)` 返回明确错误 `"session evicted"`(不静默回落活跃桶)。
- **pid 注册表归属化**:`_spawnedGodotPids` 从 `Set<number>` 改为 `Map<number, projectKey>`——orphan 清理链(§4.4)按桶归属排除全部活进程,防周期扫描误杀非活跃窗口。
- **运行中进程上限**:`GODOT_MCP_MAX_SESSIONS`(默认 4,≥1),溢出报错并列出在跑会话提示先 stop。
- **谓词**(Supervisor 模式):`isAlive(s)`(starting/running)、`canSignal(s)`(isAlive+stopping)、`hasSnapshot(s)`。`exited_early`=启动后 2s 内退出(Godot 秒退常见,单独成态防丢信息);`errored`=close code 非 0 且非 early;`stopping` 由 stop_project/killAllRunSessions 在 killProcess 前设置。
- **活跃桶惰性创建(硬性实现要求)**:任何写操作到达时若活跃 key 无桶,创建空桶(key 仍为 `_projectDir` 当前值,初始 `''`)——现有 77 个 process-state 用例在无 setProjectDir 前提下依赖此语义。

### 4.2 兼容层(零改动的关键)

现有导出函数签名**向后兼容**(个别加可选参数),语义重定向到活跃桶:

| 现有函数 | 新语义 |
|---------------------|--------|
| `getRunningProcess()`/`setRunningProcess(p,skip)` | 活跃桶的 proc;setRunningProcess(null) 只清**活跃桶**(快照挪入) |
| `getOutputBuffer()`/`clearOutputBuffer()` | 活跃桶的缓冲 |
| `appendOutput(lines, projectKey?)` | **加可选 projectKey**:缺省=活跃桶(兼容既有调用方);**游戏输出流 handler 必须显式传桶 key**(§4.3 坑 1 修复,防串桶) |
| `getLastFinishedRunOutput()` | 活跃桶的快照 |
| `acquireProcessSlot(owner, projectPath?)` | **按目标项目**(显式传参)上 busy 锁;缺省=活跃桶。⚠️ 必须加可选参数:run_project 现状顺序是 acquire(:176)先于 setProjectDir(:180),acquire 时活跃指针还指向上一个项目——按"活跃桶"锁会锁错桶 |
| `getProjectDir()`/`setProjectDir(d)` | 活跃指针本身;**写入方仅限 run_project 与显式切换点**(§4.6 裁决) |
| `getBusyInfo()`/`buildBusyErrorMessage()` | 数据来源改为**持锁桶**的项目/pid/时长(多桶下报活跃项目会张冠李戴) |
| acquireProcessSlot 的死进程自愈检查(现状 `process-state.ts:193-208` 读全局 `_runningProcess`) | 读**目标桶**的 proc |

新增导出(供 runtime.ts 的跨项目路径使用;均为 per-key 状态操作,非依赖注入 setter,不违反 AGENTS.md「禁止新增模块级 setter 注入点」):

```ts
getSession(projectPath?: string): RunSession | undefined;        // 缺省=活跃桶
listRunSessions(): Array<{ projectPath: string; displayPath: string; status: string; pid: number | null }>;
getRunSessionProc(projectPath: string): ChildProcess | null;      // 守卫判断用
clearRunSession(projectPath: string): void;                        // 守卫体内动作用:清 X 桶的 proc/busy(活跃则同步指针)/快照挪移
markSessionStopping(projectPath: string): void;                    // killProcess 前设 stopping 态
getActiveRunPids(): number[];                                      // orphan 清理链排除集合(§4.4)
killAllRunSessions(): Promise<void>;                               // GodotServer.close 用
```

**ToolDispatcher ctx 接口零改动**(`ToolDispatcher.ts:104-116` 直通层不变)——qa/gif/bridge-session 等全部现有消费方不动。

### 4.3 工具行为(`src/tools/runtime.ts`)

| 工具 | 行为 |
|------|------|
| `run_project(project_path=X)` | ① 运行中进程达上限→报错+列出在跑会话;② X 桶有活进程→杀之(同项目互杀,语义保持);③ X 桶为已结束桶→覆盖(旧快照由 stash 语义自然接管);④ spawn 后 setProjectDir(X) 切活跃;⑤ preview/TTL/wait_for_bridge 语义 per-project 不变。**⚠️ 实现要点**:"Stop existing" 段(现状 `runtime.ts:169-173` 读 `ctx.runningProcess`=活跃桶)必须改为 `ps.getRunSessionProc(X)`——活跃是 A 时 run_project(B) 应杀 **B 桶**旧进程,A 不动;busy 锁同理按 X 上锁(见 §4.2) |
| 输出流 handler(现状 `runtime.ts:225-230` 无参 `appendOutput()`) | **闭包捕获本次 spawn 的 projectKey**,改 `appendOutput(lines, key)`——活跃指针切走后 A 的输出继续写 A 桶(坑 1:串桶修复) |
| **四组守卫的判断与体内动作都按 spawn 时捕获的 key**(坑 4/5/6 修复) | close handler(:253-254)/error handler(:263-264)/autoStopTimer(:236-239)/bridge 未就绪清理(:285-287)与 wait_for_bridge 的 `isCancelled`(:279):**判断**改 `ps.getRunSessionProc(key) === proc`;**体内清理**(setProcessBusy(false)+setRunningProcess(null))改 `ps.clearRunSession(key)`——不可用活跃桶语义,否则非活跃桶的 close 会清掉活跃桶的 busy(双进程)或泄漏本桶 busy |
| `stop_project(project_path?)` | 缺省=活跃桶;指定 X=杀 X 的活进程并返回其输出(快照回落不变);orphan 分支按 X 的 key 对照 pid 注册表归属清理(准确语义见 §4.4 勘误) |
| `get_debug_output(project_path?)` | 缺省=活跃桶;指定 X=X 桶当前输出或快照(source 标注不变) |
| 返回消息 | 新增多项目提示:run_project 成功消息附当前在跑会话数(如 `(2 sessions running)`);超限错误列会话清单 |

**守卫总纲(PM2/Erodenn 先例,审查坑 3/4/5/6 统一解法)**:run_project 为本次 spawn 生成闭包级 `sessionKey`(归一化后的 X),**该次 spawn 生命周期内的全部异步回调(输出 handler/close/error/autoStop/bridge 轮询)都只认 sessionKey,不读活跃指针**——判断用 `getRunSessionProc(key)`,清理用 `clearRunSession(key)`。活跃指针只服务"缺省参数的工具调用"这一层(playwright-mcp 当前 tab 模式)。

### 4.4 orphan/周期清理链纳入分桶(审查坑 2 修复)

现状两处清理链按"单个当前管理 pid"排除,多桶并存时会周期性击杀非活跃窗口:

- `process-state.ts:378` 传 `runningPid: _runningProcess?.pid`(单值)→ `orphan-cleanup.ts:67` 第一层只跳过这一个 pid——非活跃桶 A 的活进程在 `_spawnedGodotPids` 集合中且 pid≠runningPid → `GodotServer.ts:531` 的 **30s 周期扫描**与 stop_project orphan 分支(`runtime.ts:306-313`)会 taskkill 它。
- **修复**:①`_spawnedGodotPids` 改 `Map<number, projectKey>`(§4.1);②`killOrphanGodotProcesses` 的排除集合改为 `getActiveRunPids()`(全部桶内活进程);③`registerSpawnedGodotPid(pid)` 加可选 projectKey 参数(runtime.ts 传本次 sessionKey),保留"非托管 pid"的孤儿语义不变。
- ⚠️ 勘误(v1 §4.3 错误描述):orphan 第一层过滤是**按 pid 集合**遍历,与 projectDir 无关;projectDir 只用于 `fullSystemScan` 兜底层。"orphan 清理按指定项目过滤"的准确语义=stop_project 的 orphan 分支以被停项目的 key 对照注册表归属,只清"曾由该项目 run 出、现已脱离管理"的进程。

### 4.5 bridge/profiler:单选跟随活跃项目

- `bridge-client` 的 `setBridgeProjectDir`/`ctx.functionProfiler` 全局单份——**保持不动**,跟随活跃指针;规则文档写明"bridge 查询/输入模拟对最近 run_project 的项目生效,要操作其他项目先 run_project 切换"。
- 已知扩展点(本批不做):bridge"每请求建连、无持久连接"模型(`godot_get_context` 实测)使 per-project 路由天然可行,未来按 projectPath 定位端口/secret 即可。

### 4.6 事件显式标识(为子项目 2 铺路)

`src/core/logger.ts` 的 JSONL `tool_start`/`tool_end` 条目增加 `project` 字段。实现要点(审查修正,原估 3 行→实际 ~15 行):`toolStart` 现只落 `arg_keys`(`logger.ts:416-460`),`toolEnd` 无 project 来源——须在 `pendingTools`(`logger.ts:221-224`)存 project 并让 toolEnd 配对携带;runtime 域工具从 `project_path`/活跃项目取,其他工具缺省活跃。JSONL 加字段对 dashboard 解析向后兼容。

### 4.7 活跃指针单写入方裁决(审查坑 3 修复)

**现状矛盾**:`validation.ts:574-575`(V-01 fix)在 validate_scripts 链路调 `ctx.setProjectDir(projectPath)`——不是 run_project。按 §4.1"活跃=最近一次 run_project"定义,validate_scripts(X) 会把活跃桶切到 X(空桶):getRunningProcess() 变 null、游戏输出写错桶。"现有消费方零改动"与"活跃指针唯一定义"不可兼得,必须裁决。

**裁决**:`validation.ts:575` 的 `setProjectDir` 改为读 `getProjectDir()`/局部传递(V-01 fix 的目的——orphan 清理知道当前项目——用只读方式满足),**不写活跃指针**。活跃指针写入方收窄为:run_project(spawn 成功后)+ 未来显式切换工具。这是对 validation.ts 的 ~3 行行为变更(其调用方语义不受影响,validate_scripts 从不期望切活跃),记入 §8 改动清单。

## 5. 错误处理与边界

| 场景 | 行为 |
|------|------|
| 活跃项目进程结束 | 指针**不转移**(指向该桶,快照可查);listRunSessions 可见 exited 态 |
| 同项目重复 run | 互杀旧进程(单项目用户零感知,与现状一致) |
| 上限溢出 | 拒绝+列出在跑会话+提示 stop;不自动逐出运行中进程 |
| 已结束桶超 16 | FIFO 逐出最旧(先逐出非活跃桶;活跃桶永不逐出);被逐桶的显式查询返回 "session evicted" |
| **30s 周期 orphan 扫描** | 排除集合=全部桶内活进程(`getActiveRunPids()`),非活跃窗口不会被当孤儿杀掉(§4.4) |
| **游戏输出流** | 按 spawn 时闭包捕获的 sessionKey 写入对应桶,与活跃指针切换无关(§4.3) |
| spawn 秒退(<2s) | `exited_early` 态,快照仍留档,AI 可 get_debug_output 查崩溃原因 |
| GodotServer.close() | `killAllRunSessions()` 遍历杀全部活进程+清桶(不留孤儿) |
| 归一化 key 冲突(大小写/分隔符变体) | resolve+lowercase(win)统一;同项目不同写法命中同桶 |
| validate_scripts 运行中 | 不再切活跃指针(§4.7);游戏输出照常写自己的桶 |

## 6. 连带链与仓库约束

| 项 | 动作 |
|----|------|
| defects 基线 | 模块级可变状态计数变动(单例变量组→Map+指针),按注释链惯例 bump |
| 规则模板双副本 | core.md「视觉改动收尾流程」加多项目说明(多窗口并存/查错带 project_path/上限/bridge 跟随活跃)——**触发 bump 0.33.2→0.33.3 硬门禁**(已知:该门禁 CI 侧不设防,bump 靠纪律) |
| claudemd-builder | 「运行时管理」段同步多项目措辞(手工清单,无门禁) |
| 生成产物 | inputSchema 加 `project_path` 参数(stop_project/get_debug_output)→ gen:tool-docs + build-matrix + check:budget(**顺序:build → build-matrix → gen:tool-docs**,gen 消费 matrix 产物——上批教训) |
| README | 工具表行 + 版本表行 |
| AGENTS.md 对照 | ①新增导出为 per-key 状态操作、非依赖注入 setter,不违反「禁止新增模块级 setter 注入点」(§4.2 已声明);②实施完成后产出 `docs/reviews/` 第三方审查文档(「完成前强制检查」§8) |
| 测试策略 | §7 |

## 7. 测试策略

- `test/process-state.test.js` 重构+扩充:分桶核心(多桶并存/同桶互杀/活跃切换/关窗只清本桶/上限拒绝/FIFO 逐出/exited_early/陈旧 exit 身分校验/归一化 key/pid 注册表归属/orphan 排除集合)/单项目回归(现有用例语义不变——依赖 §4.1 惰性创建硬性要求,零改动通过)。
- `test/runtime.test.js`:跨项目并存用例(A run→B run→A 仍活)、stop/get_debug_output 带 project_path、**活跃切走后关旧窗清理**(守卫专项)、**活跃切走后 A 输出仍写 A 桶**(坑 1 专项)、上限溢出报错、preview per-project、wait_for_bridge 并发不误报(坑 6)。
- **mock 双基建**:①ctx(现有 setRunningProcess 副作用模拟对齐活跃桶语义);②`runtime.test.js:22-36` 的 process-state vi.mock 工厂**必须补全部新导出**(getRunSessionProc/clearRunSession/markSessionStopping/getActiveRunPids/listRunSessions/killAllRunSessions + appendOutput/acquireProcessSlot/registerSpawnedGodotPid 的新参数形态),否则现有用例直接 TypeError。
- 手动验收:双 fixture 项目真并行弹窗(A/B 两窗口同时活 >30s 周期扫描)→ 关 A 查 A 快照 → B 不受影响。

## 8. 改动量估计

- `src/core/process-state.ts`:~250 行(单例组→Map 分桶重构 + 新导出 7 个 + pid 注册表归属化)
- `src/core/orphan-cleanup.ts`:~10 行(排除集合改 getActiveRunPids)
- `src/tools/runtime.ts`:~110 行(Stop existing/输出 handler/四组守卫按 sessionKey;stop/get_debug_output 加 project_path;上限检查;消息)
- `src/tools/validation.ts`:~3 行(§4.7 裁决,不再写活跃指针)
- `src/core/logger.ts`:~15 行(project 字段经 pendingTools 配对)
- `src/core/ToolDispatcher.ts`:0(兼容红利)
- `src/core/GodotServer.ts`:~5 行(close 链换 killAllRunSessions)
- 规则双副本/claudemd-builder/README/CHANGELOG:~25 行 × 若干
- 测试:~350 行(重构+新增)
- 版本链:0.33.2 → 0.33.3

## 9. 开放问题

无——上限默认值(4/16)、状态机阈值(2s)、活跃指针不转移、单写入方裁决(validation.ts 收窄),均已定并写入 §3.2/§4/§10。

## 10. 审阅记录(2026-09-13)

### 10.1 第三方 code-reviewer 审阅(feature-dev:code-reviewer,独立隔离)

**v1 判定:BLOCKING ISSUES → 本文档为 v2,全部落实**:

- **坑 1(Blocking,95%)** 输出串桶:appendOutput 无参写活跃桶,A 的输出在活跃切走后写进 B 桶 → §4.3 输出 handler 闭包捕获 sessionKey + appendOutput 加可选参数。
- **坑 2(Blocking,95%)** orphan 30s 周期扫描杀非活跃窗口:runningPid 单值排除(orphan-cleanup.ts:67)+ GodotServer.ts:531 周期扫描 → §4.4 纳入设计(pid 注册表 Map 化+排除集合=全部活进程+勘误 v1 对第一层过滤的错误描述)。
- **坑 3(Blocking,90%)** 活跃指针第二写入方 validation.ts:575(V-01 fix)切桶,与"活跃=最近 run_project"定义矛盾 → §4.7 裁决收窄写入方。
- **坑 4(Blocking,85%)** 守卫体内清理动作仍是活跃桶语义,清错桶/泄漏 busy → §4.2 补 clearRunSession/per-key 清理 API;§4.3 守卫总纲(判断+体内动作都按 sessionKey)。
- **坑 5(Important,90%)** autoStopTimer 守卫不触发破坏 TTL → 并入守卫总纲。
- **坑 6(Important,80%)** wait_for_bridge isCancelled 并发误报+孤儿 → 并入守卫总纲(§7 专项测试)。
- **Nits 9 条全落实**:签名措辞(§4.2"向后兼容")、stopping 设置者(§4.1+markSessionStopping)、逐出后行为(§4.1"session evicted")、logger 改动量修正(§4.6,3→15 行)、mock 双基建(§7)、惰性创建硬性要求(§4.1)、AGENTS 对照(§6)、busy 消息报持锁桶(§4.2)、自愈检查读目标桶(§4.2)。
- **审查确认项**:ToolDispatcher/cli-ctx/qa/gif 结构上零改动可达;exited_early 双判据无竞态可实现;agentsmd-builder 不涉及(实测 0 匹配);v1 §6 对 CI 门禁的描述"比 AGENTS.md 更准确"(check-rules-version-bump.mjs:41-76 比对 HEAD vs 工作区,PR merge 后恒通过)。

### 10.2 教训(登记 memory)

1. "兼容层语义重定向活跃桶"模式中,**每个读活跃指针的位置都是独立坑点**——盘点必须覆盖守卫判断、守卫体内动作、输出写入回调、异步轮询闭包(isCancelled)四类,不能只盯守卫(v1 漏掉 6 个中的 4 个皆因此)。
2. 模块级单例分桶改造前,必须 grep 单例 setter 的**全部写入方**而非只看主流程(setProjectDir 的第二写入方 validation.ts 直接推翻设计核心定义)。
3. orphan/周期清理链是"多实例并存"设计的隐形杀手:任何"只跳过单个当前 pid"的排除逻辑都会周期性击杀并行实例——多路并存设计必须把清理链纳入边界表。
