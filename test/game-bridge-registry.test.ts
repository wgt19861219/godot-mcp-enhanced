// game-bridge-registry.test.ts — A1 (2026-08-19 反馈 bridge 9081 多实例劫持)
//
// TS 侧 resolveBridgePort: 读 machine-level bridge registry(GD mcp_bridge.gd 30s 心跳写入
// projectPath/port/pid/lastSeen)解析项目实例的实际监听端口(端口被占时 GD 侧自动避让)。
// 覆盖: projectPath 匹配/不匹配、多实例取最新、超龄条目忽略、损坏 JSON 容错、目录缺失回落。
// 范式: 纯函数直测 + tmpdir 伪 registry(经 registryDir 参数注入,不碰真实 %APPDATA%)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveBridgePort, normalizeProjectKey, machineRegistryInstancesDir, _markPortFailed, _isPortFailed, liveHeartbeatPortsFor, resetBridgeState } from '../src/tools/game-bridge.js';

let registryDir: string;

beforeEach(() => {
  registryDir = join(tmpdir(), `bridge-registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(registryDir, { recursive: true });
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true });
});

/** 模拟 GD Time.get_datetime_string_from_system():本地时间、无时区后缀的 ISO 串。
 *  (勿用 toISOString() 去掉 Z —— 那是 UTC 数值,被 Date.parse 按本地解析会差出时区偏移) */
function localIso(msAgo = 0): string {
  const d = new Date(Date.now() - msAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function writeEntry(name: string, projectPath: string, port: number, lastSeenMsAgo = 0, extra: Record<string, unknown> = {}): void {
  const entry = {
    id: name.replace('.json', ''),
    projectPath,
    port,
    pid: 12345,
    lastSeen: localIso(lastSeenMsAgo),
    capabilities: ['registry-heartbeat'],
    ...extra,
  };
  writeFileSync(join(registryDir, name), JSON.stringify(entry), 'utf-8');
}

// ── machineRegistryInstancesDir: 与 instance-manager getDefaultRegistryDir 共享 ──
describe('A1: machineRegistryInstancesDir(与 GD 侧推导对齐)', () => {
  it('三平台统一 ~/.godot-mcp/instances(GD OS.get_data_dir() 两次 base_dir 归一到 home)', () => {
    // GD 实测(Windows 4.6.3): get_data_dir()=%APPDATA%,两次 base_dir=用户主目录;
    // Linux(~/.local/share)/macOS(~/Library/Application Support)两次上跳同样到 ~。
    expect(machineRegistryInstancesDir()).toBe(join(homedir(), '.godot-mcp', 'instances'));
  });
});

describe('A1: normalizeProjectKey(跨进程 projectPath 匹配归一化)', () => {
  it('分隔符统一(反斜杠 → 正斜杠)', () => {
    expect(normalizeProjectKey('D:\\proj\\game').replace(/\\/g, '/')).toBe(normalizeProjectKey('D:/proj/game'));
  });

  it('win32 大小写不敏感(与 GD globalize 输出大小写差异无关)', () => {
    if (process.platform !== 'win32') return;
    expect(normalizeProjectKey('D:\\Proj\\Game')).toBe(normalizeProjectKey('d:/proj/game'));
  });
});

// ── resolveBridgePort: registry 解析主体 ─────────────────────────────────────
describe('A1: resolveBridgePort', () => {
  const proj = join(tmpdir(), 'proj-a');

  it('projectPath 为空 → 回落 9081(无从匹配)', () => {
    expect(resolveBridgePort('', registryDir)).toBe(9081);
  });

  it('registry 目录不存在 → 回落 9081(旧版 GD 不写 machine registry,完全兼容)', () => {
    const missing = join(registryDir, 'no-such-dir');
    expect(resolveBridgePort(proj, missing)).toBe(9081);
  });

  it('projectPath 匹配的条目 → 返回其实际端口(避让端口 9082)', () => {
    writeEntry('111_1.json', proj, 9082);
    expect(resolveBridgePort(proj, registryDir)).toBe(9082);
  });

  it('projectPath 不匹配(另一项目实例) → 回落 9081(多实例劫持场景的核心守护)', () => {
    writeEntry('111_1.json', join(tmpdir(), 'proj-B'), 9082);
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);
  });

  it('同项目多实例 → 取 lastSeen 最新(同项目双开时选最近活跃)', () => {
    writeEntry('111_1.json', proj, 9081, 60_000);
    writeEntry('222_2.json', proj, 9083, 1_000);
    expect(resolveBridgePort(proj, registryDir)).toBe(9083);
  });

  it('超龄条目(>5min 无心跳,崩溃残留)忽略 → 回落 9081', () => {
    writeEntry('111_1.json', proj, 9082, 6 * 60 * 1000);
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);
  });

  it('损坏 JSON 条目容错跳过,不炸整个解析', () => {
    writeFileSync(join(registryDir, 'corrupt.json'), '{not-json', 'utf-8');
    writeEntry('111_1.json', proj, 9084);
    expect(resolveBridgePort(proj, registryDir)).toBe(9084);
  });

  it('缺 port/projectPath 字段的畸形条目跳过', () => {
    writeFileSync(join(registryDir, 'noport.json'), JSON.stringify({ projectPath: proj }), 'utf-8');
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);
  });

  it('.tmp 残留与 .json 以外文件不参与解析', () => {
    writeFileSync(join(registryDir, '111_1.json.tmp'), '{"port":9999}', 'utf-8');
    writeFileSync(join(registryDir, 'notes.txt'), 'x', 'utf-8');
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);
  });

  it('server 自注册条目(capabilities=ts-http-receiver)不参与 —— 同目录混居防误匹配', () => {
    // instance-manager 的 server/editor 实例也写 ~/.godot-mcp/instances,但其 port 是
    // editor WS 端口(如 9090),不是 bridge 监听口;靠 capabilities 区分。
    writeFileSync(join(registryDir, 'editor-9090.json'), JSON.stringify({
      id: 'editor-9090', projectPath: proj, port: 9090, lastSeen: localIso(0),
      capabilities: ['ts-http-receiver'],
    }), 'utf-8');
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);  // 不被 9090 劫走
  });
});

// ── 回落窗口扫描(2026-08-21 PR#57 CI 实测暴露):缓解批起始候选随机化后,GD 大概率 ──
// ── 不绑 9081,registry 未命中时盲回落 9081 变「连不上」——回落升级为按 secret 文件 ──
// ── 存在性扫 9081-9090(mtime 最新优先;连错由 auth 语义防线拒绝)。                ──
describe('A1+: resolveBridgePort 回落窗口扫描(registry 未命中时)', () => {
  let projDir: string;

  beforeEach(() => {
    projDir = join(tmpdir(), `bridge-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projDir, '.godot'), { recursive: true });
  });
  afterEach(() => {
    rmSync(projDir, { recursive: true, force: true });
  });

  function writeSecret(port: number, mtimeMsAgo = 0): void {
    const p = join(projDir, '.godot', `mcp_bridge_${port}.secret`);
    writeFileSync(p, 's', 'utf-8');
    const t = new Date(Date.now() - mtimeMsAgo);
    utimesSync(p, t, t);
  }

  it('registry 空 + 单 secret(避让端口 9085)→ 扫描命中 9085(不再盲回落 9081)', () => {
    writeSecret(9085);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9085);
  });

  it('多 secret 共存(同项目多实例竞态)→ 取 mtime 最新', () => {
    writeSecret(9083, 60_000);
    writeSecret(9087, 1_000);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9087);
  });

  it('registry 命中优先于窗口扫描(registry 是更强真相源)', () => {
    writeEntry('111_1.json', projDir, 9082);
    writeSecret(9085);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9082);
  });

  it('registry 目录不存在(catch 路径)同样走扫描 → 9085', () => {
    writeSecret(9085);
    expect(resolveBridgePort(projDir, join(registryDir, 'no-such-dir'))).toBe(9085);
  });

  it('窗口外端口(9091)的 secret 不参与扫描(窗口=9081-9090,与 GD PORT_ATTEMPTS 对齐)', () => {
    writeSecret(9091);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9081);
  });
});

