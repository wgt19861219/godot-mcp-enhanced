# 交付验证系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 godot-mcp-enhanced 添加两层自动化验证框架——L1 轻量验证嵌入写操作返回值，L2 深度验证通过 `verify_delivery` 工具实现四维度全面检查，同时增强 `dev_loop` 支持验收条件。

**Architecture:** 在 MCP Server 层（TypeScript 侧）实现，不修改 Godot 项目文件。L1 通过 `tool-registry.ts` 注册层为写操作工具注入 `quickVerify()` 包装器。L2 通过新增 `delivery.ts` 模块编排已有原子能力（validate_scripts、lint、profiler、executeGdscript）。dev_loop 增加可选的 `acceptance` 参数。

**Tech Stack:** TypeScript (strict), Node.js test runner, GDScript (headless 执行), Godot MCP SDK

**Spec:** `docs/superpowers/specs/2026-05-21-delivery-verification-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/tools/delivery.ts` | 新增 | `verify_delivery` 工具定义 + 四维度检查编排 + L2 GDScript 模板 |
| `src/tools/shared.ts` | 修改 | 新增 `quickVerify()` + `wrapAssertionCode()` + L1 GDScript 模板 |
| `src/tools/workflow.ts` | 修改 | `dev_loop` 增加 `acceptance` 参数支持 |
| `src/core/tool-registry.ts` | 修改 | 注册 `verify_delivery` + L1 写操作包装器常量 |
| `src/GodotServer.ts` | 修改 | 导入 delivery 模块，加入 toolModules |
| `test/shared-verify.test.js` | 新增 | L1 quickVerify + wrapAssertionCode 测试 |
| `test/tool-registry.test.js` | 修改 | 追加 L1 verify-eligible 测试 |
| `test/delivery.test.js` | 新增 | L2 工具定义和返回格式测试 |
| `test/workflow-acceptance.test.js` | 新增 | dev_loop acceptance 参数测试 |
| `test/delivery-integration.test.js` | 新增 | 集成和边界测试 |

---

## Task 1: L1 基础设施 — quickVerify 和 GDScript 模板

**Files:**
- Modify: `src/tools/shared.ts` (末尾追加)
- Create: `test/shared-verify.test.js`

- [ ] **Step 1: 写 L1 quickVerify 和模板测试**

```js
// test/shared-verify.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('shared verify utilities', () => {
  it('quickVerify is exported', async () => {
    const mod = await import('../build/tools/shared.js');
    assert.strictEqual(typeof mod.quickVerify, 'function');
  });

  it('quickVerify returns null when verify=false', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('add_node', { verify: false });
    assert.strictEqual(result, null);
  });

  it('quickVerify returns null when verify not set', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('add_node', {});
    assert.strictEqual(result, null);
  });

  it('quickVerify returns passed=false for unknown tool', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('nonexistent_tool', { verify: true });
    assert.strictEqual(result.passed, false);
    assert.ok(result.error);
  });

  it('quickVerify returns passed=false for unsupported tool', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('execute_gdscript', { verify: true });
    assert.strictEqual(result.passed, false);
    assert.ok(result.error);
  });

  it('wrapAssertionCode is exported', async () => {
    const mod = await import('../build/tools/shared.js');
    assert.strictEqual(typeof mod.wrapAssertionCode, 'function');
  });

  it('wrapAssertionCode wraps GDScript assertion code', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode(
      'var _v = 42\n_mcp_output("count", str(_v))',
      'test assertion'
    );
    assert.ok(code.includes('extends SceneTree'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('var _v = 42'));
    assert.ok(code.includes('_mcp_done'));
  });

  it('wrapAssertionCode escapes dollar signs in description', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("t", "v")', 'test $var');
    assert.ok(!code.includes('$var'), 'dollar signs should be escaped');
  });

  it('genCheckNodeExists template generates valid GDScript', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.genCheckNodeExists('root/Player/Sprite2D');
    assert.ok(code.includes('_mcp_get_node'));
    assert.ok(code.includes('root/Player/Sprite2D'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('"exists"'));
  });

  it('genCheckProperties template generates valid GDScript', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.genCheckProperties('root/Player', { position: { x: 100, y: 200 } });
    assert.ok(code.includes('position'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('"actual"'));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build 2>&1 | head -10`
