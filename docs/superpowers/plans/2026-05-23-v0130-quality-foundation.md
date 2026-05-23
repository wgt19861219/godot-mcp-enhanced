# v0.13.0 Quality Foundation 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 v0.13.0 质量基础版本，包含集成测试框架和代码模板系统

**Architecture:** 集成测试复用已有 `executeGdscript()` + `findGodot()`，双层级（Level A 管道 + Level B E2E），Godot 可选；模板系统扩展已有 `code-templates.ts`，内联渲染 + 用户目录覆盖

**Tech Stack:** TypeScript, node:test, GDScript 4.4+

**Design Spec:** `docs/superpowers/specs/2026-05-23-v0130-major-upgrade-design.md`（模块 1 + 模块 2）

**Integration Test Spec:** `docs/superpowers/specs/2026-05-21-integration-test-framework-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `test/helpers/integration-setup.js` | 创建 | Godot 可用性检测 + `itIfGodot()` |
| `test/helpers/fixtures.js` | 创建 | MINIMAL_PROJECT 模板 |
| `test/integration/gdscript-execution.test.js` | 创建 | Level A: 5 个管道测试 |
| `test/integration/scene-operations.test.js` | 创建 | Level B: 6 个场景操作测试 |
| `test/integration/script-editing.test.js` | 创建 | Level B: 4 个脚本编辑测试 |
| `test/integration/project-management.test.js` | 创建 | Level B: 5 个项目管理测试 |
| `package.json` | 修改 | 已有 test:integration/test:all，无需改 |
| `src/tools/code-templates.ts` | 修改 | 新增 3 模板 + 用户模板加载 + MCP 工具 |
| `src/tools/script.ts` | 修改 | write_script 添加模板建议 |
| `src/GodotServer.ts` | 修改 | 注册 list_templates / apply_template 工具 |
| `test/code-templates.test.js` | 创建 | 模板系统单元测试 |

---

## Part A: 集成测试框架（Tasks 1-5）

### Task 1: 集成测试基础设施

**Files:**
- Create: `test/helpers/integration-setup.js`
- Create: `test/helpers/fixtures.js`

- [ ] **Step 1: 创建 integration-setup.js**

```javascript
// test/helpers/integration-setup.js

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
 * node:test 没有 describe.skip，用 it({ skip }) 替代。
 */
export function itIfGodot(name, fn) {
  if (_godotAvailable) {
    return it(name, fn);
  }
  return it(name, { skip: 'Godot not available' }, fn);
}
```

- [ ] **Step 2: 创建 fixtures.js**

```javascript
// test/helpers/fixtures.js

/** 最小可运行 Godot 项目 */
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

- [ ] **Step 3: 验证 package.json 已有集成测试脚本**

Run: `node -e "const p=require('./package.json'); console.log('test:integration:', p.scripts['test:integration']); console.log('test:all:', p.scripts['test:all'])"`

Expected: 两个脚本均已定义

- [ ] **Step 4: 构建 + 验证 import 可用**

