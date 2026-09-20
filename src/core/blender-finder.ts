import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { getLogger } from './logger.js';
import { buildSafeEnv } from './godot-finder.js';

const execFileAsync = promisify(execFile);

/** 单值缓存（MVP 砍 project override 层，blender 版本对 bpy 影响小）。 */
let _blenderPath: string | null = null;

/**
 * 判定 `blender --version` 输出是否为可信签名。
 * 对称 godot-finder isGodotVersionSignature (C-SEC-2)：必须含 "Blender" 关键字 + 版本号，
 * 否则 GODOT_BLENDER_PATH 指向的伪造二进制（只打印版本号）被 spawn = 直达 RCE。
 */
export function isBlenderVersionSignature(stdout: string): boolean {
  const v = stdout.trim();
  return /blender/i.test(v) && /\d+\.\d+/.test(v);
}

/** Validate a candidate binary by running --version and checking signature. */
export async function validateBlenderBinary(candidatePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(candidatePath, ['--version'],
      { encoding: 'utf-8', timeout: 5000, env: buildSafeEnv() });
    return isBlenderVersionSignature(stdout);
  } catch (err) {
    getLogger().debug('blender-finder',
      `validateBlenderBinary failed for ${candidatePath}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** 找 blender：GODOT_BLENDER_PATH env → PATH 上的 blender，单值缓存。 */
export async function findBlender(): Promise<string> {
  if (_blenderPath && (_blenderPath === 'blender' || existsSync(_blenderPath))) return _blenderPath;

  // 1. GODOT_BLENDER_PATH env（validate 防伪造）
  const envPath = process.env.GODOT_BLENDER_PATH;
  if (envPath && existsSync(envPath) && await validateBlenderBinary(envPath)) {
    _blenderPath = envPath;
    return _blenderPath;
  }

  // 2. PATH 上的 blender
  try {
    const { stdout } = await execFileAsync('blender', ['--version'],
      { encoding: 'utf-8', timeout: 5000, env: buildSafeEnv() });
    if (isBlenderVersionSignature(stdout)) {
      _blenderPath = 'blender';
      return _blenderPath;
    }
  } catch (err) {
    getLogger().debug('blender-finder', `PATH blender failed: ${err instanceof Error ? err.message : err}`);
  }

  _blenderPath = null;
  throw new Error('Blender not found. Set GODOT_BLENDER_PATH or install Blender on PATH.');
}

/** Clear cache (test-only). */
export function clearBlenderPathCache(): void { _blenderPath = null; }
export function getCachedBlenderPath(): string | null { return _blenderPath; }
