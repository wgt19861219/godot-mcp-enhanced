/** setup 命令 — 一键配置 AI 客户端 */
import { join } from 'path';
import { findGodot } from '../core/godot-finder.js';
import { ALL_ADAPTERS } from './clients/index.js';
import { getErrorMessage } from '../types.js';
import { auditClientConfigured } from './audit-helper.js';

/** I-08: 检测 MCP command/args — 改进安装方式判断(setup/configure 共用) */
export function detectMcpCommand(): { command: string; args: string[] } {
  const entryPath = process.argv[1] ?? '';

  // 优先检查 npm_lifecycle_event 判断运行上下文
  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === 'postinstall' || lifecycle === 'preinstall') {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // IMPORTANT-7: 原路径段启发式(npm pack 解压临时目录、CI 本地 node_modules)会误判为全局安装。
  // 改进:优先 npm_config_global 强信号;路径段匹配时排除 npm pack 的隐藏临时段(.package/.staging 等)。
  const pathSegments = entryPath.replace(/\\/g, '/').split('/');
  const hasTempSegment = pathSegments.some(seg => seg.startsWith('.') && seg !== '.');
  const inGlobalNodeModules = (process.env.npm_config_global === 'true' ||
      (pathSegments.includes('node_modules') && pathSegments.includes('godot-mcp-enhanced'))) &&
    !hasTempSegment;

  if (inGlobalNodeModules) {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // 本地开发：用 node + 绝对路径
  const devEntry = join(import.meta.dirname ?? '.', '..', 'index.js');
  return { command: 'node', args: [devEntry] };
}

export async function runSetup(_args: string[]): Promise<void> {
  console.log('🔍 Detecting environment...\n');

  // 1. 发现 Godot
  let godotPath: string;
  try {
    godotPath = await findGodot();
    console.log(`✓ Godot found: ${godotPath}`);
  } catch (err) {
    console.error(`✗ Godot not found: ${getErrorMessage(err)}`);
    // 批 2:TTY 环境引导官方 releases 自动安装;非交互(管道/CI)保持 exit 1 指引
    const { confirmYesNo } = await import('./confirm.js');
    if (await confirmYesNo('\n未找到 Godot。是否从官方 GitHub releases 自动下载安装最新 stable?')) {
      const { installGodot } = await import('./godot-installer.js');
      const { godotPath: installed, versionTag } = await installGodot({
        confirm: async () => true,  // 外层已确认
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(`✓ Godot ${versionTag} 已安装: ${installed}`);
      godotPath = installed;
    } else {
      console.error('  运行 `npx godot-mcp-enhanced install` 自动安装,或设 GODOT_PATH 指向已有 Godot。');
      process.exit(1);
    }
  }

  // 2. 检测 MCP 命令
  const { command, args: mcpArgs } = detectMcpCommand();

  // 3. 检测 + 配置各客户端
  const projectDir = process.cwd();
  console.log(`\n📁 Project: ${projectDir}\n`);

  let configured = 0;
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(`  ⊘ ${adapter.name} (${adapter.scope}): not installed, skipping`);
      continue;
    }

    const already = await adapter.isConfigured(projectDir);
    if (already) {
      console.log(`  ✓ ${adapter.name} (${adapter.scope}): already configured`);
      continue;
    }

    try {
      await adapter.configure(projectDir, godotPath, command, mcpArgs);
      console.log(`  ✓ ${adapter.name} (${adapter.scope}): configured`);
      configured++;
      // 批4-T9(五维评估 P2): 改 MCP 客户端配置是安全敏感写面,机器级留痕(此前零审计)
      auditClientConfigured('cli:setup', adapter.name, adapter.scope, projectDir);
    } catch (err) {
      console.error(`  ✗ ${adapter.name} (${adapter.scope}): ${getErrorMessage(err)}`);
    }
  }

  // 易用性批3 (2026-09-19):两个出口都要给下一步——成功侧告知重启生效+验证方式
  // (对照 skills.ts 同款意识);零配置侧指向 configure 的 15 客户端支持面与 --force。
  if (configured > 0) {
    console.log(`\n✓ ${configured} client(s) configured.`);
    console.log('  重启 AI 客户端会话后生效(MCP 配置仅在会话启动时加载)。');
    console.log('  验证:客户端里让 AI 调用 get_godot_version,或运行 npx godot-mcp-enhanced doctor。');
  } else {
    console.log('\nNo new clients to configure.');
    console.log('  支持的全部客户端:npx godot-mcp-enhanced configure --list(15 个)');
    console.log('  客户端装在非默认位置/已配置想重写:configure <客户端名> --force');
  }
}
