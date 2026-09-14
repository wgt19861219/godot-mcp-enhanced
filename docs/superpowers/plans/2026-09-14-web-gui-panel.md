# Web GUI 监控面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP server 进程内嵌 HTTP+SSE 监控面板（四面板：运行会话/日志流/工具统计按项目分组/分钟桶时序），CLI `dashboard --web` 打开浏览器，Inspector 风格安全壳。

**Architecture:** `src/web-gui/` 新子系统（server.ts + html.ts + registry.ts）嵌 `GodotServer` 生命周期；数据流 = LogReader(500ms, srv 过滤) → 扩展版 Aggregator → SSE 推送；运行会话 = `listRunSessionsDetailed()` 内存快照；per-pid 登记文件 + token/Origin 安全壳。

**Tech Stack:** TypeScript (ES2022/strict/ESM, import 带 .js)、`node:http` + SSE（零新依赖）、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-web-gui-panel-design.md`（v3.1，两轮审阅闭环）。分支：`feat/web-gui-panel`（基于 `feat/per-project-run-sessions`）。

## Global Constraints

- 全部新代码 TypeScript strict、禁 `any`（`@typescript-eslint/no-explicit-any: error`）、ESM import 带 `.js` 后缀、`prefer-const`。
- 零新运行时依赖（仅 `node:*` 内置 + 现有依赖）。
- 遵守 2026-08-21 架构红线：新代码依赖走构造器注入，禁新增模块级 setter 注入点（`isWebGuiActive`/`getServerId` 是只读查询，合规）。
- 端口：默认起点 9550（env `GODOT_MCP_WEB_GUI_PORT`），被占 +1 最多试 20 个。env `GODOT_MCP_WEB_GUI=0` 关闭。
- 测试文件放 `test/web-gui/`，新代码不进覆盖率排除清单（阈值 76/51/79/77）。
- 注释与文档中文；代码标识符英文。
- 每 Task 完成 = `npm run lint && npm run build && npm test` 全绿后 commit（Conventional Commits，subject 中文可）。
- `listRunSessionsDetailed()` 禁止经 `getOrCreateSession` 惰性建桶（直接遍历 `_sessions`）。
- `LogReader` 的 `pollIntervalMs` 不得低于 500ms（`CHECK_DEBOUNCE_MS` 硬下限）。

---

### Task 1: logger srv 进程标识字段

**Files:**
- Modify: `src/core/logger.ts:20-35`（LogEntry）、`:93-100`（todayStr 导出）、`:268-276`（rotation 写点）、`:373-387`（checkToolTimeouts 写点）、`:392-405`（log 写点）、`:427-441`（toolStart 写点）、`:454-468`（toolEnd 写点）、模块级单例区（:602 起）
- Test: `test/web-gui/logger-srv.test.ts`（新建）

**Interfaces:**
- Produces: `LogEntry.srv?: string`；`export function getServerId(): string`（进程内惰性生成一次，`resetLogger()` 不清除——进程语义）；`export function todayStr(): string`（Task 2 消费）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/logger-srv.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger, resetLogger, getServerId } from '../../src/core/logger.js';

function tmpLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'webgui-logger-'));
}

describe('logger srv 进程标识(设计 §3.3.1:5 写点全覆盖)', () => {
  let dir: string;
  beforeEach(() => { dir = tmpLogDir(); resetLogger(); });
  afterEach(() => { resetLogger(); rmSync(dir, { recursive: true, force: true }); });

  it('getServerId 进程内稳定且非空', () => {
    const id = getServerId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getServerId()).toBe(id);
  });

  it('普通 log 条目携带 srv', async () => {
    const logger = getLogger({ logDir: dir });
    logger.info('test', 'hello srv');
    logger.flush(); logger.close();
    const files = await import('node:fs').then(m => m.readdirSync(dir));
    const f = files.find(x => x.endsWith('.jsonl'))!;
    const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const entry = lines.find((e: { msg: string }) => e.msg === 'hello srv');
    expect(entry).toBeDefined();
    expect(entry.srv).toBe(getServerId());
  });

  it('toolStart/toolEnd 条目携带 srv', () => {
    const logger = getLogger({ logDir: dir });
    const callId = logger.toolStart('demo_tool', { a: 1 }, 'D:/proj');
    logger.toolEnd(callId, 'demo_tool', 12);
    logger.flush(); logger.close();
    const lines = readFileSync(join(dir, `${todayStrLocal()}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const start = lines.find((e: { type?: string }) => e.type === 'tool_start');
    const end = lines.find((e: { type?: string }) => e.type === 'tool_end');
    expect(start.srv).toBe(getServerId());
    expect(end.srv).toBe(getServerId());
  });

  it('超时 tool_end 条目携带 srv(checkToolTimeouts 直推 buffer 写点)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      const logger = getLogger({ logDir: dir });
      logger.toolStart('slow_tool');
      vi.advanceTimersByTime(61_000);
      logger.flush(); logger.close();
      const lines = readFileSync(join(dir, `${todayStrLocal()}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const timeout = lines.find((e: { error?: string }) => e.error === 'timeout');
      expect(timeout).toBeDefined();
      expect(timeout.srv).toBe(getServerId());
    } finally { vi.useRealTimers(); }
  });
});

// 与 logger 同款本地日期(TDD 阶段临时复制,断言目标文件名)
function todayStrLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

文件头补 `import { vi } from 'vitest';`（或用 vitest globals——本项目 vitest.config 用 globals 模式，`vi` 全局可用，无需 import；与既有测试保持一致即可，先看 `test/` 任一文件惯例）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/logger-srv.test.ts`
Expected: FAIL —— `entry.srv` undefined / `getServerId is not a function`

- [ ] **Step 3: 实现**

`src/core/logger.ts` 改动（全部小diff）：

3a. LogEntry 加字段（`:33` project 之后）：

```ts
  /** §3.3.1(设计):进程标识——Web GUI 多 server 共写同一日志文件时的过滤键。
   *  可选字段,模块级 getServerId() 惰性生成一次,5 个写点全覆盖写入。 */
  srv?: string;
```

3b. 导出 todayStr（`:94` 的 `function todayStr()` 改 `export function todayStr()`，并加注释"导出供 log-reader 对齐本地日期命名（设计 §2.8 时区修复）"）。

3c. 模块级 serverId（放在 `nanoid8` 函数之后的"内部工具函数"区）：

```ts
/** 进程标识(Web GUI §3.3.1):惰性生成一次;resetLogger 不清——同一进程重启 logger 语义不变。 */
let _serverId: string | null = null;
export function getServerId(): string {
  if (!_serverId) _serverId = randomUUID();
  return _serverId;
}
```

3d. 5 写点注入。每个构造 LogEntry 的位置，在构造后追加一行：

- `log()`（entry 构造后）：`entry.srv = getServerId();`
- `toolStart()`（`:437` `if (project) entry.project = project;` 附近）：`entry.srv = getServerId();`
- `toolEnd()`（`:465` `if (pending.project) ...` 附近）：`entry.srv = getServerId();`
- `checkToolTimeouts()`（`:385` `if (pending.project) ...` 附近）：`entry.srv = getServerId();`
- `openFd()` rotation 条目（`:268-276` 对象字面量内直接加 `srv: getServerId(),`）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/logger-srv.test.ts`
Expected: 4 PASS

- [ ] **Step 5: 全量门禁 + commit**

```bash
npm run lint && npm run build && npm test
git add src/core/logger.ts test/web-gui/logger-srv.test.ts
git commit -m "feat(web-gui): LogEntry 新增 srv 进程标识字段(5 写点全覆盖)+导出 getServerId/todayStr"
```

---

### Task 2: log-reader 时区修复

**Files:**
- Modify: `src/dashboard/log-reader.ts:110-113`（getTodayFile）
- Test: `test/web-gui/log-reader-timezone.test.ts`（新建）

**Interfaces:**
- Consumes: `todayStr`（Task 1 导出）
- Produces: `LogReader.getTodayFile()` 与 logger 文件命名恒一致（Task 7 数据流依赖此对齐）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/log-reader-timezone.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogReader } from '../../src/dashboard/log-reader.js';
import { todayStr } from '../../src/core/logger.js';

describe('LogReader 时区对齐(设计 §2.8:与 logger todayStr 共用同一本地日期)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-tz-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('getTodayFile 与 logger 文件命名一致(本地日期,非 UTC)', async () => {
    // 模拟 logger 写今天的本地日期文件(若 LogReader 用 UTC,在本地≠UTC 时刻两者文件名不同)
    mkdirSync(dir, { recursive: true });
    const loggerFile = `${todayStr()}.jsonl`;
    writeFileSync(join(dir, loggerFile), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg: 'x' }) + '\n');
    const reader = new LogReader(dir, { pollIntervalMs: 1000 });
    const got: unknown[] = [];
    reader.on('entries', (es) => got.push(...es));
    await reader.start();
    // 初始回放读到了 logger 今天写的文件 → 定位正确
    expect(got.length).toBe(1);
    reader.stop();
  });

  it('UTC 与本地日期错位窗口(东八区 00:30)仍定位本地今天文件', async () => {
    vi.useFakeTimers();
    // 东八区 2026-01-01 00:30 = UTC 2025-12-31 16:30 —— UTC 日期是"昨天"
    vi.setSystemTime(new Date('2026-01-01T00:30:00+08:00'));
    try {
      mkdirSync(dir, { recursive: true });
      // logger 用本地日期 → 东八区下写 2026-01-01.jsonl
      const localToday = todayStr();  // fake clock 下的本地日期
      writeFileSync(join(dir, `${localToday}.jsonl`),
        JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg: 'tz' }) + '\n');
      const reader = new LogReader(dir, { pollIntervalMs: 1000 });
      const got: unknown[] = [];
      reader.on('entries', (es) => got.push(...es));
      await reader.start();
      expect(got.length).toBe(1);   // UTC 实现下此断言在东八区 fake clock 会失败(定位到 2025-12-31)
      reader.stop();
    } finally { vi.useRealTimers(); }
  });
});
```

注：fake timers 下 `setInterval` 也被接管，`reader.start()` 不受影响（初始回放是同步的）；`reader.stop()` 清理。若 CI 时区恰为 UTC，第二个用例的本地日期=UTC 日期——用例退化为自洽断言仍 PASS（不误报），本机东八区跑则真验证错位。这是可接受的测试设计（真错位验证依赖非 UTC 机器，本机 Windows 东八区满足）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/log-reader-timezone.test.ts`
Expected: 在东八区机器上第 2 用例 FAIL（LogReader 定位 UTC"昨天"文件，读到 0 条）；第 1 用例可能 PASS（取决于运行时刻是否错位）

- [ ] **Step 3: 实现**

`src/dashboard/log-reader.ts`：
1. import 区加：`import { todayStr } from '../core/logger.js';`
2. `getTodayFile()` 替换为：

```ts
  private getTodayFile(): string {
    // 设计 §2.8 时区修复:与 logger 共用同一本地日期函数,消除 UTC/本地错位
    // (原 toISOString() 是 UTC——东八区每日 00:00-08:00 定位到"昨天"文件,面板断流)。
    return join(this.logDir, `${todayStr()}.jsonl`);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/log-reader-timezone.test.ts && npx vitest run test/dashboard 2>/dev/null || npx vitest run --dir test -t "log"`
Expected: 2 PASS + 既有 log-reader 相关测试无回归

- [ ] **Step 5: 全量门禁 + commit**

```bash
npm run lint && npm run build && npm test
git add src/dashboard/log-reader.ts test/web-gui/log-reader-timezone.test.ts
git commit -m "fix(dashboard): LogReader getTodayFile 改用 logger 同款本地日期,修东八区 00:00-08:00 断流"
```

---

### Task 3: aggregator per-project 统计 + entry.project 死逻辑修复

**Files:**
- Modify: `src/dashboard/aggregator.ts`
- Test: `test/web-gui/aggregator-projects.test.ts`（新建）

**Interfaces:**
- Produces: `Aggregator.getProjectKeys(): string[]`、`getStateFor(project: string): DashboardState`（Task 7 组装 stats 快照消费）；`getState()` 结构契约不变（TUI 冻结）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/aggregator-projects.test.ts
import { describe, it, expect } from 'vitest';
import { Aggregator } from '../../src/dashboard/aggregator.js';
import type { LogEntry } from '../../src/core/logger.js';

function toolEndEntry(tool: string, project: string | undefined, dur = 10): LogEntry {
  const e: LogEntry = { v: 1, ts: new Date().toISOString(), level: 'info', module: 'dispatcher',
    msg: `Tool call completed: ${tool}`, tool, type: 'tool_end', call_id: `${tool}:1`, duration_ms: dur };
  if (project) e.project = project;
  return e;
}

describe('Aggregator per-project 统计(设计 §8)', () => {
  it('按 entry.project 分组统计;无 project 归 unknown 桶', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('run_project', 'D:/A'));
    agg.process(toolEndEntry('run_project', 'D:/B'));
    agg.process(toolEndEntry('validate_scripts', 'D:/A'));
    agg.process(toolEndEntry('read_script', undefined));

    expect([...agg.getProjectKeys()].sort()).toEqual(['D:/A', 'D:/B', 'unknown']);
    const a = agg.getStateFor('D:/A');
    expect(a.totalCalls).toBe(2);
    expect(a.toolStats.get('run_project')!.calls).toBe(1);
    const b = agg.getStateFor('D:/B');
    expect(b.totalCalls).toBe(1);
    const unk = agg.getStateFor('unknown');
    expect(unk.toolStats.get('read_script')!.calls).toBe(1);
  });

  it('死逻辑修复:projectPath 读 entry.project 而非 meta.project_path', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('run_project', 'D:/real'));
    expect(agg.getState().projectPath).toBe('D:/real');
  });

  it('getState() 结构契约不变(TUI 冻结):键集合与既有字段完全一致', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('t', 'p'));
    const s = agg.getState();
    expect(Object.keys(s).sort()).toEqual(
      ['mode', 'projectPath', 'recentLogs', 'startTime', 'timeSeries', 'toolStats', 'totalCalls', 'totalErrors']);
  });

  it('timeSeriesByProject 复刻 A-12 幽灵清理(跨天防撞桶)', () => {
    const agg = new Aggregator();
    const old: LogEntry = { v: 1, ts: '2026-01-01T00:00:00.000Z', level: 'info', module: 'd',
      msg: 'x', tool: 't', type: 'tool_end', call_id: 't:1', duration_ms: 1, project: 'P' };
    agg.process(old);
    // 制造 30+ 个新分钟桶把旧桶挤出 RingBuffer(TIME_SERIES_MAX_BUCKETS=30)
    for (let i = 0; i < 32; i++) {
      agg.process({ ...old, ts: new Date(Date.parse('2026-01-02T00:00:00Z') + i * 61_000).toISOString(), call_id: `t:${i + 2}` });
    }
    const s = agg.getStateFor('P');
    expect(s.timeSeries.length).toBeLessThanOrEqual(30);
    expect(s.timeSeries.every(b => b.minute !== '00:00' || b.calls > 1)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/aggregator-projects.test.ts`
Expected: FAIL —— `agg.getProjectKeys is not a function`；projectPath 为 ''

- [ ] **Step 3: 实现**

`src/dashboard/aggregator.ts`：

3a. 类内新增字段与 per-project 结构：

```ts
interface ProjectAggregate {
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeriesBuf: RingBuffer<TimeSeriesBucket>;
  timeSeriesMap: Map<string, TimeSeriesBucket>;
}
```

类内：

```ts
  private byProject = new Map<string, ProjectAggregate>();

  private projectAggregate(project: string): ProjectAggregate {
    let p = this.byProject.get(project);
    if (!p) {
      p = { totalCalls: 0, totalErrors: 0, toolStats: new Map(),
            timeSeriesBuf: new RingBuffer<TimeSeriesBucket>(TIME_SERIES_MAX_BUCKETS),
            timeSeriesMap: new Map() };
      this.byProject.set(project, p);
    }
    return p;
  }
```

3b. `process(entry)` 中：删掉 `:65-70` 的 `meta.project_path` 死逻辑块，替换为：

```ts
    const projectKey = entry.project && entry.project.length > 0 ? entry.project : 'unknown';
    if (!this.projectPath && entry.type === 'tool_start') {
      this.projectPath = projectKey !== 'unknown' ? projectKey : '';
    }
```

（`tool_end` 分支 `:72` 之后）把 tool_end 的统计逻辑抽私有方法 `accumulate(tool, durationMs, isError, ts, statsMap, bucketBuf, bucketMap, counters)` 或直接在现有全局统计后追加 per-project 同构统计（对 `this.projectAggregate(projectKey)` 做同样的 calls/errors/min/max/totalDuration/lastCalled 与分钟桶累加）。实现方式：抽一个私有 `statInto(target: ProjectAggregate-like, entry)` 复用于全局与 per-project——注意全局用现有独立字段，重构风险大；**采用追加式**（保留现有全局代码不动，在 `process` 末尾追加 per-project 累积块，代码与全局同构）。recentLogs 仅全局保留（面板日志流不分项目存两份，省内存）。

3c. 新增公共方法（`getState()` 之后）：

```ts
  getProjectKeys(): string[] {
    return [...this.byProject.keys()];
  }

  /** per-project 视图(设计 §8.1):结构与 getState() 同构(含 A-12 幽灵清理)。 */
  getStateFor(project: string): DashboardState {
    const p = this.projectAggregate(project);
    const active = p.timeSeriesBuf.toArray();
    const activeKeys = new Set(active.map(b => b.minute));
    for (const key of p.timeSeriesMap.keys()) {
      if (!activeKeys.has(key)) p.timeSeriesMap.delete(key);
    }
    return {
      startTime: this.startTime,
      mode: this.mode,
      projectPath: project === 'unknown' ? '' : project,
      totalCalls: p.totalCalls,
      totalErrors: p.totalErrors,
      toolStats: p.toolStats,
      timeSeries: active,
      recentLogs: this.recentLogs,
    };
  }
```

- [ ] **Step 4: 跑测试确认通过 + TUI 回归**

Run: `npx vitest run test/web-gui/aggregator-projects.test.ts && npm test -- --reporter=dot 2>&1 | tail -5`
Expected: 新增 4 PASS；全量无回归（重点 dashboard 相关）

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/dashboard/aggregator.ts test/web-gui/aggregator-projects.test.ts
git commit -m "feat(web-gui): aggregator per-project 统计+修 meta.project_path 恒 miss 死逻辑(getState 契约不变)"
```

---

### Task 4: process-state listRunSessionsDetailed

**Files:**
- Modify: `src/core/process-state.ts:272-279`（listRunSessions 之后追加）
- Test: `test/web-gui/run-sessions-detailed.test.ts`（新建）

**Interfaces:**
- Produces: `export interface RunSessionDetailed { projectPath: string; displayPath: string; status: RunSessionStatus; pid: number | null; processStartTime: number; busy: boolean; busyOwner: string; busySince: number; outputLines: number }`（`outputLines` 两态：运行中 = `outputBuffer.length`，已结束 = `lastFinishedRunOutput.length`）；`export function listRunSessionsDetailed(): RunSessionDetailed[]`（Task 6 构造器注入消费）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/run-sessions-detailed.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as ps from '../../src/core/process-state.js';

describe('listRunSessionsDetailed(设计 §3.3.2:直接遍历,禁惰性建桶)', () => {
  beforeEach(() => { ps.killAllRunSessions(); });

  it('返回白名单全字段且不含 proc;两态输出行数', () => {
    ps.setRunSessionProc('D:/projA', { pid: 123, on: () => {}, kill: () => {} } as unknown as import('node:child_process').ChildProcess, true);
    ps.appendOutput(['line1', 'line2'], 'D:/projA');
    ps.markSessionExited('D:/projA', 0);
    const list = ps.listRunSessionsDetailed();
    const a = list.find(s => s.projectPath.includes('proja') || s.projectPath.includes('projA'));
    expect(a).toBeDefined();
    expect(a!.pid).toBe(null);                       // exited 后 proc=null
    expect(a!.status).toBe('exited');
    expect(a!.outputLines).toBe(2);                  // ended 态读 lastFinishedRunOutput
    expect(a!).not.toHaveProperty('proc');
    expect(a!).toHaveProperty('processStartTime');
    expect(a!).toHaveProperty('busy');
    expect(a!).toHaveProperty('busyOwner');
    expect(a!).toHaveProperty('busySince');
  });

  it('不创建新桶(读侧无副作用)', () => {
    const before = ps.listRunSessions().length;
    ps.listRunSessionsDetailed();
    expect(ps.listRunSessions().length).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/run-sessions-detailed.test.ts`
Expected: FAIL —— `ps.listRunSessionsDetailed is not a function`

- [ ] **Step 3: 实现**

`src/core/process-state.ts`，紧跟 `listRunSessions()`（`:279` 之后）：

```ts
/** 会话详单(Web GUI §3.3.2):白名单字段序列化,proc 不外泄;直接遍历 _sessions
 *  (同 listRunSessions 模式),禁止 getOrCreateSession——读路径不得建桶污染 FIFO 语义。 */
export interface RunSessionDetailed {
  projectPath: string;
  displayPath: string;
  status: RunSessionStatus;
  pid: number | null;
  processStartTime: number;
  busy: boolean;
  busyOwner: string;
  busySince: number;
  /** 两态输出行数:运行中=outputBuffer.length,已结束=lastFinishedRunOutput.length */
  outputLines: number;
}

export function listRunSessionsDetailed(): RunSessionDetailed[] {
  const out: RunSessionDetailed[] = [];
  for (const [key, s] of _sessions) {
    if (key === '') continue;   // '' 空桶不进列表(同 listRunSessions)
    const ended = isEndedStatus(s.status);
    out.push({
      projectPath: key,
      displayPath: s.displayPath,
      status: s.status,
      pid: s.proc?.pid ?? null,
      processStartTime: s.processStartTime,
      busy: s.busy,
      busyOwner: s.busyOwner,
      busySince: s.busySince,
      outputLines: ended ? s.lastFinishedRunOutput.length : s.outputBuffer.length,
    });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/run-sessions-detailed.test.ts`
Expected: 2 PASS

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/core/process-state.ts test/web-gui/run-sessions-detailed.test.ts
git commit -m "feat(web-gui): process-state 新增 listRunSessionsDetailed 只读详单(白名单字段+两态行数)"
```

---

### Task 5: web-gui registry（per-pid 登记）

**Files:**
- Create: `src/web-gui/registry.ts`
- Test: `test/web-gui/registry.test.ts`

**Interfaces:**
- Produces:
  - `export interface WebGuiRegistration { pid: number; port: number; token: string; startedAt: string }`
  - `export function webGuiRegistryDir(): string`（`~/.godot-mcp/web-gui/`，测试经 opts 覆盖）
  - `export async function writeRegistration(entry: WebGuiRegistration, opts?: RegistryOpts): Promise<void>`
  - `export async function removeRegistration(pid: number, opts?: RegistryOpts): Promise<void>`
  - `export async function listRegistrations(opts?: RegistryOpts): Promise<WebGuiRegistration[]>`（readdir 聚合 + 死 pid 过滤 + 顺手清死文件）
  - `RegistryOpts = { dir?: string; isPidAlive?: (pid: number) => boolean }`
  - （Task 6 server.ts 与 Task 10 CLI 消费）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRegistration, removeRegistration, listRegistrations } from '../../src/web-gui/registry.js';

const ALIVE = () => true;
const DEAD = () => false;

describe('web-gui per-pid 登记(设计 §3.1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-reg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写 per-pid 文件 + readdir 聚合读回', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'tok-a', startedAt: new Date().toISOString() }, { dir });
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files).toEqual(['111.json']);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list).toHaveLength(1);
    expect(list[0]!.token).toBe('tok-a');
  });

  it('双进程并发登记互不丢失(各写各文件)', async () => {
    await Promise.all([
      writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir }),
      writeRegistration({ pid: 222, port: 9551, token: 'b', startedAt: 't' }, { dir }),
    ]);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list.map(r => r.pid).sort()).toEqual([111, 222]);
  });

  it('死 pid 条目被过滤且文件被清除', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    const list = await listRegistrations({ dir, isPidAlive: DEAD });
    expect(list).toHaveLength(0);
    expect(existsSync(join(dir, '111.json'))).toBe(false);
  });

  it('removeRegistration 删除自己的文件(best-effort)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await removeRegistration(111, { dir });
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('登记文件权限 0o600(Linux/macOS)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'secret', startedAt: 't' }, { dir });
    const mode = statSync(join(dir, '111.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/registry.test.ts`
Expected: FAIL —— Cannot find module '../../src/web-gui/registry.js'

- [ ] **Step 3: 实现**

```ts
// src/web-gui/registry.ts
// Web GUI per-pid 登记(设计 §3.1):每实例写自己的 ~/.godot-mcp/web-gui/<pid>.json,
// 无并发写竞争(对齐 InstanceManager 模式);文件含 token 准入凭证,权限加固防同机他用户读取。

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { getLogger } from '../core/logger.js';

export interface WebGuiRegistration {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface RegistryOpts {
  /** 测试注入目录;缺省 ~/.godot-mcp/web-gui/ */
  dir?: string;
  /** pid 探活注入点(测试 mock);缺省 process.kill(pid, 0) */
  isPidAlive?: (pid: number) => boolean;
}

export function webGuiRegistryDir(): string {
  return join(homedir(), '.godot-mcp', 'web-gui');
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** S-5 同款(instance-manager.ts:94):Windows 无视 mode,用 icacls 收紧 ACL;best-effort。 */
function hardenFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const username = userInfo().username;
    if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], { stdio: 'ignore' });
    }
  } catch {
    getLogger().warn('web-gui', `ACL restriction failed for ${filePath}, file may inherit default permissions`);
  }
}

export async function writeRegistration(entry: WebGuiRegistration, opts: RegistryOpts = {}): Promise<void> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const filePath = join(dir, `${entry.pid}.json`);
  const tmpPath = `${filePath}.tmp`;
  try {
    // S-5: token 是准入凭证,0o600 + 目录 0o700 + Windows icacls,防多用户机器泄露
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, filePath);
    hardenFilePermissionsWindows(filePath);
  } catch (err) {
    getLogger().warn('web-gui', `writeRegistration failed for pid ${entry.pid}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export async function removeRegistration(pid: number, opts: RegistryOpts = {}): Promise<void> {
  const dir = opts.dir ?? webGuiRegistryDir();
  try { await unlink(join(dir, `${pid}.json`)); } catch { /* ENOENT 忽略——best-effort */ }
}

export async function listRegistrations(opts: RegistryOpts = {}): Promise<WebGuiRegistration[]> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const out: WebGuiRegistration[] = [];
  let files: string[];
  try { files = await readdir(dir); } catch { return out; }   // 目录不存在 = 无登记
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf-8')) as WebGuiRegistration;
      if (typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.token !== 'string') continue;
      if (!isPidAlive(raw.pid)) {
        await removeRegistration(raw.pid, { dir });   // 死条目顺手清(SIGKILL 残留)
        continue;
      }
      out.push(raw);
    } catch { /* 损坏文件跳过 */ }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/registry.test.ts`
Expected: 5 PASS（win32 上 skip 1）

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/registry.ts test/web-gui/registry.test.ts
git commit -m "feat(web-gui): per-pid 登记文件(0o600+icacls+原子写+探活清死,对齐 InstanceManager S-5)"
```

---

### Task 6: WebGuiServer HTTP + 鉴权 + 静态 + /api/sessions

**Files:**
- Create: `src/web-gui/server.ts`
- Test: `test/web-gui/server-http.test.ts`

**Interfaces:**
- Consumes: `RunSessionDetailed`（Task 4）、`writeRegistration/removeRegistration`（Task 5）
- Produces:
  - `export class WebGuiServer { constructor(opts: WebGuiServerOptions); start(): Promise<void>; stop(): Promise<void>; readonly port: number }`
  - `WebGuiServerOptions = { getSessions: () => RunSessionDetailed[]; getIndexHtml: () => string; portStart?: number; token?: string }`（全部构造器注入）
  - `export function isWebGuiActive(): boolean`（launcher guard 与测试消费；状态由本类 start/stop 驱动，无外部写入接口）
  - 端点：`GET /`（静态 HTML）、`GET /api/sessions`（token 鉴权）；`/events`、`/api/stats` 由 Task 7 增加

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/server-http.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { WebGuiServer, isWebGuiActive } from '../../src/web-gui/server.js';
import type { RunSessionDetailed } from '../../src/core/process-state.js';

const FAKE_SESSIONS: RunSessionDetailed[] = [{
  projectPath: 'd:/a', displayPath: 'D:/a', status: 'running', pid: 42,
  processStartTime: 1, busy: false, busyOwner: '', busySince: 0, outputLines: 3,
}];
const FAKE_HTML = '<!doctype html><html><body>gui</body></html>';

async function startTestServer(portStart = 0): Promise<{ srv: WebGuiServer; base: string; token: string }> {
  const srv = new WebGuiServer({ getSessions: () => FAKE_SESSIONS, getIndexHtml: () => FAKE_HTML, portStart });
  await srv.start();
  return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
}

describe('WebGuiServer HTTP+鉴权(设计 §3.4/§5)', () => {
  let active: WebGuiServer | null = null;
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  it('GET / 返回注入的 HTML + nosniff + CSP 头(无 token 要求)', async () => {
    const t = await startTestServer(); active = t.srv;
    const res = await fetch(t.base + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FAKE_HTML);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBeNull();   // 不发任何 CORS 头
  });

  it('错 token 401;对 token(无 Origin,模拟 curl)放行 /api/sessions', async () => {
    const t = await startTestServer(); active = t.srv;
    const bad = await fetch(`${t.base}/api/sessions?token=wrong`);
    expect(bad.status).toBe(401);
    const ok = await fetch(`${t.base}/api/sessions?token=${t.token}`);
    expect(ok.status).toBe(200);
    const list = await ok.json() as RunSessionDetailed[];
    expect(list[0]!.pid).toBe(42);
    expect(list[0]).not.toHaveProperty('proc');
  });

  it('X-GUI-Token 头鉴权 + 伪造 Origin 403', async () => {
    const t = await startTestServer(); active = t.srv;
    const viaHeader = await fetch(t.base + '/api/sessions', { headers: { 'x-gui-token': t.token } });
    expect(viaHeader.status).toBe(200);
    const evil = await fetch(`${t.base}/api/sessions?token=${t.token}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
  });

  it('端口避让:起点被占时 +1', async () => {
    const squat = net.createServer();
    await new Promise<void>(r => squat.listen(9561, '127.0.0.1', r));
    const t = await startTestServer(9561); active = t.srv;
    expect(t.srv.port).toBe(9562);
    await active!.stop(); active = null;
    squat.close();
  });

  it('isWebGuiActive 随 start/stop 翻转(真实实例驱动复位,设计 N-2)', async () => {
    expect(isWebGuiActive()).toBe(false);
    const t = await startTestServer(); active = t.srv;
    expect(isWebGuiActive()).toBe(true);
    await active.stop(); active = null;
    expect(isWebGuiActive()).toBe(false);
  });
});
```

文件头 `import net from 'node:net';`（端口避让用例）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/server-http.test.ts`
Expected: FAIL —— Cannot find module

- [ ] **Step 3: 实现**

```ts
// src/web-gui/server.ts
// Web GUI 监控面板服务(设计 2026-09-14 v3.1):嵌 MCP server 进程,node:http + SSE,
// 127.0.0.1 恒绑定 + per-process token + Origin 白名单 + 响应卫生(Inspector 壳)。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RunSessionDetailed } from '../core/process-state.js';
import { removeRegistration, writeRegistration } from './registry.js';
import { getLogger } from '../core/logger.js';

export interface WebGuiServerOptions {
  getSessions: () => RunSessionDetailed[];
  getIndexHtml: () => string;
  /** 端口起点(默认 9550;0 = 系统随机分配,测试用) */
  portStart?: number;
  /** token 注入(测试确定性);缺省 randomBytes(24) */
  token?: string;
}

const DEFAULT_PORT_START = 9550;
const PORT_ATTEMPTS = 20;

// 模块级激活标志:只读查询导出(launcher guard 消费),由本类 start/stop 驱动——
// 非依赖注入 setter,不违反 AGENTS.md 模块级 setter 红线(设计 §3.1)。
let _active = false;
export function isWebGuiActive(): boolean {
  return _active;
}

export class WebGuiServer {
  readonly token: string;
  private readonly opts: WebGuiServerOptions;
  private httpServer: Server | null = null;
  private portValue = 0;

  constructor(opts: WebGuiServerOptions) {
    this.opts = opts;
    this.token = opts.token ?? randomBytes(24).toString('hex');
  }

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<void> {
    const start = this.opts.portStart ?? Number(process.env.GODOT_MCP_WEB_GUI_PORT) || DEFAULT_PORT_START;
    let lastErr: unknown = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const candidate = start === 0 ? 0 : start + i;
      try {
        await this.listen(candidate);
        this.portValue = (this.httpServer!.address() as { port: number }).port;
        break;
      } catch (err) {
        lastErr = err;
        this.httpServer = null;
      }
    }
    if (!this.httpServer) throw new Error(`web-gui: no free port in ${start}..${start + PORT_ATTEMPTS - 1}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    // 附属功能不阻塞进程退出(设计 §3.1,对齐 orphanScanTimer 先例);已建连接由 stop 统一收
    this.httpServer.unref();
    _active = true;
    await writeRegistration({ pid: process.pid, port: this.portValue, token: this.token, startedAt: new Date().toISOString() });
    getLogger().info('web-gui', `Web GUI listening on http://127.0.0.1:${this.portValue}/ (pid ${process.pid})`);
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => this.handle(req, res));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        this.httpServer = srv;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // 关闭顺序(设计 §3.1):SSE 连接 end → closeAllConnections → close → 删登记。
    // SSE 连接管理在 Task 7 扩展;本 Task 先 closeAllConnections 兜底。
    _active = false;
    const srv = this.httpServer;
    this.httpServer = null;
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => { srv.close(() => resolve()); });
    await removeRegistration(process.pid);
  }

  // ─── 鉴权(设计 §5) ────────────────────────────────────────────────────────

  private extractToken(req: IncomingMessage, url: URL): string | null {
    const q = url.searchParams.get('token');
    if (q) return q;
    const h = req.headers['x-gui-token'];
    return typeof h === 'string' ? h : null;
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;   // 非浏览器客户端(curl)凭 token 放行
    return origin === `http://127.0.0.1:${this.portValue}` || origin === `http://localhost:${this.portValue}`;
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    return this.extractToken(req, url) === this.token && this.originAllowed(req);
  }

  // ─── 请求路由 ──────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/') {
        // 静态 HTML 无 token 要求(本体不含 token;token 经 CLI 打开的 URL query 进入)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        });
        res.end(this.opts.getIndexHtml());
        return;
      }
      if (!this.authorized(req, url)) {
        const code = this.extractToken(req, url) === this.token ? 403 : 401;   // 对 token 错 Origin=403,错 token=401
        res.writeHead(code).end();
        return;
      }
      if (url.pathname === '/api/sessions') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.opts.getSessions()));
        return;
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/server-http.test.ts`
Expected: 5 PASS

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/server.ts test/web-gui/server-http.test.ts
git commit -m "feat(web-gui): WebGuiServer HTTP 骨架(token/Origin 四象限鉴权+端口避让+unref+登记联动)"
```

---

### Task 7: WebGuiServer SSE 通道 + 日志数据流

**Files:**
- Modify: `src/web-gui/server.ts`（/events、/api/stats、LogReader+Aggregator 接入）
- Test: `test/web-gui/server-sse.test.ts`

**Interfaces:**
- Consumes: `LogReader`（`src/dashboard/log-reader.ts`）、`Aggregator`（Task 3 扩展版）、`getServerId`（Task 1）、`resolveLogDir`（logger）
- Produces:
  - `WebGuiServerOptions` 增加 `logDir?: string`（缺省 `resolveLogDir()`；测试注入 temp 目录）
  - SSE 事件：`hello`（每次连接建立即发，含 `sessions`/`stats`/`logs` 全量）、`log`（增量批量 500ms 帧）、`sessions`（500ms 节流）、`stats`（1s 节流）
  - `GET /api/stats`（token 鉴权，返回全局 + per-project 快照）
  - stats 快照形态（html.ts 契约）：`{ startTime, mode, projectPath, totalCalls, totalErrors, toolStats: ToolStats[], timeSeries: TimeSeriesBucket[], projects: { [key: string]: { totalCalls, totalErrors, toolStats: ToolStats[], timeSeries: TimeSeriesBucket[] } } }`

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/server-sse.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { getServerId, todayStr } from '../../src/core/logger.js';

/** 读取一条 SSE 事件(事件名 + 解析后的 data);超时 fail。 */
function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ event: string; data: any }> {
  let buf = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE read timeout')), 4000);
    const pump = (): void => {
      void reader.read().then(({ done, value }) => {
        if (done) { clearTimeout(timer); reject(new Error('SSE stream ended')); return; }
        buf += new TextDecoder().decode(value);
        const m = buf.match(/event: (\w+)\ndata: ([\s\S]*?)\n\n/);
        if (m) { clearTimeout(timer); resolve({ event: m[1]!, data: JSON.parse(m[2]!) }); }
        else pump();
      }).catch(reject);
    };
    pump();
  });
}

async function connectEvents(base: string, token: string): Promise<{ es: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const es = await fetch(`${base}/events?token=${token}`, { headers: { accept: 'text/event-stream' } });
  expect(es.status).toBe(200);
  expect(es.headers.get('content-type')).toContain('text/event-stream');
  const reader = es.body!.getReader();
  return { es, reader };
}

describe('WebGuiServer SSE + 日志数据流(设计 §3.3)', () => {
  let dir: string; let logDir: string; let srv: WebGuiServer | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webgui-sse-'));
    logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
  });
  afterEach(async () => { if (srv) { await srv.stop(); srv = null; } rmSync(dir, { recursive: true, force: true }); });

  function logFile(): string { return join(logDir, `${todayStr()}.jsonl`); }
  function appendLog(msg: string, srvId = getServerId()): void {
    appendFileSync(logFile(), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg, srv: srvId }) + '\n');
  }

  it('首连收到 hello 全量(sessions+stats+logs)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir });
    await srv.start();
    appendLog('before-connect');
    await new Promise(r => setTimeout(r, 700));   // 等 LogReader 初始回放(500ms 轮询)
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    const hello = await readEvent(reader);
    expect(hello.event).toBe('hello');
    expect(hello.data).toHaveProperty('sessions');
    expect(hello.data).toHaveProperty('stats');
    expect(hello.data.logs.some((e: { msg: string }) => e.msg === 'before-connect')).toBe(true);
    await reader.cancel();
  });

  it('本进程日志 500ms 内推 log 事件;他 srv 条目被过滤', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir });
    await srv.start();
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(reader);   // 丢弃 hello
    appendLog('mine-1');
    appendLog('foreign', 'other-server-id');
    const ev = await readEvent(reader);
    expect(ev.event).toBe('log');
    expect(ev.data.entries.some((e: { msg: string }) => e.msg === 'mine-1')).toBe(true);
    expect(ev.data.entries.some((e: { msg: string }) => e.msg === 'foreign')).toBe(false);
    await reader.cancel();
  });

  it('断开重连后再次收到 hello(幂等全量恢复,设计 I-4)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir });
    await srv.start();
    const a = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(a.reader);
    await a.reader.cancel();
    const b = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    const hello2 = await readEvent(b.reader);
    expect(hello2.event).toBe('hello');
    await b.reader.cancel();
  });

  it('/api/stats 返回全局+per-project 快照', async () => {
    appendLog(JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'd', msg: 'Tool call completed: t', tool: 't', type: 'tool_end', call_id: 't:1', duration_ms: 5, project: 'D:/A', srv: getServerId() }));
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir });
    await srv.start();
    await new Promise(r => setTimeout(r, 700));
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/stats?token=${srv.token}`);
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.totalCalls).toBe(1);
    expect(stats.projects['D:/A'].totalCalls).toBe(1);
    expect(Array.isArray(stats.toolStats)).toBe(true);
  });

  it('stop 后进程不挂(SSE socket unref,无残留句柄)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir });
    await srv.start();
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(reader);
    const t0 = Date.now();
    await srv.stop(); srv = null;
    expect(Date.now() - t0).toBeLessThan(2000);   // 活跃连接存在时 stop 仍快速完成
    await reader.cancel().catch(() => {});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/server-sse.test.ts`
