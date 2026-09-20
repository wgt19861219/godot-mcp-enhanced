import type { Tool } from "@modelcontextprotocol/server";
import { ProfilerError } from '../core/function-profiler.js';
import { textResult } from '../types.js';
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { requireProjectPath } from '../core/args-validation.js';
import { executeGdscriptRuntime as executeGdscript } from '../gdscript-executor.js';
import { escapeForGdLiteral, ff } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['profiler'] as const;

const DIMENSION_MAP: Record<string, { gdConstant: string; label: string }> = {
  'process':     { gdConstant: 'Performance.TIME_PROCESS',           label: 'process' },
  'physics':     { gdConstant: 'Performance.TIME_PHYSICS_PROCESS',   label: 'physics' },
  'nav_process': { gdConstant: 'Performance.TIME_NAVIGATION_PROCESS', label: 'nav_process' },
};
const VALID_DIMENSIONS = new Set(Object.keys(DIMENSION_MAP));

function parseDimensions(raw: unknown): { dimensions: string[]; warnings: string[] } {
  let dims: string[];
  const warnings: string[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    const nonStrings = raw.filter(d => typeof d !== 'string');
    if (nonStrings.length > 0) {
      warnings.push(`Non-string dimension elements ignored: ${nonStrings.map(String).join(', ')}`);
    }
    dims = raw.filter(d => typeof d === 'string');
  } else {
    return { dimensions: ['process'], warnings };
  }
  // Dimensions are validated against VALID_DIMENSIONS whitelist — no injection risk into GDScript template
  const invalid = dims.filter(d => !VALID_DIMENSIONS.has(d));
  const valid = dims.filter(d => VALID_DIMENSIONS.has(d));
  if (invalid.length > 0) {
    warnings.push(`Unknown dimensions ignored: ${invalid.join(', ')}. Valid: ${[...VALID_DIMENSIONS].join(', ')}`);
  }
  if (valid.length === 0) {
    warnings.push('No valid dimensions provided, falling back to process');
    return { dimensions: ['process'], warnings };
  }
  return { dimensions: valid, warnings };
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'profiler',
      description:
        '性能分析工具。snapshot: 快照（FPS/内存/绘制调用/物理统计）。start/stop: 开始/停止分析会话。get_data: 收集帧级数据，含多维度采样、p99百分位、趋势退化检测、内存趋势、渲染统计。get_active_processes: 遍历场景树查找有 _process/_physics_process 的节点。get_signal_connections: 列出子树所有信号连接。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: ['snapshot', 'start', 'stop', 'get_data', 'get_active_processes', 'get_signal_connections', 'capture_functions'],
            description: '操作类型。capture_functions(P2,2026-09-11):函数级热点——需先 run_project(profiling=true) 起 spawn 会话,一次调用完成采样窗口+排名(引擎原生 profiler 流,等价编辑器 Profiler 面板;帧级 get_data 之外的函数级 self/total 热点+最慢帧 top30)',
          },
          target_fps: { type: 'number', description: '目标帧率，用于帧预算分析（get_data，默认 60）' },
          frame_count: { type: 'number', description: '采样帧数（get_data，默认 60）' },
          dimensions: {
            type: 'array',
            items: { type: 'string' },
            description: '采样维度列表（get_data，默认 ["process"]）。有效值: process, physics, nav_process',
          },
          leak_threshold_mb: { type: 'number', description: '内存泄漏嫌疑阈值 MB（get_data，默认 2.0）' },
          node_path: { type: 'string', description: '子树根节点路径（get_active_processes/get_signal_connections，默认 root）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          seconds: { type: 'number', description: 'capture_functions: 采样窗口秒数(默认 3,上限 60;窗口从首帧真实数据起算,自动停)' },
          top: { type: 'number', description: 'capture_functions: 返回热点行数(默认 20,上限 100,按 sort 排序)' },
          sort: { type: 'string', description: 'capture_functions: 排序键(selfMs|totalMs|calls,默认 selfMs)' },
          capture_limit: { type: 'number', description: 'capture_functions: 引擎每帧行数上限(默认 256,范围 16-512;越大覆盖函数越多开销越高)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genSnapshot(): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _data: Dictionary = {}
\t_data["fps"] = Performance.get_monitor(Performance.TIME_FPS)
\t_data["process_time_ms"] = Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
\t_data["physics_process_time_ms"] = Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0
\t_data["memory_static_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_data["object_count"] = int(Performance.get_monitor(Performance.OBJECT_COUNT))
\t_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_data["node_count"] = int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
\t_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_data["draw_calls"] = int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
\t_data["objects_drawn"] = int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME))
\t_data["physics_3d_active_objects"] = int(Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS))
\t_data["physics_3d_collision_pairs"] = int(Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS))
\t_mcp_output("snapshot", _data)
\t_mcp_done()
`;
}

function genStart(): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\t_mcp_output("result", {"status": "profiling_started", "message": "Use get_data to collect frame data after waiting some frames"})
\t_mcp_done()
`;
}

