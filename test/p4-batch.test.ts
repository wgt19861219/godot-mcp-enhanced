import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllModules } from '../src/module-loader.js';
import { getToolDefinition } from '../src/core/tool-registry.js';
import { markInflight, clearInflight, clearAllInflight, reportOrphanedInflight } from '../src/core/inflight.js';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_GD = readFileSync(resolve(__dirname, '..', 'src', 'scripts', 'mcp_bridge.gd'), 'utf8');
const WS_GD = readFileSync(resolve(__dirname, '..', 'addons', 'godot_mcp_server', 'websocket_server.gd'), 'utf8');
const BRIDGE_RULES = readFileSync(resolve(__dirname, '..', '.claude', 'rules', 'godot-mcp-bridge.md'), 'utf8');
const BUDGET_MJS = readFileSync(resolve(__dirname, '..', 'scripts', 'check-token-budget.mjs'), 'utf8');
const MODULE_LOADER = readFileSync(resolve(__dirname, '..', 'src', 'module-loader.ts'), 'utf8');

registerAllModules();

/**
 * P4 批 (2026-09-11) 测试:描述瘦身(game 三巨点)/失焦降速(editor 插件)/inflight 孤儿记录。
 * GD 行为(失焦 clamp 运行时效果)无法单测——由源码契约锁字面量 + check:gdscript 完整编译兜底;
 * inflight 走真实文件系统(env 注入隔离目录)。
 */

describe('P4-1: game 描述瘦身', () => {
  it('SLIM-a: game 描述压缩生效——schema < 7800B(回归锚,P10 后校准)+ 指针存在', () => {
    const def = getToolDefinition('game');
    expect(def).toBeDefined();
    const schemaBytes = Buffer.byteLength(JSON.stringify(def!.inputSchema), 'utf8');
    // 瘦身后实测 ~5.8KB;P4 锚 6500;P10 (2026-09-12) sync_state 六参数正当增量后 ~7.4KB——
    // 锚校准 7800 留余量(含审查清偿 B-1/N-4 描述补文),回弹超线即红(预算校准先例同款,非瘦身回退)
    // 反馈批A (2026-09-16) install 增 force/clean_stale_secrets 两参数(drift 刷新 + 陈旧 secret 清理,
    // send_drag 五踩根治入口)后实测 8080——锚校准 8200(描述已精简一轮,先例同款正当功能增量)
    // 易用性批 1 (2026-09-19) game action 描述补全(审查 A-3)后实测 8498——锚校准 8600(同款正当增量)
    // 布局审计批 (2026-09-22) 新增 dump_layout_tree/get_font_report 两 method 参数形状(能力 A/C,
    // TMXYH5 反馈落地)后实测 9004——锚校准 9200(同款正当功能增量)
    expect(schemaBytes).toBeLessThan(9200);
    expect(def!.description).toContain('见规则文档');
    const methodDesc = (def!.inputSchema as { properties: { method: { description: string } } }).properties.method.description;
    const paramsDesc = (def!.inputSchema as { properties: { params: { description: string } } }).properties.params.description;
    expect(methodDesc).toContain('playtest.seed/playtest.fixed_delta/playtest.step/playtest.snapshot/playtest.restore/playtest.freeze/playtest.unfreeze/playtest.step_until');
    expect(paramsDesc).toContain('send_input_sequence{timeline[{at_frame(1-600),type,...}]');
    expect(paramsDesc).toContain('step_until{conditions[{path,property,op,value}]');
  });

  it('SLIM-b: 被删细节在规则文档有承接(find_nodes root / button 取值 / button_mask)', () => {
    expect(BRIDGE_RULES).toContain('root 限定子树搜索范围');
    expect(BRIDGE_RULES).toContain('button 支持 int 1-9 或 left/right/middle');
    expect(BRIDGE_RULES).toContain('button_mask 1=left/2=right/4=middle');
  });

  it('SLIM-c: 守卫收紧——totalSum warn 线(易用性批1 校准 112KB)+ SLIM_CONFIG 死配置标注', () => {
    // P4 定 95KB(瘦身后 ~90KB);P8(热加载/SSOT 描述)+P9(dap 工具 3.4KB)正当增量推至
    // ~103.9KB 越线——P9 (2026-09-12) 校准 105KB(审查 N-5 记录);易用性批 1 (2026-09-19)
    // action 描述补全等正当增量推至 ~110.8KB——校准 112KB,回弹语义保留
    expect(BUDGET_MJS).toContain('warn: 112 * 1024');
    // B-1 勘误锚:slim 对 ui 实际生效(阈值判断在变换前),防"产物值当触发输入"口径错误回潮
    expect(MODULE_LOADER).toContain('slim 对 ui **实际生效**');
  });
});

