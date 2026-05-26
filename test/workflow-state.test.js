import { describe, it, expect } from 'vitest';
import { formatSessionState, buildStateBlock } from '../build/tools/workflow.js';

describe('Session State', () => {
  it('formatSessionState should produce valid markdown', () => {
    const state = {
      current_task: 'Implementing combat hitbox detection',
      epic: 'Combat System',
      feature: 'Melee Combat',
      files_modified: ['scripts/combat/hitbox.gd', 'scenes/combat/melee.tscn'],
      decisions: ['Use Area3D for hitbox instead of RayCast3D'],
      open_questions: ['Should hitbox persist across animation frames?'],
    };
    const md = formatSessionState(state);
    expect(md).toContain('## Current Task');
    expect(md).toContain('Implementing combat hitbox detection');
    expect(md).toContain('scripts/combat/hitbox.gd');
    expect(md).toContain('## Open Questions');
    expect(md).toContain('- [ ]');
  });

  it('buildStateBlock should produce STATUS block', () => {
    const block = buildStateBlock('Combat System', 'Melee Combat', 'Hitbox detection');
    expect(block).toContain('<!-- STATUS -->');
    expect(block).toContain('Epic: Combat System');
    expect(block).toContain('Feature: Melee Combat');
    expect(block).toContain('Task: Hitbox detection');
    expect(block).toContain('<!-- /STATUS -->');
  });

  it('buildStateBlock should omit empty fields', () => {
    const block = buildStateBlock('Combat System', '', '');
    expect(block).toContain('Epic: Combat System');
    expect(block).not.toContain('Feature:');
    expect(block).not.toContain('Task:');
  });
});
