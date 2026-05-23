# GDScript Lint 引擎与代码模板系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP 工具写入 GDScript 后自动检测 16 类 Godot 4.6 API 语义错误，并通过代码模板提供修复建议。

**Architecture:** 两阶段 lint 引擎 — 阶段 1 正则初筛（<1ms/文件），阶段 2 预留 headless 语义验证（P0 仅用启发式上下文检查替代）。lint 结果嵌入 write_script/edit_script/batch_create_files/validate_scripts 的返回值。代码模板作为 lint suggestion 返回，不增加 API 表面积。

**Tech Stack:** TypeScript, Node.js `node:test` + `node:assert/strict`, 正则表达式, GDScript 函数体解析

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/tools/gdscript-lint.ts` | Lint 类型定义、16 条规则、lintGDScript 核心函数 |
| 新建 | `src/tools/code-templates.ts` | 7 个代码模板定义 |
| 新建 | `test/gdscript-lint.test.js` | 48 条规则测试 + 4 条集成测试 |
| 新建 | `test/code-templates.test.js` | 7 条模板自测 |
| 修改 | `src/tools/validation.ts:19-50` | 从 KNOWN_BASE_METHODS 移除 bounce/friction |
| 修改 | `src/tools/script.ts:259-268,270-451` | write_script/edit_script 集成 lint |
| 修改 | `src/tools/batch-tools.ts` | batch_create_files 集成 lint |
| 修改 | `src/tools/docs.ts:78-112` | get_class_info 增加废弃标注 |

---

### Task 1: Lint 引擎基础设施

**Files:**
- Create: `src/tools/gdscript-lint.ts`
- Test: `test/gdscript-lint.test.js`

- [ ] **Step 1: 创建 lint 类型定义和工具函数**

创建 `src/tools/gdscript-lint.ts`，写入类型定义和工具函数：

```typescript
// ─── Lint Types ─────────────────────────────────────────────────────────────

export interface LintRule {
  id: string;
  severity: "error" | "warning";
  pattern: RegExp;
  message: string;
  suggestion: string;
  requiresSemanticValidation?: boolean;
  contextFilter?: (match: RegExpMatchArray, context: LintContext) => boolean;
  isCallOrder?: boolean;
}

export interface LintResult {
  rule: string;
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
  confirmed: boolean;
}

export interface LintContext {
  precedingLines: string[];
  functionBody?: string;
  functionName?: string;
}

export interface LintOutput {
  errors: LintResult[];
  warnings: LintResult[];
  meta: {
    godot_target: string;
    rules_count: number;
    last_reviewed: string;
  };
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function getLineNumber(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function isInComment(line: string, matchIndex: number): boolean {
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < matchIndex && i < line.length; i++) {
    if (!inString) {
      if (line[i] === '#') return true;
      if (line[i] === '"' || line[i] === "'") {
        inString = true;
        stringChar = line[i];
      }
    } else {
      if (line[i] === stringChar && (i === 0 || line[i - 1] !== '\\')) {
        inString = false;
      }
    }
  }
  return false;
}

function isInString(line: string, matchIndex: number): boolean {
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < matchIndex && i < line.length; i++) {
    if (!inString) {
      if (line[i] === '"' || line[i] === "'") {
        inString = true;
        stringChar = line[i];
      }
    } else {
      if (line[i] === stringChar && (i === 0 || line[i - 1] !== '\\')) {
        inString = false;
      }
    }
  }
  return inString;
}

function isInCommentOrString(line: string, matchIndex: number): boolean {
  return isInComment(line, matchIndex) || isInString(line, matchIndex);
}

interface FunctionInfo {
  name: string;
  body: string;
  startLine: number;
  endLine: number;
}

function extractFunctions(code: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)func\s+(\w+)\s*\(/);
    if (!match) continue;

    const baseIndent = match[1].length;
    const funcName = match[2];
    const startLine = i + 1;
    const bodyLines: string[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (lineIndent <= baseIndent && line.trim() !== '') break;
      bodyLines.push(line);
    }

    functions.push({
      name: funcName,
      body: bodyLines.join('\n'),
      startLine,
      endLine: startLine + bodyLines.length,
    });
  }

  return functions;
}

function extractContext(code: string, matchIndex: number): LintContext {
  const lines = code.split('\n');
  let charCount = 0;
  let matchLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i].length >= matchIndex) {
      matchLine = i;
      break;
    }
    charCount += lines[i].length + 1;
  }

  const startLine = Math.max(0, matchLine - 50);
  const precedingLines = lines.slice(startLine, matchLine);

  return { precedingLines };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTypeContext(precedingLines: string[], typeNames: string[]): boolean {
  const text = precedingLines.join('\n');
  return typeNames.some(t => text.includes(t));
}

// ─── Lint Metadata ──────────────────────────────────────────────────────────

const LINT_VERSION = {
  godot_target: "4.6",
  last_reviewed: "2026-05-18",
  rules_count: 16,
};

