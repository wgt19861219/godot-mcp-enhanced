# I-01: 提取 ToolDispatcher 类

**日期:** 2026-05-30
**状态:** 已批准（审查修订 v2）
**上下文:** v0.15.1 审查报告 I-01（GodotServer 大拆分）

## 背景

GodotServer.ts 当前 386 行，架构已比早期版本好很多（31 个工具模块独立、tool-registry 模块化、EditorConnection 分离）。但 `setupHandlers()` 方法（~163 行）仍然混合了多个横切关注点：

1. 工具列表收集 + readOnly/lite 过滤
2. 工具上下文构建 (ctx)
3. CallTool 路由（参数归一化、guard、confirm、dispatch、editor fallback）
4. Editor fallback 警告管理

这些逻辑耦合在一个匿名函数里，难以单独测试和演进。

## 目标

- 将工具调用管道提取为独立的 `ToolDispatcher` 类
- GodotServer 只负责 MCP 协议连接 + Resource 处理
- 不破坏现有 API 和测试
- 新增 ToolDispatcher 单元测试（27 条路径全覆盖）
- 修复现有 bug：setEditorExecutor 替换时未 destroy → 内存泄漏

## 架构

```
Before:                              After:
┌─────────────────────┐             ┌─────────────────────┐
│    GodotServer      │             │    GodotServer      │
│  - MCP 协议连接      │             │  - MCP 协议连接      │
│  - 工具列表过滤      │             │  - Resource 处理器   │
│  - ctx 构建         │             │  - detectProjectPath │
│  - readOnlyGuard    │             │  - run() / close()   │
│  - confirm 令牌     │             └──────────┬───────────┘
│  - editor 分发      │                        │ uses
│  - headless 分发    │             ┌──────────▼───────────┐
│  - Resource 处理器   │             │   ToolDispatcher     │
│  - detectProjectPath│             │  - 工具列表过滤       │
│  - run() / close()  │             │  - ctx 构建          │
└─────────────────────┘             │  - readOnlyGuard     │
                                    │  - confirm 令牌      │
                                    │  - editor 分发       │
                                    │  - headless 分发     │
                                    │  - fallback 警告     │
                                    └──────────────────────┘
```

## 新文件: `src/core/ToolDispatcher.ts`

### 外部依赖

ToolDispatcher 直接 import 以下模块（不通过构造函数注入）：

| 模块 | 使用的导出 | 用途 |
|------|-----------|------|
| `guard.ts` | `requiresConfirmation`, `createPendingToken`, `consumeToken` | confirm 令牌流程 |
| `tool-registry.ts` | `getAllToolDefinitions`, `getModuleForTool`, `LITE_TOOLS` | 工具发现和路由 |
| `helpers.ts` | `isPathInAllowedRoots`, `parseGodotConfig` | 路径验证 |
| `process-state.ts` | `*` (ps) | ctx getter/setter 代理 |
| `types.ts` | `ToolResult`, `ToolContext` | 类型 |

### 接口

```typescript
export interface DispatcherOptions {
  // 模式控制
  readOnly: boolean;                      // READ_ONLY_MODE 过滤
  mode: 'full' | 'lite';                  // LITE 工具集过滤
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;

  // 依赖注入
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  opsScript: string;                      // ctx 构建
  findGodot: () => Promise<string>;       // ctx 构建
}

export class ToolDispatcher {
  constructor(options: DispatcherOptions);

  /** 返回过滤后的工具列表（含 confirm_and_execute 内联工具） */
  getFilteredTools(): ToolDefinition[];

  /** 处理 CallTool 请求 — 完整管道（归一化→guard→confirm→dispatch） */
  handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult>;

  /** 运行时切换连接模式（editor fallback 时使用） */
  setConnectionMode(mode: 'headless' | 'editor'): void;

  /** 设置/清除编辑器执行器。传 null 时自动 destroy 旧执行器（修复内存泄漏） */
  setEditorExecutor(executor: EditorToolExecutor | null): void;
}
```

### handleCall 完整管道

`handleCall` 是**唯一的 try-catch 边界**，内部私有方法不自行捕获异常。

