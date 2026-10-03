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

import { appendFile, mkdir, readFile, stat, rename, rm } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { join, dirname, relative } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { createInterface } from 'node:readline';
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
    before_values?: Record<string, unknown>;  // 批4-T3: 工具经 structuredContent._audit 上报的写前旧值(首个生产者: project write_config)
    batch?: boolean;          // project_replace/create_project 批量(主路径 + 标记)
    truncated?: boolean;      // changed_files 超 MAX_CHANGED_FILES 截断
    confirmed?: boolean;      // B-1:确认后真实执行(区别于令牌请求的虚假记录)
    [key: string]: unknown;   // 自由载荷:各工具/CLI 自定义键(如 cli install 的 versionTag/binaryUrl)
  };
}

/** 批4-T3(五维评估 P1): 工具→审计上报通道。约定:工具可在 result.structuredContent._audit
 *  放 { before_values?: Record<string, unknown> }(写前旧值,供 suggest_rollback 的
 *  project.godot 恢复分支消费)。本函数提取 hint 并返回剥离 _audit 键后的 result——
 *  after hook 的返回值会传回 MCP 客户端,剥离防 _audit 成为半公共 API。
 *  非法形态(非对象/无 before_values)静默忽略返回原 result(审计提示是 best-effort,不阻断工具)。
 *  structuredContent 约束为 unknown 而非 Record:SDK CallToolResult 的该字段是具体
 *  union 类型,过窄约束会与真实 ToolResult 不兼容(批4 实测)。 */
export interface AuditHint {
  before_values?: Record<string, unknown>;
}

export function extractAuditHint<T extends { structuredContent?: unknown }>(
  result: T,
): { hint: AuditHint | undefined; result: T } {
  const raw = result.structuredContent;
  if (typeof raw !== 'object' || raw === null) return { hint: undefined, result };
  const sc = raw as Record<string, unknown>;
  const bv = sc._audit;
  if (typeof bv !== 'object' || bv === null) return { hint: undefined, result };
  const beforeValues = (bv as Record<string, unknown>).before_values;
  if (typeof beforeValues !== 'object' || beforeValues === null) return { hint: undefined, result };
  // 剥离 _audit(浅拷贝 structuredContent,不动原对象其余字段)
  const cleanedSc: Record<string, unknown> = { ...sc };
  delete cleanedSc._audit;
  const cleaned = { ...result, structuredContent: cleanedSc } as T;
  return { hint: { before_values: beforeValues as Record<string, unknown> }, result: cleaned };
}

/**
 * 原子追加一条 audit(appendFile O_APPEND,修复 devtool writeFile 竞态)。
 * 审计失败应由调用方 catch(默认 best-effort 不影响工具结果,对齐 G2 catch 哲学;
 * ⚠️ 1A STRICT 例外:GODOT_MCP_AUDIT_STRICT=true 时调用方将操作判失败——见 isAuditStrict)。
 * 空白 projectPath 拒绝(2026-10-01):join 相对路径会在 CWD 建怪名目录落"项目级"审计
 * (实证:ToolDispatcher 测试的 '   ' project_path 每轮全量测试在仓库根积 '   /.godot');
 * 此处 throw 交调用方既有 catch(recordAuditWriteFailure 可观测),绝不静默建目录。
 */
export async function appendAuditLine(projectPath: string, entry: AuditEntry): Promise<void> {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw new Error(`audit: blank project_path refused (tool=${entry.tool} action=${entry.action})`);
  }
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
  // 批5-T12: 大小轮转(项目内与外置副本各自独立判定,追加前检查)——高频写项目上
  // jsonl 无限增长会使 get_log 全量读越来越慢;10MB 链式轮转保留 3 代(.1/.2/.3)。
  await rotateIfNeeded(auditPath);
  await appendFile(auditPath, line, 'utf8');
  // 2A (2026-09-19 安全加固批2): 外置副本双写——防篡改主副本。
  // 项目内副本保留(audit 工具默认读它,现行为零变更);外置失败独立处理:默认计数不
  // throw(best-effort);STRICT 重抛(经调用方 catch 会再 record 一次,同一失败双计数,
  // 方向无害)。论证见 getExternalAuditDir。
  // Nit-2(审查): STRICT 下外置失败重抛时,项目内审计行已落(ok=true)而操作被判失败
  // ——审计与结果存在一次性分歧窗口;opt-in 边缘场景,回放时以 result 报错为准核对。
  const extPath = getExternalAuditFile(projectPath);
  try {
    await mkdir(dirname(extPath), { recursive: true });
    await rotateIfNeeded(extPath);
    await appendFile(extPath, line, 'utf8');
  } catch (e) {
    recordAuditWriteFailure(e);
    if (isAuditStrict()) throw e;
  }
}

