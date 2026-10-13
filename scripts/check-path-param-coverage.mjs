#!/usr/bin/env node
// scripts/check-path-param-coverage.mjs — M-1 (2026-10-13 全维度审查)
//
// 背景:src/core/ToolDispatcher.ts validatePathArgs 仅强制校验根级 project_path/
// search_dir;其余路径参数(file_path/script_path/scene_path 等)由各工具自行调
// resolveWithinRoot——「新增工具须确保路径参数经过 resolveWithinRoot,否则绕过根
// 限制」此前靠纪律维持(审查 M-1:结构性缺口)。本守护把该约束机械化:
//
//   声明了文件系统路径参数(schema 属性名匹配 FS_PARAM_RE)的工具源文件,必须
//   import core/path-utils(resolveWithinRoot/isPathInAllowedRoots),或满足自动
//   豁免(参数 ⊆ AUTO_OK),或在 ALLOWLIST(人工核对,附理由)。
//
// 分级:
//   AUTO_OK     = {project_path, godot_path}——dispatcher validatePathArgs 强制
//                 isPathInAllowedRoots + godot-finder origin='override' 白名单
//                 (M-2, 2026-10-13),双重通道管辖,无需文件级 import。
//   NON_FS      = 场景树/动画轨道等非文件系统路径(不由 ALLOWED_PROJECT_PATHS 管
//                 辖):node_path/track_path/root_path/body_path/animation_player_path 等。
//   ALLOWLIST   = 首轮(2026-10-13)人工逐文件核对的豁免,理由见各条注释。
//
// 模式:默认 advisory(exit 0);--strict 时差集 - ALLOWLIST 非空 exit 1。
// 接线:npm run check:path-coverage(CI 未接,观察期;差集清零后可升 strict 接 CI)。
//
// 已知边界(诚实声明):正则静态匹配,识别不了「参数经二次包装传共享层」的间接
// 防护——ALLOWLIST 条目注释写清下游校验位置,防豁免清单烂掉。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FS_PARAM_RE = /^\s*(?:[a-z][a-z0-9_]*_path|[a-z][a-z0-9_]*_dir(?:ector(?:y|ies))?|[a-z][a-z0-9_]*_file|path|file|dir|directory|destination)\s*:\s*\{/;

// 非 FS 语义(场景树节点/动画轨道/搜索根节点等)——同名不同义时该文件走 ALLOWLIST 人工裁决
const NON_FS_PARAMS = new Set([
  'node_path', 'track_path', 'parent_path', 'signal_path',
  'root_path',            // animation list_players 搜索起始节点路径
  'body_path',            // physics PhysicsBody3D 节点路径
  'animation_player_path', // animtree AnimationPlayer 节点路径
]);

// 双重通道自动管辖(见头部注释)
const AUTO_OK = new Set(['project_path', 'godot_path']);

const IMPORT_PATH_UTILS_RE = /from\s+['"][^'"]*path-utils\.js['"]/;

// 首轮人工核对(2026-10-13,全维度审查 M-1 落地批):
const ALLOWLIST = new Set([
  // ref_path/cand_path 由下游 layout-compare.ts resolveListedPath 校验(该文件已 import path-utils)
  'src/tools/analysis/index.ts',
  // stream_path 为 res:// 域,sanitizeResPath 防 traversal(本文件 :183-185)
  'src/tools/audio-ops.ts',
  // source_path 为 DAP 断点源路径(res:// 相对经 project_path 转绝对),仅送本地 editor
  // DAP 通道,无文件读写;已知低危残留(威胁模型:editor 调试器须用户主动开启)
  'src/tools/dap.ts',
  // path 为 res:// .gd 脚本路径(editor 断点域)
  'src/tools/debug.ts',
  // source_script_path 由 core/overrides.ts PathError 链校验;path 为节点路径;
  // 覆盖率排除文件(Linux CI)
  'src/tools/game-bridge.ts',
  // file_path/shader_path/resource_path 均为 res:// 域(requireResPath,:716/:721)
  'src/tools/material-ops.ts',
  // export_* action 委托 validation.ts(已 import path-utils,:75);path 为 assert 节点路径
  'src/tools/test-framework.ts',
  // path 为 res:// 相对单文件(uid set)
  'src/tools/uid-ops.ts',
  // source_path/target_path 为信号连接的源/目标**节点**路径(非 FS)
  'src/tools/signal-ops.ts',
  // 入口路由文件:schema 声明 script_path,实现在 script/{edit,read,write}.ts(均已
  // import path-utils)
  'src/tools/script.ts',
]);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e.startsWith('.')) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (e.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const strict = process.argv.includes('--strict');
const files = [
  ...walk(join(ROOT, 'src', 'tools')),
  ...readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.ts')).map(f => join(ROOT, 'src', f)),
];

const violations = [];
for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, '/');
  if (ALLOWLIST.has(rel)) continue;
  let text;
  try { text = readFileSync(full, 'utf-8'); } catch { continue; }
  if (IMPORT_PATH_UTILS_RE.test(text)) continue;
  const fsParams = [...new Set(
    text.split('\n')
      .map(l => FS_PARAM_RE.exec(l)?.[0]?.trim().replace(/\s*:\s*\{$/, ''))
      .filter(p => p && !NON_FS_PARAMS.has(p)),
  )];
  if (fsParams.length === 0) continue;
  const leftover = fsParams.filter(p => !AUTO_OK.has(p));
  if (leftover.length === 0) continue;   // 仅 project_path/godot_path:双重通道管辖
  violations.push({ rel, fsParams: leftover });
}

console.log(`[check-path-param-coverage] 扫描 ${files.length} 个 TS 文件,${violations.length} 个声明 FS 路径参数但未 import path-utils 且不在豁免清单:`);
for (const v of violations) {
  console.log(`  - ${v.rel}  [params: ${v.fsParams.join(', ')}]`);
}
if (violations.length === 0) {
  console.log('  (无——新增工具若声明 FS 路径参数,须 import path-utils 或在 ALLOWLIST 登记理由)');
  process.exit(0);
}
if (strict) {
  console.error('\n[check-path-param-coverage] STRICT 模式:存在未核对差集,exit 1。逐条人工核对后回填 ALLOWLIST(附理由)。');
  process.exit(1);
}
console.log('\n[check-path-param-coverage] advisory 模式(默认):仅报告,exit 0。');
process.exit(0);
