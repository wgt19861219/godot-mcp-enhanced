// src/tools/audit.ts
/**
 * audit — 操作审计日志查询工具(G3,2026-08-13)。
 * action=get_log 读 {project}/.godot/mcp_audit.jsonl 统计回放;
 * action=suggest_rollback 对指定条目给诚实回滚建议(create 可删/project.godot before/其余 Git)。
 * 只读工具(审计数据由 ToolDispatcher 的 audit after middleware 自动落盘,见 audit-log.ts)。
 */
import type { Tool } from '@modelcontextprotocol/server';
import type { ToolResult, ToolContext } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsErrorResult } from './shared.js';
import { readAuditLog, suggestRollback, AUDIT_LOG_REL, getAuditFailureStats, compareAuditSources } from '../core/audit-log.js';
import { resolveProjectPath } from '../core/path-utils.js';
import { join } from 'path';

// C-1 (2026-08-14): 导出 TOOL_NAMES 供 scripts/check-tool-groups.mjs 归组对账。
// 此前不导出 → 正则提取型守门扫描不到 audit → 游离 TOOL_GROUPS 未被发现(第 4 次同类盲区)。
const TOOL_NAMES = ['audit'] as const;
export { TOOL_NAMES };

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'audit',
    description: '操作审计日志查询(G3)。action=get_log 读 {project}/.godot/mcp_audit.jsonl 统计回放'
      + '(操作计数/风险高亮/最近条目/时间范围),external=true 改读外置副本(~/.godot-mcp/audit/,'
      + '防篡改参照——项目内副本可被项目脚本触及,外置受 GDScript 沙箱覆盖)并附 divergence 比对;'
      + 'action=suggest_rollback 对指定条目给诚实回滚建议(create 类可删/project.godot before_values/其余靠 Git)。'
      + 'write/destructive 操作经 audit after middleware 自动落盘(changed_files 为项目相对路径,PII 护栏)。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['get_log', 'suggest_rollback'],
          description: 'get_log=读统计回放;suggest_rollback=对指定条目给回滚建议',
        },
        project_path: { type: 'string', description: '项目路径(默认 resolveProjectPath 自动解析)' },
        limit: { type: 'number', description: 'get_log:取末尾 N 条(默认全部)' },
        since: { type: 'string', description: 'get_log:ISO 时间过滤(只看此后)' },
        external: { type: 'boolean', description: 'get_log:读外置副本(防篡改参照)并附 divergence 行数比对' },
        entry_index: { type: 'number', description: 'suggest_rollback:条目序号(从 get_log entries[].index)' },
      },
      required: ['action'],
    },
  }];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'audit') return null;
  const action = args.action as string;
  const projectPath =
    (typeof args.project_path === 'string' && args.project_path) || resolveProjectPath();
  if (!projectPath) {
    return opsErrorResult(
      'INVALID_PARAMS',
      'project_path required (pass explicitly or run from a Godot project)',
    );
  }
  try {
    if (action === 'get_log') {
      // 2A (2026-09-19 安全加固批2): external=true 读外置副本(防篡改参照) + divergence 比对
      const external = args.external === true;
      const summary = await readAuditLog(projectPath, {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        since: typeof args.since === 'string' ? args.since : undefined,
        external,
      });
      const divergence = external ? await compareAuditSources(projectPath) : undefined;
      return textResult(
        JSON.stringify(
          // 1A (2026-09-19): 附进程内审计写入失败计数(本 server 生命周期),磁盘满/权限异常可查
          opsSuccess({
            ...summary,
            write_failures: getAuditFailureStats(),
            ...(divergence ? { divergence } : {}),
          }, [
            `audit 文件: ${external ? '外置副本(防篡改参照)' : join(projectPath, ...AUDIT_LOG_REL)}`,
            'changed_files 为项目相对路径(PII 护栏);riskHighlights 标 destructive/delete/failed',
            ...(divergence ? ['divergence.diverged=true = 项目内副本行数少于外置副本,可能被整行删改(排查篡改)'] : []),
            '回滚用 suggest_rollback + entry_index',
          ]),
        ),
      );
    }
    if (action === 'suggest_rollback') {
      const idx = typeof args.entry_index === 'number' ? args.entry_index : -1;
      if (idx < 0) {
        return opsErrorResult(
          'INVALID_PARAMS',
          'entry_index required (get it from get_log entries[].index)',
        );
      }
      const summary = await readAuditLog(projectPath); // 全量,每条带全局 index
      const entry = summary.entries.find((e) => e.index === idx);
      if (!entry) {
        return opsErrorResult(
          'NOT_FOUND',
          `entry_index ${idx} not found (total entries: ${summary.entries.length})`,
        );
      }
      const suggestion = suggestRollback(entry);
      return textResult(
        JSON.stringify(
          opsSuccess({ entry, suggestion }, [
            'supported=true 仅 create 类可自动删 / project.godot 需 before_values;其余靠 Git(诚实)',
          ]),
        ),
      );
    }
    return opsErrorResult('INVALID_PARAMS', `unknown action: ${action}`);
  } catch (err) {
    return opsErrorResult(
      'AUDIT_ERROR',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export const TOOL_META = {
  audit: {
    readonly: true,
    long_running: false,
    actionRisks: { get_log: 'read' as const, suggest_rollback: 'read' as const },
  },
};