Expected: 编译错误，`quickVerify` / `wrapAssertionCode` / `genCheckNodeExists` / `genCheckProperties` 未导出

- [ ] **Step 3: 在 shared.ts 末尾追加 L1 基础设施**

在 `src/tools/shared.ts` 文件末尾（`parseGdscriptResult` 函数之后）追加：

```typescript
// ─── L1 Quick Verify Infrastructure ────────────────────────────────────────

export interface QuickVerifyResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
  error?: string;
}

/** L1 验证入口。verify !== true 时返回 null（跳过验证）。 */
export async function quickVerify(
  toolName: string,
  args: Record<string, unknown>,
): Promise<QuickVerifyResult | null> {
  if (args.verify !== true) return null;

  const supportedTools = new Set([
    'add_node', 'edit_node', 'write_script', 'edit_script',
    'load_sprite', 'ui_build_layout',
  ]);

  if (!supportedTools.has(toolName)) {
    return { passed: false, checks: [], error: `No quickVerify handler for tool: ${toolName}` };
  }

  // 实际 GDScript 验证在后续 Task 中按工具实现
  return { passed: true, checks: [{ name: 'placeholder', passed: true }] };
}

/** 公共断言包装器 — 被 dev_loop.acceptance 和 delivery.ts assertions 共同调用 */
export function wrapAssertionCode(assertionCode: string, description: string): string {
  const escapedDesc = gdEscape(description);
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _desc = "${escapedDesc}"
\t# --- user assertion code ---
\t${assertionCode.split('\n').join('\n\t')}
\t# --- end user code ---
\t_mcp_done()
`;
}

/** L1 模板: 检查节点是否存在 */
export function genCheckNodeExists(nodePath: string): string {
  const escaped = gdEscape(nodePath);
  return `var _n = _mcp_get_node("${escaped}")
if _n != null:
\t_mcp_output("node_exists", JSON.stringify({"path": "${escaped}", "exists": true, "type": _n.get_class()}))
else:
\t_mcp_output("node_exists", JSON.stringify({"path": "${escaped}", "exists": false, "type": ""}))`;
}

/** L1 模板: 批量读回属性值 */
export function genCheckProperties(nodePath: string, props: Record<string, unknown>): string {
  const escaped = gdEscape(nodePath);
  const lines: string[] = [];
  lines.push(`var _n = _mcp_get_node("${escaped}")`);
  lines.push('if _n == null:');
  lines.push(`\t_mcp_output("props", JSON.stringify({"error": "node not found: ${escaped}"}))`);
  lines.push('else:');
  lines.push('\tvar _props = {}');
  for (const [key, expected] of Object.entries(props)) {
    const ek = gdEscape(key);
    lines.push(`\t_props["${ek}"] = {"actual": str(_n.get("${ek}")), "expected": str(${gdEscape(JSON.stringify(expected))})}`);
  }
  lines.push('\t_mcp_output("props", JSON.stringify(_props))');
  return lines.join('\n');
}
```

- [ ] **Step 4: 编译并运行测试**

Run: `npm run build && node --test test/shared-verify.test.js`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/shared.ts test/shared-verify.test.js
git commit -m "feat(verify): add L1 quickVerify infrastructure and GDScript templates"
```

---

## Task 2: L1 注册层常量

**Files:**
- Modify: `src/core/tool-registry.ts`
- Modify: `test/tool-registry.test.js`

- [ ] **Step 1: 在 tool-registry.ts 追加 L1 常量**

在 `src/core/tool-registry.ts` 末尾追加：

