// src/resources.ts — MCP Resources handler for godot:// URI scheme
//
// Exposes Godot project context via MCP Resources protocol so AI clients
// can discover and read project information without explicit tool calls.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join, extname, sep } from 'path';
import { parseTscnSummary } from './tscn-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ─── Security ─────────────────────────────────────────────────────────────────

const FORBIDDEN_EXTENSIONS = new Set([
  '.import', '.uid', '.godot',
]);

const FORBIDDEN_DIRS = new Set([
  '.godot', '.import', 'node_modules', '.git', '.svn', '.hg',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.ico',
  '.mp3', '.ogg', '.wav', '.flac',
  '.glb', '.gltf', '.fbx', '.obj',
  '.ttf', '.otf', '.woff', '.woff2',
  '.zip', '.tar', '.gz', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.xls',
]);

const MAX_RESOURCES = 200;

function isSafePath(projectPath: string, filePath: string): boolean {
  const resolved = resolve(projectPath, filePath);
  const normalizedRoot = resolve(projectPath);
  // Windows: case-insensitive comparison
  const cmpResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const cmpRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!cmpResolved.startsWith(cmpRoot + sep) && cmpResolved !== cmpRoot) return false;
  // Extension check
  const ext = extname(filePath).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) return false;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  // Path segment check: block forbidden dirs and dot-prefixed segments
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (FORBIDDEN_DIRS.has(part)) return false;
    if (part.startsWith('.') && part !== '.') return false;
  }
  return true;
}

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.json': 'application/json',
    '.gd': 'text/x-gdscript',
    '.xml': 'text/xml',
    '.svg': 'image/svg+xml',
    '.cfg': 'text/plain',
    '.tscn': 'text/plain',
    '.tres': 'text/plain',
    '.gdshader': 'text/plain',
  };
  return mimeMap[ext] || 'text/plain';
}

// ─── Resource readers ─────────────────────────────────────────────────────────

function readProjectInfo(projectPath: string): McpResourceContent {
  const projectFile = join(projectPath, 'project.godot');
  if (!existsSync(projectFile)) {
    return { uri: 'godot://project/info', mimeType: 'text/plain', text: 'ERROR: project.godot not found' };
  }

  const content = readFileSync(projectFile, 'utf-8');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const info: Record<string, unknown> = {};

  let section = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = section ? `${section}/${kvMatch[1]}` : kvMatch[1];
      info[key] = parseConfigValue(kvMatch[2].trim());
    }
  }

  info['_stats'] = countFiles(projectPath);

  return {
    uri: 'godot://project/info',
    mimeType: 'application/json',
    text: JSON.stringify(info, null, 2),
  };
}

function readProjectConfig(projectPath: string): McpResourceContent {
  const projectFile = join(projectPath, 'project.godot');
  if (!existsSync(projectFile)) {
    return { uri: 'godot://project/config', mimeType: 'text/plain', text: 'ERROR: project.godot not found' };
  }
  return {
    uri: 'godot://project/config',
    mimeType: 'text/plain',
    text: readFileSync(projectFile, 'utf-8'),
  };
}

function readSceneResource(projectPath: string, scenePath: string): McpResourceContent {
  const fullPath = join(projectPath, scenePath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://scene/${scenePath}`, mimeType: 'text/plain', text: `ERROR: Scene file not found: ${scenePath}` };
  }
  const content = readFileSync(fullPath, 'utf-8');
  const summary = parseTscnSummary(content);
  return { uri: `godot://scene/${scenePath}`, mimeType: 'text/plain', text: summary };
}

function readScriptResource(projectPath: string, scriptPath: string): McpResourceContent {
  const fullPath = join(projectPath, scriptPath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://script/${scriptPath}`, mimeType: 'text/plain', text: `ERROR: Script file not found: ${scriptPath}` };
  }
  return { uri: `godot://script/${scriptPath}`, mimeType: 'text/x-gdscript', text: readFileSync(fullPath, 'utf-8') };
}

function readFileResource(projectPath: string, filePath: string): McpResourceContent {
  const fullPath = join(projectPath, filePath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://file/${filePath}`, mimeType: 'text/plain', text: `ERROR: File not found: ${filePath}` };
  }
  return { uri: `godot://file/${filePath}`, mimeType: guessMimeType(filePath), text: readFileSync(fullPath, 'utf-8') };
}

// ─── Resource listing ─────────────────────────────────────────────────────────

