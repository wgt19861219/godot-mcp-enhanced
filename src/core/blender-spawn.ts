import { runHeadlessCollector } from './headless-process.js';

export interface BlenderRunResult {
  exitCode: number | null;  // null = 超时被杀
  stdout: string;
  stderr: string;
}

/**
 * spawn blender headless + 累积 stdio + 超时 forceKillTree 杀进程树。
 * 对称 runGodotHeadless。不做成败判断(exitCode 任值都 resolve),调用方自行判断。
 */
export function runBlenderHeadless(
  args: string[],
  blenderPath: string,
  timeoutMs: number = 60_000,
): Promise<BlenderRunResult> {
  return runHeadlessCollector('runBlenderHeadless', blenderPath, args, timeoutMs);
}
