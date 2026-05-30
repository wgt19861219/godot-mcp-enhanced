import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir, parseMcpScriptOutput, buildSafeEnv } from '../helpers.js';
import { parseTscn, parseTscnSummary } from '../tscn-parser.js';
import { findInstanceNode, detachInstance, nodePathToNameAndParent } from '../tscn-editor.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult, sanitizeResPath } from './shared.js';
import { normalizeNodePath, gdEscape, toSnakeCase, valueToGd } from './shared.js';
import { forceKillTree, acquireShortRunningSlot, releaseShortRunningSlot } from '../core/process-state.js';

const ACTIONS = [
  'read_scene', 'create_scene', 'add_node', 'save_scene', 'load_sprite',
  'quick_scene', 'batch_add_nodes', 'query_scene_tree', 'inspect_node',
  'edit_node', 'remove_node', 'instance_scene', 'set_instance_property', 'detach_instance',
  'health_check',
  'merge_scene',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'scene',
      description: '场景操作。读取/创建: read_scene, create_scene, quick_scene。节点: add_node, batch_add_nodes, edit_node, remove_node。保存/资源: save_scene, load_sprite。查询: query_scene_tree, inspect_node。实例: instance_scene, set_instance_property, detach_instance。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          scene_path: { type: 'string', description: '场景路径（read_scene 用绝对路径，其余用相对项目路径）' },
          summary_only: { type: 'boolean', description: 'read_scene: 返回摘要而非完整 JSON' },
          root_node_type: { type: 'string', description: 'create_scene/quick_scene: 根节点类型（默认 Node2D）' },
          root_node_name: { type: 'string', description: 'quick_scene: 根节点名称（默认从文件名推导 PascalCase）' },
          script_path: { type: 'string', description: 'quick_scene: 脚本路径（可选）' },
          script_content: { type: 'string', description: 'quick_scene: 脚本内容（脚本不存在时自动创建）' },
          node_type: { type: 'string', description: 'add_node: 节点类型（如 Sprite2D, Camera2D）' },
          node_name: { type: 'string', description: 'add_node: 节点名称' },
          parent_node_path: { type: 'string', description: 'add_node/instance_scene: 父节点路径（默认 root）' },
          properties: { type: 'object', description: 'add_node/edit_node/instance_scene: 属性对象' },
          new_path: { type: 'string', description: 'save_scene: 新保存路径（可选）/ merge_scene: theirs 场景路径（必需）' },
          texture_path: { type: 'string', description: 'load_sprite: 纹理路径（如 res://assets/player.png）' },
          node_path: { type: 'string', description: 'inspect_node/edit_node/remove_node/load_sprite/detach_instance/set_instance_property: 节点路径' },
          max_depth: { type: 'number', description: 'query_scene_tree/inspect_node: 最大遍历深度' },
          include_signals: { type: 'boolean', description: 'inspect_node: 包含信号连接（默认 true）' },
          include_properties: { type: 'boolean', description: 'inspect_node: 包含属性值（默认 true）' },
          nodes: {
            type: 'array',
            description: 'batch_add_nodes: 节点定义数组',
            items: {
              type: 'object',
              properties: {
                node_type: { type: 'string', description: '节点类型' },
                node_name: { type: 'string', description: '节点名称' },
                parent_node_path: { type: 'string', description: '父路径（默认 root）' },
                properties: { type: 'object', description: '属性' },
              },
              required: ['node_type', 'node_name'],
            },
          },
          load_autoloads: { type: 'boolean', description: 'edit_node/remove_node/set_instance_property: 加载 Autoload（默认 true）' },
          instance_path: { type: 'string', description: 'instance_scene: 要实例化的场景文件（res://scenes/player.tscn）' },
          property: { type: 'string', description: 'set_instance_property: 属性名' },
          value: { description: 'set_instance_property: 属性值（string/number/bool/null/array/object）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'scene') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  switch (action) {
    case 'read_scene': {
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.scene_path as string));
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
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const godot = await ctx.findGodot();

      const params: Record<string, unknown> = {};
      if (action === 'create_scene') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        params.root_node_type = args.root_node_type || 'Node2D';
      } else if (action === 'add_node') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        const safeType = /^[A-Za-z0-9_]+$/;
        const unsafeName = /[\]["/:\\]/;
        if (!safeType.test(String(args.node_type ?? ''))) {
          return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
        }
        if (!String(args.node_name ?? '') || unsafeName.test(String(args.node_name))) {
          return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
        }
        params.node_type = args.node_type;
        params.node_name = args.node_name;
        params.parent_node_path = args.parent_node_path || 'root';
        if (args.properties) params.properties = args.properties;
      } else if (action === 'save_scene') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        if (args.new_path) {
          try {
            const np = normalizeUserProjectPath(String(args.new_path));
            resolveWithinRoot(p, np);
            params.new_path = np;
          } catch {
            return opsErrorResult('INVALID_PATH', 'new_path contains path traversal');
          }
        }
      } else if (action === 'load_sprite') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        const tp = String(args.texture_path);
        try { sanitizeResPath(tp, 'texture_path'); } catch {
          return opsErrorResult('INVALID_PATH', 'texture_path contains path traversal');
        }
        params.texture_path = tp;
        params.node_path = args.node_path || 'root';
      }

      return new Promise((resolve) => {
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', ctx.opsScript,
          action, JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

        let out = '';
        let settled = false;
        const MAX_OUTPUT = 100_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve({ content: [{ type: 'text', text: `${action} timed out.` }] });
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `${action} failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `${action} completed successfully.` }] });
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'quick_scene': {
      const p = requireProjectPath(args);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;

      // 输入验证: 防止 .tscn 模板注入
      const safeType = /^[A-Za-z0-9_]+$/;
      if (!safeType.test(rootNodeType)) {
        return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
      }

      // 推导根节点名: PascalCase (tween_demo -> TweenDemo)
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) {
        const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, '');
        rootNodeName = baseName ? baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Root';
      }
      if (!rootNodeName || !/^[A-Za-z0-9_]+$/.test(rootNodeName)) {
        return textResult(`Error: root_node_name must match /^[A-Za-z0-9_]+$/, got: "${rootNodeName}"`);
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
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const godot = await ctx.findGodot();
      const scriptsDir = dirname(ctx.opsScript);
      const treeScript = join(scriptsDir, 'query_scene_tree.gd');

      if (!existsSync(treeScript)) {
        releaseShortRunningSlot();
        return textResult(`Error: query_scene_tree.gd not found at ${treeScript}`);
      }

      const params = {
        scene_path: normalizeUserProjectPath(args.scene_path as string),
        max_depth: (args.max_depth as number) || 5,
      };

      return new Promise((resolve) => {
        let out = '';
        let settled = false;
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', treeScript,
          JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

        const MAX_OUTPUT = 100_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve(textResult('query_scene_tree timed out after 60s'));
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          const result = parseMcpScriptOutput(out, code);
          resolve(textResult(JSON.stringify(result, null, 2)));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve(textResult(`Error: ${err.message}`));
        });
      });
    }

    case 'inspect_node': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const godot = await ctx.findGodot();
      const scriptsDir = dirname(ctx.opsScript);
      const inspectScript = join(scriptsDir, 'inspect_node.gd');

      if (!existsSync(inspectScript)) {
        releaseShortRunningSlot();
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
        let settled = false;
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', inspectScript,
          JSON.stringify(params),
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

        const MAX_OUTPUT = 100_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve(textResult('inspect_node timed out after 60s'));
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          const result = parseMcpScriptOutput(out, code);
          resolve(textResult(JSON.stringify(result, null, 2)));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve(textResult(`Error: ${err.message}`));
        });
      });
    }

    case 'batch_add_nodes': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const scenePath = normalizeUserProjectPath(args.scene_path as string);
      const nodes = args.nodes as Array<{
        node_type: string;
        node_name: string;
        parent_node_path?: string;
        properties?: Record<string, unknown>;
      }>;

      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
        releaseShortRunningSlot();
        return opsErrorResult('INVALID_PARAMS', '"nodes" must be a non-empty array of node definitions.');
      }

      // Input validation for each node
      const safeType = /^[A-Za-z0-9_]+$/;
      const unsafeName = /[\]["/:\\]/;
      const MAX_BATCH_NODES = 100;
      if (nodes.length > MAX_BATCH_NODES) {
        releaseShortRunningSlot();
        return textResult(`Error: Too many nodes (${nodes.length}). Maximum: ${MAX_BATCH_NODES}`);
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n.node_type || !safeType.test(String(n.node_type))) {
          releaseShortRunningSlot();
          return textResult(`Error: nodes[${i}].node_type contains invalid characters: "${n.node_type}"`);
        }
        if (!n.node_name || unsafeName.test(String(n.node_name))) {
          releaseShortRunningSlot();
          return textResult(`Error: nodes[${i}].node_name contains invalid characters: "${n.node_name}"`);
        }
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
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

        let out = '';
        let settled = false;
        const MAX_OUTPUT = 100_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve({ content: [{ type: 'text', text: `batch_add_nodes timed out after 60s.` }] });
          }
        }, 60000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          if (code !== 0) {
            resolve({ content: [{ type: 'text', text: `batch_add_nodes failed (exit code ${code}):\n${out}` }] });
          } else {
            resolve({ content: [{ type: 'text', text: out.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] });
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'edit_node': {
      const p = requireProjectPath(args);
      const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
      const nodePath = normalizeNodePath(args.node_path as string);
      const properties = args.properties as Record<string, unknown>;
      if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
        return opsErrorResult('INVALID_PARAMS', '"properties" must be a non-empty object.');
      }

      // Build GDScript property setter lines
      let propLines = '';
      for (const [key, value] of Object.entries(properties)) {
        const gdKey = toSnakeCase(key);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(gdKey)) {
          return textResult(`Error: Invalid property name: "${key}"`);
        }
        propLines += `\n\t${gdScriptSetLine(gdKey, value)}`;
      }

      const script = `${SCENE_TREE_HEADER}
${TRY_SET_HELPER}
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
      return parseGdscriptResult(result, [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED', {
        suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.',
      });
    }

    case 'remove_node': {
      const p = requireProjectPath(args);
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
\t\tparent.remove_child(node)
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
      return parseGdscriptResult(result, [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED', {
        suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.',
      });
    }

    case 'instance_scene': {
      return handleInstanceScene(args, ctx);
    }

    case 'set_instance_property': {
      return handleSetInstanceProperty(args, ctx);
    }

    case 'detach_instance': {
      return handleDetachInstance(args);
    }

    case 'health_check': {
      const p = requireProjectPath(args);
      const scenePath = args.scene_path as string;
      if (!scenePath) {
        return opsErrorResult('INVALID_PARAMS', 'scene_path is required for health_check', {
          suggestion: 'Provide the scene file path relative to project, e.g. "scenes/main.tscn"',
        });
      }
      const fullPath = resolveWithinRoot(p, scenePath);
      if (!existsSync(fullPath)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene not found: ${scenePath}`);
      }
      const content = readFileSync(fullPath, 'utf-8');
      const result = checkSceneHealth(content, scenePath);
      return textResult(JSON.stringify({
        scene: scenePath,
        healthy: result.issues.length === 0,
        issue_count: result.issues.length,
        issues: result.issues,
        nodes_checked: result.nodesChecked,
      }, null, 2));
    }

    case 'merge_scene': {
      const p = requireProjectPath(args);
      const sceneA = args.scene_path as string;
      const sceneB = args.new_path as string;
      if (!sceneA || !sceneB) {
        return opsErrorResult('INVALID_PARAMS', 'Both scene_path (ours) and new_path (theirs) are required', {
          suggestion: 'Provide two scene file paths: scene_path=ours.tscn new_path=theirs.tscn',
        });
      }
      const fullPathA = resolveWithinRoot(p, sceneA);
      const fullPathB = resolveWithinRoot(p, sceneB);
      if (!existsSync(fullPathA)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene A not found: ${sceneA}`);
      }
      if (!existsSync(fullPathB)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene B not found: ${sceneB}`);
      }
      const MAX_MERGE_SIZE = 10 * 1024 * 1024; // 10MB limit (consistent with parseTscn)
      const statA = statSync(fullPathA);
      const statB = statSync(fullPathB);
      if (statA.size > MAX_MERGE_SIZE || statB.size > MAX_MERGE_SIZE) {
        return opsErrorResult('FILE_TOO_LARGE', `Scene file exceeds 10MB merge limit (A: ${statA.size}B, B: ${statB.size}B)`);
      }
      if (!existsSync(fullPathB)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene B not found: ${sceneB}`);
      }
      const ours = readFileSync(fullPathA, 'utf-8');
      const theirs = readFileSync(fullPathB, 'utf-8');
      const merged = mergeTscn(ours, theirs);
      writeFileSync(fullPathA, merged, 'utf-8');
      return textResult(JSON.stringify({
        merged_into: sceneA,
        source: sceneB,
        status: 'ok',
      }, null, 2));
    }

    default:
      return null;
  }
}

