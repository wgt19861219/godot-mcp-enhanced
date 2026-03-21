// Godot Error Analyzer Module
// Parses Godot runtime output and generates actionable fix suggestions

export interface ParsedError {
  type: 'script_error' | 'runtime_error' | 'parse_error' | 'null_reference' | 'type_error' | 'unknown';
  message: string;
  file?: string;
  line?: number;
  function?: string;
  suggestion: string;
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

// ===== Error pattern matchers =====

interface ErrorPattern {
  test: (msg: string) => boolean;
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
    test: (msg) => /Identifier "(\w+)" not found/.test(msg),
    type: 'script_error',
    suggestion: (msg) => {
      const match = msg.match(/Identifier "(\w+)" not found/);
      const ident = match ? match[1] : 'identifier';
      return `"${ident}" is not recognized. Check for typos, ensure the class/method is available, or verify the correct class_name/extends declaration.`;
    },
  },
  {
    test: (msg) => /too few arguments for function/.test(msg),
    type: 'script_error',
    suggestion: (msg) => {
      const match = msg.match(/function "(\w+)"/);
      const fn = match ? match[1] : 'the function';
      return `Missing arguments for "${fn}". Check the function signature and provide all required parameters.`;
    },
  },
  {
    test: (msg) => /too many arguments for function/.test(msg),
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
    suggestion: (msg) => {
      return `Array/Dictionary index out of bounds. Verify the index is within valid range: 0 <= index < size(). Add bounds checking before access.`;
    },
  },
  {
    test: (msg) => /File not found/.test(msg) || /can't open/.test(msg) || /Resource not found/.test(msg),
    type: 'runtime_error',
    suggestion: (msg) => {
      const match = msg.match(/(?:File not found|can't open|Resource not found):\s*(.+)/i);
      const path = match ? match[1].trim() : 'the resource';
      return `File/resource not found: ${path}. Check the path is correct and the file exists in the project.`;
    },
  },
  {
    test: (msg) => /Condition "!.*" is true/.test(msg) || /Condition ".*" is true/.test(msg),
    type: 'runtime_error',
    suggestion: (msg) => {
      const match = msg.match(/Condition "(.+?)" is true/);
      const cond = match ? match[1] : 'an internal condition';
      return `Internal assertion failed: ${cond}. This usually indicates invalid state or a bug in the logic leading to this call.`;
    },
  },
  {
    test: (msg) => /Stack trace/.test(msg) || /Traceback/.test(msg),
    type: 'unknown',
    suggestion: () => 'A stack trace was detected. Look at the preceding error messages for the root cause.',
  },
];

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
    const line = lines[i].trim();

    // at: res://path/to/script.gd:123
    const atMatch = line.match(/^(?:at|in):\s*(.+?)(?:\:(\d+))?$/);
    if (atMatch) {
      result.file = atMatch[1].trim();
      if (atMatch[2]) result.line = parseInt(atMatch[2], 10);
      break;
    }

    // at: <file>(<line>)
    const atMatch2 = line.match(/^(?:at|in):\s*(.+?)\((\d+)\)$/);
    if (atMatch2) {
      result.file = atMatch2[1].trim();
      result.line = parseInt(atMatch2[2], 10);
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

// ===== Main analyzer =====

export function analyzeOutput(output: string[]): AnalysisResult {
  const errors: ParsedError[] = [];
  const warnings: ParsedWarning[] = [];
  const prints: string[] = [];
  const suggestions: string[] = [];

  let i = 0;
  while (i < output.length) {
    const line = output[i];
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
      errors.push(error);
      suggestions.push(`[${loc.file || 'unknown'}:${loc.line || '?'}] ${error.suggestion}`);
      i++;
      continue;
    }

    // SCRIPT ERROR: <message>
    if (trimmed.match(/^SCRIPT ERROR:/i)) {
      const message = trimmed.replace(/^SCRIPT ERROR:\s*/i, '').trim();
      const loc = parseLocation(output, i);

      // Classify based on pattern
      let errorType: ParsedError['type'] = 'script_error';
      let suggestion = 'Review the script logic and ensure all variables and methods are correctly referenced.';

      for (const pattern of ERROR_PATTERNS) {
        if (pattern.type === 'parse_error') continue; // already handled above
        if (pattern.test(message)) {
          errorType = pattern.type;
          suggestion = pattern.suggestion(message);
          break;
        }
      }

      const error: ParsedError = {
        type: errorType,
        message,
        file: loc.file,
        line: loc.line,
        function: loc.func,
        suggestion,
      };
      errors.push(error);
      suggestions.push(`[${loc.file || 'unknown'}:${loc.line || '?'}] ${suggestion}`);
      i++;
      continue;
    }

    // ERROR: <message>
    if (trimmed.match(/^ERROR:/i)) {
      const message = trimmed.replace(/^ERROR:\s*/i, '').trim();
      const loc = parseLocation(output, i);

      let errorType: ParsedError['type'] = 'runtime_error';
      let suggestion = 'An engine error occurred. Check the Godot documentation for this error message.';

      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(message)) {
          errorType = pattern.type;
          suggestion = pattern.suggestion(message);
          break;
        }
      }

      const error: ParsedError = {
        type: errorType,
        message,
        file: loc.file,
        line: loc.line,
        function: loc.func,
        suggestion,
      };
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
  const parts: string[] = [];
  if (errors.length > 0) {
    parts.push(`${errors.length} error(s)`);
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
    hasErrors: errors.length > 0,
    errors,
    warnings,
    prints,
    suggestions: uniqueSuggestions,
    summary,
  };
}
