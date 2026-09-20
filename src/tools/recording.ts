import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
import { resolveWithinRoot } from '../core/path-utils.js';
import { executeGdscriptTrusted } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, escapeForGdLiteral } from './shared.js';
import { sendToBridge, setBridgeProjectDir, BridgeNotConnectedError, BridgeTimeoutError } from './game-bridge.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  BRIDGE_NOT_CONNECTED: 'BRIDGE_NOT_CONNECTED',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
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

/**
 * touch_drag 事件字段契约(F2 双侧契约:三端字段名必须对齐,防 IMP-11 同类静默错)。
 * 对应:recording.test.js 用例 D / Task 4 双侧契约测试。
 * position 在 events 端是 [x,y],发 bridge 时拆成 x/y 字段。
 */
export const TOUCH_DRAG_FIELDS = ['position', 'index', 'relative', 'speed'] as const;

// ─── Keycode → Bridge key string mapping ────────────────────────────────────

// Reverse mapping of Godot keycodes to the key strings accepted by Bridge's _cmd_send_key.
// Based on mcp_bridge.gd _key_from_string mapping.
const KEYCODE_TO_STRING: Record<number, string> = {
  4: 'a', 5: 'b', 6: 'c', 7: 'd', 8: 'e', 9: 'f', 10: 'g', 11: 'h', 12: 'i',
  13: 'j', 14: 'k', 15: 'l', 16: 'm', 17: 'n', 18: 'o', 19: 'p', 20: 'q',
  21: 'r', 22: 's', 23: 't', 24: 'u', 25: 'v', 26: 'w', 27: 'x', 28: 'y', 29: 'z',
  30: '0', 31: '1', 32: '2', 33: '3', 34: '4', 35: '5', 36: '6', 37: '7', 38: '8', 39: '9',
  41: 'escape', 42: 'tab', 44: 'enter', 45: 'space',
  46: 'up', 47: 'down', 48: 'left', 49: 'right',
  50: 'shift', 51: 'ctrl', 52: 'alt',
};

