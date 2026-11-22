// src/core/editor-auth.ts
import { readFileSync, chmodSync, statSync, existsSync, lstatSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { userInfo } from 'os';
import { getLogger } from './logger.js';
import { getErrorMessage } from '../types.js';

const SECRET_FILE_NAME = 'mcp_editor.key';
let _permWarned = false;

/** On Windows, use icacls to restrict file to current user only. Returns true if ACL was applied successfully. */
function restrictFileWindows(filePath: string): boolean {
  try {
    // C-ARC-01: Use os.userInfo().username (no environment variable spoofing)
    // and strictly validate format — no backslashes (rejects DOMAIN\user injection).
    const username = userInfo().username;
    if (!username || !/^[A-Za-z0-9_-]+$/.test(username)) {
      if (!_permWarned) {
        _permWarned = true;
        getLogger().error('security', `Cannot set ACL: username "${username}" contains unexpected characters.`);
      }
      return false;
    }
    // ACL 权限用 :M(Modify),非 :R(read)/:F(full)。:M = Read+Write+Execute+Delete,含 Write 覆盖写
    // 能力但不含 Change permissions/Take ownership,纵深防御上比 :F 更严。/inheritance:r 已移除继承
    // 与其他用户 ACE,其他用户仍无权限;:M 让 editor plugin(同 USERNAME 身份)下次 _ready 能直接
    // WriteAllText 覆盖写新 secret。若用 :R,plugin 后续覆盖写被只读 ACL 拒绝 → secret 文件停在旧值、
    // plugin 内存换新值 → MCP server 用旧文件 secret auth 失败 → 降级 headless(死循环 bug)。
    // 与 plugin 端 src/scripts/mcp_bridge.gd / addons websocket_server.gd:_restrict_secret_permissions 的 USERNAME:M 对齐。
    // Task 4(2026-11-22 spawn 点自查):补 timeout 15s——execFileSync 同步阻塞事件循环,icacls
    // 挂死(磁盘/AV 锁)会卡死整个 server;短命令 15s 参照。读回处输出仅数行,补 maxBuffer 显式值。
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:M`], { stdio: 'ignore', timeout: 15_000 });
    // Verify the ACL was applied by reading it back
    const output = execFileSync('icacls', [filePath], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    // Case-insensitive match — Windows usernames are case-insensitive
    if (!output.toLowerCase().includes(username.toLowerCase())) {
      if (!_permWarned) {
        _permWarned = true;
        getLogger().error('security', `ACL verification failed for ${filePath}: ${output.trim()}`);
      }
      return false;
    }
    return true;
  } catch {
    if (!_permWarned) {
      _permWarned = true;
      getLogger().error('security', `Failed to set Windows ACL on ${filePath}`);
    }
    return false;
  }
}

/** Check and tighten file permissions. Returns true if permissions are acceptable. */
function checkFilePermissions(filePath: string): boolean {
  if (process.platform === 'win32') {
    // Windows: restrictFileWindows applies ACL restrictions; always returns true.
    return restrictFileWindows(filePath);
  }
  try { chmodSync(filePath, 0o600); } catch (err) { getLogger().debug('auth', `chmod secret: ${err}`); }
  const stat = statSync(filePath);
  if ((stat.mode & 0o007) !== 0) {
    if (!_permWarned) {
      _permWarned = true;
      getLogger().error('security', `Editor secret ${filePath} is world-readable. Attempted chmod 0600.`);
    }
    return false;
  }
  return true;
}

/** Read the editor secret from {project}/.godot/mcp_editor.key. Returns null if not found. */
export function readEditorSecret(projectPath: string): string | null {
  const secretPath = join(projectPath, '.godot', SECRET_FILE_NAME);
  try {
    // Imp-9 (2026-06-24 审查): symlink 检查——与 game-bridge 一致(文档声称 editor-auth 也有,实际原缺)。
    // symlink 自身权限可能 OK 但指向任意文件,拒绝读取防绕过权限检查。
    const lstat = lstatSync(secretPath);
    if (lstat.isSymbolicLink()) {
      getLogger().error('security', `Editor secret file ${secretPath} is a symlink — refusing to read.`);
      return null;
    }
    // Check permissions BEFORE reading — reject insecure files before content enters memory.
    if (!checkFilePermissions(secretPath)) {
      getLogger().error('security', `Refusing to use editor secret with insecure permissions: ${secretPath}`);
      return null;
    }
    const content = readFileSync(secretPath, 'utf-8').trim();
    return content;
  } catch (err: unknown) {
    // ENOENT is expected (plugin not started yet) — silent.
    // Other errors (EACCES, EISDIR, etc.) should be surfaced for diagnosis.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().error('auth', `Failed to read editor secret: ${(err as NodeJS.ErrnoException).code} — ${getErrorMessage(err)}`);
    }
    return null;
  }
}

/**
 * Lightweight async read — no permission check (caller must check first).
 * Avoids blocking the event loop with execFileSync (icacls) on every poll.
 */
async function readSecretContent(projectPath: string): Promise<string | null> {
  const secretPath = join(projectPath, '.godot', SECRET_FILE_NAME);
  try {
    const content = (await readFile(secretPath, 'utf-8')).trim();
    return content || null;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().error('auth', `Failed to read editor secret: ${(err as NodeJS.ErrnoException).code} — ${getErrorMessage(err)}`);
    }
    return null;
  }
}

/** Poll for the editor secret file to appear (plugin may still be starting). */
export async function waitForEditorSecret(
  projectPath: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const interval = 200;
  const deadline = Date.now() + timeoutMs;
  const secretFilePath = join(projectPath, '.godot', SECRET_FILE_NAME);
  let permChecked = false;

  while (Date.now() < deadline) {
    // I-09: Fast path — check existsSync first to avoid expensive execFileSync (icacls) on every poll
    if (!existsSync(secretFilePath)) {
      await new Promise(r => setTimeout(r, interval));
      continue;
    }

    // S-3 (TOCTOU fix): symlink 每轮复检(轻量 lstatSync,无 execFileSync)。
    // 原实现只在文件首次出现时检查一次,permChecked=true 后 5s 轮询期内(~25 次)不再复核,
    // 攻击者可在首检后把 mcp_editor.key 换 symlink 指向已知内容文件 → 伪造 editor 身份。
    try {
      if (lstatSync(secretFilePath).isSymbolicLink()) {
        getLogger().error('security', `Editor secret file ${secretFilePath} is a symlink — refusing to read.`);
        return null;
      }
    } catch (err: unknown) {
      // ENOENT: existsSync 后文件被删(竞态),静默继续轮询;其他 lstat 错误 log 后继续(下轮重试)
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger().error('auth', `Failed to lstat editor secret: ${(err as NodeJS.ErrnoException).code} — ${getErrorMessage(err)}`);
      }
      await new Promise(r => setTimeout(r, interval));
      continue;
    }

    // Check permissions ONCE when file first appears (sync icacls — unavoidable on Windows, expensive)
    if (!permChecked) {
      if (!checkFilePermissions(secretFilePath)) {
        getLogger().error('security', `Refusing to use editor secret with insecure permissions: ${secretFilePath}`);
        return null;
      }
      permChecked = true;
    }

    // Subsequent polls use lightweight async read — no sync icacls
    const secret = await readSecretContent(projectPath);
    if (secret) return secret;
    await new Promise(r => setTimeout(r, interval));
  }

  // Final attempt — still lightweight
  return readSecretContent(projectPath);
}
