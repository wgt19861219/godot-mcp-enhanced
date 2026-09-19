/** doctor 命令 — 环境诊断 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { findGodot, detectGodotVersion } from '../core/godot-finder.js';
import { ALL_ADAPTERS } from './clients/index.js';
import { readJsonForCheck } from './clients/json-config.js';

function status(ok: boolean, msg: string): string {
  return ok ? `  ✓ ${msg}` : `  ✗ ${msg}`;
}

// warn 标记(审查 Nit #2):OUT OF SYNC 是 non-blocking 提示,用 ! 而非 ✗(✗ 暗示 error 但 exit 0)
function warn(msg: string): string {
  return `  ! ${msg}`;
}

// 易用性批4 (2026-09-19):「不适用」中性标记(⊘ 对齐 setup.ts 用词)——未安装的客户端/
// 非 Godot 目录里的项目结构检查,此前用 ✗ 误导用户以为环境出错(且 exit 0 加深困惑)
function na(msg: string): string {
  return `  ⊘ ${msg}`;
}

// ─── Addons 同步检查纯函数(可单测,对齐 check-gdscript.ts listGd 模式) ───

/** 递归列 addons 目录下所有文件(非仅 .gd,含 plugin.cfg/.tscn)。
 *  跳过 symlink 目录(check-gdscript B6 防逃逸,防 symlink 跳出 root)。 */
export function listAddonFiles(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;  // B6:不跟随 symlink(防逃逸出 root)
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...listAddonFiles(p));
    else out.push(p);
  }
  return out;
}

export interface AddonSyncResult {
  inSync: boolean;
  fileCount: number;    // 上游文件数(基准)
  missing: string[];    // 上游有目标无(相对路径)
  differing: string[];  // 两边有但内容不同(相对路径)
  extra: string[];      // 目标有上游无(信息项,不报为不同步)
}

/** 对比上游 vs 目标 addons 目录。内容对比用 readFileSync + ===(addons 文件小无需 hash)。 */
export function compareAddons(upstream: string, target: string): AddonSyncResult {
  const upstreamFiles = listAddonFiles(upstream).map(f => relative(upstream, f).replace(/\\/g, '/'));
  const targetFiles = listAddonFiles(target).map(f => relative(target, f).replace(/\\/g, '/'));
  const upstreamSet = new Set(upstreamFiles);
  const targetSet = new Set(targetFiles);

  const missing = upstreamFiles.filter(f => !targetSet.has(f));
  const extra = targetFiles.filter(f => !upstreamSet.has(f));
  const differing: string[] = [];
  for (const f of upstreamFiles) {
    if (!targetSet.has(f)) continue;  // 已在 missing
    // 行尾归一(审查 Nit #1):仓库 .gitattributes 强制 LF,但目标项目不受管辖,
    // Windows 用户 cp/编辑器写回可能 CRLF。字节级 === 会误报,先统一 \r\n → \n。
    const upContent = readFileSync(join(upstream, f), 'utf-8').replace(/\r\n/g, '\n');
    const tgtContent = readFileSync(join(target, f), 'utf-8').replace(/\r\n/g, '\n');
    if (upContent !== tgtContent) differing.push(f);
  }
  // differing 排序保证输出稳定(测试可断言顺序)
  differing.sort();
  return {
    inSync: missing.length === 0 && differing.length === 0,
    fileCount: upstreamFiles.length,
    missing, differing, extra,
  };
}

// A-09: 区分"未配置"和"配置损坏"两种状态
async function checkClientConfig(adapter: { name: string; isConfigured(projectDir: string): Promise<boolean> }, projectDir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const ok = await adapter.isConfigured(projectDir);
    return { ok, detail: ok ? 'configured' : 'not configured' };
  } catch {
    return { ok: false, detail: 'config parse error (file may be corrupted)' };
  }
}

