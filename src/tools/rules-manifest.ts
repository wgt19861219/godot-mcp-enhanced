// src/tools/rules-manifest.ts
// 规则文件清单（manifest）的纯函数模块：hash 计算、adopt 构建、二维判定、reconcile 规划。
// 零 IO 依赖（不读写文件系统），所有文件读写由 project.ts 编排，本模块只做决策。

import { createHash } from 'crypto';

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 单个规则文件在 manifest 中的条目 */
export interface RuleManifestEntry {
  /** 内容来源：'base' = GODOT_MCP_RULES，'detail' = DETAILED_RULE_TEMPLATES */
  source: 'base' | 'detail';
  /** 安装时文件内容的 hash（CRLF 归一化后），格式 'sha256:<hex>' */
  hash: string;
}

/** manifest 文件结构 */
export interface RulesManifest {
  /** 清单格式版本，留作未来迁移 */
  manifest_version: number;
  /** 规则文件安装时的 server 版本（仅代表规则文件，非整个 MCP 安装） */
  rules_installed_at_version: string;
  /** 安装时间 ISO 字符串 */
  installed_at: string;
  /** 文件名 → 条目 */
  rules: Record<string, RuleManifestEntry>;
}

/** 逐文件二维判定的分类（原四种见 spec §3.3；第五种 content-drift 为 2026-10-24 可靠性批新增） */
export type FileClassification =
  | 'pure-upgrade'          // 版本过时 + 用户未动过 → update 应覆盖
  | 'stale-and-modified'    // 版本过时 + 用户动过 → update 保留并警告
  | 'latest'                // 版本同 + 未动过 → 不动
  | 'local-modified'        // 版本同 + 动过 → 保留并报告
  | 'content-drift';        // 版本同 + 未动过 + manifest hash ≠ 当前进程模板 hash → 毒化指纹,update 覆盖修复

/** reconcile 执行模式 */
export type RulesMode = 'check' | 'update' | 'overwrite';

// ─── hash ────────────────────────────────────────────────────────────────────

