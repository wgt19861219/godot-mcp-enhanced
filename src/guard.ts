import { randomBytes } from 'crypto';

interface PendingToken {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
}

const TOKEN_TTL_MS = 180_000; // 3 minutes
const MAX_TOKENS = 100;
const pendingTokens = new Map<string, PendingToken>();

// 后台定期清理过期 token（每 60 秒）
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
}, 60_000);
// 允许进程正常退出（不阻塞事件循环）
if (_cleanupTimer.unref) _cleanupTimer.unref();

export const GUARDED_TOOLS = new Set([
  'remove_node',
  'execute_gdscript',
  'project_replace',
]);

export function requiresConfirmation(toolName: string): boolean {
  return GUARDED_TOOLS.has(toolName);
}

let _oldestKey: string | null = null;

export function createPendingToken(toolName: string, args: Record<string, unknown>): string {
  const now = Date.now();
  // 清理过期 token
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
  // 超限时移除最旧的（O(1) tracked key instead of full scan）
  if (pendingTokens.size >= MAX_TOKENS) {
    if (_oldestKey && pendingTokens.has(_oldestKey)) {
      pendingTokens.delete(_oldestKey);
    } else {
      const first = pendingTokens.keys().next().value;
      if (first) pendingTokens.delete(first);
    }
  }
  const token = randomBytes(18).toString('base64url');
  if (pendingTokens.size === 0) _oldestKey = token;
  pendingTokens.set(token, { token, toolName, args, createdAt: now });
  return token;
}

export function consumeToken(token: string): { toolName: string; args: Record<string, unknown> } | null {
  const pending = pendingTokens.get(token);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > TOKEN_TTL_MS) {
    pendingTokens.delete(token);
    return null;
  }
  pendingTokens.delete(token);
  return { toolName: pending.toolName, args: pending.args };
}

export function pendingCount(): number {
  return pendingTokens.size;
}
