// test/claudemd-builder.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildEngineVersion,
  buildRenderer,
  buildMainScene,
  buildKeyPaths,
  buildAutoloads,
  buildInputMap,
  buildPhysics,
  buildLayerNames,
  buildMcpMapping,
  mergeSections,
} from '../src/tools/claudemd-builder.js';

describe('claudemd-builder — simple builders', () => {
  describe('buildEngineVersion', () => {
    it('extracts version from PackedStringArray format', () => {
      const config = {
        application: { 'config/features': 'PackedStringArray("4.6", "Forward+")' },
      };
      expect(buildEngineVersion(config)).toBe('- Godot 4.6');
    });

    it('returns fallback when no features', () => {
      const config = { application: {} };
      expect(buildEngineVersion(config)).toBe('- Godot 4.x（版本未知）');
    });

    it('returns null when config is null', () => {
      expect(buildEngineVersion(null)).toBeNull();
    });

    it('returns null when no application section', () => {
      expect(buildEngineVersion({})).toBeNull();
    });
  });

  describe('buildRenderer', () => {
    it('extracts renderer/rendering_method', () => {
      const config = { rendering: { 'renderer/rendering_method': 'mobile' } };
      expect(buildRenderer(config)).toBe('- mobile');
    });

    it('extracts renderer (legacy key)', () => {
      const config = { rendering: { renderer: 'forward_plus' } };
      expect(buildRenderer(config)).toBe('- forward_plus');
    });

    it('returns null when no rendering section', () => {
      expect(buildRenderer({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildRenderer(null)).toBeNull();
    });
  });

  describe('buildMainScene', () => {
    it('extracts run/main_scene', () => {
      const config = { application: { 'run/main_scene': 'res://scenes/main.tscn' } };
      expect(buildMainScene(config)).toBe('- res://scenes/main.tscn');
    });

    it('returns null when no main scene', () => {
      const config = { application: {} };
      expect(buildMainScene(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildMainScene(null)).toBeNull();
    });
  });
});

describe('claudemd-builder — keyPaths & autoloads', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  describe('buildKeyPaths', () => {
    it('lists existing known directories', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      mkdirSync(join(tempDir, 'scenes'));
      mkdirSync(join(tempDir, 'scripts'));
      mkdirSync(join(tempDir, 'assets'));
      mkdirSync(join(tempDir, 'unknown_dir'));

      const result = buildKeyPaths(tempDir);
      expect(result).toContain('scenes/');
      expect(result).toContain('scripts/');
      expect(result).toContain('assets/');
      expect(result).not.toContain('unknown_dir');
    });

    it('returns null when no known directories exist', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      expect(buildKeyPaths(tempDir)).toBeNull();
    });

    it('includes addons when present', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      mkdirSync(join(tempDir, 'addons'));
      mkdirSync(join(tempDir, 'scripts'));

      const result = buildKeyPaths(tempDir);
      expect(result).toContain('addons/');
      expect(result).toContain('scripts/');
    });

    it('uses └── for last entry', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      mkdirSync(join(tempDir, 'scripts'));

      const result = buildKeyPaths(tempDir);
      expect(result).toContain('└──');
      expect(result).not.toContain('├──');
    });
  });

  describe('buildAutoloads', () => {
    it('builds table from autoload config', () => {
      const config = {
        autoload: {
          GlobalManager: '*res://core/global.gd',
          GameManager: 'res://core/game_manager.gd',
        },
      };
      const result = buildAutoloads(config);
      expect(result).toContain('| GlobalManager |');
      expect(result).toContain('| GameManager |');
      expect(result).toContain('res://core/global.gd');
    });

    it('truncates paths over 40 chars', () => {
      const config = {
        autoload: {
          LongName: 'res://very/long/path/that/exceeds/forty/characters/in/total/manager.gd',
        },
      };
      const result = buildAutoloads(config);
      expect(result).toContain('…');
    });

    it('returns null when no autoload section', () => {
      expect(buildAutoloads({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildAutoloads(null)).toBeNull();
    });
  });
});

