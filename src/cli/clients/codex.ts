import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientAdapter } from './types.js';
import { buildEnv } from './json-config.js';

const execFileAsync = promisify(execFile);

/**
 * C1: 从 ~/.codex/config.toml best-effort 提取 godot server 的 env 表。
 *
 * codex CLI 把 mcp servers 存在 TOML 格式而非 JSON。本函数用最小正则解析:
 *  1. 定位 `[mcp_servers.godot]` section（到下一个 `[` 开头的行或文件末）
 *  2. 在 section 内匹配 `env = { KEY = "value", ... }` 内联表
 *  3. 解析 KEY = "value" 对
 *
 * 任何步骤失败(文件不存在/格式不匹配/解析异常)返回空对象 —— 由 buildEnv 兜底
 * 仅写 GODOT_PATH。安全侧:buildEnv 仍按白名单过滤,本函数不需自行判断。
 */
function readCodexGodotEnv(configPath: string): Record<string, string> {
  if (!existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }
  // 定位 [mcp_servers.godot] section:从该 header 行到下一个 [ 开头行(或 EOF)
  const sectionHeader = /^\[mcp_servers\.godot\]\s*$/m;
  const headerMatch = sectionHeader.exec(raw);
  if (!headerMatch) return {};
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const nextSection = raw.slice(sectionStart).search(/^\[/m);
  const sectionText = nextSection === -1
    ? raw.slice(sectionStart)
    : raw.slice(sectionStart, sectionStart + nextSection);
  // 匹配 env = { ... } 内联表(codex mcp add 输出格式)
  const envMatch = sectionText.match(/env\s*=\s*\{([^}]*)\}/);
  if (!envMatch) return {};
  const envBody = envMatch[1]!;
  // 解析 KEY = "value" 对(KEY 可带/不带引用)
  const result: Record<string, string> = {};
  const pairRegex = /(?:["']?)(\w+)(?:["']?)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(envBody)) !== null) {
    result[m[1]!] = m[2]!;
  }
  return result;
}

export class CodexAdapter implements ClientAdapter {
  name = 'Codex';
  scope = 'global' as const;

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  // A-10: 使用精确匹配（完整服务器名称 "godot"）替代子串匹配
  async isConfigured(_projectDir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 });
      // 精确匹配行首或空格后的 "godot"，避免误匹配 "godot-docs" 等
      return /(?:^|\s)godot(?:\s|$)/m.test(stdout);
    } catch { return false; }
  }

  async configure(_projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    // C1: best-effort 读 ~/.codex/config.toml 旧 godot env,经 buildEnv 白名单过滤后,
    // 作为额外 --env flag 传入(防 reconfigure 丢失 ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_*)
    const oldEnv = readCodexGodotEnv(join(homedir(), '.codex', 'config.toml'));
    const env = buildEnv(godotPath, oldEnv);
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      envFlags.push('--env', `${k}=${v}`);
    }
    // 分别传递 command 和 args，避免字符串拼接注入风险
    await execFileAsync('codex', [
      'mcp', 'add', 'godot',
      '--command', mcpCommand,
      ...(mcpArgs.length > 0 ? ['--args', ...mcpArgs] : []),
      ...envFlags,
    ], { timeout: 10000 });
  }

  /** uninstall 反向操作:先 isConfigured 精确匹配(避免 remove 不存在的键报错),
   *  再调官方子命令移除。remove 失败(超时/CLI 异常)抛错交命令层报 ✗。 */
  async unconfigure(_projectDir: string): Promise<boolean> {
    if (!(await this.isConfigured(_projectDir))) return false;
    await execFileAsync('codex', ['mcp', 'remove', 'godot'], { timeout: 10000 });
    return true;
  }
}
