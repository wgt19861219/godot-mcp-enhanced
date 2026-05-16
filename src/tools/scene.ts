import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot, normalizeUserProjectPath, ensureDir, parseMcpScriptOutput } from '../helpers.js';
import { parseTscn, parseTscnSummary } from '../tscn-parser.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult } from './shared.js';
import { normalizeNodePath, gdEscape } from './shared.js';

const TOOL_NAMES = [
  'read_scene',
  'create_scene',
  'add_node',
  'save_scene',
  'load_sprite',
  'quick_scene',
  'batch_add_nodes',
  'query_scene_tree',
  'inspect_node',
  'edit_node',
  'remove_node',
  'instance_scene',
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
      name: 'quick_scene',
      description: 'Create a complete scene with optional script attachment in one step. '
        + 'Generates .tscn with root node, ext_resource reference, and optionally creates the .gd script file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene path relative to project (e.g. res://scenes/player.tscn)' },
          script_path: { type: 'string', description: 'Script path relative to project (e.g. res://scripts/player.gd). Optional.' },
          root_node_type: { type: 'string', description: 'Root node type (default: Node2D)', default: 'Node2D' },
          root_node_name: { type: 'string', description: 'Root node name (default: derived from scene filename via PascalCase)' },
          script_content: { type: 'string', description: 'If provided and script does not exist, creates the .gd file with this content' },
        },
        required: ['project_path', 'scene_path'],
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
    {
      name: 'instance_scene',
      description: 'Instantiate a .tscn scene file as a child node in a target scene via headless GDScript execution. '
        + 'The instanced scene is added at runtime and is not persisted — edit the .tscn file to persist.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Target scene path relative to project' },
          instance_path: { type: 'string', description: 'Scene file to instantiate (res://scenes/player.tscn)' },
          parent_node_path: { type: 'string', description: 'Parent node path (default: root)', default: 'root' },
          node_name: { type: 'string', description: 'Optional instance node name' },
          properties: { type: 'object', description: 'Optional initial property overrides' },
        },
        required: ['project_path', 'scene_path', 'instance_path'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'read_scene': {
      const sp = resolveWithinRoot(validatePath(args.project_path as string), normalizeUserProjectPath(args.scene_path as string));
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
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        params.root_node_type = args.root_node_type || 'Node2D';
      } else if (name === 'add_node') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        params.node_type = args.node_type;
        params.node_name = args.node_name;
        params.parent_node_path = args.parent_node_path || 'root';
        if (args.properties) params.properties = args.properties;
      } else if (name === 'save_scene') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        if (args.new_path) {
          const np = String(args.new_path);
          if (np.includes('/../') || np.includes('/..') || np.includes('\\')) {
            return opsErrorResult('INVALID_PATH', 'new_path contains path traversal');
          }
          params.new_path = np;
        }
      } else if (name === 'load_sprite') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        const tp = String(args.texture_path);
        if (tp.includes('/../') || tp.includes('/..') || tp.includes('\\')) {
          return opsErrorResult('INVALID_PATH', 'texture_path contains path traversal');
        }
        params.texture_path = tp;
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

        const timer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve({ content: [{ type: 'text', text: `${name} timed out.` }] });
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `${name} failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `${name} completed successfully.` }] });
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'quick_scene': {
      const p = validatePath(args.project_path as string);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;

      // 输入验证: 防止 .tscn 模板注入
      const safeId = /^[A-Za-z0-9_]+$/;
      if (!safeId.test(rootNodeType)) {
        return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
      }

      // 推导根节点名: PascalCase (tween_demo -> TweenDemo)
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) {
        const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, '');
        rootNodeName = baseName ? baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Root';
      }
      if (!safeId.test(rootNodeName)) {
        return textResult(`Error: root_node_name contains invalid characters: "${rootNodeName}"`);
      }

      const sceneAbsPath = resolveWithinRoot(p, sceneRelPath);

      // 覆写保护
      if (existsSync(sceneAbsPath)) {
        return textResult(`Error: Scene already exists: ${sceneRelPath}. Remove it first or use a different path.`);
      }

      // 生成 .tscn 内容
      let tscnContent: string;
      if (scriptRelPath) {
        tscnContent = [
          '[gd_scene load_steps=2 format=3]',
          '',
          `[ext_resource type="Script" path="res://${scriptRelPath.replace(/\\/g, '/')}" id="1"]`,
          '',
          `[node name="${rootNodeName}" type="${rootNodeType}"]`,
          'script = ExtResource("1")',
          '',
        ].join('\n');
      } else {
        tscnContent = [
          '[gd_scene format=3]',
          '',
          `[node name="${rootNodeName}" type="${rootNodeType}"]`,
          '',
        ].join('\n');
      }

      try {
        ensureDir(sceneAbsPath);
        writeFileSync(sceneAbsPath, tscnContent, 'utf-8');
      } catch (e: unknown) {
        return textResult(`Error writing scene: ${(e as Error).message}`);
      }

      // 如果提供 script_content 且脚本不存在，创建脚本文件
      if (scriptRelPath && scriptContent) {
        const scriptAbsPath = resolveWithinRoot(p, scriptRelPath);
        if (!existsSync(scriptAbsPath)) {
          try {
            ensureDir(scriptAbsPath);
            writeFileSync(scriptAbsPath, scriptContent, 'utf-8');
          } catch (e: unknown) {
            return textResult(`Scene created but script write failed: ${(e as Error).message}`);
          }
        }
      }

      const parts = [`Created scene: ${sceneRelPath}`];
      parts.push(`Root: ${rootNodeName} [${rootNodeType}]`);
      if (scriptRelPath) parts.push(`Script: res://${scriptRelPath.replace(/\\/g, '/')}`);
      if (scriptRelPath && scriptContent) parts.push(`Script file created`);

      return textResult(parts.join('\n'));
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
        scene_path: normalizeUserProjectPath(args.scene_path as string),
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
        scene_path: normalizeUserProjectPath(args.scene_path as string),
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
      const scenePath = normalizeUserProjectPath(args.scene_path as string);
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

        const timer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            resolve({ content: [{ type: 'text', text: 'batch_add_nodes timed out after 60s.' }] });
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `batch_add_nodes failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] });
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'edit_node': {
      const p = validatePath(args.project_path as string);
      const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
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

      const trySetHelper = `
