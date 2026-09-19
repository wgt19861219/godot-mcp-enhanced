/** configure 命令 — 定向配置单个 AI 客户端(P0-2,2026-08-19)
 *
 * 与 setup(全量扫描已安装客户端)互补:configure <client> 一条命令定向写入,
 * 未检测到的客户端(如装在非默认位置 / 提前预置配置)可 --force 写入。
 * 对标 godot-ai 22 客户端 registry 与 yanhuifair「一条命令就绪」分发面,
 * 替代手工 docs/使用指南-Warp.md。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { ALL_ADAPTERS } from './clients/index.js';
import type { ClientAdapter } from './clients/types.js';
import { findGodot } from '../core/godot-finder.js';
import { detectMcpCommand } from './setup.js';
import { getErrorMessage } from '../types.js';
import { auditClientConfigured } from './audit-helper.js';

/** 客户端名归一化:大小写/空格/连字符/下划线全部折叠("Claude Code" ≡ "claude-code" ≡ "claudecode") */
export function normalizeClientName(s: string): string {
  return s.toLowerCase().replace(/[\s_-]/g, '');
}

/** 按归一化名查找适配器;找不到返回 null */
export function findAdapterByName(name: string): ClientAdapter | null {
  const target = normalizeClientName(name);
  return ALL_ADAPTERS.find(a => normalizeClientName(a.name) === target) ?? null;
}

/** 列出全部支持客户端 + 安装/配置状态(当前 cwd 为 project scope 判定基准) */
export async function listClients(projectDir: string): Promise<void> {
  console.log('Supported clients:\n');
  console.log('  name               scope    installed  configured');
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    const configured = installed ? await adapter.isConfigured(projectDir) : false;
    const name = adapter.name.padEnd(18);
    const scope = adapter.scope.padEnd(8);
    console.log(`  ${name} ${scope} ${installed ? 'yes       ' : 'no        '} ${configured ? 'yes' : 'no'}`);
  }
  console.log('\nConfigure one:  godot-mcp-enhanced configure <client>');
  console.log('Force (uninstalled):  godot-mcp-enhanced configure <client> --force');
}

/** 客户端配置完成后的后续步骤提示(仅对有审批闸的客户端有意义) */
const POST_CONFIG_HINTS: Record<string, string> = {
  Warp: 'Warp 对项目级 .warp/.mcp.json 有审批闸:在 Warp Settings > Agents > MCP servers 手动开启 godot server(防恶意仓库自动执行)。',
};

export async function runConfigure(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length === 0 || args.includes('--list')) {
    await listClients(process.cwd());
    return;
  }
  if (positional.length > 1) {
    console.error('Usage: godot-mcp-enhanced configure <client> [--force]');
    process.exit(1);
    return; // exit 不被静态识别为终止(mock/spy 场景下兜底)
  }

  const clientName = positional[0]!;
  const adapter = findAdapterByName(clientName);
  if (!adapter) {
    console.error(`Unknown client: ${clientName}`);
    console.error(`Available: ${ALL_ADAPTERS.map(a => a.name).join(', ')}`);
    process.exit(1);
    return;
  }

  console.log(`🔧 Configuring ${adapter.name} (${adapter.scope})...\n`);

  // N-4(2026-08-19 审查):project scope 的 working_directory/env 会指向 cwd,
  // 在非 Godot 项目目录运行会精确复现使用指南-Warp §5 的坑——前置警告不阻断
  const projectDir = process.cwd();
  if (adapter.scope === 'project' && !existsSync(join(projectDir, 'project.godot'))) {
    console.warn(`  ⚠ 当前目录不是 Godot 项目(无 project.godot)——project scope 配置将指向 ${projectDir}。`);
    console.warn('    建议在 Godot 项目根目录运行,或确认这是你有意的目标。');
  }

  // 1. 未检测到:默认拒绝(--force 可越过 —— 配置写文件无害,客户端装好后即生效)
  const installed = await adapter.detect();
  if (!installed && !force) {
    console.error(`✗ ${adapter.name} not detected on this machine.`);
    console.error('  If it is installed in a non-default location, rerun with --force to write the config anyway.');
    process.exit(1);
    return;
  }
  if (!installed && force) {
    console.log('  (not detected — writing config anyway due to --force)');
  }

  // 2. 已配置:默认幂等跳过(--force 重写,如升级 command/args/env)
  if (await adapter.isConfigured(projectDir)) {
    if (!force) {
      console.log(`✓ ${adapter.name}: already configured (use --force to rewrite)`);
      return;
    }
    console.log('  (already configured — rewriting due to --force)');
  }

  // 3. 发现 Godot(与 setup 同策略:找不到硬退)
  let godotPath: string;
  try {
    godotPath = await findGodot();
  } catch (err) {
    console.error(`✗ Godot not found: ${getErrorMessage(err)}`);
    console.error('  Set GODOT_PATH environment variable or install Godot.');
    process.exit(1);
    return;
  }
  console.log(`  Godot: ${godotPath}`);

  // 4. 写配置
  const { command, args: mcpArgs } = detectMcpCommand();
  try {
    await adapter.configure(projectDir, godotPath, command, mcpArgs);
    console.log(`✓ ${adapter.name} (${adapter.scope}): configured`);
    // 批4-T9(五维评估 P2): 改 MCP 客户端配置是安全敏感写面(改它即可注入恶意
    // server),机器级留痕——此前 configure 后零审计痕迹
    auditClientConfigured('cli:configure', adapter.name, adapter.scope, projectDir);
    const hint = POST_CONFIG_HINTS[adapter.name];
    if (hint) console.log(`  → ${hint}`);
  } catch (err) {
    console.error(`✗ ${adapter.name}: ${getErrorMessage(err)}`);
    process.exit(1);
    return;
  }
}
