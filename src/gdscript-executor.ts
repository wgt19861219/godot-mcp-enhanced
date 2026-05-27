/**
 * GDScript executor module for Godot MCP Enhanced.
 *
 * Enables execution of arbitrary GDScript code in a headless Godot process.
 * Inspired by Hastur Operation Plugin's remote execution design:
 * - Code snippet auto-wrapping (no `extends` → auto-wrap)
 * - Structured key-value output via `_mcp_output(key, value)`
 * - Marked output protocol for reliable parsing
 *
 * SECURITY WARNING: GDScript has full system access (FileAccess, DirAccess,
 * OS.execute). There is NO sandbox or code audit layer. This is acceptable for
 * local MCP usage (editor on the same machine), but MUST NOT be exposed to
 * untrusted remote connections without an external sandbox.
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, mkdtempSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { analyzeOutput, type ParsedError } from './error-analyzer.js';
import { forceKillTree } from './core/process-state.js';
import { buildSafeEnv } from './helpers.js';


// ─── Sandbox scanner (C-SEC-02) ──────────────────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /OS\.(execute|shell_open|kill|set_restart_on_exit|crash)\b/, label: 'OS system command' },
  { pattern: /DirAccess\.(remove_absolute|remove)\b/, label: 'Directory removal' },
  { pattern: /FileAccess\.open\s*\([^)]*WRITE/, label: 'File write access' },
  { pattern: /Engine\.(set_singleton)\b/, label: 'Engine singleton modification' },
];

/** Best-effort scan for dangerous GDScript patterns. Returns warnings array. */
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX !== 'strict') return [];
  const warnings: string[] = [];
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }
  return warnings;
}

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

/** Generate a random per-execution marker prefix to prevent forgery. */
function generateMarker(): string {
  return `__MCP_${randomUUID().replace(/-/g, '').substring(0, 16)}__`;
}

// ─── Temp file helpers ──────────────────────────────────────────────────────

const BASE_TMP_DIR = join(tmpdir(), 'godot-mcp-exec');
let baseDirReady = false;

function ensureBaseDir(): void {
  if (baseDirReady) return;
  mkdirSync(BASE_TMP_DIR, { recursive: true, mode: 0o700 });
  baseDirReady = true;
}

/** Create an isolated session directory for one execution */
function createSessionDir(): string {
  ensureBaseDir();
  return mkdtempSync(join(BASE_TMP_DIR, `${TMP_PREFIX}`));
}

/** Background cleanup: remove session dirs older than 1 hour */
function cleanupOldSessions(): void {
  if (!baseDirReady) return;
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const entry of readdirSync(BASE_TMP_DIR)) {
      if (!entry.startsWith(TMP_PREFIX)) continue;
      const dirPath = join(BASE_TMP_DIR, entry);
      const stat = lstatSync(dirPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && now - stat.mtimeMs > maxAge) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    }
  } catch (err) { console.debug('[executor] cleanup stale dirs:', err); }
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
export function isFullClass(code: string): boolean {
  // Match `extends` at the start of a line (ignoring whitespace and comments)
  return /^\s*extends\s+/m.test(code);
}

