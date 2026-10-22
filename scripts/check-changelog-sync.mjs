#!/usr/bin/env node
// scripts/check-changelog-sync.mjs
// 治理(2026-08-09):检测 fix(security)/feat/BREAKING commit 是否漏登 CHANGELOG [Unreleased]。
//
// 问题根因:CHANGELOG 全手动无自动化(version-sync.mjs 只管版本号不管内容),
// 修复 commit 后人肉记忆易漏登。本脚本在 CI 可视化漏登(advisory 非阻断)。
//
// 检测逻辑:
// 1. 从 CHANGELOG 取最近版本段日期([Unreleased] 之上那个 ## [X.Y.Z] - YYYY-MM-DD)
// 2. git log --since=<日期> 取待发版 commit
// 3. 筛 ^(feat|fix\(security\)|fix\(reliability\)|fix\(correctness\)|BREAKING) 前缀
//    (纯 test/docs/refactor/chore 不检测——按 CHANGELOG 惯例本就不进)
// 4. 若待检 commit > 0 且 [Unreleased] 段为空或不含对应关键词 → warn 列出漏登 commit
//
// 模式:advisory(恒 exit 0 + console.warn),仿 check-env-isolation.mjs。
// STRICT=1 时升 error(仿 check-rules-content-sync.mjs 双模式)。
//
// 用法: node scripts/check-changelog-sync.mjs
// 退出码: 0=通过或 advisory warn / 1=有漏登且 STRICT=1

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const CHANGELOG = readFileSync('CHANGELOG.md', 'utf-8');
const STRICT = process.env.STRICT === '1';

/**
 * 从 CHANGELOG 取 [Unreleased] 段内容(## [Unreleased] 到下一个 ## [ 之间)。
 */
