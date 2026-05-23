// test/integration/gdscript-execution.test.js

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeGdscript } from '../../build/gdscript-executor.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

// integration-setup.js 和 tool-context.js 依赖全局 it/afterEach
globalThis.it = it;
globalThis.afterEach = afterEach;

describe('Level A: GDScript Execution Pipeline', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('1. simple expression output', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });

    assert.ok(result.compile_success, 'Should compile');
    assert.ok(result.run_success, 'Should run');
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].value, '42');
  });

  itIfGodot('2. JSON structured output', async () => {
    const data = JSON.stringify({ a: 1, b: 'hello' });
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `_mcp_output("data", '${data}')`,
      timeout: 10,
    });

    assert.ok(result.compile_success);
    assert.ok(result.run_success);
    const parsed = JSON.parse(result.outputs[0].value);
    assert.deepEqual(parsed, { a: 1, b: 'hello' });
  });

  itIfGodot('3. compile error detection', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'func foo(',
      timeout: 10,
    });

    assert.equal(result.compile_success, false, 'Should NOT compile');
    assert.ok(result.compile_error, 'Should have compile_error');
  });

  itIfGodot('4. runtime error capture', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `var x: Variant = null
x.call("hello")`,
      timeout: 10,
    });

    assert.ok(result.compile_success, 'Should compile');
    assert.equal(result.run_success, false, 'Should fail at runtime');
    assert.ok(result.run_error, 'Should have run_error');
  });

  itIfGodot('5. timeout interrupts infinite loop', async () => {
    const start = Date.now();
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'while true: pass',
      timeout: 3,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 10000, `Should terminate within 10s (took ${elapsed}ms)`);
    assert.equal(result.run_success, false, 'Should report failure');
  });
});
