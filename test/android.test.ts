import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExec, mockExists, readFileSyncMock, mockDetectVersion } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExists: vi.fn(() => true),
  readFileSyncMock: vi.fn(() => ''),
  mockDetectVersion: vi.fn(async () => '4.6.2.stable'),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExec };  // 保留 execFile/spawn 等(helpers.ts:57 用 execFile),只覆盖 execFileSync(adb)
});
vi.mock('fs', () => ({
  existsSync: mockExists,
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(), copyFileSync: vi.fn(), unlinkSync: vi.fn(),
  chmodSync: vi.fn(), statSync: vi.fn(() => ({ size: 1000 }) as any), lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
  renameSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));
vi.mock('../src/tools/spawn-helper.js', () => ({ spawnGodot: vi.fn() }));
// W5 批2 迁移后 buildSafeEnv 与 detectGodotVersion 同住 godot-finder——
// importOriginal 部分覆盖(仅 stub detectGodotVersion),防其余导出(buildSafeEnv 等)变 undefined。
vi.mock('../src/core/godot-finder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/godot-finder.js')>();
  return { ...actual, detectGodotVersion: mockDetectVersion };
});
vi.mock('../src/dashboard/launcher.js', () => ({ launchDashboardOnce: vi.fn() }));

import { handleTool } from '../src/tools/android.js';
import { spawnGodot } from '../src/tools/spawn-helper.js';

describe('android list_devices', () => {
  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); });

  it('list_devices 解析 adb devices -l 输出', async () => {
    mockExec.mockReturnValue('List of devices attached\nR58M123 device usb:3-1 product:foo model:Pixel_5\nemulator-5554 device product:sdk\n');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'list_devices', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.devices.length).toBe(2);
    expect(parsed.devices[0].serial).toBe('R58M123');
    expect(parsed.devices[0].state).toBe('device');
    expect(parsed.devices[1].product).toBe('sdk');
  });

  it('list_devices 无设备 → NO_DEVICES', async () => {
    mockExec.mockReturnValue('List of devices attached\n');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'list_devices', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('NO_DEVICES');
  });

  it('adb 不存在(ENOENT) → ADB_NOT_FOUND', async () => {
    const err: any = new Error('adb not found');
    err.code = 'ENOENT';
    mockExec.mockImplementation(() => { throw err; });
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'list_devices', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('ADB_NOT_FOUND');
  });
});

describe('android get_preset_info (INI 解析)', () => {
  const CFG = `[preset.0]
name="Windows Desktop"
platform="Windows Desktop"
[preset.1]
name="Android"
platform="Android"
runnable=true
export_path="res://export/android.apk"
[preset.1.options]
package/name="com.example.game"
custom_template/debug=""
`;
  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); });

  it('按 platform=Android 找到 preset', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'get_preset_info', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.name).toBe('Android');
    expect(parsed.platform).toBe('Android');
    expect(parsed.package_name).toBe('com.example.game');
    expect(parsed.export_path).toBe('res://export/android.apk');
  });

  it('preset_name 精确匹配 + 非 Android preset 报 NO_ANDROID_PRESET', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'get_preset_info', project_path: '/fake/p', preset_name: 'Windows Desktop' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('NO_ANDROID_PRESET');
  });

  it('无 export_presets.cfg → NO_ANDROID_PRESET', async () => {
    mockExists.mockReturnValue(false);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'get_preset_info', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('NO_ANDROID_PRESET');
  });
});

