# A-01 GDScript 辅助函数去重 — 设计文档 v2（审查修订）

**日期**: 2026-05-30
**状态**: 审查修订
**范围**: 最小（补全缺失定义 + 消除核心辅助函数重复）
**关联**: I-10 代码重复（审查报告）

## 背景

`shared.ts` 的 `SCENE_TREE_HEADER`（模板字面量，103 行）和 `gdscript-executor.ts` 的 `wrapSnippet`/`wrapSnippetAsNode`（数组拼接，~135 行）中存在重复的 GDScript 辅助函数。此外发现 SCENE_TREE_HEADER 存在 **现有 bug**。

### Bug：SCENE_TREE_HEADER 缺少 `_mcp_output` / `_mcp_outputs` 定义

SCENE_TREE_HEADER 引用了 `_mcp_output()`（第 270、279 行）和 `_mcp_outputs`（第 312 行），但**未定义**这两个符号。这意味着：
- `_mcp_load_scene()` 错误路径会触发 GDScript 运行时 "Call to undefined function" 错误
- `_mcp_done()` 引用未定义的 `_mcp_outputs`，会导致同上

此 bug 存活的原因：断言路径（`wrapAssertionCode`、`genCheckNodeExists`、`genCheckProperties`）中的 `_mcp_output` 调用需要真正的 Godot 进程才能触发，单元测试不覆盖 GDScript 执行层。

### 本次任务的双重性质

本次重构既是**去重**（消除 wrapSnippet 和 SCENE_TREE_HEADER 之间的重复），也是 **bugfix**（为 SCENE_TREE_HEADER 补全 `_mcp_output` / `_mcp_outputs`）。

### 辅助函数重复矩阵

| 辅助函数 | SCENE_TREE_HEADER | wrapSnippet | 差异 |
|---------|------------------|-------------|------|
| `_mcp_get_root()` | ✅ 有 | ✅ 有 | 完全相同 |
| `_mcp_get_node()` | ✅ 有 | ✅ 有 | **有微小差异**（见下） |
| `_mcp_load_main_scene()` | ✅ 有 | ✅ 有 | 完全相同 |
| `_mcp_output()` | ❌ **缺失** | ✅ 有 | SCENE_TREE_HEADER 未定义 |
| `var _mcp_outputs` | ❌ **缺失** | ✅ 有 | SCENE_TREE_HEADER 未声明 |

### _mcp_get_node 差异详情

SCENE_TREE_HEADER（shared.ts）— **精确版本**：
```
if _part == "":
    continue
    ...
if not _found:
    if _part == "root" and _node == _r:
        continue
    return null
```

wrapSnippet（gdscript-executor.ts）— **简洁版本**：
```
if _part == "" or _part == "root":
    continue
    ...
if not _found:
    return null
```

**决策**: 统一为 SCENE_TREE_HEADER 的精确版本。理由：
1. SCENE_TREE_HEADER 被 21+ 文件使用，是事实标准
2. 精确版本语义更准确：只在根节点上下文中跳过 "root" 部分
3. wrapSnippet 的简洁版本在实际场景中等价，但精确版本是更安全的默认

## 设计

### 方案：提取到 shared.ts 数组常量

将 4 个辅助函数提取为 `shared.ts` 中的 `readonly string[]` 常量，`SCENE_TREE_HEADER` 和 `gdscript-executor.ts` 共同引用。

### 新增常量（shared.ts）

常量间统一一个空行分隔（`''`）：

```typescript
// ─── GDScript 辅助函数（共享模板）────────────────────────

/** _mcp_get_root() — 获取场景根节点（缓存） */
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\tif root != null:',
  '\t\t_mcp_root = root',
  '\t\treturn _mcp_root',
  '\tvar ml: Variant = Engine.get_main_loop()',
  '\tif ml != null and ml is SceneTree and ml.root != null:',
  '\t\t_mcp_root = ml.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];

/** _mcp_get_node() — 按路径获取节点（含手动遍历回退，精确版） */
export const GD_MCP_GET_NODE: readonly string[] = [
  'func _mcp_get_node(path: NodePath) -> Node:',
  '\tvar _p: String = str(path)',
  '\tif _p.begins_with("/"):',
  '\t\t_p = _p.substr(1)',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn null',
  '\t# Fallback: root.get_node() may fail in headless _initialize()',
  '\tvar _node: Node = _r.get_node_or_null(_p)',
  '\tif _node != null:',
  '\t\treturn _node',
  '\t# Manual traversal for headless compatibility',
  '\tvar _parts: PackedStringArray = _p.split("/")',
  '\t_node = _r',
  '\tfor _part in _parts:',
  '\t\tif _part == "":',
  '\t\t\tcontinue',
  '\t\tvar _found: bool = false',
  '\t\tfor _ch in _node.get_children():',
  '\t\t\tif _ch.name == _part:',
  '\t\t\t\t_node = _ch',
  '\t\t\t\t_found = true',
  '\t\t\t\tbreak',
  '\t\tif not _found:',
  '\t\t\tif _part == "root" and _node == _r:',
  '\t\t\t\tcontinue',
  '\t\t\treturn null',
  '\treturn _node',
];

/** _mcp_load_main_scene() — 加载主场景 */
export const GD_MCP_LOAD_MAIN_SCENE: readonly string[] = [
  'func _mcp_load_main_scene() -> void:',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn',
  '\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")',
  '\tif _sp != null and _sp != "":',
  '\t\tvar _sr = load(_sp)',
  '\t\tif _sr:',
  '\t\t\t_r.add_child(_sr.instantiate())',
];

/** _mcp_output() — 记录输出 */
export const GD_MCP_OUTPUT: readonly string[] = [
  'func _mcp_output(key: String, value: Variant) -> void:',
  '\t_mcp_outputs.append({"key": key, "value": str(value)})',
];
```