/** CRLF / 裸 CR 归一化为 LF。仅用于算 hash，不用于写磁盘。 */
export function normalizeForHash(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 计算内容的 SHA-256 hash（CRLF 归一化后），返回 'sha256:<hex>'。 */
export function hashContent(content: string): string {
  const normalized = normalizeForHash(content);
  const hex = createHash('sha256').update(normalized, 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

// ─── adopt ───────────────────────────────────────────────────────────────────

/** adopt 输入：每个规则文件的当前磁盘内容 */
export interface AdoptFileInput {
  filename: string;
  content: string;
  source: 'base' | 'detail';
}

/** adopt 构建参数 */
export interface BuildAdoptParams {
  serverVersion: string;
  now: string; // ISO 时间戳，注入以便测试
  files: AdoptFileInput[];
}

/**
 * 把当前磁盘状态固化为新 manifest 基线（spec §5）。
 * 偏离模板的文件 hash 记实际内容（不报错），偏离计数由 countDeviations 单独算。
 */
export function buildAdoptManifest(params: BuildAdoptParams): RulesManifest {
  const rules: Record<string, RuleManifestEntry> = {};
  for (const f of params.files) {
    rules[f.filename] = { source: f.source, hash: hashContent(f.content) };
  }
  return {
    manifest_version: 1,
    rules_installed_at_version: params.serverVersion,
    installed_at: params.now,
    rules,
  };
}

/**
 * 统计 manifest 中磁盘 hash ≠ 当前模板 hash 的文件数（spec §5 adopt 报告用）。
 * @param manifest adopt 后的 manifest
 * @param currentTemplateHashes 每个文件名 → 当前模板内容的 hash
 */
export function countDeviations(
  manifest: RulesManifest,
  currentTemplateHashes: Record<string, string>,
): number {
  let n = 0;
  for (const [filename, entry] of Object.entries(manifest.rules)) {
    const templateHash = currentTemplateHashes[filename];
    if (templateHash !== undefined && entry.hash !== templateHash) n++;
  }
  return n;
}

// ─── 二维分类（spec §3.3，不级联）──────────────────────────────────────────────

/** classifyFile 输入参数 */
export interface ClassifyParams {
  /** manifest 记录的安装时版本 */
  installedVersion: string;
  /** 当前 server 版本 */
  serverVersion: string;
  /** 当前磁盘文件内容的 hash */
  diskHash: string;
  /** manifest 记录的安装时 hash */
  manifestHash: string;
  /** 当前进程模板渲染内容的 hash（P1-2 content-drift 维度）。缺省时跳过该维度
   *  （版本同+未动过 → latest），兼容不关心内容指纹的旧调用点。 */
  templateHash?: string;
}

/**
 * 逐文件二维判定。版本与"是否动过"是两个独立维度，做笛卡尔积，不级联。
 * 级联会吞用户修改（见 spec §3.3 "为什么二维而非级联"）。
 *
 * P1-2（2026-10-24）：在"版本同 + 用户未动过"象限内细分 content-drift——manifest
 * 记录的安装时 hash 与当前进程模板 hash 不符 = 版本行与内容同源关系断裂（旧进程毒化
 * 写入，或跨版本同号）。该象限用户未动过，覆盖修复无吞改风险。
 */
export function classifyFile(p: ClassifyParams): FileClassification {
  const versionStale = p.installedVersion !== p.serverVersion;
  const userModified = p.diskHash !== p.manifestHash;
  if (versionStale && !userModified) return 'pure-upgrade';
  if (versionStale && userModified) return 'stale-and-modified';
  if (!versionStale && userModified) return 'local-modified';
  if (p.templateHash !== undefined && p.manifestHash !== p.templateHash) return 'content-drift';
  return 'latest';
}

// ─── reconcile 规划（spec §3.3 + §3.4 + §3.6）─────────────────────────────────

/** 单个文件的 reconcile 动作 */
export type FileAction = 'write' | 'keep' | 'warn-keep';

export interface FilePlan {
  classification: FileClassification;
  action: FileAction;
  /** action=write 时，要写入的新内容（来自当前模板） */
  newContent?: string;
}

export interface PlanReconcileParams {
  manifest: RulesManifest;
  serverVersion: string;
  diskFiles: { filename: string; content: string }[];
  /** 当前模板内容（文件名 → 插值后的模板字符串）。update/overwrite 时覆盖用 */
  currentTemplates?: Record<string, string>;
  mode: RulesMode;
  now: string;
}

export interface ReconcilePlan {
  /** 文件名 → 动作计划 */
  actions: Record<string, FilePlan>;
  /** 是否需要写文件（check 模式为 false） */
  shouldWriteFiles: boolean;
  /** 更新后的 manifest（无论是否写文件都给出，供报告） */
  newManifest: RulesManifest;
}

/**
 * reconcile 规划的核心纯函数（spec §3.4）。
 *
 * 集成 classifyFile 的二维判定，按 mode 决策每个文件的动作：
 * - check：所有文件 action=keep，shouldWriteFiles=false
 * - update：pure-upgrade / content-drift → write；stale-and-modified/local-modified → warn-keep（保留并警告）；latest → keep
 * - overwrite：除 latest 外都 write（全覆盖）
 *
 * 关键不变式：update 模式下 stale-and-modified（版本过时 + 用户动过）与
 * local-modified（版本同 + 用户动过）的文件必须 warn-keep（保留 + 警告），
 * 绝不能 write —— 否则吞用户修改。content-drift 只在"用户未动过"象限触发，
 * 覆盖修复不与该不变式冲突（P1-2）。
 */
export function planReconcile(p: PlanReconcileParams): ReconcilePlan {
  const actions: Record<string, FilePlan> = {};
  const newRules: Record<string, RuleManifestEntry> = {};

  for (const disk of p.diskFiles) {
    const entry = p.manifest.rules[disk.filename];
    // manifest 没记录的文件（用户新增？）→ 视为 local-modified，保守不动
    const manifestHash = entry?.hash ?? '';
    const installedVersion = entry ? p.manifest.rules_installed_at_version : p.serverVersion;
    const templateContent = p.currentTemplates?.[disk.filename];
    const classification = classifyFile({
      installedVersion,
      serverVersion: p.serverVersion,
      diskHash: hashContent(disk.content),
      manifestHash,
      templateHash: templateContent !== undefined ? hashContent(templateContent) : undefined,
    });

    let action: FileAction = 'keep';
    let newContent: string | undefined;
    let resolvedHash = entry?.hash ?? hashContent(disk.content);

    if (p.mode === 'overwrite') {
      // 全覆盖（不管分类，除 latest 外都写；latest 写也无害但跳过省 IO）
      if (classification !== 'latest' && templateContent !== undefined) {
        action = 'write';
        newContent = templateContent;
        resolvedHash = hashContent(templateContent);
      }
    } else if (p.mode === 'update') {
      if (classification === 'pure-upgrade' && templateContent !== undefined) {
        action = 'write';
        newContent = templateContent;
        resolvedHash = hashContent(templateContent);
      } else if (classification === 'content-drift' && templateContent !== undefined) {
        // P1-2：版本行相同但内容指纹不符（旧进程毒化写入/跨版本同号），用户未动过
        // → 覆盖修复（等价 pure-upgrade 的覆盖行为），版本行与内容恢复同源。
        action = 'write';
        newContent = templateContent;
        resolvedHash = hashContent(templateContent);
      } else if (classification === 'stale-and-modified' || classification === 'local-modified') {
        action = 'warn-keep';
      }
    }
    // check 模式 action 保持 keep

    actions[disk.filename] = { classification, action, newContent };
    newRules[disk.filename] = {
      source: entry?.source ?? 'detail',
      hash: resolvedHash,
    };
  }

  // 新 manifest 版本：若发生过任何 write（update/overwrite），版本推进到 server 版本
  const anyWrite = Object.values(actions).some(a => a.action === 'write');
  const newManifest: RulesManifest = {
    manifest_version: p.manifest.manifest_version,
    rules_installed_at_version: anyWrite ? p.serverVersion : p.manifest.rules_installed_at_version,
    installed_at: p.now,
    rules: newRules,
  };

  return {
    actions,
    shouldWriteFiles: p.mode === 'update' || p.mode === 'overwrite',
    newManifest,
  };
}

// ─── 项目级分发状态聚合（P1-3/P1-4，2026-10-24 可靠性批）──────────────────────

/** 项目级规则分发状态（self_update check / doctor / CLI rules 共用的报告粒度） */
export type DistStatus = 'current' | 'stale' | 'content-drift';

/**
 * 由文件级分类聚合为项目单值状态。优先级：版本过时 > content-drift > current。
 * local-modified（版本同 + 用户动过）计入 current——用户本地修改不影响
 * "已分发到当前版本"的分发层事实，分发状态与用户改动是两个维度。
 */
export function summarizeDistStatus(classifications: FileClassification[]): DistStatus {
  if (classifications.some(c => c === 'pure-upgrade' || c === 'stale-and-modified')) return 'stale';
  if (classifications.some(c => c === 'content-drift')) return 'content-drift';
  return 'current';
}
