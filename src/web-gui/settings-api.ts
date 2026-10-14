// src/web-gui/settings-api.ts
// web-gui 设置面板纯逻辑层(2026-09-29 设置批,files-api.ts 同模式):
// GET 视图组装(persisted + effective + 候选)/ verify(跑 --version 验证+版本检测)/
// save(校验 → 读改写 merge → 持久化+热生效 → 机器级审计)。
// 持久化与热生效原语在 core/user-settings.ts;本层只做校验/组装/留痕。
// 审计走机器级(appendMachineAuditLine):机器级设置(影响全部工具行为)无项目可归属,
// 对齐 audit-helper 批6-N-e「无项目可归属的安全事件语义归机器」先例。

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { readUserSettings, writeUserSettings, applyUserSettings, getUserSettingsFile, type UserSettings } from '../core/user-settings.js';
import { validateGodotBinaryDetailed, detectGodotVersion, readGodotPathsConfig } from '../core/godot-finder.js';
import { getAllowedProjectPaths } from '../core/path-utils.js';
import { appendMachineAuditLine, isAuditEnabled, recordAuditWriteFailure } from '../core/audit-log.js';
import { getLogger } from '../core/logger.js';
import { guiText, type GuiLang } from './i18n.js';

/** 校验失败 stage → 人话错误键(不含路径,PII-safe;前端直接展示)。
 *  注:version-run-failed/not-godot-signature 两行经 normalizeGodotStage 的 UNSTABLE 集
 *  先行归一后不可达,保留作 UNSTABLE 集未来收窄时的回落文案(审查 Nit-1)。
 *  i18n 批(2026-10-13):值从内联中文改为 i18n.ts 字典键,按 lang 取双语。 */
const GODOT_STAGE_MESSAGE_KEYS: Record<string, string> = {
  'path-not-allowed': 'set.stage.path-not-allowed',
  'is-directory': 'set.stage.is-directory',
  'version-run-failed': 'set.stage.version-run-failed',
  'not-godot-signature': 'set.stage.not-godot-signature',
};

/** 不稳定 stage 集(2026-10-01 真机验证 NIT-2):godot-finder 的 version-run-failed 与
 *  not-godot-signature 对同一非法二进制可能非确定出现(实测 cmd.exe 间歇 exit 0 空输出
 *  → not-godot-signature,复跑 exit 1 → version-run-failed)。两路均正确拒绝,但面板
 *  对同一输入的可见 stage/文案漂移。面板层归一为单一 stage 'not-a-godot-binary' +
 *  稳定文案;godot-finder 原始 stage 不动(其余调用方与单测锁定其语义)。 */
const UNSTABLE_GODOT_STAGES: ReadonlySet<string> = new Set(['version-run-failed', 'not-godot-signature']);
const NOT_A_GODOT_BINARY_KEY = 'set.stage.not-a-godot-binary';

/** 面板层 stage 归一:不稳定集合并为 'not-a-godot-binary';其余原样映射。 */
function normalizeGodotStage(stage: string, lang: GuiLang): { stage: string; message: string } {
  if (UNSTABLE_GODOT_STAGES.has(stage)) return { stage: 'not-a-godot-binary', message: guiText(lang, NOT_A_GODOT_BINARY_KEY) };
  const key = GODOT_STAGE_MESSAGE_KEYS[stage];
  return { stage, message: key ? guiText(lang, key) : stage };
}

export interface SettingsView {
  persisted: { godotPath: string; allowedProjectPaths: string[]; vaultPath: string };
  effective: {
    godotPath: string;
    allowedProjectPaths: string[];
    unrestricted: boolean;
    godotAllowedList: string;
    vaultPath: string;
  };
  /** godot-paths.json 已登记候选(CLI install 写入;只读点选,本批不做增删)。 */
  candidates: string[];
  readOnly: boolean;
}

export interface SettingsSavePatch {
  /** Godot 可执行路径;'' = 清除(恢复启动 env 快照);undefined = 不改。 */
  godotPath?: string;
  /** 项目白名单根数组;[] = 清除;undefined = 不改。 */
  allowedProjectPaths?: string[];
  /** Obsidian vault 根目录;'' = 清除;undefined = 不改。(2026-10-08 知识库联动批) */
  vaultPath?: string;
}

export type SettingsSaveResult =
  | { ok: true; persisted: SettingsView['persisted'] }
  | { ok: false; error: string; stage?: string };

export type SettingsVerifyResult =
  | { ok: true; version: string }
  | { ok: false; stage: string; detail: string };

export interface SettingsApi {
  get(): Promise<SettingsView>;
  /** lang(2026-10-13 i18n 批):错误 detail 的展示语言,缺省 zh;接线层按请求
   *  Accept-Language 传入——service 是每 server 一个,语言是每请求一个,故走方法
   *  参数而非构造器注入。 */
  verify(path: string, lang?: GuiLang): Promise<SettingsVerifyResult>;
  save(patch: SettingsSavePatch, lang?: GuiLang): Promise<SettingsSaveResult>;
}

