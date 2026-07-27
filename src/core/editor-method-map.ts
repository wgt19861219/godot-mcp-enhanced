// src/core/editor-method-map.ts
// editor 模式 (tool, action) → command_handler 扁平 method 映射。
//
// 背景：EditorToolExecutor._executeInner 原本用工具名（如 'asset'）直接当 JSON-RPC
// method 转发给 command_handler.gd，但 command_handler 只有扁平分支
// （asset_create / asset_path / asset_batch / asset_undo / asset_save），无 'asset'
// 聚合入口 → 走兜底 -32601。本表把 (tool=asset, action=create) 映射到 asset_create，
// 让 editor 转发真正命中 GD handle_*。
//
// 未命中（list_shapes / list_materials 等无对应 GD 分支的 action，或未登记的工具）
// 返回 null，调用方 fallback 到工具名，维持原 -32601 → headless 回退路径
// （见 ToolDispatcher._isUnknownMethod）。
//
// command_handler 分支命名不统一（asset_create 有前缀 / add_node 无前缀 / guard_*
// 域前缀），无法自动推导，故用显式表。新增 (tool,action) 工具时在此登记映射。

type Args = Record<string, unknown>;

export interface EditorMethodEntry {
  /** command_handler.gd 的扁平 method 名 */
  readonly method: string;
  /** 可选：转发前变换 args（如修正字段层级） */
  readonly transformArgs?: (args: Args) => Args;
}

// asset.create 的 transform 修正（不兼容 B）：TS schema 把 position/rotation/scale
// 放顶层（asset-ops.ts，与 params 平级），但 GD handle_create 只把内层 params 传给
// place_one / _apply_transform，顶层 transform 会被静默丢弃。此处把顶层 transform
// 并入 params（params 已有同名键优先，免覆盖 shape 参数）。
export function mergeTransformIntoParams(args: Args): Args {
  const params =
    args.params && typeof args.params === 'object'
      ? { ...(args.params as Args) }
      : {};
  for (const key of ['position', 'rotation', 'scale'] as const) {
    if (args[key] !== undefined && params[key] === undefined) {
      params[key] = args[key];
    }
  }
  // 顶层 position/rotation/scale 已并入 params（GD handle_create 只读内层 params），
  // 从顶层剥离避免双重传参在日志/调试时造成视觉混淆。
  const rest = { ...args };
  delete rest.position;
  delete rest.rotation;
  delete rest.scale;
  return { ...rest, params };
}

// animation_track 的 transform：TS action 是全名（add_track/add_keyframe/set_curve），
// 编码「子域+短动作」;GD handler 按短动作 match（animation_track match add/remove;
// animation_keyframe match add/remove/update）。此处把 action 改成 GD 期望的短名
// （method 由 MAP 条目决定走哪个 handler）。set_curve 不带 transform（animation_curve 忽略 action）。
export function shortenAction(shortAction: string): (args: Args) => Args {
  return (args) => ({ ...args, action: shortAction });
}