export async function runDoctor(_args: string[]): Promise<void> {
  let hasError = false;

  // 上游 addon 定位:从 build/cli/doctor.js 回溯到包根(对齐 router.ts:6 __rootDir 模式)
  const __cliDir = dirname(fileURLToPath(import.meta.url));
  const __pkgRoot = join(__cliDir, '..', '..');
  const UPSTREAM_ADDON = join(__pkgRoot, 'addons', 'godot_mcp_server');

  // 1. Node.js 版本
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]!, 10);
  console.log(status(nodeMajor >= 20, `Node.js ${nodeVersion}${nodeMajor >= 20 ? '' : ' (requires >= 20, 对齐 package.json engines)'}`));
  if (nodeMajor < 20) hasError = true;

  // 2. Godot 发现 + 版本兼容
  // 易用性批4 (2026-09-19):版本不查时,装 Godot 3.x 的用户 doctor 全绿但工具全挂
  // (本项目支持 4.5–4.7)。detectGodotVersion 会 throw(白名单拒/--version 失败),须 try-catch。
  const projectDir = process.cwd();
  try {
    const godotPath = await findGodot();
    console.log(status(true, `Godot found: ${godotPath}`));
    try {
      const ver = await detectGodotVersion(godotPath);  // 如 "4.7.2.stable"
      const m = /^(\d+)\.(\d+)/.exec(ver);
      const major = m ? parseInt(m[1]!, 10) : 0;
      const minor = m ? parseInt(m[2]!, 10) : 0;
      if (major === 4 && minor >= 5 && minor <= 7) {
        console.log(status(true, `Godot version ${ver} (supported 4.5–4.7)`));
      } else if (major === 4 && minor > 7) {
        console.log(warn(`Godot version ${ver} > 4.7 — 未验证兼容,遇异常可回退 4.7.x`));
      } else {
        console.log(status(false, `Godot version ${ver} unsupported (requires 4.5–4.7)`));
        hasError = true;
      }
    } catch {
      console.log(warn('Godot version check skipped (--version 调用失败或路径被白名单拒)'));
    }
  } catch {
    console.log(status(false, 'Godot not found (set GODOT_PATH 或运行 `install` 自动安装)'));
    hasError = true;
  }

  // 2.7 ALLOWED_PROJECT_PATHS 可见性(易用性批4)
  // 未设是合法默认(deny-by-default 限 cwd)——warn 不 fail;多项目用户易踩
  // "路径越界 forbidden",提前给出配置方式
  const allowedRoots = process.env.ALLOWED_PROJECT_PATHS;
  if (allowedRoots) {
    console.log(status(true, `ALLOWED_PROJECT_PATHS set (${allowedRoots.split(';').length} root(s))`));
  } else {
    console.log(warn('ALLOWED_PROJECT_PATHS not set — deny-by-default(仅当前工作目录可访问)。多项目使用时在 MCP 配置 env 设置:ALLOWED_PROJECT_PATHS="D:/proj/A;D:/proj/B"'));
  }

  // 2.7b GODOT_MCP_ALLOWED_GODOT_PATHS 可见性(2026-09-19 安全加固 D2 裁决 (a) 组成)
  // 未设为 back-compat 放行(godot-finder.ts isGodotPathAllowed:env 与 godot-paths.json
  // 皆空=放行+签名校验兜底)——warn 不 fail;显式设置可硬隔离"AI 可控 godot_path 参数
  // 指向任意二进制被 spawn"面(评估完整 M5)
  const allowedGodot = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
  if (allowedGodot) {
    console.log(status(true, `GODOT_MCP_ALLOWED_GODOT_PATHS set (${allowedGodot.split(';').length} path(s))`));
  } else {
    console.log(warn('GODOT_MCP_ALLOWED_GODOT_PATHS not set — back-compat 放行(签名校验兜底)。收紧 godot 二进制白名单可设置:GODOT_MCP_ALLOWED_GODOT_PATHS="C:/Program Files/Godot;D:/godot"'));
  }

  // 2.5. 项目级 Godot 覆盖
  const mcpConfigPath = join(projectDir, '.godot', 'mcp-godot.json');
  const config = readJsonForCheck(mcpConfigPath) as { godot_path?: string } | null;
  if (config?.godot_path) {
    console.log(status(existsSync(config.godot_path), `Project Godot override: ${config.godot_path}`));
  }

  // 3. AI 客户端
  console.log('\nAI Clients:');
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(na(`${adapter.name} (${adapter.scope}): not installed`));
      continue;
    }
    // A-09: 区分配置状态;易用性批4:not configured 补修复指引
    const { ok, detail } = await checkClientConfig(adapter, projectDir);
    console.log(ok
      ? status(true, `${adapter.name} (${adapter.scope}): ${detail}`)
      : status(false, `${adapter.name} (${adapter.scope}): ${detail} — 修复: npx godot-mcp-enhanced setup 或 configure ${adapter.name.toLowerCase().replace(/\s+/g, '-')}`));
  }

  // 4. 项目结构(易用性批4:非 Godot 目录里这两项用 ⊘ 中性标记而非 ✗)
  console.log('\nProject:');
  const hasProject = existsSync(join(projectDir, 'project.godot'));
  console.log(hasProject
    ? status(true, 'project.godot found')
    : na('project.godot not found — 非 Godot 项目目录(在项目根运行 doctor 检查项目结构)'));

  const hasClaudeMd = existsSync(join(projectDir, 'CLAUDE.md'));
  console.log(hasClaudeMd
    ? status(true, 'CLAUDE.md found')
    : na('CLAUDE.md not found — AI 客户端连接项目后运行 setup_project_rules 可生成'));

  // 5. Addons 同步(上游包 vs 目标项目)— 项目待办 :150
  // warn 不 fail:同步漂移是"可能的问题提示"非环境错误,用户改 addon 后理应手动 cp,不阻断 doctor
  console.log('\nAddons sync:');
  const targetAddon = join(projectDir, 'addons', 'godot_mcp_server');
  if (!existsSync(targetAddon)) {
    console.log(status(true, 'addons/godot_mcp_server not in project (skip sync check)'));
  } else if (!existsSync(UPSTREAM_ADDON)) {
    console.log(status(true, 'upstream addon not accessible (dev mode without package root, skip)'));
  } else {
    const result = compareAddons(UPSTREAM_ADDON, targetAddon);
    if (result.inSync) {
      console.log(status(true, `addons/godot_mcp_server in sync (${result.fileCount} files)`));
    } else {
      // warn 非 fail(审查 Nit #2):用 ! 标记 non-blocking,hasError 不置 true
      console.log(warn(`addons/godot_mcp_server OUT OF SYNC (${result.missing.length} missing, ${result.differing.length} modified, ${result.extra.length} extra) — non-blocking`));
      for (const f of result.missing) console.log(`      - ${f} (missing in project)`);
      for (const f of result.differing) console.log(`      ~ ${f} (content differs from upstream)`);
    }
  }

  // 易用性批4:结尾一行下一步(两出口共享,弥补此前"满屏 ✗ 却不知道怎么办")
  console.log('\nNext steps: 配置客户端 `npx godot-mcp-enhanced setup` / 定向 `configure <客户端>`;验证链路:AI 客户端内调用 get_godot_version。');

  if (hasError) process.exit(1);
}
