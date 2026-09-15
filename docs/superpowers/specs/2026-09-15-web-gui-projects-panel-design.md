# Web GUI 项目面板 — 设计文档

- **日期**: 2026-09-15
- **状态**: v2（v1 经第三方审阅修订：1 Blocking + 6 Important + 6 Minor 全部裁决落实，见 §11 修订记录）
- **上游**: Web GUI 批（docs/superpowers/specs/2026-09-14-web-gui-panel-design.md，已合并）+ 面板控制第一版（POST stop/remove 已合并）
- **决策链**: 用户要求"面板拉起项目（任意项目输入框）"→ 用户要求"参考 Unity 等头部游戏引擎设计"→ 调研 Godot 4.x Project Manager / Unity Hub / Epic Launcher（报告见 §9）→ 范式从"输入框"升级为"扫描发现 + 列表管理"→ 设计获用户确认
- **定位**: 资源管理工作台路线的第一大步（项目面板 = 资源管理入口）

---

## 1. 目标与成功标准

在 Web GUI 面板中管理并拉起 Godot 项目：扫描发现（白名单内）→ 列表展示（名称/Last Edited/运行态/Missing 警示）→ 行内一键 Run（弹游戏窗口）或 Edit（弹编辑器）。

**验收标准**（§8 详述）：扫描发现白名单内全部 project.godot；Run 一键弹窗（preview 语义）；Missing 标记；移除仅出清单不删文件；白名单外路径全链路 403。

## 2. 范围

### 范围内

1. `src/web-gui/projects-store.ts` 新文件：项目清单持久化 + 扫描 + 元数据读取
2. server.ts 5 个新端点：`GET /api/projects`、`POST /api/projects/scan`、`POST /api/projects/add`、`POST /api/projects/remove`、`POST /api/sessions/start`
3. `src/tools/runtime.ts`：`run_project` case 主体抽为导出函数 `executeRunProject`（行为零变，既有测试锁行为）
4. html.ts：左列上半新增项目列表面板（搜索/扫描/添加/行内 Run/Edit/移除）
5. GodotServer 接线：注入 runProject/editProject
6. 扫描进度事件经现有 SSE 通道推送

### 范围外（第一版明确不做）

- 项目图标（base64 读 project.godot icon）——文本名称足够
- 行展开详情 / 排序切换 UI（固定 mtime 降序）/ tags 体系
- New Project / Import zip / 重命名项目（只读文件系统铁律——Godot PM 的 rename 本身是已知痛点）
- 卡片视图（Unity 表格行信息密度更优，调研结论）
- 停 server / 批量操作 / 远程访问（沿用 Web GUI 批范围外）

## 3. 数据层（projects-store.ts）

### 3.1 项目清单文件

`~/.godot-mcp/web-gui/projects.json`（权限 0o600 + 原子写，照抄 registry.ts S-5 模式）：

```ts
interface ProjectEntry {
  path: string;        // 绝对路径（写入时 path.resolve 归一）
  name: string;        // project.godot 的 application/config/name；缺省 basename
  addedAt: string;     // ISO 时间（入清单时刻）
  source: 'scan' | 'manual';  // 来源标记（v2/M4）：上限逐出豁免 manual 条目
}
// 文件形态: { version: 1, projects: ProjectEntry[] }
```

- 去重键 = 归一化 path（win 下 lowercase，复用 `normalizeProjectKey` 语义）
- 上限 200 条（超出**只逐出 source='scan' 的最旧条目**，manual 条目豁免——用户明确添加的不被扫描洪流挤掉；scan 条目全被逐出仍超限时停止添加并 warn）
- 读写走构造器注入 `opts.dir`（测试隔离，同 registry 模式）
- **损坏容错**（v2/M3）：projects.json JSON 解析失败 → warn 日志 + 以空清单重建（原子写已大幅缓解损坏面；清单为可再生数据，重扫描即恢复）

### 3.1.1 并发语义（v2/BLK-1，三条硬性规则）

