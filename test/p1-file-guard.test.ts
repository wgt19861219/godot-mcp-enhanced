import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPluginSelfPath, pluginSelfPathGuard } from '../src/tools/shared/file-guard.js';

/**
 * P1-2 (2026-09-11): 插件自资产写保护(FileGuard)— 单元 + 接线契约。
 * 威胁:被注入的脚本经 write/edit 工具改写 enhanced 自己的 bridge/插件守卫代码再触发重载
 * (自毁防御)。来源:NPGameDev file_guard.gd:102-115。保护面 = addons/godot_mcp_server/**
 * + 项目根 mcp_bridge.gd;其他 addons 照常可编辑(用户自己的插件开发不受影响)。
 */

describe('P1-2: isPluginSelfPath 判定矩阵', () => {
  it('FG-a: 命中——插件目录(含子文件/目录本身/正反斜杠/绝对相对)', () => {
    expect(isPluginSelfPath('D:/proj/addons/godot_mcp_server/plugin.gd')).toBe(true);
    expect(isPluginSelfPath('D:\\proj\\addons\\godot_mcp_server\\commands\\node_commands.gd')).toBe(true);
    expect(isPluginSelfPath('D:/proj/addons/godot_mcp_server')).toBe(true);
    expect(isPluginSelfPath('addons/godot_mcp_server/plugin.cfg')).toBe(true);
    expect(isPluginSelfPath('D:/proj/mcp_bridge.gd')).toBe(true);
    expect(isPluginSelfPath('/root/McpBridge')).toBe(false); // autoload 键名,非文件路径
  });

  it('FG-b: 不误伤——同前缀兄弟目录/用户自己的 addons/普通文件', () => {
    expect(isPluginSelfPath('D:/proj/addons/godot_mcp_server_fork/plugin.gd')).toBe(false); // 尾斜杠精确性
    expect(isPluginSelfPath('D:/proj/addons/my_own_plugin/plugin.gd')).toBe(false);
    expect(isPluginSelfPath('D:/proj/scripts/mcp_bridge_helper.gd')).toBe(false); // 非根 mcp_bridge.gd 精确名
    expect(isPluginSelfPath('D:/proj/scripts/player.gd')).toBe(false);
    expect(isPluginSelfPath('D:/proj/scenes/main.tscn')).toBe(false);
  });

  it('FG-b2: 大小写变体也拦(N-1 i 标志纵深防御) + mcp_bridge.gd 任意深度(I-3 语义)', () => {
    // 主路径已由 safeRealPath 的 realpath 大小写归一化兜底;i 标志防"插件目录祖先不存在"的预创建形态
    expect(isPluginSelfPath('D:/proj/addons/Godot_Mcp_Server/plugin.gd')).toBe(true);
    expect(isPluginSelfPath('D:/proj/ADDONS/GODOT_MCP_SERVER/plugin.gd')).toBe(true);
    expect(isPluginSelfPath('D:/proj/MCP_Bridge.GD')).toBe(true);
    // I-3: 守卫语义 = 任意位置同名 bridge 脚本(保守方向,与文档一致)
    expect(isPluginSelfPath('D:/proj/scripts/mcp_bridge.gd')).toBe(true);
    expect(isPluginSelfPath('D:/proj/sub/dir/mcp_bridge.gd')).toBe(true);
  });

  it('FG-c: guard 返回结构化拒绝(含自毁攻击说明与指引)', () => {
    const g = pluginSelfPathGuard('D:/proj/addons/godot_mcp_server/undo_manager.gd');
    expect(g).not.toBeNull();
    expect(g!.isError).toBe(true);
    const text = JSON.stringify(g!.content);
    expect(text.includes('PLUGIN_SELF_PATH_DENIED')).toBe(true);
    expect(text.includes('self-modification attack')).toBe(true);
    expect(pluginSelfPathGuard('D:/proj/scripts/player.gd')).toBeNull();
  });
});

describe('P1-2: 写入口接线契约', () => {
  it('FG-d: write_script/edit_script/project_replace/scene commit/quick_scene 共 5 守卫', () => {
    // 批7(2026-09-20) script.ts action 拆分后,守卫随 case 迁至 script/{write,edit,project-replace}.ts
    const write = readFileSync('src/tools/script/write.ts', 'utf8');
    expect((write.match(/pluginSelfPathGuard\(/g) ?? []).length, 'write.ts 1 处(write_script)').toBe(1);
    const edit = readFileSync('src/tools/script/edit.ts', 'utf8');
    expect((edit.match(/pluginSelfPathGuard\(/g) ?? []).length, 'edit.ts 1 处(edit_script)').toBe(1);
    const pr = readFileSync('src/tools/script/project-replace.ts', 'utf8');
    expect((pr.match(/pluginSelfPathGuard\(/g) ?? []).length, 'project-replace.ts 1 处(project_replace)').toBe(1);
    expect(pr.includes('整批原子检查'), 'project_replace 需整批守卫注释').toBe(true);
    const scene = readFileSync('src/tools/scene/index.ts', 'utf8');
    expect((scene.match(/pluginSelfPathGuard\(/g) ?? []).length, 'scene/index.ts 3 处(commit 1 + quick_scene 场景/脚本 2)').toBe(3);
  });
});
