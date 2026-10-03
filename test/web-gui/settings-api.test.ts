// test/web-gui/settings-api.test.ts
// SettingsApi 逻辑层(2026-09-29 设置批):get 视图 / verify stage 透传 / save 校验+merge+
// 热生效+机器级审计。mock godot-finder(validate/detect 不真 spawn;readGodotPathsConfig
// 不读真实机器配置)与 audit-log(审计行进内存可断言,不写真实 machine-audit.jsonl)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  auditLines: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/core/godot-finder.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/godot-finder.js')>();
  return {
    ...orig,
    readGodotPathsConfig: vi.fn(() => ['D:/cand/godot.exe']),
    validateGodotBinaryDetailed: vi.fn(async () => ({ ok: true }) as const),
    detectGodotVersion: vi.fn(async () => '4.7.1.stable'),
  };
});

vi.mock('../../src/core/audit-log.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/audit-log.js')>();
  return {
    ...orig,
    isAuditEnabled: vi.fn(() => true),
    appendMachineAuditLine: vi.fn(async (e: Record<string, unknown>) => { h.auditLines.push(e); }),
    recordAuditWriteFailure: vi.fn(),
  };
});

import { UserSettingsService } from '../../src/web-gui/settings-api.js';
import { readUserSettings, getUserSettingsFile, resetUserSettingsSnapshotForTest } from '../../src/core/user-settings.js';
import { validateGodotBinaryDetailed, detectGodotVersion } from '../../src/core/godot-finder.js';

const ENV_KEYS = ['GODOT_PATH', 'ALLOWED_PROJECT_PATHS', 'GODOT_MCP_UNRESTRICTED'] as const;

