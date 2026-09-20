// test/tools/translation-ops.test.ts — W10 批4 组B:翻译文件解析/序列化/注册纯函数单测
// 覆盖:CSV RFC4180 解析(引号内逗号/换行/双引号转义/CRLF/空行)、往返一致性、
// CSV/PO 头校验、PO 转义(N-1 单遍)、project.godot 注册三分支(已有行/有段无行/无段)。
// 诚实边界:handleTool 的文件读写编排(路径白名单/existsSync 分支)未覆盖——依赖 fs mock 面大,
// 核心风险(格式解析正确性)已由本文件锁定。
import { describe, it, expect, afterAll } from 'vitest';
import {
  parseCsvRecords, serializeCsvLine, parseTranslationCsv, serializeTranslationCsv,
  parseTranslationPo, registerTranslationsInProjectGodot,
} from '../../src/tools/translation-ops.js';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('parseCsvRecords(RFC 4180)', () => {
  it('基本逗号分隔 + 跳过空行 + 末条无换行也入列', () => {
    expect(parseCsvRecords('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsvRecords('a,b\n\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsvRecords('solo')).toEqual([['solo']]);
    expect(parseCsvRecords('')).toEqual([]);
  });
  it('引号内逗号/换行/双引号转义按字段内容保留', () => {
    const rows = parseCsvRecords('"x,1","line1\nline2","say ""hi""",plain');
    expect(rows).toEqual([['x,1', 'line1\nline2', 'say "hi"', 'plain']]);
  });
  it('CRLF 行尾按一条记录', () => {
    expect(parseCsvRecords('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('serializeCsvLine + 往返', () => {
  it('含逗号/引号/换行的字段加引号并转义;普通字段裸输出', () => {
    expect(serializeCsvLine(['plain', 'a,b', 'q"uote', 'l1\nl2'])).toBe('plain,"a,b","q""uote","l1\nl2"');
  });
  it('parse∘serialize 往返一致', () => {
    const rows = [['keys', 'en', 'zh'], ['greet', 'hello, world', '你好'], ['multi', 'a"b', 'l1\nl2']];
    const text = rows.map(serializeCsvLine).join('\n');
    expect(parseCsvRecords(text)).toEqual(rows);
  });
});

describe('parseTranslationCsv', () => {
  it('首行 keys+语言,entries[key][lang];空 key 行跳过;缺列语言忽略', () => {
    const t = parseTranslationCsv('keys,en,zh\nhello,Hi,你好\n,,\nonly_en,Yes,');
    expect(t.format).toBe('csv');
    expect(t.languages).toEqual(['en', 'zh']);
    expect(t.entries.hello).toEqual({ en: 'Hi', zh: '你好' });
    expect(t.entries.only_en).toEqual({ en: 'Yes' });
    expect(t.entries['']).toBeUndefined();
  });
  it('空文件/头列不足/首列非 keys → 明确错误', () => {
    expect(() => parseTranslationCsv('')).toThrow('CSV file is empty');
    expect(() => parseTranslationCsv('only_one_column')).toThrow('at least one language');
    expect(() => parseTranslationCsv('id,en')).toThrow('first column must be "keys"');
  });
});

describe('parseTranslationPo', () => {
  it('msgid/msgstr 对 + 续行拼接 + Language header + 复数取 [0]', () => {
    const po = [
      'msgid ""',
      'msgstr "Language: fr\\n"',
      '',
      '# comment skipped',
      'msgid "greet"',
      'msgstr ""',
      '"bon"',
      '"jour"',
      '',
      'msgid "apple"',
      'msgid_plural "apples"',
      'msgstr[0] "une pomme"',
      'msgstr[1] "des pommes"',
    ].join('\n');
    const t = parseTranslationPo(po);
    expect(t.format).toBe('po');
    expect(t.language).toBe('fr');
    expect(t.entries.greet).toBe('bonjour');   // 续行拼接
    expect(t.entries.apple).toBe('une pomme'); // 复数取 [0],其余忽略
    expect(t.entries['']).toBeUndefined();      // header 空 msgid 删除
  });
  it('N-1 单遍转义:\\n 换行、\\t 制表、字面 C:\\\\new 不被误展开', () => {
    const t = parseTranslationPo('msgid "k"\nmsgstr "a\\nb\\tc:\\\\new d\\"q"');
    expect(t.entries.k).toBe('a\nb\tc:\\new d"q');
  });
});

describe('registerTranslationsInProjectGodot(三分支 + 幂等)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mcp-tr-'));
  const pg = join(tmp, 'project.godot');
  const write = (s: string) => writeFileSync(pg, s);

  it('分支① 已有 translations 行 → 合并去重', () => {
    write('[internationalization]\n\nlocale/translations=PackedStringArray("res://a.csv")\n');
    const r = registerTranslationsInProjectGodot(pg, ['res://b.csv', 'res://a.csv'], false);
    expect(r.changed).toBe(true);
    expect(r.translations.sort()).toEqual(['res://a.csv', 'res://b.csv']);
    expect(readFileSync(pg, 'utf-8')).toContain('"res://a.csv", "res://b.csv"');
    // 幂等:重复注册同批 → changed=false 不动文件
    const again = registerTranslationsInProjectGodot(pg, ['res://b.csv', 'res://a.csv'], false);
    expect(again.changed).toBe(false);
  });

  it('分支② 有 [internationalization] 段但无 translations 行 → 段内追加', () => {
    write('[internationalization]\nlocale/test=1\n\n[rendering]\n');
    const r = registerTranslationsInProjectGodot(pg, ['res://x.csv'], false);
    expect(r.changed).toBe(true);
    const out = readFileSync(pg, 'utf-8');
    const i18nIdx = out.indexOf('[internationalization]');
    const renderingIdx = out.indexOf('[rendering]');
    const lineIdx = out.indexOf('locale/translations=');
    expect(i18nIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(i18nIdx);
    expect(lineIdx).toBeLessThan(renderingIdx);
  });

  it('分支③ 无段 → 文件尾追加新段;remove=true 移除并清空', () => {
    write('[application]\nconfig/name="t"\n');
    const r = registerTranslationsInProjectGodot(pg, ['res://y.csv'], false);
    expect(r.changed).toBe(true);
    const out = readFileSync(pg, 'utf-8');
    expect(out).toContain('[internationalization]');
    expect(out).toContain('"res://y.csv"');

    const rm = registerTranslationsInProjectGodot(pg, ['res://y.csv'], true);
    expect(rm.changed).toBe(true);
    expect(rm.translations).toEqual([]);
    expect(readFileSync(pg, 'utf-8')).toContain('PackedStringArray()');
  });

  it('未变更(remove 不存在的路径)→ changed=false', () => {
    write('[internationalization]\n\nlocale/translations=PackedStringArray("res://keep.csv")\n');
    const r = registerTranslationsInProjectGodot(pg, ['res://absent.csv'], true);
    expect(r.changed).toBe(false);
    expect(r.translations).toEqual(['res://keep.csv']);
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});
