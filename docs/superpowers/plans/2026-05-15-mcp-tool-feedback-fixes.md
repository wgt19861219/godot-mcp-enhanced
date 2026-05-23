# MCP 工具反馈修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 validate_scripts 误报 + 新增 quick_scene / batch_create_files / batch_run_verify / diff_scenes 五个工具

**Architecture:** validate_scripts 修复在现有 validation.ts 中扩展过滤器；quick_scene 加入 scene.ts 复用 .tscn 生成；三个批量工具放新建的 batch-tools.ts；GodotServer.ts 注册新模块。diff_scenes 为 P2。

**Tech Stack:** TypeScript, Node.js fs/path/child_process, Godot 4.4+ headless

---

### Task 1: validate_scripts 误报修复

**Files:**
- Modify: `src/tools/validation.ts:121-125` (isErrorFalsePositive 函数)
- Modify: `src/tools/validation.ts:46-60` (batchValidateScripts 返回结构)
- Modify: `src/tools/validation.ts:622-711` (validate_scripts handler)
- Modify: `src/tools/workflow.ts:171-209` (batch_validate handler)

- [ ] **Step 1: 添加 KNOWN_BASE_METHODS 常量**

在 `src/tools/validation.ts` 顶部（import 之后，`batchValidateScripts` 函数之前）添加：

```typescript
const KNOWN_BASE_METHODS: Set<string> = new Set([
  // Node 核心
  'add_child', 'remove_child', 'get_child', 'get_children', 'get_child_count',
  'get_parent', 'get_tree', 'get_node', 'find_child', 'find_children',
  'has_node', 'is_inside_tree', 'is_node_ready', 'queue_free', 'free',
  'call_deferred', 'set_deferred', 'emit_signal', 'connect', 'disconnect',
  'is_connected', 'get_name', 'set_name',
  // 生命周期
  '_ready', '_process', '_physics_process', '_input', '_unhandled_input',
  '_unhandled_key_input', '_enter_tree', '_exit_tree',
  // Node2D / Control
  'position', 'rotation', 'scale', 'visible', 'modulate', 'z_index',
  'get_global_mouse_position', 'get_viewport', 'get_viewport_rect',
  'set_process', 'set_physics_process', 'set_process_input',
  // CanvasItem 绘制
  'draw_rect', 'draw_circle', 'draw_string', 'draw_line', 'queue_redraw',
  'get_canvas_item', 'get_global_transform',
  // CharacterBody
  'move_and_slide', 'move_and_collide', 'velocity', 'floor',
  'is_on_floor', 'is_on_wall', 'is_on_ceiling',
  // PhysicsBody / RigidBody
  'linear_velocity', 'angular_velocity', 'mass', 'bounce', 'friction',
  'gravity_scale', 'apply_impulse', 'apply_force',
  // Navigation
  'get_rid', 'get_region',
  // Shader / Material
  'set_shader_parameter', 'canvas_item',
  // Timer
  'wait_time', 'autostart', 'one_shot',
  // Resource / Object
  'get_path', 'resource_path', 'get_resource', 'duplicate',
]);
```

- [ ] **Step 2: 重写 isErrorFalsePositive 函数**

替换 `src/tools/validation.ts` 中现有的 `isErrorFalsePositive` 函数（约第 121-125 行）：

```typescript
  const isErrorFalsePositive = (line: string): boolean => {
    // ScriptBus internal
    if (line.includes('not found in base self') && line.includes('ScriptBus')) return true;
    // Godot engine noise
    if (line.includes('Condition') && line.includes('is true')) return true;

    // 规则 1: 已知基类方法/属性 — "not found in base self" 但方法是合法继承的
    if (line.includes('not found in base self')) {
      for (const method of KNOWN_BASE_METHODS) {
        if (line.includes('.' + method) || line.includes(method + '(')) return true;
      }
    }

    // 规则 2: 虚拟方法签名不匹配 — _process/_ready 等重写签名差异
    if (/Parse Error.*\b(_ready|_process|_physics_process|_input|_unhandled_input|_enter_tree|_exit_tree)\b/.test(line)) {
      if (/signature|not found in base/.test(line)) return true;
    }

    return false;
  };
```

- [ ] **Step 3: 修改 batchValidateScripts 返回 filtered_count**

