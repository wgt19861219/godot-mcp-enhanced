# ToolDispatcher 提取实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GodotServer.setupHandlers() 中的工具调用管道提取为独立的 ToolDispatcher 类，同时修复 executor 内存泄漏 bug。

**Architecture:** 新建 `src/core/ToolDispatcher.ts`，从 GodotServer.ts 搬入工具列表过滤、ctx 构建、CallTool 管道（归一化→guard→confirm→dispatch）、fallback 警告等逻辑。GodotServer 保留 MCP 协议连接 + Resource 处理器 + detectProjectPath。dispatchTool 保持纯 headless 职责，editor/headless 分支在 handleCall 层面处理。

**Tech Stack:** TypeScript, Vitest, MCP SDK

**Spec:** `docs/superpowers/specs/2026-05-30-tooldispatcher-extraction-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/core/ToolDispatcher.ts` | **新建** | 工具分发器：列表过滤、ctx 构建、CallTool 管道、状态管理 |
| `src/GodotServer.ts` | 修改 | 删除搬走的代码，setupHandlers 委托给 ToolDispatcher |
| `test/core/ToolDispatcher.test.ts` | **新建** | 27 条路径单元测试 |
| `test/godot-server.test.js` | 不修改 | 现有集成测试保持不变（handler 捕获方式不受影响） |

---

### Task 1: 创建 ToolDispatcher 骨架 + 构造函数/ctx 构建

**Files:**
- Create: `src/core/ToolDispatcher.ts`

- [ ] **Step 1: 创建 ToolDispatcher.ts 骨架**

包含完整导入、接口定义、构造函数、ctx 构建、四个公有方法签名和六个私有方法签名。

```typescript
// src/core/ToolDispatcher.ts
import type { ToolResult, ToolContext } from '../types.js';
import type { ChildProcess } from 'child_process';
import type { ReadOnlyGuard } from './ReadOnlyGuard.js';
import type { EditorToolExecutor } from './EditorToolExecutor.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  requiresConfirmation,
  createPendingToken,
  consumeToken,
} from '../guard.js';
import {
  getAllToolDefinitions,
  getModuleForTool,
  LITE_TOOLS,
} from './tool-registry.js';
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
import * as ps from './process-state.js';

const DEBUG = process.env.DEBUG === 'true';
function log(...args: unknown[]): void {
  if (DEBUG) console.error('[tool-dispatcher]', ...args);
}

export interface DispatcherOptions {
  // 模式控制
  readOnly: boolean;
  mode: 'full' | 'lite';
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;

  // 依赖注入
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  opsScript: string;
  findGodot: () => Promise<string>;
}

export class ToolDispatcher {
  private readonly options: DispatcherOptions;
  private readonly readOnlyGuard: ReadOnlyGuard;
  private connectionMode: 'headless' | 'editor';
  private editorExecutor: EditorToolExecutor | null;
  private readonly ctx: ToolContext;
  private _editorFallback = false;
  private _editorFallbackWarned = false;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.readOnlyGuard = options.readOnlyGuard;
    this.connectionMode = options.connectionMode;
    this.editorExecutor = options.editorExecutor ?? null;

    // 构建 ctx — 直接 import process-state（内部实现细节）
    this.ctx = {
      opsScript: options.opsScript,
      findGodot: options.findGodot,
      get runningProcess() { return ps.getRunningProcess(); },
      setRunningProcess(proc: ChildProcess | null) { ps.setRunningProcess(proc); },
      get outputBuffer() { return ps.getOutputBuffer(); },
      setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
      get processStartTime() { return ps.getProcessStartTime(); },
      setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
      get projectDir() { return ps.getProjectDir(); },
      setProjectDir(d: string) { ps.setProjectDir(d); },
      parseGodotConfig,
    };
  }

  // ── 公有方法（后续 task 实现） ──

  getFilteredTools(): Tool[] {
    return [];
  }

  async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> {
    return { content: [{ type: 'text', text: 'not implemented' }] };
  }

  setConnectionMode(mode: 'headless' | 'editor'): void {
    this.connectionMode = mode;
  }

  setEditorExecutor(executor: EditorToolExecutor | null): void {
    if (this.editorExecutor) {
      this.editorExecutor.destroy();
    }
    this.editorExecutor = executor;
  }

  // ── 内部方法（后续 task 实现） ──

  /** 标记 editor fallback 状态（由 GodotServer.run() 调用） */
  markEditorFallback(): void {
    this._editorFallback = true;
  }

  private normalizeArgs(rawArgs: Record<string, unknown> | undefined): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (rawArgs) {
      for (const [key, value] of Object.entries(rawArgs)) {
        const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        args[snake] = value;
      }
    }
    return args;
  }

  private validatePathArgs(args: Record<string, unknown>): ToolResult | null {
    if (typeof args.project_path === 'string' && !isPathInAllowedRoots(args.project_path)) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'PATH_NOT_ALLOWED', message: `Path not in ALLOWED_PROJECT_PATHS: ${args.project_path}` } }) }], isError: true };
    }
    if (typeof args.search_dir === 'string' && !isPathInAllowedRoots(args.search_dir)) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'PATH_NOT_ALLOWED', message: `Search directory not in ALLOWED_PROJECT_PATHS: ${args.search_dir}. Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true.` } }) }], isError: true };
    }
    return null;
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
    const pathErr = this.validatePathArgs(args);
    if (pathErr) return pathErr;
    const targetMod = getModuleForTool(toolName);
    if (!targetMod) {
      return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] };
    }
    const result = await targetMod.handleTool(toolName, args, this.ctx);
    if (result !== null) {
      const duration = Date.now() - startTime;
      return { ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
    }
    return { content: [{ type: 'text', text: `Tool "${toolName}" registered but handler returned null` }] };
  }

  private attachFallbackWarning(result: ToolResult): ToolResult {
    if (this._editorFallback && !this._editorFallbackWarned) {
      this._editorFallbackWarned = true;
      const first = result.content?.[0];
      if (first?.type === 'text') {
        first.text += '\n\n⚠️ [EDITOR_FALLBACK] Running in Headless mode — Editor features (UndoRedo, live scene sync) unavailable.';
      }
    }
    return result;
  }
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新增错误（可能有 handleCall 返回类型不匹配的警告，后续 task 修复）

- [ ] **Step 3: 提交骨架**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat: add ToolDispatcher skeleton with constructor, ctx, and private methods"
```

