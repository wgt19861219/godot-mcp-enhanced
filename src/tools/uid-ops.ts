/**
 * uid 工具 — Godot 4.4+ 文件 UID 管理(P1-1,2026-08-19)
 *
 * 对标 yanhuifair 独有品类中对表优先级最高的一项:文件 UID 查询/批量更新/缺失检测。
 * Godot 4.4 起每个资源文件旁置 .uid 文件(`uid://xxxx` 一行),场景/资源的 ExtResource
 * 引用优先走 UID —— 文件移动后 .uid 跟着走,但 .uid 丢失/未生成时引用悬空。
 *
 * 4 op(全部 headless,纯文件层,不依赖 editor 的 uid_cache.bin):
 * - uid_scan        全量扫描:缺 .uid 的资源 + 孤儿 .uid(无主文件)
 * - uid_get         查询文件(单个/批量)的 UID
 * - uid_set         写 .uid:指定 uid / 自动生成(generate) / 批量修复缺失(fix_missing)
 * - uid_check_refs  扫描文本资源中的 uid:// 引用,检测悬空引用
 *
 * 主数据源是文件系统的 .uid 文件(非 ResourceUID 注册表):headless 下 uid_cache.bin
 * 仅在编辑器打开过项目时存在且可能过期,文件系统扫描永远反映磁盘真相。
 * 新 UID 生成用 ResourceUID.create_id_for_path(确定性,同路径同 UID,与编辑器一致)。
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
// uid 脚本全部由本工具生成(参数经 TS 侧 uid 正则/sanitizeResPath/extensions 白名单校验,
// 非用户任意代码),uid_set 需 FileAccess.WRITE 写 .uid —— 走 trusted 通道(经 runOpsScript
// trusted: true),对齐 data-import/material-ops 模式(SEC-P1-1 防线针对的是用户输入代码,
// 工具自生成脚本豁免)。
import { gdEscape, escapeForGdLiteral, sanitizeResPath, runOpsScript, NON_PERSIST, opsErrorResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_UID: 'INVALID_UID',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ACTIONS = ['uid_scan', 'uid_get', 'uid_set', 'uid_check_refs'] as const;

/** 默认参与 UID 扫描的资源扩展(Godot 4.4 EditorFileSystem 常见建 .uid 的类型,可用 extensions 参数覆盖) */
export const DEFAULT_UID_EXTENSIONS = [
  'tscn', 'tres', 'gd', 'cs', 'gdns', 'gdshader', 'shader', 'json', 'txt', 'csv', 'po',
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'tga', 'wav', 'ogg', 'mp3',
  'glb', 'gltf', 'ttf', 'otf', 'woff',
] as const;

/** check_refs 扫描的文本扩展(可能内嵌 uid:// 引用的) */
export const REF_SCAN_EXTENSIONS = [
  'tscn', 'tres', 'gd', 'cs', 'gdns', 'gdshader', 'shader', 'import', 'json', 'po', 'cfg',
] as const;

const DEFAULT_SKIP_DIRS = ['.godot', '.git', '.import', 'node_modules', '__pycache__'];

const UID_TEXT_RE = /^uid:\/\/[0-9a-z]{4,32}$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;

// ─── 参数校验 ────────────────────────────────────────────────────────────────

function validateExtensions(raw: unknown, field: string): string[] {
  const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const item of arr) {
    const ext = String(item ?? '').trim().toLowerCase();
    if (!ext) continue;
    if (!EXT_RE.test(ext)) throw new Error(`${field} entries must be alphanumeric (a-z0-9), got: ${ext}`);
    out.push(ext);
  }
  if (out.length === 0) throw new Error(`${field} must contain at least one extension`);
  if (out.length > 60) throw new Error(`${field} too many entries (max 60)`);
  return out;
}

function validateLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : 100;
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('limit must be an integer in [1, 500]');
  return n;
}

/** GD Dictionary 字面量:["a","b"] → {"a": true, "b": true}(O(1) 查找) */
function toGdSet(items: string[]): string {
  return '{' + items.map(i => `"${gdEscape(i)}": true`).join(', ') + '}';
}

/** GD Array[String] 字面量 */
function toGdStringArray(items: string[]): string {
  return '[' + items.map(i => `"${gdEscape(i)}"`).join(', ') + ']';
}

