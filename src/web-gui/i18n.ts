// src/web-gui/i18n.ts
// Web GUI 面板双语字典(2026-10-13 i18n 批):html.ts 主面板 + portal.ts 入口页共用。
// 组织:键按区域前缀(common/status/err/net/warn/proj/sess/inst/out/logs/stats/tab/files/
// preview/hex/ed/kb/set/time/lang/portal);zh 值为抽取前的原文案(逐字保留,是
// html.test.ts 中文断言的锚),en 值术语不硬翻(Godot/daemon/stdio/vault 保留)。
// 插值约定:{name} 形占位符,前端 t(key, params) 做 split/join 替换(无格式化库依赖)。
// 消费方式:html.ts/portal.ts 经 serializeI18nForInline() 以 JSON 内联进模板字符串
// (插值不经模板转义——2026-09-30 死锁根因的家族免疫;`<` 转义防 </script> 截断)。
// 后端消息(settings-api/files-api)按请求 Accept-Language 从本字典取值,见 pickGuiLang。

/** 双语文案条目。zh 为原文(测试锚),en 为英译。 */
export interface BiString {
  zh: string;
  en: string;
}

/** 面板展示语言(2026-10-13 i18n 批):后端 verify/save 的 error/detail 消息按此取双语;
 *  默认 zh(既有调用方/测试不变)。接线层从请求 Accept-Language 解析(pickGuiLang)传入。 */
export type GuiLang = 'zh' | 'en';

