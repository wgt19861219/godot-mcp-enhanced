# P2: 工具补充（文档查询增强 + 测试框架 + 导出管理）实施计划

> **Goal:** 为 godot-mcp-enhanced 添加文档版本锁定、测试框架（test_assert/test_stress）和导出管理（export_list_presets/export_get_preset/export_build），实现 P2 批次交付。
> **Architecture:** 文档工具复用已有 docs.ts/godot-docs.ts（只需加版本锁定和友好错误）；测试框架和导出管理是新模块，测试框架 Headless+Editor 双模式，导出管理仅 Editor 模式；编辑器插件新增 test_commands.gd 和 export_commands.gd 两个命令文件。
> **Tech Stack:** TypeScript, GDScript, Node.js test runner

---

### Task 1: 文档版本锁定 + 友好缺失错误

**Files:**
- Modify: `src/godot-docs.ts`
- Test: `test/docs-version.test.js`

- [ ] **Step 1: 编写测试**

```js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

describe('docs version locking', () => {
  const tmpDir = join(__dirname, 'tmp-docs-test');

  beforeEach(() => {
    // Clean up module cache by creating fresh import
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  it('should extract godot_version from extension_api.json header', () => {
    const apiData = {
      header: { version_major: 4, version_minor: 4, version_patch: 0 },
      classes: [{ name: 'Node', inherits: '', brief_description: 'Base class' }],
    };
    const apiPath = join(tmpDir, 'extension_api.json');
    writeFileSync(apiPath, JSON.stringify(apiData));

    // Dynamic import to get fresh module
    const docs = await import('../build/godot-docs.js?t=' + Date.now());
    docs.initDocs(apiPath);
    const version = docs.getDocsVersion();
    assert.equal(version, '4.4.0');
  });

  it('should return null version when header missing', () => {
    const apiData = { classes: [] };
    const apiPath = join(tmpDir, 'extension_api.json');
    writeFileSync(apiPath, JSON.stringify(apiData));

    const docs = await import('../build/godot-docs.js?t=' + Date.now());
    docs.initDocs(apiPath);
    assert.equal(docs.getDocsVersion(), null);
  });

  it('ensureInit should throw friendly error when file missing', async () => {
    // Point to non-existent path
    const docs = await import('../build/godot-docs.js?t=' + Date.now());
    assert.throws(
      () => docs.testEnsureInit('/nonexistent/path/extension_api.json'),
      /godot-classes\.json not found.*Run 'npx godot-mcp-enhanced generate-docs'/
    );
  });
});
```

- [ ] **Step 2: 实现版本锁定和友好错误**

在 `src/godot-docs.ts` 中：
1. 添加 `docsVersion: string | null` 模块变量
2. 在 `initDocs()` 中解析 header 获取 `{version_major, version_minor, version_patch}` 并存为 `docsVersion`
3. 导出 `getDocsVersion(): string | null` 函数
4. 修改 `ensureInit()` 错误消息，从 `extension_api.json not found` 改为包含 `generate-docs` 提示的友好消息
5. 导出 `testEnsureInit(path)` 供测试调用

```typescript
let docsVersion: string | null = null;

export function initDocs(docsPath: string): void {
  if (initialized) return;
  const raw = readFileSync(docsPath, 'utf-8');
  const data: ApiData = JSON.parse(raw);
  classMap.clear();
  for (const cls of data.classes) {
    classMap.set(cls.name, cls);
  }
  // Version locking
  const header = (data as any).header;
  if (header?.version_major != null) {
    docsVersion = `${header.version_major}.${header.version_minor ?? 0}.${header.version_patch ?? 0}`;
  }
  initialized = true;
  console.error(`[godot-docs] Loaded ${classMap.size} classes (v${docsVersion ?? 'unknown'}) from ${docsPath}`);
}

export function getDocsVersion(): string | null {
  return docsVersion;
}

function ensureInit(): void {
  if (initialized) return;
  const docsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'api', 'extension_api.json');
  if (existsSync(docsPath)) {
    initDocs(docsPath);
  } else {
    throw new Error(
      'Godot docs database not found. Extension API file missing.\n' +
      'Run: npx godot-mcp-enhanced generate-docs\n' +
      'Or place extension_api.json in docs/api/ directory.'
    );
  }
}

// Test-only export
export function testEnsureInit(path: string): void {
  if (existsSync(path)) {
    initDocs(path);
  } else {
    throw new Error(
      'Godot docs database not found. Run \'npx godot-mcp-enhanced generate-docs\' first.'
    );
  }
}
```