在 `batchValidateScripts` 函数中，修改过滤逻辑，统计过滤数量。将返回类型签名更新为包含 `filtered_count`：

```typescript
export interface BatchValidateResult {
  file: string;
  errors: string[];
  filtered_count?: number;
}
```

在解析循环中（`for (const line of outputLines)` 循环内），修改过滤计数逻辑：

```typescript
    let filteredCount = 0;
    let lastParseError = '';
    for (const line of outputLines) {
      const trimmed = line.trim();
      if (trimmed.includes('Parse Error:')) {
        if (isErrorFalsePositive(trimmed)) {
          filteredCount++;
          lastParseError = '';
        } else {
          lastParseError = trimmed;
        }
      } else if (trimmed.startsWith('at:') && trimmed.includes('res://') && lastParseError) {
        for (const rel of scriptRels) {
          const normalizedRel = rel.replace(/\\/g, '/');
          if (trimmed.includes('res://' + normalizedRel + ':')) {
            if (!results.has(rel)) results.set(rel, []);
            const errors = results.get(rel)!;
            if (!errors.includes(lastParseError)) {
              errors.push(lastParseError);
            }
            break;
          }
        }
        lastParseError = '';
      }
    }
```

在最终返回映射中第一个 result 对象上附加 filtered_count：

```typescript
  const finalResults = Array.from(results.entries()).map(([file, errors]) => ({ file, errors }));
  if (finalResults.length > 0 && filteredCount > 0) {
    finalResults[0].filtered_count = filteredCount;
  }
  if (filteredCount > 0 && finalResults.length === 0) {
    finalResults.push({ file: '<filtered>', errors: [], filtered_count: filteredCount });
  }
  return finalResults;
```

- [ ] **Step 4: 更新 validate_scripts handler 返回 filtered_count**

在 `validate_scripts` handler 中（约第 651 行），计算并输出总过滤数：

```typescript
      let totalFiltered = 0;
      for (const r of allBatchResults) {
        if ((r as any).filtered_count) totalFiltered += (r as any).filtered_count;
      }
```

在 `scriptsSummary` 对象中加入：

```typescript
      if (totalFiltered > 0) {
        scriptsSummary.filtered_count = totalFiltered;
      }
```

- [ ] **Step 5: 更新 workflow.ts 的 batch_validate handler**

在 `src/tools/workflow.ts` 的 `batch_validate` handler 中（约第 171-209 行），改为调用 `batchValidateScripts`：

在文件顶部添加 import：
```typescript
import { batchValidateScripts } from './validation.js';
```

替换 `batch_validate` case 的完整实现：

```typescript
    case 'batch_validate': {
      const projectPath = validatePath(args.project_path as string);
      const scripts = args.scripts as string[];

      if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
        return textResult('Error: "scripts" must be a non-empty array of file paths.');
      }

      const godot = await ctx.findGodot();
      const fullPaths: string[] = [];
      const missing: string[] = [];
      const pathSep = process.platform === 'win32' ? '\\' : '/';
      const relOf = (absPath: string) => absPath.replace(projectPath + pathSep, '');

      for (const s of scripts) {
        const full = join(projectPath, s);
        if (existsSync(full)) {
          fullPaths.push(full);
        } else {
          missing.push(s);
        }
      }

      const batchResults = await batchValidateScripts(godot, projectPath, fullPaths, 15000);

      const results: Record<string, unknown> = {};
      let allValid = true;
      let totalFiltered = 0;

      for (const r of batchResults) {
        const rel = r.file;
        results[rel] = r.errors.length > 0 ? { valid: false, error: r.errors } : { valid: true };
        if (r.errors.length > 0) allValid = false;
        if ((r as any).filtered_count) totalFiltered += (r as any).filtered_count;
      }
      for (const m of missing) {
        results[m] = { valid: false, error: 'File not found' };
        allValid = false;
      }

      const summary: Record<string, unknown> = { all_valid: allValid, total: scripts.length, results };
      if (totalFiltered > 0) summary.filtered_count = totalFiltered;

      return textResult(JSON.stringify(summary, null, 2));
    }
```