describe('claudemd-builder — input/physics/layers/mcp', () => {
  describe('buildInputMap', () => {
    it('extracts action names from input section', () => {
      const config = {
        input: {
          move_up: 'Object(InputEventKey,...)',
          move_down: 'Object(InputEventKey,...)',
          attack: 'Object(InputEventKey,...)',
        },
      };
      const result = buildInputMap(config);
      expect(result).toContain('move_up');
      expect(result).toContain('move_down');
      expect(result).toContain('attack');
    });

    it('summarizes actions when more than 15', () => {
      const input = {};
      for (let i = 0; i < 20; i++) input[`action_${i}`] = 'Object(...)';
      const config = { input };
      const result = buildInputMap(config);
      expect(result).toContain('等');
    });

    it('returns null when no input section', () => {
      expect(buildInputMap({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildInputMap(null)).toBeNull();
    });
  });

  describe('buildPhysics', () => {
    it('returns non-default gravity values', () => {
      const config = { physics: { '3d/default_gravity': 20.0 } };
      const result = buildPhysics(config);
      expect(result).toContain('3D 重力');
      expect(result).toContain('20');
    });

    it('returns null when all default', () => {
      const config = { physics: { '3d/default_gravity': 9.8 } };
      expect(buildPhysics(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildPhysics(null)).toBeNull();
    });

    it('returns null when no physics section', () => {
      expect(buildPhysics({})).toBeNull();
    });
  });

  describe('buildLayerNames', () => {
    it('extracts non-empty layer names', () => {
      const config = {
        layer_names: {
          '2d_physics/layer_1': 'Player',
          '2d_physics/layer_2': 'Enemy',
          '2d_physics/layer_3': '',
        },
      };
      const result = buildLayerNames(config);
      expect(result).toContain('2D 物理');
      expect(result).toContain('Player');
      expect(result).toContain('Enemy');
      expect(result).not.toContain('layer_3');
    });

    it('returns null when all layers empty', () => {
      const config = {
        layer_names: {
          '2d_physics/layer_1': '',
          '2d_physics/layer_2': '',
        },
      };
      expect(buildLayerNames(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildLayerNames(null)).toBeNull();
    });
  });

  describe('buildMcpMapping', () => {
    it('always returns mapping table', () => {
      const result = buildMcpMapping();
      expect(result).toContain('.claude/rules/godot-mcp.md');
      expect(result).toContain('全部工具规则');
    });
  });
});

describe('claudemd-builder — mergeSections', () => {
  it('appends MCP sections to title-only file', () => {
    const existing = '# My Game\n\nSome intro text.\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |\n|------|------|'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).toContain('# My Game');
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('- Godot 4.6');
    expect(result).toContain('## MCP 规则映射');
    expect(result).toContain('Some intro text.');
    // MCP sections come before user text
    const mcpIdx = result.indexOf('## 引擎版本');
    const userIdx = result.indexOf('Some intro text');
    expect(mcpIdx).toBeLessThan(userIdx);
  });

  it('replaces old Godot MCP Rules with new sections', () => {
    const existing = '# My Game\n## Godot MCP Rules\n- old rule\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |\n|------|------|'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).not.toContain('## Godot MCP Rules');
    expect(result).not.toContain('old rule');
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('## MCP 规则映射');
  });

  it('preserves user sections after MCP sections', () => {
    const existing = '# My Game\n## 我的规范\n- my rule\n## 引擎版本\n- Godot 4.5\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).toContain('## 我的规范');
    expect(result).toContain('my rule');
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- Godot 4.5');
    // User section comes after all MCP sections
    const lastMcp = result.lastIndexOf('## MCP 规则映射');
    const user = result.indexOf('## 我的规范');
    expect(user).toBeGreaterThan(lastMcp);
  });

  it('handles file with no ## headers', () => {
    const existing = '# My Game\nJust some text here\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('Just some text here');
  });

  it('handles duplicate MCP section headers', () => {
    const existing = '# My Game\n## 引擎版本\n- old1\n## 引擎版本\n- old2\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- old1');
    expect(result).not.toContain('- old2');
    // Only one ## 引擎版本
    expect(result.split('## 引擎版本').length).toBe(2);
  });

  it('normalizes whitespace in headers', () => {
    const existing = '# My Game\n##  引擎版本 \n- old\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- old');
  });

  it('handles empty file', () => {
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections('', sections);
    expect(result).toContain('## 引擎版本');
  });
});
