# run_project 预览模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `run_project` 加 `preview` 预览模式(禁 TTL、游戏窗口常驻至用户关闭)+ 输出快照机制(关窗后 `get_debug_output` 仍可查错)+ 规则模板收尾流程引导,实现"AI 改完直接弹游戏窗口验证,替代开编辑器"。

**Architecture:** 三处核心改动——`process-state.ts` 补输出快照(清空入口 move 语义,B-1 修复)、`runtime.ts` 加 preview 参数与快照回落、规则双副本加「视觉改动收尾流程」。配套版本链(硬门禁 bump 0.33.1→0.33.2)与生成产物再生成。

**Tech Stack:** TypeScript(ES2022/strict/ESM,import 带 `.js` 扩展名)、Vitest、Node.js。

**设计文档:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-09-13-run-project-preview-mode-design.md`(修订版 commit aa4482a9,含第三方审阅记录)

## Global Constraints

- 工作目录一律 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced`;当前分支 `feat/run-project-preview-mode`(已存在,勿在 master 开 commit)。
- TypeScript strict + `noUncheckedIndexedAccess`;禁 `any`;未使用变量报 error;ESM import 必须带 `.js`。
- 工具 `inputSchema` 描述用简体中文;工具运行时返回消息用英文(读者是 AI)。
- 提交信息 Conventional Commits(type 英文前缀,subject 中文)。
- `test/runtime.test.js` 是 `.js`(JS 测试文件,勿写成 ts)。
- 改 `rule-templates.ts` 必须同步 `.claude/rules/godot-mcp-core.md`(`STRICT=1 npm run check:rules-sync` 阻断校验)并触发 patch 版本 bump(Task 4 处理,CI 查分支最终 HEAD)。
- 生成产物不手改:`docs/tools/runtime.md` 由 `npm run gen:tool-docs` 生成;`docs/capability-matrix.{json,md}` 由 `npm run build-matrix` 生成。

---

### Task 1: process-state 输出快照机制(B-1 修复地基)

**Files:**
- Modify: `src/core/process-state.ts`
- Test: `test/process-state.test.js`

**Interfaces:**
- Consumes: 现有 `MAX_OUTPUT_BUFFER_SIZE`(=`src/core/process-state.ts:17`,5000)、`_outputBuffer` 模块变量、`resetState()`。
- Produces: `getLastFinishedRunOutput(): string[]`(新导出,Task 2 的 runtime.ts 将 import 它);内部 `stashOutputBuffer()`(不导出)。

- [ ] **Step 1: 写失败测试**

在 `test/process-state.test.js` 末尾(`getShortRunningCount` 相关 describe 之后、文件结束前)追加。同时在文件头部 import 块(现有 `import { resetState, getRunningProcess, ... } from '../src/core/process-state.js'`)中补 `getLastFinishedRunOutput`:

```js
// ─── output snapshot — B-1 修复(_lastFinishedRunOutput) ──────────────────────

describe('output snapshot — B-1 修复(_lastFinishedRunOutput)', () => {
  beforeEach(() => {
    resetState();
  });

  it('setRunningProcess(null) 把非空 buffer 挪入快照并清空当前 buffer', () => {
    appendOutput(['line1', 'SCRIPT ERROR: boom']);
    setRunningProcess(null);
    expect(getLastFinishedRunOutput()).toEqual(['line1', 'SCRIPT ERROR: boom']);
    expect(getOutputBuffer()).toEqual([]);
  });

  it('clearOutputBuffer 同样把非空内容挪入快照', () => {
    appendOutput(['a', 'b']);
    clearOutputBuffer();
    expect(getLastFinishedRunOutput()).toEqual(['a', 'b']);
    expect(getOutputBuffer()).toEqual([]);
  });

  it('空清空不覆盖既有快照(换窗时序:close handler 先存,run_project 开头 clear 时 buffer 已空)', () => {
    appendOutput(['old-run-output']);
    setRunningProcess(null);   // close handler 路径:存快照 + 清 buffer
    clearOutputBuffer();       // 新 run_project 开头(:167):buffer 已空
    expect(getLastFinishedRunOutput()).toEqual(['old-run-output']);
  });

  it('快照超过 5000 行时截断保留最近内容', () => {
    for (let i = 0; i < 3; i++) {
      appendOutput(Array.from({ length: 2000 }, (_, k) => `line-${i}-${k}`));
    }
    setRunningProcess(null);
    const snap = getLastFinishedRunOutput();
    expect(snap.length).toBe(5000);
    expect(snap[0]).toContain('line-1-');   // 最早的 line-0-* 已被截掉
  });

  it('resetState 清空快照(测试隔离)', () => {
    appendOutput(['x']);
    setRunningProcess(null);
    expect(getLastFinishedRunOutput().length).toBe(1);
    resetState();
    expect(getLastFinishedRunOutput()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/process-state.test.js -t "output snapshot"`
