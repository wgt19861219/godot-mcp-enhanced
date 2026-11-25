#!/usr/bin/env node
// scripts/check-changelog-sync.mjs
// 治理(2026-08-09):检测 fix(security)/feat/BREAKING commit 是否漏登 CHANGELOG [Unreleased]。
//
// 问题根因:CHANGELOG 全手动无自动化(version-sync.mjs 只管版本号不管内容),
// 修复 commit 后人肉记忆易漏登。本脚本在 CI 可视化漏登(advisory 非阻断)。
//
// 检测逻辑:
// 1. 从 CHANGELOG 取最近版本段日期([Unreleased] 之上那个 ## [X.Y.Z] - YYYY-MM-DD)
// 2. git log --since=<日期 00:00:00> 取待发版 commit
// 3. 筛 ^(feat|fix|BREAKING) 前缀(纯 test/docs/refactor/chore 不检测——按 CHANGELOG 惯例本就不进)
// 4. 若待检 commit > 0 且未被 CHANGELOG 覆盖 → warn 列出漏登 commit
//
// 模式:advisory(恒 exit 0 + console.warn),仿 check-env-isolation.mjs。
// STRICT=1 时升 error(仿 check-rules-content-sync.mjs 双模式)。
//
// 2026-11-25 两处根因修订(回归测试 test/scripts/check-changelog-sync.test.ts):
//   a. --since 裸日期不是零点:git approxidate 把 "YYYY-MM-DD" 解释成「该日的当前时刻」。
//      后果:发版当天窗口为空(空转过门);次日起窗口起点是「发版日的此刻」,
//      只框进发版日当晚的提交——它们多半已登记在最近版本段里,再被下面的关键词规则误报。
//      现显式补 00:00:00。
//   b. 「已登记」的判定补哈希引用,追踪号只认全大写族:
//      本仓 CHANGELOG 惯例在条目里直接写 commit 哈希(「commits a+b」),哈希被引用即权威的
//      已登记信号,优先于关键词匹配。原标识符正则 [A-Za-z]{2,}-[A-Za-z]*\d+ 把评审标签
//      Important-1 / Minor-1 当成追踪号,要求它们出现在 CHANGELOG 里——对已按哈希登记的
//      修复提交必然误报。追踪号收窄为全大写族(SEC-x / CMP-x / Pn-x / L-n …)。
//   c. (同日追加,在真实仓库自测时暴露)git log 记录的前导换行会混进哈希——除首条外的
//      记录取前 7 位只剩 6 位哈希,b 的哈希引用规则对它们失效;现剥掉前导换行。
//      另:署名尾行(Co-Authored-By 等)里的型号字样(如 GLM-5.4)不再当追踪号。
//   d. (同日独立复审 I-1/I-2 追加)c 的尾行剥离对「正文只有尾行」的短提交失效:主题与正文
//      原用空格拼接,尾行不在行首,行首锚点命不中——现改用换行拼接。另:追踪号由「全大写
//      字母-数字」泛匹配收窄为登记键族白名单——泛匹配仍把全大写评审发现编号
//      (CRITICAL-1 / NIT-2 / IMP-4)与技术词(UTF-8 / SHA-256)当追踪号要求登记。
//
// 用法: node scripts/check-changelog-sync.mjs
// 退出码: 0=通过或 advisory warn / 1=有漏登且 STRICT=1

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

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
 * 版本日期 → git --since 参数。必须显式带零点:
 * git 把裸日期 "YYYY-MM-DD" 解释成「该日的当前时刻」,窗口会随一天里的时间漂移。
 */
function toSinceDateTime(sinceDate) {
  return `${sinceDate} 00:00:00`;
}

/**
 * git log 取待发版 commit(最近版本日期零点之后)。
 * 返回 [{ hash, subject, body }] 数组。body 含完整 message(subject + footer),
 * 用于检测 BREAKING CHANGE: footer 形态(Conventional Commits)。
 */
