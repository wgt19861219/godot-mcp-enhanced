import { isAbsolute, resolve, dirname, relative, sep, basename } from 'path';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Path security constants ──────────────────────────────────────────────────

const MAX_DECODE_ITERATIONS = 20;

/** Windows device names that must never be used as file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) */
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Resolve a path to absolute. Does NOT validate security — use resolveWithinRoot for that. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** Validate and resolve a project root path. Delegates to resolvePath; use resolveWithinRoot for sub-path traversal protection. */
export const validatePath = resolvePath;

/** Validate that a path is a valid Godot project root (contains project.godot). Throws if not found. */
export function validateProjectRoot(p: string): string {
  const resolved = resolvePath(p);
  if (!existsSync(join(resolved, 'project.godot'))) {
    throw new Error(`Not a valid Godot project (no project.godot found): ${resolved}`);
  }
  return resolved;
}

/** Safely resolve real path — walks up to find existing ancestor for symlink resolution.
 *  When the full path doesn't exist, resolves the nearest existing ancestor via realpathSync,
 *  then appends the remaining non-existent segments. This prevents symlink bypass in intermediate
 *  directories (e.g. /allowed/symlink_to_external/newfile). */
export function safeRealPath(p: string, base?: string): string {
  try { return realpathSync(p); } catch {
    let current = resolvePath(p);
    const trailing: string[] = [];
    while (!existsSync(current)) {
      trailing.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break; // filesystem root
      current = parent;
    }
    let resolvedAncestor: string;
    try { resolvedAncestor = realpathSync(current); } catch { return resolvePath(p); }
    const resolved = trailing.length > 0 ? join(resolvedAncestor, ...trailing) : resolvedAncestor;
    // If a base is provided, verify the resolved path doesn't escape it
    if (base) {
      const rel = relative(base, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Path traversal detected in fallback resolution: ${p}`);
      }
    }
    return resolved;
  }
}

export function resolveWithinRoot(root: string, userPath: string): string {
  // Resolve real root path (handles symlinks and junction points)
  // NOTE: TOCTOU window exists between symlink check and actual use — accepted risk for local-only scenarios.
  const base = safeRealPath(resolvePath(root));

  // Reject UNC paths (\\server\share) — only relevant on Windows
  if (/^\\\\[^\\]/.test(userPath)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  // Reject Windows device names in the final path component (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const leafName = userPath.replace(/\\/g, '/').split('/').pop() || '';
  const baseName = leafName.replace(/\.[^.]*$/, '');
  if (WINDOWS_DEVICE_RE.test(baseName)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  // Decode iteratively to defeat multi-layer encoding (generous cap for safety)
  let decoded = userPath;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < MAX_DECODE_ITERATIONS) {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new Error(`Path traversal detected: ${userPath}`);
    }
    iterations++;
  }

  // Reject paths containing ".." before resolution
  const normalizedPath = decoded.replace(/\\/g, '/');
  if (normalizedPath.includes('..')) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  const resolved = resolve(base, normalizedPath);
  // Resolve real path for the target (handles symlinks and junction points)
  // Pass base so the fallback resolution can also check for traversal
  const realResolved = safeRealPath(resolved, base);
  const rel = relative(base, realResolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return realResolved;
}

export function ensureDir(p: string): void {
  if (!existsSync(dirname(p))) {
    mkdirSync(dirname(p), { recursive: true });
  }
}

/** Require a non-empty string from tool args. Throws descriptive error on missing/invalid. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${key} must be a non-empty string, got: ${v === undefined ? 'undefined' : v === null ? 'null' : JSON.stringify(v)}`);
  }
  return v;
}

/** Require a finite number from tool args. Returns fallback if key is absent/undefined. */
export function requireNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${key} is required and must be a number`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a finite number, got: ${JSON.stringify(v)}`);
  }
  return n;
}

/** Convenience: require and validate project_path in one call. */
export function requireProjectPath(args: Record<string, unknown>): string {
  return validatePath(requireString(args, 'project_path'));
}

export function normalizeUserProjectPath(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('res://')) return trimmed.slice('res://'.length);
  return trimmed;
}

/** Parse ALLOWED_PROJECT_PATHS env var (semicolon-separated whitelist). Returns empty array if not set. */
export function getAllowedProjectPaths(): string[] {
  const env = process.env.ALLOWED_PROJECT_PATHS;
  if (!env) return [];
  return env.split(';').filter(Boolean).map(p => resolvePath(p));
}

export function allowOutsideProjectPaths(): boolean {
  // Deprecated: ALLOW_OUTSIDE_PROJECT_PATHS — use ALLOWED_PROJECT_PATHS whitelist instead
  if (process.env.ALLOW_OUTSIDE_PROJECT_PATHS === 'true') {
    console.error('[SECURITY] [DEPRECATED] ALLOW_OUTSIDE_PROJECT_PATHS is enabled — migrate to ALLOWED_PROJECT_PATHS whitelist');
    return true;
  }
  return false;
}

let _pathAllowWarned = false;

