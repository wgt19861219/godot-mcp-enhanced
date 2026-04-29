import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname, basename, isAbsolute, extname } from 'path';
import { tmpdir } from 'os';
import { parseTscn, parseTscnSummary, type ParsedScene } from './tscn-parser.js';
import {
  editNodeProperty,
  deleteNode,
  addConnection,
  removeConnection,
  setNodeScript,
  changeNodeType,
} from './tscn-editor.js';
import {
  readResource as readResourceFile,
  writeResource as writeResourceFile,
  listResources as listResourceFiles,
} from './resource-manager.js';
import { copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  initDocs as initGodotDocs,
  getClassInfo,
  searchClasses,
  findMethod,
  getInheritanceChain,
} from './godot-docs.js';
import { analyzeOutput } from './error-analyzer.js';
import { captureScreenshot } from './screenshot.js';
import { executeGdscript } from './gdscript-executor.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEBUG = process.env.DEBUG === 'true';

const MCP_MARKER_RESULT = '___MCP_RESULT___';
const MCP_MARKER_ERROR = '___MCP_ERROR___';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
}

// ─── MCP output parser for GDScript scripts ─────────────────────────────────

function parseMcpScriptOutput(rawOutput: string, exitCode: number | null): unknown {
  const lines = rawOutput.split('\n');
  const logLines: string[] = [];
  let parsed: unknown = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MCP_MARKER_RESULT)) {
      try {
        parsed = JSON.parse(trimmed.substring(MCP_MARKER_RESULT.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON', raw: trimmed };
      }
    } else if (trimmed.startsWith(MCP_MARKER_ERROR)) {
      try {
        parsed = JSON.parse(trimmed.substring(MCP_MARKER_ERROR.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON', raw: trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  if (parsed) return parsed;

  return {
    success: false,
    error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
    raw_output: logLines.join('\n'),
  };
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function validatePath(p: string): string {
  if (p.includes('..')) throw new Error(`Path traversal detected: ${p}`);
  return isAbsolute(p) ? p : resolve(p);
}

function ensureDir(p: string): void {
  if (!existsSync(dirname(p))) {
    mkdirSync(dirname(p), { recursive: true });
  }
}

// ─── Godot binary detection ──────────────────────────────────────────────────

const COMMON_PATHS = [
  'C:\\Program Files\\Godot\\Godot_v4*.exe',
  'C:\\Program Files (x86)\\Godot\\Godot_v4*.exe',
  '/usr/bin/godot4',
  '/usr/local/bin/godot4',
  '/Applications/Godot.app/Contents/MacOS/Godot',
];

let godotPath: string | null = null;

async function findGodot(): Promise<string> {
  if (godotPath) return godotPath;

  // 1. Environment variable
  if (process.env.GODOT_PATH && existsSync(process.env.GODOT_PATH)) {
    godotPath = process.env.GODOT_PATH;
    return godotPath;
  }

  // 2. Try `godot` on PATH via a quick spawn
  try {
    const { execSync } = await import('child_process');
    const out = execSync('godot --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (out.includes('Godot')) {
      godotPath = 'godot';
      return godotPath;
    }
  } catch { /* not found on PATH */ }

  // 3. Common paths (Windows)
  if (process.platform === 'win32') {
    for (const candidate of COMMON_PATHS) {
      if (existsSync(candidate)) { godotPath = candidate; return candidate; }
    }
  }

  throw new Error(
    'Godot binary not found. Set GODOT_PATH environment variable or ensure godot is on PATH.'
  );
}

// ─── Debug output state ──────────────────────────────────────────────────────

let runningProcess: ChildProcess | null = null;
let outputBuffer: string[] = [];
let processStartTime: number = 0;
let projectDir: string = '';

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('traceback')) {
      errors.push(line);
    } else if (lower.includes('warning') || lower.includes('warn')) {
      warnings.push(line);
    } else {
      prints.push(line);
    }
  }

  return { errors, warnings, prints };
}

// ─── GodotServer class ───────────────────────────────────────────────────────

export class GodotServer {
  private server: Server;
  private opsScript: string;

  constructor(opsScript: string) {
    this.opsScript = opsScript;
    this.server = new Server(
      { name: 'godot-mcp-enhanced', version: '0.4.0' },
      { capabilities: { tools: {}, resources: {} } }
    );
    this.setupHandlers();
  }

  private async setupHandlers(): Promise<void> {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // ── Execution tools ──
        {
          name: 'launch_editor',
          description: 'Launch the Godot editor GUI for a project.',
          inputSchema: {
            type: 'object' as const,
            properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
            required: ['project_path'],
          },
        },
        {
          name: 'run_project',
          description: 'Run a Godot project in debug mode, capturing output. Supports timeout to auto-stop.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              timeout: { type: 'number', description: 'Auto-stop after N seconds (default: 30)', default: 30 },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project and return categorized output.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_debug_output',
          description: 'Get structured debug output (errors first) from the running project.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'capture_screenshot',
          description: 'Capture a screenshot of a Godot project scene (experimental). Uses headless mode with opengl3 driver. Falls back gracefully if rendering is not available.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene: { type: 'string', description: 'Scene file path relative to project (res://scenes/main.tscn). If omitted, captures the default scene or an empty viewport.' },
              output_path: { type: 'string', description: 'Output PNG path (absolute). Defaults to <project_path>/screenshot.png' },
              frame_delay: { type: 'number', description: 'Frames to wait before capture (default: 10)', default: 10 },
              viewport_width: { type: 'number', description: 'Viewport width in pixels (default: 1280)', default: 1280 },
              viewport_height: { type: 'number', description: 'Viewport height in pixels (default: 720)', default: 720 },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'analyze_screenshot',
          description: 'Return a screenshot as a base64 image for AI visual analysis. The AI can then describe what it sees, identify UI elements, spot bugs, etc. Works with any image file (PNG, JPG).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              image_path: { type: 'string', description: 'Absolute path to the image file (PNG or JPG)' },
              project_path: { type: 'string', description: 'Project path - if provided, image_path is resolved relative to the project directory' },
              question: { type: 'string', description: 'Question for the AI to answer about the image. Default: "Describe what you see in this game screenshot."', default: 'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.' },
            },
            required: [],
          },
        },
        {
          name: 'run_tests',
          description: 'Run GUT unit tests and parse results.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              test_script: { type: 'string', description: 'Path to test script or directory (res://test/)', default: 'res://test/' },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the Godot engine version.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        // ── Project tools ──
        {
          name: 'list_projects',
          description: 'Search for Godot projects in a directory.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              search_dir: { type: 'string', description: 'Directory to search in', default: '.' },
              max_depth: { type: 'number', description: 'Max directory depth (default: 3)', default: 3 },
            },
            required: ['search_dir'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Get detailed info about a Godot project (name, version, file stats).',
          inputSchema: {
            type: 'object' as const,
            properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
            required: ['project_path'],
          },
        },
        {
          name: 'list_files',
          description: 'List files in a Godot project with optional filtering.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              extensions: { type: 'array', items: { type: 'string' }, description: 'Filter by extensions (e.g. [".gd", ".tscn"])' },
              subdirectory: { type: 'string', description: 'Restrict to a subdirectory' },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'read_project_config',
          description: 'Parse project.godot into structured JSON.',
          inputSchema: {
            type: 'object' as const,
            properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
            required: ['project_path'],
          },
        },
        // ── Scene tools ──
        {
          name: 'read_scene',
          description: 'Parse a .tscn scene file and return the complete node tree as JSON.',
          inputSchema: {
            type: 'object' as const,
            properties: {
                            project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Absolute path to the .tscn file' },
              summary_only: { type: 'boolean', description: 'Return human-readable summary instead of full JSON', default: false },
            },
            required: ['project_path', 'scene_path'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene with a root node.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene path relative to project (res://scenes/new.tscn)' },
              root_node_type: { type: 'string', description: 'Root node type (default: Node2D)', default: 'Node2D' },
            },
            required: ['project_path', 'scene_path'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene path relative to project' },
              node_type: { type: 'string', description: 'Type of node to add (e.g. Sprite2D, Camera2D)' },
              node_name: { type: 'string', description: 'Name for the new node' },
              parent_node_path: { type: 'string', description: 'Parent node path (default: root)', default: 'root' },
              properties: { type: 'object', description: 'Optional properties to set on the node' },
            },
            required: ['project_path', 'scene_path', 'node_type', 'node_name'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save/resave a scene file.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene path relative to project' },
              new_path: { type: 'string', description: 'Optional new path to save as' },
            },
            required: ['project_path', 'scene_path'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite texture into a Sprite2D node in a scene.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene path relative to project' },
              texture_path: { type: 'string', description: 'Texture path relative to project (res://assets/player.png)' },
              node_path: { type: 'string', description: 'Sprite node path (default: root)', default: 'root' },
            },
            required: ['project_path', 'scene_path', 'texture_path'],
          },
        },
        // ===== API Documentation tools =====
        {
          name: 'get_class_info',
          description: 'Get complete information about a Godot class including methods, properties, signals, and constants.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              class_name: { type: 'string', description: 'Godot class name (e.g. Node2D, Control, CharacterBody2D)' },
              include_inherited: { type: 'boolean', description: 'Include inherited members (default: true)', default: true },
            },
            required: ['class_name'],
          },
        },
        {
          name: 'search_classes',
          description: 'Search Godot classes by name or description. Useful for discovering available classes.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query (e.g. "sprite", "physics", "audio")' },
              limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'find_method',
          description: 'Find a specific method on a Godot class, searching up the inheritance chain. Returns signature, parameters, and description.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              class_name: { type: 'string', description: 'Godot class name' },
              method_name: { type: 'string', description: 'Method name to find' },
            },
            required: ['class_name', 'method_name'],
          },
        },
        {
          name: 'get_inheritance',
          description: 'Get the full inheritance chain of a Godot class.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              class_name: { type: 'string', description: 'Godot class name' },
            },
            required: ['class_name'],
          },
        },
        // ===== Script tools =====
        {
          name: 'read_script',
          description: 'Read a GDScript (.gd) file with metadata (extends, class_name, line count).',
          inputSchema: {
            type: 'object' as const,
            properties: { script_path: { type: 'string', description: 'Absolute path to the .gd file' } },
            required: ['project_path', 'script_path'],
          },
        },
        {
          name: 'write_script',
          description: 'Write or overwrite a GDScript (.gd) file.',
          inputSchema: {
            type: 'object' as const,
            properties: {
                            project_path: { type: 'string', description: 'Path to Godot project directory' },
              script_path: { type: 'string', description: 'Absolute path to the .gd file' },
              content: { type: 'string', description: 'GDScript content to write' },
            },
            required: ['script_path', 'content'],
          },
        },
        {
          name: 'edit_script',
          description: 'Edit an existing GDScript file by replacing a range of lines. '
            + 'Preserves CRLF line endings. By default inserts content as-is (raw mode). '
            + 'Safer than write_script for incremental edits.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              script_path: { type: 'string', description: 'Path to the .gd file to edit (absolute or relative to project)' },
              start_line: { type: 'number', description: '1-based line number where replacement starts (inclusive)' },
              end_line: { type: 'number', description: '1-based line number where replacement ends (inclusive). Use same as start_line for single line replace.' },
              new_content: { type: 'string', description: 'New content to replace the specified line range.' },
              indent_mode: {
                type: 'string',
                enum: ['raw', 'smart'],
                description: 'Indentation mode: "raw" (default) inserts content exactly as provided. "smart" auto-adjusts indentation to match start_line.',
                default: 'raw',
              },
              verify_content: { type: 'string', description: 'Optional: expected content at the replacement range. Edit is aborted if it does not match, preventing stale line-number edits.' },
            },
            required: ['script_path', 'start_line', 'end_line', 'new_content'],
          },
        },
        // ===== Run Verification tools =====
        {
          name: 'run_and_verify',
          description: 'One-click run a Godot project in headless mode and return structured analysis (errors, warnings, suggestions). Automatically stops after timeout. '
            + 'Optionally captures a scene tree snapshot for runtime inspection.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene: { type: 'string', description: 'Optional scene file to run (e.g. res://scenes/main.tscn)' },
              timeout: { type: 'number', description: 'Auto-stop after N seconds (default: 15)', default: 15 },
              capture_tree: { type: 'boolean', description: 'Also capture a scene tree snapshot (default: false)', default: false },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'analyze_error',
          description: 'Analyze existing Godot error output text and return structured analysis with fix suggestions. Use this to re-analyze previous output.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              output: { type: 'string', description: 'The Godot runtime output to analyze (full text)' },
            },
            required: ['output'],
          },
        },        // ===== SCAFFOLDING & TEST TOOLS =====
        {
          name: 'create_project',
          description: 'Create a complete Godot 4.6 project structure with project.godot, main scene, main script, and assets directory.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Directory path where the project will be created' },
              project_name: { type: 'string', description: 'Project name (default: folder name)', default: '' },
              renderer: { type: 'string', description: 'Renderer to use: "forward_plus" (default), "mobile", or "gl_compatibility"', default: 'forward_plus', enum: ['forward_plus', 'mobile', 'gl_compatibility'] },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'generate_test',
          description: 'Analyze a GDScript file and generate a GUT (Godot Unit Test) test script. Reads the script, extracts public methods, and generates test stubs. The generated code is returned as text — use write_script to save it.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              script_path: { type: 'string', description: 'Path to the GDScript to test, relative to project root (e.g. scripts/player.gd)' },
            },
            required: ['project_path', 'script_path'],
          },
        },
        {
          name: 'create_test_scene',
          description: 'Create a GUT test runner scene (test_scene.tscn) for a Godot project. Checks if GUT addon is installed.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
            },
            required: ['project_path'],
          },
        },
        // ===== Dynamic Execution Tools =====
        {
          name: 'execute_gdscript',
          description: 'Execute arbitrary GDScript code in a headless Godot process. '
            + 'Two modes: (1) Snippet mode \u2014 provide code without "extends", auto-wrapped with helpers. '
            + 'Use _mcp_output(key, value) to return structured results. '
            + '(2) Full class mode \u2014 provide code with "extends SceneTree" for full control. '
            + 'Set load_autoloads=true to run with full autoload context (slower but can access DataRegistry, PlayerData, etc.).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              code: { type: 'string', description: 'GDScript code to execute' },
              timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 },
              load_autoloads: { type: 'boolean', description: 'When true, runs with full autoload context so DataRegistry/PlayerData etc. are available (default: false)', default: false },
            },
            required: ['project_path', 'code'],
          },
        },
        {
          name: 'query_scene_tree',
          description: 'Load a scene in headless mode and query its runtime node tree with resolved property values. '
            + 'Unlike read_scene which parses the .tscn file, this instantiates the scene and returns actual runtime properties.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene file path relative to project (e.g. res://scenes/main.tscn)' },
              max_depth: { type: 'number', description: 'Maximum tree traversal depth (default: 5)', default: 5 },
            },
            required: ['project_path', 'scene_path'],
          },
        },
        {
          name: 'inspect_node',
          description: 'Deep-inspect a specific node in a scene. Returns all properties, signal connections, '
            + 'and child nodes with recursive depth control. Loads the scene in headless mode for runtime values.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene file path relative to project' },
              node_path: { type: 'string', description: 'Node path within scene (e.g. "root/Player/Sprite2D")', default: 'root' },
              max_depth: { type: 'number', description: 'Max depth for child traversal (default: 3)', default: 3 },
              include_signals: { type: 'boolean', description: 'Include signal connection info (default: true)', default: true },
              include_properties: { type: 'boolean', description: 'Include property values (default: true)', default: true },
            },
            required: ['project_path', 'scene_path'],
          },
        },
        // ===== BATCH & VALIDATION TOOLS =====
        {
          name: 'batch_add_nodes',
          description: 'Add multiple nodes to a scene in a single call. Much faster than calling add_node repeatedly. '
            + 'Accepts an array of node definitions, each with type, name, optional parent and properties.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene path relative to project' },
              nodes: {
                type: 'array',
                description: 'Array of node definitions to add',
                items: {
                  type: 'object',
                  properties: {
                    node_type: { type: 'string', description: 'Node type (e.g. Sprite2D, Label)' },
                    node_name: { type: 'string', description: 'Name for the node' },
                    parent_node_path: { type: 'string', description: 'Parent path (default: root)', default: 'root' },
                    properties: { type: 'object', description: 'Optional properties to set' },
                  },
                  required: ['node_type', 'node_name'],
                },
              },
            },
            required: ['project_path', 'scene_path', 'nodes'],
          },
        },
        {
          name: 'validate_project',
          description: 'Validate a Godot project for common issues: missing resource references, broken script paths, '
            + 'invalid scene files, and orphaned .import files. Returns a structured report of all issues found.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              check_resources: { type: 'boolean', description: 'Check for missing resource files (default: true)', default: true },
              check_scripts: { type: 'boolean', description: 'Check for broken script references (default: true)', default: true },
              check_scenes: { type: 'boolean', description: 'Validate scene file structure (default: true)', default: true },
              exclude_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Directory paths (relative to project root) to exclude from validation. '
                  + 'Default excludes: .godot, .import, tools, addons. Directories containing .gdignore are always skipped.',
                default: ['.godot', '.import', 'tools', 'addons'],
              },
            },
            required: ['project_path'],
          },
        },
        {
          name: 'import_resources',
          description: 'Scan a directory for assets and register them with the Godot project. Generates .import stubs '
            + 'so Godot recognizes the files. Supports images, audio, fonts, and other common asset types.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              directory: { type: 'string', description: 'Directory to scan (relative to project, e.g. "assets/ui")' },
              extensions: {
                type: 'array',
                items: { type: 'string' },
                description: 'File extensions to import (default: common image/audio/font types)',
                default: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'],
              },
              recursive: { type: 'boolean', description: 'Scan subdirectories recursively (default: true)', default: true },
            },
            required: ['project_path', 'directory'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      // Normalize camelCase -> snake_case
      const args: Record<string, any> = {};
      if (rawArgs) {
        for (const [key, value] of Object.entries(rawArgs)) {
          const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
          args[snake] = value;
          args[key] = value;
        }
      }
      try {
        return await this.handleTool(name, args ?? {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('Tool error:', name, msg);
        return { content: [{ type: 'text', text: `Error: ${msg}` }] };
      }
    });

    // ── MCP Resources handlers ──────────────────────────────────────────────
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const projectPath = this.detectProjectPath();
      const resources = listMcpResources(projectPath);
      return { resources };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const templates = listMcpResourceTemplates();
      return { resourceTemplates: templates };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const projectPath = this.detectProjectPath();
      const content = readMcpResource(uri, projectPath);
      return { contents: [content] };
    });
  }

  private detectProjectPath(): string | undefined {
    // Walk up from cwd to find project root
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, 'project.godot'))) return dir;
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  private async handleTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
    const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

    switch (name) {
      // ══════════════════════════════════════════════════════════════════════
      // EXECUTION TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'launch_editor': {
        const p = validatePath(args.project_path as string);
        const godot = await findGodot();
        spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore' }).unref();
        return text(`Launched Godot editor for project: ${p}`);
      }

      case 'run_project': {
        const p = validatePath(args.project_path as string);
        const timeout = (args.timeout as number) || 30;
        const godot = await findGodot();

        // Stop existing
        if (runningProcess) {
          runningProcess.kill('SIGTERM');
          runningProcess = null;
        }

        projectDir = p;
        outputBuffer = [];
        processStartTime = Date.now();

        const proc = spawn(godot, ['--path', p, '--debug'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stdout?.on('data', (data: Buffer) => {
          const str = data.toString();
          outputBuffer.push(...str.split('\n'));
          log('stdout:', str.trimEnd());
        });
        proc.stderr?.on('data', (data: Buffer) => {
          const str = data.toString();
          outputBuffer.push(...str.split('\n'));
          log('stderr:', str.trimEnd());
        });

        proc.on('close', (code) => {
          log(`Process exited with code ${code}`);
          runningProcess = null;
        });

        runningProcess = proc;

        // Auto-stop after timeout
        if (timeout > 0) {
          setTimeout(() => {
            if (runningProcess === proc) {
              proc.kill('SIGTERM');
              runningProcess = null;
            }
          }, timeout * 1000);
        }

        return text(`Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
      }

      case 'stop_project': {
        if (!runningProcess) {
          return text('No project is currently running.');
        }
        runningProcess.kill('SIGTERM');
        runningProcess = null;

        const classified = classifyOutput(outputBuffer);
        const result = {
          status: 'stopped',
          runtime: `${((Date.now() - processStartTime) / 1000).toFixed(1)}s`,
          errors: classified.errors,
          warnings: classified.warnings,
          prints: classified.prints.slice(-50),
          total_lines: outputBuffer.length,
        };
        outputBuffer = [];
        return text(JSON.stringify(result, null, 2));
      }

      case 'get_debug_output': {
        if (outputBuffer.length === 0 && !runningProcess) {
          return text('No debug output available. Run a project first.');
        }
        const classified = classifyOutput(outputBuffer);
        const result = {
          running: runningProcess !== null,
          runtime: `${((Date.now() - processStartTime) / 1000).toFixed(1)}s`,
          errors: classified.errors,
          warnings: classified.warnings,
          prints: classified.prints.slice(-50),
          total_lines: outputBuffer.length,
        };
        return text(JSON.stringify(result, null, 2));
      }

      case 'capture_screenshot': {
        const projectPath = validatePath(args.project_path as string);
        const scene = args.scene as string | undefined;
        const outputPath = args.output_path
          ? validatePath(args.output_path as string)
          : join(projectPath, 'screenshot.png');
        const frameDelay = (args.frame_delay as number) || 10;
        const viewportW = (args.viewport_width as number) || 1280;
        const viewportH = (args.viewport_height as number) || 720;
        const godot = await findGodot();

        const result = await captureScreenshot({
          godotPath: godot,
          projectPath,
          scene,
          outputPath,
          frameDelay,
          viewportSize: { width: viewportW, height: viewportH },
          timeout: 30,
        });

        if (result.success) {
          return text(
            `Screenshot saved to: ${result.imagePath}\n` +
            `File size: ${result.fileSize} bytes\n` +
            `Viewport: ${viewportW}x${viewportH}\n` +
            `Frames waited: ${frameDelay}\n\n` +
            'Use analyze_screenshot to have the AI examine this image.'
          );
        } else {
          return text(
            `Screenshot failed: ${result.error}\n\n` +
            (result.godotOutput ? `Godot output:\n${result.godotOutput}\n\n` : '') +
            'Note: Screenshot capture is experimental. Headless rendering may not be available on all systems.'
          );
        }
      }

      case 'analyze_screenshot': {
        let imagePath = args.image_path as string | undefined;
        const projectPath = args.project_path as string | undefined;
        const question = (args.question as string) ||
          'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.';

        if (imagePath) {
          if (!isAbsolute(imagePath) && projectPath) {
            imagePath = resolve(projectPath, imagePath);
          }
          imagePath = validatePath(imagePath);
        } else if (projectPath) {
          imagePath = join(validatePath(projectPath), 'screenshot.png');
        } else {
          return text('Error: either image_path or project_path is required.');
        }

        if (!existsSync(imagePath)) {
          return text(`Image not found: ${imagePath}`);
        }

        const imageBuffer = readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const ext = extname(imagePath).toLowerCase();
        const mimeType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';

        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
              mimeType,
            },
            {
              type: 'text' as const,
              text: question,
            },
          ],
        };
      }
      case 'run_tests': {
        const p = validatePath(args.project_path as string);
        const testScript = (args.test_script as string) || 'res://test/';
        const godot = await findGodot();

        return new Promise((resolve) => {
          const proc = spawn(godot, [
            '--headless', '--path', p,
            '--script', 'addons/gut/gut_cmdln.gd',
            '-gdir', testScript,
            '-gquit',
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          proc.on('close', (code) => {
            // Parse GUT results
            const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
            const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
            resolve({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  exit_code: code,
                  passed: passed.join(', '),
                  failed: failed.join(', '),
                  raw_output: out,
                }, null, 2),
              }],
            });
          });

          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGTERM');
          }, 120000);
        });
      }

      case 'get_godot_version': {
        const godot = await findGodot();
        return new Promise((resolve) => {
          const proc = spawn(godot, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.on('close', () => {
            resolve({ content: [{ type: 'text', text: out.trim() }] });
          });
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // PROJECT TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'list_projects': {
        const searchDir = validatePath(args.search_dir as string);
        const maxDepth = (args.max_depth as number) || 3;
        const projects: string[] = [];

        function scan(dir: string, depth: number): void {
          if (depth > maxDepth) return;
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            if (entries.some(e => e.name === 'project.godot' && e.isFile())) {
              projects.push(dir);
              return; // Don't recurse into project dirs
            }
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                scan(join(dir, entry.name), depth + 1);
              }
            }
          } catch { /* permission error */ }
        }

        scan(searchDir, 0);
        return text(JSON.stringify({ count: projects.length, projects }, null, 2));
      }

      case 'get_project_info': {
        const p = validatePath(args.project_path as string);
        const cfgPath = join(p, 'project.godot');
        if (!existsSync(cfgPath)) return text(`No project.godot found at ${p}`);

        const cfg = readFileSync(cfgPath, 'utf-8');
        const config = this.parseGodotConfig(cfg);

        // Count files by type
        const stats: Record<string, number> = {};
        function countFiles(dir: string, depth: number): void {
          if (depth > 10) return;
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.')) continue;
              const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
              if (entry.isDirectory()) {
                countFiles(join(dir, entry.name), depth + 1);
              } else if (ext) {
                stats[ext] = (stats[ext] || 0) + 1;
              }
            }
          } catch { /* skip */ }
        }
        countFiles(p, 0);

        return text(JSON.stringify({
          name: (config.application as any)?.name || basename(p),
          config,
          file_stats: stats,
        }, null, 2));
      }

      case 'list_files': {
        const p = validatePath(args.project_path as string);
        const extensions = args.extensions as string[] | undefined;
        const subdir = args.subdirectory as string | undefined;
        const target = subdir ? join(p, validatePath(subdir)) : p;
        const files: string[] = [];

        function scan(dir: string): void {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.')) continue;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                scan(full);
              } else {
                const ext = '.' + entry.name.split('.').pop();
                if (!extensions || extensions.includes(ext)) {
                  files.push(full.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
                }
              }
            }
          } catch { /* skip */ }
        }
        scan(target);

        return text(JSON.stringify({ count: files.length, files }, null, 2));
      }

      case 'read_project_config': {
        const p = validatePath(args.project_path as string);
        const cfgPath = join(p, 'project.godot');
        if (!existsSync(cfgPath)) return text(`No project.godot found at ${p}`);

        const cfg = readFileSync(cfgPath, 'utf-8');
        const config = this.parseGodotConfig(cfg);
        return text(JSON.stringify(config, null, 2));
      }

      // ══════════════════════════════════════════════════════════════════════
      // SCENE TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'read_scene': {
        const sp = join(validatePath(args.project_path as string), args.scene_path as string);
        if (!existsSync(sp)) return text(`Scene file not found: ${sp}`);

        const content = readFileSync(sp, 'utf-8');
        if (args.summary_only) {
          return text(parseTscnSummary(content));
        }

        const parsed = parseTscn(content);
        // Serialize with node tree structure
        const roots = parsed.nodes.filter(n => !n.parent);
        const result = {
          header: parsed.header,
          extResources: parsed.extResources,
          subResources: parsed.subResources,
          nodeTree: roots,
          connections: parsed.connections,
          totalNodes: parsed.nodes.length,
        };
        return text(JSON.stringify(result, null, 2));
      }

      case 'create_scene':
      case 'add_node':
      case 'save_scene':
      case 'load_sprite': {
        const p = validatePath(args.project_path as string);
        const godot = await findGodot();

        const params: Record<string, unknown> = {};
        if (name === 'create_scene') {
          params.scene_path = args.scene_path;
          params.root_node_type = args.root_node_type || 'Node2D';
        } else if (name === 'add_node') {
          params.scene_path = args.scene_path;
          params.node_type = args.node_type;
          params.node_name = args.node_name;
          params.parent_node_path = args.parent_node_path || 'root';
          if (args.properties) params.properties = args.properties;
        } else if (name === 'save_scene') {
          params.scene_path = args.scene_path;
          if (args.new_path) params.new_path = args.new_path;
        } else if (name === 'load_sprite') {
          params.scene_path = args.scene_path;
          params.texture_path = args.texture_path;
          params.node_path = args.node_path || 'root';
        }

        return new Promise((resolve) => {
          log(`Running ${name} via godot_operations.gd`);
          const proc = spawn(godot, [
            '--headless', '--path', p,
            '--script', this.opsScript,
            name, JSON.stringify(params),
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          proc.on('close', (code) => {
            if (code !== 0) {
              resolve({ content: [{ type: 'text', text: `${name} failed (exit code ${code}):\n${out}` }] });
            } else {
              resolve({ content: [{ type: 'text', text: out.trim() || `${name} completed successfully.` }] });
            }
          });

          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              resolve({ content: [{ type: 'text', text: `${name} timed out.` }] });
            }
          }, 60000);
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // ===== API DOCUMENTATION TOOLS =====

      case 'get_class_info': {
        const className = args.class_name as string;
        const includeInherited = args.include_inherited !== false;
        const info = getClassInfo(className, includeInherited);
        if (!info) {
          return text(`Class not found: ${className}`);
        }
        const result = {
          name: info.name,
          inherits: info.inherits,
          brief_description: info.brief_description,
          description: info.description,
          methods_count: info.methods.length,
          methods: info.methods.map(m => ({
            name: m.name,
            signature: `${m.return_type} ${m.name}(${m.arguments.map(a => a.type + ' ' + a.name).join(', ')})`,
            description: m.description,
          })),
          properties_count: info.properties.length,
          properties: info.properties.map(p => ({
            name: p.name,
            type: p.type,
            description: p.description,
          })),
          signals_count: info.signals.length,
          signals: info.signals.map(s => ({
            name: s.name,
            description: s.description,
          })),
          constants_count: info.constants.length,
          constants: info.constants.slice(0, 50),
          enums_count: info.enums.length,
        };
        return text(JSON.stringify(result, null, 2));
      }

      case 'search_classes': {
        const query = args.query as string;
        const limit = (args.limit as number) || 20;
        const results = searchClasses(query, limit);
        if (results.length === 0) {
          return text(`No classes found matching "${query}"`);
        }
        return text(JSON.stringify({ count: results.length, classes: results }, null, 2));
      }

      case 'find_method': {
        const className = args.class_name as string;
        const methodName = args.method_name as string;
        const method = findMethod(className, methodName);
        if (!method) {
          return text(`Method "${methodName}" not found on ${className} or its parent classes.`);
        }
        const result = {
          class: className,
          name: method.name,
          return_type: method.return_type,
          arguments: method.arguments.map(a => ({
            name: a.name,
            type: a.type,
            default: a.default_value,
          })),
          signature: `${method.return_type} ${method.name}(${method.arguments.map(a => a.type + ' ' + a.name + (a.default_value ? ' = ' + a.default_value : '')).join(', ')})`,
          description: method.description,
        };
        return text(JSON.stringify(result, null, 2));
      }

      case 'get_inheritance': {
        const className = args.class_name as string;
        const chain = getInheritanceChain(className);
        if (chain.length === 0) {
          return text(`Class not found: ${className}`);
        }
        return text(JSON.stringify({ class: className, inheritance_chain: chain }, null, 2));
      }

      // ===== SCRIPT TOOLS =====
      // ══════════════════════════════════════════════════════════════════════

      case 'read_script': {
        const sp = join(validatePath(args.project_path as string), args.script_path as string);
        if (!existsSync(sp)) return text(`Script not found: ${sp}`);

        const content = readFileSync(sp, 'utf-8');
        const lines = content.split('\n');

        let extendsClass = '';
        let className = '';

        for (const line of lines) {
          const extMatch = line.match(/^extends\s+(\S+)/);
          if (extMatch) extendsClass = extMatch[1];
          const clsMatch = line.match(/^class_name\s+(\S+)/);
          if (clsMatch) className = clsMatch[1];
        }

        return text(JSON.stringify({
          path: sp,
          extends: extendsClass,
          class_name: className,
          lines: lines.length,
          content,
        }, null, 2));
      }

      case 'write_script': {
        const scriptPath = args.script_path as string;
        // Support both absolute paths and relative-to-project paths
        const sp = isAbsolute(scriptPath)
          ? scriptPath
          : join(validatePath(args.project_path as string), scriptPath);
        const content = args.content as string;

        ensureDir(sp);
        writeFileSync(sp, content, 'utf-8');

        return text(`Script written to ${sp} (${content.split('\n').length} lines)`);
      }

      case 'edit_script': {
        const scriptPath = args.script_path as string;
        // Support both absolute paths and relative-to-project paths
        const fullPath = isAbsolute(scriptPath)
          ? scriptPath
          : join(validatePath(args.project_path as string), scriptPath);
        const startLine = args.start_line as number;
        const endLine = args.end_line as number;
        const newContent = args.new_content as string;
        const indentMode = (args.indent_mode as string) || 'raw';
        const verifyContent = args.verify_content as string | undefined;

        if (!existsSync(fullPath)) {
          return text(`Error: File not found: ${fullPath}`);
        }
        if (startLine < 1 || endLine < startLine) {
          return text(`Error: Invalid line range: start_line=${startLine}, end_line=${endLine}`);
        }

        const rawFile = readFileSync(fullPath, 'utf-8');
        const hasCRLF = rawFile.includes('\r\n');
        const lines = rawFile.split(/\r?\n/);

        if (endLine > lines.length) {
          return text(`Error: end_line ${endLine} exceeds file length ${lines.length}`);
        }

        // Save before-state for diff response
        const beforeLines = lines.slice(startLine - 1, endLine);

        // Verify content if requested — prevents stale line-number edits
        if (verifyContent !== undefined) {
          const existingContent = beforeLines.join('\n');
          const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\t/g, '    ').trim();
          if (normalize(existingContent) !== normalize(verifyContent)) {
            return text(
              `Error: Content verification failed at lines ${startLine}-${endLine}. The file has changed since the line numbers were read.\n` +
              `--- Expected ---\n${verifyContent}\n` +
              `--- Actual ---\n${existingContent}`
            );
          }
        }

        // Prepare replacement lines
        const newLines = newContent.split(/\r?\n/);
        let adjustedLines: string[];

        if (indentMode === 'smart') {
          // Smart indent: detect start_line's indent, strip new_content's base indent,
          // re-apply start_line's indent. Preserves relative indentation.
          const originalLine = lines[startLine - 1] || '';
          const baseIndent = (originalLine.match(/^(\t*)/) || ['',''])[1];
          // Find minimum indent in new content to strip uniformly
          let minIndent = Infinity;
          for (const nl of newLines) {
            if (nl.trim() === '') continue; // skip blank lines
            const tabs = (nl.match(/^(\t*)/) || ['',''])[1].length;
            if (tabs < minIndent) minIndent = tabs;
          }
          if (minIndent === Infinity) minIndent = 0;
          const stripPrefix = '\t'.repeat(minIndent);

          adjustedLines = newLines.map((line: string) => {
            if (line.trim() === '') return line; // preserve blank lines as-is
            const stripped = line.startsWith(stripPrefix)
              ? line.substring(stripPrefix.length)
              : line;
            return baseIndent + stripped;
          });
        } else {
          // Raw mode (default): insert content exactly as provided
          adjustedLines = newLines;
        }

        // Replace lines
        lines.splice(startLine - 1, endLine - startLine + 1, ...adjustedLines);

        // Write back with original line endings
        const result = lines.join(hasCRLF ? '\r\n' : '\n');
        writeFileSync(fullPath, result, 'utf-8');

        // Build response with before/after diff
        const afterLines = adjustedLines;
        const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines)`;
        const diffBody = `--- Before ---\n${beforeLines.join('\n')}\n--- After ---\n${afterLines.join('\n')}`;

        return text(`${diffHeader}\n${diffBody}`);
      }

      // ===== RUN VERIFICATION TOOLS =====

      case 'run_and_verify': {
        const projectPath = validatePath(args.project_path as string);
        const timeout = (args.timeout as number) || 15;
        const scene = args.scene as string | undefined;
        const captureTree = args.capture_tree === true;

        const godot = await findGodot();
        const cmdArgs = ['--headless', '--path', projectPath];
        if (scene) cmdArgs.push(scene);

        try {
          const { stdout, stderr } = await execFileAsync(godot, cmdArgs, { timeout: timeout * 1000 });
          const allOutput = [...(stdout || '').split('\n'), ...(stderr || '').split('\n')];
          const analysis = analyzeOutput(allOutput);

          // Optionally capture scene tree
          if (captureTree && scene) {
            try {
              const scriptsDir = dirname(this.opsScript);
              const treeScript = join(scriptsDir, 'query_scene_tree.gd');
              if (existsSync(treeScript)) {
                const treeResult = await new Promise<string>((resolve) => {
                  let out = '';
                  const proc = spawn(godot, [
                    '--headless', '--path', projectPath,
                    '--script', treeScript,
                    JSON.stringify({ scene_path: scene, max_depth: 3 }),
                  ], { stdio: ['pipe', 'pipe', 'pipe'] });
                  proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                  proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
                  proc.on('close', () => resolve(out));
                  setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); resolve(''); }, 30000);
                });
                if (treeResult) {
                  (analysis as any).scene_tree = parseMcpScriptOutput(treeResult, 0);
                }
              }
            } catch { /* tree capture is optional */ }
          }

          return text(JSON.stringify(analysis, null, 2));
        } catch (e: any) {
          const allOutput = [...(e.stdout || '').split('\n'), ...(e.stderr || '').split('\n')];
          const analysis = analyzeOutput(allOutput);
          if (e.killed) {
            (analysis as any).summary += '\nNote: Process timed out after ' + timeout + 's (this is normal for interactive projects)';
          } else {
            (analysis as any).summary += '\nNote: Process exited with code ' + (e.code || 'unknown');
          }
          return text(JSON.stringify(analysis, null, 2));
        }
      }

      case 'analyze_error': {
        const outputText = args.output as string;
        if (!outputText || !outputText.trim()) {
          return text('Error: "output" parameter is required and must not be empty.');
        }
        const lines = outputText.split('\n');
        const analysis = analyzeOutput(lines);
        return text(JSON.stringify(analysis, null, 2));
      }
        // ===== SCAFFOLDING & TEST TOOLS =====

      case 'create_project': {
        const p = validatePath(args.project_path as string);
        const projectName = (args.project_name as string) || basename(p);
        const renderer = (args.renderer as string) || 'forward_plus';
        const validRenderers = ['forward_plus', 'mobile', 'gl_compatibility'];
        if (!validRenderers.includes(renderer)) {
          return text(`Error: Invalid renderer "${renderer}". Must be one of: ${validRenderers.join(', ')}`);
        }

        if (existsSync(join(p, 'project.godot'))) {
          return text(`Error: project.godot already exists at ${p}. This directory appears to be an existing Godot project.`);
        }

        // Create directory structure
        mkdirSync(join(p, 'scenes'), { recursive: true });
        mkdirSync(join(p, 'scripts'), { recursive: true });
        mkdirSync(join(p, 'assets'), { recursive: true });

        // Write project.godot
        const projectGodot = [
          '; Engine configuration file.',
          'config_version=5',
          '',
          '[application]',
          '',
          'config/name="' + projectName + '"',
          'run/main_scene="res://scenes/main.tscn"',
          'config/features=PackedStringArray("4.6")',
          '',
          '[display]',
          '',
          'window/size/viewport_width=1280',
          'window/size/viewport_height=720',
          '',
          '[rendering]',
          '',
          'renderer="' + renderer + '"',
          '',
        ].join('\n');
        writeFileSync(join(p, 'project.godot'), projectGodot, 'utf-8');

        // Write main.tscn
        const mainTscn = [
          '[gd_scene load_steps=2 format=3 uid="uid://b6q8a1x2c3d4"]',
          '',
          '[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]',
          '',
          '[node name="Main" type="Node2D"]',
          'script = ExtResource("1_main")',
          '',
        ].join('\n');
        writeFileSync(join(p, 'scenes', 'main.tscn'), mainTscn, 'utf-8');

        // Write main.gd
        const mainGd = [
          'extends Node2D',
          '',
          'func _ready() -> void:',
          "\tprint(\"Hello, Godot 4.6!\")",
          '',
        ].join('\n');
        writeFileSync(join(p, 'scripts', 'main.gd'), mainGd, 'utf-8');

        return text(
          `Project created successfully at ${p}\n\n` +
          `Structure:\n` +
          `  ├── project.godot      (name: ${projectName}, renderer: ${renderer})\n` +
          `  ├── scenes/main.tscn   (Node2D root + main.gd script)\n` +
          `  ├── scripts/main.gd    (_ready template)\n` +
          `  └── assets/            (empty)\n\n` +
          `Run with: launch_editor(project_path="${p}")`
        );
      }

      case 'generate_test': {
        const projectPath = validatePath(args.project_path as string);
        const scriptPath = args.script_path as string;
        if (!scriptPath) {
          return text('Error: script_path is required (e.g. "scripts/player.gd")');
        }

        const fullScriptPath = join(projectPath, scriptPath);
        if (!existsSync(fullScriptPath)) {
          return text(`Error: Script not found: ${fullScriptPath}`);
        }

        const source = readFileSync(fullScriptPath, 'utf-8');
        const srcLines = source.split('\n');

        // Extract extends and class_name
        let extendsClass = '';
        let className = '';
        for (const line of srcLines) {
          const extMatch = line.match(/^extends\s+(\S+)/);
          if (extMatch) extendsClass = extMatch[1];
          const clsMatch = line.match(/^class_name\s+(\S+)/);
          if (clsMatch) className = clsMatch[1];
        }

        // Extract public methods (func that don't start with _)
        const publicMethods: string[] = [];
        for (const line of srcLines) {
          const funcMatch = line.match(/^func\s+(\w+)\s*\(/);
          if (funcMatch && !funcMatch[1].startsWith('_')) {
            publicMethods.push(funcMatch[1]);
          }
        }

        if (publicMethods.length === 0) {
          return text(
            `No public methods found in ${scriptPath}.\n` +
            `Only private methods (starting with _) were detected or the file has no functions.\n` +
            `The script extends "${extendsClass || 'unknown'}".`
          );
        }

        // Build GUT test script
        const testTarget = className || (scriptPath.includes('/') ? scriptPath.split('/').pop()?.replace('.gd', '') || 'Target' : scriptPath.replace('.gd', ''));
        const scriptResPath = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath}`;

        let testCode = 'extends GutTest\n\n';
        testCode += `var ${testTarget}  # Instance under test\n\n`;
        testCode += 'func before_each():\n';
        testCode += `\t${testTarget} = load("${scriptResPath}").new()\n\n`;
        testCode += 'func after_each():\n';
        testCode += `\tif is_instance_valid(${testTarget}):\n`;
        testCode += `\t\t${testTarget}.free()\n\n`;

        for (const method of publicMethods) {
          testCode += `func test_${method}():\n`;
          testCode += `\tvar result = ${testTarget}.${method}()\n`;
          testCode += `\tassert_not_null(result, "${method} should return a value")\n\n`;
        }

        const outputTestPath = join(projectPath, 'test', 'scripts', `test_${basename(scriptPath)}`);

        return text(
          `Generated GUT test for ${scriptPath}\n\n` +
          `Target class: ${testTarget}\n` +
          `Extends: ${extendsClass || 'N/A'}\n` +
          `Class name: ${className || 'N/A'}\n` +
          `Public methods found: ${publicMethods.length}\n` +
          `  ${publicMethods.join(', ')}\n\n` +
          `Suggested save path: ${outputTestPath}\n\n` +
          `--- Generated test code ---\n${testCode}` +
          `--- End of generated code ---\n\n` +
          `To save, use: write_script(project_path="${projectPath}", script_path="test/scripts/test_${basename(scriptPath)}", content=<above code>)`
        );
      }

      case 'create_test_scene': {
        const p = validatePath(args.project_path as string);

        // Check if GUT is installed
        const gutDir = join(p, 'addons', 'gut');
        if (!existsSync(gutDir)) {
          return text(
            `GUT (Godot Unit Test) addon not found at ${gutDir}.\n\n` +
            `To install GUT:\n` +
            `1. Download from: https://github.com/bitwes/Gut/releases\n` +
            `2. Extract to ${join(p, 'addons', 'gut')}\n` +
            `3. Or use the Godot Asset Library: https://godotengine.org/asset-library/asset/282\n\n` +
            `After installing GUT, run create_test_scene again.`
          );
        }

        // Ensure test directories
        mkdirSync(join(p, 'test', 'scripts'), { recursive: true });

        // Create test_scene.tscn
        const testSceneContent = [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://addons/gut/gut.gd" id="1_gut"]',
          '',
          '[node name="TestScene" type="Node"]',
          'script = ExtResource("1_gut")',
          '',
        ].join('\n');
        writeFileSync(join(p, 'test_scene.tscn'), testSceneContent, 'utf-8');

        return text(
          `GUT test scene created at ${join(p, 'test_scene.tscn')}\n\n` +
          `To run tests:\n` +
          `1. Open test_scene.tscn in Godot editor\n` +
          `2. Click "Run All" in the GUT panel\n` +
          `3. Or use run_tests(project_path="${p}") for headless testing\n\n` +
          `Test scripts should be placed in: test/scripts/`
        );
      }

      // ══════════════════════════════════════════════════════════════════════
      // DYNAMIC EXECUTION TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'execute_gdscript': {
        const projectPath = validatePath(args.project_path as string);
        const code = args.code as string;
        const timeout = (args.timeout as number) || 30;
        const loadAutoloads = (args.load_autoloads as boolean) || false;
        const godot = await findGodot();

        const result = await executeGdscript({
          godotPath: godot,
          projectPath,
          code,
          timeout,
          loadAutoloads,
        });

        return text(JSON.stringify(result, null, 2));
      }

      case 'query_scene_tree': {
        const p = validatePath(args.project_path as string);
        const godot = await findGodot();
        const scriptsDir = dirname(this.opsScript);
        const treeScript = join(scriptsDir, 'query_scene_tree.gd');

        if (!existsSync(treeScript)) {
          return text(`Error: query_scene_tree.gd not found at ${treeScript}`);
        }

        const params = {
          scene_path: args.scene_path,
          max_depth: (args.max_depth as number) || 5,
        };

        return new Promise((resolve) => {
          let out = '';
          const proc = spawn(godot, [
            '--headless', '--path', p,
            '--script', treeScript,
            JSON.stringify(params),
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          const timer = setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              resolve(text('query_scene_tree timed out after 60s'));
            }
          }, 60000);

          proc.on('close', (code) => {
            clearTimeout(timer);
            const result = parseMcpScriptOutput(out, code);
            resolve(text(JSON.stringify(result, null, 2)));
          });

          proc.on('error', (err) => {
            clearTimeout(timer);
            resolve(text(`Error: ${err.message}`));
          });
        });
      }

      case 'inspect_node': {
        const p = validatePath(args.project_path as string);
        const godot = await findGodot();
        const scriptsDir = dirname(this.opsScript);
        const inspectScript = join(scriptsDir, 'inspect_node.gd');

        if (!existsSync(inspectScript)) {
          return text(`Error: inspect_node.gd not found at ${inspectScript}`);
        }

        const params = {
          scene_path: args.scene_path,
          node_path: args.node_path || 'root',
          max_depth: (args.max_depth as number) || 3,
          include_signals: args.include_signals !== false,
          include_properties: args.include_properties !== false,
        };

        return new Promise((resolve) => {
          let out = '';
          const proc = spawn(godot, [
            '--headless', '--path', p,
            '--script', inspectScript,
            JSON.stringify(params),
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          const timer = setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              resolve(text('inspect_node timed out after 60s'));
            }
          }, 60000);

          proc.on('close', (code) => {
            clearTimeout(timer);
            const result = parseMcpScriptOutput(out, code);
            resolve(text(JSON.stringify(result, null, 2)));
          });

          proc.on('error', (err) => {
            clearTimeout(timer);
            resolve(text(`Error: ${err.message}`));
          });
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // BATCH & VALIDATION TOOLS
      // ══════════════════════════════════════════════════════════════════════

      case 'batch_add_nodes': {
        const p = validatePath(args.project_path as string);
        const scenePath = args.scene_path as string;
        const nodes = args.nodes as Array<{
          node_type: string;
          node_name: string;
          parent_node_path?: string;
          properties?: Record<string, unknown>;
        }>;

        if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
          return text('Error: "nodes" must be a non-empty array of node definitions.');
        }

        const godot = await findGodot();

        return new Promise((resolve) => {
          log(`batch_add_nodes: adding ${nodes.length} nodes to ${scenePath}`);
          const proc = spawn(godot, [
            '--headless', '--path', p,
            '--script', this.opsScript,
            'batch_add_nodes', JSON.stringify({
              scene_path: scenePath,
              nodes: nodes,
            }),
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          proc.on('close', (code) => {
            if (code !== 0) {
              resolve({ content: [{ type: 'text', text: `batch_add_nodes failed (exit code ${code}):\n${out}` }] });
            } else {
              resolve({ content: [{ type: 'text', text: out.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] });
            }
          });

          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              resolve({ content: [{ type: 'text', text: 'batch_add_nodes timed out after 60s.' }] });
            }
          }, 60000);
        });
      }

      case 'validate_project': {
        const p = validatePath(args.project_path as string);
        const checkResources = args.check_resources !== false;
        const checkScripts = args.check_scripts !== false;
        const checkScenes = args.check_scenes !== false;
        const excludePaths: string[] = (args.exclude_paths as string[]) || ['.godot', '.import', 'tools', 'addons'];

        const issues: Array<{ severity: string; category: string; message: string; file?: string }> = [];

        // Check if a directory should be skipped (exclude list or .gdignore presence)
        function shouldSkipDir(dirName: string, dirPath: string): boolean {
          if (excludePaths.includes(dirName)) return true;
          if (existsSync(join(dirPath, '.gdignore'))) return true;
          return false;
        }

        // Helper: recursively collect files
        function collectFiles(dir: string, exts: string[], maxDepth: number = 10, depth: number = 0): string[] {
          if (depth > maxDepth) return [];
          const result: string[] = [];
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.')) continue;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                if (shouldSkipDir(entry.name, full)) continue;
                result.push(...collectFiles(full, exts, maxDepth, depth + 1));
              } else {
                const ext = '.' + entry.name.split('.').pop()!.toLowerCase();
                if (exts.includes(ext)) result.push(full);
              }
            }
          } catch { /* skip */ }
          return result;
        }

        // Check project.godot exists
        if (!existsSync(join(p, 'project.godot'))) {
          issues.push({ severity: 'critical', category: 'project', message: 'project.godot not found' });
          return text(JSON.stringify({ valid: false, issue_count: issues.length, issues }, null, 2));
        }

        // Check scenes
        if (checkScenes) {
          const sceneFiles = collectFiles(p, ['.tscn']);
          for (const sceneFile of sceneFiles) {
            const rel = sceneFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
            try {
              const content = readFileSync(sceneFile, 'utf-8');
              // Check ext_resource references
              const extResRegex = /\[ext_resource[^[]*path="([^"]+)"/g;
              let match;
              while ((match = extResRegex.exec(content)) !== null) {
                const resPath = match[1];
                if (!resPath.startsWith('res://')) continue;
                const absPath = join(p, resPath.replace('res://', ''));
                if (!existsSync(absPath)) {
                  issues.push({
                    severity: 'error',
                    category: 'missing_resource',
                    message: `Referenced resource not found: ${resPath}`,
                    file: rel,
                  });
                }
              }
            } catch (e) {
              issues.push({
                severity: 'warning',
                category: 'scene_read',
                message: `Cannot read scene file: ${(e as Error).message}`,
                file: rel,
              });
            }
          }
        }

        // Check scripts
        if (checkScripts) {
          const scriptFiles = collectFiles(p, ['.gd']);
          for (const scriptFile of scriptFiles) {
            const rel = scriptFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
            try {
              const content = readFileSync(scriptFile, 'utf-8');
              const preloadRegex = /preload\(["']([^"']+)["']\)/g;
              let match;
              while ((match = preloadRegex.exec(content)) !== null) {
                const resPath = match[1];
                if (!resPath.startsWith('res://')) continue;
                const absPath = join(p, resPath.replace('res://', ''));
                if (!existsSync(absPath)) {
                  issues.push({
                    severity: 'error',
                    category: 'missing_preload',
                    message: `preload() resource not found: ${resPath}`,
                    file: rel,
                  });
                }
              }
              // Check load() references
              const loadRegex = /(?:^|\s)load\(["']([^"']+)["']\)/g;
              while ((match = loadRegex.exec(content)) !== null) {
                const resPath = match[1];
                if (!resPath.startsWith('res://')) continue;
                const absPath = join(p, resPath.replace('res://', ''));
                if (!existsSync(absPath)) {
                  issues.push({
                    severity: 'warning',
                    category: 'missing_load',
                    message: `load() resource not found: ${resPath}`,
                    file: rel,
                  });
                }
              }
            } catch {
              issues.push({ severity: 'warning', category: 'script_read', message: 'Cannot read script file', file: rel });
            }
          }
        }

        // Check orphaned .import files (files whose source asset was deleted)
        if (checkResources) {
          const importFiles = collectFiles(p, ['.import']);
          for (const importFile of importFiles) {
            const sourceFile = importFile.replace('.import', '');
            if (!existsSync(sourceFile)) {
              const rel = importFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
              issues.push({
                severity: 'info',
                category: 'orphaned_import',
                message: `Orphaned .import file (source asset deleted)`,
                file: rel,
              });
            }
          }
        }

        const summary = {
          valid: issues.filter(i => i.severity === 'critical' || i.severity === 'error').length === 0,
          issue_count: issues.length,
          critical: issues.filter(i => i.severity === 'critical').length,
          errors: issues.filter(i => i.severity === 'error').length,
          warnings: issues.filter(i => i.severity === 'warning').length,
          info: issues.filter(i => i.severity === 'info').length,
          issues: issues.slice(0, 100), // Cap at 100 to avoid huge responses
        };

        return text(JSON.stringify(summary, null, 2));
      }

      case 'import_resources': {
        const p = validatePath(args.project_path as string);
        const directory = args.directory as string;
        const defaultExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'];
        const extensions = (args.extensions as string[]) || defaultExts;
        const recursive = args.recursive !== false;

        const targetDir = join(p, directory.replace(/^res:\/\//, ''));
        if (!existsSync(targetDir)) {
          return text(`Error: Directory not found: ${targetDir}`);
        }

        const importedFiles: string[] = [];
        const skippedFiles: string[] = [];

        function scanDir(dir: string, depth: number): void {
          if (depth > 15) return;
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name === '.import') continue;
              const fullPath = join(dir, entry.name);
              if (entry.isDirectory()) {
                if (recursive) scanDir(fullPath, depth + 1);
              } else {
                const ext = '.' + entry.name.split('.').pop()!.toLowerCase();
                if (!extensions.includes(ext)) continue;
                // Check if .import file already exists
                const importPath = fullPath + '.import';
                if (existsSync(importPath)) {
                  skippedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
                  continue;
                }
                // Generate a minimal .import file so Godot detects the resource
                const uid = 'uid://' + Buffer.from(fullPath.replace(p, '').replace(/\\/g, '/')).toString('base64url').substring(0, 24);
                const importerMap: Record<string, string> = {
                  '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.svg': 'texture',
                  '.mp3': 'ogg_vorbis', '.ogg': 'ogg_vorbis', '.wav': 'wav',
                  '.ttf': 'dynamic_font', '.otf': 'dynamic_font',
                  '.glb': 'scene', '.gltf': 'scene',
                };
                const importer = importerMap[ext] || 'any';
                const importContent = [
                  `[remap]`,
                  ``,
                  `importer="${importer}"`,
                  `type="CompressedTexture2D"`,
                  `uid="${uid}"`,
                  `path="res://.godot/imported/${entry.name}-${uid.substring(5, 13)}.ctex"`,
                  `metadata={`,
                  `"vram_texture": false`,
                  `}`,
                  ``,
                  `[deps]`,
                  ``,
                  `source_file="res://${fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), '').replace(/\\/g, '/')}"`,
                  ``,
                  `[params]`,
                  ``,
                  `compress/mode=0`,
                  `compress/high_quality=false`,
                  `compress/lossy_quality=0.7`,
                  ``,
                ].join('\n');
                writeFileSync(importPath, importContent, 'utf-8');
                importedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
              }
            }
          } catch { /* skip */ }
        }

        scanDir(targetDir, 0);

        return text(
          `Import scan complete.\n\n` +
          `Directory: ${directory}\n` +
          `New imports: ${importedFiles.length}\n` +
          `Already imported (skipped): ${skippedFiles.length}\n` +
          `Extensions: ${extensions.join(', ')}\n\n` +
          (importedFiles.length > 0 ? `Newly imported:\n${importedFiles.slice(0, 50).map(f => '  ' + f).join('\n')}${importedFiles.length > 50 ? `\n  ... and ${importedFiles.length - 50} more` : ''}\n\n` : '') +
          `Note: Open the project in Godot editor once to fully process imports.`
        );
      }

    default:
        return text(`Unknown tool: ${name}`);
    }
  }

  // ─── Godot config parser ──────────────────────────────────────────────────

  private parseGodotConfig(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

      // Section header: [section]
      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        const section = sectionMatch[1];
        if (!result[section]) result[section] = {};
        continue;
      }

      // Key-value: key = value
      const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
      if (kvMatch) {
        // Determine which section this belongs to
        // For simplicity, we parse flat; section tracking would need state
        const key = kvMatch[1];
        const value = this.parseConfigValue(kvMatch[2].trim());
        result[key] = value;
      }
    }

    // Second pass: group by section
    const sectioned: Record<string, unknown> = {};
    let currentSection = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        if (!sectioned[currentSection]) sectioned[currentSection] = {};
        continue;
      }

      const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const container = currentSection
          ? (sectioned[currentSection] as Record<string, unknown>)
          : sectioned;
        container[kvMatch[1]] = this.parseConfigValue(kvMatch[2].trim());
      }
    }

    return sectioned;
  }

  private parseConfigValue(raw: string): unknown {
    if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    const num = Number(raw);
    if (!isNaN(num) && raw !== '') return num;
    // Handle arrays [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',').map(s => this.parseConfigValue(s.trim())).filter(s => s !== '');
    }
    return raw;
  }

  // ─── Run ───────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('Godot MCP Enhanced server running on stdio');
  }
}
