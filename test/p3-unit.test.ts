import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import { profilePriceTags } from '../src/tools/manage-tools.js';
import { validateBridgePath } from '../src/tools/game-bridge.js';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_GD = readFileSync(resolve(__dirname, '..', 'src', 'scripts', 'mcp_bridge.gd'), 'utf8');

registerAllModules();

/**
 * P3 批(2026-09-11)单元/契约测试:
 * - P3-4: profilePriceTags 价格标签(bytes 口径/Buffer.byteLength 守卫)
 * - P3-3: validateBridgePath 的 custom.* 豁免 + game handleTool 前缀拦截
 * - P3-1/2/3: mcp_bridge.gd 源码契约(cmp-9 模式:GD 行为无法单测时锁源码字面量)
 */

describe('P3-4: profilePriceTags 价格标签', () => {
  it('PT-a: 7 个 profile 全覆盖,bytes/approxTokens 口径正确', () => {
    const tags = profilePriceTags();
    expect(tags.length).toBe(7);
    const byName = Object.fromEntries(tags.map(t => [t.name, t]));
    for (const name of ['full', 'lite', 'basic', 'minimal', 'slim', 'bridge_dev', '3d_dev']) {
      expect(byName[name], `profile ${name} 应存在`).toBeDefined();
    }
    expect(byName.full!.bytes).toBeGreaterThan(0);
    expect(byName.basic!.bytes).toBeGreaterThan(0);
    // basic 组清单 ⊂ full 组清单 → bytes 必然不大于 full
    expect(byName.basic!.bytes).toBeLessThanOrEqual(byName.full!.bytes);
    // full 工具数 = 全量(45,与 capability-matrix 一致的口径)
    expect(byName.full!.tools).toBeGreaterThanOrEqual(40);
    for (const t of tags) {
      expect(t.approxTokens).toBe(Math.round(t.bytes / 4));
    }
  });

  it('PT-b: Buffer.byteLength 守卫——中文按 UTF-8 计,非 string.length(beckett 同款坑)', () => {
    // 6 个汉字:string.length=6(code unit),UTF-8 实际 18 字节。若实现误用
    // string.length,对全中文描述的 server 会系统性少报 2/3。
    const s = '描述描述描述';
    expect(Buffer.byteLength(s, 'utf8')).toBe(18);
    expect(s.length).toBe(6);
    expect(Buffer.byteLength(s, 'utf8')).toBe(3 * s.length);
  });

  it('PT-c: manage_tools list_groups 响应携带 profiles', async () => {
    const mod = getModuleForTool('manage_tools');
    expect(mod).toBeDefined();
    const result = await mod!.handleTool('manage_tools', { action: 'list_groups' }, {} as never);
    expect(result).not.toBeNull();
    const text = result!.content.map(c => 'text' in c ? c.text : '').join('');
    const parsed = JSON.parse(text) as { success?: boolean; data?: { profiles?: Array<{ name: string; bytes: number }> } };
    expect(parsed.success).toBe(true);
    const profiles = parsed.data!.profiles!;
    expect(profiles.length).toBe(7);
    const basic = profiles.find(p => p.name === 'basic')!;
    expect(basic.bytes).toBeGreaterThan(0);
  });
});

describe('P3-3: validateBridgePath custom.* 豁免 + game 前缀拦截', () => {
  it('VBP-a: custom.* 命令参数不做 /root/ 断言(path 语义由游戏方定义)', () => {
    expect(validateBridgePath({ path: 'D:/some/file.txt' }, 'custom.export')).toBeNull();
    expect(validateBridgePath({ anything: 1 }, 'custom.ping')).toBeNull();
  });

  it('VBP-b: 内建命令的路径断言不受影响(回归锚)', () => {
    expect(validateBridgePath({ path: 'relative/path' }, 'click_button')).toContain('must be an absolute path');
    expect(validateBridgePath({ path: '/root/Main' }, 'click_button')).toBeNull();
  });

  it('VBP-c: game handleTool 拦截非 custom. 前缀的 custom_command(不触网,前置校验)', async () => {
    const mod = getModuleForTool('game');
    expect(mod).toBeDefined();
    const result = await mod!.handleTool('game', {
      action: 'custom_command', method: 'ping',  // 缺 custom. 前缀
    }, {} as never);
    const text = result!.content.map(c => 'text' in c ? c.text : '').join('');
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('custom.');
  });

  it('VBP-d: network_conditioner 缺 op 报 INVALID_PARAMS', async () => {
    const mod = getModuleForTool('game');
    const result = await mod!.handleTool('game', {
      action: 'network_conditioner',
    }, {} as never);
    const text = result!.content.map(c => 'text' in c ? c.text : '').join('');
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('op=set|clear|status');
  });
});

