// ─── Code Template Types ────────────────────────────────────────────────────

interface TemplateParam {
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