Expected: FAIL,报 `getLastFinishedRunOutput is not a function`(import 不存在)。

- [ ] **Step 3: 最小实现**

`src/core/process-state.ts` 三处修改:

(a) 模块变量区,`let _outputBuffer: string[] = [];`(`:122`)下一行加:

```ts
// B-1 修复(2026-09-13 预览模式设计):最近一次已结束运行会话的输出快照。
// setRunningProcess(null)/clearOutputBuffer 清空 _outputBuffer 前把非空内容挪入此处
// (move 语义;空清空不覆盖旧快照——换窗时序下 close handler 先存,run_project 开头
// 的 clearOutputBuffer 时 buffer 已空,不能把刚存的快照冲掉)。
let _lastFinishedRunOutput: string[] = [];
```

(b) `clearOutputBuffer`(`:307-309`)改造并在其后新增两个函数:

```ts
export function clearOutputBuffer(): void {
  stashOutputBuffer();
  _outputBuffer = [];
}

/** B-1 修复:输出缓冲被清空前,非空内容挪入最近结束运行快照。@internal */
function stashOutputBuffer(): void {
  if (_outputBuffer.length > 0) {
    _lastFinishedRunOutput = _outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}

/** 最近一次已结束运行会话的输出快照(get_debug_output 在当前缓冲为空且无运行进程时回落读取)。 */
export function getLastFinishedRunOutput(): string[] {
  return _lastFinishedRunOutput;
}
```

(c) `setRunningProcess` 的清空分支(`:290-293`)加 stash:

```ts
  if (!proc) {
    stashOutputBuffer();
    _outputBuffer = [];
    _processStartTime = 0;
  }
```

(d) `resetState()`(`:332-339`)的赋值清单中加一行:

```ts
  _lastFinishedRunOutput = [];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/process-state.test.js`
Expected: 全部 PASS(新增 5 例 + 原有用例不回归)。

- [ ] **Step 5: Commit**

```bash
git add src/core/process-state.ts test/process-state.test.js
git commit -m "feat(process-state): 输出快照机制——清空前挪入 _lastFinishedRunOutput(B-1 修复地基)"
```

---

### Task 2: runtime.ts preview 参数 + TTL 禁用 + 文案 + 快照回落

**Files:**
- Modify: `src/tools/runtime.ts`
- Test: `test/runtime.test.js`

**Interfaces:**
- Consumes: Task 1 的 `getLastFinishedRunOutput(): string[]`(from `../core/process-state.js`)。
- Produces: `run_project` inputSchema 新参数 `preview: boolean`;`get_debug_output`/`stop_project` 返回 JSON 新字段 `source: 'current_run' | 'last_finished_run'`;内部 helper `resolveReadableOutput(ctx)`(不导出)。

- [ ] **Step 1: mock 基建两处准备**

(a) `test/runtime.test.js` 的 process-state mock factory(`:22-35`)的导出对象里补一行(放在 `clearOutputBuffer: vi.fn(),` 之后):

```js
  getLastFinishedRunOutput: vi.fn(() => []),
```

(b) 同文件 import 行(`:71`,从 process-state import 的那行)补 `getLastFinishedRunOutput`:

```js
import { killProcess, clearOutputBuffer, setProcessBusy, registerSpawnedGodotPid, unregisterSpawnedGodotPid, killOrphanGodotProcesses, getLastFinishedRunOutput } from '../src/core/process-state.js';
```

(c) `createMockCtx`(`:76-91`)的 `setRunningProcess: vi.fn(),` 改为带真实副作用(模拟 process-state 单例行为,否则快照回落测不到真路径——设计文档 §7.3 教训):

```js
    setRunningProcess: vi.fn(function (p) { this.runningProcess = p; }),
```

- [ ] **Step 2: 写失败测试**

在 `test/runtime.test.js` 末尾追加(Imp-4 describe 之后):

