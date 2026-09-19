/**
 * 批 4b:Web 试玩闭环——export templates 检测/安装(复用批 2 下载信任链)+ Web preset
 * 生成 + headless 导出编排。
 *
 * 信任链复用(spec §3 批 4b):tpz 是 GitHub releases 官方资产,与 Godot 二进制同链
 * (域名白名单/SHA512 同源校验/失败即删/机器审计)。tpz 格式即 zip——批 4a 自写
 * zip reader 直接解。安装位置:Godot editor_data export_templates/<ver>.stable/
 * (版本必须与所用 Godot 完全一致,GODOT 严格匹配)。
 */
import { existsSync, readFileSync, renameSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { InternalError } from '../core/tool-errors.js';
import { buildReleaseUrls, downloadWithProgress, verifyDownloadedAsset, parseSha512Sums } from './godot-installer.js';
import { extractZip } from './zip-extract.js';
import { appendMachineAuditLine } from '../core/audit-log.js';
import { sanitizeMsg } from '../core/logger.js';

const execFileAsync = promisify(execFile);

/** Godot editor_data 根(Windows: %APPDATA%/Godot;macOS: ~/Library/Application Support/Godot;Linux: ~/.local/share/godot)。 */
export function godotDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Godot');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'godot');
}

/** export_templates/<ver>.stable 目录(ver 形如 "4.7.2.stable",detectGodotVersion 输出)。 */
export function templatesDirFor(version: string): string {
  return join(godotDataDir(), 'export_templates', version);
}

/** Web templates 就绪判定:Godot ≤4.5 为裸 web_release.wasm;4.6+ 为 web_release.zip——两者任一。 */
export function isWebTemplatesInstalled(version: string): boolean {
  const dir = templatesDirFor(version);
  return existsSync(join(dir, 'web_release.wasm')) || existsSync(join(dir, 'web_release.zip'));
}

/** 版本串 "4.7.2.stable" → release tag "4.7.2-stable" → 资产名模板。 */
export function exportTemplatesAssetTemplate(version: string): string {
  if (!/^\d+\.\d+\.\d+\.stable$/.test(version)) {
    throw new InternalError(`unsupported godot version string: ${version}`);
  }
  return 'Godot_v{v}-stable_export_templates.tpz';
}

/**
 * 安装 export templates:下载 tpz(SHA512 同源校验)→ 临时解压 → 原子移入
 * export_templates/<ver>.stable/ → 机器审计。已装则幂等跳过。
 */
