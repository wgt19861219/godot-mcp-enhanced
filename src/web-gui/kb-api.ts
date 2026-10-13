// src/web-gui/kb-api.ts
// 知识库联动纯逻辑层(2026-10-08 批,只读;settings-api/files-api 同模式):
// overview(项目卡片总览 + 断流检测) / projectDetail(开发日志列表 + 看板分节摘要) /
// readFile(开发日志正文,防穿越限 512KB)。
// vault 根现读 process.env.GODOT_MCP_VAULT_PATH——设置面板保存即热生效
// (applyUserSettings 直写 env,本层不缓存),env 兜底语义与其余设置字段一致。
//
// 知识库契约(实测 D:\workspace\Obsidian 归纳,不引 YAML 依赖):
// - 项目目录判定:含「开发日志/」目录、「任务看板.md」「项目待办.md」「* 首页.md」之一;
// - 活跃看板:候选 [项目待办.md, 任务看板.md] 取首个存在且 frontmatter status != archived 的
//   (GodotMCP 两文件并存但看板已归档;CardGameGodot2 无项目待办只有活跃看板);
// - 计数:frontmatter total/done 数字对优先;否则全文 - [x] / - [ ] 正则计数(限 2MB);
// - frontmatter:轻量手写解析(--- 块内 key: value,重复键取首个)——CardGameGodot2 看板
//   有堆叠重复 last-updated 键,完整 YAML 会解析失败;
// - 仓库映射:vault 根 CLAUDE.md「项目目录映射」表(| `repoPath` | `kbDir` |),AGENTS.md 兜底。
//
// 大文件策略:看板 frontmatter 只读前 8KB、分节摘要前 16KB(实测最大看板 1MB);多字节
// UTF-8 序列在截断处可能撕裂出 U+FFFD,仅影响末行提取,可接受(标题行不在末尾)。

import { execFile } from 'node:child_process';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { resolveWithinRoot } from '../core/path-utils.js';

/** 只读文件上限,对齐 files-api TEXT_MAX(512KB)。 */
export const KB_TEXT_MAX = 512 * 1024;
/** 看板 frontmatter 头部读取上限。 */
const BOARD_HEAD_BYTES = 8 * 1024;
/** 看板分节摘要读取上限。 */
const BOARD_SUMMARY_BYTES = 16 * 1024;
/** 全文复选框计数的文件大小上限(实测最大看板 ~1MB,2MB 留裕量)。 */
const BOARD_COUNT_MAX = 2 * 1024 * 1024;
/** 开发日志文件名日期前缀:YYYY-MM-DD 标题.md。 */
const LOG_NAME_RE = /^(\d{4}-\d{2}-\d{2})\s*(.*?)\.md$/;
/** 详情日志列表上限。 */
const DETAIL_LOG_LIMIT = 50;
/** 看板分节摘要条数上限。 */
const BOARD_SECTION_LIMIT = 30;
/** 断流判定阈值(天):git 最近 commit 晚于最近日志超过该天数 = 疑似断流。 */
export const STALL_THRESHOLD_DAYS = 3;
/** 「项目在开发」观察窗(天,审查 N-6):无日志分支的 stall 需 commit 距今在该窗内——
 *  死项目(commit 半年前、知识库从未建)不算断流,只有近期还在提交却从未记录才标 🔴。 */
export const RECENT_COMMIT_WINDOW_DAYS = 90;
/** git log 结果缓存 TTL。 */
const GIT_CACHE_TTL_MS = 10 * 60 * 1000;
/** git 并发上限。 */
const GIT_CONCURRENCY = 8;
/** 看板候选,顺序即优先级(项目待办 = 任务看板归档后的演进形态)。 */
const BOARD_CANDIDATES = ['项目待办.md', '任务看板.md'] as const;
/** 映射表源文件,CLAUDE.md 优先 AGENTS.md 兜底(两文件同格式)。 */
const MAP_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

export type KbErrorCode = 'bad_request' | 'not_found' | 'forbidden' | 'too_large' | 'not_configured';

export class KbError extends Error {
  constructor(readonly code: KbErrorCode, message: string) {
    super(message);
  }
}

