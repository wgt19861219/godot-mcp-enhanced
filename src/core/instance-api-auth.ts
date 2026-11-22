// src/core/instance-api-auth.ts
/**
 * C-03: 多实例 HTTP API 认证
 *
 * 在机器级注册目录 (~/.godot-mcp/) 下维护一个共享 API secret。
 * sendToInstance 请求携带 HMAC 签名，服务端可使用同一 secret 验证。
 *
 * 安全模型：
 * - secret 文件权限收紧 (0600 / icacls)
 * - HMAC 签名包含 instance.id + timestamp，防重放
 * - 仅限 localhost 通信 (127.0.0.1)
 *
 * I-6 状态（2026-08-10 行225 闭环，MULTI_INSTANCE 默认关闭）：
 * sendToInstance / dynamicSenders 发送端完整且有测试（instance-router.test.ts /
 * phase2-acceptance.test.ts）。接收端 HTTP /api/<tool> server 在 instance-http-server.ts
 * 实现，GodotServer.initMultiInstance 启动时接线 verifyApiToken（HMAC 闭环）。
 * verifyApiToken 现经 InstanceHttpServer.handleRequest 调用（入口验签），
 * 仍由 instance-api-auth.test.ts 覆盖单元测试 + instance-http-server.test.ts 覆盖集成测试。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { getLogger } from './logger.js';

const API_SECRET_FILENAME = '.api-secret';
const API_NONCES_FILENAME = '.api-nonces.json';
const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_MS = 60_000; // 签名有效期 60 秒

// A6 (2026-08-11 审查): 时钟偏移上界。原校验只查过去方向(Date.now() - timestamp > TTL),
// 远未来 timestamp(now+1年)可通过过期检查,该 token 在真实时间追上前持续有效。
// localhost 同机通信时钟偏移近零,5s 上界只容忍 NTP 抖动级别的正向漂移。
const MAX_CLOCK_SKEW_MS = 5_000;

// S-3: Nonce 防重放 — 记录最近使用的 nonce（TTL 内去重）
const _usedNonces = new Map<string, number>();
const NONCE_CLEANUP_INTERVAL = 120_000; // 每 2 分钟清理过期 nonce
let _lastNonceCleanup = Date.now();

// A6: nonce 持久化 — server 重启会清空内存 Map,60s TTL 重放窗口重新打开。
// 近 TTL 的已用 nonce 落盘 ~/.godot-mcp/.api-nonces.json,启动时懒加载回内存。
// 失败(磁盘/权限)降级内存-only,不阻断认证(纵深防御层,非可用性依赖)。
let _noncesLoaded = false;
let _noncePersistWarned = false;

let _cachedSecret: string | null = null;

/** 获取机器级注册目录 */
function getRegistryDir(): string {
  return join(homedir(), '.godot-mcp');
}

/** B-4 (2026-08-14): 写前 symlink 预检 — .api-secret 与 .api-nonces.json 两处共用。
 *  攻击者预置目标路径为 symlink,writeFileSync follow symlink 会覆盖被指向文件
 *  (nonce 是固定格式 JSON,每次合法验签 _persistNonces 都会覆写)。对齐 :64-69
 *  读侧预检模式(阶段4-3 Imp-9):lstatSync 不 follow;存在且 isSymbolicLink 则拒写
 *  + error 告警返回 false;lstat 失败保守拒写。写入成功返回 true;写失败抛错由
 *  调用方 try/catch 降级(两层调用方均有降级语义,认证不被磁盘问题阻断)。 */
