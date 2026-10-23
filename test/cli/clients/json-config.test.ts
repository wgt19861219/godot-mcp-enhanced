import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, readdirSync, statSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonConfigForUnconfigure, readJsonConfigWithBackup, readJsonForCheck, stripBom, stripJsonc, writeFileAtomicWithMode, buildEnv } from '../../../src/cli/clients/json-config.js';

const BOM = String.fromCharCode(0xFEFF);

describe('stripBom', () => {
  it('strips UTF-8 BOM', () => {
    expect(stripBom(BOM + '{"a":1}')).toBe('{"a":1}');
  });
  it('passes through non-BOM string', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });
});

describe('stripJsonc (Tier2-3)', () => {
  it('剥离行注释 //', () => {
    expect(stripJsonc('{"a": 1 // comment\n}')).toBe('{"a": 1 \n}');
  });

  it('剥离块注释 /* */', () => {
    expect(stripJsonc('{"a": /* comment */ 1}')).toBe('{"a":  1}');
  });

  it('剥离尾逗逗号(对象)', () => {
    expect(stripJsonc('{"a": 1,}')).toBe('{"a": 1}');
  });

  it('剥离尾逗逗号(数组)', () => {
    expect(stripJsonc('[1, 2, 3,]')).toBe('[1, 2, 3]');
  });

  it('保留字符串内的 // 和逗号(不误删)', () => {
    expect(stripJsonc('{"url": "https://example.com", "msg": "a,b"}')).toBe('{"url": "https://example.com", "msg": "a,b"}');
  });

  it('保留字符串内的 /* */', () => {
    expect(stripJsonc('{"path": "C://x/*y*/"}')).toBe('{"path": "C://x/*y*/"}');
  });

  it('处理转义引号 \\"(不误判字符串结束)', () => {
    expect(stripJsonc('{"q": "say \\"hi//x\\""}')).toBe('{"q": "say \\"hi//x\\""}');
  });

  it('纯 JSON 无注释时原样返回', () => {
    expect(stripJsonc('{"a": 1}')).toBe('{"a": 1}');
  });

  it('未闭合块注释扫到文件尾不崩(Nit-1)', () => {
    expect(stripJsonc('{"a": 1 /* 未闭合')).toBe('{"a": 1 ');
  });

  it('尾逗逗号后跟注释再跟 } 也识别为尾逗(Nit-1)', () => {
    expect(stripJsonc('{"a": 1,/* c */}')).toBe('{"a": 1}');
  });
});

describe('readJsonConfigWithBackup JSONC 支持 (Tier2-3)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-jsonc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('含行注释的 JSONC 解析成功,M3 落 .jsonc 备份保住注释可找回', () => {
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, '{\n  // Zed theme\n  "theme": "One Dark",\n  "mcpServers": {}\n}\n');
    const result = readJsonConfigWithBackup(configPath);
    expect(result.theme).toBe('One Dark');
    // M3(2026-10-14 审查): 剥离检测(stripJsonc 前后长度)命中 → 落 .jsonc.<uuid>.bak
    // 备份——重写纯 JSON 会丢注释,备份是可找回副本(设计即如此,非损坏路径的 .corrupt.)
    const bak = readdirSync(dir).find(f => f.includes('.jsonc.') && f.endsWith('.bak'));
    expect(bak).toBeTruthy();
    expect(readFileSync(join(dir, bak!), 'utf-8')).toContain('// Zed theme');
  });

  it('含块注释的 JSONC 解析成功', () => {
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, '/* config */\n{"a": 1}');
    const result = readJsonConfigWithBackup(configPath);
    expect(result.a).toBe(1);
  });

  it('真损坏 JSON(非注释)仍触发 backup', () => {
    const configPath = join(dir, 'broken.json');
    writeFileSync(configPath, '{ broken');
    const result = readJsonConfigWithBackup(configPath);
    expect(result).toEqual({});
    expect(readdirSync(dir).some(f => f.endsWith('.bak'))).toBe(true);
  });

  it('readJsonForCheck 含注释的 JSONC 解析成功(返对象非 null)', () => {
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, '{\n  // comment\n  "a": 1\n}');
    const result = readJsonForCheck(configPath);
    expect(result).not.toBeNull();
    expect(result!.a).toBe(1);
  });
});

