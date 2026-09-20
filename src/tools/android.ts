import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { spawnGodot } from './spawn-helper.js';
import { detectGodotVersion } from '../core/godot-finder.js';
import { buildSafeEnv } from '../core/godot-finder.js';
import { resolveWithinRoot } from '../core/path-utils.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ACTIONS = ['list_devices', 'get_preset_info', 'deploy', 'check_template', 'logcat'] as const;

const ERROR_CODES = {
  ADB_NOT_FOUND: 'ADB_NOT_FOUND',
  NO_DEVICES: 'NO_DEVICES',
  NO_ANDROID_PRESET: 'NO_ANDROID_PRESET',
  EXPORT_FAILED: 'EXPORT_FAILED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  LAUNCH_FAILED: 'LAUNCH_FAILED',
  GODOT_NOT_FOUND: 'GODOT_NOT_FOUND',
  VERSION_DETECT_FAILED: 'VERSION_DETECT_FAILED',
  TEMPLATE_MISSING: 'TEMPLATE_MISSING',
  LOGCAT_FAILED: 'LOGCAT_FAILED',
} as const;

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const SERIAL_RE = /^[a-zA-Z0-9_-]+$/;
const EXPORT_TIMEOUT_MS = 300_000;

/** adb 路径:env ANDROID_ADB(存在性校验) → PATH 'adb' fallback。adb 是系统工具,不需 --version 探测。 */
function resolveAdb(): string {
  const fromEnv = process.env.ANDROID_ADB;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return 'adb';
}

/** 跑 adb,捕获 exit/stdout。ENOENT(adb 不存在)标记 notFound。 */
function runAdb(adb: string, args: string[]): { stdout: string; exitCode: number; notFound: boolean } {
  try {
    const stdout = execFileSync(adb, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
    return { stdout, exitCode: 0, notFound: false };
  } catch (err) {
    const e = err as { code?: string; stdout?: string; status?: number };
    if (e.code === 'ENOENT') return { stdout: '', exitCode: -1, notFound: true };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? -1, notFound: false };
  }
}

/** 解析 `adb devices -l` 输出为设备数组。 */
function parseDevices(stdout: string): Array<Record<string, string>> {
  const devices: Array<Record<string, string>> = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('* daemon')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    const dev: Record<string, string> = { serial, state };
    for (let i = 2; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const eq = part.indexOf(':');
      if (eq > 0) dev[part.slice(0, eq)] = part.slice(eq + 1);
    }
    devices.push(dev);
  }
  return devices;
}

interface PresetInfo {
  index: number; name: string; platform: string;
  runnable: boolean; exportPath: string; packageName: string;
}

/** 解析 export_presets.cfg(Godot ConfigFile/INI)。两级 section:[preset.N] 主 + [preset.N.options] 子;值去引号。 */
function parsePresetsCfg(content: string): PresetInfo[] {
  const sectionData: Record<string, Record<string, string>> = {};
  let current = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1]!; sectionData[current] = sectionData[current] ?? {}; continue; }
    const eq = line.indexOf('=');
    if (eq < 0 || !current) continue;
    const key = line.slice(0, eq).trim();  // key 含 '/'(如 package/name)是整体 key,非 section 分隔
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    sectionData[current]![key] = value;
  }
  const presets: PresetInfo[] = [];
  for (const sec of Object.keys(sectionData)) {
    const m = sec.match(/^preset\.(\d+)$/);
    if (!m) continue;
    const idx = parseInt(m[1]!, 10);
    const main = sectionData[sec]!;
    const opts = sectionData[`preset.${idx}.options`] ?? {};
    presets.push({
      index: idx, name: main.name ?? '', platform: main.platform ?? '',
      runnable: main.runnable === 'true', exportPath: main.export_path ?? '',
      packageName: opts['package/name'] ?? '',
    });
  }
  return presets;
}