export interface KbProjectCard {
  /** vault 内项目目录名。 */
  name: string;
  /** 活跃看板文件名;null = 无活跃看板(两者均归档/缺席)。 */
  boardFile: string | null;
  boardStatus: string;
  done: number | null;
  total: number | null;
  /** 最近开发日志日期(YYYY-MM-DD,来自文件名);null = 无日志。 */
  lastLogDate: string | null;
  lastLogTitle: string;
  /** CLAUDE.md 映射到的本地仓库绝对路径;null = 映射表无此项目。 */
  repoPath: string | null;
  /** git 最近 commit ISO 日期;null = 无仓库/查询失败。 */
  lastCommitDate: string | null;
  /** commit 晚于最近日志的天数;null = 不可算。 */
  stallDays: number | null;
  /** 疑似断流:代码在动而知识库停滞(超 STALL_THRESHOLD_DAYS 天,或有 commit 而从未有日志)。 */
  stall: boolean;
}

export interface KbOverview {
  configured: boolean;
  /** vault 根存在性(configured 但目录缺失时前端给修复引导)。 */
  vaultExists: boolean;
  /** vault 目录名(obsidian:// URI 的 vault 参数)。 */
  vaultName: string;
  projects: KbProjectCard[];
}

export interface KbLogEntry {
  /** 相对「开发日志/」的文件名。 */
  file: string;
  date: string;
  title: string;
  /** frontmatter status 原值;'' = 未写。 */
  status: string;
}

export interface KbBoardSection {
  text: string;
}

export interface KbProjectDetail {
  name: string;
  board: {
    file: string;
    done: number | null;
    total: number | null;
    sections: KbBoardSection[];
  } | null;
  logs: KbLogEntry[];
}

export interface KbFileContent {
  content: string;
  size: number;
}

/** git 最近 commit 查询注入面(测试隔离);返回 %cI ISO 串,null = 无仓库/失败。 */
export type GitLogFn = (repoPath: string) => Promise<string | null>;

/** 简单并发限制 map(信号量模式;git 查询用)。导出供并发上限直接单测(审查 N-5)。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 读文件头部前 bytes 字节(frontmatter/摘要提取用,避免整读 1MB 看板)。 */
async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** 轻量 frontmatter 解析:--- 块内 `key: value` 行;重复键取首个(堆叠 last-updated 容错);
 *  列表/多行值不解析(本层只需要标量)。 */
export function parseFrontmatterHead(head: string): Record<string, string> {
  const lines = head.split('\n');
  const first = lines[0] ?? '';
  if (first.trim().replace(/^\uFEFF/, '') !== '---') return {};
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1]!;
      if (!(key in out)) out[key] = m[2]!.trim();
    }
  }
  return out;
}

/** 全文复选框计数:- [x]/- [X] 与 - [ ](含缩进嵌套);超 BOARD_COUNT_MAX 抛 too_large。 */
function countCheckboxes(content: string): { done: number; total: number } {
  const done = (content.match(/-\s?\[[xX]\]/g) ?? []).length;
  const todo = (content.match(/-\s?\[\s\]/g) ?? []).length;
  return { done, total: done + todo };
}

interface BoardInfo {
  file: string;
  status: string;
  done: number | null;
  total: number | null;
}

/** 活跃看板判定 + 计数(候选顺序即优先级;archived 跳过;frontmatter 计数优先,全文兜底)。 */
async function pickBoard(projectDir: string): Promise<BoardInfo | null> {
  for (const f of BOARD_CANDIDATES) {
    const abs = join(projectDir, f);
    let st;
    try { st = await stat(abs); } catch { continue; }
    if (!st.isFile()) continue;
    // 审查 Nit-K1(2026-10-13):readHead 容错对齐 N-2 语义(Windows EBUSY/权限单文件异常
    // 不该炸整个 overview)——frontmatter 读取失败跳过本候选试下一个。
    let fm: ReturnType<typeof parseFrontmatterHead>;
    try { fm = parseFrontmatterHead(await readHead(abs, BOARD_HEAD_BYTES)); } catch { continue; }
    const status = fm.status ?? '';
    if (status.toLowerCase() === 'archived') continue;
    const fmTotal = Number(fm.total);
    const fmDone = Number(fm.done);
    let done: number | null = null;
    let total: number | null = null;
    if (Number.isFinite(fmTotal) && Number.isFinite(fmDone) && fmTotal > 0) {
      total = fmTotal;
      done = fmDone;
    } else if (st.size <= BOARD_COUNT_MAX) {
      try {
        ({ done, total } = countCheckboxes(await readFile(abs, 'utf-8')));
      } catch { /* Nit-K1:计数读取失败降级为 null(看板文件仍可展示,仅进度缺席) */ }
    }
    return { file: f, status, done, total };
  }
  return null;
}

