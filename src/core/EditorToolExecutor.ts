// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';
import type { ToolResult } from '../types.js';
import { isReadOnly, isKnownTool } from './tool-registry.js';

export class EditorToolExecutor {
  private syncActive = false;
  private treeChangeBuffer: Array<{ type: string; path: string; node_type: string }> = [];
  private static readonly MAX_BUFFER_SIZE = 10000;
  private readonly conn: EditorConnection;

  /** Bound handlers stored so we can remove them on destroy. */
  private readonly _disconnectHandler = (): void => {
    this.syncActive = false;
    this.treeChangeBuffer = [];
  };
  private readonly _reconnectHandler = (): void => {
    if (this.syncActive) {
      this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
    }
  };

  constructor(conn: EditorConnection) {
    this.conn = conn;
    this.conn.addOnDisconnectHandler(this._disconnectHandler);
    this.conn.addOnReconnectHandler(this._reconnectHandler);
  }

  /** Remove all handlers from the connection. Call when discarding this executor. */
  destroy(): void {
    this.conn.removeOnDisconnectHandler(this._disconnectHandler);
    this.conn.removeOnReconnectHandler(this._reconnectHandler);
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (toolName === 'editor') {
        const action = args.action as string;
        if (action === 'sync_start') return this.handleSyncStart(args);
        if (action === 'sync_stop') return this.handleSyncStop(args);
        if (action === 'get_scene_tree') return this.handleGetSceneTree(args);
      }

      // For write operations, attach _use_undo flag so the editor plugin
      // can route through undo_manager. The plugin-side handlers already
      // use undo_manager for mutating operations (add_node, particles_create,
      // nav_create_region, etc.) — this flag enables future unified undo
      // control across all editor tool handlers.
      // TODO: 待编辑器插件后续集成 — 统一通过 _use_undo 标志控制 undo 行为
      const isWriteOp = isKnownTool(toolName) && !isReadOnly(toolName);
      const payload: Record<string, unknown> = {
        ...args,
        ...(isWriteOp ? { _use_undo: true } : {}),
      };

      // Default: forward to plugin
      const result = await this.conn.request(toolName, payload);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      if (err instanceof Error && ('code' in err || 'data' in err)) {
        // Preserve structured error info from editor plugin (I-12)
        const structured: Record<string, unknown> = { error: err.message };
        if ('code' in err) structured.code = (err as Record<string, unknown>).code;
        if ('data' in err) structured.data = (err as Record<string, unknown>).data;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  private handleTreeChange = (params: unknown): void => {
    if (typeof params !== 'object' || params === null) return;
    const p = params as { type: string; path: string; node_type: string };
    if (typeof p.type !== 'string' || typeof p.path !== 'string') return;
    if (this.treeChangeBuffer.length >= EditorToolExecutor.MAX_BUFFER_SIZE) {
      this.treeChangeBuffer.shift(); // 丢弃最旧
    }
    this.treeChangeBuffer.push(p);
  };

  private async handleSyncStart(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_ALREADY_ACTIVE' }) }],
        isError: true,
      };
    }
    this.treeChangeBuffer = [];
    this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
    try {
      const result = await this.conn.request('editor_sync_start', args);
      this.syncActive = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  private async handleSyncStop(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_NOT_ACTIVE' }) }],
        isError: true,
      };
    }
    this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
    this.syncActive = false;
    const changes = [...this.treeChangeBuffer];
    this.treeChangeBuffer = [];
    try {
      const result = await this.conn.request('editor_sync_stop', args);
      const merged = typeof result === 'object' && result !== null
        ? { ...(result as Record<string, unknown>), buffered_changes: changes }
        : { result, buffered_changes: changes };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(merged) }],
      };
    } catch (err) {
      // 即使 request 失败（如已断连），仍然返回已缓冲的变更
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ warning: message, buffered_changes: changes }) }],
      };
    }
  }

  private async handleGetSceneTree(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.conn.request('editor_get_scene_tree', args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
}
