import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolResult } from '../types.js';
import { textResult as okResult, errorResult } from '../types.js';
import { validateProjectRoot, resolveWithinRoot } from '../core/path-utils.js';
import { ensureDir } from '../core/fs-atomic.js';
import { getLogger } from '../core/logger.js';
import { scanScriptSandboxOrThrow } from './script.js';

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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
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
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
  params: [
    { name: "states", type: "string", default: "IDLE,RUN,JUMP" },
  ],
  generate: (p) => {
    const stateNames = (p.states ?? "IDLE,RUN,JUMP").split(",");
    const enumBody = stateNames.map(s => `\t${s.trim()}`).join(",\n");
    // match 分支匹配枚举值必须带 State. 前缀;裸标识符(如 `IDLE:`)编译报
    // "Identifier not declared"(2026-08-19 Godot 4.7.2/4.6.3 --check-only 双版本实测,系历史 bug)
    const matchBody = stateNames.map(s => `\t\tState.${s.trim()}:\n\t\t\tpass`).join("\n");
    return `enum State {
${enumBody}
}

var current_state: State = State.${stateNames[0]!.trim()}

func _process(delta):
\tmatch current_state:
${matchBody}

func transition_to(new_state: State):
\tcurrent_state = new_state`.trim();
  },
};

const tilesetAtlasSetup: CodeTemplate = {
  id: "T011",
  name: "tileset_atlas_setup",
  description: "TileSet + TileSetAtlasSource + 碰撞层（正确调用顺序）",
  relatedRules: ["L018"],
  verifiedGodotVersion: "4.7",
  lastVerified: "2026-08-19",
  params: [
    { name: "tile_size", type: "int", default: "16" },
    { name: "columns", type: "int", default: "4" },
    { name: "rows", type: "int", default: "4" },
  ],
  generate: (p) => `# TileSet 创建 — 注意调用顺序：先 add_source，再操作 TileData
var tileset := TileSet.new()
tileset.tile_size = Vector2i(${p.tile_size ?? "16"}, ${p.tile_size ?? "16"})

# 1. 创建并添加 source（必须先于 TileData 操作）
var atlas := TileSetAtlasSource.new()
atlas.texture_region_size = Vector2i(${p.tile_size ?? "16"}, ${p.tile_size ?? "16"})
var source_id := tileset.add_source(atlas)  # ← 先注册 source

# 2. 添加碰撞层
tileset.add_physics_layer()
tileset.set_physics_layer_collision_layer(0, 1)
tileset.set_physics_layer_collision_mask(0, 1)

# 3. 现在可以安全操作 TileData
for y in range(${p.rows ?? "4"}):
\tfor x in range(${p.columns ?? "4"}):
\t\tatlas.create_tile(Vector2i(x, y))  # ← 先创建瓦片
\t\tvar tile_data: TileData = atlas.get_tile_data(Vector2i(x, y), 0)
\t\tif tile_data:
\t\t\ttile_data.add_collision_polygon(0)
\t\t\ttile_data.set_collision_polygon_points(0, 0, PackedVector2Array([
\t\t\t\tVector2(0, 0), Vector2(${p.tile_size ?? "16"}, 0),
\t\t\t\tVector2(${p.tile_size ?? "16"}, ${p.tile_size ?? "16"}), Vector2(0, ${p.tile_size ?? "16"}),
\t\t\t]))
`.trim(),
};

// ─── Exports ────────────────────────────────────────────────────────────────

// 2026-08-19 verifiedGodotVersion 全量升 4.7:逐模板 generate({}) 产物在 Godot 4.7.2 --check-only
// 验证(独立编译 13/14 过;T003 系"类级 var+语句+func 混合粘贴片段"无法独立编译、A002 系模式骨架
// 仅定义首个状态处理——两者经 4.6.3 对照行为逐字一致验证,4.7 唯一 GDScript breaking
// (accessibility,L025)不涉及)。T010 同批修复 match 枚举前缀缺失。
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
  tilesetAtlasSetup,
];

// ─── Project scaffold templates ───────────────────────────────────────────────

interface ScaffoldTemplate {
  scenes: string[];
  scripts: string[];
  mainScene: string;
}