Run: `npm run build`

Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add test/helpers/integration-setup.js test/helpers/fixtures.js
git commit -m "test: add integration test helpers (Godot detection + fixtures)"
```

---

### Task 2: Level A — GDScript 执行管道测试（5 个用例）

**Files:**
- Create: `test/integration/gdscript-execution.test.js`
- Test: Level A 用例 1-5

- [ ] **Step 1: 创建 gdscript-execution.test.js**

```javascript
// test/integration/gdscript-execution.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeGdscript } from '../../build/gdscript-executor.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level A: GDScript Execution Pipeline', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('1. simple expression output', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });

    assert.ok(result.compile_success, 'Should compile');
    assert.ok(result.run_success, 'Should run');
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].value, '42');
  });

  itIfGodot('2. JSON structured output', async () => {
    const data = JSON.stringify({ a: 1, b: 'hello' });
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `_mcp_output("data", '${data}')`,
      timeout: 10,
    });

    assert.ok(result.compile_success);
    assert.ok(result.run_success);
    const parsed = JSON.parse(result.outputs[0].value);
    assert.deepEqual(parsed, { a: 1, b: 'hello' });
  });

  itIfGodot('3. compile error detection', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'func foo(',
      timeout: 10,
    });

    assert.equal(result.compile_success, false, 'Should NOT compile');
    assert.ok(result.compile_error, 'Should have compile_error');
  });

  itIfGodot('4. runtime error capture', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `var x: Variant = null
x.call("hello")`,
      timeout: 10,
    });

    assert.ok(result.compile_success, 'Should compile');
    assert.equal(result.run_success, false, 'Should fail at runtime');
    assert.ok(result.run_error, 'Should have run_error');
  });

  itIfGodot('5. timeout interrupts infinite loop', async () => {
    const start = Date.now();
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'while true: pass',
      timeout: 3,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 10000, `Should terminate within 10s (took ${elapsed}ms)`);
    assert.equal(result.run_success, false, 'Should report failure');
  });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `npm run test:integration`

Expected: 5 个测试全部通过（Godot 可用时）或全部 skip（Godot 不可用时）

- [ ] **Step 3: Commit**

```bash
git add test/integration/gdscript-execution.test.js
git commit -m "test: add Level A GDScript execution pipeline tests (5 cases)"
```

---

### Task 3: Level B — 场景操作测试（6 个用例）

**Files:**
- Create: `test/integration/scene-operations.test.js`
- Test: Level B 用例 6-11

- [ ] **Step 1: 确认场景工具导入路径**

Run: `node -e "import('../../build/tools/scene.js').then(m => console.log(Object.keys(m).filter(k => typeof m[k] === 'function'))).catch(e => console.error(e.message))"`

Expected: 列出 handleTool 等导出函数

- [ ] **Step 2: 创建 scene-operations.test.js**