function genStop(): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\t_mcp_output("result", {"status": "profiling_stopped"})
\t_mcp_done()
`;
}

function genGetData(
  targetFps: number,
  frameCount: number,
  dimensions: string[],
  leakThresholdMb: string,
): string {
  const dimDeclarations: string[] = [];
  const dimSampling: string[] = [];
  const dimAnalysis: string[] = [];

  for (const dim of dimensions) {
    const entry = DIMENSION_MAP[dim];
    if (!entry) continue;
    const { gdConstant, label } = entry;
    const varName = `_mcp_dim_${label}`;
    dimDeclarations.push(`var ${varName}: Array = []`);
    dimSampling.push(`${varName}.append(Performance.get_monitor(${gdConstant}) * 1000.0)`);
    dimAnalysis.push(`
\tvar _${label}_n: int = ${varName}.size()
\tif _${label}_n > 0:
\t\tvar _${label}_sorted: Array = ${varName}.duplicate()
\t\t_${label}_sorted.sort()
\t\tvar _${label}_total: float = 0.0
\t\tfor _t in ${varName}:
\t\t\t_${label}_total += _t
\t\tvar _${label}_avg: float = _${label}_total / float(_${label}_n)
\t\tvar _${label}_min: float = _${label}_sorted[0]
\t\tvar _${label}_max: float = _${label}_sorted[_${label}_n - 1]
\t\tvar _${label}_p50: float = _${label}_sorted[int(_${label}_n * 0.5)]
\t\tvar _${label}_p95_idx: int = int(_${label}_n * 0.95)
\t\tif _${label}_p95_idx >= _${label}_n:
\t\t\t_${label}_p95_idx = _${label}_n - 1
\t\tvar _${label}_p95: float = _${label}_sorted[_${label}_p95_idx]
\t\tvar _${label}_p99_idx: int = int(_${label}_n * 0.99)
\t\tif _${label}_p99_idx >= _${label}_n:
\t\t\t_${label}_p99_idx = _${label}_n - 1
\t\tvar _${label}_p99: float = _${label}_sorted[_${label}_p99_idx]
\t\tvar _${label}_over: int = 0
\t\tfor _t in ${varName}:
\t\t\tif _t > _frame_budget_ms:
\t\t\t\t_${label}_over += 1
\t\t# Spike detection (single-frame anomaly: frame time > 2x median)
\t\tvar _${label}_spike_threshold: float = _${label}_p50 * 2.0
\t\tvar _${label}_spikes: Array = []
\t\tfor _i in range(_${label}_n):
\t\t\tif ${varName}[_i] > _${label}_spike_threshold:
\t\t\t\t_${label}_spikes.append({"frame": _i, "time_ms": ${varName}[_i]})
\t\t# Degradation detection (require at least 2 samples for comparison)
\t\tvar _${label}_degradation_pct: float = 0.0
\t\tvar _${label}_degradation_detected: bool = false
\t\tvar _${label}_first_half_avg_ms: float = 0.0
\t\tvar _${label}_second_half_avg_ms: float = 0.0
\t\tif _${label}_n >= 2:
\t\t\tvar _${label}_half: int = _${label}_n / 2
\t\t\tvar _${label}_fh_sum: float = 0.0
\t\t\tvar _${label}_sh_sum: float = 0.0
\t\t\tfor _i in range(_${label}_half):
\t\t\t\t_${label}_fh_sum += ${varName}[_i]
\t\t\tfor _i in range(_${label}_half, _${label}_n):
\t\t\t\t_${label}_sh_sum += ${varName}[_i]
\t\t\t_${label}_first_half_avg_ms = _${label}_fh_sum / float(_${label}_half)
\t\t\t_${label}_second_half_avg_ms = _${label}_sh_sum / float(_${label}_n - _${label}_half)
\t\t\tif _${label}_first_half_avg_ms > 0.0:
\t\t\t\t_${label}_degradation_pct = ((_${label}_second_half_avg_ms - _${label}_first_half_avg_ms) / _${label}_first_half_avg_ms) * 100.0
\t\t\t\t_${label}_degradation_detected = _${label}_degradation_pct > 10.0
\t\tvar _${label}_data: Dictionary = {}
\t\t_${label}_data["label"] = "${label}"
\t\t_${label}_data["frame_count"] = _${label}_n
\t\t_${label}_data["avg_ms"] = _${label}_avg
\t\t_${label}_data["min_ms"] = _${label}_min
\t\t_${label}_data["max_ms"] = _${label}_max
\t\t_${label}_data["p50_ms"] = _${label}_p50
\t\t_${label}_data["p95_ms"] = _${label}_p95
\t\t_${label}_data["p99_ms"] = _${label}_p99
\t\t_${label}_data["over_budget_count"] = _${label}_over
\t\t_${label}_data["over_budget_pct"] = (float(_${label}_over) / float(_${label}_n)) * 100.0
\t\t_${label}_data["spike_count"] = _${label}_spikes.size()
\t\t_${label}_data["spikes"] = _${label}_spikes
\t\t_${label}_data["degradation_pct"] = _${label}_degradation_pct
\t\t_${label}_data["degradation_detected"] = _${label}_degradation_detected
\t\t_${label}_data["first_half_avg_ms"] = _${label}_first_half_avg_ms
\t\t_${label}_data["second_half_avg_ms"] = _${label}_second_half_avg_ms
\t\t_dim_results.append(_${label}_data)
`.trimStart());
  }

  return `${SCENE_TREE_HEADER}
