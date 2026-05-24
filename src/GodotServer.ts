import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import type { ToolResult, ToolContext } from './types.js';
import { waitForEditorSecret } from './core/editor-auth.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';
import { parseGodotConfig, isPathInAllowedRoots } from './helpers.js';

// ─── Import modular tool handlers ───────────────────────────────────────────
import * as runtime from './tools/runtime.js';
import * as screenshot from './tools/screenshot.js';
import * as project from './tools/project.js';
import * as scene from './tools/scene.js';
import * as script from './tools/script.js';
import * as validation from './tools/validation.js';
import * as docs from './tools/docs.js';
import * as node3dOps from './tools/node-3d-ops.js';
import * as physicsOps from './tools/physics-ops.js';
import * as audioOps from './tools/audio-ops.js';
import * as tilemapOps from './tools/tilemap-ops.js';
import * as materialOps from './tools/material-ops.js';
import * as gameBridge from './tools/game-bridge.js';
import * as workflow from './tools/workflow.js';
import * as animationOps from './tools/animation-ops.js';
import * as profilerOps from './tools/profiler-ops.js';
import * as spatialOps from './tools/spatial-ops.js';
import * as testFramework from './tools/test-framework.js';
import * as animtreeOps from './tools/animtree.js';
import * as navigationOps from './tools/navigation.js';
import * as particlesOps from './tools/particles.js';
import * as signalOps from './tools/signal-ops.js';
import * as batchTools from './tools/batch-tools.js';
import * as uiOps from './tools/ui-tools.js';
import * as recordingOps from './tools/recording.js';
import * as editorSync from './tools/editor-sync.js';
import * as animationTrack from './tools/animation-track.js';
import * as delivery from './tools/delivery.js';
import * as codeTemplates from './tools/code-templates.js';
import * as ikTools from './tools/ik-tools.js';
import { requiresConfirmation, createPendingToken, consumeToken } from './guard.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkgVersion = require('../package.json').version;
import { registerTools, LITE_TOOLS } from './core/tool-registry.js';
import { ReadOnlyGuard } from './core/ReadOnlyGuard.js';
import { EditorConnection } from './core/EditorConnection.js';
import { EditorToolExecutor } from './core/EditorToolExecutor.js';
import { findGodot, clearGodotPathCache, getCachedGodotPath } from './core/godot-finder.js';
import * as ps from './core/process-state.js';
import { killProcess } from './core/process-state.js';

// Re-export for backward compatibility (tests import from GodotServer)
export { clearGodotPathCache, getCachedGodotPath };

const toolModules = [runtime, screenshot, project, scene, script, validation, docs, node3dOps, physicsOps, audioOps, tilemapOps, materialOps, gameBridge, workflow, animationOps, animationTrack, profilerOps, spatialOps, testFramework, animtreeOps, navigationOps, particlesOps, signalOps, batchTools, uiOps, recordingOps, editorSync, delivery, codeTemplates, ikTools];

interface ToolMetaExport {
  TOOL_META?: Record<string, { readonly: boolean; long_running: boolean }>;
}

// 注册工具标签 + 构建工具名→模块映射
const allMeta: Array<{ name: string; readonly: boolean; long_running: boolean }> = [];
const toolModuleMap = new Map<string, typeof toolModules[number]>();
for (const mod of toolModules) {
  const meta = (mod as ToolMetaExport).TOOL_META;
  if (meta) {
    for (const [name, m] of Object.entries(meta)) {
      allMeta.push({ name, ...m });
      toolModuleMap.set(name, mod);
    }
  }
}
registerTools(allMeta);

async function dispatchTool(
  toolName: string, args: Record<string, unknown>, ctx: ToolContext, startTime: number
): Promise<ToolResult> {
  // C-03: Validate project_path against whitelist
  if (typeof args.project_path === 'string' && !isPathInAllowedRoots(args.project_path)) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'PATH_NOT_ALLOWED', message: `Path not in ALLOWED_PROJECT_PATHS: ${args.project_path}` } }) }], isError: true };
  }
  const targetMod = toolModuleMap.get(toolName);
  if (!targetMod) {
    return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] };
  }
  const result = await targetMod.handleTool(toolName, args, ctx);
  if (result !== null) {
    const duration = Date.now() - startTime;
    return { ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
  }
  return { content: [{ type: 'text', text: `Tool "${toolName}" registered but handler returned null` }] };
}

const DEBUG = process.env.DEBUG === 'true';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
}

// ─── GodotServer class ───────────────────────────────────────────────────────

// ─── Server options ───────────────────────────────────────────────────────────

export interface ServerOptions {
  mode?: 'full' | 'lite';
  connectionMode?: 'headless' | 'editor';
  readOnly?: boolean;
  noFallback?: boolean;
}

export class GodotServer {
  private server: Server;
  private opsScript: string;
  private options: ServerOptions;
  private readOnlyGuard: ReadOnlyGuard;
  private editorConn: EditorConnection | null = null;
  private editorExecutor: EditorToolExecutor | null = null;
  private connectionMode: 'headless' | 'editor';
  private noFallback: boolean;