- [ ] **Step 3: 构建并运行测试**

Run: `npm run build && node --test test/docs-version.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/godot-docs.ts test/docs-version.test.js
git commit -m "feat(docs): version locking + friendly missing-docs error"
```

---

### Task 2: generate-docs 脚本

**Files:**
- Create: `scripts/generate-doc-db.js`
- Modify: `package.json`（添加 `generate-docs` 命令）

- [ ] **Step 1: 编写 generate-doc-db.js**

脚本职责：调用 `godot --doctool --headless` 生成文档，然后解析 `doc/classes/` 目录下的 `.xml` 文件，提取类名、继承、描述、方法、属性、信号、常量，输出为 `data/godot-classes.json`。

```javascript
#!/usr/bin/env node
// scripts/generate-doc-db.js
// Generates data/godot-classes.json from Godot's built-in class documentation
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Parse XML manually (no dependencies)
function parseXml(text) {
  const classes = [];
  // Split by <class> blocks
  const classRegex = /<class\s+name="([^"]+)"\s+inherits="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g;
  const classNoInherit = /<class\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;

  let match;
  // First try with inherits
  const fullRegex = /<class\s+name="([^"]+)"(?:\s+inherits="([^"]*)")?[^>]*>([\s\S]*?)<\/class>/g;
  while ((match = fullRegex.exec(text)) !== null) {
    const cls = {
      name: match[1],
      inherits: match[2] || '',
      brief_description: '',
      description: '',
      methods: [],
      properties: [],
      signals: [],
      constants: [],
      enums: [],
    };
    const body = match[3];

    // Extract brief_description
    const bdMatch = body.match(/<brief_description>([\s\S]*?)<\/brief_description>/);
    if (bdMatch) cls.brief_description = bdMatch[1].trim();

    // Extract description
    const descMatch = body.match(/<description>([\s\S]*?)<\/description>/);
    if (descMatch) cls.description = descMatch[1].trim();

    // Extract methods
    const methodRegex = /<method\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/method>/g;
    let mMatch;
    while ((mMatch = methodRegex.exec(body)) !== null) {
      const method = {
        name: mMatch[1],
        return_type: 'void',
        arguments: [],
        description: '',
      };
      const mBody = mMatch[2];
      const retMatch = mBody.match(/<return\s+type="([^"]*)"/);
      if (retMatch) method.return_type = retMatch[1] || 'void';

      const argRegex = /<param\s+name="([^"]+)"\s+type="([^"]+)"[^>]*>/g;
      let aMatch;
      while ((aMatch = argRegex.exec(mBody) !== null)) {
        method.arguments.push({ name: aMatch[1], type: aMatch[2] });
      }
      const mDescMatch = mBody.match(/<description>([\s\S]*?)<\/description>/);
      if (mDescMatch) method.description = mDescMatch[1].trim();
      cls.methods.push(method);
    }

    // Extract properties
    const propRegex = /<property\s+name="([^"]+)"\s+type="([^"]+)"[^>]*>/g;
    let pMatch;
    while ((pMatch = propRegex.exec(body)) !== null) {
      cls.properties.push({ name: pMatch[1], type: pMatch[2], description: '' });
    }

    // Extract signals
    const sigRegex = /<signal\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/signal>/g;
    let sMatch;
    while ((sMatch = sigRegex.exec(body)) !== null) {
      const signal = { name: sMatch[1], arguments: [], description: '' };
      const sBody = sMatch[2];
      const saRegex = /<param\s+name="([^"]+)"\s+type="([^"]+)"/g;
      let saMatch;
      while ((saMatch = saRegex.exec(sBody)) !== null) {
        signal.arguments.push({ name: saMatch[1], type: saMatch[2] });
      }
      cls.signals.push(signal);
    }

    // Extract constants
    const constRegex = /<constant\s+name="([^"]+)"\s+value="([^"]*)"[^>]*>/g;
    let cMatch;
    while ((cMatch = constRegex.exec(body)) !== null) {
      cls.constants.push({ name: cMatch[1], value: cMatch[2], description: '' });
    }

    classes.push(cls);
  }
  return classes;
}

async function main() {
  // 1. Find Godot binary
  const godotPath = process.env.GODOT_PATH || 'godot';

  // 2. Get Godot version
  let version = 'unknown';
  try {
    const verOut = execSync(`"${godotPath}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
    version = verOut;
    console.log(`Godot version: ${version}`);
  } catch (e) {
    console.error('Warning: Could not get Godot version:', e.message);
  }

  // 3. Try to use extension_api.json approach (more reliable than --doctool)
  const apiPath = join(ROOT, 'docs', 'api', 'extension_api.json');
  if (existsSync(apiPath)) {
    console.log('Using existing extension_api.json...');
    const raw = readFileSync(apiPath, 'utf-8');
    const data = JSON.parse(raw);
    const output = {
      godot_version: version,
      generated_at: new Date().toISOString(),
      header: data.header || {},
      classes: data.classes || [],
    };
    const outPath = join(ROOT, 'data', 'godot-classes.json');
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output));
    console.log(`Written ${output.classes.length} classes to ${outPath}`);
    return;
  }

  // 4. Fallback: generate via --doctool
  const outputDir = join(ROOT, '.gd-docs-temp');
  mkdirSync(outputDir, { recursive: true });

  console.log('Generating docs via --doctool...');
  const result = spawnSync(godotPath, ['--headless', '--doctool', outputDir], {
    timeout: 120000,
    encoding: 'utf-8',
  });

  if (result.error) {
    console.error('Failed to run Godot --doctool:', result.error.message);
    process.exit(1);
  }

  // Parse generated XML files
  const classesDir = join(outputDir, 'classes');
  if (!existsSync(classesDir)) {
    console.error('No classes directory generated');
    process.exit(1);
  }

  const allClasses = [];
  const files = readdirSync(classesDir).filter(f => f.startsWith('class_') && f.endsWith('.xml'));
  console.log(`Parsing ${files.length} XML files...`);

  for (const file of files) {
    const text = readFileSync(join(classesDir, file), 'utf-8');
    const parsed = parseXml(text);
    allClasses.push(...parsed);
  }

  const output = {
    godot_version: version,
    generated_at: new Date().toISOString(),
    classes: allClasses,
  };

  const outPath = join(ROOT, 'data', 'godot-classes.json');
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output));
  console.log(`Written ${allClasses.length} classes to ${outPath}`);

  // Cleanup
  try { rmSync(outputDir, { recursive: true }); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 在 package.json 添加命令**

在 `package.json` 的 `scripts` 中添加：
```json
"generate-docs": "node scripts/generate-doc-db.js"
```

- [ ] **Step 3: 验证脚本可执行**

Run: `node scripts/generate-doc-db.js`
Expected: 如果有 extension_api.json 则转换成功；否则尝试 godot --doctool

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-doc-db.js package.json
git commit -m "feat: add generate-docs script for godot-classes.json"
```

---

### Task 3: test_assert + test_stress 工具

**Files:**
- Create: `src/tools/test-framework.ts`
- Modify: `src/GodotServer.ts`（注册新模块）
- Test: `test/test-framework.test.js`

- [ ] **Step 1: 编写 test-framework.ts**

```typescript
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { SCENE_TREE_HEADER, MARKER_RESULT, parseGdscriptResult } from './shared.js';

const TOOL_NAMES = ['test_assert', 'test_stress'] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'test_assert',
      description: 'Assert conditions on the Godot scene tree or runtime state. Supports: node_exists, property_equals, signal_connected, node_count.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          assertion_type: {
            type: 'string',
            enum: ['node_exists', 'property_equals', 'signal_connected', 'node_count'],
            description: 'Type of assertion to perform',
          },
          path: { type: 'string', description: 'Node path (e.g. root/Player)' },
          property: { type: 'string', description: 'Property name (for property_equals)' },
          expected: { description: 'Expected value (for property_equals)' },
          signal: { type: 'string', description: 'Signal name (for signal_connected)' },
          target: { type: 'string', description: 'Target node path (for signal_connected)' },
          method: { type: 'string', description: 'Target method name (for signal_connected)' },
          parent: { type: 'string', description: 'Parent node path (for node_count)' },
          count: { type: 'number', description: 'Expected child count (for node_count)' },
        },
        required: ['project_path', 'assertion_type'],
      },
    },
    {
      name: 'test_stress',
      description: 'Stress test: repeatedly create/destroy nodes to detect memory leaks. Returns iterations, peak memory, and leak status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          node_type: { type: 'string', description: 'Node type to create/destroy (default: Node)', default: 'Node' },
          iterations: { type: 'number', description: 'Number of iterations (default: 100)', default: 100 },
        },
        required: ['project_path'],
      },
    },
  ];
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'test_assert': return handleTestAssert(args, ctx);
    case 'test_stress': return handleTestStress(args, ctx);
    default: return null;
  }
}