/** 开发日志目录列表(倒序),解析文件名日期+标题;无目录返回 []。
 *  单文件 frontmatter 读取失败(审查 N-2:Windows EBUSY/权限)跳过该文件——列表页
 *  单文件异常不该炸整个 overview(文件名+日期仍可展示,仅 status 缺席)。 */
async function listLogs(projectDir: string, limit: number): Promise<KbLogEntry[]> {
  const dir = join(projectDir, '开发日志');
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const entries: KbLogEntry[] = [];
  for (const name of names) {
    const m = LOG_NAME_RE.exec(name);
    if (!m) continue;
    let status = '';
    try {
      status = parseFrontmatterHead(await readHead(join(dir, name), 4096)).status ?? '';
    } catch { /* 单文件读取失败:status 置空继续(审查 N-2) */ }
    entries.push({ file: name, date: m[1]!, title: m[2]!.trim() || name, status });
  }
  entries.sort((a, b) => b.file.localeCompare(a.file));
  return entries.slice(0, limit);
}

/** 解析 CLAUDE.md/AGENTS.md「项目目录映射」表:| `repoPath` | `kbDir` | 行 → kbDir(去尾斜杠) → repoPath。
 *  表头/分隔行无反引号自然跳过;格式异常行静默跳过(用户手写文件,容错优先)。
 *  取"第一对反引号 = repoPath、最后一对 = kbDir"(真机验证 2026-10-08:GodotMCP 行
 *  附注含旧仓库路径的反引号段,居中取第 2 对会误把旧路径当 kbDir → 映射丢失;两侧
 *  各取与全部现存行形态一致)。 */
export function parseRepoMapLine(line: string): { repoPath: string; kbDir: string } | null {
  if (!line.startsWith('|')) return null;
  const ticks = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]!.trim());
  if (ticks.length < 2) return null;
  const repoPath = ticks[0]!;
  const kbDir = ticks[ticks.length - 1]!.replace(/[\\/]+$/, '');
  if (!isAbsolute(repoPath) || kbDir === '') return null;
  return { repoPath, kbDir };
}

async function readRepoMap(vault: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of MAP_FILES) {
    let content: string;
    try { content = await readFile(join(vault, f), 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const parsed = parseRepoMapLine(line);
      if (parsed && !map.has(parsed.kbDir)) map.set(parsed.kbDir, parsed.repoPath);
    }
    if (map.size > 0) return map;   // CLAUDE.md 命中即不读 AGENTS.md
  }
  return map;
}

/** 默认 git 实现:git log -1 --format=%cI(2s 超时;cwd=repoPath)。 */
function defaultGitLog(repoPath: string): Promise<string | null> {
  return new Promise((resolveP) => {
    execFile('git', ['log', '-1', '--format=%cI'], { cwd: repoPath, timeout: 2000, windowsHide: true }, (err, stdout) => {
      resolveP(err || !stdout.trim() ? null : stdout.trim());
    });
  });
}

/** 项目目录名安全校验:单段(无路径分隔符)、非 ..。 */
function safeProjectName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new KbError('bad_request', 'invalid project name');
  }
  return name;
}

/** 目录是否为项目知识库目录(判定契约见文件头注释)。 */
async function isKbProjectDir(vault: string, name: string): Promise<boolean> {
  const dir = join(vault, name);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name === '开发日志') return true;
      if (e.isFile() && (e.name === '任务看板.md' || e.name === '项目待办.md')) return true;
      if (e.isFile() && e.name.endsWith(' 首页.md')) return true;
    }
  } catch { /* 目录不可读/不存在:非项目目录 */ }
  return false;
}

/** 断流天数:commit 晚于日志多少天;不可算返回 null。 */
function computeStallDays(lastCommitDate: string | null, lastLogDate: string | null): number | null {
  if (lastCommitDate === null || lastLogDate === null) return null;
  const commit = Date.parse(lastCommitDate);
  const log = Date.parse(`${lastLogDate}T00:00:00`);
  if (!Number.isFinite(commit) || !Number.isFinite(log)) return null;
  return Math.floor((commit - log) / 86_400_000);
}

