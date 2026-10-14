import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

/** 去除 UTF-8 BOM（Windows 工具有时写入 BOM，会破坏 JSON.parse）。 */
export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Tier2-3: 剥离 JSONC 注释（// 行注释、/* 块注释）和尾逗逗号，返回严格 JSON。
 *
 * Zed 等 editor 的 settings.json 是 JSONC（含注释），标准 JSON.parse 会失败 →
 * readJsonConfigWithBackup 把含注释的合法配置当损坏文件 backup + 覆盖，
 * 导致用户全部配置丢失。本函数在 parse 前剥离注释，让 JSONC 配置能被正确读取。
 *
 * 字符级状态机（参考 code-review-graph skills.py:428-502），零依赖。
 * 关键：字符串内的 // 和 , 不被误删（只剥结构位置的）。
 */
export function stripJsonc(raw: string): string {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  let inString = false;
  while (i < n) {
    const ch = raw[i]!;
    if (inString) {
      out.push(ch);
      if (ch === '\\' && i + 1 < n) {
        out.push(raw[i + 1]!);  // 转义字符是数据，不当分隔符
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    // 字符串外
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    const past = skipComment(raw, i);
    if (past !== null) {
      i = past;
      continue;
    }
    if (ch === ',') {
      // 尾逗逗号：下一个有意义字符（跳空白和注释）是 } 或 ] 则丢弃
      let j = i + 1;
      while (j < n) {
        if (/\s/.test(raw[j]!)) { j += 1; continue; }
        const p = skipComment(raw, j);
        if (p !== null) { j = p; continue; }
        break;
      }
      if (j < n && (raw[j] === '}' || raw[j] === ']')) {
        i += 1;  // 丢弃尾逗逗号
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** 如果 idx 位置开始是注释，返回注释结束后的 index；否则 null。 */
function skipComment(s: string, idx: number): number | null {
  if (s[idx] !== '/' || idx + 1 >= s.length) return null;
  const next = s[idx + 1];
  if (next === '/') {
    let i = idx + 2;
    while (i < s.length && s[i] !== '\n') i += 1;
    return i;
  }
  if (next === '*') {
    let i = idx + 2;
    while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
    return i + 2;  // 消费闭合 */（未闭合则扫到尾）
  }
  return null;
}

/**
 * C1 env 白名单前缀（对齐 buildSafeEnv 前缀策略，见 src/helpers.ts）。
 *
 * - `ALLOWED_PROJECT_PATHS`：用户显式配的项目路径白名单，重跑 setup 静默丢失会破坏 MCP 服务器定位项目。
 * - `GODOT_MCP_BRIDGE_`：bridge 运行时配置子命名空间（如 GODOT_MCP_BRIDGE_PERSISTENT_SECRET / *_EXTRA_METHODS），
 *   非用户凭证。丢失会使 mcp_bridge.gd 的对应开关失效。
 * - `GODOT_MCP_EDITOR_`：editor 插件运行时配置子命名空间（对称设计），丢失同样破坏插件行为。
 *
 * 安全侧：服务端安全/沙箱开关（GODOT_MCP_UNRESTRICTED / GODOT_MCP_ALLOW_UNSAFE /
 * ALLOW_EXECUTE_GDSCRIPT）刻意不在白名单内 —— 子进程不能自行解锁限制。
 */
const ENV_PRESERVE_PREFIXES = ['ALLOWED_PROJECT_PATHS', 'GODOT_MCP_BRIDGE_', 'GODOT_MCP_EDITOR_'] as const;

/**
 * C1: 构建 MCP server env，保留旧 env 中白名单前缀的用户配置（防 reconfigure 静默丢失）。
 *
 * 13 adapter 旧实现 `env: { GODOT_PATH: godotPath }` 完全覆盖 oldEntry.env —— 用户配的
 * ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_* 重跑 setup 后静默丢失，复发 DEFECT
 * cli-configure-env-field-overwrite。本 helper 仅保留白名单前缀且值为 string 的条目，
 * 其余（含脏值/非 string）过滤。
 *
 * @param godotPath 必填，始终写入 GODOT_PATH
 * @param oldEnv 旧 entry 的 env/environment 字段（Record<string, unknown>）；undefined 时仅含 GODOT_PATH
 * @returns 新 env 对象（GODOT_PATH + 白名单保留项）
 */
export function buildEnv(godotPath: string, oldEnv?: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { GODOT_PATH: godotPath };
  if (oldEnv) {
    for (const [k, v] of Object.entries(oldEnv)) {
      if (ENV_PRESERVE_PREFIXES.some(p => k === p || k.startsWith(p)) && typeof v === 'string') {
        env[k] = v;
      }
    }
  }
  return env;
}

/**
 * 读取 JSON 配置文件,用于 CLI client adapter 的 configure()。
 *
 * F3: 当文件存在但 JSON 解析失败(用户配置损坏)时,**不静默用空对象覆盖**——
 * 先把原始内容备份到 `<path>.corrupt.<uuid>.bak` 并打印警告,再返回 {} 让调用方
 * 以干净状态继续写入。备份失败(磁盘满/权限)则抛错,绝不覆盖未备份的损坏文件。
 *
 * - 文件不存在 → 返回 {}
 * - 合法 JSON（含 BOM，经 stripBom）→ 返回解析结果
 * - 损坏 JSON → 备份 raw 后返回 {}
 */
export function readJsonConfigWithBackup(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf-8');
  try {
    const parsed = JSON.parse(stripJsonc(stripBom(raw))) as Record<string, unknown>;
    // M3(2026-10-14 审查): 合法 JSONC(注释/尾逗号)解析成功但重写为纯 JSON 时,
    // 用户的 // 注释、尾逗号、缩进风格会无痕丢失且不触发损坏备份。Claude Code/
    // Cursor 配置官方支持 JSONC——解析成功但原文含 JSONC 特征(剥除后变短)时,
    // 同样落备份再返回,保住可找回的原始副本。
    if (stripBom(raw).length > stripJsonc(stripBom(raw)).length) {
      const backupPath = `${filePath}.jsonc.${randomUUID()}.bak`;
      try {
        writeFileSync(backupPath, raw, 'utf-8');
        console.warn(
          `[godot-mcp] ${filePath} contains JSONC comments/trailing commas — they will NOT be preserved on rewrite. Original backed up to ${backupPath}.`,
        );
      } catch {
        // 备份失败不阻断配置写入(与损坏路径的硬失败不同:此处数据未损坏,丢注释
        // 是降级而非破坏),warn 提示即可。
        console.warn(
          `[godot-mcp] ${filePath} contains JSONC comments/trailing commas — they will be lost on rewrite (backup failed: ${filePath} not writable).`,
        );
      }
    }
    return parsed;
  } catch {
    const backupPath = `${filePath}.corrupt.${randomUUID()}.bak`;
    writeFileSync(backupPath, raw, 'utf-8'); // 失败则抛错 — 不覆盖未备份的损坏文件
    console.warn(
      `[godot-mcp] ${filePath} contained invalid JSON — backed up to ${backupPath} before overwriting.`,
    );
    return {};
  }
}

/**
 * 读取 JSON 配置文件,用于 isConfigured() 只读检查。
 *
 * - 文件不存在 → 返回 null（调用方返 false）
 * - 合法 JSON（含 BOM，经 stripBom）→ 返回解析结果
 * - 损坏 JSON（BOM strip 后仍损坏）→ 返回 null（调用方返 false，不抛错、不备份）
 *
 * 与 readJsonConfigWithBackup 区别：只读不备份、不抛错、not_found 返 null。
 * 设计原因：isConfigured 现状是 try{...}catch{return false} 吞错；带 BOM 的合法配置
 * 若内联 JSON.parse 会 throw→catch→false→doctor 误报 + setup 破坏幂等。统一改用本函数。
 */
export function readJsonForCheck(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(stripJsonc(stripBom(readFileSync(filePath, 'utf-8')))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 原子写入配置文件并保持原有文件 mode（F3: adapter-no-mode-preserve）。
 *
 * A-ATOMIC (2026-09-01): 实现上移至 src/core/fs-atomic.ts(与 scene/project 两份
 * 重复实现合并,并集语义含 Windows 锁定降级直写),此处 re-export 保兼容。
 * 语义差异说明:rename 失败时此前直接抛错,core 版在 Windows 上降级为直写保可用
 * (与 project.ts I-1 行为一致);非 Windows 行为不变。
 */
export { writeFileAtomicWithMode } from '../../core/fs-atomic.js';
