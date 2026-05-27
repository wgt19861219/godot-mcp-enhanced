import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../types.js';
import { textResult as okResult, errorResult } from '../types.js';
import { validateProjectRoot, resolveWithinRoot, ensureDir } from '../helpers.js';

// ─── Code Template Types ────────────────────────────────────────────────────

export interface TemplateParam {
  name: string;
  type: string;
  default: string;
}

export interface CodeTemplate {
  id: string;
  name: string;
  description: string;
  relatedRules: string[];
  params: TemplateParam[];
  generate: (params: Record<string, string>) => string;
  verifiedGodotVersion: string;
  lastVerified: string;
  tags?: string[];
  appliesTo?: string[];
}

// ─── Templates ──────────────────────────────────────────────────────────────

const cameraSetup: CodeTemplate = {
  id: "T001",
  name: "camera3d_setup",
  description: "Camera3D + look_at，保证 add_child 在前",
  relatedRules: ["L001"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "position", type: "Vector3", default: "Vector3(0, 5, 10)" },
    { name: "target", type: "Vector3", default: "Vector3.ZERO" },
  ],
  generate: (p) => `
var cam := Camera3D.new()
cam.position = ${p.position ?? "Vector3(0, 5, 10)"}
add_child(cam)
cam.look_at(${p.target ?? "Vector3.ZERO"})
`.trim(),
};

const rigidbodyWithBounce: CodeTemplate = {
  id: "T002",
  name: "rigidbody3d_with_bounce",
  description: "RigidBody3D + PhysicsMaterial + CollisionShape3D",
  relatedRules: ["L002"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "position", type: "Vector3", default: "Vector3.ZERO" },
    { name: "radius", type: "float", default: "0.5" },
    { name: "bounce", type: "float", default: "0.4" },
    { name: "mass", type: "float", default: "1.0" },
    { name: "color", type: "Color", default: "Color.WHITE" },
  ],
  generate: (p) => `
var rb := RigidBody3D.new()
rb.position = ${p.position ?? "Vector3.ZERO"}
rb.mass = ${p.mass ?? "1.0"}
var phys_mat := PhysicsMaterial.new()
phys_mat.bounce = ${p.bounce ?? "0.4"}
rb.physics_material_override = phys_mat
var mesh_inst := MeshInstance3D.new()
var sphere := SphereMesh.new()
sphere.radius = ${p.radius ?? "0.5"}
mesh_inst.mesh = sphere
rb.add_child(mesh_inst)
var col := CollisionShape3D.new()
var shape := SphereShape3D.new()
shape.radius = ${p.radius ?? "0.5"}
col.shape = shape
rb.add_child(col)
add_child(rb)
`.trim(),
};

const area3dDetection: CodeTemplate = {
  id: "T003",
  name: "area3d_detection",
  description: "Area3D 子节点用于碰撞检测",
  relatedRules: ["L013"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "radius", type: "float", default: "2.0" },
  ],
  generate: (p) => `
var detection_area := Area3D.new()
var col := CollisionShape3D.new()
var shape := SphereShape3D.new()
shape.radius = ${p.radius ?? "2.0"}
col.shape = shape
detection_area.add_child(col)
detection_area.body_entered.connect(_on_body_entered)
detection_area.body_exited.connect(_on_body_exited)
add_child(detection_area)

func _on_body_entered(body: Node3D) -> void:
\tpass

func _on_body_exited(body: Node3D) -> void:
\tpass
`.trim(),
};

const environmentAdjustments: CodeTemplate = {
  id: "T004",
  name: "environment_adjustments",
  description: "WorldEnvironment + 色彩校正（正确属性名）",
  relatedRules: ["L004", "L005", "L011"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "brightness", type: "float", default: "1.0" },
    { name: "contrast", type: "float", default: "1.0" },
    { name: "saturation", type: "float", default: "1.0" },
  ],
  generate: (p) => `
var world_env := WorldEnvironment.new()
var env := Environment.new()
env.adjustment_enabled = true
env.adjustment_brightness = ${p.brightness ?? "1.0"}
env.adjustment_contrast = ${p.contrast ?? "1.0"}
env.adjustment_saturation = ${p.saturation ?? "1.0"}
env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
world_env.environment = env
add_child(world_env)
`.trim(),
};

