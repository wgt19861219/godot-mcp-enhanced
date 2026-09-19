// test/audit-tool.test.ts
// C-4 (2026-08-14): src/tools/audit.ts wrapper 直接测试。
// 库层(audit-log.ts)已有 test/core/audit-log.test.ts,但 112 行 wrapper
// (get_log limit/since 过滤、suggest_rollback entry_index 越界、project_path 解析失败)零测试。
// 用真实文件系统(临时目录)写 mcp_audit.jsonl,直接调 handleTool 断言输出 JSON。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleTool } from '../src/tools/audit.js';
import { appendAuditLine, type AuditEntry } from '../src/core/audit-log.js';
import type { ToolContext, ToolResult } from '../src/types.js';

// resolveProjectPath 默认 mock null —— 测试全部显式传 project_path(wrapper 短路不触它),
// 仅 project_path 解析失败用例依赖 null 返回。
vi.mock('../src/core/path-utils.js', () => ({
  resolveProjectPath: vi.fn().mockReturnValue(null),
  _resetProjectPathCache: vi.fn(),
}));

const ctx = {} as ToolContext; // audit handleTool 未使用 ctx(参数名 _ctx)

function makeEntry(tool: string, action: string, timestamp: string): AuditEntry {
  return {
    timestamp, trace_id: 't-c4', tool, action, risk: 'write', ok: true,
    project_path: '/p', changed_files: [], duration_ms: 1,
  };
}

/** 解析 textResult 的 content text 为 JSON */
function parse(result: ToolResult | null): Record<string, unknown> {
  const block = result?.content?.[0];
  expect(block && 'text' in block).toBe(true);
  return JSON.parse(String((block as { text: string }).text)) as Record<string, unknown>;
}

let tmp: string;
// 三条时间递增的 write 条目(供 limit/since 过滤 + suggest_rollback 断言)。
// E2 带 changed_files:create 类"可删"建议的前提是文件记录非空(audit-log suggestRollback 语义)
const E1 = makeEntry('script', 'write_script', '2026-08-14T10:00:00.000Z');
const E2: AuditEntry = {
  ...makeEntry('project', 'create', '2026-08-14T11:00:00.000Z'),
  changed_files: ['res://new_scene.tscn'],
};
const E3 = makeEntry('scene', 'save_scene', '2026-08-14T12:00:00.000Z');

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audit-tool-'));
  for (const e of [E1, E2, E3]) await appendAuditLine(tmp, e);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('audit wrapper: get_log', () => {
  it('limit 截断:totalEntries 计全量,entries 取末尾 N 条(带全局 index)', async () => {
    const res = await handleTool('audit', { action: 'get_log', project_path: tmp, limit: 2 }, ctx);
    const body = parse(res);
    expect(body.success).toBe(true);
    const data = body.data as {
      totalEntries: number;
      entries: { index: number; tool: string }[];
      // 1A (2026-09-19): 响应附进程内审计写入失败计数(结构存在性锁)
      write_failures: { failures: number; lastError: string };
    };
    expect(data.totalEntries).toBe(3); // limit 只影响 entries 窗口,统计仍计全量
    expect(data.entries.length).toBe(2);
    expect(data.entries.map((e) => e.tool)).toEqual(['project', 'scene']); // 末尾 2 条
    expect(data.entries[0]!.index).toBe(1); // 全局 index 从全量位置起算
    expect(data.entries[1]!.index).toBe(2);
    expect(typeof data.write_failures.failures).toBe('number'); // Nit-2 工具层覆盖
  });

  it('since 过滤:只看此后条目', async () => {
    const res = await handleTool(
      'audit',
      { action: 'get_log', project_path: tmp, since: '2026-08-14T11:00:00.000Z' },
      ctx,
    );
    const body = parse(res);
    const data = body.data as { totalEntries: number; entries: { tool: string }[] };
    expect(data.totalEntries).toBe(2); // E2/E3(timestamp >= since,E1 排除)
    expect(data.entries.map((e) => e.tool)).toEqual(['project', 'scene']);
  });
});

describe('audit wrapper: suggest_rollback', () => {
  it('entry_index 越界返回 NOT_FOUND 错误(非崩溃)', async () => {
    const res = await handleTool(
      'audit',
      { action: 'suggest_rollback', project_path: tmp, entry_index: 99 },
      ctx,
    );
    expect(res?.isError).toBe(true);
    const body = parse(res);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('NOT_FOUND');
    expect(String(body.error)).toContain('99');
  });

  it('entry_index 缺失返回 INVALID_PARAMS', async () => {
    const res = await handleTool('audit', { action: 'suggest_rollback', project_path: tmp }, ctx);
    expect(res?.isError).toBe(true);
    expect(parse(res).error_code).toBe('INVALID_PARAMS');
  });

  it('命中 create 类条目返回 supported=true 建议', async () => {
    const res = await handleTool(
      'audit',
      { action: 'suggest_rollback', project_path: tmp, entry_index: 1 },
      ctx,
    );
    const body = parse(res);
    expect(body.success).toBe(true);
    const data = body.data as { suggestion: { supported: boolean }; entry: { tool: string } };
    expect(data.entry.tool).toBe('project'); // index 1 = E2(project.create)
    expect(data.suggestion.supported).toBe(true);
  });
});

describe('audit wrapper: 参数与路径错误', () => {
  it('project_path 未传且解析失败 → INVALID_PARAMS', async () => {
    const res = await handleTool('audit', { action: 'get_log' }, ctx);
    expect(res?.isError).toBe(true);
    expect(parse(res).error_code).toBe('INVALID_PARAMS');
  });

  it('unknown action → INVALID_PARAMS', async () => {
    const res = await handleTool('audit', { action: 'nuke', project_path: tmp }, ctx);
    expect(res?.isError).toBe(true);
    expect(parse(res).error_code).toBe('INVALID_PARAMS');
  });

  it('非 audit 工具名 → 返 null(交回 dispatcher 路由)', async () => {
    const res = await handleTool('other_tool', { action: 'get_log' }, ctx);
    expect(res).toBeNull();
  });
});
