// Web GUI per-pid 登记(设计 §3.1):每实例写自己的 ~/.godot-mcp/web-gui/<pid>.json,
// 无并发写竞争(对齐 InstanceManager 模式);文件含 token 准入凭证,权限加固防同机他用户读取。

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../core/logger.js';
// 循环 import 声明(portal.ts ⇄ registry.ts):双方均只在函数体内互调、模块顶层零解引用,
// ESM live bindings 下加载时序安全——portal 顶层只用 import 声明,registry 同款。
import { ensurePackageRootEntry, PROJECT_ENTRY_NAME } from './portal.js';

export interface WebGuiRegistration {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface RegistryOpts {
  /** 测试注入目录;缺省 ~/.godot-mcp/web-gui/ */
  dir?: string;
  /** pid 探活注入点(测试 mock);缺省 process.kill(pid, 0) */
  isPidAlive?: (pid: number) => boolean;
}

export function webGuiRegistryDir(): string {
  return join(homedir(), '.godot-mcp', 'web-gui');
}

/** 共享 token 形状(导出复用:portal.ts 内嵌前同款校验,单一校验来源)。 */
export const SHARED_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * 共享持久 token(2026-09-16 入口简化批):registry 目录一份 token.txt,首实例生成后续复用。
 * 动机:原 token 每进程随机生成,server 重启即换 → 旧面板 cookie 立即作废(入口不自愈根因)。
 * cookie 域不分端口(RFC 6265),同 host 全端口有效 → 所有实例共享一份 token 后,
 * 任一实例种下的 cookie 对全部端口有效,前端跨实例/跨重启迁移无需重新鉴权。
 * 并发窗口:两实例同时首启可能各生成一份各写各的——写后以重读文件为准,收敛到最后写者的值
 * (毫秒级窗口,仅影响启动瞬间,方向安全:两实例最终一致)。
 * 0o600 + Windows icacls 对齐登记文件惯例;损坏/格式非法时重新生成。
 */
export function getOrCreateSharedToken(opts: RegistryOpts = {}): string {
  const dir = opts.dir ?? webGuiRegistryDir();
  const filePath = join(dir, 'token.txt');
  try {
    const existing = readFileSyncOpt(filePath);
    if (existing && SHARED_TOKEN_RE.test(existing)) return existing;
  } catch { /* 读失败按不存在处理 */ }
  const generated = randomBytes(24).toString('hex');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, generated, { encoding: 'utf-8', mode: 0o600 });
    hardenFilePermissionsWindows(filePath);
    // 写后重读:并发首启时收敛到文件终值,保证多实例一致
    const after = readFileSyncOpt(filePath);
    return after && SHARED_TOKEN_RE.test(after) ? after : generated;
  } catch (err) {
    getLogger().warn('web-gui', `shared token persistence failed, using per-process token: ${err instanceof Error ? err.message : err}`);
    return generated;
  }
}

function readFileSyncOpt(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf-8').trim() || null; } catch { return null; }
}

/** 包根推导(server.ts packageRoot 同款):build/web-gui/registry.js → 上三级 = 包根
 *  (src/web-gui/ 直跑与 vitest 同理)。rotate 的入口页重写缺省目标。 */
function defaultPackageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export interface RotateTokenOpts extends RegistryOpts {
  /** 入口页重写目标包根;缺省按本模块位置上三级推导(server.ts 同款)。 */
  packageRoot?: string;
}

/**
 * 轮换共享 token(M-2,2026-09-17 审查批):删 token.txt → getOrCreateSharedToken 生成新值
 * → 若包根入口页(面板入口.html,内嵌 token 的落盘副本)存在则用新 token 重写 → 返回新值。
 * 动机:token 疑似泄露(终端贴 URL/录屏/分享截图)后的主动止损出口——旧值作废,新实例/新会话
 * 收敛新值。诚实边界:已运行实例的内存 token 不热更新,须重启才认新值(rotate 防守的是
 * "后续不再认旧 token",不是即时踢线);入口页仅在已存在时重写,不新增写入面。
 */
