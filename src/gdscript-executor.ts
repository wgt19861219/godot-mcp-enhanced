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
import { writeFileSync, mkdirSync, rmSync, readdirSync, statSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
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

const BASE_TMP_DIR = join(tmpdir(), 'godot-mcp-exec');
mkdirSync(BASE_TMP_DIR, { recursive: true });

/** Create an isolated session directory for one execution */
function createSessionDir(): string {
  return mkdtempSync(join(BASE_TMP_DIR, `${TMP_PREFIX}`));
}

/** Background cleanup: remove session dirs older than 1 hour */
function cleanupOldSessions(): void {
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const entry of readdirSync(BASE_TMP_DIR)) {
      if (!entry.startsWith(TMP_PREFIX)) continue;
      const dirPath = join(BASE_TMP_DIR, entry);
      const stat = statSync(dirPath);
      if (stat.isDirectory() && now - stat.mtimeMs > maxAge) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    }
  } catch { /* ignore cleanup errors */ }
}

function writeTempScript(code: string, sessionDir: string): string {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}.gd`);
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

function writeSessionFile(content: string, ext: string, sessionDir: string): string {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}${ext}`);
  writeFileSync(filePath, content, 'utf-8');
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
 * Splits user code into declarations (class-level) and statements (inside _initialize).
 * This allows func/var/const definitions to work correctly at class scope.
 */
function wrapSnippet(code: string): string {
  const lines = code.split('\n');
  const declarationLines: string[] = [];
  const statementLines: string[] = [];

  let inFuncBody = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines go to statement group
    if (trimmed === '') {
      if (inFuncBody) {
        declarationLines.push(line);
      }
      continue;
    }

    // Comment-only lines at top level go to declarations
    if (trimmed.startsWith('#') && !inFuncBody) {
      declarationLines.push(line);
      continue;
    }

    // Top-level declarations: func, var, const, signal, enum, class_name, annotations
    // Only classify as declaration if the line starts at column 0 (no indentation).
    // Indented var/const inside if/while/for blocks are local, not class-level.
    if (/^[^\t ]/.test(line) && /^(func |static func |var |const |signal |enum |class_name |@export|@onready|@icon|@warning)/.test(trimmed)) {
      declarationLines.push(line);
      if (/^(static )?func /.test(trimmed)) {
        inFuncBody = true;
      }
      continue;
    }

    // Lines indented under a func declaration are part of that func body
    if (inFuncBody) {
      if (/^[^\t ]/.test(line) && !trimmed.startsWith('#')) {
        inFuncBody = false;
        // Fall through to statement classification below
      } else {
        declarationLines.push(line);
        continue;
      }
    }

    // Everything else is a statement
    statementLines.push(line);
  }

  const classBody = declarationLines.length > 0
    ? '\n' + declarationLines.join('\n') + '\n'
    : '';

  const initBody = statementLines.length > 0
    ? '\n' + statementLines.map(l => '\t' + l).join('\n')
    : '';

  return `extends SceneTree
## MCP snippet mode — autoloads are NOT available unless load_autoloads=true
## Use Variant type for variables to avoid "Cannot infer type" errors

var _mcp_outputs: Array = []
var _mcp_root: Node = null

func _mcp_get_root() -> Node:
\tif _mcp_root != null:
\t\treturn _mcp_root
\tif root != null:
\t\t_mcp_root = root
\t\treturn _mcp_root
\tvar ml: Variant = Engine.get_main_loop()
\tif ml != null and ml is SceneTree and ml.root != null:
\t\t_mcp_root = ml.root
\t\treturn _mcp_root
\treturn null

func _mcp_get_node(path: NodePath) -> Node:
\tvar _p: String = str(path)
\tif _p.begins_with("/"):
\t\t_p = _p.substr(1)
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn null
\t# Fallback: root.get_node() may fail in headless _initialize()
\tvar _node: Node = _r.get_node_or_null(_p)
\tif _node != null:
\t\treturn _node
\t# Manual traversal for headless compatibility
\tvar _parts: PackedStringArray = _p.split("/")
\t_node = _r
\tfor _part in _parts:
\t\tif _part == "" or _part == "root":
\t\t\tcontinue
\t\tvar _found: bool = false
\t\tfor _ch in _node.get_children():
\t\t\tif _ch.name == _part:
\t\t\t\t_node = _ch
\t\t\t\t_found = true
\t\t\t\tbreak
\t\tif not _found:
\t\t\treturn null
\treturn _node
func _mcp_load_main_scene() -> void:
\tvar _r: Node = _mcp_get_root()
\tif _r == null:
\t\treturn
\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
\tif _sp != null and _sp != "":
\t\tvar _sr = load(_sp)
\t\tif _sr:
\t\t\t_r.add_child(_sr.instantiate())

func _mcp_output(key: String, value: Variant) -> void:
\t_mcp_outputs.append({"key": key, "value": str(value)})
${classBody}
func _initialize():
\tvar _mcp_success: bool = true
\tvar _mcp_error: String = ""
\t_mcp_load_main_scene()${initBody}
\tif _mcp_success:
\t\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
\t\tif Engine.get_main_loop() == self:
\t\t\tquit(0)
`;
}

