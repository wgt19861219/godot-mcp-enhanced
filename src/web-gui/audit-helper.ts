// src/web-gui/audit-helper.ts
// 批4-T8(五维评估 P2 抗抵赖): web-gui 写端点统一审计出口。
// 背景:批2(2C)只堵了 files-api 一个口子,sessions/start|stop|remove(杀/起游戏进程)
// 与 projects/add|remove(改监控清单)此前零留痕——HTTP 面与 MCP 面同语义操作审计不对称。
// 设计:caller 归一 web-gui:<子系统>(批4-T4 通道前缀约定),trace_id 每次随机,
// duration/ok 如实。best-effort:失败计数不阻断 HTTP 响应(对齐 saveText 2C 哲学)。
// 批5-N4②(批4审查挂账): 补失败留痕——ok:false + details.error(此前仅成功路径,
// HTTP 面失败操作零留痕,对照 MCP 侧 dispatcher 连失败也落 ok:false)。
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { appendAuditLine, isAuditEnabled, recordAuditWriteFailure } from '../core/audit-log.js';
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
  // 项目根不存在则跳过(appendAuditLine 会 mkdir 建目录——假路径/已删目录不应在盘根
  // 产生垃圾 .godot;真实会话路径必存在,该守卫不影响正常留痕。失败留痕同守卫——
  // projectPath 本就不存在的失败无项目可归属,不留痕合理)
  if (!existsSync(projectPath)) return;
  const details = { ...(opts?.details ?? {}) };
  if (opts?.error !== undefined) details.error = opts.error;
  void appendAuditLine(projectPath, {
    timestamp: new Date().toISOString(),
    trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
    tool: 'web-gui', action, risk,
    ok: opts?.ok ?? true, project_path: projectPath, changed_files: opts?.changedFiles ?? [],
    duration_ms: opts?.durationMs ?? 0,  // 无实测时长记 0(诚实:非测量值)
    caller: `web-gui:${subsystem}`,
    ...(Object.keys(details).length ? { details } : {}),
  }).catch((e) => { recordAuditWriteFailure(e); });
}
