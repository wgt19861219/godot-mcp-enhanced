import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ToolResult } from './types.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';

// ─── Import modular tool handlers ───────────────────────────────────────────
import * as runtime from './tools/runtime.js';
import * as screenshot from './tools/screenshot.js';
import * as project from './tools/project.js';
import * as scene from './tools/scene.js';
import * as script from './tools/script.js';
import * as validation from './tools/validation.js';
import * as docs from './tools/docs.js';
import * as godotOps from './tools/godot-ops.js';
import * as tilemapOps from './tools/tilemap-ops.js';
import * as materialOps from './tools/material-ops.js';
import * as gameBridge from './tools/game-bridge.js';
import * as workflow from './tools/workflow.js';
import { requiresConfirmation, createPendingToken, consumeToken } from './guard.js';

const toolModules = [runtime, screenshot, project, scene, script, validation, docs, godotOps, tilemapOps, materialOps, gameBridge, workflow];

// ─── Godot binary detection ──────────────────────────────────────────────────

const WINDOWS_SEARCH_DIRS = [
  'C:\\Program Files\\Godot',
  'C:\\Program Files (x86)\\Godot',
];

const POSIX_CANDIDATES = [
  '/usr/bin/godot4',
  '/usr/local/bin/godot4',
  '/Applications/Godot.app/Contents/MacOS/Godot',
];

let godotPath: string | null = null;

function findInDirectory(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      if (/^Godot_v4.*\.exe$/i.test(entry)) {
        return join(dir, entry);
      }
    }
  } catch { /* permission denied */ }
  return null;
}

async function findGodot(): Promise<string> {
  if (godotPath) return godotPath;

  const tried: string[] = [];

  // 1. Environment variable
  if (process.env.GODOT_PATH) {
    if (existsSync(process.env.GODOT_PATH)) {
      godotPath = process.env.GODOT_PATH;
      return godotPath;
    }
    tried.push(`GODOT_PATH=${process.env.GODOT_PATH}`);
  }

  // 2. Try `godot` on PATH via a quick spawn
  try {
    const { execSync } = await import('child_process');
    const out = execSync('godot --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (out.includes('Godot')) {
      godotPath = 'godot';
      return godotPath;
    }
  } catch { tried.push('godot (PATH)'); }

  // 3. Platform-specific search
  if (process.platform === 'win32') {
    for (const dir of WINDOWS_SEARCH_DIRS) {
      tried.push(`${dir}/Godot_v4*.exe`);
      const found = findInDirectory(dir);
      if (found) { godotPath = found; return found; }
    }
  } else {
    for (const candidate of POSIX_CANDIDATES) {
      tried.push(candidate);
      if (existsSync(candidate)) { godotPath = candidate; return candidate; }
    }
  }

  throw new Error(
    `Godot binary not found. Tried:\n${tried.map(t => `  - ${t}`).join('\n')}\nSet GODOT_PATH or add godot to PATH.`
  );
}

// ─── Debug output state ──────────────────────────────────────────────────────

let runningProcess: ChildProcess | null = null;
let outputBuffer: string[] = [];
let processStartTime: number = 0;
let projectDir: string = '';

const DEBUG = process.env.DEBUG === 'true';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
}

// ─── Godot config parser ────────────────────────────────────────────────────

function parseGodotConfig(content: string): Record<string, unknown> {
  const lines = content.split('\n');
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
      container[kvMatch[1]] = parseConfigValue(kvMatch[2].trim());
    }
  }

  return sectioned;
}

function parseConfigValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => parseConfigValue(s.trim())).filter(s => s !== '');
  }
  return raw;
}

// ─── GodotServer class ───────────────────────────────────────────────────────

// ─── Write tools (filtered in READ_ONLY_MODE) ─────────────────────────────────

const WRITE_TOOLS = new Set([
  'create_scene', 'add_node', 'save_scene', 'load_sprite', 'batch_add_nodes',
  'write_script', 'edit_script', 'create_test_scene', 'execute_gdscript',
  'import_resources',
  'tilemap_set_cell', 'tilemap_erase_cell', 'tilemap_fill_rect', 'tilemap_clear', 'tilemap_paste', 'tilemap_set_transform',
  'material_write', 'shader_edit',
  'signal_connect', 'signal_disconnect', 'signal_emit',
  'node_create_3d',
  'audio_play', 'audio_stop', 'audio_set_param',
  'capture_screenshot',
  'create_project',
  'confirm_and_execute',
  'edit_node',
  'remove_node',
  'game_bridge_install', 'game_bridge_uninstall',
  'game_query', 'game_input', 'game_wait',
  'dev_loop', 'scene_snapshot', 'batch_validate',
]);

