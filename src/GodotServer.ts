import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname, basename, isAbsolute } from 'path';
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

const DEBUG = process.env.DEBUG === 'true';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
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
      { name: 'godot-mcp-enhanced', version: '0.1.0' },
      { capabilities: { tools: {} } }
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
          description: 'Capture a screenshot of a running Godot project scene via headless mode.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project_path: { type: 'string', description: 'Path to Godot project directory' },
              scene_path: { type: 'string', description: 'Scene file path relative to project (res://scenes/main.tscn)' },
              output_path: { type: 'string', description: 'Output PNG path (absolute)' },
              wait_frames: { type: 'number', description: 'Frames to wait before capture (default: 5)', default: 5 },
            },
            required: ['project_path', 'output_path'],
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
              scene_path: { type: 'string', description: 'Absolute path to the .tscn file' },
              summary_only: { type: 'boolean', description: 'Return human-readable summary instead of full JSON', default: false },
            },
            required: ['scene_path'],
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
            required: ['script_path'],
          },
        },
        {
          name: 'write_script',
          description: 'Write or overwrite a GDScript (.gd) file.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              script_path: { type: 'string', description: 'Absolute path to the .gd file' },
              content: { type: 'string', description: 'GDScript content to write' },
            },
            required: ['script_path', 'content'],
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
  }

  private async handleTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
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
        const p = validatePath(args.project_path as string);
        const scene = (args.scene_path as string) || 'res://scenes/main.tscn';
        const output = validatePath(args.output_path as string);
        const waitFrames = (args.wait_frames as number) || 5;
        const godot = await findGodot();

        // Create temporary GDScript
        const screenshotScript = `
extends SceneTree
var frames = 0
var max_frames = ${waitFrames}
var output_path = "${output.replace(/\\/g, '\\\\')}"

func _ready():
    var scene = load("${scene}")
    if scene:
        var inst = scene.instantiate()
        get_root().add_child(inst)

func _process(_delta):
    frames += 1
    if frames >= max_frames:
        var img = get_root().get_viewport().get_texture().get_image()
        img.save_png(output_path)
        print("[INFO] Screenshot saved to: " + output_path)
        quit()
`;
        const tmpScript = join(tmpdir(), `screenshot_${Date.now()}.gd`);
        writeFileSync(tmpScript, screenshotScript);
        log('Screenshot script:', tmpScript);

        return new Promise((resolve) => {
          const proc = spawn(godot, ['--headless', '--path', p, '--script', tmpScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

          proc.on('close', (code) => {
            // Cleanup temp script
            try { rmSync(tmpScript); } catch { /* ignore */ }

            if (code !== 0) {
              resolve({ content: [{ type: 'text', text: `Screenshot failed (exit code ${code}). Output:\n${out}` }] });
            } else if (existsSync(output)) {
              resolve({ content: [{ type: 'text', text: `Screenshot saved to: ${output}\nFrames waited: ${waitFrames}` }] });
            } else {
              resolve({ content: [{ type: 'text', text: `Screenshot command completed but file not found at: ${output}\nOutput:\n${out}` }] });
            }
          });

          // Timeout after 30s
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              resolve({ content: [{ type: 'text', text: 'Screenshot timed out after 30s.' }] });
            }
          }, 30000);
        });
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
        const sp = join(validatePath(args.project_path as string), args.script_path as string);
        const content = args.content as string;

        ensureDir(sp);
        writeFileSync(sp, content, 'utf-8');

        return text(`Script written to ${sp} (${content.split('\n').length} lines)`);
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