// ── A3 (2026-09-16 反馈批): 连接失败端口记忆 —— ECONNREFUSED 后端口解析自动避开、 ──
// ── 降级次新候选(09-03 反馈: 陈旧 secret mtime 压过活实例的 PERSISTENT_SECRET 场景)。 ──
describe('A3: 失败端口记忆与降级', () => {
  let projDir: string;

  beforeEach(() => {
    resetBridgeState();  // 清模块级 _failedPorts(测试隔离)
    projDir = join(tmpdir(), `bridge-failmem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projDir, '.godot'), { recursive: true });
  });
  afterEach(() => {
    resetBridgeState();
    rmSync(projDir, { recursive: true, force: true });
  });

  function writeSecret(port: number, mtimeMsAgo = 0): void {
    const p = join(projDir, '.godot', `mcp_bridge_${port}.secret`);
    writeFileSync(p, 's', 'utf-8');
    const t = new Date(Date.now() - mtimeMsAgo);
    utimesSync(p, t, t);
  }

  it('registry 命中端口刚失败 → 跳过,取次新心跳条目', () => {
    writeEntry('111_1.json', projDir, 9082, 1_000);   // 最新心跳
    writeEntry('222_2.json', projDir, 9084, 60_000);  // 次新
    _markPortFailed(9082);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9084);
  });

  it('扫描选中端口刚失败(mtime 最新)→ 降级次新 mtime(09-03 反馈核心场景)', () => {
    writeSecret(9082, 1_000);   // mtime 最新(1s 前)——陈旧 secret 压过活实例的形态
    writeSecret(9081, 60_000);  // mtime 次新(60s 前)
    expect(resolveBridgePort(projDir, registryDir)).toBe(9082);  // 未标记时选 mtime 最新
    _markPortFailed(9082);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9081);  // 标记后降级
  });

  it('registry 全部条目失败 → 回落窗口扫描', () => {
    writeEntry('111_1.json', projDir, 9082);
    writeSecret(9085);
    _markPortFailed(9082);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9085);
  });

  it('全部候选都失败 → 避无可避,返回 mtime 最新(候选语义连续)', () => {
    writeSecret(9083, 60_000);
    writeSecret(9086, 1_000);
    _markPortFailed(9086);
    _markPortFailed(9083);
    expect(resolveBridgePort(projDir, registryDir)).toBe(9086);
  });

  it('失败记忆 60s TTL 过期 → 端口恢复候选资格(防永久拉黑)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00'));
    try {
      _markPortFailed(9082);
      expect(_isPortFailed(9082)).toBe(true);
      vi.setSystemTime(new Date('2026-09-16T12:01:01'));  // 61s 后
      expect(_isPortFailed(9082)).toBe(false);  // 惰性过期
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetBridgeState 清失败记忆(测试隔离/服务重启语义)', () => {
    _markPortFailed(9082);
    expect(_isPortFailed(9082)).toBe(true);
    resetBridgeState();
    expect(_isPortFailed(9082)).toBe(false);
  });
});

// ── 批6-N-d(批5审查挂账): GODOT_MCP_BRIDGE_PORT_OVERRIDE 显式端口覆盖 ──────────
// ── 动机:test/bridge-auth-proof.test.ts 改 listen(0) 动态端口后出固定窗口         ──
// ── 9081-9090(GD 生产硬约束不为测试扩窗);override 让测试跳过解析链直连 mock。    ──
describe('N-d: resolveBridgePort 端口覆盖(GODOT_MCP_BRIDGE_PORT_OVERRIDE)', () => {
  const proj = join(tmpdir(), 'proj-override');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('合法端口 → 无条件覆盖(优先于 registry 命中条目与 projectPath 判定)', () => {
    writeEntry('111_1.json', proj, 9082);   // registry 命中条目存在——证明 override 优先
    vi.stubEnv('GODOT_MCP_BRIDGE_PORT_OVERRIDE', '12345');
    expect(resolveBridgePort(proj, registryDir)).toBe(12345);
    expect(resolveBridgePort('', registryDir)).toBe(12345);   // 空 projectPath 同覆盖(无条件语义)
  });

  it('非法值(非数字/越界/空串/非整数)→ 忽略覆盖,回落正常解析链', () => {
    writeEntry('111_1.json', proj, 9083);
    for (const bad of ['abc', '0', '70000', '', '9084.5']) {
      vi.stubEnv('GODOT_MCP_BRIDGE_PORT_OVERRIDE', bad);
      expect(resolveBridgePort(proj, registryDir), `override=${JSON.stringify(bad)}`).toBe(9083);
    }
  });
});

// ── A4 直测 (2026-09-16 反馈批,审查 B-1 修复): liveHeartbeatPortsFor 判活集合 ──
// ── 位置契约:与 resolveBridgePort 同源 machine registry(勿读 {project}/.godot/      ──
// ── mcp-instances——GD 的 project-level 心跳在 user:// 不可达,B-1 首版教训)。       ──
describe('A4: liveHeartbeatPortsFor(clean_stale_secrets 判活集合)', () => {
  const proj = join(tmpdir(), 'proj-clean');

  it('projectPath 匹配的新鲜心跳 → 端口入集合', () => {
    writeEntry('111_1.json', proj, 9081);
    writeEntry('222_2.json', proj, 9084);
    const ports = liveHeartbeatPortsFor(proj, registryDir);
    expect(ports.has(9081)).toBe(true);
    expect(ports.has(9084)).toBe(true);
    expect(ports.size).toBe(2);
  });

  it('projectPath 不匹配(另一项目)→ 不入集合(判活按项目隔离)', () => {
    writeEntry('111_1.json', join(tmpdir(), 'proj-other'), 9082);
    expect(liveHeartbeatPortsFor(proj, registryDir).size).toBe(0);
  });

  it('超龄心跳(>5min)与 server 自注册条目 → 不入集合(与 resolveBridgePort 同过滤)', () => {
    writeEntry('111_1.json', proj, 9082, 6 * 60 * 1000);  // 超龄
    writeFileSync(join(registryDir, 'server-x.json'), JSON.stringify({
      id: 'server-x', projectPath: proj, port: 9090, lastSeen: localIso(0),
      capabilities: ['ts-http-receiver'],
    }), 'utf-8');
    expect(liveHeartbeatPortsFor(proj, registryDir).size).toBe(0);
  });

  it('registry 目录不存在 → 空集(调用方按无法判活保守处理,P 空拒清)', () => {
    expect(liveHeartbeatPortsFor(proj, join(registryDir, 'no-such-dir')).size).toBe(0);
  });
});

// ── Task 4.4 (2026-09-17 架构审查 Low): lastSeenMs 毫秒精度 + pid 决胜 ─────────
// GD 旧心跳 lastSeen 是秒级串(Time.get_datetime_string_from_system)——同项目双开同秒启动
// 的两实例 lastSeen 相等,resolveBridgePort 靠 readdir 目录顺序摇摆取胜者(非确定);且
// liveHeartbeatPortsFor 对只有 lastSeenMs 的新条目(无串)会误判超龄。修复:GD 心跳新增
// lastSeenMs(UTC epoch ms),TS 侧优先消费;lastSeen 相同(同秒/同毫秒)以 pid 决胜。
describe('Task 4.4: lastSeenMs 毫秒精度 + pid 决胜(确定性端口解析)', () => {
  const proj = join(tmpdir(), 'proj-ms');

  it('4.4a: lastSeenMs 优先于 lastSeen 串(A 串更旧但 ms 更新 → A 胜,rolling upgrade 混居)', () => {
    // A:串 60s 前(旧读法看它旧),lastSeenMs 1s 前(新读法看它最新)
    writeEntry('111_1.json', proj, 9082, 60_000, { lastSeenMs: Date.now() - 1_000, pid: 100 });
    // B:串 2s 前(旧读法看它最新),无 lastSeenMs
    writeEntry('222_2.json', proj, 9084, 2_000);
    expect(resolveBridgePort(proj, registryDir)).toBe(9082);  // 旧代码此处返回 9084(只看串)
  });

  it('4.4b: 仅 lastSeenMs(无串)的新鲜条目参与解析与判活(新 GD 首个心跳未写串的窗口)', () => {
    writeEntry('111_1.json', proj, 9083, 60_000, { lastSeen: undefined, lastSeenMs: Date.now() - 1_000 });
    // JSON.stringify 会丢 undefined 键 → 条目只有 lastSeenMs;旧代码 Date.parse(undefined)=NaN 跳过
    expect(resolveBridgePort(proj, registryDir)).toBe(9083);
    expect(liveHeartbeatPortsFor(proj, registryDir).has(9083)).toBe(true);
  });

  it('4.4c: lastSeenMs 相同 → pid 高者胜(确定性;同秒双开不再靠目录顺序碰运气)', () => {
    const sameMs = Date.now() - 1_000;
    // 'a.json' 字母序在前(pid 低)——旧代码在字母序 readdir(Windows)下选 a,新代码 pid 决胜选 b
    writeEntry('a.json', proj, 9082, 60_000, { lastSeenMs: sameMs, pid: 100 });
    writeEntry('b.json', proj, 9084, 60_000, { lastSeenMs: sameMs, pid: 200 });
    expect(resolveBridgePort(proj, registryDir)).toBe(9084);
  });

  it('4.4d: lastSeenMs 超龄(>5min)同样被过滤(两种形态同一新鲜窗口)', () => {
    writeEntry('111_1.json', proj, 9082, 60_000, { lastSeenMs: Date.now() - 6 * 60 * 1000 });
    expect(resolveBridgePort(proj, registryDir)).toBe(9081);  // 回落
    expect(liveHeartbeatPortsFor(proj, registryDir).size).toBe(0);
  });
});
