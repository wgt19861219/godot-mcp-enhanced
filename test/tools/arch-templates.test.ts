import { describe, it, expect } from 'vitest';
import { ARCHITECTURE_TEMPLATES } from '../../src/tools/code-templates.js';

describe('ARCHITECTURE_TEMPLATES', () => {
  const templateIds = Object.keys(ARCHITECTURE_TEMPLATES);

  it('应包含 4 种设计模式', () => {
    expect(templateIds).toContain('observer-pattern');
    expect(templateIds).toContain('state-machine');
    expect(templateIds).toContain('component-system');
    expect(templateIds).toContain('event-bus');
  });

  it('每个模板应有 id、name、generate 函数', () => {
    for (const tmpl of Object.values(ARCHITECTURE_TEMPLATES)) {
      expect(tmpl.id).toBeTruthy();
      expect(tmpl.name).toBeTruthy();
      expect(typeof tmpl.generate).toBe('function');
      expect(tmpl.generate({})).toContain('extends');
    }
  });

  it('observer-pattern 应包含 signal 定义', () => {
    const code = ARCHITECTURE_TEMPLATES['observer-pattern'].generate({ signal_name: 'score_changed' });
    expect(code).toContain('signal');
  });

  it('state-machine 应包含 state 枚举', () => {
    const code = ARCHITECTURE_TEMPLATES['state-machine'].generate({ states: 'idle,run,jump' });
    expect(code).toContain('enum');
  });

  it('event-bus 应包含单例模式', () => {
    const code = ARCHITECTURE_TEMPLATES['event-bus'].generate({});
    expect(code).toContain('static');
  });
});