describe('readJsonConfigWithBackup', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-json-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns {} when file not found', () => {
    expect(readJsonConfigWithBackup(join(dir, 'no.json'))).toEqual({});
  });
  it('parses valid JSON with BOM', () => {
    const p = join(dir, 'bom.json');
    writeFileSync(p, BOM + '{"mcpServers":{"godot":{}}}');
    expect(readJsonConfigWithBackup(p)).toEqual({ mcpServers: { godot: {} } });
  });
  it('backs up corrupted JSON and returns {}', () => {
    const p = join(dir, 'bad.json');
    const corrupt = '{ broken';
    writeFileSync(p, corrupt);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readJsonConfigWithBackup(p);
    expect(result).toEqual({});
    const backups = readdirSync(dir).filter(f => f.startsWith('bad.json.corrupt.'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf-8')).toBe(corrupt);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('readJsonForCheck', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-chk-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when file not found', () => {
    expect(readJsonForCheck(join(dir, 'no.json'))).toBeNull();
  });
  it('parses valid JSON with BOM', () => {
    const p = join(dir, 'bom.json');
    writeFileSync(p, BOM + '{"mcpServers":{"godot":{}}}');
    expect(readJsonForCheck(p)).toEqual({ mcpServers: { godot: {} } });
  });
  it('returns null for corrupted JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ broken');
    expect(readJsonForCheck(p)).toBeNull();
  });
});

describe('writeFileAtomicWithMode', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-mode-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('preserves existing file mode across atomic rewrite (Unix 严格, Windows no-op)', () => {
    // F3: 13 adapter 旧实现 writeFileSync(tmp, data, 'utf-8') 第三参是 encoding 非 mode,
    // tmp 默认 0o666 & ~umask,rename 后覆盖原文件 mode(用户 chmod 0o600 的配置被破坏)。
    // writeFileAtomicWithMode 先读原文件 mode,显式传给 writeFileSync 保持。
    const targetPath = join(dir, 'cfg.json');
    writeFileSync(targetPath, '{"old":true}');
    try { chmodSync(targetPath, 0o600); } catch { /* Windows chmod no-op,忽略 */ }
    const beforeMode = statSync(targetPath).mode & 0o777;
    writeFileAtomicWithMode(targetPath, '{"new":true}');
    const afterMode = statSync(targetPath).mode & 0o777;
    if (process.platform !== 'win32') {
      // Unix: 原 0o600 → 新 0o600(修复生效)
      expect(beforeMode).toBe(0o600);
      expect(afterMode).toBe(0o600);
    } else {
      // Windows: stat.mode 无业务意义,helper 应 no-op 不破坏(不抛错 + mode 不变)
      expect(afterMode).toBe(beforeMode);
    }
    // 内容正确写入 + rename 后 tmp 消失(原子写入语义)
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"new":true}');
  });

  it('falls back to default mode when target file does not exist (首次写入)', () => {
    // 首次创建配置:statSync 抛 ENOENT → 跳过 mode → writeFileSync 用默认 mode
    const targetPath = join(dir, 'fresh.json');
    expect(existsSync(targetPath)).toBe(false);
    writeFileAtomicWithMode(targetPath, '{"first":true}');
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"first":true}');
    // 文件创建成功即证明 fallback 路径走通(无异常)
    expect(existsSync(targetPath)).toBe(true);
  });

  it('uses temporary file with rename (原子写入, tmp 不残留)', () => {
    const targetPath = join(dir, 'atomic.json');
    writeFileSync(targetPath, '{}');
    writeFileAtomicWithMode(targetPath, '{"v":2}');
    // rename 后 tmp 应消失,只剩目标文件
    const files = readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files).toContain('atomic.json');
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"v":2}');
  });
});

