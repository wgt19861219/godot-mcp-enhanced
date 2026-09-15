# Web GUI 项目面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web GUI 面板新增项目面板：白名单扫描发现项目 → 清单管理（名称/Last Edited/运行态/Missing）→ 行内 Run（弹游戏窗口）/Edit（弹编辑器）。

**Architecture:** `src/web-gui/projects-store.ts`（清单持久化 + BFS 扫描 + 并发三规则）+ server.ts 5 端点 + SSE `projects` 事件 + runtime.ts 的 `executeRunProject` 抽取（工具与面板双消费，行为零变）+ html.ts 左列改造（上项目下会话）。

**Tech Stack:** TypeScript (ES2022/strict/ESM, import 带 .js)、node:fs/promises、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-web-gui-projects-panel-design.md`（v2.1）。分支：`feat/web-gui-projects-panel`。

## Global Constraints

- 全部新代码 strict、禁 `any`、ESM import 带 `.js`、`prefer-const`；零新运行时依赖。
- **白名单铁律**：scan 根 = `getAllowedRealRoots()`（新增导出）；add/start 先过 `isPathInAllowedRoots`（拒 403）；PathError catch 转 403；READ_ONLY 模式 start 拒 403。
- **并发三规则（spec §3.1.1）**：扫描单飞互斥（进行中再 scan → `{started:false,reason:'scanning'}`）；add/remove/scan 合并共享 promise 串行队列；扫描合并阶段 re-read 最新清单。
- **清单语义**：只加不删；去重键 = normalizeProjectKey；上限 200 只逐出 `source:'scan'` 最旧（manual 豁免）；损坏 JSON → warn + 空清单重建；跨进程 last-writer-wins（声明性裁决，无防御代码）。
- **扫描边界**：限深 4 层；跳过 `node_modules/.git/.godot/build/dist`；单根条目上限 5000；不跟随目录符号链接（`isDirectory() && !isSymbolicLink()`，junction 实测判别不出则由限深/上限兜底）。
- 注入缺席 → 端点 503；hello `projects` 字段为 null。
- 测试放 `test/web-gui/`，新代码纳入覆盖率阈值（76/51/79/77）。
- 每 Task 完成 = `npm run lint && npm run build && npm test` 全绿后 commit（本机 Godot spawn 有随机 flaky：目标测试文件 + lint + build 必须绿，全量失败文件若为已知 flaky 单跑复验即可）。
- 注释中文；标识符英文；Conventional Commits 不 push。

---

### Task 1: 基础设施三导出 + run 链抽取

**Files:**
- Modify: `src/core/process-state.ts:209`（isAliveStatus 导出）
- Modify: `src/core/path-utils.ts:222` 之后（新增 getAllowedRealRoots）
- Modify: `src/core/ToolDispatcher.ts:139` 附近（新增 getContext getter）
- Modify: `src/tools/runtime.ts:171-361`（run_project case 抽取）
- Test: `test/web-gui/execute-run-project.test.ts`（新建）

**Interfaces:**
- Produces（后续任务消费）:
  - `export function isAliveStatus(st: RunSessionStatus): boolean`（process-state，原模块私有）
  - `export function getAllowedRealRoots(): string[]`（path-utils：`getAllowedProjectPaths().map(p => normalize(safeRealPath(p)))`；`safeRealPath` 若为模块私有则用其内部同款逻辑或导出复用）
  - `getContext(): ToolContext`（ToolDispatcher 只读 getter）
  - `export async function executeRunProject(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null>`（runtime.ts；返回 ToolResult 保真——case 体内有一处 errorResult）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/execute-run-project.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as ps from '../../src/core/process-state.js';
import { executeRunProject } from '../../src/tools/runtime.js';
import type { ToolContext } from '../../src/types.js';

// 轻量 ctx:映射到真实 process-state(与 ToolDispatcher 构造器 :104-116 同款)
function makeCtx(): ToolContext {
  return {
    opsScript: 'dummy.gd',
    findGodot: async () => 'C:/godot/fake.exe',
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skip) { ps.setRunningProcess(proc, skip); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d) { ps.setProjectDir(d); },
  } as unknown as ToolContext;
}

describe('executeRunProject 抽取等价性(spec §8.1)', () => {
  beforeEach(() => { ps.killAllRunSessions(); });

  it('isAliveStatus 已从 process-state 导出', async () => {
    const m = await import('../../src/core/process-state.js');
    expect(typeof (m as { isAliveStatus?: unknown }).isAliveStatus).toBe('function');
    expect(m.isAliveStatus!('running')).toBe(true);
    expect(m.isAliveStatus!('exited')).toBe(false);
  });

  it('getAllowedRealRoots 返回归一化数组(空 allowlist→空数组,由调用方 cwd 兜底)', async () => {
    const m = await import('../../src/core/path-utils.js');
    expect(Array.isArray(m.getAllowedRealRoots())).toBe(true);
  });

  it('非项目路径:返回 Not a Godot project 错误文本(PathError/存在性双保险)', async () => {
    const r = await executeRunProject({ action: 'run_project', project_path: 'D:/definitely/not/a/project' }, makeCtx());
    expect(r && !r.isError ? JSON.stringify(r) : String(r && (r as { content?: { text?: string }[] }).content?.[0]?.text ?? r)).toContain('project.godot');
  });

  it('白名单外路径:抛 PathError(端点层转 403 的契约)', async () => {
    await expect(
      executeRunProject({ action: 'run_project', project_path: 'Q:/outside/allowlist' }, makeCtx())
    ).rejects.toThrow();
  });
});
```

注：`ps.killAllRunSessions()` 与 resetState 的取舍——先 grep `test/web-gi*/run-sessions-*.test.ts` 里既有惯例（`resetState()` 若为测试辅助则优先）。`requireProjectPath` 的行为（白名单外抛 PathError）先 Read `src/helpers.ts:112-124` 核对后校准断言形态（可能返回默认路径而非抛错——**以实测为准**，用例断言跟随真实行为，报告注明）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/execute-run-project.test.ts`
Expected: FAIL —— executeRunProject is not a function

- [ ] **Step 3: 实现四处改动**

3a. `src/core/process-state.ts:209`：`function isAliveStatus(` 改 `export function isAliveStatus(`。

3b. `src/core/path-utils.ts` 在 `getAllowedProjectPaths` 之后新增：

```ts
/** Web GUI 扫描根(spec 2026-09-15 §3.2):allowlist 条目 realpath 归一化数组。
 *  与 isPathInAllowedRoots 的归一化语义同源(junction 防绕过);空数组=未配置,调用方自行 cwd 兜底。 */
export function getAllowedRealRoots(): string[] {
  return getAllowedProjectPaths().map(p => normalize(safeRealPath(p)));
}
```

（`safeRealPath`/`normalize` 若为模块内私有函数则直接可用；若在别处，import 之。）

3c. `src/core/ToolDispatcher.ts`（`getHealthMonitor()` 附近）：

```ts
  /** Web GUI 面板注入用(spec 2026-09-15 §6):只读暴露真实 ToolContext——
   *  面板直调 executeRunProject 复用真实链路(findGodot/setProjectDir 活跃指针等),零复刻。 */
  getContext(): ToolContext { return this.ctx; }
```

3d. `src/tools/runtime.ts`：`case 'run_project'` 整段（:172 到 :360 的 case 体）移入新导出函数，case 改为一行：

```ts
    case 'run_project':
      return executeRunProject(args, ctx);
```

函数（置于 handleTool 之前、computeRunTimeout 之后）：

```ts
/** run_project 核心链(Web GUI 项目面板 spec §6:工具与面板双消费)。
 *  行为零变:case 体逐字搬入;含 requireProjectPath(第二层白名单防线,PathError 由调用方转 403)。
 *  依赖面:ctx.findGodot/ctx.setProjectDir(真实活跃指针)/ctx.functionProfiler(可选);
 *  模块级 profilerOwnerKey 同文件共享(I-1 属主弱关联)。 */
export async function executeRunProject(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  // ← 原 case 体逐字搬入(:172-360),缩进减一层,return 形态不变(textResult/errorResult)
}
```

（纯移动：git diff 应显示删 N 行加 N-2 行，无逻辑改动。）

- [ ] **Step 4: 跑测试确认通过 + 抽取回归**

Run: `npx vitest run test/web-gi*/ execute-run-project.test.ts test/runtime.test.js test/runtime-timeout.test.ts test/process-state.test.js`
Expected: 新用例 PASS + 既有套件零回归

- [ ] **Step 5: 全量门禁 + commit**

```bash
npm run lint && npm run build && npm test
git add src/core/process-state.ts src/core/path-utils.ts src/core/ToolDispatcher.ts src/tools/runtime.ts test/web-gui/execute-run-project.test.ts
git commit -m "feat(web-gui): run 链抽取 executeRunProject+isAliveStatus/getAllowedRealRoots/getContext 三导出(行为零变)"
```

---

### Task 2: projects-store.ts（清单 + 扫描 + 并发三规则）

**Files:**
- Create: `src/web-gui/projects-store.ts`
- Test: `test/web-gui/projects-store.test.ts`

**Interfaces:**
- Consumes: `normalizeProjectKey`（process-state）、`getAllowedRealRoots`（Task 1）
- Produces（Task 3/5 消费）:

```ts
export interface ProjectEntry { path: string; name: string; addedAt: string; source: 'scan' | 'manual'; }
export interface ProjectView extends ProjectEntry { mtime: number | null; missing: boolean; running: boolean; sessionId: string | null; }
export interface ScanResult { started: boolean; reason?: 'scanning'; added?: number; scanned?: number; }

export class ProjectsStore {
  constructor(opts?: { dir?: string; getSessions?: () => { projectPath: string; status: string }[]; now?: () => Date });
  listProjects(): Promise<ProjectView[]>;                       // mtime 降序,Missing 沉底
  addProject(path: string, source?: 'manual'): Promise<{ ok: boolean; reason?: 'not_a_project' | 'duplicate' }>;
  removeProject(path: string): Promise<{ ok: boolean; reason?: 'not_found' }>;
  scanProjects(onProgress?: (found: number, scanned: number) => void): Promise<ScanResult>;
}
```

- [ ] **Step 1: 写失败测试**（覆盖 spec §8.1 边界矩阵——测试代码按 Interfaces 写全：限深 4 层 fixture 树 / 跳过目录 / 5000 上限（小目录树模拟不可行则改为注入 maxEntries 参数断言触发）/ 去重大小写 / 200 上限 manual 豁免 / 符号链接不跟随（POSIX skipIf win32）/ INI 解析回落 basename / 损坏重建 / 扫描互斥 started:false / 扫描中 add 不丢（串行队列 + re-read——用可控 now/慢 readdir 注入或分阶段调用模拟）/ UNRESTRICTED 拒绝（env stub）/ 空根数组（getAllowedRealRoots 无法注入——**给 store 加 `opts.roots?: () => string[]` 注入**，缺省用 getAllowedRealRoots；空数组时由 scanProjects 内部落 cwd））

```ts
// test/web-gui/projects-store.test.ts 骨架(实施者按上述矩阵展开为具体用例)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectsStore } from '../../src/web-gui/projects-store.js';

// 每用例: dir=mkdtemp; roots=()=>[dir]; 构造 fixture:
//   dir/pA/project.godot (config/name="游戏A")
//   dir/pB/project.godot (无 name → basename pB)
//   dir/deep1/deep2/deep3/deep4/deep5/project.godot (第5层不发现)
//   dir/node_modules/x/project.godot (跳过)
describe('ProjectsStore 边界矩阵(spec §3/§8.1)', () => { /* 逐矩阵项 it(...) */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/projects-store.test.ts`
Expected: FAIL —— Cannot find module

- [ ] **Step 3: 实现 projects-store.ts**

核心结构（完整实现，实施者照此展开）：

```ts
// src/web-gui/projects-store.ts
// Web GUI 项目面板数据层(spec 2026-09-15 v2.1):清单持久化(0o600+原子写)+白名单
// BFS 扫描(限深4/跳过清单/5000上限/不跟符号链接)+并发三规则(§3.1.1)+损坏重建。

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { normalizeProjectKey } from '../core/process-state.js';
import { getAllowedRealRoots } from '../core/path-utils.js';
import { getLogger } from '../core/logger.js';

const MAX_ENTRIES = 200;
const MAX_DEPTH = 4;
const MAX_TREE_ENTRIES = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', 'build', 'dist']);

// 并发规则2(spec §3.1.1):清单读改写串行队列
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

export class ProjectsStore { /* Interfaces 签名逐个实现 */ }
```

实现要点（逐条对应）：
- 文件路径 `join(dir ?? join(homedir(), '.godot-mcp', 'web-gui'), 'projects.json')`；写入 `mkdir(0o700)+writeFile(0o600)+rename`（.tmp→rename 原子写，照抄 registry.ts:49-55 模式）
- 读取：JSON.parse 失败 → `getLogger().warn('web-gui', ...)` + 返回空清单
- `listProjects()`：读清单 → 每项 `stat(join(path,'project.godot'))`（ENOENT → missing=true/mtime=null）→ `getSessions?.()` 对照（注入缺省空数组）→ running = sessions 中 projectPath 匹配且 status 为 starting/running/stopping → 排序（missing 沉底，mtime 降序 null 当 0）
- `addProject`：`enqueue` 内——resolve 归一 + project.godot 存在校验（not_a_project）+ 去重（normalizeProjectKey 对照）+ 200 上限逐出（只逐 scan 最旧）+ 写回
- `removeProject`：`enqueue` 内——过滤 + 写回
- `scanProjects(onProgress)`：
  - 模块级 `scanInFlight: Promise<...> | null`（规则1 单飞：非空 → `{started:false,reason:'scanning'}`）
  - `process.env.GODOT_MCP_UNRESTRICTED === 'true'` → throw（端点转 500，提示用 add）
  - roots = `this.optsRoots?.() ?? getAllowedRealRoots()`；空数组 → `[process.cwd()]`（spec IMP-2）
  - BFS：`readdir(root, { withFileTypes: true })`，`e.isDirectory() && !e.isSymbolicLink()` 才入队；depth>MAX_DEPTH 或 treeCount>MAX_TREE_ENTRIES 剪枝；遇 `project.godot` → 收集 `{path: resolve(cur), name: parseName(...), addedAt: now().toISOString(), source:'scan'}`
  - `parseName`：readFile project.godot → 逐行找 `[application]` 段内 `config/name="..."`（正则 `/^config\/name\s*=\s*"(.*)"/`，段外忽略）；失败/无 → basename
  - 合并（规则2 re-read）：`enqueue(async () => { const fresh = await this.readRaw(); /* 合并去重(旧条目优先保留原 source/addedAt) */ await this.writeRaw(merged); })`
  - 返回 `{started:true, added, scanned}`；finally 清 scanInFlight
- now 注入（测试 addedAt 排序可控）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/projects-store.test.ts`
Expected: 全矩阵 PASS

- [ ] **Step 5: 门禁 + commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/projects-store.ts test/web-gui/projects-store.test.ts
git commit -m "feat(web-gui): projects-store(清单0o600+BFS扫描边界+并发三规则+损坏重建+manual豁免)"
```

---

### Task 3: server.ts 5 端点 + SSE projects 事件

**Files:**
- Modify: `src/web-gui/server.ts`
- Test: `test/web-gui/server-projects.test.ts`（新建，或并入 server-http）

**Interfaces:**
- Consumes: `ProjectsStore`/`ProjectView`（Task 2）、`isAliveStatus`（Task 1）
- Produces（Task 4/5 消费）:
  - `WebGuiServerOptions` 新增可选注入：`projects?: { list: () => Promise<ProjectView[]>; scan: (onProgress?: (f: number, s: number) => void) => Promise<{ started: boolean; reason?: string; added?: number }>; add: (path: string) => Promise<{ ok: boolean; reason?: string }>; remove: (path: string) => Promise<{ ok: boolean; reason?: string }> }`、`runProject?: (projectPath: string) => Promise<unknown>`、`editProject?: (projectPath: string) => Promise<unknown>`、`isReadOnly?: () => boolean`
  - 端点行为契约：见 spec §4 表（403 白名单/readOnly、404、503 未注入、400 坏 body、200）
  - SSE：`projects` 事件（扫描进度节流 500ms / 完成 / 清单变更推快照）；`hello` payload 增 `projects`（注入缺席 null）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/server-projects.test.ts 核心用例(实施者按 spec §8.1 集成段展开)
// 复用 server-http.test.ts 的 mkdtemp registryDir/端口 0 起服惯例
// 用例: GET projects 200 数组 / scan 200 {started:true} + 未注入 scan 503 /
//      add 白名单外 403(vi.mock isPathInAllowedRoots 或用绝对外路径+env 隔离——
//      ⚠️ add 的白名单校验在 server.ts 端调 isPathInAllowedRoots(path),测试环境
//      setup.js 设 GODOT_MCP_UNRESTRICTED='true' 会让它恒 true——所以 add/start 的
//      403 用例须临时 delete 该 env(process.env 操作+afterEach 还原)或 vi.mock path-utils) /
//      start readOnly 403(isReadOnly 注入 ()=>true) / start 正常 200 调 runProject mock /
//      start 坏 body 400 / remove 404 / hello 含 projects 字段
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

server.ts 改动（路由表追加，全部在 authorized() 之后；add/start 的白名单/readOnly 先行）：

```ts
// 路由(handle 内 authorized 通过后):
if (url.pathname === '/api/projects' && req.method === 'GET') { /* this.opts.projects 缺席→503;list()→200 */ }
if (url.pathname === '/api/projects/scan' && req.method === 'POST') { /* 缺席 503;scan(进度→SSE broadcastProjects)→200 */ }
if (url.pathname === '/api/projects/add' && req.method === 'POST') { /* 缺席 503;isPathInAllowedRoots(path)→403;add()→not_a_project 404/duplicate 200 {ok:false}/ok 200 */ }
if (url.pathname === '/api/projects/remove' && req.method === 'POST') { /* 缺席 503;remove()→not_found 404/200 */ }
if (url.pathname === '/api/sessions/start' && req.method === 'POST') { /* 缺席 503;isReadOnly()→403;isPathInAllowedRoots→403;mode 缺省 'run';
   run→runProject(projectPath)(catch PathError→403) / edit→editProject(projectPath) → 200 {ok:true} */ }
```

- POST body 读取复用现有 `readJsonBody` 基建（handleSessionControl 的 for-await 模式；若无独立函数则顺手抽出共用）
- `add`/`remove`/`start` 成功后 `broadcastProjects()`（SSE 快照推送）+ `getLogger().info('web-gui', 'action=... path=... result=...')` audit
- `scan` 的 onProgress 节流 500ms 推 `{scanning:true,found,scanned}`，完成推 `{scanning:false,added,total}` + 快照
- `hello` payload 追加 `projects: this.opts.projects ? await this.opts.projects.list() : null`

- [ ] **Step 4: 确认通过 → Step 5: 门禁 + commit**

```bash
git add src/web-gui/server.ts test/web-gui/server-projects.test.ts
git commit -m "feat(web-gui): 项目 5 端点(白名单/readOnly/503 全态)+SSE projects 事件+hello 扩展"
```

---

### Task 4: html.ts 项目面板前端

**Files:**
- Modify: `src/web-gui/html.ts`
- Test: `test/web-gui/html.test.ts`（追加静态断言）

**Interfaces:**
- Consumes: Task 3 端点契约（GET /api/projects、POST scan/add/remove、POST /api/sessions/start）、SSE `projects` 事件、hello `projects` 字段
- Produces: 完整前端（Task 5 只接线无前端改动）

- [ ] **Step 1: 追加静态断言（红）**

```ts
// html.test.ts 追加:
it('项目面板机制标记(委托/搜索/添加/确认文案)', () => {
  expect(INDEX_HTML).toContain('closest(\'button[data-action]\')');      // 委托(项目行复用会话行模式或独立委托)
  expect(INDEX_HTML).toContain('data-action');                            // run|edit|remove|scan|add
  expect(INDEX_HTML).toContain('projSearch');                             // 搜索框
  expect(INDEX_HTML).toContain('仅从列表移除');                            // confirm 文案
  expect(INDEX_HTML).toContain('项目功能未配置');                          // hello projects:null 空态
});
```

- [ ] **Step 2: 红 → Step 3: 实现前端**

html.ts 改动（左列改造 + 新渲染函数，全 DOM API 零 innerHTML）：
- 布局：左列 section 重组——上 `<section>` 项目（标题「项目」+ 工具行[搜索框 projSearch + 扫描按钮 + 添加按钮] + 列表容器 `#projList`）、下原有运行会话 section；CSS 左列改 `grid-template-rows: auto 1fr auto 1fr` 或 flex 两段（55%/45%）
- `state.projects: ProjectView[] | null`（null=未配置空态）
- `renderProjects()`：过滤（projSearch 值子串匹配 name/path 不区分大小写）→ 行（Run ▶ / Edit ✎ / × 移除 + 名称[title=完整路径] + 相对时间 + 徽章[running 绿/missing 红]）；missing 行 Run/Edit disabled；相对时间函数 `fmtAgo(mtime)`（"3 分钟前"式，>1 天显示日期）
- 事件委托：项目区容器统一 `click` 委托 `data-action ∈ {run,edit,remove,scan,add}`：
  - run/edit → `fetch('/api/sessions/start',{method:'POST',headers:{'content-type':'application/json','x-gui-token':token},body:JSON.stringify({projectPath:data-path,mode})})` → statusBar「启动中…/编辑器拉起中…」→ 非-ok 显错（403 白名单外/readOnly 文案透传前 80 字符）
  - remove → `confirm('仅从列表移除，不删除文件。确定移除 ' + name + '?')` → POST remove
  - scan → POST scan → statusBar「扫描中…」（SSE projects 事件接管进度显示）
  - add → 内联输入行（input + 确认按钮）显隐切换 → POST add
- SSE：`es.addEventListener('projects', ...)`（scanning 分支更新 statusBar；完成/快照分支 `state.projects = payload; renderProjects()`）；`hello` 分支 `payload.projects !== undefined && (state.projects = payload.projects)`
- 移除确认用原生 `confirm()`（CSP 不受限）

- [ ] **Step 4: 绿（定向 html.test + 既有 web-gui 目录）→ Step 5: 门禁 + commit**

```bash
git add src/web-gui/html.ts test/web-gui/html.test.ts
git commit -m "feat(web-gui): 项目面板前端(扫描/添加/搜索/Run/Edit/移除委托+Missing 态+相对时间)"
```

---

### Task 5: GodotServer 接线 + 门禁 + 真机验收

**Files:**
- Modify: `src/GodotServer.ts`（run() 的 WebGuiServer 构造处扩注入）
- Test: `test/web-gui/wiring-projects.test.ts`（新建）
- Create: `.superpowers/sdd/projects-acceptance.mjs`（验收脚本，目录自忽略惯例）

**Interfaces:**
- Consumes: 全部前序（executeRunProject/getContext/ProjectsStore/端点）
- Produces: 生产接线 + 验收证据

- [ ] **Step 1: 写失败测试**（wiring：env-gate 同款 vi.mock 模式断言注入集合——WebGuiServer 构造参数含 projects/runProject/editProject/isReadOnly 四键；readOnly 状态源 = `process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true'`（与 index.ts:94 同源））

- [ ] **Step 2: 红 → Step 3: 实现接线**

```ts
// GodotServer.run() 的 WebGuiServer 构造扩为(在现有 getSessions/getIndexHtml/stopSession/removeSession 之后):
const projectsStore = new ProjectsStore();
this.webGuiServer = new WebGuiServer({
  getSessions: () => ps.listRunSessionsDetailed(),
  getIndexHtml: () => INDEX_HTML,
  stopSession: async (p) => { /* 现有实现不动 */ },
  removeSession: (p) => ps.removeRunSession(p),
  projects: {
    list: async () => projectsStore.listProjects(/* getSessions 组装在 store 内经构造注入 */),
    scan: (onProgress) => projectsStore.scanProjects(onProgress),
    add: (path) => projectsStore.addProject(path),
    remove: (path) => projectsStore.removeProject(path),
  },
  runProject: async (p) => {
    const ctx = this.dispatcher!.getContext();   // Task 1 getter(真实链路)
    const result = await executeRunProject({ action: 'run_project', project_path: p, preview: true }, ctx);
    return result;   // 端点只看 resolve/reject
  },
  editProject: async (p) => {
    // launch_editor 链复刻(runtime.ts:157-168,6 行)
    const godot = await findGodot();
    const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore', env: buildSafeEnv() });
    child.on('error', (err) => getLogger().error('web-gui', `Failed to launch editor: ${err.message}`));
    child.unref();
  },
  isReadOnly: () => process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true',
});
```

（`ProjectsStore` 构造处传 `getSessions: () => ps.listRunSessionsDetailed()` 满足 running 判定；import 区补 `ProjectsStore`/`executeRunProject`/`buildSafeEnv`——均在合法方向：应用层 → web-gui/tools。）

- [ ] **Step 4: 定向绿 + 全量门禁**

Run: `npx vitest run test/web-gui/ && npm run lint && npm run build && npm test`

- [ ] **Step 5: 真机验收脚本 + 跑通**

`.superpowers/sdd/projects-acceptance.mjs`（spawn `node build/index.js` env 剔除 `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` + stdin 保活 `sleep 120 |`，同前批模式）：
1. 读登记拿 port/token → `GET /api/projects` 200
2. `POST /api/projects/scan` → 轮询 SSE 或 2s 后 `GET /api/projects` 断言含 `e2e-project`
3. `POST /api/projects/add` 白名单外路径（`Q:/nope`）→ 断言 403
4. `POST /api/sessions/start {projectPath: e2e 绝对路径, mode:'run'}` → 200；1s 后 `/api/sessions` 断言 e2e running；`POST /api/sessions/stop` 收尾
5. finally kill + unlink 登记
真跑贴输出，`OVERALL: ACCEPTANCE PASS`。

- [ ] **Step 6: commit**

```bash
git add src/GodotServer.ts test/web-gui/wiring-projects.test.ts
git commit -m "feat(web-gui): 项目面板生产接线(getContext 真实链路+editProject 复刻+readOnly 门)+真机验收 PASS"
```

---

## Self-Review 结论（已自查修正）

1. **Spec 覆盖**：§3（Task 2）/§4 五端点+SSE（Task 3）/§6 抽取+三导出（Task 1）/§7 前端（Task 4）/§8 验收+§8.1 测试（各任务 Step 1 + Task 5 脚本）——全覆盖；§3.1.1 规则3（跨进程 last-writer-wins）为声明性裁决无防御代码（复核确认合理省略）。
2. **占位符扫描**：Task 2/3 的测试骨架标注"实施者按矩阵展开"——矩阵项已逐条枚举（非 TBD）；Task 1 Step 1 的 PathError 断言标注"以实测为准校准"（给了核查命令 `Read src/helpers.ts:112-124`）。
3. **类型一致性**：`ProjectsStore` 四方法签名（Task 2 Produces = Task 3 `projects` 注入对象 = Task 5 接线）；`executeRunProject(args, ctx): Promise<ToolResult | null>`（Task 1 = Task 5 消费）；`ProjectView` 字段（Task 2 = Task 4 前端消费 name/path/mtime/missing/running）。