/**
 * Wrap a snippet into a valid `extends SceneTree` script with helper functions.
 * Splits user code into declarations (class-level) and statements (inside _initialize).
 * This allows func/var/const definitions to work correctly at class scope.
 */
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT): string {
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

  // Build via array join — prevents JS template interpolation of user code
  const scriptLines: string[] = [
    'extends SceneTree',
    '## MCP snippet mode \u2014 autoloads are NOT available unless load_autoloads=true',
    '## Use Variant type for variables to avoid "Cannot infer type" errors',
    '',
    'var _mcp_outputs: Array = []',
    'var _mcp_root: Node = null',
    '',
    'func _mcp_get_root() -> Node:',
    '\tif _mcp_root != null:',
    '\t\treturn _mcp_root',
    '\tif root != null:',
    '\t\t_mcp_root = root',
    '\t\treturn _mcp_root',
    '\tvar ml: Variant = Engine.get_main_loop()',
    '\tif ml != null and ml is SceneTree and ml.root != null:',
    '\t\t_mcp_root = ml.root',
    '\t\treturn _mcp_root',
    '\treturn null',
    '',
    'func _mcp_get_node(path: NodePath) -> Node:',
    '\tvar _p: String = str(path)',
    '\tif _p.begins_with("/"):',
    '\t\t_p = _p.substr(1)',
    '\tvar _r: Node = _mcp_get_root()',
    '\tif _r == null:',
    '\t\treturn null',
    '\t# Fallback: root.get_node() may fail in headless _initialize()',
    '\tvar _node: Node = _r.get_node_or_null(_p)',
    '\tif _node != null:',
    '\t\treturn _node',
    '\t# Manual traversal for headless compatibility',
    '\tvar _parts: PackedStringArray = _p.split("/")',
    '\t_node = _r',
    '\tfor _part in _parts:',
    '\t\tif _part == "" or _part == "root":',
    '\t\t\tcontinue',
    '\t\tvar _found: bool = false',
    '\t\tfor _ch in _node.get_children():',
    '\t\t\tif _ch.name == _part:',
    '\t\t\t\t_node = _ch',
    '\t\t\t\t_found = true',
    '\t\t\t\tbreak',
    '\t\tif not _found:',
    '\t\t\treturn null',
    '\treturn _node',
    'func _mcp_load_main_scene() -> void:',
    '\tvar _r: Node = _mcp_get_root()',
    '\tif _r == null:',
    '\t\treturn',
    '\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")',
    '\tif _sp != null and _sp != "":',
    '\t\tvar _sr = load(_sp)',
    '\t\tif _sr:',
    '\t\t\t_r.add_child(_sr.instantiate())',
    '',
    'func _mcp_output(key: String, value: Variant) -> void:',
    '\t_mcp_outputs.append({"key": key, "value": str(value)})',
  ];

  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    scriptLines.push('');
    scriptLines.push(...declarationLines);
    scriptLines.push('');
  }

  scriptLines.push(
    'func _initialize():',
    '\t_mcp_load_main_scene()',
  );

  if (statementLines.length > 0) {
    for (const l of statementLines) {
      scriptLines.push('\t' + l);
    }
  }

  scriptLines.push(
    '\t\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\t\tif Engine.get_main_loop() == self:',
    '\t\t\tquit(0)',
  );

  return scriptLines.join('\n') + '\n';
}

/**
 * Wrap a snippet as `extends Node` for autoload mode.
 * The loader scene instantiates this via .new(), so it must be a Node subclass.
 */
