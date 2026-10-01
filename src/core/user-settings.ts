// src/core/user-settings.ts
// 用户设置(~/.godot-mcp/settings.json)读写 + 进程内应用(2026-09-29 web-gui 设置批)。
// 语义:web-gui 设置面板保存时 writeUserSettings 持久化 + applyUserSettings 热生效
// (改 process.env + 清 godot 路径缓存);server 启动时 applyUserSettingsAtStartup
// 重放(GUI 设置优先于 AI 客户端注入的 env)。
// 生效机制依据:ALLOWED_PROJECT_PATHS 每次工具调用现读 env(path-utils.ts getAllowedProjectPaths,
// 无缓存);GODOT_PATH 每次解析现读 env 但结果缓存在 godot-finder _pathCache——故 apply
// 末尾必清缓存。清除语义:字段清空 = 恢复进程启动时的 env 快照(客户端注入值),快照在
// 本模块首次接触 env 时定格。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { getLogger } from './logger.js';
import { clearGodotPathCache } from './godot-finder.js';

export interface UserSettings {
  version: 1;
  /** Godot 可执行文件绝对路径(空/缺席 = 用启动时 env 快照) */
  godotPath?: string;
  /** 项目白名单根(绝对路径数组;空/缺席 = 用启动时 env 快照) */
  allowedProjectPaths?: string[];
}

/** 启动时 env 快照:字段清除(恢复)语义的回退源。 */
interface StartupEnvSnapshot {
  godotPath: string | undefined;
  allowed: string | undefined;
}

let _startupSnapshot: StartupEnvSnapshot | null = null;

/** 快照定格(幂等):进程内首次接触 env 时的原始值,此后不再变化。 */
function ensureStartupSnapshot(): StartupEnvSnapshot {
  if (_startupSnapshot === null) {
    _startupSnapshot = {
      godotPath: process.env.GODOT_PATH,
      allowed: process.env.ALLOWED_PROJECT_PATHS,
    };
  }
  return _startupSnapshot;
}

/** 测试隔离出口(对齐 godot-finder clearGodotPathCache 模式):重置快照,下次 ensure 重定格。 */
export function resetUserSettingsSnapshotForTest(): void {
  _startupSnapshot = null;
}

/** settings.json 路径;dir 注入为测试隔离通道。 */
export function getUserSettingsFile(dir?: string): string {
  return join(dir ?? join(homedir(), '.godot-mcp'), 'settings.json');
}

/** 容错读:文件缺失/JSON 损坏/结构异常 → 空 settings(warn 留痕,对齐 projects.json 容错)。 */
export async function readUserSettings(dir?: string): Promise<UserSettings> {
  try {
    const raw = JSON.parse(await readFile(getUserSettingsFile(dir), 'utf-8')) as Partial<UserSettings>;
    const godotPath = typeof raw.godotPath === 'string' ? raw.godotPath : undefined;
    const allowedProjectPaths = Array.isArray(raw.allowedProjectPaths)
      ? raw.allowedProjectPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined;
    return { version: 1, ...(godotPath ? { godotPath } : {}), ...(allowedProjectPaths && allowedProjectPaths.length > 0 ? { allowedProjectPaths } : {}) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().warn('user-settings', `settings.json unreadable, treating as empty: ${err instanceof Error ? err.message : err}`);
    }
    return { version: 1 };
  }
}

/**
 * Windows ACL 收紧(instance-manager.ts:94 / web-gui/registry.ts:115 同款第三副本;
 * 收敛为后续重构项——core 不反向依赖 web-gui,故本文件内联)。settings.json 非凭证
 * (路径配置),但同目录含 token.txt 等凭证,ACL 收紧保持一致卫生。:M 对齐 registry
 * 版(需反复重写)。best-effort:失败只 warn。
 */
function hardenFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const username = userInfo().username;
    if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:M`], { stdio: 'ignore' });
    } else {
      getLogger().warn('user-settings', `Username "${username}" has unexpected chars, skipping ACL restriction for ${filePath}`);
    }
  } catch {
    getLogger().warn('user-settings', `ACL restriction failed for ${filePath}, file may inherit default permissions`);
  }
}

/** 原子写(tmp + rename + 0o600,projects-store.ts writeRaw 同款)。 */
export async function writeUserSettings(s: UserSettings, dir?: string): Promise<void> {
  const file = getUserSettingsFile(dir);
  const tmpPath = `${file}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(tmpPath, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, file);
  hardenFilePermissionsWindows(file);
}