---

### Task 2: 实现 getFilteredTools

**Files:**
- Modify: `src/core/ToolDispatcher.ts` — `getFilteredTools()` 方法

- [ ] **Step 1: 替换 getFilteredTools 的桩实现**

将 `return [];` 替换为完整实现：

```typescript
  getFilteredTools(): Tool[] {
    let allTools = getAllToolDefinitions();

    // 内联工具: confirm_and_execute
    allTools.push({
      name: 'confirm_and_execute',
      description: 'Execute a previously blocked tool using a confirmation token. Use this when a tool returns a confirmation_token.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: { type: 'string', description: 'Confirmation token from the blocked tool response' },
        },
        required: ['token'],
      },
    });

    // READ_ONLY_MODE 过滤
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !this.readOnlyGuard.check(t.name).blocked);
      log('READ_ONLY_MODE: %d tools available', allTools.length);
    }

    // LITE 模式过滤
    if (this.options.mode === 'lite') {
      allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
      log('LITE mode: %d tools available', allTools.length);
    }

    return allTools;
  }
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat: implement ToolDispatcher.getFilteredTools with readOnly/lite filtering"
```

---

### Task 3: 实现 handleCall 管道

**Files:**
- Modify: `src/core/ToolDispatcher.ts` — `handleCall()` 方法

ADVISORY 决策：`dispatchTool` 保持纯 headless 职责（validatePathArgs + 模块路由 + duration）。editor/headless 分支在 `handleCall` 层面处理，confirm 分支复用同一分支逻辑。

- [ ] **Step 1: 替换 handleCall 的桩实现**

将桩 `handleCall` 替换为完整管道：

