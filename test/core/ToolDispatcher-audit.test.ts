// test/core/ToolDispatcher-audit.test.ts
// C-2/C-3 (2026-08-14): audit after middleware + _auditConfirmedExecution 的 dispatcher 级集成测试。
// 此前 2157 行 ToolDispatcher.test.ts grep "audit" = 0 —— 审计系统自己零审计,重构
// middleware/confirm 路径时"真实执行绕过审计"会静默回归(after hook 抛错被 executeMiddleware
// 静默 catch,更无感知)。本文件走真实 audit-log.ts 落盘(临时目录),只 mock 外围依赖。
//
// 覆盖 5 场景:
// ① write 工具成功执行 → mcp_audit.jsonl 落盘含 {tool, action, risk}
// ② confirm_and_execute 确认后执行 → _auditConfirmedExecution 落盘(details.confirmed=true)
// ③ 令牌请求/拒绝路径 → 无虚假 ok 条目落盘
// ④ appendFile 失败 → 工具结果不受影响(best-effort 不阻断)
// ⑤ 动态工具(engine_call_method)写操作 → 落盘含 resolveDynamicTool 反查出的真实 (tool, action, risk)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Tool } from '@modelcontextprotocol/server';
import type { DispatcherOptions } from '../../src/core/ToolDispatcher.js';
import { ToolDispatcher } from '../../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { ToolResult } from '../../src/types.js';
import { resolveProjectPath as _mockResolveProjectPath } from '../../src/core/path-utils.js';
import * as ps from '../../src/core/process-state.js';
import { skipProjectPath as _mockSkipProjectPath } from '../../src/core/tool-registry.js';
import { getLogger } from '../../src/core/logger.js';
import { AUDIT_LOG_REL, type AuditEntry } from '../../src/core/audit-log.js';
import type { Mock } from 'vitest';

// ─── Hoisted Mocks(对齐 ToolDispatcher.test.ts 范式) ──────────────────────────

const {
  mockGetActionRisk,
  mockGetModuleForTool,
  mockGetAllToolDefinitions,
  mockGetToolDefinition,
  mockIsToolAllowed,
  mockIsDynamicToolName,
  mockRequiresConfirmation,
  mockConsumeToken,
  mockPeekToken,
  mockCreatePendingToken,
  mockValidateGodotBinary,
  mockValidateGodotBinaryDetailed,
} = vi.hoisted(() => ({
  // C-2 关键:audit middleware 调 getActionRisk(toolName, action) 判定 risk;
  // 现有 ToolDispatcher.test.ts 的 tool-registry mock 缺此导出 → after 抛
  // "getActionRisk is not a function" 被 executeMiddleware 静默吞(零审计零暴露的根因之一)。
  mockGetActionRisk: vi.fn().mockReturnValue(undefined),
  mockGetModuleForTool: vi.fn().mockReturnValue(undefined),
  mockGetAllToolDefinitions: vi.fn().mockReturnValue([] as Tool[]),
  mockGetToolDefinition: vi.fn().mockReturnValue(undefined),
  mockIsToolAllowed: vi.fn().mockReturnValue(true),
  mockIsDynamicToolName: vi.fn().mockReturnValue(false),
  mockRequiresConfirmation: vi.fn().mockReturnValue(false),
  mockConsumeToken: vi.fn(),
  mockPeekToken: vi.fn(),
  mockCreatePendingToken: vi.fn().mockReturnValue('tok-test'),
  mockValidateGodotBinary: vi.fn().mockResolvedValue(true),
  mockValidateGodotBinaryDetailed: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  getAllToolDefinitions: mockGetAllToolDefinitions,
  getModuleForTool: mockGetModuleForTool,
  getToolDefinition: mockGetToolDefinition,
  getActionRisk: mockGetActionRisk,
  isToolAllowed: mockIsToolAllowed,
  isDynamicToolName: mockIsDynamicToolName,
  registerInlineTool: vi.fn(),
  LITE_TOOLS: new Set<string>(),
  MINIMAL_TOOLS: new Set<string>(),
  setActiveGroups: vi.fn(),
  resolveProfile: vi.fn().mockReturnValue(new Set<string>()),
  // confirm_and_execute 属 NO_PROJECT_PATH_TOOLS(只需 token);其余工具测试都显式传 project_path
  skipProjectPath: vi.fn().mockImplementation((name: string) => name === 'confirm_and_execute'),
  tryLegacyMapping: vi.fn().mockReturnValue(null),
}));