export interface UserSettingsServiceOpts {
  /** settings.json 目录注入(测试隔离);缺省 ~/.godot-mcp/ */
  settingsDir?: string;
  /** READ_ONLY 判定注入(接线层传,与 server.ts isReadOnly 同源);缺省非只读。 */
  isReadOnly?: () => boolean;
}

export class UserSettingsService implements SettingsApi {
  private readonly settingsDir: string | undefined;
  private readonly readOnlyFn: (() => boolean) | undefined;

  constructor(opts: UserSettingsServiceOpts = {}) {
    this.settingsDir = opts.settingsDir;
    this.readOnlyFn = opts.isReadOnly;
  }

  async get(): Promise<SettingsView> {
    const s = await readUserSettings(this.settingsDir);
    return {
      persisted: {
        godotPath: s.godotPath ?? '',
        allowedProjectPaths: s.allowedProjectPaths ?? [],
        vaultPath: s.vaultPath ?? '',
      },
      effective: {
        godotPath: process.env.GODOT_PATH ?? '',
        allowedProjectPaths: getAllowedProjectPaths(),
        unrestricted: process.env.GODOT_MCP_UNRESTRICTED === 'true',
        godotAllowedList: process.env.GODOT_MCP_ALLOWED_GODOT_PATHS ?? '',
        vaultPath: process.env.GODOT_MCP_VAULT_PATH ?? '',
      },
      candidates: readGodotPathsConfig(),
      readOnly: this.readOnlyFn?.() ?? false,
    };
  }

