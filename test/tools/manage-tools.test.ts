import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool-registry — use vi.hoisted() so mock functions are available when vi.mock factory runs
const { mockSetActiveGroups, mockGetActiveGroups, mockGetGroupForTool } = vi.hoisted(() => ({
  mockSetActiveGroups: vi.fn(),
  mockGetActiveGroups: vi.fn(),
  mockGetGroupForTool: vi.fn(),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  TOOL_GROUPS: {
    core: { description: '核心工具', tools: ['project', 'scene'], requires: [], protected: true },
    animation: { description: '动画', tools: ['animation'], requires: [] },
    bridge: { description: 'Bridge', tools: ['game'], requires: ['bridge'] },
  },
  setActiveGroups: mockSetActiveGroups,
  getActiveGroups: mockGetActiveGroups,
  getGroupForTool: mockGetGroupForTool,
  notifyToolsChanged: vi.fn(),
  LEGACY_TOOL_MAP: {
    node_create_3d: { tool: 'scene', action: 'create_3d_node' },
  },
  // P3-4 (2026-09-11): list_groups 价格标签消费的两导出(mock 下返回空定义即可,
  // profilePriceTags 容忍空数组;PROFILES 给最小两键)
  PROFILES: {
    full: ['core', 'animation', 'bridge'],
    minimal: ['core'],
  },
  getAllToolDefinitions: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/tools/shared.js', () => ({
  opsSuccess: (data: unknown) => ({ success: true, data, warnings: [] }),
  opsError: (code: string, msg: string) => ({
    success: false,
    error: msg,
    error_code: code,
    warnings: [],
  }),
  opsErrorResult: (code: string, msg: string) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error: msg, error_code: code }),
      },
    ],
    isError: true,
  }),
}));
vi.mock('../../src/core/path-utils.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
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
vi.mock('../../src/core/guard.js', () => ({
  requiresConfirmation: vi.fn().mockReturnValue(false),
}));

import { handleTool, getToolDefinitions, setConnectionStatusProvider, setReconnectEditor, buildConnectionStatus, buildReconnectEditor } from '../../src/tools/manage-tools.js';

describe('manage_tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveGroups.mockReturnValue(new Set(['core', 'animation', 'bridge']));
    setConnectionStatusProvider(null);
    setReconnectEditor(null);
  });

  it('getToolDefinitions returns single tool with action enum', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('manage_tools');
    const schema = defs[0].inputSchema as Record<string, unknown>;
    expect(schema.properties).toHaveProperty('action');
  });

  it('list_groups returns all groups with status', async () => {
    const result = await handleTool('manage_tools', { action: 'list_groups' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(data.data.groups).toBeDefined();
    expect(data.data.groups.length).toBeGreaterThan(0);
    const coreGroup = data.data.groups.find((g: any) => g.name === 'core');
    expect(coreGroup).toBeDefined();
    expect(coreGroup.protected).toBe(true);
  });

  it('activate adds groups to active set', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'activate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(mockSetActiveGroups).toHaveBeenCalled();
  });

  it('deactivate rejects protected groups', async () => {
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['core'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('protected');
  });

  it('deactivate removes non-protected groups', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
  });

  it('reconnect 无 provider → editor=null + bridge no-op 说明', async () => {
    const result = await handleTool('manage_tools', { action: 'reconnect' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(data.data.editor).toBeNull();
    expect(data.data.bridge.detail).toContain('无需重连');
  });

  it('reconnect 注入 reconnectEditor → 返回其结果', async () => {
    setReconnectEditor(async () => ({ connected: true, detail: '手动重连完成' }));
    const result = await handleTool('manage_tools', { action: 'reconnect' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.data.editor).toEqual({ reconnected: true, detail: '手动重连完成' });
  });

  it('sync 无 provider → status 为 unknown', async () => {
    const result = await handleTool('manage_tools', { action: 'sync' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    const bridgeGroup = data.data.groups.find((g: any) => g.name === 'bridge');
    expect(bridgeGroup.status).toContain('unknown');
  });

  it('sync 注入 provider → requires 映射状态', async () => {
    setConnectionStatusProvider(() => ({
      editor: { installed: true, connected: true, state: 'connected' },
      bridge: { note: '每请求建连' },
    }));
    const result = await handleTool('manage_tools', { action: 'sync' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    // mock TOOL_GROUPS 含 core(requires [])/animation([])/bridge(['bridge'])
    const byName = Object.fromEntries(data.data.groups.map((g: any) => [g.name, g]));
    expect(byName.core.status).toBe('n/a');        // requires []
    expect(byName.animation.status).toBe('n/a');   // requires []
    expect(byName.bridge.status).toBe('probe-required'); // requires ['bridge']
    expect(data.data.editor.connected).toBe(true);
  });
});

describe('buildConnectionStatus / buildReconnectEditor 工厂', () => {
  it('buildConnectionStatus 映射 editorConn + healthMonitor', () => {
    const ec = { isConnected: () => true } as any;
    const hm = { getState: () => 'connected' } as any;
    const cs = buildConnectionStatus(ec, hm);
    expect(cs.editor).toEqual({ installed: true, connected: true, state: 'connected' });
    expect(cs.bridge.note).toBeTruthy();

    const cs2 = buildConnectionStatus(null, null);
    expect(cs2.editor).toEqual({ installed: false, connected: false, state: null });
  });

  it('buildConnectionStatus: editor 未连 + healthMonitor connected → state=disconnected [M5 防回归]', () => {
    // M5: editor 未连时 state 不应报 healthMonitor 的 connected(工具健康 ≠ editor 连接)。
    // 原 bug: state=healthMonitor.getState()='connected' 但 connected=false,运行时观察到误导。
    const ec = { isConnected: () => false } as any;
    const hm = { getState: () => 'connected' } as any;
    const cs = buildConnectionStatus(ec, hm);
    expect(cs.editor).toEqual({ installed: true, connected: false, state: 'disconnected' });
  });

  it('buildReconnectEditor: 已连接 → 不调 connect', async () => {
    const ec = { isConnected: () => true, connect: vi.fn() };
    const fn = buildReconnectEditor(() => ec as any);
    const r = await fn();
    expect(ec.connect).not.toHaveBeenCalled();
    expect(r).toEqual({ connected: true, detail: '已连接' });
  });

  it('buildReconnectEditor: 未连接 → 调 connect', async () => {
    // M6: 用变量替代改对象方法(原 ec.isConnected = () => true 闭包改方法,fragile)
    let connected = false;
    const ec = { isConnected: () => connected, connect: vi.fn(async () => { connected = true; }) };
    const fn = buildReconnectEditor(() => ec as any);
    const r = await fn();
    expect(ec.connect).toHaveBeenCalled();
    expect(r.connected).toBe(true);
  });

  it('buildReconnectEditor: 无 editorConn → 中性提示(含 launch_editor,不断言"未安装")', async () => {
    // 审查 IMPORTANT-3: ec=null 可能是"从未安装"或"曾连接后降级到 headless"。buildReconnectEditor 无法区分,
    // 故 detail 不应错误断言"未安装"(降级时 editor 可能已装),需中性表述 + 恢复指引。
    const fn = buildReconnectEditor(() => null);
    const r = await fn();
    expect(r.connected).toBe(false);
    expect(r.detail).not.toContain('未安装');
    expect(r.detail).toContain('launch_editor');
  });

  it('buildReconnectEditor: 方案B ec=null + rebuild → 调 rebuild 重建连接', async () => {
    // 方案B: editor 降级后 editorConn=null,manage_tools reconnect 应能重建而非报"未连接"。
    // rebuild 由 GodotServer 注入(重新读 secret + new EditorConnection + connect + 接线)。
    const rebuild = vi.fn(async () => ({ connected: true, detail: 'editor 连接已重建' }));
    const fn = buildReconnectEditor(() => null, rebuild);
    const r = await fn();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ connected: true, detail: 'editor 连接已重建' });
  });

  it('buildReconnectEditor: 方案B rebuild 抛错 → 返回失败(不崩)', async () => {
    const rebuild = vi.fn(async () => { throw new Error('secret expired'); });
    const fn = buildReconnectEditor(() => null, rebuild);
    const r = await fn();
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('重建失败');
  });

  it('buildReconnectEditor: connect 抛错 → 调 requestReconnect 启动后台重连(防一次性失败卡死) [C-RECONNECT-1]', async () => {
    // 反馈 reconnecting 卡死: 耗尽/编辑器暂未 ready 时 connect 一次性失败,旧逻辑直接返回失败无后续重试,
    // 用户须反复手动调或重启 claude。修复: catch 时调 requestReconnect 启动后台重连循环,编辑器恢复自动连。
    const ec = {
      isConnected: () => false,
      connect: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      requestReconnect: vi.fn(),
    };
    const fn = buildReconnectEditor(() => ec as any);
    const r = await fn();
    expect(ec.connect).toHaveBeenCalledOnce();
    expect(ec.requestReconnect).toHaveBeenCalledOnce();
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('后台');
  });

  it('buildReconnectEditor: connect 抛错 + ec 无 requestReconnect(向后兼容) → 不崩,仅返回失败', async () => {
    // EditorConnLike.requestReconnect 可选(向后兼容:旧 ec 实现/无此方法的 mock 不调)
    const ec = {
      isConnected: () => false,
      connect: vi.fn(async () => { throw new Error('fail'); }),
    };
    const fn = buildReconnectEditor(() => ec as any);
    const r = await fn();
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('重连失败');
  });
});
