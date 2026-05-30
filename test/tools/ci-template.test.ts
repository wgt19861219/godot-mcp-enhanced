import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateCiTemplate } from '../../src/tools/project.js';

describe('generateCiTemplate', () => {
  it('应生成有效的 GitHub Actions YAML', () => {
    const yaml = generateCiTemplate('4.4.1');
    expect(yaml).toContain('name: Godot CI');
    expect(yaml).toContain('on: [push, pull_request]');
    expect(yaml).toContain('godot');
    expect(yaml).toContain('4.4.1');
    expect(yaml).toContain('--headless');
    expect(yaml).toContain('--check-only');
  });

  it('应使用默认版本号', () => {
    const yaml = generateCiTemplate();
    expect(yaml).toContain('4.4');
  });
});
