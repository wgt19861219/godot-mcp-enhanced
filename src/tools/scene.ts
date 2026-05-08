import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot, parseMcpScriptOutput } from '../helpers.js';
import { parseTscn, parseTscnSummary } from '../tscn-parser.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult } from './shared.js';
import { normalizeNodePath, gdEscape } from './godot-ops.js';

const TOOL_NAMES = [
  'read_scene',
  'create_scene',
  'add_node',
  'save_scene',
  'load_sprite',
  'batch_add_nodes',
  'query_scene_tree',
  'inspect_node',
  'edit_node',
  'remove_node',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'read_scene',
      description: 'Parse a .tscn scene file and return the complete node tree as JSON.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Absolute path to the .tscn file' },
          summary_only: { type: 'boolean', description: 'Return human-readable summary instead of full JSON', default: false },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'create_scene',
      description: 'Create a new Godot scene with a root node.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project (res://scenes/new.tscn)' },
          root_node_type: { type: 'string', description: 'Root node type (default: Node2D)', default: 'Node2D' },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'add_node',
      description: 'Add a node to an existing scene.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_type: { type: 'string', description: 'Type of node to add (e.g. Sprite2D, Camera2D)' },
          node_name: { type: 'string', description: 'Name for the new node' },
          parent_node_path: { type: 'string', description: 'Parent node path (default: root)', default: 'root' },
          properties: { type: 'object', description: 'Optional properties to set on the node' },
        },
        required: ['project_path', 'scene_path', 'node_type', 'node_name'],
      },
    },
    {
      name: 'save_scene',
      description: 'Save/resave a scene file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          new_path: { type: 'string', description: 'Optional new path to save as' },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'load_sprite',
      description: 'Load a sprite texture into a Sprite2D node in a scene.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          texture_path: { type: 'string', description: 'Texture path relative to project (res://assets/player.png)' },
          node_path: { type: 'string', description: 'Sprite node path (default: root)', default: 'root' },
        },
        required: ['project_path', 'scene_path', 'texture_path'],
      },
    },
    {
      name: 'query_scene_tree',
      description: 'Load a scene in headless mode and query its runtime node tree with resolved property values. '
        + 'Unlike read_scene which parses the .tscn file, this instantiates the scene and returns actual runtime properties.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene file path relative to project (e.g. res://scenes/main.tscn)' },
          max_depth: { type: 'number', description: 'Maximum tree traversal depth (default: 5)', default: 5 },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'inspect_node',
      description: 'Deep-inspect a specific node in a scene. Returns all properties, signal connections, '
        + 'and child nodes with recursive depth control. Loads the scene in headless mode for runtime values.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene file path relative to project' },
          node_path: { type: 'string', description: 'Node path within scene (e.g. "root/Player/Sprite2D")', default: 'root' },
          max_depth: { type: 'number', description: 'Max depth for child traversal (default: 3)', default: 3 },
          include_signals: { type: 'boolean', description: 'Include signal connection info (default: true)', default: true },
          include_properties: { type: 'boolean', description: 'Include property values (default: true)', default: true },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'batch_add_nodes',
      description: 'Add multiple nodes to a scene in a single call. Much faster than calling add_node repeatedly. '
        + 'Accepts an array of node definitions, each with type, name, optional parent and properties.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          nodes: {
            type: 'array',
            description: 'Array of node definitions to add',
            items: {
              type: 'object',
              properties: {
                node_type: { type: 'string', description: 'Node type (e.g. Sprite2D, Label)' },
                node_name: { type: 'string', description: 'Name for the node' },
                parent_node_path: { type: 'string', description: 'Parent path (default: root)', default: 'root' },
                properties: { type: 'object', description: 'Optional properties to set' },
              },
              required: ['node_type', 'node_name'],
            },
          },
        },
        required: ['project_path', 'scene_path', 'nodes'],
      },
    },
    {
      name: 'edit_node',
      description: 'Edit properties of an existing node in a scene. Supports position, scale, rotation, and custom properties.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Node path within scene (e.g. "root/Player/Sprite2D")' },
          properties: { type: 'object', description: 'Properties to set. Supports basic types and Vector2/Vector3 as arrays.' },
          load_autoloads: { type: 'boolean', description: 'Load Autoload context (default: true)', default: true },
        },
        required: ['project_path', 'scene_path', 'node_path', 'properties'],
      },
    },
    {
      name: 'remove_node',
      description: 'Remove a node from a scene. This is a destructive operation protected by confirmation token.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Node path to remove (e.g. "root/Player/Sprite2D")' },
          load_autoloads: { type: 'boolean', description: 'Load Autoload context (default: true)', default: true },
        },
        required: ['project_path', 'scene_path', 'node_path'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'read_scene': {
      const sp = resolveWithinRoot(validatePath(args.project_path as string), args.scene_path as string);
      if (!existsSync(sp)) return textResult(`Scene file not found: ${sp}`);

      const content = readFileSync(sp, 'utf-8');
      if (args.summary_only) {
        return textResult(parseTscnSummary(content));
      }

      const parsed = parseTscn(content);
      const roots = parsed.nodes.filter(n => !n.parent);
      const result = {
        header: parsed.header,
        extResources: parsed.extResources,
        subResources: parsed.subResources,
        nodeTree: roots,
        connections: parsed.connections,
        totalNodes: parsed.nodes.length,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'create_scene':
    case 'add_node':
    case 'save_scene':
    case 'load_sprite': {
      const p = validatePath(args.project_path as string);
      const godot = await ctx.findGodot();

      const params: Record<string, unknown> = {};
      if (name === 'create_scene') {
        params.scene_path = args.scene_path;
        params.root_node_type = args.root_node_type || 'Node2D';
      } else if (name === 'add_node') {
        params.scene_path = args.scene_path;
        params.node_type = args.node_type;
        params.node_name = args.node_name;
        params.parent_node_path = args.parent_node_path || 'root';
        if (args.properties) params.properties = args.properties;
      } else if (name === 'save_scene') {
        params.scene_path = args.scene_path;
        if (args.new_path) params.new_path = args.new_path;
      } else if (name === 'load_sprite') {
        params.scene_path = args.scene_path;
        params.texture_path = args.texture_path;
        params.node_path = args.node_path || 'root';
      }

      return new Promise((resolve) => {
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', ctx.opsScript,
          name, JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        proc.on('close', (code) => {
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `${name} failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `${name} completed successfully.` }] });
          }
        });

        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve({ content: [{ type: 'text', text: `${name} timed out.` }] });
          }
        }, 60000);
      });
    }

    case 'query_scene_tree': {
      const p = validatePath(args.project_path as string);
      const godot = await ctx.findGodot();
      const scriptsDir = dirname(ctx.opsScript);
      const treeScript = join(scriptsDir, 'query_scene_tree.gd');

      if (!existsSync(treeScript)) {
        return textResult(`Error: query_scene_tree.gd not found at ${treeScript}`);
      }

      const params = {
        scene_path: args.scene_path,
        max_depth: (args.max_depth as number) || 5,
      };

      return new Promise((resolve) => {
        let out = '';
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', treeScript,
          JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        const timer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve(textResult('query_scene_tree timed out after 60s'));
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          const result = parseMcpScriptOutput(out, code);
          resolve(textResult(JSON.stringify(result, null, 2)));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve(textResult(`Error: ${err.message}`));
        });
      });
    }

    case 'inspect_node': {
      const p = validatePath(args.project_path as string);
      const godot = await ctx.findGodot();
      const scriptsDir = dirname(ctx.opsScript);
      const inspectScript = join(scriptsDir, 'inspect_node.gd');

      if (!existsSync(inspectScript)) {
        return textResult(`Error: inspect_node.gd not found at ${inspectScript}`);
      }

      const params = {
        scene_path: args.scene_path,
        node_path: args.node_path || 'root',
        max_depth: (args.max_depth as number) || 3,
        include_signals: args.include_signals !== false,
        include_properties: args.include_properties !== false,
      };

      return new Promise((resolve) => {
        let out = '';
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', inspectScript,
          JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        const timer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve(textResult('inspect_node timed out after 60s'));
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          const result = parseMcpScriptOutput(out, code);
          resolve(textResult(JSON.stringify(result, null, 2)));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve(textResult(`Error: ${err.message}`));
        });
      });
    }

    case 'batch_add_nodes': {
      const p = validatePath(args.project_path as string);
      const scenePath = args.scene_path as string;
      const nodes = args.nodes as Array<{
        node_type: string;
        node_name: string;
        parent_node_path?: string;
        properties?: Record<string, unknown>;
      }>;

      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
        return textResult('Error: "nodes" must be a non-empty array of node definitions.');
      }

      const godot = await ctx.findGodot();

      return new Promise((resolve) => {
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', ctx.opsScript,
          'batch_add_nodes', JSON.stringify({
            scene_path: scenePath,
            nodes: nodes,
          }),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        proc.on('close', (code) => {
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `batch_add_nodes failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] });
          }
        });

        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve({ content: [{ type: 'text', text: 'batch_add_nodes timed out after 60s.' }] });
          }
        }, 60000);
      });
    }

    case 'edit_node': {
      const p = validatePath(args.project_path as string);
      const nodePath = normalizeNodePath(args.node_path as string);
      const properties = args.properties as Record<string, unknown>;
      if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
        return textResult('Error: "properties" must be a non-empty object.');
      }

      // Build GDScript property setter lines
      let propLines = '';
      for (const [key, value] of Object.entries(properties)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          return textResult(`Error: Invalid property name: "${key}"`);
        }
        propLines += `\n\t${gdScriptSetLine(key, value)}`;
      }

      const script = `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn${propLines}
\t_mcp_output("edited", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
      const godot = await ctx.findGodot();
      const loadAutoloads = args.load_autoloads !== false;
      const result = await executeGdscript({
        godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads,
      });
      return parseGdscriptResult(result, [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED');
    }

    case 'remove_node': {
      const p = validatePath(args.project_path as string);
      const nodePath = normalizeNodePath(args.node_path as string);

      const script = `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar parent = node.get_parent()
