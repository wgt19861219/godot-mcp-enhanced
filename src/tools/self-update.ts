import type { Tool } from "@modelcontextprotocol/server";

// src/tools/self-update.ts
// 单工具 self_update + action enum=[check,update]。
// ⚠️ 粒度选择：不能用两个独立无-action工具——guard.ts:65 action==null → return false
//    会导致 update 的 confirm 门静默失效。action enum 让 args.action='update' 命中确认门。
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsErrorResult } from './shared.js';
import { checkForUpdateCached, compareVersion, PKG_VERSION, readInstalledPkgVersion, checkServerFresh } from '../core/update-checker.js';
import { readAddonVersion, updateAddon } from '../core/addon-version.js';
import { getAllowedProjectPaths, isPathInAllowedRoots } from '../core/path-utils.js';
import { inspectRulesDistribution } from './project.js';

// P0-1（2026-10-24）：本地 createRequire 副本已删，PKG_VERSION 单一来源化到 core/update-checker.ts
// （src/tools/ → 上两级包根 → package.json，与模板同源同岁的固化值）。

const ACTIONS = ['check', 'update'] as const;

// readonly 不可设 true（否则 update 在 readOnly 模式放行绕过保护）。
// 见 spec §5：ReadOnlyGuard 工具级判定，readonly=false → readOnly 拒整工具（check 也拒）。
export const TOOL_META = {
  self_update: {
    readonly: false,
    long_running: false,
    actionRisks: {
      check: 'read' as const,
      update: 'write' as const,
    },
  },
};

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'self_update',
    description: '检查/更新 enhanced 自身。check：查 npm 最新版 + 各项目 addon 版本漂移 + 规则分发状态（含 content-drift 毒化检测,只读）。update：更新指定项目 addon 到包版本（覆盖安装，需确认）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'update'],
          description: 'check=查版本状态（只读）/ update=更新项目 addon（破坏性，需确认）',
        },
        project_path: {
          type: 'string',
          description: '目标 Godot 项目路径（update 必填；check 可选，缺省扫 ALLOWED_PROJECT_PATHS 全部）',
        },
      },
      required: ['action'],
    },
  }];
}

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'self_update') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action as 'check' | 'update')) {
    return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
  return action === 'check' ? handleCheck(args) : handleUpdate(args);
}

async function handleCheck(args: Record<string, unknown>): Promise<ToolResult> {
  const npm = await checkForUpdateCached({ force: true });
  const hasProjectArg = !!args.project_path;
  const targetPaths = args.project_path
    ? [String(args.project_path)]
    : getAllowedProjectPaths();
  const addons = targetPaths.map(p => {
    try {
      const { version, installed } = readAddonVersion(p);
      return {
        project_path: p,
        installed_version: version,
        expected_version: installed ? PKG_VERSION : null,
        matches: installed ? version === PKG_VERSION : false,
        installed,
      };
    } catch (e) {
      return { project_path: p, installed: false, installed_version: null,
        expected_version: null, matches: false,
        error: e instanceof Error ? e.message : String(e) };
    }
  });
  // P1-3（2026-10-24 可靠性批）：规则分发状态巡检——与 addons 漂移同列报告。
  // status: current=已分发当前版本 / stale=版本过时 / content-drift=版本行与内容指纹不符
  //（疑似旧进程毒化,重跑 setup_project_rules(update) 可修复）/ missing=未分发。
  // 注意判定用进程固化 PKG_VERSION + 进程内模板 hash,旧进程上 stale 会反向误报
  //（实际需重启客户端）——与 npm.current 同龄问题,报告值仅供参考,godot_get_context
  // 的 server.version 才是进程年龄的权威读数。
  // 审查 Important-2：显式 project_path 是 AI 可控参数,巡检前过白名单（对齐同函数
  // addons 段 readAddonVersion 的 isPathInAllowedRoots 校验语义,防文件系统结构探测）。
  const rules = targetPaths.map(p => {
    try {
      if (!isPathInAllowedRoots(p)) {
        throw new Error(`路径不在 ALLOWED_PROJECT_PATHS 白名单内: ${p}`);
      }
      return { project: p, ...inspectRulesDistribution(p) };
    } catch (e) {
      return {
        project: p, status: 'missing' as const, installed_version: null, files: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  // M7：spec §4.3 — 无 project_path 参数 且 ALLOWED_PROJECT_PATHS 未配置时返提示
  const data: Record<string, unknown> = { npm, addons, rules };
  if (!hasProjectArg && targetPaths.length === 0) {
    data.hint = '未配置 ALLOWED_PROJECT_PATHS，无法扫描项目 addon。配置 ALLOWED_PROJECT_PATHS=/path1;/path2 或传 project_path 参数指定单个项目';
  }
  return textResult(JSON.stringify(opsSuccess(data)));
}

async function handleUpdate(args: Record<string, unknown>): Promise<ToolResult> {
  // P0-3（2026-10-24 毒化拦截）：旧进程上 update 会把 addon 装到旧版本（addon 脚本
  // 内容同样来自进程内存的 build/scripts）——与规则分发同族缺陷，同款拦截。
  const diskVersion = readInstalledPkgVersion();
  if (diskVersion != null) {
    const fresh = checkServerFresh(PKG_VERSION, diskVersion);
    if (!fresh.ok) return opsErrorResult(fresh.errorCode, fresh.message, { retryable: true });
  }
  const projectPath = args.project_path;
  if (typeof projectPath !== 'string' || !projectPath) {
    return opsErrorResult('INVALID_PARAMS', 'update action 需要 project_path 参数');
  }
  // 降级保护：null（未安装/malformed）直 cp 修复；非 null 且 >包版本 才拒绝
  // I-1：readAddonVersion 内 isPathInAllowedRoots 若拒会 throw，包 try/catch 返结构化错误
  // （与 handleCheck 对齐，避免 ToolDispatcher re-throw 成 MCP -32603 generic error 让 AI 无法区分错误源）
  let installed: string | null;
  let isInstalled: boolean;
  try {
    ({ version: installed, installed: isInstalled } = readAddonVersion(projectPath));
  } catch (e) {
    return opsErrorResult('PATH_NOT_ALLOWED', e instanceof Error ? e.message : String(e));
  }
  if (isInstalled && installed != null && compareVersion(installed, PKG_VERSION) > 0) {
    return opsErrorResult('DOWNGRADE_REFUSED',
      `项目 addon 版本 ${installed} 比包版本 ${PKG_VERSION} 新，疑似降级，拒绝`);
  }
  try {
    const { dest, verifyOk } = updateAddon(projectPath);
    if (!verifyOk) {
      return opsErrorResult('VERIFY_FAILED', `addon 更新后 plugin.cfg 校验失败：${dest}`);
    }
    return textResult(JSON.stringify(opsSuccess({
      project_path: projectPath,
      updated_from: installed,
      updated_to: PKG_VERSION,
      verifyOk,
      dest,
    })));
  } catch (e) {
    return opsErrorResult('UPDATE_FAILED', e instanceof Error ? e.message : String(e));
  }
}
