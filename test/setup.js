/**
 * Vitest 全局 setup — 在所有测试之前执行。
 * 设置 GODOT_MCP_UNRESTRICTED=true 以绕过路径白名单检查，
 * 因为测试使用临时目录（tmpdir）和假路径。
 */
process.env.GODOT_MCP_UNRESTRICTED = 'true';

// Task 9/11: 默认关掉 Web GUI——既有 GodotServer 测试构造实例/run() 时不再真起
// HTTP 监听 + 写 ~/.godot-mcp/web-gui/ 登记(测试隔离)。web-gui 专属测试自行覆盖本值。
process.env.GODOT_MCP_WEB_GUI = '0';

// 2A (2026-09-19 安全加固批2): 审计外置副本目录重定向到临时目录——appendAuditLine 双写
// 外置副本后,所有走真实审计的测试(audit-log/ToolDispatcher middleware/files-api 等)若不
// 隔离会写真实 ~/.godot-mcp/audit/。os.tmpdir() 下 mkdtemp 由本 setup 创建,测试进程内共享。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GODOT_MCP_AUDIT_EXTERNAL_DIR = join(
  mkdtempSync(join(tmpdir(), 'mcp-audit-ext-')), 'audit',
);
