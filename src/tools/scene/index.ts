// Scene tool entry point: definitions, handler, and meta.

import { join, dirname } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import { existsSync, readFileSync, statSync } from 'fs';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult, errorResult } from '../../types.js';
import { maybeWrapUntrusted } from '../../core/untrusted-wrap.js';
import { pluginSelfPathGuard } from '../shared/file-guard.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir, parseMcpScriptOutput } from '../../helpers.js';
import { parseTscn, parseTscnSummary } from '../../tscn/tscn-parser.js';
import { normalizeNodePath, opsErrorResult, sanitizeResPath } from '../shared.js';
import { addNode, verifySceneTree } from '../../tscn/tscn-editor.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../../core/process-state.js';
import { spawnGodot } from '../spawn-helper.js';
import { ACTIONS, requireScenePath, writeAtomic, inferSceneRootName } from './helpers.js';
import { handleInstanceScene, handleSetInstanceProperty, handleDetachInstance } from './scene-instance.js';
import { mergeTscn, checkSceneHealth } from './scene-merge.js';
import { handleCreate3dNode } from '../node-3d-ops.js';
import { handleCommitAction } from './scene-commit-tool.js';
import { scanScriptSandboxOrThrow } from '../script.js';
import type { RiskLevel } from '../../core/tool-registry.js';