/**
 * Wrap a snippet as `extends Node` for autoload mode.
 * The loader scene instantiates this via .new(), so it must be a Node subclass.
 */
function wrapSnippetAsNode(code: string): string {
  const lines = code.split('\n');
  const declarationLines: string[] = [];
  const statementLines: string[] = [];

  let inFuncBody = false;
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      if (inFuncBody) {
        declarationLines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith('#') && !inFuncBody) {
      declarationLines.push(line);
      continue;
    }

    if (/^[^\t ]/.test(line) && /^(func |static func |var |const |signal |enum |class_name |@export|@onready|@icon|@warning)/.test(trimmed)) {
      declarationLines.push(line);
      if (/^(static )?func /.test(trimmed)) {
        inFuncBody = true;
      }
      continue;
    }

    if (inFuncBody) {
      if (/^[^\t ]/.test(line) && !trimmed.startsWith('#')) {
        inFuncBody = false;
      } else {
        declarationLines.push(line);
        continue;
      }
    }

    statementLines.push(line);
  }

  const classBody = declarationLines.length > 0
    ? '\n' + declarationLines.join('\n') + '\n'
    : '';

  const initBody = statementLines.length > 0
    ? '\n' + statementLines.map(l => '\t' + l).join('\n')
    : '';

  const safeBody = classBody.replace(/func _initialize\(/g, "func _mcp_user_init(");
  const hasUserInit = /func _mcp_user_init\(/.test(safeBody);
  const userInitCall = hasUserInit ? "\n\t_mcp_user_init()" : "";

  return `extends Node
## MCP autoload snippet mode — runs as Node child in loader scene

var _mcp_outputs: Array = []

func _mcp_output(key: String, value: Variant) -> void:
\t_mcp_outputs.append({"key": key, "value": str(value)})
${safeBody}
func _initialize() -> void:${initBody}${userInitCall}
	print("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
	get_tree().quit(0)
`;
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  // Skip injection if the code already declares these helpers (exclude comment lines)
  const hasOutputsVar = code.split('\n').some(l => /^\s*var\s+_mcp_outputs\s*:/.test(l) && !l.trim().startsWith('#'));
  const hasOutputFunc = code.split('\n').some(l => /^\s*func\s+_mcp_output\s*\(/.test(l) && !l.trim().startsWith('#'));

  const helperLines: string[] = [''];
  if (!hasOutputsVar) {
    helperLines.push('var _mcp_outputs: Array = []', '');
  }
  if (!hasOutputFunc) {
    helperLines.push('func _mcp_output(key: String, value: Variant) -> void:', '\t_mcp_outputs.append({"key": key, "value": str(value)})', '');
  }

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
  let loadAutoloads = options.loadAutoloads ?? false;
  const startTime = Date.now();

  // Prepare script content
  // Routing logic:
  // --script mode requires extends SceneTree/MainLoop
  // --scene (autoload) mode uses loader that calls .new(), requires extends Node
  // SceneTree-based scripts (using root/quit/get_node override) CANNOT run as Node,
  // so autoload mode is downgraded to --script for them.
  let scriptContent: string;
  if (isFullClass(code)) {
    const extendsSceneTree = /^\s*extends\s+(SceneTree|MainLoop)/m.test(code);
    if (extendsSceneTree) {
      // SceneTree scripts always use --script mode (root/quit API incompatible with Node)
      loadAutoloads = false;
      scriptContent = injectHelpers(code);
    } else if (loadAutoloads) {
      // Full class extending Node etc. with autoloads → inject helpers, loader calls .new()
      scriptContent = injectHelpers(code);
    } else {
      // Full class extending Node/etc. without autoloads → strip extends, wrap as SceneTree
      const strippedCode = code.replace(/^\s*extends\s+\S+.*\n?/m, '');
      scriptContent = wrapSnippet(strippedCode);
    }
  } else if (loadAutoloads) {
    scriptContent = wrapSnippetAsNode(code);
  } else {
    scriptContent = wrapSnippet(code);
  }

  // Create isolated session directory
  cleanupOldSessions();
  const sessionDir = createSessionDir();

  // Write temp file
  const tempFiles: string[] = [];
  let tempFile: string;
  try {
    tempFile = writeTempScript(scriptContent, sessionDir);
    tempFiles.push(tempFile);
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
    try {
      // Write loader script first to get its absolute path
      const loaderScriptPath = writeSessionFile(createAutoloadLoaderScript(tempFile), '.gd', sessionDir);
      tempFiles.push(loaderScriptPath);
      // Create scene referencing loader script by absolute path (not res://)
      const loaderScene = createAutoloadLoaderScene(loaderScriptPath);
      const loaderScenePath = writeSessionFile(loaderScene, '.tscn', sessionDir);
      tempFiles.push(loaderScenePath);
      godotArgs.push('--scene', loaderScenePath);
    } catch (err) {
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return {
        success: false,
        compile_success: false,
        compile_error: `Failed to create autoload loader files: ${err}`,
        errors: [],
        run_success: false,
        run_error: '',
        outputs: [],
        raw_output: '',
        duration_ms: Date.now() - startTime,
      };
    }
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

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        // SIGKILL fallback after 3s if SIGTERM didn't work (especially on Windows)
        killTimer = setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
      }
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Cleanup session directory
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }

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
        const hasCompileError = compileError.length > 0;
        // Safety net: if no real errors (only RID leak cleanup warnings),
        // the script likely ran but cleanup crashed before marker print
        if (!hasCompileError && exitCode !== 0) {
          const hasRealError = /\b(Parse Error|Script Error|SCRIPT ERROR)\b/.test(rawOutput);
          if (!hasRealError) {
            resolve({
              success: false,
              compile_success: true,
              compile_error: '',
              errors: analysis.errors,
              run_success: false,
              run_error: `Process exited with code ${exitCode} (likely RID leak during cleanup, no script error found)`,
              outputs: [],
              raw_output: logLines.join('\n'),
              duration_ms: duration,
            });
            return;
          }
        }
        resolve({
          success: false,
          compile_success: !hasCompileError,
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
      if (killTimer) clearTimeout(killTimer);
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }

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
    if (trimmed.includes('Parse Error:') || trimmed.includes('Script Error:')) {
      errors.push(trimmed);
    }
  }
  return errors.join('\n');
}

// ─── Autoload loader helpers ──────────────────────────────────────────────────

/**
 * Create a minimal .tscn scene that loads with autoload context.
 * The scene runs the user's script from _ready().
 */
function createAutoloadLoaderScene(loaderScriptPath: string): string {
  const loaderPathRes = loaderScriptPath.replace(/\\/g, '/');
  return `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="${loaderPathRes}" id="1"]

[node name="MCPLoader" type="Node"]
script = ExtResource("1")
`;
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
function createAutoloadLoaderScript(userScriptPath: string): string {
  const pathRes = userScriptPath.replace(/\\/g, '/');
  return `extends Node

func _ready() -> void:
\tvar user_script: GDScript = load("${pathRes}") as GDScript
\tif user_script == null:
\t\tprint("___MCP_ERROR___" + JSON.stringify({"success": false, "error": "Failed to load user script"}))
\t\tget_tree().quit(0)
\t\treturn
\tvar instance: Variant = user_script.new()
\tif instance.has_method("_initialize"):
\t\tinstance._initialize()
\tget_tree().quit(0)
`;
}
