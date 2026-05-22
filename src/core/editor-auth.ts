// src/core/editor-auth.ts
import { readFileSync, writeFileSync, chmodSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SECRET_FILE_NAME = 'mcp_editor.key';
let _permWarned = false;

/** On Windows, use icacls to restrict file to current user only. */
function restrictFileWindows(filePath: string): void {
  try {
    execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:R"`, { stdio: 'ignore' });
  } catch { /* best effort */ }
}

/** Check and tighten file permissions. Returns true if permissions are acceptable. */
function checkFilePermissions(filePath: string): boolean {
  if (process.platform === 'win32') {
    // On Windows, apply ACL restriction proactively
    restrictFileWindows(filePath);
    return true;
  }
  try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
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
    if (existsSync(secretPath)) checkFilePermissions(secretPath);
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
