# 集成测试框架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立集成测试基础设施并编写 20 个端到端测试用例，覆盖 GDScript 执行管道和 MCP 工具核心链路

**Architecture:** 双层级测试 — Level A 直接调用 `executeGdscript()` 验证引擎通信管道，Level B 通过 `handleTool()` + `ToolContext` mock 验证完整 MCP 工具链路。复用已有 `findGodot()` + `executeGdscript()` + 各工具 `handleTool()`，不建新抽象层。

**Tech Stack:** node:test（与项目 35 个现有测试一致）、import 编译后 `build/` 模块、临时目录 fixture 工厂

---

## 文件结构

```
test/
├── helpers/
│   ├── integration-setup.js    # Godot 可用性检测 + itIfGodot
│   ├── tool-context.js         # createToolContext + createTempProject + registerCleanup
│   └── fixtures.js             # MINIMAL_PROJECT + BROKEN_REF_PROJECT 模板
├── integration/
│   ├── gdscript-execution.test.js   # Level A, 用例 1-5
│   ├── scene-operations.test.js     # Level B, 用例 6-11
│   ├── script-editing.test.js       # Level B, 用例 12-15
│   └── project-management.test.js   # Level B, 用例 16-20
└── (现有 35 个单元测试不动)
```

| 文件 | 职责 | 依赖 |
|------|------|------|
| `helpers/integration-setup.js` | Godot 检测 + 条件执行 | `build/core/godot-finder.js` |
| `helpers/tool-context.js` | ToolContext 工厂 + 临时项目 | `node:fs`, `node:os`, `node:path` |
| `helpers/fixtures.js` | Fixture 模板常量 | 无 |
| `integration/gdscript-execution.test.js` | Level A 5 个用例 | `build/gdscript-executor.js`, `helpers/integration-setup.js` |
| `integration/project-management.test.js` | Level B 5 个用例 | 各工具模块, `helpers/*` |
| `integration/script-editing.test.js` | Level B 4 个用例 | 各工具模块, `helpers/*` |
| `integration/scene-operations.test.js` | Level B 6 个用例 | 各工具模块, `helpers/*` |

---

### Task 1: 测试基础设施 — helpers 文件

**Files:**
- Create: `test/helpers/integration-setup.js`
- Create: `test/helpers/tool-context.js`
- Create: `test/helpers/fixtures.js`

- [ ] **Step 1: 创建 `test/helpers/integration-setup.js`**

```javascript
import { findGodot } from '../../build/core/godot-finder.js';

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
 * 条件执行：Godot 可用时跑测试，不可用时 skip。
 * node:test 没有 describe.skip，用 it({ skip: true }) 替代。
 */
export function itIfGodot(name, fn) {
  if (_godotAvailable) {
    return it(name, fn);
  }
  return it(name, { skip: 'Godot not available' }, fn);
}
```

- [ ] **Step 2: 创建 `test/helpers/tool-context.js`**

```javascript
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { parseGodotConfig } from '../../build/helpers.js';

// opsScript 指向编译后的 godot_operations.gd
const OPS_SCRIPT = join(dirname(import.meta.url.replace('file:///', '').replace('file://', '')),
  '..', '..', 'build', 'scripts', 'godot_operations.gd');

/** 创建最小 ToolContext mock */
export function createToolContext(projectPath) {
  return {
    opsScript: OPS_SCRIPT,
    findGodot: async () => { throw new Error('findGodot not overridden'); },
    runningProcess: null,
    setRunningProcess: () => {},
    outputBuffer: [],
    setOutputBuffer: () => {},
    processStartTime: 0,
    setProcessStartTime: () => {},
    projectDir: projectPath,
    setProjectDir: () => {},
    parseGodotConfig,
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

- [ ] **Step 3: 创建 `test/helpers/fixtures.js`**

```javascript
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

[node name="Main" parent="." index="0"]
script = ExtResource("1")
`,
  'scripts/main.gd': `extends Node2D

func _ready():
\tpass
`,
};

/** 含无效 ext_resource 引用的项目（用于 validate_project 测试） */
export const BROKEN_REF_PROJECT = {
  'project.godot': `; Engine configuration file.
[application]
config/name="BrokenRefProject"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`,
  'scenes/main.tscn': `[gd_scene load_steps=2 format=3 uid="uid://test002"]

[ext_resource type="Script" path="res://scripts/MISSING.gd" id="1"]

[node name="Root" type="Node2D"]

[node name="Main" parent="." index="0"]
script = ExtResource("1")
`,
};
```

- [ ] **Step 4: 运行 `npm run build` 确认 helpers 能正常导入**

Run: `npm run build`
Expected: 构建成功，无错误

- [ ] **Step 5: 提交**

```bash
git add test/helpers/integration-setup.js test/helpers/tool-context.js test/helpers/fixtures.js
git commit -m "test: add integration test helpers — Godot detection, ToolContext factory, fixtures"
```

---

