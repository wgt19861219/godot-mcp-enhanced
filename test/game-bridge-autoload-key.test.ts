// game-bridge-autoload-key.test.ts — G-4 + G-5 (2026-08-14 批D实测发现 P2)
//
// G-4: autoload 健康预检键名不匹配 — _doConnect 预检 parseAutoloadNames().includes('MCPBridge'),
//      但旧版 install 写入的键带 'autoload/' 前缀 → 恒不匹配 → BRIDGE_NOT_CONNECTED 误报
//      (疑致 e2e L2 suite 静默 skip)。修复: 比较时去前缀,新旧两种键都正确判定。
// G-5: AUTOLOAD_KEY 前缀致 Godot 节点名冲突 — 旧版写入 'autoload/MCPBridge' 键,Godot 解析
//      [autoload] 段时键名即节点名,含 '/' 被截断为同名 "autoload" 节点(MCPBridge + MCPOVERRIDE_*
//      冲突 → override 未加载)。修复: 写入键去前缀;install 幂等识别旧键并迁移;uninstall 双键清理。
//
// 范式: 真实 fs + tmp 项目(对齐 overrides.test.ts,绕开 game-bridge.test.ts 的 mock fs 互斥)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, utimesSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleTool, resetBridgeState, setBridgeProjectDir } from '../src/tools/game-bridge.js';
import { _resetAutoloadCache } from '../src/gdscript-executor.js';
import { asUnrestrictedPath } from './helpers/path-isolation.js';

let tmpRoot: string;
let projectDir: string;
let scriptsDir: string;
let restoreEnv: () => void;

const BASE_CONFIG = 'config_version=5\n[application]\nconfig/name="Test"\n';
const LEGACY_KEY_LINE = 'autoload/MCPBridge="*res://mcp_bridge.gd"';
const NEW_KEY_LINE = 'MCPBridge="*res://mcp_bridge.gd"';

/** 构造带 [autoload] 段的 project.godot(autoloadLines 逐行追加) */
function writeProjectGodot(autoloadLines: string[]): void {
  const section = autoloadLines.length > 0 ? '[autoload]\n' + autoloadLines.join('\n') + '\n' : '';
  writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG + section, 'utf-8');
}

