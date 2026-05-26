// test/delivery-gdd.test.js
import { expect } from 'vitest';

describe('delivery gdd_standards dimension', () => {
  it('should accept gdd_standards in checks schema', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const checksProps = tool.inputSchema.properties.checks.properties;
    expect('gdd_standards' in checksProps).toBeTruthy();
    expect(checksProps.gdd_standards.type).toBe('boolean');
  });

  it('should accept gdd_dirs in checks schema', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const checksProps = tool.inputSchema.properties.checks.properties;
    expect('gdd_dirs' in checksProps).toBeTruthy();
    expect(checksProps.gdd_dirs.type).toBe('array');
    expect(checksProps.gdd_dirs.items.type).toBe('string');
  });
});