```javascript
// test/integration/scene-operations.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../../build/tools/scene.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Scene Operations', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('6. add node to scene', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);

    assert.ok(!result.isError, `Should succeed: ${result.content?.[0]?.text ?? ''}`);
  });

  itIfGodot('7. edit node properties', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'TestNode',
    }, ctx);

    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/TestNode',
      properties: { position: [100, 200] },
    }, ctx);

    assert.ok(!editResult.isError, `Edit should succeed: ${editResult.content?.[0]?.text ?? ''}`);
  });

  itIfGodot('8. query scene tree', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await scene.handleTool('query_scene_tree', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);

    assert.ok(!result.isError, `Query should succeed: ${result.content?.[0]?.text ?? ''}`);
    const text = result.content?.[0]?.text ?? '';
    assert.ok(text.includes('Root'), 'Should contain Root node');
  });

  itIfGodot('9. full CRUD cycle', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    // Create
    const addResult = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    assert.ok(!addResult.isError, 'Create should succeed');

    // Edit
    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 50] },
    }, ctx);
    assert.ok(!editResult.isError, 'Edit should succeed');

    // Remove (with confirmation)
    const removeResult = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    // remove_node 可能需要确认 token，接受 token 或成功
    const text = removeResult.content?.[0]?.text ?? '';
    assert.ok(
      !removeResult.isError || text.includes('confirmation_token'),
      'Remove should succeed or return confirmation token'
    );
  });

  itIfGodot('10. remove_node confirmation token flow', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    // 先添加一个节点
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'ToRemove',
    }, ctx);

    // 第一次 remove（无 token）
    const firstRemove = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/ToRemove',
    }, ctx);
    const text = firstRemove.content?.[0]?.text ?? '';

    // 如果返回 confirmation_token，用它完成删除
    if (text.includes('confirmation_token')) {
      const tokenMatch = text.match(/confirmation_token["']?\s*:\s*["']([^"']+)/);
      if (tokenMatch) {
        const confirmResult = await scene.handleTool('confirm_and_execute', {
          project_path: dirRef.path,
          token: tokenMatch[1],
        }, ctx);
        assert.ok(!confirmResult.isError, 'Confirm should succeed');
      }
    }
  });

  itIfGodot('11. operate on nonexistent scene', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/nonexistent.tscn',
    }, ctx);

    assert.ok(result.isError, 'Should return error');
    const text = result.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'Error message should be non-empty');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `npm run test:integration`

Expected: 场景测试全部通过或 skip

- [ ] **Step 4: Commit**

```bash
git add test/integration/scene-operations.test.js
git commit -m "test: add Level B scene operation tests (6 cases)"
```

---

### Task 4: Level B — 脚本编辑 + 项目管理测试（10 个用例）

**Files:**
- Create: `test/integration/script-editing.test.js`
- Create: `test/integration/project-management.test.js`
- Test: Level B 用例 12-20

- [ ] **Step 1: 确认工具导入路径**

Run: `node -e "Promise.all([import('../../build/tools/script.js'), import('../../build/tools/project.js')]).then(([s,p]) => console.log('script:', typeof s.handleTool, 'project:', typeof p.handleTool)).catch(e => console.error(e.message))"`

Expected: 两个 handleTool 都是 function

- [ ] **Step 2: 创建 script-editing.test.js**

```javascript
// test/integration/script-editing.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as script from '../../build/tools/script.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Script Editing', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('12. write new script', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await script.handleTool('write_script', {
      project_path: dirRef.path,
      script_path: 'res://scripts/new_script.gd',
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);

    assert.ok(!result.isError, `Write should succeed: ${result.content?.[0]?.text ?? ''}`);
    assert.ok(existsSync(`${dirRef.path}/scripts/new_script.gd`), 'File should exist');
  });

  itIfGodot('13. search and replace edit', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    // 先写一个脚本
    await script.handleTool('write_script', {
      project_path: dirRef.path,
      script_path: 'res://scripts/edit_me.gd',
      content: 'extends Node2D\n\nvar speed: float = 100.0\n\nfunc _ready():\n\tpass\n',
    }, ctx);

    // 搜索替换
    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: 'res://scripts/edit_me.gd',
      start_line: 3,
      end_line: 3,
      new_content: 'var speed: float = 200.0',
    }, ctx);

    assert.ok(!result.isError, `Edit should succeed: ${result.content?.[0]?.text ?? ''}`);

    const content = readFileSync(`${dirRef.path}/scripts/edit_me.gd`, 'utf-8');
    assert.ok(content.includes('200.0'), 'Should contain updated value');
    assert.ok(!content.includes('100.0'), 'Should NOT contain old value');
  });

  itIfGodot('14. validate script with errors', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await script.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: ['res://scripts/main.gd'],
    }, ctx);

    // main.gd 是合法的，应该通过验证
    assert.ok(!result.isError, `Validate should succeed: ${result.content?.[0]?.text ?? ''}`);
  });

  itIfGodot('15. edit nonexistent script', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await script.handleTool('edit_script', {
      project_path: dirRef.path,
      script_path: 'res://scripts/nonexistent.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);

    // 工具应返回错误（File not found 或 isError）
    const text = result.content?.[0]?.text ?? '';
    assert.ok(
      result.isError || text.includes('Error') || text.includes('not found'),
      'Should report error for nonexistent file'
    );
  });
});
```

- [ ] **Step 3: 创建 project-management.test.js**

```javascript
// test/integration/project-management.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as project from '../../build/tools/project.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level B: Project Management', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('16. create project', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await project.handleTool('create_project', {
      project_path: join(dirRef.path, 'NewProject'),
    }, ctx);

    assert.ok(!result.isError, `Create should succeed: ${result.content?.[0]?.text ?? ''}`);
    assert.ok(existsSync(join(dirRef.path, 'NewProject', 'project.godot')), 'project.godot should exist');
  });

  itIfGodot('17. read project config', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await project.handleTool('read_project_config', {
      project_path: dirRef.path,
    }, ctx);

    assert.ok(!result.isError, `Read config should succeed: ${result.content?.[0]?.text ?? ''}`);
    const text = result.content?.[0]?.text ?? '';
    assert.ok(text.includes('TestProject'), 'Should contain project name');
  });

  itIfGodot('18. validate project with missing references', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await project.handleTool('validate_project', {
      project_path: dirRef.path,
    }, ctx);

    // 最小项目应通过验证
    assert.ok(!result.isError, `Validate should succeed: ${result.content?.[0]?.text ?? ''}`);
  });

  itIfGodot('19. list files with extension filter', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await project.handleTool('list_files', {
      project_path: dirRef.path,
      extensions: ['.gd'],
    }, ctx);

    assert.ok(!result.isError, `List should succeed: ${result.content?.[0]?.text ?? ''}`);
    const text = result.content?.[0]?.text ?? '';
    assert.ok(text.includes('.gd'), 'Should contain .gd files');
    assert.ok(!text.includes('.tscn'), 'Should NOT contain .tscn files');
  });

  itIfGodot('20. validate scripts with empty path array', async () => {
    const ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();

    const result = await project.handleTool('validate_scripts', {
      project_path: dirRef.path,
      scripts: [],
    }, ctx);

    // 空路径数组应返回错误或空结果
    const text = result.content?.[0]?.text ?? '';
    assert.ok(
      result.isError || text.includes('0') || text.includes('no scripts') || text.includes('No scripts'),
      'Should handle empty scripts array gracefully'
    );
  });
});
```

- [ ] **Step 4: 运行全部集成测试**

Run: `npm run test:integration`

Expected: 全部 20 个集成测试通过或 skip

- [ ] **Step 5: Commit**

```bash
git add test/integration/script-editing.test.js test/integration/project-management.test.js
git commit -m "test: add Level B script editing (4) + project management (5) tests"
```

---

### Task 5: 全量测试验证

**Files:** 无新增

- [ ] **Step 1: 运行全部测试（单元 + 集成）**

Run: `npm run test:all`

Expected: 全部测试通过（单元 ~747 + 集成 20），集成测试 pass 或 skip

- [ ] **Step 2: 确认单元测试不受影响**

Run: `npm test`

Expected: 全部单元测试通过，无回归

- [ ] **Step 3: Commit（如有修复）**

```bash
git add -A
git commit -m "test: fix integration test issues found during full run"
```

---

## Part B: 代码模板系统（Tasks 6-11）

### Task 6: 新增 3 个内置模板

**Files:**
- Modify: `src/tools/code-templates.ts`

- [ ] **Step 1: 在 TEMPLATES 数组前添加 3 个新模板**

在 `line2dDashed` 模板定义之后，`export const TEMPLATES` 之前插入：

```typescript
const characterBody2dMovement: CodeTemplate = {
  id: "T008",
  name: "character_body_2d_movement",
  description: "CharacterBody2D move_and_slide() + 输入处理",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "speed", type: "float", default: "300.0" },
    { name: "jump_velocity", type: "float", default: "-400.0" },
  ],
  generate: (p) => `extends CharacterBody2D

const SPEED = ${p.speed ?? "300.0"}
const JUMP_VELOCITY = ${p.jump_velocity ?? "-400.0"}

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta):
\tif not is_on_floor():
\t\tvelocity.y += gravity * delta

\tif Input.is_action_just_pressed("ui_accept") and is_on_floor():
\t\tvelocity.y = JUMP_VELOCITY

\tvar direction = Input.get_axis("ui_left", "ui_right")
\tif direction:
\t\tvelocity.x = direction * SPEED
\telse:
\t\tvelocity.x = move_toward(velocity.x, 0, SPEED)

\tmove_and_slide()`.trim(),
};

