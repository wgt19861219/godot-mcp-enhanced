/**
 * Receiver for Godot's own remote-debugger profiler stream.
 * 来源:Erodenn-godot-mcp-runtime/src/utils/profiler.ts 整文件移植(2026-09-11 P2 批;
 * 除文件头/import/logger 三处适配外逐行一致——该文件经真引擎验证,刻意不重写)。
 *
 * `run_project({ profiling: true })` binds this listener first and passes
 * `--remote-debug tcp://127.0.0.1:<port>` to the spawned engine, so the
 * measurements are the stock editor ones — no engine build, no addon, and
 * nothing injected into the project. Attached sessions cannot profile: the
 * debugger channel only exists if it was on the command line at launch.
 *
 * Godot pauses the game on a script error or `breakpoint` while a debugger is
 * connected, so every `debug_enter` is answered with `continue` — profiling
 * must never turn a runtime error into a frozen window.
 */

import * as net from 'net';
import { decodeVariant, encodeVariant, MAX_PACKET_BYTES, type Variant } from './godot-variant.js';
import { getLogger } from './logger.js';

export type ProfilerErrorCode =
  | 'bad_args'
  | 'profile_busy'
  | 'profile_not_started'
  | 'profile_timeout'
  | 'profile_disconnected'
  | 'profile_no_frames'
  | 'profile_bad_frame';

export class ProfilerError extends Error {
  constructor(
    readonly code: ProfilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfilerError';
  }
}

export type ProfileSort = 'selfMs' | 'totalMs' | 'calls';

export const PROFILE_SORTS: readonly ProfileSort[] = ['selfMs', 'totalMs', 'calls'];
export const PROFILE_MAX_SECONDS = 60;
export const CAPTURE_LIMIT_MIN = 16;
export const CAPTURE_LIMIT_MAX = 512;
export const PROFILE_TOP_MAX = 100;

/** Bound on the rows kept for the slowest frame — a full frame is unbounded. */
const WORST_FRAME_ROWS = 30;
/** Every engine row is `[signature id, calls, self, total, internal]`. */
const ROW_STRIDE = 5;
/** Milliseconds are reported to this many decimals; below it is float noise. */
const MS_DECIMALS = 4;
const MS_ROUNDING = 10 ** MS_DECIMALS;

const WAIT_CONNECT_MS = 5000;
const WAIT_FIRST_FRAME_MS = 5000;
const WAIT_TOTAL_MS = 10000;

export interface ProfilePeak {
  frame: number;
  calls: number;
  selfMs: number;
  totalMs: number;
}

export interface ProfileRow {
  signature: string;
  function: string;
  file: string;
  line: number;
  sourceResolved: boolean;
  calls: number;
  selfMs: number;
  totalMs: number;
  callsPerFrame: number;
  selfMsPerFrame: number;
  totalMsPerFrame: number;
  msPerCall: number;
  /** Inclusive share of an average frame, the editor's "Frame %" measure. */
  percentOfFrame: number;
  peak: ProfilePeak | null;
}

/** Average and worst value of one per-frame measurement across the capture. */
export interface ProfileStat {
  avg: number;
  max: number;
}

/** The engine's own frame breakdown — the editor's "Frame Time" category. */
export interface FrameTimings {
  frameMs: number;
  processMs: number;
  physicsMs: number;
  physicsFrameMs: number;
  scriptMs: number;
}

export interface ProfileServer {
  name: string;
  msPerFrame: number;
  functions: Array<{ name: string; msPerFrame: number }>;
}

export interface ProfileStartResult {
  active: boolean;
  maxSeconds: number;
  firstFrame: number | null;
  captureLimit: number;
}

export interface ProfileResult {
  seconds: number;
  frames: number;
  framesReceived: number;
  firstFrame: number | null;
  lastFrame: number | null;
  frameGaps: number;
  /**
   * Debugger packets dropped because the codec could not represent them. A
   * non-zero value means the capture may be missing frames it was sent.
   */
  undecodablePackets: number;
  captureLimit: number;
  limitReached: boolean;
  sort: ProfileSort;
  functionsReceived: number;
  unresolvedFunctions: number;
  /** Per-frame engine breakdown, averaged over the capture and at its worst. */
  frame: Record<keyof FrameTimings, ProfileStat>;
  /** Server-side timings (physics, audio, …), averaged per frame. */
  servers: ProfileServer[];
  rows: ProfileRow[];
  worstFrame: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
}

