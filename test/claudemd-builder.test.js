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
} from '../build/tools/claudemd-builder.js';

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
