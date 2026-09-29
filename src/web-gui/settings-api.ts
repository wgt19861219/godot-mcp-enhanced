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

/** 校验失败 stage → 人话错误(不含路径,PII-safe;前端直接展示)。 */
const GODOT_STAGE_MESSAGES: Record<string, string> = {
  'path-not-allowed': '路径不在 GODOT_MCP_ALLOWED_GODOT_PATHS 白名单内(见 Godot 二进制白名单策略)',
  'is-directory': '路径是目录,须指向 Godot 可执行文件',
  'version-run-failed': '无法运行 --version(文件不存在或不可执行)',
  'not-godot-signature': '--version 输出不是有效的 Godot 版本签名',
};

export interface SettingsView {
  persisted: { godotPath: string; allowedProjectPaths: string[] };
  effective: {
    godotPath: string;
    allowedProjectPaths: string[];
    unrestricted: boolean;
    godotAllowedList: string;
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
}

export type SettingsSaveResult =
  | { ok: true; persisted: SettingsView['persisted'] }
  | { ok: false; error: string; stage?: string };

export type SettingsVerifyResult =
  | { ok: true; version: string }
  | { ok: false; stage: string; detail: string };

export interface SettingsApi {
  get(): Promise<SettingsView>;
  verify(path: string): Promise<SettingsVerifyResult>;
  save(patch: SettingsSavePatch): Promise<SettingsSaveResult>;
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
      persisted: { godotPath: s.godotPath ?? '', allowedProjectPaths: s.allowedProjectPaths ?? [] },
      effective: {
        godotPath: process.env.GODOT_PATH ?? '',
        allowedProjectPaths: getAllowedProjectPaths(),
        unrestricted: process.env.GODOT_MCP_UNRESTRICTED === 'true',
        godotAllowedList: process.env.GODOT_MCP_ALLOWED_GODOT_PATHS ?? '',
      },
      candidates: readGodotPathsConfig(),
      readOnly: this.readOnlyFn?.() ?? false,
    };
  }

  /** 验证候选二进制:validateGodotBinaryDetailed 拿结构化 stage,ok 后 detectGodotVersion
   *  拿版本串(两次 spawn 仅发生在用户显式点「验证」,非热路径)。 */
  async verify(path: string): Promise<SettingsVerifyResult> {
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, stage: 'bad-request', detail: '路径不能为空' };
    }
    const check = await validateGodotBinaryDetailed(path);
    if (!check.ok) {
      return { ok: false, stage: check.stage, detail: GODOT_STAGE_MESSAGES[check.stage] ?? check.stage };
    }
    try {
      return { ok: true, version: await detectGodotVersion(path) };
    } catch {
      return { ok: false, stage: 'version-read-failed', detail: '二进制校验通过,但读取版本串失败' };
    }
  }

  async save(patch: SettingsSavePatch): Promise<SettingsSaveResult> {
    // ── 校验(godotPath:绝对路径 + validateGodotBinaryDetailed 全链含白名单)────────
    const patchGodot = patch.godotPath;
    let godotValue: string | undefined;   // undefined = 保持现值
    if (patchGodot !== undefined) {
      const trimmed = patchGodot.trim();
      if (trimmed === '') {
        godotValue = undefined;           // '' = 清除字段(写盘时省略)
      } else {
        if (!isAbsolute(trimmed)) {
          return { ok: false, error: 'Godot 路径必须是绝对路径', stage: 'not-absolute' };
        }
        const check = await validateGodotBinaryDetailed(trimmed);
        if (!check.ok) {
          const detail = GODOT_STAGE_MESSAGES[check.stage] ?? check.stage;
          this.auditSave(false, { error: `godotPath rejected: ${check.stage}` });
          return { ok: false, error: `Godot 路径校验失败:${detail}`, stage: check.stage };
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
            return { ok: false, error: '白名单条目不能为空', stage: 'bad-entry' };
          }
          const t = p.trim();
          if (t.includes(';')) {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: contains-semicolon' });
            return { ok: false, error: `白名单条目不能含分号(env 以分号分隔,会被撕裂):${t}`, stage: 'contains-semicolon' };
          }
          if (!isAbsolute(t)) {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: not-absolute' });
            return { ok: false, error: `白名单条目必须是绝对路径:${t}`, stage: 'not-absolute' };
          }
          try {
            if (!(await stat(t)).isDirectory()) {
              this.auditSave(false, { error: 'allowedProjectPaths rejected: not-a-directory' });
              return { ok: false, error: `白名单条目不是目录:${t}`, stage: 'not-a-directory' };
            }
          } catch {
            this.auditSave(false, { error: 'allowedProjectPaths rejected: not-found' });
            return { ok: false, error: `白名单条目不存在:${t}`, stage: 'not-found' };
          }
          cleaned.push(t);
        }
        allowedValue = cleaned;
      }
    }
    if (patchGodot === undefined && patchAllowed === undefined) {
      return { ok: false, error: '没有要保存的设置字段', stage: 'empty-patch' };
    }
    // ── merge(undefined = 沿用现值)→ 写盘 → 热生效 → 审计 ─────────────────────
    const current = await readUserSettings(this.settingsDir);
    const next: UserSettings = { version: 1 };
    const finalGodot = patchGodot !== undefined ? godotValue : current.godotPath;
    const finalAllowed = patchAllowed !== undefined ? allowedValue : current.allowedProjectPaths;
    if (finalGodot !== undefined) next.godotPath = finalGodot;
    if (finalAllowed !== undefined && finalAllowed.length > 0) next.allowedProjectPaths = finalAllowed;
    await writeUserSettings(next, this.settingsDir);
    applyUserSettings(next);
    const persisted = { godotPath: next.godotPath ?? '', allowedProjectPaths: next.allowedProjectPaths ?? [] };
    this.auditSave(true, {
      details: {
        godotPath: persisted.godotPath || '(cleared)',
        allowedProjectPaths: persisted.allowedProjectPaths.length > 0 ? persisted.allowedProjectPaths.join(';') : '(cleared)',
      },
    });
    getLogger().info('web-gui', `action=settings_save godotPath=${persisted.godotPath ? 'set' : 'cleared'} allowed=${persisted.allowedProjectPaths.length} result=200`);
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
