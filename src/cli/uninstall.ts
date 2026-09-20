// src/cli/uninstall.ts
/**
 * uninstall 命令 — 卸载清理(install/setup 的反向操作,可移植性评估 2026-09-20 P1)。
 *
 * 三个清理面(默认前两个,--purge 追加第三个):
 *  1. AI 客户端 MCP 注册移除(15 适配器逐个 unconfigure,反向 setup)
 *  2. 项目 addon 移除(addons/godot_mcp_server + project.godot 全部引用 + bridge 残留,
 *     反向 install-plugin / game_bridge_install)
 *  3. --purge:机器级共享状态 ~/.godot-mcp/(下载的 Godot 二进制/实例注册表/web-gui
 *     token/QA 报告/审计日志/遥测 UUID 等)
 *
 * 安全设计:
 *  - 破坏性操作确认链(对齐 setup.ts 非 TTY 阻塞约定):非交互(管道/CI)且未传 --yes
 *    → 拒绝执行 exit 2 并给指引;TTY 逐阶段 confirmYesNo(默认 N);--dry-run 零写入零确认。
 *  - 删共享状态/项目残留前扫 machine registry 判活:在跑实例点名警示
 *    (M-5 判活哲学的 CLI 版——警示不阻塞,卸载语义必须能走完)。
 *  - 项目 addon 判 tool-managed:mcp_bridge.gd 与包内版本不一致(用户自管/git tracked)
 *    则保留并提示,与 game_bridge_uninstall A2 对齐。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs';
import type { Dirent } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ALL_ADAPTERS } from './clients/index.js';
import { confirmYesNo } from './confirm.js';
import { hasFlag, opt } from './args.js';
import { auditClientRemoved, auditCliProjectWrite } from './audit-helper.js';
import { getErrorMessage } from '../types.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { InstanceManager } from '../core/instance-manager.js';
import { writeFileAtomic } from '../core/fs-atomic.js';

/** bridge autoload 双键(game-bridge.ts G-5:新键 + ≤0.23.x 旧带前缀键)。 */
const BRIDGE_AUTOLOAD_KEYS = ['MCPBridge', 'autoload/MCPBridge'] as const;
const BRIDGE_SCRIPT_NAME = 'mcp_bridge.gd';
const ADDON_REL = join('addons', 'godot_mcp_server');

/** 从 project.godot 文本移除本工具全部引用(纯函数,单测锚点)。
 *  ① bridge autoload 双键行(行首精确匹配,对齐 game_bridge_uninstall 的过滤式)
 *  ② [editor_plugins] 段内 enabled=PackedStringArray(...) 去掉 "godot_mcp_server"
 *  ③ 整段删除 [godot_mcp](本工具专属配置段:editor_port 等)
 *  其余行原样保留(含其他插件/其他 autoload)。 */
export function stripAddonReferences(config: string): { text: string; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  // inGodotMcp: 当前在 [godot_mcp] 段内(段 header 与段体都丢弃);inEditorPlugins: 段感知改写 enabled 行
  let inGodotMcp = false;
  let inEditorPlugins = false;
  for (const line of config.split('\n')) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) {
      inGodotMcp = header[1] === 'godot_mcp';
      inEditorPlugins = header[1] === 'editor_plugins';
      if (inGodotMcp) { changed = true; continue; }  // 段 header 丢弃
      out.push(line);
      continue;
    }
    if (inGodotMcp) { changed = true; continue; }  // 段体丢弃
    if (BRIDGE_AUTOLOAD_KEYS.some(k => line.startsWith(k + '='))) { changed = true; continue; }
    if (inEditorPlugins) {
      const rewritten = removeFromEnabledLine(line);
      if (rewritten !== null) { changed = true; out.push(rewritten); continue; }
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

/** enabled=PackedStringArray("a", "godot_mcp_server") → 去掉本工具项。
 *  双形式匹配(审查 Important-1):Godot 4 编辑器启用插件写入的是完整 res:// 路径形式
 *  "res://addons/godot_mcp_server/plugin.cfg";手写/旧 fixture 可能是裸名 "godot_mcp_server"。
 *  只匹配裸名时真实编辑器启用的插件清不掉,addon 删除后残留死引用。
 *  返回 null = 行内无本工具项(原样保留);其余返回改写行(清空保留为 PackedStringArray())。 */
function removeFromEnabledLine(line: string): string | null {
  const m = /^enabled=PackedStringArray\((.*)\)$/.exec(line);
  if (!m) return null;
  const items = m[1]!.split(',').map(s => s.trim()).filter(Boolean);
  const isOurs = (i: string) =>
    i === '"godot_mcp_server"' || i === '"res://addons/godot_mcp_server/plugin.cfg"';
  const kept = items.filter(i => !isOurs(i));
  if (kept.length === items.length) return null;
  return `enabled=PackedStringArray(${kept.join(', ')})`;
}

/** 递归求目录字节数(展示用;symlink 跳过不跟随,对齐 doctor listAddonFiles 防逃逸)。 */
export function dirSizeBytes(root: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) total += dirSizeBytes(p);
    else {
      try { total += statSync(p).size; } catch { /* 权限/竞态忽略 */ }
    }
  }
  return total;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 扫 machine registry 判活(纯展示+警示;读取失败视为无活实例——卸载语义不被阻塞)。 */