export function wrapSnippetAsNode(code: string, resultMarker = MARKER_RESULT): string {
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

  // Rename user's _initialize to _mcp_user_init to avoid collision with our _initialize
  for (let i = 0; i < declarationLines.length; i++) {
    declarationLines[i] = declarationLines[i].replace(/func _initialize\(/g, "func _mcp_user_init(");
  }
  const hasUserInit = /func _mcp_user_init\(/.test(declarationLines.join('\n'));

  // Build via array join — prevents JS template interpolation of user code
  const nodeLines: string[] = [
    'extends Node',
    '## MCP autoload snippet mode \u2014 runs as Node child in loader scene',
    '',
    'var _mcp_outputs: Array = []',
    '',
    'func _mcp_output(key: String, value: Variant) -> void:',
    '\t_mcp_outputs.append({"key": key, "value": str(value)})',
  ];

  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    nodeLines.push('');
    nodeLines.push(...declarationLines);
    nodeLines.push('');
  }

  nodeLines.push('func _initialize() -> void:');
  if (statementLines.length > 0) {
    for (const l of statementLines) {
      nodeLines.push('\t' + l);
    }
  }
  if (hasUserInit) {
    nodeLines.push('\t_mcp_user_init()');
  }
  nodeLines.push(
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tget_tree().quit(0)',
  );

  return nodeLines.join('\n') + '\n';
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
export function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  // Skip injection if the code already declares these helpers (exclude comment lines)
  const hasOutputsVar = lines.some(l => /^\s*var\s+_mcp_outputs\s*:/.test(l) && !l.trim().startsWith('#'));
  const hasOutputFunc = lines.some(l => /^\s*func\s+_mcp_output\s*\(/.test(l) && !l.trim().startsWith('#'));

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

export function parseMcpMarkers(raw: string, resultMarker = MARKER_RESULT, errorMarker = MARKER_ERROR): {
  parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null;
  logLines: string[];
} {
  const lines = raw.split('\n');
  const logLines: string[] = [];
  let parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON: ' + trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
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

  // Hard kill switch: set ALLOW_EXECUTE_GDSCRIPT=false to disable GDScript execution
  if (process.env.ALLOW_EXECUTE_GDSCRIPT === 'false') {
    return { success: false, compile_success: false, compile_error: 'GDScript execution is disabled (ALLOW_EXECUTE_GDSCRIPT=false)', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }

  // C-SEC-02: Sandbox warning scan (does NOT block execution)
  const sandboxWarnings = scanGdscriptSandbox(code);
  if (sandboxWarnings.length > 0) {
    console.warn('[executor] Sandbox warnings for submitted code:');
    for (const w of sandboxWarnings) {
      console.warn('  ' + w);
    }
  }

  // Validate godotPath exists and looks like a Godot binary
  if (!existsSync(godotPath)) {
    return { success: false, compile_success: false, compile_error: `Godot binary not found: ${godotPath}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }
  const binName = basename(godotPath).toLowerCase();
  if (!binName.includes('godot')) {
    return { success: false, compile_success: false, compile_error: `Binary does not appear to be Godot: ${basename(godotPath)}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }

  // C-01: Generate random per-execution markers to prevent user code forgery
  const rndResult = generateMarker();
  const rndError = generateMarker();

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
      scriptContent = wrapSnippet(strippedCode, rndResult);
    }
  } else if (loadAutoloads) {
    scriptContent = wrapSnippetAsNode(code, rndResult);
  } else {
    scriptContent = wrapSnippet(code, rndResult);
  }

  // C-09: For injectHelpers path, replace fixed markers with random ones
  // (wrapSnippet paths already use random markers via template parameter)
  scriptContent = scriptContent.replaceAll(MARKER_RESULT, rndResult);
  scriptContent = scriptContent.replaceAll(MARKER_ERROR, rndError);

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
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.debug('[executor] cleanup session on error:', e); }
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

    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB output limit
    let outputExceeded = false;

    const proc = spawn(godotPath, godotArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });

    proc.stdout?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stdout += d.toString();
      if (Buffer.byteLength(stdout, 'utf-8') > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        stdout += '\n[OUTPUT TRUNCATED: exceeded 10MB limit]';
        forceKillTree(proc);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stderr += d.toString();
      if (Buffer.byteLength(stderr, 'utf-8') > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        stderr += '\n[OUTPUT TRUNCATED: exceeded 10MB limit]';
        forceKillTree(proc);
      }
    });

    const timer = setTimeout(() => {
      if (!proc.killed) {
        forceKillTree(proc);
      }
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      // Cleanup session directory
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.debug('[executor] cleanup session on close:', e); }

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput, rndResult, rndError);
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
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.debug('[executor] cleanup session on proc error:', e); }

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
export function createAutoloadLoaderScene(loaderScriptPath: string): string {
  const loaderPathRes = loaderScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="' + loaderPathRes + '" id="1"]',
    '',
    '[node name="MCPLoader" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n');
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
export function createAutoloadLoaderScript(userScriptPath: string): string {
  const pathRes = userScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tvar user_script: GDScript = load("' + pathRes + '") as GDScript',
    '\tif user_script == null:',
    '\t\tprint("___MCP_ERROR___" + JSON.stringify({"success": false, "error": "Failed to load user script"}))',
    '\t\tget_tree().quit(0)',
    '\t\treturn',
    '\tvar instance: Variant = user_script.new()',
    '\tif instance.has_method("_initialize"):',
    '\t\tinstance._initialize()',
    '\tget_tree().quit(0)',
  ].join('\n') + '\n';
}