/** One function's numbers inside a single received frame. */
interface FrameRow {
  signature: string;
  function: string;
  file: string;
  line: number;
  sourceResolved: boolean;
  calls: number;
  selfMs: number;
  totalMs: number;
}

interface Capture {
  limit: number;
  /** Window the caller asked for; the auto-stop is armed off the first frame. */
  maxSeconds: number;
  startedAt: number;
  elapsedMs: number;
  /** Frames folded into the totals (excludes the discarded boundary frame). */
  frames: number;
  framesReceived: number;
  frameGaps: number;
  /** Packets the codec could not represent while this capture was open. */
  undecodablePackets: number;
  firstFrame: number | null;
  lastFrame: number | null;
  capped: boolean;
  totals: Map<string, FrameRow>;
  peaks: Map<string, ProfilePeak>;
  timingSums: FrameTimings;
  timingMax: FrameTimings;
  /** server name → function name → summed milliseconds. */
  servers: Map<string, Map<string, number>>;
  worst: ({ frame: number } & FrameTimings & { rows: FrameRow[] }) | null;
  result: FrameRow[] | null;
}

type ProfilerState = 'idle' | 'starting' | 'capturing' | 'stopping' | 'finished';

interface Waiter {
  predicate: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** @internal 测试用(W10 批4 组A):导出供 parseFrame 单测直接覆盖 */
export function badFrame(what: string): ProfilerError {
  return new ProfilerError(
    'profile_bad_frame',
    `Unrecognized profiler frame layout (${what}) — this Godot version may not be supported`,
  );
}

/** @internal 测试用(W10 批4 组A) */
export function asNumber(value: Variant | undefined): number {
  if (typeof value !== 'number') throw badFrame('expected a number');
  return value;
}

/**
 * Loop bounds and element counts must be real non-negative integers. Plain
 * `asNumber` would accept a float — and a layout shift that lands a timing
 * value where a count belongs makes `for (i < 0.016)` run once instead of
 * throwing, walking `offset` off silently. Fail loudly on version drift.
 */
/** @internal 测试用(W10 批4 组A) */
export function asCount(value: Variant | undefined, limit: number): number {
  const count = asNumber(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
    throw badFrame(`expected a count in [0, ${limit}], got ${count}`);
  }
  return count;
}

/** Trim float noise from the summary — these are milliseconds, not physics. */
/** @internal 测试用(W10 批4 组A) */
export function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * MS_ROUNDING) / MS_ROUNDING) as T;
  if (Array.isArray(value)) return value.map(roundNumbers) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, roundNumbers(inner)]),
    ) as T;
  }
  return value;
}

const noTimings = (): FrameTimings => ({
  frameMs: 0,
  processMs: 0,
  physicsMs: 0,
  physicsFrameMs: 0,
  scriptMs: 0,
});

/** One received frame, in the same three parts the editor's tree shows. */
interface FrameSample {
  frame: number;
  timings: FrameTimings;
  servers: Array<{ name: string; functions: Array<{ name: string; ms: number }> }>;
  rows: FrameRow[];
  /**
   * Rows the engine actually sent, before zero-call rows are dropped. The
   * engine's `captureLimit` applies to this count, so the truncation check
   * has to use it rather than the filtered `rows.length`.
   */
  rawRowCount: number;
}

/**
 * Split the engine's per-frame array. Layout: the frame number, five timing
 * fields, a server count, that many `name, entryCount, ...name/time pairs`
 * blocks, then the flattened function rows preceded by their own length.
 * Verified against `ServersProfilerFrame::serialize()`; `internal_time` at
 * `i + 4` is deliberately skipped (the editor's "internal functions" toggle).
 */
