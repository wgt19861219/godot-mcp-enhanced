import { join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot } from '../helpers.js';

const TOOL_NAMES = [
  'list_projects',
  'get_project_info',
  'list_files',
  'read_project_config',
  'create_project',
  'setup_project_rules',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'list_projects',
      description: 'Search for Godot projects in a directory.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          search_dir: { type: 'string', description: 'Directory to search in', default: '.' },
          max_depth: { type: 'number', description: 'Max directory depth (default: 3)', default: 3 },
        },
        required: ['search_dir'],
      },
    },
    {
      name: 'get_project_info',
      description: 'Get detailed info about a Godot project (name, version, file stats).',
      inputSchema: {
        type: 'object' as const,
        properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
        required: ['project_path'],
      },
    },
    {
      name: 'list_files',
      description: 'List files in a Godot project with optional filtering.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'Filter by extensions (e.g. [".gd", ".tscn"])' },
          subdirectory: { type: 'string', description: 'Restrict to a subdirectory' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'read_project_config',
      description: 'Parse project.godot into structured JSON.',
      inputSchema: {
        type: 'object' as const,
        properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
        required: ['project_path'],
      },
    },
    {
      name: 'create_project',
      description: 'Create a complete Godot 4.6 project structure with project.godot, main scene, main script, and assets directory.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Directory path where the project will be created' },
          project_name: { type: 'string', description: 'Project name (default: folder name)', default: '' },
          renderer: { type: 'string', description: 'Renderer to use: "forward_plus" (default), "mobile", or "gl_compatibility"', default: 'forward_plus', enum: ['forward_plus', 'mobile', 'gl_compatibility'] },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'setup_project_rules',
      description: 'One-time setup: generate Claude Code hooks and CLAUDE.md rules for a Godot project. Creates .claude/settings.json with PostToolUse hook for auto GDScript validation, and appends verify_delivery release gate rule to CLAUDE.md. Recommended to run this once when starting work on a new Godot project.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          hooks: { type: 'boolean', description: 'Create .claude/settings.json with PostToolUse hook (default: true)', default: true },
          claude_md: { type: 'boolean', description: 'Create/append CLAUDE.md with validation rules (default: true)', default: true },
          force: { type: 'boolean', description: 'Overwrite existing configuration (default: false)', default: false },
        },
        required: ['project_path'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'list_projects': {
      const searchDir = validatePath(args.search_dir as string);
      const maxDepth = (args.max_depth as number) || 3;
      const projects: string[] = [];

      function scan(dir: string, depth: number): void {
        if (depth > maxDepth) return;
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          if (entries.some(e => e.name === 'project.godot' && e.isFile())) {
            projects.push(dir);
            return;
          }
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              scan(join(dir, entry.name), depth + 1);
            }
          }
        } catch { /* permission error */ }
      }

      scan(searchDir, 0);
      return textResult(JSON.stringify({ count: projects.length, projects }, null, 2));
    }

    case 'get_project_info': {
      const p = validatePath(args.project_path as string);
      const cfgPath = join(p, 'project.godot');
      if (!existsSync(cfgPath)) return textResult(`No project.godot found at ${p}`);

      const cfg = readFileSync(cfgPath, 'utf-8');
      const config = ctx.parseGodotConfig(cfg);

      const stats: Record<string, number> = {};
      function countFiles(dir: string, depth: number): void {
        if (depth > 10) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
            if (entry.isDirectory()) {
              countFiles(join(dir, entry.name), depth + 1);
            } else if (ext) {
              stats[ext] = (stats[ext] || 0) + 1;
            }
          }
        } catch { /* skip */ }
      }
      countFiles(p, 0);

      return textResult(JSON.stringify({
        name: (config.application as Record<string, unknown> | undefined)?.name as string || basename(p),
        config,
        file_stats: stats,
      }, null, 2));
    }

    case 'list_files': {
      const p = validatePath(args.project_path as string);
      const extensions = args.extensions as string[] | undefined;
      const subdir = args.subdirectory as string | undefined;
      const target = subdir ? resolveWithinRoot(p, subdir) : p;
      const files: string[] = [];

      function scan(dir: string): void {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              scan(full);
            } else {
              const ext = '.' + entry.name.split('.').pop();
              if (!extensions || extensions.includes(ext)) {
                files.push(full.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
              }
            }
          }
        } catch { /* skip */ }
      }
      scan(target);

      return textResult(JSON.stringify({ count: files.length, files }, null, 2));
    }

    case 'read_project_config': {
      const p = validatePath(args.project_path as string);
      const cfgPath = join(p, 'project.godot');
      if (!existsSync(cfgPath)) return textResult(`No project.godot found at ${p}`);

      const cfg = readFileSync(cfgPath, 'utf-8');
      const config = ctx.parseGodotConfig(cfg);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'create_project': {
      const p = validatePath(args.project_path as string);
      const projectName = (args.project_name as string) || basename(p);
      const renderer = (args.renderer as string) || 'forward_plus';
      const validRenderers = ['forward_plus', 'mobile', 'gl_compatibility'];
      if (!validRenderers.includes(renderer)) {
        return textResult(`Error: Invalid renderer "${renderer}". Must be one of: ${validRenderers.join(', ')}`);
      }

      if (existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: project.godot already exists at ${p}. This directory appears to be an existing Godot project.`);
      }

      mkdirSync(join(p, 'scenes'), { recursive: true });
      mkdirSync(join(p, 'scripts'), { recursive: true });
      mkdirSync(join(p, 'assets'), { recursive: true });

      const projectGodot = [
        '; Engine configuration file.',
        'config_version=5',
        '',
        '[application]',
        '',
        'config/name="' + projectName.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"',
        'run/main_scene="res://scenes/main.tscn"',
        'config/features=PackedStringArray("4.6")',
        '',
        '[display]',
        '',
        'window/size/viewport_width=1280',
        'window/size/viewport_height=720',
        '',
        '[rendering]',
        '',
        'renderer="' + renderer + '"',
        '',
      ].join('\n');
      writeFileSync(join(p, 'project.godot'), projectGodot, 'utf-8');

      const mainTscn = [
        `[gd_scene load_steps=2 format=3 uid="uid://${randomUUID().replace(/-/g, 'a').slice(0, 12)}"]`,
        '',
        '[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]',
        '',
        '[node name="Main" type="Node2D"]',
        'script = ExtResource("1_main")',
        '',
      ].join('\n');
      writeFileSync(join(p, 'scenes', 'main.tscn'), mainTscn, 'utf-8');

      const mainGd = [
        'extends Node2D',
        '',
        'func _ready() -> void:',
        "\tprint(\"Hello, Godot 4.6!\")",
        '',
      ].join('\n');
      writeFileSync(join(p, 'scripts', 'main.gd'), mainGd, 'utf-8');

      return textResult(
        `Project created successfully at ${p}\n\n` +
        `Structure:\n` +
        `  ├── project.godot      (name: ${projectName}, renderer: ${renderer})\n` +
        `  ├── scenes/main.tscn   (Node2D root + main.gd script)\n` +
        `  ├── scripts/main.gd    (_ready template)\n` +
        `  └── assets/            (empty)\n\n` +
        `Run with: launch_editor(project_path="${p}")`
      );
    }

    case 'setup_project_rules': {
      const p = validatePath(args.project_path as string);
      const doHooks = args.hooks !== false;
      const doClaudeMd = args.claude_md !== false;
      const force = args.force === true;

      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: No project.godot found at ${p}. Not a Godot project.`);
      }

      const report: Record<string, unknown> = { project_path: p };
      const actions: string[] = [];

      // ── Hooks: .claude/settings.json ──
      if (doHooks) {
        const claudeDir = join(p, '.claude');
        const settingsPath = join(claudeDir, 'settings.json');
        const hookEntry = {
          matcher: 'mcp__godot__edit_script|mcp__godot__write_script',
          hooks: [{
            type: 'command',
            command: "echo '>>> GDScript file modified — you MUST call validate_scripts now to verify syntax.'",
          }],
        };

        let existing: ClaudeSettings | null = null;
        if (existsSync(settingsPath)) {
          try {
            existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          } catch {
            actions.push('hooks: ERROR — existing settings.json is invalid JSON. Fix manually or delete it first.');
            existing = null;
          }
        }

        if (existing) {
          const postHooks = existing.hooks?.PostToolUse;
          const alreadyConfigured = Array.isArray(postHooks) && postHooks.some(h => h.matcher === hookEntry.matcher);
          if (alreadyConfigured && !force) {
            actions.push('hooks: skipped (already configured, use force=true to overwrite)');
          } else {
            // force: remove old entry with same matcher, then append new one
            const merged = force && alreadyConfigured ? replaceHookEntry(existing, hookEntry) : mergeHooks(existing, hookEntry);
            writeAtomic(settingsPath, JSON.stringify(merged, null, 2));
            actions.push(force ? 'hooks: updated .claude/settings.json (force)' : 'hooks: updated .claude/settings.json');
          }
        } else if (existing === null && existsSync(settingsPath)) {
          // JSON parse failed — don't touch the file
        } else {
          mkdirSync(claudeDir, { recursive: true });
          writeAtomic(settingsPath, JSON.stringify({ hooks: { PostToolUse: [hookEntry] } }, null, 2));
          actions.push('hooks: created .claude/settings.json');
        }
      }

      // ── CLAUDE.md rules ──
      if (doClaudeMd) {
        const claudeMdPath = join(p, 'CLAUDE.md');
        const rules = [
          '',
          '## Godot MCP Rules',
          '- After every edit_script or write_script call, immediately run validate_scripts on the modified file. If validation fails, roll back the change.',
          '- Before committing a release version bump, run verify_delivery with scope="full". All dimensions must report no errors.',
        ];

        if (existsSync(claudeMdPath)) {
          const existing = readFileSync(claudeMdPath, 'utf-8');
          if (existing.includes('## Godot MCP Rules') && !force) {
            actions.push('CLAUDE.md: skipped (rules already present, use force=true to overwrite)');
          } else if (existing.includes('## Godot MCP Rules') && force) {
            const lines = existing.split('\n');
            const startIdx = lines.findIndex(l => l.trim() === '## Godot MCP Rules');
            let endIdx = lines.length;
            for (let i = startIdx + 1; i < lines.length; i++) {
              if (/^## /.test(lines[i])) { endIdx = i; break; }
            }
            const newBlock = rules.slice(1).join('\n');
            lines.splice(startIdx, endIdx - startIdx, newBlock);
            writeAtomic(claudeMdPath, lines.join('\n') + '\n');
            actions.push('CLAUDE.md: updated rules (force)');
          } else {
            writeAtomic(claudeMdPath, existing + rules.join('\n') + '\n');
            actions.push('CLAUDE.md: appended rules');
          }
        } else {
          writeAtomic(claudeMdPath, '# Godot Project\n' + rules.join('\n') + '\n');
          actions.push('CLAUDE.md: created with rules');
        }
      }

      report.actions = actions;
      return textResult(JSON.stringify(report, null, 2));
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  list_projects: { readonly: true, long_running: false },
  get_project_info: { readonly: true, long_running: false },
  list_files: { readonly: true, long_running: false },
  read_project_config: { readonly: true, long_running: false },
  create_project: { readonly: false, long_running: false },
  setup_project_rules: { readonly: false, long_running: false },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookEntry { matcher: string; hooks: Array<{ type: string; command: string }> }
interface SettingsHooks { PostToolUse: HookEntry[] }
interface ClaudeSettings { [key: string]: unknown; hooks?: { PostToolUse?: HookEntry[] } }

function mergeHooks(existing: ClaudeSettings, hookEntry: HookEntry): ClaudeSettings {
  const hooks: SettingsHooks = { PostToolUse: [...(existing.hooks?.PostToolUse ?? [])] };
  hooks.PostToolUse.push(hookEntry);
  return { ...existing, hooks };
}

function replaceHookEntry(existing: ClaudeSettings, hookEntry: HookEntry): ClaudeSettings {
  const filtered = (existing.hooks?.PostToolUse ?? []).filter(h => h.matcher !== hookEntry.matcher);
  filtered.push(hookEntry);
  const hooks: SettingsHooks = { PostToolUse: filtered };
  return { ...existing, hooks };
}

function writeAtomic(filePath: string, content: string): void {
  if (process.platform === 'win32') {
    // Windows: renameSync fails if target is locked (VS Code, etc.)
    writeFileSync(filePath, content, 'utf-8');
    return;
  }
  const tmp = filePath + '.mcp-tmp';
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
