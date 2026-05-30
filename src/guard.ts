import { randomBytes } from 'crypto';

interface PendingToken {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
}

const TOKEN_TTL_MS = 180_000; // 3 minutes
const MAX_TOKENS = 100;
const TOKEN_RATE_LIMIT = 5; // max new tokens per second
const pendingTokens = new Map<string, PendingToken>();
let _recentCreations: number[] = []; // timestamps of recent createPendingToken calls

let _cleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
}, 60_000);
// 允许进程正常退出（不阻塞事件循环）
if (_cleanupTimer.unref) _cleanupTimer.unref();

/** Restart the background cleanup interval if it isn't running. */
function ensureCleanupTimer(): void {
  if (_cleanupTimer !== null) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, pending] of pendingTokens) {
      if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
    }
  }, 60_000);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

// Map: merged tool name → Set of guarded actions (null = entire tool is guarded)
//
// IMPORTANT: This guard relies on GodotServer.ts routing by MERGED tool name (e.g. 'scene',
// 'script', 'game') rather than legacy individual names. If a caller bypasses the merged-name
// router and uses the old name directly (e.g. 'remove_node'), the guard WILL NOT catch it.
// GodotServer.handleToolCall() is the single entry point and always resolves to merged names.
const GUARDED: Record<string, Set<string> | null> = {
  scene: new Set(['remove_node', 'save_scene', 'detach_instance', 'merge_scene']),
  script: null, // write_script / edit_script / project_replace / execute_gdscript 全部需确认
  animation: new Set(['delete']),
  tilemap: new Set(['tilemap_clear']),
  game: new Set(['game_bridge_install', 'game_bridge_uninstall']),
  runtime: new Set(['run_project', 'launch_editor', 'stop_project']),
};

export function requiresConfirmation(toolName: string, args?: Record<string, unknown>): boolean {
  const guarded = GUARDED[toolName];
  if (guarded === undefined) return false;
  if (guarded === null) return true;
  const action = (args?.action ?? args?.method) as string | undefined;
  return action != null && guarded.has(action);
}

export function createPendingToken(toolName: string, args: Record<string, unknown>): string {
  ensureCleanupTimer();
  const now = Date.now();
  // A-08: Rate limit — prevent high-frequency token creation from evicting legitimate tokens
  _recentCreations = _recentCreations.filter(t => now - t < 1000);
  if (_recentCreations.length >= TOKEN_RATE_LIMIT) {
    throw new Error(`Token creation rate limit exceeded (max ${TOKEN_RATE_LIMIT}/s). Please wait and retry.`);
  }
  _recentCreations.push(now);
  // 清理过期 token
  for (const [key, pending] of pendingTokens) {
    if (now - pending.createdAt > TOKEN_TTL_MS) pendingTokens.delete(key);
  }
  // 超限时移除最旧的（遍历 100 条 < 1μs，逻辑清晰可靠）
  if (pendingTokens.size >= MAX_TOKENS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, pending] of pendingTokens) {
      if (pending.createdAt < oldestTime) {
        oldestTime = pending.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) pendingTokens.delete(oldestKey);
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

/**
 * Reset all mutable state: clear pending tokens and stop the cleanup interval.
 * Useful for test teardown or hot-reload scenarios.
 * The cleanup interval will be recreated on the next `createPendingToken()` call.
 */
export function resetState(): void {
  pendingTokens.clear();
  _recentCreations = [];
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

/**
 * Graceful shutdown: stop the cleanup interval and clear all pending tokens.
 * After calling this, the module is still usable — the interval restarts on
 * the next `createPendingToken()` call.
 */
export function cleanup(): void {
  resetState();
}

/** @internal Exposed for testing — check whether the cleanup timer is active. */
export function isCleanupTimerRunning(): boolean {
  return _cleanupTimer !== null;
}