- [ ] **Step 6: 编译验证**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/tools/validation.ts src/tools/workflow.ts
git commit -m "fix: validate_scripts/batch_validate 误报过滤 — 继承链方法白名单 + filtered_count"
```

---

### Task 2: quick_scene 新工具

**Files:**
- Modify: `src/tools/scene.ts` (TOOL_NAMES, getToolDefinitions, handleTool, TOOL_META)

- [ ] **Step 1: 在 TOOL_NAMES 中添加 quick_scene**

在 `src/tools/scene.ts` 第 13-24 行的 TOOL_NAMES 数组中添加 `'quick_scene'`（在 `load_sprite` 之后）：

```typescript
const TOOL_NAMES = [
  'read_scene',
  'create_scene',
  'add_node',
  'save_scene',
  'load_sprite',
  'quick_scene',
  'batch_add_nodes',
  'query_scene_tree',
  'inspect_node',
  'edit_node',
  'remove_node',
] as const;
```

- [ ] **Step 2: 添加 quick_scene 工具定义**

在 `getToolDefinitions()` 数组中（`load_sprite` 之后、`query_scene_tree` 之前）添加：

```typescript
    {
      name: 'quick_scene',
      description: 'Create a complete scene with optional script attachment in one step. '
        + 'Generates .tscn with root node, ext_resource reference, and optionally creates the .gd script file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project (e.g. res://scenes/player.tscn)' },
          script_path: { type: 'string', description: 'Script path relative to project (e.g. res://scripts/player.gd). Optional.' },
          root_node_type: { type: 'string', description: 'Root node type (default: Node2D)', default: 'Node2D' },
          root_node_name: { type: 'string', description: 'Root node name (default: derived from scene filename via PascalCase)' },
          script_content: { type: 'string', description: 'If provided and script does not exist, creates the .gd file with this content' },
        },
        required: ['project_path', 'scene_path'],
      },
    },
```

- [ ] **Step 3: 添加 quick_scene handler**

在 `handleTool` 函数的 switch 中，在 `case 'load_sprite'` 的闭合大括号之后、`case 'query_scene_tree'` 之前添加一个新的 case：

```typescript
    case 'quick_scene': {
      const p = validatePath(args.project_path as string);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;

      // 推导根节点名: PascalCase (tween_demo -> TweenDemo)
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) {
        const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, '');
        rootNodeName = baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
      }

      const sceneAbsPath = resolveWithinRoot(p, sceneRelPath);
      ensureDir(sceneAbsPath);

      // 生成 .tscn 内容
      let tscnContent: string;
      if (scriptRelPath) {
        tscnContent = [
          '[gd_scene load_steps=2 format=3]',
          '',
          `[ext_resource type="Script" path="res://${scriptRelPath.replace(/\\/g, '/')}" id="1"]`,
          '',
          `[node name="${rootNodeName}" type="${rootNodeType}"]`,
          'script = ExtResource("1")',
          '',
        ].join('\n');
      } else {
        tscnContent = [
          '[gd_scene format=3]',
          '',
          `[node name="${rootNodeName}" type="${rootNodeType}"]`,
          '',
        ].join('\n');
      }

      writeFileSync(sceneAbsPath, tscnContent, 'utf-8');

      // 如果提供 script_content 且脚本不存在，创建脚本文件
      if (scriptRelPath && scriptContent) {
        const scriptAbsPath = resolveWithinRoot(p, scriptRelPath);
        if (!existsSync(scriptAbsPath)) {
          ensureDir(scriptAbsPath);
          writeFileSync(scriptAbsPath, scriptContent, 'utf-8');
        }
      }

      const parts = [`Created scene: ${sceneRelPath}`];
      parts.push(`Root: ${rootNodeName} [${rootNodeType}]`);
      if (scriptRelPath) parts.push(`Script: res://${scriptRelPath.replace(/\\/g, '/')}`);
      if (scriptRelPath && scriptContent) parts.push(`Script file created`);

      return textResult(parts.join('\n'));
    }
```

确认 scene.ts 顶部 import 包含 `ensureDir`：

```typescript
import { validatePath, resolveWithinRoot, ensureDir } from '../helpers.js';
```

以及 `writeFileSync`：

```typescript
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
```

- [ ] **Step 4: 添加 TOOL_META**

在 `scene.ts` 底部的 `TOOL_META` 导出对象中添加：

```typescript
  quick_scene: { readonly: false, long_running: false },