// ─── GDScript 公共 helper(嵌入每个生成脚本) ───────────────────────────────

/** 递归遍历收集匹配扩展的文件(res:// 相对路径);跳过隐藏目录与 skip 集合
 *  拼接特判:起点 "res://" 已以 / 结尾(避免 res:/// 三斜杠),子目录正常加 / */
const GD_WALK = `
func _mcp_walk(dir_path: String, exts: Dictionary, skip: Dictionary, out: Array) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	var base := dir_path if dir_path.ends_with("/") else dir_path + "/"
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if dir.current_is_dir():
			if not skip.has(name) and not name.begins_with("."):
				_mcp_walk(base + name, exts, skip, out)
		else:
			var ext := name.get_extension().to_lower()
			if exts.has(ext):
				out.append(base + name)
		name = dir.get_next()
	dir.list_dir_end()
`;

/** 读文件的旁置 .uid;无文件/坏格式返回 "" */
const GD_READ_UID = `
func _mcp_read_uid(res_path: String) -> String:
	var uid_path := res_path + ".uid"
	if not FileAccess.file_exists(uid_path):
		return ""
	var f := FileAccess.open(uid_path, FileAccess.READ)
	if f == null:
		return ""
	var line := f.get_line().strip_edges()
	f.close()
	if line.begins_with("uid://"):
		return line
	return ""
`;

const GD_WRITE_UID = `
func _mcp_write_uid(res_path: String, uid_text: String) -> bool:
	var f := FileAccess.open(res_path + ".uid", FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(uid_text + "\\n")
	f.close()
	return true
`;

// ─── GDScript Generators ──────────────────────────────────────────────────

export function genUidScanScript(extensions: string[], skipDirs: string[], limit: number): string {
  return `extends SceneTree

var _mcp_outputs: Array = []
${GD_WALK}
${GD_READ_UID}
func _mcp_output(key: String, value: Variant) -> void:
	_mcp_outputs.append({"key": key, "value": str(value)})
func _mcp_done() -> void:
	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
	if Engine.get_main_loop() == self:
		quit(0)

func _initialize():
	var resources: Array = []
	_mcp_walk("res://", ${toGdSet(extensions)}, ${toGdSet(skipDirs)}, resources)
	var uid_files: Array = []
	_mcp_walk("res://", {"uid": true}, ${toGdSet(skipDirs)}, uid_files)
	var missing: Array = []
	var with_uid := 0
	for res_path in resources:
		if _mcp_read_uid(res_path) != "":
			with_uid += 1
		else:
			missing.append(res_path)
	var orphans: Array = []
	for uid_file in uid_files:
		var main_file: String = uid_file.substr(0, uid_file.length() - 4)
		if not FileAccess.file_exists(main_file):
			orphans.append(uid_file)
	var missing_shown: Array = missing.slice(0, ${limit})
	var orphan_shown: Array = orphans.slice(0, ${limit})
	_mcp_output("scan", JSON.stringify({
		"total_resources": resources.size(),
		"with_uid": with_uid,
		"missing_count": missing.size(),
		"missing": missing_shown,
		"orphan_count": orphans.size(),
		"orphans": orphan_shown
	}))
	_mcp_done()
`;
}

export function genUidGetScript(paths: string[]): string {
  return `extends SceneTree

var _mcp_outputs: Array = []
${GD_READ_UID}
func _mcp_output(key: String, value: Variant) -> void:
	_mcp_outputs.append({"key": key, "value": str(value)})
func _mcp_done() -> void:
	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
	if Engine.get_main_loop() == self:
		quit(0)

func _initialize():
	var results: Array = []
	var not_found: Array = []
	for res_path in ${toGdStringArray(paths)}:
		if not FileAccess.file_exists(res_path):
			not_found.append(res_path)
			continue
		var uid_text := _mcp_read_uid(res_path)
		results.append({"path": res_path, "uid": uid_text if uid_text != "" else null})
	_mcp_output("uids", JSON.stringify({"entries": results, "not_found": not_found}))
	_mcp_done()
`;
}