1. **扫描互斥**：`scanProjects()` 进行中再次收到 scan 请求 → 立即返回 `{ started: false, reason: 'scanning' }`（不排队、不并发）；实现用模块级单飞 promise
2. **进程内清单读改写串行化**：add/remove/scan-合并共享一条内部 promise 队列（mutex）；扫描的**合并阶段 re-read 最新清单再合并写回**（防扫描期间 add 的条目被旧快照覆盖丢失——await 点交错的真实丢更新路径，JS 单线程不救）
3. **跨进程写竞争**：多 MCP server 共写同一 projects.json 时**接受 last-writer-wins**，文档注明丢更新面存在。裁决理由：清单是**可再生缓存型数据**（重扫描即恢复全部 scan 条目；manual 条目丢失面=双方同时操作面板的边缘场景），锁文件（projects.json.lock + O_EXCL + 过期清理）的复杂度对此价值不成比例——诚实声明优于过度设计

### 3.2 扫描（Godot Scan 范式）

`scanProjects(): Promise<{ added: number; scanned: number }>`：

- 根来源 = `getAllowedProjectPaths()`（`src/core/path-utils.ts:222-226` 现有导出，分号解析）**经 realpath 归一化**——path-utils 需**新增小导出** `getAllowedRealRoots(): string[]`（`getAllowedProjectPaths().map(p => normalize(safeRealPath(p)))`；现状 realpath 归一化内联在 isPathInAllowedRoots，无可复用的数组形态导出——v2/IMP-1 修正：v1 误引不存在的 `getAllowedRoots` 且误称"复用现有"）
- **空 allowlist 时扫描根 = process.cwd()**（与 isPathInAllowedRoots 的 cwd-fallback 判定侧同源——默认安装态点扫描能发现 cwd 下项目，与 add 放行语义一致；v2/IMP-2）
- **UNRESTRICTED 模式禁扫描**（全盘递归不可接受，返回错误提示"UNRESTRICTED 模式不支持扫描，请用添加按钮"）
- 各根 BFS 递归找 `project.godot`，**限深 4 层**、跳过 `node_modules/.git/.godot/build/dist` 目录、单根目录条目上限 5000（防超大树）
- **不跟随目录符号链接/junction**（`readdir withFileTypes` 判 `isDirectory() && !isSymbolicLink()`——链接环免疫 + 发现结果确定性，v2/M5）。**junction 兜底说明（v2.1）**：Windows junction 是 reparse point，`Dirent.isSymbolicLink()` 对其归类有版本差异——若实测判别不出而被跟随，防环退化为限深 4 + 条目 5000 兜底（正确性无洞，实施时以 Windows 实测为准并在报告注明）
- 发现即合并入清单（**只加不删**——Godot 原版语义；丢失项靠 Missing 状态呈现；合并受 §3.1.1 串行队列保护）
- 同时读 `project.godot` 的 `[application]` 段 `config/name`（轻量 INI 解析：逐行找 `[application]` 段内的 `config/name="..."`；解析失败缺省 basename——不引入 project-config.ts 全量解析器，扫描要快）
- 每发现 N 个经回调推进度（SSE 事件，见 §5）
- 白名单外路径天然剪枝（根就在白名单内）；junction 防绕过依赖 roots 本身经 `safeRealPath`（复用 path-utils 现成语义）

### 3.3 清单读取（实时补全）

`listProjects(): Promise<ProjectView[]>`（`GET /api/projects` 数据源）：

```ts
interface ProjectView extends ProjectEntry {
  mtime: number | null;        // project.godot 的 stat.mtimeMs；null = Missing
  missing: boolean;            // existsSync(join(path,'project.godot')) === false
  running: boolean;            // 对照 listRunSessionsDetailed()（isAliveStatus）
  sessionId: string | null;    // 归一化 key（前端 Run 行与下半会话行的视觉关联键）
}
```

排序：mtime 降序（Missing 沉底）。`running` 判定用注入的 `getSessions` 函数（构造器注入，WebGuiServer 已有——projects-store 独立于 server.ts，由 GodotServer 接线时组装或 server.ts 内组装，实施时定，倾向 server.ts 组装保持 store 纯文件域）。谓词复用 `isAliveStatus`——**需从 process-state 导出**（现为模块私有 `process-state.ts:209`；导出复用而非三处复制，I-E 教训——v2/M1）。

