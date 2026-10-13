/**
 * Tool module auto-registration — C-ARCH-01
 *
 * Centralizes all tool module imports and registration in one place.
 * GodotServer.ts only needs to call registerAllModules().
 *
 * 2026-08-21 架构审查 D-2:从 src/core/ 移到 src/ 根——本文件是应用层组合根(44 个
 * tools import,2026-10-01 B-3 校正;计数以 `npm run check:modules-sync` 为准),放 core/ 使
 * 「core 不依赖 tools」声明名不副实;移出后 eslint 分层门禁
 * (core→tools 禁止)不再需要豁免条目。
 *
 * CMP-13 (2026-08-09): ALL_MODULES 数组由 scripts/generate-all-modules.mjs
 * 自动生成(从下方 import 块提取别名)。新增工具:① 加 import 行 ② 跑
 * `npm run generate:modules` 重生成数组。勿手动编辑 ALL_MODULES 数组。
 */

import { registerModule, TOOL_GROUPS, getToolMeta, type RiskLevel, type ToolModule } from './core/tool-registry.js';
import type { Tool } from "@modelcontextprotocol/server";

// ─── Tool module imports ─────────────────────────────────────────────────────
import * as runtime from './tools/runtime.js';
import * as screenshot from './tools/screenshot.js';
import * as project from './tools/project.js';
import * as scene from './tools/scene.js';
import * as script from './tools/script.js';
import * as validation from './tools/validation.js';
import * as docs from './tools/docs.js';
import * as physicsOps from './tools/physics-ops.js';
import * as audioOps from './tools/audio-ops.js';
import * as tilemapOps from './tools/tilemap-ops.js';
import * as materialOps from './tools/material-ops.js';
import * as gameBridge from './tools/game-bridge.js';
import * as workflow from './tools/workflow.js';
import * as animationOps from './tools/animation/animation-ops.js';
import * as profilerOps from './tools/profiler-ops.js';
// test-framework → merged into validation (v0.18.0)
// import * as testFramework from './tools/test-framework.js';
import * as animtreeOps from './tools/animtree.js';
import * as navigationOps from './tools/navigation.js';
import * as particlesOps from './tools/particles.js';
import * as signalOps from './tools/signal-ops.js';
// batch-tools → merged into workflow (v0.18.0)
// import * as batchTools from './tools/batch-tools.js';
import * as uiOps from './tools/ui-tools.js';
// recording → merged into runtime (v0.18.0)
// import * as recordingOps from './tools/recording.js';
import * as editorSync from './tools/editor-sync.js';
import * as animationTrack from './tools/animation/animation-track.js';
// delivery → merged into validation (v0.18.0)
// import * as delivery from './tools/delivery.js';
// code-templates → merged into project (v0.18.0)
// import * as codeTemplates from './tools/code-templates.js';
// ik-tools → merged into animation-ops (v0.18.0)
// import * as ikTools from './tools/ik-tools.js';
// game-design → merged into validation (v0.18.0)
// import * as gameDesign from './tools/game-design.js';
import * as manageTools from './tools/manage-tools.js';
import * as instanceTools from './tools/instance-tools.js';
import * as advancedProxy from './tools/advanced-proxy.js';
import * as loadSkill from './tools/load-skill.js';
import * as androidOps from './tools/android.js';
import * as cpp from './tools/cpp.js';
import * as dataImport from './tools/data-import.js';
import * as getContext from './tools/get-context.js';
import * as asset from './tools/asset/asset-ops.js';
import * as blender from './tools/blender.js';
import * as selfUpdate from './tools/self-update.js';
import * as testing from './tools/testing.js';
import * as debug from './tools/debug.js';  // CMP-3 (2026-08-08): debug 组 Phase 1 断点管理
import * as dap from './tools/dap.js';  // P9 (2026-09-12): debug 组 DAP 断点调试(TS 直连 editor DAP server)
import * as engine from './tools/engine.js';  // CMP-4 (2026-08-08): engine 组 实时 ClassDB 内省
import * as runtimeAssert from './tools/runtime-assert.js';
import * as qa from './tools/qa/index.js';  // v0.30 B 批：QA 测试套件编排
import * as analysis from './tools/analysis/index.js';  // v0.30 C 批：理解层 signal_map/impact_check
import * as help from './tools/help.js';
import * as audit from './tools/audit.js';  // G3 (2026-08-13): 操作审计日志查询
import * as uidOps from './tools/uid-ops.js';  // P1-1 (2026-08-19): Godot 4.4+ 文件 UID 管理
import * as translationOps from './tools/translation-ops.js';  // P1-2 (2026-08-19): 翻译文件读写/注册