// ─── 批5-T12: 大小轮转 ────────────────────────────────────────────────────────

/** 轮转阈值与保留代数(可测试性:模块常量,测试以小文件触发需另造大文件或直接测
 *  rotateIfNeeded 的行为契约——阈值本身不 mock,10MB 造文件成本可控)。 */
export const AUDIT_ROTATE_SIZE = 10 * 1024 * 1024;
export const AUDIT_ROTATE_KEEP = 3;

/** 超 AUDIT_ROTATE_SIZE 时链式轮转:.3 删(最老)→.2→.3→.1→.2→主文件→.1。
 *  文件不存在/小于阈值 no-op;轮转失败不阻断追加(best-effort——追加是主路径,
 *  轮转失败仅意味着继续增长,下次再试)。 */
export async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return; // 文件不存在(首条)——无轮转对象
  }
  if (size < AUDIT_ROTATE_SIZE) return;
  try {
    await rm(`${filePath}.${AUDIT_ROTATE_KEEP}`, { force: true });
    for (let i = AUDIT_ROTATE_KEEP - 1; i >= 1; i--) {
      try {
        await rename(`${filePath}.${i}`, `${filePath}.${i + 1}`);
      } catch { /* 该代不存在(未攒满)——跳过继续 */ }
    }
    await rename(filePath, `${filePath}.1`);
  } catch (e) {
    recordAuditWriteFailure(e);
    getLogger().warn('audit', `rotate failed for ${relative(homedir(), filePath) || filePath}: ${e instanceof Error ? e.message : e}`);
  }
}

// ─── 2A (2026-09-19 安全加固批2): 外置审计副本(防篡改第一层) ──────────────────
// 防篡改论证:项目内 .godot/ 与被审计对象同权限同生命周期,经 execute_gdscript 的
// process 能力可删改自己的审计痕迹(抗抵赖最短板);外置到 home 下,GDScript 沙箱默认
// 拦 FileAccess 读写非 res://user:// 路径,受沙箱约束的执行流删不到外置副本(要删须
// 先过 UNRESTRICTED+DISABLE_SAFETY 双 opt-in——那已是管理员授权的无限制模式)。
// env GODOT_MCP_AUDIT_EXTERNAL_DIR 可重定向(测试注入/用户自定位置;env 本身是用户
// 控制域,与 bridge registry dir 重定向同类,非安全边界)。

export function getExternalAuditDir(): string {
  return process.env.GODOT_MCP_AUDIT_EXTERNAL_DIR ?? join(homedir(), '.godot-mcp', 'audit');
}

/** 外置副本路径:按项目绝对路径 sha256 前 16 hex 命名(一项目一文件;文件名不含项目
 *  名/用户名 PII。分隔符归一防 D:\a\b 与 D:/a/b 分裂;I-1(审查)Windows 大小写归一防
 *  D:\GitHub\Demo 与 d:\github\demo 分裂——分裂不仅丢条目,还会让 compareAuditSources 的
 *  divergence(projectEntries < externalEntries)恒 false,真实删行篡改漏报。
 *  仅 win32 小写:Linux 文件系统大小写敏感,无条件小写会让不同项目碰撞同一外置文件)。 */
export function getExternalAuditFile(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/');
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const h = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(getExternalAuditDir(), `${h}.jsonl`);
}

export interface AuditDivergence {
  projectEntries: number;
  externalEntries: number;
  /** 两副本任何不一致(行数差或同位行内容不同)均为 true(批5-T11 从"单向行数比对"升级)。 */
  diverged: boolean;
  /** 批5-T11: 首个不一致行号(两副本 1-based 共同前缀之后;行数差且前缀全等时=较短方长度+1)。 */
  firstDivergentLine?: number;
  /** 批5-T11: 'length'(行数不一致)|'content'(行数一致但某行内容不同——改字段不删行的
   *  篡改形态,批4 前不可检测)。 */
  divergenceKind?: 'length' | 'content';
}

