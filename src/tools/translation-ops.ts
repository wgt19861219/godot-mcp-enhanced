/**
 * translation 工具 — 翻译文件读写/注册(P1-2,2026-08-19)
 *
 * 对标 yanhuifair 翻译域 8 工具的精简版(3 op),覆盖本地化主流程:
 * - translation_read      读 CSV(Godot 国际化表格)/ PO(gettext)翻译条目
 * - translation_write     写/创建 Godot 兼容 CSV 翻译表(key + 每语言一列)
 * - translation_register  把 .translation/.po 资源注册进 project.godot
 *                         (internationalization/locale/translations)
 *
 * 纯 TS 实现(不走 Godot 进程):CSV/PO 是纯文本格式,TS 解析比 headless GDScript
 * 更直接;project.godot 是 ConfigFile 文本,原子读写。
 * 诚实边界:CSV → .translation 的编译由 Godot 编辑器导入器完成(编辑器打开项目时
 * 自动进行),本工具不代做;register 直接接受 .po(Godot 4 原生 TranslationLoaderPO)
 * 与 .translation。
 *
 * 路径安全:全部文件操作过 resolveWithinRoot(project 根内解析 + realpath 纵深),
 * 对齐 script.ts write_script 模式(文件路径参数白名单教训:dispatcher 只校验根级
 * 字段,工具内文件 IO 必须自校验)。
 */
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { writeFileAtomic } from '../core/fs-atomic.js';
import { dirname, join } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage, textResult } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../core/path-utils.js';
import { opsErrorResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_FORMAT: 'INVALID_FORMAT',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  IO_FAILED: 'IO_FAILED',
} as const;

const ACTIONS = ['translation_read', 'translation_write', 'translation_register'] as const;

/** register 允许的翻译资源扩展(Godot 可直接 load 为 Translation 的;
 *  write 仅 .csv(PO 写入复杂度不值当,交给 gettext 工具/编辑器) */
const REGISTER_EXTENSIONS = ['.translation', '.po'];

// ─── CSV(RFC 4180,Godot 国际化表格格式) ─────────────────────────────────

/**
 * 字符级状态机解析整个 CSV 文档为记录数组。
 * I-1(2026-08-19 审查):引号内的 \r\n 是字段内容而非记录分隔(RFC 4180)——
 * 按行 split 会把 serializeCsvLine 写出的含换行字段拆成错位记录(write→read 往返损坏)。
 */
export function parseCsvRecords(content: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch; // 含 \n \r:引号内换行是字段内容
      }
    } else if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
      fieldStarted = false;
    } else if (ch === '\n') {
      // 记录结束(\r\n 的 \r 已跳过)
      fields.push(cur);
      if (!(fields.length === 1 && fields[0] === '' && !fieldStarted)) records.push(fields);
      fields = [];
      cur = '';
      fieldStarted = false;
    } else if (ch === '\r') {
      // 等待配对的 \n; lone \r 也当记录分隔由上面的 \n 分支不可达——保守跳过
      if (content[i + 1] !== '\n') {
        fields.push(cur);
        if (!(fields.length === 1 && fields[0] === '' && !fieldStarted)) records.push(fields);
        fields = [];
        cur = '';
        fieldStarted = false;
      }
    } else {
      cur += ch;
      fieldStarted = true;
    }
  }
  // 末条无换行结尾的记录
  if (cur !== '' || fields.length > 0 || fieldStarted) {
    fields.push(cur);
    records.push(fields);
  }
  return records;
}