// dynamic-risk-map.js 不 mock —— 场景⑤验证 resolveDynamicTool 真实反查
// (engine_call_method → { tool: 'engine', action: 'call_method' })

vi.mock('../../src/core/guard.js', () => ({
  requiresConfirmation: mockRequiresConfirmation,
  createPendingToken: mockCreatePendingToken,
  consumeToken: mockConsumeToken,
  peekToken: mockPeekToken,
  TOKEN_TTL_MS: 120_000,
}));

vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
  parseGodotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/core/path-utils.js', () => ({
  resolveProjectPath: vi.fn().mockReturnValue('/default/project'),
  _resetProjectPathCache: vi.fn(),
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

// fs/promises 部分 mock:appendFile/mkdir 包一层 vi.fn(默认透传真实实现,真实落盘到临时目录),
// 场景④可按需 mockRejectedValueOnce。audit-log.ts 的 import { appendFile } 会被解析到此 mock。
// 注意:工厂必须 async + await importOriginal —— importOriginal() 返回 Promise,同步展开
// 会得到 Promise 对象(所有方法 undefined),appendAuditLine 静默 no-op。
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    appendFile: vi.fn(actual.appendFile),
    mkdir: vi.fn(actual.mkdir),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const moduleHandleTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', success: true }) }],
} satisfies ToolResult);

/** getModuleForTool 默认返回可控 mock 模块(dispatchTool 调 handleTool) */
function stubModuleFor(tools: string[]): void {
  mockGetModuleForTool.mockImplementation((name: string) =>
    tools.includes(name)
      ? { handleTool: moduleHandleTool, getToolDefinitions: vi.fn().mockReturnValue([]) }
      : undefined,
  );
}

/** 读临时项目的 audit jsonl,解析为 entry 数组 */
function readAuditEntries(projectPath: string): (AuditEntry & { details?: { confirmed?: boolean } })[] {
  const auditPath = join(projectPath, ...AUDIT_LOG_REL);
  expect(existsSync(auditPath), `audit 文件应存在: ${auditPath}`).toBe(true);
  return readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry & { details?: { confirmed?: boolean } });
}

/** write_script 的 getActionRisk stub(risk='write',audit middleware 非跳过) */
function stubWriteScriptRisk(): void {
  mockGetActionRisk.mockImplementation((tool: string, action: string) =>
    tool === 'script' && action === 'write_script' ? 'write' : undefined,
  );
}

let tmpProject: string;

beforeEach(() => {
  vi.clearAllMocks();
  // isAuditEnabled 默认开:显式清 env,防宿主环境残留 GODOT_MCP_AUDIT=false 关掉审计
  delete process.env.GODOT_MCP_AUDIT;
  delete process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM;
  mockGetAllToolDefinitions.mockReturnValue([]);
  mockRequiresConfirmation.mockReturnValue(false);
  mockIsDynamicToolName.mockReturnValue(false);
  mockGetActionRisk.mockReturnValue(undefined);
  stubModuleFor(['script', 'engine_call_method']);
  moduleHandleTool.mockResolvedValue({
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', success: true }) }],
  });
  (_mockResolveProjectPath as unknown as Mock).mockReturnValue('/default/project');
  tmpProject = mkdtempSync(join(tmpdir(), 'dispatcher-audit-'));
});

