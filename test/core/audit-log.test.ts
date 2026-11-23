import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// logger 全模块 mock(同 mem-watchdog/memory-guard 测试惯例):rotateIfNeeded 包装器的失败
// warn 可断言,stderr 零杂音(既有 1A 用例的首次失败 warn 同走此 mock,断言不依赖 logger)。
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../../src/core/logger.js', () => ({ getLogger: () => mockLogger }));

import {
  appendAuditLine,
  readAuditLog,
  inferChangedFiles,
  suggestRollback,
  isAuditEnabled,
  isTokenRequestResult,
  getAuditFailureStats,
  recordAuditWriteFailure,
  isAuditStrict,
  getExternalAuditFile,
  compareAuditSources,
  extractAuditHint,
  AUDIT_LOG_REL,
  type AuditEntry,
} from '../../src/core/audit-log.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    trace_id: 'abcdef0123456789',
    tool: 'scene',
    action: 'save_scene',
    risk: 'write',
    ok: true,
    project_path: tmpDir,
    changed_files: ['scenes/main.tscn'],
    duration_ms: 100,
    ...over,
  };
}

// ─── appendAuditLine(appendFile 原子,修复 devtool writeFile 竞态)─────────────
describe('appendAuditLine', () => {
  it('写一条 → 文件存在 + JSON 结构正确', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    const f = join(tmpDir, ...AUDIT_LOG_REL);
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const e = JSON.parse(lines[0]!);
    expect(e.tool).toBe('scene');
    expect(e.trace_id).toBe('abcdef0123456789');
    expect(e.risk).toBe('write');
  });

  it('并发写多条 → 不丢行(appendFile 原子,修复 devtool writeFile 竞态)', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendAuditLine(tmpDir, makeEntry({ trace_id: i.toString().padStart(16, '0') }))),
    );
    const lines = readFileSync(join(tmpDir, ...AUDIT_LOG_REL), 'utf8').trim().split('\n');
    expect(lines.length).toBe(20); // 不丢行(G3 核心修复点)
  });

  // 2026-10-01:空白 projectPath 拒绝(实证教训:ToolDispatcher 测试的 '   ' project_path
  // 曾每轮全量测试在仓库根 CWD 积出 '   /.godot' 怪名目录)——拒绝且绝不建目录/落盘。
  it('空白/纯空格 projectPath → throw 且不建目录不落盘', async () => {
    for (const blank of ['', '   ', '\t']) {
      await expect(appendAuditLine(blank, makeEntry())).rejects.toThrow(/blank project_path refused/);
    }
    expect(existsSync(join(process.cwd(), '   ', ...AUDIT_LOG_REL))).toBe(false);
    expect(existsSync(join(tmpDir, ...AUDIT_LOG_REL))).toBe(false); // 正常写入也未发生
  });

  it('changed_files 超阈值截断 + truncated 标记(防 appendFile 超 PIPE_BUF)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `file${i}.gd`);
    await appendAuditLine(tmpDir, makeEntry({ changed_files: many }));
    const e = JSON.parse(readFileSync(join(tmpDir, ...AUDIT_LOG_REL), 'utf8'));
    expect(e.changed_files.length).toBe(50); // MAX_CHANGED_FILES
    expect(e.details.truncated).toBe(true);
  });
});

