/**
 * 批次3(2026-10-04):doctor 的 bridge 脚本指纹比对纯函数测试。
 * 用真实临时文件(不用 vi.mock fs —— compareBridgeScript 语义就是磁盘字节比对)。
 * 方案来源:docs/plans/2026-10-04-竞品回流验证与可靠性落地方案.md 批次3。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareBridgeScript } from '../src/cli/doctor.js';

const dir = mkdtempSync(join(tmpdir(), 'bridge-fp-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
};

describe('compareBridgeScript(批次3 指纹比对)', () => {
  const bundled = write('bundled.gd', 'const A := 1\nline2\nline3\n');

  it('项目文件不存在 → absent(未装 bridge,doctor 跳过)', () => {
    const r = compareBridgeScript(join(dir, 'nope.gd'), bundled);
    expect(r.status).toBe('absent');
    expect(r.projectSha256).toBeNull();
  });

  it('bundled 不可读 → bundled-missing(dev 模式,doctor 跳过)', () => {
    const project = write('p1.gd', 'const A := 1\nline2\nline3\n');
    const r = compareBridgeScript(project, join(dir, 'missing.gd'));
    expect(r.status).toBe('bundled-missing');
  });

  it('字节一致 → in-sync(sha256 相同)', () => {
    const project = write('p2.gd', 'const A := 1\nline2\nline3\n');
    const r = compareBridgeScript(project, bundled);
    expect(r.status).toBe('in-sync');
    expect(r.projectSha256).toBe(r.bundledSha256);
    expect(r.projectSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('仅 CRLF 行尾差异 → eol-only(运行时会报 fingerprintWarning 的可解释场景)', () => {
    const project = write('p3.gd', 'const A := 1\r\nline2\r\nline3\r\n');
    const r = compareBridgeScript(project, bundled);
    expect(r.status).toBe('eol-only');
    expect(r.projectSha256).not.toBe(r.bundledSha256);  // 字节级确实不同(与运行时语义一致)
  });

  it('内容真实不同 → modified(手改/损坏/旧版)', () => {
    const project = write('p4.gd', 'const A := 2\nline2\nline3\n');
    const r = compareBridgeScript(project, bundled);
    expect(r.status).toBe('modified');
  });
});
