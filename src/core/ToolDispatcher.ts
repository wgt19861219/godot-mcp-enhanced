// src/core/ToolDispatcher.ts
import type { ToolResult, ToolContext } from '../types.js';
import type { ChildProcess } from 'child_process';
import type { ReadOnlyGuard } from './ReadOnlyGuard.js';
import type { EditorToolExecutor } from './EditorToolExecutor.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  requiresConfirmation,
  createPendingToken,
  consumeToken,
} from '../guard.js';
import {
  getAllToolDefinitions,
  getModuleForTool,
  LITE_TOOLS,
  MINIMAL_TOOLS,
} from './tool-registry.js';
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
import { opsErrorResult, COMMON_ERROR_CODES } from '../tools/shared.js';
import * as ps from './process-state.js';

const DEBUG = process.env.DEBUG === 'true';
function log(...args: unknown[]): void {
  if (DEBUG) console.error('[tool-dispatcher]', ...args);
}

export interface DispatcherOptions {
  // 模式控制
  readOnly: boolean;
  mode: 'full' | 'lite' | 'minimal';
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;

  // 依赖注入
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  opsScript: string;
  findGodot: () => Promise<string>;
}

export class ToolDispatcher {
  private readonly options: DispatcherOptions;
  private readonly readOnlyGuard: ReadOnlyGuard;
  private connectionMode: 'headless' | 'editor';
  private editorExecutor: EditorToolExecutor | null;
  private readonly ctx: ToolContext;
  private _editorFallback = false;
  private _editorFallbackWarned = false;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.readOnlyGuard = options.readOnlyGuard;
    this.connectionMode = options.connectionMode;
    this.editorExecutor = options.editorExecutor ?? null;

    // 构建 ctx — 直接 import process-state（内部实现细节）
    this.ctx = {
      opsScript: options.opsScript,
      findGodot: options.findGodot,
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
  }

  getFilteredTools(): Tool[] {
    let allTools = getAllToolDefinitions();

    // 内联工具: confirm_and_execute
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

    // READ_ONLY_MODE 过滤
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !this.readOnlyGuard.check(t.name).blocked);
      log('READ_ONLY_MODE: %d tools available', allTools.length);
    }

    // LITE 模式过滤
    if (this.options.mode === 'lite') {
      allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
      log('LITE mode: %d tools available', allTools.length);
    } else if (this.options.mode === 'minimal') {
      allTools = allTools.filter(t => MINIMAL_TOOLS.has(t.name));
      log('MINIMAL mode: %d tools available', allTools.length);
    }

    return allTools;
  }

  async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> {
    const { name, arguments: rawArgs } = request.params;
    const startTime = Date.now();
    const args = this.normalizeArgs(rawArgs);

    try {
      // ── 0. Common arg type validation ──
      const typeErr = this.validateCommonArgs(args);
      if (typeErr) return typeErr;

      // ── 1. ReadOnlyGuard ──
      const guardResult = this.readOnlyGuard.check(name);
      if (guardResult.blocked) {
        return opsErrorResult(String(guardResult.errorCode ?? 'READ_ONLY'), guardResult.message ?? 'Operation blocked in read-only mode');
      }

      // ── 2. confirm_and_execute 分支 ──
      if (name === 'confirm_and_execute') {
        const token = args.token as string;
        if (!token || typeof token !== 'string') {
          return opsErrorResult('MISSING_TOKEN', 'confirmation_token is required');
        }
        const pending = consumeToken(token);
        if (!pending) {
          return opsErrorResult('INVALID_TOKEN', 'Invalid or expired confirmation token');
        }

        // 二次 guard 检查
        const confirmedGuardResult = this.readOnlyGuard.check(pending.toolName);
        if (confirmedGuardResult.blocked) {
          return opsErrorResult(String(confirmedGuardResult.errorCode ?? 'READ_ONLY'), confirmedGuardResult.message ?? 'Operation blocked in read-only mode');
        }

        // 复用同一 editor/headless 分支逻辑
        log('[CONFIRM] Executing confirmed tool: %s', pending.toolName);
        if (this.connectionMode === 'editor' && this.editorExecutor) {
          const editorResult = await this.editorExecutor.execute(pending.toolName, pending.args);
          const duration = Date.now() - startTime;
          return this.attachFallbackWarning({ ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
        }
        return this.attachFallbackWarning(await this.dispatchTool(pending.toolName, pending.args, startTime));
      }

      // ── 3. 确认令牌检查 ──
      if (requiresConfirmation(name, args)) {
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

      // ── 4. editor 模式 dispatch ──
      if (this.connectionMode === 'editor' && this.editorExecutor) {
        const editorResult = await this.editorExecutor.execute(name, args);
        const duration = Date.now() - startTime;
        return this.attachFallbackWarning({ ...editorResult, content: [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
      }

      // ── 5. headless dispatch ──
      return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Tool error:', name, msg);
      return opsErrorResult('TOOL_ERROR', msg);
    }
  }

  setConnectionMode(mode: 'headless' | 'editor'): void {
    this.connectionMode = mode;
  }

  setEditorExecutor(executor: EditorToolExecutor | null): void {
    if (this.editorExecutor) {
      this.editorExecutor.destroy();
    }
    this.editorExecutor = executor;
  }

  /** 标记 editor fallback 状态（由 GodotServer.run() 调用） */
  markEditorFallback(): void {
    this._editorFallback = true;
  }

  /** Convert camelCase arg keys to snake_case. Only top-level keys are converted; nested objects are left intact. */
  private normalizeArgs(rawArgs: Record<string, unknown> | undefined): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (rawArgs) {
      for (const [key, value] of Object.entries(rawArgs)) {
        const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        args[snake] = value;
      }
    }
    return args;
  }

  /** Validate common arg types (project_path, action). Returns error ToolResult or null. */
  private validateCommonArgs(args: Record<string, unknown>): ToolResult | null {
    if ('project_path' in args) {
      const v = args.project_path;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `project_path must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    if ('action' in args) {
      const v = args.action;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `action must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    return null;
  }

  private validatePathArgs(args: Record<string, unknown>): ToolResult | null {
    if (typeof args.project_path === 'string' && !isPathInAllowedRoots(args.project_path)) {
      return opsErrorResult('PATH_NOT_ALLOWED', `Path not in ALLOWED_PROJECT_PATHS: ${args.project_path}`);
    }
    if (typeof args.search_dir === 'string' && !isPathInAllowedRoots(args.search_dir)) {
      return opsErrorResult('PATH_NOT_ALLOWED', `Search directory not in ALLOWED_PROJECT_PATHS: ${args.search_dir}. Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true.`);
    }
    return null;
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
    const pathErr = this.validatePathArgs(args);
    if (pathErr) return pathErr;
    const targetMod = getModuleForTool(toolName);
    if (!targetMod) {
      return opsErrorResult('UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
    }
    const result = await targetMod.handleTool(toolName, args, this.ctx);
    if (result !== null) {
      const duration = Date.now() - startTime;
      return { ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
    }
    return opsErrorResult('HANDLER_NULL', `Tool "${toolName}" registered but handler returned null`);
  }

  private attachFallbackWarning(result: ToolResult): ToolResult {
    if (this._editorFallback && !this._editorFallbackWarned) {
      this._editorFallbackWarned = true;
      const first = result.content?.[0];
      if (first?.type === 'text') {
        first.text += '\n\n⚠️ [EDITOR_FALLBACK] Running in Headless mode — Editor features (UndoRedo, live scene sync) unavailable.';
      }
    }
    return result;
  }
}
