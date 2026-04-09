/**
 * GDScript executor module for Godot MCP Enhanced.
 *
 * Enables execution of arbitrary GDScript code in a headless Godot process.
 * Inspired by Hastur Operation Plugin's remote execution design:
 * - Code snippet auto-wrapping (no `extends` → auto-wrap)
 * - Structured key-value output via `_mcp_output(key, value)`
 * - Marked output protocol for reliable parsing
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutputEntry {
  key: string;
  value: string;
}

export interface ExecuteGdscriptResult {
  success: boolean;
  compile_success: boolean;
  compile_error: string;
  run_success: boolean;
  run_error: string;
  outputs: OutputEntry[];
  raw_output: string;
  duration_ms: number;
}

export interface ExecuteGdscriptOptions {
  godotPath: string;
  projectPath: string;
  code: string;
  timeout: number; // seconds
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TMP_PREFIX = 'godot-mcp-exec-';
const MARKER_RESULT = '___MCP_RESULT___';
const MARKER_ERROR = '___MCP_ERROR___';

// ─── Temp file helpers ──────────────────────────────────────────────────────

function getTempDir(): string {
  const dir = join(tmpdir(), 'godot-mcp-exec');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupOldTempFiles(): void {
  const dir = getTempDir();
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  try {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith(TMP_PREFIX)) continue;
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        rmSync(filePath, { force: true });
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

function writeTempScript(code: string): string {
  cleanupOldTempFiles();
  const id = Math.random().toString(36).substring(2, 10);
  const filePath = join(getTempDir(), `${TMP_PREFIX}${id}.gd`);
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

// ─── Code wrapping ──────────────────────────────────────────────────────────

/**
 * Detect if the code is a "full class" (contains `extends`)
 * or a "snippet" that needs auto-wrapping.
 */
function isFullClass(code: string): boolean {
  // Match `extends` at the start of a line (ignoring whitespace and comments)
  return /^\s*extends\s+/m.test(code);
}

/**
 * Wrap a snippet into a valid `extends SceneTree` script with helper functions.
 * Uses `_initialize()` which runs after the SceneTree is fully set up.
 */
function wrapSnippet(code: string): string {
  const lines = code.split('\n');
  const indented = lines.map(l => '\t' + l).join('\n');

  return `extends SceneTree

var _mcp_outputs: Array = []

func _mcp_output(key: String, value: Variant) -> void:
\t_mcp_outputs.append({"key": key, "value": str(value)})

func _initialize():
\tvar _mcp_success: bool = true
\tvar _mcp_error: String = ""
${indented}
\tif _mcp_success:
\t\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
\tquit()
`;
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  const helperLines = [
    '',
    'var _mcp_outputs: Array = []',
    '',
    'func _mcp_output(key: String, value: Variant) -> void:',
    '\t_mcp_outputs.append({"key": key, "value": str(value)})',
    '',
  ];

  const result = [...lines.slice(0, extendsIdx + 1), ...helperLines, ...lines.slice(extendsIdx + 1)];
  return result.join('\n');
}

// ─── Output parsing ─────────────────────────────────────────────────────────

function parseMcpMarkers(raw: string): {
  parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null;
  logLines: string[];
} {
  const lines = raw.split('\n');
  const logLines: string[] = [];
  let parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MARKER_RESULT)) {
      try {
        parsed = JSON.parse(trimmed.substring(MARKER_RESULT.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON: ' + trimmed };
      }
    } else if (trimmed.startsWith(MARKER_ERROR)) {
      try {
        parsed = JSON.parse(trimmed.substring(MARKER_ERROR.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON: ' + trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  return { parsed, logLines };
}

// ─── Main execution function ────────────────────────────────────────────────

export async function executeGdscript(
  options: ExecuteGdscriptOptions
): Promise<ExecuteGdscriptResult> {
  const { godotPath, projectPath, code, timeout = 30 } = options;
  const startTime = Date.now();

  // Prepare script content
  let scriptContent: string;
  if (isFullClass(code)) {
    scriptContent = injectHelpers(code);
  } else {
    scriptContent = wrapSnippet(code);
  }

  // Write temp file
  let tempFile: string;
  try {
    tempFile = writeTempScript(scriptContent);
  } catch (err) {
    return {
      success: false,
      compile_success: false,
      compile_error: `Failed to write temp script: ${err}`,
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: Date.now() - startTime,
    };
  }

  // Spawn Godot process
  return new Promise<ExecuteGdscriptResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(godotPath, [
      '--headless',
      '--path', projectPath,
      '--script', tempFile,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      // Cleanup temp file
      try { rmSync(tempFile, { force: true }); } catch { /* ignore */ }

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput);

      if (parsed) {
        const isSuccess = parsed.success === true;
        // Detect compile errors from Godot output
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;

        resolve({
          success: isSuccess && !hasCompileError,
          compile_success: !hasCompileError,
          compile_error: compileError,
          run_success: isSuccess,
          run_error: parsed.error || '',
          outputs: (parsed.outputs || []) as OutputEntry[],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
        });
      } else {
        // No marker found — likely a compile error or crash
        const compileError = extractCompileError(rawOutput);
        resolve({
          success: false,
          compile_success: compileError.length === 0,
          compile_error: compileError,
          run_success: false,
          run_error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
          outputs: [],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { rmSync(tempFile, { force: true }); } catch { /* ignore */ }

      resolve({
        success: false,
        compile_success: false,
        compile_error: `Failed to spawn Godot: ${err.message}`,
        run_success: false,
        run_error: '',
        outputs: [],
        raw_output: '',
        duration_ms: Date.now() - startTime,
      });
    });
  });
}

/**
 * Extract compile error from Godot output.
 * Godot prints errors like: "scripts/gdscript/gdscript.cpp:123 - Parse Error: ..."
 */
function extractCompileError(raw: string): string {
  const lines = raw.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('Parse Error:') || trimmed.includes('Script Error:') || trimmed.includes('ERROR:')) {
      // Skip our own markers
      if (trimmed.startsWith(MARKER_ERROR)) continue;
      errors.push(trimmed);
    }
  }
  return errors.join('\n');
}
