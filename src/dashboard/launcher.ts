// src/dashboard/launcher.ts
// Bridge 首次连接成功时，自动在新终端窗口启动 Dashboard TUI

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildSafeEnv } from '../helpers.js';
import { isWebGuiActive } from '../web-gui/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 模块级标志：整个 MCP 进程生命周期只启动一次 */
let _launched = false;

/**
 * spawn detached 子进程：挂 error 监听吞掉异步 ENOENT 等（防 uncaughtException 崩 MCP 进程），unref 不阻塞退出。
 * 触发苛刻（powershell/cmd/node/osascript 必存，linux 有 spawnSync probe 兜底），但 TOCTOU/异常环境仍可能命中，
 * 故每个 spawn 的 child 都必须挂 'error' 监听。
 */
function spawnDetached(cmd: string, args: readonly string[], opts: SpawnOptions): void {
  const child = spawn(cmd, args as string[], opts);
  child.on('error', () => {});
  child.unref();
}

/**
 * 在新终端窗口中启动 Dashboard TUI。
 * 仅在首次调用时生效，后续调用为空操作。
 * 失败时静默降级，不阻塞调用方。
 */
export function launchDashboardOnce(): void {
  if (_launched) return;

  // Web GUI 激活时抑制 TUI(设计 §3.2 双保险):功能被 Web 面板全覆盖,双开纯冗余。
  // 守在此入口统一覆盖两个触发点(index.ts 启动决策 + GodotServer.run() 装配的 bridge 首连回调)。
  // 不置位 _launched——web-gui 关闭/失败后的下一次调用仍可正常弹 TUI。
  if (isWebGuiActive()) return;

  // 环境变量禁用开关
  if (process.env.GODOT_MCP_NO_DASHBOARD === '1' || process.env.GODOT_MCP_NO_DASHBOARD === 'true') {
    return;
  }

  _launched = true; // I-2: 置位在禁用检查之后,避免首次被 NO_DASHBOARD 禁用后永久锁死

  const dashboardPath = join(__dirname, 'index.js');
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: use powershell Start-Process for reliable new-window launch
      // IMP-9 (2026-06-26 review): 用 buildSafeEnv 过滤敏感 env（GODOT_MCP_UNRESTRICTED/
      // GODOT_MCP_ALLOW_UNSAFE/ALLOW_EXECUTE_GDSCRIPT 等），dashboard 子进程不得解锁自身限制。
      const childEnv = { ...buildSafeEnv(), GODOT_MCP_NO_DASHBOARD: '1' };
      try {
        // IMPORTANT-1: PowerShell 单引号字面量转义(' → ''),防止安装路径含单引号
        // (如用户名 O'Brien)闭合 PS 字符串导致启动失败/命令注入
        const psPath = dashboardPath.replace(/'/g, "''");
        spawnDetached('powershell.exe', [
          '-WindowStyle', 'Hidden',
          '-Command',
          `Start-Process -FilePath 'node' -ArgumentList '${psPath}' -WindowStyle Normal`,
        ], {
          detached: true,
          stdio: 'ignore',
          env: childEnv,
        });
      } catch {
        // Fallback: cmd /c start
        try {
          spawnDetached('cmd', ['/c', 'start', '"godot-mcp-dashboard"', 'node', `"${dashboardPath}"`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: childEnv,
          });
        } catch {
          spawnDetached('node', [dashboardPath], {
            detached: true,
            stdio: 'ignore',
            env: childEnv,
          });
        }
      }
    } else if (platform === 'darwin') {
      // macOS: 使用 osascript 让 Terminal.app 执行
      // 用 quoted form of 防止路径中的特殊字符导致注入
      spawnDetached('osascript', ['-e', `tell application "Terminal"\ndo script "node " & quoted form of "${dashboardPath}"\nactivate\nend tell`], {
        detached: true,
        stdio: 'ignore',
        env: buildSafeEnv(),
      });
    } else {
      // Linux: 尝试常见终端模拟器
      const cmd = `node "${dashboardPath}"`;
      const terminals: [string, string[]][] = [
        ['gnome-terminal', ['--', 'bash', '-c', cmd]],
        ['konsole', ['-e', 'bash', '-c', cmd]],
        ['xterm', ['-e', cmd]],
      ];
      for (const [bin, args] of terminals) {
        // IMPORTANT-2: 同步探测终端是否可用。原代码 spawn 后立即 break,而 ENOENT 是异步
        // error 事件,导致无 gnome-terminal 的系统(如 KDE 默认)永远起不来且无感知。
        // spawnSync 的 probe.error 非 null 表示 bin 不存在(ENOENT),跳过尝试下一个。
        const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (probe.error) continue;
        try {
          spawnDetached(bin, args, { detached: true, stdio: 'ignore', env: buildSafeEnv() });
          break; // 成功 spawn 第一个可用终端后停止
        } catch {
          // 同步错误（极少见），尝试下一个
        }
      }
    }
  } catch {
    // 启动失败不阻塞 Bridge 功能
  }
}
