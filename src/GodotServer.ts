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
import { waitForEditorSecret } from './core/editor-auth.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';

// ─── Import and register tool modules ────────────────────────────────────────
import { registerModule } from './core/tool-registry.js';

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
import * as gameDesign from './tools/game-design.js';

// Self-register all modules into the registry
for (const mod of [runtime, screenshot, project, scene, script, validation, docs, node3dOps, physicsOps, audioOps, tilemapOps, materialOps, gameBridge, workflow, animationOps, animationTrack, profilerOps, spatialOps, testFramework, animtreeOps, navigationOps, particlesOps, signalOps, batchTools, uiOps, recordingOps, editorSync, delivery, codeTemplates, ikTools, gameDesign]) {
  registerModule(mod);
}


import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkgVersion = require('../package.json').version;
import { ReadOnlyGuard } from './core/ReadOnlyGuard.js';
import { ToolDispatcher } from './core/ToolDispatcher.js';
import { EditorConnection } from './core/EditorConnection.js';
import { EditorToolExecutor } from './core/EditorToolExecutor.js';
import { findGodot, clearGodotPathCache, getCachedGodotPath } from './core/godot-finder.js';
import * as ps from './core/process-state.js';
import { killProcess } from './core/process-state.js';

// Re-export for backward compatibility (tests import from GodotServer)
export { clearGodotPathCache, getCachedGodotPath };

const DEBUG = process.env.DEBUG === 'true';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[godot-mcp]', ...args);
}

// ─── GodotServer class ───────────────────────────────────────────────────────

// ─── Server options ───────────────────────────────────────────────────────────

export interface ServerOptions {
  mode?: 'full' | 'lite' | 'minimal';
  connectionMode?: 'headless' | 'editor';
  readOnly?: boolean;
  noFallback?: boolean;
}

export class GodotServer {
  private server: Server;
  private opsScript: string;
  private options: ServerOptions;
  private readOnlyGuard: ReadOnlyGuard;
  private dispatcher: ToolDispatcher | null = null;
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
    const dispatcher = new ToolDispatcher({
      readOnly: this.options.readOnly ?? false,
      mode: this.options.mode ?? 'full',
      readOnlyGuard: this.readOnlyGuard,
      connectionMode: this.connectionMode,
      noFallback: this.noFallback,
      opsScript: this.opsScript,
      findGodot,
    });
    this.dispatcher = dispatcher;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: dispatcher.getFilteredTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      dispatcher.handleCall(request)
    );

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
    // Allow explicit override via environment variable
    const envPath = process.env.GODOT_PROJECT_PATH;
    if (envPath) {
      if (existsSync(join(envPath, 'project.godot'))) return envPath;
      console.error(`GODOT_PROJECT_PATH="${envPath}" does not contain project.godot, ignoring`);
    }
    let dir = process.cwd();
    for (let i = 0; i < 15; i++) {
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
      }
      if (!secret) {
        console.error('[AUTH] No editor secret found — plugin may not be running');
        if (this.noFallback) {
          console.error('[FATAL] Editor auth required but no secret available. Install the editor plugin.');
          process.exit(1);
        }
        console.error('[FALLBACK] Running in Headless mode (no editor auth).');
        this.dispatcher?.markEditorFallback();
        this.connectionMode = 'headless';
        this.dispatcher?.setConnectionMode('headless');
      } else {
        this.editorConn = new EditorConnection({ port, reconnect: true, secret });
        try {
          await this.editorConn.connect();
          this.editorExecutor = new EditorToolExecutor(this.editorConn);
          this.dispatcher?.setEditorExecutor(this.editorExecutor);
          log('Editor: Connected to Godot plugin on port %d', port);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.noFallback) {
            console.error(`[FATAL] Editor mode required but connection failed: ${msg}`);
            console.error('Set GODOT_MCP_NO_FALLBACK=false to allow fallback, or install the plugin.');
            process.exit(1);
          }
          console.error(`[FALLBACK] Editor connection failed: ${msg}.`);
          console.error('[FALLBACK] Running in Headless mode. UndoRedo disabled, no scene state persistence.');
          this.dispatcher?.markEditorFallback();
          this.connectionMode = 'headless';
          this.dispatcher?.setConnectionMode('headless');
          this.editorConn = null;
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.editorConn) {
      this.editorConn.disconnect();
      this.editorConn = null;
      this.dispatcher?.setEditorExecutor(null);
      log('Editor connection closed');
    }
    const proc = ps.getRunningProcess();
    if (proc && !proc.killed) {
      await killProcess(proc);
      ps.setProcessBusy(false);
      ps.setRunningProcess(null);
      log('Running Godot process killed');
    }
    await this.server.close();
    log('Server shut down');
  }
}
