// src/tools/analysis/layout-compare.ts — 布局树读数容差比对（布局审计能力 B）
//
// 参考实现：TMXYH5 tools/visual_gate.py cmd_tree()（三期 152+ 例视觉巡检实战验证，
// 坐标级数值审计零假阳性）。ref/cand 两份树读数 JSON 比对，不依赖游戏运行：
//   - 平铺格式 {名: [x, y, w, h]}（bridge dump_layout_tree / _probe.gd 导出）
//   - 包装格式 {"controls": {...}, "_anchored": [名...]}（设计稿提取：锚点布局项
//     诚实标 null 而非瞎算——锚点/动态布局项静态不可换算，不过滤会产几百条假 DIFF）
// 防假阳性语义（与参考实现逐项一致，无开关）：
//   - 锚点项（_anchored 标注）与任一侧 x/y 为 null 的项：跳过并计数
//   - 恰好等于 tol 不判 DRIFT（严格大于才判）
// rebase：cand 侧以指定控件 origin 为原点相对化（global → 皮肤根相对，跨源比对必需）。

import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { textResult } from '../../types.js';
import { opsErrorResult } from '../shared.js';
import { isPathInAllowedRoots, describeAllowedRoots } from '../../core/path-utils.js';

type Rect = Array<number | null>;

interface LoadedTree {
  controls: Record<string, Rect>;
  anchored: Set<string>;
}

/** 载入树读数 JSON：兼容平铺与包装两种格式 */
function loadTree(path: string, label: string): LoadedTree | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return { error: `无法读取 ${label} 文件 ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${label} 不是合法 JSON（${path}）: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${label} 必须是 JSON 对象（平铺 {名:[x,y,w,h]} 或包装 {"controls":{...}}），收到: ${Array.isArray(parsed) ? 'array' : typeof parsed}` };
  }
  const obj = parsed as Record<string, unknown>;
  const source = (obj.controls !== undefined && typeof obj.controls === 'object' && obj.controls !== null && !Array.isArray(obj.controls))
    ? obj.controls as Record<string, unknown>
    : obj;
  const controls: Record<string, Rect> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name === '_anchored' || name === '_skin') continue; // 包装格式的元数据键
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
      return { error: `${label} 控件 "${name}" 的值必须是 [x, y, w, h] 数组（2-4 元素，null 表示未知/锚点项）` };
    }
    const rect: Rect = value.map(v => (v === null ? null : (typeof v === 'number' && Number.isFinite(v) ? v : NaN)));
    if (rect.some(v => typeof v === 'number' && Number.isNaN(v))) {
      return { error: `${label} 控件 "${name}" 含非数值坐标（允许 number 或 null）` };
    }
    controls[name] = rect;
  }
  const anchored = Array.isArray(obj._anchored)
    ? new Set(obj._anchored.filter((s): s is string => typeof s === 'string'))
    : new Set<string>();
  return { controls, anchored };
}

/** 解析 ref/cand 路径：绝对或相对 cwd；须在项目路径白名单内（只读护城河一致性） */
function resolveListedPath(input: unknown, label: string): string | { error: string } {
  if (typeof input !== 'string' || !input.trim()) {
    return { error: `${label} 参数必填（树读数 JSON 文件路径）` };
  }
  const abs = isAbsolute(input) ? input : resolve(input);
  if (!isPathInAllowedRoots(abs)) {
    return { error: `${label} 路径不在允许的项目白名单内（${abs}）。允许的根: ${describeAllowedRoots()}。跨源比对的设计稿导出可将其目录加入 ALLOWED_PROJECT_PATHS。` };
  }
  return abs;
}