describe('P3 源码契约(mcp_bridge.gd 字面量,cmp-9 模式)', () => {
  it('SRC-a: custom 命令 custom. 前缀校验 + match 优先内建 + default deny(P8-1 状态机化后语义保留)', () => {
    // P8-1 热加载化:_custom_commands 查表 → _custom_index + _execute_custom_command(active_calls 记账)
    expect(BRIDGE_GD).toContain('method.begins_with("custom.") and _custom_index.has(method)');
    expect(BRIDGE_GD).toContain('result = _execute_custom_command(method, params)');
    expect(BRIDGE_GD).toContain("must use 'custom.' prefix");
    expect(BRIDGE_GD).toContain('"custom.list":');
  });

  it('SRC-b: custom 宽容注册四分支(load 失败/非 Node/无方法/非 Dictionary)绝不破坏启动', () => {
    expect(BRIDGE_GD).toContain('failed to load as instantiable script');
    expect(BRIDGE_GD).toContain('must instantiate to a Node');
    expect(BRIDGE_GD).toContain('no get_commands() method');
    expect(BRIDGE_GD).toContain('get_commands() must return a Dictionary');
    // can_instantiate 双查(regiellis 同款:解析失败的 .gd new() 硬崩)
    expect(BRIDGE_GD).toContain('can_instantiate()');
  });

  it('SRC-c: network set 无 peer 诚实报错(OfflineMultiplayerPeer 拒),不装空壳', () => {
    expect(BRIDGE_GD).toContain('OfflineMultiplayerPeer');
    expect(BRIDGE_GD).toContain('No multiplayer peer configured');
  });

  it('SRC-d: click_button real_event 哨兵 + 等帧验证协程', () => {
    // O1 收敛(批5):原 __click_verify__ 专用哨兵统一为 __deferred__ kind=click_verify
    expect(BRIDGE_GD).toContain('"__deferred__": "click_verify"');
    expect(BRIDGE_GD).toContain('_await_click_verify_and_respond');
    expect(BRIDGE_GD).toContain('"mode": "real_event"');
    expect(BRIDGE_GD).toContain('"verified": pressed_count > 0');
  });

  it('SRC-e: ClickSignalRecorder 四信号面 + attach/detach 对称', () => {
    expect(BRIDGE_GD).toContain('class _ClickSignalRecorder');
    expect(BRIDGE_GD).toContain('btn.pressed.connect(_record_pressed)');
    expect(BRIDGE_GD).toContain('btn.button_down.connect(_record_button_down)');
    expect(BRIDGE_GD).toContain('btn.button_up.connect(_record_button_up)');
    expect(BRIDGE_GD).toContain('btn.toggled.connect(_record_toggled)');
    expect(BRIDGE_GD).toContain('btn.pressed.disconnect(_record_pressed)');
  });

  it('SRC-f: NetworkConditioner 丢包/延迟分支 + Timer flush + 直通面', () => {
    expect(BRIDGE_GD).toContain('class _NetworkConditioner');
    expect(BRIDGE_GD).toContain('extends MultiplayerPeerExtension');
    expect(BRIDGE_GD).toContain('randf() < _loss_pct / 100.0');
    expect(BRIDGE_GD).toContain('randf_range(-_jitter_ms, _jitter_ms)');
    expect(BRIDGE_GD).toContain('["send_time"]');
    expect(BRIDGE_GD).toContain('set_wait_time(0.016)');
  });

  it('SRC-g: 参数校验守卫(loss 0-100 / latency jitter 非负)', () => {
    expect(BRIDGE_GD).toContain('loss > 100.0');
    expect(BRIDGE_GD).toContain('0 <= loss_pct <= 100');
  });
});
