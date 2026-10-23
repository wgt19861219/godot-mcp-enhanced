// src/capability/diff-matrix.ts
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../module-loader.js';
import { extractCapabilities } from './extract.js';
import type { SecurityLevel, ToolCapability } from './schema.js';

/** 漂移报告：对比基线与当前矩阵的差异。
 *  L-28(2026-10-22 审查第二轮):原五维不查描述/可选参数/size——description 措辞
 *  随 npm 分发(docs/tools),optionalParams 与 requiredParams 同为契约面,inputSchema
 *  内部变化(enum/default 等,params 集合不变时)唯一可观测信号是 size。扩三维补齐。 */
export interface DriftReport {
  added: string[];
  removed: string[];
  contractChanges: string[]; // requiredParams 增减
  securityLevelDowngrades: { name: string; from: SecurityLevel; to: SecurityLevel }[];
  annotationChanges: { name: string; field: 'readOnlyHint' | 'destructiveHint' | 'idempotentHint'; from: boolean; to: boolean }[];
  /** L-28: description 文本变化(随 npm 分发,措辞漂移即发布物漂移) */
  descriptionChanges: string[];
  /** L-28: optionalParams 集合变化(与 requiredParams 同为契约面) */
  optionalParamChanges: string[];
  /** L-28: totalBytes 变化——兜住 inputSchema 内部变化(enum/default/嵌套 description,
 *   params 集合不变时其余维度不可见,唯一信号是 size) */
  sizeChanges: { name: string; from: number; to: number }[];
  hasDrift: boolean;
}

/** 安全等级危险度排名：值越大越危险。降级 = rank 升高。 */
const LEVEL_RANK: Record<SecurityLevel, number> = {
  safe: 0,
  guarded: 1,
  'danger-api': 2,
};

/**
 * 纯函数：对比两份能力矩阵，产出漂移报告。
 * 查 5 维：added / removed / contractChanges / securityLevelDowngrades / annotationChanges。
 * 不查 gdScriptImpl（editor 实现路径属元数据，非契约字段，不参与 drift）。
 */
export function diffMatrices(prev: ToolCapability[], curr: ToolCapability[]): DriftReport {
  const prevMap = new Map(prev.map((c) => [c.name, c]));
  const currMap = new Map(curr.map((c) => [c.name, c]));

  const added = [...currMap.keys()].filter((n) => !prevMap.has(n)).sort();
  const removed = [...prevMap.keys()].filter((n) => !currMap.has(n)).sort();

  const contractChanges: string[] = [];
  const securityLevelDowngrades: { name: string; from: SecurityLevel; to: SecurityLevel }[] = [];
  const annotationChanges: DriftReport['annotationChanges'] = [];
  const descriptionChanges: string[] = [];
  const optionalParamChanges: string[] = [];
  const sizeChanges: DriftReport['sizeChanges'] = [];

  const HINT_FIELDS = ['readOnlyHint', 'destructiveHint', 'idempotentHint'] as const;

  for (const [name, c] of currMap) {
    const p = prevMap.get(name);
    if (!p) continue;
    // 契约变更：requiredParams 集合不同（排序后字符串比较）
    const pReq = [...p.requiredParams].sort().join(',');
    const cReq = [...c.requiredParams].sort().join(',');
    if (pReq !== cReq) contractChanges.push(name);
    // L-28: optionalParams 集合同款比对;description 逐字比对;
    // size.totalBytes 比对(兜 inputSchema 内部变化,params 集合不可见时)
    const pOpt = [...p.optionalParams].sort().join(',');
    const cOpt = [...c.optionalParams].sort().join(',');
    if (pOpt !== cOpt) optionalParamChanges.push(name);
    if (p.description !== c.description) descriptionChanges.push(name);
    if (p.size.totalBytes !== c.size.totalBytes) {
      sizeChanges.push({ name, from: p.size.totalBytes, to: c.size.totalBytes });
    }
    // 安全降级：危险度排名升高
    if (LEVEL_RANK[c.securityLevel] > LEVEL_RANK[p.securityLevel]) {
      securityLevelDowngrades.push({ name, from: p.securityLevel, to: c.securityLevel });
    }
    // annotations hint 变更：任一 hint 布尔值翻转（undefined 视为 false）
    for (const field of HINT_FIELDS) {
      const pv = p.annotations?.[field] ?? false;
      const cv = c.annotations?.[field] ?? false;
      if (pv !== cv) {
        annotationChanges.push({ name, field, from: pv, to: cv });
      }
    }
  }

  const hasDrift =
    added.length + removed.length + contractChanges.length + securityLevelDowngrades.length
    + annotationChanges.length + descriptionChanges.length + optionalParamChanges.length + sizeChanges.length > 0;

  return { added, removed, contractChanges, securityLevelDowngrades, annotationChanges, descriptionChanges, optionalParamChanges, sizeChanges, hasDrift };
}

/** 从 git HEAD 读取已提交的基线矩阵；无基线（首次/未提交）返回 null，不阻断。 */
function readBaseline(projectRoot: string): ToolCapability[] | null {
  try {
    const json = execSync('git show HEAD:docs/capability-matrix.json', {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(json) as { tools?: ToolCapability[] };
    return parsed.tools ?? null;
  } catch {
    return null;
  }
}

/** 入口：对比 HEAD 基线与实时提取的矩阵，漂移时 exit(1)（CI 门）。 */
function main(): void {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const baseline = readBaseline(projectRoot);
  if (!baseline) {
    console.log('[diff-matrix] no committed baseline, skip');
    return;
  }
  registerAllModules();
  const curr = extractCapabilities(projectRoot);
  const report = diffMatrices(baseline, curr);
  console.log(JSON.stringify(report, null, 2));
  if (report.hasDrift) {
    console.error(
      '[diff-matrix] DRIFT DETECTED — run `npm run build-matrix` and commit to update baseline',
    );
    process.exit(1);
  }
  console.log('[diff-matrix] no drift');
}

// 仅当直接执行（非 import）时跑 main。
// Windows 下 import.meta.url 是 file:///D:/.../diff-matrix.js（正斜杠+三斜杠），
// process.argv[1] 是 D:\...\diff-matrix.js（反斜杠），字符串不相等。
// 用 fileURLToPath 把两侧都转 native path 再比较。
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
