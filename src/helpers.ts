import { isAbsolute, resolve, dirname, relative, sep } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
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

export function resolveWithinRoot(root: string, userPath: string): string {
  const base = resolvePath(root);
  const normalizedPath = userPath.replace(/\\/g, '/');
  const resolved = resolve(base, normalizedPath);
  const rel = relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return resolved;
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

export function allowOutsideProjectPaths(): boolean {
  return process.env.ALLOW_OUTSIDE_PROJECT_PATHS === 'true';
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

export function parseConfigValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => parseConfigValue(s.trim())).filter(s => s !== '');
  }
  return raw;
}

// ─── Shared: parseGodotConfig ────────────────────────────────────────────────

export function parseGodotConfig(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  const sectioned: Record<string, unknown> = {};
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

export function parseMcpScriptOutput(rawOutput: string, exitCode: number | null): unknown {
  const lines = rawOutput.split('\n');
  const logLines: string[] = [];
  let parsed: unknown = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MCP_MARKER_RESULT)) {
      try {
        parsed = JSON.parse(trimmed.substring(MCP_MARKER_RESULT.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON', raw: trimmed };
      }
    } else if (trimmed.startsWith(MCP_MARKER_ERROR)) {
      try {
        parsed = JSON.parse(trimmed.substring(MCP_MARKER_ERROR.length));
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