func _try_set(node: Node, prop: String, value: Variant) -> void:
\tvar _ok = false
\tif node.get_property_list().any(func(p): return p.name == prop):
\t\tnode.set(prop, value)
\t\t_ok = true
\tif not _ok and node is Control:
\t\tvar _vtype = typeof(value)
\t\tif _vtype == TYPE_VECTOR2:
\t\t\tnode.add_theme_font_size_override(prop, int(value.x))
\t\telif _vtype == TYPE_COLOR:
\t\t\tnode.add_theme_color_override(prop, value)
\t\telif _vtype == TYPE_FLOAT or _vtype == TYPE_INT:
\t\t\tif node.has_theme_constant(prop):
\t\t\t\tnode.add_theme_constant_override(prop, int(value))
`;

      const script = `${SCENE_TREE_HEADER}
${trySetHelper}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
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
      const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
      const nodePath = normalizeNodePath(args.node_path as string);

      const script = `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
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

    case 'instance_scene': {
      return handleInstanceScene(args, ctx);
    }

    default:
      return null;
  }
}

function gdScriptSetLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `node.${key} = null`;
  if (typeof value === 'boolean') return `node.${key} = ${value}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `# skipped ${key}: non-finite number`;
    return `node.${key} = ${value}`;
  }
  if (typeof value === 'string') return `node.${key} = "${gdEscape(value)}"`;
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) return `# skipped ${key}: non-finite number in array`;
      return `_try_set(node, "${gdEscape(key)}", Vector2(${value[0]}, ${value[1]}))`;
    }
    if (value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'number' && typeof value[2] === 'number') {
      if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2])) return `# skipped ${key}: non-finite number in array`;
      return `_try_set(node, "${gdEscape(key)}", Vector3(${value[0]}, ${value[1]}, ${value[2]}))`;
    }
    if (value.length === 4 && value.every(v => typeof v === 'number')) {
      if (!value.every(v => Number.isFinite(v as number))) return `# skipped ${key}: non-finite number in array`;
      return `_try_set(node, "${gdEscape(key)}", Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]}))`;
    }
  }
  // Object format: {x,y} → Vector2, {x,y,z} → Vector3, {r,g,b,a} → Color
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
      if (!Number.isFinite(obj.x as number) || !Number.isFinite(obj.y as number)) return `# skipped ${key}: non-finite number in object`;
      if (typeof obj.z === 'number') {
        if (!Number.isFinite(obj.z as number)) return `# skipped ${key}: non-finite number in object`;
        return `_try_set(node, "${gdEscape(key)}", Vector3(${obj.x}, ${obj.y}, ${obj.z}))`;
      }
      return `_try_set(node, "${gdEscape(key)}", Vector2(${obj.x}, ${obj.y}))`;
    }
    if (typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1.0;
      if (!Number.isFinite(obj.r as number) || !Number.isFinite(obj.g as number) || !Number.isFinite(obj.b as number) || !Number.isFinite(a as number)) return `# skipped ${key}: non-finite number in object`;
      return `_try_set(node, "${gdEscape(key)}", Color(${obj.r}, ${obj.g}, ${obj.b}, ${a}))`;
    }
  }
  throw new Error(`Property "${key}" has unsupported type. Use string/number/bool/null, array [2]=Vector2/[3]=Vector3/[4]=Color, or object {x,y}/{x,y,z}/{r,g,b,a}.`);
}

