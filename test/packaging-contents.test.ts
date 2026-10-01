import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A-2 (2026-10-01 全维度审查): npm 打包内容守护测试。
// 背景(A-1): docs 工具运行时经 build/godot-docs.js 解析包根 docs/api/extension_api.json,
// 而 files 数组曾遗漏该文件——已发布包内 docs 工具必然抛 "Godot docs database not found",
// 且无任何门禁能拦截(所有 check:* 都不看打包产物)。本测试锁两层:
// ① files 数组覆盖运行时必需数据路径;② npm pack 产物清单真实包含该文件。

describe('packaging: files 数组覆盖运行时数据路径', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
  const files: string[] = pkg.files;

  it('files 含 docs/api/extension_api.json(A-1 回归锚:docs 工具运行时数据库)', () => {
    expect(files.includes('docs/api/extension_api.json'), 'files 缺 docs/api/extension_api.json').toBe(true);
  });

  it('godot-docs 的解析目标仍是包根 docs/api(源码解析模式变更时本锚提醒同步 files)', () => {
    // src/godot-docs.ts ensureInit() 用 join(dirname(import.meta.url), '..', 'docs', 'api', ...)
    // 编译后 import.meta.url 位于 <pkg>/build/,故解析目标恒为包根 docs/api/extension_api.json。
    // 若有人改了该解析路径(如搬进 build/),此断言失败——须同步 files 数组与本测试。
    const src = readFileSync('src/godot-docs.ts', 'utf8');
    expect(
      src.includes("join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'api', 'extension_api.json')"),
      'godot-docs.ts 的 docsPath 解析表达式已变更——请同步 files 数组与本守护测试',
    ).toBe(true);
  });

  it('files 含其余运行时分发条目(build 产物/addons/工具文档)', () => {
    const required = [
      'build/scripts/*.gd',       // GDScript 运行时脚本(bridge 等)
      'build/instructions.md',    // 打包进 build 的运行时说明
      'build/game-templates/**',  // 游戏模板资产
      'build/web-gui/assets/**',  // Web GUI 静态资产(codemirror 等)
      'addons',                   // Godot editor 插件
      'scripts',                  // install-plugin 等分发脚本
      'skills',                   // skills 分发
      'docs/tools/**/*.md',       // 46 篇工具文档
    ];
    for (const entry of required) {
      expect(files.includes(entry), `files 缺 ${entry}`).toBe(true);
    }
  });

  it('docs/api/extension_api.json 在仓库根真实存在且非空(防 files 指向已删/空文件)', () => {
    const p = join(process.cwd(), 'docs', 'api', 'extension_api.json');
    expect(existsSync(p), 'docs/api/extension_api.json 不存在——docs 工具将不可用').toBe(true);
    expect(statSync(p).size, 'extension_api.json 为空文件').toBeGreaterThan(1_000_000);
  });
});

describe('packaging: npm pack 产物实测', () => {
  it(
    'npm pack --dry-run 清单含 docs/api/extension_api.json(端到端产物层验证)',
    { timeout: 60_000 },
    () => {
      // npm 的文件清单("npm notice …"行)走 stderr,须两路合并检查
      const r = spawnSync('npm', ['pack', '--dry-run'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      expect(r.status, `npm pack --dry-run 失败: ${r.stderr}`).toBe(0);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(out.includes('docs/api/extension_api.json'), 'npm 包产物缺 docs/api/extension_api.json——检查 package.json files').toBe(true);
      expect(out.includes('docs/tools/'), 'npm 包产物缺 docs/tools/ 工具文档').toBe(true);
    },
  );
});
