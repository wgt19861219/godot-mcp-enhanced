import { existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runGodotHeadless } from '../core/godot-spawn.js';
import type { GdscriptReport } from './types.js';

// ===== 可单测纯函数 =====

const RE_ERROR = /^(?:SCRIPT ERROR:|.*-\s*(?:Parse|Compile) Error:)/;
const RE_WARN = /^(?:WARNING:|.*-\s*Warning:)/;
const MAX_DETAILS = 20;

/** 解析 Godot stdout+stderr → errors/warnings/details。未知行不计数不崩。 */
export function parseGdscriptOutput(combined: string): { errors: number; warnings: number; details: string[]; detailsTotal: number } {
  const errorLines: string[] = [];
  const warnLines: string[] = [];
  for (const line of combined.split('\n')) {
    if (RE_ERROR.test(line)) errorLines.push(line.trim());
    else if (RE_WARN.test(line)) warnLines.push(line.trim());
  }
  const errors = errorLines.length;
  const warnings = warnLines.length;
  const details = [...errorLines, ...warnLines].slice(0, MAX_DETAILS);
  return { errors, warnings, details, detailsTotal: errors + warnings };
}

/** 从源 .gd 文本(传入文件内容 map,避免 IO)提取 class_name 列表 */
export function extractClassNames(files: string[], contents: Record<string, string>): string[] {
  const names: string[] = [];
  for (const f of files) {
    const m = contents[f]?.match(/^\s*class_name\s+(\w+)/m);
    const name = m?.[1];
    if (name) names.push(name);
  }
  return names;
}

/** 递归 glob .gd。跳过 symlink 目录(B6:isDirectory() 会跟随 symlink,需显式 isSymbolicLink 排除防逃逸)。 */
export function listGd(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;  // B6:不跟随 symlink(防逃逸出 root)
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...listGd(p));
    else if (e.name.endsWith('.gd')) out.push(p);
  }
  return out;
}

/** 递归收集插件加载面非脚本资产(.cfg/.tscn)。2026-10-22 审查 Major-F1:
 *  syncCheckProjectFixture 原只拷 .gd,plugin.cfg 与 ui/status_panel.tscn 不随链填充,
 *  而 fixture addons/ 被 .gitignore → CI 全新 checkout 上 project.godot 的 enabled 指向
 *  不存在的 plugin.cfg,插件(含 preload status_panel.tscn 链)实际从未启用,check:gdscript
 *  的编辑器模式覆盖在 CI 落空。symlink 排除同 listGd。 */
export function listPluginAssets(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...listPluginAssets(p));
    else if (e.name.endsWith('.cfg') || e.name.endsWith('.tscn')) out.push(p);
  }
  return out;
}

// ===== main(IO 层) =====

const SRC_ADDON = resolve(process.cwd(), 'addons', 'godot_mcp_server');
// I-3 (P2-4 审查): 扩编译范围到 src/scripts/(mcp_bridge.gd 等运行时脚本)。
// 原只编译 addons/,漏 src/scripts/mcp_bridge.gd(P2-4 五个 _cmd_playtest_* 主战场),
// 致 BLOCKED_PROPERTIES 漂移(B-1)静默通过。两目录都拷进 CHECK_PROJECT 让 Godot --import 编译。
const SRC_SCRIPTS = resolve(process.cwd(), 'src', 'scripts');
const CHECK_PROJECT = resolve(process.cwd(), 'test', 'fixtures', 'gdscript-check');
const CHECK_ADDON = resolve(CHECK_PROJECT, 'addons', 'godot_mcp_server');
const CHECK_SCRIPTS = resolve(CHECK_PROJECT, 'src', 'scripts');
const REPORT_OUT = resolve(process.cwd(), 'coverage', 'gdscript-report.json');

function writeReport(r: GdscriptReport): void {
  mkdirSync(dirname(REPORT_OUT), { recursive: true });
  writeFileSync(REPORT_OUT, JSON.stringify(r, null, 2) + '\n', 'utf8');
  process.stdout.write(`gdscript report → ${REPORT_OUT} (errors=${r.errors} warnings=${r.warnings}${r.incomplete ? ' INCOMPLETE' : ''})\n`);
}

/**
 * 将 addons/godot_mcp_server + src/scripts 复制进 gdscript-check fixture(幂等覆盖拷贝)。
 * fixture 的这两处目录被 .gitignore(运行时拷贝产物),供 main 与 vitest globalSetup
 * (test/global-setup.ts)共用——CI check job 的 vitest 跑在本脚本之前,不填充则
 * Godot load() 得 null → SCRIPT ERROR → SceneTree _init 中断 quit() 不执行 → 挂死超时。
 */
