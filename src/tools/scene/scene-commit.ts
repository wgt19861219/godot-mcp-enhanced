// P2: scene_commit — batch GDScript generator for multi-operation scene editing.
// Generates a single GDScript that loads a scene, executes multiple operations,
// optionally saves, and reports structured results via COMMIT_RESULT prefix.

import { gdEscape, escapeForGdLiteral } from '../shared/value-serializer.js';
import { BLOCKED_PROPS } from '../../core/shared/blocked-props.js';

export const COMMIT_OPERATIONS = [
  'tile_set', 'tile_fill', 'tile_erase', 'tile_clear',
  'tileset_assign', 'node_property', 'node_add',
  'tileset_physics_layer_add', 'tile_collision_set',
  'tileset_physics_layer_set', 'tileset_physics_layer_remove',
  'tileset_navigation_layer_add', 'tile_navigation_set',
  'tileset_custom_data_layer_add', 'tile_custom_data_set',
  'tile_collision_clear',
] as const;

/**
 * 直接修改外部 .tres TileSet 资源(非场景实例)的 op——save 分支据此收集待保存资源,
 * handler 层据此对 tileset_path 做项目内校验。physics/navigation/custom data 三层全可编程。
 */
export const TILESET_RESOURCE_OPS: ReadonlySet<string> = new Set([
  'tileset_physics_layer_add', 'tile_collision_set',
  'tileset_physics_layer_set', 'tileset_physics_layer_remove',
  'tileset_navigation_layer_add', 'tile_navigation_set',
  'tileset_custom_data_layer_add', 'tile_custom_data_set',
  'tile_collision_clear',
]);

export type CommitOp = typeof COMMIT_OPERATIONS[number];

/**
 * IMPORTANT-7 (review): 校验 operations 数组结构。每个 op 必须有合法 op 字段
 * (对齐 COMMIT_OPERATIONS)。原 scene-commit-tool 用 as unknown as CommitOperation[] 无运行时校验,
 * 畸形 op(op 字段缺失/非法值)会让 generateCommitScript 运行时崩溃或生成畸形 .gd。
 * @returns null 全部合法;否则首条错误信息(含索引与合法值清单)。
 */
export function validateCommitOperations(operations: Array<Record<string, unknown>>): string | null {
  const validOps = new Set<string>(COMMIT_OPERATIONS);
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const opType = op?.op;
    if (typeof opType !== 'string' || !validOps.has(opType)) {
      return `Op ${i}: invalid op "${String(opType)}". Valid: ${COMMIT_OPERATIONS.join(', ')}`;
    }
    // F-5: 逐 op 校验数值/向量/字符串字段的运行时类型。原实现只校验 op 字段,
    // 其余字段靠 TS 接口(编译时)+ as unknown as 强转,runtime 可被绕过;
    // generateCommitScript 把 op.coords.x 等直接 ${} 插值进 GDScript,
    // 字符串值可注入(二线 scanGdscriptSandbox 兜底,但纵深防御应在输入校验层先拦)。
    const err = validateOpFields(i, opType, op ?? {});
    if (err) return err;
  }
  return null;
}

