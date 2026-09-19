/**
 * 批 2:Godot 自动安装——官方 GitHub releases 下载器。
 *
 * 安全模型:
 * - 下载域名硬编码白名单(github.com / objects.githubusercontent.com / api.github.com),
 *   任何构造出的 URL 必须过 assertAllowedDownloadUrl(https + 域名在列);
 * - 版本 tag 白名单 /^\d+\.\d+\.\d+-stable$/(防任意 tag 拼接注入 URL);
 * - SHA512 校验与二进制**同 release 同信道**(SHA512-SUMS.txt),信任链 = 域名白名单,
 *   无跨信道信任假设(spec 未决项 1 实测结论:官方不提供独立 SHA256,提供同源 SHA512);
 * - 失败即删(校验不过不留半成品);零新 npm 依赖(fetch/crypto/系统 tar)。
 */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { InternalError } from '../core/tool-errors.js';

export const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'api.github.com'] as const;

export function assertAllowedDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InternalError(`download URL not in allowlist (unparseable): ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new InternalError(`download URL not https: ${url}`);
  }
  if (!(DOWNLOAD_HOSTS as readonly string[]).includes(parsed.hostname)) {
    throw new InternalError(`download host not in allowlist: ${parsed.hostname}`);
  }
}

export function assertStableVersionTag(tag: string): void {
  if (!/^\d+\.\d+\.\d+-stable$/.test(tag)) {
    throw new InternalError(`unsupported version tag (stable only): ${tag}`);
  }
}

/**
 * 平台资产名映射,返回带 `{v}` 占位符的模板(如 Godot_v{v}-stable_win64.exe.zip),
 * 由 buildReleaseUrls / installGodot 以具体版本填充——与官方 releases 资产命名一致。
 */
export function platformAssetName(platform: NodeJS.Platform, arch: string): string {
  const suffix =
    platform === 'win32' && arch === 'x64' ? 'win64.exe.zip' :
    platform === 'win32' && arch === 'arm64' ? 'windows_arm64.exe.zip' :
    platform === 'linux' && arch === 'x64' ? 'linux.x86_64.zip' :
    platform === 'linux' && arch === 'arm64' ? 'linux.arm64.zip' :
    platform === 'darwin' ? 'macos.universal.zip' : null;
  if (!suffix) throw new InternalError(`unsupported platform/arch: ${platform}/${arch}`);
  return `Godot_v{v}-stable_${suffix}`;
}

export function buildReleaseUrls(tag: string, assetTemplate: string): { binaryUrl: string; sumsUrl: string } {
  assertStableVersionTag(tag);
  const base = `https://github.com/godotengine/godot/releases/download/${tag}`;
  const binaryUrl = `${base}/${assetTemplate.replace('{v}', tag.replace('-stable', ''))}`;
  const sumsUrl = `${base}/SHA512-SUMS.txt`;
  assertAllowedDownloadUrl(binaryUrl);
  assertAllowedDownloadUrl(sumsUrl);
  return { binaryUrl, sumsUrl };
}

/** 解析官方 SHA512-SUMS.txt(`<sha512hex>␣␣<filename>` 双空格格式),返回小写 hex。 */
export function parseSha512Sums(sumsText: string, filename: string): string {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{128})\s\s+(.+)$/);
    if (match?.[1] && match[2]?.trim() === filename) return match[1].toLowerCase();
  }
  throw new InternalError(`entry not found in SHA512-SUMS.txt: ${filename}`);
}