function keycodeToBridgeKey(keycode: number): string | null {
  return KEYCODE_TO_STRING[keycode] ?? null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function sanitizeRecordingFileName(name: string): string {
  if (name.includes('/') || name.includes('\\') || name.split(/[/\\]/).includes('..')) {
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

export function validateEventsJson(eventsJson: string): { version: number; duration_ms: number; events: unknown[] } {
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
  // CRITICAL-2: 事件总数上限防 DoS(百万级 events_json 致 GDScript 编辑器 OOM / TS 逐事件 sendToBridge 挂死)
  if (obj.events.length > MAX_RECORDING_EVENTS) {
    throw new Error(`INVALID_RECORDING_FORMAT: events array exceeds ${MAX_RECORDING_EVENTS} entries (got ${obj.events.length}) — potential DoS`);
  }
  return obj as { version: number; duration_ms: number; events: unknown[] };
}

// CRITICAL-2 (R2): 录制事件总数上限,防恶意/失控客户端传百万级 events_json 致 GDScript 编辑器 OOM
// 或 TS 端逐事件 sendToBridge 长时间挂死(1 万事件 × 10s delay = 28h)。与 GDScript MAX_PLAYBACK_EVENTS 对齐。
export const MAX_RECORDING_EVENTS = 10000;

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

// ─── Tool Definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] recording module is absorbed into runtime. Do not register directly.`);
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
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          events_json: { type: 'string', description: 'JSON 格式的事件序列字符串' },
          file_name: { type: 'string', description: '录制文件名（仅接受 recording_*.json 格式）' },
          speed: { type: 'number', description: '回放速度倍率（默认 1.0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
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
  if (name !== 'recording') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

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
        // T2c (debt-cleanup-20260818): events_json 消费点是 genRecordingSaveScript 里
        // JSON.parse_string("...") 的字面量实参(纯值,不参与 % 格式化);validateEventsJson
        // 只校验 version/events 结构,事件对象附加字段原样透传——gdEscape 双写含 % 的值
        // 会破坏落盘内容与用户输入的 round-trip。
        const escapedJson = escapeForGdLiteral(eventsJson);
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
      case 'recording_play': {
        const eventsJson = args.events_json as string;
        if (!eventsJson || typeof eventsJson !== 'string') {
          return opsErrorResult('INVALID_RECORDING_FORMAT', 'events_json must be a non-empty JSON string');
        }
        let validated: ReturnType<typeof validateEventsJson>;
        try {
          validated = validateEventsJson(eventsJson);
        } catch (e) {
          return opsErrorResult('INVALID_RECORDING_FORMAT', (e as Error).message);
        }
        if (!loadAutoloads) {
          return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, 'recording_play requires Game Bridge (load_autoloads=true). Input injection is not available in headless mode.', {
            suggestion: 'Recording playback requires an active game bridge. Run game_bridge_install first, then start the game with run_project or F5.',
          });
        }
        if (ctx.projectDir) {
          setBridgeProjectDir(ctx.projectDir);
        }
        const speed = typeof args.speed === 'number' && args.speed > 0 ? args.speed : 1.0;
        const events = validated.events as Array<Record<string, unknown>>;
        if (events.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', events_played: 0, message: 'No events to play' }) }], isError: false };
        }
        // Play events through Bridge one-by-one with proper timing
        let played = 0;
        const errors: string[] = [];
        let lastTime = 0;
        for (const evt of events) {
          if (!evt) continue;
          const evtType = String(evt.type ?? '');
          // Wait for inter-event delay
          const currentTime = Number(evt.time_offset ?? evt.time_ms ?? evt.timestamp_ms ?? 0);
          if (lastTime > 0) {
            const delayMs = Math.max(0, (currentTime - lastTime) / speed);
            const clampedDelay = Math.min(Math.max(delayMs, 16), 10000);
            await new Promise(resolve => setTimeout(resolve, clampedDelay));
          }
          lastTime = currentTime;
          try {
            if (evtType === 'key') {
              const keycode = Number(evt.keycode ?? 0);
              const keyStr = keycodeToBridgeKey(keycode);
              if (!keyStr) {
                errors.push(`Event ${played}: unsupported keycode ${keycode}`);
                continue;
              }
              await sendToBridge('send_key', {
                key: keyStr,
                pressed: Boolean(evt.pressed ?? true),
              }, 3000);
              played++;
            } else if (evtType === 'mouse_click') {
              const pos = evt.position ?? evt.pos ?? [0, 0];
              const posArr = Array.isArray(pos) ? pos : [0, 0];
              await sendToBridge('send_mouse_click', {
                x: Number(posArr[0] ?? 0),
                y: Number(posArr[1] ?? 0),
                button: Number(evt.button ?? 1),
                pressed: Boolean(evt.pressed ?? true),
              }, 3000);
              played++;
            } else if (evtType === 'mouse_move') {
              const pos = evt.position ?? evt.pos ?? [0, 0];
              const posArr = Array.isArray(pos) ? pos : [0, 0];
              await sendToBridge('send_mouse_move', {
                x: Number(posArr[0] ?? 0),
                y: Number(posArr[1] ?? 0),
                // 审查 Minor-11: 回放透传 button_mask(录制侧已补记)——「按住拖动」的 motion
                // 保留按键态;旧录制无此字段回退 0(不带按键),与旧行为一致。
                button_mask: Number((evt as Record<string, unknown>).button_mask ?? 0),
              }, 3000);
              played++;
            } else if (evtType === 'touch') {
              // 阶段2b IMP-11: touch 回放——对齐 GDScript recording_commands.gd :197 + bridge _cmd_send_touch 契约
              // (position/pressed/index)。此前 touch 事件被 silently skipped(TS 侧半修复 gap)。
              const pos = evt.position ?? evt.pos ?? [0, 0];
              const posArr = Array.isArray(pos) ? pos : [0, 0];
              await sendToBridge('send_touch', {
                x: Number(posArr[0] ?? 0),
                y: Number(posArr[1] ?? 0),
                pressed: Boolean(evt.pressed ?? true),
                index: Number(evt.index ?? 0),
              }, 3000);
              played++;
            } else if (evtType === 'touch_drag') {
              // Task 3 (IMP-11 同类补全): touch_drag 回放——对齐 bridge _cmd_send_drag 契约
              // (position→x/y, index, relative, speed)。FIELDS 双侧契约见 TOUCH_DRAG_FIELDS。
              const pos = evt.position ?? evt.pos ?? [0, 0];
              const posArr = Array.isArray(pos) ? pos : [0, 0];
              const rel = evt.relative ?? [0, 0];
              const relArr = Array.isArray(rel) ? rel : [0, 0];
              const spd = evt.speed ?? [0, 0];
              const spdArr = Array.isArray(spd) ? spd : [0, 0];
              await sendToBridge('send_drag', {
                x: Number(posArr[0] ?? 0),
                y: Number(posArr[1] ?? 0),
                index: Number(evt.index ?? 0),
                relative: [Number(relArr[0] ?? 0), Number(relArr[1] ?? 0)],
                speed: [Number(spdArr[0] ?? 0), Number(spdArr[1] ?? 0)],
              }, 3000);
              played++;
            } else {
              // F3: unknown event type 计入 errors(此前 silently skip 降低可观测性,见 Task 3)
              errors.push(`Unknown event type: ${evtType}`);
            }
          } catch (e) {
            errors.push(`Event ${played} (${evtType}): ${(e as Error).message}`);
          }
        }
        const result: Record<string, unknown> = {
          status: errors.length > 0 && played === 0 ? 'error' : 'ok',
          events_played: played,
          total_events: events.length,
        };
        if (errors.length > 0) {
          result.errors = errors;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: played === 0 };
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('INVALID_FILE_NAME')) return opsErrorResult('INVALID_FILE_NAME', msg);
    if (msg.includes('traversal')) return opsErrorResult('INVALID_FILE_NAME', msg);
    // A-4: 对接 game-bridge Bridge 子类(instanceof,非字符串匹配)。游戏未运行/bridge 没正常工作 → NOT_CONNECTED;
    // 连上但卡住 → TIMEOUT;真正 GDScript 执行错误才 SCRIPT_EXEC_FAILED。
    if (err instanceof BridgeNotConnectedError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, msg, {
        suggestion: '录制/回放需要 Game Bridge 连接。Ensure: 1) game_bridge_install 已调用, 2) 游戏正在运行(F5 或 run_project), 3) 检查 .godot/ 下的 mcp_bridge_*.secret(端口被占自动避让,非固定 9081)。',
      });
    }
    if (err instanceof BridgeTimeoutError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_TIMEOUT, msg, {
        suggestion: '游戏在运行但无响应(可能被 runtime error 卡住)——这不是连接问题。检查游戏是否报错,或加大 timeout 重试。',
      });
    }
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  recording: { readonly: false, long_running: false },
};

// ─── Exported handler for runtime module merge (v0.18.0) ────────────────────

/** action 名映射：目标模块使用 record_* 前缀 → 内部 recording_* */
const RECORDING_ACTION_MAP: Record<string, string> = {
  'record_start': 'recording_start',
  'record_stop': 'recording_stop',
  'record_save': 'recording_save',
  'record_load': 'recording_load',
  'record_play': 'recording_play',
};

/** 供 runtime 模块合并调用（v0.18.0 action 路由统一） */
export async function handleRecordingAction(
  action: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  const mappedAction = RECORDING_ACTION_MAP[action] ?? action;
  // 如果不在映射表内也不是原生 recording_* action，返回 null
  if (!(ACTIONS as readonly string[]).includes(mappedAction)) return null;
  // 复用现有 handleTool，将 action 映射回内部格式
  const patchedArgs = { ...args, action: mappedAction };
  return handleTool('recording', patchedArgs, ctx);
}