```js
// ─── run_project preview 模式 + 快照回落(B-1) ───────────────────────────────

describe('run_project — preview 模式', () => {
  it('preview=true 不设 autoStopTimer:快进超时时间进程不被杀', async () => {
    vi.useFakeTimers();
    try {
      const procA = mockProc();
      setupSpawnMock(procA);
      const ctx = createMockCtx();
      await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 5, preview: true }, ctx);
      ctx.runningProcess = procA;
      killProcess.mockClear();
      vi.advanceTimersByTime(6000);
      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('对照组:非 preview 时 timer 到点杀进程', async () => {
    vi.useFakeTimers();
    try {
      const procA = mockProc();
      setupSpawnMock(procA);
      const ctx = createMockCtx();
      await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 5 }, ctx);
      ctx.runningProcess = procA;
      killProcess.mockClear();
      vi.advanceTimersByTime(6000);
      expect(killProcess).toHaveBeenCalledWith(procA);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preview=true 返回消息含预览语义且不含 timeout 秒数', async () => {
    setupSpawnMock(mockProc());
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', timeout: 30, preview: true }, ctx);
    const t = resultText(r);
    expect(t).toContain('Preview mode');
    expect(t).toContain('no auto-stop');
    expect(t).not.toContain('timeout: 30s');
  });

  it('preview + wait_for_bridge 成功分支:含 Preview mode 且不含 timeout 秒数', async () => {
    setupSpawnMock(mockProc());
    isBridgeReady.mockResolvedValue({ ready: true, reason: '' });
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'run_project', project_path: '/p', preview: true, wait_for_bridge: true, bridge_timeout: 10 }, ctx);
    const t = resultText(r);
    expect(t).toContain('Preview mode');
    expect(t).not.toContain('timeout: 40s');
    expect(t).toContain('bridge ready');
  });
});

describe('get_debug_output / stop_project — 快照回落(B-1)', () => {
  afterEach(() => {
    getLastFinishedRunOutput.mockReturnValue([]);
  });

  it('buffer 空 + 无运行进程 + 快照非空 → 读快照并标注 last_finished_run', async () => {
    getLastFinishedRunOutput.mockReturnValue(['SCRIPT ERROR: boom']);
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('boom');
    expect(t).toContain('last_finished_run');
  });

  it('buffer 非空 → 优先当前 buffer,不读快照', async () => {
    getLastFinishedRunOutput.mockReturnValue(['OLD-SNAPSHOT-LINE']);
    const ctx = createMockCtx({ outputBuffer: ['CURRENT LINE'] });
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    const t = resultText(r);
    expect(t).toContain('CURRENT LINE');
    expect(t).not.toContain('OLD-SNAPSHOT-LINE');
  });

  it('stop_project 在进程结束后仍能报出错误(现存 bug 修复)', async () => {
    const procA = mockProc();
    setupSpawnMock(procA);
    const ctx = createMockCtx({ runningProcess: procA });
    getLastFinishedRunOutput.mockReturnValue(['SCRIPT ERROR: late-crash']);
    const r = await handleTool('runtime', { action: 'stop_project' }, ctx);
    const t = resultText(r);
    expect(t).toContain('late-crash');
  });

  it('全空仍返回 No debug output', async () => {
    getLastFinishedRunOutput.mockReturnValue([]);
    const ctx = createMockCtx();
    const r = await handleTool('runtime', { action: 'get_debug_output' }, ctx);
    expect(resultText(r)).toContain('No debug output available');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/runtime.test.js -t "preview"`
Expected: preview 文案用例 FAIL(返回消息还是 `Running project at ... (timeout: 30s...)`);快照回落用例 FAIL(无 source 标注);timer 用例 FAIL(非 preview 对照组通过、preview 组被杀)。

- [ ] **Step 4: 实现**

`src/tools/runtime.ts` 六处修改:

(a) import 行(`:8`)补 `getLastFinishedRunOutput`(加到现有 import 列表末尾):

```ts
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses, registerSpawnedGodotPid, unregisterSpawnedGodotPid, getLastFinishedRunOutput } from '../core/process-state.js';
```

(b) inputSchema 在 `bridge_timeout` 属性行(`:92`)之后加:

```ts
          preview: { type: 'boolean', default: false, description: '预览模式:禁用自动停止,游戏窗口常驻,用户关闭窗口即结束验证。适用于 AI 改完代码/场景后的人工视觉验证(替代打开编辑器)。默认不与 wait_for_bridge 组合(bridge 未就绪会终止游戏,见规则说明)' },
```

(c) `classifyOutput` 函数之后(`:71` 后、`getToolDefinitions` 之前)加共享 helper:

