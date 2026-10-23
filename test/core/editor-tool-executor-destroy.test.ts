// L-12(2026-10-22 审查第二轮): EditorToolExecutor.destroy 必须注销
// scene_tree_changed 通知——sync 中途销毁时旧 handler 残留,新 executor 再注册即双重消费。
import { describe, it, expect, vi } from 'vitest';
import { EditorToolExecutor } from '../../src/core/EditorToolExecutor.js';

function makeConn() {
  return {
    addOnDisconnectHandler: vi.fn(),
    removeOnDisconnectHandler: vi.fn(),
    addOnReconnectHandler: vi.fn(),
    removeOnReconnectHandler: vi.fn(),
    onNotification: vi.fn(),
    offNotification: vi.fn(),
    request: vi.fn(),
  };
}

describe('L-12 destroy 注销 scene_tree_changed 通知', () => {
  it('destroy 调 offNotification("scene_tree_changed", handleTreeChange)', () => {
    const conn = makeConn();
    const executor = new EditorToolExecutor(conn as never);
    executor.destroy();
    expect(conn.removeOnDisconnectHandler).toHaveBeenCalledTimes(1);
    expect(conn.removeOnReconnectHandler).toHaveBeenCalledTimes(1);
    expect(conn.offNotification).toHaveBeenCalledTimes(1);
    const [method, handler] = conn.offNotification.mock.calls[0]!;
    expect(method).toBe('scene_tree_changed');
    expect(typeof handler).toBe('function');
  });

  it('destroy 幂等可重入(offNotification 未注册时 EditorConnection 侧早退,此处仅锁定调用语义)', () => {
    const conn = makeConn();
    const executor = new EditorToolExecutor(conn as never);
    executor.destroy();
    executor.destroy();
    expect(conn.offNotification).toHaveBeenCalledTimes(2);
  });
});
