import { createConnection, Socket } from 'net';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, chmodSync, statSync, lstatSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { requireProjectPath } from '../helpers.js';

const BRIDGE_PORT = 9081;
const BRIDGE_HOST = 'localhost';
const BRIDGE_SCRIPT_NAME = 'mcp_bridge.gd';
const AUTOLOAD_KEY = 'autoload/MCPBridge';
const DEFAULT_TIMEOUT = 10000;

// ─── TCP client for Bridge communication ────────────────────────────────────

export interface BridgeResponse {
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

let _nextRequestId = 1;
let _permWarned = false;
let _cachedSecret: string | null = null;
let _projectDir: string | null = null;
let _cachedSecretPath: string | null = null;
let _cachedSecretAt: number = 0;
// A-06: 5-minute TTL balances file I/O overhead vs attack window exposure.
// Shorter TTL increases fs reads; longer TTL extends the window if secret is compromised.
// For local-only TCP (127.0.0.1), this is an acceptable tradeoff.
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Persistent connection state
let _socket: Socket | null = null;
let _socketAuthenticated = false;
let _socketBuffer = '';
let _connectionLock: Promise<Socket> | null = null;

// Request serialization: ensures only one sendToBridge uses the socket at a time.
// Without this, concurrent calls register overlapping 'data' handlers on the shared
// socket, causing each handler to see partial/mixed response data.
let _sendLock: Promise<unknown> = Promise.resolve();

/** Find the bridge secret file — prefer project .godot dir, fallback to tmpdir. */
function findBridgeSecretPath(): string {
  if (_cachedSecretPath) return _cachedSecretPath;
  // Prefer project-local path (more secure than tmpdir)
  if (_projectDir) {
    _cachedSecretPath = join(_projectDir, '.godot', `mcp_bridge_${BRIDGE_PORT}.secret`);
    return _cachedSecretPath;
  }
  // Fallback to tmpdir (legacy behavior)
  _cachedSecretPath = join(tmpdir(), `mcp_bridge_${BRIDGE_PORT}.secret`);
  return _cachedSecretPath;
}

function readBridgeSecret(): string | null {
  if (_cachedSecret !== null && Date.now() - _cachedSecretAt < SECRET_CACHE_TTL) return _cachedSecret;
  _cachedSecret = null;
  const secretPath = findBridgeSecretPath();
  try {
    // Tighten permissions: owner-only read
    if (process.platform === 'win32') {
      try {
        const username = process.env.USERNAME;
        if (username && /^[A-Za-z0-9_\-\\]+$/.test(username)) {
          execFileSync('icacls', [secretPath, '/inheritance:r', '/grant:r', `${username}:R`], { stdio: 'ignore' });
        }
      } catch (err) { console.debug('[bridge] restrict Windows file permissions:', err); }
    } else {
      try {
        chmodSync(secretPath, 0o600);
      } catch (err) { console.debug('[bridge] chmod secret file:', err); }
    }
    const lstat = lstatSync(secretPath);
    if (lstat.isSymbolicLink()) {
      console.error(`[SECURITY] Bridge secret file ${secretPath} is a symlink — refusing to read.`);
      return null;
    }
    const stat = statSync(secretPath);
    if (!_permWarned && process.platform !== 'win32' && (stat.mode & 0o007) !== 0) {
      _permWarned = true;
      console.error(`[SECURITY] Bridge secret file ${secretPath} is world-readable. Attempted chmod 0600.`);
    }
    _cachedSecret = readFileSync(secretPath, 'utf-8').trim();
    _cachedSecretAt = Date.now();
    return _cachedSecret;
  } catch (err) {
    console.warn('[bridge] read bridge secret failed (%s): %s', (err as Error).message, secretPath);
    return null;
  }
}

function _invalidateSocket(): void {
  if (_socket) {
    try { _socket.destroy(); } catch (err) { console.debug('[bridge] destroy socket:', err); }
    _socket = null;
  }
  _socketAuthenticated = false;
  _socketBuffer = '';
}

/** Perform the actual TCP connection and auth handshake. */
async function _doConnect(timeout: number): Promise<Socket> {
  _invalidateSocket();

  const secret = readBridgeSecret();
  if (!secret) {
    throw new Error('Bridge secret not found. Ensure the game is running with the MCP Bridge autoload.');
  }

  return new Promise((resolve, reject) => {
    const sock = createConnection({ port: BRIDGE_PORT, host: BRIDGE_HOST }, () => {
      sock.write(JSON.stringify({ id: 0, method: 'auth', params: { secret } }) + '\n');
    });

    let authDone = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Bridge auth timed out after ${timeout}ms`));
    }, timeout);

    sock.on('data', (data: Buffer) => {
      _socketBuffer += data.toString();
      let idx: number;
      while ((idx = _socketBuffer.indexOf('\n')) !== -1) {
        const line = _socketBuffer.substring(0, idx).trim();
        _socketBuffer = _socketBuffer.substring(idx + 1);
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          if (!authDone && resp.result?.authenticated) {
            authDone = true;
            clearTimeout(timer);
            _socket = sock;
            _socketAuthenticated = true;
            // Detach per-auth handlers — response handling moves to sendToBridge
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            sock.removeAllListeners('close');
            // Register persistent monitors so a dead/lost connection is detected automatically
            sock.on('close', () => { _invalidateSocket(); });
            sock.on('error', () => { _invalidateSocket(); });
            resolve(sock);
            return;
          }
          // Auth failure response
          clearTimeout(timer);
          sock.destroy();
          if (resp.error?.code === -32001 || resp.error?.code === -32002) {
            _cachedSecret = null;
          }
          reject(new Error(`Bridge auth failed (${resp.error?.code}): ${resp.error?.message}`));
          return;
        } catch {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`Invalid JSON from bridge: ${line}`));
          return;
        }
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Bridge connection error: ${err.message}`));
    });

    sock.on('close', () => {
      clearTimeout(timer);
      if (!authDone) reject(new Error('Bridge connection closed during auth'));
    });
  });
}

