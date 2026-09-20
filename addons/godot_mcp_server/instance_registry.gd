extends Node
## CMP-7 (2026-08-08): Editor instance registry — editor discovery 对齐 headless 多实例。
##
## editor 模式启动时写 instance JSON 到 ~/.godot-mcp/instances/{port}.json,
## 让 InstanceManager(InstanceManager.ts) 能发现正在运行的 editor 实例。
## 心跳定期更新 lastSeen(每 30s),_exit_tree 删自己的 JSON。
##
## 对齐 headless 多实例的 registry 范式(InstanceManager 读 ~/.godot-mcp/instances/*.json)。
## 文件名用 port(非 pid),因 editor 端口默认段固定(9090 起,可移植性 P4 后经
## godot_mcp/editor_port_base 可配),pid 每次启动变。

const UPDATE_INTERVAL := 30.0  # lastSeen 更新间隔(秒),< InstanceManager staleTimeoutMs(70s)

var _instance_id: String = ""
var _registry_dir: String = ""
var _instance_file: String = ""
var _timer: float = 0.0
var _plugin: EditorPlugin


func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin


func _ready() -> void:
	_write_instance_json()


func _process(delta: float) -> void:
	_timer += delta
	if _timer >= UPDATE_INTERVAL:
		_timer = 0.0
		_update_last_seen()


func _exit_tree() -> void:
	_remove_instance_json()


## 写 instance JSON 到 registry(首次 + 启动时调用)
func _write_instance_json() -> void:
	# 可移植性 P4:显式 godot_mcp/editor_port 优先;未设时默认随 editor_port_base
	# (websocket_server.gd _resolve_port_range 同源),用户改了端口段注册表文件名跟着对齐。
	var port: int = int(ProjectSettings.get_setting(
		"godot_mcp/editor_port",
		ProjectSettings.get_setting("godot_mcp/editor_port_base", 9090)))
	# 审查 Nit-1:非法值回落对齐 websocket_server._resolve_port_range(WS 侧回落 9090
	# 监听,registry 用非法值会致 TS discovery 拿错端口/文件名)。
	if port < 1 or port > 65535:
		push_warning("[MCP] instance_registry: invalid editor port %d — falling back to 9090" % port)
		port = 9090
	_instance_id = "editor-%d" % port
	_registry_dir = _get_registry_dir()
	_instance_file = "%s/%s.json" % [_registry_dir, _instance_id]

	# 确保 registry 目录存在
	DirAccess.make_dir_recursive_absolute(_registry_dir)
	# P2-4 (2026-08-11): registry 目录权限收紧(对齐 instance-api-auth.ts .api-secret 0o600)。
	# 防多用户机器其他用户枚举 projectPath/pid。单人 home 默认私有,此为 defense-in-depth。
	if OS.get_name() == "Windows":
		# Windows: icacls 移除继承 + 授当前用户完全控制(其他用户拒访问)
		var username := OS.get_environment("USERNAME")
		if not username.is_empty():
			var ec := OS.execute("icacls", PackedStringArray([_registry_dir, "/inheritance:r", "/grant:r", username + ":(OI)(CI)F"]), [])
			if ec != OK:
				push_warning("[MCP] instance_registry: icacls tighten failed (exit %d), registry dir may be accessible to other users" % ec)
	else:
		# Linux/macOS: set_unix_permissions 0o700(owner-only)
		# fix #65: set_unix_permissions 是 FileAccess 的静态方法,DirAccess 无此方法——
		# 原实例调用在非 Windows 平台 runtime error 中止 _write_instance_json,
		# _write_json_atomic 永不执行 → editor 实例 JSON 永不落盘(Windows 走 icacls 分支故未触发)。
		# 镜像上方 Windows 分支:检查返回值,chmod 失败仅告警不阻断注册。
		var perm_err := FileAccess.set_unix_permissions(_registry_dir, 0b111000000)  # 0o700 = owner rwx
		if perm_err != OK:
			push_warning("[MCP] instance_registry: chmod 0700 failed (err %d), registry dir may be readable by other users" % perm_err)

	var project_path: String = ProjectSettings.globalize_path("res://").rstrip("/")
	var project_name: String = project_path.get_file()
	if project_name == "":
		project_name = "unknown"
	var data: Dictionary = {
		"id": _instance_id,
		"projectPath": project_path,
		"projectName": project_name,
		"port": port,
		"pid": OS.get_process_id(),
		# B-1 fix (审查 BLOCKING): lastSeen 用 ISO 8601 string(对齐 headless mcp_bridge.gd:476
		# + TS InstanceInfo.lastSeen: string 类型守卫 instance-manager.ts:49)。
		# 原用 epoch ms(number)致 TS isInstanceInfo typeof 检查失败 → editor 实例被静默丢弃。
		"lastSeen": Time.get_datetime_string_from_system(),
		"godotVersion": Engine.get_version_info().get("string", "unknown"),
		"capabilities": ["editor-instance"],
		"status": "ready",
	}
	_write_json_atomic(data)


## 更新 lastSeen(心跳,防 InstanceManager 标 stale)
func _update_last_seen() -> void:
	if _instance_file.is_empty():
		return
	# 读现有 JSON 只更新 lastSeen(保留其他字段,防并发覆盖)
	var f := FileAccess.open(_instance_file, FileAccess.READ)
	if f == null:
		# 文件可能被外部删了,重写
		_write_instance_json()
		return
	var content := f.get_as_text()
	f.close()
	var parsed = JSON.parse_string(content)
	if parsed == null or not parsed is Dictionary:
		_write_instance_json()
		return
	# B-1 fix: lastSeen 用 ISO 8601 string(对齐 headless + TS 类型守卫)
	parsed["lastSeen"] = Time.get_datetime_string_from_system()
	_write_json_atomic(parsed)


