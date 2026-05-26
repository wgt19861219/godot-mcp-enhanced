import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/screenshot.js';

// ─── Mock screenshot module ────────────────────────────────────────────────

vi.mock('../src/screenshot.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    captureScreenshot: vi.fn(async () => ({
      success: true,
      imagePath: '/tmp/test-screenshot.png',
      fileSize: 4096,
      width: 1280,
      height: 720,
    })),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/usr/bin/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('screenshot-tools: getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('includes capture_screenshot tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('capture_screenshot');
  });

  it('includes analyze_screenshot tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('analyze_screenshot');
  });

  it('tools have inputSchema with properties', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema.properties).toBeDefined();
    }
  });
});

describe('screenshot-tools: TOOL_META', () => {
  it('has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThan(0);
  });

  it('capture_screenshot is not readonly and is long_running', () => {
    expect(TOOL_META.capture_screenshot).toBeDefined();
    expect(TOOL_META.capture_screenshot.readonly).toBe(false);
    expect(TOOL_META.capture_screenshot.long_running).toBe(true);
  });

  it('analyze_screenshot is readonly and not long_running', () => {
    expect(TOOL_META.analyze_screenshot).toBeDefined();
    expect(TOOL_META.analyze_screenshot.readonly).toBe(true);
    expect(TOOL_META.analyze_screenshot.long_running).toBe(false);
  });
});

describe('screenshot-tools: handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_screenshot_tool', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns null for empty tool name', async () => {
    const result = await handleTool('', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('handleTool for capture_screenshot returns text result on success', async () => {
    const ctx = makeCtx();
    const result = await handleTool('capture_screenshot', {
      project_path: '/tmp/test-project',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    // Should contain text content about the screenshot
    const textContent = result.content.find(c => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('Screenshot saved');
  });

  it('handleTool for analyze_screenshot without image returns error text', async () => {
    const ctx = makeCtx();
    const result = await handleTool('analyze_screenshot', {}, ctx);

    expect(result).not.toBeNull();
    expect(result.content).toBeDefined();
    const textContent = result.content.find(c => c.type === 'text');
    expect(textContent).toBeDefined();
    // Without any path it should return an error message
    expect(textContent.text).toMatch(/error|Error|required|not found/i);
  });
});
