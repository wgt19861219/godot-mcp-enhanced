import { join, basename, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { writeFileAtomicWithMode } from '../core/fs-atomic.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import {
  buildEngineVersion, buildRenderer, buildKeyPaths, buildMainScene,
  buildAutoloads, buildInputMap, buildPhysics, buildLayerNames, buildMcpMapping,
  buildTypeGuide, buildBestPractices, mergeSections, SECTION_ORDER, GODOT_MCP_RULES,
} from './claudemd-builder.js';
import { buildAgentsMdSections, mergeAgentsMd, AGENTS_SECTION_IDS as AGENTS_SECTIONS } from './agentsmd-builder.js';
import { DETAILED_RULE_TEMPLATES } from './rule-templates.js';
import {
  buildAdoptManifest, planReconcile, hashContent, countDeviations,
  type RulesManifest, type RulesMode,
} from './rules-manifest.js';
import { validatePath, resolveWithinRoot } from '../core/path-utils.js';
import { requireString, requireProjectPath } from '../core/args-validation.js';
import { scanFiles } from '../core/file-scanner.js';
import type { GodotConfig } from '../core/config-parser.js';
import { getScaffoldFiles, PROJECT_TEMPLATES, handleTemplateAction } from './code-templates.js';
import { scanScriptSandboxOrThrow } from './script.js';
import { getLogger } from '../core/logger.js';
import { projectWriteConfig, isAllowedConfigKey, validateConfigValue } from './project-config.js';

