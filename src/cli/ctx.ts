/**
 * CLI 侧 ToolContext 构造(2026-08-21 架构审查 C-2:qa.ts/gif.ts 的 makeCtx 逐字重复收敛)。
 * ctx 仿 e2e 模式委托 process-state 单例(见 qa.ts 头注释的既有设计)。
 */
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ToolContext } from '../types.js';
import { parseGodotConfig } from '../core/config-parser.js';
import { findGodot } from '../core/godot-finder.js';
import * as ps from '../core/process-state.js';

const __rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// .gd 运行时脚本在开发态与 npm 态均位于 build/scripts/(package.json files: build/scripts/*.gd);
// 根 scripts/ 是构建脚本目录(无 .gd)——旧路径 join(__rootDir,'scripts',...) 两种形态下都
// 不存在,是 CLI qa setup「Bridge script not found」恒失败的根因(2026-08-20 demo 套件暴露)。
export function resolveOpsScript(): string {
  const candidates = [
    join(__rootDir, 'build', 'scripts', 'godot_operations.gd'),
    join(__rootDir, 'src', 'scripts', 'godot_operations.gd'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function makeCtx(): ToolContext {
  return {
    opsScript: resolveOpsScript(),
    findGodot,
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skipBusyCheck?) { ps.setRunningProcess(proc, skipBusyCheck); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d: string) { ps.setProjectDir(d); },
    parseGodotConfig,
  };
}