const softbodySetup: CodeTemplate = {
  id: "T005",
  name: "softbody3d_setup",
  description: "SoftBody3D（正确属性名 total_mass/damping_coefficient）",
  relatedRules: ["L006"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "total_mass", type: "float", default: "1.0" },
    { name: "damping", type: "float", default: "0.01" },
  ],
  generate: (p) => `
var softbody := SoftBody3D.new()
softbody.total_mass = ${p.total_mass ?? "1.0"}
softbody.damping_coefficient = ${p.damping ?? "0.01"}
add_child(softbody)
`.trim(),
};

const astarGridSetup: CodeTemplate = {
  id: "T006",
  name: "astar_grid_setup",
  description: "AStarGrid2D（先 update 再 set_point_solid）",
  relatedRules: ["L014"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "size", type: "Vector2i", default: "Vector2i(10, 10)" },
  ],
  generate: (p) => `
var grid := AStarGrid2D.new()
grid.size = ${p.size ?? "Vector2i(10, 10)"}
grid.update()
grid.set_point_solid(Vector2i(1, 1), true)
`.trim(),
};

const line2dDashed: CodeTemplate = {
  id: "T007",
  name: "line2d_dashed",
  description: "Line2D + PackedFloat32Array dash_pattern",
  relatedRules: ["L012"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "dash_length", type: "float", default: "10.0" },
    { name: "gap_length", type: "float", default: "5.0" },
    { name: "width", type: "float", default: "2.0" },
  ],
  generate: (p) => `
var line := Line2D.new()
line.width = ${p.width ?? "2.0"}
var dash_len := ${p.dash_length ?? "10.0"}
var gap_len := ${p.gap_length ?? "5.0"}
line.dash_pattern = PackedFloat32Array([dash_len, gap_len])
add_child(line)
`.trim(),
};

const characterBody2dMovement: CodeTemplate = {
  id: "T008",
  name: "character_body_2d_movement",
  description: "CharacterBody2D move_and_slide() + 输入处理",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "speed", type: "float", default: "300.0" },
    { name: "jump_velocity", type: "float", default: "-400.0" },
  ],
  generate: (p) => `extends CharacterBody2D

const SPEED = ${p.speed ?? "300.0"}
const JUMP_VELOCITY = ${p.jump_velocity ?? "-400.0"}

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta):
\tif not is_on_floor():
\t\tvelocity.y += gravity * delta

\tif Input.is_action_just_pressed("ui_accept") and is_on_floor():
\t\tvelocity.y = JUMP_VELOCITY

\tvar direction = Input.get_axis("ui_left", "ui_right")
\tif direction:
\t\tvelocity.x = direction * SPEED
\telse:
\t\tvelocity.x = move_toward(velocity.x, 0, SPEED)

\tmove_and_slide()`.trim(),
};

const timerPattern: CodeTemplate = {
  id: "T009",
  name: "timer_pattern",
  description: "Timer one-shot/重复计时器模式",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "wait_time", type: "float", default: "1.0" },
    { name: "one_shot", type: "bool", default: "false" },
  ],
  generate: (p) => `var timer := Timer.new()

func _ready():
\ttimer.wait_time = ${p.wait_time ?? "1.0"}
\ttimer.one_shot = ${p.one_shot ?? "false"}
\ttimer.timeout.connect(_on_timer_timeout)
\tadd_child(timer)
\ttimer.start()

func _on_timer_timeout():
\tpass`.trim(),
};