export function listResources(projectPath: string | undefined): McpResource[] {
  if (!projectPath) {
    return [
      { uri: 'godot://help', name: 'Help', description: 'No project path available. Use templates to read specific files.', mimeType: 'text/plain' },
    ];
  }

  const resources: McpResource[] = [
    { uri: 'godot://project/info', name: 'Project Info', description: 'Project metadata, config summary, file statistics', mimeType: 'application/json' },
    { uri: 'godot://project/config', name: 'project.godot', description: 'Raw project.godot config file', mimeType: 'text/plain' },
  ];

  scanForResources(projectPath, '', resources, 0);
  if (resources.length >= MAX_RESOURCES) {
    resources.push({
      uri: 'godot://help/truncated',
      name: 'List Truncated',
      description: `Only first ${MAX_RESOURCES} resources listed. Use templates to read specific files.`,
      mimeType: 'text/plain',
    });
  }
  return resources;
}

function scanForResources(projectPath: string, relativeDir: string, resources: McpResource[], depth: number): void {
  if (resources.length >= MAX_RESOURCES) return;
  if (depth > 5) return;
  const dir = join(projectPath, relativeDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (resources.length >= MAX_RESOURCES) return;
    if (entry.name.startsWith('.')) continue;
    if (FORBIDDEN_DIRS.has(entry.name)) continue;

    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      scanForResources(projectPath, rel, resources, depth + 1);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.tscn') {
        resources.push({
          uri: `godot://scene/${rel}`,
          name: entry.name,
          description: `Scene: ${rel}`,
          mimeType: 'text/plain',
        });
      } else if (ext === '.gd') {
        resources.push({
          uri: `godot://script/${rel}`,
          name: entry.name,
          description: `Script: ${rel}`,
          mimeType: 'text/x-gdscript',
        });
      }
    }
  }
}

// ─── Resource templates ───────────────────────────────────────────────────────

export function listResourceTemplates(): McpResourceTemplate[] {
  return [
    {
      uriTemplate: 'godot://scene/{path}',
      name: 'Scene',
      description: 'Read a .tscn scene file as a node tree summary',
      mimeType: 'text/plain',
    },
    {
      uriTemplate: 'godot://script/{path}',
      name: 'Script',
      description: 'Read a .gd script file',
      mimeType: 'text/x-gdscript',
    },
    {
      uriTemplate: 'godot://file/{path}',
      name: 'File',
      description: 'Read any text file from the project (binary files and hidden dirs blocked)',
      mimeType: 'text/plain',
    },
  ];
}

// ─── Resource reading ─────────────────────────────────────────────────────────

export function readResource(uri: string, projectPath: string | undefined): McpResourceContent {
  if (!projectPath) {
    return { uri, mimeType: 'text/plain', text: 'ERROR: No project path available.' };
  }

  if (!uri.startsWith('godot://')) {
    return { uri, mimeType: 'text/plain', text: `ERROR: Invalid URI scheme: ${uri}. Expected godot://` };
  }

  const rawPath = uri.substring('godot://'.length);
  // URL decode for safety
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }

  const slashIdx = path.indexOf('/');
  if (slashIdx === -1) {
    return { uri, mimeType: 'text/plain', text: 'Unknown resource. Use godot://project/info, godot://scene/{path}, godot://script/{path}, or godot://file/{path}' };
  }

  const category = path.substring(0, slashIdx);
  const resourcePath = path.substring(slashIdx + 1);

  switch (category) {
    case 'project':
      if (resourcePath === 'info') return readProjectInfo(projectPath);
      if (resourcePath === 'config') return readProjectConfig(projectPath);
      return { uri, mimeType: 'text/plain', text: `Unknown project resource: ${resourcePath}` };

    case 'scene':
      if (!isSafePath(projectPath, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readSceneResource(projectPath, resourcePath);

    case 'script':
      if (!isSafePath(projectPath, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readScriptResource(projectPath, resourcePath);

    case 'file':
      if (!isSafePath(projectPath, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readFileResource(projectPath, resourcePath);

    default:
      return { uri, mimeType: 'text/plain', text: `Unknown resource category: ${category}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseConfigValue(raw: string): unknown {
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

function countFiles(projectPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  function scan(dir: string, depth: number): void {
    if (depth > 5) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (FORBIDDEN_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (ext) counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    } catch { /* skip */ }
  }
  scan(projectPath, 0);
  return counts;
}
