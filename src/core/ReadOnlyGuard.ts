// src/core/ReadOnlyGuard.ts
// A-07: deny-by-default — unknown tools are blocked in readOnly mode.
// Registration order safety: GodotServer constructor calls registerModule() for all tool
// modules BEFORE creating the ReadOnlyGuard instance, so all tools are registered by the
// time guard.check() is first called. This is enforced by the constructor sequence.
// 批4-T5(五维评估 P2): check 升级 action 粒度——readonly=true 的工具若声明了非 read 的
// actionRisks(如 manage_tools activate='write'),该 action 在只读模式被拒,read action
// 仍放行。修复前显式 readonly:true 覆盖派生风险,只读模式下写 action 可达(只读承诺破坏)。
import { isReadOnly, isKnownTool, getActionRisk } from './tool-registry.js';

export interface GuardResult {
  blocked: boolean;
  errorCode?: number;
  message?: string;
}

export class ReadOnlyGuard {
  constructor(private readonly enabled: boolean) {}

  /**
   * @param action 可选 action 名。提供且非空时做 action 级判定(批4-T5):
   * readonly 工具的非 read/未知 action 在只读模式被拒(fail-closed——动态名等
   * 无法静态归风险的调用不放行)。不提供(如工具列表过滤场景)保持工具级判定。
   */
  check(toolName: string, action?: string): GuardResult {
    if (!this.enabled) return { blocked: false };
    // I-08: deny-by-default — unknown tools are blocked in readOnly mode
    if (!isKnownTool(toolName)) {
      return {
        blocked: true,
        errorCode: -32001,
        message: `Operation blocked: unknown tool "${toolName}" denied in read-only mode`,
      };
    }
    // 非 readonly 工具整体拒(原工具级行为,不变)
    if (!isReadOnly(toolName)) {
      return {
        blocked: true,
        errorCode: -32001,
        message: 'Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)',
      };
    }
    // 批4-T5: readonly 工具的 action 粒度复查——显式 readonly:true 不再覆盖 action 风险
    if (action !== undefined && action !== '') {
      const risk = getActionRisk(toolName, action);
      if (risk === undefined || risk !== 'read') {
        return {
          blocked: true,
          errorCode: -32001,
          message: `Operation blocked: action "${action}" of tool "${toolName}" is `
            + `${risk === undefined ? 'not statically risk-mapped' : `risk level "${risk}"`} `
            + '(not read-only); GODOT_MCP_READ_ONLY=true',
        };
      }
    }
    return { blocked: false };
  }
}
