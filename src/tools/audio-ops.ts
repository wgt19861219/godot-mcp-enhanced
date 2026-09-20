import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, gdEscape, escapeForGdLiteral, normalizeNodePath, clampParam, sanitizeResPath, runOpsScript } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PATH: 'INVALID_PATH',
} as const;

const ACTIONS = [
  'audio_play',
  'audio_stop',
  'audio_set_param',
  'audio_query',
] as const;

// ─── GDScript Generators: Audio ────────────────────────────────────────────

export function genAudioPlayScript(
  nodePath: string, streamPath?: string, volumeDb?: number,
  pitchScale?: number, bus?: string, fromPosition?: number
): string {
  let streamLine = '';
  if (streamPath) {
    streamLine = `\n\tvar stream_res = load("${escapeForGdLiteral(streamPath)}")\n\tif stream_res:\n\t\tnode.stream = stream_res`;
  }
  const fmtNum = (n: number) => Number.isInteger(n) ? n.toFixed(1) : String(n);
  const volLine = volumeDb !== undefined ? `\n\tnode.volume_db = ${volumeDb}` : '';
  const pitchLine = pitchScale !== undefined ? `\n\tnode.pitch_scale = ${fmtNum(pitchScale)}` : '';
  const busLine = bus ? `\n\tnode.bus = "${gdEscape(bus)}"` : '';
  const playArg = fromPosition !== undefined ? `(${fmtNum(fromPosition)})` : '()';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${streamLine}${volLine}${pitchLine}${busLine}
\tnode.play${playArg}
\t_mcp_output("playing", {"node": "${escapeForGdLiteral(nodePath)}", "stream": str(node.stream) if node.stream else "None"})
\t_mcp_done()
`;
}

export function genAudioStopScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.stop()
\t_mcp_output("stopped", {"node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

export function genAudioSetParamScript(
  nodePath: string, param: 'volume_db' | 'pitch_scale' | 'bus', value: number | string
): string {
  const valStr = typeof value === 'string' ? `"${gdEscape(value)}"` : String(value);
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.${param} = ${valStr}
\t_mcp_output("param_set", {"node": "${escapeForGdLiteral(nodePath)}", "param": "${param}", "value": ${valStr}})
\t_mcp_done()
`;
}

export function genAudioQueryScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tvar info = {}
\tinfo["playing"] = node.playing
\tinfo["volume_db"] = node.volume_db
\tinfo["pitch_scale"] = node.pitch_scale
\tinfo["bus"] = node.bus
\tinfo["stream"] = str(node.stream.resource_path) if node.stream else "None"
\tinfo["playback_position"] = node.get_playback_position() if node.playing else 0.0
\tinfo["stream_length"] = node.stream.get_length() if node.stream else 0.0
\tinfo["node_type"] = node.get_class()
\t_mcp_output("audio_info", info)
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'audio',
      description: `音频操作。play: 播放（支持 AudioStreamPlayer/2D/3D）。stop: 停止。set_param: 设置参数（volume_db/pitch_scale/bus）。query: 查询播放状态。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。audio_play/audio_stop=播放/停止, audio_set_param=调参(音量/音调/bus), audio_query=查播放状态',
          },
          node_path: { type: 'string', description: '音频节点路径' },
          stream_path: { type: 'string', description: 'play: 音频资源路径（res://...），不传则播放已配置的' },
          volume_db: { type: 'number', description: 'play: 音量（dB，-80 到 24）' },
          pitch_scale: { type: 'number', description: 'play: 音调缩放（0.01 到 100）' },
          bus: { type: 'string', description: 'play/set_param: 音频总线名称' },
          from_position: { type: 'number', description: 'play: 从指定位置开始播放（秒）' },
          param: { type: 'string', enum: ['volume_db', 'pitch_scale', 'bus'], description: 'set_param: 参数名' },
          value: { description: 'set_param: 参数值（number for volume_db/pitch_scale, string for bus）' },
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
  if (name !== 'audio') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;
    const paramWarnings: string[] = [];

    switch (action) {
      case 'audio_play': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const rawStream = args.stream_path as string | undefined;
        let streamPath: string | undefined;
        if (rawStream) {
          try {
            streamPath = sanitizeResPath(rawStream, 'stream_path');
          } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PATH, 'stream_path must be a res:// path (no traversal / encoding tricks)');
          }
        }
        const volumeDb = args.volume_db as number | undefined;
        const pitchScale = args.pitch_scale as number | undefined;
        const bus = args.bus as string | undefined;
        const fromPosition = args.from_position as number | undefined;
        if (fromPosition !== undefined && (typeof fromPosition !== 'number' || !Number.isFinite(fromPosition) || fromPosition < 0)) {
          return opsErrorResult('INVALID_TYPE', 'from_position must be a non-negative finite number');
        }
        const clampVol = clampParam(volumeDb, -80, 24, 'volume_db', paramWarnings);
        const clampPitch = clampParam(pitchScale, 0.01, 100, 'pitch_scale', paramWarnings);
        script = genAudioPlayScript(nodePath, streamPath, clampVol, clampPitch, bus, fromPosition);
        break;
      }
      case 'audio_stop': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioStopScript(nodePath);
        break;
      }
      case 'audio_set_param': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const param = args.param as string;
        const value = args.value;
        if (!['volume_db', 'pitch_scale', 'bus'].includes(param)) {
          return opsErrorResult('INVALID_TYPE', 'param must be volume_db, pitch_scale, or bus');
        }
        if (param === 'bus' && typeof value !== 'string') {
          return opsErrorResult('INVALID_TYPE', 'bus param requires a string value');
        }
        if (param !== 'bus' && typeof value !== 'number') {
          return opsErrorResult('INVALID_TYPE', `${param} param requires a number value`);
        }
        script = genAudioSetParamScript(nodePath, param as 'volume_db' | 'pitch_scale' | 'bus', value as number | string);
        break;
      }
      case 'audio_query': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioQueryScript(nodePath);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) =>
      (msg.includes('not found') || msg.includes('not an Audio')) ? ERROR_CODES.AUDIO_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings, warnRuntimePersist: true, action });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  audio: {
    readonly: false,
    long_running: false,
    actionRisks: {
      audio_play: 'read', audio_stop: 'read', audio_query: 'read', audio_set_param: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
