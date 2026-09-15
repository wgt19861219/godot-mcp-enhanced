# Web GUI 项目面板 — 设计文档

- **日期**: 2026-09-15
- **状态**: v1（设计经用户确认，待第三方审阅）
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
}
// 文件形态: { version: 1, projects: ProjectEntry[] }
```

- 去重键 = 归一化 path（win 下 lowercase，复用 `normalizeProjectKey` 语义）
- 上限 200 条（超出丢最旧——Godot PM 无上限但我们是文件存储，防疯）
- 读写走构造器注入 `opts.dir`（测试隔离，同 registry 模式）

### 3.2 扫描（Godot Scan 范式）

`scanProjects(): Promise<{ added: number; scanned: number }>`：

- 根来源 = `getAllowedRoots()`（`ALLOWED_PROJECT_PATHS` 分号解析；**UNRESTRICTED 模式下禁扫描**——全盘递归不可接受，返回错误提示"UNRESTRICTED 模式不支持扫描，请用添加按钮"）
- 各根 BFS 递归找 `project.godot`，**限深 4 层**、跳过 `node_modules/.git/.godot/build/dist` 目录、单根目录条目上限 5000（防符号链接环与超大树）
- 发现即合并入清单（**只加不删**——Godot 原版语义；丢失项靠 Missing 状态呈现）
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

排序：mtime 降序（Missing 沉底）。`running` 判定用注入的 `getSessions` 函数（构造器注入，WebGuiServer 已有——projects-store 独立于 server.ts，由 GodotServer 接线时组装或 server.ts 内组装，实施时定，倾向 server.ts 组装保持 store 纯文件域）。

## 4. 操作端点（server.ts，全部走现有 authorized() 三通道鉴权）

| 端点 | 方法 | body | 行为 |
|------|------|------|------|
| `/api/projects` | GET | — | listProjects() 快照 |
| `/api/projects/scan` | POST | — | 触发扫描（异步起、立即返回 `{started:true}`；进度与结果经 SSE `projects` 事件推送） |
| `/api/projects/add` | POST | `{path}` | **白名单校验**（`isPathInAllowedRoots`，拒 403）→ project.godot 存在校验（拒 404）→ 合并入清单 |
| `/api/projects/remove` | POST | `{path}` | 仅清单移除（**不删文件**）；成功 200 / 不存在 404 |
| `/api/sessions/start` | POST | `{projectPath, mode: 'run'\|'edit'}` | **白名单校验 403** → project.godot 存在校验 404 → mode=run 调注入 runProject / mode=edit 调注入 editProject；mode 缺省 'run'；坏 body 400 |

- start 的并发语义完全继承 run 链：同项目已 running → stop-existing 互杀旧进程后重跑；busy 链原样生效
- add/remove/start 均在 logger 记 `web-gui` audit 行（操作 + 路径 + 结果码）
- 沿用 POST 写路径既有防线（浏览器 Origin 强制 + SameSite=Strict cookie + 事件委托前端）

## 5. SSE 事件扩展

新增事件类型 `projects`：

- 扫描期间：节流 500ms 推 `{ scanning: true, found: number, scanned: number }`
- 扫描完成：`{ scanning: false, added, total }`
- 清单变更（add/remove/首次 start 后）：推最新 `listProjects()` 快照（与 sessions 帧同节奏合并推送亦可，实施时取简）
- 前端收到 `projects` 事件整体重置项目列表（hello 事件 payload 加 `projects` 字段——幂等全量语义与 sessions/stats 一致）

## 6. run 链抽取（runtime.ts）

- `case 'run_project'` 主体（`requireProjectPath` 校验之后的全部逻辑）抽为 `export async function executeRunProject(args: RunProjectArgs, ctx: ToolContext): Promise<string>`（返回原 textResult 的文本，或 `{ text, isError }`——实施时以最小 diff 为准，倾向返回原字符串由两个调用方各自包装）
- 工具 case 改调它；`RunProjectArgs` 从现有 zod 推导类型
- **行为零变**：既有 `test/runtime.test.js`（500+ 用例）是守门员；diff 期望为纯移动 + 参数化
- GodotServer 接线注入：
  - `runProject: (projectPath) => executeRunProject({ action: 'run_project', project_path: projectPath, preview: true }, ctx)` —— args 仅必填 `action`/`project_path`（工具 zod 已证：其余全 optional），`preview: true` 为面板语义（人拉起即看）。ctx 来源**实施定则**：优先经 `this.dispatcher` 内部句柄构造真实 ToolContext 子集（复用真实链路而非复刻）；若 dispatcher 未暴露可用的构造面，退而在 WebGuiServer 侧合成最小 ctx（findGodot/setProjectDir/projectDir），二选一以最小侵入为准并在实施报告注明取舍
  - `editProject: (projectPath) => ...`：launch_editor 链仅 6 行（runtime.ts:157-170），接线层直接复刻（findGodot + detached spawn `--editor --path` + unref + error 监听），不抽函数
- **MRTR 说明**：面板直调 executeRunProject 不经 dispatcher 协议层（MRTR 确认门防"AI 自读自确认"，面板操作者是真人；白名单校验 + audit 日志为面板侧防线）

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

- hello 的 `projects` 字段初始化；`projects` SSE 事件刷新；`sessions` 事件刷新 running 徽章（复用现有快照数据对照 sessionId）
- 启动成功后项目行徽章在 sessions 帧到达时自动变绿（无需 projects 事件）

## 8. 验收标准（真机）

1. `POST /api/projects/scan` → 白名单各根下全部 project.godot 出现在面板（含 e2e-project fixture）
2. 行内 Run → 游戏窗口弹出 + 下半会话区出现 running 条目 + 徽章变绿；Edit → 编辑器窗口弹出
3. 手动删一个项目目录（或造 missing）→ 面板行红标 + Run/Edit 禁用；重新扫描不清除（只加不删）
4. 移除 → 确认框 → 行消失、磁盘无变化
5. 白名单外路径 add/start → 403 + 状态栏错误提示
6. 既有回归：runtime.test.js 全量、web-gui 12 文件、TUI 不受影响

## 9. 竞品参考（调研结论，2026-09-15）

| 来源 | 借鉴 | 弃用 |
|------|------|------|
| Godot 4.x Project Manager | Scan 递归发现+只加不删+Missing 清理语义；Run（不进编辑器直接跑）；紧凑列表+名称/路径/Last Edited | New Project/Import zip/rename（只读 FS）；tags（价值/代价比低） |
| Unity Hub | Missing 状态警示；"already open"运行态；表格行信息密度；Remove 确认框不删文件；即时搜索 | Cloud/版本控列；Add from repository；卡片视图 |
| Epic Launcher | （弱扫描是公认痛点——反面教材） | 默认目录约定（我们用显式白名单替代，恰解决其发现性痛点） |

## 10. 实施基线

master（d2f1e489 之后）；分支 `feat/web-gui-projects-panel`。实施顺序建议：run 链抽取（最高风险先做，既有测试守）→ projects-store → 端点 → SSE → 前端 → 接线 → 验收。