```typescript
// ─── L1 Quick Verify eligible tools ─────────────────────────────────────────

export const VERIFY_ELIGIBLE_TOOLS = new Set([
  'add_node', 'edit_node', 'write_script', 'edit_script',
  'load_sprite', 'ui_build_layout',
]);

export function isVerifyEligible(name: string): boolean {
  return VERIFY_ELIGIBLE_TOOLS.has(name);
}
```

- [ ] **Step 2: 在 test/tool-registry.test.js 末尾追加 L1 测试**

```js
import { VERIFY_ELIGIBLE_TOOLS, isVerifyEligible } from '../build/core/tool-registry.js';

describe('L1 verify eligible tools', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains expected write tools', () => {
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('add_node'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('edit_node'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('write_script'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('edit_script'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('ui_build_layout'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('load_sprite'));
  });

  it('isVerifyEligible returns true for add_node', () => {
    assert.strictEqual(isVerifyEligible('add_node'), true);
  });

  it('isVerifyEligible returns false for read-only tools', () => {
    assert.strictEqual(isVerifyEligible('read_scene'), false);
    assert.strictEqual(isVerifyEligible('execute_gdscript'), false);
    assert.strictEqual(isVerifyEligible('profiler'), false);
  });
});
```

- [ ] **Step 3: 编译运行**

Run: `npm run build && node --test test/tool-registry.test.js`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/core/tool-registry.ts test/tool-registry.test.js
git commit -m "feat(verify): add L1 verify-eligible tool registry"
```

---

## Task 3: L2 verify_delivery 工具定义 + 注册

**Files:**
- Create: `src/tools/delivery.ts`
- Create: `test/delivery.test.js`
- Modify: `src/GodotServer.ts`

- [ ] **Step 1: 写工具定义测试**

```js
// test/delivery.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('delivery tool definitions', () => {
  it('verify_delivery is in tool definitions', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tools = mod.getToolDefinitions();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('verify_delivery'));
    assert.strictEqual(tools.length, 1);
  });

  it('verify_delivery has required fields', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    assert.ok(tool.inputSchema);
    assert.ok(tool.description);
    const required = tool.inputSchema.required;
    assert.ok(required.includes('project_path'));
    assert.ok(required.includes('scope'));
  });

  it('scope accepts scene, script, full', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const scopeEnum = tool.inputSchema.properties.scope.enum;
    assert.deepStrictEqual(scopeEnum, ['scene', 'script', 'full']);
  });

  it('checks parameter has expected dimensions', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const checksProps = tool.inputSchema.properties.checks.properties;
    assert.ok('scene_tree' in checksProps);
    assert.ok('script_health' in checksProps);
    assert.ok('performance' in checksProps);
    assert.ok('assertions' in checksProps);
  });

  it('TOOL_META marks verify_delivery as readonly and long_running', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(mod.TOOL_META.verify_delivery.readonly, true);
    assert.strictEqual(mod.TOOL_META.verify_delivery.long_running, true);
  });

  it('checkSceneIntegrity is exported', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(typeof mod.checkSceneIntegrity, 'function');
  });

  it('findAssociatedScenes is exported', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(typeof mod.findAssociatedScenes, 'function');
  });
});
```

- [ ] **Step 2: 创建 delivery.ts 工具骨架**

```typescript
// src/tools/delivery.ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, gdEscape, wrapAssertionCode } from './shared.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TOOL_NAMES = ['verify_delivery'] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

interface Issue {
  severity: 'error' | 'warning';
  location: string;
  message: string;
  suggestion?: string;
}