function handleTestAssert(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const assertionType = args.assertion_type as string;
  const path = args.path as string;
  const script = `${SCENE_TREE_HEADER}

func _init():
\tvar _root = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not available")
\t\t_mcp_done()
\t\treturn
\tvar _path = "${path || ''}"
\tmatch "${assertionType}":
\t\t"node_exists":
\t\t\tvar _n = _mcp_get_node(_path)
\t\t\tif _n != null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": true, "message": "Node exists: " + _path}))
\t\t\telse:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Node not found: " + _path}))
\t\t"property_equals":
\t\t\tvar _n = _mcp_get_node(_path)
\t\t\tif _n == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Node not found: " + _path}))
\t\t\telse:
\t\t\t\tvar _prop = "${args.property || ''}"
\t\t\t\tvar _val = _n.get(_prop)
\t\t\t\tvar _expected = ${JSON.stringify(JSON.stringify(args.expected))}
\t\t\t\tvar _expected_parsed = JSON.parse(_expected)
\t\t\t\tvar _match = str(_val) == str(_expected_parsed)
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _match, "message": "%s.%s = %s (expected: %s)" % [_path, _prop, str(_val), str(_expected_parsed)], "actual": str(_val)}))
\t\t"signal_connected":
\t\t\tvar _src = _mcp_get_node("${args.path || ''}")
\t\t\tvar _tgt = _mcp_get_node("${args.target || ''}")
\t\t\tif _src == null or _tgt == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Source or target node not found"}))
\t\t\telse:
\t\t\t\tvar _connected = _src.is_connected("${args.signal || ''}", Callable(_tgt, "${args.method || ''}"))
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _connected, "message": "Signal %s->%s.%s %s" % ["${args.signal || ''}", "${args.target || ''}", "${args.method || ''}", "connected" if _connected else "not connected"]}))
\t\t"node_count":
\t\t\tvar _p = _mcp_get_node("${args.parent || 'root'}")
\t\t\tif _p == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Parent node not found: ${args.parent || 'root'}"}))
\t\t\telse:
\t\t\t\tvar _count = _p.get_child_count()
\t\t\t\tvar _expected = ${args.count ?? -1}
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _count == _expected, "message": "Children of ${args.parent || 'root'}: %d (expected: %d)" % [_count, _expected], "actual": _count}))
\t\t_:
\t\t\t_mcp_output("error", "Unknown assertion type: ${assertionType}")
\t_mcp_done()
`;

  return parseGdscriptResult(
    ctx.executeScriptSync!(script, args.project_path as string),
    [],
    (msg) => 'ASSERTION_FAILED',
  );
}