/**
 * Generates a GDScript property-set line for a given key/value pair.
 *
 * Simple types (null, bool, number, string) → direct assignment: `node.key = value`
 * Vector/Color types → _try_set() call: `_try_set(node, "key", Vector2(...))`
 *
 * Uses the shared `valueToGd()` serializer from shared.ts for the expression.
 * On non-finite values, returns a comment line starting with `# skipped`.
 */
function gdScriptSetLine(key: string, value: unknown, varName = 'node'): string {
  const needsTrySet = isVectorLike(value);
  const ek = gdEscape(key);
  try {
    const expr = valueToGd(value);
    if (needsTrySet) {
      return `_try_set(${varName}, "${ek}", ${expr})`;
    }
    return `${varName}.${key} = ${expr}`;
  } catch (e: unknown) {
    // valueToGd throws on non-finite numbers — convert to a skip comment
    const msg = (e as Error).message;
    if (msg.includes('Non-finite')) return `# skipped ${key}: non-finite number`;
    throw e;
  }
}

/** Returns true if the value is an array/object that produces a Vector/Color expression. */
function isVectorLike(value: unknown): boolean {
  if (Array.isArray(value)) {
    return (value.length >= 2 && value.length <= 4 && value.every(v => typeof v === 'number'));
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return !!(typeof obj.x === 'number' || typeof obj.r === 'number');
  }
  return false;
}

