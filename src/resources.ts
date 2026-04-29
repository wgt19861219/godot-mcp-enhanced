// src/resources.ts — MCP Resources handler for godot:// URI scheme
//
// Exposes Godot project context via MCP Resources protocol so AI clients
// can discover and read project information without explicit tool calls.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, extname, sep } from 'path';
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
  '.godot', '.import', 'node_modules',
]);

function isSafePath(projectPath: string, filePath: string): boolean {
  const resolved = join(projectPath, filePath);
  if (!resolved.startsWith(projectPath + sep) && resolved !== projectPath) return false;
  const ext = extname(filePath).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) return false;
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (FORBIDDEN_DIRS.has(part)) return false;
  }
  return true;
}

// ─── Resource readers ─────────────────────────────────────────────────────────

function readProjectInfo(projectPath: string): McpResourceContent {
  const projectFile = join(projectPath, 'project.godot');
  if (!existsSync(projectFile)) {
    return { uri: 'godot://project/info', mimeType: 'text/plain', text: 'project.godot not found' };
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
    return { uri: 'godot://project/config', mimeType: 'text/plain', text: 'project.godot not found' };
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
    return { uri: `godot://scene/${scenePath}`, mimeType: 'text/plain', text: `Scene file not found: ${scenePath}` };
  }
  const content = readFileSync(fullPath, 'utf-8');
  const summary = parseTscnSummary(content);
  return { uri: `godot://scene/${scenePath}`, mimeType: 'text/plain', text: summary };
}

function readScriptResource(projectPath: string, scriptPath: string): McpResourceContent {
  const fullPath = join(projectPath, scriptPath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://script/${scriptPath}`, mimeType: 'text/plain', text: `Script file not found: ${scriptPath}` };
  }
  return { uri: `godot://script/${scriptPath}`, mimeType: 'text/plain', text: readFileSync(fullPath, 'utf-8') };
}

function readFileResource(projectPath: string, filePath: string): McpResourceContent {
  const fullPath = join(projectPath, filePath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://file/${filePath}`, mimeType: 'text/plain', text: `File not found: ${filePath}` };
  }
  return { uri: `godot://file/${filePath}`, mimeType: 'text/plain', text: readFileSync(fullPath, 'utf-8') };
}

// ─── Resource listing ─────────────────────────────────────────────────────────

function findProjectRoot(): string | null {
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'project.godot'))) return cwd;
  let dir = cwd;
  for (let i = 0; i < 3; i++) {
    const parent = join(dir, '..');
    if (parent === dir) break;
    if (existsSync(join(parent, 'project.godot'))) return parent;
    dir = parent;
  }
  return null;
}

export function listResources(projectPath: string | undefined): McpResource[] {
  const pp = projectPath || findProjectRoot();
  if (!pp) {
    return [
      { uri: 'godot://help', name: 'Help', description: 'Set project_path to list project resources', mimeType: 'text/plain' },
    ];
  }

  const resources: McpResource[] = [
    { uri: 'godot://project/info', name: 'Project Info', description: 'Project metadata, config summary, file statistics', mimeType: 'application/json' },
    { uri: 'godot://project/config', name: 'project.godot', description: 'Raw project.godot config file', mimeType: 'text/plain' },
  ];

  scanForResources(pp, '', resources);
  return resources;
}

function scanForResources(projectPath: string, relativeDir: string, resources: McpResource[]): void {
  const dir = join(projectPath, relativeDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (FORBIDDEN_DIRS.has(entry.name)) continue;

    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      scanForResources(projectPath, rel, resources);
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
          mimeType: 'text/plain',
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
      mimeType: 'text/plain',
    },
    {
      uriTemplate: 'godot://file/{path}',
      name: 'File',
      description: 'Read any project file (text)',
      mimeType: 'text/plain',
    },
  ];
}

// ─── Resource reading ─────────────────────────────────────────────────────────

export function readResource(uri: string, projectPath: string | undefined): McpResourceContent {
  const pp = projectPath || findProjectRoot();
  if (!pp) {
    return { uri, mimeType: 'text/plain', text: 'No project path available. Set project_path or open a Godot project directory.' };
  }

  if (!uri.startsWith('godot://')) {
    return { uri, mimeType: 'text/plain', text: `Invalid URI scheme: ${uri}. Expected godot://` };
  }

  const path = uri.substring('godot://'.length);
  const slashIdx = path.indexOf('/');
  if (slashIdx === -1) {
    return { uri, mimeType: 'text/plain', text: 'Unknown resource. Use godot://project/info, godot://scene/{path}, godot://script/{path}, or godot://file/{path}' };
  }

  const category = path.substring(0, slashIdx);
  const resourcePath = path.substring(slashIdx + 1);

  switch (category) {
    case 'project':
      if (resourcePath === 'info') return readProjectInfo(pp);
      if (resourcePath === 'config') return readProjectConfig(pp);
      return { uri, mimeType: 'text/plain', text: `Unknown project resource: ${resourcePath}` };

    case 'scene':
      if (!isSafePath(pp, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readSceneResource(pp, resourcePath);

    case 'script':
      if (!isSafePath(pp, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readScriptResource(pp, resourcePath);

    case 'file':
      if (!isSafePath(pp, resourcePath)) return { uri, mimeType: 'text/plain', text: `Access denied: ${resourcePath}` };
      return readFileResource(pp, resourcePath);

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
  function scan(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (FORBIDDEN_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (ext) counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    } catch { /* skip */ }
  }
  scan(projectPath);
  return counts;
}
