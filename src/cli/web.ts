/**
 * 批 4b:Web 试玩闭环 CLI——`npx godot-mcp-enhanced web <project> [--port N]`。
 * 链路:findGodot → detectGodotVersion → export templates 检测/安装(确认+复用批 2
 * 信任链)→ ensureWebPreset → headless --export-release → 确认起服(127.0.0.1)→
 * 打印 URL,Ctrl+C 退出。`--serve-only <dir>` 跳过导出直接 serve(已导出重玩)。
 */
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { findGodot, detectGodotVersion } from '../core/godot-finder.js';
import { installExportTemplates, ensureWebPreset, exportWeb } from './web-exporter.js';
import { startWebServer } from './web-server.js';
import { confirmYesNo } from './confirm.js';
import { opt } from './args.js';

export async function runWeb(args: string[]): Promise<void> {
  const serveOnly = opt(args, 'serve-only');
  const portArg = opt(args, 'port');
  // L-2(2026-10-22 审查):非法 --port 值此前静默转 0(随机端口),用户指定被吞。
  // 显式给了 --port 就必须是 1-65535 整数,否则报错退出。
  let port = 0;
  if (portArg !== undefined) {
    if (!/^\d+$/.test(portArg) || Number(portArg) < 1 || Number(portArg) > 65535) {
      console.error(`✗ 无效 --port 值:"${portArg}"(需 1-65535 整数)`);
      process.exit(2);
    }
    port = Number(portArg);
  }

  if (serveOnly) {
    const dir = resolve(serveOnly);
    if (!existsSync(join(dir, 'index.html'))) {
      console.error(`--serve-only 目录缺少 index.html:${dir}`);
      process.exit(2);
    }
    if (!(await confirmYesNo(`在 127.0.0.1 启动静态服务器 serve ${dir}?`))) {
      console.error('已取消');
      process.exit(1);
    }
    await serveForever(dir, port);
    return;
  }

  const projectPath = resolve(args[0] ?? '.');
  if (!existsSync(join(projectPath, 'project.godot'))) {
    console.error('用法: web <project-path> [--port N] 或 web --serve-only <exported-dir> [--port N]');
    process.exit(2);
  }

  console.log('🌐 Web 试玩闭环(导出 → 本地服务器 → 浏览器可玩)');
  const godotPath = await findGodot();
  const version = await detectGodotVersion(godotPath);  // 如 "4.7.2.stable"
  console.log(`  Godot: ${godotPath}(${version})`);

  await installExportTemplates({
    version,
    confirm: () => confirmYesNo(`首次使用 Web 导出需下载 export templates ${version}(~1GB,官方 releases,SHA512 校验,装到机器级目录)。继续?`),
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  if (ensureWebPreset(projectPath)) {
    console.log('  已生成 export_presets.cfg(Web preset)');
  }
  const webDir = await exportWeb(projectPath, godotPath, (msg) => console.log(`  ${msg}`));
  console.log(`✓ Web 导出完成: ${webDir}`);

  if (!(await confirmYesNo(`启动本地服务器试玩(127.0.0.1${port ? ':' + port : ' 随机端口'})?`))) {
    console.log(`已跳过。之后可随时:npx godot-mcp-enhanced web --serve-only "${webDir}"`);
    return;
  }
  await serveForever(webDir, port);
}

async function serveForever(dir: string, port: number): Promise<never> {
  const running = await startWebServer(dir, port);
  console.log(`\n✓ 试玩地址: ${running.url}`);
  console.log('  (Ctrl+C 停止服务器并退出)');
  // 用一个不占 CPU 的常驻 promise 保活;SIGINT 里优雅关服
  await new Promise<never>((_resolve, reject) => {
    process.on('SIGINT', () => {
      running.close().finally(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      running.close().finally(() => process.exit(0));
    });
    // 未监听信号的异常退出兜底
    process.on('exit', () => { running.server.close(); });
    void reject; // 保持 promise pending(常驻)
  });
  process.exit(0);
}
