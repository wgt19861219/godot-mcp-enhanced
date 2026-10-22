#!/usr/bin/env node
// scripts/check-command-docs-drift.mjs
// CMP-16-C (2026-08-08): GD param docs 与 TS inputSchema 的 drift 检测。
//
// 对标竞品 regiellis 的 "schema tracks whatever the editor registers"。
// 检测 GD 侧 get_command_docs 声明的参数,与 TS 侧工具 inputSchema 是否一致。
//
// 检测维度:
// 1. GD docs 有参数 X,但 TS inputSchema 没有该参数 → drift(GD 文档过时或 TS 漏加)
// 2. TS inputSchema 有参数 Y,但 GD docs 没有该参数 → 提示(可能是 action 这种路由参数,白名单豁免)
//
// method → tool/action 映射:用手写映射表(非自动前缀剥离,因命名不统一)。
// 映射表 key = GD method 名,value = {tool, action?}(action 省略表示 tool 直接对应)。
//
// 用法: node scripts/check-command-docs-drift.mjs
// 退出码: 0=通过(或只有提示级) / 1=有 drift 错误

import { readFileSync, readdirSync, statSync } from 'fs';

const root = process.cwd();
const COMMANDS_DIR = `${root}/addons/godot_mcp_server/commands`;

// ─── method → tool/action 映射表(手写,经 editor-method-map.ts 核实) ──────────
// CMP-16-C(2026-08-08):从一期 7 method(debug+engine)扩充到全 63 条映射(GD docs 64)。
// CMP-14(2026-08-09):debug 从 3 扩到 10(+7 Phase 2/3)。
// key = GD dispatch method 名;value = {tool, action}。
// 映射经 editor-method-map.ts(MAP 权威)+ command_handler.gd match 交叉核实。
const METHOD_TO_TOOL = {
  // ─── debug (CMP-3 + CMP-14):tool=debug, 10 action ───────────────────────
  debug_set_breakpoint:     { tool: 'debug',  action: 'set_breakpoint' },
  debug_clear_breakpoint:   { tool: 'debug',  action: 'clear_breakpoint' },
  debug_list_breakpoints:   { tool: 'debug',  action: 'list_breakpoints' },
  debug_stack_trace:        { tool: 'debug',  action: 'stack_trace' },
  debug_inspect_frame:      { tool: 'debug',  action: 'inspect_frame' },
  debug_evaluate:           { tool: 'debug',  action: 'evaluate' },
  debug_step:               { tool: 'debug',  action: 'step' },
  debug_continue:           { tool: 'debug',  action: 'continue' },
  debug_pause:              { tool: 'debug',  action: 'pause' },
  debug_reload_scripts:     { tool: 'debug',  action: 'reload_scripts' },
  // ─── engine (CMP-4 + CMP-9-A):tool=engine, 4 action ─────────────────────
  engine_class_info:        { tool: 'engine', action: 'class_info' },
  engine_search:            { tool: 'engine', action: 'search' },
  engine_get_inheritance:   { tool: 'engine', action: 'get_inheritance' },
  engine_call_method:       { tool: 'engine', action: 'call_method' },
  // ─── scene_commands + node_commands:tool=scene(node 归 scene 非 node)──
  open_scene:               { tool: 'scene',  action: 'open_scene' },
  save_scene:               { tool: 'scene',  action: 'save_scene' },
  instance_scene:           { tool: 'scene',  action: 'instance_scene' },
  set_instance_property:    { tool: 'scene',  action: 'set_instance_property' },
  add_node:                 { tool: 'scene',  action: 'add_node' },
  remove_node:              { tool: 'scene',  action: 'remove_node' },
  edit_node:                { tool: 'scene',  action: 'edit_node' },
  batch_add_nodes:          { tool: 'scene',  action: 'batch_add_nodes' },
  // ─── sync_commands:tool=editor(editor-sync.ts) ──────────────────────────
  // editor_get_scene_stats 无对应 TS action(走 GodotServer 直调),标 NO_TOOL
  editor_sync_start:        { tool: 'editor', action: 'sync_start' },
  editor_sync_stop:         { tool: 'editor', action: 'sync_stop' },
  editor_get_scene_tree:    { tool: 'editor', action: 'get_scene_tree' },
  // ─── animation_commands:split(3 个→animation_track,1 个→animation) ────
  // C-1(2026-10-22 审查):animation_track/animation_keyframe 的 GD method 含内部短 action
  // 参数(add/remove/update),风险必须按真实 action 解析;actions 表缺该 action → fail-closed。
  animation_track:          { tool: 'animation_track', action: 'add_track', actions: { add: 'add_track', remove: 'remove_track' } },
  animation_keyframe:       { tool: 'animation_track', action: 'add_keyframe', actions: { add: 'add_keyframe', remove: 'remove_keyframe', update: 'update_keyframe' } },
  animation_curve:          { tool: 'animation_track', action: 'set_curve' },
  animation_blend:          { tool: 'animation', action: 'blend' },
  // ─── animtree_commands:tool=animtree, action 扁平 ───────────────────────
  animtree_create:          { tool: 'animtree', action: 'animtree_create' },
  animtree_add_state:       { tool: 'animtree', action: 'animtree_add_state' },
  animtree_add_transition:  { tool: 'animtree', action: 'animtree_add_transition' },
  animtree_set_blend:       { tool: 'animtree', action: 'animtree_set_blend' },
  animtree_play:            { tool: 'animtree', action: 'animtree_play' },
  // ─── particle_commands:tool=particles, action 扁平 ──────────────────────
  particles_create:         { tool: 'particles', action: 'particles_create' },
  particles_set_emission:   { tool: 'particles', action: 'particles_set_emission' },
  particles_set_process:    { tool: 'particles', action: 'particles_set_process' },
  particles_load_preset:    { tool: 'particles', action: 'particles_load_preset' },
  particles_set_material:   { tool: 'particles', action: 'particles_set_material' },
  // ─── nav_commands:tool=nav, action 去 nav_ 前缀 ─────────────────────────
  nav_create_region:        { tool: 'nav', action: 'create_region' },
  nav_bake_mesh:            { tool: 'nav', action: 'bake_mesh' },
  nav_create_agent:         { tool: 'nav', action: 'create_agent' },
  nav_set_params:           { tool: 'nav', action: 'set_params' },
  nav_create_link:          { tool: 'nav', action: 'create_link' },
  // ─── test_commands:split(assert→validation, run/manage→testing) ────────
  test_assert:              { tool: 'validation', action: 'assert' },
  test_run:                 { tool: 'testing', action: 'run' },
  test_manage:              { tool: 'testing', action: 'manage' },
  // ─── export_commands:tool=validation, action 扁平 ───────────────────────
  export_list_presets:      { tool: 'validation', action: 'export_list_presets' },
  export_get_preset:        { tool: 'validation', action: 'export_get_preset' },
  export_build:             { tool: 'validation', action: 'export_build' },
  // ─── ui_commands:tool=ui, action 扁平 ───────────────────────────────────
  ui_create_control:        { tool: 'ui', action: 'ui_create_control' },
  ui_set_layout:            { tool: 'ui', action: 'ui_set_layout' },
  ui_get_layout:            { tool: 'ui', action: 'ui_get_layout' },
  ui_anchor_preset:         { tool: 'ui', action: 'ui_anchor_preset' },
  ui_set_theme:             { tool: 'ui', action: 'ui_set_theme' },
  ui_container_add:         { tool: 'ui', action: 'ui_container_add' },
  theme_create:             { tool: 'ui', action: 'theme_create' },
  theme_set_property:       { tool: 'ui', action: 'theme_set_property' },
  // ─── asset_commands:tool=asset, action 去 asset_ 前缀 ───────────────────
  asset_create:             { tool: 'asset', action: 'create' },
  asset_path:               { tool: 'asset', action: 'path' },
  asset_batch:              { tool: 'asset', action: 'batch' },
  asset_undo:               { tool: 'asset', action: 'undo' },
  asset_save:               { tool: 'asset', action: 'save' },
};

