// test/cli/main-entry-symlink.test.ts
// issue #71(2026-10-07,0.34.0 线上回归)——npm bin symlink 启动时 CLI 静默退出。
//
// 缺陷背景:daemon 批 A(2026-09-30 commit 70b167c1)给 src/index.ts 底部入口 IIFE
// 加了 argv[1]?.endsWith('index.js') 守卫(防 daemon/main.ts import 本模块时误起
// stdio server)。Linux/macOS npm 安装的 bin 是 symlink(/usr/local/bin/godot-mcp-enhanced
// 或 node_modules/.bin/godot-mcp-enhanced),argv[1] 是 symlink 路径、不以 index.js
// 结尾——守卫判 false 跳过整个 CLI 分流,--help/-v/doctor/setup 全部零输出 exit 0。
// 修复:index.ts isMainModule() 补 realpath(argv[1]) === __filename 兜底判定。
//
// 测试形态说明(集成级 spawn,非源码契约):本缺陷的本质是"进程启动分流",单元测试
// 无法伪造 argv[1] 主模块语义,必须真起子进程。依赖 build/index.js(pretest 自动
// npm run build 保证;直跑 vitest 者先 build)。
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { symlinkSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const realIndex = join(repoRoot, 'build', 'index.js');
const realDaemonMain = join(repoRoot, 'build', 'daemon', 'main.js');

/** symlink 模拟 npm bin(Windows 未开开发者模式/无权限时置 null → describe.skipIf)。
 *  ⚠️ 必须在模块顶层同步创建:describe.skipIf 的条件在 describe 注册时(文件加载期)
 *  求值,放 beforeAll 里赋值则注册时恒 null、恒 skip(首版测试的实际 bug)。 */
let binLink: string | null = null;
let tmpDir = '';
try {
  tmpDir = mkdtempSync(join(tmpdir(), 'gme-issue71-'));
  const link = join(tmpDir, 'godot-mcp-enhanced');
  symlinkSync(realIndex, link, 'file');
  binLink = link;
} catch {
  // Windows 无 SeCreateSymbolicLinkPrivilege(EPERM/EACCES)——本机跳过,
  // Linux/macOS CI(行为等价于线上受害平台)必然执行。
  binLink = null;
}

afterAll(() => {
  if (binLink) {
    try { unlinkSync(binLink); } catch { /* 临时目录,忽略 */ }
  }
});

describe('入口守卫:直跑 build/index.js(保底路径,平台无关)', () => {
  it('--help 有输出且退出 0', () => {
    const r = spawnSync(process.execPath, [realIndex, '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('godot-mcp-enhanced');
    expect(r.stdout).toContain('用法');
  });

  it('--version 有输出且退出 0', () => {
    const r = spawnSync(process.execPath, [realIndex, '--version'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });
});

describe.skipIf(!binLink)('入口守卫:经 npm bin symlink 启动(issue #71 回归主体)', () => {
  it('--help 有输出且退出 0(0.34.0 此场景零输出)', () => {
    const r = spawnSync(process.execPath, [binLink!, '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    // 回归断言:守卫误判时 stdout 为空字符串、exit 0 静默退出
    expect(r.stdout).toContain('godot-mcp-enhanced');
    expect(r.stdout).toContain('用法');
  });

  it('--version 有输出且退出 0', () => {
    const r = spawnSync(process.execPath, [binLink!, '--version'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it('doctor 有输出(经 symlink 的子命令路由可达)', () => {
    const r = spawnSync(process.execPath, [binLink!, 'doctor'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    // doctor 首行固定输出 Node.js 版本检查(cli/doctor.ts)
    expect(r.stdout).toContain('Node.js');
  });
});

describe('入口守卫:被 import 时不分流(守卫另一半契约,daemon main 复用)', () => {
  it('动态 import build/index.js 不触发 CLI 输出、不挂起', () => {
    // argv[1] 为 [eval]/undefined 时两条判定路径均 false → 不进入口 IIFE,
    // 加载完顶层 import 后事件循环排空自然退出(daemon/main.ts import 同语义)
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(realIndex).href)})`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('用法');
    expect(r.stdout).not.toContain('Unknown command');
  });

  it('daemon main.js 自身守卫不受影响(daemon 直跑路径存在)', () => {
    expect(existsSync(realDaemonMain)).toBe(true);
  });
});