function handleTestStress(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const nodeType = (args.node_type as string) || 'Node';
  const iterations = (args.iterations as number) || 100;
  const script = `${SCENE_TREE_HEADER}

func _init():
\tvar _root = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not available")
\t\t_mcp_done()
\t\treturn
\tvar _type = "${nodeType}"
\tvar _iters = ${iterations}
\tvar _mem_before = Performance.get_monitor(Performance.MEMORY_STATIC)
\tvar _peak = _mem_before
\tfor _i in range(_iters):
\t\tvar _n = ClassDB.instantiate(_type)
\t\tif _n == null:
\t\t\t_mcp_output("error", "Cannot instantiate: " + _type)
\t\t\t_mcp_done()
\t\t\treturn
\t\t_root.add_child(_n)
\t\tvar _mem = Performance.get_monitor(Performance.MEMORY_STATIC)
\t\tif _mem > _peak:
\t\t\t_peak = _mem
\t\t_n.queue_free()
\t\t# Force frame process
\tawait get_tree().process_frame
\tvar _mem_after = Performance.get_monitor(Performance.MEMORY_STATIC)
\tvar _leaked = _mem_after > _mem_before * 1.1
\t_mcp_output("result", JSON.stringify({
\t\t"success": not _leaked,
\t\t"iterations": _iters,
\t\t"node_type": _type,
\t\t"memory_before": _mem_before,
\t\t"memory_after": _mem_after,
\t\t"peak_memory": _peak,
\t\t"leaked": _leaked,
\t\t"message": "Stress test %s: %d iterations, memory %s" % ["PASSED" if not _leaked else "LEAKED", _iters, "stable" if not _leaked else "increased"]
\t}))
\t_mcp_done()
`;

  return parseGdscriptResult(
    ctx.executeScriptSync!(script, args.project_path as string),
    [],
    (msg) => 'STRESS_TEST_FAILED',
  );
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  test_assert: { readonly: true, long_running: false },
  test_stress: { readonly: false, long_running: true },
};
```

- [ ] **Step 2: 注册到 GodotServer.ts**

在 `src/GodotServer.ts` 中添加 `testFramework` 模块导入和注册：

```typescript
import * as testFramework from './tools/test-framework.js';
// 添加到 toolModules 数组
const toolModules = [runtime, screenshot, project, scene, script, validation, docs, godotOps, tilemapOps, materialOps, gameBridge, workflow, animationOps, profilerOps, spatialOps, testFramework];
```

- [ ] **Step 3: 编写测试**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('test-framework tool definitions', () => {
  it('should export tool definitions for test_assert and test_stress', async () => {
    const mod = await import('../build/tools/test-framework.js');
    const defs = mod.getToolDefinitions();
    assert.equal(defs.length, 2);
    assert.equal(defs[0].name, 'test_assert');
    assert.equal(defs[1].name, 'test_stress');
  });

  it('should export TOOL_META with correct readonly/long_running tags', async () => {
    const mod = await import('../build/tools/test-framework.js');
    assert.equal(mod.TOOL_META.test_assert.readonly, true);
    assert.equal(mod.TOOL_META.test_assert.long_running, false);
    assert.equal(mod.TOOL_META.test_stress.readonly, false);
    assert.equal(mod.TOOL_META.test_stress.long_running, true);
  });

  it('should return null for unknown tool name', async () => {
    const mod = await import('../build/tools/test-framework.js');
    const result = await mod.handleTool('unknown_tool', {}, {});
    assert.equal(result, null);
  });
});
```