function extractUnreleased(changelog) {
  const startIdx = changelog.indexOf('## [Unreleased]');
  if (startIdx < 0) return { content: '', startIdx: -1 };
  const afterHeader = startIdx + '## [Unreleased]'.length;
  const rest = changelog.slice(afterHeader);
  const nextSection = rest.search(/\n## \[/);
  const endIdx = nextSection >= 0 ? nextSection : rest.length;
  return { content: rest.slice(0, endIdx), startIdx };
}

/**
 * 取最近版本段日期([Unreleased] 之上的 ## [X.Y.Z] - YYYY-MM-DD)。
 * 用于 git log --since 边界。比 git tag 可靠(tag 可能滞后)。
 */
function getLatestVersionDate(changelog) {
  // 跳过 [Unreleased],找第一个带日期的版本段
  const m = changelog.match(/## \[[^\]]+\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * 取最近版本段内容(第一个带日期的 ## [X.Y.Z] 段)。
 * 用于 isMentionedInChangelog 的标识符匹配(发版前 commit 登记在版本段是合法的)。
 */
function extractRecentVersion(changelog) {
  const m = changelog.match(/## \[[^\]]+\]\s*-\s*\d{4}-\d{2}-\d{2}[\s\S]*?(?=\n## \[|\s*$)/);
  return m ? m[0] : '';
}

/**
 * git log 取待发版 commit(最近版本日期之后)。
 * 返回 [{ hash, subject, body }] 数组。body 含完整 message(subject + footer),
 * 用于检测 BREAKING CHANGE: footer 形态(Conventional Commits)。
 */
function getCommitsSince(sinceDate) {
  // --since 用日期(含当天),取当天及之后的 commit
  // 用 NUL(%x00)做 commit 记录分隔(因 body 含换行,不能按 \n split);
  // subject(%s) 与 body(%b) 用 tab(%x09) 分隔
  const log = execSync(
    `git log --since="${sinceDate}" --format="%H%x09%s%x09%b%x00" --no-merges`,
    { encoding: 'utf-8' },
  );
  if (!log.trim()) return [];
  return log.split('\x00').filter(Boolean).map(record => {
    const [hash, subject, ...bodyParts] = record.split('\t');
    return { hash: hash.slice(0, 7), subject: subject ?? '', body: bodyParts.join('\t') };
  });
}

/**
 * 筛需进 CHANGELOG 的 commit(按惯例:feat/fix/BREAKING)。
 * 纯 test/docs/refactor/chore/style/ci/build 不检测(type 不匹配即排除,本就不进 CHANGELOG)。
 * 2026-10-22 审查 Medium-D1:原限定 fix(security|reliability|correctness) 三个 scope,
 * 对本仓实际的 fix(core/...)/fix(web-gui)/fix(cli) 等主流风格全部失明——豁免语义
 * 应基于 type 而非 scope 拼写,放宽为 type 前缀匹配。
 *
 * BREAKING 检测两种形态:
 * 1. subject 前缀 feat!: / fix!: (Conventional Commits 的 ! 语法)
 * 2. footer BREAKING CHANGE: 描述 (在 body 里)
 */
const SUBJECT_WORTHY = /^(feat!?|fix!?|BREAKING)/i;
const FOOTPER_BREAKING = /^BREAKING[ -]CHANGE:/im;

function isChangelogWorthy(subject, body) {
  if (SUBJECT_WORTHY.test(subject)) return true;
  // 查 body 的 BREAKING CHANGE: footer(多行 body,逐行查)
  if (body && FOOTPER_BREAKING.test(body)) return true;
  return false;
}

/**
 * 检查 commit subject 的关键词是否出现在 CHANGELOG 中。
 * 查 [Unreleased] 段 + 最近版本段(因 --since=版本日期 取了整天,含发版前 commit,
 * 这些 commit 登记在版本段是合法的,不应误报)。
 * 匹配策略(由严到宽,advisory 模式不追求精确):
 * 1. 有明确标识符(SEC-x / CMP-x / Pn-x)→ 严格匹配标识符是否在 changelog 出现
 * 2. 无标识符的 feat/fix commit → 只要 [Unreleased] 段非空(有实质内容)就视为已覆盖
 */
function isMentionedInChangelog(subject, unreleasedContent, recentVersionContent) {
  // 标识符:SEC-x / CMP-x / Tier1-x / P2-x 等(前缀 2+ 字母数字混合,后接数字)
  const identifiers = subject.match(/[A-Za-z]{2,}-[A-Za-z]*\d+[\w-]*/g) || [];
  // 有明确标识符:严格匹配(查 unreleased + 最近版本段)
  if (identifiers.length > 0) {
    const combined = unreleasedContent + recentVersionContent;
    return identifiers.some(id => combined.includes(id));
  }
  // 无标识符:只要 unreleased 有实质内容(>50 字符,排除空白/标题)就视为已覆盖
  const stripped = unreleasedContent.replace(/[#\-*\s]/g, '');
  return stripped.length > 50;
}

function main() {
  const { content: unreleased } = extractUnreleased(CHANGELOG);
  const recentVersion = extractRecentVersion(CHANGELOG);
  const sinceDate = getLatestVersionDate(CHANGELOG);

  if (!sinceDate) {
    console.warn('[changelog-sync] ⚠ 无法从 CHANGELOG 解析版本日期,跳过检测');
    return;
  }

  const commits = getCommitsSince(sinceDate);
  const worthy = commits.filter(c => isChangelogWorthy(c.subject, c.body));

  if (worthy.length === 0) {
    console.log('[changelog-sync] ✓ 最近版本(%s)后无需进 CHANGELOG 的 commit', sinceDate);
    return;
  }

  const missing = worthy.filter(c => !isMentionedInChangelog(c.subject + ' ' + c.body, unreleased, recentVersion));

  if (missing.length === 0) {
    console.log('[changelog-sync] ✓ %d 个待检 commit 均已在 [Unreleased] 登记', worthy.length);
    return;
  }

  console.warn('[changelog-sync] ⚠ %d 个 fix(security)/feat/BREAKING commit 漏登 CHANGELOG [Unreleased]:', missing.length);
  console.warn('  最近版本段日期: %s(此日期后的 commit 应进 [Unreleased])', sinceDate);
  for (const c of missing.slice(0, 10)) {
    console.warn('    %s  %s', c.hash, c.subject);
  }
  if (missing.length > 10) {
    console.warn('    ... 其余 %d 条省略', missing.length - 10);
  }
  console.warn('[changelog-sync] 修复:在 CHANGELOG.md ## [Unreleased] 段登记上述 commit(安全修复/新功能按惯例必进)');

  if (STRICT) {
    console.error('[changelog-sync] STRICT=1,漏登阻断(exit 1)');
    process.exit(1);
  }
  console.warn('[changelog-sync] 当前 advisory 模式(恒 exit 0);STRICT=1 升 error');
}

main();
