// test/web-gui/daemon-main.test.ts
// daemon 批 A(2026-09-30 spec §3.1/§3.3/§3.4):Task 5——进程入口决策段。
// 纯逻辑用例:不真起 GodotServer / 不真 listen(全链路起进程留批 C 真机验收)。
// 可测性拆分:runDaemon 的决策段(参数解析 / env 校验 / 单例检测)抽为导出的
// runDaemonStartupGate(env + registryDir 注入,零副作用),组装段(server/gui/
// endpoint)由 runDaemon 薄壳串联;env=0 用例直接调 runDaemon——第一道闸即抛,
// 不会触达 GodotServer 构造与端口监听。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, runDaemonStartupGate, parseDaemonArgs, resolveDaemonToolMode } from '../../src/daemon/main.js';
import { writeRegistration } from '../../src/web-gui/registry.js';

describe('daemon 入口(批 A Task 5)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'web-gui-daemon-main-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('parseDaemonArgs', () => {
    it('--port / --respawn-of 解析为数字;缺席或值缺失落 undefined', () => {
      expect(parseDaemonArgs(['--port', '9550'])).toEqual({ port: 9550, respawnOf: undefined });
      expect(parseDaemonArgs(['--respawn-of', '123'])).toEqual({ port: undefined, respawnOf: 123 });
      // 值缺席(如交接脚本拼参失误)→ Number(undefined)=NaN → 落 undefined,不抛
      expect(parseDaemonArgs(['--port'])).toEqual({ port: undefined, respawnOf: undefined });
      expect(parseDaemonArgs([])).toEqual({ port: undefined, respawnOf: undefined });
    });
  });

  describe('runDaemonStartupGate(spec §3.3 面板必起 + §3.4 入口层单例检测)', () => {
    it('GODOT_MCP_WEB_GUI=0 → 拒绝,信息含"daemon 模式依赖面板端口"', async () => {
      await expect(runDaemonStartupGate({ env: { GODOT_MCP_WEB_GUI: '0' } }))
        .rejects.toThrow(/daemon 模式依赖面板端口/);
    });

    it('无 daemon 登记 → 放行', async () => {
      await expect(runDaemonStartupGate({ env: {}, registryDir: dir })).resolves.toBeUndefined();
    });

    it('registry 有活 daemon(kind=daemon,pid=本测试进程)且无 --respawn-of → 拒绝,信息含已有实例 pid 与 port', async () => {
      // 活 pid 用本测试进程 pid(listRegistrations 默认 process.kill(pid,0) 探活通过)
      await writeRegistration({ pid: process.pid, port: 19571, token: 'tok_daemon_a', startedAt: 't', kind: 'daemon' }, { dir });
      await expect(runDaemonStartupGate({ env: {}, registryDir: dir }))
        .rejects.toThrow(new RegExp(`daemon already running: pid=${process.pid} port=19571`));
    });

    it('stdio 实例登记(kind=stdio)不触发 daemon 单例拒绝(stdio 与 daemon 可并存)', async () => {
      await writeRegistration({ pid: process.pid, port: 19572, token: 'tok_stdio_a', startedAt: 't', kind: 'stdio' }, { dir });
      await expect(runDaemonStartupGate({ env: {}, registryDir: dir })).resolves.toBeUndefined();
    });

    it('--respawn-of 豁免单例检测:registry 有旧活 daemon 也放行(spec §3.4 交接窗口)', async () => {
      await writeRegistration({ pid: process.pid, port: 19571, token: 'tok_daemon_b', startedAt: 't', kind: 'daemon' }, { dir });
      await expect(runDaemonStartupGate({ env: {}, respawnOf: process.pid, registryDir: dir }))
        .resolves.toBeUndefined();
    });
  });

  describe('resolveDaemonToolMode(终审 Fix-2:工具档位接 env 收口)', () => {
    // 接线点:runDaemon 内 new GodotServer(daemonOpsScript(), { mode: resolveDaemonToolMode(process.env) })
    // ——此前 daemon 构造无 options,落 GodotServer 兜底 full 档(GodotServer.ts `mode ?? 'full'`),
    // 与 stdio 生产默认 basic(G7)决策悬空;现与 index.ts 的 env 解析链同款(daemon 无
    // --profile CLI 参数面,配置入口唯一防两通道漂移,只接 env)。
    it('GODOT_MCP_PROFILE=full → full(构造入参同值,与 stdio 同一 env 入口)', () => {
      expect(resolveDaemonToolMode({ GODOT_MCP_PROFILE: 'full' })).toBe('full');
    });

    it('缺省 → basic(对齐 stdio 生产默认 G7,不再落 GodotServer 兜底 full)', () => {
      expect(resolveDaemonToolMode({})).toBe('basic');
    });

    it('GODOT_MCP_MODE legacy 档与 stdio 同链:PROFILE 缺席才生效,优先级 PROFILE > MODE > basic', () => {
      expect(resolveDaemonToolMode({ GODOT_MCP_MODE: 'full' })).toBe('full');
      expect(resolveDaemonToolMode({ GODOT_MCP_MODE: 'lite' })).toBe('lite');
      expect(resolveDaemonToolMode({ GODOT_MCP_PROFILE: 'lite', GODOT_MCP_MODE: 'full' })).toBe('lite');
    });
  });

  describe('runDaemon 薄壳:env=0 在第一道闸即拒(不触 GodotServer 构造)', () => {
    it('GODOT_MCP_WEB_GUI=0 时 runDaemon([]) 拒绝启动', async () => {
      const prev = process.env.GODOT_MCP_WEB_GUI;
      process.env.GODOT_MCP_WEB_GUI = '0';
      try {
        await expect(runDaemon([])).rejects.toThrow(/daemon 模式依赖面板端口/);
      } finally {
        if (prev === undefined) delete process.env.GODOT_MCP_WEB_GUI;
        else process.env.GODOT_MCP_WEB_GUI = prev;
      }
    });
  });
});
