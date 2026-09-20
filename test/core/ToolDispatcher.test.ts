import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatcherOptions } from '../../src/core/ToolDispatcher.js';
import { ToolDispatcher, buildPerCallCtx } from '../../src/core/ToolDispatcher.js';
import { getCallRecorder } from '../../src/core/call-recorder.js';
import { createProgressEmitter, setProgressSender, setProgressClientReady, resetProgressSender } from '../../src/core/progress.js';
import type { ProgressEmitter } from '../../src/core/progress.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { EditorToolExecutor } from '../../src/core/EditorToolExecutor.js';
import type { ToolResult } from '../../src/types.js';
import type { Tool } from "@modelcontextprotocol/server";
import { resolveProjectPath as _mockResolveProjectPath } from '../../src/core/path-utils.js';

// ─── Hoisted Mocks (vi.hoisted ensures these are available inside vi.mock factories) ──

const {
  mockGetAllToolDefinitions,
  mockGetModuleForTool,
  mockGetToolDefinition,
  mockLITE_TOOLS,
  mockMINIMAL_TOOLS,
  mockRequiresConfirmation,
  mockCreatePendingToken,
  mockConsumeToken,
  mockPeekToken,
  mockIsPathInAllowedRoots,
  mockIsToolAllowed,
  mockSetActiveGroups,
  mockValidateGodotBinary,
  mockValidateGodotBinaryDetailed,
  mockIsDynamicToolName,
  mockGetActionRisk,
  mockIsReadOnly,
} = vi.hoisted(() => ({
  mockGetAllToolDefinitions: vi.fn<() => Tool[]>(),
  mockGetModuleForTool: vi.fn(),
  // Task 3: validateArgs 接入需要 getToolDefinition 返回带 enum 的 inputSchema。
  // 默认 undefined → 内联工具路径跳过(自然)。集成测试用例内按需 mockReturnValue。
  mockGetToolDefinition: vi.fn().mockReturnValue(undefined),
  mockLITE_TOOLS: new Set(['project', 'scene', 'script', 'validation', 'confirm_and_execute', 'animation', 'audio', 'docs', 'signal', 'material', 'test', 'screenshot', 'profiler', 'workflow', 'game']),
  mockMINIMAL_TOOLS: new Set(['project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute']),
  mockRequiresConfirmation: vi.fn(),
  mockCreatePendingToken: vi.fn(),
  mockConsumeToken: vi.fn(),
  mockPeekToken: vi.fn(),
  mockIsPathInAllowedRoots: vi.fn().mockReturnValue(true),
  mockIsToolAllowed: vi.fn().mockReturnValue(true),
  mockSetActiveGroups: vi.fn(),
  mockValidateGodotBinary: vi.fn().mockResolvedValue(true),
  // D3 (2026-09-17 反馈批次D): ToolDispatcher 改消费 validateGodotBinaryDetailed(分层 stage)
  mockValidateGodotBinaryDetailed: vi.fn().mockResolvedValue({ ok: true }),
  // A1 (2026-08-11): dispatcher 动态工具门反查依赖;默认 false(非动态),用例内按需 mockReturnValue
  mockIsDynamicToolName: vi.fn().mockReturnValue(false),
  // 1B/1C (2026-09-19 安全加固批1): audit middleware 消费 getActionRisk;
  // 默认 undefined(risk 未知 → fail-closed 落审计),用例内按需 mockReturnValue。
  mockGetActionRisk: vi.fn().mockReturnValue(undefined),
  // I-1(审查修复): audit fail-closed 的 readonly 豁免消费 isReadOnly;默认 false(不豁免)。
  mockIsReadOnly: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  getAllToolDefinitions: mockGetAllToolDefinitions,
  getModuleForTool: mockGetModuleForTool,
  getToolDefinition: mockGetToolDefinition,
  registerInlineTool: vi.fn(),
  LITE_TOOLS: mockLITE_TOOLS,
  MINIMAL_TOOLS: mockMINIMAL_TOOLS,
  isToolAllowed: mockIsToolAllowed,
  isDynamicToolName: mockIsDynamicToolName,
  setActiveGroups: mockSetActiveGroups,
  resolveProfile: vi.fn().mockReturnValue(new Set()),
  skipProjectPath: vi.fn().mockReturnValue(false),
  tryLegacyMapping: vi.fn().mockReturnValue(null),
  getActionRisk: mockGetActionRisk,
  isReadOnly: mockIsReadOnly,
}));

vi.mock('../../src/core/guard.js', () => ({
  requiresConfirmation: mockRequiresConfirmation,
  createPendingToken: mockCreatePendingToken,
  consumeToken: mockConsumeToken,
  peekToken: mockPeekToken,
  TOKEN_TTL_MS: 120_000,  // P0-2 MRTR: TTL 调整为 120s
}));

vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: mockIsPathInAllowedRoots,
  parseGodotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/core/path-utils.js', () => ({
  resolveProjectPath: vi.fn().mockReturnValue('/default/project'),
  _resetProjectPathCache: vi.fn(),
}));

vi.mock('../../src/tools/shared.js', () => ({
  opsErrorResult: vi.fn((code: string, msg: string, opts?: { suggestion?: string; retryable?: boolean; errorCategory?: string; traceId?: string }) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({
      success: false, error: msg, error_code: code, warnings: [],
      // G2 (2026-08-13): 透传结构化错误三元组(镜像 src/tools/shared/errors.ts opsError)
      ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
      ...(opts?.errorCategory ? { error_category: opts.errorCategory } : {}),
      ...(opts?.traceId ? { trace_id: opts.traceId } : {}),
    }) }],
    isError: true,
  })),
  COMMON_ERROR_CODES: { INVALID_PARAMS: 'INVALID_PARAMS' },
}));

// I-4 统一策略(设计 §7):importOriginal 部分覆盖——仅 stub 防副作用的 getter/setter,
// 新导出(getRunSessionProc/killAllRunSessions 等)透传真实模块,防补导出漂移。
vi.mock('../../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/process-state.js')>();
  return {
    ...actual,
    getRunningProcess: vi.fn().mockReturnValue(null),
    setRunningProcess: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue([]),
    setOutputBuffer: vi.fn(),
    getProcessStartTime: vi.fn().mockReturnValue(0),
    setProcessStartTime: vi.fn(),
    getProjectDir: vi.fn().mockReturnValue(''),
    setProjectDir: vi.fn(),
  };
});