// ─── trySetHelper (shared across edit_node, instance_scene, set_instance_property) ──

const TRY_SET_HELPER = `
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

// ─── instance_scene handler ──────────────────────────────────────────────────

const BLOCKED_PROPS = new Set([
  'script', 'owner', 'name', 'parent', 'children', 'tree',
  'meta', 'process_mode', 'process_priority',
  'process_input', 'process_unhandled_input', 'process_unhandled_key_input',
  'process_internal', 'physics_process_mode', 'input_event', 'ready',
]);

async function handleInstanceScene(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // 必需参数校验
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.instance_path) return opsErrorResult('MISSING_PARAM', 'instance_path is required');

  const p = requireProjectPath(args);
  const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
  const instancePath = String(args.instance_path);

  // 校验 instance_path 后缀 + 路径安全
  if (!instancePath.endsWith('.tscn') || !/^res:\/\/[a-zA-Z0-9_\-/.]+\.tscn$/.test(instancePath)) {
    return opsErrorResult('INVALID_PARAM', 'instance_path must be a valid res:// path ending in .tscn');
  }

  // 循环引用检查：对 instancePath 做与 scenePath 相同的路径解析，防止 res://scenes/../scenes/main.tscn 绕过
  const instancePathResolved = resolveWithinRoot(p, normalizeUserProjectPath(instancePath));
  if (scenePath === instancePathResolved) {
    return opsErrorResult('CIRCULAR_REFERENCE', 'CIRCULAR: scene_path and instance_path must not be the same');
  }

  const parentNodePath = normalizeNodePath((args.parent_node_path as string) || 'root');
  const nodeName = args.node_name ? String(args.node_name) : '';

  // 属性覆写中排除危险属性
  const rawProps = args.properties;
  if (rawProps !== undefined && rawProps !== null && (typeof rawProps !== 'object' || Array.isArray(rawProps))) {
    return opsErrorResult('INVALID_PARAMS', 'properties must be an object');
  }
  const properties = (rawProps as Record<string, unknown>) || {};
  const safeProps = Object.entries(properties).filter(([k]) => !BLOCKED_PROPS.has(k));

  let propLines = '';
  for (const [key, value] of safeProps) {
    const gdKey = toSnakeCase(key);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(gdKey)) continue;
    try {
      const line = gdScriptSetLine(gdKey, value, '_inst');
      if (!line.startsWith('# skipped')) {
        propLines += `\n\t${line}`;
      }
    } catch {
      // unsupported type — skip this property
    }
  }

  const nameLine = nodeName ? `\n\t_inst.name = "${gdEscape(nodeName)}"` : '';

  const script = `${SCENE_TREE_HEADER}