// ─── instance_scene handler ──────────────────────────────────────────────────

const BLOCKED_PROPS = new Set(['script', 'owner', 'name', 'parent', 'children', 'tree']);

async function handleInstanceScene(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // 必需参数校验
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.instance_path) return opsErrorResult('MISSING_PARAM', 'instance_path is required');

  const p = validatePath(args.project_path as string);
  const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
  const instancePath = String(args.instance_path);

  // 校验 instance_path 后缀
  if (!instancePath.endsWith('.tscn')) {
    return opsErrorResult('INVALID_PARAM', 'instance_path must end with .tscn');
  }

  // 循环引用检查：对 instancePath 做与 scenePath 相同的路径解析，防止 res://scenes/../scenes/main.tscn 绕过
  const instancePathResolved = resolveWithinRoot(p, normalizeUserProjectPath(instancePath));
  if (scenePath === instancePathResolved) {
    return opsErrorResult('CIRCULAR_REFERENCE', 'CIRCULAR: scene_path and instance_path must not be the same');
  }

  const parentNodePath = normalizeNodePath((args.parent_node_path as string) || 'root');
  const nodeName = args.node_name ? String(args.node_name) : '';

  // 属性覆写中排除危险属性
  const properties = (args.properties as Record<string, unknown>) || {};
  const safeProps = Object.entries(properties).filter(([k]) => !BLOCKED_PROPS.has(k));

  let propLines = '';
  for (const [key, value] of safeProps) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    try {
      const line = gdScriptSetLine(key, value).replace(/node\./g, '_inst.').replace(/node,/g, '_inst,');
      if (!line.startsWith('# skipped')) {
        propLines += `\n\t${line}`;
      }
    } catch {
      // unsupported type — skip this property
    }
  }

  const trySetHelper = `
func _try_set(node: Node, prop: String, value: Variant) -> void:
\tvar _ok = false
\tif node.get_property_list().any(func(p): return p.name == prop):
\t\tnode.set(prop, value)
\t\t_ok = true
\tif not _ok and node is Control:
\t\tvar _vtype = typeof(value)
\t\tif _vtype == TYPE_VECTOR2:
\t\t\tnode.add_theme_font_size_override(prop, int(value.x))
\t\telif _vtype == TYPE_COLOR:
\t\t\tnode.add_theme_color_override(prop, value)
\t\telif _vtype == TYPE_FLOAT or _vtype == TYPE_INT:
\t\t\tif node.has_theme_constant(prop):
\t\t\t\tnode.add_theme_constant_override(prop, int(value))
`;

  const nameLine = nodeName ? `\n\t_inst.name = "${gdEscape(nodeName)}"` : '';

  const script = `${SCENE_TREE_HEADER}
${trySetHelper}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar _scene_res = load("${gdEscape(instancePath)}")
\tif _scene_res == null:
\t\t_mcp_output("error", "Failed to load instance: ${gdEscape(instancePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_scene_res is PackedScene):
\t\t_mcp_output("error", "Resource is not a PackedScene: ${gdEscape(instancePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _inst = _scene_res.instantiate()
\tif _inst == null:
\t\t_mcp_output("error", "Failed to instantiate: ${gdEscape(instancePath)}")
\t\t_mcp_done()
\t\treturn${nameLine}${propLines}
\tvar _parent = _mcp_get_scene_node("${gdEscape(parentNodePath)}")
\tif _parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentNodePath)}")
\t\t_mcp_done()
\t\treturn
\t_parent.add_child(_inst, true)
\t_mcp_output("instanced", {
\t\t"node_name": str(_inst.name),
\t\t"node_type": _inst.get_class(),
\t\t"instance_of": "${gdEscape(instancePath)}",
\t\t"path": str(_inst.get_path())
\t})
\t_mcp_done()
`;

  const godot = await ctx.findGodot();
  const result = await executeGdscript({
    godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads: true,
  });
  return parseGdscriptResult(result, [], (msg) => {
    if (msg.includes('not found')) return 'NODE_NOT_FOUND';
    if (msg.includes('not a PackedScene')) return 'INVALID_RESOURCE';
    if (msg.includes('Failed to load')) return 'LOAD_FAILED';
    return 'SCRIPT_EXEC_FAILED';
  });
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  read_scene: { readonly: true, long_running: false },
  create_scene: { readonly: false, long_running: false },
  add_node: { readonly: false, long_running: false },
  save_scene: { readonly: false, long_running: false },
  load_sprite: { readonly: false, long_running: false },
  quick_scene: { readonly: false, long_running: false },
  batch_add_nodes: { readonly: false, long_running: false },
  query_scene_tree: { readonly: true, long_running: false },
  inspect_node: { readonly: true, long_running: false },
  edit_node: { readonly: false, long_running: false },
  remove_node: { readonly: false, long_running: false },
  instance_scene: { readonly: false, long_running: true },
};