/** 序列化单行 CSV(引号包裹含逗号/引号/换行的字段) */
export function serializeCsvLine(fields: string[]): string {
  return fields.map(f => {
    if (/[",\r\n]/.test(f)) return '"' + f.replace(/"/g, '""') + '"';
    return f;
  }).join(',');
}

export interface CsvTranslation {
  format: 'csv';
  languages: string[];
  /** entries[key][lang] = text */
  entries: Record<string, Record<string, string>>;
}

/** 解析 Godot CSV 翻译表:首行 `keys,lang1,lang2,...`(引号内换行字段按 RFC 4180 保留) */
export function parseTranslationCsv(content: string): CsvTranslation {
  const records = parseCsvRecords(content);
  if (records.length === 0) throw new Error('CSV file is empty');
  const header = records[0]!;
  if (header.length < 2) throw new Error('CSV header must have a keys column plus at least one language column');
  if (header[0] !== 'keys') throw new Error(`CSV header first column must be "keys", got: ${header[0]}`);
  const languages = header.slice(1);
  const entries: Record<string, Record<string, string>> = {};
  for (let i = 1; i < records.length; i++) {
    const cols = records[i]!;
    const key = cols[0];
    if (!key) continue;
    const row: Record<string, string> = {};
    languages.forEach((lang, li) => {
      const v = cols[li + 1];
      if (v !== undefined && v !== '') row[lang] = v;
    });
    entries[key] = row;
  }
  return { format: 'csv', languages, entries };
}

export function serializeTranslationCsv(languages: string[], entries: Record<string, Record<string, string>>): string {
  const lines = [serializeCsvLine(['keys', ...languages])];
  for (const [key, values] of Object.entries(entries)) {
    lines.push(serializeCsvLine([key, ...languages.map(l => values[l] ?? '')]));
  }
  return lines.join('\n') + '\n';
}

// ─── PO(gettext 精简解析:msgid/msgstr 对 + Language header) ───────────────

export interface PoTranslation {
  format: 'po';
  language: string | null;
  /** entries[key] = text(取 msgid[0]/msgid_plural 的 msgstr[0],复数其余忽略) */
  entries: Record<string, string>;
}

export function parseTranslationPo(content: string): PoTranslation {
  const entries: Record<string, string> = {};
  let language: string | null = null;
  let curMsgid: string | null = null;
  let curStr: string[] = [];
  let inMsgid = false;
  let inMsgstr = false;

  const flush = () => {
    if (curMsgid !== null && curStr.length > 0) {
      entries[curMsgid] = curStr.join('');
    }
    curMsgid = null;
    curStr = [];
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('msgid ')) {
      flush();
      curMsgid = unquotePo(line.slice('msgid '.length));
      inMsgid = true; inMsgstr = false;
    } else if (line.startsWith('msgstr')) {
      inMsgid = false; inMsgstr = true;
      // msgstr "..." / msgstr[0] "..." 行内文本收集;msgstr[1+](复数其余形式)忽略
      const m = line.match(/^msgstr(?:\[0\])?\s+(.+)$/);
      if (m) curStr.push(unquotePo(m[1]!));
    } else if (line.startsWith('"')) {
      const text = unquotePo(line);
      if (inMsgid && curMsgid !== null) {
        curMsgid += text;
      } else if (inMsgstr) {
        curStr.push(text);
      }
    }
  }
  flush();

  // Language header 在 msgid "" 的 msgstr 里("Language: fr\n")
  const headerStr = content.match(/msgstr\s+(?:"(?:[^"\\]|\\.)*"\s*)+/);
  if (headerStr) {
    const langMatch = unquotePoMulti(headerStr[0]).match(/Language:\s*([^\s\\]+)/);
    if (langMatch) language = langMatch[1]!;
  }
  if (entries[''] !== undefined) delete entries[''];
  return { format: 'po', language, entries };
}

function unquotePo(token: string): string {
  const m = token.match(/^"(.*)"$/);
  if (!m) return token;
  // N-1(2026-08-19 审查):单遍转义——\\n 必须先于 \\ 之外处理,链式 replace 会把
  // 字面反斜杠序列(C:\\new → "C:\\\\new")错误变成换行
  return m[1]!.replace(/\\(.)/g, (_, c: string) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    return c; // \" → " , \\ → \ ,其他 \<x> → x(gettext 未定义转义保守取字面)
  });
}

/** 把 msgstr 的多个 "..." 段拼起来 */
function unquotePoMulti(block: string): string {
  const parts = block.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  return parts.map(p => unquotePo(p)).join('');
}

// ─── project.godot 注册(ConfigFile 文本,原子写) ──────────────────────────

const TRANSLATIONS_LINE_RE = /^(locale\/translations=)(PackedStringArray\((.*)\))\s*$/;

/**
 * 把翻译资源路径合并进 project.godot 的 internationalization/locale/translations。
 * 已有行 → 合并去重;有 [internationalization] 段无该行 → 段内追加;都无 → 追加段。
 * 原子写(tmp + rename),未变更时不动文件。
 * @returns 变更后的翻译数组(res:// 路径)
 */
