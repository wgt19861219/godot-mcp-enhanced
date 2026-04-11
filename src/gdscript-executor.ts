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
import { analyzeOutput, type ParsedError } from './error-analyzer.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutputEntry {
  key: string;
  value: string;
}

export interface ExecuteGdscriptResult {
  success: boolean;
  compile_success: boolean;
  compile_error: string;
  /** Structured error list with type, file, line, message, and suggestion */
  errors: ParsedError[];
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
  /** When true, runs with full autoload context (slower but can access autoloads like DataRegistry) */
  loadAutoloads?: boolean;
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
 * Uses Variant types to avoid strict type inference issues with load().new() etc.
 */
function wrapSnippet(code: string): string {
  const lines = code.split('\n');
  const indented = lines.map(l => '\t' + l).join('\n');

  return `extends SceneTree
## MCP snippet mode — autoloads are NOT available unless load_autoloads=true
## Use Variant type for variables to avoid "Cannot infer type" errors

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
  const { godotPath, projectPath, code, timeout = 30, loadAutoloads = false } = options;
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
      errors: [],
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: Date.now() - startTime,
    };
  }

  // Build Godot arguments
  const godotArgs: string[] = ['--headless', '--path', projectPath];
  if (loadAutoloads) {
    // Autoload mode: create a loader scene that initializes all autoloads first
    const loaderScene = createAutoloadLoaderScene(tempFile);
    const loaderScenePath = writeTempFile(loaderScene, '.tscn');
    const loaderScriptPath = writeTempFile(createAutoloadLoaderScript(tempFile), '.gd');
    godotArgs.push('--scene', loaderScenePath);
    // Store both for cleanup
    (tempFile as any) = JSON.stringify([tempFile, loaderScenePath, loaderScriptPath]);
  } else {
    godotArgs.push('--script', tempFile);
  }

  // Spawn Godot process
  return new Promise<ExecuteGdscriptResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(godotPath, godotArgs, {
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
      // Cleanup temp files
      try {
        // Handle both single file and multiple files (autoload mode)
        if (typeof tempFile === 'string' && tempFile.startsWith('[')) {
          const files: string[] = JSON.parse(tempFile);
          for (const f of files) { rmSync(f, { force: true }); }
        } else {
          rmSync(tempFile, { force: true });
        }
      } catch { /* ignore */ }

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput);
      const analysis = analyzeOutput(logLines);

      if (parsed) {
        const isSuccess = parsed.success === true;
        // Detect compile errors from Godot output
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;

        resolve({
          success: isSuccess && !hasCompileError,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
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
          errors: analysis.errors,
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
        errors: [],
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

// ─── Autoload loader helpers ──────────────────────────────────────────────────

/**
 * Write a temp file with custom extension (.tscn or .gd)
 */
function writeTempFile(content: string, ext: string): string {
  const dir = getTempDir();
  const id = Math.random().toString(36).substring(2, 10);
  const filePath = join(dir, `${TMP_PREFIX}loader-${id}${ext}`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Create a minimal .tscn scene that loads with autoload context.
 * The scene runs the user's script from _ready().
 */
function createAutoloadLoaderScene(scriptPath: string): string {
  const scriptPathRes = scriptPath.replace(/\\/g, '/');
  return `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://__mcp_loader__.gd" id="1"]

[node name="MCPLoader" type="Node"]
script = ExtResource("1")
_metadata/mcp_script_path = "${scriptPathRes}"
`;
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
function createAutoloadLoaderScript(_scriptPath: string): string {
  return `extends Node

var _mcp_outputs: Array = []

func _mcp_output(key: String, value: Variant) -> void:
\t_mcp_outputs.append({"key": key, "value": str(value)})

func _ready() -> void:
\t# Autoloads are fully initialized at this point
\t# Load and execute user code dynamically
\tvar script_path: String = get_meta("mcp_script_path")
\tvar user_script: GDScript = load(script_path) as GDScript
\tif user_script == null:
\t\tprint("___MCP_ERROR___" + JSON.stringify({"success": false, "error": "Failed to load user script: " + script_path}))
\t\tget_tree().quit()
\t\treturn
\t# Execute user code by creating instance and calling _initialize if available
\tvar instance: Variant = user_script.new()
\tif instance has_method("_initialize"):
\t\tinstance._initialize()
\telif instance has_method("_ready"):
\t\tpass  # SceneTree _initialize already ran
\tget_tree().quit()
`;
}
