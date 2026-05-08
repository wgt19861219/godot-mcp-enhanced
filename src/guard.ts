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

export const GUARDED_TOOLS = new Set([
  'remove_node',
  'write_script',
  'edit_script',
  'execute_gdscript',
]);

export function requiresConfirmation(toolName: string): boolean {
  return GUARDED_TOOLS.has(toolName);
}

export function createPendingToken(toolName: string, args: Record<string, unknown>): string {
  const now = Date.now();
  // 清理过期 token
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
  // 超限时移除最旧的
  if (pendingTokens.size >= MAX_TOKENS) {
    const oldest = [...pendingTokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) pendingTokens.delete(oldest[0]);
  }
  const token = randomBytes(18).toString('base64url');
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