/**
 * uid_set 三种模式(互斥):
 * - path + uid            为单文件写指定 UID(覆盖已有)
 * - path(省略 uid)       为单文件按路径确定性生成新 UID(与编辑器一致)
 * - fix_missing=true      扫描全部缺失 .uid 的资源并批量生成写入
 */
export function genUidSetScript(opts: {
  path?: string; uid?: string; fixMissing?: boolean;
  extensions: string[]; skipDirs: string[];
}): string {
  let single: string;
  if (opts.path !== undefined) {
    const uidBranch = opts.uid !== undefined
      ? `\tvar uid_text := "${escapeForGdLiteral(opts.uid)}"
	if ResourceUID.text_to_id(uid_text) == ResourceUID.INVALID_ID:
		_mcp_output("error", "Invalid uid text: " + uid_text)
		_mcp_done()
		return`
      : `\tvar uid_text := ResourceUID.id_to_text(ResourceUID.create_id_for_path(res_path))`;
    single = `\tvar res_path := "${escapeForGdLiteral(opts.path)}"
	if not FileAccess.file_exists(res_path):
		_mcp_output("error", "File not found: " + res_path)
		_mcp_done()
		return
${uidBranch}
	if _mcp_write_uid(res_path, uid_text):
		_mcp_output("set", JSON.stringify({"path": res_path, "uid": uid_text, "generated": ${opts.uid === undefined ? 'true' : 'false'}}))
	else:
		_mcp_output("error", "Failed to write: " + res_path + ".uid")
	_mcp_done()`;
  } else {
    single = `\tvar resources: Array = []
	_mcp_walk("res://", ${toGdSet(opts.extensions)}, ${toGdSet(opts.skipDirs)}, resources)
	var fixed: Array = []
	var failed: Array = []
	for res_path in resources:
		if _mcp_read_uid(res_path) != "":
			continue
		var new_uid := ResourceUID.id_to_text(ResourceUID.create_id_for_path(res_path))
		if _mcp_write_uid(res_path, new_uid):
			fixed.append({"path": res_path, "uid": new_uid})
		else:
			failed.append(res_path)
	_mcp_output("fixed", JSON.stringify({"fixed": fixed.slice(0, 200), "fixed_count": fixed.size(), "failed": failed.slice(0, 50), "failed_count": failed.size()}))
	_mcp_done()`;
  }

  return `extends SceneTree

var _mcp_outputs: Array = []
${GD_WALK}
${GD_READ_UID}
${GD_WRITE_UID}
func _mcp_output(key: String, value: Variant) -> void:
	_mcp_outputs.append({"key": key, "value": str(value)})
func _mcp_done() -> void:
	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
	if Engine.get_main_loop() == self:
		quit(0)

func _initialize():
${single}
`;
}