// ─── readAuditLog(只读统计,不真重放)──────────────────────────────────────────
describe('readAuditLog', () => {
  it('空(无文件)→ empty summary', async () => {
    const s = await readAuditLog(tmpDir);
    expect(s.totalEntries).toBe(0);
    expect(s.entries).toEqual([]);
    expect(s.riskHighlights).toEqual([]);
  });

  it('有数据 → 统计正确(operationCounts/changedFileCounts/riskHighlights)', async () => {
    await appendAuditLine(tmpDir, makeEntry({ action: 'save_scene', changed_files: ['main.tscn'] }));
    await appendAuditLine(
      tmpDir,
      makeEntry({ action: 'delete_node', risk: 'destructive', ok: false, changed_files: [] }),
    );
    const s = await readAuditLog(tmpDir);
    expect(s.totalEntries).toBe(2);
    expect(s.operationCounts['scene.save_scene']).toBe(1);
    expect(s.operationCounts['scene.delete_node']).toBe(1);
    expect(s.changedFileCounts['main.tscn']).toBe(1);
    expect(s.riskHighlights.length).toBe(1); // delete_node(destructive + failed)
    expect(s.riskHighlights[0]!.reason).toContain('destructive');
  });

  it('limit 取末尾 N 条', async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditLine(tmpDir, makeEntry({ trace_id: i.toString().padStart(16, '0') }));
    }
    const s = await readAuditLog(tmpDir, { limit: 2 });
    expect(s.entries.length).toBe(2);
  });
});

// ─── inferChangedFiles(阶段1 args 推断 + PII 相对化)────────────────────────────
describe('inferChangedFiles', () => {
  it('scene_path 推断 + 绝对路径相对化', () => {
    const { files } = inferChangedFiles(
      'scene',
      'save_scene',
      { scene_path: join(tmpDir, 'scenes/main.tscn'), foo: 'bar' },
      tmpDir,
    );
    expect(files).toEqual(['scenes/main.tscn']); // 相对化
  });

  it('PII 护栏:绝对路径相对化,不含项目根前缀(用户名)', () => {
    const { files } = inferChangedFiles(
      'script',
      'edit_script',
      { script_path: join(tmpDir, 'scripts/player.gd') },
      tmpDir,
    );
    expect(files[0]).toBe('scripts/player.gd');
    expect(files[0]).not.toContain(tmpDir); // 不含绝对前缀
  });

  it('批量 action(project_replace/create_project)→ batch 标记', () => {
    const { batch } = inferChangedFiles('script', 'project_replace', { project_path: tmpDir }, tmpDir);
    expect(batch).toBe(true);
  });

  it('无路径字段 → 空(files[])', () => {
    const { files } = inferChangedFiles('scene', 'get_scene', { project_path: tmpDir }, tmpDir);
    expect(files).toEqual([]);
  });
});

// ─── suggestRollback(诚实:create 可删 / project before / 其余 Git)────────────
describe('suggestRollback(诚实回滚)', () => {
  it('create 类 → supported(suggest 删除文件)', () => {
    const r = suggestRollback(makeEntry({ action: 'create_scene', changed_files: ['scenes/new.tscn'] }));
    expect(r.supported).toBe(true);
    expect(r.suggestions[0]).toContain('删除');
  });

  it('project + before_values → supported(从 before 恢复)', () => {
    const r = suggestRollback(
      makeEntry({ tool: 'project', action: 'set_setting', details: { before_values: { x: 1 } } }),
    );
    expect(r.supported).toBe(true);
  });

  it('destructive/delete → 不 supported,靠 Git', () => {
    const r = suggestRollback(makeEntry({ action: 'delete_node', risk: 'destructive' }));
    expect(r.supported).toBe(false);
    expect(r.suggestions[0]).toContain('Git');
  });

  it('write/modify → 不 supported,靠 Git', () => {
    const r = suggestRollback(makeEntry({ action: 'edit_script', risk: 'write' }));
    expect(r.supported).toBe(false);
  });
});