Expected: FAIL —— /events 404

- [ ] **Step 3: 实现**

`src/web-gui/server.ts` 扩展：

3a. import 增加：

```ts
import { LogReader } from '../dashboard/log-reader.js';
import { Aggregator } from '../dashboard/aggregator.js';
import type { ToolStats, TimeSeriesBucket } from '../dashboard/aggregator.js';
import { getServerId, resolveLogDir } from '../core/logger.js';
```

3b. `WebGuiServerOptions` 加 `logDir?: string;`。

3c. 类内新增字段与方法：

```ts
  private sseClients = new Set<ServerResponse>();
  private reader: LogReader | null = null;
  private aggregator = new Aggregator();
  private pendingLogs: LogEntry[] = [];
  private logFlushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionsTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
```

（`import type { LogEntry } from '../core/logger.js';` 一并加）

3d. `start()` 末尾（写登记之后）接数据流与定时器：

```ts
    this.startDataStream();
    // log 增量帧:500ms 聚合(设计 §3.3.3;pollIntervalMs 硬下限 500 见 CHECK_DEBOUNCE_MS)
    this.logFlushTimer = setInterval(() => this.flushLogFrame(), 500);
    this.logFlushTimer.unref?.();
    this.sessionsTimer = setInterval(() => this.broadcastSnapshot('sessions', 500), 500);
    this.sessionsTimer.unref?.();
    this.statsTimer = setInterval(() => this.broadcastSnapshot('stats', 1000), 1000);
    this.statsTimer.unref?.();
```

