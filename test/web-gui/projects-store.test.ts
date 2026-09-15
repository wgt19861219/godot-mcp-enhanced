// test/web-gui/projects-store.test.ts
// Web GUI 项目面板 Task 2:projects-store(spec 2026-09-15 v2.1 §3/§3.1.1/§3.2/§8.1)
// 清单持久化(0o600+原子写)+ 白名单 BFS 扫描(限深4/跳过/5000上限/不跟链接)
// + 并发三规则(扫描互斥/串行队列+re-read 合并/last-writer-wins)+ 损坏重建。
//
// 惯例来源:
// - env 覆盖: 显式保存 + afterEach 恢复(test/web-gui/env-gate.test.ts:105-108)
// - 注入点: opts.dir/roots/now/getSessions/maxTreeEntries(简报授权的测试注入,
//   5000 上限用 maxTreeEntries 小值模拟——造 5000 真实目录不可行)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectsStore } from '../../src/web-gui/projects-store.js';
import type { ProjectEntry } from '../../src/web-gui/projects-store.js';
import { normalizeProjectKey } from '../../src/core/process-state.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

let dir: string;

/** 造一个 Godot 项目目录;configName 缺省=project.godot 无 config/name(回落 basename)。 */
function makeProject(root: string, projName: string, configName?: string): string {
  const p = join(root, projName);
  mkdirSync(p, { recursive: true });
  const lines = ['[application]'];
  if (configName !== undefined) lines.push(`config/name="${configName}"`);
  writeFileSync(join(p, 'project.godot'), lines.join('\n') + '\n');
  return p;
}

/** project.godot 的 config/name 写在 [rendering] 段内(段外,应被忽略)。 */
function makeProjectNameOutsideSection(root: string, projName: string): string {
  const p = join(root, projName);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'project.godot'), '[rendering]\nconfig/name="wrong"\n');
  return p;
}

/** 预写清单文件(绕过 store 直接落盘,构造满员等场景)。 */
function seedList(entries: ProjectEntry[]): void {
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: entries }, null, 2));
}

function makeStore(opts: Partial<ConstructorParameters<typeof ProjectsStore>[0]> = {}) {
  return new ProjectsStore({ dir, roots: () => [dir], ...opts });
}

// 钉住 UNRESTRICTED=false:开发机全局环境可能设 GODOT_MCP_UNRESTRICTED=true
// (实测污染所有 scan 用例——scanProjects 入口即拒),测试隔离必须显式覆盖。
const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'projects-store-'));
  process.env.GODOT_MCP_UNRESTRICTED = 'false';
});

afterEach(() => {
  process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
  rmSync(dir, { recursive: true, force: true });
});

// ─── 扫描边界矩阵(spec §3.2/§8.1)───────────────────────────────────────────