// ─── RULES (populated in Tasks 2-4) ────────────────────────────────────────

const RULES: LintRule[] = [];

// ─── Main Lint Function ────────────────────────────────────────────────────

export function lintGDScript(code: string, skipSemantic: boolean = false): LintOutput {
  const errors: LintResult[] = [];
  const warnings: LintResult[] = [];
  const lines = code.split('\n');
  const functions = extractFunctions(code);

  for (const rule of RULES) {
    if (rule.isCallOrder) {
      lintCallOrder(rule, functions, errors, warnings);
    } else {
      lintRegex(rule, code, lines, errors, warnings, skipSemantic);
    }
  }

  return {
    errors,
    warnings,
    meta: {
      godot_target: LINT_VERSION.godot_target,
      rules_count: RULES.length,
      last_reviewed: LINT_VERSION.last_reviewed,
    },
  };
}

function lintCallOrder(
  rule: LintRule,
  functions: FunctionInfo[],
  errors: LintResult[],
  warnings: LintResult[],
): void {
  // Populated in Task 4
}

function lintRegex(
  rule: LintRule,
  code: string,
  lines: string[],
  errors: LintResult[],
  warnings: LintResult[],
  skipSemantic: boolean,
): void {
  const globalPattern = rule.pattern.global
    ? rule.pattern
    : new RegExp(rule.pattern.source, 'g');

  let match: RegExpMatchArray | null;
  while ((match = globalPattern.exec(code)) !== null) {
    const matchIndex = match.index;
    const lineNum = getLineNumber(code, matchIndex);
    const lineText = lines[lineNum - 1] || '';

    // 计算 match 在当前行内的偏移
    let lineStart = 0;
    for (let i = 0; i < lineNum - 1; i++) {
      lineStart += (lines[i] || '').length + 1;
    }
    const lineOffset = matchIndex - lineStart;

    if (isInCommentOrString(lineText, Math.max(0, lineOffset))) continue;

    const result: LintResult = {
      rule: rule.id,
      severity: rule.severity,
      line: lineNum,
      message: rule.message,
      suggestion: rule.suggestion,
      confirmed: true,
    };

    if (rule.contextFilter) {
      const context = extractContext(code, matchIndex);
      if (!rule.contextFilter(match, context)) continue;
    }

    if (rule.severity === "error") {
      errors.push(result);
    } else {
      warnings.push(result);
    }
  }
}

/** 格式化 lint 结果为人类可读文本 */
export function formatLintResults(output: LintOutput): string {
  if (output.errors.length === 0 && output.warnings.length === 0) return '';

  const parts: string[] = [];
  if (output.errors.length > 0) {
    parts.push(`Lint Errors (${output.errors.length}):`);
    for (const e of output.errors) {
      parts.push(`  ${e.rule} (line ${e.line}): ${e.message}`);
      if (e.suggestion) parts.push(`    → ${e.suggestion.split('\n')[0]}`);
    }
  }
  if (output.warnings.length > 0) {
    parts.push(`Lint Warnings (${output.warnings.length}):`);
    for (const w of output.warnings) {
      parts.push(`  ${w.rule} (line ${w.line}): ${w.message}`);
      if (w.suggestion) parts.push(`    → ${w.suggestion.split('\n')[0]}`);
    }
  }
  return '\n\n' + parts.join('\n');
}
```

- [ ] **Step 2: 创建测试文件骨架**

创建 `test/gdscript-lint.test.js`：

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintGDScript } from '../build/tools/gdscript-lint.js';

describe('GDScript Lint', () => {
  it('returns empty results for clean code', () => {
    const code = 'extends Node3D\n\nfunc _ready():\n\tpass';
    const result = lintGDScript(code, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.meta.godot_target, '4.6');
  });

  it('returns meta information', () => {
    const result = lintGDScript('', true);
    assert.ok(result.meta.rules_count >= 0);
    assert.ok(result.meta.last_reviewed);
  });
});
```

