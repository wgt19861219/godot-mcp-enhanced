import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientAdapter } from './types.js';
import { readJsonConfigWithBackup, readJsonForCheck, writeFileAtomicWithMode, buildEnv } from './json-config.js';

export class AntigravityAdapter implements ClientAdapter {
  name = 'Antigravity';
  scope = 'global' as const;

  private static readonly USER_STATE_KEYS = ['disabled', 'disabledTools'] as const;
  private static readonly USER_STATE_DEFAULTS: Record<typeof AntigravityAdapter.USER_STATE_KEYS[number], unknown> = { disabled: false, disabledTools: [] };

  // 当前官方路径（Antigravity 2.0/IDE/CLI/SDK 共享）
  private newPath(): string {
    return join(homedir(), '.gemini', 'config', 'mcp_config.json');
  }
  // 旧 IDE 路径（兼容 detect/isConfigured）
  private legacyPath(): string {
    return join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
  }

  async detect(): Promise<boolean> {
    return existsSync(this.newPath()) || existsSync(this.legacyPath());
  }

  async isConfigured(_projectDir: string): Promise<boolean> {
    for (const path of [this.newPath(), this.legacyPath()]) {
      const content = readJsonForCheck(path);
      if (content && (content.mcpServers as Record<string, unknown> | undefined)?.godot) return true;
    }
    return false;
  }

  async configure(_projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    // 写新路径；读旧 entry 优先从已存在的路径（新或旧）取 user-state
    const configPath = this.newPath();
    const existingPath = existsSync(this.newPath()) ? this.newPath()
      : existsSync(this.legacyPath()) ? this.legacyPath() : configPath;
    const config = readJsonConfigWithBackup(existingPath);
    if (!config.mcpServers) config.mcpServers = {};
    const mcp = config.mcpServers as Record<string, Record<string, unknown>>;
    const oldEntry = mcp.godot ?? {};
    const preserved: Record<string, unknown> = {};
    for (const key of AntigravityAdapter.USER_STATE_KEYS) {
      preserved[key] = key in oldEntry ? oldEntry[key] : AntigravityAdapter.USER_STATE_DEFAULTS[key];
    }
    mcp.godot = {
      ...preserved,
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      // C1: 保留旧 entry.env 的白名单前缀(防 reconfigure 丢失用户配的 ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_*)
      env: buildEnv(godotPath, oldEntry.env as Record<string, unknown> | undefined),
    };
    const configDir = join(configPath, '..');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    // F3: 原子写入 + 保持原文件 mode（adapter-no-mode-preserve）
    writeFileAtomicWithMode(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  /** uninstall 反向操作:新/旧双路径都查,任一路径含 godot entry 即删并写回该文件
   *  (configure 只写新路径,但旧 IDE 装机可能两处都有残留)。损坏 JSON 抛错不动文件。 */
  async unconfigure(_projectDir: string): Promise<boolean> {
    let removed = false;
    for (const path of [this.newPath(), this.legacyPath()]) {
      if (!existsSync(path)) continue;
      const config = readJsonForCheck(path);
      if (!config) throw new Error(`config parse error: ${path}`);
      const mcp = config.mcpServers as Record<string, unknown> | undefined;
      if (!mcp?.godot) continue;
      delete mcp.godot;
      writeFileAtomicWithMode(path, JSON.stringify(config, null, 2) + '\n');
      removed = true;
    }
    return removed;
  }
}
