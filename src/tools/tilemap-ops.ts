import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

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

/** Generate the standard node-fetch + null-check preamble. */
function nodePreamble(nodePath: string): string {
  return `\tvar node = _mcp_get_node("${gdEscape(nodePath)}")\n\tif node == null:\n\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")\n\t\t_mcp_done()\n\t\treturn`;
}

/** Generate `if TileMap: ... elif TileMapLayer: ... else: error` branch with early-return on else. */
function tilemapBranch(tileMapBody: string, layerBody: string, returnOnError = true): string {
  const elseBlock = returnOnError
    ? '\t\t_mcp_output("error", "Not a TileMap or TileMapLayer: " + node.get_class())\n\t\t_mcp_done()\n\t\treturn'
    : '\t\t_mcp_output("error", "Not a TileMap or TileMapLayer: " + node.get_class())';
  return `\tif node.get_class() == "TileMap":\n${tileMapBody}\telif node.get_class() == "TileMapLayer":\n${layerBody}\telse:\n${elseBlock}`;
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
  nodePath: string, region?: { x: number; y: number; w: number; h: number }, layer?: number
): string {
  const la = layerArg(layer);

  if (region) {
    const readCellBody = (prefix: string) =>
      `\t\tvar cells = []\n\t\tfor cy in range(${region.y}, ${region.y + region.h}):\n\t\t\tfor cx in range(${region.x}, ${region.x + region.w}):\n\t\t\t\tvar sid = node.get_cell_source_id(${prefix}Vector2i(cx, cy))\n\t\t\t\tif sid >= 0:\n\t\t\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}Vector2i(cx, cy))\n\t\t\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}Vector2i(cx, cy))\n\t\t\t\t\tcells.append({"coords": [cx, cy], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n\t\t_mcp_output("cells", cells)`;

    return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
${tilemapBranch(readCellBody(la), readCellBody(''))}
\t_mcp_done()
`;
  }

  const readUsedBody = (prefix: string) =>
    `\t\tvar used = node.get_used_cells(${prefix.trim().replace(/,\s*$/, '')})\n\t\tvar cells = []\n\t\tfor c in used:\n\t\t\tvar sid = node.get_cell_source_id(${prefix}c)\n\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}c)\n\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}c)\n\t\t\tcells.append({"coords": [c.x, c.y], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n\t\t_mcp_output("cells", cells)`;

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
${tilemapBranch(readUsedBody(la), readUsedBody(''))}
\t_mcp_done()
`;
}

export function genTilemapSetCellScript(
  nodePath: string, coords: { x: number; y: number },
  sourceId: number, atlasCoords: { x: number; y: number },
  alternativeTile: number, layer?: number
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
\tvar coords = Vector2i(${coords.x}, ${coords.y})
\tvar atlas = Vector2i(${atlasCoords.x}, ${atlasCoords.y})
${tilemapCall('set_cell', `coords, ${sourceId}, atlas, ${alternativeTile}`, layer)}
\t_mcp_output("set", {"coords": [${coords.x}, ${coords.y}], "source_id": ${sourceId}})
\t_mcp_done()
`;
}

export function genTilemapEraseCellScript(
  nodePath: string, coords: { x: number; y: number }, layer?: number
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
\tvar coords = Vector2i(${coords.x}, ${coords.y})
${tilemapCall('erase_cell', 'coords', layer)}
\t_mcp_output("erased", {"coords": [${coords.x}, ${coords.y}]})
\t_mcp_done()
`;
}

export function genTilemapFillRectScript(
  nodePath: string, region: { x: number; y: number; w: number; h: number },
  sourceId: number, atlasCoords: { x: number; y: number },
  alternativeTile: number, layer?: number
): string {
  const la = layerArg(layer);
  const fillBody = (prefix: string) =>
    `\t\tfor cy in range(${region.h}):\n\t\t\tfor cx in range(${region.w}):\n\t\t\t\tnode.set_cell(${prefix}Vector2i(${region.x} + cx, ${region.y} + cy), ${sourceId}, atlas, ${alternativeTile})\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
\tvar atlas = Vector2i(${atlasCoords.x}, ${atlasCoords.y})
${tilemapBranch(fillBody(la), fillBody(''))}
\t_mcp_output("filled", {"region": {"x": ${region.x}, "y": ${region.y}, "w": ${region.w}, "h": ${region.h}}, "source_id": ${sourceId}})
\t_mcp_done()
`;
}

export function genTilemapClearScript(
  nodePath: string, layer?: number, clearAll?: boolean
): string {
  const tileMapClear = clearAll ? '\t\tnode.clear()' : `\t\tnode.clear_layer(${layer ?? 0})`;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
${tilemapBranch(`${tileMapClear}\n`, '\t\tnode.clear()\n')}
\t_mcp_output("cleared", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genTilemapCopyScript(
  nodePath: string, sourceRegion: { x: number; y: number; w: number; h: number }, layer?: number
): string {
  const la = layerArg(layer);
  const copyBody = (prefix: string) =>
    `\t\tfor cy in range(${sourceRegion.h}):\n\t\t\tfor cx in range(${sourceRegion.w}):\n\t\t\t\tvar c = Vector2i(${sourceRegion.x} + cx, ${sourceRegion.y} + cy)\n\t\t\t\tvar sid = node.get_cell_source_id(${prefix}c)\n\t\t\t\tif sid >= 0:\n\t\t\t\t\tvar ac = node.get_cell_atlas_coords(${prefix}c)\n\t\t\t\t\tvar alt = node.get_cell_alternative_tile(${prefix}c)\n\t\t\t\t\tcells.append({"coords": [cx, cy], "source_id": sid, "atlas_coords": [ac.x, ac.y], "alternative_tile": alt})\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
\tvar cells = []
${tilemapBranch(copyBody(la), copyBody(''))}
\t_mcp_output("pattern", {"cells": cells, "size": {"w": ${sourceRegion.w}, "h": ${sourceRegion.h}}})
\t_mcp_done()
`;
}

export function genTilemapPasteScript(
  nodePath: string, targetCoords: { x: number; y: number },
  pattern: { cells: Array<{ coords: [number, number]; source_id: number; atlas_coords: [number, number]; alternative_tile: number }>; size: { w: number; h: number } },
  layer?: number
): string {
  const patternJson = JSON.stringify(pattern);
  const la = layerArg(layer);
  const pasteBody = (prefix: string) =>
    `\t\tfor cell in pattern["cells"]:\n\t\t\tvar cx = cell["coords"][0] + tx\n\t\t\tvar cy = cell["coords"][1] + ty\n\t\t\tnode.set_cell(${prefix}Vector2i(cx, cy), cell["source_id"], Vector2i(cell["atlas_coords"][0], cell["atlas_coords"][1]), cell["alternative_tile"])\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
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
  flipH: boolean, flipV: boolean, transpose: boolean, layer?: number
): string {
  const la = layerArg(layer);
  const readTileBody = (prefix: string) =>
    `\t\tsid = node.get_cell_source_id(${prefix}c)\n\t\tif sid < 0:\n\t\t\t_mcp_output("error", "No tile at coords")\n\t\t\t_mcp_done()\n\t\t\treturn\n\t\tac = node.get_cell_atlas_coords(${prefix}c)\n\t\talt = node.get_cell_alternative_tile(${prefix}c)\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${nodePreamble(nodePath)}
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

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'tilemap_read',
      description: `Read tile data from TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径（scene tree path，如 root/Level/TileMap）' },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          region: {
            type: 'object',
            description: '读取区域 Rect2i（可选，不传则读取全部已用图块）',
            properties: {
              x: { type: 'number', description: '起始 X 坐标' },
              y: { type: 'number', description: '起始 Y 坐标' },
              w: { type: 'number', description: '宽度（必须 > 0）' },
              h: { type: 'number', description: '高度（必须 > 0）' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'tilemap_set_cell',
      description: `Set a single tile on TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          coords: {
            type: 'object',
            description: '图块坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          source_id: { type: 'number', description: 'TileSet 源 ID' },
          atlas_coords: {
            type: 'object',
            description: '图集坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          alternative_tile: { type: 'number', description: '替代图块索引（可选，默认 0）' },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'coords', 'source_id', 'atlas_coords'],
      },
    },
    {
      name: 'tilemap_erase_cell',
      description: `Erase a single tile on TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          coords: {
            type: 'object',
            description: '图块坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'coords'],
      },
    },
    {
      name: 'tilemap_fill_rect',
      description: `Fill a rectangular region with a tile. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          region: {
            type: 'object',
            description: '填充区域 Rect2i',
            properties: {
              x: { type: 'number', description: '起始 X 坐标' },
              y: { type: 'number', description: '起始 Y 坐标' },
              w: { type: 'number', description: '宽度（必须 > 0）' },
              h: { type: 'number', description: '高度（必须 > 0）' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          source_id: { type: 'number', description: 'TileSet 源 ID' },
          atlas_coords: {
            type: 'object',
            description: '图集坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          alternative_tile: { type: 'number', description: '替代图块索引（可选，默认 0）' },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'region', 'source_id', 'atlas_coords'],
      },
    },
    {
      name: 'tilemap_clear',
      description: `Clear all tiles on TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          layer: { type: 'number', description: '图层索引。不传则清除所有图层；传值则仅清除指定图层' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'tilemap_copy',
      description: `Copy tile data from a rectangular region on TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          source_region: {
            type: 'object',
            description: '源区域 Rect2i',
            properties: {
              x: { type: 'number', description: '起始 X 坐标' },
              y: { type: 'number', description: '起始 Y 坐标' },
              w: { type: 'number', description: '宽度（必须 > 0）' },
              h: { type: 'number', description: '高度（必须 > 0）' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'source_region'],
      },
    },
    {
      name: 'tilemap_paste',
      description: `Paste a tile pattern at target position on TileMap/TileMapLayer. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          target: {
            type: 'object',
            description: '粘贴目标坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          pattern: {
            type: 'object',
            description: '图块图案（由 tilemap_copy 返回的 pattern 对象）',
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
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'target', 'pattern'],
      },
    },
    {
      name: 'tilemap_set_transform',
      description: `Set tile flip/rotation transform. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径' },
          coords: {
            type: 'object',
            description: '图块坐标 Vector2i',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          flip_h: { type: 'boolean', description: '水平翻转（可选，默认 false）' },
          flip_v: { type: 'boolean', description: '垂直翻转（可选，默认 false）' },
          transpose: { type: 'boolean', description: '转置（可选，默认 false）' },
          layer: { type: 'number', description: '图层索引（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'coords'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = [
  'tilemap_read', 'tilemap_set_cell', 'tilemap_erase_cell', 'tilemap_fill_rect',
  'tilemap_clear', 'tilemap_copy', 'tilemap_paste', 'tilemap_set_transform',
] as const;

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (name) {
      case 'tilemap_read': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const layer = args.layer as number | undefined;
        const region = args.region ? validateRect2i(args.region) : undefined;
        script = genTilemapReadScript(nodePath, region, layer);
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
        script = genTilemapSetCellScript(nodePath, coords, sourceId, atlasCoords, alternativeTile, layer);
        break;
      }
      case 'tilemap_erase_cell': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const coords = validateCoords(args.coords);
        const layer = args.layer as number | undefined;
        script = genTilemapEraseCellScript(nodePath, coords, layer);
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
        script = genTilemapFillRectScript(nodePath, region, sourceId, atlasCoords, alternativeTile, layer);
        break;
      }
      case 'tilemap_clear': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const layer = args.layer as number | undefined;
        const clearAll = layer === undefined;
        script = genTilemapClearScript(nodePath, layer, clearAll);
        break;
      }
      case 'tilemap_copy': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const sourceRegion = validateRect2i(args.source_region);
        const layer = args.layer as number | undefined;
        script = genTilemapCopyScript(nodePath, sourceRegion, layer);
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
        script = genTilemapPasteScript(nodePath, target, pattern, layer);
        break;
      }
      case 'tilemap_set_transform': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const coords = validateCoords(args.coords);
        const flipH = (args.flip_h as boolean) ?? false;
        const flipV = (args.flip_v as boolean) ?? false;
        const transpose = (args.transpose as boolean) ?? false;
        const layer = args.layer as number | undefined;
        script = genTilemapSetTransformScript(nodePath, coords, flipH, flipV, transpose, layer);
        break;
      }
      default:
        return null;
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

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Coords') || msg.includes('integer')) return opsErrorResult('INVALID_TILE_COORDS', msg);
    if (msg.includes('Rect2i') || msg.includes('must be > 0')) return opsErrorResult('INVALID_REGION', msg);
    if (msg.includes('NodePath')) return opsErrorResult('TILEMAP_NOT_FOUND', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  tilemap_read: { readonly: true, long_running: false },
  tilemap_set_cell: { readonly: false, long_running: false },
  tilemap_erase_cell: { readonly: false, long_running: false },
  tilemap_fill_rect: { readonly: false, long_running: false },
  tilemap_clear: { readonly: false, long_running: false },
  tilemap_copy: { readonly: true, long_running: false },
  tilemap_paste: { readonly: false, long_running: false },
  tilemap_set_transform: { readonly: false, long_running: false },
};