// ─── Lite mode tools (14 core tools) ──────────────────────────────────────────

const LITE_TOOLS = new Set([
  'list_projects', 'get_project_info', 'list_files', 'read_project_config',
  'read_scene', 'create_scene', 'add_node', 'save_scene',
  'read_script', 'write_script', 'edit_script',
  'execute_gdscript', 'get_godot_version',
  'run_and_verify', 'confirm_and_execute',
]);

// ─── Server options ───────────────────────────────────────────────────────────

export interface ServerOptions {
  mode?: 'full' | 'lite';
  readOnly?: boolean;
}

export class GodotServer {
  private server: Server;
  private opsScript: string;
  private options: ServerOptions;

  constructor(opsScript: string, options: ServerOptions = {}) {
    this.opsScript = opsScript;
    this.options = options;
    this.server = new Server(
      { name: 'godot-mcp-enhanced', version: '0.7.0' },
      { capabilities: { tools: {}, resources: {} } }
    );
    this.setupHandlers();
  }

  private async setupHandlers(): Promise<void> {
    // ── Collect tool definitions from all modules ──
    let allTools = toolModules.flatMap(m => m.getToolDefinitions());

    // P0.1: Filter write tools in READ_ONLY_MODE
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !WRITE_TOOLS.has(t.name));
      log('READ_ONLY_MODE: %d tools available', allTools.length);
    }

    // P0.2: Filter to lite toolset
    if (this.options.mode === 'lite') {
      allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
      log('LITE mode: %d tools available', allTools.length);
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools,
    }));

    // ── Build tool context ──
    const ctx = {
      opsScript: this.opsScript,
      findGodot,
      get runningProcess() { return runningProcess; },
      setRunningProcess(proc: ChildProcess | null) { runningProcess = proc; },
      get outputBuffer() { return outputBuffer; },
      setOutputBuffer(buf: string[]) { outputBuffer = buf; },
      get processStartTime() { return processStartTime; },
      setProcessStartTime(t: number) { processStartTime = t; },
      get projectDir() { return projectDir; },
      setProjectDir(d: string) { projectDir = d; },
      parseGodotConfig,
    };

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const startTime = Date.now();
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
        // P1.1: Confirmation Token guard
        if (name === 'confirm_and_execute') {
          const token = args.token as string;
          if (!token || typeof token !== 'string') {
            return { content: [{ type: 'text', text: 'Error: confirmation_token is required' }] };
          }
          const pending = consumeToken(token);
          if (!pending) {
            return { content: [{ type: 'text', text: 'Error: invalid or expired confirmation token' }] };
          }
          // Re-dispatch with original tool name and args
          for (const mod of toolModules) {
            const result = await mod.handleTool(pending.toolName, pending.args, ctx);
            if (result !== null) {
              const duration = Date.now() - startTime;
              result.content.push({ type: 'text', text: `_duration_ms: ${duration}` });
              return result;
            }
          }
          return { content: [{ type: 'text', text: `Unknown tool: ${pending.toolName}` }] };
        }

        if (requiresConfirmation(name)) {
          const token = createPendingToken(name, args);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                requires_confirmation: true,
                tool: name,
                confirmation_token: token,
                message: `Tool "${name}" requires confirmation. Call confirm_and_execute with this token to proceed.`,
                ttl_seconds: 180,
              }),
            }],
          };
        }

        // Dispatch to the appropriate module handler
        for (const mod of toolModules) {
          const result = await mod.handleTool(name, args, ctx);
          if (result !== null) {
            // P0.3: Append duration as separate content entry
            const duration = Date.now() - startTime;
            result.content.push({ type: 'text', text: `_duration_ms: ${duration}` });
            return result;
          }
        }
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
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
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, 'project.godot'))) return dir;
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  // ─── Run ───────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('Godot MCP Enhanced server running on stdio');
  }
}