export function rotateSharedToken(opts: RotateTokenOpts = {}): string {
  const dir = opts.dir ?? webGuiRegistryDir();
  try { unlinkSync(join(dir, 'token.txt')); } catch { /* ENOENT = 首启前 rotate,按不存在处理 */ }
  const fresh = getOrCreateSharedToken(opts.dir ? { dir: opts.dir } : {});
  const root = opts.packageRoot ?? defaultPackageRoot();
  try {
    if (existsSync(join(root, PROJECT_ENTRY_NAME))) ensurePackageRootEntry(root, fresh);
  } catch (err) {
    getLogger().warn('web-gui', `rotate: package root entry refresh failed: ${err instanceof Error ? err.message : err}`);
  }
  return fresh;
}

function defaultIsPidAlive(pid: number): boolean {
  // pid<=0 守卫对齐 instance-manager.ts:307-315 原版语义(0/负数不进 process.kill)
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** S-5 同款(instance-manager.ts:94):Windows 无视 mode,用 icacls 收紧 ACL;best-effort。
 *  导出复用供 projects-store 等同域持久化文件共享(I-E 教训:导出复用而非复制;
 *  Web GUI 项目面板 spec 2026-09-15 §3.1 要求照抄本模式)。 */
export function hardenFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const username = userInfo().username;
    if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], { stdio: 'ignore' });
    } else {
      // 对齐 instance-manager.ts:100-102:username 异常字符时显式 warn(而非静默跳过)
      getLogger().warn('web-gui', `Username "${username}" has unexpected chars, skipping ACL restriction for ${filePath}`);
    }
  } catch {
    getLogger().warn('web-gui', `ACL restriction failed for ${filePath}, file may inherit default permissions`);
  }
}

export async function writeRegistration(entry: WebGuiRegistration, opts: RegistryOpts = {}): Promise<void> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const filePath = join(dir, `${entry.pid}.json`);
  const tmpPath = `${filePath}.tmp`;
  try {
    // S-5: token 是准入凭证,0o600 + 目录 0o700 + Windows icacls,防多用户机器泄露
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, filePath);
    hardenFilePermissionsWindows(filePath);
  } catch (err) {
    getLogger().warn('web-gui', `writeRegistration failed for pid ${entry.pid}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export async function removeRegistration(pid: number, opts: RegistryOpts = {}): Promise<void> {
  const dir = opts.dir ?? webGuiRegistryDir();
  try { await unlink(join(dir, `${pid}.json`)); } catch { /* ENOENT 忽略——best-effort */ }
}

export async function listRegistrations(opts: RegistryOpts = {}): Promise<WebGuiRegistration[]> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const out: WebGuiRegistration[] = [];
  let files: string[];
  try { files = await readdir(dir); } catch { return out; }   // 目录不存在 = 无登记
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf-8')) as WebGuiRegistration;
      // token 格式校验:字母数字下划线连字符集——无 shell 元字符即安全等价(关掉 defaultOpener exec 注入残余面)
      if (typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.token)) continue;
      if (!isPidAlive(raw.pid)) {
        // 死条目顺手清(SIGKILL 残留);按当前文件名删——文件名与内容 pid 不一致的异常残留文件也能清掉
        await unlink(join(dir, f)).catch(() => {});
        continue;
      }
      out.push(raw);
    } catch { /* 损坏文件跳过 */ }
  }
  return out;
}

/**
 * 陈旧登记清扫(2026-09-15 独立批):删除 pid 已死的登记文件,返回删除数。
 * 动机:Windows 强杀(taskkill/断电)不走 exit-hook,死登记只靠 listRegistrations
 * 的顺手清——而该函数仅 dashboard CLI 探活路径调用,server 自身只写不读 → 持续堆积。
 * server 启动时 fire-and-forget 调本函数(server.ts start() 接线)。
 * 诚实边界:pid 复用时 isPidAlive 误报 true → 该条目保留(方向安全:垃圾无害,误删活登记才有害)。
 * 非 WebGuiRegistration 形态文件(如 projects.json)经同 listRegistrations 的格式校验跳过,不删。
 */
export async function sweepStaleRegistrations(opts: RegistryOpts = {}): Promise<number> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  let removed = 0;
  let files: string[];
  try { files = await readdir(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf-8')) as WebGuiRegistration;
      if (typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.token)) continue;
      if (!isPidAlive(raw.pid)) {
        await unlink(join(dir, f)).catch(() => {});
        removed++;
      }
    } catch { /* 损坏文件跳过 */ }
  }
  if (removed > 0) getLogger().info('web-gui', `registry sweep: removed ${removed} stale entr${removed === 1 ? 'y' : 'ies'}`);
  return removed;
}
