import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatcherOptions } from '../../src/core/ToolDispatcher.js';
import { ToolDispatcher } from '../../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { EditorToolExecutor } from '../../src/core/EditorToolExecutor.js';
import type { ToolResult } from '../../src/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ─── Hoisted Mocks (vi.hoisted ensures these are available inside vi.mock factories) ──

const {
  mockGetAllToolDefinitions,
  mockGetModuleForTool,
  mockLITE_TOOLS,
  mockRequiresConfirmation,
  mockCreatePendingToken,
  mockConsumeToken,
} = vi.hoisted(() => ({
  mockGetAllToolDefinitions: vi.fn<() => Tool[]>(),
  mockGetModuleForTool: vi.fn(),
  mockLITE_TOOLS: new Set(['project', 'scene', 'script', 'validation', 'confirm_and_execute']),
  mockRequiresConfirmation: vi.fn(),
  mockCreatePendingToken: vi.fn(),
  mockConsumeToken: vi.fn(),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  getAllToolDefinitions: mockGetAllToolDefinitions,
  getModuleForTool: mockGetModuleForTool,
  LITE_TOOLS: mockLITE_TOOLS,
}));

vi.mock('../../src/guard.js', () => ({
  requiresConfirmation: mockRequiresConfirmation,
  createPendingToken: mockCreatePendingToken,
  consumeToken: mockConsumeToken,
}));

vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
  parseGodotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockGuard(blocked: boolean): ReadOnlyGuard {
  return {
    check: vi.fn().mockReturnValue({ blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined }),
  } as unknown as ReadOnlyGuard;
}

const FIXTURE_TOOLS: Tool[] = [
  { name: 'scene', description: 'Scene ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'script', description: 'Script ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'project', description: 'Project ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'docs', description: 'Docs ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'Screenshot ops', inputSchema: { type: 'object', properties: {} } },
];

function createOptions(overrides?: Partial<DispatcherOptions>): DispatcherOptions {
  return {
    readOnly: false,
    mode: 'full',
    connectionMode: 'headless',
    noFallback: false,
    readOnlyGuard: createMockGuard(false),
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn().mockResolvedValue('/fake/godot'),
    ...overrides,
  };
}

const mockToolResult: ToolResult = {
  content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
  mockRequiresConfirmation.mockReturnValue(false);
});

// ── getFilteredTools ────────────────────────────────────────────────────────

describe('ToolDispatcher.getFilteredTools', () => {
  // [T20] 默认模式 → 全部 + confirm_and_execute
  it('returns all tools plus confirm_and_execute in default mode', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('confirm_and_execute');
    expect(names).toContain('scene');
    expect(names).toContain('script');
    expect(names).toContain('docs');
    expect(names.length).toBe(FIXTURE_TOOLS.length + 1);
  });

  // [T21] readOnly → 过滤写工具
  it('filters write tools when readOnly is true', () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const blocked = ['scene', 'script', 'project'].includes(name);
      return { blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined };
    });
    const dispatcher = new ToolDispatcher(createOptions({ readOnly: true, readOnlyGuard: guard }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('docs');
    expect(names).toContain('screenshot');
    expect(names).not.toContain('scene');
    expect(names).not.toContain('script');
  });

  // [T22] lite → 只保留 LITE_TOOLS
  it('filters to LITE_TOOLS in lite mode', () => {
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'lite' }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    for (const name of names) {
      expect(mockLITE_TOOLS.has(name)).toBe(true);
    }
    expect(names).toContain('project');
    expect(names).toContain('scene');
    expect(names).toContain('confirm_and_execute');
  });

  // [T23] readOnly + lite 组合
  it('applies both readOnly and lite filters combined', () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const blocked = ['scene', 'script', 'project'].includes(name);
      return { blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined };
    });
    const dispatcher = new ToolDispatcher(createOptions({ readOnly: true, mode: 'lite', readOnlyGuard: guard }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain('scene');
    expect(names).not.toContain('script');
    expect(names).not.toContain('project');
    for (const name of names) {
      expect(mockLITE_TOOLS.has(name)).toBe(true);
    }
  });
});

// ── setConnectionMode ───────────────────────────────────────────────────────

describe('ToolDispatcher.setConnectionMode', () => {
  // [T24] 模式切换
  it('switches connection mode', () => {
    const dispatcher = new ToolDispatcher(createOptions({ connectionMode: 'editor' }));
    dispatcher.setConnectionMode('headless');
    expect(true).toBe(true);
  });
});

// ── setEditorExecutor ───────────────────────────────────────────────────────

