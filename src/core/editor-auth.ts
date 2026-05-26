// src/core/editor-auth.ts
import { readFileSync, writeFileSync, chmodSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const SECRET_FILE_NAME = 'mcp_editor.key';
let _permWarned = false;

/** On Windows, use icacls to restrict file to current user only. Returns true if ACL was applied successfully. */
function restrictFileWindows(filePath: string): boolean {
  try {
    const username = process.env.USERNAME;
    if (!username) return false;
    // Validate username format (letters, digits, hyphens, underscores, backslash for domain)
    if (!/^[A-Za-z0-9_\-\\]+$/.test(username)) {
      if (!_permWarned) {
        _permWarned = true;
        console.error(`[SECURITY] Cannot set ACL: USERNAME "${username}" contains unexpected characters.`);
      }
      return false;
    }
    // Extract simple username from DOMAIN\user format to avoid icacls backslash misinterpretation
    const effectiveUser = username.includes('\\') ? username.split('\\').pop()! : username;
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${effectiveUser}:R`], { stdio: 'ignore' });
    // Verify the ACL was applied by reading it back
    const output = execFileSync('icacls', [filePath], { encoding: 'utf-8' });
    if (!output.includes(effectiveUser)) {
      if (!_permWarned) {
        _permWarned = true;
        console.error(`[SECURITY] ACL verification failed for ${filePath}: ${output.trim()}`);
      }
      return false;
    }
    return true;
  } catch {
    if (!_permWarned) {
      _permWarned = true;
      console.error(`[SECURITY] Failed to set Windows ACL on ${filePath}`);
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
  try { chmodSync(filePath, 0o600); } catch (err) { console.debug('[editor-auth] chmod secret:', err); }
  const stat = statSync(filePath);
  if ((stat.mode & 0o007) !== 0) {
    if (!_permWarned) {
      _permWarned = true;
      console.error(`[SECURITY] Editor secret ${filePath} is world-readable. Attempted chmod 0600.`);
    }
    return false;
  }
  return true;
}

/** Read the editor secret from {project}/.godot/mcp_editor.key. Returns null if not found. */
export function readEditorSecret(projectPath: string): string | null {
  const secretPath = join(projectPath, '.godot', SECRET_FILE_NAME);
  try {
    if (existsSync(secretPath)) {
      if (!checkFilePermissions(secretPath)) {
        console.error(`[SECURITY] Refusing to read editor secret with insecure permissions: ${secretPath}`);
        return null;
      }
    }
    return readFileSync(secretPath, 'utf-8').trim();
  } catch {
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
  while (Date.now() < deadline) {
    const secret = readEditorSecret(projectPath);
    if (secret) return secret;
    await new Promise(r => setTimeout(r, interval));
  }
  return readEditorSecret(projectPath);
}
