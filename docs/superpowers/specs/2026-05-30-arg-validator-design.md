# I-07: 运行时类型验证层 设计文档

**日期：** 2026-05-30
**状态：** 待实施
**关联：** I-01 ToolDispatcher 提取（已完成）

---

## 背景与问题

当前 MCP 工具的参数校验分散在各工具模块内部，入口层（ToolDispatcher.handleCall）不检查参数类型。传入 `project_path=123`（数字）或 `action={}`（对象）不会在入口处被拦截，而是透传到 GDScript 层才报错，导致：

1. 错误信息不友好（GDScript 层面报错难以理解）
2. 浪费一次 Godot 进程调用（headless 启动开销）
3. 每个工具模块重复编写相同的类型检查代码

## 目标

在 ToolDispatcher 入口层添加轻量参数类型校验，拦截明显类型错误，返回结构化错误响应。

## 范围约束

- **只校验公共参数**：project_path、action、scene_path、method
- **只校验类型**：存在但类型错误时报错，缺失不报错（由各模块自行处理）
- **零新依赖**：手写检查函数
- **不改变现有模块**：各工具模块内部的校验逻辑保持不变（防御性编程）

## 方案

### 新文件：`src/core/arg-validator.ts`

导出 `validateCommonArgs(toolName, args)` 函数：

```typescript
interface ValidationFailure {
  error: { code: string; message: string };
}

function validateCommonArgs(
  toolName: string,
  args: Record<string, unknown>
): ValidationFailure | null;
```

### 校验规则

| 参数 | 规则 | 错误码 |
|------|------|--------|
| `project_path` | 存在 → 必须是非空字符串 | `INVALID_PROJECT_PATH` |
| `action` | 存在 → 必须是非空字符串 | `INVALID_ACTION` |
| `scene_path` | 存在 → 必须是非空字符串 | `INVALID_SCENE_PATH` |
| `method` | 存在 → 必须是非空字符串 | `INVALID_METHOD` |

- 返回 `null` 表示通过
- 返回 `{ error: { code, message } }` 表示失败
- 多个参数同时错误时返回第一个

### 插入位置

在 `ToolDispatcher.handleCall()` 管道中，`normalizeArgs` 之后、`ReadOnlyGuard` 之前：

```
normalizeArgs(rawArgs)           // 已有
  ↓
validateCommonArgs(name, args)   // 新增
  ↓
ReadOnlyGuard.check(name)        // 已有
  ↓
confirm_and_execute / confirm / dispatch  // 已有
```

### 错误响应格式

```json
{
  "error": {
    "code": "INVALID_PROJECT_PATH",
    "message": "project_path must be a non-empty string, got: 123"
  }
}
```

ToolDispatcher 中包装为标准 `ToolResult`：
```typescript
{
  content: [{ type: 'text', text: JSON.stringify(failure) }],
  isError: true,
}
```

## 文件变动

| 文件 | 动作 | 估计行数 |
|------|------|----------|
| `src/core/arg-validator.ts` | 新建 | ~40 行 |
| `src/core/ToolDispatcher.ts` | 修改 handleCall | +5 行 |
| `test/core/arg-validator.test.ts` | 新建 | ~80 行 |
| `test/core/ToolDispatcher.test.ts` | 补充集成测试 | +15 行 |

## 测试覆盖

arg-validator.test.ts（9 个用例）：

1. project_path 传入数字 → INVALID_PROJECT_PATH
2. project_path 传入空字符串 → INVALID_PROJECT_PATH
3. action 传入对象 → INVALID_ACTION
4. action 传入空字符串 → INVALID_ACTION
5. scene_path 传入数字 → INVALID_SCENE_PATH
6. method 传入数组 → INVALID_METHOD
7. 全部合法字符串 → null（通过）
8. 参数缺失 → null（不报错）
9. 多参数同时错误 → 返回第一个

ToolDispatcher.test.ts 补充（2 个集成用例）：

10. handleCall 传入 project_path=123 → 拦截在 guard 之前
11. handleCall 传入 action=undefined → 不拦截（缺失不报错）

## 不做的事

- 不校验参数值的有效性（如 action 是否匹配枚举值）— 由各模块处理
- 不校验工具特有参数（如 node_path、animation_name 等）
- 不引入 schema 验证库（ajv、zod 等）
- 不修改各工具模块的现有校验逻辑
