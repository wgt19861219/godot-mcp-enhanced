// runBlenderHeadless / runGodotHeadless 的共享进程编排(2026-09-18 重复分析收敛):
// spawn + Buffer[] 累积(C-PERF-01) + 超时 forceKillTree + error/close。
// label 参与错误文本前缀——blender/godot 各自的历史测试断言依赖该前缀,不可统一。
import { spawn } from 'child_process';
import { forceKillTree } from './process-state.js';
import { buildSafeEnv } from './godot-finder.js';

export interface HeadlessRunResult {
  exitCode: number | null;  // null = 超时被杀
  stdout: string;
  stderr: string;
}

export function runHeadlessCollector(
  label: string, binPath: string, args: string[], timeoutMs: number,
): Promise<HeadlessRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildSafeEnv() });

    // C-PERF-01: 用 Buffer[] 避免 O(n²) 字符串拼接
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      forceKillTree(proc);
      resolve({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      // 错误文本保留 "failed to spawn" 子串,与历史 import-check 测试断言兼容
      reject(new Error(`${label}: failed to spawn ${binPath}: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}
