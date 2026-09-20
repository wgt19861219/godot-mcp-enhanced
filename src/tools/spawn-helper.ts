import { spawn, type ChildProcess } from 'child_process';
import { buildSafeEnv } from '../core/godot-finder.js';
import { forceKillTree } from '../core/process-state.js';

export interface SpawnResult {
  stdout: string;
  stderr: string;       // A-04: 分离 stderr，下游可精确判断错误来源
  output: string;       // A-04: stdout + stderr 合并输出（向后兼容）
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * 通用 Godot headless spawn：带超时、输出收集、settled 防重入。
 *
 * - `killFn` 默认使用 `forceKillTree`（杀整个进程树），可覆盖为 `proc.kill()` 等。
 * - spawn() 同步异常被捕获并返回 `{ exitCode: -1 }`。
 */
export function spawnGodot(
  godot: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    maxOutput?: number;
    killFn?: (proc: ChildProcess) => void;
  },
): Promise<SpawnResult> {
  const {
    timeoutMs = 60_000,
    maxOutput = 100_000,
    killFn = (p: ChildProcess) => { if (!p.killed) forceKillTree(p); },
  } = opts ?? {};

  const env = buildSafeEnv();

  return new Promise<SpawnResult>((resolve) => {
    let proc: ChildProcess;
    let settled = false;
    // H-05: Use Buffer[] to avoid O(n²) string concatenation
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    try {
      proc = spawn(godot, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (spawnErr) {
      const msg = `SPAWN_FAILED: ${(spawnErr as Error).message}`;
      resolve({
        stdout: msg,
        stderr: '',
        output: msg,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    proc.stdout!.on('data', (d: Buffer) => {
      if (stdoutBytes < maxOutput) { stdoutChunks.push(d); stdoutBytes += d.byteLength; }
    });
    proc.stderr!.on('data', (d: Buffer) => {
      if (stderrBytes < maxOutput) { stderrChunks.push(d); stderrBytes += d.byteLength; }
    });

    const collectOutput = () => {
      const out = Buffer.concat(stdoutChunks).toString('utf-8');
      const errOut = Buffer.concat(stderrChunks).toString('utf-8');
      return { out, errOut };
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killFn(proc);
      const { out, errOut } = collectOutput();
      resolve({ stdout: out, stderr: errOut, output: out + errOut, exitCode: null, timedOut: true });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const { out, errOut } = collectOutput();
      resolve({ stdout: out, stderr: errOut, output: out + errOut, exitCode: code, timedOut: false });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const { errOut } = collectOutput();
      // P3(2026-08-21 七维度审核): 与同步 spawn throw 同款 SPAWN_FAILED: 前缀——
      // 消费方(如 scene/index.ts)以 startsWith('SPAWN_FAILED:') 分类错误,此前 ENOENT
      // 走异步 error 事件无前缀,两路径错误分类不一致(错误不丢但语义分叉)。
      const fail = `SPAWN_FAILED: ${err.message}`;
      resolve({ stdout: fail, stderr: errOut, output: fail + (errOut ? `\n${errOut}` : ''), exitCode: -1, timedOut: false });
    });
  });
}