export function registerTranslationsInProjectGodot(
  projectGodotPath: string, resPaths: string[], remove: boolean,
): { changed: boolean; translations: string[] } {
  const original = readFileSync(projectGodotPath, 'utf-8');
  const lines = original.split(/\r?\n/);

  let lineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TRANSLATIONS_LINE_RE.test(lines[i]!.trim())) { lineIdx = i; break; }
  }

  let current: string[] = [];
  if (lineIdx >= 0) {
    const m = lines[lineIdx]!.trim().match(TRANSLATIONS_LINE_RE);
    const arrBody = m![3]!;
    current = (arrBody.match(/res:\/\/[^"]+/g)) ?? [];
  }

  const before = [...current].sort().join('\n');
  if (remove) {
    const removeSet = new Set(resPaths);
    current = current.filter(p => !removeSet.has(p));
  } else {
    for (const p of resPaths) {
      if (!current.includes(p)) current.push(p);
    }
  }
  const after = [...current].sort().join('\n');
  if (before === after) return { changed: false, translations: current };

  const newLine = `locale/translations=PackedStringArray(${current.map(p => `"${p}"`).join(', ')})`;
  if (lineIdx >= 0) {
    lines[lineIdx] = newLine;
  } else {
    // 找 [internationalization] 段(或其别名 [internationalization])追加;没有则加段
    let sectionIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === '[internationalization]') { sectionIdx = i; break; }
    }
    if (sectionIdx >= 0) {
      // 插到该段最后一行(下一段前)
      let insertAt = sectionIdx + 1;
      while (insertAt < lines.length && !lines[insertAt]!.startsWith('[')) insertAt++;
      // 跳过段内尾部空行
      while (insertAt > sectionIdx + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
      lines.splice(insertAt, 0, '', newLine);
    } else {
      // 追加段到文件尾(保尾部换行结构)
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      lines.push('', '[internationalization]', '', newLine);
    }
  }

  const content = lines.join('\n');
  // A-ATOMIC 存量收口:project.godot 覆盖走共享原子写(替换原自写 tmp+Date.now 后缀)
  writeFileAtomic(projectGodotPath, content.endsWith('\n') ? content : content + '\n');
  return { changed: true, translations: current };
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'translation',
      description: `翻译文件管理。read: 读 CSV/PO 翻译条目(语言/键值对)。write: 写/创建 Godot 兼容 CSV 翻译表(key + 每语言一列;CSV→.translation 编译由编辑器导入完成)。register: 把 .translation/.po 注册进 project.godot(translations 数组,remove=true 反向移除)。`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。translation_read/translation_write=读/写翻译文件(.csv/.po), translation_register=注册语言',
          },
          path: { type: 'string', description: 'read/write: 翻译文件路径(res:// 相对,read 支持 .csv/.po,write 仅 .csv)' },
          languages: { type: 'array', items: { type: 'string' }, description: 'write: 语言代码列表(如 [en, zh_CN],与 entries 键对应)' },
          entries: { type: 'object', description: 'write: {key: {语言: 文本}} 条目对象' },
          paths: { type: 'array', items: { type: 'string' }, description: 'register: 翻译资源路径列表(res:// 相对,支持 .translation/.po)' },
          remove: { type: 'boolean', description: 'register: true=从注册表移除(默认 false=注册)' },
          limit: { type: 'number', description: 'read: 条目返回上限(默认 200,防大文件撑爆上下文)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

function resolveTranslationPath(projectPath: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('path is required');
  }
  return resolveWithinRoot(projectPath, normalizeUserProjectPath(rawPath));
}

function validateLanguageCode(lang: unknown): string {
  const s = String(lang ?? '').trim();
  if (!/^[a-zA-Z_]{2,3}([_-][a-zA-Z0-9]{2,4}(@[a-zA-Z0-9]+)?)?$/.test(s)) {
    throw new Error(`invalid language code: ${s}(示例: en, zh_CN, pt_BR)`);
  }
  return s;
}

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'translation') return null;

  const action = args.action as string;
  if (!action) return opsError('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);

    switch (action) {
      case 'translation_read': {
        const absPath = resolveTranslationPath(projectPath, args.path);
        if (!existsSync(absPath)) return opsError('FILE_NOT_FOUND', `file not found: ${args.path}`);
        const content = readFileSync(absPath, 'utf-8');
        const lower = absPath.toLowerCase();
        const limitRaw = typeof args.limit === 'number' ? args.limit : 200;
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 2000 ? limitRaw : 200;

        if (lower.endsWith('.csv')) {
          const parsed = parseTranslationCsv(content);
          const keys = Object.keys(parsed.entries);
          const truncated: Record<string, Record<string, string>> = {};
          for (const k of keys.slice(0, limit)) truncated[k] = parsed.entries[k]!;
          return okJson({
            format: 'csv', languages: parsed.languages,
            entry_count: keys.length, truncated: keys.length > limit, entries: truncated,
          });
        }
        if (lower.endsWith('.po')) {
          const parsed = parseTranslationPo(content);
          const keys = Object.keys(parsed.entries);
          const truncated: Record<string, string> = {};
          for (const k of keys.slice(0, limit)) truncated[k] = parsed.entries[k]!;
          return okJson({
            format: 'po', language: parsed.language,
            entry_count: keys.length, truncated: keys.length > limit, entries: truncated,
          });
        }
        return opsError('INVALID_FORMAT', 'read supports .csv and .po only');
      }

      case 'translation_write': {
        const absPath = resolveTranslationPath(projectPath, args.path);
        if (!absPath.toLowerCase().endsWith('.csv')) {
          return opsError('INVALID_FORMAT', 'write supports .csv only(PO 写入用编辑器或 gettext 工具)');
        }
        const languagesRaw = args.languages;
        if (!Array.isArray(languagesRaw) || languagesRaw.length === 0) {
          return opsError('INVALID_PARAMS', 'languages is required (array of language codes)');
        }
        const languages = languagesRaw.map(validateLanguageCode);
        const entries = args.entries;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          return opsError('INVALID_PARAMS', 'entries is required ({key: {lang: text}})');
        }
        const entryObj: Record<string, Record<string, string>> = {};
        for (const [key, values] of Object.entries(entries as Record<string, unknown>)) {
          if (typeof key !== 'string' || key === '' || key.includes('"') || /[\r\n]/.test(key)) {
            return opsError('INVALID_PARAMS', `invalid translation key: ${JSON.stringify(key)}`);
          }
          if (!values || typeof values !== 'object') {
            return opsError('INVALID_PARAMS', `entries[${JSON.stringify(key)}] must be an object`);
          }
          const row: Record<string, string> = {};
          for (const [lang, text] of Object.entries(values as Record<string, unknown>)) {
            if (!languages.includes(lang)) {
              return opsError('INVALID_PARAMS', `entries[${JSON.stringify(key)}] references language "${lang}" not in languages list`);
            }
            if (typeof text !== 'string') {
              return opsError('INVALID_PARAMS', `entries[${JSON.stringify(key)}][${lang}] must be a string`);
            }
            row[lang] = text;
          }
          entryObj[key] = row;
        }
        const csv = serializeTranslationCsv(languages, entryObj);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileAtomic(absPath, csv);  // A-ATOMIC 存量收口
        return okJson({ written: absPath, languages, entry_count: Object.keys(entryObj).length, bytes: Buffer.byteLength(csv, 'utf-8') });
      }

      case 'translation_register': {
        const pathsRaw = args.paths;
        if (!Array.isArray(pathsRaw) || pathsRaw.length === 0 || pathsRaw.length > 50) {
          return opsError('INVALID_PARAMS', 'paths must be an array of 1-50 entries');
        }
        const remove = args.remove === true;
        const resPaths: string[] = [];
        for (const p of pathsRaw) {
          const s = String(p ?? '');
          if (!s.startsWith('res://')) {
            return opsError('INVALID_PARAMS', `paths entries must start with res://, got: ${s}`);
          }
          const absPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(s));
          if (!absPath.toLowerCase().match(/\.(translation|po)$/)) {
            return opsError('INVALID_FORMAT', `register supports ${REGISTER_EXTENSIONS.join('/')} only, got: ${s}`);
          }
          if (!remove && !existsSync(absPath)) {
            return opsError('FILE_NOT_FOUND', `file not found: ${s}`);
          }
          resPaths.push(s);
        }
        const projectGodot = join(projectPath, 'project.godot');
        if (!existsSync(projectGodot)) {
          return opsError('FILE_NOT_FOUND', 'project.godot not found in project root');
        }
        const result = registerTranslationsInProjectGodot(projectGodot, resPaths, remove);
        return okJson({
          action: remove ? 'unregister' : 'register',
          changed: result.changed,
          translations: result.translations,
          note: result.changed ? undefined : 'no change (already registered / not present)',
        });
      }

      default:
        return opsError('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('Path traversal')) return opsError('INVALID_PARAMS', msg);
    return opsError(ERROR_CODES.IO_FAILED, msg);
  }
}

// ─── 结果构造(与 opsErrorResult 对齐的薄封装) ─────────────────────────────

function opsError(code: string, message: string): ToolResult {
  return opsErrorResult(code, message);
}

function okJson(data: unknown): ToolResult {
  return textResult(JSON.stringify({ success: true, data, warnings: [] }));
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  translation: {
    readonly: false,
    long_running: false,
    actionRisks: {
      translation_read: 'read', translation_write: 'write', translation_register: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