## 4. 操作端点（server.ts，全部走现有 authorized() 三通道鉴权）

| 端点 | 方法 | body | 行为 |
|------|------|------|------|
| `/api/projects` | GET | — | listProjects() 快照 |
| `/api/projects/scan` | POST | — | 触发扫描（异步起、立即返回 `{started:true}`；进度与结果经 SSE `projects` 事件推送；**扫描互斥语义见 §3.1.1**——进行中再收返回 `{started:false, reason:'scanning'}`） |
| `/api/projects/add` | POST | `{path}` | **白名单校验**（`isPathInAllowedRoots`，拒 403）→ project.godot 存在校验（拒 404）→ 合并入清单 |
| `/api/projects/remove` | POST | `{path}` | 仅清单移除（**不删文件**）；成功 200 / 不存在 404 |
| `/api/sessions/start` | POST | `{projectPath, mode: 'run'\|'edit'}` | **白名单校验 403** → project.godot 存在校验 404 → mode=run 调注入 runProject / mode=edit 调注入 editProject；mode 缺省 'run'；坏 body 400 |

- start 的并发语义完全继承 run 链：同项目已 running → stop-existing 互杀旧进程后重跑；busy 链原样生效
- **READ_ONLY 模式拦截**（v2/IMP-3）：start 端点先查 readOnly 状态（注入 `isReadOnly` 判定，接线层取 `GODOT_MCP_READ_ONLY`/ReadOnlyGuard 同源状态）→ readOnly 模式返回 403 `{error:'read-only mode'}`（AI 侧 run_project 被 ReadOnlyGuard 拦为 -32001，面板不得绕过该防线）
- **注入缺席形态**（v2/M6）：runProject/editProject/getProjects/scanProjects/addProject/removeProject 全部可选注入；缺席时对应端点返回 503 `{error:'not configured'}`（对齐 stopSession/removeSession 先例），hello 的 `projects` 字段为 `null`
- add/remove/start 均在 logger 记 `web-gui` audit 行（操作 + 路径 + 结果码）
- 沿用 POST 写路径既有防线（浏览器 Origin 强制 + SameSite=Strict cookie + 事件委托前端）

## 5. SSE 事件扩展

新增事件类型 `projects`：

- 扫描期间：节流 500ms 推 `{ scanning: true, found: number, scanned: number }`
- 扫描完成：`{ scanning: false, added, total }`
- 清单变更（add/remove/首次 start 后）：推最新 `listProjects()` 快照（与 sessions 帧同节奏合并推送亦可，实施时取简）
- 前端收到 `projects` 事件整体重置项目列表（hello 事件 payload 加 `projects` 字段——幂等全量语义与 sessions/stats 一致）

## 6. run 链抽取（runtime.ts）