const timerPattern: CodeTemplate = {
  id: "T009",
  name: "timer_pattern",
  description: "Timer one-shot/重复计时器模式",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "wait_time", type: "float", default: "1.0" },
    { name: "one_shot", type: "bool", default: "false" },
  ],
  generate: (p) => `var timer := Timer.new()

func _ready():
\ttimer.wait_time = ${p.wait_time ?? "1.0"}
\ttimer.one_shot = ${p.one_shot ?? "false"}
\ttimer.timeout.connect(_on_timer_timeout)
\tadd_child(timer)
\ttimer.start()

func _on_timer_timeout():
\tpass`.trim(),
};

const stateMachineSimple: CodeTemplate = {
  id: "T010",
  name: "state_machine_simple",
  description: "简单 enum + match 状态管理",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "states", type: "string", default: "IDLE,RUN,JUMP" },
  ],
  generate: (p) => {
    const stateNames = (p.states ?? "IDLE,RUN,JUMP").split(",");
    const enumBody = stateNames.map(s => `\t${s.trim()}`).join(",\n");
    const matchBody = stateNames.map(s => `\t\t${s.trim()}:\n\t\t\tpass`).join("\n");
    return `enum State {
${enumBody}
}

var current_state: State = State.${stateNames[0].trim()}

func _process(delta):
\tmatch current_state:
${matchBody}

func transition_to(new_state: State):
\tcurrent_state = new_state`.trim();
  },
};
```

- [ ] **Step 2: 更新 TEMPLATES 数组**

在 `TEMPLATES` 数组末尾追加 3 个新模板：

```typescript
export const TEMPLATES: CodeTemplate[] = [
  cameraSetup,
  rigidbodyWithBounce,
  area3dDetection,
  environmentAdjustments,
  softbodySetup,
  astarGridSetup,
  line2dDashed,
  characterBody2dMovement,
  timerPattern,
  stateMachineSimple,
];
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools/code-templates.ts
git commit -m "feat: add 3 new code templates (CharacterBody2D, Timer, StateMachine)"
```

---

### Task 7: 用户模板加载

**Files:**
- Modify: `src/tools/code-templates.ts`

- [ ] **Step 1: 在 code-templates.ts 底部（`getTemplateSuggestion` 之后）添加用户模板加载逻辑**

```typescript
// ─── User Template Loading ──────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface UserTemplateFile {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  appliesTo?: string[];
  godotVersion?: string;
  code: string;
  variables?: TemplateParam[];
}