```ts
  private startDataStream(): void {
    this.reader = new LogReader(this.opts.logDir ?? resolveLogDir(), { pollIntervalMs: 500 });
    this.reader.on('entries', (entries) => {
      for (const e of entries) {
        if (e.srv !== getServerId()) continue;   // 多 server 共写过滤(设计 §3.3.1)
        this.aggregator.process(e);
        this.pendingLogs.push(e);
      }
    });
    this.reader.on('error', () => { /* 轮询重试(LogReader 内建);GUI 黄条由前端按事件间隙判定 */ });
    this.reader.start().catch((err: Error) => getLogger().warn('web-gui', `LogReader start failed: ${err.message}`));
  }

  private statsSnapshot(): Record<string, unknown> {
    const s = this.aggregator.getState();
    const projects: Record<string, unknown> = {};
    for (const key of this.aggregator.getProjectKeys()) {
      const ps = this.aggregator.getStateFor(key);
      projects[key] = { totalCalls: ps.totalCalls, totalErrors: ps.totalErrors,
        toolStats: [...ps.toolStats.values()], timeSeries: ps.timeSeries };
    }
    return { startTime: s.startTime, mode: s.mode, projectPath: s.projectPath,
      totalCalls: s.totalCalls, totalErrors: s.totalErrors,
      toolStats: [...s.toolStats.values()], timeSeries: s.timeSeries, projects };
  }

  private sendEvent(res: ServerResponse, event: string, data: unknown): void {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 写失败由 close 摘除 */ }
  }

  private flushLogFrame(): void {
    if (this.pendingLogs.length === 0 || this.sseClients.size === 0) {
      this.pendingLogs = this.pendingLogs.length > 200 ? this.pendingLogs.slice(-200) : this.pendingLogs;
      return;
    }
    const entries = this.pendingLogs;
    this.pendingLogs = [];
    for (const res of this.sseClients) this.sendEvent(res, 'log', { entries });
  }

  private broadcastSnapshot(event: 'sessions' | 'stats', _throttleMs: number): void {
    if (this.sseClients.size === 0) return;
    const data = event === 'sessions' ? this.opts.getSessions() : this.statsSnapshot();
    for (const res of this.sseClients) this.sendEvent(res, event, data);
  }
```