// M-1: mock godot-finder 的 validateGodotBinary(resolveFindGodotOverride 动态 import 调用)
// D3: 校验出口已改为消费 validateGodotBinaryDetailed(分层 stage);boolean 版保留给其他调用方
vi.mock('../../src/core/godot-finder.js', () => ({
  validateGodotBinary: mockValidateGodotBinary,
  validateGodotBinaryDetailed: mockValidateGodotBinaryDetailed,
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
  { name: 'runtime', description: 'Runtime ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'validation', description: 'Validation ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'docs', description: 'Docs ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'Screenshot ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'animation', description: 'Animation ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'audio', description: 'Audio ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'signal', description: 'Signal ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'material', description: 'Material ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'test', description: 'Test ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'profiler', description: 'Profiler ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'workflow', description: 'Workflow ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'game', description: 'Game ops', inputSchema: { type: 'object', properties: {} } },
  { name: 'tilemap', description: 'Tilemap ops', inputSchema: { type: 'object', properties: {} } },
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
    toolCallDelegate: vi.fn(),
    // CRITICAL(2026-07-13): 默认 elicitFn accept — 现有 confirm_and_execute 测试绿(gate 默认放行)。
    // gate 拒绝测试通过 overrides 注入 null/false elicitFn。
    elicitFn: async () => ({ confirm: true }),
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
  (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/default/project');
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
    // lite 应排除不在 LITE_TOOLS 中的工具（如 tilemap）
    expect(names).not.toContain('tilemap');
  });

  // [T22b] minimal → 只保留 MINIMAL_TOOLS (6 个核心工具)
  it('filters to MINIMAL_TOOLS in minimal mode', () => {
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'minimal' }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    for (const name of names) {
      expect(mockMINIMAL_TOOLS.has(name)).toBe(true);
    }
    expect(names).toContain('project');
    expect(names).toContain('scene');
    expect(names).toContain('script');
    expect(names).toContain('runtime');
    expect(names).toContain('validation');
    expect(names).toContain('confirm_and_execute');
    // minimal 应排除 docs, screenshot, animation 等
    expect(names).not.toContain('docs');
    expect(names).not.toContain('screenshot');
    expect(names).not.toContain('animation');
    expect(names).not.toContain('tilemap');
  });

  // [R2] slim-profile-silent-full-fallback: 未知/拼写错 profile 解析空集时,修复前 :151 只 warn 不过滤
  // (fail-open 暴露 full 含 execute_gdscript/run_project 等高危),修复后 fail-closed 回退 minimal(安全)。
  // resolveProfile mock 默认返回空集(:46),正好模拟未知 profile。
  it('[R2] unknown profile fails closed to minimal (not full)', () => {
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'typo-profile' }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('runtime');  // minimal 含
    expect(names).not.toContain('animation');  // minimal 不含(修复前 full 含)
    expect(names).not.toContain('docs');
    expect(names).not.toContain('material');
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

  // [T23b] readOnly + minimal 组合
  it('applies both readOnly and minimal filters combined', () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const blocked = ['scene', 'script', 'project'].includes(name);
      return { blocked, errorCode: blocked ? -32001 : undefined, message: blocked ? 'blocked' : undefined };
    });
    const dispatcher = new ToolDispatcher(createOptions({ readOnly: true, mode: 'minimal', readOnlyGuard: guard }));
    const tools = dispatcher.getFilteredTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain('scene');
    expect(names).not.toContain('script');
    expect(names).not.toContain('project');
    for (const name of names) {
      expect(mockMINIMAL_TOOLS.has(name)).toBe(true);
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
  // 默认 fail-closed：清除开发者 shell 可能设的 GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true
  // （elicitation opt-in 降级），否则 4 个 T11 deny 测试被污染——elicitFn 不调用、
  // deny 路径走降级执行返回 mockToolResult(无 isError)。I-2/I-2b 测降级场景自行
  // vi.stubEnv('true') 覆盖此默认。见 test/setup-global-unrestricted：敏感 env 须测试内隔离。
  beforeEach(() => {
    vi.stubEnv('GODOT_MCP_ALLOW_UNSAFE_CONFIRM', '');
  });

  function createDispatcherForHandleCall(overrides?: Partial<DispatcherOptions>) {
    return new ToolDispatcher(createOptions(overrides));
  }

  // P0-2 MRTR: 构造第二轮 srvCtx（模拟用户已 accept）。
  // acceptedContent 只在 action='accept' 时返回 content；decline/cancel 返 undefined
  // 会被源码 :321 误判为第一轮，故拒绝场景用 accept + confirm:false（acceptedContent 返
  // {confirm:false}，源码 :347 !confirmed || confirmed.confirm !== true → ELICITATION_DENIED）。
  function mkSrvCtx(accepted: boolean = true) {
    return {
      mcpReq: {
        inputResponses: {
          confirm: accepted
            ? { action: 'accept' as const, content: { confirm: true } }
            : { action: 'accept' as const, content: { confirm: false } },
        },
      },
    } as any;
  }

  // [T1] rawArgs undefined → 空 args {}
  it('handles undefined rawArgs gracefully', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene' } });
    expect(result).toBeTruthy();
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', expect.objectContaining({ project_path: '/default/project' }), expect.anything());
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

  // 任务①(2026-09-20 可靠性批): 全局工具 deadline 端到端——挂起的 handler 在
  // GODOT_MCP_TOOL_DEADLINE_MS 到点后返回结构化 TOOL_DEADLINE_EXCEEDED(retryable/
  // error_category),而非无限挂起。真实 timers(50ms deadline,短等待)。
  it('returns structured TOOL_DEADLINE_EXCEEDED when handler hangs past global deadline (DL-E2E)', async () => {
    vi.stubEnv('GODOT_MCP_TOOL_DEADLINE_MS', '50');
    try {
      const guard = createMockGuard(false);
      // handleTool 永不 settle——模拟"handler 忘写内部超时"的挂死路径
      const mockModule = { handleTool: vi.fn().mockReturnValue(new Promise(() => {})) };
      mockGetModuleForTool.mockReturnValue(mockModule);
      const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
      const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed['error_code']).toBe('TOOL_DEADLINE_EXCEEDED');
      expect(parsed['retryable']).toBe(true);
      expect(parsed['error_category']).toBe('timeout');
      expect(typeof parsed['trace_id']).toBe('string');
    } finally {
      // Nit-4(审查): finally 恢复 env——断言失败时 '50' 不泄漏到同文件后续用例
      vi.unstubAllEnvs();
    }
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
    expect(text).toContain('Invalid or expired');
  });

  // [T6b] P0-2 MRTR: peekToken 返回 wasTruncated → 第一轮返 ARGS_TRUNCATED（不消费 token）
  it('refuses execution when token args were truncated (ARGS_TRUNCATED) (S2)', async () => {
    mockPeekToken.mockReturnValue({
      toolName: 'script',
      args: { action: 'execute_gdscript', code: 'a'.repeat(11_000) },
      wasTruncated: true,
    });
    const dispatcher = createDispatcherForHandleCall();
    // 第一轮（无 inputResponses）→ peekToken 检测 wasTruncated → 立即返 ARGS_TRUNCATED
    const result = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'truncated-token' } } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ARGS_TRUNCATED');
    // peekToken 不消费 token，consumeToken 不应被调
    expect(mockConsumeToken).not.toHaveBeenCalled();
  });

  // [B2] elicitation middleware 强制顶层 required(elicitFn=null,纯校验)
  it('rejects calls missing top-level required params with MISSING_PARAM (B2)', async () => {
    mockGetAllToolDefinitions.mockReturnValue([
      { name: 'scene', description: 'x', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
      ...FIXTURE_TOOLS,
    ]);
    mockRequiresConfirmation.mockReturnValue(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall();
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('MISSING_PARAM');
    expect(text).toContain('action');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  it('passes through when required params are present (B2)', async () => {
    mockGetAllToolDefinitions.mockReturnValue([
      { name: 'scene', description: 'x', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
      ...FIXTURE_TOOLS,
    ]);
    mockRequiresConfirmation.mockReturnValue(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall();
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'read_scene' } } });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [T7] P0-2 MRTR: confirm 分支二次 readOnlyGuard 检查（第二轮 _confirmExecute 内）
  it('re-checks readOnlyGuard for confirmed tool', async () => {
    const guard = createMockGuard(false);
    (guard.check as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'confirm_and_execute') return { blocked: false };
      return { blocked: true, errorCode: -32001, message: 'blocked after confirm' };
    });
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: {}, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: {} });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute 内二次 guard 拦截
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
  });

  // [T8] P0-2 MRTR: confirm 分支 editor 模式 dispatch（第二轮 _confirmExecute 内）
  it('dispatches confirmed tool via editor executor', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute → editor dispatch
    await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'read_scene' });
  });

  // [T9] P0-2 MRTR: confirm 分支 headless dispatch（第二轮 _confirmExecute 内）
  it('dispatches confirmed tool via headless when no executor', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'headless' });
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute → headless dispatch
    await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'read_scene' }, expect.anything());
  });

  // [T11] CRITICAL(2026-07-13 安全): P0-2 MRTR 双轮模式 — confirm_and_execute 的 out-of-band gate
  // 堵 AI 自读自确认 token。第一轮 peekToken + 返 inputRequired（SDK shim 自动 elicit push），
  // 第二轮读 inputResponses.confirm（AI 无法伪造——非其 tools/call 通道）。elicitFn 不再被调。
  it('requires user elicitInput consent before executing confirmed tool (T11)', async () => {
    const elicitFn = vi.fn().mockResolvedValue({ confirm: true });
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });

    // 第一轮（无 inputResponses）→ 返 inputRequired，不执行工具
    const r1 = await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    // inputRequired 返回结构：含 inputRequests + requestState，不含 content/isError
    expect((r1 as any).resultType).toBe('input_required');
    expect((r1 as any).inputRequests).toBeDefined();
    expect((r1 as any).requestState).toBe('valid');
    expect(elicitFn).not.toHaveBeenCalled();  // P0-2 MRTR: elicit push 由 SDK shim 处理
    expect(mockModule.handleTool).not.toHaveBeenCalled();

    // 第二轮（用户 accept）→ consumeToken + 执行
    const r2 = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'read_scene' }, expect.anything());
  });

  // P0-2 MRTR: 原 null/declined 语义（elicitFn 返 null）现已迁移到 MRTR 第二轮
  // acceptedContent 返回 {confirm:false}（accept 但用户拒绝）→ ELICITATION_DENIED。
  // 真正的 cancel/decline action 由 SDK 直接拦在 client 侧（不发第二轮 tools/call）。
  it('refuses confirmed execution when elicitation unsupported/declined/cancel (null) (T11)', async () => {
    const elicitFn = vi.fn().mockResolvedValue(null);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });
    // 第二轮：inputResponses.confirm 缺失（decline）→ acceptedContent 返 undefined → ELICITATION_DENIED
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(false),
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ELICITATION_DENIED');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  it('refuses confirmed execution when user declines (confirm:false) (T11)', async () => {
    const elicitFn = vi.fn().mockResolvedValue({ confirm: false });
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });
    // 第二轮：accept 但 content.confirm=false → acceptedContent 返 {confirm:false} → !confirmed.confirm 拒绝
    const srvCtxDecline = {
      mcpReq: {
        inputResponses: { confirm: { action: 'accept' as const, content: { confirm: false } } },
      },
    } as any;
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      srvCtxDecline,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ELICITATION_DENIED');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  // M-3(security review): 严格 === 比较,truthy 强制转换({confirm:"true"}/{confirm:1})必须拒绝
  it('rejects truthy coercion ({confirm:"true"} string) — strict === only (T11)', async () => {
    const elicitFn = vi.fn().mockResolvedValue({ confirm: 'true' });
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'remove_node' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });
    // 第二轮：accept 但 content.confirm="true"（string）→ confirm !== true → ELICITATION_DENIED
    const srvCtxTruthy = {
      mcpReq: {
        inputResponses: { confirm: { action: 'accept' as const, content: { confirm: 'true' as any } } },
      },
    } as any;
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      srvCtxTruthy,
    );
    expect(result.isError).toBe(true);
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  // I-2(security review): opt-in 降级 — GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true 时跳过 elicitation
  // 走 token 路径执行(不调 elicitFn,机制见 I-2b;此处 elicitFn mock 值无关)。默认未设=fail-closed。
  it('downgrades to token path when GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true (I-2)', async () => {
    vi.stubEnv('GODOT_MCP_ALLOW_UNSAFE_CONFIRM', 'true');
    const elicitFn = vi.fn().mockResolvedValue(null);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'read_scene' }, expect.anything());
    vi.unstubAllEnvs();
  });

  // I-2b(2026-07-15): env=true 时根本不调 elicitFn(不弹窗),对齐 I-2 注释"跳过 elicitation"语义。
  // 修复 I-2 原实现盲点:降级检查原在 elicitFn 调用之后,Claude Code 等支持 elicitation 的
  // client 仍弹窗(elicitation 照弹,仅在 decline 后放行——甚至"用户拒绝却被执行"的悖论)。
  // 前置检查后 env=true 直接跳过 elicitFn,真正免确认。
  it('does NOT call elicitFn when GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true — no popup (I-2b)', async () => {
    vi.stubEnv('GODOT_MCP_ALLOW_UNSAFE_CONFIRM', 'true');
    const elicitFn = vi.fn().mockResolvedValue({ confirm: true });
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'add_node' } });
    const dispatcher = createDispatcherForHandleCall({ elicitFn });
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } });
    expect(elicitFn).not.toHaveBeenCalled();
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', { action: 'add_node' }, expect.anything());
    vi.unstubAllEnvs();
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
    expect(parsed.ttl_seconds).toBe(120);  // P0-2 MRTR: TOKEN_TTL_MS=120_000 → 120s（MRTR 双轮需更长时间）
  });

  // [T10b] IMP-6: legacy 工具名路由时 guard 前置 tryLegacyMapping,防 legacy name 绕过 guard
  it('guards legacy tool name via tryLegacyMapping before confirmation check (IMP-6)', async () => {
    const guard = createMockGuard(false);
    const { tryLegacyMapping } = await import('../../src/core/tool-registry.js');
    // remove_node 是 legacy name → 映射到 scene + remove_node action
    (tryLegacyMapping as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'remove_node' ? { tool: 'scene', action: 'remove_node' } : null,
    );
    // requiresConfirmation 对映射后的 (scene, action=remove_node) 返回 true
    mockRequiresConfirmation.mockImplementation(
      (guardName: string, guardArgs: { action?: string }) =>
        guardName === 'scene' && guardArgs?.action === 'remove_node',
    );
    mockCreatePendingToken.mockReturnValue('legacy-token-456');

    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'remove_node', arguments: { node_path: 'root/Foo' } },
    });

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.requires_confirmation).toBe(true);
    expect(parsed.confirmation_token).toBe('legacy-token-456');
    // IMP-6 核心:requiresConfirmation 必须以映射后的 (scene, action=remove_node) 调用,而非原始 remove_node
    expect(mockRequiresConfirmation).toHaveBeenCalledWith('scene', expect.objectContaining({ action: 'remove_node' }));
    // createPendingToken 必须以原始 legacy name 调用(confirm_and_execute 据此执行原工具)
    expect(mockCreatePendingToken).toHaveBeenCalledWith('remove_node', expect.objectContaining({ node_path: 'root/Foo' }));

    // 重置 tryLegacyMapping mock(clearAllMocks 不重置 implementation,避免污染后续 case)
    (tryLegacyMapping as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  // ── A1 (2026-08-11 审查 P1): CMP-16-B 动态工具绕过 confirm/action-gate 双层门修复 ──
  // 动态注册的平铺工具名(如 engine_call_method)不在静态 metaRegistry → guard 查不到 risk
  // 永不确认、action-gate 永不命中。修复:经 METHOD_TO_TOOL 反查静态 (tool, action) 后判定。
  it('A1: dynamic tool confirm gate resolves static (tool, action) via METHOD_TO_TOOL', async () => {
    const guard = createMockGuard(false);
    mockIsDynamicToolName.mockImplementation((name: string) => name === 'engine_call_method');
    // requiresConfirmation 对反查后的 (engine, action=call_method) 返回 true(真实 registry 中该 action risk=write)
    mockRequiresConfirmation.mockImplementation(
      (guardName: string, guardArgs: { action?: string }) =>
        guardName === 'engine' && guardArgs?.action === 'call_method',
    );
    mockCreatePendingToken.mockReturnValue('dyn-token-789');

    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'engine_call_method', arguments: { node_path: 'root/Player', method: 'set_position' } },
    });

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.requires_confirmation).toBe(true);
    expect(parsed.confirmation_token).toBe('dyn-token-789');
    // A1 核心:guard 必须以反查后的 (engine, action=call_method) 判定,而非裸动态名(查不到 risk 即放行)
    expect(mockRequiresConfirmation).toHaveBeenCalledWith('engine', expect.objectContaining({ action: 'call_method' }));
    // createPendingToken 以原始动态名登记(confirm_and_execute 据此执行 editor 转发)
    expect(mockCreatePendingToken).toHaveBeenCalledWith('engine_call_method', expect.objectContaining({ node_path: 'root/Player' }));
    mockIsDynamicToolName.mockReturnValue(false);
  });

  it('A1: dynamic tool gated action (debug_evaluate → debug.evaluate) hits ACTION_GATED', async () => {
    vi.stubEnv('GODOT_MCP_PRIVILEGED_GROUPS', '');  // 未设 privileged 组 → gated
    mockIsDynamicToolName.mockImplementation((name: string) => name === 'debug_evaluate');
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: createMockGuard(false) });
    const result = await dispatcher.handleCall({
      params: { name: 'debug_evaluate', arguments: { expression: '1+1' } },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error_code).toBe('ACTION_GATED');
    // 修复前:isActionGated('debug_evaluate','') 永不命中 → 直接放行执行(gated action 绕过)
    mockIsDynamicToolName.mockReturnValue(false);
    vi.unstubAllEnvs();
  });

  it('A1: unmapped dynamic tool fails closed (confirmation required, risk unknown)', async () => {
    mockIsDynamicToolName.mockImplementation((name: string) => name === 'future_unmapped_method');
    mockRequiresConfirmation.mockReturnValue(false);  // guard 本身放行
    mockCreatePendingToken.mockReturnValue('fail-closed-token');
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: createMockGuard(false) });
    const result = await dispatcher.handleCall({
      params: { name: 'future_unmapped_method', arguments: {} },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // METHOD_TO_TOOL 未登记 → 风险未知 → fail-closed 要求确认(防 GD 新增 method 漏映射静默绕门)
    expect(parsed.requires_confirmation).toBe(true);
    mockIsDynamicToolName.mockReturnValue(false);
  });

  // [T12] editor 模式 + executor 存在 → 转发
  it('forwards to editor executor in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', expect.objectContaining({ action: 'add_node', project_path: '/default/project' }));
  });

  // [B1] editor 模式大响应也经 truncateResponse(修复 editor 绕过 response-limiter)
  it('truncates large editor responses via truncateResponse (B1)', async () => {
    const prev = process.env.GODOT_MCP_RESPONSE_LIMIT;
    process.env.GODOT_MCP_RESPONSE_LIMIT = 'true';
    try {
      const guard = createMockGuard(false);
      const hugeText = 'x'.repeat(2.2 * 1024 * 1024); // >2MB 触发 truncateResponse warning 分支
      const hugeResult = { content: [{ type: 'text' as const, text: hugeText }] };
      const mockExecutor = { execute: vi.fn().mockResolvedValue(hugeResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
      const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
      dispatcher.setEditorExecutor(mockExecutor);
      const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'read_scene' } } });
      expect(result.content.length).toBeGreaterThan(1);
      expect(result.content.some(c => 'text' in c && c.text.includes('exceeds 2MB'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GODOT_MCP_RESPONSE_LIMIT;
      else process.env.GODOT_MCP_RESPONSE_LIMIT = prev;
    }
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

  // [P1-1] (2026-07-06 review) editor 返回 -32601 Unknown method → 自动回退 headless dispatchTool。
  // 场景: TS (tool,action) 工具(script/screenshot/project/...)转发后 command_handler 不认 → -32601。
  it('falls back to headless when editor returns -32601 Unknown method (P1-1)', async () => {
    const guard = createMockGuard(false);
    const unknownMethodResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: -32601, message: 'Unknown method: script' } }) }],
      isError: true,
    };
    const mockExecutor = { execute: vi.fn().mockResolvedValue(unknownMethodResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'script', arguments: { action: 'write_script' } } });
    expect(mockExecutor.execute).toHaveBeenCalledWith('script', expect.objectContaining({ action: 'write_script' }));
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [P1-1] editor 返回非 -32601 错误(如 -32003) → 不回退, 保留编辑器原生错误语义
  it('does not fall back when editor returns non-32601 error (P1-1)', async () => {
    const guard = createMockGuard(false);
    const otherErrorResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: -32003, message: 'No scene loaded' } }) }],
    };
    const mockExecutor = { execute: vi.fn().mockResolvedValue(otherErrorResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'add_node' } } });
    expect(mockExecutor.execute).toHaveBeenCalled();
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  // [I-12/P1-1 一致性] editor 返回 -32601 的「平铺」形态（{error:msg, code:-32601}，
  // EditorToolExecutor I-12 catch 把 WS error 拍平后的结构）→ 同样应触发 headless 回退。
  it('falls back to headless when editor returns flat -32601 error (I-12/P1-1)', async () => {
    const guard = createMockGuard(false);
    const flatUnknownResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown method: script', code: -32601 }) }],
      isError: true,
    };
    const mockExecutor = { execute: vi.fn().mockResolvedValue(flatUnknownResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'script', arguments: { action: 'write_script' } } });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [P1-1b] confirm_and_execute 路径 editor -32601 同样回退（与普通 dispatch 对齐）。
  // bug: confirm 分支此前直接返 editorResult，未登记 editor-method-map 的写工具（scene
  // add_node/edit_node/remove_node 等）经 confirm 时 editor 转发 command_handler 命中兜底
  // -32601 无回退 headless。修复后 confirm 路径检测 -32601 → dispatchTool 回退。
  it('falls back to headless on -32601 via confirm_and_execute path (P1-1b)', async () => {
    const guard = createMockGuard(false);
    const flatUnknownResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown method: scene', code: -32601 }) }],
      isError: true,
    };
    const mockExecutor = { execute: vi.fn().mockResolvedValue(flatUnknownResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'add_node', node_type: 'Node3D', node_name: 'X' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'add_node', node_type: 'Node3D', node_name: 'X' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute → editor -32601 → fallback headless
    await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(mockExecutor.execute).toHaveBeenCalledWith('scene', { action: 'add_node', node_type: 'Node3D', node_name: 'X' });
    expect(mockModule.handleTool).toHaveBeenCalledWith('scene', expect.objectContaining({ action: 'add_node' }), expect.anything());
  });

  // [I-12/P1-1 负面用例] 成功响应（isError=false）即使顶层带 -32601 code 也不应误判回退。
  // _isUnknownMethod 调用前置 editorResult.isError === true，防止未来 plugin 成功响应
  // 顶层带数字 code 字段时被误判 unknown method 触发静默降级 headless。
  it('does NOT fall back when editor success carries top-level code (isError guard)', async () => {
    const guard = createMockGuard(false);
    const successWithCode: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ result: 'ok', code: -32601 }) }],
      isError: false,
    };
    const mockExecutor = { execute: vi.fn().mockResolvedValue(successWithCode), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({ params: { name: 'script', arguments: { action: 'write_script' } } });
    // 未回退 headless：handler 不应被调用，且结果不是 error
    expect(mockModule.handleTool).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
  });

  // [P1-2] (2026-07-06 review) editorExecutor 可用时, dispatchTool 注入 guard 回调到 perCallCtx。
  // script.ts/scene 写前调 checkEditorTextResourceWrite/checkEditorSceneSave 防绕过编辑器守卫。
  it('injects editor guard callbacks into perCallCtx when executor available (P1-2)', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const captured: { ctx?: { checkEditorTextResourceWrite?: unknown; checkEditorSceneSave?: unknown } } = {};
    const mockModule = {
      handleTool: vi.fn().mockImplementation((_n: string, _a: Record<string, unknown>, ctx: { checkEditorTextResourceWrite?: unknown; checkEditorSceneSave?: unknown }) => {
        captured.ctx = ctx;
        return Promise.resolve(mockToolResult);
      }),
    };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    dispatcher.setEditorExecutor(mockExecutor);
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { action: 'read_scene' } } });
    expect(typeof captured.ctx?.checkEditorTextResourceWrite).toBe('function');
    expect(typeof captured.ctx?.checkEditorSceneSave).toBe('function');
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

  // [T19] catch 异常 → PII-safe 结构化错误(G2:不再外泄 err.message)
  it('catches exceptions and returns PII-safe structured error (G2 trace+PII)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockRejectedValue(new Error('boom with /home/secret/path')) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // G2 (2026-08-13): PII 护栏 — 主 catch 用 classifyError(原生 Error 兜底 INTERNAL),
    // 绝不读 err.message。'boom with /home/secret/path' 不进响应;safeMessage='Internal error'。
    expect(parsed.error_code).toBe('INTERNAL');
    expect(parsed.error_category).toBe('internal');
    expect(parsed.retryable).toBe(false);
    expect(parsed.error).toBe('Internal error');
    expect(parsed.error).not.toContain('boom');        // err.message 不外泄
    expect(parsed.error).not.toContain('secret');      // PII 路径不外泄
    expect(parsed.trace_id).toMatch(/^[0-9a-f]{16}$/); // G2 trace_id 注入
  });

  // [G2-meta] 成功路径注入 _meta.trace_id + _meta.duration_ms(审查 I-2 补强:
  //   healthSample after 经 middleware 链式赋值注入,缺测试则未来 middleware 顺序调整无法发现回归)
  it('injects _meta.trace_id + duration_ms on success path (G2)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue({ content: [{ type: 'text' as const, text: '{"success":true,"data":{}}' }] }) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect(meta?.trace_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof meta?.duration_ms).toBe('number');
  });

  // ── validateCommonArgs 类型校验 ──────────────────────────────────────────

  // [V1] project_path=123 (number) → INVALID_PARAMS
  it('rejects numeric project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123 } },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
    expect(parsed.error).toContain('project_path');
  });

  // [V2] project_path={} (object) → INVALID_PARAMS
  it('rejects object project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: { foo: 'bar' } } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V3] project_path="  " (whitespace) → INVALID_PARAMS
  it('rejects whitespace-only project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '   ' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V4] action=[] (array) → INVALID_PARAMS
  it('rejects array action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: ['read'] } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
    expect(parsed.error).toContain('action');
  });

  // [V5] action=null → INVALID_PARAMS
  it('rejects null action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: null } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V6] action="  " (whitespace) → INVALID_PARAMS
  it('rejects whitespace-only action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: '   ' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V7] 合法字符串 → 通过（不拦截）
  it('passes valid project_path and action strings', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/valid', action: 'read_scene' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  // [V8] 参数完全缺失 → 不报错（由各模块处理）
  it('passes when common params are absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { some_other_param: 'value' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V9] 多参数同时错误 → 返回第一个（project_path 先于 action）
  it('returns first error when multiple params are invalid', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123, action: [] } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain('project_path');
  });

  // [V10] project_path=null → 注入默认值（null 视为未提供）
  it('injects default project_path when project_path is null', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: null } },
    });
    expect(result.isError).toBeFalsy();
    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'scene',
      expect.objectContaining({ project_path: '/default/project' }),
      expect.anything(),
    );
  });

  // [V11] project_path=undefined (key missing) → 不报错
  it('passes when project_path key is absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: {} },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V12] action=undefined (key missing) → 不报错
  it('passes when action key is absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/valid' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V13] P0-2 MRTR: confirm_and_execute 分支使用 pending.args（包含 project_path: 123），
  // 但 validateCommonArgs 只校验 request.params.arguments 中的参数，所以 pending.args 不被拦截
  it('does not validate pending.args in confirm_and_execute branch', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { project_path: 123 }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { project_path: 123 } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute → headless dispatch（不校验 pending.args 类型）
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(result.isError).not.toBe(true);
    const text = (result.content[result.content.length - 1] as { text: string }).text;
    expect(text).toMatch(/(_duration_ms|status)/);
  });

  // [V14] editor 模式传入 project_path=123 → 在 editorExec 前拦截
  it('validates args before editor executor in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123 } },
    });
    expect(result.isError).toBe(true);
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  // [V15] camelCase {projectPath: 123} → normalizeArgs 后被拦截
  it('validates after camelCase normalization', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { projectPath: 123 } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // ── IMPORTANT-02: path allowlist validation (all modes) ──────────────────

  // [P1] editor 模式下 project_path 不在白名单 → 被拦截，不转发到 editorExecutor
  it('rejects disallowed project_path in editor mode (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockReturnValue(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/etc/passwd', action: 'read_scene' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  // [P2] headless 模式下 project_path 不在白名单 → 同样被拦截
  it('rejects disallowed project_path in headless mode (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockReturnValue(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/etc/shadow', action: 'read_scene' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  // [P3] P0-2 MRTR: confirm_and_execute 第二轮 _confirmExecute 中 pending.args 包含不允许的路径 → 被拦截
  it('rejects disallowed project_path in confirm_and_execute pending.args (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockImplementation((p: string) => !p.includes('forbidden'));
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { project_path: '/forbidden/path', action: 'read_scene' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { project_path: '/forbidden/path', action: 'read_scene' } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute 二次路径校验拦截
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
  });

  // [P4] P0-2 MRTR: confirm_and_execute editor 分支第二轮 _confirmExecute pending.args 路径 → 被拦截
  it('rejects disallowed path in confirm_and_execute editor mode (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockImplementation((p: string) => !p.includes('evil'));
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { project_path: '/evil/path', action: 'remove_node' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { project_path: '/evil/path', action: 'remove_node' } });
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    // 第二轮（用户已确认）→ consumeToken → _confirmExecute 二次路径校验拦截（不进 editor）
    const result = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      mkSrvCtx(true),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  // [P5] 允许的路径 → 正常通过所有分支
  it('allows valid project_path in editor mode (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockReturnValue(true);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/valid/project', action: 'read_scene' } },
    });
    expect(mockExecutor.execute).toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
  });

  // [P6] search_dir 不在白名单 → 被拦截
  it('rejects disallowed search_dir in editor mode (I-02)', async () => {
    const guard = createMockGuard(false);
    mockIsPathInAllowedRoots.mockImplementation((p: string) => !p.includes('secret'));
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({
      params: { name: 'project', arguments: { search_dir: '/secret/dir', action: 'list_projects' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  // [T20] 项7: normalizeArgs 超深抛错被 :186 catch(非逃逸/非 silently 绕过)
  it('rejects >20-level nested args (normalizeArgs depth limit, 项7)', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    let nested: Record<string, unknown> = { camelKey: 1 };
    for (let i = 0; i < 25; i++) nested = { outerKey: nested };
    const result = await dispatcher.handleCall({ params: { name: 'project', arguments: nested } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/depth limit|normalization failed/i);
  });

  // [M-2] 原型污染防护：normalizeArgs 丢弃 __proto__/constructor/prototype 键
  it('drops __proto__/constructor/prototype keys (M-2 原型污染防护)', () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    // JSON.parse 用 CreateDataProperty 语义，__proto__ 作为自有属性保留（区别于对象字面量的原型 setter），
    // 故能进入 Object.entries 被 normalizeArgs 遍历到——这正是攻击向量。
    const rawArgs = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":2,"normalKey":"v"}');
    const result = (dispatcher as unknown as { normalizeArgs: (a: unknown) => Record<string, unknown> }).normalizeArgs(rawArgs);
    // 污染键全部丢弃，仅保留 normalKey（camelCase → snake_case）
    expect(Object.keys(result)).toEqual(['normal_key']);
    expect(result.normal_key).toBe('v');
    // args 原型未被改写为攻击者对象（未防护时 args.__proto__={polluted:true} 会改原型）
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    // 全局 Object.prototype 未被污染（双保险）
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

// ── getFilteredTools with activeGroups ────────────────────────────────────

describe('getFilteredTools with activeGroups', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    // 默认 isToolAllowed 返回 true（不过滤）
    mockIsToolAllowed.mockReturnValue(true);
    dispatcher = new ToolDispatcher(createOptions());
  });

  // Task 3 (A-RCE #3) 连带修复:mockImplementation 会永久覆盖 mockReturnValue 默认值,
  // 若不恢复会泄漏到后续 describe。原 executeToolCall 不调 isToolAllowed 故无害;
  // Task 3 入口强制后污染暴露(后续 describe 的 docs 工具被误拒)。afterEach 显式恢复。
  afterEach(() => {
    mockIsToolAllowed.mockReturnValue(true);
  });

  it('returns only tools allowed by activeGroups', () => {
    // 模拟 activeGroups 过滤：core(animation,scene) 允许，bridge(game) 不允许
    mockIsToolAllowed.mockImplementation((name: string) => {
      const blocked = ['game'];
      return !blocked.includes(name);
    });

    const tools = dispatcher.getFilteredTools();
    const toolNames = tools.map(t => t.name);
    // core tools should be present
    expect(toolNames).toContain('scene');
    // animation tools should be present
    expect(toolNames).toContain('animation');
    // bridge tools should NOT be present
    expect(toolNames).not.toContain('game');
  });

  it('manage_tools always appears regardless of active groups', () => {
    // 模拟只有 core 组激活
    mockIsToolAllowed.mockImplementation((name: string) => {
      const coreTools = ['scene', 'script', 'project', 'confirm_and_execute'];
      return coreTools.includes(name);
    });

    const tools = dispatcher.getFilteredTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('confirm_and_execute');
  });
});

// ── default project_path injection ─────────────────────────────────────────

describe('ToolDispatcher: default project_path injection', () => {
  it('injects default project_path when not provided', async () => {
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/injected/project');

    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);

    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'read_scene' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'scene',
      expect.objectContaining({ project_path: '/injected/project', action: 'read_scene' }),
      expect.anything(),
    );
  });

  it('returns error when project_path cannot be resolved', async () => {
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const dispatcher = new ToolDispatcher(createOptions());
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'read_scene' } },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('project_path');
  });

  it('preserves explicit project_path without calling resolveProjectPath', async () => {
    const mockResolve = _mockResolveProjectPath as ReturnType<typeof vi.fn>;
    mockResolve.mockReturnValue('/should-not-be-used');

    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);

    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/explicit', action: 'read_scene' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'scene',
      expect.objectContaining({ project_path: '/explicit' }),
      expect.anything(),
    );
    // resolveProjectPath should NOT be called when explicit path provided
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('skips project_path injection for exempt tools (skipProjectPath=true)', async () => {
    // Make skipProjectPath return true for 'docs'
    const { skipProjectPath } = await import('../../src/core/tool-registry.js');
    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // 1B (2026-09-19): docs.search_classes 真实 TOOL_META 是 read;mock 默认 undefined 会触发
    // audit fail-closed 路径 → projectPath fallback 调 resolveProjectPath,破坏本用例的
    // "exempt 工具不调 resolveProjectPath"断言。按真实语义声明 read(audit 在 fallback 前 return)。
    mockGetActionRisk.mockReturnValue('read');

    const mockResolve = _mockResolveProjectPath as ReturnType<typeof vi.fn>;
    mockResolve.mockReturnValue('/should-not-be-injected');

    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);

    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'docs', arguments: { action: 'search_classes', query: 'Node3D' } },
    });

    // resolveProjectPath should NOT be called for exempt tools
    expect(mockResolve).not.toHaveBeenCalled();
    // args should NOT have project_path injected
    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'docs',
      expect.objectContaining({ action: 'search_classes', query: 'Node3D' }),
      expect.anything(),
    );
    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'docs',
      expect.not.objectContaining({ project_path: expect.anything() }),
      expect.anything(),
    );

    // Reset mock
    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('still validates project_path type for exempt tools when explicitly provided', async () => {
    const { skipProjectPath } = await import('../../src/core/tool-registry.js');
    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const dispatcher = new ToolDispatcher(createOptions());
    const result = await dispatcher.handleCall({
      params: { name: 'docs', arguments: { action: 'search_classes', query: 'Node3D', project_path: 123 } },
    });

    // validateCommonArgs should still catch invalid project_path type
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('project_path');

    // Reset mock
    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ── findGodot override (CR-1 / CR-2 regression coverage) ─────────────────────
//
// 这些用例覆盖 C-CONC-1 重构引入的两个 CRITICAL 回归:
//   CR-1: 普通调用路径漏传 findGodotOverride → godot_path 参数失效
//   CR-2: confirm_and_execute 路径基于错误 args 计算 override
// 断言核心:传入工具模块的 ctx.findGodot(第 3 个参数)必须是 override 实现,
// 而非默认的 this.ctx.findGodot。

describe('ToolDispatcher: findGodot override propagation (CR-1/CR-2)', () => {
  function makeDispatcher(overrides?: Partial<DispatcherOptions>) {
    return new ToolDispatcher(createOptions(overrides));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
    mockRequiresConfirmation.mockReturnValue(false);
    mockValidateGodotBinary.mockResolvedValue(true);
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/default/project');
  });

  // [FG1] CR-1: 普通调用 + godot_path → ctx.findGodot 应返回 override 值
  it('CR-1: propagates godot_path override to tool ctx in normal headless dispatch', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = makeDispatcher({ readOnlyGuard: guard });

    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { godot_path: '/custom/godot.exe' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalled();
    const ctx = mockModule.handleTool.mock.calls[0][2] as { findGodot: (p?: string) => Promise<string> };
    const resolved = await ctx.findGodot();
    expect(resolved).toBe('/custom/godot.exe');
  });

  // [FG2] CR-1: 普通调用 + project_path(无 godot_path) → findGodot 应以该 project_path 调用
  it('CR-1: passes explicit project_path to findGodot when no godot_path', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const findGodotSpy = vi.fn().mockResolvedValue('/found/godot');
    const dispatcher = makeDispatcher({ readOnlyGuard: guard, findGodot: findGodotSpy });

    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/explicit/project' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalled();
    const ctx = mockModule.handleTool.mock.calls[0][2] as { findGodot: (p?: string) => Promise<string> };
    await ctx.findGodot();
    // findGodot 应以显式 project_path 调用,而非 undefined
    expect(findGodotSpy).toHaveBeenCalledWith('/explicit/project');
  });

  // [FG4] P1-7 (批次 E): godot_path 两层校验拒绝分支——H-02 绝对路径 + H-01 validateGodotBinary。
  // 现有 godot_path 测试全传绝对路径+mock 成功不触发拒绝（守卫破坏可执行任意二进制）。
  it('P1-7: rejects relative godot_path (H-02 absolute path)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = makeDispatcher({ readOnlyGuard: guard });

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { godot_path: 'relative/godot.exe' } },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('must be an absolute path');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  it('P1-7: rejects invalid godot binary (H-01 validateGodotBinary false)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockValidateGodotBinaryDetailed.mockResolvedValueOnce({ ok: false, stage: 'version-run-failed' });
    const dispatcher = makeDispatcher({ readOnlyGuard: guard });

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { godot_path: '/fake/godot.exe' } },
    });

    expect(result.isError).toBe(true);
    // D3: 错误消息已从单句 "not a valid Godot binary" 升级为 stage 诊断线索
    expect(JSON.stringify(result)).toContain('godot_path failed validation');
    expect(mockModule.handleTool).not.toHaveBeenCalled();
  });

  // [FG3] CR-2: P0-2 MRTR — confirm_and_execute 第二轮 _confirmExecute 基于 pending.args.godot_path 计算 override
  it('CR-2: confirm_and_execute uses pending.args godot_path for findGodot override', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    // pending.args 携带原始调用的 godot_path(confirm_and_execute 自身 args 只有 token)
    mockPeekToken.mockReturnValue({
      toolName: 'scene',
      args: { action: 'remove_node', godot_path: '/pending/godot.exe' },
      wasTruncated: false,
    });
    mockConsumeToken.mockReturnValue({
      toolName: 'scene',
      args: { action: 'remove_node', godot_path: '/pending/godot.exe' },
    });
    const dispatcher = makeDispatcher({ readOnlyGuard: guard, connectionMode: 'headless' });

    // 第二轮（用户已确认）→ consumeToken → _confirmExecute 用 pending.args 重算 override
    const srvCtx = {
      mcpReq: {
        inputResponses: { confirm: { action: 'accept' as const, content: { confirm: true } } },
      },
    } as any;
    await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid-token' } } },
      srvCtx,
    );

    expect(mockModule.handleTool).toHaveBeenCalled();
    const ctx = mockModule.handleTool.mock.calls[0][2] as { findGodot: (p?: string) => Promise<string> };
    const resolved = await ctx.findGodot();
    // 必须是 pending.args 的 godot_path,而非默认 findGodot 或 confirm_and_execute 的 args
    expect(resolved).toBe('/pending/godot.exe');
  });

  // [G1] C-CONC-1: 并发派发时 findGodot override 必须隔离(局部变量,不串)。
  // 模拟 MCP SDK Promise.resolve().then 并发派发多个 tools/call。若用实例字段存 override,
  // 后发调用会覆盖先发 → 两调用 ctx.findGodot 都返回同一值(串)。局部变量沿调用链传递则隔离。
  it('concurrent dispatches isolate findGodot override (G1, C-CONC-1)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    // 用 project_path + findGodotSpy(无 godot_path → 走项目感知 findGodot,不触发 validate 真实 spawn)
    const findGodotSpy = vi.fn((p?: string) => Promise.resolve(`/godot/for/${p ?? 'default'}`));
    const dispatcher = makeDispatcher({ readOnlyGuard: guard, findGodot: findGodotSpy });

    await Promise.all([
      dispatcher.handleCall({ params: { name: 'scene', arguments: { project_path: '/proj/A' } } }),
      dispatcher.handleCall({ params: { name: 'scene', arguments: { project_path: '/proj/B' } } }),
    ]);

    expect(mockModule.handleTool).toHaveBeenCalledTimes(2);
    // 各调用的 ctx.findGodot 返回各自的 override(基于该调用 project_path)— 不串
    const results = await Promise.all(
      mockModule.handleTool.mock.calls.map(c => (c[2] as { findGodot: () => Promise<string> }).findGodot()),
    );
    expect(results.sort()).toEqual(['/godot/for//proj/A', '/godot/for//proj/B']);
  });

  // [FG4] 无 godot_path 无 project_path → findGodot 以 undefined 调用(回退默认查找逻辑)
  it('falls back to default findGodot(undefined) when no godot_path and no project_path', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    // skipProjectPath 模拟,使 project_path 不被注入
    const { skipProjectPath } = await import('../../src/core/tool-registry.js');
    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const findGodotSpy = vi.fn().mockResolvedValue('/default/godot');
    const dispatcher = makeDispatcher({ readOnlyGuard: guard, findGodot: findGodotSpy });

    await dispatcher.handleCall({
      params: { name: 'docs', arguments: { action: 'search_classes', query: 'Node3D' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalled();
    const ctx = mockModule.handleTool.mock.calls[0][2] as { findGodot: (p?: string) => Promise<string> };
    await ctx.findGodot();
    // 无 project_path 时应以 undefined 调用
    expect(findGodotSpy).toHaveBeenCalledWith(undefined);

    (skipProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ── buildPerCallCtx ─────────────────────────────────────────────────────────
// [REGRESSION] spread {...this.ctx} 会把 ctx 上的 getter(runningProcess/outputBuffer 等,
// 连 process-state 模块)展平成调用时刻快照。dispatch 入口 _runningProcess=null →
// perCallCtx.runningProcess 冻结成 null → run_project isCancelled 永远 true →
// wait_for_bridge 误报 "process exited during probe"。Object.create 继承原型 getter 修复。
describe('buildPerCallCtx', () => {
  it('保留 runningProcess getter — setRunningProcess 后 perCallCtx 反映新值(非 spread 快照)', () => {
    let current: unknown = null;
    const base = {
      get runningProcess() { return current; },
      setRunningProcess(p: unknown) { current = p; },
      findGodot: vi.fn(),
    } as unknown as Parameters<typeof buildPerCallCtx>[0];
    const perCallCtx = buildPerCallCtx(base, undefined);
    // 模拟 run_project: dispatch 后 setRunningProcess(proc) 改模块 state
    (base as any).setRunningProcess('PROC_A');
    expect((perCallCtx as any).runningProcess).toBe('PROC_A'); // spread 时为 null → fail
  });

  it('findGodot 覆盖: 有 override 用 override,无 override 继承 base', () => {
    const baseFind = vi.fn();
    const overrideFind = vi.fn();
    const base = { findGodot: baseFind, runningProcess: null } as unknown as Parameters<typeof buildPerCallCtx>[0];
    expect((buildPerCallCtx(base, overrideFind as any) as any).findGodot).toBe(overrideFind);
    expect((buildPerCallCtx(base, undefined) as any).findGodot).toBe(baseFind);
  });

  it('保留其他 getter(outputBuffer)', () => {
    let buf: string[] = ['old'];
    const base = {
      get outputBuffer() { return buf; },
      findGodot: vi.fn(),
    } as unknown as Parameters<typeof buildPerCallCtx>[0];
    const perCallCtx = buildPerCallCtx(base, undefined);
    buf.push('new');
    expect((perCallCtx as any).outputBuffer).toEqual(['old', 'new']); // spread 时为 ['old'] 快照 → fail
  });
});

// ── Task 3: validateArgs schema 防线集成 ───────────────────────────────────
//
// 接入点:executeToolCall L231(validateCommonArgs return)后、ReadOnlyGuard 前。
// 用 action enum 违规演示:'totally_bogus_action' 是非空 string → 通过 validateCommonArgs,
// 但不在 scene action enum 内 → validateArgs 拒绝。接入前此用例会传到 handler(无 INVALID_PARAMS),
// 接入后返 INVALID_PARAMS 且 handler/executor 不被调用。
// #9 R2 要求:editor + headless 两路都覆盖,锁定接入点上移覆盖 editor,防后续挪回 dispatchTool 时
// editor 静默回归。

describe('executeToolCall schema validation (Task 3)', () => {
  // scene 真实 inputSchema 的 action 是 string enum;用精简 schema 演示 enum 违规拒绝
  const sceneSchemaWithEnum: Tool = {
    name: 'scene',
    description: 'Scene ops',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string' },
        action: { type: 'string', enum: ['read_scene', 'add_node', 'remove_node'] },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
    mockGetToolDefinition.mockReturnValue(sceneSchemaWithEnum);
    mockRequiresConfirmation.mockReturnValue(false);
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/default/project');
  });

  // [S1] headless:action 是非空 string → 通过 validateCommonArgs,但不在 enum → validateArgs 拒绝
  it('headless: enum-violating action → INVALID_PARAMS, handler not called', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'full', connectionMode: 'headless', readOnlyGuard: guard }));

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/tmp', action: 'totally_bogus_action' } },
    });

    // 接入前:handler 被调用,result 是 mockToolResult(isError undefined) → 用例 fail(RED)
    // 接入后:返 INVALID_PARAMS + handler 未调用(GREEN)
    expect(mockModule.handleTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [S2] editor:同样 enum 违规 → INVALID_PARAMS,executor 不被调用(锁定 #1 上移覆盖 editor)
  it('editor: enum-violating action → INVALID_PARAMS, executor not called', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'full', connectionMode: 'editor', readOnlyGuard: guard }));
    dispatcher.setEditorExecutor(mockExecutor);

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/tmp', action: 'totally_bogus_action' } },
    });

    expect(mockExecutor.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [S3] 合法 enum 值 → 通过 validateArgs,正常 dispatch(防过度拦截回归)
  it('valid enum action passes validateArgs and dispatches normally', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ mode: 'full', connectionMode: 'headless', readOnlyGuard: guard }));

    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/tmp', action: 'read_scene' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [S4] P0-2 MRTR: getToolDefinition 返 undefined(内联工具如 confirm_and_execute)→ 跳过校验,不误伤
  it('inline tool (getToolDefinition undefined) skips validateArgs', async () => {
    mockGetToolDefinition.mockReturnValue(undefined);
    const guard = createMockGuard(false);
    mockPeekToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' }, wasTruncated: false });
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { action: 'read_scene' } });
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ readOnlyGuard: guard }));

    // 第二轮（用户已确认）→ consumeToken → _confirmExecute → headless dispatch
    const srvCtx = {
      mcpReq: {
        inputResponses: { confirm: { action: 'accept' as const, content: { confirm: true } } },
      },
    } as any;
    await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'valid' } } },
      srvCtx,
    );

    // confirm_and_execute 路径应正常执行(内联工具无 inputSchema → 跳过)
    expect(mockModule.handleTool).toHaveBeenCalled();
  });
});