/** Ensure we have an authenticated persistent connection, serializing concurrent attempts. */
function _ensureConnection(timeout: number): Promise<Socket> {
  if (_socket && _socketAuthenticated && !_socket.destroyed && _socket.writable) {
    return Promise.resolve(_socket);
  }
  if (_connectionLock) return _connectionLock;
  _connectionLock = _doConnect(timeout)
    .then(sock => {
      if (_socket !== sock || !_socketAuthenticated) {
        throw new Error('Connection invalidated during setup');
      }
      return sock;
    })
    .catch(err => {
      _connectionLock = null; // Clear lock before propagating so next call can retry
      throw err;
    })
    .finally(() => { _connectionLock = null; });
  return _connectionLock;
}

/** Set the project directory for bridge secret lookup. Invalidates all cached bridge state. */
export function setBridgeProjectDir(projectDir: string): void {
  if (_projectDir === projectDir) return;
  _projectDir = projectDir;
  _cachedSecretPath = null;
  _cachedSecret = null;
  _connectionLock = null;
  _invalidateSocket();
}

export function sendToBridge(method: string, params: Record<string, unknown> = {}, timeout = DEFAULT_TIMEOUT): Promise<BridgeResponse> {
  // Serialize requests so only one uses the shared socket at a time.
  // Each call chains onto _sendLock, preventing concurrent data handlers.
  const run = () => {
    // Fast-fail if socket is known dead — skip reconnection queue
    if (_socket && _socket.destroyed) {
      _invalidateSocket();
    }
    return _ensureConnection(timeout).then(sock => {
      return new Promise<BridgeResponse>((resolve, reject) => {
      const id = _nextRequestId++;
      let settled = false;
      let buffer = '';

      function doResolve(resp: BridgeResponse) { if (!settled) { settled = true; clearTimeout(timer); resolve(resp); } }
      function doReject(err: Error) { if (!settled) { settled = true; clearTimeout(timer); reject(err); } }

      const timer = setTimeout(() => {
        _invalidateSocket();
        doReject(new Error(`Bridge request timed out after ${timeout}ms`));
      }, timeout);

      const onData = (data: Buffer) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, idx).trim();
          buffer = buffer.substring(idx + 1);
          if (!line) continue;
          try {
            const resp = JSON.parse(line) as BridgeResponse;
            if (resp.id != null && resp.id !== id) continue;
            sock.removeListener('data', onData);
            // If bridge returns auth error, invalidate cached secret
            if (resp.error?.code === -32001 || resp.error?.code === -32002) {
              _cachedSecret = null;
              _invalidateSocket();
            }
            doResolve(resp);
            return;
          } catch {
            // Log unparseable lines instead of silently discarding (I-10)
            console.warn('[bridge] sendToBridge: unparseable JSON line (request %d): %s', id, line.substring(0, 120));
            continue;
          }
        }
      };

      const onError = (err: Error) => {
        _invalidateSocket();
        doReject(new Error(`Bridge connection error: ${err.message}`));
      };

      const onClose = () => {
        _invalidateSocket();
        doReject(new Error('Bridge connection closed before response'));
      };

      sock.on('data', onData);
      sock.once('error', onError);
      sock.once('close', onClose);

      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }).catch(err => {
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED')) {
      return Promise.reject(new Error('Cannot connect to MCP Bridge. Is the game running with the bridge autoload installed?'));
    }
    return Promise.reject(err);
  });
  };

  // Chain onto the send lock — next request waits for this one to settle
  const prev = _sendLock;
  let resolveLock: () => void = () => {};
  _sendLock = new Promise<void>(r => { resolveLock = r; });
  return prev.then(() => run()).finally(resolveLock);
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const ACTIONS = [
  'game_bridge_install',
  'game_bridge_uninstall',
  'game_query',
  'game_write',
  'game_input',
  'game_wait',
] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'game',
      description: '游戏桥接操作。安装/卸载: game_bridge_install, game_bridge_uninstall。查询: game_query (ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info, take_screenshot)。写入: game_write (set_node_property, call_method)。输入: game_input (send_key, send_mouse_click, send_mouse_move, send_text)。等待: game_wait (wait_for_node, wait_for_property)。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          port: { type: 'number', description: 'game_bridge_install: 桥接监听端口（当前忽略，始终 9081）', default: 9081 },
          method: {
            type: 'string',
            description: 'game_query/game_write/game_input/game_wait 的具体方法。game_query: ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info, take_screenshot。game_write: set_node_property, call_method。game_input: send_key, send_mouse_click, send_mouse_move, send_text。game_wait: wait_for_node, wait_for_property',
          },
          params: {
            type: 'object',
            description: '方法参数。game_query: 因方法而异。game_write: set_node_property {path, property, value}, call_method {path, method, args}。game_input: send_key {key, pressed}, send_mouse_click {x, y, button, pressed}, send_mouse_move {x, y}, send_text {text}。game_wait: wait_for_node {path}, wait_for_property {path, property, value}',
          },
          timeout: { type: 'number', description: 'game_query/game_write/game_input/game_wait: 超时时间（毫秒，默认 10000）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

const QUERY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties',
  'get_performance', 'get_viewport_info', 'take_screenshot',
]);

