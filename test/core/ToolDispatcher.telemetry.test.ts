// test/core/ToolDispatcher.telemetry.test.ts
// 验证 ToolDispatcher.buildMiddleware 接入的 telemetry after-hook：
// 每次工具调用后调 record({tool,success,duration_ms,error_category?,project_hash?})。
import type { Tool } from "@modelcontextprotocol/server";

// buildMiddleware 为 private，经 handleCall 全链路触发，断言 record mock 调用契约。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DispatcherOptions } from '../../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { ToolResult } from '../../src/types.js';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────
// 仅 mock ToolDispatcher 直接依赖（tool-registry/guard/helpers/path-utils/
// shared/process-state/godot-finder/telemetry）；其余（health-monitor/elicit/
// logger/middleware/feature-flags/progress）走真实模块，保留全链路语义。
const {
  mockGetAllToolDefinitions,
  mockGetModuleForTool,
  mockGetToolDefinition,
  mockRequiresConfirmation,
  mockIsPathInAllowedRoots,
  mockSkipProjectPath,
  mockValidateGodotBinary,
  mockValidateGodotBinaryDetailed,
  mockRecord,
  mockHashProject,
  mockIsTelemetryEnabled,
} = vi.hoisted(() => ({
  mockGetAllToolDefinitions: vi.fn<() => Tool[]>(),
  mockGetModuleForTool: vi.fn(),
  mockGetToolDefinition: vi.fn().mockReturnValue(undefined),
  mockRequiresConfirmation: vi.fn().mockReturnValue(false),
  mockIsPathInAllowedRoots: vi.fn().mockReturnValue(true),
  mockSkipProjectPath: vi.fn().mockReturnValue(false),
  mockValidateGodotBinary: vi.fn().mockResolvedValue(true),
  mockValidateGodotBinaryDetailed: vi.fn().mockResolvedValue({ ok: true }),
  mockRecord: vi.fn(),
  mockHashProject: vi.fn().mockReturnValue('deadbeef'),
  // T2: 可控 isTelemetryEnabled——T1 默认 true（保持 record 被调），T2 测试中切 false
  // 验证 opt-out 守卫拦截 hashProject 参数求值（堵 telemetry-uuid.txt 创建）。
  mockIsTelemetryEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/telemetry/index.js', () => ({
  record: mockRecord,
  hashProject: mockHashProject,
  isTelemetryEnabled: mockIsTelemetryEnabled,
  getInstallUUID: () => 'salt',
  cleanupLocalFiles: vi.fn(),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  getAllToolDefinitions: mockGetAllToolDefinitions,
  getModuleForTool: mockGetModuleForTool,
  getToolDefinition: mockGetToolDefinition,
  registerInlineTool: vi.fn(),
  LITE_TOOLS: new Set<string>(),
  MINIMAL_TOOLS: new Set<string>(),
  isToolAllowed: vi.fn().mockReturnValue(true),
  // A1 (2026-08-11): dispatcher 新增动态工具门反查 import,mock 工厂缺此导出会在
  // executeToolCall 调 undefined 报 TypeError(测试全红)
  isDynamicToolName: vi.fn().mockReturnValue(false),
  setActiveGroups: vi.fn(),
  resolveProfile: vi.fn().mockReturnValue(new Set<string>()),
  skipProjectPath: mockSkipProjectPath,
  tryLegacyMapping: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/guard.js', () => ({
  requiresConfirmation: mockRequiresConfirmation,
  createPendingToken: vi.fn(),
  consumeToken: vi.fn(),
  TOKEN_TTL_MS: 60_000,
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
  opsErrorResult: vi.fn((code: string, msg: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg, error_code: code, warnings: [] }) }],
    isError: true,
  })),
  COMMON_ERROR_CODES: { INVALID_PARAMS: 'INVALID_PARAMS' },
}));

// I-4 统一策略(设计 §7):importOriginal 部分覆盖——仅 stub 防副作用的 getter/setter,
// 新导出透传真实模块,防补导出漂移。
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