async function findAliveInstances(): Promise<{ project: string; port: number; pid: number }[]> {
  try {
    const mgr = new InstanceManager();
    const all = await mgr.loadFromRegistry();
    return all
      .filter(i => mgr.getStatus(i) === 'alive')
      .map(i => ({ project: i.projectPath, port: i.port, pid: i.pid }));
  } catch {
    return [];
  }
}

export async function runUninstall(args: string[]): Promise<void> {
  const dryRun = hasFlag(args, 'dry-run');
  const assumeYes = hasFlag(args, 'yes');
  const purge = hasFlag(args, 'purge');
  const projectDir = resolve(opt(args, 'project') ?? process.cwd());

  console.log('🧹 godot-mcp-enhanced uninstall');
  if (dryRun) console.log('(dry-run:仅列出将执行的操作,零写入)\n');

  // ── Phase 0:在跑实例判活(警示,不阻塞——对齐 game_bridge_uninstall M-5 的卸载侧不对称)──
  const alive = await findAliveInstances();
  if (alive.length > 0) {
    console.log(`⚠ 检测到 ${alive.length} 个在跑实例(建议先关闭再卸载,避免注册表/secret 半清理):`);
    for (const a of alive) console.log(`    - ${a.project} (port ${a.port}, pid ${a.pid})`);
    console.log('');
  }

  // ── 确认门:非交互且未显式 --yes → 拒绝(对齐 setup.ts TTY 引导约定)──
  if (!dryRun && !assumeYes && !process.stdin.isTTY) {
    console.error('非交互环境检测到,破坏性操作需显式确认。');
    console.error('  预览(零写入): npx godot-mcp-enhanced uninstall --dry-run');
    console.error('  执行:        npx godot-mcp-enhanced uninstall --yes [--purge]');
    process.exit(EXIT_CODES.EXIT_USAGE);
  }
  const confirm = async (question: string): Promise<boolean> =>
    (dryRun || assumeYes) ? true : await confirmYesNo(question);

  // ── Phase 1:AI 客户端 MCP 注册移除 ──
  // 审查 Important-3:Phase 1 自带确认门——antigravity/codex 等是 global scope(改用户全局
  // 配置),不能无确认直接改写;dry-run/--yes 下 confirm 短路 true 零成本。
  console.log(`\nAI Clients(项目目录: ${projectDir}):`);
  let clientsRemoved = 0;
  if (!(await confirm('移除全部已配置 AI 客户端的 godot MCP 注册?(含 global scope 客户端的用户级配置)'))) {
    console.log('  ⊘ 已跳过(用户取消)');
  } else {
    for (const adapter of ALL_ADAPTERS) {
      if (!(await adapter.detect())) { console.log(`  ⊘ ${adapter.name}: 未安装`); continue; }
      if (typeof adapter.unconfigure !== 'function') { console.log(`  ⊘ ${adapter.name}: 不支持移除(旧版适配器)`); continue; }
      if (dryRun) {
        console.log(await adapter.isConfigured(projectDir)
          ? `  - ${adapter.name}: 将移除 godot 注册`
          : `  ⊘ ${adapter.name}: 未配置`);
        continue;
      }
      try {
        const removed = await adapter.unconfigure(projectDir);
        if (removed) {
          clientsRemoved++;
          auditClientRemoved(adapter.name, adapter.scope, projectDir);
        }
        console.log(removed ? `  ✓ ${adapter.name}: 已移除` : `  ⊘ ${adapter.name}: 未配置`);
      } catch (err) {
        console.error(`  ✗ ${adapter.name}: ${getErrorMessage(err)}`);
      }
    }
    if (!dryRun) console.log(`  小计: ${clientsRemoved} 个客户端注册已移除。`);
  }

  // ── Phase 2:项目 addon 移除(先探测目标,有可删项才确认——空项目不弹确认)──
  console.log('\nProject addon:');
  const addonDir = join(projectDir, ADDON_REL);
  const hasAddon = existsSync(addonDir);
  const projectGodot = join(projectDir, 'project.godot');
  const hasProjectGodot = existsSync(projectGodot);
  // 预读引用存在性(confirm 前只读)
  const stripResult = hasProjectGodot ? stripAddonReferences(readFileSync(projectGodot, 'utf-8')) : null;
  const hasReferences = stripResult?.changed ?? false;
  const scriptPath = join(projectDir, BRIDGE_SCRIPT_NAME);
  // 包根定位在函数内(对齐 doctor.ts runDoctor 内 __pkgRoot 模式)——模块级 `_` 前缀声明
  // 会命中 defects 谓词 module-level-mutable-state 的保守计数;
  // 打包布局里 .gd 运行时脚本在 build/scripts/(package.json files:build/scripts/*.gd)
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bundledScript = join(pkgRoot, 'build', 'scripts', BRIDGE_SCRIPT_NAME);
  const scriptToolManaged = existsSync(scriptPath) && existsSync(bundledScript)
    && readFileSync(bundledScript, 'utf-8') === readFileSync(scriptPath, 'utf-8');
  const godotDir = join(projectDir, '.godot');
  const secrets = existsSync(godotDir)
    ? readdirSync(godotDir).filter(n => /^mcp_bridge_\d+\.secret$/.test(n)) : [];
  const residue = ['mcp-instances', 'mcp-godot.json'].filter(rel => existsSync(join(godotDir, rel)));

  if (existsSync(scriptPath) && !scriptToolManaged) {
    console.log(`  ! ${BRIDGE_SCRIPT_NAME} 与包内版本不一致(用户自管/git tracked)——保留,需要请手动删`);
  }
  if (!hasAddon && !hasReferences && !scriptToolManaged && secrets.length === 0 && residue.length === 0) {
    console.log('  ⊘ 未发现项目 addon/引用/残留(已清理或非 Godot 项目目录)');
  } else if (!(await confirm(`移除项目内全部 godot-mcp 组件(${addonDir} 及引用/残留)?`))) {
    console.log('  ⊘ 已跳过(用户取消)');
  } else {
    const changedFiles: string[] = [];
    if (hasReferences && stripResult) {
      if (dryRun) console.log('  - 将清理 project.godot 引用(autoload/editor_plugins/[godot_mcp])');
      else {
        writeFileAtomic(projectGodot, stripResult.text);
        changedFiles.push('project.godot');
        console.log('  ✓ project.godot 引用已清理');
      }
    }
    if (hasAddon) {
      if (dryRun) console.log(`  - 将删除 ${addonDir}(${readdirSync(addonDir).length} 项)`);
      else {
        rmSync(addonDir, { recursive: true, force: true });
        changedFiles.push('addons/godot_mcp_server');
        console.log('  ✓ addons/godot_mcp_server 已删除');
      }
    }
    if (scriptToolManaged) {
      if (dryRun) console.log(`  - 将删除 ${BRIDGE_SCRIPT_NAME}(及伴生 .uid)`);
      else {
        unlinkSync(scriptPath);
        const uidPath = scriptPath + '.uid';
        if (existsSync(uidPath)) { try { unlinkSync(uidPath); } catch { /* best effort */ } }
        changedFiles.push(BRIDGE_SCRIPT_NAME);
        console.log(`  ✓ ${BRIDGE_SCRIPT_NAME} 已删除`);
      }
    }
    if (secrets.length > 0) {
      if (dryRun) console.log(`  - 将删除 ${secrets.length} 个 bridge secret`);
      else {
        for (const name of secrets) { try { unlinkSync(join(godotDir, name)); } catch { /* best effort */ } }
        console.log(`  ✓ bridge secret 已删除(${secrets.length} 个)`);
      }
    }
    for (const rel of residue) {
      if (dryRun) console.log(`  - 将删除 .godot/${rel}`);
      else {
        rmSync(join(godotDir, rel), { recursive: true, force: true });
        changedFiles.push(`.godot/${rel}`);
        console.log(`  ✓ .godot/${rel} 已删除`);
      }
    }
    if (!dryRun && changedFiles.length > 0) {
      auditCliProjectWrite(projectDir, 'uninstall_addon', changedFiles, undefined, 'cli:uninstall');
    }
  }

  // ── Phase 3:--purge 机器级共享状态 ──
  if (!purge) {
    console.log('\n(共享状态 ~/.godot-mcp/ 未清理——加 --purge 一并移除,含下载的 Godot 二进制)');
  } else {
    console.log('\nMachine state(--purge):');
    const stateDir = join(homedir(), '.godot-mcp');
    if (!existsSync(stateDir)) {
      console.log('  ⊘ ~/.godot-mcp/ 不存在,无需清理');
    } else if (!(await confirm(`删除 ~/.godot-mcp/ 全部共享状态(含下载的 Godot 二进制,${fmtBytes(dirSizeBytes(stateDir))})?`))) {
      console.log('  ⊘ 已跳过(用户取消)');
    } else if (dryRun) {
      for (const e of readdirSync(stateDir, { withFileTypes: true })) {
        console.log(`  - ~/.godot-mcp/${e.name}${e.isDirectory() ? '/' : ''}`);
      }
    } else {
      // 注:purge 不写机器审计——machine-audit.jsonl 本身在删除范围内,先写后删无意义
      try {
        rmSync(stateDir, { recursive: true, force: true });
        console.log('  ✓ ~/.godot-mcp/ 已删除');
      } catch (err) {
        console.error(`  ✗ 删除失败(可能有文件被占用,关闭在跑实例后重试): ${getErrorMessage(err)}`);
      }
    }
  }

  // ── Footer:npm 包本体指引(npx 临时进程无法自删全局安装)──
  console.log('\nNext steps:');
  console.log('  npm 全局安装的包本体(如有)请手动移除: npm uninstall -g godot-mcp-enhanced');
  console.log('  npx 方式使用无需清理(临时进程,不驻留)。');
}
