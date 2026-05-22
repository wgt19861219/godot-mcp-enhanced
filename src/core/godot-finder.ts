import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WINDOWS_SEARCH_DIRS = [
  'C:\\Program Files\\Godot',
  'C:\\Program Files (x86)\\Godot',
];

const POSIX_CANDIDATES = [
  '/usr/bin/godot4',
  '/usr/local/bin/godot4',
  '/Applications/Godot.app/Contents/MacOS/Godot',
];

let godotPath: string | null = null;

/** Clear the cached Godot binary path (useful for testing or after path changes). */
export function clearGodotPathCache(): void {
  godotPath = null;
}

/** Get the currently cached Godot binary path, or null if not yet resolved. */
export function getCachedGodotPath(): string | null {
  return godotPath;
}

function findInDirectory(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      if (/^Godot_v4.*\.exe$/i.test(entry)) {
        return join(dir, entry);
      }
    }
  } catch { /* permission denied */ }
  return null;
}

export async function findGodot(): Promise<string> {
  if (godotPath) {
    if (godotPath === 'godot' || existsSync(godotPath)) return godotPath;
    godotPath = null; // cached path no longer valid
  }

  const tried: string[] = [];

  // 1. Environment variable
  if (process.env.GODOT_PATH) {
    if (existsSync(process.env.GODOT_PATH)) {
      godotPath = process.env.GODOT_PATH;
      return godotPath;
    }
    tried.push(`GODOT_PATH=${process.env.GODOT_PATH}`);
  }

  // 2. Try `godot` on PATH via a quick async spawn
  try {
    const { stdout } = await execFileAsync('godot', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    const out = stdout.trim();
    if (out.includes('Godot')) {
      godotPath = 'godot';
      return godotPath;
    }
  } catch { tried.push('godot (PATH)'); }

  // 3. Platform-specific search
  if (process.platform === 'win32') {
    for (const dir of WINDOWS_SEARCH_DIRS) {
      tried.push(`${dir}/Godot_v4*.exe`);
      const found = findInDirectory(dir);
      if (found) { godotPath = found; return found; }
    }
  } else {
    for (const candidate of POSIX_CANDIDATES) {
      tried.push(candidate);
      if (existsSync(candidate)) { godotPath = candidate; return candidate; }
    }
  }

  throw new Error(
    `Godot binary not found. Tried:\n${tried.map(t => `  - ${t}`).join('\n')}\nSet GODOT_PATH or add godot to PATH.`
  );
}