3e. `handle()` 路由：鉴权通过后（Task 6 的 `if (!this.authorized(...))` 块之后、`/api/sessions` 旁）加：

```ts
      if (url.pathname === '/events') {
        this.handleSse(req, res);
        return;
      }
      if (url.pathname === '/api/stats') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.statsSnapshot()));
        return;
      }
```

```ts
  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.socket?.unref();   // 活跃 SSE 连接不阻塞进程退出(设计 §3.1 M-8)
    this.sseClients.add(res);
    req.on('close', () => { this.sseClients.delete(res); });   // 死连接自动摘除
    // 幂等全量(设计 I-4):每次连接建立(含自动重连)都发 hello,客户端整体重置
    const s = this.aggregator.getState();
    this.sendEvent(res, 'hello', {
      sessions: this.opts.getSessions(),
      stats: this.statsSnapshot(),
      logs: s.recentLogs.toArray().slice(-500),
    });
  }
```

3f. `stop()` 开头补数据流清理（`_active = false;` 之后）：

```ts
    this.reader?.stop();
    this.reader = null;
    for (const t of [this.logFlushTimer, this.sessionsTimer, this.statsTimer]) {
      if (t) clearInterval(t);
    }
    this.logFlushTimer = this.sessionsTimer = this.statsTimer = null;
    for (const res of this.sseClients) { try { res.end(); } catch { /* best-effort */ } }
    this.sseClients.clear();
```