/** Read-only query methods excluding take_screenshot (handled separately via bridge.screenshot). */
export const BRIDGE_READ_ONLY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties',
  'get_performance', 'get_viewport_info',
]);

const WRITE_METHODS = new Set([
  'set_node_property', 'call_method',
]);

const INPUT_METHODS = new Set([
  'send_key', 'send_mouse_click', 'send_mouse_move', 'send_text',
]);

const WAIT_METHODS = new Set([
  'wait_for_node', 'wait_for_property',
]);

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'game') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    switch (action) {
      case 'game_bridge_install': {
        const projectPath = requireProjectPath(args);
        const port = (args.port as number) || 9081;
        const scriptsDir = dirname(ctx.opsScript);
        const bridgeSrc = join(scriptsDir, BRIDGE_SCRIPT_NAME);

        if (!existsSync(bridgeSrc)) {
          return textResult(`Error: Bridge script not found at ${bridgeSrc}`);
        }

        const destScript = join(projectPath, BRIDGE_SCRIPT_NAME);
        copyFileSync(bridgeSrc, destScript);

        const configPath = join(projectPath, 'project.godot');
        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        let config = readFileSync(configPath, 'utf-8');
        if (config.includes(AUTOLOAD_KEY)) {
          return textResult(`MCP Bridge autoload already registered. Script copied to ${destScript}.`);
        }

        const autoloadEntry = `${AUTOLOAD_KEY}="*res://${BRIDGE_SCRIPT_NAME}"`;
        const autoloadRegex = /^\[autoload\]/m;
        if (autoloadRegex.test(config)) {
          config = config.replace(autoloadRegex, `[autoload]\n${autoloadEntry}`);
        } else {
          config += `\n[autoload]\n${autoloadEntry}\n`;
        }

        // Atomic write: write to temp file then rename
        const tmpPath = configPath + '.mcp-tmp';
        writeFileSync(tmpPath, config, 'utf-8');
        renameSync(tmpPath, configPath);
        return textResult(JSON.stringify({
          success: true,
          message: `MCP Bridge installed. Autoload registered on port ${port}.`,
          script_path: `res://${BRIDGE_SCRIPT_NAME}`,
          autoload_key: AUTOLOAD_KEY,
        }));
      }

      case 'game_bridge_uninstall': {
        const projectPath = requireProjectPath(args);
        const configPath = join(projectPath, 'project.godot');

        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        const config = readFileSync(configPath, 'utf-8');
        if (!config.includes(AUTOLOAD_KEY)) {
          return textResult('MCP Bridge autoload not found in project.godot.');
        }

        const lines = config.split('\n').filter(line => !line.startsWith(AUTOLOAD_KEY + '='));
        const tmpPath = configPath + '.mcp-tmp';
        writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
        renameSync(tmpPath, configPath);

        const scriptPath = join(projectPath, BRIDGE_SCRIPT_NAME);
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }

        // A-07: Clean up secret file on uninstall
        const secretPath = join(projectPath, '.godot', `mcp_bridge_${BRIDGE_PORT}.secret`);
        if (existsSync(secretPath)) {
          try { unlinkSync(secretPath); } catch { /* best effort */ }
        }
        _cachedSecret = null;
        _cachedSecretPath = null;
        _invalidateSocket();

        return textResult(JSON.stringify({ success: true, message: 'MCP Bridge uninstalled.' }));
      }

      case 'game_query':
      case 'game_write':
      case 'game_input':
      case 'game_wait': {
        // Always update project dir so switching projects between calls works
        if (ctx.projectDir) {
          setBridgeProjectDir(ctx.projectDir);
        }
        const methodSets: Record<string, Set<string>> = {
          game_query: QUERY_METHODS,
          game_write: WRITE_METHODS,
          game_input: INPUT_METHODS,
          game_wait: WAIT_METHODS,
        };
        const allowed = methodSets[action];
        const method = args.method as string;
        if (!allowed.has(method)) {
          return textResult(`Error: Unknown method "${method}". Supported: ${[...allowed].join(', ')}`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        const rawTimeout = (args.timeout as number) || DEFAULT_TIMEOUT;
        const timeout = Math.min(rawTimeout, 60000);
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
          // Clear cached secret on auth failure so next call re-reads from disk
          // Bridge error codes: -32001 (auth required), -32002 (locked out)
          if (response.error.code === -32001 || response.error.code === -32002) {
            _cachedSecret = null;
          }
          return textResult(`Bridge error (${response.error.code}): ${response.error.message}`);
        }
        return textResult(JSON.stringify(response.result, null, 2));
      }

      default:
        return null;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED')) {
      return opsErrorResult('BRIDGE_NOT_CONNECTED', 'Cannot connect to MCP Bridge. Is the game running with the bridge autoload installed?', {
        suggestion: 'Ensure: 1) game_bridge_install has been called, 2) the game is running (F5 or run_project), 3) check project .godot/ for mcp_bridge_9081.secret.',
      });
    }
    return textResult(`Error: ${msg}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  game: { readonly: false, long_running: false },
};

/** Reset all module state — for test isolation and service restart. */
export function resetBridgeState(): void {
  _nextRequestId = 1;
  _permWarned = false;
  _cachedSecret = null;
  _projectDir = null;
  _cachedSecretPath = null;
  _cachedSecretAt = 0;
  // Note: active socket connections are NOT closed here — use _invalidateSocket() for that
  _socketAuthenticated = false;
  _socketBuffer = '';
  _connectionLock = null;
  _sendLock = Promise.resolve();
}