// F-5: 运行时类型守卫
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isVec2(v: unknown): boolean {
  return typeof v === 'object' && v !== null
    && isNum((v as { x?: unknown }).x) && isNum((v as { y?: unknown }).y);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** F-5: 按 op 类型校验必填字段的运行时类型,堵 as unknown as 强转的注入面。 */
function validateOpFields(idx: number, opType: string, op: Record<string, unknown>): string | null {
  const at = `Op ${idx} (${opType})`;
  const needStr = (key: string): string | null =>
    !isStr(op[key]) ? `${at}: "${key}" must be a string` : null;
  const needVec2 = (key: string): string | null =>
    !isVec2(op[key]) ? `${at}: "${key}" must be {x:number, y:number}` : null;
  const needNum = (key: string): string | null =>
    !isNum(op[key]) ? `${at}: "${key}" must be a finite number` : null;
  const optNum = (key: string): string | null =>
    op[key] !== undefined && !isNum(op[key]) ? `${at}: optional "${key}" must be a finite number` : null;
  const optBool = (key: string): string | null =>
    op[key] !== undefined && typeof op[key] !== 'boolean' ? `${at}: optional "${key}" must be a boolean` : null;
  // tileset 写盘 op 的资源路径浅校验(生成器层,无项目根上下文):
  // res:// 前缀 + 明文 .. 段拒绝。URL 编码/symlink 等绕过形态由 handler 层
  // resolveWithinRoot 纵深拦截(scene-commit-tool.ts handleCommitAction)。
  const needResPath = (key: string): string | null => {
    if (!isStr(op[key])) return `${at}: "${key}" must be a string`;
    const p = op[key] as string;
    if (!p.startsWith('res://')) return `${at}: "${key}" must start with res:// (got non-project path)`;
    if (p.split('/').includes('..')) return `${at}: "${key}" contains path traversal segments`;
    return null;
  };
  // shape/points 校验(tile_collision_set 与 tile_navigation_set 共用形态)
  const validateShapePoints = (): string | null => {
    const shape = op.shape;
    if (shape !== 'rect' && shape !== 'polygon') {
      return `${at}: "shape" must be "rect" or "polygon"`;
    }
    if (shape === 'rect' && op.points !== undefined) {
      return `${at}: "points" must be omitted when shape is "rect" (rect 生成全格四点)`;
    }
    if (shape === 'polygon') {
      const pts = op.points;
      if (!Array.isArray(pts) || pts.length === 0) {
        return `${at}: "points" must be a non-empty array for polygon shape`;
      }
      for (let j = 0; j < pts.length; j++) {
        if (!isVec2(pts[j])) {
          return `${at}: points[${j}] must be {x:number, y:number}`;
        }
      }
    }
    return null;
  };

  switch (opType) {
    case 'tile_set': {
      return needStr('node_path') || needVec2('coords') || needNum('source_id')
        || needVec2('atlas') || optNum('alternative_tile');
    }
    case 'tile_fill': {
      const rg = op.region as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
      const regionValid = !!rg && isNum(rg.x) && isNum(rg.y) && isNum(rg.w) && isNum(rg.h);
      if (!regionValid) return `${at}: "region" must be {x,y,w,h: number}`;
      return needNum('source_id') || needVec2('atlas') || optNum('alternative_tile');
    }
    case 'tile_erase': {
      return needStr('node_path') || needVec2('coords');
    }
    case 'tile_clear': {
      return needStr('node_path');
    }
    case 'tileset_assign': {
      return needStr('node_path') || needStr('tileset_path');
    }
    case 'node_property': {
      return needStr('path') || needStr('property')
        || (op.value === undefined ? `${at}: "value" is required` : null);
    }
    case 'node_add': {
      // parent 可省略(generator 默认),但若提供必须是 string(防 gdEscape(undefined) 崩溃)
      const parentErr = op.parent !== undefined && !isStr(op.parent)
        ? `${at}: optional "parent" must be a string` : null;
      return needStr('name') || needStr('type') || parentErr;
    }
    case 'tileset_physics_layer_add': {
      return needResPath('tileset_path') || optNum('collision_layer') || optNum('collision_mask');
    }
    case 'tile_collision_set': {
      const shapeErr = validateShapePoints();
      if (shapeErr) return shapeErr;
      return needResPath('tileset_path') || needNum('source_id') || needVec2('atlas')
        || optNum('alternative_tile') || needNum('physics_layer') || optBool('one_way');
    }
    case 'tileset_physics_layer_set': {
      if (op.collision_layer === undefined && op.collision_mask === undefined) {
        return `${at}: at least one of "collision_layer"/"collision_mask" is required`;
      }
      return needResPath('tileset_path') || needNum('layer')
        || optNum('collision_layer') || optNum('collision_mask');
    }
    case 'tileset_physics_layer_remove': {
      return needResPath('tileset_path') || needNum('layer');
    }
    case 'tileset_navigation_layer_add': {
      return needResPath('tileset_path') || optNum('layers');
    }
    case 'tile_navigation_set': {
      const shapeErr = validateShapePoints();
      if (shapeErr) return shapeErr;
      return needResPath('tileset_path') || needNum('source_id') || needVec2('atlas')
        || optNum('alternative_tile') || needNum('navigation_layer');
    }
    case 'tileset_custom_data_layer_add': {
      // 审查 N-1:`in` 查原型链,constructor/toString 等可绕白名单 → 生成非法 GD;用自有属性判定
      if (op.type !== undefined
        && (!isStr(op.type) || !Object.prototype.hasOwnProperty.call(CUSTOM_DATA_TYPES, op.type))) {
        return `${at}: "type" must be one of int/float/bool/string/color/vector2`;
      }
      return needResPath('tileset_path') || needStr('name');
    }
    case 'tile_custom_data_set': {
      return needResPath('tileset_path') || needNum('source_id') || needVec2('atlas')
        || optNum('alternative_tile') || needNum('layer')
        || (op.value === undefined ? `${at}: "value" is required` : null);
    }
    case 'tile_collision_clear': {
      return needResPath('tileset_path') || needNum('source_id') || needVec2('atlas')
        || optNum('alternative_tile') || needNum('physics_layer');
    }
    default:
      return null;
  }
}

interface TileSetOp {
  op: 'tile_set';
  node_path: string;
  coords: { x: number; y: number };
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
}

interface TileFillOp {
  op: 'tile_fill';
  node_path: string;
  region: { x: number; y: number; w: number; h: number };
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
}

interface TileEraseOp {
  op: 'tile_erase';
  node_path: string;
  coords: { x: number; y: number };
}

interface TileClearOp {
  op: 'tile_clear';
  node_path: string;
}

interface TilesetAssignOp {
  op: 'tileset_assign';
  node_path: string;
  tileset_path: string;
}

interface NodePropertyOp {
  op: 'node_property';
  path: string;
  property: string;
  value: unknown;
}

interface NodeAddOp {
  op: 'node_add';
  parent: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

// TileSet 碰撞配置(2026-08-19,依据可行性评估 §2.3):两 op 直接修改外部 .tres 资源
// (MVP 排除内嵌 TileSet——tileset_assign 已确立外部 .tres 模式),save 分支对每个
// 被改 tileset 单独走 tmp+rename 原子写。tileset_path 限定 res:// 项目内(needResPath
// 浅校验 + handler 层 resolveWithinRoot 纵深,防 ResourceSaver 越界写)。
interface TilesetPhysicsLayerAddOp {
  op: 'tileset_physics_layer_add';
  tileset_path: string;
  collision_layer?: number;
  collision_mask?: number;
}

interface TileCollisionSetOp {
  op: 'tile_collision_set';
  tileset_path: string;
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
  physics_layer: number;
  shape: 'rect' | 'polygon';
  /** polygon 模式必填自定义点集;rect 模式必须省略(全格四点运行时由 tile_size 生成,等价编辑器按 F) */
  points?: Array<{ x: number; y: number }>;
  one_way?: boolean;
}

// ─── 层配置扩展批(2026-08-19):physics 修改/删除 + navigation 层 + custom data 层 ───
// API 依据本地 godot-docs 核对;navigation 是对象级 set_navigation_polygon(layer, NavigationPolygon)
// (与 collision 的 set_collision_polygon_points 点集式不对称,生成代码独立)。

interface TilesetPhysicsLayerSetOp {
  op: 'tileset_physics_layer_set';
  tileset_path: string;
  layer: number;
  collision_layer?: number;
  collision_mask?: number;
}

interface TilesetPhysicsLayerRemoveOp {
  op: 'tileset_physics_layer_remove';
  tileset_path: string;
  layer: number;
}

interface TilesetNavigationLayerAddOp {
  op: 'tileset_navigation_layer_add';
  tileset_path: string;
  layers?: number;
}

interface TileNavigationSetOp {
  op: 'tile_navigation_set';
  tileset_path: string;
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
  navigation_layer: number;
  shape: 'rect' | 'polygon';
  points?: Array<{ x: number; y: number }>;
}

/** custom data layer 的 value 类型白名单 → Variant.Type 枚举(引擎侧) */
export const CUSTOM_DATA_TYPES: Readonly<Record<string, string>> = {
  int: 'TYPE_INT', float: 'TYPE_FLOAT', bool: 'TYPE_BOOL',
  string: 'TYPE_STRING', color: 'TYPE_COLOR', vector2: 'TYPE_VECTOR2',
};

interface TilesetCustomDataLayerAddOp {
  op: 'tileset_custom_data_layer_add';
  tileset_path: string;
  name: string;
  type?: string;
}

interface TileCustomDataSetOp {
  op: 'tile_custom_data_set';
  tileset_path: string;
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
  layer: number;
  value: unknown;
}

interface TileCollisionClearOp {
  op: 'tile_collision_clear';
  tileset_path: string;
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
  physics_layer: number;
}

export type CommitOperation =
  | TileSetOp | TileFillOp | TileEraseOp | TileClearOp
  | TilesetAssignOp | NodePropertyOp | NodeAddOp
  | TilesetPhysicsLayerAddOp | TileCollisionSetOp
  | TilesetPhysicsLayerSetOp | TilesetPhysicsLayerRemoveOp
  | TilesetNavigationLayerAddOp | TileNavigationSetOp
  | TilesetCustomDataLayerAddOp | TileCustomDataSetOp
  | TileCollisionClearOp;

/** 类型谓词:TILESET_RESOURCE_OPS 集合与 union 的桥(has() 无法窄化,显式声明成员都有 tileset_path)。 */
function isTilesetResourceOp(
  op: CommitOperation,
): op is Extract<CommitOperation, { tileset_path: string }> {
  return TILESET_RESOURCE_OPS.has(op.op);
}

/** 资源层配置 op 直接修改外部 .tres(非场景实例)——save 分支据此收集待保存资源。 */
export function collectTilesetPaths(operations: CommitOperation[]): string[] {
  const paths = new Set<string>();
  for (const op of operations) {
    if (isTilesetResourceOp(op)) {
      paths.add(op.tileset_path);
    }
  }
  return [...paths];
}

/** Validate a string is a safe GDScript identifier (property name, type name, etc.) */
function isSafeIdentifier(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

// P2-3 (2026-08-06): node_add 类型从黑名单收紧为白名单。
// 原黑名单(IMP-4)只列 9 项敏感类,第三方 addon 注册的 extends Node 恶意 class_name 不在列 →
// ${op.type}.new() 跑其 _ready() → OS.execute RCE(不经 execute_gdscript 沙箱)。
// 白名单镜像 headless 的 ALLOWED_HEADLESS_TYPES(src/scripts/godot_operations.gd:195-211),
// 须与 GD 侧同步(defects detect 守护)。特殊类型请走 add_node 工具(走 GD 二次白名单校验)。
const ALLOWED_COMMIT_NODE_TYPES = new Set([
  // Node3D 系
  'Node3D', 'MeshInstance3D', 'StaticBody3D', 'RigidBody3D',
  'CharacterBody3D', 'Camera3D', 'Light3D', 'DirectionalLight3D',
  'OmniLight3D', 'SpotLight3D', 'CollisionShape3D', 'RayCast3D',
  'Area3D', 'Marker3D', 'PathFollow3D', 'VisibleOnScreenNotifier3D',
  // Node2D 系
  'Node2D', 'Sprite2D', 'AnimatedSprite2D',
  'CollisionShape2D', 'Area2D', 'RigidBody2D', 'CharacterBody2D',
  // 播放器/动画/定时
  'AudioStreamPlayer', 'AudioStreamPlayer2D', 'AudioStreamPlayer3D',
  'AnimationPlayer', 'AnimationTree', 'Timer',
  // Control 系
  'Control',
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect', 'ColorPickerButton',
  'TabContainer', 'Tree', 'ItemList', 'MarginContainer', 'HBoxContainer',
  'VBoxContainer', 'GridContainer', 'CenterContainer', 'ScrollContainer',
  'PanelContainer', 'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
]);

/**
 * Generate a complete GDScript that executes all operations in sequence,
 * optionally saves the scene, and reports structured results.
 */
export function generateCommitScript(
  scenePath: string,
  operations: CommitOperation[],
  save: boolean,
  stopOnError: boolean = true,
): string {
  const hasFill = operations.some(op => op.op === 'tile_fill');
  // 碰撞 op 修改的外部 .tres 资源(去重):save 时逐个原子写盘。
  // load() 走 ResourceCache,多个 op 引用同一路径返回同一实例,去重后保存一次即可。
  const tilesetPaths = collectTilesetPaths(operations);
  const opBlocks: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    opBlocks.push(generateOpBlock(i, op, stopOnError));
  }

  const sp = escapeForGdLiteral(scenePath);
  // F-2 (批 F, 2026-08-14): save=true 分支顶层 success 绑定 err == OK——原硬编码 true 与
  // saved:err==OK 并存,磁盘满/权限失败(EACCES/ENOSPC)时 COMMIT_RESULT 报成功(假成功),
  // AI 与 middleware 把写盘失败当成功。save=false 分支无保存动作,success:true 是"无保存失败"
  // 的预期语义,保持不变(handleCommitAction 仅在 save 时对 saved:false 置 isError)。
  // 场景保存保持原内联(tmp+rename);tileset 保存走 _save_resource helper(同模式抽函数,
  // 仅在有 tileset op 时生成,不影响纯节点 commit 的既有生成物)。
  const tilesetSaveBlock = (save && tilesetPaths.length > 0)
    ? `\tfor _p in [${tilesetPaths.map(p => `"${escapeForGdLiteral(p)}"`).join(', ')}]:\n\t\tvar _tres = load(_p)\n\t\tif _tres != null:\n\t\t\tvar _te := _save_resource(_tres, _p)\n\t\t\tif _te != OK:\n\t\t\t\terr = _te\n`
    : '';
  const saveBlock = save
    ? `\t# --- Save ---\n\tvar packed = PackedScene.new()\n\tpacked.pack(inst)\n\tvar _full := "${sp}"\n\tvar _ext := _full.get_extension()\n\tvar _tmp := _full + ".tmp." + _ext\n\tif FileAccess.file_exists(_tmp):\n\t\tDirAccess.remove_absolute(_tmp)\n\tvar err := ResourceSaver.save(packed, _tmp)\n\tif err != OK:\n\t\tDirAccess.remove_absolute(_tmp)\n\telse:\n\t\tvar _ren := DirAccess.rename_absolute(_tmp, _full)\n\t\tif _ren != OK:\n\t\t\tDirAccess.remove_absolute(_tmp)\n\t\t\terr = _ren\n${tilesetSaveBlock}\tprint("COMMIT_RESULT: " + JSON.stringify({"success": err == OK, "saved": err == OK, "results": _results}))`
    : `\tprint("COMMIT_RESULT: " + JSON.stringify({"success": true, "saved": false, "results": _results}))`;

  const fillHelper = hasFill
    ? `\nfunc _fill_tiles(node, rx, ry, rw, rh, sid, atlas, alt):\n\tfor cy in range(ry, ry + rh):\n\t\tfor cx in range(rx, rx + rw):\n\t\t\tnode.set_cell(Vector2i(cx, cy), sid, atlas, alt)\n`
    : '';

  const saveResHelper = (save && tilesetPaths.length > 0)
    ? `\nfunc _save_resource(res, full: String) -> int:\n\tvar tmp := full + ".tmp." + full.get_extension()\n\tif FileAccess.file_exists(tmp):\n\t\tDirAccess.remove_absolute(tmp)\n\tvar e := ResourceSaver.save(res, tmp)\n\tif e != OK:\n\t\tDirAccess.remove_absolute(tmp)\n\t\treturn e\n\tvar ren := DirAccess.rename_absolute(tmp, full)\n\tif ren != OK:\n\t\tDirAccess.remove_absolute(tmp)\n\t\treturn ren\n\treturn OK\n`
    : '';

  const stopBlock = stopOnError
    ? `\n\tif _has_error:\n\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error_count": _results.filter(func(r): return not r.ok).size(), "results": _results}))\n\t\tquit()\n\t\treturn`
    : '';

  return `extends SceneTree

var _results = []
var _has_error = false
${fillHelper}${saveResHelper}
func _initialize():
\tvar scene = load("${sp}")
\tif scene == null:
\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error": "Failed to load scene", "results": []}))
\t\tquit()
\t\treturn
\tvar inst = scene.instantiate()
${opBlocks.join('\n')}${stopBlock}
${saveBlock}
\tquit()
`;
}

/**
 * per-tile 守卫链(tile_collision_set / tile_navigation_set / tile_custom_data_set / tile_collision_clear
 * 四 op 共用形态):load tileset → source 存在 → TileSetAtlasSource → has_tile → layer 越界
 * → get_tile_data 非空。返回以 td 守卫的 `else:` 结尾,调用方接 5-tab 写体与上报。
 */
function tileGuardChain(
  idx: number,
  opts: {
    opName: string; tsp: string; sid: number; ax: number; ay: number; alt: number;
    layerIdx: number | string; countExpr: string; layerLabel: string;
  },
  errAction: string, stopOnError: boolean,
): string {
  const err3 = stopOnError ? '\t\t\t_has_error = true' : '\t\t\t# continue despite error';
  const err4 = stopOnError ? '\t\t\t\t_has_error = true' : '\t\t\t\t# continue despite error';
  return `
\tvar ts${idx} = load("${opts.tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tvar src${idx} = ts${idx}.get_source(${opts.sid})
\t\tif src${idx} == null:
\t\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "Source ${opts.sid} not found"})
${err3}
\t\telif not (src${idx} is TileSetAtlasSource):
\t\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "Source ${opts.sid} is not a TileSetAtlasSource (requires atlas source)"})
${err3}
\t\telif not src${idx}.has_tile(Vector2i(${opts.ax}, ${opts.ay})):
\t\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "Tile (${opts.ax}, ${opts.ay}) not in atlas"})
${err3}
\t\telif ${opts.layerIdx} < 0 or ${opts.layerIdx} >= ${opts.countExpr}:
\t\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "${opts.layerLabel} ${opts.layerIdx} out of range"})
${err3}
\t\telse:
\t\t\tvar td${idx} = src${idx}.get_tile_data(Vector2i(${opts.ax}, ${opts.ay}), ${opts.alt})
\t\t\tif td${idx} == null:
\t\t\t\t_results.append({"op": "${opts.opName}", "tileset_path": "${opts.tsp}", "ok": false, "error": "TileData unavailable (alternative_tile ${opts.alt} not created?)"})
${err4}
\t\t\telse:`;
}

function generateOpBlock(index: number, op: CommitOperation, stopOnError: boolean): string {
  const idx = index + 1;
  const errAction = stopOnError
    ? '\t\t_has_error = true'
    : '\t\t# continue despite error';
  // elif 链在 else 块内,守卫失败动作需更深缩进(tile_collision_set 守卫链)
  const errAt = (tabs: number) => stopOnError
    ? `${'\t'.repeat(tabs)}_has_error = true`
    : `${'\t'.repeat(tabs)}# continue despite error`;
  switch (op.op) {
    case 'tile_set': {
      const alt = op.alternative_tile ?? 0;
      const np = escapeForGdLiteral(op.node_path);
      return `
\t# --- Op ${idx}: tile_set ---
\tvar n${idx} = inst.get_node_or_null("${np}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_set", "node_path": "${np}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_set", "node_path": "${np}", "ok": true})`;
    }
    case 'tile_fill': {
      const alt = op.alternative_tile ?? 0;
      const cells = op.region.w * op.region.h;
      const np = escapeForGdLiteral(op.node_path);
      return `
\t# --- Op ${idx}: tile_fill ---
\tvar n${idx} = inst.get_node_or_null("${np}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_fill", "node_path": "${np}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\t_fill_tiles(n${idx}, ${op.region.x}, ${op.region.y}, ${op.region.w}, ${op.region.h}, ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_fill", "node_path": "${np}", "ok": true, "cells_affected": ${cells}})`;
    }
    case 'tile_erase': {
      const np = escapeForGdLiteral(op.node_path);
      return `
\t# --- Op ${idx}: tile_erase ---
\tvar n${idx} = inst.get_node_or_null("${np}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_erase", "node_path": "${np}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), -1)
\t\t_results.append({"op": "tile_erase", "node_path": "${np}", "ok": true})`;
    }
    case 'tile_clear': {
      const np = escapeForGdLiteral(op.node_path);
      return `
\t# --- Op ${idx}: tile_clear ---
\tvar n${idx} = inst.get_node_or_null("${np}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_clear", "node_path": "${np}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.clear()
\t\t_results.append({"op": "tile_clear", "node_path": "${np}", "ok": true})`;
    }
    case 'tileset_assign': {
      const np = escapeForGdLiteral(op.node_path);
      const tsp = escapeForGdLiteral(op.tileset_path);
      return `
\t# --- Op ${idx}: tileset_assign ---
\tvar n${idx} = inst.get_node_or_null("${np}")
\tif n${idx} == null:
\t\t_results.append({"op": "tileset_assign", "node_path": "${np}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.tile_set = load("${tsp}")
\t\t_results.append({"op": "tileset_assign", "node_path": "${np}", "ok": true})`;
    }
    case 'node_property': {
      const p = escapeForGdLiteral(op.path);
      // Imp-1 (2026-06-24 审查): node_property 直接赋值绕过 edit_node 的 S1 拦截(实测持久化)。
      // 命中 BLOCKED_PROPS 返回明确警告,与 edit_node S1 一致(不静默 drop)。
      if (BLOCKED_PROPS.has(op.property)) {
        return `
\t# --- Op ${idx}: node_property ---
\t_results.append({"op": "node_property", "path": "${p}", "property": "${gdEscape(op.property)}", "ok": false, "error": "⚠️ Property '${gdEscape(op.property)}' is blocked (BLOCKED_PROPS security policy). Use edit_node or remove it from the operation."})`;
      }
      if (!isSafeIdentifier(op.property)) {
        return `
\t# --- Op ${idx}: node_property ---
\t_results.append({"op": "node_property", "path": "${p}", "ok": false, "error": "Invalid property name"})`;
      }
      return `
\t# --- Op ${idx}: node_property ---
\tvar n${idx} = inst.get_node_or_null("${p}")
\tif n${idx} == null:
\t\t_results.append({"op": "node_property", "path": "${p}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.${op.property} = ${serializeGdValue(op.value)}
\t\t_results.append({"op": "node_property", "path": "${p}", "ok": true})`;
    }
    case 'node_add': {
      if (!isSafeIdentifier(op.type)) {
        return `
\t# --- Op ${idx}: node_add ---
\t_results.append({"op": "node_add", "name": "${gdEscape(op.name)}", "ok": false, "error": "Invalid type name"})`;
      }
      if (!ALLOWED_COMMIT_NODE_TYPES.has(op.type)) {  // P2-3: 白名单收尾,阻断非白名单类(含第三方恶意 class_name)实例化
        return `
\t# --- Op ${idx}: node_add ---
\t_results.append({"op": "node_add", "name": "${gdEscape(op.name)}", "ok": false, "error": "Type not in allowlist: ${gdEscape(op.type)} (use add_node tool for special types)"})`;
      }
      const propLines = op.properties
        ? Object.entries(op.properties)
          .filter(([k]) => isSafeIdentifier(k) && !BLOCKED_PROPS.has(k))  // Imp-1: 过滤 BLOCKED_PROPS(script/owner/name 等)防注入;name 由 op.name 单独设(下方 GDScript 先执行),过滤 properties.name 防覆盖
          .map(([k, v]) => `\t\tchild${idx}.${k} = ${serializeGdValue(v)}`)
          .join('\n') + '\n'
        : '';
      // I-5: parent='.' 表示根节点,保留 '.' 让 get_node_or_null('.') 命中根(原代码转空串导致必失败)
      // T2b: parentPath 纯字面量内插(get_node_or_null/%unique-name 语法合法),escapeForGdLiteral
      const parentPath = op.parent === '.' ? '.' : escapeForGdLiteral(op.parent);
      const name = gdEscape(op.name);
      return `
\t# --- Op ${idx}: node_add ---
\tvar child${idx} = ${op.type}.new()
\tchild${idx}.name = "${name}"
${propLines}\tvar parent${idx} = inst.get_node_or_null("${parentPath}")
\tif parent${idx} == null:
\t\t_results.append({"op": "node_add", "name": "${name}", "ok": false, "error": "Parent not found"})
${errAction}
\telse:
\t\tparent${idx}.add_child(child${idx})
\t\tchild${idx}.owner = inst
\t\t_results.append({"op": "node_add", "name": "${name}", "ok": true})`;
    }
    case 'tileset_physics_layer_add': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const layerLines = op.collision_layer !== undefined
        ? `\t\tts${idx}.set_physics_layer_collision_layer(lid${idx}, ${op.collision_layer})\n`
        : '';
      const maskLines = op.collision_mask !== undefined
        ? `\t\tts${idx}.set_physics_layer_collision_mask(lid${idx}, ${op.collision_mask})\n`
        : '';
      return `
\t# --- Op ${idx}: tileset_physics_layer_add ---
\tvar ts${idx} = load("${tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "tileset_physics_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "tileset_physics_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tvar lid${idx} = ts${idx}.get_physics_layers_count()
\t\tts${idx}.add_physics_layer()
${layerLines}${maskLines}\t\t_results.append({"op": "tileset_physics_layer_add", "tileset_path": "${tsp}", "ok": true, "layer_id": lid${idx}})`;
    }
    case 'tile_collision_set': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const alt = op.alternative_tile ?? 0;
      const phys = op.physics_layer;
      // rect:全格四点运行时由 tile_size 生成(等价编辑器碰撞编辑器按 F);polygon:字面量点集。
      // PackedVector2Array 构造器只接受 Array(不接受 Vector2 可变参)——端到端 Godot 4.6.3 实测。
      const pointsExpr = op.shape === 'rect'
        ? `PackedVector2Array([Vector2(0, 0), Vector2(sz${idx}.x, 0), Vector2(sz${idx}.x, sz${idx}.y), Vector2(0, sz${idx}.y)])`
        : `PackedVector2Array([${op.points!.map(p => `Vector2(${p.x}, ${p.y})`).join(', ')}])`;
      // 嵌套层级:guard(1-4)→ td 守卫 else 体(5),sz/one_way 行在 5-tab 层
      const szLine = op.shape === 'rect'
        ? `\t\t\t\tvar sz${idx} = ts${idx}.get_tile_size()\n`
        : '';
      const oneWayLine = op.one_way !== undefined
        ? `\t\t\t\ttd${idx}.set_collision_polygon_one_way(${phys}, 0, ${op.one_way})\n`
        : '';
      const pointsCount = op.shape === 'rect' ? 4 : op.points!.length;
      const guard = tileGuardChain(idx, {
        opName: 'tile_collision_set', tsp, sid: op.source_id,
        ax: op.atlas.x, ay: op.atlas.y, alt,
        layerIdx: phys, countExpr: `ts${idx}.get_physics_layers_count()`, layerLabel: 'physics_layer',
      }, errAction, stopOnError);
      return `
\t# --- Op ${idx}: tile_collision_set ---${guard}
${szLine}\t\t\t\ttd${idx}.set_collision_polygons_count(${phys}, 1)
\t\t\t\ttd${idx}.set_collision_polygon_points(${phys}, 0, ${pointsExpr})
${oneWayLine}\t\t\t\t_results.append({"op": "tile_collision_set", "tileset_path": "${tsp}", "ok": true, "physics_layer": ${phys}, "points_count": ${pointsCount}})`;
    }
    case 'tileset_physics_layer_set': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const err3 = errAt(3);
      const setLines = op.collision_layer !== undefined
        ? `\t\t\tts${idx}.set_physics_layer_collision_layer(${op.layer}, ${op.collision_layer})\n`
        : '';
      const maskLines = op.collision_mask !== undefined
        ? `\t\t\tts${idx}.set_physics_layer_collision_mask(${op.layer}, ${op.collision_mask})\n`
        : '';
      return `
\t# --- Op ${idx}: tileset_physics_layer_set ---
\tvar ts${idx} = load("${tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "tileset_physics_layer_set", "tileset_path": "${tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "tileset_physics_layer_set", "tileset_path": "${tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tif ${op.layer} < 0 or ${op.layer} >= ts${idx}.get_physics_layers_count():
\t\t\t_results.append({"op": "tileset_physics_layer_set", "tileset_path": "${tsp}", "ok": false, "error": "physics_layer ${op.layer} out of range"})
${err3}
\t\telse:
${setLines}${maskLines}\t\t\t_results.append({"op": "tileset_physics_layer_set", "tileset_path": "${tsp}", "ok": true, "layer": ${op.layer}})`;
    }
    case 'tileset_physics_layer_remove': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const err3 = errAt(3);
      return `
\t# --- Op ${idx}: tileset_physics_layer_remove ---
\tvar ts${idx} = load("${tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "tileset_physics_layer_remove", "tileset_path": "${tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "tileset_physics_layer_remove", "tileset_path": "${tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tif ${op.layer} < 0 or ${op.layer} >= ts${idx}.get_physics_layers_count():
\t\t\t_results.append({"op": "tileset_physics_layer_remove", "tileset_path": "${tsp}", "ok": false, "error": "physics_layer ${op.layer} out of range"})
${err3}
\t\telse:
\t\t\tts${idx}.remove_physics_layer(${op.layer})
\t\t\t_results.append({"op": "tileset_physics_layer_remove", "tileset_path": "${tsp}", "ok": true, "layer": ${op.layer}})`;
    }
    case 'tileset_navigation_layer_add': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const layerLines = op.layers !== undefined
        ? `\t\tts${idx}.set_navigation_layer_layers(lid${idx}, ${op.layers})\n`
        : '';
      return `
\t# --- Op ${idx}: tileset_navigation_layer_add ---
\tvar ts${idx} = load("${tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "tileset_navigation_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "tileset_navigation_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tvar lid${idx} = ts${idx}.get_navigation_layers_count()
\t\tts${idx}.add_navigation_layer()
${layerLines}\t\t_results.append({"op": "tileset_navigation_layer_add", "tileset_path": "${tsp}", "ok": true, "layer_id": lid${idx}})`;
    }
    case 'tile_navigation_set': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const alt = op.alternative_tile ?? 0;
      const nav = op.navigation_layer;
      // navigation 与 collision API 不对称:对象级 set_navigation_polygon(layer, NavigationPolygon),
      // 需构造 vertices + add_polygon(顶点索引)(class_navigationpolygon.rst 文档示例同款)
      const pointsExpr = op.shape === 'rect'
        ? `PackedVector2Array([Vector2(0, 0), Vector2(sz${idx}.x, 0), Vector2(sz${idx}.x, sz${idx}.y), Vector2(0, sz${idx}.y)])`
        : `PackedVector2Array([${op.points!.map(p => `Vector2(${p.x}, ${p.y})`).join(', ')}])`;
      const pointsCount = op.shape === 'rect' ? 4 : op.points!.length;
      const indices = Array.from({ length: pointsCount }, (_, i) => i).join(', ');
      const szLine = op.shape === 'rect'
        ? `\t\t\t\tvar sz${idx} = ts${idx}.get_tile_size()\n`
        : '';
      const guard = tileGuardChain(idx, {
        opName: 'tile_navigation_set', tsp, sid: op.source_id,
        ax: op.atlas.x, ay: op.atlas.y, alt,
        layerIdx: nav, countExpr: `ts${idx}.get_navigation_layers_count()`, layerLabel: 'navigation_layer',
      }, errAction, stopOnError);
      return `
\t# --- Op ${idx}: tile_navigation_set ---${guard}
${szLine}\t\t\t\tvar np${idx} := NavigationPolygon.new()
\t\t\t\tnp${idx}.vertices = ${pointsExpr}
\t\t\t\tnp${idx}.add_polygon(PackedInt32Array([${indices}]))
\t\t\t\ttd${idx}.set_navigation_polygon(${nav}, np${idx})
\t\t\t\t_results.append({"op": "tile_navigation_set", "tileset_path": "${tsp}", "ok": true, "navigation_layer": ${nav}, "points_count": ${pointsCount}})`;
    }
    case 'tileset_custom_data_layer_add': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const name = escapeForGdLiteral(op.name);
      const typeLine = op.type !== undefined
        ? `\t\tts${idx}.set_custom_data_layer_type(lid${idx}, ${CUSTOM_DATA_TYPES[op.type]})\n`
        : '';
      return `
\t# --- Op ${idx}: tileset_custom_data_layer_add ---
\tvar ts${idx} = load("${tsp}")
\tif ts${idx} == null:
\t\t_results.append({"op": "tileset_custom_data_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "TileSet resource not found"})
${errAction}
\telif not (ts${idx} is TileSet):
\t\t_results.append({"op": "tileset_custom_data_layer_add", "tileset_path": "${tsp}", "ok": false, "error": "Resource is not a TileSet"})
${errAction}
\telse:
\t\tvar lid${idx} = ts${idx}.get_custom_data_layers_count()
\t\tts${idx}.add_custom_data_layer()
\t\tts${idx}.set_custom_data_layer_name(lid${idx}, "${name}")
${typeLine}\t\t_results.append({"op": "tileset_custom_data_layer_add", "tileset_path": "${tsp}", "ok": true, "layer_id": lid${idx}, "name": "${name}"})`;
    }
    case 'tile_custom_data_set': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const alt = op.alternative_tile ?? 0;
      const guard = tileGuardChain(idx, {
        opName: 'tile_custom_data_set', tsp, sid: op.source_id,
        ax: op.atlas.x, ay: op.atlas.y, alt,
        layerIdx: op.layer, countExpr: `ts${idx}.get_custom_data_layers_count()`, layerLabel: 'custom data layer',
      }, errAction, stopOnError);
      return `
\t# --- Op ${idx}: tile_custom_data_set ---${guard}
\t\t\t\ttd${idx}.set_custom_data_by_layer_id(${op.layer}, ${serializeGdValue(op.value)})
\t\t\t\t_results.append({"op": "tile_custom_data_set", "tileset_path": "${tsp}", "ok": true, "layer": ${op.layer}})`;
    }
    case 'tile_collision_clear': {
      const tsp = escapeForGdLiteral(op.tileset_path);
      const alt = op.alternative_tile ?? 0;
      const phys = op.physics_layer;
      const guard = tileGuardChain(idx, {
        opName: 'tile_collision_clear', tsp, sid: op.source_id,
        ax: op.atlas.x, ay: op.atlas.y, alt,
        layerIdx: phys, countExpr: `ts${idx}.get_physics_layers_count()`, layerLabel: 'physics_layer',
      }, errAction, stopOnError);
      return `
\t# --- Op ${idx}: tile_collision_clear ---${guard}
\t\t\t\ttd${idx}.set_collision_polygons_count(${phys}, 0)
\t\t\t\t_results.append({"op": "tile_collision_clear", "tileset_path": "${tsp}", "ok": true, "physics_layer": ${phys}})`;
    }
  }
}