describe('android deploy', () => {
  const CFG = `[preset.1]\nname="Android"\nplatform="Android"\nrunnable=true\nexport_path="res://build/android.apk"\n[preset.1.options]\npackage/name="com.example.game"\n`;

  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); });

  it('package 含 shell 元字符(com.x;rm) → 拒绝 launch(LAUNCH_FAILED)', async () => {
    readFileSyncMock.mockReturnValue(CFG.replace('com.example.game', 'com.x;rm -rf /tmp'));
    vi.mocked(spawnGodot).mockResolvedValue({ stdout: '', stderr: '', output: '', exitCode: 0, timedOut: false });
    mockExec.mockReturnValue('Success');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'deploy', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('LAUNCH_FAILED');
    expect(parsed.error).toContain('package');
  });

  it('deviceSerial 含元字符 → 拒绝(INSTALL_FAILED)', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'deploy', project_path: '/fake/p', device_serial: 'a;rm' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('INSTALL_FAILED');
  });

  it('export 失败(exit≠0) → EXPORT_FAILED', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    vi.mocked(spawnGodot).mockResolvedValue({ stdout: '', stderr: 'template missing', output: '', exitCode: 1, timedOut: false });
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'deploy', project_path: '/fake/p', launch: false }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('EXPORT_FAILED');
    expect(spawnGodot).toHaveBeenCalledWith(expect.anything(), expect.any(Array), expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it('deploy debug=false → --export-release(release 签名导出)', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    vi.mocked(spawnGodot).mockResolvedValue({ stdout: '', stderr: '', output: '', exitCode: 0, timedOut: false });
    mockExec.mockReturnValue('Success');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    await handleTool('android', { action: 'deploy', project_path: '/fake/p', debug: false, launch: false }, ctx as any);
    expect(spawnGodot).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['--export-release']), expect.anything());
  });
  it('deploy debug=true(默认) → --export-debug + preset.name 传 spawnGodot(项2)', async () => {
    readFileSyncMock.mockReturnValue(CFG);
    vi.mocked(spawnGodot).mockResolvedValue({ stdout: '', stderr: '', output: '', exitCode: 0, timedOut: false });
    mockExec.mockReturnValue('Success');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    await handleTool('android', { action: 'deploy', project_path: '/fake/p', launch: false }, ctx as any);
    expect(spawnGodot).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['--export-debug', 'Android']), expect.anything());
  });
});

describe('android check_template', () => {
  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); mockDetectVersion.mockResolvedValue('4.6.2.stable'); });

  it('模板齐全 → status=ok + major_minor=4.6', async () => {
    mockExists.mockReturnValue(true);  // android_debug.apk + android_release.apk 都在
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'check_template', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.status).toBe('ok');
    expect(parsed.major_minor).toBe('4.6');
    expect(parsed.godot_version).toBe('4.6.2.stable');
    expect(parsed.android_debug.exists).toBe(true);
    expect(parsed.android_release.exists).toBe(true);
  });

  it('模板缺失 → TEMPLATE_MISSING + suggestion', async () => {
    mockExists.mockReturnValue(false);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'check_template', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('TEMPLATE_MISSING');
    expect(parsed.suggestion).toBeTruthy();
  });

  it('版本检测失败 → VERSION_DETECT_FAILED', async () => {
    mockDetectVersion.mockRejectedValue(new Error('godot --version failed: exit 1'));
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'check_template', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('VERSION_DETECT_FAILED');
  });
});

describe('android logcat', () => {
  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); });

  it('logcat dump 最近 N 行(默认 100)', async () => {
    mockExec.mockReturnValue('E/GDScript: error1\nE/GDScript: error2\n');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'logcat', project_path: '/fake/p' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.output).toContain('error1');
    expect(mockExec).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['logcat', '-d', '-t', '100']), expect.anything());
  });

  it('filter 透传', async () => {
    mockExec.mockReturnValue('');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    await handleTool('android', { action: 'logcat', project_path: '/fake/p', filter: '*:E' }, ctx as any);
    expect(mockExec).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['*:E']), expect.anything());
  });

  it('device_serial 校验失败 → LOGCAT_FAILED', async () => {
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'logcat', project_path: '/fake/p', device_serial: 'a;rm' }, ctx as any);
    const parsed = JSON.parse(result!.content[0].text);
    expect(parsed.error_code).toBe('LOGCAT_FAILED');
  });
});

describe('android R3-fix 项1+6', () => {
  beforeEach(() => { vi.clearAllMocks(); mockExists.mockReturnValue(true); });

  it('项1: export_presets.cfg >1MB 拒绝解析(防 OOM)', async () => {
    const fs = await import('fs');
    vi.mocked(fs.statSync).mockReturnValue({ size: 2_000_000 } as any);
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'get_preset_info', project_path: '/fake/p' }, ctx as any);
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toMatch(/too large|1MB/i);
  });

  it('项6: INI 畸形(无 = / 垃圾行)不崩', async () => {
    readFileSyncMock.mockReturnValue('[preset.0]\ngarbage no equals\n;;comment\nname="Android"\nplatform="Android"\n');
    const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };
    const result = await handleTool('android', { action: 'get_preset_info', project_path: '/fake/p' }, ctx as any);
    expect(result).toBeDefined();  // 不抛未捕获异常
  });
});