export function layoutCompare(args: Record<string, unknown>): ReturnType<typeof textResult> {
  const refRes = resolveListedPath(args.ref_path, 'ref_path');
  if (typeof refRes === 'object') return opsErrorResult('INVALID_PARAMS', refRes.error);
  const candRes = resolveListedPath(args.cand_path, 'cand_path');
  if (typeof candRes === 'object') return opsErrorResult('INVALID_PARAMS', candRes.error);

  const tol = typeof args.tol === 'number' && Number.isFinite(args.tol) && args.tol >= 0
    ? args.tol
    : 2.0;
  const rebase = typeof args.rebase === 'string' && args.rebase ? args.rebase : '';

  const refLoaded = loadTree(refRes, 'ref');
  if ('error' in refLoaded) return opsErrorResult('INVALID_PARAMS', refLoaded.error);
  const candLoaded = loadTree(candRes, 'cand');
  if ('error' in candLoaded) return opsErrorResult('INVALID_PARAMS', candLoaded.error);

  const ref = refLoaded.controls;
  const cand = candLoaded.controls;

  // rebase：cand 侧以指定控件 origin 为原点相对化（x/y 平移，w/h 不变）
  if (rebase) {
    const o = cand[rebase];
    if (!o || o[0] === null || o[1] === null) {
      return opsErrorResult('INVALID_PARAMS', `rebase 锚控件 ${rebase} 不在 cand 树或坐标为 null`);
    }
    const ox = o[0] as number;
    const oy = o[1] as number;
    const rebased: Record<string, Rect> = {};
    for (const [k, v] of Object.entries(cand)) {
      rebased[k] = v[0] === null || v[1] === null ? v : [v[0]! - ox, v[1]! - oy, ...v.slice(2)];
    }
    Object.assign(cand, rebased);
  }

  const skip = new Set([...refLoaded.anchored, ...candLoaded.anchored]);
  let skipCount = 0;
  let comparedCount = 0;
  const lines: string[] = [];
  let hasDiff = false;

  for (const name of new Set([...Object.keys(ref), ...Object.keys(cand)])) {
    if (!(name in cand)) {
      const r = ref[name]!;
      lines.push(`MISSING cand 缺控件 ${name}（ref x=${r[0]} y=${r[1]}）`);
      hasDiff = true;
      continue;
    }
    if (!(name in ref)) {
      lines.push(`EXTRA   cand 多控件 ${name}`);
      hasDiff = true;
      continue;
    }
    const rv = ref[name]!;
    const cv = cand[name]!;
    // 锚点/动态布局项（任一侧标注或 x/y 坐标 null）诚实跳过，不产假 DIFF
    if (skip.has(name) || rv[0] === null || rv[1] === null || cv[0] === null || cv[1] === null) {
      skipCount++;
      continue;
    }
    comparedCount++;
    const drifts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = rv[i];
      const c = cv[i];
      if (typeof r === 'number' && typeof c === 'number' && Math.abs(r - c) > tol) {
        drifts.push(`${['x', 'y', 'w', 'h'][i]} ${r}→${c}`);
      }
    }
    if (drifts.length > 0) {
      lines.push(`DRIFT   ${name}：${drifts.join('; ')}（容差 ${tol}px）`);
      hasDiff = true;
    }
  }

  lines.sort((a, b) => a.slice(0, 7).localeCompare(b.slice(0, 7)) || a.localeCompare(b));
  const summary = `TREE ${hasDiff ? 'FAIL' : 'PASS'}（比对 ${comparedCount} 项 / 跳过 ${skipCount} 锚点·null 项`
    + (rebase ? ` / rebase=${rebase}` : '')
    + `；${hasDiff ? '差异项即数值证据，直接修，无需判图' : '全控件坐标在容差内'}）`;

  const refUnusedAnchored = [...refLoaded.anchored].filter(n => !(n in ref)).length;
  const header = `布局树比对  ref=${refRes}\n          cand=${candRes}\n`;
  const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
  const tailNote = refUnusedAnchored > 0
    ? `\n注：ref _anchored 标注了 ${refUnusedAnchored} 个不在 controls 中的名字（已忽略）` : '';

  return textResult(header + body + summary + tailNote);
}