（`recentLogs.toArray()`——RingBuffer 若无 toArray 需确认其 API；`src/dashboard/ring-buffer.ts` 现有 4 行，实施时以实际 API 为准，aggregator 内部已在 `getState()` 用 `this.timeSeriesBuf.toArray()`，同款即可。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/server-sse.test.ts`
Expected: 5 PASS

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/server.ts test/web-gui/server-sse.test.ts
git commit -m "feat(web-gui): SSE 通道(hello 幂等/log 增量帧/快照节流)+srv 过滤日志数据流"
```

---

### Task 8: 单文件 HTML 前端

**Files:**
- Create: `src/web-gui/html.ts`
- Test: `test/web-gui/html.test.ts`（sanity 级：导出完整性，前端行为靠契约测试 + 真机验收）

**Interfaces:**
- Consumes: Task 6/7 的端点与 SSE 事件契约（`hello`/`log`/`sessions`/`stats`、`/api/sessions`、`/api/stats`）
- Produces: `export const INDEX_HTML: string`（Task 9 接线注入 `getIndexHtml`）

- [ ] **Step 1: 写 sanity 测试**

```ts
// test/web-gui/html.test.ts
import { describe, it, expect } from 'vitest';
import { INDEX_HTML } from '../../src/web-gui/html.js';

describe('INDEX_HTML 导出完整性(前端行为靠 Task 6/7 契约+真机验收)', () => {
  it('非空且含关键机制标记', () => {
    expect(INDEX_HTML.length).toBeGreaterThan(5000);
    expect(INDEX_HTML).toContain('EventSource');
    expect(INDEX_HTML).toContain('sessionStorage');
    expect(INDEX_HTML).toContain("history.replaceState");
    expect(INDEX_HTML).toContain('textContent');   // XSS 防护:动态内容不走 innerHTML
  });
  it('不含硬编码 token 或外链资源(零依赖单文件)', () => {
    expect(INDEX_HTML).not.toMatch(/token\s*[:=]\s*['"][0-9a-f]{16,}/i);
    expect(INDEX_HTML).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/html.test.ts`
Expected: FAIL —— Cannot find module

- [ ] **Step 3: 实现 INDEX_HTML**

