// src/web-gui/audit-helper.ts
// 批4-T8(五维评估 P2 抗抵赖): web-gui 写端点统一审计出口。
// 背景:批2(2C)只堵了 files-api 一个口子,sessions/start|stop|remove(杀/起游戏进程)
// 与 projects/add|remove(改监控清单)此前零留痕——HTTP 面与 MCP 面同语义操作审计不对称。
// 设计:caller 归一 web-gui:<子系统>(批4-T4 通道前缀约定),trace_id 每次随机,
// duration/ok 如实。best-effort:失败计数不阻断 HTTP 响应(对齐 saveText 2C 哲学)。
// 批5-N4②(批4审查挂账): 补失败留痕——ok:false + details.error(此前仅成功路径,
// HTTP 面失败操作零留痕,对照 MCP 侧 dispatcher 连失败也落 ok:false)。
// 批6-N-e(批5审查挂账): 失败调用 + projectPath 不存在改落机器级审计——原 existsSync
// 守卫(防 appendAuditLine mkdir 在盘根产垃圾 .godot)连假路径越权探测的证据也一并挡掉,
// 而假路径探测恰是越权侦察常见形态。机器级(~/.godot-mcp/machine-audit.jsonl)无项目可
// 归属的安全事件语义归机器,不建目录零垃圾;成功调用路径必存在,维持跳过(竞态下无项目
// 可归属)。details.project_path_absent 标注路径不存在事实,核查者可区分两类失败。
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { appendAuditLine, appendMachineAuditLine, isAuditEnabled, recordAuditWriteFailure } from '../core/audit-log.js';
import type { RiskLevel } from '../core/tool-registry.js';

export function auditWebGui(
  subsystem: 'files' | 'sessions' | 'projects',
  action: string,
  risk: RiskLevel,
  projectPath: string,
  opts?: {
    changedFiles?: string[];
    details?: Record<string, unknown>;
    durationMs?: number;
    /** 批5-N4②: 失败操作记 ok:false(默认 true=成功)。 */
    ok?: boolean;
    /** 批5-N4②: 失败原因(入 details.error)。 */
    error?: string;
  },
): void {
  if (!isAuditEnabled()) return;
  const details = { ...(opts?.details ?? {}) };
  if (opts?.error !== undefined) details.error = opts.error;
  const ok = opts?.ok ?? true;
  if (!existsSync(projectPath)) {
    // 成功调用项目路径必存在,此分支实为失败调用(或极边缘竞态):无项目审计可归属。
    // 批6-N-e: 失败留痕落机器级——不在盘根 mkdir 垃圾目录,假路径探测证据不丢。
    if (ok) return;
    details.project_path_absent = true;
    void appendMachineAuditLine({
      trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
      tool: 'web-gui', action, risk,
      ok: false, project_path: projectPath, changed_files: opts?.changedFiles ?? [],
      duration_ms: opts?.durationMs ?? 0,  // 无实测时长记 0(诚实:非测量值)
      caller: `web-gui:${subsystem}`,
      details,
    }).catch((e) => { recordAuditWriteFailure(e); });
    return;
  }
  void appendAuditLine(projectPath, {
    timestamp: new Date().toISOString(),
    trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
    tool: 'web-gui', action, risk,
    ok, project_path: projectPath, changed_files: opts?.changedFiles ?? [],
    duration_ms: opts?.durationMs ?? 0,  // 无实测时长记 0(诚实:非测量值)
    caller: `web-gui:${subsystem}`,
    ...(Object.keys(details).length ? { details } : {}),
  }).catch((e) => { recordAuditWriteFailure(e); });
}