/**
 * 应用设置到当前进程(热生效)。
 * 字段非空 → 覆盖 env;字段空/缺席 → 恢复启动快照(快照有值则恢复,无则删除 env)。
 * 末尾清 godot 路径缓存(_pathCache 命中只验存在性+白名单,不重读 GODOT_PATH env,
 * 故 env 变更后必须 clearGodotPathCache 才会被下次 findGodot 重新解析)。
 */
export function applyUserSettings(s: UserSettings): void {
  const snap = ensureStartupSnapshot();
  if (typeof s.godotPath === 'string' && s.godotPath.length > 0) {
    process.env.GODOT_PATH = s.godotPath;
  } else if (snap.godotPath !== undefined) {
    process.env.GODOT_PATH = snap.godotPath;
  } else {
    delete process.env.GODOT_PATH;
  }
  if (Array.isArray(s.allowedProjectPaths) && s.allowedProjectPaths.length > 0) {
    process.env.ALLOWED_PROJECT_PATHS = s.allowedProjectPaths.join(';');
  } else if (snap.allowed !== undefined) {
    process.env.ALLOWED_PROJECT_PATHS = snap.allowed;
  } else {
    delete process.env.ALLOWED_PROJECT_PATHS;
  }
  clearGodotPathCache();
}

/**
 * server 启动重放:定格快照 → 读 settings.json → 应用。
 * 文件缺失/为空时 apply 空对象 = 恢复快照 = 幂等无害(启动时 env === 快照)。
 * 必须在 index.ts 的「ALLOWED_PROJECT_PATHS 未配置」提示之前调用(否则提示按旧 env 误报)。
 */
export async function applyUserSettingsAtStartup(dir?: string): Promise<void> {
  ensureStartupSnapshot();
  const s = await readUserSettings(dir);
  if (s.godotPath !== undefined || s.allowedProjectPaths !== undefined) {
    applyUserSettings(s);
    getLogger().info('user-settings', `Applied user settings from ${getUserSettingsFile(dir)} (godotPath=${s.godotPath !== undefined ? 'set' : 'unset'}, allowedProjectPaths=${s.allowedProjectPaths !== undefined ? s.allowedProjectPaths.length : 'unset'})`);
  }
}

// ─── 首启预检判定(终验收 V1,spec §3.10 条款 3)─────────────────────────────

/** env 侧判定:env 是否已配置任一 Godot 生效配置(GODOT_PATH 或 ALLOWED_PROJECT_PATHS)。
 *  ALLOWED_PROJECT_PATHS 解析对齐 path-utils getAllowedProjectPaths 的 split(';')+
 *  filter 语义(纯函数不引 path-utils,防依赖面扩张;语义变更须两处同步)。
 *  空洞值(空串/纯分号)不算配置。 */
export function hasEnvGodotConfig(env: NodeJS.ProcessEnv): boolean {
  if ((env.GODOT_PATH ?? '').trim() !== '') return true;
  const allowed = env.ALLOWED_PROJECT_PATHS;
  return allowed !== undefined && allowed.split(';').some(p => p.trim() !== '');
}

/** settings.json 与 env 合并判定首启预检:两者均无有效 Godot 路径/白名单 → true
 *  (调用方显示显著提示;daemon 照常起,不阻断)。消费方:
 *  - cli/daemon.ts 的 start 壳(CLI 进程不经启动序重放,须 settings+env 合并读);
 *  - web-gui/server.ts 的 hello.settingsConfigured 经 hasEnvGodotConfig(daemon/stdio
 *    入口都经 applyUserSettingsAtStartup 重放,env 即合并生效视图,判 env 即完备)。
 *  两消费方共用本族纯函数,防 CLI 与面板判定漂移(V1 验收发现实缺的根因之一)。 */
export function isGodotConfigMissing(s: UserSettings, env: NodeJS.ProcessEnv): boolean {
  const hasSettings = (s.godotPath !== undefined && s.godotPath.trim() !== '')
    || (s.allowedProjectPaths !== undefined && s.allowedProjectPaths.length > 0);
  return !hasSettings && !hasEnvGodotConfig(env);
}
