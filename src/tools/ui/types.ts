// UI tool constants, types, and shared helpers.

import { gdEscape, valueToGd } from '../shared.js';
import { BLOCKED_PROPS } from '../scene/helpers.js';
import type { Rect } from './anchor-solver.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const ACTIONS = [
  'ui_create_control',
  'ui_set_layout',
  'ui_get_layout',
  'ui_anchor_preset',
  'ui_set_theme',
  'ui_container_add',
  'ui_draw_recipe',
  'ui_build_layout',
  'ui_measure_layout',
  'ui_import_prototype',
  'ui_pixel_verify',
  'theme_create',
  'theme_set_property',
] as const;

export const CONTROL_TYPES = [
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect',
  'ColorPickerButton', 'TabContainer', 'Tree', 'ItemList',
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer',
  'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
  // 反馈批次 B B1(2026-09-09/09-10): 补 TextureButton/ColorRect(UI 刚需),与 ui_commands.gd ALLOWED_CONTROL_TYPES 同步
  'TextureButton', 'ColorRect',
] as const;

export const ANCHOR_PRESETS: Record<string, number> = {
  top_left: 0,
  top_right: 1,
  bottom_left: 2,
  bottom_right: 3,
  center_left: 4,
  center_top: 5,
  center_right: 6,
  center_bottom: 7,
  center: 8,
  left_wide: 9,
  top_wide: 10,
  right_wide: 11,
  bottom_wide: 12,
  vcenter_wide: 13,
  hcenter_wide: 14,
  full_rect: 15,
};

export const ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_DRAW_OP: 'INVALID_DRAW_OP',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  THEME_NOT_FOUND: 'THEME_NOT_FOUND',
  INVALID_THEME_PROPERTY: 'INVALID_THEME_PROPERTY',
  INVALID_THEME_ITEM_TYPE: 'INVALID_THEME_ITEM_TYPE',
} as const;

export const DRAW_OP_KINDS = ['rect', 'circle', 'line', 'arc', 'polygon', 'polyline', 'string'] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export type DrawOp = { kind: string; [key: string]: unknown };

export interface FlexLayout {
  direction: 'row' | 'column' | 'row-reverse' | 'column-reverse' | 'grid';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  align?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  wrap?: 'nowrap' | 'wrap';
  gap?: number;
  row_gap?: number;
  padding?: number | [number, number, number, number];
  columns?: number;
}

export interface FlexChild {
  grow?: number;
  shrink?: number;
  align_self?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch';
  min_width?: number;
  min_height?: number;
  max_width?: number;
  max_height?: number;
}

// ─── PR-1: StyleBox 通道类型 ────────────────────────────────────────────────

/** stylebox 类 theme override 槽位白名单(spec §3.3;Godot 4.7 序列化属性名
 * theme_override_styles/<slot>,spec 原文 styleboxes 系误写——Task 4 集成实测)。
 * hover/pressed/disabled 仅供 ui_build_layout 手写树入口,翻译器永不产出;
 * focus/read_only 等显式不进(YAGNI:每扩一槽须定义语义边界+测试面)。
 * 双份硬编码:GD 侧副本在 ui-measure.ts 生成脚本的 _all_slots(override 并集扫描),扩槽须两处同步。 */
export type StyleBoxSlot = 'panel' | 'normal' | 'background' | 'fill' | 'hover' | 'pressed' | 'disabled';

export const STYLEBOX_SLOTS: readonly StyleBoxSlot[] = [
  'panel', 'normal', 'background', 'fill', 'hover', 'pressed', 'disabled',
];

/** StyleBoxFlat 描述(spec §3.2);corner_radius 支持统一值或四角对象。 */
export interface StyleBoxFlatSpec {
  bg_color?: [number, number, number, number];        // 0-1
  corner_radius?: number | { tl?: number; tr?: number; br?: number; bl?: number };
  border_width?: number;                               // 统一四边
  border_color?: [number, number, number, number];
  draw_center?: boolean;
}

export interface StyleBoxOverride {
  slot: StyleBoxSlot;
  box: StyleBoxFlatSpec;
}

export type UiNodeSpec = {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  anchor_preset?: string;
  rect?: Rect;
  layout?: FlexLayout;
  flex?: FlexChild;
  styleboxes?: StyleBoxOverride[];   // PR-1:样式槽位(spec §3.2)
  children?: UiNodeSpec[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/** 阶段4 同源安全: 返回 properties 中命中 BLOCKED_PROPS 的 key(script/owner/name/instance 等危险属性)。
 * 对齐 material-ops IMP-1 / scene S1——UI 工具此前未传播此安全策略。 */
export function findBlockedProps(properties?: Record<string, unknown>): string[] {
  if (!properties) return [];
  return Object.keys(properties).filter(k => BLOCKED_PROPS.has(k));
}

export function genPropertyLines(properties: Record<string, unknown>): string {
  let lines = '';
  for (const [key, value] of Object.entries(properties)) {
    lines += `\n\tnode.set("${gdEscape(key)}", ${valueToGd(value)})`;
  }
  return lines;
}

/** Convert a color value ([r,g,b] or [r,g,b,a]) to a GDScript Color() expression. */
export function colorToGd(c: unknown): string {
  if (Array.isArray(c) && (c.length === 3 || c.length === 4)) {
    return valueToGd(c.length === 3 ? [c[0], c[1], c[2], 1] : c) as string;
  }
  return valueToGd(c ?? [1, 1, 1, 1]);
}
