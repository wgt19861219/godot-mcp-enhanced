// ─── project-config.ts — Safe project.godot configuration writer ─────────
//
// Whitelist-validated key/value writer for Godot's project.godot INI file.
// Only explicitly-listed keys are accepted; value format is strictly validated.

// ─── Types ────────────────────────────────────────────────────────────────

export interface ConfigWriteResult {
  success: boolean
  content?: string
  error?: string
}

// ─── Whitelist definitions ────────────────────────────────────────────────

type ValueKind = 'res_path' | 'string' | 'positive_int' | 'enum' | 'autoload_path'

interface KeyRule {
  kind: ValueKind
  /** For enum kind: the set of legal values */
  legalValues?: string[]
}

const RESOURCE_PATH_KEYS: Record<string, KeyRule> = {
  'run/main_scene': { kind: 'res_path' },
  'application/config/icon': { kind: 'res_path' },
}

const STRING_KEYS: Record<string, KeyRule> = {
  'application/config/name': { kind: 'string' },
  'application/config/description': { kind: 'string' },
}

const INT_KEYS: Record<string, KeyRule> = {
  'display/window/size/viewport_width': { kind: 'positive_int' },
  'display/window/size/viewport_height': { kind: 'positive_int' },
}

const ENUM_KEYS: Record<string, KeyRule> = {
  'display/window/stretch/mode': {
    kind: 'enum',
    legalValues: ['disabled', 'canvas_items', 'viewport'],
  },
  'display/window/stretch/aspect': {
    kind: 'enum',
    legalValues: ['ignore', 'keep', 'keep_height', 'keep_width', 'expand'],
  },
  'rendering/renderer/rendering_method': {
    kind: 'enum',
    legalValues: ['forward_plus', 'mobile', 'gl_compatibility'],
  },
}

/** Merge all explicit key maps for lookup */
const EXPLICIT_KEYS: Record<string, KeyRule> = {
  ...RESOURCE_PATH_KEYS,
  ...STRING_KEYS,
  ...INT_KEYS,
  ...ENUM_KEYS,
}

const AUTOLOAD_PREFIX = 'autoload/'

