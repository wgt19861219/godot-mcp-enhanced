// Web GUI per-pid 登记(设计 §3.1):每实例写自己的 ~/.godot-mcp/web-gui/<pid>.json,
// 无并发写竞争(对齐 InstanceManager 模式);文件含 token 准入凭证,权限加固防同机他用户读取。

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { getLogger } from '../core/logger.js';

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
