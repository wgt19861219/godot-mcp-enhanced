import { describe, it, expect } from 'vitest'
import {
  isAllowedConfigKey,
  validateConfigValue,
  projectWriteConfig,
} from '../src/tools/project-config.js'

// ─── isAllowedConfigKey ──────────────────────────────────────────────────

describe('isAllowedConfigKey', () => {
  it('accepts resource path keys', () => {
    expect(isAllowedConfigKey('run/main_scene')).toBe(true)
    expect(isAllowedConfigKey('application/config/icon')).toBe(true)
  })

  it('accepts string keys', () => {
    expect(isAllowedConfigKey('application/config/name')).toBe(true)
    expect(isAllowedConfigKey('application/config/description')).toBe(true)
  })

  it('accepts integer keys', () => {
    expect(isAllowedConfigKey('display/window/size/viewport_width')).toBe(true)
    expect(isAllowedConfigKey('display/window/size/viewport_height')).toBe(true)
  })

  it('accepts enum keys', () => {
    expect(isAllowedConfigKey('display/window/stretch/mode')).toBe(true)
    expect(isAllowedConfigKey('display/window/stretch/aspect')).toBe(true)
    expect(isAllowedConfigKey('rendering/renderer/rendering_method')).toBe(true)
  })

  it('accepts autoload/* pattern', () => {
    expect(isAllowedConfigKey('autoload/GameManager')).toBe(true)
    expect(isAllowedConfigKey('autoload/PlayerData')).toBe(true)
  })

  it('rejects input/* keys', () => {
    expect(isAllowedConfigKey('input/move_up')).toBe(false)
    expect(isAllowedConfigKey('input/jump')).toBe(false)
  })

  it('rejects arbitrary keys', () => {
    expect(isAllowedConfigKey('unknown/key')).toBe(false)
    expect(isAllowedConfigKey('physics/2d/default_gravity')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isAllowedConfigKey('')).toBe(false)
  })
})

// ─── validateConfigValue ─────────────────────────────────────────────────

