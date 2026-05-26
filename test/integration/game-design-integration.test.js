import { describe, it, expect } from 'vitest';
import { getToolDefinitions as getGDDDefs, TOOL_META as gddMeta } from '../../src/tools/game-design.js';
import { getToolDefinitions as getDeliveryDefs } from '../../src/tools/delivery.js';
import { getToolDefinitions as getWorkflowDefs } from '../../src/tools/workflow.js';

describe('Game Design Integration', () => {
  it('all new tools are registered', () => {
    const gddDefs = getGDDDefs();
    const deliveryDefs = getDeliveryDefs();
    const workflowDefs = getWorkflowDefs();

    expect(gddDefs.find(d => d.name === 'validate_gdd')).toBeDefined();
    expect(gddDefs.find(d => d.name === 'chain_verify')).toBeDefined();
    expect(deliveryDefs.find(d => d.name === 'verify_delivery')).toBeDefined();
    expect(workflowDefs.find(d => d.name === 'dev_loop')).toBeDefined();
  });

  it('gdd_standards dimension is in verify_delivery schema', () => {
    const deliveryDefs = getDeliveryDefs();
    const vd = deliveryDefs.find(d => d.name === 'verify_delivery');
    const checksProps = vd.inputSchema.properties.checks.properties;
    expect(checksProps.gdd_standards).toBeDefined();
    expect(checksProps.gdd_dirs).toBeDefined();
  });

  it('save_state is in dev_loop schema', () => {
    const workflowDefs = getWorkflowDefs();
    const dl = workflowDefs.find(d => d.name === 'dev_loop');
    const props = dl.inputSchema.properties;
    expect(props.save_state).toBeDefined();
    expect(props.save_state.description).toContain('file-as-memory');
  });

  it('TOOL_META has correct entries for new tools', () => {
    expect(gddMeta.validate_gdd.readonly).toBe(true);
    expect(gddMeta.chain_verify.readonly).toBe(true);
  });
});