// ─── isTokenRequestResult(B-1 修复:令牌请求响应检测)──────────────────────────
describe('isTokenRequestResult(B-1:令牌请求响应→跳过虚假审计)', () => {
  it('令牌响应(requires_confirmation:true)→ true(audit 应跳过)', () => {
    expect(
      isTokenRequestResult({
        content: [{ type: 'text', text: '{"requires_confirmation":true,"confirmation_token":"abc"}' }],
      }),
    ).toBe(true);
  });

  it('三审遗留3收紧:正文伪造 requires_confirmation 子串但无 confirmation_token → false(照常记审计)', () => {
    // 真实令牌响应两键恒同现(ToolDispatcher 确认门);单子串不构成令牌请求,
    // 与 tool-circuit-breaker isConfirmationRequest 同口径
    expect(
      isTokenRequestResult({
        content: [{ type: 'text', text: 'doc says the literal marker "requires_confirmation":true must not appear' }],
      }),
    ).toBe(false);
  });

  it('普通成功响应 → false(audit 正常记录)', () => {
    expect(
      isTokenRequestResult({ content: [{ type: 'text', text: '{"success":true,"data":{}}' }] }),
    ).toBe(false);
  });

  it('错误响应 → false(audit 记录失败)', () => {
    expect(
      isTokenRequestResult({ content: [{ type: 'text', text: '{"success":false,"error":"x"}' }] }),
    ).toBe(false);
  });

  it('空 content → false', () => {
    expect(isTokenRequestResult({})).toBe(false);
  });
});
describe('isAuditEnabled', () => {
  it('默认 true(未设 env)', () => {
    delete process.env.GODOT_MCP_AUDIT;
    expect(isAuditEnabled()).toBe(true);
  });

  it('GODOT_MCP_AUDIT=false → 关', () => {
    process.env.GODOT_MCP_AUDIT = 'false';
    expect(isAuditEnabled()).toBe(false);
    delete process.env.GODOT_MCP_AUDIT;
  });

  it('GODOT_MCP_AUDIT=0 → 关', () => {
    process.env.GODOT_MCP_AUDIT = '0';
    expect(isAuditEnabled()).toBe(false);
    delete process.env.GODOT_MCP_AUDIT;
  });
});

// ─── 1A (2026-09-19 安全加固批1): 审计写入失败可观测 + STRICT 可选阻断 ──────────
describe('audit failure observability (1A)', () => {
  it('recordAuditWriteFailure 递增计数 + 记录最近错误消息', () => {
    const before = getAuditFailureStats();
    recordAuditWriteFailure(new Error('disk full'));
    const after = getAuditFailureStats();
    expect(after.failures).toBe(before.failures + 1);
    expect(after.lastError).toBe('disk full');
    // 非 Error 对象也兼容(String 化)
    recordAuditWriteFailure('boom');
    expect(getAuditFailureStats().failures).toBe(after.failures + 1);
    expect(getAuditFailureStats().lastError).toBe('boom');
  });

  it('isAuditStrict: 默认 false,GODOT_MCP_AUDIT_STRICT=true → true', () => {
    delete process.env.GODOT_MCP_AUDIT_STRICT;
    expect(isAuditStrict()).toBe(false);
    process.env.GODOT_MCP_AUDIT_STRICT = 'true';
    expect(isAuditStrict()).toBe(true);
    delete process.env.GODOT_MCP_AUDIT_STRICT;
  });
});