```ts
// ─── B-1 修复:输出读取回落 ──────────────────────────────────────────────────
// 当前输出缓冲非空、或有进程在跑 → 读当前缓冲;否则回落读最近结束运行的快照
// (process-state._lastFinishedRunOutput)。游戏结束后(用户关窗/秒崩/被杀)
// get_debug_output / stop_project 仍能报出该次运行的错误。
function resolveReadableOutput(ctx: ToolContext): { lines: string[]; fromSnapshot: boolean } {
  if (ctx.outputBuffer.length > 0 || ctx.runningProcess !== null) {
    return { lines: ctx.outputBuffer, fromSnapshot: false };
  }
  const snapshot = getLastFinishedRunOutput();
  return { lines: snapshot, fromSnapshot: snapshot.length > 0 };
}
```

(d) `run_project` case:参数解析区(`:145` `const waitForBridge = ...` 之后)加:

```ts
      const preview = args.preview === true;
```

定时器条件(`:220`)改为:

```ts
      if (timeout > 0 && !preview) {
```

返回消息两处(`:280` 与 `:282`)——`wait_for_bridge` 成功分支改为:

```ts
        if (preview) {
          return textResult(warnPrefix + 'Preview mode: bridge ready, game window open at ' + p + ', no auto-stop. It stays open until the user closes the window. After the user closes it, call get_debug_output to check for runtime errors.');
        }
        return textResult(warnPrefix + 'Bridge ready. ' + `Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
```

默认分支(`:282`)改为:

```ts
      if (preview) {
        return textResult(warnPrefix + 'Preview mode: game window is now open at ' + p + '. It stays open until the user closes the window (no auto-stop). After the user closes it, call get_debug_output to check for runtime errors.');
      }
      return textResult(warnPrefix + `Running project at ${p} (timeout: ${timeout}s; bridge not probed — wait_for_bridge=false). Use game_query(method="ping") to check bridge, or get_debug_output / stop_project.`);
```

(e) `stop_project` case(`:300`)改读数与结果:

```ts
      const { lines: stopLines, fromSnapshot: stopFromSnapshot } = resolveReadableOutput(ctx);
      const classified = classifyOutput(stopLines);
