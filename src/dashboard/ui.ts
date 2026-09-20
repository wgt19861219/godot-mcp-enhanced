// src/dashboard/ui.ts
// 纯 ANSI 终端渲染引擎 — 零依赖，不使用 ink/React
// 替代原 ui.tsx（ink+React），导出签名保持不变

import type { DashboardState, ToolStats } from './aggregator.js';
import { sparkline } from './sparkline.js';
import {
  LEVEL_COLORS, LEVEL_PREFIX, MODULE_COLORS, STATUS,
  SPARKLINE_COLORS, BORDER_COLOR, KEYBIND_COLOR, MODE_COLORS,
  fg, dim, bold, reset, colorize,
} from './themes.js';

// ─── ANSI 控制序列 ────────────────────────────────────────────────────────────

const ANSI = {
  CURSOR_HOME:    '\x1b[H',
  CLEAR_SCREEN:   '\x1b[2J',
  CLEAR_EOL:      '\x1b[K',
  ALT_SCREEN_ON:  '\x1b[?1049h',
  ALT_SCREEN_OFF: '\x1b[?1049l',
  CURSOR_HIDE:    '\x1b[?25l',
  CURSOR_SHOW:    '\x1b[?25h',
} as const;

// ─── Box-drawing 字符 ────────────────────────────────────────────────────────

const B = {
  TL: '┌', TR: '┐', BL: '└', BR: '┘',
  H: '─', V: '│',
  LJ: '├', RJ: '┤',
} as const;

// ─── UI 状态 ──────────────────────────────────────────────────────────────────

interface UIState {
  dashboard: DashboardState | null;
  paused: boolean;
  filter: string;
  levelFilter: string;         // 'ALL' | 'INFO' | 'WARN' | 'ERROR'
  inputMode: 'normal' | 'filter';
  filterInput: string;
  scrollOffset: number;
  streamEnded: boolean;
  cols: number;
  rows: number;
}

// ─── 字符串工具 ───────────────────────────────────────────────────────────────

// C-02 修复：正确处理 surrogate pair
// C-01 修复：直接扫描原始字符串，跳过 ANSI 转义序列

/** ANSI 转义序列正则（CSI 序列） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 计算字符串去掉 ANSI 转义后的显示宽度（正确处理 surrogate pair + CJK）。
 * @internal 测试用(批4审查 Nit-3):导出供 ui.test.ts 测真身,替代原复制体测试 */
export function visibleLen(s: string): number {
  // 去掉 ANSI 转义
  const clean = s.replace(ANSI_RE, '');
  let cols = 0;
  for (let i = 0; i < clean.length; ) {
    const cp = clean.codePointAt(i)!;
    cols += cp >= 0x1100 ? 2 : 1;
    // 跳过 surrogate pair 的低代理位
    i += cp > 0xFFFF ? 2 : 1;
  }
  return cols;
}

/**
 * 按显示宽度截断（C-01 修复：直接扫描原始字符串，维护原始偏移映射）。
 * 使用 ASCII '~' 作为截断标记（1 列宽），避免 U+2026 等模糊宽度字符的跨终端不一致。
 * @internal 测试用(批4审查 Nit-3)。
 */
export function truncW(s: string, maxCols: number): string {
  let cols = 0;
  let visibleEnd = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === '[') {
      i += 2;
      while (i < s.length && !/[a-zA-Z]/.test(s[i]!)) i++;
      if (i < s.length) i++;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const w = cp >= 0x1100 ? 2 : 1;
    if (cols + w > maxCols) {
      // 为截断标记预留 1 列
      if (cols < maxCols) {
        // 还剩空间，在当前可见文本末尾加 ~
        return s.slice(0, visibleEnd) + '~';
      }
      return s.slice(0, visibleEnd) + '~';
    }
    cols += w;
    visibleEnd = i + (cp > 0xFFFF ? 2 : 1);
    i = visibleEnd;
  }
  return s;
}

/** 简单 ASCII 截断（用于纯 ASCII 文本，如工具名） */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** 右填充到指定显示宽度（只在末尾加空格）。@internal 测试用(批4审查 Nit-3) */
export function padRight(s: string, maxCols: number): string {
  const vl = visibleLen(s);
  if (vl >= maxCols) return s;
  return s + ' '.repeat(maxCols - vl);
}