describe('UserSettingsService(逻辑层)', () => {
  let dir = '';
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settings-api-'));
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    resetUserSettingsSnapshotForTest();
    h.auditLines.length = 0;
    vi.mocked(validateGodotBinaryDetailed).mockClear();
    vi.mocked(validateGodotBinaryDetailed).mockResolvedValue({ ok: true });
    vi.mocked(detectGodotVersion).mockClear();
    vi.mocked(detectGodotVersion).mockResolvedValue('4.7.1.stable');
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetUserSettingsSnapshotForTest();
    await rm(dir, { recursive: true, force: true });
  });

  const svc = (opts?: { isReadOnly?: () => boolean }) => new UserSettingsService({ settingsDir: dir, ...opts });

  // ── get ────────────────────────────────────────────────────────────────────
  it('get:persisted(空容错)+ effective(env 现值)+ candidates(mock)+ readOnly 注入', async () => {
    process.env.GODOT_PATH = 'D:/env/godot.exe';
    // 平台无关化(2026-10-03 CI 修复):effective.allowedProjectPaths 经 resolvePath 归一,
    // 硬编码 Windows 路径在 Linux CI 上 resolve('D:\\p1')=cwd 相对拼接必红——改用 tmpdir 绝对路径。
    const p1 = join(dir, 'p1'); const p2 = join(dir, 'p2');
    process.env.ALLOWED_PROJECT_PATHS = `${p1};${p2}`;
    const v = await svc().get();
    expect(v.persisted).toEqual({ godotPath: '', allowedProjectPaths: [] });
    expect(v.effective.godotPath).toBe('D:/env/godot.exe');
    expect(v.effective.allowedProjectPaths).toEqual([p1, p2]);
    expect(v.effective.unrestricted).toBe(false);   // setup.js 全局设了 UNRESTRICTED,beforeEach 已删
    expect(v.candidates).toEqual(['D:/cand/godot.exe']);
    expect(v.readOnly).toBe(false);
    expect(await svc({ isReadOnly: () => true }).get()).toMatchObject({ readOnly: true });
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect((await svc().get()).effective.unrestricted).toBe(true);
  });

  // ── verify ─────────────────────────────────────────────────────────────────
  it('verify:空路径 bad-request;ok → 版本串', async () => {
    expect(await svc().verify('')).toMatchObject({ ok: false, stage: 'bad-request' });
    expect(await svc().verify('  ')).toMatchObject({ ok: false, stage: 'bad-request' });
    expect(await svc().verify('D:/godot/g.exe')).toEqual({ ok: true, version: '4.7.1.stable' });
  });

  it('verify:校验失败 stage 透传 + 人话 detail', async () => {
    vi.mocked(validateGodotBinaryDetailed).mockResolvedValue({ ok: false, stage: 'is-directory' });
    const r = await svc().verify('D:/some/dir');
    expect(r).toEqual({ ok: false, stage: 'is-directory', detail: '路径是目录,须指向 Godot 可执行文件' });
  });

  it('verify:validate ok 但版本串读取失败 → version-read-failed', async () => {
    vi.mocked(detectGodotVersion).mockRejectedValue(new Error('boom'));
    const r = await svc().verify('D:/godot/g.exe');
    expect(r).toMatchObject({ ok: false, stage: 'version-read-failed' });
  });

  // 2026-10-01 真机验证 NIT-2:cmd.exe 类非法二进制的 exec 行为非确定(间歇 exit 0 空输出
  // vs exit 1),godot-finder 可能落 version-run-failed 或 not-godot-signature——面板层
  // 归一为同一 stage/文案,同一输入不再漂移。
  it('verify/save:不稳定 stage(version-run-failed/not-godot-signature)归一为 not-a-godot-binary', async () => {
    // 平台无关化(2026-10-03):save 侧 isAbsolute 判定,'C:/...' 在 Linux 非绝对路径会被
    // not-absolute 拒(到不了 stage 归一分支)——改用 tmpdir 绝对路径。
    const fake = join(dir, 'cmd.exe');
    for (const raw of ['version-run-failed', 'not-godot-signature'] as const) {
      vi.mocked(validateGodotBinaryDetailed).mockResolvedValue({ ok: false, stage: raw });
      const v = await svc().verify(fake);
      expect(v).toEqual({
        ok: false,
        stage: 'not-a-godot-binary',
        detail: '无法验证为 Godot 可执行文件(路径不存在、不可执行或 --version 输出签名不符)',
      });
      const s = await svc().save({ godotPath: fake });
      expect(s).toMatchObject({ ok: false, stage: 'not-a-godot-binary' });
      expect((s as { error: string }).error).toContain('无法验证为 Godot 可执行文件');
    }
  });

  // ── save:校验 ──────────────────────────────────────────────────────────────
  it('save:空 patch → empty-patch', async () => {
    expect(await svc().save({})).toMatchObject({ ok: false, stage: 'empty-patch' });
  });

  it('save:godotPath 相对路径 → not-absolute(不调二进制校验,含留痕——二轮 Nit-B)', async () => {
    const r = await svc().save({ godotPath: 'relative/godot.exe' });
    expect(r).toMatchObject({ ok: false, stage: 'not-absolute' });
    expect(validateGodotBinaryDetailed).not.toHaveBeenCalled();
    expect(h.auditLines.length).toBe(1);
    expect(h.auditLines[0]).toMatchObject({ ok: false, action: 'settings_save', caller: 'web-gui:settings' });
  });

  it('save:godotPath 二进制校验失败 → stage 透传 + 失败审计行', async () => {
    vi.mocked(validateGodotBinaryDetailed).mockResolvedValue({ ok: false, stage: 'path-not-allowed' });
    const r = await svc().save({ godotPath: join(dir, 'evil.exe') });
    expect(r).toMatchObject({ ok: false, stage: 'path-not-allowed' });
    expect(h.auditLines.length).toBe(1);
    expect(h.auditLines[0]).toMatchObject({ ok: false, action: 'settings_save', caller: 'web-gui:settings' });
  });

  it('save:allowedProjectPaths 空条目/相对路径/不存在/非目录/含分号逐一拒绝 + 失败审计留痕(审查 Important-1 + 二轮 Nit-A)', async () => {
    await mkdir(join(dir, 'adir'), { recursive: true });
    await writeFile(join(dir, 'afile.txt'), 'x', 'utf8');
    // 空条目拒绝(二轮 Nit-A 补测:bad-entry 留痕行为锁定)
    expect(await svc().save({ allowedProjectPaths: ['  '] })).toMatchObject({ ok: false, stage: 'bad-entry' });
    expect(await svc().save({ allowedProjectPaths: ['relative/path'] })).toMatchObject({ ok: false, stage: 'not-absolute' });
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'missing')] })).toMatchObject({ ok: false, stage: 'not-found' });
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'afile.txt')] })).toMatchObject({ ok: false, stage: 'not-a-directory' });
    // 含分号条目拒绝(审查 Nit-3):env 分号分隔,含分号目录名保存后被 split 撕裂
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'a;b')] })).toMatchObject({ ok: false, stage: 'contains-semicolon' });
    // 全部校验失败分支均有机器级留痕(5 条拒绝 → 5 行 ok:false)
    expect(h.auditLines.length).toBe(5);
    for (const line of h.auditLines) expect(line).toMatchObject({ ok: false, action: 'settings_save', caller: 'web-gui:settings' });
    // 合法目录照常通过且不再新增失败审计
    const before = h.auditLines.length;
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'adir')] })).toMatchObject({ ok: true });
    expect(h.auditLines.length).toBe(before + 1);
    expect(h.auditLines[h.auditLines.length - 1]).toMatchObject({ ok: true });
  });

  // ── save:成功路径 + merge + 热生效 + 审计 ──────────────────────────────────
  it('save:成功 → 写盘 + env 热生效 + 成功审计行', async () => {
    await mkdir(join(dir, 'proj1'), { recursive: true });
    const gui = join(dir, 'g.exe');  // 平台无关(2026-10-03):save 的 isAbsolute 判定
    const r = await svc().save({ godotPath: gui, allowedProjectPaths: [join(dir, 'proj1')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.persisted.godotPath).toBe(gui);
    expect(await readUserSettings(dir)).toEqual({ version: 1, godotPath: gui, allowedProjectPaths: [join(dir, 'proj1')] });
    expect(process.env.GODOT_PATH).toBe(gui);
    expect(process.env.ALLOWED_PROJECT_PATHS).toBe(join(dir, 'proj1'));
    expect(h.auditLines.length).toBe(1);
    expect(h.auditLines[0]).toMatchObject({ ok: true, action: 'settings_save', project_path: getUserSettingsFile(dir) });
    expect(h.auditLines[0]!.changed_files).toEqual([getUserSettingsFile(dir)]);
  });

  it('save:merge 语义——单字段 patch 不清另一字段', async () => {
    await mkdir(join(dir, 'proj2'), { recursive: true });
    const gui = join(dir, 'g.exe');  // 平台无关(2026-10-03):同上 isAbsolute
    await svc().save({ godotPath: gui });
    const r = await svc().save({ allowedProjectPaths: [join(dir, 'proj2')] });
    expect(r.ok).toBe(true);
    expect(await readUserSettings(dir)).toEqual({ version: 1, godotPath: gui, allowedProjectPaths: [join(dir, 'proj2')] });
  });

  it('save:清除语义——godotPath 空串删字段并恢复启动快照 env', async () => {
    const injected = join(dir, 'injected.exe');
    const gui = join(dir, 'gui.exe');
    process.env.GODOT_PATH = injected;
    resetUserSettingsSnapshotForTest();
    await svc().save({ godotPath: gui });
    expect(process.env.GODOT_PATH).toBe(gui);
    const r = await svc().save({ godotPath: '' });
    expect(r.ok).toBe(true);
    expect(await readUserSettings(dir)).toEqual({ version: 1 });
    expect(process.env.GODOT_PATH).toBe(injected);
  });
});