### Task 2: Level A — GDScript 执行管道测试（用例 1-5）

**Files:**
- Create: `test/integration/gdscript-execution.test.js`

**依赖:** Task 1 完成

- [ ] **Step 1: 创建 `test/integration/gdscript-execution.test.js`**

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeGdscript } from '../../build/gdscript-executor.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level A: GDScript execution pipeline', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  registerCleanup(dirRef);

  let godotPath;
  let projectPath;

  beforeEach(() => {
    godotPath = getGodotPath();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    projectPath = dirRef.path;
  });

  itIfGodot('simple expression output', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });
    assert.ok(result.compile_success, 'Should compile');
    assert.ok(result.run_success, 'Should run');
    assert.equal(result.outputs[0].key, 'result');
    assert.equal(result.outputs[0].value, '42');
  });

  itIfGodot('JSON structured output', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: '_mcp_output("data", JSON.stringify({"a": 1}))',
      timeout: 10,
    });
    assert.ok(result.compile_success);
    assert.ok(result.run_success);
    const parsed = JSON.parse(result.outputs[0].value);
    assert.deepEqual(parsed, { a: 1 });
  });

  itIfGodot('compile error detection', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: 'func foo(',
      timeout: 10,
    });
    assert.equal(result.compile_success, false);
    assert.ok(result.compile_error.length > 0, 'Should have compile error message');
  });

  itIfGodot('runtime error capture', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: `var x: Variant = null
x.call("hello")`,
      timeout: 10,
    });
    assert.equal(result.run_success, false);
    assert.ok(result.run_error.length > 0, 'Should have runtime error message');
  });

  itIfGodot('timeout interrupt', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: 'while true:\n\tpass',
      timeout: 3,
    });
    assert.equal(result.success, false, 'Should fail due to timeout');
    assert.ok(result.duration_ms < 10000, `Should terminate within 10s, took ${result.duration_ms}ms`);
  });
});
```

- [ ] **Step 2: 运行集成测试确认通过（需 Godot 可用）**

Run: `npm run build && node --test test/integration/gdscript-execution.test.js`
Expected: 5 个用例通过（或 skip 如果 Godot 不可用）

- [ ] **Step 3: 提交**

```bash
git add test/integration/gdscript-execution.test.js
git commit -m "test: add Level A GDScript execution pipeline tests (5 cases)"
```

---

### Task 3: Level B — 项目管理域测试（用例 16-20）

**Files:**
- Create: `test/integration/project-management.test.js`

**依赖:** Task 1 完成

- [ ] **Step 1: 创建 `test/integration/project-management.test.js`**

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as project from '../../build/tools/project.js';
import * as validation from '../../build/tools/validation.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT, BROKEN_REF_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Project management', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  registerCleanup(dirRef);

  let ctx;

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  itIfGodot('create project', async () => {
    const newDir = join(dirRef.path, 'new-project');
    const result = await project.handleTool('create_project', {
      project_path: newDir,
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    assert.ok(existsSync(join(newDir, 'project.godot')), 'project.godot should exist');
  });

  itIfGodot('read project config', async () => {
    const result = await project.handleTool('read_project_config', {
      project_path: dirRef.path,
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    // parseGodotConfig returns sectioned config
    assert.ok(parsed.application || parsed['application'],
      'Should contain application section');
  });

  itIfGodot('validate project with missing references', async () => {
    dirRef.path = createTempProject(BROKEN_REF_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await validation.handleTool('validate_project', {
      project_path: dirRef.path,
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('MISSING.gd') || text.includes('missing') || text.includes('broken'),
      'Should report missing resource reference');
  });

  itIfGodot('list files with extension filter', async () => {
    const result = await project.handleTool('list_files', {
      project_path: dirRef.path,
      extensions: ['.gd'],
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    // Should only contain .gd files
    const files = parsed.data?.files || parsed.files || [];
    for (const f of files) {
      assert.ok(f.endsWith('.gd'), `File ${f} should end with .gd`);
    }
  });

  itIfGodot('empty path array returns error', async () => {
    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: [],
    }, ctx);
    assert.ok(result.isError, 'Should return error for empty scripts array');
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm run build && node --test test/integration/project-management.test.js`
Expected: 5 个用例通过（或 skip）

- [ ] **Step 3: 提交**

```bash
git add test/integration/project-management.test.js
git commit -m "test: add Level B project management tests (5 cases)"
```

---

### Task 4: Level B — 脚本编辑域测试（用例 12-15）

**Files:**
- Create: `test/integration/script-editing.test.js`

**依赖:** Task 1 完成

