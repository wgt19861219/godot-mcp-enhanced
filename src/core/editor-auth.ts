// src/core/editor-auth.ts
import { readFileSync, chmodSync, statSync } from 'fs';
import { join } from 'path';

const SECRET_FILE_NAME = 'mcp_editor.key';
let _permWarned = false;

/** Read the editor secret from {project}/.godot/mcp_editor.key. Returns null if not found. */
export function readEditorSecret(projectPath: string): string | null {
  const secretPath = join(projectPath, '.godot', SECRET_FILE_NAME);
  try {
    if (process.platform !== 'win32') {
      try { chmodSync(secretPath, 0o600); } catch { /* best effort */ }
    }
    const stat = statSync(secretPath);
    if (!_permWarned && process.platform !== 'win32' && (stat.mode & 0o007) !== 0) {
      _permWarned = true;
      console.error(`[SECURITY] Editor secret ${secretPath} is world-readable. Attempted chmod 0600.`);
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