${TRY_SET_HELPER}
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
  }, {
    suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.',
  });
}

// ─── set_instance_property handler ────────────────────────────────────────────

async function handleSetInstanceProperty(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // 必需参数校验
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.node_path) return opsErrorResult('MISSING_PARAM', 'node_path is required');
  if (!args.property) return opsErrorResult('MISSING_PARAM', 'property is required');
  if (args.value === undefined) return opsErrorResult('MISSING_PARAM', 'value is required');

  const p = requireProjectPath(args);
  const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
  const nodePath = normalizeNodePath(args.node_path as string);
  const rawPropName = String(args.property);
  const propName = toSnakeCase(rawPropName);
  const propValue = args.value;

  // 属性名安全检查
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(propName)) {
    return opsErrorResult('INVALID_PARAM', `Invalid property name: "${rawPropName}"`);
  }
  if (BLOCKED_PROPS.has(propName)) {
    return opsErrorResult('BLOCKED_PROP', `Property "${propName}" is not allowed`);
  }

  // 生成属性设置行
  let propLine: string;
  try {
    propLine = gdScriptSetLine(propName, propValue, 'target');
  } catch (e: unknown) {
    return opsErrorResult('INVALID_VALUE', (e as Error).message);
  }
  if (propLine.startsWith('# skipped')) {
    return opsErrorResult('INVALID_VALUE', `Cannot set property "${propName}": non-finite value`);
  }

  const script = `${SCENE_TREE_HEADER}
${TRY_SET_HELPER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar target = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif target == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_scene_instance
\tvar is_instance = (target != root and target.owner == root)
\tif not is_instance:
\t\t_mcp_output("error", "NODE_NOT_INSTANCE: node '${gdEscape(nodePath)}' is not an instanced scene child")
\t\t_mcp_done()
\t\treturn
\t${propLine}
\t_mcp_output("set_property", {"node": "${gdEscape(nodePath)}", "property": "${gdEscape(propName)}"})
\t_mcp_done()
`;

  const godot = await ctx.findGodot();
  const loadAutoloads = args.load_autoloads !== false;
  const result = await executeGdscript({
    godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads,
  });
  return parseGdscriptResult(result, [], (msg) => {
    if (msg.includes('not found')) return 'NODE_NOT_FOUND';
    if (msg.includes('NODE_NOT_INSTANCE')) return 'NODE_NOT_INSTANCE';
    return 'SCRIPT_EXEC_FAILED';
  }, {
    suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.',
  });
}