export async function installExportTemplates(opts: {
  version: string;  // "4.7.2.stable"
  confirm: () => Promise<boolean>;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  const started = Date.now();
  const { version } = opts;
  if (isWebTemplatesInstalled(version)) {
    opts.onProgress?.(`export templates ${version} 已安装,跳过`);
    return;
  }
  const tag = version.replace('.stable', '-stable');
  const assetName = exportTemplatesAssetTemplate(version).replace('{v}', version.replace('.stable', ''));
  const { binaryUrl, sumsUrl } = buildReleaseUrls(tag, exportTemplatesAssetTemplate(version));
  const tmpDir = join(godotDataDir(), 'export_templates', `.tmp-${version}`);
  const tpzPath = join(tmpDir, assetName);
  const sumsPath = join(tmpDir, 'SHA512-SUMS.txt');

  opts.onProgress?.(`下载 ${assetName}(~1GB,首次安装较久)`);
  if (!(await opts.confirm())) throw new InternalError('export templates install cancelled by user');
  try {
    mkdirSync(tmpDir, { recursive: true });
    await downloadWithProgress(sumsUrl, sumsPath);
    const expected = parseSha512Sums(readFileSync(sumsPath, 'utf-8'), assetName);
    await downloadWithProgress(binaryUrl, tpzPath);
    await verifyDownloadedAsset(tpzPath, expected);
    // tpz 解压出 templates/ 目录 → 移入 export_templates/<ver>.stable/
    const extractTmp = join(tmpDir, 'extracted');
    await extractZip(tpzPath, extractTmp);
    const templatesSrc = join(extractTmp, 'templates');
    if (!existsSync(templatesSrc)) {
      const { readdirSync } = await import('fs');
      throw new InternalError(
        `tpz 解压后 templates/ 目录缺失;extracted/ 实际内容: ${readdirSync(extractTmp).join(', ')}(调试现场保留: ${tmpDir})`,
      );
    }
    // Godot 期望模板文件直接位于 export_templates/<ver>.stable/ 下(无 templates/ 中间层,
    // 本机 4.6.2.stable 结构为证)——tpz 内 templates/ 目录整体 rename 为目标目录
    const dest = templatesDirFor(version);
    rmSync(dest, { recursive: true, force: true });
    renameSync(templatesSrc, dest);
    rmSync(tmpDir, { recursive: true, force: true });
    if (!isWebTemplatesInstalled(version)) {
      throw new InternalError(`templates installed but web_release.wasm missing in ${dest}`);
    }
    await appendMachineAuditLine({
      trace_id: `install-templates-${version}-${started}`, tool: 'cli', action: 'install_export_templates', risk: 'process',
      ok: true, project_path: '', changed_files: [dest], duration_ms: Date.now() - started,
      details: { version, assetName, binaryUrl },
    });
    opts.onProgress?.(`✓ templates ${version} 安装完成`);
  } catch (err) {
    // 保留 .tmp 现场供诊断(下次成功安装时覆盖);失败审计照记
    // 2D (2026-09-19 安全加固批2): 错误消息脱敏(复用 logger sanitizeMsg,同 godot-installer)
    await appendMachineAuditLine({
      trace_id: `install-templates-${version}-${started}`, tool: 'cli', action: 'install_export_templates', risk: 'process',
      ok: false, project_path: '', changed_files: [], duration_ms: Date.now() - started,
      details: { version, error: sanitizeMsg(err instanceof Error ? err.message : String(err)) },
    });
    throw err;
  }
}

/** 最小 Web export preset(Godot 4 标准形态;项目已有 presets 则不覆盖)。 */
export function ensureWebPreset(projectPath: string): boolean {
  const presetsPath = join(projectPath, 'export_presets.cfg');
  if (existsSync(presetsPath)) return false;
  mkdirSync(projectPath, { recursive: true });
  const cfg = [
    '[preset.0]',
    '',
    'name="Web"',
    'platform="Web"',
    'runnable=true',
    'advanced_options=false',
    'dedicated_server=false',
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter=""',
    'export_path="build/web/index.html"',
    'patches=PackedStringArray()',
    'encryption_include_filters=""',
    'encryption_exclude_filters=""',
    'seed=0',
    'encrypt_pck=false',
    'encrypt_directory=false',
    '',
    '[preset.0.options]',
    '',
    'custom_template/debug=""',
    'custom_template/release=""',
    'variant/extension_support=false',
    'vram_texture_compression/for_desktop=true',
    'vram_texture_compression/for_mobile=false',
    'html/export_icon=true',
    'html/custom_html_shell=""',
    'html/head_include=""',
    'html/canvas_resize_policy=2',
    'html/focus_canvas_on_start=true',
    'html/experimental_virtual_keyboard=false',
    'progressive_web_app/enabled=false',
    'progressive_web_app/offline_page=""',
    'progressive_web_app/display=1',
    'progressive_web_app/orientation=0',
    '',
  ].join('\n');
  writeFileSync(presetsPath, cfg, 'utf-8');
  return true;
}

/** headless 导出(spec B-2 处置:官方支持路径,绕开 editor stub)。成功返回 build/web 目录。 */
export async function exportWeb(projectPath: string, godotPath: string, onProgress?: (msg: string) => void): Promise<string> {
  onProgress?.('headless 导出 Web 版(--export-release,可能需要 1-3 分钟)');
  mkdirSync(join(projectPath, 'build', 'web'), { recursive: true });  // Godot 不自动建导出目录
  try {
    const { stderr } = await execFileAsync(godotPath, ['--headless', '--export-release', 'Web', '--path', projectPath], {
      timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr && /error/i.test(stderr)) {
      onProgress?.(`导出器输出: ${stderr.slice(-300)}`);
    }
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new InternalError(`godot --export-release 失败: ${(e.stderr ?? e.message).slice(-500)}`);
  }
  const webDir = join(projectPath, 'build', 'web');
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new InternalError(`导出完成但 ${webDir}/index.html 缺失(检查 export preset 与模板版本匹配)`);
  }
  return webDir;
}
