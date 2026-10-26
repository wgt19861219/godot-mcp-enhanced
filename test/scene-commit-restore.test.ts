// 批 B2 (2026-10-26): scene.commit restore point 作用域回滚测试。
// restore-points 根目录经 GODOT_MCP_RESTORE_POINTS_DIR 指到项目内 tmp(磁盘卫生)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const probeMock = vi.fn();
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscriptRuntime: (...a: unknown[]) => probeMock(...a),
}));

import {
  createRestorePoint, listRestorePoints, restoreFromPoint,
} from '../src/tools/scene/commit-restore.js';
import { handleCommitAction } from '../src/tools/scene/scene-commit-tool.js';

// 指到项目内 tmp/<随机>(不落 C 盘项目外)
const ROOT = join(process.cwd(), 'tmp', `restore-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
let proj: string;

beforeEach(() => {
  process.env.GODOT_MCP_RESTORE_POINTS_DIR = ROOT;
  probeMock.mockReset();
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
  proj = mkdtempSync(join(ROOT, 'proj-'));
  mkdirSync(join(proj, 'scenes'), { recursive: true });
  mkdirSync(join(proj, 'assets'), { recursive: true });
  writeFileSync(join(proj, 'scenes', 'a.tscn'), 'ORIGINAL-SCENE');
  writeFileSync(join(proj, 'assets', 't.tres'), 'ORIGINAL-TRES');
});

afterEach(() => {
  delete process.env.GODOT_MCP_RESTORE_POINTS_DIR;
  rmSync(ROOT, { recursive: true, force: true });
});

const projHash = (p: string) => createHash('md5').update(p.replace(/\\/g, '/')).digest('hex').slice(0, 8);

describe('createRestorePoint(批 B2)', () => {
  it('备份已存在的将写文件;跳过不存在的;全新建返回 null', () => {
    const rp = createRestorePoint(proj, ['scenes/a.tscn', 'assets/absent.tres']);
    expect(rp).not.toBeNull();
    expect(rp!.files).toEqual(['scenes/a.tscn']);
    expect(createRestorePoint(proj, ['assets/absent2.tres'])).toBeNull();
  });

  it('commit 后文件被改,restore 恢复到备份内容(作用域=本次触及文件)', () => {
    const rp = createRestorePoint(proj, ['scenes/a.tscn', 'assets/t.tres']);
    writeFileSync(join(proj, 'scenes', 'a.tscn'), 'MODIFIED');
    const r = restoreFromPoint(proj, rp!.id);
    expect(r.restored.sort()).toEqual(['assets/t.tres', 'scenes/a.tscn']);
    expect(readFileSync(join(proj, 'scenes', 'a.tscn'), 'utf8')).toBe('ORIGINAL-SCENE');
  });
});

describe('listRestorePoints / restoreFromPoint', () => {
  it('列表新→旧;未知 id 抛错;备份文件缺失进 missing(不静默)', () => {
    const rp1 = createRestorePoint(proj, ['scenes/a.tscn'])!;
    const rp2 = createRestorePoint(proj, ['scenes/a.tscn'])!;
    const list = listRestorePoints(proj);
    expect(list.map(p => p.id)).toEqual([rp2.id, rp1.id]);
    expect(() => restoreFromPoint(proj, 'nonexistent-id')).toThrow(/not found/);

    // 手工删掉一份备份文件 → missing 明细
    const backupDir = join(ROOT, projHash(proj), rp1.id);
    rmSync(join(backupDir, '0_a.tscn'));
    const r = restoreFromPoint(proj, rp1.id);
    expect(r.restored).toEqual([]);
    expect(r.missing).toEqual(['scenes/a.tscn']);
  });
});

describe('LRU 清理', () => {
  it('超过 10 点删最旧(mtime 序)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const rp = createRestorePoint(proj, ['scenes/a.tscn'])!;
      ids.push(rp.id);
    }
    const list = listRestorePoints(proj);
    expect(list).toHaveLength(10);
    expect(list.map(p => p.id)).not.toContain(ids[0]!); // 最旧被清
    expect(list.map(p => p.id)).toContain(ids[11]!);    // 最新保留
  });
});

describe('handleCommitAction 集成:restore_point 注入', () => {
  it('save=true 的 commit 结果带 restore_point{id,files};save=false 不带', async () => {
    const ctx = { findGodot: async () => 'godot', checkEditorSceneSave: undefined } as never;
    const base = {
      project_path: proj, scene_path: 'scenes/a.tscn',
      operations: [{ op: 'node_property', path: 'P', property: 'x', value: 1 }],
    };
    probeMock.mockResolvedValue({ raw_output: 'COMMIT_RESULT: {"success":true,"saved":true,"results":[]}' });
    const saved = await handleCommitAction({ ...base, save: true }, ctx);
    const parsed1 = JSON.parse((saved!.content![0] as { text: string }).text) as Record<string, never>;
    expect(parsed1.restore_point).toBeDefined();
    expect((parsed1.restore_point as { files: string[] }).files).toEqual(['scenes/a.tscn']);

    probeMock.mockResolvedValue({ raw_output: 'COMMIT_RESULT: {"success":true,"saved":false,"results":[]}' });
    const notSaved = await handleCommitAction({ ...base, save: false }, ctx);
    const parsed2 = JSON.parse((notSaved!.content![0] as { text: string }).text) as Record<string, unknown>;
    expect(parsed2.restore_point).toBeUndefined();
  });
});