// ─── detach_instance handler (TS-side .tscn text edit) ─────────────────────

function handleDetachInstance(args: Record<string, unknown>): ToolResult {
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.node_path) return opsErrorResult('MISSING_PARAM', 'node_path is required');

  const p = requireProjectPath(args);
  const sceneAbsPath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));

  if (!existsSync(sceneAbsPath)) {
    return textResult(`Error: Scene file not found: ${sceneAbsPath}`);
  }

  // Resolve node_path → nodeName + tscnParent
  let nodeName: string;
  let tscnParent: string;
  try {
    const parsed = nodePathToNameAndParent(String(args.node_path));
    nodeName = parsed.nodeName;
    tscnParent = parsed.parent;
  } catch (e: unknown) {
    return opsErrorResult('INVALID_PARAM', (e as Error).message);
  }

  // Read target .tscn
  let targetContent: string;
  try {
    targetContent = readFileSync(sceneAbsPath, 'utf-8');
  } catch (e: unknown) {
    return textResult(`Error reading scene: ${(e as Error).message}`);
  }

  // Find the instance node
  const info = findInstanceNode(targetContent, nodeName, tscnParent);
  if (!info) {
    return opsErrorResult('NOT_AN_INSTANCE', `Node "${nodeName}" (parent: "${tscnParent}") is not an instance or not found`);
  }

  // Read source .tscn
  const sourceAbsPath = resolveWithinRoot(p, info.sourcePath.replace(/^res:\/\//, ''));
  if (!existsSync(sourceAbsPath)) {
    return textResult(`Error: Source scene not found: ${info.sourcePath} (${sourceAbsPath})`);
  }

  let sourceContent: string;
  try {
    sourceContent = readFileSync(sourceAbsPath, 'utf-8');
  } catch (e: unknown) {
    return textResult(`Error reading source scene: ${(e as Error).message}`);
  }

  // Perform detach
  let result: string;
  try {
    result = detachInstance(targetContent, sourceContent, nodeName, tscnParent);
  } catch (e: unknown) {
    return textResult(`Error detaching instance: ${(e as Error).message}`);
  }

  // Write result atomically (temp file + rename) to prevent partial writes
  const tmpPath = sceneAbsPath + '.tmp';
  try {
    writeFileSync(tmpPath, result, 'utf-8');
    renameSync(tmpPath, sceneAbsPath);
  } catch (e: unknown) {
    // Cleanup temp file on failure
    try { unlinkSync(tmpPath); } catch (e) { console.debug('[scene] cleanup temp file:', e); }
    return textResult(`Error writing scene: ${(e as Error).message}`);
  }

  return textResult(`Detached instance "${nodeName}" — inlined from ${info.sourcePath} (${info.propertyOverrides.length} property override(s) preserved)`);
}

// ─── .tscn merge conflict resolver ────────────────────────────────────────────

export function mergeTscn(ours: string, theirs: string): string {
  // Parse ext_resources from both sides
  interface ExtRes { type: string; path: string; originalId: string; line: string }
  const parseExt = (content: string): ExtRes[] => {
    const result: ExtRes[] = [];
    let m: RegExpExecArray | null;
    const regex = /\[ext_resource\s+([^[\]]+)\]/g;
    while ((m = regex.exec(content)) !== null) {
      const line = m[1];
      const typeMatch = line.match(/type="([^"]+)"/);
      const pathMatch = line.match(/path="([^"]+)"/);
      const idMatch = line.match(/id="([^"]+)"/);
      if (pathMatch) {
        result.push({ type: typeMatch?.[1] || '', path: pathMatch[1], originalId: idMatch?.[1] || '', line: m[0] });
      }
    }
    return result;
  };

  // Parse sub_resources from both sides
  interface SubRes { type: string; originalId: string; body: string }
  const parseSub = (content: string): SubRes[] => {
    const result: SubRes[] = [];
    const regex = /\[sub_resource\s+type="([^"]+)"\s+id="([^"]+)"\]([\s\S]*?)(?=\n\[sub_resource|\n\[node|\n\[ext_resource|$)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      result.push({ type: m[1], originalId: m[2], body: m[3].trim() });
    }
    return result;
  };

  // Parse nodes from both sides
  interface NodeDef { name: string; line: string; body: string }
  const parseNodes = (content: string): NodeDef[] => {
    const result: NodeDef[] = [];
    const sections = content.split(/\n(?=\[node\s)/);
    for (const section of sections) {
      const headerMatch = section.match(/^\[node\s+name="([^"]+)"/);
      if (headerMatch) {
        result.push({ name: headerMatch[1], line: headerMatch[0], body: section.trim() });
      }
    }
    return result;
  };

  // Get header (before first ext_resource or sub_resource or node)
  const headerMatch = ours.match(/^([\s\S]*?)(?=\n\[ext_resource|\n\[sub_resource|\n\[node)/);
  const header = headerMatch ? headerMatch[1].trim() : '[gd_scene format=3]';

  // Merge ext_resources: ours first, then new from theirs (by path dedup)
  const oursExt = parseExt(ours);
  const theirsExt = parseExt(theirs);
  const seenPaths = new Set(oursExt.map(e => e.path));
  const mergedExt = [...oursExt];
  for (const ext of theirsExt) {
    if (!seenPaths.has(ext.path)) {
      mergedExt.push(ext);
      seenPaths.add(ext.path);
    }
  }

  // Merge sub_resources: ours first, then new from theirs (by type+body signature dedup)
  const oursSub = parseSub(ours);
  const theirsSub = parseSub(theirs);
  const subSignature = (s: SubRes) => `${s.type}::${s.body}`;
  const seenSubSigs = new Set(oursSub.map(s => subSignature(s)));
  const mergedSub = [...oursSub];
  for (const sub of theirsSub) {
    if (!seenSubSigs.has(subSignature(sub))) {
      mergedSub.push(sub);
    }
  }

  // ID assignment: preserve originals, remap only on collision
  // Phase 1: reserve all ours IDs (ours resources always keep their original IDs)
  const usedIds = new Set<string>();
  oursExt.forEach(e => { if (e.originalId) usedIds.add(e.originalId); });
  oursSub.forEach(s => { if (s.originalId) usedIds.add(s.originalId); });

  // Helper: generate a collision-free new ID matching the type of the original
  const allocateId = (originalId: string, isOurs: boolean): string => {
    if (isOurs || !usedIds.has(originalId)) {
      usedIds.add(originalId);
      return originalId;
    }
    // Collision — generate new ID preserving type
    if (/^\d+$/.test(originalId)) {
      const maxNum = [...usedIds].filter(id => /^\d+$/.test(id)).reduce((max, id) => Math.max(max, parseInt(id)), 0);
      const newId = String(maxNum + 1);
      usedIds.add(newId);
      return newId;
    }
    // String UID: append _m{N} with loop until free
    let seq = 1;
    let candidate = `${originalId}_m${seq}`;
    while (usedIds.has(candidate)) {
      seq++;
      candidate = `${originalId}_m${seq}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  const extIdMap: Record<string, string> = {};
  const reindexedExt: string[] = [];
  mergedExt.forEach((ext) => {
    const isOurs = oursExt.some(o => o.path === ext.path);
    const newId = allocateId(ext.originalId, isOurs);
    if (ext.originalId && ext.originalId !== newId) extIdMap[ext.originalId] = newId;
    reindexedExt.push(`[ext_resource type="${ext.type}" path="${ext.path}" id="${newId}"]`);
  });

  const subIdMap: Record<string, string> = {};
  const reindexedSub: string[] = [];
  mergedSub.forEach((sub) => {
    const isOurs = oursSub.some(o => o.type === sub.type && o.body === sub.body);
    const newId = allocateId(sub.originalId, isOurs);
    if (sub.originalId !== newId) subIdMap[sub.originalId] = newId;
    reindexedSub.push(`[sub_resource type="${sub.type}" id="${newId}"]\n${sub.body}`);
  });

  // Merge nodes: ours nodes + theirs nodes not in ours (by name)
  const oursNodes = parseNodes(ours);
  const theirsNodes = parseNodes(theirs);
  const oursNames = new Set(oursNodes.map(n => n.name));
  const mergedNodes = [...oursNodes];
  for (const node of theirsNodes) {
    if (!oursNames.has(node.name)) {
      mergedNodes.push(node);
    }
  }

  // Update header load_steps
  const totalResources = mergedExt.length + mergedSub.length;
  const updatedHeader = header.replace(/load_steps=\d+/, `load_steps=${totalResources + 1}`);

  // Detect format mismatch
  const formatOf = (content: string): string | null => {
    const m = content.match(/format=(\d+)/);
    return m ? m[1] : null;
  };
  const fmtA = formatOf(ours);
  const fmtB = formatOf(theirs);

  // Rebuild the scene file
  const parts: string[] = [updatedHeader, ''];
  if (fmtA && fmtB && fmtA !== fmtB) {
    parts.push(`; WARNING: format mismatch — ours=${fmtA} theirs=${fmtB}`);
  }
  parts.push(...reindexedExt);
  if (reindexedSub.length > 0) {
    parts.push('');
    parts.push(...reindexedSub);
  }
  parts.push('');
  for (const node of mergedNodes) {
    let body = node.body;
    if (Object.keys(extIdMap).length > 0) {
      body = body.replace(/ExtResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = extIdMap[id];
        return newId ? `ExtResource("${newId}")` : `ExtResource("${id}")`;
      });
    }
    if (Object.keys(subIdMap).length > 0) {
      body = body.replace(/SubResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = subIdMap[id];
        return newId ? `SubResource("${newId}")` : `SubResource("${id}")`;
      });
    }
    parts.push(body);
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Scene health check ────────────────────────────────────────────────────────

export function checkSceneHealth(
  content: string,
  scenePath: string,
): { issues: string[]; nodesChecked: number } {
  const issues: string[] = [];
  const lines = content.split('\n');

  // Parse nodes: [node name="X" type="Y" parent="Z"]
  const nodeRegex = /^\[node\s+name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]*)")?\]/;
  const nodes: Array<{ name: string; type?: string; parent?: string; hasScript: boolean; line: number }> = [];

  let currentSection = '';
  let currentNode: typeof nodes[0] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('[node ')) {
      const match = line.match(nodeRegex);
      if (match) {
        currentNode = { name: match[1], type: match[2], parent: match[3], hasScript: false, line: i + 1 };
        nodes.push(currentNode);
      }
      currentSection = 'node';
      continue;
    }

    if (line.startsWith('[')) {
      currentSection = line.startsWith('[gd_') ? 'header' : 'resource';
      currentNode = null;
      continue;
    }

    // Track if node has script
    if (currentNode && currentSection === 'node') {
      if (/^script\s*=/.test(line)) {
        currentNode.hasScript = true;
      }
    }
  }

  // Check 1: Self-referencing instance (circular)
  const extSceneRegex = /\[ext_resource[^[]*type="PackedScene"[^[]*path="([^"]+)"/g;
  let extMatch: RegExpExecArray | null;
  while ((extMatch = extSceneRegex.exec(content)) !== null) {
    const resPath = extMatch[1];
    // Convert scenePath to res:// format for comparison
    const normalizedScene = scenePath.replace(/\\/g, '/');
    if (resPath.endsWith(normalizedScene) || normalizedScene.endsWith(resPath.replace('res://', ''))) {
      issues.push(`Circular self-reference: scene instances itself via ${resPath}`);
    }
  }

  // Check 2: Duplicate node names at same parent level
  const childrenByParent: Record<string, string[]> = {};
  for (const node of nodes) {
    const parent = node.parent || '.';
    if (!childrenByParent[parent]) childrenByParent[parent] = [];
    childrenByParent[parent].push(node.name);
  }
  for (const [parent, names] of Object.entries(childrenByParent)) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        issues.push(`Duplicate node name "${name}" under parent "${parent}"`);
      }
      seen.add(name);
    }
  }

  // Check 3: Orphan leaf nodes (no script, no children, not a built-in type)
  const builtInTypes = new Set(['Camera2D', 'Camera3D', 'CollisionShape2D', 'CollisionShape3D',
    'VisibleOnScreenNotifier2D', 'VisibleOnScreenNotifier3D', 'AudioListener2D', 'AudioListener3D']);

  for (const node of nodes) {
    const hasChildren = nodes.some(n => {
      if (!n.parent) return false;
      const expected = node.parent ? `${node.parent}/${node.name}` : node.name;
      return n.parent === expected || (node.parent === '.' && n.parent === node.name);
    });
    if (!node.hasScript && !hasChildren && node.type && !builtInTypes.has(node.type)) {
      issues.push(`Orphan node "${node.name}" (${node.type}) has no script and no children`);
    }
  }

  return { issues, nodesChecked: nodes.length };
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene: { readonly: false, long_running: true },
};
