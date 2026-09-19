/**
 * G3 (2026-08-13): 操作级审计日志(借鉴 devtool audit.jsonl,附录 F.3)。
 *
 * 修复 devtool 的 writeFile read-modify-write 并发竞态(workflowAutomation.ts:267)
 * ——改用 fs/promises.appendFile(O_APPEND 内核原子,<PIPE_BUF 字节 POSIX 原子),
 * enhanced 多实例并发安全。
 *
 * 设计要点:
 * - 事后审计(after middleware),与事前门控(确认令牌/ReadOnlyGuard)正交(纵深防御)
 * - changed_files 用项目相对路径(PII 护栏:不记绝对路径含用户名)
 * - 回滚诚实:仅 create 类可删 + project.godot before_values,其余靠 Git(不过度承诺快照)
 * - 默认开(本地 .godot/ 落盘,无外传风险),GODOT_MCP_AUDIT=false 可关
 */

import { appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { RiskLevel } from './tool-registry.js';
import { getLogger } from './logger.js';

/** audit 文件相对项目根的路径(对齐 .godot/ 惯例:mcp-instances/mcp-godot.json/mcp_editor.key)。 */
export const AUDIT_LOG_REL = ['.godot', 'mcp_audit.jsonl'] as const;

/** changed_files 单条上限(防 appendFile 超 PIPE_BUF 4KB 失去原子性)。超则截断 + truncated 标记。 */
const MAX_CHANGED_FILES = 50;

/** env 开关(默认开:本地落盘无外传,比 telemetry 安全)。 */
export function isAuditEnabled(): boolean {
  const v = process.env.GODOT_MCP_AUDIT;
  return v === undefined || v === '' || v === 'true' || v === '1';
}

// ─── 1A (2026-09-19 安全加固批1): 审计写入失败可观测 + STRICT 可选阻断 ──────────
// 背景:catch 静默导致磁盘满/权限异常时操作照常执行且零留痕零告警(G2 catch 哲学的盲区)。

export interface AuditFailureStats {
  failures: number;
  lastError: string;
}

/** 审计写入失败计数(模块级只增、无 setter,符合 AGENTS.md 分层约束——不新增注入点)。 */
let auditWriteFailures = 0;
let lastAuditWriteError = '';

export function getAuditFailureStats(): AuditFailureStats {
  return { failures: auditWriteFailures, lastError: lastAuditWriteError };
}

/** 记录一次审计写入失败:计数 + 首次失败 warn(防刷屏;此后静默计数,get_log 可查)。 */
export function recordAuditWriteFailure(err: unknown): void {
  auditWriteFailures++;
  lastAuditWriteError = err instanceof Error ? err.message : String(err);
  if (auditWriteFailures === 1) {
    getLogger().warn('audit', `audit write failed (subsequent failures counted silently, see audit.get_log write_failures): ${lastAuditWriteError}`);
  }
}

/** STRICT 模式(高安全场景 opt-in):审计写入失败时调用方将操作判失败,而非静默 best-effort。 */
export function isAuditStrict(): boolean {
  return process.env.GODOT_MCP_AUDIT_STRICT === 'true';
}

/** B-1(审查修复):检测令牌请求响应(content 含 "requires_confirmation":true,操作未执行)。
 *  audit middleware 应跳过此类,不记虚假 ok=true。真实执行经 _auditConfirmedExecution 补审计。 */
export function isTokenRequestResult(result: { content?: ReadonlyArray<unknown> }): boolean {
  return (
    result.content?.some(
      (c) =>
        typeof (c as { text?: unknown }).text === 'string' &&
        ((c as { text: string }).text).includes('"requires_confirmation":true'),
    ) ??
    false
  );
}

/** audit 条目(对齐 devtool AuditEntry 5 字段 + enhanced 适配 trace_id/risk/ok)。 */
export interface AuditEntry {
  timestamp: string;        // ISO
  trace_id: string;         // G2 关联
  tool: string;
  action: string;
  risk: RiskLevel;          // write/destructive/process
  ok: boolean;
  project_path: string;
  changed_files: string[];  // 项目相对路径(PII 护栏)
  duration_ms: number;
  caller?: string;          // 1C (2026-09-19): best-effort 调用者标识(_meta.agentId,MCP 未标准化,通常 undefined)
  details?: {
    before_values?: Record<string, unknown>;  // project.godot 等(阶段2 工具上报)
    batch?: boolean;          // project_replace/create_project 批量(主路径 + 标记)
    truncated?: boolean;      // changed_files 超 MAX_CHANGED_FILES 截断
    confirmed?: boolean;      // B-1:确认后真实执行(区别于令牌请求的虚假记录)
    [key: string]: unknown;   // 自由载荷:各工具/CLI 自定义键(如 cli install 的 versionTag/binaryUrl)
  };
}

/**
 * 原子追加一条 audit(appendFile O_APPEND,修复 devtool writeFile 竞态)。
 * 审计失败应由调用方 catch(默认 best-effort 不影响工具结果,对齐 G2 catch 哲学;
 * ⚠️ 1A STRICT 例外:GODOT_MCP_AUDIT_STRICT=true 时调用方将操作判失败——见 isAuditStrict)。
 */
export async function appendAuditLine(projectPath: string, entry: AuditEntry): Promise<void> {
  const auditPath = join(projectPath, ...AUDIT_LOG_REL);
  await mkdir(dirname(auditPath), { recursive: true });
  // changed_files 超阈值截断(防 appendFile 超 PIPE_BUF 失去原子性)
  let line_entry = entry;
  if (entry.changed_files.length > MAX_CHANGED_FILES) {
    line_entry = {
      ...entry,
      changed_files: entry.changed_files.slice(0, MAX_CHANGED_FILES),
      details: { ...entry.details, truncated: true },
    };
  }
  const line = JSON.stringify(line_entry) + '\n';
  await appendFile(auditPath, line, 'utf8');
}

/** audit 回放只读统计(不真重放执行,对齐 devtool buildAuditReplay)。 */
export interface AuditReplaySummary {
  totalEntries: number;
  timeRange: { first?: string; last?: string };
  operationCounts: Record<string, number>;     // `${tool}.${action}` → 次数
  changedFileCounts: Record<string, number>;   // 相对路径 → 被改次数
  riskHighlights: { index: number; entry: AuditEntry; reason: string }[];
  parseErrors: number;
  entries: (AuditEntry & { index: number })[];  // 最近 N 条(每条带全局 index,供 suggest_rollback 精确定位)
}

/** 风险高亮启发式(destructive/delete/failed 标记,对齐 devtool riskReason)。 */
function riskReason(e: AuditEntry): string {
  if (e.risk === 'destructive') return 'destructive operation';
  if (e.action.includes('delete') || e.action.includes('remove')) return 'delete/remove operation';
  if (!e.ok) return 'failed operation';
  return '';
}

/** 读 audit.jsonl + 只读统计。limit 取末尾 N 条;since 过滤时间。 */
export async function readAuditLog(
  projectPath: string,
  opts?: { limit?: number; since?: string },
): Promise<AuditReplaySummary> {
  const auditPath = join(projectPath, ...AUDIT_LOG_REL);
  const empty: AuditReplaySummary = {
    totalEntries: 0, timeRange: {}, operationCounts: {}, changedFileCounts: {},
    riskHighlights: [], parseErrors: 0, entries: [],
  };
  if (!existsSync(auditPath)) return empty;
  const content = await readFile(auditPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const entries: AuditEntry[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      parseErrors++;
    }
  }
  const filtered = opts?.since ? entries.filter((e) => e.timestamp >= (opts.since as string)) : entries;
  const limit = opts?.limit ?? filtered.length;
  const recent = filtered.slice(-limit);
  const operationCounts: Record<string, number> = {};
  const changedFileCounts: Record<string, number> = {};
  for (const e of filtered) {
    const key = `${e.tool}.${e.action}`;
    operationCounts[key] = (operationCounts[key] ?? 0) + 1;
    for (const f of e.changed_files) changedFileCounts[f] = (changedFileCounts[f] ?? 0) + 1;
  }
  const startIdx = filtered.length - recent.length;
  const riskHighlights = recent
    .map((e, i) => ({ index: startIdx + i, entry: e, reason: riskReason(e) }))
    .filter((h) => h.reason !== '');
  return {
    totalEntries: filtered.length,
    timeRange: filtered.length
      ? { first: filtered[0]!.timestamp, last: filtered[filtered.length - 1]!.timestamp }
      : {},
    operationCounts,
    changedFileCounts,
    riskHighlights,
    parseErrors,
    entries: recent.map((e, i) => ({ ...e, index: startIdx + i })),
  };
}

// ─── changedFiles 推断(阶段1:args 推断)──────────────────────────────────────

/** 应排除的元字段(项目根等,非 changed file)。 */
const EXCLUDE_KEYS = ['project_path'];
/** 已知路径字段名(高置信度)。 */
const KNOWN_PATH_KEYS = [
  'scene_path', 'script_path', 'file_path', 'new_path', 'instance_path',
  'texture_path', 'export_path', 'dest_path', 'output_path',
];
/** 通用路径字段后缀(兜底)。 */
const PATH_KEY_RE = /(_path|_file|_scene|_script)$/;

/** 绝对路径 → 项目相对(PII 护栏:去用户名);res:// 或项目外保留原值。统一用 /(跨平台)。 */
function relativize(p: string, projectPath?: string): string {
  if (projectPath) {
    const rel = relative(projectPath, p);
    if (rel && !rel.startsWith('..') && !rel.includes(':\\')) return rel.replace(/\\/g, '/'); // 在 project 内 → 相对(统一 /)
  }
  return p; // res:// / user:// / 项目外:保留(无绝对路径 PII)
}

/**
 * 从 args 推断 changed_files(阶段1 MVP)。
 * 限制:project_replace/create_project 批量场景只能给主路径 + batch 标记,
 * 完整文件集要阶段2(工具显式上报 ToolContext.audit 收集器)。
 */
export function inferChangedFiles(
  tool: string,
  action: string,
  args: Record<string, unknown>,
  projectPath?: string,
): { files: string[]; batch: boolean } {
  const files = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    if (EXCLUDE_KEYS.includes(key)) continue; // 排除 project_path 等元字段(项目根非 changed file)
    if (typeof value !== 'string' || !value) continue;
    if (KNOWN_PATH_KEYS.includes(key) || PATH_KEY_RE.test(key)) {
      files.add(relativize(value, projectPath));
    }
  }
  // 批量场景识别(project_replace/create_project 等:主路径 + batch 标记)
  const batch = action.includes('replace') || action.includes('create_project') ||
    action === 'create' && tool === 'project';
  return { files: [...files], batch };
}

