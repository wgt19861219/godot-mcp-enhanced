// Scene instance operations: instance_scene, set_instance_property, detach_instance.

import { existsSync, readFileSync } from 'fs';
import { writeFileAtomic } from '../../core/fs-atomic.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { findInstanceNode, detachInstance, nodePathToNameAndParent } from '../../tscn/tscn-editor.js';
import { executeGdscriptRuntime as executeGdscript } from '../../gdscript-executor.js';
import { normalizeNodePath, gdEscape, escapeForGdLiteral, toSnakeCase, SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult } from '../shared.js';
import { gdScriptSetLine, TRY_SET_HELPER } from './helpers.js';
import { BLOCKED_PROPS } from '../../core/shared/blocked-props.js';

// A3 (2026-07-13 enhanced-vs-godogen 对比测试核实): instance_scene/set_instance_property 此前
// 只做运行时 add_child/改属性就 _mcp_done(), 无 pack+save 回写 .tscn → 进程退出实例丢失,
// set_instance_property 的 target.owner==root 检查恒 false → NODE_NOT_INSTANCE。此 block 对齐
// add_node(godot_operations.gd:308-321) 与 scene-commit.ts:118: pack 场景根(_mcp_scene_instance)
// 并 ResourceSaver.save 到 scenePath, 失败回 error 终止。无尾随换行(调用处前置 \n)。
function persistSceneBlock(scenePath: string): string {
  const sp = escapeForGdLiteral(scenePath);
  return [
    '\tvar _packed = PackedScene.new()',
    '\tvar _pack_err = _packed.pack(_mcp_scene_instance)',
    '\tif _pack_err != OK:',
    '\t\t_mcp_output("error", "Failed to pack scene: " + str(_pack_err))',
    '\t\t_mcp_done()',
    '\t\treturn',
    '\tvar _full := "' + sp + '"',
    '\tvar _ext := _full.get_extension()',
    '\tvar _tmp := _full + ".tmp." + _ext',
    '\tif FileAccess.file_exists(_tmp):',
    '\t\tDirAccess.remove_absolute(_tmp)',
    '\tvar _save_err := ResourceSaver.save(_packed, _tmp)',
    '\tif _save_err != OK:',
    '\t\tDirAccess.remove_absolute(_tmp)',
    '\t\t_mcp_output("error", "Failed to save scene: " + str(_save_err))',
    '\t\t_mcp_done()',
    '\t\treturn',
    '\tvar _ren := DirAccess.rename_absolute(_tmp, _full)',
    '\tif _ren != OK:',
    '\t\tDirAccess.remove_absolute(_tmp)',
    '\t\t_mcp_output("error", "Failed to rename tmp: " + str(_ren))',
    '\t\t_mcp_done()',
    '\t\treturn',
  ].join('\n');
}