/** 面板 UI 全量双语字典。键命名:<区域>.<语义>。 */
export const GUI_STRINGS: Record<string, BiString> = {
  // ── 通用 ────────────────────────────────────────────────────────────────
  'common.loading': { zh: '加载中…', en: 'Loading…' },
  'common.running': { zh: '运行中', en: 'Running' },

  // ── 头部 ────────────────────────────────────────────────────────────────
  'header.title': { zh: 'godot-mcp-enhanced 监控面板', en: 'godot-mcp-enhanced Monitor' },

  // ── 状态栏瞬态消息(statusBar,多带参数)───────────────────────────────────
  'status.connecting': { zh: '连接中…', en: 'Connecting…' },
  'status.connected': { zh: '已连接', en: 'Connected' },
  'status.starting': { zh: '启动中… {path}', en: 'Starting… {path}' },
  'status.startingEditor': { zh: '编辑器拉起中… {path}', en: 'Launching editor… {path}' },
  'status.startFail': { zh: '启动失败: {msg}', en: 'Start failed: {msg}' },
  'status.startSent': { zh: '启动指令已发出,等待会话出现', en: 'Start request sent, waiting for the session to appear' },
  'status.editorLaunched': { zh: '编辑器已拉起', en: 'Editor launched' },
  'status.importing': { zh: '导入中(引擎扫描+重导入,可能需要数十秒)… {path}', en: 'Importing (engine scan + reimport, may take tens of seconds)… {path}' },
  'status.reimportFail': { zh: '重导入失败: {msg}', en: 'Reimport failed: {msg}' },
  'status.alreadyImporting': { zh: '该项目已在导入中,请等待完成', en: 'This project is already importing, please wait for it to finish' },
  'status.importSent': { zh: '导入指令已发出,等待完成', en: 'Import request sent, waiting for completion' },
  'status.importDoneGutted': { zh: '导入完成,但有 {n} 个 .import 疑似被重写,建议在编辑器中检查: {path}', en: 'Import finished, but {n} .import file(s) appear rewritten — check them in the editor: {path}' },
  'status.importDone': { zh: '资源导入完成: {path}', en: 'Resource import finished: {path}' },
  'status.importFail': { zh: '导入失败: {msg}', en: 'Import failed: {msg}' },
  'status.removing': { zh: '移除中… {name}', en: 'Removing… {name}' },
  'status.removeFail': { zh: '移除失败: {msg}', en: 'Remove failed: {msg}' },
  'status.removed': { zh: '已从列表移除 {name}', en: 'Removed {name} from the list' },
  'status.scanning': { zh: '扫描中…', en: 'Scanning…' },
  'status.scanFail': { zh: '扫描失败: {msg}', en: 'Scan failed: {msg}' },
  'status.scanInProgress': { zh: '扫描已在进行中,进度见状态栏', en: 'A scan is already in progress, see the status bar' },
  'status.scanProgress': { zh: '扫描中 已发现 {found} / 已扫描 {scanned}', en: 'Scanning — found {found} / scanned {scanned}' },
  'status.scanFailedEvt': { zh: '扫描失败,可重试;详情见 server 日志', en: 'Scan failed, you may retry; see server logs for details' },
  'status.scanDone': { zh: '扫描完成 新增 {n} 个项目', en: 'Scan complete — {n} project(s) added' },
  'status.adding': { zh: '添加中…', en: 'Adding…' },
  'status.addFail': { zh: '添加失败: {msg}', en: 'Add failed: {msg}' },
  'status.added': { zh: '已添加', en: 'Added' },
  'status.enterPath': { zh: '请输入项目绝对路径', en: 'Please enter an absolute project path' },
  'status.readingDir': { zh: '读取目录中…', en: 'Reading directory…' },
  'status.dirReadFail': { zh: '目录读取失败: {msg}', en: 'Directory read failed: {msg}' },
  'status.dirLoaded': { zh: '目录已加载', en: 'Directory loaded' },
  'status.readingHex': { zh: '读取十六进制中…', en: 'Reading hex…' },
  'status.hexReadFail': { zh: '十六进制读取失败: {msg}', en: 'Hex read failed: {msg}' },
  'status.previewOpened': { zh: '已打开预览 {rel}', en: 'Opened preview {rel}' },
  'status.readingFile': { zh: '读取文件中… {rel}', en: 'Reading file… {rel}' },
  'status.fileReadFail': { zh: '文件读取失败: {msg}', en: 'File read failed: {msg}' },
  'status.opened': { zh: '已打开 {rel}', en: 'Opened {rel}' },
  'status.saving': { zh: '保存中…', en: 'Saving…' },
  'status.saved': { zh: '已保存 · {time}', en: 'Saved · {time}' },
  'status.saveFail': { zh: '保存失败: {msg}', en: 'Save failed: {msg}' },
  'status.conflict': { zh: '保存冲突: {rel}', en: 'Save conflict: {rel}' },
  'status.reloaded': { zh: '已重载外部版本 · {time}', en: 'Reloaded external version · {time}' },
  'status.stopping': { zh: '停止中… {project}', en: 'Stopping… {project}' },
  'status.cleaning': { zh: '清理中… {project}', en: 'Cleaning… {project}' },
  'status.opFail': { zh: '操作失败: {msg}', en: 'Operation failed: {msg}' },
  'status.opSent': { zh: '操作已提交', en: 'Operation submitted' },
  'status.kbDetailLoading': { zh: '知识库详情读取中… {name}', en: 'Loading knowledge base detail… {name}' },
  'status.kbLogLoading': { zh: '日志正文读取中… {file}', en: 'Loading log content… {file}' },
  'status.loaded': { zh: '已加载 {name}', en: 'Loaded {name}' },

  // ── 错误子句(与状态栏/结果区文案组合)─────────────────────────────────────
  'err.authExpired': { zh: '鉴权失效,请从 面板入口.html 重新进入', en: 'Authorization expired, please re-enter via 面板入口.html' },
  'err.notAllowed': { zh: '路径在白名单之外', en: 'Path is outside the allowlist' },
  'err.notGodotProject': { zh: '不是 Godot 项目', en: 'Not a Godot project' },
  'err.notGodotProjectDetail': { zh: '不是 Godot 项目(缺 project.godot)', en: 'Not a Godot project (missing project.godot)' },
  'err.readonlyStart': { zh: '只读模式，面板启动已禁用', en: 'Read-only mode — panel start is disabled' },
  'err.readonlyReimport': { zh: '只读模式，重导入已禁用', en: 'Read-only mode — reimport is disabled' },
  'err.running409': { zh: '项目运行中，请先停止再重导入', en: 'Project is running — stop it before reimporting' },
  'err.filesNotConfigured': { zh: '文件功能未配置', en: 'Files feature not configured' },
  'err.fileNotFound': { zh: '文件不存在', en: 'File not found' },
  'err.unsupportedExt': { zh: '不支持的扩展名(非文本类)', en: 'Unsupported extension (not a text type)' },
  'err.fileTooLarge': { zh: '文件超限', en: 'File exceeds the size limit' },
  'err.contentTooLarge': { zh: '内容超限(600KB)', en: 'Content exceeds the limit (600KB)' },
  'err.fileDeleted': { zh: '文件不存在(可能已被删除)', en: 'File not found (may have been deleted)' },
  'err.duplicate': { zh: '该路径已在清单中', en: 'This path is already in the list' },
  'err.listFull': { zh: '清单已满(200 上限)', en: 'Project list is full (limit 200)' },
  'err.dirMissing': { zh: '目录不存在', en: 'Directory does not exist' },

  // ── 端点级错误(M4 2026-10-14 审查:此前十余处英文硬编码,zh 界面混排英文)─────
  'err.notConfigured': { zh: '功能未配置', en: 'not configured' },
  'err.readonly': { zh: '只读模式,操作被拒绝', en: 'read-only mode' },
  'err.badJson': { zh: '请求体不是合法 JSON', en: 'bad json' },
  'err.pidRequired': { zh: '需要整数 pid', en: 'pid (integer) required' },
  'err.notRegistered': { zh: '实例未登记或已停止', en: 'not registered or dead' },
  'err.daemonHandoff': { zh: 'daemon 实例须从其自身面板或 CLI 重启(受控交接)', en: 'daemon instance must be restarted from its own panel or CLI (controlled handoff)' },
  'err.staleRegistration': { zh: '登记端口无监听——登记疑似过期(进程已死,PID 可能被无关进程复用),拒绝终止;请重新扫描或移除过期条目', en: 'registered port is not listening — registration is likely stale (process died, PID may be reused by an unrelated process). Refusing to kill. Run a rescan or remove the stale entry instead.' },
  'err.payloadTooLarge': { zh: '请求体超限', en: 'payload too large' },
  'err.saveFieldsRequired': { zh: '缺少 project/path/content/baseMtime 字段', en: 'project/path/content/baseMtime required' },
  'err.godotPathType': { zh: 'godotPath 必须是字符串', en: 'godotPath must be a string' },
  'err.allowedPathsType': { zh: 'allowedProjectPaths 必须是字符串数组', en: 'allowedProjectPaths must be a string array' },
  'err.vaultPathType': { zh: 'vaultPath 必须是字符串', en: 'vaultPath must be a string' },
  'err.pathRequired': { zh: '缺少 path 参数', en: 'path required' },
  'err.notFound': { zh: '未找到', en: 'not found' },
  'err.projectPathRequired': { zh: '缺少 projectPath 参数', en: 'projectPath required' },
  'err.sessionRunning': { zh: '会话仍在运行', en: 'session is still running' },
  'err.projectQueryRequired': { zh: '缺少 project 查询参数', en: 'project query required' },
  'err.nameRequired': { zh: '缺少 name 参数', en: 'name required' },
  'err.namePathRequired': { zh: '缺少 name 与 path 参数', en: 'name and path required' },
  'err.modeInvalid': { zh: 'mode 必须是 text、raw 或 hex', en: 'mode must be text, raw or hex' },
  'err.internal': { zh: '内部错误', en: 'internal error' },
  'err.mcpNotActive': { zh: 'MCP 端点未激活', en: 'mcp endpoint not active' },
  'err.stopFailed': { zh: '停止失败', en: 'stop failed' },
  // 与原 API 英文契约逐字一致的独立键(不复用 files 语义键——其 en 文案不同,会破坏
  // 既有消费方对错误文本的匹配)
  'err.outsideRoots': { zh: '路径在白名单之外', en: 'path outside allowed roots' },
  'err.notGodotProject404': { zh: '不是 Godot 项目', en: 'not a godot project' },
  'err.runningStopFirst': { zh: '项目运行中,请先停止再操作', en: 'project is running; stop it first' },

  // ── 网络异常文案(逐操作建键,保持原文案粒度)───────────────────────────────
  'net.start': { zh: '网络异常,启动请求未送达', en: 'Network error — start request not delivered' },
  'net.reimport': { zh: '网络异常,重导入请求未送达', en: 'Network error — reimport request not delivered' },
  'net.remove': { zh: '网络异常,移除请求未送达', en: 'Network error — remove request not delivered' },
  'net.scan': { zh: '网络异常,扫描请求未送达', en: 'Network error — scan request not delivered' },
  'net.add': { zh: '网络异常,添加请求未送达', en: 'Network error — add request not delivered' },
  'net.dir': { zh: '网络异常,目录请求未送达', en: 'Network error — directory request not delivered' },
  'net.file': { zh: '网络异常,文件请求未送达', en: 'Network error — file request not delivered' },
  'net.hex': { zh: '网络异常,十六进制请求未送达', en: 'Network error — hex request not delivered' },
  'net.save': { zh: '网络异常,保存请求未送达', en: 'Network error — save request not delivered' },
  'net.op': { zh: '网络异常,操作未送达', en: 'Network error — operation not delivered' },
  'net.restart': { zh: '网络异常,重启请求未送达', en: 'Network error — restart request not delivered' },
  'net.verify': { zh: '网络异常,验证请求未送达', en: 'Network error — verify request not delivered' },
  'net.setRead': { zh: '网络异常,设置读取失败', en: 'Network error — failed to read settings' },
  'net.kb': { zh: '网络异常,知识库请求未送达', en: 'Network error — knowledge base request not delivered' },
  'net.kbDetail': { zh: '网络异常,详情请求未送达', en: 'Network error — detail request not delivered' },
  'net.kbLog': { zh: '网络异常,日志请求未送达', en: 'Network error — log request not delivered' },
  'net.outRead': { zh: '网络异常,读取未送达', en: 'Network error — read request not delivered' },

  // ── 横幅/断连提示 ────────────────────────────────────────────────────────
  'warn.cfg': { zh: '未配置 Godot 路径与项目白名单——工具仅可访问启动目录;请在下方「设置」页配置(保存即热生效)。', en: 'Godot path and project allowlist are not configured — tools can only access the startup directory. Configure them in the "Settings" tab below (applies on save).' },
  'warn.reconnecting': { zh: '连接中断,正在寻找可用面板实例…', en: 'Connection lost, looking for an available panel instance…' },
  'warn.reconnectingShort': { zh: '连接中断,重连中…', en: 'Connection lost, reconnecting…' },
  'warn.allDeadShort': { zh: '面板服务已全部停止', en: 'All panel services have stopped' },
  'warn.allDead': { zh: '面板服务已全部停止——服务重启后刷新本页即可自动恢复;或运行 npx godot-mcp-enhanced dashboard --web 重新打开', en: 'All panel services have stopped — refresh this page after the service restarts to recover, or run npx godot-mcp-enhanced dashboard --web to reopen the panel' },
  'warn.needAuth': { zh: '本面板需经 CLI 授权后访问', en: 'This panel requires CLI authorization to access' },
  'warn.needAuthDetail': { zh: '面板需经 CLI 打开完成授权(直访地址不带 token)——请在终端运行 npx godot-mcp-enhanced dashboard --web 打开面板', en: 'The panel must be opened via the CLI to complete authorization (a direct URL carries no token) — run npx godot-mcp-enhanced dashboard --web in a terminal to open the panel' },

  // ── 项目区 ──────────────────────────────────────────────────────────────
  'proj.pane': { zh: '项目', en: 'Projects' },
  'proj.pane.title': { zh: '增删/扫描影响 server 登记状态', en: 'Add/remove/scan affects the server registry state' },
  'proj.search.label': { zh: '搜索项目:名称/路径', en: 'Search projects: name/path' },
  'proj.search.ph': { zh: '搜索:名称/路径', en: 'Search: name/path' },
  'proj.btn.scan': { zh: '扫描', en: 'Scan' },
  'proj.btn.add': { zh: '+添加', en: '+ Add' },
  'proj.addpath.label': { zh: '项目绝对路径(须在白名单内)', en: 'Absolute project path (must be inside the allowlist)' },
  'proj.btn.addConfirm': { zh: '确定', en: 'OK' },
  'proj.notConfigured': { zh: '项目功能未配置', en: 'Projects feature not configured' },
  'proj.noMatch': { zh: '无匹配项目', en: 'No matching projects' },
  'proj.emptyHint': { zh: '暂无项目,点击「扫描」发现', en: 'No projects yet — click "Scan" to discover' },
  'proj.btn.reimport': { zh: '重新导入资源', en: 'Reimport resources' },
  'proj.btn.run': { zh: '运行', en: 'Run' },
  'proj.btn.edit': { zh: '编辑', en: 'Edit' },
  'proj.btn.files': { zh: '文件', en: 'Files' },
  'proj.btn.filesTip': { zh: '浏览文件', en: 'Browse files' },
  'proj.btn.remove': { zh: '从列表移除', en: 'Remove from list' },
  'proj.missing': { zh: '路径不存在', en: 'Path does not exist' },
  'proj.runningNoReimport': { zh: '运行中，请先停止再重导入', en: 'Running — stop before reimporting' },
  'proj.confirmRemove': { zh: '仅从列表移除，不删除文件。确定移除 {name}?', en: 'This only removes the entry from the list — no files are deleted. Remove {name}?' },
  'proj.badgeKb': { zh: '知识库:{log}', en: 'Knowledge base: {log}' },
  'proj.lastLog': { zh: '最近日志 {date}', en: 'latest log {date}' },
  'proj.noLog': { zh: '无日志', en: 'no logs' },
  'proj.stallMark': { zh: '(🔴 疑似断流!)', en: '(🔴 possible stall!)' },

  // ── 会话区 ──────────────────────────────────────────────────────────────
  'sess.pane': { zh: '运行会话', en: 'Sessions' },
  'sess.pane.title': { zh: '「停止/清理」影响运行中的游戏进程', en: '"Stop/Clean" affects running game processes' },
  'sess.empty': { zh: '暂无会话', en: 'No sessions' },
  'sess.btn.stop': { zh: '停止', en: 'Stop' },
  'sess.btn.clean': { zh: '清理', en: 'Clean' },
  'sess.row.title': { zh: '{path} · pid {pid} · 输出 {lines} 行{busy}', en: '{path} · pid {pid} · {lines} output line(s){busy}' },
  'sess.busySuffix': { zh: ' · busy {owner}', en: ' · busy {owner}' },
  'sess.output.tip': { zh: '查看进程输出(运行中实时/已结束回查)', en: 'View process output (live while running / review after exit)' },

  // ── 实例区 ──────────────────────────────────────────────────────────────
  'inst.pane': { zh: '实例', en: 'Instances' },
  'inst.pane.title': { zh: '「重启」中断该实例的 MCP 会话,客户端重连拉起新进程', en: '"Restart" interrupts the MCP session of this instance; the client reconnects and spawns a new process' },
  'inst.selfSuffix': { zh: ' ·本实例', en: ' · this instance' },
  'inst.handingOver': { zh: '交接中', en: 'Handing over' },
  'inst.handingOverTip': { zh: 'respawnOf={pid} 的旧登记仍在场,受控交接进行中', en: 'respawnOf={pid} old registration still present, controlled handover in progress' },
  'inst.inUse': { zh: '占用中', en: 'In use' },
  'inst.inUseTip': { zh: '有活跃 MCP 会话(/mcp 单会话独占中)', en: 'An active MCP session exists (/mcp single-session exclusive)' },
  'inst.idle': { zh: '空闲', en: 'Idle' },
  'inst.guideText': { zh: '在 daemon 面板或 CLI 重启', en: 'Restart from the daemon panel or CLI' },
  'inst.guideTip': { zh: '跨实例重启已禁用:请在 daemon 自身面板点「重启」,或 CLI 运行 npx godot-mcp-enhanced daemon restart', en: 'Cross-instance restart is disabled — click "Restart" on the daemon panel itself, or run npx godot-mcp-enhanced daemon restart in the CLI' },
  'inst.btn.restart': { zh: '重启', en: 'Restart' },
  'inst.group.self': { zh: '本实例', en: 'This instance' },
  'inst.group.self.tip': { zh: '面板自身的宿主进程', en: 'The host process of this panel' },
  'inst.group.daemon.tip': { zh: '常驻守护进程(HTTP /mcp 端点)', en: 'Persistent daemon (HTTP /mcp endpoint)' },
  'inst.group.stdio.tip': { zh: 'MCP 客户端(Claude Code/Cursor/ZCode 等)拉起的 stdio server', en: 'stdio server spawned by an MCP client (Claude Code/Cursor/ZCode etc.)' },
  'inst.group.legacy': { zh: '早期实例', en: 'Legacy instances' },
  'inst.group.legacy.tip': { zh: '登记无类型字段——kind 字段 2026-09-30 才加入登记,此前 build 启动的实例无法判断类型;重启后新实例会正确归类', en: 'Registration lacks the kind field — it was added on 2026-09-30; instances from earlier builds cannot be classified. They will be classified correctly after restart.' },
  'inst.empty': { zh: '没有运行中的实例', en: 'No running instances' },
  'inst.started': { zh: 'started {time}{handover}', en: 'started {time}{handover}' },
  'inst.handoverSuffix': { zh: ' · 交接中(旧 pid {pid} 登记仍在场)', en: ' · handing over (old pid {pid} registration still present)' },
  'inst.gone': { zh: '实例 pid={pid} 已退出;客户端重连后新实例将出现在列表(版本列=新 build)', en: 'Instance pid={pid} exited; a new instance will appear in the list after the client reconnects (version column = new build)' },
  'inst.stillRunning': { zh: '实例 pid={pid} 仍在运行(重启可能未生效,列表 15s 自动刷新)', en: 'Instance pid={pid} is still running (restart may not have taken effect; the list refreshes every 15s)' },
  'inst.confirm.self': { zh: '重启本实例?面板将短暂断开,自动迁移到其他活实例(若无其他实例,等客户端重连后刷新本页即可)。', en: 'Restart this instance? The panel will disconnect briefly and migrate to another live instance (if none exists, wait for the client to reconnect and refresh this page).' },
  'inst.confirm.other': { zh: '重启实例 pid={pid}?\n会中断该实例正在服务的一个 MCP 会话,其正在跑的游戏会话也会被清理;\n客户端通常自动重连并拉起新进程(新代码生效),若未自动重连请在客户端手动重连。', en: 'Restart instance pid={pid}?\nThis interrupts the MCP session the instance is serving; its running game sessions are also cleaned up.\nThe client usually reconnects and spawns a new process (new code takes effect); if it does not, reconnect manually in the client.' },
  'inst.restarting': { zh: '重启中… pid={pid}', en: 'Restarting… pid={pid}' },
  'inst.restartFail': { zh: '重启失败: {msg}', en: 'Restart failed: {msg}' },
  'inst.selfRestarting': { zh: '本实例重启中,面板即将断开…', en: 'This instance is restarting, the panel is about to disconnect…' },
  'inst.restartRequested': { zh: '已请求重启 pid={pid},等待客户端拉起新进程…', en: 'Restart requested for pid={pid}, waiting for the client to spawn a new process…' },

  // ── 会话输出视图 ────────────────────────────────────────────────────────
  'out.back': { zh: '← 返回', en: '← Back' },
  'out.refresh': { zh: '⟳ 刷新', en: '⟳ Refresh' },
  'out.empty404': { zh: '该会话无输出记录(可能已被清理或从未运行)', en: 'No output record for this session (may have been cleaned up or never ran)' },
  'out.readFail': { zh: '读取失败(HTTP {n})', en: 'Read failed (HTTP {n})' },
  'out.title': { zh: '{state} · {status} · {n} 行{trunc}', en: '{state} · {status} · {n} line(s){trunc}' },
  'out.running': { zh: '运行中', en: 'Running' },
  'out.ended': { zh: '已结束', en: 'Exited' },
  'out.truncSuffix': { zh: '(尾部 {n}/{total})', en: ' (last {n}/{total})' },
  'out.noOutputYet': { zh: '暂无输出——进程尚未打印任何内容', en: 'No output yet — the process has not printed anything' },
  'out.noOutputLast': { zh: '上次运行无输出留存', en: 'No output retained from the last run' },

  // ── 日志流 ──────────────────────────────────────────────────────────────
  'logs.pane': { zh: '日志流', en: 'Log stream' },
  'logs.filter.label': { zh: '过滤日志:工具/模块/项目', en: 'Filter logs: tool/module/project' },
  'logs.filter.ph': { zh: '过滤:工具/模块/项目', en: 'Filter: tool/module/project' },
  'logs.level.label': { zh: '日志级别', en: 'Log level' },
  'logs.count': { zh: '{n} 条', en: '{n} entries' },

  // ── 工具统计 ────────────────────────────────────────────────────────────
  'stats.pane': { zh: '工具统计', en: 'Tool stats' },
  'stats.projsel.label': { zh: '工具统计项目筛选', en: 'Tool stats project filter' },
  'stats.all': { zh: '全部', en: 'All' },
  'stats.timeline': { zh: '分钟时序', en: 'Per-minute timeline' },
  'stats.waiting': { zh: '等待数据…', en: 'Waiting for data…' },
  'stats.emptyTools': { zh: '暂无工具调用——server 收到调用后出现', en: 'No tool calls yet — appears once the server receives calls' },
  'stats.emptyTimeline': { zh: '暂无分钟时序数据', en: 'No per-minute timeline data yet' },

  // ── 右列 tab ────────────────────────────────────────────────────────────
  'tab.files': { zh: '文件', en: 'Files' },
  'tab.kb': { zh: '知识库', en: 'Knowledge' },
  'tab.settings': { zh: '设置', en: 'Settings' },

  // ── 文件浏览 ────────────────────────────────────────────────────────────
  'files.emptyHint': { zh: '点击左侧项目行的「文件」按钮浏览项目目录', en: 'Click the "Files" button on a project row (left column) to browse the project directory' },
  'files.emptyDir': { zh: '空目录', en: 'Empty directory' },

  // ── 预览视图 ────────────────────────────────────────────────────────────
  'preview.back': { zh: '返回列表', en: 'Back to list' },
  'preview.download': { zh: '下载 {name}', en: 'Download {name}' },
  'preview.imgFail': { zh: '加载失败(token 失效或文件超限)', en: 'Load failed (token expired or file too large)' },
  'preview.audioFail': { zh: '音频加载失败(token 失效或文件超限)', en: 'Audio load failed (token expired or file too large)' },

  // ── hex 视图 ────────────────────────────────────────────────────────────
  'hex.truncated': { zh: '仅前 4KB,完整内容请下载后查看', en: 'Only the first 4KB — download to view the full content' },

  // ── 编辑视图 ────────────────────────────────────────────────────────────
  'ed.btn.save': { zh: '保存', en: 'Save' },
  'ed.btn.saveDirty': { zh: '● 保存', en: '● Save' },
  'ed.btn.reload': { zh: '重新加载', en: 'Reload' },
  'ed.btn.backList': { zh: '返回列表', en: 'Back to list' },
  'ed.roBanner': { zh: '只读模式:服务端为 READ_ONLY,保存已禁用', en: 'Read-only mode: the server is READ_ONLY, saving is disabled' },
  'ed.roDisabled': { zh: '只读模式:保存已禁用', en: 'Read-only mode: saving is disabled' },
  'ed.conflict': { zh: '文件已被外部修改(可能是 Godot 编辑器或 AI)', en: 'The file was modified externally (possibly by the Godot editor or an AI)' },
  'ed.btn.copyMine': { zh: '复制我的修改', en: 'Copy my changes' },
  'ed.dirtyConfirm': { zh: '有未保存修改,离开将丢失', en: 'Unsaved changes will be lost if you leave' },
  'ed.copied': { zh: '已复制我的修改到剪贴板', en: 'My changes copied to clipboard' },
  'ed.copyFail': { zh: '复制失败,请手动全选复制', en: 'Copy failed — select all and copy manually' },
  'ed.clipboardNa': { zh: '剪贴板不可用,请手动全选复制', en: 'Clipboard unavailable — select all and copy manually' },

  // ── 知识库联动 ──────────────────────────────────────────────────────────
  'kb.refresh': { zh: '⟳ 刷新', en: '⟳ Refresh' },
  'kb.gotoSettings': { zh: '去设置 vault 路径', en: 'Set vault path in Settings' },
  'kb.gotoSettingsShort': { zh: '去设置', en: 'Go to Settings' },
  'kb.notConfigured': { zh: '未配置知识库 vault——到「设置」tab 填 Obsidian vault 根目录(如 D:\\workspace\\Obsidian)即可在此查看各项目待办进度与开发日志', en: 'Knowledge base vault not configured — enter your Obsidian vault root (e.g. D:\\workspace\\Obsidian) in the "Settings" tab to view project todo progress and dev logs here' },
  'kb.vaultMissing': { zh: '配置的 vault 目录不存在,请到「设置」检查路径', en: 'The configured vault directory does not exist — check the path in "Settings"' },
  'kb.obsidianHome': { zh: 'Obsidian 首页', en: 'Obsidian home' },
  'kb.openInObsidian': { zh: '在 Obsidian 中打开', en: 'Open in Obsidian' },
  'kb.noProjects': { zh: 'vault 内未发现项目知识库目录(判定:含 开发日志/ 或 任务看板.md 或 项目待办.md 或「* 首页.md」)', en: 'No project knowledge base directories found in the vault (heuristic: contains 开发日志/ or 任务看板.md or 项目待办.md or "* 首页.md")' },
  'kb.noTasks': { zh: '{file}(无任务条目)', en: '{file} (no task entries)' },
  'kb.noBoard': { zh: '无活跃看板', en: 'No active board' },
  'kb.noBoardDetail': { zh: '无活跃看板(项目待办/任务看板均归档或缺席)', en: 'No active board (项目待办/任务看板 archived or absent)' },
  'kb.stallDays': { zh: '🔴 断流 {n}天', en: '🔴 stalled {n}d' },
  'kb.stallNoLog': { zh: '🔴 断流(近期提交无日志)', en: '🔴 stalled (recent commits without logs)' },
  'kb.fresh': { zh: '🟢 同步', en: '🟢 in sync' },
  'kb.noLog': { zh: '· 无日志', en: '· no logs' },
  'kb.lastCommit': { zh: '最近提交 {date}', en: 'Last commit {date}' },
  'kb.deadProjectTip': { zh: '最近提交 {date}(死项目或未开始记录,不算断流)', en: 'Last commit {date} (dead or unstarted project, not a stall)' },
  'kb.repoUnreadable': { zh: '· 仓库不可读', en: '· repo unreadable' },
  'kb.unmapped': { zh: '· 未映射仓库', en: '· repo not mapped' },
  'kb.noLogs': { zh: '无开发日志', en: 'No dev logs' },
  'kb.boardLine': { zh: '看板:{file}  ✔ {done}/{total}', en: 'Board: {file}  ✔ {done}/{total}' },
  'kb.logsLabel': { zh: '开发日志(最近 {n} 篇,点击查看正文)', en: 'Dev logs (latest {n}, click to view)' },
  'kb.backList': { zh: '← 返回总览', en: '← Back to overview' },
  'kb.obsidianOpen': { zh: 'Obsidian 打开', en: 'Open in Obsidian' },
  'kb.backDetail': { zh: '← 返回 {name}', en: '← Back to {name}' },
  'kb.emptyFile': { zh: '(空文件)', en: '(empty file)' },
  'kb.overviewFail': { zh: '知识库总览读取失败( HTTP {n})', en: 'Knowledge base overview failed (HTTP {n})' },
  'kb.detailFail': { zh: '项目详情读取失败: {msg}', en: 'Project detail failed: {msg}' },
  'kb.logFail': { zh: '日志读取失败: {msg}', en: 'Log read failed: {msg}' },

  // ── 设置面板 ────────────────────────────────────────────────────────────
  'set.godotpath.label': { zh: 'Godot 可执行路径', en: 'Godot executable path' },
  'set.btn.verify': { zh: '验证', en: 'Verify' },
  'set.godotpath.hint': { zh: '候选来自 ~/.godot-mcp/godot-paths.json(CLI install 登记),点击即填入并验证;「验证」会运行 --version 确认版本;留空 = 清除设置,恢复启动时配置。注:项目若配了 .godot/mcp-godot.json 等项目级 override,该项目仍优先用 override 的路径', en: 'Candidates come from ~/.godot-mcp/godot-paths.json (registered by CLI install) — click to fill and verify; "Verify" runs --version to confirm. Empty = clear the setting and restore startup config. Note: if the project has a project-level override such as .godot/mcp-godot.json, that path still takes precedence' },
  'set.allowed.label': { zh: '项目目录白名单(每行一个绝对路径)', en: 'Project directory allowlist (one absolute path per line)' },
  'set.allowed.hint': { zh: '即 ALLOWED_PROJECT_PATHS,影响所有工具可访问的目录范围;清空 = 恢复启动时配置(deny-by-default 收缩到工作目录)', en: 'This is ALLOWED_PROJECT_PATHS — the directory scope all tools can access. Clear = restore startup config (deny-by-default shrinks to the working directory)' },
  'set.vault.label': { zh: '知识库 vault 根目录(Obsidian)', en: 'Knowledge base vault root (Obsidian)' },
  'set.btn.vaultSave': { zh: '保存', en: 'Save' },
  'set.vault.hint': { zh: '即 GODOT_MCP_VAULT_PATH,「知识库」tab 据此展示各项目的待办进度/开发日志/断流检测;留空 = 清除设置。只读联动,面板不写 vault;独立于上方 Godot 设置单独保存', en: 'This is GODOT_MCP_VAULT_PATH — the "Knowledge" tab shows per-project todo progress, dev logs and stall detection based on it. Empty = clear the setting. Read-only integration; the panel never writes to the vault; saved independently of the Godot settings above' },
  'set.btn.save': { zh: '保存设置', en: 'Save settings' },
  'set.info.label': { zh: '当前生效(只读)', en: 'Currently effective (read-only)' },
  'set.readFail': { zh: '设置读取失败(无权限)', en: 'Failed to read settings (no permission)' },
  'set.roDisabled': { zh: '只读模式,保存已禁用', en: 'Read-only mode, saving is disabled' },
  'set.emptyHint': { zh: '(留空 = 清除设置,恢复启动时配置)', en: '(Empty = clear the setting and restore startup config)' },
  'set.verifying': { zh: '验证中(运行 --version)…', en: 'Verifying (running --version)…' },
  'set.verifyFail': { zh: '✗ 校验失败', en: '✗ Verification failed' },
  'set.verifyFailShort': { zh: '校验失败', en: 'Verification failed' },
  'set.saving': { zh: '保存中…(含二进制校验,可能数秒)', en: 'Saving… (includes binary verification, may take seconds)' },
  'set.saved': { zh: '已保存并立即生效(重启后仍生效)', en: 'Saved and applied immediately (persists after restart)' },
  'set.saveFail': { zh: '保存失败: {msg}', en: 'Save failed: {msg}' },
  'set.vaultSaved': { zh: '✓ 已保存并立即生效,「知识库」tab 可用', en: '✓ Saved and applied immediately — the "Knowledge" tab is available' },
  'set.vaultCleared': { zh: '✓ 已清除(恢复启动时配置)', en: '✓ Cleared (startup config restored)' },
  'set.info.godotPath': { zh: '当前 Godot 路径: ', en: 'Current Godot path: ' },
  'set.info.godotPathEmpty': { zh: '(未设置,自动查找)', en: '(not set, auto-detected)' },
  'set.info.allowed': { zh: '当前白名单: ', en: 'Current allowlist: ' },
  'set.info.allowedEmpty': { zh: '(未设置,收缩到工作目录)', en: '(not set, shrunk to the working directory)' },
  'set.info.unrestrictedTrue': { zh: 'true(所有限制旁路)', en: 'true (all restrictions bypassed)' },
  'set.info.godotAllowed': { zh: 'Godot 二进制白名单: ', en: 'Godot binary allowlist: ' },
  'set.info.godotAllowedEmpty': { zh: '(未配置)', en: '(not configured)' },
  'set.info.vault': { zh: '当前知识库 vault: ', en: 'Current knowledge base vault: ' },
  'set.info.vaultEmpty': { zh: '(未设置,「知识库」tab 显示配置引导)', en: '(not set — the "Knowledge" tab shows a setup guide)' },

  // ── 相对时间 ────────────────────────────────────────────────────────────
  'time.justNow': { zh: '刚刚', en: 'just now' },
  'time.minAgo': { zh: '{n} 分钟前', en: '{n} min ago' },
  'time.hourAgo': { zh: '{n} 小时前', en: '{n} h ago' },

  // ── 语言切换 ────────────────────────────────────────────────────────────
  'lang.switchTo': { zh: 'EN', en: '中文' },

  // ── portal 入口页 ───────────────────────────────────────────────────────
  'portal.title': { zh: 'godot-mcp-enhanced 面板入口', en: 'godot-mcp-enhanced panel entry' },
  'portal.dead.p1': { zh: '当前没有运行中的面板服务(godot-mcp server 未启动)。', en: 'No panel service is currently running (godot-mcp server not started).' },
  'portal.dead.p2': { zh: '启动方式:打开任一 AI 客户端会话(面板随 godot-mcp server 自动启动),或运行', en: 'To start: open any AI client session (the panel starts automatically with the godot-mcp server), or run' },
  'portal.dead.p3pre': { zh: '启动后', en: 'Once started, ' },
  'portal.dead.refresh': { zh: '刷新本页', en: 'refresh this page' },
  'portal.dead.p3post': { zh: '即可自动进入。', en: ' to enter automatically.' },
  'portal.scanning': { zh: '正在扫描本机面板服务…', en: 'Scanning for local panel services…' },
  'portal.scanDone': { zh: '扫描完成:9550-9569 无响应。', en: 'Scan complete: no response on 9550-9569.' },
  'portal.found': { zh: '发现 {n} 个实例,正在进入面板服务(:{port})…', en: 'Found {n} instance(s), entering the panel service (:{port})…' },
  'portal.instance': { zh: '实例 :{port}', en: 'Instance :{port}' },

  // ── 后端面向展示的消息(settings-api/files-api 按请求 Accept-Language 取值;
  //    键不进前端字典序列化范围——serializeI18nForInline 全量内联无妨,前端不引用)──
  'set.stage.path-not-allowed': { zh: '路径不在 GODOT_MCP_ALLOWED_GODOT_PATHS 白名单内(见 Godot 二进制白名单策略)', en: 'Path is not in the GODOT_MCP_ALLOWED_GODOT_PATHS allowlist (see the Godot binary allowlist policy)' },
  'set.stage.is-directory': { zh: '路径是目录,须指向 Godot 可执行文件', en: 'Path is a directory — it must point to a Godot executable' },
  'set.stage.version-run-failed': { zh: '无法运行 --version(文件不存在或不可执行)', en: 'Cannot run --version (file missing or not executable)' },
  'set.stage.not-godot-signature': { zh: '--version 输出不是有效的 Godot 版本签名', en: '--version output is not a valid Godot version signature' },
  'set.stage.not-a-godot-binary': { zh: '无法验证为 Godot 可执行文件(路径不存在、不可执行或 --version 输出签名不符)', en: 'Cannot be verified as a Godot executable (path missing, not executable, or --version signature mismatch)' },
  'set.verify.emptyPath': { zh: '路径不能为空', en: 'Path cannot be empty' },
  'set.verify.versionReadFailed': { zh: '二进制校验通过,但读取版本串失败', en: 'Binary check passed but reading the version string failed' },
  'set.save.godotNotAbsolute': { zh: 'Godot 路径必须是绝对路径', en: 'Godot path must be an absolute path' },
  'set.save.godotVerifyFailed': { zh: 'Godot 路径校验失败:{msg}', en: 'Godot path verification failed: {msg}' },
  'set.save.badEntry': { zh: '白名单条目不能为空', en: 'Allowlist entries cannot be empty' },
  'set.save.semicolon': { zh: '白名单条目不能含分号(env 以分号分隔,会被撕裂):{path}', en: 'Allowlist entries cannot contain semicolons (env is semicolon-delimited and would be torn apart): {path}' },
  'set.save.allowedNotAbsolute': { zh: '白名单条目必须是绝对路径:{path}', en: 'Allowlist entries must be absolute paths: {path}' },
  'set.save.notADirectory': { zh: '白名单条目不是目录:{path}', en: 'Allowlist entry is not a directory: {path}' },
  'set.save.notFound': { zh: '白名单条目不存在:{path}', en: 'Allowlist entry does not exist: {path}' },
  'set.save.vaultNotAbsolute': { zh: 'vault 路径必须是绝对路径', en: 'Vault path must be an absolute path' },
  'set.save.vaultNotADirectory': { zh: 'vault 路径不是目录:{path}', en: 'Vault path is not a directory: {path}' },
  'set.save.vaultNotFound': { zh: 'vault 路径不存在:{path}', en: 'Vault path does not exist: {path}' },
  'set.save.emptyPatch': { zh: '没有要保存的设置字段', en: 'No settings fields to save' },
  'files.save.gdSandboxNote': { zh: ' (含危险模式的 .gd 请经 MCP 通道写入,那里有 out-of-band 确认门)', en: ' (.gd files containing dangerous patterns must be written via the MCP channel, which enforces an out-of-band confirmation gate)' },
};