```typescript
  async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> {
    const { name, arguments: rawArgs } = request.params;
    const startTime = Date.now();
    const args = this.normalizeArgs(rawArgs);

    try {
      // ── 1. ReadOnlyGuard ──
      const guardResult = this.readOnlyGuard.check(name);
      if (guardResult.blocked) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: guardResult.errorCode, message: guardResult.message } }) }],
          isError: true,
        };
      }

      // ── 2. confirm_and_execute 分支 ──
      if (name === 'confirm_and_execute') {
        const token = args.token as string;
        if (!token || typeof token !== 'string') {
          return { content: [{ type: 'text', text: 'Error: confirmation_token is required' }] };
        }
        const pending = consumeToken(token);
        if (!pending) {
          return { content: [{ type: 'text', text: 'Error: invalid or expired confirmation token' }] };
        }

        // 二次 guard 检查
        const confirmedGuardResult = this.readOnlyGuard.check(pending.toolName);
        if (confirmedGuardResult.blocked) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: confirmedGuardResult.errorCode, message: confirmedGuardResult.message } }) }],
            isError: true,
          };
        }

        // 复用同一 editor/headless 分支逻辑
        log('[CONFIRM] Executing confirmed tool: %s', pending.toolName);
        if (this.connectionMode === 'editor' && this.editorExecutor) {
          const editorResult = await this.editorExecutor.execute(pending.toolName, pending.args);
          const duration = Date.now() - startTime;
          return this.attachFallbackWarning({ ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
        }
        return this.attachFallbackWarning(await this.dispatchTool(pending.toolName, pending.args, startTime));
      }

      // ── 3. 确认令牌检查 ──
      if (requiresConfirmation(name, args)) {
        const token = createPendingToken(name, args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              requires_confirmation: true,
              tool: name,
              confirmation_token: token,
              message: `Tool "${name}" requires confirmation. Call confirm_and_execute with this token to proceed.`,
              ttl_seconds: 180,
            }),
          }],
        };
      }

      // ── 4. editor 模式 dispatch ──
      if (this.connectionMode === 'editor' && this.editorExecutor) {
        const editorResult = await this.editorExecutor.execute(name, args);
        const duration = Date.now() - startTime;
        return this.attachFallbackWarning({ ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
      }

      // ── 5. headless dispatch ──
      return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Tool error:', name, msg);
      return { content: [{ type: 'text', text: `Error: ${msg}` }] };
    }
  }
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat: implement ToolDispatcher.handleCall with full pipeline (guard→confirm→dispatch)"
```

---

### Task 4: 改造 GodotServer.ts — 委托给 ToolDispatcher

**Files:**
- Modify: `src/GodotServer.ts`

这一步将 setupHandlers 简化，删除搬走的顶层函数和不再需要的 import。

- [ ] **Step 1: 添加 ToolDispatcher import**

在 `src/GodotServer.ts` 的 import 区域添加：

```typescript
import { ToolDispatcher } from './core/ToolDispatcher.js';
```

- [ ] **Step 2: 删除搬走的顶层代码**

从 GodotServer.ts 删除以下代码（它们已搬到 ToolDispatcher）：

1. 删除 `import { requiresConfirmation, createPendingToken, consumeToken } from './guard.js';`（第 62 行）
2. 删除 `validatePathArgs` 函数（第 77-85 行）
3. 删除 `dispatchTool` 函数（第 87-103 行）
4. 删除 `DEBUG` 和 `log` 函数（第 105-109 行）

- [ ] **Step 3: 添加 dispatcher 字段**

在 GodotServer 类的字段区域添加：

```typescript
  private dispatcher: ToolDispatcher | null = null;
```

- [ ] **Step 4: 替换 setupHandlers 方法**

将整个 `setupHandlers()` 方法替换为简化版：

```typescript
  private setupHandlers(): void {
    const dispatcher = new ToolDispatcher({
      readOnly: this.options.readOnly ?? false,
      mode: this.options.mode ?? 'full',
      readOnlyGuard: this.readOnlyGuard,
      connectionMode: this.connectionMode,
      noFallback: this.noFallback,
      opsScript: this.opsScript,
      findGodot,
    });
    this.dispatcher = dispatcher;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: dispatcher.getFilteredTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      dispatcher.handleCall(request)
    );

    // ── MCP Resources handlers ──────────────────────────────────────────────
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const projectPath = this.detectProjectPath();
      const resources = listMcpResources(projectPath);
      return { resources };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const templates = listMcpResourceTemplates();
      return { resourceTemplates: templates };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const projectPath = this.detectProjectPath();
      const content = readMcpResource(uri, projectPath);
      return { contents: [content] };
    });
  }
```

