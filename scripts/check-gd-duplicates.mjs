#!/usr/bin/env node
// scripts/check-gd-duplicates.mjs — GDScript DUPLICATE 副本一致性门禁(2026-10-01 审查 §11)。
//
// 背景:全仓 15 处 `DUPLICATE` 标记的成对函数中,安全敏感函数(_generate_secret/
// _constant_time_compare 等)在 editor 插件副本(addons/godot_mcp_server/websocket_server.gd)
// 与 bridge 运行时副本(src/scripts/mcp_bridge.gd)之间**没有任何机械同步门禁**——
// 对比 TS 侧 .claude/rules ↔ rule-templates.ts 有 check-rules-content-sync STRICT 阻断。
// 漂移后果:_constant_time_compare/_generate_secret 一侧被削弱而无 CI 报警。
//
// 策略:
//  1. EXACT_PAIRS —— 注释承诺"逐行一致/Keep in sync"的函数对:提取函数体做归一化
//     文本对账(去注释/缩进/空行),不一致即 FAIL。
//  2. MARKER_ONLY —— 有意差异的三副本(_coerce_math_value 族,见 godot_operations.gd:87
//     注释"与 editor 源版差异(有意)"):只断言 DUPLICATE 标记在场(标记被删时提醒本脚本
//     与同步义务),不做文本对账。
//
// 归一化仅容忍"排版级"差异(缩进/空行/注释/行尾空白),任何语义改动(哪怕一行)都会被
// 捕获——这正是安全副本想要的灵敏度。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const EDITOR = 'addons/godot_mcp_server/websocket_server.gd';
const BRIDGE = 'src/scripts/mcp_bridge.gd';

/** [函数名, 声明理由]——两副本须归一化后逐字节一致。 */
const EXACT_PAIRS = [
  ['_generate_secret', '密钥生成(熵源决定 token 强度)'],
  ['_constant_time_compare', '恒定时间比较(防时序侧信道)'],
  ['_constant_time_compare_varlen', '变长恒定时间比较'],
  ['_restrict_secret_permissions', 'secret 文件 ACL 收紧(icacls/chmod)'],
];

/** [文件, 函数名]——只查 DUPLICATE 标记在场(有意差异不做文本对账)。 */
const MARKER_ONLY = [
  ['addons/godot_mcp_server/commands/command_helpers.gd', 'coerce_value_for_property'],
  ['src/scripts/godot_operations.gd', '_coerce_math_value'],
  ['src/scripts/mcp_bridge.gd', '_coerce_math_value'],
];

/** 提取 GDScript 函数体(从 `^func NAME(`/`^static func NAME(` 到下一个顶层 func/class 前一行)。 */
function extractFunc(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => new RegExp(`^(static )?func ${name}\\s*\\(`).test(l));
  if (start === -1) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    // 顶层边界:下一处零缩进的 func/static func//class/信号声明
    if (/^(static )?func |^class |^signal |^@onready|^# ={4,}/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** 归一化:去整行注释、去行尾注释(保守:仅当行内无引号时)、去缩进/行尾空白、去空行、
 * 组件日志前缀归一(`[MCP Bridge]`→`[MCP]`——editor 插件与 bridge 运行时按所属组件打
 * 前缀是**有意**的可辨识性设计,非安全语义差异,2026-10-01 首跑实证两副本前缀不同)。
 * 已知理论盲区(终审 NIT-3):GDScript 三引号多行字符串的中间行(行内无引号字符却属
 * 字符串)会被行尾注释剥离误伤——当前 4 对 EXACT 函数均不含多行字符串;新增对时若
 * 函数体含 """ 字符串,须先改用 AST 级对账再纳入 EXACT_PAIRS。 */
function normalize(funcBody) {
  return funcBody
    .split('\n')
    .map(l => {
      const trimmed = l.trim();
      if (trimmed.startsWith('#')) return '';
      if (trimmed.includes('#') && !trimmed.includes('"') && !trimmed.includes("'")) {
        return trimmed.split('#')[0].trim();
      }
      return trimmed;
    })
    .filter(l => l !== '')
    .map(l => l.replaceAll('[MCP Bridge]', '[MCP]'))
    .join('\n');
}

const problems = [];
const checked = [];

for (const [name, why] of EXACT_PAIRS) {
  const editorSrc = readFileSync(join(repoRoot, EDITOR), 'utf8');
  const bridgeSrc = readFileSync(join(repoRoot, BRIDGE), 'utf8');
  const a = extractFunc(editorSrc, name);
  const b = extractFunc(bridgeSrc, name);
  if (a === null || b === null) {
    problems.push(`[gd-duplicates] FAIL 函数提取失败: ${name}(${a === null ? EDITOR : BRIDGE} 缺失)——函数改名/移位须同步本脚本`);
    continue;
  }
  const na = normalize(a);
  const nb = normalize(b);
  checked.push(name);
  if (na !== nb) {
    const la = na.split('\n').length;
    const lb = nb.split('\n').length;
    // 首个差异行定位(归一化后逐行比对)
    let diffHint = '';
    const aa = na.split('\n');
    const bb = nb.split('\n');
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      if (aa[i] !== bb[i]) {
        diffHint = ` 首个差异@归一化行 ${i + 1}: editor="${(aa[i] ?? '<无>').slice(0, 60)}" bridge="${(bb[i] ?? '<无>').slice(0, 60)}"`;
        break;
      }
    }
    problems.push(`[gd-duplicates] FAIL \`${name}\`(${why})两副本归一化后不一致: editor ${la} 行 vs bridge ${lb} 行。${diffHint}。请手工同步两副本(改动任一侧须同步另一侧,DUPLICATE 契约)`);
  }
}

for (const [file, name] of MARKER_ONLY) {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  const hasFunc = extractFunc(src, name) !== null;
  const hasMarker = /DUPLICATE/.test(src);
  checked.push(`${file.split('/').pop()}::${name}(marker-only)`);
  if (!hasFunc) problems.push(`[gd-duplicates] FAIL ${file} 缺函数 ${name}——改名须同步本脚本与另两副本`);
  if (!hasMarker) problems.push(`[gd-duplicates] FAIL ${file} 缺 DUPLICATE 标记——三副本同步义务的提示锚被删,请恢复或同步三副本`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n[gd-duplicates] ✗ ${problems.length} 处不一致(EXACT ${EXACT_PAIRS.length} 对 + MARKER_ONLY ${MARKER_ONLY.length} 项)`);
  process.exit(1);
}
console.log(`[gd-duplicates] ✓ ${checked.length} 项通过(EXACT 对账 ${EXACT_PAIRS.length} 对安全函数归一化一致;MARKER_ONLY ${MARKER_ONLY.length} 项标记在场)`);
