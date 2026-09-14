// test/core/godot-server-oninitialized.test.ts — D 批（v0.30）Roots 退役后的 oninitialized 契约
//
// MCP Roots 动态授权已随 2026-07-28 规范废弃退役（原 godot-server-roots.test.ts 的
// 8 个注入/热更新/回退用例随功能删除）。oninitialized 回调保留——它承载与 Roots
// 无关的 logger/progress client-ready 信号。本文件锁定：
// 1. oninitialized 仍被赋值且可调用（legacy 客户端握手链路）
// 2. 负向契约：src/GodotServer.ts 不再引用任何 Roots API（防回潮）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@modelcontextprotocol/server', () => {
  return {
    Server: class {
      oninitialized: (() => void) | null = null;
      setRequestHandler() {}
      async connect() {}
      async close() {}
      async start() {}
    },
  };
});

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: mockExistsSync };
});

const { mockWaitForEditorSecret } = vi.hoisted(() => ({
  mockWaitForEditorSecret: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/core/editor-auth.js', () => ({
  waitForEditorSecret: (...args: unknown[]) => mockWaitForEditorSecret(...args),
}));

vi.mock('../../src/core/EditorConnection.js', () => ({
  EditorConnection: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('no editor')),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../../src/core/EditorToolExecutor.js', () => ({
  EditorToolExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    destroy: vi.fn(),
  })),
}));

// Task 3/设计 §7 I-4: importOriginal 部分覆盖——仅 stub 测试需要的函数,
// 新导出(killAllRunSessions 等)透传真实模块,根治补导出漂移。
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
    killProcess: vi.fn().mockResolvedValue(undefined),
    getSpawnedGodotPids: vi.fn().mockReturnValue([]),
    killPidTree: vi.fn(),
    unregisterSpawnedGodotPid: vi.fn(),
  };
});

import { readFileSync } from 'node:fs';
import { GodotServer } from '../../src/GodotServer.js';

describe('GodotServer oninitialized（D 批 Roots 退役后）', () => {
  let server: GodotServer;

  beforeEach(() => {
    server = new GodotServer('fake.gd', { connectionMode: 'headless' });
  });

  afterEach(async () => {
    await server.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it('oninitialized 已赋值且可调用（legacy 客户端握手 → logger/progress client-ready）', () => {
    const mockServer = (server as unknown as { server: { oninitialized: (() => void) | null } }).server;
    expect(typeof mockServer.oninitialized).toBe('function');
    expect(() => mockServer.oninitialized!()).not.toThrow();
  });

  it('负向：GodotServer 源码不再引用 Roots API（listRoots/setAllowedRootsFromClient/list_changed）', () => {
    const src = readFileSync('src/GodotServer.ts', 'utf8');
    expect(src).not.toMatch(/listRoots/);
    expect(src).not.toMatch(/setAllowedRootsFromClient/);
    expect(src).not.toMatch(/roots\/list_changed/);
  });
});