describe('ProjectsStore 边界矩阵(spec §3/§8.1)', () => {
  it('限深 4:第 1 层发现,第 5 层不发现;added/scanned 返回值', async () => {
    makeProject(dir, 'pA', '游戏A');
    makeProject(dir, 'pB');                                        // 无 name → basename
    mkdirSync(join(dir, 'deep1', 'deep2', 'deep3', 'deep4', 'deep5'), { recursive: true });
    writeFileSync(join(dir, 'deep1', 'deep2', 'deep3', 'deep4', 'deep5', 'project.godot'), '[application]\n');
    const store = makeStore();
    const r = await store.scanProjects();
    expect(r.started).toBe(true);
    expect(r.added).toBe(2);
    const list = await store.listProjects();
    expect(list.map(e => e.name)).toContain('游戏A');              // INI 解析
    expect(list.map(e => e.name)).toContain('pB');                 // basename 回落
    expect(list.some(e => e.path.includes('deep5'))).toBe(false);  // 第 5 层不发现
    expect(r.scanned).toBeGreaterThan(0);
  });

  it('跳过目录:node_modules/.git/.godot/build/dist 下的项目不发现', async () => {
    for (const skip of ['node_modules', '.git', '.godot', 'build', 'dist']) {
      makeProject(join(dir, skip), 'x');
    }
    const store = makeStore();
    const r = await store.scanProjects();
    expect(r.added).toBe(0);
    expect(await store.listProjects()).toHaveLength(0);
  });

  it('树条目上限剪枝:注入 maxTreeEntries=3 时宽树只入队 3 个子目录(5000 上限模拟)', async () => {
    for (let i = 0; i < 10; i++) makeProject(dir, `w${i}`);
    const store = makeStore({ maxTreeEntries: 3 });
    const r = await store.scanProjects();
    expect(r.started).toBe(true);
    expect(r.added).toBe(3);       // 只入队前 3 个子目录(readdir 序),各自发现项目
    expect(r.scanned).toBe(4);     // 根 + 3 个子目录
  });

  it.skipIf(process.platform === 'win32')('不跟随目录符号链接(POSIX):链接目标项目不发现', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'ps-link-target-'));
    try {
      const target = makeProject(outer, 'linkedProj');
      symlinkSync(target, join(dir, 'aliasToProject'));
      const store = makeStore();
      const r = await store.scanProjects();
      expect(r.added).toBe(0);
      expect(await store.listProjects()).toHaveLength(0);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('INI 解析边界:config/name 在非 [application] 段内被忽略,回落 basename', async () => {
    makeProjectNameOutsideSection(dir, 'pC');
    const store = makeStore();
    await store.scanProjects();
    const list = await store.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('pC');                              // 段外 name 不采信
  });

  it('Task1 移交(I-4):单个坏根不炸整个扫描——好根项目仍发现', async () => {
    // 不注入 roots → 走缺省链(getAllowedProjectPaths 逐条 realpath + catch-跳过)。
    // win: Q:/ 不存在盘符 → safeRealPath 全链失败抛 PathError → catch-跳过(本用例主断言面)。
    // posix: 'Q:/...' resolve 为 cwd 下不存在路径 → realpath 祖先链成功不抛 → BFS readdir
    //        ENOENT catch 跳过(仍验证"单根失败不炸扫描"的对外语义,分支不同)。
    const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
    const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
    process.env.GODOT_MCP_UNRESTRICTED = 'false';
    process.env.ALLOWED_PROJECT_PATHS = `${dir};Q:/definitely/not/exist/root`;
    try {
      makeProject(dir, 'goodProj');
      const store = new ProjectsStore({ dir });                    // 缺省 roots 链
      const r = await store.scanProjects();
      expect(r.started).toBe(true);
      expect(r.added).toBe(1);                                     // 坏根被跳过,好根正常
      const list = await store.listProjects();
      expect(list.map(e => e.name)).toContain('goodProj');
    } finally {
      process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
      process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    }
  });

  it('空根数组 → 扫描根落 process.cwd()(spec IMP-2)', async () => {
    const prevCwd = process.cwd();
    const cwdTmp = mkdtempSync(join(tmpdir(), 'ps-cwd-'));
    try {
      makeProject(cwdTmp, 'cwdProj');
      process.chdir(cwdTmp);
      const store = new ProjectsStore({ dir, roots: () => [] });
      const r = await store.scanProjects();
      expect(r.started).toBe(true);
      expect(r.added).toBe(1);
      expect((await store.listProjects()).map(e => e.name)).toContain('cwdProj');
    } finally {
      process.chdir(prevCwd);
      rmSync(cwdTmp, { recursive: true, force: true });
    }
  });

  it('UNRESTRICTED 模式拒绝扫描(提示用 add)', async () => {
    const prev = process.env.GODOT_MCP_UNRESTRICTED;
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    try {
      const store = makeStore();
      await expect(store.scanProjects()).rejects.toThrow(/UNRESTRICTED/);
    } finally {
      process.env.GODOT_MCP_UNRESTRICTED = prev;
    }
  });

  it('onProgress:每发现一个项目回调一次,found 递增', async () => {
    makeProject(dir, 'g1');
    makeProject(dir, 'g2');
    const store = makeStore();
    const calls: Array<[number, number]> = [];
    const r = await store.scanProjects((found, scanned) => calls.push([found, scanned]));
    expect(r.added).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe(1);
    expect(calls[1]![0]).toBe(2);
    expect(calls[1]![1]).toBeGreaterThan(0);
  });
});

// ─── 清单持久化(spec §3.1)────────────────────────────────────────────────