function serializeGdValue(value: unknown): string {
  // I-03, C-01: Escape backslash, quote, newline for GDScript string safety
  // IMPORTANT-6 (review): 补 \r \t 转义,防控制字符破坏 .gd 字符串/被解析为行结束而注入新行。
  // SEC-P2-6 (2026-08-10): string 分支转义委托 escapeForGdLiteral(与 gdEscape 共享 escapeGdStringCore,
  //   消除两份独立实现的手动同步漂移——原 \r 处理 \r vs \n 已漂移)。
  //   不转义 % 和 '(属性值字面量不参与 % 格式化,转义反而破坏正常 % 字符)。
  if (typeof value === 'string') return `"${escapeForGdLiteral(value)}"`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'null';

  // Array support
  if (Array.isArray(value)) {
    const items = value.map(v => serializeGdValue(v)).join(', ');
    return `[${items}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    // _type explicit override
    if (obj._type && typeof obj._type === 'string') {
      const t = obj._type;
      if (t === 'Rect2' || t === 'Rect2i') {
        // I-6: 补 typeof number 守卫(与 Color/Vector 分支对齐),非数字字段降级为 0
        const rx = typeof obj.x === 'number' ? obj.x : 0;
        const ry = typeof obj.y === 'number' ? obj.y : 0;
        const rw = typeof obj.w === 'number' ? obj.w : 0;
        const rh = typeof obj.h === 'number' ? obj.h : 0;
        return `${t}(${rx}, ${ry}, ${rw}, ${rh})`;
      }
      if (t === 'Vector3' || t === 'Vector3i') {
        return `${t}(${obj.x ?? 0}, ${obj.y ?? 0}, ${obj.z ?? 0})`;
      }
      if (t === 'Vector2' || t === 'Vector2i') {
        return `${t}(${obj.x ?? 0}, ${obj.y ?? 0})`;
      }
      if (t === 'Color') {
        return `Color(${obj.r ?? 1}, ${obj.g ?? 1}, ${obj.b ?? 1}, ${obj.a ?? 1})`;
      }
      // I-01: Unknown _type intentionally falls through to auto-inference.
      // Users must use a known type or rely on auto-detection.
      // Unknown _type
    }

    // Color: has r, g, b
    if (keys.includes('r') && keys.includes('g') && keys.includes('b')
      && typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1;
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }

    // Rect2: has x, y, w, h (I-6: 补 typeof number 守卫,与 Color/Vector 分支对齐)
    if (keys.includes('w') && keys.includes('h') && keys.includes('x') && keys.includes('y') && !keys.includes('z')
      && typeof obj.x === 'number' && typeof obj.y === 'number' && typeof obj.w === 'number' && typeof obj.h === 'number') {
      return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
    }

    // Vector3: has x, y, z
    if (keys.includes('x') && keys.includes('y') && keys.includes('z')
      && typeof obj.x === 'number' && typeof obj.y === 'number' && typeof obj.z === 'number') {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }

    // Vector2: has x, y
    if (keys.includes('x') && keys.includes('y')
      && typeof obj.x === 'number' && typeof obj.y === 'number') {
      return `Vector2(${obj.x}, ${obj.y})`;
    }

    // C-02: Strip _type from fallback to avoid leaking meta-field into GDScript
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _type: _ignored, ...sanitized } = obj;
    return JSON.stringify(sanitized);
  }

  return String(value);
}