// ─── 2A (2026-09-19 安全加固批2): 外置副本双写(防篡改) ────────────────────────
// env GODOT_MCP_AUDIT_EXTERNAL_DIR 由 test/setup.js 全局重定向到临时目录(测试隔离)。
describe('external audit copy (2A)', () => {
  it('appendAuditLine 双写:项目内与外置副本内容一致', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    const ext = getExternalAuditFile(tmpDir);
    expect(existsSync(ext)).toBe(true);
    const projectSide = await readAuditLog(tmpDir);
    const externalSide = await readAuditLog(tmpDir, { external: true });
    expect(externalSide.totalEntries).toBe(projectSide.totalEntries);
    expect(externalSide.entries[0]?.tool).toBe('scene');
    expect(externalSide.entries[0]?.risk).toBe('write');
  });

  it('同项目路径分隔符归一:反斜杠与正斜杠 hash 到同一外置文件', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    const a = getExternalAuditFile(tmpDir);
    const b = getExternalAuditFile(tmpDir.replaceAll('\\', '/'));
    expect(a).toBe(b);
  });

  it('I-1(审查): win32 大小写漂移归一到同一外置文件(防 divergence 漏报)', async () => {
    // Windows 文件系统大小写不敏感:同一项目的 D:\GitHub\Demo 与 d:\github\demo 拼写
    // 应 hash 到同一外置文件——否则外置分裂且 compareAuditSources 恒 false(篡改漏报)
    const a = getExternalAuditFile('D:\\GitHub\\DemoProj');
    const b = getExternalAuditFile('d:\\github\\demoproj');
    if (process.platform === 'win32') {
      expect(a).toBe(b);
    } else {
      // Linux 大小写敏感:不同拼写是不同 key(无条件小写会碰撞不同项目)
      expect(a).not.toBe(b);
    }
  });

  it('compareAuditSources: 项目内副本被整行删(文件删除)→ diverged=true 篡改信号', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    await appendAuditLine(tmpDir, makeEntry());
    // 一致时
    const before = await compareAuditSources(tmpDir);
    expect(before.diverged).toBe(false);
    expect(before.projectEntries).toBe(2);
    expect(before.externalEntries).toBe(2);
    // 模拟项目内被删改(受沙箱约束的执行流删得到项目内副本,删不到外置)
    rmSync(join(tmpDir, ...AUDIT_LOG_REL));
    const afterD = await compareAuditSources(tmpDir);
    expect(afterD.projectEntries).toBe(0);
    expect(afterD.externalEntries).toBe(2);
    expect(afterD.diverged).toBe(true);
    // 批5-T11: 行数差形态 → divergenceKind='length',首异行=较短方长度+1
    expect(afterD.divergenceKind).toBe('length');
    expect(afterD.firstDivergentLine).toBe(1);
  });

  it('批5-T11: 篡改项目内副本单行字段(不删行)→ divergenceKind=content 检出(批4 前不可检测形态)', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    await appendAuditLine(tmpDir, makeEntry());
    await appendAuditLine(tmpDir, makeEntry());
    // 篡改第 2 行:改 trace_id 字段(冒充别的操作)/不删行——旧"单向行数比对"恒漏报
    // (注意 makeEntry 各条内容相同,篡改值必须与原值必然不同)
    const auditPath = join(tmpDir, ...AUDIT_LOG_REL);
    const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const tampered = JSON.parse(lines[1]!) as { trace_id: string };
    tampered.trace_id = 'tampered-trace-id-0000';
    lines[1] = JSON.stringify(tampered);
    writeFileSync(auditPath, lines.join('\n') + '\n', 'utf8');
    const d = await compareAuditSources(tmpDir);
    expect(d.diverged).toBe(true);
    expect(d.divergenceKind).toBe('content');
    expect(d.firstDivergentLine).toBe(2);
    expect(d.projectEntries).toBe(3);
    expect(d.externalEntries).toBe(3);  // 行数一致——旧行数比对对此形态恒 false
  });
});

// ─── 批5-T12: 大小轮转 + 流式读(rotatedFiles 计数) ───────────────────────────