/** 流式 SHA512(大文件不整读内存)。 */
export async function sha512File(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

// ─── 下载执行 + installGodot 编排 ─────────────────────────────────────────────

import { createWriteStream, readdirSync, readFileSync } from 'fs';
import { mkdir, rm, chmod, stat } from 'fs/promises';
import { Readable } from 'stream';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { appendMachineAuditLine } from '../core/audit-log.js';
import { sanitizeMsg } from '../core/logger.js';
import { readGodotPathsConfig, writeGodotPathsConfig, validateGodotBinary } from '../core/godot-finder.js';

/**
 * 解析要安装的版本 tag:GODOT_MCP_INSTALL_TAG(测试/复现 pin,不联网)> GitHub API latest。
 */
export async function fetchLatestStableTag(): Promise<string> {
  const pinned = process.env.GODOT_MCP_INSTALL_TAG;
  if (pinned) {
    assertStableVersionTag(pinned);
    return pinned;
  }
  const url = 'https://api.github.com/repos/godotengine/godot/releases/latest';
  assertAllowedDownloadUrl(url);
  const res = await fetch(url, { headers: { 'User-Agent': 'godot-mcp-enhanced-installer' } });
  if (!res.ok) throw new InternalError(`github api request failed: HTTP ${res.status}`);
  const data = await res.json() as { tag_name?: unknown };
  if (typeof data.tag_name !== 'string') throw new InternalError('github api response missing tag_name');
  assertStableVersionTag(data.tag_name);
  return data.tag_name;
}

/** 流式下载到 destPath;onProgress 收到累计字节数。 */
export async function downloadWithProgress(url: string, destPath: string, onProgress?: (bytes: number) => void): Promise<void> {
  assertAllowedDownloadUrl(url);
  await mkdir(dirname(destPath), { recursive: true });
  const MAX_ATTEMPTS = 3;
  let received = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      // 断点续传:重试时带 Range(GitHub assets 支持);首次 received=0 无 Range。
      // 断连残留文件保留,retry 以 append 续写;服务器忽略 Range(回 200)则从头重写。
      const headers: Record<string, string> = {};
      if (received > 0) headers['range'] = `bytes=${received}-`;
      const res = await fetch(url, { redirect: 'follow', headers });
      if (!res.ok && res.status !== 206 || !res.body) {
        throw new InternalError(`download failed: HTTP ${res.status}`);
      }
      const append = res.status === 206 && received > 0;
      if (!append) received = 0;
      const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
      source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.(received);
      });
      await pipeline(source, createWriteStream(destPath, { flags: append ? 'a' : 'w' }));
      return;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        await rm(destPath, { force: true });
        throw err;
      }
      // 指数退避后断点续传(大文件单流直连易被远端断开,批 4b 实测 1GB@787MB 处断)。
      // N-3(审查):'data' 计数会领先未 flush 的写缓冲——以磁盘实际字节为续传起点
      try { received = (await stat(destPath)).size; } catch { received = 0; }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** SHA512 校验;不匹配即删文件(不留半成品)并抛错。 */
export async function verifyDownloadedAsset(filePath: string, expectedSha512: string): Promise<void> {
  const actual = await sha512File(filePath);
  if (actual !== expectedSha512.toLowerCase()) {
    await rm(filePath, { force: true });
    throw new InternalError(
      `sha512 mismatch: expected ${expectedSha512.slice(0, 12)}…, got ${actual.slice(0, 12)}… — file deleted: ${filePath}`,
    );
  }
}

/** 解压 zip(自写零依赖 reader,见 zip-extract.ts——系统 tar 方案已废弃:Linux GNU tar 无 zip 支持 + Windows GNU tar 绝对路径 host:path 坑)。 */
import { extractZip } from './zip-extract.js';
export { extractZip };

/** 在解压目录定位 Godot 可执行文件(win: Godot_v*.exe;mac: Godot.app;linux: 无扩展名二进制)。 */
export function findExtractedBinary(dir: string): string {
  const entries = readdirSync(dir);
  if (process.platform === 'win32') {
    const exe = entries.find(e => /^Godot_v.*\.exe$/i.test(e));
    if (exe) return join(dir, exe);
  } else if (process.platform === 'darwin') {
    if (entries.includes('Godot.app')) return join(dir, 'Godot.app', 'Contents', 'MacOS', 'Godot');
  } else {
    const bin = entries.find(e => /^Godot_v.*/.test(e) && !/\.(zip|tpz|txt|tmp)$/i.test(e));
    if (bin) return join(dir, bin);
  }
  throw new InternalError(`extracted Godot binary not found in ${dir}`);
}

export interface InstallResult {
  godotPath: string;
  versionTag: string;
}

/**
 * 安装编排:tag 解析 → URL 构造 → 用户确认(CLI 交互,非 MCP 链路)→
 * 下载 SUMS + 二进制 → SHA512 同源校验(失败即删)→ tar 解压 → 删 zip →
 * 登记 godot-paths.json(搜索链 + 白名单)→ 机器级审计(成功/失败都记)。
 */
