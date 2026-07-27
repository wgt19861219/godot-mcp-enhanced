import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult, validateTimeout } from './shared.js';
import { formatIssues, dualTrackOutput } from './shared/issue-formatter.js';
import type { NormalizedIssue } from './shared/issue-formatter.js';
import { requireProjectPath, resolveWithinRoot, parseMcpScriptOutput, normalizeUserProjectPath, checkVersionMismatch, scanFiles } from '../helpers.js';
import { analyzeOutput, type AnalysisResult, type AnalyzeOptions } from '../error-analyzer.js';
import { lintGDScript } from './gdscript-lint.js';
import { spawnGodot } from './spawn-helper.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getLogger } from '../core/logger.js';
import { handleTestAction } from './test-framework.js';
import { handleGameDesignAction } from './game-design.js';
import { handleVerifyDelivery } from './delivery.js';

// ─── Known base class methods/properties whitelist ───────────────────────────
// The Godot headless parser cannot resolve inherited methods from base classes
// (Node, Node2D, Control, CharacterBody, etc.), so legitimate calls are
// incorrectly flagged as "not found in base self". This whitelist filters them.

export const KNOWN_BASE_METHODS: Set<string> = new Set([
  // Node 核心
  'add_child', 'remove_child', 'get_child', 'get_children', 'get_child_count',
  'get_parent', 'get_tree', 'get_node', 'find_child', 'find_children',
  'has_node', 'is_inside_tree', 'is_node_ready', 'queue_free', 'free',
  'call_deferred', 'set_deferred', 'emit_signal', 'connect', 'disconnect',
  'is_connected', 'get_name', 'set_name',
  // 生命周期
  '_ready', '_process', '_physics_process', '_input', '_unhandled_input',
  '_unhandled_key_input', '_enter_tree', '_exit_tree',
  // Node2D / Control
  'position', 'rotation', 'scale', 'visible', 'modulate', 'z_index',
  'get_global_mouse_position', 'get_viewport', 'get_viewport_rect',
  'set_process', 'set_physics_process', 'set_process_input',
  // CanvasItem 绘制
  'draw_rect', 'draw_circle', 'draw_string', 'draw_line', 'queue_redraw',
  'get_canvas_item', 'get_global_transform',
  // CharacterBody
  'move_and_slide', 'move_and_collide', 'velocity', 'floor',
  'is_on_floor', 'is_on_wall', 'is_on_ceiling',
  // PhysicsBody / RigidBody
  'linear_velocity', 'angular_velocity', 'mass',
  'gravity_scale', 'apply_impulse', 'apply_force',
  // Navigation
  'get_rid', 'get_region',
  // Shader / Material
  'set_shader_parameter', 'canvas_item',
  // Timer
  'wait_time', 'autostart', 'one_shot',
  // Resource / Object
  'get_path', 'resource_path', 'get_resource', 'duplicate',
  // Input 事件
  'is_action_pressed', 'is_action_just_pressed', 'is_action_just_released',
  'get_vector', 'get_strength', 'mouse_mode', 'set_mouse_mode',
  // Area2D / Collision
  'get_overlapping_bodies', 'get_overlapping_areas',
  'monitoring', 'monitorable', 'collision_mask', 'collision_layer',
  'set_collision_mask_value',
  // AnimationPlayer
  'play', 'stop', 'pause', 'seek',
  'get_current_animation_position', 'current_animation', 'speed_scale', 'autoplay',
  // AudioStreamPlayer
  'playing', 'volume_db', 'pitch_scale', 'stream',
  // TileMap / TileMapLayer
  'set_cell', 'get_cell', 'get_used_cells', 'map_to_local', 'local_to_map',
  // Sprite2D / Texture
  'texture', 'hframes', 'vframes', 'frame', 'region_enabled', 'region_rect',
  // Label / RichTextLabel
  'horizontal_alignment', 'vertical_alignment', 'autowrap_mode',
  'bbcode_text', 'append_text', 'scroll_to_line',
  // Timer 扩展
  'start', 'time_left', 'paused',
  // Tween
  'tween_property', 'tween_callback', 'set_parallel', 'set_trans', 'set_ease',
  // Window
  'get_window', 'set_flag', 'borderless', 'transparent',
]);

export interface BatchValidateResult {
  file: string;
  errors: string[];
  filtered_count?: number;
}

interface ExtendedAnalysisResult extends AnalysisResult {
  version_warning?: string;
  precheck_errors?: BatchValidateResult[];
  scene_tree?: unknown;
  sample_window?: { timed_out: boolean; duration_seconds: number; coverage: string };
}

/** 把 AnalysisResult（run_and_verify / analyze_error）格式化为人类可读文本 */
function formatAnalysisHuman(analysis: AnalysisResult): string {
  const issues: NormalizedIssue[] = [];
  for (const e of analysis.errors) {
    const loc = [e.file, e.line !== undefined ? String(e.line) : ''].filter(Boolean).join(':');
    issues.push({ severity: 'error', location: loc, message: e.message, suggestion: e.suggestion });
  }
  for (const w of analysis.warnings) {
    const loc = [w.file, w.line !== undefined ? String(w.line) : ''].filter(Boolean).join(':');
    issues.push({ severity: 'warning', location: loc, message: w.message });
  }
  return `Analysis: ${analysis.hasErrors ? '✗ has errors' : '✓ no errors'}\n` +
    `Errors: ${analysis.errors.length} / Warnings: ${analysis.warnings.length}\n\n` +
    formatIssues(issues, { truncate: 50 });
}

const execFileAsync = promisify(execFile);

const ACTIONS = [
  'run_and_verify',
  'analyze_error',
  'validate_project',
  'validate_scripts',
  'import_resources',
  // Absorbed from test-framework.ts
  'assert', 'stress', 'export_list_presets', 'export_get_preset', 'export_build',
  // Absorbed from game-design.ts
  'validate_gdd', 'chain_verify',
  // Absorbed from delivery.ts
  'verify_delivery',
] as const;

