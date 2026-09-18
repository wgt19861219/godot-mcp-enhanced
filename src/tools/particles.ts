import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { normalizeNodePath, gdEscape, escapeForGdLiteral, validateVector3, clampParam, SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, runOpsScript } from './shared.js';
import { ff } from './shared/value-serializer.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ACTIONS = [
  'particles_create',
  'particles_set_emission',
  'particles_set_process',
  'particles_load_preset',
  'particles_set_material',
] as const;

const PARTICLE_NODE_TYPES = ['GPUParticles2D', 'GPUParticles3D'] as const;

const EMISSION_SHAPES = ['point', 'sphere', 'box', 'ring'] as const;

const PRESETS = ['fire', 'smoke', 'rain', 'snow', 'sparkle', 'explosion'] as const;

const PRESET_CONFIGS: Record<string, Record<string, unknown>> = {
  fire: { amount: 40, lifetime: 1.5, gravity: { x: 0, y: -5, z: 0 }, spread: 30, explosiveness: 0.3, damping: 2 },
  smoke: { amount: 20, lifetime: 3, gravity: { x: 0, y: -1, z: 0 }, spread: 10, explosiveness: 0.1, damping: 3 },
  rain: { amount: 200, lifetime: 1, gravity: { x: 0, y: -20, z: 0 }, spread: 5, direction: { x: 0, y: -1, z: 0 } },
  snow: { amount: 60, lifetime: 4, gravity: { x: 0, y: -2, z: 0 }, spread: 180, randomness: 0.8 },
  sparkle: { amount: 30, lifetime: 0.5, gravity: { x: 0, y: 0, z: 0 }, spread: 180, explosiveness: 0.8 },
  explosion: { amount: 80, lifetime: 1, gravity: { x: 0, y: -3, z: 0 }, spread: 180, explosiveness: 1.0, one_shot: true },
};