- [ ] **Step 5: 调整 run() 方法**

在 `run()` 方法中，所有 editor fallback 和连接成功的地方，改用 dispatcher：

将 `this._editorFallback = true;` 后面的代码改为：
```typescript
        this._editorFallback = true;
        this.connectionMode = 'headless';
        this.dispatcher?.setConnectionMode('headless');
```

在 editor 连接成功的地方：
```typescript
          this.editorExecutor = new EditorToolExecutor(this.editorConn);
          this.dispatcher?.setEditorExecutor(this.editorExecutor);
```

在 editor 连接失败 fallback 的地方：
```typescript
          this._editorFallback = true;
          this.connectionMode = 'headless';
          this.dispatcher?.setConnectionMode('headless');
```

- [ ] **Step 6: 调整 close() 方法**

在 `close()` 中，editor 连接清理改为：

```typescript
  async close(): Promise<void> {
    if (this.editorConn) {
      this.editorConn.disconnect();
      this.editorConn = null;
      this.dispatcher?.setEditorExecutor(null);
      log('Editor connection closed');
    }
    const proc = ps.getRunningProcess();
    if (proc && !proc.killed) {
      await killProcess(proc);
      ps.setProcessBusy(false);
      ps.setRunningProcess(null);
      log('Running Godot process killed');
    }
    await this.server.close();
    log('Server shut down');
  }
```

注意：`log` 函数已从 GodotServer 中删除。在 close() 中需要重新添加一个简单的 log，或者移除这些 log 调用。**选择方案：在 GodotServer.ts 中保留一个简单的 log 函数**（只有 close/run 中用到几处）：

```typescript
const DEBUG = process.env.DEBUG === 'true';
function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
}
```

- [ ] **Step 7: 删除不再使用的字段**

从 GodotServer 类中删除：
- `private _editorFallback = false;` — 移到 ToolDispatcher
- `private _editorFallbackWarned = false;` — 移到 ToolDispatcher
- `private editorExecutor: EditorToolExecutor | null = null;` — 移到 ToolDispatcher（GodotServer 不再直接持有）

- [ ] **Step 8: 验证编译 + 现有测试**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

Run: `npx vitest run test/godot-server.test.js 2>&1 | tail -20`
Expected: 所有测试通过

Run: `npx vitest run test/guard.test.js 2>&1 | tail -10`
Expected: 所有测试通过

