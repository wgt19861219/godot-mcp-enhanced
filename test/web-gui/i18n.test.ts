// test/web-gui/i18n.test.ts
// i18n 批(2026-10-13)完整性门禁:字典双语对称 + 内联一致性 + 静态引用键有效性 +
// 切换机制接线。防两类漂移:①新增键漏译 en;②html.ts 手改内联 JSON(绕过 serializeI18nForInline)。
// 审查 Nit-2/3(2026-10-13)增强:portal HTML 同类扫描 + 命名空间键全形态扫描
// (对象形态 {key:'...'} 与三元第二分支等 t() 正则盲区)。
import { describe, it, expect } from 'vitest';
import { GUI_STRINGS, serializeI18nForInline, pickGuiLang } from '../../src/web-gui/i18n.js';
import { INDEX_HTML } from '../../src/web-gui/html.js';
import { buildPortalHtml } from '../../src/web-gui/portal.js';

/** 键命名空间前缀全集(与 i18n.ts GUI_STRINGS 的区域前缀一一对应)。 */
const KEY_NS = 'common|header|status|err|net|warn|proj|sess|inst|out|logs|stats|tab|files|preview|hex|ed|kb|set|time|lang|portal';

describe('GUI_STRINGS 双语字典完整性', () => {
  it('zh/en 两值均非空字符串(防漏译空值)', () => {
    for (const [k, v] of Object.entries(GUI_STRINGS)) {
      expect(v.zh, `键 ${k} 的 zh 为空`).not.toBe('');
      expect(v.en, `键 ${k} 的 en 为空`).not.toBe('');
    }
  });
  it('占位符 {name} 集合 zh/en 一致(防插值参数漂移)', () => {
    const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(',');
    for (const [k, v] of Object.entries(GUI_STRINGS)) {
      expect(ph(v.en), `键 ${k} 的 en 占位符与 zh 不一致`).toBe(ph(v.zh));
    }
  });
  it('serializeI18nForInline:全量内联含全部键的 zh/en;< 被转义(防 </script> 截断)', () => {
    const inline = serializeI18nForInline();
    expect(inline).not.toContain('<');
    const parsed = JSON.parse(inline.replace(/\\u003c/g, '<')) as { zh: Record<string, string>; en: Record<string, string> };
    expect(Object.keys(parsed.zh)).toEqual(Object.keys(parsed.en));
    expect(Object.keys(parsed.zh).length).toBe(Object.keys(GUI_STRINGS).length);
    for (const [k, v] of Object.entries(GUI_STRINGS)) {
      expect(parsed.zh[k]).toBe(v.zh);
      expect(parsed.en[k]).toBe(v.en);
    }
  });
  it('serializeI18nForInline(prefixes):portal 前缀过滤只含 portal/header 键', () => {
    const inline = serializeI18nForInline(['portal.', 'header.']);
    const parsed = JSON.parse(inline.replace(/\\u003c/g, '<')) as { zh: Record<string, string> };
    for (const k of Object.keys(parsed.zh)) {
      expect(k.startsWith('portal.') || k.startsWith('header.')).toBe(true);
    }
    expect(parsed.zh['portal.title']).toBeDefined();
  });
});

