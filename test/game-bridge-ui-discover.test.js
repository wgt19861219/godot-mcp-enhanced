import { describe, it, expect, beforeEach, vi } from 'vitest';

// 反馈 2026-11-07 (Task A1): click_button 顶层/params 双形态兼容测试。
// mock bridge-client 的 sendToBridge——默认抛 BridgeNotConnectedError,与真实"bridge 未连接"
// 行为一致(下方既有 "bridge is unavailable" 用例路径不变);A1 新用例在自己的 beforeEach
// 覆盖为 mockResolvedValue 以断言转发给 bridge 的 params。
const bridgeMock = vi.hoisted(() => ({
  sendToBridge: vi.fn(),
}));

vi.mock('../src/core/bridge-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendToBridge: bridgeMock.sendToBridge,
  };
});

import { getToolDefinitions, handleTool, resetBridgeState } from '../src/tools/game-bridge.js';
import { BridgeNotConnectedError } from '../src/core/bridge-client.js';

beforeEach(() => {
  // 默认:bridge 未连接(既有用例语义);A1 用例的 beforeEach 会覆盖为成功响应。
  bridgeMock.sendToBridge.mockReset();
  bridgeMock.sendToBridge.mockRejectedValue(new BridgeNotConnectedError('Bridge not connected'));
});

describe('game-bridge UI discovery', () => {
  beforeEach(() => {
    resetBridgeState();
  });

  describe('tool registration', () => {
    it('should register find_ui_elements and click_button in ACTIONS', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const actions = gameTool.inputSchema.properties.action.enum;
      expect(actions).toContain('find_ui_elements');
      expect(actions).toContain('click_button');
    });

    it('should include UI-related properties in inputSchema', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const props = gameTool.inputSchema.properties;
      expect(props.pattern).toBeDefined();
      expect(props.type).toBeDefined();
      expect(props.visible_only).toBeDefined();
      expect(props.limit).toBeDefined();
      expect(props.text).toBeDefined();
      expect(props.path).toBeDefined();
    });
  });

  // Imp-13 (2026-06-24 审查): 删除假测试——find_ui_elements/click_button response schema(自构造 response 断言其字段)
  // 和 UI type extraction(自构造 types 字典断言),均不调产品代码、恒真零保护。保留 tool registration + handler。

  describe('handler', () => {
    it('should reject click_button without text or path', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test',
        action: 'click_button',
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('text');
    });

    it('should handle find_ui_elements when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-ui',
        action: 'find_ui_elements',
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);  // 739: catch 兜底设 isError(原 textResult 缺)
      expect(result.content[0].text).toContain('error_code');  // 结构化 opsErrorResult(非 textResult)
    });

    it('should handle click_button when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-ui',
        action: 'click_button',
        text: 'Start',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });
  });
});

// ─── 反馈 2026-11-07 (Task A1): click_button 顶层/params 双形态兼容 ────────────
// game_query/write/input 均为 params{} 透传惯例,唯 click_button 是顶层 text/path——调用方
// 塞 params 必被拒。兼容取值:顶层 args 优先,读不到回落 args.params.*;报错回显实际收到的键集。
describe('click_button 顶层/params 双形态兼容 (Task A1)', () => {
  beforeEach(() => {
    bridgeMock.sendToBridge.mockReset();
    bridgeMock.sendToBridge.mockResolvedValue({ id: 1, result: { clicked: true } });
  });

  it('params 形态单传 text:不再 INVALID_PARAMS,转发 params 含 text', async () => {
    const result = await handleTool('game', {
      action: 'click_button',
      params: { text: '进入游戏' },
    }, { projectDir: '/tmp/a1-click', opsScript: '' });
    expect(result).toBeDefined();
    expect(result.isError ?? false).toBe(false);
    expect(bridgeMock.sendToBridge).toHaveBeenCalledTimes(1);
    expect(bridgeMock.sendToBridge.mock.calls[0][1]).toMatchObject({
      text: '进入游戏',
      path: '',
      real_event: false,
    });
  });

  it('params 形态单传 path:转发 params 含 path', async () => {
    const result = await handleTool('game', {
      action: 'click_button',
      params: { path: '/root/Menu/StartBtn' },
    }, { projectDir: '/tmp/a1-click', opsScript: '' });
    expect(result).toBeDefined();
    expect(result.isError ?? false).toBe(false);
    expect(bridgeMock.sendToBridge).toHaveBeenCalledTimes(1);
    expect(bridgeMock.sendToBridge.mock.calls[0][1]).toMatchObject({
      text: '',
      path: '/root/Menu/StartBtn',
    });
  });

  it('顶层与 params 同传:顶层优先,params 补缺', async () => {
    await handleTool('game', {
      action: 'click_button',
      text: '顶层文本',
      params: { text: '嵌套文本', path: '/root/Menu/Btn', real_event: true },
    }, { projectDir: '/tmp/a1-click', opsScript: '' });
    expect(bridgeMock.sendToBridge).toHaveBeenCalledTimes(1);
    expect(bridgeMock.sendToBridge.mock.calls[0][1]).toMatchObject({
      text: '顶层文本',        // 顶层优先
      path: '/root/Menu/Btn', // 顶层缺失 → params 回落
      real_event: true,       // 顶层缺失 → params 回落
    });
  });

  it('无 text/path 时报错回显实际收到的键集 + 双形态 tip', async () => {
    const result = await handleTool('game', {
      action: 'click_button',
      params: { real_event: true }, // "塞错位置"形态:键全在 params
    }, { projectDir: '/tmp/a1-click', opsScript: '' });
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('received keys');
    expect(text).toContain('action');
    expect(text).toContain('params'); // 区分"没传"与"塞错位置"
    expect(text).toContain('params 内均可'); // 双形态 tip
    expect(bridgeMock.sendToBridge).not.toHaveBeenCalled();
  });
});
