# per-project 运行会话分桶 — 设计文档

- **日期**:2026-09-13
- **状态**:设计定稿(两轮竞品调研校准),待第三方审阅
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
- **桶生命周期**:run 创建(starting→running)→ 进程结束(status→exited/exited_early/errored,proc=null,**桶保留**,输出挪入快照)→ 同项目新 run **覆盖**该桶 → 已结束桶总数上限 16(`GODOT_MCP_MAX_FINISHED_SESSIONS` 可配),超限 FIFO 逐出最旧(better-godot-mcp `exitedPidOrder` 模式)。
- **运行中进程上限**:`GODOT_MCP_MAX_SESSIONS`(默认 4,≥1),溢出报错并列出在跑会话提示先 stop。
- **谓词**(Supervisor 模式):`isAlive(s)`(starting/running)、`canSignal(s)`(isAlive+stopping)、`hasSnapshot(s)`。`exited_early`=启动后极短时间退出(阈值 2s,Godot 秒退常见,单独成态防丢信息);`errored`=close code 非 0 且非 early。

### 4.2 兼容层(零改动的关键)

现有导出函数签名**全部不变**,语义重定向到活跃桶:

| 现有函数(签名不变) | 新语义 |
|---------------------|--------|
| `getRunningProcess()`/`setRunningProcess(p,skip)` | 活跃桶的 proc;setRunningProcess(null) 只清**活跃桶**(快照挪入) |
| `getOutputBuffer()`/`appendOutput()`/`clearOutputBuffer()` | 活跃桶的缓冲 |
| `getLastFinishedRunOutput()` | 活跃桶的快照 |
| `acquireProcessSlot(owner, projectPath?)` | **按目标项目**(显式传参)上 busy 锁;缺省=活跃桶。⚠️ 必须加可选参数:run_project 现状顺序是 acquire(:162)先于 setProjectDir(:166),acquire 时活跃指针还指向上一个项目——按"活跃桶"锁会锁错桶 |
| `getProjectDir()`/`setProjectDir(d)` | 活跃指针本身 |

新增导出(供 runtime.ts 的跨项目路径使用):

```ts
getSession(projectPath?: string): RunSession | undefined;        // 缺省=活跃桶
listRunSessions(): Array<{ projectPath: string; displayPath: string; status: string; pid: number | null }>;
getRunSessionProc(projectPath: string): ChildProcess | null;      // close handler 守卫用
killAllRunSessions(): Promise<void>;                               // GodotServer.close 用
```

**ToolDispatcher ctx 接口零改动**(`ToolDispatcher.ts:104-116` 直通层不变)——qa/gif/bridge-session 等全部现有消费方不动。

### 4.3 工具行为(`src/tools/runtime.ts`)

| 工具 | 行为 |
|------|------|
| `run_project(project_path=X)` | ① 运行中进程达上限→报错+列出在跑会话;② X 桶有活进程→杀之(同项目互杀,语义保持);③ X 桶为已结束桶→覆盖(旧快照由 stash 语义自然接管);④ spawn 后 setProjectDir(X) 切活跃;⑤ preview/TTL/wait_for_bridge 语义 per-project 不变。**⚠️ 实现要点**:"Stop existing" 段(现状 `runtime.ts:154-159` 读 `ctx.runningProcess`=活跃桶)必须改为 `ps.getRunSessionProc(X)`——活跃是 A 时 run_project(B) 应杀 **B 桶**旧进程,A 不动;busy 锁同理按 X 上锁(见 §4.2) |
| `stop_project(project_path?)` | 缺省=活跃桶;指定 X=杀 X 的活进程并返回其输出(快照回落不变);orphan 清理按指定项目过滤 |
| `get_debug_output(project_path?)` | 缺省=活跃桶;指定 X=X 桶当前输出或快照(source 标注不变) |
| 返回消息 | 新增多项目提示:run_project 成功消息附当前在跑会话数(如 `(2 sessions running)`);超限错误列会话清单 |

**close handler 守卫**(本设计最高风险点,PM2/Erodenn 先例):预览模式批的守卫 `ctx.runningProcess === proc` 在活跃指针切走后会误判(A 活跃→切 B→A 关窗,守卫查的是 B 的 proc≠A 的 proc→A 桶泄漏)。改为 **`ps.getRunSessionProc(该次 spawn 的项目路径) === proc`**(按桶身份校验,与活跃指针解耦)。