  constructor(opsScript: string, options: ServerOptions = {}) {
    this.opsScript = opsScript;
    this.options = options;
    this.readOnlyGuard = new ReadOnlyGuard(options.readOnly ?? false);
    this.connectionMode = options.connectionMode ?? 'headless';
    this.noFallback = options.noFallback ?? false;
    this.server = new Server(
      { name: 'godot-mcp-enhanced', version: pkgVersion },
      { capabilities: { tools: {}, resources: {} } }
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // ── Collect tool definitions from all modules ──
    let allTools = toolModules.flatMap(m => m.getToolDefinitions());

    // Inline tool: confirm_and_execute (for confirmation token flow)
    allTools.push({
      name: 'confirm_and_execute',
      description: 'Execute a previously blocked tool using a confirmation token. Use this when a tool returns a confirmation_token.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: { type: 'string', description: 'Confirmation token from the blocked tool response' },
        },
        required: ['token'],
      },
    });

    // P0.1: Filter write tools in READ_ONLY_MODE
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !this.readOnlyGuard.check(t.name).blocked);
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
      get runningProcess() { return ps.getRunningProcess(); },
      setRunningProcess(proc: ChildProcess | null) { ps.setRunningProcess(proc); },
      get outputBuffer() { return ps.getOutputBuffer(); },
      setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
      get processStartTime() { return ps.getProcessStartTime(); },
      setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
      get projectDir() { return ps.getProjectDir(); },
      setProjectDir(d: string) { ps.setProjectDir(d); },
      parseGodotConfig,
    };

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const startTime = Date.now();
      // Normalize camelCase -> snake_case
      const args: Record<string, unknown> = {};
      if (rawArgs) {
        for (const [key, value] of Object.entries(rawArgs)) {
          const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
          args[snake] = value;
        }
      }
      try {
        // ReadOnlyGuard check
        const guardResult = this.readOnlyGuard.check(name);
        if (guardResult.blocked) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: guardResult.errorCode, message: guardResult.message } }) }],
            isError: true,
          };
        }

        // P1.1: Confirmation Token guard (applies to both editor and headless modes)
        if (name === 'confirm_and_execute') {
          const token = args.token as string;
          if (!token || typeof token !== 'string') {
            return { content: [{ type: 'text', text: 'Error: confirmation_token is required' }] };
          }
          const pending = consumeToken(token);
          if (!pending) {
            return { content: [{ type: 'text', text: 'Error: invalid or expired confirmation token' }] };
          }
          // S-1: Build operation summary for user visibility
          const summaryArgs = { ...pending.args };
          log('[CONFIRM] Executing confirmed tool: %s', pending.toolName);
          // Re-check ReadOnlyGuard for the confirmed tool
          const guardResult = this.readOnlyGuard.check(pending.toolName);
          if (guardResult.blocked) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: guardResult.errorCode, message: guardResult.message } }) }],
              isError: true,
            };
          }
          // Re-dispatch with original tool name and args
          if (this.connectionMode === 'editor' && this.editorExecutor) {
            const editorResult = await this.editorExecutor.execute(pending.toolName, pending.args);
            const duration = Date.now() - startTime;
            return { ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
          }
          return dispatchTool(pending.toolName, pending.args, ctx, startTime);
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
        // Editor mode: forward to plugin (after guard + confirmation checks)
        if (this.connectionMode === 'editor' && this.editorExecutor) {
          const editorResult = await this.editorExecutor.execute(name, args);
          const duration = Date.now() - startTime;
          return { ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
        }

        return dispatchTool(name, args, ctx, startTime);
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

    if (this.connectionMode === 'editor') {
      const port = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);
      const projectPath = this.detectProjectPath();
      let secret: string | undefined;
      if (projectPath) {
        secret = (await waitForEditorSecret(projectPath, 5000)) ?? undefined;
        if (!secret) {
          console.error('[AUTH] No editor secret found — plugin may not be running');
        }
      }
      this.editorConn = new EditorConnection({ port, reconnect: true, secret });
      try {
        await this.editorConn.connect();
        this.editorExecutor = new EditorToolExecutor(this.editorConn);
        log('Editor: Connected to Godot plugin on port %d', port);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.noFallback) {
          console.error(`[FATAL] Editor mode required but connection failed: ${msg}`);
          console.error('Set GODOT_MCP_NO_FALLBACK=false to allow fallback, or install the plugin.');
          process.exit(1);
        }
        console.error(`[FALLBACK] Editor mode requested but plugin not found at port ${port}.`);
        console.error('[FALLBACK] Running in Headless mode. UndoRedo disabled, no scene state persistence.');
        console.error('[FALLBACK] To enforce editor mode, set GODOT_MCP_NO_FALLBACK=true.');
        this.connectionMode = 'headless';
        this.editorConn = null;
      }
    }
  }

  async close(): Promise<void> {
    if (this.editorConn) {
      this.editorConn.disconnect();
      this.editorConn = null;
      this.editorExecutor = null;
      log('Editor connection closed');
    }
    const proc = ps.getRunningProcess();
    if (proc && !proc.killed) {
      await killProcess(proc);
      ps.setRunningProcess(null);
      log('Running Godot process killed');
    }
    await this.server.close();
    log('Server shut down');
  }
}
