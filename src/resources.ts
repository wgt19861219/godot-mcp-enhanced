// src/resources.ts — MCP Resources handler for godot:// URI scheme
//
// Exposes Godot project context via MCP Resources protocol so AI clients
// can discover and read project information without explicit tool calls.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname, sep } from 'path';
import { parseTscnSummary } from './tscn-parser.js';
import { parseConfigValue, safeRealPath } from './helpers.js';

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB — reject files larger than this

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
  // Resolve real paths to defeat symlinks and junction points
  const resolved = safeRealPath(resolve(projectPath, filePath));
  const normalizedRoot = safeRealPath(resolve(projectPath));
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

// ─── Built-in guides ────────────────────────────────────────────────────────

const GUIDES: Record<string, { name: string; description: string; text: string }> = {
  'getting-started': {
    name: 'Getting Started',
    description: 'Quick start guide for Godot MCP Enhanced',
    text: `# Getting Started with Godot MCP Enhanced

## Setup
1. Ensure Godot 4.x is installed and accessible via PATH or GODOT_PATH env var
2. Run the MCP server: \`npx godot-mcp-enhanced\`
3. For read-only mode: set \`READ_ONLY_MODE=true\`
4. For lite mode (14 core tools): add \`--lite\` flag
5. For minimal mode (6 core tools): add \`--minimal\` flag

## Core Workflow
1. **list_projects** — find Godot projects
2. **read_scene** / **inspect_node** — understand existing structure
3. **add_node** / **edit_node** — modify scenes
4. **write_script** / **edit_script** — create or edit GDScript
5. **save_scene** — persist changes
6. **run_and_verify** — validate the project runs correctly

## Safety Features
- **Confirmation Token**: Dangerous tools (remove_node, execute_gdscript, etc.) require a confirmation token
- **READ_ONLY_MODE**: Blocks all write operations
- **Lite mode**: Only 14 essential tools registered

## Tips
- Use \`execute_gdscript\` for operations not covered by dedicated tools
- Use \`query_scene_tree\` for runtime property values (not just .tscn parsing)
- Use \`batch_add_nodes\` to add multiple nodes efficiently
`,
  },
  'scene-workflow': {
    name: 'Scene Creation Workflow',
    description: 'Best practices for creating and modifying Godot scenes',
    text: `# Scene Creation Workflow

## Creating a New Scene
1. create_scene — creates .tscn with root node
2. add_node / batch_add_nodes — add child nodes
3. load_sprite — attach textures to Sprite2D nodes
4. edit_node — set position, scale, rotation, custom properties
5. save_scene — persist to disk

## Editing Existing Scenes
1. read_scene — parse .tscn to understand structure
2. inspect_node — deep-inspect a specific node's runtime state
3. edit_node — modify properties (supports Vector2/Vector3/Color as arrays)
4. add_node — add new children
5. remove_node — delete nodes (requires confirmation token)
6. save_scene — persist changes

## edit_node Property Types
- number: "opacity": 0.5
- string: "text": "Hello"
- boolean: "visible": true
- Vector2: "position": [100, 200]
- Vector3: "position": [1, 2, 3]
- Color: "modulate": [1, 0, 0, 1]

## Batch Operations
Use batch_add_nodes to add multiple nodes in one call.
`,
  },
  'script-development': {
    name: 'Script Development',
    description: 'GDScript writing and testing workflow',
    text: `# Script Development Workflow

## Writing Scripts
1. **read_script** — view existing GDScript
2. **write_script** — create new .gd files
3. **edit_script** — line-range or search-and-replace editing
4. **validate_scripts** — check syntax without running

## Testing Scripts
1. **execute_gdscript** — run GDScript snippets dynamically
   - Snippet mode: no extends, auto-wrapped with helpers
   - Full mode: extends SceneTree for complete control
   - Use _mcp_output(key, value) to return structured data
2. **run_and_verify** — full project validation with error analysis
3. **generate_test** + **run_tests** — GUT unit test framework

## Autoload Context
Set load_autoloads: true (default) to access project autoloads.
`,
  },
  'game-bridge': {
    name: 'Game Bridge (E2E Testing)',
    description: 'How to use the Game Bridge for live game interaction',
    text: `# Game Bridge — Live Game Interaction

## Installation
1. **game_bridge_install** — copies mcp_bridge.gd to project and registers autoload
2. Run the game — the bridge starts a TCP server on port 9081

## Querying Game State
- game_query method ping — check bridge is alive
- game_query method get_tree — full scene tree
- game_query method find_nodes — search by name/type
- game_query method get_node_properties — read properties
- game_query method get_performance — FPS, frame time

## Simulating Input
- game_input method send_key — keyboard events
- game_input method send_mouse_click — mouse clicks
- game_input method send_text — text input

## Waiting for Conditions
- game_wait method wait_for_node — check if node exists
- game_wait method wait_for_property — check property value

## Cleanup
- game_bridge_uninstall — removes autoload and script

## Architecture
TCP + NDJSON protocol, zero external dependencies.
`,
  },
  'troubleshooting': {
    name: 'Troubleshooting',
    description: 'Common issues and solutions',
    text: `# Troubleshooting Guide

## Godot Binary Not Found
Set GODOT_PATH env var or add Godot to PATH.

## Scene Save Fails
- Use relative path: res://scenes/main.tscn
- Run validate_project to check for missing references

## Confirmation Token Issues
Tokens expire after 3 minutes, single-use, max 100 pending.

## Game Bridge Connection Refused
- Ensure game is running with bridge autoload
- Check port 9081 is not blocked
- Look for "[MCP Bridge] Listening" in Godot output

## READ_ONLY_MODE
Set READ_ONLY_MODE=false or remove the env var.
`,
  },
  'hooks-setup': {
    name: 'Claude Code Hooks Setup',
    description: 'Auto-validate GDScript after edits via Claude Code hooks',
    text: `# Claude Code Hooks — Auto Validate GDScript

## Quick Setup (recommended)

Call \`setup_project_rules\` to auto-generate both hooks and CLAUDE.md rules:
\`\`\`
setup_project_rules(project_path="your/project/path")
\`\`\`
This creates \`.claude/settings.json\` with PostToolUse hook and appends validation rules to \`CLAUDE.md\`.

## What it does
After editing any .gd file via edit_script/write_script, Claude Code automatically reminds the AI to run validate_scripts.

## Setup (one-time)

Add to your Godot project's \`.claude/settings.json\`:

\`\`\`json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__godot__edit_script|mcp__godot__write_script",
        "hooks": [
          {
            "type": "command",
            "command": "echo '>>> GDScript file modified — you MUST call validate_scripts now to verify syntax.'"
          }
        ]
      }
    ]
  }
}
\`\`\`

## How it works
1. AI edits a .gd file via edit_script or write_script
2. Hook fires, outputting a reminder message
3. AI sees the message and calls validate_scripts on the changed file
4. If validation fails, AI rolls back the change

## Alternative: CLAUDE.md rule
Add to your project's CLAUDE.md:
> After every edit_script or write_script call, immediately run validate_scripts on the modified file. If validation fails, roll back the change.

Both approaches work. Hooks are automatic; CLAUDE.md rules are more flexible.

## Release Gate

Before publishing a new version of your Godot project, run verify_delivery as a quality gate:

\`\`\`
verify_delivery(scope="full", project_path="your/project/path")
\`\`\`

All four dimensions (scene_tree, script_health, performance, assertions) must pass.
If any dimension has errors, fix them before tagging a release.

Add this to your project's CLAUDE.md:
> Before committing a release version bump, run verify_delivery with scope="full". All dimensions must report no errors. Do not tag a release if verify_delivery reports failures.
`,
  },
};

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
  const scriptSize = statSync(fullPath).size;
  if (scriptSize > MAX_FILE_SIZE) {
    return { uri: `godot://script/${scriptPath}`, mimeType: 'text/plain', text: `ERROR: File too large (${(scriptSize / 1024 / 1024).toFixed(1)}MB, limit 1MB)` };
  }
  return { uri: `godot://script/${scriptPath}`, mimeType: 'text/x-gdscript', text: readFileSync(fullPath, 'utf-8') };
}