beforeEach(() => {
  restoreEnv = asUnrestrictedPath();
  tmpRoot = join(tmpdir(), `bridge-autoload-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  projectDir = join(tmpRoot, 'MyProject');
  scriptsDir = join(tmpRoot, 'scripts');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'mcp_bridge.gd'), 'extends Node\n', 'utf-8');
  // 默认无 [autoload] 段(各用例自行写)
  writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG, 'utf-8');
  resetBridgeState();
  _resetAutoloadCache();
});

afterEach(() => {
  restoreEnv();
  resetBridgeState();
  _resetAutoloadCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── G-4: autoload 预检键名匹配(带前缀/不带前缀都正确判定) ─────────────────────
describe('G-4: _doConnect autoload 预检去前缀匹配', () => {
  it('旧带前缀键(autoload/MCPBridge) → 不误报 autoload missing(连接继续到 secret 阶段)', async () => {
    writeProjectGodot([LEGACY_KEY_LINE]);
    setBridgeProjectDir(projectDir);
    const result = await handleTool('game', { action: 'game_query', method: 'ping', timeout: 1000 }, { projectDir } as never);
    expect(result?.isError).toBe(true);  // 后续阶段报错(secret 不存在/连接失败),但
    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).not.toContain('missing from');  // 不是 autoload missing 误报
    expect(text).not.toContain("[autoload] section");
  });

  it('新键(MCPBridge,无前缀) → 预检通过(回归守护)', async () => {
    writeProjectGodot([NEW_KEY_LINE]);
    setBridgeProjectDir(projectDir);
    const result = await handleTool('game', { action: 'game_query', method: 'ping', timeout: 1000 }, { projectDir } as never);
    expect(result?.isError).toBe(true);
    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).not.toContain('missing from');
  });

  it('有其它 autoload 但无 MCPBridge(任何形态) → BRIDGE_NOT_CONNECTED 含 missing from(负向守护)', async () => {
    writeProjectGodot(['PlayerHUD="*res://hud.gd"']);
    setBridgeProjectDir(projectDir);
    const result = await handleTool('game', { action: 'game_query', method: 'ping', timeout: 1000 }, { projectDir } as never);
    expect(result?.isError).toBe(true);
    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).toContain("missing from");
  });
});

// ── G-5: install/uninstall 写入键去前缀 + 旧键迁移/双键清理 ─────────────────────
describe('G-5: game_bridge_install/uninstall autoload 键名', () => {
  const ctx = () => ({ opsScript: join(scriptsDir, 'ops.gd'), projectDir } as never);

  it('install 写入无前缀键 MCPBridge(autoload 段键名即节点名,不得带 autoload/ 前缀)', async () => {
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(config).toContain(NEW_KEY_LINE);
    expect(config).not.toContain('autoload/MCPBridge=');  // 修复前写入带前缀键(节点名冲突根因)
  });

  it('install 幂等: 新键已存在 → already registered,不重复写入', async () => {
    writeProjectGodot([NEW_KEY_LINE]);
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    const text = (r?.content?.[0] as { text: string }).text;
    expect(text).toContain('already registered');
    const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(config.match(/^MCPBridge=/gm)?.length).toBe(1);
  });

  it('install 迁移旧带前缀键: 删旧行写新行(旧项目自愈,不再截断为冲突 "autoload" 节点)', async () => {
    writeProjectGodot([LEGACY_KEY_LINE]);
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(config).not.toContain('autoload/MCPBridge=');  // 旧键行被移除
    expect(config).toContain(NEW_KEY_LINE);               // 新键行写入
  });

  it('uninstall 清理新键与旧带前缀键(双键兼容)', async () => {
    writeProjectGodot([LEGACY_KEY_LINE]);
    const r1 = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir }, ctx());
    expect(r1?.isError).toBeFalsy();
    let config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(config).not.toContain('MCPBridge');  // 旧带前缀键被清

    writeProjectGodot([NEW_KEY_LINE]);
    const r2 = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir }, ctx());
    expect(r2?.isError).toBeFalsy();
    config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(config).not.toContain('MCPBridge=');  // 新键被清
    expect(existsSync(join(projectDir, 'mcp_bridge.gd'))).toBe(false);  // 脚本一并删除
  });
});

describe('反馈批 20261122 Task 3: install 内容相同跳过重写 + 决策日志', () => {
  const ctx = () => ({ opsScript: join(scriptsDir, 'ops.gd'), projectDir } as never);
  const dest = () => join(projectDir, 'mcp_bridge.gd');
  /** 把 mtime 钉到 2 分钟前——跳过写盘则不变,重写则必变(无秒级粒度歧义,范式同 web-gui/portal.test.ts)。 */
  const pinOldMtime = (p: string) => {
    const past = new Date(Date.now() - 120_000);
    utimesSync(p, past, past);
    return statSync(p).mtimeMs;
  };

  it('内容相同: 第二次 install 不重写(mtime 不变)且 scriptNote 含 skipped write', async () => {
    await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    const pinned = pinOldMtime(dest());
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(statSync(dest()).mtimeMs).toBe(pinned);
    expect((r?.content?.[0] as { text: string }).text).toContain('skipped write');
  });

  it('内容不同 + 无 force: 保持原样(回归锚)', async () => {
    writeFileSync(dest(), 'extends Node\n# local edit\n', 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(readFileSync(dest(), 'utf-8')).toBe('extends Node\n# local edit\n');
    expect((r?.content?.[0] as { text: string }).text).toContain('kept as-is');
  });

  it('内容不同 + force=true: 覆盖(回归锚)', async () => {
    writeFileSync(dest(), 'extends Node\n# local edit\n', 'utf-8');
    await handleTool('game', { action: 'game_bridge_install', project_path: projectDir, force: true }, ctx());
    expect(readFileSync(dest(), 'utf-8')).toBe('extends Node\n');
  });

  it('每次 install 向 stderr 输出恰好一行 BRIDGE-INSTALL 决策日志', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
      const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('BRIDGE-INSTALL '));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('decision=installed');
      expect(lines[0]).toContain('force=false');
    } finally {
      errSpy.mockRestore();
    }
  });
});