const ACTIONS = [
  'list_projects',
  'get_project_info',
  'list_files',
  'read_project_config',
  'create_project',
  'setup_project_rules',
  'write_config',
  // ── Template actions (merged from code-templates.ts, v0.18.0) ──
  'list_templates',
  'apply_template',
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
            enum: ['list_projects', 'get_project_info', 'list_files', 'read_project_config', 'create_project', 'setup_project_rules', 'write_config', 'list_templates', 'apply_template'],
            description: '操作类型。list_projects/get_project_info/list_files=项目查询, read_project_config/write_config=读写配置, create_project=建项目, setup_project_rules=分发项目规则, list_templates/apply_template=脚手架模板',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          search_dir: { type: 'string', description: '搜索目录（list_projects）', default: '.' },
          max_depth: { type: 'number', description: '最大搜索深度（默认 3，钳制上限 10）', default: 3 },
          extensions: { type: 'array', items: { type: 'string' }, description: '按扩展名过滤（如 [".gd", ".tscn"]）' },
          subdirectory: { type: 'string', description: '限定子目录' },
          project_name: { type: 'string', description: '项目名称（默认取文件夹名）', default: '' },
          renderer: { type: 'string', description: '渲染器："forward_plus"（默认）、"mobile"、"gl_compatibility"', default: 'forward_plus', enum: ['forward_plus', 'mobile', 'gl_compatibility'] },
          template: { type: 'string', description: '项目脚手架模板：2d-platformer / 3d-fps / visual-novel（默认空）', default: '' },
          hooks: { type: 'boolean', description: '创建 .claude/settings.json 的 PostToolUse hook（默认 true）', default: true },
          rules_mode: {
            type: 'string',
            enum: ['check', 'update', 'overwrite'],
            description: '规则文件 reconcile 模式：check（默认，只检测报告）/ update（覆盖版本过时且未动过的文件，保留用户动过的）/ overwrite（全覆盖含本地修改）',
            default: 'check',
          },
          claude_md: { type: 'boolean', description: '创建/追加 CLAUDE.md 验证规则（默认 true）', default: true },
          agents_md: { type: 'boolean', description: '创建/追加 AGENTS.md 项目规则（ZCode/Codex/Cursor 等遵循 AGENTS.md 标准的客户端读取，默认 true）', default: true },
          ci: { type: 'boolean', description: '生成 GitHub Actions CI workflow（默认 false）', default: false },
          godot_version: { type: 'string', description: 'CI 中使用的 Godot 版本（默认 4.7）', default: '4.7' },
          force: { type: 'boolean', description: '覆盖已有配置（默认 false）', default: false },
          key: { type: 'string', description: '配置键（write_config，如 "application/config/name"）' },
          value: { type: 'string', description: '配置值（write_config）' },
          // ── Template parameters (merged, v0.18.0) ──
          tag: { type: 'string', description: '模板：按标签过滤' },
          applies_to: { type: 'string', description: '模板：按适用类过滤' },
          template_id: { type: 'string', description: '模板：模板 ID（如 T008）' },
          script_path: { type: 'string', description: '模板：目标脚本路径' },
          variables: { type: 'object', description: '模板：变量覆盖', additionalProperties: { type: 'string' } },
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
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  switch (action) {
    case 'list_projects': {
      const searchDir = validatePath(requireString(args, 'search_dir'));
      // I-7 (2026-08-14 审查 P3): max_depth 钳制 ≤10——scan 逐层 readdirSync 递归,
      // AI 传 999 会扫全盘(search_dir 上层目录时尤其)。默认 3,上限 10 覆盖合理项目布局。
      // search_dir root 不做额外校验(用户定夺项:搜索语义天然跨目录)。
      const maxDepth = Math.min((args.max_depth as number) || 3, 10);
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
        } catch (err) { getLogger().debug('project', `scan directory: ${err instanceof Error ? err.message : err}`); }
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

      // A-07: Replaced inline countFiles with scanFiles
      const allFiles = scanFiles(p, [], { skipDotFiles: true });
      const stats: Record<string, number> = {};
      for (const f of allFiles) {
        const ext = '.' + f.split('.').pop()!;
        stats[ext] = (stats[ext] || 0) + 1;
      }

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

      // A-07: Replaced inline scan with scanFiles (empty array = all files)
      const extFilter = extensions && extensions.length > 0 ? extensions : [];
      const allFiles = scanFiles(target, extFilter, { skipDotFiles: true });
      const files = allFiles.map(f => f.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));

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
      // godot_version 接入:features / hello 串 / CI 模板统一从此参数派生(消除 "4.6" 硬编码漂移)。
      // config_version=5 对所有 Godot 4.x 成立(4.7 仍为 5),不做投机性 bump。
      // B-1 fix round 1 (2026-08-14): godot_version 直接拼接进 scripts/main.gd 与 CI
      // YAML,是第 4 个 .gd 写入面(quick_scene/create_files/apply_template 之后) —
      // 攻击输入如 `4.4")\n\tOS.execute("calc" # '` 可注入任意 GDScript。严格白名单校验。
      const godotVersion = parseGodotVersionArg(args);
      if (godotVersion === null) return invalidGodotVersionResult(args.godot_version);
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
        // 换行转义(2026-08-16 批 K P3):只转义 \ 与 " 时,project_name 含 \n/\r 可注入
        // 额外 config 段落(配置污染级,非 RCE;godot_version 注入面已由 3b80e36 白名单修复)。
        'config/name="' + projectName.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"',
        'run/main_scene="res://scenes/main.tscn"',
        'config/features=PackedStringArray("' + godotVersion + '")',
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
        // P0-2 (2026-09-11): 双 key 关文件日志,防并发实例共享 user://logs 的 RotatedFileLogger
        // rotate race(aigengame 实测:race 使 abort 伪装 engine_crashed)。必须写两个 key——
        // base key 默认 false,但 .pc feature-tag override 在桌面平台默认 true 且启动时获胜,
        // 只关 base 是 no-op。create_project 建的项目专供 MCP 自动化(单/多实例),无需文件日志。
        '[debug]',
        '',
        'file_logging/enable_file_logging=false',
        'file_logging/enable_file_logging.pc=false',
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
        "\tprint(\"Hello, Godot " + godotVersion + "!\")",
        '',
      ].join('\n');
      // B-1 fix round 1: 全仓所有 .gd 落盘前必须过沙箱扫描(script.ts B-1 不变式)。
      // godot_version 已过严格白名单,此处为纵深防御(防未来新参数再拼进 main.gd)。
      const mainGdGuard = scanScriptSandboxOrThrow(mainGd, join(p, 'scripts', 'main.gd'));
      if (mainGdGuard) return mainGdGuard;
      writeFileSync(join(p, 'scripts', 'main.gd'), mainGd, 'utf-8');

      // ── Template scaffold ──
      const templateName = (args.template as string) || '';
      let scaffoldInfo = '';
      if (templateName) {
        if (!PROJECT_TEMPLATES[templateName]) {
          return textResult(`Error: Unknown template "${templateName}". Available: ${Object.keys(PROJECT_TEMPLATES).join(', ')}`);
        }
        const scaffoldFiles = getScaffoldFiles(templateName, projectName);
        const tmpl = PROJECT_TEMPLATES[templateName];
        for (const sf of scaffoldFiles) {
          const fullPath = join(p, sf.path.replace(/\//g, process.platform === 'win32' ? '\\' : '/'));
          // B-1 fix round 1: projectName 是自由文本,被 getScaffoldFiles 拼进脚手架 .gd
          // 注释(`# ${className} — ${projectName}`),含换行即变活代码 — 无法格式白名单,
          // 落盘前过沙箱扫描(对齐 apply_template / batch create_files 范式)。
          const sandboxGuard = scanScriptSandboxOrThrow(sf.content, fullPath);
          if (sandboxGuard) return sandboxGuard;
          mkdirSync(fullPath.substring(0, fullPath.lastIndexOf(process.platform === 'win32' ? '\\' : '/')), { recursive: true });
          writeFileSync(fullPath, sf.content, 'utf-8');
        }
        // Update project.godot main_scene
        if (tmpl.mainScene) {
          const pgPath = join(p, 'project.godot');
          const pgContent = readFileSync(pgPath, 'utf-8');
          writeFileSync(pgPath, pgContent.replace(
            /run\/main_scene="[^"]*"/,
            `run/main_scene="${tmpl.mainScene}"`,
          ), 'utf-8');
        }
        scaffoldInfo = `\n  Template: ${templateName} (${scaffoldFiles.length} files generated)\n` +
          scaffoldFiles.map(f => `  ├── ${f.path}`).join('\n');
      }

      return textResult(
        `Project created successfully at ${p}\n\n` +
        `Structure:\n` +
        `  ├── project.godot      (name: ${projectName}, renderer: ${renderer})\n` +
        `  ├── scenes/main.tscn   (Node2D root + main.gd script)\n` +
        `  ├── scripts/main.gd    (_ready template)\n` +
        `  └── assets/            (empty)\n` +
        scaffoldInfo +
        `\n\nRun with: launch_editor(project_path="${p}")`
      );
    }

    case 'setup_project_rules': {
      const p = requireProjectPath(args);
      const doHooks = args.hooks !== false;
      const doClaudeMd = args.claude_md !== false;
      const doAgentsMd = args.agents_md !== false;
      const force = args.force === true;
      // mcpPkgPath 提升到 case 顶部：doClaudeMd 与 doAgentsMd 块共用
      const mcpPkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

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
            e => (e.hooks[0]?.command ?? '') === sessionStartEntry.hooks[0]!.command,
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
          ['## 代码最佳实践', () => buildBestPractices()],
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

        // ── rules files ──
        const rulesDir = join(p, '.claude', 'rules');
        mkdirSync(rulesDir, { recursive: true });

        // Read MCP version from package.json for template substitution
        //（base 与详细规则统一走 {{MCP_VERSION}} 插值，放在 base 段之前避免 TDZ）
        //（mcpPkgPath 已在 case 顶部声明，此处与 doAgentsMd 块共用）
        let mcpVersion = '0.16.0';
        try { mcpVersion = JSON.parse(readFileSync(mcpPkgPath, 'utf-8')).version || mcpVersion; } catch { /* fallback */ }

        // ── 规则文件 manifest 驱动（spec §3.6）──
        const manifestPath = join(rulesDir, '.godot-mcp-manifest.json');
        const rulesMode: RulesMode = (args.rules_mode as RulesMode) || 'check';

        // 当前模板内容（插值后），用于覆盖与偏离判断
        const baseContent = GODOT_MCP_RULES.replace(/\{\{MCP_VERSION\}\}/g, mcpVersion);
        const currentTemplates: Record<string, string> = { 'godot-mcp.md': baseContent };
        for (const [filename, tpl] of Object.entries(DETAILED_RULE_TEMPLATES)) {
          currentTemplates[filename] = tpl.replace(/\{\{MCP_VERSION\}\}/g, mcpVersion);
        }

        // 读现有 manifest（损坏当无 manifest，spec §6：不覆盖任何规则文件）
        let manifest: RulesManifest | null = null;
        if (existsSync(manifestPath)) {
          try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as RulesManifest;
          } catch {
            actions.push('rules-manifest: 损坏，按无 manifest 处理（adopt，不覆盖任何规则文件）');
            manifest = null;
          }
        }

        // 确保所有规则文件存在（任意 rules_mode 都先创建缺失文件）
        const allFilenames = ['godot-mcp.md', ...Object.keys(DETAILED_RULE_TEMPLATES)].sort();
        const diskFiles: { filename: string; content: string; source: 'base' | 'detail' }[] = [];
        for (const filename of allFilenames) {
          const filePath = join(rulesDir, filename);
          const source: 'base' | 'detail' = filename === 'godot-mcp.md' ? 'base' : 'detail';
          if (!existsSync(filePath)) {
            const tpl = currentTemplates[filename]!;
            writeAtomic(filePath, tpl);
            actions.push(`rules: created .claude/rules/${filename}`);
            diskFiles.push({ filename, content: tpl, source });
          } else {
            diskFiles.push({ filename, content: readFileSync(filePath, 'utf-8'), source });
          }
        }

        if (manifest === null) {
          // adopt（spec §5）：固化当前磁盘状态为基线
          const adopted = buildAdoptManifest({
            serverVersion: mcpVersion,
            now: new Date().toISOString(),
            files: diskFiles.map(f => ({ filename: f.filename, content: f.content, source: f.source })),
          });
          writeAtomic(manifestPath, JSON.stringify(adopted, null, 2));
          const dev = countDeviations(adopted, Object.fromEntries(
            diskFiles.map(f => [f.filename, hashContent(currentTemplates[f.filename]!)]),
          ));
          actions.push(`rules-manifest: 已采纳 ${diskFiles.length} 个文件（版本 ${mcpVersion}）`);
          if (dev > 0) {
            actions.push(`rules-manifest: ${dev} 个文件与当前模板不符（历史遗留或本地修改无法区分），如需对齐调 rules_mode=overwrite`);
          }
        } else {
          // reconcile（spec §3.6）：按二维判定 + mode 决策
          const plan = planReconcile({
            manifest,
            serverVersion: mcpVersion,
            diskFiles: diskFiles.map(f => ({ filename: f.filename, content: f.content })),
            currentTemplates,
            mode: rulesMode,
            now: new Date().toISOString(),
          });
          const written: string[] = [];
          const warned: string[] = [];
          for (const [filename, fp] of Object.entries(plan.actions)) {
            if (fp.action === 'write' && fp.newContent !== undefined) {
              writeAtomic(join(rulesDir, filename), fp.newContent);
              written.push(filename);
            } else if (fp.action === 'warn-keep') {
              warned.push(filename);
            }
          }
          if (plan.shouldWriteFiles) {
            writeAtomic(manifestPath, JSON.stringify(plan.newManifest, null, 2));
            if (written.length > 0) actions.push(`rules: 更新 ${written.length} 个文件（${written.join(', ')}）`);
            if (warned.length > 0) actions.push(`rules: 保留 ${warned.length} 个用户动过的文件（${warned.join(', ')}）— 版本过时但本地有修改，未覆盖；如需强制对齐调 rules_mode=overwrite`);
          } else {
            // check 模式：报告分类
            const byClass: Record<string, string[]> = {};
            for (const [fn, fp] of Object.entries(plan.actions)) {
              (byClass[fp.classification] ??= []).push(fn);
            }
            if (byClass['pure-upgrade']) actions.push(`rules: ${byClass['pure-upgrade'].length} 个文件可更新（版本过时）— 传 rules_mode=update 更新`);
            if (byClass['stale-and-modified']) actions.push(`rules: ${byClass['stale-and-modified'].length} 个文件版本过时且本地已修改 — update 会保留，overwrite 会覆盖`);
            if (byClass['local-modified']) actions.push(`rules: ${byClass['local-modified'].length} 个文件本地已修改（版本最新）`);
            if (byClass['latest'] && Object.keys(byClass).length === 1) actions.push('rules: 全部最新');
          }
        }
      }

      // ── AGENTS.md rules（ZCode 等遵循 AGENTS.md 标准的客户端）──
      if (doAgentsMd) {
        const agentsMdPath = join(p, 'AGENTS.md');

        // 独立 parse config（不引用 doClaudeMd 块内的 config：claude_md=false 时该块不执行）
        let configForAgents: GodotConfig | null;
        try {
          configForAgents = ctx.parseGodotConfig(readFileSync(join(p, 'project.godot'), 'utf-8')) as GodotConfig;
        } catch { configForAgents = null; }

        // 独立解析 mcpVersion（不引用 doClaudeMd 块内的 mcpVersion）
        let agentsMcpVersion = '0.16.0';
        try { agentsMcpVersion = JSON.parse(readFileSync(mcpPkgPath, 'utf-8')).version || agentsMcpVersion; } catch { /* fallback */ }

        const sectionsVersioned = buildAgentsMdSections(configForAgents, p, agentsMcpVersion);
        const projectName = configForAgents
          ? (configForAgents.application as Record<string, unknown>)?.['config/name'] || basename(p)
          : basename(p);

        if (existsSync(agentsMdPath)) {
          const existing = readFileSync(agentsMdPath, 'utf-8');
          const hasMcpSections = [...AGENTS_SECTIONS].some(h => existing.includes(h));
          if (hasMcpSections && !force) {
            actions.push('AGENTS.md: skipped (already configured, use force=true to update)');
          } else {
            writeAtomic(agentsMdPath, mergeAgentsMd(existing, sectionsVersioned));
            actions.push(force ? 'AGENTS.md: updated (force)' : 'AGENTS.md: merged new sections into existing file');
          }
        } else {
          const body = sectionsVersioned.map(([h, b]) => `${h}\n${b}`).join('\n\n');
          writeAtomic(agentsMdPath, `# ${projectName}\n\n${body}\n`);
          actions.push('AGENTS.md: created with project metadata');
        }
      }

      // ── CI workflow ──
      if (args.ci === true) {
        // B-1 fix round 1: godot_version 拼进 wget URL/文件名,注入面同 create_project
        const godotVersion = parseGodotVersionArg(args);
        if (godotVersion === null) return invalidGodotVersionResult(args.godot_version);
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

    case 'write_config': {
      const p = requireProjectPath(args);
      const cfgPath = join(p, 'project.godot');
      if (!existsSync(cfgPath)) return textResult(`Error: No project.godot found at ${p}`);

      const key = requireString(args, 'key');
      const value = requireString(args, 'value');

      // Pre-flight validation for clearer error messages
      if (!isAllowedConfigKey(key)) {
        return textResult(`Error: Key "${key}" is not in the allowed whitelist for write_config.`);
      }
      const validation = validateConfigValue(key, value);
      if (!validation.valid) {
        return textResult(`Error: Invalid value for "${key}": ${validation.error}`);
      }

      const original = readFileSync(cfgPath, 'utf-8');
      const result = projectWriteConfig(original, key, value);
      if (!result.success) {
        return textResult(`Error: ${result.error}`);
      }

      writeAtomic(cfgPath, result.content!);
      // 批4-T3(五维评估 P1): 写前旧值经 structuredContent._audit 上报——audit middleware/
      // _auditConfirmedExecution 提取进审计 details.before_values(suggest_rollback 的恢复
      // 数据源,批4 前该字段零生产者是死路径),并在返回 MCP 客户端前剥离(extractAuditHint)。
      // key 原本不存在时记 null(显式"原本无值",区别于 undefined 的"未上报")。
      const oldValue = (ctx.parseGodotConfig(original) as Record<string, unknown>)[key];
      return {
        ...textResult(JSON.stringify({
          success: true,
          key,
          value,
          message: `Config "${key}" updated successfully.`,
        }, null, 2)),
        structuredContent: { _audit: { before_values: { [key]: oldValue ?? null } } },
      };
    }

    // ── Template actions (merged from code-templates.ts, v0.18.0) ──
    case 'list_templates':
    case 'apply_template': {
      return handleTemplateAction(action, args, ctx);
    }

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  project: {
    readonly: false,
    long_running: false,
    // H-1: 有真实副作用的 action 标 'write'（建目录+多文件、改 project.godot、写
    // .claude/settings.json + CLAUDE.md + rules、注入 PostToolUse hook、生成脚手架多文件）
    // → requiresConfirmation(guard.ts:64 读 actionRisks) 对这些 action 返回 true，触发确认。
    // 纯查询 action 保持 'read'。project 已加入 risk-coverage.test.ts 的 GUARDED_KEYS。
    actionRisks: {
      list_projects: 'read',
      get_project_info: 'read',
      list_files: 'read',
      read_project_config: 'read',
      create_project: 'write',
      setup_project_rules: 'write',
      write_config: 'write',
      list_templates: 'read',
      apply_template: 'write',
    },
  },
};

