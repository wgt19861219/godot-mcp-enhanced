// test/core/get-context-registration.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  ALWAYS_ALLOWED,
  NO_PROJECT_PATH_TOOLS,
  getGroupForTool,
  isToolAllowed,
  skipProjectPath,
} from '../../src/core/tool-registry.js';

describe('godot_get_context registration', () => {
  it('belongs to core group via core.tools', () => {
    expect(getGroupForTool('godot_get_context')).toBe('core');
    expect(TOOL_GROUPS.core.tools).toContain('godot_get_context');
  });

  it('is always allowed', () => {
    expect(ALWAYS_ALLOWED.has('godot_get_context')).toBe(true);
    expect(isToolAllowed('godot_get_context')).toBe(true);
  });

  it('skips project_path requirement', () => {
    expect(NO_PROJECT_PATH_TOOLS.has('godot_get_context')).toBe(true);
    expect(skipProjectPath('godot_get_context')).toBe(true);
  });

  it('help/debug/engine 免注入(反馈 2026-11-18:schema 未声明 project_path,dispatcher 注入即被未知参数检查拒)', () => {
    for (const t of ['help', 'debug', 'engine']) {
      expect(skipProjectPath(t), t).toBe(true);
    }
  });
});