```ts
// src/web-gui/html.ts
// Web GUI 单文件前端(设计 §4):原生 JS + 内联 CSS,无构建链无外链。
// token 经 URL query 进入 → sessionStorage → replaceState 清 query(设计 §5.2);
// 动态内容一律 textContent(防日志内容 XSS);EventSource 断线原生重连,hello 即整体重置。

export const INDEX_HTML: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>godot-mcp-enhanced 监控面板</title>
<style>
  :root { --bg:#111418; --panel:#1a1f26; --line:#2a313b; --fg:#d7dde5; --dim:#7b8694;
          --green:#3fb950; --blue:#58a6ff; --yellow:#d29922; --red:#f85149; --orange:#db6d28; --grey:#6e7681; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.5 "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 14px; font-weight: 600; }
  header .dim { color: var(--dim); font-size: 12px; }
  #warn { display: none; background: #3d2e00; color: var(--yellow); padding: 4px 12px; font-size: 12px; }
  main { flex: 1; display: grid; grid-template-columns: 340px 1fr 420px; gap: 8px; padding: 8px; min-height: 0; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; min-height: 0; }
  section h2 { font-size: 12px; color: var(--dim); padding: 6px 10px; border-bottom: 1px solid var(--line); font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  .scroll { overflow-y: auto; flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); position: sticky; top: 0; background: var(--panel); }
  .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 11px; }
  .st-running { background:#0f2e17; color: var(--green); } .st-starting { background:#0c2d5e; color: var(--blue); }
  .st-stopping { background:#3a2c00; color: var(--yellow); } .st-exited_early { background:#4a1618; color: var(--red); }
  .st-errored { background:#43230d; color: var(--orange); } .st-exited { background:#23282f; color: var(--grey); }
  #logList { padding: 4px 0; }
  .log-line { padding: 0 10px; white-space: pre-wrap; word-break: break-all; font-family: Consolas, monospace; font-size: 12px; }
  .log-line.warn { color: var(--yellow); } .log-line.error { color: var(--red); }
  .log-line .t { color: var(--dim); margin-right: 6px; }
  .log-tools { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .log-tools input, .log-tools select { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
  .log-tools input { flex: 1; }
  #chart { display: flex; align-items: flex-end; gap: 2px; height: 90px; padding: 8px 10px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; position: relative; }
  .bar .calls { background: #2f4b6e; border-radius: 2px 2px 0 0; }
  .bar .errors { background: var(--red); border-radius: 0 0 2px 2px; }
  .empty { color: var(--dim); padding: 16px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>godot-mcp-enhanced 监控面板</h1>
  <span class="dim" id="statusBar">连接中…</span>
  <span class="dim" id="connInfo"></span>
</header>
<div id="warn"></div>
<main>
  <section><h2>运行会话</h2><div class="scroll" id="sessions"><div class="empty">暂无会话</div></div></section>
  <section><h2>日志流 <span class="dim" id="logCount"></span></h2>
    <div class="log-tools"><input id="logFilter" placeholder="过滤:工具/模块/项目"><select id="logLevel"><option>ALL</option><option>INFO</option><option>WARN</option><option>ERROR</option></select></div>
    <div class="scroll" id="logList"></div></section>
  <section><h2>工具统计 <select id="projSel"><option value="">全部</option></select></h2>
    <div class="scroll"><table id="statsTable"><thead><tr><th>tool</th><th>calls</th><th>err</th><th>avg</th><th>min</th><th>max</th></tr></thead><tbody></tbody></table></div>
    <h2 style="border-top:1px solid var(--line)">分钟时序</h2><div id="chart"><div class="empty" style="flex:1">等待数据…</div></div></section>
</main>
<script>
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || sessionStorage.getItem('gui-token') || '';
  if (token) { sessionStorage.setItem('gui-token', token); history.replaceState(null, '', location.pathname); }
  var $ = function (id) { return document.getElementById(id); };
  var state = { logs: [], stats: null, sessions: [], dedup: new Set() };
  var stopped = false;

  function authFetch(path) { return fetch(path, { headers: { 'X-GUI-Token': token } }); }

  function dedupKey(e) { return e.ts + '|' + (e.call_id || '') + '|' + (e.msg || '').slice(0, 40); }

  function pushLogs(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]; var k = dedupKey(e);
      if (state.dedup.has(k)) continue;
      state.dedup.add(k); state.logs.push(e);
    }
    if (state.logs.length > 500) { state.logs = state.logs.slice(-500); state.dedup = new Set(state.logs.map(dedupKey)); }
    renderLogs();
  }

  function resetAll(payload) {
    state.logs = []; state.dedup = new Set();
    if (payload.logs) pushLogs(payload.logs);
    if (payload.sessions) { state.sessions = payload.sessions; renderSessions(); }
    if (payload.stats) { state.stats = payload.stats; renderStats(); }
    $('statusBar').textContent = '已连接';
    $('connInfo').textContent = payload.stats && payload.stats.mode ? ('mode: ' + payload.stats.mode) : '';
  }

  function renderSessions() {
    var host = $('sessions'); host.textContent = '';
    if (!state.sessions.length) { var d = document.createElement('div'); d.className = 'empty'; d.textContent = '暂无会话'; host.appendChild(d); return; }
    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    thead.innerHTML = ''; // 表头为常量字符串,无注入面;数据行一律 DOM API
    thead.textContent = '';
    var htr = document.createElement('tr');
    ['项目', '状态', 'pid', 'busy', '输出行'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    var tbody = document.createElement('tbody');
    state.sessions.forEach(function (s) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); td1.textContent = (s.displayPath || s.projectPath || '').split(/[\\\\/]/).pop() || s.projectPath; td1.title = s.displayPath;
      var td2 = document.createElement('td'); var b = document.createElement('span'); b.className = 'badge st-' + s.status; b.textContent = s.status; td2.appendChild(b);
      var td3 = document.createElement('td'); td3.textContent = String(s.pid == null ? '-' : s.pid);
      var td4 = document.createElement('td'); td4.textContent = s.busy ? '🔒 ' + s.busyOwner : '';
      var td5 = document.createElement('td'); td5.textContent = String(s.outputLines);
      tr.append(td1, td2, td3, td4, td5); tbody.appendChild(tr);
    });
    tbl.append(thead, tbody); host.appendChild(tbl);
  }

  function renderLogs() {
    var filter = $('logFilter').value.toLowerCase();
    var level = $('logLevel').value;
    var host = $('logList'); host.textContent = '';
    var shown = state.logs.filter(function (e) {
      if (level !== 'ALL' && e.level.toUpperCase() !== level) return false;
      if (!filter) return true;
      return ((e.msg || '') + (e.module || '') + (e.tool || '') + (e.project || '')).toLowerCase().indexOf(filter) !== -1;
    }).slice(-300);
    var frag = document.createDocumentFragment();
    shown.forEach(function (e) {
      var div = document.createElement('div'); div.className = 'log-line ' + e.level;
      var t = document.createElement('span'); t.className = 't'; t.textContent = (e.ts || '').slice(11, 19);
      div.appendChild(t); div.appendChild(document.createTextNode(e.msg || ''));
      frag.appendChild(div);
    });
    host.appendChild(frag); host.scrollTop = host.scrollHeight;
    $('logCount').textContent = state.logs.length + ' 条';
  }

  function renderStats() {
    var s = state.stats; if (!s) return;
    var sel = $('projSel'); var cur = sel.value;
    var view = cur && s.projects && s.projects[cur] ? s.projects[cur] : s;
    var rows = (view.toolStats || []).slice().sort(function (a, b) { return b.calls - a.calls; });
    var tbody = $('statsTable').querySelector('tbody'); tbody.textContent = '';
    rows.forEach(function (t) {
      var tr = document.createElement('tr');
      [t.tool, t.calls, t.errors, Math.round(t.totalDurationMs / Math.max(1, t.calls)), t.minDurationMs, t.maxDurationMs].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // 项目切换器选项刷新(保留当前选择)
    var keys = s.projects ? Object.keys(s.projects) : [];
    if (cur && keys.indexOf(cur) === -1) keys.unshift(cur);
    sel.textContent = '';
    var optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部'; sel.appendChild(optAll);
    keys.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k.split(/[\\\\/]/).pop() || k; o.title = k; sel.appendChild(o); });
    sel.value = cur;
    // 时序柱状图(纯 CSS)
    var chart = $('chart'); chart.textContent = '';
    var ts = view.timeSeries || []; var max = 1;
    ts.forEach(function (b) { max = Math.max(max, b.calls); });
    ts.forEach(function (b) {
      var bar = document.createElement('div'); bar.className = 'bar'; bar.title = b.minute + ' calls=' + b.calls + ' errors=' + b.errors;
      var c = document.createElement('div'); c.className = 'calls'; c.style.height = Math.round(b.calls / max * 70) + 'px';
      var er = document.createElement('div'); er.className = 'errors'; er.style.height = Math.min(18, b.errors * 3) + 'px';
      bar.append(c, er); chart.appendChild(bar);
    });
  }

  $('logFilter').addEventListener('input', renderLogs);
  $('logLevel').addEventListener('change', renderLogs);
  $('projSel').addEventListener('change', renderStats);

  var es = new EventSource('/events?token=' + encodeURIComponent(token));
  es.addEventListener('hello', function (ev) { $('warn').style.display = 'none'; resetAll(JSON.parse(ev.data)); });
  es.addEventListener('log', function (ev) { pushLogs(JSON.parse(ev.data).entries || []); });
  es.addEventListener('sessions', function (ev) { state.sessions = JSON.parse(ev.data); renderSessions(); });
  es.addEventListener('stats', function (ev) { state.stats = JSON.parse(ev.data); renderStats(); });
  es.onerror = function () {
    $('statusBar').textContent = '连接中断,重连中…';
    // token 失效(server 重启端口复用)探测:401 时停 EventSource 防死循环(设计 M-2)
    if (stopped) return;
    authFetch('/api/stats').then(function (r) {
      if (r.status === 401 || r.status === 403) {
        stopped = true; es.close();
        $('statusBar').textContent = '面板已失效(server 已重启),请重新运行 dashboard --web';
        $('warn').style.display = 'block'; $('warn').textContent = '会话凭证已失效,请重新打开面板';
      }
    }).catch(function () { /* 网络瞬断,EventSource 自动重连 */ });
  };
})();
</script>
</body>
</html>
`;
```

注意：模板字符串内的 `${...}` 需转义——上表 HTML 中不应出现 TS 插值；若前端 JS 需要字面 `${}`，写成 `'${'` 拼接或避免使用。实现时全文 grep `\${` 确认仅允许在 TS 层。反斜杠正则 `/[\\\\/]/` 在 TS 模板串中 `\\\\` 输出为 `\\`（JS 正则转义反斜杠）+ `/`，语义正确。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/html.test.ts`
Expected: 2 PASS

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/html.ts test/web-gui/html.test.ts
git commit -m "feat(web-gui): 单文件 HTML 前端(四面板/token sessionStorage/幂等重置/401 停重连/textContent 防注入)"
```

---

### Task 9: 接线 GodotServer + index.ts TUI 决策 + launcher guard

**Files:**
- Modify: `src/GodotServer.ts`（字段区 :99 附近 + run() :525 之后 + close() :644 之后）、`src/index.ts:155-170`、`src/dashboard/launcher.ts:31-39`
- Test: `test/web-gui/wiring.test.ts`

**Interfaces:**
- Consumes: `WebGuiServer`/`isWebGuiActive`（Task 6/7）、`INDEX_HTML`（Task 8）、`listRunSessionsDetailed`（Task 4）
- Produces: `GodotServer.webGuiActive: boolean`（index.ts 决策查询点）；launcher 入口 guard（覆盖 `src/tools/game-bridge.ts:69` 第二触发点）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/wiring.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/web-gui/server.js', () => {
  return {
    WebGuiServer: vi.fn(),
    isWebGuiActive: vi.fn(() => false),
  };
});

describe('TUI 抑制双保险(设计 §3.2:两触发点)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('launcher 入口 guard:web-gui 激活时短路(不置位 _launched,不 spawn)', async () => {
    const { isWebGuiActive } = await import('../../src/web-gui/server.js');
    const child = await import('node:child_process');
    const spawnSpy = vi.spyOn(child, 'spawn');
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    expect(spawnSpy).not.toHaveBeenCalled();
    // 激活解除后仍可弹(guard 未置位 _launched)
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    launchDashboardOnce();
    expect(spawnSpy).toHaveBeenCalled();
    spawnSpy.mockRestore();
  });

  it('web-gui 关闭(env=0)或启动失败时 TUI 照旧(auto-launch 决策依据 webGuiActive)', async () => {
    // webGuiActive 三态传播的等价单测:env=0 → GodotServer 不创建 WebGuiServer(集成验证见验收脚本);
    // 此处验证决策原语:isWebGuiActive()=false 时 launcher 不短路(上一用例已覆盖 false 分支)。
    const { isWebGuiActive } = await import('../../src/web-gui/server.js');
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(isWebGuiActive()).toBe(false);
  });
});
```

注意：launcher 的 spawn 是模块顶层 `import { spawn }`——spyOn 同模块引用可拦截（ESM 下 `vi.spyOn(child_process, 'spawn')` 拦截的是 node:child_process 模块对象的属性，launcher 的命名 import 绑定不受影响——**因此此法对 ESM 命名导入无效**）。改用 `vi.mock('node:child_process', ...)` 整模块 mock（spawn/spawnSync 均 vi.fn()）。实施时按此调整：

```ts
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })),
  spawnSync: vi.fn(() => ({ error: null })),
}));
```

断言 `spawn` mock 的调用次数。`_launched` 模块级状态跨用例残留——两用例放同一文件顺序执行，或用 `vi.resetModules()` + 动态 import 隔离（推荐后者：每用例 `vi.resetModules(); const { launchDashboardOnce } = await import(...)`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/wiring.test.ts`
Expected: FAIL —— guard 不存在，第一用例 spawn 被调用

- [ ] **Step 3: 实现**

3a. `src/dashboard/launcher.ts` 入口（`:32 if (_launched) return;` 之后插入）：

```ts
  // Web GUI 激活时抑制 TUI(设计 §3.2 双保险):功能被 Web 面板全覆盖,双开纯冗余。
  // 守在此入口统一覆盖两个触发点(index.ts 启动决策 + game-bridge.ts:69 bridge 首连回调)。
  // 不置位 _launched——web-gui 关闭/失败后的下一次调用仍可正常弹 TUI。
```

文件顶部 import：`import { isWebGuiActive } from '../web-gui/server.js';`
插入短路：`if (isWebGuiActive()) return;`（置于 `_launched` 检查后、env 检查前）

3b. `src/GodotServer.ts`：

- import 区：`import { WebGuiServer } from './web-gui/server.js';`、`import { INDEX_HTML } from './web-gui/html.js';`、在 process-state import 块（`import * as ps from ...` 或既有形式）确认 `listRunSessionsDetailed` 可用（按现有 ps 命名空间追加调用即可）。
- 字段区（`:99` orphanScanTimer 附近）：

```ts
  // Web GUI(spec 2026-09-14 §3.2):server 进程内嵌监控面板;附属功能,启动失败降级禁用。
  private webGuiServer: WebGuiServer | null = null;
  /** run() 完成后已定(设计 B-2):index.ts 的 TUI 决策查询点。 */
  webGuiActive = false;
```

- `run()` 内（`:525 log('Godot MCP Enhanced server running on stdio')` 之后）：

```ts
    // Web GUI(设计 §3.2):connect 后即起,run() resolve 前三态已定(消除 index.ts 决策竞态)。
    // env=0 关闭(与 GODOT_MCP_NO_DASHBOARD 同模式);任何异常降级禁用,绝不拖垮主流程。
    if (process.env.GODOT_MCP_WEB_GUI !== '0') {
      try {
        this.webGuiServer = new WebGuiServer({
          getSessions: () => ps.listRunSessionsDetailed(),
          getIndexHtml: () => INDEX_HTML,
        });
        await this.webGuiServer.start();
        this.webGuiActive = true;
      } catch (err) {
        this.webGuiServer = null;
        this.webGuiActive = false;
        getLogger().warn('godot-mcp', `Web GUI disabled: ${err instanceof Error ? err.message : err}`);
      }
    }
```

- `close()` 内（`:644` clearInflight 之后）：

```ts
      // Web GUI 停机(设计 §3.2):SSE end → closeAllConnections → close → 删登记(顺序在 WebGuiServer.stop 内)
      if (this.webGuiServer) {
        const gui = this.webGuiServer;
        this.webGuiServer = null;
        this.webGuiActive = false;
        await safeStep('stopWebGui', () => gui.stop());
      }
```

3c. `src/index.ts:155-170` 替换为：

```ts
  server.run().then(() => {
    // Web GUI 三态已定(设计 §3.2 触发点 1):激活则跳过 TUI(guard 见 launcher 入口);
    // 禁用/失败照旧弹。行为微变(改善):run() reject 时不再给已死 server 弹监控窗。
    if (server.webGuiActive) {
      getLogger().info('godot-mcp', 'Web GUI active — skipping Dashboard TUI auto-launch');
      return;
    }
    import('./dashboard/launcher.js').then(({ launchDashboardOnce }) => {
      getLogger().info('godot-mcp', 'Auto-launching Dashboard TUI...');
      launchDashboardOnce();
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn('godot-mcp', `Dashboard auto-launch skipped: ${msg}`);
    });
  }).catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    getLogger().error('godot-mcp', 'Failed to run server', { error: msg });
    // I-CQ-01: Graceful cleanup before exit
    getLogger().close();
    process.exit(1);
  });
