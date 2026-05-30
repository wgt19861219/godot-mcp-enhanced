import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/project.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir;

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({
      application: {
        name: 'TestProject',
        'config/name': 'TestProject',
        'run/main_scene': 'res://scenes/main.tscn',
        'config/features': 'PackedStringArray("4.6")',
      },
      rendering: { 'renderer/rendering_method': 'forward_plus' },
    })),
  };
}

function makeTempDir() {
  tempDir = mkdtempSync(join(tmpdir(), 'godot-test-'));
  return tempDir;
}

function makeGodotProject(dir) {
  const projectGodot = [
    '; Engine config',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="TestGame"',
    'run/main_scene="res://scenes/main.tscn"',
    'config/features=PackedStringArray("4.6")',
    '',
    '[rendering]',
    '',
    'renderer/rendering_method="forward_plus"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'project.godot'), projectGodot, 'utf-8');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'player.gd'), 'extends Node2D', 'utf-8');
  writeFileSync(join(dir, 'scenes', 'main.tscn'), '[gd_scene]', 'utf-8');
}

// Helper: call handleTool with action-based args (merged tool)
function callProject(action, extraArgs = {}, ctx = createMockCtx()) {
  return handleTool('project', { action, ...extraArgs }, ctx);
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('project-tools getToolDefinitions', () => {
  it('returns a single merged tool definition named "project"', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('project');
  });

  it('definition has action enum with all 6 operations', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('list_projects');
    expect(actionEnum).toContain('get_project_info');
    expect(actionEnum).toContain('list_files');
    expect(actionEnum).toContain('read_project_config');
    expect(actionEnum).toContain('create_project');
    expect(actionEnum).toContain('setup_project_rules');
  });

  it('definition has name, description, and inputSchema', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('project-tools TOOL_META', () => {
  it('has single entry for merged "project" tool', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.project).toBeDefined();
  });

  it('marks project as non-readonly (contains write operations)', () => {
    expect(TOOL_META.project.readonly).toBe(false);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('project-tools handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });

  it('returns null for tool name that is not "project"', async () => {
    const result = await handleTool('list_projects', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — list_projects ─────────────────────────────────────────────

describe('project-tools handleTool — list_projects', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty list when no projects found', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const result = await callProject('list_projects', { search_dir: emptyDir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(0);
  });

  it('finds projects with project.godot', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('list_projects', { search_dir: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.projects).toContain(dir);
  });
});

// ─── handleTool — get_project_info ──────────────────────────────────────────

describe('project-tools handleTool — get_project_info', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error when project.godot missing', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'nogodot');
    mkdirSync(emptyDir, { recursive: true });

    const result = await callProject('get_project_info', { project_path: emptyDir }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project.godot found');
  });

  it('returns project info for valid project', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('get_project_info', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('TestProject');
    expect(parsed.config).toBeDefined();
    expect(parsed.file_stats).toBeDefined();
  });
});

// ─── handleTool — list_files ────────────────────────────────────────────────

describe('project-tools handleTool — list_files', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists all files in project', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('list_files', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(3);
    expect(parsed.files.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by extension', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('list_files', {
      project_path: dir,
      extensions: ['.gd'],
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    for (const f of parsed.files) {
      expect(f.endsWith('.gd')).toBe(true);
    }
  });
});

// ─── handleTool — read_project_config ───────────────────────────────────────

describe('project-tools handleTool — read_project_config', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error when project.godot missing', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'nogodot');
    mkdirSync(emptyDir, { recursive: true });

    const result = await callProject('read_project_config', { project_path: emptyDir }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project.godot found');
  });

  it('parses project.godot via ctx.parseGodotConfig', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('read_project_config', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    expect(ctx.parseGodotConfig).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toBeDefined();
  });
});

// ─── handleTool — create_project ────────────────────────────────────────────

