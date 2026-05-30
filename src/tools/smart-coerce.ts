/**
 * Smart type coercion: converts common shorthand formats to GDScript-compatible values.
 *
 * Supported conversions:
 * - Hex color strings (#RGB, #RRGGBB, #RRGGBBAA) → "Color(r, g, b, a)"
 * - Named CSS colors (13 most common) → "Color(r, g, b, a)"
 * - Comma-separated numbers ("x,y") → {x, y} / "x,y,z" → {x, y, z}
 * - Rect2-like objects ({x, y, w, h}) → "Rect2(x, y, w, h)"
 */

const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [1, 1, 1], black: [0, 0, 0], red: [1, 0, 0],
  green: [0, 0.502, 0], blue: [0, 0, 1], yellow: [1, 1, 0],
  cyan: [0, 1, 1], magenta: [1, 0, 1], orange: [1, 0.647, 0],
  purple: [0.502, 0, 0.502], pink: [1, 0.753, 0.796],
  gray: [0.502, 0.502, 0.502], grey: [0.502, 0.502, 0.502],
  transparent: [1, 1, 1],
};

function hexToNorm(hex: string): [number, number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  const r = Math.round(parseInt(h.slice(0, 2), 16) / 255 * 1000) / 1000;
  const g = Math.round(parseInt(h.slice(2, 4), 16) / 255 * 1000) / 1000;
  const b = Math.round(parseInt(h.slice(4, 6), 16) / 255 * 1000) / 1000;
  const a = h.length >= 8 ? Math.round(parseInt(h.slice(6, 8), 16) / 255 * 1000) / 1000 : 1;
  return [r, g, b, a];
}

/**
 * Smart type coercion: converts common shorthand formats to GDScript-compatible values.
 * Returns the coerced value or the original if no coercion applies.
 */
export function smartCoerce(value: unknown): unknown {
  if (typeof value !== 'string') {
    if (typeof value === 'object' && value !== null) {
      return coerceRect2(value);
    }
    return value;
  }

  const trimmed = value.trim();

  // 1. Hex color: #RGB, #RRGGBB, #RRGGBBAA
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    const [r, g, b, a] = hexToNorm(trimmed);
    return `Color(${r}, ${g}, ${b}, ${a})`;
  }

  // 2. Named CSS color (limited set)
  const lower = trimmed.toLowerCase();
  if (NAMED_COLORS[lower]) {
    const [r, g, b] = NAMED_COLORS[lower];
    const a = lower === 'transparent' ? 0 : 1;
    return `Color(${r}, ${g}, ${b}, ${a})`;
  }

  // 3. Comma-separated numbers → Vector2/Vector3 object
  const numMatch = trimmed.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)(?:\s*,\s*(-?\d+\.?\d*))?$/);
  if (numMatch) {
    const nums = numMatch.slice(1).filter(Boolean).map(Number);
    if (nums.length === 2) return { x: nums[0], y: nums[1] };
    if (nums.length === 3) return { x: nums[0], y: nums[1], z: nums[2] };
  }

  return value;
}

/**
 * Detect Rect2-like objects with {x, y, w, h} keys.
 */
export function coerceRect2(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.x === 'number' && typeof obj.y === 'number'
    && typeof obj.w === 'number' && typeof obj.h === 'number'
    && Object.keys(obj).length === 4) {
    return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
  }
  return value;
}