```
handleCall(request)
  ├── 1. normalizeArgs(rawArgs) — camelCase → snake_case
  │     └── rawArgs undefined → 空 args {}
  │
  ├── 2. readOnlyGuard.check(name)
  │     └── blocked → return error [T3]
  │
  ├── 3. name === 'confirm_and_execute'?
  │     ├── token 缺失/类型错误 → return error [T5]
  │     ├── consumeToken(token) → null → return error [T6]
  │     ├── readOnlyGuard.check(pending.toolName) → blocked → return error [T7]
  │     └── dispatchTool(pending.toolName, pending.args) ← 复用同一 dispatch
  │         ├── editor 模式 + executor → executor.execute() [T8]
  │         └── headless dispatch [T9]
  │
  ├── 4. requiresConfirmation(name, args)?
  │     └── 是 → createPendingToken → return token 响应 [T10]
  │
  ├── 5. editor 模式 + executor 存在?
  │     ├── 是 → executor.execute() + attachFallbackWarning [T12]
  │     └── 否 → 继续
  │
  ├── 6. dispatchTool(name, args) — headless dispatch
  │     ├── 工具存在 → 正常返回 + duration [T14]
  │     ├── 工具不存在 → Unknown tool [T15]
  │     └── handler 返回 null → 错误消息 [T16]
  │
  └── catch → 错误消息 [T19]
```

关键改进：`confirm_and_execute` 分支复用 `dispatchTool()` 方法，而不是重复 validatePathArgs + 分支 dispatch 逻辑（DRY 修复）。

### getFilteredTools 流程

```
getFilteredTools()
  ├── getAllToolDefinitions() — 从 tool-registry 获取全部工具
  ├── 内联构建 confirm_and_execute 工具定义
  ├── readOnly? → filter: 排除 readOnlyGuard.check(name).blocked 的工具 [T21]
  ├── lite? → filter: 只保留 LITE_TOOLS [T22]
  └── readOnly + lite 组合过滤 [T23]
```

### setEditorExecutor 生命周期管理

```typescript
setEditorExecutor(executor: EditorToolExecutor | null): void {
  // 修复现有内存泄漏：替换/清除时自动 destroy 旧的
  if (this.editorExecutor) {
    this.editorExecutor.destroy();
  }
  this.editorExecutor = executor;
}
```

这修复了 GodotServer.close() 和 editor fallback 场景中遗漏 `destroy()` 调用的现有 bug。

### 内部方法

```typescript
/** 参数归一化: camelCase → snake_case，rawArgs undefined 返回 {} */
private normalizeArgs(rawArgs: Record<string, unknown> | undefined): Record<string, unknown>;

/** 路径白名单验证。返回 error ToolResult 或 null */
private validatePathArgs(args: Record<string, unknown>): ToolResult | null;

/** 分发到工具模块（含 validatePathArgs + 模块路由 + duration） */
private dispatchTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext, startTime: number): Promise<ToolResult>;

/** Editor fallback 警告（仅首次附加） */
private attachFallbackWarning(result: ToolResult): ToolResult;
```

### ctx 构建

ctx 对象在 ToolDispatcher 构造函数中构建一次，通过 `opsScript` 和 `findGodot` 依赖注入。process-state 模块保持直接 import（当前做法），因为这是内部实现细节。

```typescript
private readonly ctx: ToolContext;

constructor(options: DispatcherOptions) {
  this.ctx = {
    opsScript: options.opsScript,
    findGodot: options.findGodot,
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc) { ps.setRunningProcess(proc); },
    // ... 其他 process-state 代理
    parseGodotConfig,
  };
}
```

## 修改文件: `src/GodotServer.ts`

### setupHandlers 简化后

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

  // Resource handlers 不变（留在 GodotServer）
  this.server.setRequestHandler(ListResourcesRequestSchema, ...);
  this.server.setRequestHandler(ListResourceTemplatesRequestSchema, ...);
  this.server.setRequestHandler(ReadResourceRequestSchema, ...);
}
```

### 新增字段

```typescript
private dispatcher: ToolDispatcher | null = null;
```

### run() 调整

```typescript
// Editor fallback 时
this._editorFallback = true;
this.connectionMode = 'headless';
dispatcher.setConnectionMode('headless');
dispatcher.setEditorExecutor(null);  // 自动 destroy 旧的