```

- [ ] **Step 5: 编译验证**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add src/tools/scene.ts
git commit -m "feat: quick_scene — 一行命令创建带脚本引用的场景"
```

---

### Task 3: batch_create_files + batch_run_verify + diff_scenes 新工具

**Files:**
- Create: `src/tools/batch-tools.ts`
- Modify: `src/GodotServer.ts` (导入新模块)

- [ ] **Step 1: 创建 batch-tools.ts**

创建 `src/tools/batch-tools.ts`，内容为三个工具的完整实现。文件结构：

1. imports（fs, path, child_process, MCP types, helpers, validation, error-analyzer, tscn-parser）
2. TOOL_NAMES 数组
3. getToolDefinitions() — 3 个工具定义
4. handleTool() — 3 个 handler：
   - `batch_create_files`: 遍历 files 数组写入，可选验证
   - `batch_run_verify`: 对每个 scene spawn godot headless，收集结果
   - `diff_scenes`: parseTscn 两个文件，对比 nodeMap 差异
5. TOOL_META 导出

关键实现细节：

**batch_create_files handler:**
```typescript
    case 'batch_create_files': {
      const p = resolvePath(args.project_path as string);
      const files = args.files as Array<{ path: string; content: string; overwrite?: boolean }>;
      const shouldValidate = args.validate !== false; // 默认 true

      const created: string[] = [];
      const skipped: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      for (const file of files) {
        try {
          const relPath = file.path.replace(/^res:\/\//, '');
          const absPath = resolveWithinRoot(p, relPath);
          if (existsSync(absPath) && !file.overwrite) { skipped.push(relPath); continue; }
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, file.content, 'utf-8');
          created.push(relPath);
        } catch (e) {
          failed.push({ path: file.path, error: (e as Error).message });
        }
      }

      const result: Record<string, unknown> = {
        created: created.length, skipped: skipped.length, failed: failed.length,
        files: { created, skipped, failed },
      };

      if (shouldValidate && created.some(f => f.endsWith('.gd'))) {
        const gdFiles = created.filter(f => f.endsWith('.gd')).map(f => resolveWithinRoot(p, f));
        try {
          const godot = await ctx.findGodot();
          const valResults = await batchValidateScripts(godot, p, gdFiles, 30000);
          const valErrors = valResults.filter(r => r.errors.length > 0);
          if (valErrors.length > 0) result.validation_errors = valErrors;
        } catch { /* optional */ }
      }

      return textResult(JSON.stringify(result, null, 2));
    }
```

**batch_run_verify handler:**
```typescript
    case 'batch_run_verify': {
      const p = resolvePath(args.project_path as string);
      const scenes = args.scenes as string[];
      const timeout = (args.timeout as number) || 10;

      const godot = await ctx.findGodot();
      const results: Array<{ scene: string; status: string; errors?: string[] }> = [];
      let passed = 0, failed = 0, timedOut = 0;

      for (const scene of scenes) {
        const sceneAbs = resolveWithinRoot(p, scene.replace(/^res:\/\//, ''));
        if (!existsSync(sceneAbs)) {
          results.push({ scene, status: 'not_found' }); failed++; continue;
        }

        const procResult = await new Promise<{ output: string; code: number; killed: boolean }>((resolve) => {
          let out = '';
          const proc = spawn(godot, ['--headless', '--path', p, scene], { stdio: ['pipe', 'pipe', 'pipe'] });
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
          const timer = setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); resolve({ output: out, code: -1, killed: true }); }, timeout * 1000);
          proc.on('close', (code) => { clearTimeout(timer); resolve({ output: out, code: code ?? 0, killed: false }); });
          proc.on('error', (err) => { clearTimeout(timer); resolve({ output: err.message, code: -1, killed: false }); });
        });

        const allOutput = procResult.output.split('\n');
        const analysis = analyzeOutput(allOutput);
        const sceneErrors = allOutput.filter(l => l.includes('ERROR') || l.includes('SCRIPT ERROR'));

        if (procResult.killed) { results.push({ scene, status: 'timed_out' }); timedOut++; }
        else if (analysis.hasErrors) { results.push({ scene, status: 'failed', errors: sceneErrors.slice(0, 5) }); failed++; }
        else { results.push({ scene, status: 'passed' }); passed++; }
      }

      return textResult(JSON.stringify({ total: scenes.length, passed, failed, timed_out: timedOut, results }, null, 2));
    }
```