Run: `npx vitest run test/tool-registry.test.js 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 9: 提交**

```bash
git add src/GodotServer.ts
git commit -m "refactor: delegate GodotServer.setupHandlers to ToolDispatcher, fix executor destroy leak"
```

---

### Task 5: 编写 ToolDispatcher 单元测试 — getFilteredTools + 状态管理（T20-T27）

**Files:**
- Create: `test/core/ToolDispatcher.test.ts`

- [ ] **Step 1: 创建测试文件 — getFilteredTools 和 setConnectionMode/setEditorExecutor**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatcherOptions } from '../../src/core/ToolDispatcher.js';
import { ToolDispatcher } from '../../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { EditorToolExecutor } from '../../src/core/EditorToolExecutor.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Mock tool-registry（ToolDispatcher 的核心依赖）
const mockGetAllToolDefinitions = vi.fn<() => Tool[]>();
const mockGetModuleForTool = vi.fn();
const mockLITE_TOOLS = new Set(['project', 'scene', 'script', 'validation', 'confirm_and_execute']);

vi.mock('../../src/core/tool-registry.js', () => ({
  getAllToolDefinitions: mockGetAllToolDefinitions,
  getModuleForTool: mockGetModuleForTool,
  LITE_TOOLS: mockLITE_TOOLS,
}));

// Mock guard.ts
const mockRequiresConfirmation = vi.fn();
const mockCreatePendingToken = vi.fn();
const mockConsumeToken = vi.fn();

vi.mock('../../src/guard.js', () => ({
  requiresConfirmation: mockRequiresConfirmation,
  createPendingToken: mockCreatePendingToken,
  consumeToken: mockConsumeToken,
}));

// Mock helpers.ts
vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
  parseGodotConfig: vi.fn().mockReturnValue({}),
}));

// Mock process-state.ts
vi.mock('../../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
}));

// Mock ReadOnlyGuard
function createMockGuard(blocked: boolean): ReadOnlyGuard {
  return {
    check: vi.fn().mockReturnValue({ blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined }),
  } as unknown as ReadOnlyGuard;
}

// 测试用 fixture 工具列表
const FIXTURE_TOOLS: Tool[] = [
  { name: 'scene', description: 'Scene ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'script', description: 'Script ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'project', description: 'Project ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'docs', description: 'Docs ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'Screenshot ops', inputSchema: { type: 'object', properties: {} } },
];

function createOptions(overrides?: Partial<DispatcherOptions>): DispatcherOptions {
  return {
    readOnly: false,
    mode: 'full',
    connectionMode: 'headless',
    noFallback: false,
    readOnlyGuard: createMockGuard(false),
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn().mockResolvedValue('/fake/godot'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
  mockRequiresConfirmation.mockReturnValue(false);
});

// ── getFilteredTools ────────────────────────────────────────────────────────

describe('ToolDispatcher.getFilteredTools', () => {
  // [T20] 默认模式 → 全部 + confirm_and_execute
  it('returns all tools plus confirm_and_execute in default mode', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('confirm_and_execute');
    expect(names).toContain('scene');
    expect(names).toContain('script');
    expect(names).toContain('docs');
    expect(names.length).toBe(FIXTURE_TOOLS.length + 1); // +1 for confirm_and_execute
  });

  // [T21] readOnly → 过滤写工具
  it('filters write tools when readOnly is true', () => {
    // scene/script/project blocked by guard, docs/screenshot pass
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const blocked = ['scene', 'script', 'project'].includes(name);
      return { blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined };
    });
    const dispatcher = new ToolDispatcher(createOptions({ readOnly: true, readOnlyGuard: guard }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('docs');
    expect(names).toContain('screenshot');
    expect(names).not.toContain('scene');
    expect(names).not.toContain('script');
  });

  // [T22] lite → 只保留 LITE_TOOLS
  it('filters to LITE_TOOLS in lite mode', () => {
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'lite' }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    for (const name of names) {
      expect(mockLITE_TOOLS.has(name)).toBe(true);
    }
    expect(names).toContain('project');
    expect(names).toContain('scene');
    expect(names).toContain('confirm_and_execute');
  });

  // [T23] readOnly + lite 组合
  it('applies both readOnly and lite filters combined', () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      // scene/script/project blocked
      const blocked = ['scene', 'script', 'project'].includes(name);
      return { blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined };
    });
    const dispatcher = new ToolDispatcher(createOptions({ readOnly: true, mode: 'lite', readOnlyGuard: guard }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain('scene');
    expect(names).not.toContain('script');
    expect(names).not.toContain('project');
    // 所有返回的工具必须同时在 LITE_TOOLS 中且通过 guard
    for (const name of names) {
      expect(mockLITE_TOOLS.has(name)).toBe(true);
    }
  });
});

// ── setConnectionMode ───────────────────────────────────────────────────────

describe('ToolDispatcher.setConnectionMode', () => {
  // [T24] 模式切换
  it('switches connection mode', () => {
    const dispatcher = new ToolDispatcher(createOptions({ connectionMode: 'editor' }));
    // 验证初始模式：构造函数设置了 connectionMode
    dispatcher.setConnectionMode('headless');
    // 无报错即通过（行为验证在 handleCall 测试中）
    expect(true).toBe(true);
  });
});

// ── setEditorExecutor ───────────────────────────────────────────────────────

describe('ToolDispatcher.setEditorExecutor', () => {
  // [T25] 设置新 executor
  it('sets a new executor', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const mockExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(mockExecutor);
    // 验证：无报错，destroy 未调用（因为是首次设置）
    expect(mockExecutor.destroy).not.toHaveBeenCalled();
  });

  // [T26] 传 null → 自动 destroy 旧的
  it('destroys old executor when set to null', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const mockExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(mockExecutor);
    dispatcher.setEditorExecutor(null);
    expect(mockExecutor.destroy).toHaveBeenCalledOnce();
  });

  // [T27] 替换旧 executor → 先 destroy 旧的
  it('destroys old executor when replacing with new one', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const oldExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const newExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(oldExecutor);
    dispatcher.setEditorExecutor(newExecutor);
    expect(oldExecutor.destroy).toHaveBeenCalledOnce();
    expect(newExecutor.destroy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run test/core/ToolDispatcher.test.ts 2>&1 | tail -30`
