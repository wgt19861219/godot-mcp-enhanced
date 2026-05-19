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
    const matchIndex = match.index!;
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
