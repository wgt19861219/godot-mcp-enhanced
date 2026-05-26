import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
} from '../src/tools/editor-sync.js';

describe('editor-sync tools', () => {
  describe('getToolDefinitions', () => {
    it('returns definitions for editor_sync_start, editor_sync_stop, editor_get_scene_tree', () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('editor_sync_start');
      expect(names).toContain('editor_sync_stop');
      expect(names).toContain('editor_get_scene_tree');
    });

    it('each definition has name, description, and inputSchema', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('TOOL_META', () => {
    it('marks editor_sync_start as not readonly and not long_running', () => {
      expect(TOOL_META.editor_sync_start.readonly).toBe(false);
      expect(TOOL_META.editor_sync_start.long_running).toBe(false);
    });

    it('marks editor_get_scene_tree as readonly', () => {
      expect(TOOL_META.editor_get_scene_tree.readonly).toBe(true);
    });
  });
});
