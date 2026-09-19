import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  });
});