${dimDeclarations.join('\n')}
var _mcp_target_fps: float = ${targetFps}
var _mcp_frame_count: int = ${frameCount}
var _mcp_collected: int = 0
var _frame_budget_ms: float = 1000.0 / _mcp_target_fps
var _mem_start: Dictionary = {}
var _mem_end: Dictionary = {}
var _render_start: Dictionary = {}
var _render_end: Dictionary = {}

func _capture_memory() -> Dictionary:
\treturn {
\t\t"static_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
\t\t"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
\t\t"resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
\t\t"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
\t}

func _initialize():
\t_mcp_load_main_scene()
\t_mem_start = _capture_memory()
\t_render_start = {
\t\t"draw_calls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
\t\t"objects_drawn": int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)),
\t}

func _process(_delta: float):
\t${dimSampling.join('\n\t')}
\t_mcp_collected += 1
\tif _mcp_collected >= _mcp_frame_count:
\t\t_analyze_and_report()

func _analyze_and_report():
\t_mem_end = _capture_memory()
\t_render_end = {
\t\t"draw_calls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
\t\t"objects_drawn": int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)),
\t}
\tvar _dim_results: Array = []
\t${dimAnalysis.join('\n\t')}
\t# Frame budget summary
\tvar _frame_data: Dictionary = {}
\t_frame_data["target_fps"] = _mcp_target_fps
\t_frame_data["frame_budget_ms"] = _frame_budget_ms
\t_frame_data["frame_count"] = _mcp_frame_count
\t_frame_data["dimension_stats"] = _dim_results
\t_mcp_output("frame_analysis", _frame_data)
\t# Memory trend
\tvar _mem_delta: float = _mem_end.get("static_mb", 0.0) - _mem_start.get("static_mb", 0.0)
\tvar _mem_data: Dictionary = {}
\t_mem_data["start_static_mb"] = _mem_start.get("static_mb", 0.0)
\t_mem_data["end_static_mb"] = _mem_end.get("static_mb", 0.0)
\t_mem_data["object_count"] = _mem_end.get("object_count", 0)
\t_mem_data["resource_count"] = _mem_end.get("resource_count", 0)
\t_mem_data["node_count"] = _mem_end.get("node_count", 0)
\t_mem_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\tvar _mem_trend: Dictionary = {}
\t_mem_trend["start_static_mb"] = _mem_start.get("static_mb", 0.0)
\t_mem_trend["end_static_mb"] = _mem_end.get("static_mb", 0.0)
\t_mem_trend["delta_mb"] = _mem_delta
\t_mem_trend["leak_suspected"] = _mem_delta > ${leakThresholdMb}
\t_mem_data["memory_trend"] = _mem_trend
\t_mcp_output("memory_stats", _mem_data)
\t# Render stats (independent block)
\tvar _render_data: Dictionary = {}
\t_render_data["start_draw_calls"] = _render_start.get("draw_calls", 0)
\t_render_data["end_draw_calls"] = _render_end.get("draw_calls", 0)
\t_render_data["start_objects_drawn"] = _render_start.get("objects_drawn", 0)
\t_render_data["end_objects_drawn"] = _render_end.get("objects_drawn", 0)
\t_mcp_output("render_stats", _render_data)
\t_mcp_done()
`;
}

function genGetActiveProcesses(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _search_root: Node = _root
\tif "${escapeForGdLiteral(nodePath)}" != "":
\t\t_search_root = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\t\tif _search_root == null:
\t\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t\t_mcp_done()
\t\t\treturn
\tvar _results: Array = []
\tvar _stack: Array = [_search_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node = _stack.pop_back()
\t\tvar _has_process: bool = _n.has_method("_process")
\t\tvar _has_physics: bool = _n.has_method("_physics_process")
\t\tif _has_process or _has_physics:
\t\t\tvar _entry: Dictionary = {}
\t\t\t_entry["path"] = str(_n.get_path()).trim_prefix("/root/")
\t\t\t_entry["type"] = _n.get_class()
\t\t\t_entry["has_process"] = _has_process
\t\t\t_entry["has_physics_process"] = _has_physics
\t\t\t_results.append(_entry)
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("active_processes", _results)
\t_mcp_output("total_count", _results.size())
\t_mcp_done()
`;
}

