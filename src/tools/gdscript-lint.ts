// See deprecated-properties.ts for the canonical deprecated property list

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
  const lines = code.split(/\r?\n/);

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
  const lines = code.split(/\r?\n/);
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

function hasTypeContext(precedingLines: string[], typeNames: string[]): boolean {
  const codeLines = precedingLines.filter(l => !l.trimStart().startsWith('#'));
  const text = codeLines.join('\n');
  return typeNames.some(t => text.includes(t));
}

// ─── Lint Metadata ──────────────────────────────────────────────────────────

const LINT_VERSION = {
  godot_target: "4.6",
  last_reviewed: "2026-05-18",
  rules_count: 16,
};

// ─── RULES (populated in Tasks 2-4) ────────────────────────────────────────

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
    pattern: /SoftBody3D\w*\.mass\s*=/,
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
    pattern: /\bget_child_or_null\s*\(/,
    message: "Node.get_child_or_null() 在 Godot 4.x 中已移除，使用 get_child() 或 find_child()",
    suggestion: "使用 get_child(index) 或 find_child(\"name\")",
  },
  // L010: FogMaterial.albedo_color
  {
    id: "L010",
    severity: "error",
    pattern: /FogMaterial\w*\.albedo_color\s*=/,
    message: "FogMaterial.albedo_color 在 Godot 4 中已重命名为 albedo",
    suggestion: "使用 fog.albedo = Color.RED",
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
    pattern: /CharacterBody\w*\.body_entered/,
    message: "CharacterBody3D 不提供 body_entered 信号，应使用 Area3D 子节点进行碰撞检测",
    suggestion: "添加 Area3D 子节点并连接其 body_entered/body_exited 信号",
  },
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
];

// ─── Main Lint Function ────────────────────────────────────────────────────

export function lintGDScript(code: string): LintOutput {
  const errors: LintResult[] = [];
  const warnings: LintResult[] = [];
  const lines = code.split(/\r?\n/);
  const functions = extractFunctions(code);

  for (const rule of RULES) {
    if (rule.isCallOrder) {
      lintCallOrder(rule, functions, errors, warnings);
    } else {
      lintRegex(rule, code, lines, errors, warnings);
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
          if (/\.look_at\s*\(/.test(body) && /RigidBody3D|RigidBody2D/.test(body)) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L016": {
        // L016: Only detects variable-based patterns: add_child(var) followed by var.method()
        // Does not detect inline: add_child(SomeClass.new()) — no variable to access
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

function lintRegex(
  rule: LintRule,
  code: string,
  lines: string[],
  errors: LintResult[],
  warnings: LintResult[],
): void {
  // Precompute line start offsets
  const lineOffsets = new Uint32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i + 1] = lineOffsets[i] + lines[i].length + 1;
  }
  const globalPattern = rule.pattern.global
    ? rule.pattern
    : new RegExp(rule.pattern.source, 'g');

  let match: RegExpMatchArray | null;
  while ((match = globalPattern.exec(code)) !== null) {
    const matchIndex = match.index!;
    // Binary search on lineOffsets to find 1-based line number
    let lo = 0, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineOffsets[mid] <= matchIndex) lo = mid + 1;
      else hi = mid;
    }
    const lineNum = lo;
    const lineText = lines[lineNum - 1] || '';

    const lineOffset = matchIndex - lineOffsets[lineNum - 1];

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