describe('INDEX_HTML i18n 接线', () => {
  it('内联字典与 GUI_STRINGS 逐字节一致(防手改内联 JSON 漂移)', () => {
    expect(INDEX_HTML).toContain('var I18N = ' + serializeI18nForInline() + ';');
  });
  it('静态段 data-i18n* 引用的键全部存在于字典(防引用悬空回落 key 本身)', () => {
    const refs = INDEX_HTML.match(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g) ?? [];
    expect(refs.length).toBeGreaterThan(20);   // 静态段抽取覆盖量量级检查
    const keys = refs.map(r => r.replace(/^[^"]+"/, '').replace(/"$/, ''));
    for (const k of keys) {
      expect(GUI_STRINGS[k], `静态引用键 ${k} 不在字典`).toBeDefined();
    }
  });
  it('命名空间键字面量全形态扫描:t() 调用/对象 {key:} 形态/三元分支(审查 Nit-3 盲区补防)', () => {
    // 匹配所有单引号包裹的 '<ns>.<name>' 字面量——覆盖 t('x')、{ key: 'x' }、
    // t(a ? 'x' : 'y') 双分支、kbTools actions 等一切引用形态;字典内联 JSON 为
    // 双引号不误匹配;'开发日志/' 等非键前缀串天然排除。
    const lits = INDEX_HTML.match(new RegExp(`'(?:${KEY_NS})\\.[a-z][a-z0-9.]*'`, 'g')) ?? [];
    expect(lits.length).toBeGreaterThan(80);   // 引用量级检查(t() 调用 + 对象/三元形态)
    for (const lit of lits) {
      const k = lit.slice(1, -1);
      expect(GUI_STRINGS[k], `键字面量 ${k} 不在字典(拼错将静默回落)`).toBeDefined();
    }
  });
  it('语言切换机制:localStorage 持久化 + reload 重建 + 切换按钮', () => {
    expect(INDEX_HTML).toContain("localStorage.getItem('gui-lang')");
    expect(INDEX_HTML).toContain("localStorage.setItem('gui-lang'");
    expect(INDEX_HTML).toContain('location.reload()');
    expect(INDEX_HTML).toContain('id="langBtn"');
    expect(INDEX_HTML).toContain("t('lang.switchTo')");
  });
  it('LANG 检测链:navigator.language zh* → zh,其余 en;localStorage 优先', () => {
    expect(INDEX_HTML).toContain("navigator.language || 'zh'");
    expect(INDEX_HTML).toContain("saved === 'zh' || saved === 'en'");
  });
  it('en 模式静态替换器 data-i18n 四变体齐备', () => {
    expect(INDEX_HTML).toContain("[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]");
    expect(INDEX_HTML).toContain('document.documentElement.lang');
    expect(INDEX_HTML).toContain("document.title = t('header.title')");
  });
  it('fetch 统一注入 accept-language=LANG(审查 Nit-1:手动切换后后端消息语言跟随)', () => {
    expect(INDEX_HTML).toContain("init.headers = Object.assign({}, init.headers, { 'accept-language': LANG });");
  });
});

describe('portal 入口页 i18n 接线(审查 Nit-2:零覆盖补防)', () => {
  const portalHtml = buildPortalHtml();
  it('内联字典为 portal/header 前缀过滤版,与 serializeI18nForInline 一致', () => {
    expect(portalHtml).toContain('var I18N = ' + serializeI18nForInline(['portal.', 'header.']) + ';');
  });
  it('静态 data-i18n 与 t() 键字面量全部在字典(拼错静默回落防线)', () => {
    const attrRefs = portalHtml.match(/data-i18n="([^"]+)"/g) ?? [];
    expect(attrRefs.length).toBeGreaterThanOrEqual(8);
    for (const r of attrRefs) {
      const k = r.replace(/^[^"]+"/, '').replace(/"$/, '');
      expect(GUI_STRINGS[k], `portal 静态引用键 ${k} 不在字典`).toBeDefined();
    }
    const lits = portalHtml.match(new RegExp(`'(?:${KEY_NS})\\.[a-z][a-z0-9.]*'`, 'g')) ?? [];
    expect(lits.length).toBeGreaterThanOrEqual(3);   // portal.scanDone/found/instance
    for (const lit of lits) {
      expect(GUI_STRINGS[lit.slice(1, -1)], `portal 键字面量 ${lit} 不在字典`).toBeDefined();
    }
  });
  it('navigator.language 自动检测 + zh 兜底文案在场(无手动切换的 file:// 页)', () => {
    expect(portalHtml).toContain("navigator.language || 'zh'");
    expect(portalHtml).toContain('正在扫描本机面板服务');   // zh 兜底(HTML 原文)
  });
});

describe('pickGuiLang(Accept-Language 解析,后端消息语言判定)', () => {
  it('zh* 前缀 → zh;其余/缺省 → en/zh 默认语义', () => {
    expect(pickGuiLang('zh-CN,zh;q=0.9')).toBe('zh');
    expect(pickGuiLang('zh_TW')).toBe('zh');
    expect(pickGuiLang('en-US,en;q=0.9')).toBe('en');
    expect(pickGuiLang('ja')).toBe('en');
    expect(pickGuiLang(undefined)).toBe('zh');   // 无头客户端无头时缺省 zh(与既有中文默认一致)
    expect(pickGuiLang('')).toBe('zh');
    expect(pickGuiLang('  zh')).toBe('zh');      // 前导空白容错
  });
});