// ─── 回滚建议(诚实:create 可删 / project.godot before / 其余 Git)──────────────

export interface RollbackSuggestion {
  supported: boolean;
  suggestions: string[];
}

/** 对单条 audit entry 生成诚实回滚建议(不自动执行,对齐 devtool suggestRollback)。 */
export function suggestRollback(entry: AuditEntry): RollbackSuggestion {
  const files = entry.changed_files;
  // create 类:可删
  if (entry.action.includes('create') && files.length > 0) {
    return {
      supported: true,
      suggestions: [`可删除本次创建的文件: ${files.join(', ')}`],
    };
  }
  // project.godot setting:从 before_values 恢复(需阶段2 工具上报)
  if (entry.tool === 'project' && entry.details?.before_values) {
    return {
      supported: true,
      suggestions: ['从 audit details.before_values 恢复 project.godot 配置项'],
    };
  }
  // destructive/delete:不可自动
  if (
    entry.risk === 'destructive' ||
    entry.action.includes('delete') ||
    entry.action.includes('remove')
  ) {
    return {
      supported: false,
      suggestions: ['删除/破坏性操作无法自动恢复,用 Git/外部备份还原'],
    };
  }
  // 其余(write/modify):靠 Git
  return {
    supported: false,
    suggestions: [
      `${entry.tool}.${entry.action}: 查 Git diff 还原(affected: ${files.join(', ') || '无记录'})`,
    ],
  };
}

// ─── 批 2:机器级审计(install 等非项目操作)──────────────────────────────────
// CLI install 装的是机器级资产(~/.godot-mcp/godot/),不落项目审计;复用 AuditEntry
// 结构与 appendFile 原子追加模式,便于同一套回放/统计工具消费。

import { homedir } from 'os';

/** 机器级审计文件:~/.godot-mcp/machine-audit.jsonl(机器级目录惯例)。 */
export function getMachineAuditFile(): string {
  return join(homedir(), '.godot-mcp', 'machine-audit.jsonl');
}

/** 追加一条机器级审计行(timestamp 由本函数补)。 */
export async function appendMachineAuditLine(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
  const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
  await mkdir(dirname(getMachineAuditFile()), { recursive: true });
  await appendFile(getMachineAuditFile(), JSON.stringify(full) + '\n', 'utf-8');
}