// ─── False-positive error filter ────────────────────────────────────────────
// Exported for testing; used internally by batchValidateScripts.

// H-12: Pre-compiled regex to extract method/property references from error lines.
// Matches: .method_name, "method_name", method_name( — captures the identifier.
const METHOD_REF_RE = /(?:\.|"|\b)([a-z_][a-z0-9_]{0,40})(?:\(|"|\.|\s|$)/gi;

export function isErrorFalsePositive(line: string): boolean {
  const trimmedLine = line.trim();

  // await expressions in "not found in base self" context are false positives
  if (trimmedLine.includes('await ') && trimmedLine.includes('not found in base self')) return true;

  // ScriptBus internal
  if (trimmedLine.includes('not found in base self') && trimmedLine.includes('ScriptBus')) return true;
  // Godot engine noise
  if (trimmedLine.includes('Condition') && trimmedLine.includes('is true')) return true;

  // 规则 1: 已知基类方法/属性 — "not found in base self" 但方法是合法继承的
  // H-12: Extract method names via regex, then O(1) Set.has() check instead of O(n) linear scan.
  if (trimmedLine.includes('not found in base self')) {
    let match: RegExpExecArray | null;
    METHOD_REF_RE.lastIndex = 0;
    while ((match = METHOD_REF_RE.exec(trimmedLine)) !== null) {
      if (KNOWN_BASE_METHODS.has(match[1]!)) return true;
    }
  }

  // 规则 2: 虚拟方法 "not found in base self" 误报 — headless parser 无法解析 Node 基类虚拟方法
  // (_ready/_process 等)。仅过滤 "not found in base self";不再过滤 "signature"
  // (签名不匹配是真实错误,如重写 _process 时参数个数写错,必须上报)
  if (/Parse Error.*\b(_ready|_process|_physics_process|_input|_unhandled_input|_enter_tree|_exit_tree)\b/.test(trimmedLine)) {
    if (/not found in base self/.test(trimmedLine)) return true;
  }

  return false;
}

// ─── Script file collection ────────────────────────────────────────────────

function collectFilesByExt(projectPath: string, extensions: string[], excludeDirs: string[] = ['.godot', '.import']): string[] {
  return scanFiles(projectPath, extensions, { skipDirs: excludeDirs });
}

/** Collect files with custom exclude paths + .gdignore awareness. */
function collectFilesWithExcludes(projectPath: string, extensions: string[], excludePaths: string[]): string[] {
  const files = scanFiles(projectPath, extensions, { skipDirs: [...excludePaths, '.godot', '.import'] });
  // Filter out files in directories containing .gdignore
  return files.filter(f => {
    const dir = dirname(f);
    return !existsSync(join(dir, '.gdignore'));
  });
}

// ─── Batch script validation ────────────────────────────────────────────────
// Used by edit_script auto-validate (script.ts) and batch_validate tool.