export const PROJECT_TEMPLATES: Record<string, ScaffoldTemplate> = {
  '2d-platformer': {
    scenes: ['Player.tscn', 'Level.tscn', 'HUD.tscn'],
    scripts: ['player.gd', 'hud.gd'],
    mainScene: 'res://scenes/Level.tscn',
  },
  '3d-fps': {
    scenes: ['Player.tscn', 'Level.tscn', 'HUD.tscn'],
    scripts: ['player.gd', 'weapon.gd', 'hud.gd'],
    mainScene: 'res://scenes/Level.tscn',
  },
  'visual-novel': {
    scenes: ['MainMenu.tscn', 'GameScene.tscn', 'DialogBox.tscn'],
    scripts: ['dialog_manager.gd', 'game_manager.gd'],
    mainScene: 'res://scenes/MainMenu.tscn',
  },
};

interface ScaffoldFile {
  path: string;
  content: string;
}

export function getScaffoldFiles(templateName: string, projectName: string): ScaffoldFile[] {
  const tmpl = PROJECT_TEMPLATES[templateName];
  if (!tmpl) return [];

  const files: ScaffoldFile[] = [];

  for (const scene of tmpl.scenes) {
    const baseName = scene.replace('.tscn', '');
    const scriptRel = tmpl.scripts.find(s => s.replace('.gd', '').toLowerCase() === baseName.toLowerCase());
    const hasScript = !!scriptRel;

    const lines = [
      `[gd_scene load_steps=2 format=3]`,
      '',
    ];
    if (hasScript) {
      lines.push(`[ext_resource type="Script" path="res://scripts/${scriptRel}" id="1"]`, '');
    }
    lines.push(`[node name="${baseName}" type="Node2D"]`);
    if (hasScript) {
      lines.push('script = ExtResource("1")');
    }
    lines.push('');

    files.push({ path: `scenes/${scene}`, content: lines.join('\n') });
  }

  for (const script of tmpl.scripts) {
    const className = script.replace('.gd', '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    files.push({
      path: `scripts/${script}`,
      content: [
        `extends Node2D`,
        '',
        `# ${className} — ${projectName}`,
        '',
        `func _ready() -> void:`,
        `\tpass`,
        '',
      ].join('\n'),
    });
  }

  return files;
}

// ─── Architecture pattern templates ───────────────────────────────────────────

interface ArchTemplate {
  id: string;
  name: string;
  description: string;
  params: TemplateParam[];
  generate: (params: Record<string, string>) => string;
}

