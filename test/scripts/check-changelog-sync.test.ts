// test/scripts/check-changelog-sync.test.ts
// check-changelog-sync.mjs 的端到端回归:在临时 git 仓库里起子进程跑脚本本体。
// 钉住 2026-11-25 修的根因——① --since 裸日期是「该日当前时刻」而非零点;
// ② git log 记录的前导换行会混进哈希;③ 哈希已被 CHANGELOG 引用的提交应视为已登记,
// 追踪号只认登记键族(SEC / CMP / SEP / CVE / GHSA / Pn-x),评审标签与技术词不算;
// ④ 署名尾行(Co-Authored-By 等)是元数据,落在正文哪一行都不参与追踪号识别。
// 脚本读 cwd 下的 CHANGELOG.md 并调 git log,所以按黑盒方式验证退出码与输出。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'check-changelog-sync.mjs');
/** 最近版本段的日期。固定在过去;用例里的提交时刻按当前时钟推算(见 earlierToday)。 */
const VERSION_DATE = '2026-01-02';
/** [Unreleased] 的实质内容:须超过脚本判定「无追踪号提交已覆盖」的 50 字符门槛。 */
const UNRELEASED_FILLER =
  '占位:待发版内容尚未展开,此句仅用于让 Unreleased 段有足够的实质长度,从而通过脚本在提交没有追踪号时采用的五十字符判定门槛,不承载任何实际含义。';
/** 跳过全局 git 配置(本机可能配了 core.hooksPath / 提交署名),提交用固定身份。 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

let tmpRoot: string;

beforeAll(() => {
  // 临时仓库放仓库内被忽略的 test-output/,不落系统临时目录
  const base = join(process.cwd(), 'test-output');
  mkdirSync(base, { recursive: true });
  tmpRoot = mkdtempSync(join(base, 'changelog-sync-'));
});

afterAll(() => {
  // beforeAll 抛错时 tmpRoot 还没赋值,此时没有东西可清
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** 每个用例一个独立仓库。 */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpRoot, 'repo-'));
  git(repo, ['init', '-q']);
  return repo;
}

