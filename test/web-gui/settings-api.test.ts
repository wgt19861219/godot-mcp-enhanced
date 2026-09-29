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
    process.env.ALLOWED_PROJECT_PATHS = 'D:\\p1;D:\\p2';
    const v = await svc().get();
    expect(v.persisted).toEqual({ godotPath: '', allowedProjectPaths: [] });
    expect(v.effective.godotPath).toBe('D:/env/godot.exe');
    expect(v.effective.allowedProjectPaths).toEqual(['D:\\p1', 'D:\\p2']);
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

  // ── save:校验 ──────────────────────────────────────────────────────────────
  it('save:空 patch → empty-patch', async () => {
    expect(await svc().save({})).toMatchObject({ ok: false, stage: 'empty-patch' });
  });

  it('save:godotPath 相对路径 → not-absolute(不调二进制校验)', async () => {
    const r = await svc().save({ godotPath: 'relative/godot.exe' });
    expect(r).toMatchObject({ ok: false, stage: 'not-absolute' });
    expect(validateGodotBinaryDetailed).not.toHaveBeenCalled();
  });

  it('save:godotPath 二进制校验失败 → stage 透传 + 失败审计行', async () => {
    vi.mocked(validateGodotBinaryDetailed).mockResolvedValue({ ok: false, stage: 'path-not-allowed' });
    const r = await svc().save({ godotPath: 'D:/evil.exe' });
    expect(r).toMatchObject({ ok: false, stage: 'path-not-allowed' });
    expect(h.auditLines.length).toBe(1);
    expect(h.auditLines[0]).toMatchObject({ ok: false, action: 'settings_save', caller: 'web-gui:settings' });
  });

  it('save:allowedProjectPaths 相对路径/不存在/非目录逐一拒绝', async () => {
    await mkdir(join(dir, 'adir'), { recursive: true });
    await writeFile(join(dir, 'afile.txt'), 'x', 'utf8');
    expect(await svc().save({ allowedProjectPaths: ['relative/path'] })).toMatchObject({ ok: false, stage: 'not-absolute' });
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'missing')] })).toMatchObject({ ok: false, stage: 'not-found' });
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'afile.txt')] })).toMatchObject({ ok: false, stage: 'not-a-directory' });
    expect(await svc().save({ allowedProjectPaths: [join(dir, 'adir')] })).toMatchObject({ ok: true });
  });

  // ── save:成功路径 + merge + 热生效 + 审计 ──────────────────────────────────
  it('save:成功 → 写盘 + env 热生效 + 成功审计行', async () => {
    await mkdir(join(dir, 'proj1'), { recursive: true });
    const r = await svc().save({ godotPath: 'D:/godot/g.exe', allowedProjectPaths: [join(dir, 'proj1')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.persisted.godotPath).toBe('D:/godot/g.exe');
    expect(await readUserSettings(dir)).toEqual({ version: 1, godotPath: 'D:/godot/g.exe', allowedProjectPaths: [join(dir, 'proj1')] });
    expect(process.env.GODOT_PATH).toBe('D:/godot/g.exe');
    expect(process.env.ALLOWED_PROJECT_PATHS).toBe(join(dir, 'proj1'));
    expect(h.auditLines.length).toBe(1);
    expect(h.auditLines[0]).toMatchObject({ ok: true, action: 'settings_save', project_path: getUserSettingsFile(dir) });
    expect(h.auditLines[0]!.changed_files).toEqual([getUserSettingsFile(dir)]);
  });

  it('save:merge 语义——单字段 patch 不清另一字段', async () => {
    await mkdir(join(dir, 'proj2'), { recursive: true });
    await svc().save({ godotPath: 'D:/godot/g.exe' });
    const r = await svc().save({ allowedProjectPaths: [join(dir, 'proj2')] });
    expect(r.ok).toBe(true);
    expect(await readUserSettings(dir)).toEqual({ version: 1, godotPath: 'D:/godot/g.exe', allowedProjectPaths: [join(dir, 'proj2')] });
  });

  it('save:清除语义——godotPath 空串删字段并恢复启动快照 env', async () => {
    process.env.GODOT_PATH = 'D:/injected.exe';
    resetUserSettingsSnapshotForTest();
    await svc().save({ godotPath: 'D:/gui.exe' });
    expect(process.env.GODOT_PATH).toBe('D:/gui.exe');
    const r = await svc().save({ godotPath: '' });
    expect(r.ok).toBe(true);
    expect(await readUserSettings(dir)).toEqual({ version: 1 });
    expect(process.env.GODOT_PATH).toBe('D:/injected.exe');
  });
});
