// Godot Error Analyzer Module
// Parses Godot runtime output and generates actionable fix suggestions

import { existsSync, readFileSync } from 'node:fs';
import { resolveWithinRoot, normalizeUserProjectPath } from './core/path-utils.js';

export interface ParsedError {
  type: 'script_error' | 'runtime_error' | 'parse_error' | 'null_reference' | 'type_error' | 'headless_limitation' | 'unknown';
  message: string;
  file?: string;
  line?: number;
  function?: string;
  suggestion: string;
  /** 出错行附近源码片段（带行号，出错行标 ">"）。仅当 options.projectPath 提供且 file 为 res:// 时填充。 */
  snippet?: string;
}

export interface ParsedWarning {
  message: string;
  file?: string;
  line?: number;
}

export interface AnalysisResult {
  hasErrors: boolean;
  errors: ParsedError[];
  warnings: ParsedWarning[];
  prints: string[];
  suggestions: string[];
  summary: string;
}

/** Options for analyzeOutput — callers can supply project context for better classification. */
export interface AnalyzeOptions {
  /** Autoload singleton names from project.godot [autoload] section.
   *  Errors referencing these names are reclassified as headless_limitation. */
  autoloadNames?: string[];
  /** Global class_name names from .godot/global_script_class_cache.cfg (S3, 2026-06-23).
   *  Errors referencing these are reclassified as headless_limitation — headless can't
   *  resolve cross-file class_name, producing the same "Identifier X not found" false
   *  positive as autoload. */
  classNames?: string[];
  /** 项目根路径。提供后对 res:// 错误文件读取源码片段附加到 ParsedError.snippet。 */
  projectPath?: string;
  /** snippet 上下文行数（出错行前后各 N 行），默认 3。 */
  snippetLines?: number;
}

// ===== Error pattern matchers =====