/** @internal 测试用(W10 批4 组A):帧解析纯函数,布局漂移防线核心 */
export function parseFrame(data: Variant[], signatures: Map<number, string>): FrameSample {
  const timings: FrameTimings = {
    frameMs: asNumber(data[1]) * 1000,
    processMs: asNumber(data[2]) * 1000,
    physicsMs: asNumber(data[3]) * 1000,
    physicsFrameMs: asNumber(data[4]) * 1000,
    scriptMs: asNumber(data[5]) * 1000,
  };
  const servers: FrameSample['servers'] = [];
  let offset = 7;
  const serverCount = asCount(data[6], data.length);
  for (let i = 0; i < serverCount; i++) {
    const name = data[offset];
    const entries = asCount(data[offset + 1], data.length - offset);
    if (entries % 2 !== 0) throw badFrame('server block holds an odd entry count');
    const functions: Array<{ name: string; ms: number }> = [];
    for (let j = offset + 2; j < offset + 2 + entries; j += 2) {
      functions.push({ name: String(data[j]), ms: asNumber(data[j + 1]) * 1000 });
    }
    servers.push({ name: String(name), functions });
    offset += 2 + entries;
  }
  const length = asCount(data[offset], data.length - offset);
  offset += 1;
  if (length % ROW_STRIDE !== 0 || offset + length !== data.length) {
    throw badFrame('row block does not fill the packet');
  }
  const rows: FrameRow[] = [];
  for (let i = offset; i < offset + length; i += ROW_STRIDE) {
    const calls = asNumber(data[i + 1]);
    if (calls === 0) continue;
    const id = asNumber(data[i]);
    const resolved = signatures.get(id);
    const signature = resolved ?? `<unresolved:${id}>`;
    const parts = signature.split('::');
    rows.push({
      signature,
      file: parts.length >= 3 ? parts.slice(0, -2).join('::') : (parts[0] ?? ''),
      line: parts.length >= 3 ? Number(parts[parts.length - 2]) : 0,
      function: parts[parts.length - 1] ?? signature,
      sourceResolved: resolved !== undefined,
      calls,
      selfMs: asNumber(data[i + 2]) * 1000,
      totalMs: asNumber(data[i + 3]) * 1000,
    });
  }
  return {
    frame: asNumber(data[0]),
    timings,
    servers,
    rows,
    rawRowCount: length / ROW_STRIDE,
  };
}

