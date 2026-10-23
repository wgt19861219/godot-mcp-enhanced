// L-6/L-7(2026-10-22 审查第二轮)game-bridge 行为锁定:
// - L-6: game_input/click_button 注入输入改变运行态,TOOL_META 风险必须为 write
// - L-7: ensureProjectDir 显式 args.project_path 优先于 ctx.projectDir
// 轻量 mock(仅 bridge-client + args-validation),不走重量级 socket mock 文件
// (game-bridge.test.ts 因 Linux issue #15 被 CI --exclude,本文件保持纯 mock 可跑)。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  setBridgeProjectDir: vi.fn(),
  getBridgeProjectDir: vi.fn(() => null),
  sendToBridge: vi.fn(),
}));

vi.mock('../src/core/bridge-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/bridge-client.js')>();
  return {
    ...actual,
    setBridgeProjectDir: bridgeMock.setBridgeProjectDir,
    getBridgeProjectDir: bridgeMock.getBridgeProjectDir,
    sendToBridge: bridgeMock.sendToBridge,
  };
});
vi.mock('../src/core/args-validation.js', () => ({
  requireProjectPath: vi.fn(({ project_path }: { project_path: string }) => {
    if (!project_path.startsWith('/allowed')) {
      throw new Error(`project_path not in whitelist: ${project_path}`);
    }
    return project_path;
  }),
  requireNumber: vi.fn(),
  requireString: vi.fn(),
}));

import { TOOL_META, handleTool } from '../src/tools/game-bridge.js';

describe('L-6 game_input/click_button 风险提级 write', () => {
  it('TOOL_META.game.actionRisks 中两者均为 write(注入输入改变运行态)', () => {
    expect(TOOL_META.game.actionRisks!.game_input).toBe('write');
    expect(TOOL_META.game.actionRisks!.click_button).toBe('write');
    // 只读对照不受牵连
    expect(TOOL_META.game.actionRisks!.game_query).toBe('read');
    expect(TOOL_META.game.actionRisks!.find_ui_elements).toBe('read');
  });
});

describe('L-7 ensureProjectDir 显式 project_path 优先', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMock.getBridgeProjectDir.mockReturnValue(null);
    bridgeMock.sendToBridge.mockResolvedValue({ id: 1, result: {} });
  });

  it('ctx.projectDir 与显式 args.project_path 并存时,显式参数胜出', async () => {
    await handleTool('game', {
      action: 'game_query', method: 'ping', project_path: '/allowed/explicit',
    }, { projectDir: '/ctx/project' } as never);
    expect(bridgeMock.setBridgeProjectDir).toHaveBeenCalledWith('/allowed/explicit');
    expect(bridgeMock.setBridgeProjectDir).not.toHaveBeenCalledWith('/ctx/project');
  });

  it('无显式参数时回退 ctx.projectDir(行为不变)', async () => {
    await handleTool('game', {
      action: 'game_query', method: 'ping',
    }, { projectDir: '/ctx/project' } as never);
    expect(bridgeMock.setBridgeProjectDir).toHaveBeenCalledWith('/ctx/project');
  });

  it('显式路径非法(白名单外)时抛错而非静默打到别的项目', async () => {
    const result = await handleTool('game', {
      action: 'game_query', method: 'ping', project_path: 'D:/evil/outside',
    }, { projectDir: '/ctx/project' } as never);
    // 外层 catch 转错误 ToolResult;setBridgeProjectDir 不应收到 ctx 回退
    const text = JSON.stringify(result ?? {});
    expect(text).toContain('whitelist');
    expect(bridgeMock.setBridgeProjectDir).not.toHaveBeenCalledWith('/ctx/project');
  });
});
