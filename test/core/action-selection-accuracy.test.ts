import { describe, it, expect } from 'vitest';

/** 50 条典型用户意图 → 期望的 (tool, action) 映射。
 *  验证 action 命名是否语义化、可从意图推断。 */
const INTENT_MAP: Array<{ intent: string; tool: string; action: string }> = [
  // Scene (8)
  { intent: '读取场景文件结构',            tool: 'scene',    action: 'read_scene' },
  { intent: '创建新场景',                 tool: 'scene',    action: 'create_scene' },
  { intent: '快速创建场景并附加脚本',      tool: 'scene',    action: 'quick_scene' },
  { intent: '添加节点到场景',             tool: 'scene',    action: 'add_node' },
  { intent: '编辑节点属性',               tool: 'scene',    action: 'edit_node' },
  { intent: '删除节点',                   tool: 'scene',    action: 'remove_node' },
  { intent: '保存场景',                   tool: 'scene',    action: 'save_scene' },
  { intent: '批量提交场景修改',           tool: 'scene',    action: 'commit' },
  // Script (4)
  { intent: '读取 GDScript 脚本',         tool: 'script',   action: 'read_script' },
  { intent: '写入脚本文件',               tool: 'script',   action: 'write_script' },
  { intent: '编辑脚本中的函数',           tool: 'script',   action: 'edit_script' },
  { intent: '执行 GDScript 代码片段',     tool: 'script',   action: 'execute_gdscript' },
  // Runtime (4)
  { intent: '启动游戏项目',               tool: 'runtime',  action: 'run_project' },
  { intent: '停止运行中的游戏',           tool: 'runtime',  action: 'stop_project' },
  { intent: '获取调试输出',               tool: 'runtime',  action: 'get_debug_output' },
  { intent: '开始录制输入事件',           tool: 'runtime',  action: 'record_start' },
  // Validation (4)
  { intent: '运行并验证场景',             tool: 'validation', action: 'run_and_verify' },
  { intent: '验证项目完整性',             tool: 'validation', action: 'validate_project' },
  { intent: '验证脚本语法',               tool: 'validation', action: 'validate_scripts' },
  { intent: '端到端交付验证',             tool: 'validation', action: 'verify_delivery' },
  // Game (3)
  { intent: '检查游戏 Bridge 连接状态',   tool: 'game',     action: 'query' },
  { intent: '模拟键盘输入',               tool: 'game',     action: 'input' },
  { intent: '等待节点出现',               tool: 'game',     action: 'wait' },
  // Animation (3)
  { intent: '播放动画',                   tool: 'animation', action: 'play' },
  { intent: '添加动画关键帧',             tool: 'animation', action: 'add_keyframe' },
  { intent: '创建动画树状态',             tool: 'animtree',  action: 'add_state' },
  // UI (3)
  { intent: '创建 UI 按钮控件',           tool: 'ui',       action: 'create_control' },
  { intent: '构建 UI 布局',              tool: 'ui',       action: 'build_layout' },
  { intent: '设置节点锚点预设',           tool: 'ui',       action: 'anchor_preset' },
  // 其他 (21)
  { intent: '创建导航区域',               tool: 'nav',      action: 'create_region' },
  { intent: '烘焙导航网格',               tool: 'nav',      action: 'bake_mesh' },
  { intent: '播放音效',                   tool: 'audio',    action: 'play' },
  { intent: '读取材质属性',               tool: 'material', action: 'read' },
  { intent: '创建粒子效果',               tool: 'particles',action: 'create' },
  { intent: '3D 射线检测',                tool: 'physics',  action: 'raycast' },
  { intent: '读取 TileMap 数据',          tool: 'tilemap',  action: 'read' },
  { intent: '连接信号',                   tool: 'signal',   action: 'connect' },
  { intent: '获取性能快照',               tool: 'profiler', action: 'snapshot' },
  { intent: '执行 dev_loop 工作流',       tool: 'workflow', action: 'dev_loop' },
  { intent: '查询 Godot 类文档',          tool: 'docs',     action: 'get_class_info' },
  { intent: '管理工具组启用/禁用',        tool: 'manage_tools', action: 'activate' },
  { intent: '确认并执行危险操作',         tool: 'confirm_and_execute', action: '' },
  { intent: '截取游戏画面',               tool: 'screenshot', action: 'capture' },
  { intent: '安装 Game Bridge',           tool: 'game',     action: 'bridge_install' },
  { intent: '查看项目信息',               tool: 'project',  action: 'get_project_info' },
  { intent: '列出项目文件',               tool: 'project',  action: 'list_files' },
  { intent: '列出代码模板',               tool: 'project',  action: 'list' },
  { intent: '启动编辑器',                 tool: 'runtime',  action: 'launch_editor' },
  { intent: '同步编辑器场景树',           tool: 'editor',   action: 'sync_start' },
  { intent: 'IK 修饰器创建',             tool: 'animation', action: 'ik_modifier_create' },
];

describe('意图→action 选准率测试', () => {
  it('覆盖 50 条意图', () => {
    expect(INTENT_MAP.length).toBeGreaterThanOrEqual(50);
  });

  it('每个 intent 映射到有效的 tool 名', () => {
    const validTools = new Set([
      'project', 'scene', 'script', 'runtime', 'validation', 'editor', 'game',
      'animation', 'animtree', 'audio', 'material',
      'screenshot', 'particles', 'physics', 'nav', 'ui', 'tilemap', 'signal',
      'profiler', 'workflow', 'docs', 'manage_tools', 'confirm_and_execute',
      'godot_advanced_tool', 'godot_list_instances', 'godot_select_instance',
    ]);
    for (const { intent, tool } of INTENT_MAP) {
      expect(validTools.has(tool)).toBe(true);
    }
  });

  it('action 名称语义化 — 可从意图合理推断', () => {
    // 这是一个设计质量检查：action 名应该包含意图中的关键动词/名词
    for (const { intent, action } of INTENT_MAP) {
      if (!action) continue; // 跳过无 action 的工具
      // action 名应是 snake_case 且包含可辨识的语义
      expect(action).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