// B5(竞品综述落地批 2026-11-13): res:// 值的段级 ".." 拒绝——前缀检查挡不住
// res://../<项目外> 越界;对齐 path-utils.ts:196 段级精确形态(分隔符先统一防
// ..\ 混合形态漏网,含 .. 的合法文件名 foo..bar.gd 不误伤)。
function hasParentSegment(value: string): boolean {
  return value.replace(/\\/g, '/').split('/').some(seg => seg === '..')
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check whether a config key is in the whitelist.
 * Explicit keys and autoload/* patterns are accepted.
 */
export function isAllowedConfigKey(key: string): boolean {
  if (!key) return false
  if (key in EXPLICIT_KEYS) return true
  if (key.startsWith(AUTOLOAD_PREFIX)) return true
  return false
}

/**
 * Validate a value against the rule for a given key.
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export function validateConfigValue(key: string, value: string): { valid: boolean; error?: string } {
  if (!isAllowedConfigKey(key)) {
    return { valid: false, error: `Key "${key}" is not in the allowed whitelist` }
  }

  // Determine rule
  const rule: KeyRule | undefined = EXPLICIT_KEYS[key]
  const isAutoload = key.startsWith(AUTOLOAD_PREFIX)

  if (isAutoload) {
    // Autoload value must be a res:// path (the * prefix is added at write time)
    if (!value.startsWith('res://')) {
      // M2 (2026-06-23): 若误带前导 *(Godot project.godot autoload 惯例),提示去掉——写入时自动注入
      const starHint = value.startsWith('*') ? ' — omit the leading "*" (it is auto-injected at write time)' : ''
      return { valid: false, error: `Autoload value must start with res://, got: "${value}"${starHint}` }
    }
    // B5(竞品综述落地批 2026-11-13): 段级 ".." 拒绝(防 res://../<项目外> 越界)
    if (hasParentSegment(value)) {
      return { valid: false, error: `Autoload value must not contain ".." path segments, got: "${value}"` }
    }
    return { valid: true }
  }

  if (!rule) {
    // Should not happen — isAllowedConfigKey covers this
    return { valid: false, error: `Unknown key rule for "${key}"` }
  }

  switch (rule.kind) {
    case 'res_path':
      if (!value.startsWith('res://')) {
        return { valid: false, error: `Resource path must start with res://, got: "${value}"` }
      }
      // B5(竞品综述落地批 2026-11-13): 段级 ".." 拒绝(防 res://../<项目外> 越界,同 autoload 分支)
      if (hasParentSegment(value)) {
        return { valid: false, error: `Resource path must not contain ".." path segments, got: "${value}"` }
      }
      return { valid: true }

    case 'string':
      // Any non-empty string is fine
      return { valid: true }

    case 'positive_int': {
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        return { valid: false, error: `Value must be a positive integer, got: "${value}"` }
      }
      return { valid: true }
    }

    case 'enum':
      if (rule.legalValues && !rule.legalValues.includes(value)) {
        return { valid: false, error: `Value must be one of [${rule.legalValues.join(', ')}], got: "${value}"` }
      }
      return { valid: true }

    default:
      return { valid: true }
  }
}

/**
 * Write a config key=value into project.godot content string.
 * Returns the modified content or an error.
 */
export function projectWriteConfig(content: string, key: string, value: string): ConfigWriteResult {
  // 1. Validate key
  if (!isAllowedConfigKey(key)) {
    return { success: false, error: `Key "${key}" is not in the allowed whitelist` }
  }

  // 2. Validate value
  const validation = validateConfigValue(key, value)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  // 3. Determine section and property name
  //    key like "display/window/size/viewport_width" → section "[display]", prop "window/size/viewport_width"
  //    key like "application/config/name" → section "[application]", prop "config/name"
  //    key like "autoload/GameMgr" → section "[autoload]", prop "GameMgr"
  const isAutoload = key.startsWith(AUTOLOAD_PREFIX)
  const sectionName = isAutoload ? 'autoload' : key.split('/')[0]!
  const propName = isAutoload ? key.slice(AUTOLOAD_PREFIX.length) : key.slice(sectionName.length + 1)

  // 4. Format the line
  let line: string
  const rule: KeyRule | undefined = EXPLICIT_KEYS[key]
  if (isAutoload) {
    // Autoload: KeyName="*res://path/to/script.gd"
    line = `${propName}="*${value}"`
  } else if (rule?.kind === 'positive_int' || rule?.kind === 'enum') {
    // Integers and enums are unquoted
    line = `${propName}=${value}`
  } else {
    // Strings and resource paths are quoted
    line = `${propName}="${escapeIniValue(value)}"`
  }

  // 5. Parse and modify INI content
  const lines = content.split('\n')
  let sectionIndex = -1  // Line index of [sectionName]
  let insertIndex = -1   // Where to insert the property
  let propFound = false

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()

    // Detect section headers
    if (trimmed === `[${sectionName}]`) {
      sectionIndex = i
      // Look for the property within this section
      for (let j = i + 1; j < lines.length; j++) {
        const inner = lines[j]!.trim()
        // Stop at next section
        if (inner.startsWith('[') && inner.endsWith(']')) break
        // Match existing property line (exact prop name before =)
        const eqIdx = inner.indexOf('=')
        if (eqIdx !== -1) {
          const existingProp = inner.substring(0, eqIdx).trim()
          if (existingProp === propName) {
            // Replace this line
            lines[j] = line
            propFound = true
            break
          }
        }
      }
      if (!propFound) {
        // Find the last non-empty line in this section
        let lastInSection = i
        for (let j = i + 1; j < lines.length; j++) {
          const inner = lines[j]!.trim()
          if (inner.startsWith('[') && inner.endsWith(']')) break
          lastInSection = j
        }
        insertIndex = lastInSection + 1
      }
      break
    }
  }

  if (propFound) {
    // Already replaced in-place
    return { success: true, content: lines.join('\n') }
  }

  if (sectionIndex !== -1) {
    // Section exists, property does not — insert after last line in section
    lines.splice(insertIndex, 0, line)
    return { success: true, content: lines.join('\n') }
  }

  // Section does not exist — append new section at end
  lines.push('')
  lines.push(`[${sectionName}]`)
  lines.push('')
  lines.push(line)
  return { success: true, content: lines.join('\n') }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Escape backslashes and double quotes for INI value strings */
function escapeIniValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
