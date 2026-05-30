# A-01 GDScript 辅助函数去重 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 SCENE_TREE_HEADER 和 wrapSnippet/wrapSnippetAsNode 之间的 GDScript 辅助函数重复，同时修复 SCENE_TREE_HEADER 缺失 `_mcp_output`/`_mcp_outputs` 的 bug。

**Architecture:** 提取 4 个共享辅助函数为 `shared.ts` 中的 `readonly string[]` 常量，SCENE_TREE_HEADER 和 gdscript-executor.ts 共同引用。`_mcp_get_node` 统一为 SCENE_TREE_HEADER 的精确版本。

**Tech Stack:** TypeScript, Vitest, Godot GDScript 模板

**Design doc:** `docs/superpowers/specs/2026-05-30-gdscript-helpers-dedup-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/shared.ts` | 修改 | 新增 4 个 `GD_MCP_*` 数组常量；重构 SCENE_TREE_HEADER |
| `src/gdscript-executor.ts` | 修改 | 导入共享常量；导出 MARKER_RESULT；重构 wrapSnippet/wrapSnippetAsNode |
| `test/gdscript-helpers.test.ts` | 创建 | 常量完整性测试 + 快照测试 + bugfix 验证 |

---

### Task 1: 基线快照捕获

**Files:**
- Create: `test/gdscript-helpers.test.ts`

- [ ] **Step 1: 捕获 wrapSnippet/wrapSnippetAsNode 基线输出**

创建测试文件，捕获重构前的输出字符串作为快照基线：

```typescript
// test/gdscript-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { wrapSnippet, wrapSnippetAsNode } from '../src/gdscript-executor.js';

describe('GDScript helpers - baseline snapshots', () => {
  it('wrapSnippet("var x = 1") baseline', () => {
    const result = wrapSnippet('var x = 1');
    // 记录关键特征用于后续对比
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _mcp_get_root');
    expect(result).toContain('func _mcp_get_node');
    expect(result).toContain('func _mcp_load_main_scene');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).toContain('var x = 1');
    // 快照：用于检测意外变更
    expect(result).toMatchSnapshot('wrapSnippet-var-x');
  });

  it('wrapSnippet with func declaration baseline', () => {
    const result = wrapSnippet('func my_func():\n\treturn 42\nvar result = my_func()');
    expect(result).toMatchSnapshot('wrapSnippet-func-decl');
  });

  it('wrapSnippetAsNode("var x = 1") baseline', () => {
    const result = wrapSnippetAsNode('var x = 1');
    expect(result).toContain('extends Node');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).not.toContain('func _mcp_get_root');
    expect(result).not.toContain('func _mcp_get_node');
    expect(result).toMatchSnapshot('wrapSnippetAsNode-var-x');
  });
});
```

- [ ] **Step 2: 运行测试生成快照**

Run: `npx vitest run test/gdscript-helpers.test.ts --update`
Expected: 3 tests pass, 快照文件 `test/__snapshots__/gdscript-helpers.test.ts.snap` 生成

- [ ] **Step 3: 提交基线快照**

```bash
git add test/gdscript-helpers.test.ts test/__snapshots__/
git commit -m "test: A-01 baseline snapshots for wrapSnippet/wrapSnippetAsNode"
```

---

### Task 2: 导出 MARKER_RESULT

**Files:**
- Modify: `src/gdscript-executor.ts:93`

SCENE_TREE_HEADER 的 `_mcp_done` 引用了 `MARKER_RESULT`。重构为数组拼接后需要通过导入获取此常量。

- [ ] **Step 1: 将 MARKER_RESULT 改为 export**

在 `src/gdscript-executor.ts` 第 93 行，将：

```typescript
const MARKER_RESULT = '___MCP_RESULT___';
```

改为：

```typescript
export const MARKER_RESULT = '___MCP_RESULT___';
```

- [ ] **Step 2: 验证编译和测试**

Run: `npx vitest run`
Expected: 1528 tests pass（export 不改变任何行为）

- [ ] **Step 3: 提交**

```bash
git add src/gdscript-executor.ts
git commit -m "refactor: export MARKER_RESULT for shared use (A-01 prep)"
```

---

### Task 3: 实现 4 个共享常量

**Files:**
- Modify: `src/tools/shared.ts`（在 SCENE_TREE_HEADER 之前插入）
- Modify: `test/gdscript-helpers.test.ts`（新增测试）

- [ ] **Step 1: 写失败测试 — 验证常量内容完整性**

