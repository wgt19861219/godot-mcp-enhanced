import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWeb } from '../../src/cli/web.js';

// L-2(2026-10-22 审查第二轮):--port 非法值此前静默转 0(随机端口),用户指定被吞。
// 校验位于任何 IO(findGodot/confirm)之前,exit spy 即可拦截,无外部副作用。
describe('runWeb --port 严格校验(L-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['abc', '0', '65536', '999999999'])('非法值 %s → exit 2 且错误信息含原值', async (bad) => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT_CALLED');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runWeb(['--port', String(bad)])).rejects.toThrow('EXIT_CALLED');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join('\n')).toContain(String(bad));
  });

  it('合法端口放行——流程继续走到 serve-only 目录检测(报 index.html 缺失而非 port 错)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'web-port-ok-'));
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('EXIT_CALLED');
      }) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(runWeb(['--serve-only', emptyDir, '--port=8080'])).rejects.toThrow('EXIT_CALLED');
      // exit(2) 来自 index.html 缺失分支,port 校验已放行
      expect(errSpy.mock.calls.flat().join('\n')).toContain('index.html');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
