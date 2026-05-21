// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';
import type { ToolResult } from '../types.js';

export class EditorToolExecutor {
  private syncActive = false;
  private treeChangeBuffer: Array<{ type: string; path: string; node_type: string }> = [];
  private static readonly MAX_BUFFER_SIZE = 10000;
  private readonly conn: EditorConnection;

  constructor(conn: EditorConnection) {
    this.conn = conn;
    this.conn.onDisconnect = () => {
      this.syncActive = false;
      this.treeChangeBuffer = [];
    };
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (toolName === 'editor_sync_start') {
        return this.handleSyncStart(args);
      }
      if (toolName === 'editor_sync_stop') {
        return this.handleSyncStop(args);
      }
      if (toolName === 'editor_get_scene_tree') {
        return this.handleGetSceneTree(args);
      }

      // Default: forward to plugin
      const result = await this.conn.request(toolName, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
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