- `case 'run_project'` 主体抽为 `export async function executeRunProject(args: RunProjectArgs, ctx: ToolContext): Promise<string>`（返回原文本由调用方各自包装，最小 diff 原则）。**抽取边界含 `requireProjectPath`**（v2/M2 裁决：面板链路自动继承第二层白名单防线 + PathError 校验；端点 catch PathError 转 403）。`RunProjectArgs` **直接定义 interface**（runtime 的 inputSchema 为手写 JSON Schema runtime.ts:110-134 非 zod，v2.1 修正措辞）
- 工具 case 改调它；**行为零变**守门员 = `test/runtime.test.js`（55 用例块/161 断言，实测计数）+ runtime-timeout/process-state/guard/function-profiler/regression 等关联套件 + 全量 `npm test`（v2/IMP-5 修正：v1 的"500+ 用例"为未实测转述）
- **ctx 依赖面（实测清单，v2/IMP-4）**：必用 3 成员 = `ctx.findGodot()`（runtime.ts:180）、`ctx.setProjectDir(p)`（:216，**必须接真实 `ps.setProjectDir`**——合成 no-op 会断活跃指针，AI 侧 stop_project/get_debug_output 缺省路径将指错桶）、`ctx.projectDir`（getter）；可选 1 成员 = `ctx.functionProfiler`（undefined 时链内安全跳过）。**模块级可变状态 `profilerOwnerKey`**（runtime.ts:101，4 处读写）为同文件抽取无障碍依赖——未来迁出 runtime.ts 时必须同搬
- **ctx 来源首选第三路线（v2/IMP-4）**：`ToolDispatcher` 加一行只读 getter `getContext(): ToolContext`（现 `private readonly ctx` 无暴露面）——GodotServer 接线经 `this.dispatcher.getContext()` 取真实 ctx（复用真实链路零复刻）；若 getter 方案受阻，退而照抄 ToolDispatcher 构造器 `:104-116` 的成员映射模式（把 findGodot/setProjectDir/projectDir 逐一映射到 `ps.*`，类型合法且行为等价）
- GodotServer 接线注入：
  - `runProject: (projectPath) => executeRunProject({ action: 'run_project', project_path: projectPath, preview: true }, ctx)` —— args 仅必填 `action`/`project_path`（工具 zod 已证：其余全 optional），`preview: true` 为面板语义（人拉起即看）
  - `editProject: (projectPath) => ...`：launch_editor 链仅 6 行（runtime.ts:157-170），接线层直接复刻（findGodot + detached spawn `--editor --path` + unref + error 监听），不抽函数
- **MRTR 说明**：面板直调 executeRunProject 不经 dispatcher 协议层（run_project risk='process'，AI 侧本就无确认门；MRTR 防"AI 自读自确认"，面板操作者是真人；面板侧防线 = 白名单双重校验 + readOnly 拦截 + audit 日志）

## 7. 前端（html.ts）

### 7.1 布局

左列改造：上半**项目**面板（新 section，高度 ~55%）、下半**运行会话**（原有，~45%）。中间栏日志流/右栏统计不变。

### 7.2 项目面板结构

```
[项目] [搜索框___________] [扫描] [+添加]
┌──────────────────────────────────────┐
│ ▶ Run  ✎ Edit  项目名  ⏱LastEdited  ●│  ← ● 状态徽章（运行中绿/Missing 红）
│ ...                                  │
└──────────────────────────────────────┘
```

- **行操作走事件委托**（#projects 容器，`data-action="run|edit|remove"` + `data-path`——沿用点击修复批模式）
- Run/Edit 点击 → statusBar「启动中…」→ SSE sessions 帧出新会话；Edit → statusBar「编辑器已拉起」
- 移除 → `confirm()` 原生确认（"仅从列表移除，不删除文件"文案）→ POST remove
- 搜索：input 事件即时 filter（名称/路径子串，不区分大小写）
- +添加：内联输入行（非弹窗）→ POST add → 错误（403 白名单外/404 非项目）显示状态栏
- Missing 行：红色徽章 + Run/Edit 按钮 disabled（title 提示"路径不存在"）
- Last Edited 显示相对时间（"3 分钟前"式，前端算）
- 项目名 title = 完整路径

### 7.3 事件接线

- hello 的 `projects` 字段初始化（**`projects: null` 时显示空态提示"项目功能未配置"**——注入缺席场景，v2.1）；`projects` SSE 事件刷新；`sessions` 事件刷新 running 徽章（复用现有快照数据对照 sessionId）
- 启动成功后项目行徽章在 sessions 帧到达时自动变绿（无需 projects 事件）

## 8. 验收标准（真机）

1. `POST /api/projects/scan` → 白名单各根下全部 project.godot 出现在面板（含 e2e-project fixture）
2. 行内 Run → 游戏窗口弹出 + 下半会话区出现 running 条目 + 徽章变绿；Edit → 编辑器窗口弹出
3. 手动删一个项目目录（或造 missing）→ 面板行红标 + Run/Edit 禁用；重新扫描不清除（只加不删）
4. 移除 → 确认框 → 行消失、磁盘无变化
5. 白名单外路径 add/start → 403 + 状态栏错误提示；**READ_ONLY 模式 start → 403**（v2/IMP-3）
6. **并发**（v2/BLK-1）：扫描进行中再点扫描 → `{started:false, reason:'scanning'}` 不产生第二个扫描；扫描期间 add 的条目在扫描合并后仍在（re-read 合并）
7. 既有回归：**全量 `npm test`**（抽取不破行为的守门员）+ web-gui 全目录 + TUI 不受影响

