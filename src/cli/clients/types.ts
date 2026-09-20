/**
 * ClientAdapter — 统一的 AI 客户端配置接口。
 *
 * 按 configure() 实现方式分两类范式（detect() 探测方式与范式正交，另说）：
 * - 文件写入型（Claude Code、Cursor、OpenCode）：读写配置文件（readJsonConfigWithBackup + 原子 tmp+rename）
 * - CLI 调用型（Codex）：调用 CLI 子命令（execFile 分别传参，不拼字符串防注入）
 *
 * 注：OpenCode 原为 CLI 型，因 `opencode mcp add` 是交互式 prompts、非交互 execFile 会挂起超时（IMPORTANT-6），
 * 改文件型读写 opencode.json；仅 detect() 仍走 `opencode --version`。
 *
 * detect() 探测方式与范式正交：文件型 adapter 多用 existsSync(配置目录/文件)，CLI 型用 execFile --version。
 *
 * scope: 'project' = 配置写入项目目录（projectDir 生效）；'global' = 配置写入用户全局目录
 *        （projectDir 为 no-op，adapter 内部用 globalConfigRoot()/homedir() 定位）。
 */
export interface ClientAdapter {
  name: string;
  scope: 'project' | 'global';
  /** 客户端是否已安装 */
  detect(): Promise<boolean>;
  /** godot MCP 是否已配置（project scope 用 projectDir；global scope 忽略 projectDir） */
  isConfigured(projectDir: string): Promise<boolean>;
  /** 将 godot MCP 配置写入该客户端 */
  configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void>;
  /** 移除 godot MCP 注册（uninstall 命令的反向操作，configure 的逆）。
   *  返回 false=本就未配置（无操作）；true=已移除并写回；throw=配置存在但移除失败
   *  （如 JSON 损坏无法解析——此时不动用户文件，交命令层报错）。
   *  可选方法：保持对外实现（测试 mock/第三方）兼容，命令层按存在性分派。 */
  unconfigure?(projectDir: string): Promise<boolean>;
}
