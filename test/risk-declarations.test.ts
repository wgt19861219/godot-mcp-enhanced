import { describe, it, expect } from 'vitest';
import { registerAllModules } from '../src/module-loader.js';
import { getActionRisk } from '../src/core/tool-registry.js';

registerAllModules();

describe('scene actionRisks', () => {
  const cases = {
    read_scene: 'read', query_scene_tree: 'read', inspect_node: 'read', health_check: 'read',
    create_scene: 'write', quick_scene: 'write', add_node: 'write', batch_add_nodes: 'write',
    edit_node: 'write', save_scene: 'write', load_sprite: 'write', instance_scene: 'write',
    set_instance_property: 'write', detach_instance: 'write', create_3d_node: 'write', commit: 'write',
    remove_node: 'destructive', merge_scene: 'destructive',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`scene.${action} → ${risk}`, () => expect(getActionRisk('scene', action)).toBe(risk));
  }
});

describe('script actionRisks', () => {
  const cases = {
    read_script: 'read', write_script: 'write', edit_script: 'write',
    generate_test: 'write', create_test_scene: 'write',
    execute_gdscript: 'process', project_replace: 'destructive',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`script.${action} → ${risk}`, () => expect(getActionRisk('script', action)).toBe(risk));
  }
});

describe('animation actionRisks', () => {
  const cases = {
    list_players: 'read', get_info: 'read', get_details: 'read', get_keyframes: 'read',
    play: 'read', stop: 'read', seek: 'read', blend: 'read',
    ik_modifier_get: 'read', ik_list_bones: 'read',
    create: 'write', update_props: 'write', add_track: 'write', add_keyframe: 'write',
    update_keyframe: 'write', ik_modifier_create: 'write', ik_modifier_set: 'write',
    delete: 'destructive', remove_track: 'destructive', remove_keyframe: 'destructive',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`animation.${action} → ${risk}`, () => expect(getActionRisk('animation', action)).toBe(risk));
  }
});

describe('animation_track actionRisks', () => {
  // P0-2（批次 E，commit 4bcb35a）：remove_track/remove_keyframe/update_keyframe 是破坏性操作，
  // 对齐 animation-ops 同名 destructive。add_track/add_keyframe/set_curve 非破坏仍 read。
  const cases = {
    add_track: 'read', add_keyframe: 'read', set_curve: 'read',
    remove_track: 'destructive', remove_keyframe: 'destructive', update_keyframe: 'destructive',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`animation_track.${action} → ${risk}`, () => expect(getActionRisk('animation_track', action)).toBe(risk));
  }
});

describe('animtree actionRisks', () => {
  // P0-2 续（2026-08-10）：create/add_state/add_transition/set_blend/state_edit 是写操作
  // （create 挂场景树 add_child，其余改状态机结构/参数）。play 是运行时触发仍 read。
  const cases = {
    animtree_play: 'read',
    animtree_create: 'write', animtree_add_state: 'write', animtree_add_transition: 'write',
    animtree_set_blend: 'write', animtree_state_edit: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`animtree.${action} → ${risk}`, () => expect(getActionRisk('animtree', action)).toBe(risk));
  }
});

describe('tilemap actionRisks', () => {
  const cases = {
    tilemap_read: 'read', tilemap_copy: 'read',
    tilemap_set_cell: 'write', tilemap_erase_cell: 'write', tilemap_fill_rect: 'write',
    tilemap_paste: 'write', tilemap_set_transform: 'write',
    tilemap_clear: 'destructive',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`tilemap.${action} → ${risk}`, () => expect(getActionRisk('tilemap', action)).toBe(risk));
  }
});

describe('material actionRisks', () => {
  const cases = {
    read: 'read', shader_read: 'read', shader_list_templates: 'read',
    set_params: 'write', create: 'write', save: 'write', load: 'write',
    shader_write: 'write', shader_load_file: 'write', shader_save_file: 'write', shader_apply_template: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`material.${action} → ${risk}`, () => expect(getActionRisk('material', action)).toBe(risk));
  }
});

describe('particles actionRisks', () => {
  const cases = {
    particles_create: 'write', particles_set_emission: 'write', particles_set_process: 'write',
    particles_load_preset: 'write', particles_set_material: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`particles.${action} → ${risk}`, () => expect(getActionRisk('particles', action)).toBe(risk));
  }
});

describe('signal actionRisks', () => {
  const cases = {
    signal_connect: 'read', signal_disconnect: 'read', signal_list: 'read', signal_emit: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`signal.${action} → ${risk}`, () => expect(getActionRisk('signal', action)).toBe(risk));
  }
});