/** Ensure path ends with separator for prefix matching (avoids double-sep on Windows). */
function ensureSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/** Check if a requested path is within the ALLOWED_PROJECT_PATHS whitelist.
 *  Unconfigured: fall back to process.cwd() as the only allowed root (deny-by-default).
 *  Configured: restrict to whitelist entries only.
 *  Explicit override: GODOT_MCP_UNRESTRICTED=true allows all paths. */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
    console.warn('[SECURITY] GODOT_MCP_UNRESTRICTED=true — all path restrictions bypassed');
    return true;
  }
  if (allowOutsideProjectPaths()) return true;
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    if (!_pathAllowWarned) {
      console.warn('[SECURITY] ALLOWED_PROJECT_PATHS not set — restricted to process.cwd(). Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true to override.');
      _pathAllowWarned = true;
    }
    const cwd = resolvePath(process.cwd());
    const resolved = resolvePath(requestedPath);
    return resolved === cwd || resolved.startsWith(ensureSep(cwd));
  }
  const resolved = resolvePath(requestedPath);
  return allowed.some(p => resolved === p || resolved.startsWith(ensureSep(p)));
}

/** Reset warning state (test-only). */
export function _resetPathAllowWarned(): void { _pathAllowWarned = false; }

/** Build a safe environment for child processes, only passing necessary variables. */
export function buildSafeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    APPDATA: process.env.APPDATA ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    GODOT: process.env.GODOT ?? '',
    // Windows-specific variables required for proper process spawning
    SystemRoot: process.env.SystemRoot ?? '',
    COMSPEC: process.env.COMSPEC ?? '',
    OS: process.env.OS ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
  };
}

// ─── Shared: checkVersionMismatch ────────────────────────────────────────────

export async function checkVersionMismatch(projectPath: string, godotBin: string): Promise<string | null> {
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, 'utf-8');
    const featuresMatch = config.match(/config\/features=PackedStringArray\("([^"]+)"\)/);
    if (!featuresMatch) return null;
    const projectVersion = featuresMatch[1];

    const { stdout, stderr } = await execFileAsync(godotBin, ['--version'], { timeout: 5000 });
    const binVersion = (stdout || stderr || '').trim();
    const binMatch = binVersion.match(/^(\d+\.\d+)/);
    if (!binMatch) return null;
    const binMajorMinor = binMatch[1];

    if (projectVersion !== binMajorMinor) {
      return `[WARNING] Version mismatch: project.godot expects Godot ${projectVersion}, but binary is ${binVersion} (${binMajorMinor}). Errors may be inaccurate.`;
    }
    return null;
  } catch (err) {
    console.warn('[helpers] checkVersionMismatch failed:', (err as Error).message);
    return null;
  }
}

// ─── Shared: parseConfigValue ────────────────────────────────────────────────

/** Split a comma-separated string while respecting quoted segments. */
function splitRespectingQuotes(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts;
}

export function parseConfigValue(raw: string, depth = 0): unknown {
  if (depth > 8) return raw;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return num;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitRespectingQuotes(inner).map(s => parseConfigValue(s, depth + 1)).filter(s => s !== '');
  }
  return raw;
}

// ─── Shared: parseGodotConfig ────────────────────────────────────────────────

export interface GodotConfig {
  [section: string]: string | number | boolean | null | unknown[] | GodotConfig;
}

export function parseGodotConfig(content: string): GodotConfig {
  const lines = content.split('\n');
  const sectioned = {} as GodotConfig;
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sectioned[currentSection]) sectioned[currentSection] = {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const container = currentSection
        ? (sectioned[currentSection] as Record<string, unknown>)
        : sectioned;
      // I-03: Ensure container is actually an object before writing properties
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        container[kvMatch[1]] = parseConfigValue(kvMatch[2].trim());
      }
    }
  }

  return sectioned;
}

// ─── MCP output parser ───────────────────────────────────────────────────────

import { MARKER_RESULT, MARKER_ERROR } from './tools/shared.js';

export function parseMcpScriptOutput(rawOutput: string, exitCode: number | null, resultMarker = MARKER_RESULT, errorMarker = MARKER_ERROR): unknown {
  const lines = rawOutput.split('\n');
  const logLines: string[] = [];
  let parsed: unknown = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON', raw: trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON', raw: trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  if (parsed) return parsed;

  return {
    success: false,
    error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
    raw_output: logLines.join('\n'),
  };
}

// ─── File scanner ────────────────────────────────────────────────────────────

export const DEFAULT_SKIP_DIRS = ['.godot', '.import', 'addons', 'tools'];

/** Recursively scan a directory for files matching given extensions.
 *  @param rootDir Root directory to scan
 *  @param extensions File extensions to include (e.g. ['.gd', '.tscn'])
 *  @param options.skipDirs Directory names to skip (default: DEFAULT_SKIP_DIRS)
 *  @param options.maxDepth Maximum recursion depth (default: 15)
 *  @param options.skipDotFiles Skip files/dirs starting with '.' (default: true) */
export function scanFiles(
  rootDir: string,
  extensions: string[],
  options: { skipDirs?: string[]; maxDepth?: number; skipDotFiles?: boolean } = {},
): string[] {
  const { skipDirs = DEFAULT_SKIP_DIRS, maxDepth = 15, skipDotFiles = true } = options;
  const results: string[] = [];
  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skipDotFiles && entry.name.startsWith('.')) continue;
        if (skipDirs.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          results.push(full);
        }
      }
    } catch (err) { console.debug('[helpers] scanFiles:', err); }
  }
  scan(rootDir, 0);
  return results;
}