/** 格式化运行时间 */
function formatUptime(startTime: string): string {
  const diff = Date.now() - new Date(startTime).getTime();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── 面板渲染函数（全部返回 { lines: string[], height: number }）─────────────

// C-03 + I-01 + I-05 修复：每个面板精确控制输出行数

/** StatusBar：顶栏，固定 3 行 */
function renderStatusBar(state: DashboardState, paused: boolean, width: number): string[] {
  const uptime = formatUptime(state.startTime);
  const modeIcon = state.mode === 'unknown' ? STATUS.disconnected : STATUS.connected;
  const modeColor = MODE_COLORS[state.mode as keyof typeof MODE_COLORS] ?? 252;
  const pauseIcon = paused ? ` ${STATUS.paused}` : '';
  const project = state.projectPath
    ? `│ Project: ${truncate(state.projectPath, 30)} `
    : '';

  const content = ' ' +
    colorize(`${modeIcon} ${state.mode.toUpperCase()}`, modeColor) +
    ` ${project}│ Calls: ${state.totalCalls} │ Errors: ${state.totalErrors} │ Uptime: ${uptime}${pauseIcon}`;

  const innerW = width - 2;
  return [
    colorize(B.TL + B.H.repeat(innerW) + B.TR, BORDER_COLOR),
    colorize(B.V, BORDER_COLOR) + padRight(truncW(content, innerW), innerW) + colorize(B.V, BORDER_COLOR),
    colorize(B.LJ + B.H.repeat(innerW) + B.RJ, BORDER_COLOR),
  ];
}

/** LogStream：左面板，精确输出 targetLines 行 */
function renderLogStream(
  state: DashboardState, ui: UIState, targetLines: number, width: number,
): string[] {
  const logs = state.recentLogs.toArray();
  let filtered = logs;
  if (ui.filter) {
    // ADVISORY-3: 统一可选链 —— 损坏行/注入行经 JSON.parse 后可能缺 module/msg 字段,
    // 与 e.tool?.includes 对齐,避免运行时 TypeError
    filtered = filtered.filter(e =>
      e.module?.includes(ui.filter) || e.tool?.includes(ui.filter) || e.msg?.includes(ui.filter)
    );
  }
  if (ui.levelFilter !== 'ALL') {
    filtered = filtered.filter(e => e.level === ui.levelFilter.toLowerCase());
  }

  // 数据行数 = 总行数 - top(1) - title(1) - bottom(1)
  const dataLines = Math.max(0, targetLines - 3);
  const endIdx = Math.max(0, filtered.length - ui.scrollOffset);
  const startIdx = Math.max(0, endIdx - dataLines);
  const visible = filtered.slice(startIdx, endIdx);

  const innerW = width - 2;
  const lines: string[] = [];

  // 顶边框 + 标题
  lines.push(colorize(B.TL + B.H.repeat(innerW) + B.TR, BORDER_COLOR));
  const statusText = ui.paused ? ' (paused)' : ' (live)';
  const title = bold() + ' Log Stream' + statusText + reset();
  lines.push(colorize(B.V, BORDER_COLOR) + padRight(truncW(title, innerW), innerW) +
    colorize(B.V, BORDER_COLOR));

  // 日志行
  for (const entry of visible) {
    const time = entry.ts.slice(11, 19);
    const levelColor = LEVEL_COLORS[entry.level] ?? 252;
    const moduleColor = MODULE_COLORS[entry.module] ?? 252;
    const prefix = LEVEL_PREFIX[entry.level] ?? '';

    let text = dim() + time + reset() + ' ' +
      colorize(`[${entry.module}]`, moduleColor);
    if (prefix) text += ' ' + colorize(prefix, levelColor);
    text += ' ' + colorize(truncW(entry.msg, innerW - 22), levelColor);

    lines.push(colorize(B.V, BORDER_COLOR) +
      padRight(truncW(text, innerW), innerW) +
      colorize(B.V, BORDER_COLOR));
  }

  // 空行填充到精确行数
  while (lines.length < targetLines - 1) {
    lines.push(colorize(B.V, BORDER_COLOR) + ' '.repeat(innerW) + colorize(B.V, BORDER_COLOR));
  }

  // 底边框
  lines.push(colorize(B.BL + B.H.repeat(innerW) + B.BR, BORDER_COLOR));
  return lines;
}

/** ToolStatsTable：右上，精确输出 targetLines 行 */
function renderToolStatsTable(tools: ToolStats[], width: number, targetLines: number): string[] {
  const innerW = width - 2;
  const sorted = [...tools].sort((a, b) => b.calls - a.calls);
  // 数据行 = targetLines - top(1) - title(1) - header(1) - bottom(1)
  const maxDataRows = Math.max(0, targetLines - 4);
  const displayed = sorted.slice(0, maxDataRows);

  const lines: string[] = [];

  lines.push(colorize(B.TL + B.H.repeat(innerW) + B.TR, BORDER_COLOR));
  const title = bold() + ' Tool Stats (Top 10)' + reset();
  lines.push(colorize(B.V, BORDER_COLOR) + padRight(truncW(title, innerW), innerW) +
    colorize(B.V, BORDER_COLOR));

  if (displayed.length > 0) {
    const header = ' Tool'.padEnd(12) + '│' + 'Calls'.padStart(6) + '│' + '  Avg'.padStart(6);
    lines.push(colorize(B.V, BORDER_COLOR) + bold() +
      padRight(header.slice(0, innerW), innerW) + reset() +
      colorize(B.V, BORDER_COLOR));
  } else {
    lines.push(colorize(B.V, BORDER_COLOR) + ' '.repeat(innerW) + colorize(B.V, BORDER_COLOR));
  }

  for (const t of displayed) {
    const avg = t.calls > 0 ? Math.round(t.totalDurationMs / t.calls) : 0;
    const name = truncate(t.tool, 10).padEnd(11);
    const row = ' ' + name + '│' + String(t.calls).padStart(6) + '│' + (avg + 'ms').padStart(6);
    lines.push(colorize(B.V, BORDER_COLOR) + padRight(row.slice(0, innerW), innerW) +
      colorize(B.V, BORDER_COLOR));
  }

  // 填充到精确行数 - 1（底框）
  while (lines.length < targetLines - 1) {
    lines.push(colorize(B.V, BORDER_COLOR) + ' '.repeat(innerW) + colorize(B.V, BORDER_COLOR));
  }

  lines.push(colorize(B.BL + B.H.repeat(innerW) + B.BR, BORDER_COLOR));
  return lines;
}

/** PerformancePanel：右下，精确输出 targetLines 行 */
function renderPerformancePanel(state: DashboardState, width: number, targetLines: number): string[] {
  const ts = state.timeSeries;
  const callsData = ts.map(b => b.calls);
  const errorData = ts.map(b => b.errors);
  const latencyData = ts.map(b => b.count > 0 ? Math.round(b.totalDurationMs / b.count) : 0);
  const innerW = width - 2;
  const sparkW = Math.max(5, Math.min(30, innerW - 12));

  const lines: string[] = [];

  lines.push(colorize(B.TL + B.H.repeat(innerW) + B.TR, BORDER_COLOR));
  const title = bold() + ` Perf (${ts.length} min)` + reset();
  lines.push(colorize(B.V, BORDER_COLOR) + padRight(truncW(title, innerW), innerW) +
    colorize(B.V, BORDER_COLOR));

  const sparkRows = [
    { label: 'Calls', data: callsData, color: SPARKLINE_COLORS.calls },
    { label: 'Errors', data: errorData, color: SPARKLINE_COLORS.errors },
    { label: 'AvgLat', data: latencyData, color: SPARKLINE_COLORS.latency },
  ];

  for (const r of sparkRows) {
    const sp = sparkline(r.data, { maxWidth: sparkW });
    const text = ' ' + colorize(r.label.padEnd(7), r.color) + ' ' + sp;
    lines.push(colorize(B.V, BORDER_COLOR) + padRight(truncW(text, innerW), innerW) +
      colorize(B.V, BORDER_COLOR));
  }

  // 填充到精确行数 - 1（底框）
  while (lines.length < targetLines - 1) {
    lines.push(colorize(B.V, BORDER_COLOR) + ' '.repeat(innerW) + colorize(B.V, BORDER_COLOR));
  }

  lines.push(colorize(B.BL + B.H.repeat(innerW) + B.BR, BORDER_COLOR));
  return lines;
}

/** KeybindBar：底栏，固定 3 行 */
function renderKeybindBar(ui: UIState, width: number): string[] {
  const innerW = width - 2;
  const filterInfo = ui.filter ? ` [${ui.filter}]` : '';
  const levelInfo = ui.levelFilter !== 'ALL' ? ` [${ui.levelFilter}]` : '';
  const text = ` ↑/↓:scroll  f:filter${filterInfo}  l:level${levelInfo}  c:clear  q:quit  Space:pause`;

  return [
    colorize(B.LJ + B.H.repeat(innerW) + B.RJ, BORDER_COLOR),
    colorize(B.V, BORDER_COLOR) + colorize(padRight(truncW(text, innerW), innerW), KEYBIND_COLOR) +
      colorize(B.V, BORDER_COLOR),
    colorize(B.BL + B.H.repeat(innerW) + B.BR, BORDER_COLOR),
  ];
}

/** FilterPrompt 覆盖行 */
function renderFilterPrompt(filterInput: string, width: number): string {
  const innerW = width - 2;
  const text = bold() + fg(220) + 'Filter: ' + reset() + filterInput + '_';
  return colorize(B.V, BORDER_COLOR) + padRight(truncW(text, innerW), innerW) +
    colorize(B.V, BORDER_COLOR);
}

/** Stream ended 提示行 */
function renderStreamEnded(width: number): string {
  const innerW = width - 2;
  const text = fg(220) + 'Stream ended — press q to quit' + reset();
  return colorize(B.V, BORDER_COLOR) + padRight(truncW(text, innerW), innerW) +
    colorize(B.V, BORDER_COLOR);
}

// ─── composeFrame：拼接所有面板 ──────────────────────────────────────────────

function composeFrame(state: DashboardState | null, ui: UIState): string {
  // A-05 修复：无数据或终端太小时清屏
  if (!state || ui.cols < 30 || ui.rows < 12) {
    return ANSI.CURSOR_HOME + ANSI.CLEAR_SCREEN + 'Waiting for data...\n';
  }

  const totalWidth = ui.cols;
  const rightWidth = 42;
  const leftWidth = Math.max(20, totalWidth - rightWidth);

  // StatusBar: 固定 3 行
  const statusBar = renderStatusBar(state, ui.paused, totalWidth);

  // KeybindBar: 固定 3 行
  const keybindBar = renderKeybindBar(ui, totalWidth);

  // 额外行
  const extraLines: string[] = [];
  if (ui.inputMode === 'filter') {
    extraLines.push(renderFilterPrompt(ui.filterInput, totalWidth));
  }
  if (ui.streamEnded) {
    extraLines.push(renderStreamEnded(totalWidth));
  }

  // 中间区域精确行数 = 总行数 - StatusBar(3) - KeybindBar(3) - 额外行
  const midLines = Math.max(6, ui.rows - 6 - extraLines.length);

  // 左面板：LogStream 占满中间行数
  const logLines = renderLogStream(state, ui, midLines, leftWidth);

  // 右面板：按比例拆分给 ToolStats 和 Performance
  const toolTargetLines = Math.max(5, Math.floor(midLines * 0.55));
  const perfTargetLines = midLines - toolTargetLines;

  const tools = [...state.toolStats.values()];
  const toolLines = renderToolStatsTable(tools, rightWidth, toolTargetLines);
  const perfLines = renderPerformancePanel(state, rightWidth, perfTargetLines);

  // 合并右侧面板后逐行拼接
  const rightPanel = [...toolLines, ...perfLines];
  const midContent: string[] = [];
  for (let i = 0; i < midLines; i++) {
    const left = i < logLines.length ? logLines[i]! : ' '.repeat(leftWidth);
    const right = i < rightPanel.length ? rightPanel[i]! : '';
    midContent.push(left + right);
  }

  // I-03 修复：每行末尾加 CLEAR_EOL 防止旧内容残留
  const allLines = [
    ...statusBar,
    ...midContent,
    ...keybindBar,
    ...extraLines,
  ];

  return ANSI.CURSOR_HOME +
    allLines.map(l => l + ANSI.CLEAR_EOL).join('\n') +
    '\n';
}

// ─── 主渲染入口 ───────────────────────────────────────────────────────────────

export function renderDashboard(
  stateStream: AsyncIterable<DashboardState>,
  initialFilter?: string,
): { waitUntilExit: () => Promise<void> } {
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>(resolve => { exitResolve = resolve; });

  const ui: UIState = {
    dashboard: null,
    paused: false,
    filter: initialFilter ?? '',
    levelFilter: 'ALL',
    inputMode: 'normal',
    filterInput: '',
    scrollOffset: 0,
    streamEnded: false,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };

  let renderScheduled = false;

  function scheduleRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(() => {
      renderScheduled = false;
      try {
        const frame = composeFrame(ui.dashboard, ui);
        process.stdout.write(frame);
      } catch (e) {
        // A-01 修复：渲染异常时输出到 stderr 方便调试
        process.stderr.write(`[dashboard] render error: ${(e as Error).message}\n`);
      }
    });
  }

  function cleanup(): void {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
    process.stdout.removeAllListeners('resize');
    process.stdout.write(ANSI.CURSOR_SHOW + ANSI.ALT_SCREEN_OFF);
  }

  function doExit(): void {
    cleanup();
    exitResolve?.();
  }

  // I-03 修复：进入 alternate screen 后立即清屏
  process.stdout.write(ANSI.ALT_SCREEN_ON + ANSI.CLEAR_SCREEN + ANSI.CURSOR_HIDE);

  // raw mode 键盘输入 — requires TTY, skip if not available (e.g. piped stdout)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (chunk: string) => {
    // 过滤输入模式
    if (ui.inputMode === 'filter') {
      if (chunk === '\r' || chunk === '\n') {
        ui.filter = ui.filterInput;
        ui.inputMode = 'normal';
        ui.filterInput = '';
      } else if (chunk === '\x1b') {
        ui.inputMode = 'normal';
        ui.filterInput = '';
      } else if (chunk === '\x7f') {
        ui.filterInput = ui.filterInput.slice(0, -1);
      } else if (chunk.length === 1 && chunk.charCodeAt(0) >= 32) {
        ui.filterInput += chunk;
      }
      scheduleRender();
      return;
    }

    // 正常模式
    if (chunk === 'q') {
      doExit();
    } else if (chunk === ' ') {
      ui.paused = !ui.paused;
    } else if (chunk === 'f') {
      ui.inputMode = 'filter';
      ui.filterInput = '';
    } else if (chunk === 'l') {
      const levels = ['ALL', 'INFO', 'WARN', 'ERROR'];
      const idx = levels.indexOf(ui.levelFilter);
      ui.levelFilter = levels[(idx + 1) % levels.length]!;
    } else if (chunk === 'c') {
      if (ui.dashboard) {
        ui.dashboard.recentLogs.clear();
        ui.scrollOffset = 0;
      }
    } else if (chunk === '\x1b[A' || chunk === '\x1bOA') {
      // I-04 修复：同时匹配正常模式和应用模式方向键
      const maxOffset = Math.max(0, (ui.dashboard?.recentLogs.length ?? 1) - 1);
      ui.scrollOffset = Math.min(ui.scrollOffset + 1, maxOffset);
    } else if (chunk === '\x1b[B' || chunk === '\x1bOB') {
      ui.scrollOffset = Math.max(0, ui.scrollOffset - 1);
    } else if (chunk === '\r' || chunk === '\n') {
      ui.paused = !ui.paused;
    }
    scheduleRender();
  });

  // 终端大小变化
  process.stdout.on('resize', () => {
    ui.cols = process.stdout.columns || 80;
    ui.rows = process.stdout.rows || 24;
    scheduleRender();
  });

  // 消费状态流
  (async () => {
    try {
      for await (const s of stateStream) {
        ui.dashboard = s;
        // A-13: 仅在 scrollOffset=0（用户在底部）时保持自动跟随
        // 用户向上滚动时不重置 offset，避免跳回底部
        if (!ui.paused && ui.scrollOffset === 0) {
          ui.scrollOffset = 0;
        }
        scheduleRender();
      }
    } catch { /* 流异常结束 */ }
    ui.streamEnded = true;
    scheduleRender();
  })();

  // 退出时恢复终端（同步，确保可靠）
  process.on('exit', () => {
    try { process.stdout.write(ANSI.CURSOR_SHOW + ANSI.ALT_SCREEN_OFF); } catch { /* ignore */ }
  });

  // 初始渲染
  scheduleRender();

  return { waitUntilExit: () => exitPromise };
}