describe('批5-T12: 轮转与流式读', () => {
  it('rotateIfNeeded: 超阈值文件链式轮转(.jsonl→.1,再超→.2),小文件 no-op', async () => {
    const { rotateIfNeeded, AUDIT_ROTATE_SIZE, AUDIT_ROTATE_KEEP } = await import('../../src/core/audit-log.js');
    const rotDir = mkdtempSync(join(tmpdir(), 'gme-rot-'));
    try {
      const main = join(rotDir, 'audit.jsonl');
      // 小文件 no-op
      writeFileSync(main, 'small', 'utf8');
      await rotateIfNeeded(main);
      expect(existsSync(main)).toBe(true);
      expect(existsSync(`${main}.1`)).toBe(false);
      // 超阈值 → .jsonl → .jsonl.1
      const big = 'x'.repeat(AUDIT_ROTATE_SIZE + 1);
      writeFileSync(main, big, 'utf8');
      await rotateIfNeeded(main);
      expect(existsSync(`${main}.1`)).toBe(true);
      expect(existsSync(main)).toBe(false);  // 主文件已被 rename 走
      // 再写超阈值主文件 → .1→.2 链式
      writeFileSync(main, big, 'utf8');
      await rotateIfNeeded(main);
      expect(existsSync(`${main}.1`)).toBe(true);
      expect(existsSync(`${main}.2`)).toBe(true);
      expect(AUDIT_ROTATE_KEEP).toBe(3);
    } finally {
      rmSync(rotDir, { recursive: true, force: true });
    }
  });

  // L-14(2026-10-22 审查第二轮): 跨进程轮转锁——持锁者存活则跳过本轮轮转,
  // 死亡 pid 的陈旧锁被覆盖;轮转后锁文件释放。
  it('rotateIfNeeded L-14: 活 pid 持锁跳过轮转;陈旧锁(死 pid)覆盖后正常轮转并释放锁', async () => {
    const { rotateIfNeeded, AUDIT_ROTATE_SIZE } = await import('../../src/core/audit-log.js');
    const rotDir = mkdtempSync(join(tmpdir(), 'gme-rot-l14-'));
    try {
      const main = join(rotDir, 'audit.jsonl');
      const big = 'x'.repeat(AUDIT_ROTATE_SIZE + 1);
      writeFileSync(main, big, 'utf8');

      // ① 活 pid 持锁(用本进程 pid 模拟"他人存活"路径之外的真持有者:找系统存活进程
      //    —— Windows 上 pid 4(System)恒活;POSIX 上 pid 1(init)恒活)
      const liveForeignPid = process.platform === 'win32' ? 4 : 1;
      writeFileSync(`${main}.lock`, String(liveForeignPid), 'utf8');
      await rotateIfNeeded(main);
      expect(existsSync(main)).toBe(true);            // 未轮转(他人持锁)
      expect(existsSync(`${main}.1`)).toBe(false);

      // ② 陈旧锁(死 pid):Windows 上大数值 pid 几乎必不存在;POSIX 用负相邻规避
      const deadPid = process.platform === 'win32' ? 99999999 : -999999;
      writeFileSync(`${main}.lock`, String(deadPid), 'utf8');
      await rotateIfNeeded(main);
      expect(existsSync(`${main}.1`)).toBe(true);     // 覆盖陈旧锁完成轮转
      expect(existsSync(main)).toBe(false);
      expect(existsSync(`${main}.lock`)).toBe(false); // 锁已释放
    } finally {
      rmSync(rotDir, { recursive: true, force: true });
    }
  });

  it('readAuditLog: rotatedFiles 计数主文件旁轮转代(流式读回归由既有统计用例覆盖)', async () => {
    await appendAuditLine(tmpDir, makeEntry());
    // 手工造一个轮转代文件(模拟历史轮转产物)
    mkdirSync(join(tmpDir, ...AUDIT_LOG_REL.slice(0, -1)), { recursive: true });
    writeFileSync(join(tmpDir, ...AUDIT_LOG_REL) + '.1', '', 'utf8');
    const summary = await readAuditLog(tmpDir);
    expect(summary.rotatedFiles).toBe(1);
    expect(summary.totalEntries).toBe(1);  // 主文件条目仍可读(流式)
  });

  it('批5-N-b: parseErrors 统计在流式读下正确(非法 JSON 行计入,空行不计)', async () => {
    const auditPath = join(tmpDir, ...AUDIT_LOG_REL);
    mkdirSync(join(tmpDir, ...AUDIT_LOG_REL.slice(0, -1)), { recursive: true });
    writeFileSync(auditPath, [
      'not-json-at-all',
      '',                                        // 空行不计 parseErrors(与旧 filter(Boolean) 一致)
      JSON.stringify(makeEntry()),
      '{"broken": ',                             // 半截 JSON 计入
    ].join('\n') + '\n', 'utf8');
    const summary = await readAuditLog(tmpDir);
    expect(summary.parseErrors).toBe(2);         // 批5 审查 N-b:此前全仓零断言,仅读码确认
    expect(summary.totalEntries).toBe(1);        // 合法行仍可读
  });

  it('批5-N-c: 端到端——超阈值审计文件 + appendAuditLine 触发轮转,新主文件可读且 .1 保留旧内容', async () => {
    const { AUDIT_ROTATE_SIZE } = await import('../../src/core/audit-log.js');
    const auditPath = join(tmpDir, ...AUDIT_LOG_REL);
    mkdirSync(join(tmpDir, ...AUDIT_LOG_REL.slice(0, -1)), { recursive: true });
    // 造超阈值主文件(旧内容,一行大 JSON 撑过 10MB)
    const oldBig = JSON.stringify({ ...makeEntry({ trace_id: 'old-era-entry' }), pad: 'x'.repeat(AUDIT_ROTATE_SIZE) });
    writeFileSync(auditPath, oldBig + '\n', 'utf8');
    // append 触发轮转:旧内容 → .1,新行落进重建的主文件
    await appendAuditLine(tmpDir, makeEntry({ trace_id: 'post-rotate-entry' }));
    expect(existsSync(`${auditPath}.1`)).toBe(true);
    const main = readFileSync(auditPath, 'utf8').trim();
    expect(main).toContain('post-rotate-entry');
    expect(main).not.toContain('old-era-entry');
    expect(readFileSync(`${auditPath}.1`, 'utf8')).toContain('old-era-entry');
    // 轮转后 readAuditLog 读新主文件(集成:append→rotate→read 全链路)
    const summary = await readAuditLog(tmpDir);
    expect(summary.totalEntries).toBe(1);
    expect(summary.entries[0]!.trace_id).toBe('post-rotate-entry');
    expect(summary.rotatedFiles).toBeGreaterThanOrEqual(1);
  });
});

