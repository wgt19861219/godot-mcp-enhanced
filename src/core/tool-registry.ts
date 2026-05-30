// src/core/tool-registry.ts

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../types.js';

// ─── Tool metadata ──────────────────────────────────────────────────────────

export interface ToolMeta {
  name: string;
  readonly: boolean;
  long_running: boolean;
}

// ─── Tool module interface ───────────────────────────────────────────────────

export interface ToolModule {
  TOOL_META?: Record<string, { readonly: boolean; long_running: boolean }>;
  getToolDefinitions(): Tool[];
  handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null>;
}

// ─── Internal state ─────────────────────────────────────────────────────────

const metaRegistry = new Map<string, ToolMeta>();
const moduleRegistry = new Map<string, ToolModule>();
const modules: ToolModule[] = [];

// ─── Module registration ────────────────────────────────────────────────────

/** Register a tool module. Called once per module at import time. */
export function registerModule(mod: ToolModule): void {
  if (modules.includes(mod)) return; // idempotent
  modules.push(mod);
  const meta = mod.TOOL_META;
  if (meta) {
    for (const [name, m] of Object.entries(meta)) {
      const entry: ToolMeta = { name, ...m };
      metaRegistry.set(name, entry);
      moduleRegistry.set(name, mod);
    }
  } else {
    const toolNames = mod.getToolDefinitions().map(t => t.name);
    if (toolNames.length > 0) {
      console.warn(`[tool-registry] Module defines ${toolNames.length} tool(s) but has no TOOL_META — dispatch will fail: ${toolNames.join(', ')}`);
    }
  }
}

// ─── Query functions ─────────────────────────────────────────────────────────

/** Check whether a tool name is registered in the meta registry. */
export function isKnownTool(name: string): boolean {
  return metaRegistry.has(name);
}

export function isReadOnly(name: string): boolean {
  return metaRegistry.get(name)?.readonly ?? false;
}

export function isLongRunning(name: string): boolean {
  return metaRegistry.get(name)?.long_running ?? false;
}

export function getReadOnlyTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => m.readonly).map(([n]) => n);
}

export function getWriteTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => !m.readonly).map(([n]) => n);
}

export function getAllToolNames(): string[] {
  return [...metaRegistry.keys()];
}

export function getToolMeta(name: string): ToolMeta | undefined {
  return metaRegistry.get(name);
}

export function getModuleForTool(name: string): ToolModule | undefined {
  return moduleRegistry.get(name);
}

export function getAllToolDefinitions(): Tool[] {
  return modules.flatMap(m => m.getToolDefinitions());
}

export function getModules(): readonly ToolModule[] {
  return modules;
}

// ─── Legacy API (backward compat) ───────────────────────────────────────────

/** Register tools from flat array (legacy, used by tests). */
export function registerTools(tools: ToolMeta[]): void {
  for (const t of tools) {
    metaRegistry.set(t.name, t);
  }
}

/** Clear all registered tools and modules (test-only). */
export function clearRegistry(): void {
  metaRegistry.clear();
  moduleRegistry.clear();
  modules.length = 0;
}

// ─── Mode filters ────────────────────────────────────────────────────────────

// LITE mode tool set — coarse-grained after tool consolidation.
// Each merged tool name (e.g. 'scene') includes both safe and destructive actions.
// Destructive actions are protected by the confirmation token guard (guard.ts GUARDED map),
// which provides the second layer of defense at the action level.
export const LITE_TOOLS = new Set([
  'project', 'scene', 'script',           // 核心 CRUD
  'runtime', 'validation',                // 运行和验证
  'confirm_and_execute',                   // 确认执行
  'animation',                             // 动画基础
  'audio',                                 // 音频基础
  'docs',                                  // 文档查询
  'signal',                                // 信号操作
  'material',                              // 材质基础
  'test',                                  // 测试
  'screenshot',                            // 截图
  'profiler',                              // 性能
  'workflow',                              // dev_loop
  'game',                                  // Bridge
]);

export const MINIMAL_TOOLS = new Set([
  'project', 'scene', 'script',           // 最小可用集
  'runtime', 'validation',                // 运行和验证
  'confirm_and_execute',                   // 确认执行
]);

// Tools eligible for quick verification (run_and_verify).
// After consolidation, these merged tools may contain actions without a quickVerify handler —
// those will return 'not_implemented' gracefully.
export const VERIFY_ELIGIBLE_TOOLS = new Set([
  'scene', 'script', 'ui',
]);

export function isVerifyEligible(name: string): boolean {
  return VERIFY_ELIGIBLE_TOOLS.has(name);
}
