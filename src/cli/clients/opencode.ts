import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ClientAdapter } from './types.js';
import { readJsonConfigWithBackup, readJsonForCheck, writeFileAtomicWithMode, buildEnv } from './json-config.js';

const execFileAsync = promisify(execFile);

export class OpenCodeAdapter implements ClientAdapter {
  name = 'OpenCode';
  scope = 'project' as const;

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  // IMPORTANT-6: opencode `mcp add` 是交互式 prompts(不接受 --command/--args/--env flag,
  // 见 sst/opencode packages/opencode/src/cli/cmd/mcp.ts 的 McpAddCommand —— 全程 prompts.text/select)。
  // 非交互式 execFile 调用会挂起超时。改为直接读/写 opencode.json 配置(与 cursor/claude-code 一致)。
  async isConfigured(projectDir: string): Promise<boolean> {
    const configPath = join(projectDir, 'opencode.json');
    const content = readJsonForCheck(configPath);
    if (!content) return false;
    return !!(content.mcp as Record<string, unknown> | undefined)?.godot;
  }

  private static readonly USER_STATE_KEYS = ['enabled'] as const;
  // spec §3.1: 首次创建 seed enabled:true(对齐 OpenCode 官方示例 + Godot AI entry_initial_fields)
  private static readonly USER_STATE_DEFAULTS: Record<string, unknown> = { enabled: true };

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const configPath = join(projectDir, 'opencode.json');
    // F3: 损坏 JSON 时备份原文件 + warn,不静默覆盖用户配置
    const config = readJsonConfigWithBackup(configPath);
    if (!config.mcp) config.mcp = {};
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    // user-state 保留:读旧 entry 白名单字段 merge 进新 entry;首次创建 seed DEFAULTS(spec §3.1)
    const oldEntry = mcp.godot ?? {};
    const preserved: Record<string, unknown> = {};
    for (const key of OpenCodeAdapter.USER_STATE_KEYS) {
      preserved[key] = key in oldEntry ? oldEntry[key] : OpenCodeAdapter.USER_STATE_DEFAULTS[key];
    }
    // opencode local MCP 配置:command 数组 + environment 对象(见 mcp.ts local 分支)
    mcp.godot = {
      ...preserved,
      type: 'local',
      command: [mcpCommand, ...mcpArgs],
      // C1: opencode 用 environment 字段(非 env),同样保留白名单前缀用户配置
      environment: buildEnv(godotPath, oldEntry.environment as Record<string, unknown> | undefined),
    };
    // F3: 原子写入 + 保持原文件 mode（adapter-no-mode-preserve）
    writeFileAtomicWithMode(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  /** uninstall 反向操作:删 opencode.json 的 mcp.godot(容器保留,损坏 JSON 抛错不动文件)。 */
  async unconfigure(projectDir: string): Promise<boolean> {
    const configPath = join(projectDir, 'opencode.json');
    if (!existsSync(configPath)) return false;
    const config = readJsonForCheck(configPath);
    if (!config) throw new Error(`config parse error: ${configPath}`);
    const mcp = config.mcp as Record<string, unknown> | undefined;
    if (!mcp?.godot) return false;
    delete mcp.godot;
    writeFileAtomicWithMode(configPath, JSON.stringify(config, null, 2) + '\n');
    return true;
  }
}
