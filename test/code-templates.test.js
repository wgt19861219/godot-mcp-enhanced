import { expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEMPLATES,
  getTemplateSuggestion,
  renderTemplate,
  getAllTemplates,
  loadUserTemplates,
} from '../src/tools/code-templates.js';

// ─── 1. 内置模板 ─────────────────────────────────────────────────────────────

describe('内置模板', () => {
  it('至少有 10 个模板', () => {
    expect(TEMPLATES.length >= 10).toBeTruthy();
  });

  it('每个模板包含 id / name / description / generate 函数', () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
      expect(tpl.description).toBeTruthy();
      expect(typeof tpl.generate).toBe('function');
    }
  });

  it('每个模板 id 唯一', () => {
    const ids = TEMPLATES.map(t => t.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('每个模板 generate({}) 返回非空字符串', () => {
    for (const tpl of TEMPLATES) {
      const code = tpl.generate({});
      expect(typeof code === 'string' && code.length > 0).toBeTruthy();
    }
  });
});

// ─── 2. 模板渲染 ─────────────────────────────────────────────────────────────

describe('renderTemplate', () => {
  it('替换单个变量', () => {
    expect(renderTemplate('var speed = {{speed}}', { speed: '300' })).toBe('var speed = 300');
  });

  it('未替换的占位符保持不变', () => {
    expect(renderTemplate('var x = {{x}}, y = {{y}}', { x: '1' })).toBe('var x = 1, y = {{y}}');
  });

  it('多次出现全部替换', () => {
    expect(renderTemplate('{{v}} + {{v}} = {{result}}', { v: '2', result: '4' })).toBe('2 + 2 = 4');
  });

  it('无占位符的字符串原样返回', () => {
    expect(renderTemplate('extends Node3D', {})).toBe('extends Node3D');
  });

  it('rejects template variable values with special characters (injection prevention)', () => {
    expect(() => renderTemplate('var x = {{val}}', { val: 'OS.execute("rm", ["-rf"])' })).toThrow(/disallowed characters/);
  });

  it('rejects template variable values with semicolons', () => {
    expect(() => renderTemplate('var x = {{val}}', { val: '1; pass' })).toThrow(/disallowed characters/);
  });

  it('accepts template variable values with safe GDScript literals', () => {
    expect(renderTemplate('var x = {{val}}', { val: 'Vector3(1.0, 2.0, 3.0)' })).toBe('var x = Vector3(1.0, 2.0, 3.0)');
  });

  it('accepts template variable values with numbers and operators', () => {
    expect(renderTemplate('speed = {{spd}}', { spd: '300.0' })).toBe('speed = 300.0');
    expect(renderTemplate('offset = {{off}}', { off: '-10 + 5 * 2' })).toBe('offset = -10 + 5 * 2');
  });
});

// ─── 3. CharacterBody2D 模板 (T008) ──────────────────────────────────────────

describe('T008 CharacterBody2D 模板', () => {
  const tpl = TEMPLATES.find(t => t.id === 'T008');
  expect(tpl).toBeTruthy();

  it('generate 包含 extends CharacterBody2D', () => {
    expect(tpl.generate({}).includes('extends CharacterBody2D')).toBeTruthy();
  });

  it('generate 包含 move_and_slide', () => {
    expect(tpl.generate({}).includes('move_and_slide')).toBeTruthy();
  });

  it('自定义参数 speed 生效', () => {
    const code = tpl.generate({ speed: '500.0' });
    expect(code.includes('500.0')).toBeTruthy();
  });

  it('自定义参数 jump_velocity 生效', () => {
    const code = tpl.generate({ jump_velocity: '-600.0' });
    expect(code.includes('-600.0')).toBeTruthy();
  });
});

// ─── 4. StateMachine 模板 (T010) ─────────────────────────────────────────────

describe('T010 StateMachine 模板', () => {
  const tpl = TEMPLATES.find(t => t.id === 'T010');
  expect(tpl).toBeTruthy();

  it('generate 包含 enum State', () => {
    expect(tpl.generate({}).includes('enum State')).toBeTruthy();
  });

  it('generate 包含 match current_state', () => {
    expect(tpl.generate({}).includes('match current_state')).toBeTruthy();
  });

  it('默认状态列表包含 IDLE, RUN, JUMP', () => {
    const code = tpl.generate({});
    expect(code.includes('IDLE')).toBeTruthy();
    expect(code.includes('RUN')).toBeTruthy();
    expect(code.includes('JUMP')).toBeTruthy();
  });

  it('自定义状态列表生效', () => {
    const code = tpl.generate({ states: 'PATROL,CHASE,RETREAT' });
    expect(code.includes('PATROL')).toBeTruthy();
    expect(code.includes('CHASE')).toBeTruthy();
    expect(code.includes('RETREAT')).toBeTruthy();
    expect(code.includes('IDLE')).toBeFalsy();
  });
});

// ─── 5. getTemplateSuggestion ────────────────────────────────────────────────

describe('getTemplateSuggestion', () => {
  it('L001 返回包含 Camera3D 的代码', () => {
    const suggestion = getTemplateSuggestion('L001');
    expect(suggestion).toBeTruthy();
    expect(suggestion.includes('Camera3D')).toBeTruthy();
  });

  it('L999 返回 null（未知规则）', () => {
    expect(getTemplateSuggestion('L999')).toBe(null);
  });

  it('L002 返回包含 PhysicsMaterial 的代码', () => {
    const suggestion = getTemplateSuggestion('L002');
    expect(suggestion).toBeTruthy();
    expect(suggestion.includes('PhysicsMaterial')).toBeTruthy();
  });
});

// ─── 6. 用户模板加载 ─────────────────────────────────────────────────────────

describe('用户模板加载', () => {
  let tmpDir;

  beforeEach(() => {
    // 创建临时目录
    tmpDir = join(process.env.TEMP || '/tmp', `mcp-template-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // 清理临时目录
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('不存在 .mcp-templates/ 目录时返回空数组', () => {
    const result = loadUserTemplates(tmpDir);
    expect(result).toEqual([]);
  });

  it('有效 JSON 模板正确加载且 generate 可替换变量', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    const userTemplate = {
      id: 'user-001',
      name: '自定义模板',
      description: '测试用',
      code: 'var {{name}} := {{value}}',
      variables: [
        { name: 'name', type: 'string', default: 'my_var' },
        { name: 'value', type: 'string', default: '42' },
      ],
    };
    writeFileSync(join(tplDir, 'custom.json'), JSON.stringify(userTemplate), 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('user-001');

    const code = result[0].generate({ name: 'health', value: '100' });
    expect(code).toBe('var health := 100');
  });

  it('无效 JSON 文件被跳过，不崩溃', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    writeFileSync(join(tplDir, 'broken.json'), '这不是合法 JSON!!!', 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(0);
  });

  it('缺少必填字段的 JSON 被跳过', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    // 缺少 name 字段
    writeFileSync(join(tplDir, 'no-name.json'), JSON.stringify({
      id: 'x',
      code: 'pass',
    }), 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(0);
  });

  it('getAllTemplates 合并内置 + 用户模板', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    const userTemplate = {
      id: 'user-merge',
      name: '合并测试',
      description: '测试合并',
      code: 'extends Node',
    };
    writeFileSync(join(tplDir, 'merge.json'), JSON.stringify(userTemplate), 'utf-8');

    const all = getAllTemplates(tmpDir);
    // 内置模板 + 1 个用户模板
    expect(all.length > TEMPLATES.length).toBeTruthy();
    expect(all.some(t => t.id === 'user-merge')).toBeTruthy();
    expect(all.some(t => t.id === 'T001')).toBeTruthy();
  });

  it('getAllTemplates 无 projectPath 时只返回内置模板', () => {
    const all = getAllTemplates();
    expect(all.length).toBe(TEMPLATES.length);
  });

  it('用户模板覆盖同名内置模板', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    const override = {
      id: 'T001',
      name: '覆盖 T001',
      description: '用户覆盖内置',
      code: '# 覆盖版本',
    };
    writeFileSync(join(tplDir, 'override.json'), JSON.stringify(override), 'utf-8');

    const all = getAllTemplates(tmpDir);
    const t001 = all.find(t => t.id === 'T001');
    expect(t001).toBeTruthy();
    expect(t001.name).toBe('覆盖 T001');
  });

  it('variables 为非数组时模板被跳过', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    writeFileSync(join(tplDir, 'bad-vars.json'), JSON.stringify({
      id: 'bad-vars',
      name: '坏变量',
      description: '变量不是数组',
      code: 'pass',
      variables: 'not-an-array',
    }), 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(0);
  });

  it('tags 为非数组时模板被跳过', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    writeFileSync(join(tplDir, 'bad-tags.json'), JSON.stringify({
      id: 'bad-tags',
      name: '坏标签',
      description: '标签不是数组',
      code: 'pass',
      tags: 123,
    }), 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(0);
  });

  it('appliesTo 为非数组时模板被跳过', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    writeFileSync(join(tplDir, 'bad-applies.json'), JSON.stringify({
      id: 'bad-applies',
      name: '坏适用范围',
      description: 'appliesTo 不是数组',
      code: 'pass',
      appliesTo: 'not-an-array',
    }), 'utf-8');

    const result = loadUserTemplates(tmpDir);
    expect(result.length).toBe(0);
  });
});
