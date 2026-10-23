// L-23(2026-10-22 审查第二轮): defaultOpener 普通 tab 模式改 execFile 参数数组——
// 原 exec 拼接 shell 字符串(`start "" "<url>"` 形态),审计关注点;URL 含 token,
// 参数数组形态不经 shell,即使 token 格式校验被绕过也无拼接注入面。
// mock child_process.execFile 捕获调用形态,三平台轮测(Object.defineProperty
// 切 platform,测后恢复——vitest 单文件顺序执行,无并发泄漏)。
import { describe, it, expect, afterEach, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn((...allArgs: unknown[]) => {
  // 签名随调用形状变化((cmd,args,cb) 或 (cmd,args,opts,cb))——末参为 callback
  const cb = allArgs[allArgs.length - 1];
  if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  execFileMock.mockClear();
  vi.restoreAllMocks();
});

describe('defaultOpener execFile 参数数组（L-23）', () => {
  it('win32: cmd /c start "" <url>(start 是 cmd 内建,不经 shell 拼接)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { defaultOpener } = await import('../../src/web-gui/open.js');
    defaultOpener('http://127.0.0.1:9550/#token=abcd-1234');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', 'http://127.0.0.1:9550/#token=abcd-1234']);
  });

  it('darwin: open <url> 参数数组', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { defaultOpener } = await import('../../src/web-gui/open.js');
    defaultOpener('http://127.0.0.1:9550/#token=abcd-1234');
    const [cmd, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('open');
    expect(args).toEqual(['http://127.0.0.1:9550/#token=abcd-1234']);
  });

  it('linux: xdg-open <url> 参数数组', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { defaultOpener } = await import('../../src/web-gui/open.js');
    defaultOpener('http://127.0.0.1:9550/#token=abcd-1234');
    const [cmd, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('xdg-open');
    expect(args).toEqual(['http://127.0.0.1:9550/#token=abcd-1234']);
  });

  it('appWindow=true 且探测到浏览器: --app=<url> 参数数组(app 模式先例,不受本改动影响)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { defaultOpener } = await import('../../src/web-gui/open.js');
    const finder = await import('../../src/web-gui/app-window.js');
    vi.spyOn(finder, 'findAppBrowserPath').mockReturnValue('C:/Program Files/Edge/msedge.exe');
    defaultOpener('http://127.0.0.1:9550/#token=abcd-1234', true);
    const [cmd, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('C:/Program Files/Edge/msedge.exe');
    expect(args).toEqual(['--app=http://127.0.0.1:9550/#token=abcd-1234']);
  });
});
