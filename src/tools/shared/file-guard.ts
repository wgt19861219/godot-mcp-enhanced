/**
 * file-guard.ts — 插件自资产写保护(FileGuard,P1-2,2026-09-11)。
 *
 * 威胁模型:write_script/edit_script/save_scene 等文件写工具能写 enhanced 自己分发到
 * 目标项目的插件资产——被注入的 GDScript 可以先改掉 bridge/插件守卫代码再触发重载,
 * 实现持久化自毁防御(防"LLM 改写自己的守卫")。来源:NPGameDev file_guard.gd:102-115 [上游 license:GitHub API 报 NOASSERTION 待人工核实,见 THIRD_PARTY_NOTICES.md]
 * (拒插件自身目录,155 行;含"尾斜杠防误伤同前缀兄弟目录"细节)。
 *
 * 保护对象(项目内两形态):
 *   - addons/godot_mcp_server/          editor 插件目录(含守卫/命令/UI 源码)
 *   - mcp_bridge.gd                     game bridge 脚本(game_bridge_install 拷贝到项目根;守卫拦任意位置同名文件——保守方向,见 isPluginSelfPath 注释)
 *
 * 边界:只拒 enhanced 自己的插件资产;用户其他 addons 目录照常可编辑(用户可能合法
 * 开发自己的插件)。误伤面 = 想通过 MCP 工具改 enhanced 插件源码的工作流——请直接用
 * 编辑器手动改(与 NPGameDev 同语义,无 env 豁免,保持 default-deny 简单性)。
 * GD 侧(editor 插件命令)本批未做对称拦截,见批次审查文档 deferred 项。
 */
import { opsErrorResult } from '../../core/shared/errors.js';
import type { ToolResult } from '../../types.js';

/** 归一化斜杠后的插件自资产路径判定(路径含该形态段即命中,与项目根前缀无关)。 */
export function isPluginSelfPath(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, '/');
  // 尾段精确:目录含尾斜杠形态(.../godot_mcp_server/...)或恰好目录本身;防误伤同前缀
  // 兄弟目录(裸 startsWith("addons/godot_mcp_server") 会误伤 godot_mcp_server_fork 之类)
  if (/(^|\/)addons\/godot_mcp_server(\/|$)/i.test(norm)) return true;
  // 项目根 bridge 脚本(autoload 注入点,改它 = 改 bridge 全部行为)
  if (/(^|\/)mcp_bridge\.gd$/i.test(norm)) return true;
  return false;
}

/** 写入口统一守卫:命中插件自资产返回结构化拒绝,否则 null 放行。 */
export function pluginSelfPathGuard(absPath: string): ToolResult | null {
  if (!isPluginSelfPath(absPath)) return null;
  return opsErrorResult(
    'PLUGIN_SELF_PATH_DENIED',
    `${absPath} is the godot-mcp-enhanced plugin's own asset (bridge script / editor plugin source) and is protected from MCP write tools — a compromised script could rewrite the guards that police it (self-modification attack, see NPGameDev FileGuard). Edit it manually in the Godot editor if you really need to.`,
    { suggestion: 'Use the editor UI to edit plugin sources; MCP write tools cover user project files only.' },
  );
}