  /** 验证候选二进制:validateGodotBinaryDetailed 拿结构化 stage,ok 后 detectGodotVersion
   *  拿版本串(两次 spawn 仅发生在用户显式点「验证」,非热路径)。 */
  async verify(path: string, lang: GuiLang = 'zh'): Promise<SettingsVerifyResult> {
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, stage: 'bad-request', detail: guiText(lang, 'set.verify.emptyPath') };
    }
    const check = await validateGodotBinaryDetailed(path);
    if (!check.ok) {
      const n = normalizeGodotStage(check.stage, lang);
      return { ok: false, stage: n.stage, detail: n.message };
    }
    try {
      return { ok: true, version: await detectGodotVersion(path) };
    } catch {
      return { ok: false, stage: 'version-read-failed', detail: guiText(lang, 'set.verify.versionReadFailed') };
    }
  }

  async save(patch: SettingsSavePatch, lang: GuiLang = 'zh'): Promise<SettingsSaveResult> {
    // ── 校验(godotPath:绝对路径 + validateGodotBinaryDetailed 全链含白名单)────────
    const patchGodot = patch.godotPath;
    let godotValue: string | undefined;   // undefined = 保持现值
    if (patchGodot !== undefined) {
      const trimmed = patchGodot.trim();
      if (trimmed === '') {
        godotValue = undefined;           // '' = 清除字段(写盘时省略)
      } else {
        if (!isAbsolute(trimmed)) {
          this.auditSave(false, { error: 'godotPath rejected: not-absolute' });   // 二轮 Nit-B: 与 allowed 侧同层格式预检留痕对称
          return { ok: false, error: guiText(lang, 'set.save.godotNotAbsolute'), stage: 'not-absolute' };
        }
        const check = await validateGodotBinaryDetailed(trimmed);
        if (!check.ok) {
          const n = normalizeGodotStage(check.stage, lang);
          this.auditSave(false, { error: `godotPath rejected: ${n.stage}` });
          return { ok: false, error: guiText(lang, 'set.save.godotVerifyFailed', { msg: n.message }), stage: n.stage };
        }
        godotValue = trimmed;
      }
    }
    // ── 校验(allowedProjectPaths:每条非空绝对路径且为存在目录;拒绝含分号条目)──────
    // 审查 Important-1(2026-09-29):白名单是 deny-by-default 安全边界,修改白名单被拒
    // 与 godotPath 被拒同属安全事件——全部校验失败分支补机器级留痕(empty-patch 豁免:
    // 无内容无事件)。含分号条目显式拒绝(审查 Nit-3):env 以分号分隔,含分号目录名保存
    // 后会被 getAllowedProjectPaths 的 split 撕裂,热生效语义错乱,宁拒不让。
    const patchAllowed = patch.allowedProjectPaths;
    let allowedValue: string[] | undefined;   // undefined = 保持现值
    if (patchAllowed !== undefined) {
      if (patchAllowed.length === 0) {
        allowedValue = undefined;             // [] = 清除字段
      } else {
        const cleaned: string[] = [];
        for (const p of patchAllowed) {
          if (typeof p !== 'string' || p.trim() === '') {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: bad-entry' });
            return { ok: false, error: guiText(lang, 'set.save.badEntry'), stage: 'bad-entry' };
          }
          const t = p.trim();
          if (t.includes(';')) {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: contains-semicolon' });
            return { ok: false, error: guiText(lang, 'set.save.semicolon', { path: t }), stage: 'contains-semicolon' };
          }
          if (!isAbsolute(t)) {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: not-absolute' });
            return { ok: false, error: guiText(lang, 'set.save.allowedNotAbsolute', { path: t }), stage: 'not-absolute' };
          }
          try {
            if (!(await stat(t)).isDirectory()) {
              this.auditSave(false, { error: 'allowedProjectPaths rejected: not-a-directory' });
              return { ok: false, error: guiText(lang, 'set.save.notADirectory', { path: t }), stage: 'not-a-directory' };
            }
          } catch {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: not-found' });
            return { ok: false, error: guiText(lang, 'set.save.notFound', { path: t }), stage: 'not-found' };
          }
          cleaned.push(t);
        }
        allowedValue = cleaned;
      }
    }
    // ── 校验(vaultPath:绝对路径且为存在目录;知识库联动批 2026-10-08)────────────
    // 对齐 allowedProjectPaths 单条目的格式+存在性预检(不 spawn,vault 是目录非可执行);
    // 校验失败同属安全事件,机器级留痕(allowed 侧同款)。
    const patchVault = patch.vaultPath;
    let vaultValue: string | undefined;   // undefined = 保持现值
    if (patchVault !== undefined) {
      const trimmedVault = patchVault.trim();
      if (trimmedVault === '') {
        vaultValue = undefined;           // '' = 清除字段
      } else {
        if (!isAbsolute(trimmedVault)) {
          this.auditSave(false, { error: 'vaultPath rejected: not-absolute' });
          return { ok: false, error: guiText(lang, 'set.save.vaultNotAbsolute'), stage: 'not-absolute' };
        }
        try {
          if (!(await stat(trimmedVault)).isDirectory()) {
            this.auditSave(false, { error: 'vaultPath rejected: not-a-directory' });
            return { ok: false, error: guiText(lang, 'set.save.vaultNotADirectory', { path: trimmedVault }), stage: 'not-a-directory' };
          }
        } catch {
          this.auditSave(false, { error: 'vaultPath rejected: not-found' });
          return { ok: false, error: guiText(lang, 'set.save.vaultNotFound', { path: trimmedVault }), stage: 'not-found' };
        }
        vaultValue = trimmedVault;
      }
    }
    if (patchGodot === undefined && patchAllowed === undefined && patchVault === undefined) {
      return { ok: false, error: guiText(lang, 'set.save.emptyPatch'), stage: 'empty-patch' };
    }
    // ── merge(undefined = 沿用现值)→ 写盘 → 热生效 → 审计 ─────────────────────
    const current = await readUserSettings(this.settingsDir);
    const next: UserSettings = { version: 1 };
    const finalGodot = patchGodot !== undefined ? godotValue : current.godotPath;
    const finalAllowed = patchAllowed !== undefined ? allowedValue : current.allowedProjectPaths;
    const finalVault = patchVault !== undefined ? vaultValue : current.vaultPath;
    if (finalGodot !== undefined) next.godotPath = finalGodot;
    if (finalAllowed !== undefined && finalAllowed.length > 0) next.allowedProjectPaths = finalAllowed;
    if (finalVault !== undefined) next.vaultPath = finalVault;
    await writeUserSettings(next, this.settingsDir);
    applyUserSettings(next);
    const persisted = {
      godotPath: next.godotPath ?? '',
      allowedProjectPaths: next.allowedProjectPaths ?? [],
      vaultPath: next.vaultPath ?? '',
    };
    this.auditSave(true, {
      details: {
        godotPath: persisted.godotPath || '(cleared)',
        allowedProjectPaths: persisted.allowedProjectPaths.length > 0 ? persisted.allowedProjectPaths.join(';') : '(cleared)',
        vaultPath: persisted.vaultPath || '(cleared)',
      },
    });
    getLogger().info('web-gui', `action=settings_save godotPath=${persisted.godotPath ? 'set' : 'cleared'} allowed=${persisted.allowedProjectPaths.length} vaultPath=${persisted.vaultPath ? 'set' : 'cleared'} result=200`);
    return { ok: true, persisted };
  }

  /** 机器级审计(成功与失败都留痕;best-effort 不阻断响应)。
   *  project_path 用 settings.json 路径(机器级归属锚点;仅路径字符串,无敏感值)。 */
  private auditSave(ok: boolean, opts?: { error?: string; details?: Record<string, unknown> }): void {
    if (!isAuditEnabled()) return;
    const details = { ...(opts?.details ?? {}) };
    if (opts?.error !== undefined) details.error = opts.error;
    const file = getUserSettingsFile(this.settingsDir);
    void appendMachineAuditLine({
      trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
      tool: 'web-gui', action: 'settings_save', risk: 'write',
      ok, project_path: file,
      changed_files: ok ? [file] : [],
      duration_ms: 0,   // 校验含 spawn --version(秒级),非本函数实测,记 0(诚实:非测量值)
      caller: 'web-gui:settings',
      ...(Object.keys(details).length > 0 ? { details } : {}),
    }).catch((e) => { recordAuditWriteFailure(e); });
  }
}
