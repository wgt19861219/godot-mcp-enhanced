import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEMPLATES,
  getTemplateSuggestion,
  renderTemplate,
  getAllTemplates,
  loadUserTemplates,
} from '../build/tools/code-templates.js';

// ─── 1. 内置模板 ─────────────────────────────────────────────────────────────

describe('内置模板', () => {
  it('至少有 10 个模板', () => {
    assert.ok(TEMPLATES.length >= 10, `实际只有 ${TEMPLATES.length} 个模板`);
  });

  it('每个模板包含 id / name / description / generate 函数', () => {
    for (const tpl of TEMPLATES) {
      assert.ok(tpl.id, `模板缺少 id`);
      assert.ok(tpl.name, `模板 ${tpl.id} 缺少 name`);
      assert.ok(tpl.description, `模板 ${tpl.id} 缺少 description`);
      assert.equal(typeof tpl.generate, 'function', `模板 ${tpl.id} 缺少 generate 函数`);
    }
  });

  it('每个模板 id 唯一', () => {
    const ids = TEMPLATES.map(t => t.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `存在重复 id: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it('每个模板 generate({}) 返回非空字符串', () => {
    for (const tpl of TEMPLATES) {
      const code = tpl.generate({});
      assert.ok(typeof code === 'string' && code.length > 0, `模板 ${tpl.id} generate({}) 返回空`);
    }
  });
});

// ─── 2. 模板渲染 ─────────────────────────────────────────────────────────────

describe('renderTemplate', () => {
  it('替换单个变量', () => {
    assert.equal(
      renderTemplate('var speed = {{speed}}', { speed: '300' }),
      'var speed = 300',
    );
  });

  it('未替换的占位符保持不变', () => {
    assert.equal(
      renderTemplate('var x = {{x}}, y = {{y}}', { x: '1' }),
      'var x = 1, y = {{y}}',
    );
  });

  it('多次出现全部替换', () => {
    assert.equal(
      renderTemplate('{{v}} + {{v}} = {{result}}', { v: '2', result: '4' }),
      '2 + 2 = 4',
    );
  });

  it('无占位符的字符串原样返回', () => {
    assert.equal(renderTemplate('extends Node3D', {}), 'extends Node3D');
  });

  it('rejects template variable values with special characters (injection prevention)', () => {
    assert.throws(
      () => renderTemplate('var x = {{val}}', { val: 'OS.execute("rm", ["-rf"])' }),
      /disallowed characters/,
    );
  });

  it('rejects template variable values with semicolons', () => {
    assert.throws(
      () => renderTemplate('var x = {{val}}', { val: '1; pass' }),
      /disallowed characters/,
    );
  });

  it('accepts template variable values with safe GDScript literals', () => {
    assert.equal(
      renderTemplate('var x = {{val}}', { val: 'Vector3(1.0, 2.0, 3.0)' }),
      'var x = Vector3(1.0, 2.0, 3.0)',
    );
  });

  it('accepts template variable values with numbers and operators', () => {
    assert.equal(
      renderTemplate('speed = {{spd}}', { spd: '300.0' }),
      'speed = 300.0',
    );
    assert.equal(
      renderTemplate('offset = {{off}}', { off: '-10 + 5 * 2' }),
      'offset = -10 + 5 * 2',
    );
  });
});

// ─── 3. CharacterBody2D 模板 (T008) ──────────────────────────────────────────

describe('T008 CharacterBody2D 模板', () => {
  const tpl = TEMPLATES.find(t => t.id === 'T008');
  assert.ok(tpl, '找不到 T008');

  it('generate 包含 extends CharacterBody2D', () => {
    assert.ok(tpl.generate({}).includes('extends CharacterBody2D'));
  });

  it('generate 包含 move_and_slide', () => {
    assert.ok(tpl.generate({}).includes('move_and_slide'));
  });

  it('自定义参数 speed 生效', () => {
    const code = tpl.generate({ speed: '500.0' });
    assert.ok(code.includes('500.0'), `应包含自定义 speed 值 500.0，实际: ${code}`);
  });

  it('自定义参数 jump_velocity 生效', () => {
    const code = tpl.generate({ jump_velocity: '-600.0' });
    assert.ok(code.includes('-600.0'), `应包含自定义 jump_velocity 值 -600.0，实际: ${code}`);
  });
});

// ─── 4. StateMachine 模板 (T010) ─────────────────────────────────────────────

describe('T010 StateMachine 模板', () => {
  const tpl = TEMPLATES.find(t => t.id === 'T010');
  assert.ok(tpl, '找不到 T010');

  it('generate 包含 enum State', () => {
    assert.ok(tpl.generate({}).includes('enum State'));
  });

  it('generate 包含 match current_state', () => {
    assert.ok(tpl.generate({}).includes('match current_state'));
  });

  it('默认状态列表包含 IDLE, RUN, JUMP', () => {
    const code = tpl.generate({});
    assert.ok(code.includes('IDLE'), '默认应包含 IDLE');
    assert.ok(code.includes('RUN'), '默认应包含 RUN');
    assert.ok(code.includes('JUMP'), '默认应包含 JUMP');
  });

  it('自定义状态列表生效', () => {
    const code = tpl.generate({ states: 'PATROL,CHASE,RETREAT' });
    assert.ok(code.includes('PATROL'), '自定义应包含 PATROL');
    assert.ok(code.includes('CHASE'), '自定义应包含 CHASE');
    assert.ok(code.includes('RETREAT'), '自定义应包含 RETREAT');
    assert.ok(!code.includes('IDLE'), '自定义后不应包含 IDLE');
  });
});

// ─── 5. getTemplateSuggestion ────────────────────────────────────────────────

describe('getTemplateSuggestion', () => {
  it('L001 返回包含 Camera3D 的代码', () => {
    const suggestion = getTemplateSuggestion('L001');
    assert.ok(suggestion, 'L001 应返回非 null');
    assert.ok(suggestion.includes('Camera3D'), `建议代码应包含 Camera3D`);
  });

  it('L999 返回 null（未知规则）', () => {
    assert.equal(getTemplateSuggestion('L999'), null);
  });

  it('L002 返回包含 PhysicsMaterial 的代码', () => {
    const suggestion = getTemplateSuggestion('L002');
    assert.ok(suggestion, 'L002 应返回非 null');
    assert.ok(suggestion.includes('PhysicsMaterial'));
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
    assert.deepEqual(result, []);
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
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'user-001');

    const code = result[0].generate({ name: 'health', value: '100' });
    assert.equal(code, 'var health := 100');
  });

  it('无效 JSON 文件被跳过，不崩溃', () => {
    const tplDir = join(tmpDir, '.mcp-templates');
    mkdirSync(tplDir, { recursive: true });

    writeFileSync(join(tplDir, 'broken.json'), '这不是合法 JSON!!!', 'utf-8');

    const result = loadUserTemplates(tmpDir);
    assert.equal(result.length, 0);
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
    assert.equal(result.length, 0);
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
    assert.ok(all.length > TEMPLATES.length, `总数应大于内置 ${TEMPLATES.length}，实际: ${all.length}`);
    assert.ok(all.some(t => t.id === 'user-merge'), '应包含用户模板 user-merge');
    assert.ok(all.some(t => t.id === 'T001'), '应保留内置模板 T001');
  });

  it('getAllTemplates 无 projectPath 时只返回内置模板', () => {
    const all = getAllTemplates();
    assert.equal(all.length, TEMPLATES.length);
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
    assert.ok(t001, 'T001 应存在');
    assert.equal(t001.name, '覆盖 T001');
  });
});
