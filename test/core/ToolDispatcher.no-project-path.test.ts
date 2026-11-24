// test/core/ToolDispatcher.no-project-path.test.ts
//
// 反馈批 20261122 Task 1 终审 triage-1:dispatcher 级回归。
//
// 此前钉住「help/debug/engine 不再被注入 project_path」的只有两层单元证据——名单成员断言
// (test/core/get-context-registration.test.ts)与「名单外工具必须在 inputSchema 声明
// project_path」的注册表不变量(test/core/project-path-injection-invariant.test.ts),没有一条
// 用例真的经过 dispatcher 的注入点(src/core/ToolDispatcher.ts executeToolCall 的
// 「0.5. Default project_path injection」)与紧随其后的 schema 校验。本文件让这三个工具真的
// 走过那条链,钉住原始症状「参数校验失败: 未知参数: project_path」不再出现。
//
// 形态(对齐 test/elicitation-args-plumbing.test.ts):注册表与 dispatcher 用真身,只接管默认
// 项目解析 resolveProjectPath——两行上下文各跑一遍,对应名单失效后的两种失败形态:
//   - 无可解析项目:注入点解析不到项目,直接回「project_path is required …」;
//   - 有可解析项目:注入键落到 args 上,被未知参数检查拒掉(反馈 11-18 的原始形态)。
// 只取三者的只读 action(risk=read):audit middleware 对 read 风险直接返回,不落审计行;
// debug/engine 在 headless 模式由 handler 回 EDITOR_ONLY——「到达 handler」的判别标志。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolDispatcher } from '../../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import type { HandlerResult } from '../../src/types.js';
import { registerAllModules } from '../../src/module-loader.js';
import { resolveProjectPath } from '../../src/core/path-utils.js';

// 只接管默认项目解析(两行上下文可控),其余导出透传真身
vi.mock('../../src/core/path-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/path-utils.js')>();
  return { ...actual, resolveProjectPath: vi.fn<() => string | undefined>() };
});

// dispatchTool 走 getModuleForTool 注册表(含 help/debug/engine 三个模块)——先注册全部工具模块
registerAllModules();

function makeDispatcher(): ToolDispatcher {
  return new ToolDispatcher({
    readOnly: false,
    mode: 'full',
    connectionMode: 'headless',
    noFallback: false,
    readOnlyGuard: { check: () => ({ blocked: false }) } as unknown as ReadOnlyGuard,
    opsScript: '',
    findGodot: async () => 'godot',
    toolCallDelegate: () => {},
  });
}

/** 全部 text 块按序拼接(HandlerResult 是 CallToolResult | InputRequiredResult 联合,先窄化)。 */
function resultText(r: HandlerResult): string {
  if (!('content' in r) || !Array.isArray(r.content)) return '';
  return r.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

// 只传各自 schema 必填(required)的参数;reached = 请求到达 handler 的判别标志
const CASES = [
  { tool: 'help', args: { tool_name: 'help' }, reached: /^# help\b/ },
  { tool: 'debug', args: { action: 'list_breakpoints' }, reached: /EDITOR_ONLY/ },
  { tool: 'engine', args: { action: 'search', query: 'Node' }, reached: /EDITOR_ONLY/ },
] as const;

describe.each<[string, string | undefined]>([
  ['无可解析项目', undefined],
  ['有可解析项目', process.cwd()],
])('project_path 免注入(反馈 2026-11-18)· 上下文:%s', (_label, resolved) => {
  beforeEach(() => {
    vi.mocked(resolveProjectPath).mockReturnValue(resolved);
  });

  it.each(CASES)('$tool 只传 schema 必填参数 → 不以 project_path 被拒', async ({ tool, args, reached }) => {
    const r = await makeDispatcher().handleCall({ params: { name: tool, arguments: { ...args } } });
    const text = resultText(r);
    expect(text).not.toContain('project_path');
    expect(text).toMatch(reached);
  });
});