// 无 TS 工具对应的 GD method(走 GodotServer 直调或内联,非工具路由)
const NO_TOOL_METHODS = new Set([
  'editor_get_scene_stats',  // 走 GodotServer.ts 直调,非 editor 工具 action
]);

// 豁免参数(TS 有但 GD docs 不含,因它们是路由/元参数):
const ROUTING_PARAMS = new Set(['action']);

// 已知重命名(GD docs 参数名 → TS inputSchema 实际参数名,因 TS 避免路由 action 冲突而改名)。
// 这些不是 drift 是有意重命名,drift 检测时豁免 GD 侧的旧名。
const KNOWN_RENAMES = {
  // ui_set_theme/theme_create:GD 用 action 做 sub-action 分发,与 TS 顶层 action 路由冲突 → TS 改名
  ui_set_theme:       { action: 'theme_action' },
  theme_create:       { action: 'theme_create_action' },
  // theme_set_property:GD 用 name,TS 用 prop_name(避免与通用 name 混淆)
  theme_set_property: { name: 'prop_name' },
};

// 已知 schema 简化(merged tool 吸收了子工具但 inputSchema 未声明子工具参数,走 additionalProperties)。
// validation 吸收了 test-framework 的 assert + export,但 inputSchema 只声明 verify/import 参数。
// 这些是真实的 schema 简化(非 docs 错),drift 检测时整 method 豁免。
const KNOWN_SCHEMA_SIMPLIFIED = new Set([
  'test_assert',        // validation 吸收 assert 但 inputSchema 无 assertion_type/path/... 参数
  'export_get_preset',  // validation inputSchema 无 name 参数
  'export_build',       // validation inputSchema 无 preset 参数
]);

