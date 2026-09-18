import { runHeadlessCollector } from './headless-process.js';

export interface GodotRunResult {
  exitCode: number | null;  // null = 超时被杀
  stdout: string;
  stderr: string;
}

/**
 * spawn Godot headless + 累积 stdio + 超时 forceKillTree 杀进程树,返回 {exitCode,stdout,stderr}。
 *
 * 不做成败判断(exitCode 任值都 resolve),供 runImport(套 code 判断)与 check-gdscript(任意 exit 解析 stderr)共用。
 * 超时 → resolve {exitCode: null}(调用方自行判断);spawn 失败 → reject。
 * 禁止在调用方重写 spawn——继承 forceKillTree 防 CI Godot 卡住留僵尸。
 */
export function runGodotHeadless(
  args: string[],
  godotPath: string,
  timeoutMs: number = 60_000,
): Promise<GodotRunResult> {
  return runHeadlessCollector('runGodotHeadless', godotPath, args, timeoutMs);
}