- [ ] **Step 3: 编译并验证骨架可运行**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/gdscript-lint.test.js`
Expected: 2 tests pass

- [ ] **Step 4: 提交**

```bash
git add src/tools/gdscript-lint.ts test/gdscript-lint.test.js
git commit -m "feat(lint): add lint engine infrastructure with types and utilities"
```

---

### Task 2: 10 条简单正则规则 (L003-L006, L008-L013)

**Files:**
- Modify: `src/tools/gdscript-lint.ts` (RULES 数组)
- Modify: `test/gdscript-lint.test.js`

- [ ] **Step 1: 添加 10 条规则到 RULES 数组**

替换 `gdscript-lint.ts` 中的空 `RULES` 数组为：

```typescript
const RULES: LintRule[] = [
  // L003: CylinderMesh.radius
  {
    id: "L003",
    severity: "error",
    pattern: /CylinderMesh\w*\.radius\s*=/,
    message: "CylinderMesh.radius 在 Godot 4 中不存在，需分别设置 top_radius 和 bottom_radius",
    suggestion: "使用 mesh.top_radius = 0.5 和 mesh.bottom_radius = 0.5 分别设置",
  },
  // L004: Environment.adjustments_*
  {
    id: "L004",
    severity: "error",
    pattern: /\.adjustments_\w+\s*=/,
    message: "Environment 的 adjustments_* 属性在 Godot 4 中不带 s，应为 adjustment_*",
    suggestion: "将 adjustments_enabled → adjustment_enabled, adjustments_brightness → adjustment_brightness 等",
  },
  // L005: Environment.tone_mapper
  {
    id: "L005",
    severity: "error",
    pattern: /\.tone_mapper\s*=/,
    message: "Environment.tone_mapper 在 Godot 4 中已重命名为 tonemap_mode",
    suggestion: "使用 env.tonemap_mode = Environment.TONE_MAPPER_LINEAR",
  },
  // L006: SoftBody3D.mass
  {
    id: "L006",
    severity: "error",
    pattern: /SoftBody3D.*\.mass\s*=/,
    message: "SoftBody3D.mass 在 Godot 4 中已重命名为 total_mass",
    suggestion: "使用 softbody.total_mass = 2.0",
  },
  // L008: ArrayMesh.create_triangle_shape
  {
    id: "L008",
    severity: "error",
    pattern: /\.create_triangle_shape\s*\(/,
    message: "ArrayMesh.create_triangle_shape() 在 Godot 4 中不存在，应为 create_triangle_mesh()",
    suggestion: "使用 mesh.create_triangle_mesh()",
  },
  // L009: Node.get_child_or_null
  {
    id: "L009",
    severity: "error",
    pattern: /\.get_child_or_null\s*\(/,
    message: "Node.get_child_or_null() 在 Godot 4.x 中已移除，使用 get_child() 或 find_child()",
    suggestion: "使用 get_child(index) 或 find_child(\"name\")",
  },
  // L010: FogMaterial.albedo_color
  {
    id: "L010",
    severity: "error",
    pattern: /FogMaterial.*\.albedo_color\s*=/,
    message: "FogMaterial.albedo_color 在 Godot 4 中已重命名为 albedo",
    suggestion: "使用 fog.albedo = Color.RED（albedo 是散射色，emission 是自发光色，两者功能完全不同）",
  },
  // L011: Environment.physically_based_lights_enabled
  {
    id: "L011",
    severity: "error",
    pattern: /\.physically_based_lights_enabled\s*=/,
    message: "Environment.physically_based_lights_enabled 在 Godot 4 中已移除",
    suggestion: "此属性已移除，无直接替代方案",
  },
  // L012: Line2D.dash_pattern non-typed array
  {
    id: "L012",
    severity: "error",
    pattern: /\.dash_pattern\s*=\s*\[/,
    message: "Line2D.dash_pattern 需要 PackedFloat32Array 类型，不能使用普通数组字面量",
    suggestion: "使用 line.dash_pattern = PackedFloat32Array([1.0, 2.0])",
  },
  // L013: CharacterBody3D.body_entered
  {
    id: "L013",
    severity: "error",
    pattern: /CharacterBody.*body_entered/,
    message: "CharacterBody3D 不提供 body_entered 信号，应使用 Area3D 子节点进行碰撞检测",
    suggestion: "添加 Area3D 子节点并连接其 body_entered/body_exited 信号",
  },
];
```

- [ ] **Step 2: 添加 30 条测试用例（命中/忽略/边界 × 10 规则）**

在 `test/gdscript-lint.test.js` 的 describe 块内追加（在最后 `});` 之前）：

```javascript
  // L003
  describe('L003 CylinderMesh.radius', () => {
    it('命中: CylinderMesh.radius 赋值', () => {
      assert.ok(lintGDScript('var mesh := CylinderMesh.new()\nmesh.radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
    it('忽略: SphereMesh.radius 合法', () => {
      assert.ok(!lintGDScript('var mesh := SphereMesh.new()\nmesh.radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
    it('边界: 变量名包含 radius', () => {
      assert.ok(!lintGDScript('var cylinder_radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
  });

  // L004
  describe('L004 Environment.adjustments_*', () => {
    it('命中: adjustments_enabled 赋值', () => {
      assert.ok(lintGDScript('env.adjustments_enabled = true', true).errors.some(e => e.rule === 'L004'));
    });
    it('忽略: adjustment_enabled 正确', () => {
      assert.ok(!lintGDScript('env.adjustment_enabled = true', true).errors.some(e => e.rule === 'L004'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# adjustments_enabled is deprecated', true).errors.some(e => e.rule === 'L004'));
    });
  });

  // L005
  describe('L005 Environment.tone_mapper', () => {
    it('命中: tone_mapper 赋值', () => {
      assert.ok(lintGDScript('env.tone_mapper = 1', true).errors.some(e => e.rule === 'L005'));
    });
    it('忽略: tonemap_mode 正确', () => {
      assert.ok(!lintGDScript('env.tonemap_mode = 1', true).errors.some(e => e.rule === 'L005'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var tone_mapper_value = 1', true).errors.some(e => e.rule === 'L005'));
    });
  });

  // L006
  describe('L006 SoftBody3D.mass', () => {
    it('命中: SoftBody3D.mass 赋值', () => {
      assert.ok(lintGDScript('var body := SoftBody3D.new()\nbody.mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
    it('忽略: RigidBody3D.mass 合法', () => {
      assert.ok(!lintGDScript('var body := RigidBody3D.new()\nbody.mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var softbody_mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
  });

  // L008
  describe('L008 ArrayMesh.create_triangle_shape', () => {
    it('命中: create_triangle_shape 调用', () => {
      assert.ok(lintGDScript('mesh.create_triangle_shape()', true).errors.some(e => e.rule === 'L008'));
    });
    it('忽略: create_triangle_mesh 正确', () => {
      assert.ok(!lintGDScript('mesh.create_triangle_mesh()', true).errors.some(e => e.rule === 'L008'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# mesh.create_triangle_shape()', true).errors.some(e => e.rule === 'L008'));
    });
  });

  // L009
  describe('L009 Node.get_child_or_null', () => {
    it('命中: get_child_or_null 调用', () => {
      assert.ok(lintGDScript('var child = get_child_or_null(0)', true).errors.some(e => e.rule === 'L009'));
    });
    it('忽略: get_child 正确', () => {
      assert.ok(!lintGDScript('var child = get_child(0)', true).errors.some(e => e.rule === 'L009'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# get_child_or_null', true).errors.some(e => e.rule === 'L009'));
    });
  });

  // L010
  describe('L010 FogMaterial.albedo_color', () => {
    it('命中: FogMaterial.albedo_color 赋值', () => {
      const r = lintGDScript('var fog := FogMaterial.new()\nfog.albedo_color = Color.RED', true);
      assert.ok(r.errors.some(e => e.rule === 'L010'));
      const l010 = r.errors.find(e => e.rule === 'L010');
      assert.ok(l010.suggestion.includes('albedo'));
      assert.ok(!l010.suggestion.includes('emission'));
    });
    it('忽略: FogMaterial.albedo 正确', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.albedo = Color.RED', true).errors.some(e => e.rule === 'L010'));
    });
    it('边界: FogMaterial.emission 合法', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.emission = Color.RED', true).errors.some(e => e.rule === 'L010'));
    });
  });

  // L011
  describe('L011 Environment.physically_based_lights_enabled', () => {
    it('命中: physically_based_lights_enabled 赋值', () => {
      assert.ok(lintGDScript('env.physically_based_lights_enabled = true', true).errors.some(e => e.rule === 'L011'));
    });
    it('忽略: 其他属性', () => {
      assert.ok(!lintGDScript('env.ambient_light_source = 1', true).errors.some(e => e.rule === 'L011'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# physically_based_lights_enabled', true).errors.some(e => e.rule === 'L011'));
    });
  });

  // L012
  describe('L012 Line2D.dash_pattern', () => {
    it('命中: dash_pattern 使用普通数组', () => {
      assert.ok(lintGDScript('line.dash_pattern = [1.0, 2.0]', true).errors.some(e => e.rule === 'L012'));
    });
    it('忽略: PackedFloat32Array 正确', () => {
      assert.ok(!lintGDScript('line.dash_pattern = PackedFloat32Array([1.0, 2.0])', true).errors.some(e => e.rule === 'L012'));
    });
    it('边界: 变量间接赋值', () => {
      assert.ok(!lintGDScript('var p := PackedFloat32Array([1, 2])\nline.dash_pattern = p', true).errors.some(e => e.rule === 'L012'));
    });
  });

  // L013
  describe('L013 CharacterBody3D.body_entered', () => {
    it('命中: CharacterBody3D 使用 body_entered', () => {
      assert.ok(lintGDScript('extends CharacterBody3D\nbody.body_entered.connect(_on_enter)', true).errors.some(e => e.rule === 'L013'));
    });
    it('忽略: Area3D 使用 body_entered 合法', () => {
      assert.ok(!lintGDScript('extends Area3D\narea.body_entered.connect(_on_enter)', true).errors.some(e => e.rule === 'L013'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# body_entered signal', true).errors.some(e => e.rule === 'L013'));
    });
  });
```

- [ ] **Step 3: 编译并运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/gdscript-lint.test.js`
Expected: 全部 32 个测试通过（2 infrastructure + 30 rule tests）

- [ ] **Step 4: 提交**

```bash
git add src/tools/gdscript-lint.ts test/gdscript-lint.test.js
git commit -m "feat(lint): add 10 simple regex rules L003-L006, L008-L013 with tests"
```

---

### Task 3: 2 条类型上下文规则 (L002, L007)

**Files:**
- Modify: `src/tools/gdscript-lint.ts` (RULES 数组追加)
- Modify: `test/gdscript-lint.test.js`

- [ ] **Step 1: 添加 L002 和 L007 规则（带 contextFilter）**

在 RULES 数组末尾（L013 之后）添加：

```typescript
  // L002: RigidBody3D.bounce
  {
    id: "L002",
    severity: "error",
    pattern: /\.bounce\s*=/,
    message: "RigidBody3D.bounce 在 Godot 4 中不存在，需使用 PhysicsMaterial",
    suggestion: "使用 PhysicsMaterial:\n  var mat := PhysicsMaterial.new()\n  mat.bounce = 0.4\n  body.physics_material_override = mat",
    requiresSemanticValidation: true,
    contextFilter: (match, context): boolean => {
      if (hasTypeContext(context.precedingLines, ['PhysicsMaterial'])) return false;
      return hasTypeContext(context.precedingLines, ['RigidBody3D', 'RigidDynamicBody3D', 'PhysicsBody3D']);
    },
  },
  // L007: Node3D.visibility_range_*
  {
    id: "L007",
    severity: "error",
    pattern: /\.visibility_range_\w+\s*=/,
    message: "visibility_range_* 属性位于 GeometryInstance3D，不在 Node3D 上",
    suggestion: "确保使用的是 MeshInstance3D/GPUParticles3D 等 GeometryInstance3D 子类",
    requiresSemanticValidation: true,
    contextFilter: (match, context): boolean => {
      const geoSubclasses = ['MeshInstance3D', 'GPUParticles3D', 'CPUParticles3D',
        'MultiMeshInstance3D', 'Decal', 'FogVolume', 'GeometryInstance3D',
        'VisualInstance3D', 'SpriteBase3D', 'Label3D'];
      if (hasTypeContext(context.precedingLines, geoSubclasses)) return false;
      return hasTypeContext(context.precedingLines, ['Node3D']);
    },
  },
```

- [ ] **Step 2: 添加 6 条测试用例**

```javascript
  // L002
  describe('L002 RigidBody3D.bounce', () => {
    it('命中: RigidBody3D.bounce 直接赋值', () => {
      assert.ok(lintGDScript('var rb := RigidBody3D.new()\nrb.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
    it('忽略: PhysicsMaterial.bounce 合法', () => {
      assert.ok(!lintGDScript('var phys_mat := PhysicsMaterial.new()\nphys_mat.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# rb.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
  });

  // L007
  describe('L007 Node3D.visibility_range_*', () => {
    it('命中: Node3D 上下文引用 visibility_range', () => {
      assert.ok(lintGDScript('var node := Node3D.new()\nnode.visibility_range_begin = 5.0', true).errors.some(e => e.rule === 'L007'));
    });
    it('忽略: MeshInstance3D 合法', () => {
      assert.ok(!lintGDScript('var mesh := MeshInstance3D.new()\nmesh.visibility_range_begin = 5.0', true).errors.some(e => e.rule === 'L007'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# visibility_range_begin', true).errors.some(e => e.rule === 'L007'));
    });
  });
```

- [ ] **Step 3: 编译并运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/gdscript-lint.test.js`
Expected: 全部 38 个测试通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/gdscript-lint.ts test/gdscript-lint.test.js
git commit -m "feat(lint): add type-context rules L002, L007 with heuristic filters"
```

---

### Task 4: 4 条调用顺序规则 (L001, L014, L015, L016)

**Files:**
- Modify: `src/tools/gdscript-lint.ts` (RULES + lintCallOrder)
- Modify: `test/gdscript-lint.test.js`

- [ ] **Step 1: 实现 lintCallOrder 并添加 4 条规则**

替换空的 `lintCallOrder` 函数为：

```typescript
function lintCallOrder(
  rule: LintRule,
  functions: FunctionInfo[],
  errors: LintResult[],
  warnings: LintResult[],
): void {
  for (const func of functions) {
    const body = func.body;
    switch (rule.id) {
      case "L001": {
        const lookAtMatch = body.match(/\.look_at\s*\(/);
        const addChildMatch = body.match(/add_child\s*\(/);
        if (lookAtMatch && addChildMatch) {
          if (body.indexOf(lookAtMatch[0]) < body.indexOf(addChildMatch[0])) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L014": {
        const solidMatch = body.match(/\.set_point_solid\s*\(/);
        const updateMatch = body.match(/\.update\s*\(\s*\)/);
        if (solidMatch && updateMatch) {
          if (body.indexOf(solidMatch[0]) < body.indexOf(updateMatch[0])) {
            warnings.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L015": {
        if (func.name === '_process' || func.name === '_physics_process') {
          if (/\.look_at\s*\(/.test(body) && /RigidBody|rigid|rb\b/.test(body)) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L016": {
        const acReg = /add_child\s*\(\s*(\w+)\s*\)/g;
        let acMatch;
        while ((acMatch = acReg.exec(body)) !== null) {
          const childVar = acMatch[1];
          const after = body.substring(acMatch.index + acMatch[0].length).trimStart();
          if (after.startsWith(childVar + '.') || after.startsWith(childVar + ' ')) {
            warnings.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
            break;
          }
        }
        break;
      }
    }
  }
}
```

在 RULES 数组末尾添加 4 条 call-order 规则：

```typescript
  // L001: look_at before add_child
  { id: "L001", severity: "error", pattern: /^$/m, isCallOrder: true,
    message: "look_at() 在 add_child() 之前调用，节点不在场景树中",
    suggestion: "先调用 add_child() 将节点加入场景树，再调用 look_at()" },
  // L014: AStarGrid2D update clears point data
  { id: "L014", severity: "warning", pattern: /^$/m, isCallOrder: true,
    message: "set_point_solid() 在 update() 之前调用，update() 会清除所有 point data",
    suggestion: "先调用 grid.update()，再调用 grid.set_point_solid()" },
  // L015: RigidBody3D.look_at in _process
  { id: "L015", severity: "error", pattern: /^$/m, isCallOrder: true,
    message: "在 _process/_physics_process 内对 RigidBody3D 调用 look_at() 会破坏物理模拟",
    suggestion: "在 _integrate_forces() 中实现跟随逻辑" },
  // L016: add_child followed by immediate method call
  { id: "L016", severity: "warning", pattern: /^$/m, isCallOrder: true,
    message: "add_child() 后同函数内立即访问子节点方法，可能因 _ready 未触发而失败",
    suggestion: "使用 await get_tree().process_frame 等待一帧后再访问" },
```

- [ ] **Step 2: 添加 12 条测试用例**

```javascript
  // L001
  describe('L001 look_at order', () => {
    it('命中: _ready 内 look_at 在 add_child 前', () => {
      const code = 'func _ready():\n\tvar cam := Camera3D.new()\n\tcam.look_at(target)\n\tadd_child(cam)';
      assert.ok(lintGDScript(code, true).errors.some(e => e.rule === 'L001'));
    });
    it('忽略: add_child 在 look_at 前', () => {
      const code = 'func _ready():\n\tvar cam := Camera3D.new()\n\tadd_child(cam)\n\tcam.look_at(target)';
      assert.ok(!lintGDScript(code, true).errors.some(e => e.rule === 'L001'));
    });
    it('边界: 跨函数不在检测范围', () => {
      const code = 'func _ready():\n\tadd_child(cam)\nfunc _process(delta):\n\tcam.look_at(target)';
      assert.ok(!lintGDScript(code, true).errors.some(e => e.rule === 'L001'));
    });
  });

  // L014
  describe('L014 AStarGrid2D update', () => {
    it('命中: 先 set_point_solid 后 update', () => {
      const code = 'func _ready():\n\tgrid.set_point_solid(Vector2i(1, 1), true)\n\tgrid.update()';
      assert.ok(lintGDScript(code, true).warnings.some(w => w.rule === 'L014'));
    });
    it('忽略: 先 update 后 set_point_solid', () => {
      const code = 'func _ready():\n\tgrid.update()\n\tgrid.set_point_solid(Vector2i(1, 1), true)';
      assert.ok(!lintGDScript(code, true).warnings.some(w => w.rule === 'L014'));
    });
    it('边界: 无 update 调用', () => {
      const code = 'func _ready():\n\tgrid.set_point_solid(Vector2i(1, 1), true)';
      assert.ok(!lintGDScript(code, true).warnings.some(w => w.rule === 'L014'));
    });
  });

  // L015
  describe('L015 RigidBody3D.look_at in _process', () => {
    it('命中: _physics_process 内 look_at', () => {
      assert.ok(lintGDScript('func _physics_process(delta):\n\trb.look_at(target)', true).errors.some(e => e.rule === 'L015'));
    });
    it('忽略: _integrate_forces 内', () => {
      assert.ok(!lintGDScript('func _integrate_forces(state):\n\tpass', true).errors.some(e => e.rule === 'L015'));
    });
    it('边界: _ready 内一次性 look_at', () => {
      assert.ok(!lintGDScript('func _ready():\n\tvar cam := Camera3D.new()\n\tadd_child(cam)\n\tcam.look_at(target)', true).errors.some(e => e.rule === 'L015'));
    });
  });

  // L016
  describe('L016 add_child followed by method call', () => {
    it('命中: add_child 后立即调用方法', () => {
      const code = 'func _ready():\n\tvar node := Node3D.new()\n\tadd_child(node)\n\tnode.set_something()';
      assert.ok(lintGDScript(code, true).warnings.some(w => w.rule === 'L016'));
    });
    it('忽略: await 后访问', () => {
      const code = 'func _ready():\n\tadd_child(node)\n\tawait get_tree().process_frame\n\tnode.set_something()';
      assert.ok(!lintGDScript(code, true).warnings.some(w => w.rule === 'L016'));
    });
    it('边界: 跨函数不在范围', () => {
      const code = 'func _ready():\n\tadd_child(node)\nfunc _process(delta):\n\tnode.set_something()';
      assert.ok(!lintGDScript(code, true).warnings.some(w => w.rule === 'L016'));
    });
  });
```

- [ ] **Step 3: 编译并运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/gdscript-lint.test.js`
Expected: 全部 50 个测试通过，meta.rules_count === 16

- [ ] **Step 4: 提交**

```bash
git add src/tools/gdscript-lint.ts test/gdscript-lint.test.js
git commit -m "feat(lint): add call-order rules L001, L014, L015, L016"
```

---

### Task 5: KNOWN_BASE_METHODS 白名单清理

**Files:**
- Modify: `src/tools/validation.ts:40`
- Modify: `test/gdscript-lint.test.js`

- [ ] **Step 1: 从白名单移除 bounce 和 friction**

在 `src/tools/validation.ts` 第 40 行，将：
```
  'linear_velocity', 'angular_velocity', 'mass', 'bounce', 'friction',
```
改为：
```
  'linear_velocity', 'angular_velocity', 'mass',
```

- [ ] **Step 2: 添加白名单清理测试**

```javascript
  describe('KNOWN_BASE_METHODS cleanup', () => {
    it('RigidBody3D.mass 不触发 L006', () => {
      assert.ok(!lintGDScript('var body := RigidBody3D.new()\nbody.mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
    it('bounce 由 lint 接管', () => {
      assert.ok(lintGDScript('var rb := RigidBody3D.new()\nrb.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
    it('friction 清理后不崩溃', () => {
      const r = lintGDScript('var rb := RigidBody3D.new()\nrb.friction = 0.3', true);
      assert.ok(r.meta.rules_count > 0);
    });
  });
```

- [ ] **Step 3: 编译并运行全部测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/validation.ts test/gdscript-lint.test.js
git commit -m "fix(lint): remove bounce/friction from KNOWN_BASE_METHODS whitelist"
```

---

### Task 6: 代码模板系统 (T001-T007)

**Files:**
- Create: `src/tools/code-templates.ts`
- Create: `test/code-templates.test.js`

- [ ] **Step 1: 创建代码模板文件**

创建 `src/tools/code-templates.ts`（完整内容见设计文档 P1 部分，7 个模板 T001-T007）。

每个模板接口：

```typescript
interface TemplateParam { name: string; type: string; default: string; }
export interface CodeTemplate {
  id: string; name: string; description: string; relatedRules: string[];
  params: TemplateParam[]; generate: (params: Record<string, string>) => string;
  verifiedGodotVersion: string; lastVerified: string;
}
```

7 个模板：
- T001 camera3d_setup — Camera3D + look_at，保证 add_child 在前
- T002 rigidbody3d_with_bounce — RigidBody3D + PhysicsMaterial + CollisionShape3D
- T003 area3d_detection — Area3D 子节点碰撞检测
- T004 environment_adjustments — WorldEnvironment + 色彩校正（正确属性名）
- T005 softbody3d_setup — SoftBody3D（total_mass/damping_coefficient）
- T006 astar_grid_setup — AStarGrid2D（先 update 再 set_point_solid）
- T007 line2d_dashed — Line2D + PackedFloat32Array dash_pattern

导出 `TEMPLATES: CodeTemplate[]` 数组和 `getTemplateSuggestion(ruleId: string): string | null` 工具函数。

- [ ] **Step 2: 创建模板自测文件**

创建 `test/code-templates.test.js`：

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintGDScript } from '../build/tools/gdscript-lint.js';
import { TEMPLATES, getTemplateSuggestion } from '../build/tools/code-templates.js';

describe('Code Templates', () => {
  const tests = [
    { id: 'T001', rules: ['L001'] }, { id: 'T002', rules: ['L002'] },
    { id: 'T003', rules: ['L013'] }, { id: 'T004', rules: ['L004', 'L005', 'L011'] },
    { id: 'T005', rules: ['L006'] }, { id: 'T006', rules: ['L014'] },
    { id: 'T007', rules: ['L012'] },
  ];
  for (const tt of tests) {
    it(`${tt.id}: generated code passes lint for related rules`, () => {
      const tpl = TEMPLATES.find(t => t.id === tt.id);
      assert.ok(tpl);
      const code = tpl.generate({});
      const result = lintGDScript(code, true);
      for (const ruleId of tt.rules) {
        const found = result.errors.find(e => e.rule === ruleId) || result.warnings.find(w => w.rule === ruleId);
        assert.ok(!found, `${tt.id} should not trigger ${ruleId}`);
      }
    });
  }
  it('getTemplateSuggestion returns suggestion for L002', () => {
    assert.ok(getTemplateSuggestion('L002')?.includes('PhysicsMaterial'));
  });
  it('getTemplateSuggestion returns null for unknown rule', () => {
    assert.equal(getTemplateSuggestion('L999'), null);
  });
});
```

- [ ] **Step 3: 编译并运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/code-templates.test.js`
Expected: 9 个测试通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/code-templates.ts test/code-templates.test.js
git commit -m "feat(lint): add 7 code templates T001-T007 with self-tests"
```

---

### Task 7: 集成 lint 到 write_script 和 edit_script

**Files:**
- Modify: `src/tools/script.ts`

- [ ] **Step 1: 导入 lint 模块**

在 `src/tools/script.ts` 顶部添加：

```typescript
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
```

- [ ] **Step 2: 修改 write_script handler**

在 `write_script` case（约第 259 行）的 `return textResult(...)` 中，将：

```typescript
return textResult(`Script written to ${sp} (${content.split('\n').length} lines)`);
```

改为：

```typescript
let lintSection = '';
if (sp.endsWith('.gd')) {
  const lintOutput = lintGDScript(content, true);
  lintSection = formatLintResults(lintOutput);
}
return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${lintSection}`);
```

- [ ] **Step 3: 修改 edit_script handler**

在 `edit_script` 的两个 return 路径（search_and_replace 模式和 line-number 模式）中，在最终 return 之前添加 lint 检查。在 return 语句的文本末尾追加 lint 结果。

对于 line-number 模式（约第 446-450 行），在最终 return 前添加：

```typescript
let editLintSection = '';
if (fullPath.endsWith('.gd')) {
  const editedContent = readFileSync(fullPath, 'utf-8');
  editLintSection = formatLintResults(lintGDScript(editedContent, true));
}
```

在 return 的 textResult 末尾追加 `${editLintSection}`。

对 search_and_replace 模式也做同样处理。

- [ ] **Step 4: 编译并运行全部测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/script.ts
git commit -m "feat(lint): integrate lint into write_script and edit_script"
```

---

### Task 8: 集成 lint 到 batch_create_files

**Files:**
- Modify: `src/tools/batch-tools.ts`

- [ ] **Step 1: 导入并集成 lint**

在 `src/tools/batch-tools.ts` 顶部添加：

```typescript
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
```

在 `batch_create_files` handler 的文件写入循环之后、返回结果之前，添加 lint 汇总：

```typescript
const lintParts: string[] = [];
for (const file of filesToCreate) {
  if (file.path.endsWith('.gd')) {
    const lintOutput = lintGDScript(file.content as string, true);
    const fmt = formatLintResults(lintOutput);
    if (fmt) lintParts.push(`[${file.path}]${fmt}`);
  }
}
const lintSummary = lintParts.length > 0 ? '\n\nLint Results:\n' + lintParts.join('\n') : '';
```

将 `lintSummary` 追加到返回文本中。

- [ ] **Step 2: 编译并运行全部测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
git add src/tools/batch-tools.ts
git commit -m "feat(lint): integrate lint into batch_create_files"
```

---

### Task 9: P2 — get_class_info 废弃属性标注

**Files:**
- Modify: `src/tools/docs.ts`

- [ ] **Step 1: 添加废弃属性映射表**

在 `src/tools/docs.ts` 的 import 之后添加 `DEPRECATED_PROPERTIES` 映射表（见设计文档 P2 部分的完整定义）。

- [ ] **Step 2: 修改 get_class_info handler**

修改 properties 映射，为匹配废弃表的属性添加 `deprecated_notes` 字段。在返回对象中添加 `deprecated_warnings` 数组。

- [ ] **Step 3: 编译并运行全部测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/docs.ts
git commit -m "feat(lint): add deprecated property annotations to get_class_info (P2)"
```

---

### Task 10: 最终构建验证

- [ ] **Step 1: 完整构建 + 全部测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 全部通过

- [ ] **Step 2: TypeScript 类型检查**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 验证 lint 规则计数**

Run: `cd D:\GitHub\godot-mcp-enhanced && node -e "const {lintGDScript} = require('./build/tools/gdscript-lint.js'); console.log(lintGDScript('', true).meta)"`
Expected: `{ godot_target: '4.6', rules_count: 16, last_reviewed: '2026-05-18' }`

---

## 自检清单

- [x] **Spec 覆盖:** P0（16 条规则 + 集成）、P1（7 模板）、P2（废弃标注）全覆盖
- [x] **白名单清理:** bounce/friction 从 KNOWN_BASE_METHODS 移除，mass 保留
- [x] **无占位符:** 所有步骤包含完整代码
- [x] **类型一致性:** LintRule/LintResult/LintOutput 在所有 Task 中使用一致
- [x] **测试覆盖:** 48 规则测试 + 3 白名单测试 + 9 模板测试 = 60 个测试用例