interface ErrorPattern {
  test: (msg: string, opts?: AnalyzeOptions) => boolean;
  type: ParsedError['type'];
  suggestion: (msg: string) => string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    test: (msg) => /Parameter "(\w+)" is null/.test(msg),
    type: 'null_reference',
    suggestion: (msg) => {
      const match = msg.match(/Parameter "(\w+)" is null/);
      const param = match ? match[1] : 'variable';
      return `Check that "${param}" is initialized before use. Use if ${param} != null: guard or assign a default value.`;
    },
  },
  {
    test: (msg) => /Invalid type in function/.test(msg),
    type: 'type_error',
    suggestion: (msg) => {
      const match = msg.match(/Invalid type in function "(\w+)".*Expected.*Got (\w+)/s);
      if (match) return `Function "${match[1]}" received type "${match[2]}" but expected a different type. Check the argument types passed to this function.`;
      return `A type mismatch occurred. Verify that all arguments match the expected types for the function call.`;
    },
  },
  {
    test: (msg) => /Parse Error/.test(msg),
    type: 'parse_error',
    suggestion: (msg) => {
      const detail = msg.replace(/SCRIPT ERROR:\s*Parse Error:\s*/i, '').trim();
      return `Syntax error: ${detail}. Check for missing colons, incorrect indentation, or typos in the script.`;
    },
  },
  {
    // Autoload singleton / global class_name not available in headless mode — must be BEFORE generic Identifier rule.
    // Note: matches any "Identifier XXX" error where XXX is an autoload name or global class_name,
    // not limited to "not found" — this is intentional: headless can't instantiate autoloads or
    // resolve cross-file class_name, so any reference to them (method calls, property access, etc.)
    // will fail and should be filtered.
    // S3 (2026-06-23): also matches class_name from .godot/global_script_class_cache.cfg.
    test: (msg, opts) => {
      if (!opts?.autoloadNames?.length && !opts?.classNames?.length) return false;
      const identMatch = msg.match(/Identifier\s+"(\w+)"/);
      if (!identMatch) return false;
      const name = identMatch[1]!;
      return (opts.autoloadNames?.includes(name) === true) || (opts.classNames?.includes(name) === true);
    },
    type: 'headless_limitation',
    suggestion: (msg) => {
      const identMatch = msg.match(/Identifier\s+"(\w+)"/);
      const name = identMatch ? identMatch[1] : 'global identifier';
      return `"${name}" is an autoload singleton or global class_name not available in headless mode. This error only occurs during headless validation (run_and_verify) and works correctly at runtime. Safe to ignore.`;
    },
  },
  {
    test: (msg) => /Identifier "(\w+)" not found/.test(msg),
    type: 'script_error',
    suggestion: (msg) => {
      const match = msg.match(/Identifier "(\w+)" not found/);
      const ident = match ? match[1] : 'identifier';
      return `"${ident}" is not recognized. Check for typos, ensure the class/method is available, or verify the correct class_name/extends declaration.`;
    },
  },
  {
    test: (msg) => /too few arguments for function/i.test(msg),
    type: 'script_error',
    suggestion: (msg) => {
      const match = msg.match(/function "(\w+)"/);
      const fn = match ? match[1] : 'the function';
      return `Missing arguments for "${fn}". Check the function signature and provide all required parameters.`;
    },
  },
  {
    test: (msg) => /too many arguments for function/i.test(msg),
    type: 'script_error',
    suggestion: (msg) => {
      const match = msg.match(/function "(\w+)"/);
      const fn = match ? match[1] : 'the function';
      return `Too many arguments for "${fn}". Remove extra parameters or check the function signature.`;
    },
  },
  {
    test: (msg) => /Index out of bounds/.test(msg),
    type: 'runtime_error',
    suggestion: (_msg) => {
      return `Array/Dictionary index out of bounds. Verify the index is within valid range: 0 <= index < size(). Add bounds checking before access.`;
    },
  },
  {
    test: (msg) => /File not found/.test(msg) || /can't open/.test(msg) || /Resource not found/.test(msg),
    type: 'runtime_error',
    suggestion: (msg) => {
      const match = msg.match(/(?:File not found|can't open|Resource not found):\s*(.+)/i);
      const path = match ? match[1]!.trim() : 'the resource';
      return `File/resource not found: ${path}. Check the path is correct and the file exists in the project.`;
    },
  },
  {
    test: (msg) => /get_tree/.test(msg) && /not (?:be )?found/.test(msg),
    type: 'script_error',
    suggestion: () => 'Godot 4.6+ 兼容性提示: 在 extends SceneTree 脚本中，请使用 self.root 代替 get_tree().root，使用 quit() 代替 get_tree().quit()',
  },
  {
    test: (msg) => /\broot\b/.test(msg) && /redefined/.test(msg),
    type: 'script_error',
    suggestion: () => "Godot 4.6+ 兼容性提示: 如果您在 extends SceneTree 脚本中，变量名 'root' 与 SceneTree.root 冲突，请改用其他名称如 scene_root 或 _root",
  },
  {
    test: (msg) => /texture_2d_get/.test(msg) && /null/.test(msg),
    type: 'headless_limitation',
    suggestion: () => 'SubViewport texture is null in headless mode. This is a known headless rendering limitation — the code works correctly on actual devices with a GPU. Safe to ignore when testing via run_and_verify.',
  },
  {
    test: (msg) => /Condition ".*p_canvas_item.*is true/.test(msg) || /Condition ".*p_viewport.*is true/.test(msg),
    type: 'headless_limitation',
    suggestion: () => 'Canvas/Viewport rendering assertion in headless mode. This is typically a headless-only issue caused by SubViewport or CanvasItem operations without a real rendering server. Safe to ignore on actual devices.',
  },
  {
    test: (msg) => /get_image\(\)/.test(msg) && /null/.test(msg),
    type: 'headless_limitation',
    suggestion: () => 'get_image() returned null, likely because SubViewport did not render in headless mode. Add a null check (if img == null: return) and test on a real device. This error does not occur with a GPU.',
  },
  {
    test: (msg) => /Condition "!.*" is true/.test(msg) || /Condition ".*" is true/.test(msg),
    type: 'runtime_error',
    suggestion: (msg) => {
      const match = msg.match(/Condition "(.+?)" is true/);
      const cond = match ? match[1]! : 'an internal condition';
      return `Internal assertion failed: ${cond}. This usually indicates invalid state or a bug in the logic leading to this call.`;
    },
  },
  {
    test: (msg) => /Stack trace/.test(msg) || /Traceback/.test(msg),
    type: 'unknown',
    suggestion: () => 'A stack trace was detected. Look at the preceding error messages for the root cause.',
  },
];

/** SCRIPT ERROR / ERROR 两分支共享的错误分类(2026-09-18 重复分析收敛):
 *  按 ERROR_PATTERNS 顺序首个命中即返回;全部未命中返回调用方给定的默认 type/suggestion。
 *  skipParseError=true 时跳过 parse_error pattern(SCRIPT ERROR 分支——parse error 已在上游独立处理)。 */
function classifyError(
  message: string,
  defaultType: ParsedError['type'],
  defaultSuggestion: string,
  options: AnalyzeOptions | undefined,
  skipParseError: boolean,
): { type: ParsedError['type']; suggestion: string } {
  for (const pattern of ERROR_PATTERNS) {
    if (skipParseError && pattern.type === 'parse_error') continue; // parse_error 已在上游处理
    if (pattern.test(message, options)) {
      return { type: pattern.type, suggestion: pattern.suggestion(message) };
    }
  }
  return { type: defaultType, suggestion: defaultSuggestion };
}

// ===== Location parser =====

interface ParsedLocation {
  file?: string;
  line?: number;
  func?: string;
}

function parseLocation(lines: string[], startIdx: number): ParsedLocation {
  const result: ParsedLocation = {};

  // Check "at: <file>(<line>)" on the next line(s)
  for (let i = startIdx + 1; i < Math.min(startIdx + 3, lines.length); i++) {
    const line = lines[i]!.trim();

    // at: res://path/to/script.gd:123
    const atMatch = line.match(/^(?:at|in):\s*(.+?)(?::(\d+))?$/);
    if (atMatch) {
      result.file = atMatch[1]!.trim();
      if (atMatch[2]) result.line = parseInt(atMatch[2], 10);
      break;
    }

    // at: <file>(<line>)
    const atMatch2 = line.match(/^(?:at|in):\s*(.+?)\((\d+)\)$/);
    if (atMatch2) {
      result.file = atMatch2[1]!.trim();
      result.line = parseInt(atMatch2[2]!, 10);
      break;
    }

    // Function context: _process, _ready, etc.
    if (!result.func) {
      const funcMatch = line.match(/in function ['"](\w+)['"]/);
      if (funcMatch) {
        result.func = funcMatch[1];
      }
    }

    // Stop if we hit another error or empty line
    if (line === '' || /^(SCRIPT ERROR|ERROR|WARNING):/.test(line)) break;
  }

  return result;
}

// ===== Source snippet =====

/** 读取 res:// 错误文件的出错行附近源码。非 res:// / 文件不存在 / 路径非法 → undefined（静默跳过）。 */
function buildSnippet(file: string | undefined, targetLine: number | undefined, projectPath: string, contextLines: number): string | undefined {
  if (!file || !file.startsWith('res://')) return undefined;
  if (targetLine === undefined || targetLine <= 0) return undefined;

  let absPath: string;
  try {
    absPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(file));
  } catch {
    return undefined; // 路径遍历/非法 → 跳过（resolveWithinRoot 5 层校验兜底）
  }

  let content: string;
  try {
    if (!existsSync(absPath)) return undefined;
    content = readFileSync(absPath, 'utf8');
  } catch {
    return undefined; // 编码/权限异常 → 跳过
  }

  const lines = content.split(/\r?\n/);
  const start = Math.max(0, targetLine - 1 - contextLines);
  const end = Math.min(lines.length, targetLine + contextLines);
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    const num = i + 1;
    const marker = num === targetLine ? '>' : ' ';
    parts.push(`${marker} ${num}: ${lines[i]}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 若 options.projectPath 提供，给 error 附加 snippet。无 projectPath 或无法读取时 no-op。 */
function enrichWithSnippet(error: ParsedError, options?: AnalyzeOptions): void {
  if (!options?.projectPath || !error.file || !error.line || error.line <= 0) return;
  const snippet = buildSnippet(error.file, error.line, options.projectPath, options.snippetLines ?? 3);
  if (snippet) error.snippet = snippet;
}

// ===== Main analyzer =====

export function analyzeOutput(output: string[], options?: AnalyzeOptions): AnalysisResult {
  const errors: ParsedError[] = [];
  const warnings: ParsedWarning[] = [];
  const prints: string[] = [];
  const suggestions: string[] = [];

  let i = 0;
  while (i < output.length) {
    const line = output[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // SCRIPT ERROR: Parse Error: <message>
    if (trimmed.match(/^SCRIPT ERROR:\s*Parse Error:/i)) {
      const message = trimmed.replace(/^SCRIPT ERROR:\s*Parse Error:\s*/i, '').trim();
      const loc = parseLocation(output, i);
      const error: ParsedError = {
        type: 'parse_error',
        message,
        file: loc.file,
        line: loc.line,
        function: loc.func,
        suggestion: `Syntax error: ${message}. Check for missing colons, incorrect indentation, or typos.`,
      };
      enrichWithSnippet(error, options);
      errors.push(error);
      suggestions.push(`[${loc.file || 'unknown'}:${loc.line || '?'}] ${error.suggestion}`);
      i++;
      continue;
    }

    // SCRIPT ERROR: <message>
    if (trimmed.match(/^SCRIPT ERROR:/i)) {
      const message = trimmed.replace(/^SCRIPT ERROR:\s*/i, '').trim();
      const loc = parseLocation(output, i);

      const { type: errorType, suggestion } = classifyError(
        message,
        'script_error',
        'Review the script logic and ensure all variables and methods are correctly referenced.',
        options,
        true,
      );

      const error: ParsedError = {
        type: errorType,
        message,
        file: loc.file,
        line: loc.line,
        function: loc.func,
        suggestion,
      };
      enrichWithSnippet(error, options);
      errors.push(error);
      suggestions.push(`[${loc.file || 'unknown'}:${loc.line || '?'}] ${suggestion}`);
      i++;
      continue;
    }

    // ERROR: <message>
    if (trimmed.match(/^ERROR:/i)) {
      const message = trimmed.replace(/^ERROR:\s*/i, '').trim();
      const loc = parseLocation(output, i);

      const { type: errorType, suggestion } = classifyError(
        message,
        'runtime_error',
        'An engine error occurred. Check the Godot documentation for this error message.',
        options,
        false,
      );

      const error: ParsedError = {
        type: errorType,
        message,
        file: loc.file,
        line: loc.line,
        function: loc.func,
        suggestion,
      };
      enrichWithSnippet(error, options);
      errors.push(error);
      suggestions.push(`[${loc.file || 'unknown'}:${loc.line || '?'}] ${suggestion}`);
      i++;
      continue;
    }

    // WARNING: <message>
    if (trimmed.match(/^WARNING:/i)) {
      const message = trimmed.replace(/^WARNING:\s*/i, '').trim();
      const loc = parseLocation(output, i);
      warnings.push({
        message,
        file: loc.file,
        line: loc.line,
      });
      i++;
      continue;
    }

    // Regular output (print statements, engine info)
    prints.push(trimmed);
    i++;
  }

  // Deduplicate suggestions
  const uniqueSuggestions = [...new Set(suggestions)];

  // Build summary
  const headlessLimitations = errors.filter(e => e.type === 'headless_limitation');
  const realErrors = errors.filter(e => e.type !== 'headless_limitation');
  const parts: string[] = [];
  if (realErrors.length > 0) {
    parts.push(`${realErrors.length} error(s)`);
  }
  if (headlessLimitations.length > 0) {
    parts.push(`${headlessLimitations.length} headless limitation(s) (safe to ignore on real devices)`);
  }
  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning(s)`);
  }
  if (prints.length > 0) {
    parts.push(`${prints.length} print line(s)`);
  }

  const summary = parts.length > 0
    ? `Analysis complete: ${parts.join(', ')}.`
    : 'No errors, warnings, or output found.';

  return {
    hasErrors: realErrors.length > 0,
    errors,
    warnings,
    prints,
    suggestions: uniqueSuggestions,
    summary,
  };
}
