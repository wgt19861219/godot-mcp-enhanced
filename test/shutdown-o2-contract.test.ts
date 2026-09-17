/**
 * Task 2.2(2026-09-17 架构审查 H-3 / O2 归位)契约级锁定:
 * setOnBridgeConnected(() => launchDashboardOnce()) 从 game-bridge 模块顶层副作用
 * 迁入 GodotServer.run() 控制面装配 —— close() 可对称清理(置 null),装配-清理
 * 逐项配对不变量不再被模块顶层副作用绕开。
 *
 * 行为级断言(spy run() 装配 / close() 置 null)见 test/godot-server.test.js;
 * 本文件锁"import 游戏工具模块不得自带控制面装配"的源码结构 —— import 副作用
 * 在 spy 装上之前发生,运行时不可观察,契约测试是唯一可靠断言层(先例:
 * test/bridge-feedback-batch-c-contract.test.ts)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gameBridge = readFileSync('src/tools/game-bridge.ts', 'utf8');
const godotServer = readFileSync('src/GodotServer.ts', 'utf8');

describe('Task 2.2 (H-3/O2): setOnBridgeConnected 归位控制面装配', () => {
  it('game-bridge.ts 模块顶层不再自装配 Dashboard 回调(O2:工具模块无控制面副作用)', () => {
    expect(gameBridge.includes('setOnBridgeConnected(() => launchDashboardOnce());')).toBe(false);
  });

  it('GodotServer.run() 装配区含 setOnBridgeConnected 装配行', () => {
    expect(godotServer.includes('setOnBridgeConnected(() => launchDashboardOnce())')).toBe(true);
  });

  it('GodotServer.close() 对称置 null(装配-清理配对)', () => {
    expect(godotServer.includes('setOnBridgeConnected(null)')).toBe(true);
  });
});
