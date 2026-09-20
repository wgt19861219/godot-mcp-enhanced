// src/cli/audit-helper.ts
// 批4-T9(五维评估 P2 抗抵赖): CLI 写面的机器级/项目级审计出口。
// 背景:setup/configure 改 MCP 客户端配置(安全敏感——改它即可注入恶意 MCP server)、
// init 写 project.godot、skills 写 ~/.claude/skills/,此前全部零审计(评估 P2-3)。
// 设计:caller 归一 cli:<命令>(批4-T4 通道前缀约定);best-effort 失败 warn 不阻断 CLI。
import { randomUUID } from 'crypto';
import { appendAuditLine, appendMachineAuditLine, isAuditEnabled, type AuditEntry } from '../core/audit-log.js';

/** CLI 改 MCP 客户端配置(setup/configure)→ 机器级留痕 */
export function auditClientConfigured(caller: 'cli:setup' | 'cli:configure', clientName: string, scope: string, projectDir: string): void {
  void appendMachineAuditLine({
    trace_id: `cli-${randomUUID().slice(0, 16)}`,
    tool: 'cli', action: 'configure_client', risk: 'write',
    ok: true, project_path: projectDir, changed_files: [], duration_ms: 0,
    caller,
    details: { client: clientName, scope },
  }).catch((e) => {
    console.warn(`[godot-mcp] machine-audit write failed (best-effort): ${e instanceof Error ? e.message : e}`);
  });
}

/** CLI 移除 MCP 客户端注册(uninstall)→ 机器级留痕。
 *  与 configure 对称:删注册同样是安全敏感写面(抗抵赖要覆盖反向操作),
 *  删光注册后恶意注入就无迹可寻。 */
export function auditClientRemoved(clientName: string, scope: string, projectDir: string): void {
  void appendMachineAuditLine({
    trace_id: `cli-${randomUUID().slice(0, 16)}`,
    tool: 'cli', action: 'remove_client', risk: 'write',
    ok: true, project_path: projectDir, changed_files: [], duration_ms: 0,
    caller: 'cli:uninstall',
    details: { client: clientName, scope },
  }).catch((e) => {
    console.warn(`[godot-mcp] machine-audit write failed (best-effort): ${e instanceof Error ? e.message : e}`);
  });
}

/** CLI init 写 project.godot → 项目级留痕(changed_files 项目相对路径,PII 护栏)。
 *  caller 必须由复用方显式归因(审查 Important-2:硬编码会让第二个调用方——uninstall——
 *  的写面被归到 init,抗抵赖归因错标);默认值仅为 init 存量调用保兼容。 */
export function auditCliProjectWrite(
  projectDir: string,
  action: string,
  changedFiles: string[],
  details?: Record<string, unknown>,
  caller: string = 'cli:init',
): void {
  // N-4①(批4审查): 项目级审计受 GODOT_MCP_AUDIT 开关控制(与 dispatcher/web-gui 语义一致;
  // 机器级 appendMachineAuditLine 恒写是 T7 的有意设计,不在此列)
  if (!isAuditEnabled()) return;
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    trace_id: `cli-${randomUUID().slice(0, 16)}`,
    tool: 'cli', action, risk: 'write',
    ok: true, project_path: projectDir, changed_files: changedFiles, duration_ms: 0,
    caller,
  };
  if (details) entry.details = details;
  void appendAuditLine(projectDir, entry).catch((e) => {
    console.warn(`[godot-mcp] audit write failed (best-effort): ${e instanceof Error ? e.message : e}`);
  });
}

/** CLI skills 分发写 ~/.claude/skills/ → 机器级留痕(目标在用户目录非项目内) */
export function auditSkillsInstall(dstCount: number): void {
  void appendMachineAuditLine({
    trace_id: `cli-${randomUUID().slice(0, 16)}`,
    tool: 'cli', action: 'install_skills', risk: 'write',
    ok: true, project_path: '', changed_files: [], duration_ms: 0,
    caller: 'cli:skills',
    details: { files: dstCount },
  }).catch((e) => {
    console.warn(`[godot-mcp] machine-audit write failed (best-effort): ${e instanceof Error ? e.message : e}`);
  });
}