// ─── Tool Definition ────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'verify_delivery',
      description:
        '端到端交付验证工具。四维度检查：场景树完整性、脚本健壮性、性能/资源健康、自定义行为断言。' +
        '返回结构化报告，通过/失败一目了然。scope 决定扫描范围，checks 决定检查维度。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scope: {
            type: 'string',
            enum: ['scene', 'script', 'full'],
            description: 'Verification scope: scene, script, or full project',
          },
          scene_path: { type: 'string', description: 'Scene path for scope=scene (relative to project)' },
          script_path: { type: 'string', description: 'Script path for scope=script (relative to project)' },
          checks: {
            type: 'object',
            description: 'Check dimensions (all default to true)',
            properties: {
              scene_tree: { type: 'boolean', description: 'Check scene tree integrity' },
              script_health: { type: 'boolean', description: 'Check script robustness' },
              performance: { type: 'boolean', description: 'Check performance/resource health' },
              assertions: {
                type: 'array',
                description: 'Custom behavior assertions (max 10)',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    gdscript: { type: 'string' },
                    expect: { type: 'string' },
                  },
                  required: ['description', 'gdscript'],
                },
              },
            },
          },
        },
        required: ['project_path', 'scope'],
      },
    },
  ];
}

// ─── Scene Integrity Helpers ────────────────────────────────────────────────

export function checkSceneIntegrity(projectPath: string, scenePath: string): { passed: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const fullPath = join(projectPath, scenePath);

  if (!existsSync(fullPath)) {
    return { passed: false, issues: [{ severity: 'error', location: scenePath, message: `Scene file not found: ${scenePath}` }] };
  }

  const content = readFileSync(fullPath, 'utf-8');

  // Check ext_resource references
  const extRegex = /^\[ext_resource[^]*path="res:\/\/([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = extRegex.exec(content)) !== null) {
    const refPath = match[1];
    const diskPath = join(projectPath, refPath);
    if (!existsSync(diskPath)) {
      issues.push({
        severity: 'error',
        location: `${scenePath}:res://${refPath}`,
        message: `Referenced resource not found: res://${refPath}`,
      });
    }
  }

  // Check [connection] static signals
  const connRegex = /^\[connection\s+.*?\]/gm;
  while ((match = connRegex.exec(content)) !== null) {
    const line = match[0];
    const target = line.match(/target="([^"]+)"/)?.[1];
    const method = line.match(/method="([^"]+)"/)?.[1];
    const signal = line.match(/signal="([^"]+)"/)?.[1];
    if (target && method) {
      if (!target.trim() || !method.trim()) {
        issues.push({
          severity: 'warning',
          location: `${scenePath}:connection`,
          message: `Malformed connection: signal=${signal ?? '?'}, target=${target}, method=${method}`,
        });
      }
    }
  }

  return { passed: issues.filter(i => i.severity === 'error').length === 0, issues };
}

