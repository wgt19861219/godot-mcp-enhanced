import { expect, it, beforeEach, describe, vi } from 'vitest';

// Mock the executor — hoisted to top by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [], raw_output: '', duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

import { executeGdscript } from '../src/gdscript-executor.js';
import { createTempProject, registerCleanup } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

describe('Level A: GDScript Execution Pipeline', () => {
  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  it('1. simple expression output', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'result', value: '42' }],
      raw_output: '', duration_ms: 100,
    });

    const result = await executeGdscript({
      godotPath: 'godot',
      projectPath: dirRef.path,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBeTruthy();
    expect(result.outputs.length).toBe(1);
    expect(result.outputs[0].value).toBe('42');
  });

  it('2. JSON structured output', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'data', value: '{"a":1,"b":"hello"}' }],
      raw_output: '', duration_ms: 100,
    });

    const data = JSON.stringify({ a: 1, b: 'hello' });
    const result = await executeGdscript({
      godotPath: 'godot',
      projectPath: dirRef.path,
      code: `_mcp_output("data", '${data}')`,
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBeTruthy();
    const parsed = JSON.parse(result.outputs[0].value);
    expect(parsed).toEqual({ a: 1, b: 'hello' });
  });

  it('3. compile error detection', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: false, compile_success: false, compile_error: 'Expected indented block',
      errors: [{ type: 'compile', file: 'test.gd', line: 1, message: 'Expected indented block', suggestion: '' }],
      run_success: false, run_error: '',
      outputs: [], raw_output: '', duration_ms: 50,
    });

    const result = await executeGdscript({
      godotPath: 'godot',
      projectPath: dirRef.path,
      code: 'func foo(',
      timeout: 10,
    });

    expect(result.compile_success).toBe(false);
    expect(result.compile_error).toBeTruthy();
  });

  it('4. runtime error capture', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: false, compile_success: true, compile_error: '',
      errors: [{ type: 'runtime', file: 'test.gd', line: 2, message: 'null instance', suggestion: '' }],
      run_success: false, run_error: 'null instance',
      outputs: [], raw_output: '', duration_ms: 100,
    });

    const result = await executeGdscript({
      godotPath: 'godot',
      projectPath: dirRef.path,
      code: `var x: Variant = null
	x.call("hello")`,
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBe(false);
    expect(result.run_error).toBeTruthy();
  });

  it('5. timeout interrupts infinite loop', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: false, compile_success: true, compile_error: '',
      errors: [], run_success: false, run_error: 'Timeout',
      outputs: [], raw_output: '', duration_ms: 3000,
    });

    const start = Date.now();
    const result = await executeGdscript({
      godotPath: 'godot',
      projectPath: dirRef.path,
      code: 'while true: pass',
      timeout: 3,
    });
    const elapsed = Date.now() - start;

    expect(elapsed < 10000).toBeTruthy();
    expect(result.run_success).toBe(false);
  });
});