// ─── Registration ─────────────────────────────────────────────────────────────

/** All tool modules in registration order. */
const ALL_MODULES: ToolModule[] = [
  runtime,
  screenshot,
  project,
  scene,
  script,
  validation,
  docs,
  physicsOps,
  audioOps,
  tilemapOps,
  materialOps,
  gameBridge,
  workflow,
  animationOps,
  profilerOps,
  animtreeOps,
  navigationOps,
  particlesOps,
  signalOps,
  uiOps,
  editorSync,
  animationTrack,
  manageTools,
  instanceTools,
  advancedProxy,
  loadSkill,
  androidOps,
  cpp,
  dataImport,
  getContext,
  asset,
  blender,
  selfUpdate,
  testing,
  debug,
  dap,
  engine,
  runtimeAssert,
  qa,
  analysis,
  help,
  audit,
  uidOps,
  translationOps,
];

// ─── Tag injection ─────────────────────────────────────────────────────────────

/** Build tool→group mapping for tag injection. */
function buildToolGroupMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [group, def] of Object.entries(TOOL_GROUPS)) {
    for (const tool of def.tools) {
      map.set(tool, group);
    }
  }
  return map;
}

const toolGroupMap = buildToolGroupMap();

/**
 * Derive MCP-standard ToolAnnotations hints from a tool's actionRisks.
 *
 * Maps the project's internal RiskLevel taxonomy (read/write/destructive/process)
 * to the four MCP-standard hints (spec 2025-06-18). Clients use these to decide
 * whether to prompt for user confirmation before executing the tool.
 *
 * Rules (conservative — never over-claim safety):
 * - readOnlyHint:    true only if every action is 'read'
 * - destructiveHint: true if any action is 'destructive'
 * - idempotentHint:  true if readOnly OR pure-write（idempotent 的定义是「多次执行结果一致/重试安全」。
 *                    纯读无副作用 ⇒ 幂等;纯写（全部 write,无 destructive/process）覆盖/设置/创建同值
 *                    结果一致,重试不放大副作用,亦判幂等。混合 read+write 的工具因 merged action
 *                    模式无法整体判定（如 save_scene 幂等但 create_node 不幂等）,保守 false。
 *                    destructive（删除不可重试）与 process（执行副作用不可逆）一律 false。
 *                    readOnly 是 idempotent 的充分条件而非定义）
 * - openWorldHint:   omitted (tools operate on Godot's closed world; default false)
 *
 * Tools without actionRisks default to write semantics (readOnlyHint=false),
 * matching the registry's default readonly=false for untagged tools (A-10).
 */
export function deriveMcpHints(actionRisks?: Record<string, RiskLevel>): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
} {
  if (!actionRisks) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  }
  const risks = Object.values(actionRisks);
  if (risks.length === 0) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  }
  const hasDestructive = risks.some(r => r === 'destructive');
  const hasProcess = risks.some(r => r === 'process');
  const hasWrite = risks.some(r => r === 'write' || r === 'destructive' || r === 'process');
  const isReadOnly = !hasWrite; // every action is 'read'
  // P1-1: 纯写工具（全部 write,无 destructive/process）幂等 —— 覆盖/设置/创建同值结果一致。
  // 混合 read+write 不判幂等:merged action 模式下整体无法判定。
  const isPureWrite = !hasDestructive && !hasProcess && risks.every(r => r === 'write');
  return {
    readOnlyHint: isReadOnly,
    destructiveHint: hasDestructive,
    idempotentHint: isReadOnly || isPureWrite,
  };
}

/**
 * Inject annotations.tags (group:xxx) AND MCP-standard hints into tool definitions.
 *
 * Tags come from the TOOL_GROUPS mapping. Hints come from each tool's actionRisks
 * via deriveMcpHints. Manually-set hints on a tool definition take precedence —
 * auto-derivation only fills hints the tool author left unset, so explicit
 * annotations (e.g. marking a tool destructiveHint=true manually) are respected.
 */