function getCommitsSince(sinceDate) {
  // --since 取版本日零点(含当天),发版前 commit 登记在版本段是合法的,由 isMentionedInChangelog 识别
  // 用 NUL(%x00)做 commit 记录分隔(因 body 含换行,不能按 \n split);
  // subject(%s) 与 body(%b) 用 tab(%x09) 分隔
  const log = execSync(
    `git log --since="${toSinceDateTime(sinceDate)}" --format="%H%x09%s%x09%b%x00" --no-merges`,
    { encoding: 'utf-8' },
  );
  if (!log.trim()) return [];
  // git 在每条记录后输出一个换行,按 NUL 切分后除首条外每条都以 "\n" 开头。
  // 不剥掉它,取前 7 位时换行会占掉一位——2026-11-25 实测:非首条记录的短哈希只剩
  // 6 位、输出里多出一个空行,新增的哈希引用规则对非首条记录全部失效。
  return log.split('\x00')
    .map(record => record.replace(/^\n/, ''))
    .filter(record => record.trim())
    .map(record => {
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
 * 追踪号:只认本仓 CHANGELOG 当登记键用的族(2026-11-25 按全史提交与 CHANGELOG 实测)——
 * 安全/提案公告号 SEC-x / CMP-x / SEP-x / CVE-x / GHSA-xxxx-xxxx-xxxx,计划阶段号 Pn-x。
 * 不认的:评审发现编号(Important-1 / CRITICAL-1 / NIT-2 / IMP-4 …每次审查自成一套,全史数十族)
 * 与技术词(UTF-8 / SHA-256)——它们是否登记由哈希引用规则管,不在这里要求。
 * 2026-11-25 之前的泛匹配正则 `[A-Za-z]{2,}-[A-Za-z]*\d+[\w-]*` 把上述一律当成追踪号,
 * 对已按哈希登记的修复提交误报;中间版本收窄为「全大写字母-数字」,只挡住了混排大小写。
 * 前后各留一个环视:不从更长的标识里截半截(如 XSEC-1 里截出 SEC-1)。
 */
const IDENTIFIER_RE =
  /(?<![A-Za-z0-9-])(?:(?:SEC|CMP|SEP)-\d+|P\d+-\d+|CVE-\d{4}-\d{4,}|GHSA(?:-[0-9a-z]{4}){3})(?![A-Za-z0-9])/g;

/**
 * git 署名类尾行(Co-Authored-By / Signed-off-by …):是元数据不是变更描述,
 * 其中的型号、版本字样(如 GLM-5.4)不参与追踪号识别。
 */
const TRAILER_RE = /^(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|helped-by|suggested-by):[^\n]*\n?/gim;

/**
 * 检查 commit 是否已被 CHANGELOG 覆盖。
 * 查 [Unreleased] 段 + 最近版本段(因 --since=版本日零点 取了整天,含发版前 commit,
 * 这些 commit 登记在版本段是合法的,不应误报)。
 * text 是主题与正文按「换行」拼接的结果——尾行剥离按行首锚定,用空格拼接时
 * 「正文只有尾行」的短提交剥不掉(2026-11-25 独立复审 I-1)。
 * 匹配策略(由严到宽,advisory 模式不追求精确):
 * 0. commit 哈希已被引用(本仓条目惯例写「commits a+b」)→ 已登记。哈希引用是权威信号,
 *    先于下面的关键词规则——否则带评审标签的已登记提交仍会被误报。
 * 1. 有追踪号 → 严格匹配追踪号是否在 changelog 出现
 * 2. 无追踪号的 feat/fix commit → 只要 [Unreleased] 段非空(有实质内容)就视为已覆盖
 */
function isMentionedInChangelog(text, unreleasedContent, recentVersionContent, hash) {
  const combined = unreleasedContent + recentVersionContent;
  if (hash && combined.includes(hash)) return true;
  const identifiers = text.replace(TRAILER_RE, '').match(IDENTIFIER_RE) || [];
  if (identifiers.length > 0) {
    return identifiers.some(id => combined.includes(id));
  }
  // 无追踪号:只要 unreleased 有实质内容(>50 字符,排除空白/标题)就视为已覆盖
  const stripped = unreleasedContent.replace(/[#\-*\s]/g, '');
  return stripped.length > 50;
}

function main() {
  const CHANGELOG = readFileSync('CHANGELOG.md', 'utf-8');
  const STRICT = process.env.STRICT === '1';
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

  const missing = worthy.filter(
    c => !isMentionedInChangelog(`${c.subject}\n${c.body}`, unreleased, recentVersion, c.hash),
  );

  if (missing.length === 0) {
    console.log('[changelog-sync] ✓ %d 个待检 commit 均已登记', worthy.length);
    return;
  }

  console.warn('[changelog-sync] ⚠ %d 个 fix/feat/BREAKING commit 漏登 CHANGELOG [Unreleased]:', missing.length);
  console.warn('  最近版本段日期: %s(此日期后的 commit 应进 [Unreleased];发版前的登记在版本段也可)', sinceDate);
  for (const c of missing.slice(0, 10)) {
    console.warn('    %s  %s', c.hash, c.subject);
  }
  if (missing.length > 10) {
    console.warn('    ... 其余 %d 条省略', missing.length - 10);
  }
  console.warn('[changelog-sync] 修复:在 CHANGELOG.md ## [Unreleased] 段登记上述 commit(写明 commit 哈希;fix/feat 按惯例必进)');

  if (STRICT) {
    console.error('[changelog-sync] STRICT=1,漏登阻断(exit 1)');
    process.exit(1);
  }
  console.warn('[changelog-sync] 当前 advisory 模式(恒 exit 0);STRICT=1 升 error');
}

// 无条件执行:本脚本只以子进程方式运行,没有模块导入它。曾经的「仅直接执行时才跑」
// 判断在路径含符号链接/junction 时不成立,脚本会不输出、exit 0——门禁静默空转。
main();
