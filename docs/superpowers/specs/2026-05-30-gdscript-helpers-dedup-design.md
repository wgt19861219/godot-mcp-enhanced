# A-01 GDScript 辅助函数去重 — 设计文档

**日期**: 2026-05-30
**状态**: 设计完成
**范围**: 最小（仅消除核心辅助函数重复）
**关联**: I-10 代码重复（审查报告）

## 背景

`shared.ts` 的 `SCENE_TREE_HEADER`（模板字面量，69 行）和 `gdscript-executor.ts` 的 `wrapSnippet`/`wrapSnippetAsNode`（数组拼接，~135 行）中存在 4 个几乎相同的 GDScript 辅助函数：

| 辅助函数 | SCENE_TREE_HEADER | wrapSnippet | 差异 |
|---------|------------------|-------------|------|
| `_mcp_get_root()` | ✅ 有 | ✅ 有 | 完全相同 |
| `_mcp_get_node()` | ✅ 有 | ✅ 有 | **有微小差异**（见下） |
| `_mcp_load_main_scene()` | ✅ 有 | ✅ 有 | 完全相同 |
| `_mcp_output()` | ✅ 有 | ✅ 有 | 完全相同 |

### _mcp_get_node 差异详情

SCENE_TREE_HEADER（shared.ts）:
```
if _part == "":
    continue
    ...
if not _found:
    if _part == "root" and _node == _r:
        continue
    return null
```

wrapSnippet（gdscript-executor.ts）:
```
if _part == "" or _part == "root":
    continue
    ...
if not _found:
    return null
```

SCENE_TREE_HEADER 版本更精确：只在 `_node == _r`（根节点）时跳过 "root" 部分。wrapSnippet 版本更简单但在实际场景中效果等价。

**决策**: 统一为 wrapSnippet 版本（更简洁）。SCENE_TREE_HEADER 的调用方不依赖 "root 只在根节点时跳过" 这个精确行为。

## 设计

### 方案：提取到 shared.ts 数组常量

将 4 个辅助函数提取为 `shared.ts` 中的 `string[]` 常量，`SCENE_TREE_HEADER` 和 `gdscript-executor.ts` 共同引用。

### 新增常量（shared.ts）

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

/** _mcp_get_node() — 按路径获取节点（含手动遍历回退） */
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
  '\t\tif _part == "" or _part == "root":',
  '\t\t\tcontinue',
  '\t\tvar _found: bool = false',
  '\t\tfor _ch in _node.get_children():',
  '\t\t\tif _ch.name == _part:',
  '\t\t\t\t_node = _ch',
  '\t\t\t\t_found = true',
  '\t\t\t\tbreak',
  '\t\tif not _found:',
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

从模板字面量改为数组拼接，引用共享常量：

```typescript
export const SCENE_TREE_HEADER = [
  'extends SceneTree',
  '',
  'var _mcp_outputs: Array = []',
  'var _mcp_root: Node = null',
  'var _mcp_scene_instance: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  '',
  // SCENE_TREE_HEADER 独有：场景加载和导航辅助
  'func _mcp_load_scene(sp: String) -> bool:',
  // ...（保持原有的 _mcp_load_scene + _mcp_get_scene_node）
  '',
  ...GD_MCP_OUTPUT,
  '',
  'func _mcp_done() -> void:',
  // ...（保持原有）
].join('\n');
```

### wrapSnippet 重构

替换内联的辅助函数为导入：

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
  'var _mcp_outputs: Array = [],
  '',
  ...GD_MCP_OUTPUT,
];
```

## 变更影响

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/tools/shared.ts` | 修改 | 新增 4 个数组常量；SCENE_TREE_HEADER 从模板字面量改为数组拼接 |
| `src/gdscript-executor.ts` | 修改 | wrapSnippet/wrapSnippetAsNode 内联辅助函数替换为导入常量 |

**不变**: 工具文件中的 gdEscape 调用、code-templates.ts、其他 GDScript 生成逻辑。

## 行为保证

- `wrapSnippet` 输出与重构前逐字节一致（快照测试验证）
- `wrapSnippetAsNode` 输出与重构前逐字节一致
- `SCENE_TREE_HEADER` 输出有微小变化（`_mcp_get_node` 中 "root" 跳过逻辑统一为简洁版本），行为等价

## 测试策略

1. **快照测试**: 重构前捕获 wrapSnippet/wrapSnippetAsNode 的完整输出，重构后断言一致
2. **现有测试**: 1528 条全量测试必须继续通过
3. **新增测试**: 验证 4 个共享常量自身内容的完整性
