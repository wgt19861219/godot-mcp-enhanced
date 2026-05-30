import { join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import {
  buildEngineVersion, buildRenderer, buildKeyPaths, buildMainScene,
  buildAutoloads, buildInputMap, buildPhysics, buildLayerNames, buildMcpMapping,
  buildTypeGuide, mergeSections, SECTION_ORDER, GODOT_MCP_RULES,
} from './claudemd-builder.js';
import { validatePath, requireString, requireProjectPath, resolveWithinRoot, type GodotConfig } from '../helpers.js';

const ACTIONS = [
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
      name: 'project',
      description: '搜索 Godot 项目、获取项目信息、列出文件、读取配置、创建项目、设置项目规则。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_projects', 'get_project_info', 'list_files', 'read_project_config', 'create_project', 'setup_project_rules'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          search_dir: { type: 'string', description: '搜索目录（list_projects）', default: '.' },
          max_depth: { type: 'number', description: '最大搜索深度（默认 3）', default: 3 },
          extensions: { type: 'array', items: { type: 'string' }, description: '按扩展名过滤（如 [".gd", ".tscn"]）' },
          subdirectory: { type: 'string', description: '限定子目录' },
          project_name: { type: 'string', description: '项目名称（默认取文件夹名）', default: '' },
          renderer: { type: 'string', description: '渲染器："forward_plus"（默认）、"mobile"、"gl_compatibility"', default: 'forward_plus', enum: ['forward_plus', 'mobile', 'gl_compatibility'] },
          hooks: { type: 'boolean', description: '创建 .claude/settings.json 的 PostToolUse hook（默认 true）', default: true },
          claude_md: { type: 'boolean', description: '创建/追加 CLAUDE.md 验证规则（默认 true）', default: true },
          ci: { type: 'boolean', description: '生成 GitHub Actions CI workflow（默认 false）', default: false },
          godot_version: { type: 'string', description: 'CI 中使用的 Godot 版本（默认 4.4）', default: '4.4' },
          force: { type: 'boolean', description: '覆盖已有配置（默认 false）', default: false },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'project') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return null;

  switch (action) {
    case 'list_projects': {
      const searchDir = validatePath(requireString(args, 'search_dir'));
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
        } catch (err) { console.debug('[project] scan directory:', err); }
      }

      scan(searchDir, 0);
      return textResult(JSON.stringify({ count: projects.length, projects }, null, 2));
    }

    case 'get_project_info': {
      const p = requireProjectPath(args);
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
        } catch (err) { console.debug('[project] count files:', err); }
      }
      countFiles(p, 0);

      return textResult(JSON.stringify({
        name: (config.application as Record<string, unknown> | undefined)?.name as string || basename(p),
        config,
        file_stats: stats,
      }, null, 2));
    }

    case 'list_files': {
      const p = requireProjectPath(args);
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
        } catch (err) { console.debug('[project] list files scan:', err); }
      }
      scan(target);

      return textResult(JSON.stringify({ count: files.length, files }, null, 2));
    }

    case 'read_project_config': {
      const p = requireProjectPath(args);
      const cfgPath = join(p, 'project.godot');
      if (!existsSync(cfgPath)) return textResult(`No project.godot found at ${p}`);

      const cfg = readFileSync(cfgPath, 'utf-8');
      const config = ctx.parseGodotConfig(cfg);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'create_project': {
      const p = requireProjectPath(args);
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
      const p = requireProjectPath(args);
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

        // PostToolUse hooks for different file types
        const hookEntries: HookEntry[] = [
          {
            matcher: 'mcp__godot__edit_script|mcp__godot__write_script',
            hooks: [{
              type: 'command',
              command: "echo '>>> GDScript file modified — you MUST call validate_scripts now to verify syntax.'",
            }],
          },
          {
            matcher: 'mcp__godot__scene|mcp__godot__batch',
            hooks: [{
              type: 'command',
              command: "echo '>>> Scene/resource file modified — you SHOULD call save_scene to persist changes.'",
            }],
          },
          {
            matcher: 'mcp__godot__material',
            hooks: [{
              type: 'command',
              command: "echo '>>> Shader/material modified — consider calling validate_scripts to verify.'",
            }],
          },
        ];

        // SessionStart hook
        const sessionStartEntry: SessionStartEntry = {
          hooks: [{
            type: 'command',
            command: "echo '>>> Session started — ensure Godot 4.4+ is installed and GODOT_MCP_NO_FALLBACK is set if needed.'",
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
          // Check if all PostToolUse matchers are already present
          const existingMatchers = new Set((postHooks ?? []).map(h => h.matcher));
          const allConfigured = hookEntries.every(he => existingMatchers.has(he.matcher));
          // Check if SessionStart is already configured
          const ssConfigured = (existing.hooks?.SessionStart ?? []).some(
            e => (e.hooks[0]?.command ?? '') === sessionStartEntry.hooks[0].command,
          );

          if (allConfigured && ssConfigured && !force) {
            actions.push('hooks: skipped (already configured, use force=true to overwrite)');
          } else {
            let current = existing;
            // Merge/replace each PostToolUse hookEntry
            for (const he of hookEntries) {
              const hasMatcher = existingMatchers.has(he.matcher);
              current = (force && hasMatcher) ? replaceHookEntry(current, he) : mergeHooks(current, he);
            }
            // Merge/replace SessionStart entry
            if (ssConfigured && force) {
              current = replaceSessionStart(current, sessionStartEntry);
            } else if (!ssConfigured) {
              current = mergeSessionStart(current, sessionStartEntry);
            }
            writeAtomic(settingsPath, JSON.stringify(current, null, 2));
            actions.push(force ? 'hooks: updated .claude/settings.json (force)' : 'hooks: updated .claude/settings.json');
          }
        } else if (existing === null && existsSync(settingsPath)) {
          // JSON parse failed — don't touch the file
        } else {
          mkdirSync(claudeDir, { recursive: true });
          writeAtomic(settingsPath, JSON.stringify({
            hooks: {
              PostToolUse: hookEntries,
              SessionStart: [sessionStartEntry],
            },
          }, null, 2));
          actions.push('hooks: created .claude/settings.json');
        }
      }

      // ── CLAUDE.md rules ──
      if (doClaudeMd) {
        const claudeMdPath = join(p, 'CLAUDE.md');

        // Parse project.godot for metadata
        const cfgPath = join(p, 'project.godot');
        let config: GodotConfig | null = null;
        try {
          const cfgContent = readFileSync(cfgPath, 'utf-8');
          config = ctx.parseGodotConfig(cfgContent) as GodotConfig;
        } catch {
          actions.push('CLAUDE.md: warning — project.godot parse failed, using minimal rules');
        }

        // Build sections
        const sections: Array<[string, string]> = [];
        const builders: Array<[string, () => string | null]> = [
          ['## 引擎版本', () => buildEngineVersion(config)],
          ['## 渲染器', () => buildRenderer(config)],
          ['## 项目关键路径', () => buildKeyPaths(p)],
          ['## 主场景', () => buildMainScene(config)],
          ['## Autoload', () => buildAutoloads(config)],
          ['## Input Map', () => buildInputMap(config)],
          ['## 物理设置', () => buildPhysics(config)],
          ['## 层级名称', () => buildLayerNames(config)],
          ['## MCP 规则映射', () => buildMcpMapping()],
          ['## GDScript 类型规范', () => buildTypeGuide()],
        ];

        for (const [header, builder] of builders) {
          const body = builder();
          if (body !== null) {
            sections.push([header, body]);
          }
        }

        if (existsSync(claudeMdPath)) {
          if (!force) {
            // Check if MCP sections already present (idempotency)
            const existing = readFileSync(claudeMdPath, 'utf-8');
            const hasMcpSections = SECTION_ORDER.some(h => existing.includes(h));
            if (hasMcpSections) {
              actions.push('CLAUDE.md: skipped (already configured, use force=true to update)');
            } else {
              const merged = mergeSections(existing, sections);
              writeAtomic(claudeMdPath, merged);
              actions.push('CLAUDE.md: merged new sections into existing file');
            }
          } else {
            // force: still merge (preserves user sections) but skip idempotency check
            const existing = readFileSync(claudeMdPath, 'utf-8');
            const merged = mergeSections(existing, sections);
            writeAtomic(claudeMdPath, merged);
            actions.push('CLAUDE.md: updated (force)');
          }
        } else {
          const content = sections.map(([h, b]) => `${h}\n${b}`).join('\n\n') + '\n';
          const projectName = config
            ? (config.application as Record<string, unknown>)?.['config/name'] || basename(p)
            : basename(p);
          writeAtomic(claudeMdPath, `# ${projectName}\n\n${content}`);
          actions.push('CLAUDE.md: created with project metadata');
        }

        // ── rules file ──
        const rulesDir = join(p, '.claude', 'rules');
        const rulesPath = join(rulesDir, 'godot-mcp.md');
        if (!existsSync(rulesPath)) {
          mkdirSync(rulesDir, { recursive: true });
          writeAtomic(rulesPath, GODOT_MCP_RULES);
          actions.push('rules: created .claude/rules/godot-mcp.md');
        } else if (force) {
          actions.push('rules: skipped (file exists, will not overwrite user modifications)');
        }
      }

      // ── CI workflow ──
      if (args.ci === true) {
        const godotVersion = (args.godot_version as string) || '4.4';
        const githubDir = join(p, '.github', 'workflows');
        const ciPath = join(githubDir, 'godot-ci.yml');

        if (existsSync(ciPath) && !force) {
          actions.push('ci: skipped (.github/workflows/godot-ci.yml exists, use force=true to overwrite)');
        } else {
          mkdirSync(githubDir, { recursive: true });
          writeAtomic(ciPath, generateCiTemplate(godotVersion));
          actions.push(`ci: created .github/workflows/godot-ci.yml (Godot ${godotVersion})`);
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
  project: { readonly: false, long_running: false },
};

// ─── CI template generator ────────────────────────────────────────────────────

export function generateCiTemplate(godotVersion: string = '4.4'): string {
  const downloadVersion = godotVersion.includes('-') ? godotVersion : `${godotVersion}-stable`;
  const baseUrl = 'https://github.com/godotengine/godot/releases/download';
  const filename = `Godot_v${downloadVersion}_linux.x86_64`;

  return `name: Godot CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Godot ${downloadVersion}
        run: |
          wget -q ${baseUrl}/${downloadVersion}/${filename}.zip
          unzip ${filename}.zip
          chmod +x ${filename}
          sudo mv ${filename} /usr/local/bin/godot
      - name: Import project resources
        run: godot --headless --import --path .
      - name: Validate scripts
        run: godot --headless --check-only --path . 2>&1 | tee validate.log
      - name: Check for errors
        run: |
          if grep -qi "script error\\|parse error\\|invalid" validate.log; then
            echo "Validation failed!"
            exit 1
          fi
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookEntry { matcher: string; hooks: Array<{ type: string; command: string }> }
interface SessionStartEntry { hooks: Array<{ type: string; command: string }> }
interface SettingsHooks {
  PostToolUse: HookEntry[];
  SessionStart?: SessionStartEntry[];
}
interface ClaudeSettings { [key: string]: unknown; hooks?: { PostToolUse?: HookEntry[]; SessionStart?: SessionStartEntry[] } }

function mergeHooks(existing: ClaudeSettings, hookEntry: HookEntry): ClaudeSettings {
  const hooks: SettingsHooks = {
    ...existing.hooks,
    PostToolUse: [...(existing.hooks?.PostToolUse ?? [])],
  };
  hooks.PostToolUse.push(hookEntry);
  return { ...existing, hooks };
}

function replaceHookEntry(existing: ClaudeSettings, hookEntry: HookEntry): ClaudeSettings {
  const filtered = (existing.hooks?.PostToolUse ?? []).filter(h => h.matcher !== hookEntry.matcher);
  filtered.push(hookEntry);
  const hooks: SettingsHooks = { ...existing.hooks, PostToolUse: filtered };
  return { ...existing, hooks };
}

function mergeSessionStart(existing: ClaudeSettings, entry: SessionStartEntry): ClaudeSettings {
  const hooks: SettingsHooks = {
    ...existing.hooks,
    PostToolUse: existing.hooks?.PostToolUse ?? [],
    SessionStart: [...(existing.hooks?.SessionStart ?? []), entry],
  };
  return { ...existing, hooks };
}

function replaceSessionStart(existing: ClaudeSettings, entry: SessionStartEntry): ClaudeSettings {
  // Deduplicate by first hook command text
  const existingSS = existing.hooks?.SessionStart ?? [];
  const cmd = entry.hooks[0]?.command ?? '';
  const filtered = existingSS.filter(e => (e.hooks[0]?.command ?? '') !== cmd);
  filtered.push(entry);
  const hooks: SettingsHooks = { ...existing.hooks, PostToolUse: existing.hooks?.PostToolUse ?? [], SessionStart: filtered };
  return { ...existing, hooks };
}

function writeAtomic(filePath: string, content: string): void {
  if (process.platform === 'win32') {
    // Windows: renameSync fails if target is locked (VS Code, etc.)
    // 非原子写入，低概率下进程崩溃可能留下部分写入的文件
    writeFileSync(filePath, content, 'utf-8');
    return;
  }
  const tmp = filePath + '.mcp-tmp';
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch (err) { console.debug('[project] cleanup temp file:', err); }
    throw e;
  }
}