/** 序列化字典供模板内联:`var I18N = { zh: {...}, en: {...} }` 的右值 JSON。
 *  `<` 转 \u003c:防字典值意外含 </script> 截断脚本(标准防御);JSON 输出的 \" \\
 *  在模板字符串 ${} 插值下原样保留(不经模板转义——2026-09-30 死锁根因家族免疫)。
 *  prefixes 过滤:portal 只内联自身前缀键,控制入口页体积。 */
export function serializeI18nForInline(prefixes?: readonly string[]): string {
  const picked: Record<string, BiString> = {};
  for (const [k, v] of Object.entries(GUI_STRINGS)) {
    if (!prefixes || prefixes.some(p => k.startsWith(p))) picked[k] = v;
  }
  return JSON.stringify({
    zh: Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v.zh])),
    en: Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v.en])),
  }).replace(/</g, '\\u003c');
}

/** 后端消息取值(settings-api/files-api 按 Accept-Language 解析结果调用)。
 *  缺 key 回落 zh(与前端 t() 同语义);params 做 {name} 占位替换。 */
export function guiText(lang: 'zh' | 'en', key: string, params?: Record<string, string | number>): string {
  const e = GUI_STRINGS[key];
  let s: string;
  if (!e) s = key;
  else s = lang === 'en' ? e.en : e.zh;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** 解析 HTTP Accept-Language 头为面板语言:zh* → zh,其余 → en,缺省 zh。 */
export function pickGuiLang(acceptLanguage: string | undefined): 'zh' | 'en' {
  if (!acceptLanguage) return 'zh';
  return /^zh/i.test(acceptLanguage.trim()) ? 'zh' : 'en';
}