/** 找 Android preset:按 name/index/platform 优先级。 */
function findAndroidPreset(cfgPath: string, presetName?: string, presetIndex?: number): PresetInfo | null {
  if (!existsSync(cfgPath)) return null;
  const presets = parsePresetsCfg(readFileSync(cfgPath, 'utf-8'));
  for (const p of presets) {
    if (p.platform !== 'Android') continue;
    if (presetName) { if (p.name === presetName) return p; else continue; }
    if (presetIndex !== undefined && presetIndex >= 0) { if (p.index === presetIndex) return p; else continue; }
    return p;
  }
  return null;
}

const validatePackage = (p: string): boolean => PACKAGE_RE.test(p);
const validateSerial = (s: string): boolean => SERIAL_RE.test(s);

/** Godot config 根路径(best-effort,不读 XDG/editor settings 覆盖)。 */
function godotConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') return join(process.env.APPDATA ?? home, 'Godot');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Godot');
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'godot');  // Linux(XDG_DATA_HOME 优先)
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'android') return null;
  const action = args.action as string;
  switch (action) {
    case 'list_devices': {
      const adb = resolveAdb();
      const r = runAdb(adb, ['devices', '-l']);
      if (r.notFound) {
        return opsErrorResult(ERROR_CODES.ADB_NOT_FOUND, 'adb not found. Install Android platform-tools or set ANDROID_ADB env.', {
          suggestion: 'Install Android platform-tools (Android Studio SDK Manager) or set ANDROID_ADB to the adb binary path.',
        });
      }
      const devices = parseDevices(r.stdout);
      if (devices.length === 0) {
        return opsErrorResult(ERROR_CODES.NO_DEVICES, 'No Android devices attached.', {
          suggestion: 'Connect a device with USB debugging enabled, or start an emulator.',
        });
      }
      return textResult(JSON.stringify({ devices, count: devices.length, adb_path: adb }));
    }
    case 'get_preset_info': {
      const projectDir = ctx.projectDir;
      if (!projectDir) return opsErrorResult(ERROR_CODES.NO_ANDROID_PRESET, 'project_path is required.');
      const cfgPath = join(projectDir, 'export_presets.cfg');
      if (existsSync(cfgPath) && statSync(cfgPath).size > 1_000_000) {
        return opsErrorResult('INVALID_PARAMS', `export_presets.cfg too large (>1MB), refuse to parse to avoid OOM`);
      }
      const preset = findAndroidPreset(cfgPath, args.preset_name as string | undefined, args.preset_index as number | undefined);
      if (!preset) {
        return opsErrorResult(ERROR_CODES.NO_ANDROID_PRESET, 'No Android export preset found.', {
          suggestion: 'Configure an Android preset in Godot Project > Export, then retry.',
        });
      }
      return textResult(JSON.stringify({
        index: preset.index, name: preset.name, platform: preset.platform,
        runnable: preset.runnable, export_path: preset.exportPath, package_name: preset.packageName,
      }));
    }
    case 'deploy': {
      const projectDir = ctx.projectDir;
      if (!projectDir) return opsErrorResult(ERROR_CODES.NO_ANDROID_PRESET, 'project_path is required.');
      const cfgPath = join(projectDir, 'export_presets.cfg');
      if (existsSync(cfgPath) && statSync(cfgPath).size > 1_000_000) {
        return opsErrorResult('INVALID_PARAMS', `export_presets.cfg too large (>1MB), refuse to parse to avoid OOM`);
      }
      const preset = findAndroidPreset(cfgPath, args.preset_name as string | undefined, args.preset_index as number | undefined);
      if (!preset) {
        return opsErrorResult(ERROR_CODES.NO_ANDROID_PRESET, 'No Android export preset found.', {
          suggestion: 'Configure an Android preset in Godot Project > Export first.',
        });
      }
      // apk 路径:res:// → projectDir 拼接 + 安全校验
      let apkAbs: string;
      try {
        apkAbs = preset.exportPath.startsWith('res://')
          ? resolveWithinRoot(projectDir, preset.exportPath.slice('res://'.length))
          : resolveWithinRoot(projectDir, preset.exportPath);
      } catch {
        return opsErrorResult(ERROR_CODES.EXPORT_FAILED, `Invalid apk path (traversal): ${preset.exportPath}`);
      }
      // 纵深防御: execFileSync(adb) 自身无 shell; validateSerial 针对 adb shell 设备端注入(launch/logcat 时 adb -s <serial> shell 把 args join 传设备 sh -c)
      const deviceSerial = args.device_serial as string | undefined;
      if (deviceSerial && !validateSerial(deviceSerial)) {
        return opsErrorResult(ERROR_CODES.INSTALL_FAILED, `Invalid device_serial: ${deviceSerial}`);
      }
      const skipExport = args.skip_export === true;
      const launch = args.launch !== false;
      const serialArgs = deviceSerial ? ['-s', deviceSerial] : [];

      // Step 1: export(必须 spawnGodot:buildSafeEnv + timeoutMs 300s,Android 导出 2-5 分钟)
      if (!skipExport) {
        const godotPath = await ctx.findGodot();
        const debug = args.debug !== false;
        const exportFlag = debug ? '--export-debug' : '--export-release';
        const r = await spawnGodot(godotPath, ['--headless', '--path', projectDir, exportFlag, preset.name, apkAbs], { timeoutMs: EXPORT_TIMEOUT_MS });
        if (r.exitCode !== 0) {
          return opsErrorResult(ERROR_CODES.EXPORT_FAILED, r.stderr || r.stdout || `godot export exit ${r.exitCode}`, {
            suggestion: 'Export failed. Install the Android export template (Godot Editor > Manage Export Templates), or check stderr.',
          });
        }
      }
      if (!existsSync(apkAbs)) {
        return opsErrorResult(ERROR_CODES.EXPORT_FAILED, `APK not found at ${apkAbs} after export.`);
      }

      // Step 2: install
      const adb = resolveAdb();
      const ir = runAdb(adb, [...serialArgs, 'install', '-r', apkAbs]);
      if (ir.notFound) return opsErrorResult(ERROR_CODES.ADB_NOT_FOUND, 'adb not found.', { suggestion: 'Set ANDROID_ADB or install platform-tools.' });
      if (ir.exitCode !== 0) {
        return opsErrorResult(ERROR_CODES.INSTALL_FAILED, ir.stdout || `adb install exit ${ir.exitCode}`, {
          suggestion: 'Install failed. Check device storage, signature, or uninstall the old version first.',
        });
      }

      // Step 3: launch(可选)——package 白名单防 adb shell 协议层注入(adb 把 args join 传设备 sh -c)
      if (launch) {
        if (!validatePackage(preset.packageName)) {
          return opsErrorResult(ERROR_CODES.LAUNCH_FAILED, `Invalid package name: ${preset.packageName}`, {
            suggestion: 'package/name in preset must match /^[a-zA-Z][a-zA-Z0-9_.]*$/.',
          });
        }
        const lr = runAdb(adb, [...serialArgs, 'shell', 'monkey', '-p', preset.packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
        if (lr.exitCode !== 0) return opsErrorResult(ERROR_CODES.LAUNCH_FAILED, lr.stdout || `adb shell exit ${lr.exitCode}`);
      }

      return textResult(JSON.stringify({
        preset: preset.name, apk_path: apkAbs,
        device: deviceSerial ?? '(default)', package_name: preset.packageName,
      }));
    }
    case 'check_template': {
      let godotPath: string;
      try { godotPath = await ctx.findGodot(); }
      catch { return opsErrorResult(ERROR_CODES.GODOT_NOT_FOUND, 'Godot binary not found.', { suggestion: 'Set GODOT_PATH or install Godot.' }); }
      let fullVersion: string;
      try {
        fullVersion = await detectGodotVersion(godotPath);
      } catch (err) {
        return opsErrorResult(ERROR_CODES.VERSION_DETECT_FAILED, (err as Error).message, {
          suggestion: 'godot --version failed. Check Godot binary is valid.',
        });
      }
      const majorMinor = fullVersion.match(/^(\d+\.\d+)/)?.[1] ?? fullVersion;  // 4.6.2.stable → 4.6
      const templateDir = join(godotConfigDir(), 'export_templates', majorMinor);
      const debugApk = join(templateDir, 'android_debug.apk');
      const releaseApk = join(templateDir, 'android_release.apk');
      const debugExists = existsSync(debugApk);
      const releaseExists = existsSync(releaseApk);
      const status = debugExists && releaseExists ? 'ok' : 'missing';
      if (status === 'missing') {
        return opsErrorResult(ERROR_CODES.TEMPLATE_MISSING, `Android export template missing for ${majorMinor}.`, {
          suggestion: `In Godot Editor: Editor > Manage Export Templates, download the ${majorMinor} templates. Expected at ${templateDir}.`,
        });
      }
      return textResult(JSON.stringify({
        godot_version: fullVersion, major_minor: majorMinor, template_dir: templateDir,
        android_debug: { path: debugApk, exists: debugExists },
        android_release: { path: releaseApk, exists: releaseExists },
        status,
      }));
    }
    case 'logcat': {
      const lines = (args.lines as number) ?? 100;
      const filter = (args.filter as string) ?? '';
      // 纵深防御: execFileSync(adb) 自身无 shell; validateSerial 针对 adb shell 设备端注入(launch/logcat 时 adb -s <serial> shell 把 args join 传设备 sh -c)
      const deviceSerial = args.device_serial as string | undefined;
      if (deviceSerial && !validateSerial(deviceSerial)) {
        return opsErrorResult(ERROR_CODES.LOGCAT_FAILED, `Invalid device_serial: ${deviceSerial}`);
      }
      const serialArgs = deviceSerial ? ['-s', deviceSerial] : [];
      const filterArgs = filter ? [filter] : [];
      const adb = resolveAdb();
      const r = runAdb(adb, [...serialArgs, 'logcat', '-d', '-t', String(lines), ...filterArgs]);
      if (r.notFound) return opsErrorResult(ERROR_CODES.ADB_NOT_FOUND, 'adb not found.', { suggestion: 'Set ANDROID_ADB or install platform-tools.' });
      if (r.exitCode !== 0) return opsErrorResult(ERROR_CODES.LOGCAT_FAILED, r.stdout || `adb logcat exit ${r.exitCode}`);
      return textResult(JSON.stringify({ lines, output: r.stdout, device: deviceSerial ?? '(default)' }));
    }
    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'android',
    description: 'Android Deploy 工具。list_devices: adb 设备列表。get_preset_info: 读 export_presets.cfg Android preset。deploy: export APK + adb install + launch(可选)。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: '操作类型。list_devices=列设备/模拟器, get_preset_info=查导出预设, deploy=构建安装启动, check_template=查导出模板安装状态, logcat=读日志' },
        project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
        lines: { type: 'number', description: 'logcat: dump 行数(默认 100)' },
        filter: { type: 'string', description: 'logcat: 过滤(如 *:E / GDScript:*)' },
        preset_name: { type: 'string', description: 'get_preset_info/deploy: preset 名' },
        preset_index: { type: 'number', description: 'deploy: preset 索引' },
        device_serial: { type: 'string', description: 'deploy: 设备 serial(adb -s)' },
        debug: { type: 'boolean', description: 'deploy: --export-debug(默认 true)' },
        launch: { type: 'boolean', description: 'deploy: 安装后启动(默认 true)' },
        skip_export: { type: 'boolean', description: 'deploy: 跳过导出(已有 APK)' },
      },
      required: ['action'],
    },
  }];
}

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  android: {
    readonly: false,
    long_running: true, // per-tool 粒度: deploy/export 慢需 long_running; list_devices/get_preset_info 秒级被错标但无害(客户端多显等待提示, 操作秒回)
    actionRisks: {
      list_devices: 'read',
      get_preset_info: 'read',
      check_template: 'read',
      logcat: 'read',
      deploy: 'process',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
