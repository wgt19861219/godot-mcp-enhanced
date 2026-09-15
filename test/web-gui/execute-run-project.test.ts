// test/web-gui/execute-run-project.test.ts
// Web GUI 项目面板 Task 1:run 链抽取 executeRunProject + 三基础设施导出
// (isAliveStatus / getAllowedRealRoots / getContext)的等价性测试。
//
// 惯例来源:
// - 状态重置: ps.resetState()(test/web-gui/run-sessions-detailed.test.ts:10 →
//   test/process-state.test.js:75;简报骨架的 killAllRunSessions 不存在,弃用)。
// - env 覆盖: 显式保存 + afterEach 恢复(test/web-gui/env-gate.test.ts:105-108)。
//
// 实测校准(src/helpers.ts:112-124):requireProjectPath 对白名单外路径抛 PathError
// (审查 I-D 收口,2026-09-03),不回落默认路径——用例 4 断言 rejects;用例 3 需先
// UNRESTRICTED=true 放行路径检查,才能走到 case 体首行的 project.godot 存在性检查。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ps from '../../src/core/process-state.js';
import { executeRunProject } from '../../src/tools/runtime.js';
import type { ToolContext } from '../../src/types.js';

// 轻量 ctx:映射到真实 process-state(与 ToolDispatcher 构造器 :104-116 同款)
function makeCtx(): ToolContext {
  return {
    opsScript: 'dummy.gd',
    findGodot: async () => 'C:/godot/fake.exe',
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skip) { ps.setRunningProcess(proc, skip); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d) { ps.setProjectDir(d); },
  } as unknown as ToolContext;
}

describe('executeRunProject 抽取等价性(spec §8.1)', () => {
  const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;

  beforeEach(() => { ps.resetState(); });
  afterEach(() => {
    process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
  });

  it('isAliveStatus 已从 process-state 导出', async () => {
    const m = await import('../../src/core/process-state.js');
    expect(typeof (m as { isAliveStatus?: unknown }).isAliveStatus).toBe('function');
    expect((m as { isAliveStatus: (st: string) => boolean }).isAliveStatus('running')).toBe(true);
    expect((m as { isAliveStatus: (st: string) => boolean }).isAliveStatus('stopping')).toBe(true);
    expect((m as { isAliveStatus: (st: string) => boolean }).isAliveStatus('exited')).toBe(false);
  });

  it('getAllowedRealRoots 返回归一化数组(空 allowlist→空数组,由调用方 cwd 兜底)', async () => {
    const m = await import('../../src/core/path-utils.js');
    expect(Array.isArray(m.getAllowedRealRoots())).toBe(true);
  });

  it('非项目路径:返回 Not a Godot project 错误文本(存在性检查)', async () => {
    // UNRESTRICTED=true 放行 isPathInAllowedRoots,让流程走到 case 体首行
    // existsSync(project.godot) 检查——该路径非项目,返回错误文本而非抛错。
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    const r = await executeRunProject({ action: 'run_project', project_path: 'D:/definitely/not/a/project' }, makeCtx());
    const text = r?.content?.[0]?.type === 'text' ? r.content[0].text : String(r);
    expect(text).toContain('project.godot');
  });

  it('白名单外路径:抛 PathError(端点层转 403 的契约,helpers.ts:119 实测形态)', async () => {
    // 限定 allowlist 到无关根 + 明确关掉 UNRESTRICTED,Q:/ 必在白名单外。
    process.env.GODOT_MCP_UNRESTRICTED = 'false';
    process.env.ALLOWED_PROJECT_PATHS = 'C:/godot-mcp-task1-unrelated-root';
    await expect(
      executeRunProject({ action: 'run_project', project_path: 'Q:/outside/allowlist' }, makeCtx())
    ).rejects.toThrow();
  });
});