afterEach(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

// ─── 场景①:write 工具成功 → 落盘 ─────────────────────────────────────────────

describe('ToolDispatcher audit middleware 集成', () => {
  it('场景①: write 工具成功执行 → .godot/mcp_audit.jsonl 落盘含 {tool, action, risk}', async () => {
    stubWriteScriptRisk();
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: {
        name: 'script',
        arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://a.gd' },
      },
    });

    // 工具结果成功
    expect(res.isError).not.toBe(true);
    expect(String(res.content?.[0]?.text)).toContain('"ok"');

    // 落盘断言
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.tool).toBe('script');
    expect(e.action).toBe('write_script');
    expect(e.risk).toBe('write');
    expect(e.ok).toBe(true);
    expect(e.project_path).toBe(tmpProject);
    expect(e.changed_files).toContain('res://a.gd'); // inferChangedFiles 从 script_path 推断
    expect(typeof e.trace_id).toBe('string');
    expect(typeof e.duration_ms).toBe('number');
    expect(e.caller).toBe('mcp'); // 批4-T4: caller 归一——匿名 MCP 调用恒 'mcp'(不再缺省)
  });

  it('场景①b: read 风险 action 不落盘(audit 只记 write/destructive/process)', async () => {
    mockGetActionRisk.mockImplementation((tool: string, action: string) =>
      tool === 'script' && action === 'read_script' ? 'read' : undefined,
    );
    const dispatcher = new ToolDispatcher(createOptions());

    await dispatcher.handleCall({
      params: { name: 'script', arguments: { action: 'read_script', project_path: tmpProject } },
    });

    expect(existsSync(join(tmpProject, ...AUDIT_LOG_REL))).toBe(false);
  });

  // ── 场景②:confirm_and_execute → _auditConfirmedExecution 落盘 ──

  it('场景②: confirm_and_execute 确认后执行 → _auditConfirmedExecution 落盘(details.confirmed=true)', async () => {
    stubWriteScriptRisk();
    // unsafe-confirm 降级路径:第一轮直接 consumeToken + 执行(绕 MRTR 轮次,代码路径最短)
    process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM = 'true';
    mockConsumeToken.mockReturnValue({
      toolName: 'script',
      args: { action: 'write_script', project_path: tmpProject, script_path: 'res://b.gd' },
    });
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: { name: 'confirm_and_execute', arguments: { token: 'tok-1' } },
    });

    expect(res.isError).not.toBe(true);

    // 补审计路径落盘:tool/action 来自 pending(原始工具),details.confirmed=true 是该路径独有标记
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.tool).toBe('script'); // 非 'confirm_and_execute'
    expect(e.action).toBe('write_script');
    expect(e.risk).toBe('write');
    expect(e.details?.confirmed).toBe(true);
    // 外层 confirm_and_execute 的 ctx.action='' 不会额外产生一条(middleware 路径 risk=undefined 跳过)
  });

  it('场景②c: MRTR 第二轮确认(inputResponses confirm=true)→ 同样经补审计落盘', async () => {
    stubWriteScriptRisk();
    // 第一轮 peekToken(返 pending + inputRequired),第二轮 consumeToken(执行)
    const pendingArgs = { action: 'write_script', project_path: tmpProject, script_path: 'res://mrtr.gd' };
    mockPeekToken.mockReturnValue({ toolName: 'script', args: pendingArgs });
    mockConsumeToken.mockReturnValue({ toolName: 'script', args: pendingArgs });
    const dispatcher = new ToolDispatcher(createOptions());

    // 第一轮:无 inputResponses → 返 inputRequired(elicitation 协议控制流,不执行)
    await dispatcher.handleCall({ params: { name: 'confirm_and_execute', arguments: { token: 'tok-m' } } });
    expect(existsSync(join(tmpProject, ...AUDIT_LOG_REL))).toBe(false); // 第一轮不执行不落盘

    // 第二轮:用户确认 → consumeToken + _confirmExecute + :410 补审计调用点
    const res = await dispatcher.handleCall(
      { params: { name: 'confirm_and_execute', arguments: { token: 'tok-m' } } },
      { mcpReq: { inputResponses: { confirm: { action: 'accept' as const, content: { confirm: true } } } } } as never,
    );

    expect(res.isError).not.toBe(true);
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    expect(entries[0]!.tool).toBe('script');
    expect(entries[0]!.action).toBe('write_script');
    expect(entries[0]!.details?.confirmed).toBe(true);
  });

  // ── 场景③:令牌请求/拒绝路径无虚假 ok 条目 ──

  it('场景③a: 令牌请求响应(requires_confirmation)不落盘虚假 ok 条目', async () => {
    stubWriteScriptRisk();
    mockRequiresConfirmation.mockReturnValue(true); // write_script 被确认门拦下,返 token
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: {
        name: 'script',
        arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://c.gd' },
      },
    });

    // 返回令牌请求形态
    expect(String(res.content?.[0]?.text)).toContain('"requires_confirmation":true');
    // B-1 修复断言:操作未执行,不得记虚假 ok=true 条目
    expect(existsSync(join(tmpProject, ...AUDIT_LOG_REL))).toBe(false);
  });

  it('场景③b: 用户 decline 确认(ELICITATION_DENIED)不落盘', async () => {
    stubWriteScriptRisk();
    mockPeekToken.mockReturnValue({
      toolName: 'script',
      args: { action: 'write_script', project_path: tmpProject },
    });
    mockConsumeToken.mockReturnValue({
      toolName: 'script',
      args: { action: 'write_script', project_path: tmpProject },
    });
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall(
      {
        params: { name: 'confirm_and_execute', arguments: { token: 'tok-2' } },
      },
      // accept 但 confirm=false → acceptedContent 返 {confirm:false} → ELICITATION_DENIED
      // (对齐 ToolDispatcher.test.ts:582 的 srvCtx 形状)
      { mcpReq: { inputResponses: { confirm: { action: 'accept' as const, content: { confirm: false } } } } } as never,
    );

    expect(String(res.content?.[0]?.text)).toContain('ELICITATION_DENIED');
    expect(existsSync(join(tmpProject, ...AUDIT_LOG_REL))).toBe(false);
  });

  // ── 场景④:appendFile 失败不阻断 ──

  it('场景④: appendFile 抛错(EACCES 类) → 工具结果不受影响(best-effort)', async () => {
    stubWriteScriptRisk();
    const { appendFile } = await import('fs/promises');
    (appendFile as unknown as Mock).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: {
        name: 'script',
        arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://d.gd' },
      },
    });

    // 审计落盘失败:工具结果仍成功,不抛异常、不变 error
    expect(res.isError).not.toBe(true);
    expect(String(res.content?.[0]?.text)).toContain('"ok"');
    expect(existsSync(join(tmpProject, ...AUDIT_LOG_REL))).toBe(false);
  });

  // ── 场景⑤(C-3):动态工具通道审计 ──

  it('场景⑤: 动态工具(engine_call_method)写操作 → 落盘含 resolveDynamicTool 反查的真实 (tool, action, risk)', async () => {
    // engine_call_method 是动态注册的平铺名;真实 resolveDynamicTool 反查 → engine.call_method
    mockIsDynamicToolName.mockImplementation((n: string) => n === 'engine_call_method');
    mockGetActionRisk.mockImplementation((tool: string, action: string) =>
      tool === 'engine' && action === 'call_method' ? 'write' : undefined,
    );
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: {
        name: 'engine_call_method',
        arguments: { project_path: tmpProject, node_path: 'root/Player', method: 'take_damage', args: [10] },
      },
    });

    expect(res.isError).not.toBe(true);

    // C-3 修复断言:middleware 用解析后的 (engine, call_method) 查 risk 并落盘,
    // 而非平铺名(平铺名 getActionRisk 恒 undefined → 修复前静默跳过零落盘)
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.tool).toBe('engine'); // 解析后的静态工具名
    expect(e.action).toBe('call_method'); // 解析后的静态 action
    expect(e.risk).toBe('write');
    expect(e.ok).toBe(true);
  });

  it('场景⑤b: 动态工具经 confirm_and_execute 确认执行 → _auditConfirmedExecution 同样反查落盘', async () => {
    mockIsDynamicToolName.mockImplementation((n: string) => n === 'engine_call_method');
    mockGetActionRisk.mockImplementation((tool: string, action: string) =>
      tool === 'engine' && action === 'call_method' ? 'write' : undefined,
    );
    process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM = 'true';
    mockConsumeToken.mockReturnValue({
      toolName: 'engine_call_method',
      args: { project_path: tmpProject, node_path: 'root/Player', method: 'take_damage' },
    });
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: { name: 'confirm_and_execute', arguments: { token: 'tok-3' } },
    });

    expect(res.isError).not.toBe(true);
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    // C-3 修复断言:确认补审计路径同样反查动态名
    expect(e.tool).toBe('engine');
    expect(e.action).toBe('call_method');
    expect(e.risk).toBe('write');
    expect(e.details?.confirmed).toBe(true);
  });

  // ── 场景⑥(I-2,设计 §6): args.project_path 缺失 → audit 落活跃桶而非 env 项目 ──

  it('场景⑥: args.project_path 缺失(注入豁免)→ audit projectPath 取活跃桶,非 env 项目', async () => {
    // runtime.stop_project risk='process'(runtime 域无参操作的审计归属即本修复的目标场景)
    mockGetActionRisk.mockImplementation((tool: string, action: string) =>
      tool === 'runtime' && action === 'stop_project' ? 'process' : undefined,
    );
    stubModuleFor(['runtime']);
    // 注入豁免:让 :312 的默认 project_path 注入跳过,ctx.args.project_path 保持缺失
    (_mockSkipProjectPath as unknown as Mock).mockImplementation((n: string) => n === 'runtime');
    // env 项目指向独立临时目录(修复前会落这里;也防失败形态写盘根垃圾路径)
    const envTmp = mkdtempSync(join(tmpdir(), 'dispatcher-audit-env-'));
    (_mockResolveProjectPath as unknown as Mock).mockReturnValue(envTmp);
    // 活跃桶指向 tmpProject(经 process-state mock)
    (ps.getProjectDir as unknown as Mock).mockReturnValue(tmpProject);
    try {
      const dispatcher = new ToolDispatcher(createOptions());
      const res = await dispatcher.handleCall({
        params: { name: 'runtime', arguments: { action: 'stop_project' } },
      });
      expect(res.isError).not.toBe(true);

      // 落盘断言:活跃桶路径(tmpProject)有审计,env 项目(envTmp)无
      const entries = readAuditEntries(tmpProject);
      expect(entries.length).toBe(1);
      expect(entries[0]!.tool).toBe('runtime');
      expect(entries[0]!.action).toBe('stop_project');
      expect(entries[0]!.project_path).toBe(tmpProject);
      expect(existsSync(join(envTmp, ...AUDIT_LOG_REL))).toBe(false);
    } finally {
      rmSync(envTmp, { recursive: true, force: true });
      (_mockSkipProjectPath as unknown as Mock).mockImplementation((n: string) => n === 'confirm_and_execute');
      (ps.getProjectDir as unknown as Mock).mockReturnValue('');
    }
  });

  // ── 场景⑦(§4.6): dispatcher toolStart 接线传 project 归属 ──

  it('场景⑦: dispatchTool 的 toolStart 调用携带 project(§4.6 JSONL project 字段接线)', async () => {
    stubWriteScriptRisk();
    const startSpy = vi.spyOn(getLogger(), 'toolStart');
    try {
      const dispatcher = new ToolDispatcher(createOptions());
      await dispatcher.handleCall({
        params: {
          name: 'script',
          arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://proj.gd' },
        },
      });
      expect(startSpy).toHaveBeenCalledWith('script', expect.objectContaining({ project_path: tmpProject }), tmpProject);
    } finally {
      startSpy.mockRestore();
    }
  });

  // ── 场景⑧(批4-T3): 工具→审计上报通道(structuredContent._audit.before_values) ──

  it('场景⑧: 工具返回 _audit.before_values → 审计 details 落盘 + 返回结果剥离 _audit(批4-T3)', async () => {
    stubWriteScriptRisk();
    moduleHandleTool.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', success: true }) }],
      structuredContent: { status: 'ok', _audit: { before_values: { 'application/config/name': 'OldName' } } },
    } satisfies ToolResult);
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: {
        name: 'script',
        arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://a.gd' },
      },
    });

    // 返回客户端的结果已剥离 _audit(防成为半公共 API),其余字段保留
    expect(res.isError).not.toBe(true);
    const sc = (res as ToolResult).structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeDefined();
    expect(sc?._audit).toBeUndefined();
    expect(sc?.status).toBe('ok');

    // 审计落盘含 before_values(此前该字段零生产者,suggest_rollback 恢复分支死路径)
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    expect(entries[0]!.details?.before_values).toEqual({ 'application/config/name': 'OldName' });
  });

  it('场景⑧b: confirm 路径同样提取 before_values 且返回结果剥离(批4-T3)', async () => {
    stubWriteScriptRisk();
    process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM = 'true';
    mockConsumeToken.mockReturnValue({
      toolName: 'script',
      args: { action: 'write_script', project_path: tmpProject, script_path: 'res://t3.gd' },
    });
    moduleHandleTool.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', success: true }) }],
      structuredContent: { _audit: { before_values: { x: 1 } } },
    } satisfies ToolResult);
    const dispatcher = new ToolDispatcher(createOptions());

    const res = await dispatcher.handleCall({
      params: { name: 'confirm_and_execute', arguments: { token: 'tok-t3' } },
    });

    expect(res.isError).not.toBe(true);
    expect((res as ToolResult).structuredContent?._audit).toBeUndefined();
    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    expect(entries[0]!.details?.confirmed).toBe(true);
    expect(entries[0]!.details?.before_values).toEqual({ x: 1 });
  });

  // ── 场景⑨(批4-T4): caller 归因归一 ──

  it('场景⑨: _meta.agentId 注入 → caller=mcp:<agentId>(客户端支持时自动细粒度归因)', async () => {
    stubWriteScriptRisk();
    const dispatcher = new ToolDispatcher(createOptions());

    await dispatcher.handleCall({
      params: {
        name: 'script',
        arguments: { action: 'write_script', project_path: tmpProject, script_path: 'res://agent.gd' },
        _meta: { agentId: 'agent-42' },
      },
    });

    const entries = readAuditEntries(tmpProject);
    expect(entries.length).toBe(1);
    expect(entries[0]!.caller).toBe('mcp:agent-42');
  });
});
