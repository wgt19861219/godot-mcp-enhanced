// test/web-gui/kb-api.test.ts
// 知识库联动逻辑层(2026-10-08 批):项目目录判定/活跃看板(项目待办派 vs 活跃看板派)/
// 计数口径(frontmatter 优先,全文复选框兜底)/最近日志/CLAUDE.md 映射解析/断流检测/
// readFile 防穿越+大小上限/未配置态。fixture 全部 mkdtemp 隔离;git 注入 fake 不真 spawn。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbApi, parseFrontmatterHead, parseRepoMapLine, mapLimit, KbError, STALL_THRESHOLD_DAYS, RECENT_COMMIT_WINDOW_DAYS } from '../../src/web-gui/kb-api.js';

/** 建一个含两类项目目录 + 映射表 + 假 git 仓库的 vault fixture。
 *  返回 { vault, repoA, repoB }——repoA 带 .git(映射命中且可查 commit),repoB 映射
 *  命中但无 .git(lastCommitDate=null),未建目录的 repoPath 不存在(不查)。 */
async function buildVault(root: string): Promise<{ vault: string; repoA: string; repoB: string }> {
  const vault = join(root, 'vault');
  const repoA = join(root, 'RepoA');
  const repoB = join(root, 'RepoB');
  await mkdir(join(vault, 'ProjA', '开发日志'), { recursive: true });
  await mkdir(join(vault, 'ProjB', '开发日志'), { recursive: true });
  await mkdir(join(vault, 'ProjC'), { recursive: true });
  await mkdir(join(vault, '杂项'), { recursive: true });
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await mkdir(join(repoA, '.git'), { recursive: true });

  // 映射表:ProjA→repoA(正常行)、ProjB→repoB(带中文附注行)、ProjC→不存在路径、
  // 一行格式异常(无反引号)与一行 kbDir 带尾斜杠——解析容错面。
  await writeFile(join(vault, 'CLAUDE.md'), [
    '# CLAUDE.md', '',
    '## 项目目录映射', '',
    '| 代码仓库路径 | 知识库目录 |',
    '|-------------|-----------|',
    `| \`${repoA}\` | \`ProjA/\` |`,
    `| \`${repoB}\`（附注:测试行） | \`ProjB/\` |`,
    '| 无反引号行 | 应跳过 |',
    `| \`${join(root, 'nowhere')}\` | \`ProjC/\` |`,
    '',
  ].join('\n'), 'utf-8');

  // ProjA:项目待办派——任务看板已归档,项目待办活跃且无 frontmatter 计数(全文计数口径)。
  await writeFile(join(vault, 'ProjA', '任务看板.md'), [
    '---', 'status: archived', 'total: 99', 'done: 99', '---', '# 已归档看板',
  ].join('\n'), 'utf-8');
  await writeFile(join(vault, 'ProjA', '项目待办.md'), [
    '---', 'date: 2026-07-22', 'project: proj-a', '---', '# 项目待办',
    '> [!abstract] 2026-09-01 批次一摘要',
    '- [x] 已完成任务一',
    '- [x] 已完成任务二',
    '- [ ] 待办甲',
    '- [ ] 待办乙',
    '- [ ] 待办丙',
    '## 分区标题(非 callout)',
  ].join('\n'), 'utf-8');
  await writeFile(join(vault, 'ProjA', '开发日志', '2026-09-28 旧批次.md'), '---\nstatus: done\n---\n旧', 'utf-8');
  await writeFile(join(vault, 'ProjA', '开发日志', '2026-10-01 新批次.md'), '---\nstatus: done\n---\n新', 'utf-8');
  await writeFile(join(vault, 'ProjA', '开发日志', 'readme.txt'), '非日期文件,列表应忽略', 'utf-8');

  // ProjB:活跃看板派——任务看板 frontmatter 带计数,无项目待办。
  await writeFile(join(vault, 'ProjB', '任务看板.md'), [
    '---', 'type: 任务看板', 'total: 10', 'done: 4', 'status: active', '---', '# 看板',
    '## 🔄 进行中', '- [ ] 某任务',
  ].join('\n'), 'utf-8');
  await writeFile(join(vault, 'ProjB', '开发日志', '2026-10-08 今日.md'), '---\nstatus: done\n---\n正文', 'utf-8');

  // ProjC:仅首页(最小项目目录形态;映射到不存在的 repoPath → 不查 git)。
  await writeFile(join(vault, 'ProjC', 'C 首页.md'), '---\nstatus: active\n---\n# C', 'utf-8');

  // 杂项:无任何知识库特征文件 → 非项目目录;.obsidian 隐藏目录 → 跳过。
  await writeFile(join(vault, '杂项', 'readme.md'), '非项目', 'utf-8');
  await writeFile(join(vault, '.obsidian', 'app.json'), '{}', 'utf-8');
  return { vault, repoA, repoB };
}