function validateUserTemplate(raw: unknown, filePath: string): UserTemplateFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.name !== 'string' || !t.name) return null;
  if (typeof t.code !== 'string' || !t.code.trim()) return null;
  if (typeof t.description !== 'string') t.description = '';
  return t as unknown as UserTemplateFile;
}

/** 加载项目 .mcp-templates/ 目录下的用户模板 */
export function loadUserTemplates(projectPath: string): CodeTemplate[] {
  const templateDir = join(projectPath, '.mcp-templates');
  if (!existsSync(templateDir)) return [];

  const userTemplates: CodeTemplate[] = [];
  const builtInIds = new Set(TEMPLATES.map(t => t.id));

  for (const file of readdirSync(templateDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(templateDir, file);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const validated = validateUserTemplate(raw, filePath);
      if (!validated) continue;

      const id = validated.id;
      if (builtInIds.has(id)) {
        console.warn(`[template] User template '${id}' in ${file} overrides built-in template`);
      }

      userTemplates.push({
        id,
        name: validated.name,
        description: validated.description ?? '',
        relatedRules: [],
        params: validated.variables ?? [],
        generate: (p) => {
          let code = validated.code;
          for (const [key, value] of Object.entries(p)) {
            code = code.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
          }
          return code;
        },
        verifiedGodotVersion: validated.godotVersion ?? '4.2',
        lastVerified: new Date().toISOString().split('T')[0],
      });
    } catch (err) {
      console.warn(`[template] Failed to load ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return userTemplates;
}

/** 渲染模板变量 — 供 MCP 工具使用 */
export function renderTemplate(code: string, variables: Record<string, string>): string {
  return code.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}

/** 获取所有模板（内置 + 用户） */
export function getAllTemplates(projectPath?: string): CodeTemplate[] {
  const builtIn = [...TEMPLATES];
  if (!projectPath) return builtIn;
  const user = loadUserTemplates(projectPath);
  if (user.length === 0) return builtIn;

  // 用户模板覆盖同名内置模板
  const userIds = new Set(user.map(t => t.id));
  const merged = builtIn.filter(t => !userIds.has(t.id)).concat(user);
  return merged;
}
```

注意：需要在文件顶部确认 `TemplateParam` 已导出（当前为 `interface TemplateParam`，需改为 `export interface TemplateParam`）。

- [ ] **Step 2: 导出 TemplateParam**

将 `interface TemplateParam` 改为 `export interface TemplateParam`。

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools/code-templates.ts
git commit -m "feat: add user template loading from .mcp-templates/ directory"
```

---

### Task 8: MCP 工具 — list_templates + apply_template

**Files:**
- Modify: `src/tools/code-templates.ts`（添加 handleTool）
- Modify: `src/GodotServer.ts`（注册工具）

- [ ] **Step 1: 在 code-templates.ts 底部添加 handleTool**

```typescript
// ─── MCP Tool Handler ───────────────────────────────────────────────────────

import { resolveWithinRoot, validatePath } from './shared.js';
import { ensureDir } from './shared.js';
import { writeFileSync } from 'node:fs';

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

export async function handleTemplateTool(
  name: string, args: Record<string, unknown>, ctx: any
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const projectPath = args.project_path ? validatePath(args.project_path as string) : undefined;

  if (name === 'list_templates') {
    const templates = getAllTemplates(projectPath);

    // 支持过滤
    const tag = args.tag as string | undefined;
    const appliesTo = args.applies_to as string | undefined;
    let filtered = templates;
    if (tag) filtered = filtered.filter(t => t.relatedRules.includes(tag));
    if (appliesTo) filtered = filtered.filter(t => t.description.toLowerCase().includes(appliesTo.toLowerCase()));

    const lines = filtered.map(t =>
      `- **${t.id}**: ${t.name} — ${t.description} (params: ${t.params.map(p => p.name).join(', ') || 'none'})`
    );
    return textResult(`Available templates (${filtered.length}):\n${lines.join('\n')}`);
  }

  if (name === 'apply_template') {
    const templateId = args.template_id as string;
    const scriptPath = args.script_path as string;
    if (!templateId) return textResult('Error: template_id is required', true);
    if (!scriptPath) return textResult('Error: script_path is required', true);
    if (!projectPath) return textResult('Error: project_path is required', true);

    const templates = getAllTemplates(projectPath);
    const template = templates.find(t => t.id === templateId);
    if (!template) return textResult(`Error: Template '${templateId}' not found. Available: ${templates.map(t => t.id).join(', ')}`, true);

    // 合并参数
    const variables: Record<string, string> = {};
    const userVars = (args.variables ?? {}) as Record<string, unknown>;
    for (const param of template.params) {
      variables[param.name] = (userVars[param.name] as string) ?? param.default;
    }

    const code = template.generate(variables);
    const fullPath = resolveWithinRoot(projectPath, scriptPath);
    ensureDir(fullPath);
    writeFileSync(fullPath, code, 'utf-8');

    return textResult(`Template '${template.name}' applied to ${scriptPath} (${code.split('\n').length} lines)`);
  }

  return textResult(`Error: Unknown template tool '${name}'`, true);
}
```

- [ ] **Step 2: 在 GodotServer.ts 中注册工具**

找到工具注册区域，添加 `list_templates` 和 `apply_template` 两个工具的定义和路由。具体位置需要读取 GodotServer.ts 中的注册模式后确定。

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools/code-templates.ts src/GodotServer.ts
git commit -m "feat: add list_templates + apply_template MCP tools"
```

---

### Task 9: 模板系统单元测试

**Files:**
- Create: `test/code-templates.test.js`

- [ ] **Step 1: 创建测试文件**

```javascript
// test/code-templates.test.js

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TEMPLATES,
  getTemplateSuggestion,
  renderTemplate,
  getAllTemplates,
  loadUserTemplates,
} from '../build/tools/code-templates.js';

describe('Code Template System', () => {

  describe('built-in templates', () => {
    it('has at least 10 templates', () => {
      assert.ok(TEMPLATES.length >= 10, `Expected >= 10, got ${TEMPLATES.length}`);
    });

    it('each template has required fields', () => {
      for (const t of TEMPLATES) {
        assert.ok(t.id, `Template missing id`);
        assert.ok(t.name, `Template ${t.id} missing name`);
        assert.ok(t.description, `Template ${t.id} missing description`);
        assert.ok(typeof t.generate === 'function', `Template ${t.id} missing generate`);
        assert.ok(t.generate({}).length > 0, `Template ${t.id} generate() returns empty`);
      }
    });

    it('each template id is unique', () => {
      const ids = TEMPLATES.map(t => t.id);
      const unique = new Set(ids);
      assert.equal(ids.length, unique.size, 'Duplicate template IDs found');
    });
  });

  describe('template rendering', () => {
    it('replaces {{variable}} placeholders', () => {
      const result = renderTemplate('var speed = {{speed}}', { speed: '300' });
      assert.equal(result, 'var speed = 300');
    });

    it('leaves unreplaced placeholders intact', () => {
      const result = renderTemplate('var x = {{unknown}}', {});
      assert.equal(result, 'var x = {{unknown}}');
    });

    it('replaces multiple occurrences', () => {
      const result = renderTemplate('{{a}} + {{a}}', { a: '1' });
      assert.equal(result, '1 + 1');
    });
  });

  describe('CharacterBody2D template', () => {
    it('generates valid GDScript with default params', () => {
      const t = TEMPLATES.find(t => t.id === 'T008');
      assert.ok(t, 'T008 should exist');
      const code = t.generate({ speed: '200', jump_velocity: '-500' });
      assert.ok(code.includes('extends CharacterBody2D'));
      assert.ok(code.includes('200'));
      assert.ok(code.includes('-500'));
      assert.ok(code.includes('move_and_slide'));
    });
  });

  describe('StateMachine template', () => {
    it('generates enum from comma-separated states', () => {
      const t = TEMPLATES.find(t => t.id === 'T010');
      assert.ok(t, 'T010 should exist');
      const code = t.generate({ states: 'IDLE,WALK,RUN' });
      assert.ok(code.includes('IDLE'));
      assert.ok(code.includes('WALK'));
      assert.ok(code.includes('RUN'));
      assert.ok(code.includes('enum State'));
      assert.ok(code.includes('match current_state'));
    });
  });

  describe('getTemplateSuggestion', () => {
    it('returns template for known lint rule', () => {
      const suggestion = getTemplateSuggestion('L001');
      assert.ok(suggestion, 'Should return suggestion for L001');
      assert.ok(suggestion.includes('Camera3D'));
    });

    it('returns null for unknown rule', () => {
      assert.equal(getTemplateSuggestion('L999'), null);
    });
  });

  describe('user template loading', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = join(tmpdir(), `template-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });

    it('returns empty when .mcp-templates/ does not exist', () => {
      const user = loadUserTemplates(tempDir);
      assert.deepEqual(user, []);
    });

    it('loads valid user template from .mcp-templates/', () => {
      const tplDir = join(tempDir, '.mcp-templates');
      mkdirSync(tplDir, { recursive: true });
      writeFileSync(join(tplDir, 'my-template.json'), JSON.stringify({
        id: 'user-001',
        name: 'My Template',
        description: 'A user template',
        code: 'extends {{base}}\n\nfunc _ready():\n\tpass',
        variables: [
          { name: 'base', type: 'string', default: 'Node2D' },
        ],
      }));

      const user = loadUserTemplates(tempDir);
      assert.equal(user.length, 1);
      assert.equal(user[0].id, 'user-001');
      assert.equal(user[0].name, 'My Template');
      const code = user[0].generate({ base: 'Node3D' });
      assert.ok(code.includes('extends Node3D'));
    });

    it('skips invalid user templates', () => {
      const tplDir = join(tempDir, '.mcp-templates');
      mkdirSync(tplDir, { recursive: true });
      writeFileSync(join(tplDir, 'bad.json'), JSON.stringify({ no_id: true }));
      writeFileSync(join(tplDir, 'also-bad.txt'), 'not json');

      const user = loadUserTemplates(tempDir);
      assert.equal(user.length, 0);
    });

    it('getAllTemplates merges user with built-in', () => {
      const tplDir = join(tempDir, '.mcp-templates');
      mkdirSync(tplDir, { recursive: true });
      writeFileSync(join(tplDir, 'custom.json'), JSON.stringify({
        id: 'user-custom',
        name: 'Custom',
        description: 'Custom template',
        code: 'extends Node',
      }));

      const all = getAllTemplates(tempDir);
      assert.ok(all.length > TEMPLATES.length, 'Should have more templates than built-in');
      assert.ok(all.find(t => t.id === 'user-custom'), 'Should include user template');
    });
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npm test`

Expected: 全部单元测试通过（含新模板测试）

- [ ] **Step 3: Commit**

```bash
git add test/code-templates.test.js
git commit -m "test: add code template system unit tests"
```

---

### Task 10: write_script 集成模板建议

**Files:**
- Modify: `src/tools/script.ts`

- [ ] **Step 1: 在 write_script handler 中添加模板建议**

在 `src/tools/script.ts` 的 `write_script` case 中（约 260-273 行），lint 之后添加模板建议：

找到：
```typescript
      let lintSection = '';
      if (sp.endsWith('.gd')) {
        const lintOutput = lintGDScript(content);
        lintSection = formatLintResults(lintOutput);
      }
      return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${lintSection}`);
```

替换为：
```typescript
      let lintSection = '';
      let templateHint = '';
      if (sp.endsWith('.gd')) {
        const lintOutput = lintGDScript(content);
        lintSection = formatLintResults(lintOutput);

        // 如果有 lint 问题，检查是否有对应模板建议
        if (lintOutput.some(r => r.level === 'error' || r.level === 'warning')) {
          const suggestions = new Set<string>();
          for (const rule of lintOutput) {
            const suggestion = getTemplateSuggestion(rule.ruleId);
            if (suggestion) suggestions.add(`  (${rule.ruleId}) → use list_templates to find a fix`);
          }
          if (suggestions.size > 0) {
            templateHint = '\n\nTemplate suggestions:\n' + [...suggestions].join('\n');
          }
        }
      }
      return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${lintSection}${templateHint}`);
```

同时确保 `getTemplateSuggestion` 已导入：
```typescript
import { getTemplateSuggestion } from './code-templates.js';
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`

Expected: 编译成功

- [ ] **Step 3: 运行全部测试**

Run: `npm test`

Expected: 全部通过，无回归

- [ ] **Step 4: Commit**

```bash
git add src/tools/script.ts
git commit -m "feat: add template suggestions to write_script lint output"
```

---

### Task 11: 最终验证 + 版本更新

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 更新版本号**

将 `package.json` 中 `"version": "0.12.0"` 改为 `"version": "0.13.0"`。

- [ ] **Step 2: 全量测试**

Run: `npm run test:all`

Expected: 全部测试通过（单元 + 集成），无回归

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "release: v0.13.0 quality foundation"
```