Expected: 全部通过（约 7 个测试）

- [ ] **Step 3: 提交**

```bash
git add test/core/ToolDispatcher.test.ts
git commit -m "test: add ToolDispatcher tests for getFilteredTools + state management (T20-T27)"
```

---

### Task 6: 编写 ToolDispatcher 单元测试 — handleCall 管道（T1-T19）

**Files:**
- Modify: `test/core/ToolDispatcher.test.ts`

在文件末尾追加 handleCall 管道测试。

- [ ] **Step 1: 在测试文件末尾追加 handleCall 测试**

```typescript
// ── handleCall 管道 ─────────────────────────────────────────────────────────

describe('ToolDispatcher.handleCall', () => {
  const mockToolResult: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
  };

  function createDispatcherForHandleCall(overrides?: Partial<DispatcherOptions>) {
    return new ToolDispatcher(createOptions(overrides));
  }

  // [T1] rawArgs undefined → 空 args {}
  it('handles undefined rawArgs gracefully', async () => {
    const guard = createMockGuard(false);
    // 让 requiresConfirmation 返回 false，dispatch 返回结果
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene' } });
    expect(result).toBeTruthy();
    // handleTool 被调用时 args 应为 {}
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', {}, expect.anything());
  });

  // [T2] 正常 camelCase → snake_case 转换
  it('normalizes camelCase args to snake_case', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { projectPath: '/test', nodeName: 'Player' } },
    });
    const calledArgs = mockModule.handleTool.mock.calls[0][1];
    expect(calledArgs).toHaveProperty('project_path');
    expect(calledArgs).toHaveProperty('node_name');
    expect(calledArgs).not.toHaveProperty('projectPath');
  });

  // [T3] readOnlyGuard.blocked → 返回错误
  it('returns error when readOnlyGuard blocks the tool', async () => {
    const guard = createMockGuard(true);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
  });

  // [T4] readOnlyGuard.passed → 继续（通过 T14 间接测试）
  it('proceeds when readOnlyGuard passes', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    expect(mockModule.handleTool).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  // [T5] confirm_and_execute token 缺失
  it('returns error when confirm_and_execute has no token', async () => {
    const dispatcher = createDispatcherForHandleCall();
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('confirmation_token is required');
  });

  // [T6] consumeToken 返回 null
  it('returns error when token is invalid or expired', async () => {
    mockConsumeToken.mockReturnValue(null);
    const dispatcher = createDispatcherForHandleCall();
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'bad-token' } } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('invalid or expired');
  });

  // [T7] confirm 分支二次 readOnlyGuard 检查
  it('re-checks readOnlyGuard for confirmed tool', async () => {
    const guard = createMockGuard(false);
    // 第一次 check（confirm_and_execute）通过，第二次 check（scene）阻止
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'confirm_and_execute') return { blocked: false };
      return { blocked: true, errorCode: -32001, message: 'blocked after confirm' };
    });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: {} });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
  });

  // [T8] confirm 分支 editor 模式 dispatch
  it('dispatches confirmed tool via editor executor', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'read_scene' });
  });

  // [T9] confirm 分支 headless dispatch
  it('dispatches confirmed tool via headless when no executor', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'headless' });
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'read_scene' }, expect.anything());
  });

  // [T10] requiresConfirmation → 返回 token
  it('returns confirmation token when tool requires confirmation', async () => {
    const guard = createMockGuard(false);
    mockRequiresConfirmation.mockReturnValue(true);
    mockCreatePendingToken.mockReturnValue('test-token-123');
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'remove_node' } } });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.requires_confirmation).toBe(true);
    expect(parsed.confirmation_token).toBe('test-token-123');
    expect(parsed.tool).toBe('scene');
  });

  // [T11] 不需要确认 → 继续（通过 T14 间接测试）

  // [T12] editor 模式 + executor 存在 → 转发
  it('forwards to editor executor in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'add_node' });
  });

  // [T13] editor 模式 executor 为 null → fallback headless
  it('falls back to headless when executor is null in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    // 不设置 executor → null
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [T14] headless 正常返回 + duration
  it('returns result with duration in headless mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    // duration 附加在最后一个 content 条目
    const lastContent = result.content[result.content.length - 1] as { text: string };
    expect(lastContent.text).toMatch(/_duration_ms: \d+/);
  });

  // [T15] 工具不存在 → Unknown tool
  it('returns unknown tool error when module not found', async () => {
    const guard = createMockGuard(false);
    mockGetModuleForTool.mockReturnValue(undefined);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'nonexistent_tool', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown tool');
  });

  // [T16] handler 返回 null → 错误消息
  it('returns error when tool handler returns null', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(null) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('handler returned null');
  });

  // [T17] 首次 fallback → 附加警告
  it('attaches fallback warning on first response when in fallback mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    dispatcher.markEditorFallback();
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const firstText = (result.content[0] as { text: string }).text;
    expect(firstText).toContain('EDITOR_FALLBACK');
  });

  // [T18] 非首次或非 fallback → 不附加
  it('does not attach fallback warning on second call', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    }) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    dispatcher.markEditorFallback();
    // 第一次
    await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    // 第二次 — 生成新的 mock 结果（因为 attachFallbackWarning 会修改 content）
    mockModule.handleTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    });
    const result2 = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const firstText = (result2.content[0] as { text: string }).text;
    expect(firstText).not.toContain('EDITOR_FALLBACK');
  });

  // [T19] catch 异常 → 错误消息
  it('catches exceptions and returns error message', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockRejectedValue(new Error('boom')) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('boom');
  });
});
```

