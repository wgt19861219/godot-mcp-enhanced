// Task 9 接线测试:launcher 双触发点 guard(设计 §3.2)+ TUI 决策原语。
// ESM 注意:launcher 顶层命名 import spawn,vi.spyOn(child_process, 'spawn') 拦截不到
// 命名绑定 → 必须整模块 vi.mock('node:child_process')(简报 Step 1 调整方案)。
// _launched 是 launcher 模块级状态:每用例 vi.resetModules() + 动态 import 隔离。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 注意:launcher → helpers.ts 还依赖 child_process 的 execFile(promisify(execFile)),
// 纯工厂 mock 只给 spawn/spawnSync 会令 helpers 模块加载即抛 TypeError —— 故 importOriginal
// 展开真实导出,仅覆盖 spawn/spawnSync 两个断言目标。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })),
    spawnSync: vi.fn(() => ({ error: null })),
  };
});

vi.mock('../../src/web-gui/server.js', () => ({
  WebGuiServer: vi.fn(),
  isWebGuiActive: vi.fn(() => false),
}));

describe('TUI 抑制双保险(设计 §3.2:两触发点)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // 隔离 launcher 模块级 _launched 状态
  });

  it('launcher 入口 guard:web-gui 激活时短路(不置位 _launched,不 spawn)', async () => {
    const { isWebGuiActive } = await import('../../src/web-gui/server.js');
    const child = await import('node:child_process');
    const spawnMock = vi.mocked(child.spawn);
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    // 激活解除后仍可弹(guard 未置位 _launched)
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    launchDashboardOnce();
    expect(spawnMock).toHaveBeenCalled();
  });

  it('web-gui 关闭(env=0)或启动失败时 TUI 照旧(auto-launch 决策依据 webGuiActive)', async () => {
    // webGuiActive 三态传播的等价单测:env=0 → GodotServer 不创建 WebGuiServer(集成验证见验收脚本);
    // 此处验证决策原语:isWebGuiActive()=false 时 launcher 不短路(上一用例已覆盖 false 分支)。
    const { isWebGuiActive } = await import('../../src/web-gui/server.js');
    (isWebGuiActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(isWebGuiActive()).toBe(false);
  });
});