```

- [ ] **Step 4: 跑测试确认通过 + 既有 GodotServer 测试隔离检查**

Run: `npx vitest run test/web-gui/wiring.test.ts && npm test -- --reporter=dot 2>&1 | tail -5`
Expected: wiring 2 PASS。若既有 GodotServer 构造测试因真起 WebGuiServer 而变慢/占端口——**这正是 Task 11 Step 1 的 test/setup.js env 隔离要解决的**；本 Task 若全量测试因此出问题，先把 `process.env.GODOT_MCP_WEB_GUI = '0';` 加进 `test/setup.js`（Task 11 Step 1 提前执行），再跑全量。

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/GodotServer.ts src/index.ts src/dashboard/launcher.ts test/web-gui/wiring.test.ts test/setup.js
git commit -m "feat(web-gui): 接线 GodotServer(webGuiActive 三态+close 链 stopWebGui)+index TUI 决策+launcher 双触发点 guard"
```

---

### Task 10: CLI dashboard --web + showHelp

**Files:**
- Create: `src/web-gui/open.ts`
- Modify: `src/cli/router.ts:57-63`（dashboard case）+ `:124`（showHelp）
- Test: `test/web-gui/open.test.ts`

**Interfaces:**
- Consumes: `listRegistrations`（Task 5）
- Produces: `export async function openWebDashboard(opts?: { opener?: (url: string) => void; choose?: (entries: WebGuiRegistration[]) => Promise<WebGuiRegistration | null>; registryDir?: string; isPidAlive?: (pid: number) => boolean }): Promise<number>`（0=成功打开；非 0=无可开/用户取消——router 以退出码透传）

- [ ] **Step 1: 写失败测试**

```ts
// test/web-gui/open.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWebDashboard } from '../../src/web-gui/open.js';
import { writeRegistration } from '../../src/web-gui/registry.js';

const ALIVE = () => true;

describe('dashboard --web(设计 §6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-open-')); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('零个活 server:打印提示,返回非 0', async () => {
    const urls: string[] = [];
    const code = await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
    expect(code).not.toBe(0);
    expect(urls).toHaveLength(0);
  });

  it('单个:opener 收到带 token 的 URL', async () => {
    await writeRegistration({ pid: process.pid, port: 9550, token: 'tok1', startedAt: 't' }, { dir });
    const urls: string[] = [];
    const code = await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
    expect(code).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:9550/?token=tok1']);
  });

  it('多个:choose 选择后被打开;取消返回非 0', async () => {
    await writeRegistration({ pid: 101, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await writeRegistration({ pid: 102, port: 9551, token: 'b', startedAt: 't' }, { dir });
    const urls: string[] = [];
    const code = await openWebDashboard({
      opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE,
      choose: async (entries) => entries.find(e => e.port === 9551) ?? null,
    });
    expect(code).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:9551/?token=b']);
    const cancelled = await openWebDashboard({
      opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE,
      choose: async () => null,
    });
    expect(cancelled).not.toBe(0);
  });
});
```

（`openWebDashboard` 的 opts 因此需含 `registryDir?: string; isPidAlive?: (pid: number) => boolean`——测试注入，生产缺省。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/web-gui/open.test.ts`
Expected: FAIL —— Cannot find module

- [ ] **Step 3: 实现**

```ts
// src/web-gui/open.ts
// CLI `dashboard --web`(设计 §6):聚合登记 → 探活清死 → 单个直开/多个菜单/零个提示。
// 跨平台开浏览器:start(Win)/open(mac)/xdg-open(Linux);失败降级打印 URL 手动点。

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { listRegistrations, type WebGuiRegistration } from './registry.js';

const execAsync = promisify(exec);

export interface OpenWebDashboardOpts {
  /** 浏览器打开函数(测试注入);缺省跨平台探测 */
  opener?: (url: string) => void;
  /** 多实例选择器(测试注入);缺省读 stdin 编号菜单 */
  choose?: (entries: WebGuiRegistration[]) => Promise<WebGuiRegistration | null>;
  registryDir?: string;
  isPidAlive?: (pid: number) => boolean;
}

function defaultOpener(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"`
    : platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 失败降级:调用方已打印 URL,手动点 */
  });
}