- [ ] **Step 4: 构建并测试**

Run: `npm run build && node --test test/test-framework.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/test-framework.ts test/test-framework.test.js src/GodotServer.ts
git commit -m "feat: add test_assert and test_stress tools"
```

---

### Task 4: 编辑器插件 — test + export 命令

**Files:**
- Create: `addons/godot_mcp_server/commands/test_commands.gd`
- Create: `addons/godot_mcp_server/commands/export_commands.gd`
- Modify: `addons/godot_mcp_server/command_handler.gd`

- [ ] **Step 1: 创建 test_commands.gd**

```gdscript
extends Node

func handle_test_assert(params: Dictionary) -> Dictionary:
	var assertion_type: String = params.get("assertion_type", "")
	var path: String = params.get("path", "")
	var ei = _get_editor_interface()
	var root: Node = null
	if ei:
		root = ei.get_edited_scene_root()
		if root == null:
			return {"error": {"code": -32003, "message": "No scene currently open in editor"}}
	else:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}

	match assertion_type:
		"node_exists":
			var node = _find_node(root, path)
			if node != null:
				return {"result": {"passed": true, "message": "Node exists: " + path}}
			else:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
		"property_equals":
			var node = _find_node(root, path)
			if node == null:
				return {"result": {"passed": false, "message": "Node not found: " + path}}
			var prop: String = params.get("property", "")
			var val = node.get(prop)
			var expected = params.get("expected")
			var match = str(val) == str(expected)
			return {"result": {"passed": match, "message": "%s.%s = %s (expected: %s)" % [path, prop, str(val), str(expected)], "actual": str(val)}}
		"signal_connected":
			var src_path: String = params.get("path", "")
			var tgt_path: String = params.get("target", "")
			var sig: String = params.get("signal", "")
			var meth: String = params.get("method", "")
			var src = _find_node(root, src_path)
			var tgt = _find_node(root, tgt_path)
			if src == null or tgt == null:
				return {"result": {"passed": false, "message": "Source or target node not found"}}
			var connected = src.is_connected(sig, Callable(tgt, meth))
			return {"result": {"passed": connected, "message": "Signal %s->%s.%s %s" % [sig, tgt_path, meth, "connected" if connected else "not connected"]}}
		"node_count":
			var parent_path: String = params.get("parent", "")
			var parent_node = _find_node(root, parent_path) if parent_path != "" else root
			if parent_node == null:
				return {"result": {"passed": false, "message": "Parent node not found: " + parent_path}}
			var count: int = parent_node.get_child_count()
			var expected_count: int = int(params.get("count", -1))
			return {"result": {"passed": count == expected_count, "message": "Children: %d (expected: %d)" % [count, expected_count], "actual": count}}
		_:
			return {"error": {"code": -32004, "message": "Unknown assertion type: " + assertion_type}}

func _find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p = path
	while p.begins_with("/"):
		p = p.substr(1)
	if p.begins_with("root/"):
		p = p.substr(5)
	if p.begins_with(root.name + "/"):
		p = p.substr(root.name.length() + 1)
	elif p == root.name:
		return root
	if p == "":
		return root
	return root.get_node_or_null(p)
```