const stateMachineSimple: CodeTemplate = {
  id: "T010",
  name: "state_machine_simple",
  description: "简单 enum + match 状态管理",
  relatedRules: [],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-23",
  params: [
    { name: "states", type: "string", default: "IDLE,RUN,JUMP" },
  ],
  generate: (p) => {
    const stateNames = (p.states ?? "IDLE,RUN,JUMP").split(",");
    const enumBody = stateNames.map(s => `\t${s.trim()}`).join(",\n");
    const matchBody = stateNames.map(s => `\t\t${s.trim()}:\n\t\t\tpass`).join("\n");
    return `enum State {
${enumBody}
}

var current_state: State = State.${stateNames[0].trim()}

func _process(delta):
\tmatch current_state:
${matchBody}

func transition_to(new_state: State):
\tcurrent_state = new_state`.trim();
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

export const TEMPLATES: CodeTemplate[] = [
  cameraSetup,
  rigidbodyWithBounce,
  area3dDetection,
  environmentAdjustments,
  softbodySetup,
  astarGridSetup,
  line2dDashed,
  characterBody2dMovement,
  timerPattern,
  stateMachineSimple,
];

const RULE_TO_TEMPLATE: Record<string, string> = {
  "L001": "T001",
  "L002": "T002",
  "L013": "T003",
  "L004": "T004",
  "L005": "T004",
  "L011": "T004",
  "L006": "T005",
  "L014": "T006",
  "L012": "T007",
};

export function getTemplateSuggestion(ruleId: string): string | null {
  const templateId = RULE_TO_TEMPLATE[ruleId];
  if (!templateId) return null;
  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template) return null;
  return template.generate({});
}

// ─── User Template Loading ──────────────────────────────────────────────────

interface UserTemplateFile {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  appliesTo?: string[];
  godotVersion?: string;
  code: string;
  variables?: TemplateParam[];
}

function validateUserTemplate(raw: unknown, _filePath: string): UserTemplateFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.name !== 'string' || !t.name) return null;
  if (typeof t.code !== 'string' || !t.code.trim()) return null;
  if (typeof t.description !== 'string') t.description = '';
  if (t.variables !== undefined && !Array.isArray(t.variables)) return null;
  if (t.tags !== undefined && !Array.isArray(t.tags)) return null;
  if (t.appliesTo !== undefined && !Array.isArray(t.appliesTo)) return null;
  return t as unknown as UserTemplateFile;
}