## 8.1 测试策略（v2/IMP-6 补，对齐上游 spec §9 格式）

- **单元（Vitest，新代码纳入覆盖率阈值）**：
  - 扫描边界矩阵：限深 4 层（第 5 层的 project.godot 不发现）、跳过目录清单、单根 5000 条上限、去重键（win 大小写）、200 上限丢最旧（scan 条目被逐、manual 豁免）、**不跟随符号链接**（构造链到的项目不发现）、轻量 INI 解析失败回落 basename
  - 白名单两态：空 allowlist → 根 = cwd；UNRESTRICTED → 拒绝扫描
  - 并发：扫描互斥（进行中再 scan 返回 started:false）；扫描期间 add 不丢（串行队列 + re-read 合并）
  - 清单损坏重建：写坏 JSON → 读取为空 + warn + 后续写入正常
  - `isAliveStatus` 导出回归（导出复用后 process-state 既有测试不破）
- **集成**：5 端点全态（200/400/403 白名单外/403 readOnly/404/503 未注入）；`executeRunProject` 抽取等价性（同 args 同 ctx 下工具路径与直调路径返回一致——至少 3 个代表性用例：正常 run/preview/PathError）
- **前端**：静态断言（data-action 委托/搜索框/confirm 文案）+ 真机人工验收（§8）
- **门禁**：标准 `npm run lint && npm run build && npm test`

## 9. 竞品参考（调研结论，2026-09-15）

| 来源 | 借鉴 | 弃用 |
|------|------|------|
| Godot 4.x Project Manager | Scan 递归发现+只加不删+Missing 清理语义；Run（不进编辑器直接跑）；紧凑列表+名称/路径/Last Edited | New Project/Import zip/rename（只读 FS）；tags（价值/代价比低） |
| Unity Hub | Missing 状态警示；"already open"运行态；表格行信息密度；Remove 确认框不删文件；即时搜索 | Cloud/版本控列；Add from repository；卡片视图 |
| Epic Launcher | （弱扫描是公认痛点——反面教材） | 默认目录约定（我们用显式白名单替代，恰解决其发现性痛点） |

## 10. 实施基线

master（d2f1e489 之后）；分支 `feat/web-gui-projects-panel`。实施顺序建议：run 链抽取（最高风险先做，既有测试守）→ projects-store → 端点 → SSE → 前端 → 接线 → 验收。

## 11. 修订记录

- **v1 → v2**（2026-09-15，第三方审阅 APPROVED WITH REVISIONS 后修订）：
  - BLK-1：新增 §3.1.1 并发语义三规则（扫描单飞互斥/进程内 promise 队列 + 合并 re-read/跨进程接受 last-writer-wins 并声明丢更新面——清单为可再生缓存型数据的裁决理由）
  - IMP-1：`getAllowedRoots` 误引修正为 `getAllowedProjectPaths()` + 新增 `getAllowedRealRoots()` 小导出（realpath 归一化数组）
  - IMP-2：空 allowlist 扫描根 = cwd（与判定侧 cwd-fallback 同源）
  - IMP-3：start 端点 READ_ONLY 拦截（403）+ 验收条
  - IMP-4：ctx 依赖面实测清单（findGodot/setProjectDir 须真实/projectDir getter/functionProfiler 可选 + profilerOwnerKey 模块级依赖点名）；ctx 来源首选 ToolDispatcher.getContext() 只读 getter 新路线
  - IMP-5："500+ 用例"失实修正（55 用例块/161 断言实测）+ 回归守门员改全量 npm test
  - IMP-6：补 §8.1 测试策略段
  - M1-M6：isAliveStatus 导出复用/抽取边界含 requireProjectPath（第二层白名单）/清单损坏整体重建/ProjectEntry 加 source 标记 + manual 逐出豁免/不跟随符号链接声明/注入缺席 503 + hello projects=null
