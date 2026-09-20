// src/core/shared/blocked-props.ts
// 场景节点危险属性黑名单——原住 src/tools/scene/helpers.ts(W1 下沉,2026-09-20 可维护性批1):
// tscn 底层解析子系统(tscn-editor-add)反向依赖 tools/ 层取此常量属层次倒置,下沉 core/shared
// 供 tscn/tools 两层共用。清单与语义零变化,纯搬家。
export const BLOCKED_PROPS = new Set([
  'script', 'owner', 'name', 'parent', 'children', 'tree',
  'meta', 'process_mode', 'process_priority',
  'process_input', 'process_unhandled_input', 'process_unhandled_key_input',
  'process_internal', 'physics_process_mode', 'input_event', 'ready',
  // I-2: instance 属性可被注入 ExtResource(1),formatTscnValue 对 ExtResource\( 不加引号原样输出,
  // Godot 会让新节点实例化该 ext_resource 指向的资源(含脚本),间接触发 _ready()。
  // 与 script 同级危险,必须阻断。
  'instance',
]);