**diff_scenes handler:**
```typescript
    case 'diff_scenes': {
      const p = resolvePath(args.project_path as string);
      const sceneA = resolveWithinRoot(p, (args.scene_a as string).replace(/^res:\/\//, ''));
      const sceneB = resolveWithinRoot(p, (args.scene_b as string).replace(/^res:\/\//, ''));
      const ignoreProps = new Set((args.ignore_properties as string[]) || ['metadata/_edit_lock']);

      if (!existsSync(sceneA)) return textResult(`Error: scene_a not found: ${args.scene_a}`);
      if (!existsSync(sceneB)) return textResult(`Error: scene_b not found: ${args.scene_b}`);

      const parsedA = parseTscn(readFileSync(sceneA, 'utf-8'));
      const parsedB = parseTscn(readFileSync(sceneB, 'utf-8'));
      const mapA = parsedA.nodeMap;
      const mapB = parsedB.nodeMap;

      const added: string[] = [];
      const removed: string[] = [];
      const modified: Array<{ path: string; changes: string[] }> = [];

      for (const [path, nodeB] of mapB) {
        if (!mapA.has(path)) added.push(`${path} [${nodeB.type}]`);
      }
      for (const [path, nodeA] of mapA) {
        if (!mapB.has(path)) removed.push(`${path} [${nodeA.type}]`);
      }
      for (const [path, nodeA] of mapA) {
        const nodeB = mapB.get(path);
        if (!nodeB) continue;
        const changes: string[] = [];
        if (nodeA.type !== nodeB.type) changes.push(`type: ${nodeA.type} → ${nodeB.type}`);
        const propsA = new Map(nodeA.properties.filter(pp => !ignoreProps.has(pp.name)).map(pp => [pp.name, JSON.stringify(pp.value)]));
        const propsB = new Map(nodeB.properties.filter(pp => !ignoreProps.has(pp.name)).map(pp => [pp.name, JSON.stringify(pp.value)]));
        for (const [key, valB] of propsB) {
          const valA = propsA.get(key);
          if (valA === undefined) changes.push(`+ ${key}: ${valB}`);
          else if (valA !== valB) changes.push(`${key}: ${valA} → ${valB}`);
        }
        for (const [key] of propsA) {
          if (!propsB.has(key)) changes.push(`- ${key}`);
        }
        if (changes.length > 0) modified.push({ path, changes });
      }

      return textResult(JSON.stringify({
        summary: `Nodes: ${mapA.size} → ${mapB.size} | Added: ${added.length} | Removed: ${removed.length} | Modified: ${modified.length}`,
        added, removed, modified,
      }, null, 2));
    }
```

- [ ] **Step 2: 注册新模块到 GodotServer.ts**

在 `src/GodotServer.ts` 中添加 import 和模块注册：

1. 在 import 区（约第 40 行）添加：
```typescript
import * as batchTools from './tools/batch-tools.js';
```

2. 在 `toolModules` 数组末尾添加 `batchTools`：
```typescript
const toolModules = [runtime, screenshot, project, scene, script, validation, docs, godotOps, tilemapOps, materialOps, gameBridge, workflow, animationOps, profilerOps, spatialOps, testFramework, animtreeOps, navigationOps, particlesOps, batchTools];
```

- [ ] **Step 3: 编译验证**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/tools/batch-tools.ts src/GodotServer.ts
git commit -m "feat: batch_create_files + batch_run_verify + diff_scenes 三个批量工具"
```

---

### Task 4: 集成验证

**Files:**
- No new files

- [ ] **Step 1: 完整编译**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build`
Expected: 编译成功，无错误

- [ ] **Step 2: 确认工具总数**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx tsc --noEmit 2>&1`
Expected: 0 errors，新增 5 个工具注册成功

- [ ] **Step 3: 提交（如有遗漏）**

```bash
git status
# 如有未提交的改动
git add -A
git commit -m "chore: 集成验证通过"
```
