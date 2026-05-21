import { it } from 'node:test';
import { findGodot } from '../../build/core/godot-finder.js';

let _godotPath = null;
let _godotAvailable = false;

/** 检测 Godot 是否可用（结果缓存） */
export async function ensureGodot() {
  if (_godotPath !== null) return _godotPath;
  try {
    _godotPath = await findGodot();
    _godotAvailable = true;
    return _godotPath;
  } catch {
    _godotAvailable = false;
    return null;
  }
}

export function isGodotAvailable() { return _godotAvailable; }
export function getGodotPath() { return _godotPath; }

/**
 * 条件执行：Godot 可用时跑测试，不可用时 skip。
 * node:test 没有 describe.skip，用 it({ skip: true }) 替代。
 */
export function itIfGodot(name, fn) {
  if (_godotAvailable) {
    return it(name, fn);
  }
  return it(name, { skip: 'Godot not available' }, fn);
}
