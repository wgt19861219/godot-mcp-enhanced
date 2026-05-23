# 集成测试框架设计：复用已有执行器 + 四域测试矩阵

> 日期: 2026-05-21
> 状态: Draft（v2 — 根据工程审查重写）
> 来源: v0.10.x 测试覆盖深化需求

## 问题背景

当前项目有 639 个单元测试（全部使用 `node:test`），但缺少与真实 Godot 引擎的集成测试。工具的 GDScript 执行管道、场景操作、脚本编辑等核心链路仅在单元测试中 mock 验证，无法捕获：

1. **GDScript 语法差异** — 生成的脚本在 Godot 解析器中行为可能与预期不同
2. **场景文件格式兼容** — .tscn 文件的序列化/反序列化细节
3. **跨工具协作** — add_node → edit_node → read_scene 的完整 CRUD 链路
4. **错误边界** — 操作不存在资源时的报错格式是否可解析

## 设计目标

1. **复用已有执行器** — 直接调用 `executeGdscript()` + `findGodot()`，不建新的 GodotRunner 抽象层
2. **双层级测试** — Level A（GDScript 执行管道）和 Level B（MCP 工具端到端）明确分离
3. **可选执行** — Godot 不可用时条件 skip，不阻塞 `npm test`
4. **零维护负担** — fixture 工厂自动创建/清理临时项目

## 已有基础设施（不复用 = 重复造轮子）

| 能力 | 已有实现 | 位置 |
|------|---------|------|
| GDScript 执行 | `executeGdscript()` | `src/gdscript-executor.ts:375` |
| Godot 路径查找 | `findGodot()` | `src/core/godot-finder.ts:43` |
| 临时目录管理 | `createSessionDir()` + `mkdtempSync` | `src/gdscript-executor.ts:67` |
| Marker 解析 | `parseMcpMarkers()` | `src/gdscript-executor.ts:341` |
| 进程超时+清理 | `forceKillTree()` + `setTimeout` | `src/core/process-state.ts` |
| 结果类型 | `ExecuteGdscriptResult`（10 个字段） | `src/gdscript-executor.ts:27` |
| MCP 工具入口 | `handleTool(name, args, ctx)` | 各 `src/tools/*.ts` |
| ToolContext 类型 | `ToolContext`（10 个字段） | `src/types.ts:8` |

集成测试 **直接导入并调用这些已有模块**，不包装、不复写。

## 第一部分：测试基础设施

### 1.1 测试框架：node:test

项目 35 个测试文件全部使用 `node:test`，集成测试保持一致：

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
```

### 1.2 可选执行模式

`node:test` 没有 `describe.skip()`，用条件 describe 实现：

```javascript
// test/helpers/integration-setup.js

import { findGodot, clearGodotPathCache } from '../../build/core/godot-finder.js';

let _godotPath = null;
let _godotAvailable = false;

/** 检测 Godot 是否可用（结果缓存） */
export async function ensureGodot() {
  if (_godotPath !== null) return _godotPath;
  try {
    _godotPath = await findGodot();
    _godotAvailable = true;
    return _godotPath;
  } catch {
    _godotAvailable = false;
    return null;
  }
}

export function isGodotAvailable() { return _godotAvailable; }
export function getGodotPath() { return _godotPath; }

/**
 * 条件执行：Godot 可用时跑测试，不可用时每个 it 返回 skip。
 * node:test 没有 describe.skip，用 it({ skip: true }) 替代。
 */
export function itIfGodot(name, fn) {
  if (_godotAvailable) {
    return it(name, fn);
  }
  return it(name, { skip: 'Godot not available' }, fn);
}
```

使用方式：

```javascript
import { ensureGodot, itIfGodot } from '../helpers/integration-setup.js';

describe('GDScript execution', async () => {
  await ensureGodot();

  itIfGodot('simple expression output', async () => {
    // ...
  });
});
```

### 1.3 Level A：GDScript 执行管道测试

Level A 直接调 `executeGdscript()`，不需要 MCP 工具层：

```javascript
import { executeGdscript } from '../../build/gdscript-executor.js';
import { getGodotPath } from '../helpers/integration-setup.js';

// 测试中：
const result = await executeGdscript({
  godotPath: getGodotPath(),
  projectPath: tempProjectDir,
  code: '_mcp_output("result", "42")',
  timeout: 10,
});
assert.ok(result.compile_success);
assert.ok(result.run_success);
```

`ExecuteGdscriptResult` 已提供全部所需字段：`compile_success`, `compile_error`, `run_success`, `run_error`, `outputs[]`, `duration_ms`。

### 1.4 Level B：MCP 工具端到端测试

Level B 通过 `handleTool()` 调用工具，需要构建 `ToolContext`。参考已有测试模式（`test/instance-scene.test.js`），最小 mock 为：

```javascript
// test/helpers/tool-context.js

import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';

/** 创建最小 ToolContext mock */
export function createToolContext(projectPath) {
  return {
    opsScript: '',
    findGodot: async () => { /* Level B 测试需要真实 Godot，由上层 ensureGodot 保证 */ },
    runningProcess: null,
    setRunningProcess: () => {},
    outputBuffer: [],
    setOutputBuffer: () => {},
    processStartTime: 0,
    setProcessStartTime: () => {},
    projectDir: projectPath,
    setProjectDir: () => {},
    parseGodotConfig: (c) => { /* Level B 按需覆盖，默认委托已有实现 */ return {}; },
  };
}

/** 创建临时 Godot 项目目录 */
export function createTempProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'godot-inttest-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
  return dir;
}

/** 注册清理回调（在 describe 顶层调用） */
export function registerCleanup(dirRef) {
  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });
}
```

使用方式：

```javascript
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';