// ─── memory-guard 四期 Task 5: rotateIfNeeded 参数化 + machine-audit 补轮转 ──────
// 采样通道(~/.godot-mcp/memory-guard-events.jsonl,8MB×4 代)复用审计轮转机制:阈值与
// 代数从常量抽成参数(rotateIfNeededWith),锁/代际/失败语义逐行保留;原 rotateIfNeeded
// 委托默认参数,对外行为不变。失败信号经返回值暴露给调用方(采样通道走 warnSampleFailOnce
// + 重试标志,不计审计失败统计——两通道口径独立)。

describe('rotateIfNeededWith 参数化(四期 Task 5)', () => {
  let rotDir: string;
  beforeEach(() => {
    rotDir = mkdtempSync(join(tmpdir(), 'gme-rotw-'));
  });
  afterEach(() => {
    rmSync(rotDir, { recursive: true, force: true });
  });

  it('阈值与代数走参数:9MB 文件对 8MB 阈值轮转;同文件经 rotateIfNeeded(默认 10MB 阈值)no-op', async () => {
    const { rotateIfNeeded, rotateIfNeededWith } = await import('../../src/core/audit-log.js');
    const main = join(rotDir, 'events.jsonl');
    writeFileSync(main, 'x'.repeat(9 * 1024 * 1024), 'utf8');
    // 包装器默认阈值(AUDIT_ROTATE_SIZE=10MB)下 9MB 未超 → no-op(对外行为不变)
    await rotateIfNeeded(main);
    expect(existsSync(main)).toBe(true);
    expect(existsSync(`${main}.1`)).toBe(false);
    // 参数化阈值 8MB:9MB 超 → 轮转
    expect(await rotateIfNeededWith(main, 8 * 1024 * 1024, 4)).toEqual({ outcome: 'rotated' });
    expect(existsSync(main)).toBe(false);
    expect(existsSync(`${main}.1`)).toBe(true);
  });

  it('keepGens=4:逐代链式后移(主→.1→.2→.3→.4),第 5 次轮转删除最老一代(gen0 消失,.5 永不出现)', async () => {
    const { rotateIfNeededWith } = await import('../../src/core/audit-log.js');
    const main = join(rotDir, 'events.jsonl');
    const read = (i: number): string => readFileSync(`${main}.${i}`, 'utf8');
    for (let gen = 0; gen < 5; gen++) {
      writeFileSync(main, `gen${gen}`, 'utf8');
      // 阈值 1 字节:每代都超限——用内容标记逐代追踪链式后移,免造 4×8MB 大文件
      expect(await rotateIfNeededWith(main, 1, 4)).toEqual({ outcome: 'rotated' });
    }
    expect(existsSync(main)).toBe(false);  // 主文件已 rename 走
    expect(read(1)).toBe('gen4');
    expect(read(2)).toBe('gen3');
    expect(read(3)).toBe('gen2');
    expect(read(4)).toBe('gen1');          // 第 5 次轮转先 rm(.4=gen0) 再整体后移
    expect(existsSync(`${main}.5`)).toBe(false);
    expect(existsSync(`${main}.lock`)).toBe(false); // 轮转后锁释放
  });

  it('keepGens=1:退化为单备份——.1 恒为上一代,.2 永不出现', async () => {
    const { rotateIfNeededWith } = await import('../../src/core/audit-log.js');
    const main = join(rotDir, 'events.jsonl');
    for (const gen of ['a', 'b']) {
      writeFileSync(main, gen, 'utf8');
      await rotateIfNeededWith(main, 1, 1);
    }
    expect(readFileSync(`${main}.1`, 'utf8')).toBe('b');
    expect(existsSync(`${main}.2`)).toBe(false);
  });

  it('结果三态:文件缺失/低于阈值 → skipped;活 pid 持锁 → skipped(他人正转,非失败);轮转动作抛错 → failed 并携带 error', async () => {
    const { rotateIfNeededWith } = await import('../../src/core/audit-log.js');
    const main = join(rotDir, 'events.jsonl');
    expect(await rotateIfNeededWith(main, 1, 4)).toEqual({ outcome: 'skipped' }); // 文件不存在(首条)
    writeFileSync(main, 'x', 'utf8');
    expect(await rotateIfNeededWith(main, 10, 4)).toEqual({ outcome: 'skipped' }); // 低于阈值
    writeFileSync(main, 'xxxxxxxx', 'utf8');
    // 活 pid 持锁:Windows pid 4(System)/POSIX pid 1(init) 恒活(同 L-14 用例取法)
    const liveForeignPid = process.platform === 'win32' ? 4 : 1;
    writeFileSync(`${main}.lock`, String(liveForeignPid), 'utf8');
    expect(await rotateIfNeededWith(main, 1, 4)).toEqual({ outcome: 'skipped' });
    expect(existsSync(main)).toBe(true);            // 他人持锁 → 本轮不转
    rmSync(`${main}.lock`);
    // 轮转动作抛错:最老代位置放一个目录——rm(无 recursive)对目录必抛(两平台 EISDIR)
    mkdirSync(`${main}.4`);
    const r = await rotateIfNeededWith(main, 1, 4);
    expect(r.outcome).toBe('failed');
    expect(r.error).toBeInstanceOf(Error);
    expect(existsSync(main)).toBe(true);            // 主文件未被动
    expect(existsSync(`${main}.lock`)).toBe(false); // 失败路径锁仍释放(finally)
  });

  it('rotateIfNeeded 包装器:轮转失败不 reject + recordAuditWriteFailure 计数并记 lastError(对外行为不变)', async () => {
    const { rotateIfNeeded, getAuditFailureStats, AUDIT_ROTATE_SIZE, AUDIT_ROTATE_KEEP } = await import('../../src/core/audit-log.js');
    const main = join(rotDir, 'audit.jsonl');
    writeFileSync(main, 'x'.repeat(AUDIT_ROTATE_SIZE + 1), 'utf8'); // 超默认阈值 → 进轮转
    mkdirSync(`${main}.${AUDIT_ROTATE_KEEP}`); // 最老代位置放目录 → rm 抛 → 轮转失败
    const before = getAuditFailureStats().failures;
    await expect(rotateIfNeeded(main)).resolves.toBeUndefined(); // 不 reject(best-effort)
    expect(getAuditFailureStats().failures).toBe(before + 1);
    expect(getAuditFailureStats().lastError).not.toBe('');
    expect(mockLogger.warn).toHaveBeenCalledWith('audit', expect.stringContaining('rotate failed for')); // warn 照旧
  });
});