export function genUidCheckRefsScript(skipDirs: string[], limit: number): string {
  return `extends SceneTree

var _mcp_outputs: Array = []
${GD_WALK}
${GD_READ_UID}
func _mcp_output(key: String, value: Variant) -> void:
	_mcp_outputs.append({"key": key, "value": str(value)})
func _mcp_done() -> void:
	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
	if Engine.get_main_loop() == self:
		quit(0)

func _initialize():
	var text_files: Array = []
	_mcp_walk("res://", ${toGdSet([...REF_SCAN_EXTENSIONS])}, ${toGdSet(skipDirs)}, text_files)
	var uid_files: Array = []
	_mcp_walk("res://", {"uid": true}, ${toGdSet(skipDirs)}, uid_files)
	var known: Dictionary = {}
	for uid_file in uid_files:
		var u := _mcp_read_uid(uid_file.substr(0, uid_file.length() - 4))
		if u != "":
			known[u] = true
	var re := RegEx.new()
	re.compile("uid://[0-9a-z]+")
	var dangling: Array = []
	var total_refs := 0
	for tf in text_files:
		var f := FileAccess.open(tf, FileAccess.READ)
		if f == null:
			continue
		var content := f.get_as_text()
		f.close()
		for m in re.search_all(content):
			var uid_text: String = m.get_string()
			total_refs += 1
			if not known.has(uid_text):
				var upto: int = m.get_start()
				var line_no: int = content.count("\\n", 0, upto) + 1
				dangling.append({"file": tf, "line": line_no, "uid": uid_text})
	_mcp_output("refs", JSON.stringify({
		"scanned_files": text_files.size(),
		"known_uids": known.size(),
		"total_refs": total_refs,
		"dangling_count": dangling.size(),
		"dangling": dangling.slice(0, ${limit})
	}))
	_mcp_done()
`;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'uid',
      description: `文件 UID 管理(Godot 4.4+)。scan: 扫描缺 .uid 资源与孤儿 .uid。get: 查文件 UID(批量)。set: 写 .uid(指定 uid/generate 单文件/fix_missing 批量修复)。check_refs: 检测 uid:// 悬空引用(仅对照项目 .uid 集合;uid 悬空但 ext_resource 另有 path fallback 的引用引擎可正常加载,计入 dangling 属诊断提示,非断链)。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。uid_scan=扫描项目 UID, uid_get=批量查 UID, uid_set=设 UID, uid_check_refs=检查 UID 引用',
          },
          paths: { type: 'array', items: { type: 'string' }, description: 'get: 文件路径列表(res:// 相对,支持批量)' },
          path: { type: 'string', description: 'set: 单文件路径(res:// 相对)' },
          uid: { type: 'string', description: 'set: 指定 UID 文本(uid://xxxx);省略则按路径确定性生成(与编辑器一致)' },
          fix_missing: { type: 'boolean', description: 'set: 批量修复全部缺 .uid 的资源' },
          extensions: { type: 'array', items: { type: 'string' }, description: `scan/set 参与的资源扩展(小写,默认 ${DEFAULT_UID_EXTENSIONS.length} 个常见类型)` },
          limit: { type: 'number', description: 'scan/check_refs 明细截断上限(默认 100,最大 500)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'uid') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    let script: string;

    switch (action) {
      case 'uid_scan': {
        const extensions = args.extensions !== undefined
          ? validateExtensions(args.extensions, 'extensions')
          : [...DEFAULT_UID_EXTENSIONS];
        const limit = validateLimit(args.limit);
        script = genUidScanScript(extensions, DEFAULT_SKIP_DIRS, limit);
        break;
      }
      case 'uid_get': {
        const rawPaths = args.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > 200) {
          return opsErrorResult('INVALID_PARAMS', 'paths must be an array of 1-200 entries');
        }
        const paths = rawPaths.map(p => sanitizeResPath(p, 'paths[]'));
        script = genUidGetScript(paths);
        break;
      }
      case 'uid_set': {
        const fixMissing = args.fix_missing === true;
        if (fixMissing && (args.path !== undefined || args.uid !== undefined)) {
          return opsErrorResult('INVALID_PARAMS', 'fix_missing cannot be combined with path/uid');
        }
        if (!fixMissing) {
          if (typeof args.path !== 'string') {
            return opsErrorResult('INVALID_PARAMS', 'path is required (or use fix_missing=true)');
          }
          const path = sanitizeResPath(args.path, 'path');
          let uid: string | undefined;
          if (args.uid !== undefined) {
            uid = String(args.uid);
            if (!UID_TEXT_RE.test(uid)) {
              return opsErrorResult('INVALID_UID', `uid must match ${UID_TEXT_RE.source}`);
            }
          }
          script = genUidSetScript({ path, uid, extensions: [...DEFAULT_UID_EXTENSIONS], skipDirs: DEFAULT_SKIP_DIRS });
        } else {
          const extensions = args.extensions !== undefined
            ? validateExtensions(args.extensions, 'extensions')
            : [...DEFAULT_UID_EXTENSIONS];
          script = genUidSetScript({ fixMissing: true, extensions, skipDirs: DEFAULT_SKIP_DIRS });
        }
        break;
      }
      case 'uid_check_refs': {
        const limit = validateLimit(args.limit);
        script = genUidCheckRefsScript(DEFAULT_SKIP_DIRS, limit);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? 'FILE_NOT_FOUND' : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads: false, timeoutSec: 60,
      errorMapper, paramWarnings: [], action, trusted: true });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('must be a string starting with res://') || msg.includes('traversal')) {
      return opsErrorResult('INVALID_PARAMS', msg);
    }
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  uid: {
    readonly: false,
    long_running: false,
    actionRisks: {
      uid_scan: 'read', uid_get: 'read', uid_set: 'write', uid_check_refs: 'read',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