const MAP: Record<string, Record<string, EditorMethodEntry>> = {
  asset: {
    create: { method: 'asset_create', transformArgs: mergeTransformIntoParams },
    path: { method: 'asset_path' },
    batch: { method: 'asset_batch' },
    undo: { method: 'asset_undo' },
    save: { method: 'asset_save' },
  },
  scene: {
    add_node: { method: 'add_node' },
    // editor-version-tear §5: edit_node / batch_add_nodes 登记打通 editor 路由,
    // editor 连接时直走 GD handle_edit_node/handle_batch_add_nodes（改内存属性 + undo）,
    // 不再 fallback headless spawnGodot 改盘（致磁盘/内存版本撕裂）
    edit_node: { method: 'edit_node' },
    batch_add_nodes: { method: 'batch_add_nodes' },
    remove_node: { method: 'remove_node' },
    instance_scene: { method: 'instance_scene' },
    set_instance_property: { method: 'set_instance_property' },
    open_scene: { method: 'open_scene' },
    save_scene: { method: 'save_scene' },
  },
  // CRITICAL(2026-07-13 协议断链): animation_track 工具 TS action 全名编码「子域+短动作」,
  // GD 按 method 分 handler → 按 action 映射到不同 method + shortenAction 转短名。
  // 未登记时 method=animation_track 命中 GD :165 但 match 只认 add/remove → -32004 (非 -32601,
  // 不触发 headless 回退) → editor 模式 6 action 全失效。
  //
  // v0.25.0：animation_track 工具已合并进 animation，6 个 track/keyframe/curve action 现由
  // animation 工具暴露。新增 animation 条目复用同一批 GD method（command_handler.gd 路由不变），
  // 使合并后 editor 模式仍直走 GD handler 而非 fallback headless。animation_track 条目暂保留，
  // 因 GD 端仍按这些 method 名路由，删除会触发 static-grep.test.ts 双向漂移检测。
  animation: {
    add_track: { method: 'animation_track', transformArgs: shortenAction('add') },
    remove_track: { method: 'animation_track', transformArgs: shortenAction('remove') },
    add_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('add') },
    remove_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('remove') },
    update_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('update') },
    set_curve: { method: 'animation_curve' },
  },
  animation_track: {
    add_track: { method: 'animation_track', transformArgs: shortenAction('add') },
    remove_track: { method: 'animation_track', transformArgs: shortenAction('remove') },
    add_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('add') },
    remove_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('remove') },
    update_keyframe: { method: 'animation_keyframe', transformArgs: shortenAction('update') },
    set_curve: { method: 'animation_curve' },
  },
  // CRITICAL(2026-07-13 协议断链): export_* editor 死锁 — method fallback 'validation'
  // → GD 无此 method -32601 → headless → test-framework 硬返 EDITOR_ONLY。登记 export_*
  // 直走 GD export 分支。assert/stress 不登记(headless 可处理,无死锁)。
  validation: {
    export_list_presets: { method: 'export_list_presets' },
    export_get_preset: { method: 'export_get_preset' },
    export_build: { method: 'export_build' },
  },
  // IMPORTANT(2026-07-13 协议断链): 下列族 editor 漏登记 → fallback toolName → -32601
  // → headless → GD 带 undo 分支成死代码,丢 editor 实时+undo。登记后 editor 模式走 GD 带 undo。
  // recording 不登记(GD editor 主动禁用 -32009,走 bridge)。headless-only action
  // (nav.query_path / animtree.animtree_state_edit / ui.ui_draw_recipe / ui.ui_build_layout)不登记。
  // method 名与 GD command_handler 分支一致(action↔method 映射经子代理核实)。
  particles: {
    particles_create: { method: 'particles_create' },
    particles_set_emission: { method: 'particles_set_emission' },
    particles_set_process: { method: 'particles_set_process' },
    particles_load_preset: { method: 'particles_load_preset' },
    particles_set_material: { method: 'particles_set_material' },
  },
  nav: {
    create_region: { method: 'nav_create_region' },
    bake_mesh: { method: 'nav_bake_mesh' },
    create_agent: { method: 'nav_create_agent' },
    set_params: { method: 'nav_set_params' },
    create_link: { method: 'nav_create_link' },
  },
  animtree: {
    animtree_create: { method: 'animtree_create' },
    animtree_add_state: { method: 'animtree_add_state' },
    animtree_add_transition: { method: 'animtree_add_transition' },
    animtree_set_blend: { method: 'animtree_set_blend' },
    animtree_play: { method: 'animtree_play' },
  },
  ui: {
    ui_create_control: { method: 'ui_create_control' },
    ui_set_layout: { method: 'ui_set_layout' },
    ui_get_layout: { method: 'ui_get_layout' },
    ui_anchor_preset: { method: 'ui_anchor_preset' },
    ui_container_add: { method: 'ui_container_add' },
    theme_set_property: { method: 'theme_set_property' },
    // ui_set_theme/theme_create 暂不登记:GD handle_ui_set_theme(ui_commands.gd:244)/
    // handle_theme_create(:353) 读 params.action 做聚合子分派(create/set_params/save/load |
    // create/extract),与 TS 顶层 action(ui_set_theme/theme_create)契约不一致 → 登记会返 -32004
    // (非 -32601,不回退 headless)回归。待 GD handler 改读专用子操作字段(如 theme_op)后再登记。
    // 当前 editor fallback headless(现状,非回归)。
  },
};

/** 解析 (toolName, args.action) → command_handler method。未命中返回 null。 */
export function resolveEditorMethod(toolName: string, args: Args): EditorMethodEntry | null {
  const actionMap = MAP[toolName];
  if (!actionMap) return null;
  const action = args.action;
  if (typeof action !== 'string') return null;
  return actionMap[action] ?? null;
}

// 供漂移检测测试引用：asset 写动作映射到的扁平 method 名（须与
// command_handler.gd 的 asset_* 分支一致）。
export const ASSET_EDITOR_METHODS = [
  'asset_create',
  'asset_path',
  'asset_batch',
  'asset_undo',
  'asset_save',
] as const;