describe('appendMachineAuditLine 轮转(四期 Task 5 补轮转债)', () => {
  it('GODOT_MCP_MACHINE_AUDIT_FILE 覆盖路径;追加前超 10MB 触发轮转(旧内容→.1,新行进重建的主文件)', async () => {
    const { appendMachineAuditLine, getMachineAuditFile, AUDIT_ROTATE_SIZE } = await import('../../src/core/audit-log.js');
    const auditPath = join(tmpDir, 'machine-audit.jsonl');
    vi.stubEnv('GODOT_MCP_MACHINE_AUDIT_FILE', auditPath);
    try {
      expect(getMachineAuditFile()).toBe(auditPath);
      // 造超阈值主文件(旧内容,一行大 JSON 撑过 10MB)
      const oldBig = JSON.stringify({ marker: 'old-era-entry', pad: 'x'.repeat(AUDIT_ROTATE_SIZE) });
      writeFileSync(auditPath, oldBig + '\n', 'utf8');
      await appendMachineAuditLine({
        trace_id: 'memguard', tool: 'memory-guard', action: 'budget_kill', risk: 'process',
        ok: true, project_path: 'D:/proj', changed_files: [], duration_ms: 0,
        details: { leaseId: 'L1' },
      });
      expect(existsSync(`${auditPath}.1`)).toBe(true);
      expect(readFileSync(`${auditPath}.1`, 'utf8')).toContain('old-era-entry');
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'memory-guard', action: 'budget_kill', details: { leaseId: 'L1' } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ─── 批4-T3(五维评估 P1): extractAuditHint 工具→审计上报通道 ─────────────────

describe('extractAuditHint(批4-T3)', () => {
  it('合法 _audit.before_values → 提取 hint + 返回剥离 _audit 的 result', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { status: 'ok', _audit: { before_values: { 'application/config/name': 'Old' } } },
    };
    const { hint, result: cleaned } = extractAuditHint(result);
    expect(hint).toEqual({ before_values: { 'application/config/name': 'Old' } });
    // 剥离:cleaned 不含 _audit,其余字段保留;原对象不被 mutate
    expect((cleaned.structuredContent as Record<string, unknown>)?._audit).toBeUndefined();
    expect((cleaned.structuredContent as Record<string, unknown>)?.status).toBe('ok');
    expect((result.structuredContent as Record<string, unknown>)?._audit).toBeDefined();
  });

  it('无 structuredContent / _audit 非对象 / 无 before_values → 原样返回无 hint', () => {
    expect(extractAuditHint({ content: [] }).hint).toBeUndefined();
    expect(extractAuditHint({ content: [], structuredContent: { _audit: 'nope' } }).hint).toBeUndefined();
    expect(extractAuditHint({ content: [], structuredContent: { _audit: {} } }).hint).toBeUndefined();
    expect(extractAuditHint({ content: [], structuredContent: { other: 1 } }).hint).toBeUndefined();
  });
});