describe('project-tools handleTool — create_project', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new Godot project structure', async () => {
    const ctx = createMockCtx();
    const newProject = join(dir, 'NewGame');

    const result = await callProject('create_project', {
      project_path: newProject,
      project_name: 'NewGame',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Project created successfully');
    expect(existsSync(join(newProject, 'project.godot'))).toBe(true);
    expect(existsSync(join(newProject, 'scenes', 'main.tscn'))).toBe(true);
    expect(existsSync(join(newProject, 'scripts', 'main.gd'))).toBe(true);
    expect(existsSync(join(newProject, 'assets'))).toBe(true);
  });

  it('refuses to create if project.godot already exists', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await callProject('create_project', {
      project_path: dir,
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('already exists');
  });

  it('returns error for invalid renderer', async () => {
    const ctx = createMockCtx();
    const newProject = join(dir, 'BadRenderer');

    const result = await callProject('create_project', {
      project_path: newProject,
      renderer: 'invalid_renderer',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Invalid renderer');
  });
});

// ─── handleTool — setup_project_rules ────────────────────────────────────────

describe('project-tools handleTool — setup_project_rules', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
    makeGodotProject(dir);
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error when project.godot missing', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'nogodot');
    mkdirSync(emptyDir, { recursive: true });

    const result = await callProject('setup_project_rules', { project_path: emptyDir }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Not a Godot project');
  });

  it('creates .claude/settings.json and CLAUDE.md', async () => {
    const ctx = createMockCtx();

    const result = await callProject('setup_project_rules', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toBeDefined();
    expect(parsed.actions.length).toBe(3);

    // Verify settings.json
    const settingsPath = join(dir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // PostToolUse: 3 hook entries (edit_script, scene/batch, material)
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse.length).toBe(3);
    expect(settings.hooks.PostToolUse[0].matcher).toContain('edit_script');
    expect(settings.hooks.PostToolUse[1].matcher).toContain('scene');
    expect(settings.hooks.PostToolUse[2].matcher).toContain('material');
    // SessionStart: 1 entry
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('Session started');

    // Verify CLAUDE.md
    const claudeMdPath = join(dir, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd).toContain('## MCP 规则映射');
    expect(claudeMd).toContain('.claude/rules/godot-mcp.md');
  });

  it('skips hooks when hooks=false', async () => {
    const ctx = createMockCtx();

    const result = await callProject('setup_project_rules', {
      project_path: dir,
      hooks: false,
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toBeDefined();
    expect(parsed.actions.length).toBe(2);
    expect(parsed.actions.some(a => a.includes('CLAUDE.md'))).toBe(true);
    expect(parsed.actions.some(a => a.includes('rules'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });

  it('skips CLAUDE.md when claude_md=false', async () => {
    const ctx = createMockCtx();

    const result = await callProject('setup_project_rules', {
      project_path: dir,
      claude_md: false,
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toBeDefined();
    expect(parsed.actions.length).toBe(1);
    expect(parsed.actions[0]).toContain('hooks');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('skips when already configured', async () => {
    const ctx = createMockCtx();

    // First run: creates everything
    await callProject('setup_project_rules', { project_path: dir }, ctx);

    // Second run: should skip hooks and CLAUDE.md (rules file skipped too)
    const result = await callProject('setup_project_rules', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toBeDefined();
    expect(parsed.actions.length).toBe(2);
    // hooks should be skipped, rules should be skipped
    expect(parsed.actions.some(a => a.includes('skipped'))).toBe(true);
  });

  it('merges hooks into existing settings.json', async () => {
    const ctx = createMockCtx();

    // Pre-create settings.json with existing config
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      someOtherSetting: true,
      hooks: { PostToolUse: [{ matcher: 'other_tool', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }), 'utf-8');

    const result = await callProject('setup_project_rules', { project_path: dir }, ctx);
    expect(result).not.toBeNull();

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.someOtherSetting).toBe(true);
    // 1 existing + 3 new PostToolUse entries
    expect(settings.hooks.PostToolUse.length).toBe(4);
    // SessionStart should also be present
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart.length).toBe(1);
  });

  it('overwrites with force=true and preserves file content', async () => {
    const ctx = createMockCtx();

    // First run
    await callProject('setup_project_rules', { project_path: dir }, ctx);

    // Second run with force
    const result = await callProject('setup_project_rules', {
      project_path: dir,
      force: true,
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toBeDefined();
    expect(parsed.actions.some(a => a.includes('updated') || a.includes('created'))).toBe(true);

    // Verify settings.json still has valid structure with all hooks
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PostToolUse.length).toBe(3);
    expect(settings.hooks.PostToolUse[0].matcher).toContain('edit_script');
    expect(settings.hooks.SessionStart.length).toBe(1);

    // Verify CLAUDE.md still has rules section
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('## MCP 规则映射');
  });

  it('creates .claude/rules/godot-mcp.md', async () => {
    const ctx = createMockCtx();
    await callProject('setup_project_rules', { project_path: dir }, ctx);

    const rulesPath = join(dir, '.claude', 'rules', 'godot-mcp.md');
    expect(existsSync(rulesPath)).toBe(true);
    const rules = readFileSync(rulesPath, 'utf-8');
    expect(rules).toContain('validate_scripts');
    expect(rules).toContain('verify_delivery');
  });

  it('does not overwrite existing godot-mcp.md', async () => {
    const ctx = createMockCtx();
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'rules', 'godot-mcp.md'), 'my custom rules', 'utf-8');

    await callProject('setup_project_rules', { project_path: dir, force: true }, ctx);

    const rules = readFileSync(join(dir, '.claude', 'rules', 'godot-mcp.md'), 'utf-8');
    expect(rules).toBe('my custom rules');
  });

  it('setup_project_rules is non-readonly via TOOL_META', () => {
    expect(TOOL_META.project.readonly).toBe(false);
  });
});