function safeWriteNoSymlink(path: string, data: string, opts: { mode?: number } = {}): boolean {
  if (existsSync(path)) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        getLogger().error('security', `Refusing to write ${path}: target is a symlink (possible pre-positioned overwrite attack). Skipping write.`);
        return false;
      }
    } catch (statErr) {
      getLogger().error('security', `lstat failed for ${path} — refusing write (conservative): ${statErr instanceof Error ? statErr.message : statErr}`);
      return false;
    }
  }
  writeFileSync(path, data, { encoding: 'utf-8', ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
  return true;
}

/** 读取或创建共享 API secret */
export function getOrCreateApiSecret(): string {
  if (_cachedSecret) return _cachedSecret;

  const secretPath = join(getRegistryDir(), API_SECRET_FILENAME);

  try {
    if (existsSync(secretPath)) {
      // 阶段4-3 (Imp-9 对齐 editor-auth:69-73 / game-bridge:88-90): symlink 检查。
      // 攻击者把 .api-secret 换成 symlink 指向任意 ≥32 字符文件,readFileSync follow symlink
      // 会把目标内容当作 secret 缓存,从而控制认证密钥。lstatSync 不 follow。命中则 unlink
      // (防下方 writeFileSync follow symlink 写目标文件) + fall through 重新生成。
      if (lstatSync(secretPath).isSymbolicLink()) {
        getLogger().error('security', `API secret file ${secretPath} is a symlink — refusing to read, regenerating.`);
        try { unlinkSync(secretPath); } catch { /* best effort */ }
      } else {
        const secret = readFileSync(secretPath, 'utf-8').trim();
        if (secret.length >= 32) {
          _cachedSecret = secret;
          return secret;
        }
      }
    }
  } catch {
    // 读取/lstat 失败 — 重新生成
  }

  // 生成新 secret (32 bytes = 256 bits)
  const secret = randomBytes(32).toString('hex');
  try {
    const dir = getRegistryDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // B-4: 写前 symlink 预检(读侧 :68 unlink 后到此处写之间存在 TOCTOU 竞态窗口,
    // 攻击者可重建 symlink;拒写时 secret 仅内存生效,降级不阻断认证)
    const written = safeWriteNoSymlink(secretPath, secret, { mode: 0o600 });

    // Windows: 收紧 ACL — I-01 fix: 使用 os.userInfo().username + execFileSync 防止 ACL 注入
    if (written && process.platform === 'win32') {
      try {
        const username = userInfo().username;
        if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
          // 批 K 2026-08-16: :R → :M(与 5968a03/editor-auth、gdscript-executor 同款统一)
          // :R 只读会让后续 secret 轮换重写/删除失败;:M 允许写删但不给改 ACL 的完全控制
          // Task 4(2026-11-22 spawn 点自查):补 timeout 15s(短命令参照)——execFileSync
          // 同步阻塞,icacls 挂死会卡死 server。
          execFileSync('icacls', [secretPath, '/inheritance:r', '/grant:r', `${username}:M`], { stdio: 'ignore', timeout: 15_000 });
        } else {
          getLogger().warn('instance-api-auth', `Username "${username}" contains unexpected characters, skipping ACL restriction`);
        }
      } catch {
        getLogger().warn('instance-api-auth', `ACL restriction failed for ${secretPath}, file may inherit default permissions`);
      }
    }

    if (written) {
      getLogger().info('instance-api-auth', `Generated new API secret at ${secretPath}`);
    } else {
      getLogger().warn('instance-api-auth', `API secret not persisted (${secretPath} is a symlink) — in-memory only until restart`);
    }
  } catch (err) {
    getLogger().warn('instance-api-auth', `Failed to persist API secret: ${err instanceof Error ? err.message : err}`);
  }

  _cachedSecret = secret;
  return secret;
}

/**
 * 生成认证令牌 — HMAC(instance.id:timestamp:nonce, secret)
 * 格式: `{timestamp}.{nonce}.{hmacHex}`
 */
export function generateApiToken(instanceId: string): string {
  const secret = getOrCreateApiSecret();
  const timestamp = Date.now().toString();
  const nonce = randomBytes(8).toString('hex');
  const hmac = createHmac(HMAC_ALGORITHM, secret)
    .update(`${instanceId}:${timestamp}:${nonce}`)
    .digest('hex');
  return `${timestamp}.${nonce}.${hmac}`;
}

/**
 * 验证认证令牌。返回 true 表示有效。
 * 支持旧格式（无 nonce）和新格式（含 nonce + 防重放）。
 */
