// src/resource-manager.ts — Godot resource file (.tres/.res) operations

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, extname, dirname } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

interface ResourceData {
  type: string;
  properties: Record<string, unknown>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Parse a Godot INI-like resource file (.tres / .res).
 * Format:
 *   [gd_resource type="Texture2D" ...]
 *   key = value
 *   [sub_resource ...]
 *   ...
 */
function parseResourceContent(content: string): ResourceData | null {
  const lines = normalizeLines(content);
  let resourceType = '';
  const properties: Record<string, unknown> = {};
  let inHeader = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;

    // Parse [gd_resource type="X" ...]
    const gdResMatch = trimmed.match(/^\[gd_resource\s+(.*)\]$/);
    if (gdResMatch) {
      const attrs = gdResMatch[1];
      const typeMatch = attrs.match(/type="([^"]*)"/);
      if (typeMatch) {
        resourceType = typeMatch[1];
      }
      inHeader = false;
      continue;
    }

    // Skip sub_resource / ext_resource sections (they are not top-level properties)
    if (trimmed.startsWith('[sub_resource') || trimmed.startsWith('[ext_resource')) continue;

    // Parse key = value
    const kvMatch = trimmed.match(/^([\w/]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawValue = kvMatch[2].trim();
      properties[key] = parseResourceValue(rawValue);
    }
  }

  if (!resourceType) return null;

  return { type: resourceType, properties };
}

function parseResourceValue(raw: string): unknown {
  // String
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  // Bool
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Null
  if (raw === 'null' || raw === 'None') return null;
  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  // ExtResource / SubResource references
  const extMatch = raw.match(/^ExtResource\("(\d+)"\)$/);
  if (extMatch) return { __type: 'ExtResource', id: parseInt(extMatch[1]) };
  const subMatch = raw.match(/^SubResource\("([^"]+)"\)$/);
  if (subMatch) return { __type: 'SubResource', id: subMatch[1] };
  // Vector types
  const vec2 = raw.match(/^Vector2\(([^)]+)\)$/);
  if (vec2) return raw;
  const vec3 = raw.match(/^Vector3\(([^)]+)\)$/);
  if (vec3) return raw;
  const color = raw.match(/^Color\(([^)]+)\)$/);
  if (color) return raw;
  // Fallback
  return raw;
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // If it looks like a Godot constructor (Vector2, Color, etc.), keep as-is
    if (/^(Vector2|Vector3|Color|Rect2|Transform2D|Transform3D|Basis|Quaternion)\(/.test(value)) {
      return value;
    }
    // If it's already quoted, keep as-is
    if (value.startsWith('"') && value.endsWith('"')) return value;
    // ExtResource / SubResource
    if (/^ExtResource\(/.test(value) || /^SubResource\(/.test(value)) return value;
    // Otherwise wrap in quotes
    return `"${value.replace(/"/g, '""')}"`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a .tres / .res resource file and return its type and properties.
 */
export function readResource(filePath: string): ResourceData | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return parseResourceContent(content);
}

/**
 * Write a .tres / .res resource file with the given type and properties.
 * This creates a minimal resource file (does not preserve sub_resources or ext_resources
 * from the original).
 */
export function writeResource(filePath: string, type: string, properties: Record<string, unknown>): boolean {
  const lines: string[] = [];
  lines.push(`[gd_resource type="${type}" load_steps=2 format=3]`);
  lines.push('');

  for (const [key, value] of Object.entries(properties)) {
    lines.push(`${key} = ${serializeValue(value)}`);
  }

  lines.push('');
  const content = lines.join('\n');

  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * List resource files in a project directory.
 * Optionally filter by resource type.
 */
export function listResources(
  projectPath: string,
  type?: string,
): { path: string; type: string }[] {
  const results: { path: string; type: string }[] = [];
  const extensions = ['.tres', '.res'];

  function scan(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            const res = readResource(full);
            if (res) {
              if (!type || res.type.toLowerCase() === type.toLowerCase()) {
                results.push({
                  path: full.replace(projectPath + (process.platform === 'win32' ? '\\' : '/'), ''),
                  type: res.type,
                });
              }
            }
          }
        }
      }
    } catch {
      // skip inaccessible dirs
    }
  }

  scan(projectPath);
  return results;
}