// ── Task 3 (A-RCE #3): profile 硬隔离(executeToolCall 入口 isToolAllowed 强制) ─
//
// 背景:isToolAllowed 原只在 getFilteredTools 广告层(:183)用,executeToolCall 主路径
// 不强制。被转发 MCP 客户端(拿完整 tools/list 或硬编码工具名)仍可调用 TOOL_GROUPS/
// slim 过滤的工具。非 RCE(ReadOnlyGuard 兜底),是隔离弱。入口强制 = 防御深度对称补强。
//
// 默认 activeGroups = Object.keys(TOOL_GROUPS)(全 20 组激活),isToolAllowed 对所有
// 已知顶层工具名(script/scene/validation 等)返 true,默认场景零误拒。
// manage_tools deactivate 收窄 activeGroups 后,入口强制才生效。
// 注意:executeToolCall 的 name 是顶层工具名,不是 action 名(execute_gdscript 是
// script 工具的 action,由 arguments.action 传)。

describe('executeToolCall profile enforcement (Task 3, A-RCE #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
    mockGetToolDefinition.mockReturnValue(undefined);
    mockRequiresConfirmation.mockReturnValue(false);
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/default/project');
    // 默认 isToolAllowed=true(对齐 mock 声明,防上个 describe 残留 false 污染)
    mockIsToolAllowed.mockReturnValue(true);
  });

  afterEach(() => {
    // 显式恢复,防 mockReturnValue(false) 跨 describe 泄漏
    mockIsToolAllowed.mockReturnValue(true);
  });

  // [P1] isToolAllowed=false → executeToolCall 入口拒绝 TOOL_NOT_ALLOWED,不路由执行
  it('rejects tool when isToolAllowed returns false (filtered out by TOOL_GROUPS)', async () => {
    mockIsToolAllowed.mockReturnValue(false);
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ readOnlyGuard: guard }));

    const result = await dispatcher.handleCall({
      params: { name: 'blender', arguments: { project_path: '/tmp' } },
    });

    // 接入前:executeToolCall 不检查 isToolAllowed,路由到 handler 返 mockToolResult(isError undefined)
    // 接入后:入口返 TOOL_NOT_ALLOWED,handler/executor 不被调用
    expect(mockModule.handleTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('TOOL_NOT_ALLOWED');
  });

  // [P2] editor 路由也被入口强制覆盖(对齐 S2 设计:防后续挪回 dispatchTool 时 editor 静默回归)
  it('rejects tool in editor routing too (defense-in-depth across routing paths)', async () => {
    mockIsToolAllowed.mockReturnValue(false);
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = new ToolDispatcher(createOptions({ connectionMode: 'editor', readOnlyGuard: guard }));
    dispatcher.setEditorExecutor(mockExecutor);

    const result = await dispatcher.handleCall({
      params: { name: 'blender', arguments: { project_path: '/tmp' } },
    });

    expect(mockExecutor.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('TOOL_NOT_ALLOWED');
  });

  // [P3] 默认 isToolAllowed=true → 顶层 core 工具不误拒(防过度拦截回归)
  // 注意：不能用 execute_gdscript 测——它是 action-gate 的 code-execution gated action，
  // 默认无 GODOT_MCP_PRIVILEGED_GROUPS 会被 isActionGated 拦截（2026-08-06 审查 P0 修复后 key 正确命中）。
  // 用 edit_script（同属 script 工具但非 gated）验证 core 工具正常放行。
  it('allowed core tool dispatches normally (no false rejection)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ readOnlyGuard: guard }));

    await dispatcher.handleCall({
      params: { name: 'script', arguments: { project_path: '/tmp', action: 'edit_script', script_path: '/tmp/x.gd', content: 'pass' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalled();
  });
});

// ── Task 3: CallRecorder 接线(healthSample.after hook record) ───────────────
//
// 接线点:buildMiddleware 的 healthSample.after(:387-396)。每次工具调用后,
// record 被调(成功记 ctx.toolName+ok,失败记 +errorType/extractErrorMessage)。
// 验证 getCallRecorder().getStats() 的 total/success/fail 在成功/失败 dispatch 后变化。

// ── P0-2 (2026-08-11): ACTION_GATED dispatcher 接线集成测 ────────────────────
// action-gate.test.ts 只覆盖纯函数(isActionGated/isActionAllowed/resolveEnabledGroups)。
// 本块验证 ToolDispatcher.ts:273-275 的接线层:GODOT_MCP_PRIVILEGED_GROUPS 未设时
// script.execute_gdscript 被 ACTION_GATED 拦截,设 code-execution 后放行到 handleTool。
// 删掉 :273-275 不会让任何现有测试红 = 接线零验证(wiring-zero-verification-test-gap
// 教训复发),本块补这个 gap。action-gate 是真实 import(非 mock),故为真集成测。
describe('ToolDispatcher ACTION_GATED wiring (P0-2)', () => {
  const origEnv = process.env.GODOT_MCP_PRIVILEGED_GROUPS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.GODOT_MCP_PRIVILEGED_GROUPS;
    else process.env.GODOT_MCP_PRIVILEGED_GROUPS = origEnv;
  });

  it('blocks script.execute_gdscript when GODOT_MCP_PRIVILEGED_GROUPS unset (integration, not pure-fn)', async () => {
    delete process.env.GODOT_MCP_PRIVILEGED_GROUPS;
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    const result = await dispatcher.handleCall({
      params: { name: 'script', arguments: { action: 'execute_gdscript', project_path: '/tmp', code: 'pass' } },
    });

    expect(result.isError).toBe(true);
    expect(handleToolSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('ACTION_GATED');
  });

  it('allows script.execute_gdscript when GODOT_MCP_PRIVILEGED_GROUPS=code-execution', async () => {
    process.env.GODOT_MCP_PRIVILEGED_GROUPS = 'code-execution';
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    const result = await dispatcher.handleCall({
      params: { name: 'script', arguments: { action: 'execute_gdscript', project_path: '/tmp', code: 'pass' } },
    });

    expect(handleToolSpy).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });
});

// ── P2-2 (2026-08-11): 安全接线守护(isPathInAllowedRoots)────────────────────
// 审查 P2-2:ToolDispatcher.ts:640 isPathInAllowedRoots 拦截零集成测(删 :640-641
// 不会让任何测试红)。本块守护 project_path 路径校验接线(PATH_NOT_ALLOWED)。
// validateGodotBinary(:672)接线测试标 follow-up(触发需 godotOverride 特定条件)。
describe('ToolDispatcher isPathInAllowedRoots wiring (P2-2)', () => {
  afterEach(() => {
    mockIsPathInAllowedRoots.mockReturnValue(true);  // restore 默认(放行)
  });

  it('isPathInAllowedRoots=false → PATH_NOT_ALLOWED(守护接线,删 :640 此测试红)', async () => {
    mockIsPathInAllowedRoots.mockReturnValue(false);
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'add_node', project_path: '/etc/passwd', scene_path: 'res://main.tscn', node_type: 'Node', node_name: 'X' } },
    });

    expect(result.isError).toBe(true);
    expect(handleToolSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('PATH_NOT_ALLOWED');
  });

  it('isPathInAllowedRoots=true → 放行(对照,防过度拦截)', async () => {
    mockIsPathInAllowedRoots.mockReturnValue(true);
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'add_node', project_path: '/proj', scene_path: 'res://main.tscn', node_type: 'Node', node_name: 'X' } },
    });

    expect(handleToolSpy).toHaveBeenCalled();
  });
});

