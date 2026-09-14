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
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** S-5 同款(instance-manager.ts:94):Windows 无视 mode,用 icacls 收紧 ACL;best-effort。 */
function hardenFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const username = userInfo().username;
    if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], { stdio: 'ignore' });
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
      if (typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.token !== 'string') continue;
      if (!isPidAlive(raw.pid)) {
        await removeRegistration(raw.pid, { dir });   // 死条目顺手清(SIGKILL 残留)
        continue;
      }
      out.push(raw);
    } catch { /* 损坏文件跳过 */ }
  }
  return out;
}