- [ ] **Step 1: 创建 `test/integration/script-editing.test.js`**

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as script from '../../build/tools/script.js';
import * as validation from '../../build/tools/validation.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Script editing', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  registerCleanup(dirRef);

  let ctx;

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  itIfGodot('write new script', async () => {
    const result = await script.handleTool('write_script', {
      project_path: dirRef.path,
      script_path: join(dirRef.path, 'scripts', 'new_script.gd'),
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    assert.ok(existsSync(join(dirRef.path, 'scripts', 'new_script.gd')),
      'Script file should exist');
  });

  itIfGodot('search and replace edit', async () => {
    const scriptPath = join(dirRef.path, 'scripts', 'main.gd');
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: scriptPath,
      start_line: 3,
      end_line: 3,
      new_content: '\tprint("edited")',
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
    const content = readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('edited'), 'Should contain replaced content');
  });

  itIfGodot('validate scripts with syntax error', async () => {
    // Write a script with syntax error
    const badScriptPath = join(dirRef.path, 'scripts', 'bad.gd');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badScriptPath, 'extends Node2D\n\nfunc foo(\n', 'utf-8');

    const result = await validation.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: ['scripts/bad.gd'],
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('error') || text.includes('Error') || text.includes('failed'),
      'Should report syntax error');
  });

  itIfGodot('edit non-existent script returns error', async () => {
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: join(dirRef.path, 'scripts', 'DOES_NOT_EXIST.gd'),
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);
    assert.ok(result.isError, 'Should return error for non-existent script');
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm run build && node --test test/integration/script-editing.test.js`
Expected: 4 个用例通过（或 skip）

- [ ] **Step 3: 提交**

```bash
git add test/integration/script-editing.test.js
git commit -m "test: add Level B script editing tests (4 cases)"
```

---

### Task 5: Level B — 场景操作域测试（用例 6-11）

**Files:**
- Create: `test/integration/scene-operations.test.js`

**依赖:** Task 1 完成

- [ ] **Step 1: 创建 `test/integration/scene-operations.test.js`**

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as scene from '../../build/tools/scene.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Scene operations', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  registerCleanup(dirRef);

  let ctx;

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  itIfGodot('add node to scene', async () => {
    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);
    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text || ''}`);
  });

  itIfGodot('add node then edit node position', async () => {
    // Step 1: add node
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'MovableNode',
    }, ctx);

    // Step 2: edit position
    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/MovableNode',
      properties: { position: [100, 200] },
    }, ctx);
    assert.ok(!editResult.isError, `Edit should succeed: ${editResult.content?.[0]?.text || ''}`);
  });

  itIfGodot('read scene tree with children', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('Root') || text.includes('Main'),
      'Should contain scene nodes');
  });

  itIfGodot('full CRUD chain — add, read, edit, remove', async () => {
    const scenePath = 'res://scenes/main.tscn';

    // Create
    const addResult = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    assert.ok(!addResult.isError, 'Create should succeed');

    // Read
    const readResult = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: scenePath,
    }, ctx);
    assert.ok(!readResult.isError, 'Read should succeed');

    // Edit
    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 75] },
    }, ctx);
    assert.ok(!editResult.isError, 'Edit should succeed');

    // Remove — first call returns confirmation token
    const removeResult1 = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    // remove_node may return token or directly remove depending on implementation
    assert.ok(!removeResult1.isError, 'Remove should not error');
  });

  itIfGodot('remove node confirmation token flow', async () => {
    // Add a node first
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'TokenNode',
    }, ctx);

    // Remove without token — should get confirmation_token or success
    const result = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/TokenNode',
    }, ctx);
    // Either returns a confirmation_token or directly succeeds
    assert.ok(!result.isError, 'Should not error');
  });

  itIfGodot('read non-existent scene returns error', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/DOES_NOT_EXIST.tscn',
    }, ctx);
    assert.ok(result.isError, 'Should return error for non-existent scene');
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm run build && node --test test/integration/scene-operations.test.js`
Expected: 6 个用例通过（或 skip）

- [ ] **Step 3: 提交**

```bash
git add test/integration/scene-operations.test.js
git commit -m "test: add Level B scene operations tests (6 cases)"
```

---

### Task 6: package.json 脚本 + 全量验证

**Files:**
- Modify: `package.json`（scripts 部分）

**依赖:** Task 2-5 全部完成

- [ ] **Step 1: 添加集成测试脚本到 package.json**

在 `package.json` 的 `scripts` 中添加：

```json
"test:integration": "npm run build && node --test test/integration/*.test.js",
"test:all": "npm run build && node --test test/*.test.js test/integration/*.test.js"
```

- [ ] **Step 2: 运行全量集成测试**

Run: `npm run test:integration`
Expected: 所有 20 个用例通过（或 skip 如果 Godot 不可用）

- [ ] **Step 3: 确认单元测试不受影响**

Run: `npm test`
Expected: 现有 639 个单元测试全部通过，集成测试不在执行范围内

- [ ] **Step 4: 运行 test:all 确认组合执行正常**

Run: `npm run test:all`
Expected: 单元测试 + 集成测试全部通过（Godot 不可用时集成测试 skip）

- [ ] **Step 5: 提交**

```bash
git add package.json
git commit -m "test: add test:integration and test:all scripts to package.json"
```