describe('validateConfigValue', () => {
  it('validates res:// prefix for resource path keys', () => {
    expect(validateConfigValue('run/main_scene', 'res://scenes/main.tscn').valid).toBe(true)
    expect(validateConfigValue('run/main_scene', 'scenes/main.tscn').valid).toBe(false)
    expect(validateConfigValue('run/main_scene', 'scenes/main.tscn').error).toContain('res://')
  })

  it('validates res:// prefix for icon', () => {
    expect(validateConfigValue('application/config/icon', 'res://icon.svg').valid).toBe(true)
    expect(validateConfigValue('application/config/icon', 'icon.svg').valid).toBe(false)
  })

  it('accepts any string for string keys', () => {
    expect(validateConfigValue('application/config/name', 'My Game').valid).toBe(true)
    expect(validateConfigValue('application/config/name', '').valid).toBe(true)
    expect(validateConfigValue('application/config/description', 'A game').valid).toBe(true)
  })

  it('validates positive integers', () => {
    expect(validateConfigValue('display/window/size/viewport_width', '1280').valid).toBe(true)
    expect(validateConfigValue('display/window/size/viewport_height', '720').valid).toBe(true)
    expect(validateConfigValue('display/window/size/viewport_width', '0').valid).toBe(false)
    expect(validateConfigValue('display/window/size/viewport_height', '-10').valid).toBe(false)
    expect(validateConfigValue('display/window/size/viewport_width', '3.14').valid).toBe(false)
    expect(validateConfigValue('display/window/size/viewport_width', 'abc').valid).toBe(false)
  })

  it('validates enum membership', () => {
    expect(validateConfigValue('display/window/stretch/mode', 'canvas_items').valid).toBe(true)
    expect(validateConfigValue('display/window/stretch/mode', 'disabled').valid).toBe(true)
    expect(validateConfigValue('display/window/stretch/mode', 'viewport').valid).toBe(true)
    expect(validateConfigValue('display/window/stretch/mode', 'fill').valid).toBe(false)

    expect(validateConfigValue('display/window/stretch/aspect', 'keep').valid).toBe(true)
    expect(validateConfigValue('display/window/stretch/aspect', 'expand').valid).toBe(true)
    expect(validateConfigValue('display/window/stretch/aspect', 'fit').valid).toBe(false)

    expect(validateConfigValue('rendering/renderer/rendering_method', 'forward_plus').valid).toBe(true)
    expect(validateConfigValue('rendering/renderer/rendering_method', 'mobile').valid).toBe(true)
    expect(validateConfigValue('rendering/renderer/rendering_method', 'vulkan').valid).toBe(false)
  })

  it('validates autoload path must start with res://', () => {
    expect(validateConfigValue('autoload/GameMgr', 'res://scripts/game.gd').valid).toBe(true)
    expect(validateConfigValue('autoload/Player', 'scripts/player.gd').valid).toBe(false)
  })

  it('rejects disallowed keys', () => {
    const result = validateConfigValue('input/jump', 'space')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not in the allowed whitelist')
  })

  // M2 (2026-06-23): autoload value 误带前导 *(Godot project.godot 惯例)时,提示去掉——写入时自动注入
  it('M2: autoload value with leading * gets hint to omit it (auto-injected at write time)', () => {
    const r = validateConfigValue('autoload/GameMgr', '*res://scripts/game.gd')
    expect(r.valid).toBe(false)
    expect(r.error).toContain('*')
    expect(r.error).toMatch(/auto-injected|omit|去掉|前导/)
  })

  // B5(竞品综述落地批 2026-11-13): res:// 值段级 ".." 拒绝——前缀检查挡不住
  // res://../<项目外>;对齐 path-utils.ts:196 段级精确形态(分隔符先统一防 ..\ 混合
  // 形态,含 .. 的合法文件名 foo..bar.gd 不误伤)。autoload 与 res_path 两分支同款。
  describe('B5: segment-level ".." rejection', () => {
    it('autoload 分支: res://../evil 拒绝', () => {
      const r = validateConfigValue('autoload/GameMgr', 'res://../evil.gd')
      expect(r.valid).toBe(false)
      expect(r.error).toContain('".." path segments')
    })

    it('autoload 分支: 混合分隔符 res://a/../..\\\\evil 拒绝', () => {
      const r = validateConfigValue('autoload/GameMgr', 'res://a/../..\\evil.gd')
      expect(r.valid).toBe(false)
      expect(r.error).toContain('".." path segments')
    })

    it('autoload 分支: 合法路径与含 ".." 文件名不误伤', () => {
      expect(validateConfigValue('autoload/GameMgr', 'res://scripts/game.gd').valid).toBe(true)
      expect(validateConfigValue('autoload/GameMgr', 'res://scripts/foo..bar.gd').valid).toBe(true)
      expect(validateConfigValue('autoload/GameMgr', 'res://scripts/..hidden.gd').valid).toBe(true)
    })

    it('res_path 分支: res://../evil 拒绝(含混合分隔符)', () => {
      expect(validateConfigValue('run/main_scene', 'res://../evil.tscn').valid).toBe(false)
      const mixed = validateConfigValue('run/main_scene', 'res://a/..\\evil.tscn')
      expect(mixed.valid).toBe(false)
      expect(mixed.error).toContain('".." path segments')
    })

    it('res_path 分支: 合法路径与含 ".." 文件名不误伤', () => {
      expect(validateConfigValue('run/main_scene', 'res://scenes/main.tscn').valid).toBe(true)
      expect(validateConfigValue('run/main_scene', 'res://scenes/foo..bar.tscn').valid).toBe(true)
    })
  })
})

// ─── projectWriteConfig ──────────────────────────────────────────────────