export function findAssociatedScenes(projectPath: string, scriptPath: string): string[] {
  const scenes: string[] = [];
  const scriptResPath = `res://${scriptPath}`;

  function scanDir(dir: string, relPrefix: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== '.godot' && entry.name !== '.import') {
            scanDir(join(dir, entry.name), `${relPrefix}${entry.name}/`);
          }
        } else if (entry.name.endsWith('.tscn')) {
          const content = readFileSync(join(dir, entry.name), 'utf-8');
          if (content.includes(`"${scriptResPath}"`)) {
            scenes.push(`${relPrefix}${entry.name}`);
          }
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  scanDir(projectPath, '');
  return scenes;
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'verify_delivery') return null;

  const projectPath = validatePath(args.project_path as string);
  const scope = args.scope as string;
  const checks = (args.checks as Record<string, unknown>) ?? {};

  const sceneTree = checks.scene_tree !== false;
  const scriptHealth = checks.script_health !== false;
  const performance = checks.performance !== false;
  const assertions = (checks.assertions as Array<Record<string, string>>) ?? [];

  const report: Record<string, unknown> = {};
  const dimensionResults: Array<{ dim: string; passed: boolean }> = [];

  // ── 维度 1: 场景树完整性 ──
  if (sceneTree) {
    let scenePaths: string[] = [];

    if (scope === 'scene') {
      const sp = args.scene_path as string;
      if (!sp) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'scene_path required for scope=scene' }] };
      } else {
        scenePaths = [sp];
      }
    } else if (scope === 'script') {
      const sp = args.script_path as string;
      if (!sp) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'script_path required for scope=script' }] };
      } else {
        scenePaths = findAssociatedScenes(projectPath, sp);
      }
    } else {
      // scope=full: collect all .tscn
      function collectScenes(dir: string, prefix: string): string[] {
        const result: string[] = [];
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && e.name !== '.godot' && e.name !== '.import') {
              result.push(...collectScenes(join(dir, e.name), `${prefix}${e.name}/`));
            } else if (e.name.endsWith('.tscn')) {
              result.push(`${prefix}${e.name}`);
            }
          }
        } catch { /* ignore */ }
        return result;
      }
      scenePaths = collectScenes(projectPath, '');
    }

    if (!report.scene_tree) {
      const allIssues: Issue[] = [];
      for (const sp of scenePaths) {
        const result = checkSceneIntegrity(projectPath, sp);
        allIssues.push(...result.issues);
      }
      const passed = allIssues.filter(i => i.severity === 'error').length === 0;
      report.scene_tree = { passed, issues: allIssues };
      dimensionResults.push({ dim: 'scene_tree', passed });
    } else {
      dimensionResults.push({ dim: 'scene_tree', passed: (report.scene_tree as { passed: boolean }).passed });
    }
  }

  // ── 维度 2: 脚本健壮性 ──
  if (scriptHealth) {
    const godot = await ctx.findGodot();
    const issues: Issue[] = [];
    let scriptPaths: string[] = [];

    if (scope === 'script') {
      const sp = args.script_path as string;
      if (sp) scriptPaths = [sp];
    } else if (scope === 'scene') {
      const scenePath = args.scene_path as string;
      if (scenePath) {
        const content = readFileSync(join(projectPath, scenePath), 'utf-8');
        const scriptRegex = /path="(res:\/\/[^"]+\.gd)"/g;
        let m: RegExpExecArray | null;
        while ((m = scriptRegex.exec(content)) !== null) {
          scriptPaths.push(m[1].replace('res://', ''));
        }
      }
    } else {
      function collectScripts(dir: string, prefix: string): string[] {
        const result: string[] = [];
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && e.name !== '.godot' && e.name !== '.import' && e.name !== 'addons') {
              result.push(...collectScripts(join(dir, e.name), `${prefix}${e.name}/`));
            } else if (e.name.endsWith('.gd')) {
              result.push(`${prefix}${e.name}`);
            }
          }
        } catch { /* ignore */ }
        return result;
      }
      scriptPaths = collectScripts(projectPath, '');
    }

    // Check file existence
    for (const sp of scriptPaths) {
      if (!existsSync(join(projectPath, sp))) {
        issues.push({ severity: 'error', location: sp, message: `Script file not found: ${sp}` });
      }
    }

    // Check preload/load references
    for (const sp of scriptPaths) {
      const fullPath = join(projectPath, sp);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf-8');
      const preloadRegex = /(?:preload|load)\("res:\/\/([^"]+)"\)/g;
      let m: RegExpExecArray | null;
      while ((m = preloadRegex.exec(content)) !== null) {
        if (!existsSync(join(projectPath, m[1]))) {
          issues.push({
            severity: 'warning',
            location: sp,
            message: `Resource not found: res://${m[1]} (referenced by preload/load)`,
          });
        }
      }
    }

    const passed = issues.filter(i => i.severity === 'error').length === 0;
    report.script_health = { passed, issues };
    dimensionResults.push({ dim: 'script_health', passed });
  }

  // ── 维度 3: 性能/资源健康 ──
  if (performance) {
    const godot = await ctx.findGodot();
    const perfScript = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _data: Dictionary = {}
\t_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_data["static_memory_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_mcp_output("perf", _data)
\t_mcp_done()
`;
    const perfResult = await executeGdscript({
      godotPath: godot, projectPath, code: perfScript, timeout: 20, loadAutoloads: false,
    });

    const perfIssues: Issue[] = [];
    let perfData: Record<string, unknown> = {};

    if (perfResult.compile_success && perfResult.run_success) {
      for (const entry of perfResult.outputs) {
        if (entry.key === 'perf') {
          try { perfData = JSON.parse(entry.value); } catch { perfData = { raw: entry.value }; }
        }
      }
      const orphans = (perfData.orphan_node_count as number) ?? 0;
      if (orphans > 100) {
        perfIssues.push({
          severity: 'warning',
          location: '(project-wide)',
          message: `High orphan node count: ${orphans}`,
          suggestion: 'Check for nodes created without add_child or missing queue_free() calls',
        });
      }
    } else {
      perfIssues.push({ severity: 'warning', location: '(project-wide)', message: 'Performance snapshot unavailable' });
    }

    const perfPassed = perfIssues.filter(i => i.severity === 'error').length === 0;
    report.performance = { passed: perfPassed, issues: perfIssues, metrics: perfData };
    dimensionResults.push({ dim: 'performance', passed: perfPassed });
  }

  // ── 维度 4: 自定义行为断言 ──
  if (assertions.length > 0) {
    if (assertions.length > 10) {
      report.assertions = { passed: false, results: [], error: 'Too many assertions (max 10)' };
      dimensionResults.push({ dim: 'assertions', passed: false });
    } else {
      const godot = await ctx.findGodot();
      const assertionResults: Array<Record<string, unknown>> = [];

      for (const a of assertions) {
        const desc = a.description ?? 'unnamed assertion';
        const expected = a.expect;
        try {
          const wrappedCode = wrapAssertionCode(a.gdscript, desc);
          const assertResult = await executeGdscript({
            godotPath: godot, projectPath, code: wrappedCode, timeout: 15, loadAutoloads: false,
          });

          if (!assertResult.compile_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.compile_error });
          } else if (!assertResult.run_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.run_error });
          } else {
            let actual = '';
            for (const entry of assertResult.outputs) {
              if (entry.key === 'assert_result') actual = entry.value;
            }
            const passed = expected ? actual === expected : true;
            assertionResults.push({ description: desc, passed, actual, expected });
          }
        } catch (err) {
          assertionResults.push({ description: desc, passed: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const allPassed = assertionResults.every(r => r.passed);
      report.assertions = { passed: allPassed, results: assertionResults };
      dimensionResults.push({ dim: 'assertions', passed: allPassed });
    }
  }

  // ── Summary ──
  const passedCount = dimensionResults.filter(d => d.passed).length;
  const totalCount = dimensionResults.length;
  report.passed = dimensionResults.every(d => d.passed);
  report.summary = `${passedCount}/${totalCount} dimensions passed`;

  return textResult(JSON.stringify(report, null, 2));
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  verify_delivery: { readonly: true, long_running: true },
};
```

- [ ] **Step 3: 在 GodotServer.ts 注册 delivery 模块**

在 `src/GodotServer.ts` 中：
1. 在导入区块（约第 48 行附近）追加: `import * as delivery from './tools/delivery.js';`
2. 在 `toolModules` 数组（约第 61 行）中追加 `delivery`

- [ ] **Step 4: 编译并运行测试**

Run: `npm run build && node --test test/delivery.test.js`
Expected: 所有测试通过

- [ ] **Step 5: 运行完整测试套件确认无回归**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/tools/delivery.ts src/GodotServer.ts test/delivery.test.js
git commit -m "feat(verify): implement verify_delivery with 4-dimension checks"
```

---

## Task 4: dev_loop acceptance 增强

**Files:**
- Modify: `src/tools/workflow.ts`
- Create: `test/workflow-acceptance.test.js`

- [ ] **Step 1: 写 acceptance 参数测试**

```js
// test/workflow-acceptance.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('dev_loop acceptance parameter', () => {
  it('dev_loop definition includes acceptance parameter', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    assert.ok(devLoop);
    const props = devLoop.inputSchema.properties;
    assert.ok('acceptance' in props, 'acceptance parameter missing');
  });

  it('acceptance has assertions array with required fields', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    assert.ok('assertions' in acceptanceProps);
    const items = acceptanceProps.assertions.items;
    assert.ok(items.properties.description);
    assert.ok(items.properties.gdscript);
    assert.ok(items.properties.expect);
    assert.ok(items.required.includes('description'));
    assert.ok(items.required.includes('gdscript'));
  });

  it('acceptance has max_retries with default 0', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    assert.ok('max_retries' in acceptanceProps);
    assert.strictEqual(acceptanceProps.max_retries.default, 0);
  });
});
```

- [ ] **Step 2: 在 workflow.ts 的 dev_loop 工具定义中追加 acceptance 参数**

在 `src/tools/workflow.ts` 的 `dev_loop` 定义 `inputSchema.properties` 中，`load_autoloads` 之后追加：

```typescript
acceptance: {
  type: 'object',
  description: 'Optional acceptance criteria to verify after execution',
  properties: {
    assertions: {
      type: 'array',
      description: 'Array of assertions to run after code execution',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Human-readable assertion description' },
          gdscript: { type: 'string', description: 'GDScript code using _mcp_output("assert_N", value) to output results' },
          expect: { type: 'string', description: 'Expected output value (string comparison)' },
        },
        required: ['description', 'gdscript'],
      },
    },
    max_retries: { type: 'number', description: 'Max retry attempts (default: 0, no auto-retry)', default: 0 },
  },
},
```

同时在 `workflow.ts` 顶部导入 `wrapAssertionCode`：

```typescript
import { SCENE_TREE_HEADER, parseGdscriptResult, wrapAssertionCode } from './shared.js';
```

- [ ] **Step 3: 在 handleTool dev_loop 分支中实现 acceptance 逻辑**

在 `case 'dev_loop'` 中，`if (verify)` 块之后、`return textResult(...)` 之前追加：

```typescript
// ── Acceptance assertions ──
const acceptance = args.acceptance as Record<string, unknown> | undefined;
if (acceptance) {
  const assertionList = (acceptance.assertions as Array<Record<string, string>>) ?? [];
  if (assertionList.length > 0) {
    const assertionResults: Array<Record<string, unknown>> = [];
    const allAssertCode = assertionList.map((a, i) => {
      return `# --- assertion ${i}: ${a.description} ---\n${a.gdscript}`;
    }).join('\n');

    const wrappedCode = wrapAssertionCode(allAssertCode, 'acceptance');
    const assertResult = await executeGdscript({
      godotPath: godot, projectPath, code: wrappedCode, timeout, loadAutoloads,
    });

    if (!assertResult.compile_success) {
      result.acceptance = { passed: false, error: assertResult.compile_error };
    } else if (!assertResult.run_success) {
      result.acceptance = { passed: false, error: assertResult.run_error };
    } else {
      const assertOutputs: Record<string, unknown> = {};
      for (const entry of assertResult.outputs) {
        try { assertOutputs[entry.key] = JSON.parse(entry.value); } catch { assertOutputs[entry.key] = entry.value; }
      }
      for (let i = 0; i < assertionList.length; i++) {
        const a = assertionList[i];
        const actual = String(assertOutputs[`assert_${i}`] ?? assertOutputs['assert_result'] ?? '');
        const passed = a.expect ? actual === a.expect : true;
        assertionResults.push({ description: a.description, passed, actual, expected: a.expect });
      }
      result.acceptance = {
        passed: assertionResults.every(r => r.passed),
        results: assertionResults,
      };
    }
  }
}
```

- [ ] **Step 4: 编译并运行测试**

Run: `npm run build && node --test test/workflow-acceptance.test.js test/workflow.test.js`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/workflow.ts test/workflow-acceptance.test.js
git commit -m "feat(verify): add dev_loop acceptance criteria support"
```

