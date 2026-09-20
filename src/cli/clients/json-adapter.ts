/**
 * JsonAdapterBase — JSON 配置文件型客户端适配器的公共基座(2026-08-21 架构审查 D-1)。
 *
 * 折叠前:12 个适配器的 configure() 主体近乎逐字重复(仅路径/根键/user-state 白名单/
 * entry 附加字段有差异),历史上已因样板复制批量踩过 env 覆盖坑(json-config.ts C1 注释)。
 * 折叠后各适配器文件退化为"spec 声明 + 继承",差异点在构造参数中显式可见。
 *
 * 保留独立(不经本基座):codex(CLI 调用型)、opencode(command 数组 + environment 键 +
 * execFile detect)、antigravity(读取源路径 ≠ 写入路径的双路径兼容)。
 *
 * 公共行为约定(全部继承自原实现的注释语义):
 * - F3:损坏 JSON 备份原文件 + warn(readJsonConfigWithBackup),不静默覆盖用户配置
 * - C1:保留旧 entry 的白名单 env(buildEnv),防 reconfigure 静默丢失用户配的
 *   ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_*
 * - F3:原子写入 + 保持原文件 mode(writeFileAtomicWithMode)
 * - user-state 白名单:仅保留旧 entry 已有键;defaults 提供首建 seed(键缺失则不 seed)
 */
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ClientAdapter } from './types.js';
import { readJsonConfigWithBackup, readJsonForCheck, writeFileAtomicWithMode, buildEnv } from './json-config.js';
export interface JsonAdapterSpec {
  name: string;
  scope: 'project' | 'global';
  /** 配置文件绝对路径(project scope 用 projectDir;global scope 忽略之) */
  configPath(projectDir: string): string;
  /** detect() 的 existsSync 探测路径列表(任一存在即视为已安装;与 configPath 正交,
   *  如 claude-code 探测 ~/.claude 目录而非项目内 settings.json) */
  detectPaths(): string[];
  /** MCP entry 所在根键路径(嵌套用数组,如 ZCode 的 ['mcp','servers']);默认 ['mcpServers'] */
  rootKeys?: readonly string[];
  /** entry 附加字段(尾部 merge,如 CherryStudio 的 type:'stdio'、Warp 的 working_directory) */
  entryExtras?(projectDir: string): Record<string, unknown>;
  /** user-state 白名单:旧 entry 已有则保留;defaults 有则首建 seed */
  preserveUserState?: { keys: readonly string[]; defaults?: Record<string, unknown> };
  /** env 字段名(默认 'env';无适配器需要覆盖,预留给未来 opencode 形态收编) */
  envKey?: string;
}

export class JsonAdapterBase implements ClientAdapter {
  readonly name: string;
  readonly scope: 'project' | 'global';

  constructor(protected readonly spec: JsonAdapterSpec) {
    this.name = spec.name;
    this.scope = spec.scope;
  }

  async detect(): Promise<boolean> {
    return this.spec.detectPaths().some(p => existsSync(p));
  }

  /** 沿 rootKeys 取(或建)entry 容器,返回持有 godot 键的对象。 */
  private entryContainer(config: Record<string, unknown>): Record<string, unknown> {
    const keys = this.spec.rootKeys ?? ['mcpServers'];
    let node: Record<string, unknown> = config;
    for (const k of keys) {
      if (!node[k] || typeof node[k] !== 'object') node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    return node;
  }

  async isConfigured(projectDir: string): Promise<boolean> {
    const content = readJsonForCheck(this.spec.configPath(projectDir));
    if (!content) return false;
    const keys = this.spec.rootKeys ?? ['mcpServers'];
    let node: unknown = content;
    for (const k of keys) {
      node = (node as Record<string, unknown> | undefined)?.[k];
      if (!node) return false;
    }
    return !!(node as Record<string, unknown> | undefined)?.godot;
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const configPath = this.spec.configPath(projectDir);
    const configDir = join(configPath, '..');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    const config = readJsonConfigWithBackup(configPath);
    const container = this.entryContainer(config);
    const oldEntry = (container.godot as Record<string, unknown> | undefined) ?? {};

    const preserved: Record<string, unknown> = {};
    const pu = this.spec.preserveUserState;
    if (pu) {
      for (const key of pu.keys) {
        if (key in oldEntry) preserved[key] = oldEntry[key];
        else if (pu.defaults && key in pu.defaults) preserved[key] = pu.defaults[key];
      }
    }

    container.godot = {
      ...preserved,
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      env: buildEnv(godotPath, oldEntry.env as Record<string, unknown> | undefined),
      ...(this.spec.entryExtras?.(projectDir) ?? {}),
    };
    writeFileAtomicWithMode(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  /** uninstall 反向操作:沿 rootKeys 找到容器,仅删 godot 键后原子写回。
   *  容器结构(如 mcpServers 根键)保留——其他 MCP server 共用同一容器,不能连坐。
   *  损坏 JSON 抛错而非备份覆盖(configure 语义):unconfigure 无新内容要写,
   *  备份+重写反而扩大破坏面,正确行为是不动用户文件并让命令层报 ✗。 */
  async unconfigure(projectDir: string): Promise<boolean> {
    const configPath = this.spec.configPath(projectDir);
    if (!existsSync(configPath)) return false;
    const config = readJsonForCheck(configPath);
    if (!config) throw new Error(`config parse error: ${configPath}`);
    const keys = this.spec.rootKeys ?? ['mcpServers'];
    let node: Record<string, unknown> | undefined = config;
    for (const k of keys) {
      node = node?.[k] as Record<string, unknown> | undefined;
      if (!node) return false;
    }
    if (!node.godot) return false;
    delete node.godot;
    writeFileAtomicWithMode(configPath, JSON.stringify(config, null, 2) + '\n');
    return true;
  }
}
