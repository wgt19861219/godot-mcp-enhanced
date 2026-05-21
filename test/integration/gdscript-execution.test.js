import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { executeGdscript } from '../../build/gdscript-executor.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createTempProject } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level A: GDScript execution pipeline', () => {
  const dirRef = { path: null };
  let godotPath;
  let projectPath;

  // Cleanup after each test
  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch { /* ignore */ }
      dirRef.path = null;
    }
  });

  beforeEach(async () => {
    await ensureGodot();
    godotPath = getGodotPath();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    projectPath = dirRef.path;
  });

  itIfGodot('simple expression output', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });
    assert.ok(result.compile_success, 'Should compile');
    assert.ok(result.run_success, 'Should run');
    assert.equal(result.outputs[0].key, 'result');
    assert.equal(result.outputs[0].value, '42');
  });

  itIfGodot('JSON structured output', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: 'var data = {"a": 1}\n_mcp_output("data", JSON.stringify(data))',
      timeout: 10,
    });
    assert.ok(result.compile_success);
    assert.ok(result.run_success);
    const parsed = JSON.parse(result.outputs[0].value);
    assert.deepEqual(parsed, { a: 1 });
  });

  itIfGodot('compile error detection', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: 'func foo(',
      timeout: 10,
    });
    assert.equal(result.compile_success, false);
    assert.ok(result.compile_error.length > 0, 'Should have compile error message');
  });

  itIfGodot('runtime error capture', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: `var x: Variant = null
x.call("hello")`,
      timeout: 10,
    });
    assert.equal(result.run_success, false);
    assert.ok(result.run_error.length > 0, 'Should have runtime error message');
  });

  itIfGodot('timeout interrupt', async () => {
    const result = await executeGdscript({
      godotPath,
      projectPath,
      code: 'while true:\n\tpass',
      timeout: 3,
    });
    assert.equal(result.success, false, 'Should fail due to timeout');
    assert.ok(result.duration_ms < 10000, `Should terminate within 10s, took ${result.duration_ms}ms`);
  });
});