## I-1 fix (审查 IMPORTANT): 原子写——先写 .tmp 再 rename(对齐 headless mcp_bridge.gd:480-489 范式),
## 防 TS 读 registry 时读到半写 JSON 致 JSON.parse 失败 → 实例被静默跳过。
## P2-3 (2026-08-11 审查): 写前 symlink 预检(对齐 SEC-P2-2 mcp_bridge.gd:383-413)。
## 攻击者预置 .tmp/_instance_file 为 symlink 指向任意文件,rename 覆盖目标。
## GD 无原生 symlink 检测 API,Windows 借 PowerShell Get-Item LinkType,Linux 借 readlink。
## S-4 (2026-08-12 审查): (1) path 经命令行参数传(非进程级 env),消除多实例并发 _MCP_SYMLINK_CHK 互相覆盖;
##     (2) Windows fail-closed — PowerShell 不可用/超时/ec 非 0 非 3 时视为可疑拒绝写(原 return ec==3 fail-open)。
func _is_symlink(path: String) -> bool:
	if not FileAccess.file_exists(path):
		return false
	if OS.get_name() == "Windows":
		# PowerShell 单引号字符串转义:' → ''
		var esc_path := path.replace("'", "''")
		var cmd := "if ((Get-Item -LiteralPath '%s' -Force).LinkType) { exit 3 } else { exit 0 }" % esc_path
		var ec := OS.execute("powershell", PackedStringArray(["-NoProfile", "-Command", cmd]), [])
		if ec == 3:
			return true  # 是 symlink
		if ec == 0:
			return false  # 非 symlink
		# fail-closed:PowerShell 不可用/受限/超时(ec != 0 且 != 3)→ 视为可疑拒绝写
		push_warning("[MCP] instance_registry: symlink check inconclusive (powershell ec=%d) for %s — refusing to write (fail-closed)" % [ec, path])
		return true
	else:
		var ec := OS.execute("readlink", PackedStringArray([path]), [])
		return ec == OK


func _write_json_atomic(data: Dictionary) -> void:
	# B3 (2026-08-11 审查): tmp 加 pid 后缀——同项目多 editor 读同端口共享同一 registry 文件,
	# 固定 .tmp 路径两实例交错写会互相损坏(写一半被对方 rename)。pid 后缀互不干扰。
	var tmp_file := _instance_file + ".%d.tmp" % OS.get_process_id()
	# P2-3: 写前 symlink 预检(防 rename 覆盖 symlink 目标)
	if _is_symlink(tmp_file) or _is_symlink(_instance_file):
		push_warning("[MCP] instance_registry: %s or its .tmp is a symlink — refusing to write (possible symlink attack)" % _instance_file)
		return
	var f := FileAccess.open(tmp_file, FileAccess.WRITE)
	if f == null:
		push_warning("[MCP] instance_registry: could not write %s (error %d)" % [tmp_file, FileAccess.get_open_error()])
		return
	f.store_string(JSON.stringify(data))
	f.close()
	# rename 是原子操作(同文件系统内),TS 读 registry 时要么看到旧文件要么看到新文件,不会读到半写
	var err := DirAccess.rename_absolute(tmp_file, _instance_file)
	if err != OK:
		push_warning("[MCP] instance_registry: rename %s → %s failed (error %d)" % [tmp_file, _instance_file, err])


## 删自己的 instance JSON(对齐 mcp_editor.key "只删自己" 范式)
## B3 (2026-08-11 审查): 原只查 file_exists 就删——同项目多 editor 共享同一 registry 文件
## (文件名 port-based),B 退出会删掉 A 的文件(A 仍在跑,TS discovery 丢实例)。
## 现读 JSON 验 pid:文件记录的 pid == 自己才删;pid 是别人的(另一实例仍持有)则跳过。
## lastSeen 由仍存活的实例心跳继续维护(pid 字段随其心跳写入),discovery 不受影响。
func _remove_instance_json() -> void:
	if _instance_file.is_empty():
		return
	if not FileAccess.file_exists(_instance_file):
		return
	var f := FileAccess.open(_instance_file, FileAccess.READ)
	if f == null:
		DirAccess.remove_absolute(_instance_file)  # 读不开(损坏)→ 删除让存活实例重写
		return
	var content := f.get_as_text()
	f.close()
	var parsed = JSON.parse_string(content)
	if parsed == null or not parsed is Dictionary:
		DirAccess.remove_absolute(_instance_file)  # 损坏 JSON → 删除让存活实例重写
		return
	var file_pid: int = int(parsed.get("pid", 0))
	if file_pid != 0 and file_pid != OS.get_process_id():
		push_warning("[MCP] instance_registry: %s is owned by live pid %d (not us %d) — leaving it in place" % [_instance_file, file_pid, OS.get_process_id()])
		return
	DirAccess.remove_absolute(_instance_file)


func _get_registry_dir() -> String:
	# ~/.godot-mcp/instances/(对齐 InstanceManager getDefaultRegistryDir)
	var home := OS.get_environment("USERPROFILE") if OS.has_feature("windows") else OS.get_environment("HOME")
	if home.is_empty():
		home = "user://"
	return "%s/.godot-mcp/instances" % home