export async function handleInstanceScene(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.instance_path) return opsErrorResult('MISSING_PARAM', 'instance_path is required');

  const p = requireProjectPath(args);
  const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));
  const instancePath = String(args.instance_path);

  if (!instancePath.endsWith('.tscn') || !/^res:\/\/[a-zA-Z0-9_\-/.]+\.tscn$/.test(instancePath)) {
    return opsErrorResult('INVALID_PARAM', 'instance_path must be a valid res:// path ending in .tscn');
  }

  const instancePathResolved = resolveWithinRoot(p, normalizeUserProjectPath(instancePath));
  if (scenePath === instancePathResolved) {
    return opsErrorResult('CIRCULAR_REFERENCE', 'CIRCULAR: scene_path and instance_path must not be the same');
  }

  const parentNodePath = normalizeNodePath((args.parent_node_path as string) || 'root');
  const nodeName = args.node_name ? String(args.node_name) : '';

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
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar _scene_res = load("${escapeForGdLiteral(instancePath)}")
\tif _scene_res == null:
\t\t_mcp_output("error", "Failed to load instance: ${escapeForGdLiteral(instancePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_scene_res is PackedScene):
\t\t_mcp_output("error", "Resource is not a PackedScene: ${escapeForGdLiteral(instancePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _inst = _scene_res.instantiate()
\tif _inst == null:
\t\t_mcp_output("error", "Failed to instantiate: ${escapeForGdLiteral(instancePath)}")
\t\t_mcp_done()
\t\treturn${nameLine}${propLines}
\tvar _parent = _mcp_get_scene_node("${escapeForGdLiteral(parentNodePath)}")
\tif _parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentNodePath)}")
\t\t_mcp_done()
\t\treturn
\t_parent.add_child(_inst, true)
\t_inst.owner = _mcp_scene_instance
${persistSceneBlock(scenePath)}
\t_mcp_output("instanced", {
\t\t"node_name": str(_inst.name),
\t\t"node_type": _inst.get_class(),
\t\t"instance_of": "${escapeForGdLiteral(instancePath)}",
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

export async function handleSetInstanceProperty(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
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

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(propName)) {
    return opsErrorResult('INVALID_PARAM', `Invalid property name: "${rawPropName}"`);
  }
  if (BLOCKED_PROPS.has(propName)) {
    return opsErrorResult('BLOCKED_PROP', `Property "${propName}" is not allowed`);
  }

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
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar target = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif target == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_scene_instance
\tvar is_instance = (target != root and target.owner == root)
\tif not is_instance:
\t\t_mcp_output("error", "NODE_NOT_INSTANCE: node '${escapeForGdLiteral(nodePath)}' is not an instanced scene child")
\t\t_mcp_done()
\t\treturn
\t${propLine}
${persistSceneBlock(scenePath)}
\t_mcp_output("set_property", {"node": "${escapeForGdLiteral(nodePath)}", "property": "${gdEscape(propName)}"})
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

export function handleDetachInstance(args: Record<string, unknown>): ToolResult {
  if (!args.project_path) return opsErrorResult('MISSING_PARAM', 'project_path is required');
  if (!args.scene_path) return opsErrorResult('MISSING_PARAM', 'scene_path is required');
  if (!args.node_path) return opsErrorResult('MISSING_PARAM', 'node_path is required');

  const p = requireProjectPath(args);
  const sceneAbsPath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string));

  if (!existsSync(sceneAbsPath)) {
    return textResult(`Error: Scene file not found: ${sceneAbsPath}`);
  }

  let nodeName: string;
  let tscnParent: string;
  try {
    const parsed = nodePathToNameAndParent(String(args.node_path));
    nodeName = parsed.nodeName;
    tscnParent = parsed.parent;
  } catch (e: unknown) {
    return opsErrorResult('INVALID_PARAM', (e as Error).message);
  }

  let targetContent: string;
  try {
    targetContent = readFileSync(sceneAbsPath, 'utf-8');
  } catch (e: unknown) {
    return textResult(`Error reading scene: ${(e as Error).message}`);
  }

  const info = findInstanceNode(targetContent, nodeName, tscnParent);
  if (!info) {
    return opsErrorResult('NOT_AN_INSTANCE', `Node "${nodeName}" (parent: "${tscnParent}") is not an instance or not found`);
  }

  const sourceRel = info.sourcePath.replace(/^res:\/\//, '');
  // I-7: 显式预校验源场景路径不含 .. (纵深防御;resolveWithinRoot 已兜底,此处的显式检查
  // 让恶意/损坏的 .tscn ext_resource 在更早阶段被拒绝,错误信息更明确)
  if (sourceRel.split(/[/\\]/).includes('..')) {
    return textResult(`Error: Source scene path must not escape project root: ${info.sourcePath}`);
  }
  const sourceAbsPath = resolveWithinRoot(p, sourceRel);
  if (!existsSync(sourceAbsPath)) {
    return textResult(`Error: Source scene not found: ${info.sourcePath} (${sourceAbsPath})`);
  }

  let sourceContent: string;
  try {
    sourceContent = readFileSync(sourceAbsPath, 'utf-8');
  } catch (e: unknown) {
    return textResult(`Error reading source scene: ${(e as Error).message}`);
  }

  let result: string;
  try {
    result = detachInstance(targetContent, sourceContent, nodeName, tscnParent);
  } catch (e: unknown) {
    return textResult(`Error detaching instance: ${(e as Error).message}`);
  }

  try {
    // A-ATOMIC 存量收口:覆盖用户 .tscn 走共享原子写(降级/清理在 core 统一处理)
    writeFileAtomic(sceneAbsPath, result);
  } catch (e: unknown) {
    return textResult(`Error writing scene: ${(e as Error).message}`);
  }

  return textResult(`Detached instance "${nodeName}" — inlined from ${info.sourcePath} (${info.propertyOverrides.length} property override(s) preserved)`);
}
