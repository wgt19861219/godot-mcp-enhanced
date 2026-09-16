/**
 * version-sync 脚本测试 — spawnSync 端到端 + tmp fixture
 *
 * 覆盖 spec §4 全部 10 用例。本 task 先覆盖校验模式(读取锚点 + 一致性)。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/version-sync.mjs', import.meta.url));

let tmpRoot: string;

/** 在 tmpRoot 下写入相对路径文件(自动建父目录) */
function fixture(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmpRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 生成 8 文件全一致的 fixture(CHANGELOG 默认含 [Unreleased] 段;A2 批后 bridgeGd 也是 A 类) */
function baseFixture(version: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'test', version }, null, 2) + '\n',
    'manifest.json': JSON.stringify({ name: 'test', version }, null, 2) + '\n',
    'server.json': JSON.stringify({ name: 'test', version, description: `test — 38 tools` }, null, 2) + '\n',
    'Dockerfile': `FROM node:18-slim\nRUN npm install -g godot-mcp-enhanced@${version}\n`,
    'addons/godot_mcp_server/plugin.cfg': `[plugin]\n\nname="MCP Server"\nversion="${version}"\nscript="plugin.gd"\n`,
    'docs/使用指南.md': `# 使用指南\n\n> **版本**：${version} ｜ **适用 Godot**：4.x\n`,
    'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-06-27\n\n### Fixed\n\n- test\n`,
    'README.md': `# Test\n\n| 版本 | 日期 | 说明 |\n|------|------|------|\n| **v${version}** | 2026-06-27 | test |\n`,
    'src/scripts/mcp_bridge.gd': `extends Node\nconst BRIDGE_SCRIPT_VERSION := "${version}"\n`,
  };
}

/** 跑脚本:run(true)=--check,run(false)=默认写入 */
function run(check: boolean): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', tmpRoot, ...(check ? ['--check'] : [])], {
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'version-sync-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Task 1: --check 校验模式 + 锚点读取
// ---------------------------------------------------------------------------