function git(cwd: string, args: string[], dates: Record<string, string> = {}): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: { ...GIT_ENV, ...dates }, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** 提交一个文件,返回 7 位短哈希(与脚本口径一致)。 */
function commit(repo: string, subject: string, date: string, body?: string): string {
  writeFileSync(join(repo, 'f.txt'), `${Math.random()}\n`);
  git(repo, ['add', '-A']);
  git(
    repo,
    ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  return git(repo, ['rev-parse', '--short=7', 'HEAD']);
}

function writeChangelog(repo: string, unreleased: string, versionSection: string): void {
  writeFileSync(
    join(repo, 'CHANGELOG.md'),
    `## [Unreleased]\n\n${unreleased}\n\n## [1.2.0] - ${VERSION_DATE}\n\n${versionSection}\n`,
  );
}

/** STRICT 模式跑脚本本体。 */
function runSync(repo: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    env: { ...process.env, STRICT: '1' },
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/**
 * 版本日当天、当前时刻往前 3 小时的时刻。
 * git 把裸日期解释成「该日的当前时刻」,所以裸日期窗口看不到这个提交,零点窗口看得到——
 * 无论测试在一天里的什么时候跑,结论都稳定。
 */
function earlierToday(): string {
  const hour = (new Date().getHours() + 21) % 24;
  return `${VERSION_DATE}T${String(hour).padStart(2, '0')}:00:00`;
}

describe('check-changelog-sync: 版本日窗口从零点起算', () => {
  it('版本日当天、早于当前时刻的未登记修复必须被检出(裸日期窗口会空过)', () => {
    const repo = makeRepo();
    const release = commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    writeChangelog(repo, UNRELEASED_FILLER, `- fix: release prep (commits ${release})`);
    const leak = commit(repo, 'fix(security): SEC-9 leak', earlierToday());

    const r = runSync(repo);

    expect(r.status).toBe(1);
    expect(r.output).toContain(leak);
  });
});

describe('check-changelog-sync: 哈希引用即已登记,评审标签不是追踪号', () => {
  it('发版日当晚的修复,哈希已写进最近版本段,说明带 Important-1 标签 → 不报', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const fix = commit(repo, 'fix(ui): late fix', `${VERSION_DATE}T23:50:00`, '终审 Important-1');
    writeChangelog(repo, UNRELEASED_FILLER, `- **fix(ui): late fix**(commits ${fix})`);

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });

  it('次日修复的哈希写进 [Unreleased] → 视为已登记', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const fix = commit(repo, 'fix(security): SEC-13 x', '2026-01-03T10:00:00');
    writeChangelog(repo, `- fix: harden auth path (commits ${fix})\n- ${UNRELEASED_FILLER}`, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });

  it('说明里的 Minor-1 是评审标签,不按追踪号要求登记', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    commit(repo, 'fix(core): tweak', '2026-01-03T10:00:00', '审查 Minor-1');
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });

  it('正文只有署名尾行的短提交,同样不把型号字样当追踪号', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    // 最常见的短提交形态:主题之后正文只有尾行,没有别的行把它挤到第二行去
    commit(
      repo,
      'fix(core): tweak three',
      '2026-01-03T10:00:00',
      'Co-Authored-By: ZCode (GLM-5.4) <noreply@localhost>',
    );
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });

  it('全大写评审发现编号(CRITICAL-1 / NIT-2)与技术词(UTF-8 / SHA-256)不是登记键', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    commit(
      repo,
      'fix(executor): CRITICAL-1 null-safe NIT-2',
      '2026-01-03T10:00:00',
      '输出统一 UTF-8;摘要改用 SHA-256',
    );
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });

  it('窗口内不是最新的一笔,哈希引用同样算已登记(git log 记录的前导换行不得混进哈希)', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const cited = commit(repo, 'fix(security): SEC-21 x', '2026-01-03T10:00:00');
    // 再提交一笔更新的,让被引用的那笔不是 git log 输出的第一条记录
    commit(repo, 'fix(core): later tweak', '2026-01-03T11:00:00');
    writeChangelog(repo, `- fix: harden path (commits ${cited})\n- ${UNRELEASED_FILLER}`, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).not.toContain('SEC-21');
  });

  it('署名尾行(Co-Authored-By 等)是元数据,其中的型号字样不按追踪号要求登记', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    commit(
      repo,
      'fix(core): tweak two',
      '2026-01-03T10:00:00',
      '说明正文\n\nCo-Authored-By: ZCode (GLM-5.4) <noreply@localhost>',
    );
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(0);
    expect(r.output).toContain('均已登记');
  });
});

describe('check-changelog-sync: 追踪号规则未被放宽', () => {
  it('全大写追踪号未登记 → 阻断并列出该提交', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const fix = commit(repo, 'fix(security): SEC-12 harden', '2026-01-03T10:00:00');
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(1);
    expect(r.output).toContain(fix);
  });

  it('安全公告号 GHSA(段内含小写)未登记 → 阻断并列出该提交', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const fix = commit(repo, 'fix(deps): bump ws (GHSA-46jr-59jr-2xj3)', '2026-01-03T10:00:00');
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(1);
    expect(r.output).toContain(fix);
  });

  it('计划阶段号 P2-17 未登记 → 阻断并列出该提交', () => {
    const repo = makeRepo();
    commit(repo, 'fix(core): release prep', `${VERSION_DATE}T00:30:00`);
    const fix = commit(repo, 'fix(qa): P2-17 残留点补修', '2026-01-03T10:00:00');
    writeChangelog(repo, UNRELEASED_FILLER, '- fix: release prep');

    const r = runSync(repo);

    expect(r.status).toBe(1);
    expect(r.output).toContain(fix);
  });
});