在 `test/gdscript-helpers.test.ts` 的新 `describe` 块中添加：

```typescript
import { describe, it, expect } from 'vitest';

describe('GD_MCP shared constants', () => {
  // 这些测试在常量创建前会失败（import 错误）
  it('GD_MCP_GET_ROOT contains expected function signature', async () => {
    const { GD_MCP_GET_ROOT } = await import('../src/tools/shared.js');
    expect(GD_MCP_GET_ROOT).toBeInstanceOf(Array);
    expect(GD_MCP_GET_ROOT[0]).toBe('func _mcp_get_root() -> Node:');
    expect(GD_MCP_GET_ROOT.join('\n')).toContain('_mcp_root = ml.root');
    // 精确版 _mcp_get_node：检查不包含简洁版的 'or _part == "root"' 模式
  });

  it('GD_MCP_GET_NODE uses precise version (not simplified)', async () => {
    const { GD_MCP_GET_NODE } = await import('../src/tools/shared.js');
    expect(GD_MCP_GET_NODE).toBeInstanceOf(Array);
    expect(GD_MCP_GET_NODE[0]).toBe('func _mcp_get_node(path: NodePath) -> Node:');
    const joined = GD_MCP_GET_NODE.join('\n');
    // 精确版特征：单独检查 _part == "root" 且带 _node == _r 条件
    expect(joined).toContain('if _part == "root" and _node == _r:');
    // 简洁版特征不应存在
    expect(joined).not.toContain('or _part == "root"');
  });

  it('GD_MCP_LOAD_MAIN_SCENE contains ProjectSettings call', async () => {
    const { GD_MCP_LOAD_MAIN_SCENE } = await import('../src/tools/shared.js');
    expect(GD_MCP_LOAD_MAIN_SCENE).toBeInstanceOf(Array);
    expect(GD_MCP_LOAD_MAIN_SCENE[0]).toBe('func _mcp_load_main_scene() -> void:');
    expect(GD_MCP_LOAD_MAIN_SCENE.join('\n')).toContain('ProjectSettings.get_setting');
  });

  it('GD_MCP_OUTPUT contains append call', async () => {
    const { GD_MCP_OUTPUT } = await import('../src/tools/shared.js');
    expect(GD_MCP_OUTPUT).toBeInstanceOf(Array);
    expect(GD_MCP_OUTPUT.join('\n')).toContain('_mcp_outputs.append');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: `GD_MCP shared constants` 的 4 个测试全部 FAIL（常量未定义）

- [ ] **Step 3: 在 shared.ts 中实现 4 个常量**

在 `src/tools/shared.ts` 的 `SCENE_TREE_HEADER` 常量定义之前（约第 213 行前），添加：

```typescript
// ─── GDScript 辅助函数（共享模板）────────────────────────
// SCENE_TREE_HEADER 和 gdscript-executor.ts 的 wrapSnippet 共同引用。
// 注意：使用 readonly string[] 而非模板字面量，防止 JS 变量插值污染 GDScript 代码。

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

/** _mcp_get_node() — 按路径获取节点（精确版：只在根节点上下文跳过 "root"） */
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

/** _mcp_output() — 记录输出（修复：SCENE_TREE_HEADER 原缺失此函数） */
export const GD_MCP_OUTPUT: readonly string[] = [
  'func _mcp_output(key: String, value: Variant) -> void:',
  '\t_mcp_outputs.append({"key": key, "value": str(value)})',
];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: `GD_MCP shared constants` 的 4 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/shared.ts test/gdscript-helpers.test.ts
git commit -m "feat: add 4 shared GD_MCP_* constants for GDScript helper dedup (A-01)"
```

---

### Task 4: 重构 wrapSnippet / wrapSnippetAsNode

**Files:**
- Modify: `src/gdscript-executor.ts:166-400`（wrapSnippet + wrapSnippetAsNode）

- [ ] **Step 1: 重构 wrapSnippet — 替换内联辅助函数为共享常量**

在 `src/gdscript-executor.ts` 顶部添加导入：

```typescript
import { GD_MCP_GET_ROOT, GD_MCP_GET_NODE, GD_MCP_LOAD_MAIN_SCENE, GD_MCP_OUTPUT } from './tools/shared.js';
```

然后在 `wrapSnippet` 函数中，将第 216-274 行的内联辅助函数数组替换为：

```typescript
  const scriptLines: string[] = [
    'extends SceneTree',
    '## MCP snippet mode — autoloads are NOT available unless load_autoloads=true',
    '## Use Variant type for variables to avoid "Cannot infer type" errors',
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
  ];