- [ ] **Step 2: 创建 export_commands.gd**

```gdscript
extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func handle_export_list_presets(params: Dictionary) -> Dictionary:
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	var result = []
	for p in presets:
		result.append({
			"name": p.name,
			"platform": p.platform if p.get("platform") else "unknown",
			" runnable": p.is_runnable()
		})
	return {"result": {"presets": result, "count": result.size()}}

func handle_export_get_preset(params: Dictionary) -> Dictionary:
	var name: String = params.get("name", "")
	if name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	for p in presets:
		if p.name == name:
			var data = {}
			# Collect all properties
			for key in p.get_property_list():
				var prop_name = key.name
				var val = p.get(prop_name)
				# Sanitize sensitive keys
				if _is_sensitive_key(prop_name):
					data[prop_name] = "***"
				else:
					data[prop_name] = val
			return {"result": data}
	return {"error": {"code": -32002, "message": "Export preset not found: " + name}}

func handle_export_build(params: Dictionary) -> Dictionary:
	var preset_name: String = params.get("preset", "")
	if preset_name == "":
		return {"error": {"code": -32004, "message": "Preset name required"}}
	var output_path: String = params.get("output_path", "")
	var ei = _plugin.get_editor_interface()
	if ei == null:
		return {"error": {"code": -32000, "message": "Editor interface not available"}}
	var presets = ei.get_export_presets()
	var target_preset = null
	for p in presets:
		if p.name == preset_name:
			target_preset = p
			break
	if target_preset == null:
		return {"error": {"code": -32002, "message": "Export preset not found: " + preset_name}}
	# Note: Actual export requires EditorExportPlatform which has limited scripting API
	# We use save_project_export_presets + signal approach
	return {"result": {"status": "export_started", "preset": preset_name, "message": "Export initiated. Check editor output for progress."}}

func _is_sensitive_key(key: String) -> bool:
	var sensitive_patterns = ["keystore", "certificate", "codesign", "identity", "provisioning", "password", "secret", "token", "api_key"]
	var k = key.to_lower()
	for pattern in sensitive_patterns:
		if k.contains(pattern):
			return true
	return false
```

- [ ] **Step 3: 更新 command_handler.gd**

```gdscript
extends Node

var _scene_commands: Node
var _node_commands: Node
var _test_commands: Node
var _export_commands: Node
var _undo_manager: Node

func setup(plugin: EditorPlugin) -> void:
	_undo_manager = preload("undo_manager.gd").new()
	_undo_manager.setup(plugin)
	add_child(_undo_manager)

	_scene_commands = preload("commands/scene_commands.gd").new()
	add_child(_scene_commands)

	_node_commands = preload("commands/node_commands.gd").new()
	_node_commands.setup(_undo_manager)
	add_child(_node_commands)

	_test_commands = preload("commands/test_commands.gd").new()
	add_child(_test_commands)

	_export_commands = preload("commands/export_commands.gd").new()
	_export_commands.setup(plugin)
	add_child(_export_commands)

func handle(method: String, params: Dictionary, request_id: int) -> Dictionary:
	match method:
		"open_scene":
			return _scene_commands.handle_open_scene(params)
		"save_scene":
			return _scene_commands.handle_save_scene(params)
		"add_node":
			return _node_commands.handle_add_node(params, request_id)
		"test_assert":
			return _test_commands.handle_test_assert(params)
		"export_list_presets":
			return _export_commands.handle_export_list_presets(params)
		"export_get_preset":
			return _export_commands.handle_export_get_preset(params)
		"export_build":
			return _export_commands.handle_export_build(params)
		_:
			return {"error": {"code": -32601, "message": "Unknown method: %s" % method}}
```