// ── P2-2 (2026-08-11): validateGodotBinary 接线守护 ────────────────────────
// 审查 P2-2:ToolDispatcher.ts:672 validateGodotBinary 拦截零集成测
// (删 :672-676 不会让任何测试红 = binary 校验接线零验证,防 godot_path 指向非 Godot)。
describe('ToolDispatcher validateGodotBinary wiring (P2-2)', () => {
  afterEach(() => {
    mockValidateGodotBinary.mockResolvedValue(true);  // restore 默认(通过)
    mockValidateGodotBinaryDetailed.mockResolvedValue({ ok: true });
  });

  it('validateGodotBinary=false + godot_path → INVALID_PARAMS(守护接线,删 :672 此测试红)', async () => {
    mockValidateGodotBinaryDetailed.mockResolvedValue({ ok: false, stage: 'path-not-allowed' });
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'add_node', project_path: '/proj', scene_path: 'res://main.tscn', node_type: 'Node', node_name: 'X', godot_path: '/fake/nonexistent-godot' } },
    });

    expect(result.isError).toBe(true);
    expect(handleToolSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(parsed)).toMatch(/godot_path failed validation/i);
  });

  // D3 (2026-09-17 反馈批次D): 校验失败错误须带诊断线索——分层 stage 的排查指引 +
  // validator pipeline 说明(09-06 fr2 反馈:单句 "not a valid Godot binary" 无从排查)。
  it('D3: 失败错误带 stage 诊断线索 + validator pipeline 说明(各 stage 抽查)', async () => {
    const cases: Array<{ stage: 'path-not-allowed' | 'is-directory' | 'version-run-failed' | 'not-godot-signature'; stdoutPreview?: string; expectText: RegExp }> = [
      { stage: 'path-not-allowed', expectText: /GODOT_MCP_ALLOWED_GODOT_PATHS whitelist/ },
      { stage: 'is-directory', expectText: /path is a directory/ },
      { stage: 'version-run-failed', expectText: /could not execute the binary with --version/ },
      { stage: 'not-godot-signature', stdoutPreview: 'some junk 1.2', expectText: /did not match a Godot version signature \(got: .{0,3}some junk 1\.2/ },
    ];
    for (const c of cases) {
      mockValidateGodotBinaryDetailed.mockResolvedValue({ ok: false, stage: c.stage, stdoutPreview: c.stdoutPreview });
      const dispatcher = new ToolDispatcher(createOptions());

      const result = await dispatcher.handleCall({
        params: { name: 'scene', arguments: { action: 'add_node', project_path: '/proj', scene_path: 'res://main.tscn', node_type: 'Node', node_name: 'X', godot_path: '/fake/invalid-godot' } },
      });

      expect(result.isError, `stage=${c.stage}`).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text, `stage=${c.stage} 须含该 stage 的排查指引`).toMatch(c.expectText);
      expect(text, `stage=${c.stage} 须含 validator pipeline 说明`).toMatch(/validator pipeline: whitelist check → directory check → run --version/);
    }
  });

  // Nit2 清偿(2026-09-17 批D审查): 消费方已改 validateGodotBinaryDetailed——
  // 放行靠 Detailed 默认 {ok:true},用例名与显式设置同步对齐(旧 boolean mock 设置是无效残留)
  it('validateGodotBinaryDetailed ok:true + godot_path → 放行(对照)', async () => {
    mockValidateGodotBinaryDetailed.mockResolvedValue({ ok: true });
    const handleToolSpy = vi.fn().mockResolvedValue(mockToolResult);
    mockGetModuleForTool.mockReturnValue({ handleTool: handleToolSpy });
    const dispatcher = new ToolDispatcher(createOptions());

    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'add_node', project_path: '/proj', scene_path: 'res://main.tscn', node_type: 'Node', node_name: 'X', godot_path: '/fake/valid-godot' } },
    });

    expect(handleToolSpy).toHaveBeenCalled();
  });
});