export async function batchValidateScripts(
  godotPath: string,
  projectPath: string,
  scriptFiles: string[],
  globalTimeoutMs: number = 15000
): Promise<BatchValidateResult[]> {
  if (scriptFiles.length === 0) return [];

  let effectiveGodotPath = godotPath;
  if (process.platform === 'win32' && !godotPath.endsWith('_console.exe')) {
    const consolePath = godotPath.replace(/\.exe$/, '_console.exe');
    if (existsSync(consolePath)) {
      effectiveGodotPath = consolePath;
    }
  }

  const pathSep = process.platform === 'win32' ? '\\' : '/';
  const relOf = (absPath: string) => absPath.replace(projectPath + pathSep, '');
  const scriptRels = scriptFiles.map(relOf);
  const resPaths = scriptRels.map(rel => 'res://' + rel.replace(/\\/g, '/'));

  const tmpDir = join(tmpdir(), 'godot-mcp-exec');
  mkdirSync(tmpDir, { recursive: true });
  const listId = randomUUID().replace(/-/g, '').substring(0, 8);
  const listPath = join(tmpDir, `validate-list-${listId}.json`).replace(/\\/g, '/');
  writeFileSync(listPath, JSON.stringify(resPaths), 'utf-8');

  const gdSafePath = listPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '').replace(/\r/g, '');

  const validatorCode = [
    'extends SceneTree',
    '',
    'func _initialize():',
    '\tvar tmp_path: String = "' + gdSafePath + '"',
    '\tvar f := FileAccess.open(tmp_path, FileAccess.READ)',
    '\tif f == null:',
    '\t\tprint("MCP_VALIDATE_ERROR: Cannot read script list")',
    '\t\tquit()',
    '\t\treturn',
    '\tvar json_text := f.get_as_text()',
    '\tf.close()',
    '\tvar scripts = JSON.parse_string(json_text)',
    '\tif scripts == null or not scripts is Array:',
    '\t\tprint("MCP_VALIDATE_ERROR: Invalid script list JSON")',
    '\t\tquit()',
    '\t\treturn',
    '\tfor i in range(scripts.size()):',
    '\t\tvar script_path: String = scripts[i]',
    '\t\tvar res = load(script_path)',
    '\t\tif res == null:',
    '\t\t\tprint("MCP_LOAD_NULL: " + script_path)',
    '\t\t\tcontinue',
    '\tprint("MCP_VALIDATE_DONE")',
    '\tquit()',
  ].join('\n');

  const validatorPath = join(tmpDir, `validate-${listId}.gd`);
  writeFileSync(validatorPath, validatorCode, 'utf-8');

  const results = new Map<string, string[]>();

  const spawnResult = await spawnGodot(effectiveGodotPath, [
    '--headless', '--path', projectPath, '--script', validatorPath,
  ], { timeoutMs: globalTimeoutMs });

  const output = spawnResult.exitCode === -1 && !spawnResult.timedOut && spawnResult.stdout.startsWith('SPAWN_FAILED:')
    ? 'SPAWN_ERROR: ' + spawnResult.stdout.replace('SPAWN_FAILED: ', '')
    : spawnResult.stdout;

  if (output.startsWith('SPAWN_ERROR:')) {
    try { rmSync(listPath, { force: true }); } catch (e) { getLogger().debug('validation', `cleanup list file: ${e instanceof Error ? e.message : e}`); }
    try { rmSync(validatorPath, { force: true }); } catch (e) { getLogger().debug('validation', `cleanup validator file: ${e instanceof Error ? e.message : e}`); }
    return [{ file: '<validator:spawn>', errors: [output] }];
  }

  let filteredCount = 0;

  try {
    const outputLines = output.split('\n');

    const infraErrors = outputLines.filter(l => l.includes('MCP_VALIDATE_ERROR:'));
    if (infraErrors.length > 0) {
      results.set('<validator>', infraErrors.map(l => l.trim()));
    }

    // 兜底: load() 返回 null 但 Godot 未打印标准 Parse Error 时,仍标记该文件(防静默漏报)
    const loadNullLines = outputLines.filter(l => l.includes('MCP_LOAD_NULL:'));
    for (const ln of loadNullLines) {
      const m = ln.match(/MCP_LOAD_NULL:\s*(res:\/\/.+)/);
      if (!m) continue;
      const nullResPath = m[1]!.trim();
      for (const rel of scriptRels) {
        const normalizedRel = rel.replace(/\\/g, '/');
        if (nullResPath === 'res://' + normalizedRel) {
          const existing = results.get(rel);
          if (!existing || existing.length === 0) {
            results.set(rel, ['Script failed to load (returned null) — Godot reported no Parse Error for this file. Check load-time issues (circular deps, invalid extends, missing dependency): ' + nullResPath]);
          }
          break;
        }
      }
    }

    const validatorCompleted = outputLines.some(l => l.includes('MCP_VALIDATE_DONE'));
    if (!validatorCompleted && infraErrors.length === 0) {
      results.set('<validator>', ['Validator process did not complete (likely timed out). Results may be incomplete.']);
    }

    let lastParseError = '';
    for (const line of outputLines) {
      const trimmed = line.trim();
      if (trimmed.includes('Parse Error:')) {
        if (isErrorFalsePositive(trimmed)) {
          filteredCount++;
          lastParseError = '';
        } else {
          lastParseError = trimmed;
        }
      } else if (trimmed.startsWith('at:') && trimmed.includes('res://') && lastParseError) {
        for (const rel of scriptRels) {
          const normalizedRel = rel.replace(/\\/g, '/');
          if (trimmed.includes('res://' + normalizedRel + ':')) {
            if (!results.has(rel)) results.set(rel, []);
            const errors = results.get(rel)!;
            if (!errors.includes(lastParseError)) {
              errors.push(lastParseError);
            }
            break;
          }
        }
        lastParseError = '';
      }
    }
  } finally {
    try { rmSync(listPath, { force: true }); } catch (e) { getLogger().debug('validation', `cleanup list file (finally): ${e instanceof Error ? e.message : e}`); }
    try { rmSync(validatorPath, { force: true }); } catch (e) { getLogger().debug('validation', `cleanup validator file (finally): ${e instanceof Error ? e.message : e}`); }
  }

  const finalResults: Array<{ file: string; errors: string[]; filtered_count?: number }> =
    Array.from(results.entries()).map(([file, errors]) => ({ file, errors }));
  if (filteredCount > 0) {
    if (finalResults.length > 0) {
      finalResults[0]!.filtered_count = filteredCount;
    } else {
      finalResults.push({ file: '<filtered>', errors: [], filtered_count: filteredCount });
    }
  }
  return finalResults;
}

// ─── Common API pitfall scanner ─────────────────────────────────────────────

interface PitfallRule {
  pattern: RegExp;
  message: string;
  condition?: (content: string) => boolean;
}

const API_PITFALL_RULES: PitfallRule[] = [
  // Vector3 required (Godot 4.x ParticleProcessMaterial)
  {
    pattern: /\.(direction|gravity|emission_box_extents)\s*=\s*Vector2\s*\(/,
    message: 'Property requires Vector3, not Vector2. In Godot 4.x, ParticleProcessMaterial.direction/gravity/emission_box_extents all take Vector3.',
  },
  // GradientTexture1D required for color_ramp
  {
    pattern: /\.color_ramp\s*=\s*Gradient\.new\s*\(\s*\)/,
    message: 'color_ramp requires GradientTexture1D, not a bare Gradient. Wrap it: var tex := GradientTexture1D.new(); tex.gradient = grad; mat.color_ramp = tex',
  },
  // RefCounted cannot add_child (only flag if file also uses scene tree APIs)
  {
    pattern: /extends\s+RefCounted/,
    message: 'RefCounted cannot call add_child(). If you need SubViewport or child nodes, use "extends Node" instead.',
    condition: (content) => /SubViewport|add_child|get_texture|get_image|queue_free/.test(content),
  },
  // seed() global pollution
  {
    pattern: /^\s*seed\s*\(\s*\d+\s*\)/m,
    message: 'seed() affects ALL subsequent random calls globally. Consider using RandomNumberGenerator with .seed = value instead to isolate randomness.',
  },
  // queue_free called twice within 3 lines (allows blank lines/comments between)
  {
    pattern: /\.queue_free\s*\(\s*\)\s*(?:\r?\n[^\n]*){0,2}\r?\n[^\n]*\.queue_free\s*\(\s*\)/,
    message: 'queue_free() appears to be called twice on the same object (likely a copy-paste error).',
  },
  // Emission shape constant does not exist
  {
    pattern: /EMISSION_SHAPE_RECTANGLE/,
    message: 'EMISSION_SHAPE_RECTANGLE does not exist in Godot 4.x. Use EMISSION_SHAPE_BOX for 3D box emission.',
  },
];

function scanForCommonPitfalls(content: string): string[] {
  // Strip comment lines to avoid false positives on documented code
  const codeOnly = content.split(/\r?\n/).filter(l => !l.trimStart().startsWith('#')).join('\n');
  const warnings: string[] = [];
  for (const rule of API_PITFALL_RULES) {
    if (rule.pattern.test(codeOnly)) {
      if (rule.condition && !rule.condition(codeOnly)) continue;
      warnings.push(rule.message);
    }
  }
  return warnings;
}

// ─── Shader file validation ────────────────────────────────────────────────

function validateShaderFile(filePath: string, relPath: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { errors: [`Cannot read shader file: ${relPath}`], warnings: [] };
  }

  const lines = content.split('\n');

  // Must have shader_type declaration
  const hasShaderType = lines.some(l => /^\s*shader_type\s+\w+\s*;/.test(l));
  if (!hasShaderType) {
    errors.push('Missing shader_type declaration (e.g. "shader_type canvas_item;" or "shader_type spatial;")');
  }

  // Check for common syntax issues
  const varyings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const lineNum = i + 1;

    // uniform without type (just "uniform name;")
    if (/^uniform\s+\w+\s*;\s*$/.test(line)) {
      errors.push(`Line ${lineNum}: uniform missing type (e.g. "uniform float name;")`);
    }

    // duplicate varying declarations
    const vm = line.match(/^varying\s+\w+\s+(\w+)/);
    if (vm) {
      if (varyings.includes(vm[1]!)) {
        errors.push(`Line ${lineNum}: Duplicate varying declaration: ${vm[1]!}`);
      }
      varyings.push(vm[1]!);
    }
  }

  return { errors, warnings };
}