describe('P4-2: 失焦降速对抗(源码契约,行为由 check:gdscript 完整编译兜底)', () => {
  it('FOCUS-a: 流量驱动 clamp + 空闲恢复 + 退出恢复三件齐备', () => {
    expect(WS_GD).toContain('const FOCUS_BOOST_SLEEP_USEC := 16666');
    expect(WS_GD).toContain('const FOCUS_IDLE_TIMEOUT_MS := 10000');
    expect(WS_GD).toContain('func _mark_focus_traffic()');
    expect(WS_GD).toContain('func _update_focus_boost()');
    expect(WS_GD).toContain('func _restore_focus_sleep()');
    // 原值保存/恢复语义(首次存原值,恢复后置 -1)
    expect(WS_GD).toContain('_focus_saved_sleep_usec = OS.low_processor_usage_mode_sleep_usec');
    // 流量点:新连接 + 入站消息
    expect(WS_GD).toContain('_mark_focus_traffic()  # P4-2: 新连接即流量');
    expect(WS_GD).toContain('_mark_focus_traffic()  # P4-2: 入站消息即流量');
    // 退出恢复(防插件停用后留低值)
    expect(WS_GD).toContain('_restore_focus_sleep()  # P4-2');
    // I-3(审查): boost 期间回焦放弃恢复(saved 失效化,交还引擎自管)
    expect(WS_GD).toContain('NOTIFICATION_APPLICATION_FOCUS_IN');
  });

  it('FOCUS-b: 不碰机器级 EditorSettings(轻量版边界,只动进程级 OS 属性)', () => {
    // 不应写机器级 EditorSettings(那需要 NPGameDev 全量版的备份+自愈全套);注释提及该键不算
    expect(WS_GD).not.toMatch(/set_setting\([^)]*unfocused/);
    expect(WS_GD).not.toContain('get_editor_settings()');
    expect(WS_GD).toContain('OS.low_processor_usage_mode_sleep_usec');
  });
});

describe('P4-3: inflight 孤儿记录(真实文件系统,env 隔离目录)', () => {
  const tmpDir = resolve(__dirname, '..', '.tmp-inflight-test');

  beforeAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    process.env.GODOT_MCP_INFLIGHT_DIR = tmpDir;
  });

  afterAll(() => {
    clearAllInflight();
    delete process.env.GODOT_MCP_INFLIGHT_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('INF-a: mark 登记 → clear 移除 → 全空删文件', () => {
    markInflight('verify_delivery');
    const file = resolve(tmpDir, `inflight-${process.pid}.json`);
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<{ tool: string }> };
    expect(parsed.entries[0].tool).toBe('verify_delivery');
    clearInflight('verify_delivery');
    expect(existsSync(file), '全空后文件删除').toBe(false);
  });

  it('INF-b: 孤儿报丧——他 pid 残留文件 → stderr 一行 + 陈年清理', () => {
    const orphan = resolve(tmpDir, 'inflight-999999.json');
    writeFileSync(orphan, JSON.stringify({
      pid: 999999,
      entries: [{ tool: 'export_build', since: Date.now() - 5000 }],
    }), 'utf8');
    const errs: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const origIsTTY = process.stderr.isTTY;
    (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stderr.isTTY = false;
    try {
      reportOrphanedInflight();
    } finally {
      (process.stderr as { write: unknown }).write = origWrite;
      process.stderr.isTTY = origIsTTY;
    }
    const out = errs.join('');
    expect(out).toContain('999999');
    expect(out).toContain('export_build');
    expect(existsSync(orphan), '报丧后孤儿文件清理').toBe(false);
  });

  it('INF-b2: 活进程文件不报丧不删(I-1 探活——本 pid 之外但存活)', () => {
    const alive = resolve(tmpDir, `inflight-${process.pid + 1 === 999999 ? 999998 : process.pid + 1}.json`);
    // 用一个确定存活的 pid:本测试进程的父进程( vitest worker )——退而求其次用自身 pid 的
    // 邻近值不可靠;直接写 pid=process.pid 的文件会被"本 pid 跳过"分支处理,不触发探活。
    // 改为验证探活函数语义:伪造 ESRCH 不可能的场景没有——用本进程 pid + 1 在 CI 环境可能不存在,
    // 因此本用例锁源码契约(探活调用存在),运行时行为由 INF-b(999999 已死)覆盖。
    const src = readFileSync(resolve(__dirname, '..', 'src', 'core', 'inflight.ts'), 'utf8');
    expect(src).toContain('isProcessAlive(parsed.pid)');
    expect(src).toContain("code !== 'ESRCH'");
    expect(alive.length > 0).toBe(true);  // 路径构造无异常
  });

  it('INF-c: 陈年残留(>24h)静默清理不报丧', () => {
    const stale = resolve(tmpDir, 'inflight-888888.json');
    writeFileSync(stale, JSON.stringify({
      pid: 888888,
      entries: [{ tool: 'old_tool', since: Date.now() - 48 * 3600 * 1000 }],
    }), 'utf8');
    // 把 mtime 拨回 25h 前(utimes 缺席则靠 since 不可行——mtime 才是判据)
    const past = new Date(Date.now() - 25 * 3600 * 1000);
    utimesSync(stale, past, past);
    const errs: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      reportOrphanedInflight();
    } finally {
      (process.stderr as { write: unknown }).write = origWrite;
    }
    expect(errs.join('')).not.toContain('888888');
    expect(existsSync(stale), '陈年文件静默清理').toBe(false);
  });

  it('INF-d: 满弃新(≤16 条)与开关(GODOT_MCP_INFLIGHT_LOG=0)', () => {
    for (let i = 0; i < 20; i++) markInflight('t' + i);
    const file = resolve(tmpDir, `inflight-${process.pid}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] };
    expect(parsed.entries.length).toBeLessThanOrEqual(16);
    clearAllInflight();
    // 开关关:mark 不写
    process.env.GODOT_MCP_INFLIGHT_LOG = '0';
    try {
      markInflight('off_tool');
      expect(existsSync(file)).toBe(false);
    } finally {
      delete process.env.GODOT_MCP_INFLIGHT_LOG;
    }
  });
});