export { mergeTscn, checkSceneHealth };

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'scene',
      description: '场景操作。读取/创建: read_scene, create_scene, quick_scene。节点: add_node, batch_add_nodes, edit_node, remove_node。保存/资源: save_scene, load_sprite。查询: query_scene_tree, inspect_node。实例: instance_scene, set_instance_property, detach_instance。详细用法: help 工具。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。read_scene/query_scene_tree/inspect_node=读取, create_scene/add_node/batch_add_nodes/quick_scene=创建, edit_node/remove_node=编辑删除, save_scene/open_scene=保存打开, instance_scene/set_instance_property/detach_instance=实例化, load_sprite=贴图加载, health_check=体检, merge_scene=合并, create_3d_node/commit=3D节点/批量提交',
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
          instance_path: { type: 'string', description: '要实例化的场景（res://…tscn）' },
          property: { type: 'string', description: 'set_instance_property: 属性名' },
          value: { description: '属性值（set_instance_property）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          // create_3d_node 参数
          type: { type: 'string', description: '类型（create_3d_node，白名单）' },
          name: { type: 'string', description: '名称（create_3d_node）' },
          parent: { type: 'string', description: 'create_3d_node: 父节点路径（默认 root）' },
          // commit 参数
          operations: {
            type: 'array',
            description: 'commit: 批量操作列表（enum 见 op 字段；铺设/TileSet 层配置/节点）',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add', 'tileset_physics_layer_add', 'tile_collision_set', 'tileset_physics_layer_set', 'tileset_physics_layer_remove', 'tileset_navigation_layer_add', 'tile_navigation_set', 'tileset_custom_data_layer_add', 'tile_custom_data_set', 'tile_collision_clear'] },
                node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
                coords: { type: 'object', description: '图块坐标 {x, y}' },
                region: { type: 'object', description: '矩形区域 {x, y, w, h}' },
                source_id: { type: 'number', description: 'TileSet 源 ID' },
                atlas: { type: 'object', description: '图集坐标 {x, y}' },
                alternative_tile: { type: 'number', description: '替代图块索引（默认 0）' },
                tileset_path: { type: 'string', description: 'TileSet .tres 路径（层配置 9 op 限 res:// 项目内）' },
                collision_layer: { type: 'number', description: '物理层位掩码（physics add/set）' },
                collision_mask: { type: 'number', description: '物理遮罩位掩码（physics add/set）' },
                physics_layer: { type: 'number', description: '物理 layer 索引，0 起（collision set/clear）' },
                layer: { type: 'number', description: 'layer 索引，0 起（physics set/remove、cdata set）' },
                layers: { type: 'number', description: '导航层位掩码（navigation add，可选）' },
                navigation_layer: { type: 'number', description: '导航 layer 索引，0 起（navigation set）' },
                shape: { type: 'string', enum: ['rect', 'polygon'], description: 'rect=全格四点;polygon=自定义点集' },
                points: { type: 'array', description: 'polygon 点集 [{x,y}]（rect 省略;逐项运行时校验）' },
                one_way: { type: 'boolean', description: '单向碰撞（collision set，默认 false）' },
                name: { type: 'string', description: '节点名（node_add）/数据层名（cdata add）' },
                type: { type: 'string', description: '节点类型（node_add）/int|float|bool|string|color|vector2（cdata add）' },
                path: { type: 'string', description: '节点路径（node_property）' },
                property: { type: 'string', description: '属性名' },
                value: { description: '属性值（node_property）/数据值（cdata set，须匹配层类型）' },
                parent: { type: 'string', description: '父节点路径（node_add）' },
              },
            },
          },
          save: { type: 'boolean', description: 'commit: 是否保存到文件（默认 true）' },
          stop_on_error: { type: 'boolean', description: '遇错是否停止（默认 true;false 时失败不阻止后续与 .tres 写盘）' },
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
  if (name !== 'scene') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  switch (action) {
    case 'read_scene': {
      const spErr = requireScenePath(args.scene_path);
      if (spErr) return spErr;
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.scene_path as string));
      if (!existsSync(sp)) return textResult(`Scene file not found: ${sp}`);
      const content = readFileSync(sp, 'utf-8');
      // P1-1: 场景文件内容 nonce 信封(输出侧防注入)
      if (args.summary_only) return textResult(maybeWrapUntrusted('scene.read', sp, parseTscnSummary(content)));
      const parsed = parseTscn(content);
      const roots = parsed.nodes.filter(n => !n.parent);
      // P1-1: 场景文件内容 nonce 信封(输出侧防注入)
      return textResult(maybeWrapUntrusted('scene.read', sp, JSON.stringify({ header: parsed.header, extResources: parsed.extResources, subResources: parsed.subResources, nodeTree: roots, connections: parsed.connections, totalNodes: parsed.nodes.length }, null, 2)));
    }

    // P1 file-op shortcut for add_node: try pure text editing first,
    // fall through to spawnGodot if properties are unsupported.
    case 'add_node': {
      // Validate params
      const p = requireProjectPath(args);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) {
        return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
      }
      if (!String(args.node_name ?? '') || /[\]["/:\\\r\n\t]/.test(String(args.node_name))) {  // 审查 L-3: 补 \r\n\t(GD Node.name 保留控制字符→stdout 展示层注入)
        return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
      }

      const absPath = resolveWithinRoot(p, sceneRelPath);
      if (!existsSync(absPath)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${sceneRelPath}`);
      }

      // P1-2 (2026-07-06 review): editor 场景写守卫 — add_node 写回前检查场景是否在编辑器打开,
      // 防覆盖编辑器内存状态致版本撕裂。headless 模式 checkEditorSceneSave 未注入, 直接放行。
      if (ctx.checkEditorSceneSave) {
        const sceneGuard = await ctx.checkEditorSceneSave(absPath);
        if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
      }

      // Convert parent_node_path to .tscn parent format
      const tscnContent = readFileSync(absPath, 'utf-8');
      const rawParent = String(args.parent_node_path || 'root');
      let tscnParent: string;
      if (rawParent === 'root' || rawParent === '/root' || rawParent === '') {
        tscnParent = '.';
      } else {
        // Strip "root/" prefix if present, keep the rest as tscn parent path
        // 审查 N2(2026-09-17): 正则尾斜杠须必有——`/^\/?root\/?/` 会把 "rootFoo" 误剥成
        // "Foo"(裸前缀吃掉);纯 "root"/"/root" 已被上方特判覆盖,此处只需 "root/..." 形态。
        let cleaned = rawParent.replace(/^\/?root\//, '');
        // B2(反馈批次 B, 2026-09-09): 对齐 GD 链 _resolve_parent_node 的根名剥离链——
        // query_scene_tree 拷贝的 parent 路径含场景根名前缀("GetNewHeroContent/OkBtn"),
        // 而 .tscn parent 语义相对场景根不含根名;不剥则 findNodeSectionLine 找不到节点
        // (此前单发文本路径与 batch/GD 链行为分叉:同输入 batch 成功、单发报 not found)。
        // 根名取 root [node] 的 name 属性;缺失时 Godot 以场景文件名(去扩展名)为根名。
        const rootName = inferSceneRootName(tscnContent, sceneRelPath);
        if (rootName && (cleaned === rootName || cleaned.startsWith(rootName + '/'))) {
          cleaned = cleaned === rootName ? '' : cleaned.slice(rootName.length + 1);
        }
        tscnParent = cleaned || '.';
      }
      const result = addNode(tscnContent, {
        parent: tscnParent,
        name: String(args.node_name),
        type: String(args.node_type),
        properties: args.properties as Record<string, unknown> | undefined,
      });

      if (result.success && result.fallback) {
        // Unsupported property types — fall back to spawnGodot
        if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
        let godot: string;
        try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
        const fallbackParams: Record<string, unknown> = {
          scene_path: sceneRelPath,
          node_type: String(args.node_type),
          node_name: String(args.node_name),
          parent_node_path: String(args.parent_node_path || 'root'),
        };
        if (args.properties) fallbackParams.properties = args.properties;
        const spawnResult = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'add_node', JSON.stringify(fallbackParams)]);
        releaseShortRunningSlot();
        if (spawnResult.timedOut) return { content: [{ type: 'text', text: 'add_node timed out.' }], isError: true };
        if (spawnResult.exitCode === -1 && spawnResult.stdout.startsWith('SPAWN_FAILED:')) return opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${spawnResult.stdout.replace('SPAWN_FAILED: ', '')}`);
        if (spawnResult.exitCode !== 0) return { content: [{ type: 'text', text: `add_node failed (exit code ${spawnResult.exitCode}):\n${spawnResult.stdout}${spawnResult.stderr ? '\n' + spawnResult.stderr : ''}` }], isError: true };
        // 审查 C-1/I-A(2026-09-03): 成功路径也拼 stderr(headless 警告可见;对齐 :204 失败路径模式)
        return { content: [{ type: 'text', text: (spawnResult.stdout.trim() || 'add_node completed successfully.') + (spawnResult.stderr ? '\n' + spawnResult.stderr : '') }] };
      }

      if (!result.success) {
        return textResult(`Error: ${result.message}`);
      }

      // P1-2 FileGuard: 拒写插件自资产(commit 目标可能是 addons 内 .tscn)
      const selfGuardC = pluginSelfPathGuard(absPath);
      if (selfGuardC) return selfGuardC;
      // Write back the modified .tscn
      // A-ATOMIC (2026-09-01): 覆盖已存在的用户场景资产改走原子写(同目录 helpers.writeAtomic
      // 此前已 import 却漏用;直写中断=半写 .tscn 损坏用户场景)
      if (result.scene) {
        // B5(反馈批次 B): 落盘前回读 parse 自检——文本拼接产物的 node parent 链须逐段可达
        // (Godot 按文件序解析,断链节点加载即"Parent path has vanished"静默丢弃),
        // 损坏当场报错拒写而非静默成功(纵深防文本拼接的未知损坏形态)
        const verify = verifySceneTree(result.scene);
        if (!verify.ok) {
          return opsErrorResult('SCENE_SELF_CHECK_FAILED', `add_node produced an invalid scene, write blocked: ${verify.problem}`);
        }
        writeAtomic(absPath, result.scene);
      }
      // S1 (2026-06-23): BLOCKED_PROPS 命中时前置明确警告(避免"设 script 看似成功但未落盘"的静默失败)
      if (result.blockedProps && result.blockedProps.length > 0) {
        const hint = result.blockedProps.includes('script')
          ? ' For scripts use quick_scene script_path, or add an [ext_resource] + "script = ExtResource(...)" line via Write .tscn.'
          : '';
        return textResult(`⚠️ Blocked properties NOT written (security policy): ${result.blockedProps.join(', ')}.${hint}\n${result.message}`);
      }
      // Tier1-1: 成功路径补 structuredContent,让 AI 无需正则解析文本即可拿结构化数据
      return {
        ...textResult(result.message),
        structuredContent: {
          action: 'add_node',
          node_name: String(args.node_name),
          node_type: String(args.node_type),
          parent: String(args.parent_node_path || 'root'),
          scene_path: sceneRelPath,
          persisted: true,
        },
      };
    }

    case 'create_scene':
    case 'save_scene':
    case 'load_sprite': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string;
      try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }

      const params: Record<string, unknown> = {};
      if (action === 'create_scene') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        // 2026-07-12 CRITICAL RCE 复合链修复：root_node_type 补字符校验
        // 与 add_node:141 / batch_add_nodes:315 / quick_scene:257 对齐。
        // 堵特殊字符注入（shell 元字符 / 路径穿越透传到 godot_operations.gd）。
        const rootNodeType = String(args.root_node_type || 'Node2D');
        if (!/^[A-Za-z0-9_]+$/.test(rootNodeType)) {
          releaseShortRunningSlot();
          return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
        }
        params.root_node_type = rootNodeType;
        if (args.root_node_name) params.root_node_name = args.root_node_name;
      } else if (action === 'save_scene') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        if (args.new_path) { try { const np = normalizeUserProjectPath(String(args.new_path)); resolveWithinRoot(p, np); params.new_path = np; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'new_path contains path traversal'); } }
      } else if (action === 'load_sprite') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        const tp = String(args.texture_path);
        try { sanitizeResPath(tp, 'texture_path'); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'texture_path contains path traversal'); }
        params.texture_path = tp; params.node_path = args.node_path || 'root';
      }

      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, action, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return { content: [{ type: 'text', text: `${action} timed out.` }], isError: true };
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${result.stdout.replace('SPAWN_FAILED: ', '')}`);
      if (result.exitCode !== 0) return { content: [{ type: 'text', text: `${action} failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}` }], isError: true };
      return { content: [{ type: 'text', text: result.stdout.trim() || `${action} completed successfully.` }] };
    }

    case 'quick_scene': {
      const p = requireProjectPath(args);
      const rawScenePath = args.scene_path as string;
      if (!rawScenePath || !rawScenePath.trim()) return opsErrorResult('INVALID_PARAMS', 'scene_path is required for quick_scene');
      const sceneRelPath = normalizeUserProjectPath(rawScenePath);
      if (!sceneRelPath) return opsErrorResult('INVALID_PARAMS', 'scene_path is required for quick_scene');
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;
      if (!/^[A-Za-z0-9_]+$/.test(rootNodeType)) return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) { const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, ''); rootNodeName = baseName ? baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Root'; }
      if (!rootNodeName || !/^[A-Za-z0-9_]+$/.test(rootNodeName)) return textResult(`Error: root_node_name must match /^[A-Za-z0-9_]+$/, got: "${rootNodeName}"`);
      const sceneAbsPath = resolveWithinRoot(p, sceneRelPath);
      if (existsSync(sceneAbsPath)) return textResult(`Error: Scene already exists: ${sceneRelPath}. Remove it first or use a different path.`);
      let tscnContent: string;
      if (scriptRelPath) { tscnContent = ['[gd_scene load_steps=2 format=3]', '', `[ext_resource type="Script" path="res://${scriptRelPath.replace(/\\/g, '/')}" id="1"]`, '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, 'script = ExtResource("1")', ''].join('\n'); }
      else { tscnContent = ['[gd_scene format=3]', '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, ''].join('\n'); }
      // B-1 (SEC-P1-1): quick_scene scriptContent 写 .gd 前过沙箱扫描(此前裸 writeFileSync 绕过,
      // tscn 绑 ExtResource → 编辑器打开/run_project 即执行)。仅在确实要写脚本时扫(已存在则内容不落盘)。
      if (scriptRelPath && scriptContent && !existsSync(resolveWithinRoot(p, scriptRelPath))) {
        const sandboxGuard = scanScriptSandboxOrThrow(scriptContent, resolveWithinRoot(p, scriptRelPath));
        if (sandboxGuard) return sandboxGuard;
      }
      // P1-2 FileGuard: quick_scene 的场景与脚本写点拒插件自资产
      const selfGuardQ1 = pluginSelfPathGuard(sceneAbsPath);
      if (selfGuardQ1) return selfGuardQ1;
      if (scriptRelPath && scriptContent) {
        const selfGuardQ2 = pluginSelfPathGuard(resolveWithinRoot(p, scriptRelPath));
        if (selfGuardQ2) return selfGuardQ2;
      }
      // A-ATOMIC (2026-09-01): 新建场景/脚本走原子写(直写中断=半写 .tscn/.gd 损坏用户资产)
      try { ensureDir(sceneAbsPath); writeAtomic(sceneAbsPath, tscnContent); } catch (e: unknown) { return textResult(`Error writing scene: ${(e as Error).message}`); }
      if (scriptRelPath && scriptContent) { const scriptAbsPath = resolveWithinRoot(p, scriptRelPath); if (!existsSync(scriptAbsPath)) { try { ensureDir(scriptAbsPath); writeAtomic(scriptAbsPath, scriptContent); } catch (e: unknown) { return textResult(`Scene created but script write failed: ${(e as Error).message}`); } } }
      const parts = [`Created scene: ${sceneRelPath}`, `Root: ${rootNodeName} [${rootNodeType}]`];
      if (scriptRelPath) parts.push(`Script: res://${scriptRelPath.replace(/\\/g, '/')}`);
      if (scriptRelPath && scriptContent) parts.push(`Script file created`);
      return textResult(parts.join('\n'));
    }

    case 'query_scene_tree': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const treeScript = join(scriptsDir, 'query_scene_tree.gd');
      if (!existsSync(treeScript)) { releaseShortRunningSlot(); return textResult(`Error: query_scene_tree.gd not found at ${treeScript}`); }
      const _snapScenePath = normalizeUserProjectPath(args.scene_path as string);
      // M-3: 校验 scene_path 在项目内（防 ../ 逃逸读项目外 .tscn；inspect_node.gd 只补 res:// 前缀不防穿越）
      try { resolveWithinRoot(p, _snapScenePath); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
      const params = { scene_path: _snapScenePath, max_depth: (args.max_depth as number) || 5 };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', treeScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('query_scene_tree timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'inspect_node': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const inspectScript = join(scriptsDir, 'inspect_node.gd');
      if (!existsSync(inspectScript)) { releaseShortRunningSlot(); return textResult(`Error: inspect_node.gd not found at ${inspectScript}`); }
      const _inspScenePath = normalizeUserProjectPath(args.scene_path as string);
      // M-3: 校验 scene_path 在项目内（防 ../ 逃逸读项目外 .tscn；inspect_node.gd 只补 res:// 前缀不防穿越）
      try { resolveWithinRoot(p, _inspScenePath); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
      const params = { scene_path: _inspScenePath, node_path: args.node_path || 'root', max_depth: (args.max_depth as number) || 3, include_signals: args.include_signals !== false, include_properties: args.include_properties !== false };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', inspectScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('inspect_node timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'batch_add_nodes': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const scenePath = normalizeUserProjectPath(args.scene_path as string);
      const nodes = args.nodes as Array<{ node_type: string; node_name: string; parent_node_path?: string; properties?: Record<string, unknown> }>;
      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) { releaseShortRunningSlot(); return opsErrorResult('INVALID_PARAMS', '"nodes" must be a non-empty array of node definitions.'); }
      if (nodes.length > 100) { releaseShortRunningSlot(); return textResult(`Error: Too many nodes (${nodes.length}). Maximum: 100`); }
      // 审查 L-3(2026-09-03): node_name 黑名单补 \r\n\t + parent_node_path 补控制字符校验——
      // GD Node.name 原样保留控制字符(真机实证),随 print/failed 清单拼进 stdout 可伪造 [ERROR]/
      // 成功行(展示层注入);判定层不受影响(exitCode 不可由 stdout 驱动)。parent_node_path 合法
      // 字符含 / . @ 等,仅拦控制字符。
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]!; if (!n.node_type || !/^[A-Za-z0-9_]+$/.test(String(n.node_type))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_type contains invalid characters: "${n.node_type}"`); } if (!n.node_name || /[\]["/:\\\r\n\t]/.test(String(n.node_name))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_name contains invalid characters: "${n.node_name}"`); } if (n.parent_node_path !== undefined && /[\r\n\t]/.test(String(n.parent_node_path))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].parent_node_path contains control characters (CR/LF/tab)`); } }
      // P1-2 (2026-07-19 spec editor-version-tear §6): editor 场景写守卫——batch_add_nodes fallback headless
      // 路径(若该场景在 editor 打开, headless 改盘会被 editor GUI save 覆盖回旧版)。此 case 无 try/finally,
      // 守卫 return 前手动 releaseShortRunningSlot(否则 slot 泄漏)。acquire 已在 :317 完成。
      const absPath = resolveWithinRoot(p, scenePath);
      if (!existsSync(absPath)) { releaseShortRunningSlot(); return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${scenePath}`); }
      if (ctx.checkEditorSceneSave) {
        const sceneGuard = await ctx.checkEditorSceneSave(absPath);
        if (sceneGuard.blocked) { releaseShortRunningSlot(); return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`); }
      }
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'batch_add_nodes', JSON.stringify({ scene_path: scenePath, nodes })]);
      releaseShortRunningSlot();
      if (result.timedOut) return errorResult('batch_add_nodes timed out after 60s.');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
      if (result.exitCode !== 0) return errorResult(`batch_add_nodes failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}`); // 审查 I-A: GD log_error 走 stderr,不拼则 per-node 失败清单不可见
      // 审查 M-2(2026-09-03): 原 BLOCKED_PROPS 前置收集+成功路径警告分支不可达已删——blocked 属性
      // 在 GD 侧 _is_safe_property 拒 → 整节点失败 → exit 1 → 上方 exitCode!==0 的 error 路径(含
      // stderr 详情)先返回;错误比警告更严格,行为不变。GD 清单(BLOCKED_PROPERTIES)较 TS
      // (BLOCKED_PROPS)多拦 4 项属纵深防御,清单不强行统一(I-A 后 stderr 误拒详情已可见)。
      return { content: [{ type: 'text', text: result.stdout.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] };
    }

    case 'edit_node': {
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args);
        const scenePath = normalizeUserProjectPath(args.scene_path as string);
        // P1-2 (2026-07-19 spec editor-version-tear §6): editor 场景写守卫——edit_node fallback headless
        // 路径(若该场景在 editor 打开, headless 改盘会被 editor GUI save 覆盖回旧版)。守卫在 try 块内,
        // return 依赖 finally 的 releaseShortRunningSlot,此处不手动 release(否则 double-release)。
        const absPath = resolveWithinRoot(p, scenePath);
        if (!existsSync(absPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${scenePath}`);
        if (ctx.checkEditorSceneSave) {
          const sceneGuard = await ctx.checkEditorSceneSave(absPath);
          if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
        }
        const nodePath = normalizeNodePath(args.node_path as string);
        const properties = args.properties as Record<string, unknown>;
        if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return opsErrorResult('INVALID_PARAMS', '"properties" must be a non-empty object.');
        // 审查 M-2(2026-09-03): 原 BLOCKED_PROPS 前置收集+成功路径警告分支不可达已删——blocked 属性
        // 在 GD 侧 _is_safe_property 拒 → failed → exit 1 → 下方 exitCode!==0 的 error 路径先返回。
        let godot: string;
        try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
        const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'edit_node', JSON.stringify({ scene_path: scenePath, node_path: nodePath, properties })]);
        releaseShortRunningSlot();
        if (result.timedOut) return errorResult('edit_node timed out after 60s.');
        if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
        if (result.exitCode !== 0) return errorResult(`edit_node failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}`); // 审查 I-A: 补 stderr(Node not found 等错误详情)
        return { content: [{ type: 'text', text: result.stdout.trim() || `edit_node completed.` }] };
      } finally { releaseShortRunningSlot(); }
    }

    case 'remove_node': {
      // 反馈 2026-08-27/08-30 (CardGame2): 原内联脚本只改内存(无 pack+save)→success 假象
      // 不落盘;queue_free 悬置致 exit 1。迁 godot_operations.gd remove_node 持久化链,
      // 对齐 edit_node 的 spawnGodot+opsScript 模式(含 editor 场景写守卫)。
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args);
        const scenePath = normalizeUserProjectPath(args.scene_path as string);
        const absPath = resolveWithinRoot(p, scenePath);
        if (!existsSync(absPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${scenePath}`);
        if (ctx.checkEditorSceneSave) {
          const sceneGuard = await ctx.checkEditorSceneSave(absPath);
          if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
        }
        const nodePath = normalizeNodePath(args.node_path as string);
        let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
        const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'remove_node', JSON.stringify({ scene_path: scenePath, node_path: nodePath })]);
        releaseShortRunningSlot();
        if (result.timedOut) return errorResult('remove_node timed out after 60s.');
        if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
        if (result.exitCode !== 0) return errorResult(`remove_node failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}`); // 审查 I-A: 补 stderr(Node not found 等错误详情)
        return { content: [{ type: 'text', text: result.stdout.trim() || `Node removed from ${scenePath}.` }] };
      } finally { releaseShortRunningSlot(); }
    }

    case 'instance_scene': return handleInstanceScene(args, ctx);
    case 'set_instance_property': return handleSetInstanceProperty(args, ctx);
    case 'detach_instance': return handleDetachInstance(args);

    case 'open_scene': {
      // editor-only：editor 模式由 editor-method-map 提前拦截走 command_handler.handle_open_scene，
      // headless 无 EditorInterface（无"活动场景"概念）→ 返 EDITOR_ONLY（与 asset 写工具惯例一致）
      return opsErrorResult('EDITOR_ONLY', 'open_scene requires editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.');
    }

    case 'health_check': {
      const p = requireProjectPath(args); const scenePath = args.scene_path as string;
      if (!scenePath || typeof scenePath !== 'string') return opsErrorResult('INVALID_PARAMS', 'scene_path is required for health_check', { suggestion: 'Provide the scene file path relative to project, e.g. "scenes/main.tscn"' });
      const fullPath = resolveWithinRoot(p, scenePath); if (!existsSync(fullPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene not found: ${scenePath}`);
      const result = checkSceneHealth(readFileSync(fullPath, 'utf-8'), scenePath);
      return textResult(JSON.stringify({ scene: scenePath, healthy: result.issues.length === 0, issue_count: result.issues.length, issues: result.issues, nodes_checked: result.nodesChecked }, null, 2));
    }

    case 'merge_scene': {
      const p = requireProjectPath(args); const sceneA = args.scene_path as string; const sceneB = args.new_path as string;
      if (!sceneA || !sceneB) return opsErrorResult('INVALID_PARAMS', 'Both scene_path (ours) and new_path (theirs) are required', { suggestion: 'Provide two scene file paths: scene_path=ours.tscn new_path=theirs.tscn' });
      const fullPathA = resolveWithinRoot(p, sceneA); const fullPathB = resolveWithinRoot(p, sceneB);
      if (!existsSync(fullPathA)) return opsErrorResult('FILE_NOT_FOUND', `Scene A not found: ${sceneA}`);
      if (!existsSync(fullPathB)) return opsErrorResult('FILE_NOT_FOUND', `Scene B not found: ${sceneB}`);
      const MAX = 10 * 1024 * 1024; const statA = statSync(fullPathA); const statB = statSync(fullPathB);
      if (statA.size > MAX || statB.size > MAX) return opsErrorResult('FILE_TOO_LARGE', `Scene file exceeds 10MB merge limit (A: ${statA.size}B, B: ${statB.size}B)`);
      const ours = readFileSync(fullPathA, 'utf-8'); const theirs = readFileSync(fullPathB, 'utf-8');
      writeAtomic(fullPathA, mergeTscn(ours, theirs));
      return textResult(JSON.stringify({ merged_into: sceneA, source: sceneB, status: 'ok' }, null, 2));
    }

    case 'create_3d_node':
      return handleCreate3dNode(args, ctx);
    case 'commit':
      return handleCommitAction(args, ctx);

    default: return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
  // Unreachable for well-formed action strings, but satisfies TS control flow
  return null;
}


export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  scene: {
    readonly: false,
    long_running: true,
    actionRisks: {
      read_scene: 'read', query_scene_tree: 'read', inspect_node: 'read', health_check: 'read',
      create_scene: 'write', quick_scene: 'write', add_node: 'write', batch_add_nodes: 'write',
      edit_node: 'write', save_scene: 'write', load_sprite: 'write', instance_scene: 'write',
      set_instance_property: 'write', detach_instance: 'write', create_3d_node: 'write', commit: 'write',
      open_scene: 'write',
      remove_node: 'destructive', merge_scene: 'destructive',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