describe('ProjectsStore 清单持久化(spec §3.1)', () => {
  it('addProject:非项目路径 not_a_project;同路径 duplicate;removeProject 两态', async () => {
    const store = makeStore();
    expect(await store.addProject(join(dir, 'nope'))).toEqual({ ok: false, reason: 'not_a_project' });
    const p = makeProject(dir, 'dupProj');
    expect(await store.addProject(p)).toEqual({ ok: true });
    expect(await store.addProject(p)).toEqual({ ok: false, reason: 'duplicate' });
    expect(await store.removeProject(p)).toEqual({ ok: true });
    expect(await store.removeProject(p)).toEqual({ ok: false, reason: 'not_found' });
  });

  it.skipIf(process.platform !== 'win32')('去重键 win 大小写不敏感(normalizeProjectKey 语义)', async () => {
    const p = makeProject(dir, 'caseProj');
    const store = makeStore();
    expect(await store.addProject(p)).toEqual({ ok: true });
    // win 文件系统大小写不敏感:CASEPROJ 路径的 project.godot 同样存在,但去重键相同
    const upper = join(dir, 'CASEPROJ');
    expect(await store.addProject(upper)).toEqual({ ok: false, reason: 'duplicate' });
    // 扫描发现后再以大小写变体手动添加 → 同样 duplicate
    const store2 = makeStore();
    await store2.scanProjects();
    expect(await store2.addProject(upper)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('200 上限:只逐出 source=scan 的最旧条目,manual 豁免', async () => {
    const entries: ProjectEntry[] = [];
    for (let i = 0; i < 200; i++) {
      entries.push({
        path: join(dir, `p${String(i).padStart(3, '0')}`),
        name: `p${i}`,
        addedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),     // p000 最旧
        source: 'scan',
      });
    }
    seedList(entries);
    const outer = mkdtempSync(join(tmpdir(), 'ps-manual-'));
    try {
      const manual = makeProject(outer, 'manualKeep');
      const store = makeStore();
      expect(await store.addProject(manual)).toEqual({ ok: true });
      const list = await store.listProjects();
      expect(list).toHaveLength(200);                              // 上限不变(逐 1 加 1)
      expect(list.some(e => e.name === 'manualKeep')).toBe(true);  // manual 保留
      expect(list.some(e => e.path.endsWith('p000'))).toBe(false); // 最旧 scan 被逐
      expect(list.some(e => e.path.endsWith('p001'))).toBe(true);  // 次旧保留
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('全 manual 满员:停止添加并返回 ok:false,清单不变', async () => {
    const entries: ProjectEntry[] = [];
    for (let i = 0; i < 200; i++) {
      entries.push({ path: join(dir, `m${i}`), name: `m${i}`, addedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), source: 'manual' });
    }
    seedList(entries);
    const outer = mkdtempSync(join(tmpdir(), 'ps-full-'));
    try {
      const extra = makeProject(outer, 'extraManual');
      const store = makeStore();
      const r = await store.addProject(extra);
      expect(r.ok).toBe(false);                                    // 无 scan 可逐 → 停止添加
      const list = await store.listProjects();
      expect(list).toHaveLength(200);
      expect(list.some(e => e.name === 'extraManual')).toBe(false);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('损坏清单:JSON 解析失败 → 读取为空,后续写入正常重建(v2/M3)', async () => {
    writeFileSync(join(dir, 'projects.json'), '{corrupted!!!');
    const store = makeStore();
    expect(await store.listProjects()).toEqual([]);
    const p = makeProject(dir, 'afterFix');
    expect(await store.addProject(p)).toEqual({ ok: true });
    const list = await store.listProjects();
    expect(list).toHaveLength(1);                                  // 重建后写入正常
  });

  it('结构异常清单(projects 非 数组)→ 读取为空', async () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: 'not-an-array' }));
    const store = makeStore();
    expect(await store.listProjects()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('清单文件权限 0o600(POSIX,registry S-5 同款)', async () => {
    const p = makeProject(dir, 'permProj');
    const store = makeStore();
    await store.addProject(p);
    const st = statSync(join(dir, 'projects.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('原子写:完成后无 .tmp 残留', async () => {
    const p = makeProject(dir, 'atomicProj');
    const store = makeStore();
    await store.addProject(p);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).some(f => f.endsWith('.tmp'))).toBe(false);
    expect(readdirSync(dir)).toContain('projects.json');
  });
});

// ─── listProjects 视图(spec §3.3)──────────────────────────────────────────

describe('ProjectsStore listProjects 视图(spec §3.3)', () => {
  it('mtime 降序 + missing 沉底 + running/sessionId 对照注入会话', async () => {
    const a = makeProject(dir, 'projA');
    const b = makeProject(dir, 'projB');
    const c = makeProject(dir, 'projC');
    utimesSync(join(a, 'project.godot'), 2000, 2000);              // mtime 最新
    utimesSync(join(b, 'project.godot'), 1000, 1000);
    const store = makeStore({
      getSessions: () => [
        { projectPath: normalizeProjectKey(a), status: 'running' },
        { projectPath: normalizeProjectKey(b), status: 'exited' },
      ],
    });
    await store.addProject(a);
    await store.addProject(b);
    await store.addProject(c);
    rmSync(join(c, 'project.godot'));                              // add 后再删 → missing 沉底
    const list = await store.listProjects();
    expect(list.map(e => e.name)).toEqual(['projA', 'projB', 'projC']);
    expect(list[0]!.running).toBe(true);                           // running 会话
    expect(list[0]!.sessionId).toBe(normalizeProjectKey(a));
    expect(list[1]!.running).toBe(false);                          // exited 非 alive
    expect(list[1]!.sessionId).toBe(normalizeProjectKey(b));       // 已结束桶仍给关联键
    expect(list[2]!.missing).toBe(true);
    expect(list[2]!.mtime).toBeNull();
    expect(list[2]!.running).toBe(false);
  });

  it('getSessions 注入缺席:running 全 false、sessionId 全 null(缺省空数组)', async () => {
    const p = makeProject(dir, 'plain');
    const store = makeStore();                                     // 不注入 getSessions
    await store.addProject(p);
    const list = await store.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0]!.running).toBe(false);
    expect(list[0]!.sessionId).toBeNull();
  });
});

// ─── 并发三规则(spec §3.1.1)───────────────────────────────────────────────

describe('ProjectsStore 并发三规则(spec §3.1.1)', () => {
  it('规则1 扫描互斥:进行中再 scan 返回 {started:false, reason:"scanning"}', async () => {
    makeProject(dir, 'mutexProj');
    const store = makeStore();
    const p1 = store.scanProjects();                               // 立即进入 BFS(真实 IO await)
    const r2 = await store.scanProjects();                         // p1 未完成时到达
    expect(r2).toEqual({ started: false, reason: 'scanning' });
    const r1 = await p1;
    expect(r1.started).toBe(true);
    // 完成后单飞标志已清,可再次扫描
    const r3 = await store.scanProjects();
    expect(r3.started).toBe(true);
    expect(r3.added).toBe(0);                                      // 已在清单,合并去重
  });

  it('规则2 串行队列:并发两个 add 都保留(读改写互斥)', async () => {
    const a = makeProject(dir, 'concurrentA');
    const outer = mkdtempSync(join(tmpdir(), 'ps-conc-'));
    try {
      const b = makeProject(outer, 'concurrentB');
      const store = makeStore();
      const [ra, rb] = await Promise.all([store.addProject(a), store.addProject(b)]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
      const list = await store.listProjects();
      expect(list).toHaveLength(2);                                // 无 last-writer-wins 丢条
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('规则2 re-read:扫描期间 add 的条目在扫描合并后仍在(防旧快照覆盖丢更新)', async () => {
    // 黑盒时序:roots() 在 BFS 开始前同步调用——在其中发起 add(不 await),
    // add 与 BFS 真实并发;合并闭包 re-read 最新清单 → manual 条目不被扫描写回覆盖。
    const outer = mkdtempSync(join(tmpdir(), 'ps-race-'));
    try {
      makeProject(dir, 'scanFound');
      const manual = makeProject(outer, 'addedDuringScan');
      let store!: ProjectsStore;
      store = new ProjectsStore({
        dir,
        roots: () => {
          void store.addProject(manual);                           // BFS 前发起,不 await
          return [dir];
        },
      });
      const r = await store.scanProjects();
      expect(r.started).toBe(true);
      expect(r.added).toBe(1);                                     // scanFound 进入
      const list = await store.listProjects();
      expect(list.map(e => e.name)).toContain('scanFound');        // 扫描条目在
      expect(list.map(e => e.name)).toContain('addedDuringScan');  // 并发 add 未被覆盖丢失
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