// ─── .tscn/.tres structural validation ──────────────────────────────────────

export function validateSceneFile(
  content: string,
  relPath: string,
  _projectPath: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content.trim()) {
    return { errors: ['Empty scene/resource file'], warnings: [] };
  }

  // 1. Check for valid header
  if (!/^\[gd_(scene|resource)\b/m.test(content)) {
    errors.push(`Missing [gd_scene] or [gd_resource] header in ${relPath}`);
  }

  // 2. Check for duplicate ext_resource ids
  const extIds = new Set<string>();
  const extRegex = /\[ext_resource[^[]*id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = extRegex.exec(content)) !== null) {
    const id = match[1]!;
    if (extIds.has(id)) {
      errors.push(`Duplicate ext_resource id: ${id} in ${relPath}`);
    } else {
      extIds.add(id);
    }
  }

  // 3. Check for duplicate sub_resource ids
  const subIds = new Set<string>();
  const subRegex = /\[sub_resource[^[]*id="([^"]+)"/g;
  while ((match = subRegex.exec(content)) !== null) {
    const id = match[1]!;
    if (subIds.has(id)) {
      errors.push(`Duplicate sub_resource id: ${id} in ${relPath}`);
    } else {
      subIds.add(id);
    }
  }

  return { errors, warnings };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'validation',
      description: '运行验证、分析错误、验证项目/脚本、导入资源。一键 headless 运行 + 错误分析，或按需单项检查。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['run_and_verify', 'analyze_error', 'validate_project', 'validate_scripts', 'import_resources',
              // ── merged actions (v0.18.0) ──
              'assert', 'stress', 'export_list_presets', 'export_get_preset', 'export_build',
              'validate_gdd', 'chain_verify', 'verify_delivery'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          scope: {
            type: 'string',
            enum: ['scene', 'script', 'full'],
            description: '验证范围(verify_delivery 必填): scene/script/full。其他 action 忽略',
          },
          scene_path: { type: 'string', description: '场景路径(scope=scene,相对项目,verify_delivery)' },
          script_path: { type: 'string', description: '脚本路径(scope=script,相对项目,verify_delivery)' },
          scene: { type: 'string', description: '可选场景文件路径（run_and_verify）' },
          timeout: { type: 'number', description: '超时秒数（默认 20）', default: 20 },
          capture_tree: { type: 'boolean', description: '同时捕获场景树快照（默认 false）', default: false },
          output: { type: 'string', description: 'Godot 运行时输出全文（analyze_error）' },
          check_resources: { type: 'boolean', description: '检查缺失资源文件（默认 true）', default: true },
          check_scripts: { type: 'boolean', description: '检查断裂脚本引用（默认 true）', default: true },
          check_scenes: { type: 'boolean', description: '验证场景文件结构（默认 true）', default: true },
          exclude_paths: {
            type: 'array',
            items: { type: 'string' },
            description: '排除的目录路径（相对项目根）。默认排除：.godot, .import',
            default: ['.godot', '.import'],
          },
          scripts: {
            type: 'array',
            items: { type: 'string' },
            description: '要验证的脚本路径数组（相对项目）。省略则扫描全部 .gd 文件',
          },
          directory: { type: 'string', description: '扫描目录（相对项目，如 "assets/ui"）' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: '导入文件扩展名（默认常见图片/音频/字体类型）',
            default: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'],
          },
          recursive: { type: 'boolean', description: '递归扫描子目录（默认 true）', default: true },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'validation') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  switch (action) {
    case 'run_and_verify': {
      const projectPath = requireProjectPath(args);
      const timeout = validateTimeout(args.timeout, 5, 120, 20);
      const scene = args.scene as string | undefined;
      const captureTree = args.capture_tree === true;

      // A2: scene 越权防护（防 ../ 读项目外 .tscn）。resolveWithinRoot 仅校验,
      // safeScene 传 normalize 后的相对路径（godot CLI 与 query_scene_tree.gd 均期望相对路径）。
      // I1 fix(2026-07-23 final review): 不用 resolveWithinRoot 返回值（绝对路径）——
      // 会让 godot CLI 收到项目绝对路径而非项目内相对路径，功能性回归。对齐 A7 模式
      // （scene/index.ts:227 resolveWithinRoot 仅校验，传 normalize 后相对 sp）。
      let safeScene: string | undefined;
      if (scene) {
        const normalized = normalizeUserProjectPath(scene);
        resolveWithinRoot(projectPath, normalized);  // 仅校验, throw if 越界
        safeScene = normalized;  // 传 normalize 后相对路径（godot CLI / query_scene_tree.gd 期望相对）
      }

      const godot = await ctx.findGodot();
      const cmdArgs = ['--headless', '--path', projectPath];
      if (safeScene) cmdArgs.push(safeScene);

      const versionWarning = await checkVersionMismatch(projectPath, godot);

      const precheckErrors: BatchValidateResult[] = [];
      try {
        const allScripts = collectFilesByExt(projectPath, ['.gd']);
        const scriptsToCheck = allScripts.slice(0, 10);
        if (scriptsToCheck.length > 0) {
          const batchResults = await batchValidateScripts(godot, projectPath, scriptsToCheck, 15000);
          precheckErrors.push(...batchResults);
        }
      } catch (err) { getLogger().debug('validation', `precheck scripts: ${err instanceof Error ? err.message : err}`); }

      // V-01 fix: setProjectDir so stop_project orphan scan can find project path
      ctx.setProjectDir(projectPath);

      const result = await spawnGodot(godot, cmdArgs, { timeoutMs: timeout * 1000 });
      const allOutput = [...result.stdout.split('\n'), ...result.stderr.split('\n')];

      // Read autoload singleton names from project.godot for better error classification
      const analyzeOpts: AnalyzeOptions = { projectPath };
      try {
        const cfgPath = join(projectPath, 'project.godot');
        if (existsSync(cfgPath)) {
          const cfgContent = readFileSync(cfgPath, 'utf-8');
          const config = ctx.parseGodotConfig(cfgContent);
          const autoloadSection = config['autoload'] as Record<string, unknown> | undefined;
          if (autoloadSection) {
            analyzeOpts.autoloadNames = Object.keys(autoloadSection);
          }
        }
        // S3 (2026-06-23): 读 global_script_class_cache.cfg 提取 class_name 全局类。
        // headless 跨文件 class_name 解析失败同样报 "Identifier X not found",需与 autoload
        // 同归 headless_limitation,否则干净项目被误诊为真实错误(见 review-followup S3)。
        const classCachePath = join(projectPath, '.godot', 'global_script_class_cache.cfg');
        if (existsSync(classCachePath)) {
          const cacheContent = readFileSync(classCachePath, 'utf-8');
          const classNames = [...cacheContent.matchAll(/"class":\s*&?"(\w+)"/g)].map(m => m[1] as string);
          if (classNames.length > 0) analyzeOpts.classNames = classNames;
        }
      } catch (err) { getLogger().debug('validation', `read autoload/class config: ${err instanceof Error ? err.message : err}`); }

      const analysis = analyzeOutput(allOutput, analyzeOpts);

      if (versionWarning) (analysis as ExtendedAnalysisResult).version_warning = versionWarning;
      if (precheckErrors.length > 0) (analysis as ExtendedAnalysisResult).precheck_errors = precheckErrors;

      if (result.timedOut) {
        (analysis as ExtendedAnalysisResult).summary += '\nNote: Process timed out (killed) after ' + timeout + 's — normal for interactive projects. hasErrors/analysis reflect ALL stdout/stderr captured during the full [0, ' + timeout + 's] run window, not just startup.';
      } else if (result.exitCode !== 0 && result.exitCode !== null) {
        (analysis as ExtendedAnalysisResult).summary += '\nNote: Process exited with code ' + result.exitCode + '. hasErrors/analysis reflect ALL stdout/stderr captured during the run.';
      }
      (analysis as ExtendedAnalysisResult).sample_window = {
        timed_out: result.timedOut,
        duration_seconds: timeout,
        coverage: 'full run window — all stdout/stderr analyzed',
      };

      if (captureTree && safeScene) {
        try {
          const scriptsDir = dirname(ctx.opsScript);
          const treeScript = join(scriptsDir, 'query_scene_tree.gd');
          if (existsSync(treeScript)) {
            const treeSpawnResult = await spawnGodot(godot, [
                '--headless', '--path', projectPath,
                '--script', treeScript,
                JSON.stringify({ scene_path: safeScene, max_depth: 3 }),
              ], { timeoutMs: 30_000 });
            const treeResult = treeSpawnResult.stdout;
            if (treeResult) {
              (analysis as ExtendedAnalysisResult).scene_tree = parseMcpScriptOutput(treeResult, 0);
            }
          }
        } catch (err) { getLogger().debug('validation', `capture scene tree: ${err instanceof Error ? err.message : err}`); }
      }

      return textResult(dualTrackOutput(formatAnalysisHuman(analysis), analysis));
    }

    case 'analyze_error': {
      // analyze_error: no project context available, skip autoload filtering
      const outputText = args.output as string;
      if (!outputText || !outputText.trim()) {
        return opsErrorResult('INVALID_PARAMS', '"output" parameter is required and must not be empty.');
      }
      const lines = outputText.split('\n');
      const analysis = analyzeOutput(lines);
      return textResult(dualTrackOutput(formatAnalysisHuman(analysis), analysis));
    }

    case 'validate_project': {
      const p = requireProjectPath(args);
      const checkResources = args.check_resources !== false;
      const checkScripts = args.check_scripts !== false;
      const checkScenes = args.check_scenes !== false;
      const excludePaths: string[] = (Array.isArray(args.exclude_paths) && args.exclude_paths.every((s: unknown) => typeof s === 'string') ? args.exclude_paths as string[] : null) || ['.godot', '.import'];

      const issues: Array<{ severity: string; category: string; message: string; file?: string }> = [];

      // A-11: Replaced inline collectFiles/shouldSkipDir with shared collectFilesWithExcludes
      const collectProjectFiles = (exts: string[]) => collectFilesWithExcludes(p, exts, excludePaths);

      if (!existsSync(join(p, 'project.godot'))) {
        issues.push({ severity: 'critical', category: 'project', message: 'project.godot not found' });
        const earlySummary = { valid: false, issue_count: issues.length, issues };
        const earlyText = `Project validation: ✗ has issues\n\n` +
          formatIssues([{ severity: 'critical', location: '', message: '[project] project.godot not found' }]);
        return textResult(dualTrackOutput(earlyText, earlySummary));
      }

      if (checkScenes) {
        const sceneFiles = collectProjectFiles(['.tscn']);
        for (const sceneFile of sceneFiles) {
          const rel = sceneFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
          try {
            const content = readFileSync(sceneFile, 'utf-8');
            const extResRegex = /\[ext_resource[^[]*path="([^"]+)"/g;
            let match;
            while ((match = extResRegex.exec(content)) !== null) {
              const resPath = match[1]!;
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_resource',
                  message: `Referenced resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }

            // Shader 引用检查：shader = "res://xxx.gdshader" (A-09: skip comment lines)
            const shaderRegex = /^[^;]*shader\s*=\s*"([^"]+\.gdshader)"/gm;
            while ((match = shaderRegex.exec(content)) !== null) {
              const shaderPath = match[1]!;
              if (!shaderPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, shaderPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_resource',
                  message: `Referenced shader not found: ${shaderPath}`,
                  file: rel,
                });
              }
            }

            // Texture 引用检查：texture = ExtResource("xxx") 确保引用 ID 在上方定义 (A-09: skip comment lines)
            const texRefRegex = /^[^;]*texture\s*=\s*ExtResource\("([^"]+)"\)/gm;
            while ((match = texRefRegex.exec(content)) !== null) {
              const refId = match[1];
              const defRegex = new RegExp(`\\[ext_resource[^\\]]*id="${refId}"`, 's');
              if (!defRegex.test(content)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_resource',
                  message: `Texture references undefined ext_resource id: "${refId}"`,
                  file: rel,
                });
              }
            }
          } catch (e) {
            issues.push({
              severity: 'warning',
              category: 'scene_read',
              message: `Cannot read scene file: ${(e as Error).message}`,
              file: rel,
            });
          }
        }
      }

      if (checkScripts) {
        const scriptFiles = collectProjectFiles(['.gd']);
        for (const scriptFile of scriptFiles) {
          const rel = scriptFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
          try {
            const content = readFileSync(scriptFile, 'utf-8');
            const preloadRegex = /preload\(["']([^"']+)["']\)/g;
            let match;
            while ((match = preloadRegex.exec(content)) !== null) {
              const resPath = match[1]!;
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_preload',
                  message: `preload() resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }
            const loadRegex = /(?:^|\s)load\(["']([^"']+)["']\)/g;
            while ((match = loadRegex.exec(content)) !== null) {
              const resPath = match[1]!;
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'warning',
                  category: 'missing_load',
                  message: `load() resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }
          } catch {
            issues.push({ severity: 'warning', category: 'script_read', message: 'Cannot read script file', file: rel });
          }
        }
      }

      if (checkResources) {
        const importFiles = collectProjectFiles(['.import']);
        for (const importFile of importFiles) {
          const sourceFile = importFile.replace('.import', '');
          if (!existsSync(sourceFile)) {
            const rel = importFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
            issues.push({
              severity: 'info',
              category: 'orphaned_import',
              message: `Orphaned .import file (source asset deleted)`,
              file: rel,
            });
          }
        }
      }

      const summary = {
        valid: issues.filter(i => i.severity === 'critical' || i.severity === 'error').length === 0,
        issue_count: issues.length,
        critical: issues.filter(i => i.severity === 'critical').length,
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
        info: issues.filter(i => i.severity === 'info').length,
        issues: issues.slice(0, 100),
      };

      // 双轨输出：人类可读 severity 分组（截断到每组 50 条）+ 尾部紧凑 JSON
      const normalized: NormalizedIssue[] = issues.map(i => ({
        severity: i.severity,
        location: i.file ?? '',
        message: i.category ? `[${i.category}] ${i.message}` : i.message,
      }));
      const humanText = `Project validation: ${summary.valid ? '✓ passed' : '✗ has issues'}\n` +
        `Totals: ${summary.critical} critical / ${summary.errors} errors / ${summary.warnings} warnings / ${summary.info} info\n\n` +
        formatIssues(normalized, { truncate: 50 });
      return textResult(dualTrackOutput(humanText, summary));
    }

    case 'validate_scripts': {
      const p = requireProjectPath(args);
      const perScriptTimeout = validateTimeout(args.timeout, 5, 60, 10);
      const godot = await ctx.findGodot();

      let scriptsToValidate: string[];
      if (args.scripts && Array.isArray(args.scripts) && args.scripts.length > 0 && args.scripts.every((s: unknown) => typeof s === 'string')) {
        scriptsToValidate = (args.scripts as string[]).map(s => resolveWithinRoot(p, s));
      } else {
        scriptsToValidate = collectFilesByExt(p, ['.gd']);
      }
      const totalFound = scriptsToValidate.length;
      if (scriptsToValidate.length > 50) {
        scriptsToValidate = scriptsToValidate.slice(0, 50);
      }

      const relOf = (f: string) => f.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');

      // Batch Godot parser validation
      const BATCH_SIZE = 20;
      const allBatchResults: BatchValidateResult[] = [];
      for (let i = 0; i < scriptsToValidate.length; i += BATCH_SIZE) {
        const batch = scriptsToValidate.slice(i, i + BATCH_SIZE);
        const batchResults = await batchValidateScripts(godot, p, batch, Math.min(perScriptTimeout * Math.max(batch.length, 5), 60) * 1000);
        allBatchResults.push(...batchResults);
      }

      const errorMap = new Map(allBatchResults.map(r => [r.file, r.errors]));
      const results: Array<{ file: string; has_errors: boolean; errors: string[]; warnings?: string[] }> = [];
      let totalErrors = 0;
      let totalWarnings = 0;
      let totalFiltered = 0;
      for (const r of allBatchResults) {
        if (r.filtered_count) totalFiltered += r.filtered_count;
      }
      for (const sf of scriptsToValidate) {
        const rel = relOf(sf);
        const errs = errorMap.get(rel) || [];
        totalErrors += errs.length;

        // API pitfall scan
        let warnings: string[] = [];
        let hasLintErrors = false;
        try {
          const content = readFileSync(sf, 'utf-8');
          warnings = scanForCommonPitfalls(content);
          totalWarnings += warnings.length;

          // Lint framework: call-order rules, deprecated API patterns, etc.
          const lintOutput = lintGDScript(content);
          hasLintErrors = lintOutput.errors.length > 0;
          if (lintOutput.errors.length > 0 || lintOutput.warnings.length > 0) {
            // IMPORTANT-3: 直接使用结构化 lint 数据，跳过序列化→解析
            const allLintItems = [...lintOutput.errors, ...lintOutput.warnings];
            for (const item of allLintItems) {
              let msg = item.rule + " (line " + item.line + "): " + item.message;
              if (item.suggestion) msg += " → " + item.suggestion.split("\n")[0];
              warnings.push(msg);
            }
            totalWarnings += lintOutput.warnings.length;
          }
        } catch (err) { getLogger().debug('validation', `scan for pitfalls: ${err instanceof Error ? err.message : err}`); }

        results.push({ file: rel, has_errors: errs.length > 0 || hasLintErrors, errors: errs, warnings: warnings.length > 0 ? warnings : undefined });
      }

      // Shader validation
      const shaderFiles = collectFilesByExt(p, ['.gdshader']);
      const shaderResults: Array<{ file: string; has_errors: boolean; errors: string[]; warnings?: string[] }> = [];
      for (const sf of shaderFiles) {
        const rel = relOf(sf);
        const { errors: sErrors, warnings: sWarnings } = validateShaderFile(sf, rel);
        totalErrors += sErrors.length;
        totalWarnings += sWarnings.length;
        if (sErrors.length > 0 || sWarnings.length > 0) {
          shaderResults.push({ file: rel, has_errors: sErrors.length > 0, errors: sErrors, warnings: sWarnings.length > 0 ? sWarnings : undefined });
        }
      }

      let summaryMsg = `Validated ${scriptsToValidate.length} scripts, found ${totalErrors} errors in ${results.filter(r => r.has_errors).length} files.`;
      if (totalWarnings > 0) {
        summaryMsg += ` ${totalWarnings} API warning(s) detected.`;
      }
      if (shaderResults.length > 0) {
        summaryMsg += ` Validated ${shaderFiles.length} shader(s), ${shaderResults.filter(r => r.has_errors).length} with errors.`;
      }
      if (totalFound > 50) {
        summaryMsg += ` (${totalFound - 50} scripts skipped — specify scripts parameter to validate more)`;
      }

      const scriptsSummary: Record<string, unknown> = {
        validated: scriptsToValidate.length,
        total_scanned: totalFound,
        total_errors: totalErrors,
        scripts_with_errors: results.filter(r => r.has_errors).length,
        scripts: results,
        summary: summaryMsg,
      };

      if (totalFiltered > 0) {
        scriptsSummary.filtered_count = totalFiltered;
      }

      if (shaderResults.length > 0) {
        scriptsSummary.shaders = shaderResults;
        scriptsSummary.shaders_validated = shaderFiles.length;
      }

      // C# 文件检测：尝试 dotnet build
      const csFiles = collectFilesByExt(p, ['.cs']);
      if (csFiles.length > 0) {
        const csResults: Array<{ file: string; status: string; engine: string; error?: string; warning?: string }> = [];
        const csprojFiles = collectFilesByExt(p, ['.csproj']);
        if (csprojFiles.length === 0) {
          csResults.push({ file: `${csFiles.length} .cs files`, status: 'skipped', engine: 'dotnet', warning: 'No .csproj found, C# validation skipped' });
        } else {
          try {
            await execFileAsync('dotnet', ['build', '--no-restore'], {
              cwd: p,
              timeout: 30000,
              encoding: 'utf-8',
            });
            csResults.push({ file: `${csFiles.length} .cs files`, status: 'valid', engine: 'dotnet' });
          } catch (e: unknown) {
            const err = e as Record<string, unknown>;
            if (err.code === 'ENOENT') {
              csResults.push({ file: `${csFiles.length} .cs files`, status: 'skipped', engine: 'dotnet', warning: 'dotnet CLI not found in PATH' });
            } else {
              const output = (err.stdout as string) || (err.message as string) || 'dotnet build failed';
              csResults.push({ file: `${csFiles.length} .cs files`, status: 'error', engine: 'dotnet', error: output.substring(0, 2000) });
            }
          }
        }
        scriptsSummary.csharp = csResults;
        scriptsSummary.csharp_files_scanned = csFiles.length;
      }

      // Scene/resource file structural validation (.tscn/.tres)
      const sceneFiles = [...collectFilesByExt(p, ['.tscn']), ...collectFilesByExt(p, ['.tres'])];
      const sceneResults: Array<{ file: string; has_errors: boolean; errors: string[]; warnings?: string[] }> = [];
      let sceneTotalErrors = 0;
      for (const sf of sceneFiles) {
        const rel = relOf(sf);
        try {
          const content = readFileSync(sf, 'utf-8');
          const { errors: sErrors, warnings: sWarnings } = validateSceneFile(content, rel, p);
          sceneTotalErrors += sErrors.length;
          if (sErrors.length > 0 || sWarnings.length > 0) {
            sceneResults.push({ file: rel, has_errors: sErrors.length > 0, errors: sErrors, warnings: sWarnings.length > 0 ? sWarnings : undefined });
          }
        } catch {
          sceneResults.push({ file: rel, has_errors: true, errors: [`Cannot read file: ${rel}`] });
          sceneTotalErrors++;
        }
      }
      if (sceneResults.length > 0) {
        scriptsSummary.scenes = sceneResults;
        scriptsSummary.scenes_validated = sceneFiles.length;
        scriptsSummary.scene_errors = sceneTotalErrors;
        summaryMsg += ` Validated ${sceneFiles.length} scene/resource file(s), ${sceneResults.filter(r => r.has_errors).length} with errors.`;
        scriptsSummary.summary = summaryMsg;
      }

      const vWarn = await checkVersionMismatch(p, godot);
      if (vWarn) scriptsSummary.version_warning = vWarn;

      // 双轨输出：把 results 的 errors/warnings（string[]）归一化为 issue 列表
      const scriptIssues: NormalizedIssue[] = [];
      for (const r of [...results, ...shaderResults, ...sceneResults]) {
        for (const err of r.errors ?? []) {
          scriptIssues.push({ severity: 'error', location: r.file, message: err });
        }
        for (const w of r.warnings ?? []) {
          scriptIssues.push({ severity: 'warning', location: r.file, message: w });
        }
      }
      const scriptHuman = `${summaryMsg}\n\n` + formatIssues(scriptIssues, { truncate: 50 });
      return textResult(dualTrackOutput(scriptHuman, scriptsSummary));
    }

    case 'import_resources': {
      const p = requireProjectPath(args);
      const directoryRaw = args.directory as string;
      const normalizedDir = normalizeUserProjectPath(directoryRaw);

      if (!normalizedDir) {
        return opsErrorResult('INVALID_PARAMS', 'directory must be a non-empty path inside project.');
      }

      const defaultExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'];
      const extensions = (args.extensions as string[]) || defaultExts;
      const recursive = args.recursive !== false;

      const targetDir = resolveWithinRoot(p, normalizedDir);
      if (!existsSync(targetDir)) {
        return opsErrorResult('NOT_FOUND', `Directory not found: ${targetDir}`);
      }

      const importedFiles: string[] = [];
      const skippedFiles: string[] = [];

      function scanDir(dir: string, depth: number): void {
        if (depth > 15) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '.import') continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (recursive) scanDir(fullPath, depth + 1);
            } else {
              const ext = '.' + entry.name.split('.').pop()!.toLowerCase();
              if (!extensions.includes(ext)) continue;
              const importPath = fullPath + '.import';
              if (existsSync(importPath)) {
                skippedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
                continue;
              }
              const uid = 'uid://' + Buffer.from(fullPath.replace(p, '').replace(/\\/g, '/')).toString('base64url').substring(0, 24);
              const importerMap: Record<string, string> = {
                '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.svg': 'texture',
                '.mp3': 'ogg_vorbis', '.ogg': 'ogg_vorbis', '.wav': 'wav',
                '.ttf': 'dynamic_font', '.otf': 'dynamic_font',
                '.glb': 'scene', '.gltf': 'scene',
              };
              const typeMap: Record<string, string> = {
                '.png': 'CompressedTexture2D', '.jpg': 'CompressedTexture2D', '.jpeg': 'CompressedTexture2D',
                '.webp': 'CompressedTexture2D', '.svg': 'CompressedTexture2D',
                '.mp3': 'AudioStreamOggVorbis', '.ogg': 'AudioStreamOggVorbis', '.wav': 'AudioStreamWAV',
                '.ttf': 'FontFile', '.otf': 'FontFile',
                '.glb': 'PackedScene', '.gltf': 'PackedScene',
              };
              const importer = importerMap[ext] || 'any';
              const resourceType = typeMap[ext] || 'Resource';
              const extSuffix = ext === '.wav' ? '.wav' : ext === '.ogg' || ext === '.mp3' ? '.ogg' : '.ctex';
              const importContent = [
                `[remap]`,
                ``,
                `importer="${importer}"`,
                `type="${resourceType}"`,
                `uid="${uid}"`,
                `path="res://.godot/imported/${entry.name}-${uid.substring(5, 13)}${extSuffix}"`,
                `metadata={`,
                `"vram_texture": false`,
                `}`,
                ``,
                `[deps]`,
                ``,
                `source_file="res://${fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), '').replace(/\\/g, '/')}"`,
                ``,
                `[params]`,
                ``,
                `compress/mode=0`,
                `compress/high_quality=false`,
                `compress/lossy_quality=0.7`,
                ``,
              ].join('\n');
              writeFileSync(importPath, importContent, 'utf-8');
              importedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
            }
          }
        } catch (err) { getLogger().debug('validation', `import resources scan: ${err instanceof Error ? err.message : err}`); }
      }

      scanDir(targetDir, 0);

      return textResult(
        `Import scan complete.\n\n` +
        `Directory: ${normalizedDir}\n` +
        `New imports: ${importedFiles.length}\n` +
        `Already imported (skipped): ${skippedFiles.length}\n` +
        `Extensions: ${extensions.join(', ')}\n\n` +
        (importedFiles.length > 0 ? `Newly imported:\n${importedFiles.slice(0, 50).map(f => '  ' + f).join('\n')}${importedFiles.length > 50 ? `\n  ... and ${importedFiles.length - 50} more` : ''}\n\n` : '') +
        `⚠️ EXPERIMENTAL: Generated .import files use approximate uid values that may differ from Godot's internal algorithm. ` +
        `Open the project in Godot editor to let it reconcile imports — Godot will regenerate correct uid values automatically.`
      );
    }

    // ── Absorbed actions ──
    case 'assert':
    case 'stress':
    case 'export_list_presets':
    case 'export_get_preset':
    case 'export_build':
      return handleTestAction(action, args, ctx);

    case 'validate_gdd':
    case 'chain_verify':
      return handleGameDesignAction(action, args, ctx);

    case 'verify_delivery':
      return handleVerifyDelivery(args, ctx);

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  validation: {
    readonly: false,
    long_running: true,
    actionRisks: {
      run_and_verify: 'read',
      analyze_error: 'read',
      validate_project: 'read',
      validate_scripts: 'read',
      import_resources: 'read',
      export_list_presets: 'read',
      export_get_preset: 'read',
      validate_gdd: 'read',
      chain_verify: 'read',
      verify_delivery: 'read',
      export_build: 'process',
      assert: 'process',
      stress: 'process',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
  // Absorbed tool meta
  test: { readonly: true, long_running: false },
  game_design: { readonly: true, long_running: false },
  verify_delivery: { readonly: true, long_running: true },
};