describe('--check 校验模式', () => {
  it('一致:5 文件全一致(CHANGELOG 含 [Unreleased])→ exit 0', () => {
    fixture(baseFixture('0.19.1'));
    const r = run(true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('一致');
  });

  it('C1: CHANGELOG [Unreleased] 不误报(首个带日期段被读取)', () => {
    // baseFixture 默认含 [Unreleased];若锚点误读 Unreleased 会 exit 1
    fixture(baseFixture('0.19.1'));
    const r = run(true);
    expect(r.status).toBe(0);
  });

  it('A 类漂移:manifest 版本不一致 → exit 1 + 错误含 manifest', () => {
    fixture(baseFixture('0.19.1'));
    writeFileSync(join(tmpRoot, 'manifest.json'), JSON.stringify({ name: 'test', version: '0.18.2' }, null, 2) + '\n');
    const r = run(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('manifest.json');
    expect(r.stderr).toContain('0.18.2');
  });

  it('B 类漂移:CHANGELOG 首条带日期版本号 ≠ package → exit 1', () => {
    fixture({
      ...baseFixture('0.19.1'),
      'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n## [0.18.2] - 2026-06-20\n`,
    });
    const r = run(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CHANGELOG');
  });

  it('B 类漂移:README 版本表首行 ≠ package → exit 1', () => {
    fixture({
      ...baseFixture('0.19.1'),
      'README.md': `# Test\n\n| 版本 | 日期 | 说明 |\n|------|------|------|\n| **v0.18.2** | 2026-06-20 | old |\n`,
    });
    const r = run(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('README');
  });

  it('格式 miss:plugin.cfg 缺 version 键 → exit 1(不静默通过)', () => {
    fixture({
      ...baseFixture('0.19.1'),
      'addons/godot_mcp_server/plugin.cfg': `[plugin]\n\nname="No Version"\nscript="plugin.gd"\n`,
    });
    const r = run(true);
    expect(r.status).toBe(1);
  });

  it('prerelease:package=0.20.0-rc.1 + 5 文件含后缀 → exit 0(锚点接受后缀)', () => {
    fixture(baseFixture('0.20.0-rc.1'));
    const r = run(true);
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2: 默认写入模式
// ---------------------------------------------------------------------------

describe('默认写入模式', () => {
  it('写入同步:A 类文件版本各异 → 写入后 == package version', () => {
    fixture({
      ...baseFixture('0.20.0'),
      'manifest.json': JSON.stringify({ name: 'test', version: '0.19.0' }, null, 2) + '\n',
      'server.json': JSON.stringify({ name: 'test', version: '0.19.0', description: 'test' }, null, 2) + '\n',
      'Dockerfile': `FROM node:18-slim\nRUN npm install -g godot-mcp-enhanced@0.19.0\n`,
      'addons/godot_mcp_server/plugin.cfg': `[plugin]\n\nversion="0.18.2"\n`,
      'docs/使用指南.md': `# 使用指南\n\n> **版本**：0.18.2 ｜ x\n`,
    });
    const r = run(false);
    expect(r.status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(tmpRoot, 'manifest.json'), 'utf-8'));
    expect(manifest.version).toBe('0.20.0');

    const serverJson = JSON.parse(readFileSync(join(tmpRoot, 'server.json'), 'utf-8'));
    expect(serverJson.version).toBe('0.20.0');

    const dockerfile = readFileSync(join(tmpRoot, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('godot-mcp-enhanced@0.20.0');

    const cfg = readFileSync(join(tmpRoot, 'addons/godot_mcp_server/plugin.cfg'), 'utf-8');
    expect(cfg).toContain('version="0.20.0"');

    const guide = readFileSync(join(tmpRoot, 'docs/使用指南.md'), 'utf-8');
    expect(guide).toContain('**版本**：0.20.0');
  });

  it('幂等:已一致时再写入 → A 类文件内容不变 + stdout 含"跳过"', () => {
    fixture(baseFixture('0.19.1'));
    const beforeManifest = readFileSync(join(tmpRoot, 'manifest.json'), 'utf-8');
    const beforeServerJson = readFileSync(join(tmpRoot, 'server.json'), 'utf-8');
    const beforeDockerfile = readFileSync(join(tmpRoot, 'Dockerfile'), 'utf-8');
    const beforeCfg = readFileSync(join(tmpRoot, 'addons/godot_mcp_server/plugin.cfg'), 'utf-8');
    const beforeGuide = readFileSync(join(tmpRoot, 'docs/使用指南.md'), 'utf-8');
    const r = run(false);
    expect(r.status).toBe(0);
    expect(readFileSync(join(tmpRoot, 'manifest.json'), 'utf-8')).toBe(beforeManifest);
    expect(readFileSync(join(tmpRoot, 'server.json'), 'utf-8')).toBe(beforeServerJson);
    expect(readFileSync(join(tmpRoot, 'Dockerfile'), 'utf-8')).toBe(beforeDockerfile);
    expect(readFileSync(join(tmpRoot, 'addons/godot_mcp_server/plugin.cfg'), 'utf-8')).toBe(beforeCfg);
    expect(readFileSync(join(tmpRoot, 'docs/使用指南.md'), 'utf-8')).toBe(beforeGuide);
    expect(r.stdout).toContain('跳过');
  });

  it('round-trip:写入后 --check 通过', () => {
    fixture({
      ...baseFixture('0.20.0'),
      'manifest.json': JSON.stringify({ name: 'test', version: '0.19.0' }, null, 2) + '\n',
    });
    expect(run(false).status).toBe(0);
    expect(run(true).status).toBe(0);
  });

  it('prerelease 写入:package=0.20.0-rc.1,A 类漂移 → 写入接受后缀', () => {
    fixture({
      ...baseFixture('0.20.0-rc.1'),
      'manifest.json': JSON.stringify({ name: 'test', version: '0.20.0' }, null, 2) + '\n',
      'server.json': JSON.stringify({ name: 'test', version: '0.20.0', description: 'test' }, null, 2) + '\n',
      'Dockerfile': `FROM node:18-slim\nRUN npm install -g godot-mcp-enhanced@0.20.0\n`,
    });
    expect(run(false).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(tmpRoot, 'manifest.json'), 'utf-8'));
    expect(manifest.version).toBe('0.20.0-rc.1');
    const serverJson = JSON.parse(readFileSync(join(tmpRoot, 'server.json'), 'utf-8'));
    expect(serverJson.version).toBe('0.20.0-rc.1');
  });

  it('CRLF 行尾:写入后仅版本字段变化,行尾 CRLF 保持(I2)', () => {
    const eol = '\r\n';
    fixture({
      'package.json': JSON.stringify({ name: 'test', version: '0.20.0' }, null, 2).replace(/\n/g, eol) + eol,
      'manifest.json': JSON.stringify({ name: 'test', version: '0.19.0' }, null, 2).replace(/\n/g, eol) + eol,
      'server.json': JSON.stringify({ name: 'test', version: '0.19.0', description: 'test' }, null, 2).replace(/\n/g, eol) + eol,
      'Dockerfile': `FROM node:18-slim${eol}RUN npm install -g godot-mcp-enhanced@0.19.0${eol}`,
      'addons/godot_mcp_server/plugin.cfg': `[plugin]${eol}${eol}version="0.19.0"${eol}`,
      'docs/使用指南.md': `# 使用指南${eol}${eol}> **版本**：0.19.0 ｜ x${eol}`,
      'CHANGELOG.md': `# Changelog${eol}${eol}## [Unreleased]${eol}${eol}## [0.20.0] - 2026-06-27${eol}`,
      'README.md': `# Test${eol}${eol}| **v0.20.0** | 2026-06-27 |${eol}`,
      'src/scripts/mcp_bridge.gd': `extends Node${eol}const BRIDGE_SCRIPT_VERSION := "0.19.0"${eol}`,
    });
    const r = run(false);
    expect(r.status).toBe(0);

    const cfg = readFileSync(join(tmpRoot, 'addons/godot_mcp_server/plugin.cfg'), 'utf-8');
    expect(cfg).toContain('version="0.20.0"');     // 版本已更新
    expect(cfg).toContain('\r\n');                  // CRLF 保持
    expect(cfg).not.toMatch(/[^\r]\n/);             // 无裸 LF(行尾未混合)

    // M-1 扩展: manifest + guide 同样保 CRLF(plugin.cfg 之外两个 A 类目标)
    const manifest = readFileSync(join(tmpRoot, 'manifest.json'), 'utf-8');
    expect(manifest).toContain('0.20.0');
    expect(manifest).toContain('\r\n');
    expect(manifest).not.toMatch(/[^\r]\n/);
    const guide = readFileSync(join(tmpRoot, 'docs/使用指南.md'), 'utf-8');
    expect(guide).toContain('**版本**：0.20.0');
    expect(guide).toContain('\r\n');
    expect(guide).not.toMatch(/[^\r]\n/);

    // server.json(JSON) + Dockerfile(文本)CRLF 保持
    const serverJson = readFileSync(join(tmpRoot, 'server.json'), 'utf-8');
    expect(serverJson).toContain('0.20.0');
    expect(serverJson).toContain('\r\n');
    const dockerfile = readFileSync(join(tmpRoot, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('godot-mcp-enhanced@0.20.0');
    expect(dockerfile).toContain('\r\n');
  });

  it('M-2: 写入模式遇损坏锚点(manifest 缺 version)→ exit 1(不静默通过)', () => {
    fixture({
      ...baseFixture('0.20.0'),
      'manifest.json': JSON.stringify({ name: 'test' }, null, 2) + '\n',  // 缺 version 字段
    });
    const r = run(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('版本同步失败');
    expect(r.stderr).toContain('manifest');
  });
});

// ---------------------------------------------------------------------------
// Task 3: --root 参数边界(I-1)
// ---------------------------------------------------------------------------

describe('--root 参数边界', () => {
  // 直接 spawnSync 构造缺值调用(绕过 run 辅助,后者固定传 --root tmpRoot)
  function runRaw(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('I-1: --root 末尾缺值 → exit 1 + stderr 含提示(非晦涩 TypeError)', () => {
    const r = runRaw(['--root']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--root 需要一个参数值');
  });

  it('I-1: --root 后跟另一个 flag → exit 1 + stderr 含提示', () => {
    const r = runRaw(['--root', '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--root 需要一个参数值');
  });

  it('I-1: --check --root 末尾缺值 → exit 1', () => {
    const r = runRaw(['--check', '--root']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--root 需要一个参数值');
  });
});
