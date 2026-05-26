import { isAbsolute, resolve, dirname, relative, sep } from 'path';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

/** Safely resolve real path — falls back to resolve() when path doesn't exist, with traversal check. */
function safeRealPath(p: string, base?: string): string {
  try { return realpathSync(p); } catch {
    const resolved = resolvePath(p);
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
  const base = safeRealPath(resolvePath(root));
  // Decode iteratively to defeat double-encoding
  let decoded = userPath;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < 5) {
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

/** Check if a requested path is within the ALLOWED_PROJECT_PATHS whitelist (or unrestricted if no whitelist set). */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (allowOutsideProjectPaths()) return true;
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    console.warn('[SECURITY] ALLOWED_PROJECT_PATHS is not set — all paths are allowed (unrestricted mode). Set ALLOWED_PROJECT_PATHS to limit access.');
    return true; // No whitelist = unrestricted (existing behavior)
  }
  const resolved = resolvePath(requestedPath);
  return allowed.some(p => resolved === p || resolved.startsWith(p + sep));
}

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
  } catch {
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
      container[kvMatch[1]] = parseConfigValue(kvMatch[2].trim());
    }
  }

  return sectioned;
}

// ─── MCP output parser ───────────────────────────────────────────────────────

const MCP_MARKER_RESULT = '___MCP_RESULT___';
const MCP_MARKER_ERROR = '___MCP_ERROR___';

export function parseMcpScriptOutput(rawOutput: string, exitCode: number | null, resultMarker = MCP_MARKER_RESULT, errorMarker = MCP_MARKER_ERROR): unknown {
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
