// game-bridge-workspace-guard.test.ts — A2 (2026-08-18 反馈 mcp_bridge.gd 工作区污染)
//
// install 曾无条件覆盖项目根 mcp_bridge.gd、uninstall 无条件删除 —— 对 git tracked 且
// 项目自管该文件的项目(CardGame2 场景)造成工作区污染(覆盖出 diff / 删掉 tracked 文件,
// 须 git checkout 恢复)。修复: 内容比对守卫 —— 内容一致(工具托管)才覆盖/删除,
// 不一致(项目自管)保留并明确提示。附带: uninstall 清理全部端口 secret(A1 避让残留)。
// 范式: 真实 fs + tmp 项目(对齐 game-bridge-autoload-key.test.ts)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleTool, resetBridgeState } from '../src/tools/game-bridge.js';
import { asUnrestrictedPath } from './helpers/path-isolation.js';

let tmpRoot: string;
let projectDir: string;
let scriptsDir: string;
let restoreEnv: () => void;

const BASE_CONFIG = 'config_version=5\n[application]\nconfig/name="Test"\n';
const BUNDLED_CONTENT = '# bundled mcp_bridge.gd (tool-managed)\nextends Node\n';
const USER_MODIFIED_CONTENT = '# project-managed, git tracked + local edits\nextends Node\n# custom LOCKOUT changes\n';