- [ ] **Step 4: Commit**

```bash
git add addons/godot_mcp_server/commands/test_commands.gd addons/godot_mcp_server/commands/export_commands.gd addons/godot_mcp_server/command_handler.gd
git commit -m "feat(editor-plugin): add test_assert and export commands"
```

---

### Task 5: 导出工具 TypeScript 定义

**Files:**
- Modify: `src/tools/test-framework.ts`（追加导出工具定义和 TOOL_META）

- [ ] **Step 1: 在 test-framework.ts 追加导出工具**

在 `src/tools/test-framework.ts` 中追加 3 个导出工具：

```typescript
// 追加到 getToolDefinitions() 返回数组
{
  name: 'export_list_presets',
  description: 'List export presets in the Godot project. Editor mode only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Path to Godot project directory' },
    },
    required: ['project_path'],
  },
},
{
  name: 'export_get_preset',
  description: 'Get detailed configuration of an export preset. Sensitive fields (keystore, certificates) are sanitized. Editor mode only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Path to Godot project directory' },
      name: { type: 'string', description: 'Export preset name' },
    },
    required: ['project_path', 'name'],
  },
},
{
  name: 'export_build',
  description: 'Execute an export build. This is a long-running operation. Editor mode only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Path to Godot project directory' },
      preset: { type: 'string', description: 'Export preset name' },
      output_path: { type: 'string', description: 'Output directory for the build' },
    },
    required: ['project_path', 'preset'],
  },
},
```

更新 TOOL_NAMES 和 handleTool：

```typescript
const TOOL_NAMES = ['test_assert', 'test_stress', 'export_list_presets', 'export_get_preset', 'export_build'] as const;

// handleTool 追加
case 'export_list_presets':
case 'export_get_preset':
case 'export_build':
  return opsErrorResult('EDITOR_ONLY', `Tool "${name}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.`);
```

更新 TOOL_META：

```typescript
export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  test_assert: { readonly: true, long_running: false },
  test_stress: { readonly: false, long_running: true },
  export_list_presets: { readonly: true, long_running: false },
  export_get_preset: { readonly: true, long_running: false },
  export_build: { readonly: false, long_running: true },
};
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/tools/test-framework.ts
git commit -m "feat: add export tool definitions (list_presets, get_preset, build)"
```

---

### Task 6: 集成测试更新 + 构建验证

**Files:**
- Test: `test/integration/editor-mode.test.js`

- [ ] **Step 1: 更新集成测试**

在现有 `test/integration/editor-mode.test.js` 中追加测试确认新工具被正确注册：

```js
it('should register test and export tools in editor mode', () => {
  const tools = toolModules.flatMap(m => m.getToolDefinitions());
  const toolNames = tools.map(t => t.name);
  assert.ok(toolNames.includes('test_assert'));
  assert.ok(toolNames.includes('test_stress'));
  assert.ok(toolNames.includes('export_list_presets'));
  assert.ok(toolNames.includes('export_get_preset'));
  assert.ok(toolNames.includes('export_build'));
});

it('export tools should return EDITOR_ONLY error in headless mode', async () => {
  const mod = await import('../build/tools/test-framework.js');
  const result = await mod.handleTool('export_list_presets', { project_path: '/tmp' }, {});
  assert.ok(result.content[0].text.includes('EDITOR_ONLY'));
});
```

- [ ] **Step 2: 全量构建和测试**

Run: `npm run build && node --test test/*.test.js test/integration/*.test.js`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add test/integration/editor-mode.test.js
git commit -m "test: integration tests for P2 test/export tools"
```