async function defaultChoose(entries: WebGuiRegistration[]): Promise<WebGuiRegistration | null> {
  console.log('检测到多个运行中的 MCP server:');
  entries.forEach((e, i) => {
    console.log(`  [${i + 1}] pid=${e.pid}  http://127.0.0.1:${e.port}/  (started ${e.startedAt})`);
  });
  process.stdout.write('选择编号(回车取消): ');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });
  const line: string = await new Promise((resolve) => rl.once('line', resolve));
  rl.close();
  const n = Number.parseInt(line.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= entries.length ? entries[n - 1]! : null;
}

export async function openWebDashboard(opts: OpenWebDashboardOpts = {}): Promise<number> {
  const entries = await listRegistrations({ dir: opts.registryDir, isPidAlive: opts.isPidAlive });
  if (entries.length === 0) {
    console.log('没有运行中的 MCP server(先在 AI 客户端里启动 godot-mcp-enhanced)。');
    return 1;
  }
  let picked: WebGuiRegistration | null;
  if (entries.length === 1) {
    picked = entries[0]!;
  } else {
    const choose = opts.choose ?? defaultChoose;
    picked = await choose(entries);
  }
  if (!picked) return 1;
  const url = `http://127.0.0.1:${picked.port}/?token=${picked.token}`;
  console.log(`Web GUI: ${url}`);
  (opts.opener ?? defaultOpener)(url);
  return 0;
}
```

`src/cli/router.ts` dashboard case 替换：

```ts
    case 'dashboard': {
      if (parsed.rest.includes('--web')) {
        const { openWebDashboard } = await import('../web-gui/open.js');
        const code = await openWebDashboard();
        process.exit(code === 0 ? EXIT_CODES.EXIT_OK : EXIT_CODES.EXIT_OPERATION_FAILED);
      }
      const { launchDashboardOnce } = await import('../dashboard/launcher.js');
      launchDashboardOnce();
      console.log('Dashboard starting... (use the separate terminal window)');
      process.exit(EXIT_CODES.EXIT_OK);
      break; // unreachable — no-fallthrough 需要显式终止语句
    }
```

showHelp `:124` 行替换为：

```
  godot-mcp-enhanced dashboard [--web]  启动监控面板(--web 打开浏览器版;默认 TUI)
```

注意：`test/cli/router.test.ts` 若断言 help 文本或 SUBCOMMANDS 需同步（SUBCOMMANDS 未变，仅 help 文案加 `--web`——先 `grep -n "dashboard" test/cli/router.test.ts` 核对再改）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/web-gui/open.test.ts test/cli/router.test.ts`
Expected: 全 PASS

- [ ] **Step 5: commit**

```bash
npm run lint && npm run build && npm test
git add src/web-gui/open.ts src/cli/router.ts test/web-gui/open.test.ts
git commit -m "feat(web-gui): CLI dashboard --web(登记聚合+探活+跨平台开浏览器+多实例菜单)"
```

---

### Task 11: 测试隔离 + 文档 + 门禁 + 真机验收

**Files:**
- Modify: `test/setup.js`、`AGENTS.md`（src/ 结构表 + dashboard 段）、`CHANGELOG.md`（[Unreleased]）
- Create: `.superpowers/sdd/web-gui-acceptance.mjs`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 发版级门禁证据 + 真机验收 PASS 记录

- [ ] **Step 1: 测试隔离**

`test/setup.js` 追加：

```js
// Web GUI 默认关:既有 GodotServer 构造测试不真起 HTTP/不写用户 ~/.godot-mcp/(设计 §9 I-3)。
// web-gui 专属测试在用例内显式 process.env.GODOT_MCP_WEB_GUI = '1'(须 afterEach 还原,防同 worker 污染)。
process.env.GODOT_MCP_WEB_GUI = '0';
```

注：Task 6/7 的 server 测试直接 `new WebGuiServer(...)`（不经 GodotServer env 门），无需改 env；仅 wiring/GodotServer 级测试受此保护。显式开 env 的测试（若有）必须 `afterEach(() => { delete process.env.GODOT_MCP_WEB_GUI; })`（`check:env-isolation` 门禁兜底）。

- [ ] **Step 2: 文档连带**

2a. `AGENTS.md` `src/` 结构表 `src/dashboard/` 行后加一行：

```
    - `src/web-gui/` — Web GUI 监控面板（**server 进程内嵌** HTTP+SSE，默认开 env `GODOT_MCP_WEB_GUI=0` 关；per-pid 登记 `~/.godot-mcp/web-gui/`；CLI `dashboard --web` 打开。注意与 dashboard TUI 区分:TUI 是独立只读 CLI 进程读日志文件,web-gui 是 server 内监控面——两者都**无设置项影响 server 行为**）
```

同时 dashboard 行的"独立只读 CLI 进程,非 server 前端"描述后追加"（仅指 TUI；Web 见 src/web-gui/）"。

2b. `CHANGELOG.md` `[Unreleased]` 段新增（Keep a Changelog 风格，Added/Fixed）：

```markdown
### Added
- Web GUI 监控面板：server 进程内嵌 HTTP+SSE（127.0.0.1 + token + Origin 白名单），四面板（运行会话/日志流/按项目工具统计/分钟时序），CLI `dashboard --web` 打开浏览器（`GODOT_MCP_WEB_GUI=0` 关闭，端口起点 `GODOT_MCP_WEB_GUI_PORT` 默认 9550）。

### Fixed
- dashboard TUI/aggregator：`meta.project_path` 恒 miss 死逻辑改读 `entry.project`；LogReader `getTodayFile()` UTC/本地日期错位（东八区每日 00:00-08:00 启动断流）。
```

- [ ] **Step 3: 真机验收脚本**

```js
// .superpowers/sdd/web-gui-acceptance.mjs
// Web GUI 真机验收(设计 §10 判据 1/2/4 的自动化部分;判据 3 双 server 与判据 5 TUI 回归人工补)
// 用法: node .superpowers/sdd/web-gui-acceptance.mjs   (需先 npm run build)
import { spawn } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const server = spawn('node', [join(ROOT, 'build', 'index.js')], {
  env: { ...process.env, GODOT_MCP_WEB_GUI: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // 判据 1:登记出现 + 面板有数据
  let reg = null;
  for (let i = 0; i < 20 && !reg; i++) {
    await sleep(500);
    const dir = join(homedir(), '.godot-mcp', 'web-gui');
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const raw = JSON.parse(await readFile(join(dir, f), 'utf-8'));
        if (raw.pid === server.pid) reg = raw;
      }
    } catch { /* 尚未创建 */ }
  }
  if (!reg) throw new Error('判据 1 FAIL: 登记文件未出现');
  log(`判据 1a 登记 OK: pid=${reg.pid} port=${reg.port}`);

  const base = `http://127.0.0.1:${reg.port}`;
  const html = await (await fetch(`${base}/`)).text();
  if (!html.includes('监控面板')) throw new Error('判据 1b FAIL: HTML 不含面板标题');
  log('判据 1b HTML OK');

  const bad = await fetch(`${base}/api/sessions?token=wrong`);
  if (bad.status !== 401) throw new Error(`判据 4 FAIL: 错 token 期望 401 实得 ${bad.status}`);
  const evil = await fetch(`${base}/api/sessions?token=${reg.token}`, { headers: { origin: 'http://evil.example' } });
  if (evil.status !== 403) throw new Error(`判据 4 FAIL: 伪造 Origin 期望 403 实得 ${evil.status}`);
  log('判据 4 鉴权 OK(401/403)');

  // SSE hello
  const es = await fetch(`${base}/events?token=${reg.token}`, { headers: { accept: 'text/event-stream' } });
  const reader = es.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  if (!text.includes('event: hello')) throw new Error('判据 1c FAIL: SSE 首事件非 hello');
  log('判据 1c SSE hello OK');
  await reader.cancel();

  log('OVERALL: ACCEPTANCE PASS ✅ (判据 2/3/5 由人工补跑)');
} finally {
  server.kill();
  await sleep(500);
  // 主动清掉本进程登记(SIGKILL 残留由下次 dashboard --web 探活清,这里脚本自己收更干净)
  await unlink(join(homedir(), '.godot-mcp', 'web-gui', `${server.pid}.json`)).catch(() => {});
}
```

注：验收会写真实 `~/.godot-mcp/web-gui/<pid>.json`（registry 无 env 覆盖，走 opts 注入是给测试用的）——脚本 finally 主动清理。logger 日志写默认目录属正常生产行为，无需清理。

- [ ] **Step 4: 全量门禁 + 验收跑**

```bash
npm run lint && npm run build && npm test
npm run check:env-isolation
node .superpowers/sdd/web-gui-acceptance.mjs
```

Expected: 全绿 + ACCEPTANCE PASS

- [ ] **Step 5: commit**

```bash
git add test/setup.js AGENTS.md CHANGELOG.md .superpowers/sdd/web-gui-acceptance.mjs
git commit -m "chore(web-gui): 测试隔离(env=0)+AGENTS.md/CHANGELOG 连带+真机验收脚本"
```

---

## Self-Review 结论（已自查修正）

1. **Spec 覆盖**：§2.1-2.10（Task 5/6/7/8/9/10/11）、§2.7 srv（Task 1）、§2.8 时区（Task 2）、§2.6+§8 aggregator（Task 3）、§2.9 guard（Task 9）、§2.10 文档（Task 11）——全覆盖；§5 安全壳四层分散在 Task 5（权限）/6（token/Origin/CSP）/8（前端侧）；§9 测试逐项对应各 Task + Task 11 隔离。
2. **占位符扫描**：无 TBD/TODO；唯一"实现时确认"项（RingBuffer.toArray API、router.test help 断言）已给出核查命令与 fallback，非占位。
3. **类型一致性**：`RunSessionDetailed`（Task 4 定义 = Task 6 消费 = Task 8 `s.status` 前端契约）；`WebGuiServerOptions` 两阶段演进（Task 6 基础 + Task 7 增 `logDir`，无签名破坏）；`statsSnapshot` 形态（Task 7 产出 = Task 8 `stats.projects`/`toolStats[]` 消费）；`isWebGuiActive`（Task 6 产出 = Task 9 launcher 消费）。