beforeEach(() => {
  restoreEnv = asUnrestrictedPath();
  tmpRoot = join(tmpdir(), `bridge-ws-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  projectDir = join(tmpRoot, 'MyProject');
  scriptsDir = join(tmpRoot, 'scripts');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'mcp_bridge.gd'), BUNDLED_CONTENT, 'utf-8');
  writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG, 'utf-8');
  resetBridgeState();
});

afterEach(() => {
  restoreEnv();
  resetBridgeState();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const ctx = () => ({ opsScript: join(scriptsDir, 'ops.gd'), projectDir } as never);
const resultText = (r: unknown): string => ((r as { content?: Array<{ text: string }> })?.content?.[0]?.text) ?? '';

describe('A2: game_bridge_install 内容比对守卫', () => {
  it('目标 mcp_bridge.gd 内容与自带版本不同(项目自管)→ 不覆盖,文件保持用户版 + 返回提示', async () => {
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(USER_MODIFIED_CONTENT);  // 未被覆盖
    expect(resultText(r)).toContain('differs from bundled version');
  });

  it('目标 mcp_bridge.gd 内容与自带版本一致(工具托管)→ 覆盖刷新,无警告(升级场景)', async () => {
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), BUNDLED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(BUNDLED_CONTENT);
    expect(resultText(r)).not.toContain('differs from bundled version');
  });

  it('目标不存在 → 正常拷贝(首次安装)', async () => {
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(BUNDLED_CONTENT);
  });

  it('已注册(幂等)且内容不同 → 同样不覆盖,already registered 响应带提示', async () => {
    writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG + '[autoload]\nMCPBridge="*res://mcp_bridge.gd"\n', 'utf-8');
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    const text = resultText(r);
    expect(text).toContain('already registered');
    expect(text).toContain('differs from bundled version');
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(USER_MODIFIED_CONTENT);
  });

  // ── A1 (2026-09-16 反馈批): drift 场景 force 刷新入口 ────────────────────────
  // send_drag 五踩根因: 项目内 mcp_bridge.gd 旧版 drift 时 kept-as-is 无 force 刷新路径,
  // 提示 "delete it manually" 藏在括号里且无精确路径。修复: force=true 显式覆盖 +
  // 无 force 时指引可操作(force=true 或删除精确路径后重装)。
  it('A1: drift + force=true → 覆盖刷新为 bundled 版本 + 响应注明 overwritten', async () => {
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir, force: true }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(BUNDLED_CONTENT);  // 已被覆盖刷新
    expect(resultText(r)).toContain('overwritten (force: true)');
  });

  it('A1: drift + force=true + 已注册(幂等)→ 同样覆盖刷新', async () => {
    writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG + '[autoload]\nMCPBridge="*res://mcp_bridge.gd"\n', 'utf-8');
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir, force: true }, ctx());
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(BUNDLED_CONTENT);
    expect(resultText(r)).toContain('overwritten (force: true)');
  });

  it('A1: drift 无 force → 提示含可操作指引(force=true 与精确删除路径)', async () => {
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    const text = resultText(r);
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(USER_MODIFIED_CONTENT);
    expect(text).toContain('force: true');
    // 响应经 JSON.stringify,Windows 路径反斜杠被转义 — 断言同形态(JSON 编码后的路径)
    expect(text).toContain(JSON.stringify(join(projectDir, 'mcp_bridge.gd')).slice(1, -1));
  });

  // ── A4 (2026-09-16 反馈批): clean_stale_secrets 陈旧 secret 清理入口 ──────────
  // 多实例端口避让后死实例的 mcp_bridge_*.secret 残留误导端口解析与 auth(09-03/09-06 反馈)。
  // 判活依据=machine registry 按项目过滤的新鲜心跳(审查 B-1 修复:首版误读
  // {project}/.godot/mcp-instances——GD 的 project-level 心跳在 user:// 不可达,判活恒空);
  // P 为空拒绝清理(防误删不写心跳的旧版活实例)。测试经 GODOT_MCP_BRIDGE_REGISTRY_DIR
  // 把 machine registry 重定向到 tmp(不碰真实 ~/.godot-mcp)。
  let machineRegistryDir: string;

  beforeEach(() => {
    machineRegistryDir = join(tmpRoot, 'machine-registry');
    mkdirSync(machineRegistryDir, { recursive: true });
    process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = machineRegistryDir;
  });
  afterEach(() => {
    delete process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  });

  function writeHeartbeat(port: number, ageMs: number): void {
    writeFileSync(join(machineRegistryDir, `inst_${port}.json`), JSON.stringify({
      id: `inst_${port}`, projectPath: projectDir, port,
      lastSeen: new Date(Date.now() - ageMs).toISOString(),
      capabilities: ['registry-heartbeat'],
    }), 'utf-8');
  }
  function writeSecrets(): string {
    const godotDir = join(projectDir, '.godot');
    mkdirSync(godotDir, { recursive: true });
    writeFileSync(join(godotDir, 'mcp_bridge_9081.secret'), 'a'.repeat(32), 'utf-8');
    writeFileSync(join(godotDir, 'mcp_bridge_9082.secret'), 'b'.repeat(32), 'utf-8');
    return godotDir;
  }

  it('A4: clean_stale_secrets=true + 新鲜心跳 9081 → 删 9082 残留,保留 9081', async () => {
    const godotDir = writeSecrets();
    writeHeartbeat(9081, 10_000);  // 10s 前心跳,新鲜
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir, clean_stale_secrets: true }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(existsSync(join(godotDir, 'mcp_bridge_9081.secret'))).toBe(true);   // 活实例保留
    expect(existsSync(join(godotDir, 'mcp_bridge_9082.secret'))).toBe(false);  // 残留被删
    expect(resultText(r)).toContain('mcp_bridge_9082.secret');
  });

  it('A4: clean_stale_secrets=true + 无任何新鲜心跳 → 拒绝清理(防误删旧版活实例)', async () => {
    const godotDir = writeSecrets();
    writeHeartbeat(9081, 10 * 60_000);  // 10 分钟前,超龄(窗口 5min)
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir, clean_stale_secrets: true }, ctx());
    expect(existsSync(join(godotDir, 'mcp_bridge_9081.secret'))).toBe(true);   // 不删
    expect(existsSync(join(godotDir, 'mcp_bridge_9082.secret'))).toBe(true);
    expect(resultText(r)).toContain('cleanup skipped');
  });

  it('A4: 默认(无参数)+ 有心跳 + 有陈旧 → 只检测不删,响应列出 candidates', async () => {
    const godotDir = writeSecrets();
    writeHeartbeat(9081, 10_000);
    const r = await handleTool('game', { action: 'game_bridge_install', project_path: projectDir }, ctx());
    expect(existsSync(join(godotDir, 'mcp_bridge_9082.secret'))).toBe(true);   // 未删
    expect(resultText(r)).toContain('stale secret candidates');
    expect(resultText(r)).toContain('mcp_bridge_9082.secret');
  });
});

describe('A2: game_bridge_uninstall 内容比对守卫', () => {
  function registerAutoload(): void {
    writeFileSync(join(projectDir, 'project.godot'), BASE_CONFIG + '[autoload]\nMCPBridge="*res://mcp_bridge.gd"\n', 'utf-8');
  }

  it('内容与自带版本一致(工具托管)→ 删除(原行为回归)', async () => {
    registerAutoload();
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), BUNDLED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'mcp_bridge.gd'))).toBe(false);
  });

  it('内容不同(项目自管/git tracked)→ 保留文件 + 返回提示(修复点:不再删 tracked 文件)', async () => {
    registerAutoload();
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), USER_MODIFIED_CONTENT, 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'mcp_bridge.gd'))).toBe(true);  // 保留
    expect(readFileSync(join(projectDir, 'mcp_bridge.gd'), 'utf-8')).toBe(USER_MODIFIED_CONTENT);
    expect(resultText(r)).toContain('kept');
  });

  it('N-5(审查): bundled 脚本缺失(工具安装损坏)→ 无法证明托管,保守不删', async () => {
    registerAutoload();
    writeFileSync(join(projectDir, 'mcp_bridge.gd'), BUNDLED_CONTENT, 'utf-8');
    // 移走 bundled 副本,模拟 opsScript 同目录的 mcp_bridge.gd 缺失
    const missingScriptsDir = join(tmpRoot, 'scripts-missing');
    mkdirSync(missingScriptsDir, { recursive: true });
    writeFileSync(join(missingScriptsDir, 'ops.gd'), '', 'utf-8');  // 无 mcp_bridge.gd
    const r = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir },
      { opsScript: join(missingScriptsDir, 'ops.gd'), projectDir } as never);
    expect(r?.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'mcp_bridge.gd'))).toBe(true);  // 修复前:被判工具托管而删除
    expect(resultText(r)).toContain('bundled copy missing');
  });

  it('清理全部端口的 secret 文件(A1 避让端口 9081/9082 残留都删)', async () => {
    registerAutoload();
    const godotDir = join(projectDir, '.godot');
    mkdirSync(godotDir, { recursive: true });
    writeFileSync(join(godotDir, 'mcp_bridge_9081.secret'), 'a'.repeat(32), 'utf-8');
    writeFileSync(join(godotDir, 'mcp_bridge_9082.secret'), 'b'.repeat(32), 'utf-8');
    writeFileSync(join(godotDir, 'other_cache.bin'), 'keep-me', 'utf-8');
    const r = await handleTool('game', { action: 'game_bridge_uninstall', project_path: projectDir }, ctx());
    expect(r?.isError).toBeFalsy();
    expect(existsSync(join(godotDir, 'mcp_bridge_9081.secret'))).toBe(false);
    expect(existsSync(join(godotDir, 'mcp_bridge_9082.secret'))).toBe(false);
    expect(existsSync(join(godotDir, 'other_cache.bin'))).toBe(true);  // 非 secret 文件不动
  });
});
