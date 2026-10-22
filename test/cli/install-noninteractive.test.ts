import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// H-4 (2026-10-22 审查第二轮): install 非交互退出码。
// 修复前:非 TTY 下 confirmYesNo 静默 return false → InternalError('install cancelled by
// user') → index.ts 把 /cancelled by user/ 映射 exitCode=0——CI/管道执行 install 不下载、
// 不安装、提示"已取消"却退出码 0,自动化误判成功。修复:非 TTY 且无 --yes → exit 2 +
// --yes 指引(对齐 uninstall.ts 先例);--yes 跳过确认直接安装。
// installGodot 与 runInstall 同文件无法 doMock,改断言全局 fetch 未被发起(installGodot
// 一进来就查版本/下载,未执行即零网络副作用)。

describe('H-4 install 非交互退出码（2026-10-22 审查第二轮）', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('非 TTY 且无 --yes:exit 2 且不发起下载', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;  // vitest worker 的 stdin 无 isTTY 属性,直接赋值(项目惯例)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { runInstall } = await import('../../src/cli/godot-installer.js');
      await runInstall([]);
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(fetchSpy).not.toHaveBeenCalled();  // 不发起版本查询/下载
      expect(errSpy.mock.calls.flat().join('\n')).toContain('--yes');  // 给出指引
    } finally {
      process.stdin.isTTY = origIsTTY;
    }
  });

  it('非 TTY 且无 --yes:带版本 tag 参数同样 exit 2(不为 tag 消费放行)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { runInstall } = await import('../../src/cli/godot-installer.js');
      await runInstall(['4.7.2-stable']);
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = origIsTTY;
    }
  });
});
