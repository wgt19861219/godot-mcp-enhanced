// src/core/bpy-sandbox.ts
// execute_bpy 的 best-effort 危险 API 静态扫描,对齐 execute_gdscript scanGdscriptSandbox 纵深防御。
// 同 GDScript 沙箱:防误用层非防对抗(字符串拼接/反射可绕过),真正隔离须容器/VM。
import { getLogger } from './logger.js';
import { escapeRegExp } from './sandbox-scanner.js';  // 批5审查 Nit-1:core 内直连新家,不走 src 根 re-export 绕行

// Python 危险 API 模式(对齐 DANGEROUS_PATTERNS 精神)。在剥字符串/注释后的 skeleton 上匹配。
const DANGEROUS_BPY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bos\.system\b/, label: 'os.system (system command)' },
  { pattern: /\bos\.popen\b/, label: 'os.popen (system command)' },
  { pattern: /\bos\.exec/, label: 'os.exec* (system command)' },
  // S-2: 补 os.spawn*/os.posix_spawn*(与 os.system 等价的进程派生族,原清单漏)
  { pattern: /\bos\.spawn\w*\b/, label: 'os.spawn* (system command)' },
  { pattern: /\bos\.posix_spawn\w*\b/, label: 'os.posix_spawn* (system command)' },
  { pattern: /\bsubprocess\b/, label: 'subprocess (system command)' },
  { pattern: /\bos\.remove\b|\bos\.unlink\b|\bshutil\.rmtree\b/, label: 'file/dir deletion' },
  // negative lookbehind 排除方法调用(`bpy.ops.image.open(...)`/`x.open(...)`)与标识符拼接(`xopen(`)，
  // 仅匹配裸 builtin `open(`（host fs 访问面）。JS lookbehind ES2018+ Node 支持。
  { pattern: /(?<![\w.])open\s*\(/, label: 'file open (host fs access)' },
  { pattern: /\beval\s*\(/, label: 'eval (arbitrary code)' },
  { pattern: /\bexec\s*\(/, label: 'exec (arbitrary code)' },
  { pattern: /\b__import__\s*\(/, label: '__import__ (dynamic import bypass)' },
  { pattern: /\bctypes\b/, label: 'ctypes (native code execution)' },
];

// 简化 stripLiterals:剥 # 注释 + 单/双/三引号字符串内容(仅用于扫描,不改原文)。
// GDScript stripLiterals 较重;bpy 场景用轻量正则剥离即可(防字符串内 API 名误报)。
function stripPythonLiterals(code: string): string {
  return code
    .replace(/#[^\n]*/g, '')            // 注释
    .replace(/'''[\s\S]*?'''/g, '""')   // 三引号字符串
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''") // 单引号字符串
    .replace(/"(?:\\.|[^"\\])*"/g, '""');// 双引号字符串
}

// P2-1: Python 危险 API token（对齐 gdscript-executor DANGEROUS_API_TOKENS 精神）。
// 用于 detectBpyStringConcatBypass 检测字符串拼接绕过（如 getattr(__builtins__, "ex"+"ec")）。
// 对应 DANGEROUS_BPY_PATTERNS 的 label，但用 token 形式供拼接重构匹配。
const BPY_DANGEROUS_TOKENS: readonly string[] = [
  'os.system', 'os.popen', 'os.exec', 'os.execv', 'os.execve',
  'subprocess', 'os.remove', 'os.unlink', 'shutil.rmtree',
  'eval', 'exec', '__import__', 'compile',
  'ctypes', 'getattr',  // 反射入口：getattr(__builtins__, ...) 是典型绕过路径
];

/**
 * P2-1: 检测 Python 字符串拼接绕过（对齐 gdscript-executor detectStringConcatBypass:181）。
 * 滑动窗口重构相邻字符串字面量，匹配 BPY_DANGEROUS_TOKENS。
 * 例：getattr(__builtins__, "ex"+"ec") → "ex"+"ec" 重构为 "exec" 命中 token。
 *
 * ⚠️ 安全限制（与 GDScript 沙箱同）：不解析 Python AST，只防常见拼接绕过。
 * 确定性攻击者仍可绕过（变量传递/动态分派），对抗边界须容器/VM 隔离。
 */
function detectBpyStringConcatBypass(code: string): string[] {
  const warnings: string[] = [];
  // 提取所有字符串字面量内容（单/双引号，不含三引号——三引号已在 stripPythonLiterals 剥离，
  // 但此处需原文 code 的字面量做重构，故独立提取）
  const stringContents: string[] = [];
  const stringLiteralRe = /(?<!\\)"([^"\\]*(?:\\.[^"\\]*)*)"|(?<!\\)'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = stringLiteralRe.exec(code)) !== null) {
    const content = match[1] ?? match[2];
    if (content) stringContents.push(content);
  }

  // 滑动窗口重构相邻字符串拼接，检查是否命中危险 token
  // 对齐 gdscript detectStringConcatBypass 的 MAX_CONCAT_WINDOW=8（覆盖常见分段，9+ 段依赖容器）
  const MAX_CONCAT_WINDOW = 8;
  for (let i = 0; i < stringContents.length; i++) {
    for (let j = i; j < Math.min(i + MAX_CONCAT_WINDOW, stringContents.length); j++) {
      const combined = stringContents.slice(i, j + 1).join('');
      for (const token of BPY_DANGEROUS_TOKENS) {
        const dotIdx = token.indexOf('.');
        const suffix = dotIdx >= 0 ? token.slice(dotIdx) : null;
        // 完全匹配 或 后缀匹配（如 ".execute" 防 ClassName + ".execute"）
        if (combined === token || (suffix !== null && combined === suffix)) {
          warnings.push(`[BPY-SANDBOX-P2] String concatenation bypass attempt: "${token}" built from parts`);
          break;
        }
      }
    }
  }
  return warnings;
}

/**
 * NIT-2: 检测 Python % 格式化字符串构造危险 API（对齐 gdscript-executor C-01-fix:217）。
 * Python 的 `"OS%s" % "system"` 等价于字符串拼接，是 detectBpyStringConcatBypass 的补充。
 * 只匹配含危险 token 前缀/后缀的字面量 + % 格式化，避免误报 `"Score: %d" % value`。
 *
 * ⚠️ 安全限制（同 detectBpyStringConcatBypass）：不解析 Python AST，只防常见构造。
 */
function detectBpyFormatStringBypass(code: string): string[] {
  const warnings: string[] = [];
  for (const token of BPY_DANGEROUS_TOKENS) {
    const dotIdx = token.indexOf('.');
    const suffix = dotIdx >= 0 ? token.slice(dotIdx) : null;
    // Match: "OS%s" / "os.%s" — 危险 token 前缀 + % 格式化（如 "OS%s" % "system" → "OSsystem"）
    // Guard: 跳过 prefixPart 为空（token 以 '.' 开头，如 .execute）防误报裸 "%s"
    const prefixPart = dotIdx >= 0 ? token.slice(0, dotIdx) : token;
    if (prefixPart && new RegExp(`["']${escapeRegExp(prefixPart)}%[sdr]["']`).test(code)) {
      warnings.push(`[BPY-SANDBOX-P2] % format string constructs dangerous API: "${token}"`);
    }
    // Match: ".execute" %s — 危险 token 后缀构造（如 ClassName + ".%s" % "execute"）
    if (suffix && new RegExp(`["']${escapeRegExp(suffix)}["'].*%[sdr]`).test(code)) {
      warnings.push(`[BPY-SANDBOX-P2] % format string constructs dangerous suffix: "${suffix}"`);
    }
  }
  return warnings;
}

export function scanBpySandbox(code: string): string[] {
  // S-1: 对齐 scanGdscriptSandbox 的 P0-1 双 opt-in 契约(gdscript-executor.ts:1054-1055):
  // 需 GODOT_MCP_UNRESTRICTED=true 同时设 GODOT_MCP_DISABLE_SAFETY/ALLOW_UNSAFE 才旁路。
  // 原单 || 会因 CI/Docker 遗留单个 DISABLE_SAFETY=true 静默旁路整个 bpy Python RCE 沙箱。
  const bypass = process.env.GODOT_MCP_UNRESTRICTED === 'true'
    && (process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true');
  if (bypass) {
    getLogger().warn('security', '⚠️ execute_bpy sandbox bypassed (UNRESTRICTED + DISABLE_SAFETY/ALLOW_UNSAFE). Full Python RCE surface.');
    return [];
  }
  if (process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true') {
    // 单设 DISABLE_SAFETY 而无 UNRESTRICTED:保持沙箱激活(对齐 gdscript-executor.ts:429)
    getLogger().warn('security', 'GODOT_MCP_DISABLE_SAFETY/ALLOW_UNSAFE ignored for execute_bpy — requires GODOT_MCP_UNRESTRICTED=true (S-1 double-opt-in). Sandbox stays active.');
  }
  const warnings: string[] = [];
  const skeleton = stripPythonLiterals(code);
  for (const { pattern, label } of DANGEROUS_BPY_PATTERNS) {
    if (pattern.test(skeleton)) {
      warnings.push(`[BPY-SANDBOX] Potential dangerous operation: ${label}`);
    }
  }
  // P2-1: Phase 2 字符串拼接绕过检测（对齐 gdscript-executor 两阶段）。
  // 必须接收原文 code（非 skeleton），与 gdscript 契约 P2-RAW 一致。
  warnings.push(...detectBpyStringConcatBypass(code));
  // NIT-2: Phase 2 % 格式化构造绕过检测（对齐 gdscript-executor C-01-fix:217）。
  // Python 的 "OS%s" % "system" 是等价拼接路径。
  warnings.push(...detectBpyFormatStringBypass(code));
  return warnings;
}
