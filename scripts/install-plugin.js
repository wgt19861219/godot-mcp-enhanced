#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
const isVerify = args.includes('--verify');

if (projectIndex === -1 || !args[projectIndex + 1]) {
  // L-19(2026-10-22 审查):原文案提示 `npx godot-mcp-enhanced install-plugin`,但 CLI
  // 路由表(SUBCOMMANDS)无此子命令——照抄会静默落入 stdio server 挂起。改为本脚本的
  // 真实调用形态(node 直跑脚本文件)。
  console.error('Usage: node scripts/install-plugin.js --project /path/to/godot/project');
  console.error('       node scripts/install-plugin.js --verify --project /path/to/godot/project');
  console.error('(npm 包内: node node_modules/godot-mcp-enhanced/scripts/install-plugin.js --project ...)');
  process.exit(1);
}

// P2: resolve → existsSync → realpath 归一(防符号链接穿越, 避免 cpSync 写到符号链接
// 指向的包外目标)。审查建议复用 validateProjectRoot, 但 validateProjectRoot 仅查
// project.godot 存在(与下方 :project.godot 检查等价, 不校验穿越/符号链接); 真实
// 符号链接防护由 realpathSync 承担。危害收窄(用户主动对自己项目运行, 源是包内固定 addons/)。
const requestedPath = resolve(args[projectIndex + 1]);
if (!existsSync(requestedPath)) {
  console.error('ERROR: Project directory does not exist:', requestedPath);
  process.exit(1);
}
let projectPath;
try {
  projectPath = realpathSync(requestedPath);
} catch (err) {
  console.error('ERROR: Cannot resolve project path (realpath failed):', err.message);
  process.exit(1);
}
const addonSource = join(__dirname, '..', 'addons', 'godot_mcp_server');
const addonDest = join(projectPath, 'addons', 'godot_mcp_server');

if (isVerify) {
  const cfgPath = join(addonDest, 'plugin.cfg');
  if (!existsSync(cfgPath)) {
    console.error('FAIL: plugin.cfg not found at', cfgPath);
    console.error('Run: npx godot-mcp-enhanced install-plugin --project', projectPath);
    process.exit(1);
  }
  const content = readFileSync(cfgPath, 'utf-8');
  if (!content.includes('[plugin]') || !content.includes('script="plugin.gd"')) {
    console.error('FAIL: plugin.cfg is malformed');
    process.exit(1);
  }
  console.log('OK: Plugin installed and valid at', addonDest);
  process.exit(0);
}

if (!existsSync(join(projectPath, 'project.godot'))) {
  console.error('ERROR: Not a Godot project (no project.godot):', projectPath);
  process.exit(1);
}

try {
  cpSync(addonSource, addonDest, { recursive: true });
  console.log('OK: Plugin installed to', addonDest);
  console.log('Next: Open Godot Editor > Project Settings > Plugins > Enable "MCP Server"');
} catch (err) {
  console.error('ERROR:', err.message);
  console.error('Manual: Copy addons/godot_mcp_server/ to your project addons/ directory');
  process.exit(1);
}
