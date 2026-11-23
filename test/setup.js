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

// 0.36.8 审查 Important-3: bridge registry 目录重定向到临时目录——GodotServer 构造器的
// 启动 sweep(bridge-client.ts sweepStaleBridgeArtifacts,读 machineRegistryInstancesDir)
// 默认面会 unlink 真实 ~/.godot-mcp/instances/ 的死 pid 条目;未重定向时每个 new GodotServer
// 的既有测试(godot-server/editor-fallback/b4-typed-outputs 等)都在清扫真实机器 registry
// (违反"测试不碰真实 ~/.godot-mcp/"纪律且行为依赖机器状态不可重现)。对齐上方
// AUDIT_EXTERNAL_DIR 模式,instances 子目录不预创建(与真实机器"目录可能不存在"语义一致,
// sweep/read 均容不存在)。bridge 专属注入测试自行覆盖本值。
process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = join(
  mkdtempSync(join(tmpdir(), 'mcp-reg-')), 'instances',
);

// 内存治理一期 Task 4(2026-11-22):测试环境默认关 memory-guard——七处 spawn 漏斗接入
// acquireLease 后,未 mock memory-guard 的既有测试会真起 PowerShell 采样(每文件 ~3 进程)
// + 写真实 ~/.godot-mcp/memory-leases.json。设 0 走 dummy lease 短路(零采样/零写盘),
// 漏斗行为对既有测试零影响。memory-guard 专属测试(test/core/memory-guard*.test.ts)自管
// env(delete/stubEnv 覆盖本值);漏斗测试 vi.mock 接管 acquireLease,与本值无关。
process.env.GODOT_MCP_MEMORY_GUARD = '0';

// memory-guard 四期:采样文件重定向到临时目录——memSample 默认开,不重定向则任何
// 走真实采样的测试写真实 ~/.godot-mcp/memory-guard-events.jsonl。采样专属测试自行覆盖本值。
process.env.GODOT_MCP_MEM_SAMPLE_FILE = join(
  mkdtempSync(join(tmpdir(), 'mcp-mem-sample-')), 'memory-guard-events.jsonl',
);