// Editor 连接成功时
this.editorExecutor = new EditorToolExecutor(this.editorConn);
dispatcher.setEditorExecutor(this.editorExecutor);
```

### close() 调整

```typescript
async close(): Promise<void> {
  if (this.editorConn) {
    this.editorConn.disconnect();
    this.editorConn = null;
    // 不需要手动 destroy executor — dispatcher.setEditorExecutor(null) 会处理
    // 但为安全起见，close 时也清理 dispatcher 引用
    this.dispatcher?.setEditorExecutor(null);
    log('Editor connection closed');
  }
  // ... 进程清理、server.close() 不变
}
```

### 可删除的代码

提取后以下顶层函数/变量可从 GodotServer.ts 中删除：
- `validatePathArgs()` 函数 → 搬入 ToolDispatcher 私有方法
- `dispatchTool()` 函数 → 搬入 ToolDispatcher 私有方法
- `DEBUG` / `log()` → 搬入 ToolDispatcher 内部
- `requiresConfirmation`, `createPendingToken`, `consumeToken` import → 搬入 ToolDispatcher

## 不变的部分

- **31 个工具模块的 import + registerModule 循环**：保留在 GodotServer.ts 顶层（启动时一次性操作）
- **Resource 处理器**：留在 GodotServer（逻辑简单，~17 行）
- **detectProjectPath()**：留在 GodotServer（Resource 和 Editor 连接都用）

## 测试策略

### 新增 `test/core/ToolDispatcher.test.ts`

27 条路径全覆盖：

**handleCall 管道（T1-T19）：**
| ID | 路径 | 优先级 |
|----|------|--------|
| T1 | rawArgs undefined → 空 args {} | 低 |
| T2 | 正常 camelCase → snake_case 转换 | 高 |
| T3 | readOnlyGuard.blocked → 返回错误 | 高 |
| T4 | readOnlyGuard.passed → 继续 | 高 |
| T5 | confirm_and_execute token 缺失/类型错误 | 高 |
| T6 | consumeToken 返回 null（无效/过期） | 高 |
| T7 | confirm 分支二次 readOnlyGuard 检查 | 高 |
| T8 | confirm 分支 editor 模式 dispatch | 高 |
| T9 | confirm 分支 headless 模式 dispatch | 高 |
| T10 | requiresConfirmation → 返回 token | 高 |
| T11 | 不需要确认 → 继续 | 中 |
| T12 | editor 模式 + executor 存在 → 转发 | 高 |
| T13 | editor 模式 executor 为 null → fallback headless | 中 |
| T14 | headless 正常返回 + duration | 高 |
| T15 | 工具不存在 → Unknown tool | 高 |
| T16 | handler 返回 null → 错误消息 | 中 |
| T17 | 首次 fallback → 附加警告 | 中 |
| T18 | 非首次或非 fallback → 不附加 | 低 |
| T19 | catch 异常 → 错误消息 | 高 |

**getFilteredTools（T20-T23）：**
| ID | 路径 | 优先级 |
|----|------|--------|
| T20 | 默认模式 → 全部 + confirm_and_execute | 高 |
| T21 | readOnly → 过滤写工具 | 高 |
| T22 | lite → 只保留 LITE_TOOLS | 高 |
| T23 | readOnly + lite 组合 | 中 |

**状态管理（T24-T27）：**
| ID | 路径 | 优先级 |
|----|------|--------|
| T24 | setConnectionMode 切换 | 中 |
| T25 | setEditorExecutor 设置新 | 高 |
| T26 | setEditorExecutor(null) → 自动 destroy | 高 |
| T27 | 替换旧 executor → 先 destroy 旧的 | 高 |

### 保留 `test/GodotServer.test.js`

集成测试确保 MCP 协议层仍然工作。可能需要微调 mock 路径。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/ToolDispatcher.ts` | **新建** | 工具分发器类 |
| `src/GodotServer.ts` | 修改 | 提取逻辑到 dispatcher，setupHandlers 简化 |
| `test/core/ToolDispatcher.test.ts` | **新建** | Dispatcher 单元测试（27 条路径） |
| `test/GodotServer.test.js` | 可能修改 | 适配新的内部结构 |

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| ctx 对象循环依赖 | ctx 在 ToolDispatcher 内部构建，注入 opsScript/findGodot |
| 现有测试回归 | 先运行全量测试确认基线，实施后重新运行 |
| 过度拆分导致增加复杂度 | ToolDispatcher 是唯一的新类，不引入新的抽象层 |
| confirm 分支 DRY 违规 | confirm_and_execute 分支复用 dispatchTool()，不重复路径验证 |
| executor 内存泄漏 | setEditorExecutor 自动 destroy 旧的（修复现有 bug） |

## 审查记录

- **v1 审查** (2026-05-30): 发现 4 处遗漏（mode/readOnly/opsScript/findGodot 字段、confirm 令牌完整流程、guard.ts 依赖、readOnly 传递）+ 1 个现有 bug（executor destroy）
- **v2 修订**: 全部修正，补充 handleCall 完整管道图、27 条测试路径、setEditorExecutor 生命周期管理