describe('projectWriteConfig', () => {
  const SAMPLE_CONFIG = [
    '; Engine config',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="TestGame"',
    'run/main_scene="res://scenes/main.tscn"',
    '',
    '[display]',
    '',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    '',
    '[rendering]',
    '',
    'renderer/rendering_method="forward_plus"',
    '',
  ].join('\n')

  it('updates an existing key in an existing section', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'application/config/name', 'New Name')
    expect(result.success).toBe(true)
    expect(result.content).toContain('config/name="New Name"')
    // Original content preserved
    expect(result.content).toContain('run/main_scene="res://scenes/main.tscn"')
    expect(result.content).toContain('viewport_width=1280')
  })

  it('adds a new key to an existing section', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'application/config/description', 'My game')
    expect(result.success).toBe(true)
    expect(result.content).toContain('config/description="My game"')
    // Section header still exists
    expect(result.content).toContain('[application]')
    // Other sections untouched
    expect(result.content).toContain('[display]')
  })

  it('creates a new section when needed', () => {
    const minimalConfig = [
      '[application]',
      '',
      'config/name="Test"',
      '',
    ].join('\n')

    const result = projectWriteConfig(minimalConfig, 'display/window/stretch/mode', 'canvas_items')
    expect(result.success).toBe(true)
    expect(result.content).toContain('[display]')
    expect(result.content).toContain('window/stretch/mode=canvas_items')
  })

  it('rejects a disallowed key', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'input/jump', 'space')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not in the allowed whitelist')
  })

  it('rejects an invalid value', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'display/window/size/viewport_width', '-5')
    expect(result.success).toBe(false)
    expect(result.error).toContain('positive integer')
  })

  it('writes autoload key with * prefix', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'autoload/GameMgr', 'res://scripts/game.gd')
    expect(result.success).toBe(true)
    expect(result.content).toContain('[autoload]')
    expect(result.content).toContain('GameMgr="*res://scripts/game.gd"')
  })

  it('updates existing autoload key', () => {
    const withAutoload = SAMPLE_CONFIG + '\n[autoload]\n\nGameMgr="*res://old.gd"\n'
    const result = projectWriteConfig(withAutoload, 'autoload/GameMgr', 'res://scripts/new.gd')
    expect(result.success).toBe(true)
    expect(result.content).toContain('GameMgr="*res://scripts/new.gd"')
    expect(result.content).not.toContain('old.gd')
  })

  it('writes integer values unquoted', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'display/window/size/viewport_width', '1920')
    expect(result.success).toBe(true)
    expect(result.content).toContain('window/size/viewport_width=1920')
    expect(result.content).not.toContain('window/size/viewport_width="1920"')
  })

  it('writes enum values unquoted', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'display/window/stretch/mode', 'viewport')
    expect(result.success).toBe(true)
    expect(result.content).toContain('window/stretch/mode=viewport')
    expect(result.content).not.toContain('window/stretch/mode="viewport"')
  })

  it('writes string values quoted', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'application/config/name', 'My "Game"')
    expect(result.success).toBe(true)
    expect(result.content).toContain('config/name="My \\"Game\\""')
  })

  it('preserves existing content and structure', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'application/config/name', 'Updated')
    expect(result.success).toBe(true)
    // Config header preserved
    expect(result.content).toContain('; Engine config')
    expect(result.content).toContain('config_version=5')
    // Other sections intact
    expect(result.content).toContain('[rendering]')
    expect(result.content).toContain('renderer/rendering_method="forward_plus"')
  })

  it('updates an existing integer value', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'display/window/size/viewport_height', '1080')
    expect(result.success).toBe(true)
    expect(result.content).toContain('window/size/viewport_height=1080')
    expect(result.content).not.toContain('viewport_height=720')
  })

  it('updates an existing enum value', () => {
    const result = projectWriteConfig(SAMPLE_CONFIG, 'rendering/renderer/rendering_method', 'mobile')
    expect(result.success).toBe(true)
    expect(result.content).toContain('renderer/rendering_method=mobile')
    expect(result.content).not.toContain('forward_plus')
  })
})