### 4.4 bridge/profiler:单选跟随活跃项目

- `bridge-client` 的 `setBridgeProjectDir`/`ctx.functionProfiler` 全局单份——**保持不动**,跟随活跃指针;规则文档写明"bridge 查询/输入模拟对最近 run_project 的项目生效,要操作其他项目先 run_project 切换"。
- 已知扩展点(本批不做):bridge"每请求建连、无持久连接"模型(`godot_get_context` 实测)使 per-project 路由天然可行,未来按 projectPath 定位端口/secret 即可。

### 4.5 事件显式标识(为子项目 2 铺路)

`src/core/logger.ts` 的 JSONL `tool_start`/`tool_end` 条目增加 `project` 字段(runtime 域工具从 `project_path`/活跃项目取;其他工具缺省活跃)。一行级改动,子项目 2 的面板按 key 归属事件(CDP 教训:事件层不依赖隐式"当前")。

## 5. 错误处理与边界

| 场景 | 行为 |
|------|------|
| 活跃项目进程结束 | 指针**不转移**(指向该桶,快照可查);listRunSessions 可见 exited 态 |
| 同项目重复 run | 互杀旧进程(单项目用户零感知,与现状一致) |
| 上限溢出 | 拒绝+列出在跑会话+提示 stop;不自动逐出运行中进程 |
| 已结束桶超 16 | FIFO 逐出最旧(先逐出非活跃桶;活跃桶永不逐出) |
| spawn 秒退(<2s) | `exited_early` 态,快照仍留档,AI 可 get_debug_output 查崩溃原因 |
| GodotServer.close() | `killAllRunSessions()` 遍历杀全部活进程+清桶(不留孤儿) |
| 归一化 key 冲突(大小写/分隔符变体) | resolve+lowercase(win)统一;同项目不同写法命中同桶 |

## 6. 连带链与仓库约束

| 项 | 动作 |
|----|------|
| defects 基线 | 模块级可变状态计数变动(单例变量组→Map+指针),按注释链惯例 bump |
| 规则模板双副本 | core.md「视觉改动收尾流程」加多项目说明(多窗口并存/查错带 project_path/上限/bridge 跟随活跃)——**触发 bump 0.33.2→0.33.3 硬门禁**(已知:该门禁 CI 侧不设防,bump 靠纪律) |
| claudemd-builder | 「运行时管理」段同步多项目措辞(手工清单,无门禁) |
| 生成产物 | inputSchema 加 `project_path` 参数(stop_project/get_debug_output)→ gen:tool-docs + build-matrix + check:budget(**顺序:build → build-matrix → gen:tool-docs**,gen 消费 matrix 产物——上批教训) |
| README | 工具表行 + 版本表行 |
| 测试策略 | §7 |

## 7. 测试策略

- `test/process-state.test.js` 重构+扩充:分桶核心(多桶并存/同桶互杀/活跃切换/关窗只清本桶/上限拒绝/FIFO 逐出/exited_early/陈旧 exit 身分校验/归一化 key)/单项目回归(现有用例语义不变,零改动通过——兼容层的直接验证)。
- `test/runtime.test.js`:跨项目并存用例(A run→B run→A 仍活)、stop/get_debug_output 带 project_path、**活跃切走后关旧窗清理**(守卫专项)、上限溢出报错、preview per-project。
- mock ctx 基建:setRunningProcess 副作用模拟对齐新语义(活跃桶)。
- 手动验收:双 fixture 项目真并行弹窗(A/B 两窗口同时活)→ 关 A 查 A 快照 → B 不受影响。

## 8. 改动量估计

- `src/core/process-state.ts`:~200 行(单例组→Map 分桶重构,核心)
- `src/tools/runtime.ts`:~80 行
- `src/core/logger.ts`:~3 行(project 字段)
- `src/core/ToolDispatcher.ts`:0(兼容红利)
- 规则双副本/claudemd-builder/README/CHANGELOG:~25 行 × 若干
- 测试:~300 行(重构+新增)
- 版本链:0.33.2 → 0.33.3

## 9. 开放问题

无——上限默认值(4/16)、状态机阈值(2s)、活跃指针不转移,均已定并写入 §3.2/§4。
