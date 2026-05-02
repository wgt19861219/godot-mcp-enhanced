import { isAbsolute, resolve, dirname, relative, sep } from 'path';
import { existsSync, mkdirSync } from 'fs';

// ─── Path helpers ────────────────────────────────────────────────────────────

export function validatePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

export function resolveWithinRoot(root: string, userPath: string): string {
  const base = validatePath(root);
  const normalizedPath = userPath.replace(/\\+/g, '/');
  const segments = normalizedPath.split('/');
  if (segments.includes('..')) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
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
