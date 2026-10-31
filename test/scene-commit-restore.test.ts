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
    expect(() => restoreFromPoint(proj, '1234567890123-abcd12')).toThrow(/not found/); // 格式合法但不存在的 id
    expect(() => restoreFromPoint(proj, 'nonexistent-id')).toThrow(/invalid restore point id/); // I-1:格式白名单先拦

    // 手工删掉一份备份文件 → missing 明细
    const backupDir = join(ROOT, projHash(proj), rp1.id);
    rmSync(join(backupDir, '0_a.tscn'));
    const r = restoreFromPoint(proj, rp1.id);
    expect(r.restored).toEqual([]);
    expect(r.missing).toEqual(['scenes/a.tscn']);
  });

  it('批 B 审查 I-1:id 穿越形态拒绝;manifest.files 含 ../ 的 rel 拒恢复(双层校验)', () => {
    // 1) id 格式白名单(join 规范化 .. 指向根外的向量)
    expect(() => restoreFromPoint(proj, '../../evil')).toThrow(/invalid restore point id/);
    expect(() => restoreFromPoint(proj, '123')).toThrow(/invalid restore point id/);

    // 2) 伪造 manifest:files 含逃逸路径 → 恢复拒拷,进 missing 带 SECURITY 标注
    const ts = Date.now();
    const evilId = `${ts}-evil1`;
    const evilDir = join(ROOT, projHash(proj), evilId);
    mkdirSync(join(evilDir), { recursive: true });
    writeFileSync(join(evilDir, '0_x.tscn'), 'EVIL');
    writeFileSync(join(evilDir, 'manifest.json'), JSON.stringify({
      id: evilId, ts, project: proj, files: ['../escape.txt'], backups: ['0_x.tscn'],
    }));
    const r = restoreFromPoint(proj, evilId);
    expect(r.restored).toEqual([]);
    expect(r.missing[0]).toContain('[SECURITY: escapes project root');
    expect(r.missing[0]).toContain('../escape.txt');
  });

  it('2026-10-29 审查 L-1:backups 含 ../ 逃逸拒绝(防伪造 manifest 拷回任意本地文件)', () => {
    // 伪造 manifest:files 是合法项目内路径,backups 指向 restore-point 目录外
    // (ROOT 外的可读敏感文件模拟)——修复前 join(dir, backup) 无消毒直接 copyFileSync
    const ts = Date.now();
    const evilId = `${ts}-evil2`;
    const evilDir = join(ROOT, projHash(proj), evilId);
    mkdirSync(evilDir, { recursive: true });
    // 备份面:一个正常备份 + 一个逃逸路径(指向 ROOT 上一级的文件)
    writeFileSync(join(evilDir, '0_a.tscn'), 'BACKUP');
    const outsideDir = join(ROOT, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const secretAbs = join(outsideDir, 'secret.txt');
    writeFileSync(secretAbs, 'SECRET-CONTENT');
    writeFileSync(join(evilDir, 'manifest.json'), JSON.stringify({
      id: evilId, ts, project: proj,
      files: ['scenes/a.tscn', 'stolen.txt'],
      backups: ['0_a.tscn', '../../outside/secret.txt'],
    }));
    writeFileSync(join(proj, 'stolen.txt'), 'PRE-EXISTING');
    const r = restoreFromPoint(proj, evilId);
    // 正常备份恢复成功;逃逸项拒绝拷贝(项目内文件不被外部内容覆盖)
    expect(r.restored).toEqual(['scenes/a.tscn']);
    expect(r.missing).toEqual(['stolen.txt [SECURITY: escapes project root, restore refused]']);
    expect(readFileSync(join(proj, 'stolen.txt'), 'utf8')).toBe('PRE-EXISTING');
  });

  it('2026-10-29 审查 L-1:backups/files 长度不齐或非 string 显式报 manifest 损坏', () => {
    const mkEvil = (id: string, manifest: Record<string, unknown>) => {
      const evilDir = join(ROOT, projHash(proj), id);
      mkdirSync(evilDir, { recursive: true });
      writeFileSync(join(evilDir, '0_a.tscn'), 'BACKUP');
      writeFileSync(join(evilDir, 'manifest.json'), JSON.stringify(manifest));
      return id;
    };
    const ts = Date.now();
    // 长度不齐(修复前 join(dir, undefined) 抛 TypeError 被上层误报)
    const shortId = mkEvil(`${ts}-evil3`, { id: `${ts}-evil3`, ts, project: proj, files: ['scenes/a.tscn'], backups: [] });
    expect(() => restoreFromPoint(proj, shortId)).toThrow(/manifest corrupted/);
    // backups 含非 string 元素
    const badTypeId = mkEvil(`${ts}-evil4`, { id: `${ts}-evil4`, ts, project: proj, files: ['scenes/a.tscn'], backups: [null] });
    expect(() => restoreFromPoint(proj, badTypeId)).toThrow(/manifest corrupted/);
    // files 非 string 元素
    const badFileId = mkEvil(`${ts}-evil5`, { id: `${ts}-evil5`, ts, project: proj, files: [123], backups: ['0_a.tscn'] });
    expect(() => restoreFromPoint(proj, badFileId)).toThrow(/manifest corrupted/);
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
