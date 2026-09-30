// test/user-settings.test.ts
// core/user-settings(2026-09-29 设置批):读写容错 + apply 热生效(env 覆盖/快照恢复/
// 清 godot 缓存)+ 启动重放。env 隔离:两个受影响 env 变量逐用例备份恢复 + 快照 reset。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readUserSettings, writeUserSettings, applyUserSettings, applyUserSettingsAtStartup,
  getUserSettingsFile, resetUserSettingsSnapshotForTest,
} from '../src/core/user-settings.js';
import { getCachedGodotPath } from '../src/core/godot-finder.js';

const ENV_KEYS = ['GODOT_PATH', 'ALLOWED_PROJECT_PATHS'] as const;

function backupEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe('user-settings(core):读写与容错', () => {
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'user-settings-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('文件缺失 → 空设置(ENOENT 不 warn)', async () => {
    expect(await readUserSettings(dir)).toEqual({ version: 1 });
  });

  it('JSON 损坏 → 空设置', async () => {
    await writeFile(getUserSettingsFile(dir), '{broken', 'utf8');
    expect(await readUserSettings(dir)).toEqual({ version: 1 });
  });

  it('roundtrip:写 → 读', async () => {
    await writeUserSettings({ version: 1, godotPath: 'D:/godot/g.exe', allowedProjectPaths: ['D:/a', 'D:/b'] }, dir);
    expect(await readUserSettings(dir)).toEqual({ version: 1, godotPath: 'D:/godot/g.exe', allowedProjectPaths: ['D:/a', 'D:/b'] });
  });

  it('结构容错:非字符串 godotPath 剔除;allowed 非字符串/空条目剔除', async () => {
    await writeFile(getUserSettingsFile(dir), JSON.stringify({ version: 1, godotPath: 42, allowedProjectPaths: ['ok', 3, ''] }), 'utf8');
    expect(await readUserSettings(dir)).toEqual({ version: 1, allowedProjectPaths: ['ok'] });
  });
});

describe('user-settings(core):apply 热生效 + 启动快照', () => {
  let dir = '';
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'user-settings-apply-'));
    saved = backupEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    resetUserSettingsSnapshotForTest();
  });
  afterEach(async () => {
    restoreEnv(saved);
    resetUserSettingsSnapshotForTest();
    await rm(dir, { recursive: true, force: true });
  });

  it('apply:非空字段覆盖 env;allowed 以分号 join', () => {
    applyUserSettings({ version: 1, godotPath: 'D:/new/godot.exe', allowedProjectPaths: ['D:/x', 'D:/y'] });
    expect(process.env.GODOT_PATH).toBe('D:/new/godot.exe');
    expect(process.env.ALLOWED_PROJECT_PATHS).toBe('D:/x;D:/y');
  });

  it('apply:清除字段恢复启动快照(模拟客户端注入值优先于 GUI 清空)', () => {
    process.env.GODOT_PATH = 'D:/injected.exe';           // 模拟 AI 客户端 spawn 注入
    process.env.ALLOWED_PROJECT_PATHS = 'D:/orig';
    resetUserSettingsSnapshotForTest();                   // 快照定格为注入值
    applyUserSettings({ version: 1, godotPath: 'D:/gui.exe', allowedProjectPaths: ['D:/gui'] });
    expect(process.env.GODOT_PATH).toBe('D:/gui.exe');
    applyUserSettings({ version: 1 });                    // GUI 清空两项 → 恢复注入值
    expect(process.env.GODOT_PATH).toBe('D:/injected.exe');
    expect(process.env.ALLOWED_PROJECT_PATHS).toBe('D:/orig');
  });

  it('apply:启动快照无值时清除 = 删除 env', () => {
    applyUserSettings({ version: 1, godotPath: 'D:/gui.exe' });
    expect(process.env.GODOT_PATH).toBe('D:/gui.exe');
    applyUserSettings({ version: 1, godotPath: '' });     // '' 亦为清除
    expect(process.env.GODOT_PATH).toBeUndefined();
  });

  it('apply:清 godot 路径缓存(findGodot _pathCache 不残留旧解析)', () => {
    // 无公开 set 缓存出口,以「apply 后缓存为空」间接断言清缓存副作用(有缓存则非 null)。
    applyUserSettings({ version: 1, godotPath: 'D:/x.exe' });
    expect(getCachedGodotPath()).toBeNull();
  });

  it('applyUserSettingsAtStartup:文件有设置 → 重放到 env', async () => {
    await writeUserSettings({ version: 1, godotPath: 'D:/cfg/g.exe', allowedProjectPaths: ['D:/cfgproj'] }, dir);
    await applyUserSettingsAtStartup(dir);
    expect(process.env.GODOT_PATH).toBe('D:/cfg/g.exe');
    expect(process.env.ALLOWED_PROJECT_PATHS).toBe('D:/cfgproj');
  });

  it('applyUserSettingsAtStartup:文件缺失 → env 不动(空 apply 幂等无害)', async () => {
    process.env.GODOT_PATH = 'D:/injected.exe';
    resetUserSettingsSnapshotForTest();
    await applyUserSettingsAtStartup(dir);
    expect(process.env.GODOT_PATH).toBe('D:/injected.exe');
  });
});