function readFileResource(projectPath: string, filePath: string): McpResourceContent {
  const fullPath = join(projectPath, filePath);
  if (!existsSync(fullPath)) {
    return { uri: `godot://file/${filePath}`, mimeType: 'text/plain', text: `ERROR: File not found: ${filePath}` };
  }
  const fileSize = statSync(fullPath).size;
  if (fileSize > MAX_FILE_SIZE) {
    return { uri: `godot://file/${filePath}`, mimeType: 'text/plain', text: `ERROR: File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB, limit 1MB)` };
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

  // Built-in guides
  for (const [id, guide] of Object.entries(GUIDES)) {
    resources.push({
      uri: `godot://guide/${id}`,
      name: guide.name,
      description: guide.description,
      mimeType: 'text/markdown',
    });
  }

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
  } catch (err) { console.debug('[resources] scanDirectory failed for', dir, err); return; }

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
  // Iterative URL decode to defeat double-encoding (consistent with resolveWithinRoot)
  let path: string;
  try {
    let decoded = rawPath;
    let prev = '';
    let iterations = 0;
    while (decoded !== prev && iterations < 20) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
      iterations++;
    }
    path = decoded;
  } catch {
    return { uri, mimeType: 'text/plain', text: `ERROR: Invalid encoded path: ${rawPath}` };
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

    case 'guide': {
      const guide = GUIDES[resourcePath];
      if (!guide) return { uri, mimeType: 'text/plain', text: `Unknown guide: ${resourcePath}. Available: ${Object.keys(GUIDES).join(', ')}` };
      return { uri, mimeType: 'text/markdown', text: guide.text };
    }

    default:
      return { uri, mimeType: 'text/plain', text: `Unknown resource category: ${category}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    } catch (err) { console.debug('[resources] scanning directory:', err); }
  }
  scan(projectPath, 0);
  return counts;
}