\tvar node_name = node.name
\tif parent:
\t\tvar child_owner = node.owner
\t\tremove_child(node)
\t\tnode.queue_free()
\t\t_mcp_output("removed", {"node": "${gdEscape(nodePath)}", "name": str(node_name)})
\telse:
\t\t_mcp_output("error", "Cannot remove root node")
\t_mcp_done()
`;
      const godot = await ctx.findGodot();
      const loadAutoloads = args.load_autoloads !== false;
      const result = await executeGdscript({
        godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads,
      });
      return parseGdscriptResult(result, [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED');
    }

    default:
      return null;
  }
}

function gdScriptSetLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `node.${key} = null`;
  if (typeof value === 'boolean') return `node.${key} = ${value}`;
  if (typeof value === 'number') return `node.${key} = ${value}`;
  if (typeof value === 'string') return `node.${key} = "${gdEscape(value)}"`;
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      return `node.${key} = Vector2(${value[0]}, ${value[1]})`;
    }
    if (value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'number' && typeof value[2] === 'number') {
      return `node.${key} = Vector3(${value[0]}, ${value[1]}, ${value[2]})`;
    }
    if (value.length === 4 && value.every(v => typeof v === 'number')) {
      return `node.${key} = Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]})`;
    }
  }
  throw new Error(`Property "${key}" has unsupported type. Use string/number/bool/null, or array of 2 (Vector2), 3 (Vector3), or 4 (Color) numbers.`);
}