/** 加载项目 .mcp-templates/ 目录下的用户模板 */
export function loadUserTemplates(projectPath: string): CodeTemplate[] {
  const templateDir = join(projectPath, '.mcp-templates');
  if (!existsSync(templateDir)) return [];

  const userTemplates: CodeTemplate[] = [];
  const builtInIds = new Set(TEMPLATES.map(t => t.id));

  for (const file of readdirSync(templateDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(templateDir, file);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const validated = validateUserTemplate(raw, filePath);
      if (!validated) continue;

      const id = validated.id;
      if (builtInIds.has(id)) {
        console.warn(`[template] User template '${id}' in ${file} overrides built-in template`);
      }

      userTemplates.push({
        id,
        name: validated.name,
        description: validated.description ?? '',
        relatedRules: [],
        params: validated.variables ?? [],
        generate: (p) => renderTemplate(validated.code, p),
        verifiedGodotVersion: validated.godotVersion ?? '4.2',
        lastVerified: new Date().toISOString().split('T')[0],
        tags: validated.tags ?? [],
        appliesTo: validated.appliesTo ?? [],
      });
    } catch (err) {
      console.warn(`[template] Failed to load ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return userTemplates;
}

/** Sanitize a user template variable value to prevent GDScript injection. */
function sanitizeTemplateValue(value: string): string {
  if (!/^[A-Za-z0-9_."()\s,\-+*/%:!<>#]+$/.test(value)) {
    throw new Error(`Template variable value contains disallowed characters: "${value.slice(0, 50)}"`);
  }
  return value;
}

/** 渲染模板变量 — 供 MCP 工具使用 */
export function renderTemplate(code: string, variables: Record<string, string>): string {
  return code.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key] ?? match;
    if (variables[key] !== undefined) {
      return sanitizeTemplateValue(value);
    }
    return value;
  });
}

/** 获取所有模板（内置 + 用户） */
export function getAllTemplates(projectPath?: string): CodeTemplate[] {
  const builtIn = [...TEMPLATES];
  if (!projectPath) return builtIn;
  const user = loadUserTemplates(projectPath);
  if (user.length === 0) return builtIn;

  // 用户模板覆盖同名内置模板
  const userIds = new Set(user.map(t => t.id));
  const merged = builtIn.filter(t => !userIds.has(t.id)).concat(user);
  return merged;
}

// ─── MCP Tool Definitions ───────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'list_templates',
      description: '列出可用的代码模板（内置 + 用户自定义）。支持按标签或适用类过滤。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory (for loading user templates)' },
          tag: { type: 'string', description: 'Filter by tag keyword' },
          applies_to: { type: 'string', description: 'Filter by applicable class name' },
        },
      },
    },
    {
      name: 'apply_template',
      description: '将代码模板应用到指定脚本路径，支持变量替换。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          template_id: { type: 'string', description: 'Template ID to apply (e.g. T008, user-custom)' },
          script_path: { type: 'string', description: 'Target script path relative to project (e.g. res://scripts/player.gd)' },
          variables: {
            type: 'object',
            description: 'Template variable overrides (key-value pairs)',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['project_path', 'template_id', 'script_path'],
      },
    },
  ];
}

export const TOOL_META = {
  list_templates: { readonly: true, long_running: false },
  apply_template: { readonly: false, long_running: false },
};

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: unknown
): Promise<ToolResult | null> {
  if (name !== 'list_templates' && name !== 'apply_template') return null;

  const projectPath = args.project_path ? validateProjectRoot(args.project_path as string) : undefined;

  if (name === 'list_templates') {
    const templates = getAllTemplates(projectPath);
    const tag = args.tag as string | undefined;
    const appliesTo = args.applies_to as string | undefined;
    let filtered = templates;
    if (tag) filtered = filtered.filter(t => {
      const tags = t.tags ?? [];
      return tags.some(tg => tg.toLowerCase().includes(tag.toLowerCase()))
        || t.description.toLowerCase().includes(tag.toLowerCase());
    });
    if (appliesTo) filtered = filtered.filter(t => {
      const applies = t.appliesTo ?? [];
      return applies.some(a => a.toLowerCase().includes(appliesTo.toLowerCase()))
        || t.description.toLowerCase().includes(appliesTo.toLowerCase());
    });

    const lines = filtered.map(t =>
      `- **${t.id}**: ${t.name} — ${t.description} (params: ${t.params.map(p => p.name).join(', ') || 'none'})`
    );
    return okResult(`Available templates (${filtered.length}):\n${lines.join('\n')}`);
  }

  if (name === 'apply_template') {
    const templateId = args.template_id as string;
    const scriptPath = args.script_path as string;
    if (!templateId) return errorResult('template_id is required');
    if (!scriptPath) return errorResult('script_path is required');
    if (!projectPath) return errorResult('project_path is required');

    const templates = getAllTemplates(projectPath);
    const template = templates.find(t => t.id === templateId);
    if (!template) return errorResult(`Template '${templateId}' not found. Available: ${templates.map(t => t.id).join(', ')}`);

    const variables: Record<string, string> = {};
    const userVars = (args.variables ?? {}) as Record<string, unknown>;
    for (const param of template.params) {
      variables[param.name] = String(userVars[param.name] ?? param.default);
    }

    const code = template.generate(variables);
    const fullPath = resolveWithinRoot(projectPath, scriptPath);
    ensureDir(fullPath);
    writeFileSync(fullPath, code, 'utf-8');

    return okResult(`Template '${template.name}' applied to ${scriptPath} (${code.split('\n').length} lines)`);
  }

  return null;
}