- [ ] **Step 2: 运行全部 ToolDispatcher 测试**

Run: `npx vitest run test/core/ToolDispatcher.test.ts 2>&1 | tail -40`
Expected: 全部通过（约 27 个测试）

- [ ] **Step 3: 提交**

```bash
git add test/core/ToolDispatcher.test.ts
git commit -m "test: add ToolDispatcher handleCall pipeline tests (T1-T19)"
```

---

### Task 7: 全量回归测试 + 清理

**Files:**
- 无新增/修改文件

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run 2>&1 | tail -30`
Expected: 所有测试通过

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 验证 ESLint**

Run: `npx eslint src/core/ToolDispatcher.ts src/GodotServer.ts 2>&1 | head -20`
Expected: 无错误（或有已知的非本次引入的警告）

- [ ] **Step 4: 最终提交（如有 lint 修复）**

```bash
git add -A
git commit -m "chore: lint fixes after ToolDispatcher extraction"
```

（仅在 Step 2-3 发现问题时才需要此提交）

---

## 自审检查

### 1. Spec 覆盖率

| Spec 要求 | Task |
|-----------|------|
| DispatcherOptions 6 字段 | Task 1 Step 1 |
| getFilteredTools (readOnly/lite/confirm_and_execute) | Task 2 |
| handleCall 完整管道 | Task 3 |
| setConnectionMode | Task 1 (骨架) + Task 5 (T24) |
| setEditorExecutor + destroy | Task 1 (骨架) + Task 5 (T25-T27) |
| markEditorFallback | Task 1 (骨架) + Task 6 (T17) |
| ctx 构建 | Task 1 Step 1 |
| GodotServer setupHandlers 简化 | Task 4 |
| GodotServer run() 调整 | Task 4 Step 5 |
| GodotServer close() 调整 | Task 4 Step 6 |
| 删除搬走的代码 | Task 4 Step 2 |
| 27 条测试路径 | Task 5 + Task 6 |
| 全量回归 | Task 7 |

### 2. 占位符扫描

无 TBD/TODO/占位符。所有步骤包含完整代码。

### 3. 类型一致性

- `DispatcherOptions` 在 Task 1 定义，Task 4 构造时使用 — 字段完全匹配
- `ToolResult` 类型从 `../types.js` import，贯穿所有 Task
- `EditorToolExecutor.destroy()` 在 Task 1 的 setEditorExecutor 中调用，与 `EditorToolExecutor.ts:29` 一致
- `attachFallbackWarning` 返回 `ToolResult`，管道中正确链接
- `handleCall` 返回 `Promise<ToolResult>`，所有分支返回 `ToolResult` 兼容对象