export interface KbApiOpts {
  /** vault 根注入(测试隔离);缺省现读 env GODOT_MCP_VAULT_PATH。 */
  vaultDir?: string;
  /** git log 注入(测试隔离);缺省 spawn git。 */
  gitLog?: GitLogFn;
}

export class KbApi {
  private readonly gitLog: GitLogFn;
  private readonly gitCache = new Map<string, { date: string | null; at: number }>();
  /** 测试注入的固定 vault 根(优先于 env)。 */
  private readonly fixedVault: string | undefined;

  constructor(opts: KbApiOpts = {}) {
    this.gitLog = opts.gitLog ?? defaultGitLog;
    this.fixedVault = opts.vaultDir;
  }

  /** 生效 vault 根(注入优先,env 兜底);'' = 未配置。 */
  private vaultRoot(): string {
    return this.fixedVault ?? process.env.GODOT_MCP_VAULT_PATH ?? '';
  }

  /** 带缓存的 git 查询(TTL 内复用;并发安全——重复请求只是多算一次覆盖同值)。 */
  private async gitLastCommit(repoPath: string): Promise<string | null> {
    const hit = this.gitCache.get(repoPath);
    if (hit && Date.now() - hit.at < GIT_CACHE_TTL_MS) return hit.date;
    const date = await this.gitLog(repoPath);
    this.gitCache.set(repoPath, { date, at: Date.now() });
    return date;
  }

  async overview(): Promise<KbOverview> {
    const vault = this.vaultRoot();
    if (vault === '') return { configured: false, vaultExists: false, vaultName: '', projects: [] };
    let st;
    try { st = await stat(vault); } catch { st = undefined; }
    if (st === undefined || !st.isDirectory()) {
      return { configured: true, vaultExists: false, vaultName: basename(vault), projects: [] };
    }
    const names = (await readdir(vault, { withFileTypes: true }))
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    const projectNames = (await mapLimit(names, 16, async (n) => (await isKbProjectDir(vault, n)) ? n : null))
      .filter((n): n is string => n !== null);
    const repoMap = await readRepoMap(vault);

    // fs 探测与 git 查询共用 8 并发(45 项目 × 2-3 个 fs 毫秒级操作;git spawn 是瓶颈,GIT_CONCURRENCY 即上限)
    const cards = await mapLimit(projectNames, GIT_CONCURRENCY, async (name): Promise<KbProjectCard> => {
      const projectDir = join(vault, name);
      const board = await pickBoard(projectDir);
      const logs = await listLogs(projectDir, 1);
      const lastLog = logs[0] ?? null;
      const repoPath = repoMap.get(name) ?? null;
      let lastCommitDate: string | null = null;
      if (repoPath !== null && await hasGitDir(repoPath)) {
        lastCommitDate = await this.gitLastCommit(repoPath);
      }
      const stallDays = computeStallDays(lastCommitDate, lastLog?.date ?? null);
      // 断流口径(审查 N-6 修正):有日志 → commit 晚于日志超阈值即断流;无日志 → 仅当
      // commit 落在「项目在开发」观察窗内(近期还在提交却从未记录)才断流——刚起步项目
      // (commit ≤3 天,还没来得及写日志)与死项目(commit >90 天)都不冤枉。
      const stall = lastCommitDate !== null && (lastLog !== null
        ? (stallDays ?? 0) > STALL_THRESHOLD_DAYS
        : (() => {
          const age = Date.now() - Date.parse(lastCommitDate);
          return age > STALL_THRESHOLD_DAYS * 86_400_000 && age <= RECENT_COMMIT_WINDOW_DAYS * 86_400_000;
        })());
      return {
        name,
        boardFile: board?.file ?? null,
        boardStatus: board?.status ?? '',
        done: board?.done ?? null,
        total: board?.total ?? null,
        lastLogDate: lastLog?.date ?? null,
        lastLogTitle: lastLog?.title ?? '',
        repoPath,
        lastCommitDate,
        stallDays,
        stall,
      };
    });
    // 排序(2026-10-08 用户反馈重设计):断流警示最前(检测核心价值);其余按「最近活动」
    // (lastCommitDate 与 lastLogDate 取新者)倒序——原版仅按 lastLogDate 倒序,半年前的
    // 死日志项目压在"近期提交但未写日志"的活跃项目之上(用户反馈"早已不活跃的排在前面");
    // 无任何活动信号(无 commit 无日志)自然沉底,同活动时间按名称稳定。
    // 字符串可比性:两源均为 ISO 前缀(2026-10-08T… 与 2026-10-08),字典序对日期有效。
    const activityOf = (c: (typeof cards)[number]): string => {
      const commit = c.lastCommitDate ?? '';
      const log = c.lastLogDate ?? '';
      return commit > log ? commit : log;
    };
    cards.sort((a, b) => {
      if (a.stall !== b.stall) return a.stall ? -1 : 1;
      const aa = activityOf(a);
      const bb = activityOf(b);
      if (aa !== bb) return bb.localeCompare(aa);
      return a.name.localeCompare(b.name);
    });
    return { configured: true, vaultExists: true, vaultName: basename(vault), projects: cards };
  }

