import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, appendRuntimePersistWarning } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const TILEMAP_ERROR_CODES = {
  TILEMAP_NOT_FOUND: 'TILEMAP_NOT_FOUND',
  INVALID_TILE_COORDS: 'INVALID_TILE_COORDS',
  INVALID_REGION: 'INVALID_REGION',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

// ─── Helper Utilities ─────────────────────────────────────────────────────

export function validateCoords(v: unknown): { x: number; y: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Coords must be an object with x, y integer fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y']) {
    if (typeof obj[key] !== 'number' || !Number.isInteger(obj[key] as number)) {
      throw new Error(`Coords field "${key}" must be an integer`);
    }
  }
  return { x: obj.x as number, y: obj.y as number };
}

export function validateRect2i(v: unknown): { x: number; y: number; w: number; h: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Region must be an object with x, y, w, h integer fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y', 'w', 'h']) {
    if (typeof obj[key] !== 'number' || !Number.isInteger(obj[key] as number)) {
      throw new Error(`Region field "${key}" must be an integer`);
    }
  }
  const w = obj.w as number;
  const h = obj.h as number;
  if (w <= 0) throw new Error('Region w must be > 0');
  if (h <= 0) throw new Error('Region h must be > 0');
  return { x: obj.x as number, y: obj.y as number, w, h };
}

// ─── Shared TileMap/TileMapLayer Helpers ─────────────────────────────────────

/** TileMap API prefix arg for layer: "0, " etc. TileMapLayer uses no layer arg. */
function layerArg(layer: number | undefined): string {
  return layer !== undefined ? `${layer}, ` : '0, ';
}

/**
 * Generate the scene-load + node-fetch + null-check preamble.
 *
 * With `scenePath`, the named scene is instantiated and the node is resolved
 * inside it (`_mcp_get_scene_node` strips the `root/` prefix and the scene root
 * name). Without it, behaviour is unchanged: the project's main scene is loaded
 * and the node is looked up from the tree root.
 */
function scenePreamble(nodePath: string, scenePath?: string): string {
  const fetch = scenePath
    ? `\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")`
    : `\tvar node = _mcp_get_node("${gdEscape(nodePath)}")`;
  const load = scenePath
    ? `\tif not _mcp_load_scene("${gdEscape(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn`
    : '\t_mcp_load_main_scene()';
  return `${load}\n${fetch}\n\tif node == null:\n\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")\n\t\t_mcp_done()\n\t\treturn`;
}

/** Generate `if TileMap: ... elif TileMapLayer: ... else: error` branch with early-return on else. */
function tilemapBranch(tileMapBody: string, layerBody: string, returnOnError = true): string {
  const elseBlock = returnOnError
    ? '\t\t_mcp_output("error", "Not a TileMap or TileMapLayer: " + node.get_class())\n\t\t_mcp_done()\n\t\treturn'
    : '\t\t_mcp_output("error", "Not a TileMap or TileMapLayer: " + node.get_class())';
  // Ensure each body ends with \n so elif/else starts on its own line
  const tmBody = tileMapBody.endsWith('\n') ? tileMapBody : tileMapBody + '\n';
  const lyBody = layerBody.endsWith('\n') ? layerBody : layerBody + '\n';
  return `\tif node.get_class() == "TileMap":\n${tmBody}\telif node.get_class() == "TileMapLayer":\n${lyBody}\telse:\n${elseBlock}`;
}

/** Generate a single API call that differs only by the layer prefix arg. */
function tilemapCall(method: string, args: string, layer: number | undefined): string {
  const la = layerArg(layer);
  return tilemapBranch(
    `\t\tnode.${method}(${la}${args})\n`,
    `\t\tnode.${method}(${args})\n`,
    false,
  );
}

// ─── GDScript Generators: TileMap ──────────────────────────────────────────