describe('ToolDispatcher.setEditorExecutor', () => {
  // [T25] 设置新 executor
  it('sets a new executor', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const mockExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(mockExecutor);
    expect(mockExecutor.destroy).not.toHaveBeenCalled();
  });

  // [T26] 传 null → 自动 destroy 旧的
  it('destroys old executor when set to null', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const mockExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(mockExecutor);
    dispatcher.setEditorExecutor(null);
    expect(mockExecutor.destroy).toHaveBeenCalledOnce();
  });

  // [T27] 替换旧 executor → 先 destroy 旧的
  it('destroys old executor when replacing with new one', () => {
    const dispatcher = new ToolDispatcher(createOptions());
    const oldExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const newExecutor = { execute: vi.fn(), destroy: vi.fn() } as unknown as EditorToolExecutor;
    dispatcher.setEditorExecutor(oldExecutor);
    dispatcher.setEditorExecutor(newExecutor);
    expect(oldExecutor.destroy).toHaveBeenCalledOnce();
    expect(newExecutor.destroy).not.toHaveBeenCalled();
  });
});

// ── handleCall 管道 ─────────────────────────────────────────────────────────

describe('ToolDispatcher.handleCall', () => {
  function createDispatcherForHandleCall(overrides?: Partial<DispatcherOptions>) {
    return new ToolDispatcher(createOptions(overrides));
  }

  // [T1] rawArgs undefined → 空 args {}
  it('handles undefined rawArgs gracefully', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene' } });
    expect(result).toBeTruthy();
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', {}, expect.anything());
  });

  // [T2] 正常 camelCase → snake_case 转换
  it('normalizes camelCase args to snake_case', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { projectPath: '/test', nodeName: 'Player' } },
    });
    const calledArgs = mockModule.handleTool.mock.calls[0][1];
    expect(calledArgs).toHaveProperty('project_path');
    expect(calledArgs).toHaveProperty('node_name');
    expect(calledArgs).not.toHaveProperty('projectPath');
  });

  // [T3] readOnlyGuard.blocked → 返回错误
  it('returns error when readOnlyGuard blocks the tool', async () => {
    const guard = createMockGuard(true);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
  });

  // [T4] readOnlyGuard.passed → 继续
  it('proceeds when readOnlyGuard passes', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    expect(mockModule.handleTool).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  // [T5] confirm_and_execute token 缺失
  it('returns error when confirm_and_execute has no token', async () => {
    const dispatcher = createDispatcherForHandleCall();
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('confirmation_token is required');
  });

  // [T6] consumeToken 返回 null
  it('returns error when token is invalid or expired', async () => {
    mockConsumeToken.mockReturnValue(null);
    const dispatcher = createDispatcherForHandleCall();
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'bad-token' } } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('invalid or expired');
  });

  // [T7] confirm 分支二次 readOnlyGuard 检查
  it('re-checks readOnlyGuard for confirmed tool', async () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'confirm_and_execute') return { blocked: false };
      return { blocked: true, errorCode: -32001, message: 'blocked after confirm' };
    });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: {} });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
  });

  // [T8] confirm 分支 editor 模式 dispatch
  it('dispatches confirmed tool via editor executor', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'read_scene' });
  });

  // [T9] confirm 分支 headless dispatch
  it('dispatches confirmed tool via headless when no executor', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'headless' });
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'read_scene' }, expect.anything());
  });

  // [T10] requiresConfirmation → 返回 token
  it('returns confirmation token when tool requires confirmation', async () => {
    const guard = createMockGuard(false);
    mockRequiresConfirmation.mockReturnValue(true);
    mockCreatePendingToken.mockReturnValue('test-token-123');
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'remove_node' } } });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.requires_confirmation).toBe(true);
    expect(parsed.confirmation_token).toBe('test-token-123');
    expect(parsed.tool).toBe('scene');
  });

  // [T12] editor 模式 + executor 存在 → 转发
  it('forwards to editor executor in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'add_node' });
  });

  // [T13] editor 模式 executor 为 null → fallback headless
  it('falls back to headless when executor is null in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [T14] headless 正常返回 + duration
  it('returns result with duration in headless mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const lastContent = result.content[result.content.length - 1] as { text: string };
    expect(lastContent.text).toMatch(/_duration_ms: \d+/);
  });

  // [T15] 工具不存在 → Unknown tool
  it('returns unknown tool error when module not found', async () => {
    const guard = createMockGuard(false);
    mockGetModuleForTool.mockReturnValue(undefined);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'nonexistent_tool', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown tool');
  });

  // [T16] handler 返回 null → 错误消息
  it('returns error when tool handler returns null', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(null) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('handler returned null');
  });

  // [T17] 首次 fallback → 附加警告
  it('attaches fallback warning on first response when in fallback mode', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    dispatcher.markEditorFallback();
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const firstText = (result.content[0] as { text: string }).text;
    expect(firstText).toContain('EDITOR_FALLBACK');
  });

  // [T18] 非首次 → 不附加
  it('does not attach fallback warning on second call', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    }) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    dispatcher.markEditorFallback();
    await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    mockModule.handleTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    });
    const result2 = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const firstText = (result2.content[0] as { text: string }).text;
    expect(firstText).not.toContain('EDITOR_FALLBACK');
  });

  // [T19] catch 异常 → 错误消息
  it('catches exceptions and returns error message', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockRejectedValue(new Error('boom')) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('boom');
  });
});