// ─── CI template generator ────────────────────────────────────────────────────

export function generateCiTemplate(godotVersion: string = '4.7'): string {
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

// B-1 fix round 1 (2026-08-14): godot_version 格式校验。
// 威胁模型:该参数直接字符串拼接进 scripts/main.gd(print Hello 串,main.tscn 绑
// ExtResource 后 run_project 即执行)与 CI workflow 的 wget URL/文件名 — 严格
// X.Y / X.Y.Z 数字白名单,拒绝一切引号/换行/括号等注入载体。
// Fix round 1 concern 1: 追加可选 pre-release 后缀 `-[A-Za-z0-9.]+`(Godot 官方
// 命名如 4.4.1-rc1 / 4.4-beta2),救活 generateCiTemplate 的 includes('-') 分支;
// 后缀字符集仅字母/数字/点,无引号/换行/括号等注入载体,注入面保持封闭。
const GODOT_VERSION_RE = /^\d+\.\d+(\.\d+)?(-[A-Za-z0-9.]+)?$/;

/** 解析并校验 args.godot_version。缺省返回 '4.7';非法格式返回 null(调用方 return
 *  invalidGodotVersionResult)。非 string 类型(如 number)同样拒绝。 */
function parseGodotVersionArg(args: Record<string, unknown>): string | null {
  const raw = args.godot_version;
  if (raw === undefined || raw === null || raw === '') return '4.7';
  if (typeof raw !== 'string' || !GODOT_VERSION_RE.test(raw)) return null;
  return raw;
}

/** godot_version 非法时的统一错误结果(create_project 与 setup_project_rules CI 共用)。 */
function invalidGodotVersionResult(raw: unknown): ToolResult {
  return opsErrorResult(
    'INVALID_PARAMS',
    `Invalid godot_version ${JSON.stringify(raw ?? null)}: must be "X.Y", "X.Y.Z" or "X.Y.Z-pre" pre-release format (e.g. 4.4, 4.7.1, 4.4.1-rc1; suffix charset: letters/digits/dots only). ` +
    'The value is embedded into generated main.gd and CI workflow files, so only strict numeric formats are accepted.',
  );
}

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
  // I-1: 统一走 temp+rename(NTFS 同盘 rename 原子);Windows 上目标被 IDE/Claude Code
  // 锁定导致 rename 失败时降级直写保可用。
  // A-ATOMIC (2026-09-01): 实现上移至 src/core/fs-atomic.ts(三份重复实现合并,并集
  // 语义另含 mode 保持与随机 tmp 后缀),此处保留签名薄委托。
  writeFileAtomicWithMode(filePath, content);
}
