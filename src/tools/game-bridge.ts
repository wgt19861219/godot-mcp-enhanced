import { createConnection } from 'net';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath } from '../helpers.js';

const BRIDGE_PORT = 9081;
const BRIDGE_HOST = 'localhost';
const BRIDGE_SCRIPT_NAME = 'mcp_bridge.gd';
const AUTOLOAD_KEY = 'autoload/MCPBridge';
const DEFAULT_TIMEOUT = 10000;

// ─── TCP client for Bridge communication ────────────────────────────────────

interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let _bridgeSecret: string | null = null;

function sendToBridge(method: string, params: Record<string, unknown> = {}, timeout = DEFAULT_TIMEOUT): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const message = JSON.stringify({ id, method, params }) + '\n';

    const socket = createConnection({ port: BRIDGE_PORT, host: BRIDGE_HOST }, () => {
      // C1: Send auth handshake if we have a secret
      if (_bridgeSecret) {
        socket.write(JSON.stringify({ id: 0, method: 'auth', secret: _bridgeSecret }) + '\n');
      }
      socket.write(message);
    });

    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Bridge request timed out after ${timeout}ms`));
    }, timeout);

    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      // Process all complete lines
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, idx).trim();
        buffer = buffer.substring(idx + 1);
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          // Skip auth response
          if (resp.id === 0 && resp.result?.authenticated) continue;
          clearTimeout(timer);
          socket.destroy();
          resolve(resp);
          return;
        } catch {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`Invalid JSON from bridge: ${line}`));
          return;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Bridge connection error: ${err.message}`));
    });

    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('Bridge connection closed before response'));
    });
  });
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'game_bridge_install',
      description: 'Install the MCP Bridge autoload into a Godot project. Copies the bridge script and registers it in project.godot.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          port: { type: 'number', description: 'Port for bridge to listen on (default: 9081)', default: 9081 },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'game_bridge_uninstall',
      description: 'Remove the MCP Bridge autoload from a Godot project.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'game_query',
      description: 'Query the running game state via MCP Bridge. Supports: ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            description: 'Query method: ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info',
          },
          params: { type: 'object', description: 'Method parameters (varies by method)' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: ['method'],
      },
    },
    {
      name: 'game_input',
      description: 'Send input events to the running game via MCP Bridge. Supports: send_key, send_mouse_click, send_mouse_move, send_text.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            description: 'Input method: send_key, send_mouse_click, send_mouse_move, send_text',
          },
          params: {
            type: 'object',
            description: 'Input parameters. send_key: {key, pressed}. send_mouse_click: {x, y, button, pressed}. send_mouse_move: {x, y}. send_text: {text}.',
          },
          timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: ['method', 'params'],
      },
    },
    {
      name: 'game_wait',
      description: 'Check a condition in the running game via MCP Bridge. Supports: wait_for_node, wait_for_property.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            description: 'Wait method: wait_for_node, wait_for_property',
          },
          params: {
            type: 'object',
            description: 'Wait parameters. wait_for_node: {path}. wait_for_property: {path, property, value}.',
          },
          timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        },
        required: ['method', 'params'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = [
  'game_bridge_install',
  'game_bridge_uninstall',
  'game_query',
  'game_input',
  'game_wait',
] as const;

const QUERY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties',
  'get_performance', 'get_viewport_info', 'set_node_property',
  'call_method', 'take_screenshot',
]);

const INPUT_METHODS = new Set([
  'send_key', 'send_mouse_click', 'send_mouse_move', 'send_text',
]);

const WAIT_METHODS = new Set([
  'wait_for_node', 'wait_for_property',
]);

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    switch (name) {
      case 'game_bridge_install': {
        const projectPath = validatePath(args.project_path as string);
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

        writeFileSync(configPath, config, 'utf-8');
        return textResult(JSON.stringify({
          success: true,
          message: `MCP Bridge installed. Autoload registered on port ${port}.`,
          script_path: `res://${BRIDGE_SCRIPT_NAME}`,
          autoload_key: AUTOLOAD_KEY,
        }));
      }

      case 'game_bridge_uninstall': {
        const projectPath = validatePath(args.project_path as string);
        const configPath = join(projectPath, 'project.godot');

        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        let config = readFileSync(configPath, 'utf-8');
        if (!config.includes(AUTOLOAD_KEY)) {
          return textResult('MCP Bridge autoload not found in project.godot.');
        }

        const lines = config.split('\n').filter(line => !line.startsWith(AUTOLOAD_KEY + '='));
        writeFileSync(configPath, lines.join('\n'), 'utf-8');

        const scriptPath = join(projectPath, BRIDGE_SCRIPT_NAME);
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
        }

        return textResult(JSON.stringify({ success: true, message: 'MCP Bridge uninstalled.' }));
      }

      case 'game_query':
      case 'game_input':
      case 'game_wait': {
        const methodSets: Record<string, Set<string>> = {
          game_query: QUERY_METHODS,
          game_input: INPUT_METHODS,
          game_wait: WAIT_METHODS,
        };
        const allowed = methodSets[name];
        const method = args.method as string;
        if (!allowed.has(method)) {
          return textResult(`Error: Unknown method "${method}". Supported: ${[...allowed].join(', ')}`);
        }
        const params = (args.params as Record<string, unknown>) || {};
        const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
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
      return textResult('Error: Cannot connect to MCP Bridge. Is the game running with the bridge autoload installed?');
    }
    return textResult(`Error: ${msg}`);
  }
}
