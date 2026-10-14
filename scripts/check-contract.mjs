#!/usr/bin/env node
// scripts/check-contract.mjs
// P1-6 跨工具契约一致性门禁（参考 breakpoint contract_check）。
//
// 从 docs/capability-matrix.json（build-matrix 产出的 committed 快照,单一真相源）
// 提取数据,交叉校验每工具的契约完整性。对齐 check-tool-count.mjs 风格:
// readFileSync 读工作区、导出纯函数供单测、[contract] 日志前缀、退出码 0=合规/1=违规。
//
// 用法：node scripts/check-contract.mjs
// 退出码：0=全部合规,1=检测到 error 级违规
//
// 增量设计:CHECKS 是数组,新增校验项只需加一条 {id, desc, severity, check}。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 校验项定义。
 * @typedef {'error'|'warn'} Severity
 * @typedef {{
 *   id: string,           // 校验项 ID（C1-C6...）
 *   desc: string,         // 人类可读描述
 *   severity: Severity,   // error=exit 1 / warn=仅提示
 *   check: (tool: object) => (string|null)  // 返回违规消息(null=通过)
 * }} Check
 */

/**
 * 从 capability-matrix.json 读取真相源。
 * @param {string} root 项目根
 * @returns {{tools: object[]}} */
export function readMatrix(root) {
  const matrixPath = join(root, 'docs', 'capability-matrix.json');
  if (!existsSync(matrixPath)) {
    throw new Error(`[contract] 真相源缺失：${matrixPath}（先跑 npm run build-matrix）`);
  }
  return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

/**
 * P1-6 首版 6 项核心校验。每项 check(tool) 返回违规消息(null=通过)。
 * @type {Check[]} */
export const CHECKS = [
  {
    id: 'C1',
    desc: '每工具必有 annotations 三 hint(readOnlyHint/destructiveHint/idempotentHint,均 boolean)',
    severity: 'error',
    check: (t) => {
      const a = t.annotations;
      if (!a) return `缺 annotations 字段`;
      if (typeof a.readOnlyHint !== 'boolean') return `annotations.readOnlyHint 非 boolean: ${typeof a.readOnlyHint}`;
      if (typeof a.destructiveHint !== 'boolean') return `annotations.destructiveHint 非 boolean: ${typeof a.destructiveHint}`;
      if (typeof a.idempotentHint !== 'boolean') return `annotations.idempotentHint 非 boolean: ${typeof a.idempotentHint}`;
      return null;
    },
  },
  {
    id: 'C2',
    desc: 'danger-api 组工具:若含 destructive action 则必 guarded(danger-api 是组级风险面,非每工具必 guarded)',
    severity: 'error',
    check: (t) => {
      // securityLevel=danger-api 是组级标注(组内任一源文件命中 DANGER_PATTERNS),
      // 不要求组内每工具都 guarded。但若工具自身含 destructive action(riskDistribution.destructive>0),
      // 则必须 guarded(destructive 操作需用户确认)。
      if (t.securityLevel === 'danger-api' && t.riskDistribution?.destructive > 0 && !t.guarded) {
        return `securityLevel=danger-api + 含 destructive action 但 guarded=false（destructive 工具必须 guarded）`;
      }
      return null;
    },
  },
  {
    id: 'C3',
    desc: 'securityLevel 与 guarded 不矛盾(guarded=true 的工具 securityLevel 不应 safe)',
    severity: 'warn',
    check: (t) => {
      // guarded=true 意味着工具需用户确认,securityLevel=safe 表示无危险 API。
      // 两者矛盾:安全工具不应需确认。但 safe+guarded 在过渡期可能出现(手动标 guarded),用 warn 不 error。
      if (t.securityLevel === 'safe' && t.guarded) {
        return `securityLevel=safe 但 guarded=true（安全工具不应需确认,可能过度保护）`;
      }
      return null;
    },
  },
  {
    id: 'C4',
    desc: 'offlineCapable 与 needsGodot 互斥(offlineCapable=true 则 needsGodot=false)',
    severity: 'error',
    check: (t) => {
      if (t.offlineCapable && t.needsGodot) {
        return `offlineCapable=true 但 needsGodot=true（离线工具不需 Godot,矛盾）`;
      }
      return null;
    },
  },
  {
    id: 'C5',
    desc: '每工具有非空 description + inputSchema(含 properties 字段,允许空对象=无参工具)',
    severity: 'error',
    check: (t) => {
      if (!t.description || t.description.trim() === '') return `description 为空`;
      if (!t.inputSchema || typeof t.inputSchema !== 'object') return `inputSchema 缺失或非对象`;
      const props = t.inputSchema.properties;
      if (props === undefined) return `inputSchema.properties 字段缺失`;
      if (typeof props !== 'object') return `inputSchema.properties 非对象: ${typeof props}`;
      // properties: {} 合法(无参工具,如 godot_list_instances)
      return null;
    },
  },
  {
    id: 'C6',
    desc: 'riskDistribution 计数和 > 0(有 action 风险标注)',
    severity: 'warn',  // warn 不阻断:inline tool(manage_tools/confirm_and_execute)确实无 actionRisks
    check: (t) => {
      const r = t.riskDistribution;
      if (!r) return `riskDistribution undefined(可能 inline tool,非阻断)`;
      const sum = (r.read || 0) + (r.write || 0) + (r.destructive || 0) + (r.process || 0);
      if (sum === 0) return `riskDistribution 四级计数全 0(无 action 风险标注)`;
      return null;
    },
  },
];

/**
 * 纯函数:跑全部校验项,返回违规清单。
 * @param {{tools: object[]}} matrix
 * @returns {{errors: Array<{tool:string, id:string, msg:string}>, warnings: Array<{tool:string, id:string, msg:string}>, totalChecks: number}}
 */
export function runChecks(matrix) {
  const errors = [];
  const warnings = [];
  const tools = matrix.tools || [];

  for (const tool of tools) {
    for (const check of CHECKS) {
      const msg = check.check(tool);
      if (msg) {
        const entry = { tool: tool.name || '(unknown)', id: check.id, msg };
        if (check.severity === 'error') {
          errors.push(entry);
        } else {
          warnings.push(entry);
        }
      }
    }
  }

  return { errors, warnings, totalChecks: tools.length * CHECKS.length };
}

/**
 * 2026-08-06 审查 P2 新增 C7：action-gate key × tool_registry 一致性校验。
 *
 * 背景：action-gate.ts 的 GATED_ACTIONS key 格式 `<工具名>.<action>`，工具名必须与
 * tool-registry 实际承载该 action 的工具名一致，否则 isActionGated 永不命中（gate 形同虚设）。
 * 此前 'runtime.execute_gdscript' 漏配致 execute_gdscript RCE 面无 gate 防护（批 1 P0 修复）。
 *
 * 2026-08-06 审查 I-1 修复：原 C7 只校验工具名（group），不校验 action 名。
 * 原始 P0 bug 是 'runtime.execute_gdscript'，runtime 是真实工具但 execute_gdscript 不在其
 * ACTIONS 数组——原 C7 会放过这种「错位 action」回归。现读工具源文件的 const ACTIONS 数组
 * 校验 action 部分实际属于该工具。
 *
 * 此校验在 runChecks 外做（matrix-level 而非 per-tool），因 action-gate key 是全局集合。
 */
function checkActionGateKeys(matrix, projectRoot) {
  const errors = [];
  const actionGatePath = join(projectRoot, 'src', 'core', 'action-gate.ts');
  if (!existsSync(actionGatePath)) return errors;  // 版本无 action-gate 则跳过
  const src = readFileSync(actionGatePath, 'utf8');
  // 只扫 GATED_ACTIONS 对象字面量内部（避注释里的旧字符串干扰，如 'runtime.execute_gdscript' 注释）
  const blockMatch = src.match(/const\s+GATED_ACTIONS[^{]*\{([\s\S]*?)\};/);
  if (!blockMatch) {
    errors.push({ tool: 'action-gate', id: 'C7', msg: 'GATED_ACTIONS 块未找到（结构被破坏）' });
    return errors;
  }
  // 提取所有形如 'xxx.yyy' 的单引号 key（仅数组内非注释行）
  const block = blockMatch[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const keyMatches = block.match(/'([a-z_]+\.[a-z_]+)'/g) ?? [];
  const keys = keyMatches.map(k => k.replace(/'/g, ''));
  if (keys.length === 0) {
    errors.push({ tool: 'action-gate', id: 'C7', msg: 'GATED_ACTIONS 无 <group>.<action> key（结构被破坏或未登记）' });
    return errors;
  }
  // 从 matrix 取所有工具名集合
  const toolNames = new Set((matrix.tools ?? []).map(t => t.name));
  for (const key of keys) {
    const [group, action] = key.split('.');
    // 维度 1：工具名必须是真实工具
    if (!toolNames.has(group)) {
      errors.push({
        tool: 'action-gate',
        id: 'C7',
        msg: `GATED_ACTIONS key '${key}' 的工具名 '${group}' 不在 tool-registry（isActionGated 永不命中，gate 形同虚设）`,
      });
      continue;
    }
      // 维度 2（I-1 修复）：action 必须在该工具源文件的 const ACTIONS 数组里
      // 2026-08-07 审查 P2 修复：原硬编码 src/tools/${group}.ts（单文件），目录式工具
      // （scene/animation/ui 等）existsSync 返 false 静默跳过 → 未来目录式工具加 GATED_ACTIONS
      // key 时 C7 无法发现 action 漂移。改为：单文件不存在时 fallback 扫 src/tools/${group}/ 下所有 .ts。
      const toolSrcPath = join(projectRoot, 'src', 'tools', `${group}.ts`);
      const toolSrcDir = join(projectRoot, 'src', 'tools', group);
      const candidateSrcs = [];  // [{label, content}]
      if (existsSync(toolSrcPath)) {
        candidateSrcs.push({ label: `${group}.ts`, content: readFileSync(toolSrcPath, 'utf8') });
      } else if (existsSync(toolSrcDir)) {
        for (const f of readdirSync(toolSrcDir).filter(f => f.endsWith('.ts'))) {
          candidateSrcs.push({ label: `${group}/${f}`, content: readFileSync(join(toolSrcDir, f), 'utf8') });
        }
      }
      if (candidateSrcs.length > 0) {
        // 检查 action 是否在任一候选文件的 ACTIONS 数组里
        const hasActionsArray = candidateSrcs.some(s => /const\s+ACTIONS\s*=/.test(s.content));
        const actionInAny = candidateSrcs.some(s => {
          const m = s.content.match(/const\s+ACTIONS\s*=\s*\[([\s\S]*?)\]/);
          if (!m) return false;
          const actionNames = new Set((m[1].match(/'([a-z_]+)'/g) ?? []).map(x => x.replace(/'/g, '')));
          return actionNames.has(action);
        });
        // 仅当工具确有 ACTIONS 数组但 action 不在其中时报错（无 ACTIONS 常量的工具跳过）
        if (hasActionsArray && !actionInAny) {
          errors.push({
            tool: 'action-gate',
            id: 'C7',
            msg: `GATED_ACTIONS key '${key}' 的 action '${action}' 不在 ${candidateSrcs.map(s => s.label).join(' 或 ')} 的 ACTIONS 数组（isActionGated 永不命中 — 正是 2026-08-06 P0 'runtime.execute_gdscript' 漏配的根因模式）`,
          });
        }
      }
  }
  return errors;
}

function main() {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const matrix = readMatrix(projectRoot);
  const { errors, warnings, totalChecks } = runChecks(matrix);

  // C7: action-gate key × tool_registry 一致性（matrix-level，非 per-tool）
  const gateErrors = checkActionGateKeys(matrix, projectRoot);
  errors.push(...gateErrors);

  console.log('[contract] 校验 %d 项 × %d 工具 = %d 检查点（真相源: docs/capability-matrix.json）',
    CHECKS.length, matrix.tools?.length || 0, totalChecks);
  if (gateErrors.length > 0) {
    console.log('[contract] + C7 action-gate key 一致性: %d 条额外检查', gateErrors.length);
  }

  if (warnings.length > 0) {
    console.warn('[contract] ⚠ %d 条 warning（非阻断）:', warnings.length);
    for (const w of warnings) {
      console.warn('  %s [%s] %s', w.tool, w.id, w.msg);
    }
  }

  if (errors.length > 0) {
    console.error('[contract] ✗ 检测到 %d 条 error 级违规:', errors.length);
    for (const e of errors) {
      console.error('  %s [%s] %s', e.tool, e.id, e.msg);
    }
    console.error('[contract] 修复：改工具契约后跑 `npm run build-matrix` 重建 matrix,再排查违规');
    process.exit(1);
  }

  console.log('[contract] ✓ 全部合规（%d error, %d warning）', errors.length, warnings.length);
}

main();