  async projectDetail(name: string): Promise<KbProjectDetail> {
    const vault = this.requireVault();
    safeProjectName(name);
    // 项目集与 overview 同源(审查 N-1):非项目知识库目录一律 not_found——vault 下
    // 任意子目录不再可经 detail 探测存在性(404 vs 200 差分面消除)。
    if (!(await isKbProjectDir(vault, name))) throw new KbError('not_found', 'project dir not found');
    const projectDir = join(vault, name);
    const board = await pickBoard(projectDir);
    const sections: KbBoardSection[] = [];
    if (board !== null) {
      // 审查 Nit-K1(2026-10-13):分节摘要读取容错对齐 N-2——EBUSY/权限时 sections
      // 置空(看板计数仍在),不再让整个 projectDetail 500。
      let head = '';
      try { head = await readHead(join(projectDir, board.file), BOARD_SUMMARY_BYTES); } catch { /* Nit-K1 */ }
      for (const line of head.split('\n')) {
        if (sections.length >= BOARD_SECTION_LIMIT) break;
        const callout = /^>\s*\[![A-Za-z]+\]\s*(.+)$/.exec(line);
        if (callout) { sections.push({ text: callout[1]!.trim() }); continue; }
        const heading = /^##\s+(?!#)(.+)$/.exec(line);
        if (heading) sections.push({ text: heading[1]!.trim() });
      }
    }
    return {
      name,
      board: board === null ? null : { file: board.file, done: board.done, total: board.total, sections },
      logs: await listLogs(projectDir, DETAIL_LOG_LIMIT),
    };
  }

  /** 开发日志正文(只读;rel 限制在 <vault>/<name>/开发日志/ 内,防穿越链复用 resolveWithinRoot)。 */
  async readFile(name: string, rel: string): Promise<KbFileContent> {
    const vault = this.requireVault();
    safeProjectName(name);
    // 项目集同源(审查 N-1):非项目目录统一 not_found;logRoot 缺席(项目无 开发日志/)
    // 同样 not_found——语义先于穿越链(不存在 > 越界)。
    if (!(await isKbProjectDir(vault, name))) throw new KbError('not_found', 'project dir not found');
    const logRoot = join(vault, name, '开发日志');
    let rootSt;
    try { rootSt = await stat(logRoot); } catch { throw new KbError('not_found', 'log dir not found'); }
    if (!rootSt.isDirectory()) throw new KbError('not_found', 'log dir not found');
    let abs: string;
    try {
      abs = resolveWithinRoot(logRoot, rel);
    } catch {
      throw new KbError('forbidden', 'path escapes log dir');
    }
    let st;
    try { st = await stat(abs); } catch { throw new KbError('not_found', 'file not found'); }
    if (st.isDirectory()) throw new KbError('bad_request', 'is a directory');
    if (!abs.endsWith('.md')) throw new KbError('bad_request', 'only .md files are readable');
    if (st.size > KB_TEXT_MAX) throw new KbError('too_large', `file ${st.size}B exceeds 512KB limit`);
    return { content: await readFile(abs, 'utf-8'), size: st.size };
  }

  private requireVault(): string {
    const vault = this.vaultRoot();
    if (vault === '') throw new KbError('not_configured', 'vault path not configured');
    return vault;
  }
}

/** repoPath 下是否有 .git(目录或文件,worktree 是文件)。 */
async function hasGitDir(repoPath: string): Promise<boolean> {
  try { await stat(join(repoPath, '.git')); return true; } catch { return false; }
}