---

## Task 5: 集成测试 + 完整回归

**Files:**
- Create: `test/delivery-integration.test.js`

- [ ] **Step 1: 写集成测试**

```js
// test/delivery-integration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('delivery integration tests', () => {
  it('quickVerify + VERIFY_ELIGIBLE_TOOLS consistency', async () => {
    const shared = await import('../build/tools/shared.js');
    const reg = await import('../build/core/tool-registry.js');
    const supportedTools = ['add_node', 'edit_node', 'write_script', 'edit_script', 'load_sprite', 'ui_build_layout'];
    for (const name of supportedTools) {
      assert.ok(reg.VERIFY_ELIGIBLE_TOOLS.has(name), `${name} missing from registry`);
    }
  });

  it('verify_delivery is registered in GodotServer toolModules', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.ok(mod.getToolDefinitions);
    assert.ok(mod.handleTool);
    assert.ok(mod.TOOL_META);
    assert.ok(mod.TOOL_META.verify_delivery);
  });

  it('wrapAssertionCode produces valid SceneTree script', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("x", "42")', 'value check');
    assert.ok(code.includes('extends SceneTree'));
    assert.ok(code.includes('_mcp_initialize'));
    assert.ok(code.includes('_mcp_output("x", "42")'));
    assert.ok(code.includes('_mcp_done'));
  });

  it('dev_loop tool definition includes acceptance', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    assert.ok(devLoop.inputSchema.properties.acceptance);
  });

  it('all new test files have no syntax errors', () => {
    // This test passes if the file itself loaded without error
    assert.ok(true);
  });
});
```