function injectTags(defs: Tool[]): Tool[] {
  return defs.map(def => {
    const hints = deriveMcpHints(getToolMeta(def.name)?.actionRisks);
    return {
      ...def,
      annotations: {
        ...def.annotations,
        tags: [`group:${toolGroupMap.get(def.name) ?? 'unknown'}`],
        // 手动标注优先, 缺失才用 RiskLevel 派生（MCP spec 2025-06-18）
        readOnlyHint: def.annotations?.readOnlyHint ?? hints.readOnlyHint,
        destructiveHint: def.annotations?.destructiveHint ?? hints.destructiveHint,
        idempotentHint: def.annotations?.idempotentHint ?? hints.idempotentHint,
      },
    };
  });
}

// ─── P2-11: slimSchema pass（schema 瘦身，消除 check-token-budget WARN）──────
// 方案 A（深度对比①）：超阈值的工具把"低频 action 专属参数"从 properties 移到 description，
// 参数仍可通过 additionalProperties 传入（LLM 按 description 提示构造）。
// 不改运行时行为：handler 仍从 args 读这些参数，只是 schema 不再逐字段声明。
//
// 设计：配置驱动（非启发式自动识别——后者太脆弱）。SLIM_CONFIG 按 toolName 列出要移除的
// 参数 + 追加到 description 的提示文本。阈值 SLIM_THRESHOLD_BYTES 决定哪些工具触发瘦身。
export const SLIM_THRESHOLD_BYTES = 8000;

// P4-1 (2026-09-11) 勘误(初版标注口径错,审查 B-1 证伪):slim 对 ui **实际生效**——
// 阈值判断用变换前的原始 barrel schema(≥8000B 触发),registry/matrix 侧看到的 ~4.8KB
// 是瘦身后产物(descHint 追加 + theme 系/tree/ops/geometry 属性移除),勿把产物值当触发
// 输入。game(原始 ~8.2KB)无配置走人工压缩路线;整属性移除机制保留作应急通道,日常
// 瘦身优先"源描述人工压缩"(解释性文本删/结构形状保,完整解释归 .claude/rules 规则文档)。
export const SLIM_CONFIG: Record<string, { removeProps: string[]; descHint: string }> = {
  // P8-3 (2026-09-11): ui 条目移除——P8-2 unknown-param 拒绝语义反转后,"从 properties
  // 移除但 handler 仍读"的 additionalProperties 约定失效(agent 传 theme_action/tree/ops 等
  // 会被拒,theme/draw/prototype 功能破坏)。schema 不撒谎是 SSOT 防线前提:键属于结构
  // 形状不可砍(P4 边界结论的自恰延伸)。机制(空配置)保留作应急通道;日常瘦身走源描述人工压缩。
};

/**
 * 对超阈值的工具瘦身：移除 action 专属参数，追加 description 提示。
 * 幂等：已瘦身的工具（无配置或未超阈值）原样返回。
 */
export function slimSchema(defs: Tool[]): Tool[] {
  return defs.map(def => {
    const config = SLIM_CONFIG[def.name];
    if (!config) return def;
    const schemaStr = JSON.stringify(def.inputSchema);
    if (Buffer.byteLength(schemaStr, 'utf8') < SLIM_THRESHOLD_BYTES) return def;

    // 保留 inputSchema 完整结构（type/required 等），只替换 properties
    const inputSchema = def.inputSchema as {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
      [k: string]: unknown;
    };
    if (!inputSchema?.properties) return def;

    const removed: string[] = [];
    const oldProperties = inputSchema.properties as Record<string, unknown>;
    const newProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(oldProperties)) {
      if (config.removeProps.includes(key)) {
        removed.push(key);
      } else {
        newProperties[key] = value;
      }
    }
    if (removed.length === 0) return def;

    // v2 SDK 的 Tool.inputSchema.properties 类型收紧为 JSON Schema 叶节点联合类型，
    // slimSchema 是运行时变换（JSON.stringify 后逐属性过滤），用类型断言保持兼容。
    return {
      ...def,
      description: def.description + config.descHint,
      inputSchema: { ...inputSchema, properties: newProperties },
    } as Tool;
  });
}

let registered = false;

/** Register all tool modules into the global registry. Idempotent — safe to call multiple times. */
export function registerAllModules(): void {
  if (registered) return;
  registered = true;
  for (const mod of ALL_MODULES) {
    const originalGetDefs = mod.getToolDefinitions;
    const wrappedMod = {
      ...mod,
      TOOL_META: mod.TOOL_META,
      getToolDefinitions: () => slimSchema(injectTags(originalGetDefs.call(mod))),
    };
    registerModule(wrappedMod);
  }
}
