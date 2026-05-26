import { expect } from 'vitest';
import {
  TILEMAP_ERROR_CODES,
  validateCoords,
  validateRect2i,
  genTilemapReadScript, genTilemapSetCellScript, genTilemapEraseCellScript,
  genTilemapFillRectScript, genTilemapClearScript, genTilemapCopyScript,
  genTilemapPasteScript, genTilemapSetTransformScript,
} from '../src/tools/tilemap-ops.js';

describe('TILEMAP_ERROR_CODES', () => {
  it('has TILEMAP_NOT_FOUND', () => { expect('TILEMAP_NOT_FOUND' in TILEMAP_ERROR_CODES).toBeTruthy(); });
  it('has INVALID_TILE_COORDS', () => { expect('INVALID_TILE_COORDS' in TILEMAP_ERROR_CODES).toBeTruthy(); });
  it('has INVALID_REGION', () => { expect('INVALID_REGION' in TILEMAP_ERROR_CODES).toBeTruthy(); });
  it('has SCRIPT_EXEC_FAILED', () => { expect('SCRIPT_EXEC_FAILED' in TILEMAP_ERROR_CODES).toBeTruthy(); });
});

describe('validateCoords', () => {
  it('accepts valid integer coords', () => {
    expect(validateCoords({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
  it('accepts zero coords', () => {
    expect(validateCoords({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
  it('accepts negative coords', () => {
    expect(validateCoords({ x: -1, y: -5 })).toEqual({ x: -1, y: -5 });
  });
  it('rejects float coords', () => {
    expect(() => validateCoords({ x: 1.5, y: 2 })).toThrow(/integer/);
  });
  it('rejects missing y', () => {
    expect(() => validateCoords({ x: 1 })).toThrow(/integer/);
  });
  it('rejects string values', () => {
    expect(() => validateCoords({ x: '1', y: 2 })).toThrow(/integer/);
  });
  it('rejects null', () => {
    expect(() => validateCoords(null)).toThrow(/object/);
  });
});

describe('validateRect2i', () => {
  it('accepts valid region', () => {
    expect(validateRect2i({ x: 0, y: 0, w: 10, h: 5 })).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });
  it('rejects w=0', () => {
    expect(() => validateRect2i({ x: 0, y: 0, w: 0, h: 5 })).toThrow(/must be > 0/);
  });
  it('rejects negative w', () => {
    expect(() => validateRect2i({ x: 0, y: 0, w: -1, h: 5 })).toThrow(/must be > 0/);
  });
  it('rejects float w', () => {
    expect(() => validateRect2i({ x: 0, y: 0, w: 1.5, h: 5 })).toThrow(/integer/);
  });
  it('rejects null', () => {
    expect(() => validateRect2i(null)).toThrow(/object/);
  });
});

describe('genTilemapReadScript', () => {
  it('contains TileMap and TileMapLayer branches', () => {
    const script = genTilemapReadScript('/root/Map', { x: 0, y: 0, w: 5, h: 5 }, 0);
    expect(script.includes('TileMap')).toBeTruthy();
    expect(script.includes('TileMapLayer')).toBeTruthy();
    expect(script.includes('get_cell_source_id')).toBeTruthy();
  });
  it('works without region', () => {
    const script = genTilemapReadScript('/root/Map');
    expect(script.includes('get_used_cells')).toBeTruthy();
  });
});

describe('genTilemapSetCellScript', () => {
  it('contains set_cell with coords and source_id', () => {
    const script = genTilemapSetCellScript('/root/Map', { x: 3, y: 4 }, 1, { x: 0, y: 0 }, 0, 0);
    expect(script.includes('set_cell')).toBeTruthy();
    expect(script.includes('Vector2i(3, 4)')).toBeTruthy();
    expect(script.includes('TileMap')).toBeTruthy();
    expect(script.includes('TileMapLayer')).toBeTruthy();
  });
});

describe('genTilemapEraseCellScript', () => {
  it('contains erase_cell', () => {
    const script = genTilemapEraseCellScript('/root/Map', { x: 1, y: 2 }, 0);
    expect(script.includes('erase_cell')).toBeTruthy();
    expect(script.includes('Vector2i(1, 2)')).toBeTruthy();
  });
});

describe('genTilemapFillRectScript', () => {
  it('contains fill rect loop', () => {
    const script = genTilemapFillRectScript('/root/Map', { x: 0, y: 0, w: 3, h: 2 }, 1, { x: 0, y: 0 }, 0, 0);
    expect(script.includes('range(3)')).toBeTruthy();
    expect(script.includes('range(2)')).toBeTruthy();
    expect(script.includes('set_cell')).toBeTruthy();
  });
});

describe('genTilemapClearScript', () => {
  it('contains clear', () => {
    const script = genTilemapClearScript('/root/Map', 0);
    expect(script.includes('.clear()')).toBeTruthy();
    expect(script.includes('TileMap')).toBeTruthy();
    expect(script.includes('TileMapLayer')).toBeTruthy();
  });
});

describe('genTilemapCopyScript', () => {
  it('contains cell reading', () => {
    const script = genTilemapCopyScript('/root/Map', { x: 0, y: 0, w: 2, h: 2 }, 0);
    expect(script.includes('get_cell_source_id')).toBeTruthy();
    expect(script.includes('cells')).toBeTruthy();
  });
});

describe('genTilemapPasteScript', () => {
  it('contains set_cell with target offset', () => {
    const pattern = { cells: [{ coords: [0, 0], source_id: 1, atlas_coords: [0, 0], alternative_tile: 0 }], size: { w: 1, h: 1 } };
    const script = genTilemapPasteScript('/root/Map', { x: 5, y: 5 }, pattern, 0);
    expect(script.includes('set_cell')).toBeTruthy();
  });
});

describe('genTilemapSetTransformScript', () => {
  it('contains flip_h', () => {
    const script = genTilemapSetTransformScript('/root/Map', { x: 1, y: 1 }, true, false, false, 0);
    expect(script.includes('flip_h')).toBeTruthy();
    expect(script.includes('set_cell')).toBeTruthy();
  });
  it('handles combined transforms (flip_h + flip_v + transpose)', () => {
    const script = genTilemapSetTransformScript('/root/Map', { x: 2, y: 3 }, true, true, true, 0);
    expect(script.includes('new_alt = new_alt | 1')).toBeTruthy();
    expect(script.includes('new_alt = new_alt | 2')).toBeTruthy();
    expect(script.includes('new_alt = new_alt | 4')).toBeTruthy();
  });
  it('uses get_class for both node types', () => {
    const script = genTilemapSetTransformScript('/root/Map', { x: 0, y: 0 }, false, false, false, 0);
    expect(script.includes('node.get_class() == "TileMap"')).toBeTruthy();
    expect(script.includes('node.get_class() == "TileMapLayer"')).toBeTruthy();
  });
});

describe('genTilemapClearScript clearAll', () => {
  it('uses clear() when clearAll is true', () => {
    const script = genTilemapClearScript('/root/Map', undefined, true);
    expect(script.includes('node.clear()')).toBeTruthy();
    expect(script.includes('clear_layer')).toBeFalsy();
  });
  it('uses clear_layer when clearAll is false', () => {
    const script = genTilemapClearScript('/root/Map', 2, false);
    expect(script.includes('clear_layer(2)')).toBeTruthy();
  });
});

describe('genTilemapReadScript empty region', () => {
  it('reads used cells without region', () => {
    const script = genTilemapReadScript('/root/Map');
    expect(script.includes('get_used_cells')).toBeTruthy();
    expect(script.includes('range(')).toBeFalsy();
  });
  it('uses get_class for node type checks', () => {
    const script = genTilemapReadScript('/root/Map', { x: 0, y: 0, w: 3, h: 3 }, 0);
    expect(script.includes('node.get_class() == "TileMap"')).toBeTruthy();
    expect(script.includes('node.get_class() == "TileMapLayer"')).toBeTruthy();
  });
});
