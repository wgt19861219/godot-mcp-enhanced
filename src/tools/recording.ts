import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot } from '../helpers.js';
import { executeGdscript, executeGdscriptTrusted } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, gdEscape } from './shared.js';
import { sendToBridge, setBridgeProjectDir } from './game-bridge.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  BRIDGE_NOT_CONNECTED: 'BRIDGE_NOT_CONNECTED',
  RECORDING_IN_PROGRESS: 'RECORDING_IN_PROGRESS',
  NO_RECORDING: 'NO_RECORDING',
  RECORDING_FILE_NOT_FOUND: 'RECORDING_FILE_NOT_FOUND',
  INVALID_RECORDING_FORMAT: 'INVALID_RECORDING_FORMAT',
  INVALID_FILE_NAME: 'INVALID_FILE_NAME',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ACTIONS = [
  'recording_start',
  'recording_stop',
  'recording_save',
  'recording_load',
  'recording_play',
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function sanitizeRecordingFileName(name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('INVALID_FILE_NAME: path traversal detected');
  }
  if (!/^recording_[\w-]+\.json$/.test(name)) {
    throw new Error('INVALID_FILE_NAME: must match recording_*.json pattern');
  }
  return name;
}

export function generateRecordingFileName(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `recording_${ts}.json`;
}

function validateEventsJson(eventsJson: string): { version: number; duration_ms: number; events: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventsJson);
  } catch {
    throw new Error('INVALID_RECORDING_FORMAT: events_json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('INVALID_RECORDING_FORMAT: events_json must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== 'number' || !Array.isArray(obj.events)) {
    throw new Error('INVALID_RECORDING_FORMAT: must contain version (number) and events (array)');
  }
  return obj as { version: number; duration_ms: number; events: unknown[] };
}

// ─── GDScript Generators (save/load still use SceneTree) ────────────────────

export function genRecordingSaveScript(fileName: string, eventsJsonEscaped: string): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar dir: DirAccess = DirAccess.open("res://")
\tif dir == null:
\t\t_mcp_output("error", "Failed to access res:// directory")
\t\t_mcp_done()
\t\treturn
\tif not dir.dir_exists("recordings"):
\t\tdir.make_dir("recordings")
\tvar file: FileAccess = FileAccess.open("res://recordings/${fileName}", FileAccess.WRITE)
\tif file == null:
\t\t_mcp_output("error", "Failed to open file for writing: res://recordings/${fileName}")
\t\t_mcp_done()
\t\treturn
\tvar events_data: String = JSON.stringify(JSON.parse_string("${eventsJsonEscaped}"))
\tif events_data == "":
\t\t_mcp_output("error", "Invalid events JSON")
\t\t_mcp_done()
\t\treturn
\tfile.store_string(events_data)
\tfile.close()
\t_mcp_output("saved", {"file_name": "${fileName}", "path": "res://recordings/${fileName}"})
\t_mcp_done()
`;
}

export function genRecordingLoadScript(fileName: string): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar file: FileAccess = FileAccess.open("res://recordings/${fileName}", FileAccess.READ)
\tif file == null:
\t\t_mcp_output("error", "File not found: res://recordings/${fileName}")
\t\t_mcp_done()
\t\treturn
\tvar content: String = file.get_as_text()
\tfile.close()
\tvar parsed: Variant = JSON.parse_string(content)
\tif parsed == null:
\t\t_mcp_output("error", "Invalid JSON in recording file: ${fileName}")
\t\t_mcp_done()
\t\treturn
\t_mcp_output("recording", parsed)
\t_mcp_done()
`;
}