export async function installGodot(opts: {
  versionTag?: string;
  confirm: () => Promise<boolean>;
  onProgress?: (msg: string) => void;
}): Promise<InstallResult> {
  const started = Date.now();
  const versionTag = opts.versionTag
    ? (assertStableVersionTag(opts.versionTag), opts.versionTag)
    : await fetchLatestStableTag();
  const assetTemplate = platformAssetName(process.platform, process.arch);
  const assetName = assetTemplate.replace('{v}', versionTag.replace('-stable', ''));
  const { binaryUrl, sumsUrl } = buildReleaseUrls(versionTag, assetTemplate);
  const installDir = join(homedir(), '.godot-mcp', 'godot', versionTag);
  const zipPath = join(installDir, assetName);
  const sumsPath = join(installDir, 'SHA512-SUMS.txt');
  const traceId = `install-${versionTag}-${started}`;

  opts.onProgress?.(`资产: ${assetName}`);
  opts.onProgress?.(`目标: ${installDir}`);
  if (!(await opts.confirm())) {
    throw new InternalError('install cancelled by user');
  }

  try {
    opts.onProgress?.('下载 SHA512-SUMS.txt …');
    await downloadWithProgress(sumsUrl, sumsPath);
    const expected = parseSha512Sums(readFileSync(sumsPath, 'utf-8'), assetName);

    opts.onProgress?.(`下载 ${assetName} …`);
    await downloadWithProgress(binaryUrl, zipPath);
    await verifyDownloadedAsset(zipPath, expected);

    opts.onProgress?.('解压 …');
    await extractZip(zipPath, installDir);
    await rm(zipPath, { force: true });  // 校验通过的 zip 用后即删
    await rm(sumsPath, { force: true });  // SUMS 同样用后即删

    const godotPath = findExtractedBinary(installDir);
    // POSIX 执行位:writeFileSync 落盘为 0644,无执行位的二进制 validateGodotBinary 会
    // EACCES 恒 false(审查 I-1)——非 Windows 平台必须补 0o755(Windows no-op)。
    if (process.platform !== 'win32') {
      await chmod(godotPath, 0o755);
    }
    // 安装后自检:登记前 validate 回读,防止「解压成功但二进制不可执行」的虚假成功。
    if (!(await validateGodotBinary(godotPath))) {
      throw new InternalError(`installed binary failed post-install validation: ${godotPath}`);
    }
    writeGodotPathsConfig([...readGodotPathsConfig(), godotPath]);

    await appendMachineAuditLine({
      trace_id: traceId, tool: 'cli', action: 'install_godot', risk: 'process',
      ok: true, project_path: '', changed_files: [godotPath], duration_ms: Date.now() - started,
      details: { versionTag, assetName, binaryUrl },
    });
    return { godotPath, versionTag };
  } catch (err) {
    await appendMachineAuditLine({
      trace_id: traceId, tool: 'cli', action: 'install_godot', risk: 'process',
      ok: false, project_path: '', changed_files: [], duration_ms: Date.now() - started,
      // 2D (2026-09-19 安全加固批2): 错误消息脱敏(网络错误可能带 URL 查询串;复用 logger
      // sanitizeMsg 词表,截断 200 顺带防超长)
      details: { versionTag, assetName, error: sanitizeMsg(err instanceof Error ? err.message : String(err)) },
    });
    throw err;
  }
}

// ─── CLI 入口(`npx godot-mcp-enhanced install [tag]`)────────────────────────

/** install 子命令:可选版本 tag 参数(默认 latest stable),交互确认后安装。 */
export async function runInstall(args: string[]): Promise<void> {
  const versionTag = args[0];
  console.log('📥 Godot 自动安装(官方 GitHub releases,SHA512 同源校验)\n');
  const { confirmYesNo } = await import('./confirm.js');
  const { godotPath, versionTag: tag } = await installGodot({
    versionTag,
    confirm: () => confirmYesNo('确认下载并安装?'),
    onProgress: (msg) => console.log(`  ${msg}`),
  });
  console.log(`\n✓ Godot ${tag} 安装完成: ${godotPath}`);
  console.log('  已登记 ~/.godot-mcp/godot-paths.json(findGodot 搜索链 + 路径白名单)。');
  console.log('  注意:登记后白名单收紧为登记路径;若需继续使用其他 Godot(如 GODOT_PATH 指向的),');
  console.log('  设 GODOT_MCP_ALLOWED_GODOT_PATHS(分号分隔)显式列出全部可信路径。');
}