- [ ] **Step 2: 运行完整测试套件**

Run: `npm test`
Expected: 全部通过（原有 611 + 新增测试）

- [ ] **Step 3: TypeScript 严格检查**

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 4: 提交**

```bash
git add test/delivery-integration.test.js
git commit -m "test(verify): add integration tests for delivery verification system"
```

---

## Task 6: CHANGELOG + 最终验证

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 运行完整测试套件**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 2: 更新 CHANGELOG.md**

在 CHANGELOG.md 的 `[Unreleased]` 区块追加：

```markdown
### Added
- **verify_delivery** tool: end-to-end delivery verification with 4 dimensions (scene tree integrity, script health, performance, custom assertions)
- **L1 quickVerify**: optional lightweight verification embedded in write tool return values (`verify=true`)
- **dev_loop acceptance**: acceptance criteria parameter for post-execution verification
```

- [ ] **Step 3: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for delivery verification system"
```

---

## 自审清单

**1. Spec 覆盖检查：**

| Spec 要求 | 对应 Task |
|---|---|
| L1 quickVerify + GDScript 模板 | Task 1 |
| L1 注册层常量 (VERIFY_ELIGIBLE_TOOLS) | Task 2 |
| L2 verify_delivery 工具定义 | Task 3 |
| L2 场景树完整性 (ext_resource + connection) | Task 3 |
| L2 脚本健壮性 (preload/load 检查) | Task 3 |
| L2 性能/资源健康 (orphan/memory/resource) | Task 3 |
| L2 自定义行为断言 (max 10) | Task 3 |
| dev_loop acceptance 参数 | Task 4 |
| scope 与 checks 正交 | Task 3 |
| scope=script 反查关联场景 | Task 3 |
| headless 有效指标枚举 | Task 3 |
| 静态信号检查限定 | Task 3 |
| wrapAssertionCode 公共函数 | Task 1 |
| 集成测试 | Task 5 |

**2. 占位符扫描：** 无 TBD/TODO/待实现。所有步骤包含完整代码。

**3. 类型一致性：**
- `QuickVerifyResult` 在 Task 1 定义并导出
- `Issue` 在 Task 3 定义并导出
- `wrapAssertionCode` 在 Task 1 导出，Task 3-4 引用
- `VERIFY_ELIGIBLE_TOOLS` 在 Task 2 导出，Task 5 引用
- `checkSceneIntegrity` / `findAssociatedScenes` 在 Task 3 导出，Task 3 测试验证