vi.mock('../../src/core/godot-finder.js', () => ({
  validateGodotBinary: mockValidateGodotBinary,
  validateGodotBinaryDetailed: mockValidateGodotBinaryDetailed,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockGuard(): ReadOnlyGuard {
  return {
    check: vi.fn().mockReturnValue({ blocked: false }),
  } as unknown as ReadOnlyGuard;
}

function createOptions(overrides?: Partial<DispatcherOptions>): DispatcherOptions {
  return {
    readOnly: false,
    mode: 'full',
    connectionMode: 'headless',
    noFallback: false,
    readOnlyGuard: createMockGuard(),
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn().mockResolvedValue('/fake/godot'),
    toolCallDelegate: vi.fn(),
    elicitFn: async () => ({ confirm: true }),
    ...overrides,
  };
}

const okResult: ToolResult = {
  content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
};

const FIXTURE_TOOL: Tool = {
  name: 'scene',
  description: 'Scene ops',
  inputSchema: { type: 'object', properties: {} },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ToolDispatcher telemetry middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllToolDefinitions.mockReturnValue([FIXTURE_TOOL]);
    mockGetModuleForTool.mockReturnValue({ handleTool: vi.fn().mockResolvedValue(okResult) });
    // T2: 默认 opt-in（isTelemetryEnabled=true）保持 T1 各用例 record 被调；
    // T2 opt-out 用例在 it 内 mockReturnValue(false) 覆盖。
    mockIsTelemetryEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 核心契约：成功路径下 record 一次调用，参数含 tool/success/duration_ms/project_hash
  it('invokes record after successful tool call with full payload', async () => {
    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/test/proj' } },
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const event = mockRecord.mock.calls[0][0];
    expect(event.tool).toBe('scene');
    expect(event.success).toBe(true);
    expect(typeof event.duration_ms).toBe('number');
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
    expect(event.error_category).toBeUndefined();
    expect(event.project_hash).toBe('deadbeef');
    expect(mockHashProject).toHaveBeenCalledWith('/test/proj');
  });

  // T1: 失败路径 success=false，error_category 固定 'TOOL_ERROR' 枚举（不再由 safeErrorCategory 派生）。
  // 原 safeErrorCategory 派生会泄漏 PII（见下条专项测试），现已改为固定枚举。
  it('flags failure with fixed error_category=TOOL_ERROR (T1: no PII derivation)', async () => {
    const failResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: -32603, message: 'boom' } }) }],
      isError: true,
    };
    mockGetModuleForTool.mockReturnValue({ handleTool: vi.fn().mockResolvedValue(failResult) });

    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/p' } },
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const event = mockRecord.mock.calls[0][0];
    expect(event.success).toBe(false);
    expect(event.error_category).toBe('TOOL_ERROR');
  });

  // T1 专项（PII 泄漏防复发）：错误文本含路径/项目名时，error_category 必须是固定枚举，
  // 整个 telemetry event 的 JSON 不得含路径片段。
  it('T1: telemetry error_category 固定 TOOL_ERROR，error 文本含路径时 event 零 PII 外泄', async () => {
    // 构造失败 ToolResult，content text 含路径（模拟 PII：home/wgt/secret/tscn）
    const piiResult: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: '{"success":false,"error":"Failed to load /home/wgt/secret/Main.tscn"}' }],
    };
    mockGetModuleForTool.mockReturnValue({ handleTool: vi.fn().mockResolvedValue(piiResult) });

    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/home/wgt/secret/proj' } },
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const event = mockRecord.mock.calls[0][0];
    expect(event.success).toBe(false);
    expect(event.error_category).toBe('TOOL_ERROR');
    // 反假绿：整个 event 序列化不得含原始路径片段（防 extractErrorMessage/safeErrorCategory 回退）
    expect(JSON.stringify(event)).not.toMatch(/home|wgt|secret|tscn|Main/i);
  });

  // final review fix: {success:false} JSON 无 isError:true 时口径对齐 healthSample
  // （旧实现仅判 isError!==true 会把这种结果记为 success=true，遥测虚高）
  it('flags failure when result is {success:false} JSON without isError (aligns with healthSample)', async () => {
    const falseSuccessResult: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'something failed' }) }],
      // 注意：无 isError: true —— 仅靠 checkJsonSuccessFalse 识别
    };
    mockGetModuleForTool.mockReturnValue({ handleTool: vi.fn().mockResolvedValue(falseSuccessResult) });

    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({ params: { name: 'scene', arguments: { project_path: '/p' } } });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const event = mockRecord.mock.calls[0][0];
    expect(event.success).toBe(false);
    expect(event.error_category).toBe('TOOL_ERROR');
  });

  // typeof 守卫：project_path 缺失（skipProjectPath=true 跳过注入）→ project_hash undefined
  it('omits project_hash when project_path is not present', async () => {
    mockSkipProjectPath.mockReturnValue(true);

    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({ params: { name: 'scene', arguments: {} } });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const event = mockRecord.mock.calls[0][0];
    expect(event.project_hash).toBeUndefined();
    expect(mockHashProject).not.toHaveBeenCalled();
  });

  // T2: opt-out（isTelemetryEnabled=false）时 after-hook 第一行守卫早 return，
  // 阻断 recordTelemetry 参数求值 → hashProject 不被调 → getInstallUUID 不触发
  // （config.ts:28 首次 mint 会创建 ~/.godot/mcp/telemetry-uuid.txt，违反 docs/telemetry.md
  // 「零副作用」承诺）。根因 [[feature-gate-inside-callee-defeated-by-arg-eval]]：
  // 守卫必须在调用方参数求值前（after-hook 第一行），非 callee（record）内部——
  // 否则 hashProject(ctx.args.project_path) 在 record() 入口前已求值，副作用已落盘。
  it('T2: opt-out（isTelemetryEnabled=false）时 after-hook 不触发 hashProject/record（堵 telemetry-uuid.txt 创建）', async () => {
    mockIsTelemetryEnabled.mockReturnValue(false);

    const { ToolDispatcher } = await import('../../src/core/ToolDispatcher.js');
    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/opt/out/proj' } },
    });

    // 守卫在 recordTelemetry 参数求值前——hashProject 不应被调（参数表达式未求值）。
    expect(mockHashProject, 'opt-out 时 hashProject 不应被调用（守卫须在参数求值前）').not.toHaveBeenCalled();
    // 整个 after-hook 早 return，record 也不应被调。
    expect(mockRecord, 'opt-out 时 record 不应被调用').not.toHaveBeenCalled();
  });
});