// ─── 提取 GD 侧 docs ──────────────────────────────────────────────────────────

/** 从 GD 源码提取 get_command_docs 里的 method→paramNames 映射 */
function extractGdDocs() {
  const files = [
    ...readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.gd')).map(f => `commands/${f}`),
    'commands/asset/asset_commands.gd',
  ];
  const docs = {}; // {method: [paramName, ...]}

  for (const relPath of files) {
    if (relPath.includes('command_helpers')) continue; // helper 文件无 docs
    if (relPath.includes('recording_commands')) continue; // 死代码
    let content;
    try {
      content = readFileSync(`${root}/addons/godot_mcp_server/${relPath}`, 'utf8');
    } catch { continue; }

    const docsStart = content.indexOf('func get_command_docs');
    if (docsStart < 0) continue;
    // 截到下一个顶层函数
    const nextFunc = content.indexOf('\nfunc ', docsStart + 10);
    const body = content.slice(docsStart, nextFunc < 0 ? docsStart + 4000 : nextFunc);

    // 提取 method key(2-tab "name": {)和其后的 doc_param 调用
    // 简化:逐 method 段提取
    const methodBlocks = body.split(/^\t\t("?[a-z_0-9]+"?): \{/m);
    // split 产生 [前导, key1, body1, key2, body2, ...]
    for (let i = 1; i < methodBlocks.length; i += 2) {
      const methodKey = methodBlocks[i].replace(/"/g, '');
      const methodBody = methodBlocks[i + 1] || '';
      const paramNames = [];
      for (const m of methodBody.matchAll(/doc_param\(\s*"([^"]+)"/g)) {
        paramNames.push(m[1]);
      }
      docs[methodKey] = paramNames;
    }
  }
  return docs;
}

// ─── 提取 TS 侧 inputSchema ───────────────────────────────────────────────────

/** 从 build/tools/ 提取工具 inputSchema 的参数名集合(递归扫子目录) */
function extractTsSchemas() {
  const toolsDir = `${root}/build/tools`;
  const schemas = {}; // {toolName: Set<paramName>}

  // 递归收集所有 .js 文件(含子目录 scene/ ui/ animation/ asset/ 等)
  const toolFiles = [];
  (function walk(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.js')) {
          toolFiles.push(full);
        }
      }
    } catch { /* dir 不存在 */ }
  })(toolsDir);

  for (const file of toolFiles) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    // 提取工具名:优先从 TOOL_NAMES,降级到 getToolDefinitions 的 name: 字段
    let toolName = null;
    const toolNameMatch = content.match(/TOOL_NAMES\s*=\s*\[([^\]]*)\]/);
    if (toolNameMatch) {
      toolName = toolNameMatch[1].match(/'([^']+)'/)?.[1];
    }
    if (!toolName) {
      // 降级:从 name: 'xxx' 提取(如 animtree/navigation 等无 TOOL_NAMES 的工具)
      const nameMatch = content.match(/name:\s*'([a-z_]+)'/);
      if (nameMatch) toolName = nameMatch[1];
    }
    if (!toolName) continue;

    // 用括号匹配提取完整的 properties {...} 块(merged tool 含嵌套对象,正则 [^}] 抓不全)
    // 找每个 "properties: {" 出现位置,括号匹配到对应的 "}"
    const propNames = new Set();
    const propsRegex = /properties:\s*\{/g;
    let propsMatch;
    while ((propsMatch = propsRegex.exec(content)) !== null) {
      const blockStart = propsMatch.index + propsMatch[0].length; // 第一个 { 之后
      const blockBody = extractBalancedBraces(content, blockStart - 1); // 从 { 开始括号匹配
      if (!blockBody) continue;
      // 提取顶层参数名(行首缩进 word: { 模式,含 enum 的 action 也算)
      for (const m of blockBody.matchAll(/^\s*(\w+):\s*\{/gm)) {
        propNames.add(m[1]);
      }
    }
    if (propNames.size > 0) {
      schemas[toolName] = propNames;
    }
  }
  return schemas;
}