const ERROR_CODES = {
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  PRESET_NOT_FOUND: 'PRESET_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateVector2(v: unknown): { x: number; y: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Vector2 must be an object with x, y number fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y']) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) throw new Error(`Vector2 field "${key}" must be a finite number`);
  }
  return { x: obj.x as number, y: obj.y as number };
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genParticlesCreateScript(
  nodeType: string, nodeName: string, parentPath: string,
  position?: { x: number; y: number } | { x: number; y: number; z: number },
  presetLines?: string,
): string {
  const is3D = nodeType === 'GPUParticles3D';
  let posLine = '';
  if (position) {
    if (is3D) {
      const p = position as { x: number; y: number; z: number };
      posLine = `\n\tnode.position = Vector3(${p.x}, ${p.y}, ${p.z})`;
    } else {
      const p = position as { x: number; y: number };
      posLine = `\n\tnode.position = Vector2(${p.x}, ${p.y})`;
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar node = ${nodeType}.new()
\tnode.name = "${gdEscape(nodeName)}"${posLine}
\tparent.add_child(node)
\tnode.owner = parent.owner if parent.owner != null else parent${presetLines ? presetLines : ''}
\t_mcp_output("created", {"type": "${gdEscape(nodeType)}", "name": "${gdEscape(nodeName)}", "path": str(node.get_path()) if node.is_inside_tree() else "${gdEscape(nodeName)}"${presetLines ? ', "preset_applied": true' : ''}})
\t_mcp_done()
`;
}

function genSetEmissionScript(
  nodePath: string,
  amount?: number,
  emissionShape?: string,
  emissionSphereRadius?: number,
  emissionBoxExtents?: { x: number; y: number; z: number },
  direction?: { x: number; y: number; z: number },
  spread?: number,
): string {
  let lines = '';
  if (amount !== undefined) {
    lines += `\n\tnode.amount = ${amount}`;
  }
  if (emissionShape) {
    const shapeMap: Record<string, string> = {
      point: 'ParticleProcessMaterial.EMISSION_SHAPE_POINT',
      sphere: 'ParticleProcessMaterial.EMISSION_SHAPE_SPHERE',
      box: 'ParticleProcessMaterial.EMISSION_SHAPE_BOX',
      ring: 'ParticleProcessMaterial.EMISSION_SHAPE_RING',
    };
    lines += `\n\tvar mat = node.process_material`;
    lines += `\n\tif mat == null:`;
    lines += `\n\t\tmat = ParticleProcessMaterial.new()`;
    lines += `\n\t\tnode.process_material = mat`;
    lines += `\n\tmat.emission_shape = ${shapeMap[emissionShape]}`;
    if (emissionShape === 'sphere' && emissionSphereRadius !== undefined) {
      lines += `\n\tmat.emission_sphere_radius = ${emissionSphereRadius}`;
    }
    if (emissionShape === 'box' && emissionBoxExtents) {
      lines += `\n\tmat.emission_box_extents = Vector3(${emissionBoxExtents.x}, ${emissionBoxExtents.y}, ${emissionBoxExtents.z})`;
    }
  }
  if (direction) {
    lines += `\n\tvar mat_d = node.process_material`;
    lines += `\n\tif mat_d == null:`;
    lines += `\n\t\tmat_d = ParticleProcessMaterial.new()`;
    lines += `\n\t\tnode.process_material = mat_d`;
    lines += `\n\tmat_d.direction = Vector3(${ff(direction.x)}, ${ff(direction.y)}, ${ff(direction.z)})`;
  }
  if (spread !== undefined) {
    lines += `\n\tvar mat_s = node.process_material`;
    lines += `\n\tif mat_s == null:`;
    lines += `\n\t\tmat_s = ParticleProcessMaterial.new()`;
    lines += `\n\t\tnode.process_material = mat_s`;
    lines += `\n\tmat_s.spread = ${ff(spread)}`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is GPUParticles2D or node is GPUParticles3D):
\t\t_mcp_output("error", "Node is not a GPUParticles type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("emission_set", {"node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

function genSetProcessScript(
  nodePath: string,
  gravity?: { x: number; y: number; z: number },
  speedScale?: number,
  explosiveness?: number,
  randomness?: number,
  lifetime?: number,
  damping?: number,
): string {
  let lines = '';
  if (gravity) {
    lines += `\n\tvar mat_g = node.process_material`;
    lines += `\n\tif mat_g == null:`;
    lines += `\n\t\tmat_g = ParticleProcessMaterial.new()`;
    lines += `\n\t\tnode.process_material = mat_g`;
    lines += `\n\tmat_g.gravity = Vector3(${ff(gravity.x)}, ${ff(gravity.y)}, ${ff(gravity.z)})`;
  }
  if (speedScale !== undefined) {
    lines += `\n\tnode.speed_scale = ${ff(speedScale)}`;
  }
  if (explosiveness !== undefined) {
    lines += `\n\tnode.explosiveness = ${ff(explosiveness)}`;
  }
  if (randomness !== undefined) {
    lines += `\n\tnode.randomness = ${ff(randomness)}`;
  }
  if (lifetime !== undefined) {
    lines += `\n\tnode.lifetime = ${ff(lifetime)}`;
  }
  if (damping !== undefined) {
    lines += `\n\tvar mat_d = node.process_material`;
    lines += `\n\tif mat_d == null:`;
    lines += `\n\t\tmat_d = ParticleProcessMaterial.new()`;
    lines += `\n\t\tnode.process_material = mat_d`;
    lines += `\n\tmat_d.damping = Vector2(${ff(damping)}, ${ff(damping)})`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is GPUParticles2D or node is GPUParticles3D):
\t\t_mcp_output("error", "Node is not a GPUParticles type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("process_set", {"node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

function genLoadPresetScript(nodePath: string, preset: string): string {
  const cfg = PRESET_CONFIGS[preset];
  if (!cfg) return '';

  let lines = '';
  lines += `\n\tnode.amount = ${cfg.amount}`;
  lines += `\n\tnode.lifetime = ${ff(cfg.lifetime as number)}`;
  lines += `\n\tnode.explosiveness = ${ff((cfg.explosiveness ?? 0) as number)}`;
  lines += `\n\tnode.randomness = ${ff((cfg.randomness ?? 0) as number)}`;

  if (cfg.one_shot) {
    lines += `\n\tnode.one_shot = true`;
  }

  lines += `\n\tvar mat = node.process_material`;
  lines += `\n\tif mat == null:`;
  lines += `\n\t\tmat = ParticleProcessMaterial.new()`;
  lines += `\n\t\tnode.process_material = mat`;

  const gravity = cfg.gravity as { x: number; y: number; z: number } | undefined;
  if (gravity) {
    lines += `\n\tmat.gravity = Vector3(${ff(gravity.x)}, ${ff(gravity.y)}, ${ff(gravity.z)})`;
  }

  if (cfg.spread !== undefined) {
    lines += `\n\tmat.spread = ${ff(cfg.spread as number)}`;
  }

  if (cfg.damping !== undefined) {
    lines += `\n\tmat.damping = Vector2(${ff(cfg.damping as number)}, ${ff(cfg.damping as number)})`;
  }

  const direction = cfg.direction as { x: number; y: number; z: number } | undefined;
  if (direction) {
    lines += `\n\tmat.direction = Vector3(${ff(direction.x)}, ${ff(direction.y)}, ${ff(direction.z)})`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is GPUParticles2D or node is GPUParticles3D):
\t\t_mcp_output("error", "Node is not a GPUParticles type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("preset_loaded", {"node": "${escapeForGdLiteral(nodePath)}", "preset": "${gdEscape(preset)}"})
\t_mcp_done()
`;
}

function genSetMaterialScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is GPUParticles2D or node is GPUParticles3D):
\t\t_mcp_output("error", "Node is not a GPUParticles type: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar mat = ParticleProcessMaterial.new()
\tnode.process_material = mat
\t_mcp_output("material_set", {"node": "${escapeForGdLiteral(nodePath)}", "material_type": "ParticleProcessMaterial"})
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'particles',
      description: `创建 GPUParticles2D/3D 节点、设置发射/处理参数、加载预设效果、设置粒子材质。运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['particles_create', 'particles_set_emission', 'particles_set_process', 'particles_load_preset', 'particles_set_material'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          node_type: {
            type: 'string',
            enum: ['GPUParticles2D', 'GPUParticles3D'],
            description: '粒子节点类型（particles_create）',
          },
          name: { type: 'string', description: '节点名称（particles_create）' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          position: {
            type: 'object',
            description: '位置。3D 用 {x,y,z}，2D 用 {x,y}',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              z: { type: 'number' },
            },
          },
          preset: {
            type: 'string',
            enum: ['fire', 'smoke', 'rain', 'snow', 'sparkle', 'explosion'],
            description: '预设效果名称',
          },
          node_path: { type: 'string', description: '粒子节点路径' },
          amount: { type: 'number', description: '发射数量（正整数）' },
          emission_shape: {
            type: 'string',
            enum: ['point', 'sphere', 'box', 'ring'],
            description: '发射形状',
          },
          emission_sphere_radius: { type: 'number', description: '球体发射半径（emission_shape=sphere 时有效）' },
          emission_box_extents: {
            type: 'object',
            description: '盒体发射范围 {x,y,z}（emission_shape=box 时有效）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          direction: {
            type: 'object',
            description: '发射方向 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          spread: { type: 'number', description: '扩散角度（0-180 度）' },
          gravity: {
            type: 'object',
            description: '重力 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          speed_scale: { type: 'number', description: '速度缩放' },
          explosiveness: { type: 'number', description: '爆发性（0-1）' },
          randomness: { type: 'number', description: '随机性（0-1）' },
          lifetime: { type: 'number', description: '粒子生命周期（秒）' },
          damping: { type: 'number', description: '阻尼' },
          material_type: {
            type: 'string',
            description: '材质类型（ParticleProcessMaterial）',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'particles') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;
    const paramWarnings: string[] = [];

    switch (action) {
      case 'particles_create': {
        const nodeType = args.node_type as string;
        const nodeName = args.name as string;
        if (!PARTICLE_NODE_TYPES.includes(nodeType as typeof PARTICLE_NODE_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_TYPE, `Invalid node_type "${nodeType}". Must be GPUParticles2D or GPUParticles3D`);
        }
        if (!nodeName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'name is required');
        }
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const is3D = nodeType === 'GPUParticles3D';
        let position: { x: number; y: number } | { x: number; y: number; z: number } | undefined;
        if (args.position) {
          if (is3D) {
            position = validateVector3(args.position);
          } else {
            position = validateVector2(args.position);
          }
        }
        // Optional preset: generate preset GDScript lines to apply in same process
        let presetLines: string | undefined;
        const preset = args.preset as string | undefined;
        if (preset) {
          if (!PRESETS.includes(preset as typeof PRESETS[number])) {
            return opsErrorResult(ERROR_CODES.PRESET_NOT_FOUND, `Unknown preset "${preset}". Available: ${PRESETS.join(', ')}`);
          }
          const cfg = PRESET_CONFIGS[preset]!;
          let lines = '';
          lines += `\n\tnode.amount = ${cfg.amount}`;
          lines += `\n\tnode.lifetime = ${ff(cfg.lifetime as number)}`;
          lines += `\n\tnode.explosiveness = ${ff((cfg.explosiveness ?? 0) as number)}`;
          lines += `\n\tnode.randomness = ${ff((cfg.randomness ?? 0) as number)}`;
          if (cfg.one_shot) lines += `\n\tnode.one_shot = true`;
          lines += `\n\tvar mat = node.process_material`;
          lines += `\n\tif mat == null:`;
          lines += `\n\t\tmat = ParticleProcessMaterial.new()`;
          lines += `\n\t\tnode.process_material = mat`;
          const gravity = cfg.gravity as { x: number; y: number; z: number } | undefined;
          if (gravity) lines += `\n\tmat.gravity = Vector3(${ff(gravity.x)}, ${ff(gravity.y)}, ${ff(gravity.z)})`;
          if (cfg.spread !== undefined) lines += `\n\tmat.spread = ${ff(cfg.spread as number)}`;
          if (cfg.damping !== undefined) lines += `\n\tmat.damping = Vector2(${ff(cfg.damping as number)}, ${ff(cfg.damping as number)})`;
          const direction = cfg.direction as { x: number; y: number; z: number } | undefined;
          if (direction) lines += `\n\tmat.direction = Vector3(${ff(direction.x)}, ${ff(direction.y)}, ${ff(direction.z)})`;
          presetLines = lines;
        }
        script = genParticlesCreateScript(nodeType, nodeName, parentPath, position, presetLines);
        break;
      }
      case 'particles_set_emission': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const amount = clampParam(args.amount as number | undefined, 1, 100000, 'amount', paramWarnings);
        const emissionShape = args.emission_shape as string | undefined;
        if (emissionShape && !EMISSION_SHAPES.includes(emissionShape as typeof EMISSION_SHAPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `Invalid emission_shape "${emissionShape}". Must be one of: ${EMISSION_SHAPES.join(', ')}`);
        }
        const sphereRadius = args.emission_sphere_radius as number | undefined;
        if (sphereRadius !== undefined && (typeof sphereRadius !== 'number' || sphereRadius < 0 || !Number.isFinite(sphereRadius))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'emission_sphere_radius must be a non-negative finite number');
        }
        let boxExtents: { x: number; y: number; z: number } | undefined;
        if (args.emission_box_extents) {
          boxExtents = validateVector3(args.emission_box_extents);
        }
        let direction: { x: number; y: number; z: number } | undefined;
        if (args.direction) {
          direction = validateVector3(args.direction);
        }
        const spread = clampParam(args.spread as number | undefined, 0, 180, 'spread', paramWarnings);
        script = genSetEmissionScript(nodePath, amount, emissionShape, sphereRadius, boxExtents, direction, spread);
        break;
      }
      case 'particles_set_process': {
        const nodePath = normalizeNodePath(args.node_path as string);
        let gravity: { x: number; y: number; z: number } | undefined;
        if (args.gravity) {
          gravity = validateVector3(args.gravity);
        }
        const speedScale = args.speed_scale as number | undefined;
        if (speedScale !== undefined && (typeof speedScale !== 'number' || !Number.isFinite(speedScale))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'speed_scale must be a finite number');
        }
        const explosiveness = clampParam(args.explosiveness as number | undefined, 0, 1, 'explosiveness', paramWarnings);
        const randomness = clampParam(args.randomness as number | undefined, 0, 1, 'randomness', paramWarnings);
        const lifetime = args.lifetime as number | undefined;
        if (lifetime !== undefined && (typeof lifetime !== 'number' || lifetime <= 0 || !Number.isFinite(lifetime))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'lifetime must be a positive finite number');
        }
        const damping = args.damping as number | undefined;
        if (damping !== undefined && (typeof damping !== 'number' || damping < 0 || !Number.isFinite(damping))) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'damping must be a non-negative finite number');
        }
        script = genSetProcessScript(nodePath, gravity, speedScale, explosiveness, randomness, lifetime, damping);
        break;
      }
      case 'particles_load_preset': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const preset = args.preset as string;
        if (!PRESETS.includes(preset as typeof PRESETS[number])) {
          return opsErrorResult(ERROR_CODES.PRESET_NOT_FOUND, `Unknown preset "${preset}". Available: ${PRESETS.join(', ')}`);
        }
        script = genLoadPresetScript(nodePath, preset);
        break;
      }
      case 'particles_set_material': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genSetMaterialScript(nodePath);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
      return ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings, warnRuntimePersist: true, action });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector2') || msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ─────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  particles: {
    readonly: false,
    long_running: false,
    actionRisks: {
      particles_create: 'write', particles_set_emission: 'write', particles_set_process: 'write',
      particles_load_preset: 'write', particles_set_material: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