/** 项目内副本 vs 外置副本逐行内容比对(批5-T11 升级:原仅 `projectEntries < externalEntries`
 *  单向行数比对,"改字段不删行"的篡改不可检测;两副本由 appendAuditLine 双写同一 line
 *  字符串,行内容应完全一致,任何同位行差异即篡改信号)。
 *  检测力边界(诚实):双删两份副本(行数等且内容等)仍不可检测——需 hash 链/签名,见
 *  方案 §4 不做裁决(跨进程并发写断链误报);外置副本自身被同权限进程删改不检(参照系
 *  假设,与 THREAT_MODEL 诚实边界一致)。 */
export async function compareAuditSources(projectPath: string): Promise<AuditDivergence> {
  const readLines = async (p: string): Promise<string[]> => {
    try {
      return (await readFile(p, 'utf8')).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const proj = await readLines(join(projectPath, ...AUDIT_LOG_REL));
  const ext = await readLines(getExternalAuditFile(projectPath));
  const common = Math.min(proj.length, ext.length);
  for (let i = 0; i < common; i++) {
    if (proj[i] !== ext[i]) {
      return { projectEntries: proj.length, externalEntries: ext.length, diverged: true, firstDivergentLine: i + 1, divergenceKind: 'content' };
    }
  }
  if (proj.length !== ext.length) {
    return { projectEntries: proj.length, externalEntries: ext.length, diverged: true, firstDivergentLine: common + 1, divergenceKind: 'length' };
  }
  return { projectEntries: proj.length, externalEntries: ext.length, diverged: false };
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
  /** 批5-T12: 主文件旁的轮转代(.1~.N)计数——回放只覆盖主文件,轮转代需手动查。 */
  rotatedFiles: number;
}

/** 风险高亮启发式(destructive/delete/failed 标记,对齐 devtool riskReason)。 */
function riskReason(e: AuditEntry): string {
  if (e.risk === 'destructive') return 'destructive operation';
  if (e.action.includes('delete') || e.action.includes('remove')) return 'delete/remove operation';
  if (!e.ok) return 'failed operation';
  return '';
}

/** 读 audit.jsonl + 只读统计。limit 取末尾 N 条;since 过滤时间。
 *  2A: external=true 读外置副本(防篡改参照,见 getExternalAuditFile)。 */
export async function readAuditLog(
  projectPath: string,
  opts?: { limit?: number; since?: string; external?: boolean },
): Promise<AuditReplaySummary> {
  const auditPath = opts?.external ? getExternalAuditFile(projectPath) : join(projectPath, ...AUDIT_LOG_REL);
  const empty: AuditReplaySummary = {
    totalEntries: 0, timeRange: {}, operationCounts: {}, changedFileCounts: {},
    riskHighlights: [], parseErrors: 0, entries: [], rotatedFiles: 0,
  };
  if (!existsSync(auditPath)) return empty;
  // 批5-T12: 流式逐行读(readline)替代 readFile 全量进内存——峰值从"原始 content +
  // lines 数组 + entries 对象"三份降为"行缓冲 + entries 对象"两份。诚实边界:扫描量
  // 不变(取末尾 N 条仍需全扫,尾部 seek 优化挂账);空行跳过不计 parseErrors(与旧
  // filter(Boolean) 语义一致)。
  const entries: AuditEntry[] = [];
  let parseErrors = 0;
  const rl = createInterface({ input: createReadStream(auditPath, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        parseErrors++;
      }
    }
  } finally {
    rl.close();
  }
  // 批5-T12: 主文件旁的轮转代计数(.1~.N 存在几个)——回放只覆盖主文件,轮转代需
  // 手动查,响应显式提示防误判"轮转后的历史消失了"。
  let rotatedFiles = 0;
  for (let i = 1; i <= AUDIT_ROTATE_KEEP; i++) {
    if (existsSync(`${auditPath}.${i}`)) rotatedFiles++;
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
    rotatedFiles,
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
// (homedir 已在文件顶部 import)

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