function genGetSignalConnections(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _search_root: Node = _root
\tif "${escapeForGdLiteral(nodePath)}" != "":
\t\t_search_root = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\t\tif _search_root == null:
\t\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t\t_mcp_done()
\t\t\treturn
\tvar _results: Array = []
\tvar _stack: Array = [_search_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node = _stack.pop_back()
\t\tvar _sig_list: Array = _n.get_signal_list()
\t\tfor _sig_info in _sig_list:
\t\t\tvar _sig_name: String = _sig_info["name"]
\t\t\tvar _conns: Array = _n.get_signal_connection_list(_sig_name)
\t\t\tfor _conn in _conns:
\t\t\t\tvar _entry: Dictionary = {}
\t\t\t\t_entry["source_path"] = str(_n.get_path()).trim_prefix("/root/")
\t\t\t\t_entry["signal_name"] = _sig_name
\t\t\t\tvar _target_obj: Object = _conn["callable"].get_object()
\t\t\t\tif _target_obj is Node:
\t\t\t\t\t_entry["target_path"] = str((_target_obj as Node).get_path()).trim_prefix("/root/")
\t\t\t\telse:
\t\t\t\t\t_entry["target_path"] = str(_target_obj)
\t\t\t\t_entry["target_method"] = _conn["callable"].get_method()
\t\t\t\t_entry["flags"] = _conn["flags"]
\t\t\t\t_results.append(_entry)
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("signal_connections", _results)
\t_mcp_output("total_count", _results.size())
\t_mcp_done()
`;
}

function ensurePositiveInt(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got: ${JSON.stringify(v)}`);
  }
  return Math.round(n);
}

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const action = args.action as string;
    const loadAutoloads = (args.load_autoloads as boolean) !== false;
    const godotPath = await ctx.findGodot();

    let code: string;
    let timeout: number = 30;

    // P2 (2026-09-11) 函数级 profiling:不走 executeGdscript——DebuggerProfiler 在 TS 侧
    // 解码引擎 debugger 流(--remote-debug 回拨,run_project(profiling=true) 时建立)。
    if (action === 'capture_functions') {
      const profiler = ctx.functionProfiler;
      if (!profiler) {
        return opsErrorResult('PROFILER_NOT_SPAWNED',
          'capture_functions needs a profiling spawn: run_project with profiling=true first (the debugger channel only exists if --remote-debug was on the command line at launch; attached/already-running sessions cannot profile).');
      }
      const seconds = args.seconds !== undefined ? Number(args.seconds) : 3;
      const top = args.top !== undefined ? Number(args.top) : 20;
      const sort = (args.sort as string) ?? 'selfMs';
      const captureLimit = args.capture_limit !== undefined ? Number(args.capture_limit) : 256;
      try {
        const result = await profiler.captureWindow(seconds, top, sort as 'selfMs' | 'totalMs' | 'calls', captureLimit);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof ProfilerError) {
          return opsErrorResult(`PROFILER_${err.code.toUpperCase()}`, err.message);
        }
        throw err;
      }
    }

    switch (action) {
      case 'snapshot':
        code = genSnapshot();
        break;
      case 'start':
        code = genStart();
        break;
      case 'stop':
        code = genStop();
        break;
      case 'get_data': {
        const targetFps = args.target_fps !== undefined
          ? ensurePositiveInt(args.target_fps, 'target_fps', 1, 1000)
          : 60;
        const frameCount = args.frame_count !== undefined
          ? ensurePositiveInt(args.frame_count, 'frame_count', 1, 600)
          : 60;
        const { dimensions, warnings: dimWarnings } = parseDimensions(args.dimensions);
        const rawThreshold = Number(args.leak_threshold_mb);
        const leakThresholdMb = args.leak_threshold_mb !== undefined
          ? (Number.isFinite(rawThreshold) && rawThreshold > 0
            ? Math.max(0.1, rawThreshold)
            : 2.0)
          : 2.0;
        const leakThresholdStr = ff(leakThresholdMb);
        code = genGetData(targetFps, frameCount, dimensions, leakThresholdStr);
        timeout = 45;
        const gdResult = await executeGdscript({
          godotPath,
          projectPath,
          code,
          timeout,
          loadAutoloads,
        });
        return parseGdscriptResult(gdResult, dimWarnings);
      }
      case 'get_active_processes': {
        const nodePath = (args.node_path as string) ?? '';
        code = genGetActiveProcesses(nodePath);
        break;
      }
      case 'get_signal_connections': {
        const nodePath = (args.node_path as string) ?? '';
        code = genGetSignalConnections(nodePath);
        break;
      }
      default:
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout,
      loadAutoloads,
    });

    return parseGdscriptResult(result);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  profiler: {
    readonly: false,
    long_running: false,
    // 该工具原不在 GUARDED 表中 → 所有 action 此前一律不确认 → 零行为改变要求全部标 'read'
    // （任何非 read 都会收紧确认，超出本次迁移范围；见 spec §4.1）
    actionRisks: {
      snapshot: 'read',
      start: 'read',
      stop: 'read',
      get_data: 'read',
      capture_functions: 'read',
      get_active_processes: 'read',
      get_signal_connections: 'read',
    },
  },
};