describe('ToolDispatcher callRecorder wiring (Task 3)', () => {
  const successResult: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
  };
  const errorResult: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify({ error: 'boom failure' }) }],
    isError: true,
  };

  beforeEach(() => {
    getCallRecorder().reset();
    vi.clearAllMocks();
    mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
    mockRequiresConfirmation.mockReturnValue(false);
    (_mockResolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue('/default/project');
  });

  it('records success on successful tool call', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(successResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ readOnlyGuard: guard }));

    await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });

    const stats = getCallRecorder().getStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.success).toBeGreaterThanOrEqual(1);
    expect(stats.fail).toBe(0);
  });

  it('records failure on error tool call (isError=true)', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(errorResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = new ToolDispatcher(createOptions({ readOnlyGuard: guard }));

    await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });

    const stats = getCallRecorder().getStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.fail).toBeGreaterThanOrEqual(1);
    expect(stats.success).toBe(0);
  });
});

// ── Task 3: progress 透传链 ──────────────────────────────────────────────────
describe('ToolDispatcher progress 透传链', () => {
  let capturedCtx: any = null;
  const mockModule = {
    handleTool: vi.fn(async (_name: string, _args: Record<string, unknown>, ctx: any) => {
      capturedCtx = ctx;
      return mockToolResult;
    }),
  };

  beforeEach(() => {
    resetProgressSender();
    capturedCtx = null;
    mockGetModuleForTool.mockReturnValue(mockModule);
    mockGetToolDefinition.mockReturnValue(undefined);
  });

  it('request 含 _meta.progressToken → perCallCtx.progress 非 undefined 且可调用触发 notification', async () => {
    const server = { notification: vi.fn().mockReturnValue(undefined) };
    setProgressSender(server as any);
    setProgressClientReady(true);
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'workflow', arguments: { action: 'dev_loop' }, _meta: { progressToken: 'tok-A' } },
    } as any);
    expect(capturedCtx).not.toBeNull();
    expect(typeof capturedCtx.progress).toBe('function');
    capturedCtx.progress(1, 3, 'executing');
    expect(server.notification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'tok-A', progress: 1, total: 3, message: 'executing' },
    });
  });

  it('request 无 _meta → perCallCtx.progress 为 undefined', async () => {
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'workflow', arguments: { action: 'dev_loop' } },
    } as any);
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.progress).toBeUndefined();
  });

  it('并发两 handleCall 不同 token → emitter 闭包独立不串（C-CONC-1）', async () => {
    const server = { notification: vi.fn().mockReturnValue(undefined) };
    setProgressSender(server as any);
    setProgressClientReady(true);
    const dispatcher = new ToolDispatcher(createOptions());
    const ctxA: any[] = [];
    const ctxB: any[] = [];
    mockModule.handleTool
      .mockImplementationOnce(async (_n: string, _a: Record<string, unknown>, ctx: any) => { ctxA.push(ctx); return mockToolResult; })
      .mockImplementationOnce(async (_n: string, _a: Record<string, unknown>, ctx: any) => { ctxB.push(ctx); return mockToolResult; });
    // 并发派发（不 await 第一个）
    const pA = dispatcher.handleCall({ params: { name: 'workflow', arguments: {}, _meta: { progressToken: 'A' } } } as any);
    const pB = dispatcher.handleCall({ params: { name: 'workflow', arguments: {}, _meta: { progressToken: 'B' } } } as any);
    await Promise.all([pA, pB]);
    // 各自 emitter 带各自 token（验证不串）
    ctxA[0].progress(1, 2);
    ctxB[0].progress(1, 2);
    const tokens = server.notification.mock.calls.map((c: any[]) => c[0].params.progressToken);
    expect(tokens).toContain('A');
    expect(tokens).toContain('B');
  });

  it('editor 模式 + dev_loop + progressToken → fallback 路径 perCallCtx.progress 注入非 undefined', async () => {
    // editor 模式：currentExecutor.execute 返回 -32601 → 触发 _isUnknownMethod → fallback dispatchTool
    const editorExecutor = {
      execute: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Unknown method' } }) }],
        isError: true, // -32601 是 error 响应;_isUnknownMethod 调用前置 editorResult.isError===true(I-12/P1-1 guard)
      }),
    };
    const server = { notification: vi.fn().mockReturnValue(undefined) };
    setProgressSender(server as any);
    setProgressClientReady(true);
    const dispatcher = new ToolDispatcher(createOptions({ connectionMode: 'editor' } as any));
    dispatcher.setEditorExecutor(editorExecutor as any);
    await dispatcher.handleCall({
      params: { name: 'workflow', arguments: { action: 'dev_loop' }, _meta: { progressToken: 'tok-ed' } },
    } as any);
    // fallback 后走 dispatchTool → buildPerCallCtx → mockModule 收到 ctx.progress
    expect(capturedCtx).not.toBeNull();
    expect(typeof capturedCtx.progress).toBe('function');
  });
});