export class DebuggerProfiler {
  private socket: net.Socket | null = null;
  /** Pending bytes, joined only once a whole frame has arrived (see `receive`). */
  private rxChunks: Buffer[] = [];
  private rxLength = 0;
  private threadId: Variant = null;
  private processId: number | null = null;
  private state: ProfilerState = 'idle';
  private error: string | null = null;
  private closed = false;
  private lastMessage: string | null = null;
  private lastDecodeError: string | null = null;
  private undecodable = 0;
  private signatures: Map<number, string> = new Map();
  private capture: Capture | null = null;
  private autoStopTimer: NodeJS.Timeout | null = null;
  private waiters: Waiter[] = [];

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (err) => this.fail(err.message));
  }

  /** Bind a loopback listener the spawned engine will dial back into. */
  static create(): Promise<DebuggerProfiler> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('Failed to bind a debugger port for profiling'));
          return;
        }
        server.removeListener('error', reject);
        resolve(new DebuggerProfiler(server, address.port));
      });
    });
  }

  /**
   * A finished capture is readable even once the engine is gone — `stop` only
   * re-ranks data already folded, and the capture worth reading is often the
   * one taken right before a crash.
   */
  get hasResult(): boolean {
    return this.capture?.result !== null && this.capture !== null;
  }

  get connected(): boolean {
    return this.socket !== null && this.threadId !== null;
  }

  /**
   * Enable the engine profiler and return once frames are arriving. The
   * capture stops itself after `seconds` so a forgotten `start_profiler`
   * cannot profile the rest of the session.
   */
  async start(seconds: number, captureLimit: number): Promise<ProfileStartResult> {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PROFILE_MAX_SECONDS) {
      throw new ProfilerError('bad_args', `seconds must be in (0, ${PROFILE_MAX_SECONDS}]`);
    }
    if (
      !Number.isInteger(captureLimit) ||
      captureLimit < CAPTURE_LIMIT_MIN ||
      captureLimit > CAPTURE_LIMIT_MAX
    ) {
      throw new ProfilerError(
        'bad_args',
        `captureLimit must be an integer in [${CAPTURE_LIMIT_MIN}, ${CAPTURE_LIMIT_MAX}]`,
      );
    }
    if (this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping') {
      throw new ProfilerError('profile_busy', 'A capture is already active');
    }

    await this.wait(
      () => this.threadId !== null,
      WAIT_CONNECT_MS,
      'Godot never opened the debugger connection',
    );

    this.signatures = new Map();
    this.capture = {
      limit: captureLimit,
      maxSeconds: seconds,
      startedAt: Date.now(),
      elapsedMs: 0,
      frames: 0,
      framesReceived: 0,
      frameGaps: 0,
      undecodablePackets: 0,
      firstFrame: null,
      lastFrame: null,
      capped: false,
      totals: new Map(),
      peaks: new Map(),
      timingSums: noTimings(),
      timingMax: noTimings(),
      servers: new Map(),
      worst: null,
      result: null,
    };
    this.state = 'starting';
    this.send(true, captureLimit);

    try {
      // `result` satisfies this too: if the engine closes the capture before a
      // frame is folded, that is an answer, not a reason to sit out the wait
      // and then report a timeout for a capture the engine actually finished.
      await this.wait(
        () => (this.capture?.frames ?? 0) > 0 || (this.capture?.result ?? null) !== null,
        WAIT_FIRST_FRAME_MS,
        'Godot sent no profiler frames',
      );
    } catch (err) {
      this.autoStop();
      throw err;
    }
    return {
      active: this.isCapturing(),
      maxSeconds: seconds,
      firstFrame: this.capture.firstFrame,
      captureLimit: captureLimit,
    };
  }

  /**
   * Stop an active capture (or re-read a finished one) and rank the functions.
   * The engine's own accumulated totals close the capture, so this waits for
   * the `profile_total` packet rather than summing the last frame.
   */
  async stop(top: number, sort: ProfileSort): Promise<ProfileResult> {
    if (!Number.isInteger(top) || top < 1 || top > PROFILE_TOP_MAX) {
      throw new ProfilerError('bad_args', `top must be an integer in [1, ${PROFILE_TOP_MAX}]`);
    }
    if (!PROFILE_SORTS.includes(sort)) {
      throw new ProfilerError('bad_args', `sort must be one of ${PROFILE_SORTS.join(', ')}`);
    }
    if (this.state === 'idle' || this.capture === null) {
      throw new ProfilerError('profile_not_started', 'Start a capture first');
    }
    this.autoStop();
    return this.finish(this.capture, top, sort);
  }

  /**
   * Wait out a known capture's close and rank it. Takes the capture rather than
   * re-reading `this.capture` so a caller that snapshotted one cannot be handed
   * a different capture's numbers.
   */
  private async finish(capture: Capture, top: number, sort: ProfileSort): Promise<ProfileResult> {
    try {
      await this.wait(
        () => capture.result !== null,
        WAIT_TOTAL_MS,
        'Godot sent no profiler totals',
      );
    } catch (err) {
      // Close the capture out either way, so it never sits in `stopping` and
      // stays re-readable. But only a timeout is recoverable here: the engine
      // went quiet while the connection held, and what we folded is still
      // good. A disconnect means the process died mid-capture, which the
      // caller needs told — a later stop_profiler re-reads the partial data.
      this.finalize(capture);
      const recoverable = err instanceof ProfilerError && err.code === 'profile_timeout';
      if (!recoverable || capture.frames === 0) throw err;
    }
    return this.summarize(capture, top, sort);
  }

  /** `start` + wait out the window + `stop`, for a one-shot capture. */
  async captureWindow(
    seconds: number,
    top: number,
    sort: ProfileSort,
    captureLimit: number = CAPTURE_LIMIT_MAX,
  ): Promise<ProfileResult> {
    await this.start(seconds, captureLimit);
    const capture = this.capture;
    if (capture === null) throw new ProfilerError('profile_not_started', 'Capture was discarded');
    await this.wait(
      () => capture.result !== null,
      seconds * 1000 + WAIT_TOTAL_MS,
      'Godot sent no profiler totals',
    );
    return this.finish(capture, top, sort);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state === 'starting' || this.state === 'capturing') {
      this.autoStop();
    }
    this.clearAutoStop();
    this.rejectWaiters(new ProfilerError('profile_disconnected', 'Profiler closed'));
    this.socket?.destroy();
    this.socket = null;
    this.server.close();
  }

  // --- transport ---

  private accept(socket: net.Socket): void {
    if (this.socket !== null || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => {
      // Release the slot even when `fail` short-circuits on an earlier error,
      // so `connected` stops claiming a peer that is gone.
      if (this.socket === socket) this.socket = null;
      this.fail('Debugger disconnected');
    });
  }

  /** Read one pending byte without joining the chunk list. */
  private byteAt(index: number): number {
    let remaining = index;
    for (const chunk of this.rxChunks) {
      if (remaining < chunk.length) return chunk[remaining] as number;
      remaining -= chunk.length;
    }
    throw new Error('Debugger read past the pending buffer');
  }

  private receive(chunk: Buffer): void {
    this.rxChunks.push(chunk);
    this.rxLength += chunk.length;
    while (this.rxLength >= 4) {
      // Read the length prefix in place. Joining on every socket chunk would
      // make assembling one large packet quadratic in its size.
      const size =
        this.byteAt(0) +
        this.byteAt(1) * 0x100 +
        this.byteAt(2) * 0x10000 +
        this.byteAt(3) * 0x1000000;
      if (size === 0) {
        this.fail('Debugger sent a zero-length packet (framing desync)');
        return;
      }
      if (size > MAX_PACKET_BYTES) {
        this.fail(`Debugger packet of ${size} bytes exceeds the ${MAX_PACKET_BYTES}-byte limit`);
        return;
      }
      if (this.rxLength < 4 + size) return;
      const joined =
        this.rxChunks.length === 1
          ? (this.rxChunks[0] as Buffer)
          : Buffer.concat(this.rxChunks, this.rxLength);
      const payload = joined.subarray(4, 4 + size);
      const rest = joined.subarray(4 + size);
      this.rxChunks = rest.length > 0 ? [rest] : [];
      this.rxLength = rest.length;
      let message: Variant;
      try {
        message = decodeVariant(payload);
      } catch (err) {
        // Unrelated debugger packets carry objects and vectors we don't decode.
        this.lastDecodeError = err instanceof Error ? err.message : String(err);
        this.undecodable += 1;
        if (this.capture !== null) this.capture.undecodablePackets += 1;
        continue;
      }
      try {
        this.handle(message);
      } catch (err) {
        // A frame we cannot parse is a stream we cannot trust, but it is not a
        // dropped connection — report it as what it is.
        const code = err instanceof ProfilerError ? err.code : 'profile_disconnected';
        this.fail(err instanceof Error ? err.message : String(err), code);
        return;
      }
      this.notify();
    }
  }

  private handle(message: Variant): void {
    if (!Array.isArray(message) || message.length !== 3) return;
    const [name, data] = [message[0], message[2]];
    const threadId = message[1] ?? null;
    if (typeof name !== 'string' || !Array.isArray(data)) return;
    this.lastMessage = name;

    if (name === 'set_pid') {
      this.threadId = threadId;
      this.processId = typeof data[0] === 'number' ? data[0] : null;
      return;
    }
    if (name === 'debug_enter') {
      // A script error or `breakpoint` halted the game; resume it immediately.
      this.write(['continue', threadId, []]);
      return;
    }
    const capturing =
      this.state === 'starting' || this.state === 'capturing' || this.state === 'stopping';
    if (!capturing || this.capture === null) return;

    if (name === 'servers:function_signature') {
      if (typeof data[0] === 'string' && typeof data[1] === 'number') {
        this.signatures.set(data[1], data[0]);
      }
      return;
    }
    if (name !== 'servers:profile_frame' && name !== 'servers:profile_total') return;

    const capture = this.capture;
    const sample = parseFrame(data, this.signatures);
    const rows = sample.rows;

    if (name === 'servers:profile_total') {
      // The engine's own accumulated rows are capped by `captureLimit` exactly
      // as the frame packets are, and carry nothing the frames did not already
      // deliver — while top-N membership rotates between frames, so summing
      // them covers strictly more functions. Verified against Godot: at a limit
      // of 16 the frames saw 37 distinct functions and this packet only 16, and
      // its call counts match our sums exactly. So this is a completion
      // sentinel, not the source of the totals.
      this.finalize(capture);
      return;
    }
    if (this.state === 'starting') this.state = 'capturing';
    capture.framesReceived += 1;
    // Enabling the profiler inside a running VM call gives that first sample a
    // zero start timestamp, so its elapsed time is fiction. Drop it — and with
    // it any truncation it reported, which describes numbers we discarded.
    if (capture.framesReceived === 1) return;

    // The engine fills each frame packet up to `captureLimit` rows, chosen by
    // inclusive time, before we drop the zero-call ones — so the raw count is
    // what says whether this frame was truncated.
    capture.capped = capture.capped || sample.rawRowCount >= capture.limit;

    const frame = sample.frame;
    capture.frames += 1;
    if (capture.frames === 1) {
      // Measure the window from real data, not from the enable round trip: the
      // handshake and first-frame latency are not time the game was profiled.
      capture.startedAt = Date.now();
      this.armAutoStop();
    }
    if (capture.firstFrame === null) capture.firstFrame = frame;
    if (capture.lastFrame !== null) {
      capture.frameGaps += Math.max(0, frame - capture.lastFrame - 1);
    }
    capture.lastFrame = frame;

    for (const key of Object.keys(capture.timingSums) as Array<keyof FrameTimings>) {
      capture.timingSums[key] += sample.timings[key];
      capture.timingMax[key] = Math.max(capture.timingMax[key], sample.timings[key]);
    }
    for (const server of sample.servers) {
      let functions = capture.servers.get(server.name);
      if (functions === undefined) {
        functions = new Map();
        capture.servers.set(server.name, functions);
      }
      for (const fn of server.functions) {
        functions.set(fn.name, (functions.get(fn.name) ?? 0) + fn.ms);
      }
    }

    for (const row of rows) {
      const total = capture.totals.get(row.signature);
      if (total === undefined) {
        capture.totals.set(row.signature, { ...row });
      } else {
        total.calls += row.calls;
        total.selfMs += row.selfMs;
        total.totalMs += row.totalMs;
      }
      const peak = capture.peaks.get(row.signature);
      if (peak === undefined || row.totalMs > peak.totalMs) {
        capture.peaks.set(row.signature, {
          frame,
          calls: row.calls,
          selfMs: row.selfMs,
          totalMs: row.totalMs,
        });
      }
    }
    if (capture.worst === null || sample.timings.frameMs > capture.worst.frameMs) {
      capture.worst = {
        frame,
        ...sample.timings,
        rows: [...rows].sort((a, b) => b.totalMs - a.totalMs).slice(0, WORST_FRAME_ROWS),
      };
    }
  }

  private summarize(capture: Capture, top: number, sort: ProfileSort): ProfileResult {
    if (capture.frames === 0) {
      // Dividing by a synthetic 1 here would return a well-formed payload of
      // zeroes and an empty `rows`, which reads exactly like "nothing in this
      // game is slow" rather than "nothing was measured".
      throw new ProfilerError(
        'profile_no_frames',
        `The capture folded no usable frames (received ${capture.framesReceived}; the first is ` +
          `always discarded), so there is nothing to rank`,
      );
    }
    const frames = capture.frames;
    const frame = {} as Record<keyof FrameTimings, ProfileStat>;
    for (const key of Object.keys(capture.timingSums) as Array<keyof FrameTimings>) {
      frame[key] = { avg: capture.timingSums[key] / frames, max: capture.timingMax[key] };
    }
    const servers: ProfileServer[] = [];
    for (const [name, functions] of capture.servers) {
      const entries = [...functions.entries()]
        .map(([fn, ms]) => ({ name: fn, msPerFrame: ms / frames }))
        .sort((a, b) => b.msPerFrame - a.msPerFrame);
      servers.push({
        name,
        msPerFrame: entries.reduce((sum, fn) => sum + fn.msPerFrame, 0),
        functions: entries,
      });
    }
    servers.sort((a, b) => b.msPerFrame - a.msPerFrame);

    const rows: ProfileRow[] = [];
    for (const row of capture.result ?? []) {
      if (row.calls <= 0) continue;
      const totalMsPerFrame = row.totalMs / frames;
      rows.push({
        ...row,
        callsPerFrame: row.calls / frames,
        selfMsPerFrame: row.selfMs / frames,
        totalMsPerFrame,
        msPerCall: row.totalMs / row.calls,
        percentOfFrame: frame.frameMs.avg > 0 ? (totalMsPerFrame / frame.frameMs.avg) * 100 : 0,
        peak: capture.peaks.get(row.signature) ?? null,
      });
    }
    rows.sort((a, b) => b[sort] - a[sort]);
    return roundNumbers({
      seconds: capture.elapsedMs / 1000,
      frames: capture.frames,
      framesReceived: capture.framesReceived,
      firstFrame: capture.firstFrame,
      lastFrame: capture.lastFrame,
      frameGaps: capture.frameGaps,
      undecodablePackets: capture.undecodablePackets,
      captureLimit: capture.limit,
      limitReached: capture.capped,
      sort,
      functionsReceived: rows.length,
      unresolvedFunctions: rows.filter((r) => !r.sourceResolved).length,
      frame,
      servers,
      rows: rows.slice(0, top),
      worstFrame: capture.worst,
    });
  }

  /** Read behind a call so `start`'s own state assignment doesn't narrow it. */
  private isCapturing(): boolean {
    return this.state === 'capturing';
  }

  private send(enabled: boolean, limit: number): void {
    this.write(['profiler:servers', this.threadId, enabled ? [true, [limit, false]] : [false]]);
  }

  private write(message: Variant): void {
    const socket = this.socket;
    if (socket === null) return;
    const raw = encodeVariant(message);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(raw.length, 0);
    try {
      socket.write(Buffer.concat([header, raw]));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private autoStop(): void {
    if (this.state !== 'starting' && this.state !== 'capturing') return;
    this.state = 'stopping';
    this.clearAutoStop();
    if (this.capture) this.send(false, this.capture.limit);
    this.notify();
  }

  private armAutoStop(): void {
    this.clearAutoStop();
    const seconds = this.capture?.maxSeconds ?? PROFILE_MAX_SECONDS;
    this.autoStopTimer = setTimeout(() => this.autoStop(), seconds * 1000);
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer === null) return;
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
  }

  /**
   * Close a capture out. Called on the engine's `profile_total`, and again if
   * that packet never arrives — a capture left in `stopping` would reject every
   * later `start` as busy while `stop` kept timing out, and the advice on that
   * error points straight back at `stop`.
   */
  private finalize(capture: Capture): void {
    if (capture.result === null) {
      capture.result = [...capture.totals.values()];
      capture.elapsedMs = Date.now() - capture.startedAt;
    }
    this.state = 'finished';
    this.clearAutoStop();
  }

  private fail(reason: string, code: ProfilerErrorCode = 'profile_disconnected'): void {
    // A clean teardown destroys the socket, which fires `close` — that is not a
    // disconnect worth reporting or logging.
    if (this.error !== null || this.closed) return;
    this.error = reason;
    getLogger().debug('profiler', `[Profiler] ${reason}`);
    // Stop reading: leaving the socket subscribed after a framing error means
    // the bad header stays at offset 0 and the pending buffer never drains.
    this.socket?.destroy();
    this.socket = null;
    this.rxChunks = [];
    this.rxLength = 0;
    this.rejectWaiters(new ProfilerError(code, reason));
  }

  // --- waiting ---

  private wait(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    if (this.error !== null || this.closed) {
      return Promise.reject(
        new ProfilerError('profile_disconnected', this.error ?? 'Profiler closed'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(
            new ProfilerError(
              'profile_timeout',
              `${what} (last debugger message: ${this.lastMessage ?? 'none'}; ` +
                `signatures: ${this.signatures.size}; decode: ${this.lastDecodeError ?? 'none'})`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate()) continue;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectWaiters(error: ProfilerError): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
