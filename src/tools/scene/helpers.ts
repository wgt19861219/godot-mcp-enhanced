// Scene tool shared helpers.

import type { ToolResult } from '../../types.js';
import { opsErrorResult } from '../shared.js';
import { gdEscape, valueToGd } from '../shared.js';
import { writeFileAtomicWithMode } from '../../core/fs-atomic.js';
import { parseTscn } from '../../tscn/tscn-parser.js';

export const ACTIONS = [
  'read_scene', 'create_scene', 'add_node', 'save_scene', 'load_sprite',
  'quick_scene', 'batch_add_nodes', 'query_scene_tree', 'inspect_node',
  'edit_node', 'remove_node', 'instance_scene', 'set_instance_property', 'detach_instance',
  'open_scene',
  'health_check',
  'merge_scene',
  'create_3d_node', 'commit',
] as const;

/** Validate that a value is a non-empty string; returns opsErrorResult if not. */
export function requireScenePath(value: unknown): ToolResult | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return opsErrorResult('INVALID_PARAMS', `scene_path must be a non-empty string, got: ${value === undefined ? 'undefined' : value === null ? 'null' : typeof value}`);
  }
  return null;
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
export function gdScriptSetLine(key: string, value: unknown, varName = 'node'): string {
  const needsTrySet = isVectorLike(value);
  const ek = gdEscape(key);
  try {
    const expr = valueToGd(value);
    if (needsTrySet) {
      return `_try_set(${varName}, "${ek}", ${expr})`;
    }
    return `${varName}.${ek} = ${expr}`;
  } catch (e: unknown) {
    // valueToGd throws on non-finite numbers — convert to a skip comment
    const msg = (e as Error).message;
    if (msg.includes('Non-finite')) return `# skipped ${key}: non-finite number`;
    throw e;
  }
}

/** Returns true if the value is an array/object that produces a Vector/Color expression. */
export function isVectorLike(value: unknown): boolean {
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

export const TRY_SET_HELPER = `
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

/** Atomic file write: write to temp then rename. Uses temp+rename on all platforms (NTFS same-volume rename is atomic).
 * A-ATOMIC (2026-09-01): 实现上移合并至 src/core/fs-atomic.ts(三份重复实现的并集语义:
 * mode 保持 + 随机 tmp 后缀 + Windows 锁定降级),此处保留签名薄委托,消费方零改动。 */
export function writeAtomic(filePath: string, content: string): void {
  writeFileAtomicWithMode(filePath, content);
}

/** B2(反馈批次 B): 推断场景根节点名——root [node] 的 name 属性;缺失时 Godot 以
 * 场景文件名(去扩展名)为根名。用于剥 query_scene_tree 拷贝路径里的根名前缀
 * (对齐 GD 链 _resolve_parent_node 的剥离链)。 */
export function inferSceneRootName(tscnContent: string, sceneRelPath: string): string | undefined {
  try {
    const root = parseTscn(tscnContent).nodes.find(n => !n.parent);
    if (root && root.name) return root.name;
  } catch {
    // parse 失败走文件名推断(addNode 文本拼接对 parse 失败的场景自身也会失败)
  }
  const base = sceneRelPath.split('/').pop() ?? '';
  const fromFile = base.replace(/\.tscn$/i, '');
  return fromFile || undefined;
}
