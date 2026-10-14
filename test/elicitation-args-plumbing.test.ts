// R1-core 端到端回归(2026-10-14 全维度审查): elicitation 补参必须到达工具 handler。
// 根因: middleware.ts 把用户补填值写入 ctx.args 浅拷贝副本,而 ToolDispatcher.handleCall
// 的 executeToolCall 闭包捕获 pre-middleware 的原始 args 对象——补参永远到不了执行。
// 判别断言: 调 workflow 缺 action,elicit 填 action='scene_snapshot':
//   修复后 → action 到达 handler,走到 scene_snapshot 的 scene_path 校验
//            (错误文本含 'scene_path is required');
//   修复前 → action 到不了 handler,停在 dispatcher 的 validateArgs 层
//            (错误文本含 "action: required 字段缺失")。
// 同时保留装配源码断言(HB-e 先例): executeToolCall 消费 ctx.args 而非闭包 args。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { ToolDispatcher } from '../src/core/ToolDispatcher.js';
import type { ReadOnlyGuard } from '../src/core/ReadOnlyGuard.js';
import { setElicitServer, resetElicitServer } from '../src/core/elicit.js';
import { registerAllModules } from '../src/module-loader.js';
import type { HandlerResult } from '../src/types.js';

// dispatchTool 走 getModuleForTool 注册表——先注册全部工具模块
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

function resultText(r: HandlerResult): string {
  return (r.content ?? []).map(c => ('text' in c ? c.text : '')).join('\n');
}

describe('R1-core: elicitation 补参经 ctx.args 到达工具 handler', () => {
  afterEach(() => {
    resetElicitServer();
  });

  it('elicit 填入的 action 到达 handler(非停留在 validateArgs)', async () => {
    // mock elicit server: 声明 elicitation 能力,表单回填 action=scene_snapshot
    setElicitServer({
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: 'accept', content: { action: 'scene_snapshot' } }),
    } as never);

    const dispatcher = makeDispatcher();
    // 缺 action;project_path 传 cwd(cwd-fallback 白名单天然放行)
    const r = await dispatcher.handleCall({
      params: { name: 'workflow', arguments: { project_path: process.cwd() } },
    });
    const text = resultText(r);
    // 修复后: action='scene_snapshot' 到达 handler,卡在 scene_path 校验
    expect(text).toContain('scene_path');
    // 修复前错误形态不得出现(action 到不了 handler 的判别)
    expect(text).not.toContain('required 字段缺失');
  });

  it('装配源码断言: executeToolCall 消费 ctx.args(防回退到闭包原始 args)', () => {
    const src = readFileSync('src/core/ToolDispatcher.ts', 'utf8');
    expect(src).toContain('this.executeToolCall(name, ctx.args, startTime');
    // 旧的闭包捕获形态(直接传外层 args)不得回归
    expect(src).not.toMatch(/executeToolCall\(name, args, startTime/);
  });
});
