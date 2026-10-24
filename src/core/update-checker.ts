// src/core/update-checker.ts
// npm registry 最新版查询 + 24h 缓存 + 网络容错。
// 启动被动提示（index.ts）与 check_update 工具共用同一函数。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// src/core/ → 上两级包根 → package.json
// P0-1（2026-10-24 规则分发可靠性批）：固化版本单一来源化——模块加载时固化（与模板
// GODOT_MCP_RULES/DETAILED_RULE_TEMPLATES 同源同岁），export 供 tools/cli 复用。
// 毒化拦截的两侧读数之一（另一侧 readInstalledPkgVersion 运行时读磁盘）。
export const PKG_VERSION: string = require('../../package.json').version;

/** 运行时读磁盘包根 package.json 的 version（总反映"已安装的最新包"，与 PKG_VERSION
 *  的进程固化值构成毒化拦截的两侧读数）。读失败返回 null（调用方跳过拦截，不阻断）。 */
export function readInstalledPkgVersion(): string | null {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const v = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

/**
 * P0 毒化拦截判定（纯函数，注入两侧值便于测试）：server 进程固化版本与磁盘包版本
 * 不一致 = 进程启动早于包更新（npm update 后客户端未重启），此时分发规则/更新 addon
 * 会写出"新版本号 + 旧内容"的毒化文件。不一致时返回用户可操作的修复指引。
 */
export function checkServerFresh(
  residentVersion: string,
  diskVersion: string,
): { ok: true } | { ok: false; errorCode: 'SERVER_STALE'; message: string } {
  if (residentVersion === diskVersion) return { ok: true };
  return {
    ok: false,
    errorCode: 'SERVER_STALE',
    message:
      // 中性表述(审查 Nit-4):双向不等都拒绝,常见形态是进程旧于磁盘,但磁盘降级
      // (resident > disk)时"落后"措辞与事实相反
      `MCP server 进程固化版本(${residentVersion})与磁盘已安装的包(${diskVersion})不一致——` +
      `此时操作会写入"新版本号+旧内容"的不一致文件。请重启 MCP 客户端(或重连 MCP)后重试。`,
  };
}

const REGISTRY_URL = 'https://registry.npmjs.org/godot-mcp-enhanced/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** 手写 semver 比较（零依赖，假设纯数字 x.y.z，非数字段 fallback 0）。返回 -1/0/1。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => Number(n) || 0);
  const pb = b.split('.').map(n => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function getDefaultCacheDir(): string {
  return join(homedir(), '.godot-mcp');  // 复用 instance-manager.ts getDefaultRegistryDir 的 ~/.godot-mcp/ 父目录惯例（机器级，非项目级）
}

function getCachePath(cacheDir?: string): string {
  return join(cacheDir ?? getDefaultCacheDir(), 'update-cache.json');
}

interface CacheData { lastCheck: number; latest: string; }

export function readCache(cachePath: string): CacheData | null {
  try {
    if (!existsSync(cachePath)) return null;
    // S2: 防大文件 OOM（64KB 上限）
    if (statSync(cachePath).size > 64 * 1024) return null;
    const obj = JSON.parse(readFileSync(cachePath, 'utf-8'));
    // S2: latest 长度上限（64 字符）
    if (typeof obj.lastCheck === 'number' && typeof obj.latest === 'string'
        && obj.latest.length <= 64) return obj;
    return null;
  } catch { return null; }  // 损坏当 miss
}

function writeCache(cachePath: string, data: CacheData): void {
  try {
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });  // recursive 对已存在目录是 noop，避免 existsSync+mkdirSync TOCTOU
    const tmp = cachePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    // S2(2026-07-31 nit#4): 显式收紧到 0o600（writeFileSync 默认 0o666 & ~umask，umask 022 → 0o644，
    // cache 含版本/时间戳信息，收紧无害；chmodSync 在 rename 前对 tmp 设置，rename 后目标继承权限）
    try { chmodSync(tmp, 0o600); } catch { /* Windows/受限环境 chmod 无效，忽略 */ }
    renameSync(tmp, cachePath);  // 原子 rename
  } catch { /* 缓存写失败静默 */ }
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  fromCache: boolean;
}

/** 查 npm 最新版。force:true 绕缓存（供 check action）；cacheDir 测试注入。失败绝不抛。 */
export async function checkForUpdateCached(opts?: { force?: boolean; cacheDir?: string }): Promise<UpdateCheckResult> {
  // 2026-08-06 审查 P3：env 门控（用户可设 GODOT_MCP_UPDATE_CHECK=false 关闭启动外传，
  // 对齐 telemetry opt-in 哲学——telemetry 都 opt-in 了 update-checker 也应可关）。
  // 注：force=true 时仍走（self_update check action 经 force:true 短路门控，且 risk='read'
  // 不经确认令牌，AI 可自主调用触发外传——对齐 docs/telemetry.md 诚实披露段）。
  // 2026-08-07 审查 P1：语义健壮化——原 === 'false' 严格字符串相等，大小写敏感 + 不认 falsy 变体
  // （用户写 =0/=no/=off/=False/=FALSE 都不触发关闭）。改为认 false/0/no/off + 大小写不敏感，
  // 对齐 feature-flags.ts isFeatureEnabled 的标准化逻辑（方向相反：update-checker 是 opt-out 默认开，
  // telemetry 是 opt-in 默认关，但标准化逻辑对齐）。
  const updateCheckEnv = process.env.GODOT_MCP_UPDATE_CHECK ?? '';
  const isUpdateCheckDisabled = /^(false|0|no|off)$/i.test(updateCheckEnv);
  if (!opts?.force && isUpdateCheckDisabled) {
    return {
      current: PKG_VERSION,
      latest: PKG_VERSION,
      updateAvailable: false,
      fromCache: false,
    };
  }
  const cachePath = getCachePath(opts?.cacheDir);
  if (!opts?.force) {
    const cached = readCache(cachePath);
    if (cached && Date.now() - cached.lastCheck < CACHE_TTL_MS) {
      return {
        current: PKG_VERSION,
        latest: cached.latest,
        updateAvailable: compareVersion(cached.latest, PKG_VERSION) > 0,
        fromCache: true,
      };
    }
  }
  let latest: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
      if (res.ok) {
        const obj = (await res.json()) as { version?: string };
        if (typeof obj.version === 'string') latest = obj.version;
      }
    } finally {
      clearTimeout(timer);  // M1: fetch throw 时也确保清理，避免 timer dangling 5s
    }
  } catch { /* 网络/超时/解析失败静默 */ }
  if (latest == null) {
    return { current: PKG_VERSION, latest: PKG_VERSION, updateAvailable: false, fromCache: false };
  }
  writeCache(cachePath, { lastCheck: Date.now(), latest });
  return {
    current: PKG_VERSION,
    latest,
    updateAvailable: compareVersion(latest, PKG_VERSION) > 0,
    fromCache: false,
  };
}
