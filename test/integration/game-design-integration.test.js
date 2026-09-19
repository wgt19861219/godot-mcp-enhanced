import { describe, it, expect } from 'vitest';
import { getToolDefinitions as getGDDDefs, TOOL_META as gddMeta } from '../../src/tools/game-design.js';
import { getToolDefinitions as getDeliveryDefs } from '../../src/tools/delivery.js';
import { getToolDefinitions as getWorkflowDefs } from '../../src/tools/workflow.js';

describe('Game Design Integration', () => {
  it('all new tools are registered', () => {
    const gddDefs = getGDDDefs();
    const deliveryDefs = getDeliveryDefs();
    const workflowDefs = getWorkflowDefs();

    expect(gddDefs.find(d => d.name === 'game_design')).toBeDefined();
    expect(deliveryDefs.find(d => d.name === 'verify_delivery')).toBeDefined();
    expect(workflowDefs.find(d => d.name === 'workflow')).toBeDefined();
  });

  it('game_design tool supports validate_gdd and chain_verify actions', () => {
    const gddDefs = getGDDDefs();
    const gd = gddDefs.find(d => d.name === 'game_design');
    const actionEnum = gd.inputSchema.properties.action.enum;
    expect(actionEnum).toContain('validate_gdd');
    expect(actionEnum).toContain('chain_verify');
  });

  it('gdd_standards dimension is in verify_delivery schema', () => {
    const deliveryDefs = getDeliveryDefs();
    const vd = deliveryDefs.find(d => d.name === 'verify_delivery');
    const checksProps = vd.inputSchema.properties.checks.properties;
    expect(checksProps.gdd_standards).toBeDefined();
    expect(checksProps.gdd_dirs).toBeDefined();
  });

  it('save_state is in workflow schema', () => {
    const workflowDefs = getWorkflowDefs();
    const wf = workflowDefs.find(d => d.name === 'workflow');
    const props = wf.inputSchema.properties;
    expect(props.save_state).toBeDefined();
    expect(props.save_state.description).toContain('保存会话状态');
  });

  it('TOOL_META has correct entry for game_design', () => {
    expect(gddMeta.game_design).toBeDefined();
    expect(gddMeta.game_design.readonly).toBe(true);
    expect(gddMeta.game_design.long_running).toBe(false);
  });
});