export function verifyApiToken(instanceId: string, token: string): boolean {
  // S-3: 解析新格式 timestamp.nonce.hmac 或旧格式 timestamp.hmac
  const parts = token.split('.');
  // C-02: 拒绝旧格式 token（无 nonce），强制使用新格式 timestamp.nonce.hmac
  if (parts.length !== 3) return false;

  const timestampStr = parts[0]!;
  const nonce = parts[1]!;
  const providedHmac = parts[2]!;

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return false;

  // 检查时效性(过去方向:TTL 过期;未来方向:A6 时钟偏移上界)
  if (Date.now() - timestamp > TOKEN_TTL_MS) return false;
  if (timestamp - Date.now() > MAX_CLOCK_SKEW_MS) return false;

  // A6: 懒加载持久化的 nonce(重启防重放窗口)
  if (!_noncesLoaded) {
    _loadPersistedNonces();
    _noncesLoaded = true;
  }
  // S-3: Nonce 防重放检查(仅查重;记录推迟到 HMAC 验证通过后 — A-2,避免伪造 token 污染 nonce 池)
  const nonceKey = `${instanceId}:${nonce}`;
  if (_usedNonces.has(nonceKey)) return false; // 已使用的 nonce → 重放攻击
  // 定期清理过期 nonce + I-01 上限保护
  const now = Date.now();
  if (now - _lastNonceCleanup > NONCE_CLEANUP_INTERVAL || _usedNonces.size > 10_000) {
    for (const [key, ts] of _usedNonces) {
      if (now - ts > TOKEN_TTL_MS * 2) _usedNonces.delete(key);
    }
    _lastNonceCleanup = now;
  }

  try {
    const secret = getOrCreateApiSecret();
    const expectedHmac = createHmac(HMAC_ALGORITHM, secret)
      .update(`${instanceId}:${timestampStr}:${nonce}`)
      .digest('hex');
    // 常量时间比较，防时序攻击
    if (expectedHmac.length !== providedHmac.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expectedHmac.length; i++) {
      mismatch |= expectedHmac.charCodeAt(i) ^ providedHmac.charCodeAt(i);
    }
    if (mismatch !== 0) return false;
    // A-2: HMAC 验证通过后才记录 nonce,避免伪造 token 提前污染 nonce 池(否则伪造签名可占用合法 nonce)
    _usedNonces.set(nonceKey, Date.now());
    _persistNonces();
    return true;
  } catch {
    return false;
  }
}

// ─── A6: nonce 持久化(重启防重放窗口) ────────────────────────────────────────

function _nonceStorePath(): string {
  return join(getRegistryDir(), API_NONCES_FILENAME);
}

function _loadPersistedNonces(): void {
  // 只回载仍在有效窗(TTL*2)内的条目,过期的留在盘上等下次写入时清掉
  const cutoff = Date.now() - TOKEN_TTL_MS * 2;
  try {
    const path = _nonceStorePath();
    if (!existsSync(path)) return;
    // B-4 (2026-08-14): 读侧 symlink 预检(对齐 .api-secret :68 模式)——symlink 指向的
    // "nonce 池"是攻击者可控输入,回载等于让攻击者伪造重放拒绝(DoS)或探测 nonce 状态。
    // 命中则不读,降级内存-only。
    if (lstatSync(path).isSymbolicLink()) {
      getLogger().error('security', `Nonce store ${path} is a symlink — refusing to load (possible pre-positioned attack).`);
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed == null || typeof parsed !== 'object') return;
    for (const [key, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === 'number' && ts > cutoff) _usedNonces.set(key, ts);
    }
  } catch {
    // 读失败(损坏/权限)降级内存-only——防重放退化为重启后窗口重开,不阻断认证
    if (!_noncePersistWarned) {
      getLogger().warn('instance-api-auth', 'Failed to load persisted nonces — replay protection degraded to memory-only until restart');
      _noncePersistWarned = true;
    }
  }
}

function _persistNonces(): void {
  try {
    const path = _nonceStorePath();
    const dir = getRegistryDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out: Record<string, number> = {};
    for (const [key, ts] of _usedNonces) out[key] = ts;
    // B-4: 写前 symlink 预检(防 follow symlink 覆写任意文件);拒写降级内存-only
    if (!safeWriteNoSymlink(path, JSON.stringify(out), { mode: 0o600 })) {
      if (!_noncePersistWarned) {
        getLogger().warn('instance-api-auth', 'Failed to persist nonces — replay protection degraded to memory-only until restart');
        _noncePersistWarned = true;
      }
    }
  } catch {
    if (!_noncePersistWarned) {
      getLogger().warn('instance-api-auth', 'Failed to persist nonces — replay protection degraded to memory-only until restart');
      _noncePersistWarned = true;
    }
  }
}

/** 构建带认证头的 headers 对象 */
export function buildAuthHeaders(instanceId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${generateApiToken(instanceId)}`,
  };
}

/** 清除缓存的 secret 和 nonce 记录（测试用） */
export function clearCachedSecret(): void {
  _cachedSecret = null;
  _usedNonces.clear();
  // A6: 重置懒加载标记,下个 verify 重新从盘上加载(测试 beforeEach/afterEach rmSync MOCK_HOME 后状态干净)
  _noncesLoaded = false;
}
