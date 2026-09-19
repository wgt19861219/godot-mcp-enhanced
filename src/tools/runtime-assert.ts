// src/tools/runtime-assert.ts — P0-5 Runtime Assert（first-class 断言工具）
//
// 将断言逻辑从 workflow.dev_loop.acceptance 提取为 agent 可直接调用的 first-class 工具。
// 5 个 action：node_state / scene_structure / screen_text / perf / screenshot_diff
// 全部依赖 game-bridge（运行中的游戏）， readOnly（screenshot_diff/perf 写临时文件）。
//
// 与 workflow.dev_loop 的关系：workflow 保持向后兼容（内部 acceptance 仍工作）；
// runtime_assert 是独立的、可任意时刻调用的验证工具。
// PR-1b 修复：node_state 兼容真 bridge 嵌套 shape（{properties:{...}, node}），修 PR-1a e2e 发现的
// 平铺假设缺陷（原实现下真 bridge 的 actual 恒 undefined，断言恒误判）。

import type { ToolResult, ToolContext } from '../types.js';
import type { Tool } from '@modelcontextprotocol/server';
import { textResult } from '../types.js';
import { sendToBridge } from './game-bridge.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, isAbsolute, dirname, sep, basename } from 'path';
import { PNG } from 'pngjs';
import { classifyError } from '../core/tool-errors.js';
import { getLogger } from '../core/logger.js';
import { diffPngBuffers } from './screenshot-detail.js';
import { isPathInAllowedRoots } from '../core/path-utils.js';
import { resolveGameDataPath } from './game-fs.js';
import { qaReportsDir } from './qa/report.js';

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'runtime_assert',
      description: '运行时断言：在运行中的游戏上验证节点状态/场景结构/屏幕文本/性能/截图对比。agent 可任意时刻调用，不必走 workflow.dev_loop。全部依赖 game-bridge（需先 game_bridge_install + 游戏运行中）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['node_state', 'scene_structure', 'screen_text', 'perf', 'screenshot_diff'],
            description: '断言类型。node_state=节点属性, scene_structure=场景结构, screen_text=屏幕文本存在性, perf=性能基线, screenshot_diff=截图像素对比',
          },
          project_path: { type: 'string', description: '项目路径（screenshot_diff 必填：解析 user:// 截图落盘位置）' },
          // node_state
          path: { type: 'string', description: 'node_state: 节点路径（如 /root/Main/Player）' },
          expect: { type: 'object', description: 'node_state: 期望的属性键值对（如 {"health": 100, "position": {"x": 0}}）' },
          tolerance: { type: 'number', description: 'node_state/perf: 数值容差（默认 0，精确匹配）' },
          // scene_structure
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                type: { type: 'string', description: '期望的节点类型（可选）' },
                absent: { type: 'boolean', description: 'true = 断言节点不存在' },
              },
            },
            description: 'scene_structure: 期望的节点列表',
          },
          // screen_text
          text: { type: 'string', description: 'screen_text: 要查找的文本' },
          present: { type: 'boolean', description: 'screen_text: true=断言文本存在（默认），false=断言不存在' },
          // perf
          baseline: { type: 'object', description: 'perf: 期望的性能基线（如 {"fps": 60}）' },
          // screenshot_diff(B-1:差异容忍语义,禁用"相似度"措辞;引擎=screenshot 工具 action=diff)
          reference: { type: 'string', description: 'screenshot_diff: 参考截图路径（res://、项目相对或绝对路径；须在白名单内）' },
          threshold: { type: 'number', description: 'screenshot_diff: 像素差异容忍阈值（0-1，默认 0.12）。per-pixel 归一化 RGB 距离严格大于此值才计为差异像素；值越小越严格' },
          max_diff_ratio: { type: 'number', description: 'screenshot_diff: 允许的差异像素占比上限（0-1，默认 0.05）。严格像素回归传 0；常规视觉回归建议以同布局好图对校准（本仓实测同布局好图对 ≈0.176，勿低于该量级）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META = {
  'runtime_assert': {
    readonly: true,
    long_running: false,
    actionRisks: {
      node_state: 'read' as const,
      scene_structure: 'read' as const,
      screen_text: 'read' as const,
      perf: 'read' as const,
      screenshot_diff: 'read' as const, // 读参考图 + 截图；diff 染红图落盘已限制在 qa-reports 目录内（I-1 白名单校验），不改场景状态
    },
  },
};

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'runtime_assert') return null;
  const action = args.action as string;

  try {
    switch (action) {
      case 'node_state':
        return await assertNodeState(args);
      case 'scene_structure':
        return await assertSceneStructure(args);
      case 'screen_text':
        return await assertScreenText(args);
      case 'perf':
        return await assertPerf(args);
      case 'screenshot_diff':
        return await assertScreenshotDiff(args);
      default:
        return textResult(JSON.stringify({ success: false, error: `Unknown action: ${action}`, error_code: 'INVALID_PARAMS' }));
    }
  } catch (err) {
    // P2-17(2026-08-21 七维度审核): 顶层兜底此前直拼 err.message(常含绝对路径)进
    // 成功返回的 ToolResult,绕过主 catch 的 G2 PII 护栏——改用 classifyError 的
    // safeMessage(EditorToolExecutor 前科修复同款),完整错误只进 server 日志。
    getLogger().error('runtime_assert', `action=${action} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const { safeMessage } = classifyError(err);
    return textResult(JSON.stringify({ success: false, error: `Assert failed: ${safeMessage}`, error_code: 'ASSERT_ERROR' }));
  }
}

// ─── Assertion implementations ──────────────────────────────────────────────

interface AssertResult {
  success: boolean;
  passed: boolean;
  action: string;
  mismatch?: Record<string, { expected: unknown; actual: unknown }>;
  details?: Record<string, unknown>;
}

function pass(action: string, details?: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify({ success: true, passed: true, action, details } as AssertResult));
}

function fail(action: string, mismatch: Record<string, { expected: unknown; actual: unknown }>, details?: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify({ success: true, passed: false, action, mismatch, details } as AssertResult));
}

/** node_state: 断言节点属性匹配期望值
 * v0.30 起导出：qa 套件的 assert 步骤复用同一实现（防两处逻辑 drift）。返回 JSON 文本
 * {success, passed, action, mismatch?}，调用方 JSON.parse 判定。 */
export async function assertNodeState(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path as string;
  const expect = args.expect as Record<string, unknown>;
  const tolerance = (args.tolerance as number) ?? 0;
  if (!path || !expect) {
    return textResult(JSON.stringify({ success: false, error: 'path and expect are required for node_state', error_code: 'INVALID_PARAMS' }));
  }

  const resp = await sendToBridge('get_node_properties', { path });
  if (resp.error) {
    return textResult(JSON.stringify({ success: false, error: `Bridge error: ${resp.error.message}`, error_code: 'BRIDGE_ERROR' }));
  }

  const raw = (resp.result ?? {}) as Record<string, unknown>;
  // 真 bridge 返回嵌套 {properties:{...}, node}(PR-1a e2e 实测);历史形态平铺。兼容双 shape,嵌套优先。
  const actual = (raw.properties !== undefined && raw.properties !== null && typeof raw.properties === 'object')
    ? raw.properties as Record<string, unknown>
    : raw;
  const mismatch: Record<string, { expected: unknown; actual: unknown }> = {};

  for (const [key, expectedVal] of Object.entries(expect)) {
    const actualVal = actual[key];
    if (typeof expectedVal === 'number' && typeof actualVal === 'number') {
      if (Math.abs(actualVal - expectedVal) > tolerance) {
        mismatch[key] = { expected: expectedVal, actual: actualVal };
      }
    } else if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
      mismatch[key] = { expected: expectedVal, actual: actualVal };
    }
  }

  return Object.keys(mismatch).length === 0
    ? pass('node_state', { path, properties_checked: Object.keys(expect).length })
    : fail('node_state', mismatch, { path });
}

/** scene_structure: 断言节点存在/缺席/类型匹配 */

/**
 * F-3: 递归收集场景树中所有 path 字段到 Set,用于精确匹配(替代原 JSON.stringify 子串匹配)。
 * 兼容平坦 {nodes:[{path}]} 与嵌套 {children:[...]} 两种形态。
 * v0.30 修复(qa e2e 实测暴露):真 bridge 的 get_tree 返回 {scene, tree:[{children:[...]}]},
 * 原实现只递归 children/nodes 键、从不进 tree 键 → 真实环境收集集恒空、一切节点判 absent。
 * 此前单测全部 mock {nodes:[...]} 形态,从未覆盖真实 shape。
 */
function collectPaths(obj: unknown, out: Set<string>): void {
  if (Array.isArray(obj)) {
    for (const item of obj) collectPaths(item, out);
    return;
  }
  if (obj && typeof obj === 'object') {
    const o = obj as { path?: unknown; children?: unknown; nodes?: unknown; tree?: unknown };
    if (typeof o.path === 'string') out.add(o.path);
    if (o.children !== undefined) collectPaths(o.children, out);
    if (o.nodes !== undefined) collectPaths(o.nodes, out);
    if (o.tree !== undefined) collectPaths(o.tree, out);
  }
}

export async function assertSceneStructure(args: Record<string, unknown>): Promise<ToolResult> {
  const nodes = args.nodes as Array<{ path: string; type?: string; absent?: boolean }>;
  if (!nodes || !Array.isArray(nodes)) {
    return textResult(JSON.stringify({ success: false, error: 'nodes array is required for scene_structure', error_code: 'INVALID_PARAMS' }));
  }

  const resp = await sendToBridge('get_tree', {});
  if (resp.error) {
    return textResult(JSON.stringify({ success: false, error: `Bridge error: ${resp.error.message}`, error_code: 'BRIDGE_ERROR' }));
  }

  // F-3: get_tree 返回 {nodes:[{path,...}]} 结构。原用 JSON.stringify 后子串包含匹配,
  // 前缀命名(Player vs PlayerHealth)会假通过/假失败。改为收集所有 path 到 Set 精确匹配。
  const paths = new Set<string>();
  collectPaths(resp.result, paths);

  const mismatch: Record<string, { expected: unknown; actual: unknown }> = {};

  for (const node of nodes) {
    const p = node.path;
    // 同时接受 /root/Main/Player 与 Main/Player 两种写法(去掉 /root/ 前缀)
    const alt = p.replace('/root/', '');
    const exists = paths.has(p) || paths.has(alt) || paths.has('/root/' + alt);
    if (node.absent) {
      if (exists) mismatch[node.path] = { expected: 'absent', actual: 'present' };
    } else {
      if (!exists) mismatch[node.path] = { expected: 'present', actual: 'absent' };
    }
  }

  return Object.keys(mismatch).length === 0
    ? pass('scene_structure', { nodes_checked: nodes.length })
    : fail('scene_structure', mismatch);
}

/** screen_text: 断言屏幕文本存在/缺席（基于 find_ui_elements 节点匹配，非 OCR）。v0.30 起导出供 qa 复用 */
export async function assertScreenText(args: Record<string, unknown>): Promise<ToolResult> {
  const text = args.text as string;
  const present = (args.present as boolean) ?? true;
  if (!text) {
    return textResult(JSON.stringify({ success: false, error: 'text is required for screen_text', error_code: 'INVALID_PARAMS' }));
  }

  const resp = await sendToBridge('find_ui_elements', { pattern: '*', visible_only: true, limit: 500 });
  if (resp.error) {
    return textResult(JSON.stringify({ success: false, error: `Bridge error: ${resp.error.message}`, error_code: 'BRIDGE_ERROR' }));
  }

  // find_ui_elements 返回 UI 元素列表，检查 text 是否出现在任何元素的 name/text 中
  const elementsJson = JSON.stringify(resp.result ?? {});
  const found = elementsJson.includes(text);

  if (present && found) {
    return pass('screen_text', { text, found: true });
  } else if (!present && !found) {
    return pass('screen_text', { text, found: false });
  } else {
    return fail('screen_text', { text: { expected: present ? 'present' : 'absent', actual: found ? 'present' : 'absent' } });
  }
}

/** perf: 断言性能基线（FPS/内存等）。v0.30 起导出供 qa 复用 */
export async function assertPerf(args: Record<string, unknown>): Promise<ToolResult> {
  const baseline = args.baseline as Record<string, number>;
  const tolerance = (args.tolerance as number) ?? 0.1; // 10% 默认容差
  if (!baseline) {
    return textResult(JSON.stringify({ success: false, error: 'baseline is required for perf', error_code: 'INVALID_PARAMS' }));
  }

  const resp = await sendToBridge('get_performance', {});
  if (resp.error) {
    return textResult(JSON.stringify({ success: false, error: `Bridge error: ${resp.error.message}`, error_code: 'BRIDGE_ERROR' }));
  }

  const actual = (resp.result as Record<string, number>) ?? {};
  const mismatch: Record<string, { expected: unknown; actual: unknown }> = {};

  for (const [key, expectedVal] of Object.entries(baseline)) {
    const actualVal = actual[key];
    if (typeof actualVal === 'number') {
      const ratio = Math.abs(actualVal - expectedVal) / Math.max(Math.abs(expectedVal), 1);
      if (ratio > tolerance) {
        mismatch[key] = { expected: expectedVal, actual: actualVal };
      }
    } else {
      mismatch[key] = { expected: expectedVal, actual: 'missing' };
    }
  }

  return Object.keys(mismatch).length === 0
    ? pass('perf', { metrics_checked: Object.keys(baseline).length, actual })
    : fail('perf', mismatch, { actual });
}

/** screenshot_diff: 截图与参考图像素级对比(差异容忍语义)。PR-1a 真实现,导出供 qa 复用。
 * 真契约(v0.30 e2e 实测):take_screenshot 把 PNG 存游戏侧 user:// 并返回 {success, path, size}——无 base64。
 * 内部参数(schema 不暴露):evidence_path 落 diff 染红图(qa 传报告目录;工具级不传则只回数值)。 */
export async function assertScreenshotDiff(args: Record<string, unknown>): Promise<ToolResult> {
  const reference = args.reference as string | undefined;
  const threshold = (args.threshold as number | undefined) ?? 0.12;
  const maxDiffRatio = (args.max_diff_ratio as number | undefined) ?? 0.05;
  const projectPathRaw = args.project_path as string | undefined;
  if (!reference) {
    return textResult(JSON.stringify({ success: false, error: 'reference is required for screenshot_diff', error_code: 'INVALID_PARAMS' }));
  }
  if (!projectPathRaw) {
    return textResult(JSON.stringify({ success: false, error: 'project_path is required for screenshot_diff (解析 user:// 截图路径)', error_code: 'INVALID_PARAMS' }));
  }
  const projAbs = resolve(projectPathRaw);
  if (!isPathInAllowedRoots(projAbs)) {
    // P2-17: 不回显 resolve 后的绝对路径(PII 护栏立场与 dispatcher 一致)
    return textResult(JSON.stringify({ success: false, error: 'project_path 不在 ALLOWED_PROJECT_PATHS 白名单内(检查环境变量或配置的项目根)', error_code: 'INVALID_PATH' }));
  }
  // reference 解析:res:// → 项目内;相对 → 项目内;绝对直用;统一过白名单
  let refAbs: string;
  if (reference.startsWith('res://')) refAbs = resolve(projAbs, reference.slice('res://'.length));
  else if (isAbsolute(reference)) refAbs = resolve(reference);
  else refAbs = resolve(projAbs, reference);
  if (!isPathInAllowedRoots(refAbs)) {
    // P2-17: 不回显 resolve 后的绝对路径(PII 护栏立场与 dispatcher 一致)
    return textResult(JSON.stringify({ success: false, error: `reference 不在 ALLOWED_PROJECT_PATHS 白名单内: ${basename(refAbs)}`, error_code: 'INVALID_PATH' }));
  }

  const resp = await sendToBridge('take_screenshot', {});
  if (resp.error) {
    return textResult(JSON.stringify({ success: false, error: `Bridge error: ${resp.error.message}`, error_code: 'BRIDGE_ERROR' }));
  }
  const shot = (resp.result ?? {}) as { success?: boolean; path?: string; size?: { x: number; y: number } };
  if (shot.success !== true || typeof shot.path !== 'string') {
    return textResult(JSON.stringify({ success: false, error: `take_screenshot 未成功: ${JSON.stringify(resp.result).slice(0, 200)}`, error_code: 'BRIDGE_ERROR' }));
  }
  const localShot = resolveGameDataPath(projAbs, shot.path);
  if (!localShot) {
    return textResult(JSON.stringify({ success: false, error: `user:// 截图无法解析到本机路径: ${shot.path}(user:// 布局异常或文件不存在)`, error_code: 'ASSERT_ERROR' }));
  }

  let refBuf: Buffer;
  let actualBuf: Buffer;
  try {
    refBuf = readFileSync(refAbs);
    actualBuf = readFileSync(localShot);
  } catch {
    // P2-17: ENOENT 的 err.message 含完整绝对路径——回显文件名即可定位,不泄路径
    return textResult(JSON.stringify({ success: false, error: `读图失败(文件缺失或不可读): 参考图 ${basename(refAbs)} / 截图 ${basename(localShot)}`, error_code: 'ASSERT_ERROR' }));
  }

  let diff;
  try {
    diff = diffPngBuffers(refBuf, actualBuf, threshold);
  } catch (e) {
    const diffErr = (e as Error).message;
    // 尺寸不一致:FAILED(带双方尺寸),不是基础设施错误
    if (diffErr.includes('dimensions mismatch')) {
      return fail('screenshot_diff', { dimensions: { expected: '参考图与截图同尺寸', actual: diffErr } }, { reference: refAbs });
    }
    // 其余解码失败(非 PNG/损坏图):基础设施错误 ASSERT_ERROR——不再误报"尺寸不一致"误导排错(审查 Minor⑤)
    return textResult(JSON.stringify({ success: false, error: `读图/解码失败: ${diffErr}`, error_code: 'ASSERT_ERROR' }));
  }

  // 可选证据落盘(失败不改变判定)
  const evidencePath = args.evidence_path as string | undefined;
  if (evidencePath) {
    // 审查 I-1(schema 不暴露 ≠ 安全边界:args-validator 未知字段允许,handleTool 原样透传,
    // evidence_path 可从外部 MCP args 注入任意路径写文件)。写面前校验:resolve 后必须位于
    // qaReportsDir() 内(前缀比较与 qa/report.ts readReport 同款;qa runner 内部拼的路径
    // 天然满足)。不可用 isPathInAllowedRoots——qa-reports 在 ~/.godot-mcp 下不在项目白名单。
    const evAbs = resolve(evidencePath);
    const reportsDir = qaReportsDir();
    if (!(evAbs === reportsDir || evAbs.startsWith(reportsDir + sep))) {
      return textResult(JSON.stringify({ success: false, error: `evidence_path 必须位于 qa-reports 目录内: ${reportsDir}(拒绝任意路径写入): ${evAbs}`, error_code: 'INVALID_PATH' }));
    }
    try {
      mkdirSync(dirname(evAbs), { recursive: true });
      const outPng = new PNG({ width: diff.width, height: diff.height });
      outPng.data = diff.diffImageData;
      writeFileSync(evAbs, PNG.sync.write(outPng));
    } catch { /* 证据 best-effort */ }
  }

  if (diff.diffRatio <= maxDiffRatio) {
    return pass('screenshot_diff', { diff_ratio: diff.diffRatio, diff_pixels: diff.diffPixels, threshold, max_diff_ratio: maxDiffRatio, evidence_path: evidencePath, size: shot.size });
  }
  return fail('screenshot_diff', {
    diff_ratio: { expected: `≤ ${maxDiffRatio}`, actual: diff.diffRatio },
    diff_pixels: { expected: `≤ ${Math.round(maxDiffRatio * diff.width * diff.height)}`, actual: diff.diffPixels },
  }, { bbox: diff.bbox, size: shot.size, evidence_path: evidencePath });
}