```

删除原来内联的 `_mcp_get_root`、`_mcp_get_node`、`_mcp_load_main_scene`、`_mcp_output` 数组元素（约 50 行）。

**注意**: `_mcp_get_node` 现在使用精确版（来自 SCENE_TREE_HEADER），而非原来的简洁版。这是有意的行为变更，行为等价但语义更严格。

- [ ] **Step 2: 重构 wrapSnippetAsNode — 替换内联 _mcp_output**

在 `wrapSnippetAsNode` 函数中，将第 355-363 行的内联辅助函数替换为：

```typescript
  const nodeLines: string[] = [
    'extends Node',
    '## MCP autoload snippet mode — runs as Node child in loader scene',
    '',
    'var _mcp_outputs: Array = []',
    '',
    ...GD_MCP_OUTPUT,
  ];
```

删除原来内联的 `_mcp_output` 数组元素（约 3 行）。

- [ ] **Step 3: 运行快照测试验证输出**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: wrapSnippetAsNode 快照测试 PASS（输出未变）；wrapSnippet 快照测试 FAIL（`_mcp_get_node` 从简洁版切换为精确版）

- [ ] **Step 4: 更新 wrapSnippet 快照**

Run: `npx vitest run test/gdscript-helpers.test.ts --update`
Expected: 所有测试 PASS，快照更新

- [ ] **Step 5: 验证快照差异符合预期**

检查 `git diff test/__snapshots__/` 确认只有 `_mcp_get_node` 部分的差异（多出 `if _part == "root" and _node == _r: continue` 分支）。

- [ ] **Step 6: 运行全量测试**

Run: `npx vitest run`
Expected: 1528 tests pass

- [ ] **Step 7: 提交**

```bash
git add src/gdscript-executor.ts test/__snapshots__/
git commit -m "refactor: wrapSnippet/wrapSnippetAsNode use shared GD_MCP_* constants (A-01)"
```

---

### Task 5: 重构 SCENE_TREE_HEADER（含 bugfix）

**Files:**
- Modify: `src/tools/shared.ts:213-315`（SCENE_TREE_HEADER）

- [ ] **Step 1: 写失败测试 — bugfix 验证**

在 `test/gdscript-helpers.test.ts` 中添加：

```typescript
describe('SCENE_TREE_HEADER bugfix', () => {
  it('contains var _mcp_outputs declaration', async () => {
    const { SCENE_TREE_HEADER } = await import('../src/tools/shared.js');
    expect(SCENE_TREE_HEADER).toContain('var _mcp_outputs: Array = []');
  });

  it('contains func _mcp_output definition', async () => {
    const { SCENE_TREE_HEADER } = await import('../src/tools/shared.js');
    expect(SCENE_TREE_HEADER).toContain('func _mcp_output(key: String, value: Variant) -> void:');
    expect(SCENE_TREE_HEADER).toContain('_mcp_outputs.append');
  });

  it('_mcp_load_scene can reference _mcp_output without error', async () => {
    const { SCENE_TREE_HEADER } = await import('../src/tools/shared.js');
    // _mcp_load_scene 的错误路径调用 _mcp_output，需要函数定义在其之前
    const outputIdx = SCENE_TREE_HEADER.indexOf('func _mcp_output');
    const loadSceneIdx = SCENE_TREE_HEADER.indexOf('func _mcp_load_scene');
    expect(outputIdx).toBeGreaterThan(-1);
    expect(loadSceneIdx).toBeGreaterThan(-1);
    // _mcp_output 可以在 _mcp_load_scene 之后定义（GDScript 不要求顺序），
    // 但必须存在
    expect(SCENE_TREE_HEADER.match(/func _mcp_output/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: `SCENE_TREE_HEADER bugfix` 的 3 个测试 FAIL（`_mcp_outputs` 和 `_mcp_output` 缺失）

- [ ] **Step 3: 重构 SCENE_TREE_HEADER 为数组拼接**

在 `src/tools/shared.ts` 中添加 `MARKER_RESULT` 导入（在文件顶部）：

```typescript
import { MARKER_RESULT } from '../gdscript-executor.js';
```

然后将 `SCENE_TREE_HEADER`（第 213-315 行）从模板字面量改为数组拼接：

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
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\t_mcp_output("error", "Scene root not available")',
  '\t\treturn false',
  '\tif _mcp_scene_instance != null:',
  '\t\tif _mcp_scene_instance.get_parent() != null:',
  '\t\t\t_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)',
  '\t\t_mcp_scene_instance.queue_free()',
  '\t\t_mcp_scene_instance = null',
  '\tvar _sr = load(sp)',
  '\tif _sr == null:',
  '\t\t_mcp_output("error", "Failed to load scene: " + sp)',
  '\t\treturn false',
  '\t_mcp_scene_instance = _sr.instantiate()',
  '\t_r.add_child(_mcp_scene_instance)',
  '\treturn true',
  '',
  'func _mcp_get_scene_node(path: String) -> Node:',
  '\t# Search within loaded scene instance (avoids root/SceneName prefix issue)',
  '\tif _mcp_scene_instance != null:',
  '\t\tvar _p: String = path',
  '\t\twhile _p.begins_with("/"):',
  '\t\t\t_p = _p.substr(1)',
  '\t\t# Strip leading "root/" or "root" prefix',
  '\t\tif _p.begins_with("root/"):',
  '\t\t\t_p = _p.substr(5)',
  '\t\telif _p == "root":',
  '\t\t\t_p = ""',
  '\t\t# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")',
  '\t\tif _p != "" and _mcp_scene_instance.name.length() > 0:',
  '\t\t\tvar _scene_name: String = _mcp_scene_instance.name + "/"',
  '\t\t\tif _p.begins_with(_scene_name):',
  '\t\t\t\t_p = _p.substr(_scene_name.length())',
  '\t\t\telif _p == _mcp_scene_instance.name:',
  '\t\t\t\t_p = ""',
  '\t\tif _p == "":',
  '\t\t\treturn _mcp_scene_instance',
  '\t\tvar _node: Node = _mcp_scene_instance.get_node_or_null(_p)',
  '\t\tif _node != null:',
  '\t\t\treturn _node',
  '\t# Fallback to global search',
  '\treturn _mcp_get_node(path)',
  '',
  ...GD_MCP_OUTPUT,
  '',
  'func _mcp_done() -> void:',
  '\tprint("' + MARKER_RESULT + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
  '\tif Engine.get_main_loop() == self:',
  '\t\tquit(0)',
].join('\n');
```

**关键变更**:
1. 新增 `var _mcp_outputs: Array = []`（bugfix）
2. `...GD_MCP_OUTPUT` 引入 `_mcp_output` 函数（bugfix）
3. `_mcp_done` 中 `${MARKER_RESULT}` 改为 `"' + MARKER_RESULT + '"`（字符串拼接，避免数组 join 不插值）
4. `_mcp_get_node` 保持精确版（从 SCENE_TREE_HEADER 原文保留，无变化）

- [ ] **Step 4: 运行 bugfix 测试确认通过**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: `SCENE_TREE_HEADER bugfix` 的 3 个测试全部 PASS

- [ ] **Step 5: 运行全量测试**

Run: `npx vitest run`
Expected: 1528 tests pass

- [ ] **Step 6: 提交**

```bash
git add src/tools/shared.ts test/gdscript-helpers.test.ts
git commit -m "refactor: SCENE_TREE_HEADER uses shared constants + bugfix missing _mcp_output (A-01)"
```

---

### Task 6: 清理旧代码 + 最终验证

**Files:**
- Modify: `src/gdscript-executor.ts`（如果 wrapSnippet 有残留的死代码行）
- Modify: `test/gdscript-helpers.test.ts`（最终整理）

- [ ] **Step 1: 检查并清理 gdscript-executor.ts 中残留的未使用导入**

确认 wrapSnippet/wrapSnippetAsNode 不再直接引用任何已删除的内联辅助函数行。检查是否有残留的死代码。

- [ ] **Step 2: 运行 TypeScript 编译检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: 1528 + 新增测试全部 pass

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "chore: A-01 final cleanup (GDScript helpers dedup complete)"
```

---

## 自审检查清单

- [x] **Spec 覆盖**: 4 个共享常量 → Task 3；wrapSnippet 重构 → Task 4；SCENE_TREE_HEADER 重构 + bugfix → Task 5；MARKER_RESULT 处理 → Task 2+5
- [x] **无占位符**: 每步有完整代码
- [x] **类型一致**: 所有导入路径和常量名在 Task 2-5 间一致（`GD_MCP_GET_ROOT`、`GD_MCP_GET_NODE`、`GD_MCP_LOAD_MAIN_SCENE`、`GD_MCP_OUTPUT`、`MARKER_RESULT`）
