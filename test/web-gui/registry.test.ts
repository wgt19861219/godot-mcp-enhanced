// test/web-gui/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRegistration, removeRegistration, listRegistrations } from '../../src/web-gui/registry.js';

const ALIVE = () => true;
const DEAD = () => false;

describe('web-gui per-pid 登记(设计 §3.1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-reg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写 per-pid 文件 + readdir 聚合读回', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'tok-a', startedAt: new Date().toISOString() }, { dir });
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files).toEqual(['111.json']);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list).toHaveLength(1);
    expect(list[0]!.token).toBe('tok-a');
  });

  it('双进程并发登记互不丢失(各写各文件)', async () => {
    await Promise.all([
      writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir }),
      writeRegistration({ pid: 222, port: 9551, token: 'b', startedAt: 't' }, { dir }),
    ]);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list.map(r => r.pid).sort()).toEqual([111, 222]);
  });

  it('死 pid 条目被过滤且文件被清除', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    const list = await listRegistrations({ dir, isPidAlive: DEAD });
    expect(list).toHaveLength(0);
    expect(existsSync(join(dir, '111.json'))).toBe(false);
  });

  it('removeRegistration 删除自己的文件(best-effort)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await removeRegistration(111, { dir });
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('登记文件权限 0o600(Linux/macOS)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'secret', startedAt: 't' }, { dir });
    const mode = statSync(join(dir, '111.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