```

result 对象(`:303-310`)在 `status` 行后加 `source` 字段、`total_lines` 换源:

```ts
      const result = {
        status: 'stopped',
        source: stopFromSnapshot ? 'last_finished_run' : 'current_run',
        runtime: `${(runtimeMs / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: stopLines.length,
      };
```

(f) `get_debug_output` case(`:315-331`)整体替换为:

```ts
    case 'get_debug_output': {
      const { lines, fromSnapshot } = resolveReadableOutput(ctx);
      if (lines.length === 0 && !ctx.runningProcess) {
        return textResult('No debug output available. Run a project first.');
      }
      const classified = classifyOutput(lines);
      const debugRuntimeMs = ctx.processStartTime > 0 ? Date.now() - ctx.processStartTime : 0;
      const result = {
        running: ctx.runningProcess !== null,
        runtime: `${(debugRuntimeMs / 1000).toFixed(1)}s`,
        source: fromSnapshot ? 'last_finished_run' : 'current_run',
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: lines.length,
      };
      // P1-1: 引擎/游戏输出 nonce 信封(prints/errors/warnings 含项目 print 任意文本,输出侧防注入)
      return textResult(maybeWrapUntrusted('runtime.debug_output', 'godot-process', JSON.stringify(result, null, 2)));
    }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/runtime.test.js`
Expected: 全部 PASS(新增 8 例 + 原有全部用例不回归——特别注意 Imp-4 系列,mock ctx 的 setRunningProcess 增强了副作用,若有断言失败需核对是否本就是被掩盖的真实行为)。

- [ ] **Step 6: Commit**

```bash
git add src/tools/runtime.ts test/runtime.test.js
git commit -m "feat(runtime): run_project preview 预览模式(禁 TTL 常驻窗口)+ 输出快照回落(B-1 修复含 stop_project 报告空 bug)"
```

---

### Task 3: 规则双副本 + claudemd-builder 措辞

**Files:**
- Modify: `src/tools/rule-templates.ts`(`:111` 之后,core 模板「手动组合」段)
- Modify: `.claude/rules/godot-mcp-core.md`(`:95-97` 对应段)
- Modify: `src/tools/claudemd-builder.ts:90`(「运行时管理」段,不在机械校验范围)

**Interfaces:**
- Consumes: 无(纯文档字符串)。
- Produces: 双副本各新增「视觉改动收尾流程(preview 预览模式)」小节;`check:rules-sync` STRICT 校验必须通过。

- [ ] **Step 1: 改 `src/tools/rule-templates.ts`**

在 core 模板中 `bridge_timeout` 行(`:111`,注意模板字符串内反引号带 `\` 转义)之后追加(同样注意所有反引号写成 `` \` ``):

```text
  - \`run_project\` 支持 \`preview\` 参数（默认 false）：true 时禁用自动停止，游戏窗口常驻，用户关闭窗口即结束——用于 AI 改完视觉内容后的收尾验证（见下「视觉改动收尾流程」）。

### 视觉改动收尾流程（preview 预览模式）

AI 改动涉及用户需要看到效果才能验收的内容（\`.tscn\` / UI 脚本 / 样式 / 场景结构等）后，收尾动作不是让用户打开编辑器：

1. \`validate_scripts\` 快速语法验证（避免弹一个崩溃的窗口）；
2. \`run_project(preview=true)\` 弹出常驻游戏窗口；
3. 告知用户"游戏窗口已弹出，请确认效果，关闭窗口即验证结束"；
4. 用户关窗后 \`get_debug_output\` 检查运行时错误并汇报（运行结束后输出仍可读，\`source\` 标注 \`last_finished_run\`）。

- 纯逻辑 / 测试 / 文档改动不弹窗。
- preview **默认不传 \`wait_for_bridge\`**：bridge 未就绪会终止游戏进程，窗口会在用户眼前闪现即逝；仅当确实需要 bridge 查询运行时状态且项目 bridge 就绪快时才组合。
- 新一轮 \`run_project\` 会先停旧进程再起新窗口；旧输出经快照自动留档，换窗前可先 \`get_debug_output\` 保存上一轮错误。
```

- [ ] **Step 2: 同步 `.claude/rules/godot-mcp-core.md`**

同样内容(反引号**不**带转义,纯 markdown)加在「### run_and_verify vs 手动组合」小节的 `bridge_timeout` 行(`:97`)之后。内容与 Step 1 逐字一致(仅转义差异)。

- [ ] **Step 3: 改 `src/tools/claudemd-builder.ts:90`**

```text
- run_project 有超时设置，长时间运行需调整；preview=true 时无自动超时（窗口常驻至用户关闭，用于改后视觉验证）
```

- [ ] **Step 4: 构建并跑双副本同步校验**

Run: `npm run build && STRICT=1 npm run check:rules-sync`
Expected: `check-rules-content-sync` 输出全部文件一致,退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/tools/rule-templates.ts .claude/rules/godot-mcp-core.md src/tools/claudemd-builder.ts
git commit -m "docs(rules): 视觉改动收尾流程(preview 预览模式)——双副本同步 + claudemd-builder 措辞"
```

---

### Task 4: 版本链(硬门禁 bump)+ CHANGELOG + README

**Files:**
- Modify: `package.json`(经 `npm version` 脚本,不手改)
- Modify: `manifest.json` 等(version-sync 产物)
- Modify: `CHANGELOG.md`
- Modify: `README.md`(版本表新行 + `:223` 工具表行)

**Interfaces:**
- Consumes: Task 3 已改 `rule-templates.ts`(触发 bump 门禁)。
- Produces: 版本 0.33.2;`check-rules-version-bump.mjs` 通过;CHANGELOG 定版段。

- [ ] **Step 1: bump 版本并同步**

```bash
npm version patch --no-git-tag-version    # 0.33.1 → 0.33.2
npm run build
npm run version-sync                       # 同步 manifest.json 等
```

Expected: `package.json` version 变 0.33.2,version-sync 无 diff 报错。

- [ ] **Step 2: CHANGELOG 定版段**

在 `## [Unreleased]` 与 `## [0.33.1]` 之间插入(日期用实施当天):

```markdown
## [0.33.2] - <YYYY-MM-DD>

> 规则模板门禁触发的 patch bump（`check-rules-version-bump.mjs` 硬门禁）；npm publish / tag 待用户指令。

### Added
- `run_project` 新增 `preview` 参数：禁用自动停止，游戏窗口常驻至用户关闭，用于 AI 改完视觉内容后的收尾验证（替代开编辑器）。规则模板双副本新增「视觉改动收尾流程」，`claudemd-builder` 措辞同步。

### Fixed
- 输出快照机制（设计审阅 B-1）：游戏进程结束（关窗/被杀/秒崩）后 `get_debug_output` 仍可读取该次运行输出（`source: "last_finished_run"` 标注）——修复 `setRunningProcess(null)` 连带清空输出缓冲导致"运行结束后查错不可达"。
- 顺带修复现存 bug：`stop_project` 在 `killProcess` 返回后输出缓冲已被 close handler 清空，停止报告的 errors/warnings 实际一直为空；现走快照回落。
```

- [ ] **Step 3: README 两处**

(a) `:223` 工具表行改为:

```markdown
| `run_project` | 以调试模式运行项目（自动超时；`preview=true` 时窗口常驻至用户关闭，用于改后视觉验证） |
```

(b) 版本表(用 `grep -n '| \*\*v0.33' README.md` 定位最新行)在最新行上方插入:

```markdown
| **v0.33.2** | <YYYY-MM-DD> | **预览模式**：`run_project(preview)` 禁自动停止、弹常驻游戏窗口（AI 改完视觉验证，替代开编辑器）+ 输出快照（`get_debug_output` 关窗后仍可查错，`source` 标注；顺带修 `stop_project` 报告空 bug）。规则模板加「视觉改动收尾流程」。 |
```

- [ ] **Step 4: 验证版本链**

Run: `node scripts/check-rules-version-bump.mjs && npm run version-check`
Expected: 两者退出码 0(bump 门禁满足、版本一致)。

- [ ] **Step 5: Commit**

```bash
git add package.json manifest.json CHANGELOG.md README.md
git commit -m "chore(release): 0.33.2 规则模板门禁 bump——预览模式批(CHANGELOG 定版 + README 版本行)"
```

(注:version-sync 若还改了其它文件,一并 add;`git status` 确认无遗漏。)

---

### Task 5: 生成产物 + 全量门禁 + 手动验收

**Files:**
- Regenerate: `docs/tools/runtime.md`(gen:tool-docs 产物,preview 参数进参数表)
- Regenerate: `docs/capability-matrix.{json,md}`(build-matrix 产物)

**Interfaces:**
- Consumes: Task 1-4 全部完成。
- Produces: 全绿门禁;交付就绪状态。

- [ ] **Step 1: 再生成产物**

```bash
npm run build              # 确保 build/ 最新
npm run gen:tool-docs      # docs/tools/runtime.md 参数表含 preview
npm run build-matrix       # capability-matrix 重建
npm run check:budget       # token 预算不超
```

Expected: gen:tool-docs/build-matrix 无报错;check:budget 通过。

- [ ] **Step 2: 全量门禁**

```bash
npm run lint
npm test
```

Expected: lint 零错误;测试全绿(覆盖率不低于既有阈值)。

- [ ] **Step 3: 手动验收(需 GODOT_PATH + 任一真实 Godot 项目)**

```bash
# 在该项目的 MCP 会话中依次:
# 1. runtime run_project preview=true → 游戏窗口弹出且 >60s 不消失
# 2. 手动关闭游戏窗口
# 3. runtime get_debug_output → 返回 source:"last_finished_run" 且含该次运行的输出
```

无 GODOT_PATH 环境时跳过并在交付报告中注明。

- [ ] **Step 4: Commit 产物**

```bash
git add docs/tools/runtime.md docs/capability-matrix.json docs/capability-matrix.md
git commit -m "docs(tools): 预览模式参数文档与 capability-matrix 再生成"
```

---

## 验收标准(对照设计文档)

1. `run_project(preview=true)`:不设 autoStopTimer、返回 Preview mode 文案(无 timeout 秒数)——Task 2 测试覆盖。
2. 游戏结束后 `get_debug_output` 读到快照(`source: "last_finished_run"`)——Task 1+2 测试覆盖。
3. `stop_project` 报告不再恒空——Task 2 测试覆盖(现存 bug 顺带修复)。
4. 双副本一致(`STRICT=1 check:rules-sync`)、版本 bump 门禁满足——Task 3/4。
5. 生成产物与代码一致(gen:tool-docs/build-matrix/budget)——Task 5。
6. lint + build + test 全绿——Task 5。
7. 实施后产出第三方审查文档 `docs/reviews/<日期>-run-project-preview.md`(AGENTS.md §8,本计划范围外、交付流程内必做)。
8. 实施完成后登记 memory:feature-decision-log(补充实施 commit 清单与验证结果)+ 本次实施新教训(若有)——AGENTS.md「完成前必登 memory」。