describe('Scene operations', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  registerCleanup(dirRef);

  itIfGodot('add node to scene', async () => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);

    assert.ok(!result.isError);
  });
});
```

### 1.5 Fixture 模板

```javascript
// test/helpers/fixtures.js

/** 最小可运行项目 */
export const MINIMAL_PROJECT = {
  'project.godot': `; Engine configuration file.
[application]
config/name="TestProject"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`,
  'scenes/main.tscn': `[gd_scene load_steps=2 format=3 uid="uid://test001"]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Root" type="Node2D"]

[node name="Main" type="Node2D" parent="."]
script = ExtResource("1")
`,
  'scripts/main.gd': `extends Node2D

func _ready():
\tpass
`,
};
```

### 1.6 测试命令

```json
// package.json scripts 补充
{
  "test": "npm run build && node --test test/*.test.js",
  "test:integration": "npm run build && node --test test/integration/*.test.js",
  "test:all": "npm run build && node --test test/*.test.js test/integration/*.test.js"
}
```

集成测试文件放在 `test/integration/`，`test:integration` 单独运行。`npm test`（单元测试）不触发集成测试。`test:all` 全跑，Godot 不可用时集成用例自动 skip。

## 第二部分：集成测试矩阵

### 2.1 Level A：GDScript 执行域（5 个）

直接调 `executeGdscript()`，验证 Godot 进程通信管道。

| # | 用例名 | 输入 | 预期 |
|---|--------|------|------|
| 1 | 简单表达式输出 | `_mcp_output("result", "42")` | `result.outputs[0].value === "42"` |
| 2 | JSON 结构化输出 | `_mcp_output("data", JSON.stringify({"a": 1}))` | `JSON.parse(result.outputs[0].value)` 等于 `{a: 1}` |
| 3 | 编译错误检测 | `func foo(` (语法不完整) | `result.compile_success === false`，`compile_error` 非空 |
| 4 | 运行时错误捕获 | `var x: Variant = null; x.call("hello")` | `result.run_success === false`，`run_error` 非空 |
| 5 | 超时中断 | `while true: pass` + `timeout=3` | 进程在 ~3s 内终止，不挂住测试 |

### 2.2 Level B：场景操作域（6 个）

通过 `handleTool()` 端到端测试，需构建 `ToolContext` + fixture 项目。

| # | 用例名 | 输入 | 预期 |
|---|--------|------|------|
| 6 | 创建节点 | `add_node` Sprite2D 到 main.tscn | 返回非 error，场景文件包含新节点 |
| 7 | 编辑节点属性 | `add_node` → `edit_node` position | `read_scene` 返回更新后的 position |
| 8 | 读取场景树 | 创建含子节点 fixture → `query_scene_tree` | 返回完整节点树含子节点 |
| 9 | 完整 CRUD 链路 | create → read → edit → remove | 每步结果一致，remove 后节点消失 |
| 10 | 删除节点确认 token | `remove_node` 无 token → 有 token | 无 token 返回 confirmation_token，有 token 成功 |
| 11 | 操作不存在资源 | `read_scene` 不存在的 .tscn | 返回 `isError: true`，错误文本可解析 |

### 2.3 Level B：脚本编辑域（4 个）

| # | 用例名 | 输入 | 预期 |
|---|--------|------|------|
| 12 | 写入新脚本 | `write_script` 新 .gd 文件 | 文件存在且 `validate_scripts` 通过 |
| 13 | 搜索替换编辑 | `edit_script` search_and_replace | 替换内容正确，`validate_scripts` 通过 |
| 14 | 验证含错误脚本 | `validate_scripts` 含语法错误脚本 | 返回错误行号和描述 |
| 15 | 编辑不存在脚本 | `edit_script` 不存在的路径 | 返回 `isError: true`，错误文本可解析 |

### 2.4 Level B：项目管理域（5 个）

| # | 用例名 | 输入 | 预期 |
|---|--------|------|------|
| 16 | 创建项目 | `create_project` 到临时目录 | `project.godot` 存在且格式正确 |
| 17 | 读取项目配置 | `read_project_config` | 返回结构化 JSON 含 config/name |
| 18 | 验证含缺失引用项目 | `validate_project` fixture 含无效 ext_resource | 报告缺失资源 |
| 19 | 列出项目文件 | `list_files` 带 `.gd` 过滤 | 仅返回 `.gd` 文件路径 |
| 20 | 空路径报错 | `validate_scripts` 空路径数组 | 返回 `isError: true`，错误文本可解析 |

### 错误边界覆盖

每个域至少一个"操作不存在的资源"用例（#11, #15, #20），验证工具的报错格式是否结构化且可解析。

## 第三部分：文件结构

```
test/
├── helpers/
│   ├── integration-setup.js    # Godot 可用性检测 + itIfGodot
│   ├── tool-context.js         # createToolContext + createTempProject + registerCleanup
│   └── fixtures.js             # MINIMAL_PROJECT 等模板
├── integration/
│   ├── gdscript-execution.test.js   # Level A, 用例 1-5
│   ├── scene-operations.test.js     # Level B, 用例 6-11
│   ├── script-editing.test.js       # Level B, 用例 12-15
│   └── project-management.test.js   # Level B, 用例 16-20
└── (现有 35 个单元测试不动)
```

所有测试文件为 `.js`，import 编译后 `build/` 模块，与项目惯例一致。

## 第四部分：非目标（第一轮不做）

- signal、animation、physics、navigation 等高层操作测试
- 性能基准测试
- Bridge TCP 通信测试（需要运行中的游戏实例）
- 跨版本 Godot 兼容性测试
- 并发压力测试
- 修改 `findGodot()` 优先级（保持现有 `GODOT_PATH > PATH > 平台搜索`）
