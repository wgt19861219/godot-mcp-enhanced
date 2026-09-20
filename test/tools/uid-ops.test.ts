// test/tools/uid-ops.test.ts — W10 批4 组B:UID 管理 TS 层单测
// 覆盖:四个 gen*Script 的生成内容关键断言(资源 UID 读写/路径转义/三种 uid_set 模式互斥分支)、
// handleTool 参数校验防线(paths 1-200/sanitizeResPath 越权拒绝/uid 格式/fix_missing 互斥)、
// trusted 通道透传(写 .uid 需 FileAccess.WRITE 全沙箱豁免)。
// 诚实边界:GDScript 侧真实执行(ResourceUID API 行为)属 e2e 面。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/gdscript-executor.js', () => ({
  executeGdscriptRuntime: vi.fn(),
  executeGdscriptTrusted: vi.fn(),
}));

import {
  handleTool, genUidScanScript, genUidGetScript, genUidSetScript, genUidCheckRefsScript,
  DEFAULT_UID_EXTENSIONS, REF_SCAN_EXTENSIONS,
} from '../../src/tools/uid-ops.js';
import { executeGdscriptTrusted } from '../../src/gdscript-executor.js';

const mockTrusted = vi.mocked(executeGdscriptTrusted);
const CTX = { findGodot: async () => '/fake/godot' } as never;

function firstJson(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text!);
}

describe('gen*Script 生成内容', () => {
  it('scan:扩展名/跳过目录注入 GD 集合字面量,双 walk(资源+uid 文件)与截断 limit', () => {
    const s = genUidScanScript(['.gd', '.tscn'], ['.git', 'build'], 50);
    expect(s).toContain('extends SceneTree');
    expect(s).toContain('".gd"');
    expect(s).toContain('".git"');
    expect(s).toContain('_mcp_walk("res://"');
    expect(s.match(/_mcp_walk\("res:\/\/"/g)).toHaveLength(2);
    expect(s).toContain('missing.slice(0, 50)');
  });

  it('get:paths 数组字面量 + not_found 分支', () => {
    const s = genUidGetScript(['res://a.gd', 'res://b.png']);
    expect(s).toContain('"res://a.gd"');
    expect(s).toContain('"res://b.png"');
    expect(s).toContain('not_found.append(res_path)');
  });

  it('set 模式① path+uid:uid 字面量转义注入 + INVALID_ID 校验分支', () => {
    const s = genUidSetScript({ path: 'res://a.gd', uid: 'uid://abc123', extensions: [], skipDirs: [] });
    expect(s).toContain('"uid://abc123"');
    expect(s).toContain('ResourceUID.text_to_id(uid_text) == ResourceUID.INVALID_ID');
    expect(s).toContain('Invalid uid text');
  });

  it('set 模式② 省略 uid:按路径确定性生成(create_id_for_path)', () => {
    const s = genUidSetScript({ path: 'res://a.gd', extensions: [], skipDirs: [] });
    expect(s).toContain('ResourceUID.create_id_for_path(res_path)');
    expect(s).not.toContain('INVALID_ID');
  });

  it('set 模式③ fix_missing:批量分支不带单文件 path 注入', () => {
    const s = genUidSetScript({ fixMissing: true, extensions: ['.gd'], skipDirs: [] });
    expect(s).not.toContain('var res_path := "res://');
    expect(s).toContain('".gd"');
  });

  it('check_refs:引用扫描扩展名集合独立于资源扫描', () => {
    expect(REF_SCAN_EXTENSIONS).not.toEqual(DEFAULT_UID_EXTENSIONS);
    const s = genUidCheckRefsScript(['.godot'], 10);
    expect(s).toContain('_mcp_walk');
  });
});

describe('handleTool 参数防线', () => {
  beforeEach(() => { mockTrusted.mockReset(); });

  it('未知 action → UNKNOWN_ACTION;缺 action → INVALID_PARAMS', async () => {
    expect(firstJson((await handleTool('uid', { project_path: '/p', action: 'x' }, CTX))!).error_code).toBe('UNKNOWN_ACTION');
    expect(firstJson((await handleTool('uid', { project_path: '/p' }, CTX))!).error_code).toBe('INVALID_PARAMS');
  });

  it('uid_get paths 越界(0/201)拒绝;非 res:// 路径拒绝(traversal 防线)', async () => {
    expect(firstJson((await handleTool('uid', { project_path: '/p', action: 'uid_get', paths: [] }, CTX))!).error_code).toBe('INVALID_PARAMS');
    const many = Array.from({ length: 201 }, (_, i) => `res://${i}.gd`);
    expect(firstJson((await handleTool('uid', { project_path: '/p', action: 'uid_get', paths: many }, CTX))!).error_code).toBe('INVALID_PARAMS');
    const r = await handleTool('uid', { project_path: '/p', action: 'uid_get', paths: ['C:/abs/escape.gd'] }, CTX);
    expect(firstJson(r!).error_code).toBe('INVALID_PARAMS');
    expect(mockTrusted).not.toHaveBeenCalled();
  });

  it('uid_set:uid 格式非法 → INVALID_UID;与 fix_missing 组合 → INVALID_PARAMS', async () => {
    const r1 = await handleTool('uid', { project_path: '/p', action: 'uid_set', path: 'res://a.gd', uid: 'not-a-uid' }, CTX);
    expect(firstJson(r1!).error_code).toBe('INVALID_UID');
    const r2 = await handleTool('uid', { project_path: '/p', action: 'uid_set', fix_missing: true, path: 'res://a.gd' }, CTX);
    expect(firstJson(r2!).error_code).toBe('INVALID_PARAMS');
  });

  it('合法 uid_set 走 trusted 通道(写 .uid 需 FileAccess.WRITE 豁免)且 timeout=60', async () => {
    mockTrusted.mockResolvedValue({
      success: true, compile_success: true, compile_error: '', errors: [],
      run_success: true, run_error: '', outputs: [], raw_output: '', duration_ms: 1,
    } as never);
    const r = await handleTool('uid', { project_path: '/p', action: 'uid_set', path: 'res://a.gd', uid: 'uid://c1234' }, CTX);
    expect(mockTrusted).toHaveBeenCalledTimes(1);
    expect(mockTrusted.mock.calls[0]![0].timeout).toBe(60);
    expect(r!.content[0]!.type).toBe('text');
  });

  it('errorMapper:not found → FILE_NOT_FOUND 映射', async () => {
    mockTrusted.mockResolvedValue({
      success: true, compile_success: true, compile_error: '', errors: [],
      run_success: true, run_error: '',
      // errorMapper 仅作用于 outputs 的 error entry(run_error 走固定 SCRIPT_EXEC_FAILED)
      outputs: [{ key: 'error', value: 'res://missing.gd not found' }],
      raw_output: '', duration_ms: 1,
    } as never);
    const r = await handleTool('uid', { project_path: '/p', action: 'uid_get', paths: ['res://missing.gd'] }, CTX);
    expect(firstJson(r!).error_code).toBe('FILE_NOT_FOUND');
  });
});