export const ARCHITECTURE_TEMPLATES: Record<string, ArchTemplate> = {
  'observer-pattern': {
    id: 'A001',
    name: 'observer_pattern',
    description: '信号驱动的观察者模式',
    params: [
      { name: 'signal_name', type: 'string', default: 'health_changed' },
      { name: 'class_name', type: 'string', default: 'Player' },
    ],
    generate: (p) => `extends Node
class_name ${p.class_name || 'Player'}

# ── Observer pattern: signal-driven ──
signal ${(p.signal_name || 'health_changed')}(new_value: int)

@export var max_health: int = 100
var current_health: int:
	set(v):
		current_health = clampi(v, 0, max_health)
		${(p.signal_name || 'health_changed')}.emit(current_health)

func take_damage(amount: int) -> void:
	current_health -= amount

# ── Observer: connect in _ready ──
# health_changed.connect(_on_health_changed)
# func _on_health_changed(new_hp: int) -> void:
#     if new_hp <= 0: _die()
`,
  },
  'state-machine': {
    id: 'A002',
    name: 'state_machine',
    description: '枚举驱动的状态机模式',
    params: [
      { name: 'states', type: 'string', default: 'idle,run,jump' },
      { name: 'class_name', type: 'string', default: 'Character' },
    ],
    generate: (p) => {
      const statesStr = p.states || 'idle,run,jump';
      const states = statesStr.split(',').map(s => s.trim().toUpperCase());
      const className = p.class_name || 'Character';
      return `extends CharacterBody2D
class_name ${className}

# ── State machine pattern ──
enum State { ${states.join(', ')} }
var state: State = State.${states[0]!}

func _physics_process(delta: float) -> void:
	match state:
		State.${states[0]!}:
			_process_${states[0]!.toLowerCase()}(delta)
${states.slice(1).map(s => `\t\tState.${s}:\n\t\t\t_process_${s.toLowerCase()}(delta)`).join('\n')}

func _transition_to(new_state: State) -> void:
	if state == new_state: return
	_exit_state(state)
	state = new_state
	_enter_state(state)

func _enter_state(s: State) -> void: pass
func _exit_state(s: State) -> void: pass
func _process_${states[0]!.toLowerCase()}(_delta: float) -> void: pass
`;
    },
  },
  'component-system': {
    id: 'A003',
    name: 'component_system',
    description: 'Node 组合的组件系统',
    params: [
      { name: 'class_name', type: 'string', default: 'Entity' },
    ],
    generate: (p) => `extends Node2D
class_name ${p.class_name || 'Entity'}

# ── Component system: node composition ──
# Add components as child nodes, each handles one concern

@onready var components: Dictionary = {}

func _ready() -> void:
	for child in get_children():
		if child.has_method(&"get_component_name"):
			components[child.get_component_name()] = child

func get_component(name: String) -> Node:
	return components.get(name)

func add_component(comp: Node) -> void:
	add_child(comp)
	if comp.has_method(&"get_component_name"):
		components[comp.get_component_name()] = comp

func remove_component(name: String) -> void:
	var comp = components.get(name)
	if comp:
		remove_child(comp)
		comp.queue_free()
		components.erase(name)
`,
  },
  'event-bus': {
    id: 'A004',
    name: 'event_bus',
    description: 'Autoload 单例事件总线',
    params: [],
    generate: (_p) => `extends Node
class_name EventBus

# ── Event bus: autoload singleton ──
# Add as Autoload in Project Settings → AutoLoad (name: EventBus)

signal game_started
signal game_paused
signal level_completed(level_num: int)
signal player_died

# Typed event dispatchers
static func emit_game_started() -> void:
	(_get_bus()).game_started.emit()

static func emit_player_died() -> void:
	(_get_bus()).player_died.emit()

static func emit_level_completed(num: int) -> void:
	(_get_bus()).level_completed.emit(num)

static func _get_bus() -> Node:
	return Engine.get_main_loop().root.get_node("/root/EventBus")
`,
  },
};

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
  "L018": "T011",
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

  // A-2 (2026-06-24 审查): 校验数组元素结构,不只查"是数组"。不可信 .mcp-templates/ 输入。
  // variables 元素须为 TemplateParam(name/type/default 字符串);tags/appliesTo 元素须为字符串。
  let variables: TemplateParam[] | undefined;
  if (t.variables !== undefined) {
    if (!Array.isArray(t.variables)) return null;
    variables = [];
    for (const v of t.variables) {
      if (!v || typeof v !== 'object') return null;
      const vp = v as Record<string, unknown>;
      if (typeof vp.name !== 'string' || !vp.name) return null;
      if (typeof vp.type !== 'string') return null;
      if (typeof vp.default !== 'string') return null;
      variables.push({ name: vp.name, type: vp.type, default: vp.default });
    }
  }
  if (t.tags !== undefined && !Array.isArray(t.tags)) return null;
  if (t.appliesTo !== undefined && !Array.isArray(t.appliesTo)) return null;
  const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : undefined;
  const appliesTo = Array.isArray(t.appliesTo) ? t.appliesTo.filter((x): x is string => typeof x === 'string') : undefined;

  return {
    id: t.id,
    name: t.name,
    code: t.code,
    description: typeof t.description === 'string' ? t.description : '',
    ...(tags ? { tags } : {}),
    ...(appliesTo ? { appliesTo } : {}),
    ...(variables ? { variables } : {}),
    ...(typeof t.godotVersion === 'string' ? { godotVersion: t.godotVersion } : {}),
  };
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
        getLogger().warn('code-templates', `User template '${id}' in ${file} overrides built-in template`);
      }

      userTemplates.push({
        id,
        name: validated.name,
        description: validated.description ?? '',
        relatedRules: [],
        params: validated.variables ?? [],
        generate: (p) => renderTemplate(validated.code, p),
        verifiedGodotVersion: validated.godotVersion ?? '4.2',
        lastVerified: new Date().toISOString().split('T')[0]!,
        tags: validated.tags ?? [],
        appliesTo: validated.appliesTo ?? [],
      });
    } catch (err) {
      getLogger().warn('code-templates', `Failed to load ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return userTemplates;
}

/** Sanitize a user template variable value to prevent GDScript injection.
 *  渲染结果直接写入 .gd 文件并经 run_project 执行，且写入路径不经过 scanGdscriptSandbox，
 *  故白名单必须排除 GDScript 语句分隔符。换行符(\n\r\f\v)是语句分隔符，允许即等同于
 *  允许注入新语句（如 `Vector3(0,5,10)\nOS.execute("calc")` → RCE）。
 *  仅保留空格与制表符（表达式内可读性所需，非语句分隔符）。 */
function sanitizeTemplateValue(value: string): string {
  if (!/^[A-Za-z0-9_."() \t,\-+*/%:!<>#]+$/.test(value)) {
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

/** 获取所有模板（内置 + 架构模式 + 用户） */
export function getAllTemplates(projectPath?: string): CodeTemplate[] {
  const builtIn = [...TEMPLATES];
  // 架构模式模板转换为 CodeTemplate 格式并入
  const archTemplates: CodeTemplate[] = Object.values(ARCHITECTURE_TEMPLATES).map(at => ({
    id: at.id,
    name: at.name,
    description: at.description,
    relatedRules: [],
    params: at.params,
    generate: at.generate,
    verifiedGodotVersion: '4.7',
    lastVerified: '2026-08-19',
    tags: ['architecture', 'pattern'],
  }));
  builtIn.push(...archTemplates);

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
  console.warn(`[DEPRECATED] code-templates module is absorbed into project. Do not register directly.`);
  return [
    {
      name: 'templates',
      description: '代码模板操作。list: 列出可用模板（内置 + 用户自定义），支持按标签或适用类过滤。apply: 将模板应用到指定脚本路径，支持变量替换。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: ['list', 'apply'],
            description: '操作类型',
          },
          tag: { type: 'string', description: 'list: Filter by tag keyword' },
          applies_to: { type: 'string', description: 'list: Filter by applicable class name' },
          template_id: { type: 'string', description: 'apply: Template ID to apply (e.g. T008, user-custom)' },
          script_path: { type: 'string', description: 'apply: Target script path relative to project (e.g. res://scripts/player.gd)' },
          variables: {
            type: 'object',
            description: 'apply: Template variable overrides (key-value pairs)',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['action'],
      },
    },
  ];
}

// B-1 (2026-08-14): 删除死标签 TOOL_META { templates: { readonly: true } }。
// 'templates' 从未注册为独立工具(v0.18.0 起 code-templates 合并进 project 的
// list_templates/apply_template action,risk 在 project.ts TOOL_META 声明:
// apply_template: 'write')。保留 readonly:true 死标签的风险:若未来误把本模块
// 直接注册,apply(写文件)会被错误标只读、绕过确认门。

// ─── Exported handler for project module merge (v0.18.0) ────────────────────

/** action 名映射：目标模块使用 list_templates/apply_template → 内部 list/apply */
const TEMPLATE_ACTION_MAP: Record<string, string> = {
  'list_templates': 'list',
  'apply_template': 'apply',
};

/** 供 project 模块合并调用（v0.18.0 action 路由统一） */
export async function handleTemplateAction(
  action: string, args: Record<string, unknown>, ctx: unknown
): Promise<ToolResult | null> {
  const mappedAction = TEMPLATE_ACTION_MAP[action] ?? action;
  if (mappedAction !== 'list' && mappedAction !== 'apply') return null;
  const patchedArgs = { ...args, action: mappedAction };
  return handleTool('templates', patchedArgs, ctx);
}

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: unknown
): Promise<ToolResult | null> {
  if (name !== 'templates') return null;

  const action = args.action as string;
  if (!action) return errorResult('action is required');

  const projectPath = typeof args.project_path === 'string' && args.project_path ? validateProjectRoot(args.project_path) : undefined;

  if (action === 'list') {
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

  if (action === 'apply') {
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
      const raw = String(userVars[param.name] ?? param.default);
      variables[param.name] = sanitizeTemplateValue(raw);
    }

    const code = template.generate(variables);
    const fullPath = resolveWithinRoot(projectPath, scriptPath);
    // B-1 (SEC-P1-1): apply_template 渲染结果写 .gd 前过沙箱扫描(此前裸 writeFileSync 绕过;
    // .mcp-templates/ 用户模板 validateUserTemplate 零内容审查,投毒模板可经此渲染写危险 .gd)。
    // 非 .gd 目标路径 scanScriptSandboxOrThrow 直接放行不受影响。
    const sandboxGuard = scanScriptSandboxOrThrow(code, fullPath);
    if (sandboxGuard) return sandboxGuard;
    ensureDir(fullPath);
    writeFileSync(fullPath, code, 'utf-8');

    return okResult(`Template '${template.name}' applied to ${scriptPath} (${code.split('\n').length} lines)`);
  }

  return null;
}