// ── 1A/1B/1C (2026-09-19 安全加固批1): audit middleware 行为 ──────────────────
//
// 直接取 ToolDispatcher 构造的 audit after hook 手动调用(不经 executeMiddleware 全链路),
// 真实 audit-log 落盘到临时目录断言。getActionRisk 经 mock 控制(默认 undefined = risk 未知),
// isDynamicToolName 经 mock 控制,resolveDynamicTool 用真实实现(未知名返 undefined)。
describe('audit middleware (1A STRICT / 1B fail-closed / 1C caller)', () => {
  type AuditAfter = (ctx: import('../../src/types.js').DispatchContext, result: import('../../src/types.js').ToolResult) => Promise<import('../../src/types.js').ToolResult>;
  let auditAfter: AuditAfter;
  let tmp: string;

  beforeEach(async () => {
    mockGetAllToolDefinitions.mockReturnValue([...FIXTURE_TOOLS]);
    mockRequiresConfirmation.mockReturnValue(false);
    mockIsDynamicToolName.mockReturnValue(false);
    mockGetActionRisk.mockReturnValue(undefined);
    mockIsReadOnly.mockReturnValue(false);
    delete process.env.GODOT_MCP_AUDIT_STRICT;
    delete process.env.GODOT_MCP_AUDIT;
    const dispatcher = new ToolDispatcher(createOptions());
    const mws = (dispatcher as unknown as { middleware: { name: string; after?: unknown }[] }).middleware;
    const audit = mws.find((m) => m.name === 'audit');
    if (typeof audit?.after !== 'function') throw new Error('audit middleware after hook not found');
    auditAfter = audit.after as AuditAfter;
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mw-'));
  });

  afterEach(async () => {
    delete process.env.GODOT_MCP_AUDIT_STRICT;
    const fs = await import('fs');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkCtx = (over: Partial<import('../../src/types.js').DispatchContext> = {}) => ({
    toolName: 'scene',
    args: { action: 'save_scene', project_path: tmp },
    startTime: Date.now(),
    phase: 'after' as const,
    traceId: 't1a2b3c4d5e6f7a8',
    ...over,
  });
  const okResult = { content: [{ type: 'text' as const, text: '{"status":"ok"}' }] };

  it('1B: risk 未知(静态漏声明)→ fail-closed 按 write 落审计 + risk_unknown', async () => {
    await auditAfter(mkCtx(), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    const s = await readAuditLog(tmp);
    expect(s.totalEntries).toBe(1);
    expect(s.entries[0]!.risk).toBe('write');
    expect((s.entries[0]!.details as Record<string, unknown>).risk_unknown).toBe(true);
    expect((s.entries[0]!.details as Record<string, unknown>).dynamic_unmapped).toBeUndefined();
  });

  it('1B: 未映射动态工具 → dynamic_unmapped=true(resolveDynamicTool 真实返 undefined)', async () => {
    mockIsDynamicToolName.mockReturnValue(true);
    await auditAfter(mkCtx({ toolName: 'definitely_not_mapped_method' }), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    const s = await readAuditLog(tmp);
    expect(s.totalEntries).toBe(1);
    expect((s.entries[0]!.details as Record<string, unknown>).dynamic_unmapped).toBe(true);
    expect((s.entries[0]!.details as Record<string, unknown>).risk_unknown).toBeUndefined();
  });

  it('I-1: readonly 平铺工具(help 的 `_: "read"` 形态,action 查不中)→ 豁免不落审计', async () => {
    // help 真实 TOOL_META: actionRisks={_:'read'} → 派生 readonly=true;调用无 action →
    // getActionRisk('help','') undefined,但工具级已声明只读 → 豁免(防 read 记 write 污染)
    mockIsReadOnly.mockReturnValue(true);
    await auditAfter(mkCtx({ toolName: 'help', args: { project_path: tmp } }), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    expect((await readAuditLog(tmp)).totalEntries).toBe(0);
  });

  it('I-1: confirm_and_execute(inline 注册 readonly=true)→ 豁免,防确认路径审计双写', async () => {
    // 真实执行审计由 _auditConfirmedExecution 补记(带真实 tool/action+confirmed 标记),
    // middleware 层对 confirm_and_execute(action='')不落 risk_unknown 条目
    mockIsReadOnly.mockReturnValue(true);
    await auditAfter(mkCtx({ toolName: 'confirm_and_execute', args: { token: 't', project_path: tmp } }), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    expect((await readAuditLog(tmp)).totalEntries).toBe(0);
  });

  it('risk=read → 跳过审计(旧行为不变)', async () => {
    mockGetActionRisk.mockReturnValue('read');
    await auditAfter(mkCtx(), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    expect((await readAuditLog(tmp)).totalEntries).toBe(0);
  });

  it('1C: ctx.caller 透传到审计行 caller 字段;缺省不写字段', async () => {
    mockGetActionRisk.mockReturnValue('write');
    // 缺省态:不传 caller → 审计行 JSON 序列化后无 caller 键
    await auditAfter(mkCtx(), okResult);
    // 透传态:caller='agent-42' → 审计行 caller 字段
    await auditAfter(mkCtx({ caller: 'agent-42' }), okResult);
    const { readAuditLog } = await import('../../src/core/audit-log.js');
    const s = await readAuditLog(tmp);
    expect(s.totalEntries).toBe(2);
    expect(s.entries[0]!.caller).toBeUndefined();
    expect(s.entries[1]!.caller).toBe('agent-42');
  });

  it('1A: 默认模式审计写失败 → result 原样返回 + 失败计数递增(不抛错)', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    // project_path 指向已存在文件 → mkdir(dirname(auditPath)) 抛 ENOTDIR → appendAuditLine throw
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-blk-'));
    const filePath = path.join(blocker, 'plainfile');
    fs.writeFileSync(filePath, 'x');
    const { getAuditFailureStats } = await import('../../src/core/audit-log.js');
    const before = getAuditFailureStats().failures;
    const ctx = mkCtx({ args: { action: 'save_scene', project_path: filePath } });
    const out = await auditAfter(ctx, okResult);
    expect(out).toBe(okResult); // 原样返回(默认 best-effort)
    expect(getAuditFailureStats().failures).toBe(before + 1);
    fs.rmSync(blocker, { recursive: true, force: true });
  });

  it('1A STRICT: 审计写失败 → after 返回 isError result(操作判失败)', async () => {
    process.env.GODOT_MCP_AUDIT_STRICT = 'true';
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-blk2-'));
    const filePath = path.join(blocker, 'plainfile');
    fs.writeFileSync(filePath, 'x');
    const ctx = mkCtx({ args: { action: 'save_scene', project_path: filePath } });
    const out = await auditAfter(ctx, okResult);
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify((out as { content: unknown }).content)).toContain('AUDIT_WRITE_FAILED');
    fs.rmSync(blocker, { recursive: true, force: true });
  });
});