export function syncCheckProjectFixture(): { addonFiles: string[]; scriptFiles: string[]; assetFiles: string[] } {
  const addonFiles = listGd(SRC_ADDON);
  const scriptFiles = listGd(SRC_SCRIPTS);
  // Major-F1 (2026-10-22): plugin.cfg/status_panel.tscn 等插件加载面资产必须随链填充,
  // 否则 CI 全新 checkout 上插件悬空启用(fixture addons/ 不进 git,本地残留会掩盖断链)。
  const assetFiles = listPluginAssets(SRC_ADDON);
  mkdirSync(CHECK_ADDON, { recursive: true });
  for (const f of addonFiles) {
    const dst = resolve(CHECK_ADDON + f.slice(SRC_ADDON.length));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
  }
  for (const f of assetFiles) {
    const dst = resolve(CHECK_ADDON + f.slice(SRC_ADDON.length));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
  }
  mkdirSync(CHECK_SCRIPTS, { recursive: true });
  for (const f of scriptFiles) {
    const dst = resolve(CHECK_SCRIPTS + f.slice(SRC_SCRIPTS.length));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
  }
  return { addonFiles, scriptFiles, assetFiles };
}

async function main(): Promise<void> {
  const godotPath = process.env.GODOT_PATH || '';

  // ① GODOT_PATH 缺失 → incomplete + stderr 告警(IMPORTANT-9b,非静默跳过)
  if (!godotPath || !existsSync(godotPath)) {
    process.stderr.write(
      `[M3c] GODOT_PATH 缺失或不存在 (${godotPath}) — gdscript 检查未执行,产出 incomplete report。\n` +
      `  设置 GODOT_PATH 启用。未设时 gdscript 维度会硬否决(非静默跳过,防 CI 假绿)。\n`,
    );
    writeReport({ errors: 0, warnings: 0, files: 0, details: [], detailsTotal: 0,
                  incomplete: true, reason: `GODOT_PATH 缺失: ${godotPath}` });
    return;
  }

  // ② 复制 addon + src/scripts 进检查项目(每次新拷最新源)
  const { addonFiles, scriptFiles } = syncCheckProjectFixture();
  const expected = addonFiles.length + scriptFiles.length;

  // ②b Major-F1 自检(2026-10-22):填充后插件加载面必须在场。enabled 指向缺失
  // plugin.cfg 时 Godot 只输出 core 层 ERROR(不匹配 RE_ERROR),CI 会假绿——
  // 以 incomplete 硬否决显式暴露断链,而非静默漏编译插件加载面。
  if (!existsSync(join(CHECK_ADDON, 'plugin.cfg'))) {
    process.stderr.write(
      '[Major-F1] fixture 同步后 plugin.cfg 缺失——插件加载面供给链断链,编辑器模式覆盖不可信。\n',
    );
    writeReport({ errors: 0, warnings: 0, files: 0, details: [], detailsTotal: 0,
                  incomplete: true, reason: 'fixture plugin.cfg missing after sync (plugin enable surface broken)' });
    return;
  }

  // ③ runGodotHeadless --import(复用 helper,继承 forceKillTree)
  let result;
  try {
    result = await runGodotHeadless(['--headless', '--import', '--path', CHECK_PROJECT], godotPath, 120_000);
  } catch (e) {
    writeReport({ errors: 0, warnings: 0, files: expected, details: [], detailsTotal: 0,
                  incomplete: true, reason: `spawn 失败: ${(e as Error).message}` });
    return;
  }

  // ④ 解析 stdout+stderr(部分版本错误走 stdout)
  const parsed = parseGdscriptOutput(result.stdout + '\n' + result.stderr);

  // ⑤ false negative 断言:setup 坏 → incomplete(不产出虚假 0/0)
  // files 断言(I-3:含 addon + src/scripts 两处)
  const checkFiles = [...listGd(CHECK_ADDON), ...listGd(CHECK_SCRIPTS)];
  if (checkFiles.length !== expected) {
    writeReport({ ...parsed, files: checkFiles.length, incomplete: true,
                  reason: `files 断言失败: 检查项目 ${checkFiles.length} ≠ 源 ${expected}` });
    return;
  }
  // class cache 断言(全部源 class_name 在 cache;当前仅 CommandHelpers)
  const srcContents: Record<string, string> = {};
  for (const f of addonFiles) srcContents[f] = readFileSync(f, 'utf8');
  const srcClassNames = extractClassNames(addonFiles, srcContents);
  if (srcClassNames.length > 0) {
    let cache = '';
    try { cache = readFileSync(resolve(CHECK_PROJECT, '.godot', 'global_script_class_cache.cfg'), 'utf8'); } catch { /* 未生成 */ }
    const missing = srcClassNames.filter(n => !cache.includes(n));
    if (missing.length > 0) {
      writeReport({ ...parsed, files: expected, incomplete: true,
                    reason: `class cache 缺: ${missing.join(', ')}(plugin 未加载?)` });
      return;
    }
  }

  // ⑥ 正常产出
  writeReport({ ...parsed, files: expected });
}

// 仅当直接执行(非 import)时跑 main(ESM 版,对齐 cli.ts:10-13 invoked 模式)
const entry = fileURLToPath(import.meta.url);
const arg1 = process.argv[1];
const invoked = arg1 !== undefined && resolve(arg1) === entry;
if (invoked) {
  main().catch(e => { process.stderr.write(`check-gdscript 失败: ${(e as Error).stack ?? e}\n`); process.exit(1); });
}