### SCENE_TREE_HEADER 重构

从模板字面量改为数组拼接。**变更包含 bugfix**：新增 `var _mcp_outputs` 和 `func _mcp_output()`。

```typescript
export const SCENE_TREE_HEADER = [
  'extends SceneTree',
  '',
  'var _mcp_outputs: Array = []',         // ← 新增（bugfix）
  'var _mcp_root: Node = null',
  'var _mcp_scene_instance: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  'func _mcp_load_scene(sp: String) -> bool:',
  // ...（保持原有的 _mcp_load_scene + _mcp_get_scene_node，独有内容）
  '',
  ...GD_MCP_OUTPUT,                        // ← 新增（bugfix）
  '',
  'func _mcp_done() -> void:',
  // ...（保持原有）
].join('\n');
```

### wrapSnippet 重构

替换内联的辅助函数为导入。`_mcp_get_node` 从简洁版切换为精确版（SCENE_TREE_HEADER 版本）：

```typescript
import { GD_MCP_GET_ROOT, GD_MCP_GET_NODE, GD_MCP_LOAD_MAIN_SCENE, GD_MCP_OUTPUT } from './tools/shared.js';

// wrapSnippet 中：
const scriptLines: string[] = [
  'extends SceneTree',
  '## MCP snippet mode ...',
  '',
  'var _mcp_outputs: Array = []',
  'var _mcp_root: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  '',
  ...GD_MCP_OUTPUT,
  '',
];
```

### wrapSnippetAsNode 重构

autoload 模式不需要 `_mcp_get_root`、`_mcp_get_node`、`_mcp_load_main_scene`，只需 `_mcp_output`：

```typescript
const nodeLines: string[] = [
  'extends Node',
  '## MCP autoload snippet mode ...',
  '',
  'var _mcp_outputs: Array = []',
  '',
  ...GD_MCP_OUTPUT,
];
```

## 变更影响

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/tools/shared.ts` | 修改 + bugfix | 新增 4 个数组常量；SCENE_TREE_HEADER 改为数组拼接；**补全 `_mcp_outputs` 声明和 `_mcp_output` 函数定义** |
| `src/gdscript-executor.ts` | 修改 | wrapSnippet/wrapSnippetAsNode 内联辅助函数替换为导入常量；`_mcp_get_node` 切换为精确版 |

**不变**: 工具文件中的 gdEscape 调用、code-templates.ts、其他 GDScript 生成逻辑。

## 行为保证

### wrapSnippet / wrapSnippetAsNode

- `wrapSnippet` 输出与重构前**不完全一致**：`_mcp_get_node` 从简洁版切换为精确版（多一个 `if _part == "root" and _node == _r: continue` 分支），行为等价
- `wrapSnippetAsNode` 输出与重构前**完全一致**（autoload 模式不含 `_mcp_get_node`）

### SCENE_TREE_HEADER（包含 bugfix）

输出相对于现有代码有**以下变更**：

| 变更项 | 旧 | 新 | 性质 |
|--------|-----|-----|------|
| `var _mcp_outputs: Array = []` | 缺失 | 有 | **Bugfix** |
| `func _mcp_output(...)` | 缺失 | 有（从共享常量引入） | **Bugfix** |
| `var _mcp_scene_instance` 声明位置 | 在 `var _mcp_root` 后 | 不变 | 不变 |
| 函数间空行 | 部分不一致 | 统一一个空行 | 格式化 |

**结论**: 所有变更要么是 bugfix（补全缺失定义），要么是行为等价的格式调整。21+ 个消费者文件无需修改。

## 测试策略

1. **快照测试**: 重构前捕获 wrapSnippet 的完整输出字符串，重构后断言差异仅限于 `_mcp_get_node` 的精确版增强
2. **Bugfix 验证**: 新增测试验证 SCENE_TREE_HEADER 包含 `var _mcp_outputs` 和 `func _mcp_output`
3. **现有测试**: 1528 条全量测试必须继续通过
4. **常量完整性**: 验证 4 个共享常量包含预期的行数和关键内容