export function genRecordingPlayScript(eventsJsonEscaped: string, speed: number): string {
  const speedStr = speed % 1 === 0 ? `${speed}.0` : String(speed);
  return `${SCENE_TREE_HEADER}

var _mcp_play_events: Array = []
var _mcp_play_index: int = 0
var _mcp_play_speed: float = ${speedStr}
var _mcp_play_timer: Timer = null

func _mcp_play_next_event() -> void:
\tif _mcp_play_index >= _mcp_play_events.size():
\t\tif _mcp_play_timer != null:
\t\t\t_mcp_play_timer.stop()
\t\t_mcp_output("playback_complete", {"events_played": _mcp_play_events.size()})
\t\t_mcp_done()
\t\treturn
\tvar evt: Dictionary = _mcp_play_events[_mcp_play_index]
\tvar evt_type: String = str(evt.get("type", ""))
\tif evt_type == "key":
\t\tvar ie: InputEventKey = InputEventKey.new()
\t\tie.keycode = int(evt.get("keycode", 0))
\t\tie.pressed = bool(evt.get("pressed", true))
\t\tie.shift_pressed = bool(evt.get("shift", false))
\t\tie.ctrl_pressed = bool(evt.get("ctrl", false))
\t\tie.alt_pressed = bool(evt.get("alt", false))
\t\tInput.parse_input_event(ie)
\telif evt_type == "mouse_click":
\t\tvar ie: InputEventMouseButton = InputEventMouseButton.new()
\t\tvar pos: Array = evt.get("position", [0.0, 0.0])
\t\tie.position = Vector2(float(pos[0]), float(pos[1]))
\t\tie.button_index = int(evt.get("button", 1))
\t\tie.pressed = bool(evt.get("pressed", true))
\t\tInput.parse_input_event(ie)
\telif evt_type == "mouse_move":
\t\tvar ie: InputEventMouseMotion = InputEventMouseMotion.new()
\t\tvar pos: Array = evt.get("position", [0.0, 0.0])
\t\tie.position = Vector2(float(pos[0]), float(pos[1]))
\t\tInput.parse_input_event(ie)
\t_mcp_play_index += 1
\tif _mcp_play_index < _mcp_play_events.size():
\t\tvar current_time: float = float(_mcp_play_events[_mcp_play_index].get("time_ms", 0))
\t\tvar prev_time: float = float(_mcp_play_events[_mcp_play_index - 1].get("time_ms", 0))
\t\tvar delay: float = (current_time - prev_time) / _mcp_play_speed
\t\t_mcp_play_timer.wait_time = clampf(delay / 1000.0, 0.016, 10.0)
\t\t_mcp_play_timer.start()
\telse:
\t\t_mcp_play_next_event()

func _initialize():
\t_mcp_load_main_scene()
\tvar parsed: Variant = JSON.parse_string("${eventsJsonEscaped}")
\tif parsed == null:
\t\t_mcp_output("error", "Invalid events JSON")
\t\t_mcp_done()
\t\treturn
\t_mcp_play_events = parsed.get("events", [])
\tif _mcp_play_events.size() == 0:
\t\t_mcp_output("playback_complete", {"events_played": 0})
\t\t_mcp_done()
\t\treturn
\t_mcp_play_speed = ${speedStr}
\t_mcp_play_timer = Timer.new()
\troot.add_child(_mcp_play_timer)
\t_mcp_play_timer.one_shot = true
\t_mcp_play_timer.connect("timeout", Callable(self, "_mcp_play_next_event"))
\t_mcp_play_index = 0
\t_mcp_play_next_event()
`;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'recording',
      description: `录制、保存、加载、回放输入事件（键盘/鼠标）。需要 Game Bridge 连接。运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['recording_start', 'recording_stop', 'recording_save', 'recording_load', 'recording_play'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          events_json: { type: 'string', description: 'JSON 格式的事件序列字符串' },
          file_name: { type: 'string', description: '录制文件名（仅接受 recording_*.json 格式）' },
          speed: { type: 'number', description: '回放速度倍率（默认 1.0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action', 'project_path'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'recording') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;

    switch (action) {
      case 'recording_start': {
        if (!loadAutoloads) {
          return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, '录制功能需要 Game Bridge 连接，headless 模式不支持。', {
            suggestion: 'Recording requires an active game bridge. Run game_bridge_install first, then start the game with run_project or F5.',
          });
        }
        if (ctx.projectDir) {
          setBridgeProjectDir(ctx.projectDir);
        }
        const resp = await sendToBridge('recording.start', {}, 5000);
        if (resp.error) {
          if (resp.error.message?.includes('Method not found')) {
            return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, '请更新项目中的 MCP Bridge 脚本以支持录制功能。运行 install-plugin 获取最新版本。');
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, resp.error.message);
        }
        const result = resp.result as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      }
      case 'recording_stop': {
        if (!loadAutoloads) {
          return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, '录制功能需要 Game Bridge 连接，headless 模式不支持。', {
            suggestion: 'Recording requires an active game bridge. Run game_bridge_install first, then start the game with run_project or F5.',
          });
        }
        if (ctx.projectDir) {
          setBridgeProjectDir(ctx.projectDir);
        }
        const resp = await sendToBridge('recording.stop', {}, 5000);
        if (resp.error) {
          if (resp.error.message?.includes('Method not found')) {
            return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, '请更新项目中的 MCP Bridge 脚本以支持录制功能。运行 install-plugin 获取最新版本。');
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, resp.error.message);
        }
        const result = resp.result as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      }
      case 'recording_save': {
        const eventsJson = args.events_json as string;
        if (!eventsJson || typeof eventsJson !== 'string') {
          return opsErrorResult('INVALID_RECORDING_FORMAT', 'events_json must be a non-empty JSON string');
        }
        // Validate JSON structure
        try {
          validateEventsJson(eventsJson);
        } catch (e) {
          return opsErrorResult('INVALID_RECORDING_FORMAT', (e as Error).message);
        }
        // Path safety: validate the generated file name resolves within project
        const fileName = generateRecordingFileName();
        resolveWithinRoot(projectPath, `recordings/${fileName}`);
        const escapedJson = gdEscape(eventsJson);
        const script = genRecordingSaveScript(fileName, escapedJson);
        const result = await executeGdscriptTrusted({
          godotPath: godot,
          projectPath,
          code: script,
          timeout: 30,
          loadAutoloads,
        });
        const errorMapper = (msg: string) => {
          if (msg.includes('not found') || msg.includes('File not found')) return ERROR_CODES.RECORDING_FILE_NOT_FOUND;
          if (msg.includes('Invalid JSON') || msg.includes('Invalid')) return ERROR_CODES.INVALID_RECORDING_FORMAT;
          return ERROR_CODES.SCRIPT_EXEC_FAILED;
        };
        return parseGdscriptResult(result, [], errorMapper);
      }
      case 'recording_load': {
        const rawName = args.file_name as string;
        if (!rawName || typeof rawName !== 'string') {
          return opsErrorResult('INVALID_FILE_NAME', 'file_name is required');
        }
        let safeName: string;
        try {
          safeName = sanitizeRecordingFileName(rawName);
        } catch (e) {
          return opsErrorResult('INVALID_FILE_NAME', (e as Error).message);
        }
        // Path safety: validate resolved path stays within project
        resolveWithinRoot(projectPath, `recordings/${safeName}`);
        const script = genRecordingLoadScript(safeName);
        const result = await executeGdscript({
          godotPath: godot,
          projectPath,
          code: script,
          timeout: 30,
          loadAutoloads,
        });
        const errorMapper = (msg: string) => {
          if (msg.includes('not found') || msg.includes('File not found')) return ERROR_CODES.RECORDING_FILE_NOT_FOUND;
          if (msg.includes('Invalid JSON') || msg.includes('Invalid')) return ERROR_CODES.INVALID_RECORDING_FORMAT;
          return ERROR_CODES.SCRIPT_EXEC_FAILED;
        };
        return parseGdscriptResult(result, [], errorMapper);
      }
      case 'recording_play': {
        const eventsJson = args.events_json as string;
        if (!eventsJson || typeof eventsJson !== 'string') {
          return opsErrorResult('INVALID_RECORDING_FORMAT', 'events_json must be a non-empty JSON string');
        }
        try {
          validateEventsJson(eventsJson);
        } catch (e) {
          return opsErrorResult('INVALID_RECORDING_FORMAT', (e as Error).message);
        }
        if (!loadAutoloads) {
          return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, 'recording_play requires Game Bridge (load_autoloads=true). Input injection is not available in headless mode.', {
            suggestion: 'Recording playback requires an active game bridge. Run game_bridge_install first, then start the game with run_project or F5.',
          });
        }
        const speed = typeof args.speed === 'number' && args.speed > 0 ? args.speed : 1.0;
        const escapedJson = gdEscape(eventsJson);
        const script = genRecordingPlayScript(escapedJson, speed);
        const result = await executeGdscript({
          godotPath: godot,
          projectPath,
          code: script,
          timeout: 30,
          loadAutoloads,
        });
        const errorMapper = (msg: string) => {
          if (msg.includes('not found') || msg.includes('File not found')) return ERROR_CODES.RECORDING_FILE_NOT_FOUND;
          if (msg.includes('Invalid JSON') || msg.includes('Invalid')) return ERROR_CODES.INVALID_RECORDING_FORMAT;
          return ERROR_CODES.SCRIPT_EXEC_FAILED;
        };
        return parseGdscriptResult(result, [], errorMapper);
      }
      default:
        return null;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('INVALID_FILE_NAME')) return opsErrorResult('INVALID_FILE_NAME', msg);
    if (msg.includes('traversal')) return opsErrorResult('INVALID_FILE_NAME', msg);
    if (msg.includes('ECONNREFUSED')) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, 'Cannot connect to MCP Bridge. Is the game running with the bridge autoload installed?', {
        suggestion: 'Ensure: 1) game_bridge_install has been called, 2) the game is running (F5 or run_project), 3) check project .godot/ for mcp_bridge_9081.secret.',
      });
    }
    if (msg.includes('Bridge secret not found')) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, 'Cannot connect to MCP Bridge. Is the game running with the bridge autoload installed?', {
        suggestion: 'Ensure: 1) game_bridge_install has been called, 2) the game is running (F5 or run_project), 3) check project .godot/ for mcp_bridge_9081.secret.',
      });
    }
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  recording: { readonly: false, long_running: false },
};