/** 从 content[startIdx](必须是 '{') 开始,括号匹配提取到对应的 '}' 的内容(含两侧括号) */
function extractBalancedBraces(content, startIdx) {
  if (content[startIdx] !== '{') return null;
  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') {
      if (!inString) { inString = true; quoteChar = ch; }
      else if (ch === quoteChar) { inString = false; quoteChar = ''; }
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(startIdx, i + 1);
    }
  }
  return null;
}

// ─── drift 检测 ───────────────────────────────────────────────────────────────

function checkDrift() {
  const gdDocs = extractGdDocs();
  const tsSchemas = extractTsSchemas();

  const errors = [];
  const warnings = [];
  let checkedCount = 0;
  let unmappedCount = 0;
  let noToolCount = 0;
  let simplifiedCount = 0;

  for (const [method, gdParams] of Object.entries(gdDocs)) {
    // 无 TS 工具对应的 method(走 GodotServer 直调,豁免)
    if (NO_TOOL_METHODS.has(method)) {
      noToolCount++;
      continue;
    }
    // 已知 schema 简化的 method(merged tool 吸收子工具但 inputSchema 未声明,豁免)
    if (KNOWN_SCHEMA_SIMPLIFIED.has(method)) {
      simplifiedCount++;
      continue;
    }
    const mapping = METHOD_TO_TOOL[method];
    if (!mapping) {
      // method 不在映射表里(应已全覆盖,出现说明遗漏)
      unmappedCount++;
      continue;
    }
    checkedCount++;

    const tsParams = tsSchemas[mapping.tool];
    if (!tsParams) {
      errors.push(`${method} → tool "${mapping.tool}": TS 侧未找到该工具的 inputSchema`);
      continue;
    }

    // 已知重命名映射(GD 旧名 → TS 新名)
    const renames = KNOWN_RENAMES[method] || {};

    // 检查 GD docs 有但 TS 没有的参数(drift:GD 文档过时或 TS 漏加)
    for (const p of gdParams) {
      // 豁免:路由参数 / 已知重命名(GD 名在 renames 里,对应 TS 名存在则不算 drift)
      if (ROUTING_PARAMS.has(p)) continue;
      if (renames[p] && tsParams.has(renames[p])) continue;
      if (!tsParams.has(p)) {
        errors.push(`${method} → ${mapping.tool}: GD docs 有参数 "${p}" 但 TS inputSchema 没有(drift)`);
      }
    }
  }

  return { errors, warnings, checkedCount, unmappedCount, noToolCount, simplifiedCount, totalGdMethods: Object.keys(gdDocs).length };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

const result = checkDrift();

if (result.errors.length > 0) {
  console.error(`[command-docs-drift] ✗ 检测到 ${result.errors.length} 处 drift:`);
  for (const e of result.errors) {
    console.error(`  ${e}`);
  }
  console.error('  修复:同步 GD get_command_docs 与 TS inputSchema 的参数定义');
  console.error('  根因:CMP-16-A docs 与 CMP-9/3/4 等 TS 工具定义漂移');
  process.exit(1);
}

console.log(`[command-docs-drift] ✓ ${result.checkedCount} method 已校验(映射表覆盖),${result.noToolCount} 无 TS 工具(直调豁免),${result.simplifiedCount} schema 简化豁免,${result.unmappedCount} 未映射(应为 0),${result.totalGdMethods} GD docs 总计`);