describe('buildEnv (C1 env 白名单合并)', () => {
  it('只含 GODOT_PATH 当 oldEnv 为 undefined', () => {
    expect(buildEnv('/godot')).toEqual({ GODOT_PATH: '/godot' });
  });

  it('保留白名单前缀的 string 值（ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_* / GODOT_MCP_EDITOR_*）', () => {
    const oldEnv = {
      ALLOWED_PROJECT_PATHS: '/projects;/other',
      GODOT_MCP_BRIDGE_PERSISTENT_SECRET: 'true',
      GODOT_MCP_EDITOR_PERSISTENT_SECRET: 'true',
      GODOT_MCP_BRIDGE_EXTRA_METHODS: 'emit_signal,foo',
    };
    expect(buildEnv('/g', oldEnv)).toEqual({
      GODOT_PATH: '/g',
      ALLOWED_PROJECT_PATHS: '/projects;/other',
      GODOT_MCP_BRIDGE_PERSISTENT_SECRET: 'true',
      GODOT_MCP_EDITOR_PERSISTENT_SECRET: 'true',
      GODOT_MCP_BRIDGE_EXTRA_METHODS: 'emit_signal,foo',
    });
  });

  it('过滤脏值与非白名单键（防子进程自行解锁限制）', () => {
    const oldEnv = {
      GODOT_MCP_UNRESTRICTED: 'true',    // 服务端安全开关,刻意不在白名单
      GODOT_MCP_ALLOW_UNSAFE: 'true',    // 同上
      ALLOW_EXECUTE_GDSCRIPT: 'true',    // 同上
      PATH: '/usr/bin',                   // 系统变量,不在白名单
      HACKER_INJECTED: 'evil',            // 脏值
    };
    expect(buildEnv('/g', oldEnv)).toEqual({ GODOT_PATH: '/g' });
  });

  it('过滤非 string 值（数字/对象/布尔均跳过,只保留 string）', () => {
    const oldEnv = {
      ALLOWED_PROJECT_PATHS: '/p',        // 保留
      GODOT_MCP_BRIDGE_PORT: 9081,        // 数字 → 跳过
      GODOT_MCP_EDITOR_FLAG: true,        // 布尔 → 跳过
      GODOT_MCP_BRIDGE_OPTS: { a: 1 },    // 对象 → 跳过
    };
    expect(buildEnv('/g', oldEnv)).toEqual({
      GODOT_PATH: '/g',
      ALLOWED_PROJECT_PATHS: '/p',
    });
  });

  it('GODOT_PATH 始终用新值（即使 oldEnv 含旧 GODOT_PATH 也覆写）', () => {
    const oldEnv = { GODOT_PATH: '/old', ALLOWED_PROJECT_PATHS: '/p' };
    expect(buildEnv('/new', oldEnv)).toEqual({
      GODOT_PATH: '/new',
      ALLOWED_PROJECT_PATHS: '/p',
    });
  });

  it('空 oldEnv 对象 → 只含 GODOT_PATH', () => {
    expect(buildEnv('/g', {})).toEqual({ GODOT_PATH: '/g' });
  });
});

// M-8(2026-10-22 审查第二轮): unconfigure 侧读取通道——JSONC 注释被剥离重写前
// 必须落 .jsonc 备份(此前 readJsonForCheck 纯读,注释静默丢失无备份可找回)。
// Nit-2 时机修正:读取只返回 {config, raw},备份延后到 backupJsoncBeforeRewrite
// (调用方确认将重写才执行,未配置客户端零副作用)。
describe('readJsonConfigForUnconfigure (M-8)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-jsonc-u-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('JSONC 读取返回 {config, raw};确认将重写时 backupJsoncBeforeRewrite 落备份(含注释)', async () => {
    const { readJsonConfigForUnconfigure, backupJsoncBeforeRewrite } = await import('../../../src/cli/clients/json-config.js');
    const configPath = join(dir, 'settings.json');
    writeFileSync(configPath, '{\n  // my comment\n  "mcpServers": { "godot": {} } }\n');
    const read = readJsonConfigForUnconfigure(configPath);
    expect(read).not.toBeNull();
    expect(read!.raw).toContain('// my comment');
    expect((read!.config.mcpServers as Record<string, unknown>).godot).toBeTruthy();
    // Nit-2: 读取阶段零副作用——未调 backup 前无备份文件
    expect(readdirSync(dir).some(f => f.endsWith('.bak'))).toBe(false);
    backupJsoncBeforeRewrite(read!.raw, configPath);
    const bak = readdirSync(dir).find(f => f.includes('.jsonc.') && f.endsWith('.bak'));
    expect(bak).toBeTruthy();
    expect(readFileSync(join(dir, bak!), 'utf-8')).toContain('// my comment');
  });

  it('纯 JSON:返回解析结果,backupJsoncBeforeRewrite 不落备份', async () => {
    const { readJsonConfigForUnconfigure, backupJsoncBeforeRewrite } = await import('../../../src/cli/clients/json-config.js');
    const configPath = join(dir, 'plain.json');
    writeFileSync(configPath, '{"a": 1}');
    const read = readJsonConfigForUnconfigure(configPath);
    expect(read!.config.a).toBe(1);
    backupJsoncBeforeRewrite(read!.raw, configPath);
    expect(readdirSync(dir).some(f => f.endsWith('.bak'))).toBe(false);
  });

  it('损坏 JSON → 抛错且不落备份(unconfigure 无新内容,不动用户文件让命令层报 ✗)', () => {
    const configPath = join(dir, 'broken.json');
    writeFileSync(configPath, '{ broken');
    expect(() => readJsonConfigForUnconfigure(configPath)).toThrow('config parse error');
    expect(readdirSync(dir).some(f => f.endsWith('.bak'))).toBe(false);
  });

  it('文件不存在 → null(调用方视为未配置)', () => {
    expect(readJsonConfigForUnconfigure(join(dir, 'no.json'))).toBeNull();
  });
});
