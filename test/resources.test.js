import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listResources,
  listResourceTemplates,
  readResource,
} from '../src/resources.js';

describe('resources', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'godot-resources-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listResources returns array when projectPath is undefined', () => {
    const resources = listResources(undefined);
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);
    // Should have a help resource when no project
    expect(resources[0].uri).toBe('godot://help');
  });

  it('listResources returns array with valid project path', () => {
    // Create minimal project structure
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="TestProject"\n');
    mkdirSync(join(tmpDir, 'scenes'));
    writeFileSync(join(tmpDir, 'scenes', 'main.tscn'), '[gd_scene load_steps=2 format=3]\n');
    mkdirSync(join(tmpDir, 'scripts'));
    writeFileSync(join(tmpDir, 'scripts', 'player.gd'), 'extends Node2D\n');

    const resources = listResources(tmpDir);
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);

    // Should have project info resources
    const uris = resources.map(r => r.uri);
    expect(uris).toContain('godot://project/info');
    expect(uris).toContain('godot://project/config');

    // Should discover scene and script files
    expect(uris.some(u => u.startsWith('godot://scene/'))).toBe(true);
    expect(uris.some(u => u.startsWith('godot://script/'))).toBe(true);

    // Should have guide resources
    expect(uris.some(u => u.startsWith('godot://guide/'))).toBe(true);
  });

  it('listResourceTemplates returns non-empty array', () => {
    const templates = listResourceTemplates();
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThanOrEqual(3);

    const templateNames = templates.map(t => t.name);
    expect(templateNames).toContain('Scene');
    expect(templateNames).toContain('Script');
    expect(templateNames).toContain('File');

    // Each template should have uriTemplate
    for (const t of templates) {
      expect(t.uriTemplate).toBeTruthy();
      expect(t.uriTemplate).toContain('godot://');
    }
  });

  it('readResource with valid guide uri', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    const content = readResource('godot://guide/getting-started', tmpDir);
    expect(content.uri).toBe('godot://guide/getting-started');
    expect(content.text).toBeTruthy();
    expect(content.text).toContain('Getting Started');
    expect(content.mimeType).toBe('text/markdown');
  });

  it('readResource with project/info uri', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="TestProject"\nconfig_version=5\n');
    const content = readResource('godot://project/info', tmpDir);
    expect(content.uri).toBe('godot://project/info');
    expect(content.text).toBeTruthy();
    const parsed = JSON.parse(content.text);
    expect(parsed['application/name']).toBe('TestProject');
  });

  it('readResource with unknown uri', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    const content = readResource('godot://unknown/thing', tmpDir);
    expect(content.text).toContain('Unknown resource category');
  });

  it('readResource with invalid uri scheme', () => {
    const content = readResource('http://example.com', tmpDir);
    expect(content.text).toContain('Invalid URI scheme');
  });

  it('readResource with unknown guide returns error', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    const content = readResource('godot://guide/nonexistent', tmpDir);
    expect(content.text).toContain('Unknown guide');
  });

  it('readResource with undefined projectPath returns error', () => {
    const content = readResource('godot://project/info', undefined);
    expect(content.text).toContain('No project path available');
  });

  it('listResources with invalid path does not crash', () => {
    // Non-existent path should not throw
    const resources = listResources('/nonexistent/path/that/does/not/exist');
    expect(Array.isArray(resources)).toBe(true);
    // Should still return project info resources even if no files scanned
    expect(resources.length).toBeGreaterThan(0);
  });

  it('readResource with file uri reads text file', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    mkdirSync(join(tmpDir, 'data'));
    writeFileSync(join(tmpDir, 'data', 'items.json'), '{"items": []}');

    const content = readResource('godot://file/data/items.json', tmpDir);
    expect(content.text).toContain('items');
    expect(content.mimeType).toBe('application/json');
  });

  it('readResource blocks forbidden extensions', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    mkdirSync(join(tmpDir, 'assets'));
    writeFileSync(join(tmpDir, 'assets', 'icon.png'), 'fake png');

    const content = readResource('godot://file/assets/icon.png', tmpDir);
    expect(content.text).toContain('Access denied');
  });

  it('readResource with missing file returns error', () => {
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nname="Test"\n');
    const content = readResource('godot://file/nonexistent.txt', tmpDir);
    expect(content.text).toContain('File not found');
  });
});