export function genTilemapReadScript(
  nodePath: string, region?: { x: number; y: number; w: number; h: number }, layer?: number,
  scenePath?: string
): string {
  const la = layerArg(layer);

  if (region) {
    const readCellBody = (prefix: string) =>
      `\t\tvar cells = []\n\t\tfor cy in range(${region.y}, ${region.y + region.h}):\n\t\t\tfor cx in range(${region.x}, ${region.x + region.w}):\n\t\t\t\tvar sid = node.get_cell_source_id(${prefix}Vector2i(cx, cy))\n\t\t\t\tif sid >= 0:\n\t\t\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}Vector2i(cx, cy))\n\t\t\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}Vector2i(cx, cy))\n\t\t\t\t\tcells.append({"coords": [cx, cy], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n\t\t_mcp_output("cells", cells)`;

    return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
${tilemapBranch(readCellBody(la), readCellBody(''))}
\t_mcp_done()
`;
  }

  const readUsedBody = (prefix: string) =>
    `\t\tvar used = node.get_used_cells(${prefix.trim().replace(/,\s*$/, '')})\n\t\tvar cells = []\n\t\tfor c in used:\n\t\t\tvar sid = node.get_cell_source_id(${prefix}c)\n\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}c)\n\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}c)\n\t\t\tcells.append({"coords": [c.x, c.y], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n\t\t_mcp_output("cells", cells)`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
${tilemapBranch(readUsedBody(la), readUsedBody(''))}
\t_mcp_done()
`;
}

export function genTilemapSetCellScript(
  nodePath: string, coords: { x: number; y: number },
  sourceId: number, atlasCoords: { x: number; y: number },
  alternativeTile: number, layer?: number, scenePath?: string
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar coords = Vector2i(${coords.x}, ${coords.y})
\tvar atlas = Vector2i(${atlasCoords.x}, ${atlasCoords.y})
${tilemapCall('set_cell', `coords, ${sourceId}, atlas, ${alternativeTile}`, layer)}
\t_mcp_output("set", {"coords": [${coords.x}, ${coords.y}], "source_id": ${sourceId}})
\t_mcp_done()
`;
}

export function genTilemapEraseCellScript(
  nodePath: string, coords: { x: number; y: number }, layer?: number, scenePath?: string
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar coords = Vector2i(${coords.x}, ${coords.y})
${tilemapCall('erase_cell', 'coords', layer)}
\t_mcp_output("erased", {"coords": [${coords.x}, ${coords.y}]})
\t_mcp_done()
`;
}

export function genTilemapFillRectScript(
  nodePath: string, region: { x: number; y: number; w: number; h: number },
  sourceId: number, atlasCoords: { x: number; y: number },
  alternativeTile: number, layer?: number, scenePath?: string
): string {
  const la = layerArg(layer);
  const fillBody = (prefix: string) =>
    `\t\tfor cy in range(${region.h}):\n\t\t\tfor cx in range(${region.w}):\n\t\t\t\tnode.set_cell(${prefix}Vector2i(${region.x} + cx, ${region.y} + cy), ${sourceId}, atlas, ${alternativeTile})\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar atlas = Vector2i(${atlasCoords.x}, ${atlasCoords.y})
${tilemapBranch(fillBody(la), fillBody(''))}
\t_mcp_output("filled", {"region": {"x": ${region.x}, "y": ${region.y}, "w": ${region.w}, "h": ${region.h}}, "source_id": ${sourceId}})
\t_mcp_done()
`;
}

export function genTilemapClearScript(
  nodePath: string, layer?: number, clearAll?: boolean, scenePath?: string
): string {
  const tileMapClear = clearAll ? '\t\tnode.clear()' : `\t\tnode.clear_layer(${layer ?? 0})`;
  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
${tilemapBranch(`${tileMapClear}\n`, '\t\tnode.clear()\n')}
\t_mcp_output("cleared", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genTilemapCopyScript(
  nodePath: string, sourceRegion: { x: number; y: number; w: number; h: number }, layer?: number,
  scenePath?: string
): string {
  const la = layerArg(layer);
  const copyBody = (prefix: string) =>
    `\t\tfor cy in range(${sourceRegion.h}):\n\t\t\tfor cx in range(${sourceRegion.w}):\n\t\t\t\tvar c = Vector2i(${sourceRegion.x} + cx, ${sourceRegion.y} + cy)\n\t\t\t\tvar sid = node.get_cell_source_id(${prefix}c)\n\t\t\t\tif sid >= 0:\n\t\t\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}c)\n\t\t\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}c)\n\t\t\t\t\tcells.append({"coords": [cx, cy], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar cells = []
${tilemapBranch(copyBody(la), copyBody(''))}
\t_mcp_output("pattern", {"cells": cells, "size": {"w": ${sourceRegion.w}, "h": ${sourceRegion.h}}})
\t_mcp_done()
`;
}

export function genTilemapPasteScript(
  nodePath: string, targetCoords: { x: number; y: number },
  pattern: { cells: Array<{ coords: [number, number]; source_id: number; atlas_coords: [number, number]; alternative_tile: number }>; size: { w: number; h: number } },
  layer?: number, scenePath?: string
): string {
  const patternJson = JSON.stringify(pattern);
  const la = layerArg(layer);
  const pasteBody = (prefix: string) =>
    `\t\tfor cell in pattern["cells"]:\n\t\t\tvar cx = cell["coords"][0] + tx\n\t\t\tvar cy = cell["coords"][1] + ty\n\t\t\tnode.set_cell(${prefix}Vector2i(cx, cy), cell["source_id"], Vector2i(cell["atlas_coords"][0], cell["atlas_coords"][1]), cell["alternative_tile"])\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar pattern = JSON.parse_string("${gdEscape(patternJson)}")
\tvar tx = ${targetCoords.x}
\tvar ty = ${targetCoords.y}
${tilemapBranch(pasteBody(la), pasteBody(''))}
\t_mcp_output("pasted", {"target": [tx, ty], "cell_count": pattern["cells"].size()})
\t_mcp_done()
`;
}

export function genTilemapSetTransformScript(
  nodePath: string, coords: { x: number; y: number },
  flipH: boolean, flipV: boolean, transpose: boolean, layer?: number, scenePath?: string
): string {
  const la = layerArg(layer);
  const readTileBody = (prefix: string) =>
    `\t\tsid = node.get_cell_source_id(${prefix}c)\n\t\tif sid < 0:\n\t\t\t_mcp_output("error", "No tile at coords")\n\t\t\t_mcp_done()\n\t\t\treturn\n\t\tac = node.get_cell_atlas_coords(${prefix}c)\n\t\talt = node.get_cell_alternative_tile(${prefix}c)\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${scenePreamble(nodePath, scenePath)}
\tvar c = Vector2i(${coords.x}, ${coords.y})
\tvar sid: int = -1
\tvar ac: Vector2i = Vector2i(0, 0)
\tvar alt: int = 0
${tilemapBranch(readTileBody(la), readTileBody(''))}
\tvar base_alt = alt & ~7
\tvar new_alt = base_alt
\tif ${flipH}:
\t\tnew_alt = new_alt | 1
\tif ${flipV}:
\t\tnew_alt = new_alt | 2
\tif ${transpose}:
\t\tnew_alt = new_alt | 4
${tilemapCall('set_cell', 'c, sid, ac, new_alt', layer)}
\t_mcp_output("transform_set", {"coords": [${coords.x}, ${coords.y}], "flip_h": ${flipH}, "flip_v": ${flipV}, "transpose": ${transpose}, "alternative_tile": new_alt})
\t_mcp_done()
`;
}

// ─── Tool Registration ──────────────────────────────────────────────────────

const ACTIONS = [
  'tilemap_read', 'tilemap_set_cell', 'tilemap_erase_cell', 'tilemap_fill_rect',
  'tilemap_clear', 'tilemap_copy', 'tilemap_paste', 'tilemap_set_transform',
] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'tilemap',
      description: `TileMap/TileMapLayer 图块操作。读取: tilemap_read, tilemap_copy。写入: tilemap_set_cell, tilemap_erase_cell, tilemap_fill_rect, tilemap_clear, tilemap_paste, tilemap_set_transform。传 scene_path 可对任意场景操作，省略则用主场景。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径（如 root/Level/TileMap）；配合 scene_path 时相对该场景解析，可省略 root/ 前缀和场景根节点名' },
          scene_path: { type: 'string', description: '目标场景路径（相对项目路径，可选）。不传则加载 application/run/main_scene——主场景是菜单时其中不含 TileMap，会返回 TILEMAP_NOT_FOUND' },
          layer: { type: 'number', description: '图层索引（可选，默认 0）。tilemap_read/set_cell/erase_cell/fill_rect/copy/paste/set_transform 使用；tilemap_clear 不传则清除所有图层' },
          region: {
            type: 'object',
            description: '矩形区域 Rect2i。tilemap_read: 读取区域（可选，不传则读取全部已用图块）；tilemap_fill_rect: 填充区域',
            properties: {
              x: { type: 'number', description: '起始 X 坐标' },
              y: { type: 'number', description: '起始 Y 坐标' },
              w: { type: 'number', description: '宽度（必须 > 0）' },
              h: { type: 'number', description: '高度（必须 > 0）' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          source_region: {
            type: 'object',
            description: '源区域 Rect2i。tilemap_copy 使用',
            properties: {
              x: { type: 'number', description: '起始 X 坐标' },
              y: { type: 'number', description: '起始 Y 坐标' },
              w: { type: 'number', description: '宽度（必须 > 0）' },
              h: { type: 'number', description: '高度（必须 > 0）' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          coords: {
            type: 'object',
            description: '图块坐标 Vector2i。tilemap_set_cell/erase_cell/set_transform 使用',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          source_id: { type: 'number', description: 'TileSet 源 ID。tilemap_set_cell/fill_rect 使用' },
          atlas_coords: {
            type: 'object',
            description: '图集坐标 Vector2i。tilemap_set_cell/fill_rect 使用',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          alternative_tile: { type: 'number', description: '替代图块索引（可选，默认 0）。tilemap_set_cell/fill_rect 使用' },
          target: {
            type: 'object',
            description: '粘贴目标坐标 Vector2i。tilemap_paste 使用',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          pattern: {
            type: 'object',
            description: '图块图案（由 tilemap_copy 返回的 pattern 对象）。tilemap_paste 使用',
            properties: {
              cells: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    coords: { type: 'array', items: { type: 'number' } },
                    source_id: { type: 'number' },
                    atlas_coords: { type: 'array', items: { type: 'number' } },
                    alternative_tile: { type: 'number' },
                  },
                },
              },
              size: {
                type: 'object',
                properties: { w: { type: 'number' }, h: { type: 'number' } },
              },
            },
          },
          flip_h: { type: 'boolean', description: '水平翻转（可选，默认 false）。tilemap_set_transform 使用' },
          flip_v: { type: 'boolean', description: '垂直翻转（可选，默认 false）。tilemap_set_transform 使用' },
          transpose: { type: 'boolean', description: '转置（可选，默认 false）。tilemap_set_transform 使用' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
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
  if (name !== 'tilemap') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    // Optional target scene. Omitted → main scene, preserving the previous behaviour.
    const scenePath = args.scene_path
      ? resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string))
      : undefined;
    let script: string;

    switch (action) {
      case 'tilemap_read': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const layer = args.layer as number | undefined;
        const region = args.region ? validateRect2i(args.region) : undefined;
        script = genTilemapReadScript(nodePath, region, layer, scenePath);
        break;
      }
      case 'tilemap_set_cell': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const coords = validateCoords(args.coords);
        const sourceId = args.source_id as number;
        if (typeof sourceId !== 'number' || !Number.isInteger(sourceId)) {
          return opsErrorResult('INVALID_TILE_COORDS', 'source_id must be an integer');
        }
        const atlasCoords = validateCoords(args.atlas_coords);
        const alternativeTile = (args.alternative_tile as number) ?? 0;
        const layer = args.layer as number | undefined;
        script = genTilemapSetCellScript(nodePath, coords, sourceId, atlasCoords, alternativeTile, layer, scenePath);
        break;
      }
      case 'tilemap_erase_cell': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const coords = validateCoords(args.coords);
        const layer = args.layer as number | undefined;
        script = genTilemapEraseCellScript(nodePath, coords, layer, scenePath);
        break;
      }
      case 'tilemap_fill_rect': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const region = validateRect2i(args.region);
        const sourceId = args.source_id as number;
        if (typeof sourceId !== 'number' || !Number.isInteger(sourceId)) {
          return opsErrorResult('INVALID_TILE_COORDS', 'source_id must be an integer');
        }
        const atlasCoords = validateCoords(args.atlas_coords);
        const alternativeTile = (args.alternative_tile as number) ?? 0;
        const layer = args.layer as number | undefined;
        script = genTilemapFillRectScript(nodePath, region, sourceId, atlasCoords, alternativeTile, layer, scenePath);
        break;
      }
      case 'tilemap_clear': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const layer = args.layer as number | undefined;
        const clearAll = layer === undefined;
        script = genTilemapClearScript(nodePath, layer, clearAll, scenePath);
        break;
      }
      case 'tilemap_copy': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const sourceRegion = validateRect2i(args.source_region);
        const layer = args.layer as number | undefined;
        script = genTilemapCopyScript(nodePath, sourceRegion, layer, scenePath);
        break;
      }
      case 'tilemap_paste': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const target = validateCoords(args.target);
        const pattern = args.pattern as { cells: Array<{ coords: [number, number]; source_id: number; atlas_coords: [number, number]; alternative_tile: number }>; size: { w: number; h: number } };
        if (!pattern || !Array.isArray(pattern.cells)) {
          return opsErrorResult('INVALID_REGION', 'pattern must have a cells array');
        }
        const layer = args.layer as number | undefined;
        script = genTilemapPasteScript(nodePath, target, pattern, layer, scenePath);
        break;
      }
      case 'tilemap_set_transform': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const coords = validateCoords(args.coords);
        const flipH = (args.flip_h as boolean) ?? false;
        const flipV = (args.flip_v as boolean) ?? false;
        const transpose = (args.transpose as boolean) ?? false;
        const layer = args.layer as number | undefined;
        script = genTilemapSetTransformScript(nodePath, coords, flipH, flipV, transpose, layer, scenePath);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    // Execute the generated GDScript
    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) =>
      msg.includes('Node not found') ? 'TILEMAP_NOT_FOUND' : 'SCRIPT_EXEC_FAILED';

    return appendRuntimePersistWarning(parseGdscriptResult(result, [], errorMapper), action);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('Coords') || msg.includes('integer')) return opsErrorResult('INVALID_TILE_COORDS', msg);
    if (msg.includes('Rect2i') || msg.includes('must be > 0')) return opsErrorResult('INVALID_REGION', msg);
    if (msg.includes('NodePath')) return opsErrorResult('TILEMAP_NOT_FOUND', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  tilemap: {
    readonly: false,
    long_running: false,
    actionRisks: {
      tilemap_read: 'read', tilemap_copy: 'read',
      tilemap_set_cell: 'write', tilemap_erase_cell: 'write', tilemap_fill_rect: 'write',
      tilemap_paste: 'write', tilemap_set_transform: 'write',
      tilemap_clear: 'destructive',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