describe('KbApi(逻辑层)', () => {
  let root = '';
  let vault = '';
  let repoA = '';
  let repoB = '';
  let savedEnv: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-api-'));
    ({ vault, repoA, repoB } = await buildVault(root));
    savedEnv = process.env.GODOT_MCP_VAULT_PATH;
    delete process.env.GODOT_MCP_VAULT_PATH;
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GODOT_MCP_VAULT_PATH;
    else process.env.GODOT_MCP_VAULT_PATH = savedEnv;
    await rm(root, { recursive: true, force: true });
  });

  const api = (gitLog?: (p: string) => Promise<string | null>) => new KbApi({ vaultDir: vault, gitLog });

  // ── 未配置态 ────────────────────────────────────────────────────────────────
  it('未配置 vault(env 缺席且未注入)→ overview configured:false;detail/readFile → not_configured', async () => {
    const a = new KbApi();
    expect(await a.overview()).toEqual({ configured: false, vaultExists: false, vaultName: '', projects: [] });
    await expect(a.projectDetail('X')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(a.readFile('X', 'a.md')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('配置了但目录不存在 → configured:true vaultExists:false projects:[]', async () => {
    const a = new KbApi({ vaultDir: join(root, 'no-such-vault') });
    const ov = await a.overview();
    expect(ov).toMatchObject({ configured: true, vaultExists: false, projects: [] });
  });

  it('env 兜底:注入缺席时读 GODOT_MCP_VAULT_PATH', async () => {
    process.env.GODOT_MCP_VAULT_PATH = vault;
    const ov = await new KbApi().overview();
    expect(ov.configured).toBe(true);
    expect(ov.vaultName).toBe('vault');
  });

  // ── overview:项目判定/看板/计数/日志/映射 ────────────────────────────────────
  it('overview:项目目录判定(ProjA/B/C 入列,杂项/.obsidian 排除)+ 看板两派 + 计数口径', async () => {
    const ov = await api().overview();
    expect(ov.configured).toBe(true);
    expect(ov.vaultExists).toBe(true);
    const names = ov.projects.map(p => p.name).sort();
    expect(names).toEqual(['ProjA', 'ProjB', 'ProjC']);
    const a = ov.projects.find(p => p.name === 'ProjA')!;
    // 项目待办派:任务看板归档被跳过,活跃看板=项目待办.md;无 frontmatter 计数 → 全文计数 2/5
    expect(a.boardFile).toBe('项目待办.md');
    expect(a.done).toBe(2);
    expect(a.total).toBe(5);
    expect(a.lastLogDate).toBe('2026-10-01');
    expect(a.lastLogTitle).toBe('新批次');
    const b = ov.projects.find(p => p.name === 'ProjB')!;
    // 活跃看板派:frontmatter 计数优先(10 total 里 done 4,不信全文)
    expect(b.boardFile).toBe('任务看板.md');
    expect(b.done).toBe(4);
    expect(b.total).toBe(10);
    expect(b.lastLogDate).toBe('2026-10-08');
    const c = ov.projects.find(p => p.name === 'ProjC')!;
    expect(c.boardFile).toBeNull();
    expect(c.done).toBeNull();
    expect(c.lastLogDate).toBeNull();
  });

  it('overview:CLAUDE.md 映射(反引号提取/附注行容错/无反引号行跳过/尾斜杠归一)', async () => {
    const ov = await api(async (p) => (p === repoA ? '2026-10-08T10:00:00+08:00' : null)).overview();
    const a = ov.projects.find(p => p.name === 'ProjA')!;
    const b = ov.projects.find(p => p.name === 'ProjB')!;
    const c = ov.projects.find(p => p.name === 'ProjC')!;
    expect(a.repoPath).toBe(repoA);          // 尾斜杠已归一为 ProjA
    expect(b.repoPath).toBe(repoB);          // 带中文附注行照常提取反引号段
    expect(c.repoPath).toBe(join(root, 'nowhere'));   // 映射到的路径不存在 → 不查 git
  });

  it('overview:断流检测——commit 晚于日志超阈值 stall:true + stallDays;同步则 false;无 git 为 null', async () => {
    const ov = await api(async (p) => (p === repoA ? '2026-10-08T10:00:00+08:00' : null)).overview();
    // repoA 有 .git:commit 2026-10-08 vs 日志 2026-10-01 → 7 天 > 3 → 断流
    const a = ov.projects.find(p => p.name === 'ProjA')!;
    expect(a.lastCommitDate).toBe('2026-10-08T10:00:00+08:00');
    expect(a.stallDays).toBe(7);
    expect(a.stall).toBe(true);
    expect(ov.projects[0]!.name).toBe('ProjA');   // 排序:断流在前
    // repoB 无 .git → lastCommitDate null → stall false(不可判,不冤枉)
    const b = ov.projects.find(p => p.name === 'ProjB')!;
    expect(b.lastCommitDate).toBeNull();
    expect(b.stall).toBe(false);  });

  it('overview:活跃度排序(2026-10-08 用户反馈)——断流最前,其余按最近活动(commit 与日志取新)倒序,死日志项目沉底', async () => {
    // 场景:ProjDead 只有半年前的死日志(原版按 lastLogDate 倒序会浮在近期项目之上);
    // ProjB 的 repoB 给一个近期 commit(活跃);ProjC 无任何信号(沉底)
    await mkdir(join(vault, 'ProjDead', '开发日志'), { recursive: true });
    await writeFile(join(vault, 'ProjDead', '开发日志', '2026-05-01 死项目.md'), '# 死', 'utf-8');
    const ov = await api(async (p) => {
      if (p === repoA) return '2026-10-08T10:00:00+08:00';   // ProjA 断流(commit 晚于日志 7 天)
      if (p === repoB) return '2026-10-07T09:00:00+08:00';    // ProjB 近期提交(活跃)
      return null;
    }).overview();
    // 断流最前;活跃(2026-10-08 日志/10-07 commit)次之;死日志(2026-05-01)沉到其后;
    // 无任何信号(ProjC)垫底
    expect(ov.projects.map(p => p.name)).toEqual(['ProjA', 'ProjB', 'ProjDead', 'ProjC']);
  });

  it('overview:有 commit 而从未有日志 → 观察窗内 stall:true / 死项目(超窗)不冤枉(审查 N-6 修正)', async () => {
    // ProjC 映射到不存在路径不查 git——给 ProjD 建真 repo(有 .git 无日志目录)
    const repoC = join(root, 'RepoC');
    await mkdir(join(repoC, '.git'), { recursive: true });
    await mkdir(join(vault, 'ProjD'), { recursive: true });
    await writeFile(join(vault, 'ProjD', 'D 首页.md'), '# D', 'utf-8');
    await writeFile(join(vault, 'CLAUDE.md'), `| \`${repoC}\` | \`ProjD\` |`, 'utf-8');
    // 10 天前的 commit(90 天观察窗内):近期还在开发却从未记录 → 断流
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const ov = await api(async () => tenDaysAgo).overview();
    const d = ov.projects.find(p => p.name === 'ProjD')!;
    expect(d.lastCommitDate).not.toBeNull();
    expect(d.lastLogDate).toBeNull();
    expect(d.stall).toBe(true);       // commit 距今 10 天(窗内)而无任何日志 → 疑似断流
    expect(d.stallDays).toBeNull();   // 无日志日期,天数差不可算
    // 100 天前的 commit(超观察窗):死项目/长期搁置,知识库从未建不算断流
    const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const ov2 = await api(async () => hundredDaysAgo).overview();
    const d2 = ov2.projects.find(p => p.name === 'ProjD')!;
    expect(d2.stall).toBe(false);
    // 1 天前的 commit(≤3 天阈值):刚起步还没来得及写日志,不冤枉
    const oneDayAgo = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const ov3 = await api(async () => oneDayAgo).overview();
    expect(ov3.projects.find(p => p.name === 'ProjD')!.stall).toBe(false);
  });

  it('overview:git 结果 TTL 缓存——同 repo 第二次查询不再调 gitLog', async () => {
    let calls = 0;
    const git = async (p: string) => { calls++; return p === repoA ? '2026-10-08T00:00:00Z' : null; };
    const a = api(git);
    await a.overview();
    await a.overview();
    expect(calls).toBe(1);   // 只查 repoA 一次,第二次 overview 走缓存
  });

  // ── projectDetail ───────────────────────────────────────────────────────────
  it('projectDetail:看板摘要(callout+## 标题)+ 日志倒序 + frontmatter status', async () => {
    const d = await api().projectDetail('ProjA');
    expect(d.name).toBe('ProjA');
    expect(d.board).not.toBeNull();
    expect(d.board!.file).toBe('项目待办.md');
    expect(d.board!.done).toBe(2);
    expect(d.board!.total).toBe(5);
    expect(d.board!.sections.map(s => s.text)).toContain('2026-09-01 批次一摘要');
    expect(d.board!.sections.map(s => s.text)).toContain('分区标题(非 callout)');
    expect(d.logs.map(l => l.date)).toEqual(['2026-10-01', '2026-09-28']);   // 倒序,非日期文件忽略
    expect(d.logs[0]!.status).toBe('done');
    expect(d.logs[0]!.file).toBe('2026-10-01 新批次.md');
  });

  it('projectDetail:不存在项目 → not_found;name 含分隔符/.. → bad_request', async () => {
    await expect(api().projectDetail('NoSuch')).rejects.toMatchObject({ code: 'not_found' });
    await expect(api().projectDetail('a/b')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(api().projectDetail('..')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(api().projectDetail('a\\b')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('项目集同源(审查 N-1):非项目目录(无知识库特征文件)detail/readFile 一律 not_found,不可探测', async () => {
    // fixture 的 杂项/ 只有 readme.md——overview 不列,detail/readFile 也拒(404 vs 200 差分面消除)
    await expect(api().projectDetail('杂项')).rejects.toMatchObject({ code: 'not_found' });
    await expect(api().readFile('杂项', 'readme.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(api().readFile('ProjC', 'x.md')).rejects.toMatchObject({ code: 'not_found' });   // 项目目录但无 开发日志/ → log dir not found
  });

  // ── readFile ────────────────────────────────────────────────────────────────
  it('readFile:正常读 + 不存在 404 + 目录 bad_request', async () => {
    const f = await api().readFile('ProjA', '2026-10-01 新批次.md');
    expect(f.content).toContain('新');
    expect(f.size).toBeGreaterThan(0);
    await expect(api().readFile('ProjA', 'nope.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(api().readFile('ProjA', '.')).rejects.toMatchObject({ code: 'bad_request' });   // 解析到日志目录本体 → is a directory
  });

  it('readFile:../ 穿越到项目根看板 → forbidden(resolveWithinRoot 链拦截)', async () => {
    await expect(api().readFile('ProjA', '../项目待办.md')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api().readFile('ProjA', '..\\项目待办.md')).rejects.toMatchObject({ code: 'forbidden' });
    // URL 编码形态的 %2e%2e 由 server 层 searchParams 已解码,同走段级 .. 拦截
    await expect(api().readFile('ProjA', 'ok/../../ProjA/开发日志/x.md')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('readFile:非 .md → bad_request;超 512KB → too_large', async () => {
    await writeFile(join(vault, 'ProjA', '开发日志', 'note.txt'), 'x', 'utf-8');
    await expect(api().readFile('ProjA', 'note.txt')).rejects.toMatchObject({ code: 'bad_request' });
    await writeFile(join(vault, 'ProjA', '开发日志', 'big.md'), 'x'.repeat(512 * 1024 + 1), 'utf-8');
    await expect(api().readFile('ProjA', 'big.md')).rejects.toMatchObject({ code: 'too_large' });
  });

  // ── 纯函数 ──────────────────────────────────────────────────────────────────
  it('parseFrontmatterHead:标量提取/重复键取首个/无 frontmatter 返回空', () => {
    expect(parseFrontmatterHead('---\nstatus: archived\nlast-updated: 2026-10-08\nlast-updated: 2026-10-09\n---\nbody')).toEqual({
      status: 'archived',
      'last-updated': '2026-10-08',   // 重复键取首个(堆叠 last-updated 容错)
    });
    expect(parseFrontmatterHead('# no frontmatter')).toEqual({});
    expect(parseFrontmatterHead('\uFEFF---\nstatus: ok\n---\n')).toEqual({ status: 'ok' });   // BOM 容错
  });

  it('parseRepoMapLine:反引号对提取/非绝对路径拒/非表格行 null', () => {
    expect(parseRepoMapLine(`| \`D:\\repo\` | \`Dir/\` |`)).toEqual({ repoPath: 'D:\\repo', kbDir: 'Dir' });
    expect(parseRepoMapLine('| `relative` | `Dir` |')).toBeNull();
    expect(parseRepoMapLine('普通行')).toBeNull();
    expect(parseRepoMapLine('| 只有 | 一对 `反引号` |')).toBeNull();
  });

  it('parseRepoMapLine:附注含反引号旧路径(真机 GodotMCP 行形态)——首对=repo 末对=kbDir,中段不误读', () => {
    // 真机回归(2026-10-08):GodotMCP 行附注带旧仓库反引号段,居中取第 2 对曾把旧路径
    // 误当 kbDir → GodotMCP 映射丢失(真机验证发现)。首末各取后:repo=新路径,kbDir=GodotMCP。
    const line = '| `D:\\GitHub\\godot-mcp-series\\godot-mcp-enhanced`（2026-08-17 更正;原记 `D:\\GitHub\\godot-mcp-enhanced` 已失效） | `GodotMCP/` |';
    expect(parseRepoMapLine(line)).toEqual({ repoPath: 'D:\\GitHub\\godot-mcp-series\\godot-mcp-enhanced', kbDir: 'GodotMCP' });
  });

  it('断流阈值常量锁定(变更须同步前端文案与文档)', () => {
    expect(STALL_THRESHOLD_DAYS).toBe(3);
    expect(RECENT_COMMIT_WINDOW_DAYS).toBe(90);   // N-6:「项目在开发」观察窗
  });

  // ── N-5 补测:mapLimit 并发 + frontmatter 截断容错 ───────────────────────────
  it('mapLimit:并发峰值不超 limit、结果保序、全量完成(审查 N-5)', async () => {
    let active = 0; let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapLimit(items, 3, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 15));
      active--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);   // 并发上限被信号量约束
    expect(peak).toBeGreaterThanOrEqual(2);   // 真并发而非串行(15ms 窗口内多 worker 同屏)
    expect(out).toEqual(items.map(n => n * 2));   // 保序
  });

  it('parseFrontmatterHead:head 截断致 --- 不闭合(8KB 上限场景)——返回已收集键不炸(审查 N-5)', () => {
    // readHead 只取前 8KB:frontmatter 体内超长导致闭合 --- 落在截断点之后
    const head = '---\nstatus: active\n' + 'x'.repeat(9 * 1024);
    expect(parseFrontmatterHead(head)).toEqual({ status: 'active' });   // 收集到的键有效
    expect(parseFrontmatterHead('---\n')).toEqual({});   // 空块同样不炸
  });

  it('看板文件超 8KB(截断区):overview 照常返回该项目的看板与计数(容错不炸,审查 N-5)', async () => {
    await mkdir(join(vault, 'ProjBig'), { recursive: true });
    await writeFile(join(vault, 'ProjBig', '项目待办.md'),
      '---\nstatus: active\n' + '<!-- ' + 'p'.repeat(20 * 1024) + ' -->\n---\n# t\n- [x] done\n- [ ] todo\n', 'utf-8');
    const ov = await api().overview();
    const big = ov.projects.find(p => p.name === 'ProjBig');
    expect(big).toBeDefined();
    expect(big!.boardFile).toBe('项目待办.md');
    expect(big!.done).toBe(1);   // frontmatter 超截断区 → 计数走全文兜底
    expect(big!.total).toBe(2);
  });

  it('KbError 形态:code + message(Error 子类,server 层按 code 映射状态码)', () => {
    const e = new KbError('forbidden', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('forbidden');
  });
});