describe('nav actionRisks', () => {
  const cases = {
    query_path: 'read', create_region: 'write', bake_mesh: 'write',
    create_agent: 'write', set_params: 'write', create_link: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`nav.${action} → ${risk}`, () => expect(getActionRisk('nav', action)).toBe(risk));
  }
});

describe('audio actionRisks', () => {
  const cases = {
    audio_play: 'read', audio_stop: 'read', audio_query: 'read', audio_set_param: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`audio.${action} → ${risk}`, () => expect(getActionRisk('audio', action)).toBe(risk));
  }
});

describe('ui actionRisks', () => {
  const cases = {
    ui_get_layout: 'read', ui_create_control: 'write', ui_set_layout: 'write',
    ui_anchor_preset: 'write', ui_set_theme: 'write', ui_container_add: 'write',
    ui_draw_recipe: 'write', ui_build_layout: 'write', theme_create: 'write', theme_set_property: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`ui.${action} → ${risk}`, () => expect(getActionRisk('ui', action)).toBe(risk));
  }
});

describe('physics actionRisks', () => {
  const cases = {
    raycast: 'read', body_info: 'read', diagnose: 'read', query_spatial: 'read', collision_overlay: 'write',
  } as const;
  for (const [action, risk] of Object.entries(cases)) {
    it(`physics.${action} → ${risk}`, () => expect(getActionRisk('physics', action)).toBe(risk));
  }
});

describe('game actionRisks', () => {
  const cases = {
    game_query:'read', game_input:'read', game_wait:'read', monitor_start:'read', monitor_stop:'read', monitor_poll:'read',
    watch_start:'read', watch_stop:'read', watch_poll:'read', find_ui_elements:'read', click_button:'read',
    game_bridge_install:'write', game_bridge_uninstall:'write', game_write:'process',
  } as const;
  for (const [a, r] of Object.entries(cases)) it(`game.${a}→${r}`, () => expect(getActionRisk('game', a)).toBe(r));
});

describe('runtime actionRisks', () => {
  const cases = {
    get_debug_output:'read', get_godot_version:'read', record_load:'read',
    launch_editor:'process', run_project:'process', stop_project:'process', run_tests:'process',
    record_start:'write', record_stop:'write', record_save:'write', record_play:'write',
  } as const;
  for (const [a, r] of Object.entries(cases)) it(`runtime.${a}→${r}`, () => expect(getActionRisk('runtime', a)).toBe(r));
});

describe('android actionRisks', () => {
  const cases = { list_devices:'read', get_preset_info:'read', check_template:'read', logcat:'read', deploy:'process' } as const;
  for (const [a, r] of Object.entries(cases)) it(`android.${a}→${r}`, () => expect(getActionRisk('android', a)).toBe(r));
});

describe('workflow actionRisks', () => {
  const cases = { scene_snapshot:'read', batch_validate:'read', diff_scenes:'read', dev_loop:'process', run_verify:'process', create_files:'write' } as const;
  for (const [a, r] of Object.entries(cases)) it(`workflow.${a}→${r}`, () => expect(getActionRisk('workflow', a)).toBe(r));
});

describe('validation actionRisks', () => {
  const cases = {
    run_and_verify:'read', analyze_error:'read', validate_project:'read', validate_scripts:'read',
    export_list_presets:'read', export_get_preset:'read', validate_gdd:'read', chain_verify:'read', verify_delivery:'read',
    import_resources:'write', // 2026-10-14 审查修复 R1-tools:批量落盘不再零确认
    export_build:'process', assert:'process', stress:'process',
  } as const;
  for (const [a, r] of Object.entries(cases)) it(`validation.${a}→${r}`, () => expect(getActionRisk('validation', a)).toBe(r));
});

describe('manage_tools actionRisks', () => {
  const cases = { list_groups:'read', sync:'read', reconnect:'read', migrate:'read', activate:'write', deactivate:'write' } as const;
  for (const [a, r] of Object.entries(cases)) it(`manage_tools.${a}→${r}`, () => expect(getActionRisk('manage_tools', a)).toBe(r));
});

describe('qa actionRisks', () => {
  // PR-1b Task 4：status 只读注册表；cancel 置取消标志干预运行中进程（teardown 收尾），process
  const cases = { run: 'process', report: 'read', diff: 'read', status: 'read', cancel: 'process' } as const;
  for (const [a, r] of Object.entries(cases)) it(`qa.${a}→${r}`, () => expect(getActionRisk('qa', a)).toBe(r));
});